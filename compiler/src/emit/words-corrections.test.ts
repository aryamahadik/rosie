// T-1132: how words-corrections.ts corrects a trade's words ops (the made-up trade's S2-05 invites in the emitted bundle,
// and the build stopping on an uncorrected op, are proved in corrected-words.test.ts; the 243 trades in the run's order
// in corrections/parity.shard-9.test.ts). Each op is corrected in its own fields only, keeps its own spelling and slots,
// and every change carries its correction's tag; an op no correction changes, or at a step the trade adds itself, stays
// as the trade file wrote it.
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { STOP_OFF_DRAFT } from "../corrections/c1";
import { JOIN_LINKS_TEXT, READY_TEXT_JOINS, linkLine } from "../corrections/c9";
import { tagOf } from "../corrections/framework";
import { loadMaster } from "../load/flow";
import { loadTrade, type LoadedTrade, type TradeOp } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import {
  WordsOpCorrectionError,
  assertWordsKeepCorrections,
  correctWordsOps,
  writtenBy,
  type CorrectedOps,
} from "./words-corrections";

const master = loadMaster();

type Line = readonly unknown[];

/** A made-up message from Rosie that texts a staff member before they have texted Rosie (the master's pre-C9 invite). */
function invite(as: string): unknown[] {
  return ["san", "staff", "This is Rosie for Demo. Reply YES to join the team.", { stop: "first", as }];
}

/** Barber's file with its own ops taken away, named "demo", and the made-up ops given for each flow. */
function demo(ops: { A?: unknown[]; B?: unknown[] }): LoadedTrade {
  const barber = structuredClone(loadTrade("barber"));
  return {
    ...barber,
    id: "demo",
    name: "Demo",
    flows: {
      A: { ...barber.flows.A, ops: (ops.A ?? []) as TradeOp[] },
      B: { ...barber.flows.B, ops: (ops.B ?? []) as TradeOp[] },
    },
  };
}

function opOf(done: CorrectedOps, flow: FlowLetter, n: number): Record<string, unknown> {
  return done.trade.flows[flow].ops[n] as unknown as Record<string, unknown>;
}

describe("correctWordsOps: a words op emitted with the corrections applied, in its own fields", () => {
  it("C1: a stop reply that names one business says Rosie's texts are off for every business, its slot kept", () => {
    const say = [
      ["cust", "san", "STOP"],
      ["san", "cust", "Texts from Demo Studio are off. {{alex.staff:Alex M.}}'s class is still booked."],
    ];
    const trade = demo({ A: [{ op: "words", at: "A7-11", say }] });
    const done = correctWordsOps(master, trade);
    expect((opOf(done, "A", 0).say as Line[])[1]?.[2]).toBe(
      `${STOP_OFF_DRAFT}. {{alex.staff:Alex M.}}'s class is still booked.`,
    );
    expect(done.corrected.map((entry) => [entry.flow, entry.op, entry.at])).toStrictEqual([
      ["A", 0, "A7-11"],
    ]);
    expect(done.corrected[0]?.changes.map((change) => [change.tag, change.path])).toStrictEqual([
      ["MC:C1", "say[1][2]"],
    ]);
    // The trade given is not changed.
    expect(trade.flows.A.ops[0]).toStrictEqual({ op: "words", at: "A7-11", say });
  });

  it("C9: invites written in a variant become the owner's join links there, and the op keeps only its own fields", () => {
    const vary = { "pf:sensitive": { say: [invite("Kit")] } };
    const done = correctWordsOps(master, demo({ B: [{ op: "words", at: "S2-05", vary }] }));
    const op = opOf(done, "B", 0);
    expect(Object.keys(op)).toStrictEqual(["op", "at", "vary"]);
    const patch = (op.vary as Record<string, Record<string, unknown>>)["pf:sensitive"];
    expect(Object.keys(patch ?? {})).toStrictEqual(["say"]);
    const said = (patch?.say ?? []) as Line[];
    expect(said).toHaveLength(1);
    expect(said[0]?.slice(0, 3)).toStrictEqual(["san", "owner", JOIN_LINKS_TEXT]);
    expect((said[0]?.[3] as { card: { lines: string[] } }).card.lines).toStrictEqual([linkLine("Kit")]);
    expect(done.corrected[0]?.changes.map((change) => [change.tag, change.path])).toStrictEqual([
      ["MC:C9", "vary.pf:sensitive.say"],
    ]);
  });

  it("C9: a `more` a words op writes at S2-06 gets the line the correction adds, after the op's own lines", () => {
    const more = ["One calendar covers both shops.", "Kit and Ola join the same way."];
    const done = correctWordsOps(master, demo({ A: [{ op: "words", at: "S2-06", more }] }));
    expect(opOf(done, "A", 0).more).toStrictEqual([...more, READY_TEXT_JOINS]);
    expect(done.corrected[0]?.changes.map((change) => [change.tag, change.op, change.path])).toStrictEqual([
      ["MC:C9", "insert", "more[2]"],
    ]);
  });

  it("corrects each words op at the step, the earlier one a later op writes over included", () => {
    const first = { op: "words", at: "S2-05", say: [invite("Kit")] };
    const second = { op: "words", at: "S2-05", say: [invite("Kit"), invite("Ola")] };
    const done = correctWordsOps(master, demo({ A: [first, second] }));
    expect(done.corrected.map((entry) => entry.op)).toStrictEqual([0, 1]);
    for (const n of [0, 1])
      for (const message of opOf(done, "A", n).say as Line[]) expect(message[1]).toBe("owner");
  });

  it("leaves an op no correction changes, and an op at a step the trade adds itself, as the trade wrote them", () => {
    const own = [
      { op: "after", at: "S2-05", steps: [{ id: "S2-x01", who: "san", to: "staff", via: "msg", say: [] }] },
      { op: "words", at: "S2-x01", say: [invite("Kit")] },
      // S2-06's `say`: C9 changes only S2-06's `more`, which this op does not write.
      { op: "words", at: "S2-06", say: [["staff", "san", "YES", { as: "Kit" }]] },
    ];
    const trade = demo({ A: own });
    const done = correctWordsOps(master, trade);
    expect(done.corrected).toStrictEqual([]);
    expect(done.trade).toBe(trade);
  });

  it("names a change by the op's own fields: a field it writes, or a field of a variant it writes", () => {
    const op = { op: "words", at: "S2-05", more: ["x"], vary: { "pf:x": { say: [] } } } as unknown as Extract<
      TradeOp,
      { op: "words" }
    >;
    expect(writtenBy(op, ["more", 0])).toBe(true);
    expect(writtenBy(op, ["say"])).toBe(false);
    expect(writtenBy(op, ["vary", "pf:x", "say", 0])).toBe(true);
    expect(writtenBy(op, ["vary", "pf:x", "more"])).toBe(false);
    expect(writtenBy(op, ["vary", "pf:y", "say"])).toBe(false);
    expect(writtenBy(op, ["tells"])).toBe(false);
  });
});

describe("fixture set v1's trades: each words op that would put back words a correction replaced is corrected", () => {
  // From the run-order sweep's list (corrections/parity.shard-9.test.ts): one op of each correction that has any.
  const CASES: readonly [trade: string, flow: FlowLetter, step: string, correction: "C1" | "C9" | "C10"][] = [
    ["farrier", "A", "S2-05", "C9"],
    ["allergist", "A", "S1-78", "C9"],
    ["advisor", "A", "A7-11", "C1"],
    ["aba", "A", "S1-32", "C10"],
  ];

  it.each(CASES)(
    "%s flow %s %s: corrected, tagged MC:%s, and the guard finds nothing left to put back",
    (id, flow, step, correction) => {
      const trade = loadTrade(id);
      const done = correctWordsOps(master, trade);
      const ops = done.corrected.filter((entry) => entry.flow === flow && entry.at === step);
      expect(ops.length, `${id} ${flow} ${step}`).toBeGreaterThan(0);
      for (const entry of ops) {
        expect(entry.trade).toBe(id);
        expect(trade.flows[flow].ops[entry.op]?.at).toBe(step);
        expect(entry.changes.map((change) => change.tag)).toContain(tagOf(correction));
        for (const change of entry.changes) {
          expect(change.tag).toBe(tagOf(change.correction));
          expect(change.step).toBe(step);
        }
      }
      expect(() => {
        assertWordsKeepCorrections(applyTrade(master[flow], trade), trade, flow);
      }).toThrow(WordsOpCorrectionError);
      expect(() => {
        assertWordsKeepCorrections(applyTrade(master[flow], done.trade), done.trade, flow);
      }).not.toThrow();
    },
    120_000,
  );

  it("allergist flow A S1-78: the contact's own text comes before Rosie's first text to them", () => {
    const done = correctWordsOps(master, loadTrade("allergist"));
    const entry = done.corrected.find((one) => one.flow === "A" && one.at === "S1-78");
    expect(entry).toBeDefined();
    const say = opOf(done, "A", entry?.op ?? -1).say as Line[];
    const fromContact = say.findIndex((message) => message[0] === "other" && message[1] === "san");
    const toContact = say.findIndex((message) => message[0] === "san" && message[1] === "other");
    expect(fromContact).toBeGreaterThanOrEqual(0);
    expect(fromContact).toBeLessThan(toContact);
  });
});
