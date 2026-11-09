// The 60-choice cap (T-295; C-075). arch 01 line 69: the frontier is about 40 choices, never more than 60 (DD); arch 03
// line 167: "Over 60 choices: each booking other than the target collapses to one 'which booking?' choice (DD)"; K-02 v1
// context.choices (maxItems 60) and choice kind whichBooking; K-09 v1 buildFrontier, whose tooManyChoices is "Still over
// 60 choices after every other booking collapsed".
//
// At 60 choices or fewer nothing changes. Over 60:
//   - the target booking keeps its choices, and so does every choice about no booking (a door, an any-time row, a
//     question about the business);
//   - every other booking's choices give way to one which-booking choice, where its first choice stood (K-02 v1: kind
//     whichBooking; its question the booking it stands for; label "Which booking?" with the booking's business, date
//     and time; its target the booking's; no fields);
//   - the choices are numbered again in frontier order (c-01, c-02, ...: a choice id appears once), and each "question"
//     stakes reason names its sibling's new id;
//   - still over 60: tooMany, with the count (K-09 v1 tooManyChoices; the turn takes the outage path, arch 06 line 293).
//
// Defaults where no source gives a value (ops/QUESTIONS.md, through the report):
//   - the target booking: the booking of the most recently sent open question that has choices (the question a reply most
//     likely answers), else the first booking in frontier order. The guard's targets name bookings but not which one
//     the turn is about (K-09 v1 guardTargets: "Several targets fit: the model picks by content", arch 02 line 115);
//   - a which-booking choice's step: its booking's hub when a hub case of it collapsed (K-02 v1: "the target booking's
//     hub for whichBooking"), else the step of its first collapsed choice (journeys 4 to 6 and 9 have no hub, arch 03
//     line 163, and T-291's read gives no booking's stage);
//   - its stakes: high when any choice it stands for is high, with their reasons (each once, "question" reasons left
//     out: they name choices that are gone), since a reply about that booking may answer one of them (the safer route:
//     K-02 README "Stakes"); low otherwise;
//   - its definition, read by decide only: WHICH_BOOKING_DEFINITION.

import { choiceIdOf } from "../assemble/assemble";
import type { Choice, OpenQuestion, StakesReason, Time } from "../assemble/types";

/** The most choices a frontier holds (arch 01 line 69; K-02 v1 context.choices maxItems). */
export const MAX_CHOICES = 60;

/** What a which-booking choice means, for decide (K-02 v1 choice.definition; arch 03 line 181). */
export const WHICH_BOOKING_DEFINITION =
  "The text is about this booking, not the one the other choices are for. Its own choices are not listed: there were more than the list holds.";

/** The capped choices, or the count still left over 60. */
export type CapAnswer =
  | { result: "capped"; choices: Choice[]; collapsedBookingIds: string[]; target: string | null }
  | { result: "tooMany"; count: number };

/** The turn's target booking, by the default above; null when no choice is about a booking. */
export function targetBookingOf(
  choices: readonly Choice[],
  openQuestions: readonly OpenQuestion[],
): string | null {
  const withChoices = new Set(choices.flatMap((choice) => choice.target.bookingId ?? []));
  let newest: { bookingId: string; at: number } | null = null;
  for (const question of openQuestions) {
    const bookingId = question.target.bookingId;
    if (bookingId === null || !withChoices.has(bookingId)) continue;
    const at = Date.parse(question.sentAt.utc);
    if (Number.isNaN(at)) continue;
    if (newest === null || at > newest.at) newest = { bookingId, at };
  }
  if (newest !== null) return newest.bookingId;
  return choices.find((choice) => choice.target.bookingId !== null)?.target.bookingId ?? null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A visit's date and time in its own zone (S13-03), as the master writes one: "Sat Oct 24, 11:00am"; null if unreadable. */
export function visitWords(time: Time): string | null {
  const at = new Date(time.utc);
  if (Number.isNaN(at.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: time.zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((each) => each.type === type)?.value);
  const [year, month, day, hour, minute] = [
    part("year"),
    part("month"),
    part("day"),
    part("hour"),
    part("minute"),
  ];
  if ([year, month, day, hour, minute].some((value) => !Number.isInteger(value))) return null;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const monthName = MONTHS[month - 1];
  if (weekday === undefined || monthName === undefined) return null;
  const clock = `${String(hour % 12 === 0 ? 12 : hour % 12)}:${String(minute).padStart(2, "0")}`;
  return `${weekday} ${monthName} ${String(day)}, ${clock}${hour < 12 ? "am" : "pm"}`;
}

/** The label of a booking's which-booking choice: "Which booking?" with its business, date and time (K-02 v1). */
export function whichBookingLabel(target: Choice["target"]): string {
  const when = target.visitAt === null ? null : visitWords(target.visitAt);
  return when === null
    ? `Which booking? ${target.businessName}`
    : `Which booking? ${target.businessName}, ${when}`;
}

/** The reasons a which-booking choice is high: those of the choices it stands for, each once, no "question" reason. */
function standInReasons(choices: readonly Choice[]): StakesReason[] {
  const seen = new Set<string>();
  const reasons: StakesReason[] = [];
  for (const choice of choices) {
    if (choice.stakes !== "high") continue;
    for (const reason of choice.stakesFrom) {
      if (reason.why === "question") continue;
      const key = `${reason.why}|${reason.step ?? ""}|${reason.ref ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reasons.push({ ...reason });
    }
  }
  const high = choices.some((choice) => choice.stakes === "high");
  if (high && reasons.length === 0) reasons.push({ why: "unknown", step: null, ref: null });
  return reasons;
}

/** One booking's which-booking choice, standing for its collapsed choices (the first of them gives the target). */
export function whichBookingChoice(
  bookingId: string,
  collapsed: readonly [Choice, ...Choice[]],
  choiceId: string,
): Choice {
  const [first] = collapsed;
  const hub = collapsed.find((choice) => choice.kind === "hub");
  const stakesFrom = standInReasons(collapsed);
  return {
    choiceId,
    kind: "whichBooking",
    label: whichBookingLabel(first.target),
    definition: WHICH_BOOKING_DEFINITION,
    step: (hub ?? first).step,
    question: bookingId,
    branch: null,
    anytimeRow: null,
    door: null,
    hub: null,
    target: { ...first.target, visitAt: first.target.visitAt === null ? null : { ...first.target.visitAt } },
    fields: [],
    stakes: stakesFrom.length > 0 ? "high" : "low",
    stakesFrom,
  };
}

/** A slot of the capped list: a choice kept, or the place of a booking's which-booking choice. */
type Slot = { kept: Choice } | { bookingId: string };

/** Caps the frontier at 60 choices (see above). */
export function capChoices(
  choices: readonly Choice[],
  openQuestions: readonly OpenQuestion[],
  max: number = MAX_CHOICES,
): CapAnswer {
  const target = targetBookingOf(choices, openQuestions);
  if (choices.length <= max)
    return { result: "capped", choices: [...choices], collapsedBookingIds: [], target };

  const slots: Slot[] = [];
  const collapsed = new Map<string, [Choice, ...Choice[]]>();
  for (const choice of choices) {
    const bookingId = choice.target.bookingId;
    if (bookingId === null || bookingId === target) {
      slots.push({ kept: choice });
      continue;
    }
    const earlier = collapsed.get(bookingId);
    if (earlier === undefined) {
      collapsed.set(bookingId, [choice]);
      slots.push({ bookingId });
    } else {
      earlier.push(choice);
    }
  }
  if (slots.length > max) return { result: "tooMany", count: slots.length };

  // Number again in frontier order; each old id maps to its new one, or to its booking's which-booking choice.
  const renamed = new Map<string, string>();
  slots.forEach((slot, index) => {
    const id = choiceIdOf(index);
    if ("kept" in slot) renamed.set(slot.kept.choiceId, id);
    else for (const choice of collapsed.get(slot.bookingId) ?? []) renamed.set(choice.choiceId, id);
  });
  const capped = slots.map((slot, index): Choice => {
    const id = choiceIdOf(index);
    if (!("kept" in slot)) {
      const stoodFor = collapsed.get(slot.bookingId);
      if (stoodFor === undefined) throw new Error("a which-booking slot without its choices");
      return whichBookingChoice(slot.bookingId, stoodFor, id);
    }
    const stakesFrom = slot.kept.stakesFrom.map((reason) =>
      reason.why === "question" && reason.ref !== null
        ? { ...reason, ref: renamed.get(reason.ref) ?? reason.ref }
        : reason,
    );
    return { ...slot.kept, choiceId: id, stakesFrom };
  });
  return { result: "capped", choices: capped, collapsedBookingIds: [...collapsed.keys()], target };
}
