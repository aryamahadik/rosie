// The Stripe effect kinds' proofs (T-326, "Proves it with"): the effects runner of T-323, with its fake clock and its fake
// repo with K-05 v1.1's claim semantics, runs Stripe effect rows through these kinds, and the Stripe double of T-422
// (no network, no key, no money) is the port:
//   1. effect-charge.json charges once on the Stripe double;
//   2. effect-charge-declined.json is recorded with no retry;
//   3. hard invariant, no charge without a clear yes: the runner only runs charge rows written by a committed turn and
//      never builds a charge itself;
//   4. one key charges at most once on the double even when the row is claimed twice;
//   5. a card hold request cannot be built (refuse-card-hold.json);
//   6. the double's list call returns every charge with the effect id it was made under.
// Then each Stripe kind, the late try's look-up (K-14 README 'A try past 23 hours'), the try's signal and what leaves a
// try. Every request the kinds send passes K-14 v1's schema, every K-05 request K-05 v1.1's (the fake repo refuses any
// other), every row's life K-07 v1's effectLife and lifeChain, and every span K-08 v1's.

import { describe, expect, it } from "vitest";

import type { Account, ListItem } from "../../../../adapters/src/stripe/double";
import type { EffectRow, KindAnswer, KindCall } from "../kinds";
import { EFFECT_TRIES, type ClaimedEffect } from "../runner";
import { contractChecks, k07Rules, readContractJson, type FakeEffectRepo } from "../runner/test-support";
import { STRIPE_KINDS, type StripeEffectPort } from "./port";
import { buildStripeRequest } from "./request";
import { ABORTED, createStripeKinds } from "./stripe-kinds";
import {
  ROSFIELD,
  SHOP,
  YOGA,
  declinedDepositRow,
  depositRow,
  k14,
  must,
  portOf,
  readExchange,
  refundRow,
  rowFromExchange,
  rowWithPort,
  stripeDouble,
  stripeHarness,
  type StripeHarness,
} from "./test-support";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ms = (instant: string): number => Date.parse(instant);
const utc = (epoch: number): string => new Date(epoch).toISOString().replace(".000Z", "Z");

/** K-07 v1 effect-charge.json's commit and claim. */
const DEPOSIT_COMMITTED = "2026-11-07T15:20:00Z";
const DEPOSIT_CLAIMED = "2026-11-07T15:20:01Z";

/** Every charge and refund the double made on an account between two times (its list call). */
function listed(h: StripeHarness, account: Account, from: string, to: string, effectId?: string): ListItem[] {
  const outcome = h.double.listMoney({ account, from, to, ...(effectId === undefined ? {} : { effectId }) });
  if (outcome.result !== "listed") throw new Error("the double did not list");
  return outcome.items;
}

interface Moves {
  moves: { from: string | null; to: string; by: string; tryOutcome: string | null }[];
}

/** A life's moves, as K-07 v1's fixtures write them, without their times and notes. */
const movesIn = (life: Moves): unknown[] =>
  life.moves.map(({ from, to, by, tryOutcome }) => ({ from, to, by, tryOutcome }));

const movesOf = (repo: FakeEffectRepo, effectId: string): unknown[] => movesIn(repo.life(effectId) as Moves);

const fixtureMoves = (file: string): unknown[] => movesIn(readContractJson(file) as Moves);

async function expectLifeAccepted(repo: FakeEffectRepo, effectId: string): Promise<void> {
  const life = repo.life(effectId);
  expect(contractChecks().k07("effectLife", life)).toEqual([]);
  const { lifeChain } = await k07Rules();
  expect(lifeChain(life)).toEqual([]);
}

/** Every request the double took passes K-14 v1's schema, and every span K-08 v1's, holding no private value. */
function expectCleanRun(h: StripeHarness, privateValues: readonly string[] = []): void {
  for (const { call, request } of h.double.requests()) expect(k14(`${call}.request`, request)).toEqual([]);
  expect(h.double.rejectedRequests()).toEqual([]);
  expect(h.refusedSpans).toEqual([]);
  for (const span of h.spans) expect(contractChecks().span(span)).toEqual([]);
  const recorded = JSON.stringify([h.spans, h.repo.results, h.repo.entries]);
  for (const value of ["demo-client-secret", "4242", "visa", ...privateValues])
    expect(recorded).not.toContain(value);
}

/** One try handed straight to a kind's port, as the runner hands it. */
function tryOf(effect: EffectRow, at: number, signal = new AbortController().signal): KindCall {
  return { effect, idempotencyKey: effect.idempotencyKey, attempt: 1, answerBy: utc(at + 30_000), signal };
}

// ---- 1 -------------------------------------------------------------------------------------------------------------

describe("1. effect-charge.json charges once on the Stripe double", () => {
  it("claims the committed deposit, charges it once on its one key, and records the PaymentIntent", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);

    const report = await h.clock.drive(h.runner().runDue());

    expect(report).toEqual({
      claim: "claimed",
      ports: ["stripe"],
      rows: [{ effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 1 }],
    });
    // One charge request, exactly K-14 v1 deposit.json's: the row's effect id, key, amount and port request.
    expect(h.double.requests()).toEqual([{ call: "charge", request: readExchange("deposit.json").request }]);
    const items = listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z");
    expect(items).toEqual([
      {
        kind: "charge",
        stripeId: "stripe-charge-double-0001",
        paymentId: "stripe-payment-double-0001",
        refundOf: null,
        effectId: row.effectId,
        amount: { cents: 4000, currency: "USD" },
        state: "succeeded",
        createdAt: DEPOSIT_CLAIMED,
      },
    ]);
    // Recorded with the PaymentIntent (K-14 default 7) and no ledger line (answer.ts default 5).
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      tries: 1,
      runs: 1,
      firstTryAt: DEPOSIT_CLAIMED,
      providerObjectId: "stripe-payment-double-0001",
      errorCode: null,
      ledgerLineId: null,
    });
    expect(movesOf(h.repo, row.effectId)).toEqual(fixtureMoves("outbox-effects/fixtures/effect-charge.json"));
    await expectLifeAccepted(h.repo, row.effectId);
    expect(h.spans.map((span) => [span.hop, span.provider, span.call, span.attempt, span.outcome])).toEqual([
      ["effectRun", "stripe", "charge", 1, "ok"],
    ]);
    expectCleanRun(h, ["4000", "Groom", "stripe-customer-demo-alex", "stripe-card-demo-alex"]);

    // Once: an hour later nothing is claimed and nothing more is charged.
    await h.clock.advanceTo(ms(DEPOSIT_CLAIMED) + HOUR);
    expect((await h.clock.drive(h.runner().runDue())).rows).toEqual([]);
    expect(h.double.requests("charge")).toHaveLength(1);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T17:00:00Z")).toHaveLength(1);
  });
});

// ---- 2 -------------------------------------------------------------------------------------------------------------

describe("2. effect-charge-declined.json is recorded with no retry", () => {
  it("records the declined deposit once, card_declined, and never tries it again", async () => {
    const committed = "2026-11-07T15:30:00Z";
    const claimed = "2026-11-07T15:30:01Z";
    const h = stripeHarness(claimed);
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      behavior: "chargeDeclined",
    });
    const row = declinedDepositRow();
    h.commit(row, committed);

    const report = await h.clock.drive(h.runner().runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "declined", refusal: null, calls: 1 },
    ]);
    expect(h.double.requests()).toEqual([
      { call: "charge", request: readExchange("decline-not-retried.json").request },
    ]);
    expect(h.repo.results.map((result) => result.request)).toMatchObject([
      { outcome: "declined", errorCode: "card_declined", providerObjectId: null, nextTryAt: null },
    ]);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "declined",
      tries: 1,
      errorCode: "card_declined",
      providerObjectId: null,
      ledgerLineId: null,
    });
    expect(movesOf(h.repo, row.effectId)).toEqual(
      fixtureMoves("outbox-effects/fixtures/effect-charge-declined.json"),
    );
    await expectLifeAccepted(h.repo, row.effectId);
    // The decline leaves a failed charge, listed with its effect id (K-14 list-48-hours.json).
    expect(listed(h, SHOP, committed, "2026-11-07T16:00:00Z")).toMatchObject([
      { kind: "charge", effectId: row.effectId, state: "failed", amount: { cents: 4000, currency: "USD" } },
    ]);
    expectCleanRun(h);

    // Never again: not an hour later, not once the card would go through.
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
    });
    await h.clock.advanceTo(ms(claimed) + HOUR);
    expect((await h.clock.drive(h.runner().runDue())).rows).toEqual([]);
    expect((await h.clock.drive(h.runner("effects-runner-2").runDue())).rows).toEqual([]);
    expect(h.double.requests("charge")).toHaveLength(1);
    expect(h.repo.results).toHaveLength(1);
  });

  it("records the bank's ask without the person present as a decline, authentication_required, never retried", async () => {
    const h = stripeHarness("2026-11-05T19:30:01Z");
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      behavior: "authenticationRequired",
    });
    const row = rowFromExchange("charge-at-owner-ok.json");
    h.commit(row);
    const report = await h.clock.drive(h.runner().runDue());
    expect(must(report.rows[0]).end).toBe("declined");
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "declined",
      errorCode: "authentication_required",
    });
    expect(h.double.requests("charge")).toHaveLength(1);
  });
});

// ---- 3 -------------------------------------------------------------------------------------------------------------

describe("3. hard invariant: the runner only runs charge rows written by a committed turn and never builds a charge", () => {
  it("charges nothing when no turn committed a charge", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const report = await h.clock.drive(h.runner().runDue());
    expect(report).toEqual({ claim: "claimed", ports: ["stripe"], rows: [] });
    expect(h.double.requests()).toEqual([]);
  });

  it("never claims a charge row that already ended or waits for Stripe: succeeded, declined, let go, outage", async () => {
    const h = stripeHarness("2026-11-08T12:00:00Z");
    const base = depositRow();
    const states = ["succeeded", "declined", "cancelled", "outage"] as const;
    for (const state of states) {
      const row = { ...base, effectId: `${base.effectId}-${state}`, idempotencyKey: `key-${state}`, state };
      h.repo.put(
        { row, version: 3, claimedBy: null, claimLapsesAt: null, lastTryAt: DEPOSIT_CLAIMED },
        DEPOSIT_COMMITTED,
      );
    }
    const report = await h.clock.drive(h.runner().runDue());
    expect(report.rows).toEqual([]);
    expect(h.double.requests()).toEqual([]);
  });

  it("refuses a charge row another runner holds, and calls nothing", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row: EffectRow = {
      ...depositRow(),
      state: "running",
      tries: 0,
      runs: 1,
      firstTryAt: DEPOSIT_CLAIMED,
    };
    const claimed: ClaimedEffect = {
      effect: row as ClaimedEffect["effect"],
      version: 2,
      claimedFrom: "pending",
      claimedBy: "effects-runner-2",
      claimLapsesAt: "2026-11-07T15:21:01Z",
    };
    const rows = await h.clock.drive(h.runner("effects-runner-1").run([claimed]));
    expect(rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "refused", refusal: "notOurs", calls: 0 },
    ]);
    expect(h.double.requests()).toEqual([]);
  });

  it("sends each committed charge exactly as its row holds it: its key, its amount, its card; nothing computed", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const rows = [
      "deposit.json",
      "full-price.json",
      "off-session-at-done.json",
      "charge-at-owner-ok.json",
    ].map(rowFromExchange);
    for (const row of rows) h.commit(row, DEPOSIT_COMMITTED);
    const report = await h.clock.drive(h.runner().runDue());
    expect(report.rows.map((row) => row.end)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    const sent = h.double.requests("charge").map((entry) => entry.request);
    expect(sent).toHaveLength(rows.length);
    for (const row of rows) {
      expect(sent).toContainEqual({
        effect: { effectId: row.effectId, idempotencyKey: row.idempotencyKey },
        amount: row.amount,
        port: row.portRequest,
      });
      expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z", row.effectId)).toMatchObject([
        { kind: "charge", effectId: row.effectId, amount: row.amount, state: "succeeded" },
      ]);
    }
    expectCleanRun(h);
  });

  it("never sends a committed charge that lacks what its call needs, and never fills it in", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const base = depositRow();
    const noCard = { ...base.portRequest };
    delete noCard.paymentMethodId;
    const row = { ...base, portRequest: noCard };
    h.commit(row, DEPOSIT_COMMITTED);

    const report = await h.clock.drive(h.runner().runDue());

    // Each of the run's 5 tries is refused before any call, so the row ends in Stripe's outage row the team sees.
    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "outage", refusal: null, calls: EFFECT_TRIES },
    ]);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "outage",
      errorCode: "request_invalid:port.paymentMethodId",
    });
    expect(h.double.requests()).toEqual([]);
    expect(h.double.rejectedRequests()).toEqual([]);

    // A charge with no amount is never given one (K-07 v1's table refuses such a row; the kind refuses it too).
    const kinds = createStripeKinds({ port: portOf(h.double), writtenAtOf: () => Promise.resolve(null) });
    const answer = await kinds.stripe_charge.run(
      tryOf({ ...base, amount: null, state: "running", firstTryAt: DEPOSIT_CLAIMED }, ms(DEPOSIT_CLAIMED)),
    );
    expect(answer).toEqual({
      outcome: "networkError",
      errorCode: "request_invalid:amount",
      retryAfterMs: null,
    });
    expect(h.double.requests()).toEqual([]);
  });

  it("gives the runner only the six kinds' ports, each running only the row it is handed", () => {
    const kinds = createStripeKinds({
      port: portOf(stripeDouble(stripeHarness(DEPOSIT_CLAIMED).clock)),
      writtenAtOf: () => Promise.resolve(null),
    });
    expect(Object.keys(kinds)).toEqual([...STRIPE_KINDS]);
    for (const port of Object.values(kinds)) expect(Object.keys(port)).toEqual(["run"]);
  });

  it("runs a row only on its own kind's port and only on its own key", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row: EffectRow = { ...depositRow(), state: "running", firstTryAt: DEPOSIT_CLAIMED };
    const wrongPort = await h.kinds.stripe_refund?.run(tryOf(row, ms(DEPOSIT_CLAIMED)));
    expect(wrongPort).toEqual({
      outcome: "networkError",
      errorCode: "request_invalid:kind",
      retryAfterMs: null,
    });
    const otherKey = await h.kinds.stripe_charge?.run({
      ...tryOf(row, ms(DEPOSIT_CLAIMED)),
      idempotencyKey: "other",
    });
    expect(otherKey).toEqual({
      outcome: "networkError",
      errorCode: "request_invalid:effect.idempotencyKey",
      retryAfterMs: null,
    });
    expect(h.double.requests()).toEqual([]);
  });
});

// ---- 4 -------------------------------------------------------------------------------------------------------------

describe("4. one key charges at most once on the double, even when the row is claimed twice", () => {
  it("a try whose answer was lost goes again on the same key and gets the first charge back", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    h.double.failNext("charge", { kind: "transient", answerLost: true });
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);

    const report = await h.clock.drive(h.runner().runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 2 },
    ]);
    const sent = h.double.requests("charge");
    expect(sent).toHaveLength(2);
    expect(must(sent[1]).request).toEqual(must(sent[0]).request);
    expect(h.repo.results.map((result) => [result.request.outcome, result.request.errorCode])).toEqual([
      ["networkError", "network"],
      ["ok", null],
    ]);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z")).toHaveLength(1);
    await expectLifeAccepted(h.repo, row.effectId);
    expectCleanRun(h);
  });

  it("a row claimed again by a second runner, after the first runner's result was lost, charges once", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);
    // Runner 1 charges, but every send of its result is lost: its claim lapses with the row still running.
    h.repo.answerNextResults(
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
    );
    const first = await h.clock.drive(h.runner("effects-runner-1").runDue());
    expect(first.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "transient", refusal: null, calls: 1 },
    ]);

    await h.clock.advanceTo(ms(DEPOSIT_CLAIMED) + MINUTE + 1000);
    const second = await h.clock.drive(h.runner("effects-runner-2").runDue());

    expect(second.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 1 },
    ]);
    expect(
      h.repo.claims.map((claim) =>
        "error" in claim.answer ? [] : claim.answer.claimed.map((c) => c.claimedFrom),
      ),
    ).toEqual([["pending"], ["running"]]);
    const sent = h.double.requests("charge");
    expect(sent).toHaveLength(2);
    expect(must(sent[1]).request).toEqual(must(sent[0]).request);
    const items = listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z");
    expect(items).toHaveLength(1);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      providerObjectId: must(items[0]).paymentId,
    });
    expectCleanRun(h);
  });

  it("the same claim handed to a runner twice calls Stripe once", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);
    const claim = await h.repo.claimEffects({ claimer: "effects-runner-1", now: DEPOSIT_CLAIMED, limit: 10 });
    if ("error" in claim) throw new Error("the claim failed");
    const runner = h.runner("effects-runner-1");
    const once = await h.clock.drive(runner.run(claim.claimed));
    const twice = await h.clock.drive(runner.run(claim.claimed));
    expect(once.map((report) => report.end)).toEqual(["succeeded"]);
    expect(twice.map((report) => report.end)).toEqual(["repeat"]);
    expect(h.double.requests("charge")).toHaveLength(1);
  });

  it("a row claimed again after Stripe has let its key go looks its effect id up and charges nothing twice", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);
    h.repo.answerNextResults(
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
    );
    await h.clock.drive(h.runner("effects-runner-1").runDue());

    // Every runner is down for 25 hours 50 minutes; Stripe keeps a key 24 hours (the double lets it go then).
    const later = ms(DEPOSIT_CLAIMED) + 25 * HOUR + 50 * MINUTE;
    await h.clock.advanceTo(later);
    const report = await h.clock.drive(h.runner("effects-runner-2").runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 1 },
    ]);
    expect(h.double.requests("listMoney")).toEqual([
      {
        call: "listMoney",
        request: { account: SHOP, from: DEPOSIT_COMMITTED, to: utc(later), effectId: row.effectId },
      },
    ]);
    expect(h.double.requests("charge")).toHaveLength(1);
    const items = listed(h, SHOP, DEPOSIT_COMMITTED, utc(later + 1000));
    expect(items).toHaveLength(1);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      providerObjectId: must(items[0]).paymentId,
    });
  });
});

// ---- 5 -------------------------------------------------------------------------------------------------------------

describe("5. a card hold request cannot be built (refuse-card-hold.json)", () => {
  it("builds no request from a row that asks for a hold: K-14 refuses the request it would be", () => {
    const row = rowWithPort("effect-charge.json", "invalid/refuse-card-hold.json");
    expect(k14("charge.exchange", readExchange("invalid/refuse-card-hold.json"))).not.toEqual([]);
    expect(buildStripeRequest(row)).toEqual({ ok: false, faults: ["port.captureMethod"] });
  });

  it("never sends it: each try is refused before any call, and the row ends in the outage row the team sees", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const row = rowWithPort("effect-charge.json", "invalid/refuse-card-hold.json");
    h.commit(row, DEPOSIT_COMMITTED);

    const report = await h.clock.drive(h.runner().runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "outage", refusal: null, calls: EFFECT_TRIES },
    ]);
    expect(h.double.requests()).toEqual([]);
    expect(h.double.rejectedRequests()).toEqual([]);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z")).toEqual([]);
    expect(h.repo.results.map((result) => result.request.errorCode)).toEqual(
      Array<string>(EFFECT_TRIES).fill("request_invalid:port.captureMethod"),
    );
    expect(h.repo.held(row.effectId).row).toMatchObject({ state: "outage", providerObjectId: null });
    await expectLifeAccepted(h.repo, row.effectId);
    expectCleanRun(h);
  });
});

// ---- 6 -------------------------------------------------------------------------------------------------------------

describe("6. the double's list call returns every charge with the effect id it was made under", () => {
  it("lists every charge, decline and refund the kinds made, each under its own row's effect id", async () => {
    const start = "2026-11-07T15:20:00Z";
    const h = stripeHarness(start);
    const charges = [
      "deposit.json",
      "full-price.json",
      "charge-at-owner-ok.json",
      "off-session-at-done.json",
      "pack-purchase.json",
      "monthly-charge.json",
    ].map(rowFromExchange);
    const others = ["save-card.json", "charge-failed-pay-link.json"].map(rowFromExchange);
    for (const row of [...charges, ...others]) h.commit(row);
    const first = await h.clock.drive(h.runner().runDue());
    expect(first.rows.map((row) => row.end)).toEqual(Array<string>(8).fill("succeeded"));

    // A declined deposit on a card that now declines, then the first deposit refunded.
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-alex",
      account: SHOP,
      customerId: "stripe-customer-demo-alex",
      behavior: "chargeDeclined",
    });
    const declined = declinedDepositRow();
    h.commit(declined);
    expect((await h.clock.drive(h.runner().runDue())).rows.map((row) => row.end)).toEqual(["declined"]);
    const deposit = must(charges[0]);
    const depositPayment = must(h.repo.held(deposit.effectId).row.providerObjectId);
    const refund = refundRow(depositPayment);
    h.commit(refund);
    expect((await h.clock.drive(h.runner().runDue())).rows.map((row) => row.end)).toEqual(["succeeded"]);

    const to = utc(h.clock.now() + MINUTE);
    const all = [SHOP, YOGA, ROSFIELD].flatMap((account) => listed(h, account, start, to));
    // Every item carries the effect id it was made under; each charge row has exactly one charge, with its amount.
    expect(all.every((item) => item.effectId !== null)).toBe(true);
    for (const row of charges) {
      const mine = all.filter((item) => item.effectId === row.effectId);
      expect(mine).toMatchObject([{ kind: "charge", state: "succeeded", amount: row.amount }]);
      expect(h.repo.held(row.effectId).row.providerObjectId).toBe(must(mine[0]).paymentId);
    }
    expect(all.filter((item) => item.effectId === declined.effectId)).toMatchObject([
      { kind: "charge", state: "failed", amount: declined.amount },
    ]);
    const depositCharge = must(all.find((item) => item.effectId === deposit.effectId));
    expect(all.filter((item) => item.effectId === refund.effectId)).toEqual([
      {
        kind: "refund",
        stripeId: must(h.repo.held(refund.effectId).row.providerObjectId),
        paymentId: depositPayment,
        refundOf: depositCharge.stripeId,
        effectId: refund.effectId,
        amount: { cents: 4000, currency: "USD" },
        state: "succeeded",
        createdAt: h.clock.nowUtc(),
      },
    ]);
    // A card save and an unpaid pay link take no money, so nothing is listed under them.
    expect(all.filter((item) => others.some((row) => row.effectId === item.effectId))).toEqual([]);
    expect(all).toHaveLength(charges.length + 2);
    // With an effect id, the list call gives only that effect's items (the effects runner's look-up).
    expect(listed(h, SHOP, start, to, deposit.effectId)).toEqual([depositCharge]);
    expectCleanRun(h, ["Alex M.", "4000"]);
  });

  it("puts the effect id on what a card save and a pay link make: the saved card's and the paid link's events", async () => {
    const h = stripeHarness("2026-11-06T15:00:01Z");
    const save = rowFromExchange("save-card.json");
    const link = rowFromExchange("charge-failed-pay-link.json");
    h.commit(save);
    h.commit(link);
    await h.clock.drive(h.runner().runDue());
    const setupId = must(h.repo.held(save.effectId).row.providerObjectId);
    const paymentId = must(h.repo.held(link.effectId).row.providerObjectId);

    const saved = h.double.completeSetup(setupId);
    expect(saved.find((event) => event.kind === "cardSaved")).toMatchObject({ effectId: save.effectId });
    const paid = h.double.payOnPage(paymentId);
    expect(paid.result).toBe("paid");
    expect(paid.events.find((event) => event.kind === "paymentSucceeded")).toMatchObject({
      effectId: link.effectId,
    });
    expect(listed(h, SHOP, "2026-11-06T15:00:00Z", "2026-11-06T16:00:00Z", link.effectId)).toMatchObject([
      { kind: "charge", paymentId, state: "succeeded", amount: link.amount },
    ]);
  });
});

// ---- each Stripe kind ------------------------------------------------------------------------------------------------

describe("each Stripe kind runs its K-14 v1 call and records what K-14 says", () => {
  async function runOne(
    file: string,
    start: string,
    prepare?: (h: StripeHarness) => void,
  ): Promise<StripeHarness> {
    const h = stripeHarness(start);
    prepare?.(h);
    h.commit(rowFromExchange(file));
    await h.clock.drive(h.runner().runDue());
    return h;
  }

  it("saves a card: the SetupIntent is recorded, its client secret never kept (save-card.json, bill-card.json)", async () => {
    for (const file of ["save-card.json", "bill-card.json"]) {
      const h = await runOne(file, readExchange(file).given.now);
      const row = rowFromExchange(file);
      expect(h.double.requests()).toEqual([{ call: "saveCard", request: readExchange(file).request }]);
      expect(h.repo.held(row.effectId).row).toMatchObject({
        state: "succeeded",
        providerObjectId: "stripe-setup-double-0001",
      });
      await expectLifeAccepted(h.repo, row.effectId);
      expectCleanRun(h);
    }
  });

  it("makes a pay link: the PaymentIntent is recorded (charge-failed-pay-link.json, bill-pay-link.json)", async () => {
    for (const file of ["charge-failed-pay-link.json", "bill-pay-link.json"]) {
      const h = await runOne(file, readExchange(file).given.now);
      const row = rowFromExchange(file);
      expect(h.double.requests()).toEqual([{ call: "payLink", request: readExchange(file).request }]);
      expect(h.repo.held(row.effectId).row).toMatchObject({
        state: "succeeded",
        providerObjectId: "stripe-payment-double-0001",
      });
      expectCleanRun(h);
    }
  });

  it("charges Rosfield's monthly bill on Rosfield's own account (monthly-charge.json)", async () => {
    const file = "monthly-charge.json";
    const h = await runOne(file, readExchange(file).given.now);
    const row = rowFromExchange(file);
    expect(row.kind).toBe("rosfield_monthly_charge");
    expect(h.double.requests()).toEqual([{ call: "charge", request: readExchange(file).request }]);
    expect(h.repo.held(row.effectId).row.state).toBe("succeeded");
    expect(listed(h, ROSFIELD, "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z", row.effectId)).toHaveLength(1);
  });

  it("records a charge waiting on the person's bank check as ok, with no ledger line (needs-authentication.json)", async () => {
    const file = "needs-authentication.json";
    const h = await runOne(file, readExchange(file).given.now, (world) => {
      world.double.seedCard({
        paymentMethodId: "stripe-card-demo-alex-yoga-studio",
        account: YOGA,
        customerId: "stripe-customer-demo-alex-yoga-studio",
        behavior: "authenticationRequired",
      });
    });
    const row = rowFromExchange(file);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      providerObjectId: "stripe-payment-double-0001",
      ledgerLineId: null,
    });
    // Nothing was taken yet: no succeeded charge is listed until the bank's check passes.
    expect(listed(h, YOGA, "2026-11-01T00:00:00Z", "2026-11-30T00:00:00Z")).toEqual([]);
    expectCleanRun(h);
  });

  it("refunds a payment and records the refund (refund-part.json's $20 of the $55 full price)", async () => {
    const h = stripeHarness("2026-11-07T16:10:01Z");
    const full = rowFromExchange("full-price.json");
    h.commit(full);
    await h.clock.drive(h.runner().runDue());
    const payment = must(h.repo.held(full.effectId).row.providerObjectId);
    const part = rowFromExchange("refund-part.json");
    const refund = { ...part, portRequest: { ...part.portRequest, paymentId: payment } };
    h.commit(refund);
    await h.clock.drive(h.runner().runDue());
    expect(h.repo.held(refund.effectId).row).toMatchObject({
      state: "succeeded",
      providerObjectId: "stripe-refund-double-0001",
    });
    expect(listed(h, SHOP, "2026-11-07T16:00:00Z", "2026-11-07T17:00:00Z", refund.effectId)).toMatchObject([
      { kind: "refund", paymentId: payment, amount: { cents: 2000, currency: "USD" }, state: "succeeded" },
    ]);
    expectCleanRun(h);
  });

  it("sends dispute evidence on the owner's yes, once, and records the dispute (dispute-evidence-owner-yes.json)", async () => {
    const file = "dispute-evidence-owner-yes.json";
    const h = await runOne(file, readExchange(file).given.now, (world) => {
      world.double.seedDispute({
        disputeId: "stripe-dispute-demo-0001",
        account: SHOP,
        chargeId: "stripe-charge-demo-0010",
        paymentId: "stripe-payment-demo-0010",
        amount: { cents: 3500, currency: "USD" },
        dueBy: "2026-11-06T22:00:00Z",
      });
    });
    const row = rowFromExchange(file);
    expect(h.double.requests()).toEqual([{ call: "disputeEvidence", request: readExchange(file).request }]);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      providerObjectId: "stripe-dispute-demo-0001",
    });
    expectCleanRun(h, ["Alex M.", "Haircut with Riley", "file-dispute-record"]);
  });

  it("tries a network error again on the same key and charges once (charge-network-error.json, then off-session-at-done.json)", async () => {
    const file = "off-session-at-done.json";
    const h = await runOne(file, "2026-10-24T18:45:01Z", (world) => {
      world.double.failNext("charge", { kind: "transient" });
    });
    const row = rowFromExchange(file);
    expect(h.repo.results.map((result) => [result.request.outcome, result.request.errorCode])).toEqual([
      ["networkError", "network"],
      ["ok", null],
    ]);
    expect(h.double.requests("charge").map((entry) => entry.request)).toEqual([
      readExchange(file).request,
      readExchange(file).request,
    ]);
    expect(listed(h, SHOP, "2026-10-24T00:00:00Z", "2026-10-25T00:00:00Z", row.effectId)).toHaveLength(1);
    await expectLifeAccepted(h.repo, row.effectId);
  });

  it("ends 5 network errors in 10 minutes in Stripe's outage row, with no charge (Stripe answering 503)", async () => {
    const h = await runOne("deposit.json", DEPOSIT_CLAIMED, (world) => {
      world.double.failNext("charge", { kind: "transient", httpStatus: 503 });
    });
    const row = rowFromExchange("deposit.json");
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "outage",
      tries: EFFECT_TRIES,
      errorCode: "503",
    });
    expect(h.double.requests("charge")).toHaveLength(EFFECT_TRIES);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z")).toEqual([]);
    await expectLifeAccepted(h.repo, row.effectId);
  });

  it("records a refused charge (a removed card) as a network error, never a decline, and charges nothing", async () => {
    const h = await runOne("deposit.json", DEPOSIT_CLAIMED, (world) => {
      world.double.removeCard({
        account: SHOP,
        customerId: "stripe-customer-demo-alex",
        paymentMethodId: "stripe-card-demo-alex",
      });
    });
    const row = rowFromExchange("deposit.json");
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "outage",
      errorCode: "refused:resource_missing",
    });
    expect(h.repo.results.every((result) => result.request.outcome === "networkError")).toBe(true);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z")).toEqual([]);
  });
});

// ---- a late try ----------------------------------------------------------------------------------------------------

describe("a charge or refund tried more than 23 hours after its row was written looks its effect id up first", () => {
  const WRITTEN = "2026-10-27T18:10:00Z";
  const TRY_1 = "2026-10-27T18:10:02Z";
  const BACK = "2026-10-28T20:00:01Z";
  const benFee = (): EffectRow => ({
    ...rowFromExchange("deposit.json"),
    effectId: "eff-ben-no-show-fee",
    idempotencyKey: "eff-ben-no-show-fee",
    turnId: "turn-sam-ok-ben-fee",
    bookingId: "booking-ben-haircut-riley",
    amount: { cents: 2000, currency: "USD" },
    portRequest: {
      account: SHOP,
      purpose: "fee",
      customerId: "stripe-customer-demo-ben",
      paymentMethodId: "stripe-card-demo-ben",
      customerPresent: false,
      description: "Lee's Barbershop: no-show fee, Tue Oct 27",
    },
  });

  /** Ben's fee, charged at try 1 whose answer was lost, then Stripe down; at BACK serviceBack hands it over again. */
  async function afterOutage(prepare?: (h: StripeHarness, request: unknown) => void): Promise<{
    h: StripeHarness;
    rows: Awaited<ReturnType<ReturnType<StripeHarness["runner"]>["run"]>>;
    row: EffectRow;
  }> {
    const h = stripeHarness(TRY_1);
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-ben",
      account: SHOP,
      customerId: "stripe-customer-demo-ben",
    });
    const base = benFee();
    h.written.set(base.effectId, WRITTEN);
    const built = buildStripeRequest(base);
    if (!built.ok) throw new Error("Ben's fee builds");
    prepare?.(h, built.built.request);
    await h.clock.advanceTo(ms(BACK));
    const row: EffectRow = {
      ...base,
      state: "running",
      tries: 0,
      runs: 2,
      firstTryAt: BACK,
      errorCode: "network",
    };
    const claimLapsesAt = utc(ms(BACK) + MINUTE);
    h.repo.put(
      { row, version: 8, claimedBy: "effects-runner-1", claimLapsesAt, lastTryAt: "2026-10-27T18:18:02Z" },
      WRITTEN,
    );
    const claimed: ClaimedEffect = {
      effect: row as ClaimedEffect["effect"],
      version: 8,
      claimedFrom: "outage",
      claimedBy: "effects-runner-1",
      claimLapsesAt,
    };
    const rows = await h.clock.drive(h.runner("effects-runner-1").run([claimed]));
    return { h, rows, row };
  }

  it("finds the charge try 1 made and takes it as the result, with no second charge (look-up-before-late-try.json)", async () => {
    const { h, rows, row } = await afterOutage((world, request) => {
      world.double.failNext("charge", { kind: "transient", answerLost: true });
      world.double.charge(request);
    });
    expect(rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 1 },
    ]);
    // The look-up is exactly K-14 v1's fixture: the effect's account, from when the row was written, to now, by effect id.
    expect(h.double.requests("listMoney")).toEqual([
      { call: "listMoney", request: readExchange("look-up-before-late-try.json").request },
    ]);
    expect(h.double.requests("charge")).toHaveLength(1);
    const items = listed(h, SHOP, WRITTEN, utc(ms(BACK) + 1000));
    expect(items).toMatchObject([{ effectId: row.effectId, state: "succeeded", createdAt: TRY_1 }]);
    expect(h.repo.held(row.effectId).row).toMatchObject({
      state: "succeeded",
      runs: 2,
      tries: 1,
      providerObjectId: must(items[0]).paymentId,
    });
    expectCleanRun(h);
  });

  it("finds only a failed charge: a decline on that try, recorded declined, card_declined, nothing sent", async () => {
    const { h, rows, row } = await afterOutage((world, request) => {
      world.double.failNext("charge", { kind: "declined" });
      world.double.charge(request);
    });
    expect(rows).toMatchObject([{ effectId: row.effectId, end: "declined", calls: 1 }]);
    expect(h.repo.held(row.effectId).row).toMatchObject({ state: "declined", errorCode: "card_declined" });
    expect(h.double.requests("charge")).toHaveLength(1);
  });

  it("finds nothing: the try goes on the effect's one key, and Stripe charges once", async () => {
    const { h, rows, row } = await afterOutage();
    expect(rows).toMatchObject([{ effectId: row.effectId, end: "succeeded", calls: 1 }]);
    expect(h.double.requests().map((entry) => entry.call)).toEqual(["listMoney", "charge"]);
    expect(listed(h, SHOP, WRITTEN, utc(ms(BACK) + 1000))).toHaveLength(1);
  });

  it("makes a failed look-up that try's failure: nothing is sent, and it is tried again", async () => {
    const { h, rows, row } = await afterOutage((world) => {
      world.double.failNext("listMoney", { kind: "transient", httpStatus: 503 });
    });
    expect(rows).toMatchObject([{ effectId: row.effectId, end: "succeeded", calls: 2 }]);
    expect(h.repo.results.map((result) => [result.request.outcome, result.request.errorCode])).toEqual([
      ["networkError", "lookup:503"],
      ["ok", null],
    ]);
    expect(h.double.requests().map((entry) => entry.call)).toEqual(["listMoney", "listMoney", "charge"]);
  });

  it("takes a refund found as the result, so nothing is refunded twice", async () => {
    const h = stripeHarness(TRY_1);
    const full = rowFromExchange("full-price.json");
    h.commit(full);
    await h.clock.drive(h.runner().runDue());
    const payment = must(h.repo.held(full.effectId).row.providerObjectId);
    const refund = refundRow(payment);
    h.written.set(refund.effectId, TRY_1);
    const built = buildStripeRequest(refund);
    if (!built.ok || built.built.call !== "refund") throw new Error("the refund builds");
    h.double.failNext("refund", { kind: "transient", answerLost: true });
    h.double.refund(built.built.request);
    await h.clock.advanceTo(ms(BACK));
    const answer = await h.kinds.stripe_refund?.run(
      tryOf({ ...refund, state: "running", runs: 2, firstTryAt: BACK }, ms(BACK)),
    );
    expect(answer).toEqual({
      outcome: "ok",
      providerObjectId: "stripe-refund-double-0001",
      ledgerLineId: null,
    });
    expect(h.double.requests("refund")).toHaveLength(1);
  });

  it("without when the row was written, holds a later run's charge, and sends a first run's within 23 hours", async () => {
    const h = stripeHarness(BACK);
    h.double.seedCard({
      paymentMethodId: "stripe-card-demo-ben",
      account: SHOP,
      customerId: "stripe-customer-demo-ben",
    });
    const kinds = createStripeKinds({
      port: portOf(h.double),
      writtenAtOf: () => Promise.resolve(null),
      now: () => h.clock.now(),
    });
    const later = { ...benFee(), state: "running" as const, runs: 2, firstTryAt: BACK };
    expect(await kinds.stripe_charge.run(tryOf(later, ms(BACK)))).toEqual({
      outcome: "networkError",
      errorCode: "written_at_unknown",
      retryAfterMs: null,
    });
    expect(h.double.requests()).toEqual([]);
    const first = { ...benFee(), state: "running" as const, runs: 1, firstTryAt: BACK };
    const answer: KindAnswer = await kinds.stripe_charge.run(tryOf(first, ms(BACK)));
    expect(answer.outcome).toBe("ok");
    expect(h.double.requests().map((entry) => entry.call)).toEqual(["charge"]);
  });
});

// ---- the try's signal ----------------------------------------------------------------------------------------------

describe("a try the runner has stopped waiting for sends nothing more", () => {
  it("sends no charge once the try's signal has aborted", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const stopped = new AbortController();
    stopped.abort();
    const row: EffectRow = { ...depositRow(), state: "running", firstTryAt: DEPOSIT_CLAIMED };
    const answer = await h.kinds.stripe_charge?.run(tryOf(row, ms(DEPOSIT_CLAIMED), stopped.signal));
    expect(answer).toEqual({ outcome: "networkError", errorCode: ABORTED, retryAfterMs: null });
    expect(h.double.requests()).toEqual([]);
  });

  /** The double as the port, with some of its calls replaced. */
  function portWith(h: StripeHarness, replaced: Partial<StripeEffectPort>): StripeEffectPort {
    return {
      saveCard: (request) => h.double.saveCard(request),
      charge: (request) => h.double.charge(request),
      payLink: (request) => h.double.payLink(request),
      refund: (request) => h.double.refund(request),
      disputeEvidence: (request) => h.double.disputeEvidence(request),
      listMoney: (request) => h.double.listMoney(request),
      ...replaced,
    };
  }

  it("hands the signal to the port with each call, and sends no charge after a look-up the runner stopped waiting for", async () => {
    const h = stripeHarness("2026-10-28T20:00:01Z");
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const kinds = createStripeKinds({
      port: portWith(h, {
        charge: (request, options) => {
          seen.push(options.signal);
          return h.double.charge(request);
        },
        listMoney: (request, options) => {
          seen.push(options.signal);
          controller.abort();
          return h.double.listMoney(request);
        },
      }),
      writtenAtOf: () => Promise.resolve("2026-10-27T18:10:00Z"),
      now: () => h.clock.now(),
    });
    const row: EffectRow = { ...depositRow(), state: "running", runs: 2, firstTryAt: "2026-10-28T20:00:01Z" };
    const answer = await kinds.stripe_charge.run(tryOf(row, h.clock.now(), controller.signal));
    expect(answer).toEqual({ outcome: "networkError", errorCode: ABORTED, retryAfterMs: null });
    expect(seen).toEqual([controller.signal]);
    expect(h.double.requests().map((entry) => entry.call)).toEqual(["listMoney"]);
  });

  it("answers at once when the runner stops waiting for a call that never comes back", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const controller = new AbortController();
    const kinds = createStripeKinds({
      port: portWith(h, { charge: () => new Promise<never>(() => undefined) }),
      writtenAtOf: () => Promise.resolve(DEPOSIT_COMMITTED),
      now: () => h.clock.now(),
    });
    const row: EffectRow = { ...depositRow(), state: "running", firstTryAt: DEPOSIT_CLAIMED };
    const answering = kinds.stripe_charge.run(tryOf(row, h.clock.now(), controller.signal));
    controller.abort();
    expect(await answering).toEqual({ outcome: "networkError", errorCode: ABORTED, retryAfterMs: null });
  });

  it("answers at once when the runner stops waiting for when the row was written", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    const controller = new AbortController();
    const kinds = createStripeKinds({
      port: portOf(h.double),
      writtenAtOf: () => new Promise<never>(() => undefined),
      now: () => h.clock.now(),
    });
    const row: EffectRow = { ...depositRow(), state: "running", firstTryAt: DEPOSIT_CLAIMED };
    const answering = kinds.stripe_charge.run(tryOf(row, h.clock.now(), controller.signal));
    controller.abort();
    expect(await answering).toEqual({ outcome: "networkError", errorCode: ABORTED, retryAfterMs: null });
    expect(h.double.requests()).toEqual([]);
  });

  it("through the runner, a charge that never answers is a timeout, tried again on the same key", async () => {
    const h = stripeHarness(DEPOSIT_CLAIMED);
    let calls = 0;
    const kinds = createStripeKinds({
      port: portWith(h, {
        charge: (request) => {
          calls += 1;
          return calls === 1 ? new Promise<never>(() => undefined) : h.double.charge(request);
        },
      }),
      writtenAtOf: (effect) => Promise.resolve(h.written.get(effect.effectId) ?? null),
      now: () => h.clock.now(),
    });
    const row = depositRow();
    h.commit(row, DEPOSIT_COMMITTED);
    const report = await h.clock.drive(h.runner("effects-runner-1", { kinds }).runDue());
    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "succeeded", refusal: null, calls: 2 },
    ]);
    expect(h.repo.results.map((result) => [result.request.outcome, result.request.errorCode])).toEqual([
      ["networkError", "timeout"],
      ["ok", null],
    ]);
    expect(listed(h, SHOP, DEPOSIT_COMMITTED, "2026-11-07T16:00:00Z")).toHaveLength(1);
  });
});
