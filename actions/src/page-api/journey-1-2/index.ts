// The journey 1 and 2 page calls (T-630; C-074; K-21 v1 README "The calls"): the K-21 v1 calls of the registration screens
// and the staff page, and of their uploads, Stripe and calendar steps, which the action layer serves for the sign-up
// journeys. Each names the folder of this one its task fills (T-665: registration/ and staff/; T-666: ports/) and, where
// K-21's "Served by" column names one, the journey 1 and 2 Tool API call behind it (../../tool-api/journey-1's registry),
// so a page's answer reaches the same call and step a chat's does.
//
// The page entry (runtime/src/gateway/pages, T-266) routes each call to the action layer's handler. Until its task builds
// it, each handler here rejects with the page entry's PageNotConnectedError before it reads the request, so the call
// answers 503 with its trace id and its span's error code notConnected, and nothing is read, written or sent: exactly as
// unconfiguredPages answers it today, so putting these handlers in the page entry changes no answer.
//
// K-21's other journey 1 calls are no task's of this folder: openLink, and codeStart and codeCheck (screens 6 and 7,
// served by K-09 v1 sendProofCode and proveCode, the shared core's calls).

import { PageNotConnectedError } from "../../../../runtime/src/gateway/pages/entry";
import type { PageCallName } from "../../../../runtime/src/gateway/pages/calls";
import type { PageHandler } from "../../../../runtime/src/gateway/pages/types";
import type { SetupCall, SetupStepId } from "../../tool-api/journey-1";

/** The folder of this one that a page call's task fills: T-665's registration/ and staff/, T-666's ports/. */
export type Journey12PageFolder = "registration" | "staff" | "ports";

/** One journey 1 and 2 page call: its K-21 v1 name, its folder, and the Tool API call behind it. */
export interface Journey12PageCall {
  readonly call: PageCallName;
  readonly folder: Journey12PageFolder;
  /**
   * The journey 1 and 2 Tool API call K-21's "Served by" names for it, with the step where it names one (null: the step of
   * the read-back the page's yes is bound to); null when K-21 serves it page-only or through a port.
   */
  readonly servedBy: { readonly call: SetupCall; readonly step: SetupStepId | null } | null;
}

/** The journey 1 and 2 page calls, in the order of K-21 v1's `$defs/callName`. */
export const JOURNEY_1_2_PAGE_CALLS = [
  { call: "readRegistration", folder: "registration", servedBy: { call: "readSetup", step: null } },
  { call: "answerOnPage", folder: "registration", servedBy: null },
  { call: "confirmOnPage", folder: "registration", servedBy: { call: "saveSetupStep", step: null } },
  { call: "signedUpload", folder: "ports", servedBy: null },
  { call: "finishUpload", folder: "ports", servedBy: { call: "saveSetupStep", step: "S1-10" } },
  { call: "stripeOnboardingStart", folder: "ports", servedBy: null },
  { call: "stripeOnboardingReturn", folder: "ports", servedBy: { call: "saveSetupStep", step: "S1-27" } },
  { call: "billCard", folder: "ports", servedBy: null },
  { call: "calendarConnectStart", folder: "ports", servedBy: null },
  { call: "calendarConnectReturn", folder: "ports", servedBy: { call: "saveSetupStep", step: "S1-24" } },
  { call: "readStaffPage", folder: "staff", servedBy: null },
] as const satisfies readonly Journey12PageCall[];

/** One of the journey 1 and 2 page calls. */
export type Journey12PageCallName = (typeof JOURNEY_1_2_PAGE_CALLS)[number]["call"];

/** Not built yet: rejects before it reads the request, so the page entry answers 503, notConnected, and does nothing. */
function notBuilt(call: Journey12PageCallName): PageHandler {
  return () => Promise.reject(new PageNotConnectedError(call));
}

/** Each journey 1 and 2 page call's handler, for the page entry's handlers; each refuses until its task builds it. */
export function journey12PageHandlers(): Readonly<Record<Journey12PageCallName, PageHandler>> {
  return {
    readRegistration: notBuilt("readRegistration"),
    answerOnPage: notBuilt("answerOnPage"),
    confirmOnPage: notBuilt("confirmOnPage"),
    signedUpload: notBuilt("signedUpload"),
    finishUpload: notBuilt("finishUpload"),
    stripeOnboardingStart: notBuilt("stripeOnboardingStart"),
    stripeOnboardingReturn: notBuilt("stripeOnboardingReturn"),
    billCard: notBuilt("billCard"),
    calendarConnectStart: notBuilt("calendarConnectStart"),
    calendarConnectReturn: notBuilt("calendarConnectReturn"),
    readStaffPage: notBuilt("readStaffPage"),
  };
}
