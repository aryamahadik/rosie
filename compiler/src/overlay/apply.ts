// The overlay applier (T-135; K-01 v1 'one compiled overlay per trade').
//
// applyTrade(flow, trade) lays one trade over one master flow exactly as overlay-core.js apply() does (lines
// 1794-1866 of the master's script): it fills the plug-in slots with the trade's switches and settings, runs the
// trade's rename pairs, lays its cast, names, story, money labels and amounts, applies its ops in order (words, more,
// after, before, branch, off) and fills the slots again in the trade's own words. NQ-PB-2 answered WRAP: the work is
// done by the master's script, loaded unchanged (core.ts); this file adds the typed input and output and the strict
// checks in front of it. The master's apply() only collects its complaints in a list and goes on; here a complaint
// throws.
//
//   - an op whose `at` is not a step of the flow (or of an earlier op)  -> UnknownStepError
//   - an `off` that names a branch the step does not have, or a `branch` op with no label -> MissingBranchLabelError
//   - an `off` with no why                                              -> OffWithoutWhyError
//   - any other complaint of apply() (a branch op on a step that is not a decision, an op with no steps, an op the
//     script does not know)                                             -> OverlayApplyError
//
// Out of scope here: per-path lighting and words (T-136), and Master Corrections on top (T-138 to T-141).
//
// What goes in: a FlowGraph (loadMaster, T-132) and a LoadedTrade (loadTrade, T-133). apply() reads a master flow and
// a trade file in the files' own shape, so both are put back into that shape first: the flow loses the `section` the
// loader derived (nothing in apply() reads it), and the trade is rebuilt from its loaded parts. Master Corrections R2
// dropped `src`, `prop` and the trade's authoring fields on loading; apply() reads none of them. Nothing the caller
// passes in is changed.
import type {
  AmountTable,
  Branch,
  FlowGraph,
  FlowLetter,
  Lane,
  LayerLine,
  MasterRecord,
  Message,
  NotInEntry,
  Step,
  StepId,
} from "../graph/types.ts";
import type { LoadedTrade, TradeId, TradeMessage } from "../load/trade";
import { loadOverlayCore } from "./core";

/** The kinds of complaint apply() makes. */
export type OverlayProblem =
  | "unknown-step"
  | "missing-branch-label"
  | "off-without-why"
  | "not-a-decision"
  | "needs-steps"
  | "unknown-op";

/** A trade that cannot be applied to a flow. `problems` holds every complaint, in op order; the message holds the first. */
export class OverlayApplyError extends Error {
  override name = "OverlayApplyError";
  readonly code: OverlayProblem;
  readonly trade: TradeId;
  readonly flow: FlowLetter;
  readonly problems: string[];

  constructor(code: OverlayProblem, trade: TradeId, flow: FlowLetter, problems: string[]) {
    super(`${trade}: ${problems[0] ?? code}`);
    this.code = code;
    this.trade = trade;
    this.flow = flow;
    this.problems = problems;
  }
}

/** An op names a step that the flow (and the ops before it) do not have. */
export class UnknownStepError extends OverlayApplyError {
  override name = "UnknownStepError";
}

/** An `off` names a branch label the step does not have, or a `branch` op gives its branch no label. */
export class MissingBranchLabelError extends OverlayApplyError {
  override name = "MissingBranchLabelError";
}

/** An `off` gives no reason. */
export class OffWithoutWhyError extends OverlayApplyError {
  override name = "OffWithoutWhyError";
}

/** A message in an applied flow: a master message, or one a trade writes with no text. */
export type AppliedMessage = Message | TradeMessage;

/** A branch of an applied flow: a master branch, or one an op added (`own`), or one an `off` op switched off. */
export type AppliedBranch = Omit<Branch, "steps"> & {
  steps: AppliedStep[];
  /** An op added this branch. */
  own?: true;
  /** An `off` op switched this branch off, with its reason. */
  off?: string;
};

/**
 * A step of an applied flow, as overlay-core.js leaves it: a master step without the loader's `section`, or a step an
 * op added (`own`). `changed` marks a step a words, more or branch op touched; `off` carries the reason of an `off` op.
 * The fields apply() or the slot fill adds besides these (`timed`, for one) stay as it writes them.
 */
export type AppliedStep = Omit<Step, "section" | "branches" | "say" | "vary" | "form"> & {
  say?: AppliedMessage[];
  form?: (string[] | [label: string])[];
  vary?: Record<string, unknown>;
  branches?: AppliedBranch[];
  own?: true;
  changed?: true;
  off?: string;
  [extra: string]: unknown;
};

/** The flow apply() returns: the master flow's header, with the trade's cast, names, story, labels and amounts laid over it. */
export interface AppliedFlow {
  id: FlowLetter;
  title: string;
  short: string;
  story: string;
  intro: string;
  cast: Record<string, string>;
  names: Record<string, string>;
  lanes: Lane[];
  amounts: AmountTable;
  steps: AppliedStep[];
  notIn: NotInEntry[];
  money: Record<string, unknown>;
  d75: boolean;
  switches: Record<string, unknown>;
  facts: Record<string, unknown>;
  record: MasterRecord;
  took: StepId;
  layerLines: LayerLine[];
}

/** One trade applied to one flow. */
export interface AppliedTrade {
  trade: TradeId;
  flow: AppliedFlow;
  /** apply()'s `slotProblems`: the plug-in slots' own complaints (a cutoff already past, for one); empty when none. */
  slotProblems: string[];
}

type Obj = Record<string, unknown>;

/** The step as the master file writes it: no `section`, its branches and their steps the same. */
function plainStep(step: Step): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(step)) {
    if (key === "section") continue;
    out[key] = key === "branches" ? (value as Branch[]).map(plainBranch) : value;
  }
  return out;
}

function plainBranch(branch: Branch): Obj {
  return { ...branch, steps: branch.steps.map(plainStep) };
}

/** The flow in the shape of master-A.json / master-B.json, which is what apply() reads. */
function masterOf(graph: FlowGraph): Obj {
  return {
    id: graph.flow,
    title: graph.title,
    short: graph.short,
    story: graph.story,
    intro: graph.intro,
    cast: graph.cast,
    names: graph.names,
    lanes: graph.lanes,
    amounts: graph.amounts,
    steps: graph.path.map(plainStep),
    notIn: graph.notIn,
    money: graph.money,
    d75: graph.d75,
    switches: graph.switches,
    facts: graph.facts,
    record: graph.record,
    took: graph.tookAt,
    layerLines: graph.layerLines,
  };
}

/**
 * The trade in the shape of a trade file, for one flow: the parts apply() reads. The ops are copied, because the
 * script puts some of their values into the flow and fills them in place afterwards.
 */
function overlayOf(trade: LoadedTrade, flow: FlowLetter): Obj {
  const part = trade.flows[flow];
  const plugin: Obj = {};
  if (trade.facts !== null) plugin["pf.facts"] = trade.facts;
  if (trade.switches !== null) plugin["pf.switches"] = trade.switches;
  if (trade.settings !== null) plugin["pf.settings"] = trade.settings;
  const overlay: Obj = structuredClone({
    id: trade.id,
    plugin,
    rename: { [flow]: part.rename },
    story: { [flow]: part.story },
    money: { [flow]: part.money },
    slots: { [flow]: part.slotRows },
    [flow]: { ops: part.ops },
  });
  if (part.cast !== null) overlay.cast = structuredClone({ [flow]: part.cast });
  if (part.names !== null) overlay.names = structuredClone({ [flow]: part.names });
  return overlay;
}

/** What apply() complains about, by the end of its message (the script is vendored and checked by checksum). */
function classify(problem: string): OverlayProblem {
  if (/: no master step \S+ in flow [AB]$/.test(problem)) return "unknown-step";
  if (problem.includes(": no branch '") || problem.endsWith(": needs a branch with a label"))
    return "missing-branch-label";
  if (problem.endsWith(": say why")) return "off-without-why";
  if (problem.endsWith(" isn't a decision")) return "not-a-decision";
  if (problem.endsWith(": needs steps")) return "needs-steps";
  return "unknown-op";
}

function refuse(code: OverlayProblem, trade: TradeId, flow: FlowLetter, problems: string[]): never {
  switch (code) {
    case "unknown-step":
      throw new UnknownStepError(code, trade, flow, problems);
    case "missing-branch-label":
      throw new MissingBranchLabelError(code, trade, flow, problems);
    case "off-without-why":
      throw new OffWithoutWhyError(code, trade, flow, problems);
    default:
      throw new OverlayApplyError(code, trade, flow, problems);
  }
}

/**
 * Applies one trade to one master flow, as overlay-core.js apply() does. `flow` is a loaded master flow (loadMaster)
 * and `trade` a loaded trade (loadTrade); the trade's ops, renames, cast, names, story, labels and amounts for
 * `flow.flow` are used. Throws UnknownStepError, MissingBranchLabelError or OffWithoutWhyError (all OverlayApplyError)
 * on the three refused inputs, and OverlayApplyError on any other complaint apply() makes. Neither input is changed.
 */
export function applyTrade(flow: FlowGraph, trade: LoadedTrade): AppliedTrade {
  const letter = flow.flow;
  const ops = trade.flows[letter].ops;

  // An off with no why is refused before apply() runs: the script would note it and still switch the step off.
  ops.forEach((op, n) => {
    if (op.op === "off" && (typeof op.why !== "string" || op.why.trim() === "")) {
      const where = `${letter} op ${String(n + 1)} (off ${op.at})`;
      refuse("off-without-why", trade.id, letter, [`${where}: say why`]);
    }
  });

  const result = loadOverlayCore().apply(masterOf(flow), overlayOf(trade, letter), letter);
  const first = result.errors[0];
  if (first !== undefined) refuse(classify(first), trade.id, letter, result.errors);

  return { trade: trade.id, flow: result.flow as AppliedFlow, slotProblems: result.slotProblems ?? [] };
}
