// The words side of the kind matcher (T-632; C-130): T-631's method A as its spike measured it (Q-42; DL-890;
// actions/spikes/q42-kind-matcher/words.mjs and FINDINGS.md "How A0, A and B match", defaults 4 and 5), typed and with
// every setting unchanged: one tokenizer, one plural fold, one rule for when a person's word meets a catalog word, and
// the split of an owner's answer into parts. Plain text: no model and no stored index (QUESTIONS.md M4.1; K-24 v1 README
// line 41).
//
// A word meets a catalog word when they are the same, or when one starts the other (at least MIN_WHOLE letters, the whole
// of the shorter: "hair" starts "haircut") or both start with the same MIN_SHARED letters ("plumb" in "plumbing" and
// "plumber"). A meeting that is not the same word weighs the share of the longer word they have in common, so
// "electrical" meets "electrician" (8 of 11) more than "electronics" (6 of 11).
//
// T-1518 (DL-1042) adds two helpers and changes none of the above: wordKey, a text's words as one key, by which a part is
// compared whole with a kind's own name and with the everyday words of everyday.ts; and partSpans, splitParts' parts with
// their places in the text, so a kind's own name typed with its commas is read as one part (matcher.ts).

/** Both words start with at least this many of the same letters. */
export const MIN_SHARED = 5;
/** Or the shorter word, of at least this many letters, starts the longer one. */
export const MIN_WHOLE = 4;

// English function words and greetings only (T-631's list); every other word is weighed by how many kinds use it.
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "get",
  "hello",
  "hi",
  "how",
  "i",
  "if",
  "im",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "so",
  "some",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "to",
  "too",
  "us",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** A plural folded to its singular: "plumbers" plumber, "services" service, "batteries" battery. */
export function fold(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/u.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * A text in lower case with its accents and possessives dropped, split into runs of letters and digits (every other
 * character separates two words). The not-booked check reads these as they are; `words` filters and folds them.
 */
export function plainTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/['’]s\b/gu, "")
    .split(/[^a-z0-9]+/u)
    .filter((token) => token !== "");
}

/** The words of a text: plainTokens without numbers, one-letter tokens and function words, each folded. */
export function words(text: string): string[] {
  return plainTokens(text)
    .filter((token) => token.length >= 2 && !/^\d+$/u.test(token) && !STOP_WORDS.has(token))
    .map(fold);
}

/**
 * A text's words as one key, in order (T-1518): what a kind's own name and an everyday word of the table (everyday.ts)
 * are compared by, so case, plurals, function words and punctuation never matter ("Movers" and "mover"; "We do haircuts"
 * and "haircut"; "OB/GYN" and "OB-GYN"). Empty when the text has no word.
 */
export function wordKey(text: string): string {
  return words(text).join(" ");
}

/**
 * How a person's word meets a catalog word: 1 when they are the same; the share of the longer word they have in common
 * when one starts the other (at least MIN_WHOLE letters) or both start with MIN_SHARED of the same letters; else 0.
 */
export function meets(word: string, catalogWord: string): number {
  if (word === catalogWord) return 1;
  const shorter = Math.min(word.length, catalogWord.length);
  let shared = 0;
  while (shared < shorter && word.charCodeAt(shared) === catalogWord.charCodeAt(shared)) shared += 1;
  if (shared >= MIN_SHARED || (shared === shorter && shorter >= MIN_WHOLE)) {
    return shared / Math.max(word.length, catalogWord.length);
  }
  return 0;
}

/**
 * The parts of an owner's S1-02 answer (K-09 matchKinds: "each part of the owner's words"): split at commas, semicolons
 * and line breaks, each part trimmed and kept exactly as typed. "and" is not a split: a kind's own name can hold it
 * ("Pet boarding and doggy daycare"; T-631's note 3).
 */
export function splitParts(text: string): string[] {
  return text
    .split(/[,;\r\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** One part splitParts gives, with where it sits in the text: `text.slice(start, end)` is the part, as typed. */
export interface PartSpan {
  readonly part: string;
  readonly start: number;
  readonly end: number;
}

/**
 * splitParts' parts, the same parts in the same order, each with its place in the text (T-1518), so the matcher can read
 * a kind's own name typed with its commas ("Glass, window and door installer") as the one part it is.
 */
export function partSpans(text: string): PartSpan[] {
  const spans: PartSpan[] = [];
  let from = 0;
  for (const separator of [...text.matchAll(/[,;\r\n]+/gu), null]) {
    const to = separator === null ? text.length : separator.index;
    const piece = text.slice(from, to);
    const part = piece.trim();
    if (part !== "") {
      const start = from + piece.indexOf(part);
      spans.push({ part, start, end: start + part.length });
    }
    if (separator !== null) from = separator.index + separator[0].length;
  }
  return spans;
}
