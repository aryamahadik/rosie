// What the reservations service (T-744; C-100, C-134) reads, takes and answers. Its data goes through the database
// engineer's K-05 v1 item 6 calls (db/repo/reservation-rules.ts: T-187's reserve and release, T-198's door lengths, cap,
// next in line, promotion and extend), at the shapes they export, behind one port (ReservationData), so the service is
// tested with a double (test-support.ts) and runs on the database through pg.ts.
//
// Every answer names ids, states, times and closed labels only: never a mobile number, an agent token or anyone's words
// (K-08 v1 "Never the raw number or words"), and never who else holds a time (S12-02: "It never learns who took it").

import type {
  Door,
  ExtendError,
  ExtendOutcome,
  ExtendRequest,
  ReleaseOutcome,
  ReleaseRequest,
  ReleaseWhy,
  Reservation,
  ReservationState,
  ReserveOutcome,
  ReserveRequest,
} from "../../../../db/repo/reservation-rules";

export type {
  Door,
  ExtendError,
  ExtendOutcome,
  ExtendRequest,
  ReleaseOutcome,
  ReleaseRequest,
  ReleaseWhy,
  Reservation,
  ReservationState,
  ReserveOutcome,
  ReserveRequest,
};

// ---- the ports ---------------------------------------------------------------------------------------------------

/**
 * K-05 v1 item 6 on the call's business (contracts/data-access/README.md items 8 to 10): reserve, release and extend as
 * db/repo/reservation-rules.ts gives them, and the reservation row as it stands now. reserve gives a held time its
 * saved-time clock row, armed at its end (item 8), and release gives the next in line it promotes its own (item 9).
 */
export interface ReservationData {
  reserve(request: ReserveRequest): Promise<ReserveOutcome>;
  release(request: ReleaseRequest): Promise<ReleaseOutcome>;
  extend(request: ExtendRequest): Promise<ExtendOutcome>;
  /** The reservation `reservationId`, or null when it does not exist or the business's scope hides it. */
  reservation(businessId: string, reservationId: string): Promise<Reservation | null>;
}

/** Now, in epoch milliseconds: the call's clock (a fake one in tests, and staging's fake clock: BP 9.4). */
export type Now = () => number;

export interface ReservationsDeps {
  readonly data: ReservationData;
  readonly now: Now;
}

// ---- who asks, and what they ask ---------------------------------------------------------------------------------

/**
 * Who asks for the time (K-09 v1.2 saveTime: round 3, DL-171 ruling 1). An outside AI's save is held for its agent token,
 * which the Tool API takes from the AI's own authentication (K-20; C-110), never from a field the AI fills; a turn's or a
 * page's save is held for the booker's mobile on file (K-28 customers.mobile_handle_id, which the reach card requires: MC
 * C2), or null when there is none (mobileRequired).
 */
export type Asker =
  | { readonly kind: "agent"; readonly agentToken: string }
  | { readonly kind: "turn" | "page"; readonly mobile: string | null };

/** A longer saved time from the start (A4-21; A5-08, B5-06), up to the door's own limit. */
export interface LongerSave {
  /** planCheck up to 60 minutes and document up to 24 hours (A4-21); ownerOk up to 30 minutes (A5-08, B5-06). */
  readonly door: "planCheck" | "document" | "ownerOk";
  readonly minutes: number;
}

/** What decides the door a save takes (MC C3; K-09 v1.2 saveTime's door). */
export interface DoorFacts {
  /** The service books at once on the customer's own AI's request: no OK rule asks the owner first (A4-98; MC C3). */
  readonly booksAtOnce: boolean;
  /** The way takes money before the visit: a deposit or the full price now, or a card to save (MC C3; K-25 path). */
  readonly moneyBefore: boolean;
  /** A longer saved time asked for from the start, or null. */
  readonly longer: LongerSave | null;
}

/** A time to save: the picked time, for the door's length (S12-01; A4-21, B4-23). */
export interface SaveRequest {
  /** The caller's id for the reservation (K-05 reserve: the same request again answers `repeated`). */
  readonly reservationId: string;
  readonly businessId: string;
  /** The worker, room, vehicle or class session (K-04 v1 resources.id), this business's. */
  readonly resourceId: string;
  /** The time to reserve, UTC, [start, end) (K-04 v1 reservations.during). */
  readonly during: { readonly start: string; readonly end: string };
  readonly seats: number;
  readonly asker: Asker;
  readonly door: DoorFacts;
  /**
   * Wait next in line when someone else has saved the time (A4-18: "They go next in line for it"; S12-02: "Dee can ask
   * to be next for 2:00pm. If Ben's saved time runs out, it's saved for Dee at once").
   */
  readonly nextInLine: boolean;
}

/** Who a time is held for, as a kind (K-05 v1 savedFor), never the number or the token. */
export type HeldFor = "phoneNumber" | "agentToken" | "booking";

/** Who fires a saved time's clock row at its end (K-05 item 8). */
export type LapsesBy = "holdersHandle" | "sweep";

/** The saved time held. */
export interface Saved {
  readonly result: "saved";
  readonly reservationId: string;
  readonly version: number;
  /** When the saved time ends, UTC: its saved-time clock row is due then (K-05 item 8). */
  readonly heldUntil: string;
  readonly door: Door;
  /** The door's minutes this save asked for (10 standard, 15 ownAi; a longer save's, cut to end by the visit). */
  readonly minutes: number;
  /** Whether the one 10-minute extension may still be offered (Q-12; never on C3's door; never for an agent token). */
  readonly extendable: boolean;
  /** The saved-time clock row that lets the time go at its end (K-05 item 8: `<reservation id>/saved-time`). */
  readonly savedTimeClockId: string;
  /**
   * The mobile's handle's clock turn for a mobile's save; the minute sweep for an agent token's, whose firing has no turn
   * and texts nobody (K-05 item 8; K-09 v1.2 saveTime).
   */
  readonly lapsesBy: LapsesBy;
  readonly repeated: boolean;
}

/** Next in line: someone else has saved the time (A4-18). Held for them the moment that saved time ends (S12-02). */
export interface NextInLine {
  readonly result: "nextInLine";
  readonly reservationId: string;
  readonly version: number;
  /** Their place in line: earliest first, a tie to the lower id (K-05 item 9). */
  readonly queuedAt: string;
  readonly repeated: boolean;
}

/** A third saved time (arch 05 line 247): only when the asker's own two saved times end, never their ids or businesses. */
export interface SavedTimeCap {
  readonly error: "savedTimeCap";
  readonly endsAt: readonly [string, string];
}

export type SaveError =
  /** Someone booked the time, or saved it while the asker did not ask to wait: the next times (S12-02), never who. */
  | { readonly error: "timeTaken" }
  /** A class session with no seat left (K-04 class_seats). */
  | { readonly error: "seatsFull" }
  | SavedTimeCap
  /** A page's or a turn's save whose booker has no mobile on file: nothing is held (K-09 v1.2; MC C2). */
  | { readonly error: "mobileRequired" }
  /**
   * The saved time would run past the visit's start, which no clock does (the clock home, S13-35: "No clock runs past
   * the visit"): nothing is held.
   */
  | { readonly error: "tooSoon"; readonly visitStartsAt: string }
  /** The resource is not this business's, or not active (K-05 reserve). */
  | { readonly error: "notBookable" }
  /** The reservation id is taken by another request (K-05 reserve). */
  | { readonly error: "idConflict"; readonly reservationId: string }
  /** Nothing was written; the same request may be sent again (K-05: a serialization failure, a deadlock, a lost link). */
  | { readonly error: "transient"; readonly sqlstate: string };

export type SaveOutcome = Saved | NextInLine | SaveError;

// ---- the one extension -----------------------------------------------------------------------------------------------

/** More time for a saved time: the one 10-minute extension (Q-12; K-09 v1.2 extendTime). */
export interface ExtendTimeRequest {
  readonly reservationId: string;
  readonly businessId: string;
  /** The reservation's version the asker read (limit 4). */
  readonly expectVersion: number;
  readonly asker: Asker;
}

export interface Extended {
  readonly result: "extended";
  readonly reservationId: string;
  readonly version: number;
  /** The old end plus 10 minutes. */
  readonly heldUntil: string;
  /** The one extension is used. */
  readonly extendable: false;
}

/** Refused before K-05 extend: a time not held for the asker's own mobile (K-09 v1.2 notExtendable; DL-171). */
export interface NotExtendable {
  readonly error: "notExtendable";
  readonly reservationId: string;
  readonly heldFor: "agentToken" | "booking";
}

export type ExtendTimeOutcome = Extended | NotExtendable | ExtendError;

// ---- the saved time's end --------------------------------------------------------------------------------------------

/** The saved-time clock row's firing: the time it saves ends (K-05 item 8: fires `{"release": <id>, "why": "expired"}`). */
export interface LapseRequest {
  readonly reservationId: string;
  readonly businessId: string;
}

/** The next in line, held for 10 minutes the moment the saved time ahead of them ended (K-05 item 9; S12-02). */
export interface PromotedTime {
  readonly reservationId: string;
  readonly version: number;
  readonly heldUntil: string;
  readonly heldFor: HeldFor;
  readonly savedTimeClockId: string;
}

export type LapseOutcome =
  /** Let go at its end; nothing booked or charged (S12-03, S12-04); the next in line promoted, or nobody. */
  | {
      readonly result: "letGo";
      readonly reservationId: string;
      readonly releasedAt: string;
      /** expired; or, for a repeat, why it was released first (let go or cancelled before its end). */
      readonly why: ReleaseWhy;
      readonly heldFor: HeldFor;
      readonly promoted: PromotedTime | null;
      /** True when it was released before: no second promotion (K-05 release: only the releasing call promotes). */
      readonly repeated: boolean;
    }
  /** Not ended yet: its end moved (the one extension moves the clock row with it). Nothing changes. */
  | { readonly result: "notYet"; readonly reservationId: string; readonly heldUntil: string }
  /** No longer a saved time (booked, or still next in line): nothing to let go. */
  | { readonly result: "notSaved"; readonly reservationId: string; readonly state: "booked" | "waiting" }
  | { readonly error: "notFound"; readonly reservationId: string }
  | { readonly error: "transient"; readonly sqlstate: string };

/** The reservations service: save, the one extension, and the end of a saved time. */
export interface Reservations {
  save(request: SaveRequest): Promise<SaveOutcome>;
  extendTime(request: ExtendTimeRequest): Promise<ExtendTimeOutcome>;
  lapse(request: LapseRequest): Promise<LapseOutcome>;
}
