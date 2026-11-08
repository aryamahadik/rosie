// Contract test for K-11 v1, the Linq port (T-090; ops/plan/02-contracts.md K-11 "Contract test" and section 2 item 12;
// contracts/port-linq/README.md "Producers and consumers", "Outcomes of a send", "Signatures in fixtures").
//
// This is the fixture part. The contract test has two parts: this one, which reads only the committed fixtures, and
// one part per producer or consumer side, added later by a QA side task that depends on this task and on that side's
// build task. SIDE_CHECKS (at the end) is the list where each side is added.
//
// What this part proves:
//   1. every fixture in contracts/port-linq/fixtures/index.json is checked against its $defs entry (the T-003
//      harness): accepted ones are accepted, refused ones are refused, none is left out; each refused one is refused
//      for its one reason (put right, it is accepted);
//   2. the schema is not vacuous: removing any one required field (of the exchange, its given, its request or its
//      outcome) from a copy of an accepted fixture makes the copy refused, and so does one field the schema does not
//      know;
//   3. what the schema leaves to code and the fixtures can show (the README's list), each also run on a damaged copy
//      to show that it fires: a poll's option ids match its options in number and order; an accepted tapback or
//      typing call has no message id; the 300 s window (a stale timestamp is outside it, every other verify fixture
//      inside it) and how each fixture says its webhook is signed; the webhook id is the event id; the parsed event
//      of verify-ok and of the double's webhook are K-06's text-imessage.json and test-phone-page.json; the late
//      receipt's partKey is the key of the failed send in error-4006.json.
//   What needs a producer or consumer side is on SIDE_CHECKS, not checked here: the signature itself (HMAC at run
//   time), the adapter and the double giving the same port-level results, the gateway rejecting every bad
//   signature, doubleWebhook round-tripping through verifyWebhook, and the adapter reading partKey from a receipt.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CONTRACTS_ROOT, describeContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The fixtures

const LINQ_DIR = path.join(CONTRACTS_ROOT, "port-linq");
const FIXTURES_DIR = path.join(LINQ_DIR, "fixtures");
const INBOUND_FIXTURES_DIR = path.join(CONTRACTS_ROOT, "inbound-event", "fixtures");
const SCHEMA_FILE = "port-linq.v1.schema.json";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const inboundFixture = (file: string): unknown => readJson(path.join(INBOUND_FIXTURES_DIR, file));

/** A value a fixture must hold; the fixtures are checked against the schema first, so a miss is a broken test. */
function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("a fixture lacks a value this test reads");
  return value;
}

// What the checks read. The fixtures are checked against the schema first (part 1), so a cast to these shapes reads
// only fields the schema requires.
interface Given {
  now: string;
  note: string;
  signing?: string;
}
interface WebhookRequest {
  webhookId: string;
  timestamp: string;
  signature: string;
  raw: string;
  receivedAt: string;
  traceId: string;
}
interface Outcome {
  result: string;
  httpStatus?: number;
  reason?: string;
  event?: Record<string, unknown> & { eventId: string; kind: string; body: string | null; traceId: string };
  partKey?: string | null;
  providerMessageId?: string | null;
  providerOptionIds?: string[] | null;
  kind?: string;
  code?: number | string;
  webhook?: WebhookRequest;
}
interface SendRequest {
  idempotencyKey: string;
  kind: string;
  options: string[] | null;
  overrideOptout: boolean;
}
interface Exchange {
  call: string;
  given: Given;
  request: Record<string, unknown>;
  outcome: Outcome;
}

const entries = index.fixtures;
const acceptedEntries = entries.filter((entry) => entry.expect === "accept");
const refusedEntries = entries.filter((entry) => entry.expect === "refuse");
const exchangeOf = (file: string): Exchange => structuredClone(fixture(file)) as Exchange;
const acceptedFiles = acceptedEntries.map((entry) => entry.file);
const filesOfCall = (call: string): string[] =>
  acceptedFiles.filter((file) => exchangeOf(file).call === call);

// ---------------------------------------------------------------------------------------------------------------
// The schema, one validator for everything (the harness's strict Ajv 2020-12 setup; the schema refers to K-06 v1)

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const folder of [
  "common",
  "bundle",
  "model",
  "inbound-event",
  "outbox-effects",
  "message-plan",
  "port-linq",
]) {
  const dir = path.join(CONTRACTS_ROOT, folder);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".schema.json"))
      ajv.addSchema(readJson(path.join(dir, entry.name)) as object);
  }
}
interface SchemaNode {
  required?: string[];
  oneOf?: SchemaNode[];
  properties?: Record<string, { const?: unknown }>;
}
const schema = readJson(path.join(LINQ_DIR, SCHEMA_FILE)) as {
  $id: string;
  $defs: Record<string, SchemaNode>;
};

function validatorFor(entry: FixtureEntry): ValidateFunction {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${must(entry.def)}`);
  if (validate === undefined) throw new Error(`no schema for ${String(entry.def)}`);
  return validate;
}
const def = (name: string): SchemaNode => must(schema.$defs[name]);

/** The fields a definition requires of one outcome: the branches (of a oneOf) whose `result` is the outcome's. */
function requiredOfOutcome(call: string, outcome: Outcome): string[] {
  const nodes = [schema.$defs[`${call}.response`], schema.$defs[`${call}.errors`]]
    .filter((node): node is SchemaNode => node !== undefined)
    .flatMap((node) => node.oneOf ?? [node]);
  return nodes
    .filter((node) => node.properties?.result?.const === outcome.result)
    .flatMap((node) => node.required ?? []);
}

// ---------------------------------------------------------------------------------------------------------------
// Checks that read only fixtures. Each returns one line per problem; an empty list means the check holds.

const WINDOW_SECONDS = 300;
const secondsOf = (time: string): number => Date.parse(time) / 1000;

/** README, verifyWebhook: the 300 s window, the way it is signed, the id the webhook and its event share. */
export function checkVerifyExchange(exchange: Exchange): string[] {
  const problems: string[] = [];
  const request = exchange.request as unknown as WebhookRequest;
  const { outcome, given } = exchange;
  const apart = Math.abs(secondsOf(request.receivedAt) - Number(request.timestamp));
  const stale = apart > WINDOW_SECONDS;
  if (outcome.reason === "staleTimestamp" && !stale)
    problems.push(
      `staleTimestamp, but the timestamp is ${String(apart)} s from receipt, inside ${String(WINDOW_SECONDS)} s`,
    );
  if (outcome.reason !== "staleTimestamp" && stale)
    problems.push(
      `${outcome.result} but the timestamp is ${String(apart)} s from receipt, outside ${String(WINDOW_SECONDS)} s`,
    );
  if ((given.signing === "oneByteChanged") !== (outcome.reason === "badSignature"))
    problems.push("badSignature is the outcome exactly when the given signing is oneByteChanged");
  if (given.signing === undefined) problems.push("a verifyWebhook fixture says how its webhook is signed");
  const raw = JSON.parse(request.raw) as { event_id: string };
  if (raw.event_id !== request.webhookId) problems.push("the webhook id is not the raw body's event id");
  if (outcome.result === "event" && must(outcome.event).eventId !== request.webhookId)
    problems.push("the parsed event's id is not the webhook id");
  if (outcome.result === "event" && must(outcome.event).traceId !== request.traceId)
    problems.push("the parsed event's trace id is not the request's");
  return problems;
}

/** README, sendPart: a poll's option ids match its options in number and order; no message id for a tapback or typing. */
export function checkSendExchange(exchange: Exchange): string[] {
  const problems: string[] = [];
  const request = exchange.request as unknown as SendRequest;
  const { outcome } = exchange;
  if (outcome.result === "accepted") {
    const ids = outcome.providerOptionIds ?? [];
    if (request.kind === "poll") {
      if (ids.length !== must(request.options).length)
        problems.push(
          `a poll of ${String(must(request.options).length)} options is answered with ${String(ids.length)} option ids`,
        );
      if (new Set(ids).size !== ids.length) problems.push("a poll's option ids are not all different");
    } else if (outcome.providerOptionIds !== null) {
      problems.push(`a ${request.kind} is answered with option ids`);
    }
    if ((request.kind === "tapback" || request.kind === "typing") && outcome.providerMessageId !== null)
      problems.push(`an accepted ${request.kind} has a message id`);
    if (request.kind !== "tapback" && request.kind !== "typing" && outcome.providerMessageId === null)
      problems.push(`an accepted ${request.kind} has no message id`);
  }
  if (request.kind !== "typing" && !/\/\d+\/\d+$/.test(request.idempotencyKey))
    problems.push("the part key is not <row>/<part>/<try>");
  return problems;
}

/** README, doubleWebhook: the signed webhook carries the event it was asked for, and its timestamp is its receipt. */
export function checkDoubleExchange(exchange: Exchange): string[] {
  const problems: string[] = [];
  const event = (exchange.request as { event: { eventId: string; body: string; receivedAt: string } }).event;
  const webhook = must(exchange.outcome.webhook);
  if (webhook.webhookId !== event.eventId) problems.push("the webhook id is not the event's id");
  if (webhook.receivedAt !== event.receivedAt) problems.push("the webhook's receipt is not the event's");
  if (Number(webhook.timestamp) !== secondsOf(webhook.receivedAt))
    problems.push("the timestamp is not the receipt");
  const raw = JSON.parse(webhook.raw) as { event_id: string; data: { parts: { value: string }[] } };
  if (raw.event_id !== event.eventId) problems.push("the raw body's event id is not the event's");
  if (raw.data.parts[0]?.value !== event.body) problems.push("the raw body's words are not the event's body");
  return problems;
}

/** README, A late receipt after 4001 or 4006: its partKey is the key of the failed send. */
export function checkLateReceipt(receipt: Exchange, failed: Exchange): string[] {
  const problems: string[] = [];
  const key = (failed.request as unknown as SendRequest).idempotencyKey;
  if (failed.outcome.kind !== "mayStillDeliver") problems.push("the failed send is not mayStillDeliver");
  if (failed.outcome.providerMessageId !== null) problems.push("the failed send has a message id");
  if (receipt.outcome.partKey !== key)
    problems.push(`the receipt's partKey is not the failed send's key ${key}`);
  const kind = must(receipt.outcome.event).kind;
  if (kind !== "delivered" && kind !== "sent") problems.push(`a ${kind} receipt carries a part key`);
  return problems;
}

/** A copy of `value` without the property at `where`. */
function without(value: unknown, where: string[]): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let node: unknown = copy;
  for (const step of where.slice(0, -1)) node = (node as Record<string, unknown>)[step];
  Reflect.deleteProperty(node as object, must(where.at(-1)));
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Every fixture of the index, checked by the T-003 harness (the schema refers to K-06, which is shared)

const report = describeContractFixtures("port-linq", {
  sharedFolders: ["common", "bundle", "model", "inbound-event", "outbox-effects", "message-plan"],
});

describe("port-linq.v1 fixtures: the index and the count", () => {
  it("checks as many fixtures as fixtures/index.json lists, none left out", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(report.entries).toHaveLength(entries.length);
    expect(report.seedRows).toBe(0);
    expect(report.passes + report.refusals).toBe(entries.length);
  });

  it("accepts every entry marked accept and refuses every entry marked refuse", () => {
    expect(report.passes).toBe(acceptedEntries.length);
    expect(report.refusals).toBe(refusedEntries.length);
    for (const result of report.entries) {
      expect(result.outcome, result.file).toBe(result.expect === "accept" ? "accepted" : "refused");
    }
  });

  it("names its definition in every entry and holds each of the five calls and the five refusals", () => {
    expect(entries.every((entry) => entry.version === "v1")).toBe(true);
    expect(entries.every((entry) => entry.def !== undefined)).toBe(true);
    const defs = new Set(acceptedEntries.map((entry) => entry.def));
    expect([...defs].sort()).toEqual(
      [
        "capabilityCheck.exchange",
        "contactAdd.exchange",
        "doubleWebhook.exchange",
        "sendPart.exchange",
        "verifyWebhook.exchange",
      ].sort(),
    );
    expect(acceptedEntries).toHaveLength(20);
    expect(refusedEntries.map((entry) => entry.file).sort()).toEqual([
      "invalid/refuse-bold.json",
      "invalid/refuse-key-on-text.json",
      "invalid/refuse-poll-six-options.json",
      "invalid/refuse-sms-channel.json",
      "invalid/refuse-tapback-on-poll.json",
    ]);
  });

  it("shows every send kind and every failure kind between the accepted fixtures", () => {
    const sends = filesOfCall("sendPart").map((file) => exchangeOf(file));
    expect(new Set(sends.map((send) => (send.request as unknown as SendRequest).kind))).toEqual(
      new Set(["words", "poll", "linkCard", "tapback", "photo", "typing"]),
    );
    expect(
      new Set(sends.filter((send) => send.outcome.result === "failed").map((send) => send.outcome.kind)),
    ).toEqual(new Set(["optedOut", "mayStillDeliver", "rateLimited"]));
    expect(new Set(filesOfCall("verifyWebhook").map((file) => exchangeOf(file).outcome.result))).toEqual(
      new Set(["event", "rejected"]),
    );
  });
});

describe("port-linq.v1 fixtures: each refused fixture is refused for its one reason", () => {
  const refused = (file: string): Record<string, unknown> => fixture(file) as Record<string, unknown>;
  const entryOf = (file: string): FixtureEntry => must(entries.find((candidate) => candidate.file === file));
  /** Mends a copy of a refused fixture with `mend`; the original is refused, the mended copy is accepted. */
  function putRight(file: string, mend: (copy: Exchange) => void): Exchange {
    const validate = validatorFor(entryOf(file));
    const original = refused(file);
    expect(validate(original), `${file} is refused`).toBe(false);
    const right = structuredClone(original) as unknown as Exchange;
    mend(right);
    expect(validate(right), `${file} put right: ${formatErrors(validate.errors).join("; ")}`).toBe(true);
    return right;
  }

  it("refuse-poll-six-options: with its first three options it is accepted, and is send-poll.json", () => {
    const right = putRight("invalid/refuse-poll-six-options.json", (copy) => {
      const request = copy.request as unknown as SendRequest;
      expect(must(request.options)).toHaveLength(6);
      request.options = must(request.options).slice(0, 3);
    });
    expect(right.request).toEqual((fixture("send-poll.json") as Exchange).request);
    expect(right.outcome).toEqual((fixture("send-poll.json") as Exchange).outcome);
  });

  it("refuse-tapback-on-poll: aimed at a message that is not a poll, it is accepted", () => {
    putRight("invalid/refuse-tapback-on-poll.json", (copy) => {
      const tapback = (copy.request as { tapback: { onPoll: boolean } }).tapback;
      expect(tapback.onPoll).toBe(true);
      tapback.onPoll = false;
    });
  });

  it("refuse-bold: without its text decorations it is accepted, and is send-text.json with them", () => {
    const right = putRight("invalid/refuse-bold.json", (copy) => {
      const request = copy.request;
      const extra = Object.keys(request).filter(
        (key) => !(key in (fixture("send-text.json") as Exchange).request),
      );
      expect(extra).toHaveLength(1);
      for (const key of extra) Reflect.deleteProperty(request, key);
    });
    expect(right.request).toEqual((fixture("send-text.json") as Exchange).request);
  });

  it("refuse-sms-channel: asking for iMessage's own channel (no preferredService) it is accepted", () => {
    const right = putRight("invalid/refuse-sms-channel.json", (copy) => {
      const request = copy.request;
      const extra = Object.keys(request).filter(
        (key) => !(key in (fixture("send-text.json") as Exchange).request),
      );
      expect(extra).toEqual(["preferredService"]);
      Reflect.deleteProperty(request, "preferredService");
    });
    expect(right.request).toEqual((fixture("send-text.json") as Exchange).request);
  });

  it("refuse-key-on-text: with its partKey null it is accepted, and is verify-ok.json with a key", () => {
    const right = putRight("invalid/refuse-key-on-text.json", (copy) => {
      expect(typeof copy.outcome.partKey).toBe("string");
      copy.outcome.partKey = null;
    });
    const ok = fixture("verify-ok.json") as Exchange;
    expect(right.request).toEqual(ok.request);
    expect(right.outcome).toEqual(ok.outcome);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The schema is not vacuous

describe("port-linq.v1 fixtures: removing a required field makes an accepted fixture refused", () => {
  for (const entry of acceptedEntries) {
    it(`${entry.file} (${must(entry.def)})`, () => {
      const validate = validatorFor(entry);
      const original = exchangeOf(entry.file);
      expect(validate(original), formatErrors(validate.errors).join("; ")).toBe(true);
      const call = original.call;
      const root = original as unknown as Record<string, Record<string, unknown>>;
      const required: [string, string][] = [
        ...must(def(must(entry.def)).required).map((field): [string, string] => ["", field]),
        ...must(def("given").required).map((field): [string, string] => ["given", field]),
        ...must(def(`${call}.request`).required).map((field): [string, string] => ["request", field]),
        ...requiredOfOutcome(call, original.outcome).map((field): [string, string] => ["outcome", field]),
      ];
      expect(required.length, "the schema requires at least one field here").toBeGreaterThan(0);
      for (const [parent, field] of required) {
        const where = parent === "" ? [field] : [parent, field];
        const holder: object = parent === "" ? original : must(root[parent]);
        expect(field in holder, `${entry.file} has the required field ${where.join(".")}`).toBe(true);
        expect(
          validate(without(original, where)),
          `${entry.file} without ${where.join(".")} must be refused`,
        ).toBe(false);
      }
      expect(
        validate({ ...original, notInTheSchema: 1 }),
        `${entry.file} with an unknown field must be refused`,
      ).toBe(false);
      expect(
        validate({ ...original, outcome: { ...original.outcome, notInTheSchema: 1 } }),
        `${entry.file} with an unknown outcome field must be refused`,
      ).toBe(false);
    });
  }

  it("takes the required fields of every outcome from the schema, so none is left unchecked", () => {
    const seen = new Set(
      acceptedEntries.map((entry) => `${entry.def ?? ""}/${exchangeOf(entry.file).outcome.result}`),
    );
    for (const name of seen) {
      const [exchangeDef, result] = name.split("/") as [string, string];
      const call = exchangeDef.replace(".exchange", "");
      expect(requiredOfOutcome(call, { result }).length, name).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. What the schema leaves to code, read from the fixtures

describe("port-linq.v1 fixtures: the webhook checks the schema leaves to code", () => {
  const verifyFiles = filesOfCall("verifyWebhook");

  it("holds for every verifyWebhook fixture", () => {
    expect(verifyFiles.length).toBeGreaterThan(3);
    for (const file of verifyFiles) expect(checkVerifyExchange(exchangeOf(file)), file).toEqual([]);
  });

  it("has verify-stale-timestamp outside the 300 s window and every other verify fixture inside it", () => {
    const stale = exchangeOf("verify-stale-timestamp.json");
    const request = stale.request as unknown as WebhookRequest;
    expect(secondsOf(request.receivedAt) - Number(request.timestamp)).toBe(900);
    for (const file of verifyFiles.filter((name) => name !== "verify-stale-timestamp.json")) {
      const other = exchangeOf(file).request as unknown as WebhookRequest;
      expect(Math.abs(secondsOf(other.receivedAt) - Number(other.timestamp)), file).toBeLessThanOrEqual(
        WINDOW_SECONDS,
      );
    }
  });

  it("has verify-ok give K-06's text-imessage.json and the double's webhook give test-phone-page.json, field for field", () => {
    expect(must(exchangeOf("verify-ok.json").outcome.event)).toEqual(inboundFixture("text-imessage.json"));
    const doubled = exchangeOf("double-signed-webhook.json");
    expect((doubled.request as { event: unknown }).event).toEqual(inboundFixture("test-phone-page.json"));
  });

  it("has the double's signed webhook carry the event it was asked for", () => {
    expect(checkDoubleExchange(exchangeOf("double-signed-webhook.json"))).toEqual([]);
  });

  it("has verify-delivered-after-4006 carry the key of the failed send in error-4006", () => {
    expect(
      checkLateReceipt(exchangeOf("verify-delivered-after-4006.json"), exchangeOf("error-4006.json")),
    ).toEqual([]);
  });

  it("gives a part key only on a sent or delivered receipt (the one receipt among the fixtures carries one)", () => {
    for (const file of verifyFiles) {
      const outcome = exchangeOf(file).outcome;
      if (outcome.result !== "event") continue;
      if (outcome.partKey !== null) {
        expect(["sent", "delivered"], file).toContain(must(outcome.event).kind);
        expect(file).toBe("verify-delivered-after-4006.json");
      }
    }
  });

  it("fires on a damaged copy of a verify fixture, the double's webhook and the late receipt", () => {
    const early = exchangeOf("verify-stale-timestamp.json");
    (early.request as unknown as WebhookRequest).timestamp = "1791821901";
    expect(checkVerifyExchange(early)).toEqual([
      "staleTimestamp, but the timestamp is 100 s from receipt, inside 300 s",
    ]);
    const late = exchangeOf("verify-ok.json");
    (late.request as unknown as WebhookRequest).timestamp = String(
      Number((late.request as unknown as WebhookRequest).timestamp) - 600,
    );
    expect(checkVerifyExchange(late)).toEqual([
      "event but the timestamp is 600 s from receipt, outside 300 s",
    ]);
    const signed = exchangeOf("verify-bad-signature.json");
    signed.given.signing = "valid";
    expect(checkVerifyExchange(signed)).toEqual([
      "badSignature is the outcome exactly when the given signing is oneByteChanged",
    ]);
    const unsigned = exchangeOf("verify-ok.json");
    unsigned.given.signing = "oneByteChanged";
    expect(checkVerifyExchange(unsigned)).toEqual([
      "badSignature is the outcome exactly when the given signing is oneByteChanged",
    ]);
    const id = exchangeOf("verify-ok.json");
    (id.request as unknown as WebhookRequest).webhookId = "evt-other";
    expect(checkVerifyExchange(id)).toEqual([
      "the webhook id is not the raw body's event id",
      "the parsed event's id is not the webhook id",
    ]);

    const double = exchangeOf("double-signed-webhook.json");
    must(double.outcome.webhook).timestamp = "1792501202";
    expect(checkDoubleExchange(double)).toEqual(["the timestamp is not the receipt"]);
    const words = exchangeOf("double-signed-webhook.json");
    (words.request as { event: { body: string } }).event.body = "Hello.";
    expect(checkDoubleExchange(words)).toEqual(["the raw body's words are not the event's body"]);

    const receipt = exchangeOf("verify-delivered-after-4006.json");
    receipt.outcome.partKey = "out-sam-booked-riley/1/2";
    expect(checkLateReceipt(receipt, exchangeOf("error-4006.json"))).toEqual([
      "the receipt's partKey is not the failed send's key out-sam-booked-riley/1/1",
    ]);
    const withId = exchangeOf("error-4006.json");
    withId.outcome.providerMessageId = "linq-msg-x";
    expect(checkLateReceipt(exchangeOf("verify-delivered-after-4006.json"), withId)).toEqual([
      "the failed send has a message id",
    ]);
    const retried = exchangeOf("error-4006.json");
    retried.outcome.kind = "refused";
    expect(checkLateReceipt(exchangeOf("verify-delivered-after-4006.json"), retried)).toEqual([
      "the failed send is not mayStillDeliver",
    ]);
  });
});

describe("port-linq.v1 fixtures: the send checks the schema leaves to code", () => {
  const sendFiles = filesOfCall("sendPart");

  it("holds for every sendPart fixture", () => {
    expect(sendFiles.length).toBeGreaterThan(10);
    for (const file of sendFiles) expect(checkSendExchange(exchangeOf(file)), file).toEqual([]);
  });

  it("has the poll's option ids in its options' order and a tapback and typing with no message id", () => {
    const poll = exchangeOf("send-poll.json");
    expect(must(poll.outcome.providerOptionIds)).toHaveLength(
      must((poll.request as unknown as SendRequest).options).length,
    );
    expect(exchangeOf("send-tapback.json").outcome.providerMessageId).toBeNull();
    expect(exchangeOf("send-typing.json").outcome.providerMessageId).toBeNull();
  });

  it("fires on a damaged copy: a poll answered with too few ids, a tapback with an id, a card with none", () => {
    const poll = exchangeOf("send-poll.json");
    must(poll.outcome.providerOptionIds).pop();
    expect(checkSendExchange(poll)).toEqual(["a poll of 3 options is answered with 2 option ids"]);
    const repeated = exchangeOf("send-poll.json");
    must(repeated.outcome.providerOptionIds)[1] = "linq-opt-demo-1";
    expect(checkSendExchange(repeated)).toEqual(["a poll's option ids are not all different"]);
    const text = exchangeOf("send-text.json");
    text.outcome.providerOptionIds = ["linq-opt-demo-1"];
    expect(checkSendExchange(text)).toEqual(["a words is answered with option ids"]);
    const tapback = exchangeOf("send-tapback.json");
    tapback.outcome.providerMessageId = "linq-msg-demo-0009";
    expect(checkSendExchange(tapback)).toEqual(["an accepted tapback has a message id"]);
    const typing = exchangeOf("send-typing.json");
    typing.outcome.providerMessageId = "linq-msg-demo-0009";
    expect(checkSendExchange(typing)).toEqual(["an accepted typing has a message id"]);
    const card = exchangeOf("send-link-card.json");
    card.outcome.providerMessageId = null;
    expect(checkSendExchange(card)).toEqual(["an accepted linkCard has no message id"]);
    const key = exchangeOf("send-text.json");
    (key.request as unknown as SendRequest).idempotencyKey = "out-a7-03-alex";
    expect(checkSendExchange(key)).toEqual(["the part key is not <row>/<part>/<try>"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sides: where each producer and consumer side is added

export interface SideCheck {
  id: string;
  side: "producer" | "consumer";
  owner: string;
  components: string;
  needs: string;
  /** Added by the QA side task for this side; it returns one line per problem. */
  check?: () => string[];
}

/**
 * contracts/port-linq/README.md "Producers and consumers". Each side is added later by a QA side task that depends on
 * this task and on that side's build task: it fills `check` (and moves its own test beside this one). Until then the
 * side is held here with what it must show, so none is forgotten.
 */
export const SIDE_CHECKS: readonly SideCheck[] = [
  {
    id: "producer-integrations",
    side: "producer",
    owner: "integrations engineer",
    components:
      "C-206 Linq send, C-207 Linq webhook events, C-208 Linq contacts registrar, C-209 Linq capability check, C-210 staging roster allow-list, C-211 Linq double",
    needs:
      "The adapter, on the recorded samples in vendor-samples/, and the double give the same port-level results as the fixtures for every call, its errors read as the five send kinds; the double answers sendPart and contactAdd with any outcome the contract defines and records every sendPart request in order; doubleWebhook round-trips through verifyWebhook, its event and partKey both; the adapter reads partKey from a receipt's idempotency_key; the signature is made at run time (HMAC over id.timestamp.raw) and a changed byte is badSignature; a staging send outside the roster is refused by the allow-list.",
  },
  {
    id: "consumer-runtime",
    side: "consumer",
    owner: "runtime engineer",
    components:
      "C-044 gateway Worker (verify and parse), C-047 safety read on arrival, C-052 guard fixed replies (`overrideOptout`), C-124 outbox dispatcher, C-127 two-part send, C-128 allowed formats",
    needs:
      "The gateway rejects every bad signature and stale timestamp with 401 and writes no event, answers 200 for an ignored event type, hands partKey on beside the sealed event; the dispatcher finds a failed part with no message id by partKey and moves it to delivered within 1 minute, takes each error kind to K-07's retry rule, keeps typing dots to 60 s and 2 minutes, and sends the two parts in order; allowed formats follow the service (no file or thread on SMS, no poll on RCS or SMS).",
  },
  {
    id: "consumer-action-layer",
    side: "consumer",
    owner: "action-layer engineer",
    components: "C-103 chat link and QR, C-109 effects runner (contacts/add, CQ-04)",
    needs:
      "The effects runner's linq_contact_add effect builds contactAdd.request as its portRequest and reads added, alreadyContact and failed with retryable as the contact fixtures write them; the chat link waits for added and shows no link after a failed that is not retryable.",
  },
  {
    id: "consumer-integrations",
    side: "consumer",
    owner: "integrations engineer",
    components: "C-178 an unregistered mobile texts",
    needs:
      "The unregistered-mobile path reads the capability check and contact add as the fixtures write them (capability.json: a number on RCS gets text alone; contact-add-failed.json: no chat link).",
  },
  {
    id: "consumer-frontend",
    side: "consumer",
    owner: "frontend engineer",
    components: "C-205 test-phone page",
    needs:
      "The test-phone page posts its text through the double's doubleWebhook and the gateway's verifyWebhook gives back the event it made, as double-signed-webhook.json shows.",
  },
];

describe("port-linq.v1 sides: the list where each producer and consumer side is added", () => {
  const readme = readFileSync(path.join(LINQ_DIR, "README.md"), "utf8");
  const start = readme.indexOf("## Producers and consumers");
  const listed = readme.slice(start, readme.indexOf("- **Contract test**", start));

  it("names each side once, with the producers and consumers of the README", () => {
    const ids = SIDE_CHECKS.map((side) => side.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SIDE_CHECKS.filter((side) => side.side === "producer")).toHaveLength(1);
    expect(SIDE_CHECKS.filter((side) => side.side === "consumer")).toHaveLength(4);
    for (const side of SIDE_CHECKS) {
      expect(side.owner, side.id).not.toBe("");
      expect(side.components, side.id).not.toBe("");
      expect(side.needs, side.id).not.toBe("");
    }
  });

  it("names every component the README's producers and consumers list, and no other", () => {
    expect(start).toBeGreaterThan(-1);
    const named = new Set(listed.match(/C-\d{3}/g));
    const held = new Set(SIDE_CHECKS.flatMap((side) => side.components.match(/C-\d{3}/g) ?? []));
    expect(named.size).toBeGreaterThan(10);
    expect([...held].sort()).toEqual([...named].sort());
  });

  it("spells each side's owner and components as the README does", () => {
    for (const side of SIDE_CHECKS) {
      expect(listed, side.id).toContain(side.owner);
      for (const component of side.components.split(", ")) expect(listed, side.id).toContain(component);
    }
  });

  for (const side of SIDE_CHECKS) {
    if (side.check === undefined) continue;
    const check = side.check;
    it(`${side.side} side ${side.id}`, () => {
      expect(check()).toEqual([]);
    });
  }
});
