// T-422: the Stripe double against K-14 v1's fixtures and schema. No network, no key; fixtures hold placeholder ids and
// Stripe's published test cards only (BP 9.4). Every answer the double gives is checked against the schema's exchange
// for its call, and every K-14 fixture the double answers is run through it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createStripeDouble, KEY_LIFE_MS, PUBLISHED_TEST_CARDS, type StripeDouble } from "./double";
import type { Account, CardBehavior, ListItem, WebhookEvent } from "./types";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-stripe", "fixtures");
const SCHEMA_ID = "https://rosie.invalid/contracts/port-stripe/port-stripe.v1.schema.json";

type Json = Record<string, unknown>;
interface Exchange {
  call: string;
  given: { now: string; note: string };
  request: Json;
  outcome: Json;
}
interface IndexEntry {
  file: string;
  def: string;
  expect: "accept" | "refuse";
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
const readFixture = (file: string): Exchange => readJson(file) as Exchange;
const INDEX = (readJson("index.json") as { fixtures: IndexEntry[] }).fixtures;

let ajv: Ajv2020;
const validators = new Map<string, ValidateFunction>();

beforeAll(() => {
  ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const folders = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["scripts", "generated", "node_modules"].includes(entry.name))
    .map((entry) => entry.name);
  for (const folder of folders) {
    for (const file of readdirSync(path.join(CONTRACTS, folder))) {
      if (!file.endsWith(".schema.json")) continue;
      ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS, folder, file), "utf8")) as object);
    }
  }
});

function validator(def: string): ValidateFunction {
  const known = validators.get(def);
  if (known !== undefined) return known;
  const check = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (check === undefined) throw new Error(`the schema has no ${def}`);
  validators.set(def, check);
  return check;
}

/** The double's answer, as the exchange the schema checks. */
function expectExchange(
  call: string,
  request: unknown,
  outcome: unknown,
  now = "2026-11-07T15:20:01Z",
): void {
  const exchange = { call, given: { now, note: "double" }, request, outcome };
  const check = validator(`${call}.exchange`);
  expect(check(exchange), `${call}: ${JSON.stringify(check.errors)}`).toBe(true);
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error("the list has no such item");
  return item;
}

function expectEvent(event: WebhookEvent): void {
  const check = validator("webhookEvent");
  expect(check(event), `${event.kind}: ${JSON.stringify(check.errors)}`).toBe(true);
}

// ---- a clock the test moves ----

function clock(start: string): { now: () => string; advance: (ms: number) => void } {
  let at = Date.parse(start);
  return {
    now: () => new Date(at).toISOString().replace(/[.][0-9]+Z$/, "Z"),
    advance: (ms) => {
      at += ms;
    },
  };
}

const START = "2026-11-07T15:20:00Z";
const HOUR = 3600 * 1000;
const SHOP: Account = { kind: "business", accountId: "stripe-acct-demo-lees-barbershop" };
const ROSFIELD: Account = { kind: "rosfield" };
const OWNER_YES = {
  kind: "ownerYes",
  person_id: "person-sam",
  role: "owner",
  open_question_id: "oq-a10-16-sam",
  option_id: "send-the-record",
  event_id: "evt-sam-0042",
};

function chargeRequest(
  effectId: string,
  overrides: {
    key?: string;
    cents?: number;
    card?: string;
    present?: boolean;
    account?: Account;
    purpose?: string;
  } = {},
): Json {
  return {
    effect: { effectId, idempotencyKey: overrides.key ?? effectId },
    amount: { cents: overrides.cents ?? 4000, currency: "USD" },
    port: {
      account: overrides.account ?? SHOP,
      purpose: overrides.purpose ?? "deposit",
      customerId: "stripe-customer-demo-alex",
      paymentMethodId: overrides.card ?? "stripe-card-demo-alex",
      customerPresent: overrides.present ?? true,
      description: "Lee's Barbershop: deposit for the Groom's package",
    },
  };
}

function withCard(behavior: CardBehavior = "visa", card = "stripe-card-demo-alex"): StripeDouble {
  const double = createStripeDouble({ now: () => START });
  double.seedCard({
    paymentMethodId: card,
    account: SHOP,
    customerId: "stripe-customer-demo-alex",
    behavior,
  });
  return double;
}

function listAll(double: StripeDouble, account: Account = SHOP, to = "2026-12-01T00:00:00Z"): ListItem[] {
  const request = { account, from: "2026-11-01T00:00:00Z", to };
  const outcome = double.listMoney(request);
  expectExchange("listMoney", request, outcome);
  if (outcome.result !== "listed") throw new Error("the listing failed");
  return outcome.items;
}

// ---- every K-14 fixture the double answers ----

const DECLINE_CARD: Record<string, CardBehavior> = {
  generic_decline: "chargeDeclined",
  insufficient_funds: "insufficientFunds",
  expired_card: "expiredCard",
  authentication_required: "authenticationRequired",
};

function accountOf(value: unknown): Account {
  return value as Account;
}

/** Sets the double up as the fixture assumes, runs the fixture's request, and checks the answer against the fixture's. */
function runFixture(file: string): void {
  const fx = readFixture(file);
  const double = createStripeDouble({ now: () => fx.given.now });
  const request = fx.request;
  const expected = fx.outcome;
  const call = fx.call;
  let actual: Json;

  switch (call) {
    case "onboardingLink": {
      actual = double.onboardingLink(request) as unknown as Json;
      expect(actual.accountCreated).toBe(expected.accountCreated);
      if (request.accountId !== null) expect(actual.accountId).toBe(request.accountId);
      expect(Date.parse(actual.expiresAt as string)).toBeGreaterThan(Date.parse(fx.given.now));
      break;
    }
    case "accountStatus": {
      if (expected.result === "disconnected") double.disconnectAccount(request.accountId as string);
      else double.setAccountState(request.accountId as string, expected.state as Json);
      actual = double.accountStatus(request) as unknown as Json;
      expect(actual.result).toBe(expected.result);
      expect(actual.state).toEqual(expected.state);
      break;
    }
    case "saveCard": {
      actual = double.saveCard(request) as unknown as Json;
      const port = request.port as Json;
      if (port.customerId !== null) expect(actual.customerId).toBe(port.customerId);
      expect(typeof actual.clientSecret).toBe("string");
      break;
    }
    case "charge": {
      const port = request.port as Json;
      const behavior: CardBehavior =
        expected.result === "needsAuthentication"
          ? "authenticationRequired"
          : typeof expected.declineCode === "string"
            ? (DECLINE_CARD[expected.declineCode] ?? "chargeDeclined")
            : "visa";
      double.seedCard({
        paymentMethodId: port.paymentMethodId as string,
        account: accountOf(port.account),
        customerId: port.customerId as string,
        behavior,
        ...(expected.result === "charged" && expected.card !== null
          ? { card: expected.card as { brand: "visa"; last4: string } }
          : {}),
      });
      if (expected.result === "failed" && expected.kind === "transient")
        double.failNext("charge", {
          kind: "transient",
          httpStatus: expected.httpStatus as number | null,
          code: expected.code as string | null,
        });
      actual = double.charge(request) as unknown as Json;
      expect(actual.result).toBe(expected.result);
      if (expected.result === "charged") expect(actual.card).toEqual(expected.card);
      if (expected.result === "needsAuthentication") expect(typeof actual.clientSecret).toBe("string");
      if (expected.result === "failed") {
        for (const field of ["kind", "httpStatus", "code", "declineCode"])
          expect(actual[field], field).toEqual(expected[field]);
      }
      break;
    }
    case "payLink": {
      actual = double.payLink(request) as unknown as Json;
      expect(typeof actual.clientSecret).toBe("string");
      break;
    }
    case "closePayLink": {
      const state =
        expected.result === "alreadyPaid"
          ? "succeeded"
          : expected.result === "alreadyClosed"
            ? "canceled"
            : "needsCard";
      double.seedPayment({
        paymentId: request.paymentId as string,
        account: accountOf(request.account),
        amount: { cents: 2500, currency: "USD" },
        state,
      });
      actual = double.closePayLink(request) as unknown as Json;
      expect(actual.paymentId).toBe(request.paymentId);
      expect(actual.paidAt === null).toBe(expected.paidAt === null);
      break;
    }
    case "removeCard": {
      double.seedCard({
        paymentMethodId: request.paymentMethodId as string,
        account: accountOf(request.account),
        customerId: request.customerId as string,
      });
      if (expected.result === "alreadyRemoved") double.removeCard(request);
      actual = double.removeCard(request) as unknown as Json;
      expect(actual.paymentMethodId).toBe(request.paymentMethodId);
      break;
    }
    case "pageIntent": {
      const account = accountOf(request.account);
      const card = expected.card as { brand: "visa"; last4: string } | null;
      const paymentMethodId = "stripe-card-for-the-page";
      if (card !== null)
        double.seedCard({ paymentMethodId, account, customerId: "stripe-customer-demo-alex", card });
      const state = expected.state as "needsCard";
      const clientSecret = expected.clientSecret as string | null;
      if ("setupId" in request)
        double.seedSetup({
          setupId: request.setupId as string,
          account,
          customerId: "stripe-customer-demo-alex",
          state,
          ...(clientSecret === null ? {} : { clientSecret }),
          paymentMethodId: card === null ? null : paymentMethodId,
        });
      else
        double.seedPayment({
          paymentId: request.paymentId as string,
          account,
          amount: (expected.amount ?? { cents: 2500, currency: "USD" }) as {
            cents: number;
            currency: string;
          },
          state,
          ...(clientSecret === null ? {} : { clientSecret }),
          paymentMethodId: card === null ? null : paymentMethodId,
        });
      actual = double.pageIntent(request) as unknown as Json;
      expect(actual).toEqual(expected);
      break;
    }
    case "savedCard": {
      double.seedCard({
        paymentMethodId: request.paymentMethodId as string,
        account: accountOf(request.account),
        customerId: request.customerId as string,
        ...(expected.result === "card" && expected.card !== null
          ? { card: expected.card as { brand: "visa"; last4: string } }
          : {}),
      });
      if (expected.result === "removed")
        double.removeCard({
          account: request.account,
          customerId: request.customerId,
          paymentMethodId: request.paymentMethodId,
        });
      actual = double.savedCard(request) as unknown as Json;
      expect(actual).toEqual(expected);
      break;
    }
    case "refund": {
      const port = request.port as Json;
      const whole = file === "refund-part.json" ? 5500 : (request.amount as { cents: number }).cents;
      double.seedPayment({
        paymentId: port.paymentId as string,
        account: accountOf(port.account),
        amount: { cents: whole, currency: "USD" },
        state: "succeeded",
        effectId: "eff-the-payment",
        createdAt: "2026-10-01T12:00:00Z",
      });
      actual = double.refund(request) as unknown as Json;
      expect(actual.state).toBe(expected.state);
      expect(actual.paymentId).toBe(expected.paymentId);
      // The refund lists with its own effect id, against the charge it refunds, though that charge is before the window.
      const wide = { account: port.account, from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" };
      const listed = double.listMoney(wide);
      expectExchange("listMoney", wide, listed);
      const refunds = listed.result === "listed" ? listed.items.filter((item) => item.kind === "refund") : [];
      expect(refunds).toMatchObject([
        { effectId: (request.effect as Json).effectId, amount: request.amount },
      ]);
      break;
    }
    case "disputeEvidence": {
      const port = request.port as Json;
      double.seedDispute({
        disputeId: port.disputeId as string,
        account: accountOf(port.account),
        chargeId: "stripe-charge-demo-0010",
        paymentId: "stripe-payment-demo-0010",
        amount: { cents: 3500, currency: "USD" },
        dueBy: expected.dueBy as string,
      });
      actual = double.disputeEvidence(request) as unknown as Json;
      expect(actual.dueBy).toBe(expected.dueBy);
      expect(actual.disputeId).toBe(expected.disputeId);
      break;
    }
    case "listMoney": {
      const account = accountOf(request.account);
      // The window holds the fixture's rows, and more outside it, which the listing leaves out.
      for (const item of expected.items as ListItem[]) double.seedListItem(account, item);
      double.seedListItem(account, {
        kind: "charge",
        stripeId: "stripe-charge-outside-the-window",
        paymentId: null,
        refundOf: null,
        effectId: "eff-outside",
        amount: { cents: 100, currency: "USD" },
        state: "succeeded",
        createdAt: "2020-01-01T00:00:00Z",
      });
      double.seedListItem(ROSFIELD, {
        kind: "charge",
        stripeId: "stripe-charge-on-the-other-account",
        paymentId: null,
        refundOf: null,
        effectId: null,
        amount: { cents: 100, currency: "USD" },
        state: "succeeded",
        createdAt: request.from as string,
      });
      actual = double.listMoney(request) as unknown as Json;
      expect(actual).toEqual(expected);
      break;
    }
    case "doublePlant": {
      actual = double.doublePlant(request) as unknown as Json;
      const planted = actual.item as Json;
      const wanted = expected.item as Json;
      for (const field of ["kind", "refundOf", "effectId", "amount", "state", "createdAt"])
        expect(planted[field], field).toEqual(wanted[field]);
      break;
    }
    default:
      throw new Error(`no run for ${call}`);
  }
  expect(actual.result).toBe(expected.result);
  expectExchange(call, request, actual, fx.given.now);
}

/** The calls the double answers: webhooks are signed in webhooks.test.ts, and spans are the adapter's. */
const DOUBLE_CALLS = new Set([
  "onboardingLink",
  "accountStatus",
  "saveCard",
  "removeCard",
  "charge",
  "payLink",
  "closePayLink",
  "pageIntent",
  "savedCard",
  "refund",
  "disputeEvidence",
  "listMoney",
  "doublePlant",
]);

describe("every accepted K-14 fixture the double answers gives its result", () => {
  const accepted = INDEX.filter(
    (entry) => entry.expect === "accept" && DOUBLE_CALLS.has(entry.def.replace(".exchange", "")),
  );
  it("covers every call but the webhooks and spans", () => {
    expect(new Set(accepted.map((entry) => entry.def.replace(".exchange", "")))).toEqual(DOUBLE_CALLS);
  });
  for (const entry of accepted) {
    it(`gives ${entry.file}'s result`, () => {
      runFixture(entry.file);
    });
  }
});

describe("every refused K-14 fixture is refused", () => {
  const refused = INDEX.filter((entry) => entry.expect === "refuse");

  const REQUEST_FAULTS = [
    "invalid/refuse-card-hold.json",
    "invalid/refuse-charge-without-key.json",
    "invalid/refuse-charge-without-effect-id.json",
    "invalid/refuse-dispute-evidence-without-owner-yes.json",
    "invalid/refuse-monthly-bill-on-business-account.json",
    "invalid/refuse-decimal-amount.json",
  ];
  for (const file of REQUEST_FAULTS) {
    it(`refuses the request of ${file}`, () => {
      const fx = readFixture(file);
      const double = createStripeDouble({ now: () => fx.given.now });
      const port = fx.request.port as Json;
      double.seedCard({
        paymentMethodId: "stripe-card-demo-alex",
        account: SHOP,
        customerId: "stripe-customer-demo-alex",
      });
      double.seedDispute({
        disputeId: (port.disputeId as string | undefined) ?? "stripe-dispute-demo-0001",
        account: SHOP,
        chargeId: "stripe-charge-demo-0010",
        paymentId: null,
        amount: { cents: 3500, currency: "USD" },
        dueBy: "2026-11-06T22:00:00Z",
      });
      const outcome: Json = (fx.call === "charge"
        ? double.charge(fx.request)
        : double.disputeEvidence(fx.request)) as unknown as Json;
      expect(outcome).toMatchObject({
        result: "failed",
        kind: "refused",
        httpStatus: 400,
        code: "parameter_invalid",
      });
      // The request has no shape in the contract, so the answer is checked alone: the call's error, as the schema has it.
      const errors = validator(`${fx.call}.errors`);
      expect(errors(outcome), JSON.stringify(errors.errors)).toBe(true);
      expect(double.rejectedRequests()).toHaveLength(1);
      expect(double.requests()).toHaveLength(0);
      expect(listAll(double)).toEqual([]);
      expect(double.events()).toEqual([]);
      // The fixture's own answer is what the schema refuses (contracts:check proves that; the double never gives it).
      expect(validator(`${fx.call}.exchange`)(fx)).toBe(false);
    });
  }

  it("never answers needsAuthentication to a charge without the person (refuse-off-session-needs-authentication)", () => {
    const fx = readFixture("invalid/refuse-off-session-needs-authentication.json");
    const double = createStripeDouble({ now: () => fx.given.now });
    const port = fx.request.port as Json;
    double.seedCard({
      paymentMethodId: port.paymentMethodId as string,
      account: SHOP,
      customerId: port.customerId as string,
      behavior: "authenticationRequired",
    });
    const outcome = double.charge(fx.request);
    expect(outcome).toMatchObject({
      result: "failed",
      kind: "declined",
      httpStatus: 402,
      declineCode: "authentication_required",
    });
    expectExchange("charge", fx.request, outcome, fx.given.now);
    expect(validator("charge.exchange")(fx)).toBe(false);
  });

  it("never gives the client secret of a card save that succeeded (refuse-page-secret-after-saved)", () => {
    const fx = readFixture("invalid/refuse-page-secret-after-saved.json");
    const double = createStripeDouble({ now: () => fx.given.now });
    const setup = double.saveCard({
      effect: { effectId: "eff-save", idempotencyKey: "eff-save" },
      port: { account: SHOP, customerId: "stripe-customer-demo-alex" },
    });
    if (setup.result !== "ready") throw new Error("no card save");
    double.completeSetup(setup.setupId);
    const outcome = double.pageIntent({ account: SHOP, setupId: setup.setupId });
    expect(outcome).toMatchObject({ result: "intent", state: "succeeded", clientSecret: null });
    expectExchange("pageIntent", { account: SHOP, setupId: setup.setupId }, outcome, fx.given.now);
    expect(validator("pageIntent.exchange")(fx)).toBe(false);
  });

  it("takes the span fixture's refusal on trust: the double writes no span and holds no card detail but brand and last four", () => {
    expect(refused.some((entry) => entry.file === "invalid/refuse-card-in-span.json")).toBe(true);
    const fx = readFixture("invalid/refuse-card-in-span.json");
    expect(validator("span")(fx)).toBe(false);
  });

  it("accounts for every refused fixture in the index", () => {
    const covered = new Set([
      ...REQUEST_FAULTS,
      "invalid/refuse-off-session-needs-authentication.json",
      "invalid/refuse-page-secret-after-saved.json",
      "invalid/refuse-card-in-span.json",
    ]);
    expect(refused.map((entry) => entry.file).sort()).toEqual([...covered].sort());
  });
});

// ---- the proof items of the card ----

describe("every charge and refund made comes back from the list call with its effect id (list-48-hours.json)", () => {
  it("lists charges, a decline and refunds, each with effect id, amount, state and Stripe id", () => {
    const double = withCard();
    double.seedCard({
      paymentMethodId: "stripe-card-demo-declines",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      behavior: "chargeDeclined",
    });
    const deposit = double.charge(chargeRequest("eff-alex-grooms-deposit"));
    const declined = double.charge(
      chargeRequest("eff-alex-grooms-deposit-declined", { card: "stripe-card-demo-declines" }),
    );
    const full = double.charge(chargeRequest("eff-alex-signature-cut-full", { cents: 5500 }));
    expect(deposit.result).toBe("charged");
    expect(declined).toMatchObject({ result: "failed", kind: "declined" });
    if (deposit.result !== "charged" || full.result !== "charged" || declined.result !== "failed")
      throw new Error("unexpected answers");
    const wholeRefund = double.refund({
      effect: {
        effectId: "eff-alex-grooms-deposit-refund",
        idempotencyKey: "eff-alex-grooms-deposit-refund",
      },
      amount: { cents: 4000, currency: "USD" },
      port: { account: SHOP, paymentId: deposit.paymentId, reason: "requestedByCustomer" },
    });
    const partRefund = double.refund({
      effect: { effectId: "eff-alex-part-refund", idempotencyKey: "eff-alex-part-refund" },
      amount: { cents: 2000, currency: "USD" },
      port: { account: SHOP, paymentId: full.paymentId, reason: "requestedByCustomer" },
    });
    expect(wholeRefund.result).toBe("refunded");
    expect(partRefund.result).toBe("refunded");

    const items = listAll(double);
    expect(items).toHaveLength(5);
    const byEffect = new Map(items.map((item) => [item.effectId, item]));
    expect(byEffect.get("eff-alex-grooms-deposit")).toMatchObject({
      kind: "charge",
      stripeId: deposit.chargeId,
      paymentId: deposit.paymentId,
      amount: { cents: 4000, currency: "USD" },
      state: "succeeded",
    });
    // A declined card leaves a failed charge, listed with its effect id (list-48-hours.json).
    expect(byEffect.get("eff-alex-grooms-deposit-declined")).toMatchObject({
      kind: "charge",
      state: "failed",
      paymentId: declined.paymentId,
    });
    expect(byEffect.get("eff-alex-signature-cut-full")).toMatchObject({
      stripeId: full.chargeId,
      state: "succeeded",
    });
    if (wholeRefund.result !== "refunded" || partRefund.result !== "refunded") throw new Error("no refund");
    expect(byEffect.get("eff-alex-grooms-deposit-refund")).toMatchObject({
      kind: "refund",
      stripeId: wholeRefund.refundId,
      refundOf: deposit.chargeId,
      amount: { cents: 4000, currency: "USD" },
      state: "succeeded",
    });
    expect(byEffect.get("eff-alex-part-refund")).toMatchObject({
      kind: "refund",
      stripeId: partRefund.refundId,
      refundOf: full.chargeId,
      amount: { cents: 2000, currency: "USD" },
    });
    expect(items.every((item) => item.effectId !== null)).toBe(true);
  });

  it("lists only the window, the account, and with effectId only that effect's items", () => {
    const clk = clock(START);
    const double = createStripeDouble({ now: clk.now });
    double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
    });
    double.charge(chargeRequest("eff-one"));
    clk.advance(HOUR);
    double.charge(chargeRequest("eff-two"));
    const window = (from: string, to: string, effectId?: string): ListItem[] => {
      const request = { account: SHOP, from, to, ...(effectId === undefined ? {} : { effectId }) };
      const outcome = double.listMoney(request);
      expectExchange("listMoney", request, outcome);
      return outcome.result === "listed" ? outcome.items : [];
    };
    expect(window("2026-11-07T15:00:00Z", "2026-11-07T17:00:00Z").map((i) => i.effectId)).toEqual([
      "eff-one",
      "eff-two",
    ]);
    // The window's start is included, its end left out.
    expect(window("2026-11-07T15:20:00Z", "2026-11-07T16:20:00Z").map((i) => i.effectId)).toEqual([
      "eff-one",
    ]);
    expect(window("2026-11-07T15:00:00Z", "2026-11-07T17:00:00Z", "eff-two").map((i) => i.effectId)).toEqual([
      "eff-two",
    ]);
    expect(window("2026-11-07T17:00:00Z", "2026-11-07T18:00:00Z")).toEqual([]);
    expect(listAll(double, ROSFIELD)).toEqual([]);
  });

  it("plants a charge with no effect id and a double charge, and both come back (CQ-15; S12-26)", () => {
    const double = withCard();
    const first = double.charge(chargeRequest("eff-dee-fee", { cents: 2000 }));
    if (first.result !== "charged") throw new Error("no charge");
    const plantRequest = {
      account: SHOP,
      plant: "secondCharge",
      amount: { cents: 2000, currency: "USD" },
      createdAt: "2026-11-07T16:00:00Z",
      effectId: "eff-dee-fee",
    };
    const second = double.doublePlant(plantRequest);
    expectExchange("doublePlant", plantRequest, second);
    const orphanRequest = {
      account: SHOP,
      plant: "chargeWithoutEffectId",
      amount: { cents: 3500, currency: "USD" },
      createdAt: "2026-11-07T17:00:00Z",
      effectId: null,
    };
    const orphan = double.doublePlant(orphanRequest);
    expectExchange("doublePlant", orphanRequest, orphan);
    const items = listAll(double);
    expect(items.filter((item) => item.effectId === "eff-dee-fee")).toHaveLength(2);
    expect(items.filter((item) => item.effectId === null)).toHaveLength(1);
    if (second.result !== "planted") throw new Error("no plant");
    // Reconciliation refunds the second charge at once, by its payment, with reason duplicate.
    const refund = double.refund({
      effect: { effectId: "eff-reconcile-dee-refund", idempotencyKey: "eff-reconcile-dee-refund" },
      amount: { cents: 2000, currency: "USD" },
      port: { account: SHOP, paymentId: second.item.paymentId ?? "", reason: "duplicate" },
    });
    expect(refund.result).toBe("refunded");
    expect(listAll(double).filter((item) => item.kind === "refund")).toMatchObject([
      { refundOf: second.item.stripeId, effectId: "eff-reconcile-dee-refund" },
    ]);
    expect(first.chargeId).not.toBe(second.item.stripeId);
  });
});

describe("the decline test card declines, and a retry with the same key returns the same decline", () => {
  for (const [name, behavior] of [
    ["pm_card_visa_chargeDeclined", "chargeDeclined"],
    ["pm_card_visa_chargeDeclinedInsufficientFunds", "insufficientFunds"],
    ["pm_card_chargeDeclinedExpiredCard", "expiredCard"],
  ] as const) {
    it(`reads Stripe's published ${name} as ${behavior}`, () => {
      expect(PUBLISHED_TEST_CARDS[name]).toBe(behavior);
      const double = createStripeDouble({ now: () => START });
      double.seedCard({ paymentMethodId: name, account: SHOP, customerId: "stripe-customer-demo-alex" });
      const request = chargeRequest("eff-declined", { card: name });
      const outcome = double.charge(request);
      expect(outcome).toMatchObject({ result: "failed", kind: "declined", httpStatus: 402 });
      expectExchange("charge", request, outcome);
    });
  }

  it("answers the same decline on a retry with the same key, with no second try at Stripe", () => {
    const double = withCard("chargeDeclined");
    const request = chargeRequest("eff-alex-grooms-deposit-declined");
    const first = double.charge(request);
    const again = double.charge(request);
    expect(first).toMatchObject({
      result: "failed",
      kind: "declined",
      httpStatus: 402,
      code: "card_declined",
      declineCode: "generic_decline",
    });
    expect(again).toEqual(first);
    expectExchange("charge", request, again);
    // One failed intent and one failed charge, not two; the card was tried once.
    expect(listAll(double)).toHaveLength(1);
    expect(double.events().filter((event) => event.kind === "paymentFailed")).toHaveLength(1);
    expect(double.requests("charge")).toHaveLength(2);
  });

  it("holds the decline even when the card would now go through, and a new key tries again", () => {
    const double = withCard("chargeDeclined");
    const first = double.charge(chargeRequest("eff-a", { key: "key-a" }));
    double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      behavior: "visa",
    });
    expect(double.charge(chargeRequest("eff-a", { key: "key-a" }))).toEqual(first);
    // Another card is a new effect row with its own key (decline-not-retried.json).
    expect(double.charge(chargeRequest("eff-b", { key: "key-b" })).result).toBe("charged");
    expect(listAll(double).map((item) => [item.effectId, item.state])).toEqual([
      ["eff-a", "failed"],
      ["eff-b", "succeeded"],
    ]);
  });

  it("refuses a repeat of the key with other parameters (idempotency_error), and stores no refusal", () => {
    const double = withCard();
    expect(double.charge(chargeRequest("eff-a", { key: "key-a", cents: 4000 })).result).toBe("charged");
    const changed = double.charge(chargeRequest("eff-a", { key: "key-a", cents: 4100 }));
    expect(changed).toMatchObject({
      result: "failed",
      kind: "refused",
      httpStatus: 400,
      code: "idempotency_error",
    });
    expect(listAll(double)).toHaveLength(1);
    // A request refused in validation is not saved: the key is free for a good request.
    const bad = { ...chargeRequest("eff-c", { key: "key-c" }), amount: { cents: 40.5, currency: "USD" } };
    expect(double.charge(bad)).toMatchObject({ kind: "refused", code: "parameter_invalid" });
    expect(double.charge(chargeRequest("eff-c", { key: "key-c" })).result).toBe("charged");
  });
});

describe("a key lives 24 hours, as Stripe's does (README spike row 7)", () => {
  function lateWorld(): { double: StripeDouble; clk: ReturnType<typeof clock> } {
    const clk = clock(START);
    const double = createStripeDouble({ now: clk.now });
    double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
    });
    return { double, clk };
  }

  it("replays a saved 500 for the same key, and lets it go after 24 hours", () => {
    const { double, clk } = lateWorld();
    double.failNext("charge", { kind: "transient", httpStatus: 500 });
    const request = chargeRequest("eff-ben-no-show-fee", { cents: 2000 });
    const first = double.charge(request);
    expect(first).toMatchObject({ result: "failed", kind: "transient", httpStatus: 500 });
    clk.advance(HOUR);
    // No script is left, but Stripe replays its saved 500 on every repeat in 24 hours.
    expect(double.charge(request)).toEqual(first);
    expect(listAll(double)).toEqual([]);
    clk.advance(KEY_LIFE_MS);
    expect(double.charge(request).result).toBe("charged");
  });

  it("does not save a 409, a 429 or no answer at all, so the retry on the same key goes through", () => {
    const { double } = lateWorld();
    const request = chargeRequest("eff-retry");
    double.failNext("charge", { kind: "transient" });
    double.failNext("charge", { kind: "transient", httpStatus: 429, code: "rate_limit" });
    double.failNext("charge", { kind: "transient", httpStatus: 409, code: "lock_timeout" });
    for (const status of [null, 429, 409]) {
      const outcome = double.charge(request);
      expect(outcome).toMatchObject({ result: "failed", kind: "transient", httpStatus: status });
      expectExchange("charge", request, outcome);
    }
    expect(double.charge(request).result).toBe("charged");
    expect(listAll(double)).toHaveLength(1);
  });

  it("a lost answer inside 24 hours gets the real answer on a retry, charged once", () => {
    const { double, clk } = lateWorld();
    double.failNext("charge", { kind: "transient", answerLost: true });
    const request = chargeRequest("eff-ben-no-show-fee", { cents: 2000 });
    expect(double.charge(request)).toMatchObject({ result: "failed", kind: "transient", httpStatus: null });
    clk.advance(2 * HOUR);
    expect(double.charge(request).result).toBe("charged");
    expect(listAll(double)).toHaveLength(1);
  });

  it("a late run without the look-up charges twice: the double charge reconciliation exists for", () => {
    const { double, clk } = lateWorld();
    double.failNext("charge", { kind: "transient", answerLost: true });
    const request = chargeRequest("eff-ben-no-show-fee", { cents: 2000 });
    double.charge(request);
    clk.advance(25 * HOUR + 50 * 60 * 1000);
    expect(double.charge(request).result).toBe("charged");
    const items = listAll(double);
    expect(items.filter((item) => item.effectId === "eff-ben-no-show-fee")).toHaveLength(2);
  });

  it("a try more than 23 hours after the effect row first lists by effect id, and takes the charge found (look-up-before-late-try.json)", () => {
    const { double, clk } = lateWorld();
    double.failNext("charge", { kind: "transient", answerLost: true });
    const request = chargeRequest("eff-ben-no-show-fee", { cents: 2000 });
    const rowWrittenAt = clk.now();
    double.charge(request);
    clk.advance(25 * HOUR + 50 * 60 * 1000);

    // The effects runner's rule (README 'Effects', 'A try past 23 hours'), run against the double.
    const lateTry = (): { sent: boolean; found: ListItem | undefined } => {
      const look = {
        account: SHOP,
        from: rowWrittenAt,
        to: clk.now(),
        effectId: "eff-ben-no-show-fee",
      };
      const listed = double.listMoney(look);
      expectExchange("listMoney", look, listed);
      if (listed.result !== "listed") throw new Error("the look-up failed");
      const found = listed.items.find((item) => item.kind === "charge" && item.state !== "failed");
      if (found !== undefined) return { sent: false, found };
      double.charge(request);
      return { sent: true, found: undefined };
    };
    const outcome = lateTry();
    expect(outcome.sent).toBe(false);
    expect(outcome.found).toMatchObject({ state: "succeeded", amount: { cents: 2000, currency: "USD" } });
    // Nothing was sent: one charge under the effect id, and the last request is the look-up's, not a second charge.
    expect(listAll(double)).toHaveLength(1);
    expect(double.requests("charge")).toHaveLength(1);
  });
});

describe("charge in test-card terms", () => {
  it("charges the default card at once, lists it, and sends paymentSucceeded with the paying card", () => {
    const double = withCard();
    const request = chargeRequest("eff-alex-grooms-deposit");
    const outcome = double.charge(request);
    expectExchange("charge", request, outcome);
    expect(outcome).toMatchObject({ result: "charged", card: { brand: "visa", last4: "4242" } });
    const events = double.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "paymentSucceeded",
      stripeType: "payment_intent.succeeded",
      effectId: "eff-alex-grooms-deposit",
      testMode: true,
      account: SHOP,
      payload: { amount: { cents: 4000, currency: "USD" }, paymentMethodId: "stripe-card-demo-alex" },
    });
    for (const event of events) expectEvent(event);
  });

  it("answers needsAuthentication only with the person present, and waits for their bank's check", () => {
    const double = withCard("authenticationRequired");
    const present = chargeRequest("eff-present", { present: true, cents: 5500 });
    const outcome = double.charge(present);
    expectExchange("charge", present, outcome);
    expect(outcome.result).toBe("needsAuthentication");
    if (outcome.result !== "needsAuthentication") throw new Error("no check");
    // Nothing is charged until the check: no charge listed, and the page reads the payment with its secret.
    expect(listAll(double)).toEqual([]);
    const page = double.pageIntent({ account: SHOP, paymentId: outcome.paymentId });
    expect(page).toMatchObject({ state: "needsAuthentication", clientSecret: outcome.clientSecret });
    expectExchange("pageIntent", { account: SHOP, paymentId: outcome.paymentId }, page);
    const events = double.completeAuthentication(outcome.paymentId, true);
    expect(events.map((event) => event.kind)).toEqual(["paymentSucceeded"]);
    expect(listAll(double)).toMatchObject([{ state: "succeeded", effectId: "eff-present" }]);
    expect(double.pageIntent({ account: SHOP, paymentId: outcome.paymentId })).toMatchObject({
      state: "succeeded",
      clientSecret: null,
      card: { brand: "visa", last4: "4242" },
    });
  });

  it("a failed check is a payment that failed, and the intent waits for another card", () => {
    const double = withCard("authenticationRequired");
    const outcome = double.charge(chargeRequest("eff-present", { present: true }));
    if (outcome.result !== "needsAuthentication") throw new Error("no check");
    const events = double.completeAuthentication(outcome.paymentId, false);
    expect(events.map((event) => event.kind)).toEqual(["paymentFailed"]);
    expect(listAll(double)).toMatchObject([{ state: "failed" }]);
    expect(double.pageIntent({ account: SHOP, paymentId: outcome.paymentId })).toMatchObject({
      state: "needsCard",
    });
  });

  it("turns the bank's ask into a decline without the person (authentication_required)", () => {
    const double = withCard("authenticationRequired");
    const request = chargeRequest("eff-absent", { present: false });
    const outcome = double.charge(request);
    expectExchange("charge", request, outcome);
    expect(outcome).toMatchObject({
      kind: "declined",
      code: "authentication_required",
      declineCode: "authentication_required",
    });
  });

  it("refuses a card that is not on that customer, or was removed", () => {
    const double = withCard();
    const strange = double.charge(chargeRequest("eff-x", { card: "stripe-card-demo-nobody" }));
    expect(strange).toMatchObject({
      result: "failed",
      kind: "refused",
      httpStatus: 400,
      code: "resource_missing",
    });
    expectExchange("charge", chargeRequest("eff-x", { card: "stripe-card-demo-nobody" }), strange);
    const removal = {
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      paymentMethodId: "stripe-card-demo-alex",
    };
    expect(double.removeCard(removal).result).toBe("removed");
    expect(double.removeCard(removal).result).toBe("alreadyRemoved");
    expect(double.charge(chargeRequest("eff-y"))).toMatchObject({
      kind: "refused",
      code: "resource_missing",
    });
    expect(double.savedCard(removal)).toEqual({
      result: "removed",
      paymentMethodId: "stripe-card-demo-alex",
    });
  });

  it("charges Rosfield's monthly bill on Rosfield's own account, and nowhere else", () => {
    const double = createStripeDouble({ now: () => START });
    const save = double.saveCard({
      effect: { effectId: "eff-sam-bill-card", idempotencyKey: "eff-sam-bill-card" },
      port: { account: ROSFIELD, customerId: null },
    });
    if (save.result !== "ready") throw new Error("no card save");
    const saved = double.completeSetup(save.setupId, { paymentMethodId: "stripe-card-demo-sam-lee-1" });
    expect(saved.map((event) => event.kind)).toEqual(["cardSaved", "cardDetails"]);
    expect(saved.every((event) => event.account.kind === "rosfield")).toBe(true);
    for (const event of saved) expectEvent(event);
    const bill = {
      effect: { effectId: "eff-bill-2026-10", idempotencyKey: "eff-bill-2026-10" },
      amount: { cents: 200, currency: "USD" },
      port: {
        account: ROSFIELD,
        purpose: "rosfieldMonthlyBill",
        customerId: save.customerId,
        paymentMethodId: "stripe-card-demo-sam-lee-1",
        customerPresent: false,
        description: "Rosfield: October",
      },
    };
    const outcome = double.charge(bill);
    expectExchange("charge", bill, outcome);
    expect(outcome.result).toBe("charged");
    expect(listAll(double, ROSFIELD)).toMatchObject([{ effectId: "eff-bill-2026-10", state: "succeeded" }]);
    expect(listAll(double, SHOP)).toEqual([]);
    // The bill's card as the monthly bill shows it.
    const card = double.savedCard({
      account: ROSFIELD,
      customerId: save.customerId,
      paymentMethodId: "stripe-card-demo-sam-lee-1",
    });
    expect(card).toEqual({
      result: "card",
      paymentMethodId: "stripe-card-demo-sam-lee-1",
      card: { brand: "visa", last4: "4242" },
    });
    expect(double.charge({ ...bill, port: { ...bill.port, account: SHOP } })).toMatchObject({
      kind: "refused",
    });
  });

  it("refuses every call on an account that disconnected", () => {
    const double = withCard();
    double.disconnectAccount("stripe-acct-demo-lees-barbershop");
    const outcome = double.charge(chargeRequest("eff-gone"));
    expect(outcome).toMatchObject({
      result: "failed",
      kind: "refused",
      httpStatus: 403,
      code: "account_invalid",
    });
    expectExchange("charge", chargeRequest("eff-gone"), outcome);
    expect(double.accountStatus({ accountId: "stripe-acct-demo-lees-barbershop" })).toMatchObject({
      result: "disconnected",
    });
    expect(double.events().map((event) => event.kind)).toEqual(["accountDisconnected"]);
  });

  it("a scripted decline makes a real failed intent and charge, in any card's terms", () => {
    const double = withCard();
    double.failNext("charge", { kind: "declined", declineCode: "insufficient_funds" });
    const outcome = double.charge(chargeRequest("eff-scripted"));
    expect(outcome).toMatchObject({ kind: "declined", declineCode: "insufficient_funds" });
    expect(listAll(double)).toMatchObject([{ state: "failed", effectId: "eff-scripted" }]);
  });

  it("scripts a failure only for the account and call named, a number of times", () => {
    const double = createStripeDouble({ now: () => START });
    double.failNext(
      "accountStatus",
      { kind: "refused", httpStatus: 404, code: "resource_missing" },
      { times: 2 },
    );
    for (let i = 0; i < 2; i += 1)
      expect(double.accountStatus({ accountId: "stripe-acct-demo-a" })).toMatchObject({
        kind: "refused",
        httpStatus: 404,
      });
    expect(double.accountStatus({ accountId: "stripe-acct-demo-a" }).result).toBe("status");
    double.failNext("listMoney", { kind: "transient", httpStatus: 503 }, { account: ROSFIELD });
    expect(listAll(double, SHOP)).toEqual([]);
    expect(
      double.listMoney({ account: ROSFIELD, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" }),
    ).toMatchObject({ kind: "transient", httpStatus: 503 });
  });
});

describe("card saves, pay links, the pages' reads and closing", () => {
  it("saves a card: ready with a secret, the page reads it, cardSaved and cardDetails follow, the secret goes", () => {
    const double = createStripeDouble({ now: () => START });
    const request = {
      effect: { effectId: "eff-alex-haircut-save-card", idempotencyKey: "eff-alex-haircut-save-card" },
      port: { account: SHOP, customerId: null },
    };
    const ready = double.saveCard(request);
    expectExchange("saveCard", request, ready);
    if (ready.result !== "ready") throw new Error("no card save");
    expect(double.saveCard(request)).toEqual(ready);
    const read = double.pageIntent({ account: SHOP, setupId: ready.setupId });
    expect(read).toMatchObject({ state: "needsCard", clientSecret: ready.clientSecret, card: null });
    expectExchange("pageIntent", { account: SHOP, setupId: ready.setupId }, read);
    // Another business's account never reads it.
    expect(
      double.pageIntent({
        account: { kind: "business", accountId: "stripe-acct-demo-other" },
        setupId: ready.setupId,
      }),
    ).toMatchObject({
      kind: "refused",
      httpStatus: 404,
    });
    const events = double.completeSetup(ready.setupId, { card: { brand: "visa", last4: "4242" } });
    expect(events.map((event) => [event.kind, event.effectId])).toEqual([
      ["cardSaved", "eff-alex-haircut-save-card"],
      ["cardDetails", null],
    ]);
    for (const event of events) expectEvent(event);
    expect(double.pageIntent({ account: SHOP, setupId: ready.setupId })).toMatchObject({
      state: "succeeded",
      clientSecret: null,
      card: { brand: "visa", last4: "4242" },
    });
  });

  it("a card the bank refuses at setup sends cardSaveFailed and leaves the page waiting for another card", () => {
    const double = createStripeDouble({ now: () => START });
    const ready = double.saveCard({
      effect: { effectId: "eff-save", idempotencyKey: "eff-save" },
      port: { account: SHOP, customerId: "stripe-customer-demo-alex" },
    });
    if (ready.result !== "ready") throw new Error("no card save");
    const events = double.completeSetup(ready.setupId, {
      refuse: { code: "card_declined", declineCode: "generic_decline" },
    });
    expect(events.map((event) => event.kind)).toEqual(["cardSaveFailed"]);
    expectEvent(at(events, 0));
    expect(double.pageIntent({ account: SHOP, setupId: ready.setupId })).toMatchObject({
      state: "needsCard",
    });
  });

  it("a pay link: declined on the page, paid with another card that is then saved, never a second link", () => {
    const double = createStripeDouble({ now: () => START });
    const request = {
      effect: {
        effectId: "eff-alex-color-correction-pay-link",
        idempotencyKey: "eff-alex-color-correction-pay-link",
      },
      amount: { cents: 2500, currency: "USD" },
      port: {
        account: SHOP,
        purpose: "deposit",
        customerId: "stripe-customer-demo-alex",
        saveCardForLater: true,
        description: "Lee's Barbershop: Color correction deposit",
      },
    };
    const link = double.payLink(request);
    expectExchange("payLink", request, link);
    if (link.result !== "created") throw new Error("no link");
    expect(double.payLink(request)).toEqual(link);
    expect(double.requests("payLink")).toHaveLength(2);

    const page = double.pageIntent({ account: SHOP, paymentId: link.paymentId });
    expect(page).toMatchObject({
      state: "needsCard",
      clientSecret: link.clientSecret,
      amount: { cents: 2500, currency: "USD" },
      card: null,
    });
    expectExchange("pageIntent", { account: SHOP, paymentId: link.paymentId }, page);

    const declined = double.payOnPage(link.paymentId, {
      behavior: "chargeDeclined",
      card: { brand: "visa", last4: "0002" },
    });
    expect(declined.result).toBe("declined");
    expect(declined.events.map((event) => event.kind)).toEqual(["paymentFailed"]);
    expect(double.pageIntent({ account: SHOP, paymentId: link.paymentId })).toMatchObject({
      state: "needsCard",
    });

    const paid = double.payOnPage(link.paymentId, { card: { brand: "visa", last4: "4242" } });
    expect(paid.result).toBe("paid");
    expect(paid.events.map((event) => event.kind)).toEqual(["paymentSucceeded", "cardDetails"]);
    for (const event of paid.events) expectEvent(event);
    const succeeded = at(paid.events, 0);
    // The card that paid is the one named, never the one declined before.
    expect(succeeded.payload.paymentMethodId).toBe(paid.paymentMethodId);
    expect(succeeded.payload.paymentMethodId).not.toBe(declined.paymentMethodId);
    expect(paid.events[1]?.payload).toMatchObject({
      paymentMethodId: paid.paymentMethodId,
      customerId: "stripe-customer-demo-alex",
    });

    const done = double.pageIntent({ account: SHOP, paymentId: link.paymentId });
    expect(done).toMatchObject({
      state: "succeeded",
      clientSecret: null,
      card: { brand: "visa", last4: "4242" },
    });
    expectExchange("pageIntent", { account: SHOP, paymentId: link.paymentId }, done);
    const closed = double.closePayLink({ account: SHOP, paymentId: link.paymentId });
    expect(closed).toMatchObject({ result: "alreadyPaid", paidAt: START });
    expectExchange("closePayLink", { account: SHOP, paymentId: link.paymentId }, closed);
    expect(listAll(double).map((item) => [item.state, item.effectId])).toEqual([
      ["failed", "eff-alex-color-correction-pay-link"],
      ["succeeded", "eff-alex-color-correction-pay-link"],
    ]);
    expect(
      double.savedCard({
        account: SHOP,
        customerId: "stripe-customer-demo-alex",
        paymentMethodId: paid.paymentMethodId,
      }),
    ).toMatchObject({
      result: "card",
      card: { brand: "visa", last4: "4242" },
    });
  });

  it("closing an unpaid pay link cancels it: no secret, no later payment, closed again is alreadyClosed", () => {
    const double = createStripeDouble({ now: () => START });
    const link = double.payLink({
      effect: { effectId: "eff-ben-pay-link", idempotencyKey: "eff-ben-pay-link" },
      amount: { cents: 2500, currency: "USD" },
      port: {
        account: SHOP,
        purpose: "deposit",
        customerId: null,
        saveCardForLater: false,
        description: "Deposit",
      },
    });
    if (link.result !== "created") throw new Error("no link");
    const close = { account: SHOP, paymentId: link.paymentId };
    const closed = double.closePayLink(close);
    expect(closed).toMatchObject({ result: "closed", paidAt: null });
    expectExchange("closePayLink", close, closed);
    expect(double.closePayLink(close)).toMatchObject({ result: "alreadyClosed" });
    expect(double.events().map((event) => event.kind)).toEqual(["paymentCanceled"]);
    expectEvent(at(double.events(), 0));
    expect(double.pageIntent({ account: SHOP, paymentId: link.paymentId })).toMatchObject({
      state: "canceled",
      clientSecret: null,
    });
    expect(() => double.payOnPage(link.paymentId)).toThrow();
    expect(double.closePayLink({ account: SHOP, paymentId: "stripe-payment-demo-nobody" })).toMatchObject({
      kind: "refused",
      httpStatus: 404,
    });
  });

  it("a card the network replaced shows its new last four and sends cardReplaced", () => {
    const double = withCard();
    const event = double.networkReplaceCard("stripe-card-demo-alex", { brand: "visa", last4: "5556" });
    expectEvent(event);
    expect(event).toMatchObject({
      kind: "cardReplaced",
      stripeType: "payment_method.automatically_updated",
      effectId: null,
    });
    const request = {
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      paymentMethodId: "stripe-card-demo-alex",
    };
    const outcome = double.savedCard(request);
    expectExchange("savedCard", request, outcome);
    expect(outcome).toMatchObject({ result: "card", card: { brand: "visa", last4: "5556" } });
  });

  it("reports an account's state, its changes and a failed payout", () => {
    const double = createStripeDouble({ now: () => START });
    double.setAccountState("stripe-acct-demo-a", {
      canPayOut: false,
      infoDue: true,
      infoDueBy: "2026-11-20T00:00:00Z",
    });
    const status = double.accountStatus({ accountId: "stripe-acct-demo-a" });
    expectExchange("accountStatus", { accountId: "stripe-acct-demo-a" }, status);
    expect(status).toMatchObject({ result: "status", state: { canPayOut: false, infoDue: true } });
    double.failPayout("stripe-acct-demo-a", { cents: 4000, currency: "USD" });
    const events = double.events();
    expect(events.map((event) => event.kind)).toEqual(["accountUpdated", "payoutFailed"]);
    for (const event of events) expectEvent(event);
  });

  it("onboards an account once per key, and a second ask reuses the account with a fresh link", () => {
    const double = createStripeDouble({ now: () => START });
    const first = {
      accountId: null,
      businessName: "Lee's Barbershop",
      returnUrl: "https://example.com/pay/s02",
      refreshUrl: "https://example.com/pay/s02/refresh",
      idempotencyKey: "onboard-business-lee",
    };
    const link = double.onboardingLink(first);
    expectExchange("onboardingLink", first, link);
    expect(double.onboardingLink(first)).toEqual(link);
    if (link.result !== "link") throw new Error("no link");
    const second = { ...first, accountId: link.accountId, idempotencyKey: "onboard-business-lee-2" };
    const again = double.onboardingLink(second);
    expectExchange("onboardingLink", second, again);
    expect(again).toMatchObject({ result: "link", accountId: link.accountId, accountCreated: false });
  });
});

describe("refunds and disputes", () => {
  function paid(): { double: StripeDouble; paymentId: string } {
    const double = withCard();
    const outcome = double.charge(chargeRequest("eff-paid", { cents: 5500 }));
    if (outcome.result !== "charged") throw new Error("no charge");
    return { double, paymentId: outcome.paymentId };
  }
  const refundOf = (paymentId: string, cents: number, key: string): Json => ({
    effect: { effectId: key, idempotencyKey: key },
    amount: { cents, currency: "USD" },
    port: { account: SHOP, paymentId, reason: "requestedByCustomer" },
  });

  it("refunds in parts up to what is left, then refuses more", () => {
    const { double, paymentId } = paid();
    const part = refundOf(paymentId, 2000, "eff-r1");
    const outcome = double.refund(part);
    expectExchange("refund", part, outcome);
    expect(outcome).toMatchObject({ result: "refunded", state: "succeeded", paymentId });
    expect(double.refund(part)).toEqual(outcome);
    expect(double.refund(refundOf(paymentId, 3600, "eff-r2"))).toMatchObject({
      kind: "refused",
      code: "charge_already_refunded",
    });
    expect(double.refund(refundOf(paymentId, 3500, "eff-r3")).result).toBe("refunded");
    expect(double.refund(refundOf(paymentId, 100, "eff-r4"))).toMatchObject({ kind: "refused" });
    expect(listAll(double).filter((item) => item.kind === "refund")).toHaveLength(2);
    expect(double.events().filter((event) => event.kind === "refundChanged")).toHaveLength(2);
    expect(double.refund(refundOf("stripe-payment-demo-nobody", 100, "eff-r5"))).toMatchObject({
      httpStatus: 404,
    });
    expect(double.refund(refundOf(paymentId, 100, "eff-r6"))).toMatchObject({ result: "failed" });
  });

  it("refuses an amount above the payment on the first refund", () => {
    const { double, paymentId } = paid();
    expect(double.refund(refundOf(paymentId, 5600, "eff-big"))).toMatchObject({
      kind: "refused",
      code: "amount_too_large",
    });
  });

  it("pm_card_refundFail: the refund succeeds and then fails, in the events and in the listing", () => {
    const double = withCard("refundFail");
    const outcome = double.charge(chargeRequest("eff-rf"));
    if (outcome.result !== "charged") throw new Error("no charge");
    const refund = double.refund(refundOf(outcome.paymentId, 4000, "eff-rf-refund"));
    expect(refund.result).toBe("refunded");
    const changes = double.events().filter((event) => event.kind === "refundChanged");
    expect(changes.map((event) => [event.stripeType, (event.payload as Json).state])).toEqual([
      ["refund.created", "succeeded"],
      ["refund.failed", "failed"],
    ]);
    for (const event of changes) expectEvent(event);
    expect(listAll(double).filter((item) => item.kind === "refund")).toMatchObject([{ state: "failed" }]);
    // A failed refund leaves the payment whole, so the money can be refunded again.
    expect(double.refund(refundOf(outcome.paymentId, 4000, "eff-rf-again")).result).toBe("refunded");
  });

  it("pm_card_createDispute: a dispute opens, blocks a refund, takes the owner's evidence once, and closes", () => {
    const double = withCard("createDispute");
    const outcome = double.charge(chargeRequest("eff-disputed", { cents: 3500 }));
    if (outcome.result !== "charged") throw new Error("no charge");
    const opened = double.events().find((event) => event.kind === "disputeOpened");
    if (opened === undefined) throw new Error("no dispute");
    expectEvent(opened);
    const disputeId = opened.payload.disputeId as string;
    expect(opened.payload).toMatchObject({ chargeId: outcome.chargeId, paymentId: outcome.paymentId });
    expect(double.refund(refundOf(outcome.paymentId, 3500, "eff-no"))).toMatchObject({
      kind: "refused",
      code: "charge_disputed",
    });

    const evidence = (key: string): Json => ({
      effect: { effectId: key, idempotencyKey: key },
      port: {
        account: SHOP,
        disputeId,
        ownerYes: OWNER_YES,
        serviceDate: "2026-10-24",
        serviceDescription: "Haircut with Riley",
        customerName: "Alex M.",
        recordFileId: "file-dispute-record-alex-2026-10-24",
      },
    });
    const sent = double.disputeEvidence(evidence("eff-evidence"));
    expectExchange("disputeEvidence", evidence("eff-evidence"), sent);
    expect(sent).toMatchObject({ result: "submitted", disputeId });
    // The same key answers the same; Stripe takes the evidence once, so another key is refused.
    expect(double.disputeEvidence(evidence("eff-evidence"))).toEqual(sent);
    expect(double.disputeEvidence(evidence("eff-evidence-again"))).toMatchObject({
      kind: "refused",
      code: "dispute_evidence_already_submitted",
    });
    const closed = double.closeDispute(disputeId, "businessWon");
    expectEvent(closed);
    expect(closed.payload).toMatchObject({ outcome: "businessWon" });
  });

  it("refuses evidence past the bank's deadline, and for a dispute that is not on the account", () => {
    const clk = clock(START);
    const double = createStripeDouble({ now: clk.now });
    double.seedDispute({
      disputeId: "stripe-dispute-demo-0001",
      account: SHOP,
      chargeId: "stripe-charge-demo-0010",
      paymentId: null,
      amount: { cents: 3500, currency: "USD" },
      dueBy: "2026-11-08T00:00:00Z",
    });
    const request = (disputeId: string, account: Account): Json => ({
      effect: { effectId: "eff-ev", idempotencyKey: `key-${disputeId}-${JSON.stringify(account)}` },
      port: {
        account,
        disputeId,
        ownerYes: OWNER_YES,
        serviceDate: "2026-10-24",
        serviceDescription: "Visit",
        customerName: "Alex M.",
        recordFileId: "file-record",
      },
    });
    expect(
      double.disputeEvidence(
        request("stripe-dispute-demo-0001", { kind: "business", accountId: "stripe-acct-demo-other" }),
      ),
    ).toMatchObject({ httpStatus: 404 });
    expect(double.disputeEvidence(request("stripe-dispute-demo-nobody", SHOP))).toMatchObject({
      httpStatus: 404,
    });
    clk.advance(10 * 24 * HOUR);
    expect(double.disputeEvidence(request("stripe-dispute-demo-0001", SHOP))).toMatchObject({
      code: "dispute_evidence_past_due",
    });
  });
});

describe("what leaves the double", () => {
  it("holds no card detail but brand and last four, no number, no key", () => {
    const double = withCard("createDispute");
    double.charge(chargeRequest("eff-1"));
    const save = double.saveCard({
      effect: { effectId: "eff-2", idempotencyKey: "eff-2" },
      port: { account: SHOP, customerId: null },
    });
    if (save.result === "ready") double.completeSetup(save.setupId);
    const everything = JSON.stringify([double.events(), double.requests(), listAll(double)]);
    expect(everything).not.toMatch(/[0-9]([ -]?[0-9]){12,}/);
    expect(everything).not.toMatch(/"(number|cvc|exp_month|exp_year|fingerprint)"/);
    expect(everything).not.toMatch(/sk_(live|test)_|whsec_|pk_(live|test)_/);
    for (const event of double.events()) {
      const card = (event.payload as Json).card;
      if (card !== undefined) expect(Object.keys(card as Json).sort()).toEqual(["brand", "last4"]);
    }
  });

  it("forgets everything on reset", () => {
    const double = withCard();
    double.charge(chargeRequest("eff-1"));
    double.failNext("charge", { kind: "transient" });
    double.reset();
    expect(double.events()).toEqual([]);
    expect(double.requests()).toEqual([]);
    expect(listAll(double)).toEqual([]);
    double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
    });
    expect(double.charge(chargeRequest("eff-1")).result).toBe("charged");
  });
});
