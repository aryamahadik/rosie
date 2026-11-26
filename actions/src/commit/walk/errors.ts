// What the walk throws (T-1139, T-1461). Each message names a fault or a seam and labels code made or the bundle names:
// step ids, gives keys and effect kinds. Never a quote's, a value's or a person's words, a branch label, or the turn's
// chat id (K-08 v1 README line 75; K-09 v1.5 default 135). A throw inside gateAndCommit's handler rolls the call's transaction back (the Tool
// API base), so nothing is written and no part commits (fail closed).

import { NotBuiltError } from "../../tool-api/errors";

/**
 * Why the walk refused a part (refused, never guessed):
 *   - flowNotInBundle: the turn's pinned bundle holds no graph of the flow the part's step is in, or not K-01's;
 *   - stepNotInBundle: a step the part enters, or the walk reaches, is not in the pinned bundle (K-01 README: "a step a
 *     bundle does not hold is not reachable"), an answer's branch step that walk.ts default 1 lets the path end past
 *     among them, since an answer writes each step of its branch through that step's writer (T-1461);
 *   - branchNotInBundle: the part chose a branch its step does not have in the pinned bundle, or a step with no branches;
 *     or, answering a plain step's buttons question (T-1480; K-09 README defaults 181 and 188), a label that is none of
 *     that step's button labels in the pinned bundle, word for word;
 *   - pathNotInBundle: where a list ends, the walk cannot tell where the path goes (the split whose branch lists the step
 *     is not in the bundle, or two branches list it);
 *   - stepNotWellFormed: a step the walk reads is not K-01 v1's shape (an asked step with no card among them);
 *   - loop: the walk met a step it had already walked (arch 03 line 191: "The compiler rejects loops");
 *   - walkTooLong: the walk passed MAX_WALK steps without stopping;
 *   - notDecided: the request carries no decided texts, so no part chose anything;
 *   - businessNotInScope: the part's choice, or the open question it answers, is about another business than the call's;
 *   - noServiceOrChatId: the rows need the service and the Linq chat id of the turn's last text, and the request's turn
 *     does not carry both as non-empty strings (K-09 v1.5 default 135);
 *   - noTurnKey: the turn key the row ids are built from is empty (default 131);
 *   - questionNotLive: the open question an option answers is not live on the turn's handle as the question read finds
 *     it (closed, never sent there, or not the chosen step's), or the option names none (T-1461);
 *   - givesNotStep: a step's writer gave a key its step does not give (K-01 v1 step.gives; T-1461);
 *   - settledNotInBundle: a split's bound settler answered no label of that step's branches in the turn's pinned graph,
 *     word for word (K-09 README default 191; T-1502), so the walk has no branch to take; or a reach settler (K-09 v1.14
 *     default 227; T-1562) answered a label the split lacks, or "wait" at a split the event table does not list;
 *   - settledNotRows: a plain step's bound buttons settler answered neither "ask" nor rows in a step writer's shape
 *     (K-09 README default 199; T-1491), so the walk can neither ask the step nor write it as walked; or a reach settler
 *     answered no text at all (default 227);
 *   - rowNotStep: a step's writer (or its buttons settler) gave an outbox row that names another step than its own
 *     (K-05 v1.22 item 82: a writer's rows carry the writer's own step; T-1479), so the row would carry another step's
 *     line to its reader;
 *   - eventKeyAtWalk: a step's writer (or its buttons settler) gave a key a turn never gives (walk.ts EVENT_ONLY_KEYS:
 *     id_checked, given only by the ID upload on the secure page; K-09 README default 209; T-1532; and control_proven,
 *     given only by the team's decision proving control: K-09 v1.14 default 223, T-1562), naming the step and the key
 *     alone; or an event or resume start (K-09 v1.14 defaults 226 and 235; T-1562) names a step and a key that are no pair
 *     of the event table (walk.ts EVENT_TABLE), so the walk would start past a step that does not wait on that key, naming
 *     the step and the key alone. (The fault list is K-09 v1.13 default 217's, classed in tool-api/refusal.ts, so the
 *     start's refusal takes this final fault of the event table rather than a new one.)
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
  | "noTurnKey"
  | "questionNotLive"
  | "givesNotStep"
  | "settledNotInBundle"
  | "settledNotRows"
  | "rowNotStep"
  | "eventKeyAtWalk";

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
 *   - answer: a choose of a hub's case, or of an open question's option while no question read is bound (WalkDeps
 *     questions: card F binds it), since the question's close needs the version its row was read at (T-1461);
 *   - gives: a step's gives key with no writer bound (the walk itself writes S1-01's thread alone);
 *   - tells: a walked step that tells someone with no writer bound, a message no question carries;
 *   - stepGate: a step with its own gate (K-01 step.when), read from the path, the plug-in and the record;
 *   - lookup: a split code settles by a field it reads (K-01 branch.reads);
 *   - waits: a split a clock settles (K-01 branch tag clock);
 *   - otherFlow: a branch that continues in the other flow;
 *   - recipient: an asked step whose question is not Rosie's reply by text to the turn's own writer;
 *   - buttons: an answer to a question that went out with options: their option ids are K-03's, which the walk does not
 *     map to a branch yet (an asked split whose message has buttons is asked with no options from T-1479: writes.ts
 *     default 10);
 *   - clock: an asked step whose card's Clock is not step 9's default (a Clock line of its own, or none), since the walk
 *     writes only step 9's default (K-05 v1 openQuestionNew.clock null);
 *   - threadByEmail: S1-01's thread for a turn whose last text came by email (K-04 threads: an email thread needs a
 *     booking and a reply address);
 *   - effect: an answer's branch effect that no step writer writes: a clock, a charge, a refund, a calendar write or a
 *     flag (K-01 v1 effect.kind), since a writer gives state rows, keys, questions and messages alone (T-1461).
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
  | "threadByEmail"
  | "effect";

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
