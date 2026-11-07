// T-137: the record engine. Proofs of the card:
//   - both flows compile 10 homes (money S13-55, contact S13-19, proof S13-45, stop S13-32, clock S13-35, who S13-31,
//     safety S13-10, change S13-56, record S13-57, two A9-21), 16 slots, 11 fixtures and onefee true;
//   - the first-fit row of every slot equals what the vendored fillRecord picks, on the main path of each flow (under
//     four stampings of the step) and on every path of four trades, three of which have their own rows first;
//   - a trade's own slot rows come first in their slot; the master's rows keep their order behind them;
//   - a `{{hold}}` slot is refused (D66), so is a hold way, a hold choice and an onefee that is not true;
//   - the compiled record is K-01's `record` (bundle.v1.schema.json), flow and trade alike.
//
// The reference side is a second, separate copy of lib.js and overlay-core.js (its own loader), run the way the
// master's tools run them: CORE.syncWays() on the master's JSON, CORE.apply() for a trade, and CORE.fillRecord() on a
// step that holds the 16 slots; its info.rows says which row each slot took.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { loadTrade, type LoadedTrade } from "../load/trade";
import { applyTrade, type AppliedTrade } from "../overlay/apply";
import { makeCjsLoader } from "../overlay/cjs-load";
import { toCorePath, tradePaths } from "../path";
import {
  HOME_NAMES,
  HoldSlotError,
  OneFeeError,
  RecordError,
  SLOT_NAMES,
  TradeSlotError,
  compileRecord,
  compileRecords,
  compileTradeRecord,
  slotRowIndex,
  type CompiledRecordView,
  type RowStamps,
  type SlotName,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
vi.setConfig({ testTimeout: 120_000 });

const master = loadMaster();

type Obj = Record<string, unknown>;

function readJson(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8")) as Obj;
}

interface RefStep extends Obj {
  id: string;
  say: [string, string, string][];
}

interface Reference {
  CORE: {
    apply(m: unknown, o: unknown, f: FlowLetter): { flow: Obj; errors: string[] };
    syncWays(flow: unknown): void;
    fillRecord(
      step: RefStep,
      path: unknown,
      flow: FlowLetter,
      info: { rows?: Record<string, number | null> },
    ): unknown;
  };
}

const ref = makeCjsLoader()(`${WORK}build/lib.js`) as Reference;

/** A step that holds all 16 slots, stamped as asked: fillRecord's info.rows says which row each slot took. */
function refRows(
  flow: Obj,
  letter: FlowLetter,
  path: unknown,
  stamps: RowStamps,
): Record<string, number | null> {
  ref.CORE.syncWays(flow);
  const step: RefStep = {
    id: "S13-55",
    rec: letter,
    ...stamps,
    say: SLOT_NAMES.map((name) => ["san", "cust", `{{${name}}}`]),
  };
  const info: { rows?: Record<string, number | null> } = {};
  ref.CORE.fillRecord(step, path, letter, info);
  return info.rows ?? {};
}

function mineRows(
  view: CompiledRecordView,
  path: Parameters<typeof slotRowIndex>[2],
  stamps: RowStamps,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const name of SLOT_NAMES) out[name] = slotRowIndex(view, name, path, stamps);
  return out;
}

const STAMPS: { label: string; stamps: (flow: FlowLetter) => RowStamps }[] = [
  { label: "no stamps", stamps: () => ({}) },
  { label: "took", stamps: (flow) => ({ took: flow }) },
  { label: "ev", stamps: (flow) => ({ ev: flow }) },
  { label: "took, ev and wr false", stamps: (flow) => ({ took: flow, ev: flow, wr: false }) },
];

const records = compileRecords(master);

describe("the master's record, both flows", () => {
  it.each(["A", "B"] as const)("flow %s: 10 homes, 16 slots, 11 fixtures, onefee true", (flow) => {
    const { record } = records[flow];
    expect(record.homes).toEqual({
      money: "S13-55",
      contact: "S13-19",
      proof: "S13-45",
      stop: "S13-32",
      clock: "S13-35",
      who: "S13-31",
      safety: "S13-10",
      change: "S13-56",
      record: "S13-57",
      two: "A9-21",
    });
    expect(Object.keys(record.homes)).toEqual([...HOME_NAMES]);
    expect(Object.keys(record.homes)).toHaveLength(10);
    expect(Object.keys(record.slots)).toEqual([...SLOT_NAMES]);
    expect(Object.keys(record.slots)).toHaveLength(16);
    expect(record.fixtures.map((fixture) => fixture.id)).toEqual([
      "two-card",
      "two-full",
      "credit-plus",
      "added-later",
      "switched",
      "switched-call",
      "stopped",
      "private-call",
      "shop-nothing",
      "two-calls",
      "payer-other",
    ]);
    expect(record.onefee).toBe(true);
    expect(Object.keys(record.ways)).toEqual(["none", "card", "deposit", "full", "credit"]);
    expect(record.ledger_rules).toContain("one fee");
  });

  it("keeps the master's own rows, in the master's order, and nothing the master does not have", () => {
    for (const flow of ["A", "B"] as const) {
      const source = master[flow].record;
      const { record, ownRows } = records[flow];
      for (const name of SLOT_NAMES) {
        expect(record.slots[name].rows).toEqual(source.slots[name]?.rows);
        expect(record.slots[name].home).toBe(source.slots[name]?.home);
        expect(ownRows[name]).toBe(0);
      }
      expect(record.fixtures).toEqual(source.fixtures);
      expect(record.services).toEqual(source.services);
      expect(record.ways).toEqual(source.ways);
      expect(record.live).toEqual(source.live);
      expect(record.lint).toEqual(source.lint);
      expect(Object.keys(record)).not.toContain("_about");
    }
  });

  it("the 16 slots are K-03's record slots, in K-03's order", () => {
    const slots = readJson(`${ROOT}contracts/message-plan/fixtures/slots.json`).slots as {
      name: string;
      kind: string;
    }[];
    expect(slots.filter((slot) => slot.kind === "record").map((slot) => slot.name)).toEqual([...SLOT_NAMES]);
    expect(slots.some((slot) => slot.name === "hold")).toBe(false);
  });

  it("every slot's home is one of the record's homes, and every home is a step of a flow", () => {
    for (const flow of ["A", "B"] as const) {
      const { record } = records[flow];
      const homes = new Set<string>(Object.values(record.homes));
      for (const name of SLOT_NAMES) expect(homes.has(record.slots[name].home)).toBe(true);
    }
    expect("A9-21" in master.B.steps).toBe(false);
    expect("A9-21" in master.A.steps).toBe(true);
  });
});

describe("the first row that fits is the row fillRecord takes", () => {
  it.each(["A", "B"] as const)("flow %s, main path, four stampings", (flow) => {
    const raw = readJson(`${WORK}master/master-${flow}.json`);
    for (const { label, stamps } of STAMPS) {
      const expected = refRows(raw, flow, null, stamps(flow));
      expect(Object.keys(expected), label).toHaveLength(16);
      expect(mineRows(records[flow], null, stamps(flow)), label).toEqual(expected);
    }
  });
});

// One apply takes about half a second: each trade and flow is applied once.
const appliedCache = new Map<string, AppliedTrade>();
function applied(id: string, flow: FlowLetter): AppliedTrade {
  const key = `${id} ${flow}`;
  let hit = appliedCache.get(key);
  if (hit === undefined) {
    hit = applyTrade(master[flow], loadTrade(id));
    appliedCache.set(key, hit);
  }
  return hit;
}

/** The reference's applied flow for a trade: apply() on a second copy, on the files as they are. */
function refApplied(id: string, flow: FlowLetter): Obj {
  const raw = readJson(`${WORK}master/master-${flow}.json`);
  const overlay = readJson(`${WORK}prof/${id}.json`);
  const dropAuthoring = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps as Obj[]) {
      delete step.src;
      delete step.prop;
      for (const branch of (step.branches ?? []) as Obj[]) dropAuthoring(branch.steps);
    }
  };
  dropAuthoring(raw.steps);
  for (const op of ((overlay[flow] as Obj).ops ?? []) as Obj[]) {
    dropAuthoring(op.steps);
    if (isBranchOp(op)) dropAuthoring([{ branches: [op.branch] }]);
  }
  const result = ref.CORE.apply(raw, overlay, flow);
  expect(result.errors).toEqual([]);
  return result.flow;
}

function isBranchOp(op: Obj): op is Obj & { branch: unknown } {
  return op.branch !== undefined;
}

describe("a trade's record", () => {
  it("puts the trade's own rows first and the master's behind them (aba)", () => {
    const trade = loadTrade("aba");
    for (const flow of ["A", "B"] as const) {
      const view = compileTradeRecord(applied("aba", flow), trade);
      expect(view.trade).toBe("aba");
      expect(view.flow).toBe(flow);
      const own = trade.flows[flow].slotRows;
      expect(Object.keys(own).sort()).toEqual(["pay.cancel", "pay.late", "pay.took"]);
      for (const name of SLOT_NAMES) {
        const mine = own[name] ?? [];
        expect(view.ownRows[name]).toBe(mine.length);
        expect(view.record.slots[name].rows.slice(0, mine.length)).toEqual(mine);
        // behind them: the master's rows, renamed with the trade's pairs, so one for one and in order
        expect(view.record.slots[name].rows).toHaveLength(
          mine.length + records[flow].record.slots[name].rows.length,
        );
      }
      expect(view.record.slots["pay.took"].rows[0]).toEqual({
        when: { rec: ["card"] },
        text: "Your card is saved; nothing is taken now",
      });
    }
  });

  it("a trade with no rows of its own has the master's rows, renamed, and no own row", () => {
    const trade = loadTrade("cpa");
    const view = compileTradeRecord(applied("cpa", "A"), trade);
    for (const name of SLOT_NAMES) {
      expect(view.ownRows[name]).toBe(0);
      expect(view.record.slots[name].rows).toHaveLength(records.A.record.slots[name].rows.length);
    }
    expect(view.record.homes).toEqual(records.A.record.homes);
    expect(view.record.fixtures.map((fixture) => fixture.id)).toEqual(
      records.A.record.fixtures.map((fixture) => fixture.id),
    );
    expect(view.record.onefee).toBe(true);
  });

  it("joins the trade's own services to the record's", () => {
    const trade = loadTrade("cpa");
    const own = Object.keys(trade.flows.A.money.services ?? {});
    const view = compileTradeRecord(applied("cpa", "A"), trade);
    for (const id of own) expect(view.record.services).toHaveProperty(id);
  });

  it.each([
    ["aba", "A"],
    ["aba", "B"],
    ["lactation", "A"],
    ["realtor", "B"],
    ["cpa", "A"],
  ] as const)("%s flow %s: the row each slot takes equals fillRecord's, on every path", (id, flow) => {
    const trade = loadTrade(id);
    const view = compileTradeRecord(applied(id, flow), trade);
    const refFlow = refApplied(id, flow);
    const paths = tradePaths(applied(id, flow), trade);
    expect(paths.length).toBeGreaterThan(10);
    let own = 0;
    for (const path of paths) {
      for (const { label, stamps } of STAMPS.slice(0, 2)) {
        const expected = refRows(refFlow, flow, toCorePath(path), stamps(flow));
        const got = mineRows(view, path, stamps(flow));
        expect(got, `${id} ${flow} ${path.kind} ${label}`).toEqual(expected);
        for (const name of SLOT_NAMES) {
          const row = got[name];
          if (row !== null && row !== undefined && row < view.ownRows[name]) own += 1;
        }
      }
    }
    if (id === "aba" || id === "lactation" || id === "realtor") expect(own).toBeGreaterThan(0);
  });
});

describe("a hold is refused (D66)", () => {
  it("a {{hold}} slot in a master row", () => {
    for (const text of [
      "{{hold}} is held on your card",
      "{{hold:$89}} is held",
      "{{ hold | the hold }} is held",
    ]) {
      const flow = structuredClone(master.A);
      flow.record.slots["pay.price"]?.rows.unshift({ when: {}, text });
      expect(() => compileRecord(flow), text).toThrow(HoldSlotError);
    }
  });

  it("a {{hold}} slot in a trade's own row", () => {
    const trade = structuredClone(loadTrade("aba"));
    trade.flows.A.slotRows["pay.price"] = [
      { when: { rec: ["card"] }, text: "{{hold:$40}} is held until the visit" },
    ];
    const made = applyTrade(master.A, trade);
    expect(() => compileTradeRecord(made, trade)).toThrow(HoldSlotError);
    expect(() => compileTradeRecord(made, trade)).toThrow(/pay\.price/);
  });

  it("a hold way and a hold choice", () => {
    const way = structuredClone(master.B);
    (way.record.ways as Obj).hold = { now: "0", card: true, fee: "fee", back: "0" };
    expect(() => compileRecord(way)).toThrow(HoldSlotError);

    const gate = structuredClone(master.A);
    gate.record.slots["pay.late"]?.rows.unshift({
      when: { before: ["hold" as never] },
      text: "may keep the fee",
    });
    expect(() => compileRecord(gate)).toThrow(HoldSlotError);

    const service = structuredClone(master.A);
    const first = Object.values(service.record.services)[0];
    if (first === undefined) throw new Error("the record has no services");
    (first as unknown as Obj).before = "hold";
    expect(() => compileRecord(service)).toThrow(HoldSlotError);
  });

  it("the words 'held' or 'hold' in a row are not a {{hold}} slot", () => {
    const flow = structuredClone(master.A);
    flow.record.slots["pay.price"]?.rows.unshift({
      when: {},
      text: "Your spot is held for you. Hold on to this text",
    });
    expect(() => compileRecord(flow)).not.toThrow();
  });
});

describe("what else a record must be", () => {
  const damaged = (change: (flow: typeof master.A) => void): (() => unknown) => {
    const flow = structuredClone(master.A);
    change(flow);
    return () => compileRecord(flow);
  };

  it("one fee per booking: onefee other than true is refused", () => {
    expect(damaged((flow) => ((flow.record as unknown as Obj).onefee = false))).toThrow(OneFeeError);
  });

  it("exactly the 16 slots and the 10 homes", () => {
    expect(damaged((flow) => delete flow.record.slots["who.ok"])).toThrow(/who\.ok/);
    expect(
      damaged((flow) => ((flow.record.slots as Obj)["pay.extra"] = flow.record.slots["pay.price"])),
    ).toThrow(/pay\.extra/);
    expect(damaged((flow) => delete (flow.record.homes as Obj).stop)).toThrow(/homes\.stop/);
    expect(damaged((flow) => ((flow.record.homes as Obj).stop = "S13-9"))).toThrow(/not a step id/);
  });

  it("a slot ends in a row that fits every path, and a row's `rec` names a record fact", () => {
    expect(
      damaged((flow) => flow.record.slots["pay.late"]?.rows.push({ when: { rec: ["paid"] }, text: "x" })),
    ).toThrow(/last row/);
    expect(
      damaged((flow) =>
        flow.record.slots["pay.late"]?.rows.unshift({ when: { rec: ["frozen"] }, text: "x" }),
      ),
    ).toThrow(/not a record fact/);
    expect(
      damaged((flow) =>
        flow.record.slots["pay.late"]?.rows.unshift({ when: { bogus: ["x"] } as never, text: "x" }),
      ),
    ).toThrow(/unknown gate key/);
  });

  it("a fixture adds only services the record has", () => {
    expect(damaged((flow) => ((flow.record.fixtures[0] ?? { id: "", label: "" }).add = ["a-nope"]))).toThrow(
      /a-nope/,
    );
  });

  it("a trade's slot the record does not have, and own rows that are not the applied ones", () => {
    const trade = loadTrade("aba");
    const made = applied("aba", "A");

    const unknown: LoadedTrade = structuredClone(trade);
    unknown.flows.A.slotRows["pay.hold"] = [{ when: {}, text: "x" }];
    expect(() => compileTradeRecord(made, unknown)).toThrow(TradeSlotError);
    expect(() => compileTradeRecord(made, unknown)).toThrow(/pay\.hold/);

    const extra: LoadedTrade = structuredClone(trade);
    extra.flows.A.slotRows["pay.back"] = [{ when: {}, text: "Your money goes back." }];
    expect(() => compileTradeRecord(made, extra)).toThrow(TradeSlotError);

    const changed: LoadedTrade = structuredClone(trade);
    const row = changed.flows.A.slotRows["pay.took"]?.[0];
    if (row === undefined) throw new Error("aba has no pay.took row");
    row.text = "Another line";
    expect(() => compileTradeRecord(made, changed)).toThrow(/own row 1/);

    expect(() => compileTradeRecord(applied("cpa", "A"), trade)).toThrow(RecordError);
  });

  it("a path of the other flow is refused by slotRowIndex", () => {
    const path = tradePaths(applied("cpa", "B"), loadTrade("cpa"))[0];
    if (path === undefined) throw new Error("cpa has no flow B path");
    expect(() => slotRowIndex(records.A, "pay.price", path)).toThrow(RecordError);
    expect(() => slotRowIndex(records.A, "pay.hold" as SlotName, null)).toThrow(RecordError);
  });
});

describe("the compiled record is K-01's record", () => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(readJson(`${ROOT}contracts/common/formats.v1.schema.json`));
  ajv.addSchema(readJson(`${ROOT}contracts/bundle/bundle.v1.schema.json`));
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/record",
  );

  function accepted(view: CompiledRecordView): string[] {
    if (validate === undefined) throw new Error("K-01 has no record definition");
    if (validate(view.record) === true) return [];
    return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
  }

  it.each(["A", "B"] as const)("the master's, flow %s", (flow) => {
    expect(accepted(records[flow])).toEqual([]);
  });

  it("a trade's own, flows A and B (aba has own rows, cpa has own services)", () => {
    for (const id of ["aba", "cpa"]) {
      for (const flow of ["A", "B"] as const) {
        expect(accepted(compileTradeRecord(applied(id, flow), loadTrade(id))), `${id} ${flow}`).toEqual([]);
      }
    }
  });

  it("a record with a 17th slot is not K-01's (the schema is not vacuous)", () => {
    const flow = structuredClone(records.A);
    (flow.record.slots as Obj)["pay.hold"] = flow.record.slots["pay.price"];
    expect(accepted(flow).length).toBeGreaterThan(0);
  });
});
