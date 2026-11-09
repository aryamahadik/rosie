// T-721: the bookings and changes part (K-30 v1), part 2: booking_changes, quotes, quote_options, owner_oks,
// booking_addresses, secure_links, page_answers and waitlist_entries, and booking_lines' two keys to them, with README
// rules 1 to 9 as they bear on those eight, against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/bookings-changes-2`). The schema comes from migrating a fresh test schema, so
// both K-30 migrations run in order: 0028 (part 1, T-720) and 0029 (this part).
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: C-099's calls, the secure page's and the console's page calls)
// or the runtime side (rosie_job: K-05's commit, the page server's link lookup, the dispatcher, clock firings, the
// 45-day copy or delete) runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is
// scoped, and is rolled back. Seed fixtures are loaded the same way, as the runtime side with no scope (K-04's fixture
// format), and committed; the card's four seeds and seed-quote-owner-ok.json load whole, part 2's rows with the rest.
//
// The rows come only from fixtures (rule 9): K-30 v1's five seeds and its refused rows, and the K-04, K-22, K-23, K-25,
// K-26, K-28 and K-29 seeds their after chains name (Lee's Barbershop, Lee Home Services, the yoga studio and the
// master's sample cast: Sam, Alex M., Riley, Avery, Jordan, Dee; B3-08's Tessa). A row made here is a fixture row under
// a new id, or with one fault; the waitlist's fifty customers are labelled stand-ins with example.com handles, never
// people. The fixtures' sealed values are stand-in bytes; the sealing check seals stand-in strings under a wrapping key
// of random bytes made here and never written to a file.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SealingError, type WrappingKeys, erasePerson, seal, unsealText } from "./sealing";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/bookings-changes/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** Part 2's eight tables (the card's), in code-unit order (as PostgreSQL orders a relation's name). */
const OWN_TABLES = [
  "booking_addresses",
  "booking_changes",
  "owner_oks",
  "page_answers",
  "quote_options",
  "quotes",
  "secure_links",
  "waitlist_entries",
];
/** Part 1's five (migration 0028, T-720). */
const PART_1_TABLES = [
  "booking_details",
  "booking_lines",
  "booking_terms",
  "booking_terms_rules",
  "booking_visits",
];
/** All thirteen of K-30's tables, in code-unit order. */
const K30_TABLES = [...PART_1_TABLES, ...OWN_TABLES].sort();
/** The six of the eight that are versioned (README rule 4). */
const VERSIONED = [
  "booking_addresses",
  "owner_oks",
  "quote_options",
  "quotes",
  "secure_links",
  "waitlist_entries",
];
/** The two only ever inserted (rule 4; rule 6: no update grant). */
const INSERT_ONLY = ["booking_changes", "page_answers"];
/** The seven with booking_id, whose Tool API insert and update policies carry rule 5's clause. */
const WITH_BOOKING = OWN_TABLES.filter((table) => table !== "quote_options");
/** The four that take UPDATE as a table grant (rule 6). */
const TABLE_UPDATES = ["booking_addresses", "owner_oks", "quote_options", "quotes"];
/** The columns rule 6 lets either role update, by table; any other column of these two is written once. */
const COLUMN_UPDATES: Record<string, readonly string[]> = {
  secure_links: ["ended_at", "ended_why", "version"],
  waitlist_entries: ["ended_at", "ended_why", "version"],
};
/** booking_lines' two keys to part 2's tables, which 0029 adds once those tables exist (rule 1; DL-278). */
const PART_2_KEYS = ["booking_lines_quote_option_fk", "booking_lines_removed_by_fk"];
/** The card's four seeds, loaded whole. */
const CARD_SEEDS = [
  "seed-booking-flow-a.json",
  "seed-booking-flow-b.json",
  "seed-booking-line-price-copied.json",
  "seed-terms-snapshot.json",
];
/** The fifth seed, a quote with the owner's OK. */
const QUOTE_SEED = "seed-quote-owner-ok.json";
const ALL_SEEDS = [...CARD_SEEDS, QUOTE_SEED];
/** The refused fixtures on part 2's tables. */
const REFUSED_HERE = [
  "invalid/refuse-change-row-update.json",
  "invalid/refuse-link-code-read.json",
  "invalid/refuse-owner-ok-without-who.json",
];
/** The refused fixtures on part 1's tables (T-720's file runs them). */
const REFUSED_PART_1 = [
  "invalid/refuse-booking-line-price-change.json",
  "invalid/refuse-booking-value-reset.json",
  "invalid/refuse-cross-business-booking-read.json",
  "invalid/refuse-line-on-other-business-booking.json",
  "invalid/refuse-terms-snapshot-update.json",
];
/** The other tables the eight refer to by their keys (README rule 1), in code-unit order. */
const REFERRED = [
  "booking_visits",
  "bookings",
  "businesses",
  "consents",
  "locations",
  "open_questions",
  "person_handles",
  "persons",
  "price_ok_limits",
  "resources",
  "services",
  "turns",
];
/** The two sealed columns of the eight (README rule 7), each with the column naming whose key seals it. */
const SEALED: Record<string, string> = {
  "booking_addresses.address": "sealed_for_person_id",
  "page_answers.answer": "person_id",
};
/** Tessa's B3-08 booking at Lee Home Services (K-28's seed), whose person has no sealing key in any seed. */
const TESSA_SEED = "../../customers/fixtures/seed-customer-business-added.json";
/** Lee Home Services' office and travel area (K-23's seed), which an address is checked against. */
const LOCATION_SEED = "../../business-setup/fixtures/seed-location-flow-b.json";
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const HOME_SERVICES = "biz-lee-home-services";
const SAM = "person-sam";
const ALEX = "person-alex";
const DEE = "person-dee";
const TESSA = "person-tessa";
/** K-26's closed registries, written only by migration 0023's own seed (K-26 README rule 5). */
const REGISTRIES = ["plugin_switches", "rule_kinds", "trade_facts"];
const SLOW = { timeout: 120_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface ContractTable {
  name: string;
  columns: {
    name: string;
    type: string;
    null: boolean;
    default?: string;
    audience: string | string[];
    sealedBy?: string;
  }[];
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
  effectiveDates: boolean;
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

const TABLES = (readJson(new URL("bookings-changes.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
/** Part 2's tables as the table list gives them, in its order. */
const OWN = TABLES.filter((table) => OWN_TABLES.includes(table.name));
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-30 v1 lists no table ${name}`);
  }
  return table;
}

/** A table's column names, in the table list's order. */
const columnsOf = (name: string): string[] => tableOf(name).columns.map((column) => column.name);

/** Every column of secure_links but the code's hash: the Tool API's SELECT (rule 6; refuse-link-code-read). */
const LINK_SELECTS = columnsOf("secure_links").filter((column) => column !== "code_sha256");

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's own row of `table` whose `column` is `value` (id by default). */
function valuesOf(file: string, table: string, value: string, column = "id"): Values {
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values[column] === value,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row with ${column} ${value}`);
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
 * file that names it, so K-30's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** The rows a load of `files` reads, each file once with every `after` chain, in load order. */
function rowsOf(files: readonly string[]): FixtureRow[] {
  const seen = new Set<string>();
  return files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen));
}

/** Rows per table, of the tables in `tables` only. */
function countsOf(rows: readonly FixtureRow[], tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows.filter((candidate) => tables.includes(candidate.table))) {
    counts[row.table] = (counts[row.table] ?? 0) + 1;
  }
  return counts;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Bytes as lower-case hex, two digits each. */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (words: string): string => createHash("sha256").update(words, "utf8").digest("hex");

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Collapses each run of white space to one space, as PostgreSQL's printed expressions break lines. */
const oneLine = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** 1 to n. */
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/** The rows of the five seeds and their chains, in load order, and those of K-30's thirteen tables. */
const ALL_ROWS = rowsOf(ALL_SEEDS);
const K30_ROWS = ALL_ROWS.filter((row) => K30_TABLES.includes(row.table));

/** Alex M.'s haircut at Lee's Barbershop (flow A): Sam's OK of the request. */
const ALEX_HAIRCUT = "booking-alex-haircut";
const ALEX_HAIRCUT_OK = valuesOf("seed-booking-flow-a.json", "owner_oks", "ok-alex-haircut-request");
/** Alex M.'s kitchen drain at home with Lee Home Services (flow B): its address, link and two answers. */
const ALEX_DRAIN = "booking-alex-drain";
const ALEX_DRAIN_ADDRESS = valuesOf("seed-booking-flow-b.json", "booking_addresses", "addr-alex-drain-1");
const ALEX_DRAIN_LINK = valuesOf("seed-booking-flow-b.json", "secure_links", "link-alex-drain-page");
const ALEX_DRAIN_ACCESS = valuesOf("seed-booking-flow-b.json", "page_answers", "ans-alex-drain-access");
const ALEX_DRAIN_LINE = valuesOf("seed-booking-flow-b.json", "booking_lines", "line-alex-drain-1");
/** Alex M.'s water heater from photos (the quote seed): the request, the quote, its option and Sam's OK. */
const WATER_HEATER = "booking-alex-water-heater";
const WATER_HEATER_QUOTE = valuesOf(QUOTE_SEED, "quotes", "quote-alex-water-heater");
const WATER_HEATER_OPTION = valuesOf(QUOTE_SEED, "quote_options", "qopt-alex-water-heater-1");
const WATER_HEATER_OK = valuesOf(QUOTE_SEED, "owner_oks", "ok-alex-water-heater-quote");
const WATER_HEATER_PHOTO = valuesOf(QUOTE_SEED, "page_answers", "ans-alex-water-heater-photo-1");
/** Dee's haircut, moved before free cancel ended: its change row. */
const DEE_HAIRCUT = "booking-dee-haircut";
const DEE_MOVE = valuesOf(
  "seed-booking-line-price-copied.json",
  "booking_changes",
  "change-dee-haircut-moved",
);
/** Dee's waitlist request at the barbershop, her own yes to texts about it, and her entry, ended booked. */
const DEE_PERSON = valuesOf("seed-terms-snapshot.json", "persons", DEE);
const DEE_WAITLIST_HEAD = valuesOf("seed-terms-snapshot.json", "bookings", "booking-dee-waitlist");
const DEE_WAITLIST_YES = valuesOf("seed-terms-snapshot.json", "consents", "consent-dee-waitlist-texts");
const DEE_ENTRY = valuesOf("seed-terms-snapshot.json", "waitlist_entries", "wait-dee-saturday-morning");
const SKIN_FADE = textOf(DEE_ENTRY.service_id);
const WANTED = textOf(DEE_ENTRY.wanted);

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;
/** The type of each column of the schema's tables, keyed table.column, as format_type prints it. */
const typeOf = new Map<string, string>();
/** PostgreSQL's keywords that it quotes as a column name (all but the unreserved ones), such as position. */
const QUOTED = new Set<string>();
/** A column name as pg_get_constraintdef prints it. */
const ident = (name: string): string => (QUOTED.has(name) ? `"${name}"` : name);

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

/** Updates the rows of `table` that `where` names, setting `set` exactly. */
function updateWhere(table: string, where: Values, set: Values): (tx: Tx) => Promise<unknown> {
  return (tx) => tx`update ${tx(table)} set ${tx(columnValues(tx, table, set))} where ${whereOf(tx, where)}`;
}

/** The primary key of a row of one of K-30's tables, from its values. */
function keyOf(row: FixtureRow): Values {
  return Object.fromEntries(
    tableOf(row.table).primaryKey.map((column) => [column, row.values[column] ?? null]),
  );
}

/**
 * Empties every table the fixtures write: truncating the heads, and K-24's kinds (which fixtures write and no head
 * names), cascades to the rest (this file's schema only). K-26's registries, the migration's own seed, stay.
 */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds cascade`;
}

/** The one row of `table` whose every column the fixture gives holds the given value, compared in the column's type. */
async function expectFound(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const typeIn = (column: string): string => typeOf.get(`${row.table}.${column}`) ?? "";
  const matched = columns.map(
    (column, i) => `("${column}")::text is not distinct from ($${String(i + 1)}::${typeIn(column)})::text`,
  );
  const given = columnValues(db.sql, row.table, row.values);
  const [found] = await db.sql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from "${row.table}" where ${matched.join(" and ")}`,
    columns.map((column) => given[column] as never),
  );
  expect(found?.n, `${row.table} ${JSON.stringify(row.values)}`).toBe(1);
}

/**
 * Loads fixture files with their `after` chains, each file once, as the runtime side, and commits: every row, part 2's
 * tables' included. A row of K-26's registries is never inserted (only a migration's seed writes a registry, K-26
 * README rule 5): it is found as the migration wrote it. Gives the rows inserted, per table.
 */
async function loadFixtures(files: readonly string[]): Promise<Record<string, number>> {
  const rows = rowsOf(files);
  for (const row of rows.filter((candidate) => REGISTRIES.includes(candidate.table))) {
    await expectFound(row);
  }
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows.filter((candidate) => !REGISTRIES.includes(candidate.table))) {
      await insertRow(tx, row.table, row.values);
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

/**
 * Every column the fixture gives is stored as given, read back as the owner by the table's primary key and compared on
 * the server in the column's own type (an instant or a range as PostgreSQL reads both; JSON, bytes and text exactly).
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

/** Rows each of `tables` shows the caller, by table. */
async function rowsIn(sql: Sql | Tx, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows each of the eight shows the caller, by table. */
const visibleRows = (sql: Sql | Tx): Promise<Record<string, number>> => rowsIn(sql, OWN_TABLES);

/** Rows of each of the eight whose business_id is `businessId`, read as the owner. */
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

/** The privileges rule 6 gives `role` on the whole of `table` (column grants apart). */
function tablePrivileges(role: Role, table: string): string[] {
  if (table === "secure_links") {
    // The Tool API's SELECT is a column grant of every column but code_sha256; the runtime side reads the whole row.
    return role === TOOL_API ? ["INSERT"] : ["INSERT", "SELECT"];
  }
  return TABLE_UPDATES.includes(table) ? ["INSERT", "SELECT", "UPDATE"] : ["INSERT", "SELECT"];
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "bookings_changes_2" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
  const keywords = await db.sql<{ word: string }[]>`select word from pg_get_keywords() where catcode <> 'U'`;
  for (const keyword of keywords) {
    QUOTED.add(keyword.word);
  }
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-30 v1): part 2's eight tables", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = { timestamptz: "timestamp with time zone" };

  it("the table list names 13 tables, each scoped by business on business_id with no effective dates: part 1's five (0028) and part 2's eight (0029) are all in the schema now; rule 4's six of the eight are versioned, and booking_changes and page_answers carry no version", async () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(K30_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.effectiveDates],
        table.name,
      ).toEqual(["business", "business_id", false]);
    }
    expect(
      OWN.filter((table) => table.versioned)
        .map((table) => [table.name, table.versionColumn])
        .sort(),
    ).toEqual(VERSIONED.map((name) => [name, "version"]));
    expect(
      OWN.filter((table) => !table.versioned)
        .map((table) => table.name)
        .sort(),
    ).toEqual(INSERT_ONLY);
    const found = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and c.relname in ${db.sql(K30_TABLES)}
    `;
    expect(found.map((row) => row.name).sort()).toEqual(K30_TABLES);
  });

  it("both K-30 migrations are recorded in schema_migrations, in order: bookings_changes_details (0028), then bookings_changes_quotes_links (0029), after core_rls, consent, business_setup, people_access, services_prices, rules and customers", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    const part1 = names.indexOf("bookings_changes_details");
    const part2 = names.indexOf("bookings_changes_quotes_links");
    expect(part1).toBeGreaterThan(-1);
    expect(part2).toBe(part1 + 1);
    for (const before of [
      "core_rls",
      "consent",
      "business_setup",
      "people_access",
      "services_prices",
      "rules",
      "customers",
    ]) {
      expect(names.indexOf(before), before).toBeGreaterThan(-1);
      expect(part1, before).toBeGreaterThan(names.indexOf(before));
    }
  });

  for (const table of OWN) {
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete, unique rules (one with a where as a partial unique index) and index names are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(constraints.filter((constraint) => constraint.kind === "p")).toEqual([
        {
          name: `${table.name}_pkey`,
          kind: "p",
          definition: `PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`,
        },
      ]);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      const unique = table.unique ?? [];
      const plain = unique.filter((rule) => rule.where === undefined);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(table.foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual(plain.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of table.foreignKeys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.map(ident).join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.map(ident).join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        );
      }
      // PostgreSQL quotes a keyword it prints as a column name (position, in two unique rules).
      for (const rule of plain) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.map(ident).join(", ")})`,
        );
      }
      const indexes = await db.sql<{ name: string; unique: boolean }[]>`
        select c.relname as name, i.indisunique as unique from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...unique.map((rule) => rule.name),
          ...(table.indexes ?? []).map((index) => index.name),
        ].sort(),
      );
      expect(
        indexes
          .filter((index) => index.unique)
          .map((index) => index.name)
          .sort(),
      ).toEqual([`${table.name}_pkey`, ...unique.map((rule) => rule.name)].sort());
    });

    it(`${table.name}: each check, partial unique rule and index is the table list's own expression, as PostgreSQL reads them`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const checks = table.checks ?? [];
      const partial = (table.unique ?? []).filter((rule) => rule.where !== undefined);
      const listed = await asOwner(async (tx) => {
        await tx`create temporary table probe (like ${tx(table.name)}) on commit drop`;
        for (const check of checks) {
          await tx.unsafe(`alter table probe add constraint ${check.name} check (${check.expression})`);
        }
        for (const rule of partial) {
          await tx.unsafe(
            `create unique index ${rule.name} on probe (${rule.columns.join(", ")}) where ${rule.where ?? ""}`,
          );
        }
        for (const index of table.indexes ?? []) {
          const using = index.using === undefined ? "" : ` using ${index.using}`;
          const where = index.where === undefined ? "" : ` where ${index.where}`;
          await tx.unsafe(
            `create index ${index.name} on probe${using} (${index.columns.join(", ")})${where}`,
          );
        }
        return definitionsOf(tx, "probe");
      });
      expect(Object.keys(listed.checks).sort()).toEqual(checks.map((check) => check.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(
        [...partial.map((rule) => rule.name), ...(table.indexes ?? []).map((index) => index.name)].sort(),
      );
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      // A plain unique rule's own index is checked above by name and columns; the partial ones and the named here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("booking_lines holds all seven of its keys now: 0029 adds booking_lines_quote_option_fk and booking_lines_removed_by_fk once quote_options and booking_changes exist (rule 1; DL-278), each as the table list writes it, checked against every row (not NOT VALID)", async () => {
    const keys = await db.sql<{ name: string; definition: string; validated: boolean }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition, convalidated as validated
      from pg_constraint where conrelid = ${`${db.schema}.booking_lines`}::regclass and contype = 'f'
    `;
    const lines = tableOf("booking_lines");
    expect(keys.map((key) => key.name).sort()).toEqual(lines.foreignKeys.map((key) => key.name).sort());
    expect(lines.foreignKeys.map((key) => key.name).filter((name) => PART_2_KEYS.includes(name))).toEqual(
      PART_2_KEYS,
    );
    for (const key of lines.foreignKeys) {
      expect(keys.find((found) => found.name === key.name)?.definition, key.name).toBe(
        `FOREIGN KEY (${key.columns.map(ident).join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.map(ident).join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
      );
    }
    expect(keys.filter((key) => !key.validated).map((key) => key.name)).toEqual([]);
    expect(
      keys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map((key) => key.definition)
        .sort(),
    ).toEqual([
      "FOREIGN KEY (quote_option_id, business_id) REFERENCES quote_options(id, business_id) ON DELETE RESTRICT",
      "FOREIGN KEY (removed_by_change_id, booking_id) REFERENCES booking_changes(id, booking_id) ON DELETE RESTRICT",
    ]);
  });

  it("the eight refer to other tables only by their keys (rule 1): K-04's bookings, businesses, persons, turns, open_questions, person_handles and resources, part 1's booking_visits, K-23's locations, K-25's services, K-26's price_ok_limits and K-29's consents; among themselves only an option and an owner's ask name their quote; of every other table only booking_lines refers to them, by its two keys", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      OWN.flatMap((table) =>
        table.foreignKeys.map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
    expect(
      keys
        .filter((key) => OWN_TABLES.includes(key.referenced))
        .map((key) => key.name)
        .sort(),
    ).toEqual(["owner_oks_quote_fk", "quote_options_quote_fk"]);
    const into = await db.sql<{ table: string; name: string }[]>`
      select src.relname as table, k.conname as name from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
    `;
    expect(into.map((key) => `${key.table} ${key.name}`).sort()).toEqual(
      PART_2_KEYS.map((name) => `booking_lines ${name}`),
    );
  });

  it("each versioned table raises its version on every update (0002's rule; rule 4): <table>_version_raised, BEFORE UPDATE FOR EACH ROW; booking_changes and page_answers, only inserted, hold no trigger; part 2 makes no function", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
    `;
    expect(triggers.map((trigger) => `${trigger.table} ${trigger.name}`).sort()).toEqual(
      VERSIONED.map((table) => `${table} ${table}_version_raised`),
    );
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
    const functions = await db.sql<{ name: string }[]>`
      select p.proname as name from pg_proc p where p.pronamespace = ${db.schema}::regnamespace
    `;
    expect(
      functions.filter((fn) =>
        [...OWN_TABLES, "booking_lines", "waitlist", "quote", "link", "owner_ok"].some((prefix) =>
          fn.name.startsWith(prefix),
        ),
      ),
    ).toEqual([]);
  });

  it("ids are text, every instant is timestamptz, the times waited for a bounded tstzrange and every amount bigint minor units in a three-letter currency; a change's values, versions and yes are jsonb, its lateness a boolean (rules 3 and 9)", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(OWN.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own
        .filter(([key]) => key.endsWith(".id") || key.endsWith("_id"))
        .filter(([, type]) => type !== "text")
        .map(([key]) => key),
    ).toEqual([]);
    const instants = own.filter(([key]) => /(_at|_until|\.at|\.answer_by)$/.test(key));
    expect(instants.filter(([, type]) => type !== "timestamp with time zone").map(([key]) => key)).toEqual(
      [],
    );
    expect(instants.map(([key]) => key).sort()).toEqual([
      "booking_addresses.checked_at",
      "booking_changes.at",
      "owner_oks.answer_by",
      "owner_oks.answered_at",
      "owner_oks.asked_at",
      "owner_oks.reminded_at",
      "page_answers.answered_at",
      "quotes.good_until",
      "quotes.priced_at",
      "quotes.sent_at",
      "secure_links.ended_at",
      "secure_links.issued_at",
      "waitlist_entries.ended_at",
      "waitlist_entries.joined_at",
    ]);
    expect(own.filter(([, type]) => type === "timestamp without time zone")).toEqual([]);
    expect(
      own
        .filter(([, type]) => ["tstzrange", "jsonb", "boolean", "bigint", "bytea"].includes(type))
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual([
      "booking_addresses.address bytea",
      "booking_changes.after_free_cancel boolean",
      "booking_changes.approved_by jsonb",
      "booking_changes.new_values jsonb",
      "booking_changes.old_values jsonb",
      "booking_changes.rows_changed jsonb",
      "page_answers.answer bytea",
      "quote_options.price_cents bigint",
      "quote_options.up_to_cents bigint",
      "waitlist_entries.wanted tstzrange",
    ]);
    expect(typeOf.get("quotes.currency")).toBe("text");
  });

  it("the sealed columns are the two the table list names (rule 7): booking_addresses.address under sealed_for_person_id and page_answers.answer under person_id, both secure-page-only and the only bytea of the eight, with no index on either; a link keeps only its code's sha256, as text", async () => {
    expect(
      OWN.flatMap((table) =>
        table.columns
          .filter((column) => column.sealedBy !== undefined)
          .map((column) => [`${table.name}.${column.name}`, column.sealedBy]),
      ),
    ).toEqual(Object.entries(SEALED));
    expect(
      OWN.flatMap((table) =>
        table.columns
          .filter((column) => column.audience === "secure-page-only")
          .map((column) => `${table.name}.${column.name}`),
      ),
    ).toEqual(Object.keys(SEALED));
    expect(
      [...typeOf.entries()]
        .filter(([key, type]) => OWN_TABLES.includes(key.split(".")[0] ?? "") && type === "bytea")
        .map(([key]) => key)
        .sort(),
    ).toEqual(Object.keys(SEALED).sort());
    const indexed = await db.sql<{ name: string; columns: string[] }[]>`
      select c.relname as name,
             array(select a.attname::text from unnest(i.indkey) as k(n)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) as columns
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid in (${`${db.schema}.booking_addresses`}::regclass, ${`${db.schema}.page_answers`}::regclass)
    `;
    expect(
      indexed.filter((index) => index.columns.includes("address") || index.columns.includes("answer")),
    ).toEqual([]);
    expect(columnsOf("secure_links").filter((column) => column.includes("code"))).toEqual(["code_sha256"]);
    expect(typeOf.get("secure_links.code_sha256")).toBe("text");
  });

  it("neither role owns any of the eight: they stay the migrations' role's", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(owners.map((row) => row.name).sort()).toEqual(OWN_TABLES);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });

  it("the upset count and staff_told are where K-30 puts them: booking_details.upset_count (integer, default 0, never below 0; arch 09 line 490) and booking_details.staff_told_at (a delivered time, Q-33), both 0028's; no table of part 2 holds either", async () => {
    const details = tableOf("booking_details");
    expect(
      details.columns
        .filter((column) => ["upset_count", "staff_told_at"].includes(column.name))
        .map((column) => [column.name, column.type, column.null, column.default ?? null]),
    ).toEqual([
      ["staff_told_at", "timestamptz", true, null],
      ["upset_count", "integer", false, "0"],
    ]);
    expect(typeOf.get("booking_details.upset_count")).toBe("integer");
    expect(typeOf.get("booking_details.staff_told_at")).toBe("timestamp with time zone");
    const [check] = await db.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${`${db.schema}.booking_details`}::regclass and conname = 'booking_details_upset_count'
    `;
    expect(check?.definition).toBe("CHECK ((upset_count >= 0))");
    expect(
      [...typeOf.keys()].filter(
        (key) => OWN_TABLES.includes(key.split(".")[0] ?? "") && /upset|staff_told/.test(key),
      ),
    ).toEqual([]);
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern with README rule 5's clause; rule 6)", () => {
  interface Policy {
    table: string;
    name: string;
    permissive: string;
    roles: string[];
    command: string;
    using: string | null;
    check: string | null;
  }

  const policiesOf = (tables: readonly string[]): Promise<Policy[]> =>
    db.sql<Policy[]>`
      select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
             qual as using, with_check as check
      from pg_policies where schemaname = ${db.schema} and tablename in ${db.sql([...tables])}
      order by tablename, policyname
    `;

  it("row-level security is on for all eight, and forced on none", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
    `;
    expect([...flags].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual(
      OWN_TABLES.map((name) => ({ name, on: true, forced: false })),
    );
  });

  it("each holds 0012's <table>_runtime for rosie_job word for word (read from outbox_rows', which keys on the same column); the seven with booking_id hold one Tool API policy per command their grants allow: _select reads only its scope, _insert, and _update where an update is granted, add rule 5's exists clause on the new row; quote_options, with no booking_id, keeps T-191's quote_options_tool_api on its scope; none for delete", async () => {
    const policies = await policiesOf([...OWN_TABLES, "outbox_rows"]);
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    const coreRuntime = core.find((policy) => policy.name === "outbox_rows_runtime");
    const coreToolApi = core.find((policy) => policy.name === "outbox_rows_tool_api");
    expect(coreToolApi?.using).toBe(coreToolApi?.check);
    const scope = coreToolApi?.using ?? "";
    expect(scope).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
    for (const table of WITH_BOOKING) {
      const updated = TABLE_UPDATES.includes(table) || table in COLUMN_UPDATES;
      const own = policies.filter((policy) => policy.table === table);
      expect(
        own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command]),
        table,
      ).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table}_tool_api_insert`, "PERMISSIVE", [TOOL_API], "INSERT"],
        [`${table}_tool_api_select`, "PERMISSIVE", [TOOL_API], "SELECT"],
        ...(updated ? [[`${table}_tool_api_update`, "PERMISSIVE", [TOOL_API], "UPDATE"]] : []),
      ]);
      const byName = (suffix: string): Policy | undefined =>
        own.find((policy) => policy.name === `${table}_${suffix}`);
      expect([byName("runtime")?.using, byName("runtime")?.check], table).toEqual([
        coreRuntime?.using,
        coreRuntime?.check,
      ]);
      // Rule 5's clause, as PostgreSQL prints it: the booking a row names is its own business's.
      const clause = `(EXISTS ( SELECT 1 FROM bookings b WHERE ((b.id = ${table}.booking_id) AND (b.business_id = ${table}.business_id))))`;
      const scopedWithClause = `(${scope} AND ${clause})`;
      expect([byName("tool_api_select")?.using, byName("tool_api_select")?.check], table).toEqual([
        scope,
        null,
      ]);
      expect(
        [byName("tool_api_insert")?.using ?? null, oneLine(byName("tool_api_insert")?.check)],
        table,
      ).toEqual([null, scopedWithClause]);
      if (updated) {
        expect([byName("tool_api_update")?.using, oneLine(byName("tool_api_update")?.check)], table).toEqual([
          scope,
          scopedWithClause,
        ]);
      }
    }
    expect(
      policies
        .filter((policy) => policy.table === "quote_options")
        .map((policy) => [
          policy.name,
          policy.permissive,
          policy.roles,
          policy.command,
          policy.using,
          policy.check,
        ]),
    ).toEqual([
      [
        "quote_options_runtime",
        "PERMISSIVE",
        [RUNTIME],
        "ALL",
        coreRuntime?.using ?? "",
        coreRuntime?.check ?? "",
      ],
      ["quote_options_tool_api", "PERMISSIVE", [TOOL_API], "ALL", scope, scope],
    ]);
    expect(policies.filter((policy) => policy.command === "DELETE")).toEqual([]);
  });

  it("table grants (DL-149, each to its named reader: the migration's header; rule 6): both roles select and insert the eight, and update quotes, quote_options, owner_oks and booking_addresses, the same for each, but that rosie_app's read of secure_links is a column grant; no delete, truncate, references or trigger; nothing to PUBLIC or any other grantee", async () => {
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
          tablePrivileges(role, table).map((privilege) => `${role} ${table} ${privilege}`),
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

  it("column grants (rule 6): both roles' UPDATE of secure_links' and waitlist_entries' ended_at, ended_why and version only, and rosie_app's SELECT of every secure_links column but code_sha256, every grantee on the eight held to exactly them; has_column_privilege agrees, column by column", async () => {
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
    const key = (grant: { table: string; column: string; grantee: string; privilege: string }): string =>
      `${grant.table} ${grant.column} ${grant.grantee} ${grant.privilege}`;
    expect(granted.map(key).sort()).toEqual(
      [
        ...Object.entries(COLUMN_UPDATES).flatMap(([table, columns]) =>
          columns.flatMap((column) =>
            ROLES.map((grantee) => key({ table, column, grantee, privilege: "UPDATE" })),
          ),
        ),
        ...LINK_SELECTS.map((column) =>
          key({ table: "secure_links", column, grantee: TOOL_API, privilege: "SELECT" }),
        ),
      ].sort(),
    );
    for (const table of OWN_TABLES) {
      const updatable = await db.sql<{ role: string; column: string }[]>`
        select r.role, a.attname as column
        from unnest(${[...ROLES]}::text[]) as r(role)
          cross join pg_attribute a
        where a.attrelid = ${`${db.schema}.${table}`}::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
        order by 1, a.attnum
      `;
      const columns = TABLE_UPDATES.includes(table) ? columnsOf(table) : (COLUMN_UPDATES[table] ?? []);
      const ordered = columnsOf(table).filter((column) => columns.includes(column));
      expect(updatable, table).toEqual(ROLES.flatMap((role) => ordered.map((column) => ({ role, column }))));
    }
    // Exception (3): the Tool API reads every column of secure_links but code_sha256, by name; the runtime side all.
    const readable = await db.sql<{ role: string; column: string }[]>`
      select r.role, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
      where a.attrelid = ${`${db.schema}.secure_links`}::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'SELECT')
      order by 1, a.attnum
    `;
    expect(readable).toEqual([
      ...LINK_SELECTS.map((column) => ({ role: TOOL_API, column })),
      ...columnsOf("secure_links").map((column) => ({ role: RUNTIME, column })),
    ]);
    const [hash] = await db.sql<{ toolApi: boolean; runtime: boolean }[]>`
      select has_column_privilege(${TOOL_API}, ${`${db.schema}.secure_links`}, 'code_sha256', 'SELECT') as "toolApi",
             has_column_privilege(${RUNTIME}, ${`${db.schema}.secure_links`}, 'code_sha256', 'SELECT') as runtime
    `;
    expect(hash).toEqual({ toolApi: false, runtime: true });
  });
});

describe("the seed fixtures load (fixtures/index.json): the card's four whole, and seed-quote-owner-ok.json", () => {
  /** README "Checked on": the five seeds together, per K-30 table, in code-unit order. */
  const SEEDED = {
    booking_addresses: 2,
    booking_changes: 1,
    booking_details: 6,
    booking_lines: 4,
    booking_terms: 4,
    booking_terms_rules: 13,
    booking_visits: 4,
    owner_oks: 2,
    page_answers: 3,
    quote_options: 1,
    quotes: 1,
    secure_links: 3,
    waitlist_entries: 1,
  };
  /** The seven rows of part 2's tables the card's four seeds hold (T-720's report; DL-278). */
  const CARD_PART_2 = {
    booking_addresses: 1,
    booking_changes: 1,
    owner_oks: 1,
    page_answers: 2,
    secure_links: 1,
    waitlist_entries: 1,
  };

  it("the index lists five seeds (the card's four and the quote's) and eight refused rows (three on part 2's tables, five on part 1's), all K-30 v1; the quote seed's own table is quotes", () => {
    expect([...SEEDS].sort()).toEqual([...ALL_SEEDS].sort());
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([...REFUSED_HERE, ...REFUSED_PART_1].sort());
    expect(INDEX.every((entry) => entry.version === "v1")).toBe(true);
    expect(
      INDEX.filter((entry) => OWN_TABLES.includes(entry.table))
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([QUOTE_SEED, ...REFUSED_HERE].sort());
  });

  for (const file of ALL_SEEDS) {
    it(
      `${file} inserts alone with its after chain, whole, as the runtime side: every row of K-30's thirteen tables is stored as given, part 2's with the rest`,
      SLOW,
      async () => {
        await reset();
        const chain = rowsOf([file]).filter((row) => K30_TABLES.includes(row.table));
        const loaded = await loadFixtures([file]);
        for (const table of K30_TABLES) {
          const given = chain.filter((row) => row.table === table);
          expect(loaded[table] ?? 0, `${file}: ${table}`).toBe(given.length);
          expect(await countRows(db.sql, table), `${file}: ${table} stored`).toBe(given.length);
        }
        for (const row of chain) {
          await expectStored(row);
        }
        expect(
          fixtureFile(file).rows.some((row) => OWN_TABLES.includes(row.table)),
          file,
        ).toBe(true);
      },
    );
  }

  it(
    "all five insert together, each after chain once: K-30's thirteen tables hold the README's counts (owner_oks 2, booking_changes 1, quotes 1, quote_options 1, booking_addresses 2, secure_links 3, page_answers 3, waitlist_entries 1 beside part 1's), every row stored as given; the card's four alone give part 2's seven rows",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(ALL_SEEDS);
      expect(Object.fromEntries(K30_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await rowsIn(db.sql, K30_TABLES)).toEqual(SEEDED);
      expect(countsOf(K30_ROWS, K30_TABLES)).toEqual(SEEDED);
      expect(countsOf(rowsOf(CARD_SEEDS), OWN_TABLES)).toEqual(CARD_PART_2);
      for (const row of K30_ROWS) {
        await expectStored(row);
      }
    },
  );
});

describe("the seeded rows of part 2, read back (the five seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(ALL_SEEDS);
  }, 120_000);

  it("the quote with the owner's OK (B4-08 to B4-13): Jordan's $640 from photos at 7:30pm Mon, one option, over Sam's $500 limit that asks for quotes; sent at 7:40pm and good for 7 days; the request is still at the entry stage, its booking values undecided and only its town known", async () => {
    const [quote] = await db.sql<Record<string, unknown>[]>`
      select q.basis, q.state, q.currency, q.priced_by_person_id as "pricedBy",
             to_char(q.priced_at at time zone z.time_zone, 'FMHH12:MIam Dy') as priced,
             to_char(q.sent_at at time zone z.time_zone, 'FMHH12:MIam Dy') as sent,
             q.good_until - q.sent_at = interval '7 days' as "goodFor7Days",
             (select count(*)::int from quote_options o where o.quote_id = q.id) as options,
             o.price_cents::text as price, o.up_to_cents as "upTo", o.label,
             o.price_cents > l.over_cents and l.quotes and l.currency = q.currency as "overTheLimit",
             g.stage, d.approval, d.timing, d.times, d.taken,
             (select array_agg(a.area || ' ' || (a.address is null)::text) from booking_addresses a
               where a.booking_id = q.booking_id) as places
      from quotes q
        join quote_options o on o.quote_id = q.id
        join price_ok_limits l on l.id = q.price_ok_limit_id
        join businesses z on z.id = q.business_id
        join bookings g on g.id = q.booking_id
        join booking_details d on d.booking_id = q.booking_id
      where q.id = ${textOf(WATER_HEATER_QUOTE.id)}
    `;
    expect(quote).toEqual({
      basis: "photos",
      state: "sent",
      currency: "USD",
      pricedBy: "person-jordan",
      priced: "7:30pm Mon",
      sent: "7:40pm Mon",
      goodFor7Days: true,
      options: 1,
      price: "64000",
      upTo: null,
      label: null,
      overTheLimit: true,
      stage: "entry",
      approval: null,
      timing: null,
      times: null,
      taken: null,
      places: ["Springfield true"],
    });
  });

  it("Sam's OK of the quote and of Alex's haircut request are K-08's ownerYes: who answered (the owner), the question that asked them, the option they picked as it was sent, and the inbound event; each asked before its deadline and answered in time, the request reminded once 30 minutes on", async () => {
    const asks = await db.sql<Record<string, unknown>[]>`
      select k.id, k.about, k.answer, k.answered_by_person_id as person, k.answered_by_role as role,
             to_char(k.asked_at at time zone z.time_zone, 'FMHH12:MIam Dy') as asked,
             to_char(k.answer_by at time zone z.time_zone, 'FMHH12:MIam Dy') as "answerBy",
             to_char(k.answered_at at time zone z.time_zone, 'FMHH12:MIam Dy') as answered,
             k.reminded_at - k.asked_at as reminded,
             q.step, q.person_id = k.answered_by_person_id as "askedThem",
             k.option_id = q.answered_option_id as "theirPick",
             k.option_id in (select e->>'id' from jsonb_array_elements(q.options) e) as "asSent",
             k.event_id is not null as "withItsEvent", k.quote_id as quote
      from owner_oks k join open_questions q on q.id = k.open_question_id join businesses z on z.id = k.business_id
      order by k.id
    `;
    expect(asks).toEqual([
      {
        id: textOf(ALEX_HAIRCUT_OK.id),
        about: "request",
        answer: "accept",
        person: SAM,
        role: "owner",
        asked: "7:20pm Wed",
        answerBy: "11:20am Thu",
        answered: "8:05am Thu",
        reminded: "00:30:00",
        step: "A6-02",
        askedThem: true,
        theirPick: true,
        asSent: true,
        withItsEvent: true,
        quote: null,
      },
      {
        id: textOf(WATER_HEATER_OK.id),
        about: "quote",
        answer: "send",
        person: SAM,
        role: "owner",
        asked: "7:31pm Mon",
        answerBy: "11:30am Tue",
        answered: "7:38pm Mon",
        reminded: null,
        step: "B4-10",
        askedThem: true,
        theirPick: true,
        asSent: true,
        withItsEvent: true,
        quote: textOf(WATER_HEATER_QUOTE.id),
      },
    ]);
  });

  it("flow B's place and page (B4-77, B4-30, B4-34, B4-29): the town checked, then the street address sealed under Alex's key with its zone and state; two page answers (the plug-in's question, an access note) sealed under his key; the secure link texted to Alex's own mobile keeps only its code's sha256", async () => {
    const [address] = await db.sql<Record<string, unknown>[]>`
      select a.position, a.area, a.zone, a.state_code as state, a.sealed_for_person_id as "sealedFor",
             a.checked_at is not null as checked, length(a.address) > 0 as "sealedBytes", l.business_id = a.business_id as "itsOwnArea"
      from booking_addresses a join locations l on l.id = a.location_id
      where a.id = ${textOf(ALEX_DRAIN_ADDRESS.id)}
    `;
    expect(address).toEqual({
      position: 1,
      area: "Springfield",
      zone: "America/New_York",
      state: "IL",
      sealedFor: ALEX,
      checked: true,
      sealedBytes: true,
      itsOwnArea: true,
    });
    const answers = await db.sql<Record<string, unknown>[]>`
      select kind, question, person_id as person, length(answer) > 0 as "sealedBytes" from page_answers
      where booking_id = ${ALEX_DRAIN} order by answered_at
    `;
    expect(answers).toEqual([
      { kind: "question", question: "Is the sink still full of water?", person: ALEX, sealedBytes: true },
      { kind: "access", question: null, person: ALEX, sealedBytes: true },
    ]);
    const [link] = await db.sql<Record<string, unknown>[]>`
      select l.purpose, l.given_via as via, l.person_id as person, h.kind as "contactKind",
             exists (select 1 from person_handles p where p.person_id = l.person_id and p.handle_id = l.handle_id) as "theirOwn",
             l.code_sha256 ~ '^[0-9a-f]{64}$' as "hashOnly", l.ended_at as ended
      from secure_links l join handles h on h.id = l.handle_id
      where l.id = ${textOf(ALEX_DRAIN_LINK.id)}
    `;
    expect(link).toEqual({
      purpose: "secure_page",
      via: "text",
      person: ALEX,
      contactKind: "phone",
      theirOwn: true,
      hashOnly: true,
      ended: null,
    });
  });

  it("Dee's move is its own change row (FS line 756; A7-03): asked by Dee, her yes as K-08's answer naming the A7-03 question and the option she picked, by its turn, before free cancel; the head's version 4 to 5, now 5; its visit is the booking's own and points at the new reservation; and every other row it wrote is named with its versions", async () => {
    const [change] = await db.sql<Record<string, unknown>[]>`
      select c.kind, c.asked_by, c.asked_by_person_id as person, c.approved_by->>'kind' as yes,
             c.approved_by->>'option_id' = q.answered_option_id as "herPick", q.step,
             c.turn_id as turn, c.after_free_cancel as late, c.booking_version_before as before,
             c.booking_version_after as after, g.version as "headNow", v.booking_id = c.booking_id as "itsOwnVisit",
             c.new_values->>'reservation_id' = v.reservation_id as "visitMoved",
             jsonb_array_length(c.rows_changed) as "rowsNamed"
      from booking_changes c
        join open_questions q on q.id = c.approved_by->>'open_question_id'
        join bookings g on g.id = c.booking_id
        join booking_visits v on v.id = c.visit_id
      where c.id = ${textOf(DEE_MOVE.id)}
    `;
    expect(change).toEqual({
      kind: "moved",
      asked_by: "customer",
      person: DEE,
      yes: "answer",
      herPick: true,
      step: "A7-03",
      turn: "turn-dee-move-pick",
      late: false,
      before: 4,
      after: 5,
      headNow: 5,
      itsOwnVisit: true,
      visitMoved: true,
      rowsNamed: 3,
    });
  });

  it("Dee's waitlist entry (A4-60): her own yes to texts about the list, for the request that joined it (which ended there), Sat Oct 24 any time before noon in the shop's zone; ended booked once she booked the spot that opened", async () => {
    const [entry] = await db.sql<Record<string, unknown>[]>`
      select w.ended_why as ended, k.kind as "yesKind", k.person_id = w.person_id as "herOwnYes",
             k.booking_id = w.booking_id as "forThatRequest", d.request_ended_why as "requestEnded",
             to_char(lower(w.wanted) at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as "from",
             to_char(upper(w.wanted) at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as until,
             w.version
      from waitlist_entries w
        join consents k on k.id = w.consent_id
        join booking_details d on d.booking_id = w.booking_id
        join businesses z on z.id = w.business_id
      where w.id = ${textOf(DEE_ENTRY.id)}
    `;
    expect(entry).toEqual({
      ended: "booked",
      yesKind: "texts",
      herOwnYes: true,
      forThatRequest: true,
      requestEnded: "waitlist",
      from: "12:00am Sat Oct 24",
      until: "12:00pm Sat Oct 24",
      version: 2,
    });
  });
});

describe("the refused fixtures on part 2's tables: each refused for its one reason, and passing once its fault is removed", () => {
  beforeEach(async () => {
    await reset();
  }, 60_000);

  it(
    "refuse-change-row-update.json: rewriting Dee's move as late is refused by privilege (42501) for a Tool API call scoped to the barbershop, and for the runtime side, column by column; a new change row is appended",
    SLOW,
    async () => {
      const file = "invalid/refuse-change-row-update.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "update",
        "booking_changes",
        BARBERSHOP,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      for (const [role, scope] of [
        [roleOf(refused), BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(as(role, scope, updateWhere(refused.table, where, refused.set ?? {})));
        expect([outcome.code, outcome.message], role).toEqual([
          refused.expect.sqlstate,
          "permission denied for table booking_changes",
        ]);
        for (const column of columnsOf("booking_changes")) {
          const changed = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update booking_changes set "${column}" = "${column}" where id = $1`, [
                textOf(where.id),
              ]),
            ),
          );
          expect(changed.code, `${role} ${column}`).toBe("42501");
        }
      }
      const appended = await as(TOOL_API, BARBERSHOP, (tx) =>
        insertReturning(tx, "booking_changes", {
          ...DEE_MOVE,
          id: "change-probe-dee-haircut-late",
          after_free_cancel: true,
          booking_version_before: 5,
          booking_version_after: 6,
        }),
      );
      expect(appended.map((row) => [row.id, row.after_free_cancel, row.booking_id])).toEqual([
        ["change-probe-dee-haircut-late", true, DEE_HAIRCUT],
      ]);
      const [kept] = await db.sql<{ late: boolean }[]>`
        select after_free_cancel as late from booking_changes where id = ${textOf(where.id)}
      `;
      expect(kept?.late).toBe(false);
    },
  );

  it(
    "refuse-link-code-read.json: a Tool API call scoped to Lee Home Services reading the whole row of Alex's secure link is refused by privilege (42501), as are its hash alone and a search by it; its other columns are read, and only the runtime side finds a link by its code's hash, with no scope (the page server)",
    SLOW,
    async () => {
      const file = "invalid/refuse-link-code-read.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "select",
        "secure_links",
        HOME_SERVICES,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      const outcome = await refusal(
        as(
          roleOf(refused),
          HOME_SERVICES,
          (tx) => tx`select * from ${tx(refused.table)} where ${whereOf(tx, where)}`,
        ),
      );
      expect([outcome.code, outcome.message]).toEqual([
        refused.expect.sqlstate,
        "permission denied for table secure_links",
      ]);
      const hash = textOf(ALEX_DRAIN_LINK.code_sha256);
      for (const read of [
        (tx: Tx) => tx`select code_sha256 from secure_links`,
        (tx: Tx) => tx`select id from secure_links where code_sha256 = ${hash}`,
      ]) {
        expect((await refusal(as(TOOL_API, HOME_SERVICES, read))).code).toBe("42501");
      }
      const others = await as(
        TOOL_API,
        HOME_SERVICES,
        (tx) =>
          tx<
            Record<string, unknown>[]
          >`select ${tx(LINK_SELECTS)} from secure_links where ${whereOf(tx, where)}`,
      );
      expect(others.map((row) => [row.id, row.purpose, row.person_id, row.handle_id, row.given_via])).toEqual(
        [[textOf(where.id), "secure_page", ALEX, "handle-alex", "text"]],
      );
      expect(Object.keys(others[0] ?? {})).not.toContain("code_sha256");
      const found = await as(
        RUNTIME,
        null,
        (tx) => tx<{ id: string; business: string }[]>`
          select id, business_id as business from secure_links where code_sha256 = ${hash} and ended_at is null
        `,
      );
      expect(found).toEqual([{ id: textOf(where.id), business: HOME_SERVICES }]);
    },
  );

  it(
    "refuse-owner-ok-without-who.json: an owner's OK of a late move recorded as accept with nobody named is refused by CHECK owner_oks_answered_by (23514); the same row naming Sam as owner, a question that asked him and its inbound event passes",
    SLOW,
    async () => {
      const file = "invalid/refuse-owner-ok-without-who.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "insert",
        "owner_oks",
        BARBERSHOP,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const outcome = await refusal(
        as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, refused.table, refused.values ?? {})),
      );
      expect([outcome.code, refused.expect.constraintOneOf?.includes(outcome.constraint ?? "")]).toEqual([
        refused.expect.sqlstate,
        true,
      ]);
      const named = await as(TOOL_API, BARBERSHOP, (tx) =>
        insertReturning(tx, refused.table, {
          ...(refused.values ?? {}),
          answered_by_person_id: SAM,
          answered_by_role: "owner",
          open_question_id: textOf(ALEX_HAIRCUT_OK.open_question_id),
          event_id: textOf(ALEX_HAIRCUT_OK.event_id),
        }),
      );
      expect(named.map((row) => [row.id, row.about, row.answer, row.answered_by_person_id])).toEqual([
        [refused.values?.id, "late_move", "accept", SAM],
      ]);
    },
  );
});

describe("rule 7: page answers, access notes and the street address are stored sealed, and a read without the secure page's scope gets nothing (T-182's seal)", () => {
  const wrappingKey = randomBytes(32);
  const keys: WrappingKeys = { resolve: () => new Uint8Array(wrappingKey) };
  const TESSA_DRAIN = "booking-tessa-drain";
  /** Stand-ins for what Tessa types on her secure page: never real values. */
  const TYPED: [string, string][] = [
    ["address", "a stand-in street address for Tessa's drain, not real"],
    ["question", "a stand-in answer to the sink question, not real"],
    ["access", "a stand-in access note: the side gate, not real"],
    ["entry_code", "a stand-in entry code, not real"],
  ];
  const typedOf = (kind: string): string => TYPED.find(([name]) => name === kind)?.[1] ?? "";
  const ADDRESS_ID = "addr-probe-tessa-drain-1";
  const answerId = (kind: string): string => `ans-probe-tessa-drain-${kind}`;

  /** The sealed bytes of each, by kind (address, then the answers), as `sql` sees them. */
  const sealedRows = (sql: Sql | Tx) => sql<{ kind: string; person: string; bytes: Uint8Array }[]>`
    select 'address' as kind, sealed_for_person_id as person, address as bytes from booking_addresses
    where booking_id = ${TESSA_DRAIN}
    union all
    select kind, person_id, answer from page_answers where booking_id = ${TESSA_DRAIN}
  `;

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

  beforeAll(async () => {
    await reset();
    await loadFixtures([TESSA_SEED, LOCATION_SEED]);
    // Tessa types her street address and three answers on her own secure link: each sealed under her own new key.
    await committedAs(RUNTIME, async (tx) => {
      const address = await seal(tx, keys, TESSA, typedOf("address"));
      await tx`
        insert into booking_addresses ${tx({
          ...columnValues(tx, "booking_addresses", {
            ...ALEX_DRAIN_ADDRESS,
            id: ADDRESS_ID,
            booking_id: TESSA_DRAIN,
            address: null,
            sealed_for_person_id: TESSA,
          }),
          address: address as never,
        })}
      `;
      for (const [kind, words] of TYPED.filter(([name]) => name !== "address")) {
        const answer = await seal(tx, keys, TESSA, words);
        await tx`
          insert into page_answers ${tx({
            ...columnValues(tx, "page_answers", {
              ...ALEX_DRAIN_ACCESS,
              id: answerId(kind),
              booking_id: TESSA_DRAIN,
              person_id: TESSA,
              kind,
              question: kind === "question" ? "Is the sink still full of water?" : null,
              answer: null,
            }),
            answer: answer as never,
          })}
        `;
      }
    });
  }, 120_000);

  it("each is stored only as its sealed form under Tessa's key: T-182's format byte, 29 bytes longer than what she typed, never the typed words; no column of any row of booking_addresses or page_answers holds them, and only the town, zone, state, kind and the plug-in's question are plain", async () => {
    const rows = await sealedRows(db.sql);
    expect(rows.map((row) => [row.kind, row.person]).sort()).toEqual(
      TYPED.map(([kind]) => [kind, TESSA]).sort(),
    );
    for (const row of rows) {
      const typed = new TextEncoder().encode(typedOf(row.kind));
      expect(row.bytes[0], row.kind).toBe(0x01);
      expect(row.bytes.length, row.kind).toBe(typed.length + 29);
      expect(toHex(row.bytes), row.kind).not.toContain(toHex(typed));
    }
    const [plain] = await db.sql<{ n: number }[]>`
      select (select count(*)::int from booking_addresses t where row(t.*)::text like ${"%stand-in%"})
           + (select count(*)::int from page_answers t where row(t.*)::text like ${"%stand-in%"}) as n
    `;
    expect(plain?.n).toBe(0);
    const [place] = await db.sql<Record<string, unknown>[]>`
      select area, zone, state_code as state from booking_addresses where id = ${ADDRESS_ID}
    `;
    expect(place).toEqual({ area: "Springfield", zone: "America/New_York", state: "IL" });
  });

  it("with the secure page's scope, a call scoped to Lee Home Services reads the four sealed values, and Tessa's own key opens each to what she typed (the page server's side, which alone holds the keys)", async () => {
    const read = await as(TOOL_API, HOME_SERVICES, sealedRows);
    expect(read).toHaveLength(TYPED.length);
    const opened = await as(RUNTIME, null, async (tx) => {
      const out: [string, string][] = [];
      for (const row of read) {
        out.push([row.kind, await unsealText(tx, keys, TESSA, new Uint8Array(row.bytes))]);
      }
      return out.sort();
    });
    expect(opened).toEqual([...TYPED].sort());
  });

  it("without it, nothing: the Tool API with no scope, or scoped to the barbershop or the yoga studio, reads no row of either table; it can read no sealing key (42501); another person's key opens none (cannot_open); and once Tessa's key is erased (rule 8) none opens again, while the rows and their plain fields stay", async () => {
    for (const scope of [null, BARBERSHOP, YOGA_STUDIO]) {
      expect(await as(TOOL_API, scope, sealedRows), String(scope)).toEqual([]);
      expect(
        await as(TOOL_API, scope, (tx) => rowsIn(tx, ["booking_addresses", "page_answers"])),
        String(scope),
      ).toEqual({ booking_addresses: 0, page_answers: 0 });
    }
    const keyRead = await refusal(as(TOOL_API, HOME_SERVICES, (tx) => tx`select * from sealing_keys`));
    expect(keyRead.code).toBe("42501");
    const outcome = await as(RUNTIME, null, async (tx) => {
      const rows = await sealedRows(tx);
      // Sam gets a key of his own; Tessa's values do not open as his.
      await seal(tx, keys, SAM, "a stand-in value of Sam's, not real");
      const asSam: string[] = [];
      for (const row of rows) {
        asSam.push(await sealingCode(unsealText(tx, keys, SAM, new Uint8Array(row.bytes))));
      }
      const erased = await erasePerson(tx, TESSA);
      const afterErase: string[] = [];
      for (const row of rows) {
        afterErase.push(await sealingCode(unsealText(tx, keys, TESSA, new Uint8Array(row.bytes))));
      }
      const [kept] = await tx<{ addresses: number; answers: number; area: string; question: string }[]>`
        select (select count(*)::int from booking_addresses where booking_id = ${TESSA_DRAIN}) as addresses,
               (select count(*)::int from page_answers where booking_id = ${TESSA_DRAIN}) as answers,
               (select area from booking_addresses where id = ${ADDRESS_ID}) as area,
               (select question from page_answers where id = ${answerId("question")}) as question
      `;
      return { asSam, erased: erased.ok, afterErase, kept };
    });
    expect(outcome).toEqual({
      asSam: TYPED.map(() => "cannot_open"),
      erased: true,
      afterErase: TYPED.map(() => "erased"),
      kept: { addresses: 1, answers: 3, area: "Springfield", question: "Is the sink still full of water?" },
    });
  });

  it(
    "the seeds' own sealed rows (Alex's drain address and two answers, the water heater's photo) are bytes under their person's key, and a call scoped to another business, or with no scope, reads none of them",
    SLOW,
    async () => {
      await reset();
      await loadFixtures(ALL_SEEDS);
      const seeded = await db.sql<{ id: string; person: string; type: string }[]>`
      select id, sealed_for_person_id as person, pg_typeof(address)::text as type from booking_addresses
      where address is not null
      union all
      select id, person_id, pg_typeof(answer)::text from page_answers
    `;
      expect([...seeded].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
        [
          textOf(ALEX_DRAIN_ACCESS.id),
          "ans-alex-drain-sink",
          textOf(WATER_HEATER_PHOTO.id),
          textOf(ALEX_DRAIN_ADDRESS.id),
        ]
          .sort()
          .map((id) => ({ id, person: ALEX, type: "bytea" })),
      );
      for (const scope of [null, BARBERSHOP, YOGA_STUDIO]) {
        expect(
          await as(TOOL_API, scope, (tx) => rowsIn(tx, ["booking_addresses", "page_answers"])),
          String(scope),
        ).toEqual({ booking_addresses: 0, page_answers: 0 });
      }
      expect(
        await as(TOOL_API, HOME_SERVICES, (tx) => rowsIn(tx, ["booking_addresses", "page_answers"])),
      ).toEqual({ booking_addresses: 2, page_answers: 3 });
    },
  );
});

describe("the waitlist keeps its order under 50 parallel joins on one time (A4-60): positions 1 to 50, with no gap and no repeat", () => {
  const PEOPLE = 50;
  const pad = (i: number): string => String(i + 1).padStart(2, "0");
  /** Fifty stand-in customers of the barbershop, each with a request that joins the list and their own yes to it. */
  const STAND_INS = Array.from({ length: PEOPLE }, (_, i) => {
    const n = pad(i);
    const person = `person-probe-wait-${n}`;
    const handle = `handle-probe-wait-${n}`;
    const booking = `booking-probe-wait-${n}`;
    const consent = `consent-probe-wait-${n}`;
    return {
      person: { ...DEE_PERSON, id: person, name: `Waitlist stand-in ${n}`, version: 1 },
      handle: { id: handle, kind: "email", address: `waitlist-stand-in-${n}@example.com` },
      booking: {
        ...DEE_WAITLIST_HEAD,
        id: booking,
        booker_person_id: person,
        served_person_id: person,
        payer_person_id: person,
      },
      consent: {
        ...DEE_WAITLIST_YES,
        id: consent,
        person_id: person,
        handle_id: handle,
        booking_id: booking,
      },
      entry: {
        id: `wait-probe-${n}`,
        business_id: BARBERSHOP,
        booking_id: booking,
        person_id: person,
        service_id: SKIN_FADE,
        resource_id: null,
        wanted: WANTED,
        consent_id: consent,
      } satisfies Values,
    };
  });

  /**
   * The open list of the skin fade at the barbershop for that one time, in its order: K-30 v1 keeps no position column,
   * so an entry's position is its rank by joined_at, then id (the README: one open entry per person and service).
   */
  const positions = (sql: Sql | Tx) => sql<{ id: string; person: string; position: number }[]>`
    select id, person_id as person, (row_number() over (order by joined_at, id))::int as position
    from waitlist_entries
    where business_id = ${BARBERSHOP} and service_id = ${SKIN_FADE} and wanted = ${WANTED}::tstzrange
      and ended_at is null
    order by joined_at, id
  `;

  /** One join: a Tool API call scoped to the barbershop that inserts the entry, committed. */
  const join = (entry: Values): Promise<string | undefined> =>
    withBusiness(db.sql, BARBERSHOP, async (tx) => {
      await tx.unsafe(`set local role ${TOOL_API}`);
      const [row] = await tx<{ id: string }[]>`
        insert into waitlist_entries ${tx(columnValues(tx, "waitlist_entries", entry))} returning id
      `;
      return row?.id;
    });

  beforeAll(async () => {
    await reset();
    await loadFixtures(["seed-terms-snapshot.json"]);
    await committedAs(RUNTIME, async (tx) => {
      for (const standIn of STAND_INS) {
        await insertRow(tx, "persons", standIn.person);
        await insertRow(tx, "handles", standIn.handle);
        await insertRow(tx, "bookings", standIn.booking);
        await insertRow(tx, "consents", standIn.consent);
      }
    });
  }, 120_000);

  it(
    "fifty customers join the skin fade's list for Sat Oct 24 before noon at once, each its own Tool API call scoped to the barbershop: all fifty are stored, at positions 1 to 50 with no gap and no repeat, one each, and the barbershop's scope reads the same list while the yoga studio's reads none",
    SLOW,
    async () => {
      expect(await positions(db.sql)).toEqual([]);
      const joined = await Promise.all(STAND_INS.map((standIn) => join(standIn.entry)));
      expect([...joined].sort()).toEqual(STAND_INS.map((standIn) => standIn.entry.id).sort());
      const list = await positions(db.sql);
      expect(list.map((row) => row.position)).toEqual(oneTo(PEOPLE));
      expect(new Set(list.map((row) => row.id)).size).toBe(PEOPLE);
      expect(list.map((row) => row.person).sort()).toEqual(
        STAND_INS.map((standIn) => standIn.person.id).sort(),
      );
      expect(await as(TOOL_API, BARBERSHOP, positions)).toEqual(list);
      expect(await as(TOOL_API, YOGA_STUDIO, positions)).toEqual([]);
      // Dee's own entry for that time ended booked, so it holds no place.
      const [dee] = await db.sql<{ ended: string }[]>`
        select ended_why as ended from waitlist_entries where id = ${textOf(DEE_ENTRY.id)}
      `;
      expect(dee?.ended).toBe("booked");
    },
  );

  it(
    "a repeated join writes no second row: the same fifty joining again at once are each refused by waitlist_entries_one_open (23505), and the list is as it was",
    SLOW,
    async () => {
      const before = await positions(db.sql);
      expect(before).toHaveLength(PEOPLE);
      const again = await Promise.all(
        STAND_INS.map((standIn) => refusal(join({ ...standIn.entry, id: `${standIn.entry.id}-again` }))),
      );
      expect(again.map((outcome) => [outcome.code, outcome.constraint])).toEqual(
        STAND_INS.map(() => ["23505", "waitlist_entries_one_open"]),
      );
      expect(await positions(db.sql)).toEqual(before);
    },
  );

  it("each entry keeps its place: no role can change what orders the list or who waits for what (42501), and when the one at position 25 leaves, those after it move up one while every other keeps its place", async () => {
    const before = await positions(db.sql);
    const leaving = before[24];
    expect(leaving?.position).toBe(25);
    for (const column of columnsOf("waitlist_entries").filter(
      (name) => !(COLUMN_UPDATES.waitlist_entries ?? []).includes(name),
    )) {
      for (const [role, scope] of [
        [TOOL_API, BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) =>
            tx.unsafe(
              `update waitlist_entries set "${column}" = "${column}", version = version + 1 where id = $1`,
              [leaving?.id ?? ""],
            ),
          ),
        );
        expect([outcome.code, outcome.message], `${role} ${column}`).toEqual([
          "42501",
          "permission denied for table waitlist_entries",
        ]);
      }
    }
    const after = await as(TOOL_API, BARBERSHOP, async (tx) => {
      await tx`
        update waitlist_entries set ended_at = now(), ended_why = 'left', version = version + 1
        where id = ${leaving?.id ?? ""}
      `;
      return positions(tx);
    });
    expect(after.map((row) => row.id)).toEqual(
      before.filter((row) => row.id !== leaving?.id).map((row) => row.id),
    );
    expect(after.map((row) => row.position)).toEqual(oneTo(PEOPLE - 1));
    expect(after.slice(0, 24)).toEqual(before.slice(0, 24));
    expect(after.slice(24).map((row) => row.position)).toEqual(
      before.slice(25).map((row) => row.position - 1),
    );
  });
});

describe("rule 5: each business's scope reads and writes only its own rows, and only onto its own bookings (the five seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(ALL_SEEDS);
  }, 120_000);

  /**
   * One row of each of the seven tables with booking_id naming the barbershop and Lee Home Services' drain: the
   * fixtures' own rows under new ids, each with that one fault. Rule 5's clause refuses each under the barbershop's
   * scope; the keys alone let each through.
   */
  const ONTO_THE_DRAIN: [string, Values][] = [
    ["booking_changes", { ...DEE_MOVE, id: "change-probe-drain", booking_id: ALEX_DRAIN, visit_id: null }],
    [
      "quotes",
      {
        ...WATER_HEATER_QUOTE,
        id: "quote-probe-drain",
        booking_id: ALEX_DRAIN,
        business_id: BARBERSHOP,
        service_id: "svc-lees-haircut",
        price_ok_limit_id: null,
      },
    ],
    ["owner_oks", { ...ALEX_HAIRCUT_OK, id: "ok-probe-drain", booking_id: ALEX_DRAIN }],
    [
      "booking_addresses",
      { ...ALEX_DRAIN_ADDRESS, id: "addr-probe-drain-2", business_id: BARBERSHOP, position: 2 },
    ],
    [
      "secure_links",
      {
        ...ALEX_DRAIN_LINK,
        id: "link-probe-drain",
        business_id: BARBERSHOP,
        code_sha256: sha256Hex("a stand-in link code for the drain, not real"),
      },
    ],
    ["page_answers", { ...ALEX_DRAIN_ACCESS, id: "ans-probe-drain", business_id: BARBERSHOP }],
    ["waitlist_entries", { ...DEE_ENTRY, id: "wait-probe-drain", booking_id: ALEX_DRAIN }],
  ];

  it("with no scope the Tool API reads no row of the eight; each business's scope shows exactly its own rows: the yoga studio none, the barbershop its own (a change, an ask, a waitlist entry), Lee Home Services its own (two addresses, a quote and its option, an ask, three links, three answers)", async () => {
    expect(await as(TOOL_API, null, visibleRows)).toEqual(Object.fromEntries(OWN_TABLES.map((t) => [t, 0])));
    const businesses = await businessIds();
    expect(businesses).toEqual(expect.arrayContaining([BARBERSHOP, HOME_SERVICES, YOGA_STUDIO]));
    for (const business of [...businesses, "biz-nobody"]) {
      expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
    }
    expect(await as(TOOL_API, HOME_SERVICES, visibleRows)).toEqual({
      booking_addresses: 2,
      booking_changes: 0,
      owner_oks: 1,
      page_answers: 3,
      quote_options: 1,
      quotes: 1,
      secure_links: 3,
      waitlist_entries: 0,
    });
    expect(await as(TOOL_API, BARBERSHOP, visibleRows)).toEqual({
      booking_addresses: 0,
      booking_changes: 1,
      owner_oks: 1,
      page_answers: 0,
      quote_options: 0,
      quotes: 0,
      secure_links: 0,
      waitlist_entries: 1,
    });
    expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
    for (const business of businesses) {
      expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
    }
  });

  it("the Tool API scoped to the barbershop cannot attach a row naming its own business to Lee Home Services' booking (rule 5's clause, 42501) on any of the seven with booking_id, though every key lets it through; Lee Home Services' own scope adds a second address, a note and a link given to Alex's own AI to its drain", async () => {
    for (const [table, values] of ONTO_THE_DRAIN) {
      expect(values.business_id, table).toBe(BARBERSHOP);
      const attached = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertRow(tx, table, values)));
      expect([attached.code, attached.message], table).toEqual([
        "42501",
        `new row violates row-level security policy for table "${table}"`,
      ]);
      // The keys alone let it through: as the owner (not bound by row-level security), it is stored.
      expect(
        await asOwner(async (tx) => {
          await insertRow(tx, table, values);
          return countRows(tx, table);
        }),
        table,
      ).toBe((await countRows(db.sql, table)) + 1);
    }
    const own = await as(TOOL_API, HOME_SERVICES, async (tx) => {
      await insertRow(tx, "booking_addresses", {
        ...ALEX_DRAIN_ADDRESS,
        id: "addr-probe-drain-2",
        position: 2,
      });
      await insertRow(tx, "page_answers", { ...ALEX_DRAIN_ACCESS, id: "ans-probe-drain-note", kind: "note" });
      await insertRow(tx, "secure_links", {
        ...ALEX_DRAIN_LINK,
        id: "link-probe-drain-ai",
        handle_id: null,
        given_via: "ai",
        code_sha256: sha256Hex("a stand-in link code given to Alex's AI, not real"),
      });
      const [counts] = await tx<{ addresses: number; answers: number; links: number }[]>`
        select (select count(*)::int from booking_addresses where booking_id = ${ALEX_DRAIN}) as addresses,
               (select count(*)::int from page_answers where booking_id = ${ALEX_DRAIN}) as answers,
               (select count(*)::int from secure_links where booking_id = ${ALEX_DRAIN}) as links
      `;
      return counts;
    });
    expect(own).toEqual({ addresses: 2, answers: 3, links: 2 });
  });

  it("an option names a quote of its own business (quote_options_quote_fk, 23503): a barbershop option of Lee Home Services' quote is refused, for its scope and for the owner; the Tool API cannot move a row of the eight to another business (42501)", async () => {
    const option: Values = {
      ...WATER_HEATER_OPTION,
      id: "qopt-probe-barbershop",
      business_id: BARBERSHOP,
      position: 2,
    };
    for (const attempt of [
      () => as(TOOL_API, BARBERSHOP, (tx) => insertRow(tx, "quote_options", option)),
      () => asOwner((tx) => insertRow(tx, "quote_options", option)),
    ]) {
      const outcome = await refusal(attempt());
      expect([outcome.code, outcome.constraint]).toEqual(["23503", "quote_options_quote_fk"]);
    }
    const rows: [string, string, string][] = [
      ["booking_changes", textOf(DEE_MOVE.id), BARBERSHOP],
      ["owner_oks", textOf(ALEX_HAIRCUT_OK.id), BARBERSHOP],
      ["waitlist_entries", textOf(DEE_ENTRY.id), BARBERSHOP],
      ["quotes", textOf(WATER_HEATER_QUOTE.id), HOME_SERVICES],
      ["quote_options", textOf(WATER_HEATER_OPTION.id), HOME_SERVICES],
      ["booking_addresses", textOf(ALEX_DRAIN_ADDRESS.id), HOME_SERVICES],
      ["secure_links", textOf(ALEX_DRAIN_LINK.id), HOME_SERVICES],
      ["page_answers", "ans-alex-drain-sink", HOME_SERVICES],
    ];
    expect(rows.map(([table]) => table).sort()).toEqual(OWN_TABLES);
    for (const [table, id, business] of rows) {
      const other = business === BARBERSHOP ? HOME_SERVICES : BARBERSHOP;
      const raise = VERSIONED.includes(table) ? ", version = version + 1" : "";
      const moved = await refusal(
        as(TOOL_API, business, (tx) =>
          tx.unsafe(`update ${table} set business_id = $1${raise} where id = $2`, [other, id]),
        ),
      );
      expect([moved.code, moved.message], table).toEqual([
        "42501",
        TABLE_UPDATES.includes(table)
          ? `new row violates row-level security policy for table "${table}"`
          : `permission denied for table ${table}`,
      ]);
    }
  });

  it("the runtime side scoped to one business (per write) cannot write another's row (42501); scoped to its own, or with no scope, it writes it, and holds a row's booking to its business by code (rule 5)", async () => {
    const second: Values = { ...ALEX_DRAIN_ADDRESS, id: "addr-probe-drain-2", position: 2 };
    const outcome = await refusal(
      as(RUNTIME, YOGA_STUDIO, (tx) => insertRow(tx, "booking_addresses", second)),
    );
    expect(outcome.code).toBe("42501");
    for (const scope of [HOME_SERVICES, null]) {
      expect(
        await as(RUNTIME, scope, async (tx) => {
          await insertRow(tx, "booking_addresses", second);
          return countRows(tx, "booking_addresses");
        }),
        String(scope),
      ).toBe((await countRows(db.sql, "booking_addresses")) + 1);
    }
  });
});

describe("rule 6: what may be written, by privilege, the same for both roles (the five seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(ALL_SEEDS);
  }, 120_000);

  /** Each of the eight with one of its rows, by id, and its business. */
  const ROWS: [string, string, string][] = [
    ["booking_addresses", textOf(ALEX_DRAIN_ADDRESS.id), HOME_SERVICES],
    ["booking_changes", textOf(DEE_MOVE.id), BARBERSHOP],
    ["owner_oks", textOf(WATER_HEATER_OK.id), HOME_SERVICES],
    ["page_answers", "ans-alex-drain-sink", HOME_SERVICES],
    ["quote_options", textOf(WATER_HEATER_OPTION.id), HOME_SERVICES],
    ["quotes", textOf(WATER_HEATER_QUOTE.id), HOME_SERVICES],
    ["secure_links", textOf(ALEX_DRAIN_LINK.id), HOME_SERVICES],
    ["waitlist_entries", textOf(DEE_ENTRY.id), BARBERSHOP],
  ];

  it("no role deletes a row of any of the eight (42501): a booking and its records are kept 7 years (rule 8)", async () => {
    expect(ROWS.map(([table]) => table)).toEqual(OWN_TABLES);
    for (const [table, id, business] of ROWS) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) => tx.unsafe(`delete from ${table} where id = $1`, [id])),
        );
        expect([outcome.code, outcome.message], `${role} ${table}`).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    }
  });

  it("booking_changes and page_answers are insert only (FS line 756; an answer is never edited): neither role updates any of their columns (42501)", async () => {
    for (const [table, id, business] of ROWS.filter(([name]) => INSERT_ONLY.includes(name))) {
      for (const column of columnsOf(table)) {
        for (const [role, scope] of [
          [TOOL_API, business],
          [RUNTIME, null],
        ] as const) {
          const outcome = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update ${table} set "${column}" = "${column}" where id = $1`, [id]),
            ),
          );
          expect([outcome.code, outcome.message], `${role} ${table}.${column}`).toEqual([
            "42501",
            `permission denied for table ${table}`,
          ]);
        }
      }
    }
  });

  it("a link and a waitlist entry change only their end (rule 6): every other column is refused for either role (42501); a contact switch ends Alex's link and Dee's second wait ends when she leaves, each raising its version", async () => {
    for (const [table, id, business] of ROWS.filter(([name]) => name in COLUMN_UPDATES)) {
      for (const column of columnsOf(table).filter((name) => !(COLUMN_UPDATES[table] ?? []).includes(name))) {
        for (const [role, scope] of [
          [TOOL_API, business],
          [RUNTIME, null],
        ] as const) {
          const outcome = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(
                `update ${table} set "${column}" = "${column}", version = version + 1 where id = $1`,
                [id],
              ),
            ),
          );
          expect([outcome.code, outcome.message], `${role} ${table}.${column}`).toEqual([
            "42501",
            `permission denied for table ${table}`,
          ]);
        }
      }
    }
    for (const [role, scope] of [
      [TOOL_API, HOME_SERVICES],
      [RUNTIME, null],
    ] as const) {
      const ended = await as(
        role,
        scope,
        (tx) => tx<{ why: string; version: number }[]>`
          update secure_links set ended_at = now(), ended_why = 'contact_switched', version = version + 1
          where id = ${textOf(ALEX_DRAIN_LINK.id)}
          returning ended_why as why, version
        `,
      );
      expect(ended, role).toEqual([{ why: "contact_switched", version: 2 }]);
    }
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const left = await as(role, scope, async (tx) => {
        await insertRow(tx, "waitlist_entries", {
          ...DEE_ENTRY,
          id: "wait-probe-dee-again",
          joined_at: "2026-10-28T13:00:00Z",
          ended_at: null,
          ended_why: null,
          version: 1,
        });
        return tx<{ why: string; version: number }[]>`
          update waitlist_entries set ended_at = now(), ended_why = 'left', version = version + 1
          where id = 'wait-probe-dee-again'
          returning ended_why as why, version
        `;
      });
      expect(left, role).toEqual([{ why: "left", version: 2 }]);
    }
  });

  it("every update of a versioned table raises its version by exactly one, under either role: one that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const [table, id, business] of ROWS.filter(([name]) => VERSIONED.includes(name))) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const kept = await refusal(
          as(role, scope, (tx) => tx.unsafe(`update ${table} set version = version where id = $1`, [id])),
        );
        expect([kept.code, kept.constraint], `${role} ${table}`).toEqual([
          "23514",
          `${table}_version_raised`,
        ]);
        const raised = await as(role, scope, (tx) =>
          tx.unsafe<{ before: number; version: number }[]>(
            `update ${table} set version = version + 1 where id = $1 returning version - 1 as before, version`,
            [id],
          ),
        );
        expect(
          raised.map((row) => row.version - row.before),
          `${role} ${table}`,
        ).toEqual([1]);
      }
    }
  });

  it("quotes, quote_options, owner_oks and booking_addresses take updates as table grants, behind rule 5: the owner's read-back changes an option before its quote is sent, the quote is sent good for 7 days, an ask is reminded, and the water heater's town gets its sealed, checked street address", async () => {
    const outcome = await as(TOOL_API, HOME_SERVICES, async (tx) => {
      const quote = await insertReturning(tx, "quotes", {
        ...WATER_HEATER_QUOTE,
        id: "quote-probe-water-heater-2",
        state: "with_owner",
        sent_at: null,
        good_until: null,
        version: 1,
      });
      await insertRow(tx, "quote_options", {
        ...WATER_HEATER_OPTION,
        id: "qopt-probe-water-heater-2",
        quote_id: "quote-probe-water-heater-2",
      });
      const option = await tx<{ price: string; version: number }[]>`
        update quote_options set price_cents = 60000, version = version + 1 where id = 'qopt-probe-water-heater-2'
        returning price_cents::text as price, version
      `;
      const sent = await tx<{ state: string; version: number }[]>`
        update quotes set state = 'sent', sent_at = now(), good_until = now() + interval '168 hours',
               version = version + 1
        where id = 'quote-probe-water-heater-2'
        returning state, version
      `;
      const ask = await tx<{ version: number }[]>`
        update owner_oks set reminded_at = asked_at + interval '30 minutes', version = version + 1
        where id = ${textOf(WATER_HEATER_OK.id)}
        returning version
      `;
      const place = await tx<{ checked: boolean; version: number }[]>`
        update booking_addresses set ${tx(
          columnValues(tx, "booking_addresses", {
            address: textOf(ALEX_DRAIN_ADDRESS.address),
            sealed_for_person_id: ALEX,
            zone: "America/New_York",
            state_code: "IL",
            checked_at: "2026-10-19T23:45:00Z",
          }),
        )}, version = version + 1
        where id = 'addr-alex-water-heater-1'
        returning checked_at is not null as checked, version
      `;
      return { quote: quote.map((row) => row.state), option, sent, ask, place };
    });
    expect(outcome).toEqual({
      quote: ["with_owner"],
      option: [{ price: "60000", version: 2 }],
      sent: [{ state: "sent", version: 2 }],
      ask: [{ version: 3 }],
      place: [{ checked: true, version: 2 }],
    });
  });
});

describe("probes: each breaks one rule of the table list and is refused by the constraint it names; the rows without the fault pass (the five seeds loaded)", () => {
  /** A change of Dee's haircut after her move: the head's version 5 to 6. */
  const CHANGE: Values = {
    ...DEE_MOVE,
    id: "change-probe-dee-haircut-2",
    booking_version_before: 5,
    booking_version_after: 6,
  };
  /** A second quote of Alex's water heater, being priced. */
  const QUOTE: Values = {
    ...WATER_HEATER_QUOTE,
    id: "quote-probe-water-heater-2",
    priced_by_person_id: null,
    priced_at: null,
    state: "pricing",
    sent_at: null,
    good_until: null,
    version: 1,
  };
  /** That quote's first option (a sent quote's options never change: rule 10, code's). */
  const OPTION: Values = {
    ...WATER_HEATER_OPTION,
    id: "qopt-probe-water-heater-2",
    quote_id: textOf(QUOTE.id),
    position: 1,
    label: null,
  };
  /** A change on Alex's drain from the owner console (no turn: CQ-44), the head's version 5 to 6. */
  const DRAIN_CHANGE: Values = {
    ...CHANGE,
    id: "change-probe-drain",
    booking_id: ALEX_DRAIN,
    business_id: HOME_SERVICES,
    visit_id: "visit-alex-drain-1",
    kind: "what_changed",
    asked_by: "owner",
    asked_by_person_id: SAM,
    approved_by: null,
    turn_id: null,
    job_id: "job-probe-console",
  };
  /** A waiting ask about Alex's water heater request (no answer yet). */
  const ASK: Values = {
    ...WATER_HEATER_OK,
    id: "ok-probe-water-heater-request",
    about: "request",
    quote_id: null,
    answer: null,
    answered_at: null,
    answered_by_person_id: null,
    answered_by_role: null,
    open_question_id: null,
    option_id: null,
    event_id: null,
    version: 1,
  };
  const ADDRESS: Values = {
    ...ALEX_DRAIN_ADDRESS,
    id: "addr-probe-drain-2",
    position: 2,
    address: null,
    sealed_for_person_id: null,
    zone: null,
    state_code: null,
    checked_at: null,
    version: 1,
  };
  const LINK: Values = {
    ...ALEX_DRAIN_LINK,
    id: "link-probe-drain-2",
    code_sha256: sha256Hex("a stand-in link code, not real"),
  };
  const ANSWER: Values = { ...ALEX_DRAIN_ACCESS, id: "ans-probe-drain-entry-code", kind: "entry_code" };
  /** Dee waiting again for a Saturday-morning skin fade, her first entry ended. */
  const WAIT: Values = {
    ...DEE_ENTRY,
    id: "wait-probe-dee-again",
    ended_at: null,
    ended_why: null,
    version: 1,
  };
  /** Alex's water heater line, copied from the option he picked with its 25% deposit. */
  const PHOTOS_LINE: Values = {
    ...ALEX_DRAIN_LINE,
    id: "line-probe-water-heater-1",
    booking_id: WATER_HEATER,
    service_id: "svc-lee-plumbing-water-heater",
    service_money_id: "way-lee-plumbing-water-heater-home",
    price_rule_id: null,
    quote_option_id: textOf(WATER_HEATER_OPTION.id),
    path: "photos|deposit|bill",
    price_cents: 64000,
    deposit_cents: 16000,
    fee_cents: null,
  };

  interface Probe {
    breaks: string;
    /** Inserted in order, as the runtime side with no scope; the last row holds the fault. */
    rows: [string, Values][];
    code: string;
    constraint: string;
  }

  const PROBES: Probe[] = [
    {
      breaks: "a change of an unknown kind",
      rows: [["booking_changes", { ...CHANGE, kind: "rescheduled" }]],
      code: "23514",
      constraint: "booking_changes_kind_known",
    },
    {
      breaks: "a customer's change naming nobody",
      rows: [["booking_changes", { ...CHANGE, asked_by_person_id: null }]],
      code: "23514",
      constraint: "booking_changes_asked_by_known",
    },
    {
      breaks: "a change made by no turn and no job",
      rows: [["booking_changes", { ...CHANGE, turn_id: null, job_id: null }]],
      code: "23514",
      constraint: "booking_changes_turn_or_job",
    },
    {
      breaks: "a change whose head version does not rise",
      rows: [["booking_changes", { ...CHANGE, booking_version_after: 5 }]],
      code: "23514",
      constraint: "booking_changes_versions",
    },
    {
      breaks: "a change's old values as a list",
      rows: [["booking_changes", { ...CHANGE, old_values: ["rsv-dee-haircut-first"] }]],
      code: "23514",
      constraint: "booking_changes_json_shapes",
    },
    {
      breaks: "a change naming another booking's visit (Alex's haircut's)",
      rows: [["booking_changes", { ...CHANGE, visit_id: "visit-alex-haircut-1" }]],
      code: "23503",
      constraint: "booking_changes_visit_fk",
    },
    {
      breaks: "a quote priced from video",
      rows: [["quotes", { ...QUOTE, basis: "video" }]],
      code: "23514",
      constraint: "quotes_basis_known",
    },
    {
      breaks: "a priced quote in an unknown state",
      rows: [
        [
          "quotes",
          {
            ...QUOTE,
            state: "accepted",
            priced_by_person_id: WATER_HEATER_QUOTE.priced_by_person_id ?? null,
            priced_at: WATER_HEATER_QUOTE.priced_at ?? null,
          },
        ],
      ],
      code: "23514",
      constraint: "quotes_state_known",
    },
    {
      breaks: "a quote priced by nobody",
      rows: [["quotes", { ...QUOTE, priced_at: "2026-10-19T23:30:00Z" }]],
      code: "23514",
      constraint: "quotes_priced_pair",
    },
    {
      breaks: "a sent quote good for 6 days (A4-12: 7)",
      rows: [
        [
          "quotes",
          {
            ...WATER_HEATER_QUOTE,
            id: "quote-probe-water-heater-2",
            good_until: "2026-10-25T23:40:00Z",
          },
        ],
      ],
      code: "23514",
      constraint: "quotes_sent_good_7_days",
    },
    {
      breaks: "a lower-case currency",
      rows: [["quotes", { ...QUOTE, currency: "usd" }]],
      code: "23514",
      constraint: "quotes_currency_form",
    },
    {
      breaks: "a quote of another business's service (the barbershop's haircut)",
      rows: [["quotes", { ...QUOTE, service_id: "svc-lees-haircut" }]],
      code: "23503",
      constraint: "quotes_service_fk",
    },
    {
      breaks: "an option at position 0",
      rows: [
        ["quotes", QUOTE],
        ["quote_options", { ...OPTION, position: 0 }],
      ],
      code: "23514",
      constraint: "quote_options_position_from_one",
    },
    {
      breaks: "a range whose top is not above its price",
      rows: [
        ["quotes", QUOTE],
        ["quote_options", { ...OPTION, up_to_cents: 64000, price_cents: 64000 }],
      ],
      code: "23514",
      constraint: "quote_options_money",
    },
    {
      breaks: "an option with a blank label",
      rows: [
        ["quotes", QUOTE],
        ["quote_options", { ...OPTION, label: " " }],
      ],
      code: "23514",
      constraint: "quote_options_money",
    },
    {
      breaks: "a second first option of one quote",
      rows: [
        ["quotes", QUOTE],
        ["quote_options", OPTION],
        ["quote_options", { ...OPTION, id: "qopt-probe-water-heater-3" }],
      ],
      code: "23505",
      constraint: "quote_options_position_key",
    },
    {
      breaks: "an ask about a quote that names no quote",
      rows: [["owner_oks", { ...ASK, about: "quote" }]],
      code: "23514",
      constraint: "owner_oks_about_known",
    },
    {
      breaks: "a quote's answer that does not fit (accept)",
      rows: [["owner_oks", { ...WATER_HEATER_OK, id: "ok-probe-water-heater-quote-2", answer: "accept" }]],
      code: "23514",
      constraint: "owner_oks_answer_fits",
    },
    {
      breaks: "an answer from a staff member (only the owner or an admin)",
      rows: [
        ["owner_oks", { ...WATER_HEATER_OK, id: "ok-probe-water-heater-quote-2", answered_by_role: "staff" }],
      ],
      code: "23514",
      constraint: "owner_oks_answered_by",
    },
    {
      breaks: "no answer before the deadline passed (S13-26: silence never says yes)",
      rows: [["owner_oks", { ...ASK, answer: "no_answer", answered_at: "2026-10-20T15:00:00Z" }]],
      code: "23514",
      constraint: "owner_oks_times",
    },
    {
      breaks: "a second waiting ask about one request",
      rows: [
        ["owner_oks", ASK],
        ["owner_oks", { ...ASK, id: "ok-probe-water-heater-request-2" }],
      ],
      code: "23505",
      constraint: "owner_oks_one_waiting",
    },
    {
      breaks: "a second waiting ask about one quote",
      rows: [
        ["quotes", QUOTE],
        ["owner_oks", { ...ASK, about: "quote", quote_id: QUOTE.id ?? null }],
        [
          "owner_oks",
          { ...ASK, id: "ok-probe-water-heater-request-2", about: "quote", quote_id: QUOTE.id ?? null },
        ],
      ],
      code: "23505",
      constraint: "owner_oks_one_waiting_per_quote",
    },
    {
      breaks: "a third address",
      rows: [["booking_addresses", { ...ADDRESS, position: 3 }]],
      code: "23514",
      constraint: "booking_addresses_position_known",
    },
    {
      breaks: "an address sealed for nobody",
      rows: [["booking_addresses", { ...ADDRESS, address: textOf(ALEX_DRAIN_ADDRESS.address) }]],
      code: "23514",
      constraint: "booking_addresses_sealed_with_person",
    },
    {
      breaks: "a zone that is not an IANA name",
      rows: [["booking_addresses", { ...ADDRESS, zone: "Eastern Time" }]],
      code: "23514",
      constraint: "booking_addresses_zone_state_form",
    },
    {
      breaks: "an address checked with no zone",
      rows: [
        [
          "booking_addresses",
          {
            ...ADDRESS,
            address: textOf(ALEX_DRAIN_ADDRESS.address),
            sealed_for_person_id: ALEX,
            state_code: "IL",
            checked_at: "2026-10-19T21:15:40Z",
          },
        ],
      ],
      code: "23514",
      constraint: "booking_addresses_checked_has_address",
    },
    {
      breaks: "a second first address of one booking",
      rows: [["booking_addresses", { ...ADDRESS, position: 1 }]],
      code: "23505",
      constraint: "booking_addresses_position_key",
    },
    {
      breaks: "a link to an unknown page",
      rows: [["secure_links", { ...LINK, purpose: "pay" }]],
      code: "23514",
      constraint: "secure_links_purpose_known",
    },
    {
      breaks: "a link texted to no contact",
      rows: [["secure_links", { ...LINK, handle_id: null }]],
      code: "23514",
      constraint: "secure_links_given_via",
    },
    {
      breaks: "a raw code kept in place of its hash (BP rule 7)",
      rows: [["secure_links", { ...LINK, code_sha256: "k30stand-in-code" }]],
      code: "23514",
      constraint: "secure_links_code_hash_form",
    },
    {
      breaks: "a link ended with no reason",
      rows: [["secure_links", { ...LINK, ended_at: "2026-10-20T12:00:00Z" }]],
      code: "23514",
      constraint: "secure_links_ended",
    },
    {
      breaks: "one code for two links",
      rows: [["secure_links", { ...LINK, code_sha256: textOf(ALEX_DRAIN_LINK.code_sha256) }]],
      code: "23505",
      constraint: "secure_links_code_key",
    },
    {
      breaks: "a link to someone else's contact (Dee's mobile for Alex)",
      rows: [["secure_links", { ...LINK, handle_id: "handle-dee" }]],
      code: "23503",
      constraint: "secure_links_handle_own_fk",
    },
    {
      breaks: "a question answer with no question",
      rows: [["page_answers", { ...ANSWER, kind: "question" }]],
      code: "23514",
      constraint: "page_answers_kind_known",
    },
    {
      breaks: "an answer of an unknown kind",
      rows: [["page_answers", { ...ANSWER, kind: "password" }]],
      code: "23514",
      constraint: "page_answers_kind_known",
    },
    {
      breaks: "an open-ended waitlist time",
      rows: [["waitlist_entries", { ...WAIT, wanted: "[2026-10-24T04:00:00Z,)" }]],
      code: "23514",
      constraint: "waitlist_entries_wanted_bounded",
    },
    {
      breaks: "a waitlist entry ended with no reason",
      rows: [["waitlist_entries", { ...WAIT, ended_at: "2026-10-28T14:00:00Z" }]],
      code: "23514",
      constraint: "waitlist_entries_ended",
    },
    {
      breaks: "a second open waitlist entry of one person and service",
      rows: [
        ["waitlist_entries", WAIT],
        ["waitlist_entries", { ...WAIT, id: "wait-probe-dee-twice" }],
      ],
      code: "23505",
      constraint: "waitlist_entries_one_open",
    },
    {
      breaks: "a waitlist entry for another business's service (Lee Home Services' drain)",
      rows: [["waitlist_entries", { ...WAIT, service_id: "svc-lee-plumbing-drain-clearing" }]],
      code: "23503",
      constraint: "waitlist_entries_service_fk",
    },
    {
      breaks: "a removed line naming another booking's change (Dee's move on Alex's drain)",
      rows: [
        [
          "booking_lines",
          {
            ...ALEX_DRAIN_LINE,
            id: "line-probe-drain-2",
            position: 2,
            state: "removed",
            removed_at: "2026-10-20T12:00:00Z",
            removed_by_change_id: textOf(DEE_MOVE.id),
          },
        ],
      ],
      code: "23503",
      constraint: "booking_lines_removed_by_fk",
    },
    {
      breaks: "a photos line copying another business's option (a barbershop quote's)",
      rows: [
        [
          "quotes",
          {
            ...QUOTE,
            id: "quote-probe-barbershop",
            booking_id: ALEX_HAIRCUT,
            business_id: BARBERSHOP,
            service_id: "svc-lees-haircut",
            price_ok_limit_id: null,
          },
        ],
        [
          "quote_options",
          {
            ...OPTION,
            id: "qopt-probe-barbershop",
            quote_id: "quote-probe-barbershop",
            business_id: BARBERSHOP,
          },
        ],
        ["booking_lines", { ...PHOTOS_LINE, quote_option_id: "qopt-probe-barbershop" }],
      ],
      code: "23503",
      constraint: "booking_lines_quote_option_fk",
    },
  ];

  /** The same rows without a fault: each passes. */
  const PASSES: { shows: string; rows: [string, Values][] }[] = [
    { shows: "a later change of Dee's haircut, naming its own visit", rows: [["booking_changes", CHANGE]] },
    {
      shows:
        "a deadline's call-off with no yes, made by a job (S13-56: nothing moves on silence but a call-off)",
      rows: [
        [
          "booking_changes",
          {
            ...CHANGE,
            kind: "cancelled",
            asked_by: "rosie",
            asked_by_person_id: null,
            approved_by: null,
            turn_id: null,
            job_id: "job-probe-deadline",
          },
        ],
      ],
    },
    { shows: "a quote being priced", rows: [["quotes", QUOTE]] },
    {
      shows: "a quote being priced with two options: a set price, and a range with its own label",
      rows: [
        ["quotes", QUOTE],
        ["quote_options", OPTION],
        [
          "quote_options",
          {
            ...OPTION,
            id: "qopt-probe-water-heater-3",
            position: 2,
            label: "a stand-in option, not from the sources",
            price_cents: 60000,
            up_to_cents: 70000,
          },
        ],
      ],
    },
    { shows: "a waiting ask about the water heater request", rows: [["owner_oks", ASK]] },
    {
      shows: "a request ask beside a quote ask, both waiting",
      rows: [
        ["quotes", QUOTE],
        ["owner_oks", ASK],
        [
          "owner_oks",
          { ...ASK, id: "ok-probe-water-heater-request-2", about: "quote", quote_id: QUOTE.id ?? null },
        ],
      ],
    },
    {
      shows: "no answer at the deadline",
      rows: [["owner_oks", { ...ASK, answer: "no_answer", answered_at: textOf(WATER_HEATER_OK.answer_by) }]],
    },
    { shows: "a second address, the town only", rows: [["booking_addresses", ADDRESS]] },
    {
      shows: "a link given to the customer's own AI, with no contact",
      rows: [["secure_links", { ...LINK, handle_id: null, given_via: "ai" }]],
    },
    { shows: "an entry code (B4-34)", rows: [["page_answers", ANSWER]] },
    { shows: "Dee waiting again, her first entry ended", rows: [["waitlist_entries", WAIT]] },
    {
      shows: "a photos line copying the option Alex picked, with its 25% deposit",
      rows: [["booking_lines", PHOTOS_LINE]],
    },
    {
      shows: "a removed line naming its own booking's change",
      rows: [
        ["booking_changes", DRAIN_CHANGE],
        [
          "booking_lines",
          {
            ...ALEX_DRAIN_LINE,
            id: "line-probe-drain-2",
            position: 2,
            state: "removed",
            removed_at: "2026-10-20T12:00:00Z",
            removed_by_change_id: "change-probe-drain",
          },
        ],
      ],
    },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(ALL_SEEDS);
  }, 120_000);

  /** Inserts each row in order; gives back how many were inserted. */
  const insertAll =
    (rows: [string, Values][]) =>
    async (tx: Tx): Promise<number> => {
      for (const [table, values] of rows) {
        await insertRow(tx, table, values);
      }
      return rows.length;
    };

  for (const probe of PROBES) {
    it(`refused: ${probe.breaks} (${probe.constraint})`, async () => {
      const outcome = await refusal(as(RUNTIME, null, insertAll(probe.rows)));
      expect([outcome.code, outcome.constraint]).toEqual([probe.code, probe.constraint]);
    });
  }

  for (const pass of PASSES) {
    it(`passes: ${pass.shows}`, async () => {
      expect(await as(RUNTIME, null, insertAll(pass.rows))).toBe(pass.rows.length);
    });
  }
});
