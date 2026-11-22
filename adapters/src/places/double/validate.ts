// What the Places double refuses (T-434; K-15 v1): a request the contract has no shape for, and an error the test
// chooses that K-15 v1 does not define. The checks are the schema's, written by hand:
//   - a search has `by` nameAndTown with exactly name and town, or `by` photoText with exactly text, each one words
//     (a character that is not a space);
//   - a details request has exactly listingRef, a K-08 v1 label (the schema's safeId: letters, digits and _ . : / # -,
//     starting with a letter or digit, and not a run that reads as a number);
//   - an error has exactly error and retryAfterSeconds, error is unavailable, rateLimited or badRequest, and
//     retryAfterSeconds is whole seconds or null.
// A problem line names the field, never its value (no name, town, photo text or reference in any message).

import { isSafeId } from "../../shared/redact";
import type { DetailsRequest, PlacesError, PlacesErrorCode, SearchBy, SearchRequest } from "./types";

export const SEARCH_BY: readonly SearchBy[] = ["nameAndTown", "photoText"];
export const PLACES_ERRORS: readonly PlacesErrorCode[] = ["unavailable", "rateLimited", "badRequest"];

const ERROR_NAMES: readonly string[] = PLACES_ERRORS;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

/** The schema's searchText: at least one character, one of them not a space. */
function isWords(value: unknown): value is string {
  return typeof value === "string" && /\S/.test(value);
}

function isErrorCode(value: unknown): value is PlacesErrorCode {
  return typeof value === "string" && ERROR_NAMES.includes(value);
}

function isRetryAfter(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

export interface Checked<T> {
  /** The request, copied, when K-15 v1 has its shape; null when it does not. */
  request: T | null;
  /** The fields at fault, never their values; empty when the request has its shape. */
  problems: string[];
}

/** Checks a search against K-15 v1's `search.request`. */
export function checkSearchRequest(request: unknown): Checked<SearchRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  if (request.by === "nameAndTown") {
    exactFields("request", request, ["by", "name", "town"], problems);
    const { name, town } = request;
    if ("name" in request && !isWords(name)) problems.push("request.name is not words");
    if ("town" in request && !isWords(town)) problems.push("request.town is not words");
    if (problems.length === 0 && isWords(name) && isWords(town))
      return { request: { by: "nameAndTown", name, town }, problems };
    return { request: null, problems };
  }
  if (request.by === "photoText") {
    exactFields("request", request, ["by", "text"], problems);
    const { text } = request;
    if ("text" in request && !isWords(text)) problems.push("request.text is not words");
    if (problems.length === 0 && isWords(text)) return { request: { by: "photoText", text }, problems };
    return { request: null, problems };
  }
  problems.push("by" in request ? "request.by is not nameAndTown or photoText" : "request.by is missing");
  return { request: null, problems };
}

/** Checks a details request against K-15 v1's `details.request`. */
export function checkDetailsRequest(request: unknown): Checked<DetailsRequest> {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["listingRef"], problems);
  const { listingRef } = request;
  const isRef = typeof listingRef === "string" && isSafeId(listingRef);
  if ("listingRef" in request && !isRef) problems.push("request.listingRef is not a K-08 label");
  if (problems.length === 0 && typeof listingRef === "string" && isRef)
    return { request: { listingRef }, problems };
  return { request: null, problems };
}

/** The fields at fault in an error the test chooses, against K-15 v1's `placesError`; empty when it fits. */
export function placesErrorProblems(error: unknown): string[] {
  if (!isObject(error)) return ["the error is not an object"];
  const problems: string[] = [];
  exactFields("error", error, ["error", "retryAfterSeconds"], problems);
  if ("error" in error && !isErrorCode(error.error))
    problems.push("error.error is not unavailable, rateLimited or badRequest");
  if ("retryAfterSeconds" in error && !isRetryAfter(error.retryAfterSeconds))
    problems.push("error.retryAfterSeconds is not whole seconds or null");
  return problems;
}

/** True when the value is an error K-15 v1 defines. */
export function isPlacesError(value: unknown): value is PlacesError {
  return placesErrorProblems(value).length === 0;
}
