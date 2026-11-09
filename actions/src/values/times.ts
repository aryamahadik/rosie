// Dates and times in a person's words, resolved from the text's send time in a zone (T-304; arch 06 line 309: "Dates
// resolve from the text's send time in the visit's zone"; S13-03). English and Spanish (A3-07: "Quiero un corte el
// sábado"): "tomorrow at 3", "Sat Oct 24 at 11:00am", "Thu 2pm", "10/24 at 2:30pm", "noon", "tonight at 8", "in 2 hours",
// "mañana a las 3 de la tarde", "el sábado a las 11".
//
// What the words say is read first (readTimeWords), then turned into every instant it can mean in a zone (instantsFor):
//   - a wall time is read on the zone's own calendar, so it keeps its wall time across a daylight-saving change ("tomorrow
//     at 3pm" on Sat Oct 31 2026 is Sun Nov 1 at 3pm EST); "in 2 hours" is elapsed time, added to the send instant;
//   - an hour with no am or pm ("at 3") can mean either, unless the words say morning or afternoon ("3 de la tarde");
//   - a time with no day is the next time the clock reads it after the text was sent; a weekday is the next one on or after
//     the send date (today's both this week's and next week's); "next Friday" the coming one or the one after; a month and
//     day the next one on or after the send date; a day with no time of day is its start, 00:00;
//   - a wall time a daylight-saving change skips has no instant, and one it repeats has two.
// Words that name two days or two times ("3 or 4pm", "Thu 2-5") are several, never one. The readers' own phrase words
// are read (T-304 round 3, DL-189): "quarter past 3" is 3:15, "quarter to 3pm" 2:45pm, "half past three" 3:30, "las 3 y
// media" 3:30, "las 3 y cuarto" 3:15, "las 4 menos cuarto" 3:45. timeReadingOf also gives every span of the folded words
// a reading read (each day, time of day, elapsed time and morning or afternoon word), so a reader of the whole value
// phrase sees what was left unread; those spans, joined by spaces, commas or cues, are the time's whole phrase in a
// person's text (values/phrase.ts; T-304 round 4, DL-199): "the day after tomorrow at 3pm", "tomorrow afternoon at 3",
// "tomorrow at noon", "mañana al mediodía", "tomorrow, 3pm". A bare number is an hour right beside a day ("Thu 2",
// "Thursday, 3", "3 tomorrow") or right after a part-of-day word ("tomorrow morning, 9" is 9am, "tomorrow night, 9"
// 9pm: T-304 round 5, DL-209), and the reading takes one only when the words name no other time of day; bareHours gives
// every such number whatever else the words hold, so the whole value phrase takes the hour beside its day even when
// another time stands elsewhere in the text ("my 2pm doesn't work. can we do Thursday, 3?"). The number edge is built
// once, for every mark (T-304 round 7, DL-228 item 1; NUMBER_START and NUMBER_END below): a mark is part of a number
// only with a digit right before it and right after it, so "tomorrow at 3.", "see you tomorrow at 3:)", "Thursday, 3:)"
// and "Update:3pm tomorrow" read their hour, while "3:30", "3.5", "10/24", "1,200" and "$3.50" keep their readings.
// Round 7 also reads a weekday's short form with its period ("Thurs. 3pm", DL-228 item 2a) and an hour, a period and
// two minute digits as hours and minutes when am or pm follows or a cue comes before ("3.30pm", "at 3.30"; item 2b);
// with neither, "3.30" stays a number. T-1130 (CQ-121's default: each form found later is added to the readers; DL-236)
// reads the forms T-304's last review found: an hour, a period and one digit after a cue or before am or pm is that many
// tenths of an hour ("at 3.5" and "3.5pm" are 3:30, half past, as the count reader reads 3.5 as three and a half);
// seconds after the minutes are read with them ("3:30:15" and "3.30.15pm" are 3:30, as "3:30:00" is); three or four
// digits after a cue or before am or pm are hours and minutes ("at 1530" is 15:30, "at 930" 9:30, "330pm" 3:30pm, as "at
// 15:30", "at 9:30" and "3:30pm" are); an approximate word may stand between a cue and its hour ("at around 3", "at
// about 3.30"), and "around", "about" and the like, or a "~" with no digit before it, stand for the cue before an hour
// and two minute digits ("around 3.30", "~3.30"); "tmrw." and "tmr." take their period, as "Thurs." does; and an
// underscore is read as a space ("_tomorrow_ at 3pm"). What joins is one definition, never a list of marks (T-1130 round
// 2, DL-251: JOINING_MARK, shared with values/phrase.ts): every character but a letter or a digit of any script, a
// sentence mark (". ! ? ; ¿ ¡") or an arrow. Any number of joining marks may stand between a cue and its hour, with or
// without a space ('at "3"', "at (3)", "at ~3", "at: 3", "at:3", "at »3«", "at 「3」", "at ≈3", "at #3", "a las »3«"),
// and every cued hour, in digits or in words, is read after the same cue (CUED); and joining marks may stand between a
// day or a part-of-day word and the bare hour beside it ("Thursday: 3", "Thursday - 3", "Thursday (3)"). A letter of
// any script is a letter, never a mark, for this reader and the phrase builder alike, so "Thursday ー 3", "Thursday 下午
// 3" and "tomorrow morning ー 9" read no hour beside the day, as "Thursday x 3" does not (words no reader knows: CQ-121).
// Nothing here keeps or logs words.

import { numberPhrasesIn, numberWordsOf } from "./numbers";
import {
  BOTH_LANGUAGES,
  findAll,
  foldWords,
  overlaps,
  type Found,
  type Span,
  type ValueLanguage,
} from "./words";
import { addDays, dateBefore, instantsAt, isDate, wallOf, weekdayOf, type LocalDate } from "./zone";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A day the words name, apart from a weekday. */
export type DayWords =
  /** today 0, tomorrow 1, the day after tomorrow 2, yesterday -1, "in 3 days" 3. */
  | { readonly kind: "relative"; readonly days: number }
  /** A month and day, with its year when given. */
  | { readonly kind: "date"; readonly month: number; readonly day: number; readonly year: number | null }
  /** "the 24th": a day of the month. */
  | { readonly kind: "dayOfMonth"; readonly day: number };

/** A weekday the words name: 0 Sunday to 6 Saturday; `next` for "next Friday", "el viernes que viene". */
export interface WeekdayWords {
  readonly weekday: number;
  readonly next: boolean;
}

/** A time of day the words name. */
export type ClockWords =
  | {
      readonly kind: "clock";
      readonly hour: number;
      readonly minute: number;
      readonly meridiem: "am" | "pm" | null;
    }
  | { readonly kind: "noon" }
  | { readonly kind: "midnight" };

/** What one time in the words says. */
export interface TimeWords {
  /** "in 2 hours": elapsed time from the send, in ms; null otherwise. */
  readonly elapsedMs: number | null;
  readonly day: DayWords | null;
  readonly weekday: WeekdayWords | null;
  readonly clock: ClockWords | null;
  /** Morning or afternoon words with no am or pm on the hour ("de la tarde", "in the morning"); null for none or both. */
  readonly hint: "am" | "pm" | null;
}

/** The words read for a time: one time, none at all, or several. */
export type TimeRead =
  | { readonly kind: "time"; readonly time: TimeWords }
  | { readonly kind: "none" }
  | { readonly kind: "several" };

const WEEKDAYS: readonly [string, number][] = [
  ["sunday", 0],
  ["sun", 0],
  ["domingo", 0],
  ["monday", 1],
  ["mon", 1],
  ["lunes", 1],
  ["tuesday", 2],
  ["tues", 2],
  ["tue", 2],
  ["martes", 2],
  ["wednesday", 3],
  ["weds", 3],
  ["wed", 3],
  ["miercoles", 3],
  ["thursday", 4],
  ["thurs", 4],
  ["thur", 4],
  ["thu", 4],
  ["jueves", 4],
  ["friday", 5],
  ["fri", 5],
  ["viernes", 5],
  ["saturday", 6],
  ["sat", 6],
  ["sabado", 6],
];

const MONTHS: readonly [string, number][] = [
  ["january", 1],
  ["jan", 1],
  ["enero", 1],
  ["february", 2],
  ["feb", 2],
  ["febrero", 2],
  ["march", 3],
  ["mar", 3],
  ["marzo", 3],
  ["april", 4],
  ["apr", 4],
  ["abril", 4],
  ["may", 5],
  ["mayo", 5],
  ["june", 6],
  ["jun", 6],
  ["junio", 6],
  ["july", 7],
  ["jul", 7],
  ["julio", 7],
  ["august", 8],
  ["aug", 8],
  ["agosto", 8],
  ["september", 9],
  ["sept", 9],
  ["sep", 9],
  ["septiembre", 9],
  ["setiembre", 9],
  ["october", 10],
  ["oct", 10],
  ["octubre", 10],
  ["november", 11],
  ["nov", 11],
  ["noviembre", 11],
  ["december", 12],
  ["dec", 12],
  ["diciembre", 12],
];

const alternation = (names: readonly [string, number][]): string =>
  [...names]
    .map(([name]) => name)
    .sort((a, b) => b.length - a.length)
    .join("|");

const WEEKDAY_NAMES = alternation(WEEKDAYS);
const MONTH_NAMES = alternation(MONTHS);
const ORDINAL = "(?:st|nd|rd|th)";

/**
 * A day as the reader reads one in folded words, as a pattern's source (for the whole value phrase, values/phrase.ts):
 * a relative day ("tomorrow", "pasado mañana", "tonight"), a weekday ("Fri", "next Friday", "el viernes"), a month and
 * day ("Oct 24", "24 de octubre"), a numeric date ("10/24") or a day of the month ("the 24th").
 */
export const DAY_PATTERN = String.raw`(?:(?:the )?day after tomorrow|pasado manana|tomorrow|tomorow|tmrw|tmr|manana|today|hoy|tonight|esta noche|yesterday|ayer|(?:(?:this|next|este|el proximo|proximo|el) )?(?:${WEEKDAY_NAMES})|(?:${MONTH_NAMES})\.? \d{1,2}${ORDINAL}?|\d{1,2}${ORDINAL}? (?:of |de )?(?:${MONTH_NAMES})|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:the )?\d{1,2}${ORDINAL})`;

const lookup = (names: readonly [string, number][], name: string | undefined): number | null =>
  names.find(([each]) => each === name)?.[1] ?? null;

const RELATIVE: readonly [RegExp, number, "pm" | null][] = [
  [/\bday after tomorrow\b/g, 2, null],
  [/\bpasado manana\b/g, 2, null],
  // A short form takes its period, as a weekday's does ("tmrw. 3pm" is one phrase: T-1130, the round 7 review's N3).
  [/\b(?:tomorrow|tomorow)\b|\b(?:tmrw|tmr)\b\.?/g, 1, null],
  [/(?<!\bla |\bpasado )\bmanana\b/g, 1, null],
  [/\b(?:today|hoy)\b/g, 0, null],
  [/\btonight\b/g, 0, "pm"],
  [/\besta noche\b/g, 0, "pm"],
  [/\b(?:yesterday|ayer)\b/g, -1, null],
];

/**
 * A weekday's short forms, which take their period as MONTH_FIRST takes "Oct.": "Mon.", "Tue.", "Tues.", "Wed.", "Thu.",
 * "Thur.", "Thurs.", "Fri.", "Sat.", "Sun." (T-304 round 7, DL-228 item 2a), so "Thurs. 3pm" is one phrase.
 */
const WEEKDAY_SHORT_FORMS = [
  "sun",
  "mon",
  "tues",
  "tue",
  "weds",
  "wed",
  "thurs",
  "thur",
  "thu",
  "fri",
  "sat",
];
/** The period right after a weekday's short form, read with it (DL-228 item 2a); none after a full name ("Thursday."). */
const WEEKDAY_PERIOD = String.raw`(?:(?<=(?<![a-z])(?:${WEEKDAY_SHORT_FORMS.join("|")}))\.)?`;

const WEEKDAY = new RegExp(
  String.raw`\b(?:(this|next|este|el proximo|proximo|el) )?(${WEEKDAY_NAMES})\b${WEEKDAY_PERIOD}(?: (que viene|proximo))?`,
  "g",
);

const MONTH_FIRST = new RegExp(
  String.raw`\b(${MONTH_NAMES})\.? (\d{1,2})${ORDINAL}?(?!\d)(?:,? (\d{4})(?!\d))?`,
  "g",
);
const DAY_FIRST = new RegExp(
  String.raw`\b(\d{1,2})${ORDINAL}? (?:of |de )?(${MONTH_NAMES})\b(?:,? (?:de )?(\d{4})(?!\d))?`,
  "g",
);
// The number edge, by construction (T-304 round 7, DL-228 item 1): a mark (any character that is neither a digit nor a
// letter) is part of a number only when a digit stands right before it and right after it; anywhere else it ends the
// number, before it and after it. Rounds 5 and 6 (DL-209, DL-217) let the comma and then the period end an hour one mark
// at a time, which left the colon hiding one ("see you tomorrow at 3:)"); here no mark is listed as an end. Between two
// digits the readers read the period, the colon and the slash as part of the number ("3.30", "3.5", "3:30", "10/24"),
// and the comma as part of it where it marks thousands, three digits after it ("1,200"); any other mark between two
// digits joins two numbers, as before ("2-5pm" is a range, so several; "3:30,4:30" two times). So every pattern below
// starts a number only where neither a digit nor a digit and such a mark stands right before it (NUMBER_START), and ends
// one only where neither a digit nor such a mark and a digit stands right after it (NUMBER_END): "see you tomorrow at
// 3:)", "tomorrow at 3:", "tomorrow at 3.", "Thursday, 3:)", "tomorrow morning, 9:)", "Update:3pm tomorrow" and
// "hmm...3pm tomorrow" read their hour, while "3:30", "3.5", "10/24", "1,200" and "$3.50" keep their readings (no hour 3,
// 10, 1 or 50 in them). A unit glued to a number is no edge but what the number is, as before: a "%" right after it (a
// share) or a "$" beside it (money) makes it no hour, and a letter glued to a bare number makes it no bare number ("3rd").
// An underscore is a mark, never a letter. The count reader starts and ends its counts at the same edges (T-1130:
// values/reparse.ts NUMERAL), so a count glued to a mark ("table for 4 or 5:)", "re:4 or 5") is read as one.
export const NUMBER_START = String.raw`(?<!\d|\d[.:/]|\d,(?=\d{3}(?!\d)))`;
export const NUMBER_END = String.raw`(?!\d|[.:/]\d|,\d{3}(?!\d))`;
/** A letter or digit of the folded words: \w without the underscore, which is a mark. */
export const LETTER_OR_DIGIT = String.raw`[^\W_]`;
// What joins by construction (T-1130), as the number edge is built (DL-228 item 1), rather than mark by mark: between a
// day and its bare hour, between a cue and its hour, and between a time's values (values/phrase.ts), every mark joins but
// a sentence mark, which ends the phrase (CQ-121's residual: "tomorrow. at 3pm"), and an arrow, which reads as "to" and
// so joins no time ("move my 3pm to 4pm" passes "4pm", T-304 round 3's default; "3pm -> 4pm" alike). Every quote,
// bracket, asterisk, underscore, dash, colon or emoji joins ("Thursday: 3", "*3pm* tomorrow", "tomorrow [3pm]", 'tomorrow
// at "3pm"', "tomorrow 👍 3pm"). A mark is what is neither a letter nor a digit of any script (\p{L}\p{N}), in one
// definition for every one of those places and for the phrase builder (round 2, DL-251: JOINING_MARK below).
/** The sentence marks, as characters of a pattern's character class: ". ! ? ;" and Spanish "¿ ¡" ("…" folds to "..."). */
export const SENTENCE_MARKS = ".!?;¿¡";
/** Unicode's arrows, as characters of a pattern's character class: "→", "⇒", "⟶", "⤏", "➡", "⬅" and the rest. */
export const ARROWS = String.raw`←-⇿➡⟵-⟿⤀-⥿⬅-⬇`;
/** An arrow typed with dashes or equals signs ("->", "-->", "=>", "<-"); "<" or ">" alone is a bracket ("<3pm>"). */
export const ASCII_ARROW = String.raw`[-=]+>|<[-=]+`;
/**
 * One mark that joins amounts or counts (values/phrase.ts): any character but a letter or a digit of any script
 * (\p{L}\p{N}) or a sentence mark. A pattern using it takes the "u" flag.
 */
export const NUMBER_JOINING_MARK = String.raw`[^\p{L}\p{N}${SENTENCE_MARKS}]`;
/**
 * One joining mark of a time, the one definition the time reader and the phrase builder share (T-1130 round 2, DL-251):
 * a mark that joins numbers and is no arrow. It is what may stand between a day or a part-of-day word and the bare hour
 * beside it (besideOnly, AFTER_PART_OF_DAY), between a cue and its hour (CUED), and between a time's values (phrase.ts
 * TIME_JOIN and BESIDE). A letter of any script is a letter, never a mark: "Thursday ー 3" and "Thursday 下午 3" stand no
 * hour beside the day, as "Thursday x 3" does not. A pattern using it takes the "u" flag.
 */
export const JOINING_MARK = String.raw`(?!${ASCII_ARROW}|[${ARROWS}])${NUMBER_JOINING_MARK}`;
/** One or more joining marks: what follows a cue before its hour ("at 3", "at: 3", "at »3«", "at ≈3", "a las «3»"). */
const JOINING_MARKS = String.raw`(?:${JOINING_MARK})+`;
/** Whether only spaces and joining marks stand between a day or a part-of-day word and the bare hour beside it. */
const BESIDE_ONLY = new RegExp(String.raw`^(?:${JOINING_MARK})*$`, "u");

const NUMERIC_DATE = new RegExp(
  String.raw`${NUMBER_START}(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?${NUMBER_END}`,
  "g",
);
const DAY_OF_MONTH = new RegExp(String.raw`${NUMBER_START}(\d{1,2})${ORDINAL}\b`, "g");

const NOON = /\b(?:noon|midday|mediodia)\b/g;
const MIDNIGHT = /\b(?:midnight|medianoche)\b/g;
// An am or pm right after an hour, with a space or a period between, is that hour's ("3pm", "3 pm", "3.pm", "3:30.pm"),
// so a period read as a sentence mark never drops the am or pm a person put after it (a default, for ops/QUESTIONS.md).
const MERIDIEM = String.raw`(?:(?: ?|\.)(am|pm)\b|([ap])\b)`;
/**
 * An hour and minutes with a colon ("3:30", "10:30am"); seconds after them are read with them, the time being its hour
 * and minute ("3:30:00"; "3:30:15" is 3:30: T-1130, the round 7 review's N1).
 */
const COLON_TIME = new RegExp(
  String.raw`${NUMBER_START}(?<!\$)(\d{1,2}):(\d{2})(?::[0-5]\d)?${NUMBER_END}${MERIDIEM}?`,
  "g",
);
/**
 * An hour, a period and two minute digits, read as hours and minutes when am or pm follows ("3.30pm", "3.30 pm") or a
 * time cue comes before ("at 3.30", "a las 3.30"); with neither, "3.30" stays a number (DL-228 item 2b; CQ-121). Seconds
 * after them are read with them, as with a colon ("3.30.15pm" is 3:30pm: T-1130).
 */
const DOT_MERIDIEM_TIME = new RegExp(
  String.raw`${NUMBER_START}(?<!\$)(\d{1,2})\.([0-5]\d)(?:\.[0-5]\d)?${NUMBER_END}${MERIDIEM}`,
  "g",
);
/**
 * Three or four digits with am or pm after them, an hour and two minute digits: "330pm" is 3:30pm, "1030am" 10:30am
 * (T-1130), as an hour and minutes are with am or pm after them (DOT_MERIDIEM_TIME).
 */
const DIGITS_MERIDIEM_TIME = new RegExp(
  String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)([01]?\d|2[0-3])([0-5]\d)${NUMBER_END}${MERIDIEM}`,
  "g",
);
/**
 * An hour, a period and one digit with am or pm after it: that many tenths of an hour after the hour ("3.5pm" is 3:30pm;
 * T-1130), as an hour and two minute digits are hours and minutes there (DOT_MERIDIEM_TIME).
 */
const DECIMAL_MERIDIEM_TIME = new RegExp(
  String.raw`${NUMBER_START}(?<!\$)(\d{1,2})\.(\d)${NUMBER_END}${MERIDIEM}`,
  "g",
);
const MERIDIEM_TIME = new RegExp(String.raw`${NUMBER_START}(?<!\$)(\d{1,2})${MERIDIEM}`, "g");
const OCLOCK_TIME = new RegExp(String.raw`${NUMBER_START}(?<!\$)(\d{1,2}) ?oclock\b`, "g");
const CUE = String.raw`(?:at|a las|a la|para las)`;
/** Words that make an hour approximate (T-1130): after a cue ("at around 3"), or for one before "3.30" ("around 3.30"). */
const APPROX = String.raw`(?:around|about|approximately|approx\.?|roughly)`;
/**
 * What stands between a cue and its hour, built from the one definition of a joining mark (JOINING_MARK; T-1130 round 2,
 * DL-251), never a list of marks: one or more joining marks, with or without a space ("at 3", "at: 3", "at:3", 'at "3"',
 * "at (3)", "at »3«", "at 「3」", "at ≈3", "at #3", "at ⏰3", "at _3_", "at ~3", "a las »3«"), and an approximate word
 * with the joining marks after it ("at around 3", "at approx. 3"). A "$" right before the hour makes it money, never an
 * hour ("at $3.50"), as everywhere in this reader. A letter of any script ends the cue ("at ー3" is no cued hour).
 */
const CUED = String.raw`\b${CUE}${JOINING_MARKS}(?:${APPROX}${JOINING_MARKS})?(?<!\$)`;
/**
 * A cued hour, a period and two minute digits (DL-228 item 2b): "at 3.30", "a las 3.30", "at 3.30pm"; an approximate
 * word with the joining marks after it, or a "~" (a hyphen once folded) with no digit before it, stands for the cue
 * there ("around 3.30", "about 3.30", "~3.30": T-1130); seconds after them are read with them ("at 3.30.15").
 */
const CUED_DOT_TIME = new RegExp(
  String.raw`(?:${CUED}|\b${APPROX}${JOINING_MARKS}(?<!\$)|(?<!\d ?)- ?)(\d{1,2})\.([0-5]\d)(?:\.[0-5]\d)?${NUMBER_END}${MERIDIEM}?`,
  "gu",
);
/** A cued hour, a period and one digit: that many tenths of an hour after the hour ("at 3.5" is 3:30; T-1130). */
const CUED_DECIMAL_TIME = new RegExp(String.raw`${CUED}(\d{1,2})\.(\d)${NUMBER_END}(?!%)${MERIDIEM}?`, "gu");
/**
 * Three or four digits after a cue, an hour of the day and two minute digits: "at 1530" is 15:30, "at 930" 9:30, as "at
 * 15:30" and "at 9:30" are (T-1130, the round 7 review's N1).
 */
const CUED_DIGITS_TIME = new RegExp(
  String.raw`${CUED}([01]?\d|2[0-3])([0-5]\d)${NUMBER_END}(?!%)${MERIDIEM}?`,
  "gu",
);
/** A cued hour ("at 3", "a las 3"), ended by any mark with no digit after it ("at 3.", "at 3:)"; never "at 3.30"). */
const CUED_TIME = new RegExp(String.raw`${CUED}(\d{1,2})${NUMBER_END}(?!%)`, "gu");
/**
 * A bare number of one or two digits, ended by any mark with no digit after it and started after any mark with no digit
 * before it ("3, tomorrow", "Thursday, 3.", "Thursday, 3:)", "2pm,3 tomorrow"; never "1,200", "3.30" or "3:30").
 */
const BARE_NUMBER = new RegExp(
  String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)(\d{1,2})${NUMBER_END}(?!${LETTER_OR_DIGIT}|[%$])`,
  "g",
);

/** A number joined to a time of day by "or", "to", a dash or "and" ("3 or 4pm", "2-5pm"): the words name two. */
const JOINED_BEFORE = new RegExp(
  String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)\d{1,2}(?::\d{2})? ?(?:or|o|to|-|and|y|a) ?$`,
);
const JOINED_AFTER = /^ ?(?:or|o|to|-|and|y|a) ?\d{1,2}(?!\d)/;
/** What stands between two times the words name when they offer either: "tomorrow or Friday". */
const EITHER = /^ ?,? ?(?:or|o) ?$/;

const AM_HINTS = /\b(?:morning|mornings|de la manana|por la manana|en la manana|la manana)\b/;
const PM_HINTS =
  /\b(?:afternoon|evening|tonight|night|de la tarde|por la tarde|en la tarde|la tarde|de la noche|por la noche|en la noche|esta noche)\b/;

const ELAPSED_UNIT: readonly [RegExp, number][] = [
  [/^ (?:hours?|hrs?|horas?)\b/, HOUR],
  [/^ (?:minutes?|mins?|minutos?)\b/, MINUTE],
];
const DAY_UNIT: readonly [RegExp, number][] = [
  [/^ (?:days?|dias?)\b/, 1],
  [/^ (?:weeks?|semanas?)\b/, 7],
];

/** A number in the words, digits or words, with where it stands. */
interface Counted extends Span {
  readonly value: number;
}

/** A whole number in digits, at the number edges (NUMBER_START, NUMBER_END). */
const DIGITS = new RegExp(String.raw`${NUMBER_START}(\d+)${NUMBER_END}`, "g");

/** Every whole number in the folded words: digits, number words, and "a", "an", "un", "una" as one. */
function countedIn(folded: string, languages: readonly ValueLanguage[]): Counted[] {
  const digits = findAll(folded, DIGITS).map((each) => ({
    value: Number(each.groups[0]),
    at: each.at,
    end: each.end,
  }));
  const ones = findAll(folded, /\b(?:an?|una?)\b/g).map((each) => ({ value: 1, at: each.at, end: each.end }));
  return [...digits, ...numberPhrasesIn(folded, languages), ...ones];
}

/** "in 2 hours", "in 3 days", "en una semana": a number after "in" or "en" and before a unit. */
function inUnits(
  folded: string,
  counted: readonly Counted[],
  units: readonly [RegExp, number][],
): { value: number; span: Span }[] {
  const found: { value: number; span: Span }[] = [];
  for (const each of counted) {
    if (!/\b(?:in|en) $/.test(folded.slice(0, each.at))) continue;
    const after = folded.slice(each.end);
    for (const [unit, size] of units) {
      const match = unit.exec(after);
      if (match !== null) {
        found.push({ value: each.value * size, span: { at: each.at - 3, end: each.end + match[0].length } });
      }
    }
  }
  return found;
}

/** The hour words that may name an hour after "at" or before "pm": one to twelve. */
function hourWordsOf(languages: readonly ValueLanguage[]): Map<string, number> {
  const hours = new Map<string, number>();
  for (const [name, entry] of numberWordsOf(languages)) {
    if (entry.value >= 1 && entry.value <= 12 && name !== "un") hours.set(name, entry.value);
  }
  return hours;
}

/** Distinct entries by their JSON form, first seen first. */
function distinct<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * Whether only spaces and joining marks stand between two spans of the folded words, in either order: commas ("Thursday,
 * 3"), and since T-1130 every mark but a sentence mark or an arrow ("Thursday: 3", "Thursday - 3", "Thursday (3)"), by
 * the one definition the phrase builder shares (JOINING_MARK): a letter of any script stands between ("Thursday ー 3").
 */
function besideOnly(folded: string, a: Span, b: Span): boolean {
  const between = a.end <= b.at ? folded.slice(a.end, b.at) : folded.slice(b.end, a.at);
  return BESIDE_ONLY.test(between);
}

/**
 * What may stand between a part-of-day word and the bare hour after it (DL-209): spaces, "at" and the marks that join
 * (T-1130: "tomorrow morning: 9"), by the one definition the phrase builder shares (JOINING_MARK; "tomorrow morning ー 9"
 * stands a letter between).
 */
const AFTER_PART_OF_DAY = new RegExp(
  String.raw`^(?:${JOINING_MARK}|(?<![\p{L}\p{N}])at(?![\p{L}\p{N}]))*$`,
  "u",
);

/** Whether `found` stands right after a part-of-day word of `hints`, with only spaces, joining marks or "at" between. */
function afterPartOfDay(folded: string, hints: readonly Span[], found: Span): boolean {
  return hints.some(
    (hint) => hint.end <= found.at && AFTER_PART_OF_DAY.test(folded.slice(hint.end, found.at)),
  );
}

/**
 * Every bare number the reader reads as an hour where it stands, whatever other time the words name (T-304 round 5,
 * DL-209): right beside a day, only spaces or joining marks between, on either side ("Thu 2", "Thursday, 3", "Thursday:
 * 3", "3 tomorrow", "3, tomorrow", "Sat Oct 24, 11"), or right after a part-of-day word, only spaces, joining marks or
 * "at" between ("tomorrow morning, 9", "tomorrow night 9"), whose morning or afternoon it takes.
 */
function bareHoursIn(folded: string, days: readonly Span[], hints: readonly Span[]): Found[] {
  return findAll(folded, BARE_NUMBER).filter(
    (found) => days.some((day) => besideOnly(folded, day, found)) || afterPartOfDay(folded, hints, found),
  );
}

const meridiemOf = (word: string | undefined, letter: string | undefined): "am" | "pm" | null => {
  if (word === "am" || letter === "a") return "am";
  if (word === "pm" || letter === "p") return "pm";
  return null;
};

/** An hour phrase read: where it stands and the time of day it names. */
interface HourPhrase extends Span {
  readonly clock: ClockWords;
}

/**
 * The hour phrases in folded words (T-304 round 3, DL-189 item 2: the readers' own phrase words): "quarter past 3", "a
 * quarter to 4pm", "half past three", "las 3 y media", "las tres y cuarto", "las 4 menos cuarto". A "to" phrase is that many
 * minutes before the hour: "quarter to 3pm" is 2:45pm; with no am or pm, "quarter to 3" is 2:45, morning or afternoon.
 */
function hourPhrasesIn(
  folded: string,
  hourWords: ReadonlyMap<string, number>,
  hourNames: string,
): HourPhrase[] {
  const hour = hourNames === "" ? String.raw`(\d{1,2})` : String.raw`(\d{1,2}|${hourNames})`;
  const meridiem = String.raw`(?:(?: ?|\.)(am|pm)\b)?`;
  // The hour ends there (DL-228 item 1): am or pm may follow it, never a letter, a digit, or a mark with a digit right
  // after it ("quarter to 3:)" and "quarter to 3:" read 3; "quarter to 3:30" does not).
  const after = String.raw`(?= ?(?:am|pm)\b|(?!${LETTER_OR_DIGIT})${NUMBER_END})`;
  // The hour starts there: no letter, digit or "$", nor a mark with a digit right before it, right before it.
  const before = String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)`;
  const patterns: readonly [RegExp, number, boolean][] = [
    [new RegExp(String.raw`\b(?:a )?quarter (?:past|after) ${hour}${after}${meridiem}`, "g"), 15, false],
    [
      new RegExp(String.raw`\b(?:a )?quarter (?:to|till|til|of|before) ${hour}${after}${meridiem}`, "g"),
      45,
      true,
    ],
    [new RegExp(String.raw`\bhalf past ${hour}${after}${meridiem}`, "g"), 30, false],
    [new RegExp(String.raw`${before}${hour}${after}${meridiem} y media\b`, "g"), 30, false],
    [new RegExp(String.raw`${before}${hour}${after}${meridiem} y cuarto\b`, "g"), 15, false],
    [new RegExp(String.raw`${before}${hour}${after}${meridiem} menos cuarto\b`, "g"), 45, true],
  ];
  const phrases: HourPhrase[] = [];
  for (const [pattern, minute, before] of patterns) {
    for (const found of findAll(folded, pattern)) {
      const said = found.groups[0] ?? "";
      const named = /^\d+$/.test(said) ? Number(said) : hourWords.get(said);
      if (named === undefined || named < 1 || named > 12) continue;
      const meridiemSaid = found.groups[1] === "am" || found.groups[1] === "pm" ? found.groups[1] : null;
      phrases.push({
        at: found.at,
        end: found.end,
        clock: hourPhraseClock(named, minute, before, meridiemSaid),
      });
    }
  }
  return phrases;
}

/** The time of day an hour phrase names: `minute` past `hour`, or for a "to" phrase that many minutes before it. */
function hourPhraseClock(
  hour: number,
  minute: number,
  before: boolean,
  meridiem: "am" | "pm" | null,
): ClockWords {
  if (meridiem === null) {
    const shown = before ? (hour === 1 ? 12 : hour - 1) : hour;
    return { kind: "clock", hour: shown, minute, meridiem: null };
  }
  const day = 24 * 60;
  const hour24 = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  const at = (hour24 * 60 + (before ? minute - 60 : minute) + day) % day;
  const atHour = Math.floor(at / 60);
  return {
    kind: "clock",
    hour: atHour % 12 === 0 ? 12 : atHour % 12,
    minute: at % 60,
    meridiem: atHour < 12 ? "am" : "pm",
  };
}

/** What the words say about one time, and every span of the folded words the reading read. */
export interface TimeReading {
  readonly read: TimeRead;
  /** Each run of the folded words read: a day, a time of day, an elapsed time, a morning or afternoon word. */
  readonly spans: readonly Span[];
  /**
   * Each bare number the reader reads as an hour where it stands, beside a day or after a part-of-day word, whatever
   * other time the words name (DL-209). The reading takes one only when the words name no other time of day.
   */
  readonly bareHours: readonly Span[];
}

/** Reads what the words say about one time, in the languages given. */
export function readTimeWords(words: string, languages: readonly ValueLanguage[] = BOTH_LANGUAGES): TimeRead {
  return timeReadingOf(words, languages).read;
}

/**
 * Folded words as the time reader reads them: an underscore is a mark, never a letter (T-304 round 7's default), so it is
 * read as a space, one character for one, and spans still stand where they do in the folded words ("_3pm_ tomorrow" and
 * "_tomorrow_ at 3pm" read their time, as "*3pm* tomorrow" does: T-1130).
 */
const readable = (folded: string): string => folded.replaceAll("_", " ");

/** Reads what the words say about one time, with the spans of their folded form it read. */
export function timeReadingOf(
  words: string,
  languages: readonly ValueLanguage[] = BOTH_LANGUAGES,
): TimeReading {
  const folded = readable(foldWords(words));
  const hints: Span[] = [
    ...findAll(folded, AM_HINTS).map(({ at, end }) => ({ at, end })),
    ...findAll(folded, PM_HINTS).map(({ at, end }) => ({ at, end })),
  ];
  const read = readFolded(folded, languages, hints);
  return { read: read.read, spans: [...read.spans, ...hints], bareHours: read.bareHours };
}

/** Reads one time from folded words, with their morning and afternoon words: the reading and the spans it took. */
function readFolded(
  folded: string,
  languages: readonly ValueLanguage[],
  hints: readonly Span[],
): TimeReading {
  const counted = countedIn(folded, languages);
  const taken: Span[] = [];
  const daySpans: Span[] = [];
  const clockSpans: Span[] = [];
  const take = (span: Span, into: Span[] | null): boolean => {
    if (overlaps(span, taken)) return false;
    taken.push(span);
    into?.push(span);
    return true;
  };
  const takeDay = (span: Span): boolean => take(span, daySpans);
  const takeClock = (span: Span): boolean => take(span, clockSpans);

  const elapsed = inUnits(folded, counted, ELAPSED_UNIT).filter((each) => take(each.span, null));
  const days: DayWords[] = [];
  let pmFromDay = false;
  for (const each of inUnits(folded, counted, DAY_UNIT)) {
    if (takeDay(each.span)) days.push({ kind: "relative", days: each.value });
  }
  for (const [pattern, offset, hint] of RELATIVE) {
    for (const found of findAll(folded, pattern)) {
      if (!takeDay(found)) continue;
      days.push({ kind: "relative", days: offset });
      if (hint === "pm") pmFromDay = true;
    }
  }
  const dated = (found: Found, month: number | null, day: number, year: string | undefined): void => {
    if (month === null || !takeDay(found)) return;
    const full = year === undefined ? null : Number(year) < 100 ? 2000 + Number(year) : Number(year);
    days.push({ kind: "date", month, day, year: full });
  };
  for (const found of findAll(folded, MONTH_FIRST)) {
    dated(found, lookup(MONTHS, found.groups[0]), Number(found.groups[1]), found.groups[2]);
  }
  for (const found of findAll(folded, DAY_FIRST)) {
    dated(found, lookup(MONTHS, found.groups[1]), Number(found.groups[0]), found.groups[2]);
  }
  for (const found of findAll(folded, NUMERIC_DATE)) {
    dated(found, Number(found.groups[0]), Number(found.groups[1]), found.groups[2]);
  }
  for (const found of findAll(folded, DAY_OF_MONTH)) {
    if (takeDay(found)) days.push({ kind: "dayOfMonth", day: Number(found.groups[0]) });
  }
  const weekdays: WeekdayWords[] = [];
  for (const found of findAll(folded, WEEKDAY)) {
    const weekday = lookup(WEEKDAYS, found.groups[1]);
    if (weekday === null || !takeDay(found)) continue;
    const before = found.groups[0];
    const next =
      before === "next" || before === "proximo" || before === "el proximo" || found.groups[2] !== undefined;
    weekdays.push({ weekday, next });
  }

  const hourWords = hourWordsOf(languages);
  const hourNames = [...hourWords.keys()].sort((a, b) => b.length - a.length).join("|");
  const clocks: ClockWords[] = [];
  for (const phrase of hourPhrasesIn(folded, hourWords, hourNames)) {
    if (takeClock(phrase)) clocks.push(phrase.clock);
  }
  for (const found of findAll(folded, NOON)) if (takeClock(found)) clocks.push({ kind: "noon" });
  for (const found of findAll(folded, MIDNIGHT)) if (takeClock(found)) clocks.push({ kind: "midnight" });
  for (const pattern of [
    COLON_TIME,
    DOT_MERIDIEM_TIME,
    CUED_DOT_TIME,
    CUED_DIGITS_TIME,
    DIGITS_MERIDIEM_TIME,
  ]) {
    for (const found of findAll(folded, pattern)) {
      if (!takeClock(found)) continue;
      const meridiem = meridiemOf(found.groups[2], found.groups[3]);
      clocks.push({
        kind: "clock",
        hour: Number(found.groups[0]),
        minute: Number(found.groups[1]),
        meridiem,
      });
    }
  }
  // An hour and tenths of an hour (T-1130): "at 3.5" and "3.5pm" are half past 3, six minutes to each tenth.
  for (const pattern of [CUED_DECIMAL_TIME, DECIMAL_MERIDIEM_TIME]) {
    for (const found of findAll(folded, pattern)) {
      if (!takeClock(found)) continue;
      const meridiem = meridiemOf(found.groups[2], found.groups[3]);
      clocks.push({
        kind: "clock",
        hour: Number(found.groups[0]),
        minute: Number(found.groups[1]) * 6,
        meridiem,
      });
    }
  }
  for (const found of findAll(folded, MERIDIEM_TIME)) {
    if (!takeClock(found)) continue;
    const meridiem = meridiemOf(found.groups[1], found.groups[2]);
    clocks.push({ kind: "clock", hour: Number(found.groups[0]), minute: 0, meridiem });
  }
  for (const found of findAll(folded, OCLOCK_TIME)) {
    if (takeClock(found))
      clocks.push({ kind: "clock", hour: Number(found.groups[0]), minute: 0, meridiem: null });
  }
  for (const found of findAll(folded, CUED_TIME)) {
    if (takeClock(found))
      clocks.push({ kind: "clock", hour: Number(found.groups[0]), minute: 0, meridiem: null });
  }
  if (hourNames !== "") {
    // An hour in words after a cue, with its am or pm when one follows ("at three pm" is 3pm, never either), or before
    // its am or pm ("three pm"); the cue is every cued hour's (CUED: "at: three", 'at "three"').
    const worded = new RegExp(
      String.raw`(?:${CUED}(${hourNames})(?:(?: ?|\.)(am|pm))?\b|\b(${hourNames})(?: ?|\.)(am|pm)\b)`,
      "gu",
    );
    for (const found of findAll(folded, worded)) {
      const hour = hourWords.get(found.groups[0] ?? found.groups[2] ?? "");
      if (hour === undefined || !takeClock(found)) continue;
      const said = found.groups[1] ?? found.groups[3];
      const meridiem = said === "am" ? "am" : said === "pm" ? "pm" : null;
      clocks.push({ kind: "clock", hour, minute: 0, meridiem });
    }
  }
  const bareHours = bareHoursIn(folded, daySpans, hints);
  if (clocks.length === 0) {
    // A bare number is an hour only right beside the day it is on ("Thu 2", "tomorrow 3", "Sat Oct 24, 11") or right
    // after a part-of-day word ("tomorrow morning, 9": DL-209), and only when the words name no other time of day.
    for (const found of bareHours) {
      if (takeClock(found))
        clocks.push({ kind: "clock", hour: Number(found.groups[0]), minute: 0, meridiem: null });
    }
  }
  const joined = clockSpans.some(
    (span) => JOINED_BEFORE.test(folded.slice(0, span.at)) || JOINED_AFTER.test(folded.slice(span.end)),
  );
  const ordered = [...taken].sort((a, b) => a.at - b.at);
  const either = ordered.some((span, index) => {
    const next = ordered[index + 1];
    return next !== undefined && EITHER.test(folded.slice(span.end, next.at));
  });
  const spans: readonly Span[] = taken;
  const reading = (read: TimeRead): TimeReading => ({
    read,
    spans,
    bareHours: bareHours.map(({ at, end }) => ({ at, end })),
  });
  if (joined || either) return reading({ kind: "several" });

  const am = AM_HINTS.test(folded);
  const pm = pmFromDay || PM_HINTS.test(folded);
  const hint = am === pm ? null : am ? "am" : "pm";
  const day = distinct(days);
  const weekday = distinct(weekdays);
  const clock = distinct(clocks);
  const [firstElapsed, ...moreElapsed] = elapsed;
  if (firstElapsed !== undefined) {
    const alone = moreElapsed.length === 0 && day.length === 0 && weekday.length === 0 && clock.length === 0;
    const time: TimeWords = {
      elapsedMs: firstElapsed.value,
      day: null,
      weekday: null,
      clock: null,
      hint: null,
    };
    return reading(alone ? { kind: "time", time } : { kind: "several" });
  }
  if (day.length > 1 || weekday.length > 1 || clock.length > 1) return reading({ kind: "several" });
  const [oneDay = null] = day;
  const [oneWeekday = null] = weekday;
  const [oneClock = null] = clock;
  if (oneDay === null && oneWeekday === null && oneClock === null) return reading({ kind: "none" });
  const time: TimeWords = { elapsedMs: null, day: oneDay, weekday: oneWeekday, clock: oneClock, hint };
  return reading({ kind: "time", time });
}

/**
 * Where the words name a date or a time of day for sure ("Oct 24", "10/24", "the 24th", "3:30", "3pm", "3 o'clock", "at
 * 7", "a las 7", "at 3.5", "at 1530"), so a reader of counts or amounts leaves those numbers alone. A bare number is
 * never one here.
 */
export function timeSpansIn(folded: string): Span[] {
  const patterns = [
    MONTH_FIRST,
    DAY_FIRST,
    NUMERIC_DATE,
    DAY_OF_MONTH,
    COLON_TIME,
    DOT_MERIDIEM_TIME,
    CUED_DOT_TIME,
    CUED_DIGITS_TIME,
    DIGITS_MERIDIEM_TIME,
    CUED_DECIMAL_TIME,
    DECIMAL_MERIDIEM_TIME,
    MERIDIEM_TIME,
    OCLOCK_TIME,
    CUED_TIME,
  ];
  const text = readable(folded);
  return patterns.flatMap((pattern) => findAll(text, pattern).map(({ at, end }) => ({ at, end })));
}

/** One way to read the time of day: the hour and minute, and a day later for a midnight read as the day's end. */
interface ClockReading {
  readonly hour: number;
  readonly minute: number;
  readonly dayAfter: number;
}

/** Every hour and minute the words' time of day can mean; a day with no time of day is its start, 00:00. */
function clockReadings(clock: ClockWords | null, hint: "am" | "pm" | null): ClockReading[] {
  if (clock === null) return [{ hour: 0, minute: 0, dayAfter: 0 }];
  if (clock.kind === "noon") return [{ hour: 12, minute: 0, dayAfter: 0 }];
  if (clock.kind === "midnight") {
    return [
      { hour: 0, minute: 0, dayAfter: 0 },
      { hour: 0, minute: 0, dayAfter: 1 },
    ];
  }
  const { hour, minute } = clock;
  if (minute > 59 || hour > 23) return [];
  const meridiem = clock.meridiem ?? (hour >= 1 && hour <= 12 ? hint : null);
  if (meridiem !== null) {
    if (hour < 1 || hour > 12) return clock.meridiem === null ? [{ hour, minute, dayAfter: 0 }] : [];
    return [{ hour: meridiem === "am" ? hour % 12 : (hour % 12) + 12, minute, dayAfter: 0 }];
  }
  if (hour === 0 || hour > 12) return [{ hour, minute, dayAfter: 0 }];
  return [
    { hour: hour % 12, minute, dayAfter: 0 },
    { hour: (hour % 12) + 12, minute, dayAfter: 0 },
  ];
}

/** The next date on or after `today` that is `month`/`day` (this year's, else next year's), or the given year's. */
function dateOf(words: Extract<DayWords, { kind: "date" }>, today: LocalDate): LocalDate[] {
  if (words.year !== null) {
    const date = { year: words.year, month: words.month, day: words.day };
    return isDate(date) ? [date] : [];
  }
  const thisYear = { year: today.year, month: words.month, day: words.day };
  const date = dateBefore(thisYear, today) ? { ...thisYear, year: today.year + 1 } : thisYear;
  return isDate(date) ? [date] : [];
}

/** "the 24th": this month's, if it has not passed, else the next month that has it. */
function dayOfMonth(day: number, today: LocalDate): LocalDate[] {
  for (let ahead = 0; ahead < 3; ahead += 1) {
    const index = today.month - 1 + ahead;
    const date = { year: today.year + Math.floor(index / 12), month: (index % 12) + 1, day };
    if (isDate(date) && !dateBefore(date, today)) return [date];
  }
  return [];
}

/** The dates a weekday can mean from `today`: the next one on or after today (today's: this week's and next week's). */
function weekdayDates(weekday: WeekdayWords, today: LocalDate): LocalDate[] {
  const ahead = (weekday.weekday - weekdayOf(today) + 7) % 7;
  if (weekday.next) {
    const first = ahead === 0 ? 7 : ahead;
    return [addDays(today, first), addDays(today, first + 7)];
  }
  return ahead === 0 ? [today, addDays(today, 7)] : [addDays(today, ahead)];
}

/** The dates the words' day can mean, before its time of day; null when the words name no day. */
function datesOf(time: TimeWords, today: LocalDate): LocalDate[] | null {
  const { day, weekday } = time;
  if (day === null) return weekday === null ? null : weekdayDates(weekday, today);
  let dates: LocalDate[];
  switch (day.kind) {
    case "relative":
      dates = [addDays(today, day.days)];
      break;
    case "date":
      dates = dateOf(day, today);
      break;
    case "dayOfMonth":
      dates = dayOfMonth(day.day, today);
      break;
  }
  return weekday === null ? dates : dates.filter((date) => weekdayOf(date) === weekday.weekday);
}

/**
 * Every instant the time the words name can mean, sent at `sentMs`, read in `zone`, earliest first. Empty when nothing
 * can: a date that does not exist, a weekday that does not fall on the date named, a wall time the zone skips.
 */
export function instantsFor(time: TimeWords, sentMs: number, zone: string): number[] {
  if (time.elapsedMs !== null) {
    const at = sentMs + time.elapsedMs;
    return [...new Set([at, Math.floor(at / MINUTE) * MINUTE])].sort((a, b) => a - b);
  }
  const today = wallOf(sentMs, zone);
  const readings = clockReadings(time.clock, time.hint);
  const dates = datesOf(time, today);
  const found = new Set<number>();
  if (dates === null) {
    // A time of day with no day: the next time the clock reads it after the send.
    for (const reading of readings) {
      for (let ahead = 0; ahead <= 2; ahead += 1) {
        const date = addDays(today, ahead + reading.dayAfter);
        const after = instantsAt(zone, { ...date, hour: reading.hour, minute: reading.minute }).filter(
          (instant) => instant > sentMs,
        );
        if (after.length > 0) {
          for (const instant of after) found.add(instant);
          break;
        }
      }
    }
  } else {
    for (const date of dates) {
      for (const reading of readings) {
        const day = addDays(date, reading.dayAfter);
        for (const instant of instantsAt(zone, { ...day, hour: reading.hour, minute: reading.minute })) {
          found.add(instant);
        }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}
