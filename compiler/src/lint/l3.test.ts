// T-153: L3, pointer lines (lib.js lintSteps lines 1944-1953, pointerLine lines 1823-1844), tested alone:
// runLint([l3], ...). Each case is the master's own steps and words (the record's own pointer lines, the steps' own
// lines), as written or moved within the flow, never invented (rule 9); each is also checked against lib.js lintSteps
// on the vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { parseFlow } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l3, pointerLine } from "./l3";
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
  pointerLine(text: unknown, pointers: RegExp[]): { kind: string; keep?: string };
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

/** L3 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l3], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L3 hits on the same file, as build-master.js lintFlow calls it. */
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
    .hits.filter((hit) => hit.rule === "L3")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

/** The record's pointer patterns, as the flow file writes them (record.lint.pointers). */
function pointers(file: Obj): string[] {
  return ((file.record as Obj).lint as { pointers: string[] }).pointers;
}

describe("L3: pointer lines", () => {
  it("fails: a line that only points to the clock home (the record's own 'Clocks: S13-35.') is an error", () => {
    const file = flowFile("A");
    expect(pointers(file)).toContain("^Clocks: S13-35\\.?$");
    (stepOf(file, "A7-06").more as string[]).push("Clocks: S13-35.");

    const result = lint(file, "A");
    expect(result.hits.map(shape)).toEqual([
      {
        rule: "L3",
        level: "error",
        field: "more 9",
        text: "Clocks: S13-35.",
        fix: "delete it: the build lists what a step follows (reads)",
      },
    ]);
    expect(result.errors).toEqual([
      "A:A7-06 L3 pointer line: more 9 'Clocks: S13-35.': delete it: the build lists what a step follows (reads)",
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: a pointer beside the step's own safe default is a warning: keep the step's own words", () => {
    const file = flowFile("A");
    const step = stepOf(file, "A7-06");
    const more = step.more as string[];
    expect(more).toContain("Safe default: the visit stays booked.");
    const line =
      "Unclear, late or off-topic answer: judgment rules 16 to 24. Safe default here: the visit stays booked.";
    more.push(line);

    const result = lint(file, "A");
    expect(result.hits.map(shape)).toEqual([
      {
        rule: "L3",
        level: "warning",
        field: "more 9",
        text: line,
        fix: "keep it as 'Safe default: the visit stays booked.' and drop the pointer words (never delete the line: it holds this step's own words)",
      },
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: A7-03's own clock line is the step's own rule, not a pointer; the master as written has no pointer line", () => {
    for (const flow of ["A", "B"] as const) {
      const file = flowFile(flow);
      const result = lint(file, flow);
      expect(result.hits).toEqual([]);
      expect(mine(result)).toEqual(reference(file, flow));
    }
    const file = flowFile("A");
    const own = (stepOf(file, "A7-03").more as string[]).find((line) => line.startsWith("Clock:"));
    expect(own).toBe("Clock: the customer picks within 24 hours; silence keeps the time as booked.");
    const patterns = pointers(file).map((source) => new RegExp(source, "i"));
    expect(pointerLine(own, patterns)).toEqual({ kind: "none" });
  });

  it("reads a line as lintSteps' pointerLine does, sentence by sentence", () => {
    const file = flowFile("A");
    const patterns = pointers(file).map((source) => new RegExp(source, "i"));
    const lines = [
      "Clocks: S13-35.",
      "Who decides: S13-31.",
      "Stop words and consent: S13-32, and the stop line once.",
      "Unclear, late or off-topic answer: judgment rules 16 to 24. Safe default here: the visit stays booked.",
      "Never: charge on this text. The owner decides any fee (S11-22).",
      ...(stepOf(file, "A7-06").more as string[]),
    ];
    for (const line of lines)
      expect(pointerLine(line, patterns), line).toEqual(ref.pointerLine(line, patterns));
    expect(lines.slice(0, 4).map((line) => pointerLine(line, patterns).kind)).toEqual([
      "bare",
      "bare",
      "partial",
      "mixed",
    ]);
  });
});
