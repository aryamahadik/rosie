// A person's words in one form for reading values out of them (T-304): case, accents, curly quotes, dots in "a.m." and
// spacing aside, so "Mañana a las 3 P.M." and "manana a las 3 pm" read alike. Nothing here keeps or logs the words.

/** The languages whose number, money and time words the reader knows (arch 06 line 341; A3-07: English and Spanish). */
export type ValueLanguage = "en" | "es";

/** Both languages: a text whose language decide could not agree on (K-02 v1 decideResult.language null). */
export const BOTH_LANGUAGES: readonly ValueLanguage[] = ["en", "es"];

/** The languages to read a text in from K-02's two-letter code: en or es alone, else both. */
export function languagesOf(language: string | null | undefined): readonly ValueLanguage[] {
  if (language === "en") return ["en"];
  if (language === "es") return ["es"];
  return BOTH_LANGUAGES;
}

/**
 * Words in one form: compatibility forms joined (NFKC), accents taken off, lower case, curly apostrophes straight, dashes
 * one hyphen, "a.m."/"p.m." as "am"/"pm", "o'clock" as "oclock", "@" as "at", spaces collapsed.
 */
export function foldWords(words: string): string {
  return words
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`´]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/(?<![a-z])([ap])\.\s?m\.?(?![a-z])/gu, "$1m")
    .replace(/\bo'?\s?clock\b/gu, "oclock")
    .replace(/@/gu, " at ")
    .replace(/\s+/gu, " ")
    .trim();
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a text, folded, in order: each run of letters and digits. */
export function wordsOf(words: string): string[] {
  return foldWords(words).match(WORD) ?? [];
}

/** Every regex match in a folded text, with where it starts and ends. */
export interface Found {
  readonly at: number;
  readonly end: number;
  readonly groups: readonly (string | undefined)[];
}

/** Every match of a global pattern in `text`. */
export function findAll(text: string, pattern: RegExp): Found[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const scan = new RegExp(pattern.source, flags);
  return [...text.matchAll(scan)].map((match) => ({
    at: match.index,
    end: match.index + match[0].length,
    groups: match.slice(1),
  }));
}

/** Where something stands in a folded text: from `at` up to `end`. */
export interface Span {
  readonly at: number;
  readonly end: number;
}

/** Whether a span overlaps any of `taken`. */
export function overlaps(found: Span, taken: readonly Span[]): boolean {
  return taken.some((other) => found.at < other.end && other.at < found.end);
}

// ---- words found in a text at word edges (T-304 round 2, DL-184) ------------------------------------------------------
//
// A quote or a value's words count only where they stand in the text whole: where they start and end at a word edge.
// Words cut out of a longer word or number say something the person never said: "40" out of "raise haircut to 140",
// "tomorrow at 1" out of "tomorrow at 10", "$1" out of "$1,200", "Oct 2" out of "Oct 24", "2" out of "12 people", "1" out
// of "10am", "yes" out of "yesterday", "no" out of "know". At each place the words stand in the text, word for word:
//   1. no letter or digit right before or right after them;
//   2. no , . : or / followed by a digit right after them ("$1" of "$1,200", "at 10" of "at 10:30"), and, at the start,
//      none right before words that start with a digit ("200" of "$1,200", "30" of "10:30", "24" of "10/24");
//   3. no hyphen, dash or apostrophe joining them to a letter or digit on either side ("twenty" of "twenty-five", "$12"
//      of "$12-15", "Thu 2" of "Thu 2-5", "can" of "can't").
// Rule 1 and rule 2's end are DL-184's own; rule 2's start and rule 3 are the same edge for a number's own marks and for
// words joined into one (default, for ops/QUESTIONS.md). Nothing here keeps or logs the words.

const LAST_IS_WORD = /[\p{L}\p{N}\p{M}]$/u;
const FIRST_IS_WORD = /^[\p{L}\p{N}\p{M}]/u;
const FIRST_IS_DIGIT = /^\p{N}/u;
const LAST_IS_NUMBER_MARK = /[,.:/]$/u;
const NUMBER_MARK_THEN_DIGIT = /^[,.:/]\p{N}/u;
const JOINED_BEFORE = /[\p{L}\p{N}\p{M}][-‐‑‒–—'’]$/u;
const JOINED_AFTER = /^[-‐‑‒–—'’][\p{L}\p{N}]/u;
const NOT_SPACE = /\S/u;

/** Whether `words`, standing in `text` from `at` to `end`, start and end at a word edge there (rules 1 to 3). */
function standsWhole(text: string, words: string, at: number, end: number): boolean {
  // Two code points either side are all the rules read; four code units hold two of any.
  const before = text.slice(Math.max(0, at - 4), at);
  const after = text.slice(end, end + 4);
  if (LAST_IS_WORD.test(before) || FIRST_IS_WORD.test(after)) return false;
  if (NUMBER_MARK_THEN_DIGIT.test(after)) return false;
  if (LAST_IS_NUMBER_MARK.test(before) && FIRST_IS_DIGIT.test(words)) return false;
  return !JOINED_BEFORE.test(before) && !JOINED_AFTER.test(after);
}

/**
 * Whether `words` are found in `text` word for word (case, spacing and punctuation as they are), in at least one place
 * where they start and end at a word edge: not cut out of a longer word or number. Words with no character but spaces are
 * never found.
 */
export function foundAtWordEdges(text: string, words: string): boolean {
  if (!NOT_SPACE.test(words)) return false;
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + 1)) {
    if (standsWhole(text, words, at, at + words.length)) return true;
  }
  return false;
}
