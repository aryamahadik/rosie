// The reservations service (T-744; C-100, C-134; arch 02 diagram line 105, "Reservations"; arch 05 line 247): saved times
// as reservation rows that limit 5 checks (T-303), with the saved-time rules the action layer applies (doors.ts).
//
// One service serves one call, under its business (the Tool API's scoped transaction, pg.ts reservationDataIn, or the
// client, reservationDataOn), and reads its now from the clock it is given, never from the platform's (BP 9.4).
//
//   save        S12-01, A4-21, B4-23: the picked time is held for the door's length (doors.ts), for its holder, through
//               K-05 reserve, which refuses a double booking in the database (EXCLUDE) and a third saved time for one
//               mobile, or for one agent token at one business (the cap: K-05 item 8; arch 05 line 247), and gives the
//               held time its saved-time clock row, armed at its end (item 8). A time someone else has saved: next in
//               line when asked (A4-18; S12-02), else timeTaken; a booked one is always timeTaken. The cap's refusal names
//               only when the asker's own two saved times end (K-09 v1.2 savedTimeCapError; RULES 4.10).
//   extendTime  Q-12: the one 10-minute extension, through K-05 extend, only for a time held for the asker's own mobile
//               (ownership is this service's: T-198's security note c); a time held for an agent token, C3's door
//               among them, or for a booking is notExtendable before K-05 is called (K-09 v1.2 extendTime; DL-171).
//   lapse       The saved-time clock row's firing (K-05 item 8: `{"release": <id>, "why": "expired"}`): the time is let go
//               at its end and the first in line is held for 10 minutes (K-05 release, item 9: queued_at order, a tie to
//               the lower id; a capped one or one EXCLUDE refuses passed over), with its own saved-time clock row. K-05's
//               release is the one place a promotion happens and it happens once: a second firing (the alarm and the
//               sweep race by design, arch 10 line 540) finds the row released and answers repeated, promoting nobody.
//               Nothing is booked or charged when a saved time lapses (S12-03: "Nothing is booked or charged while the
//               AI is quiet"; S12-04; the money home, S13-55: never a charge on silence), so a lapse writes no money row.
//
// The saved-time clock rows are K-05's to write (item 8 for a held time, item 9 for a promoted one), and this service
// writes none of its own: on the database, db/repo/reservations.ts's reserve and release write them once lead card
// T-1084 lands (until then a time saved on the database has no clock row, so nothing fires its lapse); the K-05 double
// in test-support.ts writes them as the contract says. The firing that calls lapse may instead carry the same release
// in K-05 fireClock's writes.reservations.release, in the firing's own transaction (db/repo/clocks.ts, T-197).
//
// Not here: the page's countdown (the frontend), and the let-go message and the next-in-line link (the next task); the
// firing itself (the actor's alarm, the minute sweep and Fire now: runtime/src/clocks, through K-09 gateAndCommit).
//
// Nothing here logs. What it throws names a field or a fault, never a value; what it answers names ids, states, times
// and labels, never a mobile number, an agent token, or who else holds a time.
//
// Defaults used (for ops/QUESTIONS.md; beside doors.ts's, each where no source decides):
//   4. Next in line is asked for (nextInLine): S12-02's other customer "hears right away that 2:00pm was just taken" and
//      "can ask to be next"; without it a time someone else has saved is timeTaken, as a booked one always is.
//   5. A time held for another mobile, or at another business, answers extendTime as one that does not exist (notFound,
//      K-05's shape), so the answer never confirms someone else's saved time; a token's and a booking's holds answer
//      notExtendable first, as K-09 v1.2 decides them from the stored holder alone.
//   6. A lapse runs K-05 release with why expired and no version (K-05 item 9: "null for the clock's expiry"), so the one
//      extension, which moves the clock row, is never undone by a firing at the old end (notExpired: notYet); a time
//      booked or still in line answers notSaved and nothing is released.
//   7. A repeated save answers its first save's end and version, with extendable read from the row (its one extension
//      may have been used since).

import { EXTEND_MINUTES, STANDARD_HOLD_MINUTES } from "../../../../db/repo/reservation-rules";
import {
  ReservationRequestError,
  doorOf,
  extendableOn,
  heldForKindOf,
  heldForOf,
  holdLengthOf,
  lapsesByOf,
  utcOf,
} from "./doors";
import type {
  ExtendTimeOutcome,
  ExtendTimeRequest,
  LapseOutcome,
  LapseRequest,
  ReleaseOutcome,
  Reservations,
  ReservationsDeps,
  ReserveOutcome,
  SaveOutcome,
  SaveRequest,
  Saved,
} from "./types";

export { EXTEND_MINUTES, STANDARD_HOLD_MINUTES };

/** formats.v1 utc: an RFC 3339 instant ending in Z. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function assertId(value: unknown, what: string): void {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    throw new ReservationRequestError(`${what} is not a non-empty id`);
  }
}

function assertUtc(value: unknown, what: string): void {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ReservationRequestError(`${what} is not an instant in UTC ending in Z`);
  }
}

function checkAsker(request: { asker: unknown }): void {
  const asker = request.asker as { kind?: unknown; agentToken?: unknown; mobile?: unknown } | null;
  if (typeof asker !== "object" || asker === null) {
    throw new ReservationRequestError("asker is not who asks");
  }
  if (asker.kind === "agent") {
    assertId(asker.agentToken, "asker.agentToken");
    return;
  }
  if (asker.kind !== "turn" && asker.kind !== "page") {
    throw new ReservationRequestError("asker.kind is not agent, turn or page");
  }
  if (asker.mobile !== null) assertId(asker.mobile, "asker.mobile");
}

function checkSave(request: SaveRequest): void {
  assertId(request.reservationId, "reservationId");
  assertId(request.businessId, "businessId");
  assertId(request.resourceId, "resourceId");
  assertUtc(request.during.start, "during.start");
  assertUtc(request.during.end, "during.end");
  if (Date.parse(request.during.start) >= Date.parse(request.during.end)) {
    throw new ReservationRequestError("during must start before it ends");
  }
  if (!Number.isSafeInteger(request.seats) || request.seats < 1) {
    throw new ReservationRequestError("seats is not a positive whole number");
  }
  checkAsker(request);
  checkDoorFacts(request.door);
}

const LONGER_DOORS: ReadonlySet<unknown> = new Set(["planCheck", "document", "ownerOk"]);

/** The door's facts are flags, and a longer save names one of the three longer doors (its minutes are K-05's to check). */
function checkDoorFacts(facts: unknown): void {
  const door = facts as { booksAtOnce?: unknown; moneyBefore?: unknown; longer?: unknown } | null;
  if (typeof door !== "object" || door === null) {
    throw new ReservationRequestError("door is not the facts that decide the door");
  }
  if (typeof door.booksAtOnce !== "boolean" || typeof door.moneyBefore !== "boolean") {
    throw new ReservationRequestError("door.booksAtOnce and door.moneyBefore are not true or false");
  }
  const longer = door.longer as { door?: unknown; minutes?: unknown } | null | undefined;
  if (longer === null) return;
  if (typeof longer !== "object" || !LONGER_DOORS.has(longer.door) || typeof longer.minutes !== "number") {
    throw new ReservationRequestError("door.longer is not null or a longer door with its minutes");
  }
}

function checkVersion(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ReservationRequestError("expectVersion is not a version (a positive whole number)");
  }
}

/** The service on its data and clock. */
export function createReservations(deps: ReservationsDeps): Reservations {
  const { data, now } = deps;

  /** Whether a repeated save's held time may still take its one extension: read from the row, which knows. */
  async function stillExtendable(businessId: string, reservationId: string): Promise<boolean> {
    const row = await data.reservation(businessId, reservationId);
    return row !== null && row.state === "held" && !row.extended;
  }

  async function savedOf(
    request: SaveRequest,
    held: Extract<ReserveOutcome, { result: "held" }>,
    door: Saved["door"],
    minutes: number,
    extendable: boolean,
    lapsesBy: Saved["lapsesBy"],
  ): Promise<Saved> {
    return {
      result: "saved",
      reservationId: held.reservationId,
      version: held.version,
      heldUntil: held.heldUntil,
      door,
      minutes,
      extendable:
        extendable && (!held.repeated || (await stillExtendable(request.businessId, held.reservationId))),
      savedTimeClockId: held.savedTimeClockId,
      lapsesBy,
      repeated: held.repeated,
    };
  }

  async function save(request: SaveRequest): Promise<SaveOutcome> {
    checkSave(request);
    const heldFor = heldForOf(request.asker);
    if (heldFor === null) return { error: "mobileRequired" };
    const asked = doorOf(request.asker, request.door);
    const at = utcOf(now());
    const length = holdLengthOf(asked.door, asked.holdMinutes, at, request.during.start);
    if (!length.fits) return { error: "tooSoon", visitStartsAt: request.during.start };

    const outcome = await data.reserve({
      reservationId: request.reservationId,
      businessId: request.businessId,
      resourceId: request.resourceId,
      during: { start: request.during.start, end: request.during.end },
      seats: request.seats,
      for: heldFor,
      door: asked.door,
      holdMinutes: length.holdMinutes,
      waitIfSaved: request.nextInLine,
      at,
    });
    if ("result" in outcome) {
      if (outcome.result === "held") {
        return savedOf(
          request,
          outcome,
          asked.door,
          length.minutes,
          extendableOn(asked.door, heldFor),
          lapsesByOf(heldFor),
        );
      }
      return {
        result: "nextInLine",
        reservationId: outcome.reservationId,
        version: outcome.version,
        queuedAt: outcome.queuedAt,
        repeated: outcome.repeated,
      };
    }
    switch (outcome.error) {
      case "overlap":
        return { error: "timeTaken" };
      case "seatsFull":
        return { error: "seatsFull" };
      case "savedTimeCap": {
        const [first, second] = outcome.saved;
        if (first === undefined || second === undefined) {
          throw new Error("save: K-05 answered savedTimeCap without the two saved times");
        }
        return { error: "savedTimeCap", endsAt: [first.heldUntil, second.heldUntil] };
      }
      case "notBookable":
        return { error: "notBookable" };
      case "idConflict":
        return { error: "idConflict", reservationId: outcome.reservationId };
      case "transient":
        return { error: "transient", sqlstate: outcome.sqlstate };
    }
  }

  async function extendTime(request: ExtendTimeRequest): Promise<ExtendTimeOutcome> {
    assertId(request.reservationId, "reservationId");
    assertId(request.businessId, "businessId");
    checkVersion(request.expectVersion);
    checkAsker(request);
    const notFound = {
      error: "notFound",
      table: "reservations",
      rowId: request.reservationId,
    } as const;

    const row = await data.reservation(request.businessId, request.reservationId);
    if (row?.businessId !== request.businessId) return notFound;
    // The stored holder decides (DL-171): a token's hold may be C3's 15 minutes, which nothing stored tells apart.
    if (row.forAgentToken !== null) {
      return { error: "notExtendable", reservationId: row.id, heldFor: "agentToken" };
    }
    if (row.forPhoneNumber === null) {
      return { error: "notExtendable", reservationId: row.id, heldFor: "booking" };
    }
    // Only the holder's own extension: another's saved time answers as one that does not exist.
    const { asker } = request;
    if (asker.kind === "agent" || asker.mobile !== row.forPhoneNumber) return notFound;

    const outcome = await data.extend({
      reservationId: row.id,
      businessId: request.businessId,
      expectVersion: request.expectVersion,
      door: "standard",
      at: utcOf(now()),
    });
    if ("result" in outcome) {
      return {
        result: "extended",
        reservationId: outcome.reservationId,
        version: outcome.version,
        heldUntil: outcome.heldUntil,
        extendable: false,
      };
    }
    return outcome;
  }

  function letGoOf(
    request: LapseRequest,
    released: Extract<ReleaseOutcome, { result: "released" }>,
    heldFor: ReturnType<typeof heldForKindOf>,
  ): LapseOutcome {
    const { promoted } = released;
    return {
      result: "letGo",
      reservationId: request.reservationId,
      releasedAt: released.releasedAt,
      why: released.why,
      heldFor,
      promoted:
        promoted === null
          ? null
          : {
              reservationId: promoted.reservationId,
              version: promoted.version,
              heldUntil: promoted.heldUntil,
              heldFor: heldForKindOf(promoted),
              savedTimeClockId: promoted.savedTimeClockId,
            },
      repeated: released.repeated,
    };
  }

  async function lapse(request: LapseRequest): Promise<LapseOutcome> {
    assertId(request.reservationId, "reservationId");
    assertId(request.businessId, "businessId");
    const row = await data.reservation(request.businessId, request.reservationId);
    if (row?.businessId !== request.businessId) {
      return { error: "notFound", reservationId: request.reservationId };
    }
    if (row.state === "booked" || row.state === "waiting") {
      return { result: "notSaved", reservationId: row.id, state: row.state };
    }
    // Held (its end come, or not yet) or released before (a repeat): K-05 decides, under the row's lock.
    const outcome = await data.release({
      reservationId: row.id,
      businessId: request.businessId,
      expectVersion: null,
      why: "expired",
      at: utcOf(now()),
    });
    if ("result" in outcome) return letGoOf(request, outcome, heldForKindOf(row));
    switch (outcome.error) {
      case "notExpired":
        return { result: "notYet", reservationId: row.id, heldUntil: outcome.heldUntil };
      case "notFound":
        return { error: "notFound", reservationId: row.id };
      case "transient":
        return { error: "transient", sqlstate: outcome.sqlstate };
      case "versionChanged":
        // The clock's expiry names no version (K-05 item 9), so K-05 never compares one here.
        throw new Error("lapse: K-05 compared a version the clock's expiry does not name");
    }
  }

  return { save, extendTime, lapse };
}
