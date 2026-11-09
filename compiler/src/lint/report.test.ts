// T-160: the lint report (K-01 v1 lintReport) and the manifest's journey ship list (K-01 v1 manifest.journeys), with
// `compiler lint` (compiler/src/cli/commands/lint.ts). The lint runs on fixture set v1's own flows: the master's two and
// the barber and advisor trades' (the advisor's words are the ones contracts/bundle/fixtures/lint-report.json cites), as
// the build reads them. What is checked:
//   - the report validates against K-01 v1 (Ajv 2020-12, strict) and has the shape of lint-report.json, the fixture;
//   - each rule's count is the number of failures listed under it, and only an error that is not allowed is a failure
//     (warnings and allowed hits are listed beside it, with their level and allowed, in lintFindings);
//   - a trade's hit that the master's flow also has (S1-37's "Start") is reported once, at the master;
//   - each journey holds K-01's membership (journey 1 is the fixture's 45 section 1 steps), and a journey with one
//     failing step is marked not shippable, one with none shippable, each gate accepted by K-01's journeyGate;
//   - `compiler lint` writes the three files, validated as read back, and refuses a command line it does not take.
// One or two trades only: the all-trades run is the card's CLI proof, not a unit test (DL-099).
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasMeansLine } from "../cards";
import { main, type CliIo } from "../cli/index";
import { checkBundlePart, lintRuleOrder } from "../emit/validate";
import type { MasterGraphs } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { guardKeyword } from "./guard-keyword";
import { l5 } from "./l5";
import { noDefinitionRule, type DefinitionCard } from "./no-definition";
import {
  LintReportError,
  correctedMasterInput,
  correctedTradeInput,
  journeyGates,
  journeySteps,
  joinedL5,
  k01RuleOf,
  lintFindings,
  lintMasterAndTrades,
  lintReport,
  lintRules,
  shipList,
  type JourneyGate,
  type LintReport,
} from "./report";
import { lintContext, runLint, type LintFinding, type LintResult, type LintRule } from "./runner";

const FIXTURES = new URL("../../../contracts/bundle/fixtures/", import.meta.url);
const fixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as unknown;

interface FixtureGate {
  journey: number;
  steps: string[];
  ships: boolean;
  failingSteps: string[];
}
interface FixtureBundle {
  manifest: { lint: Record<string, unknown>; journeys: FixtureGate[] };
  flows: Record<string, Record<string, unknown>>;
}

const master: MasterGraphs = loadMaster();
const barber = loadTrade("barber");
const advisor = loadTrade("advisor");
const run = lintMasterAndTrades(master, [barber, advisor]);
const report = lintReport(run.results);
const masterOnly = lintReport(run.results.filter((result) => result.trade === null));

const resultOf = (trade: string | null, flow: "A" | "B"): LintResult => {
  const found = run.results.find((result) => result.trade === trade && result.flow === flow);
  if (found === undefined) throw new Error(`no result for ${trade ?? "the master"} ${flow}`);
  return found;
};

/** A JSON value's shape: an object's keys in order with their shapes, a list's distinct item shapes, a leaf's type. */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value))
    return [...new Set((value as unknown[]).map((item) => JSON.stringify(shapeOf(item))))].sort();
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shapeOf(item)]);
  return typeof value;
}

/** The contract test's lint summary checks (tests/contract/bundle.v1.test.ts checkLintMarks, the report's part). */
function countProblems(lint: LintReport): string[] {
  const problems: string[] = [];
  const names = lint.rules.map((rule) => rule.rule);
  if (new Set(names).size !== names.length) problems.push("a rule is counted twice");
  for (const rule of lint.rules) {
    const listed = lint.failures.filter((failure) => failure.rule === rule.rule).length;
    if (listed !== rule.failures)
      problems.push(`${rule.rule} counts ${String(rule.failures)}, lists ${String(listed)}`);
  }
  for (const failure of lint.failures)
    if (!names.includes(failure.rule)) problems.push(`${failure.rule} is not counted`);
  return problems;
}

const keyOf = (hit: LintFinding): string =>
  JSON.stringify([hit.rule, hit.level, hit.step, hit.field, hit.text]);

describe("K-01 rule ids", () => {
  it("names every hit of L1 to L8 record-lint, and each other rule by its own K-01 id", () => {
    for (let n = 1; n <= 8; n += 1) expect(k01RuleOf(`L${String(n)}`)).toBe("record-lint");
    const k01 = lintRuleOrder();
    for (const rule of lintRules(master, null)) expect(k01).toContain(k01RuleOf(rule.id));
    expect(run.rules.map((rule) => rule.rule)).toEqual([
      ...Array.from({ length: 8 }, () => "record-lint"),
      "no-safe-default-or-clock",
      "choice-without-definition",
      "lookup-without-field",
      "loop",
      "guard-keyword-button",
      "judgment-rule-out-of-range",
    ]);
    expect(() => k01RuleOf("L9")).toThrow(LintReportError);
    expect(() => k01RuleOf("record variant")).toThrow(LintReportError);
  });
});

describe("the lint report (K-01 v1 lintReport)", () => {
  it("validates against K-01 v1 and has the shape of contracts/bundle/fixtures/lint-report.json", () => {
    expect(checkBundlePart(report, "lintReport")).toEqual([]);
    expect(checkBundlePart(masterOnly, "lintReport")).toEqual([]);
    const lintReportFixture = fixture("lint-report.json");
    expect(checkBundlePart(lintReportFixture, "lintReport")).toEqual([]);
    expect(shapeOf(JSON.parse(JSON.stringify(report)))).toEqual(shapeOf(lintReportFixture));
  });

  it("counts the rules run in K-01's order, each with the failures listed under it", () => {
    expect(report.rules.map((rule) => rule.rule)).toEqual([
      "no-safe-default-or-clock",
      "choice-without-definition",
      "lookup-without-field",
      "loop",
      "guard-keyword-button",
      "judgment-rule-out-of-range",
      "record-lint",
    ]);
    expect(countProblems(report)).toEqual([]);
    expect(countProblems(masterOnly)).toEqual([]);
    // One failure per step, rule, flow and trade.
    const keys = report.failures.map((failure) =>
      JSON.stringify([failure.rule, failure.flow, failure.trade, failure.step]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fails a step only for an error that is not allowed: warnings and allowed hits pass", () => {
    for (const result of run.results.filter((entry) => entry.trade === null)) {
      const failing = new Set(
        report.failures
          .filter((failure) => failure.trade === null && failure.flow === result.flow)
          .map((failure) => JSON.stringify([failure.rule, failure.step])),
      );
      const erring = new Set(
        result.hits
          .filter((hit) => hit.level === "error" && !hit.allowed)
          .map((hit) => JSON.stringify([k01RuleOf(hit.rule), hit.step])),
      );
      expect(failing).toEqual(erring);
      // The master's warnings (step 9's default, stand-ins) and its allowed L1 and L2 hits are there, and fail nothing.
      expect(result.hits.filter((hit) => hit.level === "warning").length).toBeGreaterThan(100);
      expect(result.hits.filter((hit) => hit.allowed).length).toBeGreaterThan(0);
    }
    expect(report.rules.find((rule) => rule.rule === "no-safe-default-or-clock")?.failures).toBe(0);
    expect(report.rules.find((rule) => rule.rule === "choice-without-definition")?.failures).toBe(0);
  });

  it("reports S1-37's 'Start' once in each flow, at the master, with its field, words and fix hint", () => {
    const start = report.failures.filter((failure) => failure.step === "S1-37");
    expect(start.map((failure) => [failure.rule, failure.flow, failure.trade])).toEqual([
      ["guard-keyword-button", "A", null],
      ["guard-keyword-button", "B", null],
    ]);
    for (const failure of start) {
      const hit = resultOf(null, failure.flow).hits.find(
        (entry) => entry.step === "S1-37" && entry.rule === "guard-keyword-button",
      );
      expect(hit?.field).toBe("message 2 button 1");
      expect(failure.message).toBe(hit?.line.slice(2));
      expect(failure.message).toContain("message 2 button 1 'Start'");
      expect(failure.message).toContain("reword the button");
    }
    // Each trade's flow inherits it (T-159's handoff): its own hit there is the master's, so the trade reports none.
    for (const trade of ["barber", "advisor"])
      for (const flow of ["A", "B"] as const) {
        expect(
          resultOf(trade, flow).hits.some(
            (hit) => hit.step === "S1-37" && hit.rule === "guard-keyword-button",
          ),
        ).toBe(true);
        expect(report.failures.some((failure) => failure.trade === trade && failure.step === "S1-37")).toBe(
          false,
        );
      }
  });

  it("reports a trade's own failure with its trade, and none the master's flow already has", () => {
    // The barber's words drop A4-09's safe default line (L7, the record's lint: record-lint).
    const own = report.failures.find((failure) => failure.trade === "barber" && failure.step === "A4-09");
    expect(own).toMatchObject({ rule: "record-lint", flow: "A", step: "A4-09", trade: "barber" });
    expect(own?.message).toContain("A4-09 L7 no safe default: q 'Sam replies?'");
    for (const failure of report.failures.filter((entry) => entry.trade !== null)) {
      const masterKeys = new Set(resultOf(null, failure.flow).hits.map(keyOf));
      const mine = resultOf(failure.trade, failure.flow).hits.filter(
        (hit) =>
          hit.step === failure.step &&
          k01RuleOf(hit.rule) === failure.rule &&
          hit.level === "error" &&
          !hit.allowed &&
          !masterKeys.has(keyOf(hit)),
      );
      expect(mine.length, `${String(failure.trade)} ${failure.flow} ${failure.step}`).toBeGreaterThan(0);
      expect(failure.message).toBe(mine.map((hit) => hit.line.slice(2)).join(" | "));
    }
    // The master's own A4-82 (C2's words restate S13-19's line 10: L4) is the master's, never the trades'.
    expect(
      report.failures.filter((failure) => failure.step === "A4-82").map((failure) => failure.trade),
    ).toEqual([null]);
  });

  it("keeps every hit of a trade given without the master, and refuses a flow given twice or a rule K-01 lacks", () => {
    const alone = lintReport([resultOf("barber", "A")]);
    expect(alone.failures.some((failure) => failure.step === "S1-37" && failure.trade === "barber")).toBe(
      true,
    );
    expect(() => lintReport([resultOf(null, "A"), resultOf(null, "A")])).toThrow(/given twice/);
    const stray: LintRule = {
      id: "X1",
      name: "stray",
      source: "this test",
      run: () => [{ rule: "X1", level: "error", step: "S1-01", field: "does", text: "x", fix: "none" }],
    };
    expect(() => lintReport([runLint([stray], correctedMasterInput(master, "A"))])).toThrow(LintReportError);
  });

  it("names the branch when one branch fails, and none when two do", () => {
    const step = fixture("invalid/refuse-choice-without-definition.json") as {
      id: string;
      more: string[];
      card: DefinitionCard;
    };
    const statesMeans = hasMeansLine(step.more);
    const one = noDefinitionRule(() => [{ step: step.id, card: step.card, statesMeans }]);
    const oneReport = lintReport([runLint([one], correctedMasterInput(master, "A"))]);
    expect(oneReport.failures).toEqual([
      {
        rule: "choice-without-definition",
        flow: "A",
        step: "A6-02",
        trade: null,
        branch: "2 Another time",
        message: expect.stringContaining(
          "A6-02 choice-without-definition choice without a definition: branch '2 Another time'",
        ) as unknown,
      },
    ]);
    expect(checkBundlePart(oneReport, "lintReport")).toEqual([]);

    const means = step.card.means.map((entry) => ({ branch: entry.branch, from: "none" as const }));
    const two = noDefinitionRule(() => [{ step: step.id, card: { ...step.card, means }, statesMeans }]);
    const twoReport = lintReport([runLint([two], correctedMasterInput(master, "A"))]);
    expect(twoReport.failures).toHaveLength(1);
    expect(twoReport.failures[0]).not.toHaveProperty("branch");
    expect(twoReport.failures[0]?.message.split(" | ")).toHaveLength(3);
    expect(twoReport.rules).toEqual([{ rule: "choice-without-definition", failures: 1 }]);
  });
});

describe("the findings beside it", () => {
  const findings = lintFindings(run);

  it("lists every hit with its rule, level, flow, trade, step, field, words, fix hint and allowed", () => {
    for (const hit of findings.hits) {
      expect(Object.keys(hit)).toEqual([
        "rule",
        "check",
        "level",
        "flow",
        "trade",
        "step",
        "field",
        "text",
        "fix",
        "allowed",
        "why",
      ]);
      expect(hit.allowed ? typeof hit.why : hit.why).toBe(hit.allowed ? "string" : null);
    }
    // The master's hits are all listed, in its own order; a trade's are those the master's flow does not have.
    for (const flow of ["A", "B"] as const) {
      const listed = findings.hits.filter((hit) => hit.trade === null && hit.flow === flow);
      expect(listed.map((hit) => [hit.check, hit.step, hit.field])).toEqual(
        resultOf(null, flow).hits.map((hit) => [hit.rule, hit.step, hit.field]),
      );
    }
    let inherited = 0;
    for (const trade of ["barber", "advisor"])
      for (const flow of ["A", "B"] as const) {
        const masterKeys = new Set(resultOf(null, flow).hits.map(keyOf));
        const all = resultOf(trade, flow).hits;
        const listed = findings.hits.filter((hit) => hit.trade === trade && hit.flow === flow);
        expect(listed.length).toBe(all.filter((hit) => !masterKeys.has(keyOf(hit))).length);
        inherited += all.length - listed.length;
      }
    expect(findings.inherited).toBe(inherited);
    expect(findings.corrections).toEqual(run.corrections);
  });

  it("counts each rule's errors, warnings and allowed hits, and the errors are the report's failing hits", () => {
    for (const rule of findings.rules) {
      const mine = findings.hits.filter((hit) => hit.check === rule.check);
      expect(rule.errors + rule.warnings + rule.allowed).toBe(mine.length);
    }
    const failing = findings.hits.filter((hit) => hit.level === "error" && !hit.allowed);
    const groups = new Set(failing.map((hit) => JSON.stringify([hit.rule, hit.flow, hit.trade, hit.step])));
    expect(groups.size).toBe(report.failures.length);
  });
});

describe("L5 on the master as the join wrote it", () => {
  it("passes the join, where L5 as written takes each corrected word field for drift", () => {
    const corrected = correctedMasterInput(master, "A");
    const drift = l5.run(lintContext(corrected));
    expect([...new Set(drift.map((hit) => hit.step))].sort()).toEqual(["A4-82", "A6-14", "A7-11", "A7-98"]);
    expect(joinedL5(master).run(lintContext(corrected))).toEqual([]);
    expect(joinedL5(master).run(lintContext(correctedTradeInput(master, barber, "A")))).toEqual([]);
  });
});

describe("the journey ship list (K-01 v1 manifest.journeys)", () => {
  const journeys = journeySteps(run.steps);
  const gates = journeyGates(journeys, masterOnly);
  const gate = (n: number): JourneyGate => {
    const found = gates.find((entry) => entry.journey === n);
    if (found === undefined) throw new Error(`no journey ${String(n)}`);
    return found;
  };
  const ids = [...new Set([...Object.keys(master.A.steps), ...Object.keys(master.B.steps)])];
  const of = (pattern: RegExp): string[] => ids.filter((id) => pattern.test(id)).sort();

  it("holds K-01's membership: journey 1 is the fixture's 45 section 1 steps, in its order", () => {
    expect(journeys.map((journey) => journey.journey)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const manifest = fixture("manifest.json") as { journeys: FixtureGate[] };
    const refused = fixture("invalid/refuse-journey-ships-with-failing-step.json") as FixtureGate;
    expect(journeys[0]?.steps).toEqual(manifest.journeys[0]?.steps);
    expect(journeys[0]?.steps).toEqual(refused.steps);
    const steps = (n: number): string[] => [...(journeys[n - 1]?.steps ?? [])].sort();
    expect(steps(2)).toEqual(of(/^S2-/));
    expect(steps(3)).toEqual([...of(/^[AB]3-/), "S11-62"].sort());
    expect(steps(4)).toEqual(
      [...of(/^[AB]4-/), "S12-01", "S12-02", "S12-03", "S12-04", "S12-05", "S12-28"].sort(),
    );
    expect(steps(5)).toEqual([...of(/^[AB]5-/), "S12-16", "S12-17", "S12-18", "S12-26"].sort());
    expect(steps(6)).toEqual([...of(/^[AB]6-/), "S12-33"].sort());
    expect(steps(7)).toEqual([...of(/^[AB]7-/), "S11-22"].sort());
    for (const n of [8, 9, 10]) expect(steps(n)).toEqual(of(new RegExp(`^[AB]${String(n)}-`)));
    expect(steps(11)).toEqual(of(/^S11-/));
    expect(steps(12)).toEqual(
      ["06", "07", "08", "19", "23", "24", "25", "27", "29", "30", "31", "32"].map((n) => `S12-${n}`),
    );
    // In no journey: S12-09 to S12-14 (the shared core, README open gap) and section 13 (every journey calls it).
    const held = new Set(journeys.flatMap((journey) => journey.steps));
    expect(ids.filter((id) => !held.has(id)).sort()).toEqual(
      [...of(/^S12-(09|1[0-4])$/), ...of(/^S13-/)].sort(),
    );
    // Flow A's steps come before flow B's in a section (A3-01 ... B3-01 ...), then the steps that ride with it.
    const three = journeys[2]?.steps ?? [];
    expect(three.indexOf("A3-01")).toBeLessThan(three.indexOf("B3-01"));
    expect(three.at(-1)).toBe("S11-62");
  });

  it("marks a journey with one failing step not shippable, and one with none shippable", () => {
    // The master as the build reads it fails S1-37 (guard-keyword-button) in both flows, and A4-82 and B4-93 (record-lint).
    expect(gate(1)).toMatchObject({ ships: false, failingSteps: ["S1-37"] });
    expect(gate(2)).toMatchObject({ ships: true, failingSteps: [] });
    expect(gate(4)).toMatchObject({ ships: false, failingSteps: ["A4-82", "B4-93"] });
    for (const n of [2, 3, 5, 6, 7, 8, 9, 10, 11, 12]) expect(gate(n).ships).toBe(true);
    for (const entry of gates) {
      expect(checkBundlePart(entry, "journeyGate")).toEqual([]);
      const failed = new Set(masterOnly.failures.map((failure) => failure.step));
      expect(entry.failingSteps).toEqual(entry.steps.filter((id) => failed.has(id)));
      expect(entry.ships).toBe(entry.failingSteps.length === 0);
    }
    // K-01 refuses journey 1 marked to ship with its failing step, and accepts it as marked here.
    expect(
      checkBundlePart(fixture("invalid/refuse-journey-ships-with-failing-step.json"), "journeyGate"),
    ).not.toEqual([]);
    expect(checkBundlePart({ ...gate(1), ships: true }, "journeyGate")).not.toEqual([]);

    const two = journeyGates(journeys, { failures: [{ step: "S2-05" }] });
    expect(two.filter((entry) => !entry.ships).map((entry) => [entry.journey, entry.failingSteps])).toEqual([
      [2, ["S2-05"]],
    ]);
    expect(journeyGates(journeys, { failures: [] }).every((entry) => entry.ships)).toBe(true);
  });

  it("counts a step failing in any trade: the barber's and the advisor's own failures hold their journeys back", () => {
    const all = journeyGates(journeys, report);
    expect(all.find((entry) => entry.journey === 4)?.failingSteps).toContain("A4-09");
    for (const entry of all) expect(checkBundlePart(entry, "journeyGate")).toEqual([]);
  });

  it("gives a bundle's ship list from its flow graphs and its lint (shipList, the emitter's manifest journeys)", () => {
    const flows = { A: { steps: master.A.steps }, B: { steps: master.B.steps } };
    expect(shipList(flows, { ...masterOnly })).toEqual(gates);
    // bundle-mini-a.json, a partial bundle: its flow holds S1-37 of journey 1, which its lint fails, so it does not ship.
    const mini = fixture("bundle-mini-a.json") as FixtureBundle;
    const list = shipList(mini.flows, mini.manifest.lint);
    const first = list.find((entry) => entry.journey === 1);
    expect(first).toMatchObject({ ships: false, failingSteps: ["S1-37"] });
    expect(mini.manifest.journeys[0]).toMatchObject({ ships: false, failingSteps: ["S1-37"] });
    for (const entry of list) expect(checkBundlePart(entry, "journeyGate")).toEqual([]);
    expect(() => shipList({ A: {} }, { failures: [] })).toThrow(LintReportError);
    expect(() => shipList(flows, {})).toThrow(LintReportError);
    expect(() => shipList(flows, { failures: [{ rule: "loop" }] })).toThrow(LintReportError);
  });
});

describe("compiler lint", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lint-cli-"));
    made.push(dir);
    return dir;
  };
  const capture = (): { io: CliIo; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  };

  it("writes lint-report.json, lint-findings.json and journeys.json, each sound as read back", async () => {
    const out = join(tempDir(), "lint");
    const cli = capture();
    const code = await main(["lint", "--out", out, "--trades", "barber"], cli.io);
    expect(cli.err).toEqual([]);
    expect(code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["journeys.json", "lint-findings.json", "lint-report.json"]);
    const read = (file: string): unknown => JSON.parse(readFileSync(join(out, file), "utf8")) as unknown;

    const written = read("lint-report.json") as LintReport;
    expect(checkBundlePart(written, "lintReport")).toEqual([]);
    expect(shapeOf(written)).toEqual(shapeOf(fixture("lint-report.json")));
    const expected = lintReport(lintMasterAndTrades(master, [barber]).results);
    expect(written).toEqual(JSON.parse(JSON.stringify(expected)));

    const gates = read("journeys.json") as JourneyGate[];
    expect(gates).toEqual(journeyGates(journeySteps(run.steps), expected));
    for (const entry of gates) expect(checkBundlePart(entry, "journeyGate")).toEqual([]);
    const findings = read("lint-findings.json") as { hits: { trade: string | null }[] };
    expect(findings.hits.some((hit) => hit.trade === "barber")).toBe(true);

    expect(cli.out).toContain("rule guard-keyword-button: 2 failing steps");
    expect(cli.out).toContain("journey 1: does not ship (1 failing step of 45: S1-37)");
    expect(cli.out).toContain("journey 2: ships (20 steps, none failing)");
    expect(cli.out.at(-1)).toContain("validated against K-01 v1");
  });

  it("refuses a command line it does not take, an unknown trade and a folder that is not empty", async () => {
    const bad = async (args: string[]): Promise<{ code: number; err: string[] }> => {
      const cli = capture();
      const code = await main(["lint", ...args], cli.io);
      return { code, err: cli.err };
    };
    expect((await bad([])).code).toBe(2);
    expect((await bad(["--out"])).code).toBe(2);
    expect((await bad(["--out", tempDir(), "--trade", "barber"])).err[0]).toBe('unknown argument "--trade"');
    expect((await bad(["--out", tempDir(), "--trades", "no-such-trade"])).err[0]).toBe(
      "--trades: no trade no-such-trade in fixture set v1",
    );
    const full = tempDir();
    writeFileSync(join(full, "keep.txt"), "not empty\n");
    const refused = await bad(["--out", full]);
    expect(refused.code).toBe(2);
    expect(refused.err[0]).toContain("the folder is not empty");
  });
});

// The guard rule's own id is K-01's, as the report relies on (no mapping).
describe("the rule ids the report reads", () => {
  it("takes the guard rule's id as K-01's", () => {
    expect(k01RuleOf(guardKeyword.id)).toBe(guardKeyword.id);
    expect(correctedTradeInput(master, advisor, "B").trade).toBe("advisor");
  });
});
