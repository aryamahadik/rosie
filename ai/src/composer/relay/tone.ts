// Tone by the situation tag (T-375, C-118; arch 07 line 357: "Tone by situation tag, set by code; the first that fits
// wins (DD). Grief, safety or sensitive work (a safety outcome other than No, a death report, the sensitive switch):
// gentle, no '!' (S13-22)"; S13-22: "Gentle words in every message").
//
// Code sets the tag (C-090, T-309: never the composer's) and the composer follows it: it gives the tag to the model as
// <situation>, as it is, and holds a gentle row's plan to the one rule of that tone that words can be checked for: no
// exclamation mark in the model's own words, in any language ("¡" opens one in Spanish). A gentle row is one tagged
// gentle, or one whose service limit 7 gave as nothing (./sensitive.ts gentleRow). The other tones' rules (calm and
// blaming no one for a problem; exact amounts and dates as slots for money or consent; brief and warm when routine) are
// the prompt's (rule 8) and, for amounts and dates, the literal check's (../check.ts); no check can read warmth.

import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeProblem } from "../types";
import { gentleRow } from "./sensitive";
import { ownWords, planFields, termWords } from "./words";

/** An exclamation mark, opening or closing, in any of its forms. */
export const EXCLAMATION = /[!¡！‼⁉]/u;

/** Each words field of a gentle row's plan whose own words hold an exclamation mark; empty for any other row. */
export function toneProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  if (!gentleRow(input)) return [];
  const terms = termWords(input);
  return planFields(plan)
    .filter((field) => EXCLAMATION.test(ownWords(field.text, terms)))
    .map((field): ComposeProblem => ({ check: "tone", at: field.at }));
}
