// The words side of the kind matcher's spike (T-631; Q-42): one tokenizer, one plural fold and one rule for when a
// person's word meets a catalog word, shared by every candidate, so the candidates differ only in what they read.
//
// Plain text, no model and no stored index: a word meets a catalog word when they are the same, or when one starts the
// other (at least MIN_WHOLE letters, the whole of the shorter: "hair" starts "haircut") or both start with the same
// MIN_SHARED letters ("plumb" in "plumbing" and "plumber"). A meeting that is not the same word weighs the share of the
// longer word they have in common, so "electrical" meets "electrician" (8 of 11) more than "electronics" (6 of 11).

/** Both words start with at least this many of the same letters. */
export const MIN_SHARED = 5;
/** Or the shorter word, of at least this many letters, starts the longer one. */
export const MIN_WHOLE = 4;

// English function words and greetings only; every other word is weighed by how many kinds use it (matchers.mjs).
const STOP_WORDS = new Set([
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
export function fold(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The words of a text, lower case, accents and possessives dropped, numbers and function words left out, folded. */
export function words(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word) && !STOP_WORDS.has(word))
    .map(fold);
}

/**
 * How a person's word meets a catalog word: 1 when they are the same; the share of the longer word they have in common
 * when one starts the other (at least MIN_WHOLE letters) or both start with MIN_SHARED of the same letters; else 0.
 */
export function meets(word, catalogWord) {
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
 * The parts of an owner's S1-02 answer (K-09 matchKinds: "each part of the words gets the closest kinds"): split at
 * commas, semicolons and line breaks, each part trimmed and kept exactly as typed. "and" is not a split: a kind's own
 * name can hold it ("Pet boarding and doggy daycare").
 */
export function splitParts(text) {
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
