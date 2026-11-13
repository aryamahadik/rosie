// What the payments and ledger service (C-101, T-763) reads and gives. Every row it builds is K-32 v1's (contracts/db-schema/
// money: payments, payment_items, saved_cards, pay_links, ledger_lines), every effect row K-07 v1's (contracts/outbox-effects)
// with a port request in K-14 v1's terms (contracts/port-stripe), and every write K-05 v1.1's (a stateWrite insert and an
// effectNew), so the turn's one commit carries them (C-087, T-305).
//
// Money is whole cents with its currency (CQ-09; formats.v1 `money`), never a decimal. Ids are opaque strings code makes
// (CQ-09). Nothing here holds a card number, a key, a client secret or a person's words: a card is only Stripe's opaque
// customer and payment-method ids (RULES 3.12, 4.5; K-32 "Personal data").

import type { RowRef, StateWrite } from "../../commit";
import type { Money } from "../../finalize/slots/types";
import type { MoneyRecord, MoneyService } from "../../homes/money";

export type { Money };

/** The booking money is asked for, as read in the call's business scope (K-04 v1 bookings). */
export interface Booking {
  /** K-04 bookings.id. */
  readonly id: string;
  /** K-04 bookings.business_id: the call's business, whose own Stripe account takes the money (RULES 3.1). */
  readonly businessId: string;
  /** K-04 bookings.version as read: the commit compares it (limit 4), so money never follows a booking that changed. */
  readonly version: number;
  /** K-04 bookings.booker_person_id: who pays what is due at booking, and whose own yes binds the money (RULES 3.6, 3.13). */
  readonly bookerPersonId: string;
  /** K-04 bookings.payer_person_id: who the rest is billed to, who approves nothing (RULES 3.13). */
  readonly payerPersonId: string;
}

/** One line of the booking, as the money step reads it (K-30 v1 booking_lines, the price, deposit and fee copied in). */
export interface BookingLine {
  /** K-30 booking_lines.id. */
  readonly id: string;
  /** K-30 booking_lines.version as read (limit 4). */
  readonly version: number;
  /** The line's service as the money home reads it: its money path, how it is paid, its amounts (S13-55; RULES 3.7). */
  readonly service: MoneyService;
}

/**
 * The person's own exact yes the money rests on (limit 3, C-083; arch 01 line 89: "the decider's own answer, bound to the
 * exact text and versions of the read-back it answers"): the read-back that showed the price and what is taken now
 * (A5-04: "only with the price and the yes shown first"), answered by the person it was sent to.
 */
export interface ExactYes {
  /** The open question whose read-back it answered (K-04 open_questions.id). */
  readonly openQuestionId: string;
  /** Whose yes: the person the read-back was sent to, who answered it in their own thread or page (RULES 3.6). */
  readonly personId: string;
  /** The read-back's business (K-04 open_questions.business_id): limit 3 ties a money part to it. */
  readonly businessId: string | null;
  /** The read-back's booking (K-04 open_questions.booking_id): limit 3 ties a money part to it. */
  readonly bookingId: string | null;
  /**
   * The turn whose commit records the answer: this turn's, when the gate passed the part as an exact yes and the
   * question's close rides the same commit as the money rows (all or nothing: arch 10 line 508), or an earlier turn's
   * (K-04 open_questions.status answered). Null while it is not recorded as answered: waiting, open, defaulted or
   * withdrawn, or a yes that never passed the gate.
   */
  readonly answeredIn: string | null;
}

/** A saved card row (K-32 v1 saved_cards), as the money step reads it. */
export interface SavedCard {
  /** saved_cards.id. */
  readonly id: string;
  /** saved_cards.booking_id: only this booking's charges go on it (A5-07); null for a plan's card. */
  readonly bookingId: string | null;
  /** saved_cards.saved_at is set: Stripe saved it (cardSaved), so it can be charged. */
  readonly saved: boolean;
  /** saved_cards.replaced_at is set: nothing goes on it without asking, one pay link instead (A9-14; K-14 default 17). */
  readonly replaced: boolean;
  /** saved_cards.removed_at is set: it can never be charged again (S13-55). */
  readonly removed: boolean;
}

/**
 * The card money is taken on: Stripe's opaque ids of a card the person typed into Stripe's own form on their page
 * (RULES 3.12: Rosie never sees the card), kept for the booking as a saved card or typed for this payment only (K-32
 * default 15).
 */
export interface Card {
  /** Whose card: the person who typed it on their own page. */
  readonly personId: string;
  /** Their customer on the business's own Stripe (K-14 charge.portRequest customerId). */
  readonly stripeCustomerId: string;
  /** The card as Stripe's payment-method id (K-14 charge.portRequest paymentMethodId). */
  readonly stripePaymentMethodId: string;
  /** The saved card row that keeps it for the booking, or null for a card typed for this payment only. */
  readonly savedCard: SavedCard | null;
}

/** K-32 v1 payments.purpose for a booking's money (A5-04; A6-32; A9-05, A9-12): never a hold. */
export const BOOKING_PURPOSES = ["deposit", "full_price", "rest", "extra"] as const;
export type BookingPurpose = (typeof BOOKING_PURPOSES)[number];

/** K-32 v1 payment_items.share: what one part of a payment is for its line. */
export type Share = "deposit" | "full" | "rest" | "extra";

/** One part of a payment, against one booking line (K-32 v1 payment_items; RULES 3.2: several services, one payment). */
export interface PaymentItem {
  /** The booking line it pays toward (K-30 booking_lines.id). */
  readonly lineId: string;
  readonly share: Share;
  readonly amount: Money;
}

/** Where a pay link is given (K-32 v1 pay_links.given_via): text, email, the customer's own AI, or the page. */
export type GivenVia = "text" | "email" | "ai" | "page";

/** The business the call runs for (K-04 businesses; K-23 v1 business_setup.stripe_account_id). */
export interface PayingBusiness {
  readonly id: string;
  /** The name a charge says it is for (RULES 3.14; K-14 description: "Lee's Barbershop: deposit for ..."). */
  readonly name: string;
  /** The business's own connected Stripe account, where every charge lands (RULES 3.1; K-14 businessAccount). */
  readonly stripeAccountId: string;
}

/**
 * Makes a pay link's code from its id (K-32 v1 default 21: 32 bytes of HMAC-SHA-256 of the link's id under the named
 * secret, in base64url, 43 characters), so a message carrying the live link makes the same code again and no row ever
 * holds it. The composition root binds it to the secret it reads by name; nothing here reads a key.
 */
export interface PayLinkCodes {
  /** The secret's name, never its value (default PAY_LINK_CODE_SECRET). */
  readonly keyName: string;
  codeOf(linkId: string): Promise<string>;
}

/** What one turn's payments service is built with, inside the call's business scope. */
export interface PaymentsDeps {
  /** The turn whose one commit carries the rows (K-04 turns.id): every effect row names it, and two charges in it are refused. */
  readonly turnId: string;
  /** The turn's trace (K-07 effectRow.traceId). */
  readonly traceId: string;
  readonly business: PayingBusiness;
  /** The commit's now in UTC, from the clock the call is given (BP 9.4): a pay link's deadline comes after it. */
  readonly now: string;
  /** The pay link codes' port; a pay link is refused without it. */
  readonly payLinkCodes?: PayLinkCodes;
  /** The turn's part of every row id; default the turn's id. */
  readonly turnKey?: string;
}

/** A K-14 v1 business account: every customer's money lands in the business's own Stripe (RULES 3.1). */
export interface BusinessAccount {
  readonly kind: "business";
  readonly accountId: string;
}

/** K-14 v1 saveCard.portRequest. */
export interface SaveCardPort {
  readonly account: BusinessAccount;
  readonly customerId: string | null;
}

/** K-14 v1 charge.portRequest: captured at once, with no field for a hold (RULES 3.2; D65; refuse-card-hold.json). */
export interface ChargePort {
  readonly account: BusinessAccount;
  readonly purpose: StripePurpose;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly customerPresent: boolean;
  readonly description: string;
}

/** K-14 v1 payLink.portRequest: the payment Rosie's own pay page takes, never a hold. */
export interface PayLinkPort {
  readonly account: BusinessAccount;
  readonly purpose: StripePurpose;
  readonly customerId: string | null;
  readonly saveCardForLater: boolean;
  readonly description: string;
}

/** K-14 v1 purpose for a booking's money. */
export type StripePurpose = "deposit" | "fullPrice" | "rest" | "extra";

/** The Stripe kinds this service writes (K-07 v1 effectKind). */
export type MoneyEffectKind = "stripe_save_card" | "stripe_charge" | "stripe_pay_link";

/**
 * One effect row as the commit writes it (K-05 v1.1 effectNew; K-07 v1 effectRow): its id is its one idempotency key, it
 * runs on the business's own account, and the effects runner (C-109, T-326) builds K-14's request from it alone. K-05's
 * generated effectNew is a loose record, so a unit's writes take it through rows.ts effectNewOf.
 */
export interface MoneyEffect {
  readonly effectId: string;
  readonly businessId: string;
  readonly bookingId: string;
  readonly kind: MoneyEffectKind;
  readonly port: "stripe";
  readonly calendarProvider: null;
  readonly visitId: null;
  /** The payer, or whose card is saved (K-07 effectRow.personId). */
  readonly personId: string;
  readonly handleId: null;
  /** What is due now for a charge or a pay link; null for a card save (K-14 README 'Effects'). */
  readonly amount: Money | null;
  readonly portRequest: SaveCardPort | ChargePort | PayLinkPort;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

/**
 * What a call of the service writes in the turn's one commit: the rows it read at their versions (limit 4), its money
 * rows as inserts (K-05 v1 stateWrite), and its effect rows (K-05 v1.1 effectNew). They go into the part's UnitWrites
 * (T-305: `versionsRead`, `state`, `effects.write`).
 */
export interface MoneyWrites {
  readonly versionsRead: readonly RowRef[];
  readonly state: readonly StateWrite[];
  readonly effects: readonly MoneyEffect[];
}

/** A card save: its effect, and the saved card row the save's result and cardSaved fill (K-32 saved_cards). */
export interface CardSave {
  readonly savedCardId: string;
  readonly effectId: string;
  readonly writes: MoneyWrites;
}

/** A payment asked: its row, written pending, its items and the one effect it runs from. */
export interface PaymentAsked {
  readonly paymentId: string;
  readonly effectId: string;
  readonly amount: Money;
  readonly writes: MoneyWrites;
}

/** A pay link: its payment, and the link row that keeps only its code's hash (K-32 pay_links). */
export interface PayLinkAsked extends PaymentAsked {
  readonly payLinkId: string;
}

/** A booking's money step (A5-04), as the service reads it. */
export interface MoneyStepInput {
  readonly booking: Booking;
  /** The flow's compiled record (K-01 v1 record, the turn's pinned bundle), whose ways say what each way takes now. */
  readonly record: MoneyRecord;
  /** The booking's currency (ISO 4217): every line's amounts are in it. */
  readonly currency: string;
  /** The booking's lines, its own first (S13-55: all that is due now in one payment, on one card). */
  readonly lines: readonly BookingLine[];
  /**
   * How it books (A6-01): now, or with the owner's OK first, when nothing is charged until the OK and the card is saved
   * for it (RULES 3.11; A6-02). Default now.
   */
  readonly approval?: "now" | "ownerOk";
  /** The booker's own exact yes to the read-back that showed the price and what is taken now. */
  readonly yes: ExactYes | null;
  /** The card for money now, from the booker's page: a card saved for this booking, or one typed for this payment. */
  readonly card: Card | null;
  /** The booker's customer on the business's own Stripe, for a card save; null makes one (K-14 saveCard). */
  readonly stripeCustomerId: string | null;
  /** What the money is for, as the charge says it (RULES 3.14), made by code from the services' names. */
  readonly what: string;
}

/** A5-04's four ways for the booking: exactly one happens (S13-55; RULES 3.2). */
export type MoneyWay = "nothing" | "card" | "deposit" | "full";

/** What a booking's money step built: at most one Stripe effect row (none for nothing taken). */
export interface MoneyStep {
  /** A5-04's branch: nothing taken, a card saved, a deposit, or the full price. */
  readonly way: MoneyWay;
  /** What this step writes: nothing, the card save, or the one charge (on a request, the card save; the OK charges). */
  readonly builds: "nothing" | "saveCard" | "charge";
  /** All that is due now, in one payment on one card; zero for nothing and a card. */
  readonly dueNow: Money;
  readonly writes: MoneyWrites;
  /** The payment the charge asks, or the card save, when there is one. */
  readonly paymentId: string | null;
  readonly savedCardId: string | null;
}
