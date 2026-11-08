// T-580: the safety and incidents part (K-34 v1: safety_outcomes, safety_holds, harm_reports, safety_timers and
// privacy_incidents) against local PostgreSQL (`npm run db:up`; `npm run test:integration -- safety-incidents`). The
// schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: the commit's per-write scope, the gate) or the runtime side
// (rosie_job: the actor, the guard, the dispatcher, the clock sweep, and Rosie's team's side until K-21 names its role)
// runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back.
// Seed fixtures are loaded the same way, as the runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from K-34 v1's and K-04 v1's fixtures (Lee's Barbershop, the movers and the master's sample cast:
// rule 9): a row made here is a fixture row under new ids, or with one fault. Rosie's team has no member in the sample
// cast (Q-18), so a follow-up is made by a stand-in persons row with no name and no role, as T-193's test does. The
// fixtures' sealed values are stand-in bytes; the sealing checks seal those stand-ins with db/repo/sealing.ts (T-182)
// under a wrapping key made here from random bytes for each run and kept in memory only, as sealing.int.test.ts does.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "../repo/scope";
import {
  DEFAULT_WRAPPING_KEY_NAME,
  SEAL_OVERHEAD_BYTES,
  SealingError,
  type SealingErrorCode,
  type WrappingKeys,
  erasePerson,
  seal,
  unsealText,
} from "../repo/sealing";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";

const PART_DIR = new URL("../../contracts/db-schema/safety-incidents/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const CORE_FIXTURES_DIR = new URL("../../contracts/db-schema/core/fixtures/", import.meta.url);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const OWN_TABLES = ["harm_reports", "privacy_incidents", "safety_holds", "safety_outcomes", "safety_timers"];
/** The four tables scoped by business, on business_id; harm_reports is Rosie's team's (scope none). */
const SCOPED_TABLES = ["privacy_incidents", "safety_holds", "safety_outcomes", "safety_timers"];
/** The four tables that are updated, each with a version (rule 2); safety_outcomes is only appended. */
const VERSIONED_TABLES = ["harm_reports", "privacy_incidents", "safety_holds", "safety_timers"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
/** A stand-in for a person on Rosie's team: a persons row with no name and no role (Q-18; K-34 README defaults). */
const TEAM_MEMBER = "person-team-stand-in";
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string; sealedBy?: string }[];
  primaryKey: string[];
  foreignKeys: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
  unique?: { name: string; columns: string[] }[];
  checks: { name: string; expression: string }[];
  indexes: { name: string; columns: string[]; where?: string }[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
  versionColumn?: string;
}

interface FixtureRow {
  table: string;
  values: Values;
}

interface Refused {
  role: string;
  scope: { businessId: string } | null;
  action: string;
  table: string;
  values?: Values;
  set?: Values;
  where?: Values;
  expect: { sqlstate?: string; constraintOneOf?: string[] };
}

interface FixtureFile {
  after: string[];
  rows: FixtureRow[];
  refused?: Refused;
}

interface IndexEntry {
  file: string;
  version: string;
  table: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const TABLES = (readJson(new URL("safety-incidents.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
/** Every accepted K-04 v1 seed, named as K-34's seeds name them: from K-34's fixtures/ folder. */
const CORE_SEEDS = (readJson(new URL("index.json", CORE_FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures
  .filter((entry) => entry.expect === "accept")
  .map((entry) => `../../core/fixtures/${entry.file}`);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`${name} is not in K-34's table list`);
  }
  return table;
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** A fixture's own rows of one table, in order. */
const rowsOf = (file: string, table: string): FixtureRow[] =>
  fixtureFile(file).rows.filter((row) => row.table === table);

/** The values of a fixture's `index`th own row of `table`. */
function valuesOf(file: string, table: string, index = 0): Values {
  const row = rowsOf(file, table)[index];
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row number ${String(index)}`);
  }
  return row.values;
}

function refusedOf(file: string): { fixture: FixtureFile; refused: Refused } {
  const fixture = fixtureFile(file);
  if (fixture.refused === undefined) {
    throw new Error(`${file} has no refused action`);
  }
  return { fixture, refused: fixture.refused };
}

/** The fixtures/ folder a fixture file sits in: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(file: URL): URL {
  const folder = new URL(".", file);
  return folder.href.endsWith("/invalid/") ? new URL("..", folder) : folder;
}

/**
 * A fixture's rows, after those of every fixture its `after` names (each path relative to the fixtures/ folder of the
 * file that names it, so K-34's seeds name K-04's as ../../core/fixtures/<file>), each file once.
 */
function fixtureRows(file: URL, seen: Set<string>): FixtureRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const fixture = readJson(file) as FixtureFile;
  const folder = fixturesFolderOf(file);
  return [...fixture.after.flatMap((before) => fixtureRows(new URL(before, folder), seen)), ...fixture.rows];
}

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** `values` without the named columns. */
const without = (values: Values, columns: readonly string[]): Values =>
  Object.fromEntries(Object.entries(values).filter(([column]) => !columns.includes(column)));

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Alex's crisis words after booking, and the after-safe hold they set (seed-outcome-crisis.json). */
const CRISIS = valuesOf("seed-outcome-crisis.json", "safety_outcomes");
const CRISIS_HOLD = valuesOf("seed-outcome-crisis.json", "safety_holds");
/** Alex's emergency, the later "we're safe, it's handled" read as No, over, and the released hold (seed-hold-released). */
const EMERGENCY = valuesOf("seed-hold-released.json", "safety_outcomes", 0);
const SAFE_READ = valuesOf("seed-hold-released.json", "safety_outcomes", 1);
const RELEASED_HOLD = valuesOf("seed-hold-released.json", "safety_holds");
/** Alex's threat to Riley: the hold that is never released (seed-threat-pause.json). */
const THREAT_HOLD = valuesOf("seed-threat-pause.json", "safety_holds");
/** Alex's report of harm to an older adult, and Alex's report that names Riley (seed-harm-report.json). */
const ELDER_REPORT = valuesOf("seed-harm-report.json", "harm_reports", 0);
const STAFF_REPORT = valuesOf("seed-harm-report.json", "harm_reports", 1);
/** Sam's check-out timer on the movers' in-home survey, and its core clock row (seed-safety-timer.json). */
const TIMER = valuesOf("seed-safety-timer.json", "safety_timers");
const TIMER_CLOCK = valuesOf("seed-safety-timer.json", "clock_rows");
/** Dee W.'s card photo, and the text about Ben T.'s booking that went to an old number (seed-privacy-slip.json). */
const CARD_SLIP = valuesOf("seed-privacy-slip.json", "privacy_incidents", 0);
const WRONG_PERSON_SLIP = valuesOf("seed-privacy-slip.json", "privacy_incidents", 1);
/** The columns of a hold's release. */
const RELEASE_COLUMNS = ["released_at", "released_why", "released_by_turn_id", "released_by_outcome_id"];
/** The release of Alex's emergency hold, by the turn of the clear "we're safe" and that text's own read. */
const SAFE_RELEASE: Values = Object.fromEntries(
  RELEASE_COLUMNS.map((column) => [column, RELEASED_HOLD[column] ?? null]),
);

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;
/** The type of each jsonb and bytea column of the schema, keyed table.column. */
const typeOf = new Map<string, string>();

/** Runs `fn` in one transaction as `role`, scoped to `businessId` (null: no scope), then rolls it back. */
async function as<T>(role: Role, businessId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx): Promise<never> => {
    await tx.unsafe(`set local role ${role}`);
    throw new RolledBack(await fn(tx));
  };
  try {
    if (businessId === null) {
      await db.sql.begin(run);
    } else {
      await withBusiness(db.sql, businessId, run);
    }
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/** Runs `fn` in one transaction as the tables' owner (the migrations' role), then rolls it back. */
async function asOwner<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/** Runs `fn` in one transaction as `role` with no scope, and commits it. */
async function committedAs<T>(role: Role, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  });
  return result as T;
}

interface Refusal {
  code: string | undefined;
  constraint: string | undefined;
  column: string | undefined;
  message: string;
}

/** The SQLSTATE, constraint, column and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code?: string;
      constraint_name?: string;
      column_name?: string;
      message?: string;
    };
    return {
      code: failure.code,
      constraint: failure.constraint_name,
      column: failure.column_name,
      message: failure.message ?? "",
    };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

/** A row's values as the database takes them: JSON for a jsonb column, bytes for a bytea one (`\x` and hex). */
function columnValues(sql: Sql | Tx, table: string, values: Values): Record<string, never> {
  const converted: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    const type = typeOf.get(`${table}.${column}`);
    let out: unknown = value;
    if (type === "jsonb" && value !== null) {
      out = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      out = fromHex(value.replace(/^\\x/, ""));
    }
    converted[column] = out as never;
  }
  return converted;
}

async function insertRow(sql: Sql | Tx, table: string, values: Values): Promise<void> {
  await sql`insert into ${sql(table)} ${sql(columnValues(sql, table, values))}`;
}

/** Inserts one row and gives it back as stored. */
async function insertReturning(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>> {
  const [row] = await tx<Record<string, unknown>[]>`
    insert into ${tx(table)} ${tx(columnValues(tx, table, values))} returning *
  `;
  if (row === undefined) {
    throw new Error(`${table}: the insert gave no row back`);
  }
  return row;
}

/** Empties every table the fixtures write: truncating the heads cascades to the rest (this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** Loads fixture files with their `after` chains, each file once, as the runtime side; returns the rows per table. */
async function loadFixtures(files: readonly string[]): Promise<Record<string, number>> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen));
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

/** A stored value next to the fixture's: a time as the instant it names, bytes as `\x` and hex. */
function comparable(stored: unknown, given: Json): [unknown, unknown] {
  if (stored instanceof Date && typeof given === "string") {
    return [stored.toISOString(), new Date(given).toISOString()];
  }
  if (stored instanceof Uint8Array && typeof given === "string") {
    return [`\\x${toHex(stored)}`, given];
  }
  return [stored, given];
}

/** Every column the fixture gives is stored as given, read back as the owner by the table's primary key. */
async function expectStored(row: FixtureRow): Promise<void> {
  const [key, ...more] = tableOf(row.table).primaryKey;
  if (key === undefined || more.length > 0) {
    throw new Error(`${row.table}: expected a one-column primary key`);
  }
  const id = textOf(row.values[key]);
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select * from ${db.sql(row.table)} where ${db.sql(key)} = ${id}
  `;
  expect(stored, `${row.table} ${id}`).toBeDefined();
  for (const [column, value] of Object.entries(row.values)) {
    const [actual, wanted] = comparable(stored?.[column], value);
    expect(actual, `${row.table} ${id} ${column}`).toEqual(wanted);
  }
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows of `table` the caller sees whose business_id is null. */
async function countWithNoBusiness(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(table)} where business_id is null
  `;
  return row?.n ?? -1;
}

/** Rows of `table` whose business_id is `businessId` (null: none), read as the owner. */
async function ownerCount(table: string, businessId: string | null): Promise<number> {
  const [row] =
    businessId === null
      ? await db.sql<
          { n: number }[]
        >`select count(*)::int as n from ${db.sql(table)} where business_id is null`
      : await db.sql<{ n: number }[]>`
          select count(*)::int as n from ${db.sql(table)} where business_id = ${businessId}
        `;
  return row?.n ?? -1;
}

/** A table's ids, in order. */
async function keysOf(table: string): Promise<string[]> {
  const rows = await db.sql<{ key: string }[]>`select id as key from ${db.sql(table)} order by 1`;
  return rows.map((row) => row.key);
}

/** A table's checks and indexes as PostgreSQL prints them, by name; an index without its own name and table. */
async function definitionsOf(
  sql: Sql | Tx,
  table: string,
): Promise<{ checks: Record<string, string>; indexes: Record<string, string> }> {
  const checks = await sql<{ name: string; definition: string }[]>`
    select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid = ${table}::regclass and contype = 'c'
  `;
  const indexes = await sql<{ name: string; definition: string }[]>`
    select c.relname as name, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = ${table}::regclass and not i.indisprimary
  `;
  return {
    checks: Object.fromEntries(checks.map((row) => [row.name, row.definition])),
    indexes: Object.fromEntries(
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "")]),
    ),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "safety_incidents" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-34 v1 safety and incidents)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    "text[]": "ARRAY",
    integer: "integer",
    boolean: "boolean",
    jsonb: "jsonb",
    bytea: "bytea",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names five tables: four scoped by business on business_id, harm_reports none; all but safety_outcomes versioned", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    expect(
      Object.fromEntries(
        TABLES.map((table) => [
          table.name,
          [
            table.rowLevelSecurity.scope,
            table.rowLevelSecurity.column ?? null,
            table.versioned,
            table.versionColumn ?? null,
          ],
        ]),
      ),
    ).toEqual({
      safety_outcomes: ["business", "business_id", false, null],
      safety_holds: ["business", "business_id", true, "version"],
      harm_reports: ["none", null, true, "version"],
      safety_timers: ["business", "business_id", true, "version"],
      privacy_incidents: ["business", "business_id", true, "version"],
    });
  });

  for (const table of TABLES) {
    it(`${table.name}: columns in order, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<
        { name: string; type: string; element: string; nullable: string; default: string | null }[]
      >`
        select column_name as name, data_type as type, udt_name as element, is_nullable as nullable,
               column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
        if (column.type === "text[]") {
          expect(actual?.element, `${table.name}.${column.name} element type`).toBe("_text");
        }
        expect(actual?.nullable === "YES", `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === undefined) {
          expect(actual?.default, `${table.name}.${column.name} default`).toBeNull();
        } else {
          expect((actual?.default ?? "").replace(/::.*$/, ""), `${table.name}.${column.name} default`).toBe(
            column.default,
          );
        }
      }
    });

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules and index names are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(constraints.filter((constraint) => constraint.kind === "p")).toEqual([
        {
          name: `${table.name}_pkey`,
          kind: "p",
          definition: `PRIMARY KEY (${table.primaryKey.join(", ")})`,
        },
      ]);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual(table.checks.map((check) => check.name).sort());
      expect(named("f")).toEqual(table.foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual((table.unique ?? []).map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of table.foreignKeys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        );
      }
      for (const rule of table.unique ?? []) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.join(", ")})`,
        );
      }
      const indexes = await db.sql<{ name: string }[]>`
        select indexname as name from pg_indexes where schemaname = ${db.schema} and tablename = ${table.name}
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...(table.unique ?? []).map((rule) => rule.name),
          ...table.indexes.map((index) => index.name),
        ].sort(),
      );
    });

    it(`${table.name}: each check and each index is the table list's own expression, as PostgreSQL reads both`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const listed = await asOwner(async (tx) => {
        await tx`create temporary table probe (like ${tx(table.name)}) on commit drop`;
        for (const check of table.checks) {
          await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
        }
        for (const index of table.indexes) {
          const where = index.where === undefined ? "" : ` where ${index.where}`;
          await tx.unsafe(`create index ${index.name} on probe (${index.columns.join(", ")})${where}`);
        }
        return definitionsOf(tx, "probe");
      });
      expect(Object.keys(listed.checks).sort()).toEqual(table.checks.map((check) => check.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(table.indexes.map((index) => index.name).sort());
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      // A unique rule's own index is checked above by name and columns; the named indexes here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("the three sealed columns hold bytes, each sealed under the key of the person its row names (rule 6)", async () => {
    const sealed = TABLES.flatMap((table) =>
      table.columns.flatMap((column) =>
        column.sealedBy === undefined
          ? []
          : [{ table: table.name, column: column.name, by: column.sealedBy }],
      ),
    );
    expect(sealed).toEqual([
      { table: "safety_outcomes", column: "sealed_words", by: "person_id" },
      { table: "harm_reports", column: "sealed_details", by: "sealed_for_person_id" },
      { table: "safety_timers", column: "address", by: "address_for_person_id" },
    ]);
    for (const { table, column, by } of sealed) {
      const [row] = await db.sql<{ type: string; keys: string[] }[]>`
        select
          (select data_type from information_schema.columns
           where table_schema = ${db.schema} and table_name = ${table} and column_name = ${column}) as type,
          array(select pg_get_constraintdef(oid) from pg_constraint
                where conrelid = ${table}::regclass and contype = 'f'
                  and conkey = array[(select attnum from pg_attribute
                                      where attrelid = ${table}::regclass and attname = ${by})]) as keys
      `;
      expect(row, `${table}.${column}`).toEqual({
        type: "bytea",
        keys: [`FOREIGN KEY (${by}) REFERENCES persons(id) ON DELETE RESTRICT`],
      });
    }
  });

  it("the four updated tables raise their version on every update (0002's rule): <table>_version_raised; safety_outcomes has no trigger", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual(
      VERSIONED_TABLES.map((table) => [table, `${table}_version_raised`]),
    );
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
  });

  it("row-level security is on for the four business-scoped tables with 0012's two policies on business_id, off for harm_reports; none forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual([
      { name: "harm_reports", on: false, forced: false },
      { name: "privacy_incidents", on: true, forced: false },
      { name: "safety_holds", on: true, forced: false },
      { name: "safety_outcomes", on: true, forced: false },
      { name: "safety_timers", on: true, forced: false },
    ]);
    const policies = await db.sql<
      {
        table: string;
        name: string;
        permissive: string;
        roles: string[];
        command: string;
        using: string;
        check: string;
      }[]
    >`
      select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
             qual as using, with_check as check
      from pg_policies where schemaname = ${db.schema} and tablename in ${db.sql([...OWN_TABLES, "outbox_rows"])}
      order by tablename, policyname
    `;
    expect([...new Set(policies.map((policy) => policy.table))]).toEqual(
      [...SCOPED_TABLES, "outbox_rows"].sort(),
    );
    // 0012's shape, read from outbox_rows' two policies, which key on the same column (business_id).
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    for (const table of SCOPED_TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      expect(own.map((policy) => [policy.using, policy.check])).toEqual(
        core.map((policy) => [policy.using, policy.check]),
      );
      expect(own[0]?.using).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
      // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
      expect(own[0]?.using).toContain("IS NULL");
      expect(own[1]?.using).not.toContain("IS NULL");
    }
  });

  it("grants: insert and select on safety_outcomes, update too on the three other scoped tables, to both roles; on harm_reports rosie_app inserts only", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    const rows = (role: Role, table: string, privileges: string[]) =>
      privileges.map((privilege) => ({ role, table, privilege }));
    expect(held).toEqual([
      ...rows(TOOL_API, "harm_reports", ["INSERT"]),
      ...rows(TOOL_API, "privacy_incidents", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(TOOL_API, "safety_holds", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(TOOL_API, "safety_outcomes", ["INSERT", "SELECT"]),
      ...rows(TOOL_API, "safety_timers", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "harm_reports", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "privacy_incidents", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "safety_holds", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "safety_outcomes", ["INSERT", "SELECT"]),
      ...rows(RUNTIME, "safety_timers", ["INSERT", "SELECT", "UPDATE"]),
    ]);
    // No other grantee: PUBLIC holds nothing on any of the five.
    const others = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee <> c.relowner and a.grantee not in (${TOOL_API}::regrole, ${RUNTIME}::regrole)
    `;
    expect(others).toEqual([]);
  });

  it("neither role owns a table: they stay the migrations' role's", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
      order by 1
    `;
    expect(owners.map((row) => row.name)).toEqual(OWN_TABLES);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });

  it("is recorded in schema_migrations as safety_incidents, after effects_provider_events", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("safety_incidents");
    expect(names.indexOf("safety_incidents")).toBeGreaterThan(names.indexOf("effects_provider_events"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the four of 02-contracts' K-34 row, and two more", () => {
  /** The K-34 rows all six seeds give, per table. */
  const SEEDED = {
    harm_reports: 2,
    privacy_incidents: 2,
    safety_holds: 4,
    safety_outcomes: 5,
    safety_timers: 1,
  };

  it("the index lists the six seeds and four refused rows, all K-34 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual([
      "seed-harm-report.json",
      "seed-hold-released.json",
      "seed-outcome-crisis.json",
      "seed-privacy-slip.json",
      "seed-safety-timer.json",
      "seed-threat-pause.json",
    ]);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-outcome-update.json",
      "invalid/refuse-owner-reads-harm-report.json",
      "invalid/refuse-timer-without-contact.json",
      "invalid/refuse-unknown-outcome-label.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} loads alone with its after chain, as the runtime side, and every K-34 row is stored as given`,
      SLOW,
      async () => {
        await reset();
        const chain = fixtureRows(new URL(file, FIXTURES_DIR), new Set());
        const loaded = await loadFixtures([file]);
        for (const table of OWN_TABLES) {
          const given = chain.filter((row) => row.table === table);
          expect(loaded[table] ?? 0, `${file}: ${table}`).toBe(given.length);
          expect(await countRows(db.sql, table), `${file}: ${table} stored`).toBe(given.length);
          for (const row of given) {
            await expectStored(row);
          }
        }
        expect(fixtureFile(file).rows.some((row) => OWN_TABLES.includes(row.table))).toBe(true);
      },
    );
  }

  it("all six load together, each after chain once: every K-34 table has rows", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await keysOf("safety_outcomes")).toEqual([
      "safety-alex-0202",
      "safety-alex-0203",
      "safety-alex-0204",
      "safety-alex-0205",
      "safety-alex-0220",
    ]);
    expect(await keysOf("safety_holds")).toEqual([
      "hold-alex-0202",
      "hold-alex-0203",
      "hold-alex-0204",
      "hold-alex-0205",
    ]);
    expect(await keysOf("harm_reports")).toEqual(["harm-alex-0205", "harm-alex-about-staff"]);
    expect(await keysOf("safety_timers")).toEqual(["timer-sam-survey"]);
    expect(await keysOf("privacy_incidents")).toEqual(["privacy-ben-old-number", "privacy-dee-card-photo"]);
  });

  it("they load together with every K-04 v1 seed as well, each file once", SLOW, async () => {
    await reset();
    expect(CORE_SEEDS.length).toBeGreaterThan(0);
    const loaded = await loadFixtures([...CORE_SEEDS, ...SEEDS]);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    for (const table of OWN_TABLES) {
      expect(await countRows(db.sql, table), table).toBe(loaded[table]);
    }
  });
});

describe("the seeded rows, all six seeds loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("Alex's crisis words after booking: the labels, tense and danger-word list and kind plain, the words only sealed; its after-safe hold open", async () => {
    const [outcome] = await db.sql<
      {
        labels: string[];
        tenses: string[];
        lists: string[];
        kinds: string[];
        outcomes: string[];
        timed_out: boolean;
        person: string;
        sealed: Uint8Array | null;
      }[]
    >`
      select labels, tenses, danger_word_lists as lists, danger_word_kinds as kinds, outcomes, timed_out,
             person_id as person, sealed_words as sealed
      from safety_outcomes where id = 'safety-alex-0203'
    `;
    expect(outcome).toMatchObject({
      labels: ["Crisis words"],
      tenses: ["now"],
      lists: ["general"],
      kinds: ["selfHarm"],
      outcomes: ["Crisis words"],
      timed_out: false,
      person: "person-alex",
    });
    expect(outcome?.sealed).toBeInstanceOf(Uint8Array);
    const [hold] = await db.sql<{ rule: string; released: Date | null; booking: string }[]>`
      select release_rule as rule, released_at as released, booking_id as booking
      from safety_holds where safety_outcome_id = 'safety-alex-0203'
    `;
    expect(hold).toEqual({ rule: "after_safe", released: null, booking: "booking-alex-haircut" });
  });

  it("a released hold keeps its release: when, why and by whom (the turn of the clear we're safe, and that text's own read, which holds no danger)", async () => {
    const [hold] = await db.sql<
      Record<string, unknown>[]
    >`select * from safety_holds where id = 'hold-alex-0202'`;
    for (const column of [...RELEASE_COLUMNS, "release_rule", "held_at", "version"]) {
      const [actual, wanted] = comparable(hold?.[column], RELEASED_HOLD[column] ?? null);
      expect(actual, column).toEqual(wanted);
    }
    expect(hold).toMatchObject({
      release_rule: "after_safe",
      released_why: "safe_readback",
      released_by_turn_id: "turn-alex-0220",
      released_by_outcome_id: "safety-alex-0220",
    });
    // The release's own read: No, over, no danger word (S13-10: a threat that could start again still gets the message).
    const [read] = await db.sql<
      { labels: string[]; tenses: string[]; outcomes: string[]; kinds: string[] }[]
    >`
      select labels, tenses, outcomes, danger_word_kinds as kinds from safety_outcomes where id = 'safety-alex-0220'
    `;
    expect(read).toEqual({ labels: ["No"], tenses: ["over"], outcomes: ["No"], kinds: [] });
    expect([SAFE_READ.id, EMERGENCY.id]).toEqual(["safety-alex-0220", "safety-alex-0202"]);
    // The gate's read of Alex's open holds no longer lists it: the crisis words' and the threat's are open.
    const open = await db.sql<{ id: string }[]>`
      select id from safety_holds where handle_id = 'handle-alex' and released_at is null order by id
    `;
    expect(open.map((row) => row.id)).toEqual(["hold-alex-0203", "hold-alex-0204"]);
  });

  it("the release stays whole: a later update keeps it, and one that drops half of it is refused (23514)", async () => {
    const later = await as(
      RUNTIME,
      null,
      (tx) => tx<Record<string, unknown>[]>`
        update safety_holds set version = version + 1 where id = 'hold-alex-0202'
        returning released_at, released_why, released_by_turn_id, released_by_outcome_id, version
      `,
    );
    expect(later).toHaveLength(1);
    for (const column of RELEASE_COLUMNS) {
      const [actual, wanted] = comparable(later[0]?.[column], SAFE_RELEASE[column] ?? null);
      expect(actual, column).toEqual(wanted);
    }
    expect(later[0]?.version).toBe(3);
    for (const [column, constraint] of [
      ["released_why", "safety_holds_released_pair"],
      ["released_at", "safety_holds_released_pair"],
      ["released_by_turn_id", "safety_holds_safe_release_has_read"],
      ["released_by_outcome_id", "safety_holds_safe_release_has_read"],
    ] as const) {
      const outcome = await refusal(
        as(
          RUNTIME,
          null,
          (tx) => tx`
            update safety_holds set ${tx(column)} = null, version = version + 1 where id = 'hold-alex-0202'
          `,
        ),
      );
      expect([outcome.code, outcome.constraint], column).toEqual(["23514", constraint]);
    }
  });

  it("the threat hold is never released (safety_holds_threat_never_released); the threat's turn set the core pauses on Alex and Alex's phone", async () => {
    const [hold] = await db.sql<{ rule: string; released: Date | null }[]>`
      select release_rule as rule, released_at as released from safety_holds where id = 'hold-alex-0204'
    `;
    expect(hold).toEqual({ rule: "never", released: null });
    expect(THREAT_HOLD.release_rule).toBe("never");
    const pauses = await db.sql<{ target: string; person: string | null; phone: string | null }[]>`
      select target, person_id as person, phone_number as phone from pauses
      where set_by_turn_id = 'turn-alex-0204' and business_id = ${BARBERSHOP} order by id
    `;
    expect(pauses).toEqual([
      { target: "person", person: "person-alex", phone: null },
      { target: "phone", person: null, phone: "+15555550101" },
    ]);
    // Every release, of any kind. No release fits a never hold, so safety_holds_why_fits_rule refuses it too, and a
    // release time needs its why (safety_holds_released_pair): the threat's own rule is never the only one broken.
    // PostgreSQL checks a table's CHECKs in name order, so it is the one named.
    const release = (why: string) => (tx: Tx) => tx`
      update safety_holds set released_at = '2026-10-26T22:10:03Z', released_why = ${why},
        released_by_turn_id = 'turn-alex-0220', released_by_outcome_id = 'safety-alex-0220', version = version + 1
      where id = ${textOf(THREAT_HOLD.id)}
    `;
    for (const why of ["outcome_message_sent", "booking_private", "safe_readback"]) {
      for (const role of ROLES) {
        const outcome = await refusal(as(role, BARBERSHOP, release(why)));
        expect([outcome.code, outcome.constraint], `${role} ${why}`).toEqual([
          "23514",
          "safety_holds_threat_never_released",
        ]);
      }
    }
    // The same safe release of the crisis words' after-safe hold passes: the rule, not the release, refuses it.
    const crisis = await as(
      RUNTIME,
      null,
      (tx) => tx<{ why: string; version: number }[]>`
        update safety_holds set released_at = '2026-10-26T22:10:03Z', released_why = 'safe_readback',
          released_by_turn_id = 'turn-alex-0220', released_by_outcome_id = 'safety-alex-0220', version = version + 1
        where id = ${textOf(CRISIS_HOLD.id)}
        returning released_why as why, version
      `,
    );
    expect(crisis).toEqual([{ why: "safe_readback", version: 2 }]);
  });

  it("Sam's running timer holds the actor's copy in one row: due 11:20am New York time, the sealed address, Morgan Lee and her mobile; its clock row fires the miss", async () => {
    const [timer] = await db.sql<
      {
        state: string;
        due: string;
        started: string;
        sealed: Uint8Array;
        sealedFor: string;
        contact: string;
        mobile: string;
        clock: string;
        clockDue: Date;
        due_at: Date;
      }[]
    >`
      select t.state, to_char(t.due_at at time zone t.due_zone, 'FMHH12:MIam') as due,
             to_char(t.started_at at time zone t.due_zone, 'FMHH12:MIam') as started, t.address as sealed,
             t.address_for_person_id as "sealedFor", p.name as contact, h.address as mobile, c.kind as clock,
             c.due_at as "clockDue", t.due_at
      from safety_timers t
        join persons p on p.id = t.emergency_contact_person_id
        join handles h on h.id = t.emergency_contact_handle_id
        join clock_rows c on c.id = t.clock_row_id
      where t.id = ${textOf(TIMER.id)}
    `;
    expect(timer).toMatchObject({
      state: "running",
      due: "11:20am",
      started: "9:20am",
      sealedFor: "person-alex",
      contact: "Morgan Lee",
      mobile: "+15555550108",
      clock: "step",
    });
    expect(timer?.sealed).toBeInstanceOf(Uint8Array);
    expect(timer?.clockDue.toISOString()).toBe(timer?.due_at.toISOString());
  });

  it("harm reports: the elder-care hotline given first; the report from Alex that names Riley; both open for Rosie's team, the words only sealed", async () => {
    const reports = await db.sql<
      {
        id: string;
        kind: string;
        hotline: string | null;
        named: string | null;
        open: boolean;
        sealed: boolean;
      }[]
    >`
      select id, kind, hotline, named_person_id as named, followed_up_at is null as open,
             sealed_details is not null and sealed_for_person_id = 'person-alex' as sealed
      from harm_reports order by id
    `;
    expect(reports).toEqual([
      {
        id: "harm-alex-0205",
        kind: "harm_to_child_or_elder",
        hotline: "elder_care",
        named: null,
        open: true,
        sealed: true,
      },
      {
        id: "harm-alex-about-staff",
        kind: "about_owner_or_staff",
        hotline: null,
        named: "person-riley",
        open: true,
        sealed: true,
      },
    ]);
    expect([ELDER_REPORT.id, STAFF_REPORT.id]).toEqual(["harm-alex-0205", "harm-alex-about-staff"]);
  });

  it("privacy slips: Dee W.'s card photo kept only as its kind; Ben T.'s text to an old number names the fields it showed, never their values", async () => {
    const slips = await db.sql<
      { id: string; kind: string; detail: string | null; fields: string[]; sentTo: string | null }[]
    >`
      select id, kind, detail_kind as detail, fields_shown as fields, sent_to_handle_id as "sentTo"
      from privacy_incidents order by id
    `;
    expect(slips).toEqual([
      {
        id: "privacy-ben-old-number",
        kind: "wrong_person",
        detail: null,
        fields: ["name", "visit_time"],
        sentTo: "handle-ben-old-number",
      },
      {
        id: "privacy-dee-card-photo",
        kind: "detail_never_kept",
        detail: "card_number",
        fields: [],
        sentTo: null,
      },
    ]);
    expect([CARD_SLIP.id, WRONG_PERSON_SLIP.id]).toEqual([
      "privacy-dee-card-photo",
      "privacy-ben-old-number",
    ]);
  });
});

describe("refuse-outcome-update.json: a safety outcome is never edited (rule 5)", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-outcome-update.json");
  const where = Object.entries(refused.where ?? {});
  const condition = (tx: Tx) =>
    where
      .map(([column, value]) => tx`${tx(column)} = ${textOf(value)}`)
      .reduce((all, one) => tx`${all} and ${one}`);
  const update = (tx: Tx) =>
    tx`update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, refused.set ?? {}))} where ${condition(tx)}`;

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the runtime side, with no scope, changes Alex's Crisis words to No; refused by privilege (42501)", async () => {
    expect([refused.role, refused.scope, refused.action, refused.table]).toEqual([
      "runtime",
      null,
      "update",
      "safety_outcomes",
    ]);
    expect(where.map(([column]) => column)).toEqual(["id"]);
    const outcome = await refusal(as(RUNTIME, null, update));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table safety_outcomes");
  });

  it(
    "no role may update, delete or truncate an outcome, scoped or not (42501), and the row stays as it was read",
    SLOW,
    async () => {
      const edits: ((tx: Tx) => Promise<unknown>)[] = [
        update,
        (tx) => tx`delete from safety_outcomes where ${condition(tx)}`,
        (tx) => tx`truncate safety_outcomes`,
      ];
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const run of edits) {
            const outcome = await refusal(as(role, scope, run));
            expect(outcome.code, `${role} ${String(scope)}`).toBe("42501");
            expect(outcome.message, `${role} ${String(scope)}`).toContain(
              "permission denied for table safety_outcomes",
            );
          }
        }
      }
      await expectStored({ table: "safety_outcomes", values: CRISIS });
    },
  );

  it("without its one fault, a new text gets a new row: the Tool API, scoped to Lee's Barbershop, and the runtime side each write one", async () => {
    /** A later text of Alex's, read as No (over, no danger word): a new event, a new row. */
    const next: Values = {
      ...CRISIS,
      ...refused.set,
      id: "safety-alex-0206",
      event_id: "evt-alex-0206",
      read_at: "2026-10-25T23:40:01Z",
      labels: ["No"],
      tenses: ["over"],
      danger_word_lists: [],
      danger_word_kinds: [],
      sealed_words: null,
    };
    for (const role of ROLES) {
      const stored = await as(role, BARBERSHOP, (tx) => insertReturning(tx, "safety_outcomes", next));
      expect(stored, role).toMatchObject({ id: next.id, outcomes: ["No"], lifted_to_unsure: false });
    }
  });
});

describe("refuse-timer-without-contact.json: no check-out timer without an emergency contact who said yes", () => {
  const file = "invalid/refuse-timer-without-contact.json";
  const { refused } = refusedOf(file);
  const values = refused.values ?? {};
  const insert = (row: Values) => (tx: Tx) => insertReturning(tx, refused.table, row);
  /** Morgan Lee, her mobile and her yes, as Sam's seeded timer names them. */
  const contact: Values = {
    emergency_contact_person_id: TIMER.emergency_contact_person_id ?? null,
    emergency_contact_handle_id: TIMER.emergency_contact_handle_id ?? null,
    contact_yes_at: TIMER.contact_yes_at ?? null,
  };

  beforeAll(async () => {
    await reset();
    // The fixture's after chain and its own row: the clock row the second timer would use.
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the Tool API scoped to the movers starts Sam's second timer with no contact, no handle and no yes; refused (23502)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      MOVERS,
      "insert",
      "safety_timers",
    ]);
    const outcome = await refusal(as(TOOL_API, MOVERS, insert(values)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(Object.keys(contact)).toContain(outcome.column);
  });

  it("each of the three missing alone is refused (23502, naming it)", async () => {
    for (const column of Object.keys(contact)) {
      const outcome = await refusal(as(TOOL_API, MOVERS, insert({ ...values, ...contact, [column]: null })));
      expect([outcome.code, outcome.column], column).toEqual(["23502", column]);
    }
  });

  it("without its one fault (Morgan Lee, her mobile and her yes) the same timer passes, running", async () => {
    const stored = await as(TOOL_API, MOVERS, insert({ ...values, ...contact }));
    expect(stored).toMatchObject({
      id: values.id,
      emergency_contact_person_id: "person-morgan-lee",
      emergency_contact_handle_id: "handle-morgan-lee",
      state: "running",
      missed_at: null,
      version: 1,
    });
  });
});

describe("refuse-owner-reads-harm-report.json: no business reads a harm report, its owner included", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-owner-reads-harm-report.json");
  const where = Object.entries(refused.where ?? {});
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = where.map(([column, value]) => sql`${sql(column)} = ${textOf(value)}`);
    const condition = conditions.reduce((all, one) => sql`${all} and ${one}`);
    return sql`select * from ${sql(refused.table)} where ${condition}`;
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop reads the report that names Riley; refused by privilege (42501)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "select",
      "harm_reports",
    ]);
    expect(await read(db.sql)).toHaveLength(1);
    const outcome = await refusal(as(TOOL_API, refused.scope?.businessId ?? null, read));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table harm_reports");
  });

  it("without its one fault (Rosie's team's side) the same read returns the report, unscoped or with that scope set", async () => {
    expect(await as(RUNTIME, null, read)).toHaveLength(1);
    expect(await as(RUNTIME, BARBERSHOP, read)).toHaveLength(1);
  });
});

describe("refuse-unknown-outcome-label.json: an outcome's labels are K-02's values only", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-unknown-outcome-label.json");
  const values = refused.values ?? {};
  const insert = (row: Values) => (tx: Tx) => insertReturning(tx, refused.table, row);

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop writes Alex's text labelled Self-harm; refused by safety_outcomes_labels_known (23514)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "insert",
      "safety_outcomes",
    ]);
    expect(values.labels).toEqual(["Self-harm"]);
    const outcome = await refusal(as(TOOL_API, BARBERSHOP, insert(values)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (labelled Crisis words) the same row passes", async () => {
    expect(await as(TOOL_API, BARBERSHOP, insert({ ...values, labels: ["Crisis words"] }))).toMatchObject({
      id: values.id,
      labels: ["Crisis words"],
    });
  });
});

describe("harm_reports: Rosie's team's rows (rule 4)", () => {
  /** Alex's report naming Riley, written again under a new id. */
  const report: Values = { ...STAFF_REPORT, id: "harm-alex-about-staff-2" };

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("the Tool API adds a report (the commit's write), scoped to its business or not: the row lands, as its owner reads it", async () => {
    for (const scope of [BARBERSHOP, null]) {
      const landed = await as(TOOL_API, scope, async (tx) => {
        await insertRow(tx, "harm_reports", report);
        await tx.unsafe("reset role");
        const [row] = await tx<{ n: number }[]>`
          select count(*)::int as n from harm_reports where id = ${textOf(report.id)}
        `;
        return row?.n;
      });
      expect(landed, String(scope)).toBe(1);
    }
  });

  it(
    "the Tool API reads, changes and removes none, scoped or not: select, update, delete, truncate and an insert that returns the row are refused (42501)",
    SLOW,
    async () => {
      for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
        for (const statement of [
          "select count(*) from harm_reports",
          "select id from harm_reports where id = 'harm-alex-0205'",
          "update harm_reports set version = version + 1 where id = 'harm-alex-0205'",
          "delete from harm_reports where id = 'harm-alex-0205'",
          "truncate harm_reports",
        ]) {
          const outcome = await refusal(as(TOOL_API, scope, (tx) => tx.unsafe(statement)));
          expect(outcome.code, `${String(scope)}: ${statement}`).toBe("42501");
          expect(outcome.message, `${String(scope)}: ${statement}`).toContain(
            "permission denied for table harm_reports",
          );
        }
        const returning = await refusal(
          as(TOOL_API, scope, (tx) => insertReturning(tx, "harm_reports", report)),
        );
        expect(returning.code, String(scope)).toBe("42501");
      }
    },
  );

  it("Rosie's team's side reads every report (no policy hides one), adds one and follows one up, raising its version; it never deletes or truncates (42501)", async () => {
    for (const scope of [null, BARBERSHOP, YOGA_STUDIO]) {
      expect(await as(RUNTIME, scope, (tx) => countRows(tx, "harm_reports")), String(scope)).toBe(2);
    }
    const work = await as(RUNTIME, null, async (tx) => {
      await insertRow(tx, "persons", { id: TEAM_MEMBER });
      await insertRow(tx, "harm_reports", report);
      const followed = await tx<{ followed: boolean; version: number }[]>`
        update harm_reports set followed_up_at = '2026-10-28T20:00:00Z', followed_up_by_person_id = ${TEAM_MEMBER},
          version = version + 1
        where id = 'harm-alex-0205'
        returning followed_up_at is not null as followed, version
      `;
      return { reports: await countRows(tx, "harm_reports"), followed };
    });
    expect(work).toEqual({ reports: 3, followed: [{ followed: true, version: 2 }] });
    for (const statement of [
      "delete from harm_reports where id = 'harm-alex-0205'",
      "truncate harm_reports",
    ]) {
      const outcome = await refusal(as(RUNTIME, null, (tx) => tx.unsafe(statement)));
      expect(outcome.code, statement).toBe("42501");
      expect(outcome.message, statement).toContain("permission denied for table harm_reports");
    }
    expect(await countRows(db.sql, "harm_reports")).toBe(2);
  });
});

describe("row-level security on the four business-scoped tables (rule 4)", () => {
  /** Alex's crisis words from a secure page before there is a business, and its hold: no business on either. */
  const pageOutcome: Values = {
    ...CRISIS,
    id: "safety-alex-page-0001",
    event_id: "evt-alex-page-0001",
    source: "page",
    handle_id: null,
    business_id: null,
    booking_id: null,
    turn_id: null,
  };
  const pageHold: Values = {
    ...CRISIS_HOLD,
    id: "hold-alex-page-0001",
    safety_outcome_id: "safety-alex-page-0001",
    business_id: null,
    booking_id: null,
    turn_id: null,
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
    await committedAs(RUNTIME, async (tx) => {
      await insertRow(tx, "safety_outcomes", pageOutcome);
      await insertRow(tx, "safety_holds", pageHold);
    });
  }, 60_000);

  it("the rows: Lee's Barbershop's outcomes, holds and incidents, the movers' timer, and an outcome and hold with no business", async () => {
    expect(await ownerCount("safety_outcomes", BARBERSHOP)).toBe(5);
    expect(await ownerCount("safety_outcomes", null)).toBe(1);
    expect(await ownerCount("safety_holds", BARBERSHOP)).toBe(4);
    expect(await ownerCount("safety_holds", null)).toBe(1);
    expect(await ownerCount("safety_timers", MOVERS)).toBe(1);
    expect(await ownerCount("privacy_incidents", BARBERSHOP)).toBe(2);
    expect(await ownerCount("safety_outcomes", YOGA_STUDIO)).toBe(0);
  });

  it("the Tool API with no scope reads no row of any of the four", async () => {
    for (const table of SCOPED_TABLES) {
      expect(await countRows(db.sql, table), table).toBeGreaterThan(0);
      expect(await as(TOOL_API, null, (tx) => countRows(tx, table)), table).toBe(0);
    }
  });

  it(
    "the Tool API scoped to a business reads exactly that business's rows, never one with no business",
    SLOW,
    async () => {
      for (const table of SCOPED_TABLES) {
        for (const business of [BARBERSHOP, YOGA_STUDIO, MOVERS]) {
          expect(await as(TOOL_API, business, (tx) => countRows(tx, table)), `${table} ${business}`).toBe(
            await ownerCount(table, business),
          );
          expect(
            await as(TOOL_API, business, (tx) => countWithNoBusiness(tx, table)),
            `${table} ${business}`,
          ).toBe(0);
        }
      }
      // Lee's Barbershop's crisis outcome, read from the yoga studio's scope: no row; from its own: the row.
      const read = (tx: Tx) => tx`select id from safety_outcomes where id = ${textOf(CRISIS.id)}`;
      expect(await as(TOOL_API, YOGA_STUDIO, read)).toHaveLength(0);
      expect(await as(TOOL_API, BARBERSHOP, read)).toHaveLength(1);
    },
  );

  it(
    "the runtime side with no scope reads every row, those with no business included; with a scope set, only that business's",
    SLOW,
    async () => {
      for (const table of SCOPED_TABLES) {
        expect(await as(RUNTIME, null, (tx) => countRows(tx, table)), table).toBe(
          await countRows(db.sql, table),
        );
        expect(await as(RUNTIME, null, (tx) => countWithNoBusiness(tx, table)), table).toBe(
          await ownerCount(table, null),
        );
        for (const business of [BARBERSHOP, MOVERS]) {
          expect(await as(RUNTIME, business, (tx) => countRows(tx, table)), `${table} ${business}`).toBe(
            await ownerCount(table, business),
          );
          expect(
            await as(RUNTIME, business, (tx) => countWithNoBusiness(tx, table)),
            `${table} ${business}`,
          ).toBe(0);
        }
      }
    },
  );

  it("writes under a scope: only the scope's own business; another business, no scope, or a row with no business is refused (42501)", async () => {
    const outcome: Values = { ...CRISIS, id: "safety-alex-0207", event_id: "evt-alex-0207" };
    expect(
      await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "safety_outcomes", outcome)),
    ).toMatchObject({
      id: outcome.id,
    });
    for (const scope of [YOGA_STUDIO, null]) {
      const refused = await refusal(
        as(TOOL_API, scope, (tx) => insertReturning(tx, "safety_outcomes", outcome)),
      );
      expect(refused.code, String(scope)).toBe("42501");
    }
    expect(
      (await refusal(as(RUNTIME, YOGA_STUDIO, (tx) => insertRow(tx, "safety_outcomes", outcome)))).code,
    ).toBe("42501");
    const noBusiness: Values = {
      ...pageOutcome,
      id: "safety-alex-page-0002",
      event_id: "evt-alex-page-0002",
    };
    for (const role of ROLES) {
      expect(
        (await refusal(as(role, BARBERSHOP, (tx) => insertRow(tx, "safety_outcomes", noBusiness)))).code,
      ).toBe("42501");
    }
    expect(await as(RUNTIME, null, (tx) => insertReturning(tx, "safety_outcomes", noBusiness))).toMatchObject(
      {
        business_id: null,
      },
    );
  });

  it("an update from another business's scope finds no row; from its own it raises the version", async () => {
    const cases: [string, string, string][] = [
      ["safety_holds", textOf(CRISIS_HOLD.id), BARBERSHOP],
      ["safety_timers", textOf(TIMER.id), MOVERS],
      ["privacy_incidents", textOf(CARD_SLIP.id), BARBERSHOP],
    ];
    for (const [table, id, business] of cases) {
      const bump = (tx: Tx) =>
        tx`update ${tx(table)} set version = version + 1 where id = ${id} returning id`;
      for (const role of ROLES) {
        expect(await as(role, YOGA_STUDIO, bump), `${role} ${table}`).toHaveLength(0);
        expect(await as(role, business, bump), `${role} ${table}`).toHaveLength(1);
      }
    }
  });

  it("no role deletes or truncates a row of any K-34 table, scoped or not (42501)", SLOW, async () => {
    for (const table of OWN_TABLES) {
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const statement of [`delete from ${table}`, `truncate ${table}`]) {
            const outcome = await refusal(as(role, scope, (tx) => tx.unsafe(statement)));
            expect(outcome.code, `${role} ${String(scope)}: ${statement}`).toBe("42501");
            expect(outcome.message, `${role} ${String(scope)}: ${statement}`).toContain(
              `permission denied for table ${table}`,
            );
          }
        }
      }
    }
  });
});

describe("each rule of the table list refuses a row that breaks it, for that one reason", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  /** Inserts `values` into `table` as the runtime side with no scope, after `before`, then rolls back. */
  const tried = (
    table: string,
    values: Values,
    before: FixtureRow[] = [],
  ): Promise<Record<string, unknown>> =>
    as(RUNTIME, null, async (tx) => {
      for (const row of before) {
        await insertRow(tx, row.table, row.values);
      }
      return insertReturning(tx, table, values);
    });

  /** The SQLSTATE and the constraint that refuse `values` in `table`. */
  const refusedBy = async (
    table: string,
    values: Values,
    before: FixtureRow[] = [],
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(tried(table, values, before));
    return [outcome.code, outcome.constraint];
  };

  /** A new text of Alex's, read as the seed's crisis words, under its own ids. */
  const outcome: Values = { ...CRISIS, id: "safety-rule-base", event_id: "evt-rule-base" };
  const LABELS = [
    "No",
    "Safety steps, then go on",
    "An emergency",
    "Crisis words",
    "A threat to staff or others",
    "Harm to a child or older adult",
    "Unsafe at home",
    "Needs the business's own line",
    "Unsure",
  ];
  /** No verdict in 4 s: both model tries timed out. */
  const timeout: Values = {
    timed_out: true,
    tries: [
      { model: "haiku", result: "timeout" },
      { model: "sonnet", result: "timeout" },
    ],
    labels: [],
    tenses: [],
  };

  it(
    "safety_outcomes: every source, label, tense and danger word K-02 names is taken; several labels; a lift; a timeout with and without a danger word",
    SLOW,
    async () => {
      expect(await tried("safety_outcomes", outcome)).toMatchObject({
        source: "text",
        lifted_to_unsure: false,
      });
      for (const source of ["page", "agent"]) {
        expect(
          await tried("safety_outcomes", { ...outcome, source, handle_id: null, turn_id: null }),
          source,
        ).toMatchObject({ source });
      }
      for (const label of LABELS) {
        expect(
          await tried("safety_outcomes", { ...outcome, labels: [label], outcomes: [label] }),
          label,
        ).toMatchObject({ labels: [label] });
      }
      for (const tense of ["now", "could restart", "over", "joke", "unknown"]) {
        expect(await tried("safety_outcomes", { ...outcome, tenses: [tense] }), tense).toMatchObject({
          tenses: [tense],
        });
      }
      expect(
        await tried("safety_outcomes", {
          ...outcome,
          labels: ["An emergency", "Crisis words"],
          tenses: ["now", "could restart"],
          danger_word_lists: ["general", "plugin"],
          danger_word_kinds: ["selfHarm", "other"],
          outcomes: ["An emergency", "Crisis words"],
        }),
      ).toMatchObject({ outcomes: ["An emergency", "Crisis words"] });
      // A danger word lifts No to Unsure (arch 06 line 283).
      expect(
        await tried("safety_outcomes", {
          ...outcome,
          labels: ["No"],
          tenses: ["now"],
          outcomes: ["Unsure"],
          lifted_to_unsure: true,
        }),
      ).toMatchObject({ outcomes: ["Unsure"], lifted_to_unsure: true });
      // On a timeout a self-harm word counts as Unsure; with no danger word the list is empty (the outage line goes).
      expect(
        await tried("safety_outcomes", {
          ...outcome,
          ...timeout,
          outcomes: ["Unsure"],
          lifted_to_unsure: true,
        }),
      ).toMatchObject({ timed_out: true, outcomes: ["Unsure"] });
      expect(
        await tried("safety_outcomes", {
          ...outcome,
          ...timeout,
          danger_word_lists: [],
          danger_word_kinds: [],
          outcomes: [],
        }),
      ).toMatchObject({ timed_out: true, outcomes: [] });
      // Left out, the lists are empty and nothing was lifted.
      const left = without(outcome, [
        "labels",
        "tenses",
        "danger_word_lists",
        "danger_word_kinds",
        "outcomes",
      ]);
      expect(
        await tried("safety_outcomes", { ...without(left, ["lifted_to_unsure"]), ...timeout, outcomes: [] }),
      ).toMatchObject({ danger_word_lists: [], danger_word_kinds: [], lifted_to_unsure: false });
    },
  );

  it(
    "safety_outcomes: the source, a text's handle and turn, the labels, tenses and danger words as K-02's lists",
    SLOW,
    async () => {
      expect(await refusedBy("safety_outcomes", { ...outcome, source: "voice" })).toEqual([
        "23514",
        "safety_outcomes_source_known",
      ]);
      for (const fault of [{ handle_id: null }, { turn_id: null }]) {
        expect(await refusedBy("safety_outcomes", { ...outcome, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "safety_outcomes_text_has_handle_and_turn",
        ]);
      }
      expect(await refusedBy("safety_outcomes", { ...outcome, labels: ["Self-harm"] })).toEqual([
        "23514",
        "safety_outcomes_labels_known",
      ]);
      expect(await refusedBy("safety_outcomes", { ...outcome, tenses: ["later"] })).toEqual([
        "23514",
        "safety_outcomes_tenses_known",
      ]);
      expect(await refusedBy("safety_outcomes", { ...outcome, tenses: ["now", "over"] })).toEqual([
        "23514",
        "safety_outcomes_one_tense_per_label",
      ]);
      for (const fault of [
        { danger_word_kinds: [] },
        { danger_word_lists: ["dictionary"] },
        { danger_word_kinds: ["violence"] },
      ]) {
        expect(await refusedBy("safety_outcomes", { ...outcome, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "safety_outcomes_danger_words_known",
        ]);
      }
      expect(await refusedBy("safety_outcomes", { ...outcome, outcomes: ["Self-harm"] })).toEqual([
        "23514",
        "safety_outcomes_outcomes_known",
      ]);
    },
  );

  it(
    "safety_outcomes: a verdict has labels and an outcome, a timeout neither labels nor anything but its rule; a lift gives Unsure; sealed words need a person; one or two tries",
    SLOW,
    async () => {
      // A timeout with the crisis words' label, everything else a timeout's.
      expect(
        await refusedBy("safety_outcomes", {
          ...outcome,
          ...timeout,
          labels: ["Crisis words"],
          tenses: ["now"],
          outcomes: ["Unsure"],
          lifted_to_unsure: true,
        }),
      ).toEqual(["23514", "safety_outcomes_timeout_has_no_labels"]);
      expect(await refusedBy("safety_outcomes", { ...outcome, labels: [], tenses: [] })).toEqual([
        "23514",
        "safety_outcomes_timeout_has_no_labels",
      ]);
      expect(await refusedBy("safety_outcomes", { ...outcome, outcomes: [] })).toEqual([
        "23514",
        "safety_outcomes_verdict_has_outcome",
      ]);
      for (const fault of [
        { outcomes: [] },
        { outcomes: ["Crisis words"] },
        { danger_word_lists: [], danger_word_kinds: [], outcomes: ["Unsure"], lifted_to_unsure: false },
      ]) {
        expect(
          await refusedBy("safety_outcomes", { ...outcome, ...timeout, lifted_to_unsure: false, ...fault }),
          JSON.stringify(fault),
        ).toEqual(["23514", "safety_outcomes_timeout_rule"]);
      }
      expect(await refusedBy("safety_outcomes", { ...outcome, lifted_to_unsure: true })).toEqual([
        "23514",
        "safety_outcomes_lift_gives_unsure",
      ]);
      expect(await refusedBy("safety_outcomes", { ...outcome, person_id: null })).toEqual([
        "23514",
        "safety_outcomes_sealed_has_person",
      ]);
      expect(
        await tried("safety_outcomes", { ...outcome, person_id: null, sealed_words: null }),
      ).toMatchObject({
        person_id: null,
      });
      const notOneOrTwo: Json[] = [
        [],
        { model: "haiku", result: "verdict" },
        [
          { model: "haiku", result: "error" },
          { model: "sonnet", result: "error" },
          { model: "haiku", result: "verdict" },
        ],
      ];
      for (const tries of notOneOrTwo) {
        expect(await refusedBy("safety_outcomes", { ...outcome, tries }), JSON.stringify(tries)).toEqual([
          "23514",
          "safety_outcomes_tries_list",
        ]);
      }
    },
  );

  it(
    "safety_outcomes: each foreign key refuses an id its table does not hold (23503); the id and the event are unique (23505)",
    SLOW,
    async () => {
      for (const [fault, constraint] of [
        [{ handle_id: "handle-none" }, "safety_outcomes_handle_fk"],
        [{ person_id: "person-none" }, "safety_outcomes_person_fk"],
        [{ business_id: "biz-none" }, "safety_outcomes_business_fk"],
        [{ booking_id: "booking-none" }, "safety_outcomes_booking_fk"],
        [{ turn_id: "turn-none" }, "safety_outcomes_turn_fk"],
      ] as const) {
        expect(await refusedBy("safety_outcomes", { ...outcome, ...fault }), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      // The same text read twice, and a second row under the seed's id.
      expect(await refusedBy("safety_outcomes", { ...outcome, event_id: CRISIS.event_id ?? null })).toEqual([
        "23505",
        "safety_outcomes_event_key",
      ]);
      expect(await refusedBy("safety_outcomes", { ...outcome, id: CRISIS.id ?? null })).toEqual([
        "23505",
        "safety_outcomes_pkey",
      ]);
    },
  );

  /** The emergency read again under new ids, and a hold on it as the seed's, not yet released. */
  const heldOutcome: FixtureRow = {
    table: "safety_outcomes",
    values: { ...EMERGENCY, id: "safety-rule-held", event_id: "evt-rule-held" },
  };
  const hold: Values = {
    ...without(RELEASED_HOLD, RELEASE_COLUMNS),
    id: "hold-rule-base",
    safety_outcome_id: "safety-rule-held",
    version: 1,
  };
  const releasedAt = textOf(RELEASED_HOLD.released_at);

  it(
    "safety_holds: each rule and its own release are taken; a hold that blocks booking; one that waits for a private booking",
    SLOW,
    async () => {
      expect(await tried("safety_holds", hold, [heldOutcome])).toMatchObject({
        release_rule: "after_safe",
        released_at: null,
        blocks_booking: false,
        version: 1,
      });
      expect(await tried("safety_holds", { ...hold, ...SAFE_RELEASE }, [heldOutcome])).toMatchObject({
        released_why: "safe_readback",
      });
      for (const [rule, release] of [
        ["at_once", { released_at: releasedAt, released_why: "outcome_message_sent" }],
        [
          "when_private",
          { booking_id: "booking-alex-haircut", released_at: releasedAt, released_why: "booking_private" },
        ],
        ["never", {}],
      ] as const) {
        expect(
          await tried("safety_holds", { ...hold, booking_id: "booking-alex-haircut", release_rule: rule }, [
            heldOutcome,
          ]),
          rule,
        ).toMatchObject({ release_rule: rule, released_at: null });
        expect(
          await tried("safety_holds", { ...hold, release_rule: rule, ...release }, [heldOutcome]),
          rule,
        ).toMatchObject({ release_rule: rule });
      }
      expect(
        await tried("safety_holds", { ...hold, release_rule: "at_once", blocks_booking: true }, [
          heldOutcome,
        ]),
      ).toMatchObject({ blocks_booking: true });
    },
  );

  it(
    "safety_holds: the rule, the release as a pair that fits the rule, a safe release with its read, a private booking, the order of times",
    SLOW,
    async () => {
      const before = [heldOutcome];
      expect(await refusedBy("safety_holds", { ...hold, release_rule: "later" }, before)).toEqual([
        "23514",
        "safety_holds_rule_known",
      ]);
      expect(await refusedBy("safety_holds", { ...hold, released_at: releasedAt }, before)).toEqual([
        "23514",
        "safety_holds_released_pair",
      ]);
      expect(
        await refusedBy(
          "safety_holds",
          { ...hold, release_rule: "at_once", released_why: "outcome_message_sent" },
          before,
        ),
      ).toEqual(["23514", "safety_holds_released_pair"]);
      for (const [rule, why] of [
        ["after_safe", "outcome_message_sent"],
        ["after_safe", "booking_private"],
        ["at_once", "booking_private"],
        ["when_private", "outcome_message_sent"],
        ["at_once", "visit_done"],
      ] as const) {
        expect(
          await refusedBy(
            "safety_holds",
            {
              ...hold,
              booking_id: "booking-alex-haircut",
              release_rule: rule,
              released_at: releasedAt,
              released_why: why,
            },
            before,
          ),
          `${rule} ${why}`,
        ).toEqual(["23514", "safety_holds_why_fits_rule"]);
      }
      for (const fault of [{ released_by_turn_id: null }, { released_by_outcome_id: null }]) {
        expect(
          await refusedBy("safety_holds", { ...hold, ...SAFE_RELEASE, ...fault }, before),
          JSON.stringify(fault),
        ).toEqual(["23514", "safety_holds_safe_release_has_read"]);
      }
      expect(
        await refusedBy("safety_holds", { ...hold, release_rule: "when_private", booking_id: null }, before),
      ).toEqual(["23514", "safety_holds_private_has_booking"]);
      expect(
        await refusedBy(
          "safety_holds",
          { ...hold, ...SAFE_RELEASE, released_at: "2026-10-24T15:00:02Z" },
          before,
        ),
      ).toEqual(["23514", "safety_holds_released_after_held"]);
      expect(
        await refusedBy(
          "safety_holds",
          { ...hold, ...SAFE_RELEASE, released_by_outcome_id: "safety-rule-held" },
          before,
        ),
      ).toEqual(["23514", "safety_holds_not_released_by_itself"]);
    },
  );

  it(
    "safety_holds: each foreign key refuses an id its table does not hold (23503); one hold per outcome, and the id, unique (23505)",
    SLOW,
    async () => {
      const before = [heldOutcome];
      for (const [fault, constraint] of [
        [{ safety_outcome_id: "safety-none" }, "safety_holds_outcome_fk"],
        [{ business_id: "biz-none" }, "safety_holds_business_fk"],
        [{ handle_id: "handle-none" }, "safety_holds_handle_fk"],
        [{ person_id: "person-none" }, "safety_holds_person_fk"],
        [{ booking_id: "booking-none" }, "safety_holds_booking_fk"],
        [{ turn_id: "turn-none" }, "safety_holds_turn_fk"],
        [{ ...SAFE_RELEASE, released_by_turn_id: "turn-none" }, "safety_holds_released_turn_fk"],
        [{ ...SAFE_RELEASE, released_by_outcome_id: "safety-none" }, "safety_holds_released_outcome_fk"],
      ] as const) {
        expect(await refusedBy("safety_holds", { ...hold, ...fault }, before), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      // A second hold on the seeded emergency, and a second row under the seed's hold id.
      expect(
        await refusedBy("safety_holds", { ...hold, safety_outcome_id: EMERGENCY.id ?? null }, before),
      ).toEqual(["23505", "safety_holds_one_per_outcome"]);
      expect(await refusedBy("safety_holds", { ...hold, id: RELEASED_HOLD.id ?? null }, before)).toEqual([
        "23505",
        "safety_holds_pkey",
      ]);
    },
  );

  /** Alex's report of harm to an older adult, under a new id. */
  const report: Values = { ...ELDER_REPORT, id: "harm-rule-base" };
  const team: FixtureRow[] = [{ table: "persons", values: { id: TEAM_MEMBER } }];
  const followed: Values = { followed_up_at: "2026-10-28T19:00:00Z", followed_up_by_person_id: TEAM_MEMBER };

  it(
    "harm_reports: each kind, each hotline, a follow-up; the kind, the one it names, the hotline, the sealed words' person, the follow-up as a pair after the report, the zone",
    SLOW,
    async () => {
      for (const hotline of ["child_abuse", "youth_crisis", "family_violence", "elder_care"]) {
        expect(await tried("harm_reports", { ...report, hotline }), hotline).toMatchObject({ hotline });
      }
      expect(
        await tried("harm_reports", {
          ...report,
          kind: "about_owner_or_staff",
          named_person_id: "person-riley",
        }),
      ).toMatchObject({ named_person_id: "person-riley" });
      expect(await tried("harm_reports", { ...report, kind: "unsafe_at_home", hotline: null })).toMatchObject(
        {
          kind: "unsafe_at_home",
        },
      );
      expect(await tried("harm_reports", { ...report, ...followed }, team)).toMatchObject({
        followed_up_by_person_id: TEAM_MEMBER,
      });
      // Harm to an animal goes to the owner, who decides any report (A3-49): not a kind here.
      expect(await refusedBy("harm_reports", { ...report, kind: "harm_to_animal", hotline: null })).toEqual([
        "23514",
        "harm_reports_kind_known",
      ]);
      for (const fault of [{ named_person_id: "person-riley" }, { kind: "about_owner_or_staff" }]) {
        expect(await refusedBy("harm_reports", { ...report, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "harm_reports_named_only_about_owner_or_staff",
        ]);
      }
      expect(await refusedBy("harm_reports", { ...report, hotline: "poison_control" })).toEqual([
        "23514",
        "harm_reports_hotline_known",
      ]);
      expect(await refusedBy("harm_reports", { ...report, hotline: null })).toEqual([
        "23514",
        "harm_reports_child_or_elder_has_hotline",
      ]);
      expect(await refusedBy("harm_reports", { ...report, sealed_for_person_id: null })).toEqual([
        "23514",
        "harm_reports_sealed_has_person",
      ]);
      for (const fault of [{ followed_up_at: null }, { followed_up_by_person_id: null }]) {
        expect(
          await refusedBy("harm_reports", { ...report, ...followed, ...fault }, team),
          JSON.stringify(fault),
        ).toEqual(["23514", "harm_reports_followed_up_pair"]);
      }
      expect(
        await refusedBy(
          "harm_reports",
          { ...report, ...followed, followed_up_at: "2026-10-28T14:15:02Z" },
          team,
        ),
      ).toEqual(["23514", "harm_reports_followed_after_reported"]);
      for (const day_zone of ["New York", "", "/America"]) {
        expect(await refusedBy("harm_reports", { ...report, day_zone }), day_zone).toEqual([
          "23514",
          "harm_reports_day_zone_form",
        ]);
      }
    },
  );

  it(
    "harm_reports: each foreign key refuses an id its table does not hold (23503); the id is unique (23505)",
    SLOW,
    async () => {
      for (const [fault, constraint] of [
        [{ business_id: "biz-none" }, "harm_reports_business_fk"],
        [{ safety_outcome_id: "safety-none" }, "harm_reports_outcome_fk"],
        [{ reporter_person_id: "person-none" }, "harm_reports_reporter_fk"],
        [{ booking_id: "booking-none" }, "harm_reports_booking_fk"],
        [
          { kind: "about_owner_or_staff", hotline: null, named_person_id: "person-none" },
          "harm_reports_named_fk",
        ],
        [{ sealed_for_person_id: "person-none" }, "harm_reports_sealed_for_fk"],
        [{ ...followed, followed_up_by_person_id: "person-none" }, "harm_reports_followed_up_by_fk"],
      ] as const) {
        expect(await refusedBy("harm_reports", { ...report, ...fault }), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      expect(await refusedBy("harm_reports", { ...report, id: ELDER_REPORT.id ?? null })).toEqual([
        "23505",
        "harm_reports_pkey",
      ]);
    },
  );

  /** Sam's timer again on a new clock row (one clock row per timer), not yet missed. */
  const clock: FixtureRow = {
    table: "clock_rows",
    values: {
      ...TIMER_CLOCK,
      id: "clock-timer-rule-base",
      fires: { step: "B8-86", safetyTimer: "timer-rule-base" },
    },
  };
  const timer: Values = { ...TIMER, id: "timer-rule-base", clock_row_id: "clock-timer-rule-base" };
  const dueAt = textOf(TIMER.due_at);
  /** Missed at the due time: the pro, then the contact, then the owner alerted (B8-86). */
  const missed: Values = {
    state: "missed",
    missed_at: dueAt,
    pro_alerted_at: "2026-10-27T15:20:05Z",
    contact_alerted_at: "2026-10-27T15:21:05Z",
    owner_alerted_at: "2026-10-27T15:22:05Z",
  };

  it(
    "safety_timers: running, missed with its alerts, safe before or after a miss; the yes at the start itself",
    SLOW,
    async () => {
      const before = [clock];
      const started = await tried("safety_timers", without(timer, ["state", "version"]), before);
      expect(started).toMatchObject({ state: "running", missed_at: null, safe_at: null, version: 1 });
      expect(await tried("safety_timers", { ...timer, ...missed }, before)).toMatchObject({
        state: "missed",
      });
      expect(
        await tried(
          "safety_timers",
          { ...timer, ...missed, state: "safe", safe_at: "2026-10-27T15:40:00Z" },
          before,
        ),
      ).toMatchObject({ state: "safe" });
      expect(
        await tried("safety_timers", { ...timer, state: "safe", safe_at: "2026-10-27T15:05:00Z" }, before),
      ).toMatchObject({ state: "safe", missed_at: null });
      expect(
        await tried("safety_timers", { ...timer, contact_yes_at: timer.started_at ?? null }, before),
      ).toMatchObject({ state: "running" });
    },
  );

  it(
    "safety_timers: the state and its times, due after the start, the yes before it, a contact who is not the pro, a miss after the due time, alerts only after a miss, the zone",
    SLOW,
    async () => {
      const before = [clock];
      // An unknown state fits no branch of safety_timers_state_times either; PostgreSQL checks a table's CHECKs in
      // name order, so the state's own rule is the one named.
      expect(await refusedBy("safety_timers", { ...timer, state: "paused" }, before)).toEqual([
        "23514",
        "safety_timers_state_known",
      ]);
      for (const fault of [
        { state: "missed" },
        { missed_at: dueAt },
        { ...missed, safe_at: "2026-10-27T15:40:00Z" },
        { state: "safe" },
        { safe_at: "2026-10-27T15:05:00Z" },
      ]) {
        expect(
          await refusedBy("safety_timers", { ...timer, ...fault }, before),
          JSON.stringify(fault),
        ).toEqual(["23514", "safety_timers_state_times"]);
      }
      for (const due_at of [textOf(timer.started_at), "2026-10-27T13:00:00Z"]) {
        expect(await refusedBy("safety_timers", { ...timer, due_at }, before), due_at).toEqual([
          "23514",
          "safety_timers_due_after_start",
        ]);
      }
      expect(
        await refusedBy("safety_timers", { ...timer, contact_yes_at: "2026-10-27T13:20:03Z" }, before),
      ).toEqual(["23514", "safety_timers_yes_before_start"]);
      expect(
        await refusedBy("safety_timers", { ...timer, emergency_contact_person_id: "person-sam" }, before),
      ).toEqual(["23514", "safety_timers_contact_not_worker"]);
      expect(
        await refusedBy("safety_timers", { ...timer, ...missed, missed_at: "2026-10-27T15:19:59Z" }, before),
      ).toEqual(["23514", "safety_timers_missed_after_due"]);
      for (const alert of ["pro_alerted_at", "contact_alerted_at", "owner_alerted_at"]) {
        expect(
          await refusedBy("safety_timers", { ...timer, [alert]: missed[alert] ?? null }, before),
          alert,
        ).toEqual(["23514", "safety_timers_alerts_after_miss"]);
      }
      for (const due_zone of ["New York", "", "Eastern Time"]) {
        expect(await refusedBy("safety_timers", { ...timer, due_zone }, before), due_zone).toEqual([
          "23514",
          "safety_timers_due_zone_form",
        ]);
      }
    },
  );

  it(
    "safety_timers: each foreign key refuses an id its table does not hold (23503); one timer per clock row, and the id, unique (23505)",
    SLOW,
    async () => {
      const before = [clock];
      for (const [fault, constraint] of [
        [{ business_id: "biz-none" }, "safety_timers_business_fk"],
        [{ booking_id: "booking-none" }, "safety_timers_booking_fk"],
        [{ worker_person_id: "person-none" }, "safety_timers_worker_fk"],
        [{ worker_handle_id: "handle-none" }, "safety_timers_worker_handle_fk"],
        [{ emergency_contact_person_id: "person-none" }, "safety_timers_contact_fk"],
        [{ emergency_contact_handle_id: "handle-none" }, "safety_timers_contact_handle_fk"],
        [{ started_by_turn_id: "turn-none" }, "safety_timers_turn_fk"],
        [{ address_for_person_id: "person-none" }, "safety_timers_address_for_fk"],
        [{ clock_row_id: "clock-none" }, "safety_timers_clock_fk"],
      ] as const) {
        expect(await refusedBy("safety_timers", { ...timer, ...fault }, before), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      // A second timer on the seeded timer's clock row, and a second row under the seed's id.
      expect(
        await refusedBy("safety_timers", { ...timer, clock_row_id: TIMER.clock_row_id ?? null }),
      ).toEqual(["23505", "safety_timers_clock_key"]);
      expect(await refusedBy("safety_timers", { ...timer, id: TIMER.id ?? null }, before)).toEqual([
        "23505",
        "safety_timers_pkey",
      ]);
    },
  );

  /** Dee W.'s card photo and the text about Ben T.'s booking to an old number, under new ids. */
  const detail: Values = { ...CARD_SLIP, id: "privacy-rule-detail" };
  const wrong: Values = { ...WRONG_PERSON_SLIP, id: "privacy-rule-wrong" };
  const foundAt = textOf(WRONG_PERSON_SLIP.found_at);

  it(
    "privacy_incidents: each kind of detail never kept; a slip to the wrong person with a code replaced; each step at the moment it was found",
    SLOW,
    async () => {
      for (const detail_kind of ["card_number", "ssn", "password", "door_code", "plugin_list"]) {
        expect(await tried("privacy_incidents", { ...detail, detail_kind }), detail_kind).toMatchObject({
          detail_kind,
        });
      }
      expect(
        await tried("privacy_incidents", { ...wrong, codes_replaced_at: "2026-10-16T14:00:02Z" }),
      ).toMatchObject({ kind: "wrong_person", fields_shown: ["name", "visit_time"] });
      expect(
        await tried("privacy_incidents", {
          ...wrong,
          stopped_at: foundAt,
          codes_replaced_at: foundAt,
          person_told_at: foundAt,
          business_told_at: foundAt,
          team_reviewed_at: foundAt,
        }),
      ).toMatchObject({ kind: "wrong_person" });
      // Left out, the fields shown are none.
      expect(await tried("privacy_incidents", without(detail, ["fields_shown"]))).toMatchObject({
        fields_shown: [],
      });
    },
  );

  it(
    "privacy_incidents: the kind and the detail's kind; a detail never kept names no handle, outbox row or field; a wrong-person slip names its handle and no detail; each step after it was found",
    SLOW,
    async () => {
      expect(await refusedBy("privacy_incidents", { ...detail, kind: "lost_phone" })).toEqual([
        "23514",
        "privacy_incidents_kind_known",
      ]);
      expect(await refusedBy("privacy_incidents", { ...detail, detail_kind: "bank_account" })).toEqual([
        "23514",
        "privacy_incidents_detail_kind_known",
      ]);
      for (const fault of [
        { detail_kind: null },
        { sent_to_handle_id: "handle-ben-old-number" },
        { outbox_row_id: "out-none" },
        { fields_shown: ["name"] },
      ]) {
        expect(await refusedBy("privacy_incidents", { ...detail, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "privacy_incidents_never_kept_fields",
        ]);
      }
      for (const fault of [
        { sent_to_handle_id: null },
        { detail_kind: "card_number" },
        { event_id: "evt-dee-0001" },
        { deleted_at: "2026-10-16T14:00:01Z" },
      ]) {
        expect(await refusedBy("privacy_incidents", { ...wrong, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "privacy_incidents_wrong_person_fields",
        ]);
      }
      const early = "2026-10-16T13:59:59Z";
      for (const [base, step] of [
        [{ ...detail, found_at: foundAt }, "deleted_at"],
        [wrong, "stopped_at"],
        [wrong, "codes_replaced_at"],
        [wrong, "person_told_at"],
        [wrong, "business_told_at"],
        [wrong, "team_reviewed_at"],
      ] as const) {
        expect(await refusedBy("privacy_incidents", { ...base, [step]: early }), step).toEqual([
          "23514",
          "privacy_incidents_steps_after_found",
        ]);
      }
    },
  );

  it(
    "privacy_incidents: each foreign key refuses an id its table does not hold (23503); the id is unique (23505)",
    SLOW,
    async () => {
      for (const [base, fault, constraint] of [
        [detail, { business_id: "biz-none" }, "privacy_incidents_business_fk"],
        [detail, { person_id: "person-none" }, "privacy_incidents_person_fk"],
        [wrong, { booking_id: "booking-none" }, "privacy_incidents_booking_fk"],
        [wrong, { outbox_row_id: "out-none" }, "privacy_incidents_outbox_fk"],
        [wrong, { sent_to_handle_id: "handle-none" }, "privacy_incidents_sent_to_fk"],
      ] as const) {
        expect(await refusedBy("privacy_incidents", { ...base, ...fault }), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      expect(await refusedBy("privacy_incidents", { ...detail, id: CARD_SLIP.id ?? null })).toEqual([
        "23505",
        "privacy_incidents_pkey",
      ]);
    },
  );

  /** One row per table, as the fixtures give it under new ids, with what must exist before it. */
  const BASES: Record<string, { values: Values; before: FixtureRow[] }> = {
    safety_outcomes: { values: outcome, before: [] },
    safety_holds: { values: hold, before: [heldOutcome] },
    harm_reports: { values: report, before: [] },
    safety_timers: { values: timer, before: [clock] },
    privacy_incidents: { values: detail, before: [] },
  };

  for (const table of TABLES) {
    it(`${table.name}: each column the table list marks not null refuses a null (23502)`, SLOW, async () => {
      const base = BASES[table.name];
      if (base === undefined) {
        throw new Error(`no base row for ${table.name}`);
      }
      expect(await tried(table.name, base.values, base.before)).toMatchObject({ id: base.values.id });
      const notNull = table.columns.filter((column) => !column.null).map((column) => column.name);
      expect(notNull.length, table.name).toBeGreaterThan(0);
      for (const column of notNull) {
        const refused = await refusal(tried(table.name, { ...base.values, [column]: null }, base.before));
        expect([refused.code, refused.column], `${table.name}.${column}`).toEqual(["23502", column]);
      }
    });
  }

  it(
    "the four updated tables: an update must raise the version by exactly one (<table>_version_raised, 23514)",
    SLOW,
    async () => {
      const seeded: [string, Values][] = [
        ["safety_holds", CRISIS_HOLD],
        ["harm_reports", ELDER_REPORT],
        ["safety_timers", TIMER],
        ["privacy_incidents", WRONG_PERSON_SLIP],
      ];
      expect(seeded.map(([table]) => table).sort()).toEqual(VERSIONED_TABLES);
      for (const [table, values] of seeded) {
        const id = textOf(values.id);
        for (const raise of [0, 2]) {
          const refused = await refusal(
            as(
              RUNTIME,
              null,
              (tx) => tx`update ${tx(table)} set version = version + ${raise} where id = ${id}`,
            ),
          );
          expect([refused.code, refused.constraint], `${table} raised by ${String(raise)}`).toEqual([
            "23514",
            `${table}_version_raised`,
          ]);
        }
        const raised = await as(
          RUNTIME,
          null,
          (tx) => tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where id = ${id} returning version
          `,
        );
        expect(raised, table).toEqual([{ version: Number(values.version) + 1 }]);
      }
    },
  );
});

describe("sealed fields (rule 6): each opens with its own person's key alone, and never once that key is erased", () => {
  /** One wrapping key per run: random, in memory only, named like the Workers secret that will hold the real one. */
  const wrapBytes = crypto.getRandomValues(new Uint8Array(32));
  const keys: WrappingKeys = {
    resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? wrapBytes : undefined),
  };
  const encoder = new TextEncoder();

  /** A fixture's stand-in bytes as text: what is sealed here, never a person's real words (rule 9). */
  const standIn = (value: Json | undefined): string =>
    new TextDecoder().decode(fromHex(textOf(value).replace(/^\\x/, "")));

  /** Whether `needle` appears anywhere inside `haystack`. */
  function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
    for (let start = 0; start + needle.length <= haystack.length; start += 1) {
      if (needle.every((byte, index) => haystack[start + index] === byte)) {
        return true;
      }
    }
    return false;
  }

  /** The SealingError code a promise fails with. Any other outcome fails the test. */
  async function sealingFailure(promise: Promise<unknown>): Promise<SealingErrorCode> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof SealingError) {
        return error.code;
      }
      throw error;
    }
    throw new Error("the call succeeded; it should have failed with a SealingError");
  }

  /** A row's sealed column, as stored. */
  async function sealedOf(tx: Tx, table: string, column: string, id: string): Promise<Uint8Array> {
    const [row] = await tx<{ sealed: Uint8Array | null }[]>`
      select ${tx(column)} as sealed from ${tx(table)} where id = ${id}
    `;
    const sealed = row?.sealed ?? null;
    if (sealed === null) {
      throw new Error(`${table} ${id} has no ${column}`);
    }
    return sealed;
  }

  /**
   * In one rolled-back transaction on the runtime side: seals `plain` under Alex's key and under each of `others`' own
   * keys, writes the row `write` makes with Alex's sealed bytes, then opens what was stored as Alex, as each other
   * person, and as Alex again once Alex's key is erased; `plainRead` reads the row's plain columns at the end.
   */
  async function sealedRow(
    plain: string,
    others: readonly string[],
    write: (tx: Tx, sealedHex: string) => Promise<{ table: string; column: string; id: string }>,
    plainRead: (tx: Tx) => Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    return as(RUNTIME, null, async (tx) => {
      const sealed = await seal(tx, keys, "person-alex", plain);
      for (const other of others) {
        await seal(tx, keys, other, plain);
      }
      const where = await write(tx, `\\x${toHex(sealed)}`);
      const stored = await sealedOf(tx, where.table, where.column, where.id);
      const opened = await unsealText(tx, keys, "person-alex", stored);
      const byOthers: Record<string, SealingErrorCode> = {};
      for (const other of others) {
        byOthers[other] = await sealingFailure(unsealText(tx, keys, other, stored));
      }
      const erased = await erasePerson(tx, "person-alex");
      return {
        overhead: stored.length - encoder.encode(plain).length,
        holdsThePlainBytes: contains(stored, encoder.encode(plain)),
        opened,
        byOthers,
        erased: erased.ok,
        afterErasure: await sealingFailure(unsealText(tx, keys, "person-alex", stored)),
        sealAgain: await sealingFailure(seal(tx, keys, "person-alex", plain)),
        plain: await plainRead(tx),
      };
    });
  }

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("safety_outcomes.sealed_words: Alex's words open with Alex's key, not Riley's; once Alex's key is erased never again, while the labels and tense stay plain", async () => {
    const words = standIn(CRISIS.sealed_words);
    const id = "safety-alex-0208";
    const result = await sealedRow(
      words,
      ["person-riley"],
      async (tx, sealedHex) => {
        await insertRow(tx, "safety_outcomes", {
          ...CRISIS,
          id,
          event_id: "evt-alex-0208",
          sealed_words: sealedHex,
        });
        return { table: "safety_outcomes", column: "sealed_words", id };
      },
      async (tx) => {
        const [row] = await tx<{ labels: string[]; tenses: string[]; outcomes: string[]; kinds: string[] }[]>`
          select labels, tenses, outcomes, danger_word_kinds as kinds from safety_outcomes where id = ${id}
        `;
        return row;
      },
    );
    expect(words).toBe("k34-seed-sealed-words-not-real");
    expect(result).toEqual({
      overhead: SEAL_OVERHEAD_BYTES,
      holdsThePlainBytes: false,
      opened: words,
      byOthers: { "person-riley": "cannot_open" },
      erased: true,
      afterErasure: "erased",
      sealAgain: "erased",
      plain: { labels: ["Crisis words"], tenses: ["now"], outcomes: ["Crisis words"], kinds: ["selfHarm"] },
    });
  });

  it("harm_reports.sealed_details: what Alex told opens with Alex's key, never the key of Riley, whom it names; once Alex's key is erased never again", async () => {
    const details = standIn(STAFF_REPORT.sealed_details);
    const id = "harm-alex-about-staff-sealed";
    const result = await sealedRow(
      details,
      ["person-riley"],
      async (tx, sealedHex) => {
        await insertRow(tx, "harm_reports", { ...STAFF_REPORT, id, sealed_details: sealedHex });
        return { table: "harm_reports", column: "sealed_details", id };
      },
      async (tx) => {
        const [row] = await tx<{ kind: string; named: string }[]>`
          select kind, named_person_id as named from harm_reports where id = ${id}
        `;
        return row;
      },
    );
    expect(details).toBe("k34-seed-sealed-details-not-real");
    expect(result).toMatchObject({
      overhead: SEAL_OVERHEAD_BYTES,
      holdsThePlainBytes: false,
      opened: details,
      byOthers: { "person-riley": "cannot_open" },
      erased: true,
      afterErasure: "erased",
      plain: { kind: "about_owner_or_staff", named: "person-riley" },
    });
  });

  it("safety_timers.address: the job's address opens with the key of Alex, whose place it is, not Sam's or Morgan Lee's; once Alex's key is erased never again, while the due time and contact stay", async () => {
    const address = standIn(TIMER.address);
    const id = "timer-sam-survey-sealed";
    const result = await sealedRow(
      address,
      ["person-sam", "person-morgan-lee"],
      async (tx, sealedHex) => {
        await insertRow(tx, "clock_rows", {
          ...TIMER_CLOCK,
          id: "clock-timer-sam-survey-sealed",
          fires: { step: "B8-86", safetyTimer: id },
        });
        await insertRow(tx, "safety_timers", {
          ...TIMER,
          id,
          clock_row_id: "clock-timer-sam-survey-sealed",
          address: sealedHex,
        });
        return { table: "safety_timers", column: "address", id };
      },
      async (tx) => {
        const [row] = await tx<{ zone: string; contact: string }[]>`
          select due_zone as zone, emergency_contact_handle_id as contact from safety_timers where id = ${id}
        `;
        return row;
      },
    );
    expect(address).toBe("k34-seed-sealed-address-not-real");
    expect(result).toMatchObject({
      overhead: SEAL_OVERHEAD_BYTES,
      holdsThePlainBytes: false,
      opened: address,
      byOthers: { "person-sam": "cannot_open", "person-morgan-lee": "cannot_open" },
      erased: true,
      afterErasure: "erased",
      plain: { zone: "America/New_York", contact: "handle-morgan-lee" },
    });
  });
});
