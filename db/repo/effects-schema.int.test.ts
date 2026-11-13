// T-194: K-07 v1's schema addition (effects, provider_events and outbox_claims), migrated with K-05 v1.1, against
// local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/effects-schema`). The schema comes from
// migrating a fresh test schema, with every accepted K-04 v1 seed loaded.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: K-05 v1.1's calls, the commit's
// effects under its per-write scope, recordProviderEvent unscoped) runs in its own transaction under SET LOCAL ROLE,
// scoped by withBusiness() as a call is scoped, and is rolled back. The rows come only from K-07 v1's fixtures (Lee's
// Barbershop and the master's sample cast) on K-04 v1's seeds. A turn, booking or person a K-07 effect names that K-04
// does not seed is stood in by K-04's seed row of that table under the K-07 id (a person: the id alone), committed with
// the seeds. T-1094 (DL-149) took the Tool API's grants on effects and provider_events away, so every read or write of
// them made as the Tool API is refused by privilege, scoped or not; the runtime side's are as 0015 made them.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const K07_DIR = new URL("../../contracts/outbox-effects/", import.meta.url);
const K07_FIXTURES = new URL("fixtures/", K07_DIR);
const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const OWN_TABLES = ["effects", "outbox_claims", "provider_events"];
/** The two tables scoped by business (on business_id); outbox_claims spans businesses. */
const SCOPED_TABLES = ["effects", "provider_events"];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
/** The effects runner's claimer, as K-05 v1.1's claim-effects fixture names it. */
const RUNNER = "effects-runner-1";
const KINDS = [
  "stripe_save_card",
  "stripe_charge",
  "stripe_refund",
  "stripe_pay_link",
  "stripe_dispute_evidence",
  "rosfield_monthly_charge",
  "calendar_write",
  "calendar_update",
  "calendar_delete",
  "linq_contact_add",
];
const STATES = ["pending", "running", "succeeded", "declined", "outage", "cancelled"];
const PROVIDERS = ["stripe", "google_calendar", "microsoft_calendar"];
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
  unique?: { name: string; columns: string[] }[];
  checks: { name: string; expression: string }[];
  indexes: { name: string; columns: string[]; where?: string }[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
  versionColumn?: string;
}

/** K-07 v1 effectRow, as an effect fixture ends. */
interface EffectRecord {
  effectId: string;
  turnId: string | null;
  jobId: string | null;
  businessId: string | null;
  bookingId: string | null;
  kind: string;
  port: string;
  calendarProvider: string | null;
  visitId: string | null;
  personId: string | null;
  handleId: string | null;
  amount: { cents: number; currency: string } | null;
  portRequest: Json;
  idempotencyKey?: string;
  state: string;
  tries: number;
  runs: number;
  firstTryAt: string | null;
  providerObjectId: string | null;
  errorCode: string | null;
  ledgerLineId: string | null;
  traceId: string;
}

/** K-07 v1 providerEvent. */
interface ProviderEventRecord {
  provider: string;
  providerEventId: string;
  eventType: string;
  occurredAt: string | null;
  receivedAt: string;
  businessId: string | null;
  effectId: string | null;
  payload: Json;
  traceId: string;
}

/** K-07 v1's claim on a sending outbox row. */
interface ClaimRecord {
  claimer: string;
  claimedAt: string;
  lapsesAt: string;
  claimNo: number;
  firstTryAt: string | null;
  nextTryNotBefore: string | null;
}

interface K07Fixture {
  record: string;
  effect?: EffectRecord;
  event?: ProviderEventRecord;
  row?: { id: string };
  claim?: ClaimRecord | null;
}

interface IndexEntry {
  file: string;
  version: string;
  expect: string;
}

interface Row {
  table: string;
  values: Values;
}

interface SeedFile {
  after: string[];
  rows: Row[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const TABLES = (readJson(new URL("outbox-effects.v1.tables.json", K07_DIR)) as { tables: ContractTable[] })
  .tables;
const K07_INDEX = (readJson(new URL("index.json", K07_FIXTURES)) as { fixtures: IndexEntry[] }).fixtures;
const k07 = (file: string): K07Fixture => readJson(new URL(file, K07_FIXTURES)) as K07Fixture;
const ACCEPTED = K07_INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
const EFFECT_FILES = ACCEPTED.filter((file) => k07(file).record === "effect");
const EVENT_FILES = ACCEPTED.filter((file) => k07(file).record === "providerEvent");

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`${name} is not in K-07's table list`);
  }
  return table;
}

function effectOf(file: string): EffectRecord {
  const { record, effect } = k07(file);
  if (record !== "effect" || effect === undefined) {
    throw new Error(`${file} is not an effect record`);
  }
  return effect;
}

function eventOf(file: string): ProviderEventRecord {
  const { record, event } = k07(file);
  if (record !== "providerEvent" || event === undefined) {
    throw new Error(`${file} is not a provider event record`);
  }
  return event;
}

/** An effect as its effects row (K-07 effectRow to the table list's columns); the key only when the record has one. */
function effectRow(effect: EffectRecord): Values {
  return {
    id: effect.effectId,
    turn_id: effect.turnId,
    job_id: effect.jobId,
    business_id: effect.businessId,
    booking_id: effect.bookingId,
    kind: effect.kind,
    port: effect.port,
    calendar_provider: effect.calendarProvider,
    visit_id: effect.visitId,
    person_id: effect.personId,
    handle_id: effect.handleId,
    amount_cents: effect.amount?.cents ?? null,
    currency: effect.amount?.currency ?? null,
    port_request: effect.portRequest,
    ...(effect.idempotencyKey === undefined ? {} : { idempotency_key: effect.idempotencyKey }),
    state: effect.state,
    tries: effect.tries,
    runs: effect.runs,
    first_try_at: effect.firstTryAt,
    provider_object_id: effect.providerObjectId,
    error_code: effect.errorCode,
    ledger_line_id: effect.ledgerLineId,
    trace_id: effect.traceId,
  };
}

/** A provider event as its provider_events row. */
function eventRow(event: ProviderEventRecord): Values {
  return {
    provider: event.provider,
    provider_event_id: event.providerEventId,
    event_type: event.eventType,
    occurred_at: event.occurredAt,
    received_at: event.receivedAt,
    business_id: event.businessId,
    effect_id: event.effectId,
    payload: event.payload,
    trace_id: event.traceId,
  };
}

/** An outbox fixture's claim as its outbox_claims row. */
function claimRow(file: string): Values {
  const { row, claim } = k07(file);
  if (row === undefined || claim === undefined || claim === null) {
    throw new Error(`${file} holds no claimed outbox row`);
  }
  return {
    outbox_row_id: row.id,
    claimer: claim.claimer,
    claimed_at: claim.claimedAt,
    lapses_at: claim.lapsesAt,
    claim_no: claim.claimNo,
    first_try_at: claim.firstTryAt,
    next_try_not_before: claim.nextTryNotBefore,
  };
}

/** Every effect of K-07's accepted fixtures, in index order. */
const ALL_EFFECTS = EFFECT_FILES.map(effectOf);

/** The deposit on Alex's Groom's package (effect-charge.json): a Stripe charge in a turn's commit, succeeded. */
const CHARGE = effectRow(effectOf("effect-charge.json"));
/** Riley's Google calendar event for Alex's Nov 14 visit (effect-calendar-write.json). */
const CALENDAR_WRITE = effectRow(effectOf("effect-calendar-write.json"));
/** Alex's mobile added as a Linq contact (effect-linq-contact-add.json): no business. */
const CONTACT = effectRow(effectOf("effect-linq-contact-add.json"));
/** Saving Alex's card for the $20 fee (effect-outage-let-go.json): no amount, cancelled. */
const SAVE_CARD = effectRow(effectOf("effect-outage-let-go.json"));
/** Stripe's event for the deposit, linked to its effect (provider-event-stripe.json). */
const STRIPE_EVENT = eventRow(eventOf("provider-event-stripe.json"));
/** Google's push about Riley's own calendar, linked to no effect (provider-event-calendar.json). */
const CALENDAR_EVENT = eventRow(eventOf("provider-event-calendar.json"));
/** dispatcher-1's claim on the tour's A7-03 row, K-04's seed outbox row (outbox-two-sends.json). */
const CLAIM = claimRow("outbox-two-sends.json");

const readCore = (relative: string): unknown => readJson(new URL(relative, CORE_DIR));

function coreRows(file: string, seen: Set<string>): Row[] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readCore(`fixtures/${file}`) as SeedFile;
  return [...fixture.after.flatMap((before) => coreRows(before, seen)), ...fixture.rows];
}

/** Every accepted K-04 v1 seed's rows, each `after` chain once, in load order. */
const CORE_ROWS: Row[] = (() => {
  const index = readCore("fixtures/index.json") as { fixtures: IndexEntry[] };
  const seen = new Set<string>();
  return index.fixtures
    .filter((entry) => entry.expect === "accept")
    .flatMap((entry) => coreRows(entry.file, seen));
})();

const idOf = (values: Values): string | null => (typeof values.id === "string" ? values.id : null);

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

function seedRow(table: string, id: string): Values {
  const row = CORE_ROWS.find((candidate) => candidate.table === table && idOf(candidate.values) === id);
  if (row === undefined) {
    throw new Error(`K-04's seeds hold no ${table} row ${id}`);
  }
  return row.values;
}

/**
 * The persons, turns and bookings K-07's effects name that K-04's seeds do not hold, each once: a person by its id
 * alone, a turn as K-04's seed turn and a booking as K-04's seed booking at Lee's Barbershop, under the K-07 id.
 */
const STAND_INS: Row[] = (() => {
  const held = new Set(CORE_ROWS.map((row) => `${row.table} ${idOf(row.values) ?? ""}`));
  const rows: Row[] = [];
  const add = (table: string, id: string | null, make: (id: string) => Values): void => {
    if (id === null || held.has(`${table} ${id}`)) {
      return;
    }
    held.add(`${table} ${id}`);
    rows.push({ table, values: make(id) });
  };
  for (const effect of ALL_EFFECTS) {
    add("persons", effect.personId, (id) => ({ id }));
    add("turns", effect.turnId, (id) => ({ ...seedRow("turns", "turn-alex-move-1"), id }));
    add("bookings", effect.bookingId, (id) => ({ ...seedRow("bookings", "booking-alex-haircut"), id }));
  }
  return rows;
})();

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

interface Refusal {
  code: string | undefined;
  constraint: string | undefined;
  column: string | undefined;
  message: string;
}

/** The SQLSTATE, constraint, column and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code?: string;
      constraint_name?: string;
      column_name?: string;
      message?: string;
    };
    return {
      code: failure.code,
      constraint: failure.constraint_name,
      column: failure.column_name,
      message: failure.message ?? "",
    };
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
      out = Uint8Array.from((value.replace(/^\\x/, "").match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
    }
    converted[column] = out as never;
  }
  return converted;
}

async function insertRow(sql: Sql | Tx, table: string, values: Values): Promise<void> {
  await sql`insert into ${sql(table)} ${sql(columnValues(sql, table, values))}`;
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

/** A stored value next to a fixture's: a time as the instant it names, a bigint (read back as text) as text. */
function comparable(stored: unknown, given: Json | undefined): [unknown, unknown] {
  if (stored instanceof Date && typeof given === "string") {
    return [stored.toISOString(), new Date(given).toISOString()];
  }
  if (typeof stored === "string" && typeof given === "number") {
    return [stored, String(given)];
  }
  return [stored, given];
}

/** Every value given is stored as given. */
function expectStored(stored: Record<string, unknown>, values: Values, label: string): void {
  for (const [column, value] of Object.entries(values)) {
    const [actual, wanted] = comparable(stored[column], value);
    expect(actual, `${label} ${column}`).toEqual(wanted);
  }
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows of `table` the caller sees whose business_id is null. */
async function countWithNoBusiness(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(table)} where business_id is null
  `;
  return row?.n ?? -1;
}

/** Rows of `table` whose business_id is `businessId` (null: none), read as the owner. */
async function ownerCount(table: string, businessId: string | null): Promise<number> {
  const [row] =
    businessId === null
      ? await db.sql<
          { n: number }[]
        >`select count(*)::int as n from ${db.sql(table)} where business_id is null`
      : await db.sql<{ n: number }[]>`
          select count(*)::int as n from ${db.sql(table)} where business_id = ${businessId}
        `;
  return row?.n ?? -1;
}

/** A row's primary key values, as text. */
function keyOf(table: string, values: Values): [string, string][] {
  return tableOf(table).primaryKey.map((column) => {
    const value = values[column];
    if (typeof value !== "string") {
      throw new Error(`${table}.${column} is not a text key`);
    }
    return [column, value];
  });
}

/** Raises the version of the row `values` names by `raise`, giving back the new versions. */
function raiseVersion(tx: Tx, table: string, values: Values, raise: number): Promise<{ version: number }[]> {
  const where = keyOf(table, values)
    .map(([column, value]) => tx`${tx(column)} = ${value}`)
    .reduce((all, one) => tx`${all} and ${one}`);
  return tx<{ version: number }[]>`
    update ${tx(table)} set version = version + ${raise} where ${where} returning version
  `;
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
      indexes.map((row) => [row.name, row.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "")]),
    ),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "effects" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
  // K-04's seeds and the stand-ins, committed as the owner, as rls.int.test.ts loads the seeds.
  for (const row of [...CORE_ROWS, ...STAND_INS]) {
    await insertRow(db.sql, row.table, row.values);
  }
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-07 v1 schema addition)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    bigint: "bigint",
    jsonb: "jsonb",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names three versioned tables: effects and provider_events scoped by business, outbox_claims none", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    expect(
      Object.fromEntries(
        TABLES.map((table) => [
          table.name,
          [table.rowLevelSecurity.scope, table.rowLevelSecurity.column ?? null],
        ]),
      ),
    ).toEqual({
      effects: ["business", "business_id"],
      provider_events: ["business", "business_id"],
      outbox_claims: ["none", null],
    });
    for (const table of TABLES) {
      expect([table.versioned, table.versionColumn], table.name).toEqual([true, "version"]);
    }
  });

  for (const table of TABLES) {
    it(`${table.name}: columns in order, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
        select column_name as name, data_type as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
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
      for (const rule of table.unique ?? []) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.join(", ")})`,
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
      const own = await definitionsOf(db.sql, table.name);
      expect(own.checks).toEqual(listed.checks);
      // The unique rule's own index is checked above by name and columns; the named indexes here.
      expect(
        Object.fromEntries(Object.entries(own.indexes).filter(([name]) => name in listed.indexes)),
      ).toEqual(listed.indexes);
    });
  }

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

  it("row-level security is on for effects and provider_events with 0012's two policies on business_id, off for outbox_claims; none forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual([
      { name: "effects", on: true, forced: false },
      { name: "outbox_claims", on: false, forced: false },
      { name: "provider_events", on: true, forced: false },
    ]);
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
    expect([...new Set(policies.map((policy) => policy.table))]).toEqual([
      "effects",
      "outbox_rows",
      "provider_events",
    ]);
    // 0012's shape, read from outbox_rows' two policies, which key on the same column (business_id).
    const core = policies.filter((policy) => policy.table === "outbox_rows");
    for (const table of SCOPED_TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      expect(own.map((policy) => [policy.using, policy.check])).toEqual(
        core.map((policy) => [policy.using, policy.check]),
      );
      expect(own[0]?.using).toContain("business_id = NULLIF(current_setting('rosie.business_id'");
      // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
      expect(own[0]?.using).toContain("IS NULL");
      expect(own[1]?.using).not.toContain("IS NULL");
    }
  });

  it("grants: select, insert and update to rosie_job alone on effects and provider_events (T-1094), and on outbox_claims with delete; the Tool API holds none on any of the three tables, and of their columns only effects' id and business_id to select (DL-298)", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    const rows = (role: Role, table: string, privileges: string[]) =>
      privileges.map((privilege) => ({ role, table, privilege }));
    // T-1094 (DL-149) took 0015's SELECT, INSERT and UPDATE on effects and provider_events from the Tool API: every
    // K-05 v1.1 call that reads or writes them runs on the runtime side.
    expect(held).toEqual([
      ...rows(RUNTIME, "effects", ["INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "outbox_claims", ["DELETE", "INSERT", "SELECT", "UPDATE"]),
      ...rows(RUNTIME, "provider_events", ["INSERT", "SELECT", "UPDATE"]),
    ]);
    // No other grantee: PUBLIC holds nothing on any of the three.
    const others = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee <> c.relowner and a.grantee not in (${TOOL_API}::regrole, ${RUNTIME}::regrole)
    `;
    expect(others).toEqual([]);
    // And the Tool API is no grantee of any of the three: no entry of its own is left in their grants.
    const toolApi = await db.sql<{ table: string; privilege: string }[]>`
      select c.relname as table, a.privilege_type as privilege
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.grantee = ${TOOL_API}::regrole
    `;
    expect(toolApi).toEqual([]);
    // DL-225 (T-722, DL-298): the column grants on the three gain rosie_app's SELECT of effects.id and
    // effects.business_id, which K-32 rule 5's checks read, and stay exact: no other column, grantee or privilege.
    const columns = await db.sql<{ table: string; column: string; grantee: string; privilege: string }[]>`
      select c.relname as table, a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        cross join lateral aclexplode(a.attacl) g
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and a.attacl is not null
      order by c.relname, a.attnum
    `;
    expect(columns).toEqual([
      { table: "effects", column: "id", grantee: TOOL_API, privilege: "SELECT" },
      { table: "effects", column: "business_id", grantee: TOOL_API, privilege: "SELECT" },
    ]);
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

  it("is recorded in schema_migrations as effects_provider_events, after platform_review", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("effects_provider_events");
    expect(names.indexOf("effects_provider_events")).toBeGreaterThan(names.indexOf("platform_review"));
  });
});

describe("refuse-effect-without-key.json: an effect row with no idempotency key is refused by the database", () => {
  const file = "invalid/refuse-effect-without-key.json";
  const refused = effectOf(file);

  it("the fixture is listed as refused, and is effect-charge.json's deposit with one fault: no idempotency key", () => {
    expect(K07_INDEX.find((entry) => entry.file === file)?.expect).toBe("refuse");
    expect(refused.idempotencyKey).toBeUndefined();
    const { idempotencyKey, ...withoutKey } = effectOf("effect-charge.json");
    expect(idempotencyKey).toBe("eff-alex-grooms-deposit");
    expect(refused).toEqual(withoutKey);
  });

  it("written as the commit writes it (the runtime side, scoped to Lee's Barbershop), it is refused: idempotency_key is not null (23502)", async () => {
    const row = effectRow(refused);
    expect(Object.keys(row)).not.toContain("idempotency_key");
    for (const values of [row, { ...row, idempotency_key: null }]) {
      const outcome = await refusal(as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "effects", values)));
      expect([outcome.code, outcome.column]).toEqual(["23502", "idempotency_key"]);
    }
  });

  it("the same row with its key (effect-charge.json's) passes and is stored as given", async () => {
    const stored = await as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "effects", CHARGE));
    expectStored(stored, CHARGE, "effect-charge.json");
    expect(stored).toMatchObject({ version: 1, claimed_by: null, claim_lapses_at: null, last_try_at: null });
    expect(stored.created_at).toBeInstanceOf(Date);
  });

  it("one idempotency key per effect: a second effect on the deposit's key is refused (effects_idempotency_key_key, 23505)", async () => {
    const declined = effectRow(effectOf("effect-charge-declined.json"));
    const outcome = await refusal(
      as(RUNTIME, BARBERSHOP, async (tx) => {
        await insertRow(tx, "effects", CHARGE);
        await insertRow(tx, "effects", { ...declined, idempotency_key: CHARGE.idempotency_key ?? null });
      }),
    );
    expect([outcome.code, outcome.constraint]).toEqual(["23505", "effects_idempotency_key_key"]);
    // Under its own key (as the fixture has it) the declined deposit is another effect, stored beside it.
    expect(
      await as(RUNTIME, BARBERSHOP, async (tx) => {
        await insertRow(tx, "effects", CHARGE);
        await insertRow(tx, "effects", declined);
        return countRows(tx, "effects");
      }),
    ).toBe(2);
  });
});

describe("every accepted K-07 effect and provider event is a row the tables take, as the fixture ends", () => {
  it("the index lists eleven effects and two provider events, all K-07 v1", () => {
    expect(EFFECT_FILES).toHaveLength(11);
    expect([...EVENT_FILES].sort()).toEqual(["provider-event-calendar.json", "provider-event-stripe.json"]);
    expect(
      K07_INDEX.filter((entry) => [...EFFECT_FILES, ...EVENT_FILES].includes(entry.file)).every(
        (entry) => entry.version === "v1",
      ),
    ).toBe(true);
  });

  for (const file of EFFECT_FILES) {
    it(`${file}: written as its commit or job writes it (per write, or unscoped with no business), stored as given`, async () => {
      const effect = effectOf(file);
      const row = effectRow(effect);
      const stored = await as(RUNTIME, effect.businessId, (tx) => insertReturning(tx, "effects", row));
      expectStored(stored, row, file);
      expect(stored.version, file).toBe(1);
    });
  }

  for (const file of EVENT_FILES) {
    it(`${file}: recorded by the gateway (the runtime side, unscoped), after the effect it reports on, stored as given`, async () => {
      const event = eventOf(file);
      const row = eventRow(event);
      const effect = ALL_EFFECTS.find((candidate) => candidate.effectId === event.effectId);
      expect(effect === undefined, file).toBe(event.effectId === null);
      const stored = await as(RUNTIME, null, async (tx) => {
        if (effect !== undefined) {
          await insertRow(tx, "effects", effectRow(effect));
        }
        return insertReturning(tx, "provider_events", row);
      });
      expectStored(stored, row, file);
      expect(stored).toMatchObject({ handled_at: null, version: 1 });
    });
  }

  it("left out, an effect is pending with tries 0 and runs 1 (K-05 v1.1 item 18), a provider event received now, a claim the first", async () => {
    const written = Object.fromEntries(
      Object.entries(CHARGE).filter(
        ([column]) => !["state", "tries", "runs", "first_try_at"].includes(column),
      ),
    );
    const stored = await as(RUNTIME, BARBERSHOP, async (tx) => ({
      effect: await insertReturning(tx, "effects", {
        ...written,
        provider_object_id: null,
        ledger_line_id: null,
      }),
      event: await insertReturning(
        tx,
        "provider_events",
        Object.fromEntries(Object.entries(CALENDAR_EVENT).filter(([column]) => column !== "received_at")),
      ),
    }));
    expect(stored.effect).toMatchObject({
      state: "pending",
      tries: 0,
      runs: 1,
      first_try_at: null,
      version: 1,
    });
    expect(stored.event.received_at).toBeInstanceOf(Date);
    const claim = await as(RUNTIME, null, (tx) =>
      insertReturning(
        tx,
        "outbox_claims",
        Object.fromEntries(Object.entries(CLAIM).filter(([column]) => column !== "claim_no")),
      ),
    );
    expectStored(claim, { ...CLAIM, claim_no: 1 }, "outbox-two-sends.json claim");
    expect(claim.version).toBe(1);
  });
});

describe("a provider event is stored once by (provider, provider_event_id)", () => {
  /** The same push sent again (provider-event-calendar.json's event, received a minute later). */
  const repeat: Values = { ...CALENDAR_EVENT, received_at: "2026-11-12T21:16:00Z" };

  it("a second event with the same provider and event id is refused (provider_events_pkey, 23505), whatever its body", async () => {
    for (const second of [
      CALENDAR_EVENT,
      repeat,
      { ...repeat, event_type: "calendar.deleted", payload: {} },
    ]) {
      const outcome = await refusal(
        as(RUNTIME, null, async (tx) => {
          await insertRow(tx, "provider_events", CALENDAR_EVENT);
          await insertRow(tx, "provider_events", second);
        }),
      );
      expect([outcome.code, outcome.constraint]).toEqual(["23505", "provider_events_pkey"]);
    }
  });

  it("recordProviderEvent's insert ... on conflict (provider, provider_event_id) do nothing writes nothing on a repeat", async () => {
    const recorded = await as(RUNTIME, null, async (tx) => {
      const record = (values: Values) => tx<{ id: string }[]>`
        insert into provider_events ${tx(columnValues(tx, "provider_events", values))}
        on conflict (provider, provider_event_id) do nothing
        returning provider_event_id as id
      `;
      const first = await record(CALENDAR_EVENT);
      const again = await record(repeat);
      const stored = await tx<{ received: Date; trace: string; version: number }[]>`
        select received_at as received, trace_id as trace, version from provider_events
      `;
      return { first, again, stored };
    });
    expect(recorded.first).toEqual([{ id: CALENDAR_EVENT.provider_event_id }]);
    expect(recorded.again).toEqual([]);
    // The stored row is the first receipt's: the repeat changed nothing (K-05 v1.1 item 23 answers `repeated`).
    expect(recorded.stored).toEqual([
      { received: new Date(textOf(CALENDAR_EVENT.received_at)), trace: CALENDAR_EVENT.trace_id, version: 1 },
    ]);
  });

  it("the same event id under another provider is another event, stored beside it", async () => {
    const other = { ...CALENDAR_EVENT, provider: "microsoft_calendar" };
    expect(
      await as(RUNTIME, null, async (tx) => {
        await insertRow(tx, "provider_events", CALENDAR_EVENT);
        await insertRow(tx, "provider_events", other);
        return tx<{ provider: string; id: string }[]>`
          select provider, provider_event_id as id from provider_events order by provider
        `;
      }),
    ).toEqual([
      { provider: "google_calendar", id: CALENDAR_EVENT.provider_event_id },
      { provider: "microsoft_calendar", id: CALENDAR_EVENT.provider_event_id },
    ]);
  });
});

describe("each rule of the table list refuses a row that breaks it, for that one reason", () => {
  /** Inserts `values` into `table` as the runtime side with no scope, after `before`, then rolls back. */
  const tried = (table: string, values: Values, before: Row[] = []): Promise<Record<string, unknown>> =>
    as(RUNTIME, null, async (tx) => {
      for (const row of before) {
        await insertRow(tx, row.table, row.values);
      }
      return insertReturning(tx, table, values);
    });

  /** The SQLSTATE and the constraint that refuse `values` in `table`. */
  const refusedBy = async (
    table: string,
    values: Values,
    before: Row[] = [],
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(tried(table, values, before));
    return [outcome.code, outcome.constraint];
  };

  const running: Values = { state: "running", claimed_by: RUNNER, claim_lapses_at: "2026-11-07T15:21:01Z" };
  const chargeEffect: Row = { table: "effects", values: CHARGE };

  it(
    "effects: every kind K-07 names is taken on its port, and every state, a running one claimed",
    SLOW,
    async () => {
      expect(tableOf("effects").checks.find((check) => check.name === "effects_kind_known")?.expression).toBe(
        `kind in (${KINDS.map((kind) => `'${kind}'`).join(", ")})`,
      );
      expect(
        tableOf("effects").checks.find((check) => check.name === "effects_state_known")?.expression,
      ).toBe(`state in (${STATES.map((state) => `'${state}'`).join(", ")})`);
      for (const kind of KINDS) {
        const base = kind.startsWith("calendar_")
          ? CALENDAR_WRITE
          : kind === "linq_contact_add"
            ? CONTACT
            : CHARGE;
        expect(await tried("effects", { ...base, kind }), kind).toMatchObject({ kind });
      }
      for (const state of STATES) {
        const values = state === "running" ? { ...CHARGE, ...running } : { ...CHARGE, state };
        expect(await tried("effects", values), state).toMatchObject({ state });
      }
      // A Stripe kind that moves no money may carry none (saving a card), and a job's refund has no turn.
      expect(await tried("effects", SAVE_CARD)).toMatchObject({ amount_cents: null, currency: null });
      expect(await tried("effects", effectRow(effectOf("effect-reconciliation-refund.json")))).toMatchObject({
        turn_id: null,
        job_id: "job-reconcile-2026-11-09",
      });
    },
  );

  it(
    "effects: a turn or a job, never both or neither; a known kind on its own port (no SMS port)",
    SLOW,
    async () => {
      expect(await refusedBy("effects", { ...CHARGE, job_id: "job-reconcile-2026-11-09" })).toEqual([
        "23514",
        "effects_turn_or_job",
      ]);
      expect(await refusedBy("effects", { ...CHARGE, turn_id: null })).toEqual([
        "23514",
        "effects_turn_or_job",
      ]);
      expect(await refusedBy("effects", { ...CHARGE, kind: "stripe_payout" })).toEqual([
        "23514",
        "effects_kind_known",
      ]);
      const wrongPorts: Values[] = [
        { ...CHARGE, port: "linq" },
        { ...CHARGE, port: "sms" },
        { ...CHARGE, kind: "calendar_write" },
        { ...CONTACT, port: "stripe" },
      ];
      for (const values of wrongPorts) {
        expect(await refusedBy("effects", values), JSON.stringify([values.port, values.kind])).toEqual([
          "23514",
          "effects_port_matches_kind",
        ]);
      }
      expect(await refusedBy("effects", { ...CHARGE, state: "failed" })).toEqual([
        "23514",
        "effects_state_known",
      ]);
    },
  );

  it(
    "effects: a calendar effect is keyed by provider, booking, visit and person; no other effect names a calendar or visit",
    SLOW,
    async () => {
      for (const fault of [
        { calendar_provider: "apple" },
        { booking_id: null },
        { visit_id: null },
        { person_id: null },
      ]) {
        expect(await refusedBy("effects", { ...CALENDAR_WRITE, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "effects_calendar_keyed",
        ]);
      }
      expect(await tried("effects", { ...CALENDAR_WRITE, calendar_provider: "microsoft" })).toMatchObject({
        calendar_provider: "microsoft",
      });
      // K-07 v1's frozen expression leaves one hole, reported for a minor version (not this card's to change): with no
      // provider, `calendar_provider in ('google', 'microsoft')` is unknown, and a CHECK passes on unknown, so a calendar
      // effect with every key but its provider is taken. Code must always name the provider until the rule says so.
      expect(await tried("effects", { ...CALENDAR_WRITE, calendar_provider: null })).toMatchObject({
        port: "calendar",
        calendar_provider: null,
      });
      for (const fault of [{ calendar_provider: "google" }, { visit_id: "visit-alex-riley-nov14" }]) {
        expect(await refusedBy("effects", { ...CHARGE, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "effects_calendar_keyed",
        ]);
      }
    },
  );

  it("effects: only a Linq contact names a handle, and it always does", async () => {
    expect(await refusedBy("effects", { ...CONTACT, handle_id: null })).toEqual([
      "23514",
      "effects_contact_has_handle",
    ]);
    expect(await refusedBy("effects", { ...CHARGE, handle_id: "handle-alex" })).toEqual([
      "23514",
      "effects_contact_has_handle",
    ]);
  });

  it(
    "effects: a charge, refund, pay link or monthly charge has an amount; an amount has its three-letter currency",
    SLOW,
    async () => {
      for (const kind of ["stripe_charge", "stripe_refund", "stripe_pay_link", "rosfield_monthly_charge"]) {
        expect(
          await refusedBy("effects", { ...CHARGE, kind, amount_cents: null, currency: null }),
          kind,
        ).toEqual(["23514", "effects_money_kinds_have_amount"]);
      }
      for (const fault of [
        { amount_cents: null },
        { currency: null },
        { currency: "usd" },
        { currency: "US" },
        { currency: "USDC" },
      ]) {
        expect(await refusedBy("effects", { ...CHARGE, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "effects_money_kinds_have_amount",
        ]);
      }
      expect(await refusedBy("effects", { ...SAVE_CARD, currency: "USD" })).toEqual([
        "23514",
        "effects_money_kinds_have_amount",
      ]);
    },
  );

  it(
    "effects: 0 to 5 tries in a run, at least one run; the request an object; running exactly when claimed",
    SLOW,
    async () => {
      expect(await tried("effects", { ...CHARGE, tries: 0 })).toMatchObject({ tries: 0 });
      expect(await tried("effects", { ...CHARGE, tries: 5, runs: 2 })).toMatchObject({ tries: 5, runs: 2 });
      for (const fault of [{ tries: 6 }, { tries: -1 }, { runs: 0 }]) {
        expect(await refusedBy("effects", { ...CHARGE, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "effects_tries_within_five",
        ]);
      }
      const notObjects: Json[] = [[], "deposit", 40];
      for (const port_request of notObjects) {
        expect(await refusedBy("effects", { ...CHARGE, port_request }), JSON.stringify(port_request)).toEqual(
          ["23514", "effects_port_request_object"],
        );
      }
      for (const fault of [
        { state: "running" },
        { ...running, claim_lapses_at: null },
        { ...running, claimed_by: null },
        { claimed_by: RUNNER, claim_lapses_at: running.claim_lapses_at ?? null },
      ]) {
        expect(await refusedBy("effects", { ...CHARGE, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "effects_running_is_claimed",
        ]);
      }
    },
  );

  it(
    "effects: each foreign key refuses an id its table does not hold (23503); the id and the key are unique (23505)",
    SLOW,
    async () => {
      for (const [fault, constraint] of [
        [{ turn_id: "turn-none" }, "effects_turn_fk"],
        [{ business_id: "biz-none" }, "effects_business_fk"],
        [{ booking_id: "booking-none" }, "effects_booking_fk"],
        [{ person_id: "person-none" }, "effects_person_fk"],
      ] as const) {
        expect(await refusedBy("effects", { ...CHARGE, ...fault }), constraint).toEqual([
          "23503",
          constraint,
        ]);
      }
      expect(await refusedBy("effects", { ...CONTACT, handle_id: "handle-none" })).toEqual([
        "23503",
        "effects_handle_fk",
      ]);
      expect(
        await refusedBy("effects", { ...CHARGE, idempotency_key: "eff-alex-grooms-deposit-2" }, [
          chargeEffect,
        ]),
      ).toEqual(["23505", "effects_pkey"]);
      expect(
        await refusedBy("effects", { ...CHARGE, id: "eff-alex-grooms-deposit-2" }, [chargeEffect]),
      ).toEqual(["23505", "effects_idempotency_key_key"]);
    },
  );

  it(
    "provider_events: a known provider, a payload object, a business and an effect that exist",
    SLOW,
    async () => {
      for (const provider of PROVIDERS) {
        expect(await tried("provider_events", { ...CALENDAR_EVENT, provider }), provider).toMatchObject({
          provider,
        });
      }
      for (const provider of ["linq", "resend", "google"]) {
        expect(await refusedBy("provider_events", { ...CALENDAR_EVENT, provider }), provider).toEqual([
          "23514",
          "provider_events_provider_known",
        ]);
      }
      const notObjects: Json[] = [[], "calendar.changed"];
      for (const payload of notObjects) {
        expect(
          await refusedBy("provider_events", { ...CALENDAR_EVENT, payload }),
          JSON.stringify(payload),
        ).toEqual(["23514", "provider_events_payload_object"]);
      }
      expect(await refusedBy("provider_events", { ...CALENDAR_EVENT, business_id: "biz-none" })).toEqual([
        "23503",
        "provider_events_business_fk",
      ]);
      // Stripe's event before its effect row exists, and with an effect id no row holds.
      expect(await refusedBy("provider_events", STRIPE_EVENT)).toEqual([
        "23503",
        "provider_events_effect_fk",
      ]);
      expect(
        await refusedBy("provider_events", { ...STRIPE_EVENT, effect_id: "eff-none" }, [chargeEffect]),
      ).toEqual(["23503", "provider_events_effect_fk"]);
    },
  );

  it(
    "outbox_claims: the claim lapses after it is taken and counts from 1; one claim per outbox row that exists",
    SLOW,
    async () => {
      expect(await tried("outbox_claims", CLAIM)).toMatchObject({ claim_no: 1, version: 1 });
      for (const fault of [
        { lapses_at: CLAIM.claimed_at ?? null },
        { lapses_at: "2026-10-23T14:05:01Z" },
        { claim_no: 0 },
      ]) {
        expect(await refusedBy("outbox_claims", { ...CLAIM, ...fault }), JSON.stringify(fault)).toEqual([
          "23514",
          "outbox_claims_lapse_after_claim",
        ]);
      }
      expect(await refusedBy("outbox_claims", { ...CLAIM, outbox_row_id: "out-none" })).toEqual([
        "23503",
        "outbox_claims_row_fk",
      ]);
      expect(
        await refusedBy("outbox_claims", { ...CLAIM, claimer: "dispatcher-2", claim_no: 2 }, [
          { table: "outbox_claims", values: CLAIM },
        ]),
      ).toEqual(["23505", "outbox_claims_pkey"]);
    },
  );

  /** One row per table, as the fixtures give it, with what must exist before it. */
  const BASES: Record<string, { values: Values; before: Row[] }> = {
    effects: { values: CHARGE, before: [] },
    provider_events: { values: STRIPE_EVENT, before: [chargeEffect] },
    outbox_claims: { values: CLAIM, before: [] },
  };

  for (const table of TABLES) {
    it(`${table.name}: each column the table list marks not null refuses a null (23502)`, SLOW, async () => {
      const base = BASES[table.name];
      if (base === undefined) {
        throw new Error(`no base row for ${table.name}`);
      }
      const notNull = table.columns.filter((column) => !column.null).map((column) => column.name);
      expect(notNull.length, table.name).toBeGreaterThan(0);
      for (const column of notNull) {
        const outcome = await refusal(tried(table.name, { ...base.values, [column]: null }, base.before));
        expect([outcome.code, outcome.column], `${table.name}.${column}`).toEqual(["23502", column]);
      }
    });
  }

  it(
    "every table: an update must raise the version by exactly one (<table>_version_raised, 23514)",
    SLOW,
    async () => {
      for (const table of OWN_TABLES) {
        const base = BASES[table];
        if (base === undefined) {
          throw new Error(`no base row for ${table}`);
        }
        const rows = [...base.before, { table, values: base.values }];
        const update = (raise: number) =>
          as(RUNTIME, null, async (tx) => {
            for (const row of rows) {
              await insertRow(tx, row.table, row.values);
            }
            return raiseVersion(tx, table, base.values, raise);
          });
        for (const raise of [0, 2]) {
          const outcome = await refusal(update(raise));
          expect([outcome.code, outcome.constraint], `${table} raised by ${String(raise)}`).toEqual([
            "23514",
            `${table}_version_raised`,
          ]);
        }
        expect(await update(1), table).toEqual([{ version: 2 }]);
      }
    },
  );

  it(
    "the runtime side's own updates pass, each raising the version by one: a claim taken again, a result, an event handled",
    SLOW,
    async () => {
      const done = await as(RUNTIME, null, async (tx) => {
        await insertRow(tx, "outbox_claims", CLAIM);
        await insertRow(tx, "effects", {
          ...CHARGE,
          ...running,
          provider_object_id: null,
          ledger_line_id: null,
        });
        await insertRow(tx, "provider_events", STRIPE_EVENT);
        const reclaim = await tx<{ claim: number; first: Date; version: number }[]>`
        update outbox_claims set claimer = 'dispatcher-2', claimed_at = '2026-10-23T14:06:10Z',
          lapses_at = '2026-10-23T14:07:10Z', claim_no = claim_no + 1, version = version + 1
        where outbox_row_id = ${textOf(CLAIM.outbox_row_id)}
        returning claim_no as claim, first_try_at as first, version
      `;
        const result = await tx<{ state: string; version: number }[]>`
        update effects set state = 'succeeded', claimed_by = null, claim_lapses_at = null, tries = tries + 1,
          provider_object_id = 'stripe-charge-demo-0001', version = version + 1
        where id = ${textOf(CHARGE.id)}
        returning state, version
      `;
        const handled = await tx<{ handled: boolean; version: number }[]>`
        update provider_events set handled_at = '2026-11-07T15:20:04Z', version = version + 1
        where provider = 'stripe' and provider_event_id = ${textOf(STRIPE_EVENT.provider_event_id)}
        returning handled_at is not null as handled, version
      `;
        return [...reclaim, ...result, ...handled];
      });
      expect(done).toEqual([
        { claim: 2, first: new Date(textOf(CLAIM.first_try_at)), version: 2 },
        { state: "succeeded", version: 2 },
        { handled: true, version: 2 },
      ]);
    },
  );
});

describe("writes under a scope: the commit's per-write scope, and a contact effect on the runtime side", () => {
  it("the Tool API writes no effect, under its own business's scope, another business's or none: refused by privilege (42501; T-1094)", async () => {
    // Lee's Barbershop's deposit, which 0015's policy let the Tool API write under that business's scope, and the
    // contact effect, which has no business: neither is written, so no Tool API path queues an effect for the runner.
    for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
      for (const values of [CHARGE, CONTACT]) {
        const outcome = await refusal(as(TOOL_API, scope, (tx) => insertReturning(tx, "effects", values)));
        const label = `${String(scope)}: ${textOf(values.id)}`;
        expect(outcome.code, label).toBe("42501");
        expect(outcome.message, label).toContain("permission denied for table effects");
      }
    }
  });

  it("the Tool API records no provider event, not even one for its own business: refused by privilege (42501), so no Tool API path takes an event id before the gateway (T-1094)", async () => {
    expect(CALENDAR_EVENT.business_id).toBe(BARBERSHOP);
    const records: ((tx: Tx) => Promise<unknown>)[] = [
      (tx) => insertRow(tx, "provider_events", CALENDAR_EVENT),
      // recordProviderEvent's own form (K-05 v1.1 item 23).
      (tx) => tx`
        insert into provider_events ${tx(columnValues(tx, "provider_events", CALENDAR_EVENT))}
        on conflict (provider, provider_event_id) do nothing
      `,
    ];
    for (const scope of [BARBERSHOP, null]) {
      for (const record of records) {
        const outcome = await refusal(as(TOOL_API, scope, record));
        expect(outcome.code, String(scope)).toBe("42501");
        expect(outcome.message, String(scope)).toContain("permission denied for table provider_events");
      }
    }
    // The gateway's own recording, on the runtime side with no scope, still stores the event.
    expect(
      await as(RUNTIME, null, (tx) => insertReturning(tx, "provider_events", CALENDAR_EVENT)),
    ).toMatchObject({
      provider: CALENDAR_EVENT.provider,
      provider_event_id: CALENDAR_EVENT.provider_event_id,
      business_id: BARBERSHOP,
    });
  });

  it("the runtime side writes a business's effect under that business's scope (per write), and a contact effect only unscoped", async () => {
    expect(await as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "effects", CHARGE))).toMatchObject({
      id: CHARGE.id,
    });
    expect(
      (await refusal(as(RUNTIME, YOGA_STUDIO, (tx) => insertReturning(tx, "effects", CHARGE)))).code,
    ).toBe("42501");
    expect(
      (await refusal(as(RUNTIME, BARBERSHOP, (tx) => insertReturning(tx, "effects", CONTACT)))).code,
    ).toBe("42501");
    expect(await as(RUNTIME, null, (tx) => insertReturning(tx, "effects", CONTACT))).toMatchObject({
      id: CONTACT.id,
      business_id: null,
    });
  });

  it("a provider event no business is known for is recorded unscoped; a business scope cannot write it (42501)", async () => {
    const unmatched = { ...CALENDAR_EVENT, business_id: null };
    expect(await as(RUNTIME, null, (tx) => insertReturning(tx, "provider_events", unmatched))).toMatchObject({
      business_id: null,
    });
    for (const role of ROLES) {
      const outcome = await refusal(
        as(role, BARBERSHOP, (tx) => insertReturning(tx, "provider_events", unmatched)),
      );
      expect(outcome.code, role).toBe("42501");
    }
  });
});

describe("row-level security and privileges on the stored rows", () => {
  /** Each K-07 effect once (effect-outage-runs-once.json is the same bill as effect-gave-up-outage.json, run again). */
  const effects = ALL_EFFECTS.filter(
    (effect, index) => ALL_EFFECTS.findIndex((other) => other.effectId === effect.effectId) === index,
  ).map(effectRow);
  /** Both K-07 provider events, and Google's push again under the other calendar provider with no business known. */
  const events = [
    STRIPE_EVENT,
    CALENDAR_EVENT,
    { ...CALENDAR_EVENT, provider: "microsoft_calendar", business_id: null },
  ];

  beforeAll(async () => {
    await db.sql.begin(async (tx) => {
      for (const values of effects) {
        await insertRow(tx, "effects", values);
      }
      for (const values of events) {
        await insertRow(tx, "provider_events", values);
      }
      await insertRow(tx, "outbox_claims", CLAIM);
    });
  }, 60_000);

  afterAll(async () => {
    // DL-225 (T-722, DL-297): the list gains K-32 part 1's five tables, whose keys name effects (0030), and stays exact
    // with no CASCADE.
    // DL-225 (T-723, DL-306): it gains K-32 part 2's five whose keys name a table above (0031): booking_fees (a
    // payment, a saved card), packs and pay_links (a payment), credits (a pack, which booking_fees names) and
    // reconciliation_findings (a line, a refund); and stays exact with no CASCADE.
    await db.sql`
      truncate provider_events, effects, outbox_claims, monthly_bills, monthly_bill_lines, saved_cards, payments,
        payment_items, ledger_lines, refunds, booking_fees, credits, packs, pay_links, reconciliation_findings
    `;
  });

  it("the rows: Lee's Barbershop's effects and events, the Linq contact effect and one event with no business", async () => {
    expect(effects).toHaveLength(10);
    expect(await ownerCount("effects", BARBERSHOP)).toBe(9);
    expect(await ownerCount("effects", null)).toBe(1);
    expect(await ownerCount("provider_events", BARBERSHOP)).toBe(2);
    expect(await ownerCount("provider_events", null)).toBe(1);
    expect(await ownerCount("effects", YOGA_STUDIO)).toBe(0);
  });

  it("the Tool API with no scope reads no effect and no provider event: refused by privilege (42501; T-1094), but for effects' id and business_id (DL-298), where its policy finds no row", async () => {
    for (const table of SCOPED_TABLES) {
      expect(await countRows(db.sql, table), table).toBeGreaterThan(0);
      // DL-225 (T-722, DL-298): rosie_app may SELECT effects.id and effects.business_id alone, the columns K-32 rule 5's
      // checks read, so a count of effects (which names no other column) passes and, with no scope, finds no row; the
      // whole row stays refused by privilege, as every read of provider_events.
      if (table === "effects") {
        expect(await as(TOOL_API, null, (tx) => countRows(tx, table)), table).toBe(0);
      }
      const outcome = await refusal(
        as(TOOL_API, null, (tx) =>
          table === "effects" ? tx`select * from effects`.then((rows) => rows.length) : countRows(tx, table),
        ),
      );
      expect(outcome.code, table).toBe("42501");
      expect(outcome.message, table).toContain(`permission denied for table ${table}`);
    }
  });

  it("the Tool API scoped to a business reads none of their rows either, its own business's included: refused by privilege (42501; T-1094), but for effects' id and business_id, of its own business's rows only (DL-298)", async () => {
    for (const table of SCOPED_TABLES) {
      expect(await ownerCount(table, BARBERSHOP), table).toBeGreaterThan(0);
      for (const business of [BARBERSHOP, YOGA_STUDIO]) {
        for (const read of [countRows, countWithNoBusiness]) {
          // DL-225 (T-722, DL-298): these counts of effects name no column but business_id, which rosie_app may now
          // read: it finds its own business's rows (none with no business), exactly as the runtime side scoped to it.
          if (table === "effects") {
            expect(await as(TOOL_API, business, (tx) => read(tx, table)), `${table} ${business}`).toBe(
              await as(RUNTIME, business, (tx) => read(tx, table)),
            );
            continue;
          }
          const outcome = await refusal(as(TOOL_API, business, (tx) => read(tx, table)));
          expect(outcome.code, `${table} ${business}`).toBe("42501");
          expect(outcome.message, `${table} ${business}`).toContain(`permission denied for table ${table}`);
        }
      }
    }
    // Lee's Barbershop's deposit, read by the Tool API from its own scope or the yoga studio's: refused. The runtime
    // side reads it under its business's scope, and from the yoga studio's finds no row.
    // DL-225 (T-722, DL-298): refused whole, and by every column but id and business_id; by its id alone the Tool API
    // finds it from its own business's scope only, as the runtime side does.
    const read = (tx: Tx) => tx`select id from effects where id = ${textOf(CHARGE.id)}`;
    const others = tableOf("effects")
      .columns.map((column) => column.name)
      .filter((name) => !["id", "business_id"].includes(name));
    for (const scope of [YOGA_STUDIO, BARBERSHOP]) {
      for (const column of ["*", ...others.map((name) => `"${name}"`)]) {
        const outcome = await refusal(
          as(TOOL_API, scope, (tx) =>
            tx.unsafe(`select ${column} from effects where id = $1`, [textOf(CHARGE.id)]),
          ),
        );
        expect([outcome.code, outcome.message], `${scope} ${column}`).toEqual([
          "42501",
          "permission denied for table effects",
        ]);
      }
      expect(await as(TOOL_API, scope, read), scope).toEqual(await as(RUNTIME, scope, read));
    }
    expect(await as(RUNTIME, YOGA_STUDIO, read)).toHaveLength(0);
    expect(await as(RUNTIME, BARBERSHOP, read)).toHaveLength(1);
  });

  it("the runtime side with no scope reads every row, those with no business included; with a scope set, only that business's", async () => {
    for (const table of SCOPED_TABLES) {
      expect(await as(RUNTIME, null, (tx) => countRows(tx, table)), table).toBe(
        await countRows(db.sql, table),
      );
      expect(await as(RUNTIME, null, (tx) => countWithNoBusiness(tx, table)), table).toBe(
        await ownerCount(table, null),
      );
      expect(await as(RUNTIME, BARBERSHOP, (tx) => countRows(tx, table)), table).toBe(
        await ownerCount(table, BARBERSHOP),
      );
      expect(await as(RUNTIME, BARBERSHOP, (tx) => countWithNoBusiness(tx, table)), table).toBe(0);
    }
  });

  it("an update from another business's scope finds no row, from its own it raises the version (the runtime side); the Tool API's update is refused by privilege (42501; T-1094)", async () => {
    const bump = (tx: Tx) =>
      tx`update effects set version = version + 1 where id = ${textOf(CHARGE.id)} returning id`;
    const handle = (tx: Tx) =>
      tx`update provider_events set handled_at = '2026-11-07T15:20:04Z', version = version + 1
         where provider = 'stripe' and provider_event_id = ${textOf(STRIPE_EVENT.provider_event_id)}
         returning provider_event_id as id`;
    for (const [table, update] of [
      ["effects", bump],
      ["provider_events", handle],
    ] as const) {
      expect(await as(RUNTIME, YOGA_STUDIO, update), table).toHaveLength(0);
      expect(await as(RUNTIME, BARBERSHOP, update), table).toHaveLength(1);
      // A pending effect or an event changed by a Tool API path: refused, scoped or not.
      for (const scope of [BARBERSHOP, YOGA_STUDIO, null]) {
        const outcome = await refusal(as(TOOL_API, scope, update));
        expect(outcome.code, `${table} ${String(scope)}`).toBe("42501");
        expect(outcome.message, `${table} ${String(scope)}`).toContain(
          `permission denied for table ${table}`,
        );
      }
    }
  });

  it("no role deletes or truncates an effect or a provider event, scoped or not (42501)", SLOW, async () => {
    for (const table of SCOPED_TABLES) {
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const statement of [`delete from ${table}`, `truncate ${table}`]) {
            const outcome = await refusal(as(role, scope, (tx) => tx.unsafe(statement)));
            expect(outcome.code, `${role} ${String(scope)}: ${statement}`).toBe("42501");
            expect(outcome.message, `${role} ${String(scope)}: ${statement}`).toContain(
              `permission denied for table ${table}`,
            );
          }
        }
      }
    }
  });

  it(
    "the Tool API (and so PUBLIC, whose grants it would hold) is refused outbox_claims, scoped or not (42501)",
    SLOW,
    async () => {
      for (const scope of [BARBERSHOP, null]) {
        for (const statement of [
          "select count(*) from outbox_claims",
          "insert into outbox_claims (outbox_row_id) values ('out-a7-03-alex-email')",
          "update outbox_claims set version = version + 1",
          "delete from outbox_claims",
          "truncate outbox_claims",
        ]) {
          const outcome = await refusal(as(TOOL_API, scope, (tx) => tx.unsafe(statement)));
          expect(outcome.code, `${String(scope)}: ${statement}`).toBe("42501");
          expect(outcome.message, `${String(scope)}: ${statement}`).toContain(
            "permission denied for table outbox_claims",
          );
        }
      }
    },
  );

  it("the runtime side reads every claim, scoped or not, and deletes one (a move to waiting_chat); it never truncates them", async () => {
    for (const scope of [null, BARBERSHOP]) {
      expect(await as(RUNTIME, scope, (tx) => countRows(tx, "outbox_claims")), String(scope)).toBe(1);
    }
    expect(
      await as(RUNTIME, null, async (tx) => {
        const deleted = await tx<{ id: string }[]>`
          delete from outbox_claims where outbox_row_id = ${textOf(CLAIM.outbox_row_id)}
          returning outbox_row_id as id
        `;
        return { deleted: deleted.map((row) => row.id), left: await countRows(tx, "outbox_claims") };
      }),
    ).toEqual({ deleted: [CLAIM.outbox_row_id], left: 0 });
    const outcome = await refusal(as(RUNTIME, null, (tx) => tx.unsafe("truncate outbox_claims")));
    expect(outcome.code).toBe("42501");
    expect(await countRows(db.sql, "outbox_claims")).toBe(1);
  });
});
