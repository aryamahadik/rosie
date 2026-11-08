// Limit 5, Reserved (C-085, T-303; arch 06 line 307): a booking part passes only while its reservation row still holds
// the worker, room, vehicle or seat; else the next open times, with 10 minutes to pick on the page or 2 of their text
// hours otherwise (A6-11). It replaces T-298's fail-closed stub in this slot of the gate's registry (../limits.ts). The
// rule is reserved.ts, the pick window window.ts, and what it reads facts.ts.
//
// `limit5` reads each saved time through the call's database transaction (the Tool API's scoped repo). The walk that
// names a part's saved times (C-100, C-133) and C-131's next open times are not built yet, so a part that may book a time
// fails the call closed (notBuilt) until they are wired here; createLimit5 takes other ports, as the tests do.

import type { GatePart, GateTurn, Limit, LimitVerdict } from "../framework";
import { OPEN_TIMES_NOT_BUILT, WALK_NOT_BUILT, databaseOf, reservationReaderOf } from "./facts";
import { decideReserved } from "./reserved";
import type {
  BookedTimes,
  OpenTimesFinder,
  ReservationReader,
  ReservedDecision,
  ReservedPorts,
} from "./types";

export interface Limit5Deps {
  /** The saved times each part books. Default: WALK_NOT_BUILT (a part that may book a time fails the call closed). */
  readonly bookedTimes?: BookedTimes;
  /** Saved times as they stand now, on the call's repo. Default: the data-access read on the call's transaction. */
  readonly reservations?: (repo: unknown) => ReservationReader;
  /** The next open times. Default: OPEN_TIMES_NOT_BUILT (C-131's search; the call fails closed). */
  readonly openTimes?: OpenTimesFinder;
}

/** Limit 5 in the gate's registry, with the full decision the commit's outcome writer reads. */
export interface ReservedLimit extends Limit<5> {
  /** The part's decision: pass, notChecked, or the failure with the next open times and their window, or nothing booked. */
  decide(part: GatePart, turn: GateTurn): Promise<ReservedDecision>;
}

/** The limit's K-09 verdict for the gate from its decision. */
export function verdictOf(decision: ReservedDecision): LimitVerdict<5> {
  switch (decision.result) {
    case "pass":
      return { result: "pass" };
    case "notChecked":
      return { result: "notChecked" };
    case "fail":
      return { result: "fail", outcome: { ...decision.outcome } };
  }
}

/** Made once, when first asked for. */
function once<T>(make: () => T): () => T {
  let made: { readonly value: T } | null = null;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

export function createLimit5(deps: Limit5Deps = {}): ReservedLimit {
  const bookedTimes = deps.bookedTimes ?? WALK_NOT_BUILT;
  const readerOf = deps.reservations ?? ((repo: unknown) => reservationReaderOf(databaseOf(repo)));
  const openTimes = deps.openTimes ?? OPEN_TIMES_NOT_BUILT;
  const decide = (part: GatePart, turn: GateTurn): Promise<ReservedDecision> => {
    const ports: ReservedPorts = {
      bookedTimes,
      reservations: once(() => readerOf(turn.repo)),
      openTimes,
    };
    return decideReserved(part, turn, ports);
  };
  return {
    limit: 5,
    decide,
    async check(part, turn) {
      return verdictOf(await decide(part, turn));
    },
  };
}

/** Limit 5 as the gate runs it (../limits.ts). */
export const limit5: ReservedLimit = createLimit5();

export {
  BOOKS_REASON,
  TEAM_ROLES,
  asReservationLost,
  booksATime,
  decideReserved,
  nextOpenTimesOutcome,
  notHeldWhy,
  nothingBookedOutcome,
  soonestFirst,
} from "./reserved";
export {
  Limit5NotBuiltError,
  MAY_BOOK_REASONS,
  OPEN_TIMES_NOT_BUILT,
  WALK_NOT_BUILT,
  databaseOf,
  mayBook,
  reservationReaderOf,
  savedTimeOf,
  type Limit5Port,
} from "./facts";
export {
  CUSTOMER_OPENS,
  PAGE_PICK_MINUTES,
  PickWindowError,
  STAFF_OPENS,
  TEXT_HOURS_CLOSE,
  TEXT_PICK_HOURS,
  addTextHours,
  pickWindowOf,
  utcOf,
  type WindowInput,
} from "./window";
export type {
  BookedTimes,
  During,
  Limit5Outcome,
  LostTime,
  LostWhy,
  NextOpenTimes,
  NotHeldWhy,
  NothingBooked,
  OpenTime,
  OpenTimesFinder,
  OpenTimesQuery,
  PickWindow,
  ReleasedWhy,
  ReservationReader,
  ReservationState,
  ReservedDecision,
  ReservedPorts,
  SavedTime,
} from "./types";
