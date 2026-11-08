// T-326: the 23-hour rule for a charge or refund tried late (K-14 v1 README 'A try past 23 hours'; default 18;
// QUESTIONS.md CQ-62): when a try looks its effect id up first, and what it takes from what it finds
// (look-up-before-late-try.json).

import { describe, expect, it } from "vitest";

import { LATE_TRY_MS, LOOK_UP_PREFIX, lookUpPlan, readLookUp } from "./late-try";
import { readExchange } from "./test-support";

const WRITTEN = "2026-10-27T18:10:00Z";
const ms = (instant: string): number => Date.parse(instant);
const firstRun = { runs: 1, firstTryAt: "2026-10-27T18:10:01Z" };

describe("when a try looks its effect id up first", () => {
  it("looks up a try more than 23 hours after its row was written, from when it was written", () => {
    expect(lookUpPlan(firstRun, WRITTEN, ms(WRITTEN) + LATE_TRY_MS + 1)).toEqual({
      kind: "lookUp",
      from: WRITTEN,
    });
    expect(
      lookUpPlan({ runs: 2, firstTryAt: "2026-10-28T20:00:00Z" }, WRITTEN, ms("2026-10-28T20:00:01Z")),
    ).toEqual({
      kind: "lookUp",
      from: WRITTEN,
    });
  });

  it("sends a try within 23 hours of its row's writing on its key, with no look-up", () => {
    expect(lookUpPlan(firstRun, WRITTEN, ms(WRITTEN) + LATE_TRY_MS)).toEqual({ kind: "none" });
    expect(
      lookUpPlan({ runs: 2, firstTryAt: "2026-10-27T19:00:00Z" }, WRITTEN, ms("2026-10-27T19:00:01Z")),
    ).toEqual({
      kind: "none",
    });
  });

  it("without the writing time, sends only a first run's try within 23 hours of its first try (default 1)", () => {
    const first = ms(firstRun.firstTryAt);
    expect(lookUpPlan(firstRun, null, first + 10 * 60_000)).toEqual({ kind: "none" });
    expect(lookUpPlan(firstRun, null, first + LATE_TRY_MS)).toEqual({ kind: "none" });
    expect(lookUpPlan(firstRun, null, first + LATE_TRY_MS + 1)).toEqual({ kind: "unknown" });
    // A later run's earlier tries may be older than Stripe keeps a key: it cannot be sent safely.
    expect(
      lookUpPlan({ runs: 2, firstTryAt: "2026-10-28T20:00:00Z" }, null, ms("2026-10-28T20:00:01Z")),
    ).toEqual({
      kind: "unknown",
    });
    expect(lookUpPlan({ runs: 1, firstTryAt: null }, null, first)).toEqual({ kind: "unknown" });
    // A writing time that is not an instant counts as none.
    expect(lookUpPlan(firstRun, "yesterday", first + 60_000)).toEqual({ kind: "none" });
    expect(lookUpPlan({ runs: 2, firstTryAt: null }, "2026-13-45T99:99:99Z", first)).toEqual({
      kind: "unknown",
    });
  });
});

describe("what a look-up finds", () => {
  const EFFECT = "eff-ben-no-show-fee";
  const charge = (
    state: string,
    paymentId: string,
    createdAt = "2026-10-27T18:10:02Z",
  ): Record<string, unknown> => ({
    kind: "charge",
    stripeId: `stripe-charge-${paymentId}`,
    paymentId,
    refundOf: null,
    effectId: EFFECT,
    amount: { cents: 2000, currency: "USD" },
    state,
    createdAt,
  });
  const listed = (...items: unknown[]): Record<string, unknown> => ({
    result: "listed",
    from: WRITTEN,
    to: "2026-10-28T20:00:01Z",
    items,
  });

  it("takes the charge try 1 made as the result, with its PaymentIntent (look-up-before-late-try.json)", () => {
    const { outcome } = readExchange("look-up-before-late-try.json");
    expect(readLookUp("charge", EFFECT, outcome)).toEqual({
      kind: "answer",
      answer: { outcome: "ok", providerObjectId: "stripe-payment-demo-0040", ledgerLineId: null },
    });
  });

  it("takes a succeeded charge before a pending one, and a pending one before a failed one (default 2)", () => {
    expect(readLookUp("charge", EFFECT, listed(charge("failed", "p1"), charge("succeeded", "p2")))).toEqual({
      kind: "answer",
      answer: { outcome: "ok", providerObjectId: "p2", ledgerLineId: null },
    });
    expect(readLookUp("charge", EFFECT, listed(charge("failed", "p1"), charge("pending", "p3")))).toEqual({
      kind: "answer",
      answer: { outcome: "ok", providerObjectId: "p3", ledgerLineId: null },
    });
  });

  it("records a charge that only failed as a decline, card_declined, never tried again", () => {
    expect(readLookUp("charge", EFFECT, listed(charge("failed", "p1")))).toEqual({
      kind: "answer",
      answer: { outcome: "declined", errorCode: "card_declined" },
    });
  });

  it("takes the oldest refund found as the result, whatever its state, with its own Stripe id", () => {
    const refund = (stripeId: string, state: string, createdAt: string): Record<string, unknown> => ({
      kind: "refund",
      stripeId,
      paymentId: "stripe-payment-demo-0001",
      refundOf: "stripe-charge-demo-0001",
      effectId: EFFECT,
      amount: { cents: 2000, currency: "USD" },
      state,
      createdAt,
    });
    const found = listed(
      refund("r2", "succeeded", "2026-10-27T19:00:00Z"),
      refund("r1", "failed", "2026-10-27T18:11:00Z"),
    );
    expect(readLookUp("refund", EFFECT, found)).toEqual({
      kind: "answer",
      answer: { outcome: "ok", providerObjectId: "r1", ledgerLineId: null },
    });
  });

  it("finds nothing in an empty listing, or one holding only other effects' or other kinds' items", () => {
    expect(readLookUp("charge", EFFECT, listed())).toEqual({ kind: "nothing" });
    const other = { ...charge("succeeded", "p9"), effectId: "eff-someone-else" };
    expect(readLookUp("charge", EFFECT, listed(other))).toEqual({ kind: "nothing" });
    expect(readLookUp("refund", EFFECT, listed(charge("succeeded", "p1")))).toEqual({ kind: "nothing" });
  });

  it("makes a failed look-up that try's failure, a network error, so nothing is sent", () => {
    const failed = { result: "failed", kind: "transient", httpStatus: 503, code: null, reason: "down" };
    expect(readLookUp("charge", EFFECT, failed)).toEqual({
      kind: "answer",
      answer: { outcome: "networkError", errorCode: `${LOOK_UP_PREFIX}503`, retryAfterMs: null },
    });
    const refused = {
      result: "failed",
      kind: "refused",
      httpStatus: 403,
      code: "account_invalid",
      reason: "gone",
    };
    expect(readLookUp("refund", EFFECT, refused)).toEqual({
      kind: "answer",
      answer: {
        outcome: "networkError",
        errorCode: `${LOOK_UP_PREFIX}refused:account_invalid`,
        retryAfterMs: null,
      },
    });
  });

  it("takes no partial or odd listing (default 3)", () => {
    const invalid = {
      kind: "answer",
      answer: {
        outcome: "networkError",
        errorCode: `${LOOK_UP_PREFIX}stripe_answer_invalid`,
        retryAfterMs: null,
      },
    };
    const odd: unknown[] = [
      null,
      [],
      { result: "listed" },
      { result: "listed", items: {} },
      listed({ ...charge("succeeded", "p1"), state: "held" }),
      listed({ ...charge("succeeded", "p1"), stripeId: "4242424242424242" }),
      listed({ ...charge("succeeded", "p1"), createdAt: "yesterday" }),
      listed(charge("succeeded", "p1"), "not an item"),
      {
        result: "failed",
        kind: "declined",
        httpStatus: 402,
        code: "card_declined",
        declineCode: null,
        reason: "x",
      },
    ];
    for (const value of odd)
      expect(readLookUp("charge", EFFECT, value), JSON.stringify(value)).toEqual(invalid);
  });
});
