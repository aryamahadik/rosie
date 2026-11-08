// The geo double (T-439; C-220; K-17 v1; build prompt 3.2 and 9.4): the stand-in for the geo provider in every test, and
// on staging until the provider is picked (Q-25). It makes no network call, reads no key and logs nothing, so no
// address, town or ZIP code leaves it. It does what K-17 v1's README says the double does ("How a test drives the
// double"):
//
//   geocode     a test address of ./world.ts, asked by its kind and its text exactly as K-17 v1's answer fixture writes
//               it, answers found with that address's one match: its point, precision, normalized address, state and
//               IANA zone (CQ-08). Any other request answers notFound, never an error. A request the contract has no
//               shape for (a field missing or extra, another kind, no words) answers badRequest before any call is
//               made, so it writes no span; its fields at fault are kept for the test, never their values.
//   failNext    the test's choice, never a field of the request: the next call (or the next `times` calls) fails with
//               an error K-17 v1 defines, as error-unavailable.json and error-rate-limited.json show; later calls
//               answer as before.
//   spans()     each call writes one K-08 v1 portCall span, provider geo, call geocode and its attempt, which K-17 v1's
//               geocode.span accepts: what it got (the step and the kind asked) and decided (found or notFound, the
//               number of matches, the best match's precision), or on an error its code as error_code and no decided.
//               Never the text or a normalized address. With no trace given, the span goes on the double's own.
//
// geocode returns a promise, as the port's callers take it (runtime/src/clocks GeoPort, which D-017 joins). Distance is
// never the double's: PostGIS computes it on the stored points (Q-25's default).

import {
  buildOutsideCallSpan,
  type BundleId,
  type OutsideCallSpan,
  type OutsideCallSpanInput,
  type SpanFacts,
} from "../../shared/spans";
import type {
  GeocodeCall,
  GeocodeError,
  GeocodeOutcome,
  GeocodeRequest,
  GeocodeResponse,
  GeocodeTrace,
} from "./types";
import { checkGeocodeRequest, geocodeErrorProblems } from "./validate";
import { TEST_ADDRESSES } from "./world";

export interface GeoDoubleOptions {
  /** The clock, an RFC 3339 UTC time, for each span's start. Default: the real clock. */
  readonly now?: () => string;
}

export interface FailOptions {
  /** How many calls take the error. Default: 1. */
  readonly times?: number;
}

/**
 * The trace a span goes on when the caller gives none: placeholder ids, numbered in call order, and bundle v0's id
 * (K-01 bundle-v0-skeleton.json), as K-17 v1's span fixture uses. No turn and no handle.
 */
export const DOUBLE_TRACE: { readonly traceId: string; readonly bundleId: BundleId } = {
  traceId: "trace-geo-double",
  bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
};

interface Script {
  readonly error: GeocodeError;
  remaining: number;
}

const defaultNow = (): string => new Date().toISOString();

/** The double's answer to a request K-17 v1 has the shape of: the test address's one match, or not found. */
function answerFor(request: GeocodeRequest): GeocodeResponse {
  const known = TEST_ADDRESSES.find((entry) => entry.kind === request.kind && entry.text === request.text);
  return known === undefined ? { result: "notFound" } : { result: "found", matches: [known.match] };
}

/** What an answer decided, in counts and labels (K-17 v1 geocode.span): never the address. */
function decidedOf(answer: GeocodeResponse): SpanFacts {
  if (answer.result === "notFound") return { result: "notFound", matches: 0 };
  const best = answer.matches[0];
  return best === undefined
    ? { result: "found", matches: 0 }
    : { result: "found", matches: answer.matches.length, precision: best.precision };
}

export class GeoDouble {
  readonly #now: () => string;
  #requests: GeocodeRequest[] = [];
  #rejected: { request: unknown; problems: string[] }[] = [];
  #spans: OutsideCallSpan[] = [];
  #script: Script[] = [];
  /** How many spans went on the double's own trace. */
  #ownSpans = 0;

  constructor(options: GeoDoubleOptions = {}) {
    this.#now = options.now ?? defaultNow;
  }

  // ---- what the test chooses ----

  /** The next call fails with this K-17 v1 error, `times` times; later calls answer as before. */
  failNext(error: GeocodeError, options: FailOptions = {}): void {
    const problems = geocodeErrorProblems(error);
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

  /** Every request the double took (one K-17 v1 has the shape of), in order. */
  requests(): readonly GeocodeRequest[] {
    return structuredClone(this.#requests);
  }

  /** Requests K-17 v1 has no shape for, in order, with the fields at fault (never their values). */
  rejectedRequests(): readonly { request: unknown; problems: string[] }[] {
    return structuredClone(this.#rejected);
  }

  /** The span each call wrote, in order. */
  spans(): readonly OutsideCallSpan[] {
    return structuredClone(this.#spans);
  }

  // ---- the port's call ----

  /**
   * K-17 v1 geocode: found with the test address's match, notFound, or an error. `call` names the trace, the step and
   * the try for the span, and is never part of the request. A call the span cannot be written for (an attempt below
   * 1, say) is refused with a TypeError and leaves nothing behind.
   */
  geocode(request: unknown, call: GeocodeCall = {}): Promise<GeocodeOutcome> {
    try {
      return Promise.resolve(this.#geocode(request, call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("geocode: the call was not made"));
    }
  }

  // ---- inside ----

  #geocode(request: unknown, call: GeocodeCall): GeocodeOutcome {
    const checked = checkGeocodeRequest(request);
    if (checked.request === null) {
      this.#rejected.push({ request: structuredClone(request), problems: checked.problems });
      return { error: "badRequest", retryAfterSeconds: null };
    }
    const asked = checked.request;
    const scripted = this.#script[0];
    const outcome: GeocodeOutcome = scripted === undefined ? answerFor(asked) : { ...scripted.error };
    // The span first: if it cannot be written, the call leaves no record and takes no error the test set.
    const span = this.#span(asked, outcome, call);
    if (scripted !== undefined) {
      scripted.remaining -= 1;
      if (scripted.remaining <= 0) this.#script.shift();
    }
    if (call.trace === undefined) this.#ownSpans += 1;
    this.#requests.push(asked);
    this.#spans.push(span);
    return structuredClone(outcome);
  }

  #span(request: GeocodeRequest, outcome: GeocodeOutcome, call: GeocodeCall): OutsideCallSpan {
    const common: Omit<OutsideCallSpanInput, "outcome"> = {
      ...(call.trace ?? this.#ownTrace()),
      hop: "portCall",
      at: new Date(this.#now()),
      // The double answers at once.
      ms: 0,
      provider: "geo",
      call: "geocode",
      attempt: call.attempt ?? 1,
      got: call.step === undefined ? { kind: request.kind } : { step: call.step, kind: request.kind },
    };
    if ("error" in outcome)
      return buildOutsideCallSpan({ ...common, outcome: "failed", errorCode: outcome.error });
    return buildOutsideCallSpan({ ...common, decided: decidedOf(outcome), outcome: "ok" });
  }

  /** The double's own trace for the next span on it. */
  #ownTrace(): GeocodeTrace {
    const seq = this.#ownSpans + 1;
    return {
      traceId: DOUBLE_TRACE.traceId,
      spanId: `span-geo-double-${String(seq).padStart(4, "0")}`,
      seq,
      bundleId: DOUBLE_TRACE.bundleId,
      turnId: null,
      handleRef: null,
    };
  }
}

/** A new geo double. */
export function createGeoDouble(options: GeoDoubleOptions = {}): GeoDouble {
  return new GeoDouble(options);
}
