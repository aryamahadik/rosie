// The gateway's answer rules (T-241; C-044; arch 02 step 1 "Receive", line 109), shared by every webhook door: Linq's
// (linq-webhook.ts) and the Stripe and calendar doors (providers/, T-275). Every answer is JSON carrying the trace id in
// its body and in x-trace-id, never cached. A failure is logged as one JSON line with its stage and the error's name only
// (its message could carry words from a body); for the Linq adapter's LinqWebhookError, its code beside the name (one of
// its four labels, never a field value: T-1456), so each 503 the Linq verify answers for it says why. The hand-off's line
// (T-1465) names two labels more, each from a closed list and never a field value: the event's K-06 kind, and the label
// the door's refusal carries (HANDOFF_REFUSALS), so each 503 a door answers says which kind failed and why. The bundle id
// is read at receipt, with bundle v0's as the stand-in.

import type { LinqWebhookError } from "@rosie/adapters/linq/webhook";

import { isLabel, logSink, openTrace, type BundleId, type OpenedBy, type TraceContext } from "../trace";
import { ACTOR_KINDS, RECEIPT_KINDS } from "./hand-off";

/** Bundle v0's id (K-01 bundle-v0-skeleton), the stand-in until a bundle registry can be read (K-08 README default 1). */
export const DEFAULT_BUNDLE_ID: BundleId = {
  hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
  build: 1,
};

/**
 * One webhook answer: its status and, for anything but a 200, a label naming why (never a value from the request). A 413
 * is a body over its door's cap (T-1180, body.ts).
 */
export interface Answer {
  status: 200 | 400 | 401 | 413 | 503;
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

/**
 * LinqWebhookError's four codes (T-413, adapters/src/linq/webhook/parse.ts), each a label. The type holds this list to
 * the adapter's own: a code added there and not here, or kept here and dropped there, fails the typecheck.
 */
const LINQ_WEBHOOK_CODES: Readonly<Record<LinqWebhookError["code"], true>> = {
  badEvent: true,
  unsupportedWebhookVersion: true,
  unknownService: true,
  receiptHandleUnknown: true,
};

/**
 * The code of a LinqWebhookError (an Error by that name) when it is one of the four labels; null for any other error, and
 * for a code that is none of them, so nothing but a label is ever logged for it.
 */
function linqWebhookCodeOf(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== "LinqWebhookError") return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(LINQ_WEBHOOK_CODES, code) ? code : null;
}

/**
 * The labels a door's refusal of a hand-off may carry (T-1465), as the `code` of the WiringError it rejects with: a
 * closed list, each a label and never prose built from a value. The receipt door's (runtime/src/wiring/root.ts):
 * - failedReceiptNoDoor: a `failed` receipt (Linq's message.failed and poll.failed). The dispatcher's retry or next way
 *   must act on it (arch 02 step 8), and no door does yet.
 * - smsSentReceiptNoDoor: a `sent` receipt on SMS, which is SMS's delivery receipt and arms the clock (arch 02 step 9;
 *   runtime/src/clocks/due.ts isDeliveryReceipt), and no door takes it yet.
 * - receiptKindNoDoor: a kind the receipt door has no door for at all (none the gateway routes there today).
 * - deliveredReceiptNoStatus: a `delivered` receipt whose status holds no message id or no time.
 * - outboxStoreNoAnswer: the outbox store gave no answer to the receipt's mark.
 * Each is answered 503, so Linq sends the event again.
 */
export const HANDOFF_REFUSALS = {
  failedReceiptNoDoor: true,
  smsSentReceiptNoDoor: true,
  receiptKindNoDoor: true,
  deliveredReceiptNoStatus: true,
  outboxStoreNoAnswer: true,
} as const;

/** One label of HANDOFF_REFUSALS. */
export type HandoffRefusal = keyof typeof HANDOFF_REFUSALS;

/** What a hand-off's failure line says where the error carries no label of HANDOFF_REFUSALS. */
const UNLABELED = "unlabeled";

/** Every K-06 kind the gateway hands on (./hand-off.ts): the closed list a failure line's `kind` is read against. */
const HANDOFF_KINDS: ReadonlySet<unknown> = new Set<unknown>([...ACTOR_KINDS, ...RECEIPT_KINDS]);

/**
 * The refusal label of a failed hand-off: the code of a WiringError (an Error by that name) when it is one of
 * HANDOFF_REFUSALS; "unlabeled" for any other error and for a code that is none of them, so nothing but a label of the
 * list is ever logged for it.
 */
function handoffRefusalOf(error: unknown): string {
  if (!(error instanceof Error) || error.name !== "WiringError") return UNLABELED;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(HANDOFF_REFUSALS, code) ? code : UNLABELED;
}

/** The kind as a label: the K-06 kind when it is one the gateway hands on, "unknown" for anything else. */
function handoffKindOf(kind: unknown): string {
  return typeof kind === "string" && HANDOFF_KINDS.has(kind) ? kind : "unknown";
}

/**
 * One JSON log line for a failed stage: the error's name only, since its message could carry words from the body; for a
 * LinqWebhookError, its code beside it (linqWebhookCodeOf: one of its four labels), and for every other error nothing more.
 * Handed the event of a failed hand-off (T-1465), the line also names its K-06 kind and the door's refusal label
 * (handoffKindOf, handoffRefusalOf): each a label of its closed list, never the event's own value, a chat id or a number.
 */
export function logFailure(
  traceId: string,
  stage: string,
  error: unknown,
  handoff?: { readonly kind: string },
): void {
  const name = error instanceof Error ? error.name : "unknown";
  const code = linqWebhookCodeOf(error);
  console.log(
    JSON.stringify({
      level: "error",
      msg: "gateway_failed",
      trace_id: traceId,
      stage,
      error: name,
      ...(code === null ? {} : { code }),
      ...(handoff === undefined
        ? {}
        : { kind: handoffKindOf(handoff.kind), refusal: handoffRefusalOf(error) }),
    }),
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
