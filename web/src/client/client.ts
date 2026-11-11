// The typed K-21 client (T-511; C-185; K-21 v1): how a page makes a page or console call. A page names the call and
// gives its request, typed by K-21 v1 (calls.ts), and gets the call's outcome: its response or one of its errors.
//
// The client sends through a transport, a port: in tests the Tool API mock (C-186; test-support.ts), which answers a
// fixture's request with that fixture's outcome and throws for any other; on the Worker the page entry
// (pageEntryTransport), which answers POST {BASE_PATH}/page-api/<call> (runtime/src/gateway/pages).
//
// Every call carries the page request's trace id (shell/trace.ts), in x-trace-id on the way to the page entry, so the
// page and its calls share one trace (K-08 v1; d000-factory-spec section 6).
//
// A failure is thrown, never turned into an answer: a call K-21 v1 does not hold, an answer that is not the page
// entry's 200, or one that is no JSON object. An error's message never holds the request, the answer's body or a name
// from outside the code, since a page's request carries a session token, a link code and typed words.

import { isPageCall, pagePathOf, type OutcomeOf, type PageCall, type RequestOf } from "./calls";

/** Why a call gave no outcome. */
export type PageApiErrorCode = "unknownCall" | "refusedAtEdge" | "noOutcome";

/** A call that gave no outcome. Never an answer itself. */
export class PageApiError extends Error {
  override name = "PageApiError";
  readonly code: PageApiErrorCode;
  /** The call, or null when the name given is not a call of K-21 v1. */
  readonly call: PageCall | null;
  /** The page entry's status when it was not 200, else null. */
  readonly status: number | null;

  constructor(code: PageApiErrorCode, call: PageCall | null, status: number | null, message: string) {
    super(message);
    this.code = code;
    this.call = call;
    this.status = status;
  }
}

/** How a call reaches the page entry. */
export interface PageApiTransport {
  /**
   * Sends one call's request under the page request's trace id. Resolves to what was answered with the call's outcome
   * (the client checks it is a JSON object); rejects when there is none.
   */
  readonly send: (call: PageCall, request: unknown, traceId: string) => Promise<unknown>;
}

/** The client one page request holds. */
export interface PageApiClient {
  /** The page request's trace id, which every call carries. */
  readonly traceId: string;
  /** Makes one call. Resolves to its outcome, a response or one of its errors (calls.ts isPageError tells them apart). */
  readonly call: <C extends PageCall>(call: C, request: RequestOf<C>) => Promise<OutcomeOf<C>>;
}

// Not a type guard on purpose: the outcome stays `unknown` until it is given its call's type.
function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A client that sends through `transport`, every call under `traceId`. */
export function createPageApiClient(transport: PageApiTransport, traceId: string): PageApiClient {
  return {
    traceId,
    async call<C extends PageCall>(call: C, request: RequestOf<C>): Promise<OutcomeOf<C>> {
      if (!isPageCall(call))
        throw new PageApiError("unknownCall", null, null, "the call named is not a call of K-21 v1");
      const outcome = await transport.send(call, request, traceId);
      if (!isJsonObject(outcome))
        throw new PageApiError("noOutcome", call, null, `${call}: the answer is not a JSON object`);
      // The page entry's handler holds every outcome to K-21's schema; the client only gives it its call's type.
      return outcome as OutcomeOf<C>;
    },
  };
}

/** Where the page entry is, and how one request reaches it. */
export interface PageEntry {
  /**
   * The site's origin and BASE_PATH, with no closing slash, such as https://rosfield.com/test: a call goes to
   * <baseUrl>/page-api/<call>.
   */
  baseUrl: string;
  /** Sends one request to the page entry: the Worker's own handler in process, or a fetch. */
  send: (request: Request) => Promise<Response>;
}

/**
 * The transport to the page entry: each call a POST of its request as JSON to <baseUrl>/page-api/<call>, with the trace
 * id in x-trace-id. A 200 carries the call's outcome and nothing else; any other status is the edge's own answer (400,
 * 413, 503), which gives no outcome, so it is thrown with its status alone.
 */
export function pageEntryTransport(entry: PageEntry): PageApiTransport {
  return {
    async send(call, request, traceId) {
      const response = await entry.send(
        new Request(`${entry.baseUrl}${pagePathOf(call)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-trace-id": traceId },
          body: JSON.stringify(request),
        }),
      );
      if (response.status !== 200)
        throw new PageApiError(
          "refusedAtEdge",
          call,
          response.status,
          `${call}: the page entry answered ${String(response.status)}, which carries no outcome`,
        );
      let outcome: unknown;
      try {
        outcome = await response.json();
      } catch {
        // The parser's message can quote the body, so it is not kept.
        throw new PageApiError("noOutcome", call, null, `${call}: the answer is not JSON`);
      }
      return outcome;
    },
  };
}
