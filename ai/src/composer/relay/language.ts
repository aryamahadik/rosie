// The reader's language (T-375, C-118; arch 06 line 341: the AI never chooses a language from a name: "It answers in the
// language of the text. Anyone else gets their stored language, set when they name it or write in it twice, else the
// business's"; S13-24 rule 12: "Use their language; never guess it from a name"; S13-37).
//
// Code chooses the language (K-03 `language`: for a reply, the text's, which the two decide reads report, CQ-07; else
// the person's stored one, else the business's: K-09's compose input, C-090), and the composer answers in it: it gives
// it to the model as <language>, as it is, and holds the plan to it. Each words field's own words (./words.ts: its slots
// out, a relay's original quote among them, and Rosie's own terms, which are never translated: K-03 v1.1 README) must not
// read as another language than the row's.
//
// The composer tells English from Spanish by their small words, each one a word the other language does not write ("the",
// "you", "is"; "el", "que", "por"; never "a", "no", "me", "son", "he" or "has", which both write): a field is refused when
// at least two of its words are the other language's and they outnumber its own language's. So a field of slots alone, a
// name of a place or a single borrowed word ("gracias") is never refused. Only these two languages are checked, the
// ones whose words the composer's checks already read (../check.ts reads English and Spanish dates and prices); a row in
// any other language is left to the prompt and the eval.

import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeProblem } from "../types";
import { ownWords, planFields, termWords, wordsOf } from "./words";

/** The languages the composer tells apart, by K-03's two-letter code. */
export const CHECKED_LANGUAGES = ["en", "es"] as const;
export type CheckedLanguage = (typeof CHECKED_LANGUAGES)[number];

/** English's small words that Spanish never writes, lowercased, an apostrophe straight. */
const ENGLISH = [
  "the",
  "and",
  "you",
  "your",
  "yours",
  "you're",
  "you'll",
  "you've",
  "you'd",
  "is",
  "are",
  "was",
  "were",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "will",
  "won't",
  "would",
  "wouldn't",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "should",
  "shouldn't",
  "have",
  "haven't",
  "had",
  "hasn't",
  "do",
  "does",
  "did",
  "don't",
  "doesn't",
  "didn't",
  "with",
  "for",
  "from",
  "this",
  "that",
  "these",
  "those",
  "it",
  "it's",
  "its",
  "we",
  "we'll",
  "we're",
  "we've",
  "our",
  "us",
  "they",
  "their",
  "them",
  "she",
  "her",
  "his",
  "him",
  "i",
  "i'm",
  "i'll",
  "i've",
  "my",
  "please",
  "here",
  "there",
  "there's",
  "here's",
  "what",
  "what's",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how",
  "by",
  "at",
  "on",
  "of",
  "to",
  "be",
  "been",
  "not",
  "about",
  "after",
  "before",
  "until",
  "if",
  "or",
  "but",
  "so",
  "than",
  "then",
  "just",
  "still",
  "now",
  "any",
  "all",
  "some",
  "yes",
  "thanks",
  "thank",
  "in",
  "into",
  "out",
  "up",
  "an",
  "get",
  "also",
  "only",
  "let's",
  "yet",
  "very",
];

/** Spanish's small words that English never writes, lowercased, with and without their accents. */
const SPANISH = [
  "el",
  "la",
  "los",
  "las",
  "lo",
  "le",
  "les",
  "de",
  "del",
  "al",
  "que",
  "qué",
  "por",
  "para",
  "con",
  "sobre",
  "entre",
  "hasta",
  "desde",
  "un",
  "una",
  "uno",
  "unos",
  "unas",
  "es",
  "está",
  "están",
  "estás",
  "estoy",
  "estar",
  "ser",
  "fue",
  "soy",
  "eres",
  "somos",
  "su",
  "sus",
  "tu",
  "tus",
  "tú",
  "te",
  "se",
  "sí",
  "si",
  "aún",
  "aun",
  "cuando",
  "cuándo",
  "donde",
  "dónde",
  "como",
  "cómo",
  "más",
  "mas",
  "pero",
  "también",
  "tambien",
  "nos",
  "mi",
  "mis",
  "muy",
  "hay",
  "ha",
  "han",
  "hemos",
  "puede",
  "puedes",
  "pueden",
  "puedo",
  "gracias",
  "hola",
  "y",
  "en",
  "este",
  "esta",
  "esto",
  "estos",
  "estas",
  "ese",
  "esa",
  "eso",
  "esos",
  "esas",
  "nuestro",
  "nuestra",
  "nuestros",
  "nuestras",
  "usted",
  "ustedes",
  "ni",
  "cuál",
  "cual",
  "quién",
  "quien",
  "porque",
  "pues",
  "antes",
  "después",
  "despues",
  "ahora",
  "todavía",
  "todavia",
  "aquí",
  "aqui",
  "allí",
  "alli",
  "algo",
  "cada",
  "tiene",
  "tienes",
  "tienen",
  "será",
  "hace",
  "hacer",
];

/** Each checked language's small words. */
export const SMALL_WORDS: Readonly<Record<CheckedLanguage, ReadonlySet<string>>> = Object.freeze({
  en: new Set(ENGLISH),
  es: new Set(SPANISH),
});

/** The fewest of the other language's small words that make a field read as that language. */
export const LEAST_OTHER_WORDS = 2;

const OTHER: Readonly<Record<CheckedLanguage, CheckedLanguage>> = { en: "es", es: "en" };

const isChecked = (language: string): language is CheckedLanguage =>
  (CHECKED_LANGUAGES as readonly string[]).includes(language);

/** How many of each checked language's small words some words hold. */
export function smallWordCounts(words: readonly string[]): Record<CheckedLanguage, number> {
  return {
    en: words.filter((word) => SMALL_WORDS.en.has(word)).length,
    es: words.filter((word) => SMALL_WORDS.es.has(word)).length,
  };
}

/**
 * Each words field of an English or Spanish row's plan whose own words read as the other language: at least two of the
 * other's small words, more than of the row's own. Empty for a row in any other language. Names the check and the place,
 * never words.
 */
export function languageProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  const own = input.language;
  if (!isChecked(own)) return [];
  const other = OTHER[own];
  const terms = termWords(input);
  return planFields(plan)
    .filter((field) => {
      const counts = smallWordCounts(wordsOf(ownWords(field.text, terms)));
      return counts[other] >= LEAST_OTHER_WORDS && counts[other] > counts[own];
    })
    .map((field): ComposeProblem => ({ check: "language", at: field.at }));
}
