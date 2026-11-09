// T-210: the documents and licenses part (K-35 v1: documents, document_files, document_texts, document_signers and
// document_signatures, with README rules 1 to 11) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/documents-licenses`). The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business: a turn's call, the secure page's and the owner console's page
// calls) or the runtime side (rosie_job: K-05's commit, the clock, the 45-day copy or delete) runs in its own
// transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back. Seed fixtures are
// loaded the same way, as the runtime side with no scope (K-04's fixture format), and committed.
//
// The rows come only from fixtures (rule 9): K-35 v1's seeds and refused rows and the K-04, K-22, K-23, K-24, K-25 and
// K-29 seeds their after chains name (Lee's Barbershop, the yoga studio, Lee Nutrition Clinic, the pet boarding shop and
// the master's sample cast: Sam Lee, Riley, Alex M. and Ben T.). A row made here is a fixture row under a new id, or
// with one fault. Sam's signature on his standard agreement, which refuse-signed-by-all-before-signer names but does not
// give, is made here from that fixture's own signer and text rows. The sealed values are the fixtures' short stand-in
// bytes, never ciphertext or a real number.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/documents-licenses/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
/** The five tables, in code-unit order (as PostgreSQL orders a relation's name): all scoped by business. */
const OWN_TABLES = [
  "document_files",
  "document_signatures",
  "document_signers",
  "document_texts",
  "documents",
];
/** The four written once (README rules 2 and 5): no version, no trigger, no UPDATE by either role. */
const WRITTEN_ONCE = ["document_files", "document_signatures", "document_signers", "document_texts"];
/** The seeds 02-contracts' K-35 row names, which the card's proof loads: the index's only two. */
const CARD_SEEDS = ["seed-agreement-signed.json", "seed-license-as-given.json"];
/** The other parts' tables the five refer to by their keys (README rule 1): K-04's, K-22's, K-23's and K-25's. */
const REFERRED = ["bookings", "businesses", "persons", "places_or_things", "services", "staff"];
/** What either application role may change of a document (README rule 5): its UPDATE column grants, in column order. */
const DOCUMENT_UPDATE = [
  "shown_on_listing",
  "signed_by_all_at",
  "withdrawn_at",
  "withdrawn_why",
  "withdrawn_by_person_id",
  "version",
];
/** The sealed columns (README rule 6), each bytea under its row's person_id; nothing else of the five is bytea. */
const SEALED = [
  "document_files.object_key",
  "document_signatures.typed_name",
  "documents.ends",
  "documents.issuer",
  "documents.number",
];
const BARBERSHOP = "biz-lees-barbershop";
const YOGA_STUDIO = "biz-yoga-studio";
const NUTRITION_CLINIC = "biz-lee-nutrition-clinic";
const PET_BOARDING = "biz-pet-boarding";
const SAM = "person-sam";
const RILEY = "person-riley";
const ALEX = "person-alex";
const BEN = "person-ben";
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

const TABLES = (
  readJson(new URL("documents-licenses.v1.tables.json", PART_DIR)) as { tables: ContractTable[] }
).tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

/** Every accepted seed of another database part, named as K-35's seeds name it: from K-35's fixtures/ folder. */
const seedsOf = (part: string): string[] =>
  (readJson(new URL(`../${part}/fixtures/index.json`, PART_DIR)) as { fixtures: IndexEntry[] }).fixtures
    .filter((entry) => entry.expect === "accept")
    .map((entry) => `../../${part}/fixtures/${entry.file}`);

/** Every seed of the parts K-35 sits beside (README rule 1) and of K-29, whose consent its seed loads. */
const OTHER_SEEDS = [
  ...seedsOf("core"),
  ...seedsOf("people-access"),
  ...seedsOf("business-setup"),
  ...seedsOf("kinds-of-work"),
  ...seedsOf("services-prices"),
  ...seedsOf("conversations-consent"),
];
/** refuse-signed-by-all-before-signer: its own rows are Sam's unsigned standard agreement, its words and his signer row. */
const WEDDING_FILE = "invalid/refuse-signed-by-all-before-signer.json";

function tableOf(name: string): ContractTable {
  const table = TABLES.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`K-35 v1 lists no table ${name}`);
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
 * file that names it, so K-35's seeds name K-22's as ../../people-access/fixtures/<file>), each file once.
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

const sha256Hex = (words: string): string => createHash("sha256").update(words, "utf8").digest("hex");

/** A fixture value that must be text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error(`expected text, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** Every K-35 row of the two seeds and their chains, in load order. */
const SEED_ROWS = ((): FixtureRow[] => {
  const seen = new Set<string>();
  return SEEDS.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen)).filter((row) =>
    OWN_TABLES.includes(row.table),
  );
})();

/** Sam's license number for Lee's Barbershop, texted in his chat at S1-23 and shown (seed-license-as-given). */
const SHOP_LICENSE = valuesWithId("seed-license-as-given.json", "documents", "doc-barbershop-license");
/** Riley's own barber license, added on his secure page after joining (S2-06), and its photo. */
const RILEY_LICENSE = valuesWithId("seed-license-as-given.json", "documents", "doc-riley-barber-license");
const RILEY_PHOTO = valuesWithId(
  "seed-license-as-given.json",
  "document_files",
  "docfile-riley-barber-license-photo",
);
/** S1-72's health privacy agreement for Lee Nutrition Clinic, its words, Sam as its signer and his signature. */
const HEALTH_AGREEMENT = valuesWithId(
  "seed-agreement-signed.json",
  "documents",
  "doc-health-privacy-nutrition",
);
const HEALTH_TEXT = valuesWithId(
  "seed-agreement-signed.json",
  "document_texts",
  "doctext-health-privacy-nutrition-en",
);
const HEALTH_SIGNER = valuesWithId(
  "seed-agreement-signed.json",
  "document_signers",
  "docsigner-health-privacy-sam",
);
const HEALTH_SIGNATURE = valuesWithId(
  "seed-agreement-signed.json",
  "document_signatures",
  "docsig-health-privacy-sam",
);
/** Sam's own standard agreement for the wedding party grooming, sent to him to sign once at Go live (S1-29). */
const WEDDING_AGREEMENT = valuesWithId(WEDDING_FILE, "documents", "doc-lees-wedding-party-agreement");
const WEDDING_TEXT = valuesWithId(WEDDING_FILE, "document_texts", "doctext-lees-wedding-party-agreement-en");
const WEDDING_SIGNER = valuesWithId(WEDDING_FILE, "document_signers", "docsigner-lees-wedding-party-sam");
/** Sam's tap on that agreement, made here from the fixture's signer and text: after he is asked, before it is marked. */
const WEDDING_SIGNATURE: Values = {
  id: "docsig-lees-wedding-party-sam",
  document_id: textOf(WEDDING_AGREEMENT.id),
  business_id: BARBERSHOP,
  signer_id: textOf(WEDDING_SIGNER.id),
  person_id: SAM,
  document_text_id: textOf(WEDDING_TEXT.id),
  words_sha256: textOf(WEDDING_TEXT.words_sha256),
  signed_at: "2026-10-19T18:21:00Z",
  how: "tap",
  typed_name: null,
  channel: "secure_page",
};
/** The barbershop's insurance as given in the chat: refuse-checked-column without its one fault (checked). */
const INSURANCE: Values = Object.fromEntries(
  Object.entries(refusedOf("invalid/refuse-checked-column.json").values ?? {}).filter(
    ([column]) => column !== "checked",
  ),
);
/** The court order Alex keeps on file for his son, given on his secure page: refuse-customer-document-listed unshown. */
const ALEX_COURT_ORDER: Values = {
  ...(refusedOf("invalid/refuse-customer-document-listed.json").values ?? {}),
  shown_on_listing: false,
};
/** Alex's legal papers on file at the barbershop (A4-24), made here from his court order's row. */
const ALEX_LEGAL_PAPERS: Values = {
  ...ALEX_COURT_ORDER,
  id: "doc-probe-alex-legal-papers",
  kind: "legal_papers",
  title: "Legal papers",
};
/** A court order on file for Alex M.'s haircut, his booking's (A4-25), made here from his court order's row. */
const HAIRCUT_COURT_ORDER: Values = {
  ...ALEX_COURT_ORDER,
  id: "doc-probe-haircut-court-order",
  owner_kind: "booking",
  customer_person_id: null,
  booking_id: "booking-alex-haircut",
};
/** A form built for Alex M.'s haircut (A4-43), made here from the standard agreement's shape: built, Alex served. */
const HAIRCUT_FORM: Values = {
  ...WEDDING_AGREEMENT,
  id: "doc-probe-haircut-form",
  owner_kind: "booking",
  booking_id: "booking-alex-haircut",
  person_id: ALEX,
  kind: "form",
  title: "Form",
  added_at: "2026-10-21T16:40:00Z",
  service_id: null,
};
/** An estimate built for the same haircut, which Alex and Ben T. (a co-signer he names) each sign on their own link. */
const HAIRCUT_ESTIMATE: Values = {
  ...HAIRCUT_FORM,
  id: "doc-probe-haircut-estimate",
  kind: "estimate",
  title: "Estimate",
};
const ESTIMATE_TEXT: Values = {
  ...WEDDING_TEXT,
  id: "doctext-probe-haircut-estimate-en",
  document_id: textOf(HAIRCUT_ESTIMATE.id),
  made_at: "2026-10-21T16:40:00Z",
};
const ALEX_SIGNER: Values = {
  ...WEDDING_SIGNER,
  id: "docsigner-probe-estimate-alex",
  document_id: textOf(HAIRCUT_ESTIMATE.id),
  person_id: ALEX,
  signs_as: "Customer",
  asked_at: "2026-10-21T16:40:00Z",
};
const BEN_SIGNER: Values = {
  ...ALEX_SIGNER,
  id: "docsigner-probe-estimate-ben",
  person_id: BEN,
  signs_as: "Co-signer",
};
/** A signer's tap on the estimate at `at`, made here. */
const estimateSignature = (signer: Values, at: string): Values => ({
  ...WEDDING_SIGNATURE,
  id: `docsig-probe-${textOf(signer.id)}`,
  document_id: textOf(HAIRCUT_ESTIMATE.id),
  signer_id: textOf(signer.id),
  person_id: textOf(signer.person_id),
  document_text_id: textOf(ESTIMATE_TEXT.id),
  words_sha256: textOf(ESTIMATE_TEXT.words_sha256),
  signed_at: at,
});
/** A standard agreement for the event hours, made here from the wedding party's (S1-29; FS row Q02). */
const EVENT_AGREEMENT: Values = {
  ...WEDDING_AGREEMENT,
  id: "doc-probe-event-hours-agreement",
  service_id: "svc-lees-event-hours",
};
/** A paper of the pet boarding shop's suite, given by Sam in the portal (S1-81), made here from his license's row. */
const SUITE_PAPER: Values = {
  ...SHOP_LICENSE,
  id: "doc-probe-suite-paper",
  business_id: PET_BOARDING,
  owner_kind: "place_or_thing",
  place_or_thing_id: "place-pet-boarding-suite",
  kind: "other",
  kind_id: null,
  title: "Document",
  given_via: "portal",
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

/** Updates the document whose id is `id`, setting `set` (or nothing more) and raising its version by one; gives it back. */
function updateDocument(id: Json | undefined, set: Values): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) =>
    Object.keys(set).length === 0
      ? tx<Record<string, unknown>[]>`
          update documents set version = version + 1 where ${whereOf(tx, { id: textOf(id) })} returning *
        `
      : tx<Record<string, unknown>[]>`
          update documents set ${tx(columnValues(tx, "documents", set))}, version = version + 1
          where ${whereOf(tx, { id: textOf(id) })}
          returning *
        `;
}

/** Updates the row of a table written once whose id is `id`, setting `set`; gives it back. */
function updateWrittenOnce(
  table: string,
  id: Json | undefined,
  set: Values,
): (tx: Tx) => Promise<Record<string, unknown>[]> {
  return (tx) => tx<Record<string, unknown>[]>`
    update ${tx(table)} set ${tx(columnValues(tx, table, set))} where ${whereOf(tx, { id: textOf(id) })} returning *
  `;
}

/** A row's primary key, from its values. */
const keyOf = (row: FixtureRow): Values =>
  Object.fromEntries(tableOf(row.table).primaryKey.map((column) => [column, row.values[column] ?? null]));

/** Empties every table the fixtures write: truncating the heads cascades to the rest (this file's schema only). */
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
  db = await createTestDatabase({ name: "documents_licenses" });
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

describe("the migration against the frozen table list (K-35 v1 documents and licenses)", () => {
  /** The table list's types as format_type prints them; the others print as the list writes them. */
  const typeNames: Record<string, string> = {
    timestamptz: "timestamp with time zone",
  };

  it("the table list names five tables, each scoped by business on business_id with no effective dates; only documents is versioned, on version", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(
        [table.rowLevelSecurity.scope, table.rowLevelSecurity.column, table.versioned, table.effectiveDates],
        table.name,
      ).toEqual(["business", "business_id", table.name === "documents", false]);
    }
    expect(tableOf("documents").versionColumn).toBe("version");
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

  it("documents raises its version on every update (0002's rule; README rule 2) and runs rule 11's documents_signed_by_all_once, both BEFORE UPDATE FOR EACH ROW; the four written once have no trigger", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual([
      ["documents", "documents_signed_by_all_once"],
      ["documents", "documents_version_raised"],
    ]);
    const functionOf: Record<string, string> = {
      documents_signed_by_all_once: "documents_signed_by_all_once()",
      documents_version_raised: "enforce_version_raise()",
    };
    for (const trigger of triggers) {
      expect(trigger.definition, trigger.name).toContain("BEFORE UPDATE ON");
      expect(trigger.definition, trigger.name).toContain(
        `FOR EACH ROW EXECUTE FUNCTION ${functionOf[trigger.name] ?? "?"}`,
      );
    }
  });

  it("rule 11's function documents_signed_by_all_once(): a plpgsql trigger function with no arguments, security invoker (it reads signers and signatures as the calling role, so row-level security binds it), owned by the tables' owner, its search_path pinned to this schema then pg_temp; the part makes no other function", async () => {
    const functions = await db.sql<
      {
        name: string;
        definer: boolean;
        owner: string;
        table: string;
        config: string[] | null;
        language: string;
        args: string;
        result: string;
      }[]
    >`
      select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
             (select pg_get_userbyid(relowner) from pg_class where oid = ${`${db.schema}.documents`}::regclass) as table,
             p.proconfig as config, l.lanname as language, pg_get_function_identity_arguments(p.oid) as args,
             pg_get_function_result(p.oid) as result
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = ${db.schema}::regnamespace and p.proname like 'document%'
      order by p.proname
    `;
    expect(
      functions.map(({ owner, table, ...rest }) => ({ ...rest, ownedByTables: owner === table })),
    ).toEqual([
      {
        name: "documents_signed_by_all_once",
        definer: false,
        config: [`search_path=${db.schema}, pg_temp`],
        language: "plpgsql",
        args: "",
        result: "trigger",
        ownedByTables: true,
      },
    ]);
    expect(ROLES).not.toContain(functions[0]?.owner);
  });

  it("no column says Rosie checked, verified or approved a document, or holds a lookup, a status or a parsed end date (FS line 736: 'No checked column'; D96; MC C4, C7): the only bytea columns are the five sealed ones, each sealed by its row's person_id, and ends is one of them", () => {
    const own = [...typeOf.entries()].filter(([key]) => OWN_TABLES.includes(key.split(".")[0] ?? ""));
    expect(own).toHaveLength(TABLES.reduce((sum, table) => sum + table.columns.length, 0));
    expect(
      own.filter(([key]) =>
        /check|verif|approv|status|lookup|lapse|valid|expir/.test(key.split(".")[1] ?? ""),
      ),
    ).toEqual([]);
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
  });

  it("ids are text and every time is an instant (timestamptz): no date, time or timestamp without a zone (README rules 3 and 7)", () => {
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

  it("the five refer only to K-04's businesses, persons and bookings, K-22's staff, K-23's places_or_things, K-25's services and each other (rule 1): none to K-29, K-13 or K-30, and kind_id has no key", async () => {
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
    expect(keys.filter((key) => key.columns.includes("kind_id"))).toEqual([]);
    // No table of another part refers to these (README rule 1).
    const into = await db.sql<{ table: string }[]>`
      select src.relname as table from pg_constraint k
        join pg_class src on src.oid = k.conrelid
        join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f' and dst.relnamespace = ${db.schema}::regnamespace and dst.relname in ${db.sql(OWN_TABLES)}
        and src.relname not in ${db.sql(OWN_TABLES)}
    `;
    expect(into).toEqual([]);
  });

  it("is recorded in schema_migrations as documents_licenses, after core_rls, consent, business_setup, people_access, services_prices and platform_billing", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("documents_licenses");
    for (const before of [
      "core_rls",
      "consent",
      "business_setup",
      "people_access",
      "services_prices",
      "platform_billing",
    ]) {
      expect(names.indexOf("documents_licenses"), before).toBeGreaterThan(names.indexOf(before));
    }
  });
});

describe("row-level security, policies and grants in the catalog (T-191's pattern; README rules 4 and 5)", () => {
  it("row-level security is on for all five, and forced on none", async () => {
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

  it("table grants (DL-149, each to its named reader: the migration's header; README rule 5): both roles select and insert all five, the same for each; no table-wide update, and no delete, truncate, references or trigger; nothing to PUBLIC or any other grantee", async () => {
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
          ["INSERT", "SELECT"].map((privilege) => `${role} ${table} ${privilege}`),
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

  it("column grants (README rule 5): both roles update documents' shown_on_listing, signed_by_all_at, withdrawn_at, withdrawn_why, withdrawn_by_person_id and version, and nothing else of the five; no other column grant to any grantee", async () => {
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
    expect(granted.map((row) => `${row.table} ${row.column} ${row.grantee} ${row.privilege}`).sort()).toEqual(
      ROLES.flatMap((role) => DOCUMENT_UPDATE.map((column) => `documents ${column} ${role} UPDATE`)).sort(),
    );
    // has_column_privilege agrees, column by column: what a person gave and what a document is, and every column of
    // the four written once, stay as written.
    const updatable = await db.sql<{ role: string; table: string; column: string }[]>`
      select r.role, c.relname as table, a.attname as column
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_attribute a
        join pg_class c on c.oid = a.attrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and a.attnum > 0 and not a.attisdropped
        and has_column_privilege(r.role, a.attrelid, a.attnum, 'UPDATE')
      order by r.role, c.relname, a.attnum
    `;
    expect(updatable.map((row) => `${row.role} ${row.table}.${row.column}`)).toEqual(
      ROLES.flatMap((role) => DOCUMENT_UPDATE.map((column) => `${role} documents.${column}`)),
    );
  });
});

describe("the seed fixtures load (fixtures/index.json): the two of 02-contracts' K-35 row", () => {
  /** The K-35 rows the two seeds give together, per table: every table gets rows (README "Checked on"). */
  const SEEDED = {
    document_files: 1,
    document_signatures: 1,
    document_signers: 1,
    document_texts: 1,
    documents: 3,
  };

  it("the index lists the two seeds (the card's) and eight refused rows, all K-35 v1 on its own tables", () => {
    expect([...SEEDS].sort()).toEqual(CARD_SEEDS);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([
      "invalid/refuse-as-given-edit.json",
      "invalid/refuse-checked-column.json",
      "invalid/refuse-cross-business-read.json",
      "invalid/refuse-customer-document-listed.json",
      "invalid/refuse-file-from-chat.json",
      "invalid/refuse-signature-edit.json",
      "invalid/refuse-signed-by-all-before-signer.json",
      "invalid/refuse-signed-by-all-moved.json",
    ]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of CARD_SEEDS) {
    it(
      `${file} inserts alone with its after chain, as the runtime side, and every K-35 row is stored as given`,
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

  it("both insert together, each after chain once, and every table gets rows", SLOW, async () => {
    await reset();
    const loaded = await loadFixtures(SEEDS);
    expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
    expect(await visibleRows(db.sql)).toEqual(SEEDED);
    for (const row of SEED_ROWS) {
      await expectStored(row);
    }
  });

  it(
    "they insert together with every K-04 v1, K-22 v1.1, K-23 v1, K-24 v1, K-25 v1 and K-29 v1 seed as well, each file once: no K-35 row shares a key with another part's",
    SLOW,
    async () => {
      await reset();
      expect(OTHER_SEEDS.length).toBeGreaterThan(SEEDS.length);
      const loaded = await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
      expect(Object.fromEntries(OWN_TABLES.map((table) => [table, loaded[table] ?? 0]))).toEqual(SEEDED);
      expect(await visibleRows(db.sql)).toEqual(SEEDED);
    },
  );
});

describe("the seeded rows: what the two seeds hold, read back", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 120_000);

  it("refuse-checked-column holds on the seeded schema: no checked column exists, so the row that says checked is refused (42703) and the same insurance row without it, as given, is stored", async () => {
    const outcome = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "documents", { ...INSURANCE, checked: true })),
    );
    expect([outcome.code, outcome.message]).toEqual([
      "42703",
      'column "checked" of relation "documents" does not exist',
    ]);
    expect(await as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "documents", INSURANCE))).toMatchObject(
      [{ id: INSURANCE.id, kind: "insurance", origin: "given", shown_on_listing: true }],
    );
  });

  it("Sam's barbershop license and Riley's barber license, as given and never checked: who gave each, where and when (Sam in his chat at 10:20am Mon Oct 19; Riley on his secure page at 11:08am), both shown, each sealed under its giver's key; no issuer, end, signed time or withdrawal", async () => {
    const papers = await db.sql<Record<string, unknown>[]>`
      select d.id, d.owner_kind as owner, d.kind, d.kind_id as "kindId", d.title, d.shown_on_listing as shown,
             d.origin, g.name as "givenBy", d.given_via as via, d.person_id = d.given_by_person_id as "sealedForGiver",
             k.person_id is not null as "keyHeld",
             to_char(d.added_at at time zone b.time_zone, 'FMHH12:MIam Dy Mon FMDD') as added,
             d.number is not null as "hasNumber", d.issuer, d.ends, d.signed_by_all_at as signed,
             d.withdrawn_at as withdrawn
      from documents d
        join persons g on g.id = d.given_by_person_id
        join businesses b on b.id = d.business_id
        left join sealing_keys k on k.person_id = d.person_id
      where d.business_id = ${BARBERSHOP}
      order by d.id
    `;
    const shared = {
      kind: "license",
      kindId: "barber",
      title: "Barber license",
      shown: true,
      origin: "given",
      sealedForGiver: true,
      keyHeld: true,
      hasNumber: true,
      issuer: null,
      ends: null,
      signed: null,
      withdrawn: null,
    };
    expect(papers).toEqual([
      {
        id: SHOP_LICENSE.id,
        owner: "business",
        givenBy: "Sam Lee",
        via: "chat",
        added: "10:20am Mon Oct 19",
        ...shared,
      },
      {
        id: RILEY_LICENSE.id,
        owner: "staff",
        givenBy: "Riley",
        via: "secure_page",
        added: "11:08am Mon Oct 19",
        ...shared,
      },
    ]);
    // The number is only sealed bytes: the plain number the master's sample texts (BS20981) is nowhere in the row.
    const plain = await db.sql<{ id: string }[]>`
      select id from documents
      where encode(number, 'escape') like '%BS20981%' or title like '%BS20981%' or kind like '%BS20981%'
    `;
    expect(plain).toEqual([]);
    // Riley's paper is his staff row's at the barbershop (documents_staff_fk), and its photo was taken on his page.
    const [staff] = await db.sql<{ staff: string; status: string }[]>`
      select s.id as staff, s.status from documents d
        join staff s on s.business_id = d.business_id and s.person_id = d.staff_person_id
      where d.id = ${textOf(RILEY_LICENSE.id)}
    `;
    expect(staff).toEqual({ staff: "staff-riley-barbershop", status: "joined" });
    const files = await db.sql<Record<string, unknown>[]>`
      select f.document_id as document, f.person_id as person, f.content_type as type, f.uploaded_via as via,
             u.name as "uploadedBy", f.object_key is not null as "keyHeld",
             to_char(f.uploaded_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as uploaded
      from document_files f join persons u on u.id = f.uploaded_by_person_id
    `;
    expect(files).toEqual([
      {
        document: RILEY_LICENSE.id,
        person: RILEY,
        type: "image/jpeg",
        via: "secure_page",
        uploadedBy: "Riley",
        keyHeld: true,
        uploaded: "11:08am Mon Oct 19",
      },
    ]);
  });

  it("S1-72's agreement for Lee Nutrition Clinic: built with no given values, its English words with their sha256 and version, Sam asked to sign as the owner at 11:05am Tue Oct 20 and his typed name, sealed, at 11:10am; signed by all then, so Go live finds nothing left to sign; the words and hash are K-29's consent row's, the one yes", async () => {
    const [agreement] = await db.sql<Record<string, unknown>[]>`
      select d.owner_kind as owner, d.origin, d.kind, d.kind_id as "kindId", d.title, d.shown_on_listing as shown,
             d.number, d.issuer, d.ends, d.given_by_person_id as "givenBy", d.given_via as via, d.version,
             to_char(d.signed_by_all_at at time zone b.time_zone, 'FMHH12:MIam Dy Mon FMDD') as signed
      from documents d join businesses b on b.id = d.business_id
      where d.id = ${textOf(HEALTH_AGREEMENT.id)}
    `;
    expect(agreement).toEqual({
      owner: "business",
      origin: "built",
      kind: "agreement",
      kindId: "dietitian",
      title: "Health privacy agreement",
      shown: false,
      number: null,
      issuer: null,
      ends: null,
      givenBy: null,
      via: null,
      version: 2,
      signed: "11:10am Tue Oct 20",
    });
    const [signed] = await db.sql<Record<string, unknown>[]>`
      select t.language, t.text_version as "textVersion",
             t.words_sha256 = encode(sha256(convert_to(t.words, 'UTF8')), 'hex') as "hashOfWords",
             r.signs_as as "signsAs", p.name as signer,
             to_char(r.asked_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as asked,
             s.how, s.typed_name is not null as "nameSealed", s.channel,
             to_char(s.signed_at at time zone 'America/New_York', 'FMHH12:MIam Dy Mon FMDD') as at,
             s.words_sha256 = t.words_sha256 as "signedTheWords"
      from document_signatures s
        join document_signers r on r.id = s.signer_id
        join document_texts t on t.id = s.document_text_id
        join persons p on p.id = s.person_id
      where s.document_id = ${textOf(HEALTH_AGREEMENT.id)}
    `;
    expect(signed).toEqual({
      language: "en",
      textVersion: "Health privacy agreement v1",
      hashOfWords: true,
      signsAs: "Owner",
      signer: "Sam Lee",
      asked: "11:05am Tue Oct 20",
      how: "typed_name",
      nameSealed: true,
      channel: "secure_page",
      at: "11:10am Tue Oct 20",
      signedTheWords: true,
    });
    // K-29's health_agreement consent and this signature are the one yes: same person, business, words, hash and time.
    const [yes] = await db.sql<Record<string, unknown>[]>`
      select c.person_id = s.person_id as "samePerson", c.business_id = s.business_id as "sameBusiness",
             c.exact_words = t.words as "sameWords", c.words_sha256 = s.words_sha256 as "sameHash",
             c.at = s.signed_at as "sameTime"
      from consents c
        join document_signatures s on s.business_id = c.business_id
        join document_texts t on t.id = s.document_text_id
      where c.kind = 'health_agreement' and c.business_id = ${NUTRITION_CLINIC}
    `;
    expect(yes).toEqual({
      samePerson: true,
      sameBusiness: true,
      sameWords: true,
      sameHash: true,
      sameTime: true,
    });
    // Go live's "Left unsigned" read (S1-29): agreements a kind of work needs that stand unsigned. None.
    const unsigned = await db.sql<{ id: string }[]>`
      select id from documents
      where business_id = ${NUTRITION_CLINIC} and kind = 'agreement' and kind_id is not null
        and signed_by_all_at is null and withdrawn_at is null
    `;
    expect(unsigned).toEqual([]);
  });
});

describe("row-level security per business on the five tables, every K-04, K-22, K-23, K-24, K-25, K-29 and K-35 seed loaded", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS]);
  }, 120_000);

  it(
    "with no scope the Tool API reads no row of the five; each business's scope shows exactly its own rows; the yoga studio's sees none of the barbershop's papers or the clinic's agreement",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(OWN_TABLES.map((table) => [table, 0]));
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      const businesses = await businessIds();
      expect(businesses).toEqual(expect.arrayContaining([BARBERSHOP, NUTRITION_CLINIC, YOGA_STUDIO]));
      for (const business of [...businesses, "biz-nobody"]) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      expect(await ownerRows(BARBERSHOP)).toEqual({ ...zeros, document_files: 1, documents: 2 });
      expect(await ownerRows(NUTRITION_CLINIC)).toEqual({
        ...zeros,
        document_signatures: 1,
        document_signers: 1,
        document_texts: 1,
        documents: 1,
      });
      expect(await as(TOOL_API, YOGA_STUDIO, (tx) => tx`select id from documents`)).toEqual([]);
    },
  );

  it(
    "the runtime side with no scope reads every row (the 45-day copy or delete works by person across businesses); with a scope set (per write), only that business's",
    SLOW,
    async () => {
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
      for (const business of await businessIds()) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      // Sam's documents across his businesses, read by person (documents_person_idx's read).
      const sams = await as(
        RUNTIME,
        null,
        (tx) => tx<{ id: string }[]>`
        select id from documents where person_id = ${SAM} order by id
      `,
      );
      expect(sams.map((row) => row.id)).toEqual([textOf(SHOP_LICENSE.id), textOf(HEALTH_AGREEMENT.id)]);
    },
  );

  it("the Tool API writes only its scope's rows: the yoga studio's insurance is refused under the barbershop's scope (42501) and stored under its own; an update of another business's document finds no row", async () => {
    const yogaInsurance = { ...INSURANCE, id: "doc-probe-yoga-insurance", business_id: YOGA_STUDIO };
    const outcome = await refusal(
      as(TOOL_API, BARBERSHOP, (tx) => insertReturning(tx, "documents", yogaInsurance)),
    );
    expect([outcome.code, outcome.message]).toEqual([
      "42501",
      'new row violates row-level security policy for table "documents"',
    ]);
    expect(
      await as(TOOL_API, YOGA_STUDIO, (tx) => insertReturning(tx, "documents", yogaInsurance)),
    ).toHaveLength(1);
    const hide = updateDocument(SHOP_LICENSE.id, { shown_on_listing: false });
    expect(await as(TOOL_API, YOGA_STUDIO, hide)).toHaveLength(0);
    expect(await as(TOOL_API, BARBERSHOP, hide)).toHaveLength(1);
    // A file, a text, a signer or a signature of another business is refused the same way.
    const file = { ...RILEY_PHOTO, id: "docfile-probe-from-yoga" };
    expect((await refusal(as(TOOL_API, YOGA_STUDIO, insertEach(["document_files", file])))).code).toBe(
      "42501",
    );
  });

  it("the runtime side scoped to one business (per write) cannot write another's document; scoped to its own, or with no scope, it writes it", async () => {
    const outcome = await refusal(as(RUNTIME, YOGA_STUDIO, insertEach(["documents", INSURANCE])));
    expect(outcome.code).toBe("42501");
    expect(await as(RUNTIME, BARBERSHOP, insertEach(["documents", INSURANCE]))).toHaveLength(1);
    expect(await as(RUNTIME, null, insertEach(["documents", INSURANCE]))).toHaveLength(1);
  });

  it("every update of a document raises its version by exactly one, under either role: one that leaves it is refused (documents_version_raised, 23514) and one that raises it passes", async () => {
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const kept = await refusal(
        as(
          role,
          scope,
          (tx) => tx`update documents set version = version where id = ${textOf(SHOP_LICENSE.id)}`,
        ),
      );
      expect([kept.code, kept.constraint], role).toEqual(["23514", "documents_version_raised"]);
      const raised = await as(
        role,
        scope,
        (tx) => tx<{ version: number }[]>`
          update documents set version = version + 1 where id = ${textOf(SHOP_LICENSE.id)} returning version
        `,
      );
      expect(raised, role).toEqual([{ version: 2 }]);
    }
  });
});

describe("who may do what, by privilege (README rule 5): the same for both roles, every seed loaded and Sam's unsigned standard agreement", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS, WEDDING_FILE]);
  }, 120_000);

  it("under its scope the Tool API takes Sam's license off the listing, then withdraws it as replaced by a new one (a correction is a new document), each raising the version; the runtime side's clock lets the unsigned agreement go as not signed in time, with no person", async () => {
    const corrected = await as(TOOL_API, BARBERSHOP, async (tx) => {
      const [hidden] = await updateDocument(SHOP_LICENSE.id, { shown_on_listing: false })(tx);
      await insertReturning(tx, "documents", {
        ...SHOP_LICENSE,
        id: "doc-barbershop-license-2",
        added_at: "2026-10-22T14:00:00Z",
      });
      const [replaced] = await updateDocument(SHOP_LICENSE.id, {
        withdrawn_at: "2026-10-22T14:00:00Z",
        withdrawn_why: "replaced",
        withdrawn_by_person_id: SAM,
      })(tx);
      const listed = await tx<{ id: string }[]>`
        select id from documents where shown_on_listing and withdrawn_at is null order by id
      `;
      return { hidden: hidden?.version, replaced: replaced?.version, listed: listed.map((row) => row.id) };
    });
    expect(corrected).toEqual({
      hidden: 2,
      replaced: 3,
      listed: ["doc-barbershop-license-2", textOf(RILEY_LICENSE.id)],
    });
    const letGo = await as(
      RUNTIME,
      null,
      updateDocument(WEDDING_AGREEMENT.id, {
        withdrawn_at: "2026-10-20T18:20:00Z",
        withdrawn_why: "not_signed_in_time",
        withdrawn_by_person_id: null,
      }),
    );
    expect(letGo).toMatchObject([
      { withdrawn_why: "not_signed_in_time", withdrawn_by_person_id: null, version: 2 },
    ]);
  });

  it("neither role changes what a person gave or what a document is (refuse-as-given-edit): an update of any other column of documents is refused by privilege (42501), whatever its value", async () => {
    const changes: Values = {
      number: "\\x6b33352d7365616c65642d6e756d6265722d6f74686572",
      issuer: "\\x6b33352d7365616c65642d6e756d6265722d6f74686572",
      ends: "\\x6b33352d7365616c65642d6e756d6265722d6f74686572",
      title: "Barbershop license",
      kind: "registration",
      kind_id: null,
      service_id: null,
      owner_kind: "place_or_thing",
      staff_person_id: RILEY,
      place_or_thing_id: null,
      booking_id: null,
      customer_person_id: null,
      person_id: RILEY,
      origin: "built",
      given_by_person_id: RILEY,
      given_via: "portal",
      added_at: "2026-10-19T14:25:00Z",
      business_id: YOGA_STUDIO,
      id: "doc-moved",
    };
    const asGiven = tableOf("documents")
      .columns.map((column) => column.name)
      .filter((column) => !DOCUMENT_UPDATE.includes(column));
    expect(Object.keys(changes).sort()).toEqual([...asGiven].sort());
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      for (const [column, value] of Object.entries(changes)) {
        const outcome = await refusal(as(role, scope, updateDocument(SHOP_LICENSE.id, { [column]: value })));
        expect([outcome.code, outcome.message], `${role} ${column}`).toEqual([
          "42501",
          "permission denied for table documents",
        ]);
      }
    }
  });

  it("a file, a text, a signer and a signature are never edited, even on the runtime side (refuse-signature-edit): an update by either role is refused by privilege (42501)", async () => {
    const edits: [string, Json | undefined, string, Values][] = [
      ["document_files", RILEY_PHOTO.id, BARBERSHOP, { uploaded_via: "portal" }],
      ["document_texts", HEALTH_TEXT.id, NUTRITION_CLINIC, { text_version: "Health privacy agreement v2" }],
      ["document_signers", HEALTH_SIGNER.id, NUTRITION_CLINIC, { signs_as: "Owner and manager" }],
      ["document_signatures", HEALTH_SIGNATURE.id, NUTRITION_CLINIC, { signed_at: "2026-10-20T15:00:00Z" }],
    ];
    expect(edits.map(([table]) => table).sort()).toEqual(WRITTEN_ONCE);
    for (const [table, id, business, set] of edits) {
      for (const [role, scope] of [
        [TOOL_API, business],
        [RUNTIME, null],
      ] as const) {
        const outcome = await refusal(as(role, scope, updateWrittenOnce(table, id, set)));
        expect([outcome.code, outcome.message], `${role} ${table}`).toEqual([
          "42501",
          `permission denied for table ${table}`,
        ]);
      }
    }
  });

  it("no role deletes a row of the five (42501): records are kept, and a document ends by its withdrawal", async () => {
    const rows: [string, Json | undefined, string][] = [
      ["documents", SHOP_LICENSE.id, BARBERSHOP],
      ["document_files", RILEY_PHOTO.id, BARBERSHOP],
      ["document_texts", HEALTH_TEXT.id, NUTRITION_CLINIC],
      ["document_signers", HEALTH_SIGNER.id, NUTRITION_CLINIC],
      ["document_signatures", HEALTH_SIGNATURE.id, NUTRITION_CLINIC],
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

  it("both roles insert into all five: under the barbershop's scope, or on the runtime side, an estimate for Alex M.'s haircut with its words, two signers and Alex's signature, and Riley's certificate with a PDF of it uploaded in the portal", async () => {
    const certificate = {
      ...RILEY_LICENSE,
      id: "doc-probe-riley-certificate",
      kind: "certificate",
      kind_id: null,
      title: "Certificate",
    };
    const writes = insertEach(
      ["documents", HAIRCUT_ESTIMATE],
      ["document_texts", ESTIMATE_TEXT],
      ["document_signers", ALEX_SIGNER],
      ["document_signers", BEN_SIGNER],
      ["document_signatures", estimateSignature(ALEX_SIGNER, "2026-10-21T16:45:00Z")],
      ["documents", certificate],
      [
        "document_files",
        {
          ...RILEY_PHOTO,
          id: "docfile-probe-riley-certificate",
          document_id: certificate.id,
          content_type: "application/pdf",
          uploaded_by_person_id: SAM,
          uploaded_via: "portal",
        },
      ],
    );
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      expect(await as(role, scope, writes), role).toMatchObject([{ id: "docfile-probe-riley-certificate" }]);
    }
  });
});

describe("rule 11: signed_by_all_at is set once, and only when every signer has signed (documents_signed_by_all_once)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS, WEDDING_FILE]);
  }, 120_000);

  const markSigned = (id: Json | undefined, at: string) => updateDocument(id, { signed_by_all_at: at });

  it("setting it on a built document with no signer is refused (23514), under the Tool API's scope and on the runtime side", async () => {
    for (const [role, scope] of [
      [TOOL_API, BARBERSHOP],
      [RUNTIME, null],
    ] as const) {
      const outcome = await refusal(
        as(role, scope, async (tx) => {
          await insertReturning(tx, "documents", HAIRCUT_ESTIMATE);
          return markSigned(HAIRCUT_ESTIMATE.id, "2026-10-21T16:50:00Z")(tx);
        }),
      );
      expect([outcome.code, outcome.constraint], role).toEqual(["23514", "documents_signed_by_all_once"]);
    }
  });

  it("with its one signer unsigned, Sam's standard agreement cannot be marked signed by all; once his signature is written the same update passes, which turns on the service's contract step (A5-19)", async () => {
    const early = await refusal(
      as(TOOL_API, BARBERSHOP, markSigned(WEDDING_AGREEMENT.id, "2026-10-19T18:22:00Z")),
    );
    expect([early.code, early.constraint]).toEqual(["23514", "documents_signed_by_all_once"]);
    const marked = await as(TOOL_API, BARBERSHOP, async (tx) => {
      await insertReturning(tx, "document_signatures", WEDDING_SIGNATURE);
      const [row] = await markSigned(WEDDING_AGREEMENT.id, "2026-10-19T18:22:00Z")(tx);
      const steps = await tx<{ service: string }[]>`
        select service_id as service from documents
        where service_id is not null and signed_by_all_at is not null and withdrawn_at is null
      `;
      return { version: row?.version, steps: steps.map((step) => step.service) };
    });
    expect(marked).toEqual({ version: 2, steps: ["svc-lees-wedding-party"] });
  });

  it("with two signers, one signature is not enough; with both, it passes", async () => {
    const written = insertEach(
      ["documents", HAIRCUT_ESTIMATE],
      ["document_texts", ESTIMATE_TEXT],
      ["document_signers", ALEX_SIGNER],
      ["document_signers", BEN_SIGNER],
      ["document_signatures", estimateSignature(ALEX_SIGNER, "2026-10-21T16:45:00Z")],
    );
    const half = await refusal(
      as(TOOL_API, BARBERSHOP, async (tx) => {
        await written(tx);
        return markSigned(HAIRCUT_ESTIMATE.id, "2026-10-21T16:45:00Z")(tx);
      }),
    );
    expect([half.code, half.constraint]).toEqual(["23514", "documents_signed_by_all_once"]);
    const both = await as(TOOL_API, BARBERSHOP, async (tx) => {
      await written(tx);
      await insertReturning(tx, "document_signatures", estimateSignature(BEN_SIGNER, "2026-10-21T16:55:00Z"));
      return markSigned(HAIRCUT_ESTIMATE.id, "2026-10-21T16:55:00Z")(tx);
    });
    expect(both).toMatchObject([{ id: HAIRCUT_ESTIMATE.id, version: 2 }]);
  });

  it("once set it never moves or clears, under either role; the version alone, shown_on_listing and a withdrawal pass it, and so does an update that sets it to the time it holds", async () => {
    for (const [role, scope] of [
      [TOOL_API, NUTRITION_CLINIC],
      [RUNTIME, null],
    ] as const) {
      for (const at of ["2026-10-20T15:30:00Z", null]) {
        const outcome = await refusal(
          as(role, scope, updateDocument(HEALTH_AGREEMENT.id, { signed_by_all_at: at })),
        );
        expect([outcome.code, outcome.constraint], `${role} ${String(at)}`).toEqual([
          "23514",
          "documents_signed_by_all_once",
        ]);
      }
      const passes: Values[] = [
        {},
        { shown_on_listing: true },
        { withdrawn_at: "2026-10-21T15:00:00Z", withdrawn_why: "taken_off", withdrawn_by_person_id: SAM },
        { signed_by_all_at: textOf(HEALTH_AGREEMENT.signed_by_all_at) },
      ];
      for (const set of passes) {
        expect(
          await as(role, scope, updateDocument(HEALTH_AGREEMENT.id, set)),
          `${role} ${JSON.stringify(set)}`,
        ).toMatchObject([{ version: 3 }]);
      }
    }
  });

  it("each refusal names its rule and no value: neither the time asked nor the time held is in the message", async () => {
    const moved = await refusal(
      as(
        TOOL_API,
        NUTRITION_CLINIC,
        updateDocument(HEALTH_AGREEMENT.id, { signed_by_all_at: "2026-10-20T15:30:00Z" }),
      ),
    );
    expect(moved.message).toBe("update of documents must not move or clear signed_by_all_at once it is set");
    const early = await refusal(
      as(TOOL_API, BARBERSHOP, markSigned(WEDDING_AGREEMENT.id, "2026-10-19T18:22:00Z")),
    );
    expect(early.message).toBe(
      "update of documents must not set signed_by_all_at while it has no signer or a signer has not signed",
    );
  });

  it("it fires on update only: an insert may carry the time, which is code's (rule 9), as seed-agreement-signed loads as it stands", async () => {
    expect(
      await as(
        RUNTIME,
        null,
        insertEach(["documents", { ...HAIRCUT_ESTIMATE, signed_by_all_at: "2026-10-21T16:55:00Z" }]),
      ),
    ).toMatchObject([{ id: HAIRCUT_ESTIMATE.id }]);
  });

  it("the yoga studio's scope marking the barbershop's agreement signed by all touches no row (row-level security)", async () => {
    expect(await as(TOOL_API, YOGA_STUDIO, markSigned(WEDDING_AGREEMENT.id, "2026-10-19T18:22:00Z"))).toEqual(
      [],
    );
    expect(await as(TOOL_API, YOGA_STUDIO, markSigned(HEALTH_AGREEMENT.id, "2026-10-20T15:30:00Z"))).toEqual(
      [],
    );
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
const foreignKey = (name: string) => ({ code: "23503", constraintOneOf: [name] });
const repeated = (name: string) => ({ code: "23505", constraintOneOf: [name] });
const insertDocument = (values: Values) => insertEach(["documents", values]);

/** One-rule probes (README "Checked on", round 2's 36 and one per rule beyond them): each refused by its rule, or passed. */
const PROBES: Probe[] = [
  {
    name: "a bond of the business, shown as its own word, passes",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-bond",
      kind: "bond",
      kind_id: null,
      title: "Bond",
    }),
  },
  {
    name: "any other paper the business adds passes as other",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-other",
      kind: "other",
      kind_id: null,
      title: "Document",
    }),
  },
  {
    name: "an other paper of a space, given by the owner in the portal and shown, passes",
    run: insertDocument(SUITE_PAPER),
  },
  {
    name: "a customer's legal papers, given on their secure page, pass",
    run: insertDocument(ALEX_LEGAL_PAPERS),
  },
  { name: "a booking's court order passes", run: insertDocument(HAIRCUT_COURT_ORDER) },
  {
    name: "the business's court order is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-shop-court-order",
      kind: "court_order",
      kind_id: null,
      title: "Court order",
      shown_on_listing: false,
    }),
    refused: check("documents_legal_papers_for_customer"),
  },
  {
    name: "a team member's legal papers are refused",
    run: insertDocument({
      ...RILEY_LICENSE,
      id: "doc-probe-riley-legal-papers",
      kind: "legal_papers",
      kind_id: null,
      title: "Legal papers",
      shown_on_listing: false,
    }),
    refused: check("documents_legal_papers_for_customer"),
  },
  {
    name: "a kind the sources do not name (an ID document is K-22's id_uploads) is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-id-card",
      kind: "id_card",
      kind_id: null,
      title: "ID",
    }),
    refused: check("documents_kind_known"),
  },
  {
    name: "a bond built to sign is refused",
    run: insertDocument({ ...HAIRCUT_FORM, id: "doc-probe-built-bond", kind: "bond", title: "Bond" }),
    refused: check("documents_built_to_sign"),
  },
  {
    name: "an owner the sources do not name is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-household",
      owner_kind: "household",
      shown_on_listing: false,
    }),
    refused: check("documents_owner_kind_known"),
  },
  {
    name: "a team member's paper that names no team member is refused",
    run: insertDocument({ ...RILEY_LICENSE, id: "doc-probe-riley-nobody", staff_person_id: null }),
    refused: check("documents_owner_named"),
  },
  {
    name: "the business's own paper that names a booking is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-shop-booking",
      booking_id: "booking-alex-haircut",
    }),
    refused: check("documents_owner_named"),
  },
  {
    name: "a team member's paper sealed under another person's key is refused",
    run: insertDocument({ ...RILEY_LICENSE, id: "doc-probe-riley-sam-key", person_id: SAM }),
    refused: check("documents_sealed_for_owner"),
  },
  {
    name: "a customer's own document sealed under another person's key is refused",
    run: insertDocument({ ...ALEX_LEGAL_PAPERS, id: "doc-probe-alex-sam-key", person_id: SAM }),
    refused: check("documents_sealed_for_owner"),
  },
  {
    name: "the business's paper sealed under someone other than the person who gave it is refused",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-shop-riley-key", person_id: RILEY }),
    refused: check("documents_paper_sealed_for_giver"),
  },
  {
    name: "a blank title is refused",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-blank-title", title: "   " }),
    refused: check("documents_title_given"),
  },
  {
    name: "an origin the sources do not name (looked up) is refused",
    run: insertDocument({ ...HAIRCUT_FORM, id: "doc-probe-looked-up", origin: "looked_up" }),
    refused: check("documents_given_by_whom", "documents_origin_known"),
  },
  {
    name: "a given paper with nobody who gave it is refused",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-no-giver", given_by_person_id: null }),
    refused: check("documents_given_by_whom"),
  },
  {
    name: "a built document that says where it was given is refused",
    run: insertDocument({ ...HAIRCUT_FORM, id: "doc-probe-built-via-chat", given_via: "chat" }),
    refused: check("documents_given_by_whom"),
  },
  {
    name: "a paper given by a call is refused (nothing goes by voice: DL-029)",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-by-call", given_via: "call" }),
    refused: check("documents_given_via_known"),
  },
  {
    name: "a paper given in the portal passes",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-in-portal", given_via: "portal" }),
  },
  {
    name: "a built document holding a given number is refused",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-built-number",
      number: SHOP_LICENSE.number ?? null,
    }),
    refused: check("documents_built_holds_no_given_values"),
  },
  {
    name: "a given paper marked signed by all is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-given-signed",
      signed_by_all_at: "2026-10-19T14:30:00Z",
    }),
    refused: check("documents_signed_only_built"),
  },
  {
    name: "a built document signed by all before it was built is refused",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-signed-early",
      signed_by_all_at: "2026-10-21T16:00:00Z",
    }),
    refused: check("documents_signed_only_built"),
  },
  {
    name: "a withdrawal with no reason is refused",
    run: insertDocument({ ...SHOP_LICENSE, id: "doc-probe-no-why", withdrawn_at: "2026-10-22T14:00:00Z" }),
    refused: check("documents_withdrawn_with_why"),
  },
  {
    name: "a withdrawal before the paper was given is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-withdrawn-early",
      withdrawn_at: "2026-10-19T14:00:00Z",
      withdrawn_why: "taken_off",
      withdrawn_by_person_id: SAM,
    }),
    refused: check("documents_withdrawn_with_why"),
  },
  {
    name: "a reason the sources do not name (a lapse: no end date is ever checked) is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-expired",
      withdrawn_at: "2026-10-22T14:00:00Z",
      withdrawn_why: "expired",
      withdrawn_by_person_id: SAM,
    }),
    refused: check("documents_withdrawn_why_known"),
  },
  {
    name: "a paper taken off by nobody is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-taken-off-by-nobody",
      withdrawn_at: "2026-10-22T14:00:00Z",
      withdrawn_why: "taken_off",
      withdrawn_by_person_id: null,
    }),
    refused: check("documents_withdrawn_by_whom"),
  },
  {
    name: "a document let go as not signed in time by a person is refused (the clock lets it go)",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-let-go-by-sam",
      withdrawn_at: "2026-10-21T17:40:00Z",
      withdrawn_why: "not_signed_in_time",
      withdrawn_by_person_id: SAM,
    }),
    refused: check("documents_withdrawn_by_whom"),
  },
  {
    name: "a built document not signed in time, let go by the clock with no person, passes",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-let-go",
      withdrawn_at: "2026-10-21T17:40:00Z",
      withdrawn_why: "not_signed_in_time",
      withdrawn_by_person_id: null,
    }),
  },
  {
    name: "a given paper let go as not signed in time is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-given-let-go",
      withdrawn_at: "2026-10-22T14:00:00Z",
      withdrawn_why: "not_signed_in_time",
      withdrawn_by_person_id: null,
    }),
    refused: check("documents_not_signed_only_built"),
  },
  {
    name: "a document signed by all, let go as not signed in time, is refused",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-signed-let-go",
      signed_by_all_at: "2026-10-21T16:50:00Z",
      withdrawn_at: "2026-10-21T17:40:00Z",
      withdrawn_why: "not_signed_in_time",
      withdrawn_by_person_id: null,
    }),
    refused: check("documents_not_signed_only_built"),
  },
  {
    name: "a team member's paper shown on the listing passes",
    run: insertDocument({
      ...RILEY_LICENSE,
      id: "doc-probe-riley-certificate",
      kind: "certificate",
      kind_id: null,
      title: "Certificate",
    }),
  },
  {
    name: "a booking's given paper shown on the listing is refused",
    run: insertDocument({
      ...HAIRCUT_COURT_ORDER,
      id: "doc-probe-haircut-paper-shown",
      kind: "other",
      title: "Document",
      shown_on_listing: true,
    }),
    refused: check("documents_listing_only_own_papers"),
  },
  {
    name: "a booking's built form shown on the listing is refused",
    run: insertDocument({ ...HAIRCUT_FORM, id: "doc-probe-form-shown", shown_on_listing: true }),
    refused: check("documents_listing_only_own_papers"),
  },
  {
    name: "a customer's legal papers put on the listing later are refused",
    run: async (tx) => {
      await insertReturning(tx, "documents", ALEX_LEGAL_PAPERS);
      return updateDocument(ALEX_LEGAL_PAPERS.id, { shown_on_listing: true })(tx);
    },
    refused: check("documents_listing_only_own_papers"),
  },
  { name: "a standard agreement for the event hours passes", run: insertDocument(EVENT_AGREEMENT) },
  {
    name: "a second standing agreement for one service is refused",
    run: insertEach(
      ["documents", EVENT_AGREEMENT],
      [
        "documents",
        { ...EVENT_AGREEMENT, id: "doc-probe-event-hours-agreement-2", added_at: "2026-10-19T18:30:00Z" },
      ],
    ),
    refused: repeated("documents_one_standard_agreement_per_service"),
  },
  {
    name: "a new standing agreement passes once the first is withdrawn as replaced",
    run: async (tx) => {
      await insertReturning(tx, "documents", EVENT_AGREEMENT);
      await updateDocument(EVENT_AGREEMENT.id, {
        withdrawn_at: "2026-10-19T18:30:00Z",
        withdrawn_why: "replaced",
        withdrawn_by_person_id: SAM,
      })(tx);
      return insertReturning(tx, "documents", {
        ...EVENT_AGREEMENT,
        id: "doc-probe-event-hours-agreement-2",
        added_at: "2026-10-19T18:30:00Z",
      });
    },
  },
  {
    name: "the barbershop's service named on the yoga studio's agreement is refused",
    run: insertDocument({ ...EVENT_AGREEMENT, id: "doc-probe-yoga-agreement", business_id: YOGA_STUDIO }),
    refused: foreignKey("documents_service_fk"),
  },
  {
    name: "a service that does not exist is refused",
    run: insertDocument({ ...EVENT_AGREEMENT, id: "doc-probe-no-service", service_id: "svc-none" }),
    refused: foreignKey("documents_service_fk"),
  },
  {
    name: "a standard agreement that names a kind of work is refused",
    run: insertDocument({ ...EVENT_AGREEMENT, id: "doc-probe-agreement-kind", kind_id: "barber" }),
    refused: check("documents_standard_agreement_for_service"),
  },
  {
    name: "a standard agreement as a contract is refused",
    run: insertDocument({ ...EVENT_AGREEMENT, id: "doc-probe-agreement-contract", kind: "contract" }),
    refused: check("documents_standard_agreement_for_service"),
  },
  {
    name: "a standard agreement as a given paper is refused",
    run: insertDocument({
      ...SHOP_LICENSE,
      id: "doc-probe-agreement-given",
      kind: "agreement",
      kind_id: null,
      title: "Standard agreement",
      shown_on_listing: false,
      service_id: "svc-lees-event-hours",
    }),
    refused: check("documents_standard_agreement_for_service"),
  },
  {
    name: "a standard agreement on a booking's document is refused",
    run: insertDocument({
      ...HAIRCUT_FORM,
      id: "doc-probe-agreement-booking",
      kind: "agreement",
      title: "Standard agreement",
      service_id: "svc-lees-event-hours",
    }),
    refused: check("documents_standard_agreement_for_service"),
  },
  {
    name: "a team member's paper at a business where they have no staff row is refused",
    run: insertDocument({ ...RILEY_LICENSE, id: "doc-probe-riley-at-yoga", business_id: YOGA_STUDIO }),
    refused: foreignKey("documents_staff_fk"),
  },
  {
    name: "a space that does not exist is refused",
    run: insertDocument({ ...SUITE_PAPER, id: "doc-probe-no-space", place_or_thing_id: "place-none" }),
    refused: foreignKey("documents_place_or_thing_fk"),
  },
  {
    name: "a booking that does not exist is refused",
    run: insertDocument({ ...HAIRCUT_FORM, id: "doc-probe-no-booking", booking_id: "booking-none" }),
    refused: foreignKey("documents_booking_fk"),
  },
  {
    name: "a PDF of Riley's license, uploaded in the portal by the owner, passes",
    run: insertEach([
      "document_files",
      {
        ...RILEY_PHOTO,
        id: "docfile-probe-pdf",
        content_type: "application/pdf",
        uploaded_by_person_id: SAM,
        uploaded_via: "portal",
      },
    ]),
  },
  {
    name: "a PNG of it passes",
    run: insertEach([
      "document_files",
      { ...RILEY_PHOTO, id: "docfile-probe-png", content_type: "image/png" },
    ]),
  },
  {
    name: "an SVG is refused (a browser can run it as a page)",
    run: insertEach([
      "document_files",
      { ...RILEY_PHOTO, id: "docfile-probe-svg", content_type: "image/svg+xml" },
    ]),
    refused: check("document_files_content_type_form"),
  },
  {
    name: "an XHTML file is refused",
    run: insertEach([
      "document_files",
      { ...RILEY_PHOTO, id: "docfile-probe-xhtml", content_type: "application/xhtml+xml" },
    ]),
    refused: check("document_files_content_type_form"),
  },
  {
    name: "a plain-text file is refused",
    run: insertEach([
      "document_files",
      { ...RILEY_PHOTO, id: "docfile-probe-text", content_type: "text/plain" },
    ]),
    refused: check("document_files_content_type_form"),
  },
  {
    name: "a file sealed under another person's key than its document's is refused",
    run: insertEach(["document_files", { ...RILEY_PHOTO, id: "docfile-probe-sam-key", person_id: SAM }]),
    refused: foreignKey("document_files_document_fk"),
  },
  {
    name: "a file of a document of another business is refused",
    run: insertEach([
      "document_files",
      { ...RILEY_PHOTO, id: "docfile-probe-yoga", business_id: YOGA_STUDIO },
    ]),
    refused: foreignKey("document_files_document_fk"),
  },
  {
    name: "the agreement's words in a second language pass",
    run: insertEach(["document_texts", { ...HEALTH_TEXT, id: "doctext-probe-es", language: "es" }]),
  },
  {
    name: "a second English text of one document is refused",
    run: insertEach(["document_texts", { ...HEALTH_TEXT, id: "doctext-probe-en-2" }]),
    refused: repeated("document_texts_one_per_language"),
  },
  {
    name: "a hash that is not the words' is refused",
    run: insertEach([
      "document_texts",
      {
        ...HEALTH_TEXT,
        id: "doctext-probe-hash",
        language: "es",
        words_sha256: WEDDING_TEXT.words_sha256 ?? null,
      },
    ]),
    refused: check("document_texts_words_sha256_match"),
  },
  {
    name: "the words' hash in upper-case hex is refused",
    run: insertEach([
      "document_texts",
      {
        ...HEALTH_TEXT,
        id: "doctext-probe-upper",
        language: "es",
        words_sha256: textOf(HEALTH_TEXT.words_sha256).toUpperCase(),
      },
    ]),
    refused: check("document_texts_words_sha256_match"),
  },
  {
    name: "a language that is not a BCP 47 tag is refused",
    run: insertEach(["document_texts", { ...HEALTH_TEXT, id: "doctext-probe-english", language: "English" }]),
    refused: check("document_texts_language_form"),
  },
  {
    name: "blank words are refused",
    run: insertEach([
      "document_texts",
      {
        ...HEALTH_TEXT,
        id: "doctext-probe-blank",
        language: "es",
        words: "   ",
        words_sha256: sha256Hex("   "),
      },
    ]),
    refused: check("document_texts_words_given"),
  },
  {
    name: "a blank text version is refused",
    run: insertEach([
      "document_texts",
      { ...HEALTH_TEXT, id: "doctext-probe-version", language: "es", text_version: " " },
    ]),
    refused: check("document_texts_version_given"),
  },
  {
    name: "a text of a document of another business is refused",
    run: insertEach([
      "document_texts",
      { ...HEALTH_TEXT, id: "doctext-probe-barbershop", language: "es", business_id: BARBERSHOP },
    ]),
    refused: foreignKey("document_texts_document_fk"),
  },
  {
    name: "Sam asked twice to sign one document is refused",
    run: insertEach(["document_signers", { ...HEALTH_SIGNER, id: "docsigner-probe-sam-2" }]),
    refused: repeated("document_signers_one_per_person"),
  },
  {
    name: "a blank signs_as is refused",
    run: insertEach([
      "document_signers",
      { ...WEDDING_SIGNER, id: "docsigner-probe-blank", person_id: RILEY, signs_as: " " },
    ]),
    refused: check("document_signers_signs_as_given"),
  },
  {
    name: "a signer of a document of another business is refused",
    run: insertEach([
      "document_signers",
      { ...WEDDING_SIGNER, id: "docsigner-probe-yoga", person_id: RILEY, business_id: YOGA_STUDIO },
    ]),
    refused: foreignKey("document_signers_document_fk"),
  },
  {
    name: "Sam's tap on his standard agreement passes",
    run: insertEach(["document_signatures", WEDDING_SIGNATURE]),
  },
  {
    name: "his typed name on it instead, sealed, passes",
    run: insertEach([
      "document_signatures",
      { ...WEDDING_SIGNATURE, how: "typed_name", typed_name: HEALTH_SIGNATURE.typed_name ?? null },
    ]),
  },
  {
    name: "a typed-name signature with no name is refused",
    run: insertEach(["document_signatures", { ...WEDDING_SIGNATURE, how: "typed_name", typed_name: null }]),
    refused: check("document_signatures_typed_name_given"),
  },
  {
    name: "a tap that carries a typed name is refused",
    run: insertEach([
      "document_signatures",
      { ...WEDDING_SIGNATURE, typed_name: HEALTH_SIGNATURE.typed_name ?? null },
    ]),
    refused: check("document_signatures_typed_name_given"),
  },
  {
    name: "a way of signing the sources do not name is refused",
    run: insertEach(["document_signatures", { ...WEDDING_SIGNATURE, how: "drawn" }]),
    refused: check("document_signatures_how_known"),
  },
  {
    name: "a signature in the chat is refused (a document is signed only on the secure page)",
    run: insertEach(["document_signatures", { ...WEDDING_SIGNATURE, channel: "chat" }]),
    refused: check("document_signatures_channel_known"),
  },
  {
    name: "Sam's second signature on the health agreement is refused",
    run: insertEach(["document_signatures", { ...HEALTH_SIGNATURE, id: "docsig-probe-sam-2" }]),
    refused: repeated("document_signatures_one_per_signer"),
  },
  {
    name: "a signature by someone other than its signer row's person is refused (nobody signs for someone else)",
    run: insertEach(["document_signatures", { ...WEDDING_SIGNATURE, person_id: RILEY }]),
    refused: foreignKey("document_signatures_signer_fk"),
  },
  {
    name: "a signature naming another document's words is refused",
    run: insertEach([
      "document_signatures",
      {
        ...WEDDING_SIGNATURE,
        document_text_id: textOf(HEALTH_TEXT.id),
        words_sha256: textOf(HEALTH_TEXT.words_sha256),
      },
    ]),
    refused: foreignKey("document_signatures_text_fk"),
  },
  {
    name: "a signature whose hash is not its words' is refused",
    run: insertEach([
      "document_signatures",
      { ...WEDDING_SIGNATURE, words_sha256: textOf(HEALTH_TEXT.words_sha256) },
    ]),
    refused: foreignKey("document_signatures_text_fk"),
  },
  {
    name: "a signature of a document of another business is refused",
    run: insertEach(["document_signatures", { ...WEDDING_SIGNATURE, business_id: YOGA_STUDIO }]),
    refused: foreignKey("document_signatures_document_fk"),
  },
];

describe("one-rule probes as the runtime side, every seed loaded and Sam's unsigned standard agreement: each refused by the rule it names, or passed as the sources allow", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures([...OTHER_SEEDS, ...SEEDS, WEDDING_FILE]);
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
 * Each refused fixture with its one fault removed: K-35's README names what passes once it is fixed. A fix is a value
 * changed (`fixed`), a value left out (`dropped`), the scope that may read it, the tables' owner, or a row written first.
 */
const REFUSED_CASES: {
  file: string;
  fixed: Values;
  dropped?: string[];
  fixedScope?: string;
  byOwner?: boolean;
  first?: [string, Values][];
  without: string;
}[] = [
  {
    file: "invalid/refuse-checked-column.json",
    fixed: {},
    dropped: ["checked"],
    without: "the same insurance row as given, without checked",
  },
  {
    file: "invalid/refuse-as-given-edit.json",
    fixed: { shown_on_listing: false },
    dropped: ["number"],
    without: "the same update of shown_on_listing, with the version raised",
  },
  {
    file: "invalid/refuse-signature-edit.json",
    fixed: {},
    byOwner: true,
    without: "the same update made by the tables' owner, the migrations' role",
  },
  {
    file: "invalid/refuse-cross-business-read.json",
    fixed: {},
    fixedScope: BARBERSHOP,
    without: "the same read in the barbershop's own scope",
  },
  {
    file: "invalid/refuse-file-from-chat.json",
    fixed: { uploaded_via: "secure_page" },
    without: "the same file uploaded on the secure page",
  },
  {
    file: "invalid/refuse-customer-document-listed.json",
    fixed: { shown_on_listing: false },
    without: "the same court order with shown_on_listing false",
  },
  {
    file: "invalid/refuse-signed-by-all-moved.json",
    fixed: { signed_by_all_at: "2026-10-20T15:10:00Z" },
    without: "the same update with signed_by_all_at left as it is",
  },
  {
    file: WEDDING_FILE,
    fixed: {},
    first: [["document_signatures", WEDDING_SIGNATURE]],
    without: "the same update once Sam's signature is written",
  },
];

for (const { file, fixed, dropped = [], fixedScope, byOwner = false, first = [], without } of REFUSED_CASES) {
  describe(`${file}: refused for its one reason`, () => {
    const refused = refusedOf(file);
    const role = roleOf(refused);
    const attempt =
      (change: Values, leaveOut: readonly string[]) =>
      async (tx: Tx): Promise<readonly Record<string, unknown>[]> => {
        const withChange = (values: Values | undefined): Values =>
          Object.fromEntries(
            Object.entries({ ...(values ?? {}), ...change }).filter(([column]) => !leaveOut.includes(column)),
          );
        if (refused.action === "insert") {
          return insertReturning(tx, refused.table, withChange(refused.values));
        }
        if (refused.action === "update") {
          return tx<Record<string, unknown>[]>`
            update ${tx(refused.table)} set ${tx(columnValues(tx, refused.table, withChange(refused.set)))}
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
      // The fixture's after chain and its own rows (Sam's unsigned standard agreement, its words and his signer row).
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
        expect(await as(role, scope, attempt({}, []))).toHaveLength(refused.expect.rows);
        return;
      }
      const outcome = await refusal(as(role, scope, attempt({}, [])));
      expect(outcome.code).toBe(refused.expect.sqlstate);
      if (refused.expect.constraintOneOf !== undefined) {
        expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
      } else if (outcome.code === "42501") {
        expect(outcome.message).toBe(`permission denied for table ${refused.table}`);
      } else {
        expect(outcome.message).toBe(`column "checked" of relation "${refused.table}" does not exist`);
      }
    });

    it(`without its one fault (${without}) the same ${refused.action} passes`, async () => {
      const fix = async (tx: Tx): Promise<readonly Record<string, unknown>[]> => {
        for (const [table, values] of first) {
          await insertReturning(tx, table, values);
        }
        return attempt(fixed, dropped)(tx);
      };
      const done = byOwner
        ? await asOwner(fix)
        : await as(role, fixedScope ?? refused.scope?.businessId ?? null, fix);
      const id = refused.action === "insert" ? refused.values?.id : refused.where?.id;
      expect(done.map((row) => row.id)).toEqual([textOf(id)]);
    });
  });
}
