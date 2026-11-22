// The Places double (T-434; C-218; K-15 v1; build prompt 3.2 and 9.4): the stand-in for Google Places in every test,
// and on staging while J-16 (the Places key, Q-24) is open. It makes no network call, reads no key and logs nothing, so
// no name, address, phone, town or photo text leaves it. It does what K-15 v1's README says the double does ("How a
// test drives the double"):
//
//   search      a request equal to one of ./world.ts's DEMO_SEARCHES, exactly as K-15 v1's fixture writes it, answers
//               found with that fixture's candidates; any other search answers noMatch (no-match.json), never an error.
//   details     the reference of one of its three listings answers found with that listing, as its details fixture
//               holds it; any other reference answers notFound (details-not-found.json). Never a rating or a review.
//   badRequest  a request the contract has no shape for (a field missing or extra, another `by`, no words, a
//               reference that is not a K-08 label) answers badRequest before any call is made, so it writes no span;
//               its fields at fault are kept for the test, never their values.
//   failNext    the test's choice, never a field of the request: the next call (search or details; or the next
//               `times` calls) fails with an error K-15 v1 defines, as error-unavailable.json and
//               error-rate-limited.json show; later calls answer as before.
//   spans()     each call writes one K-08 v1 portCall span, provider google_places, call search or details and its
//               attempt, which K-15 v1's search.span or details.span accepts: what it got (the step, and how it searched
//               or the reference asked) and decided (the number of candidates and the best one's reference; or found or
//               notFound and the number of photos), or on an error its code as error_code and no decided. Never a name,
//               a town, an address, a phone, photo text or a photo's credit. With no trace given, the span goes on the
//               double's own.
//
// Each call returns a promise, as PlacesPort (./types.ts) gives it to its callers.

import {
  buildOutsideCallSpan,
  type BundleId,
  type OutsideCallSpan,
  type OutsideCallSpanInput,
  type SpanFacts,
} from "../../shared/spans";
import type {
  DetailsOutcome,
  DetailsRequest,
  DetailsResponse,
  ListingCandidate,
  PlacesCall,
  PlacesCallName,
  PlacesError,
  PlacesErrorCode,
  PlacesPort,
  PlacesTrace,
  SearchOutcome,
  SearchRequest,
  SearchResponse,
} from "./types";
import { checkDetailsRequest, checkSearchRequest, placesErrorProblems } from "./validate";
import { DEMO_LISTINGS, DEMO_SEARCHES } from "./world";

export interface PlacesDoubleOptions {
  /** The clock, an RFC 3339 UTC time, for each span's start. Default: the real clock. */
  readonly now?: () => string;
}

export interface FailOptions {
  /** How many calls take the error. Default: 1. */
  readonly times?: number;
}

/** One request the double took, as the exchange K-15 v1 pairs with its outcome. */
export type PlacesRequestRecord =
  { call: "search"; request: SearchRequest } | { call: "details"; request: DetailsRequest };

/** One request K-15 v1 has no shape for, with the fields at fault (never their values). */
export interface RejectedRequest {
  call: PlacesCallName;
  request: unknown;
  problems: string[];
}

/**
 * The trace a span goes on when the caller gives none: placeholder ids, numbered in call order, and bundle v0's id
 * (K-01 bundle-v0-skeleton.json), as K-15 v1's span fixtures use. No turn and no handle.
 */
export const DOUBLE_TRACE: { readonly traceId: string; readonly bundleId: BundleId } = {
  traceId: "trace-places-double",
  bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
};

interface Script {
  readonly error: PlacesError;
  remaining: number;
}

const defaultNow = (): string => new Date().toISOString();

function sameSearch(a: SearchRequest, b: SearchRequest): boolean {
  if (a.by === "nameAndTown" && b.by === "nameAndTown") return a.name === b.name && a.town === b.town;
  if (a.by === "photoText" && b.by === "photoText") return a.text === b.text;
  return false;
}

/** A listing's fields as a search candidate gives them (K-15 v1 `candidate`). */
function candidateOf(listingRef: string): ListingCandidate {
  const known = DEMO_LISTINGS.find((entry) => entry.listing.listingRef === listingRef);
  if (known === undefined) throw new Error("the double's world names a listing it does not hold");
  const { name, address, phone, website } = known.listing;
  return { listingRef, name, address, phone, website };
}

/** The double's answer to a search K-15 v1 has the shape of: a demo search's candidates, or no match. */
function searchAnswer(request: SearchRequest): SearchResponse {
  const known = DEMO_SEARCHES.find((entry) => sameSearch(entry.request, request));
  return known === undefined
    ? { result: "noMatch" }
    : { result: "found", candidates: known.listingRefs.map(candidateOf) };
}

/** The double's answer to a details request K-15 v1 has the shape of: a demo listing, or not found. */
function detailsAnswer(request: DetailsRequest): DetailsResponse {
  const known = DEMO_LISTINGS.find((entry) => entry.listing.listingRef === request.listingRef);
  return known === undefined ? { result: "notFound" } : { result: "found", listing: known.listing };
}

/** How a call ended, for its span: what it decided, or the error's code. */
type Ended = { readonly decided: SpanFacts } | { readonly errorCode: PlacesErrorCode };

/** What a search decided, as a count and a reference (K-15 v1 search.span): never a name or an address. */
function searchDecided(answer: SearchResponse): SpanFacts {
  if (answer.result === "noMatch") return { candidates: 0 };
  const best = answer.candidates[0];
  return best === undefined
    ? { candidates: 0 }
    : { candidates: answer.candidates.length, listing: best.listingRef };
}

/** What a details call decided, as a label and a count (K-15 v1 details.span): never the listing's fields. */
function detailsDecided(answer: DetailsResponse): SpanFacts {
  return answer.result === "notFound"
    ? { result: "notFound" }
    : { result: "found", photos: answer.listing.photos.length };
}

export class PlacesDouble implements PlacesPort {
  readonly #now: () => string;
  #requests: PlacesRequestRecord[] = [];
  #rejected: RejectedRequest[] = [];
  #spans: OutsideCallSpan[] = [];
  #script: Script[] = [];
  /** How many spans went on the double's own trace. */
  #ownSpans = 0;

  constructor(options: PlacesDoubleOptions = {}) {
    this.#now = options.now ?? defaultNow;
  }

  // ---- what the test chooses ----

  /** The next call (search or details) fails with this K-15 v1 error, `times` times; later calls answer as before. */
  failNext(error: PlacesError, options: FailOptions = {}): void {
    const problems = placesErrorProblems(error);
    const times = options.times ?? 1;
    if (!Number.isInteger(times) || times < 1) problems.push("times is not a whole number of 1 or more");
    if (problems.length > 0) throw new TypeError(`failNext: ${problems.join("; ")}`);
    this.#script.push({
      error: { error: error.error, retryAfterSeconds: error.retryAfterSeconds },
      remaining: times,
    });
  }

  /** Back to a new double: no record, no span, no error waiting. */
  reset(): void {
    this.#requests = [];
    this.#rejected = [];
    this.#spans = [];
    this.#script = [];
    this.#ownSpans = 0;
  }

  // ---- what the test reads ----

  /** Every request the double took (one K-15 v1 has the shape of), with its call, in order. */
  requests(): readonly PlacesRequestRecord[] {
    return structuredClone(this.#requests);
  }

  /** Requests K-15 v1 has no shape for, in order, with the fields at fault (never their values). */
  rejectedRequests(): readonly RejectedRequest[] {
    return structuredClone(this.#rejected);
  }

  /** The span each call wrote, in order. */
  spans(): readonly OutsideCallSpan[] {
    return structuredClone(this.#spans);
  }

  // ---- the port's calls ----

  /**
   * K-15 v1 search: found with a demo search's candidates, noMatch, or an error. A call the span cannot be written
   * for (an attempt below 1, say) is refused with a TypeError and leaves nothing behind.
   */
  search(request: unknown, call: PlacesCall = {}): Promise<SearchOutcome> {
    try {
      return Promise.resolve(this.#search(request, call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("search: the call was not made"));
    }
  }

  /**
   * K-15 v1 details: found with a demo listing, notFound, or an error. A call the span cannot be written for is
   * refused with a TypeError and leaves nothing behind.
   */
  details(request: unknown, call: PlacesCall = {}): Promise<DetailsOutcome> {
    try {
      return Promise.resolve(this.#details(request, call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("details: the call was not made"));
    }
  }

  // ---- inside ----

  #search(request: unknown, call: PlacesCall): SearchOutcome {
    const checked = checkSearchRequest(request);
    if (checked.request === null) return this.#reject("search", request, checked.problems);
    const asked = checked.request;
    const scripted = this.#script[0];
    const outcome: SearchOutcome = scripted === undefined ? searchAnswer(asked) : { ...scripted.error };
    // The span first: if it cannot be written, the call leaves no record and takes no error the test set.
    const ended: Ended =
      "error" in outcome ? { errorCode: outcome.error } : { decided: searchDecided(outcome) };
    const span = this.#span("search", { searchBy: asked.by }, ended, call);
    this.#took(scripted, call, span);
    this.#requests.push({ call: "search", request: asked });
    return structuredClone(outcome);
  }

  #details(request: unknown, call: PlacesCall): DetailsOutcome {
    const checked = checkDetailsRequest(request);
    if (checked.request === null) return this.#reject("details", request, checked.problems);
    const asked = checked.request;
    const scripted = this.#script[0];
    const outcome: DetailsOutcome = scripted === undefined ? detailsAnswer(asked) : { ...scripted.error };
    const ended: Ended =
      "error" in outcome ? { errorCode: outcome.error } : { decided: detailsDecided(outcome) };
    const span = this.#span("details", { listing: asked.listingRef }, ended, call);
    this.#took(scripted, call, span);
    this.#requests.push({ call: "details", request: asked });
    return structuredClone(outcome);
  }

  /** A request K-15 v1 has no shape for: badRequest before any call, no span, and its fields at fault kept. */
  #reject(call: PlacesCallName, request: unknown, problems: string[]): PlacesError {
    this.#rejected.push({ call, request: structuredClone(request), problems });
    return { error: "badRequest", retryAfterSeconds: null };
  }

  /** Counts one call the double took: the error the test set, the double's own trace, and the span. */
  #took(scripted: Script | undefined, call: PlacesCall, span: OutsideCallSpan): void {
    if (scripted !== undefined) {
      scripted.remaining -= 1;
      if (scripted.remaining <= 0) this.#script.shift();
    }
    if (call.trace === undefined) this.#ownSpans += 1;
    this.#spans.push(span);
  }

  #span(name: PlacesCallName, got: SpanFacts, ended: Ended, call: PlacesCall): OutsideCallSpan {
    const common: Omit<OutsideCallSpanInput, "outcome"> = {
      ...(call.trace ?? this.#ownTrace()),
      hop: "portCall",
      at: new Date(this.#now()),
      // The double answers at once.
      ms: 0,
      provider: "google_places",
      call: name,
      attempt: call.attempt ?? 1,
      got: call.step === undefined ? got : { step: call.step, ...got },
    };
    if ("errorCode" in ended)
      return buildOutsideCallSpan({ ...common, outcome: "failed", errorCode: ended.errorCode });
    return buildOutsideCallSpan({ ...common, decided: ended.decided, outcome: "ok" });
  }

  /** The double's own trace for the next span on it. */
  #ownTrace(): PlacesTrace {
    const seq = this.#ownSpans + 1;
    return {
      traceId: DOUBLE_TRACE.traceId,
      spanId: `span-places-double-${String(seq).padStart(4, "0")}`,
      seq,
      bundleId: DOUBLE_TRACE.bundleId,
      turnId: null,
      handleRef: null,
    };
  }
}

/** A new Places double. */
export function createPlacesDouble(options: PlacesDoubleOptions = {}): PlacesDouble {
  return new PlacesDouble(options);
}
