// The guard's keywords (T-250; C-051). Arch 02 step 3 (architecture.txt line 115): "Code alone acts on a text that is only
// START, HELP or one of msgtext.js's 16 opt-out words, such as STOP, CANCEL, OPT OUT or PARA. CANCEL or CANCELAR also flags
// the visit (RULES 7.4; S13-28 rule 46)."
//
// The words are the pinned bundle's: K-01 v1 `lists.keywords` in its manifest, which T-134's compiler writes from msgtext.js
// (OPTOUT, line 29). No word list is typed here. A text is a keyword when, read as `keyOf` reads it, it is one of those
// words and nothing else:
//   - NFKC first, so a full-width or ligature letter reads as its plain letter;
//   - anything but a letter or a digit is cut from both ends: spaces, line breaks, punctuation ("!", ".", "?", "¡", a
//     quote) and emoji, so "Stop!", "¡Basta!" and " stop\n" read as the word;
//   - each run of spaces inside reads as one space, so "opt  out" reads as "OPT OUT";
//   - case does not matter.
// Nothing else is cut, so the word inside a sentence ("please stop", "cancel my 2pm haircut", BP 9.4) is never a keyword: it
// goes on to decide, and a stop in other words is the model's to find (RULES 7.2; the any-time table's STOP row).
//
// A button's words count as typed words: a tap of S1-37's "Start" reads as START (QUESTIONS.md Q-14's default: the lint
// fails that step, and the guard does not tell taps apart).
//
// A list the guard cannot read as K-01's (missing, a word that is blank, a word that flags the visit but is no opt-out
// word, or two words that read the same) is refused with `noKeywords`: the guard then splits nothing and the turn stops
// (fail closed), so a stop word never passes for an ordinary text. Never logged: a text's words.

import { GuardError, type GuardText, type Keyword } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const ENDS = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const INNER_SPACES = /\s+/gu;

/** Words as the guard compares them: NFKC, cut at both ends to the first and last letter or digit, inner spaces as one, upper case. */
export function keyOf(words: string): string {
  return words.normalize("NFKC").replace(ENDS, "").replace(INNER_SPACES, " ").toUpperCase();
}

/** The pinned bundle's keywords, each under the form `keyOf` reads it in. */
export class KeywordList {
  private readonly byKey: ReadonlyMap<string, Keyword>;

  /** Throws `noKeywords` when a word is blank or two words read the same. */
  constructor(keywords: readonly Keyword[]) {
    const byKey = new Map<string, Keyword>();
    for (const keyword of keywords) {
      const key = keyOf(keyword.word);
      if (key === "" || byKey.has(key)) throw new GuardError("noKeywords");
      byKey.set(key, keyword);
    }
    if (byKey.size === 0) throw new GuardError("noKeywords");
    this.byKey = byKey;
  }

  /** Every keyword, in the bundle's order: START, HELP, then the opt-out words. */
  all(): Keyword[] {
    return [...this.byKey.values()];
  }

  /** The keyword `words` are, and nothing else, or null. */
  match(words: string): Keyword | null {
    const key = keyOf(words);
    return key === "" ? null : (this.byKey.get(key) ?? null);
  }
}

function word(value: unknown): string {
  if (typeof value !== "string" || keyOf(value) === "") throw new GuardError("noKeywords");
  return value;
}

function words(value: unknown): string[] {
  if (!isList(value)) throw new GuardError("noKeywords");
  return value.map(word);
}

/**
 * The keyword list of a pinned bundle's manifest (K-01 v1 `lists.keywords`): START and HELP as the list writes them, then
 * each opt-out word, the ones `flagsVisit` names flagging the visit. Throws `noKeywords` when the list is not one the guard
 * can read as K-01's.
 */
export function keywordsOf(manifest: Readonly<Record<string, unknown>>): KeywordList {
  const lists = manifest.lists;
  const keywords = isRecord(lists) ? lists.keywords : undefined;
  if (!isRecord(keywords)) throw new GuardError("noKeywords");
  const optOut = words(keywords.optOut);
  const flagsVisit = words(keywords.flagsVisit);
  if (optOut.length === 0 || flagsVisit.some((flagged) => !optOut.includes(flagged))) {
    throw new GuardError("noKeywords");
  }
  return new KeywordList([
    { kind: "start", word: word(keywords.start), flagsVisit: false },
    { kind: "help", word: word(keywords.help), flagsVisit: false },
    ...optOut.map((stop): Keyword => ({ kind: "stop", word: stop, flagsVisit: flagsVisit.includes(stop) })),
  ]);
}

/** The K-06 kinds whose words a person typed: a text (an email's too), a photo's caption, an edit's new words. */
const TYPED_KINDS: readonly string[] = ["text", "photo", "edit"];

/**
 * The keyword a text is, or null. Only typed words count: a reaction or a poll vote is never a keyword (a vote answers its
 * own poll: arch 03 line 187). The body is read; an email whose body holds no letter or digit is read by its subject.
 */
export function keywordOf(text: GuardText, list: KeywordList): Keyword | null {
  if (!TYPED_KINDS.includes(text.kind) || text.words === null) return null;
  const body = text.words.body ?? "";
  const read = keyOf(body) === "" ? (text.words.subject ?? "") : body;
  return list.match(read);
}
