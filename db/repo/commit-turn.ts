// Data-access K-05 v1.1 item 1: commit a turn, all or nothing, once per turn id (T-195; DL-136; K-05 README items 1, 18
// and 19; arch 01 lines 39 to 41; arch 02 line 121; arch 10 line 508; arch 04 line 223: gate and commit within 300 ms).
// The gate has passed limits 1 to 6; commitTurn writes what the turn decided in one transaction on the primary, or
// nothing at all. A v1 request is a v1.1 request (its two v1.1 lists left out), so K-05 v1's exchanges hold unchanged.
//
//   1. The turn row, as committed (QUESTIONS.md NQ-RT-3's default: written once). Its id is the primary key, so a repeat
//      (a lost reply, a rerun) meets the first commit's row: `insert ... on conflict (id) do nothing` waits for a commit
//      of the same id still in flight and then finds it. A committed turn answers its first commit (turn id, time and its
//      outbox rows by turn id in commit order; written and promoted empty, since K-04 keeps no copy of a result) with
//      repeated true, whatever the repeat's body; a parked turn answers turnParked. A repeat writes nothing.
//   2. The locks, then the compares, before any other write: the saved-time clock rows of the reservations it confirms
//      or releases (so the commit takes a clock row before its reservation, as a firing does), the slot locks of the
//      reservations it releases (reservations.ts's order: the slot before the row), then every row it compares, once
//      each, in (table, row id) order: a row it writes FOR UPDATE, a row it only read FOR SHARE. A reservation to confirm
//      that is not held, or is held past its held_until, refuses the commit with reservationLost (limit 5, checked before
//      its version: arch 06 line 307); then any version that moved refuses it with versionChanged, every changed row
//      listed (limit 4: arch 06 line 305); then an effect let go that is not in outage refuses it with wrongState.
//   3. The writes, in K-05's order: state writes (an update raises the version by one); open questions opened (waiting)
//      or closed; clock rows made (waiting, or armed with their due time) or cancelled; outbox rows with no plan (K-04's
//      first state; commit_seq from the identity column, so commit order is the database's); reservations confirmed
//      (booked, with the booking, and the saved-time clock row cancelled) or released (as release does, promotion
//      included: db/repo/reservations.ts releaseIn); then K-05 v1.1's effects (written pending under the turn's id, and
//      outage rows let go) and waiting rows (superseded or withdrawn, each with its own event-log entry); then the
//      request's event-log entries, each under the turn id, its trace id and its bundle.
//   4. The answer: every row inserted or updated with its version after the commit (turn, outbox and event-log rows
//      left out, and rows of a table with no version, which a row reference cannot name), the outbox rows in commit
//      order, the next in line its releases promoted, and the waiting rows it ended.
//
// Scope (K-05 README "Scope": per write; T-191's roles): the call runs on the runtime side, as rosie_job, in one read
// committed transaction that starts with no business scope. Before each write the scope is set to that write's own
// business (set_config(..., true)), so row-level security holds each write to its business, and a turn touching two
// businesses' rows never writes a third's: a row the request names takes its business from the request, a row the commit
// updates takes it from the row as locked; a write with no business, and a table with no row-level security (turns,
// handles, phones, persons, threads, consents with no business), goes on the runtime side. The compares, the search for
// waiting rows and a repeat's outbox rows read on the runtime side, where every business's rows are seen.
//
// Refusals write nothing: the transaction rolls back. A database rule that refuses a write (EXCLUDE 23P01, CHECK 23514,
// unique 23505, foreign key 23503) answers constraint with the SQLSTATE and the constraint's name only; a serialization
// failure, a deadlock or a lost connection answers transient (the same request may be sent again); anything else
// (a request this layer cannot carry out, a row it names that does not exist) throws, and nothing is written either.
//
// Nothing here logs. What it throws names a call, a table, a column or a fault, never a value or a row id (a phone's row
// id is its number); a refusal never carries PostgresError.detail (STATE's notes for later cards, 3).
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. A row the request names (a version read or a write's row) that does not exist throws: K-05's errors have no
//      answer for it (versionChanged needs the version now), and rows that carry a version are never deleted.
//   2. `written` keeps the order of the writes: state, open questions opened then closed, clock rows made then cancelled,
//      reservations confirmed (each with its saved-time clock row) then released (each with its class seats, its
//      saved-time clock row, the promoted row and the promoted row's clock row), effects written then let go.
//   3. A confirm or a release cancels the reservation's saved-time clock row only while it is waiting or armed; a
//      cancelled or fired one stays as it is and is not listed.
//   4. The promoted next in line gets its saved-time clock row here (K-05 item 9: "with its own saved-time clock row"),
//      as item 8 makes one: armed, due at held_until in the business's zone (CQ-05), owned by the mobile's handle or
//      else by the sweep, firing {"release": <id>, "why": "expired"}.
//   5. A waiting row's entry (item 19) carries the row's business and that business's zone (null, UTC, with none); its
//      why is {"followUp": "chatOpenAnswer", "supersededBy": <answer row>} or {"closedBooking": <id>} or
//      {"closedQuestion": <id>}, in the style of K-05 v1.1's follow-up entries (dispatcher-gives-up.json's followUpOf).
//   6. A repeat leaves waitingChat out of its answer: it ended no waiting row.
//   7. The changed rows are listed once per (table, row, version read), the versions read first, then the writes, in
//      the request's order.
//   8. A state write to K-07's tables (effects, provider_events, outbox_claims) is refused as the schema refuses
//      K-04's: each has its own list or call (stateTable: "except those the commit writes through their own lists").
//   9. A calendar effect with no provider answers constraint effects_calendar_keyed: the frozen CHECK lets a null
//      provider through (null in (...) is unknown), so code holds the rule until K-07's minor version (CQ-76, DL-132).
//  10. Every time the commit writes (committed_at, closed_at, cancelled_at, armed_at, released_at, an effect's
//      created_at, each entry's at) is one moment, the transaction's now() (the test's clock when given).
//  11. A state write's value for a bytea column (a sealed value, such as safety_outcomes.sealed_words or a pause's
//      address) is K-04's text form, "\x" and hex digit pairs, and is written as the bytes it spells (bytea.ts; T-1185):
//      postgres.js would store a string's own characters. A value in any other form throws, and nothing is written.
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.1";
import { byteaFromText } from "./bytea";
import { appendEvent, type EventEntry as LogEntry } from "./event-log";
import { releaseIn } from "./reservations";
import { assertBusinessId, SCOPE_SETTING, type Sql } from "./scope";
import { inRuntimeTransaction, transientOrThrow, utc } from "./targets";

/** K-05 v1.1 commitTurn.request: the turn row, the versions read and every write. */
export type CommitTurnRequest = K05.CommitTurnRequest;
/** K-05 v1.1 commitTurn.response: committed; a repeated turn id answers the first commit with repeated true. */
export type CommitTurnResponse = K05.CommitTurnResponse;
/** K-05 v1.1 commitTurn.errors: refused, nothing written. */
export type CommitTurnError = K05.CommitTurnErrors;
export type CommitTurnOutcome = CommitTurnResponse | CommitTurnError;

export interface CommitOptions {
  /** The commit's moment (K-05 `given.now`, the test's fake clock). Default: the transaction's now() on the database. */
  now?: Date;
}

type Json = Parameters<Sql["json"]>[0];
type Row = Record<string, unknown>;
/** An optional field of event-log.ts's entry as this call always gives it: present, a value or null. */
type Given<T> = Exclude<T, undefined>;
type ChangedRow = K05.ChangedRow;
type RowRef = K05.RowRef;
type Promotion = K05.Promotion;
type LostReservation = K05.ReservationLostError["reservations"][number];

/**
 * The tables a state write never names: K-05 v1 stateTable's list (each has its own list in the request, or is written
 * once by a call of its own), and K-07's three tables, which v1.1 gives their own lists and calls (default 8).
 */
export const NOT_STATE_TABLES: ReadonlySet<string> = new Set([
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "outbox_parts",
  "reservations",
  "class_seats",
  "event_log",
  "bundles",
  "bundle_values",
  "sealing_keys",
  "effects",
  "provider_events",
  "outbox_claims",
]);

/** A database rule that refuses a write answers `constraint` (K-05 README item 1). */
const CONSTRAINT_SQLSTATES = new Set(["23P01", "23514", "23505", "23503"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BUNDLE_HASH = /^[0-9a-f]{64}$/;
const CLOCK_KINDS = new Set(["question", "never_delivered", "saved_time", "step", "job"]);
const CALENDAR_PROVIDERS = new Set(["google", "microsoft"]);

/** Thrown inside the transaction to roll it back and answer one of K-05's refusals. */
class Refused extends Error {
  readonly answer: CommitTurnError;

  constructor(answer: CommitTurnError) {
    super("commitTurn refused");
    this.answer = answer;
  }
}

// ---- request checks: what the database cannot be trusted to refuse, or what reaches SQL as a name -------------------

function fail(what: string): never {
  throw new TypeError(`commitTurn: ${what}`);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertName(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !NAME.test(value)) {
    fail(`${what} is not a plain lower-case SQL name`);
  }
}

function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value === "" || value.includes("\u0000")) {
    fail(`${what} is not a non-empty id`);
  }
}

function assertNullableId(value: unknown, what: string): asserts value is string | null {
  if (value !== null) {
    assertId(value, what);
  }
}

function assertVersion(value: unknown, what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${what} is not a version (a positive integer)`);
  }
}

function idField(record: Row, field: string, what: string): string {
  const value = record[field];
  assertId(value, `${what}.${field}`);
  return value;
}

function nullableIdField(record: Row, field: string, what: string): string | null {
  const value = record[field];
  assertNullableId(value, `${what}.${field}`);
  return value;
}

function objectField(record: Row, field: string, what: string): Row {
  const value = record[field];
  if (!isRecord(value)) {
    fail(`${what}.${field} is not an object`);
  }
  return value;
}

function listOf(record: Row, field: string, what: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    fail(`${what}.${field} is not a list`);
  }
  return value as unknown[];
}

function checkTurn(turn: Row): void {
  idField(turn, "id", "turn");
  idField(turn, "handleId", "turn");
  idField(turn, "traceId", "turn");
  const eventIds = listOf(turn, "eventIds", "turn");
  if (eventIds.length === 0) {
    fail("turn.eventIds is empty: a turn joins at least one text");
  }
  eventIds.forEach((id) => {
    assertId(id, "turn.eventIds[]");
  });
  listOf(turn, "joinedTraceIds", "turn").forEach((id) => {
    assertId(id, "turn.joinedTraceIds[]");
  });
  const bundle = objectField(turn, "bundleId", "turn");
  if (typeof bundle.hash !== "string" || !BUNDLE_HASH.test(bundle.hash)) {
    fail("turn.bundleId.hash is not 64 lower-case hex characters");
  }
  assertVersion(bundle.build, "turn.bundleId.build");
  const tries = turn.tries;
  if (tries !== 1 && tries !== 2 && tries !== 3) {
    fail("turn.tries is not 1, 2 or 3");
  }
}

/**
 * What code checks before the database is reached (the schema's rules this layer relies on, and every name that reaches
 * SQL as an identifier), so a malformed request writes nothing and touches nothing.
 */
function checkRequest(request: CommitTurnRequest): void {
  const raw: unknown = request;
  if (!isRecord(raw)) {
    fail("the request is not an object");
  }
  checkTurn(objectField(raw, "turn", "request"));
  for (const ref of listOf(raw, "versionsRead", "request")) {
    if (!isRecord(ref)) {
      fail("versionsRead[] is not a row reference");
    }
    assertName(ref.table, "versionsRead[].table");
    assertId(ref.rowId, "versionsRead[].rowId");
    assertVersion(ref.version, "versionsRead[].version");
  }
  const writes = objectField(raw, "writes", "request");
  const pairs = [
    ["openQuestions", "open", "close"],
    ["clockRows", "make", "cancel"],
    ["reservations", "confirm", "release"],
  ] as const;
  for (const [group, first, second] of pairs) {
    const lists = objectField(writes, group, "writes");
    listOf(lists, first, `writes.${group}`);
    listOf(lists, second, `writes.${group}`);
  }
  listOf(writes, "outboxRows", "writes");
  listOf(writes, "events", "writes");
  if (writes.effects !== undefined) {
    const effects = objectField(writes, "effects", "writes");
    listOf(effects, "write", "writes.effects");
    listOf(effects, "letGo", "writes.effects");
  }
  for (const write of listOf(writes, "state", "writes")) {
    if (!isRecord(write)) {
      fail("a state write is not an object");
    }
    assertName(write.table, "a state write's table");
    if (NOT_STATE_TABLES.has(write.table)) {
      fail(`a state write may not name ${write.table}: the commit writes it through its own list or call`);
    }
    if (write.op === "update") {
      assertVersion(write.expectVersion, "a state update's expectVersion");
      objectField(write, "key", "a state update");
      if (Object.hasOwn(objectField(write, "set", "a state update"), "version")) {
        fail("a state update may not set the version: the update raises it");
      }
    } else if (write.op === "insert") {
      objectField(write, "values", "a state insert");
    } else {
      fail("a state write is neither an insert nor an update");
    }
  }
  for (const row of request.writes.outboxRows) {
    if (Object.hasOwn(row, "plan") || Object.hasOwn(row, "finalParts")) {
      fail("an outbox row at the commit carries no plan: words are written into it after the commit");
    }
  }
  if (writes.waitingChat !== undefined) {
    const waiting = objectField(writes, "waitingChat", "writes");
    listOf(waiting, "withdrawForBookings", "writes.waitingChat");
    listOf(waiting, "withdrawForQuestions", "writes.waitingChat");
    const supersede = request.writes.waitingChat?.supersede ?? null;
    if (supersede !== null) {
      // K-05 v1.1 item 19's code check: the one answer is this commit's own row to the mobile that texted in.
      const answer = request.writes.outboxRows.find(
        (row) => row.id === supersede.answerRowId && row.recipientHandleId === supersede.recipientHandleId,
      );
      if (answer === undefined) {
        fail("waitingChat.supersede's answer row is not one of this commit's outbox rows to that handle");
      }
    }
  }
}

// ---- the transaction's scope, set per write ---------------------------------------------------------------------------

/** The business scope of the commit's transaction, set to each write's own business (null: the runtime side). */
class Scope {
  private readonly tx: Sql;
  private current: string | null = null;

  constructor(tx: Sql) {
    this.tx = tx;
  }

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

// ---- tables, read from the catalog once per call ------------------------------------------------------------------------

interface TableInfo {
  readonly name: string;
  readonly columns: ReadonlySet<string>;
  readonly jsonColumns: ReadonlySet<string>;
  /** The columns of type bytea, whose values come in K-04's text form and are written as their bytes (default 11). */
  readonly byteaColumns: ReadonlySet<string>;
  readonly key: readonly string[];
  readonly versioned: boolean;
  /** The column row-level security scopes the table by (K-04 rule 4), or null for a table with none. */
  readonly scopeColumn: string | null;
}

interface Context {
  readonly tx: Sql;
  readonly now: Date;
  /** `now` in the contract's form. */
  readonly at: string;
  readonly turn: K05.Turn;
  readonly scope: Scope;
  readonly tables: Map<string, TableInfo>;
}

/**
 * A table's columns, its JSON and bytea columns, its primary key and its row-level security, from the catalog: an
 * ordinary table of this connection's search path (never one of PostgreSQL's own), or a throw. Read once per call.
 */
async function tableInfo(ctx: Context, table: string): Promise<TableInfo> {
  const known = ctx.tables.get(table);
  if (known !== undefined) {
    return known;
  }
  assertName(table, "a table name");
  const [row] = await ctx.tx<
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
    fail(`no table ${table} in this database's schema`);
  }
  const columns = new Set(row.columns);
  let scopeColumn: string | null = null;
  if (row.rls) {
    scopeColumn = table === "businesses" ? "id" : "business_id";
    if (!columns.has(scopeColumn)) {
      fail(`${table} has row-level security but no business column this call can scope by`);
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
  ctx.tables.set(table, info);
  return info;
}

/** The one key column of a versioned table: a row reference names a row by one key as text (K-02 fact rowId). */
function oneKey(info: TableInfo): string {
  const [key, ...more] = info.key;
  if (!info.versioned) {
    fail(`${info.name} carries no version, so no commit compares or names its rows`);
  }
  if (key === undefined || more.length > 0) {
    fail(`${info.name}'s primary key is not one column, so a row reference cannot name its rows`);
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
  assertId(value, `${info.name}.${info.scopeColumn}`);
  return value;
}

/**
 * One column's value as postgres.js takes it: null as null, a JSON column's as JSON, a bytea column's as the bytes its
 * text form spells (default 11: any other form throws, naming the column, never the value), the rest as PostgreSQL text
 * input (K-05 v1).
 */
function columnValue(ctx: Context, info: TableInfo, column: string, value: unknown, what: string): unknown {
  if (value === null) {
    return null;
  }
  if (info.jsonColumns.has(column)) {
    return ctx.tx.json(value as Json);
  }
  if (info.byteaColumns.has(column)) {
    const bytes = byteaFromText(value);
    if (bytes === null) {
      fail(`${what} gives ${info.name}.${column} a value that is not "\\x" and hex digit pairs`);
    }
    return bytes;
  }
  return value;
}

/** Column to value for an insert or an update, each as columnValue gives it. */
function columnValues(ctx: Context, info: TableInfo, values: Row, what: string): Record<string, never> {
  const out: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    assertName(column, `${what}'s column`);
    if (!info.columns.has(column)) {
      fail(`${what} names a column ${info.name} does not have`);
    }
    out[column] = columnValue(ctx, info, column, value, what) as never;
  }
  if (Object.keys(out).length === 0) {
    fail(`${what} writes no column`);
  }
  return out;
}

// ---- 2. the locks and the compares ---------------------------------------------------------------------------------------

type Mode = "share" | "update";

interface Locked {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
  readonly business: string | null;
  readonly row: Row;
}

const targetKey = (table: string, rowId: string): string => `${table}\u0000${rowId}`;
const savedTimeClockId = (reservationId: string): string => `${reservationId}/saved-time`;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function lockRow(ctx: Context, table: string, rowId: string, mode: Mode): Promise<Locked> {
  const info = await tableInfo(ctx, table);
  const key = oneKey(info);
  const { tx } = ctx;
  const [row] =
    mode === "update"
      ? await tx<Row[]>`select * from ${tx(table)} where ${tx(key)} = ${rowId} for update`
      : await tx<Row[]>`select * from ${tx(table)} where ${tx(key)} = ${rowId} for share`;
  if (row === undefined) {
    fail(`a row of ${table} the request names does not exist (default 1)`);
  }
  const version = row.version;
  assertVersion(version, `${table}.version`);
  return { table, rowId, version, business: businessOf(info, row), row };
}

/** The saved-time clock rows of the reservations the commit confirms or releases, locked first (FOR UPDATE). */
async function lockSavedTimeClocks(
  ctx: Context,
  reservationIds: readonly string[],
): Promise<Map<string, Row>> {
  const ids = [...new Set(reservationIds.map(savedTimeClockId))].sort(compareText);
  const rows =
    ids.length === 0
      ? []
      : await ctx.tx<Row[]>`
          select id, business_id, state, version from clock_rows where id in ${ctx.tx(ids)}
          order by id collate "C" for update
        `;
  return new Map(rows.map((row) => [String(row.id), row]));
}

/**
 * The slot locks of the reservations the commit releases, taken before any reservation row is locked: the same keys,
 * in the same order, as db/repo/reservations.ts's lockSlot (the resource, and for a worker the person, sorted), so a
 * release inside a commit and a reserve or release on its own always take the slot before the row.
 */
async function lockReleaseSlots(ctx: Context, reservationIds: readonly string[]): Promise<void> {
  if (reservationIds.length === 0) {
    return;
  }
  const slots = await ctx.tx<
    { resource_id: string; resource_kind: string; worker_person_id: string | null }[]
  >`
    select resource_id, resource_kind, worker_person_id from reservations where id in ${ctx.tx([...reservationIds])}
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
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

interface Compared {
  /** Every row compared or written, by targetKey. */
  readonly rows: ReadonlyMap<string, Locked>;
  /** The saved-time clock rows found, by clock row id. */
  readonly savedTimeClocks: ReadonlyMap<string, Row>;
}

interface Expectation {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
}

/** A state update's row id: its one key column's value, the key naming exactly the primary key (no wider update). */
async function stateUpdateTarget(
  ctx: Context,
  write: Extract<K05.StateWrite, { op: "update" }>,
): Promise<string> {
  const info = await tableInfo(ctx, write.table);
  const key = oneKey(info);
  const named = Object.keys(write.key);
  if (named.length !== 1 || named[0] !== key) {
    fail(`a state update of ${write.table} must name the row by its primary key alone`);
  }
  const value = write.key[key];
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    fail(`a state update of ${write.table} names its key with no value`);
  }
  if (Object.hasOwn(write.set, key)) {
    fail(`a state update of ${write.table} may not change the row's key`);
  }
  return String(value);
}

async function lockAndCompare(ctx: Context, request: CommitTurnRequest): Promise<Compared> {
  const { writes } = request;
  const confirms = writes.reservations.confirm;
  const releases = writes.reservations.release;
  const letGos = writes.effects?.letGo ?? [];

  const savedTimeClocks = await lockSavedTimeClocks(ctx, [
    ...confirms.map((confirm) => confirm.id),
    ...releases.map((release) => release.id),
  ]);
  await lockReleaseSlots(
    ctx,
    releases.map((release) => release.id),
  );

  // Every row compared or written, with the strongest lock it needs, and every version the request read or expects.
  const modes = new Map<string, { table: string; rowId: string; mode: Mode }>();
  const expected: Expectation[] = [];
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
      want(write.table, await stateUpdateTarget(ctx, write), "update", write.expectVersion);
    }
  }
  for (const close of writes.openQuestions.close) {
    assertId(close.id, "openQuestions.close[].id");
    assertVersion(close.expectVersion, "openQuestions.close[].expectVersion");
    want("open_questions", close.id, "update", close.expectVersion);
  }
  for (const cancel of writes.clockRows.cancel) {
    assertId(cancel.id, "clockRows.cancel[].id");
    assertVersion(cancel.expectVersion, "clockRows.cancel[].expectVersion");
    want("clock_rows", cancel.id, "update", cancel.expectVersion);
  }
  for (const move of [...confirms, ...releases]) {
    assertId(move.id, "a reservation's id");
    assertVersion(move.expectVersion, "a reservation's expectVersion");
    want("reservations", move.id, "update", move.expectVersion);
  }
  for (const letGo of letGos) {
    assertId(letGo.effectId, "effects.letGo[].effectId");
    assertVersion(letGo.expectVersion, "effects.letGo[].expectVersion");
    want("effects", letGo.effectId, "update", letGo.expectVersion);
  }

  // Locked in one fixed order, so two commits never wait on each other in a circle.
  const rows = new Map<string, Locked>();
  const order = [...modes.values()].sort(
    (a, b) => compareText(a.table, b.table) || compareText(a.rowId, b.rowId),
  );
  for (const target of order) {
    rows.set(
      targetKey(target.table, target.rowId),
      await lockRow(ctx, target.table, target.rowId, target.mode),
    );
  }
  const locked = (table: string, rowId: string): Locked => {
    const row = rows.get(targetKey(table, rowId));
    if (row === undefined) {
      throw new Error(`commitTurn: a ${table} row was compared but not locked`);
    }
    return row;
  };

  // Limit 5: a reservation to confirm must still be held, and not past its end (checked before its version).
  const lost: LostReservation[] = [];
  for (const confirm of confirms) {
    const { row } = locked("reservations", confirm.id);
    const heldUntil = row.held_until instanceof Date ? row.held_until : null;
    if (row.state !== "held" || heldUntil === null || heldUntil.getTime() <= ctx.now.getTime()) {
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

  // Limit 4: every row read or written at the version the turn saw, each changed row listed once.
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

function nonEmpty<T>(items: readonly T[]): [T, ...T[]] | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

// ---- 3. the writes -----------------------------------------------------------------------------------------------------

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
    throw new Error(`commitTurn: a ${table} row is written but was not locked`);
  }
  return row;
}

async function writeState(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const write of request.writes.state) {
    const info = await tableInfo(ctx, write.table);
    if (write.op === "insert") {
      const what = `a state insert into ${write.table}`;
      const values = columnValues(ctx, info, write.values, what);
      const business = info.scopeColumn === null ? null : businessOf(info, write.values);
      await ctx.scope.to(business);
      if (!info.versioned) {
        await tx`insert into ${tx(write.table)} ${tx(values)}`;
        continue;
      }
      const key = oneKey(info);
      const [row] = await tx<{ key: unknown; version: number }[]>`
        insert into ${tx(write.table)} ${tx(values)} returning ${tx(key)} as key, version
      `;
      if (row === undefined) {
        throw new Error(`commitTurn: ${what} returned no row`);
      }
      out.written.push({ table: write.table, rowId: String(row.key), version: row.version });
      continue;
    }
    const rowId = await stateUpdateTarget(ctx, write);
    const key = oneKey(info);
    const locked = lockedRow(compared, write.table, rowId);
    const set = columnValues(ctx, info, write.set, `a state update of ${write.table}`);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update ${tx(write.table)} set ${tx(set)}, version = ${write.expectVersion + 1}
      where ${tx(key)} = ${rowId} and version = ${write.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error(`commitTurn: a state update of ${write.table} matched no row at its version`);
    }
    out.written.push({ table: write.table, rowId, version: row.version });
  }
}

async function writeOpenQuestions(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx, turn } = ctx;
  for (const question of request.writes.openQuestions.open) {
    const what = "openQuestions.open[]";
    const record = question as unknown as Row;
    idField(record, "id", what);
    idField(record, "handleId", what);
    nullableIdField(record, "personId", what);
    const business = nullableIdField(record, "businessId", what);
    nullableIdField(record, "bookingId", what);
    await ctx.scope.to(business);
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
    assertNullableId(close.answeredOptionId, "openQuestions.close[].answeredOptionId");
    const locked = lockedRow(compared, "open_questions", close.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update open_questions
      set status = ${close.status}, answered_option_id = ${close.answeredOptionId}, closed_at = ${ctx.now},
          version = ${close.expectVersion + 1}
      where id = ${close.id} and version = ${close.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: an open question's close matched no row at its version");
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

/** K-05 v1 clockNew (typed loosely by the generator): the fields this call writes, checked. */
function clockFields(clock: K05.ClockNew): ClockFields {
  const what = "clockRows.make[]";
  const kind = clock.kind;
  if (typeof kind !== "string" || !CLOCK_KINDS.has(kind)) {
    fail(`${what}.kind is not one of K-04's clock kinds`);
  }
  let due: ClockFields["due"] = null;
  if (clock.due !== undefined) {
    const record = objectField(clock, "due", what);
    const dueAt = record.dueAt;
    const dueZone = record.dueZone;
    if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt)) || typeof dueZone !== "string") {
      fail(`${what}.due needs dueAt (UTC) and dueZone`);
    }
    due = { dueAt, dueZone };
  }
  return {
    id: idField(clock, "id", what),
    kind,
    openQuestionId: nullableIdField(clock, "openQuestionId", what),
    reservationId: nullableIdField(clock, "reservationId", what),
    handleId: nullableIdField(clock, "handleId", what),
    businessId: nullableIdField(clock, "businessId", what),
    bookingId: nullableIdField(clock, "bookingId", what),
    fires: objectField(clock, "fires", what),
    due,
  };
}

async function insertClock(ctx: Context, clock: ClockFields): Promise<RowRef> {
  const { tx, turn } = ctx;
  await ctx.scope.to(clock.businessId);
  const [row] = await tx<{ version: number }[]>`
    insert into clock_rows (
      id, kind, open_question_id, reservation_id, handle_id, business_id, booking_id, due_at, due_zone, state,
      armed_at, fires, created_by_turn_id
    ) values (
      ${clock.id}, ${clock.kind}, ${clock.openQuestionId}, ${clock.reservationId}, ${clock.handleId},
      ${clock.businessId}, ${clock.bookingId}, ${clock.due?.dueAt ?? null}, ${clock.due?.dueZone ?? null},
      ${clock.due === null ? "waiting" : "armed"}, ${clock.due === null ? null : ctx.now},
      ${tx.json(clock.fires as Json)}, ${turn.id}
    )
    returning version
  `;
  return { table: "clock_rows", rowId: clock.id, version: row?.version ?? 1 };
}

async function writeClockRows(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const clock of request.writes.clockRows.make) {
    out.written.push(await insertClock(ctx, clockFields(clock)));
  }
  for (const cancel of request.writes.clockRows.cancel) {
    const locked = lockedRow(compared, "clock_rows", cancel.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update clock_rows set state = 'cancelled', cancelled_at = ${ctx.now}, version = ${cancel.expectVersion + 1}
      where id = ${cancel.id} and version = ${cancel.expectVersion}
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: a clock row's cancel matched no row at its version");
    }
    out.written.push({ table: "clock_rows", rowId: cancel.id, version: row.version });
  }
}

async function writeOutboxRows(ctx: Context, request: CommitTurnRequest, out: Written): Promise<void> {
  const { tx, turn } = ctx;
  for (const outboxRow of request.writes.outboxRows) {
    const what = "outboxRows[]";
    const record = outboxRow as unknown as Row;
    idField(record, "id", what);
    idField(record, "recipientHandleId", what);
    nullableIdField(record, "recipientPersonId", what);
    const business = nullableIdField(record, "businessId", what);
    nullableIdField(record, "bookingId", what);
    nullableIdField(record, "openQuestionId", what);
    nullableIdField(record, "copyOfRowId", what);
    await ctx.scope.to(business);
    const [row] = await tx<{ commit_seq: string | number }[]>`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, recipient_person_id, business_id, booking_id, channel, send_class,
        versions_read, open_question_id, copy_of_row_id, bundle_hash, bundle_build, trace_id
      ) values (
        ${outboxRow.id}, ${turn.id}, ${outboxRow.recipientHandleId}, ${outboxRow.recipientPersonId},
        ${outboxRow.businessId}, ${outboxRow.bookingId}, ${outboxRow.channel}, ${outboxRow.sendClass},
        ${tx.json(outboxRow.versionsRead as unknown as Json)}, ${outboxRow.openQuestionId}, ${outboxRow.copyOfRowId},
        ${turn.bundleId.hash}, ${turn.bundleId.build}, ${turn.traceId}
      )
      returning commit_seq
    `;
    out.outboxRows.push({ id: outboxRow.id, commitSeq: commitSeqOf(row?.commit_seq) });
  }
}

function commitSeqOf(value: unknown): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("commitTurn: an outbox row's commit_seq is not a positive integer");
  }
  return seq;
}

/** Cancels a reservation's saved-time clock row while it is waiting or armed (default 3), under its own business. */
async function cancelSavedTimeClock(
  ctx: Context,
  compared: Compared,
  reservationId: string,
): Promise<RowRef | null> {
  const id = savedTimeClockId(reservationId);
  const clock = compared.savedTimeClocks.get(id);
  if (clock === undefined || (clock.state !== "waiting" && clock.state !== "armed")) {
    return null;
  }
  const business = clock.business_id;
  assertNullableId(business, "clock_rows.business_id");
  await ctx.scope.to(business);
  const [row] = await ctx.tx<{ version: number }[]>`
    update clock_rows set state = 'cancelled', cancelled_at = ${ctx.now}, version = version + 1
    where id = ${id} and state in ('waiting', 'armed')
    returning version
  `;
  return row === undefined ? null : { table: "clock_rows", rowId: id, version: row.version };
}

/** The promoted next in line's saved-time clock row (default 4; K-05 items 8 and 9). */
async function promotedClock(ctx: Context, promotion: Promotion, business: string): Promise<RowRef> {
  const [owner] =
    promotion.forPhoneNumber === null
      ? []
      : await ctx.tx<{ handle_id: string | null }[]>`
          select handle_id from phones where number = ${promotion.forPhoneNumber}
        `;
  await ctx.scope.to(business);
  const [zone] = await ctx.tx<
    { time_zone: string }[]
  >`select time_zone from businesses where id = ${business}`;
  if (zone === undefined) {
    throw new Error("commitTurn: the promoted reservation's business was not found under its own scope");
  }
  return insertClock(ctx, {
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
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx } = ctx;
  for (const confirm of request.writes.reservations.confirm) {
    assertId(confirm.bookingId, "reservations.confirm[].bookingId");
    const locked = lockedRow(compared, "reservations", confirm.id);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update reservations set state = 'booked', booking_id = ${confirm.bookingId},
                              version = ${confirm.expectVersion + 1}
      where id = ${confirm.id} and version = ${confirm.expectVersion} and state = 'held'
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: a reservation's confirm matched no held row at its version");
    }
    out.written.push({ table: "reservations", rowId: confirm.id, version: row.version });
    const clock = await cancelSavedTimeClock(ctx, compared, confirm.id);
    if (clock !== null) {
      out.written.push(clock);
    }
  }
  for (const release of request.writes.reservations.release) {
    const locked = lockedRow(compared, "reservations", release.id);
    const business = locked.business;
    if (business === null) {
      throw new Error("commitTurn: a reservation to release has no business");
    }
    await ctx.scope.to(business);
    const outcome = await releaseIn(tx, {
      reservationId: release.id,
      businessId: business,
      expectVersion: release.expectVersion,
      why: release.why,
      at: ctx.at,
    });
    if ("error" in outcome) {
      // The row was locked and compared above, so a refusal here is a fault, never an answer.
      throw new Error(`commitTurn: a reservation's release was refused after its compare (${outcome.error})`);
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
    const clock = await cancelSavedTimeClock(ctx, compared, release.id);
    if (clock !== null) {
      out.written.push(clock);
    }
    if (outcome.promoted !== null) {
      const promotion: Promotion = { ...outcome.promoted };
      out.written.push({ table: "reservations", rowId: promotion.reservationId, version: promotion.version });
      out.written.push(await promotedClock(ctx, promotion, business));
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

/** K-05 v1.1 effectNew (typed loosely by the generator): the fields this call writes, checked. */
function effectFields(effect: K05.EffectNew): EffectFields {
  const what = "effects.write[]";
  const kind = effect.kind;
  const port = effect.port;
  if (typeof kind !== "string" || typeof port !== "string") {
    fail(`${what} needs a kind and a port`);
  }
  const provider = effect.calendarProvider;
  if (provider !== null && (typeof provider !== "string" || !CALENDAR_PROVIDERS.has(provider))) {
    fail(`${what}.calendarProvider is not google, microsoft or null`);
  }
  let amount: EffectFields["amount"] = null;
  if (effect.amount !== null) {
    const record = objectField(effect, "amount", what);
    if (!Number.isSafeInteger(record.cents) || typeof record.currency !== "string") {
      fail(`${what}.amount needs whole cents and a currency`);
    }
    amount = { cents: record.cents as number, currency: record.currency };
  }
  const key = effect.idempotencyKey;
  if (typeof key !== "string" || key === "") {
    fail(`${what}.idempotencyKey is not a non-empty key`);
  }
  return {
    effectId: idField(effect, "effectId", what),
    businessId: nullableIdField(effect, "businessId", what),
    bookingId: nullableIdField(effect, "bookingId", what),
    kind,
    port,
    calendarProvider: provider,
    visitId: nullableIdField(effect, "visitId", what),
    personId: nullableIdField(effect, "personId", what),
    handleId: nullableIdField(effect, "handleId", what),
    amount,
    portRequest: objectField(effect, "portRequest", what),
    idempotencyKey: key,
    traceId: idField(effect, "traceId", what),
  };
}

async function writeEffects(
  ctx: Context,
  request: CommitTurnRequest,
  compared: Compared,
  out: Written,
): Promise<void> {
  const { tx, turn } = ctx;
  const effects = request.writes.effects;
  if (effects === undefined) {
    return;
  }
  for (const effect of effects.write.map(effectFields)) {
    if (effect.port === "calendar" && effect.calendarProvider === null) {
      // The CHECK effects_calendar_keyed lets a null provider through; its refusal is answered here (default 9).
      throw new Refused({ error: "constraint", sqlstate: "23514", constraint: "effects_calendar_keyed" });
    }
    await ctx.scope.to(effect.businessId);
    const [row] = await tx<{ version: number }[]>`
      insert into effects (
        id, turn_id, job_id, business_id, booking_id, kind, port, calendar_provider, visit_id, person_id, handle_id,
        amount_cents, currency, port_request, idempotency_key, trace_id, created_at
      ) values (
        ${effect.effectId}, ${turn.id}, null, ${effect.businessId}, ${effect.bookingId}, ${effect.kind},
        ${effect.port}, ${effect.calendarProvider}, ${effect.visitId}, ${effect.personId}, ${effect.handleId},
        ${effect.amount?.cents ?? null}, ${effect.amount?.currency ?? null}, ${tx.json(effect.portRequest as Json)},
        ${effect.idempotencyKey}, ${effect.traceId}, ${ctx.now}
      )
      returning version
    `;
    out.written.push({ table: "effects", rowId: effect.effectId, version: row?.version ?? 1 });
  }
  for (const letGo of effects.letGo) {
    const locked = lockedRow(compared, "effects", letGo.effectId);
    await ctx.scope.to(locked.business);
    const [row] = await tx<{ version: number }[]>`
      update effects set state = 'cancelled', version = ${letGo.expectVersion + 1}
      where id = ${letGo.effectId} and version = ${letGo.expectVersion} and state = 'outage'
      returning version
    `;
    if (row === undefined) {
      throw new Error("commitTurn: an effect let go matched no outage row at its version");
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
  ctx: Context,
  row: WaitingRow,
  to: "superseded" | "withdrawn",
  why: Record<string, string>,
): Promise<RowRef> {
  await ctx.scope.to(row.business_id);
  const [moved] = await ctx.tx<{ version: number }[]>`
    update outbox_rows set state = ${to}, version = ${row.version + 1}
    where id = ${row.id} and version = ${row.version} and state = 'waiting_chat'
    returning version
  `;
  if (moved === undefined) {
    throw new Error("commitTurn: a waiting row moved while it was locked");
  }
  await appendEvent(ctx.tx, eventContext(ctx), {
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
    at: ctx.now,
  });
  return { table: "outbox_rows", rowId: row.id, version: moved.version };
}

/** K-05 v1.1 item 19: the waiting rows this commit ends, found by the call itself, FOR UPDATE, so none is missed. */
async function writeWaitingChat(ctx: Context, request: CommitTurnRequest, out: Written): Promise<void> {
  const waiting = request.writes.waitingChat;
  if (waiting === undefined) {
    return;
  }
  const { tx } = ctx;
  if (waiting.supersede !== null) {
    // checkRequest held the answer row to this commit's own rows to that handle.
    const { recipientHandleId, answerRowId } = waiting.supersede;
    await ctx.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and r.recipient_handle_id = ${recipientHandleId}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      out.superseded.push(
        await endWaitingRow(ctx, row, "superseded", {
          followUp: "chatOpenAnswer",
          supersededBy: answerRowId,
        }),
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
      assertId(id, `waitingChat's ${list.why} id`);
    });
    await ctx.scope.to(null);
    const rows = await tx<WaitingRow[]>`
      select r.id, r.version, r.business_id, r.booking_id, r.open_question_id, b.time_zone
      from outbox_rows r left join businesses b on b.id = r.business_id
      where r.state = 'waiting_chat' and ${tx(`r.${list.column}`)} in ${tx([...list.ids])}
      order by r.commit_seq
      for update of r
    `;
    for (const row of rows) {
      const closed = list.column === "booking_id" ? row.booking_id : row.open_question_id;
      out.withdrawn.push(await endWaitingRow(ctx, row, "withdrawn", { [list.why]: closed ?? "" }));
    }
  }
}

function eventContext(ctx: Context): {
  turnId: string;
  traceId: string;
  bundle: { hash: string; build: number };
} {
  return {
    turnId: ctx.turn.id,
    traceId: ctx.turn.traceId,
    bundle: { hash: ctx.turn.bundleId.hash, build: ctx.turn.bundleId.build },
  };
}

function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** The request's event-log entries (K-05 v1 eventEntry), each under its own business, with the turn's id, trace and bundle. */
async function writeEvents(ctx: Context, request: CommitTurnRequest): Promise<void> {
  for (const entry of request.writes.events) {
    assertId(entry.id, "events[].id");
    assertNullableId(entry.businessId, "events[].businessId");
    await ctx.scope.to(entry.businessId);
    const logEntry: LogEntry = {
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
      at: ctx.now,
    };
    await appendEvent(ctx.tx, eventContext(ctx), logEntry);
  }
}

// ---- 1. the turn, and a repeat ------------------------------------------------------------------------------------------

async function commitMoment(tx: Sql, options: CommitOptions): Promise<Date> {
  if (options.now !== undefined) {
    if (Number.isNaN(options.now.getTime())) {
      fail("now is not a valid date");
    }
    return options.now;
  }
  const [row] = await tx<{ now: Date }[]>`select now() as now`;
  if (row === undefined) {
    throw new Error("commitTurn: select now() returned no row");
  }
  return row.now;
}

/** A turn id met again: its first commit (K-05 item 1), or turnParked; nothing is written. */
async function repeatOf(tx: Sql, turnId: string): Promise<CommitTurnOutcome> {
  const [turn] = await tx<{ state: string; committed_at: Date | null; parked_at: Date | null }[]>`
    select state, committed_at, parked_at from turns where id = ${turnId}
  `;
  if (turn?.state === "parked" && turn.parked_at !== null) {
    return { error: "turnParked", turnId, parkedAt: utc(turn.parked_at) };
  }
  if (turn?.state !== "committed" || turn.committed_at === null) {
    throw new Error("commitTurn: the turn id is taken by a turn that is neither committed nor parked");
  }
  const rows = await tx<{ id: string; commit_seq: string | number }[]>`
    select id, commit_seq from outbox_rows where turn_id = ${turnId} order by commit_seq
  `;
  return {
    result: "committed",
    turnId,
    committedAt: utc(turn.committed_at),
    repeated: true,
    committed: {
      written: [],
      outboxRows: rows.map((row) => ({ id: row.id, commitSeq: commitSeqOf(row.commit_seq) })),
      promoted: [],
    },
  };
}

/** The whole commit inside the transaction `tx` (the runtime side, no scope at its start). */
async function commitIn(
  tx: Sql,
  request: CommitTurnRequest,
  options: CommitOptions,
): Promise<CommitTurnOutcome> {
  const { turn } = request;
  const now = await commitMoment(tx, options);
  const inserted = await tx<{ id: string }[]>`
    insert into turns (
      id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids, tries, committed_at
    ) values (
      ${turn.id}, ${turn.handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash}, ${turn.bundleId.build},
      ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries}, ${now}
    )
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length === 0) {
    return repeatOf(tx, turn.id);
  }

  const ctx: Context = { tx, now, at: utc(now), turn, scope: new Scope(tx), tables: new Map() };
  const compared = await lockAndCompare(ctx, request);
  const out: Written = { written: [], outboxRows: [], promoted: [], superseded: [], withdrawn: [] };
  await writeState(ctx, request, compared, out);
  await writeOpenQuestions(ctx, request, compared, out);
  await writeClockRows(ctx, request, compared, out);
  await writeOutboxRows(ctx, request, out);
  await writeReservations(ctx, request, compared, out);
  await writeEffects(ctx, request, compared, out);
  await writeWaitingChat(ctx, request, out);
  await writeEvents(ctx, request);

  const ended = out.superseded.length + out.withdrawn.length > 0;
  return {
    result: "committed",
    turnId: turn.id,
    committedAt: ctx.at,
    repeated: false,
    committed: {
      written: out.written,
      outboxRows: out.outboxRows,
      promoted: out.promoted,
      ...(ended ? { waitingChat: { superseded: out.superseded, withdrawn: out.withdrawn } } : {}),
    },
  };
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

/**
 * Any other refusal by the database, as it leaves this call: its SQLSTATE and the names of its table and constraint,
 * never PostgresError's message, detail or query, which can hold a row's values (STATE's notes for later cards, 3).
 */
export class CommitTurnDatabaseError extends Error {
  readonly code: string;
  readonly table: string | null;
  readonly constraint: string | null;

  constructor(code: string, table: string | null, constraint: string | null) {
    const names = [
      table === null ? "" : `, table ${table}`,
      constraint === null ? "" : `, constraint ${constraint}`,
    ];
    super(`commitTurn: the database refused the commit (SQLSTATE ${code}${names.join("")})`);
    this.code = code;
    this.table = table;
    this.constraint = constraint;
    this.name = "CommitTurnDatabaseError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function nameOrNull(value: unknown): string | null {
  return typeof value === "string" && NAME.test(value) ? value : null;
}

/** A PostgreSQL error as CommitTurnDatabaseError; any other error as it is. */
function scrubbed(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "PostgresError") {
    return error;
  }
  const failure = error as Error & { code?: unknown; table_name?: unknown; constraint_name?: unknown };
  if (typeof failure.code !== "string" || !SQLSTATE.test(failure.code)) {
    return error;
  }
  return new CommitTurnDatabaseError(
    failure.code,
    nameOrNull(failure.table_name),
    nameOrNull(failure.constraint_name),
  );
}

/**
 * Commits a turn (K-05 v1.1 item 1): one transaction on the primary, on the runtime side with the business scope set per
 * write. Pass the client's primary handle, run as rosie_job. Answers committed (repeated true for a turn id already
 * committed, which writes nothing), or a refusal that wrote nothing: versionChanged (limit 4), reservationLost (limit
 * 5), turnParked, wrongState (an effect let go not in outage), constraint (a database rule) or transient. Throws for a
 * request it cannot carry out (see the top of this file), a database error as CommitTurnDatabaseError; nothing is
 * written then either.
 */
export async function commitTurn(
  sql: Sql,
  request: CommitTurnRequest,
  options: CommitOptions = {},
): Promise<CommitTurnOutcome> {
  checkRequest(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: false }, (tx) => commitIn(tx, request, options));
  } catch (error) {
    if (error instanceof Refused) {
      return error.answer;
    }
    const refused = constraintOf(error);
    if (refused !== null) {
      return refused;
    }
    try {
      return transientOrThrow(error, "commitTurn");
    } catch (thrown) {
      // transientOrThrow throws a session's failure already scrubbed (T-1268): that goes on as it is. What it lets
      // through unchanged (a statement's own refusal) is scrubbed here, as before.
      throw thrown === error ? scrubbed(error) : thrown;
    }
  }
}
