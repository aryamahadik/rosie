// Limit 2, Owner rules (C-082, T-300; arch 06 line 301): every typed owner rule (K-26 v1) checked through the one
// evaluator search shares (actions/src/rules/evaluator), saying what the rule allows on failure and saving nothing. It
// replaces T-298's fail-closed stub in this slot of the gate's registry (../limits.ts). The rule is owner-rules.ts, and
// what it reads facts.ts.
//
// `limit2` is given no walk and no rules read yet: a part that may carry an owner rule is refused (notBuilt, fails
// closed) until the walk (C-100, C-132, C-133) and a data-access read of K-26's rules are wired here; any other part, such
// as Sam's S1-02 answer, proposes nothing an owner rule governs and passes with nothing read, and the sign-up door before
// it is not checked (owner-rules.ts default 4). createLimit2 takes other ports, as the tests do.

import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import { WALK_NOT_BUILT, type OwnerRules, type Proposals } from "./facts";
import { decideOwnerRules, type OwnerRulesDecision } from "./owner-rules";

export interface Limit2Deps {
  /** What each part proposes (the walk). Default WALK_NOT_BUILT: a part that may carry an owner rule is refused. */
  readonly proposals?: Proposals;
  /** The business's K-26 v1 rules rows on the call's repo. Default: none yet, so a part with a proposal is refused. */
  readonly rules?: (repo: unknown) => OwnerRules;
}

/** Limit 2 in the gate's registry, with the full decision the commit's outcome writer reads. */
export interface OwnerRulesLimit extends Limit<2> {
  /** The part's decision: pass (with its notes), notChecked, the failure with what each broken rule allows, or refused. */
  decide(part: GatePart, turn: GateTurn): Promise<OwnerRulesDecision>;
}

/** The limit's K-09 verdict for the gate from its decision: a refused or not-built part is refused, never passed. */
export function verdictOf(decision: OwnerRulesDecision): LimitVerdict<2> {
  switch (decision.result) {
    case "pass":
      return { result: "pass" };
    case "notChecked":
      return { result: "notChecked" };
    case "fail":
      return { result: "fail", outcome: { ...decision.outcome } };
    case "refused":
    case "notBuilt":
      return { result: "notBuilt" };
  }
}

export function createLimit2(deps: Limit2Deps = {}): OwnerRulesLimit {
  const proposals = deps.proposals ?? WALK_NOT_BUILT;
  const rulesOf = deps.rules ?? null;
  const decide = (part: GatePart, turn: GateTurn): Promise<OwnerRulesDecision> =>
    decideOwnerRules(part, turn, {
      proposals,
      rules: rulesOf === null ? null : () => rulesOf(turn.repo),
    });
  return {
    limit: 2,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 2 as the gate runs it (../limits.ts). */
export const limit2: OwnerRulesLimit = createLimit2();

export {
  BOOKING_DOORS,
  RULED_STAKES,
  WALK_NOT_BUILT,
  mayCarryOwnerRule,
  type OwnerRules,
  type PartProposal,
  type Proposals,
} from "./facts";
export {
  decideOwnerRules,
  saidWhatRuleAllowsOutcome,
  type Limit2Outcome,
  type Limit2Port,
  type OwnerRulesDecision,
  type OwnerRulesPorts,
  type PassWhy,
} from "./owner-rules";
