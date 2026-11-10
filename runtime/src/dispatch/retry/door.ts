// The dispatcher's send door for the retry queue (T-258; C-124; T-256's `SendDoor`; arch 10 line 540). D-017 joins it:
// `setQueueDeps({ sends: dispatchSendDoor(deps), ... })`, with the same DispatchDeps the turn's wake runs with.
//
// When a retry job comes due (never before its notBefore: the consumer holds it), the door:
//   1. for a part that failed with 4001 or 4006 (chain `awaitReceipt`), asks the store for the part's next try:
//      `markPart` failed with retry on the failed key. A receipt that came in the minute has moved the part to delivered,
//      which the store answers `wrongState`: the retries end and nothing is sent (K-07 rule 2). Otherwise the store writes
//      the new key, a minute or more after the failure (outbox-4006-new-key.json: try 2 written by markPart at 15:07:36,
//      a minute after try 1 failed), or answers the one it wrote before;
//   2. runs the recipient's rows again (`runDispatch`): the lapsed claim is claimed again (K-05 v1.1 item 13), limit 8
//      reads the send state afresh, and each part goes under the key the store holds for it: the same key after no
//      answer, the new one after a reported failure, and not before the claim's Retry-After (renewClaim notYet). A run
//      that leaves a row waiting again starts that wait's own job, so the door answers `done`.
// It answers `again` (the consumer puts the next try of this job on the queue) only when the store gave no answer it
// can use, and never once 15 minutes of tries have passed (K-07 rule 5: the next way is C-126's).

import { runDispatch, untilNotTransient, type DispatchDeps } from "../dispatcher";
import type { JobTry, SendAnswer, SendDoor } from "../../queues";
import { retryBodyOf } from "./plan";
import { triesOver } from "./rules";

/** What the door did with one try of a retry job (for its tests and logs: ids and labels only). */
export type DoorOutcome =
  /** The job's body is not one of the dispatcher's: nothing to do. */
  | "notOurs"
  /** The part's receipt came within the minute: no new key, nothing sent (K-07 rule 2). */
  | "receiptCame"
  /** The store holds no such part. */
  | "noPart"
  /** The recipient's rows ran again. */
  | "ran"
  /** The store answered transient or not at all: the job comes again. */
  | "storeAgain"
  /** 15 minutes of tries have passed: nothing more on Linq (the next way is C-126's). */
  | "triesOver";

export interface SendDoorOptions {
  /** Told what each try of a job did (a test's record; the queue's own log line carries the job's ids). */
  onTry?: (send: JobTry, outcome: DoorOutcome) => void;
}

/** The dispatcher's door for the retry queue's send jobs (T-256 `SendDoor`). */
export function dispatchSendDoor(deps: DispatchDeps, options: SendDoorOptions = {}): SendDoor {
  const told = (send: JobTry, outcome: DoorOutcome, answer: SendAnswer): SendAnswer => {
    options.onTry?.(send, outcome);
    return answer;
  };
  return {
    async retrySend(send) {
      const body = retryBodyOf(send.body);
      if (body === null) return told(send, "notOurs", { result: "done" });
      const again = (code: string): SendAnswer =>
        triesOver(send.firstTriedAt, deps.now())
          ? told(send, "triesOver", { result: "done" })
          : told(send, "storeAgain", { result: "again", code, retryAfterSeconds: null });

      if (body.chain === "awaitReceipt") {
        const next = await untilNotTransient(() =>
          deps.store.markPart({
            outcome: "failed",
            idempotencyKey: body.failedKey,
            errorCode: body.code,
            retry: true,
            at: deps.now(),
          }),
        );
        if ("error" in next) {
          switch (next.error) {
            case "wrongState":
              // The part is no longer failed: its receipt moved it to delivered within the minute.
              return told(send, "receiptCame", { result: "done" });
            case "notFound":
              return told(send, "noPart", { result: "done" });
            default:
              return again("storeTransient");
          }
        }
        // A store that took the mark but holds no next try for the part cannot send it: ask again.
        if (next.nextKey === null) return again("noNextKey");
      }

      const report = await runDispatch(deps, { recipientHandleId: body.recipientHandleId });
      if (report.claimError !== null) return again("claimTransient");
      return told(send, "ran", { result: "done" });
    },
  };
}
