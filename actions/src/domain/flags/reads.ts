// What the flags service reads (T-317; C-078): K-04 v1's handles, phones, people, roles, booking heads and pauses, and
// K-29 v1's consent rows, each through one data-access call (db/repo). A STOP or a START covers every business, so it is
// read and written on the runtime side, with no business scope (db/repo/scope.ts; T-307's security note N4): only there
// does a consent row with no business show (K-29 rule 4). setRecordFlag runs under the call's business scope.
//
// The reads hand back rows as db/repo gives them, a phone's number and a handle's address included, so the service is the
// one place that keeps them in: what it answers, writes to a log or throws carries ids, flags and closed lists only.

import {
  getBookingHead,
  listBookingHeadsOfPerson,
  type BookingHead,
} from "../../../../db/repo/bookings-head";
import { getConsent, listConsentsOfPersons, type ConsentRead } from "../../../../db/repo/consent";
import { getPerson, listLiveRolesOfPerson, type PersonRole } from "../../../../db/repo/people";
import {
  getHandle,
  getHandleByAddress,
  getPause,
  getPhone,
  listHandleIdsOfPerson,
  listOpenPausesOfPerson,
  listOpenPausesOfPhone,
  listPersonIdsOfHandle,
  type Handle,
  type Pause,
  type Phone,
} from "../../../../db/repo/phones";
import type { Sql, Tx } from "../../../../db/repo/scope";

export type { BookingHead, ConsentRead, Handle, Pause, PersonRole, Phone };

/** The K-04 v1 and K-29 v1 reads the flags service makes, each one data-access call. */
export interface FlagsReader {
  /** K-04 handles: the handle of a phone number (E.164) or an email address, or null. */
  handleOfAddress(address: string): Promise<Handle | null>;
  /** K-04 handles, by id. */
  handle(handleId: string): Promise<Handle | null>;
  /** K-04 phones: a mobile's one row across every business, with stopped, its stop and start times, and chat open. */
  phone(number: string): Promise<Phone | null>;
  /** K-04 person_handles: the people behind a handle, by id. */
  personIdsOfHandle(handleId: string): Promise<readonly string[]>;
  /** K-04 person_handles: the handles a person writes from, by id. */
  handleIdsOfPerson(personId: string): Promise<readonly string[]>;
  /** K-04 persons: whether the person exists (by id only: never a name). */
  personExists(personId: string): Promise<boolean>;
  /** K-04 person_roles: a person's live roles at every business the scope shows. */
  liveRoles(personId: string): Promise<readonly PersonRole[]>;
  /** K-29 consents: whether a row with this id is written (a repeat's rows: ids.ts), never its words. */
  consentWritten(id: string): Promise<boolean>;
  /** K-29 consents of these people as the scope shows them, without their words. */
  consentsOfPersons(personIds: readonly string[]): Promise<readonly ConsentRead[]>;
  /** K-04 bookings: the head, with private and deceased, its booker and the person served, or null. */
  bookingHead(bookingId: string): Promise<BookingHead | null>;
  /** K-04 bookings a person is in, as booker or person served, at every business the scope shows. */
  bookingsOfPerson(personId: string): Promise<readonly BookingHead[]>;
  /** K-04 pauses, by id. */
  pause(pauseId: string): Promise<Pause | null>;
  /** K-04 pauses that still hold on a person (cleared_at null), at every business the scope shows. */
  openPausesOfPerson(personId: string): Promise<readonly Pause[]>;
  /** K-04 pauses that still hold on a phone, at every business the scope shows. */
  openPausesOfPhone(number: string): Promise<readonly Pause[]>;
}

/** The reader over the data-access calls, on the call's own transaction (the runtime side's, or the call's scoped one). */
export function flagsReaderOf(db: Sql | Tx): FlagsReader {
  return {
    handleOfAddress: (address) => getHandleByAddress(db, address),
    handle: (handleId) => getHandle(db, handleId),
    phone: (number) => getPhone(db, number),
    personIdsOfHandle: (handleId) => listPersonIdsOfHandle(db, handleId),
    handleIdsOfPerson: (personId) => listHandleIdsOfPerson(db, personId),
    personExists: async (personId) => (await getPerson(db, personId))?.id === personId,
    liveRoles: (personId) => listLiveRolesOfPerson(db, personId),
    consentWritten: async (id) => (await getConsent(db, id))?.id === id,
    consentsOfPersons: (personIds) => listConsentsOfPersons(db, personIds),
    bookingHead: (bookingId) => getBookingHead(db, bookingId),
    bookingsOfPerson: (personId) => listBookingHeadsOfPerson(db, personId),
    pause: (pauseId) => getPause(db, pauseId),
    openPausesOfPerson: (personId) => listOpenPausesOfPerson(db, personId),
    openPausesOfPhone: (number) => listOpenPausesOfPhone(db, number),
  };
}

// ---- the visits a pause covers (S11-62) ------------------------------------------------------------------------------

/** One booked visit a pause covers: its booking, when it begins (UTC, ending in Z) and the zone its day is read in. */
export interface CoveredVisit {
  readonly bookingId: string;
  readonly startsAt: string;
  /** The visit's zone, else the business's (CQ-05; S13-03). */
  readonly zone: string;
}

/** What a pause is on, as the visits it covers are found by it (K-04 pauses.target; address pauses stay unread). */
export type PauseTargetRef = { readonly personId: string } | { readonly phoneNumber: string };

/**
 * The booked visits a pause covers, not yet begun. No frozen read gives a booking's date and time (K-05 open gaps 25 and
 * 27: a booking's date and time, its reservations), so this is a port the database engineer's read fills.
 */
export interface VisitsCovered {
  visitsOf(businessId: string, target: PauseTargetRef): Promise<readonly CoveredVisit[]>;
}

/** No visit's time is known until that read lands: a pause then arms no call-off clock (default 7 in record-flag.ts). */
export const NO_VISIT_TIMES: VisitsCovered = {
  visitsOf: () => Promise.resolve([]),
};
