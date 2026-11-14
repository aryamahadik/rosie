// The contact home (T-588; C-102; S13-19, with Master Corrections C2 and C9): one reach card, every message the person's
// way, reply clocks only once they were reached, and the handling line on private bookings.
//
// S13-19 as the bundle compiles it: "One card before the first message asks how to reach them. Every message after goes
// that way, and only to them." "The card asks for a mobile (an email is optional), and the way: texts, texts only, or
// email." "Default: the channel they're using." "Booked by the business with no clear yes to messages (A3-30): they get
// none. Only after the business adds their later yes to texts does Rosie text them." "Email: everything goes by email."
// "A reply clock starts only once they were reached their way. No fee follows silence to a message they couldn't get."
// "Nothing else is texted to that mobile until it texts in. No clock or fee runs on a message they didn't get."
//
// contactWay reads a person as the messages-and-consent service gives them (T-307 reach: the reach card on file; each
// mobile with its open chat, stopped flag, chat thread and K-29 texts standing; each email address with its standing)
// and one message (who it is for, its send class, whether it is the stop's one reply, the handle it answers, and the
// booking it is about as its record reads), and answers:
//   - the way it goes: "text" into the chat the mobile opened with Rosie's number (iMessage first, arch 02 line 125, on
//     the service Linq reports for that chat, which the messages service carries: DL-031, T-307 default 2), else
//     "email" (MC C2: an email stays optional and gets every message; MC C9: a text that would open a thread goes by
//     email), else "none". Never SMS and never first: no answer names a channel or an SMS port (DL-012), and a mobile
//     whose chat is not open gets no text (MC C9; RULES 4.1b). Never a call: calls only is never offered (MC C2; Q-07)
//     and its lines are unreachable (C-237), so a card or a booking that says calls only is refused. Texts only works
//     like texts while there is no voice (Q-07). No line-type lookup (N-4): a mobile is what the card and K-04 say.
//   - the contacts that carry it, and every contact the way asked for that carries nothing, with why (told to the
//     caller, never sent);
//   - whether a reply clock may start: "onceReached" when it goes their way, "never" when it goes nowhere;
//     replyClockMayStart then starts it only on a delivery on the way's own contact;
//   - the handling line, on an owner or staff message about a private booking (record.ts).
//
// A STOP or a withdrawn yes binds the contact it covers, whatever the way (K-29: the newest texts row for that contact
// decides; K-04 phones.stopped for a mobile): past it go only a safety line and the stop's one reply (RULES 4.12, 7.3;
// arch 02 line 111), into the chat that mobile once opened (it texted Rosie's number, so its chat thread exists: Rosie
// never writes first, MC C9), and nothing to an email address whose newest texts row is withdrawn (limit 8 at send
// fails closed there too: ADR-016 open point 7).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. With no reach card on file, the message goes back on the handle the person is writing from, and with none it
//      goes nowhere (T-307 default 1; S13-19 "Default: the channel they're using").
//   2. A business-added booking's "yes to messages" (A3-30) is a K-29 texts row for one of the person's contacts at this
//      business that is not withdrawn, on a contact that is not a stopped mobile; once there is one, their messages go
//      their way. A stopped mobile holds no yes, whatever its texts row says: a STOP's row covers every business and has
//      no business, so the call's business scope never reads it (K-29 rule 4), and the stopped flag is what tells it (T-307
//      Mobile.texts; K-29 README: a STOP is a withdrawal row, and the newest row decides). Only START (which clears the
//      flag) or a fresh yes turns texts back on (RULES 7.5); a fresh yes after a STOP is the stop home's (T-590) and limit
//      8's. A safety line and the stop's one reply are not messages about the booking and go past this rule, as past a
//      stop (S13-10: safety beats everything).
//   3. A reply clock starts only on a delivery on the way's own contact (the open chat for the text way, the address for
//      the email way); an email copy of a text delivered alone starts none: the safe side of "only once they were
//      reached their way".
//   4. The stop's one reply goes back on the handle the stop came from, whatever the card says, with no email copy (T-307
//      default 3; RULES 7.3).

import {
  REACH_WAYS,
  SEND_CLASSES,
  type Reach,
  type SendClass,
  type TextsStanding,
} from "../../domain/messages-consent";
import { bookingValue, readingProblem, type RecordReading } from "../../finalize/slots/record";
import { ContactHomeError, handlingLineFor, type ContactRecord, type HandlingLine } from "./record";

/** Who a message is for: the customer it reaches, or the business's owner or a staff member. */
export const AUDIENCES = ["customer", "owner", "staff"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** How a message goes: a text into the chat the mobile opened, an email, or not at all. Never SMS, never a call. */
export const MESSAGE_WAYS = ["text", "email", "none"] as const;
export type MessageWay = (typeof MESSAGE_WAYS)[number];

/** Whether a reply clock may start on the message: once they were reached their way, or never (it reaches nobody). */
export type ReplyClock = "onceReached" | "never";

/** One message the contact home rules on. */
export interface ContactMessage {
  readonly audience: Audience;
  /** RULES 4.3's send class (K-05 sendClass): a safety line goes past a stop (RULES 4.12). */
  readonly sendClass: SendClass;
  /** The stop's one reply (RULES 7.3; K-01 stopReply): back on the handle the stop came from (default 4). */
  readonly stopReply?: boolean;
  /** The handle the person is writing from, when the message answers them (default 1); one of their own. */
  readonly via?: string | null;
  /**
   * The booking the message is about, as its record reads (T-310's RecordReading: the booking values privacy, madeby
   * and reach, and the record's rows), or null for a message about no booking.
   */
  readonly booking: RecordReading | null;
}

/** Why a contact carries nothing. */
export type HeldWhy =
  /** A mobile that is not stopped and whose chat is not open: Rosie never writes first (MC C9; RULES 4.1b). */
  | "chatNotOpen"
  /** A stopped mobile: only a safety line or the stop's one reply, into a chat it once opened (RULES 7.2, 7.3; MC C1). */
  | "stopped"
  /** The contact's newest K-29 texts row withdraws its yes: as a stop for that contact (RULES 7.5, 9.1). */
  | "revoked"
  /** The way is texts and no mobile is on file (MC C2: a mobile is required). */
  | "noMobile"
  /** The way is email and no email address is on file, or the contact named is not an address. */
  | "noEmail"
  /** Nothing to reach them by: no way on the card, or no card and no handle they are writing from (S13-19). */
  | "noContact"
  /** A contact that is not one of the person's own: a message reaches only them (S13-19). */
  | "notTheirs"
  /** A booking the business added, with no yes to messages: they get none (S13-19; A3-30; default 2). */
  | "noYes";

export interface Held {
  /** The medium it would have gone by, or null for a reason that holds the whole message. */
  readonly medium: "text" | "email" | null;
  /** The contact, by handle id, or null when there was none. */
  readonly handleId: string | null;
  readonly why: HeldWhy;
}

/** The contact home's answer for one message to one person. */
export interface ContactDecision {
  readonly way: MessageWay;
  /** The mobile whose open chat carries the text, by handle id, or null. */
  readonly text: string | null;
  /** The address that carries the message (the email way, or a text that cannot go) or its copy, by handle id, or null. */
  readonly email: string | null;
  /** Every contact the way asked for that carries nothing, with why. */
  readonly held: readonly Held[];
  readonly replyClock: ReplyClock;
  /** The line an owner or staff message about a private booking carries, or null (record.ts). */
  readonly handling: HandlingLine | null;
}

/** A delivery of the message on one contact (a delivery receipt: K-07; arch 02 step 9). */
export interface Reached {
  readonly handleId: string;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Calls only is never offered (MC C2; Q-07), and S13-19's calls-only lines are unreachable (C-237). */
const CALLS_ONLY_REFUSED =
  "calls only is never offered (MC C2; Q-07), and S13-19's calls-only lines are unreachable (C-237)";

/** The message as the home reads it; the error names the argument, never its value (ids are never parsed: CQ-09). */
function checkMessage(message: ContactMessage): void {
  const { audience, sendClass, stopReply, via }: Record<string, unknown> = { ...message };
  if (!(AUDIENCES as readonly unknown[]).includes(audience))
    throw new ContactHomeError("the message's audience is not a customer, an owner or staff");
  if (!(SEND_CLASSES as readonly unknown[]).includes(sendClass))
    throw new ContactHomeError("the message's send class is not one of RULES 4.3's");
  if (stopReply !== undefined && typeof stopReply !== "boolean")
    throw new ContactHomeError("the message's stopReply is not true or false");
  if (via !== undefined && via !== null && !isId(via))
    throw new ContactHomeError("the message's via is not a handle id");
  if (message.booking === null) return;
  const problem = readingProblem(message.booking);
  if (problem !== null) throw new ContactHomeError("the booking's record cannot be read", [problem]);
  if (bookingValue(message.booking, "reach") === "callsonly") throw new ContactHomeError(CALLS_ONLY_REFUSED);
}

/** The person as T-307 reads them: an id, lists of contacts and a card whose way the card offers (never calls only). */
function checkPerson(person: Reach): void {
  const { personId, mobiles, emails, card }: Record<string, unknown> = { ...person };
  if (!isId(personId)) throw new ContactHomeError("the person has no id");
  if (!Array.isArray(mobiles) || !Array.isArray(emails))
    throw new ContactHomeError("the person's contacts are not lists");
  if (card === null) return;
  const { way, mobileHandleId, emailHandleId }: Record<string, unknown> = { ...person.card };
  if (way !== null && !(REACH_WAYS as readonly unknown[]).includes(way))
    throw new ContactHomeError(
      `the reach card's way is not texts, texts only or email: ${CALLS_ONLY_REFUSED}`,
    );
  for (const handle of [mobileHandleId, emailHandleId])
    if (handle !== null && !isId(handle))
      throw new ContactHomeError("the reach card names a contact that is not a handle id");
}

/** A safety line or the stop's one reply: the only messages a stop or a withdrawn yes lets through. */
const pastStop = (message: ContactMessage): boolean =>
  message.sendClass === "safety" || message.stopReply === true;

/** A contact's K-29 texts row at this business that is not withdrawn. */
const standingYes = (texts: TextsStanding | null): boolean => texts !== null && !texts.revoked;

/**
 * Whether one of the person's contacts holds a yes to messages at this business (default 2): a K-29 texts row not
 * withdrawn, on an email address or on a mobile that is not stopped. A stopped mobile's texts row can still show the yes
 * its STOP withdrew, since the STOP's row has no business and the business scope never reads it: `stopped` tells it.
 */
const holdsYes = (person: Reach): boolean =>
  person.mobiles.some((mobile) => !mobile.stopped && standingYes(mobile.texts)) ||
  person.emails.some((email) => standingYes(email.texts));

/** The mobile a text goes to, or null with why it does not. */
function textTo(person: Reach, handleId: string, message: ContactMessage, held: Held[]): string | null {
  const mobile = person.mobiles.find((each) => each.handleId === handleId);
  if (mobile === undefined) {
    const why = person.emails.some((each) => each.handleId === handleId) ? "noMobile" : "notTheirs";
    held.push({ medium: "text", handleId, why });
    return null;
  }
  if (mobile.stopped || mobile.texts?.revoked === true) {
    if (pastStop(message) && mobile.chatThreadId !== null) return handleId;
    held.push({ medium: "text", handleId, why: mobile.stopped ? "stopped" : "revoked" });
    return null;
  }
  if (mobile.chatOpen) return handleId;
  held.push({ medium: "text", handleId, why: "chatNotOpen" });
  return null;
}

/** The address an email goes to, or null with why it does not. */
function emailTo(person: Reach, handleId: string, held: Held[]): string | null {
  const email = person.emails.find((each) => each.handleId === handleId);
  if (email === undefined) {
    const why = person.mobiles.some((each) => each.handleId === handleId) ? "noEmail" : "notTheirs";
    held.push({ medium: "email", handleId, why });
    return null;
  }
  if (email.texts?.revoked === true) {
    held.push({ medium: "email", handleId, why: "revoked" });
    return null;
  }
  return handleId;
}

/** The way and contacts the person's card gives, else the handle they are writing from (default 1). */
interface Contacts {
  readonly way: "text" | "email";
  readonly mobile: string | null;
  readonly email: string | null;
}

function contactsOf(person: Reach, message: ContactMessage, held: Held[]): Contacts | null {
  const via = message.via ?? null;
  // The stop's one reply answers the stop where it came from, whatever the card says (default 4).
  const card = message.stopReply === true ? null : person.card;
  if (card !== null) {
    if (card.way === null) {
      held.push({ medium: null, handleId: null, why: "noContact" });
      return null;
    }
    if (card.way === "email") return { way: "email", mobile: null, email: card.emailHandleId };
    return { way: "text", mobile: card.mobileHandleId, email: card.emailHandleId };
  }
  if (via === null) {
    held.push({ medium: null, handleId: null, why: "noContact" });
    return null;
  }
  if (person.mobiles.some((each) => each.handleId === via)) return { way: "text", mobile: via, email: null };
  if (person.emails.some((each) => each.handleId === via)) return { way: "email", mobile: null, email: via };
  held.push({ medium: null, handleId: via, why: "notTheirs" });
  return null;
}

/** The line an owner or staff message about a private booking carries, or null. */
function handlingOf(record: ContactRecord, message: ContactMessage): HandlingLine | null {
  if (message.audience === "customer" || message.booking === null) return null;
  if (bookingValue(message.booking, "privacy") !== "private") return null;
  return handlingLineFor(record, message.booking);
}

/** The contact home's answer: how one message to one person goes (see the top of this file). */
export function contactWay(person: Reach, message: ContactMessage, record: ContactRecord): ContactDecision {
  checkMessage(message);
  checkPerson(person);
  const handling = handlingOf(record, message);
  const held: Held[] = [];
  const nowhere = (): ContactDecision => ({
    way: "none",
    text: null,
    email: null,
    held,
    replyClock: "never",
    handling,
  });

  const shopAdded =
    message.audience === "customer" &&
    message.booking !== null &&
    bookingValue(message.booking, "madeby") === "shop";
  if (shopAdded && !pastStop(message) && !holdsYes(person)) {
    held.push({ medium: null, handleId: null, why: "noYes" });
    return nowhere();
  }

  const contacts = contactsOf(person, message, held);
  if (contacts === null) return nowhere();

  let text: string | null = null;
  if (contacts.way === "text") {
    if (contacts.mobile === null) held.push({ medium: "text", handleId: null, why: "noMobile" });
    else text = textTo(person, contacts.mobile, message, held);
  }
  // The stop's one reply has only the handle it answers, so it gets no email copy (default 4).
  let email: string | null = null;
  if (contacts.email !== null) email = emailTo(person, contacts.email, held);
  else if (contacts.way === "email") held.push({ medium: "email", handleId: null, why: "noEmail" });

  const way: MessageWay = text !== null ? "text" : email !== null ? "email" : "none";
  if (way === "none") return nowhere();
  return { way, text, email, held, replyClock: "onceReached", handling };
}

/**
 * Whether a reply clock may start on a message the contact home ruled on: only once it reached them their way, on the
 * way's own contact (the open chat for the text way, the address for the email way: default 3), never for a message
 * that goes nowhere (S13-19: "No clock or fee runs on a message they didn't get").
 */
export function replyClockMayStart(decision: ContactDecision, reached: Reached | null): boolean {
  if (decision.replyClock === "never" || reached === null) return false;
  const carrier = decision.way === "text" ? decision.text : decision.way === "email" ? decision.email : null;
  return carrier !== null && reached.handleId === carrier;
}
