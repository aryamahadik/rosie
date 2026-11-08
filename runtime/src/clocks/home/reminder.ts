// One reminder for each booked time (T-591; C-055; S13-35; RULES 5.4; A7-01, B7-01, B7-55). S13-35: "One reminder for
// each booked time, at least 3 hours before free cancel ends, inside text hours. Never two for the same time. Usually 10am
// the day before. When free cancel ends before 1pm on the day before, 6pm the evening before that. A booking made after
// the reminder hour gets the reminder's facts in its confirmation." A7-01's own case: free cancel ends Fri at 11am for a
// Sat visit, "so it goes Thu Oct 22 at 6pm. With no cutoff at all: 10am the day before." B7-01: free cancel until 7am
// Thu for a Thu visit, so Wed at 10am. B7-55: "A job sent now gets no reminder."
//
// The time, in the zone the visit is set in (CQ-05: the visit's, else the business's; ../due.ts zoneFor), for a visit on
// day D:
//   - 10am on D-1, when free cancel has no cutoff or that is still at least 3 hours before it ends ("usually");
//   - else the latest of the reminder hours, 6pm and 10am, at least 3 hours before free cancel ends: free cancel ending
//     before 1pm on D-1 gives 6pm on D-2, "the evening before that" (noon the day before gives 6pm two evenings before),
//     and a cutoff earlier still walks back the same way, 10am then 6pm the evening before (a default: S13-35 names only
//     the day-before case).
// Both hours are inside every audience's text hours (./text-hours.ts) and before the visit. A booking made at or after
// that time gets none: its confirmation carried the facts (A7-01: "A booking made after this hour gets none").
//
// One per booked time: a reminder is keyed by its booking and the booked time's start (`reminderKeyOf`), and the same
// inputs always give the same time, so asking twice gives the one reminder, and `remindersOf` folds a booking's times into
// one reminder per start (each later day of a several-day visit gets its own: A7-01, B7-01). Times that share a start but
// differ in free cancel (two lines with their own cancel rules) get the earliest cutoff's time, which is at least 3 hours
// before every one of them.
//
// Which bookings get none (cancelled, paused, a death report) and the reminder step itself are journey 7's. Pure: no
// clock, no I/O; times in and out are K-05's UTC instants to the whole second. Throws DueError for an instant that is not
// one, a zone the platform does not know, or a booking id that is not a label.

import { isLabel } from "../../trace";
import { DueError } from "../due";
import { instantAtLocal, localDateOf } from "../zone";
import { floorSecond, HOUR, instantOf, utcOf } from "./instants";
import { checkZone } from "./text-hours";

/** 10am: the usual reminder hour, the day before the visit (S13-35; RULES 5.4). */
export const REMINDER_HOUR = 10;
/** 6pm: the evening reminder hour, when free cancel ends too early for 10am (S13-35). */
export const REMINDER_EVENING_HOUR = 18;
/** At least 3 hours before free cancel ends (S13-35; RULES 5.4). */
export const REMINDER_LEAD_MS = 3 * HOUR;

/** One booked time: when it starts and when its free cancel ends. */
export interface BookedTime {
  /** The booked time's start, UTC. */
  startsAt: string;
  /** When free cancel ends for it, UTC; null when the booking has no free-cancel cutoff. */
  freeCancelEndsAt: string | null;
}

export interface ReminderInput extends BookedTime {
  /** The booking the time is booked on (K-04 bookings id): with the start, the reminder's key. */
  bookingId: string;
  /** The zone the visit is set in (CQ-05; ../due.ts zoneFor). */
  zone: string;
  /** When the booking was made, UTC: one made at or after the reminder's time carries its facts in the confirmation. */
  bookedAt: string;
  /** Booked as sent now (B7-55): no reminder. */
  sentNow: boolean;
}

export interface ReminderRequest {
  bookingId: string;
  zone: string;
  bookedAt: string;
  sentNow: boolean;
  /** The booking's booked times, in any order; a start listed twice is one booked time. */
  times: readonly BookedTime[];
}

/** Which hour the reminder took: 10am the day before, or an earlier reminder hour before free cancel ends. */
export type ReminderRule = "dayBefore" | "beforeFreeCancel";

/** Why no reminder goes: a job sent now (B7-55), or a booking made after the reminder's time (its confirmation carried it). */
export type NoReminder = "sentNow" | "inConfirmation";

export interface Reminder {
  /** One per booked time: `reminder/<booking id>/<start>` (a label). */
  key: string;
  /** The booked time's start, UTC to the whole second. */
  startsAt: string;
  /** When the reminder goes, UTC to the whole second; null when none goes. */
  remindAt: string | null;
  /** The zone it was set in. */
  zone: string;
  rule: ReminderRule | null;
  none: NoReminder | null;
}

/** The key of a booked time's one reminder: its booking and its start, to the whole second (a label). */
export function reminderKeyOf(bookingId: string, startsAt: string): string {
  if (!isLabel(bookingId)) throw new DueError("the booking id is not a label");
  return `reminder/${bookingId}/${utcOf(floorSecond(instantOf(startsAt, "startsAt")))}`;
}

/** The reminder's time for a visit starting at `start` whose free cancel ends at `freeCancelEnd` (null: no cutoff). */
function reminderTime(
  start: number,
  freeCancelEnd: number | null,
  zone: string,
): { at: number; rule: ReminderRule } {
  const dayBefore = instantAtLocal(zone, localDateOf(start, zone), -1, REMINDER_HOUR);
  if (freeCancelEnd === null) return { at: dayBefore, rule: "dayBefore" };
  const latest = freeCancelEnd - REMINDER_LEAD_MS;
  if (dayBefore <= latest) return { at: dayBefore, rule: "dayBefore" };
  // The latest reminder hour at or before `latest`: 6pm, then 10am, on its own date, else 6pm the evening before it.
  const date = localDateOf(latest, zone);
  const evening = instantAtLocal(zone, date, 0, REMINDER_EVENING_HOUR);
  if (evening <= latest) return { at: evening, rule: "beforeFreeCancel" };
  const morning = instantAtLocal(zone, date, 0, REMINDER_HOUR);
  if (morning <= latest) return { at: morning, rule: "beforeFreeCancel" };
  return { at: instantAtLocal(zone, date, -1, REMINDER_EVENING_HOUR), rule: "beforeFreeCancel" };
}

/** The one reminder of one booked time (S13-35; RULES 5.4): the same inputs always give the same reminder. */
export function reminderOf(input: ReminderInput): Reminder {
  const zone = checkZone(input.zone);
  const key = reminderKeyOf(input.bookingId, input.startsAt);
  const start = floorSecond(instantOf(input.startsAt, "startsAt"));
  const freeCancelEnd =
    input.freeCancelEndsAt === null
      ? null
      : floorSecond(instantOf(input.freeCancelEndsAt, "freeCancelEndsAt"));
  const bookedAt = instantOf(input.bookedAt, "bookedAt");
  const base = { key, startsAt: utcOf(start), zone };
  if (input.sentNow) return { ...base, remindAt: null, rule: null, none: "sentNow" };
  const { at, rule } = reminderTime(start, freeCancelEnd, zone);
  if (at <= bookedAt) return { ...base, remindAt: null, rule: null, none: "inConfirmation" };
  return { ...base, remindAt: utcOf(at), rule, none: null };
}

/** The earlier of two free-cancel cutoffs; null (no cutoff) only when both are. */
function earlierCutoff(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return instantOf(b, "freeCancelEndsAt") < instantOf(a, "freeCancelEndsAt") ? b : a;
}

/**
 * A booking's reminders: one per booked time, never two for the same time (S13-35), in start order. A start listed more
 * than once is one booked time, and takes the earliest free-cancel cutoff given for it (none only when none is given).
 */
export function remindersOf(request: ReminderRequest): Reminder[] {
  const byStart = new Map<number, BookedTime>();
  for (const time of request.times) {
    const start = floorSecond(instantOf(time.startsAt, "startsAt"));
    const seen = byStart.get(start);
    byStart.set(
      start,
      seen === undefined
        ? time
        : {
            startsAt: seen.startsAt,
            freeCancelEndsAt: earlierCutoff(seen.freeCancelEndsAt, time.freeCancelEndsAt),
          },
    );
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, time]) =>
      reminderOf({
        bookingId: request.bookingId,
        zone: request.zone,
        bookedAt: request.bookedAt,
        sentNow: request.sentNow,
        startsAt: time.startsAt,
        freeCancelEndsAt: time.freeCancelEndsAt,
      }),
    );
}
