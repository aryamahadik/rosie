// What a Stripe call's answer is recorded as (C-109, T-326): K-14 v1's outcome, in K-05 v1.1 recordEffectResult's three
// outcomes (../kinds.ts KindAnswer). K-14 README 'Effects', "How the runner records each outcome":
//   - ok: charged, ready, created, refunded and submitted, with the providerObjectId of K-14's table (default 7): the
//     SetupIntent, the PaymentIntent (a charge and a pay link alike), the refund, the dispute. needsAuthentication, only
//     with the person present, is ok too, with the PaymentIntent: the payment waits on their bank's check on the page;
//   - declined: a card decline, recorded once and never tried again (RULES 3.11; arch 10 line 542);
//   - networkError: transient (no answer, a network error, 409, 429 or 5xx), tried again on the same key, at most 5 tries
//     in 10 minutes, then Stripe's outage row (K-07 v1 retry rule 8).
//
// Only the ids and codes listed here leave an answer: a client secret (saveCard, payLink, needsAuthentication) is never
// kept, recorded or logged (K-14 README 'Money and cards': "the effects runner keeps none"), and neither is Stripe's
// reason, a card's brand and last four or an amount. An error code is Stripe's own code, a label (K-14 stripeCode), never
// its message (T-323 security note N2).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A refused call (any other 4xx) has no K-07 v1 state (K-07 open gap 5; K-14 open gap 3). It is recorded as a network
//      error with code refused:<Stripe's code or status>, so it is never shown to a customer as a decline and ends, if
//      Stripe refuses it each time, in Stripe's outage row, which the team sees (as T-323's default 3 does for a port
//      fault), until K-07's minor version gives it a state of its own.
//   2. A decline's code is Stripe's error code (card_declined, expired_card, authentication_required), as K-07 v1
//      effect-charge-declined.json records card_declined; then its decline code; then card_declined.
//   3. A transient failure's code is Stripe's code, else the HTTP status, else "network" for no answer at all (K-07 v1's
//      placeholders 503, 429 and network). Stripe sends no Retry-After (K-14 spike row 17), so none is given.
//   4. An answer off the contract (a shape K-14 does not have, a decline on a call that cannot decline, needsAuthentication
//      without the person present: refuse-off-session-needs-authentication.json) is a network error with code
//      stripe_answer_invalid: tried again on the same key, so Stripe replays its answer, and never read as a charge or a
//      decline.
//   5. The kinds write no ledger line: ledgerLineId is null. Writing or matching it is payments and ledger's (C-101) and
//      reconciliation's by effect id (arch 10 line 550; K-07 v1 open gap 14).

import type { KindAnswer } from "../kinds";
import type { StripeEffectCall } from "./port";
import { isStripeId, type StripeCallRequest } from "./request";

/** The code of an answer off the contract (default 4). */
export const ANSWER_INVALID = "stripe_answer_invalid";

/** K-14 v1 stripeCode and declineCode: Stripe's code as a label. */
const STRIPE_CODE = /^[a-z][a-z0-9_]*$/u;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCodeOrNull = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && STRIPE_CODE.test(value));

const isStatusOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599);

export const networkError = (errorCode: string): KindAnswer => ({
  outcome: "networkError",
  errorCode,
  retryAfterMs: null,
});

const ok = (providerObjectId: string): KindAnswer => ({
  outcome: "ok",
  providerObjectId,
  ledgerLineId: null,
});

/** What each call's success answers and the id it is recorded with (K-14 README 'Effects' table; default 7). */
const SUCCESS: Readonly<Record<StripeEffectCall, Readonly<Record<string, string>>>> = {
  saveCard: { ready: "setupId" },
  charge: { charged: "paymentId", needsAuthentication: "paymentId" },
  payLink: { created: "paymentId" },
  refund: { refunded: "refundId" },
  disputeEvidence: { submitted: "disputeId" },
};

/**
 * A K-14 v1 failure (`callFailure`, or `charge.errors` for a charge) as recorded, or null when it is off the contract.
 * `prefix` marks a look-up's failure apart from the call's own.
 */
export function failureAnswer(
  call: StripeEffectCall | "listMoney",
  value: Obj,
  prefix = "",
): KindAnswer | null {
  const { kind, httpStatus, code } = value;
  if (!isCodeOrNull(code) || !isStatusOrNull(httpStatus)) return null;
  if (kind === "declined") {
    const declineCode = value.declineCode;
    if (call !== "charge" || !isCodeOrNull(declineCode)) return null;
    return { outcome: "declined", errorCode: code ?? declineCode ?? "card_declined" };
  }
  if (kind === "transient") {
    return networkError(`${prefix}${code ?? (httpStatus === null ? "network" : String(httpStatus))}`);
  }
  if (kind === "refused") {
    const why = code ?? (httpStatus === null ? null : String(httpStatus));
    return networkError(`${prefix}${why === null ? "refused" : `refused:${why}`}`);
  }
  return null;
}

/** One Stripe call's answer as K-05 v1.1 records it (defaults 1 to 5). */
export function answerOf(built: StripeCallRequest, outcome: unknown): KindAnswer {
  if (!isObject(outcome)) return networkError(ANSWER_INVALID);
  if (outcome.result === "failed") return failureAnswer(built.call, outcome) ?? networkError(ANSWER_INVALID);
  const result = outcome.result;
  const idField = typeof result === "string" ? SUCCESS[built.call][result] : undefined;
  if (idField === undefined) return networkError(ANSWER_INVALID);
  // Off-session, the bank's ask comes back as a decline (authentication_required), never as needsAuthentication.
  if (result === "needsAuthentication" && !(built.call === "charge" && built.request.port.customerPresent))
    return networkError(ANSWER_INVALID);
  const id = outcome[idField];
  return isStripeId(id) ? ok(id) : networkError(ANSWER_INVALID);
}
