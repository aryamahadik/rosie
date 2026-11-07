// T-135: the overlay applier. The whole-set comparison with overlay-core.js apply() (243 trades x both flows) is in
// the parity.shard-N.test.ts files; this file holds the three refused inputs, the other complaints, what applying
// leaves alone, a few worked trades, and the check that the shards cover every trade once.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FlowGraph } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade, type OwnStep, type TradeOp } from "../load/trade";
import {
  MissingBranchLabelError,
  OffWithoutWhyError,
  OverlayApplyError,
  UnknownStepError,
  applyTrade,
  type AppliedStep,
} from "./apply";
import { BUILD_DIR } from "./core";
import { SHARDS, shardOf } from "./parity";

const master = loadMaster();

/** A trade to damage: barber as the file has it, its flow-A ops replaced by `ops`. */
function barberWith(ops: TradeOp[]): LoadedTrade {
  const trade = structuredClone(loadTrade("barber"));
  trade.flows.A.ops = ops;
  return trade;
}

/** The first decision of the flow that has branches, and its first branch label. */
function aSplit(graph: FlowGraph): { id: string; label: string } {
  for (const step of Object.values(graph.steps)) {
    const label = step.branches?.[0]?.label;
    if (step.type === "split" && label !== undefined) return { id: step.id, label };
  }
  throw new Error("the flow has no decision");
}

function flatten(steps: AppliedStep[], into: AppliedStep[] = []): AppliedStep[] {
  for (const step of steps) {
    into.push(step);
    for (const branch of step.branches ?? []) flatten(branch.steps, into);
  }
  return into;
}

describe("refused inputs", () => {
  it("an unknown step id raises UnknownStepError and names the op", () => {
    const trade = barberWith([{ op: "more", at: "S1-99", more: ["x"] }]);
    const run = () => applyTrade(master.A, trade);
    expect(run).toThrow(UnknownStepError);
    expect(run).toThrow(/A op 1 \(more S1-99\): no master step S1-99 in flow A/);
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(OverlayApplyError);
      expect((error as UnknownStepError).name).toBe("UnknownStepError");
      expect((error as UnknownStepError).code).toBe("unknown-step");
      expect((error as UnknownStepError).trade).toBe("barber");
    }
  });

  it("an unknown step id in flow B is refused the same way", () => {
    const trade = structuredClone(loadTrade("barber"));
    trade.flows.B.ops = [{ op: "words", at: "B9-99", does: "x" }];
    expect(() => applyTrade(master.B, trade)).toThrow(UnknownStepError);
  });

  it("an id from an earlier op's added steps is known; the same id before that op is not", () => {
    const own: OwnStep = { id: "A1-x01", line: ["1"], who: "san", via: "chat", title: "t", does: "d" };
    const split = aSplit(master.A);
    const after: TradeOp = { op: "after", at: split.id, steps: [own] };
    const more: TradeOp = { op: "more", at: "A1-x01", more: ["y"] };
    expect(() => applyTrade(master.A, barberWith([after, more]))).not.toThrow();
    expect(() => applyTrade(master.A, barberWith([more, after]))).toThrow(UnknownStepError);
  });

  it("an off that names a branch the step does not have raises MissingBranchLabelError", () => {
    const split = aSplit(master.A);
    const trade = barberWith([{ op: "off", at: split.id, label: "no such branch", why: "test" }]);
    expect(() => applyTrade(master.A, trade)).toThrow(MissingBranchLabelError);
    expect(() => applyTrade(master.A, trade)).toThrow(/no branch 'no such branch'/);
  });

  it("a branch op with no label raises MissingBranchLabelError", () => {
    const split = aSplit(master.A);
    const trade = barberWith([{ op: "branch", at: split.id, branch: { label: "" } }]);
    expect(() => applyTrade(master.A, trade)).toThrow(MissingBranchLabelError);
  });

  it("an off with no why raises OffWithoutWhyError, for a step and for a branch", () => {
    const split = aSplit(master.A);
    const step = barberWith([{ op: "off", at: split.id, why: "" }]);
    expect(() => applyTrade(master.A, step)).toThrow(OffWithoutWhyError);
    expect(() => applyTrade(master.A, step)).toThrow(/A op 1 \(off .*\): say why/);
    const branch = barberWith([{ op: "off", at: split.id, label: split.label, why: "   " }]);
    expect(() => applyTrade(master.A, branch)).toThrow(OffWithoutWhyError);
  });

  it("an off with a why and a real branch label is applied", () => {
    const split = aSplit(master.A);
    const trade = barberWith([{ op: "off", at: split.id, label: split.label, why: "not in this work" }]);
    const { flow } = applyTrade(master.A, trade);
    const hit = flatten(flow.steps).find((step) => step.id === split.id);
    expect(hit?.branches?.[0]?.off).toBe("not in this work");
  });

  it("a branch op on a step that is not a decision is refused as an OverlayApplyError", () => {
    const plain = Object.values(master.A.steps).find((step) => step.type !== "split");
    if (plain === undefined) throw new Error("the flow has no plain step");
    const trade = barberWith([{ op: "branch", at: plain.id, branch: { label: "x" } }]);
    const run = () => applyTrade(master.A, trade);
    expect(run).toThrow(OverlayApplyError);
    expect(run).not.toThrow(UnknownStepError);
    expect(run).toThrow(/isn't a decision/);
  });

  it("reports every complaint, in op order, and the first in the message", () => {
    const trade = barberWith([
      { op: "more", at: "S1-98", more: ["x"] },
      { op: "more", at: "S1-99", more: ["x"] },
    ]);
    try {
      applyTrade(master.A, trade);
      expect.unreachable("applyTrade should have thrown");
    } catch (error) {
      const problems = (error as OverlayApplyError).problems;
      expect(problems).toHaveLength(2);
      expect((error as OverlayApplyError).message).toContain("S1-98");
    }
  });
});

describe("what applying leaves alone", () => {
  it("changes neither the flow nor the trade, and gives the same result twice", () => {
    const trade = loadTrade("barber");
    const flowBefore = structuredClone(master.A);
    const tradeBefore = structuredClone(trade);
    const first = applyTrade(master.A, trade);
    const second = applyTrade(master.A, trade);
    expect(second).toStrictEqual(first);
    expect(master.A).toStrictEqual(flowBefore);
    expect(trade).toStrictEqual(tradeBefore);
  });
});

describe("worked trades", () => {
  it("lays the trade's story, cast and names over the master's, and marks its steps", () => {
    const trade = loadTrade("barber");
    const { flow } = applyTrade(master.A, trade);
    expect(flow.story).toBe(trade.flows.A.story);
    expect(flow.story).not.toBe(master.A.story);
    expect({ ...master.A.cast, ...trade.flows.A.cast }).toStrictEqual(flow.cast);
    const steps = flatten(flow.steps);
    expect(steps.some((step) => step.changed === true)).toBe(true);
    expect(steps.some((step) => step.off !== undefined)).toBe(true);
  });

  it("applies a trade with no pf.facts and no pf.settings (insurance) without a complaint", () => {
    const trade = loadTrade("insurance");
    expect(trade.facts).toBeNull();
    expect(trade.settings).toBeNull();
    expect(() => applyTrade(master.A, trade)).not.toThrow();
    expect(() => applyTrade(master.B, trade)).not.toThrow();
  });

  it("applies the trade shapes wider than the master's (a text-less message, a one-string form row)", () => {
    expect(() => applyTrade(master.B, loadTrade("appraiser"))).not.toThrow();
    expect(() => applyTrade(master.B, loadTrade("towing"))).not.toThrow();
  });
});

describe("the parity shards", () => {
  it("cover every trade exactly once", () => {
    const ids = listTradeIds();
    expect(ids).toHaveLength(243);
    const seen = Array.from({ length: SHARDS }, (_, k) => shardOf(ids, k, SHARDS)).flat();
    expect([...seen].sort()).toStrictEqual([...ids].sort());
  });

  it("have a test file each", () => {
    for (let k = 1; k <= SHARDS; k += 1) {
      const text = readFileSync(new URL(`./parity.shard-${String(k)}.test.ts`, import.meta.url), "utf8");
      expect(text).toContain(`parityShard(${String(k - 1)});`);
    }
  });
});

describe("the master's script", () => {
  it("is the vendored overlay-core.js, read in place", () => {
    expect(BUILD_DIR.endsWith("fixtures/master/engine/work/build/")).toBe(true);
    expect(readFileSync(`${BUILD_DIR}overlay-core.js`, "utf8")).toContain("function apply(master, ov, fl)");
  });
});
