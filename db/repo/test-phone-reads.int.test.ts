// T-1300: K-05 v1.12's readTesterStanding, readRosterPhone and readPhoneState (items 53, 54 and 55), staging's test-phone
// page's three reads, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/test-phone-reads`).
// The schema comes from migrating a fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the
// public schema is never touched.
//
// The reads run as K-05 v1.12 names them (README "Where each read lives"): through a client whose connections run as
// rosie_job, the runtime side's role, with no business scope, so the grants and row-level security are the ones the reads
// meet; the role is the connection's. The tables' owner (the migrations' role) loads the seeds a fixture's `given` names
// (K-04's, and K-22's and K-29's by `partSeeds`), writes the rows a fixture's note lists and a case adds, and for a
// fixture whose `after` chain commits Alex's STOP or START writes the phone row each commit of the chain states, as its
// note names it: no other step of those chains (a saved time, a plan, a claim, the booking's commit) writes a row these
// reads read. Every answer is checked against its data-access v1.12 definition with Ajv 2020-12, strict, as
// contracts:check runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its parameters,
// kept in memory for the checks and never printed), so the checks read what the reads sent, not a copy of their SQL: one
// read-only transaction per read; each item's reads in its order and as written, so only the columns its consumers line
// lists; the token's hash bound as session_for_token's first argument and nowhere else; no number, email or hash in a
// statement's text; and no statement naming token_sha256, device_sha256 or code_hash, the sessions table, or a column of
// sealing_keys, messages, consents or proof_codes.
//
// Names are the master's sample cast and fixture set v1's demo shops as K-04's, K-22's and K-29's seeds hold them (rule
// 9), and the check tester as default 105 and its fixture's note describe it. The people, handles, team rows, sessions,
// codes and chat links a case adds carry example ids (t1300), no name, example.com addresses and numbers in the fiction
// range 555-0100 to 555-0199; every hash is a stand-in, the sha256 of no token and no code.
//
// T-1402 (DL-757) adds K-05 v1.15's item 68, readTesterStanding widened to K-22 v1.3's staging_testers (migration
// 0036): v1.15's two exchanges, run after K-22 v1.3's seed-staging-tester.json (Tester One listed, Tester Two whose
// listing ended), and their two refused twins; the cases v1.15's "What the new tasks must hold to" lists (a person who
// holds both rows, an ended listing beside a live team row, a listing ended a second before `at`, a person with an
// ended listing and a later live one), with its two mirrors; step 2 as one statement over both lists; and every answer
// also checked against its v1.15 definition. The listings a case adds carry example ids (t1402); the testers, their
// ids, addresses and times are K-22 v1.3's examples, never a tester's real address or name.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql, Tx } from "./scope";
import { utc, utcOrNull } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";
import {
  readPhoneState,
  type ReadPhoneStateRequest,
  readRosterPhone,
  type ReadRosterPhoneRequest,
  readTesterStanding,
  type ReadTesterStandingRequest,
} from "./test-phone-reads";
import { BrokenRecordError } from "./turn-face-reads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
type Call = "readTesterStanding" | "readRosterPhone" | "readPhoneState";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("core/fixtures/", SCHEMA_DIR);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 240_000 };

const STANDING = "readTesterStanding" satisfies Call;
const ROSTER_PHONE = "readRosterPhone" satisfies Call;
const PHONE_STATE = "readPhoneState" satisfies Call;
const CALLS: readonly Call[] = [STANDING, ROSTER_PHONE, PHONE_STATE];

/** Each read through its db/repo call, the request handed on as given (a refused one too). */
const READS: Readonly<Record<Call, (sql: Sql, request: unknown) => Promise<unknown>>> = {
  readTesterStanding: (sql, request) => readTesterStanding(sql, request as ReadTesterStandingRequest),
  readRosterPhone: (sql, request) => readRosterPhone(sql, request as ReadRosterPhoneRequest),
  readPhoneState: (sql, request) => readPhoneState(sql, request as ReadPhoneStateRequest),
};

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const SAM = "person-sam";
const SAM_HANDLE = "handle-sam";
const SAM_NUMBER = "+15555550100";
/** Sam's two sessions in K-22's seed-session.json: the live one of Oct 26 and the one he signed out of on Oct 20. */
const SAM_LIVE_TOKEN = "bcc9e6bc57d87c2e4bce0e6261d51dfa66d346abf24ef81de1bb8a4acd286127";
const SAM_SIGNED_OUT_TOKEN = "55c887c6a012afe4a89a3c2a798ec32f65a8e1a76d7acaf6338dd6dbcabc4267";
const SAM_READ_AT = "2026-10-26T09:00:00Z";
const ALEX_HANDLE = "handle-alex";
const ALEX_NUMBER = "+15555550101";
const AVERY_NUMBER = "+15555550103";
const BEN_NUMBER = "+15555550106";
const PAT = "person-pat";
const PAT_NUMBER = "+15555550107";

/** The check tester (README default 105), as read-tester-standing-check-tester's note lists its rows. */
const CHECK_TESTER = "person-check-tester";
const CHECK_TESTER_HANDLE = "handle-check-tester-email";
const CHECK_TESTER_EMAIL = "check-tester@example.com";
const CHECK_TESTER_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CHECK_TESTER_CODE_HASH = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SEEDED_AT = "2026-11-12T04:00:00Z";
const READ_AT = "2026-11-12T04:05:00Z";
const ONE_SECOND_AFTER = "2026-11-12T04:05:01Z";
/** A second session of the check tester's person, which a case adds, and the hash of no code for its proof code. */
const SECOND_TOKEN = "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";
const SECOND_CODE_HASH = "1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f";
/** A hash no session holds. */
const UNKNOWN_TOKEN = "d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3";
/**
 * K-22 v1.3's two human testers (seed-staging-tester.json): Tester One, listed since 05:30Z, and Tester Two, whose
 * listing ended at 07:00Z, each with a live session from a code to their own inbox, live until Dec 14. Stand-in hashes.
 */
const TESTER_ONE = "person-tester-one";
const TESTER_TWO = "person-tester-two";
const TESTER_TWO_TOKEN = "6a1f2e3d4c5b6a7f8e9dacbfc4d5e6f7a8b9cadb4c5d6e7f8a9bacbdc4d5e6f8";
const TESTER_TWO_ENDED = "2026-11-14T07:00:00Z";
const TESTERS_READ_AT = "2026-11-14T08:00:00Z";

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
  request: Row;
  outcome: Row;
}

interface TableRow {
  table: string;
  values: Row;
}

interface SeedFile {
  after: string[];
  rows: TableRow[];
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** The call a definition belongs to, when it is one of the three. */
const callOfDef = (def: string | undefined): Call | undefined =>
  CALLS.find((call) => (def ?? "").startsWith(`${call}.`));
/** Items 53 to 55's accepted exchanges, and item 68's (v1.15), as the index lists them, each with its call and version. */
const ACCEPTED: readonly { file: string; call: Call; version: string }[] = INDEX.flatMap((entry) => {
  const call = callOfDef(entry.def);
  return entry.expect === "accept" && call !== undefined && entry.def === `${call}.exchange`
    ? [{ file: entry.file, call, version: entry.version }]
    : [];
});
/** Their refused twins, each refused by one of the three reads' definitions. */
const REFUSED = INDEX.filter((entry) => entry.expect === "refuse" && callOfDef(entry.def) !== undefined);
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** A value of a fixture's request as text: a broken test when it is not. */
function textOf(value: Json | undefined, what: string): string {
  if (typeof value !== "string") {
    throw new Error(`${what} is not text`);
  }
  return value;
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
const V112_ID = (readJson(new URL("data-access/data-access.v1.12.schema.json", CONTRACTS)) as { $id: string })
  .$id;
/** K-05 v1.15 (T-1295), which restates item 68's request and response for their text alone (README item 68). */
const V115_ID = (readJson(new URL("data-access/data-access.v1.15.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/**
 * Checks `value` against one $defs entry of data-access v1.12 (or of the version `schemaId` names), returning Ajv's
 * errors (none when it passes).
 */
function schemaErrors(def: string, value: unknown, schemaId = V112_ID): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${schemaId} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/**
 * An answer checked against its own definition, in v1.12 and in v1.15: an error against <call>.errors, else
 * <call>.response.
 */
function answerErrors(call: Call, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  const def = isError ? `${call}.errors` : `${call}.response`;
  return [...schemaErrors(def, outcome), ...schemaErrors(def, outcome, V115_ID)];
}

// ---- databases and clients ------------------------------------------------------------------------------------------

/** One statement a role client sent: its connection, its text and its parameters (in memory only, never printed). */
interface Sent {
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first; every statement recorded. */
let job: Sql;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
let typedColumns: Map<string, string>;
/** Every base table of this file's schema, in name order. */
let schemaTables: string[];
/** Every table's columns, by table. */
const schemaColumns = new Map<string, Set<string>>();
/** Every statement the rosie_job client sent, in order. */
const sent: Sent[] = [];

function roleClient(role: string, applicationName: string, max: number, record: boolean): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    ...(record
      ? {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            sent.push({ connection, text, parameters: [...parameters] });
          },
        }
      : {}),
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "test_phone_reads" });
  job = roleClient(JOB_ROLE, "rosie-t1300-job", 5, true);
  app = roleClient(APP_ROLE, "rosie-t1300-app", 2, false);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const tables = await db.sql<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = ${db.schema} and table_type = 'BASE TABLE'
    order by table_name
  `;
  schemaTables = tables.map((table) => table.name);
  const columns = await db.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns where table_schema = ${db.schema}
  `;
  for (const column of columns) {
    const ofTable = schemaColumns.get(column.table_name) ?? new Set<string>();
    schemaColumns.set(column.table_name, ofTable.add(column.column_name));
  }
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table the seeds write (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

async function insertRow(sql: Db, table: string, row: Row): Promise<void> {
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

// ---- seeds, chains and the rows a note lists ---------------------------------------------------------------------------

/** A K-04 seed by its name. */
const coreSeed = (name: string): URL => new URL(name, CORE_DIR);

/** `<part>/<file>`, a seed of another database part (README "Fixtures", given.partSeeds), in that part's fixtures. */
function partSeed(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, SCHEMA_DIR);
}

const PERSON_ROLES = coreSeed("seed-person-roles.json");
const SESSIONS = partSeed("people-access/seed-session.json");
const OWNER_EMAIL = partSeed("people-access/seed-owner-id-upload.json");
const CHAT_LINKS = partSeed("conversations-consent/seed-chat-link.json");
const STAGING_TESTERS = partSeed("people-access/seed-staging-tester.json");

/** A seed's rows after those of the seeds its `after` names, each read from the seed's own folder; each seed once. */
function seedRows(seed: URL, seen: Set<string>): TableRow[] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as SeedFile;
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const { given } = exchangeOf(file);
  const seeds = [...given.k04Seeds.map(coreSeed), ...(given.partSeeds ?? []).map(partSeed)];
  const steps: string[] = [];
  for (const before of given.after) {
    if (seen.has(before)) {
      continue;
    }
    seen.add(before);
    const inner = chainOf(before, seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

/** Empties the tables and loads the seeds with their own chains, as the owner, in one transaction. */
async function loadSeeds(seeds: readonly URL[]): Promise<void> {
  await reset();
  const seen = new Set<string>();
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await writeRows(rows);
}

/** Rows as the owner, in one transaction. */
async function writeRows(rows: readonly TableRow[]): Promise<void> {
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** The tables the three reads read (and sessions, which item 53 reads through K-22's function). */
const READ_TABLES = ["sessions", "team_page_recipients", "handles", "person_handles", "phones", "chat_links"];
/** The chain steps that write no row of those tables: a time saved, a plan, a claim (K-05 v1 items 2, 3 and 8). */
const STEPS_WRITING_NONE = new Set(["reserve", "writePlan", "claimOutbox"]);

/** A commit's state write (K-05 v1 stateWrite), as far as this file reads one. */
type StateWrite =
  | { op: "insert"; table: string; values: Row }
  | { op: "update"; table: string; key: Record<string, string>; expectVersion: number; set: Row };

/**
 * A chain's step, as the owner, as far as these reads read it: a commit's update of a phones row as its exchange states
 * it, the version it expects raised by one (K-04's version trigger), which is the row the fixture's note names; a write
 * of any other of the tables these reads read throws, and a step that writes none of them writes nothing here.
 */
async function runStep(file: string): Promise<void> {
  const step = exchangeOf(file);
  if (STEPS_WRITING_NONE.has(step.call)) {
    return;
  }
  if (step.call !== "commitTurn") {
    throw new Error(`${file}: this test runs no ${step.call} step`);
  }
  const { state } = step.request.writes as unknown as { state: StateWrite[] };
  for (const write of state) {
    if (!READ_TABLES.includes(write.table)) {
      continue;
    }
    if (write.op !== "update" || write.table !== "phones") {
      throw new Error(`${file}: this test writes no ${write.op} of ${write.table}`);
    }
    const number = write.key.number;
    if (number === undefined) {
      throw new Error(`${file}: a phones update names its row's number`);
    }
    const set: Record<string, never> = {};
    for (const [column, value] of Object.entries(write.set)) {
      set[column] = value as never;
    }
    set.version = (write.expectVersion + 1) as never;
    const updated = await db.sql`
      update phones set ${db.sql(set)} where number = ${number} and version = ${write.expectVersion}
      returning number
    `;
    expect(updated.length, `${file}: its phones update`).toBe(1);
  }
}

/** Overrides of the check tester's session and team row, for a case. */
interface CheckTesterChange {
  session?: Row;
  team?: Row;
}

/** The six rows read-tester-standing-check-tester's note lists, value for value, with a case's overrides. */
function checkTesterRows(change: CheckTesterChange = {}): TableRow[] {
  return [
    { table: "persons", values: { id: CHECK_TESTER, name: null, language: null, version: 1 } },
    { table: "handles", values: { id: CHECK_TESTER_HANDLE, kind: "email", address: CHECK_TESTER_EMAIL } },
    { table: "person_handles", values: { person_id: CHECK_TESTER, handle_id: CHECK_TESTER_HANDLE } },
    {
      table: "team_page_recipients",
      values: {
        id: "team-check-tester",
        person_id: CHECK_TESTER,
        chat_handle_id: null,
        email_handle_id: CHECK_TESTER_HANDLE,
        added_at: SEEDED_AT,
        removed_at: null,
        version: 1,
        ...change.team,
      },
    },
    {
      table: "proof_codes",
      values: {
        id: "code-check-tester-seed",
        purpose: "sign_in",
        person_id: CHECK_TESTER,
        business_id: null,
        sent_to_handle_id: CHECK_TESTER_HANDLE,
        channel: "email",
        code_hash: CHECK_TESTER_CODE_HASH,
        hash_key_name: "PROOF_CODE_HASH_KEY",
        sent_at: SEEDED_AT,
        expires_at: "2026-11-12T04:10:00Z",
        wrong_tries: 0,
        used_at: SEEDED_AT,
        version: 2,
      },
    },
    {
      table: "sessions",
      values: {
        id: "session-check-tester",
        person_id: CHECK_TESTER,
        token_sha256: CHECK_TESTER_TOKEN,
        device_sha256: null,
        proven_via: "code",
        proof_code_id: "code-check-tester-seed",
        started_at: SEEDED_AT,
        last_seen_at: SEEDED_AT,
        expires_at: "2026-12-12T04:00:00Z",
        ended_at: null,
        ended_why: null,
        version: 1,
        ...change.session,
      },
    },
  ];
}

/** The rows two fixtures' notes list (README "v1.12" fixtures: no frozen seed holds the check tester). */
const NOTE_ROWS: Readonly<Record<string, readonly TableRow[]>> = {
  "read-tester-standing-check-tester.json": checkTesterRows(),
  "read-tester-standing-removed-member.json": checkTesterRows({
    team: { removed_at: "2026-11-12T04:04:00Z", version: 2 },
  }),
};

/** Loads a fixture's seeds, writes its chain's phone rows and the rows its note lists. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    await runStep(step);
  }
  await writeRows(NOTE_ROWS[file] ?? []);
  return exchange;
}

// ---- the cases beyond the fixtures ("What the new tasks must hold to") ----------------------------------------------------

interface Case {
  /** What the case shows, for the test's name. */
  readonly shows: string;
  readonly call: Call;
  readonly seeds: readonly URL[];
  readonly rows: readonly TableRow[];
  readonly request: Row;
  readonly outcome: Row;
}

const person = (id: string): TableRow => ({ table: "persons", values: { id, name: null, language: null } });
const link = (personId: string, handleId: string): TableRow => ({
  table: "person_handles",
  values: { person_id: personId, handle_id: handleId },
});
const handle = (id: string, kind: "phone" | "email", address: string): TableRow => ({
  table: "handles",
  values: { id, kind, address },
});

/** A second session of the check tester's person, live or signed out, with the used code it names. */
function secondSessionRows(signedOut: boolean): TableRow[] {
  return [
    {
      table: "proof_codes",
      values: {
        id: "code-t1300-check-tester-second",
        purpose: "sign_in",
        person_id: CHECK_TESTER,
        business_id: null,
        sent_to_handle_id: CHECK_TESTER_HANDLE,
        channel: "email",
        code_hash: SECOND_CODE_HASH,
        hash_key_name: "PROOF_CODE_HASH_KEY",
        sent_at: "2026-11-12T04:01:00Z",
        expires_at: "2026-11-12T04:11:00Z",
        wrong_tries: 0,
        used_at: "2026-11-12T04:01:00Z",
        version: 2,
      },
    },
    {
      table: "sessions",
      values: {
        id: "session-t1300-check-tester-second",
        person_id: CHECK_TESTER,
        token_sha256: SECOND_TOKEN,
        device_sha256: null,
        proven_via: "code",
        proof_code_id: "code-t1300-check-tester-second",
        started_at: "2026-11-12T04:01:00Z",
        last_seen_at: "2026-11-12T04:01:00Z",
        expires_at: "2026-12-12T04:01:00Z",
        ended_at: signedOut ? "2026-11-12T04:02:00Z" : null,
        ended_why: signedOut ? "signed_out" : null,
        version: signedOut ? 2 : 1,
      },
    },
  ];
}

/** A team row the check tester's person held before, removed before its live one was added. */
const REMOVED_BEFORE: TableRow = {
  table: "team_page_recipients",
  values: {
    id: "team-t1300-check-tester-before",
    person_id: CHECK_TESTER,
    chat_handle_id: null,
    email_handle_id: CHECK_TESTER_HANDLE,
    added_at: "2026-11-01T04:00:00Z",
    removed_at: "2026-11-05T04:00:00Z",
    version: 2,
  },
};

/**
 * A K-22 v1.3 listing a case adds (example ids, t1402): live, or ended at `removedAt`, which raised its version to 2
 * (README rule 10: a listing ends by removed_at and the version).
 */
function listing(id: string, personId: string, addedAt: string, removedAt: string | null = null): TableRow {
  return {
    table: "staging_testers",
    values: {
      id,
      person_id: personId,
      added_at: addedAt,
      removed_at: removedAt,
      version: removedAt === null ? 1 : 2,
    },
  };
}
/** The check tester's team row, removed at 04:04:00Z (as read-tester-standing-removed-member's note has it). */
const TEAM_ROW_REMOVED: CheckTesterChange = { team: { removed_at: "2026-11-12T04:04:00Z", version: 2 } };

/** Sam on Rosie's team, reached at his own phone: a live team row of his person. */
const SAM_TEAM_ROW: TableRow = {
  table: "team_page_recipients",
  values: {
    id: "team-t1300-sam",
    person_id: SAM,
    chat_handle_id: SAM_HANDLE,
    email_handle_id: null,
    added_at: "2026-10-26T08:00:00Z",
    removed_at: null,
    version: 1,
  },
};

/** A staff invite to Pat's phone (K-29's seed-chat-link.json holds one, P5J3, issued 2026-10-19T14:40:00Z). */
const patLink = (id: string, shortCode: string, issuedAt: string, businessId = BARBERSHOP): TableRow => ({
  table: "chat_links",
  values: {
    id,
    short_code: shortCode,
    purpose: "staff_invite",
    business_id: businessId,
    booking_id: null,
    person_id: PAT,
    phone_number: PAT_NUMBER,
    ready_text: `YES. Ref ${shortCode}`,
    given_via: ["owner"],
    issued_at: issuedAt,
    owner_retold_at: null,
    used_at: null,
    version: 1,
  },
});
const linkAnswer = (shortCode: string): Row => ({ shortCode, readyText: `YES. Ref ${shortCode}` });
/** Pat's phone in K-29's seed: a row with its chat not yet open, never stopped. */
const PAT_PHONE: Row = { chatOpen: false, stopped: false, stoppedAt: null };
/** Two links issued at one moment, after P5J3. */
const TIE_AT = "2026-10-22T09:00:00Z";

const standingAt = (tokenSha256: string, at = READ_AT): Row => ({ tokenSha256, at });
const rosterPhone = (handleId: string, number: string, email: string | null): Row => ({
  handleId,
  phone: { number, email },
});

const CASES: readonly Case[] = [
  // readTesterStanding (item 53)
  {
    shows:
      "readTesterStanding: a session expiring one second after at is live: the check tester's session ending at 04:05:01Z, read at 04:05:00Z, answers tester",
    call: STANDING,
    seeds: [],
    rows: checkTesterRows({ session: { expires_at: ONE_SECOND_AFTER } }),
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: the same session read at its own expires_at, 04:05:01Z, is no longer live: noSession",
    call: STANDING,
    seeds: [],
    rows: checkTesterRows({ session: { expires_at: ONE_SECOND_AFTER } }),
    request: standingAt(CHECK_TESTER_TOKEN, ONE_SECOND_AFTER),
    outcome: { standing: "noSession" },
  },
  {
    shows: "readTesterStanding: a person with a removed team row and a live one: tester",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), REMOVED_BEFORE],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows: "readTesterStanding: a person with two live sessions: the second session's hash answers tester",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), ...secondSessionRows(false)],
    request: standingAt(SECOND_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows: "readTesterStanding: a person with two live sessions: the first session's hash answers tester too",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), ...secondSessionRows(false)],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: a person with two sessions, the second signed out: the second's hash answers noSession",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), ...secondSessionRows(true)],
    request: standingAt(SECOND_TOKEN),
    outcome: { standing: "noSession" },
  },
  {
    shows:
      "readTesterStanding: a person with two sessions, the second signed out: the first, still live, answers tester",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), ...secondSessionRows(true)],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: Sam's live session once his person holds a live team row, reached at his phone: tester",
    call: STANDING,
    seeds: [SESSIONS],
    rows: [SAM_TEAM_ROW],
    request: standingAt(SAM_LIVE_TOKEN, SAM_READ_AT),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: Sam's live session beside another person's live team row (the check tester's): notTester",
    call: STANDING,
    seeds: [SESSIONS],
    rows: checkTesterRows(),
    request: standingAt(SAM_LIVE_TOKEN, SAM_READ_AT),
    outcome: { standing: "notTester" },
  },
  // readTesterStanding (item 68, v1.15's "What the new tasks must hold to", with two mirrors)
  {
    shows:
      "readTesterStanding: a person who holds both a live team row and a live listing (the check tester, listed too): tester",
    call: STANDING,
    seeds: [],
    rows: [...checkTesterRows(), listing("staging-tester-t1402-check-tester", CHECK_TESTER, SEEDED_AT)],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: an ended listing beside a live team row (the check tester's listing ended at 04:04:00Z): tester, by the team row",
    call: STANDING,
    seeds: [],
    rows: [
      ...checkTesterRows(),
      listing("staging-tester-t1402-check-tester", CHECK_TESTER, SEEDED_AT, "2026-11-12T04:04:00Z"),
    ],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: a live listing beside a removed team row (the mirror: the team row removed at 04:04:00Z): tester, by the listing",
    call: STANDING,
    seeds: [],
    rows: [
      ...checkTesterRows(TEAM_ROW_REMOVED),
      listing("staging-tester-t1402-check-tester", CHECK_TESTER, SEEDED_AT),
    ],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "tester" },
  },
  {
    shows:
      "readTesterStanding: a removed team row and an ended listing, the session live: neither stands, notTester",
    call: STANDING,
    seeds: [],
    rows: [
      ...checkTesterRows(TEAM_ROW_REMOVED),
      listing("staging-tester-t1402-check-tester", CHECK_TESTER, SEEDED_AT, "2026-11-12T04:04:00Z"),
    ],
    request: standingAt(CHECK_TESTER_TOKEN),
    outcome: { standing: "notTester" },
  },
  {
    shows:
      "readTesterStanding: a listing ended a second before at (Tester Two's, ended 07:00:00Z, read at 07:00:01Z, the session live): notTester",
    call: STANDING,
    seeds: [STAGING_TESTERS],
    rows: [],
    request: standingAt(TESTER_TWO_TOKEN, "2026-11-14T07:00:01Z"),
    outcome: { standing: "notTester" },
  },
  {
    shows:
      "readTesterStanding: a person with an ended listing and a later live one (Tester Two listed again at 07:30Z): tester",
    call: STANDING,
    seeds: [STAGING_TESTERS],
    rows: [listing("staging-tester-t1402-two-again", TESTER_TWO, "2026-11-14T07:30:00Z")],
    request: standingAt(TESTER_TWO_TOKEN, TESTERS_READ_AT),
    outcome: { standing: "tester" },
  },
  // readRosterPhone (item 54)
  {
    shows:
      "readRosterPhone: a phone handle of two people: the number, and email null, though Sam holds one email handle",
    call: ROSTER_PHONE,
    seeds: [OWNER_EMAIL],
    rows: [person("person-t1300-partner"), link("person-t1300-partner", SAM_HANDLE)],
    request: { handleId: SAM_HANDLE },
    outcome: rosterPhone(SAM_HANDLE, SAM_NUMBER, null),
  },
  {
    shows: "readRosterPhone: a person with two email handles: the number, and email null",
    call: ROSTER_PHONE,
    seeds: [OWNER_EMAIL],
    rows: [
      handle("handle-t1300-sam-second-email", "email", "sam.second@example.com"),
      link(SAM, "handle-t1300-sam-second-email"),
    ],
    request: { handleId: SAM_HANDLE },
    outcome: rosterPhone(SAM_HANDLE, SAM_NUMBER, null),
  },
  {
    shows: "readRosterPhone: a phone handle with no person: the number, and email null",
    call: ROSTER_PHONE,
    seeds: [],
    rows: [handle("handle-t1300-no-person", "phone", "+15555550170")],
    request: { handleId: "handle-t1300-no-person" },
    outcome: rosterPhone("handle-t1300-no-person", "+15555550170", null),
  },
  {
    shows:
      "readRosterPhone: Alex's phone, whose one person holds one email handle in K-04's seed: his number and alex@example.com",
    call: ROSTER_PHONE,
    seeds: [PERSON_ROLES],
    rows: [],
    request: { handleId: ALEX_HANDLE },
    outcome: rosterPhone(ALEX_HANDLE, ALEX_NUMBER, "alex@example.com"),
  },
  // readPhoneState (item 55)
  {
    shows:
      "readPhoneState: two links of one phone at two times: the later, though its id is the lower (Pat: P5J3, then T1L1)",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [patLink("chatlink-a-t1300-later", "T1L1", "2026-10-22T09:00:00Z")],
    request: { number: PAT_NUMBER },
    outcome: { phone: PAT_PHONE, chatLink: linkAnswer("T1L1") },
  },
  {
    shows:
      "readPhoneState: two links of one phone at one time: the lower id, though it was written second (Pat: T1B2 and T1A2)",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [patLink("chatlink-t1300-tie-b", "T1B2", TIE_AT), patLink("chatlink-t1300-tie-a", "T1A2", TIE_AT)],
    request: { number: PAT_NUMBER },
    outcome: { phone: PAT_PHONE, chatLink: linkAnswer("T1A2") },
  },
  {
    shows:
      "readPhoneState: two links at one time are told apart byte by byte (default 2): an upper-case B sorts before a lower-case a",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [patLink("chatlink-t1300-tie-a", "T1A6", TIE_AT), patLink("chatlink-t1300-tie-B", "T1B6", TIE_AT)],
    request: { number: PAT_NUMBER },
    outcome: { phone: PAT_PHONE, chatLink: linkAnswer("T1B6") },
  },
  {
    shows:
      "readPhoneState: links of two businesses: the newest, the yoga studio's, beside the barbershop's (no business scope hides one)",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [patLink("chatlink-t1300-yoga", "T1Y3", "2026-10-23T10:00:00Z", YOGA)],
    request: { number: PAT_NUMBER },
    outcome: { phone: PAT_PHONE, chatLink: linkAnswer("T1Y3") },
  },
  {
    shows:
      "readPhoneState: links of two businesses: the newest, the barbershop's, beside an older one of the yoga studio",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [
      patLink("chatlink-t1300-yoga-older", "T1Y4", "2026-10-19T10:00:00Z", YOGA),
      patLink("chatlink-t1300-barber-newer", "T1B5", "2026-10-23T11:00:00Z"),
    ],
    request: { number: PAT_NUMBER },
    outcome: { phone: PAT_PHONE, chatLink: linkAnswer("T1B5") },
  },
  {
    shows:
      "readPhoneState: Ben's stopped phone with his used booking link: stopped, the chat closed, the STOP's time, and the link as stored",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [],
    request: { number: BEN_NUMBER },
    outcome: {
      phone: { chatOpen: false, stopped: true, stoppedAt: "2026-10-20T13:00:00Z" },
      chatLink: { shortCode: "4K7Q", readyText: "Hey, send me further updates about my booking. Ref 4K7Q" },
    },
  },
  {
    shows: "readPhoneState: Avery's open chat with her used staff invite: open, and the link, used or not",
    call: PHONE_STATE,
    seeds: [CHAT_LINKS],
    rows: [],
    request: { number: AVERY_NUMBER },
    outcome: { phone: { chatOpen: true, stopped: false, stoppedAt: null }, chatLink: linkAnswer("R2V9") },
  },
];

/** Loads a case's seeds and its rows. */
async function givenCase(spec: Case): Promise<void> {
  await loadSeeds(spec.seeds);
  await writeRows(spec.rows);
}

// ---- watching one read: what it sent, what it answered, what it logged ------------------------------------------------

/** Runs `read` with every console method watched; answers the outcome or the error, and how often anything was logged. */
async function unlogged(read: () => Promise<unknown>): Promise<{ outcome: unknown; logged: number }> {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
    vi.spyOn(console, "trace").mockImplementation(() => undefined),
  ];
  try {
    let outcome: unknown;
    try {
      outcome = await read();
    } catch (error) {
      outcome = error;
    }
    return { outcome, logged: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/** One read run: its call, its label, its request, what it sent, its outcome and how often it logged. */
interface Run {
  call: Call;
  label: string;
  request: Row;
  statements: Sent[];
  outcome: unknown;
  logged: number;
}

/** Runs one read on the rosie_job client, keeping the statements it sent. */
async function watched(call: Call, label: string, request: Row): Promise<Run> {
  sent.length = 0;
  const { outcome, logged } = await unlogged(() => READS[call](job, request));
  return { call, label, request, statements: [...sent], outcome, logged };
}

/** Every v1.12 fixture's read and every case's, each over its own rows, with what it sent. */
async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  for (const { file, call } of ACCEPTED) {
    const exchange = await given(file);
    runs.push(await watched(call, file, exchange.request));
  }
  for (const spec of CASES) {
    await givenCase(spec);
    runs.push(await watched(spec.call, spec.shows, spec.request));
  }
  return runs;
}

/** Every base table's row count and content, as the owner reads it: equal before and after means nothing was written. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of schemaTables) {
    const [row] = await db.sql<{ n: number; digest: string }[]>`
      select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
      from ${db.sql(table)} t
    `;
    out[table] = `${String(row?.n)} rows, ${row?.digest ?? ""}`;
  }
  return out;
}

/** The values a read's request or answer holds that no statement's text, no error and no log line may hold. */
function secretsOf(call: Call, request: Row, outcome: unknown): string[] {
  const answer = (outcome ?? {}) as Row;
  switch (call) {
    case STANDING:
      return [textOf(request.tokenSha256, "the request's hash")];
    case ROSTER_PHONE: {
      const phone = (answer.phone ?? null) as Row | null;
      return [phone?.number, phone?.email].filter((value): value is string => typeof value === "string");
    }
    case PHONE_STATE: {
      const link = (answer.chatLink ?? null) as Row | null;
      return [request.number, link?.shortCode, link?.readyText].filter(
        (value): value is string => typeof value === "string",
      );
    }
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the role the reads run as (README v1.12 'Where each read lives': rosie_job, no business scope)", () => {
  it("the two clients run as rosie_job and rosie_app, with this file's schema first and no business scope", async () => {
    for (const [client, name] of [
      [job, JOB_ROLE],
      [app, APP_ROLE],
    ] as const) {
      const [row] = await client<{ who: string; path: string; scope: string | null }[]>`
        select current_user as who, current_setting('search_path') as path,
               current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(name);
      expect(row?.path).toBe(`${db.schema}, public`);
      expect(row?.scope ?? "").toBe("");
    }
  });

  it(
    "a Tool API client's reads are refused by PostgreSQL's own privilege check (no grant on team_page_recipients, staging_testers, handles or phones: 0012, 0017, 0036), naming no value",
    SLOW,
    async () => {
      const refused: [Call, string][] = [
        [STANDING, "read-tester-standing-check-tester.json"],
        [STANDING, "read-tester-standing-human-tester.json"],
        [ROSTER_PHONE, "read-roster-phone-email-on-file.json"],
        [PHONE_STATE, "read-phone-state-chat-link.json"],
      ];
      for (const [call, file] of refused) {
        const exchange = await given(file);
        const error = await thrownBy(READS[call](app, exchange.request));
        expect(error, file).toBeInstanceOf(DataAccessDatabaseError);
        expect((error as DataAccessDatabaseError).code, file).toBe("42501");
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        for (const value of [
          ...secretsOf(call, exchange.request, exchange.outcome),
          CHECK_TESTER,
          TESTER_ONE,
          TESTER_TWO,
          SAM,
          "@example.com",
        ]) {
          expect(text.includes(value), `${file}: ${value}`).toBe(false);
        }
      }
    },
  );

  it(
    "a business scope a connection kept is emptied for the read's transaction (as the seeds set it): Pat's barbershop link, read through a connection scoped to the yoga studio",
    SLOW,
    async () => {
      const exchange = await given("read-phone-state-chat-link.json");
      const scoped = roleClient(JOB_ROLE, "rosie-t1300-scoped", 1, false);
      try {
        await scoped`select set_config('rosie.business_id', ${YOGA}, false)`;
        const [hidden] = await scoped<{ links: number }[]>`
          select count(*)::int as links from chat_links where phone_number = ${PAT_NUMBER}
        `;
        expect(hidden?.links).toBe(0);
        expect(await readPhoneState(scoped, { number: PAT_NUMBER })).toEqual(exchange.outcome);
      } finally {
        await scoped.end({ timeout: 5 });
      }
    },
  );
});

describe("each v1.12 fixture of items 53 to 55 and each v1.15 fixture of item 68 gives its outcome (K-05 v1.12 items 53 to 55, defaults 103 to 109; v1.15 item 68, defaults 136 to 139)", () => {
  it("the index lists the seventeen exchanges of items 53 to 55 and 68 (v1.12's fifteen and v1.15's two), each valid against data-access v1.12 and v1.15, and their nine refused twins (v1.12's seven and v1.15's two), each refused by its definition in v1.12 and in v1.15", () => {
    expect(ACCEPTED.map(({ file }) => file).sort()).toEqual([
      "read-phone-state-chat-link.json",
      "read-phone-state-chat-open.json",
      "read-phone-state-no-row.json",
      "read-phone-state-started-again.json",
      "read-phone-state-stopped.json",
      "read-roster-phone-email-on-file.json",
      "read-roster-phone-not-a-phone.json",
      "read-roster-phone-tp-01.json",
      "read-roster-phone-unknown.json",
      "read-tester-standing-check-tester.json",
      "read-tester-standing-expired.json",
      "read-tester-standing-human-tester.json",
      "read-tester-standing-listing-ended.json",
      "read-tester-standing-not-tester.json",
      "read-tester-standing-removed-member.json",
      "read-tester-standing-signed-out.json",
      "read-tester-standing-unknown-token.json",
    ]);
    const v115 = ACCEPTED.filter(({ version }) => version === "v1.15").map(({ file }) => file);
    expect(v115.sort()).toEqual([
      "read-tester-standing-human-tester.json",
      "read-tester-standing-listing-ended.json",
    ]);
    for (const { file, call } of ACCEPTED) {
      const exchange = exchangeOf(file);
      expect(exchange.call, file).toBe(call);
      expect(schemaErrors(`${call}.exchange`, exchange), file).toEqual([]);
      expect(schemaErrors(`${call}.exchange`, exchange, V115_ID), file).toEqual([]);
    }
    expect(REFUSED.map((entry) => `${entry.file} by ${entry.def ?? ""}`).sort()).toEqual([
      "invalid/refuse-phone-state-answers-number.json by readPhoneState.response",
      "invalid/refuse-phone-state-link-without-phone.json by readPhoneState.response",
      "invalid/refuse-phone-state-stopped-at-after-start.json by readPhoneState.response",
      "invalid/refuse-roster-phone-by-roster-id.json by readRosterPhone.exchange",
      "invalid/refuse-roster-phone-names-person.json by readRosterPhone.response",
      "invalid/refuse-tester-standing-by-address.json by readTesterStanding.exchange",
      "invalid/refuse-tester-standing-ended-listing-told.json by readTesterStanding.response",
      "invalid/refuse-tester-standing-names-person.json by readTesterStanding.response",
      "invalid/refuse-tester-standing-token-not-hash.json by readTesterStanding.exchange",
    ]);
    for (const entry of REFUSED) {
      const value = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(entry.def ?? "", value), entry.file).not.toEqual([]);
      expect(schemaErrors(entry.def ?? "", value, V115_ID), entry.file).not.toEqual([]);
    }
  });

  for (const { file, call } of ACCEPTED) {
    it(
      `${file}: as rosie_job, ${call} answers the fixture's outcome, valid against its v1.12 and v1.15 definitions`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await READS[call](job, exchange.request);
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(call, outcome)).toEqual([]);
        expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome })).toEqual([]);
        expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome }, V115_ID)).toEqual([]);
      },
    );
  }

  it(
    "the chains of read-phone-state-stopped and -started-again leave Alex's phone row as their notes name it (commit-alex-stop: stopped, the chat closed, stop_at 15:06:36Z, version 4; commit-alex-start: not stopped, the chat open, start_at 15:20:00Z, stop_at kept, version 5)",
    SLOW,
    async () => {
      const alexPhone = async (): Promise<Row | undefined> => {
        const [row] = await db.sql<
          {
            stopped: boolean;
            chat_open: boolean;
            stop_at: Date | null;
            start_at: Date | null;
            version: number;
          }[]
        >`select stopped, chat_open, stop_at, start_at, version from phones where number = ${ALEX_NUMBER}`;
        return row === undefined
          ? undefined
          : {
              stopped: row.stopped,
              chat_open: row.chat_open,
              stop_at: utcOrNull(row.stop_at),
              start_at: utcOrNull(row.start_at),
              version: row.version,
            };
      };
      await given("read-phone-state-stopped.json");
      expect(await alexPhone()).toEqual({
        stopped: true,
        chat_open: false,
        stop_at: "2026-11-07T15:06:36Z",
        start_at: null,
        version: 4,
      });
      await given("read-phone-state-started-again.json");
      expect(await alexPhone()).toEqual({
        stopped: false,
        chat_open: true,
        stop_at: "2026-11-07T15:06:36Z",
        start_at: "2026-11-07T15:20:00Z",
        version: 5,
      });
    },
  );

  it(
    "refuse-tester-standing-token-not-hash: a standing asked with the token itself is refused before any statement, never echoing it; put right, it is the check tester's",
    SLOW,
    async () => {
      const twin = await given("read-tester-standing-check-tester.json");
      const refused = readJson(
        new URL("invalid/refuse-tester-standing-token-not-hash.json", ACCESS_DIR),
      ) as Exchange;
      sent.length = 0;
      const error = await thrownBy(READS.readTesterStanding(job, refused.request));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("readTesterStanding: the request takes only tokenSha256, at");
      const token = textOf(refused.request.sessionToken, "the refused request's token");
      expect((error as Error).message.includes(token)).toBe(false);
      expect(sent).toEqual([]);
      const { sessionToken, ...rest } = refused.request;
      expect(sessionToken).toBe(token);
      const putRight = { tokenSha256: textOf(twin.request.tokenSha256, "the twin's hash"), ...rest };
      expect(putRight).toEqual(twin.request);
      expect(await READS.readTesterStanding(job, putRight)).toEqual(twin.outcome);
    },
  );

  it(
    "refuse-roster-phone-by-roster-id: a roster phone asked by its roster id is refused before any statement; put right, it is tp-01's",
    SLOW,
    async () => {
      const twin = await given("read-roster-phone-tp-01.json");
      const refused = readJson(
        new URL("invalid/refuse-roster-phone-by-roster-id.json", ACCESS_DIR),
      ) as Exchange;
      sent.length = 0;
      const error = await thrownBy(
        readRosterPhone(job, refused.request as unknown as ReadRosterPhoneRequest),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("readRosterPhone: the request takes only handleId");
      expect(sent).toEqual([]);
      const { testPhoneId, ...rest } = refused.request;
      expect(testPhoneId).toBe("tp-01");
      const putRight = { handleId: SAM_HANDLE, ...rest };
      expect(putRight).toEqual(twin.request);
      expect(await readRosterPhone(job, putRight)).toEqual(twin.outcome);
    },
  );

  it(
    "refuse-tester-standing-names-person, refuse-roster-phone-names-person and refuse-phone-state-stopped-at-after-start, -link-without-phone and -answers-number: each read answers the accepted twin, never the refused form, and each refused answer put right is its twin's outcome",
    SLOW,
    async () => {
      const refusedOf = (file: string): Row => readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as Row;

      const notTester = await given("read-tester-standing-not-tester.json");
      const namesPerson = refusedOf("refuse-tester-standing-names-person.json");
      const standing = await READS.readTesterStanding(job, notTester.request);
      expect(standing).toEqual(notTester.outcome);
      expect(standing).not.toEqual(namesPerson);
      const { personId, ...standingPutRight } = namesPerson;
      expect(personId).toBe(SAM);
      expect(standingPutRight).toEqual(notTester.outcome);

      const tp01 = await given("read-roster-phone-tp-01.json");
      const rosterNamesPerson = refusedOf("refuse-roster-phone-names-person.json");
      const roster = await READS.readRosterPhone(job, tp01.request);
      expect(roster).toEqual(tp01.outcome);
      expect(roster).not.toEqual(rosterNamesPerson);
      const { personId: phonePerson, ...phonePutRight } = rosterNamesPerson.phone as Row;
      expect(phonePerson).toBe(SAM);
      expect({ ...rosterNamesPerson, phone: phonePutRight }).toEqual(tp01.outcome);

      const started = await given("read-phone-state-started-again.json");
      const stoppedAt = refusedOf("refuse-phone-state-stopped-at-after-start.json");
      const startedState = await READS.readPhoneState(job, started.request);
      expect(startedState).toEqual(started.outcome);
      expect(startedState).not.toEqual(stoppedAt);
      expect({ ...stoppedAt, phone: { ...(stoppedAt.phone as Row), stoppedAt: null } }).toEqual(
        started.outcome,
      );

      const noRow = await given("read-phone-state-no-row.json");
      const linkWithoutPhone = refusedOf("refuse-phone-state-link-without-phone.json");
      const noRowState = await READS.readPhoneState(job, noRow.request);
      expect(noRowState).toEqual(noRow.outcome);
      expect(noRowState).not.toEqual(linkWithoutPhone);
      expect({ ...linkWithoutPhone, chatLink: null }).toEqual(noRow.outcome);

      const open = await given("read-phone-state-chat-open.json");
      const answersNumber = refusedOf("refuse-phone-state-answers-number.json");
      const openState = await READS.readPhoneState(job, open.request);
      expect(openState).toEqual(open.outcome);
      expect(openState).not.toEqual(answersNumber);
      const { number, ...numberPutRight } = answersNumber;
      expect(number).toBe(SAM_NUMBER);
      expect(numberPutRight).toEqual(open.outcome);
    },
  );

  it(
    "refuse-tester-standing-by-address (v1.15): a standing asked with the tester's inbox address beside the hash is refused before any statement, never echoing the address; put right, it is read-tester-standing-human-tester's request, and answers tester",
    SLOW,
    async () => {
      const twin = await given("read-tester-standing-human-tester.json");
      const refused = readJson(
        new URL("invalid/refuse-tester-standing-by-address.json", ACCESS_DIR),
      ) as Exchange;
      sent.length = 0;
      const error = await thrownBy(READS.readTesterStanding(job, refused.request));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("readTesterStanding: the request takes only tokenSha256, at");
      const address = textOf(refused.request.email, "the refused request's address");
      expect((error as Error).message.includes(address)).toBe(false);
      expect(sent).toEqual([]);
      const { email, ...putRight } = refused.request;
      expect(email).toBe(address);
      expect(putRight).toEqual(twin.request);
      expect(await READS.readTesterStanding(job, putRight)).toEqual(twin.outcome);
    },
  );

  it(
    "refuse-tester-standing-ended-listing-told (v1.15): Tester Two's read answers notTester alone, never when the listing ended; the refused answer put right is read-tester-standing-listing-ended's outcome",
    SLOW,
    async () => {
      const twin = await given("read-tester-standing-listing-ended.json");
      const told = readJson(
        new URL("invalid/refuse-tester-standing-ended-listing-told.json", ACCESS_DIR),
      ) as Row;
      const standing = await READS.readTesterStanding(job, twin.request);
      expect(standing).toEqual(twin.outcome);
      expect(standing).not.toEqual(told);
      const { listingEndedAt, ...putRight } = told;
      expect(listingEndedAt).toBe(TESTER_TWO_ENDED);
      expect(putRight).toEqual(twin.outcome);
    },
  );
});

describe("beyond the fixtures (README v1.12 and v1.15 'What the new tasks must hold to'; defaults 103 to 109 and 136 to 139)", () => {
  for (const spec of CASES) {
    it(spec.shows, SLOW, async () => {
      await givenCase(spec);
      const outcome = await READS[spec.call](job, spec.request);
      expect(outcome).toEqual(spec.outcome);
      expect(answerErrors(spec.call, outcome)).toEqual([]);
    });
  }

  it(
    "readPhoneState: a stopped phone row with no STOP time (phones_stopped_has_time dropped in this file's schema for this test alone) throws BrokenRecordError, naming no value, and answers and writes nothing (default 3)",
    SLOW,
    async () => {
      await given("read-phone-state-chat-link.json");
      const schema = `"${db.schema}"`;
      try {
        await db.sql.unsafe(`alter table ${schema}.phones drop constraint phones_stopped_has_time`);
        await db.sql`update phones set stop_at = null, version = version + 1 where number = ${BEN_NUMBER}`;
        const before = await fingerprint();
        const run = await watched(PHONE_STATE, "a stopped row with no STOP time", { number: BEN_NUMBER });
        expect(run.outcome).toBeInstanceOf(BrokenRecordError);
        expect((run.outcome as Error).message).toBe("readPhoneState: a stopped phone row holds no STOP time");
        expect((run.outcome as Error).message.includes(BEN_NUMBER)).toBe(false);
        expect(run.statements.at(-1)?.text).toBe("rollback");
        expect(run.logged).toBe(0);
        expect(await fingerprint()).toEqual(before);
      } finally {
        await reset();
        await db.sql.unsafe(
          `alter table ${schema}.phones add constraint phones_stopped_has_time check (not stopped or stop_at is not null)`,
        );
      }
      expect(await readPhoneState(job, { number: BEN_NUMBER })).toEqual({ phone: null, chatLink: null });
    },
  );

  it(
    "a request of the wrong shape is refused before any statement, naming the field, never a value (default 1)",
    SLOW,
    async () => {
      await given("read-tester-standing-check-tester.json");
      const token = "placeholder-session-token-check-0001";
      const refused: [Call, unknown, string][] = [
        [STANDING, null, "readTesterStanding: the request is an object"],
        [STANDING, [], "readTesterStanding: the request is an object"],
        [
          STANDING,
          {},
          "readTesterStanding: tokenSha256 is the session token's sha256 in lower-case hex, never the token itself",
        ],
        [
          STANDING,
          { tokenSha256: token, at: READ_AT },
          "readTesterStanding: tokenSha256 is the session token's sha256 in lower-case hex, never the token itself",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN.toUpperCase(), at: READ_AT },
          "readTesterStanding: tokenSha256 is the session token's sha256 in lower-case hex, never the token itself",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN.slice(2), at: READ_AT },
          "readTesterStanding: tokenSha256 is the session token's sha256 in lower-case hex, never the token itself",
        ],
        [
          STANDING,
          { sessionToken: token, at: READ_AT },
          "readTesterStanding: the request takes only tokenSha256, at",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN, at: READ_AT, personId: CHECK_TESTER },
          "readTesterStanding: the request takes only tokenSha256, at",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN },
          "readTesterStanding: at is not an instant in UTC ending in Z",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN, at: "2026-11-12 04:05:00" },
          "readTesterStanding: at is not an instant in UTC ending in Z",
        ],
        [
          STANDING,
          { tokenSha256: CHECK_TESTER_TOKEN, at: "2026-02-30T04:05:00Z" },
          "readTesterStanding: at is not a date that exists",
        ],
        [ROSTER_PHONE, null, "readRosterPhone: the request is an object"],
        [ROSTER_PHONE, { testPhoneId: "tp-01" }, "readRosterPhone: the request takes only handleId"],
        [
          ROSTER_PHONE,
          { handleId: SAM_HANDLE, number: SAM_NUMBER },
          "readRosterPhone: the request takes only handleId",
        ],
        [
          ROSTER_PHONE,
          {},
          "readRosterPhone: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
        ],
        [
          ROSTER_PHONE,
          { handleId: SAM_NUMBER },
          "readRosterPhone: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
        ],
        [
          ROSTER_PHONE,
          { handleId: "5555550100" },
          "readRosterPhone: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
        ],
        [
          ROSTER_PHONE,
          { handleId: "sam@example.com" },
          "readRosterPhone: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
        ],
        [
          ROSTER_PHONE,
          { handleId: "" },
          "readRosterPhone: handleId is a K-04 handle id (a K-08 safe id), never a number or an address",
        ],
        [PHONE_STATE, [], "readPhoneState: the request is an object"],
        [PHONE_STATE, {}, "readPhoneState: number is a phone number in E.164 form"],
        [PHONE_STATE, { number: "5555550100" }, "readPhoneState: number is a phone number in E.164 form"],
        [
          PHONE_STATE,
          { number: "+1 555 555 0100" },
          "readPhoneState: number is a phone number in E.164 form",
        ],
        [PHONE_STATE, { phoneNumber: SAM_NUMBER }, "readPhoneState: the request takes only number"],
        [
          PHONE_STATE,
          { number: SAM_NUMBER, handleId: SAM_HANDLE },
          "readPhoneState: the request takes only number",
        ],
      ];
      for (const [call, request, message] of refused) {
        sent.length = 0;
        const error = await thrownBy(READS[call](job, request));
        expect(error, JSON.stringify(request)).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(message);
        for (const value of [
          token,
          CHECK_TESTER_TOKEN,
          CHECK_TESTER_TOKEN.toUpperCase(),
          CHECK_TESTER,
          "5555550100",
          "555 555 0100",
          "sam@example.com",
          "tp-01",
          SAM_HANDLE,
        ]) {
          expect((error as Error).message.includes(value), value).toBe(false);
        }
        expect(sent).toEqual([]);
      }
    },
  );
});

describe("one read-only transaction per read, and nothing written (README v1.12: each read 'writes nothing')", () => {
  /** Each read, with a table it reads and a fixture whose read reaches that table. */
  const PROBES: readonly { call: Call; table: string; fixture: string }[] = [
    { call: STANDING, table: "team_page_recipients", fixture: "read-tester-standing-check-tester.json" },
    { call: ROSTER_PHONE, table: "handles", fixture: "read-roster-phone-email-on-file.json" },
    { call: PHONE_STATE, table: "phones", fixture: "read-phone-state-chat-link.json" },
  ];

  for (const probe of PROBES) {
    it(
      `${probe.call}: a write inside its own transaction (a policy's function on ${probe.table}) is refused, 25006 thrown scrubbed, and leaves nothing; the same write goes through in a transaction that allows it`,
      SLOW,
      async () => {
        const exchange = await given(probe.fixture);
        // A probe that writes whenever a row of the table is read as rosie_job: a policy's function.
        const schema = `"${db.schema}"`;
        const table = `${schema}.${probe.table}`;
        const probeTable = `${schema}.t_write_probe`;
        const probeOf = `${schema}.t_write_probe_of`;
        const probeRows = async (): Promise<number> => {
          const [row] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${probeTable}`);
          return row?.n ?? -1;
        };
        await db.sql.unsafe(`create table ${probeTable} (n integer not null)`);
        await db.sql.unsafe(`grant select, insert on ${probeTable} to ${JOB_ROLE}`);
        await db.sql.unsafe(
          `create function ${probeOf}() returns boolean language plpgsql volatile as $probe$ ` +
            `begin insert into ${probeTable} (n) values (1); return true; end $probe$`,
        );
        try {
          await db.sql.unsafe(`alter table ${table} enable row level security`);
          await db.sql.unsafe(
            `create policy t_write_probe on ${table} for select to ${JOB_ROLE} using (${probeOf}())`,
          );
          // In a transaction that may write, the probe writes when the table is read.
          await job.begin(async (tx) => {
            await tx.unsafe(`select 1 from ${table}`);
          });
          expect(await probeRows()).toBeGreaterThan(0);
          await db.sql.unsafe(`truncate ${probeTable}`);
          const before = await fingerprint();
          // In the read's own transaction the same write is refused, so it answers nothing and writes nothing.
          const run = await watched(probe.call, "probe", exchange.request);
          expect(run.outcome).toBeInstanceOf(DataAccessDatabaseError);
          expect((run.outcome as DataAccessDatabaseError).code).toBe("25006");
          expect((run.outcome as Error).message).toContain(
            `${probe.call}: the database refused the call (SQLSTATE 25006`,
          );
          const text = `${(run.outcome as Error).message} ${JSON.stringify(run.outcome)}`;
          for (const value of secretsOf(probe.call, exchange.request, exchange.outcome)) {
            expect(text.includes(value), value).toBe(false);
          }
          expect(run.statements.some((statement) => statement.text === "rollback")).toBe(true);
          expect(run.logged).toBe(0);
          expect(await probeRows()).toBe(0);
          expect(await fingerprint()).toEqual(before);
        } finally {
          await db.sql.unsafe(`drop policy if exists t_write_probe on ${table}`);
          await db.sql.unsafe(`alter table ${table} disable row level security`);
          await db.sql.unsafe(`drop function if exists ${probeOf}()`);
          await db.sql.unsafe(`drop table if exists ${probeTable}`);
        }
        expect(await READS[probe.call](job, exchange.request)).toEqual(exchange.outcome);
      },
    );
  }

  it(
    "nothing is written: every table's row count and content are the same before and after reads of every handle, every number, every session's hash, refused requests and the Tool API's role",
    SLOW,
    async () => {
      await loadSeeds([SESSIONS, CHAT_LINKS]);
      await writeRows([...checkTesterRows(), SAM_TEAM_ROW, ...secondSessionRows(true)]);
      const handles = await db.sql<{ id: string }[]>`select id from handles order by id`;
      const numbers = await db.sql<{ number: string }[]>`select number from phones order by number`;
      expect(handles.length).toBeGreaterThan(8);
      expect(numbers.length).toBeGreaterThan(6);
      const before = await fingerprint();
      for (const { id } of handles) {
        await readRosterPhone(job, { handleId: id });
      }
      await readRosterPhone(job, { handleId: "handle-t1300-nobody" });
      for (const { number } of numbers) {
        await readPhoneState(job, { number });
      }
      await readPhoneState(job, { number: "+15555550198" });
      for (const tokenSha256 of [
        CHECK_TESTER_TOKEN,
        SECOND_TOKEN,
        SAM_LIVE_TOKEN,
        SAM_SIGNED_OUT_TOKEN,
        UNKNOWN_TOKEN,
      ]) {
        for (const at of [SAM_READ_AT, READ_AT]) {
          await readTesterStanding(job, { tokenSha256, at });
        }
      }
      await thrownBy(readRosterPhone(job, { handleId: SAM_NUMBER }));
      await thrownBy(readPhoneState(job, { number: "not a number" }));
      await thrownBy(readTesterStanding(app, { tokenSha256: CHECK_TESTER_TOKEN, at: READ_AT }));
      await thrownBy(readPhoneState(app, { number: SAM_NUMBER }));
      expect(await fingerprint()).toEqual(before);
      // The sessions, the team rows and the chat links are among what stayed as it was.
      expect(before.sessions).toMatch(/^4 rows, /);
      expect(before.team_page_recipients).toMatch(/^2 rows, /);
      expect(before.chat_links).toMatch(/^3 rows, /);
    },
  );
});

// ---- the statements the reads send ------------------------------------------------------------------------------------

/**
 * Each read's statements, in its item's order, as sent (whitespace folded, each parameter as `$`, a list of parameters,
 * session_for_token's two arguments among them, as `($...)`): one table or the one function each, but item 68's step 2,
 * which reads the two tester lists in one statement (v1.15 default 136); no join, no `*`.
 */
const STEP_STATEMENTS: Readonly<Record<Call, readonly string[]>> = {
  readTesterStanding: [
    "select person_id from session_for_token($...)",
    "select exists ( select 1 from team_page_recipients where person_id = $ and removed_at is null ) or exists ( select 1 from staging_testers where person_id = $ and removed_at is null ) as tester",
  ],
  readRosterPhone: [
    "select address from handles where id = $ and kind = 'phone'",
    "select person_id from person_handles where handle_id = $ limit 2",
    "select handle_id from person_handles where person_id = $",
    "select address from handles where id in ($...) and kind = 'email' limit 2",
  ],
  readPhoneState: [
    "select chat_open, stopped, stop_at from phones where number = $",
    'select short_code, ready_text from chat_links where phone_number = $ order by issued_at desc, id collate "C" limit 1',
  ],
};

/** The tables no statement may name a column of (README v1.12 "What the new tasks must hold to"). */
const NEVER_READ = ["sealing_keys", "messages", "consents", "proof_codes"];
/** The hashes no statement may name, and the sessions table, which item 53 reads through K-22's function alone. */
const NEVER_NAMED = ["token_sha256", "device_sha256", "code_hash", "sessions"];
/**
 * The tables the three reads read (K-22 v1.3's staging_testers by v1.15's item 68), whose columns a statement may name,
 * and K-22's function.
 */
const OWN_TABLES = [
  "team_page_recipients",
  "staging_testers",
  "handles",
  "person_handles",
  "phones",
  "chat_links",
];
const FUNCTION = "session_for_token";

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

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();
/** The statement with each parameter as `$` and each list of parameters as `($...)`. */
const canonical = (text: string): string =>
  normalized(text)
    .replace(/\$\d+/g, "$")
    .replace(/\(\s*\$(?:\s*,\s*\$)*\s*\)/g, "($...)");
/** Whether a statement reads a table of this file's schema or K-22's function. */
const readsSomething = (text: string): boolean =>
  tokensOf(text).some((token) => schemaColumns.has(token) || token === FUNCTION);

/**
 * The names no statement may hold: the hashes, the sessions table, the four tables and every column of theirs that none of
 * the three reads' own tables has (session_for_token's person_id among those that have one).
 */
function neverNamed(): Set<string> {
  const own = new Set(OWN_TABLES.flatMap((table) => [...(schemaColumns.get(table) ?? [])]));
  const theirs = NEVER_READ.flatMap((table) => [...(schemaColumns.get(table) ?? [])]);
  return new Set([...NEVER_NAMED, ...NEVER_READ, ...theirs.filter((column) => !own.has(column))]);
}

/** The names a statement holds that no statement may hold. */
function namedWrongly(statement: string): string[] {
  const forbidden = neverNamed();
  return [...new Set(tokensOf(statement).filter((token) => forbidden.has(token)))].sort();
}

/** What no answer of each read may hold: an id of a person, a session, a team row, a code, a business or a link. */
const NEVER_ANSWERED: Readonly<Record<Call, readonly string[]>> = {
  readTesterStanding: ["person-", "session-", "team-", "staging-", "code-", "handle-", "@", "+1555", "biz-"],
  readRosterPhone: ["person-", "session-", "team-", "code-", "biz-", "chatlink-", "role-", "Sam", "Alex"],
  readPhoneState: [
    "+1555",
    "person-",
    "handle-",
    "biz-",
    "booking-",
    "chatlink-",
    "staff_invite",
    "session-",
  ],
};

describe("the statements the reads send: items 53 to 55's reads as written, their columns alone, no hash named, never a column of sealing_keys, messages, consents or proof_codes", () => {
  it("the tables these checks name, their hash columns and K-22's function exist in this schema, so the checks below are about real names", async () => {
    for (const table of [...NEVER_READ, ...OWN_TABLES, "sessions"]) {
      expect(schemaColumns.has(table), table).toBe(true);
    }
    expect(schemaColumns.get("sessions")?.has("token_sha256")).toBe(true);
    expect(schemaColumns.get("sessions")?.has("device_sha256")).toBe(true);
    expect(schemaColumns.get("proof_codes")?.has("code_hash")).toBe(true);
    const [fn] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = ${db.schema} and p.proname = ${FUNCTION}
    `;
    expect(fn?.n).toBe(1);
  });

  it("the check refuses a hash named, the sessions table read straight and a column of sealing_keys, messages, consents or proof_codes (shown on statements made to fail), and passes the reads' own", () => {
    const caught: { statement: string; names: string[] }[] = [
      {
        statement: "select person_id from sessions where token_sha256 = $1 and ended_at is null",
        names: ["sessions", "token_sha256"],
      },
      {
        statement: 'select id from "sessions" where device_sha256 = $1',
        names: ["device_sha256", "sessions"],
      },
      { statement: "select code_hash from proof_codes where id = $1", names: ["code_hash", "proof_codes"] },
      {
        statement: "select k.wrapped_key from sealing_keys k where k.person_id = $1",
        names: ["sealing_keys", "wrapped_key"],
      },
      { statement: "select words from messages where person_id = $1", names: ["messages", "words"] },
      {
        statement: "select exact_words, words_sha256 from consents where person_id = $1",
        names: ["consents", "exact_words", "words_sha256"],
      },
      {
        statement:
          "select person_id from team_page_recipients where person_id in (select person_id from consents)",
        names: ["consents"],
      },
    ];
    for (const { statement, names } of caught) {
      const found = namedWrongly(statement);
      for (const name of names) {
        expect(found, statement).toContain(name);
      }
    }
    // The reads' own statements pass, with parameters as postgres.js binds them, and each is canonical.
    const own: [Call, number, string][] = [
      [STANDING, 0, "select person_id from session_for_token($1, $2)"],
      [
        STANDING,
        1,
        "select exists (\n      select 1 from team_page_recipients where person_id = $1 and removed_at is null\n    ) or exists (\n      select 1 from staging_testers where person_id = $2 and removed_at is null\n    ) as tester",
      ],
      [ROSTER_PHONE, 0, "select address from handles where id = $1 and kind = 'phone'"],
      [ROSTER_PHONE, 1, "select person_id from person_handles where handle_id = $1 limit 2"],
      [ROSTER_PHONE, 2, "select handle_id from person_handles where person_id = $1"],
      [ROSTER_PHONE, 3, "select address from handles where id in ($1,$2) and kind = 'email' limit 2"],
      [PHONE_STATE, 0, "select chat_open, stopped, stop_at from phones where number = $1"],
      [
        PHONE_STATE,
        1,
        'select short_code, ready_text from chat_links where phone_number = $1\n  order by issued_at desc, id collate "C" limit 1',
      ],
    ];
    for (const [call, index, statement] of own) {
      expect(namedWrongly(statement), statement).toEqual([]);
      expect(canonical(statement)).toBe(STEP_STATEMENTS[call][index]);
    }
  });

  it(
    "over every fixture and every case: one read-only transaction per read, each item's reads in its order and as written, no hash or forbidden column named, the hash bound as session_for_token's first argument alone, no number, email or hash in a statement's text, nothing logged, and no answer holding more than its definition gives",
    HEAVY,
    async () => {
      const runs = await everyRun();
      expect(runs).toHaveLength(ACCEPTED.length + CASES.length);
      const stepsSeen: Record<Call, Set<number>> = {
        readTesterStanding: new Set(),
        readRosterPhone: new Set(),
        readPhoneState: new Set(),
      };
      for (const run of runs) {
        const { label, call } = run;
        expect(run.logged, label).toBe(0);
        expect(run.outcome, label).not.toBeInstanceOf(Error);
        expect(answerErrors(call, run.outcome), label).toEqual([]);
        const answer = run.outcome as Row;

        // One transaction: one read-only begin on one connection, the scope emptied, the reads, then commit.
        const begins = run.statements.filter((statement) => statement.text.startsWith("begin"));
        expect(
          begins.map((statement) => statement.text),
          label,
        ).toEqual(["begin isolation level repeatable read read only"]);
        const begin = run.statements.findIndex((statement) => statement.text.startsWith("begin"));
        const connection = run.statements[begin]?.connection;
        const inside = run.statements.slice(begin + 1);
        const end = inside.findIndex(
          (statement) => statement.text === "commit" || statement.text === "rollback",
        );
        expect(end, label).toBeGreaterThan(1);
        expect(inside[end]?.text, label).toBe("commit");
        expect(normalized(inside[0]?.text ?? ""), label).toBe("select set_config($1, '', true)");
        const reads = inside.slice(1, end);
        for (const statement of reads) {
          expect(statement.connection, label).toBe(connection);
        }
        // Outside the transaction nothing reads a table (inRuntimeTransaction's `select 1` alone).
        const outside = [...run.statements.slice(0, begin), ...inside.slice(end + 1)];
        for (const statement of outside) {
          expect(readsSomething(statement.text), `${label}: ${statement.text}`).toBe(false);
        }

        // The item's reads, in its order, each as written, each once: steps 1 to k.
        const written = STEP_STATEMENTS[call];
        const steps = reads.map((statement) => written.indexOf(canonical(statement.text)) + 1);
        expect(steps, `${label}: ${reads.map((statement) => statement.text).join(" | ")}`).toEqual(
          steps.map((_, index) => index + 1),
        );
        for (const step of steps) {
          stepsSeen[call].add(step);
        }

        // No statement names a hash, the sessions table or a column of the four tables.
        for (const statement of run.statements) {
          expect(namedWrongly(statement.text), `${label}: ${statement.text}`).toEqual([]);
        }

        // No number, email address, hash, short code or ready text in a statement's text.
        const secrets = secretsOf(call, run.request, run.outcome);
        for (const statement of run.statements) {
          for (const secret of secrets) {
            expect(statement.text.includes(secret), `${label}: ${statement.text}`).toBe(false);
          }
        }

        const text = JSON.stringify(run.outcome);
        for (const value of NEVER_ANSWERED[call]) {
          expect(text.includes(value), `${label}: ${value}`).toBe(false);
        }
        switch (call) {
          case STANDING: {
            // The hash: session_for_token's first argument, with the time, and in no other statement's parameters.
            const hash = textOf(run.request.tokenSha256, "the request's hash");
            const first = reads[0];
            expect(first?.parameters.length, label).toBe(2);
            expect(first?.parameters[0], label).toBe(hash);
            const at = first?.parameters[1];
            expect(at instanceof Date ? utc(at) : at, label).toBe(run.request.at);
            for (const statement of run.statements) {
              if (statement !== first) {
                expect(statement.parameters.includes(hash), `${label}: ${statement.text}`).toBe(false);
              }
            }
            expect(Object.keys(answer), label).toEqual(["standing"]);
            expect(text.includes(hash), label).toBe(false);
            expect(steps.length, label).toBe(answer.standing === "noSession" ? 1 : 2);
            break;
          }
          case ROSTER_PHONE: {
            // The handle's id bound, never named; the number and the email read, never sent.
            const handleId = textOf(run.request.handleId, "the request's handle id");
            expect(reads[0]?.parameters, label).toEqual([handleId]);
            if (reads[1] !== undefined) {
              expect(reads[1].parameters, label).toEqual([handleId]);
            }
            for (const statement of run.statements) {
              expect(statement.text.includes(handleId), `${label}: ${statement.text}`).toBe(false);
              for (const secret of secrets) {
                expect(statement.parameters.includes(secret), `${label}: ${statement.text}`).toBe(false);
              }
            }
            expect(Object.keys(answer).sort(), label).toEqual(["handleId", "phone"]);
            expect(answer.handleId, label).toBe(handleId);
            expect(text.match(/handle-[A-Za-z0-9_.:/#-]+/g) ?? [], label).toEqual([handleId]);
            const phone = answer.phone as Row | null;
            if (phone === null) {
              expect(steps, label).toEqual([1]);
            } else {
              expect(Object.keys(phone).sort(), label).toEqual(["email", "number"]);
              expect(steps.length, label).toBeGreaterThan(1);
              if (phone.email !== null) {
                expect(steps, label).toEqual([1, 2, 3, 4]);
              }
            }
            break;
          }
          case PHONE_STATE: {
            // The number: the one parameter of each of item 55's reads, and of no other statement.
            const number = textOf(run.request.number, "the request's number");
            for (const statement of reads) {
              expect(statement.parameters, `${label}: ${statement.text}`).toEqual([number]);
            }
            for (const statement of [...run.statements.slice(0, begin + 2), ...inside.slice(end)]) {
              expect(statement.parameters.includes(number), `${label}: ${statement.text}`).toBe(false);
            }
            expect(Object.keys(answer).sort(), label).toEqual(["chatLink", "phone"]);
            expect(steps.length, label).toBe(answer.phone === null ? 1 : 2);
            break;
          }
        }
      }
      // Every one of each item's reads was sent by some run.
      expect([...stepsSeen.readTesterStanding].sort()).toEqual([1, 2]);
      expect([...stepsSeen.readRosterPhone].sort()).toEqual([1, 2, 3, 4]);
      expect([...stepsSeen.readPhoneState].sort()).toEqual([1, 2]);
    },
  );
});

describe("a lost connection answers transient, with no number, hash or connection string (K-05 transientError)", () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** The backend of `applicationName` once it waits on a lock, polling every 20 ms for at most 20 s. */
  async function lockWaiter(applicationName: string): Promise<number> {
    for (let tries = 0; tries < 1000; tries += 1) {
      const [row] = await db.sql<{ pid: number }[]>`
        select pid from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'
      `;
      if (row !== undefined) {
        return row.pid;
      }
      await pause(20);
    }
    throw new Error(`waited 20 s, and ${applicationName} never waited on a lock`);
  }

  /** Each read, with a table it reads and a fixture whose read reaches that table (item 68's listings among them). */
  const CUTS: readonly { call: Call; table: string; fixture: string }[] = [
    { call: STANDING, table: "team_page_recipients", fixture: "read-tester-standing-check-tester.json" },
    { call: STANDING, table: "staging_testers", fixture: "read-tester-standing-human-tester.json" },
    { call: ROSTER_PHONE, table: "handles", fixture: "read-roster-phone-email-on-file.json" },
    { call: PHONE_STATE, table: "phones", fixture: "read-phone-state-chat-link.json" },
  ];

  for (const cut of CUTS) {
    it(
      `${cut.call}, its backend terminated while it waits on ${cut.table}, answers transient with its SQLSTATE alone, writes nothing, and the same request then answers`,
      SLOW,
      async () => {
        const exchange = await given(cut.fixture);
        const url = new URL(resolvePrimaryUrl());
        const neverInAnswer = [
          ...secretsOf(cut.call, exchange.request, exchange.outcome),
          CHECK_TESTER,
          TESTER_ONE,
          SAM,
          SAM_HANDLE,
          resolvePrimaryUrl(),
          url.host,
          url.username,
          url.password,
        ].filter((value) => value !== "");
        const before = await fingerprint();
        const application = `rosie-t1300-cut-${cut.table}`;
        // A one-connection rosie_job client of its own; its one connection is dead after, and never released
        // (targets.ts inRuntimeTransaction), so it is closed at once.
        const victim = roleClient(JOB_ROLE, application, 1, false);
        let outcome: unknown;
        try {
          outcome = await db.sql.begin(async (tx) => {
            await tx`lock table ${tx(cut.table)} in access exclusive mode`;
            const pending = READS[cut.call](victim, exchange.request);
            const pid = await lockWaiter(application);
            await db.sql`select pg_terminate_backend(${pid})`;
            return pending;
          });
        } finally {
          await victim.end({ timeout: 0 });
        }
        expect(outcome).toMatchObject({ error: "transient" });
        expect(Object.keys(outcome as object).sort()).toEqual(["error", "sqlstate"]);
        expect((outcome as { sqlstate: string }).sqlstate).toMatch(/^(08[0-9A-Z]{3}|57P0[123])$/);
        expect(answerErrors(cut.call, outcome)).toEqual([]);
        const text = JSON.stringify(outcome);
        for (const value of neverInAnswer) {
          expect(text.includes(value), value).toBe(false);
        }
        expect(await fingerprint()).toEqual(before);
        expect(await READS[cut.call](job, exchange.request)).toEqual(exchange.outcome);
      },
    );
  }
});
