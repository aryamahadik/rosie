// The checks on a rewrite request before any call (T-374, C-118). In this order:
//
//   1. never a second rewrite: a told from the one rewrite's own failure (attempt `rewrite`) is the second failure, so
//      the answer is 'use the fallback', whatever else the request holds, and no call is made (arch 02 line 123: "Fails
//      again: the step's fallback text"; arch 07 line 417); any attempt but `composed` and `rewrite` is refused;
//   2. the request holds input, plan, attempt and told, and nothing else, so no check result's final parts (whose slot
//      values the composer never got: K-09 v1 finalizeMessage.response.checks, DL-158 ruling c) ride in with it;
//   3. the input is a K-03 v1.1 composeInput with no frontier, as compose checks it (check.ts inputProblems);
//   4. the plan to fix is one the composer could have returned for this input (check.ts planAgainstInput): a K-03 v1
//      plan, its formats allowed, no literal value no fact holds. It goes back to the model as data, so a filled plan, or
//      one that types a value, is refused here rather than shown. A plan whose only problems are the reader checks'
//      (T-375's relay quote, sensitive work, tone and language: the last stage of planAgainstInput) is taken: it is a
//      whole plan that keeps to its formats and its facts, one compose returned and its own reader checks refused, which
//      gets the one rewrite too (T-1535, DL-1157: S1-02's "Hi!" on a gentle row; arch 02 line 123, arch 07 line 417);
//   5. the told is what rewriteTold gives: at least one failed check, each a K-03 check name, at most once, with its
//      detail in words; nothing else. For a plan the reader checks refuse, the told is instead exactly the reader checks
//      it fails, each once, each with exactly the places it fails at as its detail (named by check and field, nothing
//      else): never a K-03 check, which finalize never ran on it, and never a reader check for a plan that passes them.
//
// A refusal names checks and places, never words (K-08 README line 75).

import { inputProblems, planAgainstInput } from "../check";
import type { ComposeInput } from "../prompt";
import { CHECK_NAMES } from "../schema";
import type { ComposeProblem } from "../types";
import { PLACES_JOINER, READER_CHECKS, type RewriteProblem, type RewriteRequest } from "./types";

const REQUEST_KEYS = ["input", "plan", "attempt", "told"] as const;
const TOLD_KEYS = ["check", "detail"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly these keys, each present. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** A problem of the reader checks' stage (./types.ts READER_CHECKS). */
const isReaderProblem = (problem: ComposeProblem): boolean =>
  (READER_CHECKS as readonly string[]).includes(problem.check);

/**
 * True when a plan's problems (check.ts planAgainstInput) are the reader checks' alone: the plan is a whole K-03 plan that
 * keeps to its formats and its facts, and only what its reader must read failed (T-1535).
 */
export function readerProblemsOnly(problems: readonly ComposeProblem[]): boolean {
  return problems.length > 0 && problems.every(isReaderProblem);
}

/**
 * Whether a told item names a reader check the plan fails, with exactly the places it fails at as its detail: each place
 * once, in any order, joined by PLACES_JOINER, and no other words.
 */
function namesReaderPlaces(check: string, detail: string, reader: readonly ComposeProblem[]): boolean {
  const places = new Set(reader.filter((problem) => problem.check === check).map((problem) => problem.at));
  const named = detail.split(PLACES_JOINER);
  return (
    places.size > 0 &&
    named.length === places.size &&
    new Set(named).size === named.length &&
    named.every((place) => places.has(place))
  );
}

/**
 * Each way `value` is not what rewriteTold gives: a list of at least one failed check, each `{ check, detail }` with a
 * K-03 check name, each check once, and a detail that holds words. With `reader`, the reader checks' problems of a plan
 * they refuse, it must instead tell exactly those checks, each once, each with exactly the places it fails at (T-1535).
 * One problem per place; empty when it is whole.
 */
export function toldProblems(value: unknown, reader: readonly ComposeProblem[] = []): RewriteProblem[] {
  if (!Array.isArray(value) || value.length === 0) return [{ check: "told", at: "told" }];
  const problems: RewriteProblem[] = [];
  const seen = new Set<string>();
  const named = (check: string, detail: string): boolean =>
    reader.length === 0 ? CHECK_NAMES.includes(check) : namesReaderPlaces(check, detail, reader);
  (value as unknown[]).forEach((item, k) => {
    if (
      isRecord(item) &&
      exactKeys(item, TOLD_KEYS) &&
      typeof item.check === "string" &&
      !seen.has(item.check) &&
      typeof item.detail === "string" &&
      item.detail.trim() !== "" &&
      named(item.check, item.detail)
    ) {
      seen.add(item.check);
      return;
    }
    problems.push({ check: "told", at: `told[${String(k)}]` });
  });
  // A reader told leaves none of the plan's failed reader checks out.
  if (problems.length === 0 && reader.some((problem) => !seen.has(problem.check)))
    problems.push({ check: "told", at: "told" });
  return problems;
}

/** Each place of `problems` as the request names it, under `plan`, once each. */
function planPlaces(problems: readonly ComposeProblem[]): RewriteProblem[] {
  const places = problems.map((problem) => (problem.at === "(root)" ? "plan" : `plan.${problem.at}`));
  return [...new Set(places)].map((at): RewriteProblem => ({ check: "planToFix", at }));
}

/**
 * Each place where the plan to fix is not one the composer could have returned for this input (check.ts
 * planAgainstInput), once each, under `plan`. A plan whose only problems are the reader checks' has none (T-1535).
 */
export function planToFixProblems(plan: unknown, input: ComposeInput): RewriteProblem[] {
  const problems = planAgainstInput(plan, input);
  return readerProblemsOnly(problems) ? [] : planPlaces(problems);
}

/** What a request comes to before any call. */
export type RequestChecked =
  | { readonly kind: "secondFailure" }
  | {
      readonly kind: "refused";
      readonly stage: "input" | "request";
      readonly problems: readonly (ComposeProblem | RewriteProblem)[];
    }
  | { readonly kind: "rewrite"; readonly request: RewriteRequest };

/**
 * Checks a rewrite request in the order at the top of this file. The types say a RewriteRequest; a caller that casts is
 * still checked.
 */
export function checkRequest(value: unknown): RequestChecked {
  if (!isRecord(value))
    return { kind: "refused", stage: "request", problems: [{ check: "request", at: "(root)" }] };
  if (value.attempt === "rewrite") return { kind: "secondFailure" };
  if (value.attempt !== "composed")
    return { kind: "refused", stage: "request", problems: [{ check: "attempt", at: "attempt" }] };
  if (!exactKeys(value, REQUEST_KEYS))
    return { kind: "refused", stage: "request", problems: [{ check: "request", at: "(root)" }] };

  const before = inputProblems(value.input);
  if (before.length > 0) return { kind: "refused", stage: "input", problems: before };
  const input = value.input as ComposeInput;
  const planned = planAgainstInput(value.plan, input);
  const reader = readerProblemsOnly(planned) ? planned : [];
  const problems = [...(reader.length > 0 ? [] : planPlaces(planned)), ...toldProblems(value.told, reader)];
  if (problems.length > 0) return { kind: "refused", stage: "request", problems };
  return { kind: "rewrite", request: value as unknown as RewriteRequest };
}
