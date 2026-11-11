// A repeated delivery receipt and the clock arming (T-1228; C-124 with C-055; K-05 v1.9 item 48, defaults 85 to 89; STATE
// note 38), run inside the Workers runtime (Vitest project "workers").
//
// The crash: markPart's commit records A7-03's first delivery, and the isolate goes down before armClock. The gateway
// never answers Linq, so Linq sends the receipt again (arch 02 line 109). That receipt is a repeat to K-05, which from
// v1.9 says what it repeats; the dispatcher hands a repeat of the row's first delivery to the clock arming again.
//
// Joined here: the dispatcher's own receipt handler, the real clock arming (runtime/src/clocks `clockArming`, T-255) over
// its K-05 armClock double and that double's store of clock rows (clocks/arming-support.ts), and the fake outbox store
// (test-support.ts), which answers a repeat as v1.9's fixtures state. One isolate is one memory of armed parts; a crash
// ends the isolate, so the next receipt meets a new one. The real outbox port (wiring/real.ts `realOutbox`) is joined
// where the store's answer, or its throw, has to cross it.
//
// A7-03's row, question, clock row and times are the fixtures' own (mark-a7-03-delivered-repeat.json,
// mark-a7-03-poll-delivered-repeat.json, arm-clock-a7-03-after-4006.json): the master's sample cast, phones 555-01xx
// (rule 9).
import { describe, expect, it } from "vitest";

import armClockAfter4006 from "../../../contracts/data-access/fixtures/arm-clock-a7-03-after-4006.json";
import markDeliveredRepeat from "../../../contracts/data-access/fixtures/mark-a7-03-delivered-repeat.json";
import markPollDeliveredRepeat from "../../../contracts/data-access/fixtures/mark-a7-03-poll-delivered-repeat.json";
import { ArmingMemory, clockArming } from "../clocks/arming";
import {
  A7_03_CLOCK_ROW,
  A7_03_QUESTION,
  ALEX_ACTOR,
  ALEX_HANDLE,
  wireArming,
  type WiredArming,
} from "../clocks/arming-support";
import { openTrace, type Span } from "../trace";
import { realOutbox, type OutboxCalls } from "../wiring/real";
import { handleDeliveryReceipt, runDispatch, type ReceiptResult } from "./dispatcher";
import {
  FakeClock,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "./test-support";
import type { ChatTarget, ClockArming, MarkPartResponse, OutboxStore, PartDelivered } from "./types";

const ALEX: ChatTarget = { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" };
const BUNDLE = { hash: "0123456789abcdef".repeat(4), build: 1 };

const ROW = markDeliveredRepeat.outcome.outboxRowId;
const WORDS_KEY = `${ROW}/1/1`;
const POLL_KEY = `${ROW}/2/1`;
const WORDS_TEXT = "Which time works?";
/** The message ids the Linq fake gives the row's two parts, in send order. */
const WORDS_MESSAGE = "linq-msg-test-0001";
const POLL_MESSAGE = "linq-msg-test-0002";
/** When the words were delivered (the row's first delivery), and the poll two seconds later. */
const WORDS_DELIVERED_AT = markDeliveredRepeat.outcome.repeatedDelivery.deliveredAt;
const POLL_DELIVERED_AT = markPollDeliveredRepeat.outcome.repeatedDelivery.deliveredAt;
/** A time a repeat may carry that is not the delivery's (an SMS part reported twice: K-05 default 86). */
const LATER = "2026-10-23T14:09:30Z";
/** The row is sent four seconds before its first receipt, at 10:05am in New York (inside text hours). */
const SENT_AT = "2026-10-23T14:05:00.000Z";
const CRASH = "the isolate went down before armClock";

/** A7-03's two-part row (the words, then the poll), asking A7-03's question. */
const A7_03: SeedRow = {
  id: ROW,
  recipient: ALEX_HANDLE,
  commitSeq: 1,
  openQuestionId: A7_03_QUESTION,
  sends: [
    words(WORDS_TEXT),
    { kind: "poll", text: null, calendarFile: "none", options: ["Sat 12:00pm", "Sat 2:00pm"], link: null },
  ],
};

/** The words' delivery as the dispatcher hands it on: the first receipt, and each repeat of it, word for word. */
const WORDS_HANDED: PartDelivered = {
  outboxRowId: ROW,
  partNo: 1,
  tryNo: 1,
  firstDelivery: true,
  openQuestionId: A7_03_QUESTION,
  deliveredAt: WORDS_DELIVERED_AT,
};

/** One Worker isolate: its memory of armed parts, and how many of its next armings go down before armClock. */
interface Isolate {
  memory: ArmingMemory;
  crashes: number;
}

const isolate = (crashes = 0): Isolate => ({ memory: new ArmingMemory(), crashes });

interface Rig {
  store: FakeOutboxStore;
  /** The arming's doubles: K-05 armClock and cancelClock over the clock rows, the question's facts, the actors. */
  wired: WiredArming;
  /** Every span of every receipt's trace, in order. */
  spans: Span[];
  /** Every part the dispatcher handed to the arming, in order, crashed or not. */
  handed: PartDelivered[];
  /** One delivery receipt as the gateway hands it on, served by `on`. */
  receipt(messageId: string, at: string, on: Isolate): Promise<ReceiptResult>;
}

/** The receipt's own trace, as the gateway opens it. */
function receiptTrace(spans: Span[]): ReturnType<typeof openTrace> {
  return openTrace({ openedBy: "providerWebhook", bundleId: BUNDLE, sink: (span) => spans.push(span) });
}

/** The real arming for one receipt, recorded, and going down first while the isolate still has a crash to make. */
function armingOn(
  on: Isolate,
  wired: WiredArming,
  handed: PartDelivered[],
  trace: ReturnType<typeof openTrace>,
): ClockArming {
  const real = clockArming({ ...wired.options, memory: on.memory, trace });
  return {
    async partDelivered(delivered) {
      handed.push(delivered);
      if (on.crashes > 0) {
        on.crashes -= 1;
        throw new Error(CRASH);
      }
      await real.partDelivered(delivered);
    },
  };
}

/** A7-03's row sent by the real dispatcher (both parts accepted by the Linq fake), ready for its receipts. */
async function sent(): Promise<Rig> {
  const clock = new FakeClock(SENT_AT);
  const store = new FakeOutboxStore([A7_03]);
  const report = await runDispatch({
    store,
    linq: new FakeLinq(clock.now),
    recipients: new FakeRecipients({ [ALEX_HANDLE]: ALEX }),
    sendState: new FakeSendState(),
    environment: "production",
    traceFor: traceCollector([]),
    now: clock.now,
    claimer: "dispatcher-1",
  });
  expect(report.rows.map((row) => [row.outboxRowId, row.outcome, row.partsSent])).toEqual([[ROW, "sent", 2]]);

  const wired = wireArming();
  const spans: Span[] = [];
  const handed: PartDelivered[] = [];
  return {
    store,
    wired,
    spans,
    handed,
    receipt(messageId, at, on) {
      const trace = receiptTrace(spans);
      return handleDeliveryReceipt(
        { store, clockArming: armingOn(on, wired, handed, trace), trace },
        { providerMessageId: messageId, partKey: null, at },
      );
    },
  };
}

/** Each try of the row's parts as the store holds it: its key, state and stored delivery time. */
const partsOf = (t: Rig): (string | null)[][] =>
  t.store.tries(ROW).map((part) => [part.key, part.state, part.deliveredAt]);

/** The question's clock row as the arming's store holds it now. */
const clockRow = (t: Rig): ReturnType<WiredArming["data"]["rowOf"]> => t.wired.data.rowOf(A7_03_CLOCK_ROW);

/** The clock row as arm-clock-a7-03-after-4006.json's one arming leaves it. */
const ARMED_ONCE = {
  clockRowId: A7_03_CLOCK_ROW,
  state: "armed",
  version: armClockAfter4006.outcome.clock.version,
  armedAt: armClockAfter4006.outcome.clock.armedAt,
  dueAt: armClockAfter4006.outcome.clock.dueAt,
  dueZone: armClockAfter4006.outcome.clock.dueZone,
};

describe("a crash between markPart's commit and armClock does not lose the arming (STATE note 38)", () => {
  it("the arming goes down once after markPart's commit: Linq's repeated receipt then arms the clock once, from the stored time", async () => {
    const t = await sent();

    // The first receipt: the mark commits, and the isolate goes down before armClock. Nothing answers Linq.
    await expect(t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate(1))).rejects.toThrow(CRASH);
    expect(partsOf(t)).toEqual([
      [WORDS_KEY, "delivered", WORDS_DELIVERED_AT],
      [POLL_KEY, "sent", null],
    ]);
    expect(t.wired.data.armRequests).toEqual([]);
    expect(clockRow(t)).toMatchObject({ state: "waiting", version: 1, armedAt: null });
    const versionAfterTheMark = t.store.row(ROW).version;

    // Linq sends the same event again, and another isolate serves it.
    const again = await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());

    expect(again).toEqual({ result: "repeated", outboxRowId: ROW, partNo: 1 });
    // The repeat wrote nothing to the outbox.
    expect(t.store.row(ROW).version).toBe(versionAfterTheMark);
    expect(partsOf(t)).toEqual([
      [WORDS_KEY, "delivered", WORDS_DELIVERED_AT],
      [POLL_KEY, "sent", null],
    ]);
    // It was handed on as the first delivery was, and the clock armed once, as the lost arming would have armed it.
    expect(t.handed).toEqual([WORDS_HANDED, WORDS_HANDED]);
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request]);
    expect(t.wired.data.armAnswers).toEqual([armClockAfter4006.outcome]);
    expect(clockRow(t)).toMatchObject(ARMED_ONCE);
    expect(t.wired.data.openedQuestions).toEqual([A7_03_QUESTION]);
    expect(t.wired.actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
  });

  it("the repeat's spans: delivered, repeated and first of its row, then clockArmed, with no handle, number, key, message id, words or time", async () => {
    const t = await sent();
    await expect(t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate(1))).rejects.toThrow(CRASH);
    await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());

    expect(t.spans.map((span) => [span.hop, span.outcome, span.got])).toEqual([
      // The first receipt's mark, before the crash.
      ["delivered", "ok", { firstDelivery: true, repeated: false }],
      // The repeat: K-05's own answer, and the label that it repeats the row's first delivery.
      ["delivered", "ok", { firstDelivery: false, repeated: true, firstOfRow: true }],
      // The arming's span, as T-564 joined it.
      ["clockArmed", "ok", { firstDelivery: true, partNo: 1, tryNo: 1 }],
    ]);
    expect(t.spans[1]?.trace_id).toBe(t.spans[2]?.trace_id);
    const written = JSON.stringify(t.spans);
    for (const secret of [
      ALEX_HANDLE,
      ALEX.to,
      "5555550101",
      ALEX.chatId,
      WORDS_KEY,
      WORDS_MESSAGE,
      WORDS_TEXT,
      WORDS_DELIVERED_AT,
      armClockAfter4006.request.dueAt,
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it("a repeat after a completed arming writes no second clock row: the same isolate makes no call, another's armClock answers repeated", async () => {
    const t = await sent();
    const first = isolate();

    expect(await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, first)).toEqual({
      result: "delivered",
      outboxRowId: ROW,
      partNo: 1,
      firstDelivery: true,
    });
    const armed = clockRow(t);
    expect(armed).toMatchObject(ARMED_ONCE);

    // The isolate that armed it: the repeat is handed on, and its memory of the armed part makes no K-05 call.
    expect(await t.receipt(WORDS_MESSAGE, LATER, first)).toEqual({
      result: "repeated",
      outboxRowId: ROW,
      partNo: 1,
    });
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request]);

    // Another isolate: armClock is asked for the stored delivery, never the repeat's own time, and answers repeated
    // with the first arming (K-05 v1 item 5).
    expect(await t.receipt(WORDS_MESSAGE, LATER, isolate())).toEqual({
      result: "repeated",
      outboxRowId: ROW,
      partNo: 1,
    });
    expect(t.handed).toEqual([WORDS_HANDED, WORDS_HANDED, WORDS_HANDED]);
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request, armClockAfter4006.request]);
    expect(t.wired.data.armAnswers).toEqual([
      armClockAfter4006.outcome,
      { ...armClockAfter4006.outcome, repeated: true },
    ]);

    // One clock row, as its one arming left it: no second row, no second write, no cancel, no second sync.
    expect(clockRow(t)).toEqual(armed);
    expect(t.wired.data.openedQuestions).toEqual([A7_03_QUESTION]);
    expect(t.wired.data.cancelRequests).toEqual([]);
    expect(t.wired.actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
    expect(t.spans.filter((span) => span.hop === "clockArmed").map((span) => span.rows ?? [])).toEqual([
      [{ table: "clock_rows", id: A7_03_CLOCK_ROW }],
      [],
      [],
    ]);
  });

  it("a repeat of a later part's delivery arms nothing (mark-a7-03-poll-delivered-repeat.json)", async () => {
    const t = await sent();
    await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());
    expect(await t.receipt(POLL_MESSAGE, POLL_DELIVERED_AT, isolate())).toEqual({
      result: "delivered",
      outboxRowId: ROW,
      partNo: 2,
      firstDelivery: false,
    });
    const armed = clockRow(t);
    const handedBefore = [...t.handed];
    expect(handedBefore.map((part) => [part.partNo, part.firstDelivery])).toEqual([
      [1, true],
      [2, false],
    ]);

    // The poll's receipt again, to another isolate: a repeat of the row's second delivery.
    const again = await t.receipt(POLL_MESSAGE, POLL_DELIVERED_AT, isolate());

    expect(again).toEqual({ result: "repeated", outboxRowId: ROW, partNo: 2 });
    expect(t.handed).toEqual(handedBefore);
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request]);
    expect(clockRow(t)).toEqual(armed);
    expect(t.spans.at(-1)).toMatchObject({ hop: "delivered", got: { firstDelivery: false, repeated: true } });
    expect(t.spans.at(-1)?.got).not.toHaveProperty("firstOfRow");
  });

  it("with the first arming lost, the poll's receipt and its repeat still arm nothing; the words' repeat arms the clock", async () => {
    const t = await sent();
    await expect(t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate(1))).rejects.toThrow(CRASH);

    await t.receipt(POLL_MESSAGE, POLL_DELIVERED_AT, isolate());
    await t.receipt(POLL_MESSAGE, POLL_DELIVERED_AT, isolate());
    expect(t.handed.map((part) => [part.partNo, part.firstDelivery])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(t.wired.data.armRequests).toEqual([]);
    expect(clockRow(t)).toMatchObject({ state: "waiting", version: 1 });

    expect(await t.receipt(WORDS_MESSAGE, LATER, isolate())).toEqual({
      result: "repeated",
      outboxRowId: ROW,
      partNo: 1,
    });
    expect(t.handed.at(-1)).toEqual(WORDS_HANDED);
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request]);
    expect(clockRow(t)).toMatchObject(ARMED_ONCE);
  });

  it("two parts delivered at one time: each repeat is handed on (a tie counts as first), and the clock keeps its one arming", async () => {
    const t = await sent();
    await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());
    await t.receipt(POLL_MESSAGE, WORDS_DELIVERED_AT, isolate());
    const armed = clockRow(t);

    await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());
    await t.receipt(POLL_MESSAGE, WORDS_DELIVERED_AT, isolate());

    expect(t.handed.map((part) => [part.partNo, part.firstDelivery, part.deliveredAt])).toEqual([
      [1, true, WORDS_DELIVERED_AT],
      [2, false, WORDS_DELIVERED_AT],
      [1, true, WORDS_DELIVERED_AT],
      [2, true, WORDS_DELIVERED_AT],
    ]);
    expect(
      t.wired.data.armAnswers.map((answer) => ("result" in answer ? answer.repeated : answer.error)),
    ).toEqual([false, true, true]);
    expect(clockRow(t)).toEqual(armed);
    expect(t.wired.data.openedQuestions).toEqual([A7_03_QUESTION]);
  });
});

/** A K-05 markPart answer as a fixture, or a test's change of one, states it. */
const answerOf = (outcome: object): MarkPartResponse => outcome as MarkPartResponse;

/** mark-a7-03-delivered-repeat.json's answer in two pieces: what it repeats, and the rest (an answer of v1 to v1.8). */
const { repeatedDelivery: STATED, ...WITHOUT_THE_FIELD } = markDeliveredRepeat.outcome;

/** A receipt handled over a store that gives `markPart` this one answer, with the real arming of a new isolate. */
async function receiptAnswered(
  markPart: OutboxStore["markPart"],
  at: string,
): Promise<{ result: Promise<ReceiptResult>; wired: WiredArming; handed: PartDelivered[]; spans: Span[] }> {
  const wired = wireArming();
  const handed: PartDelivered[] = [];
  const spans: Span[] = [];
  const trace = receiptTrace(spans);
  const store: Pick<OutboxStore, "markPart"> = { markPart };
  const result = handleDeliveryReceipt(
    { store: store as OutboxStore, clockArming: armingOn(isolate(), wired, handed, trace), trace },
    { providerMessageId: markDeliveredRepeat.request.providerMessageId, partKey: WORDS_KEY, at },
  );
  await result.catch(() => undefined);
  return { result, wired, handed, spans };
}

describe("what the dispatcher reads of markPart's answer to a repeat (K-05 v1.9's fixtures)", () => {
  it("mark-a7-03-delivered-repeat.json is handed on as the answer names it, at the stored time whatever time the repeat carries: arm-clock-a7-03-after-4006.json's request", async () => {
    const answered = await receiptAnswered(
      () => Promise.resolve(answerOf(markDeliveredRepeat.outcome)),
      LATER,
    );

    expect(await answered.result).toEqual({ result: "repeated", outboxRowId: ROW, partNo: 1 });
    expect(answered.handed).toEqual([WORDS_HANDED]);
    expect(answered.wired.data.armRequests).toEqual([armClockAfter4006.request]);
    expect(answered.wired.data.armAnswers).toEqual([armClockAfter4006.outcome]);
  });

  const repeating = (repeatedDelivery: unknown): object => ({ ...WITHOUT_THE_FIELD, repeatedDelivery });
  const handsNothingOn: readonly (readonly [string, object])[] = [
    [
      "a repeat of a later part's delivery (mark-a7-03-poll-delivered-repeat.json)",
      markPollDeliveredRepeat.outcome,
    ],
    ["firstOfRow false on the words' repeat", repeating({ ...STATED, firstOfRow: false })],
    ["repeatedDelivery null (default 89)", repeating(null)],
    ["an answer without repeatedDelivery (v1 to v1.8: default 89)", WITHOUT_THE_FIELD],
    ["firstOfRow that is not true itself", repeating({ ...STATED, firstOfRow: "true" })],
    ["no stored time", repeating({ firstOfRow: true })],
    ["a stored time that is no text", repeating({ firstOfRow: true, deliveredAt: null })],
    ["repeatedDelivery that is no object", repeating(true)],
  ];

  it.each(handsNothingOn)("hands nothing on for %s", async (_what, outcome) => {
    const answered = await receiptAnswered(() => Promise.resolve(answerOf(outcome)), WORDS_DELIVERED_AT);

    expect(await answered.result).toMatchObject({ result: "repeated", outboxRowId: ROW });
    expect(answered.handed).toEqual([]);
    expect(answered.wired.data.armRequests).toEqual([]);
    expect(answered.wired.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "waiting", version: 1 });
    expect(answered.spans.map((span) => [span.hop, span.got])).toEqual([
      ["delivered", { firstDelivery: false, repeated: true }],
    ]);
  });

  it("a mark that records a delivery never reads repeatedDelivery: firstOfRow on an answer that is no repeat is not a second hand-on", async () => {
    const recorded = { ...WITHOUT_THE_FIELD, repeated: false, firstDelivery: true, repeatedDelivery: STATED };
    const answered = await receiptAnswered(() => Promise.resolve(answerOf(recorded)), WORDS_DELIVERED_AT);

    expect(await answered.result).toEqual({
      result: "delivered",
      outboxRowId: ROW,
      partNo: 1,
      firstDelivery: true,
    });
    expect(answered.handed).toEqual([WORDS_HANDED]);
    expect(answered.wired.data.armRequests).toEqual([armClockAfter4006.request]);
  });
});

/** K-05 v1.2's four outbox calls with only markPartV12 answering: a receipt makes no other call. */
function callsMarking(markPartV12: OutboxCalls["markPartV12"]): OutboxCalls {
  const unused = (): Promise<never> => Promise.reject(new Error("a receipt makes no such call"));
  return { claimOutboxV12: unused, renewClaim: unused, markRowV12: unused, markPartV12 };
}

type K05Marked = Awaited<ReturnType<OutboxCalls["markPartV12"]>>;
const k05Answer = (outcome: object): K05Marked => outcome as K05Marked;

/** mark-a7-03-delivered-repeat.json's request as the dispatcher makes it. */
const delivered = {
  outcome: "delivered" as const,
  providerMessageId: markDeliveredRepeat.request.providerMessageId,
  at: markDeliveredRepeat.request.at,
  idempotencyKey: markDeliveredRepeat.request.idempotencyKey,
};

describe("the real outbox port between K-05 markPart and the dispatcher (wiring/real.ts realOutbox.markPart)", () => {
  it("carries repeatedDelivery across as the store gives it: the repeat's, null, and left out", async () => {
    const repeat = realOutbox({
      calls: callsMarking(() => Promise.resolve(k05Answer(markDeliveredRepeat.outcome))),
    });
    expect(await repeat.markPart(delivered)).toEqual(markDeliveredRepeat.outcome);

    const laterPart = realOutbox({
      calls: callsMarking(() => Promise.resolve(k05Answer(markPollDeliveredRepeat.outcome))),
    });
    expect(await laterPart.markPart(delivered)).toEqual(markPollDeliveredRepeat.outcome);

    const none = realOutbox({
      calls: callsMarking(() => Promise.resolve(k05Answer({ ...WITHOUT_THE_FIELD, repeatedDelivery: null }))),
    });
    expect(await none.markPart(delivered)).toEqual({ ...WITHOUT_THE_FIELD, repeatedDelivery: null });

    // An answer of v1 to v1.8 has no such field, and the port makes none up: it is still not known.
    const earlier = realOutbox({ calls: callsMarking(() => Promise.resolve(k05Answer(WITHOUT_THE_FIELD))) });
    const answer = await earlier.markPart(delivered);
    expect(answer).toEqual(WITHOUT_THE_FIELD);
    expect("error" in answer ? answer.error : answer.repeatedDelivery).toBeUndefined();
  });

  it("through the port, K-05's repeat of the first delivery arms the clock: arm-clock-a7-03-after-4006.json's request", async () => {
    const requests: unknown[] = [];
    const store = realOutbox({
      calls: callsMarking((request) => {
        requests.push(request);
        return Promise.resolve(k05Answer(markDeliveredRepeat.outcome));
      }),
    });
    const answered = await receiptAnswered(
      (request) => store.markPart(request),
      markDeliveredRepeat.request.at,
    );

    expect(await answered.result).toEqual({ result: "repeated", outboxRowId: ROW, partNo: 1 });
    // The request is mark-a7-03-delivered-repeat.json's own: the message id, the time and the echoed key.
    expect(requests).toEqual([markDeliveredRepeat.request]);
    expect(answered.handed).toEqual([WORDS_HANDED]);
    expect(answered.wired.data.armRequests).toEqual([armClockAfter4006.request]);
  });
});

describe("a markPart that throws is no answer: it surfaces, and nothing is handed to the arming", () => {
  it("a markPartV12 that throws surfaces as it is: the port does not turn it into an answer, nothing is handed to the arming and the receipt is not answered as done", async () => {
    // db/repo throws this, with nothing written, when a delivered part try of the row holds no delivered_at
    // (outbox.ts default 21): what the receipt repeats cannot be read, and it is never guessed.
    const thrown = new Error("markPart: a delivered part holds no delivered_at");
    let calls = 0;
    const store = realOutbox({
      calls: callsMarking(() => {
        calls += 1;
        return Promise.reject(thrown);
      }),
    });

    await expect(store.markPart(delivered)).rejects.toBe(thrown);
    expect(calls).toBe(1);

    const answered = await receiptAnswered(
      (request) => store.markPart(request),
      markDeliveredRepeat.request.at,
    );

    // The receipt's handler rejects with the store's own error: no result, so the root's receipt sink rejects too and
    // the gateway answers Linq 503 (gateway/linq-webhook.ts), and Linq sends the receipt again.
    await expect(answered.result).rejects.toBe(thrown);
    // One call for the receipt: a throw is not asked again as a transient answer is.
    expect(calls).toBe(2);
    expect(answered.handed).toEqual([]);
    expect(answered.wired.data.armRequests).toEqual([]);
    expect(answered.wired.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "waiting", version: 1 });
    // No span says the receipt was delivered, and none holds the error's words.
    expect(answered.spans).toEqual([]);
  });

  it("the fake store throws the same way for a delivered part with no delivery time: nothing is handed on and the clock is not touched", async () => {
    const t = await sent();
    await t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate());
    const armed = clockRow(t);
    const words1 = t.store.row(ROW).parts.find((part) => part.key === WORDS_KEY);
    if (words1 === undefined) throw new Error("the row has no words part");
    // A record no K-05 call writes: delivered, with no delivery time.
    words1.deliveredAt = null;
    const version = t.store.row(ROW).version;

    await expect(t.receipt(WORDS_MESSAGE, WORDS_DELIVERED_AT, isolate())).rejects.toThrow(
      "a delivered part holds no delivered_at",
    );

    expect(t.handed).toEqual([WORDS_HANDED]);
    expect(t.store.row(ROW).version).toBe(version);
    expect(t.wired.data.armRequests).toEqual([armClockAfter4006.request]);
    expect(clockRow(t)).toEqual(armed);
  });
});
