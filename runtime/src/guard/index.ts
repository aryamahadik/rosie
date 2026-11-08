// The guard (T-250; C-051): START, HELP and the pinned bundle's 16 opt-out words by code alone, then the handle's targets.
// See guard.ts. The fixed replies (T-267) and the after-stop rules (T-268) build beside it in this folder.

export { guardTurn, type GuardTurn } from "./guard";
export { keyOf, keywordOf, keywordsOf, KeywordList } from "./keywords";
export {
  readTargets,
  setGuardDeps,
  targetsOf,
  type GuardDeps,
  type TargetCounts,
  type TargetsRead,
} from "./targets";
export * from "./types";
