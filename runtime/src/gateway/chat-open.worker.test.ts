// The gateway opens a number's chat at receipt (T-1213; C-044; K-05 v1.7 README item 46, defaults 70, 71, 76 and 77;
// QUESTIONS.md CQ-194, CQ-196), inside the Workers runtime. First the gateway alone, its doors doubles: the Linq port
// answering one K-06 event, a key store that answers each handle's K-04 id beside its key, the chat-open port as a double
// that answers what each test says, and an actor that stores an event once. Then the gateway the composition root builds
// for the test environment (runtime/src/wiring), its chat-open port fed the K-05 v1.7 double that follows db/repo's
// openChatOnText (runtime/src/wiring/test-support.ts fakeDispatchData), so the phone row and its entry can be read back.
//
//   - A text or photo a phone handle sends through Linq: one call, after the key call and before the actor's door, with
//     the key call's handle id and, from the K-06 event, its id, service, receivedAt and trace; never the number.
//   - No call for an email handle, a reaction, a vote, a vote taken back, an edit, a receipt or Rosie's own text.
//   - A repeated webhook: K-05 answers repeated, the actor's door drops the known event id, nothing is written twice.
//   - transient, or no answer (a throw, a closed port, an answer the gateway does not know): 503, nothing stored.
//   - notFound and notAPhone, and a call the gateway cannot make as K-05 takes it: the text is stored all the same, the
//     refusal its receive span's error code.
//   - A stopped number's phone row is unchanged, in every field, and the text still reaches its actor.
//   - No span or log line holds the number or the chat id.
//
// Test values only (rule 9): the master's sample cast, the fictional 555-01xx numbers and the fixtures' own words.
import deliveredFixture from "../../../contracts/inbound-event/fixtures/delivered.json";
import editAfterCommit from "../../../contracts/inbound-event/fixtures/edit-after-commit.json";
import emailReply from "../../../contracts/inbound-event/fixtures/email-reply-check-passed.json";
import photoFixture from "../../../contracts/inbound-event/fixtures/photo.json";
import pollFailed from "../../../contracts/inbound-event/fixtures/poll-failed.json";
import pollVoteRemoved from "../../../contracts/inbound-event/fixtures/poll-vote-removed.json";
import pollVote from "../../../contracts/inbound-event/fixtures/poll-vote.json";
import reactionFromCustomer from "../../../contracts/inbound-event/fixtures/reaction-from-customer.json";
import reactionFromRosie from "../../../contracts/inbound-event/fixtures/reaction-from-rosie.json";
import sentFixture from "../../../contracts/inbound-event/fixtures/sent.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotJoinedError } from "../wiring/closed";
import { composeRoot, type HandleActors } from "../wiring/root";
import { SKELETON_FLAG } from "../wiring/skeleton";
import {
  fakeDispatchData,
  fakeFlags,
  SAM_CHAT,
  samPhoneRow,
  skeletonFakes,
  TEST_OWNER_1,
  type HandleTable,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "../wiring/test-support";
import { CHAT_REQUEST_REFUSED, NO_HANDLE_ID } from "./chat-open";
import { handleLinqWebhook } from "./linq-webhook";
import {
  fakeChatOpener,
  fakeHandleKeyStore,
  fakeKeyStore,
  type FakeChatOpener,
  type FakeHandleKeyStore,
} from "./test-support";
import type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  InboundEvent,
  LinqPort,
  ReceiptSink,
  SealedHandoff,
  StoreAnswer,
} from "./types";

type Json = Record<string, unknown>;

const WHERE = { environment: "staging", version: "test-sha" };
const NOW = Date.parse("2026-10-12T16:20:01Z");

/** Alex's number (K-06 text-imessage.json) and Sam's, in each form a number could leak in, and their chat ids. */
const NUMBERS = ["0100", "0101"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);
const CHAT_IDS = [textImessage.chatId, SAM_CHAT];

afterEach(() => {
  vi.restoreAllMocks();
});

/** The log lines written so far, as text. */
function captureLogLines(): () => string[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

/** The gateway's own receive spans, parsed from the log lines (never the actor's). */
function receiveSpans(lines: readonly string[]): Json[] {
  return lines
    .map((line) => JSON.parse(line) as Json)
    .filter((line) => line.msg === "span" && line.hop === "receive");
}

function webhook(): Request {
  return new Request("https://rosie.test/test/webhooks/linq", {
    method: "POST",
    headers: { "webhook-id": "w", "webhook-timestamp": "1", "webhook-signature": "s" },
    body: "{}",
  });
}

/** A Linq port that verifies every webhook as `event`, under the trace the gateway opened (as the adapter's parse does). */
function verifying(event: Json, partKey: string | null = null): LinqPort {
  return {
    verifyWebhook: (request) =>
      Promise.resolve({
        result: "event",
        httpStatus: 200,
        event: { ...event, traceId: request.traceId } as InboundEvent,
        partKey,
      }),
  };
}

interface Doors {
  /** One order log for the key call, the chat call and the actor's door. */
  readonly steps: string[];
  readonly keys: FakeHandleKeyStore;
  readonly chats: FakeChatOpener;
  readonly actor: ActorStub & { calls: SealedHandoff[]; written: SealedHandoff[] };
  readonly receipts: ReceiptSink & { written: ActorHandoff[] };
}

/** The doors: an actor that stores an event once (a known event id is a duplicate), noting each call in the order log. */
function doors(): Doors {
  const steps: string[] = [];
  const calls: SealedHandoff[] = [];
  const written: SealedHandoff[] = [];
  const seen = new Set<string>();
  const receiptsWritten: ActorHandoff[] = [];
  return {
    steps,
    keys: fakeHandleKeyStore(steps),
    chats: fakeChatOpener(steps),
    actor: {
      calls,
      written,
      accept(handoff): Promise<StoreAnswer> {
        calls.push(handoff);
        steps.push(`accept:${handoff.event.eventId}`);
        if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
        seen.add(handoff.event.eventId);
        written.push(handoff);
        return Promise.resolve("written");
      },
    },
    receipts: {
      written: receiptsWritten,
      accept(handoff) {
        receiptsWritten.push(handoff);
        return Promise.resolve("written");
      },
    },
  };
}

function depsOf(linq: LinqPort, d: Doors, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    linq,
    actor: d.actor,
    receipts: d.receipts,
    keys: d.keys,
    chats: d.chats,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => NOW,
    ...overrides,
  };
}

/** Posts one webhook verified as `event`; answers the status and the trace id the gateway opened. */
async function post(
  event: Json,
  d: Doors,
  overrides: Partial<GatewayDeps> = {},
): Promise<{ status: number; traceId: string }> {
  const response = await handleLinqWebhook(webhook(), depsOf(verifying(event), d, overrides), WHERE);
  return { status: response.status, traceId: String(response.headers.get("x-trace-id")) };
}

describe("the gateway alone: a number's text opens its chat at receipt", () => {
  it("a text from a phone handle: one call, after the key call and before the actor's door, with the key call's handle id and the event's own id, service, receivedAt and trace; never the number", async () => {
    const lines = captureLogLines();
    const d = doors();

    const { status, traceId } = await post(textImessage, d);

    expect(status).toBe(200);
    const handleId = d.keys.idOf(textImessage.handle);
    expect(d.steps).toEqual([
      `key:${handleId}`,
      `chat:${textImessage.eventId}`,
      `accept:${textImessage.eventId}`,
    ]);
    expect(d.chats.requests).toEqual([
      {
        eventId: textImessage.eventId,
        handleId,
        service: textImessage.service,
        receivedAt: textImessage.receivedAt,
        traceId,
      },
    ]);
    const sent = JSON.stringify(d.chats.requests);
    for (const secret of [...NUMBERS, ...CHAT_IDS]) expect(sent).not.toContain(secret);
    expect(d.actor.written).toHaveLength(1);
    expect(receiveSpans(lines())).toMatchObject([
      {
        outcome: "ok",
        error_code: null,
        decided: { signatureValid: true, knownEventId: false, answered: 200 },
      },
    ]);
  });

  it("a photo from a phone handle opens its chat too, before its actor is reached", async () => {
    captureLogLines();
    const d = doors();

    const { status } = await post(photoFixture, d);

    expect(status).toBe(200);
    expect(d.chats.requests.map((request) => [request.eventId, request.service])).toEqual([
      [photoFixture.eventId, photoFixture.service],
    ]);
    expect(d.steps.slice(-2)).toEqual([`chat:${photoFixture.eventId}`, `accept:${photoFixture.eventId}`]);
  });

  it.each<[string, Json]>([
    ["an email (Resend's reply)", emailReply],
    [
      "an Apple ID email that texts by iMessage",
      {
        ...textImessage,
        eventId: "evt-sam-email-0001",
        handle: { kind: "email", address: "sam@example.com" },
      },
    ],
    ["a reaction", reactionFromCustomer],
    ["Rosie's own reaction", reactionFromRosie],
    ["a vote", pollVote],
    ["a vote taken back", pollVoteRemoved],
    ["an edit", editAfterCommit],
    ["a delivery receipt", deliveredFixture],
    ["a sent receipt", sentFixture],
    ["a failed poll's receipt", pollFailed],
    ["a text marked as Rosie's own", { ...textImessage, eventId: "evt-alex-rosie-0001", fromRosie: true }],
  ])("no call for %s: it goes on to its door as before", async (_name, event) => {
    const lines = captureLogLines();
    const d = doors();

    const { status } = await post(event, d);

    expect(status).toBe(200);
    expect(d.chats.requests).toEqual([]);
    expect(d.actor.written.length + d.receipts.written.length).toBe(1);
    expect(receiveSpans(lines())).toMatchObject([{ outcome: "ok", error_code: null }]);
  });

  it("a repeated webhook: each goes to K-05, whose answer is repeated, and the actor's door drops the known event id: 200 both times, stored once", async () => {
    const lines = captureLogLines();
    const d = doors();
    d.chats.next.push({ result: "inserted" }, { result: "repeated" });

    const first = await post(textImessage, d);
    const again = await post(textImessage, d);

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(d.chats.requests.map((request) => request.eventId)).toEqual([
      textImessage.eventId,
      textImessage.eventId,
    ]);
    expect(d.actor.written).toHaveLength(1);
    expect(receiveSpans(lines()).map((span) => [span.outcome, span.error_code])).toEqual([
      ["ok", null],
      ["dropped", null],
    ]);
  });

  it("transient: 503 and nothing stored, the receive span failed (chatOpenTransient); Linq's retry, a repeat to K-05, is stored once", async () => {
    const lines = captureLogLines();
    const d = doors();
    d.chats.next.push({ error: "transient" });

    const first = await post(textImessage, d);

    expect(first.status).toBe(503);
    expect(d.actor.calls).toEqual([]);
    expect(receiveSpans(lines())).toMatchObject([
      {
        outcome: "failed",
        error_code: "chatOpenTransient",
        decided: { signatureValid: true, answered: 503 },
      },
    ]);

    const retry = await post(textImessage, d);

    expect(retry.status).toBe(200);
    expect(d.actor.written).toHaveLength(1);
    expect(d.chats.requests).toHaveLength(2);
  });

  it.each<[string, unknown]>([
    [
      "a database error K-05 names no answer for (db/repo throws it with its SQLSTATE, table and constraint)",
      Object.assign(new Error("openChatOnText: the database refused the call (SQLSTATE 23505)"), {
        name: "OpenChatOnTextDatabaseError",
      }),
    ],
    ["a port closed in this environment", new NotJoinedError("chatOpen")],
    ["an answer the gateway does not know", { result: "queued" }],
  ])(
    "no answer, %s: 503, nothing stored, the receive span failed (chatOpenFailed)",
    async (_name, answer) => {
      const lines = captureLogLines();
      const d = doors();
      d.chats.next.push(answer);

      const { status } = await post(textImessage, d);

      expect(status).toBe(503);
      expect(d.actor.calls).toEqual([]);
      expect(receiveSpans(lines())).toMatchObject([{ outcome: "failed", error_code: "chatOpenFailed" }]);
      expect(lines().map((line) => JSON.parse(line) as Json)).toContainEqual(
        expect.objectContaining({ msg: "gateway_failed", stage: "chat" }),
      );
    },
  );

  it.each(["notFound", "notAPhone"] as const)(
    "%s: the text is stored all the same (a refusal never keeps it from its safety read), the refusal its receive span's error code",
    async (refusal) => {
      const lines = captureLogLines();
      const d = doors();
      d.chats.next.push({ error: refusal });

      const { status } = await post(textImessage, d);

      expect(status).toBe(200);
      expect(d.actor.written).toHaveLength(1);
      expect(d.steps.slice(-2)).toEqual([`chat:${textImessage.eventId}`, `accept:${textImessage.eventId}`]);
      expect(receiveSpans(lines())).toMatchObject([
        { outcome: "ok", error_code: refusal, decided: { answered: 200 } },
      ]);
    },
  );

  it.each<[string, Json]>([
    ["an event id that reads as a number", { ...textImessage, eventId: "5551234567" }],
    ["an event id with a space", { ...textImessage, eventId: "evt alex 0001" }],
    ["a service Linq does not name", { ...textImessage, service: "fax" }],
    ["no receipt time", { ...textImessage, receivedAt: null }],
  ])(
    "a request K-05 would refuse before reading anything (%s) is never sent: the text is stored, chatRequestRefused",
    async (_name, event) => {
      const lines = captureLogLines();
      const d = doors();

      const { status } = await post(event, d);

      expect(status).toBe(200);
      expect(d.chats.requests).toEqual([]);
      expect(d.actor.written).toHaveLength(1);
      expect(receiveSpans(lines())).toMatchObject([{ outcome: "ok", error_code: CHAT_REQUEST_REFUSED }]);
    },
  );

  it("a key store that gives no handle id: no call, and the text is stored, noHandleId", async () => {
    const lines = captureLogLines();
    const d = doors();

    const { status } = await post(textImessage, d, { keys: fakeKeyStore() });

    expect(status).toBe(200);
    expect(d.chats.requests).toEqual([]);
    expect(d.actor.written).toHaveLength(1);
    expect(receiveSpans(lines())).toMatchObject([{ outcome: "ok", error_code: NO_HANDLE_ID }]);
  });

  it("no chat port (a gateway built by hand, as before T-1213): no call, and the text is stored as before", async () => {
    const lines = captureLogLines();
    const d = doors();
    const deps = depsOf(verifying(textImessage), d);
    delete deps.chats;

    const { status } = await handleLinqWebhook(webhook(), deps, WHERE);

    expect(status).toBe(200);
    expect(d.chats.requests).toEqual([]);
    expect(d.actor.written).toHaveLength(1);
    expect(receiveSpans(lines())).toMatchObject([{ outcome: "ok", error_code: null }]);
  });

  it("no span or log line holds the number or the chat id, whatever the answer, a throw whose message holds both included", async () => {
    const lines = captureLogLines();
    const d = doors();
    d.chats.next.push(
      { result: "inserted" },
      { error: "notAPhone" },
      { error: "transient" },
      new Error(`refused for ${textImessage.handle.address} on ${textImessage.chatId}`),
    );

    for (const eventId of ["evt-alex-0001", "evt-alex-0002", "evt-alex-0003", "evt-alex-0004"]) {
      await post({ ...textImessage, eventId }, d);
    }

    expect(d.chats.requests).toHaveLength(4);
    const text = lines().join("\n");
    expect(text).toContain("gateway_failed");
    for (const secret of [...NUMBERS, ...CHAT_IDS]) expect(text).not.toContain(secret);
  });
});

// ---- through the composition root's gateway, the K-05 v1.7 double behind its chat-open port -----------------------

interface RecordingActors extends HandleActors<string> {
  /** Every hand-off an actor was given, in order. */
  readonly accepted: SealedHandoff[];
  /** The hand-offs stored: a known event id is a duplicate, as T-244's actor answers. */
  readonly written: SealedHandoff[];
}

/** A HandleActors namespace whose actors store an event once, noting each call in the order log. */
function recordingActors(steps: string[]): RecordingActors {
  const accepted: SealedHandoff[] = [];
  const written: SealedHandoff[] = [];
  const seen = new Set<string>();
  return {
    accepted,
    written,
    idFromName: (name) => name,
    get: () => ({
      accept(handoff): Promise<StoreAnswer> {
        accepted.push(handoff);
        steps.push(`accept:${handoff.event.eventId}`);
        if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
        seen.add(handoff.event.eventId);
        written.push(handoff);
        return Promise.resolve("written");
      },
      fireClockRow: () => Promise.reject(new Error("no clock row fires here")),
      syncClocks: () => Promise.reject(new Error("no clock row arms here")),
    }),
  };
}

interface RootRig {
  readonly fakes: SkeletonFakes;
  readonly actors: RecordingActors;
  readonly steps: string[];
  post(event: LinqInboundEvent): Promise<number>;
  lines(): string[];
}

/**
 * The root for "test" with the skeleton flag on, its sealing port fed the K-05 key double and its chat-open port fed the
 * K-05 v1.7 double over the key double's handles (`handles` in place of them for a test of K-05's refusals); the actors
 * record each hand-off. Nothing past the actor's door runs.
 */
function rootRig(handles?: HandleTable): RootRig {
  const lines = captureLogLines();
  const fakes = skeletonFakes();
  const steps: string[] = [];
  const actors = recordingActors(steps);
  const double =
    handles === undefined
      ? fakes.dispatch
      : fakeDispatchData(fakes.turnRows, fakes.finalize.plans, () => fakes.clock.now(), handles);
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: async (request) => {
      const answer = await double.openChat(request);
      steps.push(`chat:${request.eventId}`);
      return answer;
    },
    flags: fakeFlags([SKELETON_FLAG]),
  });
  const requestOf = (signed: SignedWebhook): Request =>
    new Request("https://rosie.test/test/webhooks/linq", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": signed.webhookId,
        "webhook-timestamp": signed.timestamp,
        "webhook-signature": signed.signature,
      },
      body: signed.raw,
    });
  return {
    fakes: handles === undefined ? fakes : { ...fakes, dispatch: double },
    actors,
    steps,
    async post(event) {
      return (await root.linqWebhook(requestOf(await fakes.sign(event)))).status;
    },
    lines,
  };
}

/** A text of Sam's (test owner 1, the seeded handle-sam at the fictional 555-0100), on his chat. */
function samText(eventId: string): LinqInboundEvent {
  return {
    ...(structuredClone(textImessage) as Json),
    eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: "JOIN",
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

describe("through the composition root's gateway: K-05 v1.7 openChatOnText at receipt, over its double", () => {
  it("Sam's first text inserts his phone row once, before the actor's door, and the same webhook again answers repeated and writes nothing twice", async () => {
    const run = rootRig();
    const text = samText("evt-sam-0001");

    const statuses = [await run.post(text), await run.post(text)];

    expect(statuses).toEqual([200, 200]);
    const { dispatch } = run.fakes;
    expect(dispatch.chatOpens.map((call) => call.request.handleId)).toEqual([
      TEST_OWNER_1.handleId,
      TEST_OWNER_1.handleId,
    ]);
    expect(dispatch.chatOpens.map((call) => (call.answer as { result?: string }).result)).toEqual([
      "inserted",
      "repeated",
    ]);
    expect(run.steps).toEqual([
      "chat:evt-sam-0001",
      "accept:evt-sam-0001",
      "chat:evt-sam-0001",
      "accept:evt-sam-0001",
    ]);
    // One phone row (version 1, chat open by iMessage, not stopped) and one entry; the text stored once.
    expect(dispatch.phones.get(TEST_OWNER_1.handleId)).toMatchObject({
      number: TEST_OWNER_1.handle.address,
      chatOpen: true,
      chatWay: "imessage",
      stopped: false,
      version: 1,
    });
    expect(dispatch.chatEntries.map((entry) => [entry.id, entry.job_id, entry.turn_id])).toEqual([
      ["evt-sam-0001/chat-opened", "evt-sam-0001", null],
    ]);
    expect(run.actors.written.map((handoff) => handoff.event.eventId)).toEqual(["evt-sam-0001"]);
    for (const secret of [...NUMBERS, ...CHAT_IDS]) {
      expect(JSON.stringify(dispatch.chatEntries)).not.toContain(secret);
      expect(run.lines().join("\n")).not.toContain(secret);
    }
  });

  it("a stopped number's row is unchanged, every field and its version, and no entry is written; the text still reaches its actor", async () => {
    const run = rootRig();
    const { dispatch } = run.fakes;
    const stopped = { ...samPhoneRow(), stopped: true, stopAt: "2026-10-20T13:00:00Z", chatOpen: false };
    dispatch.phones.set(TEST_OWNER_1.handleId, structuredClone(stopped));
    dispatch.chatOpenedAt.set(TEST_OWNER_1.handleId, "2026-10-19T14:00:00Z");

    const status = await run.post(samText("evt-sam-0002"));

    expect(status).toBe(200);
    expect(dispatch.chatOpens.map((call) => call.answer)).toMatchObject([
      {
        result: "stopped",
        handleId: TEST_OWNER_1.handleId,
        phone: { chatOpen: false, stopped: true, version: stopped.version },
        event: null,
      },
    ]);
    expect(dispatch.phones.get(TEST_OWNER_1.handleId)).toEqual(stopped);
    expect(dispatch.chatOpenedAt.get(TEST_OWNER_1.handleId)).toBe("2026-10-19T14:00:00Z");
    expect(dispatch.chatEntries).toEqual([]);
    expect(run.actors.written.map((handoff) => handoff.event.eventId)).toEqual(["evt-sam-0002"]);
  });

  it("K-05 transient (a lost connection): 503 and nothing stored, no phone row, no entry, no hand-off; Linq's retry inserts the row once", async () => {
    const run = rootRig();
    const { dispatch } = run.fakes;
    dispatch.failNextChatOpen = { error: "transient", sqlstate: "08006" };
    const text = samText("evt-sam-0003");

    const first = await run.post(text);

    expect(first).toBe(503);
    expect(dispatch.phones.size).toBe(0);
    expect(dispatch.chatEntries).toEqual([]);
    expect(run.actors.accepted).toEqual([]);

    const retry = await run.post(text);

    expect(retry).toBe(200);
    expect(dispatch.phones.get(TEST_OWNER_1.handleId)).toMatchObject({ chatOpen: true, version: 1 });
    expect(dispatch.chatEntries).toHaveLength(1);
    expect(run.actors.written).toHaveLength(1);
  });

  it.each<[string, HandleTable, string]>([
    ["notFound: a handle id K-04 does not hold", () => null, "notFound"],
    [
      "notAPhone: the handle is an email handle",
      () => ({ kind: "email", address: "sam@example.com" }),
      "notAPhone",
    ],
  ])(
    "K-05 %s: the text is stored all the same, nothing is written, and the refusal is the receive span's error code",
    async (_name, handles, refusal) => {
      const run = rootRig(handles);

      const status = await run.post(samText("evt-sam-0004"));

      expect(status).toBe(200);
      expect(run.fakes.dispatch.chatOpens.map((call) => call.answer)).toMatchObject([{ error: refusal }]);
      expect(run.fakes.dispatch.phones.size).toBe(0);
      expect(run.fakes.dispatch.chatEntries).toEqual([]);
      expect(run.actors.written).toHaveLength(1);
      expect(receiveSpans(run.lines())).toMatchObject([{ outcome: "ok", error_code: refusal }]);
    },
  );
});
