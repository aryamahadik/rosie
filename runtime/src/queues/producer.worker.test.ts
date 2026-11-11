// The retry queue's producer and the Worker's queue handler (T-256), run inside the Workers runtime. The producer binding
// is a double (./test-support fakeQueue), not the RETRY_QUEUE env.staging binds since T-566; the handler is the Worker's
// own (runtime/src/index.ts), given the runtime's own MessageBatch. Test values only (rule 9).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../index";
import {
  consumeRetries,
  enqueueRetry,
  MAX_DELAY_S,
  runJob,
  SEND_TRIES_GUARD,
  setQueueDeps,
  type RetryAfter,
  type RetryJob,
  type RetryMessage,
} from "./index";
import {
  averySend,
  batchOf,
  calendarPoll,
  depsOf,
  fakeClock,
  fakeDeadLetters,
  fakeQueue,
  LOG,
  messageId,
  scriptedJob,
  scriptedSends,
  SEED_CALENDAR_POLL,
} from "./test-support";

const POLL_KIND = String(SEED_CALENDAR_POLL.job_kind);
const START = "2026-10-23T14:30:00Z";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const firstFailure = (at: number, retryAfterSeconds: number | null = null): RetryAfter => ({
  try: 1,
  firstTriedAt: new Date(at).toISOString(),
  failed: { at, error: "JobFailed:calendar503", retryAfterSeconds },
});

describe("enqueueRetry: the next try of a failed job goes on the retry queue", () => {
  it("refuses a job whose ids are no labels or whose body is no JSON object, and puts nothing on the queue", async () => {
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    const poll = calendarPoll();
    const big = "x".repeat(64_001);
    const bad: RetryJob[] = [
      { ...poll, key: "+1 555 555 0103" },
      { ...poll, key: "5555550103" },
      { ...poll, kind: "k".repeat(65) },
      { ...poll, traceId: "trace with spaces" },
      { ...poll, businessId: "biz lees" },
      { ...poll, body: { fn: () => "x" } },
      { ...poll, body: { at: undefined } },
      { ...poll, body: { count: Number.NaN } },
      { ...poll, body: { when: new Date(0) } },
      { ...poll, body: { big } },
      // 40,000 characters but 80,000 bytes as JSON: the limit is bytes.
      { ...poll, body: { wide: "é".repeat(40_000) } },
      // Jobs carry ids, not values (K-37 rule 4): no number, address or words, as a value or a name.
      { ...poll, body: { phone: "+15555550103" } },
      { ...poll, body: { email: "riley@example.com" } },
      { ...poll, body: { note: "pick me up at 9" } },
      { ...poll, body: { "+15555550103": true } },
      { ...poll, body: { people: [{ id: "person-riley" }, { id: "Riley M." }] } },
    ];
    for (const job of bad) {
      expect(await enqueueRetry(queue, job, firstFailure(clock.now()), clock.now())).toEqual({
        error: "badJob",
      });
    }
    expect(queue.sent).toEqual([]);
    const fits = {
      ...poll,
      body: { ...poll.body, cents: 3500, paid: false, note: null, pad: "x".repeat(63_000) },
    };
    expect(await enqueueRetry(queue, fits, firstFailure(0), 0)).toMatchObject({ result: "queued" });
  });

  it("refuses a failure that is not one: a try below 1, a time that is no instant, an error that is not name:label", async () => {
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    const at = clock.now();
    const failures: RetryAfter[] = [
      { ...firstFailure(at), try: 0 },
      { ...firstFailure(at), firstTriedAt: "yesterday" },
      { ...firstFailure(at), failed: { at, error: "the calendar said no", retryAfterSeconds: null } },
      { ...firstFailure(at), failed: { at: Number.NaN, error: "JobFailed:x", retryAfterSeconds: null } },
    ];
    for (const failure of failures) {
      expect(await enqueueRetry(queue, calendarPoll(), failure, at)).toEqual({ error: "badFailure" });
    }
    expect(queue.sent).toEqual([]);
  });

  it("a job's fifth try has no next try (its dead letter is the consumer's), nor a send at the guard", async () => {
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    const at = clock.now();

    expect(await enqueueRetry(queue, calendarPoll(), { ...firstFailure(at), try: 5 }, at)).toEqual({
      error: "noTriesLeft",
    });
    expect(await enqueueRetry(queue, calendarPoll(), { ...firstFailure(at), try: 4 }, at)).toMatchObject({
      result: "queued",
      message: { try: 5 },
    });
    expect(
      await enqueueRetry(queue, averySend(), { ...firstFailure(at), try: SEND_TRIES_GUARD }, at),
    ).toEqual({ error: "noTriesLeft" });
  });

  it("with no binding it answers noQueue; a binding that refuses, queueFailed", async () => {
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    queue.failNext(1);

    expect(await enqueueRetry(null, calendarPoll(), firstFailure(clock.now()), clock.now())).toEqual({
      error: "noQueue",
    });
    expect(await enqueueRetry(queue, calendarPoll(), firstFailure(clock.now()), clock.now())).toEqual({
      error: "queueFailed",
    });
  });

  it("a Retry-After over 12 hours is held to 12 hours; one that is no number counts as none", async () => {
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    const at = clock.now();

    const long = await enqueueRetry(queue, averySend(), firstFailure(at, 86_400), at);
    const negative = await enqueueRetry(
      queue,
      averySend("out-avery-new-booking-alex/1/2"),
      firstFailure(at, -5),
      at,
    );
    const nan = await enqueueRetry(queue, calendarPoll(), firstFailure(at, Number.NaN), at);

    expect(long).toMatchObject({ result: "queued", delaySeconds: MAX_DELAY_S });
    expect(queue.sent[0]?.message.notBefore).toBe(new Date(at + MAX_DELAY_S * 1000).toISOString());
    expect(negative).toMatchObject({ result: "queued", delaySeconds: 10 });
    expect(nan).toMatchObject({ result: "queued", delaySeconds: 120 });
  });
});

describe("runJob: a job's first try runs where it starts", () => {
  it("refuses a send (the dispatcher makes a row's first try) and a job that cannot ride the queue", async () => {
    const clock = fakeClock(START);
    const deps = depsOf({});
    const options = { queue: fakeQueue(clock), now: clock.now };

    expect(await runJob(averySend(), deps, options)).toEqual({
      outcome: "refused",
      errorCode: "sendIsTheDispatchers",
    });
    expect(await runJob({ ...calendarPoll(), key: "+15555550103" }, deps, options)).toEqual({
      outcome: "refused",
      errorCode: "keyNotLabel",
    });
  });

  it("a first failure the queue refused is handed on by the next start, without running the try again", async () => {
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const clock = fakeClock(START);
    const queue = fakeQueue(clock);
    const deps = depsOf({ jobs: { [POLL_KIND]: poll.run } });
    queue.failNext(1);

    expect(await runJob(calendarPoll(), deps, { queue, now: clock.now })).toEqual({
      outcome: "notQueued",
      errorCode: "queueFailed",
    });
    clock.advance(60_000);
    expect(await runJob(calendarPoll(), deps, { queue, now: clock.now })).toMatchObject({
      outcome: "queued",
      delaySeconds: 60,
      message: { try: 2, notBefore: "2026-10-23T14:32:00.000Z" },
    });
    expect(poll.calls).toHaveLength(1);
  });
});

describe("a send the dispatcher never ends", () => {
  it("stops at the guard: acked, no dead letter, nothing left on the queue", async () => {
    const sends = scriptedSends([{ fail: "rateLimited", retryAfterSeconds: 1 }]);
    const dead = fakeDeadLetters();
    const clock = fakeClock("2026-11-07T19:00:05Z");
    const queue = fakeQueue(clock);
    const deps = depsOf({ sends: sends.run, deadLetters: dead });
    await enqueueRetry(queue, averySend(), firstFailure(clock.now(), 1), clock.now());

    const outcomes: string[] = [];
    for (let round = 0; round < SEND_TRIES_GUARD + 5; round += 1) {
      const next = queue.nextDueAt();
      if (next === null) break;
      clock.to(Math.max(clock.now(), next));
      for (const sent of queue.due(clock.now())) {
        const { batch } = batchOf([{ id: messageId(), body: sent.message }], clock.now());
        const report = await consumeRetries(batch, { queue, log: LOG, deps, now: clock.now });
        outcomes.push(...report.reports.map((entry) => entry.outcome));
      }
    }

    expect(sends.calls).toHaveLength(SEND_TRIES_GUARD - 1);
    expect(sends.calls.at(-1)?.try).toBe(SEND_TRIES_GUARD);
    expect(outcomes.at(-1)).toBe("sendGivenUp");
    expect(dead.puts).toEqual([]);
    expect(queue.waiting).toBe(0);
  });
});

describe("the Worker's queue handler (runtime/src/index.ts)", () => {
  /**
   * The Worker's env without the HandleActor binding the pool's env carries (env.staging binds it since T-566), as
   * runtime/src/wiring/hop2.worker.test.ts's workerEnv(false) builds it. The queue entry wires the isolate first (T-1223),
   * and with no HANDLE_ACTOR it wires nothing, so each test keeps the ports it sets itself.
   */
  function workerEnv(): Cloudflare.Env {
    return { ENVIRONMENT: env.ENVIRONMENT, BASE_PATH: env.BASE_PATH, DB_SCHEMA: env.DB_SCHEMA };
  }

  const due: RetryMessage = {
    v: 1,
    job: calendarPoll(),
    try: 2,
    firstTriedAt: "2026-10-23T14:30:00Z",
    notBefore: "2026-10-23T14:32:00Z",
    lastError: "JobFailed:calendar503",
  };

  it("runs a due try with this isolate's ports and acks it", async () => {
    const poll = scriptedJob(["done"]);
    const undo = setQueueDeps(depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    try {
      const { batch, result } = batchOf([{ id: "0fworker1", body: due }], Date.now());
      await worker.queue(batch, workerEnv());

      expect((await result()).explicitAcks).toEqual(["0fworker1"]);
      expect(poll.calls.map((call) => [call.key, call.try])).toEqual([[due.job.key, 2]]);
    } finally {
      undo();
    }
  });

  it("with no ports joined it runs nothing and retries each message", async () => {
    const { batch, result, retries } = batchOf([{ id: "0fworker2", body: due }], Date.now());
    await worker.queue(batch, workerEnv());

    const queued = await result();
    expect(queued.explicitAcks).toEqual([]);
    expect(queued.retryMessages).toEqual([{ msgId: "0fworker2" }]);
    expect(retries).toEqual([{ msgId: "0fworker2", delaySeconds: 60 }]);
  });
});
