// Where limit 5 (C-085, T-303) gets what it reads, each behind a port (types.ts), so the rule (reserved.ts) is plain code:
//
//   - the saved times a part books: the reservations its commit confirms (K-05 v1 writes.reservations.confirm). The walk
//     after the part's choice knows them (the commit's writesOf, with M5's reservations service and booking writer: C-100,
//     C-133), and no frozen read names them yet (K-05 v1.2 README, "What v1.2 leaves for later minor versions": "a
//     booking's reservations ... with their versions"). Until that walk is wired here, a part whose choice may book a time
//     fails closed: WALK_NOT_BUILT throws, so the whole call answers notBuilt and nothing is written (default 1);
//   - each saved time as it stands now: its K-04 v1 reservations row, read by id through the database engineer's
//     data-access call (db/repo/reservations.ts getReservation) on the call's own transaction, the Tool API's scoped repo,
//     where row-level security leaves the call's business's rows only (arch 10 line 546);
//   - the next open times after a saved time that no longer holds: C-131's search (journey 4; K-09 v1.1 README open gap
//     44: "a resource's open times after a time (limit 5's next open times ...)"). Not built yet: OPEN_TIMES_NOT_BUILT
//     throws, so the call fails closed rather than claim there are none.
//
// Every read gives ids, states and times. A reservation row names who it is saved for (a mobile, an agent token), which
// the rule compares and never hands on; nothing here logs.

import { getReservation, type Reservation } from "../../../../db/repo/reservations";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { NotBuiltError } from "../../tool-api/errors";
import type { Choice } from "../framework";
import type { BookedTimes, OpenTimesFinder, ReservationReader, SavedTime } from "./types";

/** The ports limit 5 reads through that no task has built yet. */
export type Limit5Port = "bookedTimes" | "openTimes";

/**
 * A port limit 5 reads through is not built yet. It is the Tool API base's NotBuiltError for gateAndCommit, so the base
 * answers notBuilt and rolls the call back: nothing is written and no part passes. The message names the port, never a
 * part's words.
 */
export class Limit5NotBuiltError extends NotBuiltError {
  override name = "Limit5NotBuiltError";
  readonly port: Limit5Port;

  constructor(port: Limit5Port) {
    super("gateAndCommit");
    this.message = `gateAndCommit: limit 5's ${port} read is not built yet`;
    this.port = port;
  }
}

/**
 * The stakes reasons of a choice that may book or move a time (K-02 v1 stakesReason): booked (a recordWrite of the gives
 * key booked), moveRow (the any-time move), and unknown (the frontier builder could not walk it, so it takes the safer
 * route: K-02 README "Stakes").
 */
export const MAY_BOOK_REASONS: readonly string[] = ["booked", "moveRow", "unknown"];

/** Whether a choice may book or move a time, so its saved times must be known (default 1). */
export function mayBook(choice: Choice): boolean {
  return choice.stakesFrom.some((reason) => MAY_BOOK_REASONS.includes(reason.why));
}

/**
 * The walk not built yet (default 1): a part whose choice may book or move a time throws Limit5NotBuiltError, so the call
 * fails closed; any other part books no saved time.
 */
export const WALK_NOT_BUILT: BookedTimes = {
  savedTimesOf(part) {
    if (part.choice !== null && mayBook(part.choice)) {
      return Promise.reject(new Limit5NotBuiltError("bookedTimes"));
    }
    return Promise.resolve([]);
  },
};

/** C-131's search not built yet: asked for the next open times, the call fails closed. */
export const OPEN_TIMES_NOT_BUILT: OpenTimesFinder = {
  nextOpenTimes: () => Promise.reject(new Limit5NotBuiltError("openTimes")),
};

/** A K-04 v1 reservations row as the data-access call reads it, as limit 5 reads it. */
export function savedTimeOf(row: Reservation): SavedTime {
  return {
    id: row.id,
    businessId: row.businessId,
    resourceId: row.resourceId,
    during: { start: row.during.start, end: row.during.end },
    state: row.state,
    heldUntil: row.heldUntil,
    forPhoneNumber: row.forPhoneNumber,
    forAgentToken: row.forAgentToken,
    bookingId: row.bookingId,
    releasedWhy: row.releasedWhy,
    version: row.version,
  };
}

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction (tool-api/scope.ts, a postgres.js
 * transaction, which is a tagged-template function). Anything else is not a database: limit 5 throws, so the gate fails
 * the whole call and nothing passes.
 */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function") {
    throw new TypeError("limit 5 reads through the call's database transaction");
  }
  return repo as Sql | Tx;
}

/** Saved times read on the call's own transaction, under its business scope (db/repo/reservations.ts). */
export function reservationReaderOf(db: Sql | Tx): ReservationReader {
  return {
    async reservation(id) {
      const row = await getReservation(db, id);
      return row === null ? null : savedTimeOf(row);
    },
  };
}
