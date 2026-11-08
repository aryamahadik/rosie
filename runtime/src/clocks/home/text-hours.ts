// Text hours, as the clock home keeps them (T-591; C-055; S13-35, S13-02; RULES 4.3, 5.1). Texts that can wait go 9am
// to 8pm in the person's zone; the owner and the team get them from 8am (RULES 4.3: "Texts that can wait go 9am to 8pm
// in the person's own zone; the owner and team from 8am"). They end before 8pm, as limit 8 reads them at send
// (../../dispatch/limit8/text-hours.ts: inside while the local minute is before the end, H04's "20:00"; DL-180): 8:00pm
// itself is outside, so 7:59pm is the last minute, and a time moved back to the close goes to 7:59pm. Step 9's own 8pm
// (arch 02 line 127) is outside them, and the home moves it to 7:59pm (./deadline.ts). The zone is the one every due
// time is set in: the visit's, else the business's (CQ-05; ../due.ts `zoneFor`).
//
// Wall-clock hours are read on the zone's own calendar (../zone.ts), so they stay right across a daylight-saving change
// (S13-03, Sun Nov 1); a span is elapsed time inside the hours. Instants in and out are epoch milliseconds. Pure: no clock
// of its own (the caller gives each instant), no I/O.

import { DueError } from "../due";
import { instantAtLocal, isZone, localDateOf, type LocalDate } from "../zone";
import { MINUTE } from "./instants";

/** Whose text hours: a customer's open at 9am, the owner's and the team's at 8am (RULES 4.3; S13-02). */
export type Audience = "customer" | "owner" | "team";

/** 9am: a customer's text hours open (RULES 4.3). */
export const CUSTOMER_OPENS_HOUR = 9;
/** 8am: the owner's and the team's text hours open (RULES 4.3). */
export const TEAM_OPENS_HOUR = 8;
/** 8pm: everyone's text hours close; 8:00pm itself is outside, as limit 8 reads them: 7:59pm is the last minute. */
export const CLOSES_HOUR = 20;

/** Most days of text hours a span may cross: a guard far above any clock the sources name (2 text hours, 4 hours). */
const SPAN_DAYS = 366;

/** The hour the audience's text hours open; anything but the owner or the team is held to the customer's 9am, the stricter. */
export function opensHourOf(audience: Audience): number {
  return audience === "owner" || audience === "team" ? TEAM_OPENS_HOUR : CUSTOMER_OPENS_HOUR;
}

/** A zone the platform knows, or DueError: every exported call here checks it before any arithmetic. */
export function checkZone(zone: string): string {
  if (!isZone(zone)) throw new DueError("the zone is not an IANA zone the platform knows");
  return zone;
}

/** An instant in epoch milliseconds, or DueError. */
function checkInstant(atMs: number, what: string): number {
  if (!Number.isFinite(atMs)) throw new DueError(`${what} is not an instant`);
  return atMs;
}

interface Window {
  /** The opening hour itself, the first moment inside. */
  opens: number;
  /** 8:00pm itself, the first moment outside again. */
  closes: number;
}

/** The text hours of the local date `date` moved by `addDays`, as instants. */
function windowOf(zone: string, date: LocalDate, addDays: number, audience: Audience): Window {
  return {
    opens: instantAtLocal(zone, date, addDays, opensHourOf(audience)),
    closes: instantAtLocal(zone, date, addDays, CLOSES_HOUR),
  };
}

/** 7:59pm, the last minute inside a day's text hours: where a time moved back to the close goes (DL-180). */
const lastMinuteOf = (window: Window): number => window.closes - MINUTE;

/** The checked zone and the local date of the instant in it. */
function dateIn(atMs: number, zone: string): LocalDate {
  return localDateOf(checkInstant(atMs, "the instant"), checkZone(zone));
}

/**
 * True when the instant is inside the audience's text hours in the zone: from the opening hour, included, to 8:00pm,
 * which is outside (limit 8's reading: the local minute before 20:00; DL-180).
 */
export function inTextHours(atMs: number, zone: string, audience: Audience): boolean {
  const day = windowOf(zone, dateIn(atMs, zone), 0, audience);
  return atMs >= day.opens && atMs < day.closes;
}

/** True when the instant is 8:00pm itself in the zone: the moment text hours close, the first one outside them again. */
export function isClosingTime(atMs: number, zone: string): boolean {
  return atMs === instantAtLocal(zone, dateIn(atMs, zone), 0, CLOSES_HOUR);
}

/** The first moment at or after the instant inside text hours: the instant itself when inside, else when they next open. */
export function nextInTextHours(atMs: number, zone: string, audience: Audience): number {
  const date = dateIn(atMs, zone);
  const day = windowOf(zone, date, 0, audience);
  if (atMs < day.opens) return day.opens;
  if (atMs < day.closes) return atMs;
  return windowOf(zone, date, 1, audience).opens;
}

/**
 * The latest the home places a time at or before the instant inside text hours: the instant itself when inside, else
 * 7:59pm, the last minute before they last closed (DL-180).
 */
export function lastInTextHours(atMs: number, zone: string, audience: Audience): number {
  const date = dateIn(atMs, zone);
  const day = windowOf(zone, date, 0, audience);
  if (atMs >= day.closes) return lastMinuteOf(day);
  if (atMs >= day.opens) return atMs;
  return lastMinuteOf(windowOf(zone, date, -1, audience));
}

/**
 * The moment `spanMs` of text hours after `fromMs`: only time inside the audience's text hours counts, and from outside
 * them the count starts when they next open. This is "2 of their text hours" (A6-11, A6-17; arch 06 lines 251 and 307:
 * limit 5's pick window, T-303) and a Clock line counted in text hours, should Jay rule so (CQ-95 c; until then step 9
 * reads a Clock line as elapsed time). A zero span gives the first moment inside text hours. A count that runs out at
 * 8:00pm itself gives 7:59pm, as a due time landing there moves (DL-180), unless the count began inside that last minute:
 * then it gives when they next open, never a moment before the count began. Throws DueError for a span that is not a
 * length of time, or one that would run past a year of text hours.
 */
export function textHoursAfter(fromMs: number, spanMs: number, zone: string, audience: Audience): number {
  checkInstant(fromMs, "from");
  if (!Number.isFinite(spanMs) || spanMs < 0) throw new DueError("the span is not a length of time");
  let at = nextInTextHours(fromMs, zone, audience);
  let left = spanMs;
  for (let day = 0; day < SPAN_DAYS; day += 1) {
    const date = localDateOf(at, zone);
    const today = windowOf(zone, date, 0, audience);
    const room = today.closes - at;
    if (left < room) return at + left;
    if (left === room && lastMinuteOf(today) >= at) return lastMinuteOf(today);
    left -= room;
    at = windowOf(zone, date, 1, audience).opens;
  }
  throw new DueError("the span runs past a year of text hours");
}
