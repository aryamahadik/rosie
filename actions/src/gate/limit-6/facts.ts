// Where limit 6 (C-086, T-304) gets what it reads, each behind a port so the rule (re-parse.ts) is plain code:
//   - the business's own zone, K-04 v1's business head (businesses.time_zone; T-013), read through the data-access call
//     on the call's scoped transaction (db/repo/people.ts getBusiness), where row-level security leaves the call's
//     business only;
//   - where a visit happens: the zone stored with a flow B visit address's point (CQ-08: "the geo port returns each
//     point's zone"; T-439 and T-440 store it), and whether the visit is a video or phone session, with the other side's
//     zone, since both are shown (S13-03). Neither is built yet: the default knows no address zone and no video or phone
//     visit, so a flow B visit with no zone of its own resolves in the business's zone (CQ-05's default);
//   - what a value read from a photo was read back as, and whether the owner said yes to that read-back (S1-12, S1-13,
//     S1-83; C-120's photo reading, K-02 v1.1). Not built yet: the default reads every value from its own words, so no
//     value passes as a photo's.
//
// Every read gives zone names, flags and the read-back's own words (Rosie's text, which limit 6 re-parses and never
// logs); a person's words are never read here.

import { getBusiness } from "../../../../db/repo/people";
import type { Sql, Tx } from "../../../../db/repo/scope";
import type { GateTurn } from "../framework";

// ---- the business's zone (K-04 v1 business head) --------------------------------------------------------------------

export interface BusinessZones {
  /** The business's own IANA zone (K-04 v1 businesses.time_zone), or null when the call's scope shows no such row. */
  zoneOf(businessId: string): Promise<string | null>;
}

/** The business head's zone over the data-access call, on the call's own transaction (the Tool API's scoped repo). */
export function businessZonesOf(db: Sql | Tx): BusinessZones {
  return {
    async zoneOf(businessId) {
      const business = await getBusiness(db, businessId);
      return business?.timeZone ?? null;
    },
  };
}

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction (tool-api/scope.ts, a postgres.js
 * transaction, which is a tagged-template function). Anything else is not a database: limit 6 throws, so the gate fails
 * the whole call and nothing passes.
 */
export function databaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function") {
    throw new TypeError("limit 6 reads through the call's database transaction");
  }
  return repo as Sql | Tx;
}

// ---- where the visit happens (CQ-08; S13-03) --------------------------------------------------------------------------

/** The visit a part acts on, as limit 6 asks where it happens. */
export interface VisitRef {
  readonly businessId: string;
  /** The booking, or null for a new booking (a door, a which-booking pick, a hub case on no booking). */
  readonly bookingId: string | null;
  /** A, the customer comes to the business; B, the business goes to them (RULES 2.1). */
  readonly flow: "A" | "B";
}

/** Where a visit happens, as far as its zone goes. */
export interface VisitPlace {
  /** The zone stored with the visit address's point, for a visit at the customer's place (CQ-08); null when none is. */
  readonly addressZone: string | null;
  /** True for a video or phone session: both sides' times are shown when they differ (S13-03). */
  readonly remote: boolean;
  /** For a video or phone session, the other side's zone (the customer's), when known; null otherwise. */
  readonly otherZone: string | null;
}

export interface VisitPlaces {
  /** Where the visit happens: its booking's place, or for a new booking the place picked so far. */
  placeOf(visit: VisitRef, turn: GateTurn): Promise<VisitPlace>;
}

/** Nothing known of the place: the default until T-439/T-440 store a visit address's zone and a visit's kind is read. */
export const NO_PLACE_KNOWN: VisitPlaces = {
  placeOf: () => Promise.resolve({ addressZone: null, remote: false, otherZone: null }),
};

// ---- a value read from a photo (C-120; S1-12, S1-13, S1-83) -----------------------------------------------------------

/** One value of a part, as the photo port is asked about it. */
export interface FieldRef {
  /** The part's index in decide.parts. */
  readonly part: number;
  /** The field's name (K-02 v1 field.name). */
  readonly field: string;
  /** The photos the texts carrying the value's words came with (K-02 v1 attachment ids), in order. */
  readonly attachmentIds: readonly string[];
}

/** The read-back of what was read from a photo. */
export interface PhotoReadBack {
  /** The read-back's words that show this value, word for word as they went out ("A) Haircut · $35"). */
  readonly words: string;
  /** When it went out (UTC): the send time its dates resolve from. */
  readonly sentAt: string;
  /** True once the owner said yes to it (arch 06 line 309: "the read-back the owner said yes to"). */
  readonly ownerSaidYes: boolean;
}

/** Where a value comes from: its own words, or a photo and the read-back of it, if one went out. */
export type ValueSource =
  { readonly from: "words" } | { readonly from: "photo"; readonly readBack: PhotoReadBack | null };

export interface PhotoReadings {
  /** Whether the value was read from a photo (C-120 knows what it read), and if so its read-back. */
  sourceOf(field: FieldRef, turn: GateTurn): Promise<ValueSource>;
}

/** No photo reading: the default until C-120 lands, so every value re-parses from its own words. */
export const NO_PHOTO_READINGS: PhotoReadings = {
  sourceOf: () => Promise.resolve({ from: "words" }),
};
