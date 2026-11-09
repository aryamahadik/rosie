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
//   2. values side by side are one phrase when only spaces, joining marks or joining words stand between them. The marks
//      are built, not listed (T-1130, as round 7 built the number edge): every mark but a sentence mark (". ! ? ; ¿ ¡"),
//      which ends a phrase (CQ-121), joins, so a comma, a colon, a bracket, an asterisk, an underscore, a quote mark or an
//      emoji does ("*3pm* tomorrow", "_3pm_ tomorrow", "tomorrow [3pm]", 'tomorrow at "3pm"', "tomorrow 👍 3pm"); for a
//      time an arrow does not either ("->", "=>", "→"), since it reads as "to", which joins no time ("move my 3pm -> 4pm"
//      passes "4pm", as round 3's default holds for "to"). A mark is the time reader's own definition (times.ts
//      JOINING_MARK; T-1130 round 2, DL-251): neither a letter nor a digit of any script, so the reader and this builder
//      never disagree on what is a mark ("Thursday ー 3" stands a letter between, as "Thursday x 3" does). The words are
//      for a time the cues ("at", "on", "in the", "a las", "al", "de", "around" and the like, TIME_CUES) and "or" or
//      "and"; for money and counts a range or choice word ("to", "or", "and", "maybe", "y", "o", "a"), so "$40 (or $50)"
//      and "4 (maybe 5)" are several (DL-238);
//   2b. every count the count reader reads between two of a time's values ends no phrase, whatever its digits (T-1130
//      round 2, DL-251: "table tomorrow for 2 at 7pm", "tomorrow for 120 at 7pm", "tomorrow for 1,200 at noon"): the day
//      and the time around it are one. Only a count written as a party, with its unit ("100 people"), with "for", "para"
//      or the words that name what it counts before it ("for 2", "party of 4", "mesa para 4"), or in words ("for
//      twelve"), is the count reader's and counts as read; any other ("tomorrow 120 at 7pm", "Friday the 13 at 7pm",
//      "tomorrow 3.30 at 7pm") stays a piece of the time that must be read, so its whole is refused. A bare hour beside a
//      day stays an hour ("tomorrow 3 at 7pm", step 3b). Each count is taken whole as the count join builds its phrase,
//      its range, choice and adding words with it (T-1133's GAP 1: "for 4 to 6 people", "for 4 perhaps 5", "para 4 tal
//      vez 5"), and a counted party is never a bare hour (GAP 2: "tomorrow 4 people at 7pm" holds one count);
//   3. a number the reader did not read belongs to the phrase when a range word joins it to the phrase ("twenty to 3",
//      "10 - $15", "3 or 4pm"), or when it stands right after a time or an amount with one space between ("at 3 30", "at
//      three thirty", "$1 200"); a count takes one a range or choice word ("or", "to", "-", "/") joins to it, since the
//      count reader, at the number edge, leaves a number glued by a mark between two digits alone ("4 or 5/6": T-1130),
//      but never one "and" or one space joins ("table for 4 and 7:30", "table for 4 7:30" keep their time apart);
//   3b. a bare hour the time reader reads beside a day or after a part-of-day word (times.ts bareHours: "Thursday, 3", "3
//      tomorrow", "tomorrow morning, 9") belongs to the phrase beside it whatever other time the text holds (T-304 round
//      5, DL-209), so "Thursday" out of "my 2pm doesn't work. can we do Thursday, 3?" differs: the hour joins when the
//      reader takes it reading that phrase with the hour on its own, as it does unless the phrase already names its time
//      of day ("2" of "table for 2 tomorrow at 3pm" stays a count, as round 4 holds); the phrases are then joined again
//      (steps 2 and 3), so a time a comma joins comes in too ("2pm, 3 tomorrow"). A counted party where main read an hour
//      (times.ts declined, T-1133: "tomorrow, 4 people", "tomorrow at 4 people") joins the same way, as a piece left
//      unread, so the day alone is refused there as main refused it;
//   4. the phrase that holds the cited words (where they stand whole: words.ts wholeAt) is re-read on its own with the same
//      re-parse, and the value holds only if it gives the field's value and every number, currency sign and zone word in
//      it was read. None, or a piece left unread, is noText; another value differs; two are several; a zone word that is
//      not the value's zone is wrongZone; cited words that touch two phrases are several. For a time, the cited words and
//      the phrase, each read on its own, take no hour the whole text does not (T-1133's agreement, hoursAgree): "tomorrow
//      - 4" alone reads 4 for an hour, "tomorrow - 4 people" holds a party, so the cut is noText.
// The residual (DL-199 item 4; CQ-121: "a word no reader knows ("next week", "LA time", "UTC") is not read, and a value
// cut beside it is not caught by limit 6"): words no reader knows are no value and join nothing, so a cut beside them is
// not caught here: "next week" ("Friday" out of "Friday next week"), "LA time", "UTC", "after next", "a week from
// Friday", "around 3" (the time reader reads no bare hour after "around" with no cue before it, so "around 4 people"
// stays a count; it reads "at around 3" and "around 3.30": T-1130), "$40 off". The lead added at round 5
// (DL-209), written into CQ-121 beside those words: a sentence mark between day and time ends the phrase, so a cut beside
// it is also the residual: "at 3pm" out of "tomorrow. at 3pm" passes as today's 3pm, since ". ! ? ;" join nothing (step
// 2). The lead added at round 6 (DL-217 item 3), beside CQ-121's words, the round 5 review's N-b: an hour written in
// words beside a day ("Thursday, three") and an hour before "on" and its day ("3 on Thursday") are not read, so
// "Thursday" out of either is the residual too. A sentence mark right after an hour is not between day and time: it ends
// the hour, which stays in its day's phrase (DL-217 item 1: "Thursday" out of "Thursday, 3." differs). Round 7 builds
// that edge once for every mark (DL-228 item 1: times.ts NUMBER_START and NUMBER_END), so a colon or any other mark with
// no digit after it ends an hour too ("tomorrow" out of "see you tomorrow at 3:)" differs), and step 3 takes a number
// glued to the phrase's first or last digit by one mark ("30" of "at 3;30", "4" of "Thursday, 3,4"), which must be read.
// An hour, a period and two minute digits is hours and minutes only with am or pm after it or a cue before it ("3.30pm",
// "at 3.30": DL-228 item 2b); with neither ("Thursday, 3.30") it stays a number and the time reader reads no hour in it,
// so "Thursday" out of "Thursday, 3.30" is CQ-121's residual. T-1130 (CQ-121's default: each form found later is added
// to the readers; DL-236, DL-238) adds the forms T-304's last review found, so they are no longer the residual: the count
// reader starts and ends a count at the number edge ("4" out of "table for 4 or 5:)" and "1 child" out of "Update:2
// adults + 1 child" are several); the time reader reads "at 3.5" (3:30, so "tomorrow" out of "tomorrow at 3.5"
// differs), "3:30:15", "at 1530", "around 3.30", "at ~3", 'at "3"', "at (3)", "tmrw. 3pm" and "Thursday: 3", and with
// them, as the same forms, "3.5pm", "3.30.15", "330pm", "~3.30", "at around 3", any opening mark between a cue and its
// hour, any joining mark between a day and its bare hour ("Thursday - 3", "Thursday (3)") and an underscore as a mark
// ("_tomorrow_ at 3pm"); every joining mark joins a time (step 2), a count between day and time ends no phrase (step
// 2b), and every joining mark joins money and counts ("$40" out of "$40 (or $50)" or "$40 [or $50]" is several). Round 2
// (DL-251) builds each fix from one definition, never a list of marks: a cue's opening marks are the joining marks, any
// number of them, with or without a space ("tomorrow" out of "tomorrow at »3«", "at ›3‹", "at 「3」", "at ≈3", "at #3",
// "at: 3" or "a las »3«" differs); the time reader's joining mark is this builder's, so a letter of any script is a
// letter in both; and every count between a day and a time keeps the phrase whole, only a party counting as read
// ("tomorrow" out of "tomorrow for 120 at 7pm" differs, and "Friday the 13 at 7pm" is refused, never read as Fri Nov 6).
// T-1133 (DL-259) gives the readers one precedence rule (times.ts), so none of the cuts main refused passes: "150 guests"
// out of "we're at 120, maybe 150 guests" is several, "tomorrow at 120" out of "tomorrow at 120 Oak St at 3pm" differs,
// and "tomorrow: 4" out of "tomorrow: 4 people at 7pm" differs; round 2's GAPs 1 and 2 close with them (steps 2b, 3b, 4).
// Still the residual, with words no reader knows and a sentence mark between day and time: "3.5", "3.30" and "1530"
// with no cue before them and no am or pm after them ("Thursday, 3.5"), "around 3" with no cue, "~3" with neither a cue
// nor a day beside it ("tomorrow ~3" is read: a joining mark stands between), words before a count that no reader knows
// ("tomorrow, crew of 4, at 7pm", "tomorrow with 12 at 7pm"), and, as words no reader knows, a word or letter of a script
// the readers do not read between a day and a number ("Thursday" out of "Thursday ー 3" or "Thursday 下午 3" passes as
// "Thursday x 3" does, since neither reader reads an hour there; the whole read as 3pm is refused). N2's class joins the
// residual as its own (the lead, DL-251): an arrow read as "to" ("tomorrow" out of "tomorrow → 3pm" or "tomorrow ->
// 3pm"), "5ish" ("4" out of "table for 4 or 5ish"), "tomorrow around 3.5", "tomorrow at 3.75", and a count with a unit no
// reader knows before a time ("tomorrow for 2 dogs at 3pm"). Limit 3's read-back shows the person the value before any
// commit, and limit 5 checks the time is open, so neither books on one. Nothing here keeps or logs a value or the words;
// what it returns is a label.

import { amountsIn } from "./money";
import { NUMBER_JOINING_MARK, numberPhrasesIn } from "./numbers";
import {
  ADDING_WORDS,
  COUNT_LEAD,
  ENDS_WITH_COUNT_UNIT,
  RANGE_OR_CHOICE_WORDS,
  asWords,
  partiesIn,
} from "./parties";
import {
  countSpansIn,
  reparse,
  zoneWordSpansIn,
  zoneWordsOfTime,
  type FieldType,
  type FieldValue,
  type FoundCount,
  type ReparseContext,
  type ReparseFault,
} from "./reparse";
import { JOINING_MARK, TIME_CUES, timeReadingOf } from "./times";
import {
  BOTH_LANGUAGES,
  findAll,
  foldWords,
  overlaps,
  wholeAt,
  type Span,
  type ValueLanguage,
} from "./words";

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

// Step 2's cues between the values of one time are the time reader's own (times.ts TIME_CUES: "at", "on", "in the", "a
// las", "de", "or", "and" and the rest), which it also reads between an hour and the time words that are its evidence.
/**
 * The marks that join a time's values besides the cues, by construction (T-1130, the round 7 review's N2): spaces and
 * every mark but a sentence mark, which ends the phrase (CQ-121: "tomorrow. at 3pm"), and an arrow, which reads as "to"
 * and so joins no time ("move my 3pm -> 4pm" passes "4pm", as "move my 3pm to 4pm" does). So commas, colons, brackets,
 * slashes, an asterisk, a quote mark or an emoji join ("*3pm* tomorrow", "tomorrow [3pm]", 'tomorrow at "3pm"',
 * "tomorrow 👍 3pm", "_3pm_ tomorrow"). It is the time reader's own definition (times.ts JOINING_MARK; T-1130 round 2,
 * DL-251), so the two never disagree on what is a mark: a letter of any script is a letter in both ("Thursday ー 3").
 */
const TIME_MARK = JOINING_MARK;
const TIME_JOIN = new RegExp(String.raw`^(?:${TIME_MARK}|${asWords(TIME_CUES)})*$`, "u");
/**
 * Step 2 for money and counts: a range or choice word between two values ("$12 to $15", "4 or 5", "4, maybe 5", "35
 * dólares y 50 centavos"), or any mark but a sentence mark: "+" joins them as "&" does ("2 adults + 1 child": T-304
 * round 7, DL-228 item 2c), and so does a bracket or any other mark ("$40 (or $50)", "4 (maybe 5)", "$40 [or $50]":
 * T-1130, DL-238, by construction as the time's join, from the same definition: numbers.ts NUMBER_JOINING_MARK).
 */
const NUMBER_MARK = NUMBER_JOINING_MARK;
/** The count join's words: the range or choice words ("to", "or", "maybe", "tal vez") and the adding words ("and", "y"). */
const NUMBER_WORDS: readonly string[] = [...RANGE_OR_CHOICE_WORDS, ...ADDING_WORDS];
const NUMBER_JOIN = new RegExp(String.raw`^(?:${NUMBER_MARK}|${asWords(NUMBER_WORDS)})*$`, "u");
/**
 * Step 3: a range word or a joining mark between a number and the phrase ("twenty to 3", "10 - $15", "$40_000"); Spanish
 * "y", "o", "a" too.
 */
const ENGLISH_RANGE = /^ ?(?:[-/&_]|to|or|and) ?$/u;
const SPANISH_RANGE = /^ ?(?:[-/&_]|to|or|and|o|y|a) ?$/u;
/**
 * Step 3 for a count: a range or choice word or mark between a number and the count ("4 or 5/6", "4 to 7:30"; T-1130),
 * never "and", "&" or "y", which add another value ("table for 4 and 7:30" holds a count and a time).
 */
const ENGLISH_COUNT_RANGE = /^ ?(?:[-/]|to|or) ?$/u;
const SPANISH_COUNT_RANGE = /^ ?(?:[-/]|to|or|o|a) ?$/u;
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

/** A mark: a character that is neither a letter, a digit nor a space. */
const MARK = /^[^\p{L}\p{N}\s]$/u;
const DIGIT = /^\d$/u;

/**
 * Whether the one character at `index` is a mark with a digit right before it and right after it, which joins the two
 * into one number (DL-228 item 1's number edge, as the time reader builds it).
 */
function gluedByMark(folded: string, index: number): boolean {
  return (
    MARK.test(folded.charAt(index)) &&
    DIGIT.test(folded.charAt(index - 1)) &&
    DIGIT.test(folded.charAt(index + 1))
  );
}

/**
 * Step 3: a phrase with the numbers the reader did not read that belong to it: joined to it by a range word, standing
 * right after it with one space between, partly inside it, or glued to its first or last digit by one mark (T-304 round
 * 7, DL-228 item 1: a mark between two digits is part of the number, so "at 3;30" and "Thursday, 3,4" hold "30" and "4",
 * which must be read). A count takes them too (T-1130), joined by a range or choice word only, never by one space: with
 * the number edge the count reader leaves a number glued by a mark between two digits alone ("5/6"), so "4 or 5/6" holds
 * "5/6", which must be read, while "a table for 4 7:30" keeps its time apart.
 */
function grown(
  type: PhraseType,
  phrase: Span,
  numbers: readonly Span[],
  folded: string,
  range: RegExp,
): Span {
  let { at, end } = phrase;
  for (const number of numbers) {
    if (number.at < phrase.end && phrase.at < number.end) {
      at = Math.min(at, number.at);
      end = Math.max(end, number.end);
    } else if (number.end <= phrase.at && range.test(folded.slice(number.end, phrase.at))) {
      at = Math.min(at, number.at);
    } else if (number.at >= phrase.end && range.test(folded.slice(phrase.end, number.at))) {
      end = Math.max(end, number.end);
    } else if (type !== "integer" && number.at === phrase.end + 1 && folded.charAt(phrase.end) === " ") {
      end = Math.max(end, number.end);
    } else if (number.at === phrase.end + 1 && gluedByMark(folded, phrase.end)) {
      end = Math.max(end, number.end);
    } else if (number.end === phrase.at - 1 && gluedByMark(folded, number.end)) {
      at = Math.min(at, number.at);
    }
  }
  return { at, end };
}

/**
 * What may stand between a phrase and a bare hour beside its day or its part-of-day word, as the time reader reads one
 * (times.ts besideOnly): spaces, "at" and every mark but a sentence mark or an arrow ("Thursday, 3", "Thursday: 3":
 * T-1130).
 */
const BESIDE = new RegExp(String.raw`^(?:${TIME_MARK}|${asWords(["at"])})*$`, "u");

/** Whether a bare hour stands inside a phrase, or beside it with only spaces, joining marks or "at" between. */
function besidePhrase(folded: string, phrase: Span, hour: Span): boolean {
  if (hour.end <= phrase.at) return BESIDE.test(folded.slice(hour.end, phrase.at));
  if (hour.at >= phrase.end) return BESIDE.test(folded.slice(phrase.end, hour.at));
  return true;
}

/**
 * Step 3b (DL-209): the bare hours the time reader reads beside a day or after a part-of-day word, whatever other time
 * the text holds (times.ts bareHours), that belong to a phrase beside them: those the reader takes when it reads that
 * phrase with the hour on its own ("thursday, 3", "3 tomorrow"), not one beside a phrase that already names its time of
 * day ("2 tomorrow at 3pm"). An hour main's reach reads that the reader declines for a counted party (times.ts declined,
 * T-1133: "tomorrow, 4 people", "tomorrow at 4 people") belongs to the phrase the same way, as a piece the reader leaves
 * unread, so the day alone is refused there as main refused it, and no reading takes it for an hour (step 4).
 */
function hoursBeside(folded: string, phrases: readonly Span[], languages: readonly ValueLanguage[]): Span[] {
  const reading = timeReadingOf(folded, languages);
  return [...reading.bareHours, ...reading.declined].filter((hour) =>
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

/** Step 3's range words for the type, in the languages read. */
function rangeOf(type: PhraseType, languages: readonly ValueLanguage[]): RegExp {
  const spanish = languages.includes("es");
  if (type === "integer") return spanish ? SPANISH_COUNT_RANGE : ENGLISH_COUNT_RANGE;
  return spanish ? SPANISH_RANGE : ENGLISH_RANGE;
}

/** A digit: a count written with none is written in words ("two", "twelve", "a dozen"). */
const ANY_DIGIT = /\d/u;

/**
 * Whether a count is written as a party, so it counts as read between a day and its time (step 2b; T-1130 round 2,
 * DL-251): a whole number with its unit ("2 people", "100 guests"), with the words before it that write it as a party
 * ("for 2", "for 120", "party of 4", "mesa para 4"), joined to one of those by a range or choice word ("4 or 5 people":
 * parties.ts, T-1133), or in words ("two", "twelve"). Digits alone ("tomorrow 120 at 7pm", "Friday the 13 at 7pm") or a
 * number that is no whole number ("tomorrow 3.30 at 7pm") are none, so they stay a piece of the time's phrase that must
 * be read, and the whole is refused.
 */
function isParty(count: FoundCount, folded: string, parties: readonly Span[]): boolean {
  if (!Number.isInteger(count.value)) return false;
  const said = folded.slice(count.at, count.end);
  return (
    ENDS_WITH_COUNT_UNIT.test(said) ||
    COUNT_LEAD.test(folded.slice(0, count.at)) ||
    overlaps(count, parties) ||
    !ANY_DIGIT.test(said)
  );
}

/** A count phrase between two of a time's values, from its lead words (COUNT_LEAD) to its end, and whether it is a party. */
interface CountBetween extends Span {
  readonly party: boolean;
}

/**
 * Step 2b (T-1130, the round 7 review's N3; round 2, DL-251; T-1133's GAP 1): the count phrases that stand between two
 * of a time's values, such as the party in "table tomorrow for 2 at 7pm". Every count the count reader reads, whatever
 * its digits ("tomorrow for 120 at 7pm", "tomorrow for 1,200 at noon", "Friday the 13 at 7pm"), with its unit ("for 2
 * people"), that no value of the time overlaps and that is no bare hour the time reader reads beside a day or a
 * part-of-day word ("tomorrow 3 at 7pm" keeps its hour, DL-209), is taken whole as the count join builds its phrase
 * (step 2's NUMBER_JOIN), its range, choice and adding words with it ("for 4 to 6 people", "for 4 perhaps 5", "para 4 tal
 * vez 5", "2 adults and 1 child": GAP 1), with a value of the time before it and one after it. Every such phrase ends no
 * time's phrase: the day and the time around it are one, so "tomorrow" alone differs. A count phrase whose every count
 * is written as a party (isParty) is the count reader's and counts as read; any other stays a piece of the time left
 * unread. The words before it that write it as a party go with it ("tomorrow, party of 4, at 7pm", "mañana, mesa para 4,
 * a las 7": COUNT_LEAD). A counted party is never a bare hour (times.ts, GAP 2), so "tomorrow 4 people at 7pm" holds one.
 */
function countsBetween(
  folded: string,
  times: readonly Span[],
  languages: readonly ValueLanguage[],
): CountBetween[] {
  const hours = timeReadingOf(folded, languages).bareHours;
  const parties = partiesIn(folded, languages);
  const counts = countSpansIn(folded, languages).filter(
    (count) => !overlaps(count, times) && !overlaps(count, hours),
  );
  return joined(counts, folded, NUMBER_JOIN)
    .filter(
      (phrase) => times.some((time) => time.end <= phrase.at) && times.some((time) => phrase.end <= time.at),
    )
    .map((phrase) => {
      const members = counts.filter((count) => phrase.at <= count.at && count.end <= phrase.end);
      return {
        at: phrase.at - (COUNT_LEAD.exec(folded.slice(0, phrase.at))?.[0].length ?? 0),
        end: phrase.end,
        party: members.every((count) => isParty(count, folded, parties)),
      };
    });
}

/** The folded words with each span in `spans` blanked to spaces, every other character where it stands. */
function blanked(folded: string, spans: readonly Span[]): string {
  let out = folded;
  for (const { at, end } of spans) out = `${out.slice(0, at)}${" ".repeat(end - at)}${out.slice(end)}`;
  return out;
}

/** Steps 2 and 3: the phrases `values` make in folded words, joined and grown until nothing more joins, in order. */
function phrasesOf(
  type: PhraseType,
  values: readonly Span[],
  folded: string,
  languages: readonly ValueLanguage[],
): Span[] {
  const join = type === "time" ? TIME_JOIN : NUMBER_JOIN;
  const range = rangeOf(type, languages);
  const numbers = wholeNumbersIn(folded, languages);
  // Step 2b: every count between two of a time's values is blanked where the join is judged, so it ends no phrase.
  const joinable = type === "time" ? blanked(folded, countsBetween(folded, values, languages)) : folded;
  let phrases = joined(values, joinable, join);
  for (;;) {
    const next = joined(
      phrases.map((phrase) => grown(type, phrase, numbers, folded, range)),
      joinable,
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

/**
 * What the type's reader reads of a phrase on its own: its spans, and for a time the zone words beside it and the counts
 * written as a party between its values (step 2b), which the count reader reads.
 */
function readOf(type: PhraseType, said: string, languages: readonly ValueLanguage[]): Span[] {
  switch (type) {
    case "money":
      return amountsIn(said, languages).map(spanOf);
    case "integer":
      return countSpansIn(said, languages).map(spanOf);
    case "time": {
      const spans = timeReadingOf(said, languages).spans.map(spanOf);
      const read = [...spans, ...zoneWordsOfTime(said, spans).map(spanOf)];
      const parties = countsBetween(said, read, languages).filter((count) => count.party);
      return [...read, ...parties.map(spanOf)];
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

/** A run of digits. */
const DIGITS = /\d+/g;

/**
 * Step 4's agreement (T-1133): whether every hour the time reader takes in `said`, read on its own where it stands at
 * `at` in the folded text, is an hour it takes there in the whole text (a time of day or a bare hour), digit for digit.
 * Words read on their own lose what stands after them, so "tomorrow - 4" alone takes 4 for an hour where the whole text
 * "tomorrow - 4 people" holds a counted party, and "tomorrow at 120" alone takes 1:20 where "tomorrow at 120 Oak St"
 * holds no time: such a reading is not the text's (noText).
 */
function hoursAgree(
  said: string,
  at: number,
  hours: readonly Span[],
  languages: readonly ValueLanguage[],
): boolean {
  return timeReadingOf(said, languages).clocks.every((clock) =>
    findAll(said.slice(clock.at, clock.end), DIGITS).every((digits) =>
      within({ at: at + clock.at + digits.at, end: at + clock.at + digits.end }, hours),
    ),
  );
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
  const whole = type === "time" ? timeReadingOf(folded, languages) : null;
  const hours = whole === null ? [] : [...whole.clocks, ...whole.bareHours];
  for (const place of places) {
    const end = place + cited.length;
    const [phrase, ...more] = phrases.filter((each) => each.at < end && place < each.end);
    if (phrase === undefined) return "noText";
    if (more.length > 0) return "several";
    const said = folded.slice(phrase.at, phrase.end);
    const result = reparse(type, value, said, context);
    if (!result.ok) return result.why === "noValue" ? "noText" : result.why;
    if (
      whole !== null &&
      !(hoursAgree(cited, place, hours, languages) && hoursAgree(said, phrase.at, hours, languages))
    ) {
      return "noText";
    }
    const read = readOf(type, said, languages);
    if (piecesOf(type, said, languages).some((piece) => !within(piece, read))) return "noText";
  }
  return null;
}
