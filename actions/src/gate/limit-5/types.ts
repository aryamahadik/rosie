// What limit 5, Reserved (C-085, T-303; arch 06 line 307), reads and gives. "Passes when: a reservation row reserves the
// worker, room, vehicle or seat. On failure: the next open times. No pick in 10 minutes on the page, or 2 of their text
// hours otherwise: nothing booked (A6-11)." K-09 v1 limit5Outcome names the two outcomes: nextOpenTimes (ask) and
// nothingBooked (refuse).
//
// Every value below is an id, a state, a time or a closed label: a saved time is read by its K-04 v1 reservations row,
// never by anyone's words, and nothing here holds a phone number, an agent token or a quote.

import type { GatePart, GateTurn, LimitOutcomes } from "../framework";

/** Limit 5's outcomes when it fails (K-09 v1 limit5Outcome). */
export type Limit5Outcome = LimitOutcomes[5];

/** A reservation's state (K-04 v1 reservations.state): a saved time is held; next in line is waiting. */
export type ReservationState = "held" | "waiting" | "booked" | "released";
/** Why a reservation was released (K-04 v1 reservations.released_why). */
export type ReleasedWhy = "expired" | "let_go" | "cancelled";

/** A time range [start, end), UTC (K-04 v1 reservations.during). */
export interface During {
  readonly start: string;
  readonly end: string;
}

/** A saved time as limit 5 reads it: one K-04 v1 reservations row, as it stands now. */
export interface SavedTime {
  readonly id: string;
  readonly businessId: string;
  /** The worker, room, vehicle or class session it reserves (K-04 v1 resources.id). */
  readonly resourceId: string;
  readonly during: During;
  readonly state: ReservationState;
  /** When a held row's saved time ends (K-04 v1 reservations.held_until); null for a row that holds no end. */
  readonly heldUntil: string | null;
  /** Who it is saved for (K-04 v1 reservations_for_someone): a mobile, an agent token or a booking. */
  readonly forPhoneNumber: string | null;
  readonly forAgentToken: string | null;
  readonly bookingId: string | null;
  readonly releasedWhy: ReleasedWhy | null;
  readonly version: number;
}

/** Why a part's saved time does not hold it: a label, never words. */
export type NotHeldWhy =
  /** The part's choice books a time (its stakes name booked) and no saved time holds it. */
  | "noSavedTime"
  /** The saved time is gone, or outside the call's business scope (row-level security hides it). */
  | "notFound"
  /** It is at another business than the part's. */
  | "otherBusiness"
  /** Let go: expired, let go or cancelled (K-04 v1 released). */
  | "released"
  /** Booked already. */
  | "booked"
  /** Next in line: never held (A4-18). */
  | "waiting"
  /** Still held, but its saved time has ended and its clock has not let it go yet (K-05 v1 item 1: "held past its
   * held_until"). */
  | "pastEnd"
  /** Held for another booking, another mobile or an agent token this call is not. */
  | "notTheirs";

/** Why one saved time the part books does not hold it. */
export type LostWhy = Exclude<NotHeldWhy, "noSavedTime">;

/** One saved time the part books that no longer holds it, as K-05 v1's reservationLost lists one, with why. */
export interface LostTime {
  readonly id: string;
  readonly why: LostWhy;
  /** Its state now; null when it is gone or outside the call's scope. */
  readonly state: ReservationState | null;
  readonly heldUntil: string | null;
  readonly releasedWhy: ReleasedWhy | null;
  /** What it reserved, which the next open times start from; null when it is gone or outside the call's scope. */
  readonly reserved: {
    readonly businessId: string;
    readonly resourceId: string;
    readonly during: During;
  } | null;
}

/** One open time to offer: a resource and a time (C-131's search gives them; the composer fills its words from facts). */
export interface OpenTime {
  readonly resourceId: string;
  readonly during: During;
}

/** How long the person has to pick one of the next open times (A6-11). */
export type PickWindow =
  | {
      /** On the page: 10 minutes, only while they are on it. */
      readonly via: "page";
      readonly minutes: number;
      /** When the window ends: UTC, to the whole second. */
      readonly pickBy: string;
      /** True when the soonest time offered starts first, so the window ends there (S13-35). */
      readonly cutByVisit: boolean;
    }
  | {
      /** Otherwise: 2 of their text hours, ending before the visit. */
      readonly via: "text";
      readonly textHours: number;
      /** The zone their text hours are counted in, and the hours (RULES 4.3). */
      readonly zone: string;
      readonly opens: string;
      readonly closes: string;
      readonly pickBy: string;
      readonly cutByVisit: boolean;
    };

/** The next open times, soonest first, and the window to pick one in (K-09 v1: nextOpenTimes, ask). */
export interface NextOpenTimes {
  readonly kind: "nextOpenTimes";
  readonly times: readonly OpenTime[];
  readonly window: PickWindow;
}

/** No open time to offer: nothing is booked (K-09 v1: nothingBooked, refuse). */
export interface NothingBooked {
  readonly kind: "nothingBooked";
}

/** Limit 5 on one part: pass, notChecked, or the failure with what the commit's outcome writer runs next. */
export type ReservedDecision =
  | { readonly result: "pass" }
  | { readonly result: "notChecked" }
  | {
      readonly result: "fail";
      /** The first reason, in the order the saved times were named. */
      readonly why: NotHeldWhy;
      /** Every saved time the part books that does not hold it, in that order; empty for noSavedTime. */
      readonly lost: readonly LostTime[];
      readonly outcome: Limit5Outcome;
      readonly next: NextOpenTimes | NothingBooked;
    };

// ---- the ports ------------------------------------------------------------------------------------------------------

/** The saved times a part books: the walk after its choice knows them. */
export interface BookedTimes {
  /**
   * The ids of the saved times the part books when it commits, as its commit confirms them (K-05 v1
   * writes.reservations.confirm), in that order; empty when it books none.
   */
  savedTimesOf(part: GatePart, turn: GateTurn): Promise<readonly string[]>;
}

/** Saved times read as they stand now, on the call's own transaction. */
export interface ReservationReader {
  /** The reservation `id`, or null when it does not exist or the call's business scope hides it. */
  reservation(id: string): Promise<SavedTime | null>;
}

/** What the next open times are searched from. */
export interface OpenTimesQuery {
  readonly part: GatePart;
  readonly turn: GateTurn;
  /** The saved times that no longer hold the part; empty when none held it (noSavedTime). */
  readonly lost: readonly LostTime[];
}

/** The next open times after a saved time that no longer holds (C-131's search, journey 4). */
export interface OpenTimesFinder {
  nextOpenTimes(query: OpenTimesQuery): Promise<readonly OpenTime[]>;
}

/** What the rule reads, each made only when it is needed. */
export interface ReservedPorts {
  readonly bookedTimes: BookedTimes;
  readonly reservations: () => ReservationReader;
  readonly openTimes: OpenTimesFinder;
}
