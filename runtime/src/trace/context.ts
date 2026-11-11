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
//
// One run by seq across a trace's writers (T-1108; K-08 v1 README: a trace is read "by filtering on trace_id and
// ordering by seq"). A text's trace has several writers, each with its own context over the one trace id: the gateway
// (receive, scrub), then, in the handle's actor, the safety read, the batch window and the turn (the pin's context). A
// context alone numbers its own spans 1, 2, 3; so the writers of one trace share its count. `beginSeq` (the actor, as it
// stores a text, with the places the gateway took before it; a webhook's door shares its own context's count the same
// way, `shareSeq`, once the signature has passed) makes every context this isolate opens over that trace id take its
// places from one count, and `resumeSeq` brings a count back after a restart without ever lowering it. A trace nobody
// began keeps each context's own count, as before. A place is taken when a hop starts (`start`, or `reserve` for a hop
// that records its span by itself; `takeSeq` when the span's context is not open yet), not when its span is written,
// so a span recorded inside a longer hop comes after it (the gateway's receive, which ends after the actor's first
// hops; the dispatcher's dispatch, around the part's providerAccepted): by seq, the spans are in start order. The count
// lives in this isolate's memory: a writer in another isolate (the gateway before its hand-off, the actor after it) is
// told the places taken so far and goes on from there.

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
  /** The span's place, when it was taken as the hop started (`reserve`); the next place when left out. */
  seq?: number;
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

/** How many traces' shared counts one isolate keeps; the oldest is forgotten first (its contexts then count alone). */
export const SHARED_SEQ_TRACES = 4096;

/** The last place taken on each trace whose writers share one count, by trace id (this isolate's memory). */
const sharedSeq = new Map<string, number>();

/** A trace id as a context keeps it (trimmed, lowercased), so a count is found whichever way its id was written. */
const keyOf = (traceId: string): string => traceId.trim().toLowerCase();

function keepSeq(traceId: string, taken: number): void {
  const key = keyOf(traceId);
  sharedSeq.delete(key);
  sharedSeq.set(key, taken);
  while (sharedSeq.size > SHARED_SEQ_TRACES) {
    const oldest = sharedSeq.keys().next().value;
    if (oldest === undefined) break;
    sharedSeq.delete(oldest);
  }
}

const placesOf = (taken: number): number => (Number.isInteger(taken) && taken > 0 ? taken : 0);

/**
 * Begins one count for a trace's spans: from now on every context this isolate opens over `traceId` takes its places
 * from it, the next being `taken + 1`. `taken` is how many places another writer took before (the gateway's, as its
 * hand-off tells the actor); 0 when the trace starts here. A trace begun again starts again from `taken`.
 */
export function beginSeq(traceId: string, taken = 0): void {
  keepSeq(traceId, placesOf(taken));
}

/** Brings a trace's count back (a restart: the count as it was stored). It never lowers a count this isolate holds. */
export function resumeSeq(traceId: string, taken: number): void {
  keepSeq(traceId, Math.max(sharedSeq.get(keyOf(traceId)) ?? 0, placesOf(taken)));
}

/** The last place taken on a trace whose writers share one count, or null for a trace nobody began here. */
export function seqOf(traceId: string): number | null {
  return sharedSeq.get(keyOf(traceId)) ?? null;
}

/**
 * Takes the next place on a trace whose writers share one count, for a span whose context is not open yet: it is
 * recorded later with that place (`SpanFields.seq`, `BatchedText.seq`), under a bundle id known only then (the batch
 * span, which waits for the turn's pin). Undefined for a trace nobody began here: its span then takes its own context's
 * next place, as before.
 */
export function takeSeq(traceId: string): number | undefined {
  const key = keyOf(traceId);
  const taken = sharedSeq.get(key);
  if (taken === undefined) return undefined;
  sharedSeq.set(key, taken + 1);
  return taken + 1;
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
  /** The last place this context took by itself, on a trace whose writers share no count. */
  private own = 0;
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
    // A place is taken only by a span that is kept: a refused span leaves no hole in the run.
    const seq = fields.seq ?? this.nextSeq();
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
    if (fields.seq === undefined) this.reserve();
    this.kept.push(span);
    this.sink(span);
    return span;
  }

  /**
   * Takes the next place (K-08 `seq`) on the trace now, for a span recorded later with it (`SpanFields.seq`): a hop that
   * other writers record inside keeps the place it started at. From the trace's shared count when one was begun in this
   * isolate (`beginSeq`), else from this context's own.
   */
  reserve(): number {
    const seq = this.nextSeq();
    const key = keyOf(this.traceId);
    if (sharedSeq.has(key)) sharedSeq.set(key, seq);
    else this.own = seq;
    return seq;
  }

  /** The place the next span takes: the trace's shared count plus one, or this context's own. */
  private nextSeq(): number {
    return (sharedSeq.get(keyOf(this.traceId)) ?? this.own) + 1;
  }

  /**
   * Makes the count this context kept by itself the trace's one count from here on (as `beginSeq`, after the places
   * this context has taken). A webhook's door calls it once the signature has passed, so only a provider's own event
   * opens a shared count: a request anyone can send never pushes another trace's count out of this isolate's memory. A
   * trace whose writers share a count already is left as it is.
   */
  shareSeq(): void {
    if (!sharedSeq.has(keyOf(this.traceId))) keepSeq(this.traceId, this.own);
  }

  /**
   * Starts timing a hop. `finish` records the span with `at` the start and `ms` the time since, from the context's
   * clock, so a hop does not do the arithmetic. The span's place is taken now, as the hop starts (`reserve`), so a
   * span recorded before this one ends comes after it: read by seq, the spans are in the order they started (K-08 v1
   * README: seq runs 1, 2, 3 and `at` never goes back; trace-skeleton.json's dispatch is seq 13 and the part's
   * providerAccepted, recorded inside it, seq 14). A hop started and never finished leaves its place empty.
   */
  start(hop: Hop): { finish: (rest: Omit<SpanFields, "hop" | "ms" | "at" | "seq">) => Span } {
    const startedAt = this.now();
    const seq = this.reserve();
    return {
      finish: (rest) =>
        this.record({
          ...rest,
          hop,
          at: new Date(startedAt).toISOString(),
          ms: Math.max(0, this.now() - startedAt),
          seq,
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

  /**
   * The trace as K-08 v1's `trace` document: the spans this context kept, in order by seq (a hop that took its place as
   * it started may have been kept after a span recorded inside it). At least one span must have been kept.
   */
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
      spans: [...this.kept].sort((a, b) => a.seq - b.seq).map((span) => ({ ...span })),
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
  /**
   * Where the text's last hop ended, in epoch milliseconds, when this context did not keep that hop itself (the actor's
   * batch window: the text's safety read is another writer's). Left out, it is read from the context's last kept span.
   */
  waitedFrom?: number | null;
  /**
   * The batch span's place, when it was taken before this context was opened (`takeSeq`: the batch window takes it
   * before the turn's pin and writes the span after it). Left out, the span takes the next place.
   */
  seq?: number;
}

/**
 * How a batch closed, as K-08's batch spans name it: 3 s quiet (trace-skeleton.json's `threeSecondsQuiet`; `quiet`
 * is T-240's first name for it), the third text (trace-batch-three-texts.json), 6 s after the first text, or a danger
 * outcome of one of its texts (arch 02 line 113 and step S).
 */
export type BatchClosedBy = "quiet" | "threeSecondsQuiet" | "thirdText" | "maxWait" | "danger";

export interface CloseBatchOptions {
  /** The turn's id (a hash of the texts' event ids, computed elsewhere: CQ-09; K-04 turns.id). */
  turnId: string;
  /** How the batch closed: 3 s quiet, the third text, or 6 s (arch 02 line 113). */
  closedBy: BatchClosedBy;
  /** The batch's texts in arrival order: the first text's trace carries the turn (CQ-06). */
  texts: readonly BatchedText[];
  /** When the batch closed, in epoch milliseconds; the first text's context's clock, now, when left out. */
  closedAt?: number;
  /**
   * The turn's texts' event ids in arrival order, when `texts` does not hold one per text (texts handed in under one
   * trace id share its span); the texts' own when left out.
   */
  eventIds?: readonly string[];
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
  const closeMs = options.closedAt ?? Date.parse(first.context.nowUtc());
  const waited = (text: BatchedText): { at: string; ms: number } => {
    const from = text.waitedFrom ?? text.context.lastSpanEnd() ?? closeMs;
    return { at: new Date(from).toISOString(), ms: Math.max(0, closeMs - from) };
  };

  for (const text of options.texts) text.context.setTurn(options.turnId);
  // A place taken before the text's context was opened is the span's; left out, the span takes the next place.
  const placed = (text: BatchedText): { seq?: number } => (text.seq === undefined ? {} : { seq: text.seq });

  // An id that is no label (a provider's event id of digits alone, say, or a trace id with no letter in it) is counted
  // and not named, as the gateway leaves one off its spans: the span is kept, where naming it would have the contract
  // refuse the whole span.
  const namedTraces = joinedTraceIds.filter(isLabel);
  const eventIds = [...(options.eventIds ?? options.texts.map((text) => text.eventId))];
  first.context.record({
    hop: "batch",
    ...waited(first),
    ...placed(first),
    outcome: "ok",
    got: { texts: eventIds.length, eventIds: eventIds.filter(isLabel) },
    // The other texts' traces are named only when there are some, as K-08 draws both (trace-skeleton.json's batch span
    // of one text names none; trace-batch-three-texts.json's names two).
    decided: {
      closedBy: options.closedBy,
      turn: options.turnId,
      ...(joinedTraceIds.length > 0 ? { joinedTraces: namedTraces } : {}),
    },
  });
  first.context.listJoined(joinedTraceIds);

  for (const text of others) {
    text.context.record({
      hop: "batch",
      ...waited(text),
      ...placed(text),
      outcome: "joinedTurn",
      ...(isLabel(text.eventId) ? { eventId: text.eventId } : {}),
      decided: { turn: options.turnId, ...(isLabel(turnTraceId) ? { turnTrace: turnTraceId } : {}) },
    });
    text.context.end();
  }
  return { turnTraceId, joinedTraceIds };
}
