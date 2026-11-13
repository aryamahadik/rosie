// Sign-in by code for owners, admins, staff, Rosie's team and staging's testers (T-520; C-193; FS section 8; S11-52;
// S13-45; K-21 v1 signInStart, signInCheck and signOut). They all sign in the same way (K-21 v1 README, "Sign-in and
// sessions"; QUESTIONS w1-qa-web 5: the tester login is K-21's sign-in), and there is no password anywhere.
//
// Three routes, each a form posted to this site and answered with the next page (pages.ts); no script runs:
//   /sign-in        GET: the form that starts a sign-in, the portal's or (with ?link=<code>) a signed link's own.
//                   POST: signInStart. The page then names the way the code went as the answer gives it.
//   /sign-in/check  POST: signInCheck, with the code typed back (email way) or asking whether the ready text came (text
//                   way). A right code sets the session cookie and shows the consoles the person's roles open.
//   /sign-out       GET: the button. POST: signOut, and the session cookie is cleared.
// Sending the code is the action layer's; these pages only make the K-21 calls.
//
// The pause (FS section 8: five wrong codes pause sign-in for 15 minutes): when signInCheck answers paused, the page
// shows the pause, holds no form that checks a code, and keeps the pause's end with its attempt in a cookie
// (cookies.ts). Any later check of that attempt before the end, from a page reloaded, gone back to or kept open,
// gets the pause page again and no call is made. The server's own answer set the pause, and its end is the server's.
//
// What never happens here: a typed mobile, email or code is never shown back, logged or kept; a request never names
// who anyone is (the envelope carries the session token and the link code alone); and a value from the browser (a
// form field, a cookie, a query) is used only after it reads as its kind.

import { isPageError } from "../client/calls";
import type { RouteContext, RoutePage, ShellRoute } from "../shell/route";
import { consolesFor, signedInAs } from "./consoles";
import {
  clearedCookie,
  cookieNames,
  deviceCookie,
  deviceTokenOf,
  instantOf,
  newDeviceToken,
  pauseCookie,
  pauseOf,
  sessionCookie,
  sessionTokenOf,
} from "./cookies";
import {
  BAD_FORM,
  SIGN_IN_CHECK_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  TRY_AGAIN,
  codePage,
  notePage,
  pausedPage,
  signOutPage,
  signedInPage,
  startHref,
  startPage,
  textPage,
  waitingPage,
  type Attempt,
  type Problem,
} from "./pages";

/** What the routes take from outside, each replaceable in a test. */
export interface SignInDeps {
  /** The time now; the clock's when left out. */
  now?: () => Date;
  /** Makes a form's request id (K-21 v1 `page.requestId`: once per form, never reused); a random UUID when left out. */
  newRequestId?: () => string;
  /** Makes a browser's device token; 256 random bits when left out. */
  newDeviceToken?: () => string;
}

/** A request id as a form may carry it back. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** An attempt id as a form may carry it back: K-21's ids are opaque, so any visible characters, held to a length. */
const ATTEMPT_ID = /^[\x21-\x7E]{1,256}$/;
/** K-21 v1 `$defs/linkCode`, the same letters shell/config.ts linkUrl takes. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/;
/** K-21 v1 signInCheck.code. */
const CODE = /^[0-9]{4,8}$/;
/** K-21 v1 signInStart.account.typed's longest. */
const TYPED_MAX = 254;

const FORM_TYPE = "application/x-www-form-urlencoded";

/** The form a page posted, or null when the body is not a form's. The shell has already held it to its cap. */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === FORM_TYPE ? new URLSearchParams(await request.text()) : null;
}

/** The link code a form or an address carries: none (null), or one that reads as a code; false for anything else. */
function linkOf(raw: string | null): string | null | false {
  if (raw === null || raw === "") return null;
  return LINK_CODE.test(raw) ? raw : false;
}

const wayOf = (raw: string | null): "email" | "text" | null =>
  raw === "email" || raw === "text" ? raw : null;

/**
 * A 303 to the form that starts a sign-in: its path under BASE_PATH, never a host. It is a page of the shell's own
 * (its headers, the frame), holding the same address as a link.
 */
function seeSignIn(context: RouteContext): Response {
  const response = context.page(
    notePage(context.config, {
      title: "Sign in",
      lines: [],
      link: null,
      again: "Go to sign-in",
      status: 303,
    }),
  );
  response.headers.set("location", startHref(context.config, null));
  return response;
}

/** The routes of web/src/auth (see the top of this file). */
export function signInRoutes(deps: SignInDeps = {}): readonly ShellRoute[] {
  const now = deps.now ?? ((): Date => new Date());
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());
  const makeDeviceToken = deps.newDeviceToken ?? newDeviceToken;

  /** The answer for a page, with the browser's device cookie set when it had none. */
  const withDevice = (context: RouteContext, page: RoutePage, made: string | null): Response => {
    const response = context.page(page);
    if (made !== null) response.headers.append("set-cookie", deviceCookie(made, context.config));
    return response;
  };

  const startForm = (context: RouteContext): Response => {
    const link = linkOf(context.url.searchParams.get("link"));
    if (link === false) return context.notFound();
    const made = deviceTokenOf(context.request, context.config) === null ? makeDeviceToken() : null;
    return withDevice(context, startPage(context.config, { requestId: newRequestId(), link }), made);
  };

  const start = async (context: RouteContext): Promise<Response> => {
    const { config, request } = context;
    const refused = (words: string, link: string | null = null): Response =>
      context.page(startPage(config, { requestId: newRequestId(), link }, { words, status: 400 }));

    const form = await readForm(request);
    if (form === null) return refused(BAD_FORM);
    const requestId = form.get("requestId") ?? "";
    const way = wayOf(form.get("way"));
    const link = linkOf(form.get("link"));
    if (!REQUEST_ID.test(requestId) || way === null || link === false) return refused(BAD_FORM);
    const typed = (form.get("account") ?? "").trim();
    if (link === null && (typed === "" || typed.length > TYPED_MAX))
      return refused("Type the mobile number or email on file for your account.");

    const had = deviceTokenOf(request, config);
    const deviceToken = had ?? makeDeviceToken();
    const outcome = await context.client.call("signInStart", {
      page: context.envelope({ requestId, sessionToken: null, linkCode: link }),
      account:
        link === null
          ? { from: "typed", kind: typed.includes("@") ? "email" : "mobile", typed }
          : { from: "link" },
      way,
      deviceToken,
    });
    const made = had === null ? deviceToken : null;

    if (isPageError(outcome)) {
      if (outcome.error === "paused")
        return withDevice(
          context,
          pausedPage(config, { until: instantOf(outcome.until), now: now(), link, fiveWrong: false }),
          made,
        );
      return withDevice(
        context,
        startPage(config, { requestId: newRequestId(), link }, { words: TRY_AGAIN, status: 503 }),
        made,
      );
    }
    // The way is the answer's own, so the page names the way the code went as the server gives it.
    const attempt: Attempt = { attemptId: outcome.attemptId, way: outcome.way, link };
    const next = { requestId: newRequestId(), attempt, expiresAt: instantOf(outcome.expiresAt), now: now() };
    return withDevice(
      context,
      outcome.way === "email"
        ? codePage(config, next)
        : textPage(config, { ...next, readyText: outcome.readyText, textLink: outcome.textLink }),
      made,
    );
  };

  const check = async (context: RouteContext): Promise<Response> => {
    const { config, request } = context;
    const lost = (words: string, link: string | null = null): Response =>
      context.page(
        notePage(config, { title: "Start again", lines: [words], link, again: "Start again", status: 400 }),
      );

    const form = await readForm(request);
    if (form === null) return lost(BAD_FORM);
    const requestId = form.get("requestId") ?? "";
    const attemptId = form.get("attempt") ?? "";
    const way = wayOf(form.get("way"));
    const link = linkOf(form.get("link"));
    if (!REQUEST_ID.test(requestId) || !ATTEMPT_ID.test(attemptId) || way === null || link === false)
      return lost(BAD_FORM);
    const attempt: Attempt = { attemptId, way, link };

    // The pause this browser was told about for this attempt still runs: the pause page, and no call.
    const pause = pauseOf(request, config);
    if (pause !== null && pause.attemptId === attemptId && now().getTime() < pause.until.getTime())
      return context.page(pausedPage(config, { until: pause.until, now: now(), link, fiveWrong: true }));

    const deviceToken = deviceTokenOf(request, config);
    if (deviceToken === null)
      return lost(
        "This browser did not keep the cookie sign-in needs. Allow cookies for this site, then start again.",
        link,
      );

    /** The form again, for a code that was not checked or not right. */
    const again = (problem: Problem): Response =>
      context.page(
        way === "email"
          ? codePage(config, { requestId: newRequestId(), attempt, expiresAt: null, now: now() }, problem)
          : waitingPage(config, { requestId: newRequestId(), attempt }, problem),
      );

    let code: string | null = null;
    if (way === "email") {
      code = (form.get("code") ?? "").replace(/\s+/g, "");
      if (!CODE.test(code)) return again({ words: "Type the code's digits, as they came.", status: 400 });
    }

    const outcome = await context.client.call("signInCheck", {
      page: context.envelope({ requestId, sessionToken: null, linkCode: link }),
      attemptId,
      code,
      deviceToken,
    });

    if (isPageError(outcome)) {
      if (outcome.error === "attemptNotFound")
        return context.page(
          notePage(config, {
            title: "Start again",
            lines: ["That sign-in was not found for this browser."],
            link,
            again: "Start again",
          }),
        );
      return again({ words: TRY_AGAIN, status: 503 });
    }
    switch (outcome.result) {
      case "signedIn": {
        const response = context.page(
          signedInPage(config, {
            as: signedInAs(outcome.person, config),
            consoles: consolesFor(outcome.person, config),
            link,
            requestId: newRequestId(),
          }),
        );
        // The token alone, this once (K-21 v1: it leaves the server in this answer only).
        response.headers.append(
          "set-cookie",
          sessionCookie(outcome.sessionToken, outcome.sessionExpiresAt, config),
        );
        return response;
      }
      case "wrong":
        return again({
          words:
            outcome.triesLeft === 1
              ? "That code is not right. 1 try left."
              : `That code is not right. ${String(outcome.triesLeft)} tries left.`,
          status: 200,
        });
      case "paused": {
        const until = instantOf(outcome.until);
        const response = context.page(pausedPage(config, { until, now: now(), link, fiveWrong: true }));
        if (until !== null) response.headers.append("set-cookie", pauseCookie({ until, attemptId }, config));
        return response;
      }
      case "expired":
        return context.page(
          notePage(config, {
            title: "That code has run out",
            lines: ["A code works for 10 minutes. Start again for a new one."],
            link,
            again: "Start again",
          }),
        );
      case "waitingForText":
        return context.page(waitingPage(config, { requestId: newRequestId(), attempt }));
      case "alreadySignedIn":
        return context.page(
          notePage(config, {
            title: "This sign-in is already done",
            lines: [
              "If this browser is signed in, your pages open as they are.",
              "If it is not, start a new sign-in.",
            ],
            link,
            again: "Start a new sign-in",
          }),
        );
      case "secondProofNeeded":
        return context.page(
          notePage(config, {
            title: "A second proof is needed",
            lines: [
              "The code was right, but this account has not signed in on this device before, so a second proof is needed and no session has started.",
              "That step is not on this page yet. Sign in on a device you have used before, or keep working with Rosie by text.",
            ],
            link,
            again: "Back to sign-in",
          }),
        );
    }
  };

  const signOut = async (context: RouteContext): Promise<Response> => {
    const { config, request } = context;
    const form = await readForm(request);
    const requestId = form?.get("requestId") ?? "";
    if (!REQUEST_ID.test(requestId))
      return context.page(signOutPage(config, newRequestId(), { words: BAD_FORM, status: 400 }));

    const sessionToken = sessionTokenOf(request, config);
    if (sessionToken !== null) {
      const outcome = await context.client.call("signOut", {
        page: context.envelope({ requestId, sessionToken, linkCode: null }),
      });
      // Nothing changed on the server, so the cookie stays and the person can ask again.
      if (isPageError(outcome))
        return context.page(signOutPage(config, newRequestId(), { words: TRY_AGAIN, status: 503 }));
    }
    const response = context.page(
      notePage(config, {
        title: "You are signed out",
        lines: ["Your session on this browser has ended."],
        link: null,
        again: "Sign in",
      }),
    );
    response.headers.append("set-cookie", clearedCookie(cookieNames(config).session, config));
    return response;
  };

  const posts = (context: RouteContext): boolean => context.request.method === "POST";

  return [
    {
      label: "auth.signIn",
      path: SIGN_IN_PATH,
      methods: ["GET", "POST"],
      handle: (context) => (posts(context) ? start(context) : startForm(context)),
    },
    {
      label: "auth.signInCheck",
      path: SIGN_IN_CHECK_PATH,
      methods: ["GET", "POST"],
      // Nothing is at this address to read: a GET goes to the form that starts a sign-in.
      handle: (context) => (posts(context) ? check(context) : seeSignIn(context)),
    },
    {
      label: "auth.signOut",
      path: SIGN_OUT_PATH,
      methods: ["GET", "POST"],
      handle: (context) =>
        posts(context) ? signOut(context) : context.page(signOutPage(context.config, newRequestId())),
    },
  ];
}
