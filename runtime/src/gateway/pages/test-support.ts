// Doubles and fixtures for the page entry's tests (T-266). Not imported by the Worker.
//
// Every K-21 v1 fixture, accepted and refused, as contracts/page-api/fixtures/index.json lists it: each file is imported
// here by name (a Workers test cannot read files), and v1Fixtures() reads them in the index's order, failing loudly when
// the index lists a v1 file this table lacks or the table holds one the index does not list as v1.

import { vi } from "vitest";

import answerFromPage from "../../../../contracts/page-api/fixtures/answer-from-page.json";
import billCardSetup from "../../../../contracts/page-api/fixtures/bill-card-setup.json";
import calendarConnectReturn from "../../../../contracts/page-api/fixtures/calendar-connect-return.json";
import calendarConnectStart from "../../../../contracts/page-api/fixtures/calendar-connect-start.json";
import emailCheckOnPage from "../../../../contracts/page-api/fixtures/email-check-on-page.json";
import emailCodeOnPage from "../../../../contracts/page-api/fixtures/email-code-on-page.json";
import feeConsentOk from "../../../../contracts/page-api/fixtures/fee-consent-ok.json";
import fireNowInProduction from "../../../../contracts/page-api/fixtures/fire-now-in-production.json";
import fireNow from "../../../../contracts/page-api/fixtures/fire-now.json";
import goLive from "../../../../contracts/page-api/fixtures/go-live.json";
import index from "../../../../contracts/page-api/fixtures/index.json";
import refuseAlreadySignedInWithToken from "../../../../contracts/page-api/fixtures/invalid/refuse-already-signed-in-with-token.json";
import refuseFireNowInProduction from "../../../../contracts/page-api/fixtures/invalid/refuse-fire-now-in-production.json";
import refuseLinkAsProof from "../../../../contracts/page-api/fixtures/invalid/refuse-link-as-proof.json";
import refuseSignInNamesPerson from "../../../../contracts/page-api/fixtures/invalid/refuse-sign-in-names-person.json";
import refuseTestRosterInProduction from "../../../../contracts/page-api/fixtures/invalid/refuse-test-roster-in-production.json";
import refuseYesWithoutSession from "../../../../contracts/page-api/fixtures/invalid/refuse-yes-without-session.json";
import openLinkExpired from "../../../../contracts/page-api/fixtures/open-link-expired.json";
import openLinkSecurePage from "../../../../contracts/page-api/fixtures/open-link-secure-page.json";
import openLinkSignedIn from "../../../../contracts/page-api/fixtures/open-link-signed-in.json";
import registrationPreviewSummary from "../../../../contracts/page-api/fixtures/registration-preview-summary.json";
import registrationWhatIsMissing from "../../../../contracts/page-api/fixtures/registration-what-is-missing.json";
import signInAlreadySignedIn from "../../../../contracts/page-api/fixtures/sign-in-already-signed-in.json";
import signInDone from "../../../../contracts/page-api/fixtures/sign-in-done.json";
import signInFromLinkByText from "../../../../contracts/page-api/fixtures/sign-in-from-link-by-text.json";
import signInRequest from "../../../../contracts/page-api/fixtures/sign-in-request.json";
import signInWrongFive from "../../../../contracts/page-api/fixtures/sign-in-wrong-five.json";
import signOut from "../../../../contracts/page-api/fixtures/sign-out.json";
import staffPage from "../../../../contracts/page-api/fixtures/staff-page.json";
import stripeOnboardingLink from "../../../../contracts/page-api/fixtures/stripe-onboarding-link.json";
import stripeOnboardingReturn from "../../../../contracts/page-api/fixtures/stripe-onboarding-return.json";
import teamConsolePages from "../../../../contracts/page-api/fixtures/team-console-pages.json";
import teamPageAcknowledge from "../../../../contracts/page-api/fixtures/team-page-acknowledge.json";
import teamReviewDecide from "../../../../contracts/page-api/fixtures/team-review-decide.json";
import testClockRows from "../../../../contracts/page-api/fixtures/test-clock-rows.json";
import testPhoneParts from "../../../../contracts/page-api/fixtures/test-phone-parts.json";
import testPhoneSend from "../../../../contracts/page-api/fixtures/test-phone-send.json";
import testRoster from "../../../../contracts/page-api/fixtures/test-roster.json";
import textHoursOverrideClear from "../../../../contracts/page-api/fixtures/text-hours-override-clear.json";
import textHoursOverride from "../../../../contracts/page-api/fixtures/text-hours-override.json";
import uploadIdDocument from "../../../../contracts/page-api/fixtures/upload-id-document.json";
import uploadIdFinished from "../../../../contracts/page-api/fixtures/upload-id-finished.json";
import { isPageCall, PAGE_CALLS, type PageCallName } from "./calls";
import type { PageHandler, PageHandlers, PageOutcome, PageRequest } from "./types";

/** Every K-21 v1 fixture file, by the name index.json gives it. */
const V1_FILES: Readonly<Record<string, unknown>> = {
  "open-link-secure-page.json": openLinkSecurePage,
  "open-link-signed-in.json": openLinkSignedIn,
  "open-link-expired.json": openLinkExpired,
  "sign-in-request.json": signInRequest,
  "sign-in-from-link-by-text.json": signInFromLinkByText,
  "sign-in-done.json": signInDone,
  "sign-in-wrong-five.json": signInWrongFive,
  "sign-out.json": signOut,
  "email-check-on-page.json": emailCheckOnPage,
  "email-code-on-page.json": emailCodeOnPage,
  "registration-what-is-missing.json": registrationWhatIsMissing,
  "answer-from-page.json": answerFromPage,
  "fee-consent-ok.json": feeConsentOk,
  "go-live.json": goLive,
  "upload-id-document.json": uploadIdDocument,
  "upload-id-finished.json": uploadIdFinished,
  "stripe-onboarding-link.json": stripeOnboardingLink,
  "stripe-onboarding-return.json": stripeOnboardingReturn,
  "bill-card-setup.json": billCardSetup,
  "calendar-connect-start.json": calendarConnectStart,
  "calendar-connect-return.json": calendarConnectReturn,
  "staff-page.json": staffPage,
  "team-console-pages.json": teamConsolePages,
  "team-page-acknowledge.json": teamPageAcknowledge,
  "team-review-decide.json": teamReviewDecide,
  "test-roster.json": testRoster,
  "test-phone-send.json": testPhoneSend,
  "test-phone-parts.json": testPhoneParts,
  "test-clock-rows.json": testClockRows,
  "fire-now.json": fireNow,
  "fire-now-in-production.json": fireNowInProduction,
  "text-hours-override.json": textHoursOverride,
  "sign-in-already-signed-in.json": signInAlreadySignedIn,
  "registration-preview-summary.json": registrationPreviewSummary,
  "text-hours-override-clear.json": textHoursOverrideClear,
  "invalid/refuse-fire-now-in-production.json": refuseFireNowInProduction,
  "invalid/refuse-link-as-proof.json": refuseLinkAsProof,
  "invalid/refuse-test-roster-in-production.json": refuseTestRosterInProduction,
  "invalid/refuse-sign-in-names-person.json": refuseSignInNamesPerson,
  "invalid/refuse-yes-without-session.json": refuseYesWithoutSession,
  "invalid/refuse-already-signed-in-with-token.json": refuseAlreadySignedInWithToken,
};

/** One K-21 v1 fixture as the page entry's tests post it. */
export interface V1Fixture {
  /** Its name in index.json. */
  file: string;
  /** Accepted or refused by the schema (index.json `expect`). */
  expect: "accept" | "refuse";
  /** The call it is for: an exchange's `call`, or a refused request's definition (`<call>.request`). */
  call: PageCallName;
  /** The environment its `given` names; a bare request names none and is posted on staging. */
  environment: "staging" | "production";
  /** The request as the web app sends it. */
  request: Record<string, unknown>;
  /** An exchange's outcome; undefined for a bare request. */
  outcome: PageOutcome | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(file: string, why: string): never {
  throw new Error(`K-21 v1 fixture ${file}: ${why}`);
}

/** Every v1 fixture in index.json's order; throws when the index and this file's table differ. */
export function v1Fixtures(): V1Fixture[] {
  const entries = index.fixtures.filter((entry) => entry.version === "v1");
  const listed = new Set(entries.map((entry) => entry.file));
  for (const file of Object.keys(V1_FILES)) {
    if (!listed.has(file)) fail(file, "the table holds it, but index.json lists no such v1 fixture");
  }
  return entries.map((entry): V1Fixture => {
    const json = V1_FILES[entry.file];
    if (!isRecord(json)) return fail(entry.file, "index.json lists it, but the table does not hold it");
    if (entry.expect !== "accept" && entry.expect !== "refuse") return fail(entry.file, "expect is neither");
    const exchange = entry.def.endsWith(".exchange");
    const call = exchange ? json.call : entry.def.split(".")[0];
    if (typeof call !== "string" || !isPageCall(call)) return fail(entry.file, "names no call of K-21 v1");
    const request = exchange ? json.request : json;
    if (!isRecord(request)) return fail(entry.file, "has no request object");
    const given = exchange ? json.given : undefined;
    const environment = isRecord(given) ? given.environment : "staging";
    if (environment !== "staging" && environment !== "production") {
      return fail(entry.file, "names no environment the page runs in");
    }
    const outcome = exchange ? json.outcome : undefined;
    if (exchange && !isRecord(outcome)) return fail(entry.file, "has no outcome object");
    return {
      file: entry.file,
      expect: entry.expect,
      call,
      environment,
      request,
      outcome: isRecord(outcome) ? outcome : undefined,
    };
  });
}

/** What one handler stub was given: the call, the request, the trace's id and opener, and the environment. */
export interface StubCall {
  call: PageCallName;
  request: Readonly<Record<string, unknown>>;
  traceId: string;
  openedBy: string;
  environment: string;
}

export interface RecordingPages {
  handlers: PageHandlers;
  /** Every call any stub was given, in order. */
  readonly calls: StubCall[];
}

/** A handler stub for every call: each records what it was given, then answers as `answer` says (by default, `{ result: "stub" }`). */
export function recordingPages(
  answer: (page: PageRequest) => Promise<PageOutcome> = () => Promise.resolve({ result: "stub" }),
): RecordingPages {
  const calls: StubCall[] = [];
  const stub = (call: PageCallName): PageHandler => {
    return (page) => {
      calls.push({
        call,
        request: page.request,
        traceId: page.trace.traceId,
        openedBy: page.trace.openedBy,
        environment: page.environment,
      });
      return answer(page);
    };
  };
  const handlers = Object.fromEntries(PAGE_CALLS.map((call) => [call, stub(call)])) as Record<
    PageCallName,
    PageHandler
  >;
  return { handlers, calls };
}

/** Starts capturing console.log; the returned function gives the JSON log lines written so far. */
export function captureLogLines(): () => Record<string, unknown>[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

/** The pageRequest spans among the log lines. */
export function pageSpans(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line.msg === "span" && line.hop === "pageRequest");
}

/** A POST to `path` with `body` (JSON for an object, else as given) and, when given, an x-trace-id. */
export function pagePost(
  path: string,
  body: unknown,
  options: { traceId?: string; method?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.traceId !== undefined) headers.set("x-trace-id", options.traceId);
  const method = options.method ?? "POST";
  const sendsBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://rosie.test${path}`, {
    method,
    headers,
    ...(sendsBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

/** Every string in a value, at any depth: what must never reach a log line. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (isRecord(value)) return Object.values(value).flatMap(stringsOf);
  return [];
}
