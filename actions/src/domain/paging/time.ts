// Times the paging service computes (T-319), all UTC ending in Z (CQ-09), read in an IANA zone where a day counts
// (CQ-05): a page's next page 5 minutes on (arch 06 line 329), a hand-off's escalation (5 minutes; 2 days: S11-19), and a
// review item's deadline (K-37 v1 review_items.due_at: within 1 business day, or the same day).
//
// Defaults used (for ops/QUESTIONS.md; K-37 v1 open gap "The business-day calendar"; K-36 v1 open gap "The text-hours
// start of the 2 days"):
//   4. "Within 1 business day" is the same local time on the next weekday, Monday to Friday, in the business's zone: an
//      item opened on a Friday, a Saturday or a Sunday is due on Monday. No holiday is counted: no source names any.
//   5. "The same day" (a harm report, a missed deadline: A3-49, S11-70) is the end of the local day it was opened on, the
//      next local midnight in the business's zone, as K-37's seed-review-item.json shows it (13:00Z on Oct 22 due 04:00Z
//      on Oct 23, New York).
//   6. A hand-off of kind other escalates 2 days after it is handed, the earliest K-36 v1 allows
//      (hand_offs_other_two_days); counting from the owner's next text hours instead is K-36's open gap.

/** A time as UTC ending in Z, to the whole second (K-04 timestamptz as the fixtures write it). */
export function utcOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** `at` plus some minutes. */
export function plusMinutes(at: string, minutes: number): string {
  return utcOf(Date.parse(at) + minutes * 60_000);
}

/** The later of two times. */
export function laterOf(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 Sunday to 6 Saturday. */
  readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock time at `ms` in `zone`. */
function localOf(ms: number, zone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((each) => each.type === type);
    if (found === undefined) throw new TypeError(`no ${type} in the zone's time`);
    return found.value;
  };
  const weekday = WEEKDAYS[part("weekday")];
  if (weekday === undefined) throw new TypeError("no weekday in the zone's time");
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    weekday,
  };
}

/** The zone's offset from UTC at `ms`, in milliseconds (local minus UTC). */
function offsetAt(ms: number, zone: string): number {
  const local = localOf(ms, zone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `zone` (the earlier one when a clock change repeats it). */
function instantOf(local: Omit<LocalTime, "weekday">, zone: string): number {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  let guess = wall - offsetAt(wall, zone);
  guess = wall - offsetAt(guess, zone);
  return guess;
}

/** Whether `zone` is an IANA zone this runtime knows. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The same local time on the next weekday after `at`'s local day, in `zone` (default 4). */
export function nextBusinessDay(at: string, zone: string): string {
  const ms = Date.parse(at);
  const local = localOf(ms, zone);
  // Days to add: Friday to Monday is 3, Saturday 2, any other day 1.
  const add = local.weekday === 5 ? 3 : local.weekday === 6 ? 2 : 1;
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + add));
  return utcOf(
    instantOf(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: local.hour,
        minute: local.minute,
        second: local.second,
      },
      zone,
    ),
  );
}

/** The end of `at`'s local day in `zone`: the next local midnight (default 5). */
export function endOfDay(at: string, zone: string): string {
  const local = localOf(Date.parse(at), zone);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return utcOf(
    instantOf(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      zone,
    ),
  );
}
