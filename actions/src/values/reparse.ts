// Re-parse one value from its source words (T-304; arch 03 line 185: "code confirms the quote and re-parses every value
// from its words"; arch 06 line 309, limit 6). The value is the model's, in the type its field names (K-02 v1 fieldValue;
// contracts/bundle answerField.type); the words are the person's, exactly as K-02 v1's field.words gives them. A value
// re-parses when the words name exactly one value of that type and the model's is it:
//   - text: every word of the value is a word of theirs (case, accents and punctuation aside);
//   - integer: the one count in the words (digits or number words), leaving amounts, dates and times alone;
//   - boolean: the words say yes or no, not both;
//   - money: the one amount in the words (money.ts), in whole cents and its currency;
//   - time: the one date and time in the words, read from the send time in a zone the value may be in (times.ts): the
//     visit's, or for a video or phone visit either side's (S13-03); an hour with no am or pm may be either; a zone the
//     time's own words name ("3pm PST") must be the value's zone, or it is the wrong one (DL-189);
//   - zone: the one time zone the words name ("Pacific", "ET", an IANA name);
//   - id: the id stands in the words as a whole;
//   - choice: the words name exactly one of the question's options, by its number, letter or words.
// Words that hold no such value give `noValue`: a value the model gave with no source words for it is refused. Nothing
// here keeps or logs a value or the words; what it returns is a label.

import { amountsIn, distinctMoney, sameMoney, type Money } from "./money";
import { numberPhrasesIn } from "./numbers";
import { LETTER_OR_DIGIT, NUMBER_END, NUMBER_START, instantsFor, timeReadingOf, timeSpansIn } from "./times";
import {
  BOTH_LANGUAGES,
  findAll,
  foldWords,
  overlaps,
  wordsOf,
  type Span,
  type ValueLanguage,
} from "./words";
import { isZone } from "./zone";

/** A field's value type (contracts/bundle answerField.type). */
export type FieldType = "text" | "integer" | "boolean" | "money" | "time" | "zone" | "id" | "choice";

/** The value types a field may name, in order (contracts/bundle answerField.type). */
export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "integer",
  "boolean",
  "money",
  "time",
  "zone",
  "id",
  "choice",
];

/** A time: the instant in UTC and the IANA zone it is shown and reasoned in (CQ-09; K-02 fieldValue time). */
export interface ZonedTime {
  readonly utc: string;
  readonly zone: string;
}

/** A value as the model gives it (K-02 v1 fieldValue). */
export type FieldValue = string | number | boolean | Money | ZonedTime;

/** One option of an open question, as offered: its id (a choice field's value) and its words. */
export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

export interface ReparseContext {
  /** When the words were sent: the text's send time, UTC (K-02 v1 text.sentAt.utc). */
  readonly sentAt: string;
  /** The zones a date or time may resolve in: the visit's, then for a video or phone visit the other side's (S13-03). */
  readonly zones: readonly string[];
  /** The languages whose number, money and time words to read; default both. */
  readonly languages?: readonly ValueLanguage[];
  /** For a choice field: the question's options as offered, in order. */
  readonly options?: readonly ChoiceOption[];
}

/**
 * Why a value does not re-parse, as a label:
 *   typeMismatch  the value is not of its field's type;
 *   noValue       the words hold no value of that type (the model gave one with no source words for it);
 *   several       the words hold more than one, so none can be confirmed;
 *   differs       the words hold one, and it is not the model's;
 *   wrongZone     a time in a zone other than the visit's (or, for a video or phone visit, the other side's);
 *   noZone        no zone is known to resolve a date in;
 *   unreadable    the value's instant or the send time cannot be read.
 */
export type ReparseFault =
  "typeMismatch" | "noValue" | "several" | "differs" | "wrongZone" | "noZone" | "unreadable";

export type Reparse = { readonly ok: true } | { readonly ok: false; readonly why: ReparseFault };

const OK: Reparse = { ok: true };
const fault = (why: ReparseFault): Reparse => ({ ok: false, why });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value is money: whole cents and a three-letter currency code. */
export function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    typeof value.cents === "number" &&
    Number.isSafeInteger(value.cents) &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency)
  );
}

/** Whether a value is a time: a UTC instant and a zone name. */
export function isZonedTime(value: unknown): value is ZonedTime {
  return isRecord(value) && typeof value.utc === "string" && typeof value.zone === "string";
}

/** One answer when the words hold exactly one distinct value; else the fault. */
function theOne<T>(found: readonly T[], same: (a: T, b: T) => boolean, value: T): Reparse {
  const distinct: T[] = [];
  for (const each of found) if (!distinct.some((other) => same(other, each))) distinct.push(each);
  const [first, ...rest] = distinct;
  if (first === undefined) return fault("noValue");
  if (rest.length > 0) return fault("several");
  return same(first, value) ? OK : fault("differs");
}

// ---- counts, yes or no, zones, options --------------------------------------------------------------------------------

/**
 * A count in digits: "4", "1,200", "2.5". It starts and ends at the time reader's number edge (T-1130; times.ts
 * NUMBER_START and NUMBER_END, DL-228 item 1): a mark is part of the number only with a digit right before it and right
 * after it, and a comma only as a thousands mark, so a count glued to a mark is read ("table for 4 or 5:)", "re:4 or 5",
 * "Update:2 adults + 1 child") and "4, 5" or "3,4" are two. A letter glued to it ("3rd", "4pm"), a "$" beside it or a
 * "%" after it makes it no count, as before.
 */
const NUMERAL = new RegExp(
  String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?${NUMBER_END}(?!${LETTER_OR_DIGIT}|[%$])`,
  "g",
);
const NONE = /\b(?:none|ninguno|ninguna)\b/g;
/** Dozens in words (T-304 round 4, DL-199 item 2: a count is read with its scale): half a dozen is 6, a dozen 12. */
const DOZENS: readonly (readonly [RegExp, number])[] = [
  [/\b(?:half (?:a )?dozen|half-dozen|media docena)\b/g, 6],
  [/\b(?:a|one|una|un) (?:dozen|docena)\b/g, 12],
];
/** A dozen after a count: "2 dozen" is 24, "dos docenas" 24. */
const DOZEN_AFTER = /^ (?:dozens?|docenas?)\b/;
/**
 * A count's unit after it, part of its words and not its value (DL-199 item 1: "the number with its unit"); "ppl" and
 * "pax" as people write them in a booking (T-1130).
 */
const COUNT_UNITS = String.raw`people|ppl|pax|persons?|adults?|kids?|children|child|guests?|of us|personas?|adultos?|ninos?|ninas?|invitados?`;
const COUNT_UNIT = new RegExp(String.raw`^ (?:${COUNT_UNITS})\b`);
/** Whether a count's folded words end with its unit ("2 people", "two adults", "4 pax"). */
export const ENDS_WITH_COUNT_UNIT = new RegExp(String.raw` (?:${COUNT_UNITS})$`);

/** One count and where it stands in the folded words. */
export interface FoundCount extends Span {
  readonly value: number;
}

/**
 * Every count in the words, with where it stands in their folded form: digits and number words, with a dozen after them
 * ("2 dozen" is 24; "a dozen" 12, "half a dozen" 6), "none" as 0. Amounts of money, dates and times of day stand apart:
 * "a table for 4 at 7pm" holds the count 4.
 */
export function countSpansIn(
  words: string,
  languages: readonly ValueLanguage[] = BOTH_LANGUAGES,
): FoundCount[] {
  const folded = foldWords(words);
  const apart: Span[] = [
    ...amountsIn(words, languages).filter((amount) => amount.marked),
    ...timeSpansIn(folded),
  ];
  const counts: FoundCount[] = [];
  const withUnit = (count: FoundCount): FoundCount => {
    const unit = COUNT_UNIT.exec(folded.slice(count.end));
    return unit === null ? count : { ...count, end: count.end + unit[0].length };
  };
  const take = (count: FoundCount): void => {
    if (overlaps(count, counts)) return;
    const dozen = DOZEN_AFTER.exec(folded.slice(count.end));
    counts.push(
      withUnit(
        dozen === null ? count : { value: count.value * 12, at: count.at, end: count.end + dozen[0].length },
      ),
    );
  };
  for (const [pattern, value] of DOZENS) {
    for (const found of findAll(folded, pattern)) {
      if (!overlaps(found, counts)) counts.push(withUnit({ value, at: found.at, end: found.end }));
    }
  }
  for (const found of findAll(folded, NUMERAL)) {
    const whole = Number((found.groups[0] ?? "").replaceAll(",", ""));
    const value = found.groups[1] === undefined ? whole : Number(`${String(whole)}.${found.groups[1]}`);
    take({ value, at: found.at, end: found.end });
  }
  for (const phrase of numberPhrasesIn(folded, languages)) take(phrase);
  for (const found of findAll(folded, NONE)) take({ value: 0, at: found.at, end: found.end });
  return counts.filter((count) => !overlaps(count, apart)).sort((a, b) => a.at - b.at);
}

/** Every count in the words, in order (countSpansIn's values). */
export function countsIn(words: string, languages: readonly ValueLanguage[] = BOTH_LANGUAGES): number[] {
  return countSpansIn(words, languages).map((count) => count.value);
}

const YES = /\b(?:yes|yeah|yep|yup|sure|ok|okay|si|claro|correct|true|absolutely|definitely)\b/;
const NO = /\b(?:no|nope|nah|not|never|don'?t|false|nunca|tampoco)\b/;

/** What the words say, yes or no: true, false, both or neither. */
export function yesOrNoIn(words: string): boolean[] {
  const folded = foldWords(words);
  return [...(YES.test(folded) ? [true] : []), ...(NO.test(folded) ? [false] : [])];
}

const ZONE_WORDS: readonly [RegExp, string][] = [
  [/\b(?:eastern|et|est|edt|hora del este)\b/, "America/New_York"],
  [/\b(?:central|ct|cst|cdt|hora central)\b/, "America/Chicago"],
  [/\b(?:mountain|mt|mst|mdt|hora de la montana)\b/, "America/Denver"],
  [/\barizona\b/, "America/Phoenix"],
  [/\b(?:pacific|pt|pst|pdt|hora del pacifico)\b/, "America/Los_Angeles"],
  [/\b(?:alaska|akst|akdt)\b/, "America/Anchorage"],
  [/\b(?:hawaii|hst)\b/, "Pacific/Honolulu"],
];
const IANA_NAME = /\b[a-z]+(?:\/[a-z0-9_+-]+)+/g;

/** The time zones the words name, as lower-case IANA names: a US zone's name or letters, or an IANA name itself. */
export function zonesNamedIn(words: string): string[] {
  const folded = foldWords(words);
  const named = ZONE_WORDS.filter(([pattern]) => pattern.test(folded)).map(([, zone]) => zone.toLowerCase());
  for (const found of findAll(folded, IANA_NAME)) {
    const name = folded.slice(found.at, found.end);
    if (isZone(name)) named.push(name);
  }
  return named;
}

/** One zone word and where it stands in the folded words, with the zone it names (a lower-case IANA name). */
export interface ZoneWord extends Span {
  readonly zone: string;
}

/** Every zone word in the words, with where it stands in their folded form: "PST", "Pacific", "hora del este". */
export function zoneWordSpansIn(words: string): ZoneWord[] {
  const folded = foldWords(words);
  const found: ZoneWord[] = [];
  for (const [pattern, zone] of ZONE_WORDS) {
    for (const each of findAll(folded, pattern))
      found.push({ at: each.at, end: each.end, zone: zone.toLowerCase() });
  }
  for (const each of findAll(folded, IANA_NAME)) {
    const name = folded.slice(each.at, each.end);
    if (isZone(name)) found.push({ at: each.at, end: each.end, zone: name });
  }
  return found;
}

/**
 * The zone words inside the time the words read (its spans, `read`) or right beside it, a space, a comma or a bracket
 * between (T-304 round 3, DL-189 item 2; round 4, DL-199 item 2: "3pm, PST"): "3pm PST", "3pm (Pacific time)", "PT 3pm",
 * "PST, 3pm". A zone word elsewhere in the words ("PT session") names no zone for the time.
 */
export function zoneWordsOfTime(words: string, read: readonly Span[]): ZoneWord[] {
  if (read.length === 0) return [];
  const folded = foldWords(words);
  const from = Math.min(...read.map((span) => span.at));
  const to = Math.max(...read.map((span) => span.end));
  return zoneWordSpansIn(words).filter((word) => {
    if (word.at >= to) return /^[ ,(]*$/.test(folded.slice(to, word.at));
    if (word.end <= from) return /^[ ,]*$/.test(folded.slice(word.end, from));
    return true;
  });
}

/** The distinct zones named inside the time the words read or right beside it (zoneWordsOfTime). */
function zonesOfTime(words: string, read: readonly Span[]): string[] {
  return [...new Set(zoneWordsOfTime(words, read).map((word) => word.zone))];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** A leading mark an option's words may carry: "1 ", "1) ", "1. ", "A) ". */
const LEADING_MARK = /^(?:\d+[.):]?|[a-z][.):])\s+/;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `needle` stands in `folded` as whole words. */
function holdsWords(folded: string, needle: string): boolean {
  return (
    needle !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escaped(needle)}(?![\\p{L}\\p{N}])`, "u").test(folded)
  );
}

/** The ids of the options the words name: by number, by letter (alone or marked: "A", "b)"), or by their words. */
export function optionsNamedIn(words: string, options: readonly ChoiceOption[]): string[] {
  const folded = foldWords(words);
  const bare = folded.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const named: string[] = [];
  options.forEach((option, index) => {
    const number = String(index + 1);
    const letter = LETTERS[index];
    const label = foldWords(option.label).replace(LEADING_MARK, "");
    const byNumber = holdsWords(folded, number);
    const byLetter =
      letter !== undefined && (bare === letter || new RegExp(`^\\(?${letter}[.):](?:\\s|$)`).test(folded));
    if (byNumber || byLetter || holdsWords(folded, label)) named.push(option.id);
  });
  return named;
}

// ---- the re-parse -------------------------------------------------------------------------------------------------

function reparseTime(value: FieldValue, words: string, context: ReparseContext): Reparse {
  if (!isZonedTime(value)) return fault("typeMismatch");
  const valueMs = Date.parse(value.utc);
  const sentMs = Date.parse(context.sentAt);
  if (!Number.isFinite(valueMs) || !Number.isFinite(sentMs)) return fault("unreadable");
  const zones = context.zones.filter((zone) => isZone(zone));
  if (zones.length === 0) return fault("noZone");
  if (!zones.includes(value.zone)) return fault("wrongZone");
  const { read, spans } = timeReadingOf(words, context.languages ?? BOTH_LANGUAGES);
  if (read.kind === "none") return fault("noValue");
  if (read.kind === "several") return fault("several");
  // A zone the time's own words name ("3pm PST") is the one it is in: any other zone is the wrong one (DL-189 item 2).
  const [named, ...more] = zonesOfTime(words, spans);
  if (more.length > 0) return fault("several");
  if (named !== undefined && named !== value.zone.toLowerCase()) return fault("wrongZone");
  return instantsFor(read.time, sentMs, value.zone).includes(valueMs) ? OK : fault("differs");
}

/**
 * Whether `value`, of `type`, re-parses from `words`: OK, or the fault as a label. `context` gives the send time and the
 * zones a time resolves in, the languages to read, and a choice field's options.
 */
export function reparse(type: FieldType, value: FieldValue, words: string, context: ReparseContext): Reparse {
  const languages = context.languages ?? BOTH_LANGUAGES;
  switch (type) {
    case "text": {
      if (typeof value !== "string") return fault("typeMismatch");
      const told = wordsOf(value);
      if (told.length === 0) return fault("noValue");
      const said = new Set(wordsOf(words));
      return told.every((word) => said.has(word)) ? OK : fault("differs");
    }
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return fault("typeMismatch");
      return theOne(countsIn(words, languages), (a, b) => a === b, value);
    case "boolean":
      if (typeof value !== "boolean") return fault("typeMismatch");
      return theOne(yesOrNoIn(words), (a, b) => a === b, value);
    case "money":
      if (!isMoney(value)) return fault("typeMismatch");
      return theOne(
        distinctMoney(amountsIn(words, languages).map((amount) => amount.money)),
        sameMoney,
        value,
      );
    case "time":
      return reparseTime(value, words, context);
    case "zone":
      if (typeof value !== "string" || !isZone(value)) return fault("typeMismatch");
      return theOne(zonesNamedIn(words), (a, b) => a === b, value.toLowerCase());
    case "id":
      if (typeof value !== "string" || value === "") return fault("typeMismatch");
      return holdsWords(foldWords(words), foldWords(value)) ? OK : fault("noValue");
    case "choice":
      if (typeof value !== "string") return fault("typeMismatch");
      return theOne(optionsNamedIn(words, context.options ?? []), (a, b) => a === b, value);
  }
}
