// What the one rewrite is told (arch 02 line 123: "One rewrite, told what failed"; arch 07 line 417): each check the
// attempt missed and its detail, never the final parts it checked. Those hold filled values (codes, places, links) the
// composer never got (K-09 v1 finalizeMessage.response.checks: "for the one rewrite, C-118 sends the model only each
// failed check and its detail"; K-09 README default 32; T-310's security note b), so they never go back to the model.
//
// The details name slots, option ids and formats (T-310, T-311, T-312, parts.ts); as a last guard, any filled value that
// stands whole in a detail is written as its slot instead, so no value reaches the model by way of a detail.

import { escapeForPattern } from "../checks/reading";
import type { CheckName } from "../checks";
import type { CheckResult } from "./types";

/** One failed check, as the rewrite is told it. */
export interface Told {
  readonly check: CheckName;
  readonly detail: string;
}

/** A value's whole places: no letter or digit right before or after it. */
const wholePlaces = (value: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeForPattern(value)}(?![\\p{L}\\p{N}])`, "gu");

/**
 * What the one rewrite is told for a check result: each missed check and its detail, in K-03's order, with every filled
 * value (K-03 `checked.slotValues`, longest first) written as its {{slot}}. Empty when every check passed.
 */
export function rewriteTold(result: CheckResult): Told[] {
  const values = result.checked.slotValues
    .filter((fact) => fact.value.trim() !== "")
    .sort((a, b) => b.value.length - a.value.length);
  return result.checks.flatMap((check): Told[] => {
    if (check.passed || check.detail === null) return [];
    const detail = values.reduce(
      (text, fact) => text.replace(wholePlaces(fact.value), () => `{{${fact.slot}}}`),
      check.detail,
    );
    return [{ check: check.check, detail }];
  });
}
