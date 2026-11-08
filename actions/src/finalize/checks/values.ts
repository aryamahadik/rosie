// How the Values check reads the model's words (arch 07 line 409; S13-28 rule 51; RULES 3.14, 4.2): "each number, time,
// date, price, code, phone, link and name of a person or business matches a code-supplied fact", and "today" and
// "tomorrow" are slots filled at send. The text it reads has every slot value taken out already, so what is left of
// these was written by the model; each must still be held by a code-supplied fact (a slot value, a fact the composer
// was given, the reader's name or the master line's own words) or it fails.
//
// No detail quotes a piece of a filled value (T-1105; K-09 README default 32: "C-092's details name slots, never filled
// values"; T-310's security note b). A value glued to a letter or digit is not taken out of the words, and a scan that
// cuts into it would quote a piece the finalize answer's scrub cannot see, since it writes only a whole value as its
// slot: "11:00" of "11:00amx", "Springfieldx" of "88 Elm St, Springfieldx", "CodeAB" and "12" of "CodeAB12". That fault
// names the check and the slot instead, and a detail that would still hold such a piece is cut down to the check's name.

import COMMON_WORDS from "./common-words.json";
import { BUSINESS, LINK, QUOTE_SLOT, closingOf, escapeForPattern } from "./reading";
import type { CheckContext, CheckName, FinalParts, SlotValue } from "./types";

/** One kind of value and how the model may write it. The patterns are global: used only to replace (replaceIn). */
interface Scan {
  readonly noun: string;
  readonly pattern: RegExp;
  /** Whether the detail names the slots that hold this kind of value. */
  readonly namesSlots: boolean;
}

const MONEY = /[$€£]\s?\d[\d,]*(?:\.\d+)?/g;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const TIME = /\b\d{1,2}(?::\d\d)?\s?(?:[ap]\.m\.|[ap]m\b)|\b\d{1,2}:\d\d\b|\b(?:noon|midnight)\b/gi;
const DATE = new RegExp(
  [
    String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
    String.raw`\b(?:January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b\.?(?:\s\d{1,2}(?:st|nd|rd|th)?\b)?`,
    String.raw`\bMay\s\d{1,2}(?:st|nd|rd|th)?\b`,
    String.raw`\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)\b`,
  ].join("|"),
  "g",
);
const NUMBER = /\d+(?:[.,:]\d+)*/g;

/** The kinds in the order they are read, so a longer form is taken before the number inside it. */
const SCANS: readonly Scan[] = [
  { noun: "link", pattern: LINK, namesSlots: true },
  { noun: "price", pattern: MONEY, namesSlots: true },
  { noun: "phone number", pattern: PHONE, namesSlots: true },
  { noun: "time", pattern: TIME, namesSlots: true },
  { noun: "date", pattern: DATE, namesSlots: true },
  { noun: "number", pattern: NUMBER, namesSlots: false },
];

/** "today" and "tomorrow": slots filled at send in the reader's zone (arch 07 line 409), never words. */
const SEND_DAY = /\b(?:today|tomorrow)\b/gi;

/** Rosie's own name, which it says of itself (arch 07 line 351; the opener, S13-01). */
const OWN_NAMES: ReadonlySet<string> = new Set(["Rosie"]);

/**
 * The common words: each word the master writes in lower case in Rosie's own message lines, recorded from the master
 * by common-words.record.mjs, so no check needs the master at run time. No name is one (the master writes names
 * capitalized), so a capitalized word that starts a sentence and is one of these reads as a plain word, not a name.
 */
const COMMON: ReadonlySet<string> = new Set(COMMON_WORDS.words);

/** A word, with an apostrophe inside ("don't"). */
const WORD = /\p{L}+(?:['’]\p{L}+)*/gu;

/** A word in the word lists' form: lower case, with a straight apostrophe. */
const wordForm = (word: string): string => word.toLowerCase().replace(/[’‘]/g, "'");

/** A value's words in one form for matching: lower case, "11:00 a.m." as "11am", "$1,000.00" as "$1000". */
export function matchForm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d)\s+(?=[ap]\.?m\b)/g, "$1")
    .replace(/(\d)([ap])\.m\.?/g, "$1$2m")
    .replace(/:00(?=[ap]m\b)/g, "")
    .replace(/(\d)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d)\.00\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether `needle` stands in `source` as whole words: no letter or digit right before or after it, and no digit across
 * a point, comma or colon on either side (the guard after it is reading.ts wholePlaces's), so a shortened amount or
 * time is never held by the whole one: "$45" is not in "$45.99", "10" not in "10:30am", "45" not in "$12.45" (arch 07
 * lines 357 and 409).
 */
export function holdsWhole(source: string, needle: string): boolean {
  return new RegExp(
    `(?<![\\p{L}\\p{N}]|\\p{N}[.,:])${escapeForPattern(needle)}(?![\\p{L}\\p{N}]|[.,:]\\p{N})`,
    "u",
  ).test(source);
}

/**
 * What is code-supplied: each slot value (K-03 `slotValues`), each fact the composer was given, the reader's name, the
 * business's name (the one that fills a fixed line's <business>) and the master line's words outside its slots. A
 * quote is none: it holds someone's words, not a fact (arch 07 line 409).
 */
export function statedBy(parts: FinalParts, context: CheckContext): (item: string) => boolean {
  const facts = [...parts.slotValues, ...context.facts]
    .filter((fact) => fact.slot !== QUOTE_SLOT)
    .map((fact) => fact.value);
  const names = [context.readerName, context.businessName].filter((name) => name !== null);
  const master = context.masterText === null ? [] : [context.masterText.replace(/\{\{[^{}]*\}\}/g, " ")];
  const sources = [...facts, ...names, ...master].map(matchForm);
  return (item) => {
    const needle = matchForm(item);
    return needle !== "" && sources.some((source) => holdsWhole(source, needle));
  };
}

/** What the rewrite is told to do instead: the slots that hold this kind of value, when there are any. */
function advice(scan: Scan, parts: FinalParts): string {
  const holds = new RegExp(scan.pattern.source, scan.pattern.flags.replace("g", ""));
  const slots = scan.namesSlots
    ? parts.slotValues
        .filter((fact) => fact.slot !== QUOTE_SLOT && holds.test(fact.value))
        .map((fact) => `{{${fact.slot}}}`)
    : [];
  return slots.length === 0
    ? `write each ${scan.noun} as its slot.`
    : `write the ${scan.noun} as the ${slots.join(" or ")} slot.`;
}

/**
 * Whether a word is a plain word where a sentence starts, not a name: a common word (common-words.json) or a word of
 * one of the bundle's fixed lines (K-01 `fixedLines`, any language, <business> left out), each part of a hyphened word
 * ("Check-in") alike. A word of the step's master line is a code-supplied fact already (statedBy).
 */
export function plainWordsOf(context: CheckContext): (word: string) => boolean {
  const fixed = new Set(
    context.lists.fixedLines.lines.flatMap((line) =>
      line.text === null
        ? []
        : [...line.text.replaceAll(BUSINESS, " ").matchAll(WORD)].map(([word]) => wordForm(word)),
    ),
  );
  return (word) =>
    wordForm(word)
      .split("-")
      .every((part) => COMMON.has(part) || fixed.has(part));
}

// ---------------------------------------------------------------------------------------------------------------
// No piece of a filled value in a detail (T-1105): what the Values and Never-in-a-message checks may quote.

/** Where a filled value (K-03 `slotValues`) stands in a text a check reads: its slot and the characters it covers. */
export interface Place {
  readonly slot: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Each place in `text` where a filled value stands, whole or glued to a letter or digit: the longest value first, and
 * never a place inside another. A relay's quote stands nowhere: its words are the sender's, which a check quotes as the
 * model's wherever they stand outside the quote's own place (arch 07 line 409); nor does an empty value.
 */
export function placesOf(text: string, values: readonly SlotValue[]): Place[] {
  const places: Place[] = [];
  const filled = values
    .filter((fact) => fact.slot !== QUOTE_SLOT && fact.value.trim() !== "")
    .sort((a, b) => b.value.length - a.value.length);
  for (const { slot, value } of filled) {
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      const end = start + value.length;
      if (places.every((place) => end <= place.start || place.end <= start))
        places.push({ slot, start, end });
    }
  }
  return places;
}

/** What one check may quote of one text it reads: where the filled values stand in it, and the pieces split off. */
export interface Quoting {
  readonly check: CheckName;
  readonly text: string;
  readonly places: readonly Place[];
  /** Each piece of a filled value a scan split off, kept across every text the check reads (withoutPieces). */
  readonly pieces: string[];
}

/** A check's quoting of one text it reads (placesOf), keeping the pieces it splits off in `pieces`. */
export function quotingOf(
  check: CheckName,
  text: string,
  values: readonly SlotValue[],
  pieces: string[],
): Quoting {
  return { check, text, places: placesOf(text, values), pieces };
}

/**
 * The places the characters [start, end) of a quoting's text cut into: every place they touch, in the text's order,
 * when they hold one of them only in part, and none when they hold each place they touch whole. A value read whole,
 * glued or not ("rosfield.com/v/s03now"), is quoted as it stands, since the finalize answer writes its slot there
 * (T-313; DL-158 ruling c); a piece of one it cannot see. Each piece split off that holds a letter or digit is kept.
 */
export function cutInto(quoting: Quoting, start: number, end: number): Place[] {
  const touched = quoting.places
    .filter((place) => start < place.end && place.start < end)
    .sort((a, b) => a.start - b.start);
  const split = touched.filter((place) => place.start < start || end < place.end);
  for (const place of split) {
    const piece = quoting.text.slice(Math.max(start, place.start), Math.min(end, place.end));
    if (/[\p{L}\p{N}]/u.test(piece)) quoting.pieces.push(piece);
  }
  return split.length === 0 ? [] : touched;
}

/** What the rewrite is told where a fault would quote a piece of a filled value: the check and the slot, never the piece. */
export function cutFault(check: CheckName, slot: string): string {
  return check === "neverInMessage"
    ? `${check}: the slot {{${slot}}} reads with the words beside it as words that never go in a message; reword the text around it.`
    : `${check}: the slot {{${slot}}} is glued to the word beside it, so its value is not read whole; put a space between them.`;
}

/** `fault` as it is worded where nothing is cut, else the check and each slot cut into (cutFault). */
export function faultOr(quoting: Quoting, cut: readonly Place[], fault: string): string[] {
  return cut.length === 0 ? [fault] : [...new Set(cut.map((place) => cutFault(quoting.check, place.slot)))];
}

/** The fault for a piece of a quoting's text at [start, end): as worded, or the slots where it cuts into one (faultOr). */
export function quoted(quoting: Quoting, start: number, end: number, fault: string): string[] {
  return faultOr(quoting, cutInto(quoting, start, end), fault);
}

/** A check's faults, or its name alone where one would still hold a piece of a filled value a scan split off. */
export function withoutPieces(
  check: CheckName,
  faults: readonly string[],
  pieces: readonly string[],
): string[] {
  return faults.some((fault) => pieces.some((piece) => fault.includes(piece))) ? [check] : [...faults];
}

/** A character a scan put in, which stood nowhere in the text first read. */
const PUT = -1;

/** A text the scans read, with where each of its characters stood in the text first read (PUT where a scan put one). */
export interface Reading {
  readonly text: string;
  readonly at: readonly number[];
}

/** A text as first read: each character (a UTF-16 unit, as string indexes count) where it stands. */
const readingOf = (text: string): Reading => ({
  text,
  at: Array.from({ length: text.length }, (_, index) => index),
});

/** Where the characters [from, to) of a reading stood in the text first read: the first that stood there to the last. */
function spanOf(reading: Reading, from: number, to: number): [number, number] {
  let start = PUT;
  let end = PUT;
  for (let index = from; index < to; index += 1) {
    const stood = reading.at[index] ?? PUT;
    if (stood === PUT) continue;
    if (start === PUT) start = stood;
    end = stood + 1;
  }
  return [start, end];
}

/**
 * String#replace with a global pattern and a function, keeping where each character stood; `put` gets each place too.
 * It reads from the start, as String#replace does, whatever the shared pattern's lastIndex.
 */
function replaceIn(
  reading: Reading,
  pattern: RegExp,
  put: (item: string, start: number, end: number) => string,
): Reading {
  let text = "";
  let at: number[] = [];
  let last = 0;
  for (const match of reading.text.matchAll(new RegExp(pattern))) {
    const [item] = match;
    const [start, end] = spanOf(reading, match.index, match.index + item.length);
    const written = put(item, start, end);
    text += reading.text.slice(last, match.index) + written;
    at = at.concat(
      reading.at.slice(last, match.index),
      Array.from({ length: written.length }, () => PUT),
    );
    last = match.index + item.length;
  }
  return { text: text + reading.text.slice(last), at: at.concat(reading.at.slice(last)) };
}

/** A run of characters between spaces: a word as the names are read. */
const TOKEN = /\S+/g;

/**
 * The names of a person or business the model wrote that no code-supplied fact holds: each capitalized word (a
 * capital, then a small letter; STOP, HELP and AI are not names) that no fact holds and that is not Rosie's own name.
 * A word that starts a line or a sentence, follows ":" or " · ", or opens with a quote or a bracket is read as a name
 * too, unless it is a plain word (plainWordsOf). This fails closed: a plain word read as a name costs a rewrite or the
 * master's fallback line, while an invented name going out is the harm (arch 07 line 409; T-312 round 2). A name that
 * cuts into a filled value is never quoted: its fault names the slot (cutInto; T-1105).
 */
export function unstatedNames(
  reading: Reading,
  stated: (item: string) => boolean,
  plain: (word: string) => boolean,
  quoting: Quoting,
): string[] {
  const faults: string[] = [];
  let lineStart = 0;
  for (const line of reading.text.split("\n")) {
    let starts = true;
    for (const token of line.matchAll(TOKEN)) {
      const [raw] = token;
      const first = starts || /^[("“‘'[]/u.test(raw);
      starts = /[.!?:]["”’')\]]*$/u.test(raw) || raw === "·";
      const opened = raw.replace(/^[^\p{L}\p{N}]+/u, "");
      const word = opened.replace(/[^\p{L}\p{N}'’]+$/u, "");
      if (!/^\p{Lu}\p{Ll}/u.test(word)) continue;
      const bare = word.replace(/['’]s$/u, "");
      // Cut or not by what the fault quotes, the name without its "'s": a value ending "'s" it holds only in part.
      const from = lineStart + token.index + raw.length - opened.length;
      const [start, end] = spanOf(reading, from, from + bare.length);
      const cut = cutInto(quoting, start, end);
      if (OWN_NAMES.has(bare) || stated(word) || stated(bare)) continue;
      if (first && (plain(word) || plain(bare))) continue;
      faults.push(
        ...faultOr(
          quoting,
          cut,
          `The name ${bare} is not a code-supplied fact; write each name as its slot.`,
        ),
      );
    }
    lineStart += line.length + 1;
  }
  return faults;
}

/**
 * The values the model wrote that no code-supplied fact holds, each as the rewrite is told it. `text` is a send's words
 * with every slot value already taken out (reading.ts markOut), so all that is left is the model's own, and a value
 * glued to a letter or digit, which a scan may cut into: that fault names the slot, never the piece, and each piece
 * split off is kept in `pieces` (T-1105).
 */
export function unstatedValues(
  text: string,
  parts: FinalParts,
  stated: (item: string) => boolean,
  plain: (word: string) => boolean,
  pieces: string[],
): string[] {
  const quoting = quotingOf("values", text, parts.slotValues, pieces);
  const faults: string[] = [];
  let rest = replaceIn(readingOf(text), SEND_DAY, (item, start, end) => {
    const fault = `"${item}" is filled at send; write it as the {{${item.toLowerCase()}}} slot.`;
    faults.push(...quoted(quoting, start, end, fault));
    return " ";
  });
  for (const scan of SCANS) {
    rest = replaceIn(rest, scan.pattern, (item, start, end) => {
      const cut = cutInto(quoting, start, end);
      if (!stated(item)) {
        const fault = `The ${scan.noun} ${item.trim()} is not a code-supplied fact; ${advice(scan, parts)}`;
        faults.push(...faultOr(quoting, cut, fault));
      }
      return ` ${closingOf(item)}`;
    });
  }
  return [...faults, ...unstatedNames(rest, stated, plain, quoting)];
}
