// Days and clock times as a person reads them, each in the zone its time carries (CQ-09: "every time in UTC with its
// IANA zone"; S13-03: a visit's time is read in the visit's zone). The words follow K-03's slots.json examples, from the
// master's sample cast (SPEC-master 5h, 6): "Sat Oct 24", "11:00am", "Fri 11am", "9:00am Sat", "8–10am",
// "Thu Oct 29, 2–5pm".

import type { Time } from "./types";

/** A time that cannot be shown: the slot that reads it stays unfilled. */
export class TimeFormatError extends Error {
  override name = "TimeFormatError";
}

/** formats.v1 `utc`: an RFC 3339 instant ending in Z. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;

/** The instant of a UTC time, in epoch milliseconds. */
export function instantOf(utc: string): number {
  const at = UTC.test(utc) ? Date.parse(utc) : Number.NaN;
  if (Number.isNaN(at)) throw new TimeFormatError("a time must be an instant in UTC ending in Z (CQ-09)");
  return at;
}

const labelFormats = new Map<string, Intl.DateTimeFormat>();
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function formatIn(
  cache: Map<string, Intl.DateTimeFormat>,
  zone: string,
  options: Intl.DateTimeFormatOptions,
) {
  let format = cache.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone });
    } catch {
      throw new TimeFormatError("a time must carry an IANA time zone (CQ-09)");
    }
    cache.set(zone, format);
  }
  return format;
}

function partsOf(format: Intl.DateTimeFormat, at: number): Map<string, string> {
  return new Map(format.formatToParts(at).map((part) => [part.type, part.value]));
}

/** Checks that a zone is an IANA time zone the runtime knows; throws TimeFormatError if not. */
export function checkZone(zone: string): void {
  formatIn(dayFormats, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. */
export function isoDayIn(utc: string, zone: string): string {
  const parts = partsOf(
    formatIn(dayFormats, zone, { year: "numeric", month: "2-digit", day: "2-digit" }),
    instantOf(utc),
  );
  const year = parts.get("year") ?? "";
  const month = parts.get("month") ?? "";
  const day = parts.get("day") ?? "";
  return `${year}-${month}-${day}`;
}

const ISO_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** The calendar day after a YYYY-MM-DD day (counted on the calendar, so a 23- or 25-hour day changes nothing). */
export function nextIsoDay(day: string): string {
  const match = ISO_DAY.exec(day);
  if (match === null) throw new TimeFormatError(`not a calendar day: ${day}`);
  const [, year = "", month = "", date = ""] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(date) + 1)).toISOString().slice(0, 10);
}

interface Zoned {
  readonly weekday: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly period: string;
  readonly isoDay: string;
}

function zoned(time: Time): Zoned {
  const at = instantOf(time.utc);
  const parts = partsOf(
    formatIn(labelFormats, time.zone, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }),
    at,
  );
  const part = (type: string): string => parts.get(type) ?? "";
  return {
    weekday: part("weekday"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    period: part("dayPeriod").toLowerCase(),
    isoDay: isoDayIn(time.utc, time.zone),
  };
}

/** The day: "Sat Oct 24". */
export function dayLabel(time: Time): string {
  const t = zoned(time);
  return `${t.weekday} ${t.month} ${t.day}`;
}

/** The weekday alone: "Sat". */
export function weekdayLabel(time: Time): string {
  return zoned(time).weekday;
}

/** The clock time with its minutes: "11:00am", "3:30pm". */
export function clockLabel(time: Time): string {
  const t = zoned(time);
  return `${t.hour}:${t.minute}${t.period}`;
}

/** The clock time without ":00": "11am", "11:30am". */
export function shortClock(time: Time): string {
  const t = zoned(time);
  return `${t.hour}${t.minute === "00" ? "" : `:${t.minute}`}${t.period}`;
}

/**
 * A range shown in the start's zone (overlay-core.js windowText line 1352): "8–10am" when both ends share am or pm,
 * "11am–1pm" when not, and each end with its day when they fall on different days.
 */
export function rangeLabel(start: Time, end: Time): string {
  if (instantOf(end.utc) < instantOf(start.utc))
    throw new TimeFormatError("a range must not end before it starts");
  const endHere: Time = { utc: end.utc, zone: start.zone };
  const a = zoned(start);
  const b = zoned(endHere);
  const clock = (t: Zoned): string => `${t.hour}${t.minute === "00" ? "" : `:${t.minute}`}`;
  if (a.isoDay !== b.isoDay)
    return `${dayLabel(start)} ${shortClock(start)} – ${dayLabel(endHere)} ${shortClock(endHere)}`;
  return a.period === b.period
    ? `${clock(a)}–${clock(b)}${b.period}`
    : `${clock(a)}${a.period}–${clock(b)}${b.period}`;
}

/** A day with a range on it: "Thu Oct 29, 2–5pm"; with no end, "Thu Oct 29, 2:00pm". */
export function dayAndRangeLabel(start: Time, end: Time | null): string {
  if (end === null) return `${dayLabel(start)}, ${clockLabel(start)}`;
  const range = rangeLabel(start, end);
  return range.includes(" – ") ? range : `${dayLabel(start)}, ${range}`;
}
