// T-140, C8: the trades' D96 offs of S1-32, S2-22, S11-48, S11-57, S11-50, S13-11, S13-15 and S2-11 are void (MC C8;
// D96, DECISIONS.md line 1170). Proofs of the card that belong to C8:
//   - the void list is exactly MC C8's: S1-32, S2-22, S11-48 and S11-57 in its 12 trades; S11-50 in 27 trades, S13-11 in
//     16, S13-15 in fertility, lab, obgyn and sleep-clinic, and S2-11 in occupational-therapist, pain-management and
//     sports-medicine, each in both flows;
//   - with them dropped before the applier, each of those steps is reachable for each of those trades: lit on a money
//     path of the corrected flow, where before it was off;
//   - the trade files hold 618 D96 offs (01-inventory C-228, counted Nov 5): 196 are void and 422 stay in force, listed by
//     step and trade in the snapshot below; every other op stays as the trade wrote it, in order;
//   - the compiled overlay of the bundle holds none of the void offs and every other off (golf-instructor);
//   - each dropped op is tagged MC:C8, and C8 changes no step in the frame.
// The out-of-scope markers of the D96 offs C8 keeps are T-147's.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { buildBundle } from "../emit";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade, type TradeOp } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { tradePaths, walkPath } from "../path";
import { D96, VOID_STEPS, c8, isD96Off, isVoidOff, renderVoided, voidOffs } from "./c8";
import { applyCorrections } from "./framework";

vi.setConfig({ testTimeout: 600_000 });

const FLOWS: readonly FlowLetter[] = ["A", "B"];
const ALL = listTradeIds();
const master = loadMaster();

/** MC C8's 12 trades: S1-32, S2-22, S11-48 and S11-57 are void in each. */
const TWELVE = [
  "flight-school",
  "golf-instructor",
  "horse-riding",
  "hypnotherapist",
  "recording-studio",
  "reiki",
  "shooting",
  "ski-instructor",
  "sports-coach",
  "spray-tan",
  "teeth-whitening",
  "wellness-studio",
];

/** MC C8's named trades for S13-15 and S2-11, and its counts for S11-50 and S13-11. */
const NAMED: Record<string, readonly string[]> = {
  "S1-32": TWELVE,
  "S2-22": TWELVE,
  "S11-48": TWELVE,
  "S11-57": TWELVE,
  "S13-15": ["fertility", "lab", "obgyn", "sleep-clinic"],
  "S2-11": ["occupational-therapist", "pain-management", "sports-medicine"],
};
const COUNTED: Record<string, number> = { "S11-50": 27, "S13-11": 16 };

const trades = new Map<string, LoadedTrade>(ALL.map((id) => [id, loadTrade(id)]));
function trade(id: string): LoadedTrade {
  const hit = trades.get(id);
  if (hit === undefined) throw new Error(`no trade ${id}`);
  return hit;
}

interface Off {
  trade: string;
  flow: FlowLetter;
  at: string;
  label?: string;
}

/** The D96 offs of one list of ops. */
function d96Offs(id: string, flow: FlowLetter, ops: readonly TradeOp[]): Off[] {
  return ops.filter(isD96Off).map((op) => ({
    trade: id,
    flow,
    at: op.at,
    ...(op.label === undefined ? {} : { label: op.label }),
  }));
}

/** Offs grouped by step and branch label: `<step>[ "<label>"]: <ops> ops, <trades> trades: <ids>`, in step order. */
function listed(offs: readonly Off[]): string[] {
  const groups = new Map<string, { ops: number; trades: Set<string> }>();
  for (const off of offs) {
    const key = off.label === undefined ? off.at : `${off.at} "${off.label}"`;
    const group = groups.get(key) ?? { ops: 0, trades: new Set<string>() };
    group.ops += 1;
    group.trades.add(off.trade);
    groups.set(key, group);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, group]) =>
        `${key}: ${String(group.ops)} ops, ${String(group.trades.size)} trades: ${[...group.trades].sort().join(", ")}`,
    );
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

describe("C8's void list", () => {
  it("is MC C8's: the 12 trades' S1-32, S2-22, S11-48 and S11-57, S11-50 in 27, S13-11 in 16, S13-15 and S2-11 in the trades it names", () => {
    expect(ALL).toHaveLength(243);
    const byStep = new Map<string, Set<string>>(VOID_STEPS.map((step) => [step, new Set<string>()]));
    for (const id of ALL) {
      const { voided } = voidOffs(trade(id));
      for (const one of voided) byStep.get(one.at)?.add(one.trade);
      // Each trade voids a step in both flows, or in neither.
      for (const step of VOID_STEPS) {
        const flows = voided.filter((one) => one.at === step).map((one) => one.flow);
        expect([[], ["A", "B"]], `${id} ${step}`).toContainEqual(flows);
      }
    }
    for (const [step, named] of Object.entries(NAMED))
      expect([...(byStep.get(step) ?? [])].sort(), step).toStrictEqual([...named].sort());
    for (const [step, count] of Object.entries(COUNTED)) expect(byStep.get(step)?.size, step).toBe(count);
    expect(Object.fromEntries([...byStep].map(([step, ids]) => [step, [...ids].sort().join(", ")])))
      .toMatchInlineSnapshot(`
        {
          "S1-32": "flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
          "S11-48": "flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
          "S11-50": "aba, addiction, band, clown, comedian, ent, fertility, flight-school, gastroenterologist, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, orthopedist, party-characters, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, urologist, wellness-studio",
          "S11-57": "flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
          "S13-11": "fertility, flight-school, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, wellness-studio",
          "S13-15": "fertility, lab, obgyn, sleep-clinic",
          "S2-11": "occupational-therapist, pain-management, sports-medicine",
          "S2-22": "flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        }
      `);
  });

  it("voids only an off of a whole step at one of the eight, citing D96", () => {
    const off = (at: string, why: string, label?: string): TradeOp =>
      label === undefined ? { op: "off", at, why } : { op: "off", at, label, why };
    expect(isVoidOff(off("S1-32", "no license is checked for this work (D96)"))).toBe(true);
    expect(isVoidOff(off("S1-32", "no license is checked for this work (D96)", ""))).toBe(true);
    expect(isVoidOff(off("S1-32", "D96: no lookup", "The number isn't found"))).toBe(false);
    expect(isVoidOff(off("S1-33", "D96: no lookup"))).toBe(false);
    expect(isVoidOff(off("S2-22", "No staff take bookings here"))).toBe(false);
    expect(isVoidOff({ op: "more", at: "S1-32", more: ["D96"] })).toBe(false);
    expect(D96.test("D960")).toBe(false);
  });

  it("drops only the void offs: every other op stays as the trade wrote it, in order, and the trade given is not changed", () => {
    for (const id of [...TWELVE, ...(NAMED["S2-11"] ?? []), "aba", "barber"]) {
      const raw = trade(id);
      const before = structuredClone(raw);
      const { trade: done, voided } = voidOffs(raw);
      expect(raw, id).toStrictEqual(before);
      for (const flow of FLOWS) {
        const ops = raw.flows[flow].ops;
        const dropped = new Set(voided.filter((one) => one.flow === flow).map((one) => one.op));
        expect(done.flows[flow].ops, `${id} ${flow}`).toStrictEqual(ops.filter((_, n) => !dropped.has(n)));
        for (const n of dropped) expect(isVoidOff(ops[n] as TradeOp)).toBe(true);
        expect(done.flows[flow].ops.some(isVoidOff), `${id} ${flow}`).toBe(false);
      }
      expect({ ...done, flows: null }).toStrictEqual({ ...raw, flows: null });
      expect(voidOffs(done).voided, `${id}: nothing left to void`).toStrictEqual([]);
    }
    expect(voidOffs(trade("barber")).trade).toBe(trade("barber"));
  });
});

describe("the D96 offs left in force", () => {
  it("are 618 minus the void ones: 196 void, 422 in force, listed by step and trade", () => {
    const all: Off[] = [];
    const left: Off[] = [];
    const gone: Off[] = [];
    for (const id of ALL) {
      const raw = trade(id);
      const { trade: done, voided } = voidOffs(raw);
      for (const flow of FLOWS) {
        all.push(...d96Offs(id, flow, raw.flows[flow].ops));
        left.push(...d96Offs(id, flow, done.flows[flow].ops));
      }
      gone.push(...voided.map((one) => ({ trade: one.trade, flow: one.flow, at: one.at })));
      for (const one of voided) expect(one.why).toMatch(D96);
    }
    // C-228's count of Nov 5, and this build's: the same 618.
    expect(all).toHaveLength(618);
    expect(gone).toHaveLength(196);
    expect(left).toHaveLength(all.length - gone.length);
    expect(left).toHaveLength(422);
    expect(listed(gone)).toMatchInlineSnapshot(`
      [
        "S1-32: 24 ops, 12 trades: flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S11-48: 24 ops, 12 trades: flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S11-50: 54 ops, 27 trades: aba, addiction, band, clown, comedian, ent, fertility, flight-school, gastroenterologist, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, orthopedist, party-characters, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, urologist, wellness-studio",
        "S11-57: 24 ops, 12 trades: flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S13-11: 32 ops, 16 trades: fertility, flight-school, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S13-15: 8 ops, 4 trades: fertility, lab, obgyn, sleep-clinic",
        "S2-11: 6 ops, 3 trades: occupational-therapist, pain-management, sports-medicine",
        "S2-22: 24 ops, 12 trades: flight-school, golf-instructor, horse-riding, hypnotherapist, recording-studio, reiki, shooting, ski-instructor, sports-coach, spray-tan, teeth-whitening, wellness-studio",
      ]
    `);
    expect(listed(left)).toMatchInlineSnapshot(`
      [
        "S1-32 "The number isn't found": 26 ops, 13 trades: aba, addiction, doula, fertility, lab, lactation, midwife, obgyn, occupational-therapist, pain-management, psychiatrist, sleep-clinic, sports-medicine",
        "S1-33: 46 ops, 23 trades: aba, addiction, ent, fertility, flight-school, gastroenterologist, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, orthopedist, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, urologist, wellness-studio",
        "S1-60 "1 A license": 44 ops, 22 trades: architect, art-appraiser, axe-throwing, fertility, fishing-charter, flight-school, horse-riding, hunting-guide, hypnotherapist, lab, limo, mini-golf, obgyn, pet-cremation, recording-studio, reiki, shooting, sleep-clinic, spray-tan, teeth-whitening, trampoline-park, wellness-studio",
        "S1-60 "2 No license: registration only": 2 ops, 1 trades: aba",
        "S11-99: 46 ops, 23 trades: aba, addiction, ent, fertility, flight-school, gastroenterologist, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, orthopedist, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, urologist, wellness-studio",
        "S12-19: 56 ops, 26 trades: aba, addiction, band, clown, comedian, doula, fertility, flight-school, golf-instructor, horse-riding, hypnotherapist, lab, lactation, midwife, obgyn, party-characters, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S12-19 "": 8 ops, 4 trades: ent, gastroenterologist, orthopedist, urologist",
        "S13-41: 38 ops, 19 trades: aba, addiction, fertility, flight-school, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S13-43: 38 ops, 19 trades: aba, addiction, fertility, flight-school, golf-instructor, horse-riding, hypnotherapist, lab, obgyn, psychiatrist, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, wellness-studio",
        "S2-11 "Doesn't match": 12 ops, 6 trades: aba, addiction, doula, lactation, midwife, psychiatrist",
        "S2-11 "Expired": 6 ops, 3 trades: aba, addiction, psychiatrist",
        "S2-11 "The lookup is down": 12 ops, 6 trades: aba, addiction, doula, lactation, midwife, psychiatrist",
        "S2-12: 6 ops, 3 trades: aba, addiction, psychiatrist",
        "S2-13: 6 ops, 3 trades: aba, addiction, psychiatrist",
        "S2-14: 6 ops, 3 trades: aba, addiction, psychiatrist",
        "S2-28 "1 Yes, each one": 58 ops, 29 trades: architect, art-appraiser, axe-throwing, ent, fertility, fishing-charter, flight-school, gastroenterologist, golf-instructor, horse-riding, hunting-guide, hypnotherapist, lab, limo, mini-golf, obgyn, orthopedist, pet-cremation, recording-studio, reiki, shooting, ski-instructor, sleep-clinic, sports-coach, spray-tan, teeth-whitening, trampoline-park, urologist, wellness-studio",
        "S2-28 "2 No person license": 6 ops, 3 trades: aba, addiction, psychiatrist",
        "S2-29: 6 ops, 3 trades: aba, addiction, psychiatrist",
      ]
    `);
  });
});

describe("the void steps run for every trade", () => {
  it("lights each void step on a money path of each trade that turned it off, where before it was off", () => {
    const voids = new Map<string, Set<string>>();
    for (const id of ALL)
      for (const one of voidOffs(trade(id)).voided) {
        const steps = voids.get(id) ?? new Set<string>();
        steps.add(one.at);
        voids.set(id, steps);
      }
    // The 12 trades and those MC C8 names or counts: 30 trades.
    expect(voids.size).toBe(30);
    for (const [id, steps] of voids)
      for (const flow of FLOWS) {
        const raw = trade(id);
        // Before C8: the trade's op switches each of them off.
        const ops = raw.flows[flow].ops.filter(isVoidOff).map((op) => op.at);
        expect(new Set(ops), `${id} ${flow}`).toStrictEqual(steps);

        const voided = voidOffs(raw).trade;
        const done = applyCorrections(applyTrade(master[flow], voided));
        for (const step of steps)
          expect(find(done.flow.steps, step)?.off, `${id} ${flow} ${step}`).toBeUndefined();
        const path = tradePaths(done, voided, { booking: false, fixtures: false })[0];
        if (path === undefined) throw new Error(`${id} ${flow}: no money path`);
        const lit = new Set(walkPath(done, path).steps.map((entry) => entry.id));
        for (const step of steps) expect(lit.has(step), `${id} ${flow} ${step} lit`).toBe(true);
      }
  });
});

describe("C8 in the bundle", () => {
  it("leaves the void offs out of golf-instructor's compiled overlay and keeps every other off", async () => {
    const id = "golf-instructor";
    const built = await buildBundle({ trades: [id], master });
    const overlay = built.bundle.trades[id] as {
      flows: Record<FlowLetter, { ops: { op: string; at: string; label?: string; why?: string }[] }>;
    };
    for (const flow of FLOWS) {
      const offs = overlay.flows[flow].ops.filter((op) => op.op === "off");
      const kept = trade(id).flows[flow].ops.filter((op) => op.op === "off" && !isVoidOff(op));
      expect(offs, flow).toStrictEqual(kept);
      for (const step of ["S1-32", "S2-22", "S11-48", "S11-57", "S11-50", "S13-11"])
        expect(
          offs.some((op) => op.at === step && op.label === undefined),
          `${flow} ${step}`,
        ).toBe(false);
      // Its other D96 offs stay: the verify-only steps and S2-28's branch.
      for (const step of ["S1-33", "S11-99", "S12-19", "S13-41", "S13-43"])
        expect(
          offs.some((op) => op.at === step),
          `${flow} ${step}`,
        ).toBe(true);
      expect(
        offs.some((op) => op.at === "S2-28" && op.label === "1 Yes, each one"),
        flow,
      ).toBe(true);
    }
  });
});

describe("C8's tags", () => {
  it("tags every dropped op MC:C8 in its diff lines, and changes no step in the frame", () => {
    const { voided } = voidOffs(trade("golf-instructor"));
    expect(voided).toHaveLength(12);
    const lines = renderVoided(voided);
    expect(lines.every((line) => line.startsWith("MC:C8 - golf-instructor "))).toBe(true);
    expect(lines[0]).toMatch(
      /^MC:C8 - golf-instructor A ops\[\d+\]: \{"op":"off","at":"S1-32","why":".*D96.*"\}$/,
    );
    const applied = applyTrade(master.A, trade("golf-instructor"));
    expect(applyCorrections(applied, [c8]).changes).toStrictEqual([]);
    expect(c8.id).toBe("C8");
    expect(c8.source).toContain("Master Corrections C8");
    expect(c8.source).toContain("D96");
  });
});
