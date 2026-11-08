// The clock rows' shapes and ports (T-254; C-054, C-035; arch 10 'Clocks and queues', line 540; arch 01 'Clock row',
// line 83), written by hand from the frozen contracts, because the generated types are git-ignored (ADR-005) and the
// Worker must not depend on them. Only what the clocks build or read is typed:
//
//   - K-05 v1 item 6, `dueClocks` (contracts/data-access): for one handle, its armed rows due by now, earliest first, and
//     `nextDueAt`, its earliest armed row after now, where the actor sets its one alarm (due-for-handle.json); for the
//     minute sweep, armed rows no handle owns due by now and handle rows due before `missedBefore`, the rows an actor
//     missed (due-for-sweep.json). A read: the firing does the compare-and-set.
//   - K-09 v1 `gateAndCommit` with `input.kind` clock (contracts/tool-api README "A clock's firing"; QUESTIONS.md
//     NQ-RT-4): the step's clock branch, the safe default and who is told, with no decide reads and the firing's own
//     trace id (CQ-06), committed through K-05 v1 item 7, `fireClock`, which fires a row once: a repeat, such as the
//     minute sweep after the alarm, returns the first firing with `repeated` true, never an error (fire-once.json,
//     fire-repeat.json; clock-staff-invite-48h.json and its repeat).
//   - K-05 v1 item 11, `readActiveBundle`: the bundle id a clock turn names (arch 10 line 548: the bundle id on every turn).
//
// Every outside call is a port, set once per Worker isolate (`setClockDeps`) and joined at D-017; T-197 builds K-05's due
// and fire calls. Never logged, put in a span or sent on: a clock row's `fires` (a step's safe default, in words), a word,
// a number. The ids, kinds and codes here are labels.

import type { CommitContext, CommitTurnRef } from "../actor/lease";
import type { BundleRegistry } from "../bundle/types";
import type { TraceContext } from "../trace";

// ---- K-05 v1: due clock rows -------------------------------------------------------------------------------------

/** K-04 clock_rows.kind (arch 02 line 127; arch 05 line 247; arch 10 line 540). */
export type ClockKind = "question" | "never_delivered" | "saved_time" | "step" | "job";

/** K-05 v1 `dueClock`: a due clock row, as the firing needs it (K-04 clock_rows). */
export interface DueClock {
  clockRowId: string;
  /** The row's version, which the firing compares and sets (K-05 v1 fireClock.request.expectVersion). */
  version: number;
  kind: ClockKind;
  /** The handle that owns the row, or null for a row no handle owns (monthly billing: the sweep's). */
  handleId: string | null;
  businessId: string | null;
  bookingId: string | null;
  openQuestionId: string | null;
  reservationId: string | null;
  dueAt: string;
  dueZone: string;
  /** What the row fires (a step and its safe default, or a job): the gate's to read; never logged or sent on here. */
  fires: Record<string, unknown>;
}

/** K-05 v1 `dueClocks.request`: for one handle's alarm, or for the minute sweep. */
export type DueClocksRequest =
  | { for: "handle"; handleId: string; now: string; limit: number }
  | { for: "sweep"; now: string; missedBefore: string; limit: number };

/** K-05 v1 `dueClocks.response`: earliest due first; `nextDueAt` is the handle's earliest armed row after now. */
export interface DueClocksResponse {
  result: "due";
  rows: DueClock[];
  nextDueAt: string | null;
}

/** K-05 v1 `transientError`: nothing was read; the same call may be sent again. */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

export type DueClocksAnswer = DueClocksResponse | TransientError;

/** K-05 v1's due read (item 6), primary and uncached; T-197 builds it, D-017 joins it. */
export interface ClockData {
  dueClocks(request: DueClocksRequest): Promise<DueClocksAnswer>;
}

// ---- K-09 v1: a clock's firing through the gate --------------------------------------------------------------------

/** Who fires (K-05 v1 fireClock.request.by; K-09 v1 clockInput.by): the actor's alarm, the minute sweep, or staging's Fire now. */
export type FireBy = "alarm" | "sweep" | "fireNow";

/**
 * K-09 v1 `caller` for a clock's firing: a clock turn on the row's handle (kind turn, its turn id again as the request
 * id), or a firing with no turn (kind clockFiring, no turn id, the clock row's id as the request id). No person: a clock
 * acts for no one.
 */
export interface ClockCaller {
  kind: "turn" | "clockFiring";
  turnId: string | null;
  requestId: string;
  businessId: string | null;
  personId: null;
  traceId: string;
}

/** K-09 v1 `clockInput`: the row, the version read, when and by whom it fires, and the job id its log entries carry. */
export interface ClockInput {
  kind: "clock";
  clockRowId: string;
  expectVersion: number;
  firedAt: string;
  by: FireBy;
  jobId: string;
}

/**
 * K-09 v1 `gateAndCommit.request` for a clock's firing: the clock turn (its one event id the clock row's id, its id that
 * event id's hash, its trace id the firing's own), or null for a row no handle owns; no core actions (a clock's turn
 * carries none: the named rule clockTurn).
 */
export interface ClockGateRequest {
  caller: ClockCaller;
  turn: CommitTurnRef | null;
  input: ClockInput;
  core: never[];
  now: string;
}

/** K-09 v1 `gateAndCommit.fired`: the row fired once with its branch's writes; a repeat writes nothing (`repeated`). */
export interface ClockFired {
  readonly result: "fired";
  readonly clockRowId: string;
  readonly version: number;
  readonly firedAt: string;
  readonly turnId: string | null;
  readonly repeated: boolean;
  readonly core: readonly unknown[];
  readonly written: {
    readonly written: readonly unknown[];
    readonly outboxRows: readonly unknown[];
    readonly promoted: readonly unknown[];
  };
  readonly effects: readonly unknown[];
  readonly openQuestions: { readonly opened: readonly unknown[]; readonly closed: readonly unknown[] };
}

/** A K-09 error: notArmed, notDue, versionChanged, constraint, transient and the rest; nothing was written. */
export interface ToolApiError {
  readonly error: string;
  readonly [field: string]: unknown;
}

export type ClockGateAnswer = ClockFired | ToolApiError;

/**
 * K-09 v1 gateAndCommit for a clock's firing (C-074, the Tool API; it commits through K-05 v1 fireClock). `at` is what the
 * handle's actor holds at commit time (the safety holds open and the texts not read yet: CQ-65, DL-127), so the gate
 * holds a routine safe default as it holds a turn's; a row no handle owns has neither. The same port shape as the turn
 * face's gateAndCommit (runtime/src/turn), joined to the same Tool API at D-017.
 */
export interface ClockGate {
  gateAndCommit(request: ClockGateRequest, at: CommitContext, trace: TraceContext): Promise<ClockGateAnswer>;
}

/** Where a clock row's handle lives: its actor's name (actorNameOf over K-04 handles' kind and address), or null. */
export interface ClockDirectory {
  actorNameOf(handleId: string): Promise<string | null>;
}

/** What the clocks reach outside the actor, set once per Worker isolate (`setClockDeps`); joined at D-017. */
export interface ClockDeps {
  readonly data: ClockData;
  readonly gate: ClockGate;
  /** K-05 v1 readActiveBundle: the same registry port as the bundle pin's (runtime/src/bundle). */
  readonly registry: Pick<BundleRegistry, "readActiveBundle">;
  readonly directory: ClockDirectory;
}

// ---- what a firing ends with --------------------------------------------------------------------------------------

/**
 * How one firing ended: fired (the first firing or a repeat of it); refused by the call (the row not armed, not due, its
 * version moved, or another refusal) or here (a row that cannot be fired, Fire now off staging, a row for another handle);
 * failed (no answer, transient, unwired: the row stays armed and is fired again later).
 */
export type FireOutcome = "fired" | "notArmed" | "notDue" | "versionChanged" | "refused" | "failed";

/** One firing's result, in labels only. */
export interface FireReport {
  clockRowId: string;
  by: FireBy;
  outcome: FireOutcome;
  repeated: boolean;
  /** The clock turn's id, or null for a firing with no turn (or one that never reached the gate). */
  turnId: string | null;
  /** The firing's own trace id (CQ-06), or null when no trace could be opened. */
  traceId: string | null;
  errorCode: string | null;
}

/** The handle actor's clock calls, as the minute sweep and staging's Fire now reach them. */
export interface ClockActorRpc {
  fireClockRow(request: { row: DueClock; by: FireBy }): Promise<FireReport>;
}

/** The slice of the HandleActor namespace the sweep and Fire now use. */
export interface ClockActors<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): ClockActorRpc;
}
