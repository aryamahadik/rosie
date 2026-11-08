// When an effect's tries go (C-036, T-323). Arch 10 line 542: "Stripe and calendar calls retry network errors 5 times in
// 10 minutes on one idempotency key, then take that service's outage row (DD). A card decline is never retried".
//
// K-07 v1 default 3 reads it as 5 tries in all, the 10 minutes counted from the run's first try (effects.first_try_at,
// written at the claim), and K-07's named rule lifeChain holds a run to it. K-05 v1.1 item 21 has recordEffectResult move
// the row to that service's outage row on the run's 5th try (K-05 default 13), so the runner reports each try and never
// decides the outage itself. No source gives the spacing; QUESTIONS.md M2-action-adapters.4's default (the CTO's) is a
// try every 2 minutes, at 0, 2, 4, 6 and 8 minutes from the run's first try, honouring a shorter Retry-After from the
// provider: the 5th try goes by 8 minutes, inside the 10. A try that comes late (a claim taken again after a runner died)
// goes at once, and the next keeps its own slot.
//
// The claim: K-05 v1.1 gives an effect claim 60 s when it is taken, and after a network error 60 s past the next try
// (K-05 default 12), so the runner holds the row while it waits. A port call that ran past the claim could meet another
// runner's call on the same key (K-05 open gap 12, which proposes port calls under 60 s), so the runner starts a call only
// while at least PORT_CALL_BUDGET_MS of its claim is left, and stops waiting for the port when that budget is spent.

/** The tries in one run (K-07 v1 outbox-effects.rules.mjs EFFECT_TRIES; default 3). */
export const EFFECT_TRIES = 5;
/** A run's tries fall within this window from its first try (K-07 v1 outbox-effects.rules.mjs EFFECT_WINDOW_MS). */
export const EFFECT_WINDOW_MS = 10 * 60_000;
/** A try every 2 minutes from the run's first try (QUESTIONS.md M2-action-adapters.4). */
export const TRY_SPACING_MS = 2 * 60_000;
/** An effect claim lasts 60 s from its claim, or from the planned next try (K-05 v1.1 items 20 and 21; default 12). */
export const CLAIM_MS = 60_000;
/** The longest a port call may take: half a claim (default; K-05 v1.1 open gap 12 asks for port calls under 60 s). */
export const PORT_CALL_BUDGET_MS = 30_000;

/** A provider's Retry-After the runner can honour: a whole, finite number of milliseconds from 0. */
function retryAfterOf(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * When the next try goes after try `tries` of the run failed with a network error at `at` (epoch milliseconds): try
 * `tries + 1`'s slot, `firstTryAt` + `tries` × 2 minutes, or sooner when the provider's Retry-After is shorter, and never
 * before `at`. Null after the run's 5th try: the row is then that service's outage row and no try follows.
 */
export function nextTryAt(
  firstTryAt: number,
  tries: number,
  at: number,
  retryAfterMs: number | null,
): number | null {
  if (tries >= EFFECT_TRIES) return null;
  const slot = firstTryAt + tries * TRY_SPACING_MS;
  const retryAfter = retryAfterOf(retryAfterMs);
  const planned = retryAfter === null ? slot : Math.min(slot, at + retryAfter);
  return Math.max(at, planned);
}

/** True while a claim lapsing at `claimLapsesAt` leaves a port call starting at `now` its whole budget. */
export function claimLeavesBudget(now: number, claimLapsesAt: number): boolean {
  return now + PORT_CALL_BUDGET_MS <= claimLapsesAt;
}
