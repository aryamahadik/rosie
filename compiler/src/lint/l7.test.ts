// T-154: L7, a decision with no safe default line (lib.js lintSteps lines 1927-1928, hasSafeDefault and isDecision
// lines 1845-1853), tested alone: runLint([l7], ...). Each case is the master's own steps and words, as written or moved
// within the flow, or a trade's own words as the vendored apply() lays them, never invented (rule 9); each is also
// checked against lib.js lintSteps on the vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { hasSafeDefault, isDecision, l7 } from "./l7";
import { masterInput, runLint, tradeInput, type LintResult } from "./runner";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));

type Obj = Record<string, unknown>;
interface RefHit {
  rule: string;
  level: string;
  id: string;
  field: string;
  text: string;
  fix: string;
  allowed?: boolean;
}
interface Reference {
  lintSteps(steps: unknown, flow: FlowLetter, record: unknown, opts: Obj): { hits: RefHit[] };
  eachStep(steps: unknown, visit: (step: Obj) => void): void;
  hasSafeDefault(step: unknown): boolean;
  CORE: {
    syncWays(flow: unknown): void;
    apply(master: unknown, overlay: unknown, flow: FlowLetter): { flow: Obj; errors: string[] };
  };
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

const FIX =
  "add its safe default as one line, 'Safe default: ...' (what happens when the answer is unclear, late or off-topic)";

/** A master flow file as written (a fresh copy each time). */
function flowFile(flow: FlowLetter): Obj {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as Obj;
}

/** A step of a flow file by id, branch steps included. */
function stepOf(file: Obj, id: string): Obj {
  let found: Obj | undefined;
  ref.eachStep(file.steps, (step) => {
    if (step.id === id) found = step;
  });
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

/** L7 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l7], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L7 hits on a flow in the file's shape, as build-master.js lintFlow calls it. */
function reference(file: Obj, flow: FlowLetter): Obj[] {
  ref.CORE.syncWays(file);
  const record = file.record as Obj;
  const homes: Obj = {};
  for (const [name, id] of Object.entries(record.homes as Record<string, string>)) {
    ref.eachStep(file.steps, (step) => {
      if (step.id === id) homes[name] = step;
    });
  }
  return ref
    .lintSteps(file.steps, flow, record, { homes, moneyStep: file.took, names: file.names })
    .hits.filter((hit) => hit.rule === "L7")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

/** A7-06's own words without its safe default line. */
function withoutSafeDefault(step: Obj): string {
  const more = step.more as string[];
  const line = more.find((text) => text.startsWith("Safe default:"));
  if (line === undefined) throw new Error(`${String(step.id)} has no safe default line`);
  step.more = more.filter((text) => text !== line);
  return line;
}

describe("L7: a decision with no safe default line", () => {
  it("fails: A7-06 ('Does Alex cancel anyway?') without its line 'Safe default: the visit stays booked.'", () => {
    const file = flowFile("A");
    expect(withoutSafeDefault(stepOf(file, "A7-06"))).toBe("Safe default: the visit stays booked.");

    const result = lint(file, "A");
    expect(result.hits.map(shape)).toEqual([
      { rule: "L7", level: "error", field: "q", text: "Does Alex cancel anyway?", fix: FIX },
    ]);
    expect(result.errors).toEqual([`A:A7-06 L7 no safe default: q 'Does Alex cancel anyway?': ${FIX}`]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: a trade's own words that drop the line: aba's flow A, as lintSteps finds it on the vendored apply()", () => {
    const trade = loadTrade("aba");
    const result = runLint([l7], tradeInput(applyTrade(loadMaster().A, trade), trade));
    const applied = ref.CORE.apply(
      flowFile("A"),
      JSON.parse(readFileSync(`${WORK}prof/aba.json`, "utf8")) as Obj,
      "A",
    );
    expect(applied.errors).toEqual([]);
    expect(result.hits.map((hit) => hit.step)).toContain("S1-62");
    expect(result.hits.find((hit) => hit.step === "S1-62")?.text).toBe(
      "What does the plug-in say: does this work pay the $2?",
    );
    expect(result.hits.every((hit) => hit.level === "error" && hit.trade === "aba")).toBe(true);
    expect(mine(result)).toEqual(reference(applied.flow, "A"));
  });

  it("passes: both flows as written; a choice the path makes needs no line (A4-98); a line in a variant counts", () => {
    for (const flow of ["A", "B"] as const) {
      const file = flowFile(flow);
      const result = lint(file, flow);
      expect(result.hits).toEqual([]);
      expect(mine(result)).toEqual(reference(file, flow));
    }

    const file = flowFile("A");
    const choice = parseFlow(structuredClone(file), "A").steps["A4-98"];
    if (choice === undefined) throw new Error("no step A4-98");
    expect(isDecision(choice)).toBe(false);
    expect(hasSafeDefault(choice)).toBe(false);

    const step = stepOf(file, "A7-06");
    const line = withoutSafeDefault(step);
    step.vary = { "pf:sensitive": { addMore: [line] } };
    const result = lint(file, "A");
    expect(result.hits).toEqual([]);
    expect(mine(result)).toEqual(reference(file, "A"));
    expect(ref.hasSafeDefault(step)).toBe(true);
  });
});
