// T-211: the customers part (K-28 v1: customers and customer_blocks, with README rules 1 to 7) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/customers`). The schema comes from migrating a fresh test
// schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: journey 3's calls, the booking screens' and the owner console's
// page calls) or the runtime side (rosie_job: K-05's commit, the dispatcher, the 45-day copy or delete) runs in its own
// transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are
// loaded the same way, as the runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-28 v1's seeds and refused rows and the K-04, K-23 and K-29 seeds their
// after chains name (Lee's Barbershop, the yoga studio, Lee Home Services and the master's sample cast: Sam Lee, Alex M.,
// Ben T., B3-08's Tessa and Kim; A3-48's first-time sender, who has no name). A row made here is a fixture row under a
// new id, or with one fault. The fixtures' sealed addresses are stand-in bytes; the sealing check seals a stand-in
// string under a wrapping key of random bytes made here and never written to a file.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SealingError, type WrappingKeys, erasePerson, seal, unsealText } from "./sealing";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/customers/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The two tables, in code-unit order (as PostgreSQL orders a relation's name): both scoped by business, both versioned. */
const OWN_TABLES = ["customer_blocks", "customers"];
/** The three seeds 02-contracts' K-28 row names, which the card's proof loads. */
const CARD_SEEDS = [
  "seed-customer-blocked.json",
  "seed-customer-business-added.json",
  "seed-customer-mobile-email.json",
];
/** The seed beyond the row's list: a block of a first-time sender who booked nothing, with no customer row. */
const FIRST_SENDER_SEED = "seed-customer-blocked-first-sender.json";
/** K-04's tables the two refer to by their keys (README rule 1); no K-23 or K-29 table. */
const REFERRED = ["businesses", "person_handles", "persons", "phones", "turns"];
/** The only sealed column (README rule 6), bytea under its row's person_id; nothing else of the two is bytea. */
const SEALED = ["customer_blocks.address"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const HOME_SERVICES = "biz-lee-home-services";
const SAM = "person-sam";
const ALEX = "person-alex";
const BEN = "person-ben";
const TESSA = "person-tessa";
const KIM = "person-kim";
const FIRST_SENDER = "person-first-sender";
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

const TABLES = (readJson(new URL("customers.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-28's seeds name it: from K-28's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);

/** Every seed of the parts K-28 sits beside (README rule 1: K-04 and K-23) and of K-29, whose consent a seed writes. */
const OTHER_SEEDS = [...seedsOf("core"), ...seedsOf("business-setup"), ...seedsOf("conversations-consent")];

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-28 v1 lists no table ${name}`);
  }
  return table;
}

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's own row of `table` whose id is `id`. */
function valuesWithId(file: string, table: string, id: string): Values {
  const row = fixtureFile(file).rows.find(
    (candidate) => candidate.table === table && candidate.values.id === id,
  );
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row with id ${id}`);
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
 * file that names it, so K-28's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** The fixture files a load of `files` reads, each once, with every `after` chain. */
function filesRead(files: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const file of files) {
    fixtureRows(new URL(file, FIXTURES_DIR), seen);
  }
  return seen;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

const sha256Hex = (words: string): string => createHash("sha256").update(words, "utf8").digest("hex");

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Every K-28 row of the four seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Alex M. at Lee's Barbershop, as Alex's own AI booked it (A4-82, A4-23): mobile and email on file, texts. */
const ALEX_BARBERSHOP = valuesWithId(
  "seed-customer-mobile-email.json",
  "customers",
  "customer-alex-barbershop",
);
/** Alex M. at the yoga studio: the same contacts, texts only, the times Alex named, and fee-free (S11-57). */
const ALEX_YOGA = valuesWithId("seed-customer-mobile-email.json", "customers", "customer-alex-yoga");
/** Tessa at Lee Home Services, added by the business (B3-08), and her yes to texts for that booking (K-29). */
const TESSA_RECORD = valuesWithId(
  "seed-customer-business-added.json",
  "customers",
  "customer-tessa-home-services",
);
const TESSA_CONSENT = valuesWithId(
  "seed-customer-business-added.json",
  "consents",
  "consent-tessa-texts-yes-drain",
);
/** Kim at Lee Home Services (mobile and email on file, email as the way) and Sam's three blocks of Kim (S11-62). */
const KIM_RECORD = valuesWithId("seed-customer-blocked.json", "customers", "customer-kim-home-services");
const KIM_LIFTED = valuesWithId("seed-customer-blocked.json", "customer_blocks", "block-kim-number-oct20");
const KIM_NUMBER_BLOCK = valuesWithId(
  "seed-customer-blocked.json",
  "customer_blocks",
  "block-kim-number-oct26",
);
const KIM_ADDRESS_BLOCK = valuesWithId(
  "seed-customer-blocked.json",
  "customer_blocks",
  "block-kim-address-oct26",
);
/** The first-time sender's number, blocked at Lee's Barbershop the morning after their threat (A3-48). */
const FIRST_SENDER_BLOCK = valuesWithId(FIRST_SENDER_SEED, "customer_blocks", "block-first-sender-number");
/** Kim's record at Lee's Barbershop with her email on file: refuse-email-way-without-email without its one fault. */
const KIM_AT_BARBERSHOP: Values = {
  ...(refusedOf("invalid/refuse-email-way-without-email.json").values ?? {}),
  email_handle_id: "handle-kim-email",
};
/** Sam blocks Ben T.'s number at Lee Home Services in the portal, made here from Kim's open number block. */
const BEN_BLOCK: Values = {
  ...KIM_NUMBER_BLOCK,
  id: "block-probe-ben-number",
  person_id: BEN,
  phone_handle_id: "handle-ben",
  set_by_turn_id: null,
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

/** Updates the row of `table` whose id is `id`, setting `set` (or nothing more) and raising its version by one. */
function updateRow(
  table: string,
  id: Json | undefined,
  set: Values,
): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) =>
    Object.keys(set).length === 0
      ? tx<Record<string, unknown>[]>`
          update ${tx(table)} set version = version + 1 where ${whereOf(tx, { id: textOf(id) })} returning *
        `
      : tx<Record<string, unknown>[]>`
          update ${tx(table)} set ${tx(columnValues(tx, table, set))}, version = version + 1
          where ${whereOf(tx, { id: textOf(id) })}
          returning *
        `;
}

/** Sam lifts a block at `at`: lifted_at and who together, the version raised (S11-62). */
const liftBlock = (id: Json | undefined, at: string) =>
  updateRow("customer_blocks", id, { lifted_at: at, lifted_by_person_id: SAM });

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
 * the server in the column's own type (an instant as PostgreSQL reads both; bytes and text exactly).
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

/** Rows each of the two tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the two tables whose business_id is `businessId`, read as the owner. */
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

/** The ids each of the two tables shows the caller, in code-unit order. */
async function visibleIds(sql: Sql | Tx): Promise<Record<string, string[]>> {
  const ids: Record<string, string[]> = {};
  for (const table of OWN_TABLES) {
    const rows = await sql<{ id: string }[]>`select id from ${sql(table)}`;
    ids[table] = rows.map((row) => row.id).sort();
  }
  return ids;
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
  db = await createTestDatabase({ name: "customers" });
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

describe("the migration against the frozen table list (K-28 v1 customers)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
  };

  it("the table list names two tables, each scoped by business on business_id with no effective dates, both versioned on version", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [
          table.rowLevelSecurity.scope,
          table.rowLevelSecurity.column,
          table.versioned,
          table.versionColumn,
          table.effectiveDates,
        ],
        table.name,
      ).toEqual(["business", "business_id", true, "version", false]);
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

  it("each table raises its version on every update (0002's rule; README rule 2): <table>_version_raised, BEFORE UPDATE FOR EACH ROW, its only trigger; the part makes no function of its own", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual([
      ["customer_blocks", "customer_blocks_version_raised"],
      ["customers", "customers_version_raised"],
    ]);
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        "FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()",
      );
    }
    const functions = await db.sql<{ name: string }[]>`
      select proname as name from pg_proc
      where pronamespace = ${db.schema}::regnamespace and proname like 'customer%'
    `;
    expect(functions).toEqual([]);
  });

  it("neither table holds a phone number or an email address (README 'Which part owns what'): every contact column is a K-04 handle id of type text, and the only bytea column is the sealed address, sealed by its row's person_id, with no index on it", async () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(TABLES.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own
        // Whole words of the column's name, so no_voicemail is no email column.
        .filter(([key]) => /(^|_)(mobile|email|phone|number)(_|$)/.test(key.split(".")[1] ?? ""))
        .map(([key, type]) => `${key} ${type}`)
        .sort(),
    ).toEqual([
      "customer_blocks.phone_handle_id text",
      "customers.email_handle_id text",
      "customers.mobile_handle_id text",
    ]);
    expect(
      own
        .filter(([, type]) => type === "bytea")
        .map(([key]) => key)
        .sort(),
    ).toEqual(SEALED);
    expect(
      TABLES.flatMap((table) =>
        table.columns
          .filter((column) => column.sealedBy !== undefined)
          .map((column) => `${table.name}.${column.name} ${column.sealedBy ?? ""}`),
      ).sort(),
    ).toEqual(SEALED.map((key) => `${key} person_id`));
    // No index of the two names the sealed column (a match key would be a v1.1 column: README open gaps).
    const indexed = await db.sql<{ name: string; columns: string[] }[]>`
      select c.relname as name,
             array(select a.attname::text from unnest(i.indkey) as k(n)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n) as columns
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = ${`${db.schema}.customer_blocks`}::regclass
    `;
    expect(indexed.filter((index) => index.columns.includes("address"))).toEqual([]);
  });

  it("ids are text and every time is an instant (timestamptz): no date, time or timestamp without a zone (README rule 3)", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(
      own.filter(([key]) => key.endsWith(".id") || key.endsWith("_id")).every(([, type]) => type === "text"),
    ).toBe(true);
    expect(
      own.filter(([key]) => key.endsWith("_at")).every(([, type]) => type === "timestamp with time zone"),
    ).toBe(true);
    expect(
      own.filter(([, type]) =>
        ["date", "timestamp without time zone", "time without time zone"].includes(type),
      ),
    ).toEqual([]);
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

  it("the two refer only to K-04's businesses, persons, phones, person_handles and turns (rule 1): none to K-23 or K-29, a block never to a customer row (default 11), and no other part's table refers to these", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced
      from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and src.relnamespace = ${db.schema}::regnamespace and src.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(keys.map((key) => `${key.table} ${key.name} ${key.referenced}`).sort()).toEqual(
      TABLES.flatMap((table) =>
        table.foreignKeys.map((key) => `${table.name} ${key.name} ${key.references.table}`),
      ).sort(),
    );
    expect([...new Set(keys.map((key) => key.referenced))].sort()).toEqual(REFERRED);
    // A block names the business and the person, never a customer row (default 11): no key between the two.
    expect(keys.filter((key) => OWN_TABLES.includes(key.referenced))).toEqual([]);
    // No table of another part refers to these (README rule 1).
    const into = await db.sql<{ table: string }[]>`
      select src.relname as table from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
    `;
    expect(into).toEqual([]);
  });

  it("is recorded in schema_migrations as customers, after core_rls, consent, business_setup and documents_licenses", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("customers");
    for (const before of ["core_rls", "consent", "business_setup", "documents_licenses"]) {
      expect(names.indexOf("customers"), before).toBeGreaterThan(names.indexOf(before));
    }
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern; README rules 4 and 5)", () => {
  it("row-level security is on for both, and forced on neither", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
  });

  it("each holds 0012's two policies on business_id, <table>_tool_api for rosie_app and <table>_runtime for rosie_job, word for word (read from outbox_rows', which key on the same column)", async () => {
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

  it("table grants (DL-149, each to its named reader: the migration's header; README rule 5): both roles select, insert and update both tables, the same for each; no delete, truncate, references or trigger; nothing to PUBLIC or any other grantee", async () => {
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
  });

  it("no column grant on either table (README rule 5's grants are table grants): no grantee holds a privilege of its own on any column", async () => {
    const granted = await db.sql<{ table: string; column: string }[]>`
      select c.relname as table, a.attname as column
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attacl is not null
    `;
    expect(granted).toEqual([]);
  });
});

describe("the seed fixtures load (fixtures/index.json): the three of 02-contracts' K-28 row and the first-time sender's", () => {
  /** The K-28 rows the four seeds give together, per table (README "Checked on": 4 records, 4 blocks). */
  const SEEDED = { customer_blocks: 4, customers: 4 };

  it("the index lists four seeds (the card's three and the first-time sender's) and four refused rows, all K-28 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual([...CARD_SEEDS, FIRST_SENDER_SEED].sort());
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-calls-only-way.json",
      "invalid/refuse-cross-business-read.json",
      "invalid/refuse-email-way-without-email.json",
      "invalid/refuse-second-open-block.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of [...CARD_SEEDS, FIRST_SENDER_SEED]) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-28 row is stored as given`,
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

  it(
    "all four insert together, each after chain once: four records and four blocks, three of them open",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(SEEDS);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
      for (const row of SEED_ROWS) {
        await expectStored(row);
      }
      const [open] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from customer_blocks where lifted_at is null
    `;
      expect(open?.n).toBe(3);
    },
  );

  it(
    "they insert together with every K-04 v1, K-23 v1 and K-29 v1 seed as well, 32 seed files each read once: no K-28 row shares a key with another part's",
    SLOW,
    async () => {
      await reset();
      expect(OTHER_SEEDS.length).toBeGreaterThan(SEEDS.length);
      expect(filesRead([...OTHER_SEEDS, ...SEEDS]).size).toBe(32);
      const loaded = await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
    },
  );
});

describe("the seeded rows: what the four seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 120_000);

  it("Alex M. is on two businesses' lists as two records, never joined (RULES 4.10): at Lee's Barbershop as Alex's own AI booked it at 7:20pm Wed Oct 21 (texts, 18 or older); at the yoga studio texts only, the times Alex named, first name only, no voicemail and fee-free", async () => {
    const records = await db.sql<Record<string, unknown>[]>`
      select c.id, c.business_id as business, c.name, c.mobile_handle_id as mobile, c.email_handle_id as email,
             c.way, c.contact_times as times, c.first_name_only as "firstNameOnly", c.no_voicemail as "noVoicemail",
             c.age_band as "ageBand", c.fee_free as "feeFree", c.version,
             to_char(c.added_at at time zone b.time_zone, 'FMHH12:MIam Dy Mon FMDD') as added
      from customers c join businesses b on b.id = c.business_id
      where c.person_id = ${ALEX}
      order by c.added_at
    `;
    const contacts = {
      name: "Alex M.",
      mobile: "handle-alex",
      email: "handle-alex-email",
      ageBand: "18_or_older",
    };
    expect(records).toEqual([
      {
        id: ALEX_YOGA.id,
        business: YOGA_STUDIO,
        ...contacts,
        way: "textsonly",
        times: "Weekdays after 6pm",
        firstNameOnly: true,
        noVoicemail: true,
        feeFree: true,
        version: 2,
        added: "12:25pm Mon Oct 12",
      },
      {
        id: ALEX_BARBERSHOP.id,
        business: BARBERSHOP,
        ...contacts,
        way: "texts",
        times: null,
        firstNameOnly: false,
        noVoicemail: false,
        feeFree: false,
        version: 1,
        added: "7:20pm Wed Oct 21",
      },
    ]);
    // The contacts are K-04's: the mobile a phones row's handle, the email a handle of kind email, both Alex's own.
    const handles = await db.sql<{ id: string; kind: string; phone: boolean; own: boolean }[]>`
      select h.id, h.kind, exists (select 1 from phones p where p.handle_id = h.id) as phone,
             exists (select 1 from person_handles o where o.person_id = ${ALEX} and o.handle_id = h.id) as own
      from handles h where h.id in ('handle-alex', 'handle-alex-email')
      order by h.id
    `;
    expect(handles).toEqual([
      { id: "handle-alex", kind: "phone", phone: true, own: true },
      { id: "handle-alex-email", kind: "email", phone: false, own: true },
    ]);
    // No record holds the number or the address itself: they are the K-04 handles'.
    const copies = await db.sql<{ id: string }[]>`
      select c.id from customers c
      where row(c.*)::text like '%5555550101%' or row(c.*)::text like '%alex@example.com%'
    `;
    expect(copies).toEqual([]);
  });

  it("Tessa, added by the business (B3-08): her record at Lee Home Services (mobile on file, its phones row added as a Linq contact once saved, texts, 18 or older) with a live customer role, and her yes to texts as K-29's consent row for the booking, bound to the read-back's exact words and Sam's turn", async () => {
    const [record] = await db.sql<Record<string, unknown>[]>`
      select c.business_id as business, c.name, c.mobile_handle_id as mobile, c.email_handle_id as email, c.way,
             c.age_band as "ageBand", c.version, p.number, p.linq_contact_added_at >= c.added_at as "linqOnceSaved",
             exists (
               select 1 from person_roles r
               where r.person_id = c.person_id and r.business_id = c.business_id and r.role = 'customer'
                 and r.ended_at is null
             ) as "customerRole",
             to_char(c.added_at at time zone b.time_zone, 'FMHH12:MIam Dy Mon FMDD') as added
      from customers c
        join phones p on p.handle_id = c.mobile_handle_id
        join businesses b on b.id = c.business_id
      where c.id = ${textOf(TESSA_RECORD.id)}
    `;
    expect(record).toEqual({
      business: HOME_SERVICES,
      name: "Tessa",
      mobile: "handle-tessa",
      email: null,
      way: "texts",
      ageBand: "18_or_older",
      version: 1,
      number: "+15555550112",
      linqOnceSaved: true,
      customerRole: true,
      added: "10:12am Tue Oct 20",
    });
    const [yes] = await db.sql<Record<string, unknown>[]>`
      select k.kind, k.revoked, k.handle_id = c.mobile_handle_id as "coversTheMobile", k.business_id = c.business_id
               as "sameBusiness", g.business_id = c.business_id as "bookingThere", g.served_person_id as served,
             k.words_sha256 = encode(sha256(convert_to(k.exact_words, 'UTF8')), 'hex') as "hashOfWords",
             t.handle_id as "turnOf", k.channel,
             to_char(k.at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as at
      from consents k
        join customers c on c.person_id = k.person_id and c.business_id = k.business_id
        join bookings g on g.id = k.booking_id
        join turns t on t.id = k.turn_id
      where k.id = ${textOf(TESSA_CONSENT.id)}
    `;
    expect(yes).toEqual({
      kind: "texts",
      revoked: false,
      coversTheMobile: true,
      sameBusiness: true,
      bookingThere: true,
      served: TESSA,
      hashOfWords: true,
      turnOf: "handle-sam",
      channel: "text",
      at: "10:12am Tue Oct 20",
    });
    // The read-back's words are the fixture's, hashed the same way here, and carry how Tessa is reached and her age.
    const words = textOf(TESSA_CONSENT.exact_words);
    expect(sha256Hex(words)).toBe(TESSA_CONSENT.words_sha256);
    expect(words).toContain("For Tessa, 18 or older");
    expect(words).toContain("Tessa · mobile on file");
    // FS line 727's texts_ok_at is that consent row's at: no customer column repeats it (README default 5).
    expect(tableOf("customers").columns.map((column) => column.name)).not.toContain("texts_ok_at");
  });

  it("Kim (S11-62): Sam's number block in the portal at 11:00am Tue Oct 20, lifted the next morning, keeps its row; his number and address blocks told to the AI at 10:00am Mon Oct 26 both hold, the address sealed under Kim's key; so Kim is blocked at Lee Home Services and nowhere else", async () => {
    const blocks = await db.sql<Record<string, unknown>[]>`
      select b.id, b.business_id as business, b.target, b.phone_handle_id as phone, b.address is not null as sealed,
             b.set_by_person_id as "setBy", b.set_by_turn_id as turn, b.lifted_by_person_id as "liftedBy", b.version,
             to_char(b.set_at at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as set,
             to_char(b.lifted_at at time zone z.time_zone, 'FMHH12:MIam Dy Mon FMDD') as lifted
      from customer_blocks b join businesses z on z.id = b.business_id
      where b.person_id = ${KIM}
      order by b.set_at, b.target
    `;
    const shared = { business: HOME_SERVICES, setBy: SAM };
    expect(blocks).toEqual([
      {
        id: KIM_LIFTED.id,
        ...shared,
        target: "number",
        phone: "handle-kim",
        sealed: false,
        turn: null,
        liftedBy: SAM,
        version: 2,
        set: "11:00am Tue Oct 20",
        lifted: "9:30am Wed Oct 21",
      },
      {
        id: KIM_ADDRESS_BLOCK.id,
        ...shared,
        target: "address",
        phone: null,
        sealed: true,
        turn: "turn-sam-block-kim",
        liftedBy: null,
        version: 1,
        set: "10:00am Mon Oct 26",
        lifted: null,
      },
      {
        id: KIM_NUMBER_BLOCK.id,
        ...shared,
        target: "number",
        phone: "handle-kim",
        sealed: false,
        turn: "turn-sam-block-kim",
        liftedBy: null,
        version: 1,
        set: "10:00am Mon Oct 26",
        lifted: null,
      },
    ]);
    // FS line 727's blocked: whether an open row exists, per business. Kim's key, which seals the address, is held.
    const blocked = await db.sql<{ business: string; blocked: boolean }[]>`
      select z.id as business,
             exists (
               select 1 from customer_blocks b where b.business_id = z.id and b.person_id = ${KIM} and b.lifted_at is null
             ) as blocked
      from businesses z order by z.id
    `;
    expect(blocked.filter((row) => row.blocked).map((row) => row.business)).toEqual([HOME_SERVICES]);
    const [key] = await db.sql<{ held: boolean }[]>`
      select exists (select 1 from sealing_keys where person_id = ${KIM}) as held
    `;
    expect(key?.held).toBe(true);
    // Kim's record names the email as the way, with both contacts on file (A4-82: every message and link by email).
    expect(
      await db.sql`select way, mobile_handle_id, email_handle_id from customers where person_id = ${KIM}`,
    ).toEqual([
      {
        way: KIM_RECORD.way,
        mobile_handle_id: KIM_RECORD.mobile_handle_id,
        email_handle_id: KIM_RECORD.email_handle_id,
      },
    ]);
  });

  it("A3-48's first-time sender: nothing booked, so no customer row, no customer role and no name on file, only their K-04 person, handle and phone row with the chat open since 9:40pm Thu Oct 22; Sam's block of their number the next morning names the barbershop and the person", async () => {
    const [sender] = await db.sql<Record<string, unknown>[]>`
      select p.name, ph.chat_open as "chatOpen",
             to_char(ph.chat_open_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as "firstText",
             (select count(*)::int from customers c where c.person_id = p.id) as records,
             (select count(*)::int from person_roles r where r.person_id = p.id) as roles
      from persons p
        join person_handles o on o.person_id = p.id
        join phones ph on ph.handle_id = o.handle_id
      where p.id = ${FIRST_SENDER}
    `;
    expect(sender).toEqual({
      name: null,
      chatOpen: true,
      firstText: "9:40pm Thu Oct 22",
      records: 0,
      roles: 0,
    });
    const [block] = await db.sql<Record<string, unknown>[]>`
      select b.business_id as business, b.person_id as person, b.target, b.phone_handle_id as phone,
             b.lifted_at is null as open, b.set_by_person_id as "setBy", t.handle_id as "turnOf",
             to_char(b.set_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as set
      from customer_blocks b join turns t on t.id = b.set_by_turn_id
      where b.id = ${textOf(FIRST_SENDER_BLOCK.id)}
    `;
    expect(block).toEqual({
      business: BARBERSHOP,
      person: FIRST_SENDER,
      target: "number",
      phone: "handle-first-sender",
      open: true,
      setBy: SAM,
      turnOf: "handle-sam",
      set: "8:05am Fri Oct 23",
    });
  });

  it("code's rules across tables (README rule 7), held by the seeds: every record comes with a live customer role at its business, every email on file is a handle of kind email, and every mobile and blocked number a phone handle with its phones row", async () => {
    const withoutRole = await db.sql<{ id: string }[]>`
      select c.id from customers c
      where not exists (
        select 1 from person_roles r
        where r.person_id = c.person_id and r.business_id = c.business_id and r.role = 'customer' and r.ended_at is null
      )
    `;
    expect(withoutRole).toEqual([]);
    const kinds = await db.sql<{ contact: string; kind: string; phone: boolean; n: number }[]>`
      select x.contact, h.kind, exists (select 1 from phones p where p.handle_id = h.id) as phone, count(*)::int as n
      from (
        select 'email' as contact, email_handle_id as handle from customers where email_handle_id is not null
        union all
        select 'mobile', mobile_handle_id from customers where mobile_handle_id is not null
        union all
        select 'blocked number', phone_handle_id from customer_blocks where phone_handle_id is not null
      ) x join handles h on h.id = x.handle
      group by 1, 2, 3
      order by 1
    `;
    expect(kinds).toEqual([
      { contact: "blocked number", kind: "phone", phone: true, n: 3 },
      { contact: "email", kind: "email", phone: false, n: 3 },
      { contact: "mobile", kind: "phone", phone: true, n: 4 },
    ]);
  });
});

describe("row-level security per business on the two tables, every K-04, K-23, K-29 and K-28 seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
  }, 120_000);

  it(
    "with no scope the Tool API reads no row of the two; each business's scope shows exactly its own rows: the yoga studio only its own record of Alex M., the barbershop only its own and the first-time sender's block, Lee Home Services Kim, Tessa and Kim's three blocks",
    SLOW,
    async () => {
      const none = { customer_blocks: [], customers: [] };
      expect(await as(TOOL_API, null, visibleIds)).toEqual(none);
      const businesses = await businessIds();
      expect(businesses).toEqual(expect.arrayContaining([BARBERSHOP, HOME_SERVICES, YOGA_STUDIO]));
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await as(TOOL_API, YOGA_STUDIO, visibleIds)).toEqual({
        customer_blocks: [],
        customers: [ALEX_YOGA.id],
      });
      expect(await as(TOOL_API, BARBERSHOP, visibleIds)).toEqual({
        customer_blocks: [FIRST_SENDER_BLOCK.id],
        customers: [ALEX_BARBERSHOP.id],
      });
      expect(await as(TOOL_API, HOME_SERVICES, visibleIds)).toEqual({
        customer_blocks: [KIM_ADDRESS_BLOCK.id, KIM_LIFTED.id, KIM_NUMBER_BLOCK.id],
        customers: [KIM_RECORD.id, TESSA_RECORD.id],
      });
    },
  );

  it(
    "the runtime side with no scope reads all four records and four blocks (the jobs that work by person or handle); with a scope set (per write), only that business's",
    SLOW,
    async () => {
      expect(await as(RUNTIME, null, visibleRows)).toEqual({ customer_blocks: 4, customers: 4 });
      for (const business of await businessIds()) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      // Alex's records across businesses, read by person (customers_person_idx's read: the 45-day copy or delete).
      const alex = await as(
        RUNTIME,
        null,
        (tx) => tx<{ id: string }[]>`select id from customers where person_id = ${ALEX}`,
      );
      expect(alex.map((row) => row.id).sort()).toEqual([ALEX_BARBERSHOP.id, ALEX_YOGA.id].sort());
    },
  );

  it("the record on file for a proven mobile is the business's own (S13-45; RULES 4.10): Alex's mobile finds the barbershop's record in its scope, the yoga studio's in its own, and none at Lee Home Services; an open block of a number holds only at its business", async () => {
    const byMobile = (tx: Tx) =>
      tx<{ id: string }[]>`select id from customers where mobile_handle_id = 'handle-alex'`;
    expect(await as(TOOL_API, BARBERSHOP, byMobile)).toEqual([{ id: ALEX_BARBERSHOP.id }]);
    expect(await as(TOOL_API, YOGA_STUDIO, byMobile)).toEqual([{ id: ALEX_YOGA.id }]);
    expect(await as(TOOL_API, HOME_SERVICES, byMobile)).toEqual([]);
    const openBlock = (handle: string) => (tx: Tx) =>
      tx<{ id: string }[]>`
        select id from customer_blocks where phone_handle_id = ${handle} and lifted_at is null
      `;
    expect(await as(TOOL_API, HOME_SERVICES, openBlock("handle-kim"))).toEqual([{ id: KIM_NUMBER_BLOCK.id }]);
    expect(await as(TOOL_API, BARBERSHOP, openBlock("handle-kim"))).toEqual([]);
    expect(await as(TOOL_API, BARBERSHOP, openBlock("handle-first-sender"))).toEqual([
      { id: FIRST_SENDER_BLOCK.id },
    ]);
    expect(await as(TOOL_API, HOME_SERVICES, openBlock("handle-first-sender"))).toEqual([]);
  });

  it("the Tool API writes only its scope's rows: the yoga studio's record of Kim and its block of her number are refused under the barbershop's scope (42501) and stored under its own; an update of another business's record or block finds no row", async () => {
    const writes: [string, Values][] = [
      ["customers", { ...KIM_AT_BARBERSHOP, id: "customer-probe-kim-yoga", business_id: YOGA_STUDIO }],
      [
        "customer_blocks",
        {
          ...BEN_BLOCK,
          id: "block-probe-yoga-kim",
          business_id: YOGA_STUDIO,
          person_id: KIM,
          phone_handle_id: "handle-kim",
        },
      ],
    ];
    for (const [table, row] of writes) {
      const outcome = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, table, row)));
      expect([outcome.code, outcome.message], table).toEqual([
        "42501",
        `new row violates row-level security policy for table "${table}"`,
      ]);
      expect(await as(TOOL_API, YOGA_STUDIO, (tx) => insertReturning(tx, table, row)), table).toHaveLength(1);
    }
    const markFeeFree = updateRow("customers", ALEX_BARBERSHOP.id, { fee_free: true });
    expect(await as(TOOL_API, YOGA_STUDIO, markFeeFree)).toHaveLength(0);
    expect(await as(TOOL_API, BARBERSHOP, markFeeFree)).toHaveLength(1);
    const lift = liftBlock(KIM_NUMBER_BLOCK.id, "2026-10-27T13:00:00Z");
    expect(await as(TOOL_API, BARBERSHOP, lift)).toHaveLength(0);
    expect(await as(TOOL_API, HOME_SERVICES, lift)).toHaveLength(1);
  });

  it("the Tool API cannot move a record to another business, or write with no scope", async () => {
    const move = (tx: Tx) =>
      tx`update customers set business_id = ${YOGA_STUDIO}, version = version + 1 where id = ${textOf(ALEX_BARBERSHOP.id)}`;
    const moved = await refusal(as(TOOL_API, BARBERSHOP, move));
    expect([moved.code, moved.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "customers"',
    ]);
    for (const [table, values] of [
      ["customers", KIM_AT_BARBERSHOP],
      ["customer_blocks", { ...BEN_BLOCK, business_id: BARBERSHOP }],
    ] as const) {
      expect(
        (await refusal(as(TOOL_API, null, (tx) => insertReturning(tx, table, values)))).code,
        table,
      ).toBe("42501");
    }
  });

  it("the runtime side scoped to one business (per write) cannot write another's record or block; scoped to its own, or with no scope, it writes them", async () => {
    for (const [table, values, own] of [
      ["customers", KIM_AT_BARBERSHOP, BARBERSHOP],
      ["customer_blocks", BEN_BLOCK, HOME_SERVICES],
    ] as const) {
      const outcome = await refusal(as(RUNTIME, YOGA_STUDIO, insertEach([table, values])));
      expect(outcome.code, table).toBe("42501");
      expect(await as(RUNTIME, own, insertEach([table, values])), table).toHaveLength(1);
      expect(await as(RUNTIME, null, insertEach([table, values])), table).toHaveLength(1);
    }
  });

  it("every update of either table raises its version by exactly one, under either role: one that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const [table, id, business] of [
      ["customers", ALEX_YOGA.id, YOGA_STUDIO],
      ["customer_blocks", KIM_NUMBER_BLOCK.id, HOME_SERVICES],
    ] as const) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const kept = await refusal(
          as(role, scope, (tx) => tx`update ${tx(table)} set version = version where id = ${textOf(id)}`),
        );
        expect([kept.code, kept.constraint], `${role} ${table}`).toEqual([
          "23514",
          `${table}_version_raised`,
        ]);
        const raised = await as(
          role,
          scope,
          (tx) => tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where id = ${textOf(id)} returning version
          `,
        );
        const before = table === "customers" ? 2 : 1;
        expect(raised, `${role} ${table}`).toEqual([{ version: before + 1 }]);
      }
    }
  });
});

describe("who may do what, by privilege (README rule 5): the same for both roles, every seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
  }, 120_000);

  it("under its scope the Tool API marks Alex fee-free with email as the way in one update, takes Tessa's number off as staff do in person (no contact, no way), and Sam lifts Kim's open number block and the first-time sender's, each raising the version", async () => {
    const atBarbershop = await as(TOOL_API, BARBERSHOP, async (tx) => {
      const [alex] = await updateRow("customers", ALEX_BARBERSHOP.id, { fee_free: true, way: "email" })(tx);
      const [sender] = await liftBlock(FIRST_SENDER_BLOCK.id, "2026-10-24T13:00:00Z")(tx);
      return {
        alex: [alex?.fee_free, alex?.way, alex?.version],
        sender: [sender?.lifted_by_person_id, sender?.version],
      };
    });
    expect(atBarbershop).toEqual({ alex: [true, "email", 2], sender: [SAM, 2] });
    const atHomeServices = await as(TOOL_API, HOME_SERVICES, async (tx) => {
      const [tessa] = await updateRow("customers", TESSA_RECORD.id, { mobile_handle_id: null, way: null })(
        tx,
      );
      const [kim] = await liftBlock(KIM_NUMBER_BLOCK.id, "2026-10-27T13:00:00Z")(tx);
      const open = await tx<{ id: string }[]>`select id from customer_blocks where lifted_at is null`;
      return {
        tessa: [tessa?.mobile_handle_id, tessa?.way, tessa?.version],
        kim: kim?.version,
        open: open.map((row) => row.id),
      };
    });
    expect(atHomeServices).toEqual({ tessa: [null, null, 2], kim: 2, open: [KIM_ADDRESS_BLOCK.id] });
  });

  it("no role deletes a record or a block (42501): records are kept (RULES 4.10), and a lifted block keeps its row (S11-62)", async () => {
    const rows: [string, Json | undefined, string][] = [
      ["customers", ALEX_BARBERSHOP.id, BARBERSHOP],
      ["customer_blocks", KIM_LIFTED.id, HOME_SERVICES],
    ];
    for (const [table, id, business] of rows) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(
          as(role, scope, (tx) => tx`delete from ${tx(table)} where id = ${textOf(id)}`),
        );
        expect([outcome.code, outcome.message], `${role} ${table}`).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    }
  });

  it("both roles insert into both: under the barbershop's scope, or on the runtime side, Kim's record at the barbershop with her email on file and a block of her number there; under Lee Home Services' scope, a block of Ben T., who has no customer row there", async () => {
    const kimAtBarbershop = insertEach(
      ["customers", KIM_AT_BARBERSHOP],
      [
        "customer_blocks",
        {
          ...BEN_BLOCK,
          id: "block-probe-kim-barbershop",
          business_id: BARBERSHOP,
          person_id: KIM,
          phone_handle_id: "handle-kim",
        },
      ],
    );
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      expect(await as(role, scope, kimAtBarbershop), role).toMatchObject([
        { id: "block-probe-kim-barbershop" },
      ]);
    }
    for (const [role, scope] of [
      [TOOL_API, HOME_SERVICES],
      [RUNTIME, null],
    ] as const) {
      expect(await as(role, scope, insertEach(["customer_blocks", BEN_BLOCK])), role).toMatchObject([
        { id: BEN_BLOCK.id, person_id: BEN },
      ]);
    }
  });

  it("the Tool API reaches neither K-04's handles and phones nor the keys that seal an address: under Lee Home Services' scope, each is refused (42501), though its records and blocks name them by key", async () => {
    for (const table of ["handles", "phones", "sealing_keys"]) {
      const refused = await refusal(as(TOOL_API, HOME_SERVICES, (tx) => countRows(tx, table)));
      expect([refused.code, refused.message], table).toEqual([
        "42501",
        `permission denied for table ${table}`,
      ]);
    }
  });
});

describe("the sealed address (README rule 6; T-182's sealing): sealed under the blocked person's key, the row holds only the sealed bytes, and erasing the key leaves it unreadable", () => {
  const wrappingKey = randomBytes(32);
  const keys: WrappingKeys = { resolve: () => new Uint8Array(wrappingKey) };
  /** A stand-in for a street address for home visits: never a real address. */
  const STAND_IN = "a stand-in street address for Tessa's home visits, not real";

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

  it("Sam blocks Tessa's address at Lee Home Services on the runtime side: the address sealed under Tessa's own new key is the row's only copy, opens for her and not as another person's, and not at all once her key is erased", async () => {
    const outcome = await as(RUNTIME, null, async (tx) => {
      const sealed = await seal(tx, keys, TESSA, STAND_IN);
      const block = {
        ...columnValues(tx, "customer_blocks", {
          ...KIM_ADDRESS_BLOCK,
          id: "block-probe-tessa-address",
          person_id: TESSA,
          set_by_turn_id: null,
        }),
        address: sealed as never,
      };
      const [row] = await tx<{ address: Uint8Array; target: string }[]>`
        insert into customer_blocks ${tx(block)} returning address, target
      `;
      const stored = new Uint8Array(row?.address ?? new Uint8Array());
      // Each byte as one character, so a search for the stand-in's bytes matches only at a byte boundary.
      const asChars = (bytes: Uint8Array): string =>
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
      const plainInRow = asChars(stored).includes(asChars(new TextEncoder().encode(STAND_IN)));
      const [copies] = await tx<{ n: number }[]>`
        select count(*)::int as n from customer_blocks b where row(b.*)::text like ${`%${STAND_IN}%`}
      `;
      const opened = await unsealText(tx, keys, TESSA, stored);
      // The first-time sender gets a key of their own; Tessa's sealed address does not open as theirs.
      await seal(tx, keys, FIRST_SENDER, "a stand-in value of the first-time sender's");
      const asOther = await sealingCode(unsealText(tx, keys, FIRST_SENDER, stored));
      const erased = await erasePerson(tx, TESSA);
      const afterErase = await sealingCode(unsealText(tx, keys, TESSA, stored));
      return {
        target: row?.target,
        plainInRow,
        copies: copies?.n,
        opened,
        asOther,
        erased: erased.ok,
        afterErase,
      };
    });
    expect(outcome).toEqual({
      target: "address",
      plainInRow: false,
      copies: 0,
      opened: STAND_IN,
      asOther: "cannot_open",
      erased: true,
      afterErase: "erased",
    });
  });
});

interface Probe {
  /** What the sources refuse, or allow. */
  name: string;
  /** The writes, in one transaction as the runtime side with no scope, then rolled back; gives back the last row. */
  run: (tx: Tx) => Promise<readonly unknown[]>;
  /** The refusal: its SQLSTATE and the constraint that names it (one of these); absent, the writes pass. */
  refused?: { code: string; constraintOneOf: string[] };
}

const check = (...constraintOneOf: string[]) => ({ code: "23514", constraintOneOf });
const foreignKey = (name: string) => ({ code: "23503", constraintOneOf: [name] });
const repeated = (name: string) => ({ code: "23505", constraintOneOf: [name] });
const insertCustomer = (values: Values) => insertEach(["customers", values]);
const insertBlock = (values: Values) => insertEach(["customer_blocks", values]);
/** Kim's record at the barbershop with one change (a probe of one rule). */
const kimAtBarbershop = (change: Values) => insertCustomer({ ...KIM_AT_BARBERSHOP, ...change });
/** A block of Kim at Lee Home Services made from her open address block, with one change and its own id. */
const kimBlock = (id: string, change: Values) => insertBlock({ ...KIM_ADDRESS_BLOCK, id, ...change });
/** Removes one of a person's handle links, as K-05 item 29 does on the runtime side. */
const unlinkHandle = (person: string, handle: string) => (tx: Tx) =>
  tx`delete from person_handles where person_id = ${person} and handle_id = ${handle} returning person_id`;

/** One-rule probes (README "Checked on", round 2's 45, and one per rule beyond them): each refused by its rule, or passed. */
const PROBES: Probe[] = [
  {
    name: "a second record of Alex M. at Lee's Barbershop is refused (one record per person at each business)",
    run: insertCustomer({ ...ALEX_BARBERSHOP, id: "customer-probe-alex-second" }),
    refused: repeated("customers_business_person_key"),
  },
  {
    name: "texts with no mobile on file is refused",
    run: kimAtBarbershop({ mobile_handle_id: null, way: "texts" }),
    refused: check("customers_way_fits_contact"),
  },
  {
    name: "texts only with no mobile on file is refused",
    run: kimAtBarbershop({ mobile_handle_id: null, way: "textsonly" }),
    refused: check("customers_way_fits_contact"),
  },
  {
    name: "no way with a contact on file is refused",
    run: kimAtBarbershop({ way: null }),
    refused: check("customers_way_fits_contact"),
  },
  {
    name: "a way with no contact on file is refused",
    run: kimAtBarbershop({ mobile_handle_id: null, email_handle_id: null, way: "email" }),
    refused: check("customers_way_fits_contact"),
  },
  {
    name: "no contact and no way passes (a customer the business booked with no mobile: A3-19)",
    run: kimAtBarbershop({ mobile_handle_id: null, email_handle_id: null, way: null }),
  },
  {
    name: "email as the way with only an email on file passes",
    run: kimAtBarbershop({ mobile_handle_id: null }),
  },
  { name: "texts only with the mobile on file passes (Q-07)", run: kimAtBarbershop({ way: "textsonly" }) },
  { name: "texts with the mobile on file passes", run: kimAtBarbershop({ way: "texts" }) },
  { name: "under 18 passes", run: kimAtBarbershop({ age_band: "under_18" }) },
  { name: "no age band (not asked) passes", run: kimAtBarbershop({ age_band: null }) },
  {
    name: "an sms way is refused",
    run: kimAtBarbershop({ way: "sms" }),
    refused: check("customers_way_known"),
  },
  {
    name: "calls only is refused (Q-07; MC C2)",
    run: kimAtBarbershop({ way: "callsonly" }),
    refused: check("customers_way_known"),
  },
  {
    name: "an exact age is refused (A4-80: never a child's exact age)",
    run: kimAtBarbershop({ age_band: "17" }),
    refused: check("customers_age_band_known"),
  },
  {
    name: "a blank name is refused",
    run: kimAtBarbershop({ name: "  " }),
    refused: check("customers_name_given"),
  },
  {
    name: "blank contact times are refused",
    run: kimAtBarbershop({ contact_times: " " }),
    refused: check("customers_contact_times_given"),
  },
  {
    name: "the times a customer named, first name only and no voicemail pass",
    run: kimAtBarbershop({ contact_times: "Weekdays after 6pm", first_name_only: true, no_voicemail: true }),
  },
  {
    name: "someone else's mobile is refused (Alex's, named on Kim's record)",
    run: kimAtBarbershop({ mobile_handle_id: "handle-alex" }),
    refused: foreignKey("customers_mobile_own_fk"),
  },
  {
    name: "someone else's email is refused (Alex's, named on Kim's record)",
    run: kimAtBarbershop({ email_handle_id: "handle-alex-email" }),
    refused: foreignKey("customers_email_own_fk"),
  },
  {
    name: "an email handle as the mobile is refused (it has no phones row)",
    run: kimAtBarbershop({ mobile_handle_id: "handle-kim-email" }),
    refused: foreignKey("customers_mobile_phone_fk"),
  },
  {
    name: "an email on file naming Kim's own mobile handle passes the schema: its kind is code's to check (rule 7; README open gaps)",
    run: kimAtBarbershop({ email_handle_id: "handle-kim" }),
  },
  {
    name: "an unknown business is refused",
    run: kimAtBarbershop({ business_id: "biz-nobody" }),
    refused: foreignKey("customers_business_fk"),
  },
  {
    name: "an unknown person is refused",
    run: kimAtBarbershop({
      person_id: "person-nobody",
      mobile_handle_id: null,
      email_handle_id: null,
      way: null,
    }),
    refused: foreignKey("customers_person_fk"),
  },
  {
    name: "fee-free and a new way set at once, with the version raised, pass (A7-98: on the same contact, set at once)",
    run: updateRow("customers", ALEX_BARBERSHOP.id, { fee_free: true, way: "email" }),
  },
  {
    name: "staff taking Tessa's number off in person, leaving no contact and no way, passes (S13-19)",
    run: updateRow("customers", TESSA_RECORD.id, { mobile_handle_id: null, way: null }),
  },
  {
    name: "taking Tessa's number off while texts stays the way is refused",
    run: updateRow("customers", TESSA_RECORD.id, { mobile_handle_id: null }),
    refused: check("customers_way_fits_contact"),
  },
  {
    name: "Kim's way switched from email to texts, with both her contacts on file, passes (A7-98: a change on the same contact is set at once)",
    run: updateRow("customers", KIM_RECORD.id, { way: "texts" }),
  },
  {
    name: "removing Alex's email handle link while a record names it is refused (K-05 item 29 must not orphan the email on file)",
    run: unlinkHandle(ALEX, "handle-alex-email"),
    refused: foreignKey("customers_email_own_fk"),
  },
  {
    name: "removing the first-time sender's number link while a block names it is refused",
    run: unlinkHandle(FIRST_SENDER, "handle-first-sender"),
    refused: foreignKey("customer_blocks_phone_own_fk"),
  },
  {
    name: "a number block of Ben T. at Lee Home Services, who has no customer row there, passes (default 11)",
    run: insertBlock(BEN_BLOCK),
  },
  {
    name: "an address block of the first-time sender passes",
    run: insertBlock({
      ...KIM_ADDRESS_BLOCK,
      id: "block-probe-first-sender-address",
      business_id: BARBERSHOP,
      person_id: FIRST_SENDER,
      set_by_turn_id: "turn-sam-block-first-sender",
    }),
  },
  {
    name: "a second open address block of Kim passes (an address is sealed: no key compares two)",
    run: kimBlock("block-probe-kim-address-2", {}),
  },
  {
    name: "another customer's number block passes (Tessa's, beside Kim's open one)",
    run: kimBlock("block-probe-tessa-number", {
      person_id: TESSA,
      target: "number",
      phone_handle_id: "handle-tessa",
      address: null,
    }),
  },
  {
    name: "a second open block of the first-time sender's number is refused",
    run: insertBlock({ ...FIRST_SENDER_BLOCK, id: "block-probe-first-sender-2" }),
    refused: repeated("customer_blocks_one_open_number"),
  },
  {
    name: "a second block of Kim's number, lifted, passes (only an open block is one per number)",
    run: insertBlock({ ...KIM_LIFTED, id: "block-probe-kim-lifted-2" }),
  },
  {
    name: "the same number blocked at another business passes (a block holds only at its business)",
    run: insertBlock({
      ...FIRST_SENDER_BLOCK,
      id: "block-probe-first-sender-home",
      business_id: HOME_SERVICES,
    }),
  },
  {
    name: "a block naming an unknown person is refused",
    run: kimBlock("block-probe-nobody", { person_id: "person-nobody" }),
    refused: foreignKey("customer_blocks_person_fk"),
  },
  {
    name: "a block naming an unknown business is refused",
    run: kimBlock("block-probe-no-business", { business_id: "biz-nobody" }),
    refused: foreignKey("customer_blocks_business_fk"),
  },
  {
    name: "a number that is not the person's own is refused (Alex's, named for Kim)",
    run: kimBlock("block-probe-kim-alex-number", {
      target: "number",
      phone_handle_id: "handle-alex",
      address: null,
    }),
    refused: foreignKey("customer_blocks_phone_own_fk"),
  },
  {
    name: "the first-time sender's number named for Kim is refused",
    run: kimBlock("block-probe-kim-sender-number", {
      target: "number",
      phone_handle_id: "handle-first-sender",
      address: null,
    }),
    refused: foreignKey("customer_blocks_phone_own_fk"),
  },
  {
    name: "an email handle as the number is refused (it has no phones row)",
    run: kimBlock("block-probe-kim-email-number", {
      target: "number",
      phone_handle_id: "handle-kim-email",
      address: null,
    }),
    refused: foreignKey("customer_blocks_phone_fk"),
  },
  {
    name: "an unknown turn is refused",
    run: kimBlock("block-probe-no-turn", { set_by_turn_id: "turn-nobody" }),
    refused: foreignKey("customer_blocks_turn_fk"),
  },
  {
    name: "a block set by an unknown person is refused",
    run: kimBlock("block-probe-no-setter", { set_by_person_id: "person-nobody" }),
    refused: foreignKey("customer_blocks_set_by_fk"),
  },
  {
    name: "a lift by an unknown person is refused",
    run: insertBlock({ ...KIM_LIFTED, id: "block-probe-no-lifter", lifted_by_person_id: "person-nobody" }),
    refused: foreignKey("customer_blocks_lifted_by_fk"),
  },
  {
    name: "a block set in the portal, with no turn, passes",
    run: kimBlock("block-probe-portal", { set_by_turn_id: null }),
  },
  {
    name: "a number block without its number is refused",
    run: insertBlock({ ...KIM_NUMBER_BLOCK, id: "block-probe-no-number", phone_handle_id: null }),
    refused: check("customer_blocks_one_target"),
  },
  {
    name: "a number block that also holds an address is refused",
    run: insertBlock({
      ...KIM_LIFTED,
      id: "block-probe-number-and-address",
      address: KIM_ADDRESS_BLOCK.address ?? null,
    }),
    refused: check("customer_blocks_one_target"),
  },
  {
    name: "an address block naming a number is refused",
    run: kimBlock("block-probe-address-number", {
      business_id: BARBERSHOP,
      set_by_turn_id: null,
      phone_handle_id: "handle-kim",
    }),
    refused: check("customer_blocks_one_target"),
  },
  {
    name: "an address block with no address is refused",
    run: kimBlock("block-probe-no-address", { address: null }),
    refused: check("customer_blocks_one_target"),
  },
  {
    name: "a block of an email (target email) is refused: a number, or an address for home visits",
    run: kimBlock("block-probe-email-target", { target: "email" }),
    refused: check("customer_blocks_target_known"),
  },
  {
    name: "a lift without who is refused",
    run: insertBlock({ ...KIM_LIFTED, id: "block-probe-lift-no-who", lifted_by_person_id: null }),
    refused: check("customer_blocks_lifted_together"),
  },
  {
    name: "who lifted it without when is refused",
    run: insertBlock({ ...BEN_BLOCK, id: "block-probe-who-no-when", lifted_by_person_id: SAM }),
    refused: check("customer_blocks_lifted_together"),
  },
  {
    name: "a lift before the block is refused",
    run: insertBlock({ ...KIM_LIFTED, id: "block-probe-lift-early", lifted_at: "2026-10-20T14:00:00Z" }),
    refused: check("customer_blocks_lifted_after_set"),
  },
  {
    name: "Sam lifting Kim's open number block passes, with the version raised (S11-62: at any time)",
    run: liftBlock(KIM_NUMBER_BLOCK.id, "2026-10-27T13:00:00Z"),
  },
  {
    name: "a lift moved before its block is refused",
    run: updateRow("customer_blocks", KIM_LIFTED.id, { lifted_at: "2026-10-19T13:30:00Z" }),
    refused: check("customer_blocks_lifted_after_set"),
  },
];

describe("one-rule probes as the runtime side, every K-04, K-23, K-29 and K-28 seed loaded: each refused by the rule it names, or passed as the sources allow", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
  }, 120_000);

  for (const probe of PROBES) {
    const { refused } = probe;
    if (refused === undefined) {
      it(probe.name, async () => {
        expect(await as(RUNTIME, null, probe.run)).toHaveLength(1);
      });
    } else {
      it(`${probe.name} (${refused.constraintOneOf.join(" or ")}, ${refused.code})`, async () => {
        const outcome = await refusal(as(RUNTIME, null, probe.run));
        expect(outcome.code).toBe(refused.code);
        expect(refused.constraintOneOf).toContain(outcome.constraint);
      });
    }
  }
});

/**
 * Each refused fixture with its one fault removed: K-28's README names what passes once it is fixed. A fix is a value
 * changed (`fixed`), the scope that may read it, or a write made first in the same transaction.
 */
const REFUSED_CASES: {
  file: string;
  fixed: Values;
  fixedScope?: string;
  first?: (tx: Tx) => Promise<unknown>;
  without: string;
}[] = [
  {
    file: "invalid/refuse-calls-only-way.json",
    fixed: { way: "textsonly" },
    without: "the same update to texts only",
  },
  {
    file: "invalid/refuse-email-way-without-email.json",
    fixed: { email_handle_id: "handle-kim-email" },
    without: "the same row with Kim's email on file",
  },
  {
    file: "invalid/refuse-cross-business-read.json",
    fixed: {},
    fixedScope: BARBERSHOP,
    without: "the same read in the barbershop's own scope",
  },
  {
    file: "invalid/refuse-second-open-block.json",
    fixed: {},
    first: liftBlock(KIM_NUMBER_BLOCK.id, "2026-10-27T12:00:00Z"),
    without: "the same block once the first is lifted",
  },
];

for (const { file, fixed, fixedScope, first, without } of REFUSED_CASES) {
  describe(`${file}: refused for its one reason`, () => {
    const refused = refusedOf(file);
    const role = roleOf(refused);
    const attempt =
      (change: Values) =>
      async (tx: Tx): Promise<readonly Record<string, unknown>[]> => {
        if (refused.action === "insert") {
          return insertReturning(tx, refused.table, { ...(refused.values ?? {}), ...change });
        }
        if (refused.action === "update") {
          return tx<Record<string, unknown>[]>`
            update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, { ...(refused.set ?? {}), ...change }))}
            where ${whereOf(tx, refused.where ?? {})}
            returning *
          `;
        }
        return tx<
          Record<string, unknown>[]
        >`select * from ${tx(refused.table)} where ${whereOf(tx, refused.where ?? {})}`;
      };

    beforeAll(async () => {
      await reset();
      await loadFixtures([file]);
    }, 120_000);

    const how =
      refused.expect.rows !== undefined
        ? `${String(refused.expect.rows)} rows`
        : `${refused.expect.sqlstate ?? "?"}${refused.expect.constraintOneOf === undefined ? "" : ` by ${refused.expect.constraintOneOf.join(" or ")}`}`;

    it(`the fixture: ${refused.role} ${refused.action}s ${refused.table}; refused with ${how}`, async () => {
      expect(["insert", "update", "select"]).toContain(refused.action);
      const scope = refused.scope?.businessId ?? null;
      if (refused.expect.rows !== undefined) {
        // The row is there: the owner reads it, so no row is the scope's doing.
        expect(await asOwner(attempt({}))).toHaveLength(1);
        expect(await as(role, scope, attempt({}))).toHaveLength(refused.expect.rows);
        return;
      }
      const outcome = await refusal(as(role, scope, attempt({})));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      const done = await as(role, fixedScope ?? refused.scope?.businessId ?? null, async (tx) => {
        if (first !== undefined) {
          await first(tx);
        }
        return attempt(fixed)(tx);
      });
      const id = refused.action === "insert" ? refused.values?.id : refused.where?.id;
      expect(done.map((row) => row.id)).toEqual([textOf(id)]);
    });
  });
}
