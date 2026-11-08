// One try of a job and what follows it (T-256; C-056), shared by the consumer (./consumer.ts) and a job's first try
// (./producer.ts `runJob`).
//
// `runTry` runs one try: the dispatcher's send door for a send retry, the kind's runner for any other job. It never
// throws: a throw, an answer off the shape or a kind with no runner is a failed try, named by its error label.
//
// `handOn` hands on what follows a failed try, and settles the ledger with it:
//   - a job's fifth try (JOB_TRIES): one K-37 dead-letter row with the last error (the store answers repeated for a row
//     written before, which counts as written);
//   - a send at the guard (SEND_TRIES_GUARD): nothing more, never a dead letter (sends follow step 8);
//   - otherwise the next try, on the retry queue, after any Retry-After or the spacing.
// When it cannot (no queue bound, the queue or the store failing), the ledger keeps the failed try, so the next delivery
// hands it on without running the try again.

import { deadLetterRowOf } from "./dead-letter";
import {
  codeLabelOf,
  errorLabelOf,
  HAND_OFF_DELAY_S,
  JOB_TRIES,
  nextMessageOf,
  retryAfterOf,
  secondsUntil,
  SEND_TRIES_GUARD,
} from "./message";
import {
  SEND_KIND,
  type DeadLetterRow,
  type FailedTry,
  type JobLedger,
  type JobTry,
  type LedgerSettle,
  type QueueDeps,
  type RetryJob,
  type RetryMessage,
  type RetryQueue,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How one try ended. */
export type TryResult = { done: true } | { done: false; failed: FailedTry };

/** Runs try `tryNo` of the job. Never throws. */
export async function runTry(
  set: QueueDeps,
  job: RetryJob,
  tryNo: number,
  firstTriedAt: string,
  now: () => number,
): Promise<TryResult> {
  // The runner gets its own copy, so the body a dead letter keeps is the one enqueued.
  const handed: JobTry = {
    key: job.key,
    kind: job.kind,
    businessId: job.businessId,
    traceId: job.traceId,
    body: structuredClone(job.body),
    try: tryNo,
    firstTriedAt,
  };
  const failed = (error: string, retryAfterSeconds: number | null): TryResult => ({
    done: false,
    failed: { at: now(), error, retryAfterSeconds },
  });

  if (job.kind === SEND_KIND) {
    let answer: unknown;
    try {
      answer = await set.sends.retrySend(handed);
    } catch (thrown) {
      return failed(errorLabelOf(thrown), null);
    }
    if (isRecord(answer) && answer.result === "done") return { done: true };
    if (isRecord(answer) && answer.result === "again") {
      return failed(codeLabelOf("SendFailed", answer.code), retryAfterOf(answer.retryAfterSeconds));
    }
    return failed("BadAnswer:sendDoor", null);
  }

  const runner = set.jobs.get(job.kind);
  if (runner === undefined) return failed(`NoRunner:${job.kind}`, null);
  let answer: unknown;
  try {
    answer = await runner(handed);
  } catch (thrown) {
    return failed(errorLabelOf(thrown), null);
  }
  if (isRecord(answer) && answer.result === "done") return { done: true };
  if (isRecord(answer) && answer.result === "failed") {
    return failed(codeLabelOf("JobFailed", answer.code), retryAfterOf(answer.retryAfterSeconds));
  }
  return failed("BadAnswer:jobRunner", null);
}

/** Settles the ledger; a ledger that fails here changes nothing already done (its later deliveries go by what it kept). */
export async function settleQuietly(
  ledger: JobLedger,
  jobKey: string,
  tryNo: number,
  settled: LedgerSettle,
  at: number,
): Promise<void> {
  try {
    await ledger.settle(jobKey, tryNo, settled, at);
  } catch {
    // Nothing to undo: the job's own writes are keyed by its job key.
  }
}

/** Puts a message on the retry queue after the seconds until its notBefore; the error code when it cannot. */
export async function sendNext(
  queue: RetryQueue | null,
  message: RetryMessage,
  now: number,
): Promise<{ delaySeconds: number } | { error: "noQueue" | "queueFailed" }> {
  if (queue === null) return { error: "noQueue" };
  const delaySeconds = secondsUntil(message.notBefore, now);
  try {
    await queue.send(message, { contentType: "json", delaySeconds });
  } catch {
    return { error: "queueFailed" };
  }
  return { delaySeconds };
}

export interface HandOnInput {
  set: QueueDeps;
  ledger: JobLedger;
  queue: RetryQueue | null;
  /** The queue the job came from, for its dead letter. */
  queueName: string;
  job: RetryJob;
  /** The try that failed. */
  tryNo: number;
  firstTriedAt: string;
  failed: FailedTry;
  now: () => number;
}

/** What `handOn` did. */
export type HandOn =
  | { handed: "queuedNext"; message: RetryMessage; delaySeconds: number }
  | { handed: "deadLetter"; row: DeadLetterRow; repeated: boolean }
  | { handed: "sendGivenUp" }
  /** Nothing was handed on: the message comes back after `retryInSeconds`, and the ledger keeps the failed try. */
  | { handed: null; errorCode: string; retryInSeconds: number };

/** Hands on what follows a failed try (the next try, the dead letter, or nothing for a send at the guard). */
export async function handOn(input: HandOnInput): Promise<HandOn> {
  const { job, ledger, tryNo, failed } = input;
  const keepFailed = async (errorCode: string): Promise<HandOn> => {
    await settleQuietly(ledger, job.key, tryNo, { state: "failed", failed }, input.now());
    return { handed: null, errorCode, retryInSeconds: HAND_OFF_DELAY_S };
  };

  if (job.kind !== SEND_KIND && tryNo >= JOB_TRIES) {
    const row = deadLetterRowOf({
      queue: input.queueName,
      job,
      tries: tryNo,
      firstTriedAt: input.firstTriedAt,
      failed,
      deadAt: input.now(),
    });
    let answer: unknown;
    try {
      answer = await input.set.deadLetters.put(row);
    } catch {
      answer = null;
    }
    if (!isRecord(answer) || (answer.result !== "written" && answer.result !== "repeated")) {
      return keepFailed("deadLetterNotWritten");
    }
    await settleQuietly(ledger, job.key, tryNo, { state: "dead" }, input.now());
    return { handed: "deadLetter", row, repeated: answer.result === "repeated" };
  }

  if (job.kind === SEND_KIND && tryNo >= SEND_TRIES_GUARD) {
    await settleQuietly(ledger, job.key, tryNo, { state: "done" }, input.now());
    return { handed: "sendGivenUp" };
  }

  const message = nextMessageOf(job, tryNo, input.firstTriedAt, failed);
  const sent = await sendNext(input.queue, message, input.now());
  if ("error" in sent) return keepFailed(sent.error);
  await settleQuietly(ledger, job.key, tryNo, { state: "waiting" }, input.now());
  return { handed: "queuedNext", message, delaySeconds: sent.delaySeconds };
}
