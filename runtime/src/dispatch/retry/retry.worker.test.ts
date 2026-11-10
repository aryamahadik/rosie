// The dispatcher's retries (T-258; C-124), run inside the Workers runtime (Vitest project "workers") through the real
// dispatcher, the real retry queue producer and consumer (T-256) and the real send door, against fakes that answer as the
// frozen fixtures state: K-11's error-4006.json, error-403-2024.json, error-rate-limit.json, send-override-optout.json and
// verify-delivered-after-4006.json; K-07's outbox-4006-new-key.json and outbox-safety-retry.json; K-05 v1.1's markPart
// forms (mark-failed-4006, mark-failed-retry-after, mark-delivered-by-key). The rows, words and numbers are the fixtures'
// own: the master's sample cast at Lee's Barbershop, phones 555-01xx (rule 9).
import { describe, expect, it } from "vitest";

import outbox4006NewKey from "../../../../contracts/outbox-effects/fixtures/outbox-4006-new-key.json";
import outboxSafetyRetry from "../../../../contracts/outbox-effects/fixtures/outbox-safety-retry.json";
import error2024 from "../../../../contracts/port-linq/fixtures/error-403-2024.json";
import error4006 from "../../../../contracts/port-linq/fixtures/error-4006.json";
import errorRateLimit from "../../../../contracts/port-linq/fixtures/error-rate-limit.json";
import sendOverrideOptout from "../../../../contracts/port-linq/fixtures/send-override-optout.json";
import deliveredAfter4006 from "../../../../contracts/port-linq/fixtures/verify-delivered-after-4006.json";
import { consumeRetries, type MessageReport } from "../../queues";
import { batchOf, depsOf, fakeQueue, LOG, messageId, type Sent } from "../../queues/test-support";
import { openTrace, type Span } from "../../trace";
import { handleDeliveryReceipt, runDispatch, type DispatchDeps } from "../dispatcher";
import {
  FakeClock,
  FakeClockArming,
  FakeLinq,
  FakeOutboxStore,
  FakeRecipients,
  FakeSendState,
  traceCollector,
  words,
  type SeedRow,
} from "../test-support";
import type { ChatTarget, LinqAccepted, LinqFailed } from "../types";
import { dispatchSendDoor, type DoorOutcome } from "./door";
import { queueRetries } from "./plan";
import { mayOverrideOptout, retryRuleFor } from "./rules";

const CHATS: Readonly<Record<string, ChatTarget>> = {
  "handle-alex": { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" },
  "handle-sam": { to: "+15555550100", chatId: "linq-chat-demo-sam", service: "imessage" },
  "handle-avery": { to: "+15555550103", chatId: "linq-chat-demo-avery", service: "imessage" },
  "handle-ben": { to: "+15555550106", chatId: "linq-chat-demo-ben", service: "imessage" },
};

/** Linq gave no answer: a timeout or a lost connection (K-11 `transient` with no status). */
const NO_ANSWER: LinqFailed = {
  result: "failed",
  kind: "transient",
  httpStatus: null,
  code: null,
  reason: "No answer",
  retryAfterSeconds: null,
  providerMessageId: null,
};

/** A failure Linq reported: K-07 outbox-safety-retry.json's 503. */
const SERVICE_DOWN: LinqFailed = {
  result: "failed",
  kind: "transient",
  httpStatus: 503,
  code: "503",
  reason: "Service unavailable",
  retryAfterSeconds: null,
  providerMessageId: null,
};

// The fixtures' outcomes as the port's types (JSON gives their words as plain strings).
const FAILED_4006 = error4006.outcome as unknown as LinqFailed;
const FAILED_2024 = error2024.outcome as unknown as LinqFailed;
const RATE_LIMITED = errorRateLimit.outcome as unknown as LinqFailed;
const STOP_LATER_ACCEPTED = sendOverrideOptout.outcome as unknown as LinqAccepted;

/** The same instant written as the fake's clock writes it, so a fixture's "…Z" and the fake's "….000Z" compare. */
const utc = (at: string | null): string | null => (at === null ? null : new Date(at).toISOString());

interface Rig {
  clock: FakeClock;
  store: FakeOutboxStore;
  linq: FakeLinq;
  sendState: FakeSendState;
  arming: FakeClockArming;
  spans: Span[];
  queue: ReturnType<typeof fakeQueue>;
  deps: DispatchDeps;
  /** Each part's send, with the clock's time as Linq got it. */
  sendTimes: [string, string][];
  /** What the send door did with each retry job's try. */
  doorTries: { key: string; outcome: DoorOutcome }[];
  /** Hands these queue messages to the retry queue's consumer now, as Cloudflare Queues delivers a batch. */
  deliver(...entries: Sent[]): Promise<MessageReport["outcome"][]>;
  receipt(
    messageIdOfLinq: string,
    partKey: string | null,
    at: string,
  ): ReturnType<typeof handleDeliveryReceipt>;
}

/** The dispatcher, the retry queue (T-256's producer and consumer, on a fake binding) and its send door, on one clock. */
function rig(seeds: readonly SeedRow[], start: string, answerMs = 0): Rig {
  const clock = new FakeClock(start);
  const ms = (): number => Date.parse(clock.now());
  const store = new FakeOutboxStore(seeds);
  const linq = new FakeLinq(clock.now);
  const sendState = new FakeSendState();
  const arming = new FakeClockArming();
  const spans: Span[] = [];
  const queue = fakeQueue({
    now: ms,
    set: (at) => {
      clock.advance(Date.parse(at) - ms());
    },
    to: (at) => {
      clock.advance(at - ms());
    },
    advance: (by) => {
      clock.advance(by);
    },
  });
  const sendTimes: [string, string][] = [];
  linq.beforeAnswer = (request) => {
    sendTimes.push([request.idempotencyKey, clock.now()]);
    clock.advance(answerMs); // Linq's answer takes this long
    return Promise.resolve();
  };
  const deps: DispatchDeps = {
    store,
    linq,
    recipients: new FakeRecipients(CHATS),
    sendState,
    environment: "production",
    traceFor: traceCollector(spans),
    now: clock.now,
    claimer: "dispatcher-1",
    retries: queueRetries(queue, ms),
  };
  const doorTries: { key: string; outcome: DoorOutcome }[] = [];
  const door = dispatchSendDoor(
    { ...deps, claimer: "dispatcher-2" },
    {
      onTry: (send, outcome) => {
        doorTries.push({ key: send.key, outcome });
      },
    },
  );
  const queueDeps = depsOf({ sends: door });
  return {
    clock,
    store,
    linq,
    sendState,
    arming,
    spans,
    queue,
    deps,
    sendTimes,
    doorTries,
    async deliver(...entries) {
      const { batch } = batchOf(
        entries.map((entry) => ({ id: messageId(), body: entry.message })),
        ms(),
      );
      const done = await consumeRetries(batch, { queue, log: LOG, deps: queueDeps, now: ms });
      return done.reports.map((report) => report.outcome);
    },
    receipt: (messageIdOfLinq, partKey, at) =>
      handleDeliveryReceipt(
        {
          store,
          clockArming: arming,
          trace: openTrace({
            openedBy: "providerWebhook",
            bundleId: { hash: "0123456789abcdef".repeat(4), build: 1 },
            sink: (span) => spans.push(span),
          }),
        },
        { providerMessageId: messageIdOfLinq, partKey, at },
      ),
  };
}

/** The one queue message the test expects. */
function only(sent: readonly Sent[]): Sent {
  expect(sent).toHaveLength(1);
  const [entry] = sent;
  if (entry === undefined) throw new Error("no message on the retry queue");
  return entry;
}

/** The hard invariant, over every send a test made: override_optout only on a safety line or a stop reply. */
function expectOverrideOnlyWhereAllowed(t: Rig, seeds: readonly SeedRow[]): void {
  const overridden = t.linq.requests
    .filter((request) => request.overrideOptout)
    .map((request) => request.idempotencyKey);
  const allowed = overridden.filter((key) => {
    const seed = seeds.find((candidate) => key.startsWith(`${candidate.id}/`));
    return (
      seed !== undefined && (seed.sendClass === "safety" || (seed.fixedLines ?? []).includes("stopReply"))
    );
  });
  expect(overridden).toEqual(allowed);
}

const tryRows = (t: Rig, id: string): [string, string][] =>
  t.store.tries(id).map((part) => [part.key, part.state]);

describe("K-07's key rule for each K-11 failure (retryRuleFor)", () => {
  const row = {
    sendClass: "routine",
    finalParts: { fixedLines: [] as string[] },
  } as unknown as Parameters<typeof retryRuleFor>[1];

  it("picks the next try by Linq's kind", () => {
    expect(retryRuleFor(NO_ANSWER, row)).toEqual({ rule: "sameKey", code: "transient" });
    expect(retryRuleFor(SERVICE_DOWN, row)).toEqual({ rule: "newKey", code: "503", retryAfterSeconds: null });
    expect(retryRuleFor(RATE_LIMITED, row)).toEqual({ rule: "newKey", code: "1007", retryAfterSeconds: 65 });
    expect(retryRuleFor(FAILED_4006, row)).toEqual({ rule: "awaitReceipt", code: "4006" });
    expect(retryRuleFor({ ...FAILED_4006, code: "4001" }, row)).toEqual({
      rule: "awaitReceipt",
      code: "4001",
    });
    expect(retryRuleFor(FAILED_2024, row)).toEqual({ rule: "optedOut", code: "2024", dropRow: true });
  });

  it("keeps a safety line's row after a 2024, and lets override_optout ride only a safety line or a stop reply", () => {
    const safety = { ...row, sendClass: "safety" };
    const stopReply = { ...row, finalParts: { fixedLines: ["stopReply"] } } as unknown as typeof row;
    expect(retryRuleFor(FAILED_2024, safety)).toEqual({ rule: "optedOut", code: "2024", dropRow: false });
    expect(retryRuleFor(FAILED_2024, stopReply)).toEqual({ rule: "optedOut", code: "2024", dropRow: true });
    expect([row, { ...row, sendClass: "quick_reply" }, safety, stopReply].map(mayOverrideOptout)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe("a timeout retry reuses the row-part-try key", () => {
  const ROW = "out-alex-booked-riley";
  const KEY = `${ROW}/1/1`;
  const seeds: SeedRow[] = [
    {
      id: ROW,
      recipient: "handle-alex",
      commitSeq: 1,
      sends: [words("You're booked with Riley at Lee's Barbershop.\nSat Nov 14, 11:00am")],
      bookingId: "booking-alex-riley-nov14",
    },
  ];

  it("sends the same key again under the next claim after no answer, and records one acceptance", async () => {
    const t = rig(seeds, "2026-11-07T15:06:35.000Z");
    t.linq.scripts.set(KEY, [NO_ANSWER, "accept"]);

    const first = await runDispatch(t.deps, { recipientHandleId: "handle-alex" });

    expect(first.rows).toEqual([
      {
        outboxRowId: ROW,
        recipientHandleId: "handle-alex",
        outcome: "failed",
        partsSent: 0,
        retry: {
          why: "sameKey",
          chain: "rerun",
          jobKey: `retry-${KEY}#1`,
          waitSeconds: 60,
          scheduled: "queued",
        },
      },
    ]);
    // Nothing is marked: the part stays pending under its key (K-07 rule 1).
    expect(t.store.marks).toEqual([]);
    expect(tryRows(t, ROW)).toEqual([[KEY, "pending"]]);
    expect(t.spans.find((span) => span.hop === "dispatch")).toMatchObject({
      outcome: "timedOut",
      error_code: "transient",
      decided: { result: "failed", retry: "sameKey", waitSeconds: 60 },
    });
    const message = only(t.queue.sent);
    expect(message.message).toMatchObject({
      try: 2,
      notBefore: "2026-11-07T15:07:35.000Z",
      job: {
        key: `retry-${KEY}#1`,
        kind: "send",
        body: { outboxRowId: ROW, failedKey: KEY, chain: "rerun" },
      },
    });

    t.clock.advance(60_000); // the claim the try went under has lapsed
    expect(await t.deliver(message)).toEqual(["done"]);

    expect(t.doorTries).toEqual([{ key: `retry-${KEY}#1`, outcome: "ran" }]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([KEY, KEY]);
    expect(t.linq.requests[1]).toEqual(t.linq.requests[0]);
    // The re-claim handed the same key out again, attempts + 1 (K-05 v1.1 item 13), and Linq accepted it once.
    expect(t.store.tries(ROW).map((part) => [part.key, part.state, part.attempts])).toEqual([
      [KEY, "sent", 2],
    ]);
    expect(t.store.marks).toEqual([expect.objectContaining({ outcome: "sent", idempotencyKey: KEY })]);
    expect(t.store.row(ROW)).toMatchObject({ state: "sent", claim: { claimNo: 2 } });
    expect(t.linq.accepted.size).toBe(1);
    expectOverrideOnlyWhereAllowed(t, seeds);
  });
});

describe("a reported failure gets a new key", () => {
  const ROW = "out-alex-booked-riley";
  const seeds: SeedRow[] = [
    {
      id: ROW,
      recipient: "handle-alex",
      commitSeq: 1,
      sends: [words("You're booked with Riley at Lee's Barbershop.\nSat Nov 14, 11:00am")],
    },
  ];

  it("marks the try failed with retry, and the next claim sends try 2 under its own key", async () => {
    const t = rig(seeds, "2026-11-07T15:06:35.000Z");
    t.linq.failures.set(`${ROW}/1/1`, SERVICE_DOWN); // Linq answers that key so every time

    const first = await runDispatch(t.deps, { recipientHandleId: "handle-alex" });

    expect(first.rows[0]).toMatchObject({
      outcome: "failed",
      retry: { why: "newKey", chain: "rerun", waitSeconds: 60, scheduled: "queued" },
    });
    expect(t.store.marks).toEqual([
      {
        outcome: "failed",
        idempotencyKey: `${ROW}/1/1`,
        errorCode: "503",
        retry: true,
        at: "2026-11-07T15:06:35.000Z",
        providerMessageId: null,
        nextTryNotBefore: null,
      },
    ]);
    expect(tryRows(t, ROW)).toEqual([
      [`${ROW}/1/1`, "failed"],
      [`${ROW}/1/2`, "pending"],
    ]);

    t.clock.advance(60_000);
    expect(await t.deliver(only(t.queue.sent))).toEqual(["done"]);

    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${ROW}/1/1`, `${ROW}/1/2`]);
    expect(tryRows(t, ROW)).toEqual([
      [`${ROW}/1/1`, "failed"],
      [`${ROW}/1/2`, "sent"],
    ]);
    expect(t.store.row(ROW).state).toBe("sent");
    expect(t.queue.sent).toHaveLength(1); // nothing more to retry
  });

  it("starts no new job once 15 minutes of tries have passed (K-07 rule 5: the next way is C-126's)", async () => {
    const t = rig(seeds, "2026-11-07T15:06:35.000Z");
    t.linq.failures.set(`${ROW}/1/1`, SERVICE_DOWN);
    t.linq.failures.set(`${ROW}/1/2`, SERVICE_DOWN);
    await runDispatch(t.deps, { recipientHandleId: "handle-alex" });

    t.clock.advance(15 * 60_000);
    expect(await t.deliver(only(t.queue.sent))).toEqual(["done"]);

    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([`${ROW}/1/1`, `${ROW}/1/2`]);
    expect(t.queue.sent).toHaveLength(1);
    expect(t.spans.filter((span) => span.hop === "dispatch").map((span) => span.decided?.retry)).toEqual([
      "newKey",
      "newKey",
    ]);
  });
});

describe("error-4006.json: no new key until 1 minute passes with no receipt", () => {
  const ROW = "out-sam-booked-riley";
  const KEY = error4006.request.idempotencyKey;
  const seeds: SeedRow[] = [
    {
      id: ROW,
      recipient: "handle-sam",
      commitSeq: 2,
      sends: [words(error4006.request.text)],
      bookingId: "booking-alex-riley-nov14",
    },
  ];

  it("fails the part with no next try, writes try 2 a minute later and sends it (outbox-4006-new-key.json)", async () => {
    // Linq's answer takes 1 s, as in the fixtures: the 4006 comes at 15:06:36, a minute's wait ends at 15:07:36.
    const t = rig(seeds, error4006.given.now, 1_000);
    t.linq.failures.set(KEY, FAILED_4006); // Linq answers the key's stored failure if it is named again

    const first = await runDispatch(t.deps, { recipientHandleId: "handle-sam" });

    expect(t.linq.requests).toEqual([error4006.request]);
    expect(first.rows).toEqual([
      {
        outboxRowId: ROW,
        recipientHandleId: "handle-sam",
        outcome: "failed",
        partsSent: 0,
        retry: {
          why: "awaitReceipt",
          chain: "awaitReceipt",
          jobKey: `retry-${KEY}#1`,
          waitSeconds: 60,
          scheduled: "queued",
        },
      },
    ]);
    // K-05 mark-failed-4006.json's form: failed, no next try, no message id.
    expect(t.store.marks).toEqual([
      {
        outcome: "failed",
        idempotencyKey: KEY,
        errorCode: "4006",
        retry: false,
        at: "2026-11-07T15:06:36.000Z",
        providerMessageId: null,
      },
    ]);
    const message = only(t.queue.sent);
    expect(message.message.notBefore).toBe("2026-11-07T15:07:36.000Z");

    // The queue hands it over a second early: it is not run, and no new key exists.
    t.clock.advance(59_000);
    expect(await t.deliver(message)).toEqual(["early"]);
    expect(tryRows(t, ROW)).toEqual([[KEY, "failed"]]);

    t.clock.advance(1_000); // 15:07:36: the minute has passed with no receipt
    expect(await t.deliver(message)).toEqual(["done"]);
    expect(t.doorTries).toEqual([{ key: `retry-${KEY}#1`, outcome: "ran" }]);
    expect(t.store.marks).toContainEqual({
      outcome: "failed",
      idempotencyKey: KEY,
      errorCode: "4006",
      retry: true,
      at: "2026-11-07T15:07:36.000Z",
    });
    const newKey = `${ROW}/1/2`;
    expect(t.sendTimes).toEqual([
      [KEY, "2026-11-07T15:06:35.000Z"],
      [newKey, "2026-11-07T15:07:36.000Z"],
    ]);

    t.clock.advance(1_000); // its receipt, at 15:07:38
    const accepted = t.linq.accepted.get(newKey);
    expect(await t.receipt(accepted?.providerMessageId ?? "none", newKey, t.clock.now())).toMatchObject({
      result: "delivered",
      firstDelivery: true,
    });

    // K-07's life of the row, try by try: its keys, states, times and codes.
    const pick = (part: {
      idempotencyKey: string;
      partNo: number;
      tryNo: number;
      state: string;
      sentAt: string | null;
      deliveredAt: string | null;
      failedAt: string | null;
      errorCode: string | null;
    }) => ({
      idempotencyKey: part.idempotencyKey,
      partNo: part.partNo,
      tryNo: part.tryNo,
      state: part.state,
      sentAt: utc(part.sentAt),
      deliveredAt: utc(part.deliveredAt),
      failedAt: utc(part.failedAt),
      errorCode: part.errorCode,
    });
    expect(t.store.tries(ROW).map((part) => pick({ ...part, idempotencyKey: part.key }))).toEqual(
      outbox4006NewKey.parts.map(pick),
    );
    const written = outbox4006NewKey.moves.find(
      (move) => move.subject === "part" && move.key === newKey && move.from === null,
    );
    expect(utc(t.store.tries(ROW)[1]?.writtenAt ?? null)).toBe(utc(written?.at ?? null));
    expect(t.store.row(ROW).state).toBe(outbox4006NewKey.row.state);
    expect(utc(t.store.row(ROW).claim?.firstTryAt ?? null)).toBe(utc(outbox4006NewKey.claim.firstTryAt));
    expect(t.queue.sent).toHaveLength(1);
    expectOverrideOnlyWhereAllowed(t, seeds);
  });

  it("makes no new key in a run that comes before the minute is out, and the new key still goes once", async () => {
    const t = rig(seeds, error4006.given.now, 1_000);
    t.linq.failures.set(KEY, FAILED_4006);
    await runDispatch(t.deps, { recipientHandleId: "handle-sam" });
    const awaiting = only(t.queue.sent);

    // 15:07:35: the claim has lapsed, a minute has not passed since the 4006 (15:06:36), and a turn wakes the dispatcher.
    t.clock.advance(59_000);
    const wake = await runDispatch(t.deps, { recipientHandleId: "handle-sam" });
    expect(wake.rows).toHaveLength(1);
    expect(wake.rows[0]).toMatchObject({
      outcome: "awaitingRetry",
      retry: { why: "failedTry", scheduled: "queued" },
    });
    expect(tryRows(t, ROW)).toEqual([[KEY, "failed"]]);
    expect(t.linq.requests).toHaveLength(1);

    // 15:07:36: the 4006's own job writes the new key; the wake's claim is live, so it sends nothing yet.
    t.clock.advance(1_000);
    expect(await t.deliver(awaiting)).toEqual(["done"]);
    const parts = t.store.tries(ROW);
    expect(parts.map((part) => [part.key, part.state])).toEqual([
      [KEY, "failed"],
      [`${ROW}/1/2`, "pending"],
    ]);
    expect(
      Date.parse(parts[1]?.writtenAt ?? "") - Date.parse(parts[0]?.failedAt ?? ""),
    ).toBeGreaterThanOrEqual(60_000);

    // The wake's own job, once its claim has lapsed, sends the new key, once.
    const rerun = t.queue.sent[1];
    if (rerun === undefined) throw new Error("the wake left no job");
    t.clock.advance(Date.parse(rerun.message.notBefore) - Date.parse(t.clock.now()));
    expect(await t.deliver(rerun)).toEqual(["done"]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([KEY, `${ROW}/1/2`]);
    expect(t.store.row(ROW).state).toBe("sent");
  });
});

describe("a receipt in that minute ends the retries", () => {
  const ROW = "out-sam-booked-riley";
  const KEY = error4006.request.idempotencyKey;
  const seeds: SeedRow[] = [
    { id: ROW, recipient: "handle-sam", commitSeq: 2, sends: [words(error4006.request.text)] },
  ];

  it("finds the failed part by its echoed key (verify-delivered-after-4006.json), and no new key goes", async () => {
    const t = rig(seeds, error4006.given.now, 1_000);
    t.linq.failures.set(KEY, FAILED_4006);
    await runDispatch(t.deps, { recipientHandleId: "handle-sam" });
    const awaiting = only(t.queue.sent);

    // 25 s after the 4006, Linq's message.delivered for it, with the part's key beside the K-06 event.
    t.clock.advance(Date.parse(deliveredAfter4006.given.now) - Date.parse(t.clock.now()));
    const { event, partKey } = deliveredAfter4006.outcome;
    const receipt = await t.receipt(event.status.messageId, partKey, event.status.at);

    expect(receipt).toEqual({ result: "delivered", outboxRowId: ROW, partNo: 1, firstDelivery: true });
    // K-05 v1.2 mark-delivered-by-key.json's form: the message id and the echoed key.
    expect(t.store.marks.at(-1)).toEqual({
      outcome: "delivered",
      providerMessageId: "linq-msg-demo-sam-0001",
      at: "2026-11-07T15:07:00Z",
      idempotencyKey: KEY,
    });
    expect(t.store.row(ROW).state).toBe("delivered");
    expect(t.arming.delivered).toEqual([expect.objectContaining({ outboxRowId: ROW, firstDelivery: true })]);

    // The minute ends: the job finds the part delivered, and the retries end.
    t.clock.advance(Date.parse(awaiting.message.notBefore) - Date.parse(t.clock.now()));
    expect(await t.deliver(awaiting)).toEqual(["done"]);
    expect(t.doorTries).toEqual([{ key: `retry-${KEY}#1`, outcome: "receiptCame" }]);
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([KEY]);
    expect(tryRows(t, ROW)).toEqual([[KEY, "delivered"]]);
    expect(t.queue.sent).toHaveLength(1);
    expect(t.arming.delivered).toHaveLength(1);
  });
});

describe("error-403-2024.json on a routine row: no retry, and the row goes the stop path", () => {
  const ROW = "out-ben-reminder";
  const KEY = error2024.request.idempotencyKey;
  const seeds: SeedRow[] = [
    { id: ROW, recipient: "handle-ben", commitSeq: 1, sends: [words(error2024.request.text)] },
  ];

  it("marks the part failed with no retry and drops the row as stopped, with nothing on the retry queue", async () => {
    // The reminder was claimed a moment before Ben's exact STOP reached Rosie: limit 8 let it go, Linq refuses it.
    const t = rig(seeds, error2024.given.now);
    t.linq.failures.set(KEY, FAILED_2024);

    const report = await runDispatch(t.deps, { recipientHandleId: "handle-ben" });

    expect(t.linq.requests).toEqual([error2024.request]);
    expect(report.rows).toEqual([
      { outboxRowId: ROW, recipientHandleId: "handle-ben", outcome: "optedOut", partsSent: 0 },
    ]);
    expect(t.store.marks).toEqual([
      {
        outcome: "failed",
        idempotencyKey: KEY,
        errorCode: "2024",
        retry: false,
        at: "2026-10-20T13:00:03.000Z",
        providerMessageId: null,
      },
    ]);
    expect(t.store.rowMarks.map(({ request, answer }) => [request.outcome, answer])).toEqual([
      ["droppedStopped", "droppedStopped"],
    ]);
    expect(t.store.row(ROW).state).toBe("dropped_stopped");
    expect(t.queue.sent).toEqual([]);
    expect(t.spans.find((span) => span.hop === "dispatch")).toMatchObject({
      outcome: "failed",
      error_code: "2024",
      decided: { result: "optedOut" },
    });

    // Later runs find nothing to send: the row is finished, and never goes again, with override_optout or without.
    t.clock.advance(10 * 60_000);
    expect((await runDispatch(t.deps, { recipientHandleId: "handle-ben" })).claimed).toBe(0);
    expect(t.linq.requests).toHaveLength(1);
    expectOverrideOnlyWhereAllowed(t, seeds);
  });
});

describe("override_optout appears only on a stop reply or a safety line (hard invariant: no routine text after STOP)", () => {
  const SAFETY_TEXT = outboxSafetyRetry.row.finalParts.sends[0]?.text ?? "";
  const seeds: SeedRow[] = [
    { id: "out-ben-reminder", recipient: "handle-ben", commitSeq: 1, sends: [words(error2024.request.text)] },
    {
      id: "out-ben-quick",
      recipient: "handle-ben",
      commitSeq: 2,
      sends: [words(error2024.request.text)],
      sendClass: "quick_reply",
    },
    {
      id: "out-ben-stop-later",
      recipient: "handle-ben",
      commitSeq: 3,
      sends: [words(sendOverrideOptout.request.text)],
      fixedLines: ["stopReply"],
    },
    {
      id: "out-ben-safety",
      recipient: "handle-ben",
      commitSeq: 4,
      sends: [words(SAFETY_TEXT)],
      sendClass: "safety",
      fixedLines: ["safetyEmergency"],
    },
  ];

  it("to a stopped phone, only the stop reply and the safety line go, each with override_optout", async () => {
    const t = rig(seeds, sendOverrideOptout.given.now);
    t.sendState.forHandle("handle-ben", { stopped: true, chatOpen: false });
    t.linq.scripts.set(sendOverrideOptout.request.idempotencyKey, [STOP_LATER_ACCEPTED]);

    const report = await runDispatch(t.deps, { recipientHandleId: "handle-ben" });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-reminder", "droppedStopped"],
      ["out-ben-quick", "droppedStopped"],
      ["out-ben-stop-later", "sent"],
      ["out-ben-safety", "sent"],
    ]);
    expect(t.linq.requests[0]).toEqual(sendOverrideOptout.request);
    expect(t.linq.requests.map((request) => [request.idempotencyKey, request.overrideOptout])).toEqual([
      ["out-ben-stop-later/1/1", true],
      ["out-ben-safety/1/1", true],
    ]);
    expectOverrideOnlyWhereAllowed(t, seeds);
  });

  it("to a phone that is not stopped, no send carries override_optout", async () => {
    const t = rig(seeds, "2026-10-21T15:00:00.000Z"); // 11am in New York
    const report = await runDispatch(t.deps, { recipientHandleId: "handle-ben" });

    expect(report.rows.map((row) => row.outcome)).toEqual(["sent", "sent", "sent", "sent"]);
    expect(t.linq.requests.map((request) => request.overrideOptout)).toEqual([false, false, false, false]);
  });

  it("a safety line Linq still refuses with 2024 is not retried on Linq, and keeps its row for its other ways", async () => {
    const safetyFirst: SeedRow[] = [
      { ...seeds[3], commitSeq: 1 } as SeedRow,
      { ...seeds[0], commitSeq: 2 } as SeedRow,
    ];
    const t = rig(safetyFirst, sendOverrideOptout.given.now);
    t.sendState.forHandle("handle-ben", { stopped: true, chatOpen: false });
    t.linq.failures.set("out-ben-safety/1/1", FAILED_2024); // override_optout does not lift Linq's block (spike row 15)

    const report = await runDispatch(t.deps, { recipientHandleId: "handle-ben" });

    expect(report.rows.map((row) => [row.outboxRowId, row.outcome])).toEqual([
      ["out-ben-safety", "optedOut"],
      ["out-ben-reminder", "droppedStopped"],
    ]);
    expect(t.linq.requests.map((request) => [request.idempotencyKey, request.overrideOptout])).toEqual([
      ["out-ben-safety/1/1", true],
    ]);
    expect(t.store.marks).toEqual([
      expect.objectContaining({ idempotencyKey: "out-ben-safety/1/1", retry: false }),
    ]);
    expect(t.store.row("out-ben-safety").state).toBe("sending");
    expect(t.queue.sent).toEqual([]);
    expectOverrideOnlyWhereAllowed(t, safetyFirst);
  });
});

describe("error-rate-limit.json waits its Retry-After", () => {
  const ROW = "out-avery-new-booking-alex";
  const KEY = errorRateLimit.request.idempotencyKey;
  const seeds: SeedRow[] = [
    {
      id: ROW,
      recipient: "handle-avery",
      commitSeq: 14,
      sends: [words(errorRateLimit.request.text)],
      bookingId: "booking-alex-avery-nov21",
    },
  ];

  it("writes the new key with the Retry-After on the claim, and the queue sends it no earlier", async () => {
    const t = rig(seeds, errorRateLimit.given.now);
    t.linq.failures.set(KEY, RATE_LIMITED);

    const first = await runDispatch(t.deps, { recipientHandleId: "handle-avery" });

    expect(t.linq.requests).toEqual([errorRateLimit.request]);
    expect(first.rows[0]).toMatchObject({
      outcome: "failed",
      retry: { why: "newKey", jobKey: `retry-${KEY}#1`, waitSeconds: 65, scheduled: "queued" },
    });
    // K-05 mark-failed-retry-after.json's form: failed with retry, the Retry-After as nextTryNotBefore.
    expect(t.store.marks).toEqual([
      {
        outcome: "failed",
        idempotencyKey: KEY,
        errorCode: "1007",
        retry: true,
        at: "2026-11-07T19:00:05.000Z",
        providerMessageId: null,
        nextTryNotBefore: "2026-11-07T19:01:10.000Z",
      },
    ]);
    expect(t.store.row(ROW).claim?.nextTryNotBefore).toBe("2026-11-07T19:01:10.000Z");
    const message = only(t.queue.sent);
    expect(message.options.delaySeconds).toBe(65);
    expect(message.message.notBefore).toBe("2026-11-07T19:01:10.000Z");

    t.clock.advance(30_000); // handed over early: not tried
    expect(await t.deliver(message)).toEqual(["early"]);
    expect(t.linq.requests).toHaveLength(1);

    t.clock.advance(35_000); // 19:01:10
    expect(await t.deliver(message)).toEqual(["done"]);
    expect(t.sendTimes).toEqual([
      [KEY, "2026-11-07T19:00:05.000Z"],
      [`${ROW}/1/2`, "2026-11-07T19:01:10.000Z"],
    ]);
    expect(t.store.row(ROW)).toMatchObject({ state: "sent", claim: { nextTryNotBefore: null } });
  });

  it("a run before the Retry-After meets renewClaim's notYet and sends nothing (renew-claim-not-yet.json)", async () => {
    const t = rig(seeds, errorRateLimit.given.now);
    t.linq.failures.set(KEY, RATE_LIMITED);
    await runDispatch(t.deps, { recipientHandleId: "handle-avery" });

    t.clock.advance(61_000); // 19:01:06: the claim has lapsed, the Retry-After has not passed
    const wake = await runDispatch(t.deps, { recipientHandleId: "handle-avery" });

    expect(wake.rows[0]).toMatchObject({
      outcome: "retryAfter",
      retry: { why: "notYet", scheduled: "queued" },
    });
    expect(t.store.renewals.at(-1)?.answer).toBe("notYet");
    expect(t.linq.requests).toHaveLength(1);

    // Every job that comes due sends the new key once, and none before 19:01:10.
    for (const entry of [...t.queue.sent]) {
      const due = Date.parse(entry.message.notBefore);
      if (due > Date.parse(t.clock.now())) t.clock.advance(due - Date.parse(t.clock.now()));
      await t.deliver(entry);
    }
    expect(t.linq.requests.map((request) => request.idempotencyKey)).toEqual([KEY, `${ROW}/1/2`]);
    const [, retried] = t.sendTimes;
    expect(Date.parse(retried?.[1] ?? "")).toBeGreaterThanOrEqual(Date.parse("2026-11-07T19:01:10.000Z"));
    expect(t.store.row(ROW).state).toBe("sent");
  });
});
