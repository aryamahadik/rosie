// Data-access K-05 v1.2 item 26, readTurnState, with the setup parts' facts (T-667; README "v1.2's consumers": "T-667
// (the setup-part facts readTurnState reads, over K-22 to K-35, in M4)"; arch 02 line 117: each fact once, from its home,
// with its row and version; arch 10 lines 504, 538: decision reads on the primary, uncached).
//
// The same call as db/repo/turn-state.ts's, with the same request, answer, refusals, side and moment, whose facts may
// also name a setup part's home (fact-homes.ts SETUP_FACT_HOMES): a frontier or a Tool API call of journeys 1 and 2 that
// names a setup fact uses this one. K-04 core's facts, the handle, its people, roles, phone, open questions, bookings,
// pauses and consents are read by turn-state.ts's readTurnStateIn itself, in the same transaction, and this file reads
// each setup fact beside them:
//   - unknownFact names the first fact, in the request's order, whose home is neither a core home nor a setup home,
//     before anything is read;
//   - notFound names the first thing missing in the request's order, as turn-state.ts does: the handle, the business, a
//     booking, then a fact's row, core or setup alike; a setup fact's row of another business counts as missing;
//   - the facts come back in the request's order, each with its row's version (limit 4).
//
// A setup fact's row is named as K-05 names a row: a key of one column by its value, a key of two columns by K-05 v1.18
// item 77's name, the key's values joined by "/" in key order, which the SQL builds from the row's own columns and
// compares with the rowId whole, never split (row-names.ts). Every read of a business-scoped setup table also names the
// business (with businessId null, rows with no business), as turn-state.ts does, so the answer holds no other business's
// row even for a role row-level security does not bind, and a two-column name's compare uses the business's index
// (T-1427's database engineer's N3) rather than a scan. A table scoped none is read the same on both sides (K-24's kinds
// and kind_flows, the shared catalog; K-22's accounts, proof_codes and sessions; K-27's calendar_links and busy_blocks).
//
// A value is written as K-04's seed fixtures write values, as turn-state.ts writes them: JSON booleans and numbers (a
// bigint or a numeric as a JSON number, refused past the largest safe integer), arrays as JSON arrays, a timestamptz in
// UTC ending in Z, a time as HH:MM (HH:MM:SS when its seconds are not zero), a tstzrange as [start,end), and PostgreSQL
// text input for the rest: a date as YYYY-MM-DD, a daterange as PostgreSQL writes it ([from,until)), an interval as its
// whole minutes, "N minutes" (as T-320's catalog writes an interval and K-05 v1.18 default 156 reads a span).
//
// Side, scope and reads (K-05 v1.2 item 26, default 25; arch 10 line 546; K-04 v1 rule 4): as turn-state.ts. One
// read-only transaction at repeatable read on the primary, run by rosie_job: with a business under that business's
// scope, confirmed by requireBusinessScope() before the first read; with businessId null on the runtime side. Nothing
// here logs, and an error names a field, a table or a column, never a value.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. K-22 v1.1's page_links.code_sha256 is never a fact: it is a link code's hash, as secretColumn's three are
//      (fact-homes.ts NEVER_SETUP_COLUMNS), though K-05 v1.2's secretColumn predates the table.
//   2. A sealed column (a table list's sealedBy) is never a fact, as turn-state.ts leaves out pauses.address.
//   3. A map point (geography) is never a fact: the travel check compares points in SQL, and K-04's seeds give a point
//      as EWKT, which no read here writes.
//   4. K-22 v1.2's sign_in_attempts and v1.3's staging_testers are never facts: the Tool API never reads them (their
//      READMEs' rules 9 and 10).
//   5. An interval is answered as its whole minutes, "N minutes"; one that holds months, or seconds past a whole minute,
//      throws, never rounded (K-05 v1.18 default 156's rule for a span).
//   6. A numeric (K-23 locations.travel_miles) is answered as a JSON number; a bigint past the largest safe integer
//      throws, as turn-state.ts's does.
import { transientOrScrubbed } from "../clocks";
import {
  assertBusinessId,
  BusinessScopeError,
  requireBusinessScope,
  SCOPE_SETTING,
  type Sql,
  type Tx,
} from "../scope";
import {
  assertId,
  assertRequestShape,
  inRuntimeTransaction,
  type NotFoundError,
  type ReadOptions,
  type TransientError,
  utc,
} from "../targets";
import {
  FACT_HOMES,
  type FactRef,
  type FactValue,
  readTurnStateIn as readCoreTurnStateIn,
  type ReadTurnStateRequest,
  type ReadTurnStateResponse,
  type UnknownFactError,
} from "../turn-state";
import { type SetupColumnType, setupHomeOf } from "./fact-homes";
import { rowNameSql } from "./row-names";

type Db = Sql | Tx;

export type SetupTurnStateOutcome = ReadTurnStateResponse | NotFoundError | UnknownFactError | TransientError;

// ---- the request's shape (turn-state.ts's checks, word for word) ----------------------------------------------------

const REQUEST_FIELDS = ["handleId", "businessId", "bookingIds", "facts"] as const;
const FACT_FIELDS: ReadonlySet<string> = new Set(["key", "table", "rowId", "column"]);
/** K-05's tableName and columnName (data-access.v1.schema.json tableName; v1.2 columnName). */
const NAME = /^[a-z_][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses a request that is not readTurnState.request's shape, naming the field, never a value. */
function checkRequest(request: unknown): asserts request is ReadTurnStateRequest {
  assertRequestShape(request, "readTurnState", REQUEST_FIELDS);
  const fields = request as Record<string, unknown>;
  for (const field of REQUEST_FIELDS) {
    if (!Object.hasOwn(fields, field)) {
      throw new TypeError(`readTurnState: the request needs ${field}`);
    }
  }
  assertId(fields.handleId, "handleId");
  if (fields.businessId !== null) {
    assertId(fields.businessId, "businessId");
    assertBusinessId(fields.businessId);
  }
  const { bookingIds, facts } = fields;
  if (!Array.isArray(bookingIds)) {
    throw new TypeError("readTurnState: bookingIds is a list");
  }
  const seen = new Set<string>();
  for (const bookingId of bookingIds as unknown[]) {
    assertId(bookingId, "each of bookingIds");
    if (seen.has(bookingId)) {
      throw new TypeError("readTurnState: bookingIds names each booking once");
    }
    seen.add(bookingId);
  }
  if (!Array.isArray(facts)) {
    throw new TypeError("readTurnState: facts is a list");
  }
  for (const fact of facts as unknown[]) {
    if (
      !isRecord(fact) ||
      Object.keys(fact).length !== FACT_FIELDS.size ||
      !Object.keys(fact).every((field) => FACT_FIELDS.has(field))
    ) {
      throw new TypeError("readTurnState: each fact is exactly {key, table, rowId, column}");
    }
    if (typeof fact.key !== "string" || fact.key === "") {
      throw new TypeError("readTurnState: a fact's key is a non-empty string");
    }
    if (typeof fact.table !== "string" || !NAME.test(fact.table)) {
      throw new TypeError("readTurnState: a fact's table is a plain lower-case name");
    }
    assertId(fact.rowId, "a fact's rowId");
    if (typeof fact.column !== "string" || !NAME.test(fact.column)) {
      throw new TypeError("readTurnState: a fact's column is a plain lower-case name");
    }
  }
}

// ---- where each fact lives ------------------------------------------------------------------------------------------

type Home = "core" | "setup";

/** The fact's home: K-04 core's (turn-state.ts FACT_HOMES), a setup part's (SETUP_FACT_HOMES), or none. */
function homeOf(fact: FactRef): Home | null {
  const core = Object.hasOwn(FACT_HOMES, fact.table) ? FACT_HOMES[fact.table] : undefined;
  if (core !== undefined && Object.hasOwn(core.columns, fact.column)) {
    return "core";
  }
  return setupHomeOf(fact.table, fact.column) === null ? null : "setup";
}

/** The first fact, in the request's order, whose home is neither; null when every one has a home. */
function unknownFactOf(facts: readonly FactRef[]): UnknownFactError | null {
  for (const fact of facts) {
    if (homeOf(fact) === null) {
      return { error: "unknownFact", key: fact.key, table: fact.table, column: fact.column };
    }
  }
  return null;
}

const notFound = (table: string, rowId: string): NotFoundError => ({ error: "notFound", table, rowId });

// ---- one setup fact -----------------------------------------------------------------------------------------------

interface RangeRow {
  is_null: boolean;
  is_empty: boolean | null;
  lower: Date | null;
  upper: Date | null;
  lower_inc: boolean | null;
  upper_inc: boolean | null;
  version: number;
}

interface SpanRow {
  is_null: boolean;
  months: number | null;
  seconds: string | null;
  version: number;
}

/** A tstzrange as K-04's seeds write it: [start,end) in UTC, or PostgreSQL's own text for an empty or open range. */
function rangeText(row: RangeRow): string | null {
  if (row.is_null) {
    return null;
  }
  if (row.is_empty === true) {
    return "empty";
  }
  const lower = row.lower === null ? "" : utc(row.lower);
  const upper = row.upper === null ? "" : utc(row.upper);
  return `${row.lower_inc === true ? "[" : "("}${lower},${upper}${row.upper_inc === true ? "]" : ")"}`;
}

/** An interval as its whole minutes (default 5): "N minutes"; months, or a part of a minute, throw. */
function spanText(row: SpanRow, what: string): string | null {
  if (row.is_null) {
    return null;
  }
  const seconds = Number(row.seconds);
  if (row.months !== 0 || !Number.isSafeInteger(seconds) || seconds % 60 !== 0) {
    throw new Error(`readTurnState: ${what} is not a whole number of minutes`);
  }
  return `${String(seconds / 60)} minutes`;
}

/** A number column's value as a JSON number (default 6), or a throw past the largest safe integer. */
function numberOf(raw: unknown, what: string, whole: boolean): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || (whole && !Number.isSafeInteger(value))) {
    throw new Error(`readTurnState: ${what} is past what a JSON number holds`);
  }
  return value;
}

/** A value as K-04's seed fixtures write it (see the top of this file). */
function valueOf(type: SetupColumnType, raw: unknown, what: string): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch (type) {
    case "timestamptz":
      return utc(raw as Date);
    case "time":
      // PostgreSQL's time text is HH:MM:SS; whole minutes read as HH:MM, as K-04's seeds write them.
      return typeof raw === "string" ? raw.replace(/^([0-9]{2}:[0-9]{2}):00$/, "$1") : raw;
    case "bigint":
      return numberOf(raw, what, true);
    case "numeric":
      return numberOf(raw, what, false);
    default:
      return raw;
  }
}

/**
 * One setup fact from its home row, or null when the row does not exist or the business does not hold it: a row of a
 * business-scoped table must carry the request's business (with none, no business). Every name in the query comes from
 * SETUP_FACT_HOMES, which the caller has checked the fact against.
 */
async function readSetupFact(db: Db, fact: FactRef, businessId: string | null): Promise<FactValue | null> {
  const found = setupHomeOf(fact.table, fact.column);
  const type = found?.columns[fact.column];
  if (found === null || type === undefined) {
    throw new Error("readTurnState: a setup fact was read before its home was checked");
  }
  const column = db(fact.column);
  const table = db(fact.table);
  const name = rowNameSql(db, found.key);
  const ofBusiness =
    found.scopedBy === null
      ? db``
      : businessId === null
        ? db`and ${db(found.scopedBy)} is null`
        : db`and ${db(found.scopedBy)} = ${businessId}`;
  const ref: FactRef = { key: fact.key, table: fact.table, rowId: fact.rowId, column: fact.column };
  const what = `${fact.table}.${fact.column}`;
  switch (type) {
    case "tstzrange": {
      const [row] = await db<RangeRow[]>`
        select ${column} is null as is_null, isempty(${column}) as is_empty, lower(${column}) as lower,
               upper(${column}) as upper, lower_inc(${column}) as lower_inc, upper_inc(${column}) as upper_inc, version
        from ${table}
        where ${name} = ${fact.rowId} ${ofBusiness}
      `;
      return row === undefined ? null : { ...ref, value: rangeText(row), version: row.version };
    }
    case "interval": {
      const [row] = await db<SpanRow[]>`
        select ${column} is null as is_null,
               (extract(year from ${column}) * 12 + extract(month from ${column}))::integer as months,
               extract(epoch from ${column})::text as seconds, version
        from ${table}
        where ${name} = ${fact.rowId} ${ofBusiness}
      `;
      return row === undefined ? null : { ...ref, value: spanText(row, what), version: row.version };
    }
    case "date":
    case "daterange":
    case "numeric": {
      // PostgreSQL's own text for each, never a Date or a client's parse of it (a date has no zone).
      const [row] = await db<{ value: string | null; version: number }[]>`
        select ${column}::text as value, version
        from ${table}
        where ${name} = ${fact.rowId} ${ofBusiness}
      `;
      return row === undefined
        ? null
        : { ...ref, value: valueOf(type, row.value, what), version: row.version };
    }
    case "text[]":
    case "smallint[]": {
      // As JSON, so the array reads the same whatever the client knows of PostgreSQL's array types.
      const [row] = await db<{ value: unknown; version: number }[]>`
        select to_json(${column}) as value, version
        from ${table}
        where ${name} = ${fact.rowId} ${ofBusiness}
      `;
      return row === undefined ? null : { ...ref, value: row.value ?? null, version: row.version };
    }
    default: {
      const [row] = await db<{ value: unknown; version: number }[]>`
        select ${column} as value, version
        from ${table}
        where ${name} = ${fact.rowId} ${ofBusiness}
      `;
      return row === undefined
        ? null
        : { ...ref, value: valueOf(type, row.value, what), version: row.version };
    }
  }
}

// ---- the read -----------------------------------------------------------------------------------------------------

/**
 * Where, in the request's facts, the core read's notFound falls: -1 when it names the handle, the business or a booking
 * (each read before any fact), else the index of the first core fact on that row.
 */
function missingCoreFactAt(
  request: ReadTurnStateRequest,
  homes: readonly Home[],
  missing: NotFoundError,
): number {
  if (
    missing.table === "handles" ||
    (missing.table === "businesses" && missing.rowId === request.businessId) ||
    (missing.table === "bookings" && request.bookingIds.includes(missing.rowId))
  ) {
    return -1;
  }
  const at = request.facts.findIndex(
    (fact, index) => homes[index] === "core" && fact.table === missing.table && fact.rowId === missing.rowId,
  );
  if (at === -1) {
    throw new Error("readTurnState: the core read named a missing row the request does not name");
  }
  return at;
}

/**
 * Read turn state inside the transaction `db`, which must already run on the request's side: under the request's
 * business scope (turn-state.ts's readTurnStateIn checks it with requireBusinessScope before its first read), or with
 * businessId null on the runtime side, with no scope. It should be a read-only transaction at repeatable read, so the
 * answer is one moment's. Prefer readTurnState(); this is for a caller that already holds such a transaction.
 */
export async function readTurnStateIn(
  db: Db,
  request: ReadTurnStateRequest,
  options: ReadOptions = {},
): Promise<ReadTurnStateResponse | NotFoundError | UnknownFactError> {
  checkRequest(request);
  const unknown = unknownFactOf(request.facts);
  if (unknown !== null) {
    return unknown;
  }
  const homes = request.facts.map((fact) => homeOf(fact) ?? "setup");
  const core = await readCoreTurnStateIn(
    db,
    { ...request, facts: request.facts.filter((_fact, index) => homes[index] === "core") },
    options,
  );
  if ("error" in core) {
    if (core.error === "unknownFact") {
      throw new Error("readTurnState: a core fact was refused after its home was checked");
    }
    // A setup fact before the core one that is missing comes first.
    const at = missingCoreFactAt(request, homes, core);
    for (const [index, fact] of request.facts.slice(0, Math.max(at, 0)).entries()) {
      if (homes[index] === "setup" && (await readSetupFact(db, fact, request.businessId)) === null) {
        return notFound(fact.table, fact.rowId);
      }
    }
    return core;
  }
  const facts: FactValue[] = [];
  let nextCore = 0;
  for (const [index, fact] of request.facts.entries()) {
    if (homes[index] === "core") {
      const read = core.facts[nextCore];
      nextCore += 1;
      if (read === undefined) {
        throw new Error("readTurnState: the core read answered fewer facts than it was asked");
      }
      facts.push(read);
      continue;
    }
    const read = await readSetupFact(db, fact, request.businessId);
    if (read === null) {
      return notFound(fact.table, fact.rowId);
    }
    facts.push(read);
  }
  return { ...core, facts };
}

/**
 * A turn's stored state (K-05 v1.2 item 26) with the setup parts' facts, for the frontier and the journey 1 and 2 calls:
 * one read-only transaction at repeatable read on the primary, uncached, under the request's business scope, or on the
 * runtime side when businessId is null. Pass the client's primary handle, run as rosie_job. unknownFact (nothing read)
 * when a fact's home is neither a core nor a setup home; notFound for the first of the handle, the business, a booking or
 * a fact's row that is missing or another business's; transient on a serialization failure, a deadlock or a lost
 * connection. A request of the wrong shape throws a TypeError.
 */
export async function readTurnState(
  sql: Sql,
  request: ReadTurnStateRequest,
  options: ReadOptions = {},
): Promise<SetupTurnStateOutcome> {
  checkRequest(request);
  const unknown = unknownFactOf(request.facts);
  if (unknown !== null) {
    return unknown;
  }
  const { businessId } = request;
  try {
    // The runtime side's transaction clears any scope a connection kept; with a business the scope is set first.
    return await inRuntimeTransaction(sql, { readOnly: true }, async (tx) => {
      if (businessId === null) {
        return readTurnStateIn(tx, request, options);
      }
      await tx`select set_config(${SCOPE_SETTING}, ${businessId}, true)`;
      const outcome = await readTurnStateIn(tx, request, options);
      if ((await requireBusinessScope(tx)) !== businessId) {
        throw new BusinessScopeError("readTurnState must end under the business scope it began with");
      }
      return outcome;
    });
  } catch (error) {
    // A statement's own refusal and postgres.js's statement errors leave scrubbed too: the call's name and the code
    // alone, never the statement's values (clocks.ts transientOrScrubbed).
    return transientOrScrubbed("readTurnState", error);
  }
}
