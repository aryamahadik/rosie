// The reach settler port (T-1562; ruling T-1543 card B6 (b) and R1; K-09 v1.14 README default 227): read-only code for
// one split code settles (via auto: S1-71, S1-60, S1-80, S1-82, S1-62 and S1-32; and S1-75 and S1-35) that answers, where
// the walk reaches that split, the branch the walk takes there. The walk takes these settlers by step id from its binding
// (WalkDeps.reachSettlers), a field of its own beside `settlers` (default 191: a split's settler, asked only at an
// answered split) and `buttonsSettlers` (default 199: a plain step's buttons), and asks one only where default 227 says
// (writes.ts):
//   - where the walk reaches a split for which one is bound (walk.ts: a "reaches" stop, before atSplit), on a list, on a
//     chosen branch's rejoin, after another settler's stretch, or at a waiting split's event or resume start (S1-32);
//   - once, after the rows before that split are built, and only when no hold keeps the split back (writes.ts
//     firstHeld, as for any row the walk writes);
//   - handed the call's transaction and business, the split as the turn's pinned graph holds it, the turn object and the
//     rows built so far, and no part or choice on any turn (default 227; default 234 (2)): what it reads is its step's.
//
// What the walk does with the answer (reachAnswer, then walk.ts Stretch.reach):
//   - a branch label of that split, word for word: the branch is taken and written as walked, never as an answer
//     (writes.ts writingOf "step": no question closed, the split's tells kept, its writer run as a walked step's), then
//     its own steps and where it goes, each written as any walked step is;
//   - "wait" (REACH_WAITS), only at a split the event table lists (walk.ts EVENT_TABLE: S1-32 on control_proven): the walk
//     stops waitsOnEvent on that split's key, and nothing is written for the split (no record of the wait is the walk's:
//     T-1547 round-3 note 1 and T-1554 Lead note 1 leave it to T-1554, A10 and A11);
//   - "ask" (REACH_ASKS): the walk stops asking the split, as writes.ts asks any step it stops at (walk.ts default 6);
//   - a label the split lacks, or "wait" at a split the table does not list, is refused (settledNotInBundle); any other
//     answer, one that is no text, is refused (settledNotRows); a settler that refuses, or whose read fails, leaves as
//     it was thrown. Either way the call fails closed with nothing written.
// With no reach settler bound for a split, the walk stops there as today (atSplit: notBuilt for an all-lookup split).
// Which settler is bound for which split, and what each answers, are their cards' (B4, C1, D1, E1, E12; R4, R7, R8,
// R14, R19, R22, R23); this card binds none.

import type { CommitTurnContext } from "../types";
import type { RowsBuilt } from "./buttons";
import { WalkRefusedError } from "./errors";
import type { GraphStep } from "./graph";
import { waitingKeyAt, type ReachAnswer } from "./walk";

/** A reach settler's reserved answer: the walk waits on the split's event key (only at a split the event table lists). */
export const REACH_WAITS = "wait";

/** A reach settler's reserved answer: the walk stops asking the split, as it asks any step it stops at. */
export const REACH_ASKS = "ask";

/** One ask of a reach settler: on the call's transaction, inside its business scope; no part and no choice. */
export interface ReachSettlerCall<Repo = unknown> {
  /** The call's repo, inside its transaction and business scope (CommitTurnContext.repo): read through, never written. */
  readonly repo: Repo;
  /** The call's business (CommitTurnContext.businessId), never a request value. */
  readonly businessId: string;
  /** The split the walk reached, as the turn's pinned graph holds it, with its branches. */
  readonly step: GraphStep;
  /**
   * The turn as the commit hands it to writesOf: the same object the walk hands every writer and settler of this run, so
   * they can share one read for the walk.
   */
  readonly turn: CommitTurnContext<Repo>;
  /** The rows built so far in this walk, before this split. */
  readonly rows: RowsBuilt;
}

/**
 * One split's reach settler: read-only, it answers a branch label of the split, "wait" or "ask", or refuses by
 * throwing. It writes nothing; what it throws fails the call closed, as a writer's refusal does.
 */
export type ReachSettler<Repo = unknown> = (call: ReachSettlerCall<Repo>) => Promise<string>;

/** The reach settlers by step id: the settler bound to `stepId`, or null when none is. */
export type ReachSettlers<Repo = unknown> = (stepId: string) => ReachSettler<Repo> | null;

/**
 * Asks `settler` once at `call.step` and checks its answer: "wait" only at a split the event table lists, "ask", or a
 * label of the split's branches in the turn's pinned graph, word for word (the reserved words first: walk.ts default 7).
 * A label the split lacks, or "wait" elsewhere, is refused settledNotInBundle; an answer that is no text, settledNotRows;
 * each naming the split alone, never the answer. What the settler throws leaves as it was thrown.
 */
export async function reachAnswer<Repo>(
  settler: ReachSettler<Repo>,
  call: ReachSettlerCall<Repo>,
): Promise<ReachAnswer> {
  const answered: unknown = await settler(call);
  const { step } = call;
  if (typeof answered !== "string") throw new WalkRefusedError("settledNotRows", [step.id]);
  if (answered === REACH_ASKS) return { kind: "ask" };
  if (answered === REACH_WAITS) {
    if (waitingKeyAt(step.id) === null) throw new WalkRefusedError("settledNotInBundle", [step.id]);
    return { kind: "wait" };
  }
  if (!step.branches.some((branch) => branch.label === answered)) {
    throw new WalkRefusedError("settledNotInBundle", [step.id]);
  }
  return { kind: "branch", label: answered };
}
