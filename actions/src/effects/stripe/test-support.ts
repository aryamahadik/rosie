// Doubles and rows for the Stripe effect kinds' tests (T-326), never imported by the kinds themselves:
//   - K-14 v1's schema (one strict Ajv 2020-12 setup holding it and every frozen file its $refs reach), so every request
//     the kinds build and every answer the double gives is held to the contract;
//   - effect rows from the contracts' own fixtures: K-07 v1's effect rows with K-14 v1's port requests for the same
//     effect (K-14 README open gap 7: K-07's v1 fixtures hold placeholder portRequests; the effects runner writes K-14's
//     shapes), and K-14's exchanges made rows (the master's sample cast and the demo shops: rule 9);
//   - the Stripe double (adapters/src/stripe/double, T-422) seeded with those fixtures' saved cards, as the port;
//   - a harness: the effects runner (T-323) with the fake clock and the fake repo with K-05 v1.1's claim semantics, and
//     the Stripe kinds on the double.

import { readFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { createStripeDouble, type StripeDouble } from "../../../../adapters/src/stripe/double";
import type { Account } from "../../../../adapters/src/stripe/double";
import type { Span } from "../../../../runtime/src/trace";
import { CONTRACTS_DIR, formatProblems, loadToolApiSchemas } from "../../tool-api/validator";
import type { EffectRow, KindPorts } from "../kinds";
import {
  createEffectsRunner,
  type EffectsRunner,
  type EffectsRunnerDeps,
  type SpanRefusedReport,
} from "../runner";
import { FakeClock, FakeEffectRepo, fixtureEffect, spanRecorder } from "../runner/test-support";
import { createStripeKinds } from "./stripe-kinds";
import type { StripeEffectPort, StripeKind } from "./port";

// ---- K-14 v1 on disk ------------------------------------------------------------------------------------------------

const K14_ID = "https://rosie.invalid/contracts/port-stripe/port-stripe.v1.schema.json";

export function readStripeJson(file: string): unknown {
  return JSON.parse(
    readFileSync(path.join(CONTRACTS_DIR, "port-stripe", "fixtures", ...file.split("/")), "utf8"),
  ) as unknown;
}

/** One K-14 v1 exchange fixture. */
export interface Exchange {
  call: string;
  given: { now: string; note: string };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

export const readExchange = (file: string): Exchange => readStripeJson(file) as Exchange;

export interface IndexEntry {
  file: string;
  def: string;
  expect: "accept" | "refuse";
}

/** K-14 v1's fixture index. */
export const STRIPE_INDEX: readonly IndexEntry[] = (
  readStripeJson("index.json") as { fixtures: IndexEntry[] }
).fixtures;

let k14Check: ((definition: string, value: unknown) => string[]) | undefined;

/** Problems K-14 v1 finds in `value` against `$defs/<definition>`; empty when it is accepted. */
export function k14(definition: string, value: unknown): string[] {
  if (k14Check === undefined) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const schema of loadToolApiSchemas()) ajv.addSchema(schema);
    ajv.addSchema(
      JSON.parse(
        readFileSync(path.join(CONTRACTS_DIR, "port-stripe", "port-stripe.v1.schema.json"), "utf8"),
      ) as object,
    );
    k14Check = (def, data) => {
      const validate = ajv.getSchema(`${K14_ID}#/$defs/${def}`);
      if (validate === undefined) throw new Error(`K-14 v1 has no definition ${def}`);
      return validate(data) ? [] : formatProblems(validate.errors);
    };
  }
  return k14Check(definition, value);
}

// ---- the demo shops' accounts and cards (K-14 v1's fixtures) ---------------------------------------------------------

export const SHOP: Account = { kind: "business", accountId: "stripe-acct-demo-lees-barbershop" };
export const YOGA: Account = { kind: "business", accountId: "stripe-acct-demo-yoga-studio" };
export const ROSFIELD: Account = { kind: "rosfield" };

/** The double with the saved cards K-14 v1's charge fixtures name, all Stripe's default test card unless told. */
export function stripeDouble(clock: FakeClock): StripeDouble {
  const double = createStripeDouble({ now: () => clock.nowUtc() });
  double.seedCard({
    paymentMethodId: "stripe-card-demo-alex",
    account: SHOP,
    customerId: "stripe-customer-demo-alex",
  });
  double.seedCard({
    paymentMethodId: "stripe-card-demo-alex-yoga-studio",
    account: YOGA,
    customerId: "stripe-customer-demo-alex-yoga-studio",
  });
  double.seedCard({
    paymentMethodId: "stripe-card-demo-sam-lee-1",
    account: ROSFIELD,
    customerId: "stripe-customer-demo-sam-lee",
  });
  return double;
}

/** The double as the kinds' port: its calls are K-14 v1's, by the same names. */
export const portOf = (double: StripeDouble): StripeEffectPort => double;

// ---- effect rows ----------------------------------------------------------------------------------------------------

/** A K-07 v1 effect fixture's row with the port request K-14 v1's exchange for the same effect sends. */
export function rowWithPort(effectFile: string, exchangeFile: string): EffectRow {
  const effect = fixtureEffect(`outbox-effects/fixtures/${effectFile}`);
  const exchange = readExchange(exchangeFile);
  return { ...effect, portRequest: structuredClone(exchange.request.port) as EffectRow["portRequest"] };
}

/** Alex's $40 Groom's package deposit: K-07 v1 effect-charge.json's row, with K-14 v1 deposit.json's port request. */
export const depositRow = (): EffectRow => rowWithPort("effect-charge.json", "deposit.json");

/** The same deposit declined: K-07 v1 effect-charge-declined.json, with K-14 v1 decline-not-retried.json's port. */
export const declinedDepositRow = (): EffectRow =>
  rowWithPort("effect-charge-declined.json", "decline-not-retried.json");

/** Alex's deposit refunded: K-07 v1 effect-refund.json, refunding the PaymentIntent the deposit's charge made. */
export function refundRow(paymentId: string): EffectRow {
  const effect = fixtureEffect("outbox-effects/fixtures/effect-refund.json");
  return {
    ...effect,
    portRequest: { account: SHOP, paymentId, reason: "requestedByCustomer" },
  };
}

const KIND_OF_CALL: Readonly<Record<string, StripeKind>> = {
  saveCard: "stripe_save_card",
  charge: "stripe_charge",
  payLink: "stripe_pay_link",
  refund: "stripe_refund",
  disputeEvidence: "stripe_dispute_evidence",
};

/**
 * A K-14 v1 exchange made the effect row it runs from: its effect id and key, its amount and its port request, with the
 * kind its call runs as (a charge for Rosfield's monthly bill is rosfield_monthly_charge, written by the billing job).
 * A refused fixture's missing effect id or key is an empty one, which K-07 v1 refuses too.
 */
export function rowFromExchange(file: string): EffectRow {
  const { call, request } = readExchange(file);
  const effect = request.effect as { effectId?: string; idempotencyKey?: string };
  const effectId = effect.effectId ?? "";
  const port = structuredClone(request.port) as EffectRow["portRequest"];
  const bill = port.purpose === "rosfieldMonthlyBill";
  const kind: StripeKind = call === "charge" && bill ? "rosfield_monthly_charge" : must(KIND_OF_CALL[call]);
  const byJob = kind === "rosfield_monthly_charge";
  return {
    effectId,
    turnId: byJob ? null : `turn-${effectId || "unnamed"}`,
    jobId: byJob ? "job-monthly-billing" : null,
    businessId: "biz-lees-barbershop",
    bookingId: null,
    kind,
    port: "stripe",
    calendarProvider: null,
    visitId: null,
    personId: null,
    handleId: null,
    amount: (request.amount ?? null) as EffectRow["amount"],
    portRequest: port,
    idempotencyKey: effect.idempotencyKey ?? "",
    state: "pending",
    tries: 0,
    runs: 1,
    firstTryAt: null,
    providerObjectId: null,
    errorCode: null,
    ledgerLineId: null,
    traceId: `trace-${effectId || "unnamed"}`,
  };
}

export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

// ---- the harness ----------------------------------------------------------------------------------------------------

export interface StripeHarness {
  readonly clock: FakeClock;
  readonly repo: FakeEffectRepo;
  readonly double: StripeDouble;
  readonly spans: Span[];
  /** Spans the trace refused (K-08 v1): none, in every test. */
  readonly refusedSpans: SpanRefusedReport[];
  /** When each row was written (K-07 effects.created_at), as the caller of the kinds reads it. */
  readonly written: Map<string, string>;
  /** The Stripe kinds on the double, with `written` as writtenAtOf. */
  readonly kinds: KindPorts;
  /** Writes a row as the commit writes it (pending), at the clock's time unless told. */
  commit(row: EffectRow, at?: string): void;
  runner(claimer?: string, extra?: Partial<EffectsRunnerDeps>): EffectsRunner;
}

export function stripeHarness(start: string): StripeHarness {
  const clock = new FakeClock(start);
  const repo = new FakeEffectRepo();
  const double = stripeDouble(clock);
  const { spans, traceOf } = spanRecorder(clock);
  const refusedSpans: SpanRefusedReport[] = [];
  const written = new Map<string, string>();
  const kinds: KindPorts = createStripeKinds({
    port: portOf(double),
    writtenAtOf: (effect) => Promise.resolve(written.get(effect.effectId) ?? null),
    now: () => clock.now(),
  });
  return {
    clock,
    repo,
    double,
    spans,
    refusedSpans,
    written,
    kinds,
    commit: (row, at = clock.nowUtc()) => {
      repo.seed(row, at);
      written.set(row.effectId, at);
    },
    runner: (claimer = "effects-runner-1", extra = {}) =>
      createEffectsRunner({
        claimer,
        repo,
        kinds,
        traceOf,
        clock,
        zoneOf: () => Promise.resolve("America/New_York"),
        onSpanRefused: (report) => {
          refusedSpans.push(report);
        },
        ...extra,
      }),
  };
}
