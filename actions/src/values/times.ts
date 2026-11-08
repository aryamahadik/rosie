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
// Words that name two days or two times ("3 or 4pm", "Thu 2-5") are several, never one. Nothing here keeps or logs words.

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

const lookup = (names: readonly [string, number][], name: string | undefined): number | null =>
  names.find(([each]) => each === name)?.[1] ?? null;

const RELATIVE: readonly [RegExp, number, "pm" | null][] = [
  [/\bday after tomorrow\b/g, 2, null],
  [/\bpasado manana\b/g, 2, null],
  [/\b(?:tomorrow|tomorow|tmrw|tmr)\b/g, 1, null],
  [/(?<!\bla |\bpasado )\bmanana\b/g, 1, null],
  [/\b(?:today|hoy)\b/g, 0, null],
  [/\btonight\b/g, 0, "pm"],
  [/\besta noche\b/g, 0, "pm"],
  [/\b(?:yesterday|ayer)\b/g, -1, null],
];

const WEEKDAY = new RegExp(
  String.raw`\b(?:(this|next|este|el proximo|proximo|el) )?(${WEEKDAY_NAMES})\b(?: (que viene|proximo))?`,
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
const NUMERIC_DATE = /(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const DAY_OF_MONTH = new RegExp(String.raw`(?<![\d/.])(\d{1,2})${ORDINAL}\b`, "g");

const NOON = /\b(?:noon|midday|mediodia)\b/g;
const MIDNIGHT = /\b(?:midnight|medianoche)\b/g;
const COLON_TIME = /(?<![\d:/.$])(\d{1,2}):(\d{2})(?!\d)(?: ?(am|pm)\b|([ap])\b)?/g;
const MERIDIEM_TIME = /(?<![\d:/.$])(\d{1,2})(?: ?(am|pm)\b|([ap])\b)/g;
const OCLOCK_TIME = /(?<![\d:/.$])(\d{1,2}) ?oclock\b/g;
const CUE = String.raw`(?:at|a las|a la|para las)`;
const CUED_TIME = new RegExp(String.raw`\b${CUE} (\d{1,2})(?![\d:/.%])`, "g");
const BARE_NUMBER = /(?<![\w.,:/$])(\d{1,2})(?![\w.,:/%$])/g;

/** A number joined to a time of day by "or", "to", a dash or "and" ("3 or 4pm", "2-5pm"): the words name two. */
const JOINED_BEFORE = /(?<![\w.,:/$])\d{1,2}(?::\d{2})? ?(?:or|o|to|-|and|y|a) ?$/;
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

/** Every whole number in the folded words: digits, number words, and "a", "an", "un", "una" as one. */
function countedIn(folded: string, languages: readonly ValueLanguage[]): Counted[] {
  const digits = findAll(folded, /(?<![\d.,:/])(\d+)(?![\d.,:/])/g).map((each) => ({
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

/** Whether only spaces and commas stand between two spans of the folded words, in either order. */
function besideOnly(folded: string, a: Span, b: Span): boolean {
  const between = a.end <= b.at ? folded.slice(a.end, b.at) : folded.slice(b.end, a.at);
  return /^[ ,]*$/.test(between);
}

const meridiemOf = (word: string | undefined, letter: string | undefined): "am" | "pm" | null => {
  if (word === "am" || letter === "a") return "am";
  if (word === "pm" || letter === "p") return "pm";
  return null;
};

/** Reads what the words say about one time, in the languages given. */
export function readTimeWords(words: string, languages: readonly ValueLanguage[] = BOTH_LANGUAGES): TimeRead {
  const folded = foldWords(words);
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

  const clocks: ClockWords[] = [];
  for (const found of findAll(folded, NOON)) if (takeClock(found)) clocks.push({ kind: "noon" });
  for (const found of findAll(folded, MIDNIGHT)) if (takeClock(found)) clocks.push({ kind: "midnight" });
  for (const found of findAll(folded, COLON_TIME)) {
    if (!takeClock(found)) continue;
    const meridiem = meridiemOf(found.groups[2], found.groups[3]);
    clocks.push({ kind: "clock", hour: Number(found.groups[0]), minute: Number(found.groups[1]), meridiem });
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
  const hourWords = hourWordsOf(languages);
  const hourNames = [...hourWords.keys()].sort((a, b) => b.length - a.length).join("|");
  if (hourNames !== "") {
    const worded = new RegExp(String.raw`\b(?:${CUE} (${hourNames})\b|(${hourNames}) ?(am|pm)\b)`, "g");
    for (const found of findAll(folded, worded)) {
      const hour = hourWords.get(found.groups[0] ?? found.groups[1] ?? "");
      if (hour === undefined || !takeClock(found)) continue;
      const meridiem = found.groups[2] === "am" ? "am" : found.groups[2] === "pm" ? "pm" : null;
      clocks.push({ kind: "clock", hour, minute: 0, meridiem });
    }
  }
  if (clocks.length === 0) {
    // A bare number is an hour only right beside the day it is on: "Thu 2", "tomorrow 3", "Sat Oct 24, 11".
    for (const found of findAll(folded, BARE_NUMBER)) {
      if (!daySpans.some((day) => besideOnly(folded, day, found))) continue;
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
  if (joined || either) return { kind: "several" };

  const am = AM_HINTS.test(folded);
  const pm = pmFromDay || PM_HINTS.test(folded);
  const hint = am === pm ? null : am ? "am" : "pm";
  const day = distinct(days);
  const weekday = distinct(weekdays);
  const clock = distinct(clocks);
  const [firstElapsed, ...moreElapsed] = elapsed;
  if (firstElapsed !== undefined) {
    const alone = moreElapsed.length === 0 && day.length === 0 && weekday.length === 0 && clock.length === 0;
    return alone
      ? {
          kind: "time",
          time: { elapsedMs: firstElapsed.value, day: null, weekday: null, clock: null, hint: null },
        }
      : { kind: "several" };
  }
  if (day.length > 1 || weekday.length > 1 || clock.length > 1) return { kind: "several" };
  const [oneDay = null] = day;
  const [oneWeekday = null] = weekday;
  const [oneClock = null] = clock;
  if (oneDay === null && oneWeekday === null && oneClock === null) return { kind: "none" };
  return { kind: "time", time: { elapsedMs: null, day: oneDay, weekday: oneWeekday, clock: oneClock, hint } };
}

/**
 * Where the words name a date or a time of day for sure ("Oct 24", "10/24", "the 24th", "3:30", "3pm", "3 o'clock", "at
 * 7", "a las 7"), so a reader of counts or amounts leaves those numbers alone. A bare number is never one here.
 */
export function timeSpansIn(folded: string): Span[] {
  const patterns = [
    MONTH_FIRST,
    DAY_FIRST,
    NUMERIC_DATE,
    DAY_OF_MONTH,
    COLON_TIME,
    MERIDIEM_TIME,
    OCLOCK_TIME,
    CUED_TIME,
  ];
  return patterns.flatMap((pattern) => findAll(folded, pattern).map(({ at, end }) => ({ at, end })));
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
