// The runtime's trace context (T-240; K-08 v1; CQ-06; ADR-009; BP 5.5).
//
// One trace id per start. A start that comes in as a request (a text's webhook, a provider's webhook, a page request,
// an Agent API request) keeps a valid incoming x-trace-id and otherwise gets a new one (crypto.randomUUID()); a start
// that is not a request (a clock firing, the minute sweep, reconciliation) always opens its own id, under a job id.
// A page request and an Agent API request therefore never share an id with a text, a clock or each other.
//
// The context carries the trace id, the bundle id (one per trace), the turn id once the batch closes, the job id and
// the handle reference, and numbers the spans. `record` builds one K-08 span from what a hop got, decided and took,
// refuses it when it breaks the contract (no bundle id, no raw number or words, no missing provider or call), then
// hands it to the sink, which by default writes one JSON log line (Workers Logs). A refused span is never logged.
//
// A turn of several texts (CQ-06): each text opened its own trace at its webhook. `closeBatch` gives the turn the first
// text's trace id, lists the other texts' trace ids on it, and ends each other text's trace at its batch span with
// outcome joinedTurn ("joined turn T").

import {
  TraceError,
  type BundleId,
  type Hop,
  type LimitResult,
  type ModelCall,
  type OpenedBy,
  type Outcome,
  type Provider,
  type RowRef,
  type Span,
  type SpanFacts,
  type Trace,
} from "./types";
import { bundleIdProblems, isLabel, spanProblems } from "./validate";

/** What a hop gives the context for one span; the context adds the trace, the place, the bundle, the turn and the handle. */
export interface SpanFields {
  hop: Hop;
  /** How long the hop took, in whole milliseconds. */
  ms: number;
  outcome: Outcome;
  /** When the hop started (UTC, RFC 3339); the context's clock when left out. */
  at?: string;
  eventId?: string | null;
  businessId?: string | null;
  provider?: Provider;
  call?: string;
  attempt?: number;
  got?: SpanFacts;
  decided?: SpanFacts;
  limits?: LimitResult[];
  rows?: RowRef[];
  modelCalls?: ModelCall[];
  errorCode?: string | null;
}

/** Where spans go. */
export type SpanSink = (span: Span) => void;

/** The environment and build ADR-009 puts beside every log line. */
export interface LogContext {
  environment: string;
  version: string;
}

/**
 * The default sink: one JSON log line per span, `level`, `msg` ("span"), the span's fields (which include
 * `trace_id`), then `environment` and `version` (ADR-009). `write` is console.log in the Worker.
 */
export function logSink(context: LogContext, write: (line: string) => void = console.log): SpanSink {
  return (span) => {
    write(
      JSON.stringify({
        level: "info",
        msg: "span",
        ...span,
        environment: context.environment,
        version: context.version,
      }),
    );
  };
}

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A valid trace id is a UUID, as the health endpoint already holds (runtime/src/index.ts; ADR-009). */
export function isValidTraceId(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && TRACE_ID.test(value);
}

/** The incoming x-trace-id when it is a valid id (trimmed, lowercased), else a new one. */
export function traceIdFromHeader(
  header: string | null | undefined,
  newId: () => string = () => crypto.randomUUID(),
): string {
  const incoming = header?.trim();
  return isValidTraceId(incoming) ? incoming.toLowerCase() : newId();
}

/** The starts that arrive as a request and so may carry an x-trace-id; the others open a new id every time. */
const REQUEST_STARTS: readonly OpenedBy[] = [
  "textWebhook",
  "providerWebhook",
  "pageRequest",
  "agentApiRequest",
];
/** The starts with no request: each runs under a job id (K-08 v1; CQ-06). */
const JOB_STARTS: readonly OpenedBy[] = ["clockFiring", "sweep", "reconciliation"];

export interface OpenTraceOptions {
  openedBy: OpenedBy;
  /** The bundle in force: the active bundle id read at this moment (K-08 v1 README default 1). One per trace. */
  bundleId: BundleId;
  /** The request's x-trace-id header, if any. Used only by the request starts, and only when valid. */
  incomingTraceId?: string | null | undefined;
  /** The job's id: required for a clock firing, a sweep and reconciliation. */
  jobId?: string | null;
  /** The handle's id in K-04's handles table (never a number); set later with `setHandle` when not yet known. */
  handleRef?: string | null;
  sink?: SpanSink;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
  newId?: () => string;
}

export class TraceContext {
  readonly traceId: string;
  readonly openedBy: OpenedBy;
  readonly bundleId: BundleId;
  readonly jobId: string | null;
  /** True when the incoming x-trace-id was valid and kept. */
  readonly reusedIncoming: boolean;

  private handle: string | null;
  private turn: string | null = null;
  private joined: string[] = [];
  private ended = false;
  private readonly kept: Span[] = [];
  private readonly sink: SpanSink;
  private readonly now: () => number;

  constructor(options: OpenTraceOptions) {
    const problems: string[] = [];
    problems.push(...bundleIdProblems(options.bundleId));
    const jobId = options.jobId ?? null;
    if (jobId !== null && !isLabel(jobId)) problems.push("jobId is not a label");
    if (JOB_STARTS.includes(options.openedBy) && jobId === null) {
      problems.push(`a ${options.openedBy} runs under a job id`);
    }
    const handleRef = options.handleRef ?? null;
    if (handleRef !== null && !isLabel(handleRef))
      problems.push("handleRef is not a handle id (never a number or address)");
    if (problems.length > 0) throw new TraceError(`cannot open a ${options.openedBy} trace`, problems);

    const newId = options.newId ?? (() => crypto.randomUUID());
    const incoming = REQUEST_STARTS.includes(options.openedBy) ? options.incomingTraceId?.trim() : undefined;
    this.reusedIncoming = isValidTraceId(incoming);
    this.traceId = isValidTraceId(incoming) ? incoming.toLowerCase() : newId();
    this.openedBy = options.openedBy;
    this.bundleId = { hash: options.bundleId.hash, build: options.bundleId.build };
    this.jobId = jobId;
    this.handle = handleRef;
    this.sink = options.sink ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** The turn this trace carries, or null before the batch closes. */
  get turnId(): string | null {
    return this.turn;
  }

  get handleRef(): string | null {
    return this.handle;
  }

  /** True once the trace ended at "joined turn T": no span may follow. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** The spans kept so far, in order. */
  get spans(): readonly Span[] {
    return this.kept;
  }

  /** The header that carries this trace to the next hop (the actor, a page, a port): same id, no other value. */
  headers(): Record<string, string> {
    return { "x-trace-id": this.traceId };
  }

  /** Names the handle once it is resolved (by its handles id, never the number). */
  setHandle(handleRef: string): void {
    if (!isLabel(handleRef))
      throw new TraceError("cannot set the handle", [
        "handleRef is not a handle id (never a number or address)",
      ]);
    this.handle = handleRef;
  }

  /** Sets the turn this trace carries; every later span names it. */
  setTurn(turnId: string): void {
    if (turnId === "") throw new TraceError("cannot set the turn", ["turnId is empty"]);
    this.turn = turnId;
  }

  /** The instant now, as the UTC string a span's `at` holds. */
  nowUtc(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Builds, checks and keeps one span, then hands it to the sink. Throws a TraceError, keeping and logging nothing,
   * when the span breaks K-08 v1 or the trace has ended.
   */
  record(fields: SpanFields): Span {
    if (this.ended)
      throw new TraceError(`trace ${this.traceId} has ended at its batch span: no span may follow`);
    const seq = this.kept.length + 1;
    const span: Span = {
      trace_id: this.traceId,
      span_id: `${this.traceId}:${String(seq).padStart(2, "0")}`,
      seq,
      hop: fields.hop,
      at: fields.at ?? this.nowUtc(),
      ms: fields.ms,
      bundle_id: { hash: this.bundleId.hash, build: this.bundleId.build },
      turn_id: this.turn,
      handle_ref: this.handle,
      outcome: fields.outcome,
    };
    if (this.jobId !== null) span.job_id = this.jobId;
    if (fields.eventId !== undefined) span.event_id = fields.eventId;
    if (fields.businessId !== undefined) span.business_id = fields.businessId;
    if (fields.provider !== undefined) span.provider = fields.provider;
    if (fields.call !== undefined) span.call = fields.call;
    if (fields.attempt !== undefined) span.attempt = fields.attempt;
    if (fields.got !== undefined) span.got = fields.got;
    if (fields.decided !== undefined) span.decided = fields.decided;
    if (fields.limits !== undefined) span.limits = fields.limits;
    if (fields.rows !== undefined) span.rows = fields.rows;
    if (fields.modelCalls !== undefined) span.model_calls = fields.modelCalls;
    span.error_code = fields.errorCode ?? null;

    const problems = spanProblems(span);
    if (problems.length > 0) throw new TraceError(`span ${span.hop} refused`, problems);
    this.kept.push(span);
    this.sink(span);
    return span;
  }

  /**
   * Starts timing a hop. `finish` records the span with `at` the start and `ms` the time since, from the context's
   * clock, so a hop does not do the arithmetic.
   */
  start(hop: Hop): { finish: (rest: Omit<SpanFields, "hop" | "ms" | "at">) => Span } {
    const startedAt = this.now();
    return {
      finish: (rest) =>
        this.record({
          ...rest,
          hop,
          at: new Date(startedAt).toISOString(),
          ms: Math.max(0, this.now() - startedAt),
        }),
    };
  }

  /** When the last kept span ended (`at` plus `ms`) in epoch milliseconds, or null when none was kept. */
  lastSpanEnd(): number | null {
    const last = this.kept[this.kept.length - 1];
    return last === undefined ? null : Date.parse(last.at) + last.ms;
  }

  /** Lists the other texts' trace ids on this trace, which carries the turn (CQ-06). */
  listJoined(traceIds: readonly string[]): void {
    this.joined = [...traceIds];
  }

  /** Ends the trace: its last span was "joined turn T". */
  end(): void {
    this.ended = true;
  }

  /** The trace as K-08 v1's `trace` document. At least one span must have been kept. */
  toTrace(): Trace {
    if (this.kept.length === 0) throw new TraceError(`trace ${this.traceId} has no span yet`);
    return {
      trace_id: this.traceId,
      opened_by: this.openedBy,
      bundle_id: { hash: this.bundleId.hash, build: this.bundleId.build },
      turn_id: this.turn,
      job_id: this.jobId,
      handle_ref: this.handle,
      joined_trace_ids: [...this.joined],
      spans: this.kept.map((span) => ({ ...span })),
    };
  }
}

/** Opens a trace: one trace id for this start. */
export function openTrace(options: OpenTraceOptions): TraceContext {
  return new TraceContext(options);
}

/** One text of a batch: the trace it opened and the event that carried it. */
export interface BatchedText {
  context: TraceContext;
  eventId: string;
}

export interface CloseBatchOptions {
  /** The turn's id (a hash of the texts' event ids, computed elsewhere: CQ-09; K-04 turns.id). */
  turnId: string;
  /** How the batch closed: 3 s quiet, the third text, or 6 s (arch 02 line 113). */
  closedBy: "quiet" | "thirdText" | "maxWait";
  /** The batch's texts in arrival order: the first text's trace carries the turn (CQ-06). */
  texts: readonly BatchedText[];
}

export interface BatchResult {
  /** The turn's trace id: the first text's (CQ-06). */
  turnTraceId: string;
  /** The other texts' trace ids, in arrival order: each ended at "joined turn T". */
  joinedTraceIds: string[];
}

/**
 * Closes a batch under CQ-06. The first text's trace takes the turn id, records its batch span (outcome ok) and lists
 * the others' trace ids; each other text's trace takes the turn id too, records its batch span with outcome joinedTurn
 * naming the turn and the turn's trace, and ends. A batch span's time is the wait: from where the text's last hop
 * ended to the close.
 */
export function closeBatch(options: CloseBatchOptions): BatchResult {
  const [first, ...others] = options.texts;
  if (first === undefined) throw new TraceError("cannot close a batch of no texts");
  const problems: string[] = [];
  if (options.turnId === "") problems.push("turnId is empty");
  const ids = options.texts.map((text) => text.context.traceId);
  if (new Set(ids).size !== ids.length) problems.push("two texts share one trace id");
  for (const text of options.texts) {
    if (text.context.isEnded) problems.push(`trace ${text.context.traceId} has already ended`);
    if (text.context.turnId !== null) problems.push(`trace ${text.context.traceId} already carries a turn`);
  }
  if (problems.length > 0) throw new TraceError("cannot close the batch", problems);

  const joinedTraceIds = others.map((text) => text.context.traceId);
  const turnTraceId = first.context.traceId;
  const closedAt = first.context.nowUtc();
  const closeMs = Date.parse(closedAt);
  const waited = (context: TraceContext): { at: string; ms: number } => {
    const from = context.lastSpanEnd() ?? closeMs;
    return { at: new Date(from).toISOString(), ms: Math.max(0, closeMs - from) };
  };

  for (const text of options.texts) text.context.setTurn(options.turnId);

  first.context.record({
    hop: "batch",
    ...waited(first.context),
    outcome: "ok",
    got: { texts: options.texts.length, eventIds: options.texts.map((text) => text.eventId) },
    decided: { closedBy: options.closedBy, turn: options.turnId, joinedTraces: joinedTraceIds },
  });
  first.context.listJoined(joinedTraceIds);

  for (const text of others) {
    text.context.record({
      hop: "batch",
      ...waited(text.context),
      outcome: "joinedTurn",
      eventId: text.eventId,
      decided: { turn: options.turnId, turnTrace: turnTraceId },
    });
    text.context.end();
  }
  return { turnTraceId, joinedTraceIds };
}
