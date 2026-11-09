// T-209: the platform billing part (K-33 v1: bill_cards, monthly_bills and monthly_bill_lines, with README rules 1 to
// 5) against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/platform-billing`). The schema
// comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: the monthly billing job, the
// charge's and pay link's results, the pause, Rosie's team's answer) runs in its own transaction under SET LOCAL ROLE,
// scoped by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are loaded the same way, as the
// runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-33 v1's seeds and refused rows and the K-04 and K-23 seeds their after
// chains name (Lee's Barbershop, Lee Home Services, the yoga studio, the movers and the master's sample cast: Sam Lee,
// Riley, Avery, Maya, Jordan, Alex M., Ben T. and Owen H.). A row made here is a fixture row under a new id, or with one
// fault. The Stripe ids are the fixtures' opaque stand-ins. No seed names a member of Rosie's team (Q-18's members are
// real people), so the team's answers here name a stand-in person row made here; refuse-owner-removes-line's answer on
// the runtime side keeps the fixture's own values.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/platform-billing/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The three tables, in code-unit order (as PostgreSQL orders a relation's name): all scoped by business, all versioned. */
const OWN_TABLES = ["bill_cards", "monthly_bill_lines", "monthly_bills"];
/** The seeds 02-contracts' K-33 row names, which the card's proof loads. */
const CARD_SEEDS = ["seed-bill-card.json", "seed-monthly-bill.json"];
/** The other parts' tables the three refer to by their keys (README rule 1): K-04's and K-07's effects, never K-23's. */
const REFERRED = ["bookings", "businesses", "effects", "persons"];
/** What the Tool API may change of a card, and of a line (README rule 2): its UPDATE column grants. */
const CARD_UPDATE = ["removed_at", "version"];
const LINE_UPDATE = ["questioned_at", "questioned_by_person_id", "question", "version"];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA_STUDIO = "biz-yoga-studio";
const MOVERS = "biz-movers";
const PET_BOARDING = "biz-pet-boarding";
const SAM = "person-sam";
const SLOW = { timeout: 120_000 };

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

const TABLES = (readJson(new URL("platform-billing.v1.tables.json", PART_DIR)) as { tables: ContractTable[] })
  .tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-33's seeds name it: from K-33's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);

const CORE_SEEDS = seedsOf("core");
const SETUP_SEEDS = seedsOf("business-setup");

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-33 v1 lists no table ${name}`);
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
 * file that names it, so K-33's seeds name K-04's as ../../core/fixtures/<file>), each file once.
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

/** Every K-33 row of the four seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Sam's card for Lee's Barbershop and the same card chosen for the yoga studio (seed-bill-card). */
const BARBER_CARD = valuesWithId("seed-bill-card.json", "bill_cards", "billcard-lees-barbershop-1");
const YOGA_CARD = valuesWithId("seed-bill-card.json", "bill_cards", "billcard-yoga-studio-1");
/** Lee's Barbershop's October bill, sent and to be charged, and its three $2 lines (seed-monthly-bill). */
const BARBER_BILL = valuesWithId("seed-monthly-bill.json", "monthly_bills", "bill-lees-barbershop-2026-10");
const ALEX_LINE = valuesWithId(
  "seed-monthly-bill.json",
  "monthly_bill_lines",
  "billline-lees-barbershop-2026-10-alex",
);
const BEN_LINE = valuesWithId(
  "seed-monthly-bill.json",
  "monthly_bill_lines",
  "billline-lees-barbershop-2026-10-ben",
);
/** The yoga studio's October bill, charged, its charge effect and its one line (seed-monthly-bill-charged). */
const YOGA_BILL = valuesWithId("seed-monthly-bill-charged.json", "monthly_bills", "bill-yoga-studio-2026-10");
const YOGA_CHARGE = valuesWithId(
  "seed-monthly-bill-charged.json",
  "effects",
  "effect-bill-yoga-studio-2026-10-charge",
);
const YOGA_LINE = valuesWithId(
  "seed-monthly-bill-charged.json",
  "monthly_bill_lines",
  "billline-yoga-studio-2026-10-alex",
);
/** Lee Home Services' October bill: declined, one pay link, paused (seed-bill-unpaid-pause). */
const HOME_BILL = valuesWithId(
  "seed-bill-unpaid-pause.json",
  "monthly_bills",
  "bill-lee-home-services-2026-10",
);
/** The movers' October bill with no card, its pay link due Mon Nov 16, and that link (refuse-pause-before-pay-by). */
const MOVERS_PAY_LINK = valuesWithId(
  "invalid/refuse-pause-before-pay-by.json",
  "effects",
  "effect-bill-movers-2026-10-pay-link",
);
const MOVERS_BILL = valuesWithId(
  "invalid/refuse-pause-before-pay-by.json",
  "monthly_bills",
  "bill-movers-2026-10",
);
/** The movers' card with Stripe's opaque payment-method id: refuse-card-number-stored without its one fault. */
const MOVERS_CARD: Values = {
  ...(refusedOf("invalid/refuse-card-number-stored.json").values ?? {}),
  stripe_payment_method_id: "stripe-card-demo-sam-lee-1",
};
/** Alex M.'s beard trim with Avery and its $2 line at 200 cents: refuse-line-not-two-dollars without its fault. */
const BEARD_TRIM = valuesWithId(
  "invalid/refuse-line-not-two-dollars.json",
  "bookings",
  "booking-alex-beard-trim",
);
const BEARD_TRIM_LINE: Values = {
  ...(refusedOf("invalid/refuse-line-not-two-dollars.json").values ?? {}),
  amount_cents: 200,
};
/** A 1% line made here on the barbershop's October bill: 1% of a $35 plan charge, no booking and no cap person. */
const ONE_PERCENT_LINE: Values = {
  ...BEARD_TRIM_LINE,
  id: "billline-probe-one-percent",
  kind: "rosfield_1pct",
  fee_id: "fee-probe-rosfield1pct",
  booking_id: null,
  counts_for_person_id: null,
  plan_charge_cents: 3500,
  amount_cents: 35,
};
/** Lee's Barbershop's November bill made here on Sam's card: sent Tue Dec 1, to be charged Thu Dec 3. */
const NOVEMBER_BILL: Values = {
  ...BARBER_BILL,
  id: "bill-probe-lees-barbershop-2026-11",
  month: "2026-11-01",
  bill_date: "2026-12-01",
  charge_on: "2026-12-03",
  sent_at: "2026-12-01T16:00:00Z",
  total_cents: 200,
  version: 1,
};
/** A charge and a pay link made here for that November bill, as K-07 effect rows of the barbershop. */
const PROBE_CHARGE: Values = {
  ...YOGA_CHARGE,
  id: "effect-probe-charge",
  business_id: BARBERSHOP,
  port_request: { monthlyBillId: "bill-probe-lees-barbershop-2026-11" },
  idempotency_key: "rosfield-probe-charge",
  trace_id: "trace-probe-charge",
};
const PROBE_PAY_LINK: Values = {
  ...MOVERS_PAY_LINK,
  id: "effect-probe-pay-link",
  business_id: BARBERSHOP,
  port_request: { monthlyBillId: "bill-probe-lees-barbershop-2026-11" },
  idempotency_key: "rosfield-probe-pay-link",
  trace_id: "trace-probe-pay-link",
};
/** A stand-in for a person on Rosie's team, made here: no seed names one (Q-18's members are real people). */
const TEAM_MEMBER: Values = {
  id: "person-team-stand-in",
  name: "Team member (stand-in)",
  language: "en",
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

/** Updates the row of `table` whose id is `id`, setting `set` and raising its version by one; gives it back. */
function updateOne(
  table: string,
  id: Json | undefined,
  set: Values,
): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) => tx<Record<string, unknown>[]>`
    update ${tx(table)} set ${tx(columnValues(tx, table, set))}, version = version + 1
    where ${whereOf(tx, { id: textOf(id) })}
    returning *
  `;
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
 * the server in the column's own type (a date, an instant or whole cents as PostgreSQL reads both; text exactly).
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

/** Rows each of the three tables shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of OWN_TABLES) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each of the three tables whose business_id is `businessId`, read as the owner. */
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
  db = await createTestDatabase({ name: "platform_billing" });
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

describe("the migration against the frozen table list (K-33 v1 platform billing)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
  };

  it("the table list names three tables, each scoped by business on business_id and versioned on version, none with effective dates", () => {
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

  it("all three raise their version on every update (0002's rule; README rule 3): <table>_version_raised, and no other trigger", async () => {
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

  it("money is whole cents with a currency code (rule 5): total_cents, plan_charge_cents and amount_cents are bigint beside a currency defaulting to USD; no numeric, real or money column; ids are text", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own.filter(([key]) => key.endsWith("_cents")).sort()).toEqual([
      ["monthly_bill_lines.amount_cents", "bigint"],
      ["monthly_bill_lines.plan_charge_cents", "bigint"],
      ["monthly_bills.total_cents", "bigint"],
    ]);
    expect(own.filter(([, type]) => ["numeric", "real", "double precision", "money"].includes(type))).toEqual(
      [],
    );
    expect([typeOf.get("monthly_bills.currency"), typeOf.get("monthly_bill_lines.currency")]).toEqual([
      "text",
      "text",
    ]);
    expect(
      own.filter(([key]) => key.endsWith(".id") || key.endsWith("_id")).every(([, type]) => type === "text"),
    ).toBe(true);
  });

  it("a card keeps only Stripe's two opaque ids (RULES 4.5; BP rule 7): no column for a card number, expiry, security code, brand or last four", () => {
    const cardColumns = tableOf("bill_cards").columns.map((column) => column.name);
    expect(cardColumns).toEqual([
      "id",
      "business_id",
      "saved_by_person_id",
      "stripe_customer_id",
      "stripe_payment_method_id",
      "saved_at",
      "removed_at",
      "version",
    ]);
    const cardDetails = /number|expir|cvc|cvv|brand|last_?4|last_four/;
    expect(
      [...typeOf.keys()].filter(
        (key) => OWN_TABLES.includes(key.split(".")[0] ?? "") && cardDetails.test(key),
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

  it("the three refer only to K-04's businesses, persons and bookings, K-07's effects and each other (rule 1): no foreign key names a K-23 table, and fee_id has none yet (K-32 adds it)", async () => {
    const keys = await db.sql<{ table: string; name: string; referenced: string; columns: string[] }[]>`
      select src.relname as table, k.conname as name, dst.relname as referenced,
             array(select a.attname::text from unnest(k.conkey) as c(n)
                   join pg_attribute a on a.attrelid = k.conrelid and a.attnum = c.n) as columns
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
    expect(
      [...new Set(keys.map((key) => key.referenced))].filter((name) => !OWN_TABLES.includes(name)).sort(),
    ).toEqual(REFERRED);
    expect(keys.filter((key) => key.columns.includes("fee_id"))).toEqual([]);
  });

  it("is recorded in schema_migrations as platform_billing, after effects_provider_events, business_setup and availability", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("platform_billing");
    for (const before of ["effects_provider_events", "business_setup", "availability"]) {
      expect(names.indexOf("platform_billing"), before).toBeGreaterThan(names.indexOf(before));
    }
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern; README rule 2)", () => {
  it("row-level security is on for all three, and forced on none", async () => {
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

  it("table grants (DL-149, each to its named reader: the migration's header; README rule 2): the runtime side selects, inserts and updates all three; the Tool API selects and inserts cards and only selects bills and lines; no delete, truncate, references or trigger; nothing to PUBLIC", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const versioned = ["INSERT", "SELECT", "UPDATE"];
    const want: Record<Role, Record<string, string[]>> = {
      rosie_app: {
        bill_cards: ["INSERT", "SELECT"],
        monthly_bill_lines: ["SELECT"],
        monthly_bills: ["SELECT"],
      },
      rosie_job: {
        bill_cards: versioned,
        monthly_bill_lines: versioned,
        monthly_bills: versioned,
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

  it("column grants (README rule 2): the Tool API updates bill_cards' removed_at and version and monthly_bill_lines' questioned_at, questioned_by_person_id, question and version, and nothing else; no other column grant to any grantee", async () => {
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
    const want: [string, string[]][] = [
      ["bill_cards", CARD_UPDATE],
      ["monthly_bill_lines", LINE_UPDATE],
    ];
    expect(granted.map((row) => `${row.table} ${row.column} ${row.grantee} ${row.privilege}`).sort()).toEqual(
      want
        .flatMap(([table, columns]) => columns.map((column) => `${table} ${column} ${TOOL_API} UPDATE`))
        .sort(),
    );
    // has_column_privilege agrees, column by column: Stripe's ids, the bill and the line's amount, fee and answer stay
    // the runtime side's to write.
    const updatable = await db.sql<{ table: string; column: string }[]>`
      select c.relname as table, a.attname as column
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(${TOOL_API}, a.attrelid, a.attnum, 'UPDATE')
      order by c.relname, a.attnum
    `;
    expect(updatable.map((row) => `${row.table}.${row.column}`)).toEqual([
      ...CARD_UPDATE.map((column) => `bill_cards.${column}`),
      ...LINE_UPDATE.map((column) => `monthly_bill_lines.${column}`),
    ]);
  });
});

describe("the seed fixtures load (fixtures/index.json): the two of 02-contracts' K-33 row and the two beyond it", () => {
  /** The K-33 rows the four seeds give together, per table: every table gets rows (README). */
  const SEEDED = {
    bill_cards: 3,
    monthly_bill_lines: 5,
    monthly_bills: 3,
  };

  it("the index lists the four seeds (the card's two among them) and five refused rows, all K-33 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual(
      [...CARD_SEEDS, "seed-bill-unpaid-pause.json", "seed-monthly-bill-charged.json"].sort(),
    );
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-card-number-stored.json",
      "invalid/refuse-line-not-two-dollars.json",
      "invalid/refuse-owner-removes-line.json",
      "invalid/refuse-pause-before-pay-by.json",
      "invalid/refuse-second-bill-same-month.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-33 row is stored as given`,
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

  it("all four insert together, each after chain once, and no table is left empty", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await visibleRows(db.sql)).toEqual(SEEDED);
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
    expect(await visibleRows(db.sql)).toEqual(SEEDED);
  });

  it(
    "amounts are integer cents (rule 5): every seeded total and line reads back as whole cents in USD, each $2 line is 200 cents, and each bill's total is its lines' sum ($6, $2, $2); a fraction of a cent is refused by the type (22P02)",
    SLOW,
    async () => {
      await reset();
      await loadFixtures(SEEDS);
      const bills = await db.sql<
        { id: string; total: string; currency: string; lines: string; count: number; twoDollars: boolean }[]
      >`
        select b.id, b.total_cents::text as total, b.currency, sum(l.amount_cents)::text as lines,
               count(l.id)::int as count, bool_and(l.kind = 'rosfield_2' and l.amount_cents = 200) as "twoDollars"
        from monthly_bills b join monthly_bill_lines l on l.bill_id = b.id and l.business_id = b.business_id
        group by b.id, b.total_cents, b.currency
        order by b.id
      `;
      expect(bills).toEqual([
        {
          id: "bill-lee-home-services-2026-10",
          total: "200",
          currency: "USD",
          lines: "200",
          count: 1,
          twoDollars: true,
        },
        {
          id: "bill-lees-barbershop-2026-10",
          total: "600",
          currency: "USD",
          lines: "600",
          count: 3,
          twoDollars: true,
        },
        {
          id: "bill-yoga-studio-2026-10",
          total: "200",
          currency: "USD",
          lines: "200",
          count: 1,
          twoDollars: true,
        },
      ]);
      for (const row of SEED_ROWS) {
        for (const [column, value] of Object.entries(row.values)) {
          if (column.endsWith("_cents") && value !== null) {
            expect(Number.isInteger(value), `${row.table}.${column}`).toBe(true);
          }
        }
      }
      const fraction = await refusal(
        as(
          RUNTIME,
          null,
          insertEach(
            ["bookings", BEARD_TRIM],
            ["monthly_bill_lines", { ...BEARD_TRIM_LINE, amount_cents: "200.50" }],
          ),
        ),
      );
      expect(fraction.code).toBe("22P02");
    },
  );
});

describe("the seeded rows: what the four seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 120_000);

  it("one card pays both companies' bills: Sam's payment-method id sits on the barbershop's and the yoga studio's live rows, saved by Sam at 2:18pm Mon Oct 19 for the barbershop; Lee Home Services has its own card", async () => {
    const live = await db.sql<{ business: string; customer: string; method: string; saved: string }[]>`
      select business_id as business, stripe_customer_id as customer, stripe_payment_method_id as method,
             to_char(saved_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as saved
      from bill_cards where removed_at is null and saved_by_person_id = ${SAM}
      order by business_id
    `;
    expect(live).toEqual([
      {
        business: HOME_SERVICES,
        customer: "stripe-customer-demo-sam-lee",
        method: "stripe-card-demo-sam-lee-2",
        saved: "3:05pm Mon Oct 19",
      },
      {
        business: BARBERSHOP,
        customer: "stripe-customer-demo-sam-lee",
        method: "stripe-card-demo-sam-lee-1",
        saved: "2:18pm Mon Oct 19",
      },
      {
        business: YOGA_STUDIO,
        customer: "stripe-customer-demo-sam-lee",
        method: "stripe-card-demo-sam-lee-1",
        saved: "10:30am Tue Oct 20",
      },
    ]);
    // Every business one card pays (bill_cards_payment_method_idx's read).
    const paidBy = await db.sql<{ business: string }[]>`
      select business_id as business from bill_cards
      where stripe_payment_method_id = 'stripe-card-demo-sam-lee-1' and removed_at is null
      order by business_id
    `;
    expect(paidBy.map((row) => row.business)).toEqual([BARBERSHOP, YOGA_STUDIO]);
  });

  it("Lee's Barbershop's October bill: sent Mon Nov 2 at 11:00am (Nov 1 is a Sunday), to be charged Wed Nov 4 on Sam's card; $2 lines for Alex M.'s haircut and Owen H.'s plan visit toward Riley's cap and Ben T.'s trim toward Avery's, $6; Sam questioned Ben's line and it waits for Rosie's team", async () => {
    const [bill] = await db.sql<Record<string, unknown>[]>`
      select to_char(sent_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MIam') as sent,
             to_char(bill_date, 'Dy Mon FMDD') as "billDate", to_char(charge_on, 'Dy Mon FMDD') as "chargeOn",
             total_cents::int as total, state, bill_card_id as card, charge_effect_id as charge,
             pay_link_sent_at as "payLink"
      from monthly_bills where id = ${textOf(BARBER_BILL.id)}
    `;
    expect(bill).toEqual({
      sent: "Mon Nov 2, 11:00am",
      billDate: "Mon Nov 2",
      chargeOn: "Wed Nov 4",
      total: 600,
      state: "sent",
      card: "billcard-lees-barbershop-1",
      charge: null,
      payLink: null,
    });
    const lines = await db.sql<{ served: string; capOf: string; amount: number }[]>`
      select p.name as served, c.name as "capOf", l.amount_cents::int as amount
      from monthly_bill_lines l
        join bookings b on b.id = l.booking_id
        join persons p on p.id = b.served_person_id
        join persons c on c.id = l.counts_for_person_id
      where l.bill_id = ${textOf(BARBER_BILL.id)}
      order by p.name
    `;
    expect(lines).toEqual([
      { served: "Alex M.", capOf: "Riley", amount: 200 },
      { served: "Ben T.", capOf: "Avery", amount: 200 },
      { served: "Owen H.", capOf: "Riley", amount: 200 },
    ]);
    // The team console's open questions (monthly_bill_lines_open_question_idx's read), oldest first.
    const open = await db.sql<{ id: string; by: string; asked: string; question: string | null }[]>`
      select id, questioned_by_person_id as by,
             to_char(questioned_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MIam') as asked, question
      from monthly_bill_lines where questioned_at is not null and answered_at is null
      order by questioned_at
    `;
    expect(open).toEqual([
      {
        id: textOf(BEN_LINE.id),
        by: SAM,
        asked: "Tue Nov 3, 9:30am",
        question: "Ben never came in, so there was no visit.",
      },
    ]);
  });

  it("the yoga studio's bill was charged on Sam's one card Wed Nov 4 through a succeeded rosfield_monthly_charge effect for its total; Lee Home Services' was declined then, got one pay link (pay by Wed Nov 18), and its new bookings through Rosie paused at the start of Thu Nov 19", async () => {
    const bills = await db.sql<Record<string, unknown>[]>`
      select b.id, b.state, b.bill_card_id as card,
             to_char(b.charged_at at time zone 'America/New_York', 'Dy Mon FMDD') as charged,
             to_char(b.declined_at at time zone 'America/New_York', 'Dy Mon FMDD') as declined,
             to_char(b.pay_by, 'Dy Mon FMDD') as "payBy",
             to_char(b.paused_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MIam') as paused,
             b.paid_at as paid, c.kind as "chargeKind", c.state as "chargeState",
             c.amount_cents = b.total_cents as "chargeIsTotal", k.kind as "linkKind", k.state as "linkState"
      from monthly_bills b
        join effects c on c.id = b.charge_effect_id
        left join effects k on k.id = b.pay_link_effect_id
      where b.id in (${textOf(YOGA_BILL.id)}, ${textOf(HOME_BILL.id)})
      order by b.id
    `;
    expect(bills).toEqual([
      {
        id: textOf(HOME_BILL.id),
        state: "paused",
        card: "billcard-lee-home-services-1",
        charged: null,
        declined: "Wed Nov 4",
        payBy: "Wed Nov 18",
        paused: "Thu Nov 19, 12:00am",
        paid: null,
        chargeKind: "rosfield_monthly_charge",
        chargeState: "declined",
        chargeIsTotal: true,
        linkKind: "stripe_pay_link",
        linkState: "succeeded",
      },
      {
        id: textOf(YOGA_BILL.id),
        state: "charged",
        card: "billcard-yoga-studio-1",
        charged: "Wed Nov 4",
        declined: null,
        payBy: null,
        paused: null,
        paid: null,
        chargeKind: "rosfield_monthly_charge",
        chargeState: "succeeded",
        chargeIsTotal: true,
        linkKind: null,
        linkState: null,
      },
    ]);
    // The job's reads: nothing left to charge or pause among these (charge-due and pay-by reads), one bill paused.
    const due = await db.sql<{ id: string }[]>`
      select id from monthly_bills where state = 'sent' and bill_card_id is not null and charge_effect_id is null
    `;
    expect(due.map((row) => row.id)).toEqual([textOf(BARBER_BILL.id)]);
    const paused = await db.sql<{ business: string }[]>`
      select business_id as business from monthly_bills where state = 'paused'
    `;
    expect(paused).toEqual([{ business: HOME_SERVICES }]);
  });
});

describe("row-level security per business on the three tables, every K-04, K-23 and K-33 seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
  }, 120_000);

  it(
    "with no scope the Tool API reads no row of the three; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's or Lee Home Services' bills, lines or cards",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual([HOME_SERVICES, BARBERSHOP, MOVERS, PET_BOARDING, YOGA_STUDIO].sort());
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await ownerRows(BARBERSHOP)).toEqual({ bill_cards: 1, monthly_bill_lines: 3, monthly_bills: 1 });
      const yoga = await as(TOOL_API, YOGA_STUDIO, async (tx) => ({
        cards: (await tx<{ id: string }[]>`select id from bill_cards order by id`).map((row) => row.id),
        bills: (await tx<{ id: string }[]>`select id from monthly_bills order by id`).map((row) => row.id),
        lines: (await tx<{ id: string }[]>`select id from monthly_bill_lines order by id`).map(
          (row) => row.id,
        ),
      }));
      expect(yoga).toEqual({
        cards: [textOf(YOGA_CARD.id)],
        bills: [textOf(YOGA_BILL.id)],
        lines: [textOf(YOGA_LINE.id)],
      });
    },
  );

  it("the pause read (S11-69): Lee Home Services' scope reads its paused bill; Lee's Barbershop's and the yoga studio's read none", async () => {
    const paused = (tx: Tx) => tx<{ business: string }[]>`
      select business_id as business from monthly_bills where state = 'paused'
    `;
    expect(await as(TOOL_API, HOME_SERVICES, paused)).toEqual([{ business: HOME_SERVICES }]);
    expect(await as(TOOL_API, BARBERSHOP, paused)).toEqual([]);
    expect(await as(TOOL_API, YOGA_STUDIO, paused)).toEqual([]);
  });

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

  it("the Tool API writes only its scope's rows: another business's card is refused (42501), and a question on another business's line finds no row", async () => {
    const card = { ...MOVERS_CARD, id: "billcard-movers-from-barbershop" };
    const outcome = await refusal(as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "bill_cards", card)));
    expect([outcome.code, outcome.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "bill_cards"',
    ]);
    expect(await as(TOOL_API, MOVERS, (tx) => insertReturning(tx, "bill_cards", card))).toHaveLength(1);
    const question = updateOne("monthly_bill_lines", YOGA_LINE.id, {
      questioned_at: "2026-11-03T15:00:00Z",
      questioned_by_person_id: SAM,
    });
    expect(await as(TOOL_API, BARBERSHOP, question)).toHaveLength(0);
    expect(await as(TOOL_API, YOGA_STUDIO, question)).toHaveLength(1);
  });

  it("the runtime side scoped to one business (per write) cannot write another's bill or move one to another business; with no scope it writes it", async () => {
    const outcome = await refusal(as(RUNTIME, YOGA_STUDIO, insertEach(["monthly_bills", NOVEMBER_BILL])));
    expect(outcome.code).toBe("42501");
    const move = updateOne("monthly_bills", BARBER_BILL.id, { business_id: YOGA_STUDIO });
    expect((await refusal(as(RUNTIME, BARBERSHOP, move))).code).toBe("42501");
    expect(await as(RUNTIME, BARBERSHOP, insertEach(["monthly_bills", NOVEMBER_BILL]))).toHaveLength(1);
    expect(await as(RUNTIME, null, insertEach(["monthly_bills", NOVEMBER_BILL]))).toHaveLength(1);
  });

  it("every update raises the version by exactly one: an update that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const table of OWN_TABLES) {
      const row = SEED_ROWS.find((candidate) => candidate.table === table);
      if (row === undefined) {
        throw new Error(`no seed row of ${table}`);
      }
      const version = row.values.version;
      const kept = await refusal(
        as(
          RUNTIME,
          null,
          (tx) => tx`update ${tx(table)} set version = version where ${whereOf(tx, keyOf(row))}`,
        ),
      );
      expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
      const raised = await as(
        RUNTIME,
        null,
        (tx) =>
          tx<{ version: number }[]>`
            update ${tx(table)} set version = version + 1 where ${whereOf(tx, keyOf(row))} returning version
          `,
      );
      expect(raised, table).toEqual([{ version: typeof version === "number" ? version + 1 : -1 }]);
    }
  });
});

describe("who may do what, by privilege (README rule 2), every K-04, K-23 and K-33 seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
  }, 120_000);

  it("the Tool API saves a card and replaces it: the old row gets removed_at (version raised), then a new live row; a second live card is refused (bill_cards_one_live, 23505)", async () => {
    const newCard = {
      ...BARBER_CARD,
      id: "billcard-lees-barbershop-2",
      stripe_payment_method_id: "stripe-card-demo-sam-lee-2",
      saved_at: "2026-11-05T15:00:00Z",
    };
    const second = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "bill_cards", newCard)),
    );
    expect([second.code, second.constraint]).toEqual(["23505", "bill_cards_one_live"]);
    const replaced = await as(TOOL_API, BARBERSHOP, async (tx) => {
      const old = await updateOne("bill_cards", BARBER_CARD.id, { removed_at: "2026-11-05T15:00:00Z" })(tx);
      await insertReturning(tx, "bill_cards", newCard);
      const live = await tx<{ id: string }[]>`select id from bill_cards where removed_at is null`;
      return { version: old[0]?.version, live: live.map((row) => row.id) };
    });
    expect(replaced).toEqual({ version: 2, live: ["billcard-lees-barbershop-2"] });
    // A new business's first card is a plain insert under its own scope.
    expect(await as(TOOL_API, MOVERS, (tx) => insertReturning(tx, "bill_cards", MOVERS_CARD))).toHaveLength(
      1,
    );
  });

  it("the Tool API never changes a card's Stripe ids, saver, time or business in place: each update is refused by privilege (42501)", async () => {
    const changes: Values[] = [
      { stripe_payment_method_id: "stripe-card-demo-sam-lee-2" },
      { stripe_customer_id: "stripe-customer-demo-other" },
      { saved_by_person_id: "person-riley" },
      { saved_at: "2026-10-19T19:00:00Z" },
      { business_id: YOGA_STUDIO },
    ];
    for (const change of changes) {
      const outcome = await refusal(
        as(TOOL_API, BARBERSHOP, updateOne("bill_cards", BARBER_CARD.id, change)),
      );
      expect([outcome.code, outcome.message], JSON.stringify(change)).toEqual([
        "42501",
        "permission denied for table bill_cards",
      ]);
    }
    // The runtime side holds the whole row (a card replaced through K-05's commit takes a new row the same way).
    expect(
      await as(
        RUNTIME,
        null,
        updateOne("bill_cards", BARBER_CARD.id, { removed_at: "2026-11-05T15:00:00Z" }),
      ),
    ).toHaveLength(1);
  });

  it("the Tool API only reads bills: it reads its own business's bill, and an insert, an update of the state, the pause, paid or the total, and a delete are refused (42501)", async () => {
    expect(
      await as(
        TOOL_API,
        BARBERSHOP,
        (tx) => tx`select id, state, total_cents::int as total from monthly_bills`,
      ),
    ).toEqual([{ id: textOf(BARBER_BILL.id), state: "sent", total: 600 }]);
    const writes: [string, (tx: Tx) => Promise<unknown>][] = [
      ["insert", insertEach(["monthly_bills", NOVEMBER_BILL])],
      [
        "state",
        updateOne("monthly_bills", BARBER_BILL.id, { state: "charged", charged_at: "2026-11-04T16:00:02Z" }),
      ],
      ["pause", updateOne("monthly_bills", HOME_BILL.id, { paid_at: "2026-11-20T15:00:00Z", state: "paid" })],
      ["total", updateOne("monthly_bills", BARBER_BILL.id, { total_cents: 400 })],
      ["delete", (tx) => tx`delete from monthly_bills where id = ${textOf(BARBER_BILL.id)}`],
    ];
    for (const [name, write] of writes) {
      const business = name === "pause" ? HOME_SERVICES : BARBERSHOP;
      const outcome = await refusal(as(TOOL_API, business, write));
      expect([outcome.code, outcome.message], name).toEqual([
        "42501",
        "permission denied for table monthly_bills",
      ]);
    }
  });

  it("the Tool API questions its own business's line before the charge, and nothing else: adding a line, changing its amount, kind, fee, booking or cap person, answering it or deleting it is refused (42501)", async () => {
    const questioned = await as(
      TOOL_API,
      BARBERSHOP,
      updateOne("monthly_bill_lines", ALEX_LINE.id, {
        questioned_at: "2026-11-03T15:10:00Z",
        questioned_by_person_id: SAM,
        question: "Alex's haircut was a walk-in.",
      }),
    );
    expect(questioned).toMatchObject([
      {
        id: ALEX_LINE.id,
        questioned_by_person_id: SAM,
        question: "Alex's haircut was a walk-in.",
        version: 2,
      },
    ]);
    const writes: [string, (tx: Tx) => Promise<unknown>][] = [
      [
        "insert",
        insertEach(["monthly_bill_lines", { ...ALEX_LINE, id: "billline-probe", fee_id: "fee-probe" }]),
      ],
      ["amount", updateOne("monthly_bill_lines", ALEX_LINE.id, { amount_cents: 100 })],
      ["kind", updateOne("monthly_bill_lines", ALEX_LINE.id, { kind: "rosfield_1pct" })],
      ["fee", updateOne("monthly_bill_lines", ALEX_LINE.id, { fee_id: "fee-probe" })],
      ["booking", updateOne("monthly_bill_lines", ALEX_LINE.id, { booking_id: "booking-ben-trim" })],
      ["cap person", updateOne("monthly_bill_lines", ALEX_LINE.id, { counts_for_person_id: "person-avery" })],
      [
        "answer",
        updateOne("monthly_bill_lines", BEN_LINE.id, {
          answered_at: "2026-11-03T15:00:00Z",
          answered_by_person_id: SAM,
          outcome: "removed",
        }),
      ],
      ["delete", (tx) => tx`delete from monthly_bill_lines where id = ${textOf(ALEX_LINE.id)}`],
    ];
    for (const [name, write] of writes) {
      const outcome = await refusal(as(TOOL_API, BARBERSHOP, write));
      expect([outcome.code, outcome.message], name).toEqual([
        "42501",
        "permission denied for table monthly_bill_lines",
      ]);
    }
  });

  it("the runtime side writes every bill and line: it charges the barbershop's bill on its card, Rosie's team answers Ben's questioned line (a wrong line comes off) and the job adds a line", async () => {
    const done = await as(RUNTIME, null, async (tx) => {
      await insertReturning(tx, "effects", {
        ...PROBE_CHARGE,
        id: "effect-bill-lees-barbershop-2026-10-charge",
        port_request: { monthlyBillId: BARBER_BILL.id ?? null },
        idempotency_key: "rosfield-bill-lees-barbershop-2026-10-charge",
        amount_cents: 400,
      });
      const [charged] = await updateOne("monthly_bills", BARBER_BILL.id, {
        state: "charged",
        charge_effect_id: "effect-bill-lees-barbershop-2026-10-charge",
        charged_at: "2026-11-04T16:00:02Z",
        total_cents: 400,
      })(tx);
      await insertReturning(tx, "persons", TEAM_MEMBER);
      const [answered] = await updateOne("monthly_bill_lines", BEN_LINE.id, {
        answered_at: "2026-11-03T18:00:00Z",
        answered_by_person_id: textOf(TEAM_MEMBER.id),
        outcome: "removed",
      })(tx);
      const added = await insertEach(["bookings", BEARD_TRIM], ["monthly_bill_lines", BEARD_TRIM_LINE])(tx);
      return {
        state: charged?.state,
        outcome: answered?.outcome,
        version: answered?.version,
        added: added.length,
      };
    });
    expect(done).toEqual({ state: "charged", outcome: "removed", version: 3, added: 1 });
  });

  it("no role deletes a card, a bill or a line (42501): a card ends by removed_at and a wrong line by its outcome", async () => {
    const rows: [string, Json | undefined, string][] = [
      ["bill_cards", BARBER_CARD.id, BARBERSHOP],
      ["monthly_bills", BARBER_BILL.id, BARBERSHOP],
      ["monthly_bill_lines", ALEX_LINE.id, BARBERSHOP],
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
});

interface Probe {
  /** What the sources refuse, or allow. */
  name: string;
  /** The writes, in one transaction as the runtime side with no scope, then rolled back; gives back the last row. */
  run: (tx: Tx) => Promise<Record<string, unknown>[]>;
  /** The refusal: its SQLSTATE and the constraint that names it (one of these); absent, the writes pass. */
  refused?: { code: string; constraintOneOf: string[] };
}

const check = (...constraintOneOf: string[]) => ({ code: "23514", constraintOneOf });

/** The stand-in member of Rosie's team is added, then answers Ben's questioned line with `set` (README rule 2). */
const answerBen =
  (set: Values) =>
  async (tx: Tx): Promise<Record<string, unknown>[]> => {
    await insertReturning(tx, "persons", TEAM_MEMBER);
    return updateOne("monthly_bill_lines", BEN_LINE.id, {
      ...set,
      answered_by_person_id: textOf(TEAM_MEMBER.id),
    })(tx);
  };

/** One-rule probes (README "Checked on"): each refused by the rule it names, or passed as the sources allow. */
const PROBES: Probe[] = [
  {
    name: "July's bill comes Mon Aug 3 (Aug 1 2026 is a Saturday) and is charged Wed Aug 5",
    run: insertEach([
      "monthly_bills",
      {
        ...NOVEMBER_BILL,
        month: "2026-07-01",
        bill_date: "2026-08-03",
        charge_on: "2026-08-05",
        sent_at: "2026-08-03T15:00:00Z",
      },
    ]),
  },
  {
    name: "July's bill sent on Saturday Aug 1 itself is refused",
    run: insertEach([
      "monthly_bills",
      {
        ...NOVEMBER_BILL,
        month: "2026-07-01",
        bill_date: "2026-08-01",
        charge_on: "2026-08-03",
        sent_at: "2026-08-01T15:00:00Z",
      },
    ]),
    refused: check("monthly_bills_bill_date_rule"),
  },
  {
    name: "the movers' October bill with no card comes Mon Nov 2 with its pay link (Nov 1 2026 is a Sunday)",
    run: insertEach(["effects", MOVERS_PAY_LINK], ["monthly_bills", MOVERS_BILL]),
  },
  {
    name: "the movers' October bill sent on Sunday Nov 1 itself is refused",
    run: insertEach(
      ["effects", MOVERS_PAY_LINK],
      [
        "monthly_bills",
        { ...MOVERS_BILL, bill_date: "2026-11-01", charge_on: "2026-11-03", pay_by: "2026-11-15" },
      ],
    ),
    refused: check("monthly_bills_bill_date_rule"),
  },
  {
    name: "November's bill comes Tue Dec 1 (a weekday 1st) and is charged Thu Dec 3",
    run: insertEach(["monthly_bills", NOVEMBER_BILL]),
  },
  {
    name: "November's bill sent on Wed Dec 2, the day after a weekday 1st, is refused",
    run: insertEach([
      "monthly_bills",
      { ...NOVEMBER_BILL, bill_date: "2026-12-02", charge_on: "2026-12-04" },
    ]),
    refused: check("monthly_bills_bill_date_rule"),
  },
  {
    name: "a month named by a day other than its first is refused",
    run: insertEach([
      "monthly_bills",
      { ...NOVEMBER_BILL, month: "2026-11-02", bill_date: "2026-12-02", charge_on: "2026-12-04" },
    ]),
    refused: check("monthly_bills_month_first_day"),
  },
  {
    name: "a charge 3 days after the bill is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, charge_on: "2026-12-04" }]),
    refused: check("monthly_bills_charge_two_days_later"),
  },
  {
    name: "a bill with no card and no pay link is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, bill_card_id: null }]),
    refused: check("monthly_bills_pay_link_when_due"),
  },
  {
    name: "a pay link while the card is live and was not declined is refused",
    run: insertEach(
      ["effects", PROBE_PAY_LINK],
      [
        "monthly_bills",
        {
          ...NOVEMBER_BILL,
          state: "pay_link",
          pay_link_effect_id: PROBE_PAY_LINK.id ?? null,
          pay_link_sent_at: "2026-12-01T16:00:05Z",
          pay_by: "2026-12-15",
        },
      ],
    ),
    refused: check("monthly_bills_pay_link_when_due"),
  },
  {
    name: "15 days to pay by the link is refused",
    run: insertEach(
      ["effects", MOVERS_PAY_LINK],
      ["monthly_bills", { ...MOVERS_BILL, pay_by: "2026-11-17" }],
    ),
    refused: check("monthly_bills_pay_by_fourteen_days"),
  },
  {
    name: "a declined charge with its one pay link, 14 days from the charge day, passes",
    run: insertEach(
      ["effects", PROBE_CHARGE],
      ["effects", PROBE_PAY_LINK],
      [
        "monthly_bills",
        {
          ...NOVEMBER_BILL,
          state: "pay_link",
          charge_effect_id: PROBE_CHARGE.id ?? null,
          declined_at: "2026-12-03T16:00:01Z",
          pay_link_effect_id: PROBE_PAY_LINK.id ?? null,
          pay_link_sent_at: "2026-12-03T16:00:05Z",
          pay_by: "2026-12-17",
        },
      ],
    ),
  },
  {
    name: "charged and declined at once is refused",
    run: insertEach(
      ["effects", PROBE_CHARGE],
      ["effects", PROBE_PAY_LINK],
      [
        "monthly_bills",
        {
          ...NOVEMBER_BILL,
          state: "pay_link",
          charge_effect_id: PROBE_CHARGE.id ?? null,
          charged_at: "2026-12-03T16:00:02Z",
          declined_at: "2026-12-03T16:00:01Z",
          pay_link_effect_id: PROBE_PAY_LINK.id ?? null,
          pay_link_sent_at: "2026-12-03T16:00:05Z",
          pay_by: "2026-12-17",
        },
      ],
    ),
    refused: check("monthly_bills_charge_on_card"),
  },
  {
    name: "a charge on a bill with no card is refused",
    run: insertEach(
      ["effects", PROBE_CHARGE],
      ["effects", PROBE_PAY_LINK],
      [
        "monthly_bills",
        {
          ...NOVEMBER_BILL,
          bill_card_id: null,
          state: "pay_link",
          charge_effect_id: PROBE_CHARGE.id ?? null,
          pay_link_effect_id: PROBE_PAY_LINK.id ?? null,
          pay_link_sent_at: "2026-12-01T16:00:05Z",
          pay_by: "2026-12-15",
        },
      ],
    ),
    refused: check("monthly_bills_charge_on_card"),
  },
  {
    name: "a bill on another business's card is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, bill_card_id: YOGA_CARD.id ?? null }]),
    refused: { code: "23503", constraintOneOf: ["monthly_bills_card_fk"] },
  },
  {
    name: "one charge effect on two bills is refused",
    run: insertEach([
      "monthly_bills",
      {
        ...YOGA_BILL,
        id: "bill-probe-yoga-studio-2026-11",
        month: "2026-11-01",
        bill_date: "2026-12-01",
        charge_on: "2026-12-03",
        sent_at: "2026-12-01T16:00:00Z",
        charged_at: "2026-12-03T16:00:02Z",
        version: 1,
      },
    ]),
    refused: { code: "23505", constraintOneOf: ["monthly_bills_charge_effect_key"] },
  },
  {
    name: "a charge effect that does not exist is refused",
    run: insertEach([
      "monthly_bills",
      {
        ...NOVEMBER_BILL,
        state: "charged",
        charge_effect_id: "effect-none",
        charged_at: "2026-12-03T16:00:02Z",
      },
    ]),
    refused: { code: "23503", constraintOneOf: ["monthly_bills_charge_effect_fk"] },
  },
  {
    name: "a bill paid with no pay link is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, state: "paid", paid_at: "2026-12-05T15:00:00Z" }]),
    refused: check("monthly_bills_paid_by_link"),
  },
  {
    name: "Lee Home Services' bill paid before its pause began is refused",
    run: updateOne("monthly_bills", HOME_BILL.id, { state: "paid", paid_at: "2026-11-18T20:00:00Z" }),
    refused: check("monthly_bills_paid_ends_pause"),
  },
  {
    name: "Lee Home Services' bill paid by its link after the pause ends the pause",
    run: updateOne("monthly_bills", HOME_BILL.id, { state: "paid", paid_at: "2026-11-20T15:00:00Z" }),
  },
  {
    name: "a total below zero is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, total_cents: -200 }]),
    refused: check("monthly_bills_money"),
  },
  {
    name: "a bill in another currency is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, currency: "EUR" }]),
    refused: check("monthly_bills_money"),
  },
  {
    name: "a bill in a state the sources do not name is refused",
    run: insertEach(["monthly_bills", { ...NOVEMBER_BILL, state: "refunded" }]),
    refused: check("monthly_bills_state_known", "monthly_bills_state_matches"),
  },
  {
    name: "a $2 line at 200 cents, with its booking and the person whose cap it counts toward, passes",
    run: insertEach(["bookings", BEARD_TRIM], ["monthly_bill_lines", BEARD_TRIM_LINE]),
  },
  {
    name: "a $2 line with no booking is refused",
    run: insertEach(["monthly_bill_lines", { ...BEARD_TRIM_LINE, booking_id: null }]),
    refused: check("monthly_bill_lines_two_dollars"),
  },
  {
    name: "a $2 line with no cap person is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, counts_for_person_id: null }],
    ),
    refused: check("monthly_bill_lines_two_dollars"),
  },
  {
    name: "a $2 line with a plan charge is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, plan_charge_cents: 3500 }],
    ),
    refused: check("monthly_bill_lines_two_dollars"),
  },
  {
    name: "a 1% line at 35 cents of a $35 plan charge, with no cap person, passes",
    run: insertEach(["monthly_bill_lines", ONE_PERCENT_LINE]),
  },
  {
    name: "a 1% line of $35.50 at 35 cents (rounded down) passes",
    run: insertEach([
      "monthly_bill_lines",
      { ...ONE_PERCENT_LINE, plan_charge_cents: 3550, amount_cents: 35 },
    ]),
  },
  {
    name: "a 1% line of $35.50 at 36 cents (rounded up) passes",
    run: insertEach([
      "monthly_bill_lines",
      { ...ONE_PERCENT_LINE, plan_charge_cents: 3550, amount_cents: 36 },
    ]),
  },
  {
    name: "a 1% line at 2% (70 cents of $35) is refused",
    run: insertEach(["monthly_bill_lines", { ...ONE_PERCENT_LINE, amount_cents: 70 }]),
    refused: check("monthly_bill_lines_one_percent"),
  },
  {
    name: "a 1% line with no plan charge is refused",
    run: insertEach(["monthly_bill_lines", { ...ONE_PERCENT_LINE, plan_charge_cents: null }]),
    refused: check("monthly_bill_lines_one_percent"),
  },
  {
    name: "a 1% line with a cap person is refused (the 1% is not capped)",
    run: insertEach(["monthly_bill_lines", { ...ONE_PERCENT_LINE, counts_for_person_id: "person-riley" }]),
    refused: check("monthly_bill_lines_one_percent"),
  },
  {
    name: "a line of another kind is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, kind: "rosfield_5" }],
    ),
    refused: check("monthly_bill_lines_kind_known"),
  },
  {
    name: "a line in another currency is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, currency: "CAD" }],
    ),
    refused: check("monthly_bill_lines_currency"),
  },
  {
    name: "a fee billed twice is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, fee_id: ALEX_LINE.fee_id ?? null }],
    ),
    refused: { code: "23505", constraintOneOf: ["monthly_bill_lines_fee_key"] },
  },
  {
    name: "a line on another business's bill is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, bill_id: YOGA_BILL.id ?? null }],
    ),
    refused: { code: "23503", constraintOneOf: ["monthly_bill_lines_bill_fk"] },
  },
  {
    name: "a question's words with no question are refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, question: "Was this a walk-in?" }],
    ),
    refused: check("monthly_bill_lines_question_together"),
  },
  {
    name: "a question with nobody who asked it is refused",
    run: insertEach(
      ["bookings", BEARD_TRIM],
      ["monthly_bill_lines", { ...BEARD_TRIM_LINE, questioned_at: "2026-11-03T15:00:00Z" }],
    ),
    refused: check("monthly_bill_lines_question_together"),
  },
  {
    name: "an answer to a line nobody questioned is refused",
    run: insertEach(
      ["persons", TEAM_MEMBER],
      ["bookings", BEARD_TRIM],
      [
        "monthly_bill_lines",
        {
          ...BEARD_TRIM_LINE,
          answered_at: "2026-11-03T18:00:00Z",
          answered_by_person_id: TEAM_MEMBER.id ?? null,
          outcome: "stands",
        },
      ],
    ),
    refused: check("monthly_bill_lines_answer_together"),
  },
  {
    name: "an answer before its question is refused",
    run: insertEach(
      ["persons", TEAM_MEMBER],
      [
        "monthly_bill_lines",
        {
          ...BEN_LINE,
          id: "billline-probe-ben",
          fee_id: "fee-probe-ben",
          answered_at: "2026-11-03T14:00:00Z",
          answered_by_person_id: TEAM_MEMBER.id ?? null,
          outcome: "stands",
          version: 1,
        },
      ],
    ),
    refused: check("monthly_bill_lines_answer_together"),
  },
  {
    name: "an answer with no outcome is refused",
    run: answerBen({ answered_at: "2026-11-03T18:00:00Z" }),
    refused: check("monthly_bill_lines_answer_together"),
  },
  {
    name: "an outcome the sources do not name is refused",
    run: answerBen({ answered_at: "2026-11-03T18:00:00Z", outcome: "refunded" }),
    refused: check("monthly_bill_lines_outcome_known"),
  },
  {
    name: "Ben's questioned line answered by Rosie's team after the question, standing, passes",
    run: answerBen({ answered_at: "2026-11-03T18:00:00Z", outcome: "stands" }),
  },
  {
    name: "a second live card for Lee's Barbershop is refused",
    run: insertEach([
      "bill_cards",
      { ...BARBER_CARD, id: "billcard-probe", stripe_payment_method_id: "stripe-card-demo-sam-lee-2" },
    ]),
    refused: { code: "23505", constraintOneOf: ["bill_cards_one_live"] },
  },
  {
    name: "a card number with dashes in the payment-method id is refused",
    run: insertEach(["bill_cards", { ...MOVERS_CARD, stripe_payment_method_id: "0000-1111-2222-3333" }]),
    refused: check("bill_cards_no_card_number"),
  },
  {
    name: "a card number in the customer id is refused",
    run: insertEach(["bill_cards", { ...MOVERS_CARD, stripe_customer_id: "0000111122223333" }]),
    refused: check("bill_cards_no_card_number"),
  },
  {
    name: "an opaque id holding a run of 12 digits passes",
    run: insertEach([
      "bill_cards",
      { ...MOVERS_CARD, stripe_payment_method_id: "stripe-card-demo-123456789012" },
    ]),
  },
  {
    name: "an empty Stripe id is refused",
    run: insertEach(["bill_cards", { ...MOVERS_CARD, stripe_customer_id: "" }]),
    refused: check("bill_cards_ids_present"),
  },
  {
    name: "a card removed before it was saved is refused",
    run: insertEach(["bill_cards", { ...MOVERS_CARD, removed_at: "2026-10-21T14:00:00Z" }]),
    refused: check("bill_cards_removed_after_saved"),
  },
];

describe("one-rule probes as the runtime side, every K-04, K-23 and K-33 seed loaded: each refused by the rule it names, or passed as the sources allow", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SETUP_SEEDS, ...SEEDS]);
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
 * Each refused fixture with its one fault removed: K-33's README names what passes once it is fixed. The answer by
 * Rosie's team is the same update written on the runtime side, so its fix is the role, not a value.
 */
const REFUSED_CASES: { file: string; fixed: Values; fixedRole?: Role; without: string }[] = [
  {
    file: "invalid/refuse-card-number-stored.json",
    fixed: { stripe_payment_method_id: "stripe-card-demo-sam-lee-1" },
    without: "the same card with Stripe's opaque payment-method id",
  },
  {
    file: "invalid/refuse-second-bill-same-month.json",
    fixed: {
      month: "2026-11-01",
      bill_date: "2026-12-01",
      charge_on: "2026-12-03",
      sent_at: "2026-12-01T16:05:00Z",
    },
    without: "the same bill for November, sent Tue Dec 1 and charged Thu Dec 3",
  },
  {
    file: "invalid/refuse-owner-removes-line.json",
    fixed: {},
    fixedRole: RUNTIME,
    without: "the same answer written on the runtime side, where Rosie's team answers",
  },
  {
    file: "invalid/refuse-line-not-two-dollars.json",
    fixed: { amount_cents: 200 },
    without: "the same line at 200 cents",
  },
  {
    file: "invalid/refuse-pause-before-pay-by.json",
    fixed: { paused_at: "2026-11-17T05:00:00Z" },
    without: "the same pause on Tue Nov 17, after the pay-by day",
  },
];

for (const { file, fixed, fixedRole, without } of REFUSED_CASES) {
  describe(`${file}: refused for its one reason`, () => {
    const refused = refusedOf(file);
    const role = roleOf(refused);
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
      // The fixture's after chain and its own rows (the beard trim's booking, the movers' bill and its pay link).
      await loadFixtures([file]);
    }, 120_000);

    it(`the fixture: ${refused.role} ${refused.action}s ${refused.table}; refused with ${refused.expect.sqlstate ?? "?"}${refused.expect.constraintOneOf === undefined ? " by privilege" : ` by ${refused.expect.constraintOneOf.join(" or ")}`}`, async () => {
      expect(["insert", "update"]).toContain(refused.action);
      const outcome = await refusal(as(role, refused.scope?.businessId ?? null, attempt({})));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      if (refused.expect.constraintOneOf === undefined) {
        expect(outcome.message).toBe(`permission denied for table ${refused.table}`);
      } else {
        expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      }
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      const scope = fixedRole === undefined ? (refused.scope?.businessId ?? null) : null;
      const done = await as(fixedRole ?? role, scope, attempt(fixed));
      const id = refused.action === "insert" ? refused.values?.id : refused.where?.id;
      expect(done.map((row) => row.id)).toEqual([textOf(id)]);
    });
  });
}
