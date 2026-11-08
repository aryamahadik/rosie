// T-154: L6, a name the cut list removed (lib.js lintSteps lines 1923-1924, cutHits lines 1995-2007), tested alone:
// runLint([l6], ...). Each case is the master's own steps and words, and the names its record's cut list holds
// (record.live: off and merged), moved within the flow, never invented (rule 9); each is also checked against lib.js
// lintSteps on the vendored copy, given the very same flow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { parseFlow } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { l6 } from "./l6";
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

/** A step's branch by its label. */
function branchOf(step: Obj, label: string): Obj {
  const found = (step.branches as Obj[]).find((branch) => branch.label === label);
  if (found === undefined) throw new Error(`${String(step.id)} has no branch '${label}'`);
  return found;
}

/** The record's live block, as the flow file writes it. */
function liveOf(file: Obj): {
  off: Record<string, string[]>;
  merged: Record<string, Record<string, string>>;
} {
  return (file.record as Obj).live as {
    off: Record<string, string[]>;
    merged: Record<string, Record<string, string>>;
  };
}

/** L6 alone, on the flow file as the compiler loads it. */
function lint(file: Obj, flow: FlowLetter): LintResult {
  return runLint([l6], masterInput(parseFlow(structuredClone(file), flow)));
}

/** lintSteps' L6 hits on the same file, as build-master.js lintFlow calls it. */
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
    .hits.filter((hit) => hit.rule === "L6")
    .map((hit) => ({ ...shape(hit), step: hit.id, allowed: hit.allowed === true }));
}

function shape(hit: { rule: string; level: string; field: string; text: string; fix: string }): Obj {
  return { rule: hit.rule, level: hit.level, field: hit.field, text: hit.text, fix: hit.fix };
}

function mine(result: LintResult): Obj[] {
  return result.hits.map((hit) => ({ ...shape(hit), step: hit.step, allowed: hit.allowed }));
}

describe("L6: a name the cut list removed", () => {
  it("fails: the merged names: A8-45's variant under the old switch grief, A5-01 gated on the old fact memberships", () => {
    const file = flowFile("A");
    const { merged } = liveOf(file);
    const grief = merged.switches?.grief;
    expect(grief).toBe(
      "sensitive (guard 1: no rating, nothing sold, no fee unless the owner's own setting, gentle words)",
    );
    expect(merged.facts?.memberships).toBe("packs");

    const notes = stepOf(file, "A8-45");
    notes.vary = { "pf:grief": (notes.vary as Obj)["pf:sensitive"] };
    const pack = branchOf(stepOf(file, "A5-01"), "A package or membership");
    pack.when = { ...(pack.when as Obj), factOn: ["memberships"] };

    const result = lint(file, "A");
    expect(result.hits.map(shape)).toEqual([
      {
        rule: "L6",
        level: "error",
        field: "branch 'A package or membership' when factOn",
        text: "fact memberships (now: packs)",
        fix: "cut by CUT-LIST: fact memberships (now: packs): take it out, or use what replaced it",
      },
      {
        rule: "L6",
        level: "error",
        field: "vary 'pf:grief'",
        text: `switch grief (now: ${String(grief)})`,
        fix: `cut by CUT-LIST: switch grief (now: ${String(grief)}): take it out, or use what replaced it`,
      },
    ]);
    expect(result.hits.map((hit) => hit.step)).toEqual(["A5-01", "A8-45"]);
    expect(result.errors).toHaveLength(2);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("fails: cut booking values: A7-96's new way set to reach notsafe, A4-98's OK branch gated on approval expert", () => {
    const file = flowFile("A");
    const { off } = liveOf(file);
    expect(off.reach).toEqual(["notsafe"]);
    expect(off.approval).toEqual(["expert"]);

    const way = branchOf(stepOf(file, "A7-96"), "Alex changes where updates go");
    way.sets = { ...(way.sets as Obj), reach: "notsafe" };
    const ok = branchOf(stepOf(file, "A4-98"), "Sam's OK first");
    ok.when = { booking: ["ownerok", "expert"] };

    const result = lint(file, "A");
    expect(result.hits.map((hit) => [hit.step, hit.field, hit.text, hit.fix])).toEqual([
      [
        "A4-98",
        "branch 'Sam's OK first' when booking",
        "approval expert",
        "cut by CUT-LIST: approval expert: take it out",
      ],
      [
        "A7-96",
        "branch 'Alex changes where updates go' sets",
        "reach notsafe",
        "cut by CUT-LIST: reach notsafe: take it out",
      ],
    ]);
    expect(result.errors).toEqual([
      "A:A4-98 L6 cut: branch 'Sam's OK first' when booking 'approval expert': cut by CUT-LIST: approval expert: take it out",
      "A:A7-96 L6 cut: branch 'Alex changes where updates go' sets 'reach notsafe': cut by CUT-LIST: reach notsafe: take it out",
    ]);
    expect(mine(result)).toEqual(reference(file, "A"));
  });

  it("passes: both flows as written: every name they use is live (pf:sensitive, reach email, approval ownerok ...)", () => {
    for (const flow of ["A", "B"] as const) {
      const file = flowFile(flow);
      const result = lint(file, flow);
      expect(result.hits).toEqual([]);
      expect(mine(result)).toEqual(reference(file, flow));
    }
    const file = flowFile("A");
    expect(Object.keys(stepOf(file, "A8-45").vary as Obj)).toEqual(["pf:sensitive"]);
    expect(branchOf(stepOf(file, "A7-96"), "Alex changes where updates go").sets).toEqual({
      contact: "switched",
      reach: "email",
    });
    expect(branchOf(stepOf(file, "A4-98"), "Sam's OK first").when).toEqual({ booking: ["ownerok"] });
  });
});
