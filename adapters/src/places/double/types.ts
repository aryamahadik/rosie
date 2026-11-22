// The Places double's types (T-434; C-218; K-15 v1). They mirror the port's request and answer shapes in
// contracts/port-places/port-places.v1.schema.json by hand, because the generated contract types are git-ignored
// (ADR-005) and code that ships beside them must not depend on them (as the geo, Linq and Stripe doubles' types do).
// The double's own tests check every answer and every span against the schema itself.

import type { BundleId } from "../../shared/spans";

/**
 * K-15 v1 `listingRef`: the provider's own id for a listing, a K-08 v1 label. Callers keep it and compare it whole,
 * never parse it.
 */
export type ListingRef = string;

/**
 * K-15 v1 `candidate`: one listing a search found, with the fields S1-09's read-back shows. A business's name,
 * address and phone: never in a span or a log line.
 */
export type ListingCandidate = Readonly<{
  listingRef: ListingRef;
  name: string;
  address: string;
  /** E.164, or null when the listing shows none. */
  phone: string | null;
  /** An http or https URL, or null when the listing shows none. */
  website: string | null;
}>;

/** K-15 v1 `hoursSpan`: one open stretch of one day, in K-27 v1's `weekly_hours` shape. */
export type HoursSpan = Readonly<{
  /** ISO day, 1 Monday to 7 Sunday. */
  weekday: number;
  /** HH:MM local time of day. */
  opensAt: string;
  /** HH:MM local time of day, later than opensAt on the same day; 24:00 for midnight. */
  closesAt: string;
}>;

/** K-15 v1 `photoAuthor`: who a listing photo is credited to. A name, possibly a person's: never in a span. */
export type PhotoAuthor = Readonly<{
  name: string;
  uri: string | null;
}>;

/** K-15 v1 `photo`: a photo's short-lived reference and its credits. Never stored. */
export type ListingPhoto = Readonly<{
  photoRef: string;
  authors: readonly PhotoAuthor[];
}>;

/**
 * K-15 v1 `listing`: one listing's fields, offered as prefill the owner confirms. Never a rating, a review, an email
 * or a map point.
 */
export type Listing = Readonly<{
  listingRef: ListingRef;
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  /** The regular hours, one span per open stretch, in day and time order; null when the listing shows none. */
  openingHours: readonly HoursSpan[] | null;
  /** The categories as words, the primary first. */
  categories: readonly string[];
  /** At most ten. */
  photos: readonly ListingPhoto[];
}>;

/** K-15 v1 `search.request`, by name and town: the words as given, which never enter a span or a log line. */
export interface SearchByNameAndTown {
  by: "nameAndTown";
  name: string;
  town: string;
}

/** K-15 v1 `search.request`, by the text read from a photo of a card, sign or listing. */
export interface SearchByPhotoText {
  by: "photoText";
  text: string;
}

/** K-15 v1 `search.request`. */
export type SearchRequest = SearchByNameAndTown | SearchByPhotoText;

/** How a search was asked: the span's `got.searchBy`. */
export type SearchBy = SearchRequest["by"];

/** K-15 v1 `search.found`: one to five candidates, best first. */
export interface SearchFound {
  result: "found";
  candidates: ListingCandidate[];
}

/** K-15 v1 `search.noMatch`: no listing matched. An answer, not an error. */
export interface SearchNoMatch {
  result: "noMatch";
}

/** K-15 v1 `search.response`. */
export type SearchResponse = SearchFound | SearchNoMatch;

/** K-15 v1 `details.request`: a listing's reference, as a search gave it. */
export interface DetailsRequest {
  listingRef: ListingRef;
}

/** K-15 v1 `details.found`: the listing's fields. */
export interface DetailsFound {
  result: "found";
  listing: Listing;
}

/** K-15 v1 `details.notFound`: an unknown or obsolete reference. An answer, not an error. */
export interface DetailsNotFound {
  result: "notFound";
}

/** K-15 v1 `details.response`. */
export type DetailsResponse = DetailsFound | DetailsNotFound;

export type PlacesErrorCode = "unavailable" | "rateLimited" | "badRequest";

/** K-15 v1 `placesError`: the call failed, so nothing is known about the listing. */
export interface PlacesError {
  error: PlacesErrorCode;
  /** The provider's Retry-After, in whole seconds, or null when it gave none. */
  retryAfterSeconds: number | null;
}

/** What one search gives: an answer or an error (the outcome of K-15 v1's `search.exchange`). */
export type SearchOutcome = SearchResponse | PlacesError;

/** What one details call gives: an answer or an error (the outcome of K-15 v1's `details.exchange`). */
export type DetailsOutcome = DetailsResponse | PlacesError;

/** The port's two calls, as K-15 v1 names them. */
export type PlacesCallName = "search" | "details";

// ---- the call's span (K-08 v1 portCall; K-15 v1 search.span and details.span) ----

/** The trace a call's span goes on: the caller's ids, never a number, a name or an address (K-08 v1). */
export interface PlacesTrace {
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
export interface PlacesCall {
  /** The trace the span goes on. Default: the double's own (DOUBLE_TRACE), numbered in call order. */
  trace?: PlacesTrace;
  /** The step that asked, such as S1-09, S1-21, S1-38 or S1-84. Left out of the span when not given. */
  step?: string;
  /** Which try of this call, from 1. Default: 1. */
  attempt?: number;
}

/**
 * K-15 v1's two calls, as a caller takes them: the Places double now, and the real adapter (T-435) once J-16 lands.
 * Each answers with a promise; an error is an outcome, never a rejection. `call` names the trace, the step and the
 * try for the span, and is never part of the request.
 */
export interface PlacesPort {
  search(request: SearchRequest, call?: PlacesCall): Promise<SearchOutcome>;
  details(request: DetailsRequest, call?: PlacesCall): Promise<DetailsOutcome>;
}
