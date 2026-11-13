// A row's next try on the retry queue (T-258; C-124; T-256's producer; arch 10 line 540: "Queues carry retries only:
// sends follow step 8, each try after any Retry-After").
//
// A run that leaves a row waiting for its next try starts one retry job for it, keyed by the try it leaves and the claim
// that handed that try out (`retry-<part key>#<attempts>`), so each wait starts its own job and the queue's ledger never
// takes a later wait for one it already ran (T-256: "each failure of a row starts its own retry"). The job carries ids and
// labels only (K-37 rule 4): the row, its recipient, the part's key, the chain and the failure's code. When it comes due,
// the dispatcher's send door (./door.ts) runs the recipient's rows again.

import {
  codeLabelOf,
  enqueueRetry,
  SEND_KIND,
  type FailedTry,
  type RetryJob,
  type RetryQueue,
} from "../../queues";
import type { ClaimedPart, ClaimedRow, Utc } from "../types";

/**
 * What the door does when the job comes due: `rerun`, run the recipient's rows again (the part's next try is already in
 * the store: the same key, or the new key a reported failure wrote); `awaitReceipt`, first write the new key of a part that
 * failed with 4001 or 4006, unless its receipt came in the minute (K-07 rule 2), then run them again.
 */
export type RetryChain = "rerun" | "awaitReceipt";

/** Why a run left the row waiting (a label for the report and the span). */
export type RetryWhy =
  /** No answer from Linq: the same key goes again. */
  | "sameKey"
  /** A reported failure: the new key goes, after any Retry-After. */
  | "newKey"
  /** 4001 or 4006: the new key only if no receipt comes within the minute. */
  | "awaitReceipt"
  /** The claim's Retry-After has not passed (renewClaim notYet). */
  | "notYet"
  /** A part whose latest try failed with no next try yet: its own job writes it, or its other ways follow (C-126). */
  | "failedTry"
  /** The store did not take the failure's mark: the part goes again under its key, and Linq answers the same. */
  | "storeError";

/** The job's message body (ids and labels only). */
export interface RetryBody {
  outboxRowId: string;
  recipientHandleId: string;
  /** The part's key the wait is for: the try that failed, or the try that waits. */
  failedKey: string;
  chain: RetryChain;
  /** The failure's code (Linq's code, else its kind) or the wait's label, as recorded. */
  code: string;
}

/** One wait, ready for the retry queue. */
export interface RetryPlan {
  job: RetryJob;
  /** The try the queue counts as failed: 1, the run's own (each wait is a job of its own). */
  tryNo: 1;
  /** When the row's first part went (the claim's firstTryAt), which the 15 minutes count from (K-07 rule 5). */
  firstTriedAt: Utc;
  failed: FailedTry;
}

export interface RetryPlanInput {
  row: ClaimedRow;
  part: ClaimedPart;
  chain: RetryChain;
  code: string;
  /** When the run left the row waiting. */
  at: Utc;
  waitSeconds: number;
  firstTryAt: Utc | null;
}

/** The job key of a wait: the part's key and the claim count that handed it out. */
export const retryJobKey = (part: ClaimedPart): string =>
  `retry-${part.idempotencyKey}#${String(part.attempts)}`;

/** The retry job for a wait, due `waitSeconds` after `at`. */
export function retryPlanOf(input: RetryPlanInput): RetryPlan {
  const body: RetryBody = {
    outboxRowId: input.row.outboxRowId,
    recipientHandleId: input.row.recipientHandleId,
    failedKey: input.part.idempotencyKey,
    chain: input.chain,
    code: input.code,
  };
  return {
    job: {
      key: retryJobKey(input.part),
      kind: SEND_KIND,
      businessId: input.row.businessId,
      traceId: input.row.traceId,
      body: { ...body },
    },
    tryNo: 1,
    // As the queue holds a time (RFC 3339, ending in Z), whatever form the store gave it in.
    firstTriedAt: new Date(Date.parse(input.firstTryAt ?? input.at)).toISOString(),
    failed: {
      at: Date.parse(input.at),
      error: codeLabelOf("SendFailed", input.code),
      retryAfterSeconds: input.waitSeconds,
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A retry job's body as the door reads it back, or null when it is not one of the dispatcher's. */
export function retryBodyOf(body: unknown): RetryBody | null {
  if (!isRecord(body)) return null;
  const { outboxRowId, recipientHandleId, failedKey, chain, code } = body;
  if (
    typeof outboxRowId !== "string" ||
    typeof recipientHandleId !== "string" ||
    typeof failedKey !== "string" ||
    (chain !== "rerun" && chain !== "awaitReceipt") ||
    typeof code !== "string"
  ) {
    return null;
  }
  return { outboxRowId, recipientHandleId, failedKey, chain, code };
}

/** Where a run puts each wait: "queued", or why not (a label). */
export interface RetryScheduler {
  schedule(plan: RetryPlan): Promise<string>;
}

/**
 * The retry queue as the dispatcher's scheduler: T-256's `enqueueRetry` on the RETRY_QUEUE binding (null where none is
 * bound: every wait answers `noQueue`). `now` is epoch milliseconds, the dispatcher's clock.
 */
export function queueRetries(queue: RetryQueue | null, now: () => number): RetryScheduler {
  return {
    async schedule(plan) {
      const answer = await enqueueRetry(
        queue,
        plan.job,
        { try: plan.tryNo, firstTriedAt: plan.firstTriedAt, failed: plan.failed },
        now(),
      );
      return "error" in answer ? answer.error : answer.result;
    },
  };
}
