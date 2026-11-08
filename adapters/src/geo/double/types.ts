// The geo double's types (T-439; C-220; K-17 v1). They mirror the port's request and answer shapes in
// contracts/port-geo/port-geo.v1.schema.json by hand, because the generated contract types are git-ignored (ADR-005) and
// code that ships beside them must not depend on them (as the Linq and Stripe doubles' types do). The double's own tests
// check every answer and every span against the schema itself.

import type { BundleId } from "../../shared/spans";

/** K-17 v1 `kind`: what the caller asks the port to place, a ZIP code, a town or a street address (B4-77, B4-30). */
export type GeocodeKind = "zip" | "town" | "streetAddress";

/** K-17 v1 `precision`, finest first: the coarse port list each adapter maps its provider's own field to. */
export type GeocodePrecision = "exact" | "interpolated" | "street" | "zip" | "town";

/** K-17 v1 `point`: WGS 84 decimal degrees, named so nobody confuses PostGIS's longitude-first order. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * K-17 v1 `match`: one place the text matched. A mapped type rather than an interface, so a reader that types a match as
 * an open record takes it as it is (the clock arming's GeoMatch, runtime/src/clocks/types.ts, reads only the zone).
 */
export type GeocodeMatch = Readonly<{
  point: GeoPoint;
  precision: GeocodePrecision;
  /** The provider's normalized one-line address. An address: never in a span or a log line. */
  normalizedAddress: string;
  /** The US state as its two-letter USPS code (MA), or null; a null state never counts as a filled-in state's. */
  state: string | null;
  /** The point's IANA time zone (CQ-08). */
  timeZone: string;
}>;

/** K-17 v1 `geocode.request`: the words as typed, which never enter a span or a log line. */
export interface GeocodeRequest {
  kind: GeocodeKind;
  text: string;
}

/** K-17 v1 `geocode.found`: one or more places, best first. */
export interface GeocodeFound {
  result: "found";
  matches: GeocodeMatch[];
}

/** K-17 v1 `geocode.notFound`: nothing matched. An answer, not an error. */
export interface GeocodeNotFound {
  result: "notFound";
}

/** K-17 v1 `geocode.response`. A partial match is a found answer with a coarser precision, never an error. */
export type GeocodeResponse = GeocodeFound | GeocodeNotFound;

export type GeocodeErrorCode = "unavailable" | "rateLimited" | "badRequest";

/** K-17 v1 `geocode.errors`: the call failed, so nothing is known about the place. */
export interface GeocodeError {
  error: GeocodeErrorCode;
  /** The provider's Retry-After, in whole seconds, or null when it gave none. */
  retryAfterSeconds: number | null;
}

/** What one geocode call gives: an answer or an error (the outcome of K-17 v1's `geocode.exchange`). */
export type GeocodeOutcome = GeocodeResponse | GeocodeError;

// ---- the call's span (K-08 v1 portCall; K-17 v1 geocode.span) ----

/** The trace a call's span goes on: the caller's ids, never a number or an address (K-08 v1). */
export interface GeocodeTrace {
  traceId: string;
  spanId: string;
  /** Its place in the trace, from 1. */
  seq: number;
  bundleId: BundleId;
  turnId: string | null;
  jobId?: string | null;
  eventId?: string | null;
  /** The handle's id in K-04's handles table, never the number. */
  handleRef: string | null;
  businessId?: string | null;
}

/** What the caller tells the double about one call, for its span. Never a field of the port's request. */
export interface GeocodeCall {
  /** The trace the span goes on. Default: the double's own (DOUBLE_TRACE), numbered in call order. */
  trace?: GeocodeTrace;
  /** The step whose check asked, such as B4-77, B4-30, S12-07 or S1-21. Left out of the span when not given. */
  step?: string;
  /** Which try of this call, from 1. Default: 1. */
  attempt?: number;
}
