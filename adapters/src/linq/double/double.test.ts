// T-411: the Linq double against K-11 v1's fixtures and schema. No network, no key; fixtures hold fictional numbers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createLinqDouble } from "./double";
import type { SendPartFailed, SendPartRequest, ScriptedSendFailure } from "./types";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const NOW = "2026-10-23T14:05:03Z";

interface Exchange {
  call: string;
  given: { now: string; note: string };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

const readFixture = (file: string): Exchange =>
  JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as Exchange;

const SUCCESS = [
  "send-text.json",
  "send-poll.json",
  "send-link-card.json",
  "send-calendar-file.json",
  "send-photo.json",
  "send-typing.json",
  "send-tapback.json",
  "send-threaded-reply.json",
];
const FAILURES = ["error-403-2024.json", "error-4006.json", "error-rate-limit.json"];
const REFUSED = [
  "invalid/refuse-poll-six-options.json",
  "invalid/refuse-tapback-on-poll.json",
  "invalid/refuse-bold.json",
  "invalid/refuse-sms-channel.json",
];

let validateExchange: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (the same loading as the contract harness).
  const folders = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["scripts", "generated", "node_modules"].includes(entry.name))
    .map((entry) => entry.name);
  for (const folder of folders) {
    for (const file of readdirSync(path.join(CONTRACTS, folder))) {
      if (!file.endsWith(".schema.json")) continue;
      ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS, folder, file), "utf8")) as object);
    }
  }
  const check = ajv.getSchema(
    "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json#/$defs/sendPart.exchange",
  );
  if (check === undefined) throw new Error("the schema has no sendPart.exchange");
  validateExchange = check;
});

/** The double's answer, as the exchange the schema checks. */
function asExchange(request: unknown, outcome: unknown): unknown {
  return { call: "sendPart", given: { now: NOW, note: "double" }, request, outcome };
}

function scriptFrom(outcome: Record<string, unknown>): ScriptedSendFailure {
  const kind = outcome.kind as ScriptedSendFailure["kind"];
  if (kind === "mayStillDeliver") return { kind, code: outcome.code as "4001" | "4006" };
  if (kind === "rateLimited") return { kind, retryAfterSeconds: outcome.retryAfterSeconds as number };
  if (kind === "optedOut") return { kind };
  throw new Error("fixture kind not scripted here");
}

describe("the K-11 fixtures exist where the tests expect them", () => {
  it("has every fixture this file names", () => {
    for (const file of [...SUCCESS, ...FAILURES, ...REFUSED])
      expect(existsSync(path.join(FIXTURES, file))).toBe(true);
  });
});

describe("sendPart: accepted fixtures", () => {
  for (const file of SUCCESS) {
    it(`accepts ${file} with an answer the schema allows`, () => {
      const fixture = readFixture(file);
      const double = createLinqDouble({ now: () => NOW });
      const outcome = double.sendPart(fixture.request);
      expect(outcome.result).toBe("accepted");
      expect(
        validateExchange(asExchange(fixture.request, outcome)),
        JSON.stringify(validateExchange.errors),
      ).toBe(true);
      // The same shape as Linq's recorded answer: which ids are null, how many option ids, the service, the chat.
      if (outcome.result !== "accepted") return;
      const expected = fixture.outcome;
      expect(outcome.providerMessageId === null).toBe(expected.providerMessageId === null);
      expect((outcome.providerOptionIds ?? []).length).toBe(
        Array.isArray(expected.providerOptionIds) ? expected.providerOptionIds.length : 0,
      );
      expect(outcome.service).toBe(expected.service);
      expect(outcome.chatId).toBe(expected.chatId);
      expect(double.sentRequests()).toEqual([fixture.request]);
    });
  }

  it("records every accepted request in the order sent", () => {
    const double = createLinqDouble({ now: () => NOW });
    const requests = SUCCESS.map((file) => readFixture(file).request);
    for (const request of requests) expect(double.sendPart(request).result).toBe("accepted");
    expect(double.sentRequests()).toEqual(requests);
  });

  it("gives a poll option ids in the options' order, and each message its own id", () => {
    const double = createLinqDouble({ now: () => NOW });
    const first = double.sendPart(readFixture("send-text.json").request);
    const poll = double.sendPart(readFixture("send-poll.json").request);
    if (first.result !== "accepted" || poll.result !== "accepted") throw new Error("not accepted");
    expect(poll.providerOptionIds).toHaveLength(3);
    expect(new Set(poll.providerOptionIds).size).toBe(3);
    expect(first.providerMessageId).not.toBe(poll.providerMessageId);
  });
});

describe("sendPart: refused fixtures", () => {
  for (const file of REFUSED) {
    it(`refuses ${file} and records it as sent never`, () => {
      const fixture = readFixture(file);
      const double = createLinqDouble({ now: () => NOW });
      const outcome = double.sendPart(fixture.request);
      expect(outcome.result).toBe("failed");
      if (outcome.result !== "failed") return;
      expect(outcome.kind).toBe("refused");
      expect(outcome.httpStatus).toBe(400);
      expect(double.sentRequests()).toEqual([]);
      expect(double.rejectedRequests()).toHaveLength(1);
      expect(double.rejectedRequests()[0]?.problems.length).toBeGreaterThan(0);
    });
  }

  it("fixes each refused fixture's fault and takes it", () => {
    const poll = { ...readFixture("invalid/refuse-poll-six-options.json").request };
    poll.options = (poll.options as string[]).slice(0, 5);
    expect(createLinqDouble({ now: () => NOW }).sendPart(poll).result).toBe("accepted");
    const tapback = readFixture("invalid/refuse-tapback-on-poll.json").request;
    expect(
      createLinqDouble({ now: () => NOW }).sendPart({
        ...tapback,
        tapback: { ...(tapback.tapback as object), onPoll: false },
      }).result,
    ).toBe("accepted");
    for (const file of ["invalid/refuse-bold.json", "invalid/refuse-sms-channel.json"]) {
      const rest = { ...readFixture(file).request };
      delete rest.textDecorations;
      delete rest.preferredService;
      expect(createLinqDouble({ now: () => NOW }).sendPart(rest).result).toBe("accepted");
    }
  });

  it("refuses what each service does not allow, and a missing key", () => {
    const double = createLinqDouble({ now: () => NOW });
    const poll = readFixture("send-poll.json").request;
    expect(double.sendPart({ ...poll, service: "rcs" }).result).toBe("failed");
    const text = readFixture("send-text.json").request;
    expect(double.sendPart({ ...text, service: "sms", threadedReplyTo: { messageId: "m" } }).result).toBe(
      "failed",
    );
    expect(double.sendPart({ ...text, idempotencyKey: null }).result).toBe("failed");
    expect(double.sendPart({ ...text, to: "5555550101" }).result).toBe("failed");
    expect(double.sendPart("words").result).toBe("failed");
    expect(double.sentRequests()).toEqual([]);
  });
});

describe("sendPart: failures the test chooses", () => {
  for (const file of FAILURES) {
    it(`answers ${file}'s failure as the contract defines it, and records the request`, () => {
      const fixture = readFixture(file);
      const double = createLinqDouble({ now: () => NOW });
      double.failNextSend(scriptFrom(fixture.outcome));
      const outcome = double.sendPart(fixture.request);
      expect(outcome.result).toBe("failed");
      expect(
        validateExchange(asExchange(fixture.request, outcome)),
        JSON.stringify(validateExchange.errors),
      ).toBe(true);
      const failed = outcome as SendPartFailed;
      for (const field of ["kind", "httpStatus", "code", "retryAfterSeconds"] as const)
        expect(failed[field]).toEqual(fixture.outcome[field]);
      expect(double.sentRequests()).toEqual([fixture.request]);
    });
  }

  it("answers 4001, a refusal and a transient error in the contract's form", () => {
    const text = readFixture("send-text.json").request;
    const choices: ScriptedSendFailure[] = [
      { kind: "mayStillDeliver", code: "4001" },
      { kind: "refused" },
      { kind: "refused", httpStatus: 400, code: null },
      { kind: "transient" },
      { kind: "transient", httpStatus: null },
      { kind: "rateLimited" },
    ];
    for (const choice of choices) {
      const double = createLinqDouble({ now: () => NOW });
      double.failNextSend(choice);
      const outcome = double.sendPart(text);
      expect(outcome.result).toBe("failed");
      expect(validateExchange(asExchange(text, outcome)), JSON.stringify(validateExchange.errors)).toBe(true);
    }
  });

  it("applies a failure to the chosen phone only, the chosen number of times", () => {
    const double = createLinqDouble({ now: () => NOW });
    const alex = readFixture("send-text.json").request;
    const sam = readFixture("send-photo.json").request;
    double.failNextSend({ kind: "transient" }, { to: sam.to as string, times: 2 });
    expect(double.sendPart(alex).result).toBe("accepted");
    expect(double.sendPart(sam).result).toBe("failed");
    expect(double.sendPart({ ...sam, idempotencyKey: "out-sam-photo-demo/1/2" }).result).toBe("failed");
    expect(double.sendPart({ ...sam, idempotencyKey: "out-sam-photo-demo/1/3" }).result).toBe("accepted");
  });
});

describe("a repeated part under one idempotency key", () => {
  it("is recorded once and answers the same, with the same ids", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("send-poll.json").request;
    const first = double.sendPart(request);
    const again = double.sendPart(request);
    expect(again).toEqual(first);
    expect(double.sentRequests()).toEqual([request]);
  });

  it("returns the stored failure after a 4006, and a new key is a new send", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("error-4006.json").request;
    double.failNextSend({ kind: "mayStillDeliver", code: "4006" });
    const first = double.sendPart(request);
    expect(double.sendPart(request)).toEqual(first);
    expect(double.sentRequests()).toHaveLength(1);
    const retry = double.sendPart({ ...request, idempotencyKey: "out-sam-booked-riley/1/2" });
    expect(retry.result).toBe("accepted");
    expect(double.sentRequests()).toHaveLength(2);
  });

  it("lets a rate-limited part try again on the same key", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("error-rate-limit.json").request;
    double.failNextSend({ kind: "rateLimited", retryAfterSeconds: 65 });
    expect(double.sendPart(request).result).toBe("failed");
    expect(double.sendPart(request).result).toBe("accepted");
    expect(double.sendPart(request).result).toBe("accepted");
    expect(double.sentRequests()).toHaveLength(2);
  });

  it("counts typing dots, which have no key, every time", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("send-typing.json").request;
    double.sendPart(request);
    double.sendPart(request);
    expect(double.sentRequests()).toHaveLength(2);
  });
});

describe("after a 403 with code 2024 (build prompt 9.4)", () => {
  const ben = (): SendPartRequest => readFixture("error-403-2024.json").request as unknown as SendPartRequest;

  it("fails every later send to that phone until reset, whatever the part or the override", () => {
    const double = createLinqDouble({ now: () => NOW });
    double.failNextSend({ kind: "optedOut" });
    expect(double.sendPart(ben()).result).toBe("failed");
    expect(double.isOptedOut(ben().to)).toBe(true);
    const later: unknown[] = [
      { ...ben(), idempotencyKey: "out-ben-reminder/1/2" },
      { ...ben(), idempotencyKey: "out-ben-reminder/2/1" },
      readFixture("send-override-optout.json").request,
    ];
    for (const request of later) {
      const outcome = double.sendPart(request);
      expect(outcome).toMatchObject({ result: "failed", kind: "optedOut", httpStatus: 403, code: "2024" });
      expect(validateExchange(asExchange(request, outcome)), JSON.stringify(validateExchange.errors)).toBe(
        true,
      );
    }
    double.reset();
    expect(double.isOptedOut(ben().to)).toBe(false);
    expect(double.sendPart(ben()).result).toBe("accepted");
  });

  it("leaves other phones alone, and lifts one phone on request", () => {
    const double = createLinqDouble({ now: () => NOW });
    double.failNextSend({ kind: "optedOut" });
    double.sendPart(ben());
    expect(double.sendPart(readFixture("send-text.json").request).result).toBe("accepted");
    double.liftOptOut(ben().to);
    expect(double.sendPart({ ...ben(), idempotencyKey: "out-ben-reminder/1/3" }).result).toBe("accepted");
  });

  it("answers a repeat of an earlier accepted part with its stored answer", () => {
    const double = createLinqDouble({ now: () => NOW });
    const first = double.sendPart(ben());
    double.failNextSend({ kind: "optedOut" });
    double.sendPart({ ...ben(), idempotencyKey: "out-ben-reminder/2/1" });
    expect(double.sendPart(ben())).toEqual(first);
  });
});

describe("contactAdd", () => {
  const added = (): Record<string, unknown> => readFixture("contact-add-ok.json").request;

  it("adds a number, and answers added again for one already added", () => {
    const double = createLinqDouble({ now: () => NOW });
    const first = double.contactAdd(added());
    expect(first).toMatchObject({ result: "added", alreadyContact: false });
    expect(double.contactAdd(added())).toMatchObject({ result: "added", alreadyContact: true });
    expect(double.contactAddRequests()).toEqual([added().phone, added().phone]);
  });

  it("fails as the test chooses, retryable or not, and the number is then not a contact", () => {
    const double = createLinqDouble({ now: () => NOW });
    double.scriptContactAdd({ result: "failed", retryable: true });
    double.scriptContactAdd({ result: "failed", retryable: false, code: "2008", reason: "Not added." });
    expect(double.contactAdd(added())).toMatchObject({ result: "failed", retryable: true, code: null });
    expect(double.contactAdd(added())).toMatchObject({ result: "failed", retryable: false, code: "2008" });
    expect(double.contactAdd(added())).toMatchObject({ result: "added", alreadyContact: false });
  });

  it("refuses a number that is not E.164", () => {
    const double = createLinqDouble({ now: () => NOW });
    expect(double.contactAdd({ phone: "5555550101" })).toMatchObject({ result: "failed", retryable: false });
    expect(double.contactAddRequests()).toEqual([]);
  });
});

describe("capabilityCheck", () => {
  it("answers iMessage by default for 600 seconds, and what the test sets for a number", () => {
    const double = createLinqDouble({ now: () => NOW });
    const phone = "+15555550104";
    expect(double.capabilityCheck({ phone })).toEqual({
      result: "checked",
      phone,
      imessage: true,
      service: "imessage",
      checkedAt: NOW,
      cacheSeconds: 600,
    });
    double.setCapability(phone, { result: "checked", imessage: false, service: "rcs" });
    expect(double.capabilityCheck({ phone })).toMatchObject({ imessage: false, service: "rcs" });
    double.setCapability(phone, { result: "failed" });
    expect(double.capabilityCheck({ phone })).toMatchObject({ result: "failed" });
    expect(double.capabilityCheckRequests()).toEqual([phone, phone, phone]);
  });
});

describe("faked receipts, votes and failures", () => {
  it("fakes a sent and a delivered receipt carrying the part's key and message id", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("send-text.json").request;
    const outcome = double.sendPart(request);
    if (outcome.result !== "accepted") throw new Error("not accepted");
    const sent = double.fakeSent(request.idempotencyKey as string);
    const delivered = double.fakeDelivered(request.idempotencyKey as string);
    expect(sent).toMatchObject({
      kind: "sent",
      partKey: request.idempotencyKey,
      messageId: outcome.providerMessageId,
    });
    expect(delivered).toMatchObject({ kind: "delivered", partKey: request.idempotencyKey });
    expect(double.events()).toEqual([sent, delivered]);
  });

  it("fakes the late receipt after a 4006, which has no message id", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("error-4006.json").request;
    double.failNextSend({ kind: "mayStillDeliver", code: "4006" });
    double.sendPart(request);
    expect(double.fakeDelivered(request.idempotencyKey as string)).toMatchObject({
      kind: "delivered",
      partKey: request.idempotencyKey,
      messageId: null,
    });
  });

  it("refuses a receipt for a part nobody sent", () => {
    const double = createLinqDouble({ now: () => NOW });
    expect(() => double.fakeDelivered("out-nobody/1/1")).toThrow();
  });

  it("fakes a poll vote on an accepted poll's option, and a removed vote, with a null part key", () => {
    const double = createLinqDouble({ now: () => NOW });
    const poll = double.sendPart(readFixture("send-poll.json").request);
    if (poll.result !== "accepted" || poll.providerMessageId === null || poll.providerOptionIds === null)
      throw new Error("not accepted");
    const messageId = poll.providerMessageId;
    const optionId = poll.providerOptionIds[1] ?? "";
    expect(optionId).not.toBe("");
    expect(double.fakePollVote(messageId, optionId, "+15555550101")).toMatchObject({
      kind: "pollVote",
      partKey: null,
      optionId,
      removed: false,
    });
    expect(double.fakePollVote(messageId, optionId, "+15555550101", true)).toMatchObject({ removed: true });
    expect(() => double.fakePollVote(messageId, "no-such-option", "+15555550101")).toThrow();
  });

  it("fakes a failure with or without a part key", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("send-text.json").request;
    double.sendPart(request);
    expect(double.fakeFailure("4006", request.idempotencyKey as string)).toMatchObject({
      kind: "failed",
      code: "4006",
      partKey: request.idempotencyKey,
    });
    expect(double.fakeFailure("4001")).toMatchObject({ partKey: null, messageId: null });
  });
});

describe("reset and isolation", () => {
  it("clears the record, scripts, contacts, capability and stored keys", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("send-text.json").request;
    double.failNextSend({ kind: "transient" }, { times: 5 });
    double.sendPart(request);
    double.contactAdd({ phone: "+15555550101" });
    double.setCapability("+15555550101", { result: "failed" });
    double.reset();
    expect(double.sentRequests()).toEqual([]);
    expect(double.contactAddRequests()).toEqual([]);
    expect(double.events()).toEqual([]);
    expect(double.sendPart(request).result).toBe("accepted");
    expect(double.contactAdd({ phone: "+15555550101" })).toMatchObject({ alreadyContact: false });
    expect(double.capabilityCheck({ phone: "+15555550101" })).toMatchObject({ result: "checked" });
  });

  it("hands out copies: changing a read record does not change the double's", () => {
    const double = createLinqDouble({ now: () => NOW });
    double.sendPart(readFixture("send-text.json").request);
    const [first] = double.sentRequests() as SendPartRequest[];
    if (first === undefined) throw new Error("nothing recorded");
    first.text = "changed";
    expect(double.sentRequests()[0]?.text).not.toBe("changed");
  });

  it("never puts words or a phone number in a refusal's problem lines or a failure's reason", () => {
    const double = createLinqDouble({ now: () => NOW });
    const request = readFixture("invalid/refuse-poll-six-options.json").request;
    const outcome = double.sendPart(request);
    const lines = JSON.stringify([outcome, double.rejectedRequests().map((entry) => entry.problems)]);
    expect(lines).not.toContain(request.to as string);
    for (const option of request.options as string[]) expect(lines).not.toContain(option);
  });
});
