// The Stripe port the Stripe effect kinds call (C-109, T-326): K-14 v1's five calls that run from a K-07 v1 effect row
// (saveCard, charge, payLink, refund, disputeEvidence) and listMoney with an effect id, the effects runner's look-up
// before a late try (K-14 README 'Effects', 'A try past 23 hours').
//
// The requests are K-14 v1's generated types (`npm run contracts:types`; ADR-005), type imports only. Each call answers
// its outcome in K-14's terms (`<call>.response` or `<call>.errors`), at once or as a promise; the kinds read the answer
// as unknown and check it before anything is recorded (answer.ts), so an adapter that answers off the contract is never
// read as a charge or a decline. The adapter (C-214 Stripe Connect, C-215 Stripe platform billing) sends the effect's
// key as Stripe's Idempotency-Key on every try and puts the effect id on the object it makes as rosie_effect_id (K-14
// README 'Effects'); in tests the Stripe double (adapters/src/stripe/double, T-422) answers the same calls.

import type * as K14 from "../../../../contracts/generated/port-stripe/port-stripe.v1";
import type { EffectKind, EffectRow } from "../kinds";

export type SaveCardRequest = K14.SaveCardRequest;
export type ChargeRequest = K14.ChargeRequest;
export type PayLinkRequest = K14.PayLinkRequest;
export type RefundRequest = K14.RefundRequest;
export type DisputeEvidenceRequest = K14.DisputeEvidenceRequest;
export type ListMoneyRequest = K14.ListMoneyRequest;
/** The account a call runs on: the business's own, or Rosfield's for its own bill (K-14 v1 account). */
export type StripeAccount = K14.StripeAccount;

/** What every call is given besides its request. */
export interface StripeCallOptions {
  /** Aborted when the effects runner stops waiting for the try (its answerBy), so the adapter lets the call go. */
  readonly signal: AbortSignal;
}

/** K-14 v1's calls the Stripe effect kinds make; each answer is read as unknown and checked (answer.ts). */
export interface StripeEffectPort {
  saveCard(request: SaveCardRequest, options: StripeCallOptions): unknown;
  charge(request: ChargeRequest, options: StripeCallOptions): unknown;
  payLink(request: PayLinkRequest, options: StripeCallOptions): unknown;
  refund(request: RefundRequest, options: StripeCallOptions): unknown;
  disputeEvidence(request: DisputeEvidenceRequest, options: StripeCallOptions): unknown;
  listMoney(request: ListMoneyRequest, options: StripeCallOptions): unknown;
}

/** The K-14 v1 calls that run from an effect row (K-14 README 'Effects'). */
export type StripeEffectCall = "saveCard" | "charge" | "payLink" | "refund" | "disputeEvidence";

/** The six K-07 v1 kinds that run through the Stripe port (K-07 effects_port_matches_kind), in K-07's order. */
export const STRIPE_KINDS = [
  "stripe_save_card",
  "stripe_charge",
  "stripe_refund",
  "stripe_pay_link",
  "stripe_dispute_evidence",
  "rosfield_monthly_charge",
] as const satisfies readonly EffectKind[];

export type StripeKind = (typeof STRIPE_KINDS)[number];

/** Each Stripe kind's K-14 call (K-14 README 'Effects' table; ../kinds.ts EFFECT_KINDS names the same calls). */
export const CALL_OF: Readonly<Record<StripeKind, StripeEffectCall>> = {
  stripe_save_card: "saveCard",
  stripe_charge: "charge",
  stripe_refund: "refund",
  stripe_pay_link: "payLink",
  stripe_dispute_evidence: "disputeEvidence",
  rosfield_monthly_charge: "charge",
};

/** True for a K-07 v1 kind that runs through the Stripe port. */
export function isStripeKind(value: unknown): value is StripeKind {
  return typeof value === "string" && (STRIPE_KINDS as readonly string[]).includes(value);
}

export interface StripeKindsDeps {
  /** The Stripe port (K-14 v1): the adapter, or the double in tests. */
  readonly port: StripeEffectPort;
  /**
   * When the effect row was written (K-07 effects.created_at), from which a late try's 23 hours count (K-14 default 18;
   * QUESTIONS.md CQ-62). K-05 v1.1's claimed row does not carry it, so the caller reads it; null when it cannot.
   */
  writtenAtOf(effect: EffectRow): Promise<string | null>;
  /** The time now, in epoch milliseconds; default Date.now. Tests give the runner's fake clock. */
  readonly now?: () => number;
}
