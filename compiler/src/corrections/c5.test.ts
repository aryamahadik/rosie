// T-139, C5: the typed plug-in values a trade file leaves out. Proofs of the card that belong to C5:
//   - insurance has facts video, forms, firststeps, documents: cpa.json's list, in cpa.json's order (CQ-129 (a)'s
//     default), each a fact the master knows; the trade file itself still lists none (the loader's input);
//   - with them, insurance's paths carry its four facts and hide what other facts gate, where with no list every
//     fact-gated branch shows; apply() reads no facts, so insurance's applied flow is the same with them;
//   - the 12 trades without pf.settings are exactly the 12 MC C5 names, and get arrive "window" and an empty cutoff in both
//     flows, as the compiled overlay holds them (emit/trade.ts settingsFor);
//   - every value C5 fills carries MC:C5; a trade whose file writes the values is given back as it is;
//   - C5 changes no step.
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { masterShape } from "../emit/flow";
import { settingsFor } from "../emit/trade";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade, type LoadedTrade } from "../load/trade";
import { applyTrade } from "../overlay/apply";
import { loadOverlayCore } from "../overlay/core";
import { tradePaths, walkPath } from "../path";
import {
  FACTS_FROM,
  INSURANCE,
  INSURANCE_FACTS,
  NO_SETTINGS,
  START_SETTINGS,
  c5,
  correctTrade,
  renderFills,
} from "./c5";
import { applyCorrections } from "./framework";

vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];
const ALL = listTradeIds();

const trades = new Map<string, LoadedTrade>();
function trade(id: string): LoadedTrade {
  let hit = trades.get(id);
  if (hit === undefined) {
    hit = loadTrade(id);
    trades.set(id, hit);
  }
  return hit;
}

/** The facts the master knows in a flow: overlay-core.js's own list with the flow header's (factList). */
function knownFacts(flow: FlowLetter): Record<string, unknown> {
  const core = loadOverlayCore() as unknown as { factList(flow: unknown): Record<string, unknown> };
  return core.factList(masterShape(master[flow]));
}

describe("C5: insurance's facts", () => {
  it("are video, forms, firststeps and documents: cpa.json's list, in its order, where the file lists none", () => {
    const loaded = trade(INSURANCE);
    expect(loaded.facts).toBeNull();
    const { trade: done, filled } = correctTrade(loaded);
    expect(done.facts).toStrictEqual(["forms", "firststeps", "documents", "video"]);
    expect(done.facts).toStrictEqual([...INSURANCE_FACTS]);
    expect(new Set(done.facts)).toStrictEqual(new Set(["video", "forms", "firststeps", "documents"]));
    expect(done.facts).toStrictEqual(trade(FACTS_FROM).facts);
    expect(filled.filter((fill) => fill.key === "pf.facts")).toStrictEqual([
      { tag: "MC:C5", trade: INSURANCE, key: "pf.facts", value: [...INSURANCE_FACTS] },
    ]);
    // Only the facts change: the loaded trade given is left as it was, and every other part is the file's.
    expect(loaded.facts).toBeNull();
    expect({ ...done, facts: null }).toStrictEqual(loaded);
  });

  it("are each a fact the master knows, in both flows", () => {
    for (const flow of FLOWS) {
      const known = knownFacts(flow);
      for (const fact of INSURANCE_FACTS) expect(Object.keys(known), `${flow} ${fact}`).toContain(fact);
    }
  });

  it("insurance is the only trade of 243 with no facts list, so it is the only one C5 fills", () => {
    expect(ALL).toHaveLength(243);
    expect(ALL.filter((id) => trade(id).facts === null)).toStrictEqual([INSURANCE]);
    for (const id of ALL)
      expect(
        correctTrade(trade(id)).filled.some((fill) => fill.key === "pf.facts"),
        id,
      ).toBe(id === INSURANCE);
  });

  it("put on insurance's paths, hide what other facts gate, where with no list every fact-gated branch shows", () => {
    const raw = trade(INSURANCE);
    const done = correctTrade(raw).trade;
    let hidden = 0;
    for (const flow of FLOWS) {
      // apply() reads no facts: the applied flow is the same with C5's facts, so parity before the corrections holds.
      const applied = applyTrade(master[flow], raw);
      expect(applyTrade(master[flow], done)).toStrictEqual(applied);
      const before = tradePaths(applied, raw, { booking: false, fixtures: false });
      const after = tradePaths(applied, done, { booking: false, fixtures: false });
      expect(after.map((path) => `${path.price}|${path.before}|${path.after}`)).toStrictEqual(
        before.map((path) => `${path.price}|${path.before}|${path.after}`),
      );
      for (const [k, path] of after.entries()) {
        const was = before[k];
        if (was === undefined) throw new Error(`${flow}: no path ${String(k)} before C5`);
        expect(was.facts).toBeNull();
        expect(path.facts).toStrictEqual([...INSURANCE_FACTS]);
        const litBefore = new Set(walkPath(applied, was).steps.map((entry) => entry.id));
        const litAfter = new Set(walkPath(applied, path).steps.map((entry) => entry.id));
        for (const id of litAfter) expect(litBefore.has(id), `${flow} ${id}`).toBe(true);
        hidden += [...litBefore].filter((id) => !litAfter.has(id)).length;
      }
    }
    expect(hidden).toBeGreaterThan(0);
  });
});

describe("C5: the 12 trades with no settings", () => {
  it("are exactly the 12 MC C5 names", () => {
    expect(ALL.filter((id) => trade(id).settings === null)).toStrictEqual([...NO_SETTINGS]);
    expect(NO_SETTINGS).toHaveLength(12);
  });

  it("get arrive 'window' and an empty cutoff in both flows, as the compiled overlay holds them", () => {
    for (const id of NO_SETTINGS) {
      const { filled } = correctTrade(trade(id));
      const settings = filled.filter((fill) => fill.key !== "pf.facts");
      expect(settings, id).toStrictEqual(
        FLOWS.flatMap((flow) => [
          { tag: "MC:C5", trade: id, key: "pf.settings.arrive", flow, value: "window" },
          { tag: "MC:C5", trade: id, key: "pf.settings.cutoff", flow, value: null },
        ]),
      );
      for (const flow of FLOWS) {
        expect(settingsFor(trade(id).settings, flow), `${id} ${flow}`).toStrictEqual({ ...START_SETTINGS });
        expect(settingsFor(trade(id).settings, flow)).toStrictEqual({ arrive: "window", cutoff: null });
      }
    }
  });

  it("fills nothing a trade file writes: a trade with its own facts and settings is given back as it is", () => {
    for (const id of ALL.filter((one) => trade(one).settings !== null && trade(one).facts !== null)) {
      const loaded = trade(id);
      const done = correctTrade(loaded);
      expect(done.trade, id).toBe(loaded);
      expect(done.filled, id).toStrictEqual([]);
    }
    expect(settingsFor(trade("barber").settings, "A")).toStrictEqual({
      arrive: "setstart",
      cutoff: "24 hours before",
    });
  });
});

describe("C5 on the whole", () => {
  it("tags every fill MC:C5, and writes each as a diff line starting with its tag", () => {
    const filled = ALL.flatMap((id) => correctTrade(trade(id)).filled);
    expect(filled).toHaveLength(1 + 12 * 2 * 2);
    expect(filled.every((fill) => fill.tag === "MC:C5")).toBe(true);
    const lines = renderFills(filled);
    expect(lines.every((line) => line.startsWith("MC:C5 + "))).toBe(true);
    expect(lines).toContain('MC:C5 + insurance pf.facts: ["forms","firststeps","documents","video"]');
    expect(lines).toContain('MC:C5 + insurance pf.settings.arrive A: "window"');
    expect(lines).toContain("MC:C5 + dj pf.settings.cutoff B: null");
  });

  it("changes no step", () => {
    for (const flow of FLOWS) {
      const applied = applyTrade(master[flow], trade(INSURANCE));
      const done = applyCorrections(applied, [c5]);
      expect(done.changes).toStrictEqual([]);
      expect(done.flow).toStrictEqual(applied.flow);
      expect(done.corrections).toStrictEqual(["C5"]);
    }
  });

  it("is C5's own, from Master Corrections C5", () => {
    expect(c5.id).toBe("C5");
    expect(c5.source).toContain("Master Corrections C5");
  });
});
