// K-21 v1's check on the listing's request (page-api.v1.schema.json `testRoster.request`: the signed-in page envelope and
// nothing else), written out by hand so it runs inside the Workers runtime, where no validator may be compiled at run
// time (workerd allows no eval or Function). request.test.ts holds it to Ajv's verdict on the schema itself. Lengths count
// characters as Ajv does (code points), and every pattern is the schema's own, with its u flag.
//
// A problem names a field, never a value: no token, id or field name from the request is copied into one.

import { isId, isRecord } from "../test-phone/request";

/** K-21 v1 `linkCode`. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/u;

/** K-21 v1 `opaqueToken`'s lengths. */
const TOKEN_LENGTH = { min: 16, max: 512 } as const;

const PAGE_FIELDS = ["requestId", "traceId", "sessionToken", "linkCode"] as const;
const REQUEST_FIELDS = ["page"] as const;

/** K-21 v1 `signedInPage`: the page envelope with a session. */
export interface SignedInPage {
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionToken: string;
  readonly linkCode: string | null;
}

/** K-21 v1 `testRoster.request`. */
export interface TestRosterRequest {
  readonly page: SignedInPage;
}

/** The object's own value for a field, never one it inherits. */
const own = (value: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(value, field) ? value[field] : undefined;

/** Characters as Ajv counts them for minLength and maxLength: code points (a surrogate pair is one). */
const lengthOf = (text: string): number => Array.from(text).length;

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
  const token = own(page, "sessionToken");
  if (!(
    typeof token === "string" &&
    lengthOf(token) >= TOKEN_LENGTH.min &&
    lengthOf(token) <= TOKEN_LENGTH.max
  ))
    problems.push("page.sessionToken is not a session token");
  const linkCode = own(page, "linkCode");
  if (linkCode !== null && !(typeof linkCode === "string" && LINK_CODE.test(linkCode)))
    problems.push("page.linkCode is not a link code or null");
}

/** Problems K-21 v1 finds in a `testRoster.request`; none when it is one. */
export function testRosterProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  onlyFields("the request", request, REQUEST_FIELDS, problems);
  pageProblems(own(request, "page"), problems);
  return problems;
}
