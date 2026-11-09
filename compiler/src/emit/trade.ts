// One trade's compiled overlay as K-01 v1 writes it (T-149; K-01 `tradeOverlay`, one KV value under .../trade/<id>).
//
// The overlay keeps the trade's ops in order rather than words applied per step (K-01 default 5), so a run applies them
// with apply() as written (Q-35). What each part is and where it comes from:
//   trade, facts, pluginText    the loaded trade file (T-133): its id, name, style and pattern; pf.facts as listed (null
//                               when the file lists none: C5's fill is T-139's); the 11 free-text blocks whole (MC R3)
//   flows.<flow>.switches       the switches on in the flow: tradeSwitches() (T-136, overlay-core.js switchesOf; no2
//                               from the $2 split)
//   flows.<flow>.settings       pf.settings for the flow, typed: a value written per flow ({ A, B }) is split; a trade
//                               with none, or none for the flow, starts at arrive window and an empty cutoff (MC C5, the
//                               key map's pf.settings entry, K-01 tradeSettings)
//   flows.<flow>.money          money.<flow> as loaded (T-133)
//   flows.<flow>.rename         the rename pairs in order, as written (their right sides are illustrations, MC C6)
//   flows.<flow>.slotRows       the trade's own record slot rows, their words slotted (T-142, as slotFlow slots the
//                               record's rows)
//   flows.<flow>.ops            the ops in order: off and more as written; words with their messages slotted (T-142)
//                               and written as K-01 messages (T-134); after, before and branch with their steps
//                               compiled (steps.ts) from the trade's applied flow (T-135 applyTrade, then T-142's
//                               slotting with the trade's own sample table), where they sit between the master's steps,
//                               so `next`, the branches' rejoinAt and the cards read the master steps around them.
// A words op's `tells` and `why` are left out: K-01's words op does not hold them (fields overlay-core ignores are left
// out). C8's void offs are kept until T-140's correction drops them. Each message's opt-out line (its `stop` marker), in a
// words op and in the steps an op adds, is the one stop-marks.ts placeStops() gives it from the trade's own walks
// (T-1116; Q-30), not the marker the trade file wrote.
import type { FlowLetter, MasterGraphs, RecordSlotRow } from "../graph/types.ts";
import type { LoadedTrade, TradeOp, TradeSettings } from "../load/trade";
import { applyTrade, type AppliedTrade } from "../overlay/apply";
import { tradeSwitches } from "../path";
import { compileTradeBranches } from "../branches";
import { sampleTable, slotFlow, slotMessage, slotText, type SampleTable } from "../slots";
import { compileSteps, toBundleMessages, toBundleVary, toScreenRows, type BundleStep } from "./steps";
import {
  markSteps,
  ownStepHolder,
  placeMarks,
  wordsOpHolder,
  type MessageList,
  type StopMarks,
} from "./stop-marks";

type Obj = Record<string, unknown>;

/** A compiled trade overlay (K-01 `tradeOverlay`) and the steps its ops add, for the manifest's lint summary. */
export interface CompiledTrade {
  trade: string;
  overlay: Obj;
  /** The steps the trade's after, before and branch ops add, by flow, compiled. */
  steps: Record<FlowLetter, Map<string, BundleStep>>;
}

const FLOWS: readonly FlowLetter[] = ["A", "B"];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value written for both flows, or per flow as { A, B } (SPEC-prof 3; the trade loader's PerFlow): the flow's value,
 * or undefined. `{ window: 3 }` is an arrive value, not a per-flow one.
 */
function perFlow(value: unknown, flow: FlowLetter): unknown {
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => key === "A" || key === "B")) return value[flow];
  }
  return value;
}

/** pf.settings for one flow, typed (K-01 tradeSettings): MC C5's start values where the trade writes none. */
export function settingsFor(settings: TradeSettings | null, flow: FlowLetter): Obj {
  const arrive = perFlow(settings?.arrive, flow);
  const cutoff = perFlow(settings?.cutoff, flow);
  return {
    arrive: arrive === undefined ? "window" : structuredClone(arrive),
    cutoff: cutoff ?? null,
  };
}

/** money.<flow> in K-01 `tradeMoney`'s order, as loaded. */
function moneyOf(trade: LoadedTrade, flow: FlowLetter): Obj {
  const money = trade.flows[flow].money as unknown as Obj;
  const out: Obj = {};
  for (const field of ["main", "combos", "examples", "amounts", "services", "booking", "labels"]) {
    if (money[field] !== undefined) out[field] = structuredClone(money[field]);
  }
  return out;
}

/** The trade's own slot rows for one flow, their words slotted with the trade's table (as slotFlow slots the record's). */
function slotRowsOf(trade: LoadedTrade, flow: FlowLetter, table: SampleTable): Obj {
  const out: Obj = {};
  for (const [slot, rows] of Object.entries(trade.flows[flow].slotRows)) {
    out[slot] = rows.map((row: RecordSlotRow) => {
      const copy: Obj = {};
      if ((row as Partial<RecordSlotRow>).when !== undefined) copy.when = structuredClone(row.when);
      copy.text = slotText(row.text, table);
      return copy;
    });
  }
  return out;
}

/**
 * A words op's messages and variants slotted with the trade's table, each message's opt-out line as `mark` gives it
 * (its list, variant and index), then written as K-01 messages.
 */
function wordsOp(
  op: Extract<TradeOp, { op: "words" }>,
  table: SampleTable,
  where: string,
  mark: (list: readonly unknown[], kind: MessageList, vary: string | null) => unknown[],
): Obj {
  const out: Obj = { op: "words", at: op.at };
  const raw = op as unknown as Obj;
  for (const field of ["does", "more", "say", "rule", "t", "form", "table", "title", "who", "to", "vary"]) {
    const value = raw[field];
    if (value === undefined) continue;
    if (field === "say") {
      const slotted = mark(value as unknown[], "say", null).map((message) =>
        slotMessage(message as unknown[], table),
      );
      out.say = toBundleMessages(slotted, `${where}.say`);
    } else if (field === "vary") {
      const vary: Obj = {};
      for (const [key, patch] of Object.entries(value as Obj)) {
        const copy: Obj = { ...(patch as Obj) };
        for (const list of ["say", "addSay"] as const) {
          if (Array.isArray(copy[list]))
            copy[list] = mark(copy[list] as unknown[], list === "say" ? "vary.say" : "vary.addSay", key).map(
              (message) => slotMessage(message as unknown[], table),
            );
        }
        if (Array.isArray(copy.swap))
          copy.swap = (copy.swap as unknown[]).map((pair) =>
            Array.isArray(pair)
              ? (pair as unknown[]).map((side) => (typeof side === "string" ? slotText(side, table) : side))
              : pair,
          );
        vary[key] = copy;
      }
      out.vary = toBundleVary(vary, `${where}.vary`);
    } else if (field === "form") out.form = toScreenRows(value, `${where}.form`);
    else out[field] = structuredClone(value);
  }
  return out;
}

/** The ids of the steps an op adds, its branches' steps included, in page order. */
function ownIds(
  steps: readonly { id: string; branches?: readonly { steps?: readonly unknown[] }[] }[],
): string[] {
  const out: string[] = [];
  const visit = (list: readonly unknown[]): void => {
    for (const step of list) {
      if (!isObj(step) || typeof step.id !== "string") continue;
      out.push(step.id);
      for (const branch of (step.branches ?? []) as { steps?: unknown[] }[]) visit(branch.steps ?? []);
    }
  };
  visit(steps);
  return out;
}

/** The step ids every after, before and branch op of a flow adds. */
function addedIds(ops: readonly TradeOp[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === "after" || op.op === "before") for (const id of ownIds(op.steps)) out.add(id);
    if (op.op === "branch") for (const id of ownIds(op.branch.steps ?? [])) out.add(id);
  }
  return out;
}

function stepsOf(ids: readonly string[], compiled: Map<string, BundleStep>, where: string): BundleStep[] {
  return ids.map((id) => {
    const step = compiled.get(id);
    if (step === undefined) throw new Error(`${where}: the added step ${id} was not compiled`);
    return step;
  });
}

/**
 * One flow of the trade: its applied, slotted flow, and the K-01 tradeFlow. `stops` is placeStops() of the flow over
 * the bundle's trades: the messages of the trade's words ops and of the steps its ops add are marked as it gives them.
 */
function compileTradeFlow(
  master: MasterGraphs,
  trade: LoadedTrade,
  flow: FlowLetter,
  stops: StopMarks,
): { value: Obj; steps: Map<string, BundleStep> } {
  const where = `${trade.id} flow ${flow}`;
  if (stops.flow !== flow) throw new Error(`${where}: the opt-out line's marks are flow ${stops.flow}'s`);
  if (stops.paths[trade.id] === undefined)
    throw new Error(`${where}: the opt-out line's marks walked no path of ${trade.id}`);
  const applied = applyTrade(master[flow], trade);
  const table = sampleTable(master, flow, trade, applied.flow);
  const ops = trade.flows[flow].ops;
  const added = addedIds(ops);
  const slottedFlow = slotFlow(applied.flow, table);
  const slotted: AppliedTrade = {
    ...applied,
    flow: {
      ...slottedFlow,
      steps: markSteps(stops, slottedFlow.steps, (step) =>
        added.has(step.id) ? ownStepHolder(trade.id, step.id) : null,
      ),
    },
  };
  const compiled = compileSteps(slotted, added);
  const branches = compileTradeBranches(slotted);

  const out = ops.map((op, n): Obj => {
    const at = `${where} op ${String(n + 1)} (${op.op} ${op.at})`;
    switch (op.op) {
      case "off": {
        const copy: Obj = { op: "off", at: op.at };
        if (op.label !== undefined) copy.label = op.label;
        copy.why = op.why;
        return copy;
      }
      case "more":
        return { op: "more", at: op.at, more: structuredClone(op.more) };
      case "words":
        return wordsOp(op, table, at, (list, kind, vary) =>
          placeMarks(stops, list, wordsOpHolder(trade.id, n), kind, vary),
        );
      case "after":
      case "before": {
        const ids = ownIds(op.steps);
        const first = op.steps[0]?.id;
        if (first === undefined) throw new Error(`${at}: the op adds no step`);
        return { op: op.op, at: op.at, first, steps: stepsOf(ids, compiled.steps, at) };
      }
      case "branch": {
        const label = op.branch.label;
        const branch = (branches[op.at] ?? []).find((candidate) => candidate.label === label);
        if (branch === undefined)
          throw new Error(`${at}: the branch '${label}' is not among ${op.at}'s compiled branches`);
        return {
          op: "branch",
          at: op.at,
          branch: structuredClone(branch),
          steps: stepsOf(ownIds(op.branch.steps ?? []), compiled.steps, at),
        };
      }
    }
  });

  const value: Obj = {
    switches: tradeSwitches(trade, flow),
    settings: settingsFor(trade.settings, flow),
    money: moneyOf(trade, flow),
    rename: structuredClone(trade.flows[flow].rename),
    slotRows: slotRowsOf(trade, flow, table),
    ops: out,
  };
  return { value, steps: compiled.steps };
}

/**
 * Compiles one trade's overlay (K-01 `tradeOverlay`). `stops` is placeStops() of each flow over the bundle's trades,
 * this one among them.
 */
export function compileTrade(
  master: MasterGraphs,
  trade: LoadedTrade,
  stops: Readonly<Record<FlowLetter, StopMarks>>,
): CompiledTrade {
  const flows: Obj = {};
  const steps = {} as Record<FlowLetter, Map<string, BundleStep>>;
  for (const flow of FLOWS) {
    const part = compileTradeFlow(master, trade, flow, stops[flow]);
    flows[flow] = part.value;
    steps[flow] = part.steps;
  }
  const overlay: Obj = {
    contract: "bundle.v1",
    trade: { id: trade.id, name: trade.name, style: trade.style, pattern: trade.pattern },
    facts: trade.facts === null ? null : [...trade.facts],
    pluginText: structuredClone(trade.pluginText),
    flows,
  };
  return { trade: trade.id, overlay, steps };
}
