// T-193: the platform and review part (K-37 v1: parked_turns, dead_letters, gap_cases, review_items and
// live_turn_labels) against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/review`). The
// schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables. A check made as the Tool API (rosie_app, K-05
// scope business) or the runtime side (rosie_job: the runtime's crash handling and queues, and the team console until
// K-21 names its role) runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped,
// and is rolled back. Seed fixtures are loaded the same way, as the runtime side (K-04's fixture format), and committed.
// Rosie's team has no member in the sample cast (K-37 open gaps), so a reply, a replay, a review, a decision or a label
// here is made by a stand-in persons row with no name and no role, written in the same rolled-back transaction.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/platform-review/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const OWN_TABLES = ["dead_letters", "gap_cases", "live_turn_labels", "parked_turns", "review_items"];
const BARBERSHOP = "biz-lees-barbershop";
/** A stand-in for a person on Rosie's team: a persons row with no name and no role (K-37 open gaps). */
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

const TABLES = (readJson(new URL("platform-review.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`${name} is not in K-37's table list`);
  }
  return table;
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** A fixture's own rows of one table, in order. */
const rowsOf = (file: string, table: string): FixtureRow[] =>
  fixtureFile(file).rows.filter((row) => row.table === table);

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
 * file that names it, so K-37's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** A fixture value as text: a string as it is, anything else as JSON. */
const text = (value: Json | undefined): string => (typeof value === "string" ? value : JSON.stringify(value));

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

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

/** The SQLSTATE, constraint and message of a refused statement. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string };
    return { code: failure.code, constraint: failure.constraint_name, message: failure.message ?? "" };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

/** A row's values as the database takes them: JSON for a jsonb column, bytes for a bytea one (`\x` and hex). */
function columnValues(tx: Tx, table: string, values: Values): Record<string, never> {
  const converted: Record<string, never> = {};
  for (const [column, value] of Object.entries(values)) {
    const type = typeOf.get(`${table}.${column}`);
    let out: unknown = value;
    if (type === "jsonb" && value !== null) {
      out = tx.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      out = fromHex(value.replace(/^\\x/, ""));
    }
    converted[column] = out as never;
  }
  return converted;
}

async function insertRow(tx: Tx, table: string, values: Values): Promise<void> {
  await tx`insert into ${tx(table)} ${tx(columnValues(tx, table, values))}`;
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
  await db.sql`truncate businesses, persons, handles, bundles cascade`;
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
  const id = text(row.values[key]);
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

/** A table's primary key values, in order. */
async function keysOf(table: string): Promise<string[]> {
  const key = tableOf(table).primaryKey[0] ?? "id";
  const rows = await db.sql<{ key: string }[]>`
    select ${db.sql(key)} as key from ${db.sql(table)} order by 1
  `;
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
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE INDEX \S+ ON \S+ /, "")]),
    ),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "review" });
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

describe("the migration against the frozen table list (K-37 v1 platform and review)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    "text[]": "ARRAY",
    integer: "integer",
    jsonb: "jsonb",
    bytea: "bytea",
    date: "date",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names five tables, none scoped by business, each versioned on its version column", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(table.rowLevelSecurity.scope, table.name).toBe("none");
      expect([table.versioned, table.versionColumn], table.name).toEqual([true, "version"]);
    }
  });

  for (const table of TABLES) {
    it(`${table.name}: columns, types, nulls and defaults are the table list's`, async () => {
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

    it(`${table.name}: primary key, foreign keys and their on delete, unique rules and index names are the table list's`, async () => {
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
      expect(await definitionsOf(db.sql, table.name)).toEqual(listed);
    });
  }

  it("the two sealed columns hold bytes, each sealed under the key of the person its row names (K-37 rule 4)", async () => {
    const sealed = TABLES.flatMap((table) =>
      table.columns.flatMap((column) =>
        column.sealedBy === undefined
          ? []
          : [{ table: table.name, column: column.name, by: column.sealedBy }],
      ),
    );
    expect(sealed).toEqual([
      { table: "gap_cases", column: "summary_sealed", by: "sealed_for_person_id" },
      { table: "live_turn_labels", column: "label_sealed", by: "sealed_for_person_id" },
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

  it("each table raises its version on every update (0002's rule): <table>_version_raised, and no other trigger", async () => {
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

  it("row-level security is off and not forced on all five, with no policy: scope none, Rosie's team only by privilege (K-37 rule 2)", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: false, forced: false })));
    const policies = await db.sql<{ name: string }[]>`
      select policyname as name from pg_policies where schemaname = ${db.schema} and tablename in ${db.sql(OWN_TABLES)}
    `;
    expect(policies).toEqual([]);
  });

  it("grants: rosie_job selects, inserts and updates each table; rosie_app and PUBLIC hold nothing on any", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    expect(held).toEqual(
      OWN_TABLES.flatMap((table) =>
        ["INSERT", "SELECT", "UPDATE"].map((privilege) => ({ role: RUNTIME, table, privilege })),
      ),
    );
    const others = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee <> c.relowner and a.grantee <> ${RUNTIME}::regrole
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

  it("is recorded in schema_migrations as platform_review, after consent", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("platform_review");
    expect(names.indexOf("platform_review")).toBeGreaterThan(names.indexOf("consent"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the four of 02-contracts' K-37 row, and the fifth", () => {
  it("the index lists the four seeds, the fifth that gives live_turn_labels a row, and two refused rows, all K-37 v1", () => {
    expect([...SEEDS].sort()).toEqual([
      "seed-dead-letter.json",
      "seed-gap-case.json",
      "seed-live-turn-label.json",
      "seed-parked-turn.json",
      "seed-review-item.json",
    ]);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual(["invalid/refuse-dead-letter-early.json", "invalid/refuse-review-item-tool-api-read.json"]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} loads alone with its after chain, as the runtime side, and every K-37 row is stored as given`,
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

  it("all five load together, each after chain once: every K-37 table has rows", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual({
      dead_letters: 2,
      gap_cases: 1,
      live_turn_labels: 1,
      parked_turns: 1,
      review_items: 5,
    });
    expect(await keysOf("parked_turns")).toEqual(["turn-riley-done-1"]);
    expect(await keysOf("dead_letters")).toEqual([
      "dl-calendar-poll-riley-2026-10-23",
      "dl-reconcile-2026-11-03",
    ]);
    expect(await keysOf("gap_cases")).toEqual(["turn-alex-gift-card"]);
    expect(await keysOf("review_items")).toEqual([
      "review-booking-cap-barbershop",
      "review-control-movers",
      "review-harm-report-barbershop",
      "review-missed-deadline-barbershop",
      "review-new-work-barbershop",
    ]);
    expect(await keysOf("live_turn_labels")).toEqual(["turn-alex-move-1"]);
  });
});

describe("the seeded rows, all five seeds loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("the parked turn's core row is parked after its 3 tries, written once (NQ-RT-3); the team's record is open", async () => {
    const [turn] = await db.sql<{ state: string; tries: number; parked: boolean; committed: boolean }[]>`
      select state, tries, parked_at is not null as parked, committed_at is not null as committed
      from turns where id = 'turn-riley-done-1'
    `;
    expect(turn).toEqual({ state: "parked", tries: 3, parked: true, committed: false });
    const [record] = await db.sql<{ state: string; told: boolean; replied: boolean }[]>`
      select state, person_told_at is not null as told, replied_at is not null as replied
      from parked_turns where turn_id = 'turn-riley-done-1'
    `;
    expect(record).toEqual({ state: "open", told: true, replied: false });
  });

  it("the gap case keeps its state and frontier as references, and its summary only sealed, under Alex's key", async () => {
    const [gap] = await db.sql<
      {
        outcome: string;
        questions: string[];
        read: unknown;
        frontier: { choiceId: string; kind: string; step: string }[];
        sealed: Uint8Array | null;
        by: string;
      }[]
    >`
      select outcome, open_question_ids as questions, versions_read as read, frontier,
             summary_sealed as sealed, sealed_for_person_id as by
      from gap_cases where turn_id = 'turn-alex-gift-card'
    `;
    expect(gap).toMatchObject({
      outcome: "log_gap",
      questions: [],
      read: [{ table: "businesses", rowId: BARBERSHOP, version: 3 }],
      by: "person-alex",
    });
    expect(gap?.frontier.map((choice) => [choice.choiceId, choice.kind, choice.step])).toEqual([
      ["c-05", "anytime", "A3-22"],
    ]);
    expect(gap?.sealed).toBeInstanceOf(Uint8Array);
  });

  it("the team console's reads: each queue in its order, each able to use its partial index", async () => {
    const read = (query: string, index: string): Promise<{ ids: string[]; usesIndex: boolean }> =>
      asOwner(async (tx) => {
        const rows = await tx.unsafe<{ id: string }[]>(query);
        // With sequential scans priced out, the planner shows which index can serve the read.
        await tx`set local enable_seqscan = off`;
        const [plan] = await tx.unsafe<{ "QUERY PLAN": unknown }[]>(`explain (format json) ${query}`);
        return {
          ids: rows.map((row) => row.id),
          usesIndex: JSON.stringify(plan?.["QUERY PLAN"]).includes(`"Index Name":"${index}"`),
        };
      });
    expect(
      await read(
        "select id from review_items where state <> 'done' order by due_at",
        "review_items_queue_idx",
      ),
    ).toEqual({
      ids: [
        "review-new-work-barbershop",
        "review-control-movers",
        "review-harm-report-barbershop",
        "review-booking-cap-barbershop",
        "review-missed-deadline-barbershop",
      ],
      usesIndex: true,
    });
    expect(
      await read(
        "select turn_id as id from parked_turns where state = 'open' order by reply_due_at",
        "parked_turns_open_due_idx",
      ),
    ).toEqual({ ids: ["turn-riley-done-1"], usesIndex: true });
    expect(
      await read(
        "select id from dead_letters where state = 'open' order by dead_at",
        "dead_letters_open_idx",
      ),
    ).toEqual({ ids: ["dl-calendar-poll-riley-2026-10-23", "dl-reconcile-2026-11-03"], usesIndex: true });
    expect(
      await read(
        "select turn_id as id from gap_cases where review_state = 'open' order by logged_at",
        "gap_cases_open_idx",
      ),
    ).toEqual({ ids: ["turn-alex-gift-card"], usesIndex: true });
    expect(
      await read(
        "select turn_id as id from live_turn_labels where sample_month = '2026-10-01' and state = 'waiting'",
        "live_turn_labels_month_state_idx",
      ),
    ).toEqual({ ids: ["turn-alex-move-1"], usesIndex: true });
  });
});

describe("refuse-review-item-tool-api-read.json: a Tool API call cannot read the team review queue", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-review-item-tool-api-read.json");
  const where = Object.entries(refused.where ?? {});
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = where.map(([column, value]) => sql`${sql(column)} = ${value as never}`);
    const condition = conditions.reduce((all, one) => sql`${all} and ${one}`);
    return sql`select * from ${sql(refused.table)} where ${condition}`;
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop reads its own booking-cap flag; refused by privilege (42501)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "select",
      "review_items",
    ]);
    expect(where.map(([column]) => column)).toEqual(["id"]);
    expect(await read(db.sql)).toHaveLength(1);
    const outcome = await refusal(as(TOOL_API, refused.scope?.businessId ?? null, read));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table review_items");
  });

  it("without its one fault (the runtime side) the same read returns the row, unscoped or with that scope set", async () => {
    expect(await as(RUNTIME, null, read)).toHaveLength(1);
    expect(await as(RUNTIME, BARBERSHOP, read)).toHaveLength(1);
  });
});

describe("refuse-dead-letter-early.json: a job lands in the dead-letter queue only after its 5 tries", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-dead-letter-early.json");
  const values = refused.values ?? {};
  const insert = (row: Values) => (tx: Tx) => insertReturning(tx, refused.table, row);

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the runtime side, with no scope, inserts a dead letter after 3 tries; refused by dead_letters_after_five_tries (23514)", async () => {
    expect([refused.role, refused.scope, refused.action, refused.table]).toEqual([
      "runtime",
      null,
      "insert",
      "dead_letters",
    ]);
    expect(values.tries).toBe(3);
    const outcome = await refusal(as(RUNTIME, null, insert(values)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (tries 5) the same row passes; 4 tries is refused the same way", async () => {
    expect(await as(RUNTIME, null, insert({ ...values, tries: 5 }))).toMatchObject({
      id: values.id,
      tries: 5,
      state: "open",
      version: 1,
    });
    const four = await refusal(as(RUNTIME, null, insert({ ...values, tries: 4 })));
    expect([four.code, four.constraint]).toEqual(["23514", "dead_letters_after_five_tries"]);
  });
});

describe("privileges: Rosie's team only (K-37 rule 2)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it(
    "a Tool API call is refused every K-37 table, scoped or not: select, insert, update and delete (42501)",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const statement of [
            `select count(*) from ${table}`,
            `insert into ${table} default values`,
            `update ${table} set version = version + 1`,
            `delete from ${table}`,
          ]) {
            const outcome = await refusal(as(TOOL_API, scope, (tx) => tx.unsafe(statement)));
            expect(outcome.code, `${scope ?? "no scope"}: ${statement}`).toBe("42501");
            expect(outcome.message, `${scope ?? "no scope"}: ${statement}`).toContain(
              `permission denied for table ${table}`,
            );
          }
        }
      }
    },
  );

  it(
    "the runtime side reads every row, with no scope or a scope set (no policy hides one); it never deletes or truncates (42501)",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        const all = await countRows(db.sql, table);
        expect(all, table).toBeGreaterThan(0);
        expect(await as(RUNTIME, null, (tx) => countRows(tx, table)), table).toBe(all);
        expect(await as(RUNTIME, BARBERSHOP, (tx) => countRows(tx, table)), table).toBe(all);
        for (const statement of [`delete from ${table}`, `truncate ${table}`]) {
          const outcome = await refusal(as(RUNTIME, null, (tx) => tx.unsafe(statement)));
          expect(outcome.code, statement).toBe("42501");
          expect(outcome.message, statement).toContain(`permission denied for table ${table}`);
        }
        expect(await countRows(db.sql, table), table).toBe(all);
      }
    },
  );
});

describe("each rule of the table list refuses a row that breaks it, for that one reason", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  /** A second turn parked after its third crash, like the seed's (Riley's next text). */
  const PARKED_TURN: Values = {
    ...rowsOf("seed-parked-turn.json", "turns")[0]?.values,
    id: "turn-riley-done-2",
    event_ids: ["evt-riley-0032"],
    trace_id: "trace-riley-0032",
    parked_at: "2026-10-24T16:02:00Z",
    version: 1,
  };

  /** Inserts `values` into `table` as the runtime side with no scope, after the team stand-in and a parked turn. */
  const tried = (table: string, values: Values): Promise<Record<string, unknown>> =>
    as(RUNTIME, null, async (tx) => {
      await insertRow(tx, "persons", { id: TEAM_MEMBER });
      await insertRow(tx, "turns", PARKED_TURN);
      return insertReturning(tx, table, values);
    });

  /** The SQLSTATE and the constraint that refuse `values` in `table`. */
  const refusedBy = async (
    table: string,
    values: Values,
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(tried(table, values));
    return [outcome.code, outcome.constraint];
  };

  const parked: Values = {
    turn_id: "turn-riley-done-2",
    error_summary: "Exceeded CPU time limit before the commit, on try 3 of 3",
    person_told_at: "2026-10-24T16:02:01Z",
    reply_due_at: "2026-10-26T16:02:00Z",
  };
  const replied: Values = {
    state: "replied",
    replied_at: "2026-10-26T14:00:00Z",
    replied_by_person_id: TEAM_MEMBER,
    resolution: "Re-ran the turn from its sealed texts",
  };

  it(
    "parked_turns: the state, a reply with its time, person and resolution, the error, the turn and the person",
    SLOW,
    async () => {
      expect(await tried("parked_turns", parked)).toMatchObject({
        state: "open",
        replied_at: null,
        version: 1,
      });
      expect(await tried("parked_turns", { ...parked, ...replied })).toMatchObject({ state: "replied" });
      expect(await refusedBy("parked_turns", { ...parked, state: "closed" })).toEqual([
        "23514",
        "parked_turns_state_known",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, ...replied, replied_at: null })).toEqual([
        "23514",
        "parked_turns_replied_has_time",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, replied_at: "2026-10-26T14:00:00Z" })).toEqual([
        "23514",
        "parked_turns_replied_has_time",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, ...replied, replied_by_person_id: null })).toEqual([
        "23514",
        "parked_turns_replied_has_who",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, ...replied, resolution: null })).toEqual([
        "23514",
        "parked_turns_replied_has_who",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, error_summary: "  " })).toEqual([
        "23514",
        "parked_turns_error_given",
      ]);
      expect(await refusedBy("parked_turns", { ...parked, turn_id: "turn-none" })).toEqual([
        "23503",
        "parked_turns_turn_fk",
      ]);
      expect(
        await refusedBy("parked_turns", { ...parked, ...replied, replied_by_person_id: "person-none" }),
      ).toEqual(["23503", "parked_turns_replied_by_fk"]);
      expect(await refusedBy("parked_turns", { ...parked, turn_id: "turn-riley-done-1" })).toEqual([
        "23505",
        "parked_turns_pkey",
      ]);
    },
  );

  const deadLetter: Values = {
    ...rowsOf("seed-dead-letter.json", "dead_letters")[1]?.values,
    id: "dl-rule-base",
    job_id: "job-rule-base",
  };
  const resolved = "2026-10-23T15:00:00Z";

  it(
    "dead_letters: the tries and their order, the state, a resolution with its time and person, the error, the keys",
    SLOW,
    async () => {
      expect(await tried("dead_letters", deadLetter)).toMatchObject({ state: "open", resolved_at: null });
      expect(await tried("dead_letters", { ...deadLetter, business_id: null })).toMatchObject({
        business_id: null,
      });
      for (const state of ["replayed", "closed"]) {
        expect(
          await tried("dead_letters", {
            ...deadLetter,
            state,
            resolved_at: resolved,
            resolved_by_person_id: TEAM_MEMBER,
          }),
        ).toMatchObject({ state });
      }
      expect(await refusedBy("dead_letters", { ...deadLetter, tries: 4 })).toEqual([
        "23514",
        "dead_letters_after_five_tries",
      ]);
      expect(
        await refusedBy("dead_letters", { ...deadLetter, first_tried_at: "2026-10-23T14:39:00Z" }),
      ).toEqual(["23514", "dead_letters_tries_in_order"]);
      expect(await refusedBy("dead_letters", { ...deadLetter, dead_at: "2026-10-23T14:37:59Z" })).toEqual([
        "23514",
        "dead_letters_tries_in_order",
      ]);
      // An unknown state with its resolution given, so that only the state's rule is broken.
      expect(
        await refusedBy("dead_letters", {
          ...deadLetter,
          state: "retried",
          resolved_at: resolved,
          resolved_by_person_id: TEAM_MEMBER,
        }),
      ).toEqual(["23514", "dead_letters_state_known"]);
      expect(
        await refusedBy("dead_letters", {
          ...deadLetter,
          state: "replayed",
          resolved_by_person_id: TEAM_MEMBER,
        }),
      ).toEqual(["23514", "dead_letters_resolved_has_time"]);
      expect(await refusedBy("dead_letters", { ...deadLetter, resolved_at: resolved })).toEqual([
        "23514",
        "dead_letters_resolved_has_time",
      ]);
      expect(
        await refusedBy("dead_letters", { ...deadLetter, state: "closed", resolved_at: resolved }),
      ).toEqual(["23514", "dead_letters_resolved_has_who"]);
      expect(await refusedBy("dead_letters", { ...deadLetter, last_error: "" })).toEqual([
        "23514",
        "dead_letters_error_given",
      ]);
      expect(await refusedBy("dead_letters", { ...deadLetter, business_id: "biz-none" })).toEqual([
        "23503",
        "dead_letters_business_fk",
      ]);
      expect(
        await refusedBy("dead_letters", {
          ...deadLetter,
          state: "closed",
          resolved_at: resolved,
          resolved_by_person_id: "person-none",
        }),
      ).toEqual(["23503", "dead_letters_resolved_by_fk"]);
      expect(await refusedBy("dead_letters", { ...deadLetter, id: "dl-reconcile-2026-11-03" })).toEqual([
        "23505",
        "dead_letters_pkey",
      ]);
    },
  );

  const gapCase: Values = {
    turn_id: "turn-alex-move-1",
    business_id: BARBERSHOP,
    outcome: "ask",
    frontier: rowsOf("seed-gap-case.json", "gap_cases")[0]?.values.frontier ?? null,
  };
  const reviewed: Values = {
    review_state: "reviewed",
    reviewed_at: "2026-10-26T14:00:00Z",
    reviewed_by_person_id: TEAM_MEMBER,
  };

  it(
    "gap_cases: the outcome, the sealed summary's person, the frontier and state as lists, the review, the keys",
    SLOW,
    async () => {
      // Left out, the state is empty lists, and the case is logged now, open for the weekly review.
      const logged = await tried("gap_cases", gapCase);
      expect(logged).toMatchObject({
        open_question_ids: [],
        versions_read: [],
        review_state: "open",
        version: 1,
      });
      expect(logged.logged_at).toBeInstanceOf(Date);
      for (const outcome of ["answer", "ask", "pass_on", "hand_off", "log_gap", "to_person"]) {
        expect(await tried("gap_cases", { ...gapCase, outcome, business_id: null }), outcome).toMatchObject({
          outcome,
        });
      }
      expect(
        await tried("gap_cases", { ...gapCase, ...reviewed, test_ref: "gold-gap-0001", fix_ref: "T-9999" }),
      ).toMatchObject({ review_state: "reviewed", test_ref: "gold-gap-0001" });
      expect(await refusedBy("gap_cases", { ...gapCase, outcome: "book" })).toEqual([
        "23514",
        "gap_cases_outcome_known",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, summary_sealed: "\\x00" })).toEqual([
        "23514",
        "gap_cases_sealed_has_person",
      ]);
      const notLists: Json[] = [[], {}, "c-05"];
      for (const frontier of notLists) {
        expect(await refusedBy("gap_cases", { ...gapCase, frontier }), JSON.stringify(frontier)).toEqual([
          "23514",
          "gap_cases_frontier_is_list",
        ]);
      }
      expect(await refusedBy("gap_cases", { ...gapCase, versions_read: {} })).toEqual([
        "23514",
        "gap_cases_versions_read_is_list",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, review_state: "done" })).toEqual([
        "23514",
        "gap_cases_review_state_known",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, ...reviewed, reviewed_at: null })).toEqual([
        "23514",
        "gap_cases_reviewed_has_time",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, reviewed_at: "2026-10-26T14:00:00Z" })).toEqual([
        "23514",
        "gap_cases_reviewed_has_time",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, ...reviewed, reviewed_by_person_id: null })).toEqual([
        "23514",
        "gap_cases_reviewed_has_who",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, turn_id: "turn-none" })).toEqual([
        "23503",
        "gap_cases_turn_fk",
      ]);
      expect(await refusedBy("gap_cases", { ...gapCase, business_id: "biz-none" })).toEqual([
        "23503",
        "gap_cases_business_fk",
      ]);
      expect(
        await refusedBy("gap_cases", {
          ...gapCase,
          summary_sealed: "\\x00",
          sealed_for_person_id: "person-none",
        }),
      ).toEqual(["23503", "gap_cases_sealed_for_fk"]);
      expect(
        await refusedBy("gap_cases", { ...gapCase, ...reviewed, reviewed_by_person_id: "person-none" }),
      ).toEqual(["23503", "gap_cases_reviewed_by_fk"]);
      // A second gap case for one turn (the seed's).
      expect(await refusedBy("gap_cases", { ...gapCase, turn_id: "turn-alex-gift-card" })).toEqual([
        "23505",
        "gap_cases_pkey",
      ]);
    },
  );

  const reviewItem: Values = {
    id: "review-rule-base",
    kind: "listing_match",
    business_id: BARBERSHOP,
    raised_by_person_id: "person-sam",
    summary: "A listing that does not match the business: check it before the business goes live.",
    opened_at: "2026-10-19T18:20:00Z",
    due_at: "2026-10-20T18:20:00Z",
  };
  const decided: Values = {
    state: "done",
    decided_at: "2026-10-20T15:00:00Z",
    decided_by_person_id: TEAM_MEMBER,
    outcome: "The listing matches.",
  };

  it(
    "review_items: the kind, the state, a wait with its end, a decision with its time, person and outcome",
    SLOW,
    async () => {
      expect(await tried("review_items", reviewItem)).toMatchObject({ state: "open", version: 1 });
      for (const kind of [
        "new_work",
        "control",
        "listing_match",
        "owner_claim",
        "booking_cap",
        "harm_report",
        "missed_deadline",
      ]) {
        expect(await tried("review_items", { ...reviewItem, kind }), kind).toMatchObject({ kind });
      }
      expect(
        await tried("review_items", {
          ...reviewItem,
          kind: "owner_claim",
          state: "waiting",
          wait_until: "2026-10-22T18:20:00Z",
        }),
      ).toMatchObject({ state: "waiting" });
      expect(await tried("review_items", { ...reviewItem, ...decided })).toMatchObject({ state: "done" });
      expect(await refusedBy("review_items", { ...reviewItem, kind: "refund" })).toEqual([
        "23514",
        "review_items_kind_known",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, state: "closed" })).toEqual([
        "23514",
        "review_items_state_known",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, state: "waiting" })).toEqual([
        "23514",
        "review_items_waiting_has_until",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, wait_until: "2026-10-22T18:20:00Z" })).toEqual([
        "23514",
        "review_items_waiting_has_until",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, ...decided, decided_at: null })).toEqual([
        "23514",
        "review_items_done_has_time",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, decided_at: "2026-10-20T15:00:00Z" })).toEqual([
        "23514",
        "review_items_done_has_time",
      ]);
      expect(
        await refusedBy("review_items", { ...reviewItem, ...decided, decided_by_person_id: null }),
      ).toEqual(["23514", "review_items_done_has_who"]);
      expect(await refusedBy("review_items", { ...reviewItem, ...decided, outcome: null })).toEqual([
        "23514",
        "review_items_done_has_who",
      ]);
    },
  );

  it(
    "review_items: the subject as a pair, a due time after the opening, the summary, the keys",
    SLOW,
    async () => {
      expect(
        await tried("review_items", {
          ...reviewItem,
          subject_table: "businesses",
          subject_row_id: BARBERSHOP,
        }),
      ).toMatchObject({ subject_table: "businesses", subject_row_id: BARBERSHOP });
      expect(await refusedBy("review_items", { ...reviewItem, subject_table: "businesses" })).toEqual([
        "23514",
        "review_items_subject_pair",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, subject_row_id: BARBERSHOP })).toEqual([
        "23514",
        "review_items_subject_pair",
      ]);
      expect(
        await refusedBy("review_items", { ...reviewItem, due_at: reviewItem.opened_at ?? null }),
      ).toEqual(["23514", "review_items_due_after_opened"]);
      expect(await refusedBy("review_items", { ...reviewItem, due_at: "2026-10-19T18:19:59Z" })).toEqual([
        "23514",
        "review_items_due_after_opened",
      ]);
      // Left out, the opening is now, so a due time already past is refused too: code computes it from the kind.
      const opensNow = Object.fromEntries(
        Object.entries(reviewItem).filter(([column]) => column !== "opened_at"),
      );
      expect(await refusedBy("review_items", opensNow)).toEqual(["23514", "review_items_due_after_opened"]);
      expect(await refusedBy("review_items", { ...reviewItem, summary: " " })).toEqual([
        "23514",
        "review_items_summary_given",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, business_id: "biz-none" })).toEqual([
        "23503",
        "review_items_business_fk",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, turn_id: "turn-none" })).toEqual([
        "23503",
        "review_items_turn_fk",
      ]);
      expect(await refusedBy("review_items", { ...reviewItem, raised_by_person_id: "person-none" })).toEqual([
        "23503",
        "review_items_raised_by_fk",
      ]);
      expect(
        await refusedBy("review_items", { ...reviewItem, ...decided, decided_by_person_id: "person-none" }),
      ).toEqual(["23503", "review_items_decided_by_fk"]);
      expect(await refusedBy("review_items", { ...reviewItem, id: "review-control-movers" })).toEqual([
        "23505",
        "review_items_pkey",
      ]);
    },
  );

  const liveTurn: Values = { turn_id: "turn-alex-gift-card", sample_month: "2026-10-01" };
  const labelled: Values = {
    state: "labelled",
    label_sealed: "\\x00",
    sealed_for_person_id: "person-alex",
    labelled_at: "2026-11-02T10:00:00Z",
    labelled_by_person_id: TEAM_MEMBER,
  };

  it(
    "live_turn_labels: the month's first day, the state, a label with its key, time and labeller, the gold item",
    SLOW,
    async () => {
      const sampled = await tried("live_turn_labels", liveTurn);
      expect(sampled).toMatchObject({ state: "waiting", label_sealed: null, version: 1 });
      expect(sampled.sampled_at).toBeInstanceOf(Date);
      expect(
        await tried("live_turn_labels", { ...liveTurn, ...labelled, gold_item_id: "gold-2026-10-0001" }),
      ).toMatchObject({ state: "labelled", gold_item_id: "gold-2026-10-0001" });
      expect(await refusedBy("live_turn_labels", { ...liveTurn, sample_month: "2026-10-15" })).toEqual([
        "23514",
        "live_turn_labels_month_start",
      ]);
      expect(await refusedBy("live_turn_labels", { ...liveTurn, state: "skipped" })).toEqual([
        "23514",
        "live_turn_labels_state_known",
      ]);
      expect(await refusedBy("live_turn_labels", { ...liveTurn, state: "labelled" })).toEqual([
        "23514",
        "live_turn_labels_labelled_has_label",
      ]);
      expect(
        await refusedBy("live_turn_labels", { ...liveTurn, ...labelled, labelled_by_person_id: null }),
      ).toEqual(["23514", "live_turn_labels_labelled_has_label"]);
      expect(await refusedBy("live_turn_labels", { ...liveTurn, ...labelled, state: "waiting" })).toEqual([
        "23514",
        "live_turn_labels_labelled_has_label",
      ]);
      expect(
        await refusedBy("live_turn_labels", { ...liveTurn, ...labelled, sealed_for_person_id: null }),
      ).toEqual(["23514", "live_turn_labels_sealed_has_person"]);
      expect(await refusedBy("live_turn_labels", { ...liveTurn, gold_item_id: "gold-2026-10-0001" })).toEqual(
        ["23514", "live_turn_labels_gold_after_label"],
      );
      expect(await refusedBy("live_turn_labels", { ...liveTurn, turn_id: "turn-none" })).toEqual([
        "23503",
        "live_turn_labels_turn_fk",
      ]);
      expect(
        await refusedBy("live_turn_labels", {
          ...liveTurn,
          ...labelled,
          sealed_for_person_id: "person-none",
        }),
      ).toEqual(["23503", "live_turn_labels_sealed_for_fk"]);
      expect(
        await refusedBy("live_turn_labels", {
          ...liveTurn,
          ...labelled,
          labelled_by_person_id: "person-none",
        }),
      ).toEqual(["23503", "live_turn_labels_labelled_by_fk"]);
      // A turn is sampled once (the seed's).
      expect(await refusedBy("live_turn_labels", { ...liveTurn, turn_id: "turn-alex-move-1" })).toEqual([
        "23505",
        "live_turn_labels_pkey",
      ]);
    },
  );

  it(
    "every table: an update must raise the version by exactly one (<table>_version_raised, 23514)",
    SLOW,
    async () => {
      const seeded: [string, string][] = [
        ["parked_turns", "turn-riley-done-1"],
        ["dead_letters", "dl-reconcile-2026-11-03"],
        ["gap_cases", "turn-alex-gift-card"],
        ["review_items", "review-control-movers"],
        ["live_turn_labels", "turn-alex-move-1"],
      ];
      for (const [table, id] of seeded) {
        const key = tableOf(table).primaryKey[0] ?? "id";
        const [before] = await db.sql<{ version: number }[]>`
        select version from ${db.sql(table)} where ${db.sql(key)} = ${id}
      `;
        for (const raise of [0, 2]) {
          const outcome = await refusal(
            as(
              RUNTIME,
              null,
              (tx) => tx`update ${tx(table)} set version = version + ${raise} where ${tx(key)} = ${id}`,
            ),
          );
          expect([outcome.code, outcome.constraint], `${table} raised by ${String(raise)}`).toEqual([
            "23514",
            `${table}_version_raised`,
          ]);
        }
        const raised = await as(
          RUNTIME,
          null,
          (tx) =>
            tx<
              { version: number }[]
            >`update ${tx(table)} set version = version + 1 where ${tx(key)} = ${id} returning version`,
        );
        expect(raised, table).toEqual([{ version: (before?.version ?? 0) + 1 }]);
      }
    },
  );

  it(
    "the team's work on the seeded rows, each an update that raises the version by one, passes",
    SLOW,
    async () => {
      const work = await as(RUNTIME, null, async (tx) => {
        await insertRow(tx, "persons", { id: TEAM_MEMBER });
        const reply = await tx<{ state: string; version: number }[]>`
        update parked_turns set state = 'replied', replied_at = '2026-10-26T14:00:00Z',
          replied_by_person_id = ${TEAM_MEMBER}, resolution = 'Handled the request by hand', version = version + 1
        where turn_id = 'turn-riley-done-1' returning state, version
      `;
        const replay = await tx<{ state: string; version: number }[]>`
        update dead_letters set state = 'replayed', resolved_at = '2026-11-03T09:00:00Z',
          resolved_by_person_id = ${TEAM_MEMBER}, version = version + 1
        where id = 'dl-reconcile-2026-11-03' returning state, version
      `;
        const review = await tx<{ state: string; version: number }[]>`
        update gap_cases set review_state = 'reviewed', reviewed_at = '2026-10-26T14:00:00Z',
          reviewed_by_person_id = ${TEAM_MEMBER}, test_ref = 'gold-gap-0001', fix_ref = 'T-9999',
          version = version + 1
        where turn_id = 'turn-alex-gift-card' returning review_state as state, version
      `;
        const decision = await tx<{ state: string; version: number }[]>`
        update review_items set state = 'done', decided_at = '2026-10-20T15:00:00Z',
          decided_by_person_id = ${TEAM_MEMBER}, outcome = 'Control proven by the owner''s papers.',
          version = version + 1
        where id = 'review-control-movers' returning state, version
      `;
        const label = await tx<{ state: string; version: number }[]>`
        update live_turn_labels set state = 'labelled', label_sealed = '\\x00'::bytea,
          sealed_for_person_id = 'person-alex', labelled_at = '2026-11-02T10:00:00Z',
          labelled_by_person_id = ${TEAM_MEMBER}, gold_item_id = 'gold-2026-10-0001', version = version + 1
        where turn_id = 'turn-alex-move-1' returning state, version
      `;
        return [...reply, ...replay, ...review, ...decision, ...label];
      });
      expect(work).toEqual([
        { state: "replied", version: 3 },
        { state: "replayed", version: 2 },
        { state: "reviewed", version: 2 },
        { state: "done", version: 2 },
        { state: "labelled", version: 2 },
      ]);
    },
  );
});
