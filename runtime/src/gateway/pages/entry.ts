// The page entry (T-266; C-044; arch 02 layer table "Edge", line 133: "Secure pages and the agent API"; K-21 v1): the web
// app's page and console calls, each a POST to {BASE_PATH}/page-api/<call> (calls.ts), handed to the action layer's
// handler for that call (C-074; types.ts).
//
// For one call, in this order:
//   1. Its trace opens (K-08 v1 `opened_by` pageRequest; T-240; CQ-06): the request's x-trace-id when it is a valid id,
//      else a new one, under the active bundle id read at receipt (bundle v0's when none can be read, as the webhooks do).
//   2. A staging-only call anywhere but staging (ENVIRONMENT is not exactly "staging") answers K-21's stagingOnly at once:
//      its body is never read and no handler runs (BP 9.4 "Never in production"; fire-now-in-production.json, and
//      refuse-fire-now-in-production.json: no other answer there).
//   3. The body must be one JSON object, or the answer is 400 and no handler runs. The gateway checks nothing else in it:
//      the contract's checks are the handler's.
//   4. The call's handler gets the request, the trace and the environment. Its outcome, a response or one of the call's
//      errors, is sent as it is with 200. A handler that throws, or answers anything but an object JSON can send, gives
//      503 with no outcome, and the web app may send the call again (each K-21 call is safe to repeat by its own rule).
//
// Every answer is JSON with the trace id in x-trace-id, never cached. A 200 carries the call's K-21 outcome and nothing
// else, so the answers stay the contract's (the mock's, C-186); every other status is the edge's own answer, JSON
// { ok: false, error, trace_id }, as the webhooks and the 404 give it.
//
// One K-08 pageRequest span ends every answer: the call's name, the status, what was answered (response or an error's
// name) and the outcome. Never in a span or a log line: anything from the request (its body, session token, link code,
// typed words, even its envelope's ids), or a handler's error message (which could quote them); a failure's log line
// names its stage and the error's name only, and only when that name is a label.

import { isLabel, logSink, openTrace, type BundleId, type TraceContext } from "../../trace";
import { DEFAULT_BUNDLE_ID, readBundleId, respond, type WebhookEnvironment } from "../answer";
import { isStagingOnly, type PageCallName } from "./calls";
import type { PageDeps, PageOutcome } from "./types";

/** K-21's answer to a staging-only call anywhere but staging (K-21 v1 `$defs/stagingOnlyError`). */
export const STAGING_ONLY_OUTCOME: PageOutcome = Object.freeze({ error: "stagingOnly" });

/** The one ENVIRONMENT the staging-only calls run in (wrangler.jsonc env.staging); any other value is refused. */
const STAGING = "staging";

/** Errors that say the database could not run the call, rather than that it was refused (K-05 v1; arch 11 line 566). */
const FAILED_ERRORS: ReadonlySet<string> = new Set(["transient", "bookingPaused"]);

/** A handler not joined yet (`unconfiguredPages`): its call answers 503, and its span's error code is notConnected. */
export class PageNotConnectedError extends Error {
  override name = "PageNotConnectedError";
  readonly call: PageCallName;

  constructor(call: PageCallName) {
    super(`the page entry's ${call} handler is not connected yet`);
    this.call = call;
  }
}

/**
 * How one call ended. A 200 sends an outcome (`sent`, as JSON) and names what it was ("response" or the K-21 error's
 * name); a 400 or a 503 is the edge's own answer, with no outcome.
 */
type Ending =
  | {
      status: 200;
      sent: string;
      outcome: "ok" | "refused" | "failed";
      answer: string;
      errorCode: string | null;
    }
  | { status: 400 | 503; outcome: "refused" | "failed"; errorCode: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Handles one page or console call at its route. The caller has checked the method (POST). */
export async function handlePageCall(
  request: Request,
  call: PageCallName,
  deps: PageDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const bundleId = await readBundleId(deps);
  const trace = openPageTrace(deps, bundleId, where, request.headers.get("x-trace-id"));
  const timing = trace.start("pageRequest");

  const ending = await answerOf(request, call, deps, where, trace);

  try {
    timing.finish({
      outcome: ending.outcome,
      got: { pageCall: call },
      decided:
        ending.status === 200
          ? { answered: ending.status, answer: ending.answer }
          : { answered: ending.status },
      errorCode: ending.errorCode,
    });
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    logPageFailure(trace.traceId, "span", error);
  }

  if (ending.status === 200) return outcomeResponse(ending.sent, trace.traceId);
  return respond(
    { status: ending.status, error: ending.status === 400 ? "bad_request" : "unavailable" },
    trace.traceId,
  );
}

/** Steps 2 to 4: the staging-only refusal, the body, then the handler's outcome. */
async function answerOf(
  request: Request,
  call: PageCallName,
  deps: PageDeps,
  where: WebhookEnvironment,
  trace: TraceContext,
): Promise<Ending> {
  if (isStagingOnly(call) && where.environment !== STAGING) {
    return {
      status: 200,
      sent: JSON.stringify(STAGING_ONLY_OUTCOME),
      outcome: "refused",
      answer: "stagingOnly",
      errorCode: "stagingOnly",
    };
  }

  const body = await readObject(request, trace.traceId);
  if ("problem" in body) return { status: 400, outcome: "refused", errorCode: body.problem };

  let outcome: unknown;
  try {
    outcome = await deps.handlers[call]({
      call,
      request: body.request,
      trace,
      environment: where.environment,
    });
  } catch (error) {
    logPageFailure(trace.traceId, "pageHandler", error);
    const errorCode = error instanceof PageNotConnectedError ? "notConnected" : "handlerFailed";
    return { status: 503, outcome: "failed", errorCode };
  }

  const sent = isRecord(outcome) ? jsonOf(outcome) : undefined;
  if (!isRecord(outcome) || sent === undefined) {
    logPageFailure(trace.traceId, "pageAnswer", new TypeError("the handler gave no outcome"));
    return { status: 503, outcome: "failed", errorCode: "badHandlerAnswer" };
  }
  if (!Object.hasOwn(outcome, "error")) {
    return { status: 200, sent, outcome: "ok", answer: "response", errorCode: null };
  }
  const error = outcome.error;
  const code = typeof error === "string" && isLabel(error) ? error : "error";
  return {
    status: 200,
    sent,
    outcome: FAILED_ERRORS.has(code) ? "failed" : "refused",
    answer: code,
    errorCode: code,
  };
}

/**
 * Opens a page request's trace: the request's x-trace-id when it is a valid id, else a new one (T-240: a request start
 * keeps a valid incoming id), under the bundle id read at receipt, or bundle v0's when that one cannot open a trace.
 */
function openPageTrace(
  deps: PageDeps,
  bundleId: BundleId,
  where: WebhookEnvironment,
  incomingTraceId: string | null,
): TraceContext {
  const options = {
    openedBy: "pageRequest" as const,
    incomingTraceId,
    sink: logSink({ environment: where.environment, version: where.version }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  try {
    return openTrace({ ...options, bundleId });
  } catch {
    return openTrace({ ...options, bundleId: DEFAULT_BUNDLE_ID });
  }
}

/** The body as one JSON object, or why it is not one (a label for the span). Its text and the parser's message are never logged. */
async function readObject(
  request: Request,
  traceId: string,
): Promise<{ request: Record<string, unknown> } | { problem: "unreadableBody" | "notJson" | "notAnObject" }> {
  let text: string;
  try {
    text = await request.text();
  } catch (error) {
    logPageFailure(traceId, "readBody", error);
    return { problem: "unreadableBody" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message can quote the body, so nothing is logged.
    return { problem: "notJson" };
  }
  return isRecord(value) ? { request: value } : { problem: "notAnObject" };
}

/** The outcome as JSON, or undefined when JSON cannot send it (a cycle, a BigInt). */
function jsonOf(outcome: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(outcome);
  } catch {
    return undefined;
  }
}

/** The call's outcome as the web app gets it: the JSON as it is, the trace id in x-trace-id, never cached. */
function outcomeResponse(json: string, traceId: string): Response {
  return new Response(json, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-trace-id": traceId,
    },
  });
}

/**
 * One JSON log line for a failed stage: its name and the error's name, only when that is a label, since a handler's
 * error (its message, or a name it sets) could carry words from the request.
 */
function logPageFailure(traceId: string, stage: string, error: unknown): void {
  const name = error instanceof Error ? (isLabel(error.name) ? error.name : "error") : "unknown";
  console.log(
    JSON.stringify({ level: "error", msg: "gateway_failed", trace_id: traceId, stage, error: name }),
  );
}
