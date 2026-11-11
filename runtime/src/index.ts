// Rosie's Worker. Routes (factory spec 6; T-241; T-275; T-266): GET {BASE_PATH}/health, and the gateway's webhooks, each a
// POST under BASE_PATH: /webhooks/linq; Resend's /webhooks/resend, for email's delivery events and inbound replies (T-265;
// closed, answering 503, until the composition root binds the email port); Stripe's /webhooks/stripe/rosfield and
// /webhooks/stripe/businesses; the calendars'
// /webhooks/calendar/google and /webhooks/calendar/microsoft. And the page entry: the web app's K-21 v1 page and console
// calls, each a POST to {BASE_PATH}/page-api/<call>, handed to the action layer's handler for that call; a staging-only
// call answers stagingOnly wherever ENVIRONMENT is not staging (runtime/src/gateway/pages).
// Then, last before the 404, web's pages (T-1171, T-1192, T-1234): the web app shell (@rosie/web, T-511;
// web/src/shell/shell.ts), made from the Worker's vars (ENVIRONMENT, BASE_PATH, LINK_HOST), answers each address under
// BASE_PATH that one of its routes takes. That is the privacy notice at {BASE_PATH}/privacy (rosfield.com/test/privacy on
// staging), the address on the last line of Rosie's first text (RULES 4.3), and every route a feature folder lists
// (web/src/routes.ts), staging's test tools only where ENVIRONMENT is exactly staging. So a route the web lane adds is
// served with no change here. The shell's answer is sent as web made it, as every shell page is (CQ-209 (a)): GET and
// HEAD get the page, any method the route does not take the shell's 405 page; the headers set no cookie and the content
// security policy allows nothing but the page's own style; the request's trace id is in x-trace-id, and one JSON log
// line holds that id, the route's fixed label and the status, and nothing of the request or the reader.
// An address no route of the shell takes goes on to the Worker's own 404, which is as it was: the shell's `serve` gives
// null there and logs nothing.
// A page's K-21 calls reach the page entry in process, through the same answer the /page-api route gives, never by a
// fetch back to the Worker: no address is fetched, so no redirect can be followed, and an answer that is not the
// entry's 200 gives the page no outcome (T-511's security note a).
// A page request the shell itself cannot answer gets a plain 500 with its trace id and that one log line: vars the
// shell cannot be made from, or a failure outside a route's handler, where the shell has no 500 page of its own.
// Every other request carries one trace id: the incoming x-trace-id when it is a valid id (a UUID), else a new one.
// The id is returned in the x-trace-id header and the JSON body, and written in one JSON log line (Workers Logs).
// Each webhook opens its own id at receipt, and each page call its own, keeping a valid incoming one (runtime/src/gateway);
// a page call's 200 carries only its K-21 outcome, so its id is in the header alone.
// The scheduled handler is the clock rows' minute sweep (T-254, runtime/src/clocks), on T-278's one-minute cron.
// The gateway's doors come from the composition root (T-550, runtime/src/wiring), which picks each port's implementation
// for the Worker's environment. The Worker's Linq route is the root's, behind the skeleton flag (T-552, T-553).

import { pageEntryTransport, type PageApiTransport } from "@rosie/web/src/client/client";
import { readWebConfig, WebConfigError, type WebConfig } from "@rosie/web/src/shell/config";
import { createWebShell, type PageLogLine, type ShellDeps, type WebShell } from "@rosie/web/src/shell/shell";
import { CONFIG_LABEL } from "@rosie/web/src/shell/worker";

import { clockActorsOf, sweepClocks, type ClockActors } from "./clocks";
import {
  emailDepsOf,
  handleLinqWebhook,
  handlePageCall,
  handleProviderWebhook,
  handleResendWebhook,
  LINQ_WEBHOOK_PATH,
  pageDepsOf,
  pageRouteOf,
  providerDepsOf,
  providerRouteOf,
  RESEND_WEBHOOK_PATH,
  type GatewayDeps,
  type PageCallName,
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
      /**
       * The host every link starts with, a bare host such as rosfield.com (wrangler.jsonc vars in every environment,
       * T-1235). Only the web shell reads it, checked with ENVIRONMENT and BASE_PATH (web/src/shell/config.ts): where
       * it is missing or no host, web's pages answer a plain 500 and every other route answers as ever. So the type
       * lets it be missing, as an env built by hand for a route that serves no page leaves it out.
       */
      LINK_HOST?: string;
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
 * The label the page log line gives a page request the shell failed to answer: a failure of the shell's own, outside a
 * route's handler. A handler's own failure is the shell's 500 page, under the route's label.
 */
const SHELL_FAILED_LABEL = "shellFailed";

/**
 * The answer to a page request the shell gave no answer to: a plain 500 with the trace id in x-trace-id, and the
 * shell's one log line for it (web/src/shell/shell.ts PageLogLine): the trace id, a fixed label and the status, and
 * nothing of the request or of what was thrown. The words and the headers are those of web's own entry for vars it
 * cannot run on (web/src/shell/worker.ts).
 */
function pageFailed(traceId: string, route: string, log: (line: string) => void): Response {
  const line: PageLogLine = { level: "error", msg: "page", trace_id: traceId, route, status: 500 };
  log(JSON.stringify(line));
  return new Response("The page could not be shown.\n", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-trace-id": traceId,
    },
  });
}

/**
 * The health answer and the 404 are synchronous (the health tests read them without waiting); the webhooks, the page
 * calls and web's pages answer later.
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

/** The Worker's answer to one K-21 call's POST on the page entry's path. */
export type PageCallRoute = (request: Request, call: PageCallName, env: Cloudflare.Env) => Promise<Response>;

/**
 * What web's pages are served from beside the Worker's vars (T-1234). The Worker that is deployed hands in none of it,
 * so it serves web's own lists; a test hands in routes of its own.
 */
export interface WebPages {
  /**
   * The shell's parts other than its config and its transport (web/src/shell/shell.ts ShellDeps): the static pages and
   * the feature folders' route modules (web/src/routes.ts when left out), the log (console.log) and the trace id maker.
   */
  shell?: Omit<ShellDeps, "config" | "transport">;
  /**
   * A K-21 call's POST, answered: by default the gateway's page entry with the Worker's doors (handlePageCall). The
   * /page-api route and a page's own calls, in process, both go through it.
   */
  pageCall?: PageCallRoute;
}

/**
 * The Worker with the gateway's doors (the Linq adapter, the handle actor, and the Stripe and calendar doors' ports and
 * store) supplied by `gatewayDeps`, the sweep's HandleActor namespace by `clockActors` (the HANDLE_ACTOR binding by
 * default), the Linq webhook POST answered by `linqWebhook` (by default the gateway's Linq entry with those doors), and
 * web's pages served from `web` (by default web's own routes, and the gateway's page entry for a page's calls).
 */
export function createWorker(
  gatewayDeps: (env: Cloudflare.Env) => GatewayDeps,
  clockActors: (env: Cloudflare.Env) => ClockActors | null = clockActorsOf,
  linqWebhook: LinqWebhookRoute = (request, env) =>
    handleLinqWebhook(request, gatewayDeps(env), {
      environment: env.ENVIRONMENT,
      version: env.GIT_SHA ?? "unknown",
    }),
  web: WebPages = {},
): RosieWorker {
  const pageCall: PageCallRoute =
    web.pageCall ??
    ((request, call, env) =>
      handlePageCall(request, call, pageDepsOf(gatewayDeps(env)), {
        environment: env.ENVIRONMENT,
        version: env.GIT_SHA ?? "unknown",
      }));

  /**
   * How a page's K-21 calls reach the page entry (web/src/client/client.ts pageEntryTransport): in process, through
   * `pageCall`, the answer the /page-api route gives, never by a fetch back to the Worker. So nothing is ever fetched
   * at the address below and no redirect can be followed, with a body or without (T-511's security note a): the
   * transport takes the entry's 200 alone as an outcome, and throws for any other status, a 3xx among them, as refused
   * at the edge. The address is built from the config alone (LINK_HOST and BASE_PATH), never from the page request.
   * A call's name is web's (web/src/client/calls.ts) handed to the gateway's as it is: both are K-21 v1's list, and the
   * type check fails here if web ever names a call the gateway does not route.
   */
  const pageTransport = (config: WebConfig, env: Cloudflare.Env): PageApiTransport => ({
    send: (call, request, traceId) =>
      pageEntryTransport({
        baseUrl: `https://${config.linkHost}${config.basePath}`,
        send: (posted) => pageCall(posted, call, env),
      }).send(call, request, traceId),
  });

  // One shell for each env the runtime hands in (an isolate keeps one), made by the first request that reaches web's
  // pages: a request the routes before them answer never needs the shell's vars.
  const shells = new WeakMap<Cloudflare.Env, WebShell>();
  const shellOf = (env: Cloudflare.Env): WebShell => {
    const made = shells.get(env);
    if (made !== undefined) return made;
    const config = readWebConfig(env);
    const shell = createWebShell({ ...web.shell, config, transport: pageTransport(config, env) });
    shells.set(env, shell);
    return shell;
  };
  const logPage =
    web.shell?.log ??
    ((line: string) => {
      console.log(line);
    });

  /**
   * web's answer to the request when a route of the shell takes its address (shell.serve), else null, and the Worker's
   * 404 answers. A page request the shell itself cannot answer gets `pageFailed`'s plain 500 under the request's trace
   * id: vars the shell cannot be made from (WebConfigError, under the label web's own entry logs: no page is known
   * without them, so every request that comes this far gets it), a route list the shell refuses, and anything thrown
   * outside a route's handler, where the shell has no 500 page of its own (T-511's security note d: a handler's
   * Response whose body was already read).
   */
  const pageOf = (request: Request, env: Cloudflare.Env, traceId: string): Promise<Response> | null => {
    let served: Promise<Response> | null;
    try {
      served = shellOf(env).serve(request);
    } catch (error) {
      const label = error instanceof WebConfigError ? CONFIG_LABEL : SHELL_FAILED_LABEL;
      return Promise.resolve(pageFailed(traceId, label, logPage));
    }
    if (served === null) return null;
    return served.catch(() => pageFailed(traceId, SHELL_FAILED_LABEL, logPage));
  };

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

    // The Resend webhook door (T-265): email's delivery events and inbound replies, through the gateway's email port.
    if (pathname === `${basePath}${RESEND_WEBHOOK_PATH}`) {
      if (request.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method_not_allowed", trace_id: traceId }, traceId);
      }
      return handleResendWebhook(request, emailDepsOf(gatewayDeps(env)), { environment, version });
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

    const call = pathname.startsWith(basePath) ? pageRouteOf(pathname.slice(basePath.length)) : null;
    if (call !== null) {
      if (request.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method_not_allowed", trace_id: traceId }, traceId);
      }
      return pageCall(request, call, env);
    }

    if (request.method === "GET" && pathname === `${basePath}/health`) {
      console.log(JSON.stringify({ level: "info", msg: "health", trace_id: traceId, environment, version }));
      return jsonResponse(
        200,
        { ok: true, service: "rosie", environment, version, trace_id: traceId },
        traceId,
      );
    }

    // web's pages (T-1192, T-1234): the shell's answer, sent as it is; an address no route takes goes on to the 404.
    const page = pageOf(request, env, traceId);
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
// ruling 2: runtime/src/wiring wireWorker; env.staging binds it since T-566, and the Workers test pool runs env.staging):
// never at module load, where Workers refuse crypto.randomUUID().
const fetchAndWire = (
  request: Request,
  env: Cloudflare.Env,
  context: ExecutionContext,
): Response | Promise<Response> => {
  wireWorker(env);
  return rosie.fetch(request, env, context);
};

// A retry batch can be the first event an isolate sees (T-1223): the queue hands it to an isolate that may have served no
// request. So the queue entry wires the isolate first, exactly as the fetch entry does (the root's install() sets the retry
// queue's ports with the actor's), and the batch's tries run at once instead of answering "unwired" and coming back a
// minute later. Production gets its own root, every port closed, as the fetch entry wires it. The scheduled entry is not
// wired: the minute sweep reads the clock firing's ports (setClockDeps), which the root does not install.
const queueAndWire = (batch: MessageBatch, env: Cloudflare.Env): Promise<void> => {
  wireWorker(env);
  return rosie.queue(batch, env);
};

// The cast states the arity rule of RosieWorker, as createWorker's does.
export default {
  ...rosie,
  fetch: fetchAndWire as RosieWorker["fetch"],
  queue: queueAndWire,
} satisfies RosieWorker;
