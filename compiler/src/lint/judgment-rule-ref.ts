// A reference to a judgment rule that does not resolve (T-1050; C-255; K-01 v1 lint rule `judgment-rule-out-of-range`;
// MC R6; DECISIONS.md D2 and D3).
//
// MC R6: "'Judgment rule N' is rule N of the 67 numbered rules: 1 to 59 in steps S13-23 to S13-29, 60 to 65 in S13-53 and
// 66 to 67 in S13-54". K-01 v1 refuses a 'judgment rule N' outside 1 to 67 (a step's more check; its judgmentRuleNumber,
// which refuse-judgment-rule-out-of-range.json's judgmentRules [68] breaks), and "A 'judgment rule N' outside 1 to 67, or
// that does not resolve, is refused" (its judgmentRule). So the rule fails each reference that names no rule of the flow.
//
// What is read, on each step the runner hands the rules (ctx.pageOrder, branch steps included):
//   - every line of the step, as L8 reads them (l8.ts stepLines, lib.js stepLines): its title, does, rule, question and
//     `as`; each more line; each message with its element's words; its form, table, plug-in slot and swaps; each
//     variant's the same; each branch's label and endText. Each reference in them (routing/judgment-rules refs.ts: a
//     "judgment rule N" pointer, "<step> rule N" and a bare "rule N", lists and ranges spread out) is resolved;
//   - a compiled step's own judgmentRules list (K-01 step.judgmentRules: the rules its lines point to, by number), as
//     K-01's fixture writes it: each entry must be the number of one of the flow's rules.
// What does not resolve (refs.ts): a number outside 1 to 67; a number the named step does not hold ("S13-28 rule 60");
// a range from high to low; a number of a step that numbers no rules ("S13-32 rule 3", which phase 5 HUB-READ.md 2.2
// took out of A7-11 as "a pointer to a rule number that doesn't exist"); a number the flow's list lacks.
//
// One hit per number, range or cite that does not resolve, an error on its step: its field is where the words stand
// (`more 10`, `vary 'before:full' more 2`, `judgmentRules`), its text the reference as written. T-160 writes K-01's
// lintFailure from it under the rule's K-01 id.
//
// The rules a reference resolves against: the flow's own (judgmentRulesOf its steps: the master's nine rule nodes, or a
// trade's, whose renames may change a rule's words but never its number or step), or the list the rule is given, which
// a step linted alone needs (K-01's fixture has no rule nodes beside it).
import {
  JudgmentRuleError,
  judgmentRulesOf,
  resolveReference,
  ruleReferences,
  type JudgmentRules,
  type ReferenceProblem,
  type RuleReference,
} from "../routing/judgment-rules";
import { stepLines } from "./l8";
import { LintError, type LintContext, type LintHit, type LintRule } from "./runner";

/** The rule's id: K-01 v1 lintRule `judgment-rule-out-of-range` (MC R6). */
export const JUDGMENT_RULE_REF_RULE = "judgment-rule-out-of-range";

/** What to do about a reference whose `problem` names no rule, in plain words. */
function fixFor(reference: RuleReference, problem: ReferenceProblem): string {
  const advice =
    problem.kind === "out-of-range"
      ? "point to the rule meant by its number: 1 to 59 are in S13-23 to S13-29, 60 to 65 in S13-53, 66 and 67 in S13-54 (MC R6)"
      : reference.form === "home"
        ? "point to the step alone, as HUB-READ.md 2.2 fixed A7-11's 'S13-32 rule 3', or to a judgment rule by its number"
        : "point to a rule by a number the flow holds, written low to high, with the step that holds it when a step is named";
  return `${problem.words}: ${problem.why}; ${advice}`;
}

/** An entry of a compiled step's judgmentRules, read as a reference to that one rule. */
function listedReference(entry: unknown): RuleReference {
  const words = typeof entry === "string" ? entry : JSON.stringify(entry);
  const number = typeof entry === "number" && Number.isInteger(entry) ? entry : Number.NaN;
  return { words, index: 0, form: "bare", step: null, runs: [{ from: number, to: number, words }] };
}

/** The problems of a listed entry: a number that names no rule, or an entry that is no whole number. */
function listedProblems(entry: unknown, rules: JudgmentRules): ReferenceProblem[] {
  if (typeof entry !== "number" || !Number.isInteger(entry))
    return [
      {
        kind: "unknown",
        words: listedReference(entry).words,
        why: "not a whole number: K-01's judgmentRules lists the rules by number",
      },
    ];
  return resolveReference(listedReference(entry), rules).problems;
}

/** The flow's own 67 rules, read from its steps; LintError when the steps do not hold them. */
function flowRules(ctx: LintContext): JudgmentRules {
  try {
    return judgmentRulesOf(ctx.steps, `${ctx.trade ?? "the master"}'s flow ${ctx.flow}`);
  } catch (error) {
    if (error instanceof JudgmentRuleError)
      throw new LintError(
        `${error.message}: references cannot be resolved without the flow's 67 judgment rules (give the rule the flow's list)`,
      );
    throw error;
  }
}

/**
 * The rule, resolving references against `rules` when given (a compiled list: compileJudgmentRules), else against the
 * flow's own rule nodes, read on each run.
 */
export function judgmentRuleRefRule(rules?: JudgmentRules): LintRule {
  return {
    id: JUDGMENT_RULE_REF_RULE,
    name: "judgment rule does not resolve",
    source:
      "MC R6 (DECISIONS.md D2, checked Nov 5 2026); DECISIONS.md D3's pointer lines; K-01 v1 judgmentRuleNumber, judgmentRule and the step's more check (refuse-judgment-rule-out-of-range.json); phase 5 HUB-READ.md 2.2",
    run(ctx: LintContext): LintHit[] {
      const known = rules ?? flowRules(ctx);
      const hits: LintHit[] = [];
      for (const step of ctx.pageOrder) {
        for (const [field, text] of stepLines(step))
          for (const reference of ruleReferences(text))
            for (const problem of resolveReference(reference, known).problems)
              hits.push({
                rule: JUDGMENT_RULE_REF_RULE,
                level: "error",
                step: step.id,
                field,
                text: reference.words,
                fix: fixFor(reference, problem),
              });
        const listed = (step as unknown as Record<string, unknown>).judgmentRules;
        if (!Array.isArray(listed)) continue;
        for (const entry of listed as unknown[])
          for (const problem of listedProblems(entry, known))
            hits.push({
              rule: JUDGMENT_RULE_REF_RULE,
              level: "error",
              step: step.id,
              field: "judgmentRules",
              text: problem.words,
              fix: fixFor(listedReference(entry), problem),
            });
      }
      return hits;
    },
  };
}

/** The rule on each flow's own rule nodes. */
export const judgmentRuleRef: LintRule = judgmentRuleRefRule();
