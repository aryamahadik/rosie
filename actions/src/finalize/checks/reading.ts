// How the message checks read the final parts (arch 07 lines 361, 409 to 417): what code inserted (fixed lines and typed
// options), what is a quote (outside Values, One question and Never in a message), what is a slot value or a link
// (outside the Shape and Length counts), and what is left: the model's own words.

import type { CheckContext, FinalParts, Option } from "./types";

/** The relay's quote: someone's own words, quoted in a code-filled slot (arch 07 line 359; S13-37). */
export const QUOTE_SLOT = "relay.quote";

/** The one placeholder of a fixed line, filled with the business's name (K-01 `fixedLine`; arch 07 line 361). */
export const BUSINESS = "<business>";

/**
 * A link (arch 07 line 409): a web address with its scheme, or any word shaped like a domain, with or without a path:
 * letters, digits or hyphens, a dot, then two or more letters, so "lees-cuts.shop/pay" and "example.ca/pay" read as
 * links just as Rosie's own rosfield.com/v/s03 does. An email address reads as one link with its name. Never its
 * closing mark.
 */
export const LINK =
  /\bhttps?:\/\/\S*[^\s.,!?;:)]|(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}._%+-]+@)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?![\p{L}\p{N}-])(?:\/\S*[^\s.,!?;:)\]"'”’])?/giu;

/** A fixed line's words as its source writes them, or why there are none. */
export type FixedLineWords = { readonly words: string } | { readonly fault: string };

/** The source of fixed line `id` (K-01 `fixedLine`) in the reader's language, else in English, <business> filled. */
export function fixedLineWords(id: string, context: CheckContext): FixedLineWords {
  const lines = context.lists.fixedLines.lines.filter((line) => line.id === id);
  const line =
    lines.find((candidate) => candidate.lang === context.language) ??
    lines.find((candidate) => candidate.lang === "en");
  if (line === undefined) return { fault: `The fixed line ${id} is not one of the bundle's fixed lines.` };
  if (line.text === null) return { fault: `The fixed line ${id} has no words yet: it waits for Jay.` };
  if (!line.text.includes(BUSINESS)) return { words: line.text };
  const business = context.businessName;
  if (business === null) {
    return { fault: `The fixed line ${id} names the business, and there is no business yet.` };
  }
  // A function fills it as written: a string would read "$$", "$&" or "$'" in a name such as "Ca$$h Cuts".
  return { words: line.text.replaceAll(BUSINESS, () => business) };
}

/** The words of every send that has words (K-03 `send`: none for a poll or a tapback), the words send first. */
export function sendTexts(parts: FinalParts): string[] {
  return parts.sends.flatMap((send) => (send.text === null ? [] : [send.text]));
}

/** The words send's text, the one that carries fixed lines and typed options (arch 07 line 367); "" when none. */
export function wordsText(parts: FinalParts): string {
  return parts.sends.find((send) => send.kind === "words")?.text ?? "";
}

/** Every option of every send, in order (a poll's; K-03 `send.options`). */
export function optionsOf(parts: FinalParts): Option[] {
  return parts.sends.flatMap((send) => send.options);
}

/** Each slot's value (K-03 `slotValues`), quotes included. */
export function valuesOf(parts: FinalParts): string[] {
  return parts.slotValues.map((fact) => fact.value);
}

/** A piece code filled into the words: one slot's value (K-03 `fact`). */
export interface Filled {
  readonly text: string;
  /**
   * Whether code put it at one place only: a quote, which code fills once, so only one place of its words is code's
   * and a repeat of them anywhere else is the model's (arch 07 line 409: "outside a relay's quote"). Any other value is
   * a code-supplied fact wherever it stands.
   */
  readonly once: boolean;
}

/** Each slot's value (K-03 `slotValues`) as code filled it: a quote at its own place only. */
export function filledOf(parts: FinalParts): Filled[] {
  return parts.slotValues.map((fact) => ({ text: fact.value, once: fact.slot === QUOTE_SLOT }));
}

/** The quotes, each at its own place: each relay.quote value (arch 07 line 409; line 415: "outside a quote"). */
export function quotesOf(parts: FinalParts): Filled[] {
  return filledOf(parts).filter((piece) => piece.once);
}

/** What code inserted in the words: each fixed line's source words and the typed options (arch 07 lines 361, 379). */
export function insertedWords(parts: FinalParts, context: CheckContext): string[] {
  const inserted = parts.fixedLines.flatMap((id) => {
    const source = fixedLineWords(id, context);
    return "words" in source ? [source.words] : [];
  });
  return context.typedOptions === null ? inserted : [...inserted, context.typedOptions];
}

/** A text without each inserted piece (its first place: code inserts each once). */
export function withoutInserted(text: string, inserted: readonly string[]): string {
  return inserted.reduce((rest, piece) => (piece === "" ? rest : rest.replace(piece, "")), text);
}

const longestFirst = (pieces: readonly Filled[]): Filled[] =>
  pieces.filter((piece) => piece.text !== "").sort((a, b) => b.text.length - a.text.length);

/** Text made safe to match word for word inside a pattern. */
export const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The places a piece stands whole: no letter or digit right before it, none right after ("$40" is not in "$40.00").
 * Each place for a value; for a quote only the first, its own place (a pattern without the g flag replaces one).
 */
const wholePlaces = (piece: Filled): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeForPattern(piece.text)}(?![\\p{L}\\p{N}]|[.,:]\\p{N})`,
    piece.once ? "u" : "gu",
  );

/** The ".", "!" or "?" a piece ends with, which ends its sentence too. */
export const closingOf = (piece: string): string => /[.!?]+$/.exec(piece)?.[0] ?? "";

/** Each piece's places as one space: the words read without them (a quote at its own place, for its own words). */
export function blankOut(text: string, pieces: readonly Filled[]): string {
  return longestFirst(pieces).reduce((rest, piece) => rest.replace(wholePlaces(piece), " "), text);
}

/** Each piece's places as `mark`, longest first, keeping the piece's closing ".", "!" or "?" (a sentence still ends). */
export function markOut(text: string, pieces: readonly Filled[], mark: string): string {
  return longestFirst(pieces).reduce(
    (rest, piece) => rest.replace(wholePlaces(piece), () => mark + closingOf(piece.text)),
    text,
  );
}

/**
 * The model's own words in the words send (arch 07 line 417: Shape and Length "count only model-written words, not
 * fixed lines, options, slot values, links or quotes"): fixed lines and typed options out, each slot value (a quote at
 * its own place) and each link as `mark`. A mark of "$" keeps a sentence break the master's split sees (lib.js line
 * 481) and is no word of its own (line 482), so the counts read the model's words in the sentences the reader sees.
 */
export function ownWords(parts: FinalParts, context: CheckContext, mark: string): string {
  const composed = withoutInserted(wordsText(parts), insertedWords(parts, context));
  return markOut(composed, filledOf(parts), mark).replace(LINK, () => mark);
}
