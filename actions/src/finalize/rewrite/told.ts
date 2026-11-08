// What the one rewrite is told (arch 02 line 123: "One rewrite, told what failed"; arch 07 line 417), and the check
// details the finalize answer gives (DL-158 ruling c): each check the attempt missed and its detail, never the final parts
// it checked. Those hold filled values (codes, places, links) the composer never got (K-09 v1 finalizeMessage.response
// .checks: "for the one rewrite, C-118 sends the model only each failed check and its detail"; K-09 README default 32;
// T-310's security note b), so no detail carries one: T-312's details quote the composer's text after the fill, and a
// slot the composer glued to a letter or digit ("Open {{link.secure}}now", "Code{{visit.code}}") puts its value there.
//
// So every place of each non-empty filled value is written as its {{slot}}, whatever touches it, longest first; a detail
// that still holds a value after that is cut down to its check's name. A detail holds a value when it holds the value as
// written, its words as the master's word split reads them (lib.js clean and words: a clock time read as "time", a long
// dash as " to "), or its first words where a quote is cut short (T-312 quotes a sentence's first four words, then " ...").

import { wordsOf, type CheckName, type SlotValue } from "../checks";
import { escapeForPattern } from "../checks/reading";
import type { CheckOutcome, CheckResult } from "./types";

/** One failed check, as the rewrite is told it. */
export interface Told {
  readonly check: CheckName;
  readonly detail: string;
}

/** Where T-312 cuts a quoted sentence short (checks.ts lengthAndReadingFaults: `"${opening} ..."`). */
const CUT_SHORT = " ...";

/** Whether a detail still holds a value: as written, as the master's word split reads it, or its first words cut short. */
function holdsValue(detail: string, value: string): boolean {
  if (detail.includes(value)) return true;
  const words = wordsOf(value);
  if (words.length > 1 && detail.includes(words.join(" "))) return true;
  for (let count = 1; count < words.length; count += 1) {
    if (detail.includes(`${words.slice(0, count).join(" ")}${CUT_SHORT}`)) return true;
  }
  return false;
}

/**
 * A check's detail with no filled value in it (DL-158 ruling c): every place of each non-empty value (K-03
 * `slotValues`), glued to a letter or digit or not, written as its {{slot}}, the longest value first at each place; a
 * detail that still holds a value after that is cut down to its check's name.
 */
export function withoutValues(check: CheckName, detail: string, values: readonly SlotValue[]): string {
  const filled = values
    .filter((fact) => fact.value.trim() !== "")
    .sort((a, b) => b.value.length - a.value.length);
  if (filled.length === 0) return detail;
  const slotOf = new Map<string, string>();
  for (const fact of filled) if (!slotOf.has(fact.value)) slotOf.set(fact.value, fact.slot);
  const places = new RegExp([...slotOf.keys()].map(escapeForPattern).join("|"), "gu");
  const written = detail.replace(places, (value) => `{{${slotOf.get(value) ?? ""}}}`);
  return filled.some((fact) => holdsValue(written, fact.value)) ? check : written;
}

/** One attempt's checks with no filled value in any detail (withoutValues): what the finalize answer gives. */
export function checksWithoutValues(
  checks: readonly CheckOutcome[],
  values: readonly SlotValue[],
): CheckOutcome[] {
  return checks.map((outcome) => ({
    check: outcome.check,
    passed: outcome.passed,
    detail: outcome.detail === null ? null : withoutValues(outcome.check, outcome.detail, values),
  }));
}

/**
 * What the one rewrite is told for a check result: each missed check and its detail, in K-03's order, with no filled
 * value in it (withoutValues, against the result's `checked.slotValues`). Empty when every check passed.
 */
export function rewriteTold(result: CheckResult): Told[] {
  return checksWithoutValues(result.checks, result.checked.slotValues).flatMap((check): Told[] =>
    check.passed || check.detail === null ? [] : [{ check: check.check, detail: check.detail }],
  );
}
