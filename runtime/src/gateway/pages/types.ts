// The page entry's door to the action layer (T-266; C-044 to C-074): one handler per K-21 v1 call. The handlers are the
// action layer's (its page entry: the session and the link bound on the server, K-09's caller built from them, the
// contract's checks, the free-text safety reads); the gateway only routes each call to its handler, under the trace it
// opened, and sends the handler's outcome back as it is.

import type { TraceContext } from "../../trace";
import type { TraceDeps } from "../answer";
import type { PageCallName } from "./calls";

/** One call as the page entry hands it on. */
export interface PageRequest {
  /** The K-21 call its path named. */
  readonly call: PageCallName;
  /**
   * The request as the web app sent it: a JSON object the gateway has not checked against K-21. The handler checks it
   * against `$defs/<call>.request` and binds its person and business on the server (K-21 README "No browser value says
   * who anyone is"); no field of it is ever logged or put in a span.
   */
  readonly request: Readonly<Record<string, unknown>>;
  /**
   * The trace this request opened (K-08 v1 `opened_by` pageRequest): the request's valid x-trace-id, else a new one. Its
   * id is the answer's x-trace-id, and the handler records its own spans on it (a K-09 call's `caller.traceId` is its id).
   */
  readonly trace: TraceContext;
  /** Where the Worker runs: its ENVIRONMENT ("staging" on staging). */
  readonly environment: string;
}

/**
 * A call's K-21 outcome, sent to the web app as it is: its response, or one of its errors (an object with its own
 * `error`, 02-contracts section 2 item 2).
 */
export type PageOutcome = Readonly<Record<string, unknown>>;

/** One call's handler. A throw, a rejected promise or an answer that is no object means no outcome: the entry answers 503. */
export type PageHandler = (page: PageRequest) => Promise<PageOutcome>;

/** One handler for every call of K-21 v1. */
export type PageHandlers = Readonly<Record<PageCallName, PageHandler>>;

/**
 * The page entry's dependencies: the handlers, the trace's (the active bundle id read at receipt, and the clock), and the
 * cap on a call's body.
 */
export interface PageDeps extends TraceDeps {
  handlers: PageHandlers;
  /**
   * The most bytes a call's body may have (a config value, T-1180): a body over it is answered 413 before it is read
   * whole, and no handler runs. Left out, or not a whole number from 0, it is PAGE_BODY_LIMIT_BYTES (64 KiB).
   */
  bodyLimitBytes?: number;
}
