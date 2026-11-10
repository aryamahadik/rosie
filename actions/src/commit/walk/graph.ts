// The flow graph as the walk reads it (T-1139; K-01 v1, contracts/bundle `flowGraph`): its main paths, steps, branches
// and cards, narrowed from the parsed KV value field by field. The walk takes the turn's pinned graph as its own
// dependency (DL-322 ruling 4; T-1141 binds it), since the commit's writesOf port is given no bundle.
//
// A step the graph does not hold reads as null, so the walk refuses it (K-01 README: "a step a bundle does not hold is
// not reachable"). A step it holds whose fields the walk reads are not K-01 v1's shape is refused too
// (stepNotWellFormed), never read in part. Only the fields the walk reads are narrowed; the words (say, more, does) are
// never kept, so nothing here can carry them into a row or an error.

import { WalkRefusedError } from "./errors";

/** A flow (K-01 v1 flowLetter): A, the customer comes to the business; B, the business goes to the customer. */
export type FlowLetter = "A" | "B";

/** K-01 v1 branch.tag: message, the model may choose it; lookup, code settles it; clock, a clock row settles it. */
export type BranchTag = "message" | "lookup" | "clock";

/** K-01 v1 `effect`, as the walk reads it: its kind, what it acts on and, for a message, who gets it. */
export interface GraphEffect {
  readonly kind: string;
  readonly ref: string;
  readonly to: readonly string[];
}

/** K-01 v1 `branch`, as the walk reads it. */
export interface GraphBranch {
  /** The label, word for word as the bundle writes it. */
  readonly label: string;
  readonly tag: BranchTag;
  /** The branch's own steps, in order (K-01 v1 branch.steps). */
  readonly steps: readonly string[];
  /** end: this path stops; merge: it rejoins after its split (an end left out merges: K-01 README). */
  readonly end: "merge" | "end";
  /** The text an ending branch ends with, or null. */
  readonly endText: string | null;
  readonly rejoinAt: string | null;
  /** The flow a branch continues in, when it names one (K-01 v1 branch.flow), or null. */
  readonly flow: FlowLetter | null;
  /** What the choice causes, which the compiler reads from the branch's own steps (compiler/src/branches/effects.ts). */
  readonly effects: readonly GraphEffect[];
}

/** K-01 v1 `card`, the fields the walk reads: the safe default and the Clock. */
export interface GraphCard {
  readonly safeDefault: string | null;
  /** clockLine with its words, or step9Default; null when the card states none. */
  readonly clock: { readonly from: string; readonly text: string | null } | null;
}

/** K-01 v1 `step`, as the walk reads it. */
export interface GraphStep {
  readonly id: string;
  /** Who acts (K-01 v1 lane): owner, san (Rosie), staff, cust, agent, pay, out or other. */
  readonly who: string;
  /** Who it is for, when someone is, else null. */
  readonly to: string | null;
  /** How it happens (K-01 v1 via): chat, msg, portal, page, sync, auto, visit, call or email. */
  readonly via: string;
  /** Whether it has its own gate (K-01 v1 step.when). */
  readonly gated: boolean;
  /** Whether it is a split (K-01 v1 type split), with its branches. */
  readonly split: boolean;
  readonly branches: readonly GraphBranch[];
  readonly gives: readonly string[];
  readonly tells: readonly string[];
  /** How many buttons the messages Rosie sends in it carry (K-01 v1 message elements.buttons). */
  readonly buttons: number;
  /** The next step on its own list, or null where the list ends (K-01 v1 step.next). */
  readonly next: string | null;
  readonly card: GraphCard | null;
}

/** A split's branch whose own steps list a step. */
export interface Enclosing {
  readonly split: GraphStep;
  readonly branch: GraphBranch;
}

/** One flow graph of the turn's pinned bundle, as the walk reads it. */
export interface FlowGraph {
  readonly flow: FlowLetter;
  /** The step, or null when the graph does not hold it. Throws stepNotWellFormed for a step held in another shape. */
  step(id: string): GraphStep | null;
  /** Whether the step is on its section's main path (K-01 v1 section.steps). */
  onMainPath(id: string): boolean;
  /** The branches of the graph's splits whose own steps list the step. */
  enclosing(id: string): readonly Enclosing[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FLOWS: readonly FlowLetter[] = ["A", "B"];
const TAGS: readonly BranchTag[] = ["message", "lookup", "clock"];

/** A narrowing that failed: the step is not K-01's shape. */
function notWellFormed(stepId: string): WalkRefusedError {
  return new WalkRefusedError("stepNotWellFormed", [stepId]);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A list of non-empty strings; left out reads as empty when `optional`. */
function textsOf(value: unknown, stepId: string, optional: boolean): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw notWellFormed(stepId);
  const listed: unknown[] = value;
  if (!listed.every(isText)) throw notWellFormed(stepId);
  return [...listed];
}

/** A text that may be left out (null), or a non-empty string. */
function optionalText(value: unknown, stepId: string): string | null {
  if (value === undefined) return null;
  if (!isText(value)) throw notWellFormed(stepId);
  return value;
}

/** A step id or null, where K-01 requires the field (next, rejoinAt). */
function stepRef(value: unknown, stepId: string): string | null {
  if (value === null) return null;
  if (!isText(value)) throw notWellFormed(stepId);
  return value;
}

function effectOf(value: unknown, stepId: string): GraphEffect {
  if (!isRecord(value) || !isText(value.kind) || !isText(value.ref)) throw notWellFormed(stepId);
  return { kind: value.kind, ref: value.ref, to: textsOf(value.to, stepId, true) };
}

const ENDS: readonly GraphBranch["end"][] = ["merge", "end"];

function branchOf(value: unknown, stepId: string): GraphBranch {
  if (!isRecord(value) || !isText(value.label) || !Array.isArray(value.effects)) throw notWellFormed(stepId);
  const effects: unknown[] = value.effects;
  const tag = TAGS.find((each) => each === value.tag);
  // An end left out merges (K-01 README "A branch with no end merges").
  const end = value.end === undefined ? "merge" : ENDS.find((each) => each === value.end);
  const flow = value.flow === undefined ? null : FLOWS.find((each) => each === value.flow);
  if (tag === undefined || end === undefined || flow === undefined) throw notWellFormed(stepId);
  return {
    label: value.label,
    tag,
    steps: textsOf(value.steps, stepId, false),
    end,
    endText: optionalText(value.endText, stepId),
    rejoinAt: stepRef(value.rejoinAt, stepId),
    flow,
    effects: effects.map((effect) => effectOf(effect, stepId)),
  };
}

function clockOf(value: unknown, stepId: string): GraphCard["clock"] {
  if (value === undefined) return null;
  if (!isRecord(value) || !isText(value.from)) throw notWellFormed(stepId);
  return { from: value.from, text: optionalText(value.text, stepId) };
}

function cardOf(value: unknown, stepId: string): GraphCard | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw notWellFormed(stepId);
  return { safeDefault: optionalText(value.safeDefault, stepId), clock: clockOf(value.clock, stepId) };
}

/** The buttons on the messages Rosie (`san`) sends in the step (K-01 v1 message elements.buttons). */
function buttonsOf(value: unknown, stepId: string): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw notWellFormed(stepId);
  const messages: unknown[] = value;
  let buttons = 0;
  for (const message of messages) {
    if (!isRecord(message) || !isText(message.from)) throw notWellFormed(stepId);
    const { elements } = message;
    if (message.from !== "san" || elements === undefined) continue;
    if (!isRecord(elements)) throw notWellFormed(stepId);
    if (elements.buttons === undefined) continue;
    if (!Array.isArray(elements.buttons)) throw notWellFormed(stepId);
    const listed: unknown[] = elements.buttons;
    buttons += listed.length;
  }
  return buttons;
}

function stepOf(id: string, value: unknown): GraphStep {
  if (!isRecord(value) || value.id !== id || !isText(value.who) || !isText(value.via))
    throw notWellFormed(id);
  if (value.type !== undefined && value.type !== "split") throw notWellFormed(id);
  if (!Object.hasOwn(value, "next")) throw notWellFormed(id);
  const split = value.type === "split";
  // A split has its branches (at least one); a plain step has none (K-01 v1 step.type, step.branches).
  if (split ? !Array.isArray(value.branches) || value.branches.length === 0 : value.branches !== undefined) {
    throw notWellFormed(id);
  }
  const listed: unknown[] = Array.isArray(value.branches) ? value.branches : [];
  return {
    id,
    who: value.who,
    to: optionalText(value.to, id),
    via: value.via,
    gated: value.when !== undefined,
    split,
    branches: listed.map((branch) => branchOf(branch, id)),
    gives: textsOf(value.gives, id, true),
    tells: textsOf(value.tells, id, true),
    buttons: buttonsOf(value.say, id),
    next: stepRef(value.next, id),
    card: cardOf(value.card, id),
  };
}

/** Every section's main-path steps (K-01 v1 section.steps); a section not in K-01's shape lists none. */
function mainPathOf(value: unknown): Set<string> {
  const main = new Set<string>();
  if (!Array.isArray(value)) return main;
  const sections: unknown[] = value;
  for (const section of sections) {
    if (!isRecord(section) || !Array.isArray(section.steps)) continue;
    const listed: unknown[] = section.steps;
    for (const id of listed) if (isText(id)) main.add(id);
  }
  return main;
}

/**
 * One flow graph of the pinned bundle, when `value` is K-01 v1's graph of `flow` (its contract, its flow, its steps);
 * otherwise the walk has no graph to read: flowNotInBundle.
 */
export function flowGraphOf(value: unknown, flow: FlowLetter): FlowGraph {
  if (!isRecord(value) || value.contract !== "bundle.v1" || value.flow !== flow || !isRecord(value.steps)) {
    throw new WalkRefusedError("flowNotInBundle", [flow]);
  }
  const steps = value.steps;
  const main = mainPathOf(value.sections);
  const read = new Map<string, GraphStep>();
  const step = (id: string): GraphStep | null => {
    if (!Object.hasOwn(steps, id)) return null;
    const known = read.get(id);
    if (known !== undefined) return known;
    const narrowed = stepOf(id, steps[id]);
    read.set(id, narrowed);
    return narrowed;
  };
  const enclosing = (id: string): Enclosing[] => {
    const found: Enclosing[] = [];
    for (const key of Object.keys(steps)) {
      const split = step(key);
      if (split === null) continue;
      for (const branch of split.branches) if (branch.steps.includes(id)) found.push({ split, branch });
    }
    return found;
  };
  return { flow, step, onMainPath: (id) => main.has(id), enclosing };
}

/** The flow graph a step is read in: its own flow for an A or B step, the turn's for a shared (S) one (K-01 v1 stepId). */
export function flowOfStep(stepId: string, turnFlow: FlowLetter): FlowLetter {
  if (stepId.startsWith("A")) return "A";
  if (stepId.startsWith("B")) return "B";
  return turnFlow;
}
