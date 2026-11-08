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
 * Characters that show nothing: zero-width spaces and joiners, soft hyphens, word joiners, variation selectors and the
 * rest of Unicode's default-ignorable code points (T-304 round 3, DL-189 item 1).
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
/** Every mark read as an apostrophe: ' ’ ‘ ‛ ` ´ ′ ‵ (NFKC makes the fullwidth ＇ one too). */
const APOSTROPHE = /['’‘‛`´′‵]/gu;
/** Every dash, by Unicode's Dash property: - ‐ ‑ ‒ – — ― − 〜 and the rest (NFKC makes the fullwidth － one too). */
const DASH = /\p{Dash}/gu;

/** The words with every character that shows nothing taken out: 1, a zero-width space, then 40 is "140". */
export function visibleWords(words: string): string {
  return words.replace(INVISIBLE, "");
}

/**
 * Words in one form: invisible characters taken out, every apostrophe straight (before the accents come off, so "can´t"
 * is "can't"), compatibility forms joined (NFKC: "，" is ",", "：" ":", "１" "1"), accents taken off, lower case, every
 * dash one hyphen, "a.m."/"p.m." as "am"/"pm", "o'clock" as "oclock", "@" as "at", spaces collapsed.
 */
export function foldWords(words: string): string {
  return visibleWords(words)
    .replace(APOSTROPHE, "'")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(DASH, "-")
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

// ---- words found in a text at word edges (T-304 round 2, DL-184; round 3, DL-189 item 1) -----------------------------
//
// A quote or a value's words count only where they stand in the text whole: where they start and end at a word edge.
// Words cut out of a longer word or number say something the person never said: "40" out of "raise haircut to 140",
// "tomorrow at 1" out of "tomorrow at 10", "$1" out of "$1,200", "Oct 2" out of "Oct 24", "2" out of "12 people", "1" out
// of "10am", "yes" out of "yesterday", "no" out of "know".
//
// Fold first (DL-189): the edges are judged on the text as the readers fold it, not on its raw characters. Characters
// that show nothing are taken out ("40" of 1, a zero-width space, then 40 is cut out of 140), every mark foldWords
// reads as an apostrophe is one ("I can" of "I can´t"), and compatibility forms are their marks (NFKC: "$1" of "$1，200",
// "at 10" of "at 10：30", "$12" of "$12．50"; "－" is a hyphen). At each place the words stand in the text, word for word
// (case, accents and spacing as they are: K-02's quote is exact), with the folded text either side:
//   1. no letter or digit right before or right after them;
//   2. no , . : or / with a letter or digit right after it, right after them ("$1" of "$1,200", "at 10" of "at 10:30",
//      "no" of "no.reply@example.com"); at the start, none right before words that start with a digit ("200" of
//      "$1,200", "30" of "10:30"), nor one standing between a letter or digit and words that start with a letter
//      ("reply" of "no.reply", "com" of "example.com");
//   3. no hyphen, dash or apostrophe joining them to a letter or digit on either side ("twenty" of "twenty-five", "$12"
//      of "$12-15", "Thu 2" of "Thu 2-5", "can" of "can't").
// Rule 1 and rule 2's end are DL-184's and DL-189's own; rule 2's start and rule 3 are the same edge for a number's own
// marks and for words joined into one (default, for ops/QUESTIONS.md). Nothing here keeps or logs the words.

const LAST_IS_WORD = /[\p{L}\p{N}\p{M}]$/u;
const FIRST_IS_WORD = /^[\p{L}\p{N}\p{M}]/u;
const FIRST_IS_DIGIT = /^\p{N}/u;
const FIRST_IS_LETTER = /^\p{L}/u;
const LAST_IS_NUMBER_MARK = /[,.:/]$/u;
const WORD_THEN_NUMBER_MARK = /[\p{L}\p{N}\p{M}][,.:/]$/u;
const NUMBER_MARK_THEN_WORD = /^[,.:/][\p{L}\p{N}]/u;
const JOINED_BEFORE = /[\p{L}\p{N}\p{M}]['-]$/u;
const JOINED_AFTER = /^['-][\p{L}\p{N}]/u;
const NOT_SPACE = /\S/u;

/**
 * A text as its word edges are judged: invisible characters out, every apostrophe one, compatibility forms their marks
 * (NFKC), every dash one hyphen. Case, accents and spacing stay as they are.
 */
function edgeForm(text: string): string {
  return visibleWords(text).replace(APOSTROPHE, "'").normalize("NFKC").replace(DASH, "-");
}

/** Whether `words` start and end at a word edge between the folded text `before` and `after` them (rules 1 to 3). */
function standsWhole(before: string, words: string, after: string): boolean {
  if (LAST_IS_WORD.test(before) || FIRST_IS_WORD.test(after)) return false;
  if (NUMBER_MARK_THEN_WORD.test(after)) return false;
  if (LAST_IS_NUMBER_MARK.test(before)) {
    if (FIRST_IS_DIGIT.test(words)) return false;
    if (WORD_THEN_NUMBER_MARK.test(before) && FIRST_IS_LETTER.test(words)) return false;
  }
  return !JOINED_BEFORE.test(before) && !JOINED_AFTER.test(after);
}

/**
 * Every place `words` stand in `text` word for word and whole (rules 1 to 3), by where they start, first first. Words with
 * no character but spaces stand nowhere.
 */
export function wholeAt(text: string, words: string): number[] {
  const found: number[] = [];
  if (!NOT_SPACE.test(words)) return found;
  const inner = edgeForm(words);
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + 1)) {
    const before = edgeForm(text.slice(0, at));
    const after = edgeForm(text.slice(at + words.length));
    if (standsWhole(before, inner, after)) found.push(at);
  }
  return found;
}

/**
 * Whether `words` are found in `text` word for word (case, accents, spacing and punctuation as they are; characters that
 * show nothing aside), in at least one place where they start and end at a word edge of the folded text: not cut out of
 * a longer word or number. Words with no character but spaces are never found.
 */
export function foundAtWordEdges(text: string, words: string): boolean {
  return wholeAt(visibleWords(text), visibleWords(words)).length > 0;
}
