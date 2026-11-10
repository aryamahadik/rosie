// The relay's quote (T-375, C-118; arch 07 line 359: "Relays name the sender and quote them in a code-filled slot,
// translated with the original kept (S13-37)"; K-03 slots.json relay.quote: "A relayed person's words, quoted in a
// code-filled slot and translated with the original kept; private or doubtful words go as 'Read it on the secure
// page'"; S13-37: "Messages to and from staff are translated, with the original kept").
//
// The quote is the sender's own words: the slot filler (C-088) puts them in {{relay.quote}} from the record, after the
// edge scrub and limit 7 (C-091), which gives them to staff or the owner only with nothing private in them, else as
// "Read it on the secure page" (RULES 4.5; S13-28 rule 44); the Values check leaves the quote whole at its own place
// (arch 07 line 409; T-312 round 2). A plan keeps to that when:
//
//   1. a row that gives the quote (a relay.quote fact) quotes it through {{relay.quote}} exactly once: once, so the
//      original is kept, and only once, since a second place would read as the model's own words (CQ-109's default:
//      "One relay.quote per plan is the composer's rule; a later task refuses a second in the plan check");
//   2. a row that gives no quote writes no {{relay.quote}}: its reader may not see one, or there is none;
//   3. the plan never types the quote: no run of the quote's words, nor of a sample quote (a relay.quote slot's example
//      words, in the master line or the plan: S13-28 rule 51, "Every fact comes from the booking, never the example"),
//      stands in the model's own words. A run is 4 words in a row, or the whole of a quote of 3 words; a quote of 1 or 2
//      words is too short to tell a copy from the model's own words ("Yes please").
//
// The translation the reader needs is the model's own words in <language>, beside the slot (K-03 v1 has no translation
// slot: CQ-66's default 1, the quote exempt as a whole at its own place only). It shares no run of words with an
// original in another language, and the Values check reads its values as the model's (arch 07 line 409: "inside its
// translation"). Code's own readings in the slot are not the sender's words: the plan may point to the secure page in
// its own words, as plan-relay-private-a7-12.json does.

import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeProblem } from "../types";
import {
  QUOTE_SLOT,
  addOnce,
  holdsRun,
  ownWords,
  planFields,
  runsOf,
  slotsIn,
  termWords,
  wordsOf,
} from "./words";

export { QUOTE_SLOT };

/** Limit 7's reading of a secure-page-only field: the private quote's words (K-03 fact.value; S13-28 rule 44). */
export const SECURE_PAGE_READING = "Read it on the secure page";

/** Crisis words as they reach a reader: staff, then the owner (arch 07 line 359; S13-10; A3-25). */
export const CRISIS_READINGS: readonly string[] = Object.freeze([
  "Urgent: open the secure page now",
  "Urgent: a customer may need help",
]);

/** Code's own readings in the quote slot, never the sender's words. */
export const CODE_READINGS: readonly string[] = Object.freeze([SECURE_PAGE_READING, ...CRISIS_READINGS]);

/** The words in a row that make a typed quote. */
export const QUOTE_RUN = 4;
/** A quote of fewer words is never read as typed. */
export const SHORTEST_QUOTE = 3;

const reading = (text: string): string =>
  text
    .normalize("NFC")
    .trim()
    .replace(/[.!]+$/u, "")
    .toLowerCase();
const READINGS: ReadonlySet<string> = new Set(CODE_READINGS.map(reading));

/** Whether a quote's words are one of code's own readings ("Read it on the secure page", with or without its stop). */
export const isCodeReading = (text: string): boolean => READINGS.has(reading(text));

/** The row's quote: the value of its relay.quote fact, or undefined when the row gives none. */
export function quoteOf(input: ComposeInput): string | undefined {
  for (const fact of input.facts) if ("slot" in fact && fact.slot === QUOTE_SLOT) return fact.value;
  return undefined;
}

/**
 * The runs of words that would be a typed quote: of the row's quote (unless it is one of code's readings) and of every
 * sample quote the master line or the plan writes in a relay.quote slot.
 */
function typedQuoteRuns(plan: MessagePlan, input: ComposeInput): string[][] {
  const quotes: string[] = [];
  const quote = quoteOf(input);
  if (quote !== undefined && !isCodeReading(quote)) quotes.push(quote);
  const texts = [input.masterText.text, ...planFields(plan).map((field) => field.text)];
  for (const text of texts)
    for (const slot of slotsIn(text))
      if (slot.name === QUOTE_SLOT && slot.example !== null) quotes.push(slot.example);
  return quotes.flatMap((words) => {
    const said = wordsOf(words);
    return said.length < SHORTEST_QUOTE ? [] : runsOf(said, Math.min(QUOTE_RUN, said.length));
  });
}

/**
 * Each way the plan does not quote the relay as rules 1 to 3 above say, one problem per place: a field with a
 * {{relay.quote}} past the first, one on a row that gives no quote, or a typed quote; "(root)" when a row that gives the
 * quote never quotes it. Names the check and the place, never words.
 */
export function quoteProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  const given = quoteOf(input) !== undefined;
  const terms = termWords(input);
  const typed = typedQuoteRuns(plan, input);
  const problems: ComposeProblem[] = [];
  let quoted = 0;
  for (const field of planFields(plan)) {
    const slots = slotsIn(field.text).filter((slot) => slot.name === QUOTE_SLOT).length;
    if (slots > 0 && (!given || quoted + slots > 1)) addOnce(problems, { check: "relayQuote", at: field.at });
    quoted += slots;
    const own = wordsOf(ownWords(field.text, terms));
    if (typed.some((run) => holdsRun(own, run))) addOnce(problems, { check: "relayQuote", at: field.at });
  }
  if (given && quoted === 0) addOnce(problems, { check: "relayQuote", at: "(root)" });
  return problems;
}
