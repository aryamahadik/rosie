// A deadline shown in another zone too (T-591; C-055; S13-35: "A deadline sent to someone in another time zone shows
// their time too (S13-03)"; S13-03: "A deadline in a text to someone in another time zone shows their time too, like
// 'Fri 11am ET (8am your time)'"; RULES 5.2: "a deadline sent across zones shows both").
//
// The home gives the readings, the deadline's own zone first and the person's after it when their clock reads otherwise;
// the words are the composer's and the slot filler's (rule 3: no message is written in code). The person's zone is where
// they said they are (S13-02), when known. Pure: Intl only, no clock, no I/O.

import { DueError } from "../due";
import { isZone } from "../zone";
import { instantOf } from "./instants";
import { checkZone } from "./text-hours";

/** What a zone's clock reads at an instant. */
export interface WallTime {
  zone: string;
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 31. */
  day: number;
  /** 0 Sunday to 6 Saturday. */
  weekday: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
}

export interface ShownInput {
  /** The deadline, UTC. */
  at: string;
  /** The zone the deadline is set in (K-05 armClock `dueZone`). */
  dueZone: string;
  /** Where the person said they are; null when not known. */
  personZone: string | null;
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

/** What the zone's clock reads at the instant. */
export function wallTimeOf(atMs: number, zone: string): WallTime {
  if (!Number.isFinite(atMs)) throw new DueError("the instant is not an instant");
  const parts = formatterFor(checkZone(zone)).formatToParts(new Date(atMs));
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  return {
    zone,
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

const sameReading = (a: WallTime, b: WallTime): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/**
 * The readings a deadline is shown with: its own zone's, then the person's when their zone is known and its clock reads
 * otherwise at that moment. One reading when they agree (the same zone, or another name for the same clock).
 */
export function shownTimes(input: ShownInput): WallTime[] {
  const at = instantOf(input.at, "at");
  const own = wallTimeOf(at, input.dueZone);
  if (input.personZone === null || !isZone(input.personZone)) return [own];
  const theirs = wallTimeOf(at, input.personZone);
  return sameReading(own, theirs) ? [own] : [own, theirs];
}
