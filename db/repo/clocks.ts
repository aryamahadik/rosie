// Data-access K-05 v1 items 5 to 7: arm, cancel, list due and fire clock rows (T-197; C-152; K-05 README items 5, 6
// and 7, with v1.1 items 18 and 19 for a firing's effects and waiting rows; arch 01 line 83; arch 02 line 127; arch 10
// lines 508 and 540; BP 9.4). The runtime calls them, never a Tool API path: the clock arming at a first delivery
// receipt (C-055: runtime/src/clocks ArmingData), the actor's one alarm and the minute sweep (C-054: ClockData), and
// every firing, by the alarm, the sweep or staging's "Fire now", through the one fireClock (joined at D-017).
//
//   armClock     A question's clock row (named, or found as its question's own `question` row) moves from waiting to
//                armed with its due time and zone, armed at the first receipt's time, and its open question moves from
//                waiting to open in the same transaction (K-05 default 8). An armed row answers its first arming with
//                repeated true, whatever a later receipt says (a later receipt never moves it); a fired or cancelled row
//                answers clockClosed.
//   cancelClock  Outside a commit (the passed-on path: arch 02 line 123), a waiting or armed row moves to cancelled,
//                compared and set on its version, and with withdrawQuestion its own open question is withdrawn in the
//                same transaction. A cancelled row answers its cancellation with repeated true; a fired row answers
//                alreadyFired: the firing stands.
//   dueClocks    A read, one moment (repeatable read, read only). For one handle's actor: its armed rows due by now,
//                earliest first, and nextDueAt, its earliest armed row due after now, where the actor sets its one alarm
//                (clock_rows_handle_due_idx). For the minute sweep: armed rows no handle owns due by now and handle rows
//                due before missedBefore, the rows an actor missed (clock_rows_due_idx); nextDueAt is null. dueForHandle
//                and dueForSweep are the two callers' forms of it. A read: the firing does the compare-and-set.
//   fireClock    The row is locked first: fired answers the first firing with repeated true, whatever the repeat's body;
//                waiting or cancelled answers notArmed (an unarmed row is never due); another version versionChanged; a
//                due time after firedAt notDue, unless by is fireNow (staging's console; the Tool API allows it on
//                staging alone, K-21). Then, in the same transaction, the row moves to fired with fired_at and the firing
//                commits as commitTurn does: its turn row when given (committed), the locks and compares
//                (reservationLost, versionChanged, wrongState) and the writes in K-05's order, the entries carrying the
//                job id and, with a turn, the turn id (event_log_turn_or_job). The row lock is what makes parallel
//                firings of one row (the alarm, the sweep and Fire now at one moment) fire it once: the others wait for
//                the lock, then find it fired and answer the first firing.
//
// Side (K-05 README "Scope"; T-191's roles): the runtime side, run as rosie_job, each call one transaction on the
// primary, uncached, that starts with no business scope, so the sweep sees rows no handle owns and every business's
// rows. fireClock's writes go per write, as commitTurn's do: before each write the scope is set to that write's own
// business (set_config(..., true)), so row-level security holds each write to its business.
//
// The firing's commit below follows db/repo/commit-turn.ts step for step (its helpers are not exported, and this card
// may not change that file), with two differences a firing needs: the turn may be null (a row no handle owns, or a
// firing that writes no outbox row), so the rows a commit keys on the turn (open questions, outbox rows) need one, and
// what it writes carries the job id instead (effects: job_id; entries: job_id beside the turn id).
//
// Refusals write nothing: the transaction rolls back. A database rule that refuses a firing's write (23P01, 23514,
// 23505, 23503) answers constraint with the SQLSTATE and the constraint's name only; a serialization failure, a deadlock
// or a lost connection answers transient (the same request may be sent again); a request this layer cannot carry out
// throws, and a database refusal no K-05 answer names throws DataAccessDatabaseError, with nothing written either.
//
// Nothing here logs. What it throws names a call, a table, a column or a fault, never a value or a row id; a refusal
// never carries PostgresError.detail. A clock row's fires (a step's safe default, in words) is read and returned, never
// put in an error.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. armClock named by its question finds the question's rows of kind question: the live one (waiting or armed) with
//      the lowest id, else the lowest id. No such row answers notFound clock_rows with the question's id as its row id
//      (the row looked for, named as the request named it); no such question answers notFound open_questions.
//   2. armClock moves the open question to open only while it is waiting; a question already open or closed is left as
//      it is (a question answered before its receipt has its clock cancelled by that commit: clockClosed).
//   3. armed_at is the receipt's time (K-05 armClock.request.deliveredAt: "K-04 clock_rows.armed_at"); cancelled_at is
//      the request's `at`; a firing's every time (fired_at, its turn's committed_at, each write's time, each entry's at)
//      is firedAt, the firing's one moment, as commitTurn's are its now() (commit-turn.ts default 10).
//   4. cancelClock's withdrawQuestion must name the row's own question ("withdraws its open question"), still waiting or
//      open at the version read; another question, or a closed one, is a request this call cannot carry out (thrown).
//   5. A firing's turn is the clock turn of K-05 default 9: its handle is the row's and its one event id the row's id
//      (a request with another is thrown), so a repeat finds the first firing's turn by those two, whatever its body.
//   6. A firing names its own row only by clockRowId and expectVersion: versionsRead or clockRows.cancel naming it is
//      thrown (the row is compared and fired by this call).
//   7. A firing with no turn opens no question and writes no outbox row (both need a turn: K-04 open_questions.turn_id
//      and outbox_rows.turn_id are not null; refuse-fire-without-turn-writes-outbox), and its entries carry the job id
//      as their trace id, since K-05 v1 gives a turnless firing no trace id (event_log.trace_id is not null); an effect
//      keeps its own traceId.
//   8. The sweep's missedBefore may not be after its now (a row is not missed before it is due); the limits are the
//      schema's (1 to 100 for a handle, 1 to 1000 for the sweep). Rows of equal due time come in id order (collate "C",
//      compared, never parsed: CQ-09).
//   9. A firing's state write gives a bytea column (a sealed value) in K-04's text form, "\x" and hex digit pairs, and
//      it is written as the bytes it spells, as commitTurn's are (commit-turn.ts default 11; bytea.ts; T-1185):
//      postgres.js would store a string's own characters. A value in any other form throws, and nothing is written.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.1";
import { byteaFromText } from "./bytea";
import { NOT_STATE_TABLES } from "./commit-turn";
import { appendEvent, type EventContext, type EventEntry as LogEntry } from "./event-log";
import { releaseIn } from "./reservations";
import { assertBusinessId, SCOPE_SETTING, type Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction, transientOrThrow, utc } from "./targets";

type Json = Parameters<Sql["json"]>[0];
type Row = Record<string, unknown>;
/** An optional field of event-log.ts's entry as these calls always give it: present, a value or null. */
type Given<T> = Exclude<T, undefined>;
type ChangedRow = K05.ChangedRow;
type RowRef = K05.RowRef;
type Promotion = K05.Promotion;
type LostReservation = K05.ReservationLostError["reservations"][number];

// ---- the calls' shapes (K-05 v1, through v1.1's names) ------------------------------------------------------------------

/** K-05 v1 armClock.request: named by the clock row or by its question (exactly one), with the due time worked out. */
export type ArmClockRequest = { deliveredAt: string; dueAt: string; dueZone: string } & (
  { clockRowId: string } | { openQuestionId: string }
);
export type ArmClockResponse = K05.ArmClockResponse;
export type ArmClockError = K05.ClockClosedError | K05.NotFoundError | K05.TransientError;
export type ArmClockOutcome = ArmClockResponse | ArmClockError;

export type CancelClockRequest = K05.CancelClockRequest;
export type CancelClockResponse = K05.CancelClockResponse;
export type CancelClockError =
  K05.AlreadyFiredError | K05.VersionChangedError | K05.NotFoundError | K05.TransientError;
export type CancelClockOutcome = CancelClockResponse | CancelClockError;

/** K-05 v1 dueClocks.request: for one handle's actor, or for the minute sweep. */
export type DueClocksRequest =
  | { for: "handle"; handleId: string; now: string; limit: number }
  | { for: "sweep"; now: string; missedBefore: string; limit: number };
export type DueClock = K05.DueClock;
export type DueClocksResponse = K05.DueClocksResponse;
export type DueClocksOutcome = DueClocksResponse | K05.TransientError;

export type FireClockRequest = K05.FireClockRequest;
export type FireClockResponse = K05.FireClockResponse;
export type FireClockError = K05.FireClockErrors;
export type FireClockOutcome = FireClockResponse | FireClockError;

// ---- request checks ---------------------------------------------------------------------------------------------------

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BUNDLE_HASH = /^[0-9a-f]{64}$/;
/** formats.v1 utc: an RFC 3339 instant ending in Z. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
/** formats.v1 zone, the pattern K-04's clock_rows_due_zone_form holds too. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const CLOCK_KINDS = new Set(["question", "never_delivered", "saved_time", "step", "job"]);
const CALENDAR_PROVIDERS = new Set(["google", "microsoft"]);
const FIRE_BY = new Set(["alarm", "sweep", "fireNow"]);
/** A database rule that refuses a write answers `constraint` (K-05 README item 1). */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A request a call cannot carry out: thrown before anything is written (or inside the transaction, rolling it back). */
function fail(call: string, what: string): never {
  throw new TypeError(`${call}: ${what}`);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An opaque id (formats.v1 id): a non-empty string with no NUL, compared whole and never parsed (CQ-09). */
function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\u0000");
}

function assertId(call: string, value: unknown, what: string): asserts value is string {
  if (!isId(value)) {
    fail(call, `${what} is not a non-empty id`);
  }
}

function assertNullableId(call: string, value: unknown, what: string): asserts value is string | null {
  if (value !== null) {
    assertId(call, value, what);
  }
}

function assertVersion(call: string, value: unknown, what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(call, `${what} is not a version (a positive integer)`);
  }
}

function assertName(call: string, value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !NAME.test(value)) {
    fail(call, `${what} is not a plain lower-case SQL name`);
  }
}

/** formats.v1 utc, and a date that exists ("whether the date exists is a code check"). */
export function instantOf(call: string, value: unknown, what: string): Date {
  if (typeof value !== "string" || !UTC.test(value)) {
    fail(call, `${what} is not an instant in UTC ending in Z`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    fail(call, `${what} is not a date that exists`);
  }
  return date;
}

/** Whether the IANA database (through Intl) knows the zone. */
function knownZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** formats.v1 zone, and a zone the IANA database knows ("whether the zone exists ... is a code check"). */
function assertZone(call: string, value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !ZONE.test(value) || !knownZone(value)) {
    fail(call, `${what} is not an IANA zone name`);
  }
}

function idField(call: string, record: Row, field: string, what: string): string {
  const value = record[field];
  assertId(call, value, `${what}.${field}`);
  return value;
}

function nullableIdField(call: string, record: Row, field: string, what: string): string | null {
  const value = record[field];
  assertNullableId(call, value, `${what}.${field}`);
  return value;
}

function objectField(call: string, record: Row, field: string, what: string): Row {
  const value = record[field];
  if (!isRecord(value)) {
    fail(call, `${what}.${field} is not an object`);
  }
  return value;
}

function listOf(call: string, record: Row, field: string, what: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    fail(call, `${what}.${field} is not a list`);
  }
  return value as unknown[];
}

/**
 * K-05 v1 turn: what a commit, a firing or a park writes into turns, checked before the database is reached. `tries`
 * names the one try a call takes (a park's 3), else any of 1 to 3.
 */
export function checkTurn(call: string, turn: unknown, tries?: 1 | 2 | 3): void {
  if (!isRecord(turn)) {
    fail(call, "turn is not an object");
  }
  idField(call, turn, "id", "turn");
  idField(call, turn, "handleId", "turn");
  idField(call, turn, "traceId", "turn");
  const eventIds = listOf(call, turn, "eventIds", "turn");
  if (eventIds.length === 0) {
    fail(call, "turn.eventIds is empty: a turn joins at least one event");
  }
  eventIds.forEach((id) => {
    assertId(call, id, "turn.eventIds[]");
  });
  listOf(call, turn, "joinedTraceIds", "turn").forEach((id) => {
    assertId(call, id, "turn.joinedTraceIds[]");
  });
  const bundle = objectField(call, turn, "bundleId", "turn");
  if (typeof bundle.hash !== "string" || !BUNDLE_HASH.test(bundle.hash)) {
    fail(call, "turn.bundleId.hash is not 64 lower-case hex characters");
  }
  assertVersion(call, bundle.build, "turn.bundleId.build");
  if (tries === undefined ? ![1, 2, 3].includes(turn.tries as number) : turn.tries !== tries) {
    fail(call, tries === undefined ? "turn.tries is not 1, 2 or 3" : `turn.tries is not ${String(tries)}`);
  }
}

/** K-05 v1 outboxRowNew, checked: its ids, and no plan or final parts (words are written after the commit). */
export function checkOutboxRowNew(call: string, row: unknown): void {
  const what = "outboxRows[]";
  if (!isRecord(row)) {
    fail(call, `${what} is not an object`);
  }
  if (Object.hasOwn(row, "plan") || Object.hasOwn(row, "finalParts")) {
    fail(call, "an outbox row carries no plan here: words are written into it after the commit");
  }
  idField(call, row, "id", what);
  idField(call, row, "recipientHandleId", what);
  nullableIdField(call, row, "recipientPersonId", what);
  nullableIdField(call, row, "businessId", what);
  nullableIdField(call, row, "bookingId", what);
  nullableIdField(call, row, "openQuestionId", what);
  nullableIdField(call, row, "copyOfRowId", what);
  listOf(call, row, "versionsRead", what);
}

/** K-05 v1 eventEntry, checked: its id and business (the rest is the event log's and K-08's). */
export function checkEventEntry(call: string, entry: unknown): void {
  if (!isRecord(entry)) {
    fail(call, "events[] is not an object");
  }
  idField(call, entry, "id", "events[]");
  nullableIdField(call, entry, "businessId", "events[]");
}

// ---- the database's answers ---------------------------------------------------------------------------------------------

/**
 * A database refusal as it leaves one of these calls when no K-05 answer names it: its SQLSTATE and the names of its
 * table and constraint, never PostgresError's message, detail or query, which can hold a row's values.
 */
export class DataAccessDatabaseError extends Error {
  constructor(
    readonly call: string,
    readonly code: string,
    readonly table: string | null,
    readonly constraint: string | null,
  ) {
    const names = [
      table === null ? "" : `, table ${table}`,
      constraint === null ? "" : `, constraint ${constraint}`,
    ];
    super(`${call}: the database refused the call (SQLSTATE ${code}${names.join("")})`);
    this.name = "DataAccessDatabaseError";
  }
}

function nameOrNull(value: unknown): string | null {
  return typeof value === "string" && NAME.test(value) ? value : null;
}

/** A PostgreSQL error as DataAccessDatabaseError; any other error as it is. */
export function scrubbed(call: string, error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "PostgresError") {
    return error;
  }
  const failure = error as Error & { code?: unknown; table_name?: unknown; constraint_name?: unknown };
  if (typeof failure.code !== "string" || !SQLSTATE.test(failure.code)) {
    return error;
  }
  return new DataAccessDatabaseError(
    call,
    failure.code,
    nameOrNull(failure.table_name),
    nameOrNull(failure.constraint_name),
  );
}

/** The transient answer, or the error thrown on, scrubbed of any value (K-05 README: every call may answer transient). */
export function transientOrScrubbed(call: string, error: unknown): K05.TransientError {
  try {
    return transientOrThrow(error);
  } catch {
    throw scrubbed(call, error);
  }
}

/** A database rule's refusal as K-05's constraint answer: the SQLSTATE and the constraint's name, nothing else. */
function constraintOf(error: unknown): K05.ConstraintError | null {
  const failure = error as { code?: unknown; constraint_name?: unknown } | null | undefined;
  const code = failure?.code;
  const constraint = failure?.constraint_name;
  if (typeof code === "string" && CONSTRAINT_SQLSTATES.has(code) && typeof constraint === "string") {
    if (NAME.test(constraint)) {
      return { error: "constraint", sqlstate: code, constraint };
    }
  }
  return null;
}

/** Thrown inside fireClock's transaction to roll it back and answer one of K-05's refusals. */
class Refused extends Error {
  constructor(readonly answer: FireClockError) {
    super("fireClock refused");
  }
}

// ---- the clock row ------------------------------------------------------------------------------------------------------

type ClockState = "waiting" | "armed" | "fired" | "cancelled";

interface ClockRow {
  id: string;
  kind: K05.DueClock["kind"];
  open_question_id: string | null;
  reservation_id: string | null;
  handle_id: string | null;
  business_id: string | null;
  booking_id: string | null;
  due_at: Date | null;
  due_zone: string | null;
  state: ClockState;
  armed_at: Date | null;
  fires: Record<string, unknown>;
  fired_at: Date | null;
  cancelled_at: Date | null;
  version: number;
}

const CLOCK_COLUMNS =
  "id, kind, open_question_id, reservation_id, handle_id, business_id, booking_id, due_at, due_zone, state, " +
  "armed_at, fires, fired_at, cancelled_at, version";

/** A time K-04's CHECKs promise for the row's state (an armed or fired row has its due time, zone and armed_at). */
function present<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`a clock row's ${what} is missing for its state`);
  }
  return value;
}

async function lockClockRow(tx: Sql, clockRowId: string): Promise<ClockRow | undefined> {
  const [row] = await tx<ClockRow[]>`
    select ${tx.unsafe(CLOCK_COLUMNS)} from clock_rows where id = ${clockRowId} for update
  `;
  return row;
}

// ---- armClock (K-05 v1 item 5) ------------------------------------------------------------------------------------------

interface ArmChecked {
  /** The row as the request names it: by its id, or by its question (default 1). */
  readonly by: { readonly clockRowId: string } | { readonly openQuestionId: string };
  readonly deliveredAt: Date;
  readonly dueAt: Date;
  readonly dueZone: string;
}

function checkArm(request: ArmClockRequest): ArmChecked {
  const call = "armClock";
  assertRequestShape(request, call, ["clockRowId", "openQuestionId", "deliveredAt", "dueAt", "dueZone"]);
  const raw = request as Row;
  const byRow = Object.hasOwn(raw, "clockRowId");
  if (byRow === Object.hasOwn(raw, "openQuestionId")) {
    fail(call, "the request names exactly one of clockRowId and openQuestionId");
  }
  const dueZone = raw.dueZone;
  assertZone(call, dueZone, "dueZone");
  return {
    by: byRow
      ? { clockRowId: idField(call, raw, "clockRowId", "request") }
      : { openQuestionId: idField(call, raw, "openQuestionId", "request") },
    deliveredAt: instantOf(call, raw.deliveredAt, "deliveredAt"),
    dueAt: instantOf(call, raw.dueAt, "dueAt"),
    dueZone,
  };
}

function armedOf(row: ClockRow): K05.ArmedClock {
  return {
    clockRowId: row.id,
    version: row.version,
    armedAt: utc(present(row.armed_at, "armed_at")),
    dueAt: utc(present(row.due_at, "due_at")),
    dueZone: present(row.due_zone, "due_zone"),
    handleId: row.handle_id,
  };
}

/** The question's own clock row (default 1), locked; with none, which of the two is missing. */
async function lockQuestionClock(tx: Sql, openQuestionId: string): Promise<ClockRow | K05.NotFoundError> {
  const rows = await tx<ClockRow[]>`
    select ${tx.unsafe(CLOCK_COLUMNS)} from clock_rows
    where open_question_id = ${openQuestionId} and kind = 'question'
    order by id collate "C"
    for update
  `;
  const live = rows.find((row) => row.state === "waiting" || row.state === "armed");
  const row = live ?? rows[0];
  if (row !== undefined) {
    return row;
  }
  const [question] = await tx<{ id: string }[]>`select id from open_questions where id = ${openQuestionId}`;
  return {
    error: "notFound",
    table: question === undefined ? "open_questions" : "clock_rows",
    rowId: openQuestionId,
  };
}

async function armIn(tx: Sql, request: ArmChecked): Promise<ArmClockOutcome> {
  let row: ClockRow;
  if ("clockRowId" in request.by) {
    const found = await lockClockRow(tx, request.by.clockRowId);
    if (found === undefined) {
      return { error: "notFound", table: "clock_rows", rowId: request.by.clockRowId };
    }
    row = found;
  } else {
    const found = await lockQuestionClock(tx, request.by.openQuestionId);
    if ("error" in found) {
      return found;
    }
    row = found;
  }
  if (row.state === "armed") {
    // A later receipt never moves it: the first arming comes back.
    return { result: "armed", repeated: true, clock: armedOf(row) };
  }
  if (row.state === "fired" || row.state === "cancelled") {
    return { error: "clockClosed", clockRowId: row.id, state: row.state };
  }
  const [armed] = await tx<ClockRow[]>`
    update clock_rows
    set state = 'armed', due_at = ${request.dueAt}, due_zone = ${request.dueZone}, armed_at = ${request.deliveredAt},
        version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state = 'waiting'
    returning ${tx.unsafe(CLOCK_COLUMNS)}
  `;
  if (armed === undefined) {
    throw new Error("armClock: the clock row moved while it was locked");
  }
  if (row.open_question_id !== null) {
    // Default 8: its open question is waiting until its first delivery and open after (default 2: only from waiting).
    await tx`
      update open_questions set status = 'open', version = version + 1
      where id = ${row.open_question_id} and status = 'waiting'
    `;
  }
  return { result: "armed", repeated: false, clock: armedOf(armed) };
}

/**
 * Arms a question's clock row at its first delivery receipt (K-05 v1 item 5; arch 02 line 127): one transaction on the
 * primary, on the runtime side. Pass the client's primary handle, run as rosie_job. Answers armed (repeated true for a
 * row already armed, which moves nothing), clockClosed (the row fired or was cancelled), notFound or transient. Throws
 * for a request it cannot carry out, a database refusal as DataAccessDatabaseError; nothing is written then either.
 */
export async function armClock(sql: Sql, request: ArmClockRequest): Promise<ArmClockOutcome> {
  const checked = checkArm(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => armIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed("armClock", error);
  }
}

// ---- cancelClock (K-05 v1 item 5) ---------------------------------------------------------------------------------------

function checkCancel(request: CancelClockRequest): Date {
  const call = "cancelClock";
  assertRequestShape(request, call, ["clockRowId", "expectVersion", "withdrawQuestion", "at"]);
  const raw = request as unknown as Row;
  idField(call, raw, "clockRowId", "request");
  assertVersion(call, raw.expectVersion, "expectVersion");
  const withdraw = raw.withdrawQuestion;
  if (withdraw !== null) {
    if (!isRecord(withdraw)) {
      fail(call, "withdrawQuestion is neither an object nor null");
    }
    assertRequestShape(withdraw, `${call} withdrawQuestion`, ["openQuestionId", "expectVersion"]);
    idField(call, withdraw, "openQuestionId", "withdrawQuestion");
    assertVersion(call, withdraw.expectVersion, "withdrawQuestion.expectVersion");
  }
  return instantOf(call, raw.at, "at");
}

async function cancelIn(tx: Sql, request: CancelClockRequest, at: Date): Promise<CancelClockOutcome> {
  const row = await lockClockRow(tx, request.clockRowId);
  if (row === undefined) {
    return { error: "notFound", table: "clock_rows", rowId: request.clockRowId };
  }
  if (row.state === "fired") {
    return { error: "alreadyFired", clockRowId: row.id, firedAt: utc(present(row.fired_at, "fired_at")) };
  }
  if (row.state === "cancelled") {
    return {
      result: "cancelled",
      clockRowId: row.id,
      version: row.version,
      cancelledAt: utc(present(row.cancelled_at, "cancelled_at")),
      repeated: true,
    };
  }
  const withdraw = request.withdrawQuestion;
  let question: { id: string; status: string; version: number } | undefined;
  if (withdraw !== null) {
    if (row.open_question_id !== withdraw.openQuestionId) {
      fail("cancelClock", "withdrawQuestion names another question than the clock row's own (default 4)");
    }
    [question] = await tx<{ id: string; status: string; version: number }[]>`
      select id, status, version from open_questions where id = ${withdraw.openQuestionId} for update
    `;
    if (question === undefined) {
      return { error: "notFound", table: "open_questions", rowId: withdraw.openQuestionId };
    }
  }
  const changed: ChangedRow[] = [];
  if (row.version !== request.expectVersion) {
    changed.push({
      table: "clock_rows",
      rowId: row.id,
      readVersion: request.expectVersion,
      currentVersion: row.version,
    });
  }
  if (withdraw !== null && question !== undefined && question.version !== withdraw.expectVersion) {
    changed.push({
      table: "open_questions",
      rowId: question.id,
      readVersion: withdraw.expectVersion,
      currentVersion: question.version,
    });
  }
  const [first, ...rest] = changed;
  if (first !== undefined) {
    return { error: "versionChanged", changed: [first, ...rest] };
  }
  if (question !== undefined && question.status !== "waiting" && question.status !== "open") {
    fail("cancelClock", "the question to withdraw is already closed at the version read (default 4)");
  }
  const [cancelled] = await tx<{ version: number }[]>`
    update clock_rows set state = 'cancelled', cancelled_at = ${at}, version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state in ('waiting', 'armed')
    returning version
  `;
  if (cancelled === undefined) {
    throw new Error("cancelClock: the clock row moved while it was locked");
  }
  if (question !== undefined) {
    const [withdrawn] = await tx<{ id: string }[]>`
      update open_questions set status = 'withdrawn', closed_at = ${at}, version = ${question.version + 1}
      where id = ${question.id} and version = ${question.version}
      returning id
    `;
    if (withdrawn === undefined) {
      throw new Error("cancelClock: the open question moved while it was locked");
    }
  }
  return {
    result: "cancelled",
    clockRowId: row.id,
    version: cancelled.version,
    cancelledAt: utc(at),
    repeated: false,
  };
}

/**
 * Cancels a waiting or armed clock row outside a commit, with its open question withdrawn when asked (K-05 v1 item 5;
 * the passed-on path, arch 02 line 123): one transaction on the primary, on the runtime side. Pass the client's primary
 * handle, run as rosie_job. Answers cancelled (repeated true for a row already cancelled), alreadyFired, versionChanged,
 * notFound or transient. Throws for a request it cannot carry out; nothing is written then either.
 */
export async function cancelClock(sql: Sql, request: CancelClockRequest): Promise<CancelClockOutcome> {
  const at = checkCancel(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => cancelIn(tx, request, at));
  } catch (error) {
    return transientOrScrubbed("cancelClock", error);
  }
}

// ---- dueClocks (K-05 v1 item 6) -----------------------------------------------------------------------------------------

type DueChecked =
  | { readonly for: "handle"; readonly handleId: string; readonly now: Date; readonly limit: number }
  | { readonly for: "sweep"; readonly now: Date; readonly missedBefore: Date; readonly limit: number };

function checkLimit(call: string, value: unknown, most: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > most) {
    fail(call, `limit is not a whole number from 1 to ${String(most)}`);
  }
  return value;
}

function checkDue(request: DueClocksRequest): DueChecked {
  const call = "dueClocks";
  const raw: unknown = request;
  if (!isRecord(raw)) {
    fail(call, "the request is not an object");
  }
  if (raw.for === "handle") {
    assertRequestShape(raw, call, ["for", "handleId", "now", "limit"]);
    return {
      for: "handle",
      handleId: idField(call, raw, "handleId", "request"),
      now: instantOf(call, raw.now, "now"),
      limit: checkLimit(call, raw.limit, 100),
    };
  }
  if (raw.for === "sweep") {
    assertRequestShape(raw, call, ["for", "now", "missedBefore", "limit"]);
    const now = instantOf(call, raw.now, "now");
    const missedBefore = instantOf(call, raw.missedBefore, "missedBefore");
    if (missedBefore.getTime() > now.getTime()) {
      fail(call, "missedBefore is after now: a row is not missed before it is due (default 8)");
    }
    return { for: "sweep", now, missedBefore, limit: checkLimit(call, raw.limit, 1000) };
  }
  return fail(call, "for is neither handle nor sweep");
}

function dueOf(row: ClockRow): DueClock {
  return {
    clockRowId: row.id,
    version: row.version,
    kind: row.kind,
    handleId: row.handle_id,
    businessId: row.business_id,
    bookingId: row.booking_id,
    openQuestionId: row.open_question_id,
    reservationId: row.reservation_id,
    dueAt: utc(present(row.due_at, "due_at")),
    dueZone: present(row.due_zone, "due_zone"),
    fires: row.fires,
  };
}

async function dueIn(tx: Sql, request: DueChecked): Promise<DueClocksResponse> {
  if (request.for === "handle") {
    const rows = await tx<ClockRow[]>`
      select ${tx.unsafe(CLOCK_COLUMNS)} from clock_rows
      where handle_id = ${request.handleId} and state = 'armed' and due_at <= ${request.now}
      order by due_at, id collate "C"
      limit ${request.limit}
    `;
    const [next] = await tx<{ next: Date | null }[]>`
      select min(due_at) as next from clock_rows
      where handle_id = ${request.handleId} and state = 'armed' and due_at > ${request.now}
    `;
    const nextDueAt = next?.next ?? null;
    return { result: "due", rows: rows.map(dueOf), nextDueAt: nextDueAt === null ? null : utc(nextDueAt) };
  }
  const rows = await tx<ClockRow[]>`
    select ${tx.unsafe(CLOCK_COLUMNS)} from clock_rows
    where state = 'armed'
      and ((handle_id is null and due_at <= ${request.now}) or (handle_id is not null and due_at < ${request.missedBefore}))
    order by due_at, id collate "C"
    limit ${request.limit}
  `;
  return { result: "due", rows: rows.map(dueOf), nextDueAt: null };
}

/**
 * Armed clock rows that are due (K-05 v1 item 6): for one handle's actor (its rows due by now and its next due time), or
 * for the minute sweep (rows no handle owns due by now, and handle rows due before missedBefore). One read-only
 * transaction on the primary, uncached, on the runtime side. Pass the client's primary handle, run as rosie_job.
 * Answers due, or transient; throws for a request it cannot carry out.
 */
export async function dueClocks(sql: Sql, request: DueClocksRequest): Promise<DueClocksOutcome> {
  const checked = checkDue(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => dueIn(tx, checked));
  } catch (error) {
    return transientOrScrubbed("dueClocks", error);
  }
}

/** The actor's read (K-05 dueClocks for a handle): its rows due by `now`, earliest first, and its next due time. */
export function dueForHandle(
  sql: Sql,
  request: { handleId: string; now: string; limit: number },
): Promise<DueClocksOutcome> {
  return dueClocks(sql, { for: "handle", ...request });
}

/** The minute sweep's read (K-05 dueClocks for the sweep): rows no handle owns due by `now`, and missed handle rows. */
export function dueForSweep(
  sql: Sql,
  request: { now: string; missedBefore: string; limit: number },
): Promise<DueClocksOutcome> {
  return dueClocks(sql, { for: "sweep", ...request });
}

// ---- fireClock (K-05 v1 item 7, with v1.1 items 18 and 19): the request -------------------------------------------------

/**
 * What code checks before the database is reached (the schema's rules this layer relies on, defaults 5 to 7, and every
 * name that reaches SQL as an identifier), so a malformed request writes nothing and touches nothing.
 */
function checkFire(request: FireClockRequest): Date {
  const call = "fireClock";
  assertRequestShape(request, call, [
    "clockRowId",
    "expectVersion",
    "firedAt",
    "by",
    "jobId",
    "turn",
    "versionsRead",
    "writes",
  ]);
  const raw = request as unknown as Row;
  const clockRowId = idField(call, raw, "clockRowId", "request");
  assertVersion(call, raw.expectVersion, "expectVersion");
  const firedAt = instantOf(call, raw.firedAt, "firedAt");
  if (typeof raw.by !== "string" || !FIRE_BY.has(raw.by)) {
    fail(call, "by is not alarm, sweep or fireNow");
  }
  idField(call, raw, "jobId", "request");
  const turn = raw.turn;
  if (turn !== null) {
    checkTurn(call, turn);
    const eventIds = (turn as Row).eventIds as unknown[];
    if (eventIds.length !== 1 || eventIds[0] !== clockRowId) {
      fail(call, "a firing's turn has one event id, the clock row's (K-05 default 9; default 5)");
    }
  }
  for (const ref of listOf(call, raw, "versionsRead", "request")) {
    if (!isRecord(ref)) {
      fail(call, "versionsRead[] is not a row reference");
    }
    assertName(call, ref.table, "versionsRead[].table");
    assertId(call, ref.rowId, "versionsRead[].rowId");
    assertVersion(call, ref.version, "versionsRead[].version");
    if (ref.table === "clock_rows" && ref.rowId === clockRowId) {
      fail(call, "versionsRead names the firing's own row, which expectVersion compares (default 6)");
    }
  }
  const writes = objectField(call, raw, "writes", "request");
  const pairs = [
    ["openQuestions", "open", "close"],
    ["clockRows", "make", "cancel"],
    ["reservations", "confirm", "release"],
  ] as const;
  for (const [group, first, second] of pairs) {
    const lists = objectField(call, writes, group, "writes");
    listOf(call, lists, first, `writes.${group}`);
    listOf(call, lists, second, `writes.${group}`);
  }
  const outboxRows = listOf(call, writes, "outboxRows", "writes");
  outboxRows.forEach((row) => {
    checkOutboxRowNew(call, row);
  });
  listOf(call, writes, "events", "writes").forEach((entry) => {
    checkEventEntry(call, entry);
  });
  if (writes.effects !== undefined) {
    const effects = objectField(call, writes, "effects", "writes");
    listOf(call, effects, "write", "writes.effects");
    listOf(call, effects, "letGo", "writes.effects");
  }
  for (const write of listOf(call, writes, "state", "writes")) {
    if (!isRecord(write)) {
      fail(call, "a state write is not an object");
    }
    assertName(call, write.table, "a state write's table");
    if (NOT_STATE_TABLES.has(write.table)) {
      fail(
        call,
        `a state write may not name ${write.table}: the firing writes it through its own list or call`,
      );
    }
    if (write.op === "update") {
      assertVersion(call, write.expectVersion, "a state update's expectVersion");
      objectField(call, write, "key", "a state update");
      if (Object.hasOwn(objectField(call, write, "set", "a state update"), "version")) {
        fail(call, "a state update may not set the version: the update raises it");
      }
    } else if (write.op === "insert") {
      objectField(call, write, "values", "a state insert");
    } else {
      fail(call, "a state write is neither an insert nor an update");
    }
  }
  for (const cancel of request.writes.clockRows.cancel) {
    if (cancel.id === clockRowId) {
      fail(call, "clockRows.cancel names the firing's own row, which this call fires (default 6)");
    }
  }
  if (turn === null && (outboxRows.length > 0 || request.writes.openQuestions.open.length > 0)) {
    fail(call, "a firing with no turn writes no outbox row and opens no question (default 7)");
  }
  if (writes.waitingChat !== undefined) {
    const waiting = objectField(call, writes, "waitingChat", "writes");
    listOf(call, waiting, "withdrawForBookings", "writes.waitingChat");
    listOf(call, waiting, "withdrawForQuestions", "writes.waitingChat");
    const supersede = request.writes.waitingChat?.supersede ?? null;
    if (supersede !== null) {
      // K-05 v1.1 item 19's code check: the one answer is this firing's own row to that handle.
      const answer = request.writes.outboxRows.find(
        (row) => row.id === supersede.answerRowId && row.recipientHandleId === supersede.recipientHandleId,
      );
      if (answer === undefined) {
        fail(
          call,
          "waitingChat.supersede's answer row is not one of this firing's outbox rows to that handle",
        );
      }
    }
  }
  return firedAt;
}

// ---- the firing's transaction: its scope, set per write -------------------------------------------------------------------

/** The business scope of the firing's transaction, set to each write's own business (null: the runtime side). */
class Scope {
  private current: string | null = null;

  constructor(private readonly tx: Sql) {}

  async to(businessId: string | null): Promise<void> {
    if (businessId === this.current) {
      return;
    }
    if (businessId !== null) {
      assertBusinessId(businessId);
    }
    await this.tx`select set_config(${SCOPE_SETTING}, ${businessId ?? ""}, true)`;
    this.current = businessId;
  }
}

interface TableInfo {
  readonly name: string;
  readonly columns: ReadonlySet<string>;
  readonly jsonColumns: ReadonlySet<string>;
  /** The columns of type bytea, whose values come in K-04's text form and are written as their bytes (default 9). */
  readonly byteaColumns: ReadonlySet<string>;
  readonly key: readonly string[];
  readonly versioned: boolean;
  /** The column row-level security scopes the table by (K-04 rule 4), or null for a table with none. */
  readonly scopeColumn: string | null;
}

/** One firing: its moment (firedAt), its turn or none, the job id its writes carry, its scope and the tables it read. */
interface Firing {
  readonly tx: Sql;
  readonly now: Date;
  readonly at: string;
  readonly turn: K05.Turn | null;
  readonly jobId: string;
  readonly scope: Scope;
  readonly tables: Map<string, TableInfo>;
}

const FIRE = "fireClock";

/** The firing's turn, for a write that needs one (checkFire refused the request otherwise). */
function turnOf(f: Firing, what: string): K05.Turn {
  if (f.turn === null) {
    throw new Error(`fireClock: ${what} needs the firing's turn`);
  }
  return f.turn;
}

/** What every entry the firing appends carries: the job id, the turn id with a turn, the trace id and the bundle. */
function eventContextOf(f: Firing): EventContext {
  return f.turn === null
    ? { turnId: null, jobId: f.jobId, traceId: f.jobId, bundle: null }
    : {
        turnId: f.turn.id,
        jobId: f.jobId,
        traceId: f.turn.traceId,
        bundle: { hash: f.turn.bundleId.hash, build: f.turn.bundleId.build },
      };
}

/**
 * A table's columns, its JSON and bytea columns, its primary key and its row-level security, from the catalog: an
 * ordinary table of this connection's search path (never one of PostgreSQL's own), or a throw. Read once per call.
 */
async function tableInfo(f: Firing, table: string): Promise<TableInfo> {
  const known = f.tables.get(table);
  if (known !== undefined) {
    return known;
  }
  assertName(FIRE, table, "a table name");
  const [row] = await f.tx<
    { rls: boolean; columns: string[]; json_columns: string[]; bytea_columns: string[]; key: string[] }[]
  >`
    select c.relrowsecurity as rls,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 order by a.attnum) as columns,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                   and a.atttypid in ('json'::regtype, 'jsonb'::regtype)
                 order by a.attnum) as json_columns,
           array(select a.attname::text from pg_attribute a
                 where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                   and a.atttypid = 'bytea'::regtype
                 order by a.attnum) as bytea_columns,
           array(select a.attname::text
                 from pg_index i
                 cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                 where i.indrelid = c.oid and i.indisprimary
                 order by k.ord) as key
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.oid = to_regclass(${table}) and c.relkind in ('r', 'p') and n.nspname = any (current_schemas(false))
  `;
  if (row === undefined) {
    fail(FIRE, `no table ${table} in this database's schema`);
  }
  const columns = new Set(row.columns);
  let scopeColumn: string | null = null;
  if (row.rls) {
    scopeColumn = table === "businesses" ? "id" : "business_id";
    if (!columns.has(scopeColumn)) {
      fail(FIRE, `${table} has row-level security but no business column this call can scope by`);
    }
  }
  const info: TableInfo = {
    name: table,
    columns,
    jsonColumns: new Set(row.json_columns),
    byteaColumns: new Set(row.bytea_columns),
    key: row.key,
    versioned: columns.has("version"),
    scopeColumn,
  };
  f.tables.set(table, info);
  return info;
}

/** The one key column of a versioned table: a row reference names a row by one key as text (K-02 fact rowId). */
function oneKey(info: TableInfo): string {
  const [key, ...more] = info.key;
  if (!info.versioned) {
    fail(FIRE, `${info.name} carries no version, so no firing compares or names its rows`);
  }
  if (key === undefined || more.length > 0) {
    fail(FIRE, `${info.name}'s primary key is not one column, so a row reference cannot name its rows`);
  }
  return key;
}

function businessOf(info: TableInfo, row: Row): string | null {
  if (info.scopeColumn === null) {
    return null;
  }
  const value = row[info.scopeColumn];
  if (value === null || value === undefined) {
    return null;
  }
  assertId(FIRE, value, `${info.name}.${info.scopeColumn}`);
  return value;
}

/**
 * One column's value as postgres.js takes it: null as null, a JSON column's as JSON, a bytea column's as the bytes its
 * text form spells (default 9: any other form throws, naming the column, never the value), the rest as PostgreSQL text
 * input (K-05 v1).
 */
function columnValue(f: Firing, info: TableInfo, column: string, value: unknown, what: string): unknown {
  if (value === null) {
    return null;
  }
  if (info.jsonColumns.has(column)) {
    return f.tx.json(value as Json);
  }
  if (info.byteaColumns.has(column)) {
    const bytes = byteaFromText(value);
    if (bytes === null) {
      fail(FIRE, `${what} gives ${info.name}.${column} a value that is not "\\x" and hex digit pairs`);
    }
    return bytes;
  }
  return value;
}

/** Column to value for an insert or an update, each as columnValue gives it. */
function columnValues(f: Firing, info: TableInfo, values: Row, what: string): Record<string, never> {
  const out: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    assertName(FIRE, column, `${what}'s column`);
    if (!info.columns.has(column)) {
      fail(FIRE, `${what} names a column ${info.name} does not have`);
    }
    out[column] = columnValue(f, info, column, value, what) as never;
  }
  if (Object.keys(out).length === 0) {
    fail(FIRE, `${what} writes no column`);
  }
  return out;
}

// ---- the firing's locks and compares (commitTurn's step 2) ---------------------------------------------------------------

type Mode = "share" | "update";

interface Locked {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
  readonly business: string | null;
  readonly row: Row;
}

interface Compared {
  /** Every row compared or written, by targetKey. */
  readonly rows: ReadonlyMap<string, Locked>;
  /** The saved-time clock rows found, by clock row id. */
  readonly savedTimeClocks: ReadonlyMap<string, Row>;
}

const targetKey = (table: string, rowId: string): string => `${table}\u0000${rowId}`;
const savedTimeClockId = (reservationId: string): string => `${reservationId}/saved-time`;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonEmpty<T>(items: readonly T[]): [T, ...T[]] | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

async function lockRow(f: Firing, table: string, rowId: string, mode: Mode): Promise<Locked> {
  const info = await tableInfo(f, table);
  const key = oneKey(info);
  const { tx } = f;
  const [row] =
    mode === "update"
      ? await tx<Row[]>`select * from ${tx(table)} where ${tx(key)} = ${rowId} for update`
      : await tx<Row[]>`select * from ${tx(table)} where ${tx(key)} = ${rowId} for share`;
  if (row === undefined) {
    fail(FIRE, `a row of ${table} the request names does not exist`);
  }
  const version = row.version;
  assertVersion(FIRE, version, `${table}.version`);
  return { table, rowId, version, business: businessOf(info, row), row };
}

/** The saved-time clock rows of the reservations the firing confirms or releases, locked first (FOR UPDATE). */
async function lockSavedTimeClocks(f: Firing, reservationIds: readonly string[]): Promise<Map<string, Row>> {
  const ids = [...new Set(reservationIds.map(savedTimeClockId))].sort(compareText);
  const rows =
    ids.length === 0
      ? []
      : await f.tx<Row[]>`
          select id, business_id, state, version from clock_rows where id in ${f.tx(ids)}
          order by id collate "C" for update
        `;
  return new Map(rows.map((row) => [String(row.id), row]));
}

/** The slot locks of the reservations the firing releases, as commitTurn and reservations.ts take them. */
async function lockReleaseSlots(f: Firing, reservationIds: readonly string[]): Promise<void> {
  if (reservationIds.length === 0) {
    return;
  }
  const slots = await f.tx<{ resource_id: string; resource_kind: string; worker_person_id: string | null }[]>`
    select resource_id, resource_kind, worker_person_id from reservations where id in ${f.tx([...reservationIds])}
  `;
  const keys = new Set<string>();
  for (const slot of slots) {
    if (slot.resource_kind === "class_session") {
      continue;
    }
    keys.add(`resource:${slot.resource_id}`);
    if (slot.worker_person_id !== null) {
      keys.add(`person:${slot.worker_person_id}`);
    }
  }
  for (const key of [...keys].sort()) {
    await f.tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/** A state update's row id: its one key column's value, the key naming exactly the primary key (no wider update). */
async function stateUpdateTarget(
  f: Firing,
  write: Extract<K05.StateWrite, { op: "update" }>,
): Promise<string> {
  const info = await tableInfo(f, write.table);
  const key = oneKey(info);
  const named = Object.keys(write.key);
  if (named.length !== 1 || named[0] !== key) {
    fail(FIRE, `a state update of ${write.table} must name the row by its primary key alone`);
  }
  const value = write.key[key];
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    fail(FIRE, `a state update of ${write.table} names its key with no value`);
  }
  if (Object.hasOwn(write.set, key)) {
    fail(FIRE, `a state update of ${write.table} may not change the row's key`);
  }
  return String(value);
}

async function lockAndCompare(f: Firing, request: FireClockRequest): Promise<Compared> {
  const { writes } = request;
  const confirms = writes.reservations.confirm;
  const releases = writes.reservations.release;
  const letGos = writes.effects?.letGo ?? [];

  const savedTimeClocks = await lockSavedTimeClocks(f, [
    ...confirms.map((confirm) => confirm.id),
    ...releases.map((release) => release.id),
  ]);
  await lockReleaseSlots(
    f,
    releases.map((release) => release.id),
  );

  const modes = new Map<string, { table: string; rowId: string; mode: Mode }>();
  const expected: { table: string; rowId: string; version: number }[] = [];
  const want = (table: string, rowId: string, mode: Mode, version: number): void => {
    const key = targetKey(table, rowId);
    const known = modes.get(key);
    if (known === undefined || (known.mode === "share" && mode === "update")) {
      modes.set(key, { table, rowId, mode });
    }
    expected.push({ table, rowId, version });
  };
  for (const ref of request.versionsRead) {
    want(ref.table, ref.rowId, "share", ref.version);
  }
  for (const write of writes.state) {
    if (write.op === "update") {
      want(write.table, await stateUpdateTarget(f, write), "update", write.expectVersion);
    }
  }
  for (const close of writes.openQuestions.close) {
    assertId(FIRE, close.id, "openQuestions.close[].id");
    assertVersion(FIRE, close.expectVersion, "openQuestions.close[].expectVersion");
    want("open_questions", close.id, "update", close.expectVersion);
  }
  for (const cancel of writes.clockRows.cancel) {
    assertId(FIRE, cancel.id, "clockRows.cancel[].id");
    assertVersion(FIRE, cancel.expectVersion, "clockRows.cancel[].expectVersion");
    want("clock_rows", cancel.id, "update", cancel.expectVersion);
  }
  for (const move of [...confirms, ...releases]) {
    assertId(FIRE, move.id, "a reservation's id");
    assertVersion(FIRE, move.expectVersion, "a reservation's expectVersion");
    want("reservations", move.id, "update", move.expectVersion);
  }
  for (const letGo of letGos) {
    assertId(FIRE, letGo.effectId, "effects.letGo[].effectId");
    assertVersion(FIRE, letGo.expectVersion, "effects.letGo[].expectVersion");
    want("effects", letGo.effectId, "update", letGo.expectVersion);
  }

  // Locked in one fixed order after the clock row, so a firing and a commit never wait on each other in a circle.
  const rows = new Map<string, Locked>();
  const order = [...modes.values()].sort(
    (a, b) => compareText(a.table, b.table) || compareText(a.rowId, b.rowId),
  );
  for (const target of order) {
    rows.set(
      targetKey(target.table, target.rowId),
      await lockRow(f, target.table, target.rowId, target.mode),
    );
  }
  const locked = (table: string, rowId: string): Locked => {
    const row = rows.get(targetKey(table, rowId));
    if (row === undefined) {
      throw new Error(`fireClock: a ${table} row was compared but not locked`);
    }
    return row;
  };

  // Limit 5: a reservation to confirm must still be held, and not past its end (checked before its version).
  const lost: LostReservation[] = [];
  for (const confirm of confirms) {
    const { row } = locked("reservations", confirm.id);
    const heldUntil = row.held_until instanceof Date ? row.held_until : null;
    if (row.state !== "held" || heldUntil === null || heldUntil.getTime() <= f.now.getTime()) {
      lost.push({
        id: confirm.id,
        state: row.state as LostReservation["state"],
        heldUntil: heldUntil === null ? null : utc(heldUntil),
        releasedWhy: (row.released_why ?? null) as LostReservation["releasedWhy"],
      });
    }
  }
  const lostList = nonEmpty(lost);
  if (lostList !== null) {
    throw new Refused({ error: "reservationLost", reservations: lostList });
  }

  // Limit 4: every row read or written at the version the firing saw, each changed row listed once.
  const changed: ChangedRow[] = [];
  const listed = new Set<string>();
  for (const expectation of expected) {
    const now = locked(expectation.table, expectation.rowId);
    const key = `${targetKey(expectation.table, expectation.rowId)}\u0000${String(expectation.version)}`;
    if (now.version !== expectation.version && !listed.has(key)) {
      listed.add(key);
      changed.push({
        table: expectation.table,
        rowId: expectation.rowId,
        readVersion: expectation.version,
        currentVersion: now.version,
      });
    }
  }
  const changedList = nonEmpty(changed);
  if (changedList !== null) {
    throw new Refused({ error: "versionChanged", changed: changedList });
  }

  // An effect is let go only from its service's outage (K-07 letGo; K-05 v1.1 item 18).
  for (const letGo of letGos) {
    const { row } = locked("effects", letGo.effectId);
    if (row.state !== "outage") {
      throw new Refused({
        error: "wrongState",
        table: "effects",
        rowId: letGo.effectId,
        state: row.state as K05.EffectState,
      });
    }
  }

  return { rows, savedTimeClocks };
}

// ---- the firing's writes (commitTurn's step 3) ---------------------------------------------------------------------------

interface Written {
  readonly written: RowRef[];
  readonly outboxRows: K05.OutboxRowWritten[];
  readonly promoted: Promotion[];
  readonly superseded: RowRef[];
  readonly withdrawn: RowRef[];
}

function lockedRow(compared: Compared, table: string, rowId: string): Locked {
  const row = compared.rows.get(targetKey(table, rowId));
  if (row === undefined) {
    throw new Error(`fireClock: a ${table} row is written but was not locked`);
  }
  return row;
}

async function writeState(
  f: Firing,
  request: FireClockRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = f;
  for (const write of request.writes.state) {
    const info = await tableInfo(f, write.table);
    if (write.op === "insert") {
      const what = `a state insert into ${write.table}`;
      const values = columnValues(f, info, write.values, what);
      await f.scope.to(info.scopeColumn === null ? null : businessOf(info, write.values));
      if (!info.versioned) {
        await tx`insert into ${tx(write.table)} ${tx(values)}`;
        continue;
      }
      const key = oneKey(info);
      const [row] = await tx<{ key: unknown; version: number }[]>`
        insert into ${tx(write.table)} ${tx(values)} returning ${tx(key)} as key, version
      `;
      if (row === undefined) {
        throw new Error(`fireClock: ${what} returned no row`);
      }
      out.written.push({ table: write.table, rowId: String(row.key), version: row.version });
      continue;
    }
    const rowId = await stateUpdateTarget(f, write);
    const key = oneKey(info);
    const locked = lockedRow(compared, write.table, rowId);
    const set = columnValues(f, info, write.set, `a state update of ${write.table}`);
    await f.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update ${tx(write.table)} set ${tx(set)}, version = ${write.expectVersion + 1}
      where ${tx(key)} = ${rowId} and version = ${write.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error(`fireClock: a state update of ${write.table} matched no row at its version`);
    }
    out.written.push({ table: write.table, rowId, version: row.version });
  }
}

async function writeOpenQuestions(
  f: Firing,
  request: FireClockRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = f;
  for (const question of request.writes.openQuestions.open) {
    const turn = turnOf(f, "an open question");
    const what = "openQuestions.open[]";
    const record = question as unknown as Row;
    idField(FIRE, record, "id", what);
    idField(FIRE, record, "handleId", what);
    nullableIdField(FIRE, record, "personId", what);
    const business = nullableIdField(FIRE, record, "businessId", what);
    nullableIdField(FIRE, record, "bookingId", what);
    await f.scope.to(business);
    const [row] = await tx<{ version: number }[]>`
      insert into open_questions (
        id, turn_id, handle_id, person_id, business_id, booking_id, step, options, readback, versions_read,
        bundle_hash, bundle_build, clock
      ) values (
        ${question.id}, ${turn.id}, ${question.handleId}, ${question.personId}, ${question.businessId},
        ${question.bookingId}, ${question.step}, ${tx.json(question.options as unknown as Json)}, ${question.readback},
        ${tx.json(question.versionsRead as unknown as Json)}, ${turn.bundleId.hash}, ${turn.bundleId.build},
        ${question.clock}
      )
      returning version
    `;
    out.written.push({ table: "open_questions", rowId: question.id, version: row?.version ?? 1 });
  }
  for (const close of request.writes.openQuestions.close) {
    assertNullableId(FIRE, close.answeredOptionId, "openQuestions.close[].answeredOptionId");
    const locked = lockedRow(compared, "open_questions", close.id);
    await f.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update open_questions
      set status = ${close.status}, answered_option_id = ${close.answeredOptionId}, closed_at = ${f.now},
          version = ${close.expectVersion + 1}
      where id = ${close.id} and version = ${close.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("fireClock: an open question's close matched no row at its version");
    }
    out.written.push({ table: "open_questions", rowId: close.id, version: row.version });
  }
}

interface ClockFields {
  readonly id: string;
  readonly kind: string;
  readonly openQuestionId: string | null;
  readonly reservationId: string | null;
  readonly handleId: string | null;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly fires: Row;
  readonly due: { dueAt: string; dueZone: string } | null;
}

/** K-05 v1 clockNew (typed loosely by the generator): the fields a firing writes, checked. */
function clockFields(clock: K05.ClockNew): ClockFields {
  const what = "clockRows.make[]";
  const kind = clock.kind;
  if (typeof kind !== "string" || !CLOCK_KINDS.has(kind)) {
    fail(FIRE, `${what}.kind is not one of K-04's clock kinds`);
  }
  let due: ClockFields["due"] = null;
  if (clock.due !== undefined) {
    const record = objectField(FIRE, clock, "due", what);
    const dueAt = record.dueAt;
    const dueZone = record.dueZone;
    if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt)) || typeof dueZone !== "string") {
      fail(FIRE, `${what}.due needs dueAt (UTC) and dueZone`);
    }
    due = { dueAt, dueZone };
  }
  return {
    id: idField(FIRE, clock, "id", what),
    kind,
    openQuestionId: nullableIdField(FIRE, clock, "openQuestionId", what),
    reservationId: nullableIdField(FIRE, clock, "reservationId", what),
    handleId: nullableIdField(FIRE, clock, "handleId", what),
    businessId: nullableIdField(FIRE, clock, "businessId", what),
    bookingId: nullableIdField(FIRE, clock, "bookingId", what),
    fires: objectField(FIRE, clock, "fires", what),
    due,
  };
}

async function insertClock(f: Firing, clock: ClockFields): Promise<RowRef> {
  const { tx } = f;
  await f.scope.to(clock.businessId);
  const [row] = await tx<{ version: number }[]>`
    insert into clock_rows (
      id, kind, open_question_id, reservation_id, handle_id, business_id, booking_id, due_at, due_zone, state,
      armed_at, fires, created_by_turn_id
    ) values (
      ${clock.id}, ${clock.kind}, ${clock.openQuestionId}, ${clock.reservationId}, ${clock.handleId},
      ${clock.businessId}, ${clock.bookingId}, ${clock.due?.dueAt ?? null}, ${clock.due?.dueZone ?? null},
      ${clock.due === null ? "waiting" : "armed"}, ${clock.due === null ? null : f.now},
      ${tx.json(clock.fires as Json)}, ${f.turn?.id ?? null}
    )
    returning version
  `;
  return { table: "clock_rows", rowId: clock.id, version: row?.version ?? 1 };
}

async function writeClockRows(
  f: Firing,
  request: FireClockRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = f;
  for (const clock of request.writes.clockRows.make) {
    out.written.push(await insertClock(f, clockFields(clock)));
  }
  for (const cancel of request.writes.clockRows.cancel) {
    const locked = lockedRow(compared, "clock_rows", cancel.id);
    await f.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update clock_rows set state = 'cancelled', cancelled_at = ${f.now}, version = ${cancel.expectVersion + 1}
      where id = ${cancel.id} and version = ${cancel.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("fireClock: a clock row's cancel matched no row at its version");
    }
    out.written.push({ table: "clock_rows", rowId: cancel.id, version: row.version });
  }
}

export function commitSeqOf(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("an outbox row's commit_seq is not a positive integer");
  }
  return seq;
}

/**
 * Inserts one outbox row with no plan (K-04's first state, planned) under the turn's id, bundle and trace id, with
 * commit_seq from K-04's identity column, so commit order is the database's. The row was checked (checkOutboxRowNew).
 */
export async function insertOutboxRow(
  tx: Sql,
  turn: K05.Turn,
  row: K05.OutboxRowNew,
): Promise<K05.OutboxRowWritten> {
  const [inserted] = await tx<{ commit_seq: string | number }[]>`
    insert into outbox_rows (
      id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class,
      versions_read, open_question_id, copy_of_row_id, bundle_hash, bundle_build, trace_id
    ) values (
      ${row.id}, ${turn.id}, ${row.recipientHandleId}, ${row.recipientPersonId}, ${row.businessId}, ${row.bookingId},
      ${row.channel}, ${row.sendClass}, ${tx.json(row.versionsRead as unknown as Json)}, ${row.openQuestionId},
      ${row.copyOfRowId}, ${turn.bundleId.hash}, ${turn.bundleId.build}, ${turn.traceId}
    )
    returning commit_seq
  `;
  return { id: row.id, commitSeq: commitSeqOf(inserted?.commit_seq) };
}

/** A turn's outbox rows in commit order (a repeat's answer: K-04 keeps no copy of a result). */
export async function outboxRowsOfTurn(tx: Sql, turnId: string): Promise<K05.OutboxRowWritten[]> {
  const rows = await tx<{ id: string; commit_seq: string | number }[]>`
    select id, commit_seq from outbox_rows where turn_id = ${turnId} order by commit_seq
  `;
  return rows.map((row) => ({ id: row.id, commitSeq: commitSeqOf(row.commit_seq) }));
}

async function writeOutboxRows(f: Firing, request: FireClockRequest, out: Written): Promise<void> {
  for (const outboxRow of request.writes.outboxRows) {
    const turn = turnOf(f, "an outbox row");
    await f.scope.to(outboxRow.businessId);
    out.outboxRows.push(await insertOutboxRow(f.tx, turn, outboxRow));
  }
}

/** Cancels a reservation's saved-time clock row while it is waiting or armed, under its own business. */
async function cancelSavedTimeClock(
  f: Firing,
  compared: Compared,
  reservationId: string,
): Promise<RowRef | null> {
  const id = savedTimeClockId(reservationId);
  const clock = compared.savedTimeClocks.get(id);
  // The fired row itself was fired before the compares, so it is found fired here and left as it is.
  if (clock === undefined || (clock.state !== "waiting" && clock.state !== "armed")) {
    return null;
  }
  const business = clock.business_id;
  assertNullableId(FIRE, business, "clock_rows.business_id");
  await f.scope.to(business);
  const [row] = await f.tx<{ version: number }[]>`
    update clock_rows set state = 'cancelled', cancelled_at = ${f.now}, version = version + 1
    where id = ${id} and state in ('waiting', 'armed')
    returning version
  `;
  return row === undefined ? null : { table: "clock_rows", rowId: id, version: row.version };
}

/** The promoted next in line's saved-time clock row (commitTurn's default 4; K-05 items 8 and 9). */
async function promotedClock(f: Firing, promotion: Promotion, business: string): Promise<RowRef> {
  await f.scope.to(null);
  const [owner] =
    promotion.forPhoneNumber === null
      ? []
      : await f.tx<{ handle_id: string | null }[]>`
          select handle_id from phones where number = ${promotion.forPhoneNumber}
        `;
  await f.scope.to(business);
  const [zone] = await f.tx<{ time_zone: string }[]>`select time_zone from businesses where id = ${business}`;
  if (zone === undefined) {
    throw new Error("fireClock: the promoted reservation's business was not found under its own scope");
  }
  return insertClock(f, {
    id: promotion.savedTimeClockId,
    kind: "saved_time",
    openQuestionId: null,
    reservationId: promotion.reservationId,
    handleId: owner?.handle_id ?? null,
    businessId: business,
    bookingId: promotion.bookingId,
    fires: { release: promotion.reservationId, why: "expired" },
    due: { dueAt: promotion.heldUntil, dueZone: zone.time_zone },
  });
}

async function writeReservations(
  f: Firing,
  request: FireClockRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = f;
  for (const confirm of request.writes.reservations.confirm) {
    assertId(FIRE, confirm.bookingId, "reservations.confirm[].bookingId");
    const locked = lockedRow(compared, "reservations", confirm.id);
    await f.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update reservations set state = 'booked', booking_id = ${confirm.bookingId},
                              version = ${confirm.expectVersion + 1}
      where id = ${confirm.id} and version = ${confirm.expectVersion} and state = 'held'
      returning version
    `;
    if (row === undefined) {
      throw new Error("fireClock: a reservation's confirm matched no held row at its version");
    }
    out.written.push({ table: "reservations", rowId: confirm.id, version: row.version });
    const clock = await cancelSavedTimeClock(f, compared, confirm.id);
    if (clock !== null) {
      out.written.push(clock);
    }
  }
  for (const release of request.writes.reservations.release) {
    const locked = lockedRow(compared, "reservations", release.id);
    const business = locked.business;
    if (business === null) {
      throw new Error("fireClock: a reservation to release has no business");
    }
    await f.scope.to(business);
    const outcome = await releaseIn(tx, {
      reservationId: release.id,
      businessId: business,
      expectVersion: release.expectVersion,
      why: release.why,
      at: f.at,
    });
    if ("error" in outcome) {
      // The row was locked and compared above, so a refusal here is a fault, never an answer.
      throw new Error(`fireClock: a reservation's release was refused after its compare (${outcome.error})`);
    }
    if (outcome.repeated) {
      continue;
    }
    out.written.push({ table: "reservations", rowId: release.id, version: outcome.version });
    if (locked.row.resource_kind === "class_session") {
      const [seats] = await tx<{ version: number }[]>`
        select version from class_seats where resource_id = ${String(locked.row.resource_id)}
      `;
      if (seats !== undefined) {
        out.written.push({
          table: "class_seats",
          rowId: String(locked.row.resource_id),
          version: seats.version,
        });
      }
    }
    const clock = await cancelSavedTimeClock(f, compared, release.id);
    if (clock !== null) {
      out.written.push(clock);
    }
    if (outcome.promoted !== null) {
      const promotion: Promotion = { ...outcome.promoted };
      out.written.push({ table: "reservations", rowId: promotion.reservationId, version: promotion.version });
      out.written.push(await promotedClock(f, promotion, business));
      out.promoted.push(promotion);
    }
  }
}

interface EffectFields {
  readonly effectId: string;
  readonly businessId: string | null;
  readonly bookingId: string | null;
  readonly kind: string;
  readonly port: string;
  readonly calendarProvider: string | null;
  readonly visitId: string | null;
  readonly personId: string | null;
  readonly handleId: string | null;
  readonly amount: { cents: number; currency: string } | null;
  readonly portRequest: Row;
  readonly idempotencyKey: string;
  readonly traceId: string;
}

/** K-05 v1.1 effectNew (typed loosely by the generator): the fields a firing writes, checked. */
function effectFields(effect: K05.EffectNew): EffectFields {
  const what = "effects.write[]";
  const kind = effect.kind;
  const port = effect.port;
  if (typeof kind !== "string" || typeof port !== "string") {
    fail(FIRE, `${what} needs a kind and a port`);
  }
  const provider = effect.calendarProvider;
  if (provider !== null && (typeof provider !== "string" || !CALENDAR_PROVIDERS.has(provider))) {
    fail(FIRE, `${what}.calendarProvider is not google, microsoft or null`);
  }
  let amount: EffectFields["amount"] = null;
  if (effect.amount !== null) {
    const record = objectField(FIRE, effect, "amount", what);
    if (!Number.isSafeInteger(record.cents) || typeof record.currency !== "string") {
      fail(FIRE, `${what}.amount needs whole cents and a currency`);
    }
    amount = { cents: record.cents as number, currency: record.currency };
  }
  const key = effect.idempotencyKey;
  if (typeof key !== "string" || key === "") {
    fail(FIRE, `${what}.idempotencyKey is not a non-empty key`);
  }
  return {
    effectId: idField(FIRE, effect, "effectId", what),
    businessId: nullableIdField(FIRE, effect, "businessId", what),
    bookingId: nullableIdField(FIRE, effect, "bookingId", what),
    kind,
    port,
    calendarProvider: provider,
    visitId: nullableIdField(FIRE, effect, "visitId", what),
    personId: nullableIdField(FIRE, effect, "personId", what),
    handleId: nullableIdField(FIRE, effect, "handleId", what),
    amount,
    portRequest: objectField(FIRE, effect, "portRequest", what),
    idempotencyKey: key,
    traceId: idField(FIRE, effect, "traceId", what),
  };
}

async function writeEffects(
  f: Firing,
  request: FireClockRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = f;
  const effects = request.writes.effects;
  if (effects === undefined) {
    return;
  }
  for (const effect of effects.write.map(effectFields)) {
    if (effect.port === "calendar" && effect.calendarProvider === null) {
      // The CHECK effects_calendar_keyed lets a null provider through; its refusal is answered here (CQ-76).
      throw new Refused({ error: "constraint", sqlstate: "23514", constraint: "effects_calendar_keyed" });
    }
    await f.scope.to(effect.businessId);
    // K-05 v1.1 item 18: under the turn's id, or for a firing with no turn the request's job id (effects_turn_or_job).
    const [row] = await tx<{ version: number }[]>`
      insert into effects (
        id, turn_id, job_id, business_id, booking_id, kind, port, calendar_provider, visit_id, person_id, handle_id,
        amount_cents, currency, port_request, idempotency_key, trace_id, created_at
      ) values (
        ${effect.effectId}, ${f.turn?.id ?? null}, ${f.turn === null ? f.jobId : null}, ${effect.businessId},
        ${effect.bookingId}, ${effect.kind}, ${effect.port}, ${effect.calendarProvider}, ${effect.visitId},
        ${effect.personId}, ${effect.handleId}, ${effect.amount?.cents ?? null}, ${effect.amount?.currency ?? null},
        ${tx.json(effect.portRequest as Json)}, ${effect.idempotencyKey}, ${effect.traceId}, ${f.now}
      )
      returning version
    `;
    out.written.push({ table: "effects", rowId: effect.effectId, version: row?.version ?? 1 });
  }
  for (const letGo of effects.letGo) {
    const locked = lockedRow(compared, "effects", letGo.effectId);
    await f.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update effects set state = 'cancelled', version = ${letGo.expectVersion + 1}
      where id = ${letGo.effectId} and version = ${letGo.expectVersion} and state = 'outage'
      returning version
    `;
    if (row === undefined) {
      throw new Error("fireClock: an effect let go matched no outage row at its version");
    }
    out.written.push({ table: "effects", rowId: letGo.effectId, version: row.version });
  }
}

interface WaitingRow {
  id: string;
  version: number;
  business_id: string | null;
  booking_id: string | null;
  open_question_id: string | null;
  time_zone: string | null;
}

/** Moves one waiting row (K-07 waiting_chat) to superseded or withdrawn, under its business, with its entry. */
async function endWaitingRow(
  f: Firing,
  row: WaitingRow,
  to: "superseded" | "withdrawn",
  why: Record<string, string>,
): Promise<RowRef> {
  await f.scope.to(row.business_id);
  const [moved] = await f.tx<{ version: number }[]>`
    update outbox_rows set state = ${to}, version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state = 'waiting_chat'
    returning version
  `;
  if (moved === undefined) {
    throw new Error("fireClock: a waiting row moved while it was locked");
  }
  await appendEvent(f.tx, eventContextOf(f), {
    id: `${row.id}/${to}`,
    kind: "outbox_row.state_changed",
    zone: row.time_zone,
    businessId: row.business_id,
    actorKind: "rosie",
    tableName: "outbox_rows",
    rowId: row.id,
    oldValues: { state: "waiting_chat" },
    newValues: { state: to },
    why,
    at: f.now,
  });
  return { table: "outbox_rows", rowId: row.id, version: moved.version };
}

/** K-05 v1.1 item 19: the waiting rows this firing ends, found by the call itself, FOR UPDATE, so none is missed. */
async function writeWaitingChat(f: Firing, request: FireClockRequest, out: Written): Promise<void> {
  const waiting = request.writes.waitingChat;
  if (waiting === undefined) {
    return;
  }
  const { tx } = f;
  if (waiting.supersede !== null) {
    // checkFire held the answer row to this firing's own rows to that handle.
    const { recipientHandleId, answerRowId } = waiting.supersede;
    await f.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and r.recipient_handle_id = ${recipientHandleId}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      out.superseded.push(
        await endWaitingRow(f, row, "superseded", { followUp: "chatOpenAnswer", supersededBy: answerRowId }),
      );
    }
  }
  const lists = [
    { ids: waiting.withdrawForBookings, column: "booking_id", why: "closedBooking" },
    { ids: waiting.withdrawForQuestions, column: "open_question_id", why: "closedQuestion" },
  ] as const;
  for (const list of lists) {
    if (list.ids.length === 0) {
      continue;
    }
    list.ids.forEach((id) => {
      assertId(FIRE, id, `waitingChat's ${list.why} id`);
    });
    await f.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and ${tx(`r.${list.column}`)} in ${tx([...list.ids])}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      const closed = list.column === "booking_id" ? row.booking_id : row.open_question_id;
      out.withdrawn.push(await endWaitingRow(f, row, "withdrawn", { [list.why]: closed ?? "" }));
    }
  }
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** A K-05 eventEntry as event-log.ts appends it, at the call's moment (its sealed values in either form K-05 names). */
export function logEntryOf(entry: K05.EventEntry, at: Date): LogEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    zone: entry.zone,
    businessId: entry.businessId,
    actorKind: entry.actorKind,
    actorPersonId: entry.actorPersonId,
    actorRole: entry.actorRole,
    tableName: entry.tableName,
    rowId: entry.rowId,
    oldValues: entry.oldValues as Given<LogEntry["oldValues"]>,
    newValues: entry.newValues as Given<LogEntry["newValues"]>,
    sealed:
      entry.sealed === null
        ? null
        : { forPersonId: entry.sealed.forPersonId, bytes: base64Bytes(entry.sealed.base64) },
    why: entry.why as Given<LogEntry["why"]>,
    approvedBy: entry.approvedBy as Given<LogEntry["approvedBy"]>,
    proofs: entry.proofs as Given<LogEntry["proofs"]>,
    at,
  };
}

/** The request's entries, each under its own business, with the job id, the turn's id when there is one, and the trace. */
async function writeEvents(f: Firing, request: FireClockRequest): Promise<void> {
  for (const entry of request.writes.events) {
    await f.scope.to(entry.businessId);
    await appendEvent(f.tx, eventContextOf(f), logEntryOf(entry, f.now));
  }
}

// ---- fireClock: the row, a repeat and the firing -----------------------------------------------------------------------

/**
 * The first firing of a fired row, as a repeat answers it: its time, its turn (the clock turn on the row's handle whose
 * one event id is the row's: default 5) and that turn's outbox rows in commit order; nothing is written.
 */
async function repeatOf(tx: Sql, row: ClockRow): Promise<FireClockResponse> {
  const [turn] =
    row.handle_id === null
      ? []
      : await tx<{ id: string }[]>`
          select id from turns
          where handle_id = ${row.handle_id} and event_ids = array[${row.id}]::text[] and state = 'committed'
          order by id collate "C"
          limit 1
        `;
  return {
    result: "fired",
    clockRowId: row.id,
    version: row.version,
    firedAt: utc(present(row.fired_at, "fired_at")),
    turnId: turn?.id ?? null,
    repeated: true,
    committed: {
      written: [],
      outboxRows: turn === undefined ? [] : await outboxRowsOfTurn(tx, turn.id),
      promoted: [],
    },
  };
}

/** The whole firing inside the transaction `tx` (the runtime side, no scope at its start). */
async function fireIn(tx: Sql, request: FireClockRequest, firedAt: Date): Promise<FireClockOutcome> {
  const row = await lockClockRow(tx, request.clockRowId);
  if (row === undefined) {
    return { error: "notFound", table: "clock_rows", rowId: request.clockRowId };
  }
  if (row.state === "fired") {
    return repeatOf(tx, row);
  }
  if (row.state === "waiting" || row.state === "cancelled") {
    return { error: "notArmed", clockRowId: row.id, state: row.state };
  }
  if (row.version !== request.expectVersion) {
    return {
      error: "versionChanged",
      changed: [
        {
          table: "clock_rows",
          rowId: row.id,
          readVersion: request.expectVersion,
          currentVersion: row.version,
        },
      ],
    };
  }
  const dueAt = present(row.due_at, "due_at");
  if (dueAt.getTime() > firedAt.getTime() && request.by !== "fireNow") {
    return { error: "notDue", clockRowId: row.id, dueAt: utc(dueAt) };
  }
  const { turn } = request;
  if (turn !== null && turn.handleId !== row.handle_id) {
    fail(FIRE, "a firing's turn is on the clock row's own handle (default 5)");
  }

  const f: Firing = {
    tx,
    now: firedAt,
    at: utc(firedAt),
    turn,
    jobId: request.jobId,
    scope: new Scope(tx),
    tables: new Map(),
  };
  // The turn row, written once, as committed (NQ-RT-3); an id already taken is the primary key's refusal (constraint).
  if (turn !== null) {
    await tx`
      insert into turns (
        id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, committed_at
      ) values (
        ${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash}, ${turn.bundleId.build},
        ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries}, ${firedAt}
      )
    `;
  }
  // The row fires before the compares, so a release of its own reservation (a saved time's expiry) finds it fired.
  await f.scope.to(row.business_id);
  const [fired] = await tx<{ version: number }[]>`
    update clock_rows set state = 'fired', fired_at = ${firedAt}, version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state = 'armed'
    returning version
  `;
  if (fired === undefined) {
    throw new Error("fireClock: the clock row moved while it was locked");
  }

  // The compares read on the runtime side, where every business's rows are seen (as commitTurn's do).
  await f.scope.to(null);
  const compared = await lockAndCompare(f, request);
  const out: Written = { written: [], outboxRows: [], promoted: [], superseded: [], withdrawn: [] };
  await writeState(f, request, compared, out);
  await writeOpenQuestions(f, request, compared, out);
  await writeClockRows(f, request, compared, out);
  await writeOutboxRows(f, request, out);
  await writeReservations(f, request, compared, out);
  await writeEffects(f, request, compared, out);
  await writeWaitingChat(f, request, out);
  await writeEvents(f, request);

  const ended = out.superseded.length + out.withdrawn.length > 0;
  return {
    result: "fired",
    clockRowId: row.id,
    version: fired.version,
    firedAt: f.at,
    turnId: turn?.id ?? null,
    repeated: false,
    committed: {
      written: out.written,
      outboxRows: out.outboxRows,
      promoted: out.promoted,
      ...(ended ? { waitingChat: { superseded: out.superseded, withdrawn: out.withdrawn } } : {}),
    },
  };
}

/**
 * Fires a clock row once, with what its firing commits, in one transaction on the primary (K-05 v1 item 7, v1.1 items
 * 18 and 19; arch 10 line 508): the runtime side, its writes scoped per write. Pass the client's primary handle, run as
 * rosie_job. Answers fired (repeated true for a row already fired, which writes nothing), or a refusal that wrote
 * nothing: notArmed, notDue, versionChanged, reservationLost, wrongState, constraint, notFound or transient. Throws for
 * a request it cannot carry out, a database refusal no answer names as DataAccessDatabaseError; nothing is written then
 * either.
 */
export async function fireClock(sql: Sql, request: FireClockRequest): Promise<FireClockOutcome> {
  const firedAt = checkFire(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => fireIn(tx, request, firedAt));
  } catch (error) {
    if (error instanceof Refused) {
      return error.answer;
    }
    const refused = constraintOf(error);
    if (refused !== null) {
      return refused;
    }
    return transientOrScrubbed(FIRE, error);
  }
}
