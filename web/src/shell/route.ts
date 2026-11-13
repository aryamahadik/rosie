// What a feature folder gives the web shell (T-511; build prompt 3.5 (c)): its routes. Each feature folder holds one
// route module, routes.ts, exporting ROUTES; web/src/routes.ts lists every folder's module once, and the shell
// (shell.ts) serves whatever those lists hold. So a page task adds its routes in its own folder and changes nothing
// outside it.
//
// A route is a fixed label, a path under BASE_PATH, the methods it takes and a handler. The shell gives the handler
// the request, the config, the trace id and a K-21 client that carries that id, and sends the handler's answer with
// x-trace-id and one log line (shell.ts).
//
// A path is /segments of lowercase letters, digits and hyphens. A segment written :name takes any one segment of the
// address, handed to the handler as it came, not decoded: "/sign-in" is one address, "/:code" every one-segment
// address. An exact path always wins over one with a :name, whatever the order, so a wide route (a link's short code)
// never takes another page's address.

import type { EnvelopeParts, PageEnvelope } from "../client/calls";
import type { PageApiClient } from "../client/client";
import type { WebConfig } from "./config";

/** The methods a route may take. GET also answers HEAD, with no body. */
export type RouteMethod = "GET" | "POST";

/** One page for the frame (frame.ts), as a route gives it. */
export interface RoutePage {
  /** The page's title, plain text. */
  title: string;
  /** The main landmark's content: HTML the route has built, every text in it escaped with escapeHtml. */
  main: string;
  /** The status, 200 when left out. */
  status?: number;
  /** False: search engines may index the page. Left out, they are asked not to. */
  noindex?: boolean;
  /** True: the page holds a form that posts to this site, which the content security policy then allows. */
  forms?: boolean;
}

/** What the shell hands a route's handler for one request. */
export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  /** The route's own path under BASE_PATH, as the address gave it. */
  readonly path: string;
  /** The address's value for each :name of the route's path, not decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly config: WebConfig;
  /** The page request's trace id (trace.ts). */
  readonly traceId: string;
  /** The K-21 client for this request: every call carries the trace id. */
  readonly client: PageApiClient;
  /** A K-21 call's envelope under this request's trace id. */
  readonly envelope: <Session extends string | null, Link extends string | null>(
    parts: EnvelopeParts<Session, Link>,
  ) => PageEnvelope<Session, Link>;
  /** The page inside the frame, with the shell's headers. */
  readonly page: (page: RoutePage) => Response;
  /** The shell's own 404 page, for an address whose :name names nothing. */
  readonly notFound: () => Response;
}

/** One route of a feature folder. */
export interface ShellRoute {
  /** The route's name in the log line: fixed letters written in the code, never a value from a request. */
  readonly label: string;
  /** The path under BASE_PATH (see the top of this file). */
  readonly path: string;
  /** The methods it takes; any other gets the shell's 405 page. */
  readonly methods: readonly RouteMethod[];
  /** Answers one request. A throw, or an answer that is no Response, gets the shell's 500 page. */
  readonly handle: (context: RouteContext) => Response | Promise<Response>;
}

/** One feature folder's route module, as web/src/routes.ts lists it. */
export interface RouteModule {
  /** The folder under web/src, such as "link" or "console/team/paging". */
  readonly folder: string;
  /**
   * True for staging's test tools (build prompt 9.4): none of the folder's routes exists unless ENVIRONMENT is exactly
   * "staging". Set in web/src/routes.ts, outside the folder, so no route of the folder can leave it out.
   */
  readonly stagingOnly: boolean;
  /** The folder's own ROUTES list. */
  readonly routes: readonly ShellRoute[];
}

/** A route list the shell refuses to serve. */
export class RouteError extends Error {
  override name = "RouteError";
}

/** The label the log line gives a request no route answers. No route may take it. */
export const NOT_FOUND_LABEL = "notFound";

const LABEL = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;
const LABEL_MAX = 64;
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const PARAM = /^:[a-z][A-Za-z0-9]*$/;
const METHODS: ReadonlySet<string> = new Set<RouteMethod>(["GET", "POST"]);

/** One segment of a route's path: its own letters, or the name of the :name it takes. */
type Segment = { readonly literal: string } | { readonly param: string };

/** A route ready to match. */
export interface TableRoute {
  readonly route: ShellRoute;
  readonly segments: readonly Segment[];
  /** True when the path has no :name. */
  readonly exact: boolean;
}

/** A route with the values the address gave its :names. */
export interface RouteMatch {
  readonly route: ShellRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** The routes one shell serves. */
export interface RouteTable {
  readonly routes: readonly TableRoute[];
  /** The route at `path` (the address's path under BASE_PATH), or null: an exact path first, then the first :name path. */
  readonly match: (path: string) => RouteMatch | null;
}

function segmentsOf(route: ShellRoute): Segment[] {
  const parts = route.path.split("/");
  if (parts[0] !== "" || parts.length < 2)
    throw new RouteError(`${route.label}: the path "${route.path}" does not start with /`);
  const names = new Set<string>();
  return parts.slice(1).map((part): Segment => {
    if (SEGMENT.test(part)) return { literal: part };
    if (!PARAM.test(part))
      throw new RouteError(
        `${route.label}: "${part}" in the path "${route.path}" is neither a segment of lowercase letters, digits and hyphens nor a :name`,
      );
    const name = part.slice(1);
    if (names.has(name))
      throw new RouteError(`${route.label}: the path "${route.path}" names :${name} twice`);
    names.add(name);
    return { param: name };
  });
}

/** A path's shape: its segments, every :name written alike, so two paths that take the same addresses read alike. */
function shapeOf(segments: readonly Segment[]): string {
  return segments.map((segment) => ("literal" in segment ? `/${segment.literal}` : "/:")).join("");
}

function paramsOf(segments: readonly Segment[], parts: readonly string[]): Record<string, string> | null {
  if (parts.length !== segments.length) return null;
  const params: [string, string][] = [];
  for (const [k, segment] of segments.entries()) {
    const part = parts[k];
    if (part === undefined || part === "") return null;
    if ("literal" in segment) {
      if (segment.literal !== part) return null;
    } else {
      params.push([segment.param, part]);
    }
  }
  return Object.fromEntries(params);
}

/**
 * The table of `routes`, checked: each label a label and used once, each path a path, each method GET or POST, and no
 * two paths that take the same addresses. Throws RouteError otherwise, so a mistake in one folder's list is found
 * when the shell is made, not by a reader.
 */
export function routeTable(routes: readonly ShellRoute[]): RouteTable {
  const labels = new Set<string>();
  const shapes = new Map<string, string>();
  const table = routes.map((route): TableRoute => {
    if (route.label.length > LABEL_MAX || !LABEL.test(route.label) || route.label === NOT_FOUND_LABEL)
      throw new RouteError("a route's label is not a label (letters and digits, from a lowercase letter)");
    if (labels.has(route.label)) throw new RouteError(`two routes are labelled ${route.label}`);
    labels.add(route.label);

    if (route.methods.length === 0) throw new RouteError(`${route.label}: the route takes no method`);
    for (const method of route.methods)
      if (!METHODS.has(method)) throw new RouteError(`${route.label}: a route takes GET or POST only`);

    const segments = segmentsOf(route);
    const shape = shapeOf(segments);
    const other = shapes.get(shape);
    if (other !== undefined)
      throw new RouteError(`${other} and ${route.label} take the same addresses (${shape})`);
    shapes.set(shape, route.label);
    return { route, segments, exact: segments.every((segment) => "literal" in segment) };
  });

  // An exact path before any :name path; inside each kind, the order the routes were listed in.
  const ordered = [...table.filter((entry) => entry.exact), ...table.filter((entry) => !entry.exact)];
  return {
    routes: table,
    match(path) {
      if (!path.startsWith("/")) return null;
      const parts = path.slice(1).split("/");
      for (const entry of ordered) {
        const params = paramsOf(entry.segments, parts);
        if (params !== null) return { route: entry.route, params };
      }
      return null;
    },
  };
}
