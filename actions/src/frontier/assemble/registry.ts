// The frontier's sources, in the order its choices are listed (T-291; arch 03 lines 157 to 167): the open questions
// first, then the branches below them that pass their gates, the hubs and doors, and the any-time rows, as K-09's
// build-frontier-s1-02.json lists them (S1-02's options, then the door S11-21, then the danger row).
//
// A slot holds null until its task lands; a null slot offers nothing and is logged on every call
// (frontier_source_missing), so the frontier fails closed on what is not built. Each later task fills its own slot with
// the source its folder exports (actions/src/frontier/sources/<name>/), one line here; facts and the 60 cap (T-295) run
// after the sources, outside this list.

import { openQuestionsSource } from "../sources/open-questions";
import type { SourceSlot } from "./types";

/** The slot names, in order. */
export const SLOT_NAMES = ["openQuestions", "branchGates", "hubsAndDoors", "anyTime"] as const;

/** The frontier's slots: only the open questions are built (T-291); T-292, T-293 and T-294 fill the others. */
export const FRONTIER_SOURCES: readonly SourceSlot[] = [
  { name: "openQuestions", source: openQuestionsSource },
  { name: "branchGates", source: null },
  { name: "hubsAndDoors", source: null },
  { name: "anyTime", source: null },
];
