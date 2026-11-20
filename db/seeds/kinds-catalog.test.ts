// T-1469: the kinds catalog set's plan and its compare, with no database (`npm test`; the database half, the card's
// proofs, is kinds-catalog.int.test.ts). The plan is the kinds seed's own catalog part (catalogPlanOf, T-212): planned
// here from the checked trade files alone, it is compared, row for row and as JSON text, with the catalog rows kindsPlanOf
// plans beside the demo shops' picks. The compare of rows read back with the plan is checked on copies of the planned
// rows, changed one value at a time.
import { beforeAll, describe, expect, it } from "vitest";
import {
  catalogPlanOf,
  type KindsCatalogPlan,
  kindsPlanOf,
  openTradeSet,
  type VerifiedTradeSet,
  verifyTradeSet,
} from "./kinds";
import {
  type CatalogDifference,
  catalogDifferences,
  type CatalogRowRead,
  KindsCatalogSeedError,
  seed,
  seedKindsCatalog,
} from "./kinds-catalog";
import { openFixtureSet, verifyFixtureSet } from "./lib/fixture-set";

const REFUSED = "the kinds catalog seed refused, writing nothing: ";

let trades: VerifiedTradeSet;
let plan: KindsCatalogPlan;

beforeAll(() => {
  trades = verifyTradeSet(openTradeSet());
  plan = catalogPlanOf(trades);
});

/** The plan's rows as the database gives them back: every planned column, and version, as a first run leaves them. */
function readBack(version = 1): { kinds: Record<string, unknown>[]; flows: Record<string, unknown>[] } {
  return {
    kinds: plan.rows.kinds.map((row) => ({ ...row, facts: [...row.facts], version })),
    flows: plan.rows.kind_flows.map((row) => ({
      ...row,
      combos: [...row.combos],
      switches_on: [...row.switches_on],
      version,
    })),
  };
}

/** The row read back for one kind (kinds) or one of its flows (kind_flows). */
function rowOf(rows: Record<string, unknown>[], kindId: string, flow?: string): Record<string, unknown> {
  const found = rows.find((row) =>
    flow === undefined ? row.id === kindId : row.kind_id === kindId && row.flow === flow,
  );
  if (found === undefined) {
    throw new Error(`no row for ${kindId} ${flow ?? ""}`);
  }
  return found;
}

describe("the kinds catalog set's plan (T-1469)", () => {
  it("plans 243 kinds, one per trade file, each followed in kind_flows by its two flows, A then B", () => {
    expect(plan.rows.kinds).toHaveLength(243);
    expect(plan.rows.kind_flows).toHaveLength(486);
    plan.rows.kinds.forEach((kind, index) => {
      expect(
        [plan.rows.kind_flows[2 * index], plan.rows.kind_flows[2 * index + 1]].map((row) => [
          row?.kind_id,
          row?.flow,
        ]),
        kind.id,
      ).toEqual([
        [kind.id, "A"],
        [kind.id, "B"],
      ]);
    });
    expect(plan.kinds.map((kind) => kind.kindId)).toEqual(plan.rows.kinds.map((kind) => kind.id));
    expect(Object.keys(plan.rows)).toEqual(["kinds", "kind_flows"]);
  });

  it("is the kinds seed's catalog exactly: the same rows, values and order as kindsPlanOf plans beside the demo shops' picks, as objects and as JSON text", () => {
    const full = kindsPlanOf(verifyFixtureSet(openFixtureSet()), trades);
    expect(plan.rows.kinds).toStrictEqual(full.rows.kinds);
    expect(plan.rows.kind_flows).toStrictEqual(full.rows.kind_flows);
    expect(plan.kinds).toStrictEqual(full.kinds);
    expect(JSON.stringify(plan.rows.kinds)).toBe(JSON.stringify(full.rows.kinds));
    expect(JSON.stringify(plan.rows.kind_flows)).toBe(JSON.stringify(full.rows.kind_flows));
    expect(JSON.stringify(plan.kinds)).toBe(JSON.stringify(full.kinds));
  });

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedKindsCatalog);
  });
});

describe("the kinds catalog set's compare of the rows read back with its plan (T-1469)", () => {
  it("finds nothing when every row read back holds its trade file's values, whatever its version, and looks at no row the plan does not name", () => {
    const { kinds, flows } = readBack();
    expect(catalogDifferences(plan.rows, kinds, flows)).toEqual([]);
    const raised = readBack(7);
    expect(catalogDifferences(plan.rows, raised.kinds, raised.flows)).toEqual([]);
    const drafted: CatalogRowRead = {
      id: "new-pack-hikes",
      name: "pack hikes",
      style: null,
      pattern: "event",
      facts: null,
      source: "new_work",
      version: 1,
    };
    expect(catalogDifferences(plan.rows, [...kinds, drafted], flows)).toEqual([]);
  });

  it("names each kind whose rows differ, in code-point order of id, with each row's table, flow and columns: a value changed, a null where the file gives words, a list in another order, a row that is not there", () => {
    const { kinds, flows } = readBack();
    rowOf(kinds, "barber").name = "Barber Shop Deluxe";
    rowOf(flows, "barber", "A").cutoff = null;
    rowOf(flows, "dog-walker", "B").arrive_window_hours = 3;
    const insurance = rowOf(kinds, "insurance");
    insurance.facts = [...(insurance.facts as string[])].reverse();
    rowOf(flows, "plumber", "B").cutoff = "1 hour before";
    rowOf(flows, "plumber", "B").switches_on = [];
    const withoutYogaB = flows.filter((row) => !(row.kind_id === "yoga" && row.flow === "B"));
    const expected: CatalogDifference[] = [
      { kindId: "barber", parts: ["kinds: name", "kind_flows A: cutoff"] },
      { kindId: "dog-walker", parts: ["kind_flows B: arrive_window_hours"] },
      { kindId: "insurance", parts: ["kinds: facts"] },
      { kindId: "plumber", parts: ["kind_flows B: switches_on, cutoff"] },
      { kindId: "yoga", parts: ["kind_flows B: no row"] },
    ];
    expect(catalogDifferences(plan.rows, kinds, withoutYogaB)).toEqual(expected);
  });

  it("refuses with a message that names each kind id and what differs, at most ten of them, and keeps every id", () => {
    const one = new KindsCatalogSeedError([{ kindId: "barber", parts: ["kinds: name"] }]);
    expect(one.message).toBe(
      `${REFUSED}the catalog rows of 1 kind differ from the trade files, and a catalog row is never changed here: ` +
        "barber (kinds: name)",
    );
    expect(one.kindIds).toEqual(["barber"]);
    expect(one.name).toBe("KindsCatalogSeedError");
    const ids = plan.rows.kinds.slice(0, 12).map((kind) => kind.id);
    const many = new KindsCatalogSeedError(
      ids.map((kindId) => ({ kindId, parts: ["kinds: name", "kind_flows B: cutoff"] })),
    );
    expect(many.kindIds).toEqual(ids);
    expect(many.message).toBe(
      `${REFUSED}the catalog rows of 12 kinds differ from the trade files, and a catalog row is never changed here: ` +
        ids
          .slice(0, 10)
          .map((id) => `${id} (kinds: name; kind_flows B: cutoff)`)
          .join(", ") +
        " (and 2 more)",
    );
  });
});
