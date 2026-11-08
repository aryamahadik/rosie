// What a try's error leaves behind (T-256; STATE note 3): a dead letter's last error and every log line hold the error's
// name and a label only, never a message's words, a phone number, a name or PostgresError.detail; and a body that is no
// retry message is never run. Run inside the Workers runtime with the runtime's own MessageBatch. Test values only
// (rule 9): the words and number below are made up, there to prove they never get out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeRetries,
  errorLabelOf,
  isErrorLabel,
  JobMemory,
  readRetryMessage,
  runJob,
  type QueueDeps,
  type RetryMessage,
} from "./index";
import {
  batchOf,
  calendarPoll,
  depsOf,
  fakeClock,
  fakeDeadLetters,
  fakeQueue,
  firstOf,
  LOG,
  messageId,
  scriptedJob,
  SEED_CALENDAR_POLL,
  type Clock,
  type FakeQueue,
} from "./test-support";

const POLL_KIND = String(SEED_CALENDAR_POLL.job_kind);
/** Private words a careless error could carry: a name, a phone number, a row's detail. Made up. */
const PRIVATE = [
  "Riley",
  "riley@example.com",
  "+15555550103",
  "555-0103",
  "Failing row contains",
  "pick me up",
];

/** postgres.js's error for a refused write: its message, detail and where carry the row's values. */
class PostgresError extends Error {
  override readonly name = "PostgresError";
  readonly code = "23514";
  readonly constraint_name = "dead_letters_after_five_tries";
  readonly detail = "Failing row contains (dl-x, Riley, +15555550103, pick me up at 9)";
  readonly where = "riley@example.com";

  constructor() {
    super('new row for relation "dead_letters" violates check constraint: Riley +15555550103');
  }
}

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const leaks = (text: string): string[] => PRIVATE.filter((word) => text.includes(word));

describe("the error label: the error's name and a label only", () => {
  it("a thrown error leaves its name and 'threw'; a refused PostgreSQL write its SQLSTATE and constraint, never its detail", () => {
    const thrown: [unknown, string][] = [
      [new Error("Riley at +15555550103 said pick me up"), "Error:threw"],
      [new TypeError("cannot read riley@example.com"), "TypeError:threw"],
      [new PostgresError(), "PostgresError:23514:dead_letters_after_five_tries"],
      [Object.assign(new Error("x"), { name: "Riley said hi" }), "Error:threw"],
      [Object.assign(new Error("x"), { name: "PostgresError", code: "555-0103" }), "PostgresError:threw"],
      ["Riley +15555550103", "Thrown:threw"],
      [null, "Thrown:threw"],
    ];
    for (const [value, label] of thrown) {
      expect(errorLabelOf(value)).toBe(label);
      expect(isErrorLabel(label)).toBe(true);
    }
  });

  it("a fifth try that throws a PostgresError leaves only its name, SQLSTATE and constraint in the dead letter and the logs", async () => {
    const dead = fakeDeadLetters();
    const poll = scriptedJob([
      { fail: "calendar503" },
      { throw: new Error("Riley +15555550103") },
      { fail: "Riley +15555550103" },
      { fail: "calendar503" },
      { throw: new PostgresError() },
    ]);
    const clock = fakeClock("2026-10-23T14:30:00Z");
    const queue = fakeQueue(clock);
    const deps = depsOf({ jobs: { [POLL_KIND]: poll.run }, deadLetters: dead });

    await runJob(calendarPoll(), deps, { queue, now: clock.now });
    await pump(queue, clock, deps);

    expect(dead.rows).toHaveLength(1);
    const row = firstOf(dead.rows);
    expect(row.last_error).toBe("PostgresError:23514:dead_letters_after_five_tries");
    expect(queue.sent.map((sent) => sent.message.lastError)).toEqual([
      "JobFailed:calendar503",
      "Error:threw",
      "JobFailed:badCode",
      "JobFailed:calendar503",
    ]);
    expect(leaks(JSON.stringify(row))).toEqual([]);
    expect(leaks(JSON.stringify(queue.sent))).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    expect(leaks(lines.join("\n"))).toEqual([]);
  });

  it("one JSON log line per message, on the job's own trace id, with labels and counts only", async () => {
    const poll = scriptedJob([{ fail: "calendar503" }, "done"]);
    const clock = fakeClock("2026-10-23T14:30:00Z");
    const queue = fakeQueue(clock);
    const deps = depsOf({ jobs: { [POLL_KIND]: poll.run } });

    await runJob(calendarPoll(), deps, { queue, now: clock.now });
    await pump(queue, clock, deps);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        level: "info",
        msg: "retryQueue",
        trace_id: "trace-calendar-poll-0042",
        job_id: "job-calendar-poll-riley-2026-10-23T14:30Z",
        job_kind: "calendar_poll",
        try: 2,
        message_id: expect.any(String) as unknown,
        outcome: "done",
        error_code: null,
        retry_in_s: null,
        environment: "staging",
        version: "test-sha",
      },
    ]);
  });
});

describe("a body that is no retry message is never run", () => {
  const good = (clock: Clock): RetryMessage => ({
    v: 1,
    job: calendarPoll(),
    try: 2,
    firstTriedAt: "2026-10-23T14:30:00Z",
    notBefore: new Date(clock.now()).toISOString(),
    lastError: "JobFailed:calendar503",
  });

  it("each is retried with no delay, toward the queue's own dead-letter queue (rosie-retry-dlq), and named by why", async () => {
    const poll = scriptedJob(["done"]);
    const clock = fakeClock("2026-10-23T14:32:00Z");
    const deps: QueueDeps = depsOf({ jobs: { [POLL_KIND]: poll.run }, ledger: new JobMemory() });
    const base = good(clock);
    const bodies: [unknown, string][] = [
      ["Riley +15555550103", "notObject"],
      [null, "notObject"],
      [{ ...base, v: 2 }, "unknownVersion"],
      [{ ...base, job: { ...base.job, key: "+1 555 555 0103" } }, "keyNotLabel"],
      [{ ...base, job: { ...base.job, key: "5555550103" } }, "keyNotLabel"],
      [{ ...base, job: { ...base.job, kind: "calendar poll" } }, "kindNotLabel"],
      [{ ...base, job: { ...base.job, traceId: "" } }, "traceNotLabel"],
      [{ ...base, job: { ...base.job, businessId: undefined } }, "businessNotLabel"],
      [{ ...base, job: { ...base.job, body: ["calendar_poll"] } }, "bodyNotJson"],
      [{ ...base, try: 1 }, "tryOutOfRange"],
      [{ ...base, try: 6 }, "tryOutOfRange"],
      [{ ...base, try: 2.5 }, "tryOutOfRange"],
      [{ ...base, notBefore: "tomorrow" }, "timeNotUtc"],
      [{ ...base, firstTriedAt: "2026-10-23 14:30" }, "timeNotUtc"],
      [{ ...base, lastError: "Riley said the calendar is down" }, "lastErrorNotLabel"],
      [{ ...base, lastError: "calendar503" }, "lastErrorNotLabel"],
    ];

    for (const [body, problem] of bodies) {
      expect(readRetryMessage(body)).toEqual({ problem });
    }
    const ids = bodies.map(() => messageId());
    const { batch, result, retries } = batchOf(
      bodies.map(([body], index) => ({ id: ids[index] ?? "", body })),
      clock.now(),
    );
    const report = await consumeRetries(batch, { queue: null, log: LOG, deps, now: clock.now });

    expect(report.reports.map((entry) => [entry.outcome, entry.errorCode])).toEqual(
      bodies.map(([, problem]) => ["badMessage", problem]),
    );
    expect((await result()).retryMessages.map((retry) => retry.msgId)).toEqual(ids);
    expect(retries.map((retry) => retry.delaySeconds)).toEqual(bodies.map(() => undefined));
    expect(poll.calls).toEqual([]);
    expect(leaks(lines.join("\n"))).toEqual([]);
    expect(readRetryMessage(base)).toEqual({ message: base });
  });
});

/** Delivers what the double queue holds as each message comes due, until it is empty. */
async function pump(queue: FakeQueue, clock: Clock, deps: QueueDeps): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    const next = queue.nextDueAt();
    if (next === null) return;
    if (next > clock.now()) clock.to(next);
    for (const sent of queue.due(clock.now())) {
      const { batch } = batchOf([{ id: messageId(), body: sent.message }], clock.now());
      await consumeRetries(batch, { queue, log: LOG, deps, now: clock.now });
    }
  }
  throw new Error("the queue never emptied");
}
