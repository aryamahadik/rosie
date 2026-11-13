// The staging-only guard staging's test tools use (T-522; C-203, C-204, C-205; build prompt 9.4: "Never in
// production").
//
// The shell already serves a folder marked staging only in web/src/routes.ts nowhere but on staging (shell/shell.ts).
// This guard is the second check, inside the tool itself: a tool hands its whole list of routes to stagingOnlyRoutes,
// and then, unless ENVIRONMENT is exactly "staging", every route answers the shell's own 404 page (the route
// context's notFound) and the tool's handler is never called. So no tool code runs and no K-21 call is made there,
// even if the folder's mark in web/src/routes.ts is ever lost.
//
// The guard reads one thing: the config the shell hands a handler (shell/config.ts readWebConfig, from the Worker's
// vars). It never reads the request, so no address, query, header, cookie or body can switch a tool on. It fails
// closed: a config that is missing, is no object, does not hold both values as its own, or whose two values disagree
// (an ENVIRONMENT other than "staging" with the staging mark set, or "staging" without the mark) is not staging.

import type { ShellRoute } from "../../shell/route";

/** The one ENVIRONMENT staging's test tools exist in (wrangler.jsonc env.staging), by its exact spelling. */
export const STAGING_ENVIRONMENT = "staging";

/** A route's handler (shell/route.ts ShellRoute.handle). */
export type RouteHandler = ShellRoute["handle"];

/** The handlers stagingOnly made, so a route can be asked whether it is guarded. */
const GUARDED = new WeakSet<RouteHandler>();

/**
 * True only for the config of a web app on staging: an object whose own `environment` is exactly "staging" and whose
 * own `staging` is true (shell/config.ts WebConfig). Anything else is not staging (see the top of this file). A page
 * outside the tool folders uses it to show no link to a tool, and no control of one, anywhere else.
 */
export function isStagingConfig(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  if (!Object.hasOwn(config, "environment") || !Object.hasOwn(config, "staging")) return false;
  const { environment, staging } = config as { environment?: unknown; staging?: unknown };
  return environment === STAGING_ENVIRONMENT && staging === true;
}

/**
 * `handle` behind the guard: on staging it answers as `handle` does, with the same context; anywhere else the answer
 * is the shell's 404 page and `handle` is never called.
 */
export function stagingOnly(handle: RouteHandler): RouteHandler {
  if (GUARDED.has(handle)) return handle;
  const guarded: RouteHandler = (context) =>
    isStagingConfig(context.config) ? handle(context) : context.notFound();
  GUARDED.add(guarded);
  return guarded;
}

/**
 * A tool's list of routes, each behind the guard: the same labels, paths and methods, in the same order. A tool's
 * routes.ts exports it as its ROUTES, so no route of the tool can leave the guard out. The list given is not changed.
 */
export function stagingOnlyRoutes(routes: readonly ShellRoute[]): readonly ShellRoute[] {
  return routes.map((route) => ({ ...route, handle: stagingOnly((context) => route.handle(context)) }));
}

/** True when the route's handler is one stagingOnly or stagingOnlyRoutes made. */
export function isGuarded(route: ShellRoute): boolean {
  return GUARDED.has(route.handle);
}
