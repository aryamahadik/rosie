// The ledger (C-101, T-763; arch 09 line 457: "MONEY append-only", "Ledger entry never edited"; line 492: "Ledger lines are
// never edited; a refund is a new line"; K-32 v1 ledger_lines): one line per Stripe charge that moved a customer's money
// through the business's own Stripe, with the effect id it was made under and Stripe's own id, which reconciliation matches
// daily (arch 10 line 550).
//
// Lines are only ever appended. chargeLine makes the charge line of a payment from what Stripe said happened: the charge
// effect's result (K-14 charge.response `charged`) or the payment's event (K-14 `paymentSucceeded`, a pay link's or a bank's
// check); appendLine adds it to the lines a booking already has. Nothing here updates or deletes a line: a line already
// there is never changed (ledgerEdit), a payment has one charge line (K-32 ledger_lines_payment_charge_key) and a Stripe
// object one line of each kind (ledger_lines_stripe_object_key), and the same result read twice appends nothing, so a
// retried result or a repeated event writes nothing twice (arch 10 line 508).
//
// Only a taken charge makes a line: a card saved takes nothing ($0, no line: SCENARIOS.md "the card is saved, $0 is taken"),
// a decline takes nothing, and a charge that waits on the person's bank (needsAuthentication) has no line until its
// paymentSucceeded (K-14 README 'Effects'; RULES 3.14). Refund lines are the refunds task's (the card's "Not here").
//
// Who writes it: the runtime side only (K-32 rule 6: the Tool API may only read ledger_lines), as the effect's result or the
// provider event is recorded (K-05 v1.1 recordEffectResult's ledgerLineId names the line). K-05 v1.1 has no call that
// inserts the line itself (K-32 README open gaps, "K-05 calls"), so the line is handed over as K-32's row; a K-05 minor
// version carries it.

import { isStripeId } from "../../effects/stripe/request";
import { refuse } from "./errors";
import type { Money } from "./types";

/** A ledger line as K-32 v1 ledger_lines holds it, column for column (written_at is the database's now()). */
export interface LedgerLine {
  readonly id: string;
  readonly business_id: string;
  readonly booking_id: string | null;
  readonly kind: "charge" | "refund" | "refund_failed";
  readonly amount_cents: number;
  readonly currency: string;
  readonly payment_id: string | null;
  readonly refund_id: string | null;
  readonly effect_id: string;
  readonly stripe_object_id: string;
  readonly moved_at: string;
  readonly written_by: "effect_result" | "provider_event" | "reconciliation";
}

/** The payment a charge line names, as written (K-32 payments): its effect, booking, business and amount. */
export interface LedgerPayment {
  readonly id: string;
  readonly businessId: string;
  readonly bookingId: string | null;
  readonly effectId: string;
  readonly amount: Money;
}

/** What Stripe said was taken, in K-14 v1's terms. */
export type ChargeTaken =
  /** The charge effect's result, K-14 charge.response `charged`, recorded for the effect it ran. */
  | {
      readonly from: "effectResult";
      readonly effectId: string;
      readonly paymentId: string;
      readonly chargeId: string;
      readonly chargedAt: string;
    }
  /** K-14's `paymentSucceeded` event, stored once (K-07 provider event), naming the effect the payment was made under. */
  | {
      readonly from: "providerEvent";
      readonly effectId: string | null;
      readonly occurredAt: string;
      readonly payload: {
        readonly paymentId: string;
        readonly chargeId: string;
        readonly amount: Money;
      };
    };

/** A K-14 webhook event in the port's terms, as the gateway parsed it (K-14 v1 webhookEvent). */
export interface StripeEvent {
  readonly kind: string;
  readonly effectId: string | null;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The charge line's id by rule: one per payment, so a retried result or a repeated event makes the same line. */
export function chargeLineId(paymentId: string): string {
  return `ledger-${paymentId}`;
}

/**
 * K-14's paymentSucceeded event as a charge taken; null for any other event (a decline, a cancel, a card saved: none takes
 * money). An event that is not K-14's shape is refused, never read as money taken.
 */
export function takenFromEvent(event: StripeEvent): ChargeTaken | null {
  if (event.kind !== "paymentSucceeded") return null;
  const { payload } = event;
  const amount = payload.amount;
  if (
    !isStripeId(payload.paymentId) ||
    !isStripeId(payload.chargeId) ||
    !isRecord(amount) ||
    typeof amount.cents !== "number" ||
    typeof amount.currency !== "string"
  )
    refuse("ledgerMismatch", ["event.payload"]);
  return {
    from: "providerEvent",
    effectId: event.effectId,
    occurredAt: event.occurredAt,
    payload: {
      paymentId: payload.paymentId,
      chargeId: payload.chargeId,
      amount: { cents: amount.cents, currency: amount.currency },
    },
  };
}

/**
 * The charge line of a payment, from what Stripe said was taken: the payment's amount, under its own effect id, with
 * Stripe's charge id. Refused when the result is another effect's, or an event names another amount or currency: a line
 * says only what the record says happened (RULES 3.14).
 */
export function chargeLine(payment: LedgerPayment, taken: ChargeTaken): LedgerLine {
  if (taken.effectId !== payment.effectId) refuse("ledgerMismatch", ["effectId"]);
  const chargeId = taken.from === "effectResult" ? taken.chargeId : taken.payload.chargeId;
  const movedAt = taken.from === "effectResult" ? taken.chargedAt : taken.occurredAt;
  if (!isStripeId(chargeId)) refuse("ledgerMismatch", ["chargeId"]);
  if (!UTC.test(movedAt)) refuse("ledgerMismatch", ["movedAt"]);
  if (
    taken.from === "providerEvent" &&
    (taken.payload.amount.cents !== payment.amount.cents ||
      taken.payload.amount.currency !== payment.amount.currency)
  )
    refuse("ledgerMismatch", ["amount"]);
  if (!Number.isSafeInteger(payment.amount.cents) || payment.amount.cents < 1) refuse("badInput", ["amount"]);
  return {
    id: chargeLineId(payment.id),
    business_id: payment.businessId,
    booking_id: payment.bookingId,
    kind: "charge",
    amount_cents: payment.amount.cents,
    currency: payment.amount.currency,
    payment_id: payment.id,
    refund_id: null,
    effect_id: payment.effectId,
    stripe_object_id: chargeId,
    moved_at: movedAt,
    written_by: taken.from === "effectResult" ? "effect_result" : "provider_event",
  };
}

/**
 * What a line says happened: which money moved, which way, under which payment, effect and Stripe object. How it was
 * learned (written_by) and the time Stripe gave (moved_at) stay as the line was first written.
 */
const LINE_FACTS = [
  "id",
  "business_id",
  "booking_id",
  "kind",
  "amount_cents",
  "currency",
  "payment_id",
  "refund_id",
  "effect_id",
  "stripe_object_id",
] as const;

const sameMoney = (a: LedgerLine, b: LedgerLine): boolean => LINE_FACTS.every((fact) => a[fact] === b[fact]);

/**
 * Appends one line to the lines already written, append-only: the line to insert, or null when the same money is already
 * there, so a retried result, a repeated event, or the charge's result and its paymentSucceeded event both arriving write
 * nothing twice, and the first line stays as it was. Refused: a line already there that says other money (lines are never
 * edited), a second charge line for one payment, or a second line of one kind for one Stripe object.
 */
export function appendLine(lines: readonly LedgerLine[], line: LedgerLine): LedgerLine | null {
  for (const old of lines) {
    if (old.id === line.id) {
      if (sameMoney(old, line)) return null;
      refuse("ledgerEdit", ["id"]);
    }
    if (
      line.kind === "charge" &&
      old.kind === "charge" &&
      line.payment_id !== null &&
      old.payment_id === line.payment_id
    )
      refuse("ledgerTwice", ["payment_id"]);
    if (old.kind === line.kind && old.stripe_object_id === line.stripe_object_id)
      refuse("ledgerTwice", ["stripe_object_id"]);
  }
  return line;
}

/** The lines after appending: the old ones as they were, in order, then the new one when it is new. */
export function appendTo(lines: readonly LedgerLine[], line: LedgerLine): readonly LedgerLine[] {
  const added = appendLine(lines, line);
  return added === null ? [...lines] : [...lines, added];
}
