// What the walk throws (T-1139). Each message names a fault or a seam and labels code made or the bundle names: step ids
// and gives keys. Never a quote's, a value's or a person's words, a branch label, or the turn's chat id (K-08 v1 README
// line 75; K-09 v1.5 default 135). A throw inside gateAndCommit's handler rolls the call's transaction back (the Tool
// API base), so nothing is written and no part commits (fail closed).

import { NotBuiltError } from "../../tool-api/errors";

/**
 * Why the walk refused a part (refused, never guessed):
 *   - flowNotInBundle: the turn's pinned bundle holds no graph of the flow the part's step is in, or not K-01's;
 *   - stepNotInBundle: a step the part enters, or the walk reaches, is not in the pinned bundle (K-01 README: "a step a
 *     bundle does not hold is not reachable");
 *   - branchNotInBundle: the part chose a branch its step does not have in the pinned bundle, or a step with no branches;
 *   - pathNotInBundle: where a list ends, the walk cannot tell where the path goes (the split whose branch lists the step
 *     is not in the bundle, or two branches list it);
 *   - stepNotWellFormed: a step the walk reads is not K-01 v1's shape (an asked step with no card among them);
 *   - loop: the walk met a step it had already walked (arch 03 line 191: "The compiler rejects loops");
 *   - walkTooLong: the walk passed MAX_WALK steps without stopping;
 *   - notDecided: the request carries no decided texts, so no part chose anything;
 *   - businessNotInScope: the part's choice is about another business than the call's;
 *   - noServiceOrChatId: the rows need the service and the Linq chat id of the turn's last text, and the request's turn
 *     does not carry both as non-empty strings (K-09 v1.5 default 135);
 *   - noTurnKey: the turn key the row ids are built from is empty (default 131).
 */
export type WalkFault =
  | "flowNotInBundle"
  | "stepNotInBundle"
  | "branchNotInBundle"
  | "pathNotInBundle"
  | "stepNotWellFormed"
  | "loop"
  | "walkTooLong"
  | "notDecided"
  | "businessNotInScope"
  | "noServiceOrChatId"
  | "noTurnKey";

/** The walk refused the part: the whole turn is refused and nothing is written. */
export class WalkRefusedError extends Error {
  override name = "WalkRefusedError";
  readonly fault: WalkFault;
  /** The steps or keys at fault, as labels (step ids, the flow letter), or empty. */
  readonly ids: readonly string[];

  constructor(fault: WalkFault, ids: readonly string[] = []) {
    super(
      ids.length === 0
        ? `gateAndCommit: the walk refused the part (${fault}); nothing was written`
        : `gateAndCommit: the walk refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

/**
 * What the walk does not write yet: each journey's lane extends it (the card's "Not here"). Each is answered notBuilt,
 * with nothing written:
 *   - verb: a part with no offered choice (pass_on, hand_off), whose writes are not a walk's;
 *   - whichBooking: the "which booking?" choice, which picks a booking and walks nowhere;
 *   - answer: a choose of an open question's option or a hub's case: the question's close and its clock's cancel, the
 *     asked step's gives (S1-02's kinds: the matcher, C-130) and the branch's effects (journey 1's lane; DL-322);
 *   - gives: a step's gives key with no writer (the walk writes S1-01's thread alone);
 *   - tells: a plain step that tells someone, a message no question carries;
 *   - stepGate: a step with its own gate (K-01 step.when), read from the path, the plug-in and the record;
 *   - lookup: a split code settles by a field it reads (K-01 branch.reads);
 *   - waits: a split a clock settles (K-01 branch tag clock);
 *   - otherFlow: a branch that continues in the other flow;
 *   - recipient: an asked step whose question is not Rosie's reply by text to the turn's own writer;
 *   - buttons: an asked step whose message has buttons, whose option ids K-03 gives;
 *   - clock: an asked step whose card's Clock is not step 9's default (a Clock line of its own, or none), since the walk
 *     writes only step 9's default (K-05 v1 openQuestionNew.clock null);
 *   - threadByEmail: S1-01's thread for a turn whose last text came by email (K-04 threads: an email thread needs a
 *     booking and a reply address).
 */
export type WalkSeam =
  | "verb"
  | "whichBooking"
  | "answer"
  | "gives"
  | "tells"
  | "stepGate"
  | "lookup"
  | "waits"
  | "otherFlow"
  | "recipient"
  | "buttons"
  | "clock"
  | "threadByEmail";

/**
 * Something the walk would have to write is not built yet: the Tool API base answers gateAndCommit `notBuilt` and rolls
 * the call back, so nothing is written and no part commits (fail closed).
 */
export class WalkNotBuiltError extends NotBuiltError {
  override name = "WalkNotBuiltError";
  readonly seam: WalkSeam;
  /** The steps or keys it is about, as labels (step ids, gives keys, a verb), or empty. */
  readonly ids: readonly string[];

  constructor(seam: WalkSeam, ids: readonly string[] = []) {
    super("gateAndCommit");
    this.message =
      ids.length === 0
        ? `gateAndCommit: the walk does not write ${seam} yet; nothing was written`
        : `gateAndCommit: the walk does not write ${seam} yet (${ids.join(", ")}); nothing was written`;
    this.seam = seam;
    this.ids = [...ids];
  }
}
