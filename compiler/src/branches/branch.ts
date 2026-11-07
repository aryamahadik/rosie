// Branches (T-145; K-01 v1 `branch`; C-058): for each branch of each split its exact label, its tag, its gates, how it
// ends, the typed fields its answer gives and its effects.
//
//   label        word for word as the master writes it (overlays match it exactly, SPEC-master 5d). Never retyped.
//   tag          message: the model may choose it; lookup: code settles it; clock: a clock row settles it. Only message
//                branches enter the choices (arch 03 line 161). The rules, one per tag, in this order:
//                  clock    the label is only a silence or a time that ran out: `No reply`, `No answer in time`,
//                           `Not done in time`, `Nothing entered by night` (CLOCK_LABEL). A label that also names a
//                           reply (`Later, or no reply`) is a message: the customer can still answer, and the clock is
//                           the safe default's.
//                  lookup   the branch's own gate names the money path (price, before or after): the booking's money
//                           path settles it, as A5-04's four branches do. `reads` names that value (from path).
//                  message  every other branch.
//                A record gate (`rec`) alone does not make a lookup: it lights a branch the customer still chooses
//                (A7-92 `Alex cancels late`).
//   when, sets   the branch's own gate and booking values, as written.
//   steps        the ids of the branch's own steps, in order (a switched-off step is left out).
//   end, endText, flow
//                as written: `merge` rejoins, `end` stops, `flow` continues in the other flow.
//   rejoinAt     where the walk goes after a merging branch: the next step on the split's own list; null when the branch
//                ends or leaves the flow, or when the split is the last step of its list, where the enclosing branch's
//                rejoinAt decides (the K-01 text; the same as a step's `next`). A branch with no `end` merges (the
//                master's step walker reads it so).
//   answerFields the split's own `gives` keys, typed (ANSWER_TYPES), on a message branch that does not end the flow.
//   effects      see effects.ts.
//
// Read from the step as written (the master's, or a trade's applied step), never per path: which branches are lit on a
// path is the path model's (compiler/src/path); the gate here is the one the path model reads.
import type { Gate, Sets, StepId } from "../graph/types.ts";
import { branchEffects, type Effect, type EffectStep } from "./effects";

export type BranchTag = "message" | "lookup" | "clock";

export type AnswerType = "text" | "integer" | "boolean" | "money" | "time" | "zone" | "id" | "choice";

/** A field a branch's answer carries (K-01 answerField). */
export interface AnswerField {
  name: string;
  type: AnswerType;
}

/** Where code reads the value that settles a lookup branch (K-01 branch.reads). */
export interface BranchReads {
  from: "needs" | "record" | "path";
  key: string;
}

/** One compiled branch (K-01 branch). */
export interface CompiledBranch {
  label: string;
  tag: BranchTag;
  when?: Gate;
  sets?: Sets;
  steps: StepId[];
  end?: "merge" | "end";
  endText?: string;
  flow?: "A" | "B";
  rejoinAt: StepId | null;
  answerFields: AnswerField[];
  effects: Effect[];
  reads?: BranchReads;
}

/** The part of a branch this reads: the master's branch and an applied trade's both fit. */
export interface BranchSource {
  label: string;
  steps: readonly BranchStepSource[];
  end?: "merge" | "end";
  endText?: string;
  flow?: "A" | "B";
  when?: Gate;
  sets?: Sets;
  /** An `off` op switched the branch off: it is not compiled. */
  off?: string;
}

/** The part of a step this reads: the master's step and an applied trade's both fit. */
export interface BranchStepSource extends EffectStep {
  id: StepId;
  type?: string;
  gives?: readonly string[];
  branches?: readonly BranchSource[];
  off?: string;
}

/** A flow's branches that cannot be compiled. */
export class BranchError extends Error {
  override name = "BranchError";
}

/**
 * The type of each key a split's answer gives (the `gives` of a split, both flows; ops/plan/02-contracts.md section 8 names
 * where each lives). A key not here is an error: nothing is typed by a guess.
 */
export const ANSWER_TYPES: Readonly<Record<string, AnswerType>> = {
  kinds: "text",
  business: "id",
  terms: "boolean",
  bill_card: "boolean",
  live: "boolean",
  license_checked: "boolean",
  request: "text",
  safe: "choice",
  who_for: "choice",
  reach_by: "choice",
  times: "time",
  customer: "id",
  service: "id",
  place: "text",
  price_known: "money",
  choice: "choice",
  address: "text",
  booked: "boolean",
  settled: "boolean",
  // a split a trade adds: the tax trade's own A8-x01 and B8-x01 (the only key outside the master's splits in the 243 trades)
  signed: "boolean",
};

/**
 * A label that is only a silence or a time that ran out. Leading button numbers are ignored. `No reply`, `No reply yet`,
 * `No reply: nothing blocked`, `No answer in time`, `No reply by the deadline`, `Not paid in time`, `Still unpaid in time`,
 * `Nothing entered by night`. Not `Later, or no reply`, `No: staff text LATE` or `Done in time`.
 */
export const CLOCK_LABEL =
  /^(?:\d+\s+)?(?:no (?:reply|answer)(?: yet| in time| by [a-z ]+| all day|: .+)?|not [a-z' ]+ in time|still unpaid in time|nothing entered by night)$/i;

const MONEY_KEYS = ["price", "before", "after"] as const;

/** The money key a branch's gate names first (price, before, after), or null. */
function moneyKey(when: Gate | undefined): (typeof MONEY_KEYS)[number] | null {
  if (when === undefined) return null;
  for (const key of MONEY_KEYS) if (when[key] !== undefined) return key;
  return null;
}

/** The tag of a branch (see the rules at the top of this file). */
export function tagOf(branch: BranchSource): BranchTag {
  if (CLOCK_LABEL.test(branch.label.trim())) return "clock";
  if (moneyKey(branch.when) !== null) return "lookup";
  return "message";
}

/** The type of an answer key. */
export function answerTypeOf(key: string): AnswerType {
  const type = ANSWER_TYPES[key];
  if (type === undefined)
    throw new BranchError(`the answer key "${key}" has no type (add it to ANSWER_TYPES)`);
  return type;
}

/** Does the branch go on: it rejoins, and does not end the flow or leave for the other flow? */
export function rejoins(branch: Pick<BranchSource, "end" | "flow">): boolean {
  return branch.end !== "end" && branch.flow === undefined;
}

function liveSteps(steps: readonly BranchStepSource[]): BranchStepSource[] {
  return steps.filter((step) => step.off === undefined);
}

function compileBranch(split: BranchStepSource, branch: BranchSource, next: StepId | null): CompiledBranch {
  const steps = liveSteps(branch.steps);
  const tag = tagOf(branch);
  const out: CompiledBranch = {
    label: branch.label,
    tag,
    steps: steps.map((step) => step.id),
    rejoinAt: rejoins(branch) ? next : null,
    answerFields: [],
    effects: [],
  };
  if (branch.when !== undefined) out.when = structuredClone(branch.when);
  if (branch.sets !== undefined) out.sets = { ...branch.sets };
  if (branch.end !== undefined) out.end = branch.end;
  if (branch.endText !== undefined) out.endText = branch.endText;
  if (branch.flow !== undefined) out.flow = branch.flow;

  if (tag === "lookup") {
    const key = moneyKey(branch.when);
    if (key !== null) out.reads = { from: "path", key };
  }
  if (tag === "message" && branch.end !== "end") {
    out.answerFields = (split.gives ?? []).map((name) => ({ name, type: answerTypeOf(name) }));
  }
  out.effects = branchEffects(branch, steps);
  return out;
}

/**
 * Every split's compiled branches in a flow's main list (steps with their branches nested), by step id. `list` is the flow's
 * main path in the master's order (FlowGraph.path, AppliedFlow.steps). A step an `off` op switched off is skipped with its
 * branches; a branch an `off` op switched off is left out.
 */
export function compileBranches(list: readonly BranchStepSource[]): Record<StepId, CompiledBranch[]> {
  const out: Record<StepId, CompiledBranch[]> = {};

  const visit = (steps: readonly BranchStepSource[]): void => {
    const live = liveSteps(steps);
    live.forEach((step, k) => {
      const next = live[k + 1]?.id ?? null;
      if (step.type === "split") {
        if (step.id in out) throw new BranchError(`${step.id}: two splits with one id in one flow`);
        out[step.id] = (step.branches ?? [])
          .filter((branch) => branch.off === undefined)
          .map((branch) => compileBranch(step, branch, next));
      }
      for (const branch of step.branches ?? []) {
        if (branch.off === undefined) visit(branch.steps);
      }
    });
  };
  visit(list);
  return out;
}

/** The splits that no branch of rejoins: the walk through such a split can never go on (the lint's, T-155). */
export function splitsWithoutRejoin(compiled: Record<StepId, readonly CompiledBranch[]>): StepId[] {
  return Object.entries(compiled)
    .filter(([, branches]) => !branches.some((branch) => rejoins(branch)))
    .map(([id]) => id);
}

/**
 * The splits no branch of which rejoins, each with whether it is a dead end by its host: `hostEnds` is true when the split is
 * the last step of a branch that itself ends the flow or leaves it (nothing after it could run anyway); false when the split
 * is on the main path or in a branch that rejoins, where no branch rejoining would stop a walk that should go on. The master
 * has two such splits, both the last step of an ending branch: A8-51 and B8-54 ("Whose side is it on?": all three branches
 * end the visit).
 */
export function closedSplits(list: readonly BranchStepSource[]): { id: StepId; hostEnds: boolean }[] {
  const out: { id: StepId; hostEnds: boolean }[] = [];
  const visit = (steps: readonly BranchStepSource[], hostEnds: boolean): void => {
    const live = liveSteps(steps);
    live.forEach((step, k) => {
      const branches = (step.branches ?? []).filter((branch) => branch.off === undefined);
      if (step.type === "split" && !branches.some((branch) => rejoins(branch)))
        out.push({ id: step.id, hostEnds: hostEnds && k === live.length - 1 });
      for (const branch of branches) visit(branch.steps, !rejoins(branch));
    });
  };
  visit(list, false);
  return out;
}

/** The branches that continue in the other flow, by split id and label. */
export function flowSwitches(
  compiled: Record<StepId, readonly CompiledBranch[]>,
): { id: StepId; label: string; flow: "A" | "B" }[] {
  const out: { id: StepId; label: string; flow: "A" | "B" }[] = [];
  for (const [id, branches] of Object.entries(compiled)) {
    for (const branch of branches)
      if (branch.flow !== undefined) out.push({ id, label: branch.label, flow: branch.flow });
  }
  return out;
}
