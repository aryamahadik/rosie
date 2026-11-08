// T-203: the business setup part (K-23 v1: business_setup, flow_defaults, companies, company_kinds, business_photos,
// business_faqs, locations, places_or_things and new_booking_pauses) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/business-setup`). The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: the commit's per-write scope,
// the clock sweep, sign-up's turns before there is a business) runs in its own transaction under SET LOCAL ROLE, scoped
// by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are loaded the same way, as the runtime side
// with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-23 v1's seeds and the K-04 v1 seeds their after chains name (Lee's
// Barbershop, Lee Home Services, the pet boarding demo shop, the yoga studio and the master's sample cast: Sam Lee). A
// row made here is a fixture row under a new id, or with one fault. The points the travel check asks about are
// stand-ins a few miles from the seeds' own stand-in map points, as a geo double could return them (Q-25), never
// geocodes.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/business-setup/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The nine tables, in code-unit order (as PostgreSQL orders a relation's name): all scoped by business, all versioned. */
const OWN_TABLES = [
  "business_faqs",
  "business_photos",
  "business_setup",
  "companies",
  "company_kinds",
  "flow_defaults",
  "locations",
  "new_booking_pauses",
  "places_or_things",
];
/** The seeds 02-contracts' K-23 row names, which the card's proof loads. */
const CARD_SEEDS = [
  "seed-business-demo-shop.json",
  "seed-company-two-kinds.json",
  "seed-location-flow-b.json",
  "seed-place-or-thing.json",
];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const PET_BOARDING = "biz-pet-boarding";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
/** Metres in a mile, as K-23's travel check counts them (README, "Locations and places"). */
const METRES_PER_MILE = 1609.344;
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
  indexes?: { name: string; columns: string[]; using?: string; where?: string }[];
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

const TABLES = (readJson(new URL("business-setup.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted K-04 v1 seed, named as K-23's seeds name it: from K-23's fixtures/ folder. */
const CORE_SEEDS = (
  readJson(new URL("../core/fixtures/index.json", PART_DIR)) as { fixtures: IndexEntry[] }
).fixtures
  .filter((entry) => entry.expect === "accept")
  .map((entry) => `../../core/fixtures/${entry.file}`);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-23 v1 lists no table ${name}`);
  }
  return table;
}

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
 * file that names it, so K-23's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Every K-23 row of the six seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Lee Home Services' plumbing kind (seed-company-two-kinds) and its company, as S1-04 writes them before S1-09. */
const EARLY_COMPANY: Values = {
  ...valuesOf("seed-company-two-kinds.json", "companies", 0),
  id: "company-sam-before-business",
  business_id: null,
  version: 1,
};
const EARLY_KIND: Values = {
  ...valuesOf("seed-company-two-kinds.json", "company_kinds", 0),
  company_id: "company-sam-before-business",
  business_id: null,
  version: 1,
};

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;
/** The type of each column of the schema's tables, keyed table.column, as format_type prints it. */
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
  message: string;
}

/** The SQLSTATE, constraint and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string };
    return { code: failure.code, constraint: failure.constraint_name, message: failure.message ?? "" };
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
async function insertReturning(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>[]> {
  return tx<Record<string, unknown>[]>`
    insert into ${tx(table)} ${tx(columnValues(tx, table, values))} returning *
  `;
}

/** `column = value and ...` for each column of `where`. */
function whereOf(sql: Sql | Tx, where: Values) {
  const conditions = Object.entries(where).map(([column, value]) => sql`${sql(column)} = ${textOf(value)}`);
  return conditions.reduce((all, one) => sql`${all} and ${one}`);
}

/** A row's primary key, from its values. */
const keyOf = (row: FixtureRow): Values =>
  Object.fromEntries(tableOf(row.table).primaryKey.map((column) => [column, row.values[column] ?? null]));

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

/**
 * Every column the fixture gives is stored as given, read back as the owner by the table's primary key and compared on
 * the server in the column's own type (an interval, a time, a numeric, a map point or a list as PostgreSQL reads both).
 */
async function expectStored(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const key = tableOf(row.table).primaryKey;
  const compared = columns.map((column, i) => {
    const type = typeOf.get(`${row.table}.${column}`) ?? "";
    return `("${column}")::text is not distinct from ($${String(i + 1)}::${type})::text as "${column}"`;
  });
  const matched = key.map((column, i) => `"${column}" = $${String(columns.length + i + 1)}`);
  const found = await db.sql.unsafe<Record<string, boolean>[]>(
    `select ${compared.join(", ")} from "${row.table}" where ${matched.join(" and ")}`,
    [
      ...columns.map((column) => row.values[column] ?? null),
      ...key.map((column) => textOf(row.values[column])),
    ],
  );
  const label = `${row.table} ${JSON.stringify(keyOf(row))}`;
  expect(found, label).toHaveLength(1);
  expect(found[0], label).toEqual(Object.fromEntries(columns.map((column) => [column, true])));
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each of the nine tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the nine tables whose business_id is `businessId` (null: no business), read as the owner. */
async function ownerRows(businessId: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table)}
      where ${businessId === null ? db.sql`business_id is null` : db.sql`business_id = ${businessId}`}
    `;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Rows each of the nine tables shows the caller whose business_id is null. */
async function visibleRowsWithNoBusiness(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table)} where business_id is null
    `;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Each business's id, in code-unit order. */
async function businessIds(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`select id from businesses`;
  return rows.map((row) => row.id).sort();
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
  db = await createTestDatabase({ name: "business_setup" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-23 v1 business setup)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
    time: "time without time zone",
  };

  it("the table list names nine tables, each scoped by business on business_id and versioned", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.versionColumn],
        table.name,
      ).toEqual(["business", "business_id", true, "version"]);
    }
  });

  for (const table of TABLES) {
    it(`${table.name}: columns in order, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: boolean; default: string | null }[]>`
        select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
               pg_get_expr(d.adbin, d.adrelid) as default
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = ${`${db.schema}.${table.name}`}::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type] ?? column.type);
        expect(actual?.nullable, `${table.name}.${column.name} null`).toBe(column.null);
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

    it(`${table.name}: each check, each index (with its access method) and each partial unique index is the table list's own expression, as PostgreSQL reads both`, async () => {
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
          const using = index.using === undefined ? "" : ` using ${index.using}`;
          const where = index.where === undefined ? "" : ` where ${index.where}`;
          await tx.unsafe(
            `create index ${index.name} on probe${using} (${index.columns.join(", ")})${where}`,
          );
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

  it("the map points are PostGIS points (rule 2): map_point and travel_centre are geography(Point,4326), and map_point has a GiST index", async () => {
    expect([typeOf.get("locations.map_point"), typeOf.get("locations.travel_centre")]).toEqual([
      "geography(Point,4326)",
      "geography(Point,4326)",
    ]);
    const own = await definitionsOf(db.sql, "locations");
    expect(own.indexes.locations_map_point_idx).toBe("USING gist (map_point)");
  });

  it("all nine raise their version on every update (0002's rule): <table>_version_raised, and no other trigger", async () => {
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

  it("row-level security is on for all nine, in T-191's pattern: 0012's two policies on business_id, <table>_tool_api for rosie_app and <table>_runtime for rosie_job; none forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
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
    expect([...new Set(policies.map((policy) => policy.table))].sort()).toEqual(
      [...OWN_TABLES, "outbox_rows"].sort(),
    );
    // 0012's shape, read from outbox_rows' two policies, which key on the same column (business_id).
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    for (const table of OWN_TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      expect(
        own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command]),
        table,
      ).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      expect(
        own.map((policy) => [policy.using, policy.check]),
        table,
      ).toEqual(core.map((policy) => [policy.using, policy.check]));
      expect(own[0]?.using, table).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
      // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
      expect(own[0]?.using, table).toContain("IS NULL");
      expect(own[1]?.using, table).not.toContain("IS NULL");
    }
  });

  it("grants (DL-149, each to its named reader: the migration's header): select, insert and update on all nine to both roles; no delete, truncate, references or trigger; nothing to PUBLIC", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) =>
        OWN_TABLES.flatMap((table) =>
          ["INSERT", "SELECT", "UPDATE"].map((privilege) => `${role} ${table} ${privilege}`),
        ),
      ).sort(),
    );
    const others = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee <> c.relowner and a.grantee not in (${TOOL_API}::regrole, ${RUNTIME}::regrole)
    `;
    expect(others).toEqual([]);
    // No column holds a grant of its own: each role's rights are the whole table's.
    const columnGrants = await db.sql<{ table: string; column: string }[]>`
      select c.relname as table, a.attname as column
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attacl is not null
    `;
    expect(columnGrants).toEqual([]);
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

  it("core's businesses row keeps K-04's columns: K-23 adds none to it (FS line 721's rest lives in business_setup)", async () => {
    const columns = await db.sql<{ name: string }[]>`
      select attname as name from pg_attribute
      where attrelid = ${`${db.schema}.businesses`}::regclass and attnum > 0 and not attisdropped
      order by attnum
    `;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "display_name",
      "status",
      "time_zone",
      "text_hours_start",
      "text_hours_end",
      "version",
    ]);
  });

  it("is recorded in schema_migrations as business_setup, after notifications and core_rls_narrow", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("business_setup");
    expect(names.indexOf("business_setup")).toBeGreaterThan(names.indexOf("notifications"));
    expect(names.indexOf("business_setup")).toBeGreaterThan(names.indexOf("core_rls_narrow"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the four of 02-contracts' K-23 row and the two beyond it", () => {
  /** The K-23 rows the six seeds give together, per table: every table gets rows. */
  const SEEDED = {
    business_faqs: 1,
    business_photos: 3,
    business_setup: 1,
    companies: 2,
    company_kinds: 3,
    flow_defaults: 4,
    locations: 3,
    new_booking_pauses: 1,
    places_or_things: 3,
  };

  it("the index lists the six seeds (the card's four among them) and four refused rows, all K-23 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual(
      [...CARD_SEEDS, "seed-location-travel-centre.json", "seed-new-booking-pause.json"].sort(),
    );
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-nomoney-fact-without-switch.json",
      "invalid/refuse-photo-customer-without-yes.json",
      "invalid/refuse-second-open-pause.json",
      "invalid/refuse-travel-centre-without-address.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-23 row is stored as given`,
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

  it("all six insert together, each after chain once, and no table is left empty", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await visibleRows(db.sql)).toEqual(SEEDED);
    for (const row of SEED_ROWS) {
      await expectStored(row);
    }
  });

  it("they insert together with every K-04 v1 seed as well, each file once", SLOW, async () => {
    await reset();
    expect(CORE_SEEDS.length).toBeGreaterThan(0);
    const loaded = await loadFixtures([...CORE_SEEDS, ...SEEDS]);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await visibleRows(db.sql)).toEqual(SEEDED);
  });
});

describe("the seeded rows: what the six seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("Lee's Barbershop is set up and live: listing phone, website, About us and three photos confirmed, Stripe, terms ticked by Sam, control by a code to the listing; free cancel until 24 hours before with a set start in both flows; one FAQ; the shop at 88 Elm St", async () => {
    const [setup] = await db.sql<Record<string, unknown>[]>`
      select s.listing_phone as phone, s.website, s.stripe_account_id is not null as stripe, s.no_money as "noMoney",
             p.name as "termsBy", s.control_proven_via as control, s.profile_confirmed_at is not null as profile,
             b.status
      from business_setup s
        join businesses b on b.id = s.business_id
        join persons p on p.id = s.terms_accepted_by_person_id
      where s.business_id = ${BARBERSHOP}
    `;
    expect(setup).toEqual({
      phone: "+15555550177",
      website: "https://example.com",
      stripe: true,
      noMoney: false,
      termsBy: "Sam Lee",
      control: "listing_code",
      profile: true,
      status: "live",
    });
    const flows = await db.sql<{ flow: string; cutoff: string; arrive: string }[]>`
      select flow, cutoff_before::text as cutoff, arrive from flow_defaults where business_id = ${BARBERSHOP}
      order by flow
    `;
    expect(flows).toEqual([
      { flow: "A", cutoff: "24:00:00", arrive: "setstart" },
      { flow: "B", cutoff: "24:00:00", arrive: "setstart" },
    ]);
    // The listing read (K-21) returns photos and FAQs sorted by position.
    const photos = await db.sql<{ label: string }[]>`
      select label from business_photos where business_id = ${BARBERSHOP} order by position
    `;
    expect(photos.map((photo) => photo.label)).toEqual(["The shop front", "The chairs", "A chair, ready"]);
    const faqs = await db.sql<{ question: string }[]>`
      select question from business_faqs where business_id = ${BARBERSHOP} order by position
    `;
    expect(faqs.map((faq) => faq.question)).toEqual(["Do you cut kids' hair?"]);
  });

  it("Sam's two companies after S1-04: plumbing and electrical share Lee Home Services LLC under their own trade names, the barbershop is its own; the plumber's cancelright switch is on in flow B only", async () => {
    const kinds = await db.sql<
      { company: string; kind: string; trade: string | null; a: string[]; b: string[]; business: string }[]
    >`
      select c.name as company, k.kind_id as kind, k.trade_name as trade, k.pf_switches_a as a,
             k.pf_switches_b as b, k.business_id as business
      from company_kinds k join companies c on c.id = k.company_id and c.business_id = k.business_id
      order by c.name, k.kind_id
    `;
    expect(kinds).toEqual([
      {
        company: "Lee Home Services LLC",
        kind: "electrician",
        trade: "Lee Electric",
        a: [],
        b: [],
        business: HOME_SERVICES,
      },
      {
        company: "Lee Home Services LLC",
        kind: "plumber",
        trade: "Lee Plumbing",
        a: [],
        b: ["cancelright"],
        business: HOME_SERVICES,
      },
      { company: "Lee's Barbershop LLC", kind: "barber", trade: null, a: [], b: [], business: BARBERSHOP },
    ]);
  });

  it("Lee Home Services goes 25 miles from its office at 1200 Main St (its own point is the centre), with an arrival window in flow B; the barbershop's second shop goes 25 miles from the first shop, stored as its pin and its address", async () => {
    const rows = await db.sql<
      {
        id: string;
        address: string;
        miles: string | null;
        centre: string | null;
        centreAddress: string | null;
      }[]
    >`
      select id, address, travel_miles::text as miles, ST_AsEWKT(travel_centre) as centre,
             travel_centre_address as "centreAddress"
      from locations where travel_miles is not null order by id
    `;
    expect(rows).toEqual([
      {
        id: "loc-lee-home-services-office",
        address: "1200 Main St, Springfield",
        miles: "25",
        centre: null,
        centreAddress: null,
      },
      {
        id: "loc-lees-barbershop-second-shop",
        address: "123 Demo St, Anytown",
        miles: "25",
        centre: "SRID=4326;POINT(-90.01 40.01)",
        centreAddress: "88 Elm St, Springfield",
      },
    ]);
    const [flowB] = await db.sql<{ arrive: string }[]>`
      select arrive from flow_defaults where business_id = ${HOME_SERVICES} and flow = 'B'
    `;
    expect(flowB?.arrive).toBe("window");
  });

  it("the pet boarding demo shop's run, suite and cat condo each fit two pets and are counted by the day; Sam's PAUSE of the barbershop at 1:15pm Mon Oct 26 ended with his RESUME at 2:40pm", async () => {
    const spaces = await db.sql<{ name: string; kind: string; fits: number; per: string }[]>`
      select name, kind, fits, bookable_per as per from places_or_things where business_id = ${PET_BOARDING}
      order by name
    `;
    expect(spaces).toEqual([
      { name: "Cat condo", kind: "space", fits: 2, per: "day" },
      { name: "Standard run", kind: "space", fits: 2, per: "day" },
      { name: "Suite", kind: "space", fits: 2, per: "day" },
    ]);
    const [pause] = await db.sql<Record<string, unknown>[]>`
      select to_char(paused_at at time zone 'America/New_York', 'Dy Mon DD, FMHH12:MIam') as paused,
             to_char(resumed_at at time zone 'America/New_York', 'FMHH12:MIam') as resumed,
             paused_by_person_id as "pausedBy", resumed_by_person_id as "resumedBy"
      from new_booking_pauses where business_id = ${BARBERSHOP}
    `;
    expect(pause).toEqual({
      paused: "Mon Oct 26, 1:15pm",
      resumed: "2:40pm",
      pausedBy: "person-sam",
      resumedBy: "person-sam",
    });
  });
});

describe("row-level security per business on the nine tables, every K-04 v1 and K-23 v1 seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SEEDS]);
    // A company and its kind written before their business exists (S1-04 before S1-09), on the runtime side.
    await committedAs(RUNTIME, async (tx) => {
      await insertRow(tx, "companies", EARLY_COMPANY);
      await insertRow(tx, "company_kinds", EARLY_KIND);
    });
  }, 60_000);

  it(
    "with no scope the Tool API reads no row of the nine; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's setup, companies or kinds",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual([HOME_SERVICES, BARBERSHOP, MOVERS, PET_BOARDING, YOGA_STUDIO].sort());
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      const barbershop = await ownerRows(BARBERSHOP);
      for (const table of ["business_setup", "companies", "company_kinds"]) {
        expect(barbershop[table], table).toBeGreaterThan(0);
      }
      expect(await as(TOOL_API, YOGA_STUDIO, visibleRows)).toEqual(zeros);
    },
  );

  it(
    "a company and its kind with no business yet are seen by no business scope, under either role; the runtime side with no scope reads them",
    SLOW,
    async () => {
      const withNone = await ownerRows(null);
      expect([withNone.companies, withNone.company_kinds]).toEqual([1, 1]);
      const zeros = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));
      for (const business of await businessIds()) {
        for (const role of ROLES) {
          expect(await as(role, business, visibleRowsWithNoBusiness), `${role} at ${business}`).toEqual(
            zeros,
          );
        }
      }
      expect(await as(RUNTIME, null, visibleRowsWithNoBusiness)).toEqual(withNone);
    },
  );

  it(
    "the runtime side with no scope reads every row; with a scope set (per write), only that business's",
    SLOW,
    async () => {
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
      for (const business of await businessIds()) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
    },
  );

  it("the Tool API writes only its scope's rows: another business's insert is refused (42501), its update finds no row, a row cannot move to another business, and nothing is deleted", async () => {
    const secondFaq = {
      ...valuesOf("seed-business-demo-shop.json", "business_faqs"),
      id: "faq-lees-barbershop-second",
      position: 2,
    };
    const addFaq = (tx: Tx) => insertReturning(tx, "business_faqs", secondFaq);
    expect((await refusal(as(TOOL_API, YOGA_STUDIO, addFaq))).code).toBe("42501");
    expect(await as(TOOL_API, BARBERSHOP, addFaq)).toHaveLength(1);
    const bump = (tx: Tx): Promise<readonly unknown[]> =>
      tx`update business_setup set version = version + 1 where business_id = ${BARBERSHOP} returning version`;
    expect(await as(TOOL_API, YOGA_STUDIO, bump)).toHaveLength(0);
    expect(await as(TOOL_API, BARBERSHOP, bump)).toEqual([{ version: 5 }]);
    const move = (tx: Tx) => tx`
      update locations set business_id = ${YOGA_STUDIO}, version = version + 1 where id = 'loc-lees-barbershop-shop'
    `;
    expect((await refusal(as(TOOL_API, BARBERSHOP, move))).code).toBe("42501");
    for (const table of OWN_TABLES) {
      const removed = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx`delete from ${tx(table)}`));
      expect([removed.code, removed.message], table).toEqual([
        "42501",
        `permission denied for table ${table}`,
      ]);
    }
    // A company with no business is the runtime side's alone: the Tool API cannot write one.
    const early = { ...EARLY_COMPANY, id: "company-sam-before-business-2" };
    expect(
      (await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "companies", early)))).code,
    ).toBe("42501");
  });

  it("the runtime side scoped to one business (per write) cannot write another's row, nor one with no business; with no scope it writes both", async () => {
    const secondFaq = {
      ...valuesOf("seed-business-demo-shop.json", "business_faqs"),
      id: "faq-lees-barbershop-second",
      position: 2,
    };
    const early = { ...EARLY_COMPANY, id: "company-sam-before-business-2" };
    expect(
      (await refusal(as(RUNTIME, YOGA_STUDIO, (tx) => insertReturning(tx, "business_faqs", secondFaq)))).code,
    ).toBe("42501");
    expect(
      (await refusal(as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "companies", early)))).code,
    ).toBe("42501");
    expect(
      await as(RUNTIME, null, async (tx) => [
        ...(await insertReturning(tx, "business_faqs", secondFaq)),
        ...(await insertReturning(tx, "companies", early)),
      ]),
    ).toHaveLength(2);
  });

  it("a kind's business is its company's: company_kinds_company_business_fk refuses another business (23503); the same kind under its company's business passes", async () => {
    const electrician = valuesOf("seed-company-two-kinds.json", "company_kinds", 1);
    const misfiled = { ...electrician, company_id: "company-lees-barbershop", business_id: HOME_SERVICES };
    const outcome = await refusal(as(RUNTIME, null, (tx) => insertReturning(tx, "company_kinds", misfiled)));
    expect([outcome.code, outcome.constraint]).toEqual(["23503", "company_kinds_company_business_fk"]);
    expect(
      await as(RUNTIME, null, (tx) =>
        insertReturning(tx, "company_kinds", { ...misfiled, business_id: BARBERSHOP }),
      ),
    ).toHaveLength(1);
  });

  it("every update raises the version by exactly one: under its business's scope, an update that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const table of OWN_TABLES) {
      const row = SEED_ROWS.find((candidate) => candidate.table === table);
      if (row === undefined) {
        throw new Error(`no seed row of ${table}`);
      }
      const business = textOf(row.values.business_id);
      const version = row.values.version;
      const kept = await refusal(
        as(
          TOOL_API,
          business,
          (tx) => tx`update ${tx(table)} set version = version where ${whereOf(tx, keyOf(row))}`,
        ),
      );
      expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
      const raised = await as(
        TOOL_API,
        business,
        (tx) =>
          tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where ${whereOf(tx, keyOf(row))} returning version
          `,
      );
      expect(raised, table).toEqual([{ version: typeof version === "number" ? version + 1 : -1 }]);
    }
  });

  it("the travel check is distance on stored points (Q-25): a point about 20 miles from the office is inside its 25 miles and one about 40 miles out is not; from the second shop's centre, about 10 miles in and 40 out", async () => {
    const inside = async (location: string, point: string): Promise<boolean | undefined> => {
      const [row] = await db.sql<{ inside: boolean }[]>`
        select ST_DWithin(coalesce(travel_centre, map_point), ${point}::geography,
                          travel_miles::float8 * ${METRES_PER_MILE}::float8) as inside
        from locations where id = ${location}
      `;
      return row?.inside;
    };
    expect(await inside("loc-lee-home-services-office", "SRID=4326;POINT(-90 40.29)")).toBe(true);
    expect(await inside("loc-lee-home-services-office", "SRID=4326;POINT(-90 40.58)")).toBe(false);
    expect(await inside("loc-lees-barbershop-second-shop", "SRID=4326;POINT(-90.01 40.155)")).toBe(true);
    expect(await inside("loc-lees-barbershop-second-shop", "SRID=4326;POINT(-90.01 40.59)")).toBe(false);
  });
});

/** Each refused fixture with its one fault removed: K-23's README names the row that passes once it is fixed. */
const REFUSED_CASES: { file: string; fixed: Values; without: string }[] = [
  {
    file: "invalid/refuse-photo-customer-without-yes.json",
    fixed: { written_yes_confirmed_at: "2026-10-20T15:00:00Z" },
    without: "the same photo with the owner's confirmation of that customer's written yes",
  },
  {
    file: "invalid/refuse-second-open-pause.json",
    fixed: { resumed_at: "2026-10-27T14:00:00Z", resumed_by_person_id: "person-sam" },
    without: "the same pause with RESUME's time and who resumed it",
  },
  {
    file: "invalid/refuse-nomoney-fact-without-switch.json",
    fixed: { pf_switches_a: ["nomoney"] },
    without: "the same update that also turns the nomoney switch on",
  },
  {
    file: "invalid/refuse-travel-centre-without-address.json",
    fixed: { travel_centre_address: "88 Elm St, Springfield" },
    without: "the same second shop with its centre's address",
  },
];

for (const { file, fixed, without } of REFUSED_CASES) {
  describe(`${file}: refused for its one reason, as the Tool API side`, () => {
    const { refused } = refusedOf(file);
    const attempt =
      (change: Values) =>
      (tx: Tx): Promise<Record<string, unknown>[]> => {
        if (refused.action === "insert") {
          return insertReturning(tx, refused.table, { ...(refused.values ?? {}), ...change });
        }
        return tx<Record<string, unknown>[]>`
          update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, { ...(refused.set ?? {}), ...change }))}
          where ${whereOf(tx, refused.where ?? {})}
          returning *
        `;
      };

    beforeAll(async () => {
      await reset();
      // The fixture's after chain and its own rows (the open pause the second one meets).
      await loadFixtures([file]);
    }, 60_000);

    it(`the fixture: the Tool API scoped to Lee's Barbershop ${refused.action}s into ${refused.table}; refused by ${refused.expect.constraintOneOf?.join(" or ") ?? "?"} (${refused.expect.sqlstate ?? "?"}), never by privilege`, async () => {
      expect([
        refused.role,
        refused.scope?.businessId,
        ["insert", "update"].includes(refused.action),
      ]).toEqual(["toolApi", BARBERSHOP, true]);
      const outcome = await refusal(as(TOOL_API, BARBERSHOP, attempt({})));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      const done = await as(TOOL_API, BARBERSHOP, attempt(fixed));
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ business_id: BARBERSHOP });
    });
  });
}
