// T-153: L1, record words in a variant (lib.js lintSteps lines 1914-1922), tested alone: runLint([l1], ...).
// Each case is the master's own steps and words, as written or moved within the flow, never invented (rule 9); each is
// also checked against lib.js lintSteps on the vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { parseFlow } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l1, recordKeyParts, timingKeyParts } from "./l1";
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

/** L1 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l1], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L1 hits on the same file, as build-master.js lintFlow calls it. */
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
    .hits.filter((hit) => hit.rule === "L1")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

describe("L1: record words in a variant", () => {
  it("fails: the master's own 'before:full' variant (S1-14) on A7-06, after the money step, is an error", () => {
    const file = flowFile("A");
    const words = (stepOf(file, "S1-14").vary as Obj)["before:full"];
    stepOf(file, "A7-06").vary = { "before:full": structuredClone(words) };

    const result = lint(file, "A");
    const fix =
      "the record carries these words (before:full): use a record slot ({{pay.took}}, {{pay.late}}, {{reach.way}} ...) and drop the variant";
    expect(result.hits.filter((hit) => hit.step === "A7-06").map(shape)).toEqual([
      { rule: "L1", level: "error", field: "vary 'before:full'", text: "before:full", fix },
    ]);
    expect(result.errors).toEqual([`A:A7-06 L1 record variant: vary 'before:full': ${fix}`]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: a branch after the money step that reads the money choice made before it is a warning (L1b)", () => {
    const file = flowFile("A");
    const branches = stepOf(file, "A7-06").branches as Obj[];
    const keep = branches.find((branch) => branch.label === "1 Keep it");
    if (keep === undefined) throw new Error("A7-06 has no branch '1 Keep it'");
    keep.when = { before: ["card", "deposit"] };

    const result = lint(file, "A");
    expect(result.hits.filter((hit) => hit.step === "A7-06").map(shape)).toEqual([
      {
        rule: "L1",
        level: "warning",
        field: "branch '1 Keep it' when",
        text: "before: card, deposit",
        fix: "use rec: (what was taken: paid, card, nothing ...), so mixes light right",
      },
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: A7-06 as written, and the master's own switch variant after the money step (A8-45 pf:sensitive)", () => {
    const file = flowFile("A");
    const result = lint(file, "A");
    expect(Object.keys(stepOf(file, "A8-45").vary as Obj)).toEqual(["pf:sensitive"]);
    expect(result.hits.filter((hit) => hit.step === "A7-06" || hit.step === "A8-45")).toEqual([]);
    // what flow A as written has: business-added variants (booking:shop) before the money step, each a warning the
    // record's allow list exempts (lint.allow)
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.hits.map((hit) => [hit.step, hit.level, hit.allowed])).toEqual([
      ["A4-21", "warning", true],
      ["A4-42", "warning", true],
      ["A4-43", "warning", true],
      ["A5-20", "warning", true],
      ["A5-31", "warning", true],
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("a key's record parts: money choices, pf:credit and the record's booking groups; timing parts apart", () => {
    expect(recordKeyParts("price:visit+before:deposit+after:card")).toEqual([
      "price:visit",
      "before:deposit",
      "after:card",
    ]);
    expect(recordKeyParts("pf:credit+pf:sensitive")).toEqual(["pf:credit"]);
    expect(recordKeyParts("booking:callsonly+booking:private")).toEqual([
      "booking:callsonly",
      "booking:private",
    ]);
    // the record's own groups: charge, contact, payer
    expect(recordKeyParts("booking:failed+booking:switched+booking:other")).toHaveLength(3);
    // not the record's: a switch, the timing, the times, who made the booking
    expect(recordKeyParts("pf:sensitive+booking:sentnow+booking:setstart+booking:shop")).toEqual([]);
    expect(timingKeyParts("booking:shop+booking:sentnow+booking:setstart")).toEqual([
      "booking:shop",
      "booking:sentnow",
    ]);
  });
});
