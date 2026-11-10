// K-21 v1's error names (T-1180; T-266's security note; DL-357): every `error` a call's `<call>.errors` can carry
// (contracts/page-api/page-api.v1.schema.json, with the K-09 and K-05 errors it takes by reference), as one closed list.
// The page entry puts a handler's `error` into its pageRequest span only when it is one of these, by its exact spelling;
// any other value is written as UNKNOWN_PAGE_ERROR, so a span never carries a label a handler made up, whatever words it
// might hold. The answer itself is still the handler's outcome, sent as it is (entry.ts). pages.test.ts holds this list
// to the schema, following each `$ref`, so a name the schema has and this list lacks (or the other way) fails it.

/** Every error name of K-21 v1's calls, each once, in the order JavaScript sorts strings. */
export const PAGE_ERRORS = [
  "alreadyDone",
  "attemptNotFound",
  "bookingPaused",
  "connectNotFound",
  "constraint",
  "emailAlreadyProven",
  "fieldsInvalid",
  "linkExpired",
  "needsMissing",
  "noContactOnFile",
  "noListingEmail",
  "noMoney",
  "notAllowed",
  "notArmed",
  "notFound",
  "notPaged",
  "notTeam",
  "notTestHandle",
  "notTestPhone",
  "notTester",
  "paused",
  "providerUnavailable",
  "questionClosed",
  "readBackChanged",
  "readBackExpired",
  "safetyFirst",
  "signInNeeded",
  "signatureNeeded",
  "stagingOnly",
  "tooLarge",
  "transient",
  "uploadNotFound",
  "versionChanged",
  "writeBackNotForKind",
  "wrongType",
] as const;

export type PageErrorName = (typeof PAGE_ERRORS)[number];

/** The span's label for a handler's `error` that is not one of K-21 v1's names (a fixed label, never the value). */
export const UNKNOWN_PAGE_ERROR = "unknownPageError";

// A Set, so a name such as "constructor" or "__proto__" is never taken for an error.
const ERRORS: ReadonlySet<string> = new Set(PAGE_ERRORS);

/** True when `value` is an error name of K-21 v1, by its exact spelling. */
export function isPageError(value: unknown): value is PageErrorName {
  return typeof value === "string" && ERRORS.has(value);
}
