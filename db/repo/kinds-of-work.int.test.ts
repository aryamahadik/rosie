// T-205: the kinds of work part (K-24 v1: kinds, kind_flows, picked_kinds, picked_kind_texts, new_work_drafts and
// new_work_draft_blocks) against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/kinds-of-work`).
// The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: the commit's per-write scope,
// sign-up's turns before there is a business, the catalog's writer) runs in its own transaction under SET LOCAL ROLE,
// scoped by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are loaded the same way, as the
// runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-24 v1's seeds and the K-23 v1 and K-04 v1 seeds their after chains name
// (Lee's Barbershop, Lee Home Services, the pet boarding demo shop, the yoga studio and the master's sample cast: Sam
// Lee), and the barber and plumber trade files of fixture set v1 (fixtures/master/engine/work/prof/), whose plug-in
// values the text blocks are. A row made here is a fixture row under a new id, or with one fault.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/kinds-of-work/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TRADE_DIR = new URL("../../fixtures/master/engine/work/prof/", import.meta.url);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The six tables, in code-unit order (as PostgreSQL orders a relation's name): all versioned. */
const OWN_TABLES = [
  "kind_flows",
  "kinds",
  "new_work_draft_blocks",
  "new_work_drafts",
  "picked_kind_texts",
  "picked_kinds",
];
/** The shared catalog (scope none, README rule 2): every business picks from it, and the Tool API only reads it. */
const CATALOG = ["kind_flows", "kinds"];
/** The four tables scoped by business on business_id (README rule 2), in code-unit order. */
const SCOPED = ["new_work_draft_blocks", "new_work_drafts", "picked_kind_texts", "picked_kinds"];
/** The seeds 02-contracts' K-24 row names, which the card's proof loads. */
const CARD_SEEDS = ["seed-kinds-sample.json", "seed-business-kinds.json", "seed-new-work-draft.json"];
/** The 11 free-text plug-in keys, in S1-11's order (README; compiler/src/load/trade.ts PF_TEXT_KEYS). */
const PF_TEXT_KEYS = [
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const PET_BOARDING = "biz-pet-boarding";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
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

const TABLES = (readJson(new URL("kinds-of-work.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-24's seeds name it: from K-24's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);
/** Every accepted K-04 v1 seed and every accepted K-23 v1 seed. */
const CORE_SEEDS = seedsOf("core");
const SETUP_SEEDS = seedsOf("business-setup");

/** A trade file's plug-in values, read by its top keys (MC R3). */
const pluginOf = (trade: string): Record<string, Json> =>
  (readJson(new URL(`${trade}.json`, TRADE_DIR)) as { plugin: Record<string, Json> }).plugin;

/** A trade file's plug-in text block: the value as JSON text, unchanged (K-01 pluginText; T-133's loader). */
function pluginText(trade: string, key: string): string {
  const value = pluginOf(trade)[key];
  if (value === undefined) {
    throw new Error(`${trade}.json has no plug-in value ${key}`);
  }
  return JSON.stringify(value);
}

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-24 v1 lists no table ${name}`);
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
 * file that names it, so K-24's seeds name K-23's as ../../business-setup/fixtures/<file>), each file once.
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

const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A text's length in bytes, encoded as UTF-8 (the database's encoding). */
const byteLengthOf = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Every K-24 row of the three seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** The barbershop's pick (seed-business-kinds), the base of the picks made here. */
const BARBERSHOP_PICK = valuesOf("seed-business-kinds.json", "picked_kinds", 0);
/** The drafted kind new-pack-hikes, its pick, its draft and its block 4 (seed-new-work-draft). */
const DRAFTED_KIND = valuesOf("seed-new-work-draft.json", "kinds");
const PACK_HIKES_PICK = valuesOf("seed-new-work-draft.json", "picked_kinds");
const PACK_HIKES_DRAFT = valuesOf("seed-new-work-draft.json", "new_work_drafts");
const ANSWERED_BLOCK = valuesOf("seed-new-work-draft.json", "new_work_draft_blocks", 1);

/**
 * S1-02, S1-11 and S1-03 before S1-04 and S1-09 (README "Order of sign-up"): the barbershop's pick with its first text
 * block, and a kind drafted at sign-up with its pick, its draft and one answered block, all before any company or
 * business exists. The runtime side writes them.
 */
const EARLY_ROWS: [string, Values][] = [
  ["kinds", { ...DRAFTED_KIND, id: "new-pack-hikes-sign-up" }],
  [
    "picked_kinds",
    {
      ...BARBERSHOP_PICK,
      id: "pick-sam-barbershop-sign-up",
      company_id: null,
      business_id: null,
      version: 1,
    },
  ],
  [
    "picked_kind_texts",
    {
      ...valuesOf("seed-business-kinds.json", "picked_kind_texts", 0),
      picked_kind_id: "pick-sam-barbershop-sign-up",
      business_id: null,
    },
  ],
  [
    "picked_kinds",
    {
      ...PACK_HIKES_PICK,
      id: "pick-sam-pack-hikes-sign-up",
      kind_id: "new-pack-hikes-sign-up",
      business_id: null,
    },
  ],
  [
    "new_work_drafts",
    {
      ...PACK_HIKES_DRAFT,
      id: "draft-pack-hikes-sign-up",
      picked_kind_id: "pick-sam-pack-hikes-sign-up",
      business_id: null,
      state: "drafting",
      version: 1,
    },
  ],
  ["new_work_draft_blocks", { ...ANSWERED_BLOCK, draft_id: "draft-pack-hikes-sign-up", business_id: null }],
];

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

/** `column = value and ...` for each column of `where` (text, or a number such as a checklist block's). */
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
 * Empties every table the fixtures write: truncating the heads, and the catalog, cascades to the rest (this file's
 * schema only).
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
 * the server in the column's own type (a list, a time or an integer as PostgreSQL reads both; text exactly).
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

/** Rows each of the four business-scoped tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows each of the six tables holds, read as the caller, by table. */
async function allRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the four tables whose business_id is `businessId` (null: no business), read as the owner. */
async function ownerRows(businessId: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table)}
      where ${businessId === null ? db.sql`business_id is null` : db.sql`business_id = ${businessId}`}
    `;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Rows each of the four tables shows the caller whose business_id is null. */
async function visibleRowsWithNoBusiness(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
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
  db = await createTestDatabase({ name: "kinds_of_work" });
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

describe("the migration against the frozen table list (K-24 v1 kinds of work)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
  };

  it("the table list names six tables, all versioned: the catalog's two (kinds, kind_flows) span businesses, the four others are scoped by business on business_id", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.versionColumn],
        table.name,
      ).toEqual(
        SCOPED.includes(table.name)
          ? ["business", "business_id", true, "version"]
          : ["none", undefined, true, "version"],
      );
    }
    expect([...CATALOG, ...SCOPED].sort()).toEqual(OWN_TABLES);
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
      const foreignKeys = table.foreignKeys ?? [];
      const unique = table.unique ?? [];
      // A unique rule with a where is a partial unique index (tables.meta.schema.json), which no constraint row holds.
      const plain = unique.filter((rule) => rule.where === undefined);
      const partial = unique.filter((rule) => rule.where !== undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
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

  it("a plug-in text block is text checked with `is json` (rule 6), never jsonb: the server is PostgreSQL 16 or later, and no column here is json or jsonb", async () => {
    const [server] = await db.sql<{ version: number }[]>`
      select current_setting('server_version_num')::int as version
    `;
    expect(server?.version).toBeGreaterThanOrEqual(160000);
    expect(typeOf.get("picked_kind_texts.block")).toBe("text");
    const jsonColumns = [...typeOf.entries()].filter(
      ([key, type]) => OWN_TABLES.includes(key.split(".")[0] ?? "") && ["json", "jsonb"].includes(type),
    );
    expect(jsonColumns).toEqual([]);
  });

  it("all six raise their version on every update (0002's rule): <table>_version_raised, and no other trigger", async () => {
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

  it("row-level security is on for the four business-scoped tables, in T-191's pattern: 0012's two policies on business_id, <table>_tool_api for rosie_app and <table>_runtime for rosie_job; the catalog's two keep it off and hold no policy; none is forced", async () => {
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

  it("grants (DL-149, each to its named reader: the migration's header): rosie_app selects the catalog and nothing more there; rosie_job selects, inserts and updates it; both roles select, insert and update the four; no delete, truncate, references or trigger; nothing to PUBLIC; no column grants", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const expected = (role: Role, table: string): string[] =>
      role === TOOL_API && CATALOG.includes(table) ? ["SELECT"] : ["INSERT", "SELECT", "UPDATE"];
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

  it("nothing here changes K-23's company_kinds (rule 1): its columns and foreign keys are K-23 v1's, with no key to kinds yet (K-23 v1.1's, README open gaps); only kind_flows and picked_kinds refer to kinds", async () => {
    const setup = (
      readJson(new URL("../business-setup/business-setup.v1.tables.json", PART_DIR)) as {
        tables: ContractTable[];
      }
    ).tables.find((table) => table.name === "company_kinds");
    expect(setup).toBeDefined();
    const columns = await db.sql<{ name: string }[]>`
      select attname as name from pg_attribute
      where attrelid = ${`${db.schema}.company_kinds`}::regclass and attnum > 0 and not attisdropped
      order by attnum
    `;
    expect(columns.map((column) => column.name)).toEqual(setup?.columns.map((column) => column.name));
    const keys = await db.sql<{ name: string }[]>`
      select conname as name from pg_constraint
      where conrelid = ${`${db.schema}.company_kinds`}::regclass and contype = 'f'
    `;
    expect(keys.map((key) => key.name).sort()).toEqual(
      (setup?.foreignKeys ?? []).map((key) => key.name).sort(),
    );
    const referring = await db.sql<{ name: string }[]>`
      select conname as name from pg_constraint
      where contype = 'f' and confrelid = ${`${db.schema}.kinds`}::regclass
    `;
    expect(referring.map((key) => key.name).sort()).toEqual(["kind_flows_kind_fk", "picked_kinds_kind_fk"]);
  });

  it("is recorded in schema_migrations as kinds_of_work, after business_setup and people_access", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("kinds_of_work");
    expect(names.indexOf("kinds_of_work")).toBeGreaterThan(names.indexOf("business_setup"));
    expect(names.indexOf("kinds_of_work")).toBeGreaterThan(names.indexOf("people_access"));
  });
});

describe("the seed fixtures load (fixtures/index.json): the three of 02-contracts' K-24 row", () => {
  /** The K-24 rows the three seeds give together, per table: every table gets rows. */
  const SEEDED = {
    kind_flows: 16,
    kinds: 9,
    new_work_draft_blocks: 6,
    new_work_drafts: 1,
    picked_kind_texts: 11,
    picked_kinds: 4,
  };

  it("the index lists the three seeds (the card's) and five refused rows, all K-24 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual([...CARD_SEEDS].sort());
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-cross-business-text-read.json",
      "invalid/refuse-main-path-not-listed.json",
      "invalid/refuse-no-block-with-facts.json",
      "invalid/refuse-pick-without-company-kind.json",
      "invalid/refuse-typed-key-as-text-block.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of CARD_SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-24 row is stored as given`,
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

  it("all three insert together, each after chain once, and no table is left empty", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await allRows(db.sql)).toEqual(SEEDED);
    for (const row of SEED_ROWS) {
      await expectStored(row);
    }
  });

  it("they insert together with every K-04 v1 and K-23 v1 seed as well, each file once", SLOW, async () => {
    await reset();
    expect(CORE_SEEDS.length).toBeGreaterThan(0);
    expect(SETUP_SEEDS.length).toBeGreaterThan(0);
    const loaded = await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await allRows(db.sql)).toEqual(SEEDED);
  });
});

describe("the seeded rows: what the three seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("the catalog: eight trade-file kinds with both flows and one drafted kind with none; insurance carries MC C5's facts and starts at window with an empty cutoff in both flows; dog-walker's flow B has a 2-hour window; the plumber's cancelright is on in flow B only", async () => {
    const kinds = await db.sql<{ id: string; source: string; flows: number }[]>`
      select k.id, k.source, count(f.flow)::int as flows
      from kinds k left join kind_flows f on f.kind_id = k.id
      group by k.id, k.source
      order by k.id collate "C"
    `;
    expect(kinds).toEqual([
      { id: "barber", source: "trade_file", flows: 2 },
      { id: "boarding", source: "trade_file", flows: 2 },
      { id: "dog-walker", source: "trade_file", flows: 2 },
      { id: "electrician", source: "trade_file", flows: 2 },
      { id: "insurance", source: "trade_file", flows: 2 },
      { id: "movers", source: "trade_file", flows: 2 },
      { id: "new-pack-hikes", source: "new_work", flows: 0 },
      { id: "plumber", source: "trade_file", flows: 2 },
      { id: "yoga", source: "trade_file", flows: 2 },
    ]);
    const [insurance] = await db.sql<{ facts: string[] }[]>`select facts from kinds where id = 'insurance'`;
    expect(insurance?.facts).toEqual(["video", "forms", "firststeps", "documents"]);
    const settings = await db.sql<
      { kind: string; flow: string; arrive: string; hours: number | null; cutoff: string | null }[]
    >`
      select kind_id as kind, flow, arrive, arrive_window_hours as hours, cutoff from kind_flows
      where kind_id in ('insurance', 'dog-walker')
      order by kind_id collate "C", flow
    `;
    expect(settings).toEqual([
      { kind: "dog-walker", flow: "A", arrive: "setstart", hours: null, cutoff: "24 hours before" },
      { kind: "dog-walker", flow: "B", arrive: "window", hours: 2, cutoff: "8pm the day before" },
      { kind: "insurance", flow: "A", arrive: "window", hours: null, cutoff: null },
      { kind: "insurance", flow: "B", arrive: "window", hours: null, cutoff: null },
    ]);
    const plumber = await db.sql<{ flow: string; on: string[] }[]>`
      select flow, switches_on as on from kind_flows where kind_id = 'plumber' order by flow
    `;
    expect(plumber).toEqual([
      { flow: "A", on: [] },
      { flow: "B", on: ["cancelright"] },
    ]);
  });

  it("Sam's S1-02 answer 'Barbershop, plumbing, electrical': three listed picks in the order named, each its company's kind after S1-04; only the barbershop's 11 text blocks are loaded so far (S1-11), each carrying its pick's business", async () => {
    const picks = await db.sql<
      { position: number; words: string; kind: string; company: string; business: string; blocks: number }[]
    >`
      select p.position, p.words, p.kind_id as kind, c.name as company, p.business_id as business,
             (select count(*)::int from picked_kind_texts t where t.picked_kind_id = p.id) as blocks
      from picked_kinds p
        join company_kinds k on k.company_id = p.company_id and k.kind_id = p.kind_id
        join companies c on c.id = p.company_id and c.business_id = p.business_id
      where p.owner_person_id = 'person-sam' and p.outcome = 'listed'
      order by p.position
    `;
    expect(picks).toEqual([
      {
        position: 1,
        words: "Barbershop",
        kind: "barber",
        company: "Lee's Barbershop LLC",
        business: BARBERSHOP,
        blocks: 11,
      },
      {
        position: 2,
        words: "plumbing",
        kind: "plumber",
        company: "Lee Home Services LLC",
        business: HOME_SERVICES,
        blocks: 0,
      },
      {
        position: 3,
        words: "electrical",
        kind: "electrician",
        company: "Lee Home Services LLC",
        business: HOME_SERVICES,
        blocks: 0,
      },
    ]);
    const [astray] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from picked_kind_texts t join picked_kinds p on p.id = t.picked_kind_id
      where t.business_id is distinct from p.business_id
    `;
    expect(astray?.n).toBe(0);
  });

  it("Sam's NEW pack hikes for the pet boarding business: the drafted kind new-pack-hikes (pattern service, no style or facts), its pick, its draft in review, and the blocks answered, block 3 a clear no setting nothing; the other blocks stay at their safe defaults", async () => {
    const [draft] = await db.sql<Record<string, unknown>[]>`
      select d.state, p.outcome, p.words, k.id as kind, k.source, k.pattern, k.style, k.facts,
             d.business_id as business, p.company_id as company
      from new_work_drafts d
        join picked_kinds p on p.id = d.picked_kind_id and p.business_id = d.business_id
        join kinds k on k.id = p.kind_id
      where d.id = 'draft-pack-hikes'
    `;
    expect(draft).toEqual({
      state: "in_review",
      outcome: "new_work",
      words: "pack hikes",
      kind: "new-pack-hikes",
      source: "new_work",
      pattern: "service",
      style: null,
      facts: null,
      business: PET_BOARDING,
      company: null,
    });
    const blocks = await db.sql<{ block: number; outcome: string; facts: string[]; switches: string[] }[]>`
      select block, outcome, facts_on as facts, switches_on as switches from new_work_draft_blocks
      where draft_id = 'draft-pack-hikes' and business_id = ${PET_BOARDING}
      order by block
    `;
    expect(blocks).toEqual([
      { block: 3, outcome: "no", facts: [], switches: [] },
      { block: 4, outcome: "answered", facts: ["forms", "firststeps"], switches: [] },
      { block: 6, outcome: "answered", facts: ["plans"], switches: [] },
      { block: 8, outcome: "answered", facts: ["animals"], switches: [] },
      { block: 12, outcome: "answered", facts: ["groups"], switches: [] },
      { block: 14, outcome: "answered", facts: ["dropoff"], switches: [] },
    ]);
  });
});

describe("a plug-in text block round-trips byte for byte (S1-11; MC R3; README rule 6: text checked with is json, never jsonb)", () => {
  const given = fixtureFile("seed-business-kinds.json").rows.filter(
    (row) => row.table === "picked_kind_texts",
  );
  const servicesBlock = textOf(valuesOf("seed-business-kinds.json", "picked_kind_texts", 1).block);

  beforeAll(async () => {
    await reset();
    await loadFixtures(["seed-business-kinds.json"]);
  }, 60_000);

  it("the seed gives the barbershop's 11 blocks in S1-11's order, each the barber trade file's own value as JSON text, unchanged (K-01 pluginText)", () => {
    expect(given.map((row) => row.values.pf_key)).toEqual(PF_TEXT_KEYS);
    for (const row of given) {
      const key = textOf(row.values.pf_key);
      expect(textOf(row.values.block), key).toBe(pluginText("barber", key));
    }
  });

  it("each block reads back with the very bytes it was given: the same text, its length in bytes and its sha256, both taken on the server; and the same text through the Tool API under the barbershop's scope", async () => {
    const stored = await db.sql<{ key: string; block: string; bytes: number; sha256: string }[]>`
      select pf_key as key, block, octet_length(block) as bytes,
             encode(sha256(convert_to(block, 'UTF8')), 'hex') as sha256
      from picked_kind_texts where picked_kind_id = 'pick-sam-barbershop'
    `;
    const byKey = new Map(stored.map((row) => [row.key, row]));
    expect([...byKey.keys()].sort()).toEqual([...PF_TEXT_KEYS].sort());
    for (const row of given) {
      const key = textOf(row.values.pf_key);
      const text = textOf(row.values.block);
      expect(byKey.get(key), key).toEqual({
        key,
        block: text,
        bytes: byteLengthOf(text),
        sha256: sha256Of(text),
      });
    }
    const viaToolApi = await as(
      TOOL_API,
      BARBERSHOP,
      (tx) => tx<{ key: string; block: string }[]>`
        select pf_key as key, block from picked_kind_texts where picked_kind_id = 'pick-sam-barbershop'
      `,
    );
    expect(new Map(viaToolApi.map((row) => [row.key, row.block]))).toEqual(
      new Map(given.map((row) => [textOf(row.values.pf_key), textOf(row.values.block)])),
    );
  });

  it("characters outside ASCII keep their bytes: the services block's ½ takes two bytes in UTF-8, and a copy of the same value pretty-printed, its keys reversed and ½ escaped, is stored and read back exactly as written, where jsonb would rewrite it", async () => {
    expect(servicesBlock).toContain("½");
    expect(byteLengthOf(servicesBlock)).toBeGreaterThan(servicesBlock.length);
    const value = JSON.parse(servicesBlock) as Record<string, Json>;
    const rewritten = JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 2).replaceAll(
      "½",
      "\\u00bd",
    );
    expect(rewritten).not.toBe(servicesBlock);
    expect(JSON.parse(rewritten)).toEqual(value);
    const [row] = await as(
      TOOL_API,
      BARBERSHOP,
      (tx) => tx<{ block: string; bytes: number; sha256: string; asJsonb: string }[]>`
        update picked_kind_texts set block = ${rewritten}, version = version + 1
        where picked_kind_id = 'pick-sam-barbershop' and pf_key = 'pf.services'
        returning block, octet_length(block) as bytes, encode(sha256(convert_to(block, 'UTF8')), 'hex') as sha256,
                  (block::jsonb)::text as "asJsonb"
      `,
    );
    expect(row?.block).toBe(rewritten);
    expect(row?.bytes).toBe(byteLengthOf(rewritten));
    expect(row?.sha256).toBe(sha256Of(rewritten));
    // The same text as jsonb reads back as another text with the same value: the reason the block is text.
    expect(row?.asJsonb).not.toBe(rewritten);
    expect(JSON.parse(row?.asJsonb ?? "null")).toEqual(value);
  });

  it("text that is not JSON is refused (picked_kind_texts_block_is_json, 23514); the same words as a JSON string pass", async () => {
    const license = pluginOf("barber")["pf.license"] as Record<string, Json>;
    const words = textOf(license.need);
    const write =
      (block: string) =>
      (tx: Tx): Promise<readonly { block: string }[]> =>
        tx<{ block: string }[]>`
          update picked_kind_texts set block = ${block}, version = version + 1
          where picked_kind_id = 'pick-sam-barbershop' and pf_key = 'pf.license'
          returning block
        `;
    const refused = await refusal(as(TOOL_API, BARBERSHOP, write(words)));
    expect([refused.code, refused.constraint]).toEqual(["23514", "picked_kind_texts_block_is_json"]);
    expect(await as(TOOL_API, BARBERSHOP, write(JSON.stringify(words)))).toEqual([
      { block: JSON.stringify(words) },
    ]);
  });
});

describe("row-level security per business on the four tables, every K-04 v1, K-23 v1 and K-24 v1 seed loaded", () => {
  const zeros = Object.fromEntries(SCOPED.map((table) => [table, 0]));
  /** A fourth barbershop pick, not yet placed in a company. */
  const secondPick: Values = {
    ...BARBERSHOP_PICK,
    id: "pick-sam-barbershop-second",
    position: 4,
    company_id: null,
    version: 1,
  };
  /** Another pick before any business, which only the runtime side may write. */
  const earlyPick: Values = {
    ...BARBERSHOP_PICK,
    id: "pick-sam-barbershop-sign-up-second",
    company_id: null,
    business_id: null,
    version: 1,
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
    await committedAs(RUNTIME, async (tx) => {
      for (const [table, values] of EARLY_ROWS) {
        await insertRow(tx, table, values);
      }
    });
  }, 60_000);

  it(
    "with no scope the Tool API reads no row of the four; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's picks and blocks or the pet boarding draft",
    SLOW,
    async () => {
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual([HOME_SERVICES, BARBERSHOP, MOVERS, PET_BOARDING, YOGA_STUDIO].sort());
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      const barbershop = await ownerRows(BARBERSHOP);
      expect([barbershop.picked_kinds, barbershop.picked_kind_texts]).toEqual([1, 11]);
      const petBoarding = await ownerRows(PET_BOARDING);
      expect([
        petBoarding.picked_kinds,
        petBoarding.new_work_drafts,
        petBoarding.new_work_draft_blocks,
      ]).toEqual([1, 1, 6]);
      expect(await as(TOOL_API, YOGA_STUDIO, visibleRows)).toEqual(zeros);
    },
  );

  it(
    "the catalog is every scope's to read and no scope's to write: the Tool API reads every kind and flow under any scope or none, and its insert, update or delete is refused by privilege (42501); the runtime side writes a drafted kind and a flow",
    SLOW,
    async () => {
      const catalog = async (sql: Sql | Tx): Promise<Record<string, number>> => ({
        kinds: await countRows(sql, "kinds"),
        kind_flows: await countRows(sql, "kind_flows"),
      });
      const all = await catalog(db.sql);
      expect(all).toEqual({ kinds: 10, kind_flows: 16 });
      for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
        expect(await as(TOOL_API, scope, catalog), String(scope)).toEqual(all);
      }
      const drafted: Values = { ...DRAFTED_KIND, id: "new-pack-hikes-catalog" };
      const flowChange = (tx: Tx) => tx`
      update kind_flows set main_combo = 'list|none|counter', version = version + 1
      where kind_id = 'barber' and flow = 'A'
      returning kind_id
    `;
      const writes: [string, (tx: Tx) => Promise<unknown>][] = [
        ["kinds", (tx) => insertReturning(tx, "kinds", drafted)],
        ["kind_flows", flowChange],
        ["kinds", (tx) => tx`delete from kinds where id = 'new-pack-hikes'`],
        ["kind_flows", (tx) => tx`delete from kind_flows where kind_id = 'barber'`],
      ];
      for (const scope of [BARBERSHOP, null]) {
        for (const [table, write] of writes) {
          const refused = await refusal(as(TOOL_API, scope, write));
          expect([refused.code, refused.message], `${table} ${String(scope)}`).toEqual([
            "42501",
            `permission denied for table ${table}`,
          ]);
        }
      }
      expect(
        await as(RUNTIME, null, async (tx) => [
          ...(await insertReturning(tx, "kinds", drafted)),
          ...(await flowChange(tx)),
        ]),
      ).toHaveLength(2);
    },
  );

  it(
    "a pick with its text block, and a drafted kind's pick, draft and block, written before any business, are seen by no business scope, under either role; the runtime side with no scope reads them",
    SLOW,
    async () => {
      const withNone = await ownerRows(null);
      expect(withNone).toEqual({
        new_work_draft_blocks: 1,
        new_work_drafts: 1,
        picked_kind_texts: 1,
        picked_kinds: 2,
      });
      for (const business of await businessIds()) {
        for (const role of ROLES) {
          expect(await as(role, business, visibleRowsWithNoBusiness), `${role} at ${business}`).toEqual(
            zeros,
          );
        }
      }
      expect(await as(TOOL_API, null, visibleRowsWithNoBusiness)).toEqual(zeros);
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

  it(
    "the Tool API writes only its scope's rows: another business's insert is refused (42501), its update finds no row, a row cannot move to another business, a row with no business is not its to write, and nothing is deleted",
    SLOW,
    async () => {
      const addPick = (tx: Tx) => insertReturning(tx, "picked_kinds", secondPick);
      expect((await refusal(as(TOOL_API, YOGA_STUDIO, addPick))).code).toBe("42501");
      expect(await as(TOOL_API, BARBERSHOP, addPick)).toHaveLength(1);
      const bump = (tx: Tx) => tx<{ version: number }[]>`
      update picked_kind_texts set version = version + 1
      where picked_kind_id = 'pick-sam-barbershop' and pf_key = 'pf.edges'
      returning version
    `;
      expect(await as(TOOL_API, YOGA_STUDIO, bump)).toHaveLength(0);
      expect(await as(TOOL_API, BARBERSHOP, bump)).toEqual([{ version: 2 }]);
      const move = (tx: Tx) => tx`
      update new_work_drafts set business_id = ${YOGA_STUDIO}, version = version + 1 where id = 'draft-pack-hikes'
    `;
      expect((await refusal(as(TOOL_API, PET_BOARDING, move))).code).toBe("42501");
      expect(
        (await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "picked_kinds", earlyPick))))
          .code,
      ).toBe("42501");
      for (const table of OWN_TABLES) {
        const removed = await refusal(as(TOOL_API, BARBERSHOP, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    },
  );

  it(
    "the runtime side scoped to one business (per write) cannot write another's row, nor one with no business; with no scope it writes both; it deletes nothing",
    SLOW,
    async () => {
      expect(
        (await refusal(as(RUNTIME, YOGA_STUDIO, (tx) => insertReturning(tx, "picked_kinds", secondPick))))
          .code,
      ).toBe("42501");
      expect(
        (await refusal(as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "picked_kinds", earlyPick)))).code,
      ).toBe("42501");
      expect(
        await as(RUNTIME, null, async (tx) => [
          ...(await insertReturning(tx, "picked_kinds", secondPick)),
          ...(await insertReturning(tx, "picked_kinds", earlyPick)),
        ]),
      ).toHaveLength(2);
      for (const table of OWN_TABLES) {
        const removed = await refusal(as(RUNTIME, null, (tx) => tx`delete from ${tx(table)}`));
        expect([removed.code, removed.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    },
  );

  it(
    "a text block's or a draft's business is its pick's, a draft block's its draft's, and a pick's its company's: each composite key refuses another business (23503), and the same row under the right business passes",
    SLOW,
    async () => {
      const plumbingLicense: Values = {
        picked_kind_id: "pick-sam-plumbing",
        pf_key: "pf.license",
        business_id: BARBERSHOP,
        block: pluginText("plumber", "pf.license"),
        version: 1,
      };
      const secondNewPick: Values = { ...PACK_HIKES_PICK, id: "pick-sam-pack-hikes-second" };
      const secondDraft: Values = {
        ...PACK_HIKES_DRAFT,
        id: "draft-pack-hikes-second",
        picked_kind_id: "pick-sam-pack-hikes-second",
        business_id: HOME_SERVICES,
      };
      const fifthBlock: Values = { ...ANSWERED_BLOCK, block: 5, business_id: HOME_SERVICES };
      const movePlumbing = (business: string) => (tx: Tx) => tx`
      update picked_kinds set business_id = ${business}, version = version + 1 where id = 'pick-sam-plumbing'
      returning id
    `;
      const cases: {
        constraint: string;
        wrong: (tx: Tx) => Promise<unknown>;
        right: (tx: Tx) => Promise<readonly unknown[]>;
      }[] = [
        {
          constraint: "picked_kind_texts_pick_business_fk",
          wrong: (tx) => insertReturning(tx, "picked_kind_texts", plumbingLicense),
          right: (tx) =>
            insertReturning(tx, "picked_kind_texts", { ...plumbingLicense, business_id: HOME_SERVICES }),
        },
        {
          constraint: "new_work_drafts_pick_business_fk",
          wrong: async (tx) => {
            await insertRow(tx, "picked_kinds", secondNewPick);
            return insertReturning(tx, "new_work_drafts", secondDraft);
          },
          right: async (tx) => {
            await insertRow(tx, "picked_kinds", secondNewPick);
            return insertReturning(tx, "new_work_drafts", { ...secondDraft, business_id: PET_BOARDING });
          },
        },
        {
          constraint: "new_work_draft_blocks_draft_business_fk",
          wrong: (tx) => insertReturning(tx, "new_work_draft_blocks", fifthBlock),
          right: (tx) =>
            insertReturning(tx, "new_work_draft_blocks", { ...fifthBlock, business_id: PET_BOARDING }),
        },
        {
          constraint: "picked_kinds_company_business_fk",
          wrong: movePlumbing(BARBERSHOP),
          right: movePlumbing(HOME_SERVICES),
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
    "every update raises the version by exactly one, on all six: an update that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes (the four under their business's Tool API scope, the catalog on the runtime side)",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        const row = SEED_ROWS.find((candidate) => candidate.table === table);
        if (row === undefined) {
          throw new Error(`no seed row of ${table}`);
        }
        const [role, business]: [Role, string | null] = SCOPED.includes(table)
          ? [TOOL_API, textOf(row.values.business_id)]
          : [RUNTIME, null];
        const version = row.values.version;
        const kept = await refusal(
          as(
            role,
            business,
            (tx) => tx`update ${tx(table)} set version = version where ${whereOf(tx, keyOf(row))}`,
          ),
        );
        expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
        const raised = await as(
          role,
          business,
          (tx) =>
            tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where ${whereOf(tx, keyOf(row))} returning version
          `,
        );
        expect(raised, table).toEqual([{ version: typeof version === "number" ? version + 1 : -1 }]);
      }
    },
  );
});

describe("the rules the table list holds: each row that breaks one rule is refused by that rule alone, and the README's valid forms pass", () => {
  const BARBER_KIND = valuesOf("seed-kinds-sample.json", "kinds", 0);
  const BARBER_A_COMBOS = valuesOf("seed-kinds-sample.json", "kind_flows", 0).combos;
  const flowChange =
    (set: Values, kind = "barber", flow = "A") =>
    (tx: Tx): Promise<readonly unknown[]> =>
      tx`
        update kind_flows set ${tx(columnValues(tx, "kind_flows", { ...set, version: 2 }))}
        where kind_id = ${kind} and flow = ${flow}
        returning kind_id
      `;
  const insert =
    (table: string, values: Values) =>
    (tx: Tx): Promise<readonly unknown[]> =>
      insertReturning(tx, table, values);
  if (!Array.isArray(BARBER_A_COMBOS)) {
    throw new Error("seed-kinds-sample's barber flow A has no combos list");
  }

  /** Each probe breaks exactly one rule; each is run on the runtime side with no scope, so only that rule refuses it. */
  const PROBES: {
    breaks: string;
    run: (tx: Tx) => Promise<readonly unknown[]>;
    code: string;
    rule: string;
  }[] = [
    {
      breaks: "a trade-file kind whose id starts new-",
      run: insert("kinds", { ...BARBER_KIND, id: "new-barber" }),
      code: "23514",
      rule: "kinds_new_work_id",
    },
    {
      breaks: "a drafted kind whose id does not start new-",
      run: insert("kinds", { ...DRAFTED_KIND, id: "pack-hikes" }),
      code: "23514",
      rule: "kinds_new_work_id",
    },
    {
      breaks: "a drafted kind with facts of its own (its facts are its draft's)",
      run: insert("kinds", { ...DRAFTED_KIND, id: "new-pack-hikes-facts", facts: ["animals"] }),
      code: "23514",
      rule: "kinds_drafted_facts_on_draft",
    },
    {
      breaks: "a trade-file kind with no booking type",
      run: insert("kinds", { ...BARBER_KIND, id: "barber-no-style", style: null }),
      code: "23514",
      rule: "kinds_trade_file_has_style",
    },
    {
      breaks: "a pattern outside FS section 3's eleven",
      run: insert("kinds", { ...DRAFTED_KIND, id: "new-pack-hikes-walk", pattern: "walk" }),
      code: "23514",
      rule: "kinds_pattern_known",
    },
    {
      breaks: "a flow A path with flow B's own after",
      run: flowChange({ combos: [...BARBER_A_COMBOS, "list|card|own"] }),
      code: "23514",
      rule: "kind_flows_after_by_flow",
    },
    {
      breaks: "a path outside the master's price|before|after",
      run: flowChange({ combos: [...BARBER_A_COMBOS, "list|cash|counter"] }),
      code: "23514",
      rule: "kind_flows_combos_form",
    },
    {
      breaks: "a window's hours with a set start",
      run: flowChange({ arrive_window_hours: 2 }),
      code: "23514",
      rule: "kind_flows_window_hours",
    },
    {
      breaks: "work not booked that still names a kind",
      run: insert("picked_kinds", {
        ...BARBERSHOP_PICK,
        id: "pick-sam-not-booked",
        outcome: "not_booked",
        company_id: null,
      }),
      code: "23514",
      rule: "picked_kinds_kind_unless_not_booked",
    },
    {
      breaks: "a listed pick that names a drafted kind",
      run: insert("picked_kinds", {
        ...BARBERSHOP_PICK,
        id: "pick-sam-listed-drafted",
        kind_id: "new-pack-hikes",
        company_id: null,
      }),
      code: "23514",
      rule: "picked_kinds_outcome_matches_kind",
    },
    {
      breaks: "work not booked placed in a company",
      run: insert("picked_kinds", {
        ...BARBERSHOP_PICK,
        id: "pick-sam-not-booked",
        outcome: "not_booked",
        kind_id: null,
      }),
      code: "23514",
      rule: "picked_kinds_not_booked_unplaced",
    },
    {
      breaks: "a second pick of one company kind",
      run: insert("picked_kinds", { ...BARBERSHOP_PICK, id: "pick-sam-barbershop-again", position: 4 }),
      code: "23505",
      rule: "picked_kinds_one_per_company_kind",
    },
    {
      breaks: "a second draft for one pick",
      run: insert("new_work_drafts", { ...PACK_HIKES_DRAFT, id: "draft-pack-hikes-again" }),
      code: "23505",
      rule: "new_work_drafts_one_per_pick",
    },
    {
      breaks: "a draft state S1-03 does not name",
      run: (tx) => tx`
        update new_work_drafts set state = 'live', version = version + 1 where id = 'draft-pack-hikes' returning id
      `,
      code: "23514",
      rule: "new_work_drafts_state_known",
    },
    {
      breaks: "a block outside the checklist's 15",
      run: insert("new_work_draft_blocks", { ...ANSWERED_BLOCK, block: 16 }),
      code: "23514",
      rule: "new_work_draft_blocks_block_range",
    },
  ];

  /** The README's valid forms (its check of 2026-11-07), each passing on the runtime side. */
  const VALID: { form: string; run: (tx: Tx) => Promise<readonly unknown[]> }[] = [
    {
      form: "an empty facts list",
      run: insert("kinds", { ...BARBER_KIND, id: "barber-no-facts", facts: [] }),
    },
    { form: "a 3-hour window", run: flowChange({ arrive_window_hours: 3 }, "dog-walker", "B") },
    {
      form: "a pick not booked with nothing set up",
      run: insert("picked_kinds", {
        ...BARBERSHOP_PICK,
        id: "pick-sam-not-booked",
        outcome: "not_booked",
        kind_id: null,
        company_id: null,
        business_id: null,
      }),
    },
    {
      form: "a pick not yet placed beside its company's placed one",
      run: insert("picked_kinds", {
        ...BARBERSHOP_PICK,
        id: "pick-sam-barbershop-again",
        position: 4,
        company_id: null,
      }),
    },
    {
      form: "an answered block that sets a switch",
      run: insert("new_work_draft_blocks", { ...ANSWERED_BLOCK, block: 9, switches_on: ["sensitive"] }),
    },
    {
      form: "a draft the team approved",
      run: (tx) => tx`
        update new_work_drafts set state = 'approved', version = version + 1 where id = 'draft-pack-hikes'
        returning id
      `,
    },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
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

/** Each refused write with its one fault removed: K-24's README names the action that passes once it is fixed. */
const REFUSED_WRITES: { file: string; fixed: Values; without: string }[] = [
  {
    file: "invalid/refuse-typed-key-as-text-block.json",
    fixed: { pf_key: "pf.license" },
    without: "the same insert as pf.license",
  },
  {
    file: "invalid/refuse-main-path-not-listed.json",
    fixed: { main_combo: "list|none|counter" },
    without: "the same update to list|none|counter, a listed path",
  },
  {
    file: "invalid/refuse-pick-without-company-kind.json",
    fixed: { company_id: null },
    without: "the same pick not yet placed, company_id null",
  },
  {
    file: "invalid/refuse-no-block-with-facts.json",
    fixed: { facts_on: [] },
    without: "the same no setting nothing",
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

describe("invalid/refuse-cross-business-text-read.json: another business's text blocks are hidden from a Tool API call", () => {
  const refused = refusedOf("invalid/refuse-cross-business-text-read.json");
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> =>
    sql`select * from ${sql(refused.table)} where ${whereOf(sql, refused.where ?? {})}`;

  beforeAll(async () => {
    await reset();
    await loadFixtures(["invalid/refuse-cross-business-text-read.json"]);
  }, 60_000);

  it("scoped to the yoga studio, the read of the barbershop's text blocks returns no row, as the fixture expects, though all 11 are there", async () => {
    expect([refused.role, refused.action, refused.scope?.businessId]).toEqual([
      "toolApi",
      "select",
      YOGA_STUDIO,
    ]);
    expect(await read(db.sql)).toHaveLength(11);
    expect(await as(roleOf(refused), YOGA_STUDIO, read)).toHaveLength(refused.expect.rows ?? -1);
  });

  it("without its one fault (the barbershop's own scope) the same read returns all 11", async () => {
    expect(await as(TOOL_API, BARBERSHOP, read)).toHaveLength(11);
  });
});
