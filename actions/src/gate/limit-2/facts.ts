// Where limit 2 (C-082, T-300) gets what it reads, each behind a port, so the rule (owner-rules.ts) and the evaluator it
// shares with search (actions/src/rules/evaluator) are plain code:
//   - what a part proposes that an owner rule may govern: a visit's time, a booking's price with its extras, a deposit, a
//     fee, the person a new booking is for (the evaluator's Proposal). The walk after the part's choice knows it (the
//     commit's writesOf, with the price resolver C-132 and the booking writer: C-100, C-133). It is not built for any
//     booking step (T-1139 builds the walk for S1-01 and S1-02 only), so the shipped limit answers it with
//     WALK_NOT_BUILT: a part that may carry an owner rule is not known, and the limit refuses it (notBuilt: fails
//     closed); any other part proposes nothing an owner rule governs (owner-rules.ts default 1);
//   - the business's owner rules: K-26 v1's rules rows, read through a data-access call on the call's own transaction
//     (the Tool API's scoped repo, where row-level security leaves the call's business only: arch 10 line 546). db/repo
//     has no read of K-26's rules yet, so the shipped limit has none, and a part with a proposal is refused (notBuilt)
//     until one is wired here (createLimit2's `rules`).
// Neither port writes. Every read gives ids, labels, amounts and instants; the owner's words (rules.words) are not read.

import { holdClassOf } from "../../commit/hold";
import type { Proposal, RuleRow } from "../../rules/evaluator";
import type { GatePart, GateTurn } from "../framework";

// ---- what a part proposes (the walk) ----------------------------------------------------------------------------------

/**
 * What one gated part proposes, as far as owner rules read it:
 *   none      nothing an owner rule governs (a setup, team or settings choice about no booking, a change that only protects);
 *   proposal  what its walk would book, move or charge;
 *   unknown   it may carry an owner rule, and the walk that would say what it proposes is not built: refused, never passed.
 */
export type PartProposal =
  | { readonly kind: "none" }
  | { readonly kind: "proposal"; readonly proposal: Proposal }
  | { readonly kind: "unknown" };

export interface Proposals {
  /** What one gated part proposes: the walk after its choice, with the price, extras and times it gives. */
  proposalOf(part: GatePart, turn: GateTurn): Promise<PartProposal>;
}

/**
 * The stakes reasons of a choice whose walk may book, move, charge or take money (K-02 v1 stakesReason): booked, moveRow
 * and calendarWrite (a visit's time), charge and money (a fee, a deposit or a price taken), cancelRow (a late cancel may
 * charge a fee), unknown (the frontier builder could not walk it, so the safer route). Not refund, which no K-26 kind
 * governs, and not question: another option's stake says nothing about this one.
 */
export const RULED_STAKES: readonly string[] = [
  "booked",
  "moveRow",
  "calendarWrite",
  "charge",
  "money",
  "cancelRow",
  "unknown",
];

/** The doors whose entry books a visit (arch 03 line 165; K-02 v1 choice.door): a new booking, an existing booking. */
export const BOOKING_DOORS: readonly string[] = ["newBooking", "existingBooking"];

/** A step of a visit's own journey, in flow A or B (K-01 stepId: A4-14, B7-05); S steps are the business's journeys. */
const VISIT_STEP = /^[AB]\d/u;

/**
 * Whether a part may carry an owner rule, so its proposal must come from the walk (owner-rules.ts default 1): a choice on
 * a booking, at a step of a visit's journey, at a booking door, with a stake that books, moves, charges, takes money or
 * cancels, or carrying a time or money value. Never pass_on or hand_off (no choice), and never a change that only
 * protects (the commit's list: actions/src/commit/hold.ts), which no owner rule holds back.
 */
export function mayCarryOwnerRule(part: GatePart): boolean {
  const { part: said, choice } = part;
  if (choice === null) return false;
  if (holdClassOf(said, choice) === "protective") return false;
  if (choice.target.bookingId !== null) return true;
  if (VISIT_STEP.test(choice.step)) return true;
  if (choice.door !== null && BOOKING_DOORS.includes(choice.door)) return true;
  if (choice.stakesFrom.some((reason) => RULED_STAKES.includes(reason.why))) return true;
  return choice.fields.some((field) => field.type === "time" || field.type === "money");
}

const NONE: PartProposal = { kind: "none" };
const UNKNOWN: PartProposal = { kind: "unknown" };

/**
 * The walk not built yet: a part that may carry an owner rule is not known (the limit refuses it: notBuilt), any other
 * part proposes nothing an owner rule governs.
 */
export const WALK_NOT_BUILT: Proposals = {
  proposalOf: (part) => Promise.resolve(mayCarryOwnerRule(part) ? UNKNOWN : NONE),
};

// ---- the business's owner rules (K-26 v1) -----------------------------------------------------------------------------

export interface OwnerRules {
  /**
   * The business's K-26 v1 rules rows, read on the call's scope: at least every row in effect at `at` (a UTC instant).
   * The evaluator checks each against the closed registry: a row of a kind it does not hold is refused, never ignored.
   */
  rulesOf(businessId: string, at: string): Promise<readonly RuleRow[]>;
}
