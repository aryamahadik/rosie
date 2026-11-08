// T-153: L2, record phrases outside a slot (lib.js lintSteps lines 1929-1943), tested alone: runLint([l2], ...).
// Each case is the master's own steps and words, as written or moved within the flow, never invented (rule 9); each is
// also checked against lib.js lintSteps on the vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { parseFlow } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l2 } from "./l2";
import { masterInput, runLint, type LintResult } from "./runner";

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
  CORE: { syncWays(flow: unknown): void };
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

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

/** L2 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l2], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L2 hits on the same file, as build-master.js lintFlow calls it. */
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
    .hits.filter((hit) => hit.rule === "L2")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

/** The words of a row of a record slot, as the flow file writes them. */
function rowText(file: Obj, slot: string, row: number): string {
  const slots = (file.record as Obj).slots as Record<string, { rows: { text: string }[] }>;
  const text = slots[slot]?.rows[row - 1]?.text;
  if (text === undefined) throw new Error(`no row ${String(row)} of ${slot}`);
  return text;
}

describe("L2: record phrases outside a slot", () => {
  it("fails: {{pay.took}}'s own row written out on A7-06, after the money step, is an error", () => {
    const file = flowFile("A");
    const row = rowText(file, "pay.took", 5);
    expect(row).toBe("Nothing taken, no card saved");
    const step = stepOf(file, "A7-06");
    (step.more as string[]).push(row);

    const result = lint(file, "A");
    const fix = "this is S13-55's rule (row 5 of {{pay.took}}): use {{pay.took}} / delete the line";
    expect(result.hits.filter((hit) => hit.step === "A7-06").map(shape)).toEqual([
      { rule: "L2", level: "error", field: "more 9", text: row, fix },
    ]);
    expect(result.errors).toEqual([`A:A7-06 L2 record phrase: more 9 '${row}': ${fix}`]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: before the money step the same is a warning: A4-02's own 'paid in full', which the allow list exempts", () => {
    const file = flowFile("A");
    const result = lint(file, "A");
    expect(
      result.hits.filter((hit) => hit.step === "A4-02").map((hit) => [hit.field, hit.level, hit.allowed]),
    ).toEqual([["does", "warning", true]]);
    expect(result.hits.find((hit) => hit.step === "A4-02")?.fix).toBe(
      "this is S13-55's rule (the money phrase /\\bpaid in full\\b/): use a record slot / delete the line",
    );
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: A7-06 as written says the late fee through its slot ({{pay.late}}), not in the record's words", () => {
    const file = flowFile("A");
    const say = JSON.stringify(stepOf(file, "A7-06").say);
    expect(say).toContain("{{pay.late}}");
    const result = lint(file, "A");
    expect(result.hits.filter((hit) => hit.step === "A7-06")).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: the home of the $2 (A9-21) holds the record's words: a home is never read", () => {
    const file = flowFile("A");
    const home = stepOf(file, "A9-21");
    const row = rowText(file, "two.count", 2);
    (home.more as string[]).push(row);
    const result = lint(file, "A");
    expect(result.hits.filter((hit) => hit.step === "A9-21")).toEqual([]);
    // the same row on a step of the same section that is not a home is the record's words outside a slot
    (stepOf(file, "A9-02").more as string[]).push(row);
    const moved = lint(file, "A");
    expect(moved.hits.filter((hit) => hit.step === "A9-02").map((hit) => [hit.level, hit.fix])).toEqual([
      ["error", "this is A9-21's rule (row 2 of {{two.count}}): use {{two.count}} / delete the line"],
    ]);
    expect(mine(moved)).toEqual(reference(file, "A"));
  });
});
