// K-21 v1's checks on the two requests (page-api.v1.schema.json `testPhoneSend.request` and `testPhoneParts.request`,
// with their signed-in page envelope), written out by hand so they run inside the Workers runtime, where no validator may
// be compiled at run time (workerd allows no eval or Function). request.test.ts holds them to Ajv's verdict on the schema
// itself. Lengths count characters as Ajv does (code points), and every pattern is the schema's own, with its u flag.
//
// One check is code's, not the schema's: `since` must name a real instant (common/formats.v1 utc: "Whether the date
// exists is a code check").
//
// A problem names a field, never a value: no words, token, id or field name from the request is copied into one.

/** common/formats.v1 `id`: a string with a character that is not a line end. */
const ID = /./u;
/** common/formats.v1 `utc`. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;
/** K-21 v1 `linkCode`. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/u;

/** K-21 v1 `opaqueToken`'s lengths, and `testPhoneSend.request.words`'. */
const TOKEN_LENGTH = { min: 16, max: 512 } as const;
const WORDS_LENGTH = { min: 1, max: 10_000 } as const;

const PAGE_FIELDS = ["requestId", "traceId", "sessionToken", "linkCode"] as const;
const SEND_FIELDS = ["page", "testPhoneId", "words", "threadedReplyTo"] as const;
const PARTS_FIELDS = ["page", "testPhoneId", "since"] as const;

/** K-21 v1 `signedInPage`: the page envelope with a session. */
export interface SignedInPage {
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionToken: string;
  readonly linkCode: string | null;
}

/** K-21 v1 `testPhoneSend.request`. */
export interface TestPhoneSendRequest {
  readonly page: SignedInPage;
  readonly testPhoneId: string;
  readonly words: string;
  readonly threadedReplyTo: string | null;
}

/** K-21 v1 `testPhoneParts.request`. */
export interface TestPhonePartsRequest {
  readonly page: SignedInPage;
  readonly testPhoneId: string;
  readonly since: string | null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's own value for a field, never one it inherits. */
const own = (value: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(value, field) ? value[field] : undefined;

/** Characters as Ajv counts them for minLength and maxLength: code points (a surrogate pair is one). */
const lengthOf = (text: string): number => Array.from(text).length;

export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

const isUtc = (value: unknown): value is string => typeof value === "string" && UTC.test(value);

const hasLength = (value: unknown, bounds: { readonly min: number; readonly max: number }): boolean =>
  typeof value === "string" && lengthOf(value) >= bounds.min && lengthOf(value) <= bounds.max;

/** True when a utc time names an instant that exists (no 30 February, no hour 24, no second 60). */
export function isRealInstant(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})/u.exec(value);
  if (match === null) return false;
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN, hour = Number.NaN, minute = Number.NaN] =
    match.slice(1, 6).map(Number);
  const second = Number(match[6]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/** additionalProperties false: a field the definition does not name is a problem (its name is not copied). */
function onlyFields(
  where: string,
  value: Record<string, unknown>,
  fields: readonly string[],
  problems: string[],
): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    problems.push(`${where} has a field K-21 v1 does not name`);
}

function pageProblems(page: unknown, problems: string[]): void {
  if (!isRecord(page)) {
    problems.push("page is not an object");
    return;
  }
  onlyFields("page", page, PAGE_FIELDS, problems);
  if (!isId(own(page, "requestId"))) problems.push("page.requestId is not an id");
  if (!isId(own(page, "traceId"))) problems.push("page.traceId is not a trace id");
  if (!hasLength(own(page, "sessionToken"), TOKEN_LENGTH))
    problems.push("page.sessionToken is not a session token");
  const linkCode = own(page, "linkCode");
  if (linkCode !== null && !(typeof linkCode === "string" && LINK_CODE.test(linkCode)))
    problems.push("page.linkCode is not a link code or null");
}

/** Problems K-21 v1 finds in a `testPhoneSend.request`; none when it is one. */
export function testPhoneSendProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, SEND_FIELDS, problems);
  pageProblems(own(request, "page"), problems);
  if (!isId(own(request, "testPhoneId"))) problems.push("testPhoneId is not an id");
  if (!hasLength(own(request, "words"), WORDS_LENGTH)) problems.push("words is not 1 to 10000 characters");
  const threadedReplyTo = own(request, "threadedReplyTo");
  if (threadedReplyTo !== null && !isId(threadedReplyTo))
    problems.push("threadedReplyTo is not an id or null");
  return problems;
}

/** Problems K-21 v1 finds in a `testPhoneParts.request` (and code's real-instant check on `since`); none when it is one. */
export function testPhonePartsProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, PARTS_FIELDS, problems);
  pageProblems(own(request, "page"), problems);
  if (!isId(own(request, "testPhoneId"))) problems.push("testPhoneId is not an id");
  const since = own(request, "since");
  if (since !== null && !isUtc(since)) problems.push("since is not a utc time or null");
  else if (since !== null && !isRealInstant(since)) problems.push("since names no real instant");
  return problems;
}

/**
 * True when the request's page envelope carries no session token (null, or none at all): K-21 v1 signInNeededError,
 * "no session token", whatever else the request holds. Nothing else of the request is read for it.
 */
export function lacksSessionToken(request: unknown): boolean {
  if (!isRecord(request)) return false;
  const page = own(request, "page");
  if (!isRecord(page)) return false;
  const token = own(page, "sessionToken");
  return token === null || token === undefined;
}
