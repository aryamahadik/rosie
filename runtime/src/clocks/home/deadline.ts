// The clock home's deadlines (T-591; C-055; S13-35 "Runs every clock from the visit"; RULES 5.1, 5.5, 5.8, 4.3; S13-28
// rules 47 and 48). S13-35: "Deadlines are set from the visit, inside text hours, with time left to act. No clock runs
// past the visit: its safe default applies by then ... Every deadline ends before the visit ... On a job sent now, every
// clock is the plug-in's urgent clock, any hour ... No clock or promise runs past the arrival estimate." Its rule: "every
// clock leaves the person time to act, and ends by the visit."
//
// Every due time the home gives, in the zone it is set in (CQ-05: the visit's, else the business's; ../due.ts zoneFor):
//
//   1. Ends by the visit: a deadline that would pass the visit's start is cut to it, as step 9 caps its own (../due.ts).
//   2. Sits inside the person's text hours (./text-hours.ts: 9am to 8pm, the owner's and team's from 8am). Outside them it
//      moves to when they next open, if that is still by the visit: "the earliest safe moment in text hours" (RULES 5.8;
//      S13-28 rule 48), and a later deadline only leaves more time to act. Else, with no opening left before the visit,
//      it moves back to when they last closed, if that still leaves time to act: at least 1 hour after the clock started,
//      step 9's own floor (../due.ts DELIVERY_FLOOR_MS; RULES 5.1's "time left to act"). Else no moment inside text hours
//      both leaves time to act and comes by the visit, and it stays where it is: by the visit, outside text hours,
//      flagged (`inTextHours` false), since the visit and the time to act come first in S13-35's rule.
//   3. On a job sent now: the plug-in's urgent clock from the clock's start, any hour, never past the arrival estimate.
//
// `homeDueOf` is step 9's due rule (../due.ts dueOf, T-255) held to the home, `homeNeverDeliveredDueOf` the same for the
// never-delivered path (neverDeliveredDueOf), and `fitDeadline` holds any other deadline a step names to it (the journeys
// call it; build prompt 3.5). Reply clocks are elapsed time until Jay rules on CQ-95 (c); ./text-hours.ts textHoursAfter
// counts text hours when a clock does.
//
// Pure: no clock, no I/O. Times in and out are K-05's UTC instants to the whole second (CQ-09). Never logged by anything
// here: a due time, a zone. Throws DueError for an instant that is not one, a zone the platform does not know, or an
// urgent clock that is not a length of time.

import {
  DELIVERY_FLOOR_MS,
  dueOf,
  DueError,
  neverDeliveredDueOf,
  type DueBranch,
  type DueInput,
  type NeverDeliveredBranch,
  type NeverDeliveredInput,
} from "../due";
import { ceilSecond, floorSecond, instantOf, utcOf } from "./instants";
import { checkZone, inTextHours, lastInTextHours, nextInTextHours, type Audience } from "./text-hours";

/**
 * Where the home put a deadline:
 *   asGiven     inside text hours and by the visit, as its rule gave it;
 *   visitStart  cut to the visit's start, which is inside text hours (or, with `inTextHours` false, no moment inside them
 *               leaves time to act before it);
 *   later       moved to when text hours next open, still by the visit;
 *   earlier     moved back to when text hours last closed (no opening was left before the visit), still leaving time to act;
 *   urgent      a job sent now: the plug-in's urgent clock, any hour.
 */
export type HomeFit = "asGiven" | "visitStart" | "later" | "earlier" | "urgent";

export interface DeadlineInput {
  /** The deadline as its rule gives it (step 9's due rule, a step's Clock line, a journey's own deadline), UTC. */
  dueAt: string;
  /** When the clock started (the first delivery receipt, or the send), UTC: the time left to act counts from here. */
  from: string;
  /** The visit's start, UTC; null when the deadline is about no visit. */
  visitStartsAt: string | null;
  /** The zone the deadline is set in: the visit's, else the business's (CQ-05; ../due.ts zoneFor). */
  zone: string;
  /** Whose text hours it keeps: the person who must act by it (RULES 4.3). */
  audience: Audience;
}

export interface HomeDeadline {
  /** When the clock row is due: UTC to the whole second (K-05 armClock `dueAt`). */
  dueAt: string;
  /** The zone it was set in (K-05 armClock `dueZone`). */
  dueZone: string;
  fit: HomeFit;
  /**
   * True when the deadline reached or passed the visit's start (or the arrival estimate), so that start held it first: cut
   * to it here, or already capped there by step 9's own rule.
   */
  cutByVisit: boolean;
  /** True when the due time is inside the audience's text hours in its zone. */
  inTextHours: boolean;
}

export interface UrgentInput {
  /** When the clock started (the first delivery receipt, or the send), UTC. */
  from: string;
  /** The plug-in's urgent clock for a job sent now, in milliseconds (such as a 5-minute reply to an on-call lockout). */
  urgentClockMs: number;
  /** The arrival estimate, UTC, which no clock passes; null when none is known yet. */
  arrivalAt: string | null;
  zone: string;
  audience: Audience;
}

/** Step 9's due rule's input (../due.ts DueInput), with what the home needs beside it. */
export interface HomeDueInput extends DueInput {
  /** Who the question is to: their text hours hold the deadline (RULES 4.3). */
  audience: Audience;
  /** A job sent now: the plug-in's urgent clock in milliseconds, which replaces step 9's rule (S13-35); null: a set time. */
  urgentClockMs: number | null;
}

export interface HomeDue extends HomeDeadline {
  /** The part of step 9's rule the deadline came from; null on a job sent now (the urgent clock replaces the rule). */
  branch: DueBranch | null;
  /** True when a Clock line was given in a form step 9 cannot read, so its default was used (../due.ts). */
  clockLineUnread: boolean;
}

/** Step 9's never-delivered input (../due.ts NeverDeliveredInput), with what the home needs beside it. */
export interface HomeNeverDeliveredInput extends NeverDeliveredInput {
  /** Who is told when the path applies: the owner, or Rosie's team for the owner's own question (S13-29 rule 57). */
  audience: Audience;
  /** A job sent now: the plug-in's urgent clock in milliseconds; null: a set time. */
  urgentClockMs: number | null;
}

export interface HomeNeverDeliveredDue extends HomeDeadline {
  /** The part of the never-delivered rule the time came from; null on a job sent now. */
  branch: NeverDeliveredBranch | null;
}

/** Holds an instant to the home: by the visit, then inside text hours as far as time to act and the visit allow. */
function fit(
  candidate: number,
  floor: number,
  visit: number | null,
  zone: string,
  audience: Audience,
): HomeDeadline {
  let due = candidate;
  let placed: HomeFit = "asGiven";
  let cutByVisit = false;
  if (visit !== null && due >= visit) {
    due = visit;
    placed = "visitStart";
    cutByVisit = true;
  }
  if (!inTextHours(due, zone, audience)) {
    const later = nextInTextHours(due, zone, audience);
    if (visit === null || later <= visit) {
      due = later;
      placed = "later";
    } else {
      const earlier = lastInTextHours(due, zone, audience);
      if (earlier >= floor) {
        due = earlier;
        placed = "earlier";
      }
    }
  }
  return {
    dueAt: utcOf(due),
    dueZone: zone,
    fit: placed,
    cutByVisit,
    inTextHours: inTextHours(due, zone, audience),
  };
}

/**
 * Holds a deadline to the clock home (S13-35; RULES 5.1): cut to end by the visit, then into the audience's text hours,
 * later if that is still by the visit, else earlier if that still leaves time to act (1 hour after `from`).
 */
export function fitDeadline(input: DeadlineInput): HomeDeadline {
  const zone = checkZone(input.zone);
  const candidate = ceilSecond(instantOf(input.dueAt, "dueAt"));
  const floor = ceilSecond(instantOf(input.from, "from")) + DELIVERY_FLOOR_MS;
  const visit =
    input.visitStartsAt === null ? null : floorSecond(instantOf(input.visitStartsAt, "visitStartsAt"));
  return fit(candidate, floor, visit, zone, input.audience);
}

/**
 * A job sent now: every clock is the plug-in's urgent clock, any hour (S13-35; RULES 5.5), so it runs from its start with
 * no text-hours cut, at 2am as at noon, and never past the arrival estimate (S13-35: "No clock or promise runs past the
 * arrival estimate").
 */
export function urgentDue(input: UrgentInput): HomeDeadline {
  const zone = checkZone(input.zone);
  const span = input.urgentClockMs;
  if (!Number.isInteger(span) || span <= 0) throw new DueError("the urgent clock is not a length of time");
  const start = ceilSecond(instantOf(input.from, "from"));
  const arrival = input.arrivalAt === null ? null : floorSecond(instantOf(input.arrivalAt, "arrivalAt"));
  let due = start + span;
  let cutByVisit = false;
  if (arrival !== null && due >= arrival) {
    due = arrival;
    cutByVisit = true;
  }
  return {
    dueAt: utcOf(due),
    dueZone: zone,
    fit: "urgent",
    cutByVisit,
    inTextHours: inTextHours(due, zone, input.audience),
  };
}

/**
 * A question's clock, due by step 9's rule (../due.ts dueOf: its Clock line, else 7pm the day before, 2 hours before a
 * same-day visit, at least 1 hour after delivery, by the visit; with no visit 8pm the day after delivery) and held to the
 * home: inside the person's text hours and by the visit. On a job sent now, the plug-in's urgent clock from delivery
 * instead, any hour. This is what the arming's call to dueOf becomes (T-255's handoff: "T-591 should call or constrain
 * dueOf").
 */
export function homeDueOf(input: HomeDueInput): HomeDue {
  if (input.urgentClockMs !== null) {
    const urgent = urgentDue({
      from: input.deliveredAt,
      urgentClockMs: input.urgentClockMs,
      arrivalAt: input.visitStartsAt,
      zone: input.zone,
      audience: input.audience,
    });
    return { ...urgent, branch: null, clockLineUnread: false };
  }
  const due = dueOf({
    deliveredAt: input.deliveredAt,
    clockLine: input.clockLine,
    visitStartsAt: input.visitStartsAt,
    zone: input.zone,
  });
  const held = fitDeadline({
    dueAt: due.dueAt,
    from: input.deliveredAt,
    visitStartsAt: input.visitStartsAt,
    zone: input.zone,
    audience: input.audience,
  });
  return { ...held, branch: due.branch, clockLineUnread: due.clockLineUnread };
}

/**
 * When a question never delivered takes step 9's never-delivered path (../due.ts neverDeliveredDueOf: by the visit, or
 * with none 8pm the day after the send), held to the home: inside the text hours of whoever is told, and by the visit, so
 * a 7am visit's path applies at 8pm the evening before, while the owner can still act. On a job sent now, the plug-in's
 * urgent clock from the send.
 */
export function homeNeverDeliveredDueOf(input: HomeNeverDeliveredInput): HomeNeverDeliveredDue {
  if (input.urgentClockMs !== null) {
    const urgent = urgentDue({
      from: input.sentAt,
      urgentClockMs: input.urgentClockMs,
      arrivalAt: input.visitStartsAt,
      zone: input.zone,
      audience: input.audience,
    });
    return { ...urgent, branch: null };
  }
  const due = neverDeliveredDueOf({
    sentAt: input.sentAt,
    visitStartsAt: input.visitStartsAt,
    zone: input.zone,
  });
  const held = fitDeadline({
    dueAt: due.dueAt,
    from: input.sentAt,
    visitStartsAt: input.visitStartsAt,
    zone: input.zone,
    audience: input.audience,
  });
  return { ...held, branch: due.branch };
}
