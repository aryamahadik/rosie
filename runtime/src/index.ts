// Rosie's Worker. Routes (factory spec 6; T-241; T-275): GET {BASE_PATH}/health, and the gateway's webhooks, each a POST
// under BASE_PATH: /webhooks/linq; Stripe's /webhooks/stripe/rosfield and /webhooks/stripe/businesses; the calendars'
// /webhooks/calendar/google and /webhooks/calendar/microsoft.
// Every request carries one trace id: the incoming x-trace-id when it is a valid id (a UUID), else a new one.
// The id is returned in the x-trace-id header and the JSON body, and written in one JSON log line (Workers Logs).
// Each webhook opens its own id at receipt (runtime/src/gateway).
// The scheduled handler is the clock rows' minute sweep (T-254, runtime/src/clocks), on T-278's one-minute cron.
// The gateway's doors come from the composition root (T-550, runtime/src/wiring), which picks each port's implementation
// for the Worker's environment. The Worker's Linq route is the root's, behind the skeleton flag (T-552, T-553).

import { clockActorsOf, sweepClocks, type ClockActors } from "./clocks";
import {
  handleLinqWebhook,
  handleProviderWebhook,
  LINQ_WEBHOOK_PATH,
  providerDepsOf,
  providerRouteOf,
  type GatewayDeps,
} from "./gateway";
import { workerRoot } from "./wiring";

// The HandleActor Durable Object (T-244): the Workers runtime finds the class named in wrangler.jsonc here.
export { HandleActor } from "./actor";

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
 * The health and 404 answers are synchronous (the health tests read them without waiting); the webhooks answer later.
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

    if (request.method === "GET" && pathname === `${basePath}/health`) {
      console.log(JSON.stringify({ level: "info", msg: "health", trace_id: traceId, environment, version }));
      return jsonResponse(
        200,
        { ok: true, service: "rosie", environment, version, trace_id: traceId },
        traceId,
      );
    }
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
export default createWorker(
  (env) => workerRoot(env).gateway,
  clockActorsOf,
  (request, env) => workerRoot(env).linqWebhook(request),
);
