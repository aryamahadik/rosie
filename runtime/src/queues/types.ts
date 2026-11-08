// The retry queue's shapes and ports (T-256; C-056; C-035; arch 10 'Clocks and queues', architecture.txt line 540:
// "Queues carry retries only: sends follow step 8, each try after any Retry-After; other jobs get 5 tries, then a
// dead-letter queue in the team console (DD)"). No contract names a queue message, so the runtime owns this format; the
// dead-letter row is K-37 v1's (contracts/db-schema/platform-review, table dead_letters). Written by hand: the generated
// types are git-ignored (ADR-005) and the Worker must not depend on them.
//
// The ports, each joined by D-017 (`setQueueDeps`), with doubles in the tests:
//   - the retry queue's producer: the RETRY_QUEUE binding (wrangler.jsonc, T-279; the Queues bindings are the release
//     engineer's, NQ-RT-5), as `RetryQueue`;
//   - the dispatcher's door for a send retry (`SendDoor`): step 8 and K-07 v1's retry rules stay the dispatcher's;
//   - each job kind's runner (`JobRunner`);
//   - the K-37 v1 dead_letters writer (`DeadLetterStore`), on the runtime side, unscoped (K-37 rule 2);
//   - the job ledger (`JobLedger`): which try of each job key has begun and how it ended (this isolate's memory unless
//     D-017 joins a lasting one: ./ledger.ts).

/** The job kind of a send retry. Every other kind is a job: 5 tries in all, then a dead-letter row. */
export const SEND_KIND = "send";

/** A job's message: ids and references only, never a private value (K-37 rule 4: "jobs carry ids, not values"). */
export type JobBody = Readonly<Record<string, unknown>>;

/** A job as the retry queue carries it: the same on every try. */
export interface RetryJob {
  /**
   * The job's key, the same on every try: the id its event-log entries carry (K-04 event_log.job_id; K-37
   * dead_letters.job_id). A label. A send retry's key names the try that failed (its part's key), so each failure of a
   * row starts its own retry.
   */
  key: string;
  /** "send" for a send retry, else the job's kind (K-37 dead_letters.job_kind: reconciliation, calendar_poll ...). A label. */
  kind: string;
  /** The business the job is for, or null for a job across businesses (K-37 dead_letters.business_id). */
  businessId: string | null;
  /** The job's trace id, kept from its start (K-37 dead_letters.trace_id; arch 10 line 548). A label. */
  traceId: string;
  /** The job's own message (K-37 dead_letters.message_body: "as it was enqueued, so the team can replay it"). */
  body: JobBody;
}

/** One queue message: one try of a job (version 1 of the runtime's own format). */
export interface RetryMessage {
  v: 1;
  job: RetryJob;
  /** The try this message carries: from 2, since the first try ran where the job started (queues carry retries only). */
  try: number;
  /** When the job's first try ran (UTC). */
  firstTriedAt: string;
  /** Not tried before this instant (UTC): after the provider's Retry-After when it gave one, else after the spacing. */
  notBefore: string;
  /** The last try's error: its name and a label, such as `TypeError:threw`; never a message's words (STATE note 3). */
  lastError: string;
}

/** What the producer and the consumer hand the RETRY_QUEUE binding: one message, as JSON, after a delay. */
export interface RetrySendOptions {
  contentType: "json";
  delaySeconds: number;
}

/** The retry queue's producer as the runtime uses it: the RETRY_QUEUE binding's `send`. */
export interface RetryQueue {
  send(message: RetryMessage, options: RetrySendOptions): Promise<unknown>;
}

/** One try of a job, as its runner or the send door is handed it. */
export interface JobTry {
  key: string;
  kind: string;
  businessId: string | null;
  traceId: string;
  body: JobBody;
  /** This try's number: 1 where the job started, then 2 and on from the queue. */
  try: number;
  /** When the job's first try ran (UTC). */
  firstTriedAt: string;
}

/** How a job's try ended, as its runner answers. */
export type JobAnswer =
  | { result: "done" }
  /** `code` names the failure (a label, never a provider's message); any Retry-After the job was given, in seconds. */
  | { result: "failed"; code: string; retryAfterSeconds?: number | null };

/** Runs one try of a job of one kind. It may throw: the throw counts as a failed try, named by the error's name only. */
export type JobRunner = (job: JobTry) => Promise<JobAnswer>;

/** How a send retry's try ended, as the dispatcher answers. */
export type SendAnswer =
  /** Nothing more for the queue: the row went, or it is finished, held, dropped or failed with its next way taken. */
  | { result: "done" }
  /** The row's next try must wait: after the provider's Retry-After when it gave one. `code` names why (a label). */
  | { result: "again"; code: string; retryAfterSeconds: number | null };

/**
 * The dispatcher's door for a send retry (D-017 joins it to the dispatcher for the row named in the job's body). It sends
 * under K-07 v1's retry rules and step 8's 15 minutes, and never puts a retry on the queue itself: the consumer does.
 */
export interface SendDoor {
  retrySend(send: JobTry): Promise<SendAnswer>;
}

/** A K-37 v1 dead_letters row as the runtime writes it: the table's columns (seed-dead-letter.json's), open. */
export interface DeadLetterRow {
  id: string;
  queue: string;
  job_kind: string;
  job_id: string;
  message_body: JobBody;
  tries: number;
  first_tried_at: string;
  last_tried_at: string;
  last_error: string;
  business_id: string | null;
  trace_id: string;
  dead_at: string;
  state: "open";
  version: 1;
}

/** The dead-letter store's answer: written, or the same id was written before (nothing written), or why not (a label). */
export type DeadLetterAnswer = { result: "written" } | { result: "repeated" } | { error: string };

/** Writes K-37 v1 dead_letters rows on the runtime side (unscoped: K-37 rule 2), as a K-37 row insert. */
export interface DeadLetterStore {
  /** Inserts the row; the same id again answers repeated and writes nothing (the table's primary key). */
  put(row: DeadLetterRow): Promise<DeadLetterAnswer>;
}

/** A try that failed: when it ended, its error (name and label) and any Retry-After in seconds. */
export interface FailedTry {
  /** Epoch milliseconds. */
  at: number;
  error: string;
  retryAfterSeconds: number | null;
}

/** What the ledger says of a try that is about to run. */
export type LedgerBegin =
  /** Run it: the job is not finished and no delivery began this try or a later one. */
  | { go: true }
  /** The job is finished (done or dead), or this try or a later one began before: a message delivered again. */
  | { go: false; why: "finished" | "seen" }
  /** This try began at `since` (epoch milliseconds) and has not ended: running now, or its run died. */
  | { go: false; why: "running"; since: number }
  /** This try ran and failed, and what follows it (the next try, or the dead letter) was not handed on yet. */
  | { go: false; why: "handOff"; failed: FailedTry };

/** How a try ended, as the ledger keeps it. */
export type LedgerSettle =
  | { state: "done" }
  | { state: "dead" }
  /** It failed and the next try is on the queue. */
  | { state: "waiting" }
  /** It failed and what follows is not handed on yet. */
  | { state: "failed"; failed: FailedTry };

/**
 * Which try of each job key has begun and how it ended: what makes a message the queue delivers twice run its job once.
 * A lasting ledger (a K-05 call or a Durable Object, not built yet) keeps that across isolates; this isolate's memory
 * keeps it within one (./ledger.ts).
 */
export interface JobLedger {
  begin(jobKey: string, tryNo: number, at: number): Promise<LedgerBegin>;
  settle(jobKey: string, tryNo: number, settled: LedgerSettle, at: number): Promise<void>;
}

/** The retry queue's ports for this Worker isolate (D-017 joins them: `setQueueDeps`). */
export interface QueueDeps {
  sends: SendDoor;
  /** Each job kind's runner, by kind. A kind with none fails its tries (`NoRunner:<kind>`) and ends as a dead letter. */
  jobs: ReadonlyMap<string, JobRunner>;
  deadLetters: DeadLetterStore;
  /** This isolate's memory when left out. */
  ledger?: JobLedger;
}
