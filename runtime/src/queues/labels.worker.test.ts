// What a try's error leaves behind (T-256; STATE note 3): a dead letter's last error and every log line hold the error's
// name and a label only, never a message's words, a phone number, a name or PostgresError.detail; and a body that is no
// retry message is never run. A refused write's SQLSTATE and constraint reach the label from postgres.js's PostgresError
// and from db/repo's scrubbed DataAccessDatabaseError and CommitTurnDatabaseError alike (T-1340). Run inside the Workers
// runtime with the runtime's own MessageBatch. Test values only (rule 9): the words and number below are made up, there
// to prove they never get out.
import type { DataAccessDatabaseError as RepoDataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { CommitTurnDatabaseError as RepoCommitTurnDatabaseError } from "@rosie/db/repo/commit-turn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeRetries,
  enqueueRetry,
  errorLabelOf,
  isErrorLabel,
  JobMemory,
  readRetryMessage,
  runJob,
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
  scriptedJob,
  scriptedSends,
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

/** The table's and the constraint's names as db/repo's two scrubbed errors put them in their message. */
const namesOf = (table: string | null, constraint: string | null): string =>
  `${table === null ? "" : `, table ${table}`}${constraint === null ? "" : `, constraint ${constraint}`}`;

/**
 * db/repo's scrubbed refusal (clocks.ts, T-1322), built as its constructor builds it: the call's name, the SQLSTATE and
 * the names of the table and constraint, each also in the message. `implements` holds its fields to the real class's;
 * the runtime imports no db/repo code, so neither does this test.
 */
class DataAccessDatabaseError extends Error implements RepoDataAccessDatabaseError {
  override readonly name = "DataAccessDatabaseError";
  readonly call: string;
  readonly code: string;
  readonly table: string | null;
  readonly constraint: string | null;

  constructor(call: string, code: string, table: string | null, constraint: string | null) {
    super(`${call}: the database refused the call (SQLSTATE ${code}${namesOf(table, constraint)})`);
    this.call = call;
    this.code = code;
    this.table = table;
    this.constraint = constraint;
  }
}

/** commitTurn's scrubbed refusal (commit-turn.ts), built as its constructor builds it, its fields held to the real class's. */
class CommitTurnDatabaseError extends Error implements RepoCommitTurnDatabaseError {
  override readonly name = "CommitTurnDatabaseError";
  readonly code: string;
  readonly table: string | null;
  readonly constraint: string | null;

  constructor(code: string, table: string | null, constraint: string | null) {
    super(`commitTurn: the database refused the commit (SQLSTATE ${code}${namesOf(table, constraint)})`);
    this.code = code;
    this.table = table;
    this.constraint = constraint;
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

  it("db/repo's scrubbed refusals leave their name, SQLSTATE and constraint as a PostgresError does, with or without a constraint", () => {
    const thrown: [unknown, string][] = [
      [
        new DataAccessDatabaseError("sendState", "23514", "outbox_rows", "outbox_rows_state_known"),
        "DataAccessDatabaseError:23514:outbox_rows_state_known",
      ],
      [new DataAccessDatabaseError("sendState", "22P02", null, null), "DataAccessDatabaseError:22P02"],
      [new DataAccessDatabaseError("handleTargets", "23503", "turns", null), "DataAccessDatabaseError:23503"],
      [
        new CommitTurnDatabaseError("23503", "outbox_rows", "outbox_rows_turn_fk"),
        "CommitTurnDatabaseError:23503:outbox_rows_turn_fk",
      ],
      [new CommitTurnDatabaseError("22P02", null, null), "CommitTurnDatabaseError:22P02"],
      [new CommitTurnDatabaseError("23514", "turns", null), "CommitTurnDatabaseError:23514"],
    ];
    for (const [value, label] of thrown) {
      expect(errorLabelOf(value)).toBe(label);
      expect(isErrorLabel(label)).toBe(true);
    }
  });

  it("a code that is no SQLSTATE gives threw, and a constraint that is no constraint's name is left out, for each as for a PostgresError", () => {
    const badCodes: unknown[] = [
      "555-0103",
      "UNDEFINED_VALUE",
      "2351",
      "235140",
      "22p02",
      " 23514",
      "23514\n",
      23514,
      null,
      undefined,
    ];
    const badConstraints: unknown[] = [
      "Riley's check",
      "outbox rows state known",
      "Outbox_rows_state_known",
      "outbox-rows-state-known",
      "9outbox_rows",
      "",
      "x".repeat(64),
      "riley@example.com",
      42,
      null,
      undefined,
      ["outbox_rows_state_known"],
    ];
    // Each name's error, and the field that name keeps its constraint's name in.
    const refusals: [string, string, () => Error][] = [
      ["PostgresError", "constraint_name", () => new PostgresError()],
      [
        "DataAccessDatabaseError",
        "constraint",
        () => new DataAccessDatabaseError("sendState", "23514", "outbox_rows", null),
      ],
      [
        "CommitTurnDatabaseError",
        "constraint",
        () => new CommitTurnDatabaseError("23514", "outbox_rows", null),
      ],
    ];
    for (const [name, field, make] of refusals) {
      const labelWith = (code: unknown, constraint: unknown): string =>
        errorLabelOf(Object.assign(make(), { code, [field]: constraint }));
      for (const code of badCodes) {
        expect(labelWith(code, "outbox_rows_state_known")).toBe(`${name}:threw`);
      }
      for (const constraint of badConstraints) {
        expect(labelWith("23514", constraint)).toBe(`${name}:23514`);
      }
      expect(labelWith("23514", "outbox_rows_state_known")).toBe(`${name}:23514:outbox_rows_state_known`);
    }
  });

  it("a PostgresError reads only postgres.js's constraint_name, db/repo's errors only their constraint; any other error leaves threw", () => {
    const thrown: [unknown, string][] = [
      [new PostgresError(), "PostgresError:23514:dead_letters_after_five_tries"],
      [
        Object.assign(new PostgresError(), {
          constraint_name: undefined,
          constraint: "outbox_rows_state_known",
        }),
        "PostgresError:23514",
      ],
      [
        Object.assign(new DataAccessDatabaseError("sendState", "23514", null, null), {
          constraint_name: "outbox_rows_state_known",
        }),
        "DataAccessDatabaseError:23514",
      ],
      [
        Object.assign(new CommitTurnDatabaseError("23514", null, null), {
          constraint_name: "outbox_rows_state_known",
        }),
        "CommitTurnDatabaseError:23514",
      ],
      // clocks.ts scrubbed()'s client error (UNDEFINED_VALUE, a serialize TypeError): an Error with the call and code.
      [
        Object.assign(new Error("sendState: the database call failed (code UNDEFINED_VALUE)"), {
          call: "sendState",
          code: "UNDEFINED_VALUE",
        }),
        "Error:threw",
      ],
      [
        Object.assign(new Error("x"), { code: "23514", constraint: "outbox_rows_state_known" }),
        "Error:threw",
      ],
      [
        Object.assign(new TypeError("x"), { code: "22P02", constraint_name: "turns_state_known" }),
        "TypeError:threw",
      ],
      [
        Object.assign(new Error("x"), {
          name: "DataAccessError",
          code: "23514",
          constraint: "turns_state_known",
        }),
        "DataAccessError:threw",
      ],
    ];
    for (const [value, label] of thrown) {
      expect(errorLabelOf(value)).toBe(label);
      expect(isErrorLabel(label)).toBe(true);
    }
  });

  it("nothing but the name, SQLSTATE and constraint reaches the label: a value planted in the message, call, table or any other field never does", () => {
    const call = "riley_5555550103_call";
    const table = "riley_5555550103_table";
    const planted = {
      message: `${call}: Riley at +15555550103 said pick me up (table ${table})`,
      detail: "Failing row contains (Riley, +15555550103, pick me up at 9)",
      where: "riley@example.com",
      query: "update outbox_rows set state = $1 where id = $2",
      args: ["riley_5555550103_arg", "+15555550103"],
      constraint_name: "riley_5555550103_constraint_name",
      cause: new Error("Riley +15555550103"),
    };
    const words = [
      call,
      table,
      planted.constraint_name,
      "riley_5555550103_arg",
      "outbox_rows set",
      ...PRIVATE,
    ];
    const thrown: [unknown, string][] = [
      [
        Object.assign(new DataAccessDatabaseError(call, "23514", table, "outbox_rows_state_known"), planted),
        "DataAccessDatabaseError:23514:outbox_rows_state_known",
      ],
      [
        Object.assign(new DataAccessDatabaseError(call, "23514", table, null), planted),
        "DataAccessDatabaseError:23514",
      ],
      [
        Object.assign(new CommitTurnDatabaseError("23514", table, "turns_state_known"), { ...planted, call }),
        "CommitTurnDatabaseError:23514:turns_state_known",
      ],
      [
        Object.assign(new CommitTurnDatabaseError("23514", table, null), { ...planted, call }),
        "CommitTurnDatabaseError:23514",
      ],
    ];
    for (const [value, label] of thrown) {
      const left = errorLabelOf(value);
      expect(left).toBe(label);
      expect(words.filter((word) => left.includes(word))).toEqual([]);
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

  it("a send whose door throws sendState's scrubbed refusal (T-1322) leaves only its name, SQLSTATE and constraint in the next message and the logs", async () => {
    const refusal = Object.assign(
      new DataAccessDatabaseError("sendState", "23514", "outbox_rows", "outbox_rows_state_known"),
      { detail: "Failing row contains (Riley, +15555550103, pick me up at 9)", where: "riley@example.com" },
    );
    const sends = scriptedSends([{ throw: refusal }, "done"]);
    const clock = fakeClock("2026-11-07T19:00:05Z");
    const queue = fakeQueue(clock);
    const deps = depsOf({ sends: sends.run });

    const queued = await enqueueRetry(
      queue,
      averySend(),
      {
        try: 1,
        firstTriedAt: "2026-11-07T19:00:04Z",
        failed: { at: clock.now(), error: "SendFailed:rateLimited", retryAfterSeconds: null },
      },
      clock.now(),
    );
    await pump(queue, clock, deps);

    expect(queued).toMatchObject({ result: "queued" });
    expect(sends.calls.map((call) => call.try)).toEqual([2, 3]);
    expect(queue.sent.map((sent) => sent.message.lastError)).toEqual([
      "SendFailed:rateLimited",
      "DataAccessDatabaseError:23514:outbox_rows_state_known",
    ]);
    expect(lines.map((line) => (JSON.parse(line) as { error_code: unknown }).error_code)).toEqual([
      "DataAccessDatabaseError:23514:outbox_rows_state_known",
      null,
    ]);
    expect(leaks(JSON.stringify(queue.sent))).toEqual([]);
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
      [
        { ...base, job: { ...base.job, body: { personId: "Riley M.", phone: "+15555550103" } } },
        "bodyNotIds",
      ],
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
