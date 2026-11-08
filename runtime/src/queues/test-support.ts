// Doubles for the retry queue's tests (T-256). Not imported by the Worker. The batches the consumer gets are the Workers
// runtime's own (`createMessageBatch` from cloudflare:test, read back with `getQueueResult`); the rest are doubles:
//
//   - the RETRY_QUEUE producer binding (env.staging has none until T-566): it keeps each message with its delay and when
//     it was sent, and `due` gives the messages the queue would deliver by a given time, as Cloudflare Queues hold a
//     message for its delaySeconds;
//   - K-37's dead_letters insert: one row per id, a second insert of the same id answers repeated (its primary key);
//   - a job runner and the dispatcher's send door that answer from a script;
//   - a fake clock.
//
// Test values only (rule 9): the job is K-37's seed-dead-letter.json calendar poll at Lee's Barbershop; the send retry is
// K-07's outbox-retry-after-reclaimed.json row (Avery's new-booking text, refused with a 429), by its ids only.

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  type QueueResult,
} from "cloudflare:test";

import seedDeadLetter from "../../../contracts/db-schema/platform-review/fixtures/seed-dead-letter.json";
import { JobMemory } from "./ledger";
import type {
  DeadLetterAnswer,
  DeadLetterRow,
  DeadLetterStore,
  JobAnswer,
  JobLedger,
  JobRunner,
  JobTry,
  QueueDeps,
  RetryJob,
  RetryMessage,
  RetryQueue,
  RetrySendOptions,
  SendAnswer,
  SendDoor,
} from "./types";

export const QUEUE_NAME = "rosie-retry";
export const LOG = { environment: "staging", version: "test-sha" };

/** K-37's seed dead letter for Riley's calendar poll: the row a job like it leaves after its fifth try. */
export const SEED_CALENDAR_POLL = seedDeadLetter.rows[1]?.values as unknown as Record<string, unknown>;

/** The calendar poll as a job (seed-dead-letter.json's second row: its kind, id, message, business and trace). */
export function calendarPoll(key = String(SEED_CALENDAR_POLL.job_id)): RetryJob {
  return {
    key,
    kind: String(SEED_CALENDAR_POLL.job_kind),
    businessId: String(SEED_CALENDAR_POLL.business_id),
    traceId: String(SEED_CALENDAR_POLL.trace_id),
    body: structuredClone(SEED_CALENDAR_POLL.message_body) as Record<string, unknown>,
  };
}

/** A send retry for Avery's new-booking row after its try 1 (out-avery-new-booking-alex/1/1) was refused. */
export function averySend(failedKey = "out-avery-new-booking-alex/1/1"): RetryJob {
  return {
    key: `retry-${failedKey}`,
    kind: "send",
    businessId: "biz-lees-barbershop",
    traceId: "trace-alex-0120",
    body: { outboxRowId: "out-avery-new-booking-alex", recipientHandleId: "handle-avery", failedKey },
  };
}

/** A fake clock in epoch milliseconds. */
export interface Clock {
  now: () => number;
  /** Sets it to a UTC instant. */
  set(utc: string): void;
  /** Sets it to epoch milliseconds. */
  to(ms: number): void;
  advance(ms: number): void;
}

export function fakeClock(utc: string): Clock {
  let at = Date.parse(utc);
  return {
    now: () => at,
    set: (next) => {
      at = Date.parse(next);
    },
    to: (ms) => {
      at = ms;
    },
    advance: (ms) => {
      at += ms;
    },
  };
}

/** One message the binding took. */
export interface Sent {
  message: RetryMessage;
  options: RetrySendOptions;
  /** When it was sent (epoch milliseconds, the fake clock's). */
  sentAt: number;
  /** When the queue would deliver it: sent plus its delay. */
  dueAt: number;
}

export interface FakeQueue extends RetryQueue {
  readonly sent: Sent[];
  /** The next `count` sends throw. */
  failNext(count: number): void;
  /** Takes the messages due by `at` off the queue, in the order sent. */
  due(at: number): Sent[];
  /** When the earliest message still on the queue comes due, or null when none is left. */
  nextDueAt(): number | null;
  /** Messages still on the queue. */
  readonly waiting: number;
}

export function fakeQueue(clock: Clock): FakeQueue {
  const sent: Sent[] = [];
  let pending: Sent[] = [];
  let failures = 0;
  return {
    sent,
    get waiting() {
      return pending.length;
    },
    failNext: (count) => {
      failures = count;
    },
    send: (message, options) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("the queue refused it"));
      }
      // As the binding does: the message goes as JSON, so what is delivered is a copy.
      const copy = JSON.parse(JSON.stringify(message)) as RetryMessage;
      const at = clock.now();
      const entry: Sent = {
        message: copy,
        options: { ...options },
        sentAt: at,
        dueAt: at + options.delaySeconds * 1000,
      };
      sent.push(entry);
      pending.push(entry);
      return Promise.resolve({ metadata: { metrics: { backlogCount: pending.length, backlogBytes: 0 } } });
    },
    due: (at) => {
      const ready = pending.filter((entry) => entry.dueAt <= at);
      pending = pending.filter((entry) => entry.dueAt > at);
      return ready;
    },
    nextDueAt: () => (pending.length === 0 ? null : Math.min(...pending.map((entry) => entry.dueAt))),
  };
}

export interface FakeDeadLetters extends DeadLetterStore {
  readonly rows: DeadLetterRow[];
  /** Every insert asked for, a repeated one included. */
  readonly puts: DeadLetterRow[];
  failNext(count: number): void;
}

export function fakeDeadLetters(): FakeDeadLetters {
  const rows: DeadLetterRow[] = [];
  const puts: DeadLetterRow[] = [];
  let failures = 0;
  return {
    rows,
    puts,
    failNext: (count) => {
      failures = count;
    },
    put: (row) => {
      puts.push(structuredClone(row));
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("the database is down"));
      }
      const answer: DeadLetterAnswer = rows.some((kept) => kept.id === row.id)
        ? { result: "repeated" }
        : { result: "written" };
      if (answer.result === "written") rows.push(structuredClone(row));
      return Promise.resolve(answer);
    },
  };
}

/** What a scripted try does: succeed, fail with a code (and any Retry-After), or throw this error. */
export type Step = "done" | { fail: string; retryAfterSeconds?: number | null } | { throw: Error };

export interface Scripted<T> {
  readonly calls: JobTry[];
  readonly run: T;
}

function stepOf(script: readonly Step[], index: number): Step {
  return script[Math.min(index, script.length - 1)] ?? "done";
}

/** The first item, which the test expects to be there. */
export function firstOf<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

/** A job runner that answers from the script, one step per call (the last step repeats). */
export function scriptedJob(script: readonly Step[]): Scripted<JobRunner> {
  const calls: JobTry[] = [];
  const run: JobRunner = (job) => {
    calls.push(structuredClone(job));
    const step = stepOf(script, calls.length - 1);
    if (step === "done") return Promise.resolve({ result: "done" });
    if ("throw" in step) return Promise.reject(step.throw);
    const answer: JobAnswer = {
      result: "failed",
      code: step.fail,
      retryAfterSeconds: step.retryAfterSeconds ?? null,
    };
    return Promise.resolve(answer);
  };
  return { calls, run };
}

/** The dispatcher's send door answering from the script: a failure is "again" with its code and Retry-After. */
export function scriptedSends(script: readonly Step[]): Scripted<SendDoor> {
  const calls: JobTry[] = [];
  const run: SendDoor = {
    retrySend: (send) => {
      calls.push(structuredClone(send));
      const step = stepOf(script, calls.length - 1);
      if (step === "done") return Promise.resolve({ result: "done" });
      if ("throw" in step) return Promise.reject(step.throw);
      const answer: SendAnswer = {
        result: "again",
        code: step.fail,
        retryAfterSeconds: step.retryAfterSeconds ?? null,
      };
      return Promise.resolve(answer);
    },
  };
  return { calls, run };
}

/** The ports, each test with its own ledger (the isolate's would carry one test's jobs into the next). */
export function depsOf(parts: {
  sends?: SendDoor;
  jobs?: Record<string, JobRunner>;
  deadLetters?: DeadLetterStore;
  ledger?: JobLedger;
}): QueueDeps {
  return {
    sends: parts.sends ?? scriptedSends(["done"]).run,
    jobs: new Map(Object.entries(parts.jobs ?? {})),
    deadLetters: parts.deadLetters ?? fakeDeadLetters(),
    ledger: parts.ledger ?? new JobMemory(),
  };
}

let messageNo = 0;

/** A message id like the queue's: hex, unique in a test run. */
export function messageId(): string {
  messageNo += 1;
  return `0f${messageNo.toString(16).padStart(30, "0")}`;
}

/** A retry a message was given, with the delay asked for (the runtime's own result does not keep the delay). */
export interface Retried {
  msgId: string;
  delaySeconds: number | undefined;
}

/**
 * A batch of the retry queue, as the Workers runtime builds it, with the context its result is read through. Each
 * message's `retry` still goes to the runtime's own; `retries` also keeps the delay each one was asked for.
 */
export function batchOf(
  messages: readonly { id: string; body: unknown; attempts?: number }[],
  at: number,
): { batch: MessageBatch; result: () => Promise<QueueResult>; retries: Retried[] } {
  const batch = createMessageBatch(
    QUEUE_NAME,
    messages.map((message) => ({
      id: message.id,
      timestamp: at,
      attempts: message.attempts ?? 1,
      body: message.body,
    })),
  );
  const retries: Retried[] = [];
  for (const message of batch.messages) {
    const retry = message.retry.bind(message);
    Object.defineProperty(message, "retry", {
      value: (options?: QueueRetryOptions) => {
        retries.push({ msgId: message.id, delaySeconds: options?.delaySeconds });
        retry(options);
      },
    });
  }
  const context = createExecutionContext();
  return { batch, result: () => getQueueResult(batch, context), retries };
}
