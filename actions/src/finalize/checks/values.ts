// How the Values check reads the model's words (arch 07 line 409; S13-28 rule 51; RULES 3.14, 4.2): "each number, time,
// date, price, code, phone, link and name of a person or business matches a code-supplied fact", and "today" and
// "tomorrow" are slots filled at send. The text it reads has every slot value taken out already, so what is left of
// these was written by the model; each must still be held by a code-supplied fact (a slot value, a fact the composer
// was given, the reader's name or the master line's own words) or it fails.

import COMMON_WORDS from "./common-words.json";
import { BUSINESS, LINK, QUOTE_SLOT, closingOf, escapeForPattern } from "./reading";
import type { CheckContext, FinalParts } from "./types";

/** One kind of value and how the model may write it. The patterns are global: used only with String#replace. */
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
 * What is code-supplied: each slot value (K-03 `slotValues`), each fact the composer was given, the reader's name and
 * the master line's words outside its slots. A quote is none: it holds someone's words, not a fact (arch 07 line 409).
 */
export function statedBy(parts: FinalParts, context: CheckContext): (item: string) => boolean {
  const facts = [...parts.slotValues, ...context.facts]
    .filter((fact) => fact.slot !== QUOTE_SLOT)
    .map((fact) => fact.value);
  const reader = context.readerName === null ? [] : [context.readerName];
  const master = context.masterText === null ? [] : [context.masterText.replace(/\{\{[^{}]*\}\}/g, " ")];
  const sources = [...facts, ...reader, ...master].map(matchForm);
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

/**
 * The names of a person or business the model wrote that no code-supplied fact holds: each capitalized word (a
 * capital, then a small letter; STOP, HELP and AI are not names) that no fact holds and that is not Rosie's own name.
 * A word that starts a line or a sentence, follows ":" or " · ", or opens with a quote or a bracket is read as a name
 * too, unless it is a plain word (plainWordsOf). This fails closed: a plain word read as a name costs a rewrite or the
 * master's fallback line, while an invented name going out is the harm (arch 07 line 409; T-312 round 2).
 */
export function unstatedNames(
  text: string,
  stated: (item: string) => boolean,
  plain: (word: string) => boolean,
): string[] {
  const faults: string[] = [];
  for (const line of text.split("\n")) {
    let starts = true;
    for (const raw of line.split(/\s+/)) {
      if (raw === "") continue;
      const first = starts || /^[("“‘'[]/u.test(raw);
      starts = /[.!?:]["”’')\]]*$/u.test(raw) || raw === "·";
      const word = raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}'’]+$/u, "");
      if (!/^\p{Lu}\p{Ll}/u.test(word)) continue;
      const bare = word.replace(/['’]s$/u, "");
      if (OWN_NAMES.has(bare) || stated(word) || stated(bare)) continue;
      if (first && (plain(word) || plain(bare))) continue;
      faults.push(`The name ${bare} is not a code-supplied fact; write each name as its slot.`);
    }
  }
  return faults;
}

/**
 * The values the model wrote that no code-supplied fact holds, each as the rewrite is told it. `text` is a send's words
 * with every slot value already taken out (reading.ts markOut), so all that is left is the model's own.
 */
export function unstatedValues(
  text: string,
  parts: FinalParts,
  stated: (item: string) => boolean,
  plain: (word: string) => boolean,
): string[] {
  const faults: string[] = [];
  let rest = text.replace(SEND_DAY, (item) => {
    faults.push(`"${item}" is filled at send; write it as the {{${item.toLowerCase()}}} slot.`);
    return " ";
  });
  for (const scan of SCANS) {
    rest = rest.replace(scan.pattern, (item) => {
      if (!stated(item))
        faults.push(`The ${scan.noun} ${item.trim()} is not a code-supplied fact; ${advice(scan, parts)}`);
      return ` ${closingOf(item)}`;
    });
  }
  return [...faults, ...unstatedNames(rest, stated, plain)];
}
