// The Master Corrections layer (T-138; K-01 v1 manifest and graph; C-060).
//
// Master Corrections (the handover's "3 Master Corrections.md", section 3) lists what holds where the master's steps
// say something else. The compiler applies them after the trade overlay: a correction reads one applied flow (applyTrade,
// T-135) and returns it with its changes made. This file is the frame they run in; c1.ts and c2.ts are the first two
// corrections, and T-139 to T-141 add C3 to C10 the same way.
//
//   - A correction is an object: its id (C1 ...), its title, its source and apply(ctx). It never touches the flow
//     except through the edit context: set(), insert(), remove(), rewriteText(), switchOff() and switchOffBranch().
//     Every one of those records a Change, and the frame (not the correction) gives it the tag `MC:<id>`.
//   - applyCorrections() runs the corrections in the order of their ids, on a copy: the applied flow it was given is
//     not changed. When all have run, it replays the recorded changes on a second copy of the original and checks the
//     result is the corrected flow, deep for deep. A correction that changed anything another way (a write through
//     what step() returned, for one) makes that check fail with UntaggedChangeError, so no changed line goes
//     untagged.
//   - renderDiff() is the compiler's diff output: one line per removed or added value, each starting with its tag.
//     The parity checks (T-139 and later) allow exactly the lines that carry a tag.
//
// Out of scope here: C3 to C10 (T-139 to T-141), and what the corrections' new words finally say where Jay decides
// them (Q-01: the stop replies' exact words).
import { isDeepStrictEqual } from "node:util";
import type { FlowLetter } from "../graph/types.ts";
import type { TradeId } from "../load/trade";
import type { AppliedFlow, AppliedStep, AppliedTrade } from "../overlay/apply";
import { c1 } from "./c1";
import { c10 } from "./c10";
import { c2 } from "./c2";
import { c9 } from "./c9";

/** A correction's id: C1 to C10 of Master Corrections section 3. */
export type CorrectionId = `C${number}`;

/** The tag every changed line carries in the diff output. */
export type CorrectionTag = `MC:${CorrectionId}`;

/** One step of a path into a step's fields: a key, or an index into an array. */
export type PathPart = string | number;

/** What one edit did: set a value (a new key included), insert an array element, or remove an element or a key. */
export type ChangeOp = "set" | "insert" | "remove";

/** One recorded edit. `step` is the step's id; `parts` is the path inside that step (branches included: `branches`, 1, `off`). */
export interface Change {
  correction: CorrectionId;
  /** `MC:<correction>`, given by the frame. */
  tag: CorrectionTag;
  flow: FlowLetter;
  trade: TradeId;
  step: string;
  /** The path as text: `more[14]`, `say[1][2]`, `branches[1].off`. */
  path: string;
  parts: PathPart[];
  op: ChangeOp;
  /** The value before (`set` of an existing value, `remove`); absent for `insert` and for `set` of a new key. */
  before?: unknown;
  /** The value after (`set`, `insert`); absent for `remove`. */
  after?: unknown;
}

/** The step fields rewriteText() reads when it is not told which: the words of a step. */
export const WORD_FIELDS: readonly string[] = [
  "does",
  "more",
  "say",
  "vary",
  "rule",
  "title",
  "q",
  "layerAdd",
];

/** Why a correction cannot be applied, or a result that is not what its changes say. */
export class CorrectionError extends Error {
  override name = "CorrectionError";
}

/** The corrected flow differs from the original with the recorded changes replayed: something changed without a tag. */
export class UntaggedChangeError extends CorrectionError {
  override name = "UntaggedChangeError";
}

/** A line as the master writes it (a string: the whole line) or as a trade may have renamed it (a pattern), and what holds instead. */
export type LineRule = readonly [match: string | RegExp, held: string];

/** What a correction may do to an applied flow, and nothing else. Every edit is recorded with the correction's tag. */
export interface EditContext {
  readonly flow: FlowLetter;
  readonly trade: TradeId;
  /** The flow's step ids in page order, branch steps included. */
  stepIds(): string[];
  /** A step of the flow (branch steps included), or undefined. Read only: a write through it is caught as untagged. */
  step(id: string): Readonly<AppliedStep> | undefined;
  /** A step that must be there: CorrectionError when it is not. */
  need(id: string): Readonly<AppliedStep>;
  /** Sets the value at `parts` of the step (an existing array index, or a key, new or not). */
  set(id: string, parts: readonly PathPart[], value: unknown): void;
  /** Inserts `value` at `index` of the array at `parts` (index = length appends). */
  insert(id: string, parts: readonly PathPart[], index: number, value: unknown): void;
  /** Removes the array element or the key at `parts`. */
  remove(id: string, parts: readonly PathPart[]): void;
  /**
   * Calls `rewrite(text, parts)` for every string in the step's fields (default: WORD_FIELDS; the branches' steps are
   * other steps) and sets each one it returns another text for. Returns how many it changed.
   */
  rewriteText(
    id: string,
    rewrite: (text: string, parts: readonly PathPart[]) => string,
    fields?: readonly string[],
  ): number;
  /**
   * rewriteText() with rules: a text that is exactly a rule's string, or that a rule's pattern matches, is changed
   * (the first rule that fits; `$1` in the new text is the pattern's first group). A trade's overlay renames words
   * inside the master's lines ("shop-added" is "clinic-added"), so a pattern covers those spellings.
   */
  rewriteLines(id: string, rules: readonly LineRule[], fields?: readonly string[]): number;
  /** Switches the step off, as an `off` op does: `off` holds the reason. Not offered, not lit, on any path. */
  switchOff(id: string, why: string): void;
  /** Switches one branch (by label) of the step off, as an `off` op does. */
  switchOffBranch(id: string, label: string, why: string): void;
}

/** One correction of Master Corrections section 3. */
export interface Correction {
  id: CorrectionId;
  title: string;
  /** Where it comes from: the Master Corrections row and the decisions it names. */
  source: string;
  apply(ctx: EditContext): void;
}

/** A trade's flow with the corrections made, and every change they made. Usable wherever an AppliedTrade is. */
export interface CorrectedTrade extends AppliedTrade {
  /** The corrections that ran, in order. */
  corrections: CorrectionId[];
  /** Every edit, in the order made, each with its tag. */
  changes: Change[];
}

/**
 * The corrections this build applies, in the order they run (the order of their ids). T-139 to T-141 add C3 to C10
 * here: each is one file beside c1.ts, and each change it makes is tagged by the frame.
 */
export const CORRECTIONS: readonly Correction[] = [c1, c2, c9, c10];

/** The tag of a correction id. */
export function tagOf(id: CorrectionId): CorrectionTag {
  return `MC:${id}`;
}

const ID_PATTERN = /^C([1-9]|10)$/;

function numberOf(id: CorrectionId): number {
  return Number(id.slice(1));
}

function checkList(list: readonly Correction[]): void {
  let last = 0;
  for (const correction of list) {
    if (!ID_PATTERN.test(correction.id))
      throw new CorrectionError(`${correction.id} is not a correction of Master Corrections (C1 to C10)`);
    const n = numberOf(correction.id);
    if (n <= last)
      throw new CorrectionError(
        `${correction.id} is out of order or used twice: corrections run in id order`,
      );
    last = n;
  }
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null;
}

/** Every step of the flow by id, the steps under branches included; a step id used twice is refused. */
function indexSteps(flow: AppliedFlow): Map<string, AppliedStep> {
  const index = new Map<string, AppliedStep>();
  const visit = (steps: AppliedStep[]): void => {
    for (const step of steps) {
      if (index.has(step.id))
        throw new CorrectionError(`${flow.id}: step ${step.id} is used twice, so a change cannot name it`);
      index.set(step.id, step);
      for (const branch of step.branches ?? []) visit(branch.steps);
    }
  };
  visit(flow.steps);
  return index;
}

/** `more[14]`, `say[1][2]`, `branches[1].off`. */
export function pathText(parts: readonly PathPart[]): string {
  let out = "";
  for (const part of parts)
    out += typeof part === "number" ? `[${String(part)}]` : out === "" ? part : `.${part}`;
  return out;
}

/** The container that holds the last part of `parts` in `root`, and that last part. */
function parentOf(root: Obj, parts: readonly PathPart[], where: string): { holder: Obj; key: PathPart } {
  const last = parts.at(-1);
  if (last === undefined) throw new CorrectionError(`${where}: an edit needs a path`);
  let holder: unknown = root;
  for (const part of parts.slice(0, -1)) {
    holder = isObj(holder) ? holder[part as string] : undefined;
    if (!isObj(holder)) throw new CorrectionError(`${where}: nothing at ${pathText(parts)}`);
  }
  if (!isObj(holder)) throw new CorrectionError(`${where}: nothing at ${pathText(parts)}`);
  return { holder: holder, key: last };
}

/**
 * The same edit, as the context makes it and as the replay makes it. For an insert, `parts` ends with the index to insert
 * at. Returns the value before, when there was one.
 */
function perform(
  step: AppliedStep,
  op: ChangeOp,
  parts: readonly PathPart[],
  value: unknown,
  where: string,
): unknown {
  const { holder, key } = parentOf(step, parts, where);
  if (op === "insert") {
    if (!Array.isArray(holder))
      throw new CorrectionError(`${where}: ${pathText(parts.slice(0, -1))} is not a list`);
    if (typeof key !== "number" || key < 0 || key > holder.length)
      throw new CorrectionError(`${where}: no place for ${pathText(parts)}`);
    holder.splice(key, 0, structuredClone(value));
    return undefined;
  }
  if (op === "remove") {
    if (Array.isArray(holder)) {
      if (typeof key !== "number" || key < 0 || key >= holder.length)
        throw new CorrectionError(`${where}: nothing at ${pathText(parts)}`);
      const before: unknown = holder[key];
      holder.splice(key, 1);
      return before;
    }
    if (!(key in holder)) throw new CorrectionError(`${where}: nothing at ${pathText(parts)}`);
    const before = holder[key as string];
    Reflect.deleteProperty(holder, key);
    return before;
  }
  if (Array.isArray(holder) && (typeof key !== "number" || key < 0 || key >= holder.length))
    throw new CorrectionError(`${where}: nothing at ${pathText(parts)} to set`);
  const before = holder[key as string];
  holder[key as string] = structuredClone(value);
  return before;
}

/** The recorded changes made again, in order, on a copy of the original flow. */
function replay(flow: AppliedFlow, changes: readonly Change[]): void {
  const index = indexSteps(flow);
  for (const change of changes) {
    const step = index.get(change.step);
    const where = `${change.tag} ${change.step}`;
    if (step === undefined) throw new UntaggedChangeError(`${where}: the step is not in the original flow`);
    perform(step, change.op, change.parts, change.after, where);
  }
}

function makeContext(
  correction: Correction,
  flow: AppliedFlow,
  trade: TradeId,
  index: Map<string, AppliedStep>,
  changes: Change[],
): EditContext {
  const tag = tagOf(correction.id);
  const stepOf = (id: string): AppliedStep => {
    const step = index.get(id);
    if (step === undefined) throw new CorrectionError(`${tag}: no step ${id} in flow ${flow.id}`);
    return step;
  };
  const record = (
    id: string,
    op: ChangeOp,
    parts: readonly PathPart[],
    before: unknown,
    after: unknown,
  ): void => {
    const change: Change = {
      correction: correction.id,
      tag,
      flow: flow.id,
      trade,
      step: id,
      path: pathText(parts),
      parts: [...parts],
      op,
    };
    if (op !== "insert" && before !== undefined) change.before = structuredClone(before);
    if (op !== "remove") change.after = structuredClone(after);
    changes.push(change);
  };
  const ctx: EditContext = {
    flow: flow.id,
    trade,
    stepIds: () => [...index.keys()],
    step: (id) => index.get(id),
    need: (id) => stepOf(id),
    set(id, parts, value) {
      const before = perform(stepOf(id), "set", parts, value, `${tag} ${id}`);
      record(id, "set", parts, before, value);
    },
    insert(id, parts, at, value) {
      perform(stepOf(id), "insert", [...parts, at], value, `${tag} ${id}`);
      record(id, "insert", [...parts, at], undefined, value);
    },
    remove(id, parts) {
      const before = perform(stepOf(id), "remove", parts, undefined, `${tag} ${id}`);
      record(id, "remove", parts, before, undefined);
    },
    rewriteText(id, rewrite, fields = WORD_FIELDS) {
      const step = stepOf(id);
      const edits: { parts: PathPart[]; text: string }[] = [];
      const walk = (value: unknown, parts: PathPart[]): void => {
        if (typeof value === "string") {
          const next = rewrite(value, parts);
          if (next !== value) edits.push({ parts, text: next });
        } else if (Array.isArray(value)) {
          value.forEach((item, k) => {
            walk(item, [...parts, k]);
          });
        } else if (isObj(value)) {
          for (const [key, item] of Object.entries(value)) walk(item, [...parts, key]);
        }
      };
      for (const field of fields) if (field in step) walk(step[field], [field]);
      for (const edit of edits) ctx.set(id, edit.parts, edit.text);
      return edits.length;
    },
    rewriteLines(id, rules, fields = WORD_FIELDS) {
      return ctx.rewriteText(
        id,
        (text) => {
          for (const [match, held] of rules) {
            if (typeof match === "string") {
              if (text === match) return held;
            } else if (match.test(text)) return text.replace(match, held);
          }
          return text;
        },
        fields,
      );
    },
    switchOff(id, why) {
      ctx.set(id, ["off"], why);
    },
    switchOffBranch(id, label, why) {
      const at = (stepOf(id).branches ?? []).findIndex((branch) => branch.label === label);
      if (at < 0) throw new CorrectionError(`${tag}: step ${id} has no branch '${label}'`);
      ctx.set(id, ["branches", at, "off"], why);
    },
  };
  return ctx;
}

/**
 * Applies Master Corrections to one trade's applied flow (applyTrade of T-135). `list` is the corrections to run
 * (default CORRECTIONS), in id order. The applied trade given is not changed. Throws CorrectionError when a correction
 * names a step the flow does not have, and UntaggedChangeError when a change was made without being recorded.
 */
export function applyCorrections(
  applied: AppliedTrade,
  list: readonly Correction[] = CORRECTIONS,
): CorrectedTrade {
  checkList(list);
  const flow = structuredClone(applied.flow);
  const index = indexSteps(flow);
  const changes: Change[] = [];
  for (const correction of list)
    correction.apply(makeContext(correction, flow, applied.trade, index, changes));

  const original = structuredClone(applied.flow);
  replay(original, changes);
  if (!isDeepStrictEqual(original, flow))
    throw new UntaggedChangeError(
      `${applied.trade} flow ${flow.id}: the corrected flow is not the original with its tagged changes made`,
    );
  return {
    ...applied,
    flow,
    corrections: list.map((correction) => correction.id),
    changes,
  };
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The compiler's diff output for the changes: for each, a line `- <before>` when a value went and a line `+ <after>`
 * when one came, every line starting with the change's tag. The parity checks read it line by line: a line without a
 * tag is a difference nothing allows.
 */
export function renderDiff(changes: readonly Change[]): string[] {
  const lines: string[] = [];
  for (const change of changes) {
    const where = `${change.trade} ${change.flow} ${change.step} ${change.path}`;
    if (change.op !== "insert" && "before" in change)
      lines.push(`${change.tag} - ${where}: ${show(change.before)}`);
    if (change.op !== "remove") lines.push(`${change.tag} + ${where}: ${show(change.after)}`);
    else if (!("before" in change)) lines.push(`${change.tag} - ${where}`);
  }
  return lines;
}
