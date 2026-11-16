// T-139, C3: D104's own-AI door. Proofs of the card that belong to C3 (both flows):
//   - the compiled door carries a 15-minute save with extensions 0: booked at once on the AI's request when nothing is due
//     (the money way "none"), and with money due now or a card to save (the flow's other money ways) the time saved 15
//     minutes as a calendar reservation, never extended, the pay link to the AI, the customer's email and an open chat;
//     not done in time, let go with nothing booked or charged and nobody chased (S12-04's text not sent);
//   - it stands in place of the master's saves, which the steps it runs before still state: the 10 minutes and more time
//     (A4-21, B4-23), the page's one clock (A5-31, B5-43), a plan check up to 1 hour, a document up to 24 hours, the
//     owner's OK up to 30 minutes (A5-08, B5-06);
//   - those steps stay as written: C3 changes no step, in the master or a trade's flow, and the door is the same for
//     every trade;
//   - a flow that lacks one of them stops the build.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { correctedFlow, masterShape } from "../emit/flow";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedFlow, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import {
  DOOR_STEPS,
  MASTER_SAVE_EXTENSIONS,
  MASTER_SAVE_MINUTES,
  NOT_CHASED,
  OWN_AI_SAVE,
  OWN_YES_STEPS,
  OwnAiDoorError,
  c3,
  ownAiDoor,
} from "./c3";
import { CorrectionError, applyCorrections } from "./framework";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const TRADES = ["barber", "aba", "deck"] as const;

const memo = new Map<string, AppliedTrade>();
function applied(id: string, flow: FlowLetter): AppliedTrade {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    hit = applyTrade(master[flow], loadTrade(id));
    memo.set(key, hit);
  }
  return hit;
}

function find(steps: readonly AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = find(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The step's title, does and more lines, as one list (the master's own words). */
function lines(flow: AppliedFlow, id: string): string[] {
  const step = find(flow.steps, id);
  if (step === undefined) throw new Error(`no step ${id} in flow ${flow.id}`);
  return [step.title, step.does, ...(step.more ?? [])];
}

/** The master flow as the bundle holds it, corrected (emit/flow.ts). */
function bundled(flow: FlowLetter): AppliedFlow {
  return correctedFlow(master, flow).flow;
}

describe("C3: the compiled own-AI door", () => {
  it("carries a 15-minute save with extensions 0, as a calendar reservation, in both flows", () => {
    for (const flow of FLOWS) {
      const door = ownAiDoor(bundled(flow));
      expect(door.tag).toBe("MC:C3");
      expect(door.flow).toBe(flow);
      expect(door.saved.time).toStrictEqual({ minutes: 15, extensions: 0 });
      expect(door.saved.time).toStrictEqual({ ...OWN_AI_SAVE });
      expect(door.saved.as).toBe("calendar reservation");
    }
  });

  it("books at once when nothing is due, and saves the time on every way with money due or a card to save", () => {
    for (const flow of FLOWS) {
      const door = ownAiDoor(bundled(flow));
      const ways = (master[flow].money as { ways?: { before?: string[] } }).ways?.before;
      expect(ways, flow).toStrictEqual(["none", "card", "deposit", "full"]);
      expect(door.atOnce.ways).toStrictEqual(["none"]);
      expect(door.saved.ways).toStrictEqual(["card", "deposit", "full"]);
      expect(door.atOnce.insteadOf).toStrictEqual([...OWN_YES_STEPS[flow]]);
      expect(door.who).toBe("agent");
      expect(door.through).toStrictEqual(["api", "mcp"]);
      expect(door.approval).toBe("now");
      expect(door.saved.payLink).toStrictEqual(["agent", "email", "chat"]);
      expect(door.saved.inTime).toBe("booked");
      expect(door.saved.notInTime).toStrictEqual({
        booked: false,
        charged: false,
        chased: false,
        notSent: ["S12-04"],
      });
    }
  });

  it("stands in place of the master's saves, which the steps it runs before still state", () => {
    for (const flow of FLOWS) {
      const door = ownAiDoor(bundled(flow));
      const save = flow === "A" ? "A4-21" : "B4-23";
      const page = flow === "A" ? "A5-31" : "B5-43";
      const ownerOk = flow === "A" ? "A5-08" : "B5-06";
      expect(door.before).toStrictEqual([...DOOR_STEPS[flow]]);
      for (const id of [save, page, ownerOk, ...OWN_YES_STEPS[flow], ...NOT_CHASED])
        expect(door.before).toContain(id);

      // The master's own words, which hold at every other door: 10 minutes, more time, 1 hour, 24 hours, 30 minutes.
      expect(lines(bundled(flow), save)[0]).toBe(`Saves the time for ${String(MASTER_SAVE_MINUTES)} minutes`);
      expect(door.saved.insteadOf).toStrictEqual({
        minutes: MASTER_SAVE_MINUTES,
        extensions: MASTER_SAVE_EXTENSIONS,
      });
      expect(door.saved.insteadOf).toStrictEqual({ minutes: 10, extensions: 1 });
      const said = (id: string): string => lines(bundled(flow), id).join(" ");
      expect(said(save)).toContain("offers more time at least once");
      expect(said(save)).toContain("A plan check keeps it saved up to 1 hour.");
      expect(said(save)).toContain("up to 24 hours");
      expect(said(page)).toContain("The page has one 10-minute clock, offered more time before it ends.");
      expect(said(ownerOk)).toContain("30 minutes of Sam's text hours");
      expect(said("S12-03")).toContain("The saved time's 10 minutes keep running.");
      expect(said("S12-04")).toContain("gets one text with a link to finish");
      expect(door.notApplied.map((one) => one.what)).toStrictEqual([
        "more time, when asked or offered before the saved time ends",
        "a plan check, up to 1 hour",
        "a document to sign, up to 24 hours",
        "the owner's OK, up to 30 minutes",
      ]);
      expect(door.notApplied.map((one) => one.at)).toStrictEqual([
        [save, page],
        [save],
        [save, page],
        [ownerOk],
      ]);
      for (const one of door.notApplied) for (const id of one.at) expect(door.before).toContain(id);
    }
  });

  it("is the same for every trade: a trade's ops never change D104", () => {
    for (const flow of FLOWS) {
      const door = ownAiDoor(bundled(flow));
      expect(ownAiDoor(masterShape(master[flow]))).toStrictEqual(door);
      for (const id of TRADES) expect(ownAiDoor(applied(id, flow).flow), `${id} ${flow}`).toStrictEqual(door);
    }
  });
});

describe("C3: the steps it runs before stay as written", () => {
  it("changes no step, in the master or a trade's flow", () => {
    for (const flow of FLOWS) {
      const base = { trade: "master", flow: masterShape(master[flow]), slotProblems: [] };
      const done = applyCorrections(base, [c3]);
      expect(done.changes).toStrictEqual([]);
      expect(done.flow).toStrictEqual(base.flow);
      expect(done.corrections).toStrictEqual(["C3"]);
      for (const id of TRADES) {
        const trade = applied(id, flow);
        const mine = applyCorrections(trade, [c3]);
        expect(mine.changes, `${id} ${flow}`).toStrictEqual([]);
        expect(mine.flow, `${id} ${flow}`).toStrictEqual(trade.flow);
      }
    }
  });

  it("leaves no change tagged MC:C3 when every correction runs", () => {
    for (const flow of FLOWS) {
      const done = applyCorrections(applied("barber", flow));
      expect(done.corrections).toContain("C3");
      expect(done.changes.filter((change) => change.correction === "C3")).toStrictEqual([]);
      for (const id of DOOR_STEPS[flow])
        expect(find(done.flow.steps, id), `${flow} ${id}`).toStrictEqual(
          find(applied("barber", flow).flow.steps, id),
        );
    }
  });

  it("stops the build where a flow lacks a step the door runs before", () => {
    const flow = structuredClone(applied("barber", "A").flow);
    const quiet = find(flow.steps, "S12-03");
    const never = quiet?.branches?.find((branch) => branch.label === "Never comes back");
    if (never === undefined) throw new Error("S12-03 has no branch 'Never comes back'");
    never.steps = [];
    expect(() => ownAiDoor(flow)).toThrow(OwnAiDoorError);
    expect(() => ownAiDoor(flow)).toThrow(/S12-04/);
    expect(() => applyCorrections({ trade: "barber", flow, slotProblems: [] }, [c3])).toThrow(
      CorrectionError,
    );
  });

  it("is C3's own, from Master Corrections C3 and D104", () => {
    expect(c3.id).toBe("C3");
    expect(c3.source).toContain("Master Corrections C3");
    expect(c3.source).toContain("D104");
  });
});
