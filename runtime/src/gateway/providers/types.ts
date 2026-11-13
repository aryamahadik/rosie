// The provider webhook doors' interfaces (T-275; C-044; arch 02 step 1 "Receive", line 109: "Stripe and calendar events
// go to PostgreSQL"). The doors hold no signature algorithm, no vendor parse past reading a push into K-16's request,
// and no storage; each outside thing is an interface the runtime owns, filled by a double in tests:
// - the Stripe port's verify call (K-14 v1 `verifyWebhook`): the Stripe adapters (C-214, C-215) check the signature with
//   the shared helper (adapters/src/shared/hmac.ts) and parse the event;
// - the calendar port's check of a push (K-16 v1 `verifyNotification`): the Google and Microsoft adapters (C-216, C-217);
// - K-05 v1.1's `recordProviderEvent` (the database engineer's C-152, T-199; joined at D-017), which stores a K-07 v1
//   provider event once by (provider, provider event id) in one statement and says whether it was a repeat, so the
//   duplicate is decided in the same storage step as the write (T-241's and T-244's rule);
// - the business a Stripe event concerns (K-14 README "Webhook events"), which no K-05 call reads yet.
//
// The shapes are written by hand: the generated types are git-ignored (ADR-005) and the Worker must not depend on them.

import type { BundleId } from "../../trace";

// ---- K-07 v1 provider events and K-05 v1.1 recordProviderEvent ---------------------------------------------------------

/** K-07 v1 `providerEvent.provider`: the three providers whose events go to PostgreSQL. */
export type EventProvider = "stripe" | "google_calendar" | "microsoft_calendar";

/**
 * K-07 v1 `providerEvent` (outbox-effects.v1 `providerEvent`), which is K-05 v1.1's `recordProviderEvent.request`: one
 * Stripe or calendar event, stored once by `(provider, providerEventId)` and linked to its effect row when it reports on
 * one (a calendar push about a person's own event links to none: S12-33).
 */
export interface ProviderEvent {
  provider: EventProvider;
  providerEventId: string;
  /** The provider's own name for the event (K-14's Stripe type; K-16's push state or Graph's change or lifecycle event). */
  eventType: string;
  occurredAt: string | null;
  /** When the gateway received it. */
  receivedAt: string;
  businessId: string | null;
  effectId: string | null;
  /** The event's fields as the port parses them; never a key or a card number (K-07; the gateway scrubs it). */
  payload: Record<string, unknown>;
  /** The trace the gateway opened at receipt (arch 10 line 548). */
  traceId: string;
}

/** K-05 v1.1 `recordProviderEvent.response`: recorded once; a repeat writes nothing and answers the stored row's facts. */
export interface ProviderEventRecorded {
  result: "recorded";
  provider: EventProvider;
  providerEventId: string;
  repeated: boolean;
  receivedAt: string;
  effectId: string | null;
}

/** K-05 v1 `constraintError`: a database rule refused the write; nothing was written. */
export interface ConstraintError {
  error: "constraint";
  sqlstate: string;
  constraint: string;
}

/** K-05 v1 `transientError`: the database could not run the call now; nothing was written. */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

/** K-05 v1.1 `recordProviderEvent.errors`. */
export type RecordProviderEventError = ConstraintError | TransientError;

/**
 * K-05 v1.1 `recordProviderEvent` (item 23: unscoped, on the runtime side; `insert ... on conflict do nothing`, and on a
 * conflict the stored row's `receivedAt` and `effectId` with `repeated` true). A throw or an error answer means nothing
 * was written: the gateway answers 503 so the provider retries.
 */
export interface ProviderEventStore {
  recordProviderEvent(event: ProviderEvent): Promise<ProviderEventRecorded | RecordProviderEventError>;
}

// ---- K-14 v1 verifyWebhook (the Stripe port) ----------------------------------------------------------------------

/** K-14 v1 `endpoint`: Rosfield's own account's endpoint, or the connected accounts' endpoint; each has its own secret. */
export type StripeEndpoint = "rosfield" | "businesses";

/** K-14 v1 `verifyWebhook.request`: one Stripe webhook as the gateway received it, before any parsing. */
export interface StripeVerifyRequest {
  endpoint: StripeEndpoint;
  /** The Stripe-Signature header exactly as sent ("" when missing; the door refuses that before the port). */
  signatureHeader: string;
  /** The body exactly as received: Stripe signs "<t>.<raw>". */
  raw: string;
  receivedAt: string;
  traceId: string;
}

/** K-14 v1 `account`: a business's own connected account, or Rosfield's own. */
export type StripeAccount = { kind: "business"; accountId: string } | { kind: "rosfield" };

/** K-14 v1 `webhookEvent`, as far as the gateway reads it; the kind's own fields ride in `payload` untouched. */
export interface StripeWebhookEvent {
  eventId: string;
  kind: string;
  stripeType: string;
  account: StripeAccount;
  testMode: boolean;
  occurredAt: string;
  effectId: string | null;
  payload: Record<string, unknown>;
}

/** Why K-14 v1 rejects a webhook (`verifyWebhook.errors`): each is answered 401 and dropped. */
export type StripeRejectReason = "badHeader" | "staleTimestamp" | "badSignature";

/** K-14 v1 `verifyWebhook.response` and its rejection. */
export type StripeVerifyResult =
  | { result: "event"; httpStatus: 200; event: StripeWebhookEvent }
  | { result: "ignored"; httpStatus: 200; stripeType: string }
  | { result: "rejected"; httpStatus: 401; reason: StripeRejectReason };

/** The slice of K-14 v1 the gateway uses; the Stripe adapters (C-214, C-215) and the Stripe double fill it. */
export interface StripePort {
  verifyWebhook(request: StripeVerifyRequest): Promise<StripeVerifyResult>;
}

/**
 * The business a Stripe event concerns (K-14 README "Webhook events"): the business whose K-23 v1 `stripe_account_id` is
 * the event's account, or for Rosfield's own account the business of the effect it names; null when none is known (K-07
 * `businessId`: "when known"). No K-05 call reads it yet (a K-05 minor version; D-017 joins it). A throw answers 503.
 */
export interface StripeBusinessLookup {
  businessOf(event: { account: StripeAccount; effectId: string | null }): Promise<string | null>;
}

// ---- K-16 v1 verifyNotification (the calendar port) ------------------------------------------------------------------

/** K-16 v1 `googlePush`: Google's push, a POST with no body, its X-Goog-* headers read into these fields. */
export interface GooglePush {
  provider: "google";
  kind: "push";
  channelId: string;
  /** X-Goog-Channel-Token as sent, "" when missing: the verifier the adapter set on the channel. */
  channelToken: string;
  resourceId: string;
  resourceState: string;
  messageNumber: string;
  channelExpiration: string | null;
  receivedAt: string;
  traceId: string;
}

/** K-16 v1 `graphValidation`: Graph's handshake when a subscription is made (`?validationToken=`). */
export interface GraphValidation {
  provider: "microsoft";
  kind: "validation";
  /** The token, URL-decoded. */
  validationToken: string;
  receivedAt: string;
  traceId: string;
}

export type GraphChangeType = "created" | "updated" | "deleted";
export type GraphLifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";

/** K-16 v1 `graphNotice`: one item of a Graph POST, a change notification or a lifecycle notification, never both. */
export interface GraphNotice {
  notificationId: string | null;
  subscriptionId: string;
  clientState: string;
  changeType: GraphChangeType | null;
  lifecycleEvent: GraphLifecycleEvent | null;
  subscriptionExpirationDateTime: string | null;
}

/** K-16 v1 `graphNotifications`: Graph's POST, parsed from its JSON body. */
export interface GraphNotifications {
  provider: "microsoft";
  kind: "notifications";
  notifications: GraphNotice[];
  receivedAt: string;
  traceId: string;
}

/** K-16 v1 `verifyNotification.request`. */
export type CalendarPushRequest = GooglePush | GraphValidation | GraphNotifications;

/** K-16 v1 `calendarNotice`: a stored push's payload in Rosie's terms; never an event's content. */
export interface CalendarNotice {
  calendarLinkId: string;
  watchId: string;
  notice: "changed" | "missed" | "reauthorizationRequired" | "watchRemoved";
}

/** K-16 v1 `verifyNotification.response`. */
export type CalendarVerifyResult =
  | { result: "validation"; httpStatus: 200; contentType: "text/plain"; body: string }
  | { result: "accepted"; httpStatus: 200; events: ProviderEvent[]; unknownWatches: number }
  | { result: "ignored"; httpStatus: 200; why: "syncMessage" }
  | { result: "rejected"; httpStatus: 401; why: "verifierMismatch" | "unreadable" };

/** The slice of K-16 v1 the gateway uses; the Google and Microsoft adapters (C-216, C-217) and the double fill it. */
export interface CalendarPort {
  verifyNotification(request: CalendarPushRequest): Promise<CalendarVerifyResult>;
}

// ---- the doors' dependencies --------------------------------------------------------------------------------------------

/**
 * The outside things the Stripe and calendar doors use, and each door's body cap. The gateway holds them as
 * GatewayDeps.providers, so each cap is a config value of the gateway's, beside the page entry's and Linq's (T-1195).
 */
export interface ProviderDoors {
  stripe: StripePort;
  stripeBusinesses: StripeBusinessLookup;
  calendar: CalendarPort;
  events: ProviderEventStore;
  /**
   * The most bytes a Stripe webhook's body may have (a config value, T-1195; ../body.ts): over it, the webhook is answered
   * 413 before its body is read whole and before any signature check, and nothing is verified or stored. Left out, or not
   * a whole number from 0, it is STRIPE_BODY_LIMIT_BYTES (256 KiB).
   */
  stripeBodyLimitBytes?: number;
  /**
   * The most bytes a calendar push's body may have, at Google's door and Graph's (a config value, T-1195; ../body.ts):
   * over it, the push is answered 413 before its body is read whole and before it is checked, and nothing is stored.
   * Left out, or not a whole number from 0, it is CALENDAR_BODY_LIMIT_BYTES (256 KiB, T-1201).
   */
  calendarBodyLimitBytes?: number;
}

/** The doors with the trace's needs: the active bundle id read at receipt and the clock. */
export interface ProviderDeps extends ProviderDoors {
  bundleId: () => BundleId | Promise<BundleId>;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
}
