// What the effects runner reads, calls and reports (C-109, T-323).
//
// The two K-05 v1.1 calls it makes are a port, given to the runner (EffectRepo): claimEffects (claim effect rows, item 20)
// and recordEffectResult (record an effect's result, item 21). T-199 builds them on PostgreSQL; the tests use a fake repo
// with their claim semantics (test-support.ts). Their requests and answers are the generated contract types
// (`npm run contracts:types`; ADR-005), type imports only; recordEffectResult's request, which the generator types loosely,
// is spelled out here field by field from its schema, and the tests hold every request sent to that schema.

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1.1";
import type { TraceContext } from "../../../../runtime/src/trace";
import type { EffectKind, EffectPortName, EffectRow, KindPorts } from "../kinds";

// ---- K-05 v1.1 claimEffects (item 20) ------------------------------------------------------------------------------

export type ClaimEffectsRequest = K05.ClaimEffectsRequest;
export type ClaimEffectsResponse = K05.ClaimEffectsResponse;
/** transient: nothing was claimed; the same request may be sent again. */
export type ClaimEffectsError = K05.ClaimEffectsErrors;
/** An effect row the runner now holds: the row after the claim, its version, the state it came from and the claim. */
export type ClaimedEffect = K05.ClaimedEffect;

// ---- K-05 v1.1 recordEffectResult (item 21) ------------------------------------------------------------------------

/** One event-log entry (K-05 v1 eventEntry); a result's is K-08's effect.result. */
export type EventEntry = K05.EventEntry;

/** K-05 v1.1 `recordEffectResult.request`, field by field (the generator types it as a loose object). */
export interface EffectResultRequest {
  effectId: string;
  expectVersion: number;
  claimer: string;
  outcome: "ok" | "networkError" | "declined";
  /** When the try's answer came (effects.last_try_at). */
  at: string;
  /** For ok, the provider's id of what it made or changed, or null; null otherwise. */
  providerObjectId: string | null;
  /** For networkError and declined, the error the network or the provider gave; null for ok. */
  errorCode: string | null;
  /** For ok, the ledger line it writes or matches, or null; null otherwise. */
  ledgerLineId: string | null;
  /** For networkError, when the next try goes; null after the run's 5th try and for ok and declined. */
  nextTryAt: string | null;
  /** The try's event-log entries, at least its effect.result entry, appended in the result's own transaction. */
  events: [EventEntry, ...EventEntry[]];
}

export type RecordEffectResultResponse = K05.RecordEffectResultResponse;
/** claimLost, wrongState, versionChanged, notFound or transient: nothing was written. */
export type RecordEffectResultError = K05.RecordEffectResultErrors;

/** The two K-05 v1.1 calls the runner makes, each one transaction on the primary (T-199 builds them). */
export interface EffectRepo {
  claimEffects(request: ClaimEffectsRequest): Promise<ClaimEffectsResponse | ClaimEffectsError>;
  recordEffectResult(
    request: EffectResultRequest,
  ): Promise<RecordEffectResultResponse | RecordEffectResultError>;
}

// ---- the clock -----------------------------------------------------------------------------------------------------

/** The runner's clock: the time now, and a wait. Tests give a fake one, so tries spread over minutes run at once. */
export interface RunnerClock {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolves at `at` (epoch milliseconds) or later, at once when it has passed, and early when `signal` aborts. */
  sleepUntil(at: number, signal?: AbortSignal): Promise<void>;
}

// ---- spans ---------------------------------------------------------------------------------------------------------

/** Where an effect's spans go: a trace context (runtime/src/trace) the caller opens for the effect's run. */
export type EffectSpans = Pick<TraceContext, "start">;

/** A span the trace refused (K-08 v1), by labels only; the effect's run never changes for it. */
export interface SpanRefusedReport {
  effectId: string;
  attempt: number;
  error: string;
}

// ---- the runner ----------------------------------------------------------------------------------------------------

export interface EffectsRunnerDeps {
  /** This runner instance, as its claims name it (K-05 v1.1 claimer; effects.claimed_by): a label, never a key. */
  readonly claimer: string;
  readonly repo: EffectRepo;
  /** Each kind's port (../kinds.ts); a kind left out is not built, and its port's rows are not claimed. */
  readonly kinds: KindPorts;
  /**
   * The trace an effect's spans join (K-08 v1 effectRun), opened by the caller for the effect's run: what starts the
   * runner (C-056) opens it on the effect's trace with the bundle in force.
   */
  traceOf(effect: EffectRow): EffectSpans;
  /** The zone an effect's event-log entries are read in: its business's (default: null, UTC, for every effect). */
  zoneOf?(effect: EffectRow): Promise<string | null>;
  /** Default: the system clock. */
  readonly clock?: RunnerClock;
  /** At most this many rows per claim, 1 to 100 (K-05 v1.1 claimEffects.limit); default 10. */
  readonly limit?: number;
  /** Told when the trace refuses a span; default: one JSON line on console.warn. */
  onSpanRefused?(report: SpanRefusedReport): void;
}

/** How one claimed row's run ended for this runner. */
export type RowEnd =
  /** Recorded: the provider did it. */
  | "succeeded"
  /** Recorded: a card decline, never tried again. */
  | "declined"
  /** Recorded: the run's 5th network error; the row is now that service's outage row. */
  | "outage"
  /** K-05 answered claimLost: another runner holds the row now, so this one stops. */
  | "claimLost"
  /** K-05 answered wrongState: the row is no longer running. */
  | "wrongState"
  /** K-05 answered versionChanged: the row moved since this runner's last read. */
  | "versionChanged"
  /** K-05 answered notFound. */
  | "notFound"
  /** K-05 answered transient to every send of the result: unrecorded, so the row is tried again once its claim lapses. */
  | "transient"
  /** The claim had too little time left for a port call: never called, so the row waits for its claim to lapse. */
  | "claimLapsed"
  /** The row already had its 5 tries in this run, so no 6th call. */
  | "triesSpent"
  /** This runner already ran or is running this claim of the row: nothing done again. */
  | "repeat"
  /** The row cannot run as it stands (refusal names why): never called. */
  | "refused";

/** Why a claimed row was refused before any call. */
export type Refusal =
  /** Not running in the claim (K-05 v1.1 claimedEffect.effect.state is running). */
  | "notRunning"
  /** Claimed by another runner. */
  | "notOurs"
  /** No idempotency key (K-07 v1 refuse-effect-without-key): no port is ever called without the row's one key. */
  | "noIdempotencyKey"
  /** Not a K-07 v1 kind. */
  | "unknownKind"
  /** Its port is not its kind's (K-07 v1 effects_port_matches_kind). */
  | "portMismatch"
  /** A calendar row that names no calendar (QUESTIONS.md CQ-76). */
  | "noCalendarProvider"
  /** Its kind has no port in this runner. */
  | "noKindPort"
  /** Running with no first try time, so its 10 minutes cannot be counted (K-07 v1 effectRow.firstTryAt). */
  | "noFirstTry";

/** One claimed row in a run's report: labels and counts only. */
export interface RowReport {
  effectId: string;
  kind: EffectKind | null;
  end: RowEnd;
  /** Set when end is refused. */
  refusal: Refusal | null;
  /** The port calls this runner made for the row in this run. */
  calls: number;
}

/** What one run of the runner did. */
export interface RunReport {
  /** claimed: the claim answered (maybe with no rows); transient: it did not, so nothing ran; noPortServed: no claim. */
  claim: "claimed" | "transient" | "noPortServed";
  /** The ports this runner claimed rows of. */
  ports: EffectPortName[];
  rows: RowReport[];
}

export interface EffectsRunner {
  /** Claims due effect rows of the ports it serves (K-05 v1.1 claimEffects) and runs each to its end. */
  runDue(): Promise<RunReport>;
  /** Runs rows this runner already holds (from claimEffects, or serviceBack after an outage), each to its end. */
  run(claimed: readonly ClaimedEffect[]): Promise<RowReport[]>;
}
