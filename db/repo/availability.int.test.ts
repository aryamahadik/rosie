// T-208: the availability part (K-27 v1: weekly_hours, time_off, classes, class_sessions, calendar_links,
// calendar_link_shares and busy_blocks, with README rules 1 to 7) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/availability`). The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app) or the runtime side (rosie_job) runs in its own transaction under SET LOCAL ROLE,
// with the call's settings set for that transaction: rosie.business_id through setBusinessScope() as a call is scoped,
// and rosie.person_id with set_config(..., true) as K-22 v1 rule 4 states it; then it is rolled back. Seed fixtures are
// loaded as the runtime side with no settings (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-27 v1's seeds and the K-04, K-22, K-23, K-24 and K-25 seeds their after
// chains name (Lee's Barbershop, Lee Home Services, the yoga studio, the movers, the pet boarding demo shop and the
// master's sample cast: Sam Lee, Riley, Avery and Maya). A row made here is a fixture row under a new id, or with one
// fault. The fixtures' sealed tokens are stand-in bytes; the sealing check seals a stand-in string under a wrapping key
// of random bytes made here and never written to a file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SealingError, type WrappingKeys, erasePerson, seal, unsealText } from "./sealing";
import { type Sql, type Tx, setBusinessScope } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/availability/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The seven tables, in code-unit order (as PostgreSQL orders a relation's name); all are versioned (README rule 3). */
const OWN_TABLES = [
  "busy_blocks",
  "calendar_link_shares",
  "calendar_links",
  "class_sessions",
  "classes",
  "time_off",
  "weekly_hours",
];
/** Scoped by business_id with 0012's two policies and no rule of their own (README rule 5). */
const PLAIN_SCOPED = ["class_sessions", "classes", "time_off", "weekly_hours"];
/** Scoped by business_id (the table list's rowLevelSecurity): the four and the shares. */
const BUSINESS_SCOPED = ["calendar_link_shares", ...PLAIN_SCOPED];
/** Scope none: a person's across every business, read by a business through a live share (README rule 5). */
const SPANNING = ["busy_blocks", "calendar_links"];
/** The other parts' tables the seven refer to by their keys (README rule 1). */
const REFERRED = ["businesses", "locations", "persons", "places_or_things", "resources", "services"];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
const PET_BOARDING = "biz-pet-boarding";
const SAM = "person-sam";
const RILEY = "person-riley";
const AVERY = "person-avery";
const MAYA = "person-maya";
const SLOW = { timeout: 120_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string; sealedBy?: string }[];
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
}

interface FixtureRow {
  table: string;
  values: Values;
}

/** A call's settings: rosie.business_id (K-04 rule 4) and rosie.person_id (K-22 rule 4); left out, unset. */
interface Scope {
  businessId?: string;
  personId?: string;
}

interface Refused {
  role: string;
  scope: Scope | null;
  action: string;
  table: string;
  columns?: string[];
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

const TABLES = (readJson(new URL("availability.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-27's seeds name it: from K-27's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-27 v1 lists no table ${name}`);
  }
  return table;
}

const columnsOf = (name: string): string[] => tableOf(name).columns.map((column) => column.name);

/** What the Tool API may read of a link, and write of a share (README rule 5): its column grants. */
const LINK_READ = columnsOf("calendar_links").filter((column) => column !== "tokens");
const SHARE_START = ["id", "calendar_link_id", "person_id", "business_id", "shared_at"];
const SHARE_END = ["ended_at", "version"];

/**
 * Each Tool API policy of README rule 5 that is not 0012's: its command and its expressions, word for word from the
 * README (the select policy of a share is "its business's rows", in the form of the README's other share policies).
 */
const RULE_POLICIES: { table: string; name: string; command: string; using?: string; check?: string }[] = [
  {
    table: "busy_blocks",
    name: "busy_blocks_tool_api_delete",
    command: "DELETE",
    using: "business_id = current_setting('rosie.business_id', true) and source = 'photo'",
  },
  {
    table: "busy_blocks",
    name: "busy_blocks_tool_api_insert",
    command: "INSERT",
    check: "business_id = current_setting('rosie.business_id', true) and source = 'photo'",
  },
  {
    table: "busy_blocks",
    name: "busy_blocks_tool_api_select",
    command: "SELECT",
    using:
      "(source = 'photo' and business_id = current_setting('rosie.business_id', true)) or (source = 'calendar' and exists (select 1 from calendar_link_shares s where s.calendar_link_id = busy_blocks.calendar_link_id and s.business_id = current_setting('rosie.business_id', true) and s.ended_at is null))",
  },
  {
    table: "busy_blocks",
    name: "busy_blocks_tool_api_update",
    command: "UPDATE",
    using: "business_id = current_setting('rosie.business_id', true) and source = 'photo'",
    check: "business_id = current_setting('rosie.business_id', true) and source = 'photo'",
  },
  {
    table: "calendar_link_shares",
    name: "calendar_link_shares_tool_api_insert",
    command: "INSERT",
    check:
      "business_id = current_setting('rosie.business_id', true) and person_id = nullif(current_setting('rosie.person_id', true), '')",
  },
  {
    table: "calendar_link_shares",
    name: "calendar_link_shares_tool_api_select",
    command: "SELECT",
    using: "business_id = current_setting('rosie.business_id', true)",
  },
  {
    table: "calendar_link_shares",
    name: "calendar_link_shares_tool_api_update",
    command: "UPDATE",
    using: "business_id = current_setting('rosie.business_id', true) and ended_at is null",
    check: "business_id = current_setting('rosie.business_id', true) and ended_at is not null",
  },
  {
    table: "calendar_links",
    name: "calendar_links_tool_api_select",
    command: "SELECT",
    using:
      "exists (select 1 from calendar_link_shares s where s.calendar_link_id = calendar_links.id and s.business_id = current_setting('rosie.business_id', true) and s.ended_at is null) or person_id = nullif(current_setting('rosie.person_id', true), '')",
  },
];

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's own row of `table` whose `column` is `value`. */
function valuesWhere(file: string, table: string, column: string, value: string): Values {
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values[column] === value,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row with ${column} ${value}`);
  }
  return row.values;
}

const valuesWithId = (file: string, table: string, id: string): Values => valuesWhere(file, table, "id", id);

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
 * file that names it, so K-27's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Every K-27 row of the five seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Lee's Barbershop's shop, open Monday 9:00am to 5:00pm (seed-hours). */
const SHOP_MONDAY = valuesWithId("seed-hours.json", "weekly_hours", "hours-lees-barbershop-shop-mon");
/** Avery's own Monday at the shop (seed-hours). */
const AVERY_MONDAY = valuesWithId("seed-hours.json", "weekly_hours", "hours-avery-mon");
/** Riley's day off for Mon Nov 2, lapsed with no answer (seed-time-off). */
const RILEY_OFF = valuesWithId("seed-time-off.json", "time_off", "off-riley-mon-nov-2");
/** Sam's BLOCK of the whole barbershop, Thu Oct 29, 2 to 5pm (seed-time-off). */
const SAM_BLOCK = valuesWithId("seed-time-off.json", "time_off", "block-lees-barbershop-thu-oct-29");
/** Avery's day off for Fri Nov 13, still asked (seed-time-off). */
const AVERY_ASKED = valuesWithId("seed-time-off.json", "time_off", "off-avery-fri-nov-13");
/** The Hot Flow class, Saturdays 10:00 to 11:00am with Maya in the Studio room (seed-session-seats). */
const HOT_FLOW = valuesWithId("seed-session-seats.json", "classes", "class-yoga-hot-flow-sat");
/** The Handstand workshop, a one-off session with Maya in the Studio room, Sat Nov 14 11:00am (seed-session-seats). */
const WORKSHOP = valuesWhere(
  "seed-session-seats.json",
  "class_sessions",
  "resource_id",
  "res-handstand-workshop",
);
/** Sam's dropped Outlook link and Riley's linked Google link (seed-calendar-link). */
const SAM_LINK = valuesWithId("seed-calendar-link.json", "calendar_links", "callink-sam-microsoft");
const RILEY_LINK = valuesWithId("seed-calendar-link.json", "calendar_links", "callink-riley-google");
/** Lee's Barbershop's share of Riley's link (seed-calendar-link). */
const RILEY_SHARE = valuesWithId("seed-calendar-link.json", "calendar_link_shares", "share-riley-barbershop");
/** Riley's personal event over Ben T.'s visit, and the movers' photo block of Sam's schedule (seed-busy-block). */
const RILEY_BLOCK = valuesWithId("seed-busy-block.json", "busy_blocks", "busy-riley-sat-nov-7");
const PHOTO_BLOCK = valuesWithId("seed-busy-block.json", "busy_blocks", "busy-sam-movers-photo-sat-nov-14");
/** A class session resource made here for the session probes: the yoga studio's, as K-04's seed writes one. */
const PROBE_SESSION_RESOURCE: Values = {
  id: "res-probe-session",
  business_id: YOGA_STUDIO,
  kind: "class_session",
  name: "Probe session",
  person_id: null,
  active: true,
  version: 1,
};
/** A session made here on that resource: the workshop's service, at 1:00pm, with nobody named and no room. */
const PROBE_SESSION: Values = {
  ...WORKSHOP,
  resource_id: "res-probe-session",
  during: "[2026-11-14T18:00:00Z,2026-11-14T19:00:00Z)",
  teacher_resource_id: null,
  room_resource_id: null,
  minimum: null,
};
/** A linked link made here for Maya, who has none: Google, with stand-in sealed bytes and no subscription. */
const MAYA_LINK: Values = {
  ...RILEY_LINK,
  id: "callink-maya-google",
  person_id: MAYA,
  sync_cursor: null,
  synced_at: null,
  subscription_id: null,
  subscription_resource_id: null,
  subscribed_at: null,
  subscription_expires_at: null,
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

/** Updates the row of `table` whose key is `key`, setting `set` and raising its version by one; gives it back. */
function updateOne(table: string, key: Values, set: Values): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) => tx<Record<string, unknown>[]>`
    update ${tx(table)} set ${tx(columnValues(tx, table, set))}, version = version + 1
    where ${whereOf(tx, key)}
    returning *
  `;
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
 * Runs `fn` in one transaction as `role` with the call's settings (null: none), then rolls it back. The business scope
 * is set as a call sets it (setBusinessScope), the person as K-22 rule 4 states it.
 */
async function as<T>(role: Role, scope: Scope | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (scope?.businessId !== undefined) {
        await setBusinessScope(tx, scope.businessId);
      }
      if (scope?.personId !== undefined) {
        await tx`select set_config('rosie.person_id', ${scope.personId}, true)`;
      }
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

/** A Tool API call under one business's scope, or with no scope (null). */
const tool = (businessId: string | null, personId?: string): Scope => ({
  ...(businessId === null ? {} : { businessId }),
  ...(personId === undefined ? {} : { personId }),
});

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

/** Runs `fn` in one transaction as `role` with no settings, and commits it. */
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
 * the server in the column's own type (a time, an instant, a range or bytes as PostgreSQL reads both; text exactly).
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
  // A bytea value goes as its bytes: postgres.js serializes a text parameter bound to bytea as the text's own bytes.
  const given = columnValues(db.sql, row.table, row.values);
  const found = await db.sql.unsafe<Record<string, boolean>[]>(
    `select ${compared.join(", ")} from "${row.table}" where ${matched.join(" and ")}`,
    [...columns.map((column) => given[column] as never), ...key.map((column) => textOf(row.values[column]))],
  );
  const label = `${row.table} ${JSON.stringify(keyOf(row))}`;
  expect(found, label).toHaveLength(1);
  expect(found[0], label).toEqual(Object.fromEntries(columns.map((column) => [column, true])));
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each of the five business-scoped tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_SCOPED) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the five business-scoped tables whose business_id is `businessId`, read as the owner. */
async function ownerRows(businessId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_SCOPED) {
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

/** The ids a read of `table` returns the caller, in code-unit order (a link read names only granted columns). */
async function idsIn(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`select id from ${tx(table)}`;
  return rows.map((row) => row.id).sort();
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

interface Policy {
  table: string;
  name: string;
  permissive: string;
  roles: string[];
  command: string;
  using: string | null;
  check: string | null;
}

const policiesIn = (sql: Sql | Tx, schema: string): Promise<Policy[]> => sql<Policy[]>`
  select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
         qual as using, with_check as check
  from pg_policies where schemaname = ${schema}
  order by tablename, policyname
`;

beforeAll(async () => {
  db = await createTestDatabase({ name: "availability" });
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

describe("the migration against the frozen table list (K-27 v1 availability)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    time: "time without time zone",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names seven tables: five scoped by business on business_id, a link and a busy block scoped none; all seven versioned on version, none with effective dates", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.versionColumn],
        table.name,
      ).toEqual(
        SPANNING.includes(table.name)
          ? ["none", undefined, true, "version"]
          : ["business", "business_id", true, "version"],
      );
      expect(table.effectiveDates, table.name).toBe(false);
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

  it("the three exclusions need no extension beyond 0001's: = on text and smallint through btree_gist (made in public by 0001), && on the ranges through PostgreSQL's own range_ops (README rule 2)", async () => {
    const [extension] = await db.sql<{ schema: string }[]>`
      select extnamespace::regnamespace::text as schema from pg_extension where extname = 'btree_gist'
    `;
    expect(extension?.schema).toBe("public");
    const classesOf = async (index: string): Promise<[string, string | null][]> => {
      const rows = await db.sql<{ opclass: string; extension: string | null }[]>`
        select o.opcname as opclass, e.extname as extension
        from pg_index i
          cross join lateral unnest(i.indclass::oid[]) with ordinality as k(opclass, position)
          join pg_opclass o on o.oid = k.opclass
          left join pg_depend d on d.classid = 'pg_opclass'::regclass and d.objid = o.oid and d.deptype = 'e'
          left join pg_extension e on e.oid = d.refobjid
        where i.indexrelid = ${`${db.schema}.${index}`}::regclass
        order by k.position
      `;
      return rows.map((row) => [row.opclass, row.extension]);
    };
    expect(await classesOf("weekly_hours_no_overlap")).toEqual([
      ["gist_text_ops", "btree_gist"],
      ["gist_text_ops", "btree_gist"],
      ["gist_int2_ops", "btree_gist"],
      ["range_ops", null],
    ]);
    for (const index of ["class_sessions_one_per_room", "class_sessions_one_per_teacher"]) {
      expect(await classesOf(index), index).toEqual([
        ["gist_text_ops", "btree_gist"],
        ["range_ops", null],
      ]);
    }
  });

  it("all seven raise their version on every update (0002's rule; README rule 3): <table>_version_raised, and no other trigger", async () => {
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

  it("calendar_links.tokens is the one sealed field (README rule 6): bytea, sealed by person_id in the table list, and no other column of the seven is bytea, so no plain copy is kept", () => {
    const sealed = TABLES.flatMap((table) =>
      table.columns
        .filter((column) => column.sealedBy !== undefined)
        .map((column) => [table.name, column.name, column.sealedBy]),
    );
    expect(sealed).toEqual([["calendar_links", "tokens", "person_id"]]);
    const bytea = [...typeOf.entries()]
      .filter(([key, type]) => type === "bytea" && OWN_TABLES.includes(key.split(".")[0] ?? ""))
      .map(([key]) => key);
    expect(bytea).toEqual(["calendar_links.tokens"]);
    // busy_blocks has no column for what an event is (refuse-busy-block-title; arch 05 line 261).
    for (const column of ["title", "description", "summary", "location", "attendees", "organizer"]) {
      expect(columnsOf("busy_blocks"), column).not.toContain(column);
      expect(typeOf.has(`busy_blocks.${column}`), column).toBe(false);
    }
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

  it("the seven refer only to K-04's businesses, persons and resources, K-23's locations and places_or_things, K-25's services and each other (rule 1): no foreign key names a K-22 table", async () => {
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

  it("is recorded in schema_migrations as availability, after rules, people_access and services_prices", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("availability");
    for (const before of ["rules", "people_access", "services_prices", "core_sealing_keys"]) {
      expect(names.indexOf("availability"), before).toBeGreaterThan(names.indexOf(before));
    }
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern; README rule 5)", () => {
  it("row-level security is on for all seven: the five scoped by business and the link and the busy block, which a business reads only through a live share; none is forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
  });

  it("each table's policies, by name, role and command: 0012's two on the four plain business-scoped tables; 0012's runtime policy and one Tool API policy per command on the shares; a runtime policy and the Tool API's select on the links; a runtime policy and one Tool API policy per command on the busy blocks", async () => {
    const own = (await policiesIn(db.sql, db.schema)).filter((policy) => OWN_TABLES.includes(policy.table));
    const shape = own.map((policy) => [
      policy.table,
      policy.name,
      policy.permissive,
      policy.roles,
      policy.command,
    ]);
    const expected = [
      ...PLAIN_SCOPED.flatMap((table) => [
        [table, `${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [table, `${table}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]),
      ...["calendar_link_shares", ...SPANNING].map((table) => [
        table,
        `${table}_runtime`,
        "PERMISSIVE",
        [RUNTIME],
        "ALL",
      ]),
      ...RULE_POLICIES.map((policy) => [policy.table, policy.name, "PERMISSIVE", [TOOL_API], policy.command]),
    ];
    const order = (rows: unknown[][]): unknown[][] =>
      [...rows].sort((a, b) =>
        `${String(a[0])} ${String(a[1])}`.localeCompare(`${String(b[0])} ${String(b[1])}`),
      );
    expect(order(shape)).toEqual(order(expected));
  });

  it("the four plain tables' policies and the shares' runtime policy are 0012's word for word (read from outbox_rows', which key on business_id); the links' and busy blocks' runtime policies admit every row (the runtime side is unscoped)", async () => {
    const all = await policiesIn(db.sql, db.schema);
    const of = (name: string): [string | null, string | null] => {
      const policy = all.find((candidate) => candidate.name === name);
      return [policy?.using ?? "missing", policy?.check ?? "missing"];
    };
    const coreRuntime = all.find((policy) => policy.name === "outbox_rows_runtime");
    const coreTool = all.find((policy) => policy.name === "outbox_rows_tool_api");
    expect(coreRuntime?.using).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
    for (const table of PLAIN_SCOPED) {
      expect(of(`${table}_runtime`), table).toEqual([coreRuntime?.using, coreRuntime?.check]);
      expect(of(`${table}_tool_api`), table).toEqual([coreTool?.using, coreTool?.check]);
    }
    expect(of("calendar_link_shares_runtime")).toEqual([coreRuntime?.using, coreRuntime?.check]);
    for (const table of SPANNING) {
      expect(of(`${table}_runtime`), table).toEqual(["true", "true"]);
    }
  });

  it("each Tool API policy of README rule 5 is the README's expression, as PostgreSQL reads both (built on copies of the three tables in a schema of their own, then compared)", async () => {
    const probe = `${db.schema}_probe`;
    const listed = await asOwner(async (tx) => {
      await tx.unsafe(`create schema ${probe}`);
      for (const table of ["calendar_links", "calendar_link_shares", "busy_blocks"]) {
        await tx.unsafe(`create table ${probe}.${table} (like ${db.schema}.${table})`);
      }
      await tx.unsafe(`set local search_path to ${probe}`);
      for (const policy of RULE_POLICIES) {
        const using = policy.using === undefined ? "" : ` using (${policy.using})`;
        const check = policy.check === undefined ? "" : ` with check (${policy.check})`;
        await tx.unsafe(
          `create policy ${policy.name} on ${policy.table} for ${policy.command.toLowerCase()} to ${TOOL_API}${using}${check}`,
        );
      }
      return policiesIn(tx, probe);
    });
    const own = (await policiesIn(db.sql, db.schema)).filter((policy) =>
      RULE_POLICIES.some((rule) => rule.name === policy.name),
    );
    const expressions = (policies: Policy[]) =>
      Object.fromEntries(policies.map((policy) => [policy.name, [policy.using, policy.check]]));
    expect(listed).toHaveLength(RULE_POLICIES.length);
    expect(expressions(own)).toEqual(expressions(listed));
  });

  it("table grants (DL-149, each to its named reader: the migration's header; README rule 5): both roles select, insert and update the four plain tables and only the Tool API deletes a span; the runtime side holds the link and the shares in full; the Tool API's table grants on them are only SELECT on the shares; both roles hold busy blocks in full; no truncate, references or trigger; nothing to PUBLIC", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const versioned = ["INSERT", "SELECT", "UPDATE"];
    const full = ["DELETE", "INSERT", "SELECT", "UPDATE"];
    const want: Record<Role, Record<string, string[]>> = {
      rosie_app: {
        busy_blocks: full,
        calendar_link_shares: ["SELECT"],
        class_sessions: versioned,
        classes: versioned,
        time_off: versioned,
        weekly_hours: full,
      },
      rosie_job: {
        busy_blocks: full,
        calendar_link_shares: versioned,
        calendar_links: versioned,
        class_sessions: versioned,
        classes: versioned,
        time_off: versioned,
        weekly_hours: versioned,
      },
    };
    expect(held.map((row) => `${row.role} ${row.table} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) =>
        Object.entries(want[role]).flatMap(([table, privileges]) =>
          privileges.map((privilege) => `${role} ${table} ${privilege}`),
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
  });

  it("column grants (README rule 5): the Tool API reads every calendar_links column but tokens, inserts a share's five columns and updates its end and version; no other column grant, and the tokens are neither readable nor writable by it", async () => {
    const granted = await db.sql<{ table: string; column: string; grantee: string; privilege: string }[]>`
      select c.relname as table, a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        cross join lateral aclexplode(a.attacl) g
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attacl is not null
    `;
    const want: [string, string, string[]][] = [
      ["calendar_links", "SELECT", LINK_READ],
      ["calendar_link_shares", "INSERT", SHARE_START],
      ["calendar_link_shares", "UPDATE", SHARE_END],
    ];
    expect(granted.map((row) => `${row.table} ${row.column} ${row.grantee} ${row.privilege}`).sort()).toEqual(
      want
        .flatMap(([table, privilege, columns]) =>
          columns.map((column) => `${table} ${column} ${TOOL_API} ${privilege}`),
        )
        .sort(),
    );
    expect(LINK_READ).toHaveLength(16);
    const tokens = await db.sql<{ privilege: string; held: boolean }[]>`
      select p.privilege,
             has_column_privilege(${TOOL_API}, ${`${db.schema}.calendar_links`}::regclass, 'tokens', p.privilege) as held
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(privilege)
    `;
    expect(tokens.map((row) => [row.privilege, row.held])).toEqual([
      ["SELECT", false],
      ["INSERT", false],
      ["UPDATE", false],
      ["REFERENCES", false],
    ]);
  });
});

describe("the seed fixtures load (fixtures/index.json): the five of 02-contracts' K-27 row", () => {
  /** The K-27 rows the five seeds give together, per table: every table gets rows (README). */
  const SEEDED = {
    busy_blocks: 3,
    calendar_link_shares: 4,
    calendar_links: 3,
    class_sessions: 3,
    classes: 1,
    time_off: 4,
    weekly_hours: 17,
  };

  it("the index lists the five seeds and eight refused rows, all K-27 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual([
      "seed-busy-block.json",
      "seed-calendar-link.json",
      "seed-hours.json",
      "seed-session-seats.json",
      "seed-time-off.json",
    ]);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-busy-block-other-business-read.json",
      "invalid/refuse-busy-block-title.json",
      "invalid/refuse-calendar-tokens-read.json",
      "invalid/refuse-connecting-with-tokens.json",
      "invalid/refuse-icloud-link.json",
      "invalid/refuse-photo-block-without-yes.json",
      "invalid/refuse-share-for-another-person.json",
      "invalid/refuse-two-sessions-one-room.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-27 row is stored as given`,
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

  it("all five insert together, each after chain once, and every table gets rows", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    for (const table of OWN_TABLES) {
      expect(await countRows(db.sql, table), table).toBe(SEEDED[table as keyof typeof SEEDED]);
    }
    for (const row of SEED_ROWS) {
      await expectStored(row);
    }
  });

  it(
    "they insert together with every K-04 v1, K-23 v1, K-22 v1.1, K-24 v1 and K-25 v1 seed as well, each file once: no K-27 row shares a key with another part's",
    SLOW,
    async () => {
      await reset();
      const others = [
        ...seedsOf("core"),
        ...seedsOf("business-setup"),
        ...seedsOf("people-access"),
        ...seedsOf("kinds-of-work"),
        ...seedsOf("services-prices"),
      ];
      expect(others.length).toBeGreaterThan(SEEDS.length);
      const loaded = await loadFixtures([...others, ...SEEDS]);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    },
  );
});

describe("the seeded rows: what the five seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it("H01's hours as local times with their zone: Lee's Barbershop's shop Mon to Fri 9:00am to 5:00pm and Sat 10:00am to 2:00pm, Avery's own Mon to Fri at the shop, and the yoga studio's shop the same; Saturday Nov 7, read in the shop's zone after daylight time ended, is 15:00 to 19:00 UTC", async () => {
    const spans = await db.sql<
      { owner: string; days: string; opens: string; closes: string; zone: string }[]
    >`
      select coalesce(resource_id, location_id) as owner, string_agg(weekday::text, '' order by weekday) as days,
             opens_at::text as opens, closes_at::text as closes, time_zone as zone
      from weekly_hours
      group by business_id, coalesce(resource_id, location_id), opens_at, closes_at, time_zone
      order by 1, 2
    `;
    expect(spans).toEqual([
      {
        owner: "loc-lees-barbershop-shop",
        days: "12345",
        opens: "09:00:00",
        closes: "17:00:00",
        zone: "America/New_York",
      },
      {
        owner: "loc-lees-barbershop-shop",
        days: "6",
        opens: "10:00:00",
        closes: "14:00:00",
        zone: "America/New_York",
      },
      {
        owner: "loc-yoga-studio-shop",
        days: "12345",
        opens: "09:00:00",
        closes: "17:00:00",
        zone: "America/New_York",
      },
      {
        owner: "loc-yoga-studio-shop",
        days: "6",
        opens: "10:00:00",
        closes: "14:00:00",
        zone: "America/New_York",
      },
      { owner: "res-avery", days: "12345", opens: "09:00:00", closes: "17:00:00", zone: "America/New_York" },
    ]);
    const [saturday] = await db.sql<{ opens: Date; closes: Date }[]>`
      select (date '2026-11-07' + opens_at) at time zone time_zone as opens,
             (date '2026-11-07' + closes_at) at time zone time_zone as closes
      from weekly_hours where id = 'hours-lees-barbershop-shop-sat'
    `;
    expect([saturday?.opens.toISOString(), saturday?.closes.toISOString()]).toEqual([
      "2026-11-07T15:00:00.000Z",
      "2026-11-07T19:00:00.000Z",
    ]);
  });

  it("the times card's reads: Riley's busy block takes 2:00pm Sat Nov 7 out and 3:00pm stays open; Sam's BLOCK takes Thu Oct 29 2:00pm out; Riley's lapsed Mon Nov 2 stays open and Avery's asked Fri Nov 13 is out (only asked and ok rows take times out)", async () => {
    const busyAt = async (person: string, at: string): Promise<string[]> => {
      const rows = await db.sql<{ id: string }[]>`
        select id from busy_blocks where person_id = ${person} and during @> ${at}::timestamptz order by id
      `;
      return rows.map((row) => row.id);
    };
    expect(await busyAt(RILEY, "2026-11-07T19:00:00Z")).toEqual(["busy-riley-sat-nov-7"]);
    expect(await busyAt(RILEY, "2026-11-07T20:00:00Z")).toEqual([]);
    const offAt = async (at: string): Promise<string[]> => {
      const rows = await db.sql<{ id: string }[]>`
        select id from time_off
        where business_id = ${BARBERSHOP} and status in ('asked', 'ok') and during @> ${at}::timestamptz
        order by id
      `;
      return rows.map((row) => row.id);
    };
    expect(await offAt("2026-10-29T19:00:00Z")).toEqual(["block-lees-barbershop-thu-oct-29"]);
    expect(await offAt("2026-11-02T15:00:00Z")).toEqual([]);
    expect(await offAt("2026-11-13T15:00:00Z")).toEqual(["off-avery-fri-nov-13"]);
    const [lapsed] = await db.sql<{ status: string; by: string | null }[]>`
      select status, status_by_person_id as by from time_off where id = 'off-riley-mon-nov-2'
    `;
    expect(lapsed).toEqual({ status: "lapsed", by: null });
  });

  it("S1-83's timetable and A4-33's sessions: the Hot Flow class with Maya in the Studio room, 12 seats and a minimum of 3; its Sat Nov 14 session scheduled with 12 seats in its K-04 counter; its Sat Nov 7 session counted with too few and cancelled by Sam; the Handstand workshop a session with no class, 10 seats and 2 taken", async () => {
    const sessions = await db.sql<
      {
        session: string;
        klass: string | null;
        service: string;
        teacher: string | null;
        room: string | null;
        status: string;
        tooFew: boolean | null;
        by: string | null;
        capacity: number;
        taken: number;
      }[]
    >`
      select s.resource_id as session, s.class_id as klass, s.service_id as service, s.teacher_resource_id as teacher,
             s.room_resource_id as room, s.status, s.too_few as "tooFew", s.cancelled_by_person_id as by,
             c.capacity, c.taken
      from class_sessions s join class_seats c on c.resource_id = s.resource_id
      order by s.resource_id
    `;
    expect(sessions).toEqual([
      {
        session: "res-handstand-workshop",
        klass: null,
        service: "svc-yoga-handstand-workshop",
        teacher: "res-maya",
        room: "res-studio-room",
        status: "scheduled",
        tooFew: null,
        by: null,
        capacity: 10,
        taken: 2,
      },
      {
        session: "res-hot-flow-sat-nov-14",
        klass: "class-yoga-hot-flow-sat",
        service: "svc-yoga-hot-flow",
        teacher: "res-maya",
        room: "res-studio-room",
        status: "scheduled",
        tooFew: null,
        by: null,
        capacity: 12,
        taken: 0,
      },
      {
        session: "res-hot-flow-sat-nov-7",
        klass: "class-yoga-hot-flow-sat",
        service: "svc-yoga-hot-flow",
        teacher: "res-maya",
        room: "res-studio-room",
        status: "cancelled",
        tooFew: true,
        by: SAM,
        capacity: 12,
        taken: 0,
      },
    ]);
    const [klass] = await db.sql<{ seats: number; minimum: number | null; service: string }[]>`
      select seats, minimum, service_id as service from classes where id = 'class-yoga-hot-flow-sat'
    `;
    expect(klass).toEqual({ seats: 12, minimum: 3, service: "svc-yoga-hot-flow" });
  });

  it("one link per person, read through shares: Sam's Outlook link dropped with its one reminder and read by both his businesses; Riley's Google link linked and read by the barbershop; Avery's connecting with no tokens and no linked time; each linked or dropped link holds sealed bytes", async () => {
    const links = await db.sql<
      { id: string; person: string; provider: string; state: string; sealed: boolean; linked: boolean }[]
    >`
      select id, person_id as person, provider, state, tokens is not null as sealed, linked_at is not null as linked
      from calendar_links order by id
    `;
    expect(links).toEqual([
      {
        id: "callink-avery-google",
        person: AVERY,
        provider: "google",
        state: "connecting",
        sealed: false,
        linked: false,
      },
      {
        id: "callink-riley-google",
        person: RILEY,
        provider: "google",
        state: "linked",
        sealed: true,
        linked: true,
      },
      {
        id: "callink-sam-microsoft",
        person: SAM,
        provider: "microsoft",
        state: "dropped",
        sealed: true,
        linked: true,
      },
    ]);
    const shares = await db.sql<{ link: string; business: string }[]>`
      select calendar_link_id as link, business_id as business from calendar_link_shares
      where ended_at is null order by 1, 2
    `;
    expect(shares).toEqual([
      { link: "callink-avery-google", business: BARBERSHOP },
      { link: "callink-riley-google", business: BARBERSHOP },
      { link: "callink-sam-microsoft", business: HOME_SERVICES },
      { link: "callink-sam-microsoft", business: BARBERSHOP },
    ]);
    const blocks = await db.sql<{ id: string; source: string; business: string | null }[]>`
      select id, source, business_id as business from busy_blocks order by id
    `;
    expect(blocks).toEqual([
      { id: "busy-riley-sat-nov-7", source: "calendar", business: null },
      { id: "busy-sam-movers-photo-sat-nov-14", source: "photo", business: MOVERS },
      { id: "busy-sam-thu-nov-12", source: "calendar", business: null },
    ]);
  });
});

describe("row-level security on the seven tables, the five seeds loaded (README rule 5)", () => {
  const zeros = Object.fromEntries(BUSINESS_SCOPED.map((table) => [table, 0]));

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  it(
    "the five business-scoped tables: with no scope the Tool API reads no row; each business's scope shows exactly its own rows; the runtime side with no scope reads every row, and with a scope set (per write) only that business's",
    SLOW,
    async () => {
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual(
        expect.arrayContaining([BARBERSHOP, HOME_SERVICES, MOVERS, PET_BOARDING, YOGA_STUDIO]),
      );
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, tool(business), visibleRows), business).toEqual(await ownerRows(business));
        expect(await as(RUNTIME, tool(business), visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await ownerRows(BARBERSHOP)).toEqual({
        calendar_link_shares: 3,
        class_sessions: 0,
        classes: 0,
        time_off: 3,
        weekly_hours: 11,
      });
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
    },
  );

  it("the Tool API writes only its scope's rows of the four plain tables: another business's insert is refused (42501), its update finds no row, a row cannot move to another business; it deletes its own span, and never a window, a class or a session (42501)", async () => {
    const span: Values = { ...SHOP_MONDAY, id: "hours-lees-barbershop-shop-sun", weekday: 7 };
    const addSpan = (tx: Tx) => insertReturning(tx, "weekly_hours", span);
    expect((await refusal(as(TOOL_API, tool(YOGA_STUDIO), addSpan))).code).toBe("42501");
    expect(await as(TOOL_API, tool(BARBERSHOP), addSpan)).toHaveLength(1);
    const bump = updateOne("time_off", { id: "block-lees-barbershop-thu-oct-29" }, { status: "cancelled" });
    expect(await as(TOOL_API, tool(YOGA_STUDIO), bump)).toHaveLength(0);
    expect(await as(TOOL_API, tool(BARBERSHOP), bump)).toHaveLength(1);
    const move = updateOne("weekly_hours", { id: "hours-avery-mon" }, { business_id: YOGA_STUDIO });
    expect((await refusal(as(TOOL_API, tool(BARBERSHOP), move))).code).toBe("42501");
    const removeSpan = (tx: Tx) => tx<{ id: string }[]>`
      delete from weekly_hours where id = 'hours-avery-mon' returning id
    `;
    expect(await as(TOOL_API, tool(BARBERSHOP), removeSpan)).toEqual([{ id: "hours-avery-mon" }]);
    expect(await as(TOOL_API, tool(YOGA_STUDIO), removeSpan)).toEqual([]);
    for (const table of ["class_sessions", "classes", "time_off"]) {
      const removed = await refusal(as(TOOL_API, tool(YOGA_STUDIO), (tx) => tx`delete from ${tx(table)}`));
      expect([removed.code, removed.message], table).toEqual([
        "42501",
        `permission denied for table ${table}`,
      ]);
    }
  });

  it("the runtime side deletes no hours, window, class, session, link or share (42501): K-05's state writes insert and update only, and a link and a share are kept as the record", async () => {
    for (const table of OWN_TABLES.filter((name) => name !== "busy_blocks")) {
      const removed = await refusal(as(RUNTIME, null, (tx) => tx`delete from ${tx(table)}`));
      expect([removed.code, removed.message], table).toEqual([
        "42501",
        `permission denied for table ${table}`,
      ]);
    }
  });

  it("calendar_links: the barbershop reads Sam's, Riley's and Avery's links through its live shares, Lee Home Services Sam's, the yoga studio and the movers none; a call with no business reads only its own person's link; the runtime side reads every link, scoped or not", async () => {
    const links = (tx: Tx) => idsIn(tx, "calendar_links");
    expect(await as(TOOL_API, tool(BARBERSHOP), links)).toEqual([
      "callink-avery-google",
      "callink-riley-google",
      "callink-sam-microsoft",
    ]);
    expect(await as(TOOL_API, tool(HOME_SERVICES), links)).toEqual(["callink-sam-microsoft"]);
    expect(await as(TOOL_API, tool(YOGA_STUDIO), links)).toEqual([]);
    expect(await as(TOOL_API, tool(MOVERS), links)).toEqual([]);
    expect(await as(TOOL_API, null, links)).toEqual([]);
    expect(await as(TOOL_API, tool(null, SAM), links)).toEqual(["callink-sam-microsoft"]);
    expect(await as(TOOL_API, tool(null, RILEY), links)).toEqual(["callink-riley-google"]);
    expect(await as(TOOL_API, tool(YOGA_STUDIO, RILEY), links)).toEqual(["callink-riley-google"]);
    const all = ["callink-avery-google", "callink-riley-google", "callink-sam-microsoft"];
    expect(await as(RUNTIME, null, links)).toEqual(all);
    expect(await as(RUNTIME, tool(YOGA_STUDIO), links)).toEqual(all);
  });

  it("calendar_links: the Tool API's select *, a read naming the tokens and a search by them are refused (42501), as are its insert, update and delete of a link: every write of a link is the runtime side's", async () => {
    const attempts: [string, (tx: Tx) => Promise<unknown>][] = [
      ["select *", (tx) => tx`select * from calendar_links`],
      ["read the tokens", (tx) => tx`select id, tokens from calendar_links`],
      ["search by the tokens", (tx) => tx`select id from calendar_links where tokens is not null`],
      [
        "insert a link",
        (tx) =>
          insertRow(tx, "calendar_links", {
            ...MAYA_LINK,
            tokens: null,
            state: "connecting",
            linked_at: null,
          }),
      ],
      ["update a link", (tx) => tx`update calendar_links set state = 'unlinked', version = version + 1`],
      ["delete a link", (tx) => tx`delete from calendar_links`],
    ];
    for (const [what, attempt] of attempts) {
      const refused = await refusal(as(TOOL_API, tool(BARBERSHOP, RILEY), attempt));
      expect([refused.code, refused.message], what).toEqual([
        "42501",
        "permission denied for table calendar_links",
      ]);
    }
  });

  it("busy_blocks: the barbershop reads Riley's and Sam's calendar blocks through its shares, Lee Home Services Sam's, the movers only their own photo block, the yoga studio none; the runtime side reads every block, scoped or not", async () => {
    const blocks = (tx: Tx) => idsIn(tx, "busy_blocks");
    expect(await as(TOOL_API, tool(BARBERSHOP), blocks)).toEqual([
      "busy-riley-sat-nov-7",
      "busy-sam-thu-nov-12",
    ]);
    expect(await as(TOOL_API, tool(HOME_SERVICES), blocks)).toEqual(["busy-sam-thu-nov-12"]);
    expect(await as(TOOL_API, tool(MOVERS), blocks)).toEqual(["busy-sam-movers-photo-sat-nov-14"]);
    expect(await as(TOOL_API, tool(YOGA_STUDIO), blocks)).toEqual([]);
    expect(await as(TOOL_API, null, blocks)).toEqual([]);
    const all = ["busy-riley-sat-nov-7", "busy-sam-movers-photo-sat-nov-14", "busy-sam-thu-nov-12"];
    expect(await as(RUNTIME, null, blocks)).toEqual(all);
    expect(await as(RUNTIME, tool(YOGA_STUDIO), blocks)).toEqual(all);
  });

  it("busy_blocks: the Tool API writes only its own photo rows: a calendar block it writes is refused (42501), its update or delete of one changes no row, turning a photo block into a calendar block is refused (42501), and the movers delete their own photo block", async () => {
    const calendarBlock: Values = {
      ...RILEY_BLOCK,
      id: "busy-riley-probe",
      provider_event_ref: "gcal-ev-riley-probe",
    };
    for (const [business, values] of [
      [BARBERSHOP, calendarBlock],
      [BARBERSHOP, { ...calendarBlock, business_id: BARBERSHOP }],
    ] as const) {
      const refused = await refusal(
        as(TOOL_API, tool(business), (tx) => insertRow(tx, "busy_blocks", values)),
      );
      expect(refused.code).toBe("42501");
      expect(refused.message).toContain("row-level security");
    }
    const moveCalendar = (tx: Tx) => tx<{ id: string }[]>`
      update busy_blocks set during = '[2026-11-07T20:00:00Z,2026-11-07T21:00:00Z)', version = version + 1
      where id = 'busy-riley-sat-nov-7' returning id
    `;
    expect(await as(TOOL_API, tool(BARBERSHOP), moveCalendar)).toEqual([]);
    const removeCalendar = (tx: Tx) => tx<{ id: string }[]>`
      delete from busy_blocks where id = 'busy-riley-sat-nov-7' returning id
    `;
    expect(await as(TOOL_API, tool(BARBERSHOP), removeCalendar)).toEqual([]);
    const toCalendar = (tx: Tx) => tx`
      update busy_blocks
      set source = 'calendar', business_id = null, calendar_link_id = 'callink-sam-microsoft',
          provider_event_ref = 'graph-ev-sam-probe', confirmed_at = null, confirmed_by_person_id = null,
          version = version + 1
      where id = 'busy-sam-movers-photo-sat-nov-14'
    `;
    expect((await refusal(as(TOOL_API, tool(MOVERS), toCalendar))).code).toBe("42501");
    const removePhoto = (tx: Tx) => tx<{ id: string }[]>`
      delete from busy_blocks where id = 'busy-sam-movers-photo-sat-nov-14' returning id
    `;
    expect(await as(TOOL_API, tool(MOVERS), removePhoto)).toEqual([
      { id: "busy-sam-movers-photo-sat-nov-14" },
    ]);
    expect(await as(TOOL_API, tool(BARBERSHOP), removePhoto)).toEqual([]);
    // The runtime side writes a calendar block with no business, and deletes one (calendar sync in).
    expect(await as(RUNTIME, null, insertEach(["busy_blocks", calendarBlock]))).toHaveLength(1);
    expect(await as(RUNTIME, null, removeCalendar)).toEqual([{ id: "busy-riley-sat-nov-7" }]);
  });

  it("calendar_link_shares: a share starts only in the calendar's own person's call at that business; for someone else's calendar, another business or a call with no person it is refused (42501); naming its end or version is refused (42501), and a second live share of one person at one business is refused (23505)", async () => {
    const share = (values: Values = {}): Values => ({
      id: "share-riley-home-services",
      calendar_link_id: "callink-riley-google",
      person_id: RILEY,
      business_id: HOME_SERVICES,
      shared_at: "2026-11-07T17:00:00Z",
      ...values,
    });
    const start = (values: Values) => (tx: Tx) => insertRow(tx, "calendar_link_shares", values);
    const started = await as(TOOL_API, tool(HOME_SERVICES, RILEY), async (tx) => {
      await start(share())(tx);
      return tx<{ ended: Date | null; version: number }[]>`
        select ended_at as ended, version from calendar_link_shares where id = 'share-riley-home-services'
      `;
    });
    expect(started).toEqual([{ ended: null, version: 1 }]);
    for (const [what, scope, values] of [
      ["Sam's call sharing Riley's calendar", tool(HOME_SERVICES, SAM), share()],
      [
        "Riley's call sharing it with another business",
        tool(HOME_SERVICES, RILEY),
        share({ business_id: MOVERS }),
      ],
      ["a call with no person", tool(HOME_SERVICES), share()],
    ] as const) {
      const refused = await refusal(as(TOOL_API, scope, start(values)));
      expect([refused.code, refused.message], what).toEqual([
        "42501",
        'new row violates row-level security policy for table "calendar_link_shares"',
      ]);
    }
    for (const extra of [{ ended_at: "2026-11-07T18:00:00Z" }, { version: 1 }]) {
      const refused = await refusal(as(TOOL_API, tool(HOME_SERVICES, RILEY), start(share(extra))));
      expect([refused.code, refused.message], Object.keys(extra).join()).toEqual([
        "42501",
        "permission denied for table calendar_link_shares",
      ]);
    }
    const second = await refusal(
      as(
        TOOL_API,
        tool(BARBERSHOP, SAM),
        start({
          ...share(),
          id: "share-sam-barbershop-again",
          calendar_link_id: "callink-sam-microsoft",
          person_id: SAM,
          business_id: BARBERSHOP,
        }),
      ),
    );
    expect([second.code, second.constraint]).toEqual(["23505", "calendar_link_shares_one_per_person"]);
  });

  it("calendar_link_shares: the barbershop ends its own live share of Riley's link, after which it reads no link and no block of his, and never reopens it; Lee Home Services ending it changes no row; an update that does not end it, moving it to another business, or deleting it is refused (42501)", async () => {
    const end = (tx: Tx) => tx<{ id: string; version: number }[]>`
      update calendar_link_shares set ended_at = '2026-11-08T12:00:00Z', version = version + 1
      where id = 'share-riley-barbershop' returning id, version
    `;
    expect(await as(TOOL_API, tool(HOME_SERVICES), end)).toEqual([]);
    const after = await as(TOOL_API, tool(BARBERSHOP), async (tx) => {
      const ended = await end(tx);
      const links = await idsIn(tx, "calendar_links");
      const blocks = await idsIn(tx, "busy_blocks");
      const reopened = await tx<{ id: string }[]>`
        update calendar_link_shares set ended_at = null, version = version + 1
        where id = 'share-riley-barbershop' returning id
      `;
      return { ended, links, blocks, reopened };
    });
    expect(after).toEqual({
      ended: [{ id: "share-riley-barbershop", version: 2 }],
      links: ["callink-avery-google", "callink-sam-microsoft"],
      blocks: ["busy-sam-thu-nov-12"],
      reopened: [],
    });
    const keepLive = await refusal(
      as(
        TOOL_API,
        tool(BARBERSHOP),
        (tx) => tx`
        update calendar_link_shares set version = version + 1 where id = 'share-riley-barbershop'
      `,
      ),
    );
    expect([keepLive.code, keepLive.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "calendar_link_shares"',
    ]);
    for (const statement of [
      "update calendar_link_shares set business_id = 'biz-yoga-studio', ended_at = now(), version = version + 1",
      "delete from calendar_link_shares",
    ]) {
      const refused = await refusal(as(TOOL_API, tool(BARBERSHOP), (tx) => tx.unsafe(statement)));
      expect([refused.code, refused.message], statement).toEqual([
        "42501",
        "permission denied for table calendar_link_shares",
      ]);
    }
  });
});

describe("the rules the table list holds: each row that breaks one rule is refused by that rule alone, and the README's valid forms pass", () => {
  const hours = (fault: Values) =>
    insertEach(["weekly_hours", { ...SHOP_MONDAY, id: "hours-probe", ...fault }]);
  const off = (base: Values, fault: Values) =>
    insertEach(["time_off", { ...base, id: "off-probe", ...fault }]);
  const klass = (fault: Values) => insertEach(["classes", { ...HOT_FLOW, id: "class-probe", ...fault }]);
  const session = (fault: Values) =>
    insertEach(["resources", PROBE_SESSION_RESOURCE], ["class_sessions", { ...PROBE_SESSION, ...fault }]);
  const link = (fault: Values) => insertEach(["calendar_links", { ...MAYA_LINK, ...fault }]);
  const relink = (base: Values, set: Values) => updateOne("calendar_links", { id: textOf(base.id) }, set);
  const share = (fault: Values) =>
    insertEach([
      "calendar_link_shares",
      { ...RILEY_SHARE, id: "share-probe", business_id: YOGA_STUDIO, ...fault },
    ]);
  const block = (fault: Values) =>
    insertEach([
      "busy_blocks",
      { ...RILEY_BLOCK, id: "busy-probe", provider_event_ref: "gcal-ev-riley-probe", ...fault },
    ]);

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  const REFUSED: { breaks: string; rule: string; code: string; write: (tx: Tx) => Promise<unknown> }[] = [
    {
      breaks: "a span of the shop overlapping its Monday",
      rule: "weekly_hours_no_overlap",
      code: "23P01",
      write: hours({ opens_at: "16:00", closes_at: "18:00" }),
    },
    {
      breaks: "Avery's own span overlapping his Monday, at any of the business's locations",
      rule: "weekly_hours_no_overlap",
      code: "23P01",
      write: insertEach([
        "weekly_hours",
        { ...AVERY_MONDAY, id: "hours-probe", location_id: null, opens_at: "16:00", closes_at: "18:00" },
      ]),
    },
    {
      breaks: "a span backwards",
      rule: "weekly_hours_span_in_order",
      code: "23514",
      write: hours({ weekday: 7, opens_at: "17:00", closes_at: "09:00" }),
    },
    { breaks: "day 8", rule: "weekly_hours_weekday_known", code: "23514", write: hours({ weekday: 8 }) },
    {
      breaks: "a zone that is not an IANA name",
      rule: "weekly_hours_time_zone_form",
      code: "23514",
      write: hours({ weekday: 7, time_zone: "Eastern Time" }),
    },
    {
      breaks: "a space's hours naming a location",
      rule: "weekly_hours_one_owner",
      code: "23514",
      write: hours({
        business_id: PET_BOARDING,
        owner_kind: "place",
        place_or_thing_id: "place-pet-boarding-suite",
      }),
    },
    {
      breaks: "a class session as an hours owner",
      rule: "weekly_hours_resource_kind_known",
      code: "23514",
      write: hours({
        business_id: YOGA_STUDIO,
        owner_kind: "resource",
        location_id: null,
        resource_id: "res-handstand-workshop",
        resource_kind: "class_session",
      }),
    },
    {
      breaks: "a room off (time off is a person's)",
      rule: "time_off_kind_fits_owner",
      code: "23514",
      write: off(RILEY_OFF, {
        business_id: YOGA_STUDIO,
        resource_id: "res-studio-room",
        resource_kind: "room",
      }),
    },
    {
      breaks: "a worker closed (a person is off, never closed)",
      rule: "time_off_kind_fits_owner",
      code: "23514",
      write: off(RILEY_OFF, { kind: "closed" }),
    },
    {
      breaks: "the whole business off",
      rule: "time_off_kind_fits_owner",
      code: "23514",
      write: off(SAM_BLOCK, { kind: "off" }),
    },
    {
      breaks: "a lapsed row with a person",
      rule: "time_off_status_by_known",
      code: "23514",
      write: off(RILEY_OFF, { status_by_person_id: SAM }),
    },
    {
      breaks: "an asked row set by someone other than the asker",
      rule: "time_off_asked_is_asker",
      code: "23514",
      write: off(AVERY_ASKED, { status_by_person_id: SAM }),
    },
    {
      breaks: "an answer before the ask",
      rule: "time_off_times_in_order",
      code: "23514",
      write: off(SAM_BLOCK, { status_at: "2026-10-26T15:31:00Z" }),
    },
    {
      breaks: "an open-ended window",
      rule: "time_off_window_bounded",
      code: "23514",
      write: off(AVERY_ASKED, { during: "[2026-11-13T05:00:00Z,)" }),
    },
    {
      breaks: "a class with no seats",
      rule: "classes_seats_positive",
      code: "23514",
      write: klass({ seats: 0 }),
    },
    {
      breaks: "a minimum of 0",
      rule: "classes_minimum_positive",
      code: "23514",
      write: klass({ minimum: 0 }),
    },
    {
      breaks: "a teacher kind other than worker",
      rule: "classes_teacher_is_worker",
      code: "23514",
      write: klass({ teacher_kind: "room" }),
    },
    {
      breaks: "a room as the teacher",
      rule: "classes_teacher_fk",
      code: "23503",
      write: klass({ teacher_resource_id: "res-studio-room" }),
    },
    {
      breaks: "a worker as the room",
      rule: "classes_room_fk",
      code: "23503",
      write: klass({ room_resource_id: "res-maya" }),
    },
    {
      breaks: "a class selling no service of its business",
      rule: "classes_service_fk",
      code: "23503",
      write: klass({ service_id: "svc-yoga-yin" }),
    },
    {
      breaks: "Maya teaching two sessions at once",
      rule: "class_sessions_one_per_teacher",
      code: "23P01",
      write: session({
        teacher_resource_id: "res-maya",
        during: "[2026-11-14T16:30:00Z,2026-11-14T17:30:00Z)",
      }),
    },
    {
      breaks: "a count after the start",
      rule: "class_sessions_counted_whole",
      code: "23514",
      write: session({ counted_at: "2026-11-14T18:30:00Z", too_few: false }),
    },
    {
      breaks: "a count with no answer",
      rule: "class_sessions_counted_whole",
      code: "23514",
      write: session({ counted_at: "2026-11-13T18:00:00Z" }),
    },
    {
      breaks: "a cancel with no who",
      rule: "class_sessions_cancelled_has_time",
      code: "23514",
      write: session({ status: "cancelled", cancelled_at: "2026-11-13T18:00:00Z" }),
    },
    {
      breaks: "a worker resource as a session",
      rule: "class_sessions_resource_fk",
      code: "23503",
      write: insertEach([
        "class_sessions",
        { ...PROBE_SESSION, resource_id: "res-riley", business_id: YOGA_STUDIO },
      ]),
    },
    {
      breaks: "a session of a class that does not exist",
      rule: "class_sessions_class_fk",
      code: "23503",
      write: session({ class_id: "class-yoga-nowhere" }),
    },
    {
      breaks: "a second live link for Sam",
      rule: "calendar_links_one_live_per_person",
      code: "23505",
      write: link({ id: "callink-sam-google", person_id: SAM }),
    },
    {
      breaks: "Sam's Graph subscription on another Microsoft link",
      rule: "calendar_links_subscription_key",
      code: "23505",
      write: link({
        provider: "microsoft",
        subscription_id: "graph-sub-sam-01",
        subscribed_at: "2026-11-06T09:21:30Z",
        subscription_expires_at: "2026-11-13T09:20:30Z",
      }),
    },
    {
      breaks: "an iCloud link",
      rule: "calendar_links_provider_known",
      code: "23514",
      write: link({ provider: "apple" }),
    },
    {
      breaks: "a connecting row with a linked time",
      rule: "calendar_links_linked_has_time",
      code: "23514",
      write: link({ state: "connecting", tokens: null }),
    },
    {
      breaks: "a linked row with no tokens",
      rule: "calendar_links_tokens_while_live",
      code: "23514",
      write: link({ tokens: null }),
    },
    {
      breaks: "a connecting row with a cursor",
      rule: "calendar_links_connecting_unread",
      code: "23514",
      write: link({ state: "connecting", tokens: null, linked_at: null, sync_cursor: "gcal-sync-maya-0001" }),
    },
    {
      breaks: "an unlink keeping its subscription",
      rule: "calendar_links_subscription_whole",
      code: "23514",
      write: relink(RILEY_LINK, { state: "unlinked", tokens: null, unlinked_at: "2026-11-08T12:00:00Z" }),
    },
    {
      breaks: "a drop reason outside the list",
      rule: "calendar_links_dropped_has_time",
      code: "23514",
      write: relink(RILEY_LINK, {
        state: "dropped",
        dropped_at: "2026-11-08T12:00:00Z",
        dropped_why: "expired",
      }),
    },
    {
      breaks: "a reminder on a live link",
      rule: "calendar_links_reminded_while_dropped",
      code: "23514",
      write: relink(RILEY_LINK, { drop_reminded_at: "2026-11-08T12:00:00Z" }),
    },
    {
      breaks: "Sam's reconnect keeping synced_at",
      rule: "calendar_links_times_in_order",
      code: "23514",
      write: relink(SAM_LINK, {
        state: "linked",
        linked_at: "2026-11-10T22:00:00Z",
        sync_cursor: null,
        dropped_at: null,
        dropped_why: null,
        drop_reminded_at: null,
      }),
    },
    {
      breaks: "a share naming Sam's link as Riley's",
      rule: "calendar_link_shares_link_fk",
      code: "23503",
      write: share({ calendar_link_id: "callink-sam-microsoft" }),
    },
    {
      breaks: "a share ended before it started",
      rule: "calendar_link_shares_times_in_order",
      code: "23514",
      write: share({ ended_at: "2026-11-02T14:00:00Z" }),
    },
    {
      breaks: "a second live share of Riley at the barbershop",
      rule: "calendar_link_shares_one_per_person",
      code: "23505",
      write: share({ business_id: BARBERSHOP }),
    },
    {
      breaks: "a calendar block with a business",
      rule: "busy_blocks_source_fields",
      code: "23514",
      write: block({ business_id: BARBERSHOP }),
    },
    {
      breaks: "a photo block with a link",
      rule: "busy_blocks_source_fields",
      code: "23514",
      write: insertEach([
        "busy_blocks",
        { ...PHOTO_BLOCK, id: "busy-probe", calendar_link_id: "callink-sam-microsoft" },
      ]),
    },
    {
      breaks: "Riley's block on Sam's link",
      rule: "busy_blocks_link_fk",
      code: "23503",
      write: block({ calendar_link_id: "callink-sam-microsoft" }),
    },
    {
      breaks: "the same event twice",
      rule: "busy_blocks_event_key",
      code: "23505",
      write: block({ provider_event_ref: RILEY_BLOCK.provider_event_ref ?? null }),
    },
    {
      breaks: "a block with no end",
      rule: "busy_blocks_during_bounded",
      code: "23514",
      write: block({ during: "[2026-11-07T19:00:00Z,)" }),
    },
  ];

  const PASSES: { form: string; write: (tx: Tx) => Promise<readonly unknown[]> }[] = [
    {
      form: "the shop's adjacent span to 24:00 on Monday",
      write: hours({ opens_at: "17:00", closes_at: "24:00" }),
    },
    {
      form: "another worker's span at the same time as Avery's",
      write: insertEach(["weekly_hours", { ...AVERY_MONDAY, id: "hours-probe", resource_id: "res-riley" }]),
    },
    {
      form: "a room's own hours and a space's own hours",
      write: insertEach(
        [
          "weekly_hours",
          {
            ...SHOP_MONDAY,
            id: "hours-probe-room",
            business_id: YOGA_STUDIO,
            owner_kind: "resource",
            location_id: "loc-yoga-studio-shop",
            resource_id: "res-studio-room",
            resource_kind: "room",
          },
        ],
        [
          "weekly_hours",
          {
            ...SHOP_MONDAY,
            id: "hours-probe-space",
            business_id: PET_BOARDING,
            owner_kind: "place",
            location_id: null,
            place_or_thing_id: "place-pet-boarding-suite",
          },
        ],
      ),
    },
    {
      form: "a room closed for a day",
      write: off(SAM_BLOCK, {
        business_id: YOGA_STUDIO,
        owner_kind: "resource",
        resource_id: "res-studio-room",
        resource_kind: "room",
        kind: "closed",
      }),
    },
    {
      form: "Sam OKs Avery's ask",
      write: updateOne(
        "time_off",
        { id: "off-avery-fri-nov-13" },
        {
          status: "ok",
          status_at: "2026-11-07T14:00:00Z",
          status_by_person_id: SAM,
        },
      ),
    },
    { form: "a class with no teacher named", write: klass({ teacher_resource_id: null }) },
    {
      form: "a session in the cancelled session's room and time",
      write: session({
        room_resource_id: "res-studio-room",
        during: "[2026-11-07T15:00:00Z,2026-11-07T16:00:00Z)",
      }),
    },
    {
      form: "a count with enough, before the start",
      write: updateOne(
        "class_sessions",
        { resource_id: "res-hot-flow-sat-nov-14" },
        {
          counted_at: "2026-11-13T15:00:00Z",
          too_few: false,
        },
      ),
    },
    {
      form: "a new link with no state given, which starts connecting with no tokens and no linked time",
      write: insertEach([
        "calendar_links",
        Object.fromEntries(
          Object.entries({ ...MAYA_LINK, tokens: null, linked_at: null }).filter(
            ([column]) => column !== "state",
          ),
        ),
      ]),
    },
    {
      form: "Sam's reconnect: linked again with the new tokens, its drop marks cleared and its cursor and synced_at null",
      write: relink(SAM_LINK, {
        state: "linked",
        linked_at: "2026-11-10T22:00:00Z",
        sync_cursor: null,
        synced_at: null,
        dropped_at: null,
        dropped_why: null,
        drop_reminded_at: null,
      }),
    },
    {
      form: "Riley's unlink clearing its tokens and its subscription",
      write: relink(RILEY_LINK, {
        state: "unlinked",
        tokens: null,
        unlinked_at: "2026-11-08T12:00:00Z",
        subscription_id: null,
        subscription_resource_id: null,
        subscribed_at: null,
        subscription_expires_at: null,
      }),
    },
    { form: "a calendar block with no business, written by the runtime side", write: block({}) },
    {
      form: "a moved event rewriting its row",
      write: updateOne(
        "busy_blocks",
        { id: "busy-riley-sat-nov-7" },
        {
          during: "[2026-11-07T20:00:00Z,2026-11-07T21:00:00Z)",
        },
      ),
    },
  ];

  for (const { breaks, rule, code, write } of REFUSED) {
    it(`${breaks}: refused by ${rule} (${code})`, async () => {
      const outcome = await refusal(as(RUNTIME, null, write));
      expect([outcome.code, outcome.constraint]).toEqual([code, rule]);
    });
  }

  for (const { form, write } of PASSES) {
    it(`${form}: passes`, async () => {
      expect((await as(RUNTIME, null, write)).length).toBeGreaterThan(0);
    });
  }

  it("every update raises the version by exactly one, on all seven: an update that leaves it is refused (<table>_version_raised, 23514), and one that raises it passes", async () => {
    const targets: [string, string, string][] = [
      ["busy_blocks", "id", "busy-riley-sat-nov-7"],
      ["calendar_link_shares", "id", "share-riley-barbershop"],
      ["calendar_links", "id", "callink-riley-google"],
      ["class_sessions", "resource_id", "res-hot-flow-sat-nov-14"],
      ["classes", "id", "class-yoga-hot-flow-sat"],
      ["time_off", "id", "off-avery-fri-nov-13"],
      ["weekly_hours", "id", "hours-avery-mon"],
    ];
    expect(targets.map(([table]) => table)).toEqual(OWN_TABLES);
    for (const [table, column, id] of targets) {
      const kept = await refusal(
        as(RUNTIME, null, (tx) => tx`update ${tx(table)} set version = version where ${tx(column)} = ${id}`),
      );
      expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
      const raised = await as(RUNTIME, null, async (tx) => {
        const [row] = await tx<
          { version: number }[]
        >`select version from ${tx(table)} where ${tx(column)} = ${id}`;
        const after = await tx<{ version: number }[]>`
          update ${tx(table)} set version = version + 1 where ${tx(column)} = ${id} returning version
        `;
        return [row?.version, after.map((one) => one.version)];
      });
      const [before, after] = raised as [number, number[]];
      expect(after, table).toEqual([before + 1]);
    }
  });
});

describe("the sealed tokens (README rule 6; T-182's sealing): the connect's return seals them under the person's key, only the runtime side opens them, and erasing the key leaves them unreadable", () => {
  const wrappingKey = randomBytes(32);
  const keys: WrappingKeys = { resolve: () => new Uint8Array(wrappingKey) };
  /** A stand-in for the provider's tokens: never a real token. */
  const STAND_IN = "stand-in refresh and access tokens for Avery's Google calendar, not real";

  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  /** The SealingError code a sealed value is refused with. */
  async function sealingCode(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof SealingError) {
        return error.code;
      }
      throw error;
    }
    throw new Error("the sealed value opened; it should not have");
  }

  it("Avery's connect's return on the runtime side: the tokens sealed under his own new key move his link to linked; the row holds only the sealed bytes, which open for him and not as another person's, and not at all once his key is erased", async () => {
    const outcome = await as(RUNTIME, null, async (tx) => {
      const sealed = await seal(tx, keys, AVERY, STAND_IN);
      const [row] = await tx<{ tokens: Uint8Array; state: string; version: number }[]>`
        update calendar_links
        set tokens = ${sealed}, state = 'linked', linked_at = '2026-11-07T16:01:00Z', version = version + 1
        where id = 'callink-avery-google'
        returning tokens, state, version
      `;
      const stored = new Uint8Array(row?.tokens ?? new Uint8Array());
      // Each byte as one character, so a search for the stand-in's bytes matches only at a byte boundary.
      const asChars = (bytes: Uint8Array): string =>
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
      const plainInRow = asChars(stored).includes(asChars(new TextEncoder().encode(STAND_IN)));
      const opened = await unsealText(tx, keys, AVERY, stored);
      // Maya gets a key of her own; Avery's sealed tokens do not open as hers.
      await seal(tx, keys, MAYA, "a stand-in value of Maya's");
      const asMaya = await sealingCode(unsealText(tx, keys, MAYA, stored));
      const erased = await erasePerson(tx, AVERY);
      const afterErase = await sealingCode(unsealText(tx, keys, AVERY, stored));
      return {
        state: row?.state,
        version: row?.version,
        plainInRow,
        opened,
        asMaya,
        erased: erased.ok,
        afterErase,
      };
    });
    expect(outcome).toEqual({
      state: "linked",
      version: 2,
      plainInRow: false,
      opened: STAND_IN,
      asMaya: "cannot_open",
      erased: true,
      afterErase: "erased",
    });
  });

  it("the Tool API reaches neither the tokens nor the keys that seal them: under the barbershop's scope, which reads Riley's link through its share, both are refused (42501)", async () => {
    for (const statement of [
      "select tokens from calendar_links where id = 'callink-riley-google'",
      "select wrapped_key from sealing_keys where person_id = 'person-riley'",
    ]) {
      const refused = await refusal(as(TOOL_API, tool(BARBERSHOP, RILEY), (tx) => tx.unsafe(statement)));
      expect(refused.code, statement).toBe("42501");
    }
  });
});

describe("invalid/refuse-busy-block-title.json: a busy block written with its event's title has no column for it", () => {
  const file = "invalid/refuse-busy-block-title.json";
  const refused = refusedOf(file);
  const write = (values: Values) => (tx: Tx) => insertReturning(tx, refused.table, values);

  beforeAll(async () => {
    await reset();
    await loadFixtures([file]);
  }, 60_000);

  it("the fixture: the runtime side with no scope inserts Riley's block with a title; refused as the fixture expects (42703: no such column)", async () => {
    expect([refused.role, refused.action, refused.table, refused.scope]).toEqual([
      "runtime",
      "insert",
      "busy_blocks",
      null,
    ]);
    const outcome = await refusal(as(roleOf(refused), null, write(refused.values ?? {})));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain('column "title" of relation "busy_blocks" does not exist');
  });

  it("without its one fault (the same row without the title) the same insert passes", async () => {
    const values = Object.fromEntries(
      Object.entries(refused.values ?? {}).filter(([column]) => column !== "title"),
    );
    const done = await as(roleOf(refused), null, write(values));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: "busy-riley-sat-nov-7-titled",
      business_id: null,
      source: "calendar",
    });
  });
});

describe("invalid/refuse-busy-block-other-business-read.json: a business that reads no link of Riley's reads none of his blocks", () => {
  const file = "invalid/refuse-busy-block-other-business-read.json";
  const refused = refusedOf(file);
  const read = (tx: Tx): Promise<readonly unknown[]> =>
    tx`select * from ${tx(refused.table)} where ${whereOf(tx, refused.where ?? {})}`;

  beforeAll(async () => {
    await reset();
    await loadFixtures([file]);
  }, 60_000);

  it("scoped to the yoga studio, the Tool API's read of Riley's calendar block returns no row, as the fixture expects, though it is there", async () => {
    expect([refused.role, refused.action, refused.scope?.businessId]).toEqual([
      "toolApi",
      "select",
      YOGA_STUDIO,
    ]);
    expect(await asOwner(read)).toHaveLength(1);
    expect(await as(roleOf(refused), refused.scope, read)).toHaveLength(refused.expect.rows ?? -1);
  });

  it("without its one fault (the scope of Lee's Barbershop, which reads Riley's link through its share) the same read returns it", async () => {
    expect(await as(TOOL_API, tool(BARBERSHOP), read)).toHaveLength(1);
  });
});

describe("invalid/refuse-calendar-tokens-read.json: no Tool API grant reaches the sealed tokens", () => {
  const file = "invalid/refuse-calendar-tokens-read.json";
  const refused = refusedOf(file);
  const read = (columns: readonly string[]) => (tx: Tx) =>
    tx<
      Record<string, unknown>[]
    >`select ${tx(columns as string[])} from ${tx(refused.table)} where ${whereOf(tx, refused.where ?? {})}`;

  beforeAll(async () => {
    await reset();
    await loadFixtures([file]);
  }, 60_000);

  it("scoped to Lee's Barbershop, which reads Riley's link, the Tool API's read naming the tokens is refused, as the fixture expects (42501)", async () => {
    expect([refused.role, refused.action, refused.scope?.businessId]).toEqual([
      "toolApi",
      "select",
      BARBERSHOP,
    ]);
    expect(refused.columns).toContain("tokens");
    const outcome = await refusal(as(roleOf(refused), refused.scope, read(refused.columns ?? [])));
    expect([outcome.code, outcome.message]).toEqual([
      refused.expect.sqlstate,
      "permission denied for table calendar_links",
    ]);
  });

  it("without its one fault (the same read of its id, provider and state) it passes", async () => {
    const columns = (refused.columns ?? []).filter((column) => column !== "tokens");
    expect(await as(TOOL_API, refused.scope, read(columns))).toEqual([
      { id: "callink-riley-google", provider: "google", state: "linked" },
    ]);
  });
});

/** Each refused write with its one fault removed: K-27's README names the write that passes once it is fixed. */
const REFUSED_WRITES: {
  file: string;
  scope: (refused: Refused) => Scope | null;
  fixed: Values;
  without: string;
}[] = [
  {
    file: "invalid/refuse-photo-block-without-yes.json",
    scope: (refused) => refused.scope,
    fixed: { confirmed_at: "2026-11-07T15:10:00Z", confirmed_by_person_id: SAM },
    without: "the same photo block with Sam's yes and its time",
  },
  {
    file: "invalid/refuse-two-sessions-one-room.json",
    scope: (refused) => refused.scope,
    fixed: { during: "[2026-11-14T18:00:00Z,2026-11-14T19:00:00Z)" },
    without: "the same session at 1:00pm",
  },
  {
    file: "invalid/refuse-icloud-link.json",
    scope: (refused) => refused.scope,
    fixed: { provider: "google" },
    without: "the same link as Google",
  },
  {
    file: "invalid/refuse-connecting-with-tokens.json",
    scope: (refused) => refused.scope,
    fixed: { state: "linked", linked_at: "2026-11-07T16:01:00Z" },
    without: "the same write that also moves the link to linked with its time",
  },
  {
    file: "invalid/refuse-share-for-another-person.json",
    scope: (refused) => ({ ...refused.scope, personId: RILEY }),
    fixed: {},
    without: "the same share in Riley's own call",
  },
];

for (const { file, scope, fixed, without } of REFUSED_WRITES) {
  describe(`${file}: refused for its one reason`, () => {
    const refused = refusedOf(file);
    const attempt =
      (change: Values) =>
      async (tx: Tx): Promise<number> => {
        if (refused.action === "insert") {
          const result = await tx`
            insert into ${tx(refused.table)} ${tx(columnValues(tx, refused.table, { ...(refused.values ?? {}), ...change }))}
          `;
          return result.count;
        }
        const result = await tx`
          update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, { ...(refused.set ?? {}), ...change }))}
          where ${whereOf(tx, refused.where ?? {})}
        `;
        return result.count;
      };

    beforeAll(async () => {
      await reset();
      // The fixture's after chain and its own rows, as the runtime side.
      await loadFixtures([file]);
    }, 60_000);

    it(`the fixture: ${refused.role} ${refused.scope === null ? "with no scope" : `scoped to ${JSON.stringify(refused.scope)}`} ${refused.action}s ${refused.table}; refused as it expects (${refused.expect.sqlstate ?? "?"}${refused.expect.constraintOneOf === undefined ? "" : `, ${refused.expect.constraintOneOf.join(" or ")}`})`, async () => {
      expect(["insert", "update"]).toContain(refused.action);
      const outcome = await refusal(as(roleOf(refused), refused.scope, attempt({})));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      if (refused.expect.constraintOneOf === undefined) {
        expect(outcome.message).toContain("row-level security");
      } else {
        expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      }
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      expect(await as(roleOf(refused), scope(refused), attempt(fixed))).toBe(1);
    });
  });
}
