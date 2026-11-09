// References to the judgment rules by number, and what they resolve to (T-1050; MC R6; DECISIONS.md D2 and D3; K-01 v1
// step.judgmentRules: "'judgment rule N' pointers ... by number, each resolving to rule N of the flow's judgmentRules").
//
// The forms (case aside), each a run of numbers joined by ",", "and", "or" (a list) or "to", "-", "–" (a range, spread
// out), as the master's own ripple tool reads a pointer (phase3 tools/ripple/deps.js jrulesIn):
//   judgment  "judgment rule 25", "judgment rules 45 and 46", "judgment rules 16 to 24", "judgment rules 33, 35 and 36":
//             D3's pointer lines, the form every step uses (D2: "Every other step points to it by number").
//   step      "S13-28 rule 48", "S13-27 rules 35 and 36": R6's numbers with the step that holds them, as RULES.md cites
//             them (MC C6 cites "S13-28 rule 51", the cards "S13-54 rule 67"). The step id stands right before "rule",
//             with only spaces between; after a comma it is a cite of its own ("(S13-35, rule 49)" is a bare rule 49).
//   bare      "rule 49", "rules 6 to 8": R6's numbers alone.
//   home      "S13-55 rule 7": a step that is not one of the nine, with a number of that step's own. The master numbers no
//             other step's rules (phase 5 HUB-READ.md 2.2: "S13-32 has no numbered rules", so A7-11's "S13-32 rule 3" was
//             "a pointer to a rule number that doesn't exist" and came out), so such a cite is never read as a judgment rule
//             and resolves to no rule.
// A number is digits standing alone ("3pm" and "2nd" are not numbers here); "rule" inside a word ("overrule") is not read.
//
// What does not resolve (a ReferenceProblem): a number outside 1 to 67 (`out-of-range`, K-01's refusal); a number that is
// not one of the flow's rules, a number the named step does not hold ("S13-28 rule 60": 60 is in S13-53), a range that
// runs from high to low, and a home cite (`unknown`).
import type { StepId } from "../../graph/types.ts";
import { JUDGMENT_RULE_COUNT, JUDGMENT_RULE_STEPS, type JudgmentRule, type JudgmentRules } from "./rules";

/** How a reference names its rules (see the head of this file). */
export type ReferenceForm = "judgment" | "step" | "bare" | "home";

/** One number, or a range of them, as a reference writes it: "25" (from = to), "16 to 24". */
export interface NumberRun {
  from: number;
  to: number;
  words: string;
}

/** One reference to rules by number in a text. */
export interface RuleReference {
  /** The words as written: "judgment rules 16 to 24", "S13-28 rule 51", "rule 49". */
  words: string;
  /** Where the words start in the text. */
  index: number;
  form: ReferenceForm;
  /** The step written before "rule" (forms step and home), else null. */
  step: StepId | null;
  /** The numbers, in the order written. */
  runs: NumberRun[];
}

/** Why a reference, or one of its numbers, does not resolve. */
export interface ReferenceProblem {
  /** `out-of-range`: outside 1 to 67 (K-01 v1's judgmentRuleNumber); `unknown`: any other number that names no rule. */
  kind: "out-of-range" | "unknown";
  /** The number, range or cite that does not resolve, as written. */
  words: string;
  why: string;
}

/** A reference with what it resolves to. */
export interface ResolvedReference extends RuleReference {
  /** The rules it names, in the order named, each once. */
  rules: JudgmentRule[];
  /** Empty when every number resolves. */
  problems: ReferenceProblem[];
}

/** A reference found in a file: the path of the words that hold it, and those words. */
export interface FoundReference extends ResolvedReference {
  path: string;
  text: string;
}

const NUMBER = String.raw`\d+(?!\w)`;
const JOIN = String.raw`(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|to)\s+|\s*[-–]\s*)`;
const REFERENCE = new RegExp(
  String.raw`(?<![\w-])(?:(judgment)\s+|([SAB]\d{1,2}-\d{2,3})\s+)?rules?\s+(${NUMBER}(?:${JOIN}${NUMBER})*)`,
  "gi",
);

/** The runs of a reference's numbers: a list split at ",", "and" and "or"; a part with "to", "-" or "–" a range. */
function runsOf(numbers: string): NumberRun[] {
  const runs: NumberRun[] = [];
  for (const part of numbers.split(/\s*(?:,|\band\b|\bor\b)\s*/i)) {
    const words = part.trim();
    const found = words.match(/\d+/g) ?? [];
    if (found.length === 1) runs.push({ from: Number(found[0]), to: Number(found[0]), words });
    for (let k = 0; k + 1 < found.length; k += 1)
      runs.push({ from: Number(found[k]), to: Number(found[k + 1]), words });
  }
  return runs;
}

/** Every reference to rules by number in a text, in the order written. */
export function ruleReferences(text: string): RuleReference[] {
  const out: RuleReference[] = [];
  for (const found of text.matchAll(REFERENCE)) {
    const [words, judgment, step, numbers = ""] = found;
    const id = step === undefined ? null : step.toUpperCase();
    const form: ReferenceForm =
      judgment !== undefined
        ? "judgment"
        : id === null
          ? "bare"
          : JUDGMENT_RULE_STEPS.includes(id)
            ? "step"
            : "home";
    out.push({ words, index: found.index, form, step: id, runs: runsOf(numbers) });
  }
  return out;
}

/** What `reference` resolves to among the flow's `rules` (compileJudgmentRules), with each number that does not. */
export function resolveReference(reference: RuleReference, rules: JudgmentRules): ResolvedReference {
  const named: JudgmentRule[] = [];
  const problems: ReferenceProblem[] = [];
  if (reference.form === "home") {
    problems.push({
      kind: "unknown",
      words: reference.words,
      why: `${String(reference.step)} has no numbered rules: the master numbers only the 67 judgment rules, in ${JUDGMENT_RULE_STEPS.join(", ")} (MC R6; phase 5 HUB-READ.md 2.2)`,
    });
    return { ...reference, rules: named, problems };
  }
  const byNumber = new Map(rules.rules.map((rule) => [rule.number, rule]));
  for (const run of reference.runs) {
    if (run.from > run.to) {
      problems.push({
        kind: "unknown",
        words: run.words,
        why: "the range runs from high to low, so it names no rule",
      });
      continue;
    }
    if (run.from < 1 || run.to > JUDGMENT_RULE_COUNT)
      problems.push({
        kind: "out-of-range",
        words: run.words,
        why: `outside 1 to ${String(JUDGMENT_RULE_COUNT)}: the judgment rules are numbered 1 to ${String(JUDGMENT_RULE_COUNT)} (MC R6)`,
      });
    for (let n = Math.max(run.from, 1); n <= Math.min(run.to, JUDGMENT_RULE_COUNT); n += 1) {
      const rule = byNumber.get(n);
      if (rule === undefined) {
        problems.push({
          kind: "unknown",
          words: String(n),
          why: `rule ${String(n)} is not one of the flow's judgment rules`,
        });
        continue;
      }
      if (reference.form === "step" && rule.step !== reference.step) {
        problems.push({
          kind: "unknown",
          words: String(n),
          why: `rule ${String(n)} is in ${rule.step}, not in ${String(reference.step)} (MC R6)`,
        });
        continue;
      }
      if (!named.includes(rule)) named.push(rule);
    }
  }
  return { ...reference, rules: named, problems };
}

/** Every reference in a text, each with what it resolves to among `rules`. */
export function judgmentReferences(text: string, rules: JudgmentRules): ResolvedReference[] {
  return ruleReferences(text).map((reference) => resolveReference(reference, rules));
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every reference in a parsed JSON value (a flow file, a trade file), each with the path of the words that hold it and
 * what it resolves to among `rules`: every string is read, an object's keys too (a trade's free-text blocks have keys
 * in words). `at` starts each path.
 */
export function referencesIn(value: unknown, rules: JudgmentRules, at: string): FoundReference[] {
  const out: FoundReference[] = [];
  const read = (text: string, path: string): void => {
    for (const reference of ruleReferences(text))
      out.push({ ...resolveReference(reference, rules), path, text });
  };
  const walk = (item: unknown, path: string): void => {
    if (typeof item === "string") read(item, path);
    else if (Array.isArray(item))
      (item as unknown[]).forEach((inner, k) => {
        walk(inner, `${path}[${String(k)}]`);
      });
    else if (isObj(item))
      for (const [key, inner] of Object.entries(item)) {
        read(key, `${path} key '${key}'`);
        walk(inner, `${path}.${key}`);
      }
  };
  walk(value, at);
  return out;
}
