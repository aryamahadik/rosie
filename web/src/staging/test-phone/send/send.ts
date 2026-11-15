// The test-phone page's routes (T-523; C-205; build prompt 9.4 "The test-phone page"; K-21 v1 testPhoneSend), made here
// with the request ids the Worker gives. routes.ts puts them behind the staging-only guard (T-522).
//
//   /staging/test-phone       GET: the page (page.ts), for the phone the address names. Without a session cookie, the
//                             page that asks for sign-in first: the page sits behind the tester login (T-520).
//   /staging/test-phone/send  POST: K-21 v1 testPhoneSend, as the chosen test phone, with the typed text. The server
//                             builds the event, the Linq double signs it and the gateway takes it (T-565); the page
//                             shows the answer's trace id.
// Opening the page makes no call. The send route checks, in this order and before any call: the session cookie (none:
// sign in first); the form as the page sent it (its request id); a chosen test phone (none, or a value that is no
// roster id: nothing is sent and the page comes back with send disabled); the text (not blank, at most 10,000
// characters); the message it replies under (empty, or a message id). Then the one call, its envelope holding the
// form's request id, the page request's trace id, the session token and no link. Each answer K-21 v1 gives has its
// page: sent, stagingOnly (the guard's refused page), signInNeeded, notTester, notTestPhone and transient. A call that
// gives no outcome throws, as every page's does, and the shell answers its 500 page (client/client.ts).
//
// The text goes as typed, with one change: a form sends each line break as CR LF (HTML's form submission), so each is
// read back as the LF that was typed. Nothing here logs: the shell's one line holds the trace id, the label and the
// status alone.

import { sessionTokenOf } from "../../../auth/cookies";
import type { Problem } from "../../../auth/pages";
import { isPageError } from "../../../client/calls";
import type { RouteContext, ShellRoute } from "../../../shell/route";
import { isStagingOnlyRefusal, refusedPage } from "../../guard";
import {
  PHONE_FIELD,
  REPLY_FIELD,
  REQUEST_FIELD,
  SEND_PATH,
  TEST_PHONE_PATH,
  WORDS,
  WORDS_FIELD,
  WORDS_MAX,
  messageIdOf,
  notOnRoster,
  notTesterPage,
  rosterIdOf,
  signInFirstPage,
  testPhonePage,
  type TestPhoneView,
} from "./page";

/** What the routes take from outside, replaceable in a test. */
export interface SendDeps {
  /** Makes a form's request id (K-21 v1 page.requestId: once per form, never reused); a random UUID when left out. */
  newRequestId?: () => string;
}

/** A request id as a form may carry it back (as the sign-in forms', auth/sign-in.ts). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

const FORM_TYPE = "application/x-www-form-urlencoded";

/** The form a page posted, or null when the body is not a form's. The shell has already held it to its cap. */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === FORM_TYPE ? new URLSearchParams(await request.text()) : null;
}

/** The text as it was typed: the CR LF (or lone CR) a form sends for a line break, read back as LF. */
function asTyped(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

/** Characters as K-21 counts them (JSON Schema's maxLength: code points, a surrogate pair is one). */
function lengthOf(text: string): number {
  return Array.from(text).length;
}

/** The two routes of the test-phone page's send side (see the top of this file). */
export function testPhoneSendRoutes(deps: SendDeps = {}): ShellRoute[] {
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());

  /** The test-phone page, its send form under a new request id. */
  const pageOf = (context: RouteContext, view: Omit<TestPhoneView, "requestId">): Response =>
    context.page(testPhonePage(context.config, { ...view, requestId: newRequestId() }));

  const open = (context: RouteContext): Response => {
    const { config, request, url } = context;
    if (sessionTokenOf(request, config) === null) return context.page(signInFirstPage(config, false));
    const phone = rosterIdOf(url.searchParams.get(PHONE_FIELD));
    const reply = messageIdOf(url.searchParams.get(REPLY_FIELD));
    let problem: Problem | null = null;
    if (phone === false) problem = { words: WORDS.badPhone, status: 400 };
    else if (reply === false) problem = { words: WORDS.badReply, status: 400 };
    return pageOf(context, {
      testPhoneId: typeof phone === "string" ? phone : null,
      replyTo: typeof reply === "string" ? reply : "",
      words: "",
      sent: null,
      problem,
    });
  };

  const send = async (context: RouteContext): Promise<Response> => {
    const { config, request } = context;
    const sessionToken = sessionTokenOf(request, config);
    if (sessionToken === null) return context.page(signInFirstPage(config, true));

    const form = await readForm(request);
    const requestId = form?.get(REQUEST_FIELD) ?? "";
    const phone = rosterIdOf(form?.get(PHONE_FIELD) ?? null);
    const words = asTyped(form?.get(WORDS_FIELD) ?? "");
    const reply = (form?.get(REPLY_FIELD) ?? "").trim();
    /** The page again, with what was typed kept, the problem on top and nothing sent. */
    const again = (problem: Problem): Response =>
      pageOf(context, {
        testPhoneId: typeof phone === "string" ? phone : null,
        replyTo: reply,
        words,
        sent: null,
        problem,
      });

    if (form === null || !REQUEST_ID.test(requestId)) return again({ words: WORDS.badForm, status: 400 });
    if (phone === null) return again({ words: WORDS.noPhone, status: 400 });
    if (phone === false) return again({ words: WORDS.badPhone, status: 400 });
    if (words.trim() === "") return again({ words: WORDS.noWords, status: 400 });
    if (lengthOf(words) > WORDS_MAX) return again({ words: WORDS.tooLong, status: 400 });
    const threadedReplyTo = messageIdOf(reply);
    if (threadedReplyTo === false) return again({ words: WORDS.badReply, status: 400 });

    const outcome = await context.client.call("testPhoneSend", {
      page: context.envelope({ requestId, sessionToken, linkCode: null }),
      testPhoneId: phone,
      words,
      threadedReplyTo,
    });

    // The server is not on staging: shown as refused, never as sent (T-522).
    if (isStagingOnlyRefusal(outcome)) return refusedPage(context);
    if (isPageError(outcome)) {
      switch (outcome.error) {
        case "signInNeeded":
          return context.page(signInFirstPage(config, true));
        case "notTester":
          return context.page(notTesterPage(config));
        case "notTestPhone":
          return pageOf(context, {
            testPhoneId: null,
            replyTo: "",
            words: "",
            sent: null,
            problem: notOnRoster(outcome.testPhoneId),
          });
        case "transient":
          return again({ words: WORDS.tryAgain, status: 503 });
      }
    }
    return pageOf(context, {
      testPhoneId: phone,
      replyTo: "",
      words: "",
      sent: { testPhoneId: phone, words, threadedReplyTo, answer: outcome },
      problem: null,
    });
  };

  return [
    { label: "testPhone.page", path: TEST_PHONE_PATH, methods: ["GET"], handle: open },
    { label: "testPhone.send", path: SEND_PATH, methods: ["POST"], handle: send },
  ];
}
