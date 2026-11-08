// The due rule (T-255; C-055): when a question's clock row is due, from arch 02 step 9 'Wait' (architecture.txt line 127):
//
//   "The question's clock row arms at its first delivery receipt: message.delivered on iMessage and RCS, message.sent or
//   the SMS provider's receipt on SMS, and Resend's delivered on email. It is due at the step's Clock line. Without one:
//   7pm the day before the visit, or 2 hours before a same-day visit, and at least 1 hour after delivery unless that
//   passes the visit's start, which always comes first (RULES 5.1, 8.3; S13-35; DD). With no visit: 8pm the day after
//   delivery (DD). ... Never delivered: no clock runs; by the visit, or with none 8pm the day after the send (DD), the
//   safe default applies and the owner, or Rosie's team for the owner's own question, is told (S13-29 rule 57)."
//
// Read with the clock home, S13-35 ("No clock runs past the visit: its safe default applies by then"; "Every deadline
// ends before the visit"), which wins over a step's own words (S13-30): a Clock line's deadline is held to the visit's
// start too. The zone is CQ-05's (the visit's zone, else the business's) with CQ-08's (the geo port gives a visit
// address's zone) and S13-03's rule: a visit at the business (flow A) uses the business's zone, a visit at the customer's
// place (flow B) that place's. Wall-clock deadlines (7pm, 8pm) are read in that zone on its own calendar, so they stay
// right across a daylight-saving change (S13-03, Sun Nov 1); "2 hours before" and "1 hour after" are elapsed time.
//
// Pure: no clock, no I/O. Times in and out are K-05's UTC instants (CQ-09); a due time is to the whole second, as K-05
// writes it. Never logged by anything here: a due time, a zone, a Clock line's words.

import { instantAtLocal, isZone, localDateOf, sameLocalDate } from "./zone";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 7pm, the default's hour the day before the visit (arch 02 line 127; RULES 8.3: "7pm the day before"). */
export const DAY_BEFORE_HOUR = 19;
/** 8pm, the hour the day after delivery (no visit) or after the send (never delivered) (arch 02 line 127). */
export const DAY_AFTER_HOUR = 20;
/** 2 hours before a same-day visit (arch 02 line 127; RULES 8.3: "2 hours before for a visit today"). */
export const SAME_DAY_LEAD_MS = 2 * HOUR;
/** At least 1 hour after delivery (arch 02 line 127; RULES 5.1: "with time left to act"). */
export const DELIVERY_FLOOR_MS = HOUR;

/** A malformed input: an instant that is not one, or a zone the platform does not know. */
export class DueError extends Error {
  override name = "DueError";
}

/**
 * Which part of step 9's rule gave the due time:
 *   clockLine      the step's Clock line;
 *   dayBefore      7pm the day before the visit;
 *   sameDay        2 hours before a same-day visit;
 *   deliveryFloor  1 hour after delivery, the default being sooner;
 *   visitStart     the visit's start, which always comes first;
 *   noVisit        8pm the day after delivery.
 */
export type DueBranch = "clockLine" | "dayBefore" | "sameDay" | "deliveryFloor" | "visitStart" | "noVisit";

export interface DueInput {
  /** The first delivery receipt's time (K-06 `status.at`; K-05 armClock `deliveredAt`), UTC. */
  deliveredAt: string;
  /** The step's Clock line as it applies (K-04 open_questions.clock, such as "24 h"); null: step 9's default. */
  clockLine: string | null;
  /** The visit's start, UTC; null when the question is about no visit. */
  visitStartsAt: string | null;
  /** The zone the deadline is set in (`zoneFor`). */
  zone: string;
}

export interface Due {
  /** When the clock row is due: UTC to the whole second (K-05 armClock `dueAt`). */
  dueAt: string;
  /** The zone it was set in (K-05 armClock `dueZone`; K-04 clock_rows.due_zone). */
  dueZone: string;
  branch: DueBranch;
  /** True when a Clock line was given in a form the rule cannot read, so step 9's default was used. */
  clockLineUnread: boolean;
}

/** Which part of step 9's never-delivered rule gave the time: the visit's start, or 8pm the day after the send. */
export type NeverDeliveredBranch = "visitStart" | "dayAfterSend";

export interface NeverDeliveredInput {
  /** When the question's message was sent (or, never sent, when it was committed to go), UTC. */
  sentAt: string;
  /** The visit's start, UTC; null when the question is about no visit. */
  visitStartsAt: string | null;
  zone: string;
}

export interface NeverDeliveredDue {
  dueAt: string;
  dueZone: string;
  branch: NeverDeliveredBranch;
}

/** Where the deadline's zone came from: the business's, a flow B visit address's, or UTC when neither is known. */
export type ZoneFrom = "business" | "visitAddress" | "utc";

export interface ZoneInput {
  /** The visit's flow (RULES 2.1: A, the customer comes to the business; B, the business goes to them); null: no visit. */
  flow: "A" | "B" | null;
  /** The business's own zone (K-04 businesses.time_zone); null for a question with no business. */
  businessZone: string | null;
  /** A flow B visit address's zone (CQ-08: the geo port's, or the one stored with the visit); null when not known. */
  visitAddressZone: string | null;
}

/**
 * The deadline's zone (CQ-05: the visit's zone, else the business's; S13-03: a visit at the business uses the business's
 * zone, a visit at the customer's place that place's). Flow A reads the business's zone, never an address's; flow B the
 * visit address's, else the business's. A name the platform does not know counts as not known. With neither, UTC: the
 * zone K-08 gives a row with no business.
 */
export function zoneFor(input: ZoneInput): { zone: string; from: ZoneFrom } {
  if (input.flow === "B" && isZone(input.visitAddressZone)) {
    return { zone: input.visitAddressZone, from: "visitAddress" };
  }
  if (isZone(input.businessZone)) return { zone: input.businessZone, from: "business" };
  return { zone: "UTC", from: "utc" };
}

/**
 * Whether a K-06 receipt is the kind that arms a question's clock (arch 02 line 127; K-06 README "Routing"): `delivered`
 * on iMessage, RCS and email (and on a Linq receipt that does not report its service), `sent` only on SMS. A `failed`
 * receipt, or a `sent` on any other service, arms nothing.
 */
export function isDeliveryReceipt(kind: string, service: string | null): boolean {
  if (kind === "delivered") return true;
  return kind === "sent" && service === "sms";
}

const CLOCK_LINE = /^(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/iu;

/**
 * A Clock line "as it applies" (K-04 open_questions.clock; K-05 openQuestionNew.clock: "such as '24 h'") read as a span of
 * elapsed time from delivery, in ms: a whole number and a unit, minutes, hours or days ("30 min", "24 h", "2 days"). Null
 * for any other form, which the rule cannot read (the master's own lines are free words, kept word for word by K-01).
 */
export function clockLineMs(text: string): number | null {
  const found = CLOCK_LINE.exec(text.trim());
  if (found === null) return null;
  const count = Number(found[1]);
  const unit = (found[2] ?? "").toLowerCase();
  if (count < 1) return null;
  if (unit.startsWith("m")) return count * MINUTE;
  if (unit.startsWith("h")) return count * HOUR;
  return count * DAY;
}

/** An instant as K-05 writes it: UTC to the whole second, ending in Z (CQ-09). */
function utcOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function instantOf(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new DueError(`${what} is not an instant`);
  return ms;
}

function zoneOf(zone: string): string {
  if (!isZone(zone)) throw new DueError("the zone is not an IANA zone the platform knows");
  return zone;
}

/** The instant at the whole second at or after `ms`: "at least" an hour, a span, never a part-second short of it. */
const ceilSecond = (ms: number): number => Math.ceil(ms / SECOND) * SECOND;
/** The instant at the whole second at or before `ms`: a visit's start is never passed. */
const floorSecond = (ms: number): number => Math.floor(ms / SECOND) * SECOND;

/**
 * When a question's clock row is due, armed at its first delivery receipt (arch 02 step 9). Throws DueError for an
 * instant that is not one or a zone the platform does not know.
 *
 *   - A Clock line it can read: delivery plus its span; the visit's start if that comes first (S13-35).
 *   - Else, with a visit: 2 hours before it when it falls on the delivery's date in the zone, else 7pm the day before it;
 *     then at least 1 hour after delivery; then never past the visit's start.
 *   - Else, with no visit: 8pm the day after delivery.
 */
export function dueOf(input: DueInput): Due {
  const zone = zoneOf(input.zone);
  const delivered = ceilSecond(instantOf(input.deliveredAt, "deliveredAt"));
  const visit =
    input.visitStartsAt === null ? null : floorSecond(instantOf(input.visitStartsAt, "visitStartsAt"));
  const span = input.clockLine === null ? null : clockLineMs(input.clockLine);
  const clockLineUnread = input.clockLine !== null && span === null;
  const done = (ms: number, branch: DueBranch): Due => ({
    dueAt: utcOf(ms),
    dueZone: zone,
    branch,
    clockLineUnread,
  });

  if (span !== null) {
    const due = delivered + span;
    return visit !== null && visit < due ? done(visit, "visitStart") : done(due, "clockLine");
  }
  if (visit === null) {
    return done(instantAtLocal(zone, localDateOf(delivered, zone), 1, DAY_AFTER_HOUR), "noVisit");
  }

  let due: number;
  let branch: DueBranch;
  if (sameLocalDate(delivered, visit, zone)) {
    due = visit - SAME_DAY_LEAD_MS;
    branch = "sameDay";
  } else {
    due = instantAtLocal(zone, localDateOf(visit, zone), -1, DAY_BEFORE_HOUR);
    branch = "dayBefore";
  }
  const floor = delivered + DELIVERY_FLOOR_MS;
  if (due < floor) {
    due = floor;
    branch = "deliveryFloor";
  }
  if (visit < due) {
    due = visit;
    branch = "visitStart";
  }
  return done(due, branch);
}

/**
 * When a question that was never delivered takes step 9's never-delivered path (arch 02 line 127): by the visit, or with
 * no visit 8pm the day after the send. Its question's own clock never arms (no receipt, no clock). Throws DueError as
 * `dueOf` does.
 */
export function neverDeliveredDueOf(input: NeverDeliveredInput): NeverDeliveredDue {
  const zone = zoneOf(input.zone);
  const sent = ceilSecond(instantOf(input.sentAt, "sentAt"));
  if (input.visitStartsAt !== null) {
    const visit = floorSecond(instantOf(input.visitStartsAt, "visitStartsAt"));
    return { dueAt: utcOf(visit), dueZone: zone, branch: "visitStart" };
  }
  const due = instantAtLocal(zone, localDateOf(sent, zone), 1, DAY_AFTER_HOUR);
  return { dueAt: utcOf(due), dueZone: zone, branch: "dayAfterSend" };
}
