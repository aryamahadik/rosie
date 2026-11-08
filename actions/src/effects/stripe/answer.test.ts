// T-326: what each Stripe call's answer is recorded as (K-14 v1 README 'Effects', "How the runner records each
// outcome"), on every K-14 fixture outcome of the five effect calls: ok with K-14's providerObjectId, a decline once and
// never again, a network error tried again on the same key; and nothing of a client secret, a reason, an amount or a
// card leaves an answer.

import { describe, expect, it } from "vitest";

import type { KindAnswer } from "../kinds";
import { ANSWER_INVALID, answerOf } from "./answer";
import { buildStripeRequest, type StripeCallRequest } from "./request";
import { STRIPE_INDEX, k14, readExchange, rowFromExchange } from "./test-support";

const EFFECT_CALLS = ["saveCard", "charge", "payLink", "refund", "disputeEvidence"];

/** The fixture's request as the kinds build it from its row. */
function builtOf(file: string): StripeCallRequest {
  const build = buildStripeRequest(rowFromExchange(file));
  if (!build.ok) throw new Error(`${file} does not build`);
  return build.built;
}

/** What K-14 v1's README records each fixture's outcome as. */
const EXPECTED: Readonly<Record<string, KindAnswer>> = {
  "save-card.json": { outcome: "ok", providerObjectId: "stripe-setup-demo-alex-1", ledgerLineId: null },
  "bill-card.json": { outcome: "ok", providerObjectId: "stripe-setup-demo-sam-lee-1", ledgerLineId: null },
  "deposit.json": { outcome: "ok", providerObjectId: "stripe-payment-demo-0001", ledgerLineId: null },
  "full-price.json": { outcome: "ok", providerObjectId: "stripe-payment-demo-0003", ledgerLineId: null },
  "charge-at-owner-ok.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-0005",
    ledgerLineId: null,
  },
  "off-session-at-done.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-0010",
    ledgerLineId: null,
  },
  "pack-purchase.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-yoga-0002",
    ledgerLineId: null,
  },
  "monthly-charge.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-yoga-studio-2026-10",
    ledgerLineId: null,
  },
  // With the person present, their bank's check: ok, the PaymentIntent, no ledger line until paymentSucceeded.
  "needs-authentication.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-yoga-0001",
    ledgerLineId: null,
  },
  "decline-not-retried.json": { outcome: "declined", errorCode: "card_declined" },
  "charge-network-error.json": { outcome: "networkError", errorCode: "network", retryAfterMs: null },
  "charge-failed-pay-link.json": {
    outcome: "ok",
    providerObjectId: "stripe-payment-demo-0007",
    ledgerLineId: null,
  },
  "bill-pay-link.json": {
    outcome: "ok",
    providerObjectId: "stripe-pay-link-demo-lee-home-services-2026-10",
    ledgerLineId: null,
  },
  "refund-part.json": { outcome: "ok", providerObjectId: "stripe-refund-demo-0003", ledgerLineId: null },
  "refund-double-charge.json": {
    outcome: "ok",
    providerObjectId: "stripe-refund-demo-0021",
    ledgerLineId: null,
  },
  "dispute-evidence-owner-yes.json": {
    outcome: "ok",
    providerObjectId: "stripe-dispute-demo-0001",
    ledgerLineId: null,
  },
};

const accepted = STRIPE_INDEX.filter(
  (entry) => entry.expect === "accept" && EFFECT_CALLS.some((call) => entry.def === `${call}.exchange`),
);

describe("every K-14 v1 fixture outcome of an effect call is recorded as K-14 says", () => {
  it("covers every accepted fixture of the five calls", () => {
    expect(accepted.map((entry) => entry.file).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const entry of accepted) {
    it(`records ${entry.file}'s ${String(readExchange(entry.file).outcome.result)}`, () => {
      const exchange = readExchange(entry.file);
      const answer = answerOf(builtOf(entry.file), exchange.outcome);
      expect(answer).toEqual(EXPECTED[entry.file]);
      // Nothing but ids and codes: no client secret, reason, card or amount.
      const text = JSON.stringify(answer);
      for (const value of [exchange.outcome.clientSecret, exchange.outcome.reason, "4242", "visa", "cents"]) {
        if (typeof value === "string") expect(text).not.toContain(value);
      }
    });
  }
});

describe("failures", () => {
  const charge = builtOf("deposit.json");
  const refund = builtOf("refund-part.json");
  const failure = (fields: Record<string, unknown>): Record<string, unknown> => ({
    result: "failed",
    kind: "transient",
    httpStatus: null,
    code: null,
    declineCode: null,
    reason: "Stripe's words, never recorded",
    paymentId: null,
    ...fields,
  });

  it("records a decline with Stripe's code, then its decline code, then card_declined (default 2)", () => {
    const declined = { kind: "declined", httpStatus: 402 };
    expect(
      answerOf(charge, failure({ ...declined, code: "expired_card", declineCode: "expired_card" })),
    ).toEqual({
      outcome: "declined",
      errorCode: "expired_card",
    });
    expect(answerOf(charge, failure({ ...declined, declineCode: "insufficient_funds" }))).toEqual({
      outcome: "declined",
      errorCode: "insufficient_funds",
    });
    expect(answerOf(charge, failure(declined))).toEqual({ outcome: "declined", errorCode: "card_declined" });
  });

  it("records a transient failure as a network error with Stripe's code, the status or network (default 3)", () => {
    expect(answerOf(charge, failure({ httpStatus: 429, code: "rate_limit" }))).toEqual({
      outcome: "networkError",
      errorCode: "rate_limit",
      retryAfterMs: null,
    });
    expect(answerOf(charge, failure({ httpStatus: 503 }))).toEqual({
      outcome: "networkError",
      errorCode: "503",
      retryAfterMs: null,
    });
    expect(answerOf(refund, failure({}))).toEqual({
      outcome: "networkError",
      errorCode: "network",
      retryAfterMs: null,
    });
  });

  it("records a refused call as a network error, never a decline (default 1)", () => {
    const refused = failure({ kind: "refused", httpStatus: 400, code: "resource_missing" });
    expect(k14("charge.errors", refused)).toEqual([]);
    expect(answerOf(charge, refused)).toEqual({
      outcome: "networkError",
      errorCode: "refused:resource_missing",
      retryAfterMs: null,
    });
    expect(answerOf(refund, failure({ kind: "refused", httpStatus: 400 }))).toEqual({
      outcome: "networkError",
      errorCode: "refused:400",
      retryAfterMs: null,
    });
  });
});

describe("an answer off the contract is a network error, never a charge or a decline (default 4)", () => {
  const charge = builtOf("deposit.json");
  const invalid: KindAnswer = { outcome: "networkError", errorCode: ANSWER_INVALID, retryAfterMs: null };

  it("refuses needsAuthentication without the person present (refuse-off-session-needs-authentication.json)", () => {
    const file = "invalid/refuse-off-session-needs-authentication.json";
    const exchange = readExchange(file);
    expect(k14("charge.exchange", exchange)).not.toEqual([]);
    expect(answerOf(builtOf(file), exchange.outcome)).toEqual(invalid);
  });

  it("refuses shapes K-14 does not have", () => {
    const refund = builtOf("refund-part.json");
    const answers: unknown[] = [
      null,
      "charged",
      [],
      {},
      { result: "charged" },
      { result: "charged", paymentId: "" },
      { result: "charged", paymentId: "4242424242424242" },
      { result: "charged", paymentId: 5 },
      { result: "held", paymentId: "stripe-payment-demo-0001" },
      { result: "constructor", paymentId: "stripe-payment-demo-0001" },
      { result: "toString", paymentId: "stripe-payment-demo-0001" },
      { result: "refunded", refundId: "stripe-refund-demo-0001" },
      { result: "failed", kind: "declined", httpStatus: 402, code: "card declined", declineCode: null },
      { result: "failed", kind: "unknown", httpStatus: 400, code: null },
      { result: "failed", kind: "transient", httpStatus: 302, code: null },
    ];
    for (const answer of answers) expect(answerOf(charge, answer), JSON.stringify(answer)).toEqual(invalid);
    // A refund cannot be declined: only a card can.
    const declinedRefund = {
      result: "failed",
      kind: "declined",
      httpStatus: 402,
      code: "card_declined",
      declineCode: null,
    };
    expect(answerOf(refund, declinedRefund)).toEqual(invalid);
  });
});
