// The 67 numbered judgment rules (T-1050; C-255; K-01 v1 `judgmentRules` of `routingTables`).
//
// Master Corrections R6: "'Judgment rule N' is rule N of the 67 numbered rules: 1 to 59 in steps S13-23 to S13-29, 60
// to 65 in S13-53 and 66 to 67 in S13-54 (DECISIONS.md D2, checked Nov 5 2026)". D2: the nine rule nodes "open section
// 13 with the 67 numbered rules ... word for word", every other step "points to it by number", and "the numbers 1 to 67
// are frozen". So the rules are read from the flow itself, not typed here: each `more` line of a rule node (kind: rule)
// that starts with its number, `<N>. <text>`, is rule N, its text the rest of the line, word for word, and its step the
// node that holds it. This is how the master's own ripple tool reads them (phase3 tools/ripple/deps.js jruleMap: a
// rule node's `more` line matching /^\s*(\d{1,3})\.\s/). A line with no number, such as the nine lines after rule 36
// in S13-27, belongs to no numbered rule: it stays in the rule node's own text (the always-on prefix, T-146).
//
// What is refused (JudgmentRuleError, naming the place): one of the nine steps missing, not a rule node, switched off by
// a trade, or holding no numbered line; a numbered line in any other rule node; a number given twice, missing, out of
// page order, or in a step R6 does not give it (60 in S13-29, say). So a flow that compiles holds rules 1 to 67, each
// once, 1 to 59 from S13-23 to S13-29, 60 to 65 from S13-53 and 66 and 67 from S13-54.
//
// A trade's flow (overlay/apply.ts) reads the same way: no trade op touches the nine steps in fixture set v1, and a
// trade's rename pairs may change a rule's words (funeral's 61 and 65, advisor's 47 and 61), never its number or step.
// The bundle carries each master flow's list (K-01 flowGraph.routing.judgmentRules); `RuleReference`s (refs.ts) resolve
// against it.
import type { FlowGraph, StepId } from "../../graph/types.ts";
import type { AppliedTrade } from "../../overlay/apply";

/** A flow whose judgment rules are not the 67 R6 numbers. The message names the place. */
export class JudgmentRuleError extends Error {
  override name = "JudgmentRuleError";
}

/** One numbered judgment rule, as K-01 v1 `judgmentRule` holds it: its number, its words and the step it comes from. */
export interface JudgmentRule {
  number: number;
  text: string;
  step: StepId;
}

/** K-01 v1 `judgmentRules`: the 67 rules in number order. */
export interface JudgmentRules {
  rules: JudgmentRule[];
}

/** How many numbered rules there are (MC R6; DECISIONS.md D2: "The numbers 1 to 67 are frozen"). */
export const JUDGMENT_RULE_COUNT = 67;

/** One part of MC R6: the steps that hold a run of the numbers. */
export interface JudgmentRuleHome {
  readonly steps: readonly StepId[];
  readonly first: number;
  readonly last: number;
}

/** MC R6, word for word: 1 to 59 in S13-23 to S13-29, 60 to 65 in S13-53 and 66 to 67 in S13-54. */
export const JUDGMENT_RULE_HOMES: readonly JudgmentRuleHome[] = [
  { steps: ["S13-23", "S13-24", "S13-25", "S13-26", "S13-27", "S13-28", "S13-29"], first: 1, last: 59 },
  { steps: ["S13-53"], first: 60, last: 65 },
  { steps: ["S13-54"], first: 66, last: 67 },
];

/** The nine steps that hold the numbered rules, in R6's order (D2: S13-53 right after S13-29, S13-54 after S13-53). */
export const JUDGMENT_RULE_STEPS: readonly StepId[] = JUDGMENT_RULE_HOMES.flatMap((home) => home.steps);

/** A numbered line of a rule node: its number, then a dot and a space (deps.js jruleMap). */
const NUMBERED = /^\s*(\d{1,3})\.\s+([\s\S]*)$/;

/** What is read of a step: its id, kind, lines, a trade's `off` and its branches' steps. */
export interface RuleNodeLike {
  readonly id: StepId;
  readonly kind?: unknown;
  readonly more?: unknown;
  readonly off?: unknown;
  readonly branches?: readonly { readonly steps?: readonly RuleNodeLike[] }[];
}

function eachStep(steps: readonly RuleNodeLike[], visit: (step: RuleNodeLike) => void): void {
  for (const step of steps) {
    visit(step);
    for (const branch of step.branches ?? []) eachStep(branch.steps ?? [], visit);
  }
}

/** The run of numbers R6 gives to a step, or null for a step that holds none. */
function homeOf(id: StepId): JudgmentRuleHome | null {
  return JUDGMENT_RULE_HOMES.find((home) => home.steps.includes(id)) ?? null;
}

/**
 * The 67 judgment rules of a flow's steps (nested, branch steps included), in number order. `at` names the flow in an
 * error. Throws JudgmentRuleError when the steps do not hold rules 1 to 67 where MC R6 puts them.
 */
export function judgmentRulesOf(steps: readonly RuleNodeLike[], at: string): JudgmentRules {
  const found = new Map<StepId, RuleNodeLike>();
  const rules: JudgmentRule[] = [];
  eachStep(steps, (step) => {
    if (step.kind !== "rule") return;
    const lines = Array.isArray(step.more) ? (step.more as unknown[]) : [];
    const home = homeOf(step.id);
    if (home === null) {
      for (const line of lines)
        if (typeof line === "string" && NUMBERED.test(line))
          throw new JudgmentRuleError(
            `${at}: ${step.id} has the numbered line '${line.slice(0, 60)}', but the numbered rules are only in ${JUDGMENT_RULE_STEPS.join(", ")} (MC R6)`,
          );
      return;
    }
    if (found.has(step.id)) throw new JudgmentRuleError(`${at}: ${step.id} is listed twice`);
    found.set(step.id, step);
    if (step.off !== undefined)
      throw new JudgmentRuleError(
        `${at}: ${step.id} is switched off (${typeof step.off === "string" ? step.off : JSON.stringify(step.off)}), but every judgment rule holds in every flow (MC R6)`,
      );
    let held = 0;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      const numbered = NUMBERED.exec(line);
      if (numbered === null) continue;
      const number = Number(numbered[1]);
      if (number < home.first || number > home.last)
        throw new JudgmentRuleError(
          `${at}: ${step.id} holds rule ${String(number)}, but MC R6 puts rules ${String(home.first)} to ${String(home.last)} in ${home.steps.join(", ")}`,
        );
      rules.push({ number, text: numbered[2] ?? "", step: step.id });
      held += 1;
    }
    if (held === 0) throw new JudgmentRuleError(`${at}: ${step.id} holds no numbered rule (MC R6)`);
  });
  for (const id of JUDGMENT_RULE_STEPS)
    if (!found.has(id))
      throw new JudgmentRuleError(
        `${at}: ${id} is not a rule node of the flow, but MC R6 puts judgment rules in it`,
      );

  rules.forEach((rule, k) => {
    const number = k + 1;
    if (rule.number !== number) {
      const twice = rules.findIndex((other) => other.number === rule.number) !== k;
      throw new JudgmentRuleError(
        twice
          ? `${at}: rule ${String(rule.number)} is given twice (${rules
              .filter((other) => other.number === rule.number)
              .map((other) => other.step)
              .join(", ")})`
          : `${at}: rule ${String(number)} is missing or out of order: ${rule.step} gives rule ${String(rule.number)} in its place (the numbers run 1 to 67 in page order, MC R6)`,
      );
    }
  });
  if (rules.length !== JUDGMENT_RULE_COUNT)
    throw new JudgmentRuleError(
      `${at}: ${String(rules.length)} numbered rules, expected ${String(JUDGMENT_RULE_COUNT)} (MC R6)`,
    );
  return { rules };
}

/** The 67 judgment rules of a master flow (T-132's loaded flow): what the bundle carries in routing.judgmentRules. */
export function compileJudgmentRules(graph: FlowGraph): JudgmentRules {
  return judgmentRulesOf(graph.path, `master-${graph.flow}.json judgment rules`);
}

/** The 67 judgment rules of one trade's flow (overlay/apply.ts): the master's numbers and steps, in the trade's words. */
export function compileTradeJudgmentRules(applied: AppliedTrade): JudgmentRules {
  return judgmentRulesOf(applied.flow.steps, `${applied.trade} flow ${applied.flow.id} judgment rules`);
}

/** The rules a step holds (one of the nine), in number order; none for any other step. */
export function rulesOfStep(rules: JudgmentRules, step: StepId): JudgmentRule[] {
  return rules.rules.filter((rule) => rule.step === step);
}
