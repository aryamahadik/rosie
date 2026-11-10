// The first sentence of a step's `does` (K-01 v1 step.does), a door's definition (T-293): K-02 v1 README default 3
// ("for an any-time row, a door or an entry step, the first sentence of its handler or entry step, the stand-in K-01 uses
// for a branch with no Means line"). The cut is the compiler's own for that stand-in (compiler/src/cards/lines.ts
// firstSentence, T-144), written again here because the action layer does not import the compiler at run time
// (ADR-002: a lane's use of another shows in its package.json); first-sentence.test.ts holds the two to the same answer
// on every step of fixture set v1's two master flows.

const WORD_ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|approx|a\.m|p\.m|No|Mr|Mrs|Ms|Dr|St)\.)$/u;

/** Is a quotation still open at the end of this text? An apostrophe inside a word is not a quote. */
function insideQuote(text: string): boolean {
  const opening = text.match(/(?:^|[\s(])'(?=\S)/gu)?.length ?? 0;
  const closing = text.match(/(?<=\S)'(?=$|[\s.,;:!?)])/gu)?.length ?? 0;
  return opening > closing;
}

/**
 * The first sentence of a text: up to the first full stop, question mark or exclamation mark that is followed by a space
 * and then a capital letter, a digit, a quote or a slot, or that ends the text. A stop after a known abbreviation, or
 * inside an open quotation, does not end it. A text with no such stop is its own first sentence.
 */
export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  const stops = /[.!?]+["')\]]*(?=\s|$)/gu;
  let found: RegExpExecArray | null;
  while ((found = stops.exec(clean)) !== null) {
    const end = found.index + found[0].length;
    const before = clean.slice(0, end);
    const after = clean.slice(end).trimStart();
    if (WORD_ABBREVIATIONS.test(before) || insideQuote(before)) continue;
    if (after === "" || /^["'([{]?[A-Z0-9{]/u.test(after)) return before;
  }
  return clean;
}
