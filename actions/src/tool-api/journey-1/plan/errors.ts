// What journey 1's plan folder throws (T-1482). Each message names a call, a step, a fault or a seam: never the owner's
// words, an id, a number, a stop reading or the turn's chat id (K-08 v1 README line 75; DL-935: never log a read's answer
// raw). A throw inside a step writer fails the call closed with nothing written (the walk: actions/src/commit/walk
// writes.ts; the Tool API base rolls the call's transaction back).

import type { CallName } from "../../calls";
import { NotBuiltError } from "../../errors";

/**
 * Why S1-08's writer refused (refused, never guessed):
 *   - wrongStep: the writer was called for another step than S1-08 (the binding's fault);
 *   - noPerson: the turn names no person to receive the plan's row (K-09 caller.personId null).
 */
export type PlanFault = "wrongStep" | "noPerson";

/** S1-08's writer refused: the whole call is refused and nothing is written. */
export class PlanRefusedError extends Error {
  override name = "PlanRefusedError";
  readonly fault: PlanFault;
  /** The steps at fault, as labels (step ids), or empty. */
  readonly ids: readonly string[];

  constructor(fault: PlanFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `the plan refused the part (${fault}); nothing was written`
        : `the plan refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

/**
 * What S1-08's writer does not write yet, answered notBuilt with nothing written:
 *   - stopNotWired: no stop home reads bound, so the owner cannot be read with readStop and mayText cannot rule the row
 *     (K-09 README default 189: fail closed).
 */
export type PlanSeam = "stopNotWired";

/** Something S1-08's writer would have to read is not bound: the base answers notBuilt and rolls back. */
export class PlanNotBuiltError extends NotBuiltError {
  override name = "PlanNotBuiltError";
  readonly seam: PlanSeam;
  /** The steps it is about, as labels, or empty. */
  readonly ids: readonly string[];

  constructor(call: CallName, seam: PlanSeam, ids: readonly string[] = []) {
    super(call);
    this.message =
      ids.length === 0
        ? `${call}: the plan's row is not built (${seam}); nothing was written`
        : `${call}: the plan's row is not built (${seam}: ${ids.join(", ")}); nothing was written`;
    this.seam = seam;
    this.ids = [...ids];
  }
}
