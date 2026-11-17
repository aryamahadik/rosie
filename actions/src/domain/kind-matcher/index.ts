// The kind matcher (T-632; C-130): an owner's words at sign-up (S1-02), part by part, to the closest of the 243 kinds of
// work as K-09 v1 matchKinds answers them: listed (one kind), which (two, one "which?" first), new_work (none yet, so
// S1-03 drafts it) or not_booked (work Rosie never books, S1-74: nothing is set up). T-631's method A: plain text on K-24
// v1's kinds.name, style and pattern, no model and no stored index. Pure: the caller hands in the kinds rows (K-24 v1
// kinds, source trade_file) and holds the matcher per catalog; the production read of those rows is T-633's binding.
// See matcher.ts, not-booked.ts and words.ts.

export {
  createKindMatcher,
  FLOOR,
  K1,
  KindCatalogError,
  LENGTH_NORM,
  NAME_WEIGHT,
  RATIO,
  TRADE_FILE,
  type CatalogKind,
  type KindFound,
  type KindMatch,
  type KindMatcher,
  type KindOutcome,
  type MatchKindsResponse,
  type RankedKind,
} from "./matcher";
export { notBookedReason, type NotBookedReason } from "./not-booked";
export { fold, meets, MIN_SHARED, MIN_WHOLE, plainTokens, splitParts, words } from "./words";
