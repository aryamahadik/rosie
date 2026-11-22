// The signed-link opener (T-512; C-185; A4-42: "links are always the host plus a short code"; K-21 v1 openLink; FS line
// 701; S13-45: "Opening a link never counts").
//
// A link is https://<LINK_HOST><BASE_PATH>/<code> (shell/config.ts linkUrl): rosfield.com/test/<code> on staging. Its one
// route, GET /:code under BASE_PATH, takes any one-segment address no exact path has (shell/route.ts: an exact path such
// as /sign-in or /privacy always wins), and for one request:
//   1. The code is the address's own segment, as it came. One that is not a link's short code (K-21 v1 `$defs/linkCode`)
//      is no link at all: the shell's 404 page, and nothing is sent.
//   2. openLink, with the page envelope alone: this request's own new id, the page request's trace id, the session
//      cookie's token or null (auth/cookies.ts sessionTokenOf), and the code. Nothing else from the browser is read or
//      sent: no request names a person, a business, a proof or a role (K-21 v1 README, "No browser value says who anyone
//      is"), so no query, header, form or other cookie can make the call act for anyone.
//   3. The answer: linkExpired gives the plain expired page (pages.ts), transient and bookingPaused the page that could
//      not open, and an open link the page view.ts allows, which counts as proof only what a session of the link's own
//      person proves, never the link.
// The page holds no form and runs no script; a sign-in goes through auth's own pages (/sign-in?link=<code>).

import { isPageError } from "../client/calls";
import { sessionTokenOf } from "../auth/cookies";
import type { RouteContext, ShellRoute } from "../shell/route";
import { expiredPage, notOpenedPage, openedPage } from "./pages";
import { linkViewOf } from "./view";

/** The link route's path under BASE_PATH: the host plus a short code (A4-42). */
export const LINK_PATH = "/:code";

/** The link route's label in the shell's log line: fixed letters, never the code. */
export const LINK_LABEL = "link.open";

/** K-21 v1 `$defs/linkCode`, the same letters shell/config.ts linkUrl takes. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/;

/** True when `code` reads as a link's short code (K-21 v1 `$defs/linkCode`). */
export function isLinkCode(code: string): boolean {
  return LINK_CODE.test(code);
}

/** What the opener takes from outside, replaceable in a test. */
export interface LinkDeps {
  /** Makes the request id of one openLink call (K-21 v1 `page.requestId`, never reused); a random UUID when left out. */
  newRequestId?: () => string;
}

/** The routes of web/src/link (see the top of this file). */
export function linkRoutes(deps: LinkDeps = {}): readonly ShellRoute[] {
  const newRequestId = deps.newRequestId ?? ((): string => crypto.randomUUID());

  const open = async (context: RouteContext): Promise<Response> => {
    const code = context.params.code ?? "";
    if (!isLinkCode(code)) return context.notFound();

    const sessionToken = sessionTokenOf(context.request, context.config);
    const outcome = await context.client.call("openLink", {
      page: context.envelope({ requestId: newRequestId(), sessionToken, linkCode: code }),
    });
    if (isPageError(outcome))
      return context.page(outcome.error === "linkExpired" ? expiredPage() : notOpenedPage());
    return context.page(openedPage(context.config, code, linkViewOf(outcome, sessionToken !== null)));
  };

  return [{ label: LINK_LABEL, path: LINK_PATH, methods: ["GET"], handle: open }];
}
