// One flow's master graph as K-01 v1 writes it (T-149; K-01 `flowGraph`, one KV value under .../flow/<flow>).
//
// The stages run in this order, each the one that makes its part:
//   1. the loaded master flow (T-132), in the master file's shape (masterShape: the shape apply() and the corrections
//      read; the loader's `section` is dropped, as overlay/apply.ts does for apply());
//   2. Master Corrections (T-138: applyCorrections, C1 and C2 today; the corrections T-139 to T-141 add run here too);
//   3. sample-value slotting (T-142: slotFlow with the master's own sample table, C6);
//   4. the steps (steps.ts: cards T-144, branches T-145, messages T-134), the record (T-137: compileRecord on the record
//      as corrected and slotted), the routing tables (T-146: compileTradeRouting on the same flow) and the layer lines.
//      Each message's opt-out line (its `stop` marker) is the one stop-marks.ts placeStops() gives it: walkStops() over
//      every path of every trade the bundle holds (T-1116; Q-30), not the marker the master wrote.
// What K-01 holds and no merged stage makes is given to the emitter: the 67 judgment rules (T-1050; until then a
// stand-in, standins.ts).
//
// A step a correction switched off (C2's calls-only steps) stays in `steps`, since the routing tables may name it (the
// rule node S13-33), but no section lists it and no `next` or branch leads to it; its out-of-scope marker is T-148's.
import type { Branch, FlowGraph, FlowLetter, MasterGraphs, Step } from "../graph/types.ts";
import { compileLayerLines } from "../branches";
import { CORRECTIONS, applyCorrections, type Correction } from "../corrections/framework";
import type { AppliedFlow, AppliedTrade } from "../overlay/apply";
import { compileRecord } from "../record";
import { compileTradeRouting } from "../routing";
import { sampleTable, slotFlow } from "../slots";
import { compileSteps, type BundleStep } from "./steps";
import { markSteps, masterHolder, type StopMarks } from "./stop-marks";

type Obj = Record<string, unknown>;

/** The trade id the master's own flow carries through the stages that take an applied trade (none of them reads it). */
export const MASTER_TRADE = "master";

/** K-01 v1 `judgmentRules`: the 67 numbered rules. */
export interface JudgmentRules {
  rules: { number: number; text: string; step: string }[];
}

/** A compiled master graph (K-01 `flowGraph`) and its steps, for the manifest's lint summary. */
export interface CompiledFlow {
  flow: FlowLetter;
  graph: Obj;
  steps: Map<string, BundleStep>;
}

/** A master step as master-<flow>.json writes it: the loader's `section` dropped, its branches' steps the same. */
function plainStep(step: Step): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(step)) {
    if (key === "section") continue;
    out[key] =
      key === "branches"
        ? (value as Branch[]).map((branch) => ({ ...branch, steps: branch.steps.map(plainStep) }))
        : value;
  }
  return out;
}

/** The loaded master flow in the master file's shape, the shape the corrections and the compile stages read. */
export function masterShape(graph: FlowGraph): AppliedFlow {
  return structuredClone({
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
    money: graph.money as unknown as Obj,
    d75: graph.d75,
    switches: graph.switches,
    facts: graph.facts,
    record: graph.record,
    took: graph.tookAt,
    layerLines: graph.layerLines,
  }) as AppliedFlow;
}

/**
 * The master's own flow after the corrections (T-138), before the slotting: the flow the opt-out line's walks read
 * (stop-marks.ts placeStops), where the sample names in `as` still name the people the chats belong to.
 */
export function correctedFlow(
  master: MasterGraphs,
  flow: FlowLetter,
  corrections: readonly Correction[] = CORRECTIONS,
): AppliedTrade {
  const corrected = applyCorrections(
    { trade: MASTER_TRADE, flow: masterShape(master[flow]), slotProblems: [] },
    corrections,
  );
  return { trade: MASTER_TRADE, flow: corrected.flow, slotProblems: [] };
}

/**
 * The master's own flow after the corrections (T-138) and the slotting (T-142): an applied flow with no trade, which
 * the step, routing and record stages read.
 */
export function correctedMaster(
  master: MasterGraphs,
  flow: FlowLetter,
  corrections: readonly Correction[] = CORRECTIONS,
): AppliedTrade {
  const corrected = correctedFlow(master, flow, corrections);
  const table = sampleTable(master, flow, null, master[flow]);
  return { trade: MASTER_TRADE, flow: slotFlow(corrected.flow, table), slotProblems: [] };
}

/**
 * Compiles one flow's master graph (K-01 `flowGraph`). `stops` is placeStops() of the flow over the bundle's trades:
 * each message's opt-out line is the one it gives (none where the walks show no line).
 */
export function compileFlow(
  master: MasterGraphs,
  flow: FlowLetter,
  judgmentRules: JudgmentRules,
  stops: StopMarks,
  corrections: readonly Correction[] = CORRECTIONS,
): CompiledFlow {
  const graph = master[flow];
  if (stops.flow !== flow)
    throw new Error(`the opt-out line's marks are flow ${stops.flow}'s, not flow ${flow}'s`);
  const corrected = correctedMaster(master, flow, corrections);
  const applied: AppliedTrade = {
    ...corrected,
    flow: {
      ...corrected.flow,
      steps: markSteps(stops, corrected.flow.steps, (step) => () => masterHolder(step.id)),
    },
  };
  const compiled = compileSteps(applied);
  const sections = graph.sections.map((section) => ({
    n: section.n,
    title: section.title,
    steps: section.steps.filter((id) => !compiled.off.has(id)),
  }));
  const record = compileRecord({ ...graph, record: applied.flow.record }).record;
  const routing = compileTradeRouting(applied);
  const value: Obj = {
    contract: "bundle.v1",
    flow,
    sections,
    steps: Object.fromEntries(compiled.steps),
    tookAt: graph.tookAt,
    money: structuredClone(graph.money),
    amounts: structuredClone(graph.amounts),
    switches: structuredClone(graph.switches),
    facts: structuredClone(graph.facts),
    layerLines: compileLayerLines(applied.flow.layerLines),
    record,
    routing: {
      hubs: routing.hubs,
      doors: routing.doors,
      anytime: routing.anytime,
      alwaysOn: routing.alwaysOn,
      homes: routing.homes,
      judgmentRules: structuredClone(judgmentRules),
    },
  };
  return { flow, graph: value, steps: compiled.steps };
}
