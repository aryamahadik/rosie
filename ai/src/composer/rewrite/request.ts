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
//      one that types a value, is refused here rather than shown;
//   5. the told is what rewriteTold gives: at least one failed check, each a K-03 check name, at most once, with its
//      detail in words; nothing else.
//
// A refusal names checks and places, never words (K-08 README line 75).

import { inputProblems, planAgainstInput } from "../check";
import type { ComposeInput } from "../prompt";
import { CHECK_NAMES } from "../schema";
import type { ComposeProblem } from "../types";
import type { RewriteProblem, RewriteRequest } from "./types";

const REQUEST_KEYS = ["input", "plan", "attempt", "told"] as const;
const TOLD_KEYS = ["check", "detail"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly these keys, each present. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/**
 * Each way `value` is not what rewriteTold gives: a list of at least one failed check, each `{ check, detail }` with a
 * K-03 check name, each check once, and a detail that holds words. One problem per place; empty when it is whole.
 */
export function toldProblems(value: unknown): RewriteProblem[] {
  if (!Array.isArray(value) || value.length === 0) return [{ check: "told", at: "told" }];
  const problems: RewriteProblem[] = [];
  const seen = new Set<string>();
  (value as unknown[]).forEach((item, k) => {
    if (
      isRecord(item) &&
      exactKeys(item, TOLD_KEYS) &&
      typeof item.check === "string" &&
      CHECK_NAMES.includes(item.check) &&
      !seen.has(item.check) &&
      typeof item.detail === "string" &&
      item.detail.trim() !== ""
    ) {
      seen.add(item.check);
      return;
    }
    problems.push({ check: "told", at: `told[${String(k)}]` });
  });
  return problems;
}

/**
 * Each place where the plan to fix is not one the composer could have returned for this input (check.ts
 * planAgainstInput), once each, under `plan`.
 */
export function planToFixProblems(plan: unknown, input: ComposeInput): RewriteProblem[] {
  const places = planAgainstInput(plan, input).map((problem) =>
    problem.at === "(root)" ? "plan" : `plan.${problem.at}`,
  );
  return [...new Set(places)].map((at): RewriteProblem => ({ check: "planToFix", at }));
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
  const problems = [...planToFixProblems(value.plan, input), ...toldProblems(value.told)];
  if (problems.length > 0) return { kind: "refused", stage: "request", problems };
  return { kind: "rewrite", request: value as unknown as RewriteRequest };
}
