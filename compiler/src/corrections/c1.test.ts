// T-138, C1: one Rosie number for every business; STOP stops Rosie's texts to that phone for every business.
// Proofs of the card that belong to C1 (the sweep over all 243 trades x both flows is in framework.test.ts):
//   - the stop replies of A7-11, B7-15, A7-98, B7-88 and S2-08 say Rosie's texts to this number are off for every
//     business, on the path's own words (walkPath), for the trades whose words differ most;
//   - S13-32 no longer says each business texts from its own number;
//   - the business's own listed phone and the call lines Jay decides stay as they were;
//   - every changed line carries MC:C1.
// The replies' exact words are Jay's (Q-01): these tests check the meaning (every business), not the final words.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep, type AppliedTrade } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import { STOP_AT_ONCE_DRAFT, STOP_OFF_DRAFT, S13_32_LINES, STOP_REPLY_STEPS, c1, everyBusiness } from "./c1";
import { applyCorrections, renderDiff, type CorrectedTrade } from "./framework";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
// barber has the master's words; dance and dentist (flow A) say "Texts from <the studio> are off" their own way;
// allergist, dentist (flow B) and property-manager say "You won't get more texts from Rosie for <business>";
// mortgage and private-investigator word S13-32's reviewer lines their own way.
const TRADES = [
  "barber",
  "dance",
  "dentist",
  "allergist",
  "property-manager",
  "mortgage",
  "private-investigator",
] as const;

const memo = new Map<string, { applied: AppliedTrade; done: CorrectedTrade }>();
function corrected(id: string, flow: FlowLetter): { applied: AppliedTrade; done: CorrectedTrade } {
  const key = `${id} ${flow}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    const applied = applyTrade(master[flow], loadTrade(id));
    hit = { applied, done: applyCorrections(applied, [c1]) };
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

/** The words a step shows on the trade's first money path (the opt-out line settled), joined. */
function words(done: CorrectedTrade, trade: string, id: string): string {
  const path = tradePaths(done, loadTrade(trade), { booking: false, fixtures: false })[0];
  if (path === undefined) throw new Error(`${trade}: no path`);
  const step = walkPath(done, path).steps.find((lit) => lit.id === id);
  if (step === undefined) throw new Error(`${trade} ${path.flow}: ${id} is not lit on the first path`);
  return strings(step.words).join(" | ");
}

describe("the draft meaning", () => {
  it("says every business, never one business's", () => {
    expect(STOP_OFF_DRAFT).toBe("Rosie's texts to this number are off for every business");
    expect(STOP_AT_ONCE_DRAFT).toContain("every business");
    expect(everyBusiness("Texts from Lee's Barbershop are off. Your visit is still booked.")).toBe(
      `${STOP_OFF_DRAFT}. Your visit is still booked.`,
    );
    expect(everyBusiness("Texts from Lee Home Services to this number are off. Reply START.")).toBe(
      `${STOP_OFF_DRAFT}. Reply START.`,
    );
    expect(everyBusiness("Texts from this business stop at once. The visit stays booked.")).toBe(
      `${STOP_AT_ONCE_DRAFT}. The visit stays booked.`,
    );
    expect(everyBusiness("Texts from the studio stop at once, but the trial stays booked.")).toBe(
      `${STOP_AT_ONCE_DRAFT}, but the trial stays booked.`,
    );
    expect(
      everyBusiness("You won't get more texts from Rosie for Lee Snow & Lawn. Your plan stays on."),
    ).toBe(`${STOP_OFF_DRAFT}. Your plan stays on.`);
  });

  it("leaves a line that does not name one business as it is", () => {
    for (const text of [
      "Texts are off. Reply START, or call the business.",
      "Texts to this customer are off. Reach them their way.",
      "Rosie's texts to this number are off for every business.",
      "Only START turns texts back on.",
    ])
      expect(everyBusiness(text)).toBe(text);
  });

  it("is C1's, and runs on its own", () => {
    expect(c1.id).toBe("C1");
    expect(S13_32_LINES.length).toBeGreaterThan(0);
    expect(STOP_REPLY_STEPS).toStrictEqual({
      A: ["A7-11", "A7-98", "S2-08"],
      B: ["B7-15", "B7-88", "S2-08"],
    });
  });
});

describe("C1 on real trades", () => {
  it("makes the stop replies of A7-11, A7-98 and S2-08 say Rosie's texts to this number are off for every business", () => {
    for (const trade of TRADES) {
      const { done } = corrected(trade, "A");
      for (const id of ["A7-11", "A7-98", "S2-08"]) {
        const said = words(done, trade, id);
        expect(said, `${trade} ${id}`).toContain(STOP_OFF_DRAFT);
        expect(said, `${trade} ${id}`).not.toMatch(/Texts from [^|]{1,80}? (?:to this number )?are off/);
      }
    }
  });

  it("makes the stop replies of B7-15, B7-88 and S2-08 say the same in flow B", () => {
    for (const trade of TRADES) {
      const { done } = corrected(trade, "B");
      for (const id of ["B7-15", "B7-88", "S2-08"]) {
        const said = words(done, trade, id);
        expect(said, `${trade} ${id}`).toContain(STOP_OFF_DRAFT);
      }
    }
  });

  it("says in the step's own description that Rosie's texts to this number stop at once for every business", () => {
    for (const [trade, flow, id] of [
      ["barber", "A", "A7-11"],
      ["barber", "B", "B7-15"],
      ["dance", "A", "A7-11"],
    ] as const) {
      const { done } = corrected(trade, flow);
      expect(words(done, trade, id), `${trade} ${id}`).toContain(STOP_AT_ONCE_DRAFT);
    }
  });

  it("keeps what else the stop reply says: the visit is still booked, how to cancel, START", () => {
    const { done } = corrected("dentist", "A");
    const said = words(done, "dentist", "A7-11");
    expect(said).toContain("is still booked. To cancel it, reply START, or call the office.");
  });

  it("no longer says in S13-32 that each business texts from its own number", () => {
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const rule = corrected(trade, flow).done.flow.steps.find((step) => step.id === "S13-32");
        const lines = strings(rule?.more);
        expect(
          lines.some((line) => /own Rosie number|from its own number/i.test(line)),
          `${trade} ${flow}`,
        ).toBe(false);
        expect(lines, `${trade} ${flow}`).toContain(
          "It stops Rosie's texts to that phone for every business, at once, until START turns them back on. Every business texts from the one Rosie number.",
        );
        expect(lines, `${trade} ${flow}`).toContain("HELP gets Rosie's name and number, and how to stop.");
        expect(lines, `${trade} ${flow}`).toContain(
          "Every call says who's calling, that it's automated and recorded, and Rosie's number.",
        );
        expect(
          lines.some((line) =>
            line.startsWith("Each business with an open booking for that phone hears only:"),
          ),
          `${trade} ${flow}`,
        ).toBe(true);
        expect(
          lines.some((line) =>
            /^Every business texts from ONE Rosie number, so a STOP stops them all\.$/.test(line),
          ),
        ).toBe(true);
      }
    }
  });

  it("says a fresh yes turns on that booking's texts only, and START turns the phone back on for every business", () => {
    const rule = corrected("barber", "A").done.flow.steps.find((step) => step.id === "S13-32");
    expect(strings(rule?.more)).toContain(
      "Only START turns Rosie's texts to that phone back on, for every business. A fresh yes on a new booking, sent from that number, turns on that booking's texts only. A booking made any other way sends that phone no text.",
    );
  });

  it("leaves the business's own listed phone and the decisions Jay keeps as they were", () => {
    const flowSteps = (done: CorrectedTrade, applied: AppliedTrade, id: string): [unknown, unknown] => {
      const find = (steps: AppliedStep[]): AppliedStep | undefined => {
        for (const step of steps) {
          if (step.id === id) return step;
          for (const branch of step.branches ?? []) {
            const hit = find(branch.steps);
            if (hit !== undefined) return hit;
          }
        }
        return undefined;
      };
      return [find(done.flow.steps), find(applied.flow.steps)];
    };
    const { applied, done } = corrected("barber", "A");
    for (const id of ["A10-13", "S1-75", "S1-35", "S11-40", "S12-12", "A3-05"]) {
      const [after, before] = flowSteps(done, applied, id);
      expect(after, id).toStrictEqual(before);
    }
    const [b, bApplied] = [corrected("barber", "B").done, corrected("barber", "B").applied];
    for (const id of ["B8-02", "B3-03"]) {
      const [after, before] = flowSteps(b, bApplied, id);
      expect(after, id).toStrictEqual(before);
    }
  });

  it("changes only the steps of the card, and every changed line carries MC:C1", () => {
    const allowed = new Set(["S13-32", "A7-11", "B7-15", "A7-98", "B7-88", "S2-08"]);
    for (const trade of TRADES) {
      for (const flow of FLOWS) {
        const { done } = corrected(trade, flow);
        expect(done.changes.length, `${trade} ${flow}`).toBeGreaterThan(0);
        for (const change of done.changes) {
          expect(change.tag).toBe("MC:C1");
          expect(allowed.has(change.step), `${trade} ${flow}: ${change.step}`).toBe(true);
          expect(change.op).toBe("set");
        }
        expect(
          renderDiff(done.changes).every((line) => line.startsWith("MC:C1 ")),
          `${trade} ${flow}`,
        ).toBe(true);
      }
    }
  });

  it("finds nothing more to change in a flow it has already corrected", () => {
    const { done } = corrected("barber", "A");
    expect(applyCorrections(done, [c1]).changes).toStrictEqual([]);
  });
});
