// K-21 v1's checks on the sign-in calls' requests (page-api.v1.schema.json `signInStart.request`, T-1282;
// `signInCheck.request` and `signOut.request`, T-1285; each with its page envelope), written out by hand so they run
// inside the Workers runtime, where no validator may be compiled at run time (workerd allows no eval or Function).
// request.test.ts and check-request.test.ts hold them to Ajv's verdict on the schema itself. Lengths count characters as
// Ajv does (code points), and every pattern is the schema's own, with its u flag.
//
// Then the typed contact read as K-05 v1.13's signInContact needs it (ADR-016 section 4, "The key": an email in lower
// case, a mobile in E.164), which is code's, not the schema's.
//
// A problem names a field, never a value: no contact, code, token, id or field name from the request is copied into one.

/** common/formats.v1 `id`: a string with a character that is not a line end. */
const ID = /./u;
/** K-21 v1 `linkCode`. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/u;
/** K-21 v1 `signInCheck.request.code`: the code as typed, 4 to 8 digits. */
const CODE = /^[0-9]{4,8}$/u;

/** K-21 v1 `opaqueToken`'s lengths, and `signInStart.request.account.typed`'s. */
const TOKEN_LENGTH = { min: 16, max: 512 } as const;
const TYPED_LENGTH = { min: 1, max: 254 } as const;

const PAGE_FIELDS = ["requestId", "traceId", "sessionToken", "linkCode"] as const;
const START_FIELDS = ["page", "account", "way", "deviceToken"] as const;
const TYPED_FIELDS = ["from", "kind", "typed"] as const;
const LINK_FIELDS = ["from"] as const;
const CHECK_FIELDS = ["page", "attemptId", "code", "deviceToken"] as const;
const SIGN_OUT_FIELDS = ["page"] as const;

/** K-21 v1 `page`: the envelope every request carries. */
export interface PageEnvelope {
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionToken: string | null;
  readonly linkCode: string | null;
}

/** K-21 v1 `signInStart.request.account`: typed by the person, or the page's own signed link's. */
export type SignInAccount =
  | { readonly from: "typed"; readonly kind: "mobile" | "email"; readonly typed: string }
  | { readonly from: "link" };

/** K-21 v1 `signInStart.request`. */
export interface SignInStartRequest {
  readonly page: PageEnvelope;
  readonly account: SignInAccount;
  readonly way: "email" | "text";
  readonly deviceToken: string;
}

/** K-21 v1 `signInCheck.request`: the attempt the page holds, the code as typed (null on the text way) and the device. */
export interface SignInCheckRequest {
  readonly page: PageEnvelope;
  readonly attemptId: string;
  readonly code: string | null;
  readonly deviceToken: string;
}

/** K-21 v1 `signedInPage`: the envelope with a session, whose token is required. */
export interface SignedInPageEnvelope extends PageEnvelope {
  readonly sessionToken: string;
}

/** K-21 v1 `signOut.request`. */
export interface SignOutRequest {
  readonly page: SignedInPageEnvelope;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's own value for a field, never one it inherits. */
const own = (value: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(value, field) ? value[field] : undefined;

/** Characters as Ajv counts them for minLength and maxLength: code points (a surrogate pair is one). */
const lengthOf = (text: string): number => Array.from(text).length;

const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

const hasLength = (value: unknown, bounds: { readonly min: number; readonly max: number }): boolean =>
  typeof value === "string" && lengthOf(value) >= bounds.min && lengthOf(value) <= bounds.max;

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

/** Each named field is present (required). */
function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field));
}

/**
 * K-21 v1 `page` (a session token or null), or with `session` "required" its `signedInPage` (a session token, never
 * null): the two envelopes differ in that field alone.
 */
function pageProblems(
  page: unknown,
  problems: string[],
  session: "optional" | "required" = "optional",
): void {
  if (!isRecord(page)) {
    problems.push("page is not an object");
    return;
  }
  onlyFields("page", page, PAGE_FIELDS, problems);
  if (!isId(own(page, "requestId"))) problems.push("page.requestId is not an id");
  if (!isId(own(page, "traceId"))) problems.push("page.traceId is not a trace id");
  const sessionToken = own(page, "sessionToken");
  if (session === "required") {
    if (!hasLength(sessionToken, TOKEN_LENGTH)) problems.push("page.sessionToken is not a session token");
  } else if (sessionToken !== null && !hasLength(sessionToken, TOKEN_LENGTH))
    problems.push("page.sessionToken is not a session token or null");
  const linkCode = own(page, "linkCode");
  if (linkCode !== null && !(typeof linkCode === "string" && LINK_CODE.test(linkCode)))
    problems.push("page.linkCode is not a link code or null");
}

/** K-21 v1 `signInStart.request.account`'s oneOf: exactly one of the typed account and the link's. */
function accountProblems(account: unknown, problems: string[]): void {
  if (!isRecord(account)) {
    problems.push("account is not an object");
    return;
  }
  const from = own(account, "from");
  if (from === "typed") {
    const kind = own(account, "kind");
    const right =
      hasFields(account, TYPED_FIELDS) &&
      Object.keys(account).every((key) => (TYPED_FIELDS as readonly string[]).includes(key)) &&
      (kind === "mobile" || kind === "email") &&
      hasLength(own(account, "typed"), TYPED_LENGTH);
    if (!right) problems.push("account is not a typed mobile or email of 1 to 254 characters");
    return;
  }
  if (from === "link") {
    if (Object.keys(account).some((key) => !(LINK_FIELDS as readonly string[]).includes(key)))
      problems.push("account from link has a field K-21 v1 does not name");
    return;
  }
  problems.push("account is neither typed nor from the link");
}

/** Problems K-21 v1 finds in a `signInStart.request`; none when it is one. */
export function signInStartProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, START_FIELDS, problems);
  const page = own(request, "page");
  const account = own(request, "account");
  pageProblems(page, problems);
  accountProblems(account, problems);
  const way = own(request, "way");
  if (way !== "email" && way !== "text") problems.push("way is not email or text");
  if (!hasLength(own(request, "deviceToken"), TOKEN_LENGTH))
    problems.push("deviceToken is not a device token");
  // The schema's if and then: an account from the link needs the page's link code.
  if (
    isRecord(account) &&
    own(account, "from") === "link" &&
    isRecord(page) &&
    own(page, "linkCode") === null
  )
    problems.push("an account from the link needs page.linkCode");
  return problems;
}

/** Problems K-21 v1 finds in a `signInCheck.request`; none when it is one. */
export function signInCheckProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, CHECK_FIELDS, problems);
  pageProblems(own(request, "page"), problems);
  if (!isId(own(request, "attemptId"))) problems.push("attemptId is not an id");
  const code = own(request, "code");
  if (code !== null && !(typeof code === "string" && CODE.test(code)))
    problems.push("code is not 4 to 8 digits or null");
  if (!hasLength(own(request, "deviceToken"), TOKEN_LENGTH))
    problems.push("deviceToken is not a device token");
  return problems;
}

/** Problems K-21 v1 finds in a `signOut.request` (its page a `signedInPage`); none when it is one. */
export function signOutProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, SIGN_OUT_FIELDS, problems);
  pageProblems(own(request, "page"), problems, "required");
  return problems;
}

// ---- the contact, as K-05 v1.13's signInContact reads it --------------------------------------------------------------

/** K-05 v1.13 signInContact, with the text its keyed hash is made over (K-22 rule 9: the contact as normalized). */
export type ReadContact =
  | { readonly kind: "email"; readonly address: string; readonly hashed: string }
  | { readonly kind: "mobile"; readonly number: string; readonly hashed: string }
  | { readonly kind: "link"; readonly hashed: string };

/** K-05 v1.12 emailOnFile, as db/repo checks it (K-04 handles_address_form): one @, no space, lower case. */
const EMAIL_ON_FILE = /^[^@\sA-Z]+@[^@\sA-Z]+$/u;
/** K-05 v1 phoneNumber (K-04 phones_number_form): E.164. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;
/** The marks a person types inside a number: spaces, dots, dashes and brackets. */
const NUMBER_MARKS = /[\s().-]/gu;
/** A North American number typed with its ten digits, the area code first (default 4 in start.ts). */
const TEN_DIGITS = /^[2-9][0-9]{9}$/u;
/** The same with the country code 1 before it, and no +. */
const ELEVEN_DIGITS = /^1[2-9][0-9]{9}$/u;

/** A typed email as K-04 keeps an address: no space around it, in lower case; null when it is none. */
export function emailOf(typed: string): string | null {
  const address = typed.trim().toLowerCase();
  return EMAIL_ON_FILE.test(address) ? address : null;
}

/**
 * A typed mobile in E.164: with its + as typed, or ten digits (eleven starting with 1) read as a North American number;
 * the marks people type inside a number are dropped. Null when it is none of these.
 */
export function mobileOf(typed: string): string | null {
  const bare = typed.trim().replace(NUMBER_MARKS, "");
  if (E164.test(bare)) return bare;
  if (TEN_DIGITS.test(bare)) return `+1${bare}`;
  if (ELEVEN_DIGITS.test(bare)) return `+${bare}`;
  return null;
}

/**
 * The contact a start is counted by, or null when a typed one cannot be read: the typed email in lower case, the typed
 * mobile in E.164, or, for an account from the link, the page's link code as presented (K-22 default 15).
 */
export function contactOf(request: SignInStartRequest): ReadContact | null {
  const { account } = request;
  if (account.from === "link") {
    const { linkCode } = request.page;
    return linkCode === null ? null : { kind: "link", hashed: linkCode };
  }
  if (account.kind === "email") {
    const address = emailOf(account.typed);
    return address === null ? null : { kind: "email", address, hashed: address };
  }
  const number = mobileOf(account.typed);
  return number === null ? null : { kind: "mobile", number, hashed: number };
}
