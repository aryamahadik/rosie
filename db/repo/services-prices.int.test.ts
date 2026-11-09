// T-206: the services and prices part (K-25 v1: services, service_money, item_services, price_rules and price_rule_ties)
// against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/services-prices`). The schema comes
// from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: the commit's per-write scope, the
// setup seeds) runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is
// rolled back. Seed fixtures are loaded the same way, as the runtime side with no scope (K-04's fixture format), and
// committed.
//
// The rows come only from fixtures (rule 9): K-25 v1's seeds and the K-24 v1, K-23 v1 and K-04 v1 seeds their after
// chains name (Lee's Barbershop, Lee Home Services, the pet boarding demo shop, the movers, the yoga studio and the
// master's sample cast: Sam Lee, Riley and Andre). A row made here is a fixture row under a new id, or with one fault.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/services-prices/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The five tables, in code-unit order (as PostgreSQL orders a relation's name): all scoped by business. */
const OWN_TABLES = ["item_services", "price_rule_ties", "price_rules", "service_money", "services"];
/** The four that are updated and carry a version (README rule 3); item_services rows are only added and removed. */
const VERSIONED = ["price_rule_ties", "price_rules", "service_money", "services"];
/** The seeds 02-contracts' K-25 row names, which the card's proof loads. */
const CARD_SEEDS = [
  "seed-services-price-list.json",
  "seed-service-money-paths.json",
  "seed-price-rule-dates.json",
];
/** The other parts' tables the five refer to by their keys (README rule 1). */
const REFERRED = ["businesses", "kinds", "locations", "persons", "places_or_things", "resources"];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const PET_BOARDING = "biz-pet-boarding";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
/** The start of Mon Nov 2 in the businesses' zone (America/New_York): the haircut's $40 starts then (S11-54). */
const NOV_2 = "2026-11-02T05:00:00Z";
/** When Sam confirmed the money card (S1-13, 2:11pm Mon Oct 19), the start of the board's prices. */
const CARD_CONFIRMED = "2026-10-19T18:11:00Z";
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

const TABLES = (readJson(new URL("services-prices.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-25's seeds name it: from K-25's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);
/** Every accepted K-04 v1, K-23 v1 and K-24 v1 seed. */
const CORE_SEEDS = seedsOf("core");
const SETUP_SEEDS = seedsOf("business-setup");
const KINDS_SEEDS = seedsOf("kinds-of-work");
/** The five K-25 seeds and K-04's resources (Riley, a worker, and the yoga studio's room), which the probes name. */
const PROBE_SEEDS = [...SEEDS, "../../core/fixtures/seed-resources.json"];

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-25 v1 lists no table ${name}`);
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

/** The values of a fixture's own row of `table` whose id is `id`. */
function valuesWithId(file: string, table: string, id: string): Values {
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values.id === id,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row ${id}`);
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
 * file that names it, so K-25's seeds name K-23's as ../../business-setup/fixtures/<file>), each file once.
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

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Every K-25 row of the five seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Lee's Barbershop's haircut (seed-services-price-list). */
const HAIRCUT = valuesWithId("seed-services-price-list.json", "services", "svc-lees-haircut");
/** The haircut at the shop: a card saved for the $20 fee, paid at the chair (seed-service-money-paths). */
const HAIRCUT_AT_SHOP = valuesWithId(
  "seed-service-money-paths.json",
  "service_money",
  "way-lees-haircut-shop",
);
/** The haircut's $40 for visits from Mon Nov 2, its own price with no condition (seed-price-rule-dates). */
const HAIRCUT_40 = valuesWithId("seed-price-rule-dates.json", "price_rules", "price-lees-haircut-40");
/** The kids cut's $25 from Sam's yes (seed-price-rule-dates). */
const KIDS_CUT_25 = valuesWithId("seed-price-rule-dates.json", "price_rules", "price-lees-kids-cut");
/** Event hours at $140 with Andre, a worker condition (seed-price-rule-dates). */
const EVENT_HOURS_ANDRE = valuesWithId(
  "seed-price-rule-dates.json",
  "price_rules",
  "price-lees-event-hours-andre",
);
/** The wiring repair's $89 service call, promised at the visit (seed-price-rule-dates). */
const WIRING_REPAIR = valuesWithId(
  "seed-price-rule-dates.json",
  "price_rules",
  "price-lee-electric-wiring-repair",
);
/** The standard run takes its own stay (seed-item-services). */
const STAY_LINK = valuesOf("seed-item-services.json", "item_services", 0);

/** A service made here: the haircut under a new id, last in the list, with no way yet. */
const HAIRCUT_COPY_ID = "svc-lees-haircut-copy";
const HAIRCUT_COPY: Values = { ...HAIRCUT, id: HAIRCUT_COPY_ID, position: 11 };
/** A way made here: the haircut's way at the shop, for the copy, under a new id. */
const COPY_AT_SHOP: Values = {
  ...HAIRCUT_AT_SHOP,
  id: "way-lees-haircut-copy-shop",
  service_id: HAIRCUT_COPY_ID,
};
/** A price made here: the haircut on Saturdays (a time condition), beside its own price with none. */
const SATURDAY_ID = "price-lees-haircut-saturday";
const SATURDAY_PRICE: Values = { ...HAIRCUT_40, id: SATURDAY_ID, weekdays: "6", price_cents: 4500 };
/**
 * A tie made here (no seed shows one, README "Seed and refused-row fixtures"): the haircut at the customer's home and
 * the haircut on Saturdays each set one condition, and both apply to a Saturday visit at home.
 */
const TIE_ID = "tie-lees-haircut-home-saturday";
const TIE: Values = {
  id: TIE_ID,
  business_id: BARBERSHOP,
  service_id: "svc-lees-haircut",
  first_rule_id: "price-lees-haircut-home",
  second_rule_id: SATURDAY_ID,
  asked_at: "2026-11-03T15:00:00Z",
  winner_rule_id: null,
  answered_at: null,
  answered_by_person_id: null,
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

/** `column = value and ...` for each column of `where` (text, or a number). */
function whereOf(sql: Sql | Tx, where: Values) {
  const conditions = Object.entries(where).map(([column, value]) => {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`a where value is text or a number, found ${JSON.stringify(value)}`);
    }
    return sql`${sql(column)} = ${value}`;
  });
  return conditions.reduce((all, one) => sql`${all} and ${one}`);
}

/** A row's primary key, from its values. */
const keyOf = (row: FixtureRow): Values =>
  Object.fromEntries(tableOf(row.table).primaryKey.map((column) => [column, row.values[column] ?? null]));

/**
 * Empties every table the fixtures write: truncating the heads, and the catalog of kinds, cascades to the rest (this
 * file's schema only).
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds cascade`;
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
 * the server in the column's own type (an interval, a time, an instant or an amount as PostgreSQL reads both; text
 * exactly).
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

/** Rows each of the five tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the five tables whose business_id is `businessId`, read as the owner. */
async function ownerRows(businessId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
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

/** The ids of a service's rules with no condition whose dates hold the instant `at`: [effective_from, effective_to). */
async function unconditionedAt(sql: Sql | Tx, serviceId: string, at: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from price_rules
    where service_id = ${serviceId} and service_money_id is null and worker_resource_id is null and weekdays is null
      and from_time is null and until_time is null
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

beforeAll(async () => {
  db = await createTestDatabase({ name: "services_prices" });
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

describe("the migration against the frozen table list (K-25 v1 services and prices)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    time: "time without time zone",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names five tables, all scoped by business on business_id; four are versioned and item_services is not; only price_rules has effective dates", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.versionColumn],
        table.name,
      ).toEqual(
        VERSIONED.includes(table.name)
          ? ["business", "business_id", true, "version"]
          : ["business", "business_id", false, undefined],
      );
      expect([table.effectiveDates, table.effectiveColumns], table.name).toEqual(
        table.name === "price_rules" ? [true, ["effective_from", "effective_to"]] : [false, undefined],
      );
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules (a partial one as a partial unique index), exclusions and index names are the table list's`, async () => {
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

    it(`${table.name}: each check, each exclusion, each index and each partial unique index is the table list's own expression, as PostgreSQL reads both`, async () => {
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

  it("price_rules_one_in_effect needs no extension beyond 0001's: = on text and time through btree_gist (made in public by 0001), && on the range through PostgreSQL's own range_ops", async () => {
    const [extension] = await db.sql<{ schema: string }[]>`
      select extnamespace::regnamespace::text as schema from pg_extension where extname = 'btree_gist'
    `;
    expect(extension?.schema).toBe("public");
    const classes = await db.sql<{ opclass: string; extension: string | null }[]>`
      select o.opcname as opclass, e.extname as extension
      from pg_index i
        cross join lateral unnest(i.indclass::oid[]) with ordinality as k(opclass, position)
        join pg_opclass o on o.oid = k.opclass
        left join pg_depend d on d.classid = 'pg_opclass'::regclass and d.objid = o.oid and d.deptype = 'e'
        left join pg_extension e on e.oid = d.refobjid
      where i.indexrelid = ${`${db.schema}.price_rules_one_in_effect`}::regclass
      order by k.position
    `;
    expect(classes.map((row) => [row.opclass, row.extension])).toEqual([
      ["gist_text_ops", "btree_gist"],
      ["gist_text_ops", "btree_gist"],
      ["gist_text_ops", "btree_gist"],
      ["gist_text_ops", "btree_gist"],
      ["gist_time_ops", "btree_gist"],
      ["gist_time_ops", "btree_gist"],
      ["range_ops", null],
    ]);
  });

  it("the four versioned tables raise their version on every update (0002's rule): <table>_version_raised, and no other trigger; item_services has none", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual(
      VERSIONED.map((table) => [table, `${table}_version_raised`]),
    );
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
  });

  it("row-level security is on for all five, in T-191's pattern: 0012's two policies on business_id, <table>_tool_api for rosie_app and <table>_runtime for rosie_job; none is forced", async () => {
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
    expect(core).toHaveLength(2);
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

  it("grants (DL-149, each to its named reader: the migration's header; README rule 6): both roles select, insert and update the four versioned tables and delete none; both select and insert item_services, and only rosie_app deletes a link; no truncate, references or trigger; nothing to PUBLIC; no column grants", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const expected = (role: Role, table: string): string[] => {
      if (table === "item_services") {
        return role === TOOL_API ? ["DELETE", "INSERT", "SELECT"] : ["INSERT", "SELECT"];
      }
      return ["INSERT", "SELECT", "UPDATE"];
    };
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) =>
        OWN_TABLES.flatMap((table) =>
          expected(role, table).map((privilege) => `${role} ${table} ${privilege}`),
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

  it("the five refer only to K-04's businesses, persons and resources, K-23's locations and places_or_things, K-24's kinds and each other (rule 1); no other table refers to them yet", async () => {
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
    const referring = await db.sql<{ name: string }[]>`
      select k.conname as name
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
    `;
    expect(referring).toEqual([]);
  });

  it("is recorded in schema_migrations as services_prices, after kinds_of_work", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("services_prices");
    expect(names.indexOf("services_prices")).toBeGreaterThan(names.indexOf("kinds_of_work"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the three of 02-contracts' K-25 row, and the two beyond it", () => {
  /** The K-25 rows the five seeds give together, per table: every table but the ties gets rows (README). */
  const SEEDED = { item_services: 3, price_rule_ties: 0, price_rules: 21, service_money: 17, services: 16 };

  it("the index lists five seeds (the card's three among them) and four refused rows, all K-25 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual(
      [...CARD_SEEDS, "seed-item-services.json", "seed-price-withdrawn-before-start.json"].sort(),
    );
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-cross-business-price-read.json",
      "invalid/refuse-fee-on-nothing-taken.json",
      "invalid/refuse-overlapping-effective-dates.json",
      "invalid/refuse-place-of-another-service.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file}${CARD_SEEDS.includes(file) ? " (the card's)" : ""} inserts alone with its after chain, as the runtime side, and every K-25 row is stored as given`,
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

  it("the card's three insert together, each after chain once", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(CARD_SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual({
      item_services: 0,
      price_rule_ties: 0,
      price_rules: 15,
      service_money: 13,
      services: 12,
    });
  });

  it(
    "all five insert together, each after chain once, and no table but the ties is left empty",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(SEEDS);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
      for (const row of SEED_ROWS) {
        await expectStored(row);
      }
    },
  );

  it(
    "they insert together with every K-04 v1, K-23 v1 and K-24 v1 seed as well, each file once",
    SLOW,
    async () => {
      await reset();
      expect([CORE_SEEDS.length > 0, SETUP_SEEDS.length > 0, KINDS_SEEDS.length > 0]).toEqual([
        true,
        true,
        true,
      ]);
      const loaded = await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...KINDS_SEEDS, ...SEEDS]);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
    },
  );
});

describe("the seeded rows: what the five seeds hold, read back", () => {
  const SHOP = "loc-lees-barbershop-shop";
  const SECOND_SHOP = "loc-lees-barbershop-second-shop";

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("Lee's Barbershop's list as S1-12 reads it, in order and matched to the barber kind: the board's one-price services, the free style consult, the house calls, the wedding party set by the customer's answers and event hours per hour; extras only where the barber file says something", async () => {
    const list = await db.sql<
      { position: number; name: string; kind: string; unit: string | null; length: string; extras: boolean }[]
    >`
      select position, name, price_kind as kind, unit, length::text as length, extras is not null as extras
      from services where business_id = ${BARBERSHOP} and kind_id = 'barber' and active
      order by position
    `;
    expect(list.map((service) => [service.position, service.name, service.kind, service.length])).toEqual([
      [1, "Haircut", "one_price", "00:30:00"],
      [2, "Skin fade", "one_price", "00:45:00"],
      [3, "Beard trim", "one_price", "00:15:00"],
      [4, "Kids cut (12 and under)", "one_price", "00:30:00"],
      [5, "Signature cut and hot towel shave", "one_price", "01:00:00"],
      [6, "Groom's package (cut, shave, facial)", "one_price", "02:30:00"],
      [7, "Style consult", "one_price", "00:15:00"],
      [8, "Home grooming visit (cut, beard trim, hot towel)", "one_price", "01:00:00"],
      [9, "Wedding party grooming", "by_answers", "00:35:00"],
      [10, "Event hours (a barber on site at an event)", "per_hour", "01:00:00"],
    ]);
    expect(list.filter((service) => service.unit !== null)).toEqual([]);
    expect(list.filter((service) => !service.extras).map((service) => service.name)).toEqual([
      "Style consult",
    ]);
    const boarding = await db.sql<{ name: string; kind: string; unit: string | null; length: string }[]>`
      select name, price_kind as kind, unit, length::text as length from services
      where business_id = ${PET_BOARDING} order by position
    `;
    expect(boarding).toEqual([
      { name: "Stay in a standard run (dog)", kind: "per_unit", unit: "night", length: "1 day" },
      { name: "Stay in a suite", kind: "per_unit", unit: "night", length: "1 day" },
      { name: "Cat condo", kind: "per_unit", unit: "night", length: "1 day" },
    ]);
  });

  it("S1-13's money card as Sam confirmed it: one way per service and place, the haircut also at the customer's home from the second shop, which has the travel area; the $20 and $40 fees, the $40 deposit, the free consult with nothing taken, the skin fade's own 2 hours, the tip line on the home grooming visit's bill and the wedding party's 25% deposit", async () => {
    const card = await db.sql<
      {
        service: string;
        place: string;
        flow: string;
        location: string | null;
        path: string;
        deposit: number | null;
        percent: number | null;
        fee: number | null;
        currency: string | null;
        cutoff: string | null;
        tip: boolean | null;
      }[]
    >`
      select s.name as service, m.place, m.flow, m.location_id as location, m.path, m.deposit_cents::int as deposit,
             m.deposit_percent as percent, m.fee_cents::int as fee, m.currency, m.cutoff_before::text as cutoff,
             m.tip_line as tip
      from service_money m join services s on s.id = m.service_id and s.business_id = m.business_id
      where m.business_id = ${BARBERSHOP} and m.active
      order by s.position, m.place
    `;
    expect(
      card.map((way) => [
        way.service,
        way.place,
        way.flow,
        way.location,
        way.path,
        way.deposit,
        way.percent,
        way.fee,
        way.currency,
        way.cutoff,
        way.tip,
      ]),
    ).toEqual([
      ["Haircut", "business", "A", SHOP, "list|card|counter", null, null, 2000, "USD", null, null],
      ["Haircut", "customer", "B", SECOND_SHOP, "list|full|none", null, null, 2000, "USD", null, null],
      ["Skin fade", "business", "A", SHOP, "list|card|counter", null, null, 2000, "USD", "02:00:00", null],
      ["Beard trim", "business", "A", SHOP, "list|card|counter", null, null, 2000, "USD", null, null],
      [
        "Kids cut (12 and under)",
        "business",
        "A",
        SHOP,
        "list|card|counter",
        null,
        null,
        2000,
        "USD",
        null,
        null,
      ],
      [
        "Signature cut and hot towel shave",
        "business",
        "A",
        SHOP,
        "list|full|none",
        null,
        null,
        2000,
        "USD",
        null,
        null,
      ],
      [
        "Groom's package (cut, shave, facial)",
        "business",
        "A",
        SHOP,
        "list|deposit|counter",
        4000,
        null,
        4000,
        "USD",
        null,
        null,
      ],
      ["Style consult", "business", "A", SHOP, "list|none|none", null, null, null, null, null, null],
      [
        "Home grooming visit (cut, beard trim, hot towel)",
        "customer",
        "B",
        SECOND_SHOP,
        "list|card|bill",
        null,
        null,
        8900,
        "USD",
        null,
        true,
      ],
      [
        "Wedding party grooming",
        "customer",
        "B",
        SECOND_SHOP,
        "photos|deposit|bill",
        null,
        25,
        null,
        null,
        null,
        null,
      ],
      [
        "Event hours (a barber on site at an event)",
        "customer",
        "B",
        SECOND_SHOP,
        "list|none|bill",
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    ]);
    const places = await db.sql<{ id: string; kind: string; travel: boolean }[]>`
      select id, kind, travel_miles is not null as travel from locations where id in (${SHOP}, ${SECOND_SHOP})
      order by id collate "C"
    `;
    expect(places).toEqual([
      { id: SECOND_SHOP, kind: "shop", travel: true },
      { id: SHOP, kind: "shop", travel: false },
    ]);
  });

  it("every price is a rule with dates: the haircut's $35 from Sam's yes closed at the start of Mon Nov 2 and its $40 opened at that instant, its $75 at the customer's home, event hours $120 an hour and $140 with Andre, who is a worker of the barbershop; the movers' vault visit $35 and $40 after 5pm", async () => {
    const rules = await db.sql<
      {
        id: string;
        cents: number;
        place: string | null;
        worker: string | null;
        after: string | null;
        starts: Date;
        ends: Date | null;
      }[]
    >`
      select id, price_cents::int as cents, service_money_id as place, worker_resource_id as worker,
             from_time::text as after, effective_from as starts, effective_to as ends
      from price_rules
      where service_id in ('svc-lees-haircut', 'svc-lees-event-hours', 'svc-movers-vault-visit')
      order by service_id collate "C", effective_from, id collate "C"
    `;
    expect(rules).toEqual([
      {
        id: "price-lees-event-hours",
        cents: 12000,
        place: null,
        worker: null,
        after: null,
        starts: new Date(CARD_CONFIRMED),
        ends: null,
      },
      {
        id: "price-lees-event-hours-andre",
        cents: 14000,
        place: null,
        worker: "res-andre",
        after: null,
        starts: new Date("2026-10-19T19:00:00Z"),
        ends: null,
      },
      {
        id: "price-lees-haircut-35",
        cents: 3500,
        place: null,
        worker: null,
        after: null,
        starts: new Date(CARD_CONFIRMED),
        ends: new Date(NOV_2),
      },
      {
        id: "price-lees-haircut-home",
        cents: 7500,
        place: "way-lees-haircut-home",
        worker: null,
        after: null,
        starts: new Date(CARD_CONFIRMED),
        ends: null,
      },
      {
        id: "price-lees-haircut-40",
        cents: 4000,
        place: null,
        worker: null,
        after: null,
        starts: new Date(NOV_2),
        ends: null,
      },
      {
        id: "price-movers-vault-visit",
        cents: 3500,
        place: null,
        worker: null,
        after: null,
        starts: new Date(CARD_CONFIRMED),
        ends: null,
      },
      {
        id: "price-movers-vault-visit-evening",
        cents: 4000,
        place: null,
        worker: null,
        after: "17:00:00",
        starts: new Date(CARD_CONFIRMED),
        ends: null,
      },
    ]);
    const [andre] = await db.sql<{ kind: string; person: string; business: string }[]>`
      select kind, person_id as person, business_id as business from resources where id = 'res-andre'
    `;
    expect(andre).toEqual({ kind: "worker", person: "person-andre", business: BARBERSHOP });
    const [meet] = await db.sql<{ meet: boolean; overlap: boolean }[]>`
      select a.effective_to = b.effective_from as meet,
             tstzrange(a.effective_from, a.effective_to, '[)') && tstzrange(b.effective_from, b.effective_to, '[)')
               as overlap
      from price_rules a, price_rules b where a.id = 'price-lees-haircut-35' and b.id = 'price-lees-haircut-40'
    `;
    expect(meet).toEqual({ meet: true, overlap: false });
  });

  it("the dates the exclusion reads: the haircut's own price at a visit's start is the $35 until a microsecond before midnight on Mon Nov 2 and the $40 from then (S11-54)", async () => {
    const at = (instant: string): Promise<string[]> => unconditionedAt(db.sql, "svc-lees-haircut", instant);
    expect(await at("2026-10-30T16:00:00Z")).toEqual(["price-lees-haircut-35"]);
    expect(await at("2026-11-02T04:59:59.999999Z")).toEqual(["price-lees-haircut-35"]);
    expect(await at(NOV_2)).toEqual(["price-lees-haircut-40"]);
    expect(await at("2026-11-03T16:00:00Z")).toEqual(["price-lees-haircut-40"]);
  });

  it("a price set for a later date and withdrawn before it starts (seed-price-withdrawn-before-start): the faucet rebuild's $40 is an empty range that holds no instant, and from midnight on Mon Nov 2 the $35 opened at that instant holds", async () => {
    const [withdrawn] = await db.sql<{ empty: boolean; cents: number }[]>`
      select isempty(tstzrange(effective_from, effective_to, '[)')) as empty, price_cents::int as cents
      from price_rules where id = 'price-lee-plumbing-faucet-rebuild-40'
    `;
    expect(withdrawn).toEqual({ empty: true, cents: 4000 });
    const at = (instant: string): Promise<string[]> =>
      unconditionedAt(db.sql, "svc-lee-plumbing-faucet-rebuild", instant);
    expect(await at("2026-10-30T16:00:00Z")).toEqual(["price-lee-plumbing-faucet-rebuild-35"]);
    expect(await at("2026-11-02T04:59:59.999999Z")).toEqual(["price-lee-plumbing-faucet-rebuild-35"]);
    expect(await at(NOV_2)).toEqual(["price-lee-plumbing-faucet-rebuild-35-again"]);
    expect(await at("2026-11-03T16:00:00Z")).toEqual(["price-lee-plumbing-faucet-rebuild-35-again"]);
  });

  it("S1-81: each of the pet boarding shop's spaces takes its own stay, priced per night", async () => {
    const links = await db.sql<{ space: string; service: string; cents: number }[]>`
      select p.name as space, s.name as service, r.price_cents::int as cents
      from item_services i
        join places_or_things p on p.id = i.place_or_thing_id
        join services s on s.id = i.service_id and s.business_id = i.business_id
        join price_rules r on r.service_id = s.id and r.effective_to is null
      where i.business_id = ${PET_BOARDING}
      order by p.name collate "C"
    `;
    expect(links).toEqual([
      { space: "Cat condo", service: "Cat condo", cents: 2500 },
      { space: "Standard run", service: "Stay in a standard run (dog)", cents: 4800 },
      { space: "Suite", service: "Stay in a suite", cents: 7000 },
    ]);
  });
});

describe("effective dates: one price in effect per service and set of conditions (price_rules_one_in_effect; arch 09 line 488; S11-54)", () => {
  /** The start of Mon Nov 9 in the barbershop's zone: a raise of the kids cut set for a later date. */
  const RAISE_AT = "2026-11-09T05:00:00Z";

  beforeAll(async () => {
    await reset();
    await loadFixtures(PROBE_SEEDS);
  }, 60_000);

  it(
    "by the Tool API on the kids cut: a raise from a later date closes the $25 at that instant; a correction is refused while the raise is open (23P01) and passes once the raise is closed at its own start; withdrawn the same way, the $25 opens again at that instant beside two empty rows; a row closed before its own start is refused (23514), an open row over another open one too (23P01), and a withdrawn row is never deleted (42501)",
    SLOW,
    async () => {
      const outcome = await as(TOOL_API, BARBERSHOP, async (tx) => {
        const close = (id: string, at: string) => tx<{ id: string }[]>`
          update price_rules set effective_to = ${at}, version = version + 1 where id = ${id} returning id
        `;
        const open = (id: string, cents: number, from = RAISE_AT) =>
          insertReturning(tx, "price_rules", {
            ...KIDS_CUT_25,
            id,
            price_cents: cents,
            effective_from: from,
            effective_to: null,
            version: 1,
          });
        const steps: unknown[] = [];
        steps.push((await close("price-lees-kids-cut", RAISE_AT)).length);
        steps.push((await open("price-lees-kids-cut-30", 3000)).length);
        const corrected = await refusal(
          tx.savepoint((sp) =>
            insertReturning(sp, "price_rules", {
              ...KIDS_CUT_25,
              id: "price-lees-kids-cut-28",
              price_cents: 2800,
              effective_from: RAISE_AT,
              effective_to: null,
              version: 1,
            }),
          ),
        );
        steps.push([corrected.code, corrected.constraint]);
        steps.push((await close("price-lees-kids-cut-30", RAISE_AT)).length);
        steps.push((await open("price-lees-kids-cut-28", 2800)).length);
        steps.push((await close("price-lees-kids-cut-28", RAISE_AT)).length);
        steps.push((await open("price-lees-kids-cut-25-again", 2500)).length);
        const rows = await tx<{ id: string; cents: number; empty: boolean; open: boolean }[]>`
          select id, price_cents::int as cents, isempty(tstzrange(effective_from, effective_to, '[)')) as empty,
                 effective_to is null as open
          from price_rules where service_id = 'svc-lees-kids-cut'
          order by effective_from, id collate "C"
        `;
        const before = await unconditionedAt(tx, "svc-lees-kids-cut", "2026-11-09T04:59:59.999999Z");
        const atRaise = await unconditionedAt(tx, "svc-lees-kids-cut", RAISE_AT);
        const early = await refusal(
          tx.savepoint(
            (sp) => sp`
          update price_rules set effective_to = '2026-11-08T05:00:00Z', version = version + 1
          where id = 'price-lees-kids-cut-25-again'
        `,
          ),
        );
        const over = await refusal(
          tx.savepoint((sp) =>
            insertReturning(sp, "price_rules", {
              ...KIDS_CUT_25,
              id: "price-lees-kids-cut-26",
              price_cents: 2600,
              effective_from: "2026-11-16T05:00:00Z",
              effective_to: null,
              version: 1,
            }),
          ),
        );
        const removed = await refusal(
          tx.savepoint((sp) => sp`delete from price_rules where id = 'price-lees-kids-cut-30'`),
        );
        return {
          steps,
          rows,
          before,
          atRaise,
          early: [early.code, early.constraint],
          over: [over.code, over.constraint],
          removed: [removed.code, removed.message],
        };
      });
      expect(outcome).toEqual({
        steps: [1, 1, ["23P01", "price_rules_one_in_effect"], 1, 1, 1, 1],
        rows: [
          { id: "price-lees-kids-cut", cents: 2500, empty: false, open: false },
          { id: "price-lees-kids-cut-25-again", cents: 2500, empty: false, open: true },
          { id: "price-lees-kids-cut-28", cents: 2800, empty: true, open: false },
          { id: "price-lees-kids-cut-30", cents: 3000, empty: true, open: false },
        ],
        before: ["price-lees-kids-cut"],
        atRaise: ["price-lees-kids-cut-25-again"],
        early: ["23514", "price_rules_dates_in_order"],
        over: ["23P01", "price_rules_one_in_effect"],
        removed: ["42501", "permission denied for table price_rules"],
      });
    },
  );

  it("rules with other conditions stand in effect at once: a place rule beside the service's own price (the seeds), Saturdays beside Sundays, and Riley's price beside Andre's; the same conditions twice are refused (23P01), and a rule from inside another's dates too", async () => {
    const outcome = await as(RUNTIME, null, async (tx) => {
      const added = [
        ...(await insertReturning(tx, "price_rules", SATURDAY_PRICE)),
        ...(await insertReturning(tx, "price_rules", {
          ...SATURDAY_PRICE,
          id: "price-lees-haircut-sunday",
          weekdays: "7",
        })),
        ...(await insertReturning(tx, "price_rules", {
          ...EVENT_HOURS_ANDRE,
          id: "price-lees-event-hours-riley",
          worker_resource_id: "res-riley",
        })),
      ].length;
      const twice = await refusal(
        tx.savepoint((sp) =>
          insertReturning(sp, "price_rules", { ...SATURDAY_PRICE, id: "price-lees-haircut-saturday-again" }),
        ),
      );
      const inside = await refusal(
        tx.savepoint((sp) =>
          insertReturning(sp, "price_rules", {
            ...HAIRCUT_40,
            id: "price-lees-haircut-37",
            price_cents: 3700,
            effective_from: "2026-10-26T04:00:00Z",
            effective_to: "2026-10-27T04:00:00Z",
          }),
        ),
      );
      return { added, twice: [twice.code, twice.constraint], inside: [inside.code, inside.constraint] };
    });
    expect(outcome).toEqual({
      added: 3,
      twice: ["23P01", "price_rules_one_in_effect"],
      inside: ["23P01", "price_rules_one_in_effect"],
    });
  });
});

describe("row-level security per business on the five tables, every K-04 v1, K-23 v1, K-24 v1 and K-25 v1 seed loaded", () => {
  const zeros = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));

  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...KINDS_SEEDS, ...SEEDS]);
  }, 60_000);

  it(
    "with no scope the Tool API reads no row of the five; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's services, ways or prices, and the barbershop's none of the pet boarding shop's links",
    SLOW,
    async () => {
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual([HOME_SERVICES, BARBERSHOP, MOVERS, PET_BOARDING, YOGA_STUDIO].sort());
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await ownerRows(BARBERSHOP)).toEqual({
        item_services: 0,
        price_rule_ties: 0,
        price_rules: 12,
        service_money: 11,
        services: 10,
      });
      expect(await ownerRows(PET_BOARDING)).toEqual({
        item_services: 3,
        price_rule_ties: 0,
        price_rules: 3,
        service_money: 3,
        services: 3,
      });
      expect(await as(TOOL_API, YOGA_STUDIO, visibleRows)).toEqual(zeros);
      expect((await as(TOOL_API, BARBERSHOP, visibleRows)).item_services).toBe(0);
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
    "the Tool API writes only its scope's rows: another business's insert is refused (42501), its update finds no row, a row cannot move to another business, and a service, a way, a price or a tie is never deleted (42501)",
    SLOW,
    async () => {
      const addService = (tx: Tx) => insertReturning(tx, "services", HAIRCUT_COPY);
      expect((await refusal(as(TOOL_API, YOGA_STUDIO, addService))).code).toBe("42501");
      expect(await as(TOOL_API, BARBERSHOP, addService)).toHaveLength(1);
      const bump = (tx: Tx) => tx<{ version: number }[]>`
        update price_rules set version = version + 1 where id = 'price-lees-haircut-40' returning version
      `;
      expect(await as(TOOL_API, YOGA_STUDIO, bump)).toHaveLength(0);
      expect(await as(TOOL_API, BARBERSHOP, bump)).toEqual([{ version: 2 }]);
      const move = (tx: Tx) => tx`
        update price_rules set business_id = ${YOGA_STUDIO}, version = version + 1 where id = 'price-lees-skin-fade'
      `;
      expect((await refusal(as(TOOL_API, BARBERSHOP, move))).code).toBe("42501");
      for (const table of VERSIONED) {
        const removed = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    },
  );

  it(
    "a link between a space and a service is removed by the Tool API in its own scope only (S1-81 and Settings); the runtime side deletes nothing of the five (42501); neither role updates a link (42501)",
    SLOW,
    async () => {
      const unlink = (tx: Tx) => tx<{ service: string }[]>`
        delete from item_services
        where place_or_thing_id = 'place-pet-boarding-suite' and service_id = 'svc-boarding-suite-stay'
        returning service_id as service
      `;
      expect(await as(TOOL_API, PET_BOARDING, unlink)).toEqual([{ service: "svc-boarding-suite-stay" }]);
      expect(await as(TOOL_API, YOGA_STUDIO, unlink)).toEqual([]);
      expect(await as(TOOL_API, null, unlink)).toEqual([]);
      for (const table of OWN_TABLES) {
        const removed = await refusal(as(RUNTIME, null, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
      for (const [role, scope] of [
        [TOOL_API, PET_BOARDING],
        [RUNTIME, null],
      ] as const) {
        const changed = await refusal(
          as(role, scope, (tx) => tx`update item_services set business_id = business_id`),
        );
        expect([changed.code, changed.message], role).toEqual([
          "42501",
          "permission denied for table item_services",
        ]);
      }
    },
  );

  it(
    "a way's, a price's, a link's and a tie's business is its service's: each composite key refuses another business (23503), and the same row under the right business passes",
    SLOW,
    async () => {
      const videoWay: Values = {
        ...HAIRCUT_AT_SHOP,
        id: "way-lees-haircut-video",
        place: "video",
        location_id: null,
      };
      const suiteLink: Values = { ...STAY_LINK, place_or_thing_id: "place-pet-boarding-suite" };
      const cases: {
        constraint: string;
        wrong: (tx: Tx) => Promise<unknown>;
        right: (tx: Tx) => Promise<readonly unknown[]>;
      }[] = [
        {
          constraint: "service_money_service_fk",
          wrong: insertEach(["service_money", { ...videoWay, business_id: HOME_SERVICES }]),
          right: insertEach(["service_money", videoWay]),
        },
        {
          constraint: "price_rules_service_fk",
          wrong: insertEach(["price_rules", { ...SATURDAY_PRICE, business_id: HOME_SERVICES }]),
          right: insertEach(["price_rules", SATURDAY_PRICE]),
        },
        {
          constraint: "item_services_service_fk",
          wrong: insertEach(["item_services", { ...suiteLink, business_id: BARBERSHOP }]),
          right: insertEach(["item_services", suiteLink]),
        },
        {
          constraint: "price_rule_ties_service_fk",
          wrong: insertEach(
            ["price_rules", SATURDAY_PRICE],
            ["price_rule_ties", { ...TIE, business_id: HOME_SERVICES }],
          ),
          right: insertEach(["price_rules", SATURDAY_PRICE], ["price_rule_ties", TIE]),
        },
      ];
      for (const { constraint, wrong, right } of cases) {
        const outcome = await refusal(as(RUNTIME, null, wrong));
        expect([outcome.code, outcome.constraint], constraint).toEqual(["23503", constraint]);
        expect(await as(RUNTIME, null, right), constraint).toHaveLength(1);
      }
    },
  );

  it(
    "every update raises the version by exactly one, on the four versioned tables: an update that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes, each under its business's Tool API scope",
    SLOW,
    async () => {
      const nothing = (): Promise<void> => Promise.resolve();
      const targets: [string, string, (tx: Tx) => Promise<unknown>][] = [
        ["price_rule_ties", TIE_ID, insertEach(["price_rules", SATURDAY_PRICE], ["price_rule_ties", TIE])],
        ["price_rules", "price-lees-haircut-35", nothing],
        ["service_money", "way-lees-haircut-shop", nothing],
        ["services", "svc-lees-haircut", nothing],
      ];
      expect(targets.map(([table]) => table)).toEqual(VERSIONED);
      for (const [table, id, setup] of targets) {
        const kept = await refusal(
          as(TOOL_API, BARBERSHOP, async (tx) => {
            await setup(tx);
            return tx`update ${tx(table)} set version = version where id = ${id}`;
          }),
        );
        expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
        const raised = await as(TOOL_API, BARBERSHOP, async (tx) => {
          await setup(tx);
          const [row] = await tx<{ version: number }[]>`select version from ${tx(table)} where id = ${id}`;
          const after = await tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where id = ${id} returning version
          `;
          return [row?.version, after.map((one) => one.version)];
        });
        const [before, after] = raised as [number, number[]];
        expect(after, table).toEqual([before + 1]);
      }
    },
  );
});

describe("the rules the table list holds: each row that breaks one rule is refused by that rule alone, and the README's valid forms pass", () => {
  const service = (fault: Values) => insertEach(["services", { ...HAIRCUT_COPY, ...fault }]);
  const way = (fault: Values) =>
    insertEach(["services", HAIRCUT_COPY], ["service_money", { ...COPY_AT_SHOP, ...fault }]);
  const price = (fault: Values) => insertEach(["price_rules", { ...SATURDAY_PRICE, ...fault }]);
  const tie = (fault: Values) =>
    insertEach(["price_rules", SATURDAY_PRICE], ["price_rule_ties", { ...TIE, ...fault }]);
  const link = (fault: Values) => insertEach(["item_services", { ...STAY_LINK, ...fault }]);
  const answer = { winner_rule_id: "price-lees-haircut-home", answered_at: "2026-11-03T16:00:00Z" };

  /** Each probe breaks exactly one rule; each is run on the runtime side with no scope, so only that rule refuses it. */
  const PROBES: {
    breaks: string;
    run: (tx: Tx) => Promise<readonly unknown[]>;
    code: string;
    rule: string;
  }[] = [
    { breaks: "a blank name", run: service({ name: "   " }), code: "23514", rule: "services_name_given" },
    {
      breaks: "a price kind S1-12 does not name",
      run: service({ price_kind: "per_visit" }),
      code: "23514",
      rule: "services_price_kind_known",
    },
    {
      breaks: "a per-unit price with no unit",
      run: service({ price_kind: "per_unit" }),
      code: "23514",
      rule: "services_unit_with_per_unit",
    },
    {
      breaks: "a unit on a one-price service",
      run: service({ unit: "night" }),
      code: "23514",
      rule: "services_unit_with_per_unit",
    },
    {
      breaks: "a time it takes of zero",
      run: service({ length: "0 minutes" }),
      code: "23514",
      rule: "services_length_positive",
    },
    {
      breaks: "position 0",
      run: service({ position: 0 }),
      code: "23514",
      rule: "services_position_from_one",
    },
    {
      breaks: "extras that are JSON but not an object",
      run: service({ extras: JSON.stringify(["Haircut"]) }),
      code: "23514",
      rule: "services_extras_json",
    },
    {
      breaks: "extras that are not JSON",
      run: service({ extras: "Haircut, $35, 30 min" }),
      code: "23514",
      rule: "services_extras_json",
    },
    {
      breaks: "a kind of work K-24 does not list",
      run: service({ kind_id: "hair-stylist-unknown" }),
      code: "23503",
      rule: "services_kind_fk",
    },
    {
      breaks: "a business that does not exist",
      run: service({ business_id: "biz-nobody" }),
      code: "23503",
      rule: "services_business_fk",
    },
    {
      breaks: "the customer's place in flow A",
      run: way({ place: "customer" }),
      code: "23514",
      rule: "service_money_flow_matches_place",
    },
    {
      breaks: "a place at the business with no location",
      run: way({ location_id: null }),
      code: "23514",
      rule: "service_money_location_by_place",
    },
    {
      breaks: "a video way with a location",
      run: way({ place: "video" }),
      code: "23514",
      rule: "service_money_location_by_place",
    },
    {
      breaks: "a path of the other flow",
      run: way({ path: "list|card|own" }),
      code: "23514",
      rule: "service_money_path_known",
    },
    {
      breaks: "a hold path, not one of the 28",
      run: way({ path: "list|hold|counter" }),
      code: "23514",
      rule: "service_money_path_known",
    },
    {
      breaks: "a visit price taken in full (D66)",
      run: way({ path: "visit|full|none" }),
      code: "23514",
      rule: "service_money_path_known",
    },
    {
      breaks: "a deposit with nothing after (D66)",
      run: way({ path: "list|deposit|none", deposit_cents: 1000 }),
      code: "23514",
      rule: "service_money_path_known",
    },
    {
      breaks: "a deposit path with no deposit",
      run: way({ path: "list|deposit|counter" }),
      code: "23514",
      rule: "service_money_deposit_with_deposit_path",
    },
    {
      breaks: "a deposit given twice, as an amount and a share",
      run: way({ path: "list|deposit|counter", deposit_cents: 4000, deposit_percent: 25 }),
      code: "23514",
      rule: "service_money_deposit_with_deposit_path",
    },
    {
      breaks: "a deposit on a card path",
      run: way({ deposit_cents: 4000 }),
      code: "23514",
      rule: "service_money_deposit_with_deposit_path",
    },
    {
      breaks: "a deposit of 0",
      run: way({ path: "list|deposit|counter", deposit_cents: 0 }),
      code: "23514",
      rule: "service_money_deposit_in_range",
    },
    {
      breaks: "a deposit of the whole price",
      run: way({ path: "list|deposit|counter", deposit_percent: 100 }),
      code: "23514",
      rule: "service_money_deposit_in_range",
    },
    {
      breaks: "a fee of 0",
      run: way({ fee_cents: 0 }),
      code: "23514",
      rule: "service_money_fee_needs_money_before",
    },
    {
      breaks: "a fee on a path that takes nothing before",
      run: way({ path: "list|none|counter" }),
      code: "23514",
      rule: "service_money_fee_needs_money_before",
    },
    {
      breaks: "a currency with no amount",
      run: way({ fee_cents: null }),
      code: "23514",
      rule: "service_money_currency_with_amount",
    },
    {
      breaks: "an amount with no currency",
      run: way({ currency: null }),
      code: "23514",
      rule: "service_money_currency_with_amount",
    },
    {
      breaks: "a lower-case currency",
      run: way({ currency: "usd" }),
      code: "23514",
      rule: "service_money_currency_with_amount",
    },
    {
      breaks: "two free-cancel times",
      run: way({ cutoff_before: "2 hours", cutoff_day_before_at: "18:00" }),
      code: "23514",
      rule: "service_money_one_cutoff",
    },
    {
      breaks: "a free-cancel time of zero",
      run: way({ cutoff_before: "0 minutes" }),
      code: "23514",
      rule: "service_money_one_cutoff",
    },
    {
      breaks: "a tip line where Rosie sends no bill",
      run: way({ tip_line: true }),
      code: "23514",
      rule: "service_money_tip_line_on_bills",
    },
    {
      breaks: "a second way at one place",
      run: insertEach(["service_money", { ...HAIRCUT_AT_SHOP, id: "way-lees-haircut-shop-again" }]),
      code: "23505",
      rule: "service_money_one_per_place",
    },
    {
      breaks: "a second way by video",
      run: insertEach(
        ["services", HAIRCUT_COPY],
        ["service_money", { ...COPY_AT_SHOP, place: "video", location_id: null }],
        [
          "service_money",
          { ...COPY_AT_SHOP, id: "way-lees-haircut-copy-video", place: "video", location_id: null },
        ],
      ),
      code: "23505",
      rule: "service_money_one_video",
    },
    {
      breaks: "a location that does not exist",
      run: way({ location_id: "loc-nowhere" }),
      code: "23503",
      rule: "service_money_location_fk",
    },
    {
      breaks: "the same conditions twice in effect",
      run: insertEach(["price_rules", { ...HAIRCUT_40, id: "price-lees-haircut-40-again" }]),
      code: "23P01",
      rule: "price_rules_one_in_effect",
    },
    {
      breaks: "a worker that is a room",
      run: async (tx) => {
        // The yoga studio's room (K-04 seed-resources) is there, as a room: the key refuses its kind, not its absence.
        const [room] = await tx<{ kind: string }[]>`select kind from resources where id = 'res-studio-room'`;
        if (room?.kind !== "room") {
          throw new Error("K-04's seed-resources should hold the studio room");
        }
        return price({ worker_resource_id: "res-studio-room" })(tx);
      },
      code: "23503",
      rule: "price_rules_worker_fk",
    },
    {
      breaks: "the worker's kind changed",
      run: price({ worker_resource_kind: "room" }),
      code: "23514",
      rule: "price_rules_worker_kind",
    },
    {
      breaks: "days out of order",
      run: price({ weekdays: "76" }),
      code: "23514",
      rule: "price_rules_weekdays_form",
    },
    {
      breaks: "every day as a day condition",
      run: price({ weekdays: "1234567" }),
      code: "23514",
      rule: "price_rules_weekdays_form",
    },
    {
      breaks: "an empty day condition",
      run: price({ weekdays: "" }),
      code: "23514",
      rule: "price_rules_weekdays_form",
    },
    {
      breaks: "a day outside 1 to 7",
      run: price({ weekdays: "8" }),
      code: "23514",
      rule: "price_rules_weekdays_form",
    },
    {
      breaks: "a clock condition from midnight",
      run: price({ from_time: "00:00" }),
      code: "23514",
      rule: "price_rules_times_form",
    },
    {
      breaks: "a clock condition until 24:00",
      run: price({ until_time: "24:00" }),
      code: "23514",
      rule: "price_rules_times_form",
    },
    {
      breaks: "clock times backwards",
      run: price({ from_time: "17:00", until_time: "09:00" }),
      code: "23514",
      rule: "price_rules_times_form",
    },
    {
      breaks: "a negative price",
      run: price({ price_cents: -500 }),
      code: "23514",
      rule: "price_rules_money",
    },
    {
      breaks: "a 'from' price of 0",
      run: price({ from_cents: 0 }),
      code: "23514",
      rule: "price_rules_money",
    },
    {
      breaks: "a lower-case currency on a price",
      run: price({ currency: "usd" }),
      code: "23514",
      rule: "price_rules_money",
    },
    {
      breaks: "a price closed before its own start",
      run: price({ effective_to: "2026-11-01T05:00:00Z" }),
      code: "23514",
      rule: "price_rules_dates_in_order",
    },
    {
      breaks: "a setter who is no person",
      run: price({ set_by_person_id: "person-nobody" }),
      code: "23503",
      rule: "price_rules_set_by_fk",
    },
    {
      breaks: "a place that is another service's way",
      run: price({ service_money_id: "way-lees-skin-fade-shop" }),
      code: "23503",
      rule: "price_rules_place_fk",
    },
    {
      breaks: "a tie of a rule with itself",
      run: tie({ second_rule_id: "price-lees-haircut-home" }),
      code: "23514",
      rule: "price_rule_ties_two_rules",
    },
    {
      breaks: "a tie with another service's rule",
      run: tie({ second_rule_id: "price-lees-skin-fade" }),
      code: "23503",
      rule: "price_rule_ties_second_fk",
    },
    {
      breaks: "the same tie asked twice",
      run: insertEach(
        ["price_rules", SATURDAY_PRICE],
        ["price_rule_ties", TIE],
        ["price_rule_ties", { ...TIE, id: "tie-lees-haircut-home-saturday-again" }],
      ),
      code: "23505",
      rule: "price_rule_ties_pair_key",
    },
    {
      breaks: "a winner outside the pair",
      run: tie({ ...answer, winner_rule_id: "price-lees-haircut-40", answered_by_person_id: "person-sam" }),
      code: "23514",
      rule: "price_rule_ties_winner_of_pair",
    },
    {
      breaks: "an answer without who gave it",
      run: tie(answer),
      code: "23514",
      rule: "price_rule_ties_answer_together",
    },
    {
      breaks: "an answer before the question",
      run: tie({ ...answer, answered_at: "2026-11-03T14:00:00Z", answered_by_person_id: "person-sam" }),
      code: "23514",
      rule: "price_rule_ties_answer_together",
    },
    {
      breaks: "an answer by no person",
      run: tie({ ...answer, answered_by_person_id: "person-nobody" }),
      code: "23503",
      rule: "price_rule_ties_answered_by_fk",
    },
    { breaks: "a link made twice", run: link({}), code: "23505", rule: "item_services_pkey" },
    {
      breaks: "a link to a space that does not exist",
      run: link({ place_or_thing_id: "place-nowhere" }),
      code: "23503",
      rule: "item_services_place_or_thing_fk",
    },
  ];

  /** The README's valid forms (its check of 2026-11-07), each passing on the runtime side. */
  const VALID: { form: string; run: (tx: Tx) => Promise<readonly unknown[]> }[] = [
    {
      form: "a service set by the customer's answers, with no unit",
      run: service({ price_kind: "by_answers" }),
    },
    {
      form: "a way by video, with no location",
      run: way({ place: "video", location_id: null }),
    },
    { form: "a way at the second shop", run: way({ location_id: "loc-lees-barbershop-second-shop" }) },
    { form: "a free-cancel time of 6pm the day before", run: way({ cutoff_day_before_at: "18:00" }) },
    { form: "tips off on a bill Rosie sends", run: way({ path: "list|card|bill", tip_line: false }) },
    {
      form: "a deposit as a share, with no fee or currency of its own",
      run: way({ path: "list|deposit|counter", deposit_percent: 25, fee_cents: null, currency: null }),
    },
    {
      form: "an evening price from 5pm until 9pm",
      run: price({ weekdays: null, from_time: "17:00", until_time: "21:00" }),
    },
    {
      form: "a 'from' price on the wiring repair's visit path",
      run: insertEach([
        "price_rules",
        {
          ...WIRING_REPAIR,
          id: "price-lee-electric-wiring-repair-from",
          service_money_id: "way-lee-electric-wiring-repair-home",
          from_cents: 11000,
        },
      ]),
    },
    {
      form: "a tie asked, then answered by Sam",
      run: async (tx) => {
        await tie({})(tx);
        return tx`
          update price_rule_ties
          set winner_rule_id = 'price-lees-haircut-home', answered_at = '2026-11-03T16:00:00Z',
              answered_by_person_id = 'person-sam', version = version + 1
          where id = ${TIE_ID}
          returning id
        `;
      },
    },
    { form: "a stay linked to a second space", run: link({ place_or_thing_id: "place-pet-boarding-suite" }) },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(PROBE_SEEDS);
  }, 60_000);

  for (const { breaks, run, code, rule } of PROBES) {
    it(`${breaks}: refused by ${rule} (${code})`, async () => {
      const outcome = await refusal(as(RUNTIME, null, run));
      expect([outcome.code, outcome.constraint]).toEqual([code, rule]);
    });
  }

  for (const { form, run } of VALID) {
    it(`${form}: passes`, async () => {
      expect(await as(RUNTIME, null, run)).toHaveLength(1);
    });
  }
});

describe("invalid/refuse-overlapping-effective-dates.json: S11-54's raise saved without closing the row in effect", () => {
  const file = "invalid/refuse-overlapping-effective-dates.json";
  const refused = refusedOf(file);
  const scope = refused.scope?.businessId ?? null;
  const raise = (tx: Tx) => insertReturning(tx, refused.table, refused.values ?? {});

  beforeAll(async () => {
    await reset();
    // The fixture's after chain and its own row: the haircut's $35, still open.
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the Tool API, scoped to the barbershop, inserts the haircut's $40 from Mon Nov 2 while the $35 is open; refused by price_rules_one_in_effect (23P01), never by privilege", async () => {
    expect([refused.role, refused.action, refused.table, scope]).toEqual([
      "toolApi",
      "insert",
      "price_rules",
      BARBERSHOP,
    ]);
    const outcome = await refusal(as(roleOf(refused), scope, raise));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (the $35 closed at that instant first, as a change closes one row and opens the next) the same insert passes in the same scope", async () => {
    const opened = await as(roleOf(refused), scope, async (tx) => {
      const closed = await tx<{ id: string }[]>`
        update price_rules set effective_to = ${NOV_2}, version = version + 1
        where id = 'price-lees-haircut-35' and effective_to is null
        returning id
      `;
      expect(closed).toEqual([{ id: "price-lees-haircut-35" }]);
      return raise(tx);
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ id: "price-lees-haircut-40", business_id: BARBERSHOP });
  });
});

/** Each refused write with its one fault removed: K-25's README names the action that passes once it is fixed. */
const REFUSED_WRITES: { file: string; fixed: Values; without: string }[] = [
  {
    file: "invalid/refuse-fee-on-nothing-taken.json",
    fixed: { fee_cents: null, currency: null },
    without: "the same change that also clears the fee, and with it the fee's currency",
  },
  {
    file: "invalid/refuse-place-of-another-service.json",
    fixed: { service_money_id: "way-lees-skin-fade-shop" },
    without: "the same price at the skin fade's own way at the shop",
  },
];

for (const { file, fixed, without } of REFUSED_WRITES) {
  describe(`${file}: refused for its one reason, never by privilege`, () => {
    const refused = refusedOf(file);
    const scope = refused.scope?.businessId ?? null;
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
      // The fixture's after chain (its own rows: none).
      await loadFixtures([file]);
    }, 60_000);

    it(`the fixture: ${refused.role} ${scope === null ? "with no scope" : `scoped to ${scope}`} ${refused.action}s into ${refused.table}; refused by ${refused.expect.constraintOneOf?.join(" or ") ?? "?"} (${refused.expect.sqlstate ?? "?"})`, async () => {
      expect(["insert", "update"]).toContain(refused.action);
      const outcome = await refusal(as(roleOf(refused), scope, attempt({})));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      const done = await as(roleOf(refused), scope, attempt(fixed));
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject(fixed);
      if (scope !== null) {
        expect(done[0]).toMatchObject({ business_id: scope });
      }
    });
  });
}

describe("invalid/refuse-cross-business-price-read.json: another business's prices are hidden from a Tool API call", () => {
  const refused = refusedOf("invalid/refuse-cross-business-price-read.json");
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> =>
    sql`select * from ${sql(refused.table)} where ${whereOf(sql, refused.where ?? {})}`;

  beforeAll(async () => {
    await reset();
    await loadFixtures(["invalid/refuse-cross-business-price-read.json"]);
  }, 60_000);

  it("scoped to the yoga studio, the read of the barbershop's haircut prices returns no row, as the fixture expects, though all 3 are there", async () => {
    expect([refused.role, refused.action, refused.scope?.businessId]).toEqual([
      "toolApi",
      "select",
      YOGA_STUDIO,
    ]);
    expect(await read(db.sql)).toHaveLength(3);
    expect(await as(roleOf(refused), YOGA_STUDIO, read)).toHaveLength(refused.expect.rows ?? -1);
  });

  it("without its one fault (the barbershop's own scope) the same read returns its 3 rows", async () => {
    expect(await as(TOOL_API, BARBERSHOP, read)).toHaveLength(3);
  });
});
