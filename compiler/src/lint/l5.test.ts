// T-154: L5, twin drift (lib.js mergeShared lines 1704-1713), tested alone: runLint([l5], ...). Each case is the
// master's own steps and words, as written or moved within the flows, never invented (rule 9). lib.js lintSteps has no
// L5: the master runs it where it joins its source parts (mergeShared). So the failing case is also run through the
// vendored mergeShared, on a source part made of the same words: the shared text A7-06 as flow A reads it, and the
// step that names it, setting what the case sets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l5, SHARED_WORDS, sharedTexts, textOf } from "./l5";
import { eachStep, masterInput, runLint, tradeInput, type LintResult, type LintStep } from "./runner";

const WORK = fileURLToPath(new URL("../../../fixtures/master/engine/work/", import.meta.url));

type Obj = Record<string, unknown>;
interface RefHit {
  rule: string;
  level: string;
  id: string;
  field: string;
  text: string;
  fix: string;
}
interface Reference {
  mergeShared(parts: Obj, flow: FlowLetter, opts: { names: Obj }): { errors: string[]; hits: RefHit[] };
  lintSort(hits: RefHit[], record: unknown, flow: FlowLetter): { errors: string[] };
  eachStep(steps: unknown, visit: (step: Obj) => void): void;
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;
const master = loadMaster();

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

function branchesOf(step: Obj): Obj[] {
  return step.branches as Obj[];
}

/** L5 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l5], masterInput(parseFlow(structuredClone(file), flow)));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step }));
}

function theirs(hits: RefHit[]): Obj[] {
  return hits.map((hit) => ({ ...shape(hit), step: hit.id }));
}

describe("L5: twin drift", () => {
  it("fails: A7-06 says A7-05's words (its does, its first label and endText): twin drift, as mergeShared finds it", () => {
    const file = flowFile("A");
    const step = stepOf(file, "A7-06");
    const donor = stepOf(flowFile("A"), "A7-05");
    const [first] = branchesOf(step);
    const [donorFirst] = branchesOf(donor);
    if (first === undefined || donorFirst === undefined) throw new Error("A7-06 or A7-05 has no branch");
    expect(step.text).toBe("A7-06");
    expect(stepOf(flowFile("B"), "B7-10").text).toBe("A7-06");

    // The shared text A7-06 as flow A reads it: its words, labels and endTexts as the join laid them on A7-06.
    const text = {
      title: step.title,
      does: step.does,
      more: step.more,
      say: step.say,
      labels: branchesOf(step).map((branch) => branch.label),
      endTexts: branchesOf(step).map((branch) => branch.endText ?? null),
    };
    step.does = donor.does;
    first.label = donorFirst.label;
    first.endText = donorFirst.endText;

    const result = lint(file, "A");
    expect(result.hits.map(shape)).toEqual([
      {
        rule: "L5",
        level: "error",
        field: "does",
        text: "A7-06",
        fix: "the words live in the shared text A7-06: take 'does' off the step (a real twin difference: {{ab:A words|B words}} in the text, or addMore on the step)",
      },
      {
        rule: "L5",
        level: "error",
        field: "branch 1 label",
        text: "2 Cancel it",
        fix: `the shared text A7-06 names it '2 Cancel anyway': leave the step's label empty ("")`,
      },
      {
        rule: "L5",
        level: "error",
        field: "branch 1 endText",
        text: "Cancelled in time. Anything paid comes back, as the booking took it.",
        fix: "the shared text A7-06 has its endText: take it off the step",
      },
    ]);
    expect(result.errors[0]).toBe(
      "A:A7-06 L5 twin drift: does 'A7-06': the words live in the shared text A7-06: take 'does' off the step (a real twin difference: {{ab:A words|B words}} in the text, or addMore on the step)",
    );

    // The same drift in the master's own source shape: a part whose step names the text and sets what the case set
    // (its other words left to the text, its other labels empty), run through the vendored mergeShared.
    const own: Obj = { ...step, branches: structuredClone(branchesOf(step)) };
    for (const field of ["title", "more", "say"]) Reflect.deleteProperty(own, field);
    branchesOf(own).forEach((branch, k) => {
      if (k > 0) branch.label = "";
    });
    const parts = { A710: { part: "A710", shared: { "A7-06": text }, sections: [{ n: 7, steps: [own] }] } };
    const names = { A: file.names, B: flowFile("B").names };
    const merged = ref.mergeShared(parts, "A", { names });
    expect(merged.errors).toEqual([]);
    expect(mine(result)).toEqual(theirs(merged.hits));
    expect(result.errors).toEqual(ref.lintSort(merged.hits, file.record, "A").errors);
  });

  it("passes: both flows as written, each of the 205 shared texts named by one twin in each flow", () => {
    for (const flow of ["A", "B"] as const) {
      const result = runLint([l5], masterInput(master[flow]));
      expect(result.hits).toEqual([]);
      expect(result.rules).toEqual([{ rule: "L5", errors: 0, warnings: 0, allowed: 0 }]);
    }
    const texts = sharedTexts();
    expect(texts.size).toBe(205);
    for (const text of texts.values()) {
      expect(text.twins.A?.id.startsWith("A")).toBe(true);
      expect(text.twins.B?.id.startsWith("B")).toBe(true);
      expect(text.twins.A === undefined ? undefined : textOf(text.twins.A)).toBe(text.name);
    }
  });

  it("passes: a field only one twin has is that step's own (B4-115's booking:sentnow variant, given to A4-98 too)", () => {
    const text = sharedTexts().get("A4-98");
    expect(text?.twins.B?.id).toBe("B4-115");
    // B4-115 also has two lines of its own after the shared ones (addMore) and a variant A4-98 lacks: the join's
    expect(text?.words).toEqual(["title", "does", "more", "q"]);

    const file = flowFile("A");
    stepOf(file, "A4-98").vary = structuredClone(stepOf(flowFile("B"), "B4-115").vary);
    expect(lint(file, "A").hits).toEqual([]);
    // the text's own words moved the same way are drift
    stepOf(file, "A4-98").more = structuredClone(stepOf(flowFile("B"), "B4-115").more);
    expect(lint(file, "A").hits.map((hit) => [hit.step, hit.field])).toEqual([["A4-98", "more"]]);
  });

  it("passes: a trade's applied flow is not read: aba's words on the twins are its own (SPEC-prof 3: ops per flow)", () => {
    const trade = loadTrade("aba");
    const input = tradeInput(applyTrade(master.A, trade), trade);
    const texts = sharedTexts();
    const own: string[] = [];
    eachStep(input.steps, (step: LintStep) => {
      const name = textOf(step);
      const twin = name === undefined ? undefined : texts.get(name)?.twins.A;
      if (twin !== undefined && SHARED_WORDS.some((field) => !isDeepStrictEqual(step[field], twin[field])))
        own.push(step.id);
    });
    expect(own.length).toBeGreaterThan(0);
    expect(runLint([l5], input).hits).toEqual([]);
  });
});
