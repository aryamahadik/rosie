// T-667: item 77's two-column names and the setup fact homes, held to their own rules without a database (the
// integration tests, turn-state.int.test.ts and commit-setup.int.test.ts, hold them to the frozen table lists and run
// them against local PostgreSQL).
import { describe, expect, it } from "vitest";
import { FACT_HOMES } from "../turn-state";
import { NEVER_SETUP_COLUMNS, NEVER_SETUP_TABLES, SETUP_FACT_HOMES, setupHomeOf } from "./fact-homes";
import { isNamedKey, TWO_COLUMN_KEYS, twoColumnKeyOf } from "./row-names";

describe("K-05 v1.18 item 77's two-column keys", () => {
  it("names exactly the five tables item 77 lists, each key in its primary key's column order", () => {
    expect(TWO_COLUMN_KEYS).toEqual({
      company_kinds: ["company_id", "kind_id"],
      flow_defaults: ["business_id", "flow"],
      kind_flows: ["kind_id", "flow"],
      new_work_draft_blocks: ["draft_id", "block"],
      picked_kind_texts: ["picked_kind_id", "pf_key"],
    });
    expect(twoColumnKeyOf("company_kinds")).toEqual(["company_id", "kind_id"]);
    expect(twoColumnKeyOf("services")).toBeNull();
    expect(twoColumnKeyOf("toString")).toBeNull();
  });

  it("takes a key of one column, and a key of two only as item 77 lists it, column for column", () => {
    expect(isNamedKey("services", ["id"])).toBe(true);
    expect(isNamedKey("company_kinds", ["company_id", "kind_id"])).toBe(true);
    expect(isNamedKey("company_kinds", ["kind_id", "company_id"])).toBe(false);
    expect(isNamedKey("company_kinds", ["company_id"])).toBe(true);
    for (const table of ["item_services", "bundles", "outbox_parts", "release_flags", "person_handles"]) {
      expect(isNamedKey(table, ["a", "b"]), table).toBe(false);
    }
    expect(isNamedKey("company_kinds", ["company_id", "kind_id", "business_id"])).toBe(false);
    expect(isNamedKey("company_kinds", [])).toBe(false);
  });
});

describe("the setup fact homes", () => {
  const homes = Object.entries(SETUP_FACT_HOMES);

  it("hold every home's key, scope and version among its own columns, a two-column key only as item 77 names it", () => {
    for (const [table, home] of homes) {
      for (const column of [...home.key, "version", ...(home.scopedBy === null ? [] : [home.scopedBy])]) {
        expect(Object.hasOwn(home.columns, column), `${table}.${column}`).toBe(true);
      }
      expect(isNamedKey(table, home.key), table).toBe(true);
      expect(home.columns.version, table).toBe("integer");
    }
    expect(
      homes
        .filter(([, home]) => home.key.length === 2)
        .map(([table]) => table)
        .sort(),
    ).toEqual(Object.keys(TWO_COLUMN_KEYS).sort());
  });

  it("never list a K-04 core table, which turn-state.ts's FACT_HOMES holds", () => {
    for (const [table] of homes) {
      expect(Object.hasOwn(FACT_HOMES, table), table).toBe(false);
    }
  });

  it("never answer a secret's hash, a sealed column or a table the Tool API never reads", () => {
    for (const name of NEVER_SETUP_COLUMNS) {
      const [table = "", column = ""] = name.split(".");
      expect(Object.hasOwn(SETUP_FACT_HOMES[table]?.columns ?? {}, column), name).toBe(false);
      expect(setupHomeOf(table, column), name).toBeNull();
    }
    for (const table of NEVER_SETUP_TABLES) {
      expect(Object.hasOwn(SETUP_FACT_HOMES, table), table).toBe(false);
      expect(setupHomeOf(table, "id"), table).toBeNull();
    }
    expect(setupHomeOf("locations", "map_point")).toBeNull();
    expect(setupHomeOf("item_services", "service_id")).toBeNull();
    expect(setupHomeOf("businesses", "name")).toBeNull();
    expect(setupHomeOf("constructor", "name")).toBeNull();
    expect(setupHomeOf("services", "toString")).toBeNull();
    expect(setupHomeOf("company_kinds", "pf_facts")).toBe(SETUP_FACT_HOMES.company_kinds);
  });
});
