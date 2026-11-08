// The database the commit path's integration tests run on (T-306). Never imported by the Worker.
//
// One fresh schema per test file, migrated with every migration of db/migrations/ (db/repo/test-db.ts) and dropped when
// the file ends, so the public schema is never touched. Beside the owner's client (the migrations' role, which loads the
// seeds and reads what a commit left), two clients run as the application roles, as in the Worker (T-191; 0012):
//   - the runtime side's, as rosie_job: K-05's commitTurn runs on it, in its own transaction (K-05 README "Scope");
//   - the Tool API's, as rosie_app: each gateAndCommit call's business-scoped transaction (actions/src/tool-api).
// Rows come only from the contracts' fixtures: K-04's seeds and K-05's reserve exchange (the master's sample cast, the
// 555-01xx range; rule 9). Nothing here logs: no statement's parameters, row's words, number or name leaves the database.

import postgres from "postgres";

import { resolvePrimaryUrl } from "../../../../db/repo/client";
import { reserve, type ReserveRequest } from "../../../../db/repo/reservations";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../../../db/repo/test-db";
import { contractFile } from "../../tool-api/test-support";

type Db = Sql | Tx;
type Values = Record<string, unknown>;

/** The runtime side's role, which K-05's commitTurn runs as (K-05 README "Scope"; 0012: only rosie_job may run it). */
export const RUNTIME_ROLE = "rosie_job";
/** The Tool API's role, which every call's business-scoped transaction runs as (0012). */
export const TOOL_API_ROLE = "rosie_app";

const CORE_SEEDS = "db-schema/core/fixtures/";

interface SeedFile {
  readonly after: readonly string[];
  readonly rows: readonly { readonly table: string; readonly values: Values }[];
}

export interface CommitDatabase {
  /** The owner's client and the schema: it loads the seeds and reads what a commit left. */
  readonly db: TestDatabase;
  /** As rosie_job, this file's schema first: the runtime side the commit runs on. */
  readonly runtime: Sql;
  /** As rosie_app, this file's schema first: the Tool API's business scope. */
  readonly toolApi: Sql;
  /** The application name the runtime client's connections carry (for pg_stat_activity). */
  readonly runtimeApplication: string;
  /**
   * One more client on this schema as `role`. `onStatement` gets each statement's text as it is sent (SQL with its
   * placeholders), never its parameters. The caller ends it.
   */
  client(role: string, applicationName: string, max: number, onStatement?: (text: string) => void): Sql;
  /** Ends every client and drops the schema. */
  close(): Promise<void>;
}

/** Makes this file's schema and its clients. `name` names the schema (t_<name>_<8 hex>) and the runtime application. */
export async function openCommitDatabase(name: string, max: number): Promise<CommitDatabase> {
  const db = await createTestDatabase({ name });
  const url = resolvePrimaryUrl();
  const client = (
    role: string,
    applicationName: string,
    poolSize: number,
    onStatement?: (text: string) => void,
  ): Sql =>
    postgres(url, {
      max: poolSize,
      onnotice: () => undefined,
      ...(onStatement === undefined
        ? {}
        : {
            debug: (_connection: number, text: string) => {
              onStatement(text);
            },
          }),
      connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
    });
  const runtimeApplication = `rosie-${name.replace(/_/g, "-")}-runtime`;
  const runtime = client(RUNTIME_ROLE, runtimeApplication, max);
  const toolApi = client(TOOL_API_ROLE, `rosie-${name.replace(/_/g, "-")}-tool-api`, max);
  return {
    db,
    runtime,
    toolApi,
    runtimeApplication,
    client,
    close: async () => {
      await Promise.all([runtime.end({ timeout: 5 }), toolApi.end({ timeout: 5 })]);
      await db.drop();
    },
  };
}

// ---- K-04's seeds ---------------------------------------------------------------------------------------------------

/** K-04's seed rows of `files`, each file's `after` first, every file once, in order. */
export function seedRows(files: readonly string[]): SeedFile["rows"] {
  const seen = new Set<string>();
  const rowsOf = (file: string): SeedFile["rows"] => {
    if (seen.has(file)) return [];
    seen.add(file);
    const seedFile = contractFile(`${CORE_SEEDS}${file}`) as SeedFile;
    return [...seedFile.after.flatMap(rowsOf), ...seedFile.rows];
  };
  return files.flatMap(rowsOf);
}

/** The jsonb and bytea columns of this schema's tables, by `table.column`. */
async function typedColumns(cdb: CommitDatabase): Promise<Map<string, string>> {
  const rows = await cdb.db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${cdb.db.schema} and data_type in ('jsonb', 'bytea')
  `;
  return new Map(rows.map((row) => [row.key, row.type]));
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Inserts one row as given: a jsonb column as JSON, a bytea column from its hex text, the rest as PostgreSQL text input. */
export async function insertRow(
  sql: Db,
  typed: ReadonlyMap<string, string>,
  table: string,
  row: Values,
): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typed.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value as never);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** Empties this schema's tables (truncating the heads cascades to the rest; identities restart), then loads the seeds. */
export async function seed(cdb: CommitDatabase, files: readonly string[]): Promise<void> {
  const { sql } = cdb.db;
  await sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const typed = await typedColumns(cdb);
  const rows = seedRows(files);
  await sql.begin(async (tx) => {
    for (const row of rows) await insertRow(tx, typed, row.table, row.values);
  });
}

/**
 * K-05 reserve-10-min.json run for real (T-187's reserve(), as the owner), then the saved-time clock row K-05 item 8 gives
 * the held row, which reserve() does not write yet (db/repo/reservations.ts): armed at the request's time, due at the
 * held row's end in its business's zone, owned by the mobile's handle, firing its release.
 */
export async function holdTime(cdb: CommitDatabase): Promise<void> {
  const { sql } = cdb.db;
  const exchange = contractFile("data-access/fixtures/reserve-10-min.json") as { request: ReserveRequest };
  const outcome = await reserve(sql, exchange.request);
  if (!("result" in outcome) || outcome.result !== "held") {
    throw new Error("reserve-10-min.json's time was not held");
  }
  const [row] = await sql<{ business_id: string; handle_id: string | null; zone: string }[]>`
    select r.business_id, p.handle_id, b.time_zone as zone
    from reservations r
    join businesses b on b.id = r.business_id
    left join phones p on p.number = r.for_phone_number
    where r.id = ${outcome.reservationId}
  `;
  if (row === undefined) throw new Error("the held time has no row");
  await insertRow(sql, await typedColumns(cdb), "clock_rows", {
    id: outcome.savedTimeClockId,
    kind: "saved_time",
    reservation_id: outcome.reservationId,
    handle_id: row.handle_id,
    business_id: row.business_id,
    booking_id: null,
    due_at: outcome.heldUntil,
    due_zone: row.zone,
    state: "armed",
    armed_at: exchange.request.at,
    fires: { release: outcome.reservationId, why: "expired" },
  });
}

/** Inserts one event-log row as a job's entry (no turn), as the owner. */
export async function insertJobEntry(cdb: CommitDatabase, id: string, kind: string): Promise<void> {
  await insertRow(cdb.db.sql, await typedColumns(cdb), "event_log", {
    id,
    job_id: "job-t306-taken",
    trace_id: "trace-t306-taken",
    actor_kind: "job",
    kind,
  });
}

// ---- what a commit leaves behind --------------------------------------------------------------------------------------

const VERSIONED = [
  "businesses",
  "persons",
  "phones",
  "person_roles",
  "bookings",
  "resources",
  "reservations",
  "class_seats",
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "effects",
];
const WRITTEN_ONCE = ["handles", "person_handles", "event_log"];

/** Every core table's row count, and a versioned one's sum of versions: equal before and after means nothing was written. */
export async function snapshot(cdb: CommitDatabase): Promise<Record<string, string>> {
  const { sql } = cdb.db;
  const out: Record<string, string> = {};
  for (const table of VERSIONED) {
    const [row] = await sql<{ n: number; v: number }[]>`
      select count(*)::int as n, coalesce(sum(version), 0)::int as v from ${sql(table)}
    `;
    out[table] = `${String(row?.n)} rows, versions ${String(row?.v)}`;
  }
  for (const table of WRITTEN_ONCE) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    out[table] = `${String(row?.n)} rows`;
  }
  return out;
}

/** The rows that carry one turn's id. */
export interface Footprint {
  readonly turns: number;
  readonly outbox: number;
  readonly events: number;
  readonly effects: number;
  readonly questions: number;
  readonly clocks: number;
}

export const NO_FOOTPRINT: Footprint = {
  turns: 0,
  outbox: 0,
  events: 0,
  effects: 0,
  questions: 0,
  clocks: 0,
};

export async function footprint(cdb: CommitDatabase, turnId: string): Promise<Footprint> {
  const [row] = await cdb.db.sql<Footprint[]>`
    select (select count(*)::int from turns where id = ${turnId}) as turns,
           (select count(*)::int from outbox_rows where turn_id = ${turnId}) as outbox,
           (select count(*)::int from event_log where turn_id = ${turnId}) as events,
           (select count(*)::int from effects where turn_id = ${turnId}) as effects,
           (select count(*)::int from open_questions where turn_id = ${turnId}) as questions,
           (select count(*)::int from clock_rows where created_by_turn_id = ${turnId}) as clocks
  `;
  if (row === undefined) throw new Error("footprint: no row");
  return row;
}

/** One row's version and the columns asked for, as the owner reads it; undefined when there is no such row. */
export async function rowOf(
  cdb: CommitDatabase,
  table: string,
  id: string,
  columns: readonly string[],
): Promise<Values | undefined> {
  const { sql } = cdb.db;
  const [row] = await sql<
    Values[]
  >`select ${sql(["version", ...columns])} from ${sql(table)} where id = ${id}`;
  return row;
}

/**
 * Waits until `count` backends of `applicationName` wait on a lock (pg_stat_activity), at most about 30 seconds (a resource
 * guard for a loaded machine, not part of any test's claim).
 */
export async function lockWaiters(
  cdb: CommitDatabase,
  applicationName: string,
  count: number,
): Promise<void> {
  for (let tries = 0; tries < 1500; tries += 1) {
    const [row] = await cdb.db.sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where application_name = ${applicationName} and wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${String(count)} commits ever waited on the lock`);
}

/** The table each insert or update statement writes, in the order sent (statements' text only, never their values). */
export function writesIn(statements: readonly string[]): string[] {
  return statements.flatMap((text) => {
    const table = /^\s*(?:insert into|update)\s+"?([a-z_]+)"?/.exec(text)?.[1];
    return table === undefined ? [] : [table];
  });
}
