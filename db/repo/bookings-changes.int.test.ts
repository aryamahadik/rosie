// T-720: the bookings and changes part (K-30 v1), part 1: booking_details, booking_visits, booking_lines, booking_terms
// and booking_terms_rules, with README rules 1 to 9 as they bear on those five, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/bookings-changes`). The schema comes from migrating a fresh
// test schema.
//
// Part 2 (T-721) makes K-30's other eight tables (quotes, quote_options, owner_oks, booking_changes, booking_addresses,
// secure_links, page_answers, waitlist_entries) and booking_lines' two keys to quote_options and booking_changes (README
// rule 1 makes those tables first). The card's four seeds also write seven rows of those eight tables; this file loads
// every other row of each seed and its after chain, checks that each row it holds back is one of part 2's tables, by
// name and count, and that none of part 1's rows names one, and T-721's test loads the seeds whole.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: C-099's calls, the booking screens' and the owner console's page
// calls) or the runtime side (rosie_job: K-05's commit, the dispatcher, clock firings, the 45-day copy or delete) runs
// in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back. Seed
// fixtures are loaded the same way, as the runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-30 v1's seeds and refused rows and the K-04, K-22, K-23, K-25, K-26,
// K-28 and K-29 seeds their after chains name (Lee's Barbershop, Lee Home Services, the yoga studio and the master's
// sample cast: Sam, Alex M., Riley, Avery, Jordan, Dee; B3-08's Tessa). A row made here is a fixture row under a new
// id, or with one fault. The fixtures' sealed codes are stand-in bytes; the sealing check seals stand-in strings under
// a wrapping key of random bytes made here and never written to a file.
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
/** Part 1's five tables (the card's), in code-unit order (as PostgreSQL orders a relation's name). */
const OWN_TABLES = [
  "booking_details",
  "booking_lines",
  "booking_terms",
  "booking_terms_rules",
  "booking_visits",
];
/** The three of them that are versioned (README rule 4); the snapshot's two are only inserted. */
const VERSIONED = ["booking_details", "booking_lines", "booking_visits"];
/** K-30's other eight tables, part 2's (T-721), in code-unit order. */
const PART_2_TABLES = [
  "booking_addresses",
  "booking_changes",
  "owner_oks",
  "page_answers",
  "quote_options",
  "quotes",
  "secure_links",
  "waitlist_entries",
];
/** booking_lines' two keys to part 2's tables (README rule 1 makes those tables first): part 2 adds them. */
const PART_2_KEYS = ["booking_lines_quote_option_fk", "booking_lines_removed_by_fk"];
/** The four seeds the card's proof loads. */
const CARD_SEEDS = [
  "seed-booking-flow-a.json",
  "seed-booking-flow-b.json",
  "seed-booking-line-price-copied.json",
  "seed-terms-snapshot.json",
];
/** The fifth seed, a quote with the owner's OK: its own table is part 2's, so T-721's proof loads it. */
const QUOTE_SEED = "seed-quote-owner-ok.json";
/** The refused fixtures on part 1's tables: the card's and the four beyond it. */
const REFUSED_HERE = [
  "invalid/refuse-booking-line-price-change.json",
  "invalid/refuse-booking-value-reset.json",
  "invalid/refuse-cross-business-booking-read.json",
  "invalid/refuse-line-on-other-business-booking.json",
  "invalid/refuse-terms-snapshot-update.json",
];
/** The refused fixtures on part 2's tables (T-721's). */
const REFUSED_PART_2 = [
  "invalid/refuse-change-row-update.json",
  "invalid/refuse-link-code-read.json",
  "invalid/refuse-owner-ok-without-who.json",
];
/**
 * The other tables the five refer to by their keys (README rule 1), in code-unit order: other parts', and part 2's
 * booking_changes and quote_options, which booking_lines' two keys name (migration 0029, T-721; DL-225, DL-278).
 */
const REFERRED = [
  "booking_changes",
  "bookings",
  "businesses",
  "consents",
  "persons",
  "price_ok_limits",
  "price_rules",
  "quote_options",
  "reservations",
  "rules",
  "service_money",
  "services",
];
/** The only sealed column of the five (README rule 7), bytea under its row's code_for_person_id. */
const SEALED = ["booking_visits.check_in_code"];
/** The columns rule 6 lets either role update, by table; any other column of these two is written once. */
const COLUMN_UPDATES: Record<string, readonly string[]> = {
  booking_lines: ["state", "removed_at", "removed_by_change_id", "version"],
  booking_visits: ["reservation_id", "arrival_window", "cutoff_at", "version"],
};
/** Tessa's B3-08 booking at Lee Home Services (K-28's seed), whose person has no sealing key in any seed. */
const TESSA_SEED = "../../customers/fixtures/seed-customer-business-added.json";
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
  columns: { name: string; type: string; null: boolean; default?: string; sealedBy?: string }[];
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
/** Part 1's tables as the table list gives them. */
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

/** Every part 1 row of the card's four seeds and their chains, in load order. */
const SEED_ROWS = rowsOf(CARD_SEEDS).filter((row) => OWN_TABLES.includes(row.table));

/** Alex M.'s haircut at Lee's Barbershop (flow A): the details, the visit, the line and the snapshot. */
const ALEX_HAIRCUT = "booking-alex-haircut";
const ALEX_HAIRCUT_DETAILS = valuesOf(
  "seed-booking-flow-a.json",
  "booking_details",
  ALEX_HAIRCUT,
  "booking_id",
);
const ALEX_HAIRCUT_VISIT = valuesOf("seed-booking-flow-a.json", "booking_visits", "visit-alex-haircut-1");
const ALEX_HAIRCUT_LINE = valuesOf("seed-booking-flow-a.json", "booking_lines", "line-alex-haircut-1");
const ALEX_HAIRCUT_TERMS = valuesOf("seed-booking-flow-a.json", "booking_terms", ALEX_HAIRCUT, "booking_id");
/** Alex M.'s kitchen drain at home with Lee Home Services (flow B), and its address row (part 2's: its zone). */
const ALEX_DRAIN = "booking-alex-drain";
const ALEX_DRAIN_VISIT = valuesOf("seed-booking-flow-b.json", "booking_visits", "visit-alex-drain-1");
const ALEX_DRAIN_ADDRESS = valuesOf("seed-booking-flow-b.json", "booking_addresses", "addr-alex-drain-1");
/** Dee's haircut with Avery, copied at $35 before Sam's raise, and moved before free cancel ended. */
const DEE_HAIRCUT = "booking-dee-haircut";
const DEE_HAIRCUT_LINE = valuesOf(
  "seed-booking-line-price-copied.json",
  "booking_lines",
  "line-dee-haircut-1",
);
const DEE_HAIRCUT_VISIT = valuesOf(
  "seed-booking-line-price-copied.json",
  "booking_visits",
  "visit-dee-haircut-1",
);
const DEE_MOVE = valuesOf(
  "seed-booking-line-price-copied.json",
  "booking_changes",
  "change-dee-haircut-moved",
);
/** Dee's skin fade, booked from the waitlist, and the waitlist request that ended there. */
const DEE_SKIN_FADE = "booking-dee-skin-fade";
const DEE_SKIN_FADE_TERMS = valuesOf(
  "seed-terms-snapshot.json",
  "booking_terms",
  DEE_SKIN_FADE,
  "booking_id",
);
const DEE_WAITLIST = "booking-dee-waitlist";
/** The barbershop's line on Lee Home Services' drain: refuse-line-on-other-business-booking without its scope. */
const LINE_ON_DRAIN = refusedOf("invalid/refuse-line-on-other-business-booking.json").values ?? {};
/** The same barbershop line on the barbershop's own booking, Alex's haircut: that fixture without its one fault. */
const SECOND_HAIRCUT_LINE: Values = {
  ...LINE_ON_DRAIN,
  id: "line-probe-alex-haircut-2",
  booking_id: ALEX_HAIRCUT,
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

/** Updates the rows of `table` that `where` names, setting `set` exactly, and gives them back as stored. */
function updateWhere(
  table: string,
  where: Values,
  set: Values,
): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) =>
    tx<Record<string, unknown>[]>`
      update ${tx(table)} set ${tx(columnValues(tx, table, set))} where ${whereOf(tx, where)} returning *
    `;
}

/** The primary key of a row of one of the five, from its values. */
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

interface Loaded {
  /** Rows inserted, per table. */
  loaded: Record<string, number>;
  /** Rows of part 2's tables held back for T-721, per table. */
  held: Record<string, number>;
}

/**
 * Loads fixture files with their `after` chains, each file once, as the runtime side, and commits: every row but those
 * of part 2's tables (T-721's), which this schema does not have yet and which are counted instead. A row of K-26's
 * registries is never inserted (only a migration's seed writes a registry, K-26 README rule 5): it is found as the
 * migration wrote it, as rules.int.test.ts finds it.
 */
async function loadFixtures(files: readonly string[]): Promise<Loaded> {
  const rows = rowsOf(files);
  for (const row of rows.filter((candidate) => REGISTRIES.includes(candidate.table))) {
    await expectFound(row);
  }
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    const held: Record<string, number> = {};
    for (const row of rows.filter((candidate) => !REGISTRIES.includes(candidate.table))) {
      if (PART_2_TABLES.includes(row.table)) {
        held[row.table] = (held[row.table] ?? 0) + 1;
        continue;
      }
      await insertRow(tx, row.table, row.values);
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return { loaded, held };
  });
}

/**
 * Every column the fixture gives is stored as given, read back as the owner by the table's primary key and compared on
 * the server in the column's own type (an instant or a range as PostgreSQL reads both; bytes and text exactly).
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

/** Rows each of the five shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the five whose business_id is `businessId`, read as the owner. */
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

beforeAll(async () => {
  db = await createTestDatabase({ name: "bookings_changes" });
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

describe("the migration against the frozen table list (K-30 v1): part 1's five tables", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
    time: "time without time zone",
  };

  it("the table list names 13 tables, each scoped by business on business_id with no effective dates; part 1 makes the card's five, and part 2's eight are migration 0029's (T-721)", async () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual([...OWN_TABLES, ...PART_2_TABLES].sort());
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
    const found = await db.sql<{ name: string; part: string }[]>`
      select c.relname as name, case when c.relname in ${db.sql(OWN_TABLES)} then 'one' else 'two' end as part
      from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql([...OWN_TABLES, ...PART_2_TABLES])}
      order by 1
    `;
    // DL-225 (T-721, DL-278): the list gains part 2's eight, made by migration 0029, and stays exact.
    expect(found).toEqual(
      [...OWN_TABLES, ...PART_2_TABLES]
        .sort()
        .map((name) => ({ name, part: OWN_TABLES.includes(name) ? "one" : "two" })),
    );
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete (part 2's two among them, migration 0029's), unique rules and index names are the table list's`, async () => {
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
      // DL-225 (T-721, DL-278): booking_lines' list gains part 2's two keys, which migration 0029 adds, and stays exact.
      const keys = table.foreignKeys;
      const unique = table.unique ?? [];
      // No unique rule of the five has a where: each is a constraint row.
      expect(unique.filter((rule) => rule.where !== undefined)).toEqual([]);
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(keys.map((key) => key.name).sort());
      expect(named("u")).toEqual(unique.map((rule) => rule.name).sort());
      expect(named("x")).toEqual([]);
      for (const key of keys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.map(ident).join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.map(ident).join(", ")}) ON DELETE ${key.onDelete.toUpperCase()}`,
        );
      }
      // PostgreSQL quotes a keyword it prints as a column name (position, in two unique rules).
      for (const rule of unique) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.map(ident).join(", ")})`,
        );
      }
      const indexes = await db.sql<{ name: string }[]>`
        select c.relname as name from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...unique.map((rule) => rule.name),
          ...(table.indexes ?? []).map((index) => index.name),
        ].sort(),
      );
    });

    it(`${table.name}: each check and each index is the table list's own expression, as PostgreSQL reads both`, async () => {
      // The table list's expressions, built on a temporary table with the same columns, then printed by PostgreSQL
      // the same way as the migration's: equal text means the same rule, word for word after PostgreSQL's reading.
      const checks = table.checks ?? [];
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
        return definitionsOf(tx, "probe");
      });
      expect(Object.keys(listed.checks).sort()).toEqual(checks.map((check) => check.name).sort());
      expect(Object.keys(listed.indexes).sort()).toEqual(
        (table.indexes ?? []).map((index) => index.name).sort(),
      );
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      // A unique rule's own index is checked above by name and columns; the named indexes here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

  it("booking_lines holds all seven of its foreign keys: booking_lines_quote_option_fk and booking_lines_removed_by_fk name part 2's quote_options and booking_changes, which rule 1 makes before them, so part 2 adds them (migration 0029); no seed row of part 1 names either column", async () => {
    const lines = tableOf("booking_lines");
    expect(
      lines.foreignKeys
        .filter((key) => PART_2_KEYS.includes(key.name))
        .map((key) => [key.name, key.columns, key.references.table, key.references.columns, key.onDelete]),
    ).toEqual([
      [
        "booking_lines_quote_option_fk",
        ["quote_option_id", "business_id"],
        "quote_options",
        ["id", "business_id"],
        "restrict",
      ],
      [
        "booking_lines_removed_by_fk",
        ["removed_by_change_id", "booking_id"],
        "booking_changes",
        ["id", "booking_id"],
        "restrict",
      ],
    ]);
    // Every other key of the five names a table this schema has.
    const elsewhere = OWN.flatMap((table) =>
      table.foreignKeys.filter((key) => !PART_2_KEYS.includes(key.name)).map((key) => key.references.table),
    );
    expect(elsewhere.filter((name) => PART_2_TABLES.includes(name))).toEqual([]);
    const held = await db.sql<{ name: string }[]>`
      select conname as name from pg_constraint where conname in ${db.sql(PART_2_KEYS)}
        and connamespace = ${db.schema}::regnamespace
    `;
    // DL-225 (T-721, DL-278): the list gains the two keys migration 0029 adds, and stays exact.
    expect(held.map((key) => key.name).sort()).toEqual(PART_2_KEYS);
    for (const row of SEED_ROWS.filter((candidate) => candidate.table === "booking_lines")) {
      expect([row.values.quote_option_id, row.values.removed_by_change_id], textOf(row.values.id)).toEqual([
        null,
        null,
      ]);
    }
  });

  it("the five refer only to other tables by their keys (rule 1): K-04's bookings, businesses, persons and reservations, K-25's services, service_money and price_rules, K-26's rules and price_ok_limits, K-29's consents, and part 2's booking_changes and quote_options (booking_lines' two keys, migration 0029's); a terms rule names its snapshot; of every other table only part 2's booking_changes refers to these (a change names its visit)", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    // DL-225 (T-721, DL-278): the list gains booking_lines' two keys to part 2's tables, and stays exact.
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      OWN.flatMap((table) =>
        table.foreignKeys.map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
    expect(keys.filter((key) => OWN_TABLES.includes(key.referenced)).map((key) => key.name)).toEqual([
      "booking_terms_rules_terms_fk",
    ]);
    const into = await db.sql<{ table: string }[]>`
      select src.relname as table from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
      order by 1
    `;
    // DL-225 (T-721, DL-278): the list gains part 2's booking_changes (booking_changes_visit_fk), and stays exact.
    // DL-225 (T-722, DL-297): it gains K-32's payment_items and refunds (payment_items_line_fk, refunds_line_fk, to
    // booking_lines; 0030), ordered by name now that it holds more than one, and stays exact.
    // DL-225 (T-723, DL-306): it gains K-32 part 2's booking_fees and rosfield_fees (booking_fees_visit_fk,
    // rosfield_fees_visit_fk, to booking_visits) and credits (credits_line_fk, to booking_lines; 0031), and stays exact.
    expect(into).toEqual([
      { table: "booking_changes" },
      { table: "booking_fees" },
      { table: "credits" },
      { table: "payment_items" },
      { table: "refunds" },
      { table: "rosfield_fees" },
    ]);
  });

  it("each versioned table raises its version on every update (0002's rule; rule 4): <table>_version_raised, BEFORE UPDATE FOR EACH ROW; booking_details also holds rule 6's booking_details_set_once; the snapshot's two tables hold no trigger", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual([
      ["booking_details", "booking_details_set_once"],
      ["booking_details", "booking_details_version_raised"],
      ["booking_lines", "booking_lines_version_raised"],
      ["booking_visits", "booking_visits_version_raised"],
    ]);
    for (const trigger of triggers) {
      const fn = trigger.name.endsWith("_version_raised")
        ? "enforce_version_raise"
        : "booking_details_set_once";
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(`FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    }
  });

  it("rule 6's function booking_details_set_once() is the part's only function: plpgsql, security invoker (it runs as the calling role), owned by the migrations' role, with the README's body: the listed columns, the message and SQLSTATE 23514 under the constraint's name", async () => {
    const functions = await db.sql<
      {
        name: string;
        language: string;
        definer: boolean;
        owner: string;
        me: string;
        config: string[] | null;
        body: string;
      }[]
    >`
      select p.proname as name, l.lanname as language, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             current_user as me, p.proconfig as config, p.prosrc as body
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = ${db.schema}::regnamespace and (p.proname like 'booking%' or p.proname like '%set_once%')
      order by p.proname
    `;
    // DL-225 (T-722, DL-297): the list gains K-32's money_set_once() (0030, the money part's own, by its README rule 7),
    // ordered by name so this part's function stays first, and stays exact.
    expect(functions.map((fn) => [fn.name, fn.language, fn.definer, fn.owner === fn.me, fn.config])).toEqual([
      ["booking_details_set_once", "plpgsql", false, true, null],
      ["money_set_once", "plpgsql", false, true, null],
    ]);
    const body = oneLine(functions[0]?.body);
    for (const column of ["booking_id", "business_id", "number", "door", "made_by"]) {
      expect(body, column).toContain(`new.${column} is distinct from old.${column}`);
    }
    for (const column of [
      "approval",
      "timing",
      "times",
      "taken",
      "first_link_given_at",
      "staff_told_at",
      "request_ended_at",
      "request_ended_why",
    ]) {
      expect(body, column).toContain(
        `(old.${column} is not null and new.${column} is distinct from old.${column})`,
      );
    }
    for (const column of ["need_by", "meets_pro", "meets_pro_person_id", "upset_count", "version"]) {
      expect(body, column).not.toContain(`.${column} `);
    }
    expect(body).toContain(
      "raise exception 'a booking value is set once and never changed (FS line 752)' using errcode = 'check_violation', constraint = 'booking_details_set_once'; end if; return new;",
    );
  });

  it("there is no first_sms_at column anywhere in the schema (MC C9: no first-contact SMS); FS line 729's field is booking_details.first_link_given_at, an instant (Q-33)", async () => {
    const named = await db.sql<{ key: string }[]>`
      select c.relname || '.' || a.attname as key from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = ${db.schema}::regnamespace and a.attnum > 0 and not a.attisdropped
        and a.attname in ('first_sms_at', 'first_link_given_at')
    `;
    expect(named.map((row) => row.key)).toEqual(["booking_details.first_link_given_at"]);
    expect(typeOf.get("booking_details.first_link_given_at")).toBe("timestamp with time zone");
    expect(TABLES.flatMap((table) => table.columns.map((column) => column.name))).not.toContain(
      "first_sms_at",
    );
  });

  it("the check-in code is the visit's (A6-14: new for this visit): booking_visits.check_in_code is the only bytea of the five, sealed by its row's code_for_person_id, with no index on it; no other table of the five holds a code", async () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(OWN.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own
        .filter(([, type]) => type === "bytea")
        .map(([key]) => key)
        .sort(),
    ).toEqual(SEALED);
    expect(
      OWN.flatMap((table) =>
        table.columns
          .filter((column) => column.sealedBy !== undefined)
          .map((column) => `${table.name}.${column.name} ${column.sealedBy ?? ""}`),
      ),
    ).toEqual(SEALED.map((key) => `${key} code_for_person_id`));
    expect(
      own
        .filter(([key]) => (key.split(".")[1] ?? "").includes("code"))
        .map(([key]) => key)
        .sort(),
    ).toEqual(["booking_visits.check_in_code", "booking_visits.code_for_person_id"]);
    const indexed = await db.sql<{ name: string; columns: string[] }[]>`
      select c.relname as name,
             array(select a.attname::text from unnest(i.indkey) as k(n)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) as columns
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = ${`${db.schema}.booking_visits`}::regclass
    `;
    expect(indexed.filter((index) => index.columns.includes("check_in_code"))).toEqual([]);
  });

  it("ids are text, every instant is timestamptz and the arrival window a tstzrange, need_by is a day, and every amount is bigint minor units beside a three-letter currency (rules 3 and 9)", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(
      own.filter(([key]) => key.endsWith(".id") || key.endsWith("_id")).every(([, type]) => type === "text"),
    ).toBe(true);
    expect(own.filter(([key]) => key.endsWith("_at")).map(([key, type]) => `${key} ${type}`)).toEqual(
      own
        .filter(([key]) => key.endsWith("_at"))
        .map(
          ([key]) =>
            `${key} ${key === "booking_terms.cutoff_day_before_at" ? "time without time zone" : "timestamp with time zone"}`,
        ),
    );
    expect(
      own
        .filter(([, type]) => ["date", "time without time zone", "tstzrange", "interval"].includes(type))
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual([
      "booking_details.need_by date",
      "booking_terms.cutoff_before interval",
      "booking_terms.cutoff_day_before_at time without time zone",
      "booking_visits.arrival_window tstzrange",
    ]);
    expect(own.filter(([, type]) => type === "timestamp without time zone")).toEqual([]);
    expect(
      own
        .filter(([key]) => key.endsWith("_cents"))
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual(
      ["deposit_cents", "fee_cents", "from_cents", "price_cents", "up_to_cents"].map(
        (column) => `booking_lines.${column} bigint`,
      ),
    );
    expect(typeOf.get("booking_lines.currency")).toBe("text");
  });

  it("neither role owns a table or the function: they stay the migrations' role's", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = 'booking_details_set_once'
      order by 1
    `;
    expect(owners.map((row) => row.name)).toEqual([
      ...OWN_TABLES.slice(0, 1),
      "booking_details_set_once",
      ...OWN_TABLES.slice(1),
    ]);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });

  it("is recorded in schema_migrations as bookings_changes_details, after core_rls, consent, services_prices, rules and customers", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("bookings_changes_details");
    for (const before of ["core_rls", "consent", "services_prices", "rules", "customers"]) {
      expect(names.indexOf("bookings_changes_details"), before).toBeGreaterThan(names.indexOf(before));
    }
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

  it("row-level security is on for all five, and forced on none", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
  });

  it("each holds 0012's <table>_runtime for rosie_job word for word (read from outbox_rows', which keys on the same column) and one Tool API policy per command its grants allow: _select reads only its scope (0012's Tool API expression), _insert, and _update where an update is granted, add rule 5's exists clause on the new row; none for delete", async () => {
    const policies = await policiesOf([...OWN_TABLES, "outbox_rows"]);
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    const coreRuntime = core.find((policy) => policy.name === "outbox_rows_runtime");
    const coreToolApi = core.find((policy) => policy.name === "outbox_rows_tool_api");
    expect(coreToolApi?.using).toBe(coreToolApi?.check);
    const scope = coreToolApi?.using ?? "";
    expect(scope).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
    for (const table of OWN_TABLES) {
      const updated = table === "booking_details" || table in COLUMN_UPDATES;
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
  });

  it("table grants (DL-149, each to its named reader: the migration's header; rule 6): both roles select and insert all five, the same for each; booking_details also takes UPDATE as a table grant; no delete, truncate, references or trigger; nothing to PUBLIC or any other grantee", async () => {
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
          [...["INSERT", "SELECT"], ...(table === "booking_details" ? ["UPDATE"] : [])].map(
            (privilege) => `${role} ${table} ${privilege}`,
          ),
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

  it("column grants (rule 6): both roles' UPDATE of booking_lines' state, removed_at, removed_by_change_id and version and of booking_visits' reservation_id, arrival_window, cutoff_at and version only, every grantee on the five held to exactly them; has_column_privilege agrees, column by column", async () => {
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
      Object.entries(COLUMN_UPDATES)
        .flatMap(([table, columns]) =>
          columns.flatMap((column) =>
            ROLES.map((grantee) => key({ table, column, grantee, privilege: "UPDATE" })),
          ),
        )
        .sort(),
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
      const columns =
        table === "booking_details"
          ? tableOf(table).columns.map((column) => column.name)
          : (COLUMN_UPDATES[table] ?? []);
      const ordered = tableOf(table)
        .columns.map((column) => column.name)
        .filter((column) => columns.includes(column));
      expect(updatable, table).toEqual(ROLES.flatMap((role) => ordered.map((column) => ({ role, column }))));
    }
  });
});

describe("the seed fixtures load (fixtures/index.json): the card's four, with every row of part 1's tables", () => {
  /** The part 1 rows the card's four seeds give together, per table (README "Checked on", less the quote seed's). */
  const SEEDED = {
    booking_details: 5,
    booking_lines: 4,
    booking_terms: 4,
    booking_terms_rules: 13,
    booking_visits: 4,
  };
  /** The rows of part 2's tables each seed gives with its after chain, which T-721's test loads. */
  const HELD: Record<string, Record<string, number>> = {
    "seed-booking-flow-a.json": { owner_oks: 1 },
    "seed-booking-flow-b.json": { booking_addresses: 1, page_answers: 2, secure_links: 1 },
    "seed-booking-line-price-copied.json": { booking_changes: 1, waitlist_entries: 1 },
    "seed-terms-snapshot.json": { waitlist_entries: 1 },
  };

  it("the index lists five seeds (the card's four and the quote's, whose own table is part 2's) and eight refused rows (five on part 1's tables, three on part 2's), all K-30 v1", () => {
    expect([...SEEDS].sort()).toEqual([...CARD_SEEDS, QUOTE_SEED].sort());
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([...REFUSED_HERE, ...REFUSED_PART_2].sort());
    expect(INDEX.every((entry) => entry.version === "v1")).toBe(true);
    expect(
      INDEX.filter((entry) => OWN_TABLES.includes(entry.table))
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([...CARD_SEEDS, ...REFUSED_HERE].sort());
    expect(INDEX.find((entry) => entry.file === QUOTE_SEED)?.table).toBe("quotes");
  });

  for (const file of CARD_SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side: every row of part 1's tables (and of every other part's) is stored as given, and only its rows of part 2's tables are held for T-721`,
      SLOW,
      async () => {
        await reset();
        const chain = rowsOf([file]);
        const { loaded, held } = await loadFixtures([file]);
        expect(held, file).toEqual(HELD[file]);
        expect(Object.keys(held).every((table) => PART_2_TABLES.includes(table))).toBe(true);
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

  it(
    "all four insert together, each after chain once: 5 details, 4 visits, 4 lines, 4 snapshots naming 13 rules in force, every one stored as given; the 7 rows of part 2's tables are held",
    SLOW,
    async () => {
      await reset();
      const { loaded, held } = await loadFixtures(CARD_SEEDS);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
      expect(countsOf(SEED_ROWS, OWN_TABLES)).toEqual(SEEDED);
      for (const row of SEED_ROWS) {
        await expectStored(row);
      }
      expect(held).toEqual({
        booking_addresses: 1,
        booking_changes: 1,
        owner_oks: 1,
        page_answers: 2,
        secure_links: 1,
        waitlist_entries: 1,
      });
    },
  );
});

describe("the seeded rows, read back (the card's four seeds)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  it("flow A (list|card|counter): Alex M.'s haircut at Lee's Barbershop through Alex's own AI, a request Sam OK'd: its details, its one visit naming K-04's reservation at Sat Oct 24 11:00am with free cancel until Fri 11:00am (24 hours before, as its snapshot's rule says), and the $35 line with the $20 fee copied from the rule and the way", async () => {
    const [details] = await db.sql<Record<string, unknown>[]>`
      select number, door, made_by, approval, timing, times, taken, meets_pro, upset_count, version
      from booking_details where booking_id = ${ALEX_HAIRCUT}
    `;
    expect(details).toEqual({
      number: "LB1024",
      door: "ai",
      made_by: "customer",
      approval: "ownerok",
      timing: "settime",
      times: "setstart",
      taken: "asked",
      meets_pro: null,
      upset_count: 0,
      version: ALEX_HAIRCUT_DETAILS.version,
    });
    const [visit] = await db.sql<Record<string, unknown>[]>`
      select v.position, v.reservation_id as reservation, r.booking_id = v.booking_id as "reservationOfBooking",
             to_char(lower(r.during) at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as starts,
             to_char(v.cutoff_at at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as "freeCancelUntil",
             v.cutoff_at = lower(r.during) - t.cutoff_before as "fromTheSnapshotsRule",
             v.arrival_window as window, v.code_for_person_id as "codeFor", v.check_in_code is not null as sealed
      from booking_visits v
        join reservations r on r.id = v.reservation_id
        join businesses z on z.id = v.business_id
        join booking_terms t on t.booking_id = v.booking_id
      where v.id = ${textOf(ALEX_HAIRCUT_VISIT.id)}
    `;
    expect(visit).toEqual({
      position: 1,
      reservation: "rsv-alex-haircut",
      reservationOfBooking: true,
      starts: "11:00am Sat Oct 24",
      freeCancelUntil: "11:00am Fri Oct 23",
      fromTheSnapshotsRule: true,
      window: null,
      codeFor: ALEX,
      sealed: true,
    });
    const [line] = await db.sql<Record<string, unknown>[]>`
      select l.path, l.price_kind, l.units, l.price_cents, l.fee_cents, l.currency, l.paid_by, l.state,
             l.price_cents = p.price_cents * l.units as "theRulesPrice", l.fee_cents = m.fee_cents as "theWaysFee",
             l.path = m.path as "theWaysPath", l.price_kind = s.price_kind as "theServicesKind"
      from booking_lines l
        join price_rules p on p.id = l.price_rule_id
        join service_money m on m.id = l.service_money_id
        join services s on s.id = l.service_id
      where l.id = ${textOf(ALEX_HAIRCUT_LINE.id)}
    `;
    expect(line).toEqual({
      path: "list|card|counter",
      price_kind: "one_price",
      units: 1,
      price_cents: "3500",
      fee_cents: "2000",
      currency: "USD",
      paid_by: "money",
      state: "open",
      theRulesPrice: true,
      theWaysFee: true,
      theWaysPath: true,
      theServicesKind: true,
    });
  });

  it("flow B (list|card|bill): Alex M.'s kitchen drain at home with Jordan, Thu Oct 22: the visit's reservation holds 8:00 to 11:00am while its arrival window reads 8:00 to 10:00am in the visit's zone (its address's), free cancel until 7:00am from the way's own 1-hour rule, and the $179 line with the $89 fee", async () => {
    const zone = textOf(ALEX_DRAIN_ADDRESS.zone);
    const [visit] = await db.sql<Record<string, unknown>[]>`
      select to_char(lower(r.during) at time zone ${zone}, 'FMHH12:MIam') || ' to ' ||
               to_char(upper(r.during) at time zone ${zone}, 'FMHH12:MIam Dy Mon FMDD') as reserved,
             to_char(lower(v.arrival_window) at time zone ${zone}, 'FMHH12:MIam') || ' to ' ||
               to_char(upper(v.arrival_window) at time zone ${zone}, 'FMHH12:MIam Dy Mon FMDD') as window,
             r.during @> v.arrival_window as "windowInsideReserved",
             to_char(v.cutoff_at at time zone ${zone}, 'FMHH12:MIam Dy Mon FMDD') as "freeCancelUntil",
             t.cutoff_before = m.cutoff_before as "theWaysOwnRule",
             v.cutoff_at = lower(r.during) - t.cutoff_before as "fromTheSnapshotsRule",
             d.meets_pro as "meetsPro", v.code_for_person_id as "codeFor"
      from booking_visits v
        join reservations r on r.id = v.reservation_id
        join booking_terms t on t.booking_id = v.booking_id
        join booking_details d on d.booking_id = v.booking_id
        join booking_lines l on l.booking_id = v.booking_id
        join service_money m on m.id = l.service_money_id
      where v.id = ${textOf(ALEX_DRAIN_VISIT.id)}
    `;
    expect(visit).toEqual({
      reserved: "8:00am to 11:00am Thu Oct 22",
      window: "8:00am to 10:00am Thu Oct 22",
      windowInsideReserved: true,
      freeCancelUntil: "7:00am Thu Oct 22",
      theWaysOwnRule: true,
      fromTheSnapshotsRule: true,
      meetsPro: "served",
      codeFor: ALEX,
    });
    const lines = await db.sql<Record<string, unknown>[]>`
      select path, price_cents, fee_cents, currency from booking_lines where booking_id = ${ALEX_DRAIN}
    `;
    expect(lines).toEqual([
      { path: "list|card|bill", price_cents: "17900", fee_cents: "8900", currency: "USD" },
    ]);
  });

  it("a booking keeps the price it was made with (RULES 3.7; S11-54): after Sam's raise the list prices Dee's Nov 7 visit at $40, while her line, copied on Fri Oct 23 while the $35 rule was open, keeps $35 and the $20 fee", async () => {
    const [prices] = await db.sql<Record<string, unknown>[]>`
      select l.price_cents as copied,
             (select p.price_cents from price_rules p
               where p.service_id = l.service_id and p.service_money_id is null and p.worker_resource_id is null
                 and p.effective_from <= lower(r.during) and (p.effective_to is null or p.effective_to > lower(r.during))
             ) as "listNow",
             (select p.price_cents from price_rules p
               where p.service_id = l.service_id and p.service_money_id is null and p.worker_resource_id is null
                 and p.effective_from <= t.written_at and (p.effective_to is null or p.effective_to > t.written_at)
             ) as "listWhenCopied",
             l.price_rule_id as rule, l.fee_cents as fee, l.version
      from booking_lines l
        join booking_visits v on v.booking_id = l.booking_id
        join reservations r on r.id = v.reservation_id
        join booking_terms t on t.booking_id = l.booking_id
      where l.id = ${textOf(DEE_HAIRCUT_LINE.id)}
    `;
    expect(prices).toEqual({
      copied: "3500",
      listNow: "4000",
      listWhenCopied: "3500",
      rule: "price-lees-haircut-35",
      fee: "2000",
      version: 1,
    });
  });

  it("Dee's move on Wed Oct 28, before free cancel (its change row is part 2's): her visit points at the new 11:00am reservation, its free-cancel time moved with it, its version raised once, and its code as written; the line is untouched", async () => {
    const [visit] = await db.sql<Record<string, unknown>[]>`
      select v.reservation_id as reservation, v.cutoff_at = lower(r.during) - t.cutoff_before as "movedWithIt",
             to_char(lower(r.during) at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as starts,
             v.version, v.check_in_code = ${fromHex(textOf(DEE_HAIRCUT_VISIT.check_in_code).replace(/^\\x/, ""))} as "codeAsWritten"
      from booking_visits v
        join reservations r on r.id = v.reservation_id
        join booking_terms t on t.booking_id = v.booking_id
        join businesses z on z.id = v.business_id
      where v.id = ${textOf(DEE_HAIRCUT_VISIT.id)}
    `;
    const newValues = DEE_MOVE.new_values as Values;
    expect(visit).toEqual({
      reservation: textOf(newValues.reservation_id),
      movedWithIt: true,
      starts: "11:00am Sat Nov 7",
      version: 2,
      codeAsWritten: true,
    });
    const [line] = await db.sql<{ state: string; version: number }[]>`
      select state, version from booking_lines where id = ${textOf(DEE_HAIRCUT_LINE.id)}
    `;
    expect(line).toEqual({ state: "open", version: 1 });
  });

  it("the terms snapshot copies what was in force when the booking was written, and nothing later: Dee's skin fade keeps its way's own 2-hour cancel rule (Alex's haircut, whose way has none, K-23's 24 hours), and names exactly the barbershop's K-26 rows in force at written_at, not the no-show count Sam turned on from Oct 28", async () => {
    const [rule] = await db.sql<Record<string, unknown>[]>`
      select t.cutoff_before::text as "skinFade", m.cutoff_before::text as "skinFadeWay",
             (select h.cutoff_before::text from booking_terms h where h.booking_id = ${ALEX_HAIRCUT}) as haircut,
             (select hm.cutoff_before is null from service_money hm where hm.id = 'way-lees-haircut-shop') as "haircutWayHasNone"
      from booking_terms t
        join booking_lines l on l.booking_id = t.booking_id
        join service_money m on m.id = l.service_money_id
      where t.booking_id = ${DEE_SKIN_FADE}
    `;
    expect(rule).toEqual({
      skinFade: "02:00:00",
      skinFadeWay: "02:00:00",
      haircut: "24:00:00",
      haircutWayHasNone: true,
    });
    expect(DEE_SKIN_FADE_TERMS.cutoff_before).toBe("2 hours");
    const snapshots = await db.sql<{ booking: string; named: string[]; inForce: string[] }[]>`
      select t.booking_id as booking,
             array(
               select coalesce(r.rule_id, r.price_ok_limit_id) from booking_terms_rules r
               where r.booking_id = t.booking_id order by 1
             ) as named,
             array(
               select x.id from (
                 select k.id, k.flow, k.kind_id, k.effective_from, k.effective_to from rules k
                 where k.business_id = t.business_id
                 union all
                 select o.id, o.flow, o.kind_id, o.effective_from, o.effective_to from price_ok_limits o
                 where o.business_id = t.business_id
               ) x
               where x.effective_from <= t.written_at and (x.effective_to is null or x.effective_to > t.written_at)
                 and (x.flow is null or x.flow = g.flow)
                 and (x.kind_id is null or x.kind_id in (
                   select s.kind_id from booking_lines l join services s on s.id = l.service_id
                   where l.booking_id = t.booking_id
                 ))
               order by 1
             ) as "inForce"
      from booking_terms t join bookings g on g.id = t.booking_id
      order by 1
    `;
    expect(snapshots.map((snapshot) => snapshot.booking)).toEqual(
      [ALEX_DRAIN, ALEX_HAIRCUT, DEE_HAIRCUT, DEE_SKIN_FADE].sort(),
    );
    for (const snapshot of snapshots) {
      expect(snapshot.named, snapshot.booking).toEqual(snapshot.inForce);
    }
    expect(snapshots.find((snapshot) => snapshot.booking === DEE_SKIN_FADE)?.named).toEqual([
      "pok-lees-barbershop-quotes",
      "rule-lees-barbershop-note-kids-cut",
      "rule-lees-barbershop-ok-new-customer",
      "rule-lees-barbershop-ok-same-day",
    ]);
    const [noShow] = await db.sql<{ inForceNow: boolean; named: number }[]>`
      select effective_from <= now() as "inForceNow",
             (select count(*)::int from booking_terms_rules where rule_id = 'rule-lees-barbershop-no-show-count') as named
      from rules where id = 'rule-lees-barbershop-no-show-count'
    `;
    expect(noShow).toEqual({ inForceNow: true, named: 0 });
  });

  it("each snapshot names, never copies, the words its customer ticked (rule 7; A5-07): K-29's ticked_terms consent row for the same booking, by its person served, whose sha256 matches its words; the version and language are the checked text's", async () => {
    const terms = await db.sql<Record<string, unknown>[]>`
      select t.booking_id as booking, k.kind, k.booking_id = t.booking_id as "sameBooking",
             k.person_id = g.served_person_id as "personServed", k.business_id = t.business_id as "sameBusiness",
             k.words_sha256 = encode(sha256(convert_to(k.exact_words, 'UTF8')), 'hex') as "hashOfWords",
             t.terms_version as version, t.terms_language as language, t.notices_shown as notices
      from booking_terms t
        join consents k on k.id = t.terms_consent_id
        join bookings g on g.id = t.booking_id
      order by 1
    `;
    expect(terms).toHaveLength(4);
    for (const row of terms) {
      expect(row, String(row.booking)).toEqual({
        booking: row.booking,
        kind: "ticked_terms",
        sameBooking: true,
        personServed: true,
        sameBusiness: true,
        hashOfWords: true,
        version: ALEX_HAIRCUT_TERMS.terms_version,
        language: "en",
        notices: [],
      });
    }
    // The words have one home: no column of the snapshot holds them.
    const words = textOf(
      valuesOf("seed-booking-flow-a.json", "consents", "consent-alex-ticked-terms-haircut").exact_words,
    );
    expect(sha256Hex(words)).toBe(
      valuesOf("seed-booking-flow-a.json", "consents", "consent-alex-ticked-terms-haircut").words_sha256,
    );
    const copies = await db.sql<{ booking: string }[]>`
      select booking_id as booking from booking_terms t where row(t.*)::text like ${"%Free to cancel%"}
    `;
    expect(copies).toEqual([]);
  });

  it("Dee's waitlist request ended there (its entry is part 2's): its details keep the request's end, with its booking values undecided, and it has no visit, line or snapshot", async () => {
    const [request] = await db.sql<Record<string, unknown>[]>`
      select d.request_ended_why as why, d.approval, d.timing, d.taken, g.stage,
             (select count(*)::int from booking_visits v where v.booking_id = d.booking_id) as visits,
             (select count(*)::int from booking_lines l where l.booking_id = d.booking_id) as lines,
             (select count(*)::int from booking_terms t where t.booking_id = d.booking_id) as snapshots
      from booking_details d join bookings g on g.id = d.booking_id
      where d.booking_id = ${DEE_WAITLIST}
    `;
    expect(request).toEqual({
      why: "waitlist",
      approval: null,
      timing: null,
      taken: null,
      stage: "cancelled",
      visits: 0,
      lines: 0,
      snapshots: 0,
    });
  });

  it("the four seeded visits each hold their own code, sealed for the person who gets it: four different sealed values, each for its booking's person served", async () => {
    const codes = await db.sql<{ id: string; code: Uint8Array; codeFor: string; served: string }[]>`
      select v.id, v.check_in_code as code, v.code_for_person_id as "codeFor", g.served_person_id as served
      from booking_visits v join bookings g on g.id = v.booking_id
      order by 1
    `;
    expect(codes).toHaveLength(4);
    expect(new Set(codes.map((row) => toHex(row.code))).size).toBe(4);
    for (const row of codes) {
      expect(row.codeFor, row.id).toBe(row.served);
    }
    expect(codes.filter((row) => row.codeFor === DEE).map((row) => row.id)).toEqual([
      textOf(DEE_HAIRCUT_VISIT.id),
      "visit-dee-skin-fade-1",
    ]);
  });
});

describe("the refused fixtures on part 1's tables: each refused for its one reason, and passing once its fault is removed", () => {
  beforeEach(async () => {
    await reset();
  }, 60_000);

  it(
    "refuse-booking-line-price-change.json (the card's): after Sam's raise, a Tool API call scoped to the barbershop setting Dee's booked line to $40 is refused by privilege (42501), and the runtime side is refused too, so a later price change never reaches a booked line (RULES 3.7); the same call setting the line removed passes",
    SLOW,
    async () => {
      const file = "invalid/refuse-booking-line-price-change.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "update",
        "booking_lines",
        BARBERSHOP,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      const outcome = await refusal(
        as(
          roleOf(refused),
          refused.scope?.businessId ?? null,
          updateWhere(refused.table, where, refused.set ?? {}),
        ),
      );
      expect([outcome.code, outcome.message]).toEqual([
        refused.expect.sqlstate,
        "permission denied for table booking_lines",
      ]);
      const runtime = await refusal(as(RUNTIME, null, updateWhere(refused.table, where, refused.set ?? {})));
      expect([runtime.code, runtime.message]).toEqual(["42501", "permission denied for table booking_lines"]);
      // Every copied column is refused the same way, for both roles; only rule 6's four columns change.
      const copied = tableOf("booking_lines")
        .columns.map((column) => column.name)
        .filter((column) => !(COLUMN_UPDATES.booking_lines ?? []).includes(column));
      for (const column of copied) {
        for (const [role, scope] of [
          [TOOL_API, BARBERSHOP],
          [RUNTIME, null],
        ] as const) {
          const changed = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(
                `update booking_lines set "${column}" = "${column}", version = version + 1 where id = $1`,
                [textOf(where.id)],
              ),
            ),
          );
          expect(changed.code, `${role} ${column}`).toBe("42501");
        }
      }
      const removed = await as(
        TOOL_API,
        BARBERSHOP,
        updateWhere(refused.table, where, {
          state: "removed",
          removed_at: "2026-10-28T14:10:02Z",
          version: 2,
        }),
      );
      expect(removed.map((row) => [row.state, row.price_cents, row.version])).toEqual([
        ["removed", "3500", 2],
      ]);
      const [kept] = await db.sql<{ price: string }[]>`
        select price_cents::text as price from booking_lines where id = ${textOf(where.id)}
      `;
      expect(kept?.price).toBe("3500");
    },
  );

  it(
    "refuse-terms-snapshot-update.json: changing the cancel rule in Dee's skin fade's snapshot to 24 hours is refused by privilege (42501), for either role; a snapshot for a booking that has none, the waitlist request's, is inserted",
    SLOW,
    async () => {
      const file = "invalid/refuse-terms-snapshot-update.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table]).toEqual(["toolApi", "update", "booking_terms"]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      for (const [role, scope] of [
        [roleOf(refused), refused.scope?.businessId ?? null],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(as(role, scope, updateWhere(refused.table, where, refused.set ?? {})));
        expect([outcome.code, outcome.message], role).toEqual([
          refused.expect.sqlstate,
          "permission denied for table booking_terms",
        ]);
      }
      const snapshot: Values = { ...DEE_SKIN_FADE_TERMS, booking_id: DEE_WAITLIST, terms_consent_id: null };
      const inserted = await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "booking_terms", snapshot));
      expect(inserted.map((row) => [row.booking_id, row.cutoff_before])).toEqual([
        [DEE_WAITLIST, "02:00:00"],
      ]);
    },
  );

  it(
    "refuse-booking-value-reset.json: setting Alex's haircut, a request the owner OK'd, back to books now is refused by trigger booking_details_set_once (23514), for either role; the same update of the need-by date, which is not set once, passes",
    SLOW,
    async () => {
      const file = "invalid/refuse-booking-value-reset.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table]).toEqual(["toolApi", "update", "booking_details"]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      for (const [role, scope] of [
        [roleOf(refused), refused.scope?.businessId ?? null],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(as(role, scope, updateWhere(refused.table, where, refused.set ?? {})));
        expect(
          [outcome.code, refused.expect.constraintOneOf?.includes(outcome.constraint ?? "")],
          role,
        ).toEqual([refused.expect.sqlstate, true]);
        expect(outcome.message, role).toBe("a booking value is set once and never changed (FS line 752)");
      }
      const needBy = await as(
        TOOL_API,
        BARBERSHOP,
        updateWhere(refused.table, where, { need_by: "2026-10-24", version: refused.set?.version ?? null }),
      );
      expect(needBy.map((row) => [row.approval, row.version])).toEqual([["ownerok", 7]]);
    },
  );

  it(
    "refuse-cross-business-booking-read.json: a Tool API call scoped to the yoga studio does not see the barbershop's line for Alex's haircut, though Alex is its customer too (no row); the barbershop's own scope sees it",
    SLOW,
    async () => {
      const file = "invalid/refuse-cross-business-booking-read.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "select",
        "booking_lines",
        YOGA_STUDIO,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const where = refused.where ?? {};
      const read = (sql: Sql | Tx) => sql`select * from ${sql(refused.table)} where ${whereOf(sql, where)}`;
      expect(await read(db.sql)).toHaveLength(1);
      expect(await as(TOOL_API, YOGA_STUDIO, read)).toHaveLength(refused.expect.rows ?? -1);
      expect(await as(TOOL_API, BARBERSHOP, read)).toHaveLength(1);
      // Alex is the yoga studio's customer too (K-28), which sees none of the barbershop's five tables' rows.
      expect(await as(TOOL_API, YOGA_STUDIO, visibleRows)).toEqual(
        Object.fromEntries(OWN_TABLES.map((t) => [t, 0])),
      );
    },
  );

  it(
    "refuse-line-on-other-business-booking.json: a Tool API call scoped to the barbershop adding a barbershop line, its own business and service, to Lee Home Services' booking of Alex's drain is refused by the insert policy (42501), though the key to bookings alone lets it through; the same line on the barbershop's own booking passes",
    SLOW,
    async () => {
      const file = "invalid/refuse-line-on-other-business-booking.json";
      const refused = refusedOf(file);
      expect([refused.role, refused.action, refused.table, refused.scope?.businessId]).toEqual([
        "toolApi",
        "insert",
        "booking_lines",
        BARBERSHOP,
      ]);
      await loadFixtures(fixtureFile(file).after);
      const outcome = await refusal(
        as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, refused.table, refused.values ?? {})),
      );
      expect([outcome.code, outcome.message]).toEqual([
        refused.expect.sqlstate,
        'new row violates row-level security policy for table "booking_lines"',
      ]);
      // The keys alone let it through: as the owner (not bound by row-level security), it is stored.
      expect(await asOwner((tx) => insertReturning(tx, refused.table, refused.values ?? {}))).toHaveLength(1);
      expect(
        await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "booking_lines", SECOND_HAIRCUT_LINE)),
      ).toMatchObject([{ id: SECOND_HAIRCUT_LINE.id, booking_id: ALEX_HAIRCUT, position: 2 }]);
    },
  );
});

describe("rule 5: each business's scope reads and writes only its own rows, and only onto its own bookings (the card's four seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  /**
   * One row of each of the five naming the barbershop and Lee Home Services' drain: the barbershop's own rows under new
   * ids, each with that one fault. Rule 5's clause refuses each under the barbershop's scope.
   */
  const ONTO_THE_DRAIN: [string, Values][] = [
    ["booking_details", { ...ALEX_HAIRCUT_DETAILS, booking_id: ALEX_DRAIN, number: "LB1099" }],
    [
      "booking_visits",
      {
        ...ALEX_HAIRCUT_VISIT,
        id: "visit-probe-drain-2",
        booking_id: ALEX_DRAIN,
        position: 2,
        reservation_id: null,
      },
    ],
    ["booking_lines", { ...SECOND_HAIRCUT_LINE, id: "line-probe-drain-2", booking_id: ALEX_DRAIN }],
    ["booking_terms", { ...ALEX_HAIRCUT_TERMS, booking_id: ALEX_DRAIN, terms_consent_id: null }],
    [
      "booking_terms_rules",
      {
        ...valuesOf("seed-booking-flow-a.json", "booking_terms_rules", "btr-alex-haircut-ok-same-day"),
        id: "btr-probe-drain-ok-same-day",
        booking_id: ALEX_DRAIN,
      },
    ],
  ];
  /** A second day of Alex's drain and a second line on it, Lee Home Services' own (its rows under new ids). */
  const DRAIN_DAY_2: Values = {
    ...ALEX_DRAIN_VISIT,
    id: "visit-probe-drain-2",
    position: 2,
    reservation_id: null,
    check_in_code: "\\x6b33302d7365616c2d636f64652d35",
  };
  const DRAIN_LINE_2: Values = {
    ...valuesOf("seed-booking-flow-b.json", "booking_lines", "line-alex-drain-1"),
    id: "line-probe-drain-2",
    position: 2,
  };

  it(
    "with no scope the Tool API reads no row of the five; each business's scope shows exactly its own rows: the yoga studio none, the barbershop its three bookings', Lee Home Services the drain's",
    SLOW,
    async () => {
      expect(await as(TOOL_API, null, visibleRows)).toEqual(
        Object.fromEntries(OWN_TABLES.map((t) => [t, 0])),
      );
      const businesses = await businessIds();
      expect(businesses).toEqual(expect.arrayContaining([BARBERSHOP, HOME_SERVICES, YOGA_STUDIO]));
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await as(TOOL_API, HOME_SERVICES, visibleRows)).toEqual({
        booking_details: 1,
        booking_lines: 1,
        booking_terms: 1,
        booking_terms_rules: 1,
        booking_visits: 1,
      });
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
      for (const business of businesses) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
    },
  );

  it("the Tool API scoped to the barbershop cannot attach a row naming its own business to Lee Home Services' booking (rule 5's clause, 42501) on any of the five, though every key lets it through; Lee Home Services' own scope adds a second day and a second line to its drain", async () => {
    for (const [table, values] of ONTO_THE_DRAIN) {
      expect(values.business_id, table).toBe(BARBERSHOP);
      const attached = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, table, values)));
      expect([attached.code, attached.message], table).toEqual([
        "42501",
        `new row violates row-level security policy for table "${table}"`,
      ]);
    }
    // The visit and the line, which no key of the drain holds back, are stored as the owner (no row-level security).
    for (const [table, values] of ONTO_THE_DRAIN.filter(([name]) =>
      ["booking_lines", "booking_visits"].includes(name),
    )) {
      expect(await asOwner((tx) => insertReturning(tx, table, values)), table).toHaveLength(1);
    }
    const own = await as(TOOL_API, HOME_SERVICES, async (tx) => {
      const [visit] = await insertReturning(tx, "booking_visits", DRAIN_DAY_2);
      const [line] = await insertReturning(tx, "booking_lines", DRAIN_LINE_2);
      return [
        visit?.id,
        line?.id,
        await countRows(tx, "booking_visits"),
        await countRows(tx, "booking_lines"),
      ];
    });
    expect(own).toEqual([DRAIN_DAY_2.id, DRAIN_LINE_2.id, 2, 2]);
  });

  it("the Tool API cannot move a row to another business: booking_details by rule 6's trigger (23514), every other table by privilege (42501); it cannot write with no scope (42501), and an update of another business's row finds no row", async () => {
    const details = await refusal(
      as(
        TOOL_API,
        BARBERSHOP,
        (tx) => tx`
          update booking_details set business_id = ${HOME_SERVICES}, version = version + 1
          where booking_id = ${ALEX_HAIRCUT}
        `,
      ),
    );
    expect([details.code, details.constraint]).toEqual(["23514", "booking_details_set_once"]);
    for (const [table, column, id] of [
      ["booking_visits", "id", ALEX_HAIRCUT_VISIT.id],
      ["booking_lines", "id", ALEX_HAIRCUT_LINE.id],
      ["booking_terms", "booking_id", ALEX_HAIRCUT],
      ["booking_terms_rules", "id", "btr-alex-haircut-ok-same-day"],
    ] as const) {
      const moved = await refusal(
        as(TOOL_API, BARBERSHOP, (tx) =>
          tx.unsafe(`update ${table} set business_id = $1 where ${column} = $2`, [HOME_SERVICES, textOf(id)]),
        ),
      );
      expect([moved.code, moved.message], table).toEqual(["42501", `permission denied for table ${table}`]);
    }
    const noScope = await refusal(
      as(TOOL_API, null, (tx) => insertReturning(tx, "booking_lines", SECOND_HAIRCUT_LINE)),
    );
    expect([noScope.code, noScope.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "booking_lines"',
    ]);
    const remove = (tx: Tx) => tx`
      update booking_lines set state = 'removed', removed_at = now(), version = version + 1
      where id = ${textOf(ALEX_HAIRCUT_LINE.id)} returning id
    `;
    expect(await as(TOOL_API, YOGA_STUDIO, remove)).toHaveLength(0);
    expect(await as(TOOL_API, HOME_SERVICES, remove)).toHaveLength(0);
    expect(await as(TOOL_API, BARBERSHOP, remove)).toHaveLength(1);
  });

  it("the runtime side scoped to one business (per write) cannot write another's row (42501); scoped to its own, or with no scope, it writes it, and holds a row's booking to its business by code (rule 5)", async () => {
    const outcome = await refusal(
      as(RUNTIME, YOGA_STUDIO, (tx) => insertReturning(tx, "booking_lines", SECOND_HAIRCUT_LINE)),
    );
    expect(outcome.code).toBe("42501");
    for (const scope of [BARBERSHOP, null]) {
      expect(
        await as(RUNTIME, scope, (tx) => insertReturning(tx, "booking_lines", SECOND_HAIRCUT_LINE)),
        String(scope),
      ).toHaveLength(1);
    }
  });
});

describe("rule 6: what may be written, by privilege and one trigger, the same for both roles (the card's four seeds loaded)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  /** Each table with one of its rows, by its primary key, and its business. */
  const ROWS: [string, string, Json | undefined, string][] = [
    ["booking_details", "booking_id", ALEX_HAIRCUT, BARBERSHOP],
    ["booking_visits", "id", ALEX_DRAIN_VISIT.id, HOME_SERVICES],
    ["booking_lines", "id", DEE_HAIRCUT_LINE.id, BARBERSHOP],
    ["booking_terms", "booking_id", DEE_SKIN_FADE, BARBERSHOP],
    ["booking_terms_rules", "id", "btr-alex-drain-price-oks", HOME_SERVICES],
  ];

  it("no role deletes a row of any of the five (42501): a booking and the words agreed are kept 7 years (rule 8)", async () => {
    for (const [table, column, id, business] of ROWS) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) => tx.unsafe(`delete from ${table} where ${column} = $1`, [textOf(id)])),
        );
        expect([outcome.code, outcome.message], `${role} ${table}`).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    }
  });

  it("the snapshot is insert only (FS line 752): neither role updates a column of booking_terms or booking_terms_rules (42501)", async () => {
    for (const [table, column, id, business] of ROWS.filter(([name]) => name.startsWith("booking_terms"))) {
      for (const name of tableOf(table).columns.map((each) => each.name)) {
        for (const [role, scope] of [
          [TOOL_API, business],
          [RUNTIME, null],
        ] as const) {
          const outcome = await refusal(
            as(role, scope, (tx) =>
              tx.unsafe(`update ${table} set "${name}" = "${name}" where ${column} = $1`, [textOf(id)]),
            ),
          );
          expect(outcome.code, `${role} ${table}.${name}`).toBe("42501");
        }
      }
    }
  });

  it("a visit's code, who it is for, its booking and its place never change (42501, either role); a move changes only its reservation, window and free-cancel time, raising its version (A7-03)", async () => {
    const visit = textOf(ALEX_DRAIN_VISIT.id);
    for (const column of tableOf("booking_visits")
      .columns.map((each) => each.name)
      .filter((name) => !(COLUMN_UPDATES.booking_visits ?? []).includes(name))) {
      for (const [role, scope] of [
        [TOOL_API, HOME_SERVICES],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) =>
            tx.unsafe(
              `update booking_visits set "${column}" = "${column}", version = version + 1 where id = $1`,
              [visit],
            ),
          ),
        );
        expect([outcome.code, outcome.message], `${role} ${column}`).toEqual([
          "42501",
          "permission denied for table booking_visits",
        ]);
      }
    }
    for (const [role, scope] of [
      [TOOL_API, HOME_SERVICES],
      [RUNTIME, null],
    ] as const) {
      const moved = await as(
        role,
        scope,
        (tx) =>
          tx<{ from: Date; until: Date; cutoff: Date; version: number; code: Uint8Array }[]>`
          update booking_visits
          set reservation_id = null, arrival_window = tstzrange(lower(arrival_window) + interval '1 day',
                upper(arrival_window) + interval '1 day', '[)'),
              cutoff_at = cutoff_at + interval '1 day', version = version + 1
          where id = ${visit}
          returning lower(arrival_window) as from, upper(arrival_window) as until, cutoff_at as cutoff, version,
                    check_in_code as code
        `,
      );
      expect(
        moved.map((row) => [
          row.from.toISOString(),
          row.until.toISOString(),
          row.cutoff.toISOString(),
          row.version,
          toHex(row.code),
        ]),
        role,
      ).toEqual([
        [
          "2026-10-23T12:00:00.000Z",
          "2026-10-23T14:00:00.000Z",
          "2026-10-23T11:00:00.000Z",
          2,
          textOf(ALEX_DRAIN_VISIT.check_in_code).replace(/^\\x/, ""),
        ],
      ]);
    }
  });

  it("booking_details' values are set once (rule 6's trigger, 23514 booking_details_set_once, either role): Alex's decided haircut keeps its number, door, made by, approval, timing, times, taken and staff_told_at; Dee's ended waitlist request keeps its end", async () => {
    const refusedSets: [string, Values][] = [
      [ALEX_HAIRCUT, { booking_id: "booking-alex-drain" }],
      [ALEX_HAIRCUT, { number: "LB1025" }],
      [ALEX_HAIRCUT, { door: "page" }],
      [ALEX_HAIRCUT, { made_by: "shop", door: "business" }],
      [ALEX_HAIRCUT, { approval: "now" }],
      [ALEX_HAIRCUT, { approval: null }],
      [ALEX_HAIRCUT, { timing: "sentnow" }],
      [ALEX_HAIRCUT, { times: "window" }],
      [ALEX_HAIRCUT, { taken: "nothing" }],
      [ALEX_HAIRCUT, { staff_told_at: "2026-10-22T12:07:00Z" }],
      [DEE_WAITLIST, { request_ended_why: "dropped" }],
      [DEE_WAITLIST, { request_ended_at: null, request_ended_why: null }],
    ];
    for (const [booking, set] of refusedSets) {
      for (const [role, scope] of [
        [TOOL_API, BARBERSHOP],
        [RUNTIME, null],
      ] as const) {
        const label = `${role} ${booking} ${JSON.stringify(set)}`;
        const outcome = await refusal(
          as(
            role,
            scope,
            (tx) =>
              tx`
              update booking_details set ${tx(columnValues(tx, "booking_details", set))}, version = version + 1
              where booking_id = ${booking}
            `,
          ),
        );
        expect([outcome.code, outcome.constraint, outcome.message], label).toEqual([
          "23514",
          "booking_details_set_once",
          "a booking value is set once and never changed (FS line 752)",
        ]);
      }
    }
  });

  it("a null value is set once and then held, and the others move (rule 6): Dee's undecided request takes its approval, timing, taken and first chat link once; the need-by date, who meets the pro and the upset count change on later updates", async () => {
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const outcome = await as(role, scope, async (tx) => {
        const set = (values: Values) => tx`
          update booking_details set ${tx(columnValues(tx, "booking_details", values))}, version = version + 1
          where booking_id = ${DEE_WAITLIST}
          returning approval, timing, taken, need_by::text as need_by, upset_count, version
        `;
        const once = await set({
          approval: "now",
          timing: "settime",
          taken: "asked",
          first_link_given_at: "2026-10-21T23:25:00Z",
        });
        const later = await set({ need_by: "2026-10-24", upset_count: 1 });
        const again = await set({ need_by: null, upset_count: 2 });
        // In a savepoint, so the refusal leaves the transaction usable; it rolls back to the savepoint.
        const held = await refusal(
          tx.savepoint(
            (sp) => sp`
              update booking_details set first_link_given_at = '2026-10-21T23:26:00Z', version = version + 1
              where booking_id = ${DEE_WAITLIST}
            `,
          ),
        );
        return { once, later, again, held: [held.code, held.constraint] };
      });
      expect(outcome, role).toEqual({
        once: [
          { approval: "now", timing: "settime", taken: "asked", need_by: null, upset_count: 0, version: 4 },
        ],
        later: [
          {
            approval: "now",
            timing: "settime",
            taken: "asked",
            need_by: "2026-10-24",
            upset_count: 1,
            version: 5,
          },
        ],
        again: [
          { approval: "now", timing: "settime", taken: "asked", need_by: null, upset_count: 2, version: 6 },
        ],
        held: ["23514", "booking_details_set_once"],
      });
    }
    // Who meets the pro moves (flow B): Lee Home Services' drain, from the person served to nobody home.
    const meets = await as(
      TOOL_API,
      HOME_SERVICES,
      (tx) =>
        tx<{ meets_pro: string }[]>`
        update booking_details set meets_pro = 'nobody_home', version = version + 1 where booking_id = ${ALEX_DRAIN}
        returning meets_pro
      `,
    );
    expect(meets).toEqual([{ meets_pro: "nobody_home" }]);
  });

  it("every update of a versioned table raises its version by exactly one, under either role: one that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const [table, column, id, business] of ROWS.filter(([name]) => VERSIONED.includes(name))) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const kept = await refusal(
          as(role, scope, (tx) =>
            tx.unsafe(`update ${table} set version = version where ${column} = $1`, [textOf(id)]),
          ),
        );
        expect([kept.code, kept.constraint], `${role} ${table}`).toEqual([
          "23514",
          `${table}_version_raised`,
        ]);
        const raised = await as(role, scope, (tx) =>
          tx.unsafe<{ before: number; version: number }[]>(
            `update ${table} set version = version + 1 where ${column} = $1 returning version - 1 as before, version`,
            [textOf(id)],
          ),
        );
        expect(
          raised.map((row) => row.version - row.before),
          `${role} ${table}`,
        ).toEqual([1]);
      }
    }
  });
});

describe("rule 7: the check-in code is new each visit and sealed under its person's key (T-182's seal)", () => {
  const wrappingKey = randomBytes(32);
  const keys: WrappingKeys = { resolve: () => new Uint8Array(wrappingKey) };
  /** Stand-ins for two days' codes: never real codes. */
  const DAY_CODES = [
    "a stand-in check-in code for day 1, not real",
    "a stand-in check-in code for day 2, not real",
  ];
  const TESSA_DRAIN = "booking-tessa-drain";

  beforeAll(async () => {
    await reset();
    await loadFixtures([TESSA_SEED]);
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

  it("two check-in codes for two visits of one booking differ: Lee Home Services' job for Tessa (B3-08) over two days holds a code per visit, each sealed under Tessa's own new key; the two stored codes differ and open to two different codes, no row holds a plain code, neither opens as another person's, and neither opens once her key is erased while both rows stay", async () => {
    const outcome = await as(RUNTIME, null, async (tx) => {
      for (const [i, code] of DAY_CODES.entries()) {
        const sealed = await seal(tx, keys, TESSA, code);
        const visit = {
          ...columnValues(tx, "booking_visits", {
            ...ALEX_DRAIN_VISIT,
            id: `visit-probe-tessa-drain-${String(i + 1)}`,
            booking_id: TESSA_DRAIN,
            position: i + 1,
            reservation_id: null,
            code_for_person_id: TESSA,
          }),
          check_in_code: sealed as never,
        };
        await tx`insert into booking_visits ${tx(visit)}`;
      }
      const rows = await tx<{ position: number; code: Uint8Array }[]>`
        select position, check_in_code as code from booking_visits where booking_id = ${TESSA_DRAIN} order by position
      `;
      const stored = rows.map((row) => new Uint8Array(row.code));
      const opened: string[] = [];
      for (const code of stored) {
        opened.push(await unsealText(tx, keys, TESSA, code));
      }
      const [plain] = await tx<{ n: number }[]>`
        select count(*)::int as n from booking_visits v where row(v.*)::text like ${"%stand-in check-in code%"}
      `;
      // Sam gets a key of his own; Tessa's codes do not open as his.
      await seal(tx, keys, SAM, "a stand-in value of Sam's, not real");
      const asSam = await sealingCode(unsealText(tx, keys, SAM, stored[0] ?? new Uint8Array()));
      const erased = await erasePerson(tx, TESSA);
      const afterErase: string[] = [];
      for (const code of stored) {
        afterErase.push(await sealingCode(unsealText(tx, keys, TESSA, code)));
      }
      return {
        positions: rows.map((row) => row.position),
        storedDiffer: toHex(stored[0] ?? new Uint8Array()) !== toHex(stored[1] ?? new Uint8Array()),
        opened,
        plainCopies: plain?.n,
        asSam,
        erased: erased.ok,
        afterErase,
        kept: await countRows(tx, "booking_visits"),
      };
    });
    expect(outcome).toEqual({
      positions: [1, 2],
      storedDiffer: true,
      opened: DAY_CODES,
      plainCopies: 0,
      asSam: "cannot_open",
      erased: true,
      afterErase: ["erased", "erased"],
      kept: 2,
    });
    expect(new Set(outcome.opened).size).toBe(2);
  });

  it("a code is sealed for exactly one named person (booking_visits_code_with_person, 23514): a code with nobody to give it to, or a person with no code, is refused; a visit with neither (nobody home, B4-105) passes", async () => {
    const base: Values = {
      ...ALEX_DRAIN_VISIT,
      id: "visit-probe-tessa-drain-1",
      booking_id: TESSA_DRAIN,
      reservation_id: null,
    };
    for (const faulty of [
      { ...base, code_for_person_id: null },
      { ...base, check_in_code: null, code_for_person_id: TESSA },
    ]) {
      const outcome = await refusal(as(RUNTIME, null, (tx) => insertReturning(tx, "booking_visits", faulty)));
      expect([outcome.code, outcome.constraint]).toEqual(["23514", "booking_visits_code_with_person"]);
    }
    expect(
      await as(RUNTIME, null, (tx) =>
        insertReturning(tx, "booking_visits", { ...base, check_in_code: null, code_for_person_id: null }),
      ),
    ).toHaveLength(1);
  });
});

describe("probes: each breaks one rule of the table list and is refused by the constraint it names; the rows without the fault pass (the card's four seeds loaded, and a second drain job of Alex's that Lee Home Services adds, made here)", () => {
  const PROBE_BOOKING = "booking-probe-alex-drain-2";
  /** The head of a second drain job of Alex's (K-04's row from flow B's seed under a new id), with none of the five. */
  const HEAD: Values = {
    ...valuesOf("seed-booking-flow-b.json", "bookings", ALEX_DRAIN),
    id: PROBE_BOOKING,
    version: 1,
  };
  /** Its rows: Alex's drain's under new ids, the business adding it (B3-08: door business, made by the shop). */
  const DETAILS: Values = {
    ...valuesOf("seed-booking-flow-b.json", "booking_details", ALEX_DRAIN, "booking_id"),
    booking_id: PROBE_BOOKING,
    number: "LH2202",
    door: "business",
    made_by: "shop",
    approval: "now",
    staff_told_at: null,
    version: 1,
  };
  const VISIT: Values = {
    ...ALEX_DRAIN_VISIT,
    id: "visit-probe-alex-drain-2-1",
    booking_id: PROBE_BOOKING,
    reservation_id: null,
  };
  const LINE: Values = {
    ...valuesOf("seed-booking-flow-b.json", "booking_lines", "line-alex-drain-1"),
    id: "line-probe-alex-drain-2-1",
    booking_id: PROBE_BOOKING,
  };
  const TERMS: Values = {
    ...valuesOf("seed-booking-flow-b.json", "booking_terms", ALEX_DRAIN, "booking_id"),
    booking_id: PROBE_BOOKING,
    terms_consent_id: null,
  };
  const TERMS_RULE: Values = {
    ...valuesOf("seed-booking-flow-b.json", "booking_terms_rules", "btr-alex-drain-price-oks"),
    id: "btr-probe-alex-drain-2-price-oks",
    booking_id: PROBE_BOOKING,
  };
  const HAIRCUT_RULE = valuesOf(
    "seed-booking-flow-a.json",
    "booking_terms_rules",
    "btr-alex-haircut-ok-same-day",
  );

  interface Probe {
    breaks: string;
    /** Inserted in order, as the runtime side with no scope; the last row holds the fault. */
    rows: [string, Values][];
    code: string;
    constraint?: string;
  }

  const PROBES: Probe[] = [
    {
      breaks: "a call door (Q-05: calls and voicemails are out)",
      rows: [["booking_details", { ...DETAILS, door: "call", made_by: "customer" }]],
      code: "23514",
      constraint: "booking_details_door_known",
    },
    {
      breaks: "a walk-in made by the customer (RULES 2.5: a walk-in is the business's own)",
      rows: [["booking_details", { ...DETAILS, door: "walk_in", made_by: "customer" }]],
      code: "23514",
      constraint: "booking_details_made_by_door",
    },
    {
      breaks: "a booking the business adds made a request (A4-98: it books on the owner's reply)",
      rows: [["booking_details", { ...DETAILS, approval: "ownerok" }]],
      code: "23514",
      constraint: "booking_details_shop_books_now",
    },
    {
      breaks: "a second booking numbered LH2201 at Lee Home Services",
      rows: [["booking_details", { ...DETAILS, number: "LH2201" }]],
      code: "23505",
      constraint: "booking_details_number_key",
    },
    {
      breaks: "a booking number with a space in it",
      rows: [["booking_details", { ...DETAILS, number: "LH 2202" }]],
      code: "23514",
      constraint: "booking_details_number_form",
    },
    {
      breaks: "a person named while the person served meets the pro (B4-26)",
      rows: [["booking_details", { ...DETAILS, meets_pro_person_id: SAM }]],
      code: "23514",
      constraint: "booking_details_meets_pro_known",
    },
    {
      breaks: "a request ended with no reason",
      rows: [["booking_details", { ...DETAILS, request_ended_at: "2026-10-20T15:00:00Z" }]],
      code: "23514",
      constraint: "booking_details_request_end",
    },
    {
      breaks: "an open-ended arrival window",
      rows: [["booking_visits", { ...VISIT, arrival_window: "[2026-10-22T12:00:00Z,)" }]],
      code: "23514",
      constraint: "booking_visits_window_bounded",
    },
    {
      breaks: "one reservation for two visits (Alex's drain's)",
      rows: [["booking_visits", { ...VISIT, reservation_id: "rsv-alex-drain" }]],
      code: "23505",
      constraint: "booking_visits_reservation_key",
    },
    {
      breaks: "a second first visit of one booking",
      rows: [
        ["booking_visits", VISIT],
        ["booking_visits", { ...VISIT, id: "visit-probe-tessa-again" }],
      ],
      code: "23505",
      constraint: "booking_visits_position_key",
    },
    {
      breaks: "a visit at position 0",
      rows: [["booking_visits", { ...VISIT, position: 0 }]],
      code: "23514",
      constraint: "booking_visits_position_from_one",
    },
    {
      breaks: "a hold path (SPEC-master D66: no hold)",
      rows: [["booking_lines", { ...LINE, path: "list|hold|bill" }]],
      code: "23514",
      constraint: "booking_lines_path_form",
    },
    {
      breaks: "a photos line with no quote option, priced by no rule",
      rows: [["booking_lines", { ...LINE, path: "photos|card|bill", price_rule_id: null }]],
      code: "23514",
      constraint: "booking_lines_price_source",
    },
    {
      breaks: "a deposit over the price (S1-13)",
      rows: [["booking_lines", { ...LINE, path: "list|deposit|bill", deposit_cents: 20000 }]],
      code: "23514",
      constraint: "booking_lines_deposit_with_deposit_path",
    },
    {
      breaks: "a fee on a nothing-taken path (FS section 4)",
      rows: [["booking_lines", { ...LINE, path: "list|none|bill" }]],
      code: "23514",
      constraint: "booking_lines_fee_needs_money_before",
    },
    {
      breaks: "one price for two units",
      rows: [["booking_lines", { ...LINE, units: 2 }]],
      code: "23514",
      constraint: "booking_lines_units",
    },
    {
      breaks: "a lower-case currency",
      rows: [["booking_lines", { ...LINE, currency: "usd" }]],
      code: "23514",
      constraint: "booking_lines_money",
    },
    {
      breaks: "a removed line with no time it was removed",
      rows: [["booking_lines", { ...LINE, state: "removed" }]],
      code: "23514",
      constraint: "booking_lines_state",
    },
    {
      breaks: "'179.00' as cents: a decimal, never integer minor units (CQ-09)",
      rows: [["booking_lines", { ...LINE, price_cents: "179.00" }]],
      code: "22P02",
    },
    {
      breaks: "the way of another service (the barbershop's haircut way)",
      rows: [["booking_lines", { ...LINE, service_money_id: "way-lees-haircut-shop" }]],
      code: "23503",
      constraint: "booking_lines_way_fk",
    },
    {
      breaks: "the price rule of another service (the haircut's $35)",
      rows: [["booking_lines", { ...LINE, price_rule_id: "price-lees-haircut-35" }]],
      code: "23503",
      constraint: "booking_lines_price_rule_fk",
    },
    {
      breaks: "a service of another business (the barbershop's haircut, with its own way and rule)",
      rows: [
        [
          "booking_lines",
          {
            ...LINE,
            service_id: "svc-lees-haircut",
            service_money_id: "way-lees-haircut-shop",
            price_rule_id: "price-lees-haircut-35",
          },
        ],
      ],
      code: "23503",
      constraint: "booking_lines_service_fk",
    },
    {
      breaks: "both cancel rules at once",
      rows: [["booking_terms", { ...TERMS, cutoff_day_before_at: "19:00", cutoff_zone: "America/Chicago" }]],
      code: "23514",
      constraint: "booking_terms_one_cutoff",
    },
    {
      breaks: "a day-before cancel time with no zone (S13-03)",
      rows: [["booking_terms", { ...TERMS, cutoff_before: null, cutoff_day_before_at: "19:00" }]],
      code: "23514",
      constraint: "booking_terms_zone_with_clock",
    },
    {
      breaks: "a terms language that is not a BCP 47 tag",
      rows: [["booking_terms", { ...TERMS, terms_language: "English" }]],
      code: "23514",
      constraint: "booking_terms_version_given",
    },
    {
      breaks: "a second snapshot naming the words Alex ticked for the drain",
      rows: [["booking_terms", { ...TERMS, terms_consent_id: "consent-alex-ticked-terms-drain" }]],
      code: "23505",
      constraint: "booking_terms_consent_key",
    },
    {
      breaks: "a terms rule row naming both a rule and a limit",
      rows: [
        ["booking_terms", TERMS],
        ["booking_terms_rules", { ...TERMS_RULE, rule_id: textOf(HAIRCUT_RULE.rule_id) }],
      ],
      code: "23514",
      constraint: "booking_terms_rules_one_ref",
    },
    {
      breaks: "a rule named twice in one snapshot (Alex's haircut's same-day OK)",
      rows: [["booking_terms_rules", { ...HAIRCUT_RULE, id: "btr-probe-alex-haircut-again" }]],
      code: "23505",
      constraint: "booking_terms_rules_rule_key",
    },
    {
      breaks: "a terms rule row with no snapshot",
      rows: [["booking_terms_rules", TERMS_RULE]],
      code: "23503",
      constraint: "booking_terms_rules_terms_fk",
    },
  ];

  /** The same rows without a fault: each passes. */
  const PASSES: { shows: string; rows: [string, Values][] }[] = [
    {
      shows: "a booking the business adds, made by the shop, booked now (B3-08)",
      rows: [["booking_details", DETAILS]],
    },
    {
      shows: "two visits of the job, each its own position and code",
      rows: [
        ["booking_visits", VISIT],
        [
          "booking_visits",
          {
            ...VISIT,
            id: "visit-probe-alex-drain-2-2",
            position: 2,
            check_in_code: "\\x6b33302d7365616c2d636f64652d36",
          },
        ],
      ],
    },
    { shows: "the drain line copied at $179 with its $89 fee", rows: [["booking_lines", LINE]] },
    {
      shows: "a snapshot with a day-before cancel time in its zone and a notice shown",
      rows: [
        [
          "booking_terms",
          {
            ...TERMS,
            cutoff_before: null,
            cutoff_day_before_at: "19:00",
            cutoff_zone: "America/Chicago",
            notices_shown: ["a stand-in notice shown at booking, not from the sources"],
          },
        ],
      ],
    },
    {
      shows: "a snapshot naming the price OK limit in force",
      rows: [
        ["booking_terms", TERMS],
        ["booking_terms_rules", TERMS_RULE],
      ],
    },
  ];

  beforeAll(async () => {
    await reset();
    await loadFixtures(CARD_SEEDS);
  }, 120_000);

  /** Inserts the probe booking's head, then each row in order; gives back how many of the rows were inserted. */
  const insertAll =
    (rows: [string, Values][]) =>
    async (tx: Tx): Promise<number> => {
      await insertRow(tx, "bookings", HEAD);
      for (const [table, values] of rows) {
        await insertRow(tx, table, values);
      }
      return rows.length;
    };

  for (const probe of PROBES) {
    it(`refused: ${probe.breaks} (${probe.constraint ?? probe.code})`, async () => {
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
