// The whole value phrase around a value's words (T-304 round 4, DL-199: the readers define the phrase). Words that stand
// whole in a text can still leave out what the text says right beside them: "40" out of "40 euros", "$1" out of "$1
// million", "tomorrow at 3pm" out of "the day after tomorrow at 3pm", "at 3" out of "tomorrow afternoon at 3", "tomorrow"
// out of "tomorrow at noon" or "tomorrow, 3pm", "tomorrow at 3pm" out of "tomorrow at 3pm, PST". So a value of a type
// people write as a number (money, a count, a date or time) is re-read from its whole phrase, and the phrase is the
// readers' own, never a pattern list of its own (round 3's method, which DL-199 dropped):
//   1. the person's whole text is read with the same reader that read the field, and every place it reads a value of the
//      type is one value of the text, with its span: for money each amount with its sign, currency word, scale, per-unit
//      and range (money.ts amountsIn: "40 euros", "$1 million", "$40/hr", "$12-15"); for a count each count with its
//      dozen (reparse.ts countSpansIn: "2 dozen"); for a time each day, time of day, elapsed time and morning or
//      afternoon word the time reader takes (times.ts timeReadingOf: "the day after tomorrow", "next Friday", "pasado
//      mañana", "noon", "at 3", "quarter to 3", "afternoon", "de la tarde") and each zone word (reparse.ts
//      zoneWordSpansIn: "PST", "Pacific");
//   2. values side by side are one phrase when only spaces, commas or joining words stand between them: for a time the
//      cues ("at", "on", "in the", "a las", "al", "de", "around" and the like, TIME_CUES) and "or" or "and"; for money and
//      counts a range or choice word ("to", "or", "and", "-", "/", "y", "o", "a");
//   3. a number the reader did not read belongs to the phrase when a range word joins it to the phrase ("twenty to 3",
//      "10 - $15", "3 or 4pm"), or when it stands right after a time or an amount with one space between ("at 3 30", "at
//      three thirty", "$1 200"): a count's reader reads every number that is no amount or time, so a count takes none;
//   3b. a bare hour the time reader reads beside a day or after a part-of-day word (times.ts bareHours: "Thursday, 3", "3
//      tomorrow", "tomorrow morning, 9") belongs to the phrase beside it whatever other time the text holds (T-304 round
//      5, DL-209), so "Thursday" out of "my 2pm doesn't work. can we do Thursday, 3?" differs: the hour joins when the
//      reader takes it reading that phrase with the hour on its own, as it does unless the phrase already names its time
//      of day ("2" of "table for 2 tomorrow at 3pm" stays a count, as round 4 holds); the phrases are then joined again
//      (steps 2 and 3), so a time a comma joins comes in too ("2pm, 3 tomorrow");
//   4. the phrase that holds the cited words (where they stand whole: words.ts wholeAt) is re-read on its own with the same
//      re-parse, and the value holds only if it gives the field's value and every number, currency sign and zone word in
//      it was read. None, or a piece left unread, is noText; another value differs; two are several; a zone word that is
//      not the value's zone is wrongZone; cited words that touch two phrases are several.
// The residual (DL-199 item 4; CQ-121: "a word no reader knows ("next week", "LA time", "UTC") is not read, and a value
// cut beside it is not caught by limit 6"): words no reader knows are no value and join nothing, so a cut beside them is
// not caught here: "next week" ("Friday" out of "Friday next week"), "LA time", "UTC", "after next", "a week from
// Friday", "around 3" (the time reader reads no bare hour after "around"), "$40 off". The lead added at round 5
// (DL-209), written into CQ-121 beside those words: a sentence mark between day and time ends the phrase, so a cut beside
// it is also the residual: "at 3pm" out of "tomorrow. at 3pm" passes as today's 3pm, since ". ! ? ;" join nothing (step
// 2). Limit 3's read-back shows the person the value before any commit, and limit 5 checks the time is open, so neither
// books on one. Nothing here keeps or logs a value or the words; what it returns is a label.

import { amountsIn } from "./money";
import { numberPhrasesIn } from "./numbers";
import {
  countSpansIn,
  reparse,
  zoneWordSpansIn,
  zoneWordsOfTime,
  type FieldType,
  type FieldValue,
  type ReparseContext,
  type ReparseFault,
} from "./reparse";
import { timeReadingOf } from "./times";
import { BOTH_LANGUAGES, findAll, foldWords, wholeAt, type Span, type ValueLanguage } from "./words";

/** The field types written as numbers, whose values are re-read from their whole value phrase. */
export type PhraseType = "integer" | "money" | "time";

/** Whether a field's type is one written as a number (money, a count, a date or time). */
export function isPhraseType(type: FieldType): type is PhraseType {
  return type === "integer" || type === "money" || type === "time";
}

/** Why a value fails its whole value phrase: a re-parse fault, or noText for a phrase none or not all of is read. */
export type PhraseFault = ReparseFault | "noText";

const spanOf = ({ at, end }: Span): Span => ({ at, end });

/** Step 1: every value the type's reader reads in folded words, where it stands. */
function valuesIn(type: PhraseType, folded: string, languages: readonly ValueLanguage[]): Span[] {
  switch (type) {
    case "money":
      return amountsIn(folded, languages).map(spanOf);
    case "integer":
      return countSpansIn(folded, languages).map(spanOf);
    case "time":
      return [...timeReadingOf(folded, languages).spans, ...zoneWordSpansIn(folded)].map(spanOf);
  }
}

/**
 * Step 2: the cues that may stand between the values of one time ("tomorrow at 3pm", "tomorrow afternoon at 3", "3pm on
 * Friday", "at 3 in the afternoon", "mañana a las 3", "mañana al mediodía", "a eso de las 3"), with "or" and "and" (the
 * time reader reads two times so joined as several).
 */
const TIME_CUES: readonly string[] = [
  "at",
  "on",
  "by",
  "around",
  "about",
  "approximately",
  "approx",
  "roughly",
  "say",
  "like",
  "maybe",
  "from",
  "after",
  "before",
  "till",
  "til",
  "until",
  "between",
  "the",
  "this",
  "in",
  "of",
  "for",
  "or",
  "and",
  "either",
  "a",
  "al",
  "el",
  "la",
  "las",
  "los",
  "de",
  "del",
  "en",
  "por",
  "para",
  "como",
  "sobre",
  "hacia",
  "eso",
  "tipo",
  "o",
  "y",
];
const TIME_JOIN = new RegExp(String.raw`^(?:[\s,:·•|()/&-]|\b(?:${TIME_CUES.join("|")})\b)*$`, "u");
/**
 * Step 2 for money and counts: a range or choice word between two values ("$12 to $15", "4 or 5", "4, maybe 5", "35
 * dólares y 50 centavos").
 */
const NUMBER_JOIN =
  /^(?:[\s,/&-]|\b(?:to|or|and|maybe|perhaps|possibly|probably|o|y|a|quizas|quiza|tal vez)\b)*$/u;
/**
 * Step 3: a range word or a joining mark between a number and the phrase ("twenty to 3", "10 - $15", "$40_000"); Spanish
 * "y", "o", "a" too.
 */
const ENGLISH_RANGE = /^ ?(?:[-/&_]|to|or|and) ?$/u;
const SPANISH_RANGE = /^ ?(?:[-/&_]|to|or|and|o|y|a) ?$/u;
/** A whole number: digits and their marks, with no letter or digit right before or after ("30", "1,200"; not "3pm"). */
const WHOLE_NUMBER = /(?<![\p{L}\p{N}])\d+(?:[.,:]\d+)*(?![\p{L}\p{N}])/gu;

/** The whole numbers in folded words: digits, and numbers written in words. */
function wholeNumbersIn(folded: string, languages: readonly ValueLanguage[]): Span[] {
  return [...findAll(folded, WHOLE_NUMBER), ...numberPhrasesIn(folded, languages)].map(spanOf);
}

/** Spans joined into phrases: overlapping or touching ones, and ones with only what `join` allows between them. */
function joined(spans: readonly Span[], folded: string, join: RegExp): Span[] {
  const phrases: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.at - b.at || a.end - b.end)) {
    const last = phrases[phrases.length - 1];
    if (last !== undefined && (span.at <= last.end || join.test(folded.slice(last.end, span.at)))) {
      phrases[phrases.length - 1] = { at: last.at, end: Math.max(last.end, span.end) };
    } else {
      phrases.push(span);
    }
  }
  return phrases;
}

/** Step 3: a phrase with the numbers the reader did not read that belong to it. */
function grown(
  type: PhraseType,
  phrase: Span,
  numbers: readonly Span[],
  folded: string,
  range: RegExp,
): Span {
  if (type === "integer") return phrase;
  let { at, end } = phrase;
  for (const number of numbers) {
    if (number.end <= phrase.at && range.test(folded.slice(number.end, phrase.at))) {
      at = Math.min(at, number.at);
    } else if (number.at >= phrase.end && range.test(folded.slice(phrase.end, number.at))) {
      end = Math.max(end, number.end);
    } else if (number.at === phrase.end + 1 && folded.charAt(phrase.end) === " ") {
      end = Math.max(end, number.end);
    }
  }
  return { at, end };
}

/** What may stand between a phrase and a bare hour beside its day or its part-of-day word: spaces, commas, "at". */
const BESIDE = /^(?:[ ,]|\bat\b)*$/u;

/** Whether a bare hour stands inside a phrase, or beside it with only spaces, commas or "at" between. */
function besidePhrase(folded: string, phrase: Span, hour: Span): boolean {
  if (hour.end <= phrase.at) return BESIDE.test(folded.slice(hour.end, phrase.at));
  if (hour.at >= phrase.end) return BESIDE.test(folded.slice(phrase.end, hour.at));
  return true;
}

/**
 * Step 3b (DL-209): the bare hours the time reader reads beside a day or after a part-of-day word, whatever other time
 * the text holds (times.ts bareHours), that belong to a phrase beside them: those the reader takes when it reads that
 * phrase with the hour on its own ("thursday, 3", "3 tomorrow"), not one beside a phrase that already names its time of
 * day ("2 tomorrow at 3pm").
 */
function hoursBeside(folded: string, phrases: readonly Span[], languages: readonly ValueLanguage[]): Span[] {
  return timeReadingOf(folded, languages).bareHours.filter((hour) =>
    phrases.some((phrase) => {
      if (!besidePhrase(folded, phrase, hour)) return false;
      const at = Math.min(phrase.at, hour.at);
      const said = folded.slice(at, Math.max(phrase.end, hour.end));
      const read = timeReadingOf(said, languages).spans;
      return read.some((span) => span.at <= hour.at - at && hour.end - at <= span.end);
    }),
  );
}

/** Steps 1 to 3b: every value phrase of the type in folded words, in order. */
function phrasesIn(type: PhraseType, folded: string, languages: readonly ValueLanguage[]): Span[] {
  const values = valuesIn(type, folded, languages);
  const phrases = phrasesOf(type, values, folded, languages);
  if (type !== "time") return phrases;
  const hours = hoursBeside(folded, phrases, languages);
  return hours.length === 0 ? phrases : phrasesOf(type, [...values, ...hours], folded, languages);
}

/** Steps 2 and 3: the phrases `values` make in folded words, joined and grown until nothing more joins, in order. */
function phrasesOf(
  type: PhraseType,
  values: readonly Span[],
  folded: string,
  languages: readonly ValueLanguage[],
): Span[] {
  const join = type === "time" ? TIME_JOIN : NUMBER_JOIN;
  const range = languages.includes("es") ? SPANISH_RANGE : ENGLISH_RANGE;
  const numbers = wholeNumbersIn(folded, languages);
  let phrases = joined(values, folded, join);
  for (;;) {
    const next = joined(
      phrases.map((phrase) => grown(type, phrase, numbers, folded, range)),
      folded,
      join,
    );
    const before = phrases;
    const same =
      next.length === before.length && next.every((phrase, index) => sameSpan(phrase, before[index]));
    if (same) return next;
    phrases = next;
  }
}

/** Whether two spans stand at the same place. */
function sameSpan(a: Span, b: Span | undefined): boolean {
  return b?.at === a.at && b.end === a.end;
}

/** What the type's reader reads of a phrase on its own: its spans, and for a time the zone words beside it. */
function readOf(type: PhraseType, said: string, languages: readonly ValueLanguage[]): Span[] {
  switch (type) {
    case "money":
      return amountsIn(said, languages).map(spanOf);
    case "integer":
      return countSpansIn(said, languages).map(spanOf);
    case "time": {
      const spans = timeReadingOf(said, languages).spans.map(spanOf);
      return [...spans, ...zoneWordsOfTime(said, spans).map(spanOf)];
    }
  }
}

/** The pieces of a phrase that must all be read: every digit and number word, a currency sign, a zone word. */
function piecesOf(type: PhraseType, said: string, languages: readonly ValueLanguage[]): Span[] {
  const numbers = [...findAll(said, /\d+/g), ...numberPhrasesIn(said, languages)].map(spanOf);
  switch (type) {
    case "money":
      return [...numbers, ...findAll(said, /\p{Sc}/gu).map(spanOf)];
    case "integer":
      return numbers;
    case "time":
      return [...numbers, ...zoneWordSpansIn(said).map(spanOf)];
  }
}

/** Whether a piece lies inside one of the spans read. */
function within(piece: Span, read: readonly Span[]): boolean {
  return read.some((span) => span.at <= piece.at && piece.end <= span.end);
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
  if (places.length === 0) return "noText";
  const phrases = phrasesIn(type, folded, languages);
  for (const place of places) {
    const end = place + cited.length;
    const [phrase, ...more] = phrases.filter((each) => each.at < end && place < each.end);
    if (phrase === undefined) return "noText";
    if (more.length > 0) return "several";
    const said = folded.slice(phrase.at, phrase.end);
    const result = reparse(type, value, said, context);
    if (!result.ok) return result.why === "noValue" ? "noText" : result.why;
    const read = readOf(type, said, languages);
    if (piecesOf(type, said, languages).some((piece) => !within(piece, read))) return "noText";
  }
  return null;
}
