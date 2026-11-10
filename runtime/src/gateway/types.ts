// The gateway's two doors (T-241; C-044): the Linq port it verifies through (K-11 v1) and the actor it hands the event to.
// Both are interfaces, so the gateway holds no signature algorithm, no Linq wire format and no storage:
// - The signature algorithm and Linq's wire format are the Linq adapter's (C-207, T-413).
// - Sealing the event and writing it to the handle's actor is T-243's; the scrub is T-242's (runtime/src/scrub).

import type { BundleId } from "../trace";
import type { PageHandlers } from "./pages/types";
import type { ProviderDoors } from "./providers/types";
import type { HandleRef, SealedBox, SealingKeyStore } from "./seal";

/** K-06 v1's inbound event, as far as the gateway reads it; the rest rides through untouched (the gateway seals the words, T-243). */
export interface InboundEvent {
  eventId: string;
  provider: string;
  kind: string;
  service: string;
  traceId: string;
  handle: HandleRef;
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

/** What the gateway hands a receipt's door: the scrubbed event with `partKey` beside it (K-11 README: K-06 does not change). */
export interface ActorHandoff {
  event: InboundEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
}

/**
 * K-06's event as the actor stores it: the scrubbed event with its words (`body`, and an email's `email.subject`)
 * taken out and sealed into `sealed` (null when the event has no words). Every other field is K-06's, in the clear:
 * the actor orders, dedupes and routes on them.
 */
export interface SealedEvent {
  eventId: string;
  provider: string;
  kind: string;
  service: string;
  traceId: string;
  handle: HandleRef;
  /** `scrubbed`'s counts are in the event's own field of that name; the words are only here, sealed. */
  sealed: SealedBox | null;
  readonly [field: string]: unknown;
}

/** What the gateway hands the handle's actor: a sealed event with `partKey` beside it. Never a plain body. */
export interface SealedHandoff {
  event: SealedEvent;
  partKey: string | null;
  traceId: string;
  bundleId: BundleId;
  /** The name of the handle's Durable Object (`actorNameOf(event.handle)`): every event of a handle names the same one. */
  actorName: string;
}

/** The answer of a door that stores: `written`, or `duplicate` (its event id is already known; nothing was written). */
export type StoreAnswer = "written" | "duplicate";

/**
 * The actor's door (T-243 fills it; the inbox behind it is T-244's). A throw or a rejected promise means the write
 * failed: the gateway answers 503.
 *
 * The seen-event-id check lives behind this door, in the handle actor's own storage, in the same step as the write:
 * two retries of one event that arrive together cannot both pass a check that sits apart from the write, and the
 * actor is the one place that already owns the handle's rows. No wrangler binding is added here (NQ-RT-5).
 */
export interface ActorStub {
  accept(handoff: SealedHandoff): Promise<StoreAnswer>;
}

/**
 * The door for delivery receipts (`delivered`, `sent`, `failed`): they go to the outbox dispatcher and to clock arming
 * (K-06 README routing), never to the handle's actor, and carry no words.
 */
export interface ReceiptSink {
  accept(handoff: ActorHandoff): Promise<StoreAnswer>;
}

export interface GatewayDeps {
  linq: LinqPort;
  actor: ActorStub;
  receipts: ReceiptSink;
  /** The handle's sealing key (NQ-RT-1); a fake in tests until D-017. */
  keys: SealingKeyStore;
  /** The active bundle id read at receipt (K-08 v1 README default 1). */
  bundleId: () => BundleId | Promise<BundleId>;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
  /**
   * The Stripe and calendar doors' ports and store (T-275, providers/); left out, each answers by failing, so those
   * routes answer 503 and store nothing until D-017 joins them.
   */
  providers?: ProviderDoors;
  /**
   * The action layer's handler for each K-21 v1 page and console call (T-266, pages/; C-074); left out, each answers by
   * failing, so its route answers 503 and does nothing until its handler is joined. The staging-only calls are refused
   * outside staging before any handler runs.
   */
  pages?: PageHandlers;
}
