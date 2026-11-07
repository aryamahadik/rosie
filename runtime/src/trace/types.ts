// The shapes of K-08 v1's trace documents (contracts/event-trace/event-trace.v1.schema.json), written by hand here
// because the generated types are git-ignored (ADR-005) and the Worker must not depend on them. Field names are the
// contract's snake_case. The unit tests check every document built here against the contract's own schema (Ajv 2020).

/** The hops K-08 v1 names (its `hop` definition and README hop table). */
export const HOPS = [
  "receive",
  "scrub",
  "safetyRead",
  "batch",
  "lease",
  "guard",
  "frontier",
  "search",
  "decideReads",
  "reread",
  "planner",
  "gate",
  "commit",
  "compose",
  "fillAndChecks",
  "rewriteOrFallback",
  "dispatch",
  "providerAccepted",
  "delivered",
  "clockArmed",
  "clockFired",
  "effectRun",
  "providerWebhook",
  "pageRequest",
  "agentApiRequest",
  "portCall",
] as const;
export type Hop = (typeof HOPS)[number];

/** The closed list of outside services (K-08 v1 `provider`). */
export const PROVIDERS = [
  "linq",
  "resend",
  "stripe",
  "google_calendar",
  "microsoft_calendar",
  "google_places",
  "geo",
  "r2",
  "anthropic",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const OUTCOMES = ["ok", "dropped", "joinedTurn", "refused", "held", "timedOut", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** What opened a trace (K-08 v1 `trace.opened_by`; CQ-06). */
export const OPENED_BY = [
  "textWebhook",
  "providerWebhook",
  "pageRequest",
  "agentApiRequest",
  "clockFiring",
  "sweep",
  "reconciliation",
] as const;
export type OpenedBy = (typeof OPENED_BY)[number];

export const MODEL_ROLES = ["haiku", "sonnet"] as const;
export const MODEL_PURPOSES = [
  "safetyRead",
  "decideFirst",
  "decideCheck",
  "reread",
  "planner",
  "compose",
  "rewrite",
] as const;
export const MODEL_OUTCOMES = ["ok", "timedOut", "failed"] as const;
export const LIMIT_RESULTS = ["pass", "fail", "notChecked"] as const;

/** K-01's bundle id: the content hash and the build number from 1 (K-01 v1 manifest.bundleId; CQ-09). */
export interface BundleId {
  hash: string;
  build: number;
}

/** One value of what a hop got or decided: a count, a yes or no, none, a label or a list of labels. Never words. */
export type SpanValue = number | boolean | null | string | string[];
export type SpanFacts = Record<string, SpanValue>;

export interface LimitResult {
  limit: number;
  result: (typeof LIMIT_RESULTS)[number];
  outcome: string | null;
}

export interface RowRef {
  table: string;
  id: string;
}

export interface ModelCall {
  model: string;
  role: (typeof MODEL_ROLES)[number];
  purpose: (typeof MODEL_PURPOSES)[number];
  input_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  ms: number;
  outcome: (typeof MODEL_OUTCOMES)[number];
}

/** One span, as K-08 v1's `span` definition spells it; written as one JSON log line. */
export interface Span {
  trace_id: string;
  span_id: string;
  seq: number;
  hop: Hop;
  at: string;
  ms: number;
  bundle_id: BundleId;
  turn_id: string | null;
  job_id?: string | null;
  event_id?: string | null;
  handle_ref: string | null;
  business_id?: string | null;
  provider?: Provider;
  call?: string;
  attempt?: number;
  got?: SpanFacts;
  decided?: SpanFacts;
  limits?: LimitResult[];
  rows?: RowRef[];
  model_calls?: ModelCall[];
  outcome: Outcome;
  error_code?: string | null;
}

/** One trace document (K-08 v1 `trace`). */
export interface Trace {
  trace_id: string;
  opened_by: OpenedBy;
  bundle_id: BundleId;
  turn_id: string | null;
  job_id: string | null;
  handle_ref: string | null;
  joined_trace_ids: string[];
  spans: Span[];
}

/** Reply time read from a turn's traces (K-08 v1 `replyTime`; Q-41; CQ-06). */
export interface ReplyTime {
  trace_id: string;
  turn_id: string;
  bundle_id: BundleId;
  texts: number;
  last_text_event_id: string;
  last_text_at: string;
  first_part_row_id: string;
  first_part_accepted_at: string;
  ms: number;
  reread: boolean;
  rewrite: boolean;
}

/** A trace problem the caller can act on: a refused span, a bad start, a batch or a measure that cannot be made. */
export class TraceError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "TraceError";
    this.problems = problems;
  }
}
