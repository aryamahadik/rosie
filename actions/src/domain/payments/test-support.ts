// Test sources for the payments and ledger service (T-763), for the tests only. Nothing is invented and no real person is
// named (rule 9):
//   - the money combos are fixture set v1's test kit (fixtures/v1/test-kit/SCENARIOS.md, "Per money combo"), each run on
//     the demo shop and service it names (fixtures/v1/test-kit/shops/<id>.json), whose amounts are the shop's own;
//   - the record is T-137's compiled record of the master's two flows (the money home's sources, T-593), whose ways say
//     what each way takes now;
//   - the cast and the Lee's Barbershop rows are K-14 v1's, K-32 v1's and K-07 v1's fixtures' (Alex M., Sam, the $140
//     Groom's package with its $40 deposit, the $55 Signature cut); Stripe ids are their placeholders or the double's;
//     Riley (K-04 v1 seed-person-roles) stands in as a payer who is not the booker, with a customer and card in the
//     same placeholder form;
//   - the Stripe port is the Stripe double (T-422) under the effects runner (T-323) with the Stripe kinds (T-326), through
//     T-326's own harness, so the effect rows the service builds run exactly as the commit's rows will.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Account } from "../../../../adapters/src/stripe/double";
import type { CommitUnit, TurnActor, TurnRow, UnitWrites } from "../../commit";
import { noWrites } from "../../commit/test-support";
import { stripeHarness, type StripeHarness } from "../../effects/stripe/test-support";
import { amountsOf, sources, type Sources } from "../../homes/money/test-support";
import type { FlowLetter, MoneyRecord, MoneyService } from "../../homes/money";
import { claimedRowOf, withMoney } from "./rows";
import type {
  Booking,
  BookingLine,
  BookingPurpose,
  Card,
  ExactYes,
  MoneyEffect,
  MoneyWrites,
  PayLinkCodes,
  PayingBusiness,
  PaymentsDeps,
  Share,
} from "./types";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// ---- the turn and the cast (K-07, K-14 and K-32 v1's fixtures) ---------------------------------------------------------

/** The turn the deposit is charged in (K-07 v1 effect-charge.json; K-32 seed-payment-deposit). */
export const TURN_ID = "turn-alex-grooms-1";
export const TRACE_ID = "trace-alex-0100";
/** When the turn commits (K-07 effect-charge.json's commit) and the runner claims the row (its first try). */
export const COMMITTED_AT = "2026-11-07T15:20:00Z";
export const CLAIMED_AT = "2026-11-07T15:20:01Z";

/** Lee's Barbershop and its own connected account, as K-14 v1's fixtures name it. */
export const LEES: PayingBusiness = {
  id: "biz-lees-barbershop",
  name: "Lee's Barbershop",
  stripeAccountId: "stripe-acct-demo-lees-barbershop",
};
export const LEES_ACCOUNT: Account = { kind: "business", accountId: LEES.stripeAccountId };

export const ALEX = "person-alex";
export const SAM = "person-sam";
export const ALEX_CUSTOMER = "stripe-customer-demo-alex";
export const ALEX_CARD = "stripe-card-demo-alex";

/** A payer who is not the booker (RULES 3.13: "Someone else pays"), and Riley's customer and card on the shop's account. */
export const RILEY = "person-riley";
export const RILEY_CUSTOMER = "stripe-customer-demo-riley";
export const RILEY_CARD = "stripe-card-demo-riley";

/** The deps of one turn at Lee's Barbershop. */
export function lees(overrides: Partial<PaymentsDeps> = {}): PaymentsDeps {
  return {
    turnId: TURN_ID,
    traceId: TRACE_ID,
    business: LEES,
    now: COMMITTED_AT,
    payLinkCodes: TEST_CODES,
    ...overrides,
  };
}

/** A booking of Alex's at Lee's Barbershop (K-32 seed-payment-deposit's head row, at the version read). */
export function alexBooking(id = "booking-alex-grooms-package", overrides: Partial<Booking> = {}): Booking {
  return {
    id,
    businessId: LEES.id,
    version: 2,
    bookerPersonId: ALEX,
    payerPersonId: ALEX,
    ...overrides,
  };
}

/** Alex's own exact yes to the booking's read-back, recorded by this turn's commit. */
export function alexYes(booking: Booking, overrides: Partial<ExactYes> = {}): ExactYes {
  return {
    openQuestionId: `oq-a5-04-${booking.id}`,
    personId: booking.bookerPersonId,
    businessId: booking.businessId,
    bookingId: booking.id,
    answeredIn: TURN_ID,
    ...overrides,
  };
}

/** Alex's card saved for a booking (K-32 seed-payment-deposit's saved card), saved and usable. */
export function alexSavedCard(booking: Booking, id = "card-alex-grooms-package"): Card {
  return {
    personId: ALEX,
    stripeCustomerId: ALEX_CUSTOMER,
    stripePaymentMethodId: ALEX_CARD,
    savedCard: { id, bookingId: booking.id, saved: true, replaced: false, removed: false },
  };
}

/** Alex's card typed on the page for this payment only (K-32 default 15: no saved card row). */
export function alexTypedCard(): Card {
  return {
    personId: ALEX,
    stripeCustomerId: ALEX_CUSTOMER,
    stripePaymentMethodId: ALEX_CARD,
    savedCard: null,
  };
}

/** Riley's card saved for a booking Riley pays, saved and usable. */
export function rileySavedCard(booking: Booking, id = `card-riley-${booking.id}`): Card {
  return {
    personId: RILEY,
    stripeCustomerId: RILEY_CUSTOMER,
    stripePaymentMethodId: RILEY_CARD,
    savedCard: { id, bookingId: booking.id, saved: true, replaced: false, removed: false },
  };
}

/** Riley's card typed on the page for one payment only. */
export function rileyTypedCard(): Card {
  return {
    personId: RILEY,
    stripeCustomerId: RILEY_CUSTOMER,
    stripePaymentMethodId: RILEY_CARD,
    savedCard: null,
  };
}

/** K-32 v1 payment_items.share for each purpose a booking's money takes. */
export const SHARE_OF: Readonly<Record<BookingPurpose, Share>> = {
  deposit: "deposit",
  full_price: "full",
  rest: "rest",
  extra: "extra",
};

/**
 * The pay link codes' port for tests: a 43-character base64url code made from the link's id with a fixed test prefix
 * (a stand-in for HMAC-SHA-256 under PAY_LINK_CODE_SECRET; no key is read).
 */
export const TEST_CODES: PayLinkCodes = {
  keyName: "PAY_LINK_CODE_SECRET",
  async codeOf(linkId) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`test-pay-link-code/${linkId}`),
    );
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  },
};

/** The sha256 of a text, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---- the record (T-137's compiled record, through the money home's sources) --------------------------------------------

let records: Readonly<Record<FlowLetter, MoneyRecord>> | null = null;

/** Both flows' money records, compiled once. */
export async function moneyRecords(): Promise<Readonly<Record<FlowLetter, MoneyRecord>>> {
  if (records !== null) return records;
  const src: Sources = await sources();
  records = src.records;
  return records;
}

/** A booking line on a money path, with the amounts it carries (whole cents in dollars). */
export function lineOf(
  id: string,
  path: string,
  amounts: { price?: number; deposit?: number; paid?: number; fee?: number; rest?: number },
): BookingLine {
  const [price, before, after] = path.split("|");
  const money: MoneyService["amounts"] = {
    ...(amounts.price === undefined ? {} : { price: { cents: amounts.price, currency: "USD" } }),
    ...(amounts.deposit === undefined ? {} : { deposit: { cents: amounts.deposit, currency: "USD" } }),
    ...(amounts.paid === undefined ? {} : { paid: { cents: amounts.paid, currency: "USD" } }),
    ...(amounts.fee === undefined ? {} : { fee: { cents: amounts.fee, currency: "USD" } }),
    ...(amounts.rest === undefined ? {} : { rest: { cents: amounts.rest, currency: "USD" } }),
  };
  const service: MoneyService = {
    id: "own",
    price: price as MoneyService["price"],
    before: before as MoneyService["before"],
    after: after as MoneyService["after"],
    paidBy: "money",
    amounts: money,
  };
  return { id, version: 1, service };
}

// ---- SCENARIOS.md's money combos ---------------------------------------------------------------------------------------

/** What a combo states is taken at booking. */
export type StatedAtBooking =
  | { readonly way: "nothing" }
  | { readonly way: "card" }
  | { readonly way: "deposit"; readonly cents: number }
  | { readonly way: "full"; readonly cents: number };

/** One combo of SCENARIOS.md's "Per money combo": the flow, the money path, the shop and service, and its stated lines. */
export interface Scenario {
  readonly flow: FlowLetter;
  readonly combo: string;
  readonly shop: string;
  readonly service: string;
  /** Its "At booking" line, word for word. */
  readonly atBooking: string;
  readonly stated: StatedAtBooking;
}

const HEADING = /^### (A|B) · `([a-z]+\|[a-z]+\|[a-z]+)` on ([A-Za-z0-9-]+) \((.+)\)$/u;
const AT_BOOKING = /^- At booking: (.+)$/u;

/** "$1,855" or "$40.50" as cents. */
export function centsOf(text: string): number {
  const match = /^\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/u.exec(text);
  if (match === null) throw new Error(`not an amount: ${text}`);
  return Number((match[1] ?? "").replace(/,/gu, "")) * 100 + Number(match[2] ?? "0");
}

function statedOf(line: string): StatedAtBooking {
  if (line.startsWith("nothing is taken and no card is saved")) return { way: "nothing" };
  if (line.startsWith("the card is saved, $0 is taken, nothing is held on the card")) return { way: "card" };
  const deposit = /^the deposit (\$[0-9,.]+) is taken once the booking is written/u.exec(line);
  if (deposit?.[1] !== undefined) return { way: "deposit", cents: centsOf(deposit[1]) };
  const full = /^the full price (\$[0-9,.]+) is taken once the booking is written/u.exec(line);
  if (full?.[1] !== undefined) return { way: "full", cents: centsOf(full[1]) };
  throw new Error(`an "At booking" line SCENARIOS.md does not state this way: ${line}`);
}

/** SCENARIOS.md's money combos, in its order. */
export function scenarios(): Scenario[] {
  const text = readFileSync(`${ROOT}fixtures/v1/test-kit/SCENARIOS.md`, "utf8");
  const out: Scenario[] = [];
  let current: Omit<Scenario, "atBooking" | "stated"> | null = null;
  for (const line of text.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [, flow, combo, shop, service] = heading;
      if (flow === undefined || combo === undefined || shop === undefined || service === undefined)
        throw new Error(`a heading SCENARIOS.md cannot read: ${line}`);
      current = { flow: flow as FlowLetter, combo, shop, service };
      continue;
    }
    const at = AT_BOOKING.exec(line);
    if (at?.[1] !== undefined && current !== null) {
      out.push({ ...current, atBooking: at[1], stated: statedOf(at[1]) });
      current = null;
    }
  }
  return out;
}

/** A demo shop's service row (fixtures/v1/test-kit/shops/<id>.json flows.<flow>.services). */
export interface ShopService {
  readonly business: string;
  readonly combo: string;
  readonly name: string;
  readonly amounts: Readonly<Record<string, unknown>>;
}

/** The shop's service a combo names: its flow, money path and name. */
export function shopService(scenario: Scenario): ShopService {
  const shop = JSON.parse(
    readFileSync(`${ROOT}fixtures/v1/test-kit/shops/${scenario.shop}.json`, "utf8"),
  ) as {
    flows: Record<string, { business: string; services: Record<string, unknown>[] }>;
  };
  const flow = shop.flows[scenario.flow];
  if (flow === undefined) throw new Error(`${scenario.shop} has no flow ${scenario.flow}`);
  const found = flow.services.find(
    (service) => service.combo === scenario.combo && service.name === scenario.service,
  );
  if (found === undefined)
    throw new Error(`${scenario.shop} has no ${scenario.flow} ${scenario.combo} service ${scenario.service}`);
  return { business: flow.business, combo: scenario.combo, name: scenario.service, amounts: found };
}

/** The shop's service as a booking line: its money path and the amounts it carries (paid now is the shop's paid_now). */
export function shopLine(service: ShopService, id: string): BookingLine {
  const [price, before, after] = service.combo.split("|");
  const row = service.amounts;
  const money: MoneyService = {
    id: "own",
    price: price as MoneyService["price"],
    before: before as MoneyService["before"],
    after: after as MoneyService["after"],
    paidBy: "money",
    amounts: amountsOf({
      price: row.price,
      deposit: row.deposit,
      paid: row.paid_now,
      fee: row.fee,
      rest: row.rest,
    }),
  };
  return { id, version: 1, service: money };
}

// ---- the Stripe double under the effects runner (T-326's harness) ------------------------------------------------------

/** Runs effect rows the service built, as the commit writes them (pending, under the turn), through the runner. */
export async function runEffects(
  h: StripeHarness,
  effects: readonly MoneyEffect[],
  turnId = TURN_ID,
  at = COMMITTED_AT,
): Promise<void> {
  for (const effect of effects) h.commit(claimedRowOf(effect, turnId), at);
  await h.clock.drive(h.runner().runDue());
}

/** T-326's harness on the double, with a shop's account given Alex's card. */
export function harnessFor(account: Account, start = CLAIMED_AT): StripeHarness {
  const h = stripeHarness(start);
  if (account.kind === "business" && account.accountId !== LEES.stripeAccountId)
    h.double.seedCard({ paymentMethodId: ALEX_CARD, account, customerId: ALEX_CUSTOMER });
  return h;
}

// ---- the commit (T-305) ----------------------------------------------------------------------------------------------

/** K-05 v1 turn: the turn the money rows commit under. */
export function turnRow(id = TURN_ID): TurnRow {
  return {
    id,
    handleId: "handle-alex",
    eventIds: ["evt-alex-0100"],
    bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
    traceId: TRACE_ID,
    joinedTraceIds: [],
    tries: 1,
  };
}

/** Alex acts in the turn, a customer of Lee's Barbershop. */
export const ALEX_ACTOR: TurnActor = {
  personId: ALEX,
  roleAt: (businessId) => (businessId === LEES.id ? "customer" : null),
};

/** A passed part's writes carrying the money rows (T-305 UnitWrites), through the service's own withMoney. */
export function unitOf(writes: MoneyWrites, step = "A5-04"): UnitWrites {
  return withMoney(noWrites({ step, choice: "1 Book it" }), writes);
}

/** The commit unit of a part whose answer is the yes. */
export function commitUnitOf(writes: MoneyWrites, yes: ExactYes): CommitUnit {
  return {
    writes: unitOf(writes),
    answer: { openQuestionId: yes.openQuestionId, optionId: "opt-1", eventId: "evt-alex-0100" },
  };
}

// ---- a seeded generator for the property tests -------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a property test's cases are the same on every run. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** One of a list, by the generator. */
export function pick<T>(random: () => number, list: readonly T[]): T {
  const item = list[Math.floor(random() * list.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}
