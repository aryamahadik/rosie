// The reservations service's data on PostgreSQL: K-05 v1 item 6 as the database engineer's data-access calls give it
// (db/repo/reservation-rules.ts: T-187's reserve and release with T-198's door lengths, cap, next in line, promotion and
// extend), called, never copied.
//
//   reservationDataIn  inside the call's own transaction, the Tool API's scoped repo (tool-api/scope.ts: one transaction
//                      under the call's business), so a save, its booking line and its booking details commit together;
//   reservationDataOn  on the database client, each call its own transaction under the request's business (K-05 "Scope":
//                      business), with its lost-connection-safe handling: a serialization failure, a deadlock or a lost
//                      connection answers transient, and the same request may be sent again.
//
// The saved-time clock row a held time gets (K-05 item 8), and the one a promoted next in line gets (item 9), are K-05
// reserve's and release's to write (lead card T-1084, db/repo/reservations.ts); this file writes no row of its own.

import {
  extend,
  extendIn,
  getReservation,
  release,
  releaseIn,
  reserve,
  reserveIn,
} from "../../../../db/repo/reservation-rules";
import { withBusiness, type Sql, type Tx } from "../../../../db/repo/scope";
import type { ReservationData } from "./types";

/** K-05 v1 item 6 inside the transaction `tx`, which the caller scoped to the call's business. */
export function reservationDataIn(tx: Tx): ReservationData {
  return {
    reserve: (request) => reserveIn(tx, request),
    release: (request) => releaseIn(tx, request),
    extend: (request) => extendIn(tx, request),
    reservation: (_businessId, reservationId) => getReservation(tx, reservationId),
  };
}

/** K-05 v1 item 6 on the client `sql`: each call one transaction under the request's business. */
export function reservationDataOn(sql: Sql): ReservationData {
  return {
    reserve: (request) => reserve(sql, request),
    release: (request) => release(sql, request),
    extend: (request) => extend(sql, request),
    reservation: (businessId, reservationId) =>
      withBusiness(sql, businessId, (tx) => getReservation(tx, reservationId), { readOnly: true }),
  };
}
