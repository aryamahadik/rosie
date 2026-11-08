// The Stripe double's signed webhooks (T-422; C-214, C-215; K-14 v1 `doubleWebhook`; build prompt 9.4). Test code only:
// it makes no network call, reads no key (the caller hands in made-up whsec_ test secrets, one per endpoint), and logs
// nothing, so no body or secret leaves it. An error names a label, never a value.
//
// `sign` takes one port event (a webhookEvent, such as the double's own events()) and gives the webhook Stripe would
// send for it, in Stripe's form: the raw JSON body, and a Stripe-Signature header `t=<seconds>,v1=<hex>` where v1 is the
// HMAC-SHA256 of "<t>.<raw>" under the receiving endpoint's secret (README spike row 13). The double signs for the
// endpoint whose account the event names: `businesses` for a business's account, `rosfield` for Rosfield's. verifyWebhook
// on the result, inside the 300 s window, gives the same event back (the contract test's round trip).
//
// What a port event does not hold stays out of the body, as for the real events: the adapter drops the rest of a
// Stripe object anyway (a payment's customer, a setup's usage is added only where the port event names it).

import { signHmacSha256 } from "../../shared/hmac";
import type { Account, Endpoint, SignedWebhook, WebhookEvent } from "./types";
import { isStripeId, isUtc } from "./validate";

/** The default age of a stale webhook, in seconds: one past the 300 s window. */
export const STALE_BY_SECONDS = 301;

/** The API version the fixtures' bodies carry (README 'Spike findings'). */
export const API_VERSION = "2026-10-28.endive";

/** A request the double cannot sign: a setup fault in the test, named by label. */
export class StripeDoubleWebhookError extends Error {
  override readonly name = "StripeDoubleWebhookError";
  readonly code: "badEvent" | "badTime" | "wrongEndpoint" | "badSecret" | "unknownKind";

  constructor(code: StripeDoubleWebhookError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface StripeWebhookDoubleOptions {
  /** The test environment's signing secrets, "whsec_" and letters: one per endpoint. Never Stripe's. */
  readonly secrets: { readonly rosfield: string; readonly businesses: string };
}

export interface StripeSignOptions {
  /** When the gateway received it. Default: one second after the event happened, as the fixtures' are. */
  readonly receivedAt?: string;
  /** The trace id the gateway opened. Default: trace-stripe-double-<n>, counted per double. */
  readonly traceId?: string;
  /**
   * Sign it outside the 300 s window: true makes the timestamp STALE_BY_SECONDS old, a number sets the age in seconds.
   * The signature is still right for that timestamp, so only the window fails it.
   */
  readonly stale?: boolean | number;
  /** Change one byte of the signature (the fixtures' oneByteChanged). */
  readonly oneByteChanged?: boolean;
}

export interface StripeWebhookDouble {
  /** The signed webhook for one port event, on the endpoint its account names. */
  sign(event: WebhookEvent, options?: StripeSignOptions): Promise<SignedWebhook>;
  /** A signed event of a type Rosie does not use, which the gateway answers 200 and drops. */
  signUnused(
    request: {
      endpoint: Endpoint;
      eventId: string;
      stripeType: string;
      account: Account;
      occurredAt: string;
    },
    options?: StripeSignOptions,
  ): Promise<SignedWebhook>;
}

type Json = Record<string, unknown>;

const bad = (code: StripeDoubleWebhookError["code"]): StripeDoubleWebhookError =>
  new StripeDoubleWebhookError(code);

const seconds = (time: string): number => {
  if (!isUtc(time)) throw bad("badTime");
  return Math.floor(Date.parse(time) / 1000);
};

const lower = (cents: { cents: number; currency: string }): Json => ({
  amount: cents.cents,
  currency: cents.currency.toLowerCase(),
});

const REFUND_STATUS: Readonly<Record<string, string>> = {
  pending: "pending",
  requiresAction: "requires_action",
  succeeded: "succeeded",
  failed: "failed",
  canceled: "canceled",
};

const DISPUTE_STATUS: Readonly<Record<string, string>> = {
  businessWon: "won",
  customerWon: "lost",
  inquiryClosed: "warning_closed",
};

function metadata(effectId: string | null): Json {
  return effectId === null ? {} : { rosie_effect_id: effectId };
}

/** The Stripe object a port event is about: its id and its fields, by kind (README 'Webhook events'). */
function object(event: WebhookEvent): Json {
  const p = event.payload as Json;
  const money = (value: unknown): Json => lower(value as { cents: number; currency: string });
  switch (event.kind) {
    case "accountUpdated": {
      const state = p.state as {
        onboardingFinished: boolean;
        canTakeCharges: boolean;
        canPayOut: boolean;
        infoDue: boolean;
        infoDueBy: string | null;
      };
      return {
        id: event.account.kind === "business" ? event.account.accountId : "",
        object: "account",
        charges_enabled: state.canTakeCharges,
        details_submitted: state.onboardingFinished,
        payouts_enabled: state.canPayOut,
        requirements: {
          currently_due: state.infoDue ? ["individual.verification.document"] : [],
          current_deadline: state.infoDueBy === null ? null : seconds(state.infoDueBy),
        },
      };
    }
    case "accountDisconnected":
      return { id: "ca_double", object: "application", name: "Rosie" };
    case "cardSaved":
      return {
        id: p.setupId,
        object: "setup_intent",
        customer: p.customerId,
        metadata: metadata(event.effectId),
        payment_method: p.paymentMethodId,
        status: "succeeded",
        usage: "off_session",
      };
    case "cardSaveFailed":
      return {
        id: p.setupId,
        object: "setup_intent",
        last_setup_error: { code: p.code, decline_code: p.declineCode },
        metadata: metadata(event.effectId),
        status: "requires_payment_method",
      };
    case "cardDetails":
    case "cardReplaced":
      return {
        id: p.paymentMethodId,
        object: "payment_method",
        card: p.card,
        customer: p.customerId,
        type: "card",
      };
    case "paymentSucceeded":
      return {
        id: p.paymentId,
        object: "payment_intent",
        ...money(p.amount),
        amount_received: (p.amount as { cents: number }).cents,
        latest_charge: p.chargeId,
        metadata: metadata(event.effectId),
        payment_method: p.paymentMethodId,
        status: "succeeded",
      };
    case "paymentFailed":
      return {
        id: p.paymentId,
        object: "payment_intent",
        last_payment_error: { code: p.code, decline_code: p.declineCode },
        latest_charge: p.chargeId,
        metadata: metadata(event.effectId),
        status: "requires_payment_method",
      };
    case "paymentCanceled":
      return {
        id: p.paymentId,
        object: "payment_intent",
        metadata: metadata(event.effectId),
        status: "canceled",
      };
    case "refundChanged":
      return {
        id: p.refundId,
        object: "refund",
        ...money(p.amount),
        metadata: metadata(event.effectId),
        payment_intent: p.paymentId,
        status: REFUND_STATUS[p.state as string],
      };
    case "disputeOpened":
      return {
        id: p.disputeId,
        object: "dispute",
        ...money(p.amount),
        charge: p.chargeId,
        evidence_details: {
          due_by: seconds(p.evidenceDueBy as string),
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: p.paymentId,
        reason: "general",
        status: "needs_response",
      };
    case "disputeClosed":
      return {
        id: p.disputeId,
        object: "dispute",
        charge: p.chargeId,
        status: DISPUTE_STATUS[p.outcome as string],
      };
    case "payoutFailed":
      return {
        id: p.payoutId,
        object: "payout",
        ...money(p.amount),
        failure_code: p.failureCode,
        status: "failed",
      };
    default:
      throw bad("unknownKind");
  }
}

function endpointOf(account: Account): Endpoint {
  return account.kind === "business" ? "businesses" : "rosfield";
}

/** One byte of the hex signature changed: its first digit, to another. */
function changeOneByte(hex: string): string {
  return `${hex.startsWith("0") ? "1" : "0"}${hex.slice(1)}`;
}

/** The double that makes signed webhooks. Each call counts its own default trace id, so a test reads them in order. */
export function createStripeWebhookDouble(options: StripeWebhookDoubleOptions): StripeWebhookDouble {
  for (const secret of [options.secrets.rosfield, options.secrets.businesses])
    if (!/^whsec_[A-Za-z0-9]{8,}$/.test(secret)) throw bad("badSecret");
  let serial = 0;

  async function envelope(
    endpoint: Endpoint,
    body: Json,
    occurredAt: string,
    signOptions: StripeSignOptions,
  ): Promise<SignedWebhook> {
    serial += 1;
    const receivedAt =
      signOptions.receivedAt ??
      new Date(Date.parse(occurredAt) + 1000).toISOString().replace(/[.][0-9]+Z$/, "Z");
    const age =
      signOptions.stale === undefined || signOptions.stale === false
        ? 0
        : signOptions.stale === true
          ? STALE_BY_SECONDS
          : signOptions.stale;
    const timestamp = String(seconds(receivedAt) - age);
    const raw = JSON.stringify(body);
    const signature = await signHmacSha256(options.secrets[endpoint], `${timestamp}.${raw}`);
    return {
      endpoint,
      signatureHeader: `t=${timestamp},v1=${signOptions.oneByteChanged === true ? changeOneByte(signature) : signature}`,
      raw,
      receivedAt,
      traceId: signOptions.traceId ?? `trace-stripe-double-${String(serial).padStart(4, "0")}`,
    };
  }

  function frame(
    eventId: string,
    account: Account,
    occurredAt: string,
    type: string,
    data: Json,
    live: boolean,
  ): Json {
    if (!isStripeId(eventId)) throw bad("badEvent");
    return {
      id: eventId,
      object: "event",
      api_version: API_VERSION,
      ...(account.kind === "business" ? { account: account.accountId } : {}),
      created: seconds(occurredAt),
      livemode: live,
      type,
      data: { object: data },
    };
  }

  return {
    // async, so an event the double cannot sign rejects, whatever the call shape.
    async sign(event, signOptions = {}) {
      // A test may hand in any value, whatever the type says.
      if (typeof (event as { payload?: unknown }).payload !== "object") throw bad("badEvent");
      const body = frame(
        event.eventId,
        event.account,
        event.occurredAt,
        event.stripeType,
        object(event),
        !event.testMode,
      );
      return envelope(endpointOf(event.account), body, event.occurredAt, signOptions);
    },
    async signUnused(request, signOptions = {}) {
      if (request.endpoint !== endpointOf(request.account)) throw bad("wrongEndpoint");
      const body = frame(
        request.eventId,
        request.account,
        request.occurredAt,
        request.stripeType,
        { id: "unused-double", object: "unused", metadata: {} },
        false,
      );
      return envelope(request.endpoint, body, request.occurredAt, signOptions);
    },
  };
}
