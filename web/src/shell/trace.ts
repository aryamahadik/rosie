// A page request's trace id (T-511; d000-factory-spec section 6; K-08 v1 `$defs/traceId`; ADR-009): the incoming
// x-trace-id when it is a valid id (a UUID), in lower case, else a new one. The Worker reads its own requests the same
// way (runtime/src/index.ts), so one id follows a request from the page to its K-21 calls and their spans.
// A value that is not a valid id is never echoed, logged or shown: only a UUID's letters reach a header, a log line or
// an error page.

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a valid trace id. */
export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value);
}

/** The request's trace id: its valid x-trace-id in lower case, else `newId()`. */
export function traceIdOf(request: Request, newId: () => string = () => crypto.randomUUID()): string {
  const incoming = request.headers.get("x-trace-id")?.trim();
  return incoming !== undefined && isTraceId(incoming) ? incoming.toLowerCase() : newId();
}
