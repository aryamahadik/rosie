// The retry queue's producer (T-256; C-056): puts the next try of a job that failed on the RETRY_QUEUE binding, after any
// Retry-After (arch 10 line 540: "sends follow step 8, each try after any Retry-After"). Queues carry retries only, so a
// job's first try runs where the job starts:
//
//   - `enqueueRetry`: the caller made a try itself and it failed (the dispatcher's own send of a row, rate-limited with a
//     Retry-After); the next try goes on the queue, due after the Retry-After, else after the spacing (10 s for a send,
//     2 minutes for a job). The binding's delay holds it; the consumer runs nothing before its notBefore either.
//   - `runJob`: runs a job's first try where it starts (a sweep, a daily job) and hands a failure on the same way. The
//     ledger keys it by the job key, so the same job started twice runs once.
//
// The RETRY_QUEUE binding is the release engineer's (wrangler.jsonc, T-279; NQ-RT-5); env.staging repeats it since
// T-566. Where an environment has no copy, `retryQueueOf` gives null and nothing is enqueued (answered `noQueue`).

import { isolateJobs } from "./ledger";
import { isErrorLabel, isUtc, jobProblem, lastTryOf, nextMessageOf, retryAfterOf, utcOf } from "./message";
import { handOn, runTry, sendNext, settleQuietly } from "./run";
import {
  SEND_KIND,
  type FailedTry,
  type LedgerBegin,
  type QueueDeps,
  type RetryJob,
  type RetryMessage,
  type RetryQueue,
} from "./types";

declare global {
  namespace Cloudflare {
    interface Env {
      /** The retry queue's producer (wrangler.jsonc, T-279; env.staging repeats it since T-566). Missing where the environment has no copy. */
      RETRY_QUEUE?: Queue;
    }
  }
}

/** The RETRY_QUEUE binding as the producer and the consumer use it; null where the environment has none. */
export function retryQueueOf(env: Cloudflare.Env): RetryQueue | null {
  const queue = env.RETRY_QUEUE;
  if (queue === undefined) return null;
  return { send: (message, options) => queue.send(message, options) };
}

/** The failed try a caller hands on. */
export interface RetryAfter {
  /** The try that failed: 1 for the try made where the job started. */
  try: number;
  /** When the job's first try ran (UTC). */
  firstTriedAt: string;
  failed: FailedTry;
}

export type EnqueueAnswer =
  | { result: "queued"; message: RetryMessage; delaySeconds: number }
  /**
   * badJob: an id that is no label or a body that is no JSON object; badFailure: a try, time or error label that is
   * not one; noTriesLeft: the job's fifth try (a dead letter, which only the consumer writes) or the send guard;
   * noQueue: no binding here; queueFailed: the binding refused it.
   */
  | { error: "badJob" | "badFailure" | "noTriesLeft" | "noQueue" | "queueFailed" };

/** Within what JavaScript can turn into a date, with room for a 12-hour delay. */
const isInstantMs = (value: number): boolean => Number.isFinite(value) && Math.abs(value) < 8.6e15;

/** Puts the try after `after.try` on the retry queue, due after any Retry-After, else after the spacing. */
export async function enqueueRetry(
  queue: RetryQueue | null,
  job: RetryJob,
  after: RetryAfter,
  now: number,
): Promise<EnqueueAnswer> {
  if (jobProblem(job) !== null) return { error: "badJob" };
  const { failed } = after;
  if (
    !Number.isInteger(after.try) ||
    after.try < 1 ||
    !isUtc(after.firstTriedAt) ||
    !isErrorLabel(failed.error) ||
    !isInstantMs(failed.at)
  ) {
    return { error: "badFailure" };
  }
  if (after.try >= lastTryOf(job.kind)) return { error: "noTriesLeft" };
  const message = nextMessageOf(job, after.try, after.firstTriedAt, {
    at: failed.at,
    error: failed.error,
    retryAfterSeconds: retryAfterOf(failed.retryAfterSeconds),
  });
  const sent = await sendNext(queue, message, now);
  if ("error" in sent) return { error: sent.error };
  return { result: "queued", message, delaySeconds: sent.delaySeconds };
}

export interface RunJobOptions {
  /** The retry queue's producer (RETRY_QUEUE), which takes the next try; null where none is bound. */
  queue: RetryQueue | null;
  /** The queue a dead letter names (the retry queue's name). */
  queueName?: string;
  /** Epoch milliseconds; Date.now when left out. */
  now?: () => number;
}

export type RunJobReport =
  | { outcome: "done" }
  | { outcome: "queued"; message: RetryMessage; delaySeconds: number }
  /** The ledger has this job key started, running or finished already: nothing ran. */
  | { outcome: "duplicate" }
  /** Not run: the job cannot ride the queue (a label), a send (the dispatcher's own first try), or the ledger failed. */
  | { outcome: "refused"; errorCode: string }
  /** The try failed and its next try could not be put on the queue (noQueue, queueFailed); the ledger keeps it. */
  | { outcome: "notQueued"; errorCode: string };

/**
 * Runs a job's first try where it starts and hands a failure on to the retry queue. Never throws. A second start of the
 * same job key runs nothing; one whose first failure was not handed on hands it on now.
 */
export async function runJob(job: RetryJob, set: QueueDeps, options: RunJobOptions): Promise<RunJobReport> {
  const problem = jobProblem(job);
  if (problem !== null) return { outcome: "refused", errorCode: problem };
  if (job.kind === SEND_KIND) return { outcome: "refused", errorCode: "sendIsTheDispatchers" };
  const now = options.now ?? Date.now;
  const ledger = set.ledger ?? isolateJobs;
  const startedAt = now();

  let begun: LedgerBegin;
  try {
    begun = await ledger.begin(job.key, 1, startedAt);
  } catch {
    return { outcome: "refused", errorCode: "ledgerFailed" };
  }
  let firstTriedAt = utcOf(startedAt);
  let failed: FailedTry;
  if (begun.go) {
    const tried = await runTry(set, job, 1, firstTriedAt, now);
    if (tried.done) {
      await settleQuietly(ledger, job.key, 1, { state: "done" }, now());
      return { outcome: "done" };
    }
    failed = tried.failed;
  } else if (begun.why === "handOff") {
    // The first try failed before and was not handed on: hand it on now, without running it again.
    failed = begun.failed;
    firstTriedAt = utcOf(failed.at);
  } else {
    return { outcome: "duplicate" };
  }

  const handed = await handOn({
    set,
    ledger,
    queue: options.queue,
    queueName: options.queueName ?? "",
    job,
    tryNo: 1,
    firstTriedAt,
    failed,
    now,
  });
  if (handed.handed === "queuedNext") {
    return { outcome: "queued", message: handed.message, delaySeconds: handed.delaySeconds };
  }
  if (handed.handed === null) return { outcome: "notQueued", errorCode: handed.errorCode };
  // A first try is never a job's fifth or a send's last (a send is refused above): not reached.
  return { outcome: "notQueued", errorCode: handed.handed };
}
