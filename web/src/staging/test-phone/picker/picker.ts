// The picker's route (T-525; C-205; build prompt 9.4 "Seeded state"; K-21 v1 testRoster), made here with the request
// ids the Worker gives. routes.ts puts it behind the staging-only guard (T-522).
//
//   /staging/test-phone/phones  GET: K-21 v1 testRoster, then the picker (page.ts), which links each test phone to the
//                               test-phone page with that phone chosen. Without a session cookie, the page that asks
//                               for sign-in first, with no call: the picker sits behind the tester login (T-520).
//
// Opening the page makes the one call, a read, its envelope holding a new request id, the page request's trace id, the
// session token and no link; nothing of the address's query is read. Each answer K-21 v1 gives has its page: the
// roster (the picker), stagingOnly (the guard's refused page), signInNeeded, notTester and transient. A call that gives
// no outcome throws, as every page's does, and the shell answers its 500 page (client/client.ts). Nothing here logs:
// the shell's one line holds the trace id, the label and the status alone.

import { sessionTokenOf } from "../../../auth/cookies";
import { isPageError } from "../../../client/calls";
import type { RouteContext, ShellRoute } from "../../../shell/route";
import { isStagingOnlyRefusal, refusedPage } from "../../guard";
import { PICKER_PATH, notTesterPage, pickerPage, signInFirstPage, tryAgainPage } from "./page";

/** What the route takes from outside, replaceable in a test. */
export interface PickerDeps {
  /** Makes a call's request id (K-21 v1 page.requestId: once per call, never reused); a random UUID when left out. */
  newRequestId?: () => string;
}

/** The picker's route (see the top of this file). */
export function testPhonePickerRoutes(deps: PickerDeps = {}): ShellRoute[] {
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());

  const open = async (context: RouteContext): Promise<Response> => {
    const { config, request } = context;
    const sessionToken = sessionTokenOf(request, config);
    if (sessionToken === null) return context.page(signInFirstPage(config, false));

    const outcome = await context.client.call("testRoster", {
      page: context.envelope({ requestId: newRequestId(), sessionToken, linkCode: null }),
    });

    // The server is not on staging: shown as refused, never as a list (T-522).
    if (isStagingOnlyRefusal(outcome)) return refusedPage(context);
    if (isPageError(outcome)) {
      switch (outcome.error) {
        case "signInNeeded":
          return context.page(signInFirstPage(config, true));
        case "notTester":
          return context.page(notTesterPage(config));
        case "transient":
          return context.page(tryAgainPage(config));
      }
    }
    return context.page(pickerPage(config, outcome));
  };

  return [{ label: "testPhone.phones", path: PICKER_PATH, methods: ["GET"], handle: open }];
}
