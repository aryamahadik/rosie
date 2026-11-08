// The retry queue (T-256; C-056; C-035; arch 10 'Clocks and queues', architecture.txt line 540): "Queues carry retries
// only: sends follow step 8, each try after any Retry-After; other jobs get 5 tries, then a dead-letter queue in the team
// console (DD)".
//
// The producer (producer.ts) puts the next try of a failed job on the RETRY_QUEUE binding; the consumer (consumer.ts) is
// the Worker's queue handler (runtime/src/index.ts), which runs each try once (ledger.ts, by job key), sends retries
// through the dispatcher's door after any Retry-After, and turns a job's fifth failure into one K-37 v1 dead-letter row
// (dead-letter.ts). D-017 joins the ports: `setQueueDeps({ sends, jobs, deadLetters, ledger })`. The team console's view
// of the dead letters is C-194's.

export {
  consumeRetries,
  queueDeps,
  retryQueueHandler,
  setQueueDeps,
  type BatchReport,
  type ConsumeOptions,
  type MessageOutcome,
  type MessageReport,
} from "./consumer";
export { deadLetterIdOf, deadLetterRowOf, RETRY_QUEUE_NAME, type DeadLetterInput } from "./dead-letter";
export { isolateJobs, JOB_MEMORY, JobMemory } from "./ledger";
export {
  codeLabelOf,
  errorLabelOf,
  HAND_OFF_DELAY_S,
  isErrorLabel,
  JOB_SPACING_S,
  JOB_TRIES,
  MAX_DELAY_S,
  readRetryMessage,
  RUN_LAPSE_MS,
  SEND_SPACING_S,
  SEND_TRIES_GUARD,
} from "./message";
export {
  enqueueRetry,
  retryQueueOf,
  runJob,
  type EnqueueAnswer,
  type RetryAfter,
  type RunJobOptions,
  type RunJobReport,
} from "./producer";
export * from "./types";
