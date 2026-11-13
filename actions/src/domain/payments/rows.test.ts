// The payments service's building blocks (T-763): the rows it writes against K-32 v1's table list and K-05 v1.1, the card
// save (A5-07; K-14 save-card.json), the pay link (A6-32, A9-05; K-14 charge-failed-pay-link.json; K-32 seed-pay-link),
// a booking's several services in one payment (RULES 3.2), the business scope (RULES 3.1), and the append-only ledger
// (arch 09 line 492; K-32 seed-payment-deposit and seed-pay-link), each line made from what the Stripe double says was
// taken, and none from a decline or a charge still waiting on the person's bank.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contractChecks } from "../../commit/test-support";
import { contractChecks as effectChecks } from "../../effects/runner/test-support";
import { k14, readExchange } from "../../effects/stripe/test-support";
import {
  PaymentRefusedError,
  appendLine,
  appendTo,
  chargeLine,
  claimedRowOf,
  createPayments,
  descriptionOf,
  takenFromEvent,
  type Booking,
  type LedgerLine,
  type LedgerPayment,
  type MoneyWrites,
  type PaymentRefusal,
  type PaymentsDeps,
  type PayLinkInput,
} from "./index";
import {
  ALEX,
  ALEX_CARD,
  ALEX_CUSTOMER,
  CLAIMED_AT,
  LEES,
  LEES_ACCOUNT,
  TEST_CODES,
  TURN_ID,
  alexBooking,
  alexSavedCard,
  alexTypedCard,
  alexYes,
  harnessFor,
  lees,
  lineOf,
  moneyRecords,
  runEffects,
  seeded,
  sha256Hex,
} from "./test-support";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

async function refusalOf(action: () => unknown): Promise<PaymentRefusal | null> {
  try {
    await action();
    return null;
  } catch (error) {
    if (error instanceof PaymentRefusedError) return error.reason;
    throw error;
  }
}

/** K-32 v1's table list: each table's columns, and those with no default that may not be null. */
function moneyTables(): Map<string, { columns: Set<string>; required: Set<string> }> {
  const list = JSON.parse(readFileSync(`${ROOT}contracts/db-schema/money/money.v1.tables.json`, "utf8")) as {
    tables: { name: string; columns: { name: string; null: boolean; default?: string }[] }[];
  };
  return new Map(
    list.tables.map((table) => [
      table.name,
      {
        columns: new Set(table.columns.map((column) => column.name)),
        required: new Set(
          table.columns.filter((column) => !column.null && column.default === undefined).map((c) => c.name),
        ),
      },
    ]),
  );
}

/** A K-32 seed fixture's row of a table, by its id. */
function seedRow(file: string, table: string, id: string): Record<string, unknown> {
  const seed = JSON.parse(readFileSync(`${ROOT}contracts/db-schema/money/fixtures/${file}`, "utf8")) as {
    rows: { table: string; values: Record<string, unknown> }[];
  };
  const row = seed.rows.find((each) => each.table === table && each.values.id === id);
  if (row === undefined) throw new Error(`${file} has no ${table} row ${id}`);
  return row.values;
}

/** Every write and effect a call made, held to K-05 v1.1 and to K-32's table list. */
function expectContractRows(writes: MoneyWrites): void {
  const tables = moneyTables();
  const checks = contractChecks();
  for (const write of writes.state) {
    expect(checks.k05("stateWrite", write), write.table).toEqual([]);
    if (write.op !== "insert") throw new Error("money rows are only inserted");
    const table = tables.get(write.table);
    if (table === undefined) throw new Error(`${write.table} is not a K-32 table`);
    for (const column of Object.keys(write.values)) expect(table.columns.has(column), column).toBe(true);
    for (const column of table.required)
      expect(Object.keys(write.values), `${write.table}.${column}`).toContain(column);
  }
  for (const effect of writes.effects) {
    expect(checks.k05("effectNew", effect)).toEqual([]);
    expect(effectChecks().k07("effectRow", claimedRowOf(effect, TURN_ID))).toEqual([]);
  }
  for (const row of writes.versionsRead) expect(checks.k05("rowRef", row)).toEqual([]);
}

const valuesOf = (writes: MoneyWrites, table: string): Record<string, unknown>[] =>
  writes.state.flatMap((write) => (write.op === "insert" && write.table === table ? [write.values] : []));

// ---- the card save -----------------------------------------------------------------------------------------------------

describe("a card saved for a booking (A5-07; K-14 saveCard)", () => {
  it("builds save-card.json's request and the saved card row its result and cardSaved fill, nothing charged", () => {
    const booking = alexBooking("booking-alex-haircut-riley");
    const saved = createPayments(lees()).saveCard({ booking, personId: ALEX, stripeCustomerId: null });
    const [effect] = saved.writes.effects;
    expect(effect).toMatchObject({
      kind: "stripe_save_card",
      amount: null,
      personId: ALEX,
      bookingId: booking.id,
    });
    expect(effect?.portRequest).toEqual(readExchange("save-card.json").request.port);
    expect(
      k14("saveCard.request", {
        effect: { effectId: effect?.effectId, idempotencyKey: effect?.idempotencyKey },
        port: effect?.portRequest,
      }),
    ).toEqual([]);
    expect(valuesOf(saved.writes, "saved_cards")).toEqual([
      {
        id: saved.savedCardId,
        business_id: LEES.id,
        person_id: ALEX,
        booking_id: booking.id,
        membership_id: null,
        stripe_customer_id: null,
        stripe_payment_method_id: null,
        save_effect_id: saved.effectId,
        saved_from_payment_id: null,
      },
    ]);
    expect(valuesOf(saved.writes, "payments")).toEqual([]);
    expectContractRows(saved.writes);
  });

  it("is only the booker's own card, once per booking in a turn", async () => {
    const booking = alexBooking();
    const payments = createPayments(lees());
    expect(
      await refusalOf(() => payments.saveCard({ booking, personId: "person-riley", stripeCustomerId: null })),
    ).toBe("cardNotUsable");
    payments.saveCard({ booking, personId: ALEX, stripeCustomerId: ALEX_CUSTOMER });
    expect(
      await refusalOf(() => payments.saveCard({ booking, personId: ALEX, stripeCustomerId: ALEX_CUSTOMER })),
    ).toBe("badInput");
  });
});

// ---- the money step ----------------------------------------------------------------------------------------------------

describe("a booking's money step (A5-04)", () => {
  const booking = alexBooking("booking-alex-mixed");
  const step = async (overrides: Record<string, unknown> = {}) => {
    const records = await moneyRecords();
    return createPayments(lees()).moneyStep({
      booking,
      record: records.A,
      currency: "USD",
      lines: [
        lineOf("line-mixed-1", "list|deposit|counter", {
          price: 14000,
          deposit: 4000,
          rest: 10000,
          fee: 4000,
        }),
        lineOf("line-mixed-2", "list|full|none", { price: 5500, paid: 5500, fee: 2000 }),
        lineOf("line-mixed-3", "list|card|counter", { price: 3500, fee: 2000 }),
      ],
      yes: alexYes(booking),
      card: alexSavedCard(booking, "card-alex-mixed"),
      stripeCustomerId: ALEX_CUSTOMER,
      what: "the Groom's package, the Signature cut and a haircut",
      ...overrides,
    });
  };

  it("takes all that is due now across several services in one payment, on one card, as a deposit with part left (RULES 3.2)", async () => {
    const taken = await step();
    expect(taken.way).toBe("deposit");
    expect(taken.dueNow).toEqual({ cents: 9500, currency: "USD" });
    expect(taken.writes.effects).toHaveLength(1);
    expect(taken.writes.effects[0]).toMatchObject({
      kind: "stripe_charge",
      amount: { cents: 9500, currency: "USD" },
    });
    expect(
      valuesOf(taken.writes, "payment_items").map((item) => [
        item.booking_line_id,
        item.share,
        item.amount_cents,
      ]),
    ).toEqual([
      ["line-mixed-1", "deposit", 4000],
      ["line-mixed-2", "full", 5500],
    ]);
    expect(valuesOf(taken.writes, "payments")[0]).toMatchObject({
      purpose: "deposit",
      saved_card_id: "card-alex-mixed",
    });
    expect(taken.writes.versionsRead.map((row) => row.rowId)).toEqual([
      booking.id,
      "line-mixed-1",
      "line-mixed-2",
      "line-mixed-3",
    ]);
    expectContractRows(taken.writes);
  });

  it("all paid now is the full price; a card way with a card already kept builds nothing more", async () => {
    const records = await moneyRecords();
    const full = createPayments(lees()).moneyStep({
      booking,
      record: records.A,
      currency: "USD",
      lines: [lineOf("line-full-1", "list|full|none", { price: 5500, paid: 5500 })],
      yes: alexYes(booking),
      card: alexTypedCard(),
      stripeCustomerId: ALEX_CUSTOMER,
      what: "Signature cut and hot towel shave",
    });
    expect(full.way).toBe("full");
    expect(full.writes.effects[0]?.portRequest).toEqual(readExchange("full-price.json").request.port);
    expect(valuesOf(full.writes, "payments")[0]).toMatchObject({
      purpose: "full_price",
      saved_card_id: null,
    });
    const kept = createPayments(lees()).moneyStep({
      booking,
      record: records.A,
      currency: "USD",
      lines: [lineOf("line-card-1", "list|card|counter", { price: 3500, fee: 2000 })],
      yes: alexYes(booking),
      card: alexSavedCard(booking),
      stripeCustomerId: ALEX_CUSTOMER,
      what: "a haircut",
    });
    expect([kept.way, kept.builds, kept.writes.effects.length, kept.writes.state.length]).toEqual([
      "card",
      "nothing",
      0,
      0,
    ]);
  });

  it("refuses what it cannot take: no card, a deposit on a card not kept, a card not usable, an amount not known", async () => {
    const records = await moneyRecords();
    expect(await refusalOf(() => step({ card: null }))).toBe("noCard");
    expect(await refusalOf(() => step({ card: alexTypedCard() }))).toBe("cardNotKept");
    const saved = alexSavedCard(booking, "card-alex-mixed");
    const savedCard = saved.savedCard;
    if (savedCard === null) throw new Error("a saved card");
    for (const card of [
      { ...saved, savedCard: { ...savedCard, replaced: true } },
      { ...saved, savedCard: { ...savedCard, removed: true } },
      { ...saved, savedCard: { ...savedCard, saved: false } },
      { ...saved, savedCard: { ...savedCard, bookingId: "booking-other" } },
      { ...saved, personId: "person-riley" },
    ])
      expect(await refusalOf(() => step({ card }))).toBe("cardNotUsable");
    // A deposit way with no deposit amount: never guessed (S13-55).
    expect(
      await refusalOf(() =>
        createPayments(lees()).moneyStep({
          booking,
          record: records.A,
          currency: "USD",
          lines: [lineOf("line-unknown-1", "list|deposit|counter", { price: 14000 })],
          yes: alexYes(booking),
          card: alexSavedCard(booking),
          stripeCustomerId: ALEX_CUSTOMER,
          what: "the Groom's package",
        }),
      ),
    ).toBe("amountNotKnown");
  });
});

// ---- the business's own account ----------------------------------------------------------------------------------------

describe("every charge lands in the business's own Stripe account (RULES 3.1)", () => {
  it("runs on the call's business's account only, and never on a booking of another business", async () => {
    const yoga: Booking = { ...alexBooking("booking-alex-hot-flow"), businessId: "biz-yoga-studio" };
    const payments = createPayments(lees());
    expect(
      await refusalOf(() => payments.saveCard({ booking: yoga, personId: ALEX, stripeCustomerId: null })),
    ).toBe("otherBusiness");
    const asked = payments.charge({
      booking: alexBooking(),
      lines: [{ id: "line-alex-grooms-1", version: 1 }],
      purpose: "deposit",
      items: [{ lineId: "line-alex-grooms-1", share: "deposit", amount: { cents: 4000, currency: "USD" } }],
      card: alexSavedCard(alexBooking()),
      customerPresent: true,
      yes: alexYes(alexBooking()),
      what: "the Groom's package",
    });
    expect(asked.writes.effects[0]?.portRequest).toMatchObject({ account: LEES_ACCOUNT });
    // An item naming a line the booking was not read with is refused (K-32 rule 10).
    expect(
      await refusalOf(() =>
        createPayments(lees()).charge({
          booking: alexBooking(),
          lines: [{ id: "line-alex-grooms-1", version: 1 }],
          purpose: "deposit",
          items: [
            { lineId: "line-yoga-hot-flow-1", share: "deposit", amount: { cents: 4000, currency: "USD" } },
          ],
          card: alexSavedCard(alexBooking()),
          customerPresent: true,
          yes: alexYes(alexBooking()),
          what: "the Groom's package",
        }),
      ),
    ).toBe("badInput");
    // An account id that reads as a card number is never sent.
    const odd = createPayments(lees({ business: { ...LEES, stripeAccountId: "4242 4242 4242 4242" } }));
    expect(
      await refusalOf(() => odd.saveCard({ booking: alexBooking(), personId: ALEX, stripeCustomerId: null })),
    ).toBe("badInput");
  });

  it("says what each charge is for, as K-14's fixtures write it (RULES 3.14)", () => {
    expect(descriptionOf(LEES, "deposit", "the Groom's package")).toBe(
      "Lee's Barbershop: deposit for the Groom's package",
    );
    expect(descriptionOf(LEES, "full_price", "Signature cut and hot towel shave")).toBe(
      "Lee's Barbershop: Signature cut and hot towel shave, paid in full",
    );
    expect(descriptionOf(LEES, "rest", "home grooming visit, Thu Nov 5")).toBe(
      "Lee's Barbershop: home grooming visit, Thu Nov 5",
    );
    expect(() => descriptionOf(LEES, "deposit", "card 4242 4242 4242 4242")).toThrow(PaymentRefusedError);
    expect(() => descriptionOf(LEES, "deposit", "  ")).toThrow(PaymentRefusedError);
    expect(() => descriptionOf(LEES, "deposit", "two\nlines")).toThrow(PaymentRefusedError);
  });
});

// ---- the pay link ------------------------------------------------------------------------------------------------------

describe("a pay link (A6-32, A9-05; K-14 payLink; K-32 pay_links)", () => {
  const booking = alexBooking("booking-alex-color-correction");
  const linkInput = (overrides: Partial<PayLinkInput> = {}): PayLinkInput => ({
    booking,
    lines: [{ id: "line-alex-color-1", version: 1 }],
    purpose: "deposit",
    items: [{ lineId: "line-alex-color-1", share: "deposit", amount: { cents: 2500, currency: "USD" } }],
    personId: ALEX,
    stripeCustomerId: ALEX_CUSTOMER,
    saveCardForLater: true,
    givenVia: ["text", "email"],
    dueAt: "2026-11-07T17:00:00Z",
    yes: alexYes(booking, { answeredIn: "turn-alex-color-request" }),
    what: "Color correction",
    ...overrides,
  });

  it("builds charge-failed-pay-link.json's request, its payment pending and its link keeping only its code's hash", async () => {
    const asked = await createPayments(lees()).payLink(linkInput());
    const [effect] = asked.writes.effects;
    const fixture = readExchange("charge-failed-pay-link.json").request;
    expect(effect).toMatchObject({ kind: "stripe_pay_link", amount: fixture.amount });
    expect(effect?.portRequest).toEqual(fixture.port);
    expect(
      k14("payLink.request", {
        effect: { effectId: effect?.effectId, idempotencyKey: effect?.idempotencyKey },
        amount: effect?.amount,
        port: effect?.portRequest,
      }),
    ).toEqual([]);
    const code = await TEST_CODES.codeOf(asked.payLinkId);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(valuesOf(asked.writes, "pay_links")).toEqual([
      {
        id: asked.payLinkId,
        business_id: LEES.id,
        payment_id: asked.paymentId,
        person_id: ALEX,
        given_via: ["text", "email"],
        code_sha256: await sha256Hex(code),
        due_at: "2026-11-07T17:00:00Z",
      },
    ]);
    expect(JSON.stringify(asked.writes)).not.toContain(code);
    expect(valuesOf(asked.writes, "payments")[0]).toMatchObject({
      state: "pending",
      method: "card",
      saved_card_id: null,
    });
    expectContractRows(asked.writes);
  });

  it("builds seed-pay-link's bill for the rest, for the payer, with no deadline (A9-05)", async () => {
    const home = alexBooking("booking-alex-home-grooming");
    const asked = await createPayments(lees()).payLink({
      booking: home,
      lines: [{ id: "line-alex-home-grooming-1", version: 1 }],
      purpose: "rest",
      items: [
        { lineId: "line-alex-home-grooming-1", share: "rest", amount: { cents: 17900, currency: "USD" } },
      ],
      personId: ALEX,
      stripeCustomerId: ALEX_CUSTOMER,
      saveCardForLater: false,
      givenVia: ["text", "email"],
      dueAt: null,
      yes: alexYes(home, { answeredIn: "turn-alex-home-grooming-book" }),
      what: "home grooming visit, Thu Nov 5",
    });
    const seedEffect = seedRow("seed-pay-link.json", "effects", "eff-alex-home-grooming-bill");
    expect(asked.writes.effects[0]?.portRequest).toEqual(seedEffect.port_request);
    expect(asked.writes.effects[0]?.amount).toEqual({
      cents: seedEffect.amount_cents,
      currency: seedEffect.currency,
    });
    expect(valuesOf(asked.writes, "payment_items")[0]).toMatchObject({ share: "rest", amount_cents: 17900 });
  });

  it("refuses a deadline not after now, a place it cannot go, a card saved with no customer, no code port or a bad code", async () => {
    const payments = () => createPayments(lees());
    expect(await refusalOf(() => payments().payLink(linkInput({ dueAt: "2026-11-07T15:20:00Z" })))).toBe(
      "badInput",
    );
    expect(await refusalOf(() => payments().payLink(linkInput({ givenVia: [] })))).toBe("badInput");
    expect(
      await refusalOf(() => payments().payLink(linkInput({ givenVia: ["sms" as unknown as "text"] }))),
    ).toBe("badInput");
    expect(await refusalOf(() => payments().payLink(linkInput({ stripeCustomerId: null })))).toBe("badInput");
    expect(await refusalOf(() => payments().payLink(linkInput({ personId: "person-riley" })))).toBe(
      "badInput",
    );
    const noCodes: PaymentsDeps = {
      turnId: TURN_ID,
      traceId: "trace-alex-0100",
      business: LEES,
      now: CLAIMED_AT,
    };
    expect(await refusalOf(() => createPayments(noCodes).payLink(linkInput()))).toBe("noPayLinkCode");
    const shortCodes = lees({
      payLinkCodes: { keyName: "PAY_LINK_CODE_SECRET", codeOf: () => Promise.resolve("a2") },
    });
    expect(await refusalOf(() => createPayments(shortCodes).payLink(linkInput()))).toBe("noPayLinkCode");
  });

  it("runs on the Stripe double: the pay page takes the payment, and its paymentSucceeded makes one charge line", async () => {
    const asked = await createPayments(lees()).payLink(linkInput());
    const h = harnessFor(LEES_ACCOUNT);
    await runEffects(h, asked.writes.effects);
    const paymentId = h.repo.held(asked.effectId).row.providerObjectId;
    if (paymentId === null) throw new Error("the pay link made its payment");
    const page = h.double.payOnPage(paymentId);
    expect(page.result).toBe("paid");
    const lines = page.events.flatMap((event) => {
      const taken = takenFromEvent(event);
      return taken === null
        ? []
        : [
            chargeLine(
              {
                id: asked.paymentId,
                businessId: LEES.id,
                bookingId: booking.id,
                effectId: asked.effectId,
                amount: asked.amount,
              },
              taken,
            ),
          ];
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "charge", amount_cents: 2500, written_by: "provider_event" });
  });
});

// ---- the ledger --------------------------------------------------------------------------------------------------------

describe("the ledger is append-only (arch 09 line 492; K-32 ledger_lines)", () => {
  const deposit: LedgerPayment = {
    id: "pay-alex-grooms-deposit",
    businessId: LEES.id,
    bookingId: "booking-alex-grooms-package",
    effectId: "eff-alex-grooms-deposit",
    amount: { cents: 4000, currency: "USD" },
  };

  /** A K-32 seed line without the database's written_at. */
  function seedLine(file: string, id: string): Record<string, unknown> {
    const line = { ...seedRow(file, "ledger_lines", id) };
    delete line.written_at;
    return line;
  }

  it("makes seed-payment-deposit's charge line from the charge's result, and from its paymentSucceeded event (K-14 webhook-event.json)", () => {
    const fromResult = chargeLine(deposit, {
      from: "effectResult",
      effectId: "eff-alex-grooms-deposit",
      paymentId: "stripe-payment-demo-0001",
      chargeId: "stripe-charge-demo-0001",
      chargedAt: "2026-11-07T15:20:02Z",
    });
    expect({ ...fromResult, id: "ledger-alex-grooms-deposit" }).toEqual(
      seedLine("seed-payment-deposit.json", "ledger-alex-grooms-deposit"),
    );
    const event = (
      readExchange("webhook-event.json").outcome as { event: Parameters<typeof takenFromEvent>[0] }
    ).event;
    const taken = takenFromEvent(event);
    if (taken === null) throw new Error("paymentSucceeded takes money");
    expect(chargeLine(deposit, taken)).toEqual({ ...fromResult, written_by: "provider_event" });
  });

  it("appends a line once: a repeat writes nothing, a change is refused, a second charge line for a payment or a Stripe charge is refused", async () => {
    const line = chargeLine(deposit, {
      from: "effectResult",
      effectId: deposit.effectId,
      paymentId: "stripe-payment-demo-0001",
      chargeId: "stripe-charge-demo-0001",
      chargedAt: "2026-11-07T15:20:02Z",
    });
    expect(appendLine([], line)).toEqual(line);
    expect(appendLine([line], line)).toBeNull();
    expect(appendTo([line], line)).toEqual([line]);
    // The same charge learned again from its paymentSucceeded event, a second later: nothing more, the first line kept.
    const fromEvent: LedgerLine = { ...line, written_by: "provider_event", moved_at: "2026-11-07T15:20:03Z" };
    expect(appendLine([line], fromEvent)).toBeNull();
    expect(appendTo([line], fromEvent)).toEqual([line]);
    // The same line read back with its columns in another order is the same line.
    const reordered = Object.fromEntries(Object.entries(line).reverse()) as unknown as LedgerLine;
    expect(appendLine([reordered], line)).toBeNull();
    const edited: LedgerLine = { ...line, amount_cents: 14000 };
    expect(await refusalOf(() => appendLine([line], edited))).toBe("ledgerEdit");
    expect(
      await refusalOf(() => appendLine([line], { ...line, stripe_object_id: "stripe-charge-demo-0099" })),
    ).toBe("ledgerEdit");
    expect(await refusalOf(() => appendLine([line], { ...line, id: "ledger-other" }))).toBe("ledgerTwice");
    expect(
      await refusalOf(() => appendLine([line], { ...line, id: "ledger-other", payment_id: "pay-other" })),
    ).toBe("ledgerTwice");
  });

  it("keeps every line it has, unchanged and in order, through any run of appends (seeded)", () => {
    const random = seeded(492);
    let lines: readonly LedgerLine[] = [];
    for (let n = 0; n < 400; n += 1) {
      const payment = `pay-${String(Math.floor(random() * 60))}`;
      const line = chargeLine(
        { ...deposit, id: payment, effectId: `eff-${payment}` },
        {
          from: "effectResult",
          effectId: `eff-${payment}`,
          paymentId: `stripe-payment-${payment}`,
          chargeId: `stripe-charge-${payment}`,
          chargedAt: "2026-11-07T15:20:02Z",
        },
      );
      const before = structuredClone(lines);
      lines = appendTo(lines, line);
      expect(lines.slice(0, before.length)).toEqual(before);
      expect(lines.length - before.length).toBeLessThanOrEqual(1);
    }
    expect(new Set(lines.map((line) => line.payment_id)).size).toBe(lines.length);
  });

  it("makes a line only from money taken: a decline, a cancel and a card saved make none, and a mismatched result is refused", async () => {
    for (const kind of ["paymentFailed", "paymentCanceled", "cardSaved", "refundChanged"])
      expect(
        takenFromEvent({ kind, effectId: deposit.effectId, occurredAt: CLAIMED_AT, payload: {} }),
      ).toBeNull();
    expect(
      await refusalOf(() =>
        takenFromEvent({
          kind: "paymentSucceeded",
          effectId: deposit.effectId,
          occurredAt: CLAIMED_AT,
          payload: {},
        }),
      ),
    ).toBe("ledgerMismatch");
    const taken = {
      from: "providerEvent" as const,
      effectId: deposit.effectId,
      occurredAt: CLAIMED_AT,
      payload: {
        paymentId: "stripe-payment-demo-0001",
        chargeId: "stripe-charge-demo-0001",
        amount: deposit.amount,
      },
    };
    expect(await refusalOf(() => chargeLine(deposit, { ...taken, effectId: "eff-other" }))).toBe(
      "ledgerMismatch",
    );
    expect(
      await refusalOf(() =>
        chargeLine(deposit, {
          ...taken,
          payload: { ...taken.payload, amount: { cents: 14000, currency: "USD" } },
        }),
      ),
    ).toBe("ledgerMismatch");
    expect(
      await refusalOf(() =>
        chargeLine(deposit, { ...taken, payload: { ...taken.payload, chargeId: "4242424242424242" } }),
      ),
    ).toBe("ledgerMismatch");
  });

  it("on the Stripe double: a declined deposit and one waiting on the bank write no line until money is taken", async () => {
    const booking = alexBooking();
    const charge = () =>
      createPayments(lees()).charge({
        booking,
        lines: [{ id: "line-alex-grooms-1", version: 1 }],
        purpose: "deposit",
        items: [{ lineId: "line-alex-grooms-1", share: "deposit", amount: { cents: 4000, currency: "USD" } }],
        card: alexSavedCard(booking),
        customerPresent: true,
        yes: alexYes(booking),
        what: "the Groom's package",
      });
    const payment = (asked: ReturnType<typeof charge>): LedgerPayment => ({
      id: asked.paymentId,
      businessId: LEES.id,
      bookingId: booking.id,
      effectId: asked.effectId,
      amount: asked.amount,
    });
    const linesOf = (
      events: readonly Parameters<typeof takenFromEvent>[0][],
      asked: ReturnType<typeof charge>,
    ) =>
      events.flatMap((event) => {
        const taken = takenFromEvent(event);
        return taken === null ? [] : [chargeLine(payment(asked), taken)];
      });

    const declined = harnessFor(LEES_ACCOUNT);
    declined.double.seedCard({
      paymentMethodId: ALEX_CARD,
      account: LEES_ACCOUNT,
      customerId: ALEX_CUSTOMER,
      behavior: "chargeDeclined",
    });
    const first = charge();
    await runEffects(declined, first.writes.effects);
    expect(declined.repo.held(first.effectId).row.state).toBe("declined");
    expect(linesOf(declined.double.events(), first)).toEqual([]);

    const bank = harnessFor(LEES_ACCOUNT);
    bank.double.seedCard({
      paymentMethodId: ALEX_CARD,
      account: LEES_ACCOUNT,
      customerId: ALEX_CUSTOMER,
      behavior: "authenticationRequired",
    });
    const second = charge();
    await runEffects(bank, second.writes.effects);
    expect(linesOf(bank.double.events(), second)).toEqual([]);
    const paymentId = bank.repo.held(second.effectId).row.providerObjectId;
    if (paymentId === null) throw new Error("the charge made its payment");
    const confirmed = bank.double.completeAuthentication(paymentId, true);
    expect(linesOf(confirmed, second).map((line) => [line.kind, line.amount_cents, line.written_by])).toEqual(
      [["charge", 4000, "provider_event"]],
    );
  });
});
