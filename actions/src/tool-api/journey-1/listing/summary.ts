// S1-76's review item's summary (T-635a; K-09 README default 205, as DL-1133's Fix 1 words it): one of six fixed
// sentences code writes, with no private value (K-37 v1 review_items.summary: "without private values"), never the typed
// words, a listing's fields or a banned word:
//
//   A listing check (S1-76): the business's details as sent need a person's check before anything goes live. Claim: <claim>. Reason: <reason>.
//
// where <claim> is `owner` or `helper` (S1-09's settler's claim) and <reason> is `no listing`, `two listings` or `banned
// word` (the settler's reason label noListing, twoListings or bannedWord: default 201 (v)). The claim and the reason are
// labels, not private values.
//
// A leaf module: it imports nothing, so the paging service's review.ts (actions/src/domain/paging) can compare a
// listing_match item's summary whole with the owner's three sentences without an import cycle through the listing folder
// (T-1525 round 2, the action-layer engineer's note B). A done decision writes control (team_check) on a listing_match
// item only when its summary is one of the owner's sentences, compared whole, never by reading words (default 205;
// MASTER-FLOW-A line 149: "Never: count the helper's yes as the owner's").

/** Whose claim S1-09's answer carries (default 201): the owner's, or a helper's ("Helps run it; not an owner"). */
export type ListingClaim = "owner" | "helper";

/** Why S1-09's settler answered "No match, or already listed" (default 201 (v)). */
export type ListingReason = "noListing" | "twoListings" | "bannedWord";

/** The three reason labels, in default 201 (v)'s order. */
export const LISTING_REASONS: readonly ListingReason[] = ["noListing", "twoListings", "bannedWord"];

/** Each reason label's words in the summary (default 205). */
const REASON_WORDS: Readonly<Record<ListingReason, string>> = {
  noListing: "no listing",
  twoListings: "two listings",
  bannedWord: "banned word",
};

/** The summary's fixed opening sentence (default 205). */
const OPENING =
  "A listing check (S1-76): the business's details as sent need a person's check before anything goes live.";

/** S1-76's review item's summary for a claim and a reason: one of the six fixed sentences (default 205). */
export function listingSummaryOf(claim: ListingClaim, reason: ListingReason): string {
  return `${OPENING} Claim: ${claim}. Reason: ${REASON_WORDS[reason]}.`;
}

/** The owner's three sentences, in the reasons' order: the only summaries a done decision may prove control on. */
export const OWNER_LISTING_SUMMARIES: readonly string[] = LISTING_REASONS.map((reason) =>
  listingSummaryOf("owner", reason),
);

/** The helper's three sentences, in the reasons' order: a done decision never proves control on one. */
export const HELPER_LISTING_SUMMARIES: readonly string[] = LISTING_REASONS.map((reason) =>
  listingSummaryOf("helper", reason),
);

/** Whether a stored summary is one of the owner's three sentences, compared whole (default 205). */
export function isOwnerListingSummary(summary: unknown): boolean {
  return typeof summary === "string" && OWNER_LISTING_SUMMARIES.includes(summary);
}
