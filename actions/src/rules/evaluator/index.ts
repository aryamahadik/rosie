// The one owner rule evaluator (C-082, T-300; arch 06 line 301; arch 05 line 237), shared by limit 2 at the gate
// (actions/src/gate/limit-2) and search (C-097, the journey 4 lane), so both read K-26 v1's typed rules the same way. It
// reads nothing and writes nothing: its callers hand it the rules rows and one proposal. See evaluate.ts.

export { dayOf, evaluateRules, inDays, isDay, readRule, rulesThatApply, type RuleReading } from "./evaluate";
export {
  RULE_KINDS,
  RULE_KIND_NAMES,
  isRuleKind,
  kindEntry,
  type RuleGoverns,
  type RuleKind,
  type RuleKindEntry,
  type RuleValueType,
} from "./registry";
export type {
  Allowance,
  BrokenCheck,
  CustomerFacts,
  Day,
  DayRange,
  Money,
  NotApplicableWhy,
  NotedCheck,
  OwnerRule,
  PriceBasis,
  Proposal,
  ProposedPrice,
  RefusedRule,
  RefusedWhy,
  RuleCheck,
  RuleNote,
  RuleRow,
  RuleValue,
  RulesVerdict,
  Time,
} from "./types";
