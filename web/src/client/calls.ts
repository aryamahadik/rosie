// The page and console calls the web app makes (T-511; C-185; K-21 v1): every call's name, and each call's request,
// outcome, response and errors as K-21 v1 defines them, from its generated module (`npm run contracts:types`; ADR-005:
// generated into contracts/generated/, never committed).
//
// Each type is read off the call's exchange in K-21 v1's root, by its call, never by a generated name: the generator
// numbers the later copies of a title, and those numbers shift between generations (DL-350). The types are imported as
// types only, so nothing here loads the generated module at run time.
//
// The path is the page entry's (runtime/src/gateway/pages/calls.ts): POST {BASE_PATH}/page-api/<call>, the contract's
// name and the call's own, so one name serves the contract, its fixtures, the Tool API mock (C-186) and the route.
// K-21's later minor versions (v1.1's booking page and listing, v1.2's customer screens) bring their calls with their
// journey lanes.

import type * as K21 from "../../../contracts/generated/page-api/page-api.v1";

/** Every call K-21 v1 holds, in the order of `$defs/callName` (client.test.ts holds this list to the schema's). */
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
] as const satisfies readonly K21.PageApiV1["call"][];

export type PageCall = (typeof PAGE_CALLS)[number];

/** The prefix, under BASE_PATH, of every call's path: {BASE_PATH}/page-api/<call>. */
export const PAGE_API_PATH = "/page-api";

/** One call's exchange in K-21 v1: its request paired with its outcome (what every fixture is). */
export type ExchangeOf<C extends PageCall> = Extract<K21.PageApiV1, { call: C }>;

/** K-21 v1 `$defs/<call>.request`. */
export type RequestOf<C extends PageCall> = ExchangeOf<C>["request"];

/** What a call answers: its response, or one of its errors. */
export type OutcomeOf<C extends PageCall> = ExchangeOf<C>["outcome"];

/** K-21 v1 `$defs/<call>.errors`: each an object with its own `error` (02-contracts section 2 item 2). */
export type ErrorOf<C extends PageCall> = Extract<OutcomeOf<C>, { error: string }>;

/** K-21 v1 `$defs/<call>.response`: no response has an `error`. */
export type ResponseOf<C extends PageCall> = Exclude<OutcomeOf<C>, { error: string }>;

// A set, so a name such as "constructor" is never taken for a call.
const CALLS: ReadonlySet<string> = new Set(PAGE_CALLS);

/** True when `name` is a call of K-21 v1, by its exact spelling. */
export function isPageCall(name: unknown): name is PageCall {
  return typeof name === "string" && CALLS.has(name);
}

/** One call's path under BASE_PATH. */
export function pagePathOf(call: PageCall): string {
  return `${PAGE_API_PATH}/${call}`;
}

/** True when an outcome is one of its call's errors, not its response. */
export function isPageError<O extends object>(outcome: O): outcome is Extract<O, { error: string }> {
  return Object.hasOwn(outcome, "error");
}

/**
 * What every K-21 request carries beside its own fields (K-21 v1 `$defs/page`): the page's own id for this submit, the
 * trace the page request opened, the session cookie's value and the link the page was opened from. A call whose
 * envelope needs the link or the session (`$defs/linkPage`, `$defs/signedInPage`) gets it by the type it is given.
 */
export interface PageEnvelope<
  Session extends string | null = string | null,
  Link extends string | null = string | null,
> {
  requestId: string;
  traceId: string;
  sessionToken: Session;
  linkCode: Link;
}

/** The envelope's parts a page gives; the trace id is the page request's own (shell/trace.ts). */
export type EnvelopeParts<Session extends string | null, Link extends string | null> = Omit<
  PageEnvelope<Session, Link>,
  "traceId"
>;

/** A call's envelope under the page request's trace id, so the page and its calls share one trace (K-08 v1). */
export function envelopeOf<Session extends string | null, Link extends string | null>(
  traceId: string,
  parts: EnvelopeParts<Session, Link>,
): PageEnvelope<Session, Link> {
  return {
    requestId: parts.requestId,
    traceId,
    sessionToken: parts.sessionToken,
    linkCode: parts.linkCode,
  };
}
