// T-153: the lint runner. Proofs of the card:
//   - on the uncorrected master, L1 to L4 give the same hits as lib.js lintSteps on the vendored copy, flow by flow and
//     hit by hit (rule, level, step, field, words, fix, report line, allowed): 0 errors and 0 warnings, and each of the
//     allow list's 24 exemptions used (12 hits allowed in flow A, 20 in flow B), as CHECKS.md reads: "Lint: 0 errors,
//     0 warnings, 24 allowed";
//   - the runner runs the rules it is given, nothing else, and sums their hits, in page order, each step's in the order
//     of the rules; the allow list exempts a step from the rules it names only;
//   - a trade's applied flow is linted as lintSteps lints the vendored apply() of the same trade, and a rule can read
//     that trade path by path (T-136's path model: its paths, and what each lights).
//
// The reference side is a second, separate copy of lib.js (its own loader), run as build-master.js lintFlow runs it
// (lines 78-90): the flow's record loaded (CORE.syncWays), the record's homes found in the flow's steps, the money step
// (`took`) and the flow's names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { pathName, tradePaths, walkPath } from "../path";
import { compileRecord } from "../record";
import { l1 } from "./l1";
import { l2 } from "./l2";
import { l3 } from "./l3";
import { l4 } from "./l4";
import {
  LintError,
  lintContext,
  masterInput,
  runLint,
  tradeInput,
  type LintFinding,
  type LintRule,
} from "./runner";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
const RULES: readonly LintRule[] = [l1, l2, l3, l4];
const IDS = RULES.map((rule) => rule.id);

type Obj = Record<string, unknown>;

interface RefHit {
  rule: string;
  level: string;
  id: string;
  field: string;
  text: string;
  fix: string;
  line?: string;
  allowed?: boolean;
}

interface RefResult {
  errors: string[];
  warnings: string[];
  allowed: string[];
  hits: RefHit[];
}

interface Reference {
  lintSteps(
    steps: unknown,
    flow: FlowLetter,
    record: unknown,
    opts: { homes: Obj; moneyStep: unknown; names: unknown },
  ): RefResult;
  eachStep(steps: unknown, visit: (step: Obj) => void): void;
  CORE: {
    syncWays(flow: unknown): void;
    apply(master: unknown, overlay: unknown, flow: FlowLetter): { flow: Obj; errors: string[] };
  };
}

const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}

/** lintSteps on a flow in the file's shape, as build-master.js lintFlow calls it. */
function vendored(flow: Obj, letter: FlowLetter): RefResult {
  ref.CORE.syncWays(flow);
  const record = flow.record as Obj;
  const homes: Obj = {};
  for (const [name, id] of Object.entries(record.homes as Record<string, string>)) {
    ref.eachStep(flow.steps, (step) => {
      if (step.id === id) homes[name] = step;
    });
  }
  return ref.lintSteps(flow.steps, letter, record, { homes, moneyStep: flow.took, names: flow.names });
}

/** A hit of one of L1 to L4, by its rule or by its report line (`A:A4-21 L1 record variant: ...`). */
const ours = (rule: string): boolean => IDS.includes(rule);
const ourLine = (line: string): boolean => ours(/^[AB]:\S+ (L\d+) /.exec(line)?.[1] ?? "");

/** A hit in one shape for both sides. */
function mine(hit: LintFinding): Obj {
  const { rule, level, step, field, text, fix, line, allowed } = hit;
  return { rule, level, step, field, text, fix, line, allowed };
}

function theirs(hit: RefHit): Obj {
  return {
    rule: hit.rule,
    level: hit.level,
    step: hit.id,
    field: hit.field,
    text: hit.text,
    fix: hit.fix,
    line: hit.line,
    allowed: hit.allowed === true,
  };
}

const master = loadMaster();

describe("on the uncorrected master, L1 to L4 give lintSteps' hits on the vendored copy", () => {
  it.each(["A", "B"] as const)("flow %s: the same hits, hit by hit, and no error or warning", (flow) => {
    const reference = vendored(readJson(`${WORK}master/master-${flow}.json`), flow);
    const result = runLint(RULES, masterInput(master[flow]));

    expect(result.hits.map(mine)).toEqual(reference.hits.filter((hit) => ours(hit.rule)).map(theirs));
    expect(result.errors).toEqual(reference.errors.filter(ourLine));
    expect(result.warnings).toEqual(reference.warnings.filter(ourLine));
    expect(result.allowed).toEqual(reference.allowed.filter(ourLine));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.hits.length).toBe(flow === "A" ? 12 : 20);
    expect(result.hits.every((hit) => hit.allowed && hit.why !== null)).toBe(true);
    expect(result.rules).toEqual([
      { rule: "L1", errors: 0, warnings: 0, allowed: flow === "A" ? 5 : 14 },
      { rule: "L2", errors: 0, warnings: 0, allowed: flow === "A" ? 7 : 6 },
      { rule: "L3", errors: 0, warnings: 0, allowed: 0 },
      { rule: "L4", errors: 0, warnings: 0, allowed: 0 },
    ]);
  });

  it("each of the allow list's 24 exemptions is used: 32 hits allowed, 0 errors (CHECKS.md: 24 allowed)", () => {
    const allow = master.A.record.lint.allow as Obj;
    expect(master.B.record.lint.allow).toEqual(allow);
    expect(Object.keys(allow)).toHaveLength(24);
    const hits = (["A", "B"] as const).flatMap((flow) => runLint(RULES, masterInput(master[flow])).hits);
    expect(hits.filter((hit) => hit.allowed)).toHaveLength(32);
    expect([...new Set(hits.map((hit) => hit.step))].sort()).toEqual(Object.keys(allow).sort());
    for (const hit of hits) {
      const entry = allow[hit.step] as { rule: string | string[]; why: string };
      expect([entry.rule].flat()).toContain(hit.rule);
      expect(hit.why).toBe(entry.why);
    }
  });
});

describe("the runner", () => {
  const input = masterInput(master.A);

  it("runs only the rules it is given, and sums their hits", () => {
    const alone = RULES.map((rule) => runLint([rule], input));
    alone.forEach((result, k) => {
      expect(result.hits.every((hit) => hit.rule === IDS[k])).toBe(true);
      expect(result.rules.map((count) => count.rule)).toEqual([IDS[k]]);
    });
    expect(alone.map((result) => result.hits.length)).toEqual([5, 7, 0, 0]);

    const all = runLint(RULES, input);
    expect(all.hits).toHaveLength(12);
    expect([...all.hits].sort((a, b) => a.line.localeCompare(b.line))).toEqual(
      alone.flatMap((result) => result.hits).sort((a, b) => a.line.localeCompare(b.line)),
    );
    expect(runLint([], input)).toEqual({
      flow: "A",
      trade: null,
      hits: [],
      errors: [],
      warnings: [],
      allowed: [],
      rules: [],
    });
  });

  it("puts the hits in page order, a step's own in the order of the rules", () => {
    const at = new Map(lintContext(input).pageOrder.map((step, k) => [step.id, k]));
    const position = (hit: LintFinding): number => at.get(hit.step) ?? -1;
    for (const rules of [RULES, [...RULES].reverse()]) {
      const hits = runLint(rules, input).hits;
      hits.forEach((hit, k) => {
        if (k > 0) expect(position(hit)).toBeGreaterThanOrEqual(position(hits[k - 1] ?? hit));
      });
      // A4-43 has an L1 and an L2 hit: they come in the order the rules were given
      const order = hits.filter((hit) => hit.step === "A4-43").map((hit) => hit.rule);
      expect(order).toEqual(rules[0] === l1 ? ["L1", "L2"] : ["L2", "L1"]);
    }
  });

  it("the allow list exempts a step from the rules it names, and from no other", () => {
    const view = structuredClone(compileRecord(master.A));
    const allow = view.record.lint.allow as Record<string, { rule: string | string[]; why: string }>;
    delete allow["A4-21"];
    allow["A4-43"] = { rule: "L1", why: allow["A4-43"]?.why ?? "" };
    const result = runLint(RULES, masterInput(master.A, view));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "A:A4-21 L1 record variant: vary 'booking:shop': prefer a slot: booking:shop words can come from the record's rows",
      "A:A4-43 L2 record phrase: vary 'booking:shop' more 1 'Its page not finished: it stays booked, with nothing taken.': this is S13-55's rule (the money phrase /\\bnothing (was )?taken\\b/): use a record slot / delete the line",
    ]);
    expect(result.hits.filter((hit) => hit.allowed)).toHaveLength(10);
    expect(result.rules[0]).toEqual({ rule: "L1", errors: 0, warnings: 1, allowed: 4 });
  });

  it("refuses a rule given twice, a hit under another rule's id, and another flow's record", () => {
    expect(() => runLint([l1, l1], input)).toThrow(LintError);
    const stray: LintRule = { ...l2, id: "L9", name: "stray" };
    expect(() => runLint([stray], input)).toThrow(/the rule L9 reported a hit under L2/);
    expect(() => masterInput(master.A, compileRecord(master.B))).toThrow(LintError);
  });
});

/** The vendored apply() of a trade, on the files as they are. */
function refApplied(id: string, flow: FlowLetter): Obj {
  const result = ref.CORE.apply(
    readJson(`${WORK}master/master-${flow}.json`),
    readJson(`${WORK}prof/${id}.json`),
    flow,
  );
  expect(result.errors).toEqual([]);
  return result.flow;
}

describe("a trade's applied flow", () => {
  it.each([
    ["aba", "A"],
    ["cpa", "B"],
  ] as const)("%s flow %s: L1 to L4 give lintSteps' hits on the vendored apply()", (id, flow) => {
    const trade = loadTrade(id);
    const applied = applyTrade(master[flow], trade);
    const result = runLint(RULES, tradeInput(applied, trade));
    const reference = vendored(refApplied(id, flow), flow);
    expect(result.trade).toBe(id);
    expect(result.hits.every((hit) => hit.trade === id && hit.flow === flow)).toBe(true);
    expect(result.hits.map(mine)).toEqual(reference.hits.filter((hit) => ours(hit.rule)).map(theirs));
    expect(result.errors).toEqual(reference.errors.filter(ourLine));
    expect(result.warnings).toEqual(reference.warnings.filter(ourLine));
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("a rule reads the trade path by path: paths() are its paths, walk(path) what one lights; the master has none", () => {
    const trade = loadTrade("cpa");
    const applied = applyTrade(master.A, trade);
    const ctx = lintContext(tradeInput(applied, trade));
    const paths = ctx.paths();
    expect(paths.map(pathName)).toEqual(tradePaths(applied, trade).map(pathName));
    expect(paths.some((path) => path.kind === "fixture")).toBe(true);
    expect(ctx.paths()).toBe(paths);
    const first = paths[0];
    if (first === undefined) throw new Error("cpa has no flow A path");
    const lit = ctx.walk(first).steps.map((step) => step.id);
    expect(lit).toEqual(walkPath(applied, first).steps.map((step) => step.id));
    expect(lit.length).toBeGreaterThan(100);

    const whole = lintContext(masterInput(master.A));
    expect(whole.paths()).toEqual([]);
    expect(() => whole.walk(first)).toThrow(LintError);
  });

  it("refuses a record or a trade file of another trade or flow", () => {
    const trade = loadTrade("cpa");
    const applied = applyTrade(master.A, trade);
    expect(() => tradeInput(applied, trade, compileRecord(master.A))).toThrow(LintError);
    expect(() => tradeInput(applied, loadTrade("aba"))).toThrow(/the trade file given is aba/);
  });
});
