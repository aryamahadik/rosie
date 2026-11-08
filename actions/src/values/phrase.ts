// The whole value phrase around a value's words (T-304 round 3, DL-189 item 2). Words that stand whole in a text can
// still leave out what the text says right beside them: "40" out of "40%" or "40¢", "$40" out of "$40 /hr", "3 tomorrow"
// out of "quarter to 3 tomorrow", "mañana a las 3" out of "mañana a las 3 y media", "tomorrow at 3pm" out of "tomorrow at
// 3pm PST". So a value of a type people write as a number (money, a count, a date or time) is re-read from the whole value
// phrase of the text its words came from:
//   1. the words stand whole in the text as the readers fold it (words.ts wholeAt), at each place they do, and the reader
//      reads the value from a run of them;
//   2. the whole phrase is that run of the text, widened on either side over the value's own pieces as long as there are
//      more: digits and their separators; number words as the reader joins them ("a hundred and forty", "forty one") and
//      scale words ("thousand", "k"); currency signs and units ("$", "%", "¢", "/hr", "percent", "cents", "dollars"); am
//      or pm, "o'clock", "noon" or "midnight", minutes ("thirty" in "three thirty"), zone words ("PST", "Pacific time");
//      the day a time is on and the time a day has ("3pm tomorrow", "tomorrow at 3pm", "Fri", "Oct 24"); cents after an
//      amount ("12 dollars and 50 cents"); the readers' own phrase words ("quarter to", "half past", "y media", "y cuarto",
//      "menos cuarto", "de la tarde"); and the other end of a range or a choice of two ("$12 to 15", "3 or 4pm", "4-6
//      people", "today or tomorrow");
//   3. the whole phrase is re-read, and every piece of it must be part of what the reader read: a piece the reader does
//      not read ("thirty" in "at three thirty", "k" in "$2k", "twenty" in "twenty to 3") leaves the phrase unread;
//   4. the value holds only if the whole phrase gives the same value. None, or a piece left unread, is noText; another
//      value differs; two are several; a zone word other than the value's zone is wrongZone.
// A per-unit after an amount ("/hr", "a foot") is no part of its value: "$40/hr" is $40, as K-02's "$12 a foot" is $12
// (default, for ops/QUESTIONS.md). Nothing here keeps or logs a value or the words; what it returns is a label.

import { amountsIn } from "./money";
import { numberPhrasesIn, numberWordsOf } from "./numbers";
import {
  countSpansIn,
  reparse,
  zoneWordSpansIn,
  type FieldType,
  type FieldValue,
  type ReparseContext,
  type ReparseFault,
} from "./reparse";
import { DAY_PATTERN, timeReadingOf } from "./times";
import { BOTH_LANGUAGES, findAll, foldWords, wholeAt, type Span, type ValueLanguage } from "./words";

/** The field types written as numbers, whose values are re-read from their whole value phrase. */
export type PhraseType = "integer" | "money" | "time";

/** Whether a field's type is one written as a number (money, a count, a date or time). */
export function isPhraseType(type: FieldType): type is PhraseType {
  return type === "integer" || type === "money" || type === "time";
}

/** Why a value fails its whole value phrase: a re-parse fault, or noText for a phrase none or not all of is read. */
export type PhraseFault = ReparseFault | "noText";

/** The spans of folded words the type's reader reads its value from: each amount, each count, or the time's words. */
function readingOf(type: PhraseType, folded: string, languages: readonly ValueLanguage[]): Span[] {
  switch (type) {
    case "money":
      return amountsIn(folded, languages).map(({ at, end }) => ({ at, end }));
    case "integer":
      return countSpansIn(folded, languages).map(({ at, end }) => ({ at, end }));
    case "time":
      return timeReadingOf(folded, languages).spans.map(({ at, end }) => ({ at, end }));
  }
}

/** What the reader read of folded words: its reading, and for a time also every zone word (reparse reads them). */
function consumedOf(type: PhraseType, folded: string, languages: readonly ValueLanguage[]): Span[] {
  const read = readingOf(type, folded, languages);
  return type === "time" ? [...read, ...zoneWordSpansIn(folded)] : read;
}

/** A number word pattern of the languages given, longest first, or one that never matches. */
function wordsPattern(words: readonly string[]): string {
  return words.length === 0 ? "(?!)" : [...words].sort((a, b) => b.length - a.length).join("|");
}

const MONEY_MARKS =
  /[\p{Sc}%]|(?<=\d)k\b|\b(?:k|percent|pct|cents?|centavos?|dollars?|bucks?|dolares|dolar|usd|grand|dozen|docenas?)\b/gu;
const COUNT_MARKS =
  /[\p{Sc}%]|(?<=\d)(?:am|pm|[ap]|st|nd|rd|th|k)\b|\b(?:am|pm|oclock|percent|pct|cents?|dollars?|bucks?|k|grand|dozen|docenas?)\b/gu;
const TIME_MARKS =
  /(?<=\d)(?:am|pm|[ap])\b|\b(?:am|pm|oclock|noon|midnight|midday|mediodia|medianoche|quarter|half|media|cuarto|menos)\b/gu;

/** The pieces of a value phrase that must be read: digits, number words, and the type's signs, units and phrase words. */
function piecesIn(type: PhraseType, folded: string, languages: readonly ValueLanguage[]): Span[] {
  const numberWords = wordsPattern([...numberWordsOf(languages).keys()]);
  const marks = type === "money" ? MONEY_MARKS : type === "integer" ? COUNT_MARKS : TIME_MARKS;
  const pieces: Span[] = [
    ...findAll(folded, /\d+/g),
    ...findAll(folded, new RegExp(String.raw`\b(?:${numberWords})\b`, "g")),
    ...findAll(folded, marks),
  ];
  if (type === "time") pieces.push(...zoneWordSpansIn(folded));
  return pieces;
}

/** Whether a piece lies inside one of the spans read. */
function within(piece: Span, read: readonly Span[]): boolean {
  return read.some((span) => span.at <= piece.at && piece.end <= span.end);
}

/** How a type's value phrase widens: patterns ending right before it, patterns starting right after it. */
interface Widening {
  readonly left: readonly RegExp[];
  readonly right: readonly RegExp[];
}

const NUMBER = String.raw`\d+(?:[.,:]\d+)*`;
const SCALE = String.raw`(?:hundred|thousand|million|mil|grand|k|dozen|docenas?)\b`;
/** A group of three digits after a space: spaced thousands ("$1 200"), which the readers read as two numbers. */
const SPACED_THOUSANDS = /^ \d{3}(?!\d)/;

function wideningFor(type: PhraseType, languages: readonly ValueLanguage[]): Widening {
  const words = numberWordsOf(languages);
  const all = wordsPattern([...words.keys()]);
  // Minutes after an hour ("three thirty", "tres y diez"): number words from 2 to 59, never a one ("un", "una", "one").
  const minutes = wordsPattern(
    [...words].filter(([, word]) => word.value >= 2 && word.value <= 59).map(([name]) => name),
  );
  switch (type) {
    case "money":
      return {
        left: [
          /(?:us ?\$|usd ?|\$) ?$/,
          /\p{Sc} ?$/u,
          new RegExp(String.raw`(?:\$ ?)?${NUMBER} ?(?:-|to|or|o) ?\$? ?$`),
          new RegExp(String.raw`\b(?:${all}) (?:to|or|o) $`),
        ],
        right: [
          /^(?:[.,]\d+)+/,
          /^ ?(?:%|¢|k\b)/u,
          /^ ?\/ ?[a-z]+\b/,
          new RegExp(
            String.raw`^ (?:percent|per cent|por ciento|pct|cents?|centavos?|dollars?|bucks?|dolares|dolar|usd|${SCALE})`,
          ),
          new RegExp(String.raw`^ ?(?:-|to|or|o) ?\$? ?${NUMBER}`),
          new RegExp(String.raw`^ (?:to|or|o) (?:${all})\b`),
          new RegExp(
            String.raw`^ (?:and|y) (?:\d+ ?(?:cents?\b|centavos?\b|¢)|(?:${all}) (?:cents?|centavos?)\b)`,
            "u",
          ),
          SPACED_THOUSANDS,
        ],
      };
    case "integer":
      return {
        left: [
          /\p{Sc} ?$/u,
          new RegExp(String.raw`${NUMBER} ?(?:-|to|or|o) ?$`),
          new RegExp(String.raw`\b(?:${all}) (?:to|or|o) $`),
        ],
        right: [
          /^(?:[.,:/]\d+)+/,
          /^(?:am|pm|[ap]|st|nd|rd|th|k)\b/,
          /^ ?(?:%|¢)/u,
          new RegExp(
            String.raw`^ (?:am|pm|oclock|percent|per cent|por ciento|pct|cents?|dollars?|bucks?|${SCALE})`,
          ),
          new RegExp(String.raw`^ ?(?:-|to|or|o) ?${NUMBER}`),
          new RegExp(String.raw`^ (?:to|or|o) (?:${all})\b`),
          SPACED_THOUSANDS,
        ],
      };
    case "time":
      return {
        left: [
          /\b(?:a )?(?:quarter|half) (?:to|till|til|of|before|past|after) $/,
          new RegExp(
            String.raw`\b(?:(?:${all})(?: minutes?)?|\d{1,2} minutes?) (?:to|till|til|of|before|past|after) $`,
          ),
          /\b\d{1,2}(?:[:.]\d{2})?(?: ?(?:am|pm))? ?(?:-|or|o|and|y) ?$/,
          // The day the time is on, and a time of day before a day ("tomorrow at 3pm", "3pm tomorrow").
          new RegExp(String.raw`\b${DAY_PATTERN},? (?:at |a las |a la |para las |on )?$`),
          /\b\d{1,2}(?:(?:[:.]\d{2})? ?(?:am|pm)|[:.]\d{2}) (?:on )?$/,
        ],
        right: [
          new RegExp(String.raw`^,? (?:on |or |o )?${DAY_PATTERN}(?![\w/])`),
          new RegExp(String.raw`^ (?:at|a las|a la|para las) (?:\d{1,2}(?:[:.]\d{2})?(?!\d)|(?:${all})\b)`),
          /^ \d{1,2}(?:(?:[:.]\d{2})? ?(?:am|pm)\b|[:.]\d{2}(?!\d))/,
          /^ (?:noon|midnight|midday|mediodia|medianoche)\b/,
          /^(?:[:.]\d+)+/,
          /^(?:am|pm|[ap])\b/,
          /^ (?:am|pm|oclock)\b/,
          /^ (?:y|and) (?:media|cuarto|a half|half)\b/,
          new RegExp(String.raw`^ menos (?:cuarto|${minutes}|\d{1,2})\b`),
          new RegExp(String.raw`^ y (?:${minutes})\b`),
          /^ (?:de|por|en) la (?:tarde|manana|noche)\b/,
          /^ in the (?:morning|afternoon|evening)\b/,
          /^ (?:at night|tonight)\b/,
          new RegExp(String.raw`^ (?:${minutes})\b`),
          /^ \d{2}(?!\d)/,
          /^ ?(?:-|or|o|and|y) ?\d{1,2}(?:[:.]\d{2})?(?!\d)/,
        ],
      };
  }
}

/** The longest match of any pattern, by its length (0 for none). */
function longest(patterns: readonly RegExp[], text: string): number {
  let most = 0;
  for (const pattern of patterns) most = Math.max(most, pattern.exec(text)?.[0].length ?? 0);
  return most;
}

/** The whole value phrase: `span` of `folded`, widened over the type's pieces on either side while any is there. */
function widen(type: PhraseType, folded: string, span: Span, languages: readonly ValueLanguage[]): Span {
  const widening = wideningFor(type, languages);
  // Number words the reader joins into one number ("a hundred and forty") widen the phrase as one piece.
  const numbers = numberPhrasesIn(folded, languages);
  const zones = type === "time" ? zoneWordSpansIn(folded) : [];
  let { at, end } = span;
  for (;;) {
    let nextAt = at - longest(widening.left, folded.slice(0, at));
    let nextEnd = end + longest(widening.right, folded.slice(end));
    if (/^(?:hundred|thousand)\b/.test(folded.slice(nextAt))) {
      nextAt -= /\b(?:a|an) $/.exec(folded.slice(0, nextAt))?.[0].length ?? 0;
    }
    if (type !== "time" && /^\d{3}(?!\d)/.test(folded.slice(nextAt))) {
      nextAt -= /(?:\$ ?)?\b\d{1,3} $/.exec(folded.slice(0, nextAt))?.[0].length ?? 0;
    }
    for (const phrase of numbers) {
      if (phrase.at < nextEnd && nextAt < phrase.end) {
        nextAt = Math.min(nextAt, phrase.at);
        nextEnd = Math.max(nextEnd, phrase.end);
      }
    }
    for (const zone of zones) {
      if (zone.at >= nextEnd && /^ ?\(?$/.test(folded.slice(nextEnd, zone.at))) {
        nextEnd = zone.end + (/^(?: time)?\)?/.exec(folded.slice(zone.end))?.[0].length ?? 0);
      } else if (zone.end <= nextAt && folded.slice(zone.end, nextAt) === " ") {
        nextAt = zone.at;
      }
    }
    if (nextAt === at && nextEnd === end) return { at, end };
    at = nextAt;
    end = nextEnd;
  }
}

/**
 * Whether `value`, of `type`, holds on the whole value phrase its `words` stand in, in `text` (steps 1 to 4): null when
 * it does, else the fault as a label. Types not written as numbers have no value phrase: null. `context` is reparse's.
 */
export function wholePhraseFault(
  type: FieldType,
  value: FieldValue,
  text: string,
  words: string,
  context: ReparseContext,
): PhraseFault | null {
  if (!isPhraseType(type)) return null;
  const languages = context.languages ?? BOTH_LANGUAGES;
  const folded = foldWords(text);
  const cited = foldWords(words);
  const places = wholeAt(folded, cited);
  const read = readingOf(type, cited, languages);
  if (places.length === 0 || read.length === 0) return "noText";
  const from = Math.min(...read.map((span) => span.at));
  const to = Math.max(...read.map((span) => span.end));
  for (const place of places) {
    const whole = widen(type, folded, { at: place + from, end: place + to }, languages);
    const phrase = folded.slice(whole.at, whole.end);
    const result = reparse(type, value, phrase, context);
    if (!result.ok) return result.why === "noValue" ? "noText" : result.why;
    const consumed = consumedOf(type, phrase, languages);
    if (piecesIn(type, phrase, languages).some((piece) => !within(piece, consumed))) return "noText";
  }
  return null;
}
