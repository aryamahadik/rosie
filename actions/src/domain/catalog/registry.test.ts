// T-1433 (i): the catalog's fact and switch names are held in code (registry.ts) and held here to K-26 v1's registry seed,
// contracts/db-schema/rules/fixtures/seed-rule-registry.json, which migration 0023 writes into trade_facts and
// plugin_switches (K-05 v1.18 CQ-349 ruling (3): no read, names only from compiled sources, held to the registry by a
// unit test, as limit 2's evaluator holds K-26's 16 rule kinds).

import { describe, expect, it } from "vitest";

import { contractFile } from "../../tool-api/test-support";
import { PLUGIN_SWITCHES, TRADE_FACTS, isPluginSwitch, isTradeFact } from "./index";

interface RegistrySeed {
  readonly rows: readonly { readonly table: string; readonly values: Readonly<Record<string, unknown>> }[];
}

/** The names of one of the seed's registry tables, in the seed's order. */
function seededNames(table: string): unknown[] {
  const seed = contractFile("db-schema/rules/fixtures/seed-rule-registry.json") as RegistrySeed;
  return seed.rows.filter((row) => row.table === table).map((row) => row.values.name);
}

describe("the catalog's names are K-26 v1's registry (seed-rule-registry.json)", () => {
  it("holds exactly the seed's 28 trade facts, in its order", () => {
    const facts = seededNames("trade_facts");
    expect(facts).toHaveLength(28);
    expect([...TRADE_FACTS]).toEqual(facts);
  });

  it("holds exactly the seed's 6 plug-in switches, in its order, nomoney among them as K-26 default 3 adds it", () => {
    const switches = seededNames("plugin_switches");
    expect(switches).toHaveLength(6);
    expect([...PLUGIN_SWITCHES]).toEqual(switches);
    expect(isPluginSwitch("nomoney") && isTradeFact("nomoney")).toBe(true);
  });

  it("knows no other name: a switch is no fact, a fact no switch, and nothing inherited or out of form", () => {
    for (const name of ["sensitive", "grief", "toString", "constructor", "__proto__", "Photos", ""]) {
      expect(isTradeFact(name), name).toBe(false);
    }
    for (const name of ["photos", "grief", "toString", "constructor", "__proto__", "Sensitive", ""]) {
      expect(isPluginSwitch(name), name).toBe(false);
    }
  });
});
