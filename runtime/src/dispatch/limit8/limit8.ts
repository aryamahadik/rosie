// Limit 8, the check at send (T-259; C-125, C-241; steps S13-02, S13-32; arch 06 line 313; RULES 4.3, 4.1b; DL-012).
//
// `decideLimit8` is pure: a claimed row, its recipient's send state and the clock go in, one decision comes out. The
// dispatcher calls it before each send and carries the decision out (markRow, or the send). In arch 06's order:
//
//   0. A send by an SMS port is refused (refuse-sms-channel.json; DL-012): there is no SMS port. A row on the `sms`
//      channel through the linq port goes like any other, text only (K-07 README; DL-031).
//   1. Stopped: only a safety line and a stop reply go, with the opt-out override on the send, at any hour (RULES 4.3,
//      4.12; arch 02 line 125); any other row is dropped, and its question takes step 9's never-delivered path (T-255).
//   2. Not stopped and no open chat: every row waits, whatever its class (a safety line too) and audience (customer,
//      owner, team), with no text and no clock: Rosie never writes first (RULES 4.1b; MC C9; CQ-37).
//   3. A safety line and a stop reply then go at any hour, with no check of versions.
//   4. Stale: a row whose read versions changed is composed again from today's record (S13-57), or withdrawn when its
//      booking or question has closed.
//   5. Text hours: only a routine row waits for them. 9am to 8pm in the visit's zone, else the business's (CQ-05); the
//      owner and team from 8am (RULES 4.3). A reply in the same turn (Q-15's default) and a visit happening now go at
//      any hour. The staging test phone's override opens the hours on staging only (BP 9.4).
//
// A row with a part already accepted goes whole: once the first part is out, only a stop can still change the
// decision (the person must not get half a message, and a stale second part would contradict the first).

import { checkTextHours, minutesOf, type TextWindow } from "./text-hours";
import type { ClaimedRow, MarkRowRequest, SendState, Utc } from "../types";

/** What the dispatcher does with the row now. */
export type Limit8Decision =
  /** Go on and send. `overrideOptout` is set when the recipient is stopped and the row is one a stop does not bind. */
  | { action: "send"; reason: SendReason; overrideOptout: boolean }
  /** Mark the row with this limit-8 outcome and send nothing. */
  | { action: "mark"; outcome: MarkRowRequest["outcome"]; heldUntil: Utc | null }
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

  // A stopped phone: only a safety line and a stop reply go, with the opt-out override (STOP clears chat_open).
  if (state.stopped) {
    if (isSafety(row)) return { action: "send", reason: "safety", overrideOptout: true };
    if (isStopReply(row)) return { action: "send", reason: "stopReply", overrideOptout: true };
    return { action: "mark", outcome: "droppedStopped", heldUntil: null };
  }
  if (input.partOut) return { action: "send", reason: "partOut", overrideOptout: false };

  // Rosie never writes first, to anyone (MC C9): a phone not stopped and with no open chat has not texted Rosie, so every
  // row waits, whatever its class (a safety line too) and its audience (customer, owner, team).
  if (!state.chatOpen) return { action: "mark", outcome: "waitingChat", heldUntil: null };

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
