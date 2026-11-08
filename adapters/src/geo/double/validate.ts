// What the geo double refuses (T-439; K-17 v1): a request the contract has no shape for, and an error the test chooses
// that K-17 v1 does not define. The checks are the schema's, written by hand: a request has exactly kind and text, kind
// is zip, town or streetAddress, and text has words (a character that is not a space); an error has exactly error and
// retryAfterSeconds, error is unavailable, rateLimited or badRequest, and retryAfterSeconds is whole seconds or null.
// A problem line names the field, never its value (no address, town or ZIP in any message).

import type { GeocodeError, GeocodeErrorCode, GeocodeKind, GeocodeRequest } from "./types";

export const GEOCODE_KINDS: readonly GeocodeKind[] = ["zip", "town", "streetAddress"];
export const GEOCODE_ERRORS: readonly GeocodeErrorCode[] = ["unavailable", "rateLimited", "badRequest"];

const KIND_NAMES: readonly string[] = GEOCODE_KINDS;
const ERROR_NAMES: readonly string[] = GEOCODE_ERRORS;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

function isKind(value: unknown): value is GeocodeKind {
  return typeof value === "string" && KIND_NAMES.includes(value);
}

function isErrorCode(value: unknown): value is GeocodeErrorCode {
  return typeof value === "string" && ERROR_NAMES.includes(value);
}

/** The schema's text: at least one character, one of them not a space. */
function isWords(value: unknown): value is string {
  return typeof value === "string" && /\S/.test(value);
}

function isRetryAfter(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

export interface CheckedRequest {
  /** The request, copied, when K-17 v1 has its shape; null when it does not. */
  request: GeocodeRequest | null;
  /** The fields at fault, never their values; empty when the request has its shape. */
  problems: string[];
}

/** Checks a geocode request against K-17 v1's `geocode.request`. */
export function checkGeocodeRequest(request: unknown): CheckedRequest {
  if (!isObject(request)) return { request: null, problems: ["the request is not an object"] };
  const problems: string[] = [];
  exactFields("request", request, ["kind", "text"], problems);
  const { kind, text } = request;
  if ("kind" in request && !isKind(kind)) problems.push("request.kind is not zip, town or streetAddress");
  if ("text" in request && !isWords(text)) problems.push("request.text is not words");
  if (problems.length === 0 && isKind(kind) && isWords(text)) return { request: { kind, text }, problems };
  return { request: null, problems };
}

/** The fields at fault in an error the test chooses, against K-17 v1's `geocode.errors`; empty when it fits. */
export function geocodeErrorProblems(error: unknown): string[] {
  if (!isObject(error)) return ["the error is not an object"];
  const problems: string[] = [];
  exactFields("error", error, ["error", "retryAfterSeconds"], problems);
  if ("error" in error && !isErrorCode(error.error))
    problems.push("error.error is not unavailable, rateLimited or badRequest");
  if ("retryAfterSeconds" in error && !isRetryAfter(error.retryAfterSeconds))
    problems.push("error.retryAfterSeconds is not whole seconds or null");
  return problems;
}

/** True when the value is an error K-17 v1 defines. */
export function isGeocodeError(value: unknown): value is GeocodeError {
  return geocodeErrorProblems(value).length === 0;
}
