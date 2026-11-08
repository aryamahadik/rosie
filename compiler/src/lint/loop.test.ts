// T-158: the rule `loop`, a walk can loop (QUESTIONS Q-39's default: a cycle through relative t references or
// flow-switch ends, where code's walk would not stop at a step that asks, waits or ends; arch 12 line 592; arch 03 line
// 191; SPEC-master 5g), tested alone: runLint([loop], ...). Each case is the master's own steps with one time or one
// branch end changed within the flow, never new words (rule 9). refuse-loop.json is K-01's own refused step, checked
// with K-01's schema; a loop of named times is also checked against lib.js flowTimeProblems on the vendored copy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compileBranches, flowSwitches } from "../branches";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster, parseFlow } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { findLoops, loop, loopRule, splitKind, timeReferences } from "./loop";
import { masterInput, runLint, tradeInput, type LintInput, type LintResult, type LintStep } from "./runner";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;

type Obj = Record<string, unknown>;

interface Reference {
  flowTimeProblems(steps: unknown, flow: FlowLetter): string[];
  CORE: { syncWays(flow: unknown): void };
}
const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

const FIX_TIME = "time it from a step outside this loop, or give it a fixed time";

/** A master flow file as written (a fresh copy each time). */
function flowFile(flow: FlowLetter): Obj {
  return JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as Obj;
}

function list(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

/** A step of a flow file by id, branch steps included. */
function stepOf(file: Obj, id: string): Obj {
  const find = (steps: Obj[]): Obj | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      for (const branch of list(step.branches)) {
        const inner = find(list(branch.steps));
        if (inner !== undefined) return inner;
      }
    }
    return undefined;
  };
  const found = find(list(file.steps));
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

/** A branch of a split by its label. */
function branchOf(step: Obj, label: string): Obj {
  const found = list(step.branches).find((branch) => branch.label === label);
  if (found === undefined) throw new Error(`${String(step.id)} has no branch '${label}'`);
  return found;
}

/** The lint's input for a flow file, as the compiler loads it. */
function input(file: Obj, flow: FlowLetter): LintInput {
  return masterInput(parseFlow(structuredClone(file), flow));
}

/** The rule alone on a flow file; given the other flow's file, the rule follows switches into it. */
function lint(file: Obj, flow: FlowLetter, other: Obj | null = null): LintResult {
  const rule = other === null ? loop : loopRule(input(other, flow === "A" ? "B" : "A"));
  return runLint([rule], input(file, flow));
}

function hits(result: LintResult): { step: string; field: string; text: string }[] {
  return result.hits.map(({ step, field, text }) => ({ step, field, text }));
}

/** lib.js flowTimeProblems' loop lines on a flow file (build-master.js's check that a relative time never loops). */
function libLoops(file: Obj, flow: FlowLetter): string[] {
  ref.CORE.syncWays(file);
  return ref.flowTimeProblems(file.steps, flow).filter((line) => line.endsWith("in a loop"));
}

/** K-01 v1's step definition, with the schema's own checks (Ajv, as the contract harness sets it up). */
function stepSchema(): (value: unknown) => boolean {
  const schema = JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as {
    $id: string;
  };
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as object);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/step`);
  if (validate === undefined) throw new Error("K-01 v1 has no step definition");
  return (value) => validate(value) === true;
}

/** How T-291's frontier reads a compiled K-01 step (actions/src/frontier/assemble/bundle.ts splitOf), from its tags. */
function frontierKind(step: Obj): string | null {
  const branches = list(step.branches);
  if (step.type !== "split" && branches.length === 0) return null;
  const tags = branches.map((branch) => branch.tag);
  if (tags.length === 0 || tags.some((tag) => tag !== "message" && tag !== "lookup" && tag !== "clock"))
    return "unknown";
  if (tags.includes("message") && step.via === "sync") return "unknown";
  return tags.includes("message") || tags.includes("clock") ? "asks" : "code";
}

describe("loop: a walk can loop (Q-39 default)", () => {
  it("passes: both master flows as written, alone and with the other flow; A's 3 flow switches lead to no step of B", () => {
    for (const [flow, other] of [
      ["A", "B"],
      ["B", "A"],
    ] as const) {
      expect(lint(flowFile(flow), flow).hits).toEqual([]);
      expect(lint(flowFile(flow), flow, flowFile(other)).hits).toEqual([]);
      expect(libLoops(flowFile(flow), flow)).toEqual([]);
    }
    const master = loadMaster();
    const switches = flowSwitches(compileBranches(master.A.path));
    expect(switches.map(({ id, flow }) => `${id} ${flow}`).sort()).toEqual([
      "A10-32 B",
      "A4-01 B",
      "A4-15 B",
    ]);
    // Each is a split of flow A's own: flow B holds no step of that id, so nothing there leads back.
    for (const { id } of switches) expect(master.B.steps[id]).toBeUndefined();
    expect(flowSwitches(compileBranches(master.B.path))).toEqual([]);
  });

  it("reads each relative time as SPEC-master 5g does: the step it names, or the timed step before it on each path", () => {
    // A6-14 'right after': after A6-32 (the link to pay what's due, on the path where A6-10's charge failed), and after
    // A5-04 ('3 minutes later') on the others.
    const a = timeReferences(input(flowFile("A"), "A"));
    expect(a.filter((reference) => reference.step === "A6-14")).toEqual([
      { step: "A6-14", field: "t", from: "A5-04" },
      { step: "A6-14", field: "t", from: "A6-32" },
    ]);
    expect(a.filter((reference) => reference.step === "A7-70")).toEqual([
      { step: "A7-70", field: "t", from: "A8-03" },
    ]);
    // B7-27: 'the day of B8-01, 7:40am', and in its booking:sentnow variant '10 minutes after B8-91'.
    const b = timeReferences(input(flowFile("B"), "B"));
    expect(b.filter((reference) => reference.step === "B7-27")).toEqual([
      { step: "B7-27", field: "t", from: "B8-01" },
      { step: "B7-27", field: "vary 'booking:sentnow' t", from: "B8-91" },
    ]);
  });

  it("fails: refuse-loop.json, K-01's refused step, A6-14 'right after' A6-26 timed from it: the walk A6-14, A6-26, A6-14", () => {
    const fixture = JSON.parse(
      readFileSync(`${ROOT}contracts/bundle/fixtures/invalid/refuse-loop.json`, "utf8"),
    ) as LintStep & { t: string; walk: string[]; lint: string[] };
    expect(fixture.t).toBe("right after");
    expect(fixture.lint).toEqual([]);
    // The step the fixture's walk names next, as the walk has it: the timed step right before A6-14, its time set
    // from A6-14.
    const before = { id: "A6-26", t: "right after A6-14" };
    const steps: LintStep[] = [before, fixture];
    const result = runLint([loop], { ...masterInput(loadMaster().A), steps });
    expect(hits(result)).toEqual([
      { step: "A6-26", field: "t", text: "A6-26 > A6-14 > A6-26" },
      { step: "A6-14", field: "t", text: "A6-14 > A6-26 > A6-14" },
    ]);
    expect(result.errors).toContain(`A:A6-14 loop walk can loop: t 'A6-14 > A6-26 > A6-14': ${FIX_TIME}`);
    const failing = result.hits.find((hit) => hit.step === "A6-14");
    expect(failing?.rule).toBe("loop");
    const walk = findLoops({ flow: "A", steps }).find((found) => found.step === "A6-14")?.walk;
    expect(walk).toEqual(fixture.walk);

    // K-01 refuses the step as it stands (its walk comes back to a step and its lint is empty), and takes it once its
    // lint names the rule that failed it, with the walk the rule found.
    const valid = stepSchema();
    expect(valid(fixture)).toBe(false);
    expect(valid({ ...fixture, walk, lint: [failing?.rule] })).toBe(true);

    // A step switched off (an `off` op) is not walked: with A6-26 off, A6-14 has no timed step before it.
    const off = { ...before, off: "not offered" };
    expect(runLint([loop], { ...masterInput(loadMaster().A), steps: [off, fixture] }).hits).toEqual([]);
  });

  it("fails: the same loop in the master: S1-79 'right after' S1-50, once S1-50 is timed right after S1-79", () => {
    const file = flowFile("A");
    const s150 = stepOf(file, "S1-50");
    expect(s150.t).toBe("14 minutes later");
    expect(stepOf(file, "S1-79").t).toBe("right after");
    s150.t = "right after S1-79";
    const result = lint(file, "A");
    expect(hits(result)).toEqual([
      { step: "S1-50", field: "t", text: "S1-50 > S1-79 > S1-50" },
      { step: "S1-79", field: "t", text: "S1-79 > S1-50 > S1-79" },
    ]);
    expect(result.errors).toEqual([
      `A:S1-50 loop walk can loop: t 'S1-50 > S1-79 > S1-50': ${FIX_TIME}`,
      `A:S1-79 loop walk can loop: t 'S1-79 > S1-50 > S1-79': ${FIX_TIME}`,
    ]);
    expect(result.rules).toEqual([{ rule: "loop", errors: 2, warnings: 0, allowed: 0 }]);
  });

  it("fails: named times that loop through A5-04, a split code settles (each branch a lookup), as lib.js finds them", () => {
    const file = flowFile("A");
    stepOf(file, "A5-04").t = "right after A6-14";
    stepOf(file, "A6-14").t = "right after A5-04";
    expect(hits(lint(file, "A"))).toEqual([
      { step: "A5-04", field: "t", text: "A5-04 > A6-14 > A5-04" },
      { step: "A6-14", field: "t", text: "A6-14 > A5-04 > A6-14" },
    ]);
    expect(libLoops(file, "A")).toEqual([
      "A:A5-04 its time and A6-14 are set from each other in a loop",
      "A:A6-14 its time and A5-04 are set from each other in a loop",
    ]);
  });

  it("does not report a cycle that passes through a step that asks: A7-70 and A8-03 (check-in), which lib.js calls a loop", () => {
    const file = flowFile("A");
    expect(stepOf(file, "A7-70").t).toBe("30 minutes before A8-03");
    stepOf(file, "A8-03").t = "right after A7-70";
    const read = input(file, "A");
    // The cycle is there: each time is set from the other's.
    expect(timeReferences(read).filter((reference) => ["A7-70", "A8-03"].includes(reference.step))).toEqual([
      { step: "A7-70", field: "t", from: "A8-03" },
      { step: "A8-03", field: "t", from: "A7-70" },
    ]);
    expect(libLoops(file, "A")).toEqual([
      "A:A7-70 its time and A8-03 are set from each other in a loop",
      "A:A8-03 its time and A7-70 are set from each other in a loop",
    ]);
    // A8-03 asks how check-in goes (its branches are messages): code's walk stops there, so nothing is reported.
    const a803 = parseFlow(structuredClone(file), "A").steps["A8-03"];
    expect(a803 === undefined ? null : splitKind(a803)).toBe("asks");
    expect(runLint([loop], read).hits).toEqual([]);
  });

  it("reports a cycle through a split the walk cannot read (A6-10, a sync split with message branches): the safer reading", () => {
    const file = flowFile("A");
    stepOf(file, "A6-10").t = "right after A6-14";
    stepOf(file, "A6-14").t = "right after A6-10";
    expect(hits(lint(file, "A"))).toEqual([
      { step: "A6-10", field: "t", text: "A6-10 > A6-14 > A6-10" },
      { step: "A6-14", field: "t", text: "A6-14 > A6-10 > A6-14" },
    ]);
  });

  it("reads splits as T-291's frontier reads K-01's compiled steps (splitOf): every step of bundle-mini-a and -b", () => {
    const master = loadMaster();
    const seen: Record<string, number> = {};
    for (const [name, flow] of [
      ["bundle-mini-a.json", "A"],
      ["bundle-mini-b.json", "B"],
    ] as const) {
      const bundle = JSON.parse(readFileSync(`${ROOT}contracts/bundle/fixtures/${name}`, "utf8")) as {
        flows: Partial<Record<FlowLetter, { steps: Record<string, Obj> }>>;
      };
      for (const [id, compiled] of Object.entries(bundle.flows[flow]?.steps ?? {})) {
        const step = master[flow].steps[id];
        if (step === undefined) throw new Error(`${name}: no master step ${id}`);
        const kind = frontierKind(compiled);
        expect(splitKind(step), `${flow} ${id}`).toBe(kind);
        seen[String(kind)] = (seen[String(kind)] ?? 0) + 1;
      }
    }
    expect(Object.keys(seen).sort()).toEqual(["asks", "code", "null"]);
    // The four kinds: A5-04 is settled by code (four lookups); A6-02 asks (and waits on a clock); A6-10 cannot be read
    // (a sync split with message branches); A6-14 is no split.
    const kinds = ["A5-04", "A6-02", "A6-10", "A6-14"].map((id) => {
      const step = master.A.steps[id];
      return step === undefined ? `no ${id}` : splitKind(step);
    });
    expect(kinds).toEqual(["code", "asks", "unknown", null]);
  });

  it("fails: a flow switch that names its own flow comes back to its split: on A5-04, which code settles; not on A4-01, which asks", () => {
    const file = flowFile("A");
    const nothing = branchOf(stepOf(file, "A5-04"), "Nothing taken");
    nothing.end = "end";
    nothing.flow = "A";
    expect(hits(lint(file, "A"))).toEqual([
      { step: "A5-04", field: "walk", text: "A5-04 > A5-05 > A5-04" },
      { step: "A5-05", field: "walk", text: "A5-05 > A5-04 > A5-05" },
    ]);

    const asks = flowFile("A");
    const home = branchOf(stepOf(asks, "A4-01"), "2 At my home");
    expect(home.flow).toBe("B");
    home.flow = "A";
    expect(lint(asks, "A").hits).toEqual([]);
  });

  it("fails: a switch into the other flow and back once the rule is given that flow (S12-05 settled by code); not while it asks", () => {
    const switchService = (file: Obj, to: FlowLetter): Obj => {
      const service = branchOf(stepOf(file, "S12-05"), "The service");
      service.end = "end";
      service.flow = to;
      return file;
    };
    // Each branch gated on what was taken, as A5-04's are: code settles the split by the booking's money path.
    const settle = (file: Obj): Obj => {
      const split = stepOf(file, "S12-05");
      branchOf(split, "Nothing: all right as sent").when = { before: ["none"] };
      branchOf(split, "The service").when = { before: ["card"] };
      branchOf(split, "The price").when = { before: ["deposit", "full"] };
      return file;
    };
    const a = switchService(settle(flowFile("A")), "B");
    const b = switchService(settle(flowFile("B")), "A");
    // Alone, flow A's switch goes on in flow B, which the run does not hold: nothing comes back.
    expect(lint(a, "A").hits).toEqual([]);
    // Given flow B, the walk goes on at S12-05 in B, whose own switch brings it back to A.
    const round = [
      { step: "S12-05", field: "walk", text: "S12-05 > S12-06 > S12-05 > S12-06 > S12-05" },
      { step: "S12-06", field: "walk", text: "S12-06 > S12-05 > S12-06 > S12-05 > S12-06" },
    ];
    expect(hits(lint(a, "A", b))).toEqual(round);
    expect(hits(lint(b, "B", a))).toEqual(round);

    // The same switches on S12-05 as written, a question ("What's wrong?"): code's walk stops there.
    const askA = switchService(flowFile("A"), "B");
    const askB = switchService(flowFile("B"), "A");
    expect(lint(askA, "A", askB).hits).toEqual([]);
    expect(() => runLint([loopRule(input(askA, "A"))], input(askA, "A"))).toThrow(
      "the other flow given to the loop rule is flow A, the flow it lints",
    );
  });

  it("fails: a variant's time counts, and the hit names it: B7-27's booking:sentnow time, 10 minutes after B8-91", () => {
    const file = flowFile("B");
    const vary = stepOf(file, "B7-27").vary as Record<string, Obj>;
    expect(vary["booking:sentnow"]?.t).toBe("10 minutes after B8-91");
    stepOf(file, "B8-91").t = "right after B7-27";
    expect(hits(lint(file, "B"))).toEqual([
      { step: "B7-27", field: "vary 'booking:sentnow' t", text: "B7-27 > B8-91 > B7-27" },
      { step: "B8-91", field: "t", text: "B8-91 > B7-27 > B8-91" },
    ]);
  });

  it("passes: trades' applied flows, aba in flow A and cpa in flow B, each given its other flow", () => {
    const master = loadMaster();
    for (const [id, flow, other] of [
      ["aba", "A", "B"],
      ["cpa", "B", "A"],
    ] as const) {
      const trade = loadTrade(id);
      const there = applyTrade(master[other], trade);
      const rule = loopRule({ flow: other, steps: there.flow.steps });
      const result = runLint([rule], tradeInput(applyTrade(master[flow], trade), trade));
      expect(result.trade).toBe(id);
      expect(result.hits).toEqual([]);
    }
  });
});
