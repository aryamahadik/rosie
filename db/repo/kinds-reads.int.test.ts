// T-1458: K-05 v1.19's two reads (db/repo/kinds-reads.ts) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/kinds-reads`). The schema comes from migrating a fresh test schema, which
// test-db.ts drops when the file ends.
//
// readKindCatalog runs as the Tool API's role, rosie_app (item 78), in a transaction of its own and inside a call's
// under every business's scope and none; readPickedKinds runs as the runtime side's role, rosie_job (item 79). The
// tables' owner (the migrations' role) loads the seeds a fixture's `given` names (K-04's, and K-23's and K-24's as
// partSeeds, each with its own after chain, each file once), writes the rows the sign-up fixtures' notes list and the
// rows a test adds, and reads back, in one statement per table, what item 79's rule reaches. The owner is not bound by
// row-level security, so only the reads under test meet it; it also runs readPickedKinds itself, to show each
// statement's own rule holds where row-level security does not.
//
// Both role clients record every statement they send with its values (postgres.js `debug`), so the tests read what the
// two reads sent: each read's tables and columns and no other, never `*` or a whole row, never kinds.facts,
// picked_kind_texts.block, new_work_draft_blocks.answer, handles or phones; each of item 79's statements carrying its
// rule, bound to the request's own business or person; each child joined to its pick; item 77's names built in SQL; and
// item 79's steps in its order (README "What the new tasks must hold to", :1238).
//
// Rule 9: every row comes from fixture set v1's demo shops through the frozen seeds, or is a seed row under a new id or
// with one fault (no business yet, another owner, an empty name, a NULL element, its picked_at or position moved); no
// number, address, name or words are made up.
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import {
  type KindsRead,
  readKindCatalog,
  readKindCatalogIn,
  type ReadKindCatalogResponse,
  readPickedKinds,
  type ReadPickedKindsResponse,
} from "./kinds-reads";
import {
  BusinessScopeError,
  SCOPE_SETTING,
  setBusinessScope,
  type Sql,
  type Tx,
  withBusiness,
} from "./scope";
import type { ReadOptions } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Request = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const VERSION = "v1.19";
const APP_ROLE = "rosie_app";
const JOB_ROLE = "rosie_job";
const SLOW = { timeout: 120_000 };
/** A one-moment transaction, as each read's own begins (targets.ts inRuntimeTransaction). */
const ONE_MOMENT = "isolation level repeatable read read only";

const SAM = "person-sam";
const ALEX = "person-alex";
const RILEY = "person-riley";
const BARBERSHOP = "biz-lees-barbershop";
const HOME_SERVICES = "biz-lee-home-services";
const PET_BOARDING = "biz-pet-boarding";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const LEES_COMPANY = "company-lees-barbershop";
const HOME_COMPANY = "company-lee-home-services";
const SAM_BARBERSHOP = "pick-sam-barbershop";
const SAM_PLUMBING = "pick-sam-plumbing";
const SAM_ELECTRICAL = "pick-sam-electrical";
const PACK_HIKES = "pick-sam-pack-hikes";
const DRAFT = "draft-pack-hikes";
const DRAFTED_KIND = "new-pack-hikes";
/** The clock the tests read at: the latest of the v1.19 fixtures' (read-kind-catalog-sample's). */
const AT: ReadOptions = { now: new Date("2026-10-26T14:10:00Z") };

const CALLS = ["readKindCatalog", "readPickedKinds"] as const satisfies readonly KindsRead[];
type Call = (typeof CALLS)[number];

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
  shows?: string;
}

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
}

interface Exchange {
  call: string;
  given: Given;
  request: Request;
  outcome: Record<string, Json>;
}

interface SeedRow {
  table: string;
  values: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: SeedRow[];
}

/** One statement a role client sent, with its values (postgres.js debug). */
interface Sent {
  query: string;
  parameters: readonly unknown[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** Every v1.19 entry of the index, selected by its version, never by a pinned list or count (DL-124, DL-125). */
const ENTRIES = INDEX.filter((entry) => entry.version === VERSION);
const ACCEPTED = ENTRIES.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
/** The refused v1.19 exchanges, each refused for its request (README "Fixtures", v1.19: by `<call>.exchange`). */
const REFUSED_REQUESTS = ENTRIES.filter(
  (entry) => entry.expect === "refuse" && entry.def?.endsWith(".exchange") === true,
).map((entry) => entry.file);
/** The refused v1.19 answers (by `<call>.response`): what the reads never answer. */
const REFUSED_ANSWERS = ENTRIES.filter(
  (entry) => entry.expect === "refuse" && entry.def?.endsWith(".response") === true,
);

function isCall(call: string): call is Call {
  return (CALLS as readonly string[]).includes(call);
}

function callOf(exchange: Exchange): Call {
  if (!isCall(exchange.call)) {
    throw new Error(`v1.19 adds no call ${exchange.call}`);
  }
  return exchange.call;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer as the response `result` names, refused when it is anything else (an error). */
function answerOf<T extends { result: string }>(answer: unknown, result: T["result"]): T {
  if (!isRecord(answer) || answer.result !== result) {
    throw new Error(`expected the answer ${result}`);
  }
  return answer as T;
}

const catalogOf = (answer: unknown): ReadKindCatalogResponse =>
  answerOf<ReadKindCatalogResponse>(answer, "kindCatalog");
const pickedOf = (answer: unknown): ReadPickedKindsResponse =>
  answerOf<ReadPickedKindsResponse>(answer, "pickedKinds");

const UTF8 = new TextEncoder();

/** Two ids or keys compared byte by byte, their UTF-8 bytes, as collate "C" compares them on a UTF8 database. */
function compareBytes(a: string, b: string): number {
  const first = UTF8.encode(a);
  const second = UTF8.encode(b);
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const step = (first[index] ?? 0) - (second[index] ?? 0);
    if (step !== 0) {
      return step;
    }
  }
  return first.length - second.length;
}
const byBytes = (list: readonly string[]): string[] => [...list].sort(compareBytes);

/** The thrown error of a read that must throw; a read that answers is a failed test. */
async function thrownBy(read: Promise<unknown>): Promise<Error> {
  const error = await read.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) {
    throw new Error("the read answered; it should have thrown");
  }
  return error;
}

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -------------------

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const V119_ID = (readJson(new URL("data-access/data-access.v1.19.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Ajv's errors for `value` against one $defs entry of data-access v1.19; none when it passes. */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V119_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.19 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer against its call's response, or its call's errors when it is one. */
function answerErrors(call: Call, answer: unknown): string[] {
  const isError = isRecord(answer) && "error" in answer;
  return schemaErrors(isError ? `${call}.errors` : `${call}.response`, answer);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;
/** Every table of this file's schema. */
let schemaTables: Set<string>;
/** Every table's columns, by table. */
let schemaColumns: Map<string, Set<string>>;
/** Every statement the two role clients sent, in order, with its values. */
const sent: Sent[] = [];

function roleClient(role: string, applicationName: string): Sql {
  return db.connect({
    max: 4,
    onnotice: () => undefined,
    debug: (_connection: number, query: string, parameters: unknown[]) => {
      sent.push({ query, parameters: [...parameters] });
    },
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "kinds_reads" });
  app = roleClient(APP_ROLE, "rosie-t1458-app");
  job = roleClient(JOB_ROLE, "rosie-t1458-job");
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const tables = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = ${db.schema}
  `;
  schemaTables = new Set(tables.map((table) => table.name));
  const columns = await db.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = ${db.schema}
  `;
  schemaColumns = new Map();
  for (const column of columns) {
    const ofTable = schemaColumns.get(column.table_name) ?? new Set<string>();
    schemaColumns.set(column.table_name, ofTable.add(column.column_name));
  }
}, 120_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await job.end({ timeout: 5 });
  await db.drop();
});

// ---- seeds ------------------------------------------------------------------------------------------------------------

/** Empties every table the seeds write (truncating the heads and K-24's catalog cascades to the rest; this schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags, kinds restart identity cascade`;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One row as the database takes it: JSON for a jsonb column, bytes for a bytea one (`\x` and hex). */
async function insertRow(sql: Sql | Tx, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it, each file once. */
function seedRows(file: URL, seen: Set<string>): SeedRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(new URL(before, file), seen)), ...seed.rows];
}

/** `<part>/<file>`, a seed of another database part (K-05 given.partSeeds), in that part's fixtures folder. */
function partSeedUrl(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, DB_SCHEMA_DIR);
}

/** The seed files a fixture's given names: K-04's, then the other parts'. */
const seedsOf = (state: Given): URL[] => [
  ...state.k04Seeds.map((seed) => new URL(seed, CORE_DIR)),
  ...(state.partSeeds ?? []).map(partSeedUrl),
];

/** Inserts the rows of these seed files and their chains, each row once, then `noted`, in one transaction as the owner. */
async function loadSeeds(files: readonly URL[], noted: readonly SeedRow[] = []): Promise<void> {
  const seen = new Set<string>();
  const rows = [...files.flatMap((file) => seedRows(file, seen)), ...noted];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** A world: a fresh schema's tables holding these seeds with their chains, then `noted`. */
async function load(files: readonly URL[], noted: readonly SeedRow[] = []): Promise<void> {
  await reset();
  await loadSeeds(files, noted);
}

const SEED = {
  personRoles: new URL("seed-person-roles.json", CORE_DIR),
  kindsSample: partSeedUrl("kinds-of-work/seed-kinds-sample.json"),
  businessKinds: partSeedUrl("kinds-of-work/seed-business-kinds.json"),
  newWorkDraft: partSeedUrl("kinds-of-work/seed-new-work-draft.json"),
  companyTwoKinds: partSeedUrl("business-setup/seed-company-two-kinds.json"),
} as const;

/** The rows of one seed file, without its after chain. */
const ownRows = (url: URL): SeedRow[] => (readJson(url) as SeedFile).rows;

/** The one row of `url`'s own rows in `table` whose values hold `match`. */
function seedRowOf(url: URL, table: string, match: Record<string, Json>): SeedRow {
  const [row, ...more] = ownRows(url).filter(
    (candidate) =>
      candidate.table === table &&
      Object.entries(match).every(([column, value]) => candidate.values[column] === value),
  );
  if (row === undefined || more.length > 0) {
    throw new Error(`not one ${table} row of ${url.pathname} holds the values named`);
  }
  return row;
}

/** A seed value that is text, refused when it is anything else. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error("expected a text value");
  }
  return value;
}

/** A seed row under a new id or with one fault: the values named changed, every other as the seed holds it (rule 9). */
const withValues = (row: SeedRow, values: Record<string, Json>): SeedRow => ({
  table: row.table,
  values: { ...row.values, ...values },
});

// ---- the rows the sign-up fixtures' notes list (README "Fixtures", v1.19: written first) -----------------------------

/**
 * Sam's sign-up before S1-04 and S1-09, as read-picked-kinds-sign-up's note lists it: K-24's seed-business-kinds' three
 * picks with company_id and business_id null and version 1, and pick-sam-barbershop's eleven text blocks as that seed
 * holds them, each with business_id null and version 1.
 */
const SIGN_UP_ROWS: readonly SeedRow[] = ownRows(SEED.businessKinds).flatMap((row) => {
  if (row.table === "picked_kinds") {
    return [withValues(row, { company_id: null, business_id: null, version: 1 })];
  }
  if (row.table === "picked_kind_texts" && row.values.picked_kind_id === SAM_BARBERSHOP) {
    return [withValues(row, { business_id: null, version: 1 })];
  }
  return [];
});

const SIGN_UP_FIXTURE = "read-picked-kinds-sign-up.json";
/** By fixture, the rows its note says its database side writes itself (no frozen seed holds a pick with no business). */
const NOTED_ROWS: Readonly<Record<string, readonly SeedRow[]>> = {
  [SIGN_UP_FIXTURE]: SIGN_UP_ROWS,
  "read-picked-kinds-sign-up-under-business.json": SIGN_UP_ROWS,
  "read-picked-kinds-other-person.json": SIGN_UP_ROWS,
};

/** Loads a fixture's world: its seeds with their chains, then the rows its note lists. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  if (exchange.given.after.length > 0) {
    throw new Error(`${file}: a v1.19 read runs after no exchange`);
  }
  await load(seedsOf(exchange.given), NOTED_ROWS[file] ?? []);
  return exchange;
}

// ---- the worlds the tests build on ------------------------------------------------------------------------------------

/**
 * Every business's rows: Lee's Barbershop's placed pick, its eleven text blocks and its company, and Lee Home Services'
 * two picks and company (K-24's seed-business-kinds, with K-23's seed-company-two-kinds); the pet boarding business's
 * new-work pick, its draft in review and its six blocks (K-24's seed-new-work-draft); and, as rows of their own, the
 * barbershop's eleven text blocks under Lee Home Services' plumbing pick, so another business holds text blocks too.
 */
const HOME_SERVICES_TEXTS: readonly SeedRow[] = ownRows(SEED.businessKinds)
  .filter((row) => row.table === "picked_kind_texts")
  .map((row) => withValues(row, { picked_kind_id: SAM_PLUMBING, business_id: HOME_SERVICES }));

async function businessesWorld(): Promise<void> {
  await load([SEED.personRoles, SEED.businessKinds, SEED.newWorkDraft], HOME_SERVICES_TEXTS);
}

/** Every business of the businesses world, and the two of K-04's seeds that hold no kind of work. */
const BUSINESSES = [BARBERSHOP, HOME_SERVICES, PET_BOARDING, YOGA, MOVERS] as const;

const LEES_COMPANY_ROW = seedRowOf(SEED.companyTwoKinds, "companies", { id: LEES_COMPANY });
const HOME_COMPANY_ROW = seedRowOf(SEED.companyTwoKinds, "companies", { id: HOME_COMPANY });
const LEES_BARBER_ROW = seedRowOf(SEED.companyTwoKinds, "company_kinds", {
  company_id: LEES_COMPANY,
  kind_id: "barber",
});
const NEW_WORK_ROWS = ownRows(SEED.newWorkDraft);
/** The drafted kind new-pack-hikes, as K-24's seed-new-work-draft holds it. */
const DRAFTED_KIND_ROWS = NEW_WORK_ROWS.filter((row) => row.table === "kinds");
/** Sam's new-work pick, its draft and its six blocks, drafted during sign-up before any business: no business on any. */
const SAM_NEW_WORK = NEW_WORK_ROWS.filter((row) => row.table !== "kinds").map((row) =>
  withValues(row, { business_id: null }),
);
/** Sam's barbershop company named at S1-04 before S1-09 gives it a business, its barber kind, and the pick placed in it. */
const SAM_COMPANY_ROWS = [
  withValues(LEES_COMPANY_ROW, { business_id: null }),
  withValues(LEES_BARBER_ROW, { business_id: null }),
];
const SAM_PLACED_SIGN_UP = SIGN_UP_ROWS.map((row) =>
  row.table === "picked_kinds" && row.values.id === SAM_BARBERSHOP
    ? withValues(row, { company_id: LEES_COMPANY, version: 2 })
    : row,
);

const ALEX_COMPANY = "company-alex-lee-home-services";

/** A row of Sam's sign-up as Alex's own: its ids moved to Alex's and its owner Alex (a seed row under a new id). */
function asAlex(row: SeedRow): SeedRow {
  const values: Record<string, Json> = { ...row.values };
  for (const column of ["id", "picked_kind_id", "draft_id"]) {
    const value = values[column];
    if (typeof value === "string") {
      values[column] = value.replace(/^pick-sam-/, "pick-alex-").replace(/^draft-/, "draft-alex-");
    }
  }
  if (Object.hasOwn(values, "owner_person_id")) {
    values.owner_person_id = ALEX;
  }
  return { table: row.table, values };
}

/** Alex's sign-up of his own: Sam's sign-up rows and new work under Alex's ids, and Lee Home Services' company as his. */
const ALEX_ROWS = [
  withValues(HOME_COMPANY_ROW, { id: ALEX_COMPANY, owner_person_id: ALEX, business_id: null }),
  ...[...SIGN_UP_ROWS, ...SAM_NEW_WORK].map(asAlex),
];

/**
 * Two sign-ups with no business: Sam's (his three picks, the barbershop placed in his company with no business, its
 * text blocks, his new-work pick with its draft and blocks) and Alex's, under K-04's seeds and K-24's catalog sample.
 */
async function signUpWorld(): Promise<void> {
  await load(
    [SEED.personRoles, SEED.kindsSample],
    [...DRAFTED_KIND_ROWS, ...SAM_COMPANY_ROWS, ...SAM_PLACED_SIGN_UP, ...SAM_NEW_WORK, ...ALEX_ROWS],
  );
}

// ---- the reads ----------------------------------------------------------------------------------------------------------

const nowOf = (exchange: Exchange): ReadOptions => ({ now: new Date(exchange.given.now) });

/** The read a fixture names, in its own transaction, as `client` (rosie_app for item 78, rosie_job for item 79). */
async function runRead(exchange: Exchange, client?: Sql): Promise<unknown> {
  const request = structuredClone(exchange.request) as never;
  return callOf(exchange) === "readKindCatalog"
    ? await readKindCatalog(client ?? app, request, nowOf(exchange))
    : await readPickedKinds(client ?? job, request, nowOf(exchange));
}

/** readKindCatalogIn as `client`, in a transaction `mode` begins (one moment by default), under `scope` when given. */
async function catalogIn(
  client: Sql,
  scope: string | null,
  options: ReadOptions = AT,
  mode: string = ONE_MOMENT,
): Promise<unknown> {
  return await client.begin(mode, async (tx) => {
    if (scope !== null) {
      await setBusinessScope(tx, scope);
    }
    return readKindCatalogIn(tx, {}, options);
  });
}

/** readPickedKinds as `client` for the business (or none) and the person, at the tests' clock. */
async function picked(client: Sql, businessId: string | null, personId: string): Promise<unknown> {
  return await readPickedKinds(client, { businessId, personId }, AT);
}

/** Every business the world holds, by id. */
async function businessesHeld(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`select id from businesses order by id collate "C"`;
  return rows.map((row) => row.id);
}

/** Each list of a readPickedKinds answer by its rows' names: picks and companies in the answer's order, the rest sorted. */
interface Names {
  picks: string[];
  texts: string[];
  drafts: string[];
  blocks: string[];
  companies: string[];
}

function answeredNames(answer: ReadPickedKindsResponse): Names {
  return {
    picks: answer.picks.map((pick) => pick.id),
    texts: byBytes(answer.picks.flatMap((pick) => pick.texts.map((text) => text.rowId))),
    drafts: byBytes(answer.picks.flatMap((pick) => (pick.draft === null ? [] : [pick.draft.id]))),
    blocks: byBytes(answer.picks.flatMap((pick) => pick.draft?.blocks.map((block) => block.rowId) ?? [])),
    companies: answer.companies.map((company) => company.id),
  };
}

/**
 * What item 79's rule reaches, read by the tables' owner in one statement per table, the rule written once with `or`:
 * the business's rows, and the person's with no business, each child with its pick's (and a block with its draft's)
 * business; picks in (picked_at, position, id) order and companies in id order, as the database orders them.
 */
async function reached(businessId: string | null, personId: string): Promise<Names> {
  const names = (rows: readonly { name: string }[]): string[] => rows.map((row) => row.name);
  const picks = await db.sql<{ name: string }[]>`
    select id as name from picked_kinds
    where business_id = ${businessId} or (business_id is null and owner_person_id = ${personId})
    order by picked_at, position, id collate "C"
  `;
  const texts = await db.sql<{ name: string }[]>`
    select t.picked_kind_id || '/' || t.pf_key as name
    from picked_kind_texts t join picked_kinds p on p.id = t.picked_kind_id
    where (p.business_id = ${businessId} and t.business_id = ${businessId})
       or (p.business_id is null and p.owner_person_id = ${personId} and t.business_id is null)
  `;
  const drafts = await db.sql<{ name: string }[]>`
    select d.id as name from new_work_drafts d join picked_kinds p on p.id = d.picked_kind_id
    where (p.business_id = ${businessId} and d.business_id = ${businessId})
       or (p.business_id is null and p.owner_person_id = ${personId} and d.business_id is null)
  `;
  const blocks = await db.sql<{ name: string }[]>`
    select b.draft_id || '/' || b.block as name
    from new_work_draft_blocks b join new_work_drafts d on d.id = b.draft_id join picked_kinds p on p.id = d.picked_kind_id
    where (p.business_id = ${businessId} and d.business_id = ${businessId} and b.business_id = ${businessId})
       or (p.business_id is null and p.owner_person_id = ${personId} and d.business_id is null
           and b.business_id is null)
  `;
  const companies = await db.sql<{ name: string }[]>`
    select id as name from companies
    where business_id = ${businessId} or (business_id is null and owner_person_id = ${personId})
    order by id collate "C"
  `;
  return {
    picks: names(picks),
    texts: byBytes(names(texts)),
    drafts: byBytes(names(drafts)),
    blocks: byBytes(names(blocks)),
    companies: names(companies),
  };
}

/** One row a readPickedKinds answer holds, with its business and its owner (a child's is its pick's). */
interface AnsweredRow {
  table: string;
  name: string;
  businessId: string | null;
  owner: string;
  pickBusinessId: string | null;
}

function answeredRows(answer: ReadPickedKindsResponse): AnsweredRow[] {
  const rows: AnsweredRow[] = [];
  for (const pick of answer.picks) {
    const of = { owner: pick.ownerPersonId, pickBusinessId: pick.businessId };
    rows.push({ table: "picked_kinds", name: pick.id, businessId: pick.businessId, ...of });
    for (const text of pick.texts) {
      rows.push({ table: "picked_kind_texts", name: text.rowId, businessId: text.businessId, ...of });
    }
    if (pick.draft !== null) {
      rows.push({ table: "new_work_drafts", name: pick.draft.id, businessId: pick.draft.businessId, ...of });
      for (const block of pick.draft.blocks) {
        rows.push({ table: "new_work_draft_blocks", name: block.rowId, businessId: block.businessId, ...of });
      }
    }
  }
  for (const company of answer.companies) {
    rows.push({
      table: "companies",
      name: company.id,
      businessId: company.businessId,
      owner: company.ownerPersonId,
      pickBusinessId: company.businessId,
    });
  }
  return rows;
}

/**
 * readPickedKinds for the business (or none) and the person, as rosie_job: valid at v1.19; every row the business's or,
 * with no business, the person's own, each child with its pick's business; exactly the rows the rule reaches, in the
 * database's order; and the same answer from the tables' owner, whom only each statement's own rule holds.
 */
async function expectReached(businessId: string | null, personId: string): Promise<ReadPickedKindsResponse> {
  const where = `under ${businessId ?? "no business"} for ${personId}`;
  const answer = pickedOf(await picked(job, businessId, personId));
  expect(answerErrors("readPickedKinds", answer), where).toEqual([]);
  expect([answer.businessId, answer.personId], where).toEqual([businessId, personId]);
  for (const row of answeredRows(answer)) {
    const theirs = row.businessId === null ? row.owner === personId : row.businessId === businessId;
    expect(theirs, `${where}: ${row.table} ${row.name}`).toBe(true);
    expect(row.businessId, `${where}: ${row.table} ${row.name} beside its pick`).toBe(row.pickBusinessId);
  }
  expect(answeredNames(answer), where).toEqual(await reached(businessId, personId));
  expect(pickedOf(await picked(db.sql, businessId, personId)), `${where}, as the tables' owner`).toEqual(
    answer,
  );
  return answer;
}

/** Every name a readPickedKinds answer holds, of every table. */
function allNames(answer: ReadPickedKindsResponse): string[] {
  return answeredRows(answer).map((row) => row.name);
}

// ---- the statements: their tables, columns, rules and order -----------------------------------------------------------

/** A statement as one line, its spaces folded. */
const lineOf = (query: string): string => query.replace(/\s+/g, " ").trim();

/** A statement's tokens: comments, string literals and collations dropped, quoted names unquoted, lower case. */
function tokensOf(statement: string): string[] {
  return (
    statement
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/'(?:[^']|'')*'/g, " ")
      .replace(/collate\s+"[^"]*"/gi, " ")
      .replaceAll('"', "")
      .toLowerCase()
      .match(/[a-z_][a-z0-9_$]*|\$\d+|\d+|[^\s\w]/g) ?? []
  );
}

const isName = (token: string | undefined): token is string =>
  token !== undefined && /^[a-z_][a-z0-9_$]*$/.test(token);

/** Words that may follow a table in FROM or JOIN without being its alias. */
const NOT_AN_ALIAS = new Set([
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "on",
  "using",
  "order",
  "group",
  "having",
  "limit",
  "offset",
  "for",
  "union",
  "returning",
]);

/**
 * The tables a statement reads, each by its name and its alias (name or alias → table), and the places it declares
 * them: a schema table after FROM or JOIN (so `extract(epoch from p.picked_at)` declares nothing).
 */
function declarationsOf(tokens: readonly string[]): { tables: Map<string, string>; places: Set<number> } {
  const tables = new Map<string, string>();
  const places = new Set<number>();
  tokens.forEach((token, index) => {
    const table = tokens[index + 1];
    if ((token !== "from" && token !== "join") || !isName(table) || !schemaTables.has(table)) {
      return;
    }
    tables.set(table, table);
    places.add(index + 1);
    const alias = tokens[index + 2];
    if (isName(alias) && !NOT_AN_ALIAS.has(alias) && !schemaTables.has(alias)) {
      tables.set(alias, table);
      places.add(index + 2);
    }
  });
  return { tables, places };
}

/** Every table of this file's schema a statement names, wherever it names it. */
function tablesOf(statement: string): string[] {
  return [...new Set(tokensOf(statement).filter((token) => schemaTables.has(token)))];
}

/** The tables each read may read (README items 78 and 79), and no others. */
const TABLES_OF: Readonly<Record<Call, readonly string[]>> = {
  readKindCatalog: ["kinds"],
  readPickedKinds: [
    "businesses",
    "companies",
    "new_work_draft_blocks",
    "new_work_drafts",
    "persons",
    "picked_kind_texts",
    "picked_kinds",
  ],
};

/** Each table's column list, as items 78 and 79 name them, and no other column of the table. */
const COLUMNS_OF: Readonly<Record<string, readonly string[]>> = {
  kinds: ["id", "name", "pattern", "source", "style", "version"],
  persons: ["id"],
  businesses: ["id"],
  picked_kinds: [
    "business_id",
    "company_id",
    "id",
    "kind_id",
    "outcome",
    "owner_person_id",
    "picked_at",
    "position",
    "version",
    "words",
  ],
  picked_kind_texts: ["business_id", "pf_key", "picked_kind_id", "version"],
  new_work_drafts: ["business_id", "drafted_at", "id", "picked_kind_id", "state", "version"],
  new_work_draft_blocks: [
    "answered_at",
    "block",
    "business_id",
    "draft_id",
    "facts_on",
    "outcome",
    "switches_on",
    "version",
  ],
  companies: ["business_id", "id", "name", "owner_person_id", "version"],
};

/**
 * Never named by any statement of the two reads (README :1238): kinds.facts, new_work_draft_blocks.answer (no column
 * of these names is read), handles and phones; and no kind_flows or company_kinds row.
 */
const NEVER_NAMED = new Set(["facts", "answer", "handles", "phones", "kind_flows", "company_kinds"]);

/** The tokens a `*` that is a wildcard (every column) follows: `select *`, `a, *`, `t.*`, `count(*)`. */
const WILDCARD_AFTER = new Set(["select", ",", ".", "("]);

/** The columns of the tables `owners` that a token names. */
const columnOf = (owners: Iterable<string>, token: string): string[] =>
  [...owners].filter((table) => schemaColumns.get(table)?.has(token) === true);

/**
 * What is wrong with one statement of `call`: `*`, a whole row (a table or alias named where a value goes), a table
 * beyond the read's own, a column beyond its table's list (picked_kind_texts.block among them), a name never named,
 * and a column left unqualified in a statement that reads two tables or more.
 */
function problemsOf(statement: string, call: Call): string[] {
  const tokens = tokensOf(statement);
  const { tables, places } = declarationsOf(tokens);
  const read = new Set(tables.values());
  const problems: string[] = [];
  for (const table of tablesOf(statement)) {
    if (!TABLES_OF[call].includes(table)) {
      problems.push(`a table beyond its own: ${table}`);
    }
  }
  tokens.forEach((token, index) => {
    // A wildcard follows select, a comma, a dot or a parenthesis; a `*` between two values multiplies them.
    if (token === "*" && WILDCARD_AFTER.has(tokens[index - 1] ?? "")) {
      problems.push("*");
    }
    if (NEVER_NAMED.has(token)) {
      problems.push(`a name never named: ${token}`);
    }
    if (tables.has(token) && !places.has(index) && tokens[index + 1] !== ".") {
      problems.push(`a whole row: ${token}`);
    }
    if (tokens[index - 1] === ".") {
      const owner = tables.get(tokens[index - 2] ?? "");
      if (owner === undefined) {
        problems.push(`a column of no table read: ${token}`);
      } else if (!(COLUMNS_OF[owner] ?? []).includes(token)) {
        problems.push(`a column beyond its list: ${owner}.${token}`);
      }
      return;
    }
    if (places.has(index) || tables.has(token) || tokens[index - 1] === "as") {
      return;
    }
    const owners = columnOf(read, token);
    if (owners.length === 0) {
      return;
    }
    if (read.size > 1) {
      problems.push(`an unqualified column in a join: ${token}`);
    } else if (!owners.some((table) => (COLUMNS_OF[table] ?? []).includes(token))) {
      problems.push(`a column beyond its list: ${owners.join(", ")}.${token}`);
    }
  });
  return problems;
}

/** Every column a statement names, of the tables it reads, qualified or not (never an output alias). */
function columnsOf(statement: string): string[] {
  const tokens = tokensOf(statement);
  const { tables, places } = declarationsOf(tokens);
  const read = new Set(tables.values());
  const named = new Set<string>();
  tokens.forEach((token, index) => {
    if (places.has(index) || tables.has(token) || tokens[index - 1] === "as") {
      return;
    }
    if (tokens[index - 1] === ".") {
      const owner = tables.get(tokens[index - 2] ?? "");
      if (owner !== undefined && schemaColumns.get(owner)?.has(token) === true) {
        named.add(`${owner}.${token}`);
      }
      return;
    }
    for (const owner of columnOf(read, token)) {
      named.add(`${owner}.${token}`);
    }
  });
  return [...named];
}

/** The aliases a statement reads each of its tables under. */
function aliasOf(statement: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [name, table] of declarationsOf(tokensOf(statement)).tables) {
    if (name !== table) {
      aliases.set(table, name);
    }
  }
  return aliases;
}

/** The tables of item 79 whose rows carry the rule: a business's, or a person's with no business. */
const RULED = new Set([
  "picked_kinds",
  "picked_kind_texts",
  "new_work_drafts",
  "new_work_draft_blocks",
  "companies",
]);

/**
 * What is wrong with the rule one of item 79's statements carries for `request` (README item 79, default 180): persons
 * and businesses read by the request's own id alone; every other statement either the business's, each table read
 * under business_id = the request's business, or the person's, each under business_id is null with the pick's (or the
 * company's) owner_person_id = the request's person; a text or a draft joined to its pick, a block to its draft and the
 * draft to its pick; and no `or`.
 */
function ruleProblemsOf(statement: Sent, request: { businessId: string | null; personId: string }): string[] {
  const line = lineOf(statement.query);
  const bound = (placeholder: string | undefined): unknown =>
    placeholder === undefined ? undefined : statement.parameters[Number(placeholder.slice(1)) - 1];
  const tables = new Set(tablesOf(line));
  if (tables.has("persons")) {
    return line === "select id from persons where id = $1" && bound("$1") === request.personId
      ? []
      : ["persons read other than by the request's person"];
  }
  if (tables.has("businesses")) {
    return line === "select id from businesses where id = $1" && bound("$1") === request.businessId
      ? []
      : ["businesses read other than by the request's business"];
  }
  if (![...tables].some((table) => RULED.has(table))) {
    return [];
  }
  const problems: string[] = [];
  const aliases = aliasOf(line);
  if (/\bor\b/.test(line)) {
    problems.push("an or");
  }
  const persons = line.includes("business_id is null");
  for (const table of tables) {
    const alias = aliases.get(table);
    if (alias === undefined) {
      problems.push(`${table} read under no alias`);
      continue;
    }
    if (persons) {
      if (!line.includes(`${alias}.business_id is null`)) {
        problems.push(`${table}: no ${alias}.business_id is null`);
      }
    } else {
      const placeholder = new RegExp(`\\b${alias}\\.business_id = (\\$\\d+)`).exec(line)?.[1];
      if (request.businessId === null || bound(placeholder) !== request.businessId) {
        problems.push(`${table}: not ${alias}.business_id = the request's business`);
      }
    }
  }
  if (persons) {
    const owner = aliases.get(tables.has("companies") ? "companies" : "picked_kinds");
    const placeholder =
      owner === undefined
        ? undefined
        : new RegExp(`\\b${owner}\\.owner_person_id = (\\$\\d+)`).exec(line)?.[1];
    if (bound(placeholder) !== request.personId) {
      problems.push("not owner_person_id = the request's person on the pick or the company");
    }
  }
  const pick = aliases.get("picked_kinds");
  const draft = aliases.get("new_work_drafts");
  const text = aliases.get("picked_kind_texts");
  const block = aliases.get("new_work_draft_blocks");
  if (
    text !== undefined &&
    !line.includes(`join picked_kinds ${pick ?? "?"} on ${pick ?? "?"}.id = ${text}.picked_kind_id`)
  ) {
    problems.push("a text not joined to its pick");
  }
  if (
    draft !== undefined &&
    !line.includes(`join picked_kinds ${pick ?? "?"} on ${pick ?? "?"}.id = ${draft}.picked_kind_id`)
  ) {
    problems.push("a draft not joined to its pick");
  }
  if (
    block !== undefined &&
    !line.includes(`join new_work_drafts ${draft ?? "?"} on ${draft ?? "?"}.id = ${block}.draft_id`)
  ) {
    problems.push("a block not joined to its draft");
  }
  return problems;
}

/** The fixed statements the two reads send, each by what it does. */
const FIXED_LABELS: ReadonlyMap<string, string> = new Map([
  ["select 1", "probe"],
  [`begin ${ONE_MOMENT}`, "begin"],
  ["commit", "commit"],
  ["rollback", "rollback"],
  ["select set_config($1, '', true)", "clear the scope"],
  ["select current_setting($1, true) as scope", "read the scope"],
  [
    "select pg_has_role(current_user, 'rosie_app', 'USAGE') as app, pg_has_role(current_user, 'rosie_job', 'USAGE') as job",
    "the role",
  ],
  [
    "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
    "one moment",
  ],
  ["select now() as now", "now"],
]);

/** One statement by what it does: a fixed one by its label, a read by its first table and, for item 79's, its part. */
function labelOf(statement: Sent): string {
  const line = lineOf(statement.query);
  const fixed = FIXED_LABELS.get(line);
  if (fixed !== undefined) {
    return fixed;
  }
  if (line === "select set_config($1, $2, true)") {
    return `scope ${String(statement.parameters[1])}`;
  }
  const [first] = declarationsOf(tokensOf(line)).tables.values();
  if (first === undefined) {
    return line;
  }
  if (!RULED.has(first)) {
    return first;
  }
  return `${first}, ${line.includes("business_id is null") ? "the person's" : "the business's"}`;
}

/** Item 79's five statements of one part, in its order. */
const PART = [
  "picked_kinds",
  "picked_kind_texts",
  "new_work_drafts",
  "new_work_draft_blocks",
  "companies",
] as const;
const partOf = (whose: "the business's" | "the person's"): string[] =>
  PART.map((table) => `${table}, ${whose}`);

/** The statements a read sends, by label, with nothing else sent meanwhile. */
async function labelsOf(read: () => Promise<unknown>): Promise<string[]> {
  sent.length = 0;
  await read().catch(() => undefined);
  return sent.map(labelOf);
}

// ---- a fault in the scope: a statement between the read's own sets it (the read must refuse to go on) ----------------

/** The template the scope is read by (scope.ts readBusinessScope), its strings joined. */
const SCOPE_READ = "select current_setting($, true) as scope";

function isScopeRead(strings: unknown): boolean {
  if (!Array.isArray(strings)) {
    return false;
  }
  const pieces: unknown[] = strings;
  return pieces.every((piece) => typeof piece === "string") && pieces.join("$") === SCOPE_READ;
}

/**
 * `client` whose reserved connection, before its `nth` read of the business scope, sets the scope to `value` with a
 * statement of its own (set_config, transaction local), as something between the read's own statements could. Only
 * the client is changed; the read under test runs as it is.
 */
function shiftingScope(client: Sql, nth: number, value: string): Sql {
  let reads = 0;
  const shifted = (reserved: Sql): Sql =>
    new Proxy(reserved, {
      apply(target, thisArg, args: unknown[]): unknown {
        if (isScopeRead(args[0])) {
          reads += 1;
          if (reads === nth) {
            return (async (): Promise<unknown> => {
              await target`select set_config(${SCOPE_SETTING}, ${value}, true)`;
              const read: unknown = await Reflect.apply(target, thisArg, args);
              return read;
            })();
          }
        }
        const made: unknown = Reflect.apply(target, thisArg, args);
        return made;
      },
    });
  return new Proxy(client, {
    get(target, key, receiver): unknown {
      if (key === "reserve") {
        return async (): Promise<Sql> => shifted(await target.reserve());
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the roles the reads run as (K-05 v1.19 items 78 and 79; T-191)", () => {
  it("the two clients run as rosie_app and rosie_job, with this file's schema first and no business scope", async () => {
    for (const [client, role] of [
      [app, APP_ROLE],
      [job, JOB_ROLE],
    ] as const) {
      const [row] = await client<{ who: string; path: string; scope: string | null }[]>`
        select current_user as who, current_setting('search_path') as path,
               current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(role);
      expect(row?.path).toBe(`${db.schema}, public`);
      expect(row?.scope ?? "").toBe("");
    }
  });
});

describe("each v1.19 fixture, answered from its given (README items 78 and 79)", () => {
  it("the index lists accepted exchanges of both calls, refused requests and refused answers, and no other call", () => {
    for (const call of CALLS) {
      expect(
        ACCEPTED.some((file) => exchangeOf(file).call === call),
        call,
      ).toBe(true);
    }
    for (const file of [...ACCEPTED, ...REFUSED_REQUESTS]) {
      expect(isCall(exchangeOf(file).call), file).toBe(true);
    }
    expect(REFUSED_REQUESTS.length).toBeGreaterThan(0);
    expect(REFUSED_ANSWERS.length).toBeGreaterThan(0);
    for (const entry of REFUSED_ANSWERS) {
      expect(
        CALLS.some((call) => entry.def === `${call}.response`),
        entry.file,
      ).toBe(true);
    }
  });

  for (const file of ACCEPTED) {
    it(
      `${file}: its outcome from its given, valid at v1.19, from every side item ${file.includes("catalog") ? "78" : "79"} runs on`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const call = callOf(exchange);
        const answer = await runRead(exchange);
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(call, answer)).toEqual([]);
        expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome: answer })).toEqual([]);
        if (call === "readKindCatalog") {
          expect(await runRead(exchange, job), "rosie_job, in its own").toEqual(exchange.outcome);
          for (const scope of [null, ...(await businessesHeld())]) {
            for (const client of [app, job]) {
              expect(
                await catalogIn(client, scope, nowOf(exchange)),
                `inside a call's, under ${scope ?? "none"}`,
              ).toEqual(exchange.outcome);
            }
          }
        } else {
          expect(await runRead(exchange, db.sql), "the tables' owner").toEqual(exchange.outcome);
        }
      },
    );
  }

  it(
    "the sign-up fixtures' notes list the rows written first, as the database side writes them; without them Sam's sign-up holds no pick",
    SLOW,
    async () => {
      const note = exchangeOf(SIGN_UP_FIXTURE).given.note ?? "";
      expect(note).toContain("the database side writes these rows itself before the read");
      expect(note).toContain(
        "K-24's seed-business-kinds' three picks (pick-sam-barbershop, pick-sam-plumbing and pick-sam-electrical",
      );
      expect(note).toContain("with company_id and business_id null and version 1");
      expect(note).toContain(
        "pick-sam-barbershop's eleven text blocks as that seed holds them, each with business_id null and version 1",
      );
      for (const file of Object.keys(NOTED_ROWS).filter((name) => name !== SIGN_UP_FIXTURE)) {
        expect(exchangeOf(file).given.note ?? "", file).toContain(
          "written by the database side as that fixture's note lists them",
        );
      }
      const picks = SIGN_UP_ROWS.filter((row) => row.table === "picked_kinds");
      const texts = SIGN_UP_ROWS.filter((row) => row.table === "picked_kind_texts");
      expect(picks.map((row) => row.values.id)).toEqual([SAM_BARBERSHOP, SAM_PLUMBING, SAM_ELECTRICAL]);
      expect(texts).toHaveLength(11);
      for (const row of [...picks, ...texts]) {
        expect([row.values.business_id, row.values.version]).toEqual([null, 1]);
      }
      for (const row of picks) {
        expect(row.values.company_id).toBeNull();
      }
      const exchange = exchangeOf(SIGN_UP_FIXTURE);
      await load(seedsOf(exchange.given));
      const without = pickedOf(await runRead(exchange));
      expect([without.picks, without.companies]).toEqual([[], []]);
    },
  );
});

describe("refused requests: each refused before any statement reaches the database", () => {
  for (const file of REFUSED_REQUESTS) {
    it(`${file}: refused with a TypeError, from every side its read runs on`, SLOW, async () => {
      const exchange = exchangeOf(file);
      const request = (): never => structuredClone(exchange.request) as never;
      sent.length = 0;
      if (callOf(exchange) === "readKindCatalog") {
        for (const client of [app, job]) {
          await expect(readKindCatalog(client, request())).rejects.toThrow(TypeError);
          await expect(readKindCatalogIn(client, request())).rejects.toThrow(TypeError);
        }
      } else {
        for (const client of [job, app]) {
          await expect(readPickedKinds(client, request())).rejects.toThrow(TypeError);
        }
      }
      expect(sent).toEqual([]);
    });
  }

  it(
    "a request of any other wrong shape is refused the same way, and its error names a field, never a value",
    SLOW,
    async () => {
      const words = "Barbershop, plumbing, electrical";
      const refused: [() => Promise<unknown>, string][] = [
        [() => readKindCatalog(app, null as never), "readKindCatalog: the request is an object"],
        [() => readKindCatalog(app, [] as never), "readKindCatalog: the request is an object"],
        [() => readKindCatalog(app, { flow: "A" }), "readKindCatalog: the request names nothing"],
        [() => readKindCatalogIn(app, { words }), "readKindCatalog: the request names nothing"],
        [() => readPickedKinds(job, null as never), "readPickedKinds: the request is an object"],
        [() => readPickedKinds(job, {} as never), "readPickedKinds: the request needs businessId"],
        [
          () => readPickedKinds(job, { businessId: null } as never),
          "readPickedKinds: the request needs personId",
        ],
        [
          () => readPickedKinds(job, { businessId: null, personId: SAM, words } as never),
          "readPickedKinds: the request takes only businessId, personId",
        ],
        [() => readPickedKinds(job, { businessId: null, personId: "" }), "personId is a non-empty id"],
        [
          () => readPickedKinds(job, { businessId: null, personId: 7 } as never),
          "personId is a non-empty id",
        ],
        [() => readPickedKinds(job, { businessId: "", personId: SAM }), "businessId is a non-empty id"],
        [
          () => readPickedKinds(job, { businessId: words.repeat(5), personId: SAM }),
          "a business scope needs a non-empty business id",
        ],
        [
          () => readPickedKinds(job, { businessId: "   ", personId: SAM }),
          "a business scope needs a non-empty business id",
        ],
      ];
      sent.length = 0;
      for (const [read, message] of refused) {
        const error = await thrownBy(read());
        expect(error, message).toBeInstanceOf(TypeError);
        expect(error.message).toContain(message);
        for (const value of [words, "Barbershop", SAM]) {
          expect(error.message.includes(value), `${message}: ${value}`).toBe(false);
        }
      }
      expect(sent).toEqual([]);
    },
  );
});

describe("refused answers: the reads never answer what the schema refuses", () => {
  /** The fixture a refused answer mends into, as its index entry names it ("it is <file>'s outcome"). */
  const twinOf = (entry: IndexEntry): string => {
    const name = /it is ([a-z0-9-]+)'s outcome\)$/.exec(entry.shows ?? "")?.[1];
    if (name === undefined) {
      throw new Error(`${entry.file} names no twin`);
    }
    return `${name}.json`;
  };

  for (const entry of REFUSED_ANSWERS) {
    it(
      `${entry.file}: refused by the schema; from its twin's given the read answers the twin's outcome instead`,
      SLOW,
      async () => {
        const refusedAnswer = readJson(new URL(entry.file, ACCESS_DIR));
        expect(schemaErrors(entry.def ?? "", refusedAnswer)).not.toEqual([]);
        const twin = await given(twinOf(entry));
        expect(`${callOf(twin)}.response`).toBe(entry.def);
        const answer = await runRead(twin);
        expect(answer).toEqual(twin.outcome);
        expect(answer).not.toEqual(refusedAnswer);
        expect(schemaErrors(entry.def ?? "", answer)).toEqual([]);
      },
    );
  }
});

describe("readKindCatalog (item 78): the matcher's catalog as rosie_app, the same under every business and under none", () => {
  const SAMPLE = exchangeOf("read-kind-catalog-sample.json");

  it(
    "under each business's scope and under none, inside a call's transaction and in its own, as rosie_app and as rosie_job: the eight trade-file kinds of K-24's sample, never the drafted kind",
    SLOW,
    async () => {
      await businessesWorld();
      const expected = { ...SAMPLE.outcome, readAt: "2026-10-26T14:10:00Z" };
      for (const client of [app, job]) {
        expect(await readKindCatalog(client, {}, AT)).toEqual(expected);
        for (const scope of [null, ...BUSINESSES]) {
          expect(await catalogIn(client, scope), `under ${scope ?? "none"}`).toEqual(expected);
        }
      }
      const answer = catalogOf(await readKindCatalog(app, {}, AT));
      expect(answer.kinds.map((kind) => kind.id)).not.toContain(DRAFTED_KIND);
      expect(answer.kinds.map((kind) => kind.id)).toEqual(byBytes(answer.kinds.map((kind) => kind.id)));
    },
  );

  it(
    "a drafted kind is never answered, whatever its draft's state (approved included) and even with a style of its own (K-24 README line 96)",
    SLOW,
    async () => {
      await businessesWorld();
      const trade = (SAMPLE.outcome.kinds as { id: string }[]).map((kind) => kind.id);
      await db.sql`update kinds set style = 'Set service', version = version + 1 where id = ${DRAFTED_KIND}`;
      for (const state of ["drafting", "in_review", "approved", "kept_offline"]) {
        await db.sql`update new_work_drafts set state = ${state}, version = version + 1 where id = ${DRAFT}`;
        // Each read starts only once the one before it has ended: one at a time, none left unawaited.
        for (const read of [() => readKindCatalog(app, {}, AT), () => catalogIn(app, PET_BOARDING)]) {
          const answer = catalogOf(await read());
          expect(
            answer.kinds.map((kind) => kind.id),
            state,
          ).toEqual(trade);
          expect(answerErrors("readKindCatalog", answer), state).toEqual([]);
        }
      }
    },
  );

  it(
    "inside a call's transaction it refuses one that is not one moment's (read committed, as withBusiness begins one; one that may write; a pooled handle), before any table is read; serializable read only answers",
    SLOW,
    async () => {
      await businessesWorld();
      sent.length = 0;
      const readCommitted = await thrownBy(
        withBusiness(app, BARBERSHOP, (tx) => readKindCatalogIn(tx, {}), { readOnly: true }),
      );
      const mayWrite = await thrownBy(catalogIn(app, BARBERSHOP, AT, "isolation level repeatable read"));
      const pooled = await thrownBy(readKindCatalogIn(app, {}));
      for (const error of [readCommitted, mayWrite, pooled]) {
        expect(error.message).toContain(
          "readKindCatalog runs in one read-only transaction at repeatable read",
        );
      }
      expect(sent.some((statement) => tablesOf(statement.query).length > 0)).toBe(false);
      const serializable = await catalogIn(app, null, AT, "isolation level serializable read only");
      expect(answerErrors("readKindCatalog", serializable)).toEqual([]);
    },
  );

  it(
    "in its own transaction it sends one begin of a repeatable read, read-only transaction, confirms it, reads kinds once and commits, with no business scope set",
    SLOW,
    async () => {
      await businessesWorld();
      expect(await labelsOf(() => readKindCatalog(app, {}, AT))).toEqual([
        "probe",
        "begin",
        "clear the scope",
        "one moment",
        "kinds",
        "commit",
      ]);
    },
  );

  it(
    "an empty kinds.style throws, naming the call, the table and the column, never the value or the row; a style of spaces is carried as stored",
    SLOW,
    async () => {
      await businessesWorld();
      await db.sql`update kinds set style = '', version = version + 1 where id = 'barber'`;
      // Each read starts only once the one before it has ended, so no refusal is left unawaited.
      for (const read of [() => readKindCatalog(app, {}, AT), () => catalogIn(app, BARBERSHOP)]) {
        const error = await thrownBy(read());
        expect(error.message).toBe(
          "readKindCatalog: kinds.style holds an empty style, which the answer cannot carry",
        );
      }
      await db.sql`update kinds set style = '  ', version = version + 1 where id = 'barber'`;
      const answer = catalogOf(await readKindCatalog(app, {}, AT));
      expect(answerErrors("readKindCatalog", answer)).toEqual([]);
      expect(answer.kinds.find((kind) => kind.id === "barber")).toEqual({
        id: "barber",
        name: "Barber",
        style: "  ",
        pattern: "chair",
        source: "trade_file",
        version: 3,
      });
    },
  );
});

describe("readPickedKinds (item 79): a business's rows under its scope, a person's with no business on the runtime side", () => {
  it(
    "under each business, every other business's picks, texts, drafts and blocks and companies are never answered: each answer exactly what the rule reaches, as rosie_job and as the tables' owner",
    SLOW,
    async () => {
      await businessesWorld();
      for (const businessId of [null, ...BUSINESSES]) {
        for (const personId of [SAM, ALEX]) {
          await expectReached(businessId, personId);
        }
      }
      const barbershop = await expectReached(BARBERSHOP, SAM);
      expect(answeredNames(barbershop).picks).toEqual([SAM_BARBERSHOP]);
      expect(barbershop.picks[0]?.texts).toHaveLength(11);
      expect(barbershop.companies.map((company) => company.id)).toEqual([LEES_COMPANY]);
      for (const theirs of [SAM_PLUMBING, SAM_ELECTRICAL, PACK_HIKES, DRAFT, `${DRAFT}/4`, HOME_COMPANY]) {
        expect(allNames(barbershop), theirs).not.toContain(theirs);
      }
      expect(allNames(barbershop).some((name) => name.startsWith(`${SAM_PLUMBING}/`))).toBe(false);
      const homeServices = await expectReached(HOME_SERVICES, SAM);
      expect(answeredNames(homeServices).picks).toEqual([SAM_PLUMBING, SAM_ELECTRICAL]);
      expect(answeredNames(homeServices).texts).toHaveLength(11);
      expect(answeredNames(homeServices).companies).toEqual([HOME_COMPANY]);
      const petBoarding = await expectReached(PET_BOARDING, SAM);
      expect(answeredNames(petBoarding)).toEqual({
        picks: [PACK_HIKES],
        texts: [],
        drafts: [DRAFT],
        blocks: byBytes([3, 4, 6, 8, 12, 14].map((block) => `${DRAFT}/${String(block)}`)),
        companies: [],
      });
      for (const none of [YOGA, MOVERS, null]) {
        const empty = await expectReached(none, SAM);
        expect([empty.picks, empty.companies]).toEqual([[], []]);
      }
    },
  );

  it(
    "a person's rows with no business are answered to that person alone, another person's never, under no business and under one: picks, texts, drafts, blocks and companies",
    SLOW,
    async () => {
      await signUpWorld();
      for (const businessId of [null, BARBERSHOP, YOGA]) {
        for (const personId of [SAM, ALEX, RILEY]) {
          await expectReached(businessId, personId);
        }
      }
      const sam = await expectReached(null, SAM);
      expect(answeredNames(sam)).toEqual({
        picks: [SAM_BARBERSHOP, SAM_PLUMBING, SAM_ELECTRICAL, PACK_HIKES],
        texts: byBytes(
          SIGN_UP_ROWS.filter((row) => row.table === "picked_kind_texts").map(
            (row) => `${SAM_BARBERSHOP}/${textOf(row.values.pf_key)}`,
          ),
        ),
        drafts: [DRAFT],
        blocks: byBytes([3, 4, 6, 8, 12, 14].map((block) => `${DRAFT}/${String(block)}`)),
        companies: [LEES_COMPANY],
      });
      const alex = await expectReached(null, ALEX);
      expect(answeredNames(alex).picks).toEqual([
        "pick-alex-barbershop",
        "pick-alex-plumbing",
        "pick-alex-electrical",
        "pick-alex-pack-hikes",
      ]);
      expect(answeredNames(alex).companies).toEqual([ALEX_COMPANY]);
      expect(
        allNames(alex).some((name) => name.includes("-sam-") || name === DRAFT || name === LEES_COMPANY),
      ).toBe(false);
      expect(allNames(sam).some((name) => name.includes("-alex-"))).toBe(false);
      const riley = await expectReached(BARBERSHOP, RILEY);
      expect([riley.picks, riley.companies]).toEqual([[], []]);
    },
  );

  it(
    "a pick placed in a company with no business yet (S1-04 before S1-09) is answered with its company, to its person alone",
    SLOW,
    async () => {
      await signUpWorld();
      for (const businessId of [null, BARBERSHOP]) {
        const sam = await expectReached(businessId, SAM);
        const barbershop = sam.picks.find((pick) => pick.id === SAM_BARBERSHOP);
        expect([barbershop?.companyId, barbershop?.businessId, barbershop?.version]).toEqual([
          LEES_COMPANY,
          null,
          2,
        ]);
        expect(sam.companies).toEqual([
          {
            id: LEES_COMPANY,
            ownerPersonId: SAM,
            name: "Lee's Barbershop LLC",
            businessId: null,
            version: 2,
          },
        ]);
        const alex = await expectReached(businessId, ALEX);
        expect(allNames(alex)).not.toContain(LEES_COMPANY);
      }
    },
  );

  it(
    "a business's pick whose text, draft or block still has no business is answered without that row, which is answered nowhere: neither under its business nor with any person's rows",
    SLOW,
    async () => {
      const cases: [string, () => Promise<unknown>, string, string][] = [
        [
          "a text block",
          () => db.sql`
            update picked_kind_texts set business_id = null, version = version + 1
            where picked_kind_id = ${SAM_BARBERSHOP} and pf_key = 'pf.rules'
          `,
          `${SAM_BARBERSHOP}/pf.rules`,
          BARBERSHOP,
        ],
        [
          "a draft block",
          () => db.sql`
            update new_work_draft_blocks set business_id = null, version = version + 1
            where draft_id = ${DRAFT} and block = 4
          `,
          `${DRAFT}/4`,
          PET_BOARDING,
        ],
        [
          "a draft, with its blocks",
          async () => {
            await db.sql`
              update new_work_draft_blocks set business_id = null, version = version + 1 where draft_id = ${DRAFT}
            `;
            await db.sql`update new_work_drafts set business_id = null, version = version + 1 where id = ${DRAFT}`;
          },
          DRAFT,
          PET_BOARDING,
        ],
      ];
      for (const [what, fault, name, businessOfPick] of cases) {
        await businessesWorld();
        await fault();
        for (const businessId of [null, ...BUSINESSES]) {
          for (const personId of [SAM, ALEX]) {
            const answer = await expectReached(businessId, personId);
            expect(allNames(answer), `${what} under ${businessId ?? "none"} for ${personId}`).not.toContain(
              name,
            );
          }
        }
        const under = await expectReached(businessOfPick, SAM);
        expect(under.picks.length, what).toBe(1);
        if (what === "a text block") {
          expect(under.picks[0]?.texts).toHaveLength(10);
        } else if (what === "a draft block") {
          expect(under.picks[0]?.draft?.blocks.map((block) => block.block)).toEqual([3, 6, 8, 12, 14]);
        } else {
          expect(under.picks[0]?.draft).toBeNull();
        }
      }
    },
  );

  it(
    "the business's picks and the person's are merged as the database orders them: picked_at to the microsecond, then position, then the id byte by byte",
    SLOW,
    async () => {
      const merged = async (): Promise<string[]> => {
        const answer = await expectReached(PET_BOARDING, SAM);
        return answeredNames(answer).picks;
      };
      await load([SEED.personRoles, SEED.kindsSample, SEED.newWorkDraft], SIGN_UP_ROWS);
      expect(await merged()).toEqual([SAM_BARBERSHOP, SAM_PLUMBING, SAM_ELECTRICAL, PACK_HIKES]);
      // A microsecond after the sign-up's picks: last, where milliseconds alone would tie it and place it by position.
      await db.sql`
        update picked_kinds set picked_at = '2026-10-19T18:05:00.000001Z', version = version + 1 where id = ${PACK_HIKES}
      `;
      expect(await merged()).toEqual([SAM_BARBERSHOP, SAM_PLUMBING, SAM_ELECTRICAL, PACK_HIKES]);
      const [moved] = await db.sql<{ ms: string; us: string }[]>`
        select to_char(picked_at at time zone 'UTC', 'HH24:MI:SS.MS') as ms,
               to_char(picked_at at time zone 'UTC', 'HH24:MI:SS.US') as us
        from picked_kinds where id = ${PACK_HIKES}
      `;
      expect(moved).toEqual({ ms: "18:05:00.000", us: "18:05:00.000001" });
      // The same instant as theirs at position 2: before plumbing, by the id's bytes.
      await db.sql`
        update picked_kinds set picked_at = '2026-10-19T18:05:00Z', position = 2, version = version + 1
        where id = ${PACK_HIKES}
      `;
      expect(await merged()).toEqual([SAM_BARBERSHOP, PACK_HIKES, SAM_PLUMBING, SAM_ELECTRICAL]);
      // Two picks at one instant and position, one in each part, whose ids JavaScript's own order and the bytes' differ on.
      const electrical = seedRowOf(SEED.businessKinds, "picked_kinds", { id: SAM_ELECTRICAL });
      const fi = `${SAM_ELECTRICAL}-ﬁ`;
      const hwair = `${SAM_ELECTRICAL}-\u{10348}`;
      await loadSeeds(
        [],
        [
          withValues(electrical, {
            id: fi,
            position: 4,
            company_id: null,
            business_id: PET_BOARDING,
            version: 1,
          }),
          withValues(electrical, { id: hwair, position: 4, company_id: null, business_id: null, version: 1 }),
        ],
      );
      expect([fi, hwair].sort()).toEqual([hwair, fi]);
      expect(byBytes([hwair, fi])).toEqual([fi, hwair]);
      expect(await merged()).toEqual([SAM_BARBERSHOP, PACK_HIKES, SAM_PLUMBING, SAM_ELECTRICAL, fi, hwair]);
    },
  );

  it("the business's companies and the person's are merged in id order, byte by byte", SLOW, async () => {
    await businessesWorld();
    const second = `${HOME_COMPANY}-2`;
    await loadSeeds([], [withValues(HOME_COMPANY_ROW, { id: second, business_id: null })]);
    expect(answeredNames(await expectReached(BARBERSHOP, SAM)).companies).toEqual([second, LEES_COMPANY]);
    expect(answeredNames(await expectReached(HOME_SERVICES, SAM)).companies).toEqual([HOME_COMPANY, second]);
    expect(answeredNames(await expectReached(BARBERSHOP, ALEX)).companies).toEqual([LEES_COMPANY]);
  });

  it(
    "the person is found first, then the business: notFound for the first missing, nothing read beyond it",
    SLOW,
    async () => {
      await load([]);
      for (const businessId of [null, BARBERSHOP]) {
        expect(await picked(job, businessId, SAM)).toEqual({
          error: "notFound",
          table: "persons",
          rowId: SAM,
        });
        const labels = await labelsOf(() => picked(job, businessId, SAM));
        expect(labels.slice(labels.indexOf("persons"))).toEqual(["persons", "commit"]);
      }
      await load([SEED.personRoles]);
      expect(await picked(job, PET_BOARDING, SAM)).toEqual({
        error: "notFound",
        table: "businesses",
        rowId: PET_BOARDING,
      });
      const labels = await labelsOf(() => picked(job, PET_BOARDING, SAM));
      expect(labels.slice(labels.indexOf("persons"))).toEqual([
        "persons",
        `scope ${PET_BOARDING}`,
        "read the scope",
        "businesses",
        "read the scope",
        "commit",
      ]);
    },
  );

  it(
    "an empty companies.name throws, of the business's part and of the person's, naming the call, the table and the column, never the value or the row; a name of spaces is carried as stored",
    SLOW,
    async () => {
      const message = "readPickedKinds: companies.name holds an empty name, which the answer cannot carry";
      await businessesWorld();
      await db.sql`update companies set name = '', version = version + 1 where id = ${LEES_COMPANY}`;
      expect((await thrownBy(picked(job, BARBERSHOP, SAM))).message).toBe(message);
      expect(pickedOf(await picked(job, HOME_SERVICES, SAM)).companies).toHaveLength(1);
      await signUpWorld();
      await db.sql`update companies set name = '', version = version + 1 where id = ${LEES_COMPANY}`;
      expect((await thrownBy(picked(job, null, SAM))).message).toBe(message);
      expect((await thrownBy(picked(job, YOGA, SAM))).message).toBe(message);
      expect(pickedOf(await picked(job, null, ALEX)).companies).toHaveLength(1);
      await db.sql`update companies set name = '  ', version = version + 1 where id = ${LEES_COMPANY}`;
      const answer = await expectReached(null, SAM);
      expect(answer.companies.map((company) => company.name)).toEqual(["  "]);
    },
  );

  it(
    "a draft block's facts or switches with a NULL element, or an element that is no plug-in name, throw, never an invalid answer",
    SLOW,
    async () => {
      const faults: [string, string][] = [
        ["facts_on = array['forms', null]::text[]", "new_work_draft_blocks.facts_on holds a NULL element"],
        [
          "facts_on = array['']::text[]",
          "new_work_draft_blocks.facts_on holds an element that is not a plug-in name",
        ],
        ["switches_on = array[null]::text[]", "new_work_draft_blocks.switches_on holds a NULL element"],
      ];
      for (const [set, holds] of faults) {
        await businessesWorld();
        await db.sql.unsafe(
          `update new_work_draft_blocks set ${set}, version = version + 1 where draft_id = $1 and block = 4`,
          [DRAFT],
        );
        const error = await thrownBy(picked(job, PET_BOARDING, SAM));
        expect(error.message).toBe(`readPickedKinds: ${holds}, which the answer cannot carry`);
      }
    },
  );
});

describe("readPickedKinds (item 79): one moment as rosie_job, its scope set and compared, then cleared, in item 79's order", () => {
  it(
    "with a business: the side checked, persons first, the scope set and compared before businesses and the business's five statements, compared again, then cleared and confirmed empty before the person's five, in one read-only transaction at repeatable read",
    SLOW,
    async () => {
      await businessesWorld();
      expect(await labelsOf(() => picked(job, BARBERSHOP, SAM))).toEqual([
        "probe",
        "begin",
        "clear the scope",
        "the role",
        "read the scope",
        "persons",
        `scope ${BARBERSHOP}`,
        "read the scope",
        "businesses",
        ...partOf("the business's"),
        "read the scope",
        "clear the scope",
        "read the scope",
        ...partOf("the person's"),
        "commit",
      ]);
      expect(await labelsOf(() => readPickedKinds(job, { businessId: BARBERSHOP, personId: SAM }))).toEqual([
        "probe",
        "begin",
        "clear the scope",
        "the role",
        "read the scope",
        "persons",
        `scope ${BARBERSHOP}`,
        "read the scope",
        "businesses",
        ...partOf("the business's"),
        "read the scope",
        "clear the scope",
        "read the scope",
        ...partOf("the person's"),
        "now",
        "commit",
      ]);
    },
  );

  it(
    "with businessId null: the side checked and the scope confirmed empty before persons and the person's five statements; no scope is ever set",
    SLOW,
    async () => {
      await signUpWorld();
      expect(await labelsOf(() => picked(job, null, SAM))).toEqual([
        "probe",
        "begin",
        "clear the scope",
        "the role",
        "read the scope",
        "persons",
        ...partOf("the person's"),
        "commit",
      ]);
    },
  );

  it(
    "the business's part must end under the scope it set, compared with the request's business: a scope moved to another business, or emptied, before any read or at the part's end, is refused, as is a scope set again before the person's rows; nothing is answered",
    SLOW,
    async () => {
      await businessesWorld();
      const cases: [string, string | null, number, string, string, string][] = [
        ["moved before businesses", BARBERSHOP, 2, YOGA, "BusinessScopeError", "businesses"],
        ["moved at the part's end", BARBERSHOP, 3, YOGA, "BusinessScopeError", "picked_kinds, the person's"],
        ["emptied at the part's end", BARBERSHOP, 3, "", "BusinessScopeError", "picked_kinds, the person's"],
        [
          "set again before the person's rows",
          BARBERSHOP,
          4,
          BARBERSHOP,
          "Error",
          "picked_kinds, the person's",
        ],
        ["set before persons with no business", null, 1, BARBERSHOP, "Error", "persons"],
      ];
      for (const [what, businessId, nth, value, name, neverSent] of cases) {
        const client = shiftingScope(job, nth, value);
        sent.length = 0;
        const error = await thrownBy(readPickedKinds(client, { businessId, personId: SAM }, AT));
        expect(error.name, what).toBe(name);
        if (name === "Error") {
          expect(error.message, what).toContain(
            "readPickedKinds runs on the runtime side, with no business scope",
          );
        } else {
          expect(error, what).toBeInstanceOf(BusinessScopeError);
        }
        const labels = sent.map(labelOf);
        expect(labels, what).not.toContain(neverSent);
        expect(labels.at(-1), what).toBe("rollback");
      }
      const moved = await thrownBy(
        readPickedKinds(shiftingScope(job, 3, YOGA), { businessId: BARBERSHOP, personId: SAM }, AT),
      );
      expect(moved.message).toBe(
        "readPickedKinds must end the business's part under the request's own business scope",
      );
    },
  );

  it(
    "a role that holds rosie_app's rights and not rosie_job's is refused before any table is read; the tables' owner, which holds neither until T-1093, runs",
    SLOW,
    async () => {
      await businessesWorld();
      for (const businessId of [null, BARBERSHOP]) {
        sent.length = 0;
        const error = await thrownBy(picked(app, businessId, SAM));
        expect(error).toBeInstanceOf(BusinessScopeError);
        expect(error.message).toContain("readPickedKinds runs as rosie_job");
        expect(sent.some((statement) => tablesOf(statement.query).length > 0)).toBe(false);
        expect(pickedOf(await picked(db.sql, businessId, SAM))).toEqual(
          pickedOf(await picked(job, businessId, SAM)),
        );
      }
    },
  );

  it("with no clock given, readAt is the database's now, in UTC, for both reads", SLOW, async () => {
    await businessesWorld();
    const before = Date.now();
    const catalog = catalogOf(await readKindCatalog(app, {}));
    const kinds = pickedOf(await readPickedKinds(job, { businessId: BARBERSHOP, personId: SAM }));
    for (const readAt of [catalog.readAt, kinds.readAt]) {
      expect(Math.abs(Date.parse(readAt) - before)).toBeLessThan(60_000);
      expect(readAt.endsWith("Z")).toBe(true);
    }
  });

  it(
    "a client that cannot reach the database is answered transient, never thrown (K-05: every call can answer transient)",
    SLOW,
    async () => {
      const closed = createServer();
      closed.listen(0, "127.0.0.1");
      await once(closed, "listening");
      const { port } = closed.address() as AddressInfo;
      closed.close();
      await once(closed, "close");
      const url = new URL(resolvePrimaryUrl());
      url.hostname = "127.0.0.1";
      url.port = String(port);
      const unreachable = postgres(url.href, { max: 1, connect_timeout: 2, onnotice: () => undefined });
      try {
        const transient = { error: "transient", sqlstate: "08001" };
        expect(await readKindCatalog(unreachable, {})).toEqual(transient);
        expect(await readPickedKinds(unreachable, { businessId: null, personId: SAM })).toEqual(transient);
        expect(await readPickedKinds(unreachable, { businessId: BARBERSHOP, personId: SAM })).toEqual(
          transient,
        );
      } finally {
        await unreachable.end({ timeout: 1 });
      }
    },
  );
});

// ---- the statements' column lists and rules (README :1238) --------------------------------------------------------------

describe("every statement the two reads send names its item's columns and no other, and each of item 79's carries its rule (README :1238)", () => {
  /** One read as recorded: its call, its request and the statements it sent that read a table. */
  interface Run {
    call: Call;
    request: { businessId: string | null; personId: string };
    statements: Sent[];
  }

  it("the checks find each fault on statements made to fail, and pass statements shaped as the reads' own", () => {
    const request = { businessId: BARBERSHOP, personId: SAM };
    const caught: [string, Call, string][] = [
      ["select * from kinds where source = 'trade_file'", "readKindCatalog", "*"],
      ["select k.* from kinds k where k.source = 'trade_file'", "readKindCatalog", "*"],
      ["select id, name, facts from kinds", "readKindCatalog", "a name never named: facts"],
      ["select id, name, facts from kinds", "readKindCatalog", "a column beyond its list: kinds.facts"],
      ["select to_json(k) from kinds k", "readKindCatalog", "a whole row: k"],
      [
        "select k.id from kinds k join kind_flows f on f.kind_id = k.id",
        "readKindCatalog",
        "a table beyond its own: kind_flows",
      ],
      [
        "select t.picked_kind_id, t.block from picked_kind_texts t join picked_kinds p on p.id = t.picked_kind_id where p.business_id = $1 and t.business_id = $2",
        "readPickedKinds",
        "a column beyond its list: picked_kind_texts.block",
      ],
      [
        "select b.block, b.answer from new_work_draft_blocks b join new_work_drafts d on d.id = b.draft_id join picked_kinds p on p.id = d.picked_kind_id where p.business_id = $1 and d.business_id = $2 and b.business_id = $3",
        "readPickedKinds",
        "a column beyond its list: new_work_draft_blocks.answer",
      ],
      [
        "select p.id, position from picked_kinds p join companies c on c.id = p.company_id where p.business_id = $1 and c.business_id = $2",
        "readPickedKinds",
        "an unqualified column in a join: position",
      ],
      [
        "select p.id, h.address from picked_kinds p join handles h on h.id = p.owner_person_id where p.business_id = $1",
        "readPickedKinds",
        "a table beyond its own: handles",
      ],
      [
        "select id, name from persons where id = $1",
        "readPickedKinds",
        "a column beyond its list: persons.name",
      ],
    ];
    for (const [statement, call, problem] of caught) {
      expect(problemsOf(statement, call), statement).toContain(problem);
    }
    const ruled: [Sent, string][] = [
      [
        {
          query: "select t.picked_kind_id, t.pf_key from picked_kind_texts t where t.business_id is null",
          parameters: [],
        },
        "a text not joined to its pick",
      ],
      [
        {
          query: "select t.picked_kind_id, t.pf_key from picked_kind_texts t where t.business_id is null",
          parameters: [],
        },
        "not owner_person_id = the request's person on the pick or the company",
      ],
      [
        {
          query:
            "select t.picked_kind_id from picked_kind_texts t join picked_kinds p on p.id = t.picked_kind_id where p.business_id = $1 and t.business_id = $2",
          parameters: [BARBERSHOP, HOME_SERVICES],
        },
        "picked_kind_texts: not t.business_id = the request's business",
      ],
      [
        {
          query: "select p.id from picked_kinds p where p.business_id = $1 or p.business_id is null",
          parameters: [BARBERSHOP],
        },
        "an or",
      ],
      [
        {
          query:
            "select d.id from new_work_drafts d join picked_kinds p on p.id = d.picked_kind_id where p.business_id is null and p.owner_person_id = $1 and d.business_id = $2",
          parameters: [ALEX, BARBERSHOP],
        },
        "not owner_person_id = the request's person on the pick or the company",
      ],
      [
        { query: "select id from persons where id = $1", parameters: [ALEX] },
        "persons read other than by the request's person",
      ],
    ];
    for (const [statement, problem] of ruled) {
      expect(ruleProblemsOf(statement, request), statement.query).toContain(problem);
    }
    const clean: Sent[] = [
      { query: "select id from businesses where id = $1", parameters: [BARBERSHOP] },
      {
        query:
          "select p.id, (extract(epoch from p.picked_at) * 1000000)::bigint::text as picked_at_us from picked_kinds p where p.business_id = $1",
        parameters: [BARBERSHOP],
      },
      {
        query:
          'select ("t"."picked_kind_id"::text || \'/\' || "t"."pf_key"::text) as row_id, t.picked_kind_id from picked_kind_texts t join picked_kinds p on p.id = t.picked_kind_id where p.business_id is null and p.owner_person_id = $1 and t.business_id is null',
        parameters: [SAM],
      },
    ];
    for (const statement of clean) {
      expect(problemsOf(statement.query, "readPickedKinds"), statement.query).toEqual([]);
      expect(ruleProblemsOf(statement, request), statement.query).toEqual([]);
    }
  });

  it(
    "over every fixture and every business and person of the worlds, each read names exactly its tables and its columns, never *, a whole row or a column beyond its list; each of item 79's statements carries its rule bound to the request's own business or person; item 77's names are built in SQL",
    SLOW,
    async () => {
      const runs: Run[] = [];
      const watch = async (
        call: Call,
        request: Run["request"],
        read: () => Promise<unknown>,
      ): Promise<void> => {
        sent.length = 0;
        await read();
        runs.push({
          call,
          request,
          statements: sent.filter((statement) => tablesOf(statement.query).length > 0),
        });
      };
      for (const file of ACCEPTED) {
        const exchange = await given(file);
        const request = {
          businessId: (exchange.request.businessId ?? null) as string | null,
          personId: (exchange.request.personId ?? "") as string,
        };
        await watch(callOf(exchange), request, () => runRead(exchange));
      }
      for (const world of [businessesWorld, signUpWorld]) {
        await world();
        for (const businessId of [null, ...BUSINESSES]) {
          for (const personId of [SAM, ALEX]) {
            await watch("readPickedKinds", { businessId, personId }, () => picked(job, businessId, personId));
          }
          await watch("readKindCatalog", { businessId: null, personId: "" }, () =>
            catalogIn(app, businessId),
          );
        }
      }
      for (const call of CALLS) {
        const statements = runs.filter((run) => run.call === call).flatMap((run) => run.statements);
        expect(statements.length, call).toBeGreaterThan(0);
        const tables = new Set(statements.flatMap((statement) => tablesOf(statement.query)));
        expect([...tables].sort(), call).toEqual([...TABLES_OF[call]].sort());
        const columns = new Set(statements.flatMap((statement) => columnsOf(statement.query)));
        const listed = TABLES_OF[call].flatMap((table) =>
          (COLUMNS_OF[table] ?? []).map((column) => `${table}.${column}`),
        );
        expect([...columns].sort(), call).toEqual([...listed].sort());
        for (const statement of statements) {
          expect(problemsOf(statement.query, call), `${call}: ${statement.query}`).toEqual([]);
        }
      }
      for (const run of runs.filter((each) => each.call === "readPickedKinds")) {
        for (const statement of run.statements) {
          expect(
            ruleProblemsOf(statement, run.request),
            `${JSON.stringify(run.request)}: ${statement.query}`,
          ).toEqual([]);
        }
      }
      const lines = runs.flatMap((run) => run.statements).map((statement) => lineOf(statement.query));
      for (const name of [
        `("t"."picked_kind_id"::text || '/' || "t"."pf_key"::text) as row_id`,
        `("b"."draft_id"::text || '/' || "b"."block"::text) as row_id`,
      ]) {
        expect(
          lines.some((line) => line.includes(name)),
          name,
        ).toBe(true);
      }
      for (const line of lines) {
        expect(line.includes("picked_kind_texts") && !line.includes("as row_id"), line).toBe(false);
      }
    },
  );
});
