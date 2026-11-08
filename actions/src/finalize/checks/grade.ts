// The master's plain-words score (C-092; arch 07 line 413: "English of 12 words or more at grade 9.5 or lower by lib.js's
// grade()"), ported line for line from scratch/master-copy/engine/work/build/lib.js (read 2026-11-07): grade() is lines
// 483 to 488, with the syllable count (line 472), the cleaning (480), the sentence and word splits (481, 482), the
// longest sentence (489) and the limits (LIM, line 470) it uses. grade-parity.json holds 30 lines graded by the master's
// own grade(), and grade.test.ts holds this port to them within 0.1.
//
// One step of the master's clean() is left out: it also reads its old app's link domain as the word "link". The message
// checks take every link out before they count (arch 07 line 417), and no Rosie text holds that domain, so the two give
// the same grade on every text without it.

/** The master's limits that the message checks use (lib.js LIM, line 470; arch 07 line 413; SPEC-master section 4). */
export const LIMITS = {
  /** Characters of a message's own words with an element, a poll or a card (LIM.msg). */
  withElement: 260,
  /** Characters of a message's own words without one (LIM.msgPlain). */
  plain: 320,
  /** The highest reading grade (LIM.grade). */
  grade: 9.5,
  /** Words in one sentence (LIM.sentence). */
  sentenceWords: 22,
  /** Commas, semicolons and brackets in one sentence (LIM.ideas). */
  ideas: 4,
  /** A text of fewer words gets no grade (lib.js line 485). */
  gradeWords: 12,
} as const;

/** The syllables of one word (lib.js syl, line 472). */
export function syllables(word: string): number {
  let letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (letters === "") return 1;
  if (letters.length <= 3) return 1;
  letters = letters.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, letters.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

/** A text as the master counts it (lib.js clean, line 480): each clock time is the one word "time", a long dash " to ". */
export function cleanText(text: string): string {
  return text
    .replace(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi, "time")
    .replace(/[–—]/g, " to ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentences of a text, line by line (lib.js sentences, line 481). */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => cleanText(line).split(/(?<=[.!?])\s+(?=[A-Z0-9"'$])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[a-z0-9]/i.test(sentence));
}

/** The words of a text: what holds a letter or a digit (lib.js words, line 482). */
export function wordsOf(text: string): string[] {
  return cleanText(text)
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));
}

/** The reading grade of a text, or null under 12 words (lib.js grade, lines 483 to 488). */
export function grade(text: string): number | null {
  const sentences = sentencesOf(text);
  const words = wordsOf(text);
  if (words.length < LIMITS.gradeWords) return null;
  const count = words.reduce((sum, word) => sum + syllables(word), 0);
  return 0.39 * (words.length / Math.max(1, sentences.length)) + 11.8 * (count / words.length) - 15.59;
}

/** The words in a text's longest sentence (lib.js longest, line 489). */
export function longestSentence(text: string): number {
  return sentencesOf(text).reduce((most, sentence) => Math.max(most, wordsOf(sentence).length), 0);
}

/** The commas, semicolons and brackets in one sentence: the ideas it packs (lib.js scoreText, line 495). */
export function ideasIn(sentence: string): number {
  return sentence.match(/[,;()]/g)?.length ?? 0;
}
