// L7, a decision with no safe default line (T-154; lib.js lintSteps lines 1927-1928; hasSafeDefault and isDecision,
// lines 1845-1853; DESIGN-REVIEW-10 M1).
//
// A decision is a split with a branch that an answer picks: a branch with no `when`. (A split whose every branch is
// gated is a choice the path makes, such as A4-98's "Books on the yes" or "Sam's OK first", not a question.) Every
// decision keeps its safe default as one line, "Safe default: ...", saying what happens when the answer is unclear,
// late or off-topic, so that a rebuild cannot lose it. The line may stand in the step's does, rule or more, or in a
// variant's does, rule, more or addMore. A decision anywhere in the flow without one is an error, named by its question
// (by its title when it has none).
import { isRecord, type LintContext, type LintHit, type LintRule, type LintStep } from "./runner";

/** "Safe default", in any case (lib.js SAFE_DEFAULT). */
const SAFE_DEFAULT = /\bsafe default\b/i;

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A split with a branch an answer picks: one with no `when` (lib.js isDecision). */
export function isDecision(step: LintStep): boolean {
  return step.type === "split" && (step.branches ?? []).some((branch) => !branch.when);
}

/** Does the step keep a "Safe default" line: in its does, rule or more, or in a variant's (lib.js hasSafeDefault)? */
export function hasSafeDefault(step: LintStep): boolean {
  const own: unknown[] = [step.does, step.rule, ...list(step.more)];
  const vary = isRecord(step.vary) ? step.vary : {};
  for (const patch of Object.values(vary)) {
    const words = isRecord(patch) ? patch : {};
    own.push(words.does, words.rule, ...list(words.more), ...list(words.addMore));
  }
  return own.some((line) => typeof line === "string" && SAFE_DEFAULT.test(line));
}

/** The words that name a decision in a report: its question, else its title (lib.js `s.q || s.title || ""`). */
function nameOf(step: LintStep): string {
  if (typeof step.q === "string" && step.q !== "") return step.q;
  return typeof step.title === "string" ? step.title : "";
}

/** L7: a decision with no safe default line. */
export const l7: LintRule = {
  id: "L7",
  name: "no safe default",
  source: "lib.js lintSteps lines 1927-1928, hasSafeDefault and isDecision lines 1845-1853",
  run(ctx: LintContext): LintHit[] {
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      if (!isDecision(step) || hasSafeDefault(step)) continue;
      hits.push({
        rule: "L7",
        level: "error",
        step: step.id,
        field: "q",
        text: nameOf(step),
        fix: "add its safe default as one line, 'Safe default: ...' (what happens when the answer is unclear, late or off-topic)",
      });
    }
    return hits;
  },
};
