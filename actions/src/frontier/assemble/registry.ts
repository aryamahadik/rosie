// The frontier's sources, in the order its choices are listed (T-291; arch 03 lines 157 to 167): the open questions
// first, then the branches below them that pass their gates, the hubs and doors, and the any-time rows, as K-09's
// build-frontier-s1-02.json lists them (S1-02's options, then the door S11-21, then the danger row).
//
// A slot holds null until its task lands; a null slot offers nothing and is logged on every call
// (frontier_source_missing), so the frontier fails closed on what is not built. Each later task fills its own slot with
// the source its folder exports (actions/src/frontier/sources/<name>/), one line here; facts and the 60 cap (T-295) run
// after the sources, outside this list.
//
// The hubs-and-doors source (T-293, wired by T-1147) reads its doors' words and the sign-up door's section from the
// pinned flow graph through the bundles port the frontier reads the bundle with (sources/hubs-doors), so the slots are
// made for that port: frontierSources(bundles), which buildFrontier's handler uses (handler.ts; T-293's handoff 1).

import { createHubsAndDoorsSource } from "../sources/hubs-doors";
import { openQuestionsSource } from "../sources/open-questions";
import type { FrontierBundles, SourceSlot } from "./types";

/** The slot names, in order. */
export const SLOT_NAMES = ["openQuestions", "branchGates", "hubsAndDoors", "anyTime"] as const;

/**
 * The frontier's slots, each source made for the bundles port the frontier reads with: the open questions (T-291) and
 * the hubs and doors (T-293) are built; T-292 and T-294 fill the others.
 */
export function frontierSources(bundles: FrontierBundles): readonly SourceSlot[] {
  return [
    { name: "openQuestions", source: openQuestionsSource },
    { name: "branchGates", source: null },
    { name: "hubsAndDoors", source: createHubsAndDoorsSource(bundles) },
    { name: "anyTime", source: null },
  ];
}

/** A bundles port that holds no bundle: K-01's answer for one in neither KV nor PostgreSQL's copy is null. */
const NO_BUNDLES: FrontierBundles = {
  manifest: () => Promise.resolve(null),
  flow: () => Promise.resolve(null),
};

/**
 * The frontier's slots as built, for a reader that asks which are (a null source is not built yet). Its sources read
 * through a port that holds no bundle, so its hubs and doors offer no door (logged frontier_bundle_missing on a call
 * that would): buildFrontier makes its slots for its own port (frontierSources).
 */
export const FRONTIER_SOURCES: readonly SourceSlot[] = frontierSources(NO_BUNDLES);
