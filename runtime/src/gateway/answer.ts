// The gateway's answer rules (T-241; C-044; arch 02 step 1 "Receive", line 109), shared by every webhook door: Linq's
// (linq-webhook.ts) and the Stripe and calendar doors (providers/, T-275). Every answer is JSON carrying the trace id in
// its body and in x-trace-id, never cached. A failure is logged as one JSON line with its stage and the error's name only
// (its message could carry words from a body). The bundle id is read at receipt, with bundle v0's as the stand-in.

import { isLabel, logSink, openTrace, type BundleId, type OpenedBy, type TraceContext } from "../trace";

/** Bundle v0's id (K-01 bundle-v0-skeleton), the stand-in until a bundle registry can be read (K-08 README default 1). */
export const DEFAULT_BUNDLE_ID: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

/** One webhook answer: its status and, for anything but a 200, a label naming why (never a value from the request). */
export interface Answer {
  status: 200 | 400 | 401 | 503;
  error?: string;
}

/** The answer as the provider gets it: JSON with the trace id, the same id in x-trace-id, never cached. */
export function respond(answer: Answer, traceId: string): Response {
  const body =
    answer.error === undefined
      ? { ok: true, trace_id: traceId }
      : { ok: false, error: answer.error, trace_id: traceId };
  return new Response(JSON.stringify(body), {
    status: answer.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-trace-id": traceId,
    },
  });
}

/** One JSON log line for a failed stage: the error's name only, since its message could carry words from the body. */
export function logFailure(traceId: string, stage: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "unknown";
  console.log(
    JSON.stringify({ level: "error", msg: "gateway_failed", trace_id: traceId, stage, error: name }),
  );
}

/** Where the Worker runs, for every log line (ADR-009). */
export interface WebhookEnvironment {
  environment: string;
  version: string;
}

/** What a door needs to open its trace: the active bundle id read at receipt and the clock. */
export interface TraceDeps {
  /** The active bundle id read at receipt (K-08 v1 README default 1). */
  bundleId: () => BundleId | Promise<BundleId>;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
}

/** The active bundle id, or bundle v0's when it cannot be read: a span never goes without one. */
export async function readBundleId(deps: TraceDeps): Promise<BundleId> {
  try {
    return await deps.bundleId();
  } catch {
    return DEFAULT_BUNDLE_ID;
  }
}

/**
 * Opens the trace of one webhook (K-08 v1 `opened_by`: a text's webhook or a provider's). The request's own x-trace-id
 * is never kept: a webhook comes from a provider, which knows no Rosie trace, so the id is always new.
 */
export function openWebhookTrace(
  deps: TraceDeps,
  bundleId: BundleId,
  where: WebhookEnvironment,
  openedBy: OpenedBy,
): TraceContext {
  const options = {
    openedBy,
    sink: logSink({ environment: where.environment, version: where.version }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  try {
    return openTrace({ ...options, bundleId });
  } catch {
    return openTrace({ ...options, bundleId: DEFAULT_BUNDLE_ID });
  }
}

/** Keeps only the facts that are labels: a value a port gave that is not one would make the span refused. */
export function labelFacts(facts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => isLabel(value)));
}
