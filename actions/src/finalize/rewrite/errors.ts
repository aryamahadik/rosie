// What the finalize call throws (T-313). Each message names a fault, a port or row ids (labels code made): never a value,
// a detail or a text's words. A throw inside finalizeMessage's handler rolls the call's transaction back (the Tool API
// base), so nothing is written.

import { NotBuiltError } from "../../tool-api/errors";

/** A port of the finalize call not built yet (types.ts FinalizePorts). */
export type FinalizeSeam = "readRow" | "insertFixedLines" | "writePlan" | "cancelClock" | "openReviewItem";

/**
 * Something the finalize call needs is not built yet: the Tool API base answers finalizeMessage `notBuilt` and rolls the
 * call back, so nothing is written and nothing is sent (fail closed).
 */
export class FinalizeNotBuiltError extends NotBuiltError {
  override name = "FinalizeNotBuiltError";
  readonly seam: FinalizeSeam;

  constructor(seam: FinalizeSeam) {
    super("finalizeMessage");
    this.message = `finalizeMessage: ${seam} is not built yet; nothing was written`;
    this.seam = seam;
  }
}

/**
 * Why the finalize call refused a request it cannot answer with one of K-09 v1's errors (fail closed):
 *   - planForOtherRow, rowMismatch, channelMismatch: the plan or the row read names another row or channel than the
 *     request's (K-05 v1 writePlan: "that the plan's row is this row is a code check");
 *   - fixedLineRow: the row carries a fixed line code writes word for word, so the composer path never finalizes it
 *     (STATE note 17; T-267);
 *   - rowNotPlannable: the row is neither planned nor stale, yet holds no final parts (K-07 v1);
 *   - partsNotWellFormed: the fixed-line port answered parts for another row or channel, or with no send or more than two;
 *   - stopReplyLine: the parts name stopReply, the one line besides a safety row that limit 8 lets past the stopped flag,
 *     which the finalize call never writes (T-267's security note b; CQ-55);
 *   - noPassedOnLine: the bundle holds no words for the passed-on line in the reader's language or in English (K-01 v1
 *     fixed line passedOn), so nothing could go;
 *   - writeRefused, clockRefused, reviewRefused: a K-05 write or the review item answered an error K-09 v1's
 *     finalizeMessage has no answer for (a database rule; a clock already fired; the caller not on the team).
 */
export type FinalizeFault =
  | "planForOtherRow"
  | "rowMismatch"
  | "channelMismatch"
  | "fixedLineRow"
  | "rowNotPlannable"
  | "partsNotWellFormed"
  | "stopReplyLine"
  | "noPassedOnLine"
  | "writeRefused"
  | "clockRefused"
  | "reviewRefused";

/** The finalize call refused the request: nothing was written (or the call's transaction rolls back what was). */
export class FinalizeRefusedError extends Error {
  override name = "FinalizeRefusedError";
  readonly fault: FinalizeFault;
  /** The answer's error code, when a port answered one (a label), or null. */
  readonly code: string | null;

  constructor(fault: FinalizeFault, code: string | null = null) {
    super(
      code === null
        ? `finalizeMessage: refused (${fault}); nothing was written`
        : `finalizeMessage: refused (${fault}: ${code}); nothing was written`,
    );
    this.fault = fault;
    this.code = code;
  }
}
