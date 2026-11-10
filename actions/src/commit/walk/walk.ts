// The walk after a choice (T-1139; arch 03 line 191: "Code's walk after a choice stops at the first step that asks
// someone, waits on a clock or event, or ends the journey. The compiler rejects loops"). From where the part's choice
// starts it (a door's or an any-time row's step entered, or a split's branch chosen), code follows the pinned flow graph
// (K-01 v1) one path, in order:
//
//   - a plain step is walked (its own writes apply: its gives) and the walk goes on to its next;
//   - a split stops the walk: one with a message branch asks someone, one with a clock branch waits on a clock; one whose
//     branches are all lookups is settled by code from a field it reads, which the walk does not read yet (notBuilt);
//   - a chosen branch is taken (its effects apply: what the choice causes, read by the compiler from the branch's own
//     steps), then its own steps are passed in order, each only to see whether it stops the walk, then it goes on: an
//     ending branch ends the path with its end text, a merging one rejoins at its rejoinAt or its split's next;
//   - where a list ends (next null), its section's main path ends the journey, and a branch's list goes where its branch
//     goes.
//
// It only reads the graph: what each step writes is writes.ts's. A step the pinned bundle does not hold is refused, never
// guessed (K-01 README: "a step a bundle does not hold is not reachable"), with one documented default below.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. An ending branch's own step that the bundle does not hold, when one of the branch's message effects names it, is
//      accounted for by that effect: the compiler reads a branch's effects from its own steps (a message per step that
//      tells someone, a record write per gives key, a charge, a calendar write: compiler/src/branches/effects.ts), and
//      the path ends after the branch's steps anyway. So S1-02's "Not a service we book" ends with its end text on bundle
//      v0, which does not hold S1-74 (ADR-013 section 6; DL-322 ruling 3), while "One isn't on the list yet" and "All on
//      the list", which merge at S1-11, are refused at S1-03 and S1-11. Any other step the bundle does not hold is
//      refused.
//   2. A step with its own gate (K-01 v1 step.when) is not walked yet: its gate reads the path, the plug-in and the
//      record (notBuilt). A chosen branch's own gate was the frontier's to read when it offered the branch.

import { WalkNotBuiltError, WalkRefusedError } from "./errors";
import type { FlowGraph, GraphBranch, GraphStep } from "./graph";

/** The most steps one walk follows before it is refused (walkTooLong): far past any path the master holds. */
export const MAX_WALK = 64;

/** Where a choice starts the walk. */
export type WalkStart =
  /** A step entered: a door's, an any-time row's or a search entry's step (K-02 v1 choice.step). */
  | { readonly kind: "step"; readonly step: string }
  /** A branch chosen at a split: an open question's option or a hub's case (K-02 v1 choice.step and choice.branch). */
  | { readonly kind: "branch"; readonly step: string; readonly branch: string };

/** What the walk applies, in order. */
export type Move =
  /** A plain step walked: its own writes apply. */
  | { readonly kind: "step"; readonly step: GraphStep }
  /** A branch taken: its effects apply. */
  | { readonly kind: "branch"; readonly split: GraphStep; readonly branch: GraphBranch };

/** Where the walk stops. */
export type Stop =
  /** A split that asks someone (a message branch): its question goes out, and the walk waits for the answer. */
  | { readonly kind: "asks"; readonly step: GraphStep }
  /** A split a clock settles (a clock branch, no message branch). */
  | { readonly kind: "waits"; readonly step: GraphStep }
  /** An ending branch: the path stops with its end text. */
  | {
      readonly kind: "ends";
      readonly split: GraphStep;
      readonly branch: GraphBranch;
      readonly text: string | null;
    }
  /** The end of a section's main path: the journey ends. */
  | { readonly kind: "journeyEnds"; readonly step: GraphStep };

export interface Walked {
  readonly moves: readonly Move[];
  readonly stop: Stop;
}

/** Default 1: an ending branch's message effect names the step the bundle does not hold. */
function accountedFor(branch: GraphBranch, stepId: string): boolean {
  return (
    branch.end === "end" &&
    branch.effects.some((effect) => effect.kind === "message" && effect.ref === stepId)
  );
}

/** The walk from `start` along the graph, to where it stops. Throws WalkRefusedError or WalkNotBuiltError. */
export function walkFrom(graph: FlowGraph, start: WalkStart): Walked {
  const moves: Move[] = [];
  const walked = new Set<string>();

  /** One more step on the walk: refused when it comes back to a walked step or the walk runs past MAX_WALK. */
  const enter = (id: string): void => {
    if (walked.has(id)) throw new WalkRefusedError("loop", [id]);
    if (walked.size >= MAX_WALK) throw new WalkRefusedError("walkTooLong", [id]);
    walked.add(id);
  };

  const held = (id: string): GraphStep => {
    const step = graph.step(id);
    if (step === null) throw new WalkRefusedError("stepNotInBundle", [id]);
    return step;
  };

  /** A split stops the walk: it asks someone, or waits on a clock; a split code settles is not read yet. */
  const atSplit = (split: GraphStep): Stop => {
    if (split.branches.some((branch) => branch.tag === "message")) return { kind: "asks", step: split };
    if (split.branches.some((branch) => branch.tag === "clock")) return { kind: "waits", step: split };
    throw new WalkNotBuiltError("lookup", [split.id]);
  };

  /** From step `id` along its own list (each step's next), each plain step applied, to where the walk stops. */
  const from = (id: string): Stop => {
    let step = held(id);
    for (;;) {
      enter(step.id);
      if (step.gated) throw new WalkNotBuiltError("stepGate", [step.id]);
      if (step.split) return atSplit(step);
      moves.push({ kind: "step", step });
      if (step.next === null) return climb(step);
      step = held(step.next);
    }
  };

  /** Where a branch goes once its own steps are done: an ending one stops; a merging one rejoins. */
  const after = (split: GraphStep, branch: GraphBranch): Stop => {
    if (branch.end === "end") return { kind: "ends", split, branch, text: branch.endText };
    if (branch.flow !== null && branch.flow !== graph.flow)
      throw new WalkNotBuiltError("otherFlow", [split.id]);
    const rejoin = branch.rejoinAt ?? split.next;
    return rejoin === null ? climb(split) : from(rejoin);
  };

  /**
   * A branch taken: its effects, then its own steps in order, each passed only to see whether it stops the walk (what a
   * plain one writes is in the branch's effects, which the compiler reads from it), then where the branch goes.
   */
  const take = (split: GraphStep, branch: GraphBranch): Stop => {
    moves.push({ kind: "branch", split, branch });
    for (const id of branch.steps) {
      const step = graph.step(id);
      if (step === null) {
        if (accountedFor(branch, id)) continue;
        throw new WalkRefusedError("stepNotInBundle", [id]);
      }
      enter(step.id);
      if (step.gated) throw new WalkNotBuiltError("stepGate", [step.id]);
      if (step.split) return atSplit(step);
    }
    return after(split, branch);
  };

  /**
   * The list holding `step` ends with it (K-01 v1 step.next null: "the enclosing branch's end or rejoinAt decides"). On
   * its section's main path the journey ends; on a branch's list, the walk goes where that branch goes. Refused when no
   * split of the bundle lists it, two do, or it is not its branch's last step: the walk cannot tell where the path goes.
   */
  const climb = (step: GraphStep): Stop => {
    const holders = graph.enclosing(step.id);
    if (holders.length === 0 && graph.onMainPath(step.id)) return { kind: "journeyEnds", step };
    const [holder] = holders;
    if (holders.length !== 1 || holder?.branch.steps.at(-1) !== step.id) {
      throw new WalkRefusedError("pathNotInBundle", [step.id]);
    }
    return after(holder.split, holder.branch);
  };

  if (start.kind === "step") return { moves, stop: from(start.step) };
  const split = held(start.step);
  const branch = split.branches.find((each) => each.label === start.branch);
  if (branch === undefined) throw new WalkRefusedError("branchNotInBundle", [split.id]);
  enter(split.id);
  return { moves, stop: take(split, branch) };
}
