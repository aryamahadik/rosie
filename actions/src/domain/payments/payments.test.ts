// The payments and ledger service's proofs (T-763, "Proves it with"), run by `npm run test:unit -- actions/src/domain/payments`:
//   1. each SCENARIOS.md money combo produces the effect row and ledger lines it states (list|card|counter: the card
//      saved, $0 taken), its effect row run by the effects runner (T-323) and the Stripe kinds (T-326) on the Stripe
//      double (T-422), and its ledger lines made from what the double says was taken;
//   2. the hard invariant: no charge row is built without a committed exact yes bound to that booking, a property test
//      over all four ways;
//   3. a hold cannot be built (refuse-card-hold.json);
//   4. two charges for one booking in one turn are refused.
// Every request the double takes passes K-14 v1's schema (T-326's harness checks it), and every row is K-32 v1's.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../../commit";
import { contractChecks } from "../../commit/test-support";
import { k14, readExchange } from "../../effects/stripe/test-support";
import { MoneyHomeError, readMoneyRecord } from "../../homes/money";
import { sources } from "../../homes/money/test-support";
import {
  BOOKING_PURPOSES,
  PaymentRefusedError,
  chargeLine,
  checkEffect,
  checkTurnCharges,
  createPayments,
  isChargeKind,
  rowId,
  takenFromEvent,
  yesBinds,
  yesRefusal,
  type Booking,
  type BookingLine,
  type Card,
  type ChargeInput,
  type ExactYes,
  type LedgerLine,
  type MoneyEffect,
  type MoneyStep,
  type MoneyWrites,
  type PaymentAsked,
  type PaymentRefusal,
} from "./index";
import {
  ALEX,
  ALEX_ACTOR,
  ALEX_CARD,
  ALEX_CUSTOMER,
  CLAIMED_AT,
  LEES,
  LEES_ACCOUNT,
  RILEY,
  RILEY_CARD,
  RILEY_CUSTOMER,
  SAM,
  SHARE_OF,
  TURN_ID,
  alexBooking,
  alexSavedCard,
  alexTypedCard,
  alexYes,
  commitUnitOf,
  harnessFor,
  lees,
  lineOf,
  moneyRecords,
  pick,
  rileySavedCard,
  rileyTypedCard,
  runEffects,
  scenarios,
  seeded,
  shopLine,
  shopService,
  turnRow,
  type Scenario,
} from "./test-support";

/** The Groom's package's one line, as read (K-32 seed-payment-deposit's booking line). */
const GROOMS_LINE = { id: "line-alex-grooms-1", version: 1 } as const;

/** The refusal an action throws, or null when it builds. */
function refusalOf(action: () => unknown): PaymentRefusal | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof PaymentRefusedError) return error.reason;
    throw error;
  }
}

/** What a charge or pay link built, or, when it was refused, its refusal and nothing at all. */
async function attempt(
  action: () => PaymentAsked | Promise<PaymentAsked>,
): Promise<{ refusal: PaymentRefusal | null; writes: MoneyWrites }> {
  try {
    return { refusal: null, writes: (await action()).writes };
  } catch (error) {
    if (error instanceof PaymentRefusedError)
      return { refusal: error.reason, writes: { versionsRead: [], state: [], effects: [] } };
    throw error;
  }
}

const paymentsRows = (writes: MoneyWrites): Record<string, unknown>[] =>
  writes.state
    .filter((write) => write.op === "insert" && write.table === "payments")
    .map((write) => (write.op === "insert" ? write.values : {}));

const tableOf = (writes: MoneyWrites): string[] => writes.state.map((write) => write.table);

/** The ledger lines a run's events make for the payment the step asked (K-14 paymentSucceeded; ledger.ts). */
function linesFromEvents(
  events: readonly {
    kind: string;
    effectId: string | null;
    occurredAt: string;
    payload: Record<string, unknown>;
  }[],
  payment: { id: string; businessId: string; bookingId: string; effectId: string; cents: number },
): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const event of events) {
    const taken = takenFromEvent(event);
    if (taken === null) continue;
    lines.push(
      chargeLine(
        {
          id: payment.id,
          businessId: payment.businessId,
          bookingId: payment.bookingId,
          effectId: payment.effectId,
          amount: { cents: payment.cents, currency: "USD" },
        },
        taken,
      ),
    );
  }
  return lines;
}

// ---- 1 -----------------------------------------------------------------------------------------------------------------

describe("1. each SCENARIOS.md money combo produces the effect row and ledger lines it states", () => {
  const combos = scenarios();

  it("reads every combo of SCENARIOS.md's 'Per money combo', both flows and all four ways", () => {
    expect(combos.length).toBe(56);
    expect(combos.filter((combo) => combo.flow === "A")).toHaveLength(28);
    expect(combos.filter((combo) => combo.flow === "B")).toHaveLength(28);
    expect(new Set(combos.map((combo) => combo.stated.way))).toEqual(
      new Set(["nothing", "card", "deposit", "full"]),
    );
    // The example the card names: list|card|counter, the card saved and $0 taken.
    const example = combos.find((combo) => combo.flow === "A" && combo.combo === "list|card|counter");
    expect(example?.atBooking).toBe("the card is saved, $0 is taken, nothing is held on the card.");
  });

  /** The booking a combo's money step is for, on the shop's own account, with the card its page gives. */
  function stepOf(combo: Scenario, index: number) {
    const service = shopService(combo);
    const business = {
      id: `biz-demo-${combo.shop}`,
      name: service.business,
      stripeAccountId: `stripe-acct-demo-${combo.shop}`,
    };
    const booking: Booking = {
      id: `booking-alex-${combo.shop}-${combo.flow}-${String(index)}`,
      businessId: business.id,
      version: 3,
      bookerPersonId: ALEX,
      payerPersonId: ALEX,
    };
    const line = shopLine(service, `line-${booking.id}-1`);
    // The page gives the card for money now: a deposit keeps it, saved for the booking; the full price may be typed for
    // this payment only (K-32 default 15). A card way saves its card in the step itself.
    const card: Card | null =
      combo.stated.way === "deposit"
        ? alexSavedCard(booking, `card-${booking.id}`)
        : combo.stated.way === "full"
          ? alexTypedCard()
          : null;
    return { business, booking, line, card, service };
  }

  it.each(
    combos.map((combo, index) => [`${combo.flow} ${combo.combo} on ${combo.shop}`, combo, index] as const),
  )("%s: the effect row and ledger lines its 'At booking' line states", async (_name, combo, index) => {
    const records = await moneyRecords();
    const { business, booking, line, card } = stepOf(combo, index);
    const payments = createPayments(lees({ business }));
    const step = payments.moneyStep({
      booking,
      record: records[combo.flow],
      currency: "USD",
      lines: [line],
      yes: alexYes(booking),
      card,
      stripeCustomerId: ALEX_CUSTOMER,
      what: combo.service,
    });
    const account = { kind: "business" as const, accountId: business.stripeAccountId };
    const h = harnessFor(account);
    await runEffects(h, step.writes.effects);
    const calls = h.double.requests();
    const listed = h.double.listMoney({ account, from: "2026-11-07T00:00:00Z", to: "2026-11-08T00:00:00Z" });
    if (listed.result !== "listed") throw new Error("the double did not list");
    expect(step.way, combo.atBooking).toBe(combo.stated.way);

    switch (combo.stated.way) {
      case "nothing": {
        // "nothing is taken and no card is saved": no effect row, no money row, no ledger line.
        expect(step.builds).toBe("nothing");
        expect(step.writes.effects).toEqual([]);
        expect(step.writes.state).toEqual([]);
        expect(step.dueNow).toEqual({ cents: 0, currency: "USD" });
        expect(calls).toEqual([]);
        expect(listed.items).toEqual([]);
        break;
      }
      case "card": {
        // "the card is saved, $0 is taken, nothing is held on the card": one card save, its saved card row, no
        // payment and no ledger line, before and after the page saves the card.
        expect(step.builds).toBe("saveCard");
        expect(step.dueNow).toEqual({ cents: 0, currency: "USD" });
        expect(step.writes.effects).toHaveLength(1);
        const [save] = step.writes.effects;
        expect(save?.kind).toBe("stripe_save_card");
        expect(save?.amount).toBeNull();
        expect(save?.portRequest).toEqual({ account, customerId: ALEX_CUSTOMER });
        expect(tableOf(step.writes)).toEqual(["saved_cards"]);
        expect(paymentsRows(step.writes)).toEqual([]);
        const setupId = h.repo.held(save?.effectId ?? "").row.providerObjectId;
        expect(h.repo.held(save?.effectId ?? "").row.state).toBe("succeeded");
        const events = h.double.completeSetup(setupId ?? "", { paymentMethodId: "stripe-card-double-saved" });
        expect(events.map((event) => event.kind)).toContain("cardSaved");
        expect(linesFromEvents(h.double.events(), dummyPayment(booking, save?.effectId ?? ""))).toEqual([]);
        expect(calls.map((call) => call.call)).toEqual(["saveCard"]);
        expect(listed.items).toEqual([]);
        break;
      }
      case "deposit":
      case "full": {
        // "the deposit $X (the full price $X) is taken once the booking is written": one charge of exactly that, on the
        // shop's own account, captured at once; one payment written pending with its item; one ledger charge line.
        const cents = combo.stated.cents;
        expect(step.builds).toBe("charge");
        expect(step.dueNow).toEqual({ cents, currency: "USD" });
        expect(step.writes.effects).toHaveLength(1);
        const [charge] = step.writes.effects;
        expect(charge?.kind).toBe("stripe_charge");
        expect(charge?.amount).toEqual({ cents, currency: "USD" });
        expect(charge?.portRequest).toMatchObject({
          account,
          purpose: combo.stated.way === "deposit" ? "deposit" : "fullPrice",
          customerId: ALEX_CUSTOMER,
          paymentMethodId: ALEX_CARD,
          customerPresent: true,
        });
        expect(tableOf(step.writes)).toEqual(["payments", "payment_items"]);
        const [payment] = paymentsRows(step.writes);
        expect(payment).toMatchObject({
          id: step.paymentId,
          purpose: combo.stated.way === "deposit" ? "deposit" : "full_price",
          method: "card",
          amount_cents: cents,
          currency: "USD",
          state: "pending",
          effect_id: charge?.effectId,
        });
        expect(h.repo.held(charge?.effectId ?? "").row.state).toBe("succeeded");
        expect(calls.map((call) => call.call)).toEqual(["charge"]);
        expect(listed.items.map((item) => [item.kind, item.amount.cents, item.effectId, item.state])).toEqual(
          [["charge", cents, charge?.effectId, "succeeded"]],
        );
        const lines = linesFromEvents(h.double.events(), {
          id: step.paymentId ?? "",
          businessId: business.id,
          bookingId: booking.id,
          effectId: charge?.effectId ?? "",
          cents,
        });
        expect(lines).toEqual([
          {
            id: `ledger-${step.paymentId ?? ""}`,
            business_id: business.id,
            booking_id: booking.id,
            kind: "charge",
            amount_cents: cents,
            currency: "USD",
            payment_id: step.paymentId,
            refund_id: null,
            effect_id: charge?.effectId,
            stripe_object_id: listed.items[0]?.stripeId,
            moved_at: CLAIMED_AT,
            written_by: "provider_event",
          },
        ]);
        break;
      }
    }
  });

  /** A payment no charge was made for, to show a card save's events make no line. */
  function dummyPayment(booking: Booking, effectId: string) {
    return {
      id: `pay-none-${booking.id}`,
      businessId: booking.businessId,
      bookingId: booking.id,
      effectId,
      cents: 1,
    };
  }

  it("on a request, each deposit and full-price combo saves the card and charges nothing until the owner's OK, which charges what it states", async () => {
    const records = await moneyRecords();
    const money = combos.filter((combo) => combo.stated.way === "deposit" || combo.stated.way === "full");
    expect(money).toHaveLength(22);
    for (const [index, combo] of money.entries()) {
      const { business, booking, line } = stepOf(combo, 100 + index);
      const asked = createPayments(lees({ business })).moneyStep({
        booking,
        record: records[combo.flow],
        currency: "USD",
        lines: [line],
        approval: "ownerOk",
        yes: alexYes(booking),
        card: null,
        stripeCustomerId: ALEX_CUSTOMER,
        what: combo.service,
      });
      // "nothing is charged while the OK is pending; the card is saved, then charged at the OK" (RULES 3.11).
      expect(asked.builds, combo.combo).toBe("saveCard");
      expect(asked.writes.effects.map((effect) => effect.kind)).toEqual(["stripe_save_card"]);
      expect(paymentsRows(asked.writes)).toEqual([]);
      // At the OK, a later turn charges the saved card what the combo states, the person not on the page.
      if (combo.stated.way !== "deposit" && combo.stated.way !== "full") throw new Error("money now");
      const atOk = createPayments(lees({ business, turnId: `turn-ok-${booking.id}` })).charge({
        booking,
        lines: [line],
        purpose: combo.stated.way === "deposit" ? "deposit" : "full_price",
        items: [
          {
            lineId: line.id,
            share: combo.stated.way === "deposit" ? "deposit" : "full",
            amount: { cents: combo.stated.cents, currency: "USD" },
          },
        ],
        card: alexSavedCard(booking, asked.savedCardId ?? ""),
        customerPresent: false,
        yes: alexYes(booking, { answeredIn: TURN_ID }),
        what: combo.service,
      });
      expect(atOk.amount).toEqual({ cents: combo.stated.cents, currency: "USD" });
      expect(atOk.writes.effects[0]?.portRequest).toMatchObject({ customerPresent: false });
    }
  });
});

// ---- 2 -----------------------------------------------------------------------------------------------------------------

/** A yes of one of the ways it can fail to bind, or bound. */
type YesCase =
  | "none"
  | "notAnswered"
  | "answeredEmpty"
  | "otherBooking"
  | "noBooking"
  | "otherBusiness"
  | "noBusiness"
  | "relayed"
  | "payerNotBooker"
  | "boundThisTurn"
  | "boundEarlier";

const YES_CASES: readonly YesCase[] = [
  "none",
  "notAnswered",
  "answeredEmpty",
  "otherBooking",
  "noBooking",
  "otherBusiness",
  "noBusiness",
  "relayed",
  "payerNotBooker",
  "boundThisTurn",
  "boundEarlier",
];

const BOUND_CASES: readonly YesCase[] = ["boundThisTurn", "boundEarlier"];

function yesOf(kind: YesCase, booking: Booking, turnId: string): ExactYes | null {
  switch (kind) {
    case "none":
      return null;
    case "notAnswered":
      return alexYes(booking, { answeredIn: null });
    case "answeredEmpty":
      return alexYes(booking, { answeredIn: "" });
    case "otherBooking":
      return alexYes(booking, { bookingId: `${booking.id}-other` });
    case "noBooking":
      return alexYes(booking, { bookingId: null });
    case "otherBusiness":
      return alexYes(booking, { businessId: "biz-yoga-studio" });
    case "noBusiness":
      return alexYes(booking, { businessId: null });
    case "relayed":
      return alexYes(booking, { personId: SAM });
    case "payerNotBooker":
      return alexYes(booking, { personId: booking.payerPersonId });
    case "boundThisTurn":
      return alexYes(booking, { answeredIn: turnId });
    case "boundEarlier":
      return alexYes(booking, { answeredIn: "turn-alex-earlier" });
  }
}

type CardCase =
  "none" | "typed" | "saved" | "otherBooking" | "removed" | "replaced" | "notSaved" | "otherPerson";
const CARD_CASES: readonly CardCase[] = [
  "none",
  "typed",
  "saved",
  "otherBooking",
  "removed",
  "replaced",
  "notSaved",
  "otherPerson",
];

function cardOf(kind: CardCase, booking: Booking): Card | null {
  const saved = alexSavedCard(booking, `card-${booking.id}`);
  switch (kind) {
    case "none":
      return null;
    case "typed":
      return alexTypedCard();
    case "saved":
      return saved;
    case "otherBooking":
      return alexSavedCard({ ...booking, id: `${booking.id}-other` }, `card-${booking.id}-other`);
    case "removed":
      return { ...saved, savedCard: saved.savedCard === null ? null : { ...saved.savedCard, removed: true } };
    case "replaced":
      return {
        ...saved,
        savedCard: saved.savedCard === null ? null : { ...saved.savedCard, replaced: true },
      };
    case "notSaved":
      return { ...saved, savedCard: saved.savedCard === null ? null : { ...saved.savedCard, saved: false } };
    case "otherPerson":
      return { ...saved, personId: SAM };
  }
}

const WAYS = ["none", "card", "deposit", "full"] as const;
const AFTERS = { A: ["none", "counter", "bill", "card"], B: ["none", "bill", "card", "own"] } as const;

/** A random booking line on one of the four ways, with amounts the way needs. */
function randomLine(random: () => number, id: string, flow: "A" | "B"): BookingLine {
  const before = pick(random, WAYS);
  const price = 500 + Math.floor(random() * 60_000);
  const deposit = 100 + Math.floor(random() * (price - 100));
  const after = before === "full" ? "none" : pick(random, AFTERS[flow]);
  const fee = Math.floor(random() * 10_000);
  return lineOf(id, `list|${before}|${after}`, {
    price,
    ...(before === "deposit" ? { deposit, rest: price - deposit } : {}),
    ...(before === "full" ? { paid: price } : {}),
    fee,
  });
}

/** The rows of a step that take money: its charge or pay link effects and its payment rows. */
function chargeRowsOf(writes: MoneyWrites): unknown[] {
  return [...writes.effects.filter((effect) => isChargeKind(effect.kind)), ...paymentsRows(writes)];
}

describe("2. hard invariant: no charge row is built without a committed exact yes bound to that booking", () => {
  it("over all four ways (5,000 seeded bookings): a charge row only ever rests on the booker's committed yes for that booking, and every other yes builds nothing at all", async () => {
    const records = await moneyRecords();
    const random = seeded(763);
    const seen = {
      charged: 0,
      boundButRefused: 0,
      byYes: new Map<YesCase, number>(),
      wayCharged: new Set<string>(),
      wayStepped: new Set<string>(),
    };
    for (let n = 0; n < 5000; n += 1) {
      const flow = pick(random, ["A", "B"] as const);
      const turnId = `turn-prop-${String(n)}`;
      const payer = pick(random, [ALEX, "person-riley"]);
      const booking = alexBooking(`booking-prop-${String(n)}`, { payerPersonId: payer });
      const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, at) =>
        randomLine(random, `line-prop-${String(n)}-${String(at + 1)}`, flow),
      );
      // Half the bookings take a bound yes and a card the page gave, so the charges the invariant rules on are many.
      const yesCase = random() < 0.5 ? pick(random, BOUND_CASES) : pick(random, YES_CASES);
      const yes = yesOf(yesCase, booking, turnId);
      const cardCase = random() < 0.5 ? pick(random, ["saved", "typed"] as const) : pick(random, CARD_CASES);
      const approval = pick(random, ["now", "ownerOk"] as const);
      const payments = createPayments(lees({ turnId }));
      let step: MoneyStep | null = null;
      let refusal: PaymentRefusal | null = null;
      try {
        step = payments.moneyStep({
          booking,
          record: records[flow],
          currency: "USD",
          lines,
          approval,
          yes,
          card: cardOf(cardCase, booking),
          stripeCustomerId: ALEX_CUSTOMER,
          what: "the visit",
        });
      } catch (error) {
        if (!(error instanceof PaymentRefusedError)) throw error;
        refusal = error.reason;
      }
      const binds = yesBinds(yes, booking);
      seen.byYes.set(yesCase, (seen.byYes.get(yesCase) ?? 0) + 1);
      // The invariant: a charge row is built only on the booker's committed yes bound to that booking.
      const charges = step === null ? [] : chargeRowsOf(step.writes);
      if (charges.length > 0) expect(binds, `case ${String(n)}`).toBe(true);
      // And a yes that does not bind builds nothing at all, with the reason the yes gives.
      if (!binds) {
        expect(step, `case ${String(n)}`).toBeNull();
        expect(refusal).toBe(yesRefusal(yes, booking));
      }
      if (step !== null) seen.wayStepped.add(step.way);
      if (step !== null && charges.length > 0) {
        seen.charged += 1;
        seen.wayCharged.add(step.way);
        // One charge: one effect row and one payment, on the business's own account, for all that is due now.
        expect(step.writes.effects).toHaveLength(1);
        expect(paymentsRows(step.writes)).toHaveLength(1);
        expect(step.writes.effects[0]?.amount).toEqual(step.dueNow);
      }
      if (binds && refusal !== null) seen.boundButRefused += 1;
    }
    // Not vacuous: every yes case was tried, every way was stepped through, deposits and full prices were charged.
    for (const yesCase of YES_CASES) expect(seen.byYes.get(yesCase) ?? 0).toBeGreaterThan(100);
    expect([...seen.wayStepped].sort()).toEqual(["card", "deposit", "full", "nothing"]);
    expect([...seen.wayCharged].sort()).toEqual(["deposit", "full"]);
    expect(seen.charged).toBeGreaterThan(200);
    expect(seen.boundButRefused).toBeGreaterThan(0);
  });

  it("charge and payLink alone: no payment row without the booker's committed yes bound to that booking", async () => {
    const random = seeded(1763);
    let built = 0;
    for (let n = 0; n < 1500; n += 1) {
      const turnId = `turn-alone-${String(n)}`;
      const booking = alexBooking(`booking-alone-${String(n)}`);
      const yesCase = pick(random, YES_CASES);
      const yes = yesOf(yesCase, booking, turnId);
      const payments = createPayments(lees({ turnId }));
      const cents = 100 + Math.floor(random() * 50_000);
      const items = [
        { lineId: `line-alone-${String(n)}`, share: "deposit" as const, amount: { cents, currency: "USD" } },
      ];
      const lines = [{ id: `line-alone-${String(n)}`, version: 1 }];
      const binds = yesBinds(yes, booking);
      let asked: PaymentAsked | null = null;
      try {
        asked =
          random() < 0.5
            ? payments.charge({
                booking,
                lines,
                purpose: "deposit",
                items,
                card: alexSavedCard(booking),
                customerPresent: true,
                yes,
                what: "the visit",
              })
            : await payments.payLink({
                booking,
                lines,
                purpose: "deposit",
                items,
                personId: ALEX,
                stripeCustomerId: ALEX_CUSTOMER,
                saveCardForLater: true,
                givenVia: ["text"],
                dueAt: "2026-11-07T17:00:00Z",
                yes,
                what: "the visit",
              });
      } catch (error) {
        if (!(error instanceof PaymentRefusedError)) throw error;
        expect(error.reason).toBe(yesRefusal(yes, booking));
      }
      if (asked !== null) {
        built += 1;
        expect(binds).toBe(true);
        expect(chargeRowsOf(asked.writes)).toHaveLength(2);
      } else expect(binds).toBe(false);
    }
    expect(built).toBeGreaterThan(100);
  });

  // A card is charged only for the booker (service.ts default 4): RULES 3.13, "The payer gets a pay link only for the rest,
  // at DONE or on the bill, and approves nothing"; RULES 1.10, no money without the person's own yes.

  it("a payer who is not the booker is never charged on a card: the rest on their saved card off the page on the booker's yes, the same on the page and for an extra, are refused and build no effect row, payment or ledger line; a pay link for the rest still builds theirs", async () => {
    // Alex books the Groom's package, and Riley pays the rest (RULES 3.13: "Someone else pays").
    const booking = alexBooking("booking-alex-grooms-package", { payerPersonId: RILEY });
    const forRiley = (purpose: "rest" | "extra", customerPresent: boolean): ChargeInput => ({
      booking,
      lines: [GROOMS_LINE],
      purpose,
      items: [{ lineId: GROOMS_LINE.id, share: purpose, amount: { cents: 10000, currency: "USD" } }],
      card: rileySavedCard(booking),
      customerPresent,
      yes: alexYes(booking),
      what: "the Groom's package",
    });
    // The payment and effect the charge would have been (service.ts default 1), to read the double's events against.
    const wouldBe = {
      id: rowId("pay", booking.id, TURN_ID),
      businessId: LEES.id,
      bookingId: booking.id,
      effectId: rowId("eff-charge", booking.id, TURN_ID),
      cents: 10000,
    };
    const payments = createPayments(lees());
    const cases = [
      ["rest", false],
      ["rest", true],
      ["extra", false],
      ["extra", true],
    ] as const;
    for (const [purpose, customerPresent] of cases) {
      const label = `${purpose}, on the page ${String(customerPresent)}`;
      const tried = await attempt(() => payments.charge(forRiley(purpose, customerPresent)));
      expect(tried.refusal, label).toBe("payerNotBooker");
      expect(tried.writes.effects, label).toEqual([]);
      expect(paymentsRows(tried.writes), label).toEqual([]);
      // On the Stripe double, with Riley's card on file there: no request reaches Stripe, nothing is taken, no line.
      const h = harnessFor(LEES_ACCOUNT);
      h.double.seedCard({ paymentMethodId: RILEY_CARD, account: LEES_ACCOUNT, customerId: RILEY_CUSTOMER });
      await runEffects(h, tried.writes.effects);
      expect(h.double.requests(), label).toEqual([]);
      expect(
        h.double.listMoney({
          account: LEES_ACCOUNT,
          from: "2026-11-07T00:00:00Z",
          to: "2026-11-08T00:00:00Z",
        }),
        label,
      ).toMatchObject({ result: "listed", items: [] });
      expect(linesFromEvents(h.double.events(), wouldBe), label).toEqual([]);
    }
    // Riley's own yes changes nothing: the payer approves nothing.
    const rileysYes = alexYes(booking, { personId: RILEY });
    expect(
      (await attempt(() => payments.charge({ ...forRiley("rest", true), yes: rileysYes }))).refusal,
    ).toBe("yesNotTheirOwn");
    // Riley is asked the rest only by a pay link: in the same turn, after the refused charges, it is built.
    const link = await payments.payLink({
      booking,
      lines: [GROOMS_LINE],
      purpose: "rest",
      items: [{ lineId: GROOMS_LINE.id, share: "rest", amount: { cents: 10000, currency: "USD" } }],
      personId: RILEY,
      stripeCustomerId: RILEY_CUSTOMER,
      saveCardForLater: false,
      givenVia: ["text"],
      dueAt: null,
      yes: alexYes(booking),
      what: "the Groom's package",
    });
    expect(link.writes.effects.map((effect) => [effect.kind, effect.personId])).toEqual([
      ["stripe_pay_link", RILEY],
    ]);
    expect(tableOf(link.writes)).toEqual(["payments", "payment_items", "pay_links"]);
    expect(paymentsRows(link.writes)).toMatchObject([
      { payer_person_id: RILEY, purpose: "rest", amount_cents: 10000, saved_card_id: null },
    ]);
    // What is due at booking stays the booker's, on his own card: Alex's deposit is K-14 deposit.json's charge, though
    // Riley pays the rest.
    const deposit = createPayments(lees()).charge({
      ...forRiley("rest", true),
      purpose: "deposit",
      items: [{ lineId: GROOMS_LINE.id, share: "deposit", amount: { cents: 4000, currency: "USD" } }],
      card: alexSavedCard(booking),
    });
    expect(deposit.writes.effects[0]?.portRequest).toEqual(readExchange("deposit.json").request.port);
    expect(paymentsRows(deposit.writes)).toMatchObject([{ payer_person_id: ALEX, purpose: "deposit" }]);
  });

  it("the booker who pays the rest too is charged it at DONE on the card saved for the booking, off the page: K-14 off-session-at-done.json's request exactly", () => {
    const booking = alexBooking("booking-alex-haircut-done");
    const line = { id: "line-alex-haircut-done-1", version: 1 };
    const asked = createPayments(lees()).charge({
      booking,
      lines: [line],
      purpose: "rest",
      items: [{ lineId: line.id, share: "rest", amount: { cents: 3500, currency: "USD" } }],
      card: alexSavedCard(booking, "card-alex-haircut-done"),
      customerPresent: false,
      yes: alexYes(booking, { answeredIn: "turn-alex-haircut-book" }),
      what: "haircut with Riley, Sat Oct 24",
    });
    const done = readExchange("off-session-at-done.json").request;
    const [effect] = asked.writes.effects;
    expect(effect?.amount).toEqual(done.amount);
    expect(effect?.portRequest).toEqual(done.port);
    expect(
      k14("charge.request", {
        effect: { effectId: effect?.effectId, idempotencyKey: effect?.idempotencyKey },
        amount: effect?.amount,
        port: effect?.portRequest,
      }),
    ).toEqual([]);
    expect(effect?.personId).toBe(ALEX);
    expect(paymentsRows(asked.writes)).toMatchObject([
      { payer_person_id: ALEX, purpose: "rest", saved_card_id: "card-alex-haircut-done" },
    ]);
  });

  it("charge and payLink alone, the payer not the booker (2,000 seeded bookings): no card is ever charged for that payer, whatever the purpose, presence or yes, and they are asked only by a pay link, for the rest, on the booker's bound yes", async () => {
    const random = seeded(313);
    const seen = {
      payerRefused: 0,
      bookerCharged: 0,
      linked: 0,
      byYes: new Map<YesCase, number>(),
      purposes: new Set<string>(),
    };
    for (let n = 0; n < 2000; n += 1) {
      const turnId = `turn-payer-${String(n)}`;
      const booking = alexBooking(`booking-payer-${String(n)}`, { payerPersonId: RILEY });
      // Half the bookings take a bound yes, so the refusals the payer alone causes are many.
      const yesCase = random() < 0.5 ? pick(random, BOUND_CASES) : pick(random, YES_CASES);
      const yes = yesOf(yesCase, booking, turnId);
      const binds = yesBinds(yes, booking);
      seen.byYes.set(yesCase, (seen.byYes.get(yesCase) ?? 0) + 1);
      const purpose = pick(random, BOOKING_PURPOSES);
      seen.purposes.add(purpose);
      const lineId = `line-payer-${String(n)}`;
      const lines = [{ id: lineId, version: 1 }];
      const cents = 100 + Math.floor(random() * 50_000);
      const items = [{ lineId, share: SHARE_OF[purpose], amount: { cents, currency: "USD" } }];
      const payments = createPayments(lees({ turnId }));
      const label = `case ${String(n)}: ${purpose}, yes ${yesCase}`;
      if (random() < 0.5) {
        // A charge on Riley's card or Alex's, saved for the booking or typed, with the person on the page or not.
        const card = pick(random, [
          rileySavedCard(booking),
          rileyTypedCard(),
          alexSavedCard(booking),
          alexTypedCard(),
        ]);
        const customerPresent = random() < 0.5;
        const tried = await attempt(() =>
          payments.charge({ booking, lines, purpose, items, card, customerPresent, yes, what: "the visit" }),
        );
        if (!binds) expect(tried.refusal, label).toBe(yesRefusal(yes, booking));
        else if (purpose === "rest" || purpose === "extra")
          expect(tried.refusal, label).toBe("payerNotBooker");
        if (tried.refusal === "payerNotBooker") seen.payerRefused += 1;
        // A charge that is built is the booker's: what is due at booking, on his own card, on his bound yes.
        if (tried.refusal === null) {
          seen.bookerCharged += 1;
          expect(binds, label).toBe(true);
          expect(["deposit", "full_price"], label).toContain(purpose);
          expect(
            tried.writes.effects.map((effect) => [effect.kind, effect.personId]),
            label,
          ).toEqual([["stripe_charge", ALEX]]);
          expect(tried.writes.effects[0]?.portRequest, label).toMatchObject({
            customerId: ALEX_CUSTOMER,
            paymentMethodId: ALEX_CARD,
          });
          expect(paymentsRows(tried.writes), label).toMatchObject([{ payer_person_id: ALEX }]);
        }
      } else {
        // A pay link for Riley, the payer.
        const tried = await attempt(() =>
          payments.payLink({
            booking,
            lines,
            purpose,
            items,
            personId: RILEY,
            stripeCustomerId: RILEY_CUSTOMER,
            saveCardForLater: random() < 0.5,
            givenVia: ["text"],
            dueAt: null,
            yes,
            what: "the visit",
          }),
        );
        if (!binds) expect(tried.refusal, label).toBe(yesRefusal(yes, booking));
        // What is due at booking is never the payer's: the booker pays it, on the page.
        else if (purpose === "deposit" || purpose === "full_price")
          expect(tried.refusal, label).toBe("badInput");
        // The rest is theirs, by pay link, on the booker's bound yes.
        else if (purpose === "rest") expect(tried.refusal, label).toBeNull();
        // Whatever is built for the payer is a pay link, never a charge on a card.
        if (tried.refusal === null) {
          if (purpose === "rest") seen.linked += 1;
          expect(
            tried.writes.effects.map((effect) => [effect.kind, effect.personId]),
            label,
          ).toEqual([["stripe_pay_link", RILEY]]);
          expect(paymentsRows(tried.writes), label).toMatchObject([
            { payer_person_id: RILEY, saved_card_id: null },
          ]);
        }
      }
    }
    // Not vacuous: every yes case and purpose was tried; payer charges were refused, booker charges and links built.
    for (const yesCase of YES_CASES) expect(seen.byYes.get(yesCase) ?? 0).toBeGreaterThan(30);
    expect([...seen.purposes].sort()).toEqual(["deposit", "extra", "full_price", "rest"]);
    expect(seen.payerRefused).toBeGreaterThan(200);
    expect(seen.bookerCharged).toBeGreaterThan(50);
    expect(seen.linked).toBeGreaterThan(100);
  });
});

// ---- 3 -----------------------------------------------------------------------------------------------------------------

describe("3. a hold cannot be built (refuse-card-hold.json)", () => {
  /** Alex's $40 Groom's package deposit at Lee's Barbershop, charged on his saved card as the booking is written (A5-13). */
  function groomsDeposit(card: Card = alexSavedCard(alexBooking())): PaymentAsked {
    const booking = alexBooking();
    return createPayments(lees()).charge({
      booking,
      lines: [GROOMS_LINE],
      purpose: "deposit",
      items: [{ lineId: GROOMS_LINE.id, share: "deposit", amount: { cents: 4000, currency: "USD" } }],
      card,
      customerPresent: true,
      yes: alexYes(booking),
      what: "the Groom's package",
    });
  }

  const requestOf = (effect: MoneyEffect | undefined): Record<string, unknown> => ({
    effect: { effectId: effect?.effectId, idempotencyKey: effect?.idempotencyKey },
    amount: effect?.amount,
    port: effect?.portRequest,
  });

  it("builds K-14's deposit.json charge, captured at once: its amount and port request exactly, with no field for a hold", () => {
    const asked = groomsDeposit();
    const [effect] = asked.writes.effects;
    const deposit = readExchange("deposit.json").request;
    expect(effect?.amount).toEqual(deposit.amount);
    expect(effect?.portRequest).toEqual(deposit.port);
    expect(effect?.idempotencyKey).toBe(effect?.effectId);
    expect(k14("charge.request", requestOf(effect))).toEqual([]);
    expect(Object.keys(effect?.portRequest ?? {})).not.toContain("captureMethod");
    // The payment is written pending, taken at once by its effect; there is no held or authorized state (K-32).
    expect(paymentsRows(asked.writes)[0]?.state).toBe("pending");
  });

  it("refuse-card-hold.json's request is refused by K-14, by the Stripe double and by the service's own check", () => {
    const hold = readExchange("invalid/refuse-card-hold.json");
    expect((hold.request.port as Record<string, unknown>).captureMethod).toBe("manual");
    expect(k14("charge.request", hold.request)).not.toEqual([]);
    const h = harnessFor(LEES_ACCOUNT);
    const outcome = h.double.charge(hold.request);
    expect(outcome).toMatchObject({ result: "failed", kind: "refused" });
    expect(h.double.rejectedRequests().map((rejected) => rejected.call)).toEqual(["charge"]);
    expect(
      h.double.listMoney({ account: LEES_ACCOUNT, from: "2026-11-07T00:00:00Z", to: "2026-11-08T00:00:00Z" }),
    ).toMatchObject({ items: [] });
    // An effect row carrying the hold's port request is never written: refused before the commit.
    const [effect] = groomsDeposit().writes.effects;
    if (effect === undefined) throw new Error("a deposit effect");
    const held = { ...effect, portRequest: hold.request.port } as unknown as MoneyEffect;
    expect(refusalOf(() => checkEffect(held, TURN_ID))).toBe("hold");
  });

  it("no input can ask for one: a hold on the card is never sent, and a hold purpose, a hold way or a hold in the record is refused", async () => {
    // A hold's field smuggled in beside the card is never sent: the port request is built field by field.
    const smuggled = { ...alexSavedCard(alexBooking()), captureMethod: "manual" } as Card;
    const [effect] = groomsDeposit(smuggled).writes.effects;
    expect(effect?.portRequest).toEqual(readExchange("deposit.json").request.port);
    const booking = alexBooking();
    const charge = (purpose: string) => () =>
      createPayments(lees()).charge({
        booking,
        lines: [GROOMS_LINE],
        purpose: purpose as "deposit",
        items: [{ lineId: GROOMS_LINE.id, share: "deposit", amount: { cents: 4000, currency: "USD" } }],
        card: alexSavedCard(booking),
        customerPresent: true,
        yes: alexYes(booking),
        what: "the Groom's package",
      });
    expect(refusalOf(charge("hold"))).toBe("hold");
    expect(refusalOf(charge("authorize"))).toBe("hold");
    expect(refusalOf(charge("capture_later"))).toBe("hold");
    // A service whose way before the visit is a hold is refused before its booking is read.
    const records = await moneyRecords();
    const line = lineOf("line-alex-grooms-1", "list|deposit|counter", {
      price: 14000,
      deposit: 4000,
      rest: 10000,
    });
    const holdLine = { ...line, service: { ...line.service, before: "hold" } } as unknown as BookingLine;
    expect(
      refusalOf(() =>
        createPayments(lees()).moneyStep({
          booking,
          record: records.A,
          currency: "USD",
          lines: [holdLine],
          yes: alexYes(booking),
          card: alexSavedCard(booking),
          stripeCustomerId: ALEX_CUSTOMER,
          what: "the Groom's package",
        }),
      ),
    ).toBe("hold");
    // A record that holds a card has no way to be read at all (D66; the money home's record reader).
    const src = await sources();
    const raw = structuredClone(src.flows.A.record) as { ways: Record<string, unknown> };
    raw.ways.hold = { now: "deposit", card: true, fee: "fee", back: "deposit" };
    expect(() => readMoneyRecord("A", raw)).toThrow(MoneyHomeError);
  });

  it("across every SCENARIOS.md combo, no port request carries a hold and every payment is written pending", async () => {
    const records = await moneyRecords();
    for (const [index, combo] of scenarios().entries()) {
      const service = shopService(combo);
      const booking = alexBooking(`booking-hold-${String(index)}`);
      const card =
        combo.stated.way === "deposit"
          ? alexSavedCard(booking, `card-hold-${String(index)}`)
          : alexTypedCard();
      const step = createPayments(lees()).moneyStep({
        booking,
        record: records[combo.flow],
        currency: "USD",
        lines: [shopLine(service, `line-hold-${String(index)}`)],
        yes: alexYes(booking),
        card,
        stripeCustomerId: ALEX_CUSTOMER,
        what: combo.service,
      });
      for (const effect of step.writes.effects) {
        expect(Object.keys(effect.portRequest)).not.toContain("captureMethod");
        expect(checkEffect(effect, TURN_ID)).toBe(effect);
      }
      for (const payment of paymentsRows(step.writes)) expect(payment.state).toBe("pending");
    }
  });
});

// ---- 4 -----------------------------------------------------------------------------------------------------------------

describe("4. two charges for one booking in one turn are refused", () => {
  const booking = alexBooking();
  const item = {
    lineId: "line-alex-grooms-1",
    share: "deposit" as const,
    amount: { cents: 4000, currency: "USD" },
  };
  const chargeInput = (forBooking: Booking = booking) => ({
    booking: forBooking,
    lines: [GROOMS_LINE],
    purpose: "deposit" as const,
    items: [item],
    card: alexSavedCard(forBooking),
    customerPresent: true,
    yes: alexYes(forBooking),
    what: "the Groom's package",
  });
  const payLinkInput = (forBooking: Booking = booking) => ({
    booking: forBooking,
    lines: [GROOMS_LINE],
    purpose: "deposit" as const,
    items: [item],
    personId: ALEX,
    stripeCustomerId: ALEX_CUSTOMER,
    saveCardForLater: true,
    givenVia: ["text" as const],
    dueAt: "2026-11-07T17:00:00Z",
    yes: alexYes(forBooking),
    what: "the Groom's package",
  });

  it("a second charge, money step or pay link for one booking in the turn is refused, and builds nothing", async () => {
    const payments = createPayments(lees());
    const first = payments.charge(chargeInput());
    expect(first.writes.effects).toHaveLength(1);
    expect(refusalOf(() => payments.charge(chargeInput()))).toBe("secondChargeInTurn");
    await expect(payments.payLink(payLinkInput())).rejects.toMatchObject({ reason: "secondChargeInTurn" });
    const records = await moneyRecords();
    expect(
      refusalOf(() =>
        payments.moneyStep({
          booking,
          record: records.A,
          currency: "USD",
          lines: [lineOf(item.lineId, "list|deposit|counter", { price: 14000, deposit: 4000, rest: 10000 })],
          yes: alexYes(booking),
          card: alexSavedCard(booking),
          stripeCustomerId: ALEX_CUSTOMER,
          what: "the Groom's package",
        }),
      ),
    ).toBe("secondChargeInTurn");
    // A pay link first, then a charge: refused the same way.
    const other = createPayments(lees());
    await other.payLink(payLinkInput());
    expect(refusalOf(() => other.charge(chargeInput()))).toBe("secondChargeInTurn");
    // Two pay links built side by side for one booking: only one is built.
    const sideBySide = createPayments(lees());
    const both = await Promise.allSettled([
      sideBySide.payLink(payLinkInput()),
      sideBySide.payLink(payLinkInput()),
    ]);
    expect(both.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("another booking in the turn is charged, and the same booking in another turn", () => {
    const payments = createPayments(lees());
    payments.charge(chargeInput());
    const second = alexBooking("booking-alex-signature-cut");
    expect(payments.charge(chargeInput(second)).writes.effects).toHaveLength(1);
    const later = createPayments(lees({ turnId: "turn-alex-grooms-2", traceId: "trace-alex-0101" }));
    expect(later.charge(chargeInput()).writes.effects).toHaveLength(1);
    // A card save beside a charge for one booking is no second charge.
    const withSave = createPayments(lees());
    withSave.saveCard({ booking, personId: ALEX, stripeCustomerId: ALEX_CUSTOMER });
    expect(withSave.charge(chargeInput()).writes.effects).toHaveLength(1);
  });

  it("the turn's commit: two units charging one booking are refused (checkTurnCharges); one charge rides T-305's commit request, which K-05 v1.1 takes", () => {
    // Two parts, each with its own service, each charging the booking: the turn's effect rows are refused together.
    const one = createPayments(lees()).charge(chargeInput());
    const two = createPayments(lees()).charge(chargeInput());
    expect(
      refusalOf(() => {
        checkTurnCharges([...one.writes.effects, ...two.writes.effects]);
      }),
    ).toBe("secondChargeInTurn");
    // A charge and a pay link from two parts, for one booking: refused too.
    const [linkEffect] = createPayments(lees()).charge(chargeInput()).writes.effects;
    if (linkEffect === undefined) throw new Error("a charge effect");
    const asPayLink = { ...linkEffect, kind: "stripe_pay_link" as const };
    expect(
      refusalOf(() => {
        checkTurnCharges([...one.writes.effects, asPayLink]);
      }),
    ).toBe("secondChargeInTurn");
    // Distinct bookings, and a card save beside a charge, pass.
    const signature = createPayments(lees()).charge(chargeInput(alexBooking("booking-alex-signature-cut")));
    const save = createPayments(lees()).saveCard({ booking, personId: ALEX, stripeCustomerId: null });
    expect(
      refusalOf(() => {
        checkTurnCharges([...one.writes.effects, ...signature.writes.effects, ...save.writes.effects]);
      }),
    ).toBeNull();
    // The one charge, in T-305's one commit request under the turn id: K-05 v1.1 takes it whole.
    const request = buildCommitRequest({
      turn: turnRow(),
      zone: "America/New_York",
      businessId: LEES.id,
      actor: ALEX_ACTOR,
      units: [commitUnitOf(one.writes, alexYes(booking))],
    });
    checkTurnCharges(request.writes.effects?.write ?? []);
    expect(contractChecks().k05("commitTurn.request", request)).toEqual([]);
    expect(request.writes.effects?.write).toEqual(one.writes.effects);
    expect(request.writes.state.map((write) => write.table)).toEqual(["payments", "payment_items"]);
    expect(request.versionsRead).toEqual([
      { table: "bookings", rowId: booking.id, version: booking.version },
      { table: "booking_lines", rowId: GROOMS_LINE.id, version: GROOMS_LINE.version },
    ]);
    // The effect's entry carries the yes that approves it (T-305 default 3).
    expect(request.writes.events.map((entry) => [entry.kind, entry.rowId, entry.approvedBy])).toEqual([
      [
        "effect.created",
        one.effectId,
        {
          kind: "answer",
          open_question_id: `oq-a5-04-${booking.id}`,
          option_id: "opt-1",
          event_id: "evt-alex-0100",
        },
      ],
    ]);
  });
});
