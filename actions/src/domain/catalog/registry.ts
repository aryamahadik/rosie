// K-26 v1's closed registry of plug-in names (contracts/db-schema/rules: trade_facts and plugin_switches, which migration
// 0023 seeds from fixtures/seed-rule-registry.json), as the catalog holds it in code (K-05 v1.18 CQ-349 ruling (3); T-1433
// (i)). Every fact and switch name the catalog writes to K-23 company_kinds comes from a compiled source (a trade's
// defaults, K-24 kinds.facts and kind_flows.switches_on, written from the bundle's trade overlays; or a new-work draft's
// checklist names, S1-03), and the registry changes only with a migration's seed recorded as a K-26 minor version (K-26
// rule 6), so the names a business may hold change with a deploy, never between two reads: no read is made, and a name
// outside these lists is refused, never written (fails closed). registry.test holds both lists to the seed, as limit 2's
// evaluator holds K-26's 16 rule kinds (actions/src/rules/evaluator/registry.ts).

/** K-26 v1 trade_facts: the 28 plug-in facts a kind of work may list (company_kinds.pf_facts), in the seed's order. */
export const TRADE_FACTS = [
  "plans",
  "packs",
  "groups",
  "classes",
  "firststeps",
  "forms",
  "sentnow",
  "results",
  "planbill",
  "dropoff",
  "multiday",
  "spaces",
  "children",
  "incare",
  "animals",
  "video",
  "aftercare",
  "photos",
  "documents",
  "waitlist",
  "tips",
  "discounts",
  "stages",
  "monthlybill",
  "banktransfer",
  "extrawork",
  "nomoney",
  "capacitycheck",
] as const;

/**
 * K-26 v1 plugin_switches: the 6 plug-in switches a kind of work may have on in a flow (company_kinds.pf_switches_a and
 * pf_switches_b), in the seed's order; nomoney is a switch too, set with its fact (K-26 default 3).
 */
export const PLUGIN_SWITCHES = ["sensitive", "no2", "welfare", "cancelright", "verify", "nomoney"] as const;

export type TradeFact = (typeof TRADE_FACTS)[number];
export type PluginSwitch = (typeof PLUGIN_SWITCHES)[number];

/** Whether a name is one of K-26 v1's trade facts. */
export function isTradeFact(name: string): name is TradeFact {
  return (TRADE_FACTS as readonly string[]).includes(name);
}

/** Whether a name is one of K-26 v1's plug-in switches. */
export function isPluginSwitch(name: string): name is PluginSwitch {
  return (PLUGIN_SWITCHES as readonly string[]).includes(name);
}
