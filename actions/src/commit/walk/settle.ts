// The settler port (T-1502; K-09 README default 191 as T-1499's round 2 corrects it, DL-1018 card 4, DL-1021): read-only
// code for one split step that answers the label of the branch the turn takes there, so an owner's words, not the option
// decide named, decide S1-02's branch. The walk takes the settlers by step id from its binding (WalkDeps.settlers),
// beside the question read and the step writers, and asks one only where default 191 says (writes.ts):
//   - at a split step: a step whose branches the turn's pinned graph holds (a settler bound at a step with no branches,
//     S1-04's among them, is never asked under default 191: its own version says when it is asked);
//   - for a passed part that chooses an option of that step's open question, once a question read is bound;
//   - only when no hold keeps the answer back: an answer's first row is its question's close, and when what is open holds
//     that row back nothing is read for the part, so its settler is not asked (STATE note 1; commit.ts step 3);
//   - once, before the walk reads a branch from the graph and before any writer is called.
// Of the choice decide named the walk then reads only what every option of that question shares (its question, its step
// and its target), never its branch, label or choiceId, to find the branch.
//
// What the walk does with the answer: a label the pinned graph holds for that step, word for word, is walked as a chosen
// branch is today (the question closed at the version its row is read at, the step's own writer, each step of the settled
// branch by its writer, on to the first step that asks, waits or ends), each writer handed the settled branch as the
// branch chosen, and the unit's why naming the step and the settled branch, never the option named or the person's words.
// Any other answer (a label the step does not hold, or no label) is refused (settledNotInBundle), and a settler that
// refuses or whose read fails leaves as it was thrown: either way the call fails closed with nothing written and the
// question stays open (a failed read is never taken as a branch). With no settler bound the walk is exactly today's.

import type { Choice } from "../../gate/framework";
import type { CommitTurnContext, PassedPart } from "../types";
import { WalkRefusedError } from "./errors";
import type { GraphStep } from "./graph";

/** One ask of a split step's settler: on the call's transaction, inside its business scope. */
export interface StepSettlerCall<Repo = unknown> {
  /** The call's repo, inside its transaction and business scope (CommitTurnContext.repo): read through, never written. */
  readonly repo: Repo;
  /** The call's business (CommitTurnContext.businessId), never a request value. */
  readonly businessId: string;
  /** The split step, as the turn's pinned graph holds it, with its branches. */
  readonly step: GraphStep;
  /** The part the gate passed. */
  readonly part: PassedPart;
  /**
   * The offered choice the part named. A settler reads of it only what every option of its question shares (its
   * question, step and target): never its branch, label or choiceId, which name the option decide named.
   */
  readonly choice: Choice;
  /**
   * The turn as the commit hands it to writesOf: the same object the walk hands every writer of this run as
   * `writer.turn`, so a settler and a writer can share one read for the walk.
   */
  readonly turn: CommitTurnContext<Repo>;
}

/**
 * One split step's settler: read-only, it answers the label of the branch the turn takes at that step, or refuses by
 * throwing. It writes nothing; what it throws fails the call closed, as a writer's refusal does.
 */
export type StepSettler<Repo = unknown> = (call: StepSettlerCall<Repo>) => Promise<string>;

/** The settlers by step id: the settler bound to `stepId`, or null when none is. */
export type StepSettlers<Repo = unknown> = (stepId: string) => StepSettler<Repo> | null;

/** Whether the pinned graph holds a step as a split with its branches: the only step default 191 asks a settler at. */
export function isSplitStep(step: GraphStep | null): step is GraphStep {
  return step !== null && step.split && step.branches.length > 0;
}

/**
 * Asks `settler` once for the branch at `call.step` and checks its answer: a label of that step's branches in the
 * turn's pinned graph, word for word. Any other answer is refused (settledNotInBundle), naming the step alone, never the
 * answer. What the settler throws leaves as it was thrown.
 */
export async function settledBranch<Repo>(
  settler: StepSettler<Repo>,
  call: StepSettlerCall<Repo>,
): Promise<string> {
  const answered: unknown = await settler(call);
  if (typeof answered !== "string" || !call.step.branches.some((branch) => branch.label === answered)) {
    throw new WalkRefusedError("settledNotInBundle", [call.step.id]);
  }
  return answered;
}
