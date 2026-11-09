// The lint runner (T-153; C-065; K-01 v1 'the lint summary').
//
// The lint reads one flow's steps, the master's (load/flow.ts) or a trade's applied flow (overlay/apply.ts), with that
// flow's compiled record (T-137), and reports what goes against the record's rules. Each rule is its own file and an
// object: its id, its name, its source and run(ctx), which returns the hits it finds (l1.ts to l4.ts are the master's
// L1 to L4 from lib.js lintSteps; L5 to L8 are T-154's, the five section 12 rules T-155 to T-159's). runLint(rules,
// input) runs exactly the rules it is given and sums their hits. A new rule is a new file passed in the list: nothing
// here changes.
//
//   - Every hit names its rule, its level (error or warning), the step, the field, the words and the fix.
//   - The hits are put in page order (a step, then its branches' steps), each step's hits in the order the rules were
//     given: with [L1, L2, L3, L4], lib.js lintSteps' own order.
//   - The record's allow list (record.lint.allow: { "A4-21": { "rule": "L1", "why": "..." } }) exempts a step from the
//     rules it names: such a hit is allowed, neither an error nor a warning. Every other hit is an error or a warning,
//     and each report line is listed once (lib.js lintSort, lines 1967-1978).
//
// What a rule reads (LintContext): the flow's steps in page order with branch steps nested (`steps`), every step in
// page order (`pageOrder`), the compiled record (homes, slots and the lint lists), the flow's sample names, the money
// step, the record's home steps found in the flow, and place(step): the step's section and where it stands against the
// money step (lintSteps' zone and early, lines 1911-1913). A rule that reads a trade path by path (T-157's lookup
// field) has the path model (T-136): paths() gives the trade's paths (path/model.ts tradePaths: its listed money paths,
// its booking values and the record's fixtures, with its own switches and facts) and walk(path) what one path lights
// (path/words.ts walkPath, following a branch's `sets`), each step's opt-out line placed per person as Master
// Corrections C9 and Q-30 place it (corrections/stops.ts walkStops, T-1116), not by the master's applyStops. The
// master is linted as a whole flow, as lintSteps lints it: it has no trade paths.
//
// K-01 v1 names every hit of the master's own rules L1 to L8 `record-lint` (the record's own lint tables); the report
// that K-01 holds (rules with their failure counts, and each failing step) is written from this result by T-160.
import { walkStops } from "../corrections/stops";
import type { FlowGraph, FlowLetter, StepId } from "../graph/types.ts";
import type { LoadedTrade, TradeId } from "../load/trade";
import type { AppliedTrade } from "../overlay/apply";
import { tradePaths, type PathWalk, type TradePath } from "../path";
import {
  compileRecord,
  compileTradeRecord,
  type CompiledRecord,
  type CompiledRecordView,
  type HomeName,
} from "../record";

/** A hit is an error (the record's rule is broken) or a warning (a slot or a record row would say it better). */
export type LintLevel = "error" | "warning";

/** A branch as the lint reads it. Its fields are read as lintSteps reads them: a field of another type is passed over. */
export interface LintBranch {
  readonly label: string;
  readonly when?: unknown;
  readonly sets?: unknown;
  readonly endText?: unknown;
  readonly steps?: readonly LintStep[];
}

/**
 * A step as the lint reads it: a master step (load/flow.ts) or an applied one (overlay/apply.ts). The fields are the
 * ones lib.js lintSteps reads; each is checked before it is used, as lintSteps checks it.
 */
export interface LintStep {
  readonly id: StepId;
  /** A shared part's step for one flow only (lib.js forFlow); a joined flow has none, so none is skipped. */
  readonly only?: unknown;
  readonly type?: unknown;
  readonly title?: unknown;
  readonly q?: unknown;
  readonly as?: unknown;
  readonly does?: unknown;
  readonly rule?: unknown;
  readonly more?: unknown;
  readonly say?: unknown;
  readonly form?: unknown;
  readonly table?: unknown;
  readonly slot?: unknown;
  readonly when?: unknown;
  readonly vary?: unknown;
  /** Stamped on the money step and every step after it (overlay-core.js T1); `false` keeps a step's own words. */
  readonly took?: unknown;
  readonly branches?: readonly LintBranch[];
}

/** One thing a rule found on one step. */
export interface LintHit {
  /** The rule's id: L1 ... */
  readonly rule: string;
  readonly level: LintLevel;
  /** The step's id (K-01 lintFailure.step). */
  readonly step: StepId;
  /** Where on the step: `vary 'booking:shop'`, `more 2`, `message 1 card`, `rule` ... */
  readonly field: string;
  /** The words, or the key, that the rule found there. */
  readonly text: string;
  /** What to do about it, in plain words. */
  readonly fix: string;
}

/** What one lint run reads: one flow, the master's (`trade` null) or one trade's. */
export interface LintInput {
  readonly flow: FlowLetter;
  readonly trade: TradeId | null;
  /** The flow's steps in page order, each split's branch steps nested in it, stamped as the flow file has them. */
  readonly steps: readonly LintStep[];
  /** The flow's compiled record (T-137): its homes, its slots and its lint lists (phrases, pointers, allow). */
  readonly record: CompiledRecord;
  /** The flow's sample names (cast slots: biz, pro, place, cust, owner). */
  readonly names: Readonly<Record<string, string>>;
  /** The money step (the flow's `took`: A5-04, B5-02), or null when the flow has none. */
  readonly moneyStep: StepId | null;
  /** For a trade: its applied flow and its file, whose paths a rule may walk; null for the master. */
  readonly overlay: { readonly applied: AppliedTrade; readonly file: LoadedTrade } | null;
}

/** Where a step stands for the record's rules (lib.js lintSteps lines 1911-1913). */
export interface StepPlace {
  /** The section in the id (A7-06: 7), or 0 for an id without one. */
  readonly section: number;
  /** Stamped `took`: the money step or a step after it. */
  readonly took: boolean;
  /** The money step or a step under its branches: these set the record. */
  readonly money: boolean;
  /** After the money step, or in sections 11 and 12, the money step's own steps aside: the record says these words. */
  readonly zone: boolean;
  /** Sections 3 to 12 outside the zone: before the money step, the money step itself, or stamped `took: false`. */
  readonly early: boolean;
  /** One of the record's home steps (record.homes, in either flow: A9-21 counts in flow B too). */
  readonly home: boolean;
}

/** What a rule is given. */
export interface LintContext extends LintInput {
  /** Every step the lint reads, branch steps included, in page order; a step without an id or of the other flow is left out. */
  readonly pageOrder: readonly LintStep[];
  /** The record's home steps found in this flow, in the record's order (flow B has no A9-21: no `two`). */
  readonly homes: Readonly<Partial<Record<HomeName, LintStep>>>;
  place(step: LintStep): StepPlace;
  /**
   * The trade's paths (path/model.ts tradePaths: each money path it lists, each booking value it uses, the record's
   * fixtures on them), made on the first call; none for the master, which is linted as one whole flow.
   */
  paths(): readonly TradePath[];
  /**
   * What one of the trade's paths lights, in page order, with each step's words on it (path/words.ts walkPath, a
   * branch's `sets` followed), the opt-out line placed per person (corrections/stops.ts walkStops).
   */
  walk(path: TradePath): PathWalk;
}

/** One lint rule: one file. */
export interface LintRule {
  /** The id every hit of the rule carries and the allow list names: L1 ... */
  readonly id: string;
  /** Its name in a report line (lib.js LINT_NAMES): "record variant". */
  readonly name: string;
  /** Where the rule comes from. */
  readonly source: string;
  run(ctx: LintContext): LintHit[];
}

/** A hit as the run reports it. */
export interface LintFinding extends LintHit {
  readonly flow: FlowLetter;
  readonly trade: TradeId | null;
  /** The report line: `A:A4-21 L1 record variant: vary 'booking:shop': prefer a slot: ...` (lib.js lintSort). */
  readonly line: string;
  /** The record's allow list exempts this step from this rule. */
  readonly allowed: boolean;
  /** The allow list's reason, on an allowed hit. */
  readonly why: string | null;
}

/** How many hits one rule had: errors and warnings are the hits not allowed. */
export interface RuleCount {
  readonly rule: string;
  readonly errors: number;
  readonly warnings: number;
  readonly allowed: number;
}

/** One lint run. */
export interface LintResult {
  readonly flow: FlowLetter;
  readonly trade: TradeId | null;
  /** Every hit of every rule given, in page order. */
  readonly hits: LintFinding[];
  /** The lines of the errors not allowed, each once. */
  readonly errors: string[];
  /** The lines of the warnings not allowed, each once. */
  readonly warnings: string[];
  /** The lines of the allowed hits, each with its reason: `... (allowed: <why>)`. */
  readonly allowed: string[];
  /** Each rule given, in the order given, with its counts. */
  readonly rules: RuleCount[];
}

/** A lint run that cannot be made: a rule given twice, a hit under another rule's id, an input of another flow. */
export class LintError extends Error {
  override name = "LintError";
}

/** A plain object (not null, not a list). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The section in a step id: A7-06 is 7, S13-55 is 13; 0 when the id has none (lib.js secOf). */
export function sectionOf(id: string): number {
  const found = /^[SAB](\d+)-/.exec(id);
  return found?.[1] === undefined ? 0 : Number(found[1]);
}

/** Curly quotes made straight, so a pattern written with ' and " reads them (lib.js unq). */
export function unq(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** Calls `visit` on every step under `steps`, depth first in page order: a step, then its branches' steps (lib.js eachStep). */
export function eachStep(steps: readonly LintStep[], visit: (step: LintStep) => void): void {
  for (const step of steps) {
    visit(step);
    for (const branch of step.branches ?? []) eachStep(branch.steps ?? [], visit);
  }
}

/** The money step and every step under its branches: they set the record (lib.js moneyStepIds). */
function moneyStepIds(steps: readonly LintStep[], moneyStep: StepId | null): Set<string> {
  const ids = new Set<string>();
  if (moneyStep === null || moneyStep === "") return ids;
  eachStep(steps, (step) => {
    if (step.id !== moneyStep) return;
    ids.add(step.id);
    for (const branch of step.branches ?? []) eachStep(branch.steps ?? [], (inner) => ids.add(inner.id));
  });
  return ids;
}

/** The context the rules are given for one input. */
export function lintContext(input: LintInput): LintContext {
  const all: LintStep[] = [];
  eachStep(input.steps, (step) => all.push(step));
  const pageOrder = all.filter((step) => step.id !== "" && !(Boolean(step.only) && step.only !== input.flow));

  const homes: Partial<Record<HomeName, LintStep>> = {};
  for (const [name, id] of Object.entries(input.record.homes) as [HomeName, StepId][]) {
    for (const step of all) if (step.id === id) homes[name] = step;
  }
  const homeIds = new Set<string>(Object.values(input.record.homes));
  const money = moneyStepIds(input.steps, input.moneyStep);

  const places = new Map<LintStep, StepPlace>();
  const place = (step: LintStep): StepPlace => {
    const known = places.get(step);
    if (known !== undefined) return known;
    const section = sectionOf(step.id);
    const took = Boolean(step.took);
    const own = money.has(step.id);
    const zone = (took || section === 11 || section === 12) && !own;
    const made: StepPlace = {
      section,
      took,
      money: own,
      zone,
      early: !zone && section >= 3 && section <= 12,
      home: homeIds.has(step.id),
    };
    places.set(step, made);
    return made;
  };

  const { overlay } = input;
  let made: readonly TradePath[] | null = null;
  const paths = (): readonly TradePath[] => {
    if (overlay === null) return [];
    made ??= tradePaths(overlay.applied, overlay.file);
    return made;
  };
  const walk = (path: TradePath): PathWalk => {
    if (overlay === null)
      throw new LintError(
        "the master is linted as one whole flow: only a trade's applied flow has paths to walk",
      );
    return walkStops(overlay.applied, path, { sets: true });
  };

  return { ...input, pageOrder, homes, place, paths, walk };
}

/** The record's allow list: step id to the rules it is exempt from and why (record.lint.allow). */
function allowList(record: CompiledRecord): Map<string, { rules: string[]; why: string }> {
  const out = new Map<string, { rules: string[]; why: string }>();
  const allow = record.lint.allow;
  if (!isRecord(allow)) return out;
  for (const [id, entry] of Object.entries(allow)) {
    if (!isRecord(entry)) continue;
    const rules = (Array.isArray(entry.rule) ? (entry.rule as unknown[]) : [entry.rule]).filter(
      (rule): rule is string => typeof rule === "string",
    );
    out.set(id, { rules, why: String(entry.why) });
  }
  return out;
}

/** At most `n` characters of a text, with "..." when cut (lib.js short). */
function short(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}

/**
 * Runs the rules given, in the order given, on one flow, and sums their hits. The hits come in page order, a step's
 * own in the order of the rules; the record's allow list sorts each one into allowed, error or warning (lib.js
 * lintSort). Throws LintError when two rules share an id or a rule reports a hit under another rule's id.
 */
export function runLint(rules: readonly LintRule[], input: LintInput): LintResult {
  const names = new Map<string, string>();
  for (const rule of rules) {
    if (names.has(rule.id)) throw new LintError(`the rule ${rule.id} is given twice`);
    names.set(rule.id, rule.name);
  }
  const ctx = lintContext(input);
  const order = new Map<string, number>();
  ctx.pageOrder.forEach((step, k) => {
    if (!order.has(step.id)) order.set(step.id, k);
  });

  const found: LintHit[] = [];
  for (const rule of rules) {
    for (const hit of rule.run(ctx)) {
      if (hit.rule !== rule.id)
        throw new LintError(`the rule ${rule.id} reported a hit under ${hit.rule} (${hit.step})`);
      found.push(hit);
    }
  }
  // Array.prototype.sort is stable: a step's hits keep the order of the rules, and a rule's own order.
  const at = (hit: LintHit): number => order.get(hit.step) ?? Number.MAX_SAFE_INTEGER;
  found.sort((a, b) => at(a) - at(b));

  const allow = allowList(input.record);
  const hits: LintFinding[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed: string[] = [];
  const counts = new Map(rules.map((rule) => [rule.id, { errors: 0, warnings: 0, allowed: 0 }]));
  for (const hit of found) {
    const name = names.get(hit.rule) ?? hit.rule;
    const text = hit.field.includes(hit.text) ? "" : ` '${short(hit.text, 60)}'`;
    const line = `${input.flow}:${hit.step} ${hit.rule} ${name}: ${hit.field}${text}: ${hit.fix}`;
    const entry = allow.get(hit.step);
    const exempt = entry?.rules.includes(hit.rule) === true;
    const count = counts.get(hit.rule);
    if (exempt) {
      allowed.push(`${line} (allowed: ${entry.why})`);
      if (count !== undefined) count.allowed += 1;
    } else if (hit.level === "error") {
      if (!errors.includes(line)) errors.push(line);
      if (count !== undefined) count.errors += 1;
    } else {
      if (!warnings.includes(line)) warnings.push(line);
      if (count !== undefined) count.warnings += 1;
    }
    hits.push({
      ...hit,
      flow: input.flow,
      trade: input.trade,
      line,
      allowed: exempt,
      why: exempt ? entry.why : null,
    });
  }
  return {
    flow: input.flow,
    trade: input.trade,
    hits,
    errors,
    warnings,
    allowed,
    rules: rules.map((rule) => ({
      rule: rule.id,
      ...(counts.get(rule.id) ?? { errors: 0, warnings: 0, allowed: 0 }),
    })),
  };
}

/** The lint's input for one master flow (load/flow.ts), with its compiled record (record/compile.ts). */
export function masterInput(graph: FlowGraph, view: CompiledRecordView = compileRecord(graph)): LintInput {
  if (view.flow !== graph.flow || view.trade !== null)
    throw new LintError(
      `the record given is ${view.trade ?? "the master"}'s for flow ${view.flow}, not the master's for flow ${graph.flow}`,
    );
  return {
    flow: graph.flow,
    trade: null,
    steps: graph.path,
    record: view.record,
    names: graph.names,
    moneyStep: graph.tookAt,
    overlay: null,
  };
}

/**
 * The lint's input for one trade's applied flow (overlay/apply.ts applyTrade of `file`; a corrected one too), with the
 * trade's compiled record (record/compile.ts compileTradeRecord of the same applied flow).
 */
export function tradeInput(applied: AppliedTrade, file: LoadedTrade, view?: CompiledRecordView): LintInput {
  if (file.id !== applied.trade)
    throw new LintError(`the applied flow is ${applied.trade}'s, but the trade file given is ${file.id}`);
  const own = view ?? compileTradeRecord(applied, file);
  if (own.flow !== applied.flow.id || own.trade !== applied.trade)
    throw new LintError(
      `the record given is ${own.trade ?? "the master"}'s for flow ${own.flow}, not ${applied.trade}'s for flow ${applied.flow.id}`,
    );
  return {
    flow: applied.flow.id,
    trade: applied.trade,
    steps: applied.flow.steps,
    record: own.record,
    names: applied.flow.names,
    moneyStep: applied.flow.took,
    overlay: { applied, file },
  };
}
