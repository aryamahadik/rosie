// Text hours in a zone (RULES 4.3; arch 06 line 313; CQ-05). Pure time arithmetic on IANA zone names, with no clock
// of its own: the caller gives the instant.

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

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
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The local calendar date and time of an instant in a zone. Throws RangeError for a zone name that does not exist. */
export function partsInZone(instantMs: number, zone: string): ZonedParts {
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    minutes: pick("hour") * 60 + pick("minute"),
  };
}

/** The zone's offset from UTC at an instant, in ms (local minus UTC). */
function offsetMs(instantMs: number, zone: string): number {
  const local = partsInZone(instantMs, zone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, 0, local.minutes);
  return asUtc - Math.floor(instantMs / 60_000) * 60_000;
}

/** The instant at which a zone's clock reads `minutes` on a calendar day (the day may overflow: day 32 is next month). */
export function instantOfLocal(
  zone: string,
  year: number,
  month: number,
  day: number,
  minutes: number,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const first = naive - offsetMs(naive, zone);
  // One more pass settles a guess that landed across a daylight-saving change.
  return naive - offsetMs(first, zone);
}

/** "HH:MM" as minutes since midnight; null when it is not a time. */
export function minutesOf(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export interface TextWindow {
  /** Minutes since local midnight the window opens (inclusive). */
  startMinutes: number;
  /** Minutes since local midnight the window closes (exclusive). */
  endMinutes: number;
}

export type TextHoursVerdict = { inside: true } | { inside: false; notBefore: string };

/**
 * Whether an instant falls inside a window in a zone, and if not, when the window next opens: today's opening when it
 * is early, tomorrow's when it is late.
 */
export function checkTextHours(instantMs: number, zone: string, window: TextWindow): TextHoursVerdict {
  const local = partsInZone(instantMs, zone);
  if (local.minutes >= window.startMinutes && local.minutes < window.endMinutes) return { inside: true };
  const day = local.minutes < window.startMinutes ? local.day : local.day + 1;
  const opens = instantOfLocal(zone, local.year, local.month, day, window.startMinutes);
  return { inside: false, notBefore: new Date(opens).toISOString() };
}
