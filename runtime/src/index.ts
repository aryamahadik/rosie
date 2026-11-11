// Rosie's Worker. Routes (factory spec 6; T-241; T-275; T-266): GET {BASE_PATH}/health, and the gateway's webhooks, each a
// POST under BASE_PATH: /webhooks/linq; Stripe's /webhooks/stripe/rosfield and /webhooks/stripe/businesses; the calendars'
// /webhooks/calendar/google and /webhooks/calendar/microsoft. And the page entry: the web app's K-21 v1 page and console
// calls, each a POST to {BASE_PATH}/page-api/<call>, handed to the action layer's handler for that call; a staging-only
// call answers stagingOnly wherever ENVIRONMENT is not staging (runtime/src/gateway/pages).
// Then, last before the 404, web's pages (T-1171, T-1192): @rosie/web's servePage answers GET and HEAD at a page's exact
// path under BASE_PATH, and 405 to any other method there. Today that is the privacy notice at {BASE_PATH}/privacy
// (rosfield.com/test/privacy on staging), the address on the last line of Rosie's first text (RULES 4.3). Its answer is
// sent as web made it (web/src/shell/serve.ts): static HTML whose headers set no cookie and whose content security
// policy allows nothing but the page's own style. It has no trace id and no log line: a page reads nothing from the
// request, and nothing about the reader is logged.
// Every other request carries one trace id: the incoming x-trace-id when it is a valid id (a UUID), else a new one.
// The id is returned in the x-trace-id header and the JSON body, and written in one JSON log line (Workers Logs).
// Each webhook opens its own id at receipt, and each page call its own, keeping a valid incoming one (runtime/src/gateway);
// a page call's 200 carries only its K-21 outcome, so its id is in the header alone.
// The scheduled handler is the clock rows' minute sweep (T-254, runtime/src/clocks), on T-278's one-minute cron.
// The gateway's doors come from the composition root (T-550, runtime/src/wiring), which picks each port's implementation
// for the Worker's environment. The Worker's Linq route is the root's, behind the skeleton flag (T-552, T-553).

import { servePage } from "@rosie/web/src/shell/serve";

import { clockActorsOf, sweepClocks, type ClockActors } from "./clocks";
import {
  handleLinqWebhook,
  handlePageCall,
  handleProviderWebhook,
  LINQ_WEBHOOK_PATH,
  pageDepsOf,
  pageRouteOf,
  providerDepsOf,
  providerRouteOf,
  type GatewayDeps,
} from "./gateway";
import { wireWorker, workerRoot } from "./wiring";

// The HandleActor Durable Object (T-244): the Workers runtime finds the class named in wrangler.jsonc here.
export { HandleActor } from "./actor";
export { TestPhoneLine } from "./wiring/test-phone/line";

// The retry queue's consumer (T-256, runtime/src/queues): the Workers runtime hands it each batch of RETRY_QUEUE.
import { retryQueueHandler } from "./queues";

declare global {
  namespace Cloudflare {
    interface Env {
      /** "production" or "staging" (wrangler.jsonc vars). */
      ENVIRONMENT: string;
      /** Path prefix the Worker answers under: "/test" on staging, "" otherwise. */
      BASE_PATH: string;
      /** PostgreSQL schema: empty on staging, preview_<slug> on a branch preview. */
      DB_SCHEMA: string;
      /** The commit a deploy came from (`--var GIT_SHA:<sha>`); missing when run locally. */
      GIT_SHA?: string;
    }
  }
}

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function traceIdOf(request: Request): string {
  const incoming = request.headers.get("x-trace-id")?.trim();
  return incoming !== undefined && TRACE_ID.test(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
}

function jsonResponse(status: number, body: Record<string, unknown>, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-trace-id": traceId,
    },
  });
}

/**
 * The health answer, web's pages and the 404 are synchronous (the health tests read them without waiting); the webhooks
 * and the page calls answer later.
 * The Workers runtime always passes the execution context, so its call is the second form.
 */
export interface RosieWorker {
  fetch(request: Request, env: Cloudflare.Env): Response;
  fetch(request: Request, env: Cloudflare.Env, context: ExecutionContext): Response | Promise<Response>;
  /** The one-minute cron (T-278's trigger): the clock rows' sweep, kept alive with the context's waitUntil (T-254). */
  scheduled(controller: ScheduledController, env: Cloudflare.Env, context: ExecutionContext): void;
  /** The retry queue's consumer (T-256): each message of the batch acked or retried on its own (runtime/src/queues). */
  queue(batch: MessageBatch, env: Cloudflare.Env): Promise<void>;
}

/** The Worker's answer to one POST on the Linq webhook path. */
export type LinqWebhookRoute = (request: Request, env: Cloudflare.Env) => Promise<Response>;

/**
 * The Worker with the gateway's doors (the Linq adapter, the handle actor, and the Stripe and calendar doors' ports and
 * store) supplied by `gatewayDeps`, the sweep's HandleActor namespace by `clockActors` (the HANDLE_ACTOR binding by
 * default), and the Linq webhook POST answered by `linqWebhook` (by default the gateway's Linq entry with those doors).
 */
export function createWorker(
  gatewayDeps: (env: Cloudflare.Env) => GatewayDeps,
  clockActors: (env: Cloudflare.Env) => ClockActors | null = clockActorsOf,
  linqWebhook: LinqWebhookRoute = (request, env) =>
    handleLinqWebhook(request, gatewayDeps(env), {
      environment: env.ENVIRONMENT,
      version: env.GIT_SHA ?? "unknown",
    }),
): RosieWorker {
  const scheduled = (
    controller: ScheduledController,
    env: Cloudflare.Env,
    context: ExecutionContext,
  ): void => {
    const swept = sweepClocks({
      scheduledTime: controller.scheduledTime,
      actors: clockActors(env),
      log: { environment: env.ENVIRONMENT, version: env.GIT_SHA ?? "unknown" },
      staging: env.ENVIRONMENT === "staging",
    });
    context.waitUntil(
      swept.then(
        () => undefined,
        () => undefined,
      ),
    );
  };
  const fetch = (request: Request, env: Cloudflare.Env): Response | Promise<Response> => {
    const traceId = traceIdOf(request);
    const environment = env.ENVIRONMENT;
    const version = env.GIT_SHA ?? "unknown";
    const basePath = env.BASE_PATH.replace(/\/+$/, "");
    const pathname = new URL(request.url).pathname;

    if (pathname === `${basePath}${LINQ_WEBHOOK_PATH}`) {
      if (request.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method_not_allowed", trace_id: traceId }, traceId);
      }
      return linqWebhook(request, env);
    }

    const route = pathname.startsWith(basePath) ? providerRouteOf(pathname.slice(basePath.length)) : null;
    if (route !== null) {
      if (request.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method_not_allowed", trace_id: traceId }, traceId);
      }
      return handleProviderWebhook(request, route, providerDepsOf(gatewayDeps(env)), {
        environment,
        version,
      });
    }

    const pageCall = pathname.startsWith(basePath) ? pageRouteOf(pathname.slice(basePath.length)) : null;
    if (pageCall !== null) {
      if (request.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method_not_allowed", trace_id: traceId }, traceId);
      }
      return handlePageCall(request, pageCall, pageDepsOf(gatewayDeps(env)), { environment, version });
    }

    if (request.method === "GET" && pathname === `${basePath}/health`) {
      console.log(JSON.stringify({ level: "info", msg: "health", trace_id: traceId, environment, version }));
      return jsonResponse(
        200,
        { ok: true, service: "rosie", environment, version, trace_id: traceId },
        traceId,
      );
    }

    // web's pages (T-1192): web's answer, sent as it is; a path that is no page's goes on to the 404.
    const page = servePage(request, env.BASE_PATH);
    if (page !== null) return page;

    console.log(JSON.stringify({ level: "info", msg: "not_found", trace_id: traceId, environment, version }));
    return jsonResponse(404, { ok: false, error: "not_found", trace_id: traceId }, traceId);
  };
  // The cast states the arity rule of RosieWorker: the runtime's three-argument call may get a Promise (the webhook).
  return { fetch: fetch as RosieWorker["fetch"], scheduled, queue: retryQueueHandler };
}

// The composition root's gateway for the Worker's environment (T-550). Until its joins land (T-552 to T-564) every port not
// joined is closed there, so its doors fail and each provider route answers 503 (a Stripe request with an unreadable
// signature header, 401); the provider doors stay unconfigured (T-275). The Linq route is the root's (T-552's security
// review): 404 while the skeleton flag is off, which it is wherever no release flags are bound (D-017's rollback).
const rosie = createWorker(
  (env) => workerRoot(env).gateway,
  clockActorsOf,
  (request, env) => workerRoot(env).linqWebhook(request),
);

// The actor's ports are wired on the Worker's first request, where the HandleActor namespace is bound (T-553; DL-313
// ruling 2: runtime/src/wiring wireWorker): never at module load, where Workers refuse crypto.randomUUID(), and not in the
// Workers test pool or on staging, which have no binding until T-566.
const fetchAndWire = (
  request: Request,
  env: Cloudflare.Env,
  context: ExecutionContext,
): Response | Promise<Response> => {
  wireWorker(env);
  return rosie.fetch(request, env, context);
};

// The cast states the arity rule of RosieWorker, as createWorker's does.
export default { ...rosie, fetch: fetchAndWire as RosieWorker["fetch"] } satisfies RosieWorker;
