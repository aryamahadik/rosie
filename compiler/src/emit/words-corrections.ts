// A trade's words ops keep every Master Correction in the emitted bundle (T-1132; DL-245; Master Corrections section 3,
// C1, C2, C9 and C10; T-1116's security review, note N1 and new tasks 1 and 3).
//
// The compiler applies the corrections after the trade overlay (corrections/framework.ts): a correction reads the
// trade's applied flow, so it also corrects what a trade's words op wrote at a step it changes (c9.ts's line rules match
// a trade's spelling of a master line). The bundle holds the master graph corrected, and each trade's ops as the trade
// file writes them (trade.ts; K-01 default 5), and a run lays the ops over the corrected master with apply() (Q-35): a
// words op's fields replace the step's, and each variant it writes is merged field by field (overlay-core.js apply(),
// lines 1822 to 1826). So a words op at a step a correction changed would put back the words the correction replaced:
// S2-05's invites (Rosie writing first, C9), a stop reply that names one business (C1), S1-78's contact texted before
// their own text (C9), the line for an ID that does not match (C10), and the lines a correction adds to a `more` the op
// replaces (S2-06, A6-14, B6-13).
//
//   correctWordsOps()          the trade with each such words op emitted with the corrections applied: the op's fields
//                              laid over its master step as apply() lays them (before any slot fill or rename, so the op
//                              keeps its own spelling and slots), the corrections run over that flow (applyCorrections, so
//                              each change carries the frame's tag MC:<id>), and what they changed in the op's own fields
//                              taken back into the op. A run then shows the corrected build's words at that step.
//   assertWordsKeepCorrections()  the guard: on a trade's applied flow, before the corrections run, no correction may
//                              change what a words op wrote at that step; else the build stops, naming the trade, the flow,
//                              the step and the correction. compileTrade() (trade.ts) runs it on every trade it compiles.
//
// Which ops: the words ops at the steps where some correction changes what a words op wrote, all of the flow's words ops
// laid over the master in order, as a run lays them. Each op there is corrected alone, the earlier ones a later op
// writes over included. An op at a step one of the trade's own after, before or branch ops adds is never corrected:
// the corrections change master steps only. A correction that takes away a field a words op writes cannot be kept by a
// words op (apply() lays only the fields it is given), so the build stops there too. The guard reads words ops only: a
// line a `more` op appends is not a words op's, and the run-order sweep (corrections/parity.shard-9.test.ts) shows that
// no correction changes such a line in any of the 243 trades.
import type { FlowLetter, MasterGraphs, FlowGraph } from "../graph/types.ts";
import {
  CORRECTIONS,
  CorrectionError,
  applyCorrections,
  type Change,
  type Correction,
  type PathPart,
} from "../corrections/framework";
import type { LoadedTrade, TradeId, TradeOp } from "../load/trade";
import type { AppliedFlow, AppliedStep, AppliedTrade } from "../overlay/apply";
import { loadOverlayCore } from "../overlay/core";
import { masterShape } from "./flow";

type Obj = Record<string, unknown>;
type WordsOp = Extract<TradeOp, { op: "words" }>;

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** A trade words op the bundle holds with a correction applied, and what the corrections changed in it. */
export interface CorrectedWordsOp {
  trade: TradeId;
  flow: FlowLetter;
  /** The op's place in the flow's ops, from 0: the overlay keeps the trade file's order. */
  op: number;
  /** Its step. */
  at: string;
  /** Each change the corrections made in the op's own fields, in order, each tagged MC:<id>; its path is the op's. */
  changes: Change[];
}

/** A trade with its words ops as the bundle holds them, and each op that was corrected. */
export interface CorrectedOps {
  trade: LoadedTrade;
  corrected: CorrectedWordsOp[];
}

/** A words op whose correction cannot be kept by the op, or that reached the overlay without it. */
export class WordsOpCorrectionError extends CorrectionError {
  override name = "WordsOpCorrectionError";
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let wordsFields: readonly string[] | null = null;

/** The fields a words op replaces: overlay-core.js WORDS_FIELDS, read from the script (it is never copied). */
function fieldsOfWords(): readonly string[] {
  if (wordsFields !== null) return wordsFields;
  const fields = (loadOverlayCore() as unknown as { WORDS_FIELDS?: unknown }).WORDS_FIELDS;
  if (!Array.isArray(fields) || !fields.every((field): field is string => typeof field === "string"))
    throw new Error("overlay-core.js does not export WORDS_FIELDS as a list of field names");
  wordsFields = [...fields];
  return wordsFields;
}

/** Every step of a flow, the steps under branches included, by id. */
function stepIndex(
  steps: readonly AppliedStep[],
  out = new Map<string, AppliedStep>(),
): Map<string, AppliedStep> {
  for (const step of steps) {
    out.set(step.id, step);
    for (const branch of step.branches ?? []) stepIndex(branch.steps, out);
  }
  return out;
}

/** Each loaded master flow in the master file's shape (flow.ts masterShape), made once: nothing changes it. */
const BASES = new WeakMap<FlowGraph, AppliedFlow>();

function baseOf(graph: FlowGraph): AppliedFlow {
  let base = BASES.get(graph);
  if (base === undefined) {
    base = masterShape(graph);
    BASES.set(graph, base);
  }
  return base;
}

/**
 * Whether a change's path lies in what the words op writes: a field it gives (apply() replaces the step's), or a field
 * of a variant it gives (apply() merges the variant field by field), or the whole of such a variant or of `vary`.
 */
export function writtenBy(op: WordsOp, parts: readonly PathPart[]): boolean {
  const [field, key, sub] = parts;
  if (typeof field !== "string") return false;
  if (field !== "vary") return fieldsOfWords().includes(field) && (op as Obj)[field] !== undefined;
  const vary = op.vary as Obj | undefined;
  if (vary === undefined) return false;
  if (key === undefined) return true;
  const patch = vary[String(key)];
  if (!isObj(patch)) return false;
  return sub === undefined || patch[String(sub)] !== undefined;
}

/** The op laid over its step as overlay-core.js apply() lays a words op (lines 1822 to 1826), in place. */
function lay(step: AppliedStep, op: WordsOp): void {
  const raw = op as Obj;
  for (const field of fieldsOfWords())
    if (raw[field] !== undefined) step[field] = structuredClone(raw[field]);
  if (op.vary !== undefined) {
    const vary: Obj = { ...(step.vary ?? {}) };
    for (const [key, patch] of Object.entries(op.vary))
      vary[key] = { ...(isObj(vary[key]) ? vary[key] : {}), ...structuredClone(patch) };
    step.vary = vary;
  }
  step.changed = true;
}

/** A copy of the master flow with each op laid over its step, in order, as a run lays them. */
function laid(base: AppliedFlow, ops: readonly WordsOp[]): AppliedFlow {
  const flow = structuredClone(base);
  const index = stepIndex(flow.steps);
  for (const op of ops) {
    const step = index.get(op.at);
    if (step === undefined) throw new Error(`no master step ${op.at} in flow ${flow.id}`);
    lay(step, op);
  }
  return flow;
}

/**
 * The op with each field it writes as the corrected step holds it. Throws when a correction took away a field the op
 * writes: apply() lays only the fields a words op gives, so no words op can keep that correction.
 */
function takeBack(op: WordsOp, step: AppliedStep, changes: readonly Change[], where: string): WordsOp {
  const raw = op as Obj;
  const out: Obj = { ...raw };
  const gone = (parts: PathPart[]): WordsOpCorrectionError => {
    const by = changes.find(
      (change) => change.parts.length <= parts.length && change.parts.every((part, k) => parts[k] === part),
    );
    return new WordsOpCorrectionError(
      `${where}: ${by?.tag ?? "a correction"} takes away the words op's ${parts.join(".")}, which no words op can keep`,
    );
  };
  for (const field of fieldsOfWords()) {
    if (raw[field] === undefined) continue;
    const value = step[field];
    if (value === undefined) throw gone([field]);
    out[field] = structuredClone(value);
  }
  if (op.vary !== undefined) {
    const vary: Obj = {};
    const held = isObj(step.vary) ? step.vary : {};
    for (const [key, patch] of Object.entries(op.vary)) {
      const now = held[key];
      if (!isObj(now)) throw gone(["vary", key]);
      const copy: Obj = {};
      for (const sub of Object.keys(patch)) {
        const value = now[sub];
        if (value === undefined) throw gone(["vary", key, sub]);
        copy[sub] = structuredClone(value);
      }
      vary[key] = copy;
    }
    out.vary = vary;
  }
  return out as WordsOp;
}

/**
 * The trade with each words op that would put back words a correction replaced emitted with the corrections applied,
 * and a record of each such op (see the top of this file). An op no correction changes is the trade file's own; a trade
 * with none is returned as it was given. `corrections` defaults to CORRECTIONS, the list the master graph is corrected
 * with (flow.ts correctedFlow).
 */
export function correctWordsOps(
  master: MasterGraphs,
  trade: LoadedTrade,
  corrections: readonly Correction[] = CORRECTIONS,
): CorrectedOps {
  let out: LoadedTrade = trade;
  const corrected: CorrectedWordsOp[] = [];
  for (const flow of FLOWS) {
    const base = baseOf(master[flow]);
    const steps = stepIndex(base.steps);
    const ops = trade.flows[flow].ops;
    const words: { op: WordsOp; n: number }[] = [];
    ops.forEach((op, n) => {
      if (op.op === "words" && steps.has(op.at)) words.push({ op, n });
    });
    if (words.length === 0) continue;

    // Every words op laid in order, as a run lays them: the steps where a correction changes what a words op wrote.
    const together = laid(
      base,
      words.map(({ op }) => op),
    );
    const all = applyCorrections({ trade: trade.id, flow: together, slotProblems: [] }, corrections);
    const hit = new Set(
      all.changes
        .filter((change) => words.some(({ op }) => op.at === change.step && writtenBy(op, change.parts)))
        .map((change) => change.step),
    );
    if (hit.size === 0) continue;

    // Each words op at those steps, laid alone over its master step: what the corrections change in its own fields.
    const next = [...ops];
    let fixed = false;
    for (const { op, n } of words) {
      if (!hit.has(op.at)) continue;
      const where = `${trade.id} flow ${flow} ${op.at} (op ${String(n + 1)}, words)`;
      const alone = laid(base, [op]);
      const done = applyCorrections({ trade: trade.id, flow: alone, slotProblems: [] }, corrections);
      const changes = done.changes.filter((change) => change.step === op.at && writtenBy(op, change.parts));
      if (changes.length === 0) continue;
      const step = stepIndex(done.flow.steps).get(op.at);
      if (step === undefined) throw new Error(`${where}: the corrected flow lost the step`);
      next[n] = takeBack(op, step, changes, where);
      corrected.push({ trade: trade.id, flow, op: n, at: op.at, changes });
      fixed = true;
    }
    if (fixed) out = { ...out, flows: { ...out.flows, [flow]: { ...out.flows[flow], ops: next } } };
  }
  return { trade: out, corrected };
}

/**
 * The guard: on `applied`, the trade's applied flow before the corrections run (applyTrade over the loaded master), no
 * correction may change what one of the trade's words ops wrote at that step, since a run would then put back the words
 * the correction replaced. Throws WordsOpCorrectionError naming the trade, the flow, the step and the correction.
 */
export function assertWordsKeepCorrections(
  applied: AppliedTrade,
  trade: LoadedTrade,
  flow: FlowLetter,
  corrections: readonly Correction[] = CORRECTIONS,
): void {
  const ops = trade.flows[flow].ops;
  for (const change of applyCorrections(applied, corrections).changes) {
    let last = -1;
    ops.forEach((op, n) => {
      if (op.op === "words" && op.at === change.step && writtenBy(op, change.parts)) last = n;
    });
    if (last >= 0)
      throw new WordsOpCorrectionError(
        `${trade.id} flow ${flow} ${change.step}: the trade's words op ${String(last + 1)} would put back what ${change.tag} replaced (${change.path})`,
      );
  }
}
