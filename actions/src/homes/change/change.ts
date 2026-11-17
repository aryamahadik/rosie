// The change home (T-594; C-099; S13-56 "If the business can't give it, or someone leaves"): from a booked visit and the
// reason the business can't give it as booked, the offers allowed, the deadline the offer names and what silence does.
//
// S13-56 as the bundle compiles it (both flows, word for word; test-support.ts S13_56_RULES checks each line against the
// compiled step): "One path for every reason the business can't give a booked visit, and one path for someone who
// leaves." "Any reason counts: a pro can't come, the business is closed, a part is late, or a tool is out." "Also the
// weather, too few booked, a removal or a quit, a license lapse, or the owner unable to act." "The business offers another
// pro, only where the booking didn't name a person. Or another time, or a free cancel with everything back." "First, any
// people-per-staff or two-adult rule is checked again for whoever is left." "Another pro needs the skill (and any license
// the owner says it needs), at the same price or lower. A higher price needs the customer's yes." "Never say why the pro
// is out." "The one exception, a pro running late: 'No reply: the later start stands, and nothing else changes.'" "Never:
// a booking that named a person (a child's too), or someone in care, is moved to another person on silence: Sam calls
// them." "The offer names the deadline: 7pm the day before, or 2 hours before for a visit today." "No answer by the
// deadline: called off, no fee, all paid goes back, after every channel is tried. Nothing moves on silence." "A crew, class
// seat, party or drop-off where nobody was named, with no one in care: the business staffs it." "A job sent now whose pro
// can't come, and nobody takes it: called off with no fee, and everything paid is refunded." "A booking with a need-by
// date: new times only before it." "The owner can't act, and nobody else can: visits only the owner could give get a free
// cancel, with everything back." "Rosie's team acts when the owner can't be reached in time (judgment rule 57)." "Someone
// leaves, by asking, by removal or by quitting: their last day is set, and their future bookings go to this path."
// "Their booked customers get the choices above." "A business that closes: every future booking is called off with
// everything back, and each customer is told (S11-75)." Its rule: "when the business side can't give a visit, the
// customer chooses, and silence never moves them."
//
// The paths (changeOffer), first that fits:
//   - notOffered: the booking is no booked visit (a request, a visit under way, over or cancelled), its visit has begun,
//     or a death was reported on it (the owner decides the rest: A7-81);
//   - calledOff: a business that closes (S11-75) or calls the visit off (A7-66, A7-93 "The business cancels it"): no fee,
//     everything back, at once; or a job sent now whose pro can't come and nobody takes it;
//   - laterStart: a pro running late: keep the later start, move or cancel, all free, and no reply keeps the later start
//     (A7-14), the one case in which silence changes anything;
//   - businessStaffs: a pro out of a job sent now that a stand-in takes, or of a crew, class seat, party or drop-off where
//     nobody was named, with no one in care, once the people-per-staff and two-adult rules hold for whoever is left: the
//     customer is asked nothing and the visit stays as booked;
//   - offer: another pro (a pro out only, never where the booking named a person, never for someone in care, and only a
//     stand-in who passes every check below), another time (before the need-by date, if any) and a free cancel with
//     everything back; the owner unable to act gives the free cancel alone, and Rosie's team acts. The deadline is S13-56's
//     (offerDeadline) and no answer by it calls that visit off, no fee, everything back, after every channel is tried.
// No path holds the reason: what the customer is offered, and every word written from it, is the same whichever reason a
// pro is out for (S13-56 "Never say why the pro is out").
//
// A stand-in (standInWhy), first check that fails: the pro who is out; not free or no yes to standing in (A7-15, A7-17:
// "only if one said yes first"); no skill on record; a license the business says they lack, or none known; a people-per-
// staff, two-adult or supervision rule that fails or is not known for them (A7-15: "An apprentice whose supervisor is out
// can't go ahead alone"); a price not known, or higher than the booking's (S13-56: "at the same price or lower").
//
// Defaults used (for ops/QUESTIONS.md), each failing closed: nobody moves, no other pro, a person reaches them:
//   1. Whether a booking named its pro is on no frozen record (K-04 v1's head, K-30 v1 and T-308 hold no such field), so
//      it is the caller's reading, and with none (null) the booking reads as named: no other pro, and Sam calls them.
//   2. Staff skills arrive with journey 2 (K-22 v1 staff_skills, read by no K-05 call yet): a stand-in with no skill on
//      record (null) is never offered (the lead note, DL-925 item 3).
//   3. Someone in care (an in-care mark: S13-10) is on no frozen record the module reads: with none (null) the booking
//      reads as in care. Someone in care is never offered another pro (A7-15 and B7-19: "Sam calls them, never a
//      stand-in"; S13-56: "Sam calls them"), whether or not the booking named a person.
//   4. A license the business says a stand-in lacks (S13-15; K-35 v1), the people-per-staff, two-adult and supervision
//      rules (S13-56; A7-15), a stand-in's price for the service (K-25 v1's staff prices) and what the booking holds (a
//      visit, or a crew, class seat, party or drop-off) are the caller's readings; one not known never lets a stand-in in,
//      and a booking whose holding is not known is a visit, so its customer is asked.
//   5. The deadline is S13-56's ("7pm the day before, or 2 hours before for a visit today"), which is RULES 8.3's and step
//      9's default: it is read by the clock home's due rule (runtime/src/clocks/due.ts dueOf, T-255) from the time the offer
//      is made, so the offer names the time its clock row is due. With it come the clock home's cuts (S13-35): at least 1
//      hour to act, and never past the visit's start. "Or the plug-in's shorter time" is held by no typed field (K-24's pf
//      blocks are free text), so the plug-in's time is never used: the customer keeps S13-56's longer time.
//   6. The deadline's zone is the visit's (S13-03; CQ-05; the due rule's zoneFor): the business's in flow A, which is the
//      lead note's "in the business's zone", and a flow B visit address's when known, else the business's; a deadline is
//      never read in UTC for want of a zone.
//   7. A visit nobody on the record may decide (T-308 whoDecides: no person served on record, or a minor with no parent or
//      guardian on file) gets no other pro, and a person reaches them (S13-31: "When nobody allowed can decide in time, the
//      step's safe default runs and a person is told").
//   8. A job sent now whose pro is out goes to a stand-in who passes every check (nobody was named for it), else it is
//      called off (S13-56); a stand-in for a crew, class seat, party or drop-off is the business's own staffing, never a
//      move on silence: the customer was asked nothing and the visit keeps its time.
// Nothing here reads free text, logs, or holds a name, a number or anyone's words: ids, flags, times and labels in and out.

import type { BookingFlow, BookingStage } from "../../../../db/repo/bookings-head";
import { dueOf, zoneFor, type DueBranch } from "../../../../runtime/src/clocks/due";
import type { DecidesAs, NoDecider, WhoDecides } from "../../domain/identity-access";
import { isDate, type LocalDate } from "../../values/zone";
import { ChangeHomeError } from "./errors";

// ---- what it reads -------------------------------------------------------------------------------------------------

/**
 * Why the business can't give the visit as booked (S13-56's reasons; A7-93's branches), or someone leaves (S13-56: "by
 * asking, by removal or by quitting"). Labels only: the reason is read, never passed on.
 */
export const CHANGE_REASONS = [
  /** A pro can't come: sick, or a day off the owner said OK to (A7-15, S11-43, S11-106). */
  "proCantCome",
  /** A pro is removed from the team (S11-49). */
  "removal",
  /** A pro quits (S11-49). */
  "quit",
  /** A pro asked to leave, and the visit is after their last day (S11-49). */
  "leaves",
  /** A pro's license for the work lapsed, by the business's word (S11-50, S11-99, S13-41). */
  "licenseLapse",
  /** A pro is running late on the visit day (A7-14): the one exception. */
  "proRunningLate",
  /** The business is closed: a closed day, a block, a pause whose visits are moved (S11-13 to S11-15, A7-23). */
  "closed",
  /** A part is late (A7-23). */
  "partLate",
  /** A tool or a room is out (A7-23). */
  "toolOut",
  /** The weather (A7-23). */
  "weather",
  /** Too few booked to run, and the owner called it off (A7-68, A7-69). */
  "tooFewBooked",
  /** The owner can't act, and nobody else can (S11-19): a visit only the owner could give. */
  "ownerCantAct",
  /** The business calls the visit off (A7-66). */
  "businessCancels",
  /** The business closes (S11-75). */
  "businessCloses",
] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number];

/** The reasons a pro is out: the ones another pro could cover, and whose reason is never said (S13-56). */
export const PRO_OUT_REASONS: readonly ChangeReason[] = [
  "proCantCome",
  "removal",
  "quit",
  "leaves",
  "licenseLapse",
];

/** Someone leaving (S13-56: "by asking, by removal or by quitting"): their future bookings go to this path. */
export const LEAVING_REASONS: readonly ChangeReason[] = ["leaves", "removal", "quit"];

/** What a booking holds: a visit with a pro, or a crew, class seat, party or drop-off (S13-56). */
export const BOOKING_HOLDS = ["visit", "crew", "classSeat", "party", "dropOff"] as const;
export type BookingHolds = (typeof BOOKING_HOLDS)[number];

/** The holdings the business staffs where nobody was named and no one is in care (S13-56). */
const STAFFED_HOLDS: readonly BookingHolds[] = ["crew", "classSeat", "party", "dropOff"];

/** An amount in integer minor units with its three-letter currency (CQ-09; K-30 v1 rule 9). */
export interface Price {
  readonly cents: number;
  readonly currency: string;
}

/** Someone who could stand in, as the caller found them. Null: not on any record the caller reads (fails closed). */
export interface StandIn {
  readonly personId: string;
  /** Free at the visit's time and said yes to standing in (A7-15: "only if one is free and said yes"; A7-17). */
  readonly saidYes: boolean;
  /** Has the skill the service needs (K-22 v1 staff_skills; S2-15: journey 2). */
  readonly skill: boolean | null;
  /** The business says they lack a license the work needs, for that service and place (S13-15; K-35 v1). */
  readonly licenseLacking: boolean | null;
  /** Every people-per-staff, two-adult and supervision rule holds with them (S13-56; A7-15). */
  readonly staffRulesHold: boolean | null;
  /** Their price for the booked service (K-25 v1: a staff price, else the service's own). */
  readonly price: Price | null;
}

/** What frozen calls give of the booking: the K-04 v1 head (T-186) and who decides the visit (T-308). See reads.ts. */
export interface ChangeBookingRead {
  readonly bookingId: string;
  readonly businessId: string;
  readonly flow: BookingFlow;
  readonly stage: BookingStage;
  readonly deceased: boolean;
  /** Who decides the visit (T-308 whoDecides): the person served, or a minor's parents or guardians, or nobody. */
  readonly decides: WhoDecides;
}

/** The booking's facts the caller reads beside the head. Null: not on any record the caller reads (fails closed). */
export interface ChangeFacts {
  /** The pro the visit is booked with (K-04 v1 reservations.worker_person_id), or null when no person is booked. */
  readonly proPersonId: string | null;
  /** The booking named its pro (booked by name): on no frozen record (default 1). */
  readonly named: boolean | null;
  /** Someone in care is served (an in-care mark, S13-10): on no frozen record the module reads (default 3). */
  readonly inCare: boolean | null;
  /** What the booking holds (K-04 v1 reservations and the booking's kind; default 4). */
  readonly holds: BookingHolds;
  /** The people-per-staff and two-adult rules hold for whoever is left (S13-56: "First, ... checked again"). */
  readonly staffRuleHolds: boolean | null;
  /** A job sent now (K-30 v1 booking_details.timing sentnow). */
  readonly sentNow: boolean;
  /** The need-by date, a day in the visit's zone (K-30 v1 booking_details.need_by), or null. */
  readonly needBy: LocalDate | null;
  /** The visit's start (K-04 v1 reservations.during), UTC. */
  readonly visitStartsAt: string;
  /** The business's zone (K-04 v1 businesses.time_zone). */
  readonly businessZone: string;
  /** A flow B visit address's zone (K-30 v1 booking_addresses.zone), or null. */
  readonly visitAddressZone: string | null;
  /** The booked price of the service (K-30 v1 booking_lines, the price copied in). */
  readonly price: Price | null;
}

/** One booked visit, as the change home reads it. */
export interface ChangeBooking extends ChangeBookingRead, ChangeFacts {}

/** What the change home rules on: one booking, the reason it can't be given as booked, and who could stand in. */
export interface ChangeReading {
  readonly booking: ChangeBooking;
  readonly reason: ChangeReason;
  /** When the offer is made (the turn's or the job's time), UTC: its deadline is read from here. */
  readonly offeredAt: string;
  /** Who could stand in, as the caller found them; [] for none. */
  readonly standIns: readonly StandIn[];
}

// ---- what it answers -----------------------------------------------------------------------------------------------

/** The change home's paths (see the top of this file). */
export const CHANGE_PATHS = ["offer", "laterStart", "businessStaffs", "calledOff", "notOffered"] as const;
export type ChangePath = (typeof CHANGE_PATHS)[number];

/** Why nothing is offered: a request, a visit under way, over or cancelled, a death reported, or a visit begun. */
export type NotOfferedWhy = "notBooked" | "inProgress" | "over" | "deceased" | "visitStarted";

/** A stand-in's own checks (standInWhy), first that fails, or allowed. */
export type StandInWhy =
  | "allowed"
  | "samePro"
  | "noYes"
  | "noSkillRecorded"
  | "noSkill"
  | "licenseNotKnown"
  | "licenseLacking"
  | "staffRulesNotKnown"
  | "staffRules"
  | "priceNotKnown"
  | "higherPrice";

export interface StandInVerdict {
  readonly personId: string;
  readonly why: StandInWhy;
}

/** Why another pro is or is not offered. */
export type AnotherProWhy =
  | "allowed"
  | "noProOut"
  | "named"
  | "namedNotKnown"
  | "inCare"
  | "inCareNotKnown"
  | "nobodyDecides"
  | "noneAllowed"
  | "notOffered";

export interface AnotherPro {
  readonly offered: boolean;
  readonly why: AnotherProWhy;
  /** The stand-ins who may be offered, by person id, in the order given. */
  readonly standIns: readonly string[];
  /** Each stand-in's own checks; whether the booking lets any in at all is `why`. */
  readonly verdicts: readonly StandInVerdict[];
}

export interface AnotherTime {
  readonly offered: boolean;
  /** New times only before this day, the booking's need-by date (S13-56); null: no limit. */
  readonly before: LocalDate | null;
}

/** Which part of the deadline's rule gave it (default 5). */
export type DeadlineRule = "dayBefore" | "sameDay" | "timeToAct" | "visitStart";

/** The deadline the offer names (S13-56): its clock row is due then. */
export interface ChangeDeadline {
  /** UTC, to the whole second (K-05 armClock dueAt). */
  readonly dueAt: string;
  /** The zone it was read in (K-05 armClock dueZone). */
  readonly dueZone: string;
  readonly rule: DeadlineRule;
}

/**
 * What no answer does: callOff (by the deadline, after every channel is tried: that visit called off, no fee, everything
 * paid for it back; the other visits and their money never kept or refunded for one miss), laterStartStands (a pro running
 * late: nothing else changes), staysBooked (nothing was asked: the visit keeps its time) or none (nothing to answer).
 */
export type SilenceOutcome = "callOff" | "laterStartStands" | "staysBooked" | "none";

/** Whom silence moves: nobody, or, for a pro running late, the visit to the later start (the one exception). */
export type SilenceMoves = "nobody" | "laterStart";

export interface Silence {
  readonly outcome: SilenceOutcome;
  readonly moves: SilenceMoves;
}

/** Who reaches the customer beyond the offer: the owner ("Sam calls them"), Rosie's team (judgment rule 57) or none. */
export type PersonReaches = "owner" | "rosieTeam" | "none";

/** The change home's answer for one booking. It never holds the reason (S13-56: "Never say why the pro is out"). */
export interface ChangeOffer {
  readonly path: ChangePath;
  readonly notOffered: NotOfferedWhy | null;
  readonly anotherPro: AnotherPro;
  readonly anotherTime: AnotherTime;
  /** A free cancel with everything back (S13-56). */
  readonly freeCancel: boolean;
  /** A pro running late: the later start, kept (A7-14 "That's fine"). */
  readonly keepLaterStart: boolean;
  /**
   * businessStaffs on a job sent now: the stand-ins who may take it, each passing every check, in the order given. A crew,
   * class seat, party or drop-off is staffed the business's own way, so [] (S11-46: "Whoever covers has the skill").
   */
  readonly staffedBy: readonly string[];
  readonly deadline: ChangeDeadline | null;
  readonly silence: Silence;
  readonly personReaches: PersonReaches;
  /** Every choice is free (A7-93: "Every choice is free: no fee"; S13-55: "a business cancel: everything back"). */
  readonly fee: "none";
  /** Who picks (S13-31: "The person served decides: ... another pro, a cancel"). */
  readonly decides: WhoDecides;
}

// ---- reading checks -------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const FLOWS: readonly unknown[] = ["A", "B"];
const STAGES: readonly unknown[] = ["entry", "booked", "checked_in", "done", "cancelled"];
const DECIDES_AS: readonly DecidesAs[] = ["served", "parentOrGuardian", "owner", "admin"];
const NO_DECIDER: readonly NoDecider[] = [
  "bookingNotFound",
  "servedNotOnRecord",
  "noParentOrGuardian",
  "nobodyAllowed",
];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isTriState(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isPrice(value: unknown): value is Price {
  if (!isObj(value)) return false;
  const { cents, currency } = value;
  return (
    typeof cents === "number" &&
    Number.isSafeInteger(cents) &&
    cents >= 0 &&
    typeof currency === "string" &&
    /^[A-Z]{3}$/u.test(currency)
  );
}

function isLocalDate(value: unknown): value is LocalDate {
  if (!isObj(value)) return false;
  const { year, month, day } = value;
  return (
    typeof year === "number" &&
    typeof month === "number" &&
    typeof day === "number" &&
    isDate({ year, month, day })
  );
}

function isDecides(value: unknown): value is WhoDecides {
  if (!isObj(value)) return false;
  if (value.ok === false) return (NO_DECIDER as readonly unknown[]).includes(value.why);
  if (value.ok !== true || !Array.isArray(value.deciders)) return false;
  const deciders: readonly unknown[] = value.deciders;
  return (
    deciders.length > 0 &&
    deciders.every(
      (decider) =>
        isObj(decider) && isId(decider.personId) && (DECIDES_AS as readonly unknown[]).includes(decider.as),
    )
  );
}

/** The booking as the home reads it; each problem names a field, never its value. */
function bookingProblems(value: unknown): string[] {
  if (!isObj(value)) return ["the reading has no booking"];
  const problems: string[] = [];
  const need = (ok: boolean, what: string): void => {
    if (!ok) problems.push(what);
  };
  need(isId(value.bookingId), "the booking has no id");
  need(isId(value.businessId), "the booking has no business");
  need(FLOWS.includes(value.flow), "the booking's flow is not A or B");
  need(STAGES.includes(value.stage), "the booking's stage is not one of K-04's");
  need(typeof value.deceased === "boolean", "the booking's deceased flag is not true or false");
  need(isDecides(value.decides), "who decides the visit is not T-308's answer");
  need(value.proPersonId === null || isId(value.proPersonId), "the booking's pro is not an id");
  need(isTriState(value.named), "whether the booking named its pro is not true, false or not known");
  need(isTriState(value.inCare), "whether someone in care is served is not true, false or not known");
  need(
    (BOOKING_HOLDS as readonly unknown[]).includes(value.holds),
    "what the booking holds is not one the change home knows",
  );
  need(isTriState(value.staffRuleHolds), "whether the staff rules hold is not true, false or not known");
  need(typeof value.sentNow === "boolean", "whether the job was sent now is not true or false");
  need(value.needBy === null || isLocalDate(value.needBy), "the need-by date is not a date");
  need(isInstant(value.visitStartsAt), "the visit's start is not an instant");
  need(isId(value.businessZone), "the business has no zone");
  need(
    value.visitAddressZone === null || isId(value.visitAddressZone),
    "the visit address's zone is not a name",
  );
  need(value.price === null || isPrice(value.price), "the booked price is not minor units with a currency");
  return problems;
}

/** A stand-in as the home reads it; each problem names a field, never its value. */
function standInProblems(value: unknown, index: number): string[] {
  const at = `stand-in ${String(index + 1)}`;
  if (!isObj(value)) return [`${at} is not a stand-in`];
  const problems: string[] = [];
  if (!isId(value.personId)) problems.push(`${at} has no person`);
  if (typeof value.saidYes !== "boolean") problems.push(`${at}'s yes is not true or false`);
  if (!isTriState(value.skill)) problems.push(`${at}'s skill is not true, false or not known`);
  if (!isTriState(value.licenseLacking)) problems.push(`${at}'s license is not true, false or not known`);
  if (!isTriState(value.staffRulesHold))
    problems.push(`${at}'s staff rules are not true, false or not known`);
  if (value.price !== null && !isPrice(value.price))
    problems.push(`${at}'s price is not minor units with a currency`);
  return problems;
}

/** Throws ChangeHomeError, naming each problem, for a reading the change home cannot read. */
function checkReading(reading: ChangeReading): void {
  const value: unknown = reading;
  if (!isObj(value)) throw new ChangeHomeError("the change home was given no reading");
  const problems = bookingProblems(value.booking);
  if (!(CHANGE_REASONS as readonly unknown[]).includes(value.reason))
    problems.push("the reason is not one the change home knows");
  if (!isInstant(value.offeredAt)) problems.push("the offer's time is not an instant");
  if (!Array.isArray(value.standIns)) problems.push("the stand-ins are not a list");
  else {
    const standIns: readonly unknown[] = value.standIns;
    standIns.forEach((standIn, index) => problems.push(...standInProblems(standIn, index)));
  }
  if (problems.length > 0) throw new ChangeHomeError("the change home cannot read this booking", problems);
}

// ---- the rules -------------------------------------------------------------------------------------------------------

/** Whether a pro is out for this reason (S13-56: the reasons another pro could cover). */
export function isProOut(reason: ChangeReason): boolean {
  return PRO_OUT_REASONS.includes(reason);
}

/** A stand-in's own checks, first that fails (see the top of this file). */
export function standInWhy(booking: ChangeBooking, standIn: StandIn): StandInWhy {
  if (booking.proPersonId !== null && standIn.personId === booking.proPersonId) return "samePro";
  if (!standIn.saidYes) return "noYes";
  if (standIn.skill === null) return "noSkillRecorded";
  if (!standIn.skill) return "noSkill";
  if (standIn.licenseLacking === null) return "licenseNotKnown";
  if (standIn.licenseLacking) return "licenseLacking";
  if (standIn.staffRulesHold === null) return "staffRulesNotKnown";
  if (!standIn.staffRulesHold) return "staffRules";
  const booked = booking.price;
  const theirs = standIn.price;
  if (booked === null || theirs === null) return "priceNotKnown";
  if (booked.currency !== theirs.currency) return "priceNotKnown";
  return theirs.cents > booked.cents ? "higherPrice" : "allowed";
}

/** Why the booking lets no other pro in at all (S13-56; defaults 1, 3 and 7), or null when it may. */
function bookingBlocks(booking: ChangeBooking): AnotherProWhy | null {
  if (booking.named === true) return "named";
  if (booking.named === null) return "namedNotKnown";
  if (booking.inCare === true) return "inCare";
  if (booking.inCare === null) return "inCareNotKnown";
  if (!booking.decides.ok) return "nobodyDecides";
  return null;
}

const NO_PRO_VERDICTS: readonly StandInVerdict[] = [];

function noPro(why: AnotherProWhy): AnotherPro {
  return { offered: false, why, standIns: [], verdicts: NO_PRO_VERDICTS };
}

/** Another pro for this booking: only for a pro out, never where it named a person or serves someone in care. */
function anotherProOf(reading: ChangeReading): AnotherPro {
  const { booking, reason } = reading;
  if (!isProOut(reason)) return noPro("noProOut");
  const verdicts = reading.standIns.map((standIn) => ({
    personId: standIn.personId,
    why: standInWhy(booking, standIn),
  }));
  const blocked = bookingBlocks(booking);
  if (blocked !== null) return { offered: false, why: blocked, standIns: [], verdicts };
  const allowed = verdicts.filter((verdict) => verdict.why === "allowed").map((verdict) => verdict.personId);
  return allowed.length > 0
    ? { offered: true, why: "allowed", standIns: allowed, verdicts }
    : { offered: false, why: "noneAllowed", standIns: [], verdicts };
}

const RULE_OF: Readonly<Partial<Record<DueBranch, DeadlineRule>>> = {
  dayBefore: "dayBefore",
  sameDay: "sameDay",
  deliveryFloor: "timeToAct",
  visitStart: "visitStart",
};

/** What offerDeadline reads. */
export interface DeadlineRequest {
  readonly flow: BookingFlow;
  readonly visitStartsAt: string;
  readonly offeredAt: string;
  readonly businessZone: string;
  readonly visitAddressZone: string | null;
}

/**
 * The deadline an offer names (S13-56: "7pm the day before, or 2 hours before for a visit today"), in the visit's zone, by
 * the clock home's due rule from the time the offer is made, with its cuts: at least 1 hour to act, never past the visit's
 * start (defaults 5 and 6). Throws ChangeHomeError for an instant that is not one, or a visit whose zone is not known.
 */
export function offerDeadline(request: DeadlineRequest): ChangeDeadline {
  const { flow, visitStartsAt, offeredAt, businessZone, visitAddressZone } = request;
  if (!FLOWS.includes(flow)) throw new ChangeHomeError("the booking's flow is not A or B");
  if (!isInstant(visitStartsAt) || !isInstant(offeredAt))
    throw new ChangeHomeError("the visit's start or the offer's time is not an instant");
  const { zone, from } = zoneFor({ flow, businessZone, visitAddressZone });
  if (from === "utc")
    throw new ChangeHomeError(
      "the visit's zone is not known: a deadline is never read in UTC for want of one",
    );
  const due = dueOf({ deliveredAt: offeredAt, clockLine: null, visitStartsAt, zone });
  const rule = RULE_OF[due.branch];
  if (rule === undefined) throw new ChangeHomeError("the due rule gave no deadline from the visit");
  return { dueAt: due.dueAt, dueZone: due.dueZone, rule };
}

const NO_TIME: AnotherTime = { offered: false, before: null };

/** The change home's answer for one booking (see the top of this file). Throws ChangeHomeError for a bad reading. */
export function changeOffer(reading: ChangeReading): ChangeOffer {
  checkReading(reading);
  const { booking, reason, offeredAt } = reading;
  const answer = (parts: Omit<ChangeOffer, "fee" | "decides">): ChangeOffer => ({
    ...parts,
    fee: "none",
    decides: booking.decides,
  });
  const nothing = (
    path: "calledOff" | "notOffered" | "businessStaffs",
    why: NotOfferedWhy | null,
    staffedBy: readonly string[] = [],
  ): ChangeOffer =>
    answer({
      path,
      notOffered: why,
      anotherPro: noPro("notOffered"),
      anotherTime: NO_TIME,
      freeCancel: false,
      keepLaterStart: false,
      staffedBy,
      deadline: null,
      silence: { outcome: path === "businessStaffs" ? "staysBooked" : "none", moves: "nobody" },
      personReaches: "none",
    });

  if (booking.deceased) return nothing("notOffered", "deceased");
  if (booking.stage === "entry") return nothing("notOffered", "notBooked");
  if (booking.stage === "checked_in") return nothing("notOffered", "inProgress");
  if (booking.stage !== "booked") return nothing("notOffered", "over");
  if (reason === "businessCloses" || reason === "businessCancels") return nothing("calledOff", null);

  const before = booking.needBy;
  if (reason === "proRunningLate")
    return answer({
      path: "laterStart",
      notOffered: null,
      anotherPro: noPro("noProOut"),
      anotherTime: { offered: true, before },
      freeCancel: true,
      keepLaterStart: true,
      staffedBy: [],
      deadline: null,
      silence: { outcome: "laterStartStands", moves: "laterStart" },
      personReaches: "none",
    });
  if (Date.parse(booking.visitStartsAt) <= Date.parse(offeredAt))
    return nothing("notOffered", "visitStarted");

  const proOut = isProOut(reason);
  const anotherPro = anotherProOf(reading);
  if (proOut && booking.sentNow)
    return anotherPro.offered
      ? nothing("businessStaffs", null, anotherPro.standIns)
      : nothing("calledOff", null);
  if (
    proOut &&
    STAFFED_HOLDS.includes(booking.holds) &&
    booking.named === false &&
    booking.inCare === false &&
    booking.staffRuleHolds === true
  )
    return nothing("businessStaffs", null);

  const deadline = offerDeadline({
    flow: booking.flow,
    visitStartsAt: booking.visitStartsAt,
    offeredAt,
    businessZone: booking.businessZone,
    visitAddressZone: booking.visitAddressZone,
  });
  const silence: Silence = { outcome: "callOff", moves: "nobody" };
  if (reason === "ownerCantAct")
    return answer({
      path: "offer",
      notOffered: null,
      anotherPro: noPro("noProOut"),
      anotherTime: NO_TIME,
      freeCancel: true,
      keepLaterStart: false,
      staffedBy: [],
      deadline,
      silence,
      personReaches: "rosieTeam",
    });

  const samCalls = proOut && (booking.named !== false || booking.inCare !== false);
  return answer({
    path: "offer",
    notOffered: null,
    anotherPro,
    anotherTime: { offered: true, before },
    freeCancel: true,
    keepLaterStart: false,
    staffedBy: [],
    deadline,
    silence,
    personReaches: samCalls || !booking.decides.ok ? "owner" : "none",
  });
}

/** When a leaver's access ends (S13-56: "at once, or at the set time"; S11-49: "A removal ends them at once"). */
export type AccessEnds = "atOnce" | "atSetTime";

/**
 * Someone leaving: their access ends at once on a removal, else at the last day set (S13-56; S11-49), and each future
 * booking of theirs goes to this path with that reason. Throws ChangeHomeError for a reason that is not someone leaving.
 */
export function leaverAccessEnds(reason: ChangeReason): AccessEnds {
  if (!LEAVING_REASONS.includes(reason)) throw new ChangeHomeError("the reason is not someone leaving");
  return reason === "removal" ? "atOnce" : "atSetTime";
}
