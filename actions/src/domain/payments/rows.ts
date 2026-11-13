// The rows the payments service writes (C-101, T-763), each exactly as K-32 v1 (contracts/db-schema/money), K-07 v1 and
// K-14 v1 hold them, with the checks that keep a malformed row from ever reaching the commit:
//
//   - every effect row runs on the business's own account (RULES 3.1), with its effect id as its one idempotency key
//     (arch 10 line 542; K-14 README 'Effects'), and is held to K-14 v1 by T-326's buildStripeRequest, the effects
//     runner's own check: a port request carrying a field K-14 has no place for, a hold's captureMethod included, is
//     refused here and never written (RULES 3.2; D65; refuse-card-hold.json);
//   - every payment is written pending, method card, from its one effect (K-32 rule 5: only the effect's result or a
//     provider event makes a Stripe payment paid), its items adding up to its amount (rule 10);
//   - every amount is whole cents, at least one, in the booking's currency (CQ-09; payments_money).
//
// Row ids are fixed by rule from the booking and the turn (default 1 in service.ts), so a rerun of the turn builds the same
// rows and a second charge for one booking in one turn would take the first one's key.

import type { EffectNew, RowRef, StateWrite, UnitWrites } from "../../commit";
import type { EffectRow } from "../../effects/kinds";
import { buildStripeRequest } from "../../effects/stripe";
import { isStripeId } from "../../effects/stripe/request";
import { refuse } from "./errors";
import type {
  Booking,
  BookingLine,
  BusinessAccount,
  Money,
  MoneyEffect,
  MoneyEffectKind,
  MoneyWrites,
  PaymentItem,
  PayingBusiness,
  SaveCardPort,
  ChargePort,
  PayLinkPort,
} from "./types";

/** K-14 v1 idempotencyKey: at most 255 characters, the most Stripe takes. */
export const MAX_KEY_LENGTH = 255;

const CURRENCY = /^[A-Z]{3}$/u;
/** Thirteen or more digits in a row read as a card number (K-14 stripeId; K-32 saved_cards_no_card_number). */
const CARD_NUMBER = /[0-9]([ -]?[0-9]){12,}/u;
/** K-14 v1 description: words, at most 500 characters. */
const MAX_DESCRIPTION = 500;

/** An opaque id code makes (CQ-09): a non-empty string with no space around it. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Refuses a field that is not an id. */
export function requireId(value: unknown, field: string): string {
  if (!isId(value)) refuse("badInput", [field]);
  return value;
}

/** Refuses a field that is not Stripe's opaque id (K-14 stripeId: never a card number). */
export function requireStripeId(value: unknown, field: string): string {
  if (!isStripeId(value) || !isId(value)) refuse("badInput", [field]);
  return value;
}

/** Whole cents, at least one, in the booking's currency (CQ-09; K-32 payments_money). Refuses anything else. */
export function requireMoney(amount: Money, currency: string, field: string): Money {
  if (!CURRENCY.test(currency)) refuse("badInput", ["currency"]);
  if (!Number.isSafeInteger(amount.cents) || amount.currency !== currency) refuse("badInput", [field]);
  if (amount.cents < 1) refuse("nothingDue", [field]);
  return { cents: amount.cents, currency: amount.currency };
}

/** The account every customer's money lands in: the business's own (RULES 3.1; K-14 businessAccount). */
export function accountOf(business: PayingBusiness): BusinessAccount {
  return { kind: "business", accountId: requireStripeId(business.stripeAccountId, "stripeAccountId") };
}

/** A row's id by rule: its kind, the booking and the turn (service.ts default 1). */
export function rowId(prefix: string, bookingId: string, turnKey: string): string {
  return `${prefix}-${bookingId}-${turnKey}`;
}

/**
 * What a charge says it is for (RULES 3.14: "Every charge says what it is for"; K-14 description), made by code from the
 * business's name and the services' words, as K-14 v1's fixtures write it: "Lee's Barbershop: deposit for the Groom's
 * package", "...: Signature cut and hot towel shave, paid in full". Refuses words that are empty, past K-14's 500
 * characters, or that read as a card number.
 */
export function descriptionOf(
  business: PayingBusiness,
  purpose: "deposit" | "full_price" | "rest" | "extra",
  what: string,
): string {
  const words = what.trim();
  if (words.length === 0 || /[\r\n]/u.test(words)) refuse("badInput", ["what"]);
  const name = business.name.trim();
  if (name.length === 0) refuse("badInput", ["business.name"]);
  const text =
    purpose === "deposit"
      ? `${name}: deposit for ${words}`
      : purpose === "full_price"
        ? `${name}: ${words}, paid in full`
        : `${name}: ${words}`;
  if (Array.from(text).length > MAX_DESCRIPTION || CARD_NUMBER.test(text)) refuse("badInput", ["what"]);
  return text;
}

/** The rows a booking's money rests on, at the versions read: the booking and its lines (limit 4). */
export function versionsOf(
  booking: Booking,
  lines: readonly Pick<BookingLine, "id" | "version">[],
): RowRef[] {
  const rows: RowRef[] = [{ table: "bookings", rowId: booking.id, version: booking.version }];
  for (const line of lines) rows.push({ table: "booking_lines", rowId: line.id, version: line.version });
  for (const row of rows)
    if (!Number.isSafeInteger(row.version) || row.version < 1) refuse("badInput", [`${row.table}.version`]);
  return rows;
}

/** An insert of one money row (K-05 v1 stateWrite; K-32 v1's columns and values). */
export function insert(table: string, values: Readonly<Record<string, unknown>>): StateWrite {
  return { op: "insert", table, values: { ...values } };
}

/** An effect row the commit writes, its id its one key (K-05 v1.1 effectNew; K-07 v1 effectRow). */
export function effectOf(input: {
  readonly effectId: string;
  readonly kind: MoneyEffectKind;
  readonly booking: Booking;
  readonly personId: string;
  readonly amount: Money | null;
  readonly portRequest: SaveCardPort | ChargePort | PayLinkPort;
  readonly traceId: string;
}): MoneyEffect {
  if (Array.from(input.effectId).length > MAX_KEY_LENGTH) refuse("idTooLong", ["effectId"]);
  return {
    effectId: input.effectId,
    businessId: input.booking.businessId,
    bookingId: input.booking.id,
    kind: input.kind,
    port: "stripe",
    calendarProvider: null,
    visitId: null,
    personId: input.personId,
    handleId: null,
    amount: input.amount,
    portRequest: input.portRequest,
    idempotencyKey: input.effectId,
    traceId: requireId(input.traceId, "traceId"),
  };
}

/**
 * The effect row as the effects runner claims it (K-05 v1.1 effectRow: pending, run 1, no try yet), under the turn that
 * commits it.
 */
export function claimedRowOf(effect: MoneyEffect, turnId: string): EffectRow {
  return {
    effectId: effect.effectId,
    turnId,
    jobId: null,
    businessId: effect.businessId,
    bookingId: effect.bookingId,
    kind: effect.kind,
    port: effect.port,
    calendarProvider: null,
    visitId: null,
    personId: effect.personId,
    handleId: null,
    amount: effect.amount === null ? null : { cents: effect.amount.cents, currency: effect.amount.currency },
    portRequest: structuredClone({ ...effect.portRequest }),
    idempotencyKey: effect.idempotencyKey,
    state: "pending",
    tries: 0,
    runs: 1,
    firstTryAt: null,
    providerObjectId: null,
    errorCode: null,
    ledgerLineId: null,
    traceId: effect.traceId,
  };
}

/**
 * Holds a built effect row to K-14 v1 the way the effects runner will (T-326's buildStripeRequest): its effect id and key,
 * its amount, and its port request field by field, so a field K-14 has no place for (a hold's captureMethod) or a request
 * the runner would refuse is never written. Refuses with the fields at fault (names, never values).
 */
export function checkEffect(effect: MoneyEffect, turnId: string): MoneyEffect {
  const port: Readonly<Record<string, unknown>> = { ...effect.portRequest };
  if (Object.hasOwn(port, "captureMethod")) refuse("hold", ["port.captureMethod"]);
  const built = buildStripeRequest(claimedRowOf(effect, turnId));
  if (!built.ok) refuse("notStripeRequest", built.faults);
  return effect;
}

/** The effect row as K-05 v1.1's effectNew, which a unit's writes carry (T-305 UnitWrites.effects.write). */
export function effectNewOf(effect: MoneyEffect): EffectNew {
  return {
    ...effect,
    amount: effect.amount === null ? null : { cents: effect.amount.cents, currency: effect.amount.currency },
    portRequest: structuredClone({ ...effect.portRequest }),
  };
}

/**
 * A passed part's writes with a call's money writes added (T-305 UnitWrites): the rows read, the money rows and the effect
 * rows, after what the part already writes.
 */
export function withMoney(unit: UnitWrites, writes: MoneyWrites): UnitWrites {
  return {
    ...unit,
    versionsRead: [...unit.versionsRead, ...writes.versionsRead],
    state: [...unit.state, ...writes.state],
    effects: {
      write: [...unit.effects.write, ...writes.effects.map(effectNewOf)],
      letGo: [...unit.effects.letGo],
    },
  };
}

/** A payment's items, each against its line, adding up to the payment's amount (K-32 rule 10). */
export function itemsTotal(items: readonly PaymentItem[], currency: string): Money {
  if (items.length === 0) refuse("nothingDue", ["items"]);
  let cents = 0;
  items.forEach((item, index) => {
    requireId(item.lineId, `items.${String(index)}.lineId`);
    cents += requireMoney(item.amount, currency, `items.${String(index)}.amount`).cents;
  });
  if (!Number.isSafeInteger(cents)) refuse("badInput", ["items"]);
  return { cents, currency };
}

/** One payment item row per part, with its id by rule (K-32 payment_items; one per payment, line and share). */
export function itemRows(paymentId: string, booking: Booking, items: readonly PaymentItem[]): StateWrite[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const key = `${item.lineId}|${item.share}`;
    if (seen.has(key)) refuse("badInput", [`items.${String(index)}`]);
    seen.add(key);
    return insert("payment_items", {
      id: `item-${paymentId}-${String(index + 1)}`,
      payment_id: paymentId,
      business_id: booking.businessId,
      booking_line_id: item.lineId,
      share: item.share,
      amount_cents: item.amount.cents,
      currency: item.amount.currency,
    });
  });
}

/**
 * The payment row, written pending from its one effect (K-32 payments: method card, its effect unique, no fee or plan
 * charge named; asked_at the database's now, with its effect's created_at; K-32 rule 5: only the effect's result or a
 * provider event makes it paid). There is no held or authorized state to write (RULES 3.2; payments_state_known).
 */
export function paymentRow(input: {
  readonly paymentId: string;
  readonly booking: Booking;
  readonly payerPersonId: string;
  readonly purpose: "deposit" | "full_price" | "rest" | "extra";
  readonly amount: Money;
  readonly effectId: string;
  readonly savedCardId: string | null;
}): StateWrite {
  return insert("payments", {
    id: input.paymentId,
    business_id: input.booking.businessId,
    payer_person_id: input.payerPersonId,
    booking_id: input.booking.id,
    purpose: input.purpose,
    method: "card",
    amount_cents: input.amount.cents,
    currency: input.amount.currency,
    state: "pending",
    effect_id: input.effectId,
    saved_card_id: input.savedCardId,
    booking_fee_id: null,
    plan_charge_id: null,
    recorded_by_person_id: null,
  });
}
