// The gateway's two doors (T-241; C-044): the Linq port it verifies through (K-11 v1) and the actor it hands the event to.
// Both are interfaces, so the gateway holds no signature algorithm, no Linq wire format and no storage:
// - The signature algorithm and Linq's wire format are the Linq adapter's (C-207, T-413).
// - Sealing the event and writing it to the handle's actor is T-243's; the scrub is T-242's (runtime/src/scrub).

import type { BundleId } from "../trace";
import type { EmailPort } from "./email/types";
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
  /**
   * For an email's delivery event only (T-265; K-12 v1 `verifyWebhook.response` rfcMessageId): the Message-ID of Rosie's
   * email the receipt reports on, which later emails in the booking's thread name, or null when Resend gives none (an
   * email that never went). K-06 v1 has no field for it, so it rides beside the event, never in it. Left out for a Linq
   * receipt.
   */
  rfcMessageId?: string | null;
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

/**
 * K-05 v1.7 openChatOnText's request as the gateway makes it at receipt (T-1213; K-05 README item 46): the text's event
 * id, its handle by the K-04 id the key call answered (K-05 v1.2 handleSealingKey), and, from the K-06 event, the service
 * Linq reports, the time the gateway received it and its trace. Never the number: K-05 reads it from the handle's row.
 */
export interface ChatOpenRequest {
  readonly eventId: string;
  readonly handleId: string;
  readonly service: string;
  readonly receivedAt: string;
  readonly traceId: string;
}

/**
 * K-05 v1.7 openChatOnText's answer as the gateway reads it: one of its five results (the chat inserted or opened now,
 * open already, a stopped number left as it is, or this text's repeat), each of which lets the text go on to its actor;
 * a refusal, notFound or notAPhone, the caller's fault, after which the text is stored all the same (default 77); or
 * transient, nothing written. Never the phone row, its entry or the number.
 */
export type ChatOpenAnswer =
  | { readonly result: "inserted" | "opened" | "alreadyOpen" | "stopped" | "repeated" }
  | { readonly error: "notFound" | "notAPhone" | "transient" };

/**
 * The port the gateway opens a number's chat through at receipt (T-1213; K-05 v1.7 item 46; ./chat-open.ts): once for
 * each text or photo a phone handle sends through Linq, after the key call and before the actor's door. A throw is no
 * answer: the gateway answers 503 and stores nothing.
 */
export interface ChatOpenPort {
  openChatOnText(request: ChatOpenRequest): Promise<ChatOpenAnswer>;
}

export interface GatewayDeps {
  linq: LinqPort;
  actor: ActorStub;
  receipts: ReceiptSink;
  /** The handle's sealing key (NQ-RT-1); a fake in tests until D-017. */
  keys: SealingKeyStore;
  /**
   * K-05 v1.7 openChatOnText at receipt (T-1213; ./chat-open.ts): a number's text opens its chat before its actor is
   * reached. The composition root always binds it (runtime/src/wiring: real in test and staging, closed in production,
   * with no database in the Worker until T-567, so there it fails closed and the gateway answers 503, as every seal does).
   * Left out (a gateway built by hand, as the gateway's own doubles build it), no chat is opened: the text is stored as
   * before T-1213, and rows to its number wait for the chat (limit 8 fails closed).
   */
  chats?: ChatOpenPort;
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
  /**
   * The most bytes a page or console call's body may have (a config value, T-1180; body.ts): over it, the call is
   * answered 413 before its body is read whole, and no handler runs. Left out, or not a whole number from 0, it is
   * PAGE_BODY_LIMIT_BYTES (64 KiB).
   */
  pageBodyLimitBytes?: number;
  /**
   * The most bytes a Linq webhook's body may have (a config value, T-1180; body.ts): over it, the webhook is answered
   * 413 before its body is read whole, and nothing is verified or handed on. Left out, or not a whole number from 0, it
   * is LINQ_BODY_LIMIT_BYTES (256 KiB).
   */
  linqBodyLimitBytes?: number;
  /**
   * The email port's verify and read (T-265, email/; K-12 v1 verifyWebhook and readReply): the email adapter (C-213),
   * which reads RESEND_WEBHOOK_SECRET and RESEND_RECEIVING_KEY by name. Left out, each call answers by failing, so the
   * Resend webhook route answers 503 and reads, writes and hands on nothing until the composition root binds it. The
   * door writes through this gateway's own `actor`, `receipts` and `keys`.
   */
  email?: EmailPort;
  /**
   * The most bytes a Resend webhook's body may have (a config value, T-265; body.ts): over it, the webhook is answered
   * 413 before its body is read whole, and nothing is verified, read or handed on. Left out, or not a whole number from
   * 0, it is EMAIL_BODY_LIMIT_BYTES (256 KiB).
   */
  emailBodyLimitBytes?: number;
}
