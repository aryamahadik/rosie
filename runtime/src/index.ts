// Rosie's Worker. Routes (factory spec 6; T-241): GET {BASE_PATH}/health and POST {BASE_PATH}/webhooks/linq (the gateway).
// Every request carries one trace id: the incoming x-trace-id when it is a valid id (a UUID), else a new one.
// The id is returned in the x-trace-id header and the JSON body, and written in one JSON log line (Workers Logs).
// The Linq webhook opens its own id at receipt (runtime/src/gateway).
// The scheduled handler is the clock rows' minute sweep (T-254, runtime/src/clocks), on T-278's one-minute cron.

import { clockActorsOf, sweepClocks, type ClockActors } from "./clocks";
import { handleLinqWebhook, LINQ_WEBHOOK_PATH, unconfiguredGateway, type GatewayDeps } from "./gateway";

// The HandleActor Durable Object (T-244): the Workers runtime finds the class named in wrangler.jsonc here.
export { HandleActor } from "./actor";

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
 * The health and 404 answers are synchronous (the health tests read them without waiting); the Linq webhook answers
 * later. The Workers runtime always passes the execution context, so its call is the second form.
 */
export interface RosieWorker {
  fetch(request: Request, env: Cloudflare.Env): Response;
  fetch(request: Request, env: Cloudflare.Env, context: ExecutionContext): Response | Promise<Response>;
  /** The one-minute cron (T-278's trigger): the clock rows' sweep, kept alive with the context's waitUntil (T-254). */
  scheduled(controller: ScheduledController, env: Cloudflare.Env, context: ExecutionContext): void;
}

/**
 * The Worker with the gateway's doors (the Linq adapter, the handle actor) supplied by `gatewayDeps`, and the sweep's
 * HandleActor namespace by `clockActors` (the HANDLE_ACTOR binding by default).
 */
export function createWorker(
  gatewayDeps: (env: Cloudflare.Env) => GatewayDeps,
  clockActors: (env: Cloudflare.Env) => ClockActors | null = clockActorsOf,
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
      return handleLinqWebhook(request, gatewayDeps(env), { environment, version });
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
  return { fetch: fetch as RosieWorker["fetch"], scheduled };
}

// Until the Linq adapter (T-413) and the handle actor (T-243) exist, the gateway's doors fail and the route answers 503.
export default createWorker(() => unconfiguredGateway());
