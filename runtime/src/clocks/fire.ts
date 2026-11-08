// The one fire path (T-254; C-054; QUESTIONS.md NQ-RT-4; BP 9.4 'A fake clock': Fire now runs the same path). Every
// firing of a clock row, by the handle actor's alarm, the minute sweep or staging's Fire now, goes through `fireOnce`,
// which runs the step's clock branch as a turn:
//
//   1. It reads the active bundle id (K-05 v1 readActiveBundle): the bundle a clock turn names (arch 10 line 548).
//   2. It opens the firing's own trace (CQ-06; K-08 opened_by clockFiring, or sweep for a row the sweep found), under the
//      job id `job-fire-<clock row id>` (K-05's fixtures' form), so a firing never shares an id with a text or another
//      firing.
//   3. A row a handle owns is a clock turn on that handle (K-09 README "A clock's firing"; K-05 v1 default 9): its one
//      event id is the clock row's id, its id that event id's hash by the turn lease's own `turnIdOf` (CQ-09, CQ-69), its
//      trace id the firing's, tries 1; caller kind turn. A row no handle owns has no turn (caller kind clockFiring, the
//      clock row's id as the request id).
//   4. It calls K-09 gateAndCommit with input.kind clock (no decide reads, no core actions), handing on what the actor
//      holds at commit time (CommitContext), which commits through K-05 v1 fireClock. Fired answers once; a repeat answers
//      `repeated` with the first firing (the sweep and the alarm race by design: arch 10 line 540), never an error.
//   5. It records one `clockFired` span on the firing's trace: labels and counts only.
//
// `InFlight` keeps one firing per clock row in flight in an isolate (an actor, or the Worker's jobs), so the alarm, the
// sweep and Fire now firing one row at the same moment share one call; K-05's compare-and-set keeps it once across
// isolates. Never throws: a firing that cannot finish reports `failed` and the row stays armed for the next pass.
// Never logged or put in a span: a clock row's `fires`, a word, a number.

import { turnIdOf, type CommitContext, type CommitTurnRef } from "../actor/lease";
import {
  isLabel,
  logSink,
  openTrace,
  type BundleId,
  type LogContext,
  type SpanFacts,
  type TraceContext,
} from "../trace";
import type { RowRef } from "../trace/types";
import type {
  ClockCaller,
  ClockDeps,
  ClockFired,
  ClockGateRequest,
  ClockKind,
  DueClock,
  FireBy,
  FireOutcome,
  FireReport,
} from "./types";

let deps: ClockDeps | null = null;

/** Sets the clocks' ports for this Worker isolate; returns the function that puts the earlier ones back. */
export function setClockDeps(next: ClockDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** The clocks' ports for this isolate, or null before D-017 joins them (nothing fires: fails closed). */
export function clockDeps(): ClockDeps | null {
  return deps;
}

/** What a firing needs from where it runs: the handle's actor, or the Worker for a row no handle owns. */
export interface FireHost {
  /** Epoch milliseconds now: the actor's clock in the actor (the stored schedule's), the cron's time in the sweep. */
  now(): number;
  /** The safety holds open and the texts not read yet, read at commit time; a row no handle owns has none. */
  context(): CommitContext;
  /** The environment and build every log line carries (ADR-009). */
  logContext(): LogContext;
  /** True on staging, the one place Fire now may fire (BP 9.4: never in production). */
  staging(): boolean;
}

/** The job id a firing's log entries carry (K-04 event_log_turn_or_job), one per clock row, as K-05's fixtures spell it. */
export function jobIdOf(clockRowId: string): string {
  return `job-fire-${clockRowId}`;
}

/** An instant as K-05 writes it: UTC to the whole second, ending in Z (CQ-09). */
export function utcOf(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLabelOrNull = (value: unknown): value is string | null => value === null || isLabel(value);

const CLOCK_KINDS: readonly ClockKind[] = ["question", "never_delivered", "saved_time", "step", "job"];

/**
 * True when a due row can be fired and logged: its ids are labels (never words or a number), its version a count from
 * 1, its kind K-04's, its due time an instant. A row that is not is never fired here (fails closed).
 */
export function isDueClock(value: unknown): value is DueClock {
  if (!isRecord(value)) return false;
  const version = value.version;
  return (
    isLabel(value.clockRowId) &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1 &&
    typeof value.kind === "string" &&
    (CLOCK_KINDS as readonly string[]).includes(value.kind) &&
    isLabelOrNull(value.handleId) &&
    isLabelOrNull(value.businessId) &&
    typeof value.dueAt === "string" &&
    Number.isFinite(Date.parse(value.dueAt))
  );
}

/** A K-05 v1 dueClocks answer, checked: the rows that can be fired, and the next due time in epoch milliseconds. */
export interface DueRead {
  rows: DueClock[];
  nextDueAt: number | null;
}

/** K-05 v1 dueClocks' answer as a due read, or null when it is not one (transient, or another shape). */
export function dueReadOf(answer: unknown): DueRead | null {
  if (!isRecord(answer) || answer.result !== "due" || !Array.isArray(answer.rows)) return null;
  const next = answer.nextDueAt ?? null;
  if (next !== null && (typeof next !== "string" || !Number.isFinite(Date.parse(next)))) return null;
  return {
    rows: (answer.rows as unknown[]).filter(isDueClock),
    nextDueAt: next === null ? null : Date.parse(next),
  };
}

/** The error code an answer carries, when it is a label; else badAnswer. */
export function codeOf(answer: unknown): string {
  return isRecord(answer) && isLabel(answer.error) ? answer.error : "badAnswer";
}

/** One firing per clock row in flight: a second firing of a row while one runs is handed the first one's result. */
export class InFlight {
  private readonly running = new Map<string, Promise<FireReport>>();

  run(clockRowId: string, fire: () => Promise<FireReport>): Promise<FireReport> {
    const known = this.running.get(clockRowId);
    if (known !== undefined) return known;
    const started = fire().finally(() => {
      this.running.delete(clockRowId);
    });
    this.running.set(clockRowId, started);
    return started;
  }
}

/** The Worker's own firings (rows no handle owns, by the sweep or Fire now), one per row in flight. */
export const jobFirings = new InFlight();

const HASH = /^[0-9a-f]{64}$/u;

/** K-05 v1 readActiveBundle, checked: the active bundle id, or why there is none (a label). */
async function activeBundleOf(set: ClockDeps): Promise<BundleId | string> {
  let answer: unknown;
  try {
    answer = await set.registry.readActiveBundle({});
  } catch {
    return "noAnswer";
  }
  if (!isRecord(answer)) return "badAnswer";
  if (answer.error === "noActiveBundle" || answer.error === "transient") return answer.error;
  const id = answer.bundleId;
  if (answer.result !== "active" || !isRecord(id)) return "badAnswer";
  const { hash, build } = id;
  if (typeof hash !== "string" || !HASH.test(hash)) return "badAnswer";
  if (typeof build !== "number" || !Number.isInteger(build) || build < 1) return "badAnswer";
  return { hash, build };
}

/** K-09's fired answer for this request (this row, this turn), or null when the answer is not one. */
function firedOf(value: unknown, request: ClockGateRequest): ClockFired | null {
  if (!isRecord(value) || value.result !== "fired") return null;
  if (value.clockRowId !== request.input.clockRowId) return null;
  if ((value.turnId ?? null) !== (request.turn?.id ?? null)) return null;
  if (typeof value.version !== "number" || typeof value.repeated !== "boolean") return null;
  if (typeof value.firedAt !== "string") return null;
  const written = value.written;
  if (!isRecord(written) || !Array.isArray(written.written) || !Array.isArray(written.outboxRows))
    return null;
  return value as unknown as ClockFired;
}

/** Errors that say the call could not run (failed: fired again later) rather than that it was refused. */
const FAILED_CODES: ReadonlySet<string> = new Set(["noAnswer", "transient", "unwired", "badAnswer"]);

function outcomeOf(code: string): FireOutcome {
  if (code === "notArmed" || code === "notDue" || code === "versionChanged") return code;
  return FAILED_CODES.has(code) ? "failed" : "refused";
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/u;

/** The rows a first firing wrote, for its span: tables and ids only (K-08 v1 rowRef). */
function rowsOf(fired: ClockFired): RowRef[] {
  const rows: RowRef[] = [];
  for (const row of fired.written.written) {
    if (isRecord(row) && typeof row.table === "string" && TABLE_NAME.test(row.table) && isLabel(row.rowId)) {
      rows.push({ table: row.table, id: row.rowId });
    }
  }
  for (const row of fired.written.outboxRows) {
    if (isRecord(row) && isLabel(row.id)) rows.push({ table: "outbox_rows", id: row.id });
  }
  return rows;
}

type Timer = ReturnType<TraceContext["start"]>;

/** Records a span; a span the trace refuses is not kept, and the firing stands. */
function finish(span: Timer, fields: Parameters<Timer["finish"]>[0]): void {
  try {
    span.finish(fields);
  } catch {
    // No span for this firing; what it did stands.
  }
}

/** One JSON log line for a firing that could open no trace (no bundle id to put on a span), with its own trace id. */
function logUntraced(host: FireHost, row: DueClock, by: FireBy, code: string): void {
  try {
    const context = host.logContext();
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "clockFiring",
        trace_id: crypto.randomUUID(),
        job_id: jobIdOf(row.clockRowId),
        by,
        outcome: "failed",
        error_code: code,
        environment: context.environment,
        version: context.version,
      }),
    );
  } catch {
    // No line; the report says it.
  }
}

/**
 * Fires one clock row once (steps 1 to 5 above) and says how it ended. Never throws: a row that cannot be fired is
 * refused, and a call that fails leaves the row armed for the next pass.
 */
export async function fireOnce(row: DueClock, by: FireBy, host: FireHost): Promise<FireReport> {
  const clockRowId = isRecord(row) && typeof row.clockRowId === "string" ? row.clockRowId : "";
  const report = (
    outcome: FireOutcome,
    errorCode: string | null,
    rest: Partial<FireReport> = {},
  ): FireReport => ({
    clockRowId,
    by,
    outcome,
    repeated: false,
    turnId: null,
    traceId: null,
    errorCode,
    ...rest,
  });
  if (!isDueClock(row)) return report("refused", "badRow");
  if (by === "fireNow" && !host.staging()) return report("refused", "notStaging");
  const set = deps;
  if (set === null) return report("failed", "unwired");

  const bundleId = await activeBundleOf(set);
  if (typeof bundleId === "string") {
    logUntraced(host, row, by, bundleId);
    return report("failed", bundleId);
  }

  let trace: TraceContext;
  let turnId: string | null;
  try {
    trace = openTrace({
      openedBy: by === "sweep" ? "sweep" : "clockFiring",
      bundleId,
      jobId: jobIdOf(row.clockRowId),
      handleRef: row.handleId,
      sink: logSink(host.logContext()),
      now: () => host.now(),
    });
    turnId = row.handleId === null ? null : await turnIdOf([row.clockRowId]);
    if (turnId !== null) trace.setTurn(turnId);
  } catch {
    return report("refused", "badRow");
  }

  const firedAt = utcOf(host.now());
  const turn: CommitTurnRef | null =
    row.handleId === null || turnId === null
      ? null
      : {
          id: turnId,
          handleId: row.handleId,
          eventIds: [row.clockRowId],
          bundleId: { hash: bundleId.hash, build: bundleId.build },
          traceId: trace.traceId,
          joinedTraceIds: [],
          tries: 1,
        };
  const caller: ClockCaller =
    turn === null
      ? {
          kind: "clockFiring",
          turnId: null,
          requestId: row.clockRowId,
          businessId: row.businessId,
          personId: null,
          traceId: trace.traceId,
        }
      : {
          kind: "turn",
          turnId: turn.id,
          requestId: turn.id,
          businessId: row.businessId,
          personId: null,
          traceId: trace.traceId,
        };
  const request: ClockGateRequest = {
    caller,
    turn,
    input: {
      kind: "clock",
      clockRowId: row.clockRowId,
      expectVersion: row.version,
      firedAt,
      by,
      jobId: jobIdOf(row.clockRowId),
    },
    core: [],
    now: firedAt,
  };

  const span = trace.start("clockFired");
  const got: SpanFacts = { by, kind: row.kind, version: row.version };
  const where = {
    eventId: row.clockRowId,
    ...(row.businessId !== null ? { businessId: row.businessId } : {}),
  };
  const traced = { turnId, traceId: trace.traceId };

  let at: CommitContext;
  try {
    at = host.context();
  } catch {
    // What the actor holds cannot be read: nothing goes to the gate (fails closed), and the row stays armed.
    finish(span, { outcome: "failed", ...where, got, errorCode: "noContext" });
    return report("failed", "noContext", traced);
  }

  let answer: unknown;
  try {
    answer = await set.gate.gateAndCommit(request, at, trace);
  } catch {
    answer = { error: "noAnswer" };
  }

  const fired = firedOf(answer, request);
  if (fired !== null) {
    finish(span, {
      outcome: "ok",
      ...where,
      got,
      decided: {
        repeated: fired.repeated,
        version: fired.version,
        outboxRows: fired.written.outboxRows.length,
        effects: Array.isArray(fired.effects) ? fired.effects.length : 0,
      },
      rows: fired.repeated ? [] : rowsOf(fired),
    });
    return report("fired", null, { ...traced, repeated: fired.repeated });
  }
  const code = codeOf(answer);
  const outcome = outcomeOf(code);
  finish(span, { outcome: outcome === "failed" ? "failed" : "refused", ...where, got, errorCode: code });
  return report(outcome, code, traced);
}
