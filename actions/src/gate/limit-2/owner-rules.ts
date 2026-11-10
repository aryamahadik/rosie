// Limit 2, Owner rules (C-082, T-300; arch 06 line 301): "One rule evaluator, shared with search, passes every typed rule.
// The $250 minimum holds on texted bookings too, on the booking's total with any extra work (DD). A photo quote is checked
// when it is priced, before any yes (A4-05). A price set only at the visit or by the hour cannot fail a minimum: it passes,
// and the owner's booking card says the minimum could not be checked (DD)." On failure: "Rosie says what the rule allows.
// Nothing is saved." (K-09 v1 limit2Outcome: saidWhatRuleAllows, refuse.)
//
// For one gated part, in this order:
//   1. pass_on and hand_off choose nothing a rule governs: notChecked (K-08 v1 limitResult: "notChecked when the turn has
//      nothing it applies to");
//   2. what the part proposes (the walk, facts.ts): nothing an owner rule governs passes, with no rule read (K-09 v1's
//      commit-s1-02.json: limit 2 passes Sam's S1-02 answer), but at the sign-up door, which starts a business's sign-up,
//      there is nothing to check (notChecked: default 4); a proposal not known yet is refused (notBuilt);
//   3. a proposal at another business than the call's cannot be checked in the call's scope: refused (notBuilt);
//   4. the business's K-26 v1 rules rows (facts.ts), checked by the one evaluator (actions/src/rules/evaluator): a row of a
//      kind not in the frozen registry, or one it cannot read, refuses the part, never ignored; a broken rule fails it with
//      saidWhatRuleAllows and what each broken rule allows; else it passes, with the notes for the owner's booking card
//      (minimumNotChecked) and whether an OK rule makes the booking wait for the owner's OK (A4-98). A proposal the
//      evaluator cannot read, such as a list price with no amount (DL-328), throws: the gate's call rolls back and
//      nothing passes.
//
// The limit only checks. It has no port that writes, and what its outcome writes (Rosie's reply saying what the rule
// allows; the note on the owner's booking card) is the commit's (K-09 v1 limitNOutcome; T-305 default 8), so a repeated
// turn that runs the gate again gets the same answer and nothing more (STATE note 1). Nothing here logs. What it returns
// names rule ids, kinds, labels, amounts, days and instants: never the owner's words or a person's.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. What may carry an owner rule until the walk is wired (facts.ts mayCarryOwnerRule): a choice on a booking, at a step
//      of a visit's journey (flow A or B), at a booking door, with a stake that books, moves, charges, takes money or
//      cancels (or that the frontier could not walk), or carrying a time or money value. K-26's rules govern bookings
//      (S11-57: "for new bookings only"), so any other choice (setup, team and settings about no booking: the S steps)
//      proposes nothing they govern, and a change that only protects (a STOP, a death report, the A3-48 pause, A3-50's
//      private booking: the commit's list in actions/src/commit/hold.ts) is never held back by an owner rule.
//   2. A part refused because a row cannot be read (an unknown kind above all) or a port is not built answers notBuilt:
//      the gate refuses the whole call and nothing is written (fails closed), since a rule nobody can read may be the one
//      that forbids it. A new registry kind reaches limit 2 only with the evaluator's change (K-26 README rule 6).
//   3. K-09 v1's commit-limit-2-owner-rule.json says Alex's "tonight at 9pm" is "past Lee's Barbershop's hours". K-26 v1
//      has no hours kind (its README: hours are K-27's, H01), so the limit's tests give the barbershop a K-26 notice rule
//      of 24 hours (a made-up value) that the time breaks. Whether limit 2 also reads K-27's hours, or a K-09 minor version
//      rewords the fixture's note, is the architect's (open question).
//   4. T-1183 (DL-364): K-02 v1.1's sign-up door (its default 9) starts a business's sign-up, before any rule of the
//      business could govern what it does (K-26's rules hold a business's bookings: S11-57), so when it proposes nothing
//      an owner rule governs, limit 2 has nothing to apply to it: notChecked, as K-09 v1.5's commit-s1-01.json and K-08
//      v1's trace-skeleton.json log it (ADR-013 section 2). Every other part that proposes nothing ruled still passes, the
//      answer at S1-02 that follows the door among them (commit-s1-02.json), and a sign-up door that may carry a rule (on
//      a booking, with a ruled stake, with a time or money value: not the door K-02 v1.1 shapes) is checked as any part.

import { evaluateRules, type BrokenCheck, type NotedCheck, type RefusedRule } from "../../rules/evaluator";
import type { Choice, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type { OwnerRules, Proposals } from "./facts";

/** Limit 2's outcome when it fails (K-09 v1 limit2Outcome). */
export type Limit2Outcome = LimitOutcomes[2];

/** Rosie says what the rule allows; nothing is saved (K-09 v1: refuse). */
export function saidWhatRuleAllowsOutcome(): Limit2Outcome {
  return { limit: 2, outcome: "refuse", action: "saidWhatRuleAllows" };
}

/** Why a part passes: it proposes nothing an owner rule governs, or every rule that applies holds. */
export type PassWhy = "nothingRuled" | "rulesHold";

/** A port limit 2 reads that is not built yet (default 2). */
export type Limit2Port = "proposals" | "rules";

export type OwnerRulesDecision =
  | {
      readonly result: "pass";
      readonly why: PassWhy;
      /** The notes for the owner's booking card, such as minimumNotChecked (arch 06 line 301), which the commit writes. */
      readonly notes: readonly NotedCheck[];
      /** An OK rule applies: the booking waits for the owner's OK (A4-98, B4-115), which never refuses it. */
      readonly ownerOkFirst: boolean;
    }
  | { readonly result: "notChecked" }
  | {
      readonly result: "fail";
      readonly outcome: Limit2Outcome;
      /** Each broken rule and what it allows: what Rosie says (arch 06 line 301). */
      readonly allows: readonly [BrokenCheck, ...BrokenCheck[]];
    }
  /** A rules row the evaluator cannot read, an unknown kind above all: refused, never ignored (default 2). */
  | { readonly result: "refused"; readonly refused: readonly [RefusedRule, ...RefusedRule[]] }
  /** A port it reads is not built yet, or the proposal is at another business than the call's (default 2). */
  | { readonly result: "notBuilt"; readonly port: Limit2Port };

/** What the rule reads: the walk, and the business's rules made only when a proposal needs them (null: not built). */
export interface OwnerRulesPorts {
  readonly proposals: Proposals;
  readonly rules: (() => OwnerRules) | null;
}

const NOT_CHECKED: OwnerRulesDecision = { result: "notChecked" };
const NOTHING_RULED: OwnerRulesDecision = {
  result: "pass",
  why: "nothingRuled",
  notes: [],
  ownerOkFirst: false,
};
const notBuilt = (port: Limit2Port): OwnerRulesDecision => ({ result: "notBuilt", port });

/** K-02 v1.1's sign-up door (its default 9), which starts a business's sign-up (default 4). */
function startsSignUp(choice: Choice): boolean {
  return choice.kind === "door" && choice.door === "signUp";
}

/** Limit 2 on one agreed part: pass, notChecked, the failure with what each broken rule allows, or refused. */
export async function decideOwnerRules(
  part: GatePart,
  turn: GateTurn,
  ports: OwnerRulesPorts,
): Promise<OwnerRulesDecision> {
  const { part: said, choice } = part;
  if (said.verb === "pass_on" || said.verb === "hand_off") return NOT_CHECKED;
  if (choice === null) throw new TypeError("limit 2 got a choose or enter part without its offered choice");

  const proposed = await ports.proposals.proposalOf(part, turn);
  if (proposed.kind === "none") return startsSignUp(choice) ? NOT_CHECKED : NOTHING_RULED;
  if (proposed.kind === "unknown") return notBuilt("proposals");
  const { proposal } = proposed;
  // The rules are read in the call's business scope only; another business's cannot be checked here (fails closed).
  if (proposal.businessId !== turn.businessId) return notBuilt("rules");
  if (ports.rules === null) return notBuilt("rules");

  const rows = await ports.rules().rulesOf(turn.businessId, proposal.rulesAt);
  const verdict = evaluateRules(rows, proposal);
  switch (verdict.result) {
    case "refused":
      return { result: "refused", refused: verdict.refused };
    case "broken":
      return { result: "fail", outcome: saidWhatRuleAllowsOutcome(), allows: verdict.broken };
    case "holds":
      return { result: "pass", why: "rulesHold", notes: verdict.notes, ownerOkFirst: verdict.ownerOkFirst };
  }
}
