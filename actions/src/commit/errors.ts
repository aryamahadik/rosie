// What the commit throws (T-305). Each message names a fault, a port or row ids (labels code made): never a quote's, a
// value's or a person's words, which a state write or a part may carry (K-08 v1 README: "never the raw number or words").
// A throw inside gateAndCommit's handler rolls the call's transaction back (the Tool API base), so nothing is written.

import { NotBuiltError } from "../tool-api/errors";

/** A port of the commit not built yet (types.ts CommitPorts), or an input the commit does not take yet. */
export type CommitSeam = "commitTurn" | "writesOf" | "runCore" | "openHolds" | "clockFiring" | "plannerVerbs";

/**
 * Something the commit needs is not built yet: the Tool API base answers gateAndCommit `notBuilt` and rolls the call back,
 * so nothing is written and no part commits (fail closed).
 */
export class CommitNotBuiltError extends NotBuiltError {
  override name = "CommitNotBuiltError";
  readonly seam: CommitSeam;

  constructor(seam: CommitSeam) {
    super("gateAndCommit");
    this.message = `gateAndCommit: ${seam} is not built yet; nothing was written`;
    this.seam = seam;
  }
}

/**
 * Why the commit refused a turn it could not write as one K-05 commit (fail closed):
 *   - callerNotTurn, turnIdMismatch, traceIdMismatch: the request names another turn than its turn row, or is not a
 *     turn's call;
 *   - stateTable: a state write names a table the commit writes through its own list, or a write-once table (K-05 v1
 *     stateTable);
 *   - outboxRowWithPlan: an outbox row carries a plan, final parts or a field K-05 v1 outboxRowNew does not hold: words
 *     go into the row after the commit (arch 01 line 41; K-07 v1);
 *   - effectWithoutKey, effectKeyTwice, effectNotWellFormed: an effect row with no idempotency key, a key two effects
 *     share, or an effect without its id or kind (K-07 v1 effectRow; arch 10 line 542: one key over all tries);
 *   - idTwice: one id given to two rows of one list, or to two event-log entries;
 *   - partNotGated: the gate passed a part decide does not hold, or one whose verb no limit gates;
 *   - wrongState: K-05 answered an error K-09 v1 has no answer for (an effect let go that is not in outage);
 *   - stillChanged: the rows the turn read changed again after the one reload (arch 06 line 305: reload once).
 */
export type CommitFault =
  | "callerNotTurn"
  | "turnIdMismatch"
  | "traceIdMismatch"
  | "stateTable"
  | "outboxRowWithPlan"
  | "effectWithoutKey"
  | "effectKeyTwice"
  | "effectNotWellFormed"
  | "idTwice"
  | "partNotGated"
  | "wrongState"
  | "stillChanged";

/** The commit refused the turn: nothing was sent to K-05, or K-05 wrote nothing. */
export class CommitRefusedError extends Error {
  override name = "CommitRefusedError";
  readonly fault: CommitFault;
  /** The rows at fault, by id (labels code made), or empty. */
  readonly ids: readonly string[];

  constructor(fault: CommitFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `gateAndCommit: the commit refused the turn (${fault}); nothing was written`
        : `gateAndCommit: the commit refused the turn (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}
