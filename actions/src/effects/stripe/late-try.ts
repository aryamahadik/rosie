// A charge or refund tried late (C-109, T-326; K-14 v1 README 'A try past 23 hours'; default 18; QUESTIONS.md CQ-62).
//
// Stripe keeps an idempotency key for 24 hours and gives every repeat in that time the first answer; after that the same
// key may make a new request (K-14 spike row 7). K-07 v1's outage path runs an effect once more when Stripe is back
// (arch 11 line 582), which can be more than a day later. So "any try of a charge or a refund that goes more than 23
// hours after its effect row was written first looks the effect id up: listMoney on the effect's account, from when the
// row was written (K-07 effects.created_at), to now, with effectId":
//   - found, it is the result and nothing is sent: a charge that succeeded or is still pending is recorded ok with its
//     paymentId; a charge that failed, with none that succeeded, was a decline on that try, recorded declined with
//     card_declined and never tried again; a refund found is recorded ok with its stripeId, whatever its state;
//   - nothing found: the try goes on the effect's one key;
//   - a look-up that fails is that try's failure: nothing is sent, and K-07's rules for the try apply.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. When the row was written is the caller's to give (K-05 v1.1's claimed row has no created_at). When it cannot say,
//      a try in the row's first run within 23 hours of that run's first try needs no look-up: every try of the row went
//      at or after that first try (K-05 v1.1 item 20), so Stripe still holds the key. Any other try is not sent and is
//      recorded as a network error, written_at_unknown, which ends in Stripe's outage row the team sees: never a charge
//      or refund that could be a second one.
//   2. Of several charges found under one effect id, a succeeded one is the result, then a pending one (pending or
//      requiresAction), and only failed or canceled ones are a decline; of several refunds, the oldest.
//   3. A listing off the contract, or one holding an item off it, is a failed look-up (code lookup:stripe_answer_invalid):
//      K-14 gives no partial listing.

import type { EffectRow, KindAnswer } from "../kinds";
import { ANSWER_INVALID, failureAnswer, networkError } from "./answer";
import { isStripeId } from "./request";

/** A try this long after its row was written looks its effect id up first (K-14 README 'A try past 23 hours'). */
export const LATE_TRY_MS = 23 * 60 * 60 * 1000;

/** The code of a try not sent because when its row was written is unknown (default 1). */
export const WRITTEN_AT_UNKNOWN = "written_at_unknown";

/** Marks a look-up's failure apart from the call's own. */
export const LOOK_UP_PREFIX = "lookup:";

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;

/** Epoch milliseconds of a contract instant, or null when it is not one. */
function epochOrNull(value: unknown): number | null {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whether a try at `now` looks its effect id up first, and from when. */
export type LookUpPlan =
  | { readonly kind: "none" }
  | { readonly kind: "lookUp"; readonly from: string }
  | { readonly kind: "unknown" };

/** The 23-hour rule for one try of a charge or refund at `now` (epoch milliseconds); default 1 when unwritten. */
export function lookUpPlan(
  effect: Pick<EffectRow, "runs" | "firstTryAt">,
  writtenAt: string | null,
  now: number,
): LookUpPlan {
  const written = epochOrNull(writtenAt);
  if (written !== null && writtenAt !== null) {
    return now - written > LATE_TRY_MS ? { kind: "lookUp", from: writtenAt } : { kind: "none" };
  }
  const firstTry = epochOrNull(effect.firstTryAt);
  if (effect.runs === 1 && firstTry !== null && now - firstTry <= LATE_TRY_MS) return { kind: "none" };
  return { kind: "unknown" };
}

/** What a look-up found: nothing (the try goes on), or the try's answer (found, or the look-up's failure). */
export type LookUpFound =
  { readonly kind: "nothing" } | { readonly kind: "answer"; readonly answer: KindAnswer };

interface Item {
  readonly kind: "charge" | "refund";
  readonly stripeId: string;
  readonly paymentId: string | null;
  readonly effectId: string | null;
  readonly state: string;
  readonly createdAt: number;
}

const STATES = ["succeeded", "pending", "failed", "requiresAction", "canceled"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One listed charge or refund (K-14 v1 listItem), by the fields the look-up reads, or null when it is off the contract. */
function itemOf(value: unknown): Item | null {
  if (!isObject(value)) return null;
  const { kind, stripeId, paymentId, effectId, state } = value;
  const createdAt = epochOrNull(value.createdAt);
  if (kind !== "charge" && kind !== "refund") return null;
  if (!isStripeId(stripeId) || (paymentId !== null && !isStripeId(paymentId))) return null;
  if (effectId !== null && typeof effectId !== "string") return null;
  if (typeof state !== "string" || !STATES.includes(state) || createdAt === null) return null;
  return { kind, stripeId, paymentId, effectId, state, createdAt };
}

const failed = (code: string): LookUpFound => ({
  kind: "answer",
  answer: networkError(`${LOOK_UP_PREFIX}${code}`),
});

/** Reads a look-up's listing for one charge or refund effect (default 2 and 3). */
export function readLookUp(call: "charge" | "refund", effectId: string, listed: unknown): LookUpFound {
  if (!isObject(listed)) return failed(ANSWER_INVALID);
  if (listed.result === "failed") {
    const answer = failureAnswer("listMoney", listed, LOOK_UP_PREFIX);
    return answer === null ? failed(ANSWER_INVALID) : { kind: "answer", answer };
  }
  if (listed.result !== "listed" || !Array.isArray(listed.items)) return failed(ANSWER_INVALID);
  const items: Item[] = [];
  for (const raw of listed.items as unknown[]) {
    const item = itemOf(raw);
    if (item === null) return failed(ANSWER_INVALID);
    items.push(item);
  }
  const mine = items
    .filter((item) => item.kind === call && item.effectId === effectId)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (mine.length === 0) return { kind: "nothing" };
  if (call === "refund") {
    const [oldest] = mine;
    return oldest === undefined
      ? { kind: "nothing" }
      : { kind: "answer", answer: { outcome: "ok", providerObjectId: oldest.stripeId, ledgerLineId: null } };
  }
  const made =
    mine.find((item) => item.state === "succeeded") ??
    mine.find((item) => item.state === "pending" || item.state === "requiresAction");
  if (made !== undefined) {
    return {
      kind: "answer",
      answer: { outcome: "ok", providerObjectId: made.paymentId, ledgerLineId: null },
    };
  }
  return { kind: "answer", answer: { outcome: "declined", errorCode: "card_declined" } };
}
