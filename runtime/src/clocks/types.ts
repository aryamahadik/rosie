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
//   - T-255's arming: K-05 v1 item 5, `armClock` and `cancelClock` (arm-clock.json, cancel-clock.json); the question's
//     facts the due rule reads (a port with no contract yet); K-17 v1 `geocode` for a flow B visit address's zone (CQ-08).
//
// Every outside call is a port, set once per Worker isolate (`setClockDeps`) and joined at D-017; T-197 builds K-05's due
// and fire calls. Never logged, put in a span or sent on: a clock row's `fires` (a step's safe default, in words), a word,
// a number. The ids, kinds and codes here are labels.

import type { CommitContext, CommitTurnRef } from "../actor/lease";
import type { BundleRegistry } from "../bundle/types";
import type { TraceContext } from "../trace";
import type { DueBranch, ZoneFrom } from "./due";

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

/** The handle actor's clock calls, as the minute sweep, staging's Fire now and the clock arming (T-255) reach them. */
export interface ClockActorRpc {
  fireClockRow(request: { row: DueClock; by: FireBy }): Promise<FireReport>;
  /** After an arming: fire the handle's due rows and keep the actor's one alarm at its earliest armed row (T-254). */
  syncClocks(handleId: string): Promise<FireReport[]>;
}

/** The slice of the HandleActor namespace the sweep, Fire now and the clock arming use. */
export interface ClockActors<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): ClockActorRpc;
}

// ---- K-05 v1: arm a clock row; cancel one (T-255; README item 5; arm-clock.json, cancel-clock.json) -------------------

/**
 * K-05 v1 `armClock.request`: arm a waiting clock row at its first delivery receipt with the due time the due rule worked
 * out, named by its question (the question's clock row) or by the row itself.
 */
export type ArmClockRequest = { deliveredAt: string; dueAt: string; dueZone: string } & (
  { openQuestionId: string } | { clockRowId: string }
);

/** K-05 v1 `armedClock`: the row as armed; `handleId` is the handle whose actor sets its alarm, or null for the sweep. */
export interface ArmedClock {
  clockRowId: string;
  version: number;
  armedAt: string;
  dueAt: string;
  dueZone: string;
  handleId: string | null;
}

/** K-05 v1 `armClock.response`: armed; a later receipt never moves it, and a repeat returns the first arming. */
export interface ArmClockResponse {
  result: "armed";
  repeated: boolean;
  clock: ArmedClock;
}

/** K-05 v1 `ClockClosedError`: the row fired or was cancelled (a question answered before its receipt): nothing arms. */
export interface ClockClosedError {
  error: "clockClosed";
  clockRowId: string;
  state: "fired" | "cancelled";
}

/** K-05 v1 `notFoundError`. */
export interface NotFoundError {
  error: "notFound";
  table: string;
  rowId: string;
}

export type ArmClockAnswer = ArmClockResponse | ClockClosedError | NotFoundError | TransientError;

/** K-05 v1 `cancelClock.request`: cancel a waiting or armed row outside a commit, compared and set on its version. */
export interface CancelClockRequest {
  clockRowId: string;
  expectVersion: number;
  /** For the passed-on path, its open question withdrawn in the same transaction; else null. */
  withdrawQuestion: { openQuestionId: string; expectVersion: number } | null;
  at: string;
}

/** K-05 v1 `cancelClock.response`; a repeat says `repeated`. */
export interface CancelClockResponse {
  result: "cancelled";
  clockRowId: string;
  version: number;
  cancelledAt: string;
  repeated: boolean;
}

/** K-05 v1 `AlreadyFiredError`: it fired first, and the firing stands. */
export interface AlreadyFiredError {
  error: "alreadyFired";
  clockRowId: string;
  firedAt: string;
}

/** K-05 v1 `versionChangedError`. */
export interface VersionChangedError {
  error: "versionChanged";
  changed: readonly { table: string; rowId: string; readVersion: number; currentVersion: number }[];
}

export type CancelClockAnswer =
  CancelClockResponse | AlreadyFiredError | VersionChangedError | NotFoundError | TransientError;

/** K-05 v1 item 5's calls the arming makes, on the primary; T-197 builds them, D-017 joins them. */
export interface ArmingData {
  armClock(request: ArmClockRequest): Promise<ArmClockAnswer>;
  cancelClock(request: CancelClockRequest): Promise<CancelClockAnswer>;
}

// ---- what the due rule reads about a question (no K-05 call returns it yet: a port) -----------------------------------

/**
 * The facts the due rule reads about one open question, beyond its receipt. No frozen call returns them together (K-05
 * v1.2 open gap 25: no call gives a booking's date and time; `sendState`'s `visitZone` is null until K-30 freezes), so
 * this is a port with a fake until a K-05 minor version names the read (QUESTIONS.md). Read on the primary, uncached, as
 * every decision read is (arch 02 line 117).
 */
export interface QuestionFacts {
  openQuestionId: string;
  /** K-04 open_questions.clock: the step's Clock line as it applies, such as "24 h"; null: step 9's default. */
  clockLine: string | null;
  /** K-04 businesses.time_zone of the question's business; null for a question with no business. */
  businessZone: string | null;
  /** The visit the question is about, or null (no booking, or a booking with no time). */
  visit: {
    /** The visit's start, UTC (K-04 reservations.during's lower bound for the booking). */
    startsAt: string;
    /** K-04 bookings.flow: A, the customer comes to the business; B, the business goes to the customer (RULES 2.1). */
    flow: "A" | "B";
    /** Flow B: the visit address's zone, when it is stored with the visit (K-30; CQ-08); null when not. */
    addressZone: string | null;
    /** Flow B: the visit address as given, for the geo port when its zone is not stored. Never logged. */
    address: string | null;
  } | null;
  /**
   * The question's never-delivered clock row (K-04 clock_rows kind never_delivered) and the version read, when its
   * commit made one; null otherwise. Once the question is delivered its never-delivered path no longer applies, so the
   * arming cancels it.
   */
  neverDelivered: { clockRowId: string; version: number } | null;
}

export interface QuestionFactsReader {
  questionFacts(openQuestionId: string): Promise<QuestionFacts | NotFoundError | TransientError>;
}

// ---- K-17 v1: the geo port, for a flow B visit address's zone (CQ-08) ------------------------------------------------

/** K-17 v1 `geocode.request`. */
export interface GeocodeRequest {
  kind: "zip" | "town" | "streetAddress";
  text: string;
}

/** K-17 v1 `match`, as far as the arming reads it: the point's IANA zone. */
export interface GeoMatch {
  timeZone: string;
  readonly [field: string]: unknown;
}

/** K-17 v1 `geocode.response` and `geocode.errors`. */
export type GeocodeAnswer =
  | { result: "found"; matches: readonly GeoMatch[] }
  | { result: "notFound" }
  | { error: "unavailable" | "rateLimited" | "badRequest"; retryAfterSeconds: number | null };

/** K-17 v1's one call (C-220's adapter or its double; joined at D-017). */
export interface GeoPort {
  geocode(request: GeocodeRequest): Promise<GeocodeAnswer>;
}

// ---- the arming's result --------------------------------------------------------------------------------------------

/**
 * How one arming ended:
 *   armed       the question's clock row armed now;
 *   repeated    already armed by an earlier receipt (K-05's repeat answer, or this isolate's memory): nothing armed twice;
 *   notFirst    not the row's first delivery: nothing to arm;
 *   noQuestion  the delivered row asks no question;
 *   closed      the row fired or was cancelled before its receipt (K-05 clockClosed);
 *   notFound    the question, or its clock row, does not exist;
 *   refused     an input the arming cannot use (nothing was read or sent);
 *   failed      no answer it could use: nothing armed.
 */
export type ArmOutcome =
  "armed" | "repeated" | "notFirst" | "noQuestion" | "closed" | "notFound" | "refused" | "failed";

/** One arming's result, in labels only: never the due time, the zone, the Clock line's words or an address. */
export interface ArmReport {
  outcome: ArmOutcome;
  openQuestionId: string | null;
  clockRowId: string | null;
  /** The due rule's branch, when it ran. */
  branch: DueBranch | null;
  /** Where the zone came from, when the due rule ran. */
  zoneFrom: ZoneFrom | null;
  /** True when the Clock line could not be read and step 9's default was used. */
  clockLineUnread: boolean;
  /** The question's never-delivered row: cancelled, alreadyFired, none (it has none), failed, or null (not reached). */
  neverDelivered: "cancelled" | "alreadyFired" | "none" | "failed" | null;
  /** True when the handle's actor was told (`syncClocks`) and answered. */
  synced: boolean;
  errorCode: string | null;
}
