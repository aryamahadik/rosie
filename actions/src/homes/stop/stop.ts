// The stop home (T-590; C-102, C-078; S13-32 with Master Corrections C1; RULES 7.1 to 7.5): whether Rosie may text this
// person at this business at all, the opt-out line, and what a stop word does to a booked visit.
//
// S13-32 as the bundle compiles it (with C1): "Rosie texts or calls only someone who said yes." "It stops Rosie's texts to
// that phone for every business, at once, until START turns them back on." "Only START turns Rosie's texts to that phone
// back on, for every business. A fresh yes on a new booking, sent from that number, turns on that booking's texts only. A
// booking made any other way sends that phone no text." "Alone, a stop word never cancels, moves or skips a booked visit,
// and never ends a plan." "The opt-out line goes only in the very first text Rosie ever sends a number."
//
// The home rules on a reading of one person's contact at one business (reads.ts readStop: K-04's handle, the person's own
// handles and the mobile's one phones row; K-29's texts rows of everyone behind that contact, through T-307's and T-317's
// ports) and one message:
//   - numberStop: one number stops every business (MC C1). The number is stopped when its phones row's stopped flag is
//     set, or when the newest K-29 texts row for every business (business_id null) read for it, whoever's, is a STOP;
//     either one alone is enough (fail closed). Only START clears both: it clears the flag and its row is newer. A STOP is
//     one row with no business and one flag on the number's one phones row, never a row per business (DL-864), so a stop
//     given in one business's thread reads the same at every business. Under a business scope K-29's rows for every
//     business are not read (K-29 rule 4), and the flag alone tells the stop;
//   - textsYes: whether the person holds a yes to texts at the business: the person's own K-29 texts row that decides for
//     this contact (K-29 README: the newest of the business's own rows and the rows for every business), not withdrawn;
//     or, with none on file, the person texting in from this number in this turn (their own number, in the thread they
//     opened: S13-19 "Default: the channel they're using"). A K-29 row is written only for a yes words.ts counts: T-307's
//     yes() refuses someone else's word (notFromThem) and a contact that is not theirs (notTheirContact);
//   - mayText: "texts" or "noTexts", with why. A safety line and the stop's one reply are never bound by a stop (RULES
//     4.12, 7.3; arch 02 line 111); how they go is the contact home's and T-307's. Anything else to a stopped number is
//     "noTexts", but a text about a new booking whose fresh yes came from that number (see default 3);
//   - optOutLine: "carry" on the very first text Rosie ever sends a number (K-04 phones.optout_line_delivered_at not set:
//     Q-30's default, Rosie's first reply in a chat the person opened), else "omit";
//   - stopWordEffect: a stop word stops texts at once and never cancels, moves or skips a booked visit; a bare Cancel flags
//     it (RULES 7.4); a charge for work already given stands; and in one case only it does what it answers (default 5).
// Nothing here logs, and what it answers or throws carries ids and labels only, never a number or anyone's words.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The flag and K-29's rows are read side by side and either one stops the number: a flag set with a START row newer,
//      or a STOP row newer than a clear flag, both read as stopped (fail closed: "the row is the record, the flag what
//      limit 8 reads", K-29 README).
//   2. A START decides as K-29's newest row for every business, and it turns back on only a yes the person gave at that
//      business (one of their own rows there that is not withdrawn): it restores texts, it never makes a yes where the
//      person gave none.
//   3. A fresh yes on a new booking lifts a stopped number for that booking only when it is written in this turn, by text,
//      in this number's own turn, for this business and booking, newer than the stop (T-317's stopped.ts default 1: the
//      record does not say who gave an older yes or from where, as limit 8's notKnown). A stop whose time is not known
//      lets no yes past it (T-317 default 2).
//   4. Texting in counts as a yes only while no K-29 row decides for the contact: a withdrawn yes stays withdrawn when
//      they text in (only START or a fresh yes turns it back on: RULES 7.5), and a stopped number's text gets only the
//      guard's one fixed reply (RULES 7.3; T-268), which is a stop reply.
//   5. The one case (RULES 7.4 [lawyer]; S13-32: "Inside a legal cancel period, a stop that replies to the cancel notice
//      counts as the cancel. So does one that replies to a text about that sold work."): only the sold work it answers
//      is cancelled, never a booked visit; whether the stop answers that notice or text, inside its legal cancel period,
//      is the caller's reading (no frozen part holds a legal cancel period yet).
//   6. An email address is never texted (texts go only to a mobile), so it reads "noTexts" here and its way is the
//      contact home's; the opt-out line is a text's.

import type { ConsentRead } from "../../../../db/repo/consent";
import type { Phone } from "../../../../db/repo/phones";
import { SEND_CLASSES, newestDecides, type SendClass } from "../../domain/messages-consent";
import { StopHomeError } from "./errors";

/** A K-29 texts row as the stop home reads it (T-307's ConsentRead, never its words). */
export type TextsRow = Pick<
  ConsentRead,
  | "id"
  | "personId"
  | "businessId"
  | "kind"
  | "revoked"
  | "handleId"
  | "bookingId"
  | "at"
  | "channel"
  | "turnId"
>;

/** A mobile's one phones row across every business, as the stop home reads it (K-04 v1 phones). */
export type StopPhone = Pick<Phone, "handleId" | "stopped" | "stopAt" | "optoutLineDeliveredAt">;

/** One person's contact at one business, as the stop home reads it (reads.ts readStop). */
export interface StopReading {
  readonly personId: string;
  /** The business the text is for; null for Rosie's own texts for no business (an owner's sign-up). */
  readonly businessId: string | null;
  /** The contact, by handle id: never its number or address. */
  readonly handleId: string;
  /** The contact's kind (K-04 handles), or null when no such handle is on file. */
  readonly kind: "phone" | "email" | null;
  /** The contact is one of the person's own (K-04 person_handles). */
  readonly own: boolean;
  /** The mobile's phones row, or null (an email address, or a mobile with no phones row). */
  readonly phone: StopPhone | null;
  /** The K-29 rows read for this contact, of everyone behind it, as the reader's scope shows them, with this turn's. */
  readonly texts: readonly TextsRow[];
}

/** The turn a message answers: its id and the handle whose texts it batches (K-05 v1 turn). */
export interface TurnRef {
  readonly id: string;
  readonly handleId: string;
}

/** One message the stop home rules on. */
export interface StopMessage {
  /** RULES 4.3's send class (K-05 sendClass): a safety line goes past a stop (RULES 4.12). */
  readonly sendClass: SendClass;
  /** The stop's one reply (RULES 7.3; K-01 stopReply). */
  readonly stopReply?: boolean;
  /** The booking it is about, or null. */
  readonly bookingId: string | null;
  /** The turn it answers, or null for a message no turn of theirs asked for (a reminder, a clock's). */
  readonly turn: TurnRef | null;
}

/** Whether one number is stopped for every business (MC C1), and since when. */
export interface NumberStop {
  readonly stopped: boolean;
  /** The stop's time (the later of the flag's stop_at and the STOP row's), or null when not stopped or not known. */
  readonly since: Date | null;
}

/** Why a person does or does not hold a yes to texts at the business (labels). */
export type TextsYesWhy =
  /** Their own K-29 texts row decides for this contact here, and gives a yes. */
  | "standingYes"
  /** No row decides, and they are texting in from this number in this turn. */
  | "textingIn"
  /** The row that decides withdraws texts (a STOP, a work phone's answer, a switch of contact). */
  | "withdrawn"
  /** No yes on file, and they are not texting in from this number. */
  | "none"
  /** Not one of the person's own contacts (K-04 person_handles). */
  | "notTheirs"
  /** An email address or no handle: texts go only to a mobile (default 6). */
  | "notAMobile";

export interface TextsYes {
  readonly yes: boolean;
  readonly why: TextsYesWhy;
  /** The K-29 row that decides, by id, or null. */
  readonly consentId: string | null;
}

/** Whether Rosie may text the number: the stop home's two rulings. */
export const TEXT_RULINGS = ["texts", "noTexts"] as const;
export type TextRuling = (typeof TEXT_RULINGS)[number];

/** Why Rosie may or may not text the number (labels). */
export type MayTextWhy =
  /** A yes stands, and the number is not stopped. */
  | "yes"
  /** Their own text from this number in this turn, and the number is not stopped. */
  | "textingIn"
  /** A safety line or the stop's one reply: never bound by a stop (RULES 4.12, 7.3). */
  | "pastStop"
  /** A stopped number's fresh yes on this booking, from that number in this turn (MC C1; default 3). */
  | "freshYes"
  /** The number is stopped for every business (MC C1). */
  | "stopped"
  /** No yes, and not texting in. */
  | "noYes"
  /** The yes that decides was withdrawn. */
  | "withdrawn"
  /** Not one of the person's own contacts. */
  | "notTheirs"
  /** An email address or no handle (default 6). */
  | "notAMobile";

export interface TextDecision {
  readonly ruling: TextRuling;
  readonly why: MayTextWhy;
}

/** Whether a message carries the opt-out line (RULES 4.3's STOP, HELP and rates line). */
export type OptOutLine = "carry" | "omit";

/** What a stop word answers, as the guard's targets read it (S13-32: "It also does what it answers in one case only"). */
export const STOP_ANSWERS = ["none", "visitText", "soldWorkCancelNotice", "soldWorkText"] as const;
export type StopAnswers = (typeof STOP_ANSWERS)[number];

/** One stop word, as the guard and the safety read give it (labels only, never the words). */
export interface StopWord {
  /** A bare Cancel: CANCEL or CANCELAR alone (RULES 7.4; arch 02 step 3: "CANCEL or CANCELAR also flags the visit"). */
  readonly bareCancel: boolean;
  readonly answers: StopAnswers;
  /** The sold work it answers is inside its legal cancel period (RULES 7.4 [lawyer]). */
  readonly inLegalCancelPeriod: boolean;
}

/** What a stop word does (RULES 7.2 to 7.4; S13-32). */
export interface StopWordEffect {
  /** Rosie's texts to the number stop at once, for every business. */
  readonly texts: "stop";
  /** The booked visit: kept as booked, or flagged for a bare Cancel. Never cancelled, moved or skipped. */
  readonly visit: "keep" | "flag";
  /** A charge for work already given stands. */
  readonly chargeForWorkGiven: "keep";
  /** The sold work it answers: kept, or cancelled in the one case (default 5). A plan is never ended otherwise. */
  readonly soldWork: "keep" | "cancel";
}

// ---- reading checks -------------------------------------------------------------------------------------------------

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isTime(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** A K-29 row as the home reads it; the error names the field, never its value (ids are never parsed: CQ-09). */
function checkRow(row: TextsRow, index: number): void {
  const at = `texts row ${String(index + 1)}`;
  const {
    id,
    personId,
    businessId,
    kind,
    revoked,
    handleId,
    bookingId,
    channel,
    turnId,
  }: Record<string, unknown> = { ...row };
  if (!isId(id) || !isId(personId)) throw new StopHomeError(`${at} has no id or no person`);
  for (const [name, value] of Object.entries({ businessId, handleId, bookingId, turnId }))
    if (value !== null && !isId(value)) throw new StopHomeError(`${at}'s ${name} is not an id`);
  if (typeof kind !== "string" || typeof channel !== "string")
    throw new StopHomeError(`${at} has no kind or no channel`);
  if (typeof revoked !== "boolean") throw new StopHomeError(`${at}'s revoked is not true or false`);
  if (!isTime(row.at)) throw new StopHomeError(`${at}'s time is not a time`);
}

/** The reading as the home reads it: ids, flags and times of the right kind, and a phones row of this contact only. */
function checkReading(reading: StopReading): void {
  const { personId, businessId, handleId, kind, own, phone, texts }: Record<string, unknown> = { ...reading };
  if (!isId(personId)) throw new StopHomeError("the reading names no person");
  if (!isId(handleId)) throw new StopHomeError("the reading names no contact");
  if (businessId !== null && !isId(businessId))
    throw new StopHomeError("the reading's business is not an id");
  if (kind !== "phone" && kind !== "email" && kind !== null)
    throw new StopHomeError("the contact's kind is not a phone or an email");
  if (typeof own !== "boolean") throw new StopHomeError("the reading's own is not true or false");
  if (!Array.isArray(texts)) throw new StopHomeError("the reading's texts rows are not a list");
  reading.texts.forEach(checkRow);
  if (phone === null) return;
  if (kind !== "phone") throw new StopHomeError("a phones row is read for a contact that is not a mobile");
  const {
    handleId: phoneHandle,
    stopped,
    stopAt,
    optoutLineDeliveredAt,
  }: Record<string, unknown> = {
    ...reading.phone,
  };
  if (phoneHandle !== handleId) throw new StopHomeError("the phones row read is not the contact's");
  if (typeof stopped !== "boolean") throw new StopHomeError("the phone's stopped flag is not true or false");
  for (const [name, value] of Object.entries({ stopAt, optoutLineDeliveredAt }))
    if (value !== null && !isTime(value)) throw new StopHomeError(`the phone's ${name} is not a time`);
}

/** The message as the home reads it. */
function checkMessage(message: StopMessage): void {
  const { sendClass, stopReply, bookingId, turn }: Record<string, unknown> = { ...message };
  if (!(SEND_CLASSES as readonly unknown[]).includes(sendClass))
    throw new StopHomeError("the message's send class is not one of RULES 4.3's");
  if (stopReply !== undefined && typeof stopReply !== "boolean")
    throw new StopHomeError("the message's stopReply is not true or false");
  if (bookingId !== null && !isId(bookingId)) throw new StopHomeError("the message's booking is not an id");
  if (turn === null) return;
  const { id, handleId }: Record<string, unknown> = { ...message.turn };
  if (!isId(id) || !isId(handleId)) throw new StopHomeError("the message's turn has no id or no handle");
}

// ---- the rules -------------------------------------------------------------------------------------------------------

/** The contact's K-29 texts rows, of everyone behind it. */
const textsOf = (reading: StopReading): TextsRow[] =>
  reading.texts.filter((row) => row.kind === "texts" && row.handleId === reading.handleId);

/** The later of two times, either of which may be missing. */
function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The number's stop, from its flag and its newest texts row for every business (MC C1; default 1). */
function stopOf(reading: StopReading): NumberStop {
  const flag = reading.phone?.stopped === true;
  const everyBusiness = newestDecides(textsOf(reading).filter((row) => row.businessId === null));
  const byRow = everyBusiness?.revoked === true;
  if (!flag && !byRow) return { stopped: false, since: null };
  const since = later(
    flag ? (reading.phone?.stopAt ?? null) : null,
    byRow ? (everyBusiness?.at ?? null) : null,
  );
  return { stopped: true, since };
}

/** Whether one number is stopped for every business (MC C1), and since when (see the top of this file). */
export function numberStop(reading: StopReading): NumberStop {
  checkReading(reading);
  return stopOf(reading);
}

/** The person's yes at the business, as the home reads it (the reading and message already checked). */
function yesOf(reading: StopReading, message: StopMessage): TextsYes {
  const answer = (yes: boolean, why: TextsYesWhy, consentId: string | null = null): TextsYes => ({
    yes,
    why,
    consentId,
  });
  if (reading.kind !== "phone") return answer(false, "notAMobile");
  if (!reading.own) return answer(false, "notTheirs");
  const { personId, businessId } = reading;
  const theirs = textsOf(reading).filter((row) => row.personId === personId);
  const atBusiness = theirs.filter((row) => businessId !== null && row.businessId === businessId);
  const deciding = newestDecides(
    theirs.filter((row) => row.businessId === businessId || row.businessId === null),
  );
  if (deciding === null) {
    return message.turn?.handleId === reading.handleId ? answer(true, "textingIn") : answer(false, "none");
  }
  if (deciding.revoked) return answer(false, "withdrawn", deciding.id);
  // A START turns back on a yes they gave here; it never makes one where they gave none (default 2).
  const isStart = deciding.businessId === null;
  if (isStart && !atBusiness.some((row) => !row.revoked)) {
    return message.turn?.handleId === reading.handleId ? answer(true, "textingIn") : answer(false, "none");
  }
  return answer(true, "standingYes", deciding.id);
}

/** Whether the person holds a yes to texts at the business (see the top of this file). */
export function textsYes(reading: StopReading, message: StopMessage): TextsYes {
  checkReading(reading);
  checkMessage(message);
  return yesOf(reading, message);
}

/** A safety line or the stop's one reply: never bound by a stop (RULES 4.12, 7.3). */
const pastStop = (message: StopMessage): boolean =>
  message.sendClass === "safety" || message.stopReply === true;

/** Whether a fresh yes on this message's booking, from that number in this turn, lifts a stopped number (default 3). */
function freshYesLifts(reading: StopReading, message: StopMessage, since: Date | null): boolean {
  const { turn, bookingId } = message;
  const { personId, businessId, handleId } = reading;
  if (since === null || turn === null || bookingId === null || businessId === null) return false;
  if (turn.handleId !== handleId) return false;
  return textsOf(reading).some(
    (row) =>
      !row.revoked &&
      row.personId === personId &&
      row.businessId === businessId &&
      row.bookingId === bookingId &&
      row.channel === "text" &&
      row.turnId === turn.id &&
      row.at.getTime() > since.getTime(),
  );
}

/** Whether Rosie may text this person's contact at this business now (see the top of this file). */
export function mayText(reading: StopReading, message: StopMessage): TextDecision {
  checkReading(reading);
  checkMessage(message);
  const texts = (why: MayTextWhy): TextDecision => ({ ruling: "texts", why });
  const noTexts = (why: MayTextWhy): TextDecision => ({ ruling: "noTexts", why });
  if (reading.kind !== "phone") return noTexts("notAMobile");
  if (!reading.own) return noTexts("notTheirs");
  if (pastStop(message)) return texts("pastStop");
  const stop = stopOf(reading);
  if (stop.stopped)
    return freshYesLifts(reading, message, stop.since) ? texts("freshYes") : noTexts("stopped");
  const yes = yesOf(reading, message);
  if (yes.yes) return texts(yes.why === "textingIn" ? "textingIn" : "yes");
  return noTexts(yes.why === "withdrawn" ? "withdrawn" : "noYes");
}

/** Whether a text to the contact carries the opt-out line: only Rosie's very first text to that number (Q-30). */
export function optOutLine(reading: StopReading): OptOutLine {
  checkReading(reading);
  if (reading.kind !== "phone") return "omit";
  return (reading.phone?.optoutLineDeliveredAt ?? null) === null ? "carry" : "omit";
}

/** What a stop word does (see the top of this file): it stops texts and never cancels a visit. */
export function stopWordEffect(word: StopWord): StopWordEffect {
  const { bareCancel, answers, inLegalCancelPeriod }: Record<string, unknown> = { ...word };
  if (typeof bareCancel !== "boolean")
    throw new StopHomeError("the stop word's bareCancel is not true or false");
  if (!(STOP_ANSWERS as readonly unknown[]).includes(answers))
    throw new StopHomeError("what the stop word answers is not one the stop home knows");
  if (typeof inLegalCancelPeriod !== "boolean")
    throw new StopHomeError("the stop word's inLegalCancelPeriod is not true or false");
  const answersSoldWork = answers === "soldWorkCancelNotice" || answers === "soldWorkText";
  return {
    texts: "stop",
    visit: bareCancel ? "flag" : "keep",
    chargeForWorkGiven: "keep",
    soldWork: answersSoldWork && inLegalCancelPeriod ? "cancel" : "keep",
  };
}
