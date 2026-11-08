// The retry queue's consumer (T-256; C-056; arch 10 line 540): the Worker's queue handler for the retry queue
// (runtime/src/index.ts). Each message is one try of one job, and each is acked or retried on its own:
//
//   1. A body that is no retry message (./message.ts) is never run: it is retried until the queue's own dead-letter queue
//      takes it (wrangler.jsonc: max_retries 5, then rosie-retry-dlq; T-279).
//   2. A try that is not due (before its notBefore: a Retry-After, or the spacing) is not run and counts no try: the
//      message comes back when it is due. So a send retry with Retry-After 30 is never tried before 30 s.
//   3. The ledger, by job key (./ledger.ts): a job already finished, or a try already begun, runs nothing, so a message
//      the queue delivers twice runs its job once. A try begun and still running comes back after the run's lapse (15
//      minutes); once lapsed, the try counts as failed (`Lapsed:noAnswer`) and what follows it is handed on.
//   4. The try runs (./run.ts `runTry`): the dispatcher's send door for a send, the kind's runner for a job.
//   5. Done: acked. Failed (./run.ts `handOn`): the next try goes on the queue after any Retry-After, else after the
//      spacing; a job's fifth failure becomes one K-37 dead-letter row with its last error instead; a send never does
//      (step 8 ends it: the dispatcher answers done). Then the message is acked. A next step that cannot be handed on (no
//      queue bound, the queue or the store failing) brings the message back after a minute; the ledger keeps the failed
//      try, so that delivery hands it on without running the try again.
//
// Never throws. One JSON log line per message (ADR-009): the job's trace id, ids, counts and labels only; never a job's
// body, a message's words, a number, or an error's message or detail (STATE note 3).

import { isLabel, type LogContext } from "../trace";
import { isolateJobs } from "./ledger";
import { HAND_OFF_DELAY_S, MAX_DELAY_S, readRetryMessage, RUN_LAPSE_MS, secondsUntil } from "./message";
import { retryQueueOf } from "./producer";
import { handOn, runTry, settleQuietly } from "./run";
import type { FailedTry, LedgerBegin, QueueDeps, RetryQueue } from "./types";

let deps: QueueDeps | null = null;

/** Sets the retry queue's ports for this Worker isolate; returns the function that puts the earlier ones back. */
export function setQueueDeps(next: QueueDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** The retry queue's ports for this isolate, or null before D-017 joins them (nothing runs: every message comes back). */
export function queueDeps(): QueueDeps | null {
  return deps;
}

export interface ConsumeOptions {
  /** The retry queue's producer (the RETRY_QUEUE binding), which takes each next try; null where none is bound. */
  queue: RetryQueue | null;
  log: LogContext;
  /** The ports; this isolate's (`setQueueDeps`) when left out. */
  deps?: QueueDeps | null;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
}

/** How one message was handled. */
export type MessageOutcome =
  /** The try succeeded (a send: the dispatcher has nothing more for the queue): acked. */
  | "done"
  /** The try failed and the next try is on the queue: acked. */
  | "queuedNext"
  /** A job's fifth try failed and its dead-letter row is written: acked. */
  | "deadLetter"
  /** A send reached the guard: acked, no dead letter. */
  | "sendGivenUp"
  /** Not due yet: retried for the seconds left. */
  | "early"
  /** The job is finished or this try began before: acked, nothing run. */
  | "duplicate"
  /** This try is running in another delivery: retried after the run's lapse. */
  | "running"
  /** What follows the failed try could not be handed on: retried after a minute. */
  | "handOffFailed"
  /** Not a retry message: retried toward the queue's own dead-letter queue. */
  | "badMessage"
  /** No ports joined (D-017): retried after a minute. */
  | "unwired"
  /** The ledger could not be read: retried after a minute. */
  | "ledgerFailed"
  /** Something here broke: retried after a minute. */
  | "consumerFailed";

export interface MessageReport {
  messageId: string;
  outcome: MessageOutcome;
  jobKey: string | null;
  jobKind: string | null;
  traceId: string | null;
  try: number | null;
  /** The failed try's error label, or why the message could not be handled (a label); null when nothing failed. */
  errorCode: string | null;
  /** The delay the message was retried with; null when it was acked. */
  retryInSeconds: number | null;
}

export interface BatchReport {
  queue: string;
  reports: MessageReport[];
}

/** Outcomes that log at warn: something did not go as it should. */
const WARN: ReadonlySet<MessageOutcome> = new Set<MessageOutcome>([
  "deadLetter",
  "sendGivenUp",
  "handOffFailed",
  "badMessage",
  "unwired",
  "ledgerFailed",
  "consumerFailed",
]);

/** Handles one batch of the retry queue, message by message. Never throws. */
export async function consumeRetries(batch: MessageBatch, options: ConsumeOptions): Promise<BatchReport> {
  const set = options.deps === undefined ? deps : options.deps;
  const reports: MessageReport[] = [];
  for (const message of batch.messages) {
    let report: MessageReport;
    try {
      report = await handleMessage(message, batch.queue, set, options);
    } catch {
      report = {
        messageId: message.id,
        outcome: "consumerFailed",
        jobKey: null,
        jobKind: null,
        traceId: null,
        try: null,
        errorCode: "consumerFailed",
        retryInSeconds: HAND_OFF_DELAY_S,
      };
      retryQuietly(message, HAND_OFF_DELAY_S);
    }
    logReport(options.log, report);
    reports.push(report);
  }
  return { queue: batch.queue, reports };
}

/** The Worker's queue handler (runtime/src/index.ts): the batch with the RETRY_QUEUE binding and this isolate's ports. */
export async function retryQueueHandler(batch: MessageBatch, env: Cloudflare.Env): Promise<void> {
  await consumeRetries(batch, {
    queue: retryQueueOf(env),
    log: { environment: env.ENVIRONMENT, version: env.GIT_SHA ?? "unknown" },
  });
}

function retryQuietly(message: Message, delaySeconds: number): void {
  try {
    message.retry({ delaySeconds });
  } catch {
    // The batch's own retry stands: an unacked message comes back.
  }
}

async function handleMessage(
  message: Message,
  queueName: string,
  set: QueueDeps | null,
  options: ConsumeOptions,
): Promise<MessageReport> {
  const now = options.now ?? Date.now;
  const read = readRetryMessage(message.body);
  if ("problem" in read) {
    message.retry();
    return {
      messageId: message.id,
      outcome: "badMessage",
      jobKey: null,
      jobKind: null,
      traceId: null,
      try: null,
      errorCode: read.problem,
      retryInSeconds: 0,
    };
  }
  const carried = read.message;
  const { job } = carried;
  const tryNo = carried.try;
  const report = (
    outcome: MessageOutcome,
    errorCode: string | null,
    retryInSeconds: number | null = null,
  ): MessageReport => {
    if (retryInSeconds === null) message.ack();
    else message.retry({ delaySeconds: retryInSeconds });
    return {
      messageId: message.id,
      outcome,
      jobKey: job.key,
      jobKind: job.kind,
      traceId: job.traceId,
      try: tryNo,
      errorCode,
      retryInSeconds,
    };
  };

  if (set === null) return report("unwired", "unwired", HAND_OFF_DELAY_S);
  const at = now();
  const wait = secondsUntil(carried.notBefore, at);
  if (wait > 0) return report("early", null, wait);

  const ledger = set.ledger ?? isolateJobs;
  let begun: LedgerBegin;
  try {
    begun = await ledger.begin(job.key, tryNo, at);
  } catch {
    return report("ledgerFailed", "ledgerFailed", HAND_OFF_DELAY_S);
  }

  let failed: FailedTry;
  if (begun.go) {
    const tried = await runTry(set, job, tryNo, carried.firstTriedAt, now);
    if (tried.done) {
      await settleQuietly(ledger, job.key, tryNo, { state: "done" }, now());
      return report("done", null);
    }
    failed = tried.failed;
  } else if (begun.why === "handOff") {
    failed = begun.failed;
  } else if (begun.why === "running") {
    const lapsesAt = begun.since + RUN_LAPSE_MS;
    if (at < lapsesAt) {
      return report("running", null, Math.min(MAX_DELAY_S, Math.max(1, Math.ceil((lapsesAt - at) / 1000))));
    }
    // The delivery that began this try died before it ended: the try counts as failed.
    failed = { at: begun.since, error: "Lapsed:noAnswer", retryAfterSeconds: null };
  } else {
    return report("duplicate", null);
  }

  const handed = await handOn({
    set,
    ledger,
    queue: options.queue,
    queueName,
    job,
    tryNo,
    firstTriedAt: carried.firstTriedAt,
    failed,
    now,
  });
  if (handed.handed === null) return report("handOffFailed", handed.errorCode, handed.retryInSeconds);
  return report(handed.handed, failed.error);
}

/** One JSON log line for a handled message: labels, ids and counts only (ADR-009). */
function logReport(log: LogContext, report: MessageReport): void {
  const label = (value: string | null): string | null => (isLabel(value) ? value : null);
  try {
    console.log(
      JSON.stringify({
        level: WARN.has(report.outcome) ? "warn" : "info",
        msg: "retryQueue",
        trace_id: label(report.traceId) ?? crypto.randomUUID(),
        job_id: label(report.jobKey),
        job_kind: label(report.jobKind),
        try: report.try,
        message_id: label(report.messageId),
        outcome: report.outcome,
        error_code: label(report.errorCode),
        retry_in_s: report.retryInSeconds,
        environment: log.environment,
        version: log.version,
      }),
    );
  } catch {
    // No line; the report says it.
  }
}
