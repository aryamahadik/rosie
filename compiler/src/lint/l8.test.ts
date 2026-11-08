// T-154: L8, banned old-rule phrases (lib.js lintSteps lines 1925-1926, bannedList, bannedFix and stepLines lines
// 1854-1890), tested alone: runLint([l8], ...). The master as written holds none of the record's old-rule patterns, so
// the failing cases are trades' own words as the vendored apply() lays them on the master, never invented (rule 9);
// each is also checked against lib.js lintSteps on the vendored copy, given the very same flow.
//
// Last, the card's whole proof for C-065: on the uncorrected master, L1 to L8 together give lintSteps' hits, hit by
// hit, with 0 errors and the allow list's 24 exemptions (CHECKS.md: "Lint: 0 errors, 0 warnings, 24 allowed").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { compileRecord } from "../record";
import { l1 } from "./l1";
import { l2 } from "./l2";
import { l3 } from "./l3";
import { l4 } from "./l4";
import { l5 } from "./l5";
import { l6 } from "./l6";
import { l7 } from "./l7";
import { bannedList, l8 } from "./l8";
import { masterInput, runLint, tradeInput, type LintFinding, type LintResult } from "./runner";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));

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
  lintSteps(steps: unknown, flow: FlowLetter, record: unknown, opts: Obj): RefResult;
  eachStep(steps: unknown, visit: (step: Obj) => void): void;
  CORE: {
    syncWays(flow: unknown): void;
    apply(master: unknown, overlay: unknown, flow: FlowLetter): { flow: Obj; errors: string[] };
  };
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;
const master = loadMaster();

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

/** L8 alone on a trade's applied flow, and lintSteps' L8 hits on the vendored apply() of the same trade. */
function onTrade(id: string, flow: FlowLetter): { result: LintResult; reference: Obj[] } {
  const trade = loadTrade(id);
  const result = runLint([l8], tradeInput(applyTrade(master[flow], trade), trade));
  const applied = ref.CORE.apply(
    readJson(`${WORK}master/master-${flow}.json`),
    readJson(`${WORK}prof/${id}.json`),
    flow,
  );
  expect(applied.errors).toEqual([]);
  const reference = vendored(applied.flow, flow)
    .hits.filter((hit) => hit.rule === "L8")
    .map(theirs);
  return { result, reference };
}

describe("L8: banned old-rule phrases", () => {
  it("fails: advisor's flow B says 'Google's AI' (B3-05) and '$2 a confirmed booking' (S11-63): remove only those words", () => {
    const { result, reference } = onTrade("advisor", "B");
    expect(result.hits.map(mine)).toEqual(reference);
    const google = result.hits.find((hit) => hit.step === "B3-05");
    expect(google?.field).toBe("does");
    expect(google?.fix).toBe(
      "an old rule's words, 'Google's AI' (/(Google's AI)/): remove only these words: 'Google's AI'; keep the rest of the line (its other words are this step's own); the rule now: an AI calling for someone is a caller like any other (A3-05)",
    );
    const fee = result.hits.find((hit) => hit.step === "S11-63");
    expect(fee?.text).toBe(
      "Rosfield's $2, where the plug-in allows it: $2 a confirmed booking, never more than $49 a month per person.",
    );
    expect(fee?.fix.startsWith("an old rule's words, '$2 a confirmed booking'")).toBe(true);
    expect(fee?.fix).toContain(
      "remove only these words: '$2 a confirmed booking'; keep the rest of the line",
    );
    expect(result.hits.every((hit) => hit.level === "error" && !hit.allowed)).toBe(true);
  });

  it("fails: art-classes's flow B card line 'Group class at a host's place' is old words only: write the rule now", () => {
    const { result, reference } = onTrade("art-classes", "B");
    expect(result.hits.map(mine)).toEqual(reference);
    const card = result.hits.find((hit) => hit.step === "S1-13" && hit.field === "message 1 card");
    expect(card?.text).toBe("Group class at a host's place");
    expect(card?.fix).toBe(
      "an old rule's words, 'host's place' (/(host's place|visit day at a host)/): the rule now: a second place with its own days (CUT-LIST); write that, or delete the line",
    );
  });

  it("passes: both flows as written hold none of the record's 29 old-rule patterns", () => {
    for (const flow of ["A", "B"] as const) {
      expect(bannedList(compileRecord(master[flow]).record)).toHaveLength(29);
      const result = runLint([l8], masterInput(master[flow]));
      expect(result.hits).toEqual([]);
      const reference = vendored(readJson(`${WORK}master/master-${flow}.json`), flow);
      expect(reference.hits.filter((hit) => hit.rule === "L8")).toEqual([]);
    }
  });
});

describe("L1 to L8 on the uncorrected master (C-065)", () => {
  const ALL = [l1, l2, l3, l4, l5, l6, l7, l8];

  it.each(["A", "B"] as const)("flow %s: lintSteps' hits, hit by hit; L5 to L8 find nothing", (flow) => {
    const reference = vendored(readJson(`${WORK}master/master-${flow}.json`), flow);
    const result = runLint(ALL, masterInput(master[flow]));
    expect(result.hits.map(mine)).toEqual(reference.hits.map(theirs));
    expect(result.errors).toEqual(reference.errors);
    expect(result.warnings).toEqual(reference.warnings);
    expect(result.allowed).toEqual(reference.allowed);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rules.slice(4)).toEqual(
      ["L5", "L6", "L7", "L8"].map((rule) => ({ rule, errors: 0, warnings: 0, allowed: 0 })),
    );
  });

  it("0 errors and 24 allowed in total: the allow list's 24 exemptions, each used (32 hits allowed)", () => {
    const allow = master.A.record.lint.allow as Obj;
    expect(Object.keys(allow)).toHaveLength(24);
    const hits = (["A", "B"] as const).flatMap((flow) => runLint(ALL, masterInput(master[flow])).hits);
    expect(hits.filter((hit) => !hit.allowed)).toEqual([]);
    expect(hits).toHaveLength(32);
    expect([...new Set(hits.map((hit) => hit.step))].sort()).toEqual(Object.keys(allow).sort());
  });
});
