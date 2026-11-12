// The web app shell (T-511; C-185): one answer for every page request under BASE_PATH.
//
// It serves web's static pages (web/src/routes.ts PAGE_ROUTES: the privacy notice, with the bytes and headers servePage
// gives it) and the routes of every feature folder (ROUTE_MODULES; route.ts). For one request:
//   1. Its trace id: the incoming x-trace-id when it is a valid id, else a new one (trace.ts).
//   2. The route at its path under BASE_PATH, an exact path before a :name path. Staging's test tools exist only when
//      ENVIRONMENT is exactly "staging" (build prompt 9.4: never in production), decided once, from the config alone
//      and failing closed (staging/guard isStagingConfig). Anywhere else the table holds no route of a folder marked
//      staging only, and no route behind the staging-only guard (staging/guard isGuarded), whatever its folder's mark.
//      So there a tool's address is an unknown address for every method and whatever the request carries, decided
//      before anything below looks at the request (T-520 round 2; DL-491): no Origin, header or body changes the
//      answer, none of the body is read and no handler runs.
//   3. No route: the 404 page. A method the route does not take: the 405 page with Allow. A POST that was not sent to
//      this site's own host (LINK_HOST), or is not from its own origin: the 403 page; one whose body is over the cap:
//      the 413 page (post-guard.ts; T-520, T-1237), each before any handler runs. Else the route's handler answers; a
//      throw, or an answer that is no Response, gives the 500 page. Each error page shows the trace id.
//   4. HEAD gets GET's answer with no body.
// Every answer carries the trace id in x-trace-id, and one JSON log line is written for it: the trace id, the route's
// label and the status, nothing else. A label is fixed letters from the code (route.ts), and the trace id is always a
// UUID, so nothing of the request (its address, query, headers, cookies or body) and nothing a handler threw is ever
// logged. A page's K-21 calls go through the request's client, which carries the same trace id (client/client.ts).
//
// Rendering (the plan's default for the web rendering approach): HTML made on the Worker in TypeScript, no client
// framework, each page through the frame (frame.ts), with a content security policy that loads nothing but the frame's
// own style. A page that holds a form says so, and the policy then lets it post to this site only.
//
// `fetch` answers every request; `serve` gives null for an address no route takes (a tool's address outside staging
// among them), so a Worker with routes of its own (runtime/src/index.ts) can keep its own 404 for those.

import { envelopeOf } from "../client/calls";
import { createPageApiClient, type PageApiTransport } from "../client/client";
import { PAGE_ROUTES, ROUTE_MODULES, type PageRoute } from "../routes";
import { isGuarded, isStagingConfig } from "../staging/guard";
import type { WebConfig } from "./config";
import { renderErrorPage, type ErrorStatus } from "./error-pages";
import { renderPage } from "./frame";
import { guardPost, type PostRefusal } from "./post-guard";
import {
  NOT_FOUND_LABEL,
  routeTable,
  type RouteContext,
  type RouteMatch,
  type RouteModule,
  type RoutePage,
  type ShellRoute,
} from "./route";
import { pageHeaders } from "./serve";
import { traceIdOf } from "./trace";

const HTML = "text/html; charset=utf-8";

/** What the shell is made from. */
export interface ShellDeps {
  /** The web app's config (config.ts readWebConfig). */
  config: WebConfig;
  /** How a page's K-21 calls reach the page entry (client/client.ts). */
  transport: PageApiTransport;
  /** The static pages; web/src/routes.ts PAGE_ROUTES when left out. */
  pages?: readonly PageRoute[];
  /** The feature folders' route modules; web/src/routes.ts ROUTE_MODULES when left out. */
  modules?: readonly RouteModule[];
  /** Writes one log line; console.log when left out (Workers Logs). */
  log?: (line: string) => void;
  /** Makes a trace id; crypto.randomUUID when left out. */
  newTraceId?: () => string;
  /**
   * Told what a handler threw, before the 500 page is sent. Nothing is logged from it here. A test hands in a function
   * that throws it again, so a page test fails loudly on the Tool API mock's error instead of reading a 500 page.
   */
  onRouteError?: (error: unknown) => void;
}

/** The shell: the answer to a page request. */
export interface WebShell {
  /** The answer to any request: a page, or the 404 page when no route is at its address. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** The answer when a route is at the request's address, else null (nothing is logged for it). */
  readonly serve: (request: Request) => Promise<Response> | null;
}

/** One log line's content: the trace id, the route's label and the status only. */
export interface PageLogLine {
  level: "info" | "error";
  msg: "page";
  trace_id: string;
  route: string;
  status: number;
}

/** A static page as a route: GET alone, the page as it renders for the base path, with servePage's headers. */
function staticRoute(page: PageRoute): ShellRoute {
  return {
    label: page.label,
    path: page.path,
    methods: ["GET"],
    handle: (context) =>
      new Response(page.render(context.config.basePath), { status: 200, headers: pageHeaders(HTML) }),
  };
}

/** The methods a route takes, as Allow names them: HEAD rides with GET. */
function allowOf(route: ShellRoute): string {
  return [
    ...new Set(route.methods.flatMap((method) => (method === "GET" ? ["GET", "HEAD"] : [method]))),
  ].join(", ");
}

function takes(route: ShellRoute, method: string): boolean {
  return route.methods.some((taken) => taken === method || (taken === "GET" && method === "HEAD"));
}

/** The shell over `deps` (see the top of this file). Throws RouteError for a route list it cannot serve. */
export function createWebShell(deps: ShellDeps): WebShell {
  const { config, transport } = deps;
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });
  const modules = deps.modules ?? ROUTE_MODULES;
  // Staging's test tools are in the table only on staging (see the top of this file): anywhere else neither a folder
  // marked staging only nor a guarded route is listed, so a tool's address is like any unknown address.
  const staging = isStagingConfig(config);
  const table = routeTable([
    ...(deps.pages ?? PAGE_ROUTES).map(staticRoute),
    ...modules
      .filter((module) => staging || !module.stagingOnly)
      .flatMap((module) => module.routes)
      .filter((route) => staging || !isGuarded(route)),
  ]);

  /** The request's path under BASE_PATH, or null when it is not under it. */
  const pathOf = (url: URL): string | null => {
    if (!url.pathname.startsWith(`${config.basePath}/`)) return null;
    return url.pathname.slice(config.basePath.length);
  };

  const errorPage = (status: ErrorStatus, traceId: string): Response =>
    new Response(renderErrorPage({ status, basePath: config.basePath, traceId }), {
      status,
      headers: pageHeaders(HTML),
    });

  /** The answer as it is sent: no body for HEAD, the trace id in x-trace-id, and the one log line. */
  const finish = (request: Request, answer: Response, traceId: string, label: string): Response => {
    const headers = new Headers(answer.headers);
    headers.set("x-trace-id", traceId);
    const sent = new Response(request.method === "HEAD" ? null : answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers,
    });
    const line: PageLogLine = {
      level: sent.status >= 500 ? "error" : "info",
      msg: "page",
      trace_id: traceId,
      route: label,
      status: sent.status,
    };
    log(JSON.stringify(line));
    return sent;
  };

  const answerRoute = async (
    request: Request,
    url: URL,
    path: string,
    match: RouteMatch,
    traceId: string,
  ): Promise<Response> => {
    const { route, params } = match;
    if (!takes(route, request.method)) {
      const refused = errorPage(405, traceId);
      refused.headers.set("allow", allowOf(route));
      return finish(request, refused, traceId, route.label);
    }
    // A POST reaches its handler only on this site's own host, from its own origin and with a body under the cap
    // (post-guard.ts).
    let guarded = request;
    if (request.method === "POST") {
      let checked: Request | PostRefusal;
      try {
        checked = await guardPost(request, config);
      } catch (error) {
        deps.onRouteError?.(error);
        return finish(request, errorPage(500, traceId), traceId, route.label);
      }
      if (typeof checked === "number")
        return finish(request, errorPage(checked, traceId), traceId, route.label);
      guarded = checked;
    }
    const context: RouteContext = {
      request: guarded,
      url,
      path,
      params,
      config,
      traceId,
      client: createPageApiClient(transport, traceId),
      envelope: (parts) => envelopeOf(traceId, parts),
      page: (page: RoutePage) =>
        new Response(
          renderPage({
            basePath: config.basePath,
            path,
            title: page.title,
            main: page.main,
            noindex: page.noindex ?? true,
          }),
          { status: page.status ?? 200, headers: pageHeaders(HTML, { forms: page.forms === true }) },
        ),
      notFound: () => errorPage(404, traceId),
    };
    let answer: unknown;
    try {
      answer = await route.handle(context);
    } catch (error) {
      deps.onRouteError?.(error);
      return finish(request, errorPage(500, traceId), traceId, route.label);
    }
    if (!(answer instanceof Response)) {
      deps.onRouteError?.(new TypeError("the route's handler gave no Response"));
      return finish(request, errorPage(500, traceId), traceId, route.label);
    }
    return finish(request, answer, traceId, route.label);
  };

  const serve = (request: Request): Promise<Response> | null => {
    const url = new URL(request.url);
    const path = pathOf(url);
    const match = path === null ? null : table.match(path);
    if (path === null || match === null) return null;
    return answerRoute(request, url, path, match, traceIdOf(request, deps.newTraceId));
  };

  return {
    serve,
    fetch(request) {
      const served = serve(request);
      if (served !== null) return served;
      const traceId = traceIdOf(request, deps.newTraceId);
      return Promise.resolve(finish(request, errorPage(404, traceId), traceId, NOT_FOUND_LABEL));
    },
  };
}
