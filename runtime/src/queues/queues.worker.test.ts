// The retry queue, run inside the Workers runtime (T-256; C-056; arch 10 line 540). Each batch is the runtime's own
// MessageBatch (`createMessageBatch`), its acks and retries read back with `getQueueResult`; the producer binding, the
// dead-letter store, the job runners, the send door and the clock are doubles (./test-support.ts). Each try's message is
// delivered when the double queue says it is due (its delaySeconds), unless a test delivers it early on purpose.
// Test values only (rule 9).
import type { QueueResult } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import platformReview from "../../../contracts/db-schema/platform-review/platform-review.v1.tables.json";
import {
  consumeRetries,
  enqueueRetry,
  HAND_OFF_DELAY_S,
  JOB_SPACING_S,
  JobMemory,
  RUN_LAPSE_MS,
  runJob,
  SEND_SPACING_S,
  type ConsumeOptions,
  type DeadLetterRow,
  type MessageReport,
  type QueueDeps,
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
  firstOf,
  LOG,
  messageId,
  QUEUE_NAME,
  scriptedJob,
  scriptedSends,
  SEED_CALENDAR_POLL,
  type Clock,
  type FakeQueue,
  type Retried,
} from "./test-support";

const POLL_KIND = String(SEED_CALENDAR_POLL.job_kind);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Delivered {
  reports: MessageReport[];
  result: QueueResult;
  retries: Retried[];
}

/** The retries asked for, each with its delay, after checking the runtime's own batch registered exactly those. */
function retriesOf(delivered: Delivered): Retried[] {
  expect(delivered.result.retryMessages.map((retry) => retry.msgId)).toEqual(
    delivered.retries.map((retry) => retry.msgId),
  );
  return delivered.retries;
}

interface Wiring {
  clock: Clock;
  queue: FakeQueue;
  deps: QueueDeps;
}

const optionsOf = (wiring: Wiring): ConsumeOptions => ({
  queue: wiring.queue,
  log: LOG,
  deps: wiring.deps,
  now: wiring.clock.now,
});

/** Delivers messages as one batch now, as the queue would; each copy gets its own message id unless one is given. */
async function deliver(
  wiring: Wiring,
  messages: readonly { message: unknown; id?: string; attempts?: number }[],
  options: Partial<ConsumeOptions> = {},
): Promise<Delivered> {
  const { batch, result, retries } = batchOf(
    messages.map((entry) => ({
      id: entry.id ?? messageId(),
      body: entry.message,
      attempts: entry.attempts ?? 1,
    })),
    wiring.clock.now(),
  );
  const report = await consumeRetries(batch, { ...optionsOf(wiring), ...options });
  return { reports: report.reports, result: await result(), retries };
}

/** Delivers what the double queue holds as each message comes due (moving the clock to it), until it is empty. */
async function pump(wiring: Wiring): Promise<MessageReport[]> {
  const reports: MessageReport[] = [];
  for (let round = 0; round < 200; round += 1) {
    const next = wiring.queue.nextDueAt();
    if (next === null) return reports;
    if (next > wiring.clock.now()) wiring.clock.to(next);
    for (const sent of wiring.queue.due(wiring.clock.now())) {
      reports.push(...(await deliver(wiring, [{ message: sent.message }])).reports);
    }
  }
  throw new Error("the queue never emptied");
}

function wire(start: string, deps: QueueDeps): Wiring {
  const clock = fakeClock(start);
  return { clock, queue: fakeQueue(clock), deps };
}

/** K-37 v1's dead_letters columns (platform-review.v1.tables.json). */
const DEAD_LETTER_COLUMNS = (
  platformReview.tables.find((table) => table.name === "dead_letters")?.columns ?? []
).map((column) => column.name);

/** K-37 v1's CHECKs on dead_letters, as code: every one holds for the row. */
function checksOf(row: DeadLetterRow): string[] {
  const broken: string[] = [];
  if (!(row.tries >= 5)) broken.push("dead_letters_after_five_tries");
  const first = Date.parse(row.first_tried_at);
  const last = Date.parse(row.last_tried_at);
  const dead = Date.parse(row.dead_at);
  if (!(first <= last && last <= dead)) broken.push("dead_letters_tries_in_order");
  if (!["open", "replayed", "closed"].includes(row.state)) broken.push("dead_letters_state_known");
  if (row.last_error.trim().length === 0) broken.push("dead_letters_error_given");
  return broken;
}

describe("a job failing 5 times becomes one dead-letter row with its last error", () => {
  it("tries 1 to 5 (the first where the job starts, then 2 minutes apart on the queue) end in one K-37 dead_letters row", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([
      { fail: "calendar503" },
      { fail: "calendar503" },
      { fail: "calendar503" },
      { fail: "calendar503" },
      { fail: "calendarTimeout" },
    ]);
    const wiring = wire(
      "2026-10-23T14:30:00Z",
      depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead }),
    );
    const job = calendarPoll();

    const first = await runJob(job, wiring.deps, {
      queue: wiring.queue,
      queueName: QUEUE_NAME,
      now: wiring.clock.now,
    });
    expect(first).toMatchObject({ outcome: "queued", delaySeconds: JOB_SPACING_S });
    const reports = await pump(wiring);

    expect(poll.calls.map((call) => [call.try, new Date(call.firstTriedAt).toISOString()])).toEqual([
      [1, "2026-10-23T14:30:00.000Z"],
      [2, "2026-10-23T14:30:00.000Z"],
      [3, "2026-10-23T14:30:00.000Z"],
      [4, "2026-10-23T14:30:00.000Z"],
      [5, "2026-10-23T14:30:00.000Z"],
    ]);
    expect(reports.map((report) => [report.try, report.outcome, report.errorCode])).toEqual([
      [2, "queuedNext", "JobFailed:calendar503"],
      [3, "queuedNext", "JobFailed:calendar503"],
      [4, "queuedNext", "JobFailed:calendar503"],
      [5, "deadLetter", "JobFailed:calendarTimeout"],
    ]);
    expect(wiring.queue.sent.map((sent) => [sent.message.try, sent.options.delaySeconds])).toEqual([
      [2, 120],
      [3, 120],
      [4, 120],
      [5, 120],
    ]);
    expect(wiring.queue.waiting).toBe(0);

    expect(dead.rows).toHaveLength(1);
    const row = firstOf(dead.rows);
    expect(row).toEqual({
      id: `dl-${job.key}`,
      queue: "rosie-retry",
      job_kind: "calendar_poll",
      job_id: "job-calendar-poll-riley-2026-10-23T14:30Z",
      message_body: SEED_CALENDAR_POLL.message_body,
      tries: 5,
      first_tried_at: "2026-10-23T14:30:00.000Z",
      last_tried_at: "2026-10-23T14:38:00.000Z",
      last_error: "JobFailed:calendarTimeout",
      business_id: "biz-lees-barbershop",
      trace_id: "trace-calendar-poll-0042",
      dead_at: "2026-10-23T14:38:00.000Z",
      state: "open",
      version: 1,
    });
    expect(checksOf(row)).toEqual([]);
  });

  it("the row has K-37's columns, as seed-dead-letter.json writes them, and the seed's job, times and trace", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const wiring = wire(
      "2026-10-23T14:30:00Z",
      depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead }),
    );
    await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    await pump(wiring);

    expect(dead.rows).toHaveLength(1);
    const row: Record<string, unknown> = { ...firstOf(dead.rows) };
    expect(Object.keys(row).sort()).toEqual(Object.keys(SEED_CALENDAR_POLL).sort());
    expect(DEAD_LETTER_COLUMNS.filter((column) => !(column in row))).toEqual([
      "resolved_at",
      "resolved_by_person_id",
    ]);
    for (const column of [
      "job_kind",
      "job_id",
      "message_body",
      "tries",
      "business_id",
      "trace_id",
      "state",
      "version",
    ]) {
      expect(row[column], column).toEqual(SEED_CALENDAR_POLL[column]);
    }
    for (const column of ["first_tried_at", "last_tried_at"]) {
      expect(Date.parse(String(row[column])), column).toBe(Date.parse(String(SEED_CALENDAR_POLL[column])));
    }
  });

  it("the fifth try's message delivered again writes no second row and runs no sixth try", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const wiring = wire(
      "2026-10-23T14:30:00Z",
      depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead }),
    );
    await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    await pump(wiring);
    const fifth = wiring.queue.sent.at(-1)?.message;

    wiring.clock.advance(60 * 60_000);
    const again = await deliver(wiring, [{ message: fifth, attempts: 2 }]);

    expect(again.reports.map((report) => report.outcome)).toEqual(["duplicate"]);
    expect(again.result.explicitAcks).toHaveLength(1);
    expect(poll.calls).toHaveLength(5);
    expect(dead.puts).toHaveLength(1);
  });

  it("a dead letter the store cannot write comes back in a minute and is written once, with no try run again", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const wiring = wire(
      "2026-10-23T14:30:00Z",
      depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead }),
    );
    await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    for (let tryNo = 2; tryNo <= 4; tryNo += 1) {
      wiring.clock.to(wiring.queue.nextDueAt() ?? 0);
      for (const sent of wiring.queue.due(wiring.clock.now()))
        await deliver(wiring, [{ message: sent.message }]);
    }
    wiring.clock.to(wiring.queue.nextDueAt() ?? 0);
    const [fifth] = wiring.queue.due(wiring.clock.now());

    dead.failNext(1);
    const failed = await deliver(wiring, [{ message: fifth?.message, id: "0fdead01" }]);
    expect(failed.reports.map((report) => [report.outcome, report.errorCode])).toEqual([
      ["handOffFailed", "deadLetterNotWritten"],
    ]);
    expect(retriesOf(failed)).toEqual([{ msgId: "0fdead01", delaySeconds: HAND_OFF_DELAY_S }]);
    expect(dead.rows).toHaveLength(0);

    wiring.clock.advance(HAND_OFF_DELAY_S * 1000);
    const back = await deliver(wiring, [{ message: fifth?.message, id: "0fdead01", attempts: 2 }]);
    expect(back.reports.map((report) => report.outcome)).toEqual(["deadLetter"]);
    expect(back.result.explicitAcks).toEqual(["0fdead01"]);
    expect(poll.calls).toHaveLength(5);
    expect(dead.rows).toHaveLength(1);
    expect(dead.rows[0]?.last_error).toBe("JobFailed:calendar503");
  });

  it("a kind with no runner fails each try as NoRunner and lands in the dead-letter queue", async () => {
    const dead = fakeDeadLetters();
    const wiring = wire("2026-10-23T14:30:00Z", depsOf({ deadLetters: dead }));
    const job = { ...calendarPoll("job-nightly-export-2026-10-23"), kind: "nightly_export" };

    await runJob(job, wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    await pump(wiring);

    expect(dead.rows.map((row) => [row.job_kind, row.tries, row.last_error])).toEqual([
      ["nightly_export", 5, "NoRunner:nightly_export"],
    ]);
  });
});

describe("a job succeeding on try 3 leaves none", () => {
  it("try 1 and try 2 fail, try 3 succeeds: no dead letter, no fourth try, the message acked", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([{ fail: "calendar503" }, { throw: new Error("socket hang up") }, "done"]);
    const wiring = wire(
      "2026-10-23T14:30:00Z",
      depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead }),
    );

    await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    const reports = await pump(wiring);

    expect(poll.calls.map((call) => call.try)).toEqual([1, 2, 3]);
    expect(reports.map((report) => [report.try, report.outcome, report.errorCode])).toEqual([
      [2, "queuedNext", "Error:threw"],
      [3, "done", null],
    ]);
    expect(dead.puts).toEqual([]);
    expect(wiring.queue.sent.map((sent) => sent.message.try)).toEqual([2, 3]);
    expect(wiring.queue.waiting).toBe(0);
  });

  it("the third try's message delivered again later runs nothing", async () => {
    const poll = scriptedJob([{ fail: "calendar503" }, { fail: "calendar503" }, "done"]);
    const wiring = wire("2026-10-23T14:30:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now });
    await pump(wiring);
    const third = wiring.queue.sent.at(-1)?.message;

    const again = await deliver(wiring, [{ message: third, attempts: 2 }]);

    expect(again.reports.map((report) => report.outcome)).toEqual(["duplicate"]);
    expect(poll.calls).toHaveLength(3);
  });

  it("a first try that succeeds puts nothing on the queue", async () => {
    const poll = scriptedJob(["done"]);
    const wiring = wire("2026-10-23T14:30:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));

    expect(await runJob(calendarPoll(), wiring.deps, { queue: wiring.queue, now: wiring.clock.now })).toEqual(
      {
        outcome: "done",
      },
    );
    expect(wiring.queue.sent).toEqual([]);
  });
});

describe("a send retry with Retry-After 30 is not tried before 30 s (fake clock)", () => {
  const FAILED_AT = "2026-11-07T19:00:05Z";

  async function queuedSend(retryAfterSeconds: number | null, script = scriptedSends(["done"])) {
    const dead = fakeDeadLetters();
    const wiring = wire(FAILED_AT, depsOf({ sends: script.run, deadLetters: dead }));
    const answer = await enqueueRetry(
      wiring.queue,
      averySend(),
      {
        try: 1,
        firstTriedAt: "2026-11-07T19:00:04Z",
        failed: { at: wiring.clock.now(), error: "SendFailed:rateLimited", retryAfterSeconds },
      },
      wiring.clock.now(),
    );
    return { wiring, answer, sends: script, dead };
  }

  it("the producer puts it on the queue with delaySeconds 30 and notBefore 30 s after the refusal", async () => {
    const { wiring, answer } = await queuedSend(30);

    expect(answer).toMatchObject({ result: "queued", delaySeconds: 30 });
    expect(wiring.queue.sent.map((sent) => sent.options)).toEqual([
      { contentType: "json", delaySeconds: 30 },
    ]);
    expect(wiring.queue.sent[0]?.message).toEqual({
      v: 1,
      job: averySend(),
      try: 2,
      firstTriedAt: "2026-11-07T19:00:04Z",
      notBefore: "2026-11-07T19:00:35.000Z",
      lastError: "SendFailed:rateLimited",
    });
  });

  it("delivered at 0 s, 15 s and 29.999 s it is not tried and comes back for the time left; at 30 s it is tried once", async () => {
    const { wiring, sends } = await queuedSend(30);
    const message = wiring.queue.sent[0]?.message;

    const early: (number | undefined)[] = [];
    for (const after of [0, 15_000, 29_999]) {
      wiring.clock.to(Date.parse(FAILED_AT) + after);
      const delivered = await deliver(wiring, [{ message, id: "0fsend01" }]);
      expect(delivered.reports.map((report) => report.outcome)).toEqual(["early"]);
      expect(delivered.result.explicitAcks).toEqual([]);
      early.push(retriesOf(delivered)[0]?.delaySeconds);
    }
    expect(early).toEqual([30, 15, 1]);
    expect(sends.calls).toEqual([]);

    wiring.clock.to(Date.parse(FAILED_AT) + 30_000);
    const due = await deliver(wiring, [{ message, id: "0fsend01" }]);
    expect(due.reports.map((report) => report.outcome)).toEqual(["done"]);
    expect(due.result.explicitAcks).toEqual(["0fsend01"]);
    expect(sends.calls.map((call) => [call.key, call.try, call.body])).toEqual([
      [averySend().key, 2, averySend().body],
    ]);
  });

  it("each next try waits for the Retry-After the dispatcher answers with, and a send never becomes a dead letter", async () => {
    const script = scriptedSends([
      { fail: "rateLimited", retryAfterSeconds: 45 },
      { fail: "rateLimited", retryAfterSeconds: 45 },
      { fail: "rateLimited", retryAfterSeconds: 45 },
      { fail: "rateLimited", retryAfterSeconds: 45 },
      { fail: "rateLimited", retryAfterSeconds: 45 },
      "done",
    ]);
    const { wiring, sends, dead } = await queuedSend(30, script);

    const reports = await pump(wiring);

    expect(sends.calls.map((call) => call.try)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(wiring.queue.sent.map((sent) => sent.options.delaySeconds)).toEqual([30, 45, 45, 45, 45, 45]);
    const tried = sends.calls.map(
      (call, index) => (wiring.queue.sent[index]?.dueAt ?? 0) - Date.parse(FAILED_AT),
    );
    expect(tried).toEqual([30_000, 75_000, 120_000, 165_000, 210_000, 255_000]);
    expect(reports.at(-1)?.outcome).toBe("done");
    expect(dead.puts).toEqual([]);
  });

  it("without a Retry-After a send's next try goes after 10 s", async () => {
    const { wiring, answer } = await queuedSend(null);

    expect(answer).toMatchObject({ result: "queued", delaySeconds: SEND_SPACING_S });
    expect(wiring.queue.sent[0]?.message.notBefore).toBe("2026-11-07T19:00:15.000Z");
  });
});

describe("a message delivered twice by the queue runs its job once (idempotent by job key)", () => {
  /** Try 2 of the calendar poll, due now. */
  function secondTry(clock: Clock, key?: string): RetryMessage {
    return {
      v: 1,
      job: calendarPoll(key),
      try: 2,
      firstTriedAt: "2026-10-23T14:30:00Z",
      notBefore: new Date(clock.now()).toISOString(),
      lastError: "JobFailed:calendar503",
    };
  }

  it("delivered again after it ran: acked, not run", async () => {
    const poll = scriptedJob(["done"]);
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    const message = secondTry(wiring.clock);

    const first = await deliver(wiring, [{ message, id: "0fdup001" }]);
    wiring.clock.advance(5_000);
    const second = await deliver(wiring, [{ message, id: "0fdup001", attempts: 2 }]);

    expect([...first.reports, ...second.reports].map((report) => report.outcome)).toEqual([
      "done",
      "duplicate",
    ]);
    expect([...first.result.explicitAcks, ...second.result.explicitAcks]).toEqual(["0fdup001", "0fdup001"]);
    expect(poll.calls).toHaveLength(1);
  });

  it("twice in one batch, or as two copies with their own message ids: run once", async () => {
    const poll = scriptedJob(["done"]);
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));

    const sameBatch = await deliver(wiring, [
      { message: secondTry(wiring.clock, "job-poll-a"), id: "0fdup002" },
      { message: secondTry(wiring.clock, "job-poll-a"), id: "0fdup002" },
    ]);
    const copies = await deliver(wiring, [
      { message: secondTry(wiring.clock, "job-poll-b"), id: "0fdup003" },
      { message: secondTry(wiring.clock, "job-poll-b"), id: "0fdup004" },
    ]);

    expect(sameBatch.reports.map((report) => report.outcome)).toEqual(["done", "duplicate"]);
    expect(copies.reports.map((report) => report.outcome)).toEqual(["done", "duplicate"]);
    expect(copies.result.explicitAcks).toEqual(["0fdup003", "0fdup004"]);
    expect(poll.calls.map((call) => call.key)).toEqual(["job-poll-a", "job-poll-b"]);
  });

  it("delivered twice at once: one delivery runs it, the other comes back after the run's lapse, then runs nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const slow = (job: { key: string }) => {
      calls.push(job.key);
      return gate.then(() => ({ result: "done" as const }));
    };
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: slow } }));
    const message = secondTry(wiring.clock);

    const running = deliver(wiring, [{ message, id: "0fdup005" }]);
    const meanwhile = await deliver(wiring, [{ message, id: "0fdup006" }]);
    release();
    const ran = await running;

    expect(meanwhile.reports.map((report) => report.outcome)).toEqual(["running"]);
    expect(retriesOf(meanwhile)).toEqual([{ msgId: "0fdup006", delaySeconds: RUN_LAPSE_MS / 1000 }]);
    expect(ran.reports.map((report) => report.outcome)).toEqual(["done"]);

    wiring.clock.advance(RUN_LAPSE_MS);
    const back = await deliver(wiring, [{ message, id: "0fdup006", attempts: 2 }]);
    expect(back.reports.map((report) => report.outcome)).toEqual(["duplicate"]);
    expect(calls).toEqual([message.job.key]);
  });

  it("a failed try's message delivered again neither runs the try again nor queues its next try twice", async () => {
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    const message = secondTry(wiring.clock);

    await deliver(wiring, [{ message, id: "0fdup007" }]);
    const again = await deliver(wiring, [{ message, id: "0fdup007", attempts: 2 }]);

    expect(again.reports.map((report) => report.outcome)).toEqual(["duplicate"]);
    expect(poll.calls).toHaveLength(1);
    expect(wiring.queue.sent.map((sent) => sent.message.try)).toEqual([3]);
  });

  it("a job started twice where it starts runs once", async () => {
    const poll = scriptedJob(["done"]);
    const wiring = wire("2026-10-23T14:30:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    const options = { queue: wiring.queue, now: wiring.clock.now };

    expect(await runJob(calendarPoll(), wiring.deps, options)).toEqual({ outcome: "done" });
    expect(await runJob(calendarPoll(), wiring.deps, options)).toEqual({ outcome: "duplicate" });
    expect(poll.calls).toHaveLength(1);
  });
});

describe("what follows a failed try when it cannot be handed on", () => {
  it("a next try the queue refuses: the message comes back in a minute and hands it on without running the try again", async () => {
    const poll = scriptedJob([{ fail: "calendar503" }]);
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run } }));
    const message: RetryMessage = {
      v: 1,
      job: calendarPoll(),
      try: 2,
      firstTriedAt: "2026-10-23T14:30:00Z",
      notBefore: "2026-10-23T14:32:00Z",
      lastError: "JobFailed:calendar503",
    };

    wiring.queue.failNext(1);
    const refused = await deliver(wiring, [{ message, id: "0fhand01" }]);
    expect(refused.reports.map((report) => [report.outcome, report.errorCode])).toEqual([
      ["handOffFailed", "queueFailed"],
    ]);
    expect(retriesOf(refused)).toEqual([{ msgId: "0fhand01", delaySeconds: HAND_OFF_DELAY_S }]);

    wiring.clock.advance(HAND_OFF_DELAY_S * 1000);
    const back = await deliver(wiring, [{ message, id: "0fhand01", attempts: 2 }]);
    expect(back.reports.map((report) => report.outcome)).toEqual(["queuedNext"]);
    expect(poll.calls).toHaveLength(1);
    expect(
      wiring.queue.sent.map((sent) => [sent.message.try, sent.message.notBefore, sent.options.delaySeconds]),
    ).toEqual([[3, "2026-10-23T14:34:00.000Z", 60]]);
  });

  it("a try whose delivery died is taken as failed once its 15 minutes lapse, and its next try goes on", async () => {
    const poll = scriptedJob(["done"]);
    const ledger = new JobMemory();
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({ jobs: { [POLL_KIND]: poll.run }, ledger }));
    const message: RetryMessage = {
      v: 1,
      job: calendarPoll(),
      try: 2,
      firstTriedAt: "2026-10-23T14:30:00Z",
      notBefore: "2026-10-23T14:32:00Z",
      lastError: "JobFailed:calendar503",
    };
    // A delivery began try 2 at 14:32 and its isolate died before it ended.
    expect(await ledger.begin(message.job.key, 2, wiring.clock.now())).toEqual({ go: true });

    wiring.clock.advance(10 * 60_000);
    const stillRunning = await deliver(wiring, [{ message, id: "0fdied01", attempts: 2 }]);
    expect(stillRunning.reports.map((report) => report.outcome)).toEqual(["running"]);
    expect(retriesOf(stillRunning)).toEqual([{ msgId: "0fdied01", delaySeconds: 300 }]);

    wiring.clock.advance(5 * 60_000);
    const lapsed = await deliver(wiring, [{ message, id: "0fdied01", attempts: 3 }]);
    expect(lapsed.reports.map((report) => [report.outcome, report.errorCode])).toEqual([
      ["queuedNext", "Lapsed:noAnswer"],
    ]);
    expect(poll.calls).toEqual([]);
    expect(wiring.queue.sent.map((sent) => [sent.message.try, sent.message.lastError])).toEqual([
      [3, "Lapsed:noAnswer"],
    ]);
  });

  it("with no ports joined nothing runs: each message comes back in a minute", async () => {
    const wiring = wire("2026-10-23T14:32:00Z", depsOf({}));
    const message: RetryMessage = {
      v: 1,
      job: calendarPoll(),
      try: 2,
      firstTriedAt: "2026-10-23T14:30:00Z",
      notBefore: "2026-10-23T14:32:00Z",
      lastError: "JobFailed:calendar503",
    };

    const delivered = await deliver(wiring, [{ message, id: "0fnone01" }], { deps: null });

    expect(delivered.reports.map((report) => report.outcome)).toEqual(["unwired"]);
    expect(retriesOf(delivered)).toEqual([{ msgId: "0fnone01", delaySeconds: HAND_OFF_DELAY_S }]);
  });
});
