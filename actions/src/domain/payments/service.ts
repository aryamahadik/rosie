// The payments and ledger service (C-101, T-763; arch 02 diagram line 105, "Payments & ledger"; S13-55; RULES 3.1 to 3.14):
// it turns a booking's money into effect rows and money rows that ride the turn's one commit (C-087, T-305), so a charge
// runs once from the row the commit wrote (arch 10 line 508; tour line 420: "Charges, refunds and calendar updates run
// after the save, from rows it wrote, once each"), on the business's own Stripe account (RULES 3.1), through the effects
// runner's Stripe kinds (C-109, T-326) and K-14 v1's port.
//
// One service serves one turn, inside the call's business scope, and reads its now from the clock it is given (BP 9.4).
// Every call only builds: it reads no row and calls no port but the pay link codes' (a pure function of the link's id), so
// a repeated turn builds the same rows again before K-05 answers repeated (T-305: writesOf has no outside effect).
//
//   moneyStep  A5-04, "What's taken now?": exactly one of nothing, a card saved, a deposit or the full price, read from the
//              record's ways (K-01 record.ways, through the money home: T-137, T-593), never written here. All that is due
//              now is added up across the booking's services and taken in one payment on one card (RULES 3.2); part paid
//              now and part left is a deposit, all of it the full price (A5-04). Each step builds at most one Stripe effect
//              row with its key: none for nothing taken; the card save when a card must go on file and none is saved for
//              the booking yet (A5-07; and on a request, RULES 3.11: "the card is saved, then charged at the OK"); else the
//              one charge for all that is due now, with the person on the page (A5-13, A5-16).
//   saveCard   A5-07: the card goes on file through Stripe, in the business's own account; nothing is charged.
//   charge     All that is due now, on a card the person typed in Stripe's own form, captured at once: never a hold.
//   payLink    The payment Rosie's own pay page takes (A6-32, A9-05, MC C3), with its link row keeping only its code's hash.
// A charge's and a pay link's items name only the lines the booking was read with, and add up to the payment (K-32 rule
// 10); the booking and those lines are the versions the commit compares (limit 4).
//
// The hard invariants, each refused before anything is built (PaymentRefusedError, nothing written):
//   - no charge without a committed exact yes bound to that booking (yes.ts): every charge, pay link and money step;
//   - never a hold: no input names one, no state, purpose or way can hold one, and every effect row is held to K-14 v1 as
//     the effects runner holds it, so a port request with a hold's captureMethod is refused (rows.ts checkEffect;
//     RULES 3.2; D65; refuse-card-hold.json);
//   - two charges for one booking in one turn are refused (turn.ts): a charge or a pay link, each one payment;
//   - the ledger is append-only (ledger.ts).
//
// Not here: refunds (the next task); journey 5's steps, the page and its clock (the money-before task); fees (C-106),
// packs and plans; the event-log kinds of these rows, which K-08 v1.2 does not have yet (default 3).
//
// Nothing here logs. What it throws names a reason and fields (errors.ts), never an amount, an id's value or a card's ids.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Row ids are fixed by rule, `<kind>-<booking id>-<turn key>` (eff-card, eff-charge, eff-pay-link, card, pay, link;
//      items `item-<payment id>-<n>`; the charge line `ledger-<payment id>`), the turn key the turn's own id, as T-305's
//      ids are fixed by rule; an effect's id is its one idempotency key, as K-07's and K-14's fixtures write them, so a
//      rerun of the turn builds the same request. An effect id past K-14's 255 characters is refused, never shortened.
//   2. Every money step needs the booker's committed exact yes bound to the booking, a card save included, since A5-04
//      takes money or a card "only with the price and the yes shown first". A card saved for a booking on its own
//      (saveCard) moves no money and needs no yes; it is the booker's own card for that booking only.
//   3. The money rows carry no event-log entries of their own: an entry's kind is K-08's closed list (K-04
//      event_log.kind), and K-08 v1.2 has no money kind yet (K-32 README open gaps, "K-08 event kinds ... a K-08 minor
//      version before C-101 commits them"), so none is made up here. The effect row's own `effect.created` entry, which
//      the commit writes with the answer as approvedBy (T-305 build.ts), is the audit line meanwhile.
//   4. A charge at booking (deposit, full price) goes on the booker's own card (RULES 3.13: the person booking pays what
//      is due at booking); the rest and an extra on the payer's. A pay link is for that same person.
//   5. A deposit keeps the card (A5-13: "the card stays saved"; the record's deposit way saves one), so its charge goes
//      on a card saved for this booking; the full price may go on a card typed for this payment only (K-32 default 15).
//   6. A card the network replaced, or one removed, is never charged (A9-14: "Nothing goes on a new card without
//      asking"; S13-55); a card saved for another booking neither (A5-07: "It's there only for what the customer ticks").

import { MoneyHomeError, readMoney, type MoneyBooking, type MoneyService } from "../../homes/money";
import { refuse, PaymentRefusedError } from "./errors";
import {
  accountOf,
  checkEffect,
  descriptionOf,
  effectOf,
  insert,
  itemRows,
  itemsTotal,
  paymentRow,
  requireId,
  requireStripeId,
  rowId,
  versionsOf,
} from "./rows";
import { TurnCharges } from "./turn";
import {
  BOOKING_PURPOSES,
  type Booking,
  type BookingLine,
  type BookingPurpose,
  type Card,
  type CardSave,
  type ExactYes,
  type GivenVia,
  type Money,
  type MoneyStep,
  type MoneyStepInput,
  type MoneyWay,
  type PaymentAsked,
  type PaymentItem,
  type PaymentsDeps,
  type PayLinkAsked,
  type Share,
  type StripePurpose,
} from "./types";
import { requireBoundYes } from "./yes";

/** K-14 v1 purpose for each K-32 purpose a booking's money takes. */
const STRIPE_PURPOSE: Readonly<Record<BookingPurpose, StripePurpose>> = {
  deposit: "deposit",
  full_price: "fullPrice",
  rest: "rest",
  extra: "extra",
};

/** Words that ask for money held on a card and taken later: never (RULES 3.2; D65). */
const HOLD_WORDS = /hold|authori[sz]|capture/iu;

/** The four ways a service asks money before the visit (S13-55), as the money home's record names them. */
const BEFORE_WAYS: readonly string[] = ["none", "card", "deposit", "full"];

/** K-32 pay_links.given_via. */
const GIVEN_VIA: readonly GivenVia[] = ["text", "email", "ai", "page"];

/** A pay link's code (K-32 default 21): 32 bytes in base64url, 43 characters. */
const PAY_LINK_CODE = /^[A-Za-z0-9_-]{43}$/u;

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/u;

/** A booking line as read, by its id and version (K-30 booking_lines): a payment's items name only these (K-32 rule 10). */
export type LineRead = Pick<BookingLine, "id" | "version">;

/** A charge on a card (K-14 charge, run as K-07 stripe_charge). */
export interface ChargeInput {
  readonly booking: Booking;
  /** The booking's lines as read: the items name only these, and their versions are compared (limit 4). */
  readonly lines: readonly LineRead[];
  readonly purpose: BookingPurpose;
  /** What it pays toward each booking line, adding up to the charge (RULES 3.2: one payment for all that is due now). */
  readonly items: readonly PaymentItem[];
  readonly card: Card;
  /** The person is on the page while it is charged (K-14 customerPresent): at booking yes; at the OK or at DONE no. */
  readonly customerPresent: boolean;
  readonly yes: ExactYes | null;
  /** What it is for, as the charge says it (RULES 3.14), made by code from the services' names. */
  readonly what: string;
}

/** A card save for a booking (K-14 saveCard, run as K-07 stripe_save_card). */
export interface SaveCardInput {
  readonly booking: Booking;
  /** Whose card: the booker, on their own page (RULES 3.13: "Their own card is saved, where the service saves one"). */
  readonly personId: string;
  /** Their customer on the business's own Stripe; null makes one, and the save's result names it (K-14 saveCard). */
  readonly stripeCustomerId: string | null;
}

/** A pay link (K-14 payLink, run as K-07 stripe_pay_link; K-32 pay_links). */
export interface PayLinkInput {
  readonly booking: Booking;
  /** The booking's lines as read: the items name only these, and their versions are compared (limit 4). */
  readonly lines: readonly LineRead[];
  readonly purpose: BookingPurpose;
  readonly items: readonly PaymentItem[];
  /** Whom it is for: the person paying (default 4). Anyone with a forwarded link can pay it (A9-11). */
  readonly personId: string;
  /** Their customer on the business's own Stripe: needed to save the paying card for later (K-14 payLink). */
  readonly stripeCustomerId: string | null;
  /** Stripe saves the card that pays it to the customer, as the one saved for the booking (A6-32; K-14 'Pay links'). */
  readonly saveCardForLater: boolean;
  /** Where it is given (K-32 pay_links.given_via): at least one place. */
  readonly givenVia: readonly GivenVia[];
  /** The deadline its clock row closes it at (clock.pay; MC C3's 15 minutes), after now; null for none (a bill: A9-05). */
  readonly dueAt: string | null;
  readonly yes: ExactYes | null;
  readonly what: string;
}

/** One turn's payments and ledger service. */
export interface Payments {
  /** The turn it builds for. */
  readonly turnId: string;
  /** A5-04: the booking's money step, exactly one way, at most one Stripe effect row. */
  moneyStep(input: MoneyStepInput): MoneyStep;
  /** A5-07: a card saved for the booking, nothing charged. */
  saveCard(input: SaveCardInput): CardSave;
  /** All that is due now on a card, captured at once (never a hold), on the business's own account. */
  charge(input: ChargeInput): PaymentAsked;
  /** One pay link for a payment, its code kept only as a hash. */
  payLink(input: PayLinkInput): Promise<PayLinkAsked>;
}

/** The ways the money home reads a service by: its record's four ways and credit (K-01 record.ways). */
function readingOf(input: MoneyStepInput): ReturnType<typeof readMoney> {
  const services: MoneyService[] = input.lines.map((line, index) => {
    const before: unknown = line.service.before;
    if (typeof before === "string" && HOLD_WORDS.test(before))
      refuse("hold", [`lines.${String(index)}.before`]);
    if (typeof before !== "string" || !BEFORE_WAYS.includes(before))
      refuse("badInput", [`lines.${String(index)}.before`]);
    return { ...line.service, id: index === 0 ? "own" : `line${String(index + 1)}` };
  });
  const booking: MoneyBooking = {
    flow: input.record.flow,
    currency: input.currency,
    services,
    took: false,
  };
  try {
    return readMoney(booking, input.record);
  } catch (error) {
    if (error instanceof MoneyHomeError) refuse("badInput", ["lines"]);
    throw error;
  }
}

/** The share a way pays now (K-32 payment_items.share). */
function shareOf(way: string, index: number): Share {
  if (way === "deposit") return "deposit";
  if (way === "full") return "full";
  return refuse("badInput", [`lines.${String(index)}.way`]);
}

/** A card the charge may go on: a card of this booking's (or typed for this payment), not removed or replaced. */
function usableCard(card: Card, booking: Booking, personId: string, keepsCard: boolean): Card {
  requireStripeId(card.stripeCustomerId, "card.stripeCustomerId");
  requireStripeId(card.stripePaymentMethodId, "card.stripePaymentMethodId");
  if (card.personId !== personId) refuse("cardNotUsable", ["card.personId"]);
  const saved = card.savedCard;
  if (saved === null) {
    if (keepsCard) refuse("cardNotKept", ["card.savedCard"]);
    return card;
  }
  requireId(saved.id, "card.savedCard.id");
  if (saved.bookingId !== booking.id) refuse("cardNotUsable", ["card.savedCard.bookingId"]);
  if (!saved.saved || saved.removed || saved.replaced) refuse("cardNotUsable", ["card.savedCard"]);
  return card;
}

/** Whether the booking already keeps a card that can be charged: saved for it, not removed or replaced. */
function keptCard(card: Card | null, booking: Booking): boolean {
  const saved = card?.savedCard ?? null;
  return saved !== null && saved.bookingId === booking.id && saved.saved && !saved.removed && !saved.replaced;
}

function checkPurpose(purpose: unknown): BookingPurpose {
  const known = BOOKING_PURPOSES.find((each) => each === purpose);
  if (known !== undefined) return known;
  if (typeof purpose === "string" && HOLD_WORDS.test(purpose)) refuse("hold", ["purpose"]);
  return refuse("badInput", ["purpose"]);
}

/** Refuses an item that names a line the booking was not read with (K-32 rule 10: items name lines of their booking). */
function itemsOnLines(items: readonly PaymentItem[], lines: readonly LineRead[]): void {
  const ids = new Set(lines.map((line) => line.id));
  items.forEach((item, index) => {
    if (!ids.has(item.lineId)) refuse("badInput", [`items.${String(index)}.lineId`]);
  });
}

/** Who pays what (default 4): the booker at booking, the payer for the rest and an extra (RULES 3.13). */
function payerFor(booking: Booking, purpose: BookingPurpose): string {
  return purpose === "deposit" || purpose === "full_price" ? booking.bookerPersonId : booking.payerPersonId;
}

/** The sha256 of a pay link's code, in lowercase hex (K-32 pay_links.code_sha256). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The payments and ledger service for one turn, inside the call's business scope. */
export function createPayments(deps: PaymentsDeps): Payments {
  const turnId = requireId(deps.turnId, "turnId");
  const traceId = requireId(deps.traceId, "traceId");
  const turnKey = requireId(deps.turnKey ?? turnId, "turnKey");
  const business = deps.business;
  requireId(business.id, "business.id");
  if (!UTC.test(deps.now)) refuse("badInput", ["now"]);
  const charges = new TurnCharges(turnId);
  const saves = new Set<string>();

  /** The booking is the call's business's, with ids and a version (RULES 3.1; arch 10 line 546). */
  function ownBooking(booking: Booking): Booking {
    requireId(booking.id, "booking.id");
    requireId(booking.bookerPersonId, "booking.bookerPersonId");
    requireId(booking.payerPersonId, "booking.payerPersonId");
    if (booking.businessId !== business.id) refuse("otherBusiness", ["booking.businessId"]);
    return booking;
  }

  function saveCard(input: SaveCardInput): CardSave {
    const booking = ownBooking(input.booking);
    const personId = requireId(input.personId, "personId");
    if (personId !== booking.bookerPersonId) refuse("cardNotUsable", ["personId"]);
    const customerId =
      input.stripeCustomerId === null ? null : requireStripeId(input.stripeCustomerId, "stripeCustomerId");
    if (saves.has(booking.id)) refuse("badInput", ["saveCard"]);
    const effectId = rowId("eff-card", booking.id, turnKey);
    const savedCardId = rowId("card", booking.id, turnKey);
    const effect = checkEffect(
      effectOf({
        effectId,
        kind: "stripe_save_card",
        booking,
        personId,
        amount: null,
        portRequest: { account: accountOf(business), customerId },
        traceId,
      }),
      turnId,
    );
    saves.add(booking.id);
    // The row the save's result and cardSaved fill, each value once (K-32 saved_cards: customer, card, saved_at).
    const row = insert("saved_cards", {
      id: savedCardId,
      business_id: booking.businessId,
      person_id: personId,
      booking_id: booking.id,
      membership_id: null,
      stripe_customer_id: customerId,
      stripe_payment_method_id: null,
      save_effect_id: effectId,
      saved_from_payment_id: null,
    });
    return {
      savedCardId,
      effectId,
      writes: { versionsRead: versionsOf(booking, []), state: [row], effects: [effect] },
    };
  }

  /** A charge, given its card is already checked for the way (usableCard). */
  function chargeOn(input: ChargeInput, keepsCard: boolean): PaymentAsked {
    const booking = ownBooking(input.booking);
    requireBoundYes(input.yes, booking);
    const purpose = checkPurpose(input.purpose);
    const currency = input.items[0]?.amount.currency ?? "";
    const amount = itemsTotal(input.items, currency);
    itemsOnLines(input.items, input.lines);
    const versionsRead = versionsOf(booking, input.lines);
    const payerId = payerFor(booking, purpose);
    const card = usableCard(input.card, booking, payerId, keepsCard);
    const present: unknown = input.customerPresent;
    if (typeof present !== "boolean") refuse("badInput", ["customerPresent"]);
    charges.check(booking.id);
    const effectId = rowId("eff-charge", booking.id, turnKey);
    const paymentId = rowId("pay", booking.id, turnKey);
    const effect = checkEffect(
      effectOf({
        effectId,
        kind: "stripe_charge",
        booking,
        personId: payerId,
        amount,
        portRequest: {
          account: accountOf(business),
          purpose: STRIPE_PURPOSE[purpose],
          customerId: card.stripeCustomerId,
          paymentMethodId: card.stripePaymentMethodId,
          customerPresent: present,
          description: descriptionOf(business, purpose, input.what),
        },
        traceId,
      }),
      turnId,
    );
    const state = [
      paymentRow({
        paymentId,
        booking,
        payerPersonId: payerId,
        purpose,
        amount,
        effectId,
        savedCardId: card.savedCard?.id ?? null,
      }),
      ...itemRows(paymentId, booking, input.items),
    ];
    charges.mark(booking.id);
    return { paymentId, effectId, amount, writes: { versionsRead, state, effects: [effect] } };
  }

  function charge(input: ChargeInput): PaymentAsked {
    return chargeOn(input, false);
  }

  async function payLink(input: PayLinkInput): Promise<PayLinkAsked> {
    const booking = ownBooking(input.booking);
    requireBoundYes(input.yes, booking);
    const purpose = checkPurpose(input.purpose);
    const currency = input.items[0]?.amount.currency ?? "";
    const amount = itemsTotal(input.items, currency);
    itemsOnLines(input.items, input.lines);
    const versionsRead = versionsOf(booking, input.lines);
    const personId = requireId(input.personId, "personId");
    if (personId !== payerFor(booking, purpose)) refuse("badInput", ["personId"]);
    const saveForLater: unknown = input.saveCardForLater;
    if (typeof saveForLater !== "boolean") refuse("badInput", ["saveCardForLater"]);
    // A card is saved to a customer, so saving it needs one (K-14 payLink.portRequest dependentSchemas).
    const customerId =
      input.stripeCustomerId === null
        ? saveForLater
          ? refuse("badInput", ["stripeCustomerId"])
          : null
        : requireStripeId(input.stripeCustomerId, "stripeCustomerId");
    const givenVia = [...input.givenVia];
    if (
      givenVia.length === 0 ||
      new Set(givenVia).size !== givenVia.length ||
      !givenVia.every((place) => GIVEN_VIA.includes(place))
    )
      refuse("badInput", ["givenVia"]);
    if (input.dueAt !== null && (!UTC.test(input.dueAt) || Date.parse(input.dueAt) <= Date.parse(deps.now)))
      refuse("badInput", ["dueAt"]);
    const codes = deps.payLinkCodes;
    if (codes === undefined || !/^[A-Z][A-Z0-9_]*$/u.test(codes.keyName)) return refuse("noPayLinkCode");
    charges.check(booking.id);

    const effectId = rowId("eff-pay-link", booking.id, turnKey);
    const paymentId = rowId("pay", booking.id, turnKey);
    const payLinkId = rowId("link", booking.id, turnKey);
    // The code is made from the link's id (K-32 default 21) and never kept: only its sha256 is written.
    const code = await codes.codeOf(payLinkId);
    if (!PAY_LINK_CODE.test(code)) refuse("noPayLinkCode");
    const codeSha256 = await sha256Hex(code);

    // Checked again after the wait, so two pay links built side by side for one booking never both pass.
    charges.check(booking.id);
    const effect = checkEffect(
      effectOf({
        effectId,
        kind: "stripe_pay_link",
        booking,
        personId,
        amount,
        portRequest: {
          account: accountOf(business),
          purpose: STRIPE_PURPOSE[purpose],
          customerId,
          saveCardForLater: saveForLater,
          description: descriptionOf(business, purpose, input.what),
        },
        traceId,
      }),
      turnId,
    );
    const state = [
      paymentRow({
        paymentId,
        booking,
        payerPersonId: personId,
        purpose,
        amount,
        effectId,
        savedCardId: null,
      }),
      ...itemRows(paymentId, booking, input.items),
      insert("pay_links", {
        id: payLinkId,
        business_id: booking.businessId,
        payment_id: paymentId,
        person_id: personId,
        given_via: givenVia,
        code_sha256: codeSha256,
        due_at: input.dueAt,
      }),
    ];
    charges.mark(booking.id);
    return { paymentId, effectId, payLinkId, amount, writes: { versionsRead, state, effects: [effect] } };
  }

  function moneyStep(input: MoneyStepInput): MoneyStep {
    const booking = ownBooking(input.booking);
    requireBoundYes(input.yes, booking);
    if (input.lines.length === 0) refuse("badInput", ["lines"]);
    input.lines.forEach((line, index) => requireId(line.id, `lines.${String(index)}.id`));
    const versionsRead = versionsOf(booking, input.lines);
    const reading = readingOf(input);

    // All that is due now, one item per service that pays now (RULES 3.2), each amount the record's way names.
    const items: PaymentItem[] = [];
    for (const [index, service] of reading.services.entries()) {
      if (!service.paysNow) continue;
      const line = input.lines[index];
      if (line === undefined) refuse("badInput", ["lines"]);
      if (service.now === null) refuse("amountNotKnown", [`lines.${String(index)}`]);
      if (service.now.cents === 0) continue;
      items.push({ lineId: line.id, share: shareOf(service.way, index), amount: service.now });
    }
    const keepsCard = reading.services.some((service) => service.card);
    const partLeft = reading.services.some((service) => service.due === null || service.due.cents > 0);
    const way: MoneyWay = items.length > 0 ? (partLeft ? "deposit" : "full") : keepsCard ? "card" : "nothing";
    const dueNow: Money =
      items.length > 0 ? itemsTotal(items, input.currency) : { cents: 0, currency: input.currency };
    const none: MoneyStep = {
      way,
      builds: "nothing",
      dueNow,
      writes: { versionsRead, state: [], effects: [] },
      paymentId: null,
      savedCardId: null,
    };
    if (way === "nothing") return none;

    // A card goes on file first where none is kept for the booking: the card way, and a request, whose money waits for
    // the owner's OK (RULES 3.11: "the card is saved, then charged at the OK").
    const waitsForOk = input.approval === "ownerOk";
    if (way === "card" || waitsForOk) {
      if (keptCard(input.card, booking)) return none;
      const saved = saveCard({
        booking,
        personId: booking.bookerPersonId,
        stripeCustomerId: input.stripeCustomerId,
      });
      return {
        ...none,
        builds: "saveCard",
        writes: { versionsRead, state: saved.writes.state, effects: saved.writes.effects },
        savedCardId: saved.savedCardId,
      };
    }

    if (input.card === null) return refuse("noCard", ["card"]);
    const asked = chargeOn(
      {
        booking,
        lines: input.lines,
        purpose: way === "full" ? "full_price" : "deposit",
        items,
        card: input.card,
        customerPresent: true,
        yes: input.yes,
        what: input.what,
      },
      keepsCard,
    );
    return {
      ...none,
      builds: "charge",
      writes: { versionsRead, state: asked.writes.state, effects: asked.writes.effects },
      paymentId: asked.paymentId,
    };
  }

  return { turnId, moneyStep, saveCard, charge, payLink };
}

/** Whether an error is the service's refusal (nothing was built). */
export function isPaymentRefusal(error: unknown): error is PaymentRefusedError {
  return error instanceof PaymentRefusedError;
}
