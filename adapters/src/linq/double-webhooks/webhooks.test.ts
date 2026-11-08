// T-412: the Linq double's signed webhooks, checked against T-413's real adapter and the contracts' fixtures. No network and
// no real key: the secret is a made-up test string built here, and every phone is the fictional 555-01xx.
//
// The proof T-413 could not give: the double and the adapter give identical K-06 events for the same input. Each K-06
// fixture event is signed by the double, verified by `createLinqWebhookVerifier`, and must come back equal to the fixture.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createLinqDouble } from "../double";
import { createLinqWebhookVerifier } from "../webhook/verify";
import type { InboundEvent, VerifyWebhookRequest, VerifyWebhookResult } from "../webhook/types";
import {
  LinqDoubleWebhookError,
  STALE_BY_SECONDS,
  createLinqWebhookDouble,
  eventFromDoubleEvent,
  type DoubleWebhookRequest,
} from "./webhooks";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const LINQ_FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const K06_FIXTURES = path.join(CONTRACTS, "inbound-event", "fixtures");

// A made-up test secret: "whsec_" and base64. Not a key of any service.
const SECRET = `whsec_${btoa("rosie-double-test-bytes-0001")}`;

// The chat's person, as the gateway's thread lookup gives it (K-04 threads.linq_chat_id).
const CHATS: Readonly<Record<string, string>> = {
  "linq-chat-demo-alex": "+15555550101",
  "linq-chat-demo-sam": "+15555550100",
  "linq-chat-demo-tomas": "+15555550105",
  "linq-chat-double-0104": "+15555550104",
  "linq-chat-demo-0106": "+15555550106",
};

const verifier = createLinqWebhookVerifier({
  secret: () => SECRET,
  chatHandle: (chatId) => CHATS[chatId] ?? null,
  optionWords: (pollId, optionId) =>
    pollId === "linq-msg-demo-0002" && optionId === "linq-opt-demo-2" ? "Sat 2:00pm" : null,
});

const double = createLinqWebhookDouble({ secret: SECRET });

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const k06 = (name: string): InboundEvent =>
  readJson(path.join(K06_FIXTURES, name)) as unknown as InboundEvent;

let validateEvent: ValidateFunction;
let validateExchange: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name))) {
      if (file.endsWith(".schema.json")) ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)));
    }
  }
  const event = ajv.getSchema("https://rosie.invalid/contracts/inbound-event/inbound-event.v1.schema.json");
  const exchange = ajv.getSchema("https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json");
  if (event === undefined || exchange === undefined) throw new Error("a contract schema has no root");
  validateEvent = event;
  validateExchange = exchange;
});

function eventOf(result: VerifyWebhookResult) {
  if (result.result !== "event") throw new Error(`expected an event, got ${result.result}`);
  expect(validateEvent(result.event), JSON.stringify(validateEvent.errors)).toBe(true);
  return result;
}

// fixture, then the part key a receipt echoes (null for every other kind).
const TABLE: [string, string | null][] = [
  ["text-imessage.json", null],
  ["photo.json", null],
  ["reaction-from-customer.json", null],
  ["reaction-from-rosie.json", null],
  ["poll-vote.json", null],
  ["poll-vote-removed.json", null],
  ["edit-after-commit.json", null],
  ["delivered.json", "out-a7-03-alex/1/1"],
  ["sent.json", "out-tomas-booked/1/1"],
  ["poll-failed.json", null],
  ["duplicate-event.json", null],
  ["test-phone-page.json", null],
];

describe("each generated webhook verifies under T-413's adapter and parses to its K-06 fixture", () => {
  it.each(TABLE)("%s", async (name, partKey) => {
    const event = k06(name);
    const webhook = await double.sign({ event, partKey });
    expect(webhook.webhookId).toBe(event.eventId);
    expect(webhook.signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const result = eventOf(await verifier.verifyWebhook(webhook));
    expect(result.event).toEqual(event);
    expect(result.partKey).toBe(partKey);
  });

  it("covers every K-06 fixture a Linq event can make", () => {
    const linqKinds = new Set(TABLE.map(([name]) => k06(name).kind));
    expect([...linqKinds].sort()).toEqual(
      ["delivered", "edit", "failed", "photo", "pollVote", "reaction", "sent", "text", "voteRemoved"].sort(),
    );
  });

  it("makes the K-11 double-signed-webhook.json exchange: the same raw body and timestamp, a valid signature", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "double-signed-webhook.json")) as {
      call: string;
      given: unknown;
      request: DoubleWebhookRequest;
      outcome: { result: "signed"; webhook: VerifyWebhookRequest };
    };
    const fresh = createLinqWebhookDouble({ secret: SECRET });
    const webhook = await fresh.sign(fixture.request);
    expect(webhook.raw).toBe(fixture.outcome.webhook.raw);
    expect(webhook.timestamp).toBe(fixture.outcome.webhook.timestamp);
    expect(webhook.webhookId).toBe(fixture.outcome.webhook.webhookId);
    expect({ ...webhook, signature: "v1,signed-at-test-time" }).toEqual(fixture.outcome.webhook);
    // The exchange is valid against the port's own schema.
    const exchange = { ...fixture, outcome: { result: "signed", webhook } };
    expect(validateExchange(exchange), JSON.stringify(validateExchange.errors)).toBe(true);
    expect(eventOf(await verifier.verifyWebhook(webhook)).event).toEqual(fixture.request.event);
    expect(webhook.signature).not.toBe(fixture.outcome.webhook.signature);
  });

  it("signs the same event twice into the same webhook id and a verifying body: a duplicate Linq retry", async () => {
    const first = await double.sign({ event: k06("text-imessage.json"), partKey: null });
    const retry = await double.sign({ event: k06("duplicate-event.json"), partKey: null });
    expect(retry.webhookId).toBe(first.webhookId);
    expect(retry.receivedAt).not.toBe(first.receivedAt);
    const a = eventOf(await verifier.verifyWebhook(first));
    const b = eventOf(await verifier.verifyWebhook(retry));
    expect(b.event.eventId).toBe(a.event.eventId);
    expect(b.event.receivedAt).toBe("2026-10-12T16:20:31Z");
  });

  it("holds every kind's body to the adapter's wire form: parts, is_me false and the 2026-02-03 envelope", async () => {
    const webhook = await double.sign({ event: k06("photo.json"), partKey: null });
    const body = JSON.parse(webhook.raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      api_version: "v3",
      webhook_version: "2026-02-03",
      event_type: "message.received",
    });
    expect(body.data).toMatchObject({
      direction: "inbound",
      sender_handle: { is_me: false, service: "iMessage" },
      parts: [
        { type: "text", value: "Here's my price list" },
        { type: "media", id: "att-sam-price-list", mime_type: "image/jpeg" },
      ],
    });
  });
});

describe("the 300 s window", () => {
  it("makes a webhook outside the window on request, correctly signed, that fails verification", async () => {
    const event = k06("text-imessage.json");
    const stale = await double.sign({ event, partKey: null }, { stale: true });
    const fresh = await double.sign({ event, partKey: null });
    expect(Number(fresh.timestamp) - Number(stale.timestamp)).toBe(STALE_BY_SECONDS);
    expect(stale.signature).not.toBe(fresh.signature);
    expect(await verifier.verifyWebhook(stale)).toEqual({
      result: "rejected",
      httpStatus: 401,
      reason: "staleTimestamp",
    });
  });

  it("its signature is right for the old timestamp: the same webhook with a fresh timestamp and no new signature is a bad signature", async () => {
    const event = k06("text-imessage.json");
    const stale = await double.sign({ event, partKey: null }, { stale: true });
    const moved = { ...stale, timestamp: String(Date.parse(event.receivedAt) / 1000) };
    expect(await verifier.verifyWebhook(moved)).toMatchObject({ result: "rejected", reason: "badSignature" });
  });

  it("holds the edge: 300 s old passes, 301 s old is stale, and a given age is taken in seconds", async () => {
    const event = k06("text-imessage.json");
    expect(
      (await verifier.verifyWebhook(await double.sign({ event, partKey: null }, { stale: 300 }))).result,
    ).toBe("event");
    expect(
      await verifier.verifyWebhook(await double.sign({ event, partKey: null }, { stale: 301 })),
    ).toMatchObject({
      reason: "staleTimestamp",
    });
    expect(
      (await verifier.verifyWebhook(await double.sign({ event, partKey: null }, { stale: false }))).result,
    ).toBe("event");
  });

  it("matches verify-stale-timestamp.json: a correctly signed webhook the window refuses", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "verify-stale-timestamp.json")) as {
      request: VerifyWebhookRequest;
      outcome: unknown;
    };
    const stale = await double.sign({ event: k06("text-imessage.json"), partKey: null }, { stale: true });
    expect(await verifier.verifyWebhook(stale)).toEqual(fixture.outcome);
  });

  it("a webhook signed under another secret, or with a changed byte, is refused", async () => {
    const event = k06("text-imessage.json");
    const other = createLinqWebhookDouble({ secret: `whsec_${btoa("another-test-bytes-0002")}` });
    expect(await verifier.verifyWebhook(await other.sign({ event, partKey: null }))).toMatchObject({
      reason: "badSignature",
    });
    const ok = await double.sign({ event, partKey: null });
    expect(await verifier.verifyWebhook({ ...ok, raw: `${ok.raw} ` })).toMatchObject({
      reason: "badSignature",
    });
  });
});

describe("Rosie's own echoes carry is_me, so the adapter ignores them", () => {
  const echo = {
    eventId: "evt-double-echo-0001",
    chatId: "linq-chat-demo-alex",
    messageId: "linq-msg-double-0001",
    text: "Which time works?",
    service: "imessage" as const,
    sentAt: "2026-10-23T14:05:03Z",
    receivedAt: "2026-10-23T14:05:04Z",
    traceId: "trace-double-echo-0001",
  };

  it("an echoed message.received verifies and is ignored, never a customer event", async () => {
    const webhook = await double.echo(echo);
    expect(JSON.parse(webhook.raw)).toMatchObject({
      event_type: "message.received",
      data: { sender_handle: { handle: "+15555550199", is_me: true } },
    });
    expect(await verifier.verifyWebhook(webhook)).toEqual({
      result: "ignored",
      httpStatus: 200,
      eventType: "message.received",
    });
  });

  it("a stale echo is refused by the window before anything is read", async () => {
    expect(await verifier.verifyWebhook(await double.echo(echo, { stale: true }))).toMatchObject({
      result: "rejected",
      reason: "staleTimestamp",
    });
  });

  it("only the chosen test phone's own words become customer events: its text is the one event, its handle the test phone", async () => {
    const event = k06("test-phone-page.json");
    const mine = eventOf(await verifier.verifyWebhook(await double.sign({ event, partKey: null })));
    expect(mine.event.handle).toEqual({ kind: "phone", address: "+15555550104" });
    expect(mine.event.fromRosie).toBe(false);
    const echoed = await verifier.verifyWebhook(
      await double.echo({ ...echo, chatId: "linq-chat-double-0104", text: event.body ?? "" }),
    );
    expect(echoed.result).toBe("ignored");
  });

  it("Rosie's own reaction goes in with Rosie's line as the sender and fromRosie true; the person comes from the chat", async () => {
    const webhook = await double.sign({ event: k06("reaction-from-rosie.json"), partKey: null });
    expect(JSON.parse(webhook.raw)).toMatchObject({
      data: { is_from_me: true, from_handle: { handle: "+15555550199", is_me: true } },
    });
    const result = eventOf(await verifier.verifyWebhook(webhook));
    expect(result.event.fromRosie).toBe(true);
    expect(result.event.handle.address).toBe("+15555550101");
  });
});

describe("faked events of T-411's Linq double", () => {
  it("a sent receipt, a delivered receipt, a vote, a removed vote and a failure verify back to the K-06 event", async () => {
    const linq = createLinqDouble({ now: () => "2026-10-23T14:05:06Z" });
    const words = readJson(path.join(LINQ_FIXTURES, "send-text.json")).request as Record<string, unknown>;
    const poll = readJson(path.join(LINQ_FIXTURES, "send-poll.json")).request as Record<string, unknown>;
    linq.sendPart(words);
    const pollOutcome = linq.sendPart(poll);
    if (pollOutcome.result !== "accepted" || pollOutcome.providerOptionIds === null)
      throw new Error("not accepted");
    const pollId = pollOutcome.providerMessageId ?? "";
    const optionId = pollOutcome.providerOptionIds[1] ?? "";
    const key = words.idempotencyKey as string;
    const context = {
      receivedAt: "2026-10-23T14:05:07Z",
      traceId: "trace-double-faked-0001",
      handle: "+15555550101",
      chatId: "linq-chat-demo-alex",
    };

    const sent = eventFromDoubleEvent(linq.fakeSent(key), { ...context, eventId: "evt-double-sent-0001" });
    const delivered = eventFromDoubleEvent(linq.fakeDelivered(key), {
      ...context,
      eventId: "evt-double-delivered-0001",
    });
    const vote = eventFromDoubleEvent(linq.fakePollVote(pollId, optionId, "+15555550101"), {
      ...context,
      eventId: "evt-double-vote-0001",
    });
    const removed = eventFromDoubleEvent(linq.fakePollVote(pollId, optionId, "+15555550101", true), {
      ...context,
      eventId: "evt-double-vote-0002",
    });
    const failure = eventFromDoubleEvent(linq.fakeFailure("4006", key), {
      ...context,
      eventId: "evt-double-failed-0001",
    });

    const own = createLinqWebhookVerifier({ secret: () => SECRET, chatHandle: (id) => CHATS[id] ?? null });
    for (const request of [sent, delivered, vote, removed, failure]) {
      const result = eventOf(await own.verifyWebhook(await double.sign(request)));
      expect(result.event).toEqual(request.event);
      expect(result.partKey).toBe(request.partKey);
    }
    expect(sent.partKey).toBe(key);
    expect(delivered.event.kind).toBe("delivered");
    expect(vote.event.kind).toBe("pollVote");
    expect(removed.event.kind).toBe("voteRemoved");
    expect(failure.event.status?.failure).toEqual({ code: "4006", reason: "Delivery failed." });
  });

  it("a late receipt after a part failed with no message id needs the caller's message id, else it throws a label", () => {
    const linq = createLinqDouble();
    const request = readJson(path.join(LINQ_FIXTURES, "send-text.json")).request as Record<string, unknown>;
    linq.failNextSend({ kind: "mayStillDeliver", code: "4006" });
    linq.sendPart(request);
    const key = request.idempotencyKey as string;
    const context = {
      eventId: "evt-double-late-0001",
      receivedAt: "2026-10-23T14:06:00Z",
      traceId: "trace-double-late-0001",
      handle: "+15555550101",
      chatId: "linq-chat-demo-alex",
    };
    expect(() => eventFromDoubleEvent(linq.fakeDelivered(key), context)).toThrow(LinqDoubleWebhookError);
    const late = eventFromDoubleEvent(linq.fakeDelivered(key), {
      ...context,
      messageId: "linq-msg-double-late",
    });
    expect(late.partKey).toBe(key);
  });
});

describe("a request the double cannot sign names a label, never a value", () => {
  const text = k06("text-imessage.json");
  const attempt = (change: Partial<InboundEvent>, partKey: string | null = null) =>
    double.sign({ event: { ...text, ...change }, partKey });

  it.each([
    [
      "a number that is not fictional",
      { handle: { kind: "phone" as const, address: "+14155551234" } },
      null,
      "notFictionalPhone",
    ],
    ["an event that is not Linq's", { provider: "linq-other" as unknown as "linq" }, null, "notLinq"],
    ["a key on a text", {}, "out-a/1/1", "keyOnNonReceipt"],
    ["a photo with no image", { kind: "photo" as const }, null, "notAnImage"],
    [
      "a text with an image",
      { attachments: [{ attachmentId: "a-1", mediaType: "image/png" }] },
      null,
      "imageOnText",
    ],
    ["a send time that is not UTC", { sentAt: "yesterday" }, null, "badTime"],
    ["a text with no service", { service: null }, null, "missingField"],
    ["a kind of no Linq event", { kind: "email" as unknown as "text" }, null, "unknownKind"],
  ])("%s", async (_name, change, partKey, code) => {
    const failed = attempt(change, partKey);
    await expect(failed).rejects.toBeInstanceOf(LinqDoubleWebhookError);
    await expect(failed).rejects.toMatchObject({ code, message: code });
  });

  // Kinds beyond a text: each fixture is the K-06 event of its kind.
  const KIND_FIXTURES: [string, string, string | null][] = [
    ["text", "text-imessage.json", null],
    ["photo", "photo.json", null],
    ["edit", "edit-after-commit.json", null],
    ["pollVote", "poll-vote.json", null],
    ["voteRemoved", "poll-vote-removed.json", null],
    ["sent", "sent.json", "out-tomas-booked/1/1"],
    ["delivered", "delivered.json", "out-a7-03-alex/1/1"],
    ["failed", "poll-failed.json", null],
    ["reaction from a customer", "reaction-from-customer.json", null],
    ["reaction from Rosie", "reaction-from-rosie.json", null],
  ];
  const NO_SUCH_LINE = "+11235550100";

  it.each(
    KIND_FIXTURES.filter(([name]) => name !== "reaction from a customer" && name !== "reaction from Rosie"),
  )("refuses fromRosie true on a %s", async (_name, file, partKey) => {
    const failed = double.sign({ event: { ...k06(file), fromRosie: true }, partKey });
    await expect(failed).rejects.toMatchObject({ code: "fromRosieOnNonReaction" });
  });

  it.each(KIND_FIXTURES)("refuses a number outside 555-01xx on a %s", async (_name, file, partKey) => {
    const event = { ...k06(file), handle: { kind: "phone" as const, address: NO_SUCH_LINE } };
    const failed = double.sign({ event, partKey });
    await expect(failed).rejects.toMatchObject({ code: "notFictionalPhone" });
  });

  it.each(["sent", "delivered", "failed"] as const)(
    "refuses a faked %s event of T-411's double whose handle is not fictional",
    async (kind) => {
      const doubleEvent =
        kind === "failed"
          ? { kind, at: "2026-11-07T10:00:00Z", partKey: null, messageId: "m-1", code: "4006", reason: "x" }
          : { kind, at: "2026-11-07T10:00:00Z", partKey: "k/1/1", messageId: "m-1", chatId: "chat-1" };
      const request = eventFromDoubleEvent(doubleEvent, {
        eventId: "evt-1",
        receivedAt: "2026-11-07T10:00:01Z",
        traceId: "trace-1",
        handle: NO_SUCH_LINE,
        chatId: "chat-1",
      });
      await expect(double.sign(request)).rejects.toMatchObject({ code: "notFictionalPhone" });
    },
  );

  it("refuses a secret that is not whsec_ and base64, and a Rosie line that is not fictional", async () => {
    await expect(
      createLinqWebhookDouble({ secret: "not-a-secret" }).sign({ event: text, partKey: null }),
    ).rejects.toThrow();
    expect(() => createLinqWebhookDouble({ secret: SECRET, rosieLine: "+14155551234" })).toThrow(
      LinqDoubleWebhookError,
    );
  });
});
