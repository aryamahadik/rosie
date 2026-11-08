// The Stripe effect kinds (C-109, T-326): the KindPort (../kinds.ts) each of K-07 v1's six Stripe kinds runs through in
// the effects runner (../runner, T-323): save a card, a charge (a deposit, the full price, at the owner's OK, the rest at
// DONE without the person, a pack, a plan's charge, a fee), a refund, a pay link, dispute evidence on the owner's yes,
// and Rosfield's monthly charge, each through K-14 v1's Stripe port.
//
// One try of one claimed row:
//   1. the K-14 request is built from the row alone (request.ts): its effect id and its one idempotency key, its amount,
//      and its portRequest as it stands. A row that does not hold exactly its call's request is never sent (a hold
//      included: refuse-card-hold.json), and is recorded as a network error naming its first field at fault, so it ends
//      in Stripe's outage row the team sees, never in a call;
//   2. the key the runner hands the try is the row's own (T-323): a try on any other key is never sent;
//   3. a charge or refund tried more than 23 hours after its row was written first looks its effect id up (late-try.ts),
//      and what it finds is the result, so a run after a long outage never charges or refunds twice;
//   4. the call goes with the row's key, which the adapter sends as Stripe's Idempotency-Key and the effect id it puts on
//      the object it makes (rosie_effect_id): a repeat of the try, or a second claim of the row, within Stripe's 24 hours
//      gets the first answer back, so one key charges at most once (K-14 spike rows 7 to 9);
//   5. the answer is recorded as ok, declined or a network error (answer.ts); the runner records a decline once and never
//      tries it again, and tries a network error again on the same key, at most 5 times in 10 minutes, then takes
//      Stripe's outage row (arch 10 line 542; RULES 3.11).
// Each step that calls Stripe first checks the try's signal: once the runner has stopped waiting (its answerBy, 30 s), no
// further call goes, the try answers at once rather than wait on a call that has not come back, and the signal goes
// with each call so the adapter can let it go.
//
// Nothing here builds a charge, a price or an amount, and nothing here is a Tool API path: the runner claims the rows the
// turn's commit wrote (K-05 v1.1 claimEffects, on the runtime side's effects table: DL-149), and these ports run only
// what they are handed. Not here: payments and ledger (C-101), reconciliation (C-112), what starts the runner (C-056).

import { utc } from "../runner/clock";
import type { KindAnswer, KindCall, KindPort } from "../kinds";
import { answerOf, networkError } from "./answer";
import { lookUpPlan, readLookUp, WRITTEN_AT_UNKNOWN } from "./late-try";
import {
  STRIPE_KINDS,
  type StripeCallOptions,
  type StripeEffectPort,
  type StripeKind,
  type StripeKindsDeps,
} from "./port";
import { buildStripeRequest, refusedCode, type StripeCallRequest } from "./request";

/** The code of a try not sent, or not waited for, because the runner had stopped waiting for it (its signal aborted). */
export const ABORTED = "aborted";

const STOPPED: unique symbol = Symbol("stopped");

/**
 * The answer `work` gives, or STOPPED as soon as the try's signal aborts: the runner aborts it at answerBy, so the kind
 * answers by then even when a call never comes back (T-323's handoff). A call that ends later is not waited for; the
 * runner tries the row again on the same key, and Stripe gives the first answer back.
 */
async function untilAborted<T>(work: T | Promise<T>, signal: AbortSignal): Promise<T | typeof STOPPED> {
  if (signal.aborted) return STOPPED;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    onAbort = () => {
      resolve(STOPPED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(work), stopped]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** One call to the port with its typed request. */
function send(port: StripeEffectPort, built: StripeCallRequest, options: StripeCallOptions): unknown {
  switch (built.call) {
    case "saveCard":
      return port.saveCard(built.request, options);
    case "charge":
      return port.charge(built.request, options);
    case "payLink":
      return port.payLink(built.request, options);
    case "refund":
      return port.refund(built.request, options);
    case "disputeEvidence":
      return port.disputeEvidence(built.request, options);
  }
}

/** One try of one claimed Stripe effect row (steps 1 to 5). */
async function runTry(
  deps: StripeKindsDeps,
  now: () => number,
  kind: StripeKind,
  call: KindCall,
): Promise<KindAnswer> {
  const { effect, signal } = call;
  if (effect.kind !== kind) return networkError(refusedCode(["kind"]));
  const build = buildStripeRequest(effect);
  if (!build.ok) return networkError(refusedCode(build.faults));
  const { built } = build;
  if (call.idempotencyKey !== built.request.effect.idempotencyKey)
    return networkError(refusedCode(["effect.idempotencyKey"]));
  const options: StripeCallOptions = { signal };

  if (built.call === "charge" || built.call === "refund") {
    const writtenAt = await untilAborted(deps.writtenAtOf(effect), signal);
    if (writtenAt === STOPPED) return networkError(ABORTED);
    const at = now();
    const plan = lookUpPlan(effect, writtenAt, at);
    if (plan.kind === "unknown") return networkError(WRITTEN_AT_UNKNOWN);
    if (plan.kind === "lookUp") {
      if (signal.aborted) return networkError(ABORTED);
      const listed = await untilAborted<unknown>(
        deps.port.listMoney(
          {
            account: built.request.port.account,
            from: plan.from,
            to: utc(at),
            effectId: built.request.effect.effectId,
          },
          options,
        ),
        signal,
      );
      if (listed === STOPPED) return networkError(ABORTED);
      const found = readLookUp(built.call, built.request.effect.effectId, listed);
      if (found.kind === "answer") return found.answer;
    }
  }

  if (signal.aborted) return networkError(ABORTED);
  const outcome = await untilAborted<unknown>(send(deps.port, built, options), signal);
  if (outcome === STOPPED) return networkError(ABORTED);
  return answerOf(built, outcome);
}

/** The KindPort of each of K-07 v1's six Stripe kinds, ready for the effects runner's `kinds`. */
export function createStripeKinds(deps: StripeKindsDeps): Readonly<Record<StripeKind, KindPort>> {
  const now = deps.now ?? (() => Date.now());
  const portOf = (kind: StripeKind): KindPort => ({ run: (call) => runTry(deps, now, kind, call) });
  return {
    stripe_save_card: portOf("stripe_save_card"),
    stripe_charge: portOf("stripe_charge"),
    stripe_refund: portOf("stripe_refund"),
    stripe_pay_link: portOf("stripe_pay_link"),
    stripe_dispute_evidence: portOf("stripe_dispute_evidence"),
    rosfield_monthly_charge: portOf("rosfield_monthly_charge"),
  } satisfies Record<(typeof STRIPE_KINDS)[number], KindPort>;
}
