// T-204: the people and access part (K-22 v1.1: accounts, id_uploads, staff, staff_skills, team_powers, on_call,
// emergency_contacts, proof_codes, sessions, contact_changes and v1.1's page_links, with README rules 4, 5 and 8)
// against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/people-access`). The schema comes from
// migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app) or the runtime side (rosie_job) runs in its own transaction under SET LOCAL ROLE,
// with the call's settings set for that transaction: rosie.business_id through setBusinessScope() as a call is scoped,
// and rosie.person_id with set_config(..., true) as README rule 4 states it; then it is rolled back. Seed fixtures are
// loaded as the runtime side with no scope (K-04's fixture format), and committed. A refused fixture's own rows are
// written as the runtime side inside the check's transaction, before its role and settings are set.
//
// The rows come only from fixtures (rule 9): K-22 v1.1's seeds and the K-04, K-23 and K-29 seeds their after chains
// name (Lee's Barbershop, Lee Home Services and the master's sample cast: Sam Lee, Pat, Riley, Jordan, Casey, Alex M.).
// A row made here is a fixture row under a new id, or with one fault, or a new row of the same cast: its handles are in
// the 555-01xx range or at example.com, and its code, token and device hashes are sha256 of stand-in strings, never a
// real code or token. The wrapping key of the sealing check is random bytes made here and never written to a file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SealingError, type WrappingKeys, erasePerson, seal, unsealText } from "./sealing";
import { type Sql, type Tx, setBusinessScope } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/people-access/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The eleven tables of K-22 v1 and v1.1, in code-unit order (as PostgreSQL orders a relation's name). */
const OWN_TABLES = [
  "accounts",
  "contact_changes",
  "emergency_contacts",
  "id_uploads",
  "on_call",
  "page_links",
  "proof_codes",
  "sessions",
  "staff",
  "staff_skills",
  "team_powers",
];
/** Scoped by business_id (README rules 4 and 8; the table lists' rowLevelSecurity). */
const BUSINESS_SCOPED = [
  "contact_changes",
  "emergency_contacts",
  "on_call",
  "page_links",
  "staff",
  "staff_skills",
  "team_powers",
];
/** The business-scoped tables with 0012's two policies and no rule of their own. */
const PLAIN_SCOPED = ["emergency_contacts", "on_call", "staff", "staff_skills", "team_powers"];
/** Scope none, bound to the call's person instead (README rule 5): row-level security on. */
const PERSON_BOUND = ["proof_codes", "sessions"];
/** Scope none with no Tool API grant (README open gap): row-level security off, as K-04's persons. */
const RUNTIME_ONLY = ["accounts", "id_uploads"];
/** The tables every update of which raises the version (README rule 2), each with a one-column key. */
const VERSIONED = [
  "accounts",
  "emergency_contacts",
  "on_call",
  "page_links",
  "proof_codes",
  "sessions",
  "staff",
  "team_powers",
];
/** The six seeds 02-contracts' K-22 row names, which the card's proof loads. */
const CARD_SEEDS = [
  "seed-emergency-contact.json",
  "seed-owner-id-upload.json",
  "seed-proof-code.json",
  "seed-session.json",
  "seed-staff-invited.json",
  "seed-staff-joined.json",
];
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const YOGA_STUDIO = "biz-yoga-studio";
const SAM = "person-sam";
const ALEX = "person-alex";
const RILEY = "person-riley";
const JORDAN = "person-jordan";
/** Sam's device and his two session tokens, as seed-session holds them (sha256 of stand-in strings). */
const SAM_DEVICE = "e28c360bbd60fac9cabe9778c941ca8e14aaca204d780bfd44982220825ea15c";
const SAM_LIVE_TOKEN = "bcc9e6bc57d87c2e4bce0e6261d51dfa66d346abf24ef81de1bb8a4acd286127";
const SAM_SIGNED_OUT_TOKEN = "55c887c6a012afe4a89a3c2a798ec32f65a8e1a76d7acaf6338dd6dbcabc4267";
const HASH_KEY_NAME = "PROOF_CODE_HASH_KEY";
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
    onDelete?: string;
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

/** A call's settings: rosie.business_id (K-04 rule 4) and rosie.person_id (README rule 4); left out, unset. */
interface Scope {
  businessId?: string;
  personId?: string;
}

interface Refused {
  role: "toolApi" | "runtime";
  scope: Scope | null;
  action: "select" | "insert" | "update";
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

const TABLES = [
  ...(readJson(new URL("people-access.v1.tables.json", PART_DIR)) as { tables: ContractTable[] }).tables,
  ...(readJson(new URL("people-access.v1.1.tables.json", PART_DIR)) as { tables: ContractTable[] }).tables,
];
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted K-04 v1 seed, named as K-22's seeds name it: from K-22's fixtures/ folder. */
const CORE_SEEDS = (
  readJson(new URL("../core/fixtures/index.json", PART_DIR)) as { fixtures: IndexEntry[] }
).fixtures
  .filter((entry) => entry.expect === "accept")
  .map((entry) => `../../core/fixtures/${entry.file}`);

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-22 v1.1 lists no table ${name}`);
  }
  return table;
}

const columnsOf = (name: string): string[] => tableOf(name).columns.map((column) => column.name);
const columnsBut = (name: string, left: readonly string[]): string[] =>
  columnsOf(name).filter((column) => !left.includes(column));

/** What the Tool API may read, insert and update of the three tables whose grants are column grants (rules 5, 8). */
const PROOF_CODE_READ = columnsBut("proof_codes", ["code_hash"]);
const PROOF_CODE_SEND = [
  "id",
  "purpose",
  "person_id",
  "business_id",
  "sent_to_handle_id",
  "channel",
  "code_hash",
  "hash_key_name",
  "sent_at",
  "expires_at",
];
const SESSION_READ = columnsBut("sessions", ["token_sha256", "device_sha256"]);
const SESSION_UPDATE = ["last_seen_at", "ended_at", "ended_why", "version"];
const PAGE_LINK_READ = columnsBut("page_links", ["code_sha256"]);
const PAGE_LINK_ISSUE = [
  "id",
  "business_id",
  "person_id",
  "purpose",
  "step_id",
  "code_sha256",
  "sent_to_handle_id",
  "issued_at",
  "expires_at",
];
const PAGE_LINK_END = ["ended_at", "ended_why", "ended_by_contact_change_id", "version"];

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

/** The values of a fixture's `index`th own row of `table`. */
function valuesOf(file: string, table: string, index = 0): Values {
  const row = fixtureFile(file).rows.filter((candidate) => candidate.table === table)[index];
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row number ${String(index)}`);
  }
  return row.values;
}

/** The fixtures/ folder a fixture file sits in: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(file: URL): URL {
  const folder = new URL(".", file);
  return folder.href.endsWith("/invalid/") ? new URL("..", folder) : folder;
}

/**
 * A fixture's rows, after those of every fixture its `after` names (each path relative to the fixtures/ folder of the
 * file that names it, so K-22's seeds name K-04's as ../../core/fixtures/<file>), each file once. With `own` false the
 * file's own rows are left out (a refused fixture's are written inside each check).
 */
function fixtureRows(file: URL, seen: Set<string>, own = true): FixtureRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const fixture = readJson(file) as FixtureFile;
  const folder = fixturesFolderOf(file);
  return [
    ...fixture.after.flatMap((before) => fixtureRows(new URL(before, folder), seen)),
    ...(own ? fixture.rows : []),
  ];
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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The sha256 of a stand-in string, in lowercase hex: the form of every stored hash here, never a real one. */
const standIn = (label: string): string => createHash("sha256").update(label).digest("hex");

/** An ISO instant `minutes` after `iso`. */
const plus = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

/** Every K-22 row of the nine seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

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

/** Inserts one row with no RETURNING (a Tool API insert reads nothing back: README rules 4, 5 and 8). */
async function insertRow(sql: Sql | Tx, table: string, values: Values): Promise<number> {
  const result = await sql`insert into ${sql(table)} ${sql(columnValues(sql, table, values))}`;
  return result.count;
}

/** `column = value and ...` for each column of `where`. */
function whereOf(sql: Sql | Tx, where: Values) {
  const conditions = Object.entries(where).map(([column, value]) => sql`${sql(column)} = ${textOf(value)}`);
  return conditions.reduce((all, one) => sql`${all} and ${one}`);
}

/** Sets the call's person for the rest of the transaction (README rule 4); '' is what an ended setting reads as. */
async function setPerson(tx: Tx, personId: string): Promise<void> {
  await tx`select set_config('rosie.person_id', ${personId}, true)`;
}

/**
 * Runs `fn` in one transaction as `role` with the call's settings (null: none), then rolls it back. `before` rows are
 * first written as the runtime side with no settings, in the same transaction.
 */
async function as<T>(
  role: Role,
  scope: Scope | null,
  fn: (tx: Tx) => Promise<T>,
  before: readonly FixtureRow[] = [],
): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      if (before.length > 0) {
        await tx.unsafe(`set local role ${RUNTIME}`);
        for (const row of before) {
          await insertRow(tx, row.table, row.values);
        }
      }
      await tx.unsafe(`set local role ${role}`);
      if (scope?.businessId !== undefined) {
        await setBusinessScope(tx, scope.businessId);
      }
      if (scope?.personId !== undefined) {
        await setPerson(tx, scope.personId);
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

/** check_proof_code's outcome (README rule 5) for a typed code's hash at `at`. */
async function checkCode(tx: Tx, codeId: string, typedHash: string, at: string): Promise<string | undefined> {
  const [row] = await tx<{ outcome: string }[]>`
    select check_proof_code(${codeId}, ${typedHash}, ${at}::timestamptz) as outcome
  `;
  return row?.outcome;
}

async function deviceKnown(tx: Tx, device: string): Promise<boolean | undefined> {
  const [row] = await tx<{ known: boolean }[]>`select device_known(${device}) as known`;
  return row?.known;
}

interface Code {
  id: string;
  hash: string;
  values: Values;
}

/** A code as a send writes it: the ten columns rule 5 grants, its keyed hash a stand-in, working 10 minutes. */
function codeSent(
  id: string,
  purpose: string,
  personId: string | null,
  handleId: string,
  sentAt: string,
  businessId: string | null = null,
): Code {
  const hash = standIn(`code ${id}`);
  return {
    id,
    hash,
    values: {
      id,
      purpose,
      person_id: personId,
      business_id: businessId,
      sent_to_handle_id: handleId,
      channel: handleId.endsWith("-email") ? "email" : "text",
      code_hash: hash,
      hash_key_name: HASH_KEY_NAME,
      sent_at: sentAt,
      expires_at: plus(sentAt, 10),
    },
  };
}

/** A code already used (written on the runtime side, as a turn that checked it right would leave it). */
function codeUsed(
  id: string,
  purpose: string,
  personId: string,
  handleId: string,
  sentAt: string,
): FixtureRow {
  const code = codeSent(id, purpose, personId, handleId, sentAt);
  return { table: "proof_codes", values: { ...code.values, used_at: plus(sentAt, 1), version: 2 } };
}

/** A session started at `at` with a 30-day life (the seeds' example: README open gaps), naming its sign-in code. */
function sessionStarted(
  id: string,
  personId: string,
  codeId: string,
  provenVia: string,
  at: string,
  device = SAM_DEVICE,
): Values {
  return {
    id,
    person_id: personId,
    token_sha256: standIn(`token ${id}`),
    device_sha256: device,
    proven_via: provenVia,
    proof_code_id: codeId,
    started_at: at,
    last_seen_at: at,
    expires_at: plus(at, 30 * 24 * 60),
  };
}

/** A contact change with no business: the person's own, made by that person (README rule 4). */
function ownChange(
  id: string,
  personId: string,
  way: string,
  oldHandle: string,
  newHandle: string,
  at: string,
  proof: { code?: string; upload?: string },
): Values {
  return {
    id,
    person_id: personId,
    business_id: null,
    old_handle_id: oldHandle,
    new_handle_id: newHandle,
    way,
    proof_code_id: proof.code ?? null,
    id_upload_id: proof.upload ?? null,
    changed_by_person_id: personId,
    changed_at: at,
  };
}

const handleRow = (id: string, kind: string, address: string): FixtureRow => ({
  table: "handles",
  values: { id, kind, address },
});

/** Empties every table the fixtures write: truncating the heads cascades to the rest (this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** Loads fixture files with their `after` chains, each file once, as the runtime side; returns the rows per table. */
async function loadFixtures(files: readonly string[], own = true): Promise<Record<string, number>> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen, own));
  return committedAs(RUNTIME, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

/** What is loaded now, so checks that share a state load it once. */
let loadedState = "";

/** Every K-04 v1 seed and every K-22 v1.1 seed with its chain (K-23's and K-29's seeds among them). */
async function loadEverySeed(): Promise<void> {
  if (loadedState !== "every seed") {
    await reset();
    await loadFixtures([...CORE_SEEDS, ...SEEDS]);
    loadedState = "every seed";
  }
}

/** A refused fixture's after chain alone, without its own rows (each check writes those). */
async function loadChainOf(file: string): Promise<void> {
  const state = `chain ${[...fixtureFile(file).after].sort().join(" ")}`;
  if (loadedState !== state) {
    await reset();
    await loadFixtures([file], false);
    loadedState = state;
  }
}

/**
 * Every column the fixture gives is stored as given, read back as the owner by the table's primary key and compared on
 * the server in the column's own type (a time, a list, bytes or an instant as PostgreSQL reads both).
 */
async function expectStored(row: FixtureRow): Promise<void> {
  const columns = Object.keys(row.values);
  const key = tableOf(row.table).primaryKey;
  const compared = columns.map((column, i) => {
    const type = typeOf.get(`${row.table}.${column}`) ?? "";
    return `("${column}")::text is not distinct from ($${String(i + 1)}::${type})::text as "${column}"`;
  });
  const matched = key.map((column, i) => `"${column}" = $${String(columns.length + i + 1)}`);
  // A bytea value goes as its bytes: postgres.js serializes a text parameter bound to bytea as the text's own bytes.
  const given = columnValues(db.sql, row.table, row.values);
  const found = await db.sql.unsafe<Record<string, boolean>[]>(
    `select ${compared.join(", ")} from "${row.table}" where ${matched.join(" and ")}`,
    [...columns.map((column) => given[column] as never), ...key.map((column) => textOf(row.values[column]))],
  );
  const label = `${row.table} ${key.map((column) => textOf(row.values[column])).join(" ")}`;
  expect(found, label).toHaveLength(1);
  expect(found[0], label).toEqual(Object.fromEntries(columns.map((column) => [column, true])));
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each business-scoped table shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_SCOPED) {
    counts[table] = await countRows(sql, table);
  }
  return counts;
}

/** Rows of each business-scoped table whose business_id is `businessId` (null: no business), read as the owner. */
async function ownerRows(businessId: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of BUSINESS_SCOPED) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table)}
      where ${businessId === null ? db.sql`business_id is null` : db.sql`business_id = ${businessId}`}
    `;
    counts[table] = row?.n ?? -1;
  }
  return counts;
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
  db = await createTestDatabase({ name: "people_access" });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select c.relname || '.' || a.attname as key, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  `;
  for (const column of typed) {
    typeOf.set(column.key, column.type);
  }
}, 120_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table lists (K-22 v1 and v1.1)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
    time: "time without time zone",
  };

  it("the two lists name eleven tables: seven scoped by business on business_id, four scoped none; eight versioned", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      const scoped = BUSINESS_SCOPED.includes(table.name);
      expect([table.rowLevelSecurity.scope, table.rowLevelSecurity.column], table.name).toEqual(
        scoped ? ["business", "business_id"] : ["none", undefined],
      );
      expect([table.versioned, table.versionColumn], table.name).toEqual(
        VERSIONED.includes(table.name) ? [true, "version"] : [false, undefined],
      );
    }
    expect([...PERSON_BOUND, ...RUNTIME_ONLY].sort()).toEqual(
      OWN_TABLES.filter((table) => !BUSINESS_SCOPED.includes(table)),
    );
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

    it(`${table.name}: primary key, foreign keys with no schema prefix and their on delete (none named: PostgreSQL's default), unique rules (a partial one as a partial unique index) and index names are the table list's`, async () => {
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
        const onDelete = key.onDelete === undefined ? "" : ` ON DELETE ${key.onDelete.toUpperCase()}`;
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")})${onDelete}`,
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

  it("the eight versioned tables raise their version on every update (0002's rule): <table>_version_raised, and no other trigger on any of the eleven", async () => {
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

  it("the sealed fields (rule 6) are bytea, each sealed by the person column the list names, and no column keeps a plain copy", () => {
    const sealed = TABLES.flatMap((table) =>
      table.columns
        .filter((column) => column.sealedBy !== undefined)
        .map((column) => [
          `${table.name}.${column.name}`,
          column.sealedBy,
          typeOf.get(`${table.name}.${column.name}`),
        ]),
    );
    expect(sealed).toEqual([
      ["id_uploads.object_key", "person_id", "bytea"],
      ["emergency_contacts.name", "person_id", "bytea"],
      ["emergency_contacts.mobile", "person_id", "bytea"],
    ]);
    // The tables hold exactly the listed columns (checked above), so nothing beside the sealed form holds the value.
    for (const table of ["id_uploads", "emergency_contacts"]) {
      const bytea = columnsOf(table).filter((column) => typeOf.get(`${table}.${column}`) === "bytea");
      expect(bytea, table).toEqual(table === "id_uploads" ? ["object_key"] : ["name", "mobile"]);
    }
  });

  it("is recorded in schema_migrations as people_access, after business_setup and core_sealing_keys", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("people_access");
    expect(names.indexOf("people_access")).toBeGreaterThan(names.indexOf("business_setup"));
    expect(names.indexOf("people_access")).toBeGreaterThan(names.indexOf("core_sealing_keys"));
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern; README rules 4, 5 and 8)", () => {
  interface Policy {
    table: string;
    name: string;
    permissive: string;
    roles: string[];
    command: string;
    using: string | null;
    check: string | null;
  }

  /** Each Tool API policy of rules 4, 5 and 8: its command and its expressions, word for word from the README. */
  const RULE_POLICIES: { table: string; name: string; command: string; using?: string; check?: string }[] = [
    {
      table: "contact_changes",
      name: "contact_changes_tool_api_select",
      command: "SELECT",
      using: "business_id = current_setting('rosie.business_id', true)",
    },
    {
      table: "contact_changes",
      name: "contact_changes_tool_api_insert",
      command: "INSERT",
      check:
        "(business_id = current_setting('rosie.business_id', true) and way in ('in_person', 'owner_team_edit')) or (business_id is null and person_id = nullif(current_setting('rosie.person_id', true), '') and changed_by_person_id = person_id and (way not in ('own_code', 'email_on_file') or exists (select 1 from proof_codes c where c.id = contact_changes.proof_code_id and c.person_id = contact_changes.person_id and c.used_at is not null)))",
    },
    {
      table: "proof_codes",
      name: "proof_codes_tool_api_select",
      command: "SELECT",
      using:
        "person_id = nullif(current_setting('rosie.person_id', true), '') or (person_id is null and business_id = current_setting('rosie.business_id', true))",
    },
    { table: "proof_codes", name: "proof_codes_tool_api_insert", command: "INSERT", check: "true" },
    {
      table: "sessions",
      name: "sessions_tool_api_select",
      command: "SELECT",
      using: "person_id = nullif(current_setting('rosie.person_id', true), '')",
    },
    {
      table: "sessions",
      name: "sessions_tool_api_insert",
      command: "INSERT",
      check:
        "person_id = nullif(current_setting('rosie.person_id', true), '') and exists (select 1 from proof_codes c where c.id = sessions.proof_code_id and c.person_id = sessions.person_id and c.used_at is not null and c.purpose in ('sign_in', 'new_device'))",
    },
    {
      table: "sessions",
      name: "sessions_tool_api_update",
      command: "UPDATE",
      using: "person_id = nullif(current_setting('rosie.person_id', true), '') and ended_at is null",
      check: "person_id = nullif(current_setting('rosie.person_id', true), '')",
    },
    {
      table: "page_links",
      name: "page_links_tool_api_select",
      command: "SELECT",
      using: "business_id = nullif(current_setting('rosie.business_id', true), '')",
    },
    {
      table: "page_links",
      name: "page_links_tool_api_insert",
      command: "INSERT",
      check: "business_id = nullif(current_setting('rosie.business_id', true), '')",
    },
    {
      table: "page_links",
      name: "page_links_tool_api_update",
      command: "UPDATE",
      using: "business_id = nullif(current_setting('rosie.business_id', true), '') and ended_at is null",
      check: "business_id = nullif(current_setting('rosie.business_id', true), '')",
    },
  ];

  const policiesIn = (sql: Sql | Tx, schema: string): Promise<Policy[]> => sql<Policy[]>`
    select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
           qual as using, with_check as check
    from pg_policies where schemaname = ${schema}
    order by tablename, policyname
  `;

  it("row-level security is on for the seven business-scoped tables and the two bound to the call's person; off for accounts and id_uploads (no Tool API grant); none forced", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(
      OWN_TABLES.map((name) => ({ name, on: !RUNTIME_ONLY.includes(name), forced: false })),
    );
  });

  it("each table's policies, by name, role and command: 0012's two on the five plain tables; one per command for the Tool API and 0012's runtime policy on contact_changes and page_links; the person-bound ones on proof_codes and sessions, and every row for the runtime side", async () => {
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
      ...[...BUSINESS_SCOPED.filter((table) => !PLAIN_SCOPED.includes(table)), ...PERSON_BOUND].map(
        (table) => [table, `${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
      ),
      ...RULE_POLICIES.map((policy) => [policy.table, policy.name, "PERMISSIVE", [TOOL_API], policy.command]),
    ];
    const order = (rows: unknown[][]): unknown[][] =>
      [...rows].sort((a, b) =>
        `${String(a[0])} ${String(a[1])}`.localeCompare(`${String(b[0])} ${String(b[1])}`),
      );
    expect(order(shape)).toEqual(order(expected));
  });

  it("the plain tables' policies, and the runtime policies of contact_changes and page_links, are 0012's word for word (read from outbox_rows', which key on business_id); proof_codes' and sessions' runtime policies admit every row", async () => {
    const all = await policiesIn(db.sql, db.schema);
    const core = all.filter((policy) => policy.table === "outbox_rows");
    const of = (name: string): [string | null, string | null] => {
      const policy = all.find((candidate) => candidate.name === name);
      return [policy?.using ?? "missing", policy?.check ?? "missing"];
    };
    const coreRuntime = core.find((policy) => policy.name === "outbox_rows_runtime");
    const coreTool = core.find((policy) => policy.name === "outbox_rows_tool_api");
    for (const table of PLAIN_SCOPED) {
      expect(of(`${table}_runtime`), table).toEqual([coreRuntime?.using, coreRuntime?.check]);
      expect(of(`${table}_tool_api`), table).toEqual([coreTool?.using, coreTool?.check]);
    }
    for (const table of ["contact_changes", "page_links"]) {
      expect(of(`${table}_runtime`), table).toEqual([coreRuntime?.using, coreRuntime?.check]);
    }
    for (const table of PERSON_BOUND) {
      expect(of(`${table}_runtime`), table).toEqual(["true", "true"]);
    }
  });

  it("each Tool API policy of rules 4, 5 and 8 is the README's expression, as PostgreSQL reads both (built on copies of the four tables in a schema of their own, then compared)", async () => {
    const probe = `${db.schema}_probe`;
    const listed = await asOwner(async (tx) => {
      await tx.unsafe(`create schema ${probe}`);
      for (const table of ["proof_codes", "sessions", "contact_changes", "page_links"]) {
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

  it("table grants (DL-149, each to its named reader: the migration's header): both roles on the five plain tables and contact_changes; the runtime side alone on accounts and id_uploads and in full on proof_codes, sessions and page_links; the Tool API's table grant there only INSERT on sessions; no delete, truncate, references or trigger; nothing to PUBLIC", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
    `;
    const full = ["INSERT", "SELECT", "UPDATE"];
    const once = ["INSERT", "SELECT"];
    const want: Record<Role, Record<string, string[]>> = {
      rosie_app: {
        contact_changes: once,
        emergency_contacts: full,
        on_call: full,
        sessions: ["INSERT"],
        staff: full,
        staff_skills: once,
        team_powers: full,
      },
      rosie_job: {
        accounts: full,
        contact_changes: once,
        emergency_contacts: full,
        id_uploads: once,
        on_call: full,
        page_links: full,
        proof_codes: full,
        sessions: full,
        staff: full,
        staff_skills: once,
        team_powers: full,
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

  it("column grants (rules 5 and 8): the Tool API reads every proof_codes column but code_hash and inserts a send's ten; reads every sessions column but the two hashes and updates four; reads every page_links column but code_sha256, inserts an issue's nine and updates the end; no other column grant, and no hash readable", async () => {
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
      ["proof_codes", "SELECT", PROOF_CODE_READ],
      ["proof_codes", "INSERT", PROOF_CODE_SEND],
      ["sessions", "SELECT", SESSION_READ],
      ["sessions", "UPDATE", SESSION_UPDATE],
      ["page_links", "SELECT", PAGE_LINK_READ],
      ["page_links", "INSERT", PAGE_LINK_ISSUE],
      ["page_links", "UPDATE", PAGE_LINK_END],
    ];
    expect(granted.map((row) => `${row.table} ${row.column} ${row.grantee} ${row.privilege}`).sort()).toEqual(
      want
        .flatMap(([table, privilege, columns]) =>
          columns.map((column) => `${table} ${column} ${TOOL_API} ${privilege}`),
        )
        .sort(),
    );
    expect(PROOF_CODE_READ).toHaveLength(14);
    expect(SESSION_READ).toHaveLength(10);
    expect(PAGE_LINK_READ).toHaveLength(12);
    const hashes = await db.sql<{ readable: boolean }[]>`
      select has_column_privilege(${TOOL_API}, (${db.schema} || '.' || t.name)::regclass, t.col, 'SELECT') as readable
      from (values ('proof_codes', 'code_hash'), ('sessions', 'token_sha256'), ('sessions', 'device_sha256'),
                   ('page_links', 'code_sha256')) as t(name, col)
    `;
    expect(hashes.map((row) => row.readable)).toEqual([false, false, false, false]);
  });

  it("neither role owns a table or a function: they stay the migrations' role's", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace
        and p.proname in ('check_proof_code', 'proof_code_limits', 'session_for_token', 'device_known',
                          'page_link_for_code')
      order by 1
    `;
    expect(owners).toHaveLength(OWN_TABLES.length + 5);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });

  it("the five calls of rules 5 and 8: security definer, owned by the tables' owner, search_path pinned to this schema then pg_temp, with the README's arguments and results; the four SQL ones bound when made; EXECUTE for the two roles only, never PUBLIC", async () => {
    const calls = await db.sql<
      {
        name: string;
        definer: boolean;
        owner: string;
        table: string;
        config: string[];
        bound: boolean;
        language: string;
        args: string;
        result: string;
      }[]
    >`
      select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             (select pg_get_userbyid(relowner) from pg_class where oid = ${`${db.schema}.proof_codes`}::regclass) as table,
             p.proconfig as config, p.prosqlbody is not null as bound, l.lanname as language,
             pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = ${db.schema}::regnamespace
        and p.proname in ('check_proof_code', 'proof_code_limits', 'session_for_token', 'device_known',
                          'page_link_for_code')
      order by p.proname
    `;
    const pinned = [`search_path=${db.schema}, pg_temp`];
    expect(calls.map(({ owner, table, ...rest }) => ({ ...rest, ownedByTables: owner === table }))).toEqual([
      {
        name: "check_proof_code",
        definer: true,
        config: pinned,
        bound: false,
        language: "plpgsql",
        args: "code_id text, typed_hash text, at timestamp with time zone",
        result: "text",
        ownedByTables: true,
      },
      {
        name: "device_known",
        definer: true,
        config: pinned,
        bound: true,
        language: "sql",
        args: "device_sha256 text",
        result: "boolean",
        ownedByTables: true,
      },
      {
        name: "page_link_for_code",
        definer: true,
        config: pinned,
        bound: true,
        language: "sql",
        args: "code_sha256 text, at timestamp with time zone",
        result:
          "TABLE(page_link_id text, business_id text, person_id text, purpose text, step_id text, expires_at timestamp with time zone, version integer)",
        ownedByTables: true,
      },
      {
        name: "proof_code_limits",
        definer: true,
        config: pinned,
        bound: true,
        language: "sql",
        args: "handle_id text, purpose text, since timestamp with time zone, at timestamp with time zone",
        result: "TABLE(sent_since integer, paused_until timestamp with time zone)",
        ownedByTables: true,
      },
      {
        name: "session_for_token",
        definer: true,
        config: pinned,
        bound: true,
        language: "sql",
        args: "token_sha256 text, at timestamp with time zone",
        result: "TABLE(session_id text, person_id text)",
        ownedByTables: true,
      },
    ]);
    const grants = await db.sql<{ name: string; grantee: string }[]>`
      select p.proname as name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = ${db.schema}::regnamespace and a.privilege_type = 'EXECUTE'
        and p.proname in ('check_proof_code', 'proof_code_limits', 'session_for_token', 'device_known',
                          'page_link_for_code')
      order by 1, 2
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    expect(grants).toEqual(
      calls.flatMap((call) =>
        [me?.name ?? "", TOOL_API, RUNTIME].sort().map((grantee) => ({ name: call.name, grantee })),
      ),
    );
  });
});

describe("the seed fixtures load (fixtures/index.json): the six of 02-contracts' K-22 row, and on_call's, contact_changes' and v1.1's page_links'", () => {
  /** The K-22 rows the nine seeds give together, per table: every table gets rows. */
  const SEEDED = {
    accounts: 1,
    contact_changes: 1,
    emergency_contacts: 2,
    id_uploads: 1,
    on_call: 3,
    page_links: 4,
    proof_codes: 5,
    sessions: 2,
    staff: 4,
    staff_skills: 6,
    team_powers: 1,
  };

  it("the index lists nine seeds (the card's six among them) and thirty-one refused rows (25 of v1, 6 of v1.1), all on K-22's own tables", () => {
    expect([...SEEDS].sort()).toEqual(
      [...CARD_SEEDS, "seed-contact-change.json", "seed-on-call.json", "seed-page-link.json"].sort(),
    );
    const refused = INDEX.filter((entry) => entry.expect === "refuse");
    expect(refused.filter((entry) => entry.version === "v1")).toHaveLength(25);
    expect(refused.filter((entry) => entry.version === "v1.1")).toHaveLength(6);
    expect(INDEX.every((entry) => OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file}${CARD_SEEDS.includes(file) ? " (the card's)" : ""} inserts alone with its after chain, as the runtime side, and every K-22 row is stored as given`,
      SLOW,
      async () => {
        await reset();
        loadedState = "";
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

  it("all nine insert together, each after chain once, and no table is left empty", SLOW, async () => {
    await reset();
    loadedState = "";
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    for (const row of SEED_ROWS) {
      await expectStored(row);
    }
  });

  it("they insert together with every K-04 v1 seed as well, each file once", SLOW, async () => {
    await reset();
    loadedState = "";
    expect(CORE_SEEDS.length).toBeGreaterThan(0);
    const loaded = await loadFixtures([...CORE_SEEDS, ...SEEDS]);
    loadedState = "every seed";
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    const stored: Record<string, number> = {};
    for (const table of OWN_TABLES) {
      stored[table] = await countRows(db.sql, table);
    }
    expect(stored).toEqual(SEEDED);
  });
});

describe("the seeded rows read back", () => {
  beforeAll(loadEverySeed, 120_000);

  it("Sam's account: the mobile proven by his own text, the email by a code typed back; his ID at sign-up, its object key sealed (bytes, not the key's text); Pat invited to Lee Home Services, not joined, who may OK prices over $500", async () => {
    const [account] = await db.sql<Record<string, unknown>[]>`
      select a.mobile, a.email, a.mobile_proven_at is not null as "mobileProven", a.email_proven_at is not null as "emailProven",
             u.purpose, u.content_type as "contentType", length(u.object_key) > 0 as sealed
      from accounts a join id_uploads u on u.person_id = a.person_id
      where a.person_id = ${SAM}
    `;
    expect(account).toEqual({
      mobile: "+15555550100",
      email: "sam@example.com",
      mobileProven: true,
      emailProven: true,
      purpose: "sign_up",
      contentType: "image/jpeg",
      sealed: true,
    });
    const [pat] = await db.sql<Record<string, unknown>[]>`
      select s.status, s.joined_at as joined, p.power, p.over_cents as "overCents", p.over_currency as currency
      from staff s join team_powers p on p.staff_id = s.id and p.business_id = s.business_id
      where s.id = 'staff-pat-home-services'
    `;
    expect(pat).toEqual({
      status: "invited",
      joined: null,
      power: "prices",
      overCents: 50000,
      currency: "USD",
    });
  });

  it("the joined team: each joined from the mobile Sam gave and bookable after it; Riley speaks English and Spanish with an 8am day list; skills: Jordan plumbing and electrical, Casey plumbing, Riley every barber service, beard color and house calls", async () => {
    const team = await db.sql<
      { id: string; fromOwn: boolean; languages: string[]; dayList: string | null }[]
    >`
      select id, joined_from_number = mobile and bookable_at >= joined_at as "fromOwn", languages,
             day_list_time::text as "dayList"
      from staff where status = 'joined' order by id
    `;
    expect(team).toEqual([
      { id: "staff-casey-home-services", fromOwn: true, languages: ["en"], dayList: null },
      { id: "staff-jordan-home-services", fromOwn: true, languages: ["en"], dayList: "07:00:00" },
      { id: "staff-riley-barbershop", fromOwn: true, languages: ["en", "es"], dayList: "08:00:00" },
    ]);
    const skills = await db.sql<{ staff: string; kind: string; skill: string | null }[]>`
      select staff_id as staff, kind_id as kind, skill from staff_skills order by staff_id, kind_id, skill nulls first
    `;
    expect(skills.map((row) => `${row.staff} ${row.kind} ${row.skill ?? "(every service)"}`)).toEqual([
      "staff-casey-home-services plumber (every service)",
      "staff-jordan-home-services electrician (every service)",
      "staff-jordan-home-services plumber (every service)",
      "staff-riley-barbershop barber (every service)",
      "staff-riley-barbershop barber beard color",
      "staff-riley-barbershop barber house calls",
    ]);
  });

  it("on call for Lee Home Services' plumbing: the nearest free plumber in open hours, Jordan weeknights 5:30pm to 7:30am, Casey weekends and holidays; Jordan's contact Casey said yes, Riley's has not", async () => {
    const rows = await db.sql<
      {
        staff: string | null;
        hours: string;
        days: number[];
        holidays: boolean;
        from: string | null;
        until: string | null;
      }[]
    >`
      select staff_id as staff, hours, days, holidays, from_time::text as from, until_time::text as until
      from on_call where business_id = ${HOME_SERVICES} order by id
    `;
    expect(rows).toEqual([
      { staff: null, hours: "open", days: [1, 2, 3, 4, 5, 6, 7], holidays: false, from: null, until: null },
      {
        staff: "staff-casey-home-services",
        hours: "closed",
        days: [6, 7],
        holidays: true,
        from: null,
        until: null,
      },
      {
        staff: "staff-jordan-home-services",
        hours: "closed",
        days: [1, 2, 3, 4, 5],
        holidays: false,
        from: "17:30:00",
        until: "07:30:00",
      },
    ]);
    const contacts = await db.sql<{ pro: string; contact: string | null; yes: boolean }[]>`
      select person_id as pro, contact_person_id as contact, contact_yes_at is not null as yes
      from emergency_contacts order by id
    `;
    expect(contacts).toEqual([
      { pro: JORDAN, contact: "person-casey", yes: true },
      { pro: RILEY, contact: null, yes: false },
    ]);
  });
});

describe("proof codes: 10 minutes and 5 tries (RULES 6.2), held by the schema and by check_proof_code", () => {
  beforeAll(loadEverySeed, 120_000);

  const at = "2026-11-04T09:00:00.000Z";

  it("five wrong codes pause the code 15 minutes from the fifth: wrong four times, paused at the fifth; a sixth try, even the right code, is refused as paused and changes nothing", async () => {
    const code = codeSent("code-probe-five-wrong", "sign_in", JORDAN, "handle-jordan", at);
    const answer = await as(TOOL_API, { personId: JORDAN }, async (tx) => {
      await insertRow(tx, "proof_codes", code.values);
      const outcomes: (string | undefined)[] = [];
      for (let minute = 1; minute <= 5; minute += 1) {
        outcomes.push(
          await checkCode(tx, code.id, standIn(`a wrong code ${String(minute)}`), plus(at, minute)),
        );
      }
      const read = async () => {
        const [row] = await tx<
          { tries: number; last: Date; paused: Date; used: Date | null; version: number }[]
        >`
          select wrong_tries as tries, last_wrong_at as last, paused_until as paused, used_at as used, version
          from proof_codes where id = ${code.id}
        `;
        return row;
      };
      const afterFive = await read();
      const sixth = await checkCode(tx, code.id, code.hash, plus(at, 6));
      const seventh = await checkCode(tx, code.id, standIn("a wrong code 7"), plus(at, 7));
      return { outcomes, afterFive, sixth, seventh, afterSixth: await read() };
    });
    expect(answer.outcomes).toEqual(["wrong", "wrong", "wrong", "wrong", "paused"]);
    expect(answer.afterFive).toEqual({
      tries: 5,
      last: new Date(plus(at, 5)),
      paused: new Date(plus(at, 20)),
      used: null,
      version: 6,
    });
    expect([answer.sixth, answer.seventh]).toEqual(["paused", "paused"]);
    expect(answer.afterSixth).toEqual(answer.afterFive);
  });

  it("a code expires after 10 minutes: the right code at 10 minutes and a second is expired and changes nothing; at exactly 10 minutes it is right, and then used; an unknown code id is unknown", async () => {
    const late = codeSent("code-probe-late", "sign_in", SAM, "handle-sam", at);
    const onTime = codeSent("code-probe-on-time", "sign_in", SAM, "handle-sam", at);
    const answer = await as(TOOL_API, { personId: SAM }, async (tx) => {
      await insertRow(tx, "proof_codes", late.values);
      await insertRow(tx, "proof_codes", onTime.values);
      const expired = await checkCode(tx, late.id, late.hash, plus(at, 10 + 1 / 60));
      const [lateRow] = await tx<{ used: Date | null; tries: number; version: number }[]>`
        select used_at as used, wrong_tries as tries, version from proof_codes where id = ${late.id}
      `;
      return {
        expired,
        lateRow,
        right: await checkCode(tx, onTime.id, onTime.hash, plus(at, 10)),
        again: await checkCode(tx, onTime.id, onTime.hash, plus(at, 10)),
        unknown: await checkCode(tx, "code-probe-nobody", onTime.hash, plus(at, 1)),
      };
    });
    expect(answer).toEqual({
      expired: "expired",
      lateRow: { used: null, tries: 0, version: 1 },
      right: "right",
      again: "used",
      unknown: "unknown",
    });
  });

  it("the schema holds both without the call: a sixth wrong try is refused (proof_codes_wrong_tries_range), a code used after five wrong codes or after its 10 minutes is refused (proof_codes_used_in_time), a code that works longer than 10 minutes is refused (proof_codes_ten_minutes), and a fifth wrong code without its 15-minute pause is refused (proof_codes_pause_after_five); 23514 each, on the runtime side", async () => {
    const paused = "code-jordan-sign-in-paused";
    const update = (set: Values) => (tx: Tx) =>
      tx`update proof_codes set ${tx(columnValues(tx, "proof_codes", set))} where id = ${paused}`;
    // One fault only: the pause is cleared with it, so proof_codes_pause_after_five has nothing to refuse.
    const sixth = await refusal(
      as(
        RUNTIME,
        null,
        update({ wrong_tries: 6, last_wrong_at: "2026-10-26T07:05:00Z", paused_until: null, version: 7 }),
      ),
    );
    expect([sixth.code, sixth.constraint]).toEqual(["23514", "proof_codes_wrong_tries_range"]);
    const usedAfterFive = await refusal(
      as(RUNTIME, null, update({ used_at: "2026-10-26T07:05:00Z", version: 7 })),
    );
    expect([usedAfterFive.code, usedAfterFive.constraint]).toEqual(["23514", "proof_codes_used_in_time"]);
    const code = codeSent("code-probe-eleven-minutes", "sign_in", SAM, "handle-sam", at);
    const longer = await refusal(
      as(RUNTIME, null, (tx) => insertRow(tx, "proof_codes", { ...code.values, expires_at: plus(at, 11) })),
    );
    expect([longer.code, longer.constraint]).toEqual(["23514", "proof_codes_ten_minutes"]);
    const usedLate = await refusal(
      as(RUNTIME, null, (tx) => insertRow(tx, "proof_codes", { ...code.values, used_at: plus(at, 11) })),
    );
    expect([usedLate.code, usedLate.constraint]).toEqual(["23514", "proof_codes_used_in_time"]);
    const unpaused = await refusal(
      as(RUNTIME, null, (tx) =>
        insertRow(tx, "proof_codes", { ...code.values, wrong_tries: 5, last_wrong_at: plus(at, 5) }),
      ),
    );
    expect([unpaused.code, unpaused.constraint]).toEqual(["23514", "proof_codes_pause_after_five"]);
    // The same rows within the rules pass: used at 9 minutes, and paused 15 minutes from the fifth.
    expect(
      await as(RUNTIME, null, (tx) => insertRow(tx, "proof_codes", { ...code.values, used_at: plus(at, 9) })),
    ).toBe(1);
    expect(
      await as(RUNTIME, null, (tx) =>
        insertRow(tx, "proof_codes", {
          ...code.values,
          wrong_tries: 5,
          last_wrong_at: plus(at, 5),
          paused_until: plus(at, 20),
        }),
      ),
    ).toBe(1);
  });

  it("proof_code_limits answers only a count and a pause: both codes to Jordan's mobile counted for every person and purpose, while Jordan's own read sees his one; the pause until 7:19am, then none", async () => {
    const forSam = codeUsed(
      "code-probe-to-jordan-for-sam",
      "contact_change",
      SAM,
      "handle-jordan",
      "2026-10-26T07:30:00Z",
    );
    const answer = await as(
      TOOL_API,
      { personId: JORDAN },
      async (tx) => {
        const limits = (since: string, now: string) => tx<{ sentSince: number; pausedUntil: Date | null }[]>`
          select sent_since as "sentSince", paused_until as "pausedUntil"
          from proof_code_limits('handle-jordan', 'sign_in', ${since}::timestamptz, ${now}::timestamptz)
        `;
        const own = await tx<{ id: string }[]>`select id from proof_codes order by id`;
        return {
          during: await limits("2026-10-26T00:00:00Z", "2026-10-26T07:10:00Z"),
          after: await limits("2026-10-26T00:00:00Z", "2026-10-26T07:20:00Z"),
          later: await limits("2026-10-26T07:20:00Z", "2026-10-26T07:40:00Z"),
          nobody:
            await tx`select * from proof_code_limits('handle-avery', 'sign_in', '2026-10-01T00:00:00Z', '2026-10-26T07:20:00Z')`,
          own: own.map((row) => row.id),
        };
      },
      [forSam],
    );
    expect(answer).toEqual({
      during: [{ sentSince: 2, pausedUntil: new Date("2026-10-26T07:19:00Z") }],
      after: [{ sentSince: 2, pausedUntil: null }],
      later: [{ sentSince: 1, pausedUntil: null }],
      nobody: [{ sent_since: 0, paused_until: null }],
      own: ["code-jordan-sign-in-paused"],
    });
  });
});

/** One way a refused fixture passes once its one fault is gone (README, "Seed and refused-row fixtures"). */
interface Fixed {
  label: string;
  /** Default: the fixture's role and settings. */
  role?: Role;
  scope?: Scope | null;
  /** Merged into the fixture's values (insert) or set (update). */
  change?: Values;
  /** Columns left out of the fixture's values. */
  drop?: string[];
  /** A select's columns instead of the fixture's. */
  columns?: string[];
  /** Rows written on the runtime side first, beside the fixture's own. */
  before?: FixtureRow[];
  /** Run as the call before its action (check_proof_code saying right). */
  prepare?: (tx: Tx) => Promise<void>;
  /** Another action in place of the fixture's. */
  action?: (tx: Tx) => Promise<number>;
  rows: number;
}

/** Why a refused fixture's 42501 comes: no grant reaches it, or a policy refuses the row. */
type Why = "privilege" | "policy";

const runtimeSide: Fixed = { label: "the same on the runtime side", role: RUNTIME, scope: null, rows: 1 };

/** Every refused fixture, its one reason and each way it passes without it, grouped by after chain. */
const REFUSED_CASES: { file: string; why?: Why; fixed: Fixed[] }[] = [
  {
    file: "invalid/refuse-staff-joined-from-other-mobile.json",
    fixed: [
      {
        label: "the same join from Pat's own mobile",
        change: { joined_from_number: "+15555550107" },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-bookable-before-join.json",
    fixed: [
      {
        label: "the same yes once Pat joined from Pat's own mobile",
        change: { status: "joined", joined_at: "2026-10-19T15:02:00Z", joined_from_number: "+15555550107" },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-admin-export-power.json",
    fixed: [{ label: "the same power as money", change: { power: "money" }, rows: 1 }],
  },
  {
    file: "invalid/refuse-emergency-contact-is-pro.json",
    fixed: [
      {
        label: "the same contact as Jordan",
        change: { contact_person_id: JORDAN, contact_handle_id: "handle-jordan" },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-sign-in-own-change.json",
    why: "policy",
    fixed: [
      { label: "the same row in Jordan's own call", scope: { personId: JORDAN }, rows: 1 },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-session-contact-change-code.json",
    why: "policy",
    fixed: [
      {
        label: "the same insert naming a used sign-in code of Jordan's, in his own call",
        before: [
          codeUsed("code-jordan-sign-in-oct31", "sign_in", JORDAN, "handle-jordan", "2026-10-31T18:00:00Z"),
        ],
        change: { proof_code_id: "code-jordan-sign-in-oct31" },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-proof-code-raw.json",
    fixed: [
      {
        label: "the same code as a 64-hex keyed hash",
        change: { code_hash: standIn("482913 keyed") },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-code-after-ten-minutes.json",
    fixed: [
      {
        label: "the same code typed back at 9 minutes",
        change: { used_at: "2026-10-27T08:29:00Z" },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-proof-code-inserted-used.json",
    why: "privilege",
    fixed: [{ label: "the same insert without used_at", drop: ["used_at"], rows: 1 }, runtimeSide],
  },
  {
    file: "invalid/refuse-session-raw-token.json",
    fixed: [
      {
        label: "the same session with the token's sha256",
        change: { token_sha256: standIn("session token sam oct26") },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-proof-code-hash-read.json",
    why: "privilege",
    fixed: [
      runtimeSide,
      {
        label: "every other column, in Sam's own call",
        scope: { businessId: BARBERSHOP, personId: SAM },
        columns: PROOF_CODE_READ,
        rows: 1,
      },
      { label: "every other column, in a call acting for no one", columns: PROOF_CODE_READ, rows: 0 },
    ],
  },
  {
    file: "invalid/refuse-proof-code-pause-lifted.json",
    why: "privilege",
    fixed: [runtimeSide],
  },
  {
    file: "invalid/refuse-other-person-code-read.json",
    fixed: [
      {
        label: "the same read in Jordan's own call",
        scope: { businessId: HOME_SERVICES, personId: JORDAN },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-own-chat-change-business-read.json",
    fixed: [runtimeSide],
  },
  {
    file: "invalid/refuse-own-chat-change-for-another.json",
    why: "policy",
    fixed: [
      {
        label: "the same row in Alex's own call",
        scope: { businessId: BARBERSHOP, personId: ALEX },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-own-chat-change-under-business.json",
    why: "policy",
    fixed: [
      {
        label: "the same row with no business in Alex's own call",
        scope: { personId: ALEX },
        change: { business_id: null },
        rows: 1,
      },
      {
        label: "the same row with no business in Alex's own call, scoped to the barbershop",
        scope: { businessId: BARBERSHOP, personId: ALEX },
        change: { business_id: null },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-page-link-raw-code.json",
    fixed: [
      {
        label: "the same row with the sha256",
        change: { code_sha256: standIn("link code sam s1-29") },
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-page-link-code-read.json",
    why: "privilege",
    fixed: [{ label: "the same read of every column but code_sha256", columns: PAGE_LINK_READ, rows: 1 }],
  },
  {
    file: "invalid/refuse-page-link-reopened.json",
    fixed: [
      runtimeSide,
      {
        label: "ending a live link in the same scope",
        action: async (tx) =>
          (
            await tx`
              update page_links set ended_at = '2026-10-21T09:00:00Z', ended_why = 'step_done', version = 2
              where id = 'page-link-sam-registration'
            `
          ).count,
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-page-link-other-business-read.json",
    fixed: [{ label: "the barbershop's own scope", scope: { businessId: BARBERSHOP }, rows: 1 }],
  },
  {
    file: "invalid/refuse-page-link-to-another-person.json",
    fixed: [
      { label: "the same row sent to Sam's handle", change: { sent_to_handle_id: "handle-sam" }, rows: 1 },
    ],
  },
  {
    file: "invalid/refuse-page-link-inserted-ended.json",
    why: "privilege",
    fixed: [{ label: "the same insert without the end", drop: ["ended_at", "ended_why"], rows: 1 }],
  },
  {
    file: "invalid/refuse-session-token-read.json",
    why: "privilege",
    fixed: [
      runtimeSide,
      {
        label: "every column but the two hashes, in Sam's own call",
        scope: { personId: SAM },
        columns: SESSION_READ,
        rows: 1,
      },
    ],
  },
  {
    file: "invalid/refuse-session-device-read.json",
    why: "privilege",
    fixed: [
      {
        label: "the same read without device_sha256",
        columns: (fixtureFile("invalid/refuse-session-device-read.json").refused?.columns ?? []).filter(
          (column) => column !== "device_sha256",
        ),
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-other-person-session-read.json",
    fixed: [
      { label: "the same read in Sam's own call", scope: { businessId: BARBERSHOP, personId: SAM }, rows: 1 },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-other-person-session-end.json",
    fixed: [
      {
        label: "the same update in Sam's own call (version 2 to 3)",
        scope: { businessId: BARBERSHOP, personId: SAM },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-sign-in-session-read.json",
    fixed: [{ label: "the same read in Sam's own call", scope: { personId: SAM }, rows: 1 }, runtimeSide],
  },
  {
    file: "invalid/refuse-sign-in-session-end.json",
    fixed: [{ label: "the same update in Sam's own call", scope: { personId: SAM }, rows: 1 }, runtimeSide],
  },
  {
    file: "invalid/refuse-sign-in-session-start.json",
    why: "policy",
    fixed: [{ label: "the same insert in Sam's own call", scope: { personId: SAM }, rows: 1 }, runtimeSide],
  },
  {
    file: "invalid/refuse-session-unused-code.json",
    why: "policy",
    fixed: [
      {
        label: "the same insert once check_proof_code says right for that code",
        prepare: async (tx) => {
          const code = valuesOf("invalid/refuse-session-unused-code.json", "proof_codes");
          const outcome = await checkCode(
            tx,
            textOf(code.id),
            textOf(code.code_hash),
            "2026-10-29T08:21:00Z",
          );
          if (outcome !== "right") {
            throw new Error(`check_proof_code answered ${String(outcome)}`);
          }
        },
        rows: 1,
      },
      runtimeSide,
    ],
  },
  {
    file: "invalid/refuse-ended-session-reopened.json",
    fixed: [runtimeSide],
  },
];

const roleOf = (role: Refused["role"]): Role => (role === "toolApi" ? TOOL_API : RUNTIME);

/** A fixture's scope as the call's settings: null and {} both set neither. */
const settingsOf = (scope: Scope | null): Scope | null =>
  scope === null || (scope.businessId === undefined && scope.personId === undefined) ? null : scope;

/** The fixture's action, with a fix's change, dropped columns or columns; resolves to the rows read or written. */
function actionOf(refused: Refused, fix: Fixed | null) {
  return async (tx: Tx): Promise<number> => {
    await fix?.prepare?.(tx);
    if (fix?.action !== undefined) {
      return fix.action(tx);
    }
    const adjust = (values: Values): Values => {
      const kept = Object.fromEntries(
        Object.entries(values).filter(([column]) => !(fix?.drop ?? []).includes(column)),
      );
      return { ...kept, ...(fix?.change ?? {}) };
    };
    if (refused.action === "insert") {
      return insertRow(tx, refused.table, adjust(refused.values ?? {}));
    }
    const where = whereOf(tx, refused.where ?? {});
    if (refused.action === "select") {
      const columns = fix?.columns ?? refused.columns;
      const rows =
        columns === undefined
          ? await tx`select * from ${tx(refused.table)} where ${where}`
          : await tx`select ${tx(columns)} from ${tx(refused.table)} where ${where}`;
      return rows.length;
    }
    const result = await tx`
      update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, adjust(refused.set ?? {})))} where ${where}
    `;
    return result.count;
  };
}

describe("every refused fixture is refused for its one reason, and passes without it (README rules 4, 5 and 8 and the CHECKs)", () => {
  it("the cases cover the index's thirty-one refused fixtures, each once", () => {
    expect(REFUSED_CASES.map((entry) => entry.file).sort()).toEqual(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    );
  });

  for (const { file, why, fixed } of REFUSED_CASES) {
    describe(file, () => {
      const fixture = fixtureFile(file);
      const refused = fixture.refused;
      if (refused === undefined) {
        throw new Error(`${file} has no refused action`);
      }
      const role = roleOf(refused.role);
      const settings = settingsOf(refused.scope);
      const expectation = refused.expect;

      beforeAll(() => loadChainOf(file), 120_000);

      it(`the fixture: ${refused.role} ${refused.action} on ${refused.table} with ${JSON.stringify(refused.scope)} is refused as ${JSON.stringify(expectation)}`, async () => {
        const run = as(role, settings, actionOf(refused, null), fixture.rows);
        if (expectation.rows !== undefined) {
          expect(await run).toBe(expectation.rows);
          return;
        }
        const outcome = await refusal(run);
        expect(outcome.code).toBe(expectation.sqlstate);
        if (expectation.constraintOneOf !== undefined) {
          expect(expectation.constraintOneOf).toContain(outcome.constraint);
        }
        if (why === "privilege") {
          expect(outcome.message).toBe(`permission denied for table ${refused.table}`);
        }
        if (why === "policy") {
          expect(outcome.message).toBe(
            `new row violates row-level security policy for table "${refused.table}"`,
          );
        }
      });

      for (const fix of fixed) {
        it(`without its one fault: ${fix.label}`, async () => {
          const callRole = fix.role ?? role;
          const callSettings = fix.scope === undefined ? settings : settingsOf(fix.scope);
          expect(
            await as(callRole, callSettings, actionOf(refused, fix), [
              ...fixture.rows,
              ...(fix.before ?? []),
            ]),
          ).toBe(fix.rows);
        });
      }
    });
  }
});

describe("every path that binds a person (README rules 4 and 5): each in its order of calls", () => {
  beforeAll(loadEverySeed, 120_000);

  it("S11-52, a sign-in by a code on a device seen before: with no person the call reads the contact's limits, sends the code and reads none of Sam's codes, gets wrong and then right by the code id it made; acting for Sam, the device is known and his session starts, which his own call reads back", async () => {
    const at = "2026-11-02T08:20:00.000Z";
    const code = codeSent("code-probe-sign-in", "sign_in", SAM, "handle-sam", at);
    const answer = await as(TOOL_API, null, async (tx) => {
      const limits = await tx<{ sentSince: number; pausedUntil: Date | null }[]>`
        select sent_since as "sentSince", paused_until as "pausedUntil"
        from proof_code_limits('handle-sam', 'sign_in', ${plus(at, -24 * 60)}::timestamptz, ${at}::timestamptz)
      `;
      const sent = await insertRow(tx, "proof_codes", code.values);
      const seen = await tx`select id from proof_codes`;
      const wrong = await checkCode(tx, code.id, standIn("not the code"), plus(at, 1));
      const right = await checkCode(tx, code.id, code.hash, plus(at, 2));
      await setPerson(tx, SAM);
      const known = await deviceKnown(tx, SAM_DEVICE);
      const started = await insertRow(
        tx,
        "sessions",
        sessionStarted("session-probe-sign-in", SAM, code.id, "code", plus(at, 2)),
      );
      const own = await tx<{ id: string }[]>`select id from sessions order by started_at`;
      return { limits, sent, seen: seen.length, wrong, right, known, started, own: own.map((row) => row.id) };
    });
    expect(answer).toEqual({
      limits: [{ sentSince: 0, pausedUntil: null }],
      sent: 1,
      seen: 0,
      wrong: "wrong",
      right: "right",
      known: true,
      started: 1,
      own: ["session-sam-oct20", "session-sam-oct26", "session-probe-sign-in"],
    });
  });

  it("S13-45 row 8, a new device by a code to the owner's email: once the sign-in code is right the device is not known, so no session; a new_device code to Sam's email on file, right with no person, then starts the session naming the sign-in code; a second proof for the same sign-in starts none (23505)", async () => {
    const at = "2026-11-03T08:20:00.000Z";
    const signIn = codeSent("code-probe-new-device-sign-in", "sign_in", SAM, "handle-sam", at);
    const email = codeSent("code-probe-new-device-email", "new_device", SAM, "handle-sam-email", plus(at, 2));
    const device = standIn("device a new phone of sam");
    const answer = await as(TOOL_API, null, async (tx) => {
      await insertRow(tx, "proof_codes", signIn.values);
      const signInRight = await checkCode(tx, signIn.id, signIn.hash, plus(at, 1));
      await setPerson(tx, SAM);
      const knownBefore = await deviceKnown(tx, device);
      // The call ends with no session; the next call acts for no one until its own code is right.
      await setPerson(tx, "");
      await insertRow(tx, "proof_codes", email.values);
      const emailRight = await checkCode(tx, email.id, email.hash, plus(at, 3));
      await setPerson(tx, SAM);
      const started = await insertRow(
        tx,
        "sessions",
        sessionStarted(
          "session-probe-new-device",
          SAM,
          signIn.id,
          "code_and_email_code",
          plus(at, 3),
          device,
        ),
      );
      const knownAfter = await deviceKnown(tx, device);
      const second = await refusal(
        tx.savepoint((inner) =>
          insertRow(
            inner,
            "sessions",
            sessionStarted(
              "session-probe-new-device-2",
              SAM,
              signIn.id,
              "code_and_email_code",
              plus(at, 4),
              device,
            ),
          ),
        ),
      );
      return {
        signInRight,
        knownBefore,
        emailRight,
        started,
        knownAfter,
        second: [second.code, second.constraint],
      };
    });
    expect(answer).toEqual({
      signInRight: "right",
      knownBefore: false,
      emailRight: "right",
      started: 1,
      knownAfter: true,
      second: ["23505", "sessions_proof_code_key"],
    });
  });

  it("S13-45 row 8, a new device by the ID re-check: the runtime side writes the re_check upload; the call starts the session naming the used sign-in code only once it acts for Sam (42501 before), never naming his used owner_email code", async () => {
    const used = codeUsed(
      "code-probe-re-check-sign-in",
      "sign_in",
      SAM,
      "handle-sam",
      "2026-11-05T08:20:00.000Z",
    );
    const upload: FixtureRow = {
      table: "id_uploads",
      values: {
        ...valuesOf("seed-owner-id-upload.json", "id_uploads"),
        id: "idup-sam-re-check",
        purpose: "re_check",
        uploaded_at: "2026-11-05T08:25:00Z",
      },
    };
    const session = (codeId: string) =>
      sessionStarted(
        "session-probe-re-check",
        SAM,
        codeId,
        "code_and_id_re_check",
        "2026-11-05T08:26:00.000Z",
      );
    const before = [used, upload];
    const noPerson = await refusal(
      as(TOOL_API, null, (tx) => insertRow(tx, "sessions", session(textOf(used.values.id))), before),
    );
    expect([noPerson.code, noPerson.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "sessions"',
    ]);
    expect(
      await as(
        TOOL_API,
        { personId: SAM },
        (tx) => insertRow(tx, "sessions", session(textOf(used.values.id))),
        before,
      ),
    ).toBe(1);
    const otherCode = await refusal(
      as(
        TOOL_API,
        { personId: SAM },
        (tx) => insertRow(tx, "sessions", session("code-sam-owner-email")),
        before,
      ),
    );
    expect(otherCode.code).toBe("42501");
  });

  it("S1-10, the owner's email at sign-up: the code is sent and checked right with no person, and no Tool API call reads it back", async () => {
    const at = "2026-11-06T14:11:00.000Z";
    const code = codeSent("code-probe-owner-email", "owner_email", SAM, "handle-sam-email", at, BARBERSHOP);
    const answer = await as(TOOL_API, { businessId: BARBERSHOP }, async (tx) => {
      const sent = await insertRow(tx, "proof_codes", code.values);
      const right = await checkCode(tx, code.id, code.hash, plus(at, 1));
      const seen = await tx`select id from proof_codes where id = ${code.id}`;
      return { sent, right, seen: seen.length };
    });
    expect(answer).toEqual({ sent: 1, right: "right", seen: 0 });
  });

  it("D75, the person's own chat: Alex's own call sends the code to the new contact, checks it right and writes his own_chat change with no business, which it does not read back", async () => {
    const at = "2026-11-06T19:00:00.000Z";
    const code = codeSent("code-probe-own-chat", "contact_change", ALEX, "handle-alex", at);
    const answer = await as(TOOL_API, { businessId: BARBERSHOP, personId: ALEX }, async (tx) => {
      await insertRow(tx, "proof_codes", code.values);
      const right = await checkCode(tx, code.id, code.hash, plus(at, 2));
      const written = await insertRow(
        tx,
        "contact_changes",
        ownChange(
          "cc-probe-alex-email-to-phone",
          ALEX,
          "own_chat",
          "handle-alex-email",
          "handle-alex",
          plus(at, 2),
          {
            code: code.id,
          },
        ),
      );
      const readBack = await tx`select id from contact_changes where id = 'cc-probe-alex-email-to-phone'`;
      return { right, written, readBack: readBack.length };
    });
    expect(answer).toEqual({ right: "right", written: 1, readBack: 0 });
  });

  it("D77, at the desk: Riley's call for the barbershop sends a code for Alex it cannot read, checks it right, writes the in_person change under its business and reads it back; Sam's owner_team_edit of Riley's contact passes", async () => {
    const at = "2026-11-06T16:00:00.000Z";
    const newPhone = handleRow("handle-alex-new-phone", "phone", "+15555550114");
    const rileyEmail = handleRow("handle-riley-email", "email", "riley@example.com");
    const code = codeSent("code-probe-desk", "contact_change", ALEX, "handle-alex-new-phone", at, BARBERSHOP);
    const answer = await as(
      TOOL_API,
      { businessId: BARBERSHOP, personId: RILEY },
      async (tx) => {
        await insertRow(tx, "proof_codes", code.values);
        const seen = await tx`select id from proof_codes where id = ${code.id}`;
        const right = await checkCode(tx, code.id, code.hash, plus(at, 1));
        const written = await insertRow(tx, "contact_changes", {
          ...ownChange(
            "cc-probe-desk",
            ALEX,
            "in_person",
            "handle-alex",
            "handle-alex-new-phone",
            plus(at, 1),
            {
              code: code.id,
            },
          ),
          business_id: BARBERSHOP,
          changed_by_person_id: RILEY,
        });
        const readBack = await tx`select id from contact_changes where id = 'cc-probe-desk'`;
        return { seen: seen.length, right, written, readBack: readBack.length };
      },
      [newPhone, rileyEmail],
    );
    expect(answer).toEqual({ seen: 0, right: "right", written: 1, readBack: 1 });
    expect(
      await as(
        TOOL_API,
        { businessId: BARBERSHOP, personId: SAM },
        (tx) =>
          insertRow(tx, "contact_changes", {
            ...ownChange(
              "cc-probe-team-edit",
              RILEY,
              "owner_team_edit",
              "handle-riley",
              "handle-riley-email",
              at,
              {},
            ),
            business_id: BARBERSHOP,
            changed_by_person_id: SAM,
          }),
        [newPhone, rileyEmail],
      ),
    ).toBe(1);
  });

  it("D100, a lost phone: with no person the new chat sends a code to Alex's email on file and checks it right; acting for Alex it writes his email_on_file change with no business; with a code not yet right the same change is refused (42501)", async () => {
    const at = "2026-11-07T10:00:00.000Z";
    const newPhone = handleRow("handle-alex-new-phone", "phone", "+15555550114");
    const change = (codeId: string) =>
      ownChange(
        "cc-probe-lost-phone",
        ALEX,
        "email_on_file",
        "handle-alex",
        "handle-alex-new-phone",
        plus(at, 2),
        {
          code: codeId,
        },
      );
    for (const scope of [null, { businessId: BARBERSHOP }]) {
      const code = codeSent("code-probe-lost-phone", "contact_change", ALEX, "handle-alex-email", at);
      const answer = await as(
        TOOL_API,
        scope,
        async (tx) => {
          await insertRow(tx, "proof_codes", code.values);
          const right = await checkCode(tx, code.id, code.hash, plus(at, 2));
          await setPerson(tx, ALEX);
          return { right, written: await insertRow(tx, "contact_changes", change(code.id)) };
        },
        [newPhone],
      );
      expect(answer, JSON.stringify(scope)).toEqual({ right: "right", written: 1 });
    }
    const notYet = codeSent("code-probe-lost-phone-not-yet", "contact_change", ALEX, "handle-alex-email", at);
    const refusedChange = await refusal(
      as(
        TOOL_API,
        { personId: ALEX },
        async (tx) => {
          await insertRow(tx, "proof_codes", notYet.values);
          return insertRow(tx, "contact_changes", change(notYet.id));
        },
        [newPhone],
      ),
    );
    expect([refusedChange.code, refusedChange.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "contact_changes"',
    ]);
  });

  it("a portal call with a session: session_for_token finds Sam's live session and his person with no person set, and nothing for the signed-out token, an unknown one or the live one once expired; acting for Sam the call touches it (version 3) and signs out (version 4), after which it touches nothing", async () => {
    const answer = await as(TOOL_API, null, async (tx) => {
      const find = (token: string, at: string) => tx<{ session_id: string; person_id: string }[]>`
        select * from session_for_token(${token}, ${at}::timestamptz)
      `;
      const live = await find(SAM_LIVE_TOKEN, "2026-10-26T09:10:00Z");
      const signedOut = await find(SAM_SIGNED_OUT_TOKEN, "2026-10-20T08:20:00Z");
      const unknown = await find(standIn("a token nobody holds"), "2026-10-26T09:10:00Z");
      const expired = await find(SAM_LIVE_TOKEN, "2026-11-25T08:21:00Z");
      await setPerson(tx, live[0]?.person_id ?? "");
      const touched = await tx`
        update sessions set last_seen_at = '2026-10-26T09:10:00Z', version = 3 where id = 'session-sam-oct26'
      `;
      const ended = await tx`
        update sessions set ended_at = '2026-10-26T09:12:00Z', ended_why = 'signed_out', version = 4
        where id = 'session-sam-oct26'
      `;
      const again = await tx`
        update sessions set last_seen_at = '2026-10-26T09:13:00Z', version = 5 where id = 'session-sam-oct26'
      `;
      const [row] = await tx<{ version: number; ended: string }[]>`
        select version, ended_why as ended from sessions where id = 'session-sam-oct26'
      `;
      return {
        live,
        signedOut: signedOut.length,
        unknown: unknown.length,
        expired: expired.length,
        touched: touched.count,
        ended: ended.count,
        again: again.count,
        row,
      };
    });
    expect(answer).toEqual({
      live: [{ session_id: "session-sam-oct26", person_id: SAM }],
      signedOut: 0,
      unknown: 0,
      expired: 0,
      touched: 1,
      ended: 1,
      again: 0,
      row: { version: 4, ended: "signed_out" },
    });
  });

  it("a turn: Jordan's own turn reads only his codes and writes his own_code change with a used code of his; a call acting for Sam writes his signed_in_id_re_check change; the '' an ended setting leaves reads no one's session and knows no device", async () => {
    const at = "2026-11-07T18:00:00.000Z";
    const jordanEmail = handleRow("handle-jordan-email", "email", "jordan@example.com");
    const code = codeSent("code-probe-own-code", "contact_change", JORDAN, "handle-jordan", at);
    const answer = await as(
      TOOL_API,
      { personId: JORDAN },
      async (tx) => {
        const codes = await tx<{ id: string }[]>`select id from proof_codes order by id`;
        await insertRow(tx, "proof_codes", code.values);
        const right = await checkCode(tx, code.id, code.hash, plus(at, 1));
        const written = await insertRow(
          tx,
          "contact_changes",
          ownChange(
            "cc-probe-own-code",
            JORDAN,
            "own_code",
            "handle-jordan",
            "handle-jordan-email",
            plus(at, 1),
            {
              code: code.id,
            },
          ),
        );
        return { codes: codes.map((row) => row.id), right, written };
      },
      [jordanEmail],
    );
    expect(answer).toEqual({ codes: ["code-jordan-sign-in-paused"], right: "right", written: 1 });
    const reCheck: FixtureRow = {
      table: "id_uploads",
      values: {
        ...valuesOf("seed-owner-id-upload.json", "id_uploads"),
        id: "idup-sam-re-check-email",
        purpose: "re_check",
        uploaded_at: at,
      },
    };
    expect(
      await as(
        TOOL_API,
        { personId: SAM },
        (tx) =>
          insertRow(
            tx,
            "contact_changes",
            ownChange(
              "cc-probe-re-check",
              SAM,
              "signed_in_id_re_check",
              "handle-sam-email",
              "handle-sam-email-2",
              at,
              {
                upload: "idup-sam-re-check-email",
              },
            ),
          ),
        [handleRow("handle-sam-email-2", "email", "sam.lee@example.com"), reCheck],
      ),
    ).toBe(1);
    expect(
      await as(TOOL_API, { personId: "" }, async (tx) => ({
        sessions: (await tx`select id from sessions`).length,
        known: await deviceKnown(tx, SAM_DEVICE),
      })),
    ).toEqual({ sessions: 0, known: false });
  });

  it("a temporary sessions table the caller makes does not reach session_for_token (pg_temp is searched last)", async () => {
    const forged = standIn("a forged token");
    const found = await as(TOOL_API, null, async (tx) => {
      await tx`
        create temporary table sessions (id text, person_id text, token_sha256 text, ended_at timestamptz,
                                         expires_at timestamptz)
      `;
      await tx`insert into pg_temp.sessions values ('session-forged', ${SAM}, ${forged}, null, '2030-01-01T00:00:00Z')`;
      return tx`select * from session_for_token(${forged}, '2026-11-01T00:00:00Z')`;
    });
    expect(found).toHaveLength(0);
  });
});

describe("page links (rule 8): found only by page_link_for_code, ended and never reopened", () => {
  beforeAll(loadEverySeed, 120_000);

  const linkHash = (id: string): string =>
    textOf(fixtureFile("seed-page-link.json").rows.find((row) => row.values.id === id)?.values.code_sha256);

  it("page_link_for_code finds Sam's live registration link with no settings, and nothing for the ended S1-10 link, the registration link at its expiry or an unknown code", async () => {
    const answer = await as(TOOL_API, null, async (tx) => {
      const find = (hash: string, at: string) =>
        tx`select * from page_link_for_code(${hash}, ${at}::timestamptz)`;
      return {
        live: await find(linkHash("page-link-sam-registration"), "2026-10-20T09:00:00Z"),
        ended: (await find(linkHash("page-link-sam-s1-10"), "2026-10-19T15:00:00Z")).length,
        lapsed: (await find(linkHash("page-link-sam-registration"), "2026-10-26T14:50:00Z")).length,
        unknown: (await find(standIn("a link code nobody holds"), "2026-10-20T09:00:00Z")).length,
      };
    });
    expect(answer).toEqual({
      live: [
        {
          page_link_id: "page-link-sam-registration",
          business_id: BARBERSHOP,
          person_id: SAM,
          purpose: "registration",
          step_id: "S1-27",
          expires_at: new Date("2026-10-26T14:50:00Z"),
          version: 1,
        },
      ],
      ended: 0,
      lapsed: 0,
      unknown: 0,
    });
  });

  it("the barbershop's scope ends Riley's live link (left) and issues a live one; another business's scope issues none (42501)", async () => {
    const issued: Values = {
      id: "page-link-probe-sam-s1-29",
      business_id: BARBERSHOP,
      person_id: SAM,
      purpose: "registration",
      step_id: "S1-29",
      code_sha256: standIn("link code probe s1-29"),
      sent_to_handle_id: "handle-sam",
      issued_at: "2026-10-21T10:00:00Z",
      expires_at: "2026-10-28T10:00:00Z",
    };
    const answer = await as(TOOL_API, { businessId: BARBERSHOP }, async (tx) => {
      const ended = await tx`
        update page_links set ended_at = '2026-10-21T09:00:00Z', ended_why = 'left', version = 2
        where id = 'page-link-riley-s2-06'
      `;
      const found =
        await tx`select * from page_link_for_code(${linkHash("page-link-riley-s2-06")}, '2026-10-21T09:30:00Z')`;
      return { ended: ended.count, found: found.length, issued: await insertRow(tx, "page_links", issued) };
    });
    expect(answer).toEqual({ ended: 1, found: 0, issued: 1 });
    const elsewhere = await refusal(
      as(TOOL_API, { businessId: YOGA_STUDIO }, (tx) => insertRow(tx, "page_links", issued)),
    );
    expect([elsewhere.code, elsewhere.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "page_links"',
    ]);
  });
});

describe("row-level security per business on the seven business-scoped tables, every K-04 v1 and K-22 v1.1 seed loaded", () => {
  beforeAll(loadEverySeed, 120_000);

  it(
    "with no scope the Tool API reads no row of the seven; each business's scope shows exactly its own rows (a contact change with no business in none)",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(BUSINESS_SCOPED.map((table) => [table, 0]));
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = (await db.sql<{ id: string }[]>`select id from businesses order by id`).map(
        (row) => row.id,
      );
      expect(businesses).toEqual(expect.arrayContaining([BARBERSHOP, HOME_SERVICES, YOGA_STUDIO]));
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, { businessId: business }, visibleRows), business).toEqual(
          await ownerRows(business),
        );
      }
      const home = await ownerRows(HOME_SERVICES);
      for (const table of ["staff", "staff_skills", "team_powers", "on_call", "emergency_contacts"]) {
        expect(home[table], table).toBeGreaterThan(0);
      }
      expect((await ownerRows(BARBERSHOP)).page_links).toBe(4);
      expect((await ownerRows(null)).contact_changes).toBe(1);
    },
  );

  it(
    "the runtime side with no scope reads every row of the seven, a contact change with no business included; with a scope set (per write), only that business's",
    SLOW,
    async () => {
      const all = await visibleRows(db.sql);
      expect(await as(RUNTIME, null, visibleRows)).toEqual(all);
      for (const business of [BARBERSHOP, HOME_SERVICES, YOGA_STUDIO]) {
        expect(await as(RUNTIME, { businessId: business }, visibleRows), business).toEqual(
          await ownerRows(business),
        );
      }
    },
  );

  it("the Tool API writes only its scope's rows: another business's insert is refused (42501), its update finds no row, a row cannot move to another business; neither role deletes a row of the eleven", async () => {
    const skill = {
      ...valuesOf("seed-staff-joined.json", "staff_skills", 1),
      id: "skill-jordan-electrician-2",
      skill: "panel upgrades",
    };
    expect(
      (await refusal(as(TOOL_API, { businessId: YOGA_STUDIO }, (tx) => insertRow(tx, "staff_skills", skill))))
        .code,
    ).toBe("42501");
    expect(
      await as(TOOL_API, { businessId: HOME_SERVICES }, (tx) => insertRow(tx, "staff_skills", skill)),
    ).toBe(1);
    const bump = async (tx: Tx): Promise<number> =>
      (await tx`update staff set version = version + 1 where id = 'staff-riley-barbershop'`).count;
    expect(await as(TOOL_API, { businessId: YOGA_STUDIO }, bump)).toBe(0);
    expect(await as(TOOL_API, { businessId: BARBERSHOP }, bump)).toBe(1);
    const move = (tx: Tx) => tx`
      update on_call set business_id = ${YOGA_STUDIO}, staff_id = null, version = version + 1
      where id = 'oncall-plumbing-open-hours'
    `;
    expect((await refusal(as(TOOL_API, { businessId: HOME_SERVICES }, move))).code).toBe("42501");
    for (const role of ROLES) {
      for (const table of OWN_TABLES) {
        const removed = await refusal(
          as(role, { businessId: BARBERSHOP }, (tx) => tx`delete from ${tx(table)}`),
        );
        expect([removed.code, removed.message], `${role} ${table}`).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    }
  });

  it("accounts and id_uploads are the runtime side's alone: the Tool API is refused them (42501), scoped or not, and the runtime side reads them", async () => {
    for (const table of RUNTIME_ONLY) {
      for (const scope of [{ businessId: BARBERSHOP, personId: SAM }, null]) {
        const refused = await refusal(as(TOOL_API, scope, (tx) => countRows(tx, table)));
        expect([refused.code, refused.message], table).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
      expect(await as(RUNTIME, null, (tx) => countRows(tx, table)), table).toBe(1);
    }
  });
});

describe("sealed fields (rule 6; T-182's sealing): the stored value is the sealed form under the pro's own key", () => {
  beforeAll(loadEverySeed, 120_000);

  it("Casey's emergency contact, sealed under Casey's key and saved by the Tool API in Lee Home Services' scope, opens with that key and holds no plain text; once Casey's key is erased it opens no more", async () => {
    const wrappingKey = crypto.getRandomValues(new Uint8Array(32));
    const keys: WrappingKeys = { resolve: () => wrappingKey };
    const answer = await asOwner(async (tx) => {
      const name = await seal(tx, keys, "person-casey", "Jordan");
      const mobile = await seal(tx, keys, "person-casey", "+15555550111");
      await tx.unsafe(`set local role ${TOOL_API}`);
      await setBusinessScope(tx, HOME_SERVICES);
      const saved = await insertRow(tx, "emergency_contacts", {
        id: "ec-casey-home-services",
        business_id: HOME_SERVICES,
        person_id: "person-casey",
        name: `\\x${toHex(name)}`,
        mobile: `\\x${toHex(mobile)}`,
        agreed_ticked_at: "2026-10-19T15:02:00Z",
        added_at: "2026-10-19T15:02:00Z",
      });
      await tx.unsafe("reset role");
      const [row] = await tx<{ name: Uint8Array; mobile: Uint8Array }[]>`
        select name, mobile from emergency_contacts where id = 'ec-casey-home-services'
      `;
      const storedName = new Uint8Array(row?.name ?? new Uint8Array());
      const storedMobile = new Uint8Array(row?.mobile ?? new Uint8Array());
      const asText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
      const plain = asText(storedName).includes("Jordan") || asText(storedMobile).includes("5555550111");
      const opened = [
        await unsealText(tx, keys, "person-casey", storedName),
        await unsealText(tx, keys, "person-casey", storedMobile),
      ];
      const erased = await erasePerson(tx, "person-casey");
      let afterErase = "opened";
      try {
        await unsealText(tx, keys, "person-casey", storedName);
      } catch (error) {
        afterErase = error instanceof SealingError ? error.code : "other error";
      }
      return { saved, plain, opened, erased: erased.ok, afterErase };
    });
    expect(answer).toEqual({
      saved: 1,
      plain: false,
      opened: ["Jordan", "+15555550111"],
      erased: true,
      afterErase: "erased",
    });
  });
});

describe("versions (rule 2): every update of the eight versioned tables raises the version by exactly one", () => {
  beforeAll(loadEverySeed, 120_000);

  it("on the runtime side, an update that leaves it is refused (<table>_version_raised, 23514) and one that raises it passes", async () => {
    for (const table of VERSIONED) {
      const row = SEED_ROWS.find((candidate) => candidate.table === table);
      if (row === undefined) {
        throw new Error(`no seed row of ${table}`);
      }
      const key = Object.fromEntries(
        tableOf(table).primaryKey.map((column) => [column, row.values[column] ?? null]),
      );
      const kept = await refusal(
        as(RUNTIME, null, (tx) => tx`update ${tx(table)} set version = version where ${whereOf(tx, key)}`),
      );
      expect([kept.code, kept.constraint], table).toEqual(["23514", `${table}_version_raised`]);
      const raised = await as(
        RUNTIME,
        null,
        (tx) =>
          tx<
            { version: number }[]
          >`update ${tx(table)} set version = version + 1 where ${whereOf(tx, key)} returning version`,
      );
      const version = row.values.version;
      expect(raised, table).toEqual([{ version: typeof version === "number" ? version + 1 : -1 }]);
    }
  });
});
