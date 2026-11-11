// The email webhook door's interfaces (T-265; C-044; K-12 v1 "Delivery events" and "Inbound replies"; arch 02 step 1
// "Receive", line 109). The door holds no signature algorithm, no Resend wire format, no key and no storage; each outside
// thing is an interface the runtime owns, filled by a double in tests:
// - the email port's verify call (K-12 v1 `verifyWebhook`): the email adapter (C-213) checks Svix's signature over
//   "<svix-id>.<svix-timestamp>.<raw>" under RESEND_WEBHOOK_SECRET, read by name where the adapter runs, and parses the
//   body into a delivery event (one K-06 event with the email's Message-ID beside it), the notice that a reply came in, or
//   a type Rosie does not use;
// - the email port's read of a reply (K-12 v1 `readReply`): Resend's `email.received` carries only a reply's metadata,
//   so the adapter reads the reply itself from Resend's receiving API (RESEND_RECEIVING_KEY, by name) into one K-06 text
//   event with its sender check (RULES 6.1);
// - the door to the handle's actor, the receipt door and the handle's sealing key store, which are the gateway's own
//   (../types.ts, ../seal.ts): a reply is scrubbed and sealed as a text is (../hand-off.ts, T-243) and a receipt goes to
//   the receipt door, never the actor.
//
// The shapes are written by hand: the generated types are git-ignored (ADR-005) and the Worker must not depend on them.

import type { BundleId } from "../../trace";
import type { SealingKeyStore } from "../seal";
import type { ActorStub, InboundEvent, ReceiptSink } from "../types";

/** K-12 v1 `verifyWebhook.request`: one Resend webhook as the gateway received it, before any parsing. */
export interface EmailVerifyRequest {
  /** The svix-id header: the webhook's id, the same on every retry of it, and the K-06 event id (README default 7). */
  webhookId: string;
  /** The svix-timestamp header as sent: whole seconds since 1970, within 300 s of receivedAt. */
  timestamp: string;
  /** The svix-signature header exactly as sent: one or more "v1,<base64>" separated by spaces. */
  signature: string;
  /** The body exactly as received: Svix signs "<webhookId>.<timestamp>.<raw>". */
  raw: string;
  receivedAt: string;
  traceId: string;
}

/** Why K-12 v1 rejects a webhook (`verifyWebhook.errors`): each is answered 401 and dropped. */
export type EmailRejectReason = "badTimestamp" | "staleTimestamp" | "badSignature";

/** K-12 v1 `verifyWebhook.response` and its rejection. */
export type EmailVerifyResult =
  /** A delivery event (K-12 `receiptEvent`: delivered or failed) with the Message-ID of Rosie's email beside it. */
  | { result: "event"; httpStatus: 200; event: InboundEvent; rfcMessageId: string | null }
  /** Resend's email.received: a reply to read with `readReply`, under the webhook's id. */
  | { result: "reply"; eventId: string; receivedEmailId: string; replyAddress: string }
  | { result: "ignored"; httpStatus: 200; eventType: string }
  | { result: "rejected"; httpStatus: 401; reason: EmailRejectReason };

/** K-12 v1 `readReply.request`: one reply `verifyWebhook` announced. */
export interface EmailReadRequest {
  eventId: string;
  receivedEmailId: string;
  receivedAt: string;
  traceId: string;
}

/** K-12 v1 `readReply.response` and its errors. */
export type EmailReadResult =
  /** The reply as one K-06 text event (K-12 `replyEvent`), its sender check in `email.senderCheck`. */
  | { result: "event"; httpStatus: 200; event: InboundEvent }
  /** An automatic reply (RFC 3834): answered 200 and dropped, so no loop of automatic emails starts (default 17). */
  | { result: "ignored"; httpStatus: 200; reason: "automaticReply" }
  /** The gateway answers 503, so Resend sends the webhook again (default 11). */
  | { result: "failed"; kind: "transient"; httpStatus: 503; code: string | null; reason: string }
  /** Resend has no such email, or none of its content: answered 200 and dropped. */
  | { result: "failed"; kind: "unreadable"; httpStatus: 200; code: string | null; reason: string };

/**
 * The slice of K-12 v1 the gateway uses: the verify and parse of a webhook, and the read of a reply. The email adapter
 * (C-213) and the email double (T-418) fill it. A throw is no answer: the door answers 503 and writes nothing.
 */
export interface EmailPort {
  verifyWebhook(request: EmailVerifyRequest): Promise<EmailVerifyResult>;
  readReply(request: EmailReadRequest): Promise<EmailReadResult>;
}

/**
 * What the email webhook door uses. The gateway builds it from its own doors (../index.ts `emailDepsOf`): the email port
 * is GatewayDeps.email (closed when left out), and the actor door, the receipt door and the key store are the ones the
 * Linq entry writes through, so a reply and a text of one handle reach one actor and one inbox.
 */
export interface EmailDeps {
  /** K-12 v1's verify and read. */
  email: EmailPort;
  /** The door to the handle's actor: a reply goes here, scrubbed and sealed, and nowhere else. */
  actor: ActorStub;
  /** The receipt door (the dispatcher's receipt handler, then clock arming): a delivery event goes here, never the actor. */
  receipts: ReceiptSink;
  /** The handle's sealing key (NQ-RT-1), asked once per reply with words. */
  keys: SealingKeyStore;
  /** The active bundle id read at receipt (K-08 v1 README default 1). */
  bundleId: () => BundleId | Promise<BundleId>;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
  /**
   * The most bytes a Resend webhook's body may have (a config value; ../body.ts): over it, the webhook is answered 413
   * before its body is read whole and before any signature check, and nothing is verified, read or handed on. Left out,
   * or not a whole number from 0, it is EMAIL_BODY_LIMIT_BYTES (256 KiB).
   */
  emailBodyLimitBytes?: number;
}
