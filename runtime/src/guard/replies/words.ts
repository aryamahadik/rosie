// The fixed replies' words (T-267; C-052). Fixed text exists only where the sources fix it (BP rule 3; arch 07 line 361):
// these are K-01 v1's fixed lines, read from the pinned bundle's manifest (`lists.fixedLines`), by code alone, never
// through the composer.
//
// K-01 v1 holds the stop, START and HELP replies with no words yet (`stopReply`, `startReply` and `helpReply` are
// `pendingJay`, text null: Q-01 sends their drafted words to Jay on a tier 3 card before any release). While a line has
// no words in the bundle, its reply goes with Q-01's drafted default below; once the bundle carries Jay's words, those go,
// word for word. Every other line (`stopToBusiness`, `stopLaterReply`, ...) goes only as the bundle writes it.
//
// The drafted words keep each source's meaning:
//   - STOP (MC C1; RULES 7.2, 7.3; S13-32): Rosie's texts to this number are off for every business, never one
//     business's; and each step's other content stays (Q-01's default): the visit is still booked and how to cancel it
//     by a call (A7-11, B7-15; RULES 7.3), and START turns texts back on (S2-08; RULES 7.5). With a stop for every
//     business there may be no visit, or several, so the visit's line names none of them;
//   - START (RULES 7.5; MC C1): texts are back on, for every business, in one reply;
//   - HELP (RULES 7.6; MC C1; QUESTIONS.md M3-M3b.2): Rosie's name and number and how to stop. Rosie's number is a config
//     value (K-09 README default 21; Q-51), filled where the words hold `<rosieNumber>`.
// A line that still holds a placeholder after the fill (K-01's `<business>`: these replies are for every business, so
// they have no business to name) is not sent as it is: a Q-01 line falls back to its drafted default, any other has none.
//
// Never logged or put in a span: the words.

import type { ReplyWords } from "./types";

/** The K-01 v1 fixed lines whose words wait for Jay (Q-01), and the replies this path writes. */
export const STOP_REPLY = "stopReply";
export const START_REPLY = "startReply";
export const HELP_REPLY = "helpReply";

/**
 * Q-01's drafted default words, used only while the pinned bundle's line has none (`pendingJay`). Jay reviews them on the
 * tier 3 release card (Q-01; BP 9.2), and his words then ride in the bundle.
 */
export const Q01_DRAFTED: Readonly<Record<string, string>> = {
  [STOP_REPLY]:
    "Rosie's texts to this number are off, for every business. Any visit you booked is still booked; to cancel it, " +
    "call the business. Reply START to turn texts back on.",
  [START_REPLY]: "Rosie's texts to this number are back on, for every business. Reply STOP to turn them off.",
  [HELP_REPLY]:
    "This is Rosie, the automated booking assistant. Rosie's number is <rosieNumber>. To stop Rosie's texts to " +
    "this number, for every business, reply STOP.",
};

/**
 * K-09 v1.1 names RULES 7.5's notice to a business `textsOffReachTheirWay` (README default 50), where K-01 v1 holds the
 * same words as `stopToBusiness`. A K-09 id the bundle does not hold is read as its K-01 line.
 */
export const K09_LINE_IN_K01: Readonly<Record<string, string>> = {
  textsOffReachTheirWay: "stopToBusiness",
};

const ROSIE_NUMBER = "<rosieNumber>";
const PLACEHOLDER = /<[A-Za-z][A-Za-z0-9]*>/u;
/** A letter or a digit: a line with none is no line. */
const HAS_WORDS = /[\p{L}\p{N}]/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The pinned bundle's fixed lines (K-01 v1 `lists.fixedLines.lines`), each id with its words, or null while they wait
 * for Jay. An entry that is not K-01's shape is left out, and a manifest with no list gives none: every reply then has
 * only its Q-01 default, and every other line no words.
 */
export function fixedLinesOf(
  manifest: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string | null> {
  const lines = new Map<string, string | null>();
  const lists = manifest.lists;
  const fixedLines = isRecord(lists) ? lists.fixedLines : undefined;
  const entries = isRecord(fixedLines) ? fixedLines.lines : undefined;
  if (!Array.isArray(entries)) return lines;
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || lines.has(entry.id)) continue;
    const text = entry.text;
    if (typeof text === "string" || text === null) lines.set(entry.id, text);
  }
  return lines;
}

/** The words with Rosie's number filled in; null when a placeholder is left (or the number is needed and blank). */
function filled(text: string, rosieNumber: string): string | null {
  let out = text;
  if (out.includes(ROSIE_NUMBER)) {
    const number = rosieNumber.trim();
    if (number === "") return null;
    out = out.replaceAll(ROSIE_NUMBER, number);
  }
  return PLACEHOLDER.test(out) || !HAS_WORDS.test(out) ? null : out;
}

/**
 * A fixed line's words: the pinned bundle's when it has them, else Q-01's drafted default for the stop, START and HELP
 * replies; null when there are none to send as they are.
 */
export function wordsFor(
  fixedLineId: string,
  lines: ReadonlyMap<string, string | null>,
  rosieNumber: string,
): ReplyWords | null {
  const lineId = lines.has(fixedLineId) ? fixedLineId : (K09_LINE_IN_K01[fixedLineId] ?? fixedLineId);
  const inBundle = lines.get(lineId) ?? null;
  if (inBundle !== null) {
    const text = filled(inBundle, rosieNumber);
    if (text !== null) return { lineId, text, from: "bundle" };
  }
  const drafted = Q01_DRAFTED[lineId];
  if (drafted === undefined) return null;
  const text = filled(drafted, rosieNumber);
  return text === null ? null : { lineId, text, from: "q01Default" };
}
