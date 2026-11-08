// msgtext.js, the master's message script, loaded as it is (T-134; NQ-PB-2 answered WRAP by T-131).
//
// fixtures/master/engine/work/build/msgtext.js turns a message's chat elements into the text a customer on plain SMS
// gets (smsText(), lines 47-67), names the element keys it knows (KEYS, line 27) and holds the 16 opt-out words
// (OPTOUT, line 29). The script is read-only (rule 1): it is loaded unchanged through overlay/cjs-load.ts, as the
// overlay applier loads overlay-core.js, and none of its rules is copied here.
//
// OPTOUT is not one of the script's exports (line 116: smsText, stopLine, pickLabel, uiProblems, words, hasElement,
// bKey, bLab, KEYS), so its words are read from the script's own text: the one line `var OPTOUT = [...]`, a list of
// quoted words, parsed as JSON. No word is typed in here.
import { readFileSync } from "node:fs";
import { makeCjsLoader } from "../overlay/cjs-load";
import { BUILD_DIR } from "../overlay/core";

/** Fixture set v1's copy of msgtext.js. */
export const MSGTEXT_FILE = `${BUILD_DIR}msgtext.js`;

/** The parts of msgtext.js this module calls (its exports, line 116). */
export interface MsgTextScript {
  /** What a customer on plain SMS gets for a message `[from, to, text]` or `[from, to, text, elements]` (lines 47-67). */
  smsText(message: readonly unknown[]): string;
  /** The element keys the script knows (line 27). */
  KEYS: readonly string[];
}

let cached: MsgTextScript | null = null;

/** Loads msgtext.js once per process. Throws if the script does not offer smsText() and KEYS. */
export function loadMsgText(): MsgTextScript {
  if (cached) return cached;
  const exported = makeCjsLoader()(MSGTEXT_FILE) as Partial<MsgTextScript> | null;
  if (typeof exported?.smsText !== "function" || !Array.isArray(exported.KEYS))
    throw new Error(`${MSGTEXT_FILE} does not export smsText() and KEYS`);
  cached = exported as MsgTextScript;
  return cached;
}

/** msgtext.js's opt-out words, as and where the script writes them. */
export interface OptOutSource {
  /** The words in the script's order. */
  words: string[];
  file: string;
  /** The line of the script that holds them, from 1. */
  line: number;
}

const OPTOUT_LINE = /var OPTOUT = (\[[^\]\n]*\]);/g;

/**
 * Reads the opt-out words from msgtext.js's text (`source`, read from `file`): the one `var OPTOUT = [...]` line, its
 * list parsed as JSON. Throws, naming the file, when there is no such line or more than one, or when the list is not
 * a list of words, each written once.
 */
export function parseOptOut(source: string, file: string): OptOutSource {
  const found = [...source.matchAll(OPTOUT_LINE)];
  const [match] = found;
  if (found.length !== 1 || match?.[1] === undefined)
    throw new Error(`${file}: expected one "var OPTOUT = [...]" line, found ${String(found.length)}`);
  const line = source.slice(0, match.index).split("\n").length;
  let words: unknown;
  try {
    words = JSON.parse(match[1]);
  } catch {
    throw new Error(`${file} line ${String(line)}: OPTOUT is not a list of quoted words`);
  }
  if (
    !Array.isArray(words) ||
    words.length === 0 ||
    words.some((word) => typeof word !== "string" || word.trim() === "")
  )
    throw new Error(`${file} line ${String(line)}: OPTOUT is not a list of words`);
  const list = words as string[];
  if (new Set(list).size !== list.length)
    throw new Error(`${file} line ${String(line)}: OPTOUT names a word twice`);
  return { words: list, file, line };
}

let optOut: OptOutSource | null = null;

/** msgtext.js's opt-out words (OPTOUT, line 29), read once per process; each call gets its own copy. */
export function readOptOut(): OptOutSource {
  optOut ??= parseOptOut(readFileSync(MSGTEXT_FILE, "utf8"), MSGTEXT_FILE);
  return { ...optOut, words: [...optOut.words] };
}
