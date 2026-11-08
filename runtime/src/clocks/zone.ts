// Wall-clock time in an IANA zone (T-255; S13-03: "Every time is saved with its time zone. A booked window stays right when
// the clocks change, like on Sun Nov 1"; CQ-09: a zone is an IANA name). Pure arithmetic on the platform's Intl, the same
// in the Worker and under Node: no clock of its own (the caller gives each instant) and no package (none in the lockfile).
//
// A deadline named in wall time ("7pm the day before", "8pm the day after") is found from the zone's own calendar date and
// its offset on that date, so it stays right across a daylight-saving change; "2 hours before" and "1 hour after" are
// elapsed time, added to the instant.

/** A calendar date in a zone: year, month 1 to 12, day 1 to 31. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
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

function partsOf(instantMs: number, zone: string): LocalParts {
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

/** The calendar date an instant falls on in a zone. */
export function localDateOf(instantMs: number, zone: string): LocalDate {
  const { year, month, day } = partsOf(instantMs, zone);
  return { year, month, day };
}

/** True when two instants fall on the same calendar date in a zone. */
export function sameLocalDate(aMs: number, bMs: number, zone: string): boolean {
  const a = localDateOf(aMs, zone);
  const b = localDateOf(bMs, zone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** The zone's offset from UTC at an instant, in ms (the zone's wall clock minus UTC). */
function offsetMs(instantMs: number, zone: string): number {
  const local = partsOf(instantMs, zone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the zone's clock reads `hour`:00 on a date moved by `addDays` (the day may run past a month's end:
 * Date.UTC carries it). Two passes: the first guesses with the offset at the naive instant, the second takes the offset at
 * that guess, which settles a date on the other side of a daylight-saving change.
 */
export function instantAtLocal(zone: string, date: LocalDate, addDays: number, hour: number): number {
  const naive = Date.UTC(date.year, date.month - 1, date.day + addDays, hour, 0, 0);
  const first = naive - offsetMs(naive, zone);
  return naive - offsetMs(first, zone);
}
