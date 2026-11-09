// The reservations service (T-744; C-100, C-134): saves a picked time for its door's length, lets it go at its end and
// promotes the next in line, gives one 10-minute extension (never on C3's door), and refuses a third saved time for one
// mobile or one agent token at a business. See service.ts, doors.ts and pg.ts.

export {
  ReservationRequestError,
  doorOf,
  extendableOn,
  heldForKindOf,
  heldForOf,
  holdLengthOf,
  lapsesByOf,
  utcOf,
  type HoldLength,
} from "./doors";
export { reservationDataIn, reservationDataOn } from "./pg";
export { EXTEND_MINUTES, STANDARD_HOLD_MINUTES, createReservations } from "./service";
export type {
  Asker,
  Door,
  DoorFacts,
  ExtendTimeOutcome,
  ExtendTimeRequest,
  Extended,
  HeldFor,
  LapseOutcome,
  LapseRequest,
  LapsesBy,
  LongerSave,
  NextInLine,
  NotExtendable,
  Now,
  PromotedTime,
  ReservationData,
  Reservations,
  ReservationsDeps,
  SaveError,
  SaveOutcome,
  SaveRequest,
  Saved,
  SavedTimeCap,
} from "./types";
