// The gateway's two doors (T-241; C-044): the Linq port it verifies through (K-11 v1) and the actor it hands the event to.
// Both are interfaces, so the gateway holds no signature algorithm, no Linq wire format and no storage:
// - The signature algorithm and Linq's wire format are the Linq adapter's (C-207, T-413).
// - Sealing the event and writing it to the handle's actor is T-243's; the scrub is T-242's (runtime/src/scrub).

import type { BundleId } from "../trace";

/** K-06 v1's inbound event, as far as the gateway reads it; the rest rides through untouched, sealed by the actor (T-243). */
export interface InboundEvent {
  eventId: string;
  provider: string;
  kind: string;
  service: string;
  traceId: string;
  readonly [field: string]: unknown;
}

/** K-11 v1 `verifyWebhook.request`: one webhook before any parsing. */
export interface VerifyWebhookRequest {
  webhookId: string;
  timestamp: string;
  signature: string;
  raw: string;
  receivedAt: string;
  traceId: string;
}

/** K-11 v1 `verifyWebhook.response` and its rejection (`rejected` is answered 401 by the gateway). */
export type VerifyWebhookResult =
  | { result: "event"; httpStatus: 200; event: InboundEvent; partKey: string | null }
  | { result: "ignored"; httpStatus: 200; eventType: string }
  | {
      result: "rejected";
      httpStatus: 401;
      reason: "badTimestamp" | "staleTimestamp" | "badSignature";
    };

/** The slice of K-11 v1 the gateway uses. The Linq adapter (C-207) and the Linq double (C-211) fill it. */
export interface LinqPort {
  verifyWebhook(request: VerifyWebhookRequest): Promise<VerifyWebhookResult>;
}

/** What the gateway hands the actor: the event with `partKey` beside it (K-11 README: K-06 does not change). */
export interface ActorHandoff {
  event: InboundEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
}

/**
 * The actor's door (T-243 fills it). `written`: the event is stored. `duplicate`: its event id is already known and
 * nothing was written. A throw or a rejected promise means the write failed: the gateway answers 503.
 *
 * The seen-event-id check lives behind this door, in the handle actor's own storage, in the same step as the write:
 * two retries of one event that arrive together cannot both pass a check that sits apart from the write, and the
 * actor is the one place that already owns the handle's rows. No wrangler binding is added here (NQ-RT-5).
 */
export interface ActorStub {
  accept(handoff: ActorHandoff): Promise<"written" | "duplicate">;
}

export interface GatewayDeps {
  linq: LinqPort;
  actor: ActorStub;
  /** The active bundle id read at receipt (K-08 v1 README default 1). */
  bundleId: () => BundleId | Promise<BundleId>;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
}
