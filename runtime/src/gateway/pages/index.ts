// The page entry (T-266; C-044): the web app's K-21 v1 page and console calls under BASE_PATH, routed to the action
// layer's handlers (C-074) under a trace opened per request, the staging-only calls refused outside staging, a body over
// its cap refused before it is read whole, and only K-21 v1's error names in its span (T-1180). See entry.ts for the order
// of one call, calls.ts for the routes and errors.ts for the error names.

import { PageNotConnectedError } from "./entry";
import type { PageCallName } from "./calls";
import type { PageHandler, PageHandlers } from "./types";

export {
  PAGE_API_PATH,
  PAGE_CALLS,
  STAGING_ONLY_CALLS,
  isPageCall,
  isStagingOnly,
  pagePathOf,
  pageRouteOf,
  type PageCallName,
} from "./calls";
export { PAGE_ERRORS, UNKNOWN_PAGE_ERROR, isPageError, type PageErrorName } from "./errors";
export { PageNotConnectedError, STAGING_ONLY_OUTCOME, handlePageCall } from "./entry";
export type { PageDeps, PageHandler, PageHandlers, PageOutcome, PageRequest } from "./types";

/**
 * The handler stubs until the action layer's page entry (C-074) joins each call: every one answers by failing, so its
 * call answers 503 with a trace id and does nothing. The staging-only calls are refused outside staging before any
 * handler runs, joined or not.
 */
export function unconfiguredPages(): PageHandlers {
  const notYet =
    (call: PageCallName): PageHandler =>
    () =>
      Promise.reject(new PageNotConnectedError(call));
  return {
    openLink: notYet("openLink"),
    signInStart: notYet("signInStart"),
    signInCheck: notYet("signInCheck"),
    signOut: notYet("signOut"),
    codeStart: notYet("codeStart"),
    codeCheck: notYet("codeCheck"),
    readRegistration: notYet("readRegistration"),
    answerOnPage: notYet("answerOnPage"),
    confirmOnPage: notYet("confirmOnPage"),
    signedUpload: notYet("signedUpload"),
    finishUpload: notYet("finishUpload"),
    stripeOnboardingStart: notYet("stripeOnboardingStart"),
    stripeOnboardingReturn: notYet("stripeOnboardingReturn"),
    billCard: notYet("billCard"),
    calendarConnectStart: notYet("calendarConnectStart"),
    calendarConnectReturn: notYet("calendarConnectReturn"),
    readStaffPage: notYet("readStaffPage"),
    teamConsole: notYet("teamConsole"),
    teamAcknowledgePage: notYet("teamAcknowledgePage"),
    teamDecideReviewItem: notYet("teamDecideReviewItem"),
    testRoster: notYet("testRoster"),
    testPhoneSend: notYet("testPhoneSend"),
    testPhoneParts: notYet("testPhoneParts"),
    testClockRows: notYet("testClockRows"),
    fireNow: notYet("fireNow"),
    textHoursOverride: notYet("textHoursOverride"),
  };
}
