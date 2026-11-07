// T-413: Linq webhook verify and parse on the recorded vendor samples and K-11 v1's fixtures. No network, no real key:
// the secret below is a made-up test string, and every signature is made at test time. Phones are the fictional 555-01xx.
//
// The Linq double (T-411) makes no signed webhooks yet (T-412 does), so "the double and the adapter give the same event"
// is checked here against the K-11 fixtures the double serves: `double-signed-webhook.json` is signed at test time and
// must verify back to the event the double was given, and `verify-ok` and `verify-delivered-after-4006` must give the
// fixtures' own K-06 events, byte for byte.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { signLinqWebhook } from "../../shared/hmac";
import { loadRecordedSample, loadRecordedSampleText } from "../../shared/samples";
import { LinqWebhookError, parseLinqWebhook } from "./parse";
import type { VerifyWebhookRequest, VerifyWebhookResult } from "./types";
import { createLinqWebhookVerifier } from "./verify";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const SAMPLES = path.join(CONTRACTS, "port-linq", "vendor-samples");
const LINQ_FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const K06_FIXTURES = path.join(CONTRACTS, "inbound-event", "fixtures");

// A made-up test secret: "whsec_" and base64, as Linq's form. Not a key of any service.
const SECRET = `whsec_${btoa("rosie-test-signing-bytes-0001")}`;

// The chat's person, as the gateway's thread lookup would give it (K-04 threads.linq_chat_id), for the sample cast.
const CHATS: Readonly<Record<string, string>> = {
  "linq-chat-demo-alex": "+15555550101",
  "linq-chat-demo-sam": "+15555550100",
  "linq-chat-demo-tomas": "+15555550105",
  "linq-chat-demo-0106": "+15555550106",
};

const verifier = createLinqWebhookVerifier({
  secret: () => SECRET,
  chatHandle: (chatId) => CHATS[chatId] ?? null,
});

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** A request for `raw`, signed now under SECRET; its clock is the webhook's own `created_at`. */
async function signed(raw: string, id: string, createdAt: string): Promise<VerifyWebhookRequest> {
  const timestamp = String(Date.parse(createdAt) / 1000);
  return {
    webhookId: id,
    timestamp,
    signature: await signLinqWebhook(SECRET, id, timestamp, raw),
    raw,
    receivedAt: createdAt,
    traceId: "trace-test-0001",
  };
}

function sampleRequest(name: string): Promise<VerifyWebhookRequest> {
  const raw = loadRecordedSampleText(SAMPLES, name);
  const body = JSON.parse(raw) as { event_id: string; created_at: string };
  return signed(raw, body.event_id, body.created_at);
}

/** A sample's JSON with edits by dotted path (undefined removes), so a test changes one fact and signs the result. */
interface Doc {
  set(path: string, value: unknown): void;
  get(path: string): unknown;
  text(): string;
}

function doc(raw: string): Doc {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const walk = (keys: string[]): Record<string, unknown> => {
    let at = root;
    for (const key of keys) at = at[key] as Record<string, unknown>;
    return at;
  };
  return {
    set(path, value) {
      const keys = path.split(".");
      const last = keys.pop() ?? "";
      const parent = walk(keys);
      // Removing a key rebuilds the object without it (no dynamic delete).
      if (value === undefined) {
        const kept = Object.entries(parent).filter(([key]) => key !== last);
        for (const key of Object.keys(parent)) Reflect.deleteProperty(parent, key);
        Object.assign(parent, Object.fromEntries(kept));
      } else parent[last] = value;
    },
    get(path) {
      const keys = path.split(".");
      const last = keys.pop() ?? "";
      return walk(keys)[last];
    },
    text: () => JSON.stringify(root),
  };
}

let validateEvent: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name))) {
      if (file.endsWith(".schema.json")) ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)));
    }
  }
  const check = ajv.getSchema("https://rosie.invalid/contracts/inbound-event/inbound-event.v1.schema.json");
  if (check === undefined) throw new Error("the schema has no K-06 root");
  validateEvent = check;
});

function eventOf(result: VerifyWebhookResult) {
  if (result.result !== "event") throw new Error(`expected an event, got ${result.result}`);
  expect(validateEvent(result.event), JSON.stringify(validateEvent.errors)).toBe(true);
  return result;
}

/** Fixture and event agree on every field's nullness and type (their ids differ: a fixture is its own story). */
function sameShape(event: Record<string, unknown>, fixture: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(fixture)) {
    // `service` is whatever Linq reports on that event, and each case checks it by name: a fixture may hold null
    // (poll-failed.json) where the recorded sample reports iMessage.
    if (key === "service") continue;
    const got = event[key];
    if (expected === null) expect(got, key).toBeNull();
    else if (Array.isArray(expected)) expect(Array.isArray(got), key).toBe(true);
    else expect(typeof got, key).toBe(typeof expected);
  }
  expect(Object.keys(event).sort()).toEqual(Object.keys(fixture).sort());
}

describe("the contract's exchanges (K-11 v1 fixtures)", () => {
  it("verify-ok.json passes and gives the fixture's K-06 event and a null partKey", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "verify-ok.json")) as {
      request: VerifyWebhookRequest;
      outcome: unknown;
    };
    const { request } = fixture;
    const signature = await signLinqWebhook(SECRET, request.webhookId, request.timestamp, request.raw);
    expect(await verifier.verifyWebhook({ ...request, signature })).toEqual(fixture.outcome);
  });

  it("verify-delivered-after-4006.json gives the delivered event with the part's key beside it", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "verify-delivered-after-4006.json")) as {
      request: VerifyWebhookRequest;
      outcome: unknown;
    };
    const { request } = fixture;
    const signature = await signLinqWebhook(SECRET, request.webhookId, request.timestamp, request.raw);
    const result = await verifier.verifyWebhook({ ...request, signature });
    expect(result).toEqual(fixture.outcome);
    expect(eventOf(result).partKey).toBe("out-sam-booked-riley/1/1");
  });

  it("verify-bad-signature.json is rejected: one byte of a valid signature changed", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "verify-bad-signature.json")) as {
      request: VerifyWebhookRequest;
      outcome: unknown;
    };
    const { request } = fixture;
    const good = await signLinqWebhook(SECRET, request.webhookId, request.timestamp, request.raw);
    // Change the first base64 character after "v1,": a different first byte, still valid base64.
    const first = good.charAt(3) === "A" ? "B" : "A";
    const signature = `${good.slice(0, 3)}${first}${good.slice(4)}`;
    expect(signature).not.toBe(good);
    expect(await verifier.verifyWebhook({ ...request, signature })).toEqual(fixture.outcome);
  });

  it("verify-stale-timestamp.json is rejected although correctly signed", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "verify-stale-timestamp.json")) as {
      request: VerifyWebhookRequest;
      outcome: unknown;
    };
    const { request } = fixture;
    const signature = await signLinqWebhook(SECRET, request.webhookId, request.timestamp, request.raw);
    expect(await verifier.verifyWebhook({ ...request, signature })).toEqual(fixture.outcome);
  });

  it("double-signed-webhook.json, signed at test time, verifies back to the event the double was given", async () => {
    const fixture = readJson(path.join(LINQ_FIXTURES, "double-signed-webhook.json")) as {
      request: { event: unknown; partKey: string | null };
      outcome: { webhook: VerifyWebhookRequest };
    };
    const { webhook } = fixture.outcome;
    const signature = await signLinqWebhook(SECRET, webhook.webhookId, webhook.timestamp, webhook.raw);
    const result = eventOf(await verifier.verifyWebhook({ ...webhook, signature }));
    expect(result.event).toEqual(fixture.request.event);
    expect(result.partKey).toBe(fixture.request.partKey);
    // K-06's own fixture is the same event, byte for byte.
    expect(result.event).toEqual(readJson(path.join(K06_FIXTURES, "test-phone-page.json")));
  });
});

describe("rejections", () => {
  it("rejects a header with no v1 entry, a bare hex signature and an empty one as badSignature", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    for (const signature of ["", "deadbeef", request.signature.slice(3)]) {
      expect(await verifier.verifyWebhook({ ...request, signature })).toEqual({
        result: "rejected",
        httpStatus: 401,
        reason: "badSignature",
      });
    }
  });

  it("rejects a changed body, a changed id and a wrong secret", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    for (const changed of [
      { ...request, raw: `${request.raw} ` },
      { ...request, webhookId: "evt-other" },
    ]) {
      expect((await verifier.verifyWebhook(changed)).result).toBe("rejected");
    }
    const other = createLinqWebhookVerifier({ secret: () => `whsec_${btoa("another-test-bytes-0002")}` });
    expect(await other.verifyWebhook(request)).toMatchObject({ result: "rejected", reason: "badSignature" });
  });

  it("rejects a secret that is not whsec_ and base64 as badSignature, never a throw", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    const broken = createLinqWebhookVerifier({ secret: () => "not-a-linq-secret" });
    expect(await broken.verifyWebhook(request)).toMatchObject({ result: "rejected", reason: "badSignature" });
  });

  it("rejects a timestamp that is not whole seconds as badTimestamp", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    for (const timestamp of ["", "abc", "1791822001.5", "-5"]) {
      expect(await verifier.verifyWebhook({ ...request, timestamp })).toEqual({
        result: "rejected",
        httpStatus: 401,
        reason: "badTimestamp",
      });
    }
  });

  it("holds the 300 s window: 300 s old passes, 301 s old is stale, also from the future", async () => {
    const raw = loadRecordedSampleText(SAMPLES, "webhook-message-received.json");
    const at = Date.parse("2026-10-12T16:20:01Z");
    const run = async (offsetSeconds: number) => {
      const timestamp = String(at / 1000 + offsetSeconds);
      const signature = await signLinqWebhook(SECRET, "evt-alex-0001", timestamp, raw);
      return verifier.verifyWebhook({
        webhookId: "evt-alex-0001",
        timestamp,
        signature,
        raw,
        receivedAt: "2026-10-12T16:20:01Z",
        traceId: "trace-test-0001",
      });
    };
    expect((await run(-300)).result).toBe("event");
    expect(await run(-301)).toMatchObject({ result: "rejected", reason: "staleTimestamp" });
    expect(await run(301)).toMatchObject({ result: "rejected", reason: "staleTimestamp" });
  });

  it("accepts the right entry among several space-separated ones (key rotation)", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    const signature = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${request.signature}`;
    expect((await verifier.verifyWebhook({ ...request, signature })).result).toBe("event");
  });

  it("uses its own clock only when receivedAt is not a time", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    const now = Date.parse("2026-10-12T16:20:01Z");
    const clocked = createLinqWebhookVerifier({ secret: () => SECRET, now: () => now });
    expect((await clocked.verifyWebhook({ ...request, receivedAt: "not a time" })).result).toBe("event");
    const late = createLinqWebhookVerifier({ secret: () => SECRET, now: () => now + 400_000 });
    expect(await late.verifyWebhook({ ...request, receivedAt: "not a time" })).toMatchObject({
      reason: "staleTimestamp",
    });
  });

  it("does not parse a body whose signature is bad (no event, whatever it says)", async () => {
    const request = await sampleRequest("webhook-message-received.json");
    const result = await verifier.verifyWebhook({ ...request, signature: "v1,AAAA" });
    expect(result).not.toHaveProperty("event");
  });
});

describe("every recorded vendor sample", () => {
  const headers = loadRecordedSample(SAMPLES, "webhook-headers.json") as Record<string, string>;

  it("names the three headers the gateway reads", () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"])
      expect(headers).toHaveProperty(name);
  });

  const samples = readdirSync(SAMPLES).filter((name) => /^webhook-(?!headers).*\.json$/.test(name));

  it("is covered: the folder holds exactly the samples this file expects", () => {
    expect(samples).toEqual([
      "webhook-message-delivered.json",
      "webhook-message-edited.json",
      "webhook-message-failed.json",
      "webhook-message-received-photo.json",
      "webhook-message-received.json",
      "webhook-message-sent.json",
      "webhook-poll-failed.json",
      "webhook-poll-updated.json",
      "webhook-poll-vote-added.json",
      "webhook-poll-vote-removed.json",
      "webhook-reaction-added.json",
    ]);
  });

  // sample, K-06 fixture it maps to, then what the adapter must give.
  const table: [string, string, Record<string, unknown>, string | null][] = [
    [
      "webhook-message-received.json",
      "text-imessage.json",
      {
        eventId: "evt-alex-0001",
        kind: "text",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        messageId: "linq-msg-demo-in-alex-0001",
        chatId: "linq-chat-demo-alex",
        sentAt: "2026-10-12T16:20:00Z",
        body: "Haircut at Lee's Barbershop this Saturday?",
        fromRosie: false,
      },
      null,
    ],
    [
      "webhook-message-received-photo.json",
      "photo.json",
      {
        eventId: "evt-sam-photo-0001",
        kind: "photo",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550100" },
        messageId: "linq-msg-demo-in-sam-0001",
        body: "Here's my price list",
        attachments: [{ attachmentId: "linq-att-demo-0001", mediaType: "image/jpeg" }],
      },
      null,
    ],
    [
      "webhook-message-delivered.json",
      "delivered.json",
      {
        eventId: "evt-linq-delivered-0001",
        kind: "delivered",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        status: { messageId: "linq-msg-demo-0001", at: "2026-10-23T14:05:04Z", failure: null },
        sentAt: null,
        body: null,
      },
      "out-a7-03-alex/1/1",
    ],
    [
      "webhook-message-sent.json",
      "sent.json",
      {
        eventId: "evt-linq-sent-0001",
        kind: "sent",
        service: "sms",
        handle: { kind: "phone", address: "+15555550105" },
        status: { messageId: "linq-msg-demo-0040", at: "2026-10-21T12:30:06Z", failure: null },
      },
      "out-tomas-booked/1/1",
    ],
    [
      "webhook-message-failed.json",
      "poll-failed.json",
      {
        eventId: "evt-linq-failed-0001",
        kind: "failed",
        service: null,
        handle: { kind: "phone", address: "+15555550100" },
        status: {
          messageId: "linq-msg-demo-0050",
          at: "2026-11-07T15:06:36Z",
          failure: { code: "4006", reason: "Message send timed out" },
        },
      },
      null,
    ],
    [
      "webhook-message-edited.json",
      "edit-after-commit.json",
      {
        eventId: "evt-alex-0015",
        kind: "edit",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        sentAt: "2026-10-23T14:07:30Z",
        body: "Actually 3:30 works better",
        edit: { messageId: "linq-msg-demo-in-alex-0014" },
      },
      null,
    ],
    [
      "webhook-reaction-added.json",
      "reaction-from-rosie.json",
      {
        eventId: "evt-alex-0013",
        kind: "reaction",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        sentAt: "2026-10-23T14:08:04Z",
        reaction: { reaction: "like", onMessageId: "linq-msg-demo-in-alex-0012" },
        fromRosie: true,
      },
      null,
    ],
    [
      "webhook-poll-vote-added.json",
      "poll-vote.json",
      {
        eventId: "evt-alex-0010",
        kind: "pollVote",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        poll: { pollId: "linq-msg-demo-0002", optionId: "linq-opt-demo-2", optionWords: "" },
      },
      null,
    ],
    [
      "webhook-poll-vote-removed.json",
      "poll-vote-removed.json",
      {
        eventId: "evt-alex-0011",
        kind: "voteRemoved",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        poll: { pollId: "linq-msg-demo-0002", optionId: "linq-opt-demo-2", optionWords: "" },
      },
      null,
    ],
    [
      "webhook-poll-failed.json",
      "poll-failed.json",
      {
        eventId: "evt-linq-poll-failed-0001",
        kind: "failed",
        service: "imessage",
        handle: { kind: "phone", address: "+15555550101" },
        status: {
          messageId: "linq-msg-demo-0002",
          at: "2026-10-23T14:05:06Z",
          failure: { code: "4001", reason: "poll failed" },
        },
      },
      null,
    ],
  ];

  it.each(table)(
    "%s parses to a K-06 event shaped like %s",
    async (sample, fixtureName, expected, partKey) => {
      const result = eventOf(await verifier.verifyWebhook(await sampleRequest(sample)));
      expect(result.event).toMatchObject({ provider: "linq", ...expected });
      expect(typeof result.event.receivedAt).toBe("string");
      expect(result.event.traceId).toBe("trace-test-0001");
      expect(result.partKey).toBe(partKey);
      sameShape(
        result.event as unknown as Record<string, unknown>,
        readJson(path.join(K06_FIXTURES, fixtureName)),
      );
    },
  );

  it("poll.updated is a signed type K-06 v1 has no kind for: ignored, answered 200", async () => {
    expect(await verifier.verifyWebhook(await sampleRequest("webhook-poll-updated.json"))).toEqual({
      result: "ignored",
      httpStatus: 200,
      eventType: "poll.updated",
    });
  });

  it("each sample's expectation is in the table or is poll.updated", () => {
    expect(table.map(([name]) => name).sort()).toEqual(
      samples.filter((name) => name !== "webhook-poll-updated.json"),
    );
  });

  it("gives only a part key to sent and delivered receipts", async () => {
    for (const [sample, , , partKey] of table) {
      const result = eventOf(await verifier.verifyWebhook(await sampleRequest(sample)));
      const kind = result.event.kind;
      expect(result.partKey !== null).toBe(kind === "sent" || kind === "delivered");
      expect(result.partKey).toBe(partKey);
    }
  });
});

describe("what must never start a turn as the person's words (T-244's security note)", () => {
  async function receivedWith(change: (body: Doc) => void) {
    const body = doc(loadRecordedSampleText(SAMPLES, "webhook-message-received.json"));
    change(body);
    return verifier.verifyWebhook(await signed(body.text(), "evt-echo-0001", "2026-10-12T16:20:01Z"));
  }

  it("Rosie's own words echoed back (is_me) are ignored, never an event, not even with fromRosie true", async () => {
    const result = await receivedWith((body) => {
      body.set("data.sender_handle.is_me", true);
    });
    expect(result).toEqual({ result: "ignored", httpStatus: 200, eventType: "message.received" });
  });

  it("an outbound-direction message.received is ignored too", async () => {
    const result = await receivedWith((body) => {
      body.set("data.direction", "outbound");
    });
    expect(result).toMatchObject({ result: "ignored" });
  });

  it("a Rosie edit and a Rosie vote are ignored; Rosie's own reaction stays an event with fromRosie true", async () => {
    for (const [name, type] of [
      ["webhook-message-edited.json", "message.edited"],
      ["webhook-poll-vote-added.json", "poll.vote.added"],
      ["webhook-poll-vote-removed.json", "poll.vote.removed"],
    ] as const) {
      const body = doc(loadRecordedSampleText(SAMPLES, name));
      body.set("data.sender_handle.is_me", true);
      const result = await verifier.verifyWebhook(
        await signed(body.text(), "evt-echo-0002", body.get("created_at") as string),
      );
      expect(result).toEqual({ result: "ignored", httpStatus: 200, eventType: type });
    }
    const reaction = eventOf(
      await verifier.verifyWebhook(await sampleRequest("webhook-reaction-added.json")),
    );
    expect(reaction.event.fromRosie).toBe(true);
    expect(reaction.event.kind).toBe("reaction");
  });

  it("no kind but a reaction ever carries fromRosie true", async () => {
    for (const name of readdirSync(SAMPLES).filter((n) => /^webhook-(?!headers).*\.json$/.test(n))) {
      const result = await verifier.verifyWebhook(await sampleRequest(name));
      if (result.result === "event") expect(result.event.fromRosie).toBe(result.event.kind === "reaction");
    }
  });
});

describe("types and edges", () => {
  async function withBody(change: (body: Doc) => void, name = "webhook-message-received.json") {
    const body = doc(loadRecordedSampleText(SAMPLES, name));
    change(body);
    return verifier.verifyWebhook(await signed(body.text(), "evt-edge-0001", "2026-10-12T16:20:01Z"));
  }

  it.each(["message.read", "chat.typing_indicator.started", "reaction.removed", "poll.updated"])(
    "a signed %s is ignored with its type named",
    async (type) => {
      expect(
        await withBody((body) => {
          body.set("event_type", type);
        }),
      ).toEqual({ result: "ignored", httpStatus: 200, eventType: type });
    },
  );

  it("a signed body that is not JSON, or has no event type, is ignored as unknown", async () => {
    const raw = "not json";
    expect(await verifier.verifyWebhook(await signed(raw, "evt-x", "2026-10-12T16:20:01Z"))).toEqual({
      result: "ignored",
      httpStatus: 200,
      eventType: "unknown",
    });
    expect(await verifier.verifyWebhook(await signed("[1]", "evt-x", "2026-10-12T16:20:01Z"))).toMatchObject({
      result: "ignored",
    });
    expect(
      await withBody((body) => {
        body.set("event_type", undefined);
      }),
    ).toMatchObject({ result: "ignored", eventType: "unknown" });
  });

  it("an event type Rosie uses in another webhook version fails closed with a label", async () => {
    await expect(
      withBody((body) => {
        body.set("webhook_version", "2025-01-01");
      }),
    ).rejects.toMatchObject({ name: "LinqWebhookError", code: "unsupportedWebhookVersion" });
  });

  it("a malformed used event fails closed, naming a label and never a value", async () => {
    const attempt = withBody((body) => {
      body.set("data.sender_handle.handle", "+15555550101 and a secret word");
    });
    await expect(attempt).rejects.toBeInstanceOf(LinqWebhookError);
    await expect(attempt).rejects.toMatchObject({ message: "badEvent" });
    await expect(
      withBody((body) => {
        body.set("data.chat", undefined);
      }),
    ).rejects.toMatchObject({ code: "badEvent" });
    await expect(
      withBody((body) => {
        body.set("data.service", "carrier-pigeon");
      }),
    ).rejects.toMatchObject({ code: "unknownService" });
  });

  it("a receipt or Rosie's reaction with no known person for its chat fails closed (the gateway answers 503)", async () => {
    const none = createLinqWebhookVerifier({ secret: () => SECRET });
    const unknown = createLinqWebhookVerifier({ secret: () => SECRET, chatHandle: () => null });
    const broken = createLinqWebhookVerifier({
      secret: () => SECRET,
      chatHandle: () => {
        throw new Error("store down");
      },
    });
    for (const name of [
      "webhook-message-delivered.json",
      "webhook-reaction-added.json",
      "webhook-poll-failed.json",
    ]) {
      for (const port of [none, unknown, broken])
        await expect(port.verifyWebhook(await sampleRequest(name))).rejects.toMatchObject({
          code: "receiptHandleUnknown",
        });
    }
  });

  it("takes a vote's option words from the caller's lookup when it has them, else gives an empty string", async () => {
    const withWords = createLinqWebhookVerifier({
      secret: () => SECRET,
      optionWords: (pollId, optionId) =>
        pollId === "linq-msg-demo-0002" && optionId === "linq-opt-demo-2" ? "Sat 2:00pm" : null,
    });
    const got = eventOf(await withWords.verifyWebhook(await sampleRequest("webhook-poll-vote-added.json")));
    expect(got.event.poll).toEqual({
      pollId: "linq-msg-demo-0002",
      optionId: "linq-opt-demo-2",
      optionWords: "Sat 2:00pm",
    });
    // Linq's own fixture words: the K-06 fixture poll-vote.json holds the same words.
    expect(
      (readJson(path.join(K06_FIXTURES, "poll-vote.json")) as { poll: { optionWords: string } }).poll
        .optionWords,
    ).toBe("Sat 2:00pm");
  });

  it("a threaded reply, a link part and a non-image file read as K-06 says", async () => {
    const reply = eventOf(
      await withBody((body) => {
        body.set("data.reply_to", { message_id: "linq-msg-demo-0001", part_index: 0 });
      }),
    );
    expect(reply.event.threadedReplyTo).toBe("linq-msg-demo-0001");
    const card = eventOf(
      await withBody((body) => {
        body.set("data.parts", [
          { type: "text", value: "My card" },
          { type: "media", id: "linq-att-demo-0002", mime_type: "text/vcard" },
        ]);
      }),
    );
    expect(card.event).toMatchObject({
      kind: "text",
      body: "My card",
      attachments: [{ attachmentId: "linq-att-demo-0002", mediaType: "text/vcard" }],
    });
    const photoOnly = eventOf(
      await withBody((body) => {
        body.set("data.parts", [{ type: "media", id: "linq-att-demo-0003", mime_type: "image/png" }]);
      }),
    );
    expect(photoOnly.event).toMatchObject({ kind: "photo", body: "" });
  });

  it("a time with another offset is written in UTC", async () => {
    const got = eventOf(
      await withBody((body) => {
        body.set("data.sent_at", "2026-10-12T12:20:00-04:00");
      }),
    );
    expect(got.event.sentAt).toBe("2026-10-12T16:20:00Z");
  });

  it("parseLinqWebhook reads a body without any signature (the caller has verified it)", async () => {
    const body = JSON.parse(loadRecordedSampleText(SAMPLES, "webhook-message-received.json")) as unknown;
    const parsed = await parseLinqWebhook({ body, receivedAt: "2026-10-12T16:20:01Z", traceId: "t-1" });
    expect(parsed).toMatchObject({ result: "event", partKey: null });
  });
});
