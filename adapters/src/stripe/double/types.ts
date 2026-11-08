// The Stripe double's types (T-422; C-214, C-215; K-14 v1). They mirror the port's request and answer shapes in
// contracts/port-stripe/port-stripe.v1.schema.json by hand, because the generated contract types are git-ignored
// (ADR-005) and code that ships beside them must not depend on them (as the Linq double's types do). The double's own
// tests check every answer against the schema itself.

export interface Money {
  cents: number;
  currency: string;
}

export type Account = { kind: "business"; accountId: string } | { kind: "rosfield" };
export interface BusinessAccount {
  kind: "business";
  accountId: string;
}

export type Purpose =
  "deposit" | "fullPrice" | "rest" | "extra" | "fee" | "tip" | "pack" | "planCharge" | "rosfieldMonthlyBill";

export type Brand =
  | "amex"
  | "cartes_bancaires"
  | "diners"
  | "discover"
  | "eftpos_au"
  | "jcb"
  | "link"
  | "mastercard"
  | "unionpay"
  | "visa"
  | "unknown";

export interface CardShown {
  brand: Brand;
  last4: string;
}

export interface EffectRef {
  effectId: string;
  idempotencyKey: string;
}

export interface CallFailure {
  result: "failed";
  kind: "transient" | "refused";
  httpStatus: number | null;
  code: string | null;
  reason: string;
}

export interface ChargeFailure {
  result: "failed";
  kind: "declined" | "transient" | "refused";
  httpStatus: number | null;
  code: string | null;
  declineCode: string | null;
  reason: string;
  paymentId: string | null;
}

// ---- requests ----

export interface OnboardingLinkRequest {
  accountId: string | null;
  businessName: string;
  returnUrl: string;
  refreshUrl: string;
  idempotencyKey: string;
}
export interface AccountStatusRequest {
  accountId: string;
}
export interface SaveCardRequest {
  effect: EffectRef;
  port: { account: Account; customerId: string | null };
}
export interface RemoveCardRequest {
  account: Account;
  customerId: string;
  paymentMethodId: string;
}
export interface ChargeRequest {
  effect: EffectRef;
  amount: Money;
  port: {
    account: Account;
    purpose: Purpose;
    customerId: string;
    paymentMethodId: string;
    customerPresent: boolean;
    description: string;
  };
}
export interface PayLinkRequest {
  effect: EffectRef;
  amount: Money;
  port: {
    account: Account;
    purpose: Purpose;
    customerId: string | null;
    saveCardForLater: boolean;
    description: string;
  };
}
export interface ClosePayLinkRequest {
  account: Account;
  paymentId: string;
}
export type PageIntentRequest =
  { account: Account; setupId: string } | { account: Account; paymentId: string };
export interface SavedCardRequest {
  account: Account;
  customerId: string;
  paymentMethodId: string;
}
export interface RefundRequest {
  effect: EffectRef;
  amount: Money;
  port: { account: Account; paymentId: string; reason: "duplicate" | "requestedByCustomer" };
}
export interface DisputeEvidenceRequest {
  effect: EffectRef;
  port: {
    account: BusinessAccount;
    disputeId: string;
    ownerYes: {
      kind: "ownerYes";
      person_id: string;
      role: "owner" | "admin";
      open_question_id: string;
      option_id: string | null;
      event_id: string;
    };
    serviceDate: string;
    serviceDescription: string;
    customerName: string;
    recordFileId: string;
  };
}
export interface ListMoneyRequest {
  account: Account;
  from: string;
  to: string;
  effectId?: string;
}
export interface DoublePlantRequest {
  account: Account;
  plant: "chargeWithoutEffectId" | "secondCharge";
  amount: Money;
  createdAt: string;
  effectId: string | null;
}

// ---- answers ----

export interface AccountState {
  onboardingFinished: boolean;
  canTakeCharges: boolean;
  canPayOut: boolean;
  infoDue: boolean;
  infoDueBy: string | null;
}

export type OnboardingLinkOutcome =
  | { result: "link"; accountId: string; accountCreated: boolean; url: string; expiresAt: string }
  | CallFailure;
export type AccountStatusOutcome =
  | { result: "status"; accountId: string; checkedAt: string; state: AccountState }
  | { result: "disconnected"; accountId: string; checkedAt: string }
  | CallFailure;
export type SaveCardOutcome =
  { result: "ready"; setupId: string; customerId: string; clientSecret: string } | CallFailure;
export type RemoveCardOutcome =
  { result: "removed" | "alreadyRemoved"; paymentMethodId: string } | CallFailure;
export type ChargeOutcome =
  | {
      result: "charged";
      paymentId: string;
      chargeId: string;
      card: CardShown | null;
      chargedAt: string;
    }
  | { result: "needsAuthentication"; paymentId: string; clientSecret: string }
  | ChargeFailure;
export type PayLinkOutcome =
  { result: "created"; paymentId: string; clientSecret: string; createdAt: string } | CallFailure;
export type ClosePayLinkOutcome =
  | { result: "closed" | "alreadyPaid" | "alreadyClosed"; paymentId: string; paidAt: string | null }
  | CallFailure;
export type IntentState = "needsCard" | "needsAuthentication" | "processing" | "succeeded" | "canceled";
export type PageIntentOutcome =
  | {
      result: "intent";
      setupId: string;
      state: IntentState;
      clientSecret: string | null;
      card: CardShown | null;
    }
  | {
      result: "intent";
      paymentId: string;
      state: IntentState;
      clientSecret: string | null;
      amount: Money;
      card: CardShown | null;
    }
  | CallFailure;
export type SavedCardOutcome =
  | { result: "card"; paymentMethodId: string; card: CardShown | null }
  | { result: "removed"; paymentMethodId: string }
  | CallFailure;
export type RefundOutcome =
  | {
      result: "refunded";
      refundId: string;
      paymentId: string;
      state: "pending" | "succeeded";
      refundedAt: string;
    }
  | CallFailure;
export type DisputeEvidenceOutcome =
  { result: "submitted"; disputeId: string; submittedAt: string; dueBy: string } | CallFailure;

export type ListState = "succeeded" | "pending" | "failed" | "requiresAction" | "canceled";
export interface ListItem {
  kind: "charge" | "refund";
  stripeId: string;
  paymentId: string | null;
  refundOf: string | null;
  effectId: string | null;
  amount: Money;
  state: ListState;
  createdAt: string;
}
export type ListMoneyOutcome =
  { result: "listed"; from: string; to: string; items: ListItem[] } | CallFailure;
export type DoublePlantOutcome = { result: "planted"; item: ListItem } | CallFailure;

// ---- webhook events, in the port's terms (webhookEvent) ----

export type EventKind =
  | "accountUpdated"
  | "accountDisconnected"
  | "cardSaved"
  | "cardSaveFailed"
  | "cardDetails"
  | "cardReplaced"
  | "paymentSucceeded"
  | "paymentFailed"
  | "paymentCanceled"
  | "refundChanged"
  | "disputeOpened"
  | "disputeClosed"
  | "payoutFailed";

export interface WebhookEvent {
  eventId: string;
  kind: EventKind;
  stripeType: string;
  account: Account;
  testMode: boolean;
  occurredAt: string;
  effectId: string | null;
  payload: Record<string, unknown>;
}

export type Endpoint = "rosfield" | "businesses";

export interface SignedWebhook {
  endpoint: Endpoint;
  signatureHeader: string;
  raw: string;
  receivedAt: string;
  traceId: string;
}

// ---- what the test chooses ----

/** The calls a failure can be scripted for. */
export type ScriptedCall =
  | "onboardingLink"
  | "accountStatus"
  | "saveCard"
  | "removeCard"
  | "charge"
  | "payLink"
  | "closePayLink"
  | "pageIntent"
  | "savedCard"
  | "refund"
  | "disputeEvidence"
  | "listMoney"
  | "doublePlant";

export type ScriptedFailure =
  | {
      kind: "transient";
      /** 409, 429 or 5xx; null (the default) is no answer at all. */
      httpStatus?: number | null;
      code?: string | null;
      /**
       * For charge, refund and the like: Stripe did the work, but the answer never came (try 1 of the late-try
       * fixture). The key is kept with the true answer, so a repeat on it inside 24 hours gets it.
       */
      answerLost?: boolean;
    }
  | { kind: "refused"; httpStatus?: number; code?: string | null }
  | { kind: "declined"; code?: string; declineCode?: string };

/**
 * A test card, in Stripe's published test-card terms (README 'The double'): what a charge on it does. `visa` is the
 * default.
 */
export type CardBehavior =
  | "visa"
  | "chargeDeclined"
  | "insufficientFunds"
  | "expiredCard"
  | "authenticationRequired"
  | "createDispute"
  | "refundFail";

export interface CardSeed {
  paymentMethodId: string;
  account: Account;
  customerId: string;
  card?: CardShown;
  behavior?: CardBehavior;
}
