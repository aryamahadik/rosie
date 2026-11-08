// T-153: L4, a line restating a home (lib.js lintSteps lines 1954-1961, homeLines lines 1799-1810), tested alone:
// runLint([l4], ...). Each case is the master's own steps and words (a home's own lines, the steps' own lines), as
// written or moved within the flow, never invented (rule 9); each is also checked against lib.js lintSteps on the
// vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { parseFlow } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l4 } from "./l4";
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

/** L4 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l4], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L4 hits on the same file, as build-master.js lintFlow calls it. */
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
    .hits.filter((hit) => hit.rule === "L4")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

/** A `more` line of a step, as the flow file writes it (1 is the first). */
function moreLine(file: Obj, id: string, n: number): string {
  const line = (stepOf(file, id).more as string[])[n - 1];
  if (line === undefined) throw new Error(`${id} has no more line ${String(n)}`);
  return line;
}

describe("L4: a line restating a home", () => {
  it("fails: the money home's own line 10 (S13-55) said again on A7-06 is an error", () => {
    const file = flowFile("A");
    const line = moreLine(file, "S13-55", 10);
    expect(line).toBe(
      "Rosie NEVER makes a new charge on silence. Silence: no fee, unless a signed schedule keeps part.",
    );
    (stepOf(file, "A7-06").more as string[]).push(line);

    const result = lint(file, "A");
    const fix = "restates S13-55 line 10 (money): delete it, or keep only this step's own part";
    expect(result.hits.map(shape)).toEqual([
      { rule: "L4", level: "error", field: "more 9", text: line, fix },
    ]);
    expect(result.errors).toEqual([`A:A7-06 L4 restated rule: more 9 '${line.slice(0, 60)}...': ${fix}`]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: a rule box that says a home's rule again (S13-19's, on A7-06) is an error", () => {
    const file = flowFile("A");
    const rule = stepOf(file, "S13-19").rule as string;
    stepOf(file, "A7-06").rule = rule;
    const result = lint(file, "A");
    expect(result.hits.map((hit) => [hit.step, hit.field, hit.level, hit.fix])).toEqual([
      [
        "A7-06",
        "rule",
        "error",
        "restates S13-19 rule (contact): delete it, or keep only this step's own part",
      ],
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: the master as written restates no home; a home line under 8 words said again is not read", () => {
    for (const flow of ["A", "B"] as const) {
      const file = flowFile(flow);
      const result = lint(file, flow);
      expect(result.hits).toEqual([]);
      expect(mine(result)).toEqual(reference(file, flow));
    }
    const file = flowFile("A");
    const short = moreLine(file, "S13-55", 3);
    expect(short).toBe("Nothing is ever held on a card.");
    (stepOf(file, "A7-06").more as string[]).push(short);
    const result = lint(file, "A");
    expect(result.hits).toEqual([]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: a home does not restate itself, and a step that shares some words with a home is not a restatement", () => {
    const file = flowFile("A");
    // A7-06's own Never line speaks of the owner's fee decision, as the money home does (S13-55 line 9), in its own
    // words: sharing some words is not saying the line again
    expect(moreLine(file, "A7-06", 7)).toBe(
      "Never: charge on this text. The owner decides any fee (S11-22).",
    );
    // the home of the $2 (A9-21) says the money home's line: a home is never read
    (stepOf(file, "A9-21").more as string[]).push(moreLine(file, "S13-55", 10));
    const result = lint(file, "A");
    expect(result.hits).toEqual([]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });
});
