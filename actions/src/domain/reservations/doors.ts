// The saved-time rules the action layer applies (C-134; T-744): which door a save takes, who the time is held for, how
// long it holds, and whether its one extension may be offered. The minutes themselves are K-05's (db/repo/
// reservation-rules.ts doorMinutes, T-198), never written here; so is every refusal the database makes (the cap, EXCLUDE).
//
//   The door (MC C3; K-09 v1.2 saveTime, round 2: DL-162 ruling 4). ownAi, 15 minutes, never extended, is only for the
//   customer's own AI booking a service that books at once with money due before the visit or a card to save; the
//   longer saves of A4-21 (a plan check up to 1 hour, a document up to 24 hours) and Sam's OK up to 30 minutes (A5-08,
//   B5-06) never apply to it ("the 15 minutes are never extended, since D104 lets the time go at 15 minutes"). Every
//   other save, a request the owner OKs included, is the standard door, 10 minutes (S12-01), or the longer door asked for.
//   Who it is held for (DL-171 ruling 1): an agent's save for its agent token, a turn's or a page's for the booker's
//   mobile on file; with none, nothing is held (mobileRequired).
//
//   The one extension (Q-12's default: 10 more minutes, offered once before the hold ends; arch 05 line 247). Never on the
//   ownAi door, and never for a time held for an agent token, whatever door it was saved on: K-04 keeps no door on the row,
//   so C3's 15 minutes cannot be told from an AI's standard save, and every token's hold is refused (DL-171; DL-173
//   ruling 3; K-09 v1.2 extendTime notExtendable). A time held for a mobile is never on the ownAi door (doorOf), so the
//   action layer names the standard door to K-05 extend (K-09 v1.2 extendTime).
//
//   The clock home (S13-35, T-591: B4-23, S12-01 and S12-02 follow it). Its ruling clockEndsBy, visitStart ("No clock
//   runs past the visit"), holds the saved time's clock: a save ends by the visit's start. A door that saves "up to" its
//   limit is cut to end there; a door with fixed minutes that would run past it saves nothing (tooSoon). The home's
//   clockHours ruling is not applied to a saved time (default 2 below).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A longer save asked for (planCheck, document, ownerOk) keeps its one extension, as a standard save does: Q-12 gives
//      every saved time "10 more minutes, offered once", and C3 alone says never.
//   2. A saved time's minutes are elapsed time at any hour, never moved into text hours: they hold a time while someone
//      finishes ("The saved time's 10 minutes keep running", S12-03), not a deadline for a reply; S12-04's one text at the
//      end is limit 8's, at send.
//   3. A save whose fixed minutes would end after the visit's start is refused (tooSoon) rather than cut, since K-05
//      reserve holds the door's own minutes; ending exactly at the start is allowed ("ends by the visit").

import { doorMinutes, type Door, type SavedFor } from "../../../../db/repo/reservation-rules";
import { clockHomeModule } from "../../../../runtime/src/clocks/home";
import type { Asker, DoorFacts, HeldFor, LapsesBy, Reservation } from "./types";

const MINUTE = 60_000;

/** A request the service cannot carry out: it names the field, never a value. Thrown before anything is read. */
export class ReservationRequestError extends TypeError {
  override name = "ReservationRequestError";
}

/** The door a save takes, and the minutes asked for a door that takes them (MC C3; A4-21; DL-162 ruling 4). */
export function doorOf(asker: Asker, facts: DoorFacts): { door: Door; holdMinutes: number | null } {
  if (asker.kind === "agent" && facts.booksAtOnce && facts.moneyBefore) {
    return { door: "ownAi", holdMinutes: null };
  }
  if (facts.longer !== null) {
    return { door: facts.longer.door, holdMinutes: facts.longer.minutes };
  }
  return { door: "standard", holdMinutes: null };
}

/** Who the time is held for (DL-171 ruling 1), or null when a turn's or a page's booker has no mobile on file. */
export function heldForOf(asker: Asker): SavedFor | null {
  if (asker.kind === "agent") return { agentToken: asker.agentToken };
  return asker.mobile === null ? null : { phoneNumber: asker.mobile };
}

/** Who a held row is held for, as a kind: an agent token first, then a mobile, else a booking (K-04 for_someone). */
export function heldForKindOf(row: Pick<Reservation, "forAgentToken" | "forPhoneNumber">): HeldFor {
  if (row.forAgentToken !== null) return "agentToken";
  if (row.forPhoneNumber !== null) return "phoneNumber";
  return "booking";
}

/** Who fires the saved-time clock row (K-05 item 8): the mobile's handle, else the minute sweep. */
export function lapsesByOf(heldFor: SavedFor): LapsesBy {
  return "phoneNumber" in heldFor ? "holdersHandle" : "sweep";
}

/** Whether the one extension may be offered for a save on `door` held for `heldFor` (Q-12; MC C3; DL-171). */
export function extendableOn(door: Door, heldFor: SavedFor): boolean {
  return door !== "ownAi" && "phoneNumber" in heldFor;
}

/** An instant as K-05 takes one: UTC to the whole second (CQ-09), never past the instant given. */
export function utcOf(ms: number): string {
  if (!Number.isFinite(ms)) throw new ReservationRequestError("now is not an instant");
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** The clock home's end for every clock (S13-35): the visit's start. Any other ruling is one this service cannot keep. */
function clockEndsByVisitStart(): void {
  const ruling = clockHomeModule.rule("clockEndsBy", { sentNow: false });
  if (ruling !== "visitStart") {
    throw new Error("the clock home rules a clock end the reservations service does not know");
  }
}

/** How long a save holds: the door's minutes, held by the clock home to end by the visit's start. */
export type HoldLength =
  | { readonly fits: true; readonly minutes: number; readonly holdMinutes: number | null }
  | { readonly fits: false };

/**
 * The minutes a save on `door` holds when saved at `at` for a visit starting at `visitStartsAt` (both UTC): the door's
 * own (K-05 doorMinutes, which refuses minutes the door does not allow with a TypeError), cut to end by the visit's start
 * for a door that saves up to its limit, or nothing for a fixed door that would run past it (defaults 3).
 */
export function holdLengthOf(
  door: Door,
  holdMinutes: number | null,
  at: string,
  visitStartsAt: string,
): HoldLength {
  const minutes = doorMinutes(door, holdMinutes);
  clockEndsByVisitStart();
  const left = Math.floor((Date.parse(visitStartsAt) - Date.parse(at)) / MINUTE);
  if (minutes <= left) return { fits: true, minutes, holdMinutes };
  if (holdMinutes === null || left < 1) return { fits: false };
  return { fits: true, minutes: left, holdMinutes: left };
}
