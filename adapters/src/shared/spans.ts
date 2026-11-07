// The span helper (T-410; K-08 event-trace v1, "Trace spans"). An adapter builds one span per outside call with
// buildOutsideCallSpan and writes it with spanLogLine. The span carries provider, call and attempt, the bundle id, a
// handle reference and what the hop got and decided as labels, counts and yes/no values: never a raw phone number,
// message text, address or key. A value that is not a safe label, or sits under a private name, is replaced by
// "redacted"; an input that cannot make a valid span (an unknown provider, a call that is not a label, an attempt
// below 1) is refused with a TypeError that names the field, never the value.
//
// runtime/src/trace (T-240) builds and checks spans against the same K-08 v1 rules for the other hops; this file stays
// to the outside-call hops (portCall, effectRun, dispatch) and its output is checked against the schema in the tests.

import { OUTSIDE_CALL_HOPS, PROVIDERS, type OutsideCallHop, type Provider } from "./ports";
import { REDACTED, findPrivateValue, isSafeId, safeIdOrRedacted } from "./redact";

/** One value of what a hop got or decided (K-08 spanValue): a count, a yes or no, none, a label or a list of labels. */
export type SpanValue = number | boolean | null | string | readonly string[];
export type SpanFacts = Readonly<Record<string, SpanValue>>;

export const SPAN_OUTCOMES = [
  "ok",
  "dropped",
  "joinedTurn",
  "refused",
  "held",
  "timedOut",
  "failed",
] as const;
export type SpanOutcome = (typeof SPAN_OUTCOMES)[number];

export interface BundleId {
  readonly hash: string;
  readonly build: number;
}

export interface OutsideCallSpanInput {
  readonly traceId: string;
  readonly spanId: string;
  /** Its place in the trace, from 1. */
  readonly seq: number;
  readonly hop: OutsideCallHop;
  /** When the call started. */
  readonly at: Date;
  /** How long it took, in milliseconds. */
  readonly ms: number;
  readonly bundleId: BundleId;
  readonly turnId: string | null;
  readonly jobId?: string | null;
  readonly eventId?: string | null;
  /** The handle's id in K-04's handles table, never the number. */
  readonly handleRef: string | null;
  readonly businessId?: string | null;
  readonly provider: Provider;
  /** The port call, as its contract names it (sendPart, charge, search...). */
  readonly call: string;
  /** Which try of this call, from 1. */
  readonly attempt: number;
  /** Values of any type: each is kept only when it is a K-08 span value, else redacted. */
  readonly got?: Readonly<Record<string, unknown>>;
  readonly decided?: Readonly<Record<string, unknown>>;
  readonly outcome: SpanOutcome;
  /** A provider's or HTTP code such as 403, 2024 or 4006; null when none. */
  readonly errorCode?: string | number | null;
}

/** The span as K-08 v1 writes it (snake_case, one JSON object per log line). */
export interface OutsideCallSpan {
  readonly trace_id: string;
  readonly span_id: string;
  readonly seq: number;
  readonly hop: OutsideCallHop;
  readonly at: string;
  readonly ms: number;
  readonly bundle_id: BundleId;
  readonly turn_id: string | null;
  readonly job_id: string | null;
  readonly event_id: string | null;
  readonly handle_ref: string | null;
  readonly business_id: string | null;
  readonly provider: Provider;
  readonly call: string;
  readonly attempt: number;
  readonly got?: SpanFacts;
  readonly decided?: SpanFacts;
  readonly outcome: SpanOutcome;
  readonly error_code: string | null;
}

// A fact whose name says it holds words, a number, an address, or a secret is never kept, whatever its value looks like
// (a word such as "yes" is a valid label, so the value alone cannot tell words from a label).
const PRIVATE_NAME_PART =
  /text|body|words|message|content|caption|subject|phone|number|email|address|token|secret|key|authorization|signature|password|passcode/i;
const PRIVATE_NAME_EXACT = /^(?:to|from|name|code|otp|pin|sms)$/i;
const FACT_NAME = /^[a-z][A-Za-z0-9]*$/;

function isPrivateName(name: string): boolean {
  return PRIVATE_NAME_PART.test(name) || PRIVATE_NAME_EXACT.test(name);
}

function keepLabel(value: string): string {
  return isSafeId(value) && findPrivateValue(value) === undefined ? value : REDACTED;
}

function keepValue(value: unknown): SpanValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isInteger(value) ? value : REDACTED;
  if (typeof value === "string") return keepLabel(value);
  if (Array.isArray(value))
    return value.map((item) => (typeof item === "string" ? keepLabel(item) : REDACTED));
  return REDACTED;
}

/**
 * What a hop got or decided, as K-08 span values. A name that is not camelCase, or is "provider" (the span's own
 * field holds the vendor), is refused; a private name or a value that is not a safe label is redacted.
 */
export function sanitizeFacts(facts: Readonly<Record<string, unknown>>, field: string): SpanFacts {
  const out: Record<string, SpanValue> = {};
  for (const [name, value] of Object.entries(facts)) {
    if (!FACT_NAME.test(name) || name === "provider")
      throw new TypeError(`${field}: a fact name must be camelCase and not "provider"`);
    out[name] = isPrivateName(name) ? REDACTED : keepValue(value);
  }
  return out;
}

function requireInteger(value: number, minimum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum)
    throw new TypeError(`${field} must be a whole number of ${String(minimum)} or more`);
  return value;
}

function requireOneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new TypeError(`${field} is not one of ${allowed.join(", ")}`);
  return found;
}

function optionalId(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : safeIdOrRedacted(value);
}

/**
 * One span for an outside call, in K-08 v1's form. The ids and the handle reference are kept when they are safe ids
 * and redacted when they are not (a raw number given by mistake never reaches the line).
 */
export function buildOutsideCallSpan(input: OutsideCallSpanInput): OutsideCallSpan {
  const hop = requireOneOf(input.hop, OUTSIDE_CALL_HOPS, "hop");
  const provider = requireOneOf(input.provider, PROVIDERS, "provider");
  const outcome = requireOneOf(input.outcome, SPAN_OUTCOMES, "outcome");
  if (!isSafeId(input.call) || findPrivateValue(input.call) !== undefined)
    throw new TypeError("call must be a label");
  if (!/^[0-9a-f]{64}$/.test(input.bundleId.hash))
    throw new TypeError("bundleId.hash must be 64 lowercase hex characters");
  if (Number.isNaN(input.at.getTime())) throw new TypeError("at must be a valid date");

  const span: OutsideCallSpan = {
    trace_id: safeIdOrRedacted(input.traceId),
    span_id: safeIdOrRedacted(input.spanId),
    seq: requireInteger(input.seq, 1, "seq"),
    hop,
    at: input.at.toISOString(),
    ms: Math.max(0, Math.round(input.ms)),
    bundle_id: {
      hash: input.bundleId.hash,
      build: requireInteger(input.bundleId.build, 1, "bundleId.build"),
    },
    turn_id: optionalId(input.turnId),
    job_id: optionalId(input.jobId),
    event_id: optionalId(input.eventId),
    handle_ref: optionalId(input.handleRef),
    business_id: optionalId(input.businessId),
    provider,
    call: input.call,
    attempt: requireInteger(input.attempt, 1, "attempt"),
    ...(input.got === undefined ? {} : { got: sanitizeFacts(input.got, "got") }),
    ...(input.decided === undefined ? {} : { decided: sanitizeFacts(input.decided, "decided") }),
    outcome,
    error_code:
      input.errorCode === undefined || input.errorCode === null
        ? null
        : safeIdOrRedacted(String(input.errorCode)),
  };
  return span;
}

export interface LogContext {
  readonly level: "info" | "warn" | "error";
  readonly environment: string;
  readonly version: string;
}

/**
 * The span as one JSON log line (ADR-009: level, msg, trace_id, environment and version beside the span's fields). A
 * last guard refuses a line that still holds an E.164 number, an email address or a key-shaped value, so a bug in a
 * caller fails loudly instead of logging it.
 */
export function spanLogLine(span: OutsideCallSpan, context: LogContext): string {
  const line = JSON.stringify({
    level: context.level,
    msg: "span",
    environment: context.environment,
    version: context.version,
    ...span,
  });
  const found = findPrivateValue(line, { looseNumbers: false });
  if (found !== undefined) throw new Error(`span line refused: it holds a ${found}`);
  return line;
}
