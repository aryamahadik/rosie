// T-1132: a trade's words op keeps every Master Correction in the emitted bundle. A run lays the trade's ops over the
// bundle's corrected master with apply() (Q-35), and a words op's `say` replaces the step's: so a words op at a step a
// correction changed would put back the words the correction replaced. The emitter emits such an op with the correction
// applied, each change tagged MC:<id>, or the build fails naming the trade, flow, step and correction.
//
// The made-up trade here is fixture set v1's barber with its own ops taken away, named "demo", and one words op of its
// own: at S2-05 it texts each staff member (the made-up Kit and Ola) an invite, as the master did before C9. C9 replaces
// the invites with the owner's message holding each person's join link and QR (Rosie never writes first). The 243
// trades' own words ops are swept in the run's order in corrections/parity.shard-9.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { JOIN_LINKS_TEXT, linkLine } from "../corrections/c9";
import { loadMaster } from "../load/flow";
import { loadTrade, type LoadedTrade, type TradeOp } from "../load/trade";
import {
  compileTrade,
  compilerVersion,
  correctedFlow,
  emitBundle,
  placeStops,
  standInInputs,
  standInJudgmentRules,
  standInList,
  standInModelRouting,
  standInPrompts,
  SHARED_LIST_NAMES,
  type EmittedBundle,
  type SharedListName,
  type StopMarks,
} from "./index";

const master = loadMaster();

/** The made-up op: an invite texted to each staff member, before they have texted Rosie (the master's pre-C9 shape). */
const INVITES: TradeOp = {
  op: "words",
  at: "S2-05",
  say: [
    ["san", "staff", "This is Rosie for Demo. Reply YES to join the team.", { stop: "first", as: "Kit" }],
    ["san", "staff", "This is Rosie for Demo. Reply YES to join the team.", { stop: "first", as: "Ola" }],
  ],
};

/** Barber's file with its own ops taken away, named "demo", and the invites op in flow A. */
function demoTrade(): LoadedTrade {
  const barber = structuredClone(loadTrade("barber"));
  return {
    ...barber,
    id: "demo",
    name: "Demo",
    flows: {
      A: { ...barber.flows.A, ops: [structuredClone(INVITES)] },
      B: { ...barber.flows.B, ops: [] },
    },
  };
}

interface Said {
  from: string;
  to: string;
  text: string;
  elements?: { card?: { lines?: string[] } };
}

/** What the emitter now says about each words op it emitted with a correction applied. */
interface Corrected {
  trade: string;
  flow: FlowLetter;
  op: number;
  at: string;
  changes: { tag: string; correction: string; path: string }[];
}

let emitted: EmittedBundle & { corrected?: Corrected[] };

// The emitter walks every path of the made-up trade in both flows to place the opt-out line (T-1116): a few seconds on
// a quiet build Mac. The hook's own limit is a resource guard, as the project's 30 s is (T-1073), not part of the claim.
beforeAll(() => {
  const lists = {} as Record<SharedListName, unknown>;
  for (const name of SHARED_LIST_NAMES) lists[name] = standInList(name).value;
  emitted = emitBundle({
    master,
    trades: [demoTrade()],
    bundleId: { hash: "cd".repeat(32), build: 3 },
    builtAt: "2026-11-09T00:00:00Z",
    compilerVersion: compilerVersion(),
    inputs: standInInputs([]).value,
    prompts: standInPrompts().value,
    routing: standInModelRouting().value,
    judgmentRules: standInJudgmentRules().value,
    lists,
  });
}, 120_000);

describe("a made-up trade's words op that texts each staff member an invite at S2-05 (T-1132)", () => {
  it("is emitted with C9's words: the owner gets each person's join link and QR, and no invite is texted", () => {
    const ops = (emitted.bundle.trades.demo?.flows as Record<FlowLetter, { ops: Obj[] }>).A.ops;
    expect(ops.map((op) => `${String(op.op)} ${String(op.at)}`)).toStrictEqual(["words S2-05"]);
    const say = (ops[0]?.say ?? []) as Said[];
    expect(say.filter((message) => message.from === "san" && message.to === "staff")).toStrictEqual([]);
    expect(say).toHaveLength(1);
    expect(say[0]).toMatchObject({ from: "san", to: "owner", text: JOIN_LINKS_TEXT });
    expect(say[0]?.elements?.card?.lines).toStrictEqual([linkLine("Kit"), linkLine("Ola")]);
  });

  it("says the op was corrected, each change tagged MC:C9", () => {
    expect(emitted.corrected).toBeDefined();
    const ops = (emitted.corrected ?? []).filter((entry) => entry.trade === "demo");
    expect(ops.map((entry) => [entry.flow, entry.op, entry.at])).toStrictEqual([["A", 0, "S2-05"]]);
    const changes = ops[0]?.changes ?? [];
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.tag).toBe("MC:C9");
      expect(change.correction).toBe("C9");
    }
    expect(changes.map((change) => change.path)).toContain("say");
  });

  it("stops the build, naming the trade, flow, step and correction, when the op reaches the overlay uncorrected", () => {
    const raw = demoTrade();
    const stops = {} as Record<FlowLetter, StopMarks>;
    for (const flow of ["A", "B"] as const)
      stops[flow] = placeStops(master[flow], correctedFlow(master, flow), [raw]);
    expect(() => compileTrade(master, raw, stops)).toThrow(/^demo flow A S2-05: .*MC:C9/);
  }, 120_000);
});

type Obj = Record<string, unknown>;
