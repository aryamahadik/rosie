// Limit 8, the check at send (T-259; C-125, C-241; steps S13-02, S13-32; arch 06 line 313; RULES 4.3, 4.1b; DL-012).
//
// `decideLimit8` is pure: a claimed row, its recipient's send state and the clock go in, one decision comes out. The
// dispatcher calls it before each send and carries the decision out (markRow, or the send). In arch 06's order:
//
//   0. A send by an SMS port is refused (refuse-sms-channel.json; DL-012): there is no SMS port. A row on the `sms`
//      channel through the linq port goes like any other, text only (K-07 README; DL-031).
//      Then the row's end, before anything else is read (T-1283; ADR-016 section 3; K-04 v1.1 outbox_rows.not_after, the
//      claim's `notAfter`): no part of a row goes at or after it, so a row tried at or after its end is withdrawn, unsent,
//      at every try, a retry and a late wake included (a sign-in code dies 10 minutes after it is made: RULES 6.2). A code
//      row always has an end (outbox_rows_code_has_not_after): one claimed with none, or an end or a clock that is not a
//      time, ends the row too (fails closed).
//   1. Stopped: only a safety line and a stop reply go, with the opt-out override on the send, at any hour (RULES 4.3,
//      4.12; arch 02 line 125); any other row is dropped, and its question takes step 9's never-delivered path (T-255).
//      A texts yes newer than the stop turns texts back on only when it is the person's own word sent from the number
//      that stopped (T-1099; RULES 7.1, 7.5; S13-32 lines 7213 to 7215, 7242): a START, or a fresh yes for this row's
//      booking. K-05 v1.8's textsConsent says who gave the yes and for which booking (item 47: fromContact and
//      bookingId). A yes the business entered ('1 Yes' by text or on the Today page, which writes a texts row newer
//      than the STOP that K-05 default 35 reads as the covering row), or one whose record does not say who gave it (an
//      answer before v1.8, which has neither field), never does: the row is dropped. A row the person's own yes lifted
//      goes on to the checks below, where a stopped phone's closed chat holds it (K-04 phones_stop_closes_chat).
//      An email row's stop is its address's newest texts consent row, never the phone's stopped flag (T-1283; ADR-016
//      section 3; K-05 item 28: "for an email contact it is the stop record, since only a phone carries the flag"):
//      revoked, every row to the address is dropped, whatever its class (ADR-016 open point 7: fails closed); a send
//      state that holds no texts row read cannot show the stop, so nothing is sent and nothing is marked.
//   2. Not stopped and no open chat: every text row waits, whatever its class (a safety line too) and audience
//      (customer, owner, team), with no text and no clock: Rosie never writes first (RULES 4.1b; MC C9; CQ-37). It is a
//      text rule: an email row skips it and goes on to the checks below (T-1283; ADR-016 section 3).
//   3. A safety line and a stop reply then go at any hour, with no check of versions.
//   4. Stale: a row whose read versions changed is composed again from today's record (S13-57), or withdrawn when its
//      booking or question has closed.
//   5. Text hours: only a routine row waits for them. 9am to 8pm in the visit's zone, else the business's (CQ-05); the
//      owner and team from 8am (RULES 4.3). A reply in the same turn (Q-15's default) and a visit happening now go at
//      any hour. The staging test phone's override opens the hours on staging only (BP 9.4). A sign-in code's row is a
//      quick reply (ADR-016 section 3), so it goes at any hour and, with no business, never reads a zone.
//
// A row with a part already accepted goes whole: once the first part is out, only a stop or the row's end can still
// change the decision (the person must not get half a message, and a stale second part would contradict the first).

import { checkTextHours, minutesOf, type TextWindow } from "./text-hours";
import type { ClaimedRow, MarkRowRequest, SendState, Utc } from "../types";

/** What the dispatcher does with the row now. */
export type Limit8Decision =
  /** Go on and send. `overrideOptout` is set when the recipient is stopped and the row is one a stop does not bind. */
  | { action: "send"; reason: SendReason; overrideOptout: boolean }
  /**
   * Mark the row with this limit-8 outcome and send nothing. `yesRefused` is set when a stopped phone's newest texts row
   * was a yes that did not lift the stop (a label for the span).
   */
  | { action: "mark"; outcome: MarkRowRequest["outcome"]; heldUntil: Utc | null; yesRefused?: YesRefused }
  /** An SMS port: nothing is sent and the row is not marked (no K-05 move exists for it; CQ-55 (1)). */
  | { action: "refuseSms" }
  /** The send state cannot be read as it is (a zone or hours that are not valid): nothing is sent. */
  | { action: "unreadable" };

/** Why a row may go, a label for the span. */
export type SendReason =
  "safety" | "stopReply" | "inHours" | "sameTurn" | "visitNow" | "stagingOverride" | "partOut";

export interface Limit8Input {
  row: ClaimedRow;
  state: SendState;
  now: Utc;
  /** True on staging only (the Worker's ENVIRONMENT var is "staging"): the test phone's override is then honoured. */
  honourOverride: boolean;
  /** Whether a part of this row was accepted already (this run or an earlier one). */
  partOut: boolean;
}

/** RULES 4.3: a customer's text hours start at 9am, the owner's and team's at 8am. */
export const CUSTOMER_OPENS = "09:00";
export const STAFF_OPENS = "08:00";

export const isStopReply = (row: ClaimedRow): boolean => row.finalParts.fixedLines.includes("stopReply");

export const isSafety = (row: ClaimedRow): boolean => row.sendClass === "safety";

/**
 * A send by an SMS port is refused (refuse-sms-channel.json: `port` "sms"; DL-012). A row on the `sms` channel through the
 * `linq` port is Linq's SMS service in the same chat, text only, and goes (K-07 README; DL-031).
 */
export const isSmsPort = (row: ClaimedRow): boolean => row.port === "sms";

/**
 * An email row: on the email channel, by the email port (K-05 v1.2 claimedRow: the email channel goes by the email port,
 * every other channel by linq). A row whose channel and port disagree is no K-05 answer, and is read as a text row, so
 * the text rules, which hold more back, decide it (T-1283).
 */
export const isEmailRow = (row: ClaimedRow): boolean => row.channel === "email" && row.port === "email";

/**
 * Whether the row's end has come (T-1283; ADR-016 section 3; K-05 v1.13 claimedRow.notAfter, K-04 v1.1 not_after): no
 * part of a row is sent at or after its end. A row goes only while the clock reads before its end, so an end or a clock
 * that is not a time ends it. A code row always has an end (K-04 v1.1 outbox_rows_code_has_not_after; K-05's
 * refuse-claimed-code-row-no-not-after), so one claimed with none has ended too: no code goes past its 10 minutes. A row
 * with no end (null, or left out by an answer before v1.13) never ends here.
 */
export function endPassed(row: ClaimedRow, now: Utc): boolean {
  const end = row.notAfter ?? null;
  if (end === null) return row.emailPurpose === "code";
  return !(Date.parse(now) < Date.parse(end));
}

/**
 * An email address's stop (T-1283; ADR-016 section 3): the address's newest texts consent row, as K-05 sendState gives it
 * for the row's recipient ("for an email contact it is the stop record, since only a phone carries the flag": item 28,
 * default 35). Revoked: stopped; a row that does not withdraw, or none: not stopped. Never the phone's stopped flag,
 * which is the number's alone (STATE note 10; K-12 emailWay: the owner's email is where Rosie writes after the owner
 * texts STOP). Null when the send state holds no texts row read at all (a reader that does not give it): not known.
 */
export function emailStopped(state: SendState): boolean | null {
  const newest = state.textsConsent;
  if (newest === undefined) return null;
  return newest === null ? false : newest.revoked;
}

/** Why a stopped phone's newest texts row, a yes, did not lift the stop: a label for the span, never words or numbers. */
export type YesRefused =
  /** The record does not say who gave it, its booking or when the stop came (as before K-05 v1.8): fail closed. */
  | "notKnown"
  /** Not the person's own text from that number: the business's '1 Yes' (by text or on the Today page), a page's. */
  | "notFromContact"
  /** Not newer than the stop. */
  | "notAfterStop"
  /** A fresh yes for another booking, or for none: it turns only its own booking's texts back on (S13-32 line 7242). */
  | "otherBooking";

/** What the newest texts row does to a stopped phone's stop for one row. */
export type YesAfterStop = { lifts: true } | { lifts: false; refused: YesRefused | null };

/**
 * Whether the person's own yes since the stop turns texts back on for this row (T-1099). After a STOP, only START or a
 * fresh yes on a new booking sent from that number does, for that booking (RULES 7.5; S13-32 line 7242): never someone
 * else's word (RULES 7.1; S13-32 line 7214), and the business's word counts only for someone who gave the business their
 * number for this booking (line 7215), which a stop takes back. Every check fails closed: a row the record does not
 * describe in full lifts nothing. `refused` is null when there is no yes to refuse (no row, or the newest withdraws).
 */
export function yesAfterStop(row: ClaimedRow, state: SendState): YesAfterStop {
  const yes = state.textsConsent;
  if (yes === undefined || yes === null || yes.revoked) return { lifts: false, refused: null };
  if (yes.fromContact === undefined) return { lifts: false, refused: "notKnown" };
  if (!yes.fromContact) return { lifts: false, refused: "notFromContact" };
  const stopAt = state.stopAt ?? null;
  if (stopAt === null) return { lifts: false, refused: "notKnown" };
  if (!(Date.parse(yes.at) > Date.parse(stopAt))) return { lifts: false, refused: "notAfterStop" };
  // A START covers every business, and so every row; a fresh yes names its business and its booking.
  if (yes.businessId === null) return { lifts: true };
  if (yes.bookingId === undefined) return { lifts: false, refused: "notKnown" };
  if (yes.bookingId === null || yes.bookingId !== row.bookingId)
    return { lifts: false, refused: "otherBooking" };
  return { lifts: true };
}

/**
 * Whether the recipient's stop stands for this row. A text row: the stopped flag is set and no yes of the person's own
 * lifts it. An email row: its address's newest texts row withdraws texts, or no texts row was read, so the stop is not
 * known and stands (T-1283; fails closed).
 */
export const stopStands = (row: ClaimedRow, state: SendState): boolean =>
  isEmailRow(row) ? emailStopped(state) !== false : state.stopped && !yesAfterStop(row, state).lifts;

/** The row's read versions that moved: any not found in the current versions, or found at another version. */
export function versionsChanged(row: ClaimedRow, state: SendState): boolean {
  return row.versionsRead.some((read) => {
    const now = state.currentVersions.find(
      (current) => current.table === read.table && current.rowId === read.rowId,
    );
    return now?.version !== read.version;
  });
}

/** The window the recipient's text hours give, or null when the business's hours are not valid times. */
function windowFor(state: SendState): TextWindow | null {
  const open = minutesOf(state.textHours.start);
  const close = minutesOf(state.textHours.end);
  if (open === null || close === null) return null;
  const floor = minutesOf(state.audience === "customer" ? CUSTOMER_OPENS : STAFF_OPENS);
  if (floor === null) return null;
  // The business's own hours can narrow the window but never open it before the rule's hour for the recipient.
  return { startMinutes: Math.max(open, floor), endMinutes: close };
}

export function decideLimit8(input: Limit8Input): Limit8Decision {
  const { row, state, now } = input;
  if (isSmsPort(row)) return { action: "refuseSms" };

  // The row's end, before anything else: at or after it no part goes, at any try (T-1283; ADR-016 section 3).
  if (endPassed(row, now)) return { action: "mark", outcome: "withdrawn", heldUntil: null };

  const email = isEmailRow(row);
  if (email) {
    // An email address's stop is its newest texts row, never the phone's flag (T-1283; ADR-016 section 3): revoked, any
    // row to it is dropped, whatever its class. With no texts row read the stop is not known: nothing is sent or marked.
    const stopped = emailStopped(state);
    if (stopped === null) return { action: "unreadable" };
    if (stopped) return { action: "mark", outcome: "droppedStopped", heldUntil: null };
  } else if (state.stopped) {
    // A stopped phone: only a safety line and a stop reply go, with the opt-out override (STOP clears chat_open), unless
    // the person's own yes from that number since the stop turned this row's texts back on (T-1099).
    if (isSafety(row)) return { action: "send", reason: "safety", overrideOptout: true };
    if (isStopReply(row)) return { action: "send", reason: "stopReply", overrideOptout: true };
    const yes = yesAfterStop(row, state);
    if (!yes.lifts) {
      return {
        action: "mark",
        outcome: "droppedStopped",
        heldUntil: null,
        ...(yes.refused === null ? {} : { yesRefused: yes.refused }),
      };
    }
  }
  if (input.partOut) return { action: "send", reason: "partOut", overrideOptout: false };

  // Rosie never writes first, to anyone (MC C9): a phone not stopped and with no open chat has not texted Rosie, so every
  // row waits, whatever its class (a safety line too) and its audience (customer, owner, team). A text rule: an email row
  // goes on to the checks after it (T-1283; ADR-016 section 3; RULES 4.1b is about iMessage).
  if (!email && !state.chatOpen) return { action: "mark", outcome: "waitingChat", heldUntil: null };

  if (isSafety(row)) return { action: "send", reason: "safety", overrideOptout: false };
  if (isStopReply(row)) return { action: "send", reason: "stopReply", overrideOptout: false };

  if (versionsChanged(row, state)) {
    const closed =
      (row.bookingId !== null && state.closed.booking) ||
      (row.openQuestionId !== null && state.closed.question);
    return { action: "mark", outcome: closed ? "withdrawn" : "stale", heldUntil: null };
  }

  // Only these two classes skip the hours; a class K-07 does not name is held to them like a routine row.
  if (row.sendClass === "quick_reply") return { action: "send", reason: "sameTurn", overrideOptout: false };
  if (row.sendClass === "visit_now") return { action: "send", reason: "visitNow", overrideOptout: false };

  if (input.honourOverride && state.textHoursOverride) {
    return { action: "send", reason: "stagingOverride", overrideOptout: false };
  }

  const window = windowFor(state);
  const zone = state.visitZone ?? state.businessZone;
  let verdict;
  try {
    if (window === null) return { action: "unreadable" };
    verdict = checkTextHours(Date.parse(now), zone, window);
  } catch {
    return { action: "unreadable" };
  }
  if (verdict.inside) return { action: "send", reason: "inHours", overrideOptout: false };
  return { action: "mark", outcome: "held", heldUntil: verdict.notBefore };
}
