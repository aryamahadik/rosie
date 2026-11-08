// Where the identity-and-access service (T-308; C-094) gets its facts: K-04 v1's people, roles, handles and booking
// heads through the data-access calls (db/repo; K-05), and two narrow ports for what K-04 v1 does not hold.
//
// Every read takes and gives ids and closed lists: never a name, a number, an email or a person's words (the action
// layer never reads free text: arch 02 line 139), so nothing the service answers can carry them into a log, a span or
// an error (K-08 v1 "Never the raw number or words"; CQ-59).

import { getBookingHead, type BookingHead } from "../../../../db/repo/bookings-head";
import {
  listLiveRolesOfBusiness,
  listLiveRolesOfPerson,
  type PersonRole,
  type PersonRoleName,
} from "../../../../db/repo/people";
import { listPersonIdsOfHandle } from "../../../../db/repo/phones";
import type { Sql, Tx } from "../../../../db/repo/scope";

/** The K-04 v1 reads the service makes, each one data-access call (db/repo). */
export interface IdentityReader {
  /** The people who write from a handle (K-04 person_handles: one handle can be several people, arch 01 line 55). */
  personIdsOfHandle(handleId: string): Promise<readonly string[]>;
  /**
   * A person's live roles (K-04 person_roles, ended_at null). Under a call's business scope row-level security shows
   * only that business's rows (K-04 v1 rule 4); the service checks the business itself as well.
   */
  liveRolesOfPerson(personId: string): Promise<readonly PersonRole[]>;
  /** A business's live roles of one kind: its owners, its admins. */
  liveRolesOfBusiness(businessId: string, role: PersonRoleName): Promise<readonly PersonRole[]>;
  /** A booking's head row (K-04 bookings: the booker, the person served, the payer and the flags), or null. */
  bookingHead(bookingId: string): Promise<BookingHead | null>;
}

/**
 * The reader over the data-access calls, on the call's own transaction: the Tool API's scoped repo (T-290, scope.ts),
 * which reads the primary, uncached, as every decision does (arch 10 line 538).
 */
export function identityReaderOf(db: Sql | Tx): IdentityReader {
  return {
    personIdsOfHandle: (handleId) => listPersonIdsOfHandle(db, handleId),
    liveRolesOfPerson: (personId) => listLiveRolesOfPerson(db, personId),
    liveRolesOfBusiness: (businessId, role) => listLiveRolesOfBusiness(db, businessId, role),
    bookingHead: (bookingId) => getBookingHead(db, bookingId),
  };
}

// ---- admins' powers (K-22 v1 team_powers: T-321) ---------------------------------------------------------------------

/**
 * The K-22 v1 `team_powers.power` values that let an admin decide a business matter: money (fees and refunds), team
 * (people and their roles) and settings (S13-45 row 8; RULES 6.8). Closing, export, hand-over and removing the account
 * owner are no power at all: they stay the owner's alone.
 */
export const ADMIN_POWERS = ["money", "team", "settings"] as const;
export type AdminPower = (typeof ADMIN_POWERS)[number];

/**
 * Whether the owner lets an admin decide with a power at a business (K-22 v1 `team_powers`, a live row given to that
 * admin's `staff` row; S2-02, S2-15). Admins' powers are T-321's, so the service asks through this port.
 */
export interface AdminPowers {
  holds(businessId: string, personId: string, power: AdminPower): Promise<boolean>;
}

/** No admin holds a power: the owner alone decides business matters (the default until T-321 reads K-22 v1). */
export const NO_ADMIN_POWERS: AdminPowers = {
  holds: () => Promise.resolve(false),
};

// ---- the person served beyond K-04 v1 (K-28 v1 age band; the family record) ------------------------------------------

/** K-28 v1 `customers.age_band`: the answer to "are you 18 or older?" (A4-80), never an exact age. */
export type AgeBand = "18_or_older" | "under_18";

/** What is on file about the person served that K-04 v1 does not hold. */
export interface ServedFacts {
  /** Their age band at this business; null when it was not asked. */
  readonly ageBand: AgeBand | null;
  /**
   * For a minor, the parents or guardians on file who decide for them (A4-25: "The family's record on the secure page
   * decides who may book and hear"). Papers on file, such as a court order, win, so a reader that finds papers names
   * only the people the papers allow.
   */
  readonly parentOrGuardianIds: readonly string[];
}

export interface ServedFactsReader {
  /** What is on file about the person served on one booking of a business. */
  servedFacts(businessId: string, bookingId: string, servedPersonId: string): Promise<ServedFacts>;
}

/**
 * Nothing on file: no age band and no parent or guardian, so the person served decides as an adult (A4-24: "Plug-in
 * silent: the person served must be an adult"; S13-31: "Rosie never judges whether someone can decide"). The default
 * until a reader of K-28 v1's age band and the family record exists.
 */
export const NOTHING_ON_FILE: ServedFactsReader = {
  servedFacts: () => Promise.resolve({ ageBand: null, parentOrGuardianIds: [] }),
};
