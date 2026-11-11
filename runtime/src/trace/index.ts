// Runtime trace context (T-240): one trace id per start, hop spans per K-08 v1. See context.ts.

export {
  TraceContext,
  beginSeq,
  closeBatch,
  isValidTraceId,
  logSink,
  openTrace,
  resumeSeq,
  seqOf,
  traceIdFromHeader,
  type BatchClosedBy,
  type BatchResult,
  type BatchedText,
  type CloseBatchOptions,
  type LogContext,
  type OpenTraceOptions,
  type SpanFields,
  type SpanSink,
} from "./context";
export { replyTimeOf } from "./reply-time";
export { HOPS, OPENED_BY, OUTCOMES, PROVIDERS, TraceError } from "./types";
export type {
  BundleId,
  Hop,
  OpenedBy,
  Outcome,
  Provider,
  ReplyTime,
  Span,
  SpanFacts,
  SpanValue,
  Trace,
} from "./types";
export { bundleIdProblems, isLabel, spanProblems } from "./validate";
