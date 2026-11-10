// The page and console calls the page entry routes (T-266; C-044; K-21 v1): each call's path under BASE_PATH, and which
// calls are staging's only. The names are K-21 v1's `$defs/callName`, in its order, and the staging-only ones its
// `$defs/stagingOnlyCall` (contracts/page-api/page-api.v1.schema.json); pages.test.ts holds both lists to the schema.
// K-21's later minor versions bring their calls with their journey lanes (v1.1's booking page and listing, v1.2's
// customer screens), so until then their paths answer 404 like any unknown path.
//
// The path is the contract's name and the call's own, exactly: POST {BASE_PATH}/page-api/<call>, so one name serves the
// contract, its fixtures (`call`), the Tool API mock (C-186) and the route. No source names the path (Q-51 makes only
// BASE_PATH and the link host config values), so this is the card's default.

/** Every call K-21 v1 holds, in the order of `$defs/callName`. */
export const PAGE_CALLS = [
  "openLink",
  "signInStart",
  "signInCheck",
  "signOut",
  "codeStart",
  "codeCheck",
  "readRegistration",
  "answerOnPage",
  "confirmOnPage",
  "signedUpload",
  "finishUpload",
  "stripeOnboardingStart",
  "stripeOnboardingReturn",
  "billCard",
  "calendarConnectStart",
  "calendarConnectReturn",
  "readStaffPage",
  "teamConsole",
  "teamAcknowledgePage",
  "teamDecideReviewItem",
  "testRoster",
  "testPhoneSend",
  "testPhoneParts",
  "testClockRows",
  "fireNow",
  "textHoursOverride",
] as const;

export type PageCallName = (typeof PAGE_CALLS)[number];

/**
 * The calls that exist on staging only and answer K-21's stagingOnly anywhere else, doing nothing (K-21 v1
 * `$defs/stagingOnlyCall`, in its order; BP 9.4 "Never in production").
 */
export const STAGING_ONLY_CALLS = [
  "testRoster",
  "testPhoneSend",
  "testPhoneParts",
  "testClockRows",
  "fireNow",
  "textHoursOverride",
] as const satisfies readonly PageCallName[];

/** The prefix, under BASE_PATH, of every call's path: {BASE_PATH}/page-api/<call>. */
export const PAGE_API_PATH = "/page-api";

// Sets, so a name such as "constructor" or "__proto__" is never taken for a call.
const CALLS: ReadonlySet<string> = new Set(PAGE_CALLS);
const STAGING_ONLY: ReadonlySet<string> = new Set(STAGING_ONLY_CALLS);

/** True when `name` is a call of K-21 v1, by its exact spelling. */
export function isPageCall(name: string): name is PageCallName {
  return CALLS.has(name);
}

/** True when the call exists on staging only. */
export function isStagingOnly(call: PageCallName): boolean {
  return STAGING_ONLY.has(call);
}

/** One call's path under BASE_PATH. */
export function pagePathOf(call: PageCallName): string {
  return `${PAGE_API_PATH}/${call}`;
}

/**
 * The call a path under BASE_PATH names, or null when it names none. Only `/page-api/<call>` exactly, with the call's own
 * spelling: no trailing part or slash, no other case, and no decoding (a percent-encoded name is not a call).
 */
export function pageRouteOf(path: string): PageCallName | null {
  const prefix = `${PAGE_API_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  return isPageCall(name) ? name : null;
}
