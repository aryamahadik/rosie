// The 67 numbered judgment rules (T-1050; C-255; MC R6) and the references to them by number.
export {
  JUDGMENT_RULE_COUNT,
  JUDGMENT_RULE_HOMES,
  JUDGMENT_RULE_STEPS,
  JudgmentRuleError,
  compileJudgmentRules,
  compileTradeJudgmentRules,
  judgmentRulesOf,
  rulesOfStep,
  type JudgmentRule,
  type JudgmentRuleHome,
  type JudgmentRules,
  type RuleNodeLike,
} from "./rules";
export {
  judgmentReferences,
  referencesIn,
  resolveReference,
  ruleReferences,
  type FoundReference,
  type NumberRun,
  type ReferenceForm,
  type ReferenceProblem,
  type ResolvedReference,
  type RuleReference,
} from "./refs";
