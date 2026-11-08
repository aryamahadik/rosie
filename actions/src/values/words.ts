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
