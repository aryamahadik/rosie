// The dead-letter row (T-256; C-056; K-37 v1 dead_letters, contracts/db-schema/platform-review): a job other than a send
// whose fifth try failed. The team console lists it, oldest first, and the team replays or closes it (C-194).
//
// One row per job: its id is fixed by rule from the job key, so a dead letter written again after a crash names the same
// row and the store answers repeated. The row keeps K-37's CHECKs: tries at least 5 (dead_letters_after_five_tries), the
// times in order (dead_letters_tries_in_order), state open with no resolution, and a last error that is not blank.
// The last error is the error label the fifth try left: its name and a label only (STATE note 3).

import { utcOf } from "./message";
import type { DeadLetterRow, FailedTry, RetryJob } from "./types";

/** The queue a dead letter names when the batch gives none (wrangler.jsonc's retry queue, T-279). */
export const RETRY_QUEUE_NAME = "rosie-retry";

/** The dead letter's id, fixed by rule from the job key: one row per job. */
export const deadLetterIdOf = (jobKey: string): string => `dl-${jobKey}`;

export interface DeadLetterInput {
  /** The queue the job came from (the batch's queue name). */
  queue: string;
  job: RetryJob;
  /** The tries the job had in all (5). */
  tries: number;
  /** When its first try ran (UTC). */
  firstTriedAt: string;
  /** Its last try, which failed. */
  failed: FailedTry;
  /** Epoch milliseconds now: when it lands in the dead-letter queue. */
  deadAt: number;
}

/** The K-37 v1 dead_letters row for a job whose last try failed, with its times held in K-37's order. */
export function deadLetterRowOf(input: DeadLetterInput): DeadLetterRow {
  const first = Date.parse(input.firstTriedAt);
  const last = Math.max(first, input.failed.at);
  const dead = Math.max(last, input.deadAt);
  return {
    id: deadLetterIdOf(input.job.key),
    queue: input.queue === "" ? RETRY_QUEUE_NAME : input.queue,
    job_kind: input.job.kind,
    job_id: input.job.key,
    message_body: input.job.body,
    tries: input.tries,
    first_tried_at: utcOf(first),
    last_tried_at: utcOf(last),
    last_error: input.failed.error,
    business_id: input.job.businessId,
    trace_id: input.job.traceId,
    dead_at: utcOf(dead),
    state: "open",
    version: 1,
  };
}
