// An option that is only an opt-out word (arch 07 line 415: "in options, an option that is only an opt-out word
// ('Cancel visit', never 'Cancel'; PLAIN-WORDS §3)"). msgtext.js line 95 gives the reason: a chat app may send a
// button's words, so a button that is only an opt-out word would stop the texts instead. The words are msgtext.js's 16
// (OPTOUT, line 29), which the bundle carries as K-01 `sharedLists.keywords.optOut` for the guard, the lint and these
// checks to read (T-134 compiles it); this file holds no list of its own.

/** A label's letters alone, in capitals and without accents: "Stop!", "opt-out" and "Cancel." read STOP, OPTOUT, CANCEL. */
export function lettersOf(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}]/gu, "");
}

/**
 * Whether an option's label is only one of the opt-out words, in any case, with any spaces or marks around or inside
 * it (msgtext.js line 95 compares the trimmed label in capitals; "Stop." or "Opt out" would stop the texts just the same).
 */
export function isOptOutOnly(label: string, optOutWords: readonly string[]): boolean {
  const letters = lettersOf(label);
  return letters !== "" && optOutWords.some((word) => lettersOf(word) === letters);
}
