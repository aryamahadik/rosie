// Limit 5, Reserved (C-085, T-303; arch 06 line 307): "Passes when: a reservation row reserves the worker, room, vehicle
// or seat. On failure: the next open times. No pick in 10 minutes on the page, or 2 of their text hours otherwise: nothing
// booked (A6-11)." K-09 v1 limit5Outcome: nextOpenTimes (ask), nothingBooked (refuse).
//
// For one gated part, in this order:
//   1. What it books: pass_on and hand_off book nothing (notChecked). A choose or enter books the saved times the walk
//      after its choice confirms (the BookedTimes port: K-05 v1 writes.reservations.confirm). None, and its choice books a
//      time (its stakes name booked: K-02 v1 stakesReason): no saved time holds it, so it fails (noSavedTime: default 2).
//      None otherwise: it books no time (notChecked).
//   2. Each saved time it books must still hold it, as K-05 v1's commit checks a confirm (item 1: "a reservation that is
//      not held, or is held past its held_until, refuses the commit with reservationLost"), read now on the call's own
//      transaction: found in the call's business scope, at the part's business, held, its saved time not yet ended at the
//      gate's now, and held for this part (default 3): for the part's booking when it names one, else for the mobile the
//      turn's text came from. A time held for someone else is never this part's, so two turns can never book one held
//      time: only the holder's part passes (S12-01: "the first to confirm books; the other gets the next times or a place
//      in line").
//   3. On failure: the next open times (C-131's search through the OpenTimesFinder port), soonest first, with the window
//      to pick one (window.ts): 10 minutes on the page, else 2 of their text hours, ending before the visit. With no open
//      time to offer, nothing is booked (nothingBooked: default 5).
//
// A saved time can still be let go between this read and the commit. K-05 v1's commitTurn then refuses the whole commit
// with reservationLost, and gateAndCommit gates the turn once more (actions/src/commit, T-305: "a version or reservation
// conflict reloads once and gates again"), when this read finds it let go and gives the next open times: K-09 v1 README
// "A K-05 v1 ... reservationLost from the commit is turned into ... limit 5's outcome for the parts it touches, never
// returned as an error".
//
// What the outcome writes (the next times' question, its clock, the message) is the commit's (K-09 v1 limitNOutcome;
// T-305 default 8): decideReserved says what, and the limit hands the gate its K-09 outcome. Nothing here logs; what it
// returns names ids, states, times and labels, never a person's words, a phone number or an agent token.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Until the walk after a choice names its saved times here (C-100, C-133; no K-05 read names a booking's
//      reservations yet), a part whose choice may book or move a time (stakes booked, moveRow or unknown) fails the whole
//      call closed (notBuilt: facts.ts WALK_NOT_BUILT), and any other part books no saved time.
//   2. A part whose choice books a time (stakes booked) and that names no saved time fails limit 5 (noSavedTime): "a
//      reservation row reserves the worker, room, vehicle or seat".
//   3. Held for this part: a saved time for a booking holds only a part on that booking; one for a mobile holds only a
//      part in a turn whose text came from that mobile (K-02 v1 writer.handle); one for an agent token holds no part until
//      the Agent API names the caller's token (K-09 v1's caller names none; K-20, T-328), as limit 3 refuses an unbound
//      AI's yes. A page's call therefore books only a time saved for its booking.
//   4. The window ends no later than the start of the soonest time offered (window.ts; S13-35), and its text hours are
//      the person's, in the zone of the text that carries the part's quote (K-02 v1 text.sentAt.zone; CQ-05), from 8am
//      for the owner, an admin or staff at the part's business, else 9am, to 8pm (RULES 4.3). A caller that is not a page
//      (a turn, an outside AI) takes the text window: arch 06 line 307's "otherwise".
//   5. No open time to offer (C-131 finds none after the lost time): nothingBooked, as A6-13's "OK, nothing was booked"
//      ends A6-11's "C, or no reply". Open times that start at or before the gate's now are never offered; the rest are
//      offered soonest first, each once.

import type { Choice, Context, GatePart, GateTurn } from "../framework";
import type {
  Limit5Outcome,
  LostTime,
  LostWhy,
  NextOpenTimes,
  NotHeldWhy,
  NothingBooked,
  OpenTime,
  ReservedDecision,
  ReservedPorts,
  SavedTime,
} from "./types";
import { pickWindowOf } from "./window";

/** The next open times (K-09 v1: ask). */
export function nextOpenTimesOutcome(): Limit5Outcome {
  return { limit: 5, outcome: "ask", action: "nextOpenTimes" };
}

/** No pick in time, or nothing to pick: nothing booked (K-09 v1: refuse). */
export function nothingBookedOutcome(): Limit5Outcome {
  return { limit: 5, outcome: "refuse", action: "nothingBooked" };
}

/** The stakes reason of a choice that books a time (K-02 v1 stakesReason booked: a recordWrite of the gives key booked). */
export const BOOKS_REASON = "booked";

/** Whether a choice books a time (default 2). */
export function booksATime(choice: Choice): boolean {
  return choice.stakesFrom.some((reason) => reason.why === BOOKS_REASON);
}

/** The roles whose text hours open at 8am: the owner and team (RULES 4.3; K-02 v1 person roles). */
export const TEAM_ROLES: readonly string[] = ["owner", "admin", "staff"];

const PASS: ReservedDecision = { result: "pass" };
const NOT_CHECKED: ReservedDecision = { result: "notChecked" };
const NOTHING_BOOKED: NothingBooked = { kind: "nothingBooked" };

/** Whether a saved time's end comes after `now` (both UTC); a missing or unreadable time never does. */
function endsAfter(heldUntil: string | null, now: string): boolean {
  if (heldUntil === null) return false;
  const ends = Date.parse(heldUntil);
  const at = Date.parse(now);
  return Number.isFinite(ends) && Number.isFinite(at) && ends > at;
}

/** Whether a held saved time is held for this part (default 3). */
function heldFor(row: SavedTime, choice: Choice, turn: GateTurn): boolean {
  if (row.bookingId !== null) return choice.target.bookingId === row.bookingId;
  if (row.forPhoneNumber !== null) {
    return turn.request.caller.kind === "turn" && turn.context.writer.handle === row.forPhoneNumber;
  }
  return false;
}

/** Why one saved time does not hold the part, or null when it does (step 2). */
export function notHeldWhy(row: SavedTime | null, choice: Choice, turn: GateTurn): LostWhy | null {
  if (row === null) return "notFound";
  if (row.businessId !== turn.businessId || row.businessId !== choice.target.businessId)
    return "otherBusiness";
  if (row.state !== "held") return row.state;
  if (!endsAfter(row.heldUntil, turn.request.now)) return "pastEnd";
  return heldFor(row, choice, turn) ? null : "notTheirs";
}

function lostTimeOf(id: string, why: LostWhy, row: SavedTime | null): LostTime {
  return {
    id,
    why,
    state: row?.state ?? null,
    heldUntil: row?.heldUntil ?? null,
    releasedWhy: row?.releasedWhy ?? null,
    reserved:
      row === null
        ? null
        : {
            businessId: row.businessId,
            resourceId: row.resourceId,
            during: { start: row.during.start, end: row.during.end },
          },
  };
}

/** The saved times as K-05 v1's reservationLost lists them: id, state, end and why released (those it found). */
export function asReservationLost(lost: readonly LostTime[]): {
  id: string;
  state: SavedTime["state"];
  heldUntil: string | null;
  releasedWhy: SavedTime["releasedWhy"];
}[] {
  return lost.flatMap((time) =>
    time.state === null
      ? []
      : [{ id: time.id, state: time.state, heldUntil: time.heldUntil, releasedWhy: time.releasedWhy }],
  );
}

/** Open times that start after `now`, each once, soonest first (a tie by resource id, compared, never parsed). */
export function soonestFirst(times: readonly OpenTime[], now: string): OpenTime[] {
  const at = Date.parse(now);
  const seen = new Set<string>();
  const offered: OpenTime[] = [];
  for (const time of times) {
    const start = Date.parse(time.during.start);
    const end = Date.parse(time.during.end);
    const key = JSON.stringify([time.resourceId, time.during.start, time.during.end]);
    if (!(start > at) || !(end > start) || seen.has(key)) continue;
    seen.add(key);
    offered.push({ resourceId: time.resourceId, during: { start: time.during.start, end: time.during.end } });
  }
  return offered.sort((a, b) => {
    const byStart = Date.parse(a.during.start) - Date.parse(b.during.start);
    if (byStart !== 0) return byStart;
    return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
  });
}

type Text = Context["texts"][number];

/** The text that carries the part's quote (the gate's checks found it there), else the turn's first text. */
function textOf(context: Context, quote: string): Text {
  return context.texts.find((text) => text.words.includes(quote)) ?? context.texts[0];
}

/** Whether the person the call acts for is the owner, an admin or staff at the part's business (default 4). */
function isTeam(turn: GateTurn, businessId: string): boolean {
  const { personId } = turn.request.caller;
  const person = turn.context.writer.people.find((each) => each.personId === personId);
  return (person?.roles ?? []).some(
    (role) => role.businessId === businessId && TEAM_ROLES.includes(role.role),
  );
}

/** The next open times and their window, or nothing booked when there is none (step 3). */
async function failure(
  why: NotHeldWhy,
  lost: readonly LostTime[],
  part: GatePart,
  choice: Choice,
  turn: GateTurn,
  ports: ReservedPorts,
): Promise<ReservedDecision> {
  const { now } = turn.request;
  const times = soonestFirst(await ports.openTimes.nextOpenTimes({ part, turn, lost }), now);
  const [soonest] = times;
  if (soonest === undefined) {
    return { result: "fail", why, lost, outcome: nothingBookedOutcome(), next: NOTHING_BOOKED };
  }
  const next: NextOpenTimes = {
    kind: "nextOpenTimes",
    times,
    window: pickWindowOf({
      via: turn.request.caller.kind === "page" ? "page" : "text",
      now,
      soonest: soonest.during.start,
      zone: textOf(turn.context, part.part.quote).sentAt.zone,
      team: isTeam(turn, choice.target.businessId),
    }),
  };
  return { result: "fail", why, lost, outcome: nextOpenTimesOutcome(), next };
}

/** Limit 5 on one agreed part: pass, notChecked, or the failure with what the commit runs next. */
export async function decideReserved(
  part: GatePart,
  turn: GateTurn,
  ports: ReservedPorts,
): Promise<ReservedDecision> {
  const { part: said, choice } = part;
  if (said.verb === "pass_on" || said.verb === "hand_off") return NOT_CHECKED;
  if (choice === null) throw new TypeError("limit 5 got a choose or enter part without its offered choice");

  // 1. What it books.
  const ids = [...new Set(await ports.bookedTimes.savedTimesOf(part, turn))];
  if (ids.length === 0) {
    return booksATime(choice) ? failure("noSavedTime", [], part, choice, turn, ports) : NOT_CHECKED;
  }

  // 2. Each saved time it books still holds it, read now.
  const reader = ports.reservations();
  const lost: LostTime[] = [];
  for (const id of ids) {
    const row = await reader.reservation(id);
    const why = notHeldWhy(row, choice, turn);
    if (why !== null) lost.push(lostTimeOf(id, why, row));
  }
  const [first] = lost;
  if (first === undefined) return PASS;

  // 3. The next open times, or nothing booked.
  return failure(first.why, lost, part, choice, turn, ports);
}
