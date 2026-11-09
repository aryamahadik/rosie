// T-207: the rules part (K-26 v1: trade_facts, plugin_switches, rule_kinds, rules and price_ok_limits) against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/rules`). The schema comes from migrating a fresh test
// schema, and its migration (0023) also writes the three closed registries' seed.
//
// The test's connection is the migrations' role, which owns the tables, is not bound by row-level security and is the
// only role that may write the registries (README rule 5). A check made as the Tool API (rosie_app, K-05 scope business)
// or the runtime side (rosie_job: the commit's per-write scope) runs in its own transaction under SET LOCAL ROLE, scoped
// by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are loaded the same way, as the runtime side
// with no scope (K-04's fixture format), and committed; a registry row a fixture's chain names is found as the
// migration wrote it, never inserted again.
//
// The rows come only from fixtures (rule 9): K-26 v1's seeds and the K-23 v1 and K-04 v1 seeds their after chains name
// (Lee's Barbershop, Lee Home Services, the yoga studio and the master's sample cast: Sam Lee). A row made here is a
// fixture row under a new id, or with one fault.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/rules/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The five tables, in code-unit order (as PostgreSQL orders a relation's name). */
const OWN_TABLES = ["plugin_switches", "price_ok_limits", "rule_kinds", "rules", "trade_facts"];
/** The closed registries (scope none, README rule 5): the same for every business, written only by a migration's seed. */
const REGISTRIES = ["plugin_switches", "rule_kinds", "trade_facts"];
/** The two tables scoped by business on business_id, versioned and with effective dates (README rules 3 and 5). */
const SCOPED = ["price_ok_limits", "rules"];
/** The seeds 02-contracts' K-26 row names, which the card's proof loads. */
const CARD_SEEDS = ["seed-rules-tap-list.json", "seed-price-ok-limit.json", "seed-note-only-rule.json"];
/** The registries' seed, one beyond the row's list (README): the migration's own rows. */
const REGISTRY_SEED = "seed-rule-registry.json";
/** The other parts' tables the five refer to by their keys (README rule 1): K-04's alone. */
const REFERRED = ["businesses", "persons"];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA_STUDIO = "biz-yoga-studio";
/** When Sam kept the tap list (2:12pm Mon Oct 19, README), the start of every seeded rule and price OK limit. */
const TAP_LIST_KEPT = "2026-10-19T18:12:00Z";
/** The start of Mon Nov 2 in the barbershop's zone (America/New_York): the change date the README names. */
const NOV_2 = "2026-11-02T05:00:00Z";
const SAME_DAY_ID = "rule-lees-barbershop-ok-same-day";
const NEW_CUSTOMER_ID = "rule-lees-barbershop-ok-new-customer";
const COLOR_QUOTES_ID = "pok-lees-barbershop-quotes";
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey: string[];
  foreignKeys?: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
  unique?: { name: string; columns: string[]; where?: string }[];
  exclude?: {
    name: string;
    using: string;
    elements: { column?: string; expression?: string; operator: string }[];
    where?: string;
  }[];
  checks?: { name: string; expression: string }[];
  indexes?: { name: string; columns: string[]; using?: string; where?: string }[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
  versionColumn?: string;
  effectiveDates: boolean;
  effectiveColumns?: string[];
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

const TABLES = (readJson(new URL("rules.v1.tables.json", PART_DIR)) as { tables: ContractTable[] }).tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-26's seeds name it: from K-26's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);
/** Every accepted K-04 v1 and K-23 v1 seed. */
const CORE_SEEDS = seedsOf("core");
const SETUP_SEEDS = seedsOf("business-setup");

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-26 v1 lists no table ${name}`);
  }
  return table;
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's own row of `table` whose key (the table's one primary key column) is `key`. */
function valuesWithKey(file: string, table: string, key: string): Values {
  const column = tableOf(table).primaryKey[0] ?? "";
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values[column] === key,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row ${key}`);
  }
  return row.values;
}

function refusedOf(file: string): Refused {
  const refused = fixtureFile(file).refused;
  if (refused === undefined) {
    throw new Error(`${file} has no refused action`);
  }
  return refused;
}

/** The role a refused fixture names: toolApi is rosie_app, runtime is rosie_job (K-04's fixture format). */
function roleOf(refused: Refused): Role {
  if (refused.role === "toolApi") {
    return TOOL_API;
  }
  if (refused.role === "runtime") {
    return RUNTIME;
  }
  throw new Error(`a refused fixture names an unknown role ${refused.role}`);
}

/** The fixtures/ folder a fixture file sits in: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(file: URL): URL {
  const folder = new URL(".", file);
  return folder.href.endsWith("/invalid/") ? new URL("..", folder) : folder;
}

/**
 * A fixture's rows, after those of every fixture its `after` names (each path relative to the fixtures/ folder of the
 * file that names it, so K-26's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** The ids of the businesses the files' chains give, in code-unit order. */
function businessesOf(files: readonly string[]): string[] {
  const seen = new Set<string>();
  return files
    .flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen))
    .filter((row) => row.table === "businesses")
    .map((row) => textOf(row.values.id))
    .sort();
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Every K-26 row of the four seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();
/** The registries' rows as seed-rule-registry.json gives them: what the migration's seed must hold, row for row. */
const REGISTRY_ROWS = fixtureFile(REGISTRY_SEED).rows;
const registryCount = (table: string): number => REGISTRY_ROWS.filter((row) => row.table === table).length;

/** The tap list's same-day rule for the whole barbershop (seed-rules-tap-list). */
const SAME_DAY = valuesWithKey("seed-rules-tap-list.json", "rules", SAME_DAY_ID);
/** The tap list's new-customer rule (seed-rules-tap-list), which S11-57's change closes. */
const NEW_CUSTOMER = valuesWithKey("seed-rules-tap-list.json", "rules", NEW_CUSTOMER_ID);
/** Sam's $500 limit for Lee Home Services' quotes and bills in both flows (seed-price-ok-limit). */
const HOME_SERVICES_LIMIT = valuesWithKey(
  "seed-price-ok-limit.json",
  "price_ok_limits",
  "pok-lee-home-services",
);
/** Who may book a kids cut, in Sam's words, saved only as a note for the barber kind (seed-note-only-rule). */
const KIDS_CUT_NOTE = valuesWithKey(
  "seed-note-only-rule.json",
  "rules",
  "rule-lees-barbershop-note-kids-cut",
);
/** The registry's same-day kind, note kind, waitlist fact and verify switch (seed-rule-registry). */
const SAME_DAY_KIND = valuesWithKey(REGISTRY_SEED, "rule_kinds", "ok_same_day");
const NOTE_KIND = valuesWithKey(REGISTRY_SEED, "rule_kinds", "note");
const WAITLIST_FACT = valuesWithKey(REGISTRY_SEED, "trade_facts", "waitlist");
const VERIFY_SWITCH = valuesWithKey(REGISTRY_SEED, "plugin_switches", "verify");

/** A rule made here: the tap list's same-day rule for the barber kind only, a scope of its own beside the business's. */
const BARBER_SAME_DAY: Values = {
  ...SAME_DAY,
  id: "rule-lees-barbershop-ok-same-day-barber",
  kind_id: "barber",
};
/** A money rule made here: limit 2's $250 minimum (arch 06 line 301) for the whole barbershop. */
const MINIMUM_JOB: Values = {
  ...SAME_DAY,
  id: "rule-lees-barbershop-minimum-job",
  rule_kind: "minimum_job",
  value_type: "money",
  value_on: null,
  value_cents: 25000,
  value_currency: "USD",
};
/** A span rule made here: the notice a booking needs before its start (FS row H05). */
const NOTICE: Values = {
  ...SAME_DAY,
  id: "rule-lees-barbershop-notice",
  rule_kind: "notice",
  value_type: "span",
  value_on: null,
  value_span: "2 hours",
};
/** A count rule made here: the no-show count at 2, as the plug-ins' edge puts it (README default 5). */
const NO_SHOW_COUNT: Values = {
  ...SAME_DAY,
  id: "rule-lees-barbershop-no-show-count",
  rule_kind: "no_show_count",
  value_type: "count",
  value_on: null,
  value_count: 2,
};
/** A dates rule made here: days in the barbershop's zone that wait for Sam's OK (A4-98's date ranges). */
const OK_DATES: Values = {
  ...SAME_DAY,
  id: "rule-lees-barbershop-ok-dates",
  rule_kind: "ok_dates",
  value_type: "dates",
  value_on: null,
  value_dates: "[2026-11-26,2026-11-28)",
};
/** A note made here: Sam's kids cut note under a new id, a second note in the same scope. */
const SECOND_NOTE: Values = { ...KIDS_CUT_NOTE, id: "rule-lees-barbershop-note-kids-cut-2" };
/** A price OK limit made here: Lee Home Services' $500 limit for its plumber kind only, beside the business's. */
const PLUMBER_LIMIT: Values = {
  ...HOME_SERVICES_LIMIT,
  id: "pok-lee-home-services-plumber",
  kind_id: "plumber",
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

/** Inserts each row in order and gives back the last one as stored. */
function insertEach(...rows: [string, Values][]): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return async (tx) => {
    let last: Record<string, unknown>[] = [];
    for (const [table, values] of rows) {
      last = await insertReturning(tx, table, values);
    }
    return last;
  };
}

/** A row's primary key, from its values. */
const keyOf = (row: FixtureRow): Values =>
  Object.fromEntries(tableOf(row.table).primaryKey.map((column) => [column, row.values[column] ?? null]));

/**
 * Every column the fixture gives is stored as given, read back as the owner by the table's primary key and compared on
 * the server in the column's own type (an instant, an amount or a flag as PostgreSQL reads both; text exactly).
 */
async function expectStored(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const key = tableOf(row.table).primaryKey;
  const typeIn = (column: string): string => typeOf.get(`${row.table}.${column}`) ?? "";
  const compared = columns.map(
    (column, i) =>
      `("${column}")::text is not distinct from ($${String(i + 1)}::${typeIn(column)})::text as "${column}"`,
  );
  const matched = key.map(
    (column, i) => `"${column}" = $${String(columns.length + i + 1)}::${typeIn(column)}`,
  );
  const found = await db.sql.unsafe<Record<string, boolean>[]>(
    `select ${compared.join(", ")} from "${row.table}" where ${matched.join(" and ")}`,
    [
      ...columns.map((column) => row.values[column] ?? null),
      ...key.map((column) => row.values[column] ?? null),
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

/** Rows each of the two business-scoped tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows each registry shows the caller, by table. */
async function registryRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of REGISTRIES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the two tables whose business_id is `businessId`, read as the owner. */
async function ownerRows(businessId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table)} where business_id = ${businessId}
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

/** The ids of a business's rules of one kind whose dates hold the instant `at`: [effective_from, effective_to). */
async function inEffect(sql: Sql | Tx, businessId: string, kind: string, at: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from rules
    where business_id = ${businessId} and rule_kind = ${kind}
      and tstzrange(effective_from, effective_to, '[)') @> ${at}::timestamptz
    order by id collate "C"
  `;
  return rows.map((row) => row.id);
}

/**
 * A table's checks, exclusions and indexes as PostgreSQL prints them, by name; an index without its own name and table,
 * but with UNIQUE kept, so a partial unique index is compared as one.
 */
async function definitionsOf(
  sql: Sql | Tx,
  table: string,
): Promise<{
  checks: Record<string, string>;
  excludes: Record<string, string>;
  indexes: Record<string, string>;
}> {
  const constraints = await sql<{ name: string; kind: string; definition: string }[]>`
    select conname as name, contype as kind, pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid = ${table}::regclass and contype in ('c', 'x')
  `;
  const indexes = await sql<{ name: string; definition: string }[]>`
    select c.relname as name, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where i.indrelid = ${table}::regclass and not i.indisprimary
  `;
  const byKind = (kind: string): Record<string, string> =>
    Object.fromEntries(
      constraints.filter((row) => row.kind === kind).map((row) => [row.name, row.definition]),
    );
  return {
    checks: byKind("c"),
    excludes: byKind("x"),
    indexes: Object.fromEntries(
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1")]),
    ),
  };
}

/**
 * Empties every table the fixtures write but the registries: truncating the heads cascades to the rest, rules and
 * price_ok_limits among them (this file's schema only). Nothing the registries hold refers to them, so the migration's
 * seed stays as it was.
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/**
 * Loads fixture files with their `after` chains, each file once, as the runtime side; returns the rows per table the
 * chains give. A registry row is never inserted (only a migration's seed writes a registry, README rule 5): it is found
 * stored as given, as the migration wrote it.
 */
async function loadFixtures(files: readonly string[]): Promise<Record<string, number>> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen));
  for (const row of rows.filter((candidate) => REGISTRIES.includes(candidate.table))) {
    await expectStored(row);
  }
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows) {
      if (!REGISTRIES.includes(row.table)) {
        await insertRow(tx, row.table, row.values);
      }
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "rules" });
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

describe("the migration against the frozen table list (K-26 v1 rules)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
  };

  it("the table list names five tables: the three closed registries span businesses (scope none), with no version and no effective dates; rules and price_ok_limits are scoped by business on business_id, versioned, with effective dates", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      const scoped = SCOPED.includes(table.name);
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.versionColumn],
        table.name,
      ).toEqual(
        scoped ? ["business", "business_id", true, "version"] : ["none", undefined, false, undefined],
      );
      expect([table.effectiveDates, table.effectiveColumns], table.name).toEqual(
        scoped ? [true, ["effective_from", "effective_to"]] : [false, undefined],
      );
    }
    expect([...REGISTRIES, ...SCOPED].sort()).toEqual(OWN_TABLES);
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules, exclusions and index names are the table list's`, async () => {
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
      const foreignKeys = table.foreignKeys ?? [];
      const unique = table.unique ?? [];
      const exclude = table.exclude ?? [];
      // A unique rule with a where is a partial unique index (tables.meta.schema.json), which no constraint row holds.
      const plain = unique.filter((rule) => rule.where === undefined);
      const partial = unique.filter((rule) => rule.where !== undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual(exclude.map((rule) => rule.name).sort());
      for (const key of foreignKeys) {
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
          ...exclude.map((rule) => rule.name),
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

    it(`${table.name}: each check, each exclusion (its where too) and each index is the table list's own expression, as PostgreSQL reads both`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const checks = table.checks ?? [];
      const exclude = table.exclude ?? [];
      const partial = (table.unique ?? []).filter((rule) => rule.where !== undefined);
      const listed = await asOwner(async (tx) => {
        await tx`create temporary table probe (like ${tx(table.name)}) on commit drop`;
        for (const check of checks) {
          await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
        }
        for (const rule of exclude) {
          const elements = rule.elements.map(
            (element) => `${element.column ?? `(${element.expression ?? ""})`} with ${element.operator}`,
          );
          const where = rule.where === undefined ? "" : ` where (${rule.where})`;
          await tx.unsafe(
            `alter table probe add constraint ${rule.name} exclude using ${rule.using} (${elements.join(", ")})${where}`,
          );
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
      expect(Object.keys(listed.excludes).sort()).toEqual(exclude.map((rule) => rule.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(
        [...(table.indexes ?? []), ...partial, ...exclude].map((index) => index.name).sort(),
      );
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      expect(own.excludes).toEqual(listed.excludes);
      // A plain unique rule's own index is checked above by name and columns; the named, partial and exclusion
      // indexes here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("the two exclusions need no extension beyond 0001's: = on text through btree_gist (made in public by 0001), && on the range through PostgreSQL's own range_ops; only rules_one_in_effect is partial, leaving out the dates and note kinds", async () => {
    const [extension] = await db.sql<{ schema: string }[]>`
      select extnamespace::regnamespace::text as schema from pg_extension where extname = 'btree_gist'
    `;
    expect(extension?.schema).toBe("public");
    const classesOf = async (index: string): Promise<[string, string | null][]> => {
      const classes = await db.sql<{ opclass: string; extension: string | null }[]>`
        select o.opcname as opclass, e.extname as extension
        from pg_index i
          cross join lateral unnest(i.indclass::oid[]) with ordinality as k(opclass, position)
          join pg_opclass o on o.oid = k.opclass
          left join pg_depend d on d.classid = 'pg_opclass'::regclass and d.objid = o.oid and d.deptype = 'e'
          left join pg_extension e on e.oid = d.refobjid
        where i.indexrelid = ${`${db.schema}.${index}`}::regclass
        order by k.position
      `;
      return classes.map((row): [string, string | null] => [row.opclass, row.extension]);
    };
    const text: [string, string | null] = ["gist_text_ops", "btree_gist"];
    expect(await classesOf("rules_one_in_effect")).toEqual([text, text, text, text, ["range_ops", null]]);
    expect(await classesOf("price_ok_limits_one_in_effect")).toEqual([text, text, text, ["range_ops", null]]);
    const partial = await db.sql<{ name: string; partial: boolean }[]>`
      select c.relname as name, i.indpred is not null as partial
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relnamespace = ${db.schema}::regnamespace
        and c.relname in ('rules_one_in_effect', 'price_ok_limits_one_in_effect')
      order by c.relname
    `;
    expect(partial).toEqual([
      { name: "price_ok_limits_one_in_effect", partial: false },
      { name: "rules_one_in_effect", partial: true },
    ]);
  });

  it("rules and price_ok_limits raise their version on every update (0002's rule): <table>_version_raised, and no other trigger; the registries have none", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual(
      SCOPED.map((table) => [table, `${table}_version_raised`]),
    );
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
  });

  it("row-level security is on for rules and price_ok_limits, in T-191's pattern: 0012's two policies on business_id, <table>_tool_api for rosie_app and <table>_runtime for rosie_job; the registries keep it off and hold no policy; none is forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: SCOPED.includes(name), forced: false })));
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
      [...SCOPED, "outbox_rows"].sort(),
    );
    // 0012's shape, read from outbox_rows' two policies, which key on the same column (business_id).
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    expect(core).toHaveLength(2);
    for (const table of SCOPED) {
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

  it("grants (DL-149, each to its named reader: the migration's header; README rule 5): both roles select the registries and nothing more there; both select, insert and update rules and price_ok_limits and delete neither; no truncate, references or trigger; nothing to PUBLIC; no column grants", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const expected = (table: string): string[] =>
      REGISTRIES.includes(table) ? ["SELECT"] : ["INSERT", "SELECT", "UPDATE"];
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) =>
        OWN_TABLES.flatMap((table) => expected(table).map((privilege) => `${role} ${table} ${privilege}`)),
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

  it("the five refer only to K-04's businesses and persons and to each other (rule 1): no foreign key names a K-23 or K-24 table", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      TABLES.flatMap((table) =>
        (table.foreignKeys ?? []).map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
  });

  it("is recorded in schema_migrations as rules, after services_prices", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("rules");
    expect(names.indexOf("rules")).toBeGreaterThan(names.indexOf("services_prices"));
  });
});

describe("the closed registries: the migration's own seed is seed-rule-registry.json, row for row (C-157; README rules 3, 5 and 6)", () => {
  it("the fixture gives every column of each registry row, and the fresh schema holds exactly its rows: 28 plug-in facts, 6 plug-in switches and 16 rule kinds, each stored as given, and no other", async () => {
    expect(Object.fromEntries(REGISTRIES.map((table) => [table, registryCount(table)]))).toEqual({
      plugin_switches: 6,
      rule_kinds: 16,
      trade_facts: 28,
    });
    expect(REGISTRY_ROWS.every((row) => REGISTRIES.includes(row.table))).toBe(true);
    expect(fixtureFile(REGISTRY_SEED).after).toEqual([]);
    for (const row of REGISTRY_ROWS) {
      expect(Object.keys(row.values), `${row.table} ${JSON.stringify(keyOf(row))}`).toEqual(
        tableOf(row.table).columns.map((column) => column.name),
      );
      await expectStored(row);
    }
    expect(await registryRows(db.sql)).toEqual({ plugin_switches: 6, rule_kinds: 16, trade_facts: 28 });
  });

  it("the rule kinds as the README lists them: each kind's one value type and the fact the work must list before it is offered; note is the one note kind", async () => {
    const kinds = await db.sql<{ id: string; type: string; needs: string | null }[]>`
      select id, value_type as type, needs_fact as needs from rule_kinds order by id collate "C"
    `;
    expect(kinds.map((kind) => [kind.id, kind.type, kind.needs])).toEqual([
      ["bank_transfer_over", "money", "banktransfer"],
      ["deposit_cap", "money", null],
      ["fee_cap", "money", null],
      ["members_paying_elsewhere", "on", "packs"],
      ["minimum_job", "money", null],
      ["months_offered", "dates", null],
      ["no_show_count", "count", null],
      ["note", "note", null],
      ["notice", "span", null],
      ["ok_dates", "dates", null],
      ["ok_new_customer", "on", null],
      ["ok_same_day", "on", null],
      ["one_bill", "on", "monthlybill"],
      ["own_customers_only", "on", null],
      ["tip_line", "on", "tips"],
      ["waitlist", "on", "waitlist"],
    ]);
  });

  it("the facts are the master's 28 live ones and the switches its 5 live ones and nomoney, as the README lists them", async () => {
    const facts = await db.sql<{ name: string }[]>`select name from trade_facts order by name collate "C"`;
    expect(facts.map((fact) => fact.name)).toEqual(
      [
        "plans",
        "packs",
        "groups",
        "classes",
        "firststeps",
        "forms",
        "sentnow",
        "results",
        "planbill",
        "dropoff",
        "multiday",
        "spaces",
        "children",
        "incare",
        "animals",
        "video",
        "aftercare",
        "photos",
        "documents",
        "waitlist",
        "tips",
        "discounts",
        "stages",
        "monthlybill",
        "banktransfer",
        "extrawork",
        "nomoney",
        "capacitycheck",
      ].sort(),
    );
    const switches = await db.sql<
      { name: string }[]
    >`select name from plugin_switches order by name collate "C"`;
    expect(switches.map((one) => one.name)).toEqual(
      ["sensitive", "no2", "welfare", "cancelright", "verify", "nomoney"].sort(),
    );
  });

  it("every fact and switch K-23 v1's seeds name in a business's kinds is a registry entry, which code checks at each write since an array carries no foreign key (README 'Which part owns what')", async () => {
    const seen = new Set<string>();
    const kinds = SETUP_SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter(
      (row) => row.table === "company_kinds",
    );
    expect(kinds.length).toBeGreaterThan(0);
    const namesOf = (row: FixtureRow, column: string): string[] => {
      const value = row.values[column];
      if (!Array.isArray(value)) {
        throw new Error(`company_kinds.${column} is not a list`);
      }
      return value.map((name) => textOf(name));
    };
    const facts = new Set(
      (await db.sql<{ name: string }[]>`select name from trade_facts`).map((fact) => fact.name),
    );
    const switches = new Set(
      (await db.sql<{ name: string }[]>`select name from plugin_switches`).map((one) => one.name),
    );
    const named = kinds.flatMap((row) => namesOf(row, "pf_facts"));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !facts.has(name))).toEqual([]);
    const switched = kinds.flatMap((row) => [
      ...namesOf(row, "pf_switches_a"),
      ...namesOf(row, "pf_switches_b"),
    ]);
    expect(switched.length).toBeGreaterThan(0);
    expect(switched.filter((name) => !switches.has(name))).toEqual([]);
  });
});

describe("the seed fixtures load (fixtures/index.json): the three of 02-contracts' K-26 row, and the registry beyond it", () => {
  /** The K-26 rows the four seeds' chains give together, per table: every table gets rows. */
  const SEEDED = { plugin_switches: 6, price_ok_limits: 3, rule_kinds: 16, rules: 3, trade_facts: 28 };

  it("the index lists four seeds (the card's three and the registry) and two refused rows, all K-26 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual([...CARD_SEEDS, REGISTRY_SEED].sort());
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual(["invalid/refuse-overlapping-rule-dates.json", "invalid/refuse-unknown-rule-kind.json"]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file}${CARD_SEEDS.includes(file) ? " (the card's)" : " (the migration's own seed)"} loads alone with its after chain, as the runtime side: each registry row it names is found as the migration wrote it, and every other K-26 row is inserted and stored as given`,
      SLOW,
      async () => {
        await reset();
        const chain = fixtureRows(new URL(file, FIXTURES_DIR), new Set());
        const loaded = await loadFixtures([file]);
        for (const table of OWN_TABLES) {
          const given = chain.filter((row) => row.table === table);
          expect(loaded[table] ?? 0, `${file}: ${table}`).toBe(given.length);
          // A registry holds the migration's seed whatever a chain names; the two scoped tables hold the chain's rows.
          expect(await countRows(db.sql, table), `${file}: ${table} stored`).toBe(
            REGISTRIES.includes(table) ? registryCount(table) : given.length,
          );
          for (const row of given) {
            await expectStored(row);
          }
        }
        expect(fixtureFile(file).rows.some((row) => OWN_TABLES.includes(row.table))).toBe(true);
      },
    );
  }

  it("the card's three load together, each after chain once", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(CARD_SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await visibleRows(db.sql)).toEqual({ price_ok_limits: 3, rules: 3 });
  });

  it(
    "all four load together with every K-04 v1 and K-23 v1 seed as well, each file once, and every K-26 row is stored as given",
    SLOW,
    async () => {
      await reset();
      expect([CORE_SEEDS.length > 0, SETUP_SEEDS.length > 0]).toEqual([true, true]);
      const loaded = await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual({ price_ok_limits: 3, rules: 3 });
      expect(await registryRows(db.sql)).toEqual({ plugin_switches: 6, rule_kinds: 16, trade_facts: 28 });
      for (const row of SEED_ROWS) {
        await expectStored(row);
      }
    },
  );
});

describe("the seeded rows: what the four seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("Lee's Barbershop's tap list kept as shown (S1-21): same-day and new customers ask Sam first, two on rules for the whole business from 2:12pm Mon Oct 19, still in effect, whose kinds need no fact; color quotes come to Sam first as flow A quotes over $0, and no bill needs an OK; each set by Sam, the barbershop's owner", async () => {
    const rules = await db.sql<
      {
        kind: string;
        type: string;
        value: boolean | null;
        flow: string | null;
        work: string | null;
        starts: Date;
        ends: Date | null;
        setter: string;
        needs: string | null;
      }[]
    >`
      select r.rule_kind as kind, r.value_type as type, r.value_on as value, r.flow, r.kind_id as work,
             r.effective_from as starts, r.effective_to as ends, r.set_by_person_id as setter, k.needs_fact as needs
      from rules r join rule_kinds k on k.id = r.rule_kind and k.value_type = r.value_type
      where r.business_id = ${BARBERSHOP} and r.value_type = 'on'
      order by r.rule_kind collate "C"
    `;
    const kept = {
      type: "on",
      value: true,
      flow: null,
      work: null,
      starts: new Date(TAP_LIST_KEPT),
      ends: null,
      setter: "person-sam",
      needs: null,
    };
    expect(rules).toEqual([
      { kind: "ok_new_customer", ...kept },
      { kind: "ok_same_day", ...kept },
    ]);
    const limits = await db.sql<
      {
        flow: string | null;
        work: string | null;
        quotes: boolean;
        bills: boolean;
        cents: number;
        currency: string;
      }[]
    >`
      select flow, kind_id as work, quotes, bills, over_cents as cents, currency from price_ok_limits
      where id = ${COLOR_QUOTES_ID}
    `;
    expect(limits).toEqual([
      { flow: "A", work: null, quotes: true, bills: false, cents: 0, currency: "USD" },
    ]);
    const roles = await db.sql<{ role: string }[]>`
      select role from person_roles where person_id = 'person-sam' and business_id = ${BARBERSHOP}
    `;
    expect(roles).toEqual([{ role: "owner" }]);
  });

  it("Sam's $500 limit for Lee Home Services covers quotes and bills in both flows and every kind; the barbershop's barbers in flow B, a scope more specific than the tap list's flow A row, send any wedding party quote over $500 to Sam first", async () => {
    const limits = await db.sql<
      {
        id: string;
        business: string;
        flow: string | null;
        work: string | null;
        quotes: boolean;
        bills: boolean;
        cents: number;
        currency: string;
        open: boolean;
      }[]
    >`
      select id, business_id as business, flow, kind_id as work, quotes, bills, over_cents as cents, currency,
             effective_to is null as open
      from price_ok_limits order by id collate "C"
    `;
    expect(limits).toEqual([
      {
        id: "pok-lee-home-services",
        business: HOME_SERVICES,
        flow: null,
        work: null,
        quotes: true,
        bills: true,
        cents: 50000,
        currency: "USD",
        open: true,
      },
      {
        id: "pok-lees-barbershop-barber-flow-b",
        business: BARBERSHOP,
        flow: "B",
        work: "barber",
        quotes: true,
        bills: false,
        cents: 50000,
        currency: "USD",
        open: true,
      },
      {
        id: COLOR_QUOTES_ID,
        business: BARBERSHOP,
        flow: "A",
        work: null,
        quotes: true,
        bills: false,
        cents: 0,
        currency: "USD",
        open: true,
      },
    ]);
  });

  it("who may book a kids cut is saved only as a note for the barber kind (arch 09 line 482): the kind note, Sam's words, no typed value; the kind is what tells the read-back it was saved only as a note", async () => {
    const notes = await db.sql<
      {
        kind: string;
        type: string;
        work: string | null;
        flow: string | null;
        words: string | null;
        typed: number;
        means: string;
      }[]
    >`
      select r.rule_kind as kind, r.value_type as type, r.kind_id as work, r.flow, r.words,
             num_nonnulls(r.value_on, r.value_cents, r.value_currency, r.value_span, r.value_count, r.value_dates)
               as typed,
             k.means
      from rules r join rule_kinds k on k.id = r.rule_kind
      where r.business_id = ${BARBERSHOP} and r.value_type = 'note'
    `;
    expect(notes).toEqual([
      {
        kind: "note",
        type: "note",
        work: "barber",
        flow: null,
        words: textOf(KIDS_CUT_NOTE.words),
        typed: 0,
        means: textOf(NOTE_KIND.means),
      },
    ]);
  });

  it("bookings follow the rules in effect when they are made (S11-57; README 'Effective dates and scope'): a minute before 2:12pm Mon Oct 19 none of the barbershop's rules or limits holds; from 2:12pm the two on rules, the note and both limits do, and still on Nov 2", async () => {
    const heldAt = async (instant: string): Promise<string[]> => {
      const rows = await db.sql<{ id: string }[]>`
        select id from (
          select id, effective_from, effective_to from rules where business_id = ${BARBERSHOP}
          union all
          select id, effective_from, effective_to from price_ok_limits where business_id = ${BARBERSHOP}
        ) as held
        where tstzrange(effective_from, effective_to, '[)') @> ${instant}::timestamptz
        order by id collate "C"
      `;
      return rows.map((row) => row.id);
    };
    const all = [
      "pok-lees-barbershop-barber-flow-b",
      COLOR_QUOTES_ID,
      "rule-lees-barbershop-note-kids-cut",
      NEW_CUSTOMER_ID,
      SAME_DAY_ID,
    ];
    expect(await heldAt("2026-10-19T18:11:00Z")).toEqual([]);
    expect(await heldAt(TAP_LIST_KEPT)).toEqual(all);
    expect(await heldAt(NOV_2)).toEqual(all);
  });
});

describe("effective dates: one rule of a kind and one price OK limit in effect per scope (README 'Effective dates and scope'; arch 09 line 488; S11-57)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it(
    "by the Tool API, S11-57's change for new bookings only: a second new-customer rule while the kept one is open is refused (23P01); the kept one closed at the start of Mon Nov 2 (raising its version) and the next opened at that instant pass; a booking made a microsecond before Nov 2 follows the old one, from Nov 2 the new one; a row closed at its own start is refused (23514), and a rule is never deleted (42501)",
    SLOW,
    async () => {
      const nextId = "rule-lees-barbershop-ok-new-customer-nov-2";
      const next: Values = { ...NEW_CUSTOMER, id: nextId, value_on: false, effective_from: NOV_2 };
      const outcome = await as(TOOL_API, BARBERSHOP, async (tx) => {
        const over = await refusal(tx.savepoint((sp) => insertReturning(sp, "rules", next)));
        const closed = await tx<{ version: number }[]>`
          update rules set effective_to = ${NOV_2}, version = version + 1
          where id = ${NEW_CUSTOMER_ID} and effective_to is null
          returning version
        `;
        const opened = (await insertReturning(tx, "rules", next)).length;
        const before = await inEffect(tx, BARBERSHOP, "ok_new_customer", "2026-11-02T04:59:59.999999Z");
        const atChange = await inEffect(tx, BARBERSHOP, "ok_new_customer", NOV_2);
        const sameDay = await inEffect(tx, BARBERSHOP, "ok_same_day", NOV_2);
        const atOwnStart = await refusal(
          tx.savepoint(
            (sp) => sp`
              update rules set effective_to = effective_from, version = version + 1 where id = ${nextId}
            `,
          ),
        );
        const removed = await refusal(
          tx.savepoint((sp) => sp`delete from rules where id = ${NEW_CUSTOMER_ID}`),
        );
        return {
          over: [over.code, over.constraint],
          closed,
          opened,
          before,
          atChange,
          sameDay,
          atOwnStart: [atOwnStart.code, atOwnStart.constraint],
          removed: [removed.code, removed.message],
        };
      });
      expect(outcome).toEqual({
        over: ["23P01", "rules_one_in_effect"],
        closed: [{ version: 2 }],
        opened: 1,
        before: [NEW_CUSTOMER_ID],
        atChange: [nextId],
        sameDay: [SAME_DAY_ID],
        atOwnStart: ["23514", "rules_dates_in_order"],
        removed: ["42501", "permission denied for table rules"],
      });
    },
  );

  it(
    "a price OK change by the Tool API: a second limit in one scope while one is open is refused (23P01); Lee Home Services' limit closed at the start of Mon Nov 2 and the next opened at that instant pass; one from inside the old one's dates is refused (23P01); a limit for one kind of work stands beside the business's",
    SLOW,
    async () => {
      const next: Values = {
        ...HOME_SERVICES_LIMIT,
        id: "pok-lee-home-services-nov-2",
        over_cents: 40000,
        effective_from: NOV_2,
      };
      const outcome = await as(TOOL_API, HOME_SERVICES, async (tx) => {
        const over = await refusal(tx.savepoint((sp) => insertReturning(sp, "price_ok_limits", next)));
        const closed = await tx<{ version: number }[]>`
          update price_ok_limits set effective_to = ${NOV_2}, version = version + 1
          where id = 'pok-lee-home-services' and effective_to is null
          returning version
        `;
        const opened = (await insertReturning(tx, "price_ok_limits", next)).length;
        const inside = await refusal(
          tx.savepoint((sp) =>
            insertReturning(sp, "price_ok_limits", {
              ...HOME_SERVICES_LIMIT,
              id: "pok-lee-home-services-oct-26",
              effective_from: "2026-10-26T04:00:00Z",
              effective_to: "2026-10-27T04:00:00Z",
            }),
          ),
        );
        const beside = (await insertReturning(tx, "price_ok_limits", PLUMBER_LIMIT)).length;
        const rows = await tx<{ id: string; cents: number; open: boolean }[]>`
          select id, over_cents as cents, effective_to is null as open from price_ok_limits
          order by effective_from, id collate "C"
        `;
        return {
          over: [over.code, over.constraint],
          closed,
          opened,
          inside: [inside.code, inside.constraint],
          beside,
          rows,
        };
      });
      expect(outcome).toEqual({
        over: ["23P01", "price_ok_limits_one_in_effect"],
        closed: [{ version: 2 }],
        opened: 1,
        inside: ["23P01", "price_ok_limits_one_in_effect"],
        beside: 1,
        rows: [
          { id: "pok-lee-home-services", cents: 50000, open: false },
          { id: "pok-lee-home-services-plumber", cents: 50000, open: true },
          { id: "pok-lee-home-services-nov-2", cents: 40000, open: true },
        ],
      });
    },
  );

  it(
    "a dates kind and the note kind may have several rows in effect in one scope (two overlapping date ranges, a second note for the barber kind); every other kind one at a time per scope (23P01); a rule for one kind of work, or for one flow, stands beside the business's",
    SLOW,
    async () => {
      const outcome = await as(RUNTIME, null, async (tx) => {
        const added = [
          ...(await insertReturning(tx, "rules", OK_DATES)),
          ...(await insertReturning(tx, "rules", {
            ...OK_DATES,
            id: "rule-lees-barbershop-ok-dates-2",
            value_dates: "[2026-11-27,2026-11-30)",
          })),
          ...(await insertReturning(tx, "rules", SECOND_NOTE)),
          ...(await insertReturning(tx, "rules", BARBER_SAME_DAY)),
          ...(await insertReturning(tx, "rules", {
            ...SAME_DAY,
            id: "rule-lees-barbershop-ok-same-day-flow-b",
            flow: "B",
          })),
        ].length;
        const [dates] = await tx<{ n: number }[]>`
          select count(*)::int as n from rules
          where business_id = ${BARBERSHOP} and rule_kind = 'ok_dates' and value_dates @> '2026-11-27'::date
        `;
        const notes = await inEffect(tx, BARBERSHOP, "note", NOV_2);
        const twice = await refusal(
          tx.savepoint((sp) =>
            insertReturning(sp, "rules", { ...SAME_DAY, id: "rule-lees-barbershop-ok-same-day-again" }),
          ),
        );
        const barberTwice = await refusal(
          tx.savepoint((sp) =>
            insertReturning(sp, "rules", {
              ...BARBER_SAME_DAY,
              id: "rule-lees-barbershop-ok-same-day-barber-2",
            }),
          ),
        );
        return {
          added,
          dates: dates?.n,
          notes,
          twice: [twice.code, twice.constraint],
          barberTwice: [barberTwice.code, barberTwice.constraint],
        };
      });
      expect(outcome).toEqual({
        added: 5,
        dates: 2,
        notes: ["rule-lees-barbershop-note-kids-cut", "rule-lees-barbershop-note-kids-cut-2"],
        twice: ["23P01", "rules_one_in_effect"],
        barberTwice: ["23P01", "rules_one_in_effect"],
      });
    },
  );
});

describe("row-level security per business on rules and price_ok_limits, every K-04 v1, K-23 v1 and K-26 v1 seed loaded; the registries every role's to read and no application role's to write", () => {
  const files = [...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS];
  const zeros = Object.fromEntries(SCOPED.map((table) => [table, 0]));

  beforeAll(async () => {
    await reset();
    await loadFixtures(files);
  }, 60_000);

  it(
    "with no scope the Tool API reads no row of the two; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's rules or price OK limits",
    SLOW,
    async () => {
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual(businessesOf(files));
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await ownerRows(BARBERSHOP)).toEqual({ price_ok_limits: 2, rules: 3 });
      expect(await ownerRows(HOME_SERVICES)).toEqual({ price_ok_limits: 1, rules: 0 });
      expect(await as(TOOL_API, YOGA_STUDIO, visibleRows)).toEqual(zeros);
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

  it(
    "the Tool API writes only its scope's rows: another business's insert is refused (42501), its update finds no row, a row cannot move to another business, and a rule or a price OK limit is never deleted (42501)",
    SLOW,
    async () => {
      const addRule = (tx: Tx) => insertReturning(tx, "rules", BARBER_SAME_DAY);
      expect((await refusal(as(TOOL_API, YOGA_STUDIO, addRule))).code).toBe("42501");
      expect(await as(TOOL_API, BARBERSHOP, addRule)).toHaveLength(1);
      const addLimit = (tx: Tx) => insertReturning(tx, "price_ok_limits", PLUMBER_LIMIT);
      expect((await refusal(as(TOOL_API, BARBERSHOP, addLimit))).code).toBe("42501");
      expect(await as(TOOL_API, HOME_SERVICES, addLimit)).toHaveLength(1);
      const bump = (tx: Tx) => tx<{ version: number }[]>`
        update rules set version = version + 1 where id = ${SAME_DAY_ID} returning version
      `;
      expect(await as(TOOL_API, YOGA_STUDIO, bump)).toHaveLength(0);
      expect(await as(TOOL_API, BARBERSHOP, bump)).toEqual([{ version: 2 }]);
      const move = (tx: Tx) => tx`
        update price_ok_limits set business_id = ${YOGA_STUDIO}, version = version + 1 where id = ${COLOR_QUOTES_ID}
      `;
      expect((await refusal(as(TOOL_API, BARBERSHOP, move))).code).toBe("42501");
      for (const table of SCOPED) {
        const removed = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    },
  );

  it(
    "the runtime side scoped to one business (per write) cannot write another's row; with no scope it writes; it deletes nothing (42501)",
    SLOW,
    async () => {
      const addRule = (tx: Tx) => insertReturning(tx, "rules", BARBER_SAME_DAY);
      expect((await refusal(as(RUNTIME, YOGA_STUDIO, addRule))).code).toBe("42501");
      expect(await as(RUNTIME, null, addRule)).toHaveLength(1);
      for (const table of SCOPED) {
        const removed = await refusal(as(RUNTIME, null, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    },
  );

  it(
    "every update of rules and price_ok_limits raises the version by exactly one: one that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes, under the barbershop's Tool API scope",
    SLOW,
    async () => {
      const targets: [string, string][] = [
        ["price_ok_limits", COLOR_QUOTES_ID],
        ["rules", SAME_DAY_ID],
      ];
      expect(targets.map(([table]) => table)).toEqual(SCOPED);
      for (const [table, id] of targets) {
        const kept = await refusal(
          as(TOOL_API, BARBERSHOP, (tx) => tx`update ${tx(table)} set version = version where id = ${id}`),
        );
        expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
        const raised = await as(
          TOOL_API,
          BARBERSHOP,
          (tx) => tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where id = ${id} returning version
          `,
        );
        expect(raised, table).toEqual([{ version: 2 }]);
      }
    },
  );

  it(
    "the registries are every role's to read, under any business's scope or none; no application role may write them: an insert (a Tool API call's among them), an update, a delete or a truncate is refused by privilege (42501), scoped or not",
    SLOW,
    async () => {
      const all = await registryRows(db.sql);
      expect(all).toEqual({ plugin_switches: 6, rule_kinds: 16, trade_facts: 28 });
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
          expect(await as(role, scope, registryRows), `${role} ${String(scope)}`).toEqual(all);
        }
      }
      const writes: [string, (tx: Tx) => Promise<unknown>][] = [
        [
          "trade_facts",
          (tx) => insertReturning(tx, "trade_facts", { ...WAITLIST_FACT, name: "waitlistcopy" }),
        ],
        [
          "rule_kinds",
          (tx) => insertReturning(tx, "rule_kinds", { ...SAME_DAY_KIND, id: "ok_same_day_copy" }),
        ],
        ["plugin_switches", (tx) => tx`update plugin_switches set means = means where name = 'verify'`],
        ["rule_kinds", (tx) => tx`delete from rule_kinds where id = 'note'`],
        ["trade_facts", (tx) => tx`truncate trade_facts`],
      ];
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const [table, write] of writes) {
            const refused = await refusal(as(role, scope, write));
            expect([refused.code, refused.message], `${role} ${String(scope)} ${table}`).toEqual([
              "42501",
              `permission denied for table ${table}`,
            ]);
          }
        }
      }
      expect(await registryRows(db.sql)).toEqual(all);
    },
  );
});

describe("a new kind of rule is a registry row, never a column (arch 09 line 480; README rule 6; the card's Gives)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("a rule of a kind the registry lacks is refused under the barbershop's Tool API scope (rules_kind_fk, 23503); once a migration's seed adds the kind's row (here the migrations' role, rolled back), the same rule passes there, and rules keeps the table list's columns", async () => {
    const kind: Values = { ...SAME_DAY_KIND, id: "ok_same_day_copy" };
    const rule: Values = {
      ...SAME_DAY,
      id: "rule-lees-barbershop-ok-same-day-copy",
      rule_kind: "ok_same_day_copy",
    };
    const before = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "rules", rule)));
    expect([before.code, before.constraint]).toEqual(["23503", "rules_kind_fk"]);
    const after = await asOwner(async (tx) => {
      await insertRow(tx, "rule_kinds", kind);
      await tx.unsafe(`set local role ${TOOL_API}`);
      await tx`select set_config('rosie.business_id', ${BARBERSHOP}, true)`;
      return insertReturning(tx, "rules", rule);
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: "rule-lees-barbershop-ok-same-day-copy",
      business_id: BARBERSHOP,
      rule_kind: "ok_same_day_copy",
      value_type: "on",
      value_on: true,
    });
    const columns = await db.sql<{ name: string }[]>`
      select attname as name from pg_attribute
      where attrelid = ${`${db.schema}.rules`}::regclass and attnum > 0 and not attisdropped
      order by attnum
    `;
    expect(columns.map((column) => column.name)).toEqual(
      tableOf("rules").columns.map((column) => column.name),
    );
    // Rolled back: the registry is the migration's seed again.
    expect(await registryRows(db.sql)).toEqual({ plugin_switches: 6, rule_kinds: 16, trade_facts: 28 });
  });
});

describe("the rules the table list holds: each row that breaks one rule is refused by that rule alone, and the README's valid forms pass", () => {
  const rule = (fault: Values) => insertEach(["rules", { ...BARBER_SAME_DAY, ...fault }]);
  const minimum = (fault: Values) => insertEach(["rules", { ...MINIMUM_JOB, ...fault }]);
  const note = (fault: Values) => insertEach(["rules", { ...SECOND_NOTE, ...fault }]);
  const limit = (fault: Values) => insertEach(["price_ok_limits", { ...PLUMBER_LIMIT, ...fault }]);

  /** Each probe breaks exactly one rule; each is run on the runtime side with no scope, so only that rule refuses it. */
  const PROBES: {
    breaks: string;
    run: (tx: Tx) => Promise<readonly unknown[]>;
    code: string;
    rule: string;
  }[] = [
    {
      breaks: "a value of another type than its kind's (money for the same-day kind)",
      run: rule({ value_type: "money", value_on: null, value_cents: 0, value_currency: "USD" }),
      code: "23503",
      rule: "rules_kind_fk",
    },
    {
      breaks: "a fact's name as a kind (tips is a fact; tip_line is the kind)",
      run: rule({ rule_kind: "tips" }),
      code: "23503",
      rule: "rules_kind_fk",
    },
    {
      breaks: "an on kind with no value",
      run: rule({ value_on: null }),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "an on kind with an amount beside its value",
      run: rule({ value_cents: 0, value_currency: "USD" }),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "a money value without its currency",
      run: minimum({ value_currency: null }),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "an on value on a money kind",
      run: minimum({ value_on: true, value_cents: null, value_currency: null }),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "a dates kind given a span instead",
      run: insertEach(["rules", { ...OK_DATES, value_dates: null, value_span: "1 day" }]),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "a note with an on value",
      run: note({ value_on: true }),
      code: "23514",
      rule: "rules_value_matches_type",
    },
    {
      breaks: "negative cents",
      run: minimum({ value_cents: -1 }),
      code: "23514",
      rule: "rules_value_in_range",
    },
    {
      breaks: "a lower-case currency on a rule",
      run: minimum({ value_currency: "usd" }),
      code: "23514",
      rule: "rules_value_in_range",
    },
    {
      breaks: "a notice of zero",
      run: insertEach(["rules", { ...NOTICE, value_span: "0 minutes" }]),
      code: "23514",
      rule: "rules_value_in_range",
    },
    {
      breaks: "a negative notice",
      run: insertEach(["rules", { ...NOTICE, value_span: "-2 hours" }]),
      code: "23514",
      rule: "rules_value_in_range",
    },
    {
      breaks: "a no-show count of 0",
      run: insertEach(["rules", { ...NO_SHOW_COUNT, value_count: 0 }]),
      code: "23514",
      rule: "rules_value_in_range",
    },
    {
      breaks: "an empty date range",
      run: insertEach(["rules", { ...OK_DATES, value_dates: "[2026-11-26,2026-11-26)" }]),
      code: "23514",
      rule: "rules_value_in_range",
    },
    { breaks: "a flow C", run: rule({ flow: "C" }), code: "23514", rule: "rules_flow_known" },
    {
      breaks: "a kind of work out of form",
      run: rule({ kind_id: "Barber" }),
      code: "23514",
      rule: "rules_kind_id_form",
    },
    {
      breaks: "a note without words",
      run: note({ words: null }),
      code: "23514",
      rule: "rules_note_has_words",
    },
    {
      breaks: "a note of blank words",
      run: note({ words: "   " }),
      code: "23514",
      rule: "rules_note_has_words",
    },
    {
      breaks: "a rule closed at its own start",
      run: rule({ effective_to: TAP_LIST_KEPT }),
      code: "23514",
      rule: "rules_dates_in_order",
    },
    {
      breaks: "a rule closed before its own start",
      run: rule({ effective_to: "2026-10-19T18:00:00Z" }),
      code: "23514",
      rule: "rules_dates_in_order",
    },
    {
      breaks: "a setter who is no person",
      run: rule({ set_by_person_id: "person-nobody" }),
      code: "23503",
      rule: "rules_set_by_fk",
    },
    {
      breaks: "a business that does not exist",
      run: rule({ business_id: "biz-nobody" }),
      code: "23503",
      rule: "rules_business_fk",
    },
    {
      breaks: "the same kind in the same scope while one is in effect",
      run: insertEach(["rules", { ...SAME_DAY, id: "rule-lees-barbershop-ok-same-day-again" }]),
      code: "23P01",
      rule: "rules_one_in_effect",
    },
    {
      breaks: "a rule from inside another's dates",
      run: insertEach([
        "rules",
        {
          ...SAME_DAY,
          id: "rule-lees-barbershop-ok-same-day-oct-26",
          effective_from: "2026-10-26T04:00:00Z",
          effective_to: "2026-10-27T04:00:00Z",
        },
      ]),
      code: "23P01",
      rule: "rules_one_in_effect",
    },
    {
      breaks: "a price OK limit covering nothing",
      run: limit({ quotes: false, bills: false }),
      code: "23514",
      rule: "price_ok_limits_covers_something",
    },
    {
      breaks: "a negative amount",
      run: limit({ over_cents: -1 }),
      code: "23514",
      rule: "price_ok_limits_money",
    },
    {
      breaks: "a lower-case currency on a limit",
      run: limit({ currency: "usd" }),
      code: "23514",
      rule: "price_ok_limits_money",
    },
    {
      breaks: "a limit in flow C",
      run: limit({ flow: "C" }),
      code: "23514",
      rule: "price_ok_limits_flow_known",
    },
    {
      breaks: "a limit's kind of work out of form",
      run: limit({ kind_id: "Plumber" }),
      code: "23514",
      rule: "price_ok_limits_kind_id_form",
    },
    {
      breaks: "a limit closed at its own start",
      run: limit({ effective_to: TAP_LIST_KEPT }),
      code: "23514",
      rule: "price_ok_limits_dates_in_order",
    },
    {
      breaks: "a limit set by no person",
      run: limit({ set_by_person_id: "person-nobody" }),
      code: "23503",
      rule: "price_ok_limits_set_by_fk",
    },
    {
      breaks: "a limit of a business that does not exist",
      run: limit({ business_id: "biz-nobody" }),
      code: "23503",
      rule: "price_ok_limits_business_fk",
    },
    {
      breaks: "a second limit in one scope while one is in effect",
      run: insertEach(["price_ok_limits", { ...HOME_SERVICES_LIMIT, id: "pok-lee-home-services-again" }]),
      code: "23P01",
      rule: "price_ok_limits_one_in_effect",
    },
  ];

  /** The README's valid forms (its check of 2026-11-07), each passing on the runtime side. */
  const VALID: { form: string; run: (tx: Tx) => Promise<readonly unknown[]> }[] = [
    { form: "a same-day rule for the barber kind beside the business's", run: rule({}) },
    {
      form: "a same-day rule for flow B beside the business's",
      run: insertEach(["rules", { ...SAME_DAY, id: "rule-lees-barbershop-ok-same-day-flow-b", flow: "B" }]),
    },
    { form: "limit 2's $250 minimum job", run: minimum({}) },
    { form: "a notice of 2 hours", run: insertEach(["rules", NOTICE]) },
    { form: "a no-show count of 2", run: insertEach(["rules", NO_SHOW_COUNT]) },
    {
      form: "two overlapping date ranges in one scope",
      run: insertEach(
        ["rules", OK_DATES],
        [
          "rules",
          { ...OK_DATES, id: "rule-lees-barbershop-ok-dates-2", value_dates: "[2026-11-27,2026-11-30)" },
        ],
      ),
    },
    {
      form: "months offered, a dates kind",
      run: insertEach([
        "rules",
        {
          ...OK_DATES,
          id: "rule-lees-barbershop-months-offered",
          rule_kind: "months_offered",
          value_dates: "[2026-04-01,2026-11-01)",
        },
      ]),
    },
    { form: "a second note in one scope", run: note({}) },
    {
      form: "a typed rule that keeps the owner's words",
      run: rule({ words: "Same-day and new customers: Ask you first" }),
    },
    {
      form: "members who pay elsewhere turned off by a row with value off (its unset default is on)",
      run: insertEach([
        "rules",
        {
          ...SAME_DAY,
          id: "rule-yoga-studio-members-paying-elsewhere",
          business_id: YOGA_STUDIO,
          rule_kind: "members_paying_elsewhere",
          value_on: false,
        },
      ]),
    },
    { form: "a price OK limit for the plumber kind beside the business's", run: limit({}) },
    { form: "a bills-only limit of $0", run: limit({ quotes: false, bills: true, over_cents: 0 }) },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  for (const { breaks, run, code, rule: name } of PROBES) {
    it(`${breaks}: refused by ${name} (${code})`, async () => {
      const outcome = await refusal(as(RUNTIME, null, run));
      expect([outcome.code, outcome.constraint]).toEqual([code, name]);
    });
  }

  for (const { form, run } of VALID) {
    it(`${form}: passes`, async () => {
      expect(await as(RUNTIME, null, run)).toHaveLength(1);
    });
  }
});

describe("the registries' own rules, checked as the migrations' role (the only writer, README rule 5), each probe rolled back", () => {
  /** Each probe breaks exactly one rule of a registry. */
  const PROBES: { breaks: string; run: (tx: Tx) => Promise<unknown>; code: string; rule: string }[] = [
    {
      breaks: "a rule kind needing a fact the registry lacks (memberships, merged into packs)",
      run: (tx) =>
        insertReturning(tx, "rule_kinds", {
          ...SAME_DAY_KIND,
          id: "ok_same_day_copy",
          needs_fact: "memberships",
        }),
      code: "23503",
      rule: "rule_kinds_needs_fact_fk",
    },
    {
      breaks: "a second note kind",
      run: (tx) => insertReturning(tx, "rule_kinds", { ...NOTE_KIND, id: "note_copy" }),
      code: "23514",
      rule: "rule_kinds_note_is_note",
    },
    {
      breaks: "the kind note of another type (its check is tested before its key)",
      run: (tx) => insertReturning(tx, "rule_kinds", { ...NOTE_KIND, value_type: "on" }),
      code: "23514",
      rule: "rule_kinds_note_is_note",
    },
    {
      breaks: "a value type outside the list (a share)",
      run: (tx) =>
        insertReturning(tx, "rule_kinds", {
          ...SAME_DAY_KIND,
          id: "ok_same_day_copy",
          value_type: "percent",
        }),
      code: "23514",
      rule: "rule_kinds_value_type_known",
    },
    {
      breaks: "a kind name out of form",
      run: (tx) => insertReturning(tx, "rule_kinds", { ...SAME_DAY_KIND, id: "ok-same-day-copy" }),
      code: "23514",
      rule: "rule_kinds_id_form",
    },
    {
      breaks: "a kind given twice",
      run: (tx) => insertReturning(tx, "rule_kinds", SAME_DAY_KIND),
      code: "23505",
      rule: "rule_kinds_pkey",
    },
    {
      breaks: "a fact name out of form",
      run: (tx) => insertReturning(tx, "trade_facts", { ...WAITLIST_FACT, name: "wait_list" }),
      code: "23514",
      rule: "trade_facts_name_form",
    },
    {
      breaks: "a fact given twice",
      run: (tx) => insertReturning(tx, "trade_facts", WAITLIST_FACT),
      code: "23505",
      rule: "trade_facts_pkey",
    },
    {
      breaks: "a switch name out of form",
      run: (tx) => insertReturning(tx, "plugin_switches", { ...VERIFY_SWITCH, name: "Verify" }),
      code: "23514",
      rule: "plugin_switches_name_form",
    },
    {
      breaks: "a switch given twice",
      run: (tx) => insertReturning(tx, "plugin_switches", VERIFY_SWITCH),
      code: "23505",
      rule: "plugin_switches_pkey",
    },
    {
      breaks: "removing a fact a kind needs",
      run: (tx) => tx`delete from trade_facts where name = 'waitlist'`,
      code: "23503",
      rule: "rule_kinds_needs_fact_fk",
    },
    {
      breaks: "removing a kind a kept rule names",
      run: (tx) => tx`delete from rule_kinds where id = 'ok_same_day'`,
      code: "23503",
      rule: "rules_kind_fk",
    },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  for (const { breaks, run, code, rule } of PROBES) {
    it(`${breaks}: refused by ${rule} (${code})`, async () => {
      const outcome = await refusal(asOwner(run));
      expect([outcome.code, outcome.constraint]).toEqual([code, rule]);
    });
  }

  it("every probe was rolled back: the registries are the migration's seed", async () => {
    expect(await registryRows(db.sql)).toEqual({ plugin_switches: 6, rule_kinds: 16, trade_facts: 28 });
  });
});

describe("invalid/refuse-unknown-rule-kind.json: S1-21's phone-line row as a rule of a kind the registry does not hold (C-236)", () => {
  const file = "invalid/refuse-unknown-rule-kind.json";
  const refused = refusedOf(file);
  const scope = refused.scope?.businessId ?? null;
  const attempt =
    (change: Values) =>
    (tx: Tx): Promise<Record<string, unknown>[]> =>
      insertReturning(tx, refused.table, { ...(refused.values ?? {}), ...change });

  beforeAll(async () => {
    await reset();
    // The fixture's after chain (the registry, the migration's own, and K-04's people); its own rows: none.
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the Tool API, scoped to the barbershop, inserts a rule of kind phone_line; refused by rules_kind_fk (23503), never by privilege", async () => {
    expect([refused.role, refused.action, refused.table, scope]).toEqual([
      "toolApi",
      "insert",
      "rules",
      BARBERSHOP,
    ]);
    const outcome = await refusal(as(roleOf(refused), scope, attempt({})));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
    expect(await countRows(db.sql, "rules")).toBe(0);
  });

  it("without its one fault (the registry kind ok_same_day) the same insert passes in the same scope", async () => {
    const done = await as(roleOf(refused), scope, attempt({ rule_kind: "ok_same_day" }));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: "rule-lees-barbershop-phone-line",
      business_id: BARBERSHOP,
      rule_kind: "ok_same_day",
      value_type: "on",
      value_on: true,
    });
  });
});

describe("invalid/refuse-overlapping-rule-dates.json: a second new-customer rule from Nov 2 while the kept one is in effect", () => {
  const file = "invalid/refuse-overlapping-rule-dates.json";
  const refused = refusedOf(file);
  const scope = refused.scope?.businessId ?? null;
  const insert = (tx: Tx): Promise<Record<string, unknown>[]> =>
    insertReturning(tx, refused.table, refused.values ?? {});

  beforeAll(async () => {
    await reset();
    // The fixture's after chain: the tap list, with the new-customer rule kept and open.
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the Tool API, scoped to the barbershop, inserts the new-customer rule from Mon Nov 2 while the kept one is open; refused by rules_one_in_effect (23P01), never by privilege", async () => {
    expect([refused.role, refused.action, refused.table, scope]).toEqual([
      "toolApi",
      "insert",
      "rules",
      BARBERSHOP,
    ]);
    const outcome = await refusal(as(roleOf(refused), scope, insert));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (the kept rule closed at that instant first, as a change closes one row and opens the next) the same insert passes in the same scope, and the rule in effect is the kept one until Nov 2 and the new one from then", async () => {
    const outcome = await as(roleOf(refused), scope, async (tx) => {
      const closed = await tx<{ id: string }[]>`
        update rules set effective_to = ${NOV_2}, version = version + 1
        where id = ${NEW_CUSTOMER_ID} and effective_to is null
        returning id
      `;
      const opened = await insert(tx);
      return {
        closed,
        opened: opened.map((row) => [row.id, row.value_on]),
        before: await inEffect(tx, BARBERSHOP, "ok_new_customer", "2026-11-02T04:59:59.999999Z"),
        after: await inEffect(tx, BARBERSHOP, "ok_new_customer", NOV_2),
      };
    });
    expect(outcome).toEqual({
      closed: [{ id: NEW_CUSTOMER_ID }],
      opened: [["rule-lees-barbershop-ok-new-customer-2", false]],
      before: [NEW_CUSTOMER_ID],
      after: ["rule-lees-barbershop-ok-new-customer-2"],
    });
  });
});
