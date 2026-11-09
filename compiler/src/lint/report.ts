// The lint report and the manifest's journey ship list (T-160; C-065 to C-070; K-01 v1 "the lint summary" and "which
// journeys may ship"; arch 12 line 592: "A journey with a failing step does not ship; fixes go in an overlay Jay
// approves").
//
// What the lint reads (lintMasterAndTrades, lintFixtureSet): the master's two flows and each trade's two flows as the
// build reads them, Master Corrections applied (corrections/framework.ts CORRECTIONS). The master's own flow is the one
// emit/flow.ts correctedFlow() gives; a trade's is overlay/apply.ts applyTrade() on the master's flow, then the
// corrections, which the compiler applies after the trade overlay (corrections/framework.ts). Each flow is linted by
// every rule T-153 to T-159 and T-1050 wrote (lintRules: L1 to L8, the five rules of arch 12 line 592 and the
// judgment-rule numbers), the loop rule given the same trade's other flow, so a flow switch into it is followed. L5
// alone reads the master as the join wrote it (joinedL5): it holds a twin to the join's own words, so on a corrected
// flow it would take each correction for drift.
//
// What is made from the results:
//   lintReport()    K-01 v1 lintReport, the bundle's lint summary, in contracts/bundle/fixtures/lint-report.json's shape:
//                   each K-01 rule run with its count of failing steps, and every failing step with its rule, flow,
//                   step and trade (null for the master), the branch when one branch fails, and a message that gives, in
//                   plain words, each hit's rule, field, words and fix hint. A failing step is one with an error the
//                   record's allow list does not exempt: a warning and an allowed hit pass (NQ-PB-3's default; lib.js
//                   lintSort), so neither is a failure. One failure per step, rule, flow and trade, as K-01 counts
//                   "how many steps fail it"; a step's hits under one rule share it, each in its message.
//   lintFindings()  every hit with its rule, level, flow, trade, step, field, words, fix hint and allowed (with the allow
//                   list's reason). K-01's lintFailure has no place for the level, the field, the fix or allowed
//                   (additionalProperties false), so they ride beside the report; the warnings are NQ-PB-3's list for
//                   the J-18 batch (T-164).
//   journeyGates()  K-01 v1 manifest.journeys, the ship list: each journey's steps (journeySteps(), the membership of
//                   contracts/bundle/README.md "Journey membership"), its failing steps (those of its steps that fail in
//                   any flow or trade), and `ships` true only when it has none. shipList() gives the same from a
//                   bundle's compiled flow graphs and its lint report: the value the emitter's manifest `journeys` reads.
//                   A journey lists the master's steps only (K-01: each one a step of a flow of the bundle), so a failing
//                   step that no journey holds (section 13's, S12-09 to S12-14, a trade's own A8-x05) is in the report
//                   and gates no journey.
//
// K-01's rule ids: each rule of T-155 to T-159 and T-1050 carries its own; every hit of the master's own rules L1 to L8
// is record-lint (K-01 lintRule: "record-lint is the record's own lint tables"; T-153's handoff).
//
// A trade's hit that the master's own flow also has (the same rule, level, step, field and words) is the master's, not
// the trade's: every trade inherits S1-37's "Start" (T-159's handoff). It is reported once, at the master, as
// contracts/bundle/fixtures/lint-report.json reports S1-37 (K-01 lintFailure.trade: "the trade whose overlay fails").
import { CORRECTIONS, applyCorrections, type Correction } from "../corrections/framework";
import { correctedFlow } from "../emit/flow";
import { lintRuleOrder } from "../emit/validate";
import type { FlowLetter, MasterGraphs, StepId } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade, type TradeId } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { compileRecord } from "../record";
import { guardKeyword } from "./guard-keyword";
import { judgmentRuleRef } from "./judgment-rule-ref";
import { l1 } from "./l1";
import { l2 } from "./l2";
import { l3 } from "./l3";
import { l4 } from "./l4";
import { l5 } from "./l5";
import { l6 } from "./l6";
import { l7 } from "./l7";
import { l8 } from "./l8";
import { lookupField } from "./lookup-field";
import { loopRule, type LoopFlow } from "./loop";
import { noDefaultOrClock } from "./no-default-or-clock";
import { noDefinition } from "./no-definition";
import {
  isRecord,
  lintContext,
  masterInput,
  runLint,
  sectionOf,
  tradeInput,
  type LintFinding,
  type LintInput,
  type LintLevel,
  type LintResult,
  type LintRule,
} from "./runner";

/** A lint report or ship list that cannot be made from what it is given. */
export class LintReportError extends Error {
  override name = "LintReportError";
}

/** K-01 v1 lintFailure: one step that fails a lint rule (arch 12 line 592). */
export interface LintFailure {
  /** K-01 lintRule. */
  readonly rule: string;
  readonly flow: FlowLetter;
  readonly step: StepId;
  /** The trade whose overlay fails, or null for the master itself. */
  readonly trade: TradeId | null;
  /** The branch label, when one branch fails. */
  readonly branch?: string;
  /** What fails, in plain words: each hit's rule, field, words and fix hint. */
  readonly message: string;
}

/** K-01 v1 lintReport, the lint summary: each rule run with its count of failing steps, and every failing step. */
export interface LintReport {
  readonly rules: readonly { readonly rule: string; readonly failures: number }[];
  readonly failures: readonly LintFailure[];
}

/** One journey's steps (K-01 journeyGate.steps). */
export interface JourneySteps {
  readonly journey: number;
  readonly steps: readonly StepId[];
}

/** K-01 v1 journeyGate: one journey, its steps, its failing steps and whether it may ship. */
export interface JourneyGate {
  readonly journey: number;
  readonly steps: readonly StepId[];
  /** True only when none of its steps fails the lint. */
  readonly ships: boolean;
  /** Its failing steps, each one of its steps, in its steps' order. */
  readonly failingSteps: readonly StepId[];
}

/** A rule run on each flow: its own id (the check), its K-01 id, its name and its source. */
export interface RuleInfo {
  readonly check: string;
  readonly rule: string;
  readonly name: string;
  readonly source: string;
}

/** One lint run over the master and some trades. */
export interface LintRun {
  /** The Master Corrections applied to every flow linted, in the order they ran. */
  readonly corrections: readonly string[];
  /** The rules run on each flow, in the order run. */
  readonly rules: readonly RuleInfo[];
  /** Every step id of the master's two flows, each once (flow A's, then flow B's own): the journeys' steps. */
  readonly steps: readonly StepId[];
  /** The master's flows A and B, then each trade's flows A and B, in the order the trades were given. */
  readonly results: readonly LintResult[];
}

/** One hit as lintFindings() lists it. */
export interface ReportedHit {
  /** K-01 lintRule. */
  readonly rule: string;
  /** The rule's own id: L1 to L8 for record-lint, else the K-01 id again. */
  readonly check: string;
  readonly level: LintLevel;
  readonly flow: FlowLetter;
  readonly trade: TradeId | null;
  readonly step: StepId;
  /** Where on the step. */
  readonly field: string;
  /** The words, or the key, the rule found there. */
  readonly text: string;
  /** What to do about it, in plain words. */
  readonly fix: string;
  /** The record's allow list exempts the step from this rule: neither an error nor a warning. */
  readonly allowed: boolean;
  /** The allow list's reason, on an allowed hit. */
  readonly why: string | null;
}

/** Every hit of a lint run, each once (a trade's hit the master's flow also has is the master's). */
export interface LintFindings {
  readonly corrections: readonly string[];
  /** Each rule run, with the counts of the hits listed: errors and warnings are those not allowed. */
  readonly rules: readonly (RuleInfo & {
    readonly errors: number;
    readonly warnings: number;
    readonly allowed: number;
  })[];
  /** Trade hits the master's own flow also has, so listed once, at the master. */
  readonly inherited: number;
  readonly hits: readonly ReportedHit[];
}

const FLOWS: readonly FlowLetter[] = ["A", "B"];

function otherFlow(flow: FlowLetter): FlowLetter {
  return flow === "A" ? "B" : "A";
}

/** The master's own rules, L1 to L8 (lib.js lintSteps): K-01 v1 names each of their hits record-lint. */
const MASTER_RULE = /^L[1-8]$/;

/**
 * K-01 v1's id of a lint rule: record-lint for the master's own L1 to L8, the rule's own id for the others (they carry
 * K-01's). Throws LintReportError for an id K-01's lintRule does not hold.
 */
export function k01RuleOf(rule: string): string {
  const id = MASTER_RULE.test(rule) ? "record-lint" : rule;
  const order = lintRuleOrder();
  if (!order.includes(id))
    throw new LintReportError(`the lint rule ${rule} has no K-01 v1 id (lintRule: ${order.join(", ")})`);
  return id;
}

/**
 * L5 (twin drift) read where it can judge: on the master as the join wrote it (`joined`, load/flow.ts loadMaster: the
 * vendored master-A.json and master-B.json), whatever flow of the master is linted. L5 holds each twin to the join's own
 * words in its flow (l5.ts), and Master Corrections change the joined flows after the join, so on a corrected flow it
 * would report each word field a correction changed as drift (A4-82, A6-14, A7-11 and A7-98, and their twins B4-93,
 * B6-13, B7-15 and B7-88), as it would each field an approved overlay changes later. A trade's flow is not read (l5.ts).
 */
export function joinedL5(joined: MasterGraphs): LintRule {
  return {
    id: l5.id,
    name: l5.name,
    source: `${l5.source}; read on the master as the join wrote it (T-160)`,
    run: (ctx) => (ctx.trade !== null ? [] : l5.run(lintContext(masterInput(joined[ctx.flow])))),
  };
}

/**
 * The rules the lint runs on one flow, in this order: the master's L1 to L8 (T-153, T-154; L5 on the master as the join
 * wrote it, `joined`: joinedL5), no-safe-default-or-clock, choice-without-definition, lookup-without-field, loop and
 * guard-keyword-button (T-155 to T-159), and judgment-rule-out-of-range (T-1050). `other` is the same trade's other
 * flow, so the loop rule follows a flow switch into it (loop.ts loopRule); null lints the flow alone.
 */
export function lintRules(joined: MasterGraphs, other: LoopFlow | null): LintRule[] {
  return [
    l1,
    l2,
    l3,
    l4,
    joinedL5(joined),
    l6,
    l7,
    l8,
    noDefaultOrClock,
    noDefinition,
    lookupField,
    loopRule(other),
    guardKeyword,
    judgmentRuleRef,
  ];
}

/**
 * The lint's input for one master flow as the build reads it: Master Corrections applied (emit/flow.ts correctedFlow),
 * its record compiled from the corrected record, as emit/flow.ts compileFlow compiles it.
 */
export function correctedMasterInput(
  master: MasterGraphs,
  flow: FlowLetter,
  corrections: readonly Correction[] = CORRECTIONS,
): LintInput {
  const graph = master[flow];
  const corrected = correctedFlow(master, flow, corrections);
  return {
    flow,
    trade: null,
    steps: corrected.flow.steps,
    record: compileRecord({ ...graph, record: corrected.flow.record }).record,
    names: graph.names,
    moneyStep: graph.tookAt,
    overlay: null,
  };
}

/**
 * The lint's input for one trade's flow as the build reads it: applyTrade() on the master's flow, then Master
 * Corrections (the compiler applies them after the trade overlay: corrections/framework.ts).
 */
export function correctedTradeInput(
  master: MasterGraphs,
  trade: LoadedTrade,
  flow: FlowLetter,
  corrections: readonly Correction[] = CORRECTIONS,
): LintInput {
  return tradeInput(applyCorrections(applyTrade(master[flow], trade), corrections), trade);
}

/** Runs lintRules() on both flows of the master or of one trade, each flow's loop rule given the other flow. */
function lintBoth(joined: MasterGraphs, inputs: Readonly<Record<FlowLetter, LintInput>>): LintResult[] {
  return FLOWS.map((flow) => {
    const other = inputs[otherFlow(flow)];
    return runLint(lintRules(joined, { flow: other.flow, steps: other.steps }), inputs[flow]);
  });
}

/**
 * Lints the master's two flows and each trade's two flows as the build reads them (Master Corrections applied), with
 * every rule of lintRules(). The trades are linted in the order given, one at a time; a trade given twice is refused.
 */
export function lintMasterAndTrades(
  master: MasterGraphs,
  trades: Iterable<LoadedTrade>,
  corrections: readonly Correction[] = CORRECTIONS,
): LintRun {
  const results = lintBoth(master, {
    A: correctedMasterInput(master, "A", corrections),
    B: correctedMasterInput(master, "B", corrections),
  });
  const seen = new Set<TradeId>();
  for (const trade of trades) {
    if (seen.has(trade.id)) throw new LintReportError(`the trade ${trade.id} is given twice`);
    seen.add(trade.id);
    results.push(
      ...lintBoth(master, {
        A: correctedTradeInput(master, trade, "A", corrections),
        B: correctedTradeInput(master, trade, "B", corrections),
      }),
    );
  }
  return {
    corrections: corrections.map((correction) => correction.id),
    rules: lintRules(master, null).map((rule) => ({
      check: rule.id,
      rule: k01RuleOf(rule.id),
      name: rule.name,
      source: rule.source,
    })),
    steps: [...new Set([...Object.keys(master.A.steps), ...Object.keys(master.B.steps)])],
    results,
  };
}

/**
 * lintMasterAndTrades() on fixture set v1: its master flows and the trades named, by id (default: every trade), linted
 * in id order and loaded one at a time.
 */
export function lintFixtureSet(trades?: readonly TradeId[]): LintRun {
  const ids = [...(trades ?? listTradeIds())].sort();
  function* load(): Generator<LoadedTrade> {
    for (const id of ids) yield loadTrade(id);
  }
  return lintMasterAndTrades(loadMaster(), load());
}

/** A hit's identity across the master and a trade: its rule, level, step, field and words. */
function hitKey(hit: LintFinding): string {
  return JSON.stringify([hit.rule, hit.level, hit.step, hit.field, hit.text]);
}

/** One result's hits as reported, and how many of its hits were the master's own. */
interface OwnHits {
  readonly result: LintResult;
  readonly hits: readonly LintFinding[];
  readonly inherited: number;
}

/**
 * Each result's own hits: a trade's hit that the master's result for the same flow also has (hitKey) is the master's,
 * so it is dropped there and reported once, at the master. A trade's result with no master result for its flow keeps
 * every hit. Throws LintReportError when one flow of the master or of a trade is given twice.
 */
function ownHits(results: readonly LintResult[]): OwnHits[] {
  const given = new Set<string>();
  const masterKeys = new Map<FlowLetter, Set<string>>();
  for (const result of results) {
    const owner = `${result.trade ?? "the master"}'s flow ${result.flow}`;
    if (given.has(owner)) throw new LintReportError(`${owner} is given twice`);
    given.add(owner);
    if (result.trade === null) masterKeys.set(result.flow, new Set(result.hits.map(hitKey)));
  }
  return results.map((result) => {
    const keys = result.trade === null ? undefined : masterKeys.get(result.flow);
    const hits = keys === undefined ? result.hits : result.hits.filter((hit) => !keys.has(hitKey(hit)));
    return { result, hits, inherited: result.hits.length - hits.length };
  });
}

/** A hit as a report line says it: the runner's line without its flow (`S1-37 guard-keyword-button ...: ...`). */
function described(hit: LintFinding): string {
  const prefix = `${hit.flow}:`;
  return hit.line.startsWith(prefix) ? hit.line.slice(prefix.length) : hit.line;
}

/** A field that names a branch by its label: `branch '<label>'`, then nothing or words with no quote (`when`, `reads ...`). */
const LABELLED = /^branch '(.*)'(?: [^']*)?$/;

/** A field that names a branch by its number: `branch 2 label` (the hit's words are the label) or `branch 2 endText`. */
const NUMBERED = /^branch \d+ (label|endText)$/;

/** The branch label a hit names in its field, or null when its field names none or not by its label. */
function branchOf(hit: LintFinding): string | null {
  const labelled = LABELLED.exec(hit.field);
  if (labelled !== null) return labelled[1] ?? null;
  return NUMBERED.exec(hit.field)?.[1] === "label" ? hit.text : null;
}

/** The one branch every hit names, or null when a hit names none or they name more than one. */
function oneBranch(hits: readonly LintFinding[]): string | null {
  const labels = hits.map(branchOf);
  const first = labels[0];
  if (first === undefined || first === null) return null;
  return labels.every((label) => label === first) ? first : null;
}

/** The K-01 rules the results ran, in K-01's order (its lintRule enum). */
function rulesRun(results: readonly LintResult[]): string[] {
  const run = new Set<string>();
  for (const result of results) for (const count of result.rules) run.add(k01RuleOf(count.rule));
  return lintRuleOrder().filter((rule) => run.has(rule));
}

/**
 * K-01 v1 lintReport from lint results (the master's and trades' flows, as lintMasterAndTrades gives them): each K-01
 * rule the results ran, in K-01's order, with its count of failing steps; and every failing step, in the order of the
 * results and then of its first hit (page order). A failing step is one with an error that is not allowed; its hits
 * under one rule make one failure, whose message holds each of them, and whose branch is the one branch they all name.
 */
export function lintReport(results: readonly LintResult[]): LintReport {
  const groups = new Map<
    string,
    { rule: string; flow: FlowLetter; trade: TradeId | null; step: StepId; hits: LintFinding[] }
  >();
  for (const { hits } of ownHits(results))
    for (const hit of hits) {
      if (hit.allowed || hit.level !== "error") continue;
      const rule = k01RuleOf(hit.rule);
      const key = JSON.stringify([rule, hit.flow, hit.trade, hit.step]);
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, { rule, flow: hit.flow, trade: hit.trade, step: hit.step, hits: [hit] });
      else group.hits.push(hit);
    }
  const failures: LintFailure[] = [...groups.values()].map((group) => {
    const at = { rule: group.rule, flow: group.flow, step: group.step, trade: group.trade };
    const message = group.hits.map(described).join(" | ");
    const branch = oneBranch(group.hits);
    return branch === null ? { ...at, message } : { ...at, branch, message };
  });
  return {
    rules: rulesRun(results).map((rule) => ({
      rule,
      failures: failures.filter((failure) => failure.rule === rule).length,
    })),
    failures,
  };
}

/**
 * Every hit of a lint run with its rule, level, flow, trade, step, field, words, fix hint and allowed, each once: a
 * trade's hit the master's flow also has is listed at the master. In the run's order, each flow's in page order.
 */
export function lintFindings(run: LintRun): LintFindings {
  const own = ownHits(run.results);
  const hits: ReportedHit[] = own.flatMap(({ hits: list }) =>
    list.map((hit) => ({
      rule: k01RuleOf(hit.rule),
      check: hit.rule,
      level: hit.level,
      flow: hit.flow,
      trade: hit.trade,
      step: hit.step,
      field: hit.field,
      text: hit.text,
      fix: hit.fix,
      allowed: hit.allowed,
      why: hit.why,
    })),
  );
  return {
    corrections: [...run.corrections],
    rules: run.rules.map((rule) => {
      const mine = hits.filter((hit) => hit.check === rule.check);
      return {
        ...rule,
        errors: mine.filter((hit) => !hit.allowed && hit.level === "error").length,
        warnings: mine.filter((hit) => !hit.allowed && hit.level === "warning").length,
        allowed: mine.filter((hit) => hit.allowed).length,
      };
    }),
    inherited: own.reduce((sum, entry) => sum + entry.inherited, 0),
    hits,
  };
}

/** Journey membership as K-01 v1 states it: whole sections, and the steps of other sections that ride with it. */
interface Membership {
  readonly journey: number;
  readonly sections: readonly number[];
  readonly riders: readonly StepId[];
}

/**
 * contracts/bundle/README.md "Journey membership" (K-01 v1 journeyGate.steps): journey N holds section N's steps of both
 * flows, whole (its default 18), and the steps of other sections that ride with it (02-contracts K-09's table; BP's
 * starting shape: S11-62 with journey 3, S11-22 with journey 7; each section 12 step with the first journey that uses it,
 * BP 3.6). Journey 11 is section 11 whole, S11-22 and S11-62 included; journey 12 holds the section 12 steps not already
 * shipped. S12-09 to S12-14 (K-09 v1's shared core) are in no journey until the lead names theirs (README open gap), and
 * section 13's rule nodes and homes in none: every journey calls them (BP 3.5).
 */
const MEMBERSHIP: readonly Membership[] = [
  { journey: 1, sections: [1], riders: [] },
  { journey: 2, sections: [2], riders: [] },
  { journey: 3, sections: [3], riders: ["S11-62"] },
  { journey: 4, sections: [4], riders: ["S12-01", "S12-02", "S12-03", "S12-04", "S12-05", "S12-28"] },
  { journey: 5, sections: [5], riders: ["S12-16", "S12-17", "S12-18", "S12-26"] },
  { journey: 6, sections: [6], riders: ["S12-33"] },
  { journey: 7, sections: [7], riders: ["S11-22"] },
  { journey: 8, sections: [8], riders: [] },
  { journey: 9, sections: [9], riders: [] },
  { journey: 10, sections: [10], riders: [] },
  { journey: 11, sections: [11], riders: [] },
  {
    journey: 12,
    sections: [],
    riders: [
      "S12-06",
      "S12-07",
      "S12-08",
      "S12-19",
      "S12-23",
      "S12-24",
      "S12-25",
      "S12-27",
      "S12-29",
      "S12-30",
      "S12-31",
      "S12-32",
    ],
  },
];

const STEP_ID = /^([SAB])(\d+)-(x?)(\d+)$/;
const LETTER_ORDER = "SAB";

/**
 * The order of step ids in a journey's list: by section, flow A's before flow B's, then by number (S1-01, S1-02, ...,
 * S1-84; A3-01 ... B3-01 ... S11-62), a trade's own step (x) after the master's. An id of another shape comes last.
 */
export function compareStepIds(a: StepId, b: StepId): number {
  const left = STEP_ID.exec(a);
  const right = STEP_ID.exec(b);
  if (left === null || right === null) {
    if (left !== right) return left === null ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const rank = (found: RegExpExecArray): number[] => [
    Number(found[2]),
    LETTER_ORDER.indexOf(found[1] ?? ""),
    found[3] === "x" ? 1 : 0,
    Number(found[4]),
  ];
  const x = rank(left);
  const y = rank(right);
  for (let k = 0; k < x.length; k += 1) {
    const d = (x[k] ?? 0) - (y[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Each journey's steps among the step ids given (both flows' steps, each once): K-01 v1's membership (MEMBERSHIP), in
 * compareStepIds order. A journey that holds none of them is left out (K-01 journeyGate.steps has at least one), so a
 * partial bundle lists only the journeys it holds steps of.
 */
export function journeySteps(ids: Iterable<StepId>): JourneySteps[] {
  const all = [...new Set(ids)];
  return MEMBERSHIP.flatMap(({ journey, sections, riders }) => {
    const steps = all
      .filter((id) => sections.includes(sectionOf(id)) || riders.includes(id))
      .sort(compareStepIds);
    return steps.length === 0 ? [] : [{ journey, steps }];
  });
}

/**
 * The ship list (K-01 v1 manifest.journeys): each journey with its failing steps, those of its steps the report fails
 * in any flow or trade, in its steps' order, and `ships` true only when it has none (arch 12 line 592: "A journey with
 * a failing step does not ship").
 */
export function journeyGates(
  journeys: readonly JourneySteps[],
  report: { readonly failures: readonly { readonly step: StepId }[] },
): JourneyGate[] {
  const failing = new Set(report.failures.map((failure) => failure.step));
  return journeys.map(({ journey, steps }) => {
    const failingSteps = steps.filter((id) => failing.has(id));
    return { journey, steps: [...steps], ships: failingSteps.length === 0, failingSteps };
  });
}

/** The failing steps of a K-01 lintReport read as data (a manifest's `lint`). */
function failuresOf(lint: Readonly<Record<string, unknown>>): { step: StepId }[] {
  const failures = lint.failures;
  if (!Array.isArray(failures))
    throw new LintReportError("the lint report has no failures list (K-01 lintReport.failures)");
  return (failures as unknown[]).map((failure, k) => {
    const step = isRecord(failure) ? failure.step : undefined;
    if (typeof step !== "string")
      throw new LintReportError(`the lint report's failure ${String(k + 1)} names no step`);
    return { step };
  });
}

/**
 * A bundle's ship list (K-01 v1 manifest.journeys): journeyGates() of the journeys its flow graphs hold steps of, read
 * against its lint report. `flows` holds K-01 flow graphs by flow, each with its `steps` by id; `lint` is K-01's
 * lintReport (the manifest's `lint`). The value the emitter's manifest `journeys` reads (emit.ts).
 */
export function shipList(
  flows: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  lint: Readonly<Record<string, unknown>>,
): JourneyGate[] {
  const ids: StepId[] = [];
  for (const [flow, graph] of Object.entries(flows)) {
    const steps = graph.steps;
    if (!isRecord(steps)) throw new LintReportError(`flow ${flow} has no steps by id (K-01 flowGraph.steps)`);
    ids.push(...Object.keys(steps));
  }
  return journeyGates(journeySteps(ids), { failures: failuresOf(lint) });
}
