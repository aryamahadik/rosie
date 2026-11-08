// The window limit 5's outcome gives to pick one of the next open times (C-085, T-303). Arch 06 line 307: "No pick in 10
// minutes on the page, or 2 of their text hours otherwise: nothing booked (A6-11)". A6-11 (MASTER-FLOW-A, "Offers the
// next times"): "Means 'A or B': one of the next times, in any words, within 10 minutes"; "After Sam's OK, they aren't on
// the page. Then it's 2 of their text hours to pick, ending before the visit"; "10 minutes only while they're on the
// page".
//
//   - On the page: 10 minutes from now.
//   - Otherwise: 2 of their text hours from now. S13-02: "A customer's reply clock for a text that can wait never runs
//     outside text hours", so only time inside their text hours counts: 9am to 8pm in their zone, the owner and team from
//     8am (RULES 4.3; arch 06 line 313; the dispatcher's own hours, runtime/src/dispatch/limit8). Wall-clock hours are read
//     on the zone's own calendar, so they stay right across a daylight-saving change (S13-03).
//   - Either way it ends before the visit (S13-35: every deadline ends before the visit): no later than the start of the
//     soonest time offered (default 4).
//
// Pure: the gate's `now` comes in, and nothing here reads a clock, does I/O or logs.

import {
  CUSTOMER_OPENS,
  STAFF_OPENS,
  instantOfLocal,
  minutesOf,
  partsInZone,
} from "../../../../runtime/src/dispatch/limit8";
import type { PickWindow } from "./types";

/** Minutes to pick on the page (A6-11: "within 10 minutes"; "10 minutes only while they're on the page"). */
export const PAGE_PICK_MINUTES = 10;
/** Text hours to pick otherwise (A6-11: "2 of their text hours to pick, ending before the visit"). */
export const TEXT_PICK_HOURS = 2;
/** Text hours end at 8pm in the person's zone, for everyone (RULES 4.3; arch 06 line 313). */
export const TEXT_HOURS_CLOSE = "20:00";
/** When text hours open: 9am for a customer, 8am for the owner and team (RULES 4.3). */
export { CUSTOMER_OPENS, STAFF_OPENS };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** More days than any span of text hours limit 5 counts: a guard, never reached with valid hours. */
const MAX_DAYS = 31;

/** A malformed input: an instant that is not one, or text hours that are not times. */
export class PickWindowError extends Error {
  override name = "PickWindowError";
}

function minutesOfTime(time: string): number {
  const minutes = minutesOf(time);
  if (minutes === null) throw new PickWindowError("text hours must be HH:MM times");
  return minutes;
}

/**
 * The instant `spanMs` of text hours after `fromMs` in `zone`, counting only time inside [opens, closes) on each local day:
 * time before the opening waits for it, and time from the close waits for the next day's opening. Throws PickWindowError
 * for hours that are not times or that open at or after they close, and RangeError for a zone the platform does not know.
 */
export function addTextHours(
  fromMs: number,
  spanMs: number,
  zone: string,
  opens: string,
  closes: string,
): number {
  const open = minutesOfTime(opens);
  const close = minutesOfTime(closes);
  if (open >= close) throw new PickWindowError("text hours must open before they close");
  if (!Number.isFinite(fromMs)) throw new PickWindowError("the start is not an instant");
  let at = fromMs;
  let left = spanMs;
  for (let day = 0; day <= MAX_DAYS; day += 1) {
    const local = partsInZone(at, zone);
    const opensAt = instantOfLocal(zone, local.year, local.month, local.day, open);
    const closesAt = instantOfLocal(zone, local.year, local.month, local.day, close);
    const nextOpens = instantOfLocal(zone, local.year, local.month, local.day + 1, open);
    if (at < opensAt) at = opensAt;
    if (at < closesAt) {
      if (left <= closesAt - at) return at + left;
      left -= closesAt - at;
    }
    at = nextOpens;
  }
  throw new PickWindowError("the span of text hours does not end");
}

/** An instant as K-05 writes one: UTC to the whole second, ending in Z (CQ-09), never past the instant given. */
export function utcOf(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

export interface WindowInput {
  /** Whether the person picks on the page (the caller is a page) or otherwise (by text). */
  readonly via: "page" | "text";
  /** The gate's now (K-09 v1 gateAndCommit.request.now), UTC. */
  readonly now: string;
  /** The start of the soonest time offered, UTC: the window ends no later. */
  readonly soonest: string;
  /** The zone their text hours are counted in (CQ-05: the visit's, else the business's). */
  readonly zone: string;
  /** Whether the person picking is the owner or on the team, whose text hours open at 8am (RULES 4.3). */
  readonly team: boolean;
}

function instantOf(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new PickWindowError(`${what} is not an instant`);
  return ms;
}

/** The window to pick one of the next open times in (A6-11): 10 minutes on the page, else 2 of their text hours. */
export function pickWindowOf(input: WindowInput): PickWindow {
  const now = instantOf(input.now, "now");
  const visit = instantOf(input.soonest, "the soonest time");
  if (input.via === "page") {
    const ends = now + PAGE_PICK_MINUTES * MINUTE;
    return {
      via: "page",
      minutes: PAGE_PICK_MINUTES,
      pickBy: utcOf(Math.min(ends, visit)),
      cutByVisit: visit < ends,
    };
  }
  const opens = input.team ? STAFF_OPENS : CUSTOMER_OPENS;
  const ends = addTextHours(now, TEXT_PICK_HOURS * HOUR, input.zone, opens, TEXT_HOURS_CLOSE);
  return {
    via: "text",
    textHours: TEXT_PICK_HOURS,
    zone: input.zone,
    opens,
    closes: TEXT_HOURS_CLOSE,
    pickBy: utcOf(Math.min(ends, visit)),
    cutByVisit: visit < ends,
  };
}
