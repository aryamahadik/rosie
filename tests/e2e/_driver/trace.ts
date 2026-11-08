// Collects a trace by its trace id (T-465; C-148). A span is one JSON log line (ADR-009; K-08 v1 README "A span is one
// log line"): K-08's span fields beside `level`, `msg` ("span"), `environment` and `version`. Workers Logs keep them; a
// gateway run in this process writes them with console.log, which `captureConsoleLog` collects. A trace is read by
// filtering on trace_id and ordering by seq, then checked against K-08 v1's `trace` definition.
//
// The driver never prints a line it collects: a span holds no words, and other lines are not its to print.

import type { Hop, Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { K08, schemaProblems } from "./contracts";

/** A log line as a Worker writes it (a JSON string), or as a log reader already parsed it. */
export type LogLine = string | Readonly<Record<string, unknown>>;

/**
 * Where a target reads span log lines for a trace id: the lines captured in this process, or the lines a Workers Logs
 * reader gives on staging (DL-024: the build Mac, never CI). A reader may return every line it has.
 */
export type SpanReader = (traceId: string) => readonly LogLine[] | Promise<readonly LogLine[]>;

/** The fields ADR-009 puts beside a span's own on its log line. */
const LOG_FIELDS = new Set(["level", "msg", "environment", "version"]);

function asObject(line: LogLine): Record<string, unknown> | null {
  if (typeof line !== "string") return { ...line };
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The spans in `lines`, in the order given: each line whose `msg` is "span", without ADR-009's log fields. Lines that
 * are not JSON objects or not spans are passed over. A span's shape is checked when its trace is (traceOf).
 */
export function spansOfLogLines(lines: Iterable<LogLine>): Span[] {
  const spans: Span[] = [];
  for (const line of lines) {
    const object = asObject(line);
    if (object?.msg !== "span") continue;
    const span = Object.fromEntries(Object.entries(object).filter(([key]) => !LOG_FIELDS.has(key)));
    spans.push(span as unknown as Span);
  }
  return spans;
}

/** What opened a trace, from its first hop (K-08 v1 `trace.opened_by`; CQ-06). */
const OPENED_BY: Partial<Record<Hop, Trace["opened_by"]>> = {
  receive: "textWebhook",
  providerWebhook: "providerWebhook",
  pageRequest: "pageRequest",
  agentApiRequest: "agentApiRequest",
  clockFired: "clockFiring",
};

export interface CollectedTrace {
  /** The trace as K-08 v1's `trace` document, or null when no span carries the trace id. */
  readonly trace: Trace | null;
  /** Why the trace is not a K-08 v1 trace (Ajv's lines, by place and rule), or why there is none. Empty when it is. */
  readonly problems: readonly string[];
}

function lastLabel(spans: readonly Span[], pick: (span: Span) => string | null | undefined): string | null {
  for (const span of [...spans].reverse()) {
    const value = pick(span);
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * The trace of `traceId` from `spans`: its spans in seq order, with the trace's own fields read from them (the bundle
 * id from the first span; the turn, handle and job as the spans name them; the other texts' traces a batch joined,
 * CQ-06). `openedBy` is read from the first hop when K-08 names one for it, else taken as given.
 */
export function traceOf(
  traceId: string,
  spans: readonly Span[],
  openedBy: Trace["opened_by"] = "textWebhook",
): CollectedTrace {
  const own = spans.filter((span) => span.trace_id === traceId).sort((a, b) => a.seq - b.seq);
  const [first] = own;
  if (first === undefined) return { trace: null, problems: [`no span carries trace id ${traceId}`] };
  const batch = own.find((span) => span.hop === "batch" && span.outcome === "ok");
  const joined = batch?.decided?.joinedTraces;
  const trace: Trace = {
    trace_id: traceId,
    opened_by: OPENED_BY[first.hop] ?? openedBy,
    bundle_id: { hash: first.bundle_id.hash, build: first.bundle_id.build },
    turn_id: lastLabel(own, (span) => span.turn_id),
    job_id: first.job_id ?? null,
    handle_ref: lastLabel(own, (span) => span.handle_ref),
    joined_trace_ids: Array.isArray(joined) ? [...joined] : [],
    spans: [first, ...own.slice(1)],
  };
  return { trace, problems: schemaProblems(K08, "trace", trace) };
}

/** Reads `value` as a K-08 v1 trace document; throws with the schema's problem lines when it is not one. */
export function asTrace(value: unknown): Trace {
  const problems = schemaProblems(K08, "trace", value);
  if (problems.length > 0) throw new Error(`not a K-08 v1 trace:\n${problems.join("\n")}`);
  return value as Trace;
}

export interface LogCapture {
  /** Every console.log line since the capture started, in order, as one string each. */
  readonly lines: readonly string[];
  /** A SpanReader over the captured lines. */
  readonly reader: SpanReader;
  /** Stops this capture; the last one stopped puts console.log back. Safe to call twice. */
  stop(): void;
}

/** The line lists of the captures running now: each gets every line. */
const listening = new Set<string[]>();
/** console.log as it was before the first capture that is still running. */
let saved: PropertyDescriptor | undefined;

function writeLine(...args: unknown[]): void {
  const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  for (const lines of listening) lines.push(line);
}

/**
 * Collects console.log lines until stopped, without printing them: the log lines a Worker run in this process writes
 * (runtime/src/trace logSink writes each span with console.log). Captures running at the same time each get every
 * line, and may stop in any order; console.log is put back when the last one stops.
 */
export function captureConsoleLog(): LogCapture {
  const lines: string[] = [];
  if (listening.size === 0) {
    saved = Object.getOwnPropertyDescriptor(console, "log");
    console.log = writeLine;
  }
  listening.add(lines);
  return {
    lines,
    reader: () => [...lines],
    stop() {
      if (!listening.delete(lines) || listening.size > 0) return;
      if (saved !== undefined) Object.defineProperty(console, "log", saved);
      saved = undefined;
    },
  };
}
