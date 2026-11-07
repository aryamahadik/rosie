// The Linq webhook entry (T-241; C-044; arch 02 step 1 "Receive", line 109).
//
// Answers: a bad or stale signature 401, with nothing written or handed on; a signed event type Rosie does not use 200,
// handed on to no one; a known event id 200 and dropped; a failing scrub-seal-write (a key store that gives no key, a
// seal or a write that fails, an event it cannot route, a verify result it does not know, or a verifier that cannot
// answer) 503, so Linq retries for 30 minutes, with nothing stored; otherwise 200. After the verify the event is
// scrubbed, then (texts, photos, reactions, votes, edits) sealed and written to the handle's actor, or (receipts) handed
// scrubbed to the dispatcher's door (hand-off.ts). The trace id opens at receipt, one K-08 `receive` span ends every answer,
// and the answer carries x-trace-id. Never logged: a body, a phone number, the webhook secret.

import { isLabel, logSink, openTrace, type BundleId, type TraceContext } from "../trace";
import { HandoffError, prepareHandoff } from "./hand-off";
import type { GatewayDeps, StoreAnswer, VerifyWebhookResult } from "./types";

/** Bundle v0's id (K-01 bundle-v0-skeleton), the stand-in until a bundle registry can be read (K-08 README default 1). */
export const DEFAULT_BUNDLE_ID: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

// The webhook's headers by Linq's standard names (K-11 README spike row 2). The adapter's wire format is T-413's; these
// three names only fill K-11's request fields, and a missing one becomes "" (the schema's own rule for `signature`).
const HEADER_ID = "webhook-id";
const HEADER_TIMESTAMP = "webhook-timestamp";
const HEADER_SIGNATURE = "webhook-signature";

interface Answer {
  status: 200 | 400 | 401 | 503;
  error?: string;
}

function respond(answer: Answer, traceId: string): Response {
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

function logFailure(traceId: string, stage: string, error: unknown): void {
  // The error's name only: its message could carry words from the body.
  const name = error instanceof Error ? error.name : "unknown";
  console.log(
    JSON.stringify({ level: "error", msg: "gateway_failed", trace_id: traceId, stage, error: name }),
  );
}

async function readBundleId(deps: GatewayDeps): Promise<BundleId> {
  try {
    return await deps.bundleId();
  } catch {
    return DEFAULT_BUNDLE_ID;
  }
}

function openContext(
  deps: GatewayDeps,
  bundleId: BundleId,
  environment: string,
  version: string,
): TraceContext {
  const options = {
    openedBy: "textWebhook" as const,
    sink: logSink({ environment, version }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  try {
    return openTrace({ ...options, bundleId });
  } catch {
    return openTrace({ ...options, bundleId: DEFAULT_BUNDLE_ID });
  }
}

export interface WebhookEnvironment {
  environment: string;
  version: string;
}

/**
 * Handles one Linq webhook POST. The unsigned request's own x-trace-id is not kept: a webhook comes from Linq, which
 * knows no Rosie trace, so the id is always new.
 */
export async function handleLinqWebhook(
  request: Request,
  deps: GatewayDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const bundleId = await readBundleId(deps);
  const context = openContext(deps, bundleId, where.environment, where.version);
  const timing = context.start("receive");
  const receivedAt = new Date(now()).toISOString();

  let eventId: string | undefined;
  let got: Record<string, string> = {};
  let answer: Answer = { status: 503, error: "unavailable" };
  let outcome: "ok" | "dropped" | "refused" | "failed" = "failed";
  let decided: Record<string, boolean | number> = {};
  let errorCode: string | null = null;

  const fail = (status: 400 | 503, error: string, code: string): void => {
    answer = { status, error };
    outcome = status === 400 ? "refused" : "failed";
    errorCode = code;
  };

  let raw: string | undefined;
  try {
    raw = await request.text();
  } catch (error) {
    logFailure(context.traceId, "readBody", error);
  }

  if (raw === undefined) {
    fail(400, "bad_request", "unreadableBody");
  } else {
    let verified: VerifyWebhookResult | undefined;
    try {
      verified = await deps.linq.verifyWebhook({
        webhookId: request.headers.get(HEADER_ID) ?? "",
        timestamp: request.headers.get(HEADER_TIMESTAMP) ?? "",
        signature: request.headers.get(HEADER_SIGNATURE) ?? "",
        raw,
        receivedAt,
        traceId: context.traceId,
      });
    } catch (error) {
      logFailure(context.traceId, "verify", error);
    }

    if (verified === undefined) {
      fail(503, "unavailable", "verifyUnavailable");
    } else if (verified.result === "rejected") {
      answer = { status: 401, error: "unauthorized" };
      outcome = "refused";
      decided = { signatureValid: false, answered: 401 };
      errorCode = verified.reason;
    } else if (verified.result === "ignored") {
      answer = { status: 200 };
      outcome = "dropped";
      decided = { signatureValid: true, ignoredType: true, answered: 200 };
      got = { eventType: verified.eventType };
    } else if (isNotEvent(verified.result)) {
      // A K-11 minor version that adds a result is not handed on as an event: fail closed, never 200.
      fail(503, "unavailable", "unknownVerifyResult");
    } else if (typeof verified.event.eventId !== "string" || verified.event.eventId === "") {
      fail(503, "unavailable", "badVerifyAnswer");
    } else {
      const { event, partKey } = verified;
      eventId = event.eventId;
      got = { kind: event.kind, service: event.service };
      let stored: StoreAnswer | undefined;
      let stage = "prepare";
      let code = "handoffFailed";
      try {
        // Scrub, then seal (actor kinds), then write: the door never gets an unscrubbed or an unsealed body.
        const prepared = await prepareHandoff(
          { event, partKey, traceId: context.traceId, bundleId },
          deps.keys,
        );
        stage = "handoff";
        stored =
          prepared.door === "actor"
            ? await deps.actor.accept(prepared.handoff)
            : await deps.receipts.accept(prepared.handoff);
      } catch (error) {
        logFailure(context.traceId, stage, error);
        if (stage === "prepare") code = error instanceof HandoffError ? error.code : "sealFailed";
      }
      // 200 only for a positive answer of the door: anything else, an unknown word included, is 503.
      if (stored === "duplicate") {
        answer = { status: 200 };
        outcome = "dropped";
        decided = { signatureValid: true, knownEventId: true, answered: 200 };
      } else if (stored === "written") {
        answer = { status: 200 };
        outcome = "ok";
        decided = { signatureValid: true, knownEventId: false, answered: 200 };
      } else {
        decided = { signatureValid: true, answered: 503 };
        fail(503, "unavailable", code);
      }
    }
  }

  try {
    timing.finish({
      outcome: outcome,
      provider: "linq",
      ...(eventId !== undefined && isLabel(eventId) ? { eventId } : {}),
      got: sanitizeFacts(got),
      decided,
      errorCode,
    });
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    logFailure(context.traceId, "span", error);
  }
  return respond(answer, context.traceId);
}

/** The positive check: the verify result is an event, by its own word. The type holds three results; a later one reads as not an event. */
function isNotEvent(result: string): boolean {
  return result !== "event";
}

/** Keeps only the facts that are labels: a kind or service the port gave that is not one would make the span refused. */
function sanitizeFacts(facts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => isLabel(value)));
}
