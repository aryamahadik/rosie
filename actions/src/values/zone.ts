// Wall-clock time in an IANA zone, both ways (T-304; S13-03: "Every time is saved with its time zone. A booked window
// stays right when the clocks change, like on Sun Nov 1"; CQ-09: every time in UTC with its IANA zone). Pure arithmetic
// on the platform's Intl, the same in the Worker and under Node: no clock of its own and no package.
//
// A wall time is found from the zone's own calendar and its offset on that date, so "tomorrow at 3pm" keeps its 3pm across
// a daylight-saving change. A wall time the zone skips (the hour clocks jump over) has no instant; one the zone shows twice
// (the hour clocks fall back over) has two.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A calendar date in a zone: year, month 1 to 12, day 1 to 31. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A date and a time of day on a zone's wall clock, to the minute. */
export interface WallTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's formatter, made once; throws RangeError for a name the platform does not know. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** True when the platform knows the name as an IANA zone (America/New_York, UTC); false for anything else. */
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

interface Parts extends WallTime {
  readonly second: number;
}

function partsOf(instantMs: number, zone: string): Parts {
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** What a zone's wall clock reads at an instant, to the minute. */
export function wallOf(instantMs: number, zone: string): WallTime {
  const { year, month, day, hour, minute } = partsOf(instantMs, zone);
  return { year, month, day, hour, minute };
}

/** The zone's offset from UTC at an instant, in ms (its wall clock minus UTC). */
function offsetAt(instantMs: number, zone: string): number {
  const local = partsOf(instantMs, zone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/** The number of days in a month of the Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True when the date exists: month 1 to 12, day within its month. */
export function isDate(date: LocalDate): boolean {
  return (
    Number.isInteger(date.year) &&
    Number.isInteger(date.month) &&
    Number.isInteger(date.day) &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= daysInMonth(date.year, date.month)
  );
}

/** The date `days` calendar days after `date` (before it when negative), across months and years. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The day of the week a date falls on: 0 Sunday to 6 Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Whether two dates are the same calendar day. */
export function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Whether a date comes before another. */
export function dateBefore(a: LocalDate, b: LocalDate): boolean {
  return Date.UTC(a.year, a.month - 1, a.day) < Date.UTC(b.year, b.month - 1, b.day);
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return sameDate(a, b) && a.hour === b.hour && a.minute === b.minute;
}

/**
 * Every instant at which the zone's wall clock reads `wall`, earliest first: one on most days, none in the hour a
 * daylight-saving change skips, two in the hour it repeats. The offsets a day either side cover any one change. A date
 * that does not exist, or a time outside 00:00 to 23:59, has none.
 */
export function instantsAt(zone: string, wall: WallTime): number[] {
  const validTime =
    Number.isInteger(wall.hour) &&
    Number.isInteger(wall.minute) &&
    wall.hour >= 0 &&
    wall.hour <= 23 &&
    wall.minute >= 0 &&
    wall.minute <= 59;
  if (!isDate(wall) || !validTime) return [];
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const offsets = new Set([offsetAt(naive - DAY, zone), offsetAt(naive, zone), offsetAt(naive + DAY, zone)]);
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (sameWall(wallOf(candidate, zone), wall)) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}
