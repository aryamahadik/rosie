// web's answer to a request for one of its pages (T-1171). servePage answers GET and HEAD at a page's path under
// BASE_PATH with that page, and any other method there with 405. For every other path it gives null: that path stays
// the Worker's (runtime/src/index.ts: health, the webhooks, the page calls and its 404).
//
// A page answer is static HTML, and its headers keep it so (RULES 4.3 and 4.5): no set-cookie header, ever; a content
// security policy that loads nothing (default-src 'none'), runs no script, sends no form, allows the frame's own inline
// style by its hash alone and lets no other site frame the page; no referrer on any link; no type sniffing. Nothing from
// the request (its query, headers or cookies) reaches the page, and nothing about the reader is logged.
//
// The Worker's fetch calls servePage last before its 404 (T-1192, runtime/src/index.ts), so these pages are served on
// rosfield.com/test. The web app shell (T-511, shell.ts) serves the same pages with the same headers, and beside them
// the feature folders' routes, each answer with its trace id and one log line; servePage itself is unchanged.
import { PAGE_ROUTES, type PageRoute } from "../routes";
import { FRAME_STYLE_SOURCE, basePathOf } from "./frame";

/** The methods a page answers. */
export const PAGE_METHODS = ["GET", "HEAD"] as const;

/** What one page's content security policy allows beyond the frame's own style. Left out: nothing. */
export interface PagePolicy {
  /** True: the page holds a form that posts to this site (form-action 'self'), never to another. */
  forms?: boolean;
}

/**
 * The content security policy of every page answer (see the top of this file). With `policy.forms`, a form may post to
 * this site and nowhere else; everything else stays as it is.
 */
export function contentSecurityPolicy(policy: PagePolicy = {}): string {
  return [
    "default-src 'none'",
    `style-src ${FRAME_STYLE_SOURCE}`,
    "base-uri 'none'",
    `form-action ${policy.forms === true ? "'self'" : "'none'"}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The headers of every page answer: no cookie, nothing loaded from outside, no script, no referrer, no framing. */
export function pageHeaders(contentType: string, policy: PagePolicy = {}): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy(policy),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

/** The page at `pathname` under `basePath` (as basePathOf reads it), or null when no page is there. */
export function routeOf(pathname: string, basePath: string): PageRoute | null {
  return PAGE_ROUTES.find((route) => `${basePath}${route.path}` === pathname) ?? null;
}

/**
 * The answer to `request` when it asks for one of web's pages under BASE_PATH `basePath` (wrangler.jsonc vars: "/test"
 * on staging, "" in production), or null when it does not (see the top of this file). Throws BasePathError for a base
 * path that is not one.
 */
export function servePage(request: Request, basePath: string): Response | null {
  const base = basePathOf(basePath);
  const route = routeOf(new URL(request.url).pathname, base);
  if (route === null) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = pageHeaders("text/plain; charset=utf-8");
    headers.set("allow", PAGE_METHODS.join(", "));
    return new Response("Method not allowed\n", { status: 405, headers });
  }
  const page = route.render(base);
  return new Response(request.method === "HEAD" ? null : page, {
    status: 200,
    headers: pageHeaders("text/html; charset=utf-8"),
  });
}
