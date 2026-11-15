// The thread view's route (T-524; C-205; build prompt 9.4 "The test-phone page"; K-21 v1 testPhoneParts), made here
// with the request ids the Worker gives. routes.ts puts it behind the staging-only guard (T-522).
//
//   /staging/test-phone/parts  GET: K-21 v1 testPhoneParts for the test phone the address's `phone` field names by its
//                              roster id (as the send page's address does: send/page.ts), then the thread view
//                              (page.ts). Without a session cookie, the page that asks for sign-in first, with no call:
//                              the view sits behind the tester login (T-520).
//
// The route checks, in this order and before any call: the session cookie (none: sign in first); the chosen test phone
// (none: the page that says to choose one; a value that is no roster id: the same, 400). Then the one call, a read, its
// envelope holding a new request id, the page request's trace id, the session token and no link, with `since` null: all
// the doubles keep. Each answer K-21 v1 gives has its page: the parts (the thread view), stagingOnly (the guard's
// refused page), signInNeeded, notTester, notTestPhone and transient. A call that gives no outcome throws, as every
// page's does, and the shell answers its 500 page (client/client.ts). Nothing here logs: the shell's one line holds the
// trace id, the label and the status alone.

import { sessionTokenOf } from "../../../auth/cookies";
import { isPageError } from "../../../client/calls";
import type { RouteContext, ShellRoute } from "../../../shell/route";
import { isStagingOnlyRefusal, refusedPage } from "../../guard";
import { PHONE_FIELD, rosterIdOf } from "../send/page";
import {
  PARTS_PATH,
  WORDS,
  choosePage,
  notOnRosterPage,
  notTesterPage,
  partsPage,
  signInFirstPage,
  tryAgainPage,
} from "./page";

/** What the route takes from outside, replaceable in a test. */
export interface PartsDeps {
  /** Makes a call's request id (K-21 v1 page.requestId: once per call, never reused); a random UUID when left out. */
  newRequestId?: () => string;
}

/** The thread view's route (see the top of this file). */
export function testPhonePartsRoutes(deps: PartsDeps = {}): ShellRoute[] {
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());

  const open = async (context: RouteContext): Promise<Response> => {
    const { config, request, url } = context;
    const sessionToken = sessionTokenOf(request, config);
    if (sessionToken === null) return context.page(signInFirstPage(config, false));
    const phone = rosterIdOf(url.searchParams.get(PHONE_FIELD));
    if (phone === null) return context.page(choosePage(config, null));
    if (phone === false) return context.page(choosePage(config, { words: WORDS.badPhone, status: 400 }));

    const outcome = await context.client.call("testPhoneParts", {
      page: context.envelope({ requestId: newRequestId(), sessionToken, linkCode: null }),
      testPhoneId: phone,
      since: null,
    });

    // The server is not on staging: shown as refused, never as a phone's texts (T-522).
    if (isStagingOnlyRefusal(outcome)) return refusedPage(context);
    if (isPageError(outcome)) {
      switch (outcome.error) {
        case "signInNeeded":
          return context.page(signInFirstPage(config, true));
        case "notTester":
          return context.page(notTesterPage(config));
        case "notTestPhone":
          return context.page(notOnRosterPage(config, outcome.testPhoneId));
        case "transient":
          return context.page(tryAgainPage(config, phone));
      }
    }
    return context.page(partsPage(config, phone, outcome));
  };

  return [{ label: "testPhone.parts", path: PARTS_PATH, methods: ["GET"], handle: open }];
}
