// T-138, C2: a mobile is required, no confirmation by SMS, "calls only" is not offered (DL-029).
// Proofs of the card that belong to C2 (the sweep over all 243 trades x both flows is in framework.test.ts):
//   - A4-82, B4-93 and S13-19 ask for a mobile, not "the number or email";
//   - A6-14 and B6-13 no longer say the confirmation is texted on a call, and say it is never sent as an SMS;
//   - A4-87, B4-109 and S13-33 are not reachable through 'calls only': on every path of the trade, including the paths
//     that put the booking on calls only, none of them is lit (and on the flow before the correction, they are);
//   - the Calls only branch and button of the reach card are gone;
//   - every changed line carries MC:C2.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import { CALLS_ONLY_OFF, c2 } from "./c2";
import { applyCorrections, renderDiff, type CorrectedTrade } from "./framework";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
// barber has the master's words; aba and deck call their business a "clinic" and a "showroom" in S13-19.
const TRADES = ["barber", "aba", "deck"] as const;
const REACH: Record<FlowLetter, string> = { A: "A4-82", B: "B4-93" };
const CONFIRM: Record<FlowLetter, string> = { A: "A6-14", B: "B6-13" };
const CALL_BOOKING: Record<FlowLetter, string> = { A: "A4-87", B: "B4-109" };

const memo = new Map<string, { applied: AppliedTrade; done: CorrectedTrade }>();
function corrected(id: string, flow: FlowLetter): { applied: AppliedTrade; done: CorrectedTrade } {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    const applied = applyTrade(master[flow], loadTrade(id));
    hit = { applied, done: applyCorrections(applied, [c2]) };
    memo.set(key, hit);
  }
  return hit;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

function find(steps: AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = find(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The words a step shows on the trade's first money path. */
function words(done: CorrectedTrade, trade: string, id: string): string[] {
  const path = tradePaths(done, loadTrade(trade), { booking: false, fixtures: false })[0];
  if (path === undefined) throw new Error(`${trade}: no path`);
  const step = walkPath(done, path).steps.find((lit) => lit.id === id);
  if (step === undefined) throw new Error(`${trade} ${path.flow}: ${id} is not lit on the first path`);
  return strings(step.words);
}

describe("C2: a mobile is required", () => {
  it("makes the reach card ask for a mobile, with an email optional", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const said = words(corrected(trade, flow).done, trade, REACH[flow]);
        const all = said.join(" | ");
        expect(all, `${trade} ${REACH[flow]}`).toContain(
          "Please give your mobile number. An email is optional.",
        );
        expect(all, `${trade} ${REACH[flow]}`).toContain(
          "It asks for their mobile number, and how to reach them.",
        );
        expect(all, `${trade} ${REACH[flow]}`).not.toContain("number or email");
        expect(all, `${trade} ${REACH[flow]}`).toContain("A mobile is required. A landline is not taken");
        expect(all, `${trade} ${REACH[flow]}`).toContain(
          "Nothing else is texted to that mobile until it texts in.",
        );
      }
    }
  });

  it("makes S13-19 ask for a mobile, a landline not taken, and says nothing is texted until it texts in", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const rule = strings(find(corrected(trade, flow).done.flow.steps, "S13-19")?.more);
        expect(rule, `${trade} ${flow}`).toContain(
          "The card asks for a mobile (an email is optional), and the way: texts, texts only, or email.",
        );
        expect(
          rule.some((line) =>
            line.startsWith("A mobile is required. A landline is not taken: they give another number"),
          ),
          `${trade} ${flow}`,
        ).toBe(true);
        expect(
          rule.some((line) => /^Calls only: never a text|^Calls only never changes the money/.test(line)),
        ).toBe(false);
        expect(rule).toContain(
          "Nothing else is texted to that mobile until it texts in. No clock or fee runs on a message they didn't get.",
        );
        expect(rule.join(" ")).not.toContain("moves them to calls only");
      }
    }
  });

  it("keeps a trade's own word for its business in S13-19 (aba: clinic, deck: showroom)", () => {
    const aba = strings(find(corrected("aba", "A").done.flow.steps, "S13-19")?.more);
    expect(aba.some((line) => line.endsWith("never twice, clinic-added bookings too."))).toBe(true);
    const deck = strings(find(corrected("deck", "A").done.flow.steps, "S13-19")?.more);
    expect(deck.some((line) => line.endsWith("never twice, showroom-added bookings too."))).toBe(true);
  });
});

describe("C2: no confirmation by SMS", () => {
  it("says the confirmation goes in the chat if it is open, is never an SMS, and goes in full by email and on the page", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const lines = strings(find(corrected(trade, flow).done.flow.steps, CONFIRM[flow])?.more);
        expect(lines, `${trade} ${CONFIRM[flow]}`).toContain(
          "Where they take texts, the confirmation goes in the chat if that mobile's chat is open. It is never sent as an SMS. In full by email and on the page.",
        );
        expect(
          lines.some((line) => line.startsWith("On a call, the read-back")),
          `${trade} ${flow}`,
        ).toBe(false);
      }
    }
  });
});

describe("C2: calls only is not offered", () => {
  it("takes the Calls only choice and its branch off the reach card", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const card = find(corrected(trade, flow).done.flow.steps, REACH[flow]);
        const buttons = strings((card?.say as unknown[][] | undefined)?.map((message) => message[3]));
        expect(buttons, `${trade} ${flow}`).toContain("Text me");
        expect(buttons, `${trade} ${flow}`).not.toContain("Calls only");
        const branch = card?.branches?.find((candidate) => candidate.label === "Calls only");
        expect(branch?.off, `${trade} ${flow}`).toBe(CALLS_ONLY_OFF);
        for (const other of card?.branches ?? [])
          if (other.label !== "Calls only")
            expect(other.off, `${trade} ${flow} ${other.label}`).toBeUndefined();
      }
    }
  });

  it("makes A4-87, B4-109 and S13-33 unreachable on every path, the calls-only paths included", () => {
    for (const flow of FLOWS) {
      const { applied, done } = corrected("barber", flow);
      const trade = loadTrade("barber");
      const paths = tradePaths(applied, trade);
      const calls = [CALL_BOOKING[flow], "S13-33"];

      // Control: before the correction, some path of the trade does light them (the test can fail).
      const before = new Set(paths.flatMap((path) => walkPath(applied, path).steps.map((lit) => lit.id)));
      for (const id of calls) expect(before.has(id), `${flow}: ${id} is lit before C2`).toBe(true);
      expect(
        paths.some((path) => Object.values(path.booking ?? {}).includes("callsonly")),
        `${flow}: a path puts the booking on calls only`,
      ).toBe(true);

      for (const path of paths) {
        // Every path as the compiler walks it (a branch's `sets` followed); the calls-only paths also as step.js reads them.
        const onCalls = Object.values(path.booking ?? {}).includes("callsonly");
        for (const sets of onCalls ? [true, false] : [true]) {
          const walk = walkPath(done, path, { sets });
          const lit = walk.steps.map((step) => step.id);
          for (const id of calls)
            expect(lit, `${flow} ${path.price}|${path.before}|${path.after}: ${id}`).not.toContain(id);
          const card = walk.steps.find((step) => step.id === REACH[flow]);
          const callsOnly = card?.branches.find((branch) => branch.label === "Calls only");
          if (callsOnly !== undefined) {
            expect(callsOnly.lit).toBe(false);
            expect(callsOnly.off).toBe(true);
          }
        }
      }
    }
  });

  it("switches off A4-87, B4-109 and S13-33 with a reason, in both flows", () => {
    for (const flow of FLOWS)
      for (const id of [CALL_BOOKING[flow], "S13-33"])
        expect(find(corrected("barber", flow).done.flow.steps, id)?.off).toBe(CALLS_ONLY_OFF);
  });

  it("leaves a trade's own off of those steps as the trade wrote it", () => {
    const { applied } = corrected("barber", "A");
    const mine: AppliedTrade = { ...applied, flow: structuredClone(applied.flow) };
    const own = "the trade's own reason";
    const call = find(mine.flow.steps, "A4-87");
    const rule = find(mine.flow.steps, "S13-33");
    const branch = find(mine.flow.steps, "A4-82")?.branches?.find(
      (candidate) => candidate.label === "Calls only",
    );
    if (call === undefined || rule === undefined || branch === undefined) throw new Error("steps missing");
    call.off = own;
    rule.off = own;
    branch.off = own;

    const done = applyCorrections(mine, [c2]);
    expect(find(done.flow.steps, "A4-87")?.off).toBe(own);
    expect(find(done.flow.steps, "S13-33")?.off).toBe(own);
    expect(
      find(done.flow.steps, "A4-82")?.branches?.find((candidate) => candidate.label === "Calls only")?.off,
    ).toBe(own);
    expect(
      done.changes.filter((change) => change.path === "off" || change.path.endsWith(".off")),
    ).toStrictEqual([]);
  });
});

describe("C2 on the whole", () => {
  it("changes only the steps of the card, and every changed line carries MC:C2", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const { done } = corrected(trade, flow);
        const allowed = new Set([REACH[flow], "S13-19", CONFIRM[flow], CALL_BOOKING[flow], "S13-33"]);
        expect(done.changes.length, `${trade} ${flow}`).toBeGreaterThan(0);
        for (const change of done.changes) {
          expect(change.tag).toBe("MC:C2");
          expect(allowed.has(change.step), `${trade} ${flow}: ${change.step}`).toBe(true);
        }
        expect(
          renderDiff(done.changes).every((line) => line.startsWith("MC:C2 ")),
          `${trade} ${flow}`,
        ).toBe(true);
      }
    }
  });

  it("finds nothing more to change in a flow it has already corrected", () => {
    const { done } = corrected("barber", "B");
    expect(applyCorrections(done, [c2]).changes).toStrictEqual([]);
  });

  it("is C2's own, and does not undo C1", () => {
    expect(c2.id).toBe("C2");
    const { applied } = corrected("barber", "A");
    const both = applyCorrections(applied);
    const text = strings(find(both.flow.steps, "A7-11")?.say).join(" ");
    expect(text).toContain("Rosie's texts to this number are off for every business");
    expect(both.changes.some((change) => change.tag === "MC:C1")).toBe(true);
    expect(both.changes.some((change) => change.tag === "MC:C2")).toBe(true);
  });
});
