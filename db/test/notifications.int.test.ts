// T-581: the notifications part (K-36 v1: hand_offs, team_pages and team_page_recipients) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- notifications`). The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: the commit's per-write scope and the owner's answer) or the
// runtime side (rosie_job: the clock that escalates a hand-off or repeats a page, the dispatcher, and Rosie's team's
// side until K-21 names its role) runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call
// is scoped, and is rolled back. Seed fixtures are loaded the same way, as the runtime side with no scope (K-04's
// fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-36 v1's seeds and the K-34 v1 and K-04 v1 seeds their after chains name
// (Lee's Barbershop, the yoga studio and the master's sample cast: Sam, Alex M., Riley, and Pat, the person Sam named),
// and, for the rows a hand-off or a page points at beyond those chains, K-34's crisis-words read, harm reports and safety
// timer and K-37's review items. A row made here is a fixture row under new ids, or with one fault. No seed names a
// member of Rosie's team (Q-18's members are real people), so a member is a stand-in persons row with no name and no
// role, as T-193's and T-580's tests make, reached by stand-in handles in the fixtures' made-up ranges (555-01xx and
// example.com). The summaries of the pages made here are examples, as the seeds' are.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";

const PART_DIR = new URL("../../contracts/db-schema/notifications/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The three tables, in code-unit order (as PostgreSQL orders a relation's name). All three are versioned. */
const OWN_TABLES = ["hand_offs", "team_page_recipients", "team_pages"];
/** hand_offs is scoped by business, on business_id; team_pages and team_page_recipients are Rosie's team's (none). */
const SCOPED_TABLES = ["hand_offs"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
const ZONE = "America/New_York";
const DAY = 24 * 60;
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey: string[];
  foreignKeys: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
  unique?: { name: string; columns: string[]; where?: string }[];
  checks?: { name: string; expression: string }[];
  indexes?: { name: string; columns: string[]; where?: string }[];
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
  scope?: { businessId: string } | null;
  action: string;
  table: string;
  values?: Values;
  set?: Values;
  where?: Values;
  expect: { sqlstate?: string; constraintOneOf?: string[]; rows?: number };
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

const TABLES = (readJson(new URL("notifications.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another part, named as K-36's seeds name K-34's: from K-36's fixtures/ folder. */
const acceptedOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);
const CORE_SEEDS = acceptedOf("core");
const SAFETY_SEEDS = acceptedOf("safety-incidents");
/** The rows a hand-off or a page points at beyond K-36's chains: K-34's crisis words, harm reports and timer, K-37's queue. */
const POINTED_AT = [
  "../../safety-incidents/fixtures/seed-outcome-crisis.json",
  "../../safety-incidents/fixtures/seed-harm-report.json",
  "../../safety-incidents/fixtures/seed-safety-timer.json",
  "../../platform-review/fixtures/seed-review-item.json",
];

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's `index`th own row of `table`. */
function valuesOf(file: string, table: string, index = 0): Values {
  const row = fixtureFile(file).rows.filter((candidate) => candidate.table === table)[index];
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
 * file that names it, so K-36's seeds name K-34's as ../../safety-incidents/fixtures/<file>), each file once.
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

/** The instant `minutes` after `iso` (before it when negative). */
const later = (iso: Json | undefined, minutes: number): string =>
  new Date(Date.parse(textOf(iso)) + minutes * 60_000).toISOString();

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Alex's threat to Riley handed to Sam, its fired clock row, the open page and its armed next clock row (seed-page-open). */
const THREAT_HAND_OFF = valuesOf("seed-page-open.json", "hand_offs");
const THREAT_CLOCK = valuesOf("seed-page-open.json", "clock_rows", 0);
const OPEN_PAGE_NEXT_CLOCK = valuesOf("seed-page-open.json", "clock_rows", 2);
const OPEN_PAGE = valuesOf("seed-page-open.json", "team_pages");
/** Alex's emergency handed to Sam, its fired clock row, and the page Pat acknowledged (seed-page-acknowledged). */
const EMERGENCY_HAND_OFF = valuesOf("seed-page-acknowledged.json", "hand_offs");
const EMERGENCY_CLOCK = valuesOf("seed-page-acknowledged.json", "clock_rows", 0);
const CANCELLED_CLOCK = valuesOf("seed-page-acknowledged.json", "clock_rows", 2);
const ACKNOWLEDGED_PAGE = valuesOf("seed-page-acknowledged.json", "team_pages");
/** The columns of a page's acknowledgement. */
const ACKNOWLEDGEMENT = ["state", "acknowledged_at", "acknowledged_by_person_id", "acknowledged_via"];
/** The columns of a hand-off's answer. */
const ANSWER = ["answered_at", "answered_via", "answered_by_person_id"];

/** A stand-in for a member of Rosie's team: a persons row with no name and no role, with a mobile and an email. */
const TEAM_MEMBER = "person-team-stand-in";
const TEAM: FixtureRow[] = [
  { table: "persons", values: { id: TEAM_MEMBER } },
  { table: "handles", values: { id: "handle-team-stand-in", kind: "phone", address: "+15555550190" } },
  {
    table: "handles",
    values: { id: "handle-team-stand-in-email", kind: "email", address: "team-stand-in@example.com" },
  },
  { table: "person_handles", values: { person_id: TEAM_MEMBER, handle_id: "handle-team-stand-in" } },
  { table: "person_handles", values: { person_id: TEAM_MEMBER, handle_id: "handle-team-stand-in-email" } },
];
/** The stand-in on the recipient list: paged in their own chat with Rosie, else by email. */
const MEMBER: Values = {
  id: "recipient-team-stand-in",
  person_id: TEAM_MEMBER,
  chat_handle_id: "handle-team-stand-in",
  email_handle_id: "handle-team-stand-in-email",
  added_at: "2026-10-01T12:00:00Z",
  removed_at: null,
  version: 1,
};

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

/** A stored value next to the fixture's: a time as the instant it names. */
function comparable(stored: unknown, given: Json): [unknown, unknown] {
  if (stored instanceof Date && typeof given === "string") {
    return [stored.toISOString(), new Date(given).toISOString()];
  }
  return [stored, given];
}

/** Every column the fixture gives is stored as given, read back as the owner by the table's primary key. */
async function expectStored(row: FixtureRow): Promise<void> {
  const id = textOf(row.values.id);
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select * from ${db.sql(row.table)} where id = ${id}
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

/** Rows of `table` whose business_id is `businessId`, read as the owner. */
async function ownerCount(table: string, businessId: string): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from ${db.sql(table)} where business_id = ${businessId}
  `;
  return row?.n ?? -1;
}

/** A table's ids, in order. */
async function keysOf(table: string): Promise<string[]> {
  const rows = await db.sql<{ key: string }[]>`select id as key from ${db.sql(table)} order by 1`;
  return rows.map((row) => row.key);
}

/**
 * A table's checks and indexes as PostgreSQL prints them, by name; an index without its own name and table, but with
 * UNIQUE kept, so a partial unique index is compared as one.
 */
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
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1")]),
    ),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "notifications" });
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

describe("the migration against the frozen table list (K-36 v1 notifications)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names three tables: hand_offs scoped by business on business_id, team_pages and team_page_recipients none; all three versioned", () => {
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
      hand_offs: ["business", "business_id", true, "version"],
      team_pages: ["none", null, true, "version"],
      team_page_recipients: ["none", null, true, "version"],
    });
  });

  for (const table of TABLES) {
    it(`${table.name}: columns in order, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
        select column_name as name, data_type as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules (a partial one as a partial unique index) and index names are the table list's`, async () => {
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
      const unique = table.unique ?? [];
      // A unique rule with a where is a partial unique index (tables.meta.schema.json), which no constraint row holds.
      const plain = unique.filter((rule) => rule.where === undefined);
      const partial = unique.filter((rule) => rule.where !== undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(table.foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of table.foreignKeys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        );
      }
      for (const rule of plain) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.join(", ")})`,
        );
      }
      const indexes = await db.sql<{ name: string; unique: boolean; partial: boolean }[]>`
        select c.relname as name, i.indisunique as unique, i.indpred is not null as partial
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...unique.map((rule) => rule.name),
          ...(table.indexes ?? []).map((index) => index.name),
        ].sort(),
      );
      for (const rule of partial) {
        expect(
          indexes.find((index) => index.name === rule.name),
          rule.name,
        ).toEqual({ name: rule.name, unique: true, partial: true });
      }
    });

    it(`${table.name}: each check, each index and each partial unique index is the table list's own expression, as PostgreSQL reads both`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const checks = table.checks ?? [];
      const partial = (table.unique ?? []).filter((rule) => rule.where !== undefined);
      const listed = await asOwner(async (tx) => {
        await tx`create temporary table probe (like ${tx(table.name)}) on commit drop`;
        for (const check of checks) {
          await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
        }
        for (const index of table.indexes ?? []) {
          const where = index.where === undefined ? "" : ` where ${index.where}`;
          await tx.unsafe(`create index ${index.name} on probe (${index.columns.join(", ")})${where}`);
        }
        for (const rule of partial) {
          await tx.unsafe(
            `create unique index ${rule.name} on probe (${rule.columns.join(", ")}) where ${rule.where ?? ""}`,
          );
        }
        return definitionsOf(tx, "probe");
      });
      expect(Object.keys(listed.checks).sort()).toEqual(checks.map((check) => check.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(
        [...(table.indexes ?? []), ...partial].map((index) => index.name).sort(),
      );
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      // A plain unique rule's own index is checked above by name and columns; the named and partial indexes here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("all three tables raise their version on every update (0002's rule): <table>_version_raised, and no other trigger", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual(
      OWN_TABLES.map((table) => [table, `${table}_version_raised`]),
    );
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
  });

  it("row-level security is on for hand_offs with 0012's two policies on business_id, off for team_pages and team_page_recipients; none forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual([
      { name: "hand_offs", on: true, forced: false },
      { name: "team_page_recipients", on: false, forced: false },
      { name: "team_pages", on: false, forced: false },
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
    expect([...new Set(policies.map((policy) => policy.table))]).toEqual([...SCOPED_TABLES, "outbox_rows"]);
    // 0012's shape, read from outbox_rows' two policies, which key on the same column (business_id).
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    const own = policies.filter((policy) => policy.table === "hand_offs");
    expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
      ["hand_offs_runtime", "PERMISSIVE", [RUNTIME], "ALL"],
      ["hand_offs_tool_api", "PERMISSIVE", [TOOL_API], "ALL"],
    ]);
    expect(own.map((policy) => [policy.using, policy.check])).toEqual(
      core.map((policy) => [policy.using, policy.check]),
    );
    expect(own[0]?.using).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
    // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
    expect(own[0]?.using).toContain("IS NULL");
    expect(own[1]?.using).not.toContain("IS NULL");
  });

  it("grants (README rule 2): select, insert and update on hand_offs to both roles; on team_pages rosie_app inserts only; team_page_recipients is rosie_job's alone; no delete, truncate, references or trigger", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const rows = (role: Role, table: string, privileges: string[]) =>
      privileges.map((privilege) => `${role} ${table} ${privilege}`);
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      [
        ...rows(TOOL_API, "hand_offs", ["INSERT", "SELECT", "UPDATE"]),
        ...rows(TOOL_API, "team_pages", ["INSERT"]),
        ...rows(RUNTIME, "hand_offs", ["INSERT", "SELECT", "UPDATE"]),
        ...rows(RUNTIME, "team_page_recipients", ["INSERT", "SELECT", "UPDATE"]),
        ...rows(RUNTIME, "team_pages", ["INSERT", "SELECT", "UPDATE"]),
      ].sort(),
    );
    // No other grantee: PUBLIC holds nothing on any of the three.
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

  it("is recorded in schema_migrations as notifications, after platform_review and safety_incidents", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("notifications");
    expect(names.indexOf("notifications")).toBeGreaterThan(names.indexOf("platform_review"));
    expect(names.indexOf("notifications")).toBeGreaterThan(names.indexOf("safety_incidents"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the two of 02-contracts' K-36 row", () => {
  /** The K-36 rows both seeds give, per table: no seed names a member of Rosie's team. */
  const SEEDED = { hand_offs: 2, team_page_recipients: 0, team_pages: 2 };

  it("the index lists the two seeds and four refused rows, all K-36 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual(["seed-page-acknowledged.json", "seed-page-open.json"]);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-other-business-reads-hand-off.json",
      "invalid/refuse-owner-reads-team-page.json",
      "invalid/refuse-page-acknowledged-by-nobody.json",
      "invalid/refuse-threat-escalates-after-ten-minutes.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-36 row is stored as given`,
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
        expect(fixtureFile(file).rows.some((row) => row.table === "team_pages")).toBe(true);
      },
    );
  }

  it(
    "both insert together, each after chain once: two hand-offs to Sam and the two pages they raised",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(SEEDS);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await keysOf("hand_offs")).toEqual(["handoff-alex-0202", "handoff-alex-0204"]);
      expect(await keysOf("team_pages")).toEqual(["page-alex-0202", "page-alex-0204"]);
      expect(await keysOf("team_page_recipients")).toEqual([]);
    },
  );

  it("they insert together with every K-04 v1 and K-34 v1 seed as well, each file once", SLOW, async () => {
    await reset();
    expect(CORE_SEEDS.length).toBeGreaterThan(0);
    expect(SAFETY_SEEDS.length).toBeGreaterThan(0);
    const loaded = await loadFixtures([...CORE_SEEDS, ...SAFETY_SEEDS, ...SEEDS]);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    for (const table of OWN_TABLES) {
      expect(await countRows(db.sql, table), table).toBe(loaded[table] ?? 0);
    }
  });
});

describe("the seeded rows, both seeds loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("the open page: Alex's threat told to Sam at 5:40pm New York time; no answer, so at 5:45pm the hand-off's clock row fired and Pat and Rosie's team were paged; paged again at 5:50pm; still open, its next page armed for 5:55pm", async () => {
    const [row] = await db.sql<Record<string, unknown>[]>`
      select h.kind, h.told_as as "toldAs", told.name as told,
             to_char(h.handed_at at time zone ${ZONE}, 'FMHH12:MIam') as handed,
             hc.state as "handOffClock", to_char(hc.fired_at at time zone ${ZONE}, 'FMHH12:MIam') as fired,
             h.escalated_at = h.escalate_at as "escalatedWhenDue", h.answered_at as answered,
             p.state, p.times_paged as times, p.repeat_minutes as repeat, named.name as named,
             to_char(p.opened_at at time zone ${ZONE}, 'FMHH12:MIam') as opened,
             to_char(p.last_paged_at at time zone ${ZONE}, 'FMHH12:MIam') as "lastPaged",
             nc.state as "nextClock", to_char(nc.due_at at time zone ${ZONE}, 'FMHH12:MIam') as "nextDue",
             nc.due_at = p.last_paged_at + interval '5 minutes' as "fiveMinutesOn"
      from team_pages p
        join hand_offs h on h.id = p.hand_off_id
        join persons told on told.id = h.told_person_id
        join clock_rows hc on hc.id = h.escalation_clock_row_id
        join persons named on named.id = p.named_person_id
        join clock_rows nc on nc.id = p.next_page_clock_row_id
      where p.id = ${textOf(OPEN_PAGE.id)}
    `;
    expect(row).toEqual({
      kind: "threat",
      toldAs: "owner",
      told: "Sam Lee",
      handed: "5:40pm",
      handOffClock: "fired",
      fired: "5:45pm",
      escalatedWhenDue: true,
      answered: null,
      state: "open",
      times: 2,
      repeat: 5,
      named: "Pat",
      opened: "5:45pm",
      lastPaged: "5:50pm",
      nextClock: "armed",
      nextDue: "5:55pm",
      fiveMinutesOn: true,
    });
    // The owner hears A3-48's line, never Alex's words; the page holds ids, kinds and plain words.
    expect(THREAT_HAND_OFF.summary).toMatch(/^Urgent: /);
    expect(OPEN_PAGE.summary).toContain(textOf(THREAT_HAND_OFF.id));
  });

  it("an acknowledged page keeps who and when: Pat, by reply, at 11:12am New York time, after the last page at 11:10am; its next page's clock row was cancelled then; Sam's own answer is still to come", async () => {
    const [page] = await db.sql<Record<string, unknown>[]>`
      select * from team_pages where id = ${textOf(ACKNOWLEDGED_PAGE.id)}
    `;
    for (const column of [...ACKNOWLEDGEMENT, "last_paged_at", "times_paged", "repeat_minutes", "version"]) {
      const [actual, wanted] = comparable(page?.[column], ACKNOWLEDGED_PAGE[column] ?? null);
      expect(actual, column).toEqual(wanted);
    }
    expect(page).toMatchObject({
      state: "acknowledged",
      acknowledged_by_person_id: "person-pat",
      acknowledged_via: "reply",
      named_person_id: "person-pat",
      version: 3,
    });
    const [when] = await db.sql<Record<string, unknown>[]>`
      select to_char(p.acknowledged_at at time zone ${ZONE}, 'FMHH12:MIam') as acknowledged,
             to_char(p.last_paged_at at time zone ${ZONE}, 'FMHH12:MIam') as "lastPaged",
             ack.name as "by", nc.state as "nextClock", nc.cancelled_at = p.acknowledged_at as "cancelledThen",
             h.kind as "handOff", h.answered_at is null as "ownerStillToAnswer"
      from team_pages p
        join persons ack on ack.id = p.acknowledged_by_person_id
        join clock_rows nc on nc.id = p.next_page_clock_row_id
        join hand_offs h on h.id = p.hand_off_id
      where p.id = ${textOf(ACKNOWLEDGED_PAGE.id)}
    `;
    expect(when).toEqual({
      acknowledged: "11:12am",
      lastPaged: "11:10am",
      by: "Pat",
      nextClock: "cancelled",
      cancelledThen: true,
      handOff: "emergency",
      ownerStillToAnswer: true,
    });
    expect(CANCELLED_CLOCK.state).toBe("cancelled");
    // The team console's open pages no longer list it (team_pages_open_idx's rows); the threat's page is still open.
    const open = await db.sql<
      { id: string }[]
    >`select id from team_pages where state = 'open' order by opened_at`;
    expect(open.map((row) => row.id)).toEqual([textOf(OPEN_PAGE.id)]);
  });

  it("the acknowledgement stays whole: a later update keeps who and when; one that drops any part of it or reopens the page is refused (team_pages_acknowledged_together, 23514), as is one that moves it before the last page (team_pages_acknowledged_after_paged)", async () => {
    const id = textOf(ACKNOWLEDGED_PAGE.id);
    const updated = await as(
      RUNTIME,
      null,
      (tx) => tx<Record<string, unknown>[]>`
        update team_pages set version = version + 1 where id = ${id}
        returning state, acknowledged_at, acknowledged_by_person_id, acknowledged_via, version
      `,
    );
    expect(updated).toHaveLength(1);
    for (const column of ACKNOWLEDGEMENT) {
      const [actual, wanted] = comparable(updated[0]?.[column], ACKNOWLEDGED_PAGE[column] ?? null);
      expect(actual, column).toEqual(wanted);
    }
    expect(updated[0]?.version).toBe(4);
    for (const [column, value, constraint] of [
      ["acknowledged_at", null, "team_pages_acknowledged_together"],
      ["acknowledged_by_person_id", null, "team_pages_acknowledged_together"],
      ["acknowledged_via", null, "team_pages_acknowledged_together"],
      ["state", "open", "team_pages_acknowledged_together"],
      ["acknowledged_at", "2026-10-24T15:10:00Z", "team_pages_acknowledged_after_paged"],
    ] as const) {
      const outcome = await refusal(
        as(
          RUNTIME,
          null,
          (tx) => tx`update team_pages set ${tx(column)} = ${value}, version = version + 1 where id = ${id}`,
        ),
      );
      expect([outcome.code, outcome.constraint], `${column} ${String(value)}`).toEqual(["23514", constraint]);
    }
  });
});

describe("refuse-owner-reads-team-page.json: no business reads a page to Rosie's team, its owner included", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-owner-reads-team-page.json");
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = Object.entries(refused.where ?? {}).map(
      ([column, value]) => sql`${sql(column)} = ${textOf(value)}`,
    );
    const condition = conditions.reduce((all, one) => sql`${all} and ${one}`);
    return sql`select * from ${sql(refused.table)} where ${condition}`;
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop reads the page about its own hand-off; refused by privilege (42501)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "select",
      "team_pages",
    ]);
    expect(await read(db.sql)).toHaveLength(1);
    const outcome = await refusal(as(TOOL_API, refused.scope?.businessId ?? null, read));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table team_pages");
  });

  it("without its one fault (Rosie's team's side) the same read returns the page, unscoped or with that scope set", async () => {
    expect(await as(RUNTIME, null, read)).toHaveLength(1);
    expect(await as(RUNTIME, BARBERSHOP, read)).toHaveLength(1);
  });
});

describe("refuse-other-business-reads-hand-off.json: another business's hand-off is hidden from a Tool API call", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-other-business-reads-hand-off.json");
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = Object.entries(refused.where ?? {}).map(
      ([column, value]) => sql`${sql(column)} = ${textOf(value)}`,
    );
    const condition = conditions.reduce((all, one) => sql`${all} and ${one}`);
    return sql`select * from ${sql(refused.table)} where ${condition}`;
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to the yoga studio reads Lee's Barbershop's threat hand-off; no row", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      YOGA_STUDIO,
      "select",
      "hand_offs",
    ]);
    expect(await read(db.sql)).toHaveLength(1);
    expect(await as(TOOL_API, refused.scope?.businessId ?? null, read)).toHaveLength(
      refused.expect.rows ?? -1,
    );
  });

  it("without its one fault (the barbershop's own scope) the same read returns the hand-off", async () => {
    expect(await as(TOOL_API, BARBERSHOP, read)).toHaveLength(1);
  });
});

describe("refuse-threat-escalates-after-ten-minutes.json: an emergency or a threat goes to Rosie's team after exactly 5 minutes", () => {
  const file = "invalid/refuse-threat-escalates-after-ten-minutes.json";
  const { refused } = refusedOf(file);
  const values = refused.values ?? {};
  const insert = (row: Values) => (tx: Tx) => insertReturning(tx, refused.table, row);

  beforeAll(async () => {
    await reset();
    // The fixture's after chain and its own row: the clock row the late hand-off would use.
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop hands Alex's threat to Sam, escalating 10 minutes later; refused by hand_offs_emergency_threat_five_minutes (23514)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "insert",
      "hand_offs",
    ]);
    expect(values.escalate_at).toBe(later(values.handed_at, 10).replace(".000Z", "Z"));
    const outcome = await refusal(as(TOOL_API, BARBERSHOP, insert(values)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (escalating 5 minutes after it was handed off) the same row passes, unanswered and not yet escalated", async () => {
    const stored = await as(
      TOOL_API,
      BARBERSHOP,
      insert({ ...values, escalate_at: later(values.handed_at, 5) }),
    );
    expect(stored).toMatchObject({
      id: values.id,
      kind: "threat",
      escalation_clock_row_id: values.escalation_clock_row_id,
      answered_at: null,
      escalated_at: null,
      version: 1,
    });
    const [actual, wanted] = comparable(stored.escalate_at, "2026-10-26T21:45:03Z");
    expect(actual).toEqual(wanted);
  });
});

describe("refuse-page-acknowledged-by-nobody.json: a page is acknowledged by someone, by a reply or a console tap", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-page-acknowledged-by-nobody.json");
  const set = refused.set ?? {};
  const update = (changes: Values) => (tx: Tx) => tx<Record<string, unknown>[]>`
    update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, changes))}
    where id = ${textOf(refused.where?.id)}
    returning state, acknowledged_at, acknowledged_by_person_id, acknowledged_via, version
  `;

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the runtime side, with no scope, marks the open page acknowledged with no one and no way; refused by team_pages_acknowledged_together (23514)", async () => {
    expect([refused.role, refused.scope ?? null, refused.action, refused.table]).toEqual([
      "runtime",
      null,
      "update",
      "team_pages",
    ]);
    expect(Object.keys(refused.where ?? {})).toEqual(["id"]);
    const outcome = await refusal(as(RUNTIME, null, update(set)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("naming only Pat, or only the reply, is refused too", async () => {
    for (const half of [{ acknowledged_by_person_id: "person-pat" }, { acknowledged_via: "reply" }]) {
      const outcome = await refusal(as(RUNTIME, null, update({ ...set, ...half })));
      expect([outcome.code, outcome.constraint], JSON.stringify(half)).toEqual([
        "23514",
        "team_pages_acknowledged_together",
      ]);
    }
  });

  it("without its one fault (naming Pat and reply) the same update passes: acknowledged, by whom, how and when", async () => {
    const done = await as(
      RUNTIME,
      null,
      update({ ...set, acknowledged_by_person_id: "person-pat", acknowledged_via: "reply" }),
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      state: "acknowledged",
      acknowledged_by_person_id: "person-pat",
      acknowledged_via: "reply",
      version: 3,
    });
    const [actual, wanted] = comparable(done[0]?.acknowledged_at, set.acknowledged_at ?? null);
    expect(actual).toEqual(wanted);
  });
});

/** Pages paged once and waiting in the team console, one per reason other than a hand-off, each at its one row. */
const NO_POINTER: Values = {
  hand_off_id: null,
  harm_report_id: null,
  review_item_id: null,
  safety_timer_id: null,
  turn_id: null,
  named_person_id: null,
};
const ONCE: Values = {
  times_paged: 1,
  last_paged_at: OPEN_PAGE.opened_at ?? null,
  repeat_minutes: null,
  next_page_clock_row_id: null,
};
const pageOf = (reason: string, values: Values): Values => ({
  ...OPEN_PAGE,
  ...ONCE,
  ...NO_POINTER,
  id: `page-rule-${reason.replaceAll("_", "-")}`,
  reason,
  ...values,
});
const PAGES = {
  owner_cannot_act: pageOf("owner_cannot_act", {
    summary: "Word that the owner of Lee's Barbershop (biz-lees-barbershop) can't act.",
  }),
  harm_report: pageOf("harm_report", {
    harm_report_id: "harm-alex-about-staff",
    summary: "Harm report harm-alex-about-staff at Lee's Barbershop (biz-lees-barbershop): follow up today.",
  }),
  review_item: pageOf("review_item", {
    review_item_id: "review-harm-report-barbershop",
    summary: "Review item review-harm-report-barbershop at Lee's Barbershop (biz-lees-barbershop).",
  }),
  safety_timer_missed: pageOf("safety_timer_missed", {
    business_id: MOVERS,
    safety_timer_id: "timer-sam-survey",
    summary: "Safety timer timer-sam-survey at Movers (biz-movers) missed: keep trying until SAFE.",
  }),
  passed_on: pageOf("passed_on", {
    turn_id: "turn-alex-move-1",
    summary: "Turn turn-alex-move-1: the reply went out as passed on to Rosie's team.",
  }),
  hard_invariant_breach: pageOf("hard_invariant_breach", {
    business_id: null,
    summary: "A hard-invariant breach in production.",
  }),
} satisfies Record<string, Values>;

describe("team_pages: Rosie's team's rows (README rule 2)", () => {
  /** The pages the commit writes: for a harm report, a review item and a reply passed on. */
  const written = [PAGES.harm_report, PAGES.review_item, PAGES.passed_on];

  beforeAll(async () => {
    await reset();
    await loadFixtures([...SEEDS, ...POINTED_AT]);
  }, 60_000);

  it("the Tool API adds a page (the commit's write) for a harm report, a review item and a reply passed on, scoped to its business or not: each row lands, as its owner reads it", async () => {
    for (const scope of [BARBERSHOP, null]) {
      for (const values of written) {
        const landed = await as(TOOL_API, scope, async (tx) => {
          await insertRow(tx, "team_pages", values);
          await tx.unsafe("reset role");
          const [row] = await tx<{ n: number }[]>`
            select count(*)::int as n from team_pages where id = ${textOf(values.id)}
          `;
          return row?.n;
        });
        expect(landed, `${String(scope)} ${textOf(values.reason)}`).toBe(1);
      }
    }
  });

  it(
    "the Tool API reads, changes and removes none, scoped or not: select, update, delete, truncate and an insert that returns the row are refused (42501)",
    SLOW,
    async () => {
      for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
        for (const statement of [
          "select count(*) from team_pages",
          "select id from team_pages where id = 'page-alex-0204'",
          "update team_pages set version = version + 1 where id = 'page-alex-0204'",
          "delete from team_pages where id = 'page-alex-0204'",
          "truncate team_pages",
        ]) {
          const outcome = await refusal(as(TOOL_API, scope, (tx) => tx.unsafe(statement)));
          expect(outcome.code, `${String(scope)}: ${statement}`).toBe("42501");
          expect(outcome.message, `${String(scope)}: ${statement}`).toContain(
            "permission denied for table team_pages",
          );
        }
        const returning = await refusal(
          as(TOOL_API, scope, (tx) => insertReturning(tx, "team_pages", PAGES.harm_report)),
        );
        expect(returning.code, String(scope)).toBe("42501");
      }
    },
  );

  it("Rosie's team's side reads every page (no policy hides one), adds one, pages the open one again on a new clock row and acknowledges it by a console tap, raising its version; it never deletes or truncates (42501)", async () => {
    for (const scope of [null, BARBERSHOP, YOGA_STUDIO]) {
      expect(await as(RUNTIME, scope, (tx) => countRows(tx, "team_pages")), String(scope)).toBe(2);
    }
    const id = textOf(OPEN_PAGE.id);
    const work = await as(RUNTIME, null, async (tx) => {
      for (const row of TEAM) {
        await insertRow(tx, row.table, row.values);
      }
      await insertRow(tx, "team_pages", PAGES.hard_invariant_breach);
      // The 5:55pm clock row fires: the page goes a third time, and the next one is armed for 6:00pm.
      await tx`
        update clock_rows set state = 'fired', fired_at = ${textOf(OPEN_PAGE_NEXT_CLOCK.due_at)},
          version = version + 1
        where id = ${textOf(OPEN_PAGE.next_page_clock_row_id)}
      `;
      await insertRow(tx, "clock_rows", {
        ...OPEN_PAGE_NEXT_CLOCK,
        id: "clock-page-alex-0204-4",
        armed_at: OPEN_PAGE_NEXT_CLOCK.due_at ?? null,
        due_at: later(OPEN_PAGE_NEXT_CLOCK.due_at, 5),
      });
      const paged = await tx<{ times: number; version: number }[]>`
        update team_pages set times_paged = times_paged + 1, last_paged_at = ${textOf(OPEN_PAGE_NEXT_CLOCK.due_at)},
          next_page_clock_row_id = 'clock-page-alex-0204-4', version = version + 1
        where id = ${id}
        returning times_paged as times, version
      `;
      // A member of Rosie's team taps acknowledged in the team console at 5:56pm; the next page's clock row is cancelled.
      await tx`
        update clock_rows set state = 'cancelled', cancelled_at = '2026-10-26T21:56:00Z', version = version + 1
        where id = 'clock-page-alex-0204-4'
      `;
      const acknowledged = await tx<{ state: string; via: string; version: number }[]>`
        update team_pages set state = 'acknowledged', acknowledged_at = '2026-10-26T21:56:00Z',
          acknowledged_by_person_id = ${TEAM_MEMBER}, acknowledged_via = 'console_tap', version = version + 1
        where id = ${id}
        returning state, acknowledged_via as via, version
      `;
      return { pages: await countRows(tx, "team_pages"), paged, acknowledged };
    });
    expect(work).toEqual({
      pages: 3,
      paged: [{ times: 3, version: 3 }],
      acknowledged: [{ state: "acknowledged", via: "console_tap", version: 4 }],
    });
    for (const statement of ["delete from team_pages where id = 'page-alex-0204'", "truncate team_pages"]) {
      const outcome = await refusal(as(RUNTIME, null, (tx) => tx.unsafe(statement)));
      expect(outcome.code, statement).toBe("42501");
      expect(outcome.message, statement).toContain("permission denied for table team_pages");
    }
    expect(await countRows(db.sql, "team_pages")).toBe(2);
  });
});

describe("team_page_recipients: Rosie's team's own list (README rule 2)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
    await committedAs(RUNTIME, async (tx) => {
      for (const row of TEAM) {
        await insertRow(tx, row.table, row.values);
      }
    });
  }, 60_000);

  it("the Tool API holds no grant on it, scoped or not: select, insert, update, delete and truncate are refused (42501)", async () => {
    for (const scope of [BARBERSHOP, null]) {
      for (const statement of [
        "select count(*) from team_page_recipients",
        "update team_page_recipients set version = version + 1",
        "delete from team_page_recipients",
        "truncate team_page_recipients",
      ]) {
        const outcome = await refusal(as(TOOL_API, scope, (tx) => tx.unsafe(statement)));
        expect(outcome.code, `${String(scope)}: ${statement}`).toBe("42501");
        expect(outcome.message, `${String(scope)}: ${statement}`).toContain(
          "permission denied for table team_page_recipients",
        );
      }
      const inserted = await refusal(
        as(TOOL_API, scope, (tx) => insertRow(tx, "team_page_recipients", MEMBER)),
      );
      expect(inserted.code, String(scope)).toBe("42501");
    }
  });

  it("Rosie's team's side adds a member, paged in their own chat, else by email; removes them by removed_at, raising the version; the same person may join again; it never deletes or truncates (42501)", async () => {
    const work = await as(RUNTIME, null, async (tx) => {
      const added = await insertReturning(
        tx,
        "team_page_recipients",
        without(MEMBER, ["removed_at", "version"]),
      );
      const removed = await tx<{ removed: boolean; version: number }[]>`
        update team_page_recipients set removed_at = '2026-11-01T12:00:00Z', version = version + 1
        where id = ${textOf(MEMBER.id)}
        returning removed_at is not null as removed, version
      `;
      await insertRow(tx, "team_page_recipients", {
        ...MEMBER,
        id: "recipient-team-stand-in-again",
        email_handle_id: null,
        added_at: "2026-11-02T12:00:00Z",
      });
      const live = await tx<{ id: string }[]>`
        select id from team_page_recipients where removed_at is null order by id
      `;
      return {
        added: [added.removed_at, added.version],
        removed,
        live: live.map((row) => row.id),
        all: await countRows(tx, "team_page_recipients"),
      };
    });
    expect(work).toEqual({
      added: [null, 1],
      removed: [{ removed: true, version: 2 }],
      live: ["recipient-team-stand-in-again"],
      all: 2,
    });
    for (const statement of ["delete from team_page_recipients", "truncate team_page_recipients"]) {
      const outcome = await refusal(as(RUNTIME, null, (tx) => tx.unsafe(statement)));
      expect(outcome.code, statement).toBe("42501");
      expect(outcome.message, statement).toContain("permission denied for table team_page_recipients");
    }
  });
});

/** Alex's threat to Riley handed to Sam again under new ids, on a clock row of its own (one clock row per hand-off). */
const handOffClock: FixtureRow = {
  table: "clock_rows",
  values: {
    ...THREAT_CLOCK,
    id: "clock-handoff-rule-base",
    fires: { job: "hand-off-escalation", handOff: "handoff-rule-base" },
  },
};
const handOff: Values = {
  ...THREAT_HAND_OFF,
  id: "handoff-rule-base",
  escalation_clock_row_id: "clock-handoff-rule-base",
};
const handedAt = textOf(THREAT_HAND_OFF.handed_at);

describe("row-level security on hand_offs (README rule 2)", () => {
  /** Sam's console answer to Alex's emergency, 20 minutes after it was handed off (the owner's late answer). */
  const answer = (tx: Tx) => tx<{ version: number }[]>`
    update hand_offs set answered_at = ${later(EMERGENCY_HAND_OFF.handed_at, 20)}, answered_via = 'console_tap',
      answered_by_person_id = 'person-sam', version = version + 1
    where id = ${textOf(EMERGENCY_HAND_OFF.id)}
    returning version
  `;

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
    // The clock row a new hand-off below uses, written first so each write is the hand-off's alone.
    await committedAs(RUNTIME, (tx) => insertRow(tx, handOffClock.table, handOffClock.values));
  }, 60_000);

  it("the rows: Lee's Barbershop's two hand-offs; none for the yoga studio or the movers", async () => {
    expect(await ownerCount("hand_offs", BARBERSHOP)).toBe(2);
    expect(await ownerCount("hand_offs", YOGA_STUDIO)).toBe(0);
    expect(await ownerCount("hand_offs", MOVERS)).toBe(0);
  });

  it("the Tool API with no scope reads no hand-off", async () => {
    expect(await countRows(db.sql, "hand_offs")).toBe(2);
    expect(await as(TOOL_API, null, (tx) => countRows(tx, "hand_offs"))).toBe(0);
  });

  it("the Tool API scoped to a business reads exactly that business's hand-offs", async () => {
    for (const business of [BARBERSHOP, YOGA_STUDIO, MOVERS]) {
      expect(await as(TOOL_API, business, (tx) => countRows(tx, "hand_offs")), business).toBe(
        await ownerCount("hand_offs", business),
      );
    }
  });

  it("the runtime side with no scope reads every hand-off (the clock that escalates one); with a scope set, only that business's", async () => {
    expect(await as(RUNTIME, null, (tx) => countRows(tx, "hand_offs"))).toBe(2);
    for (const business of [BARBERSHOP, YOGA_STUDIO]) {
      expect(await as(RUNTIME, business, (tx) => countRows(tx, "hand_offs")), business).toBe(
        await ownerCount("hand_offs", business),
      );
    }
  });

  it("writes under a scope: only the scope's own business; another business, or no scope for the Tool API, is refused (42501)", async () => {
    expect(await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "hand_offs", handOff))).toMatchObject({
      id: handOff.id,
      business_id: BARBERSHOP,
    });
    for (const scope of [YOGA_STUDIO, null]) {
      const refused = await refusal(as(TOOL_API, scope, (tx) => insertRow(tx, "hand_offs", handOff)));
      expect(refused.code, String(scope)).toBe("42501");
    }
    expect((await refusal(as(RUNTIME, YOGA_STUDIO, (tx) => insertRow(tx, "hand_offs", handOff)))).code).toBe(
      "42501",
    );
    expect(await as(RUNTIME, null, (tx) => insertReturning(tx, "hand_offs", handOff))).toMatchObject({
      id: handOff.id,
    });
  });

  it("Sam's console answer: from another business's scope it finds no row; from his own it lands, raising the version", async () => {
    for (const role of ROLES) {
      expect(await as(role, YOGA_STUDIO, answer), role).toEqual([]);
      expect(await as(role, BARBERSHOP, answer), role).toEqual([{ version: 3 }]);
    }
    expect(await as(TOOL_API, null, answer)).toEqual([]);
  });

  it("no role deletes or truncates a row of any K-36 table, scoped or not (42501)", SLOW, async () => {
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
    await loadFixtures([...SEEDS, ...POINTED_AT]);
  }, 60_000);

  /** Inserts `values` into `table` as the runtime side with no scope, after `before`, then rolls back. */
  const tried = (
    table: string,
    values: Values,
    before: readonly FixtureRow[] = [],
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
    before: readonly FixtureRow[] = [],
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(tried(table, values, before));
    return [outcome.code, outcome.constraint];
  };

  const handOffBefore = [handOffClock];
  /** Alex's emergency handed to Sam again under new ids, on a clock row of its own. */
  const emergencyClock: FixtureRow = {
    table: "clock_rows",
    values: {
      ...EMERGENCY_CLOCK,
      id: "clock-handoff-rule-emergency",
      fires: { job: "hand-off-escalation", handOff: "handoff-rule-emergency" },
    },
  };
  const emergency: Values = {
    ...EMERGENCY_HAND_OFF,
    id: "handoff-rule-emergency",
    escalation_clock_row_id: "clock-handoff-rule-emergency",
  };
  /** Alex's crisis words after booking (K-34's seed-outcome-crisis) told to Sam: Rosie's team at once, no clock row. */
  const crisisAt = "2026-10-25T23:10:02Z";
  const crisis: Values = {
    ...handOff,
    kind: "crisis_words",
    safety_outcome_id: "safety-alex-0203",
    turn_id: "turn-alex-0203",
    booking_id: "booking-alex-haircut",
    summary: "Urgent: a customer may need help.",
    handed_at: crisisAt,
    escalate_at: crisisAt,
    escalation_clock_row_id: null,
    escalated_at: crisisAt,
  };
  /** Any other hand-off: told to Sam in text hours; Rosie's team after 2 days unanswered (S11-19). */
  const other: Values = {
    ...handOff,
    kind: "other",
    safety_outcome_id: null,
    booking_id: "booking-alex-haircut",
    summary: "A question about booking-alex-haircut that Rosie could not answer.",
    escalate_at: later(handedAt, 2 * DAY),
    escalated_at: null,
  };
  /** Sam's answer 3 minutes after the alert, before anyone else is paged. */
  const answered = (via: string): Values => ({
    answered_at: later(handedAt, 3),
    answered_via: via,
    answered_by_person_id: "person-sam",
    escalated_at: null,
  });

  it(
    "hand_offs: each kind as arch 06 line 329 tells it, told to the owner or to whoever they named, answered by a reply or a console tap",
    SLOW,
    async () => {
      expect(await tried("hand_offs", handOff, handOffBefore)).toMatchObject({
        kind: "threat",
        told_as: "owner",
        answered_at: null,
      });
      expect(await tried("hand_offs", emergency, [emergencyClock])).toMatchObject({ kind: "emergency" });
      expect(await tried("hand_offs", crisis)).toMatchObject({
        kind: "crisis_words",
        escalation_clock_row_id: null,
      });
      for (const days of [2, 3]) {
        expect(
          await tried("hand_offs", { ...other, escalate_at: later(handedAt, days * DAY) }, handOffBefore),
          `${String(days)} days`,
        ).toMatchObject({ kind: "other", safety_outcome_id: null });
      }
      expect(
        await tried(
          "hand_offs",
          { ...handOff, told_person_id: "person-pat", told_as: "named" },
          handOffBefore,
        ),
      ).toMatchObject({ told_person_id: "person-pat", told_as: "named" });
      for (const via of ["reply", "console_tap"]) {
        expect(await tried("hand_offs", { ...handOff, ...answered(via) }, handOffBefore), via).toMatchObject({
          answered_via: via,
          answered_by_person_id: "person-sam",
        });
      }
      // Answered the moment it was handed off; left out, the version is 1.
      expect(
        await tried("hand_offs", { ...handOff, ...answered("reply"), answered_at: handedAt }, handOffBefore),
      ).toMatchObject({ answered_via: "reply" });
      expect(await tried("hand_offs", without(handOff, ["version"]), handOffBefore)).toMatchObject({
        version: 1,
      });
    },
  );

  it(
    "hand_offs: the kind, who was told as, and a safety read for each safety kind but none for any other hand-off",
    SLOW,
    async () => {
      // Harm to a child or an older adult never goes to the owner: it is a K-34 harm report.
      expect(
        await refusedBy("hand_offs", { ...handOff, kind: "harm_to_child_or_elder" }, handOffBefore),
      ).toEqual(["23514", "hand_offs_kind_known"]);
      expect(await refusedBy("hand_offs", { ...handOff, told_as: "staff" }, handOffBefore)).toEqual([
        "23514",
        "hand_offs_told_as_known",
      ]);
      for (const [base, before] of [
        [handOff, handOffBefore],
        [emergency, [emergencyClock]],
        [crisis, []],
      ] as const) {
        expect(
          await refusedBy("hand_offs", { ...base, safety_outcome_id: null }, before),
          textOf(base.kind),
        ).toEqual(["23514", "hand_offs_safety_kind_has_outcome"]);
      }
      expect(
        await refusedBy("hand_offs", { ...other, safety_outcome_id: "safety-alex-0204" }, handOffBefore),
      ).toEqual(["23514", "hand_offs_safety_kind_has_outcome"]);
    },
  );

  it(
    "hand_offs: when Rosie's team is paged: crisis words at once with no clock row; an emergency or a threat at exactly 5 minutes, on a clock row; any other hand-off no sooner than 2 days, on a clock row; never before it is due",
    SLOW,
    async () => {
      // Crisis words 5 minutes late (escalated then), or a minute before they were handed off.
      for (const minutes of [5, -1]) {
        expect(
          await refusedBy("hand_offs", {
            ...crisis,
            escalate_at: later(crisisAt, minutes),
            escalated_at: later(crisisAt, Math.max(minutes, 0)),
          }),
          `${String(minutes)} minutes`,
        ).toEqual(["23514", "hand_offs_crisis_words_at_once"]);
      }
      for (const [base, before] of [
        [handOff, handOffBefore],
        [emergency, [emergencyClock]],
      ] as const) {
        for (const minutes of [4, 10]) {
          const at = later(base.handed_at, minutes);
          expect(
            await refusedBy("hand_offs", { ...base, escalate_at: at, escalated_at: at }, before),
            `${textOf(base.kind)} at ${String(minutes)} minutes`,
          ).toEqual(["23514", "hand_offs_emergency_threat_five_minutes"]);
        }
      }
      for (const minutes of [DAY, 2 * DAY - 1]) {
        expect(
          await refusedBy("hand_offs", { ...other, escalate_at: later(handedAt, minutes) }, handOffBefore),
          `${String(minutes)} minutes`,
        ).toEqual(["23514", "hand_offs_other_two_days"]);
      }
      const unclocked: Values[] = [
        { ...handOff, escalation_clock_row_id: null },
        { ...other, escalation_clock_row_id: null },
      ];
      for (const fault of unclocked) {
        expect(await refusedBy("hand_offs", fault), textOf(fault.kind)).toEqual([
          "23514",
          "hand_offs_clock_unless_at_once",
        ]);
      }
      expect(
        await refusedBy(
          "hand_offs",
          { ...crisis, escalation_clock_row_id: "clock-handoff-rule-base" },
          handOffBefore,
        ),
      ).toEqual(["23514", "hand_offs_clock_unless_at_once"]);
      expect(
        await refusedBy("hand_offs", { ...handOff, escalated_at: later(handedAt, 4) }, handOffBefore),
      ).toEqual(["23514", "hand_offs_escalated_when_due"]);
    },
  );

  it(
    "hand_offs: the answer: a reply or a console tap; when, how and by whom together; never before the hand-off",
    SLOW,
    async () => {
      expect(await refusedBy("hand_offs", { ...handOff, ...answered("phone_call") }, handOffBefore)).toEqual([
        "23514",
        "hand_offs_answered_via_known",
      ]);
      const reply = answered("reply");
      for (const column of ANSWER) {
        expect(
          await refusedBy("hand_offs", { ...handOff, ...reply, [column]: null }, handOffBefore),
          `${column} missing`,
        ).toEqual(["23514", "hand_offs_answered_together"]);
        expect(
          await refusedBy("hand_offs", { ...handOff, [column]: reply[column] ?? null }, handOffBefore),
          `${column} alone`,
        ).toEqual(["23514", "hand_offs_answered_together"]);
      }
      expect(
        await refusedBy(
          "hand_offs",
          { ...handOff, ...reply, answered_at: later(handedAt, -1) },
          handOffBefore,
        ),
      ).toEqual(["23514", "hand_offs_answered_after_handed"]);
    },
  );

  it(
    "hand_offs: each foreign key refuses an id its table does not hold (23503); one hand-off per clock row, and the id, unique (23505)",
    SLOW,
    async () => {
      for (const [fault, constraint] of [
        [{ business_id: "biz-none" }, "hand_offs_business_fk"],
        [{ safety_outcome_id: "safety-none" }, "hand_offs_safety_outcome_fk"],
        [{ turn_id: "turn-none" }, "hand_offs_turn_fk"],
        [{ booking_id: "booking-none" }, "hand_offs_booking_fk"],
        [{ about_person_id: "person-none" }, "hand_offs_about_person_fk"],
        [{ told_person_id: "person-none" }, "hand_offs_told_person_fk"],
        [{ alert_outbox_row_id: "out-none" }, "hand_offs_alert_outbox_fk"],
        [{ escalation_clock_row_id: "clock-none" }, "hand_offs_clock_fk"],
        [{ ...answered("reply"), answered_by_person_id: "person-none" }, "hand_offs_answered_by_fk"],
      ] as const) {
        expect(await refusedBy("hand_offs", { ...handOff, ...fault }, handOffBefore), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      // A second hand-off on the seeded hand-off's clock row, and a second row under the seed's id.
      expect(
        await refusedBy("hand_offs", {
          ...handOff,
          escalation_clock_row_id: THREAT_HAND_OFF.escalation_clock_row_id ?? null,
        }),
      ).toEqual(["23505", "hand_offs_clock_key"]);
      expect(
        await refusedBy("hand_offs", { ...handOff, id: THREAT_HAND_OFF.id ?? null }, handOffBefore),
      ).toEqual(["23505", "hand_offs_pkey"]);
    },
  );

  /** The open page again under new ids, for the hand-off above (one page per hand-off), on a next clock row of its own. */
  const pageClock: FixtureRow = {
    table: "clock_rows",
    values: {
      ...OPEN_PAGE_NEXT_CLOCK,
      id: "clock-page-rule-base",
      fires: { job: "team-page", page: "page-rule-base" },
    },
  };
  const withHandOff: FixtureRow[] = [handOffClock, { table: "hand_offs", values: handOff }];
  const pageBefore = [...withHandOff, pageClock];
  const page: Values = {
    ...OPEN_PAGE,
    id: "page-rule-base",
    hand_off_id: "handoff-rule-base",
    next_page_clock_row_id: "clock-page-rule-base",
  };
  const openedAt = textOf(OPEN_PAGE.opened_at);
  /** The page Pat acknowledged, again under new ids, for the emergency above, its next clock row cancelled. */
  const acknowledgedClock: FixtureRow = {
    table: "clock_rows",
    values: {
      ...CANCELLED_CLOCK,
      id: "clock-page-rule-acknowledged",
      fires: { job: "team-page", page: "page-rule-acknowledged" },
    },
  };
  const acknowledgedBefore = [emergencyClock, { table: "hand_offs", values: emergency }, acknowledgedClock];
  const acknowledged: Values = {
    ...ACKNOWLEDGED_PAGE,
    id: "page-rule-acknowledged",
    hand_off_id: "handoff-rule-emergency",
    next_page_clock_row_id: "clock-page-rule-acknowledged",
  };

  it(
    "team_pages: a page for each reason, each at its one row; paged once and waiting, or repeating every 5 minutes; acknowledged by a reply or a console tap",
    SLOW,
    async () => {
      expect(await tried("team_pages", page, pageBefore)).toMatchObject({
        reason: "hand_off",
        state: "open",
        times_paged: 2,
        repeat_minutes: 5,
      });
      for (const [reason, values] of Object.entries(PAGES)) {
        expect(await tried("team_pages", values), reason).toMatchObject({
          reason,
          times_paged: 1,
          repeat_minutes: null,
        });
      }
      // Which other reasons repeat is code's (README open gaps): a harm report's page may repeat too.
      expect(
        await tried(
          "team_pages",
          {
            ...PAGES.harm_report,
            times_paged: 2,
            last_paged_at: later(openedAt, 5),
            repeat_minutes: 5,
            next_page_clock_row_id: "clock-page-rule-base",
          },
          [pageClock],
        ),
      ).toMatchObject({ reason: "harm_report", repeat_minutes: 5 });
      for (const via of ["reply", "console_tap"]) {
        expect(
          await tried("team_pages", { ...acknowledged, acknowledged_via: via }, acknowledgedBefore),
          via,
        ).toMatchObject({ state: "acknowledged", acknowledged_via: via });
      }
      // Acknowledged at the moment of the last page; a page paged once may be acknowledged with no clock row.
      expect(
        await tried(
          "team_pages",
          { ...acknowledged, acknowledged_at: acknowledged.last_paged_at ?? null },
          acknowledgedBefore,
        ),
      ).toMatchObject({ state: "acknowledged" });
      expect(
        await tried(
          "team_pages",
          {
            ...PAGES.passed_on,
            state: "acknowledged",
            acknowledged_at: later(openedAt, 30),
            acknowledged_by_person_id: TEAM_MEMBER,
            acknowledged_via: "console_tap",
          },
          TEAM,
        ),
      ).toMatchObject({ state: "acknowledged", next_page_clock_row_id: null });
      // Left out, a page is open, paged once, at version 1.
      expect(
        await tried("team_pages", without(PAGES.owner_cannot_act, ["times_paged", "state", "version"])),
      ).toMatchObject({ state: "open", times_paged: 1, version: 1 });
    },
  );

  it(
    "team_pages: the reason, and each reason's one pointer: a hand-off, a harm report, a review item, a safety timer, a turn passed on, a business for owner silence; whoever the owner named only on a hand-off's page",
    SLOW,
    async () => {
      expect(await refusedBy("team_pages", { ...PAGES.hard_invariant_breach, reason: "outage" })).toEqual([
        "23514",
        "team_pages_reason_known",
      ]);
      expect(await refusedBy("team_pages", { ...page, hand_off_id: null }, pageBefore)).toEqual([
        "23514",
        "team_pages_hand_off_pointer",
      ]);
      expect(
        await refusedBy("team_pages", { ...PAGES.passed_on, hand_off_id: "handoff-rule-base" }, withHandOff),
      ).toEqual(["23514", "team_pages_hand_off_pointer"]);
      for (const [base, column, value, constraint] of [
        [PAGES.harm_report, "harm_report_id", "harm-alex-about-staff", "team_pages_harm_report_pointer"],
        [
          PAGES.review_item,
          "review_item_id",
          "review-harm-report-barbershop",
          "team_pages_review_item_pointer",
        ],
        [PAGES.safety_timer_missed, "safety_timer_id", "timer-sam-survey", "team_pages_safety_timer_pointer"],
      ] as const) {
        expect(await refusedBy("team_pages", { ...base, [column]: null }), `${column} missing`).toEqual([
          "23514",
          constraint,
        ]);
        expect(
          await refusedBy("team_pages", { ...PAGES.owner_cannot_act, [column]: value }),
          `${column} on another reason`,
        ).toEqual(["23514", constraint]);
      }
      expect(await refusedBy("team_pages", { ...PAGES.passed_on, turn_id: null })).toEqual([
        "23514",
        "team_pages_passed_on_has_turn",
      ]);
      expect(await refusedBy("team_pages", { ...PAGES.owner_cannot_act, business_id: null })).toEqual([
        "23514",
        "team_pages_owner_cannot_act_has_business",
      ]);
      expect(await refusedBy("team_pages", { ...PAGES.harm_report, named_person_id: "person-pat" })).toEqual([
        "23514",
        "team_pages_named_only_for_hand_off",
      ]);
    },
  );

  it(
    "team_pages: a repeat only every 5 minutes; how many times and when it was paged, in order; the state; an open repeating page always names its next clock row",
    SLOW,
    async () => {
      for (const repeat_minutes of [10, 1]) {
        expect(
          await refusedBy("team_pages", { ...page, repeat_minutes }, pageBefore),
          String(repeat_minutes),
        ).toEqual(["23514", "team_pages_repeat_every_five"]);
      }
      for (const fault of [{ times_paged: 0 }, { repeat_minutes: null }]) {
        expect(
          await refusedBy("team_pages", { ...page, ...fault }, pageBefore),
          JSON.stringify(fault),
        ).toEqual(["23514", "team_pages_times_paged"]);
      }
      expect(
        await refusedBy("team_pages", { ...PAGES.owner_cannot_act, last_paged_at: later(openedAt, -1) }),
      ).toEqual(["23514", "team_pages_last_paged_in_order"]);
      expect(await refusedBy("team_pages", { ...page, last_paged_at: openedAt }, pageBefore)).toEqual([
        "23514",
        "team_pages_last_paged_in_order",
      ]);
      expect(await refusedBy("team_pages", { ...page, state: "closed" }, pageBefore)).toEqual([
        "23514",
        "team_pages_state_known",
      ]);
      expect(await refusedBy("team_pages", { ...page, next_page_clock_row_id: null }, pageBefore)).toEqual([
        "23514",
        "team_pages_open_repeat_has_clock",
      ]);
    },
  );

  it(
    "team_pages: the acknowledgement: a reply or a console tap; state, when, who and how together; never before the last page",
    SLOW,
    async () => {
      expect(
        await refusedBy(
          "team_pages",
          { ...acknowledged, acknowledged_via: "phone_call" },
          acknowledgedBefore,
        ),
      ).toEqual(["23514", "team_pages_acknowledged_via_known"]);
      expect(await refusedBy("team_pages", { ...page, state: "acknowledged" }, pageBefore)).toEqual([
        "23514",
        "team_pages_acknowledged_together",
      ]);
      for (const fault of [
        { state: "open" },
        { acknowledged_at: null },
        { acknowledged_by_person_id: null },
        { acknowledged_via: null },
      ]) {
        expect(
          await refusedBy("team_pages", { ...acknowledged, ...fault }, acknowledgedBefore),
          JSON.stringify(fault),
        ).toEqual(["23514", "team_pages_acknowledged_together"]);
      }
      expect(
        await refusedBy(
          "team_pages",
          { ...acknowledged, acknowledged_at: later(acknowledged.last_paged_at, -1) },
          acknowledgedBefore,
        ),
      ).toEqual(["23514", "team_pages_acknowledged_after_paged"]);
    },
  );

  it(
    "team_pages: each foreign key refuses an id its table does not hold (23503); one page per hand-off, one per clock row, and the id, unique (23505)",
    SLOW,
    async () => {
      for (const [values, before, constraint] of [
        [{ ...PAGES.owner_cannot_act, business_id: "biz-none" }, [], "team_pages_business_fk"],
        [{ ...page, hand_off_id: "handoff-none" }, [pageClock], "team_pages_hand_off_fk"],
        [{ ...PAGES.harm_report, harm_report_id: "harm-none" }, [], "team_pages_harm_report_fk"],
        [{ ...PAGES.review_item, review_item_id: "review-none" }, [], "team_pages_review_item_fk"],
        [{ ...PAGES.safety_timer_missed, safety_timer_id: "timer-none" }, [], "team_pages_safety_timer_fk"],
        [{ ...PAGES.passed_on, turn_id: "turn-none" }, [], "team_pages_turn_fk"],
        [{ ...page, named_person_id: "person-none" }, pageBefore, "team_pages_named_person_fk"],
        [{ ...page, next_page_clock_row_id: "clock-none" }, withHandOff, "team_pages_clock_fk"],
        [
          { ...acknowledged, acknowledged_by_person_id: "person-none" },
          acknowledgedBefore,
          "team_pages_acknowledged_by_fk",
        ],
      ] as const) {
        expect(await refusedBy("team_pages", values, [...before]), constraint).toEqual(["23503", constraint]);
      }
      // A second page for the seeded threat's hand-off, one on the open page's next clock row, one under its id.
      expect(
        await refusedBy("team_pages", { ...page, hand_off_id: OPEN_PAGE.hand_off_id ?? null }, [pageClock]),
      ).toEqual(["23505", "team_pages_one_per_hand_off"]);
      expect(
        await refusedBy(
          "team_pages",
          { ...page, next_page_clock_row_id: OPEN_PAGE.next_page_clock_row_id ?? null },
          withHandOff,
        ),
      ).toEqual(["23505", "team_pages_clock_key"]);
      expect(await refusedBy("team_pages", { ...page, id: OPEN_PAGE.id ?? null }, pageBefore)).toEqual([
        "23505",
        "team_pages_pkey",
      ]);
    },
  );

  it(
    "team_page_recipients: reached in their own chat, by email or both, but somehow; removed no earlier than added; each foreign key (23503); one live row per person, and the id, unique (23505)",
    SLOW,
    async () => {
      for (const reach of [{}, { email_handle_id: null }, { chat_handle_id: null }]) {
        expect(
          await tried("team_page_recipients", { ...MEMBER, ...reach }, TEAM),
          JSON.stringify(reach),
        ).toMatchObject({ person_id: TEAM_MEMBER, removed_at: null });
      }
      expect(
        await refusedBy(
          "team_page_recipients",
          { ...MEMBER, chat_handle_id: null, email_handle_id: null },
          TEAM,
        ),
      ).toEqual(["23514", "team_page_recipients_reachable"]);
      expect(
        await refusedBy("team_page_recipients", { ...MEMBER, removed_at: later(MEMBER.added_at, -1) }, TEAM),
      ).toEqual(["23514", "team_page_recipients_removed_after_added"]);
      expect(
        await tried("team_page_recipients", { ...MEMBER, removed_at: MEMBER.added_at ?? null }, TEAM),
      ).toMatchObject({ id: MEMBER.id });
      for (const [fault, constraint] of [
        [{ person_id: "person-none" }, "team_page_recipients_person_fk"],
        [{ chat_handle_id: "handle-none" }, "team_page_recipients_chat_handle_fk"],
        [{ email_handle_id: "handle-none" }, "team_page_recipients_email_handle_fk"],
      ] as const) {
        expect(await refusedBy("team_page_recipients", { ...MEMBER, ...fault }, TEAM), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      // Two live rows for the stand-in; then the stand-in removed, and a second row under the removed row's id.
      const removed: FixtureRow = {
        table: "team_page_recipients",
        values: { ...MEMBER, removed_at: "2026-10-20T12:00:00Z" },
      };
      expect(
        await refusedBy("team_page_recipients", { ...MEMBER, id: "recipient-team-stand-in-2" }, [
          ...TEAM,
          { table: "team_page_recipients", values: MEMBER },
        ]),
      ).toEqual(["23505", "team_page_recipients_one_live_per_person"]);
      expect(
        await tried("team_page_recipients", { ...MEMBER, id: "recipient-team-stand-in-2" }, [
          ...TEAM,
          removed,
        ]),
      ).toMatchObject({ removed_at: null });
      expect(await refusedBy("team_page_recipients", MEMBER, [...TEAM, removed])).toEqual([
        "23505",
        "team_page_recipients_pkey",
      ]);
    },
  );

  /** One row per table, as the fixtures give it under new ids, with what must exist before it. */
  const BASES: Record<string, { values: Values; before: FixtureRow[] }> = {
    hand_offs: { values: handOff, before: handOffBefore },
    team_pages: { values: page, before: pageBefore },
    team_page_recipients: { values: MEMBER, before: TEAM },
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
    "all three tables: an update must raise the version by exactly one (<table>_version_raised, 23514)",
    SLOW,
    async () => {
      const cases: [string, string, FixtureRow[], number][] = [
        ["hand_offs", textOf(THREAT_HAND_OFF.id), [], Number(THREAT_HAND_OFF.version)],
        ["team_pages", textOf(OPEN_PAGE.id), [], Number(OPEN_PAGE.version)],
        [
          "team_page_recipients",
          textOf(MEMBER.id),
          [...TEAM, { table: "team_page_recipients", values: MEMBER }],
          Number(MEMBER.version),
        ],
      ];
      expect(cases.map(([table]) => table).sort()).toEqual(OWN_TABLES);
      for (const [table, id, before, version] of cases) {
        const bump = (raise: number) => async (tx: Tx) => {
          for (const row of before) {
            await insertRow(tx, row.table, row.values);
          }
          return tx<{ version: number }[]>`
            update ${tx(table)} set version = version + ${raise} where id = ${id} returning version
          `;
        };
        for (const raise of [0, 2]) {
          const refused = await refusal(as(RUNTIME, null, bump(raise)));
          expect([refused.code, refused.constraint], `${table} raised by ${String(raise)}`).toEqual([
            "23514",
            `${table}_version_raised`,
          ]);
        }
        expect(await as(RUNTIME, null, bump(1)), table).toEqual([{ version: version + 1 }]);
      }
    },
  );
});
