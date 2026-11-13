// T-1269: K-05 v1.11's readTurnParty (item 52), the handle's party for a turn, against local PostgreSQL (`npm run
// db:up`; `npm run test:integration -- db/repo/turn-party`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The read runs as K-05 v1.11 names it (item 52; README "The call v1.11 adds"): through a client whose connections run as
// rosie_job, the runtime side's role, with no business scope, so the grants and row-level security are the ones the read
// meets; the role is the connection's. The tables' owner (the migrations' role) loads the K-04 seeds a fixture's `given`
// names and writes the rows a fixture's note lists and a case adds. Where a note names T-1148's SKELETON_ROWS, T-1148's
// own seed writes them (db/seeds/skeleton.ts seedSkeleton, as rosie_job); a fixture's `after` step, the gateway's
// handleSealingKey, runs for real as rosie_job with a wrapping key made for this run (random: never a real key, never
// read from the environment). Every answer is checked against its data-access v1.11 definition with Ajv 2020-12, strict,
// as contracts:check runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its parameters,
// kept in memory for the checks and never printed), so the checks read what the read sent, not a copy of its SQL: one
// read-only transaction per read; item 52's six reads in its order, each the statement item 52 names; only the columns
// item 52's consumers line lists; the address bound as step 1's one parameter and named nowhere else; and no column of
// sealing_keys, phones, threads, messages, bookings or consents.
//
// Names are the master's sample cast and fixture set v1's demo shops as K-04's seeds hold them (rule 9). The people,
// handles, companies and businesses a case adds carry example ids (t1269), no name or a made-up one, and numbers in the
// fiction range 555-0100 to 555-0199.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedSkeleton } from "../seeds/skeleton";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { handleSealingKey, type HandleSealingKeyRequest } from "./handle-keys";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { BrokenRecordError } from "./turn-face-reads";
import {
  type BusinessUndecidedError,
  readTurnParty,
  type ReadTurnPartyOutcome,
  type ReadTurnPartyRequest,
} from "./turn-party";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
type Handle = ReadTurnPartyRequest["handle"];

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
const WRAP_NAME = "SEALING_WRAP_KEY";
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 240_000 };

const BUSINESS_HEAD = "seed-business-head.json";
const PERSON_ROLES = "seed-person-roles.json";

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const HOME_SERVICES = "biz-lee-home-services";
/** A business this file adds, in another zone than the seeds' three, so a zone is seen to be the business's own. */
const WEST = "biz-t1269-west";
const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";

const SAM = "person-sam";
const SAM_HANDLE = "handle-sam";
const SAM_NUMBER = "+15555550100";
const RILEY_HANDLE = "handle-riley";
const RILEY_NUMBER = "+15555550102";
const TOMAS_NUMBER = "+15555550105";
const HUGO = "person-hugo";
/** A customer of the barbershop this file adds, and the handle they write from. */
const CUSTOMER = "person-t1269-customer";
const CUSTOMER_HANDLE = "handle-t1269-customer";
const CUSTOMER_NUMBER = "+15555550161";
/** The yoga studio's owner in one case, who writes from no handle of this file. */
const YOGA_OWNER = "person-t1269-yoga-owner";
/** A staff member of WEST, and the handle they write from. */
const WEST_STAFF = "person-t1269-west";
const WEST_HANDLE = "handle-t1269-west";
const WEST_NUMBER = "+15555550162";
/** S11-100's handover time (read-turn-party-owner-role-ended): Mon Nov 30 at 9:00am in New York. */
const HANDOVER = "2026-11-30T14:00:00Z";
/** A last day still to come: after the database's now() (checked below), so a role ending then has ended_at set. */
const LATER = "2027-03-01T00:00:00Z";

interface Given {
  k04Seeds: string[];
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
const requestOf = (exchange: Exchange): ReadTurnPartyRequest =>
  exchange.request as unknown as ReadTurnPartyRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** Item 52's accepted exchanges, as the index lists them. */
const PARTY_FIXTURES = INDEX.filter(
  (entry) => entry.expect === "accept" && entry.def === "readTurnParty.exchange",
).map((entry) => entry.file);
/** Their refused twins, each refused by one of readTurnParty's definitions. */
const REFUSED_FIXTURES = INDEX.filter(
  (entry) => entry.expect === "refuse" && (entry.def ?? "").startsWith("readTurnParty."),
);
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** This run's wrapping key for the gateway's handleSealingKey in a chain: random, never a real key or the environment's. */
const WRAP_KEY = new Uint8Array(randomBytes(32));
const WRAPPING_KEYS = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? WRAP_KEY : undefined),
};

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
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
const V111_ID = (readJson(new URL("data-access/data-access.v1.11.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.11, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V111_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.11 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer checked against its own definition: an error against readTurnParty.errors, else readTurnParty.response. */
function answerErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? "readTurnParty.errors" : "readTurnParty.response", outcome);
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
  db = await createTestDatabase({ name: "turn_party" });
  job = roleClient(JOB_ROLE, "rosie-t1269-job", 5, true);
  app = roleClient(APP_ROLE, "rosie-t1269-app", 2, false);
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
  await db.sql`truncate businesses, persons, handles restart identity cascade`;
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

/** A K-04 seed file's rows after those of its `after` chain, each file once. */
function seedRows(file: string, seen: Set<string>): TableRow[] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

/** A fixture's chain: the K-04 seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: string[]; steps: string[] } {
  const exchange = exchangeOf(file);
  const seeds = [...exchange.given.k04Seeds];
  const steps: string[] = [];
  for (const before of exchange.given.after) {
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

/** Empties the tables and loads K-04's seeds, as the owner, in one transaction. */
async function loadSeeds(seeds: readonly string[]): Promise<void> {
  await reset();
  const seen = new Set<string>();
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** Runs a chain's step for real: the gateway's handleSealingKey (K-05 v1.2 item 29), as rosie_job. */
async function runStep(file: string): Promise<void> {
  const step = exchangeOf(file);
  if (step.call !== "handleSealingKey") {
    throw new Error(`${file}: this test runs no ${step.call} step`);
  }
  const result = await handleSealingKey(
    job,
    WRAPPING_KEYS,
    step.request as unknown as HandleSealingKeyRequest,
    { now: new Date(step.given.now) },
  );
  expect(result.outcome, file).toEqual(step.outcome);
}

/** T-1148's seed (when asked), then `rows`, as the owner, in one transaction. */
async function writeRows(skeleton: boolean, rows: readonly TableRow[]): Promise<void> {
  if (skeleton) {
    await seedSkeleton(db.sql);
  }
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

// ---- the rows five fixtures' notes list (README "v1.11" fixtures: their database side writes them itself) ---------------

const person = (id: string, name: string | null = null): TableRow => ({
  table: "persons",
  values: { id, name, language: null },
});
const phoneHandle = (id: string, address: string): TableRow => ({
  table: "handles",
  values: { id, kind: "phone", address },
});
const link = (personId: string, handleId: string): TableRow => ({
  table: "person_handles",
  values: { person_id: personId, handle_id: handleId },
});
const role = (
  id: string,
  personId: string,
  businessId: string,
  kind: string,
  endedAt: string | null = null,
): TableRow => ({
  table: "person_roles",
  values: { id, person_id: personId, business_id: businessId, role: kind, ended_at: endedAt },
});
const company = (id: string, ownerPersonId: string, businessId: string | null): TableRow => ({
  table: "companies",
  values: { id, owner_person_id: ownerPersonId, name: "T-1269 example company", business_id: businessId },
});
const business = (id: string, zone: string): TableRow => ({
  table: "businesses",
  values: {
    id,
    name: "T-1269 example business",
    display_name: "T-1269 example business",
    status: "saved",
    time_zone: zone,
  },
});

/** What a note lists: T-1148's SKELETON_ROWS (written by its own seed) and the rows after them, value for value. */
interface NoteRows {
  skeleton: boolean;
  rows: TableRow[];
}

const NOTE_ROWS: Readonly<Record<string, NoteRows>> = {
  "read-turn-party-test-owner-1.json": { skeleton: true, rows: [] },
  "read-turn-party-several-companies.json": {
    skeleton: true,
    rows: [
      {
        table: "businesses",
        values: {
          id: HOME_SERVICES,
          name: "Lee Home Services",
          display_name: "Lee Home Services",
          status: "saved",
          time_zone: NEW_YORK,
          text_hours_start: "08:00",
          text_hours_end: "20:00",
          version: 1,
        },
      },
      {
        table: "companies",
        values: {
          id: "company-lee-home-services",
          owner_person_id: SAM,
          name: "Lee Home Services LLC",
          business_id: HOME_SERVICES,
          version: 2,
        },
      },
    ],
  },
  "read-turn-party-sign-up-before-business.json": {
    skeleton: false,
    rows: [
      { table: "persons", values: { id: SAM, name: "Sam Lee", language: null, version: 1 } },
      phoneHandle(SAM_HANDLE, SAM_NUMBER),
      link(SAM, SAM_HANDLE),
      {
        table: "companies",
        values: {
          id: "company-lee-home-services",
          owner_person_id: SAM,
          name: "Lee Home Services LLC",
          business_id: null,
          version: 1,
        },
      },
      {
        table: "companies",
        values: {
          id: "company-lees-barbershop",
          owner_person_id: SAM,
          name: "Lee's Barbershop LLC",
          business_id: null,
          version: 1,
        },
      },
    ],
  },
  "read-turn-party-handed-over.json": {
    skeleton: true,
    rows: [
      { table: "persons", values: { id: HUGO, name: "Hugo P.", language: null, version: 1 } },
      {
        table: "person_roles",
        values: {
          id: "role-hugo-barber",
          person_id: HUGO,
          business_id: BARBERSHOP,
          role: "owner",
          ended_at: null,
          version: 1,
        },
      },
    ],
  },
  "read-turn-party-owner-role-ended.json": {
    skeleton: true,
    rows: [
      {
        table: "person_roles",
        values: {
          id: "role-sam-barber",
          person_id: SAM,
          business_id: BARBERSHOP,
          role: "owner",
          ended_at: HANDOVER,
          version: 2,
        },
      },
    ],
  },
};

/** Loads a fixture's seeds, runs its chain's steps for real and writes the rows its note lists. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    await runStep(step);
  }
  const note = NOTE_ROWS[file];
  if (note !== undefined) {
    await writeRows(note.skeleton, note.rows);
  }
  return exchange;
}

// ---- item 52's consumers line, case by case ("What the new tasks must hold to"), with the lead's note (DL-511) ----------

interface Case {
  /** What the case shows, for the test's name. */
  readonly shows: string;
  readonly seeds: readonly string[];
  /** Whether T-1148's seed writes test owner 1's rows (Sam, his handle and the barbershop's company) first. */
  readonly skeleton: boolean;
  readonly rows: readonly TableRow[];
  /** What the owner changes after the rows (an update or a delete the case needs). */
  readonly then?: (sql: Sql) => Promise<unknown>;
  readonly handle: Handle;
  readonly outcome: ReadTurnPartyOutcome;
}

const phone = (address: string): Handle => ({ kind: "phone", address });
const UNKNOWN: ReadTurnPartyOutcome = { handleId: null, businessId: null, personId: null, zone: null };
const undecided = (
  reason: BusinessUndecidedError["reason"],
  handleId: string,
  personId: string | null,
): BusinessUndecidedError => ({ error: "businessUndecided", reason, handleId, personId });

/** The barbershop's customer this file adds: a live customer role at Lee's Barbershop, whose live owner role is Sam's. */
const CUSTOMER_ROWS: readonly TableRow[] = [
  person(CUSTOMER),
  phoneHandle(CUSTOMER_HANDLE, CUSTOMER_NUMBER),
  link(CUSTOMER, CUSTOMER_HANDLE),
  role("role-t1269-customer-barber", CUSTOMER, BARBERSHOP, "customer"),
];
/** Hugo P. with the barbershop's live owner role from the handover (read-turn-party-handed-over's note). */
const HUGO_OWNER_ROWS: readonly TableRow[] = [
  person(HUGO, "Hugo P."),
  role("role-hugo-barber", HUGO, BARBERSHOP, "owner"),
];

const CASES: readonly Case[] = [
  {
    shows:
      "two people on one handle whose live roles name one business (Riley and Avery, both barbershop staff): that business, personId null",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [link("person-avery", RILEY_HANDLE)],
    handle: phone(RILEY_NUMBER),
    outcome: { handleId: RILEY_HANDLE, businessId: BARBERSHOP, personId: null, zone: NEW_YORK },
  },
  {
    shows:
      "two people on one handle whose live roles name two businesses (Riley at the barbershop, Maya at the yoga studio): severalBusinesses, personId null",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [link("person-maya", RILEY_HANDLE)],
    handle: phone(RILEY_NUMBER),
    outcome: undecided("severalBusinesses", RILEY_HANDLE, null),
  },
  {
    shows: "a live role at one business beside a company with no business yet: severalBusinesses",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [company("company-t1269-riley-sign-up", "person-riley", null)],
    handle: phone(RILEY_NUMBER),
    outcome: undecided("severalBusinesses", RILEY_HANDLE, "person-riley"),
  },
  {
    shows:
      "a live customer role at a business whose live owner role another person holds, and no company: that business",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: CUSTOMER_ROWS,
    handle: phone(CUSTOMER_NUMBER),
    outcome: { handleId: CUSTOMER_HANDLE, businessId: BARBERSHOP, personId: CUSTOMER, zone: NEW_YORK },
  },
  {
    shows:
      "a live customer role and a company at a business whose live owner role another person holds: anotherOwner",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [...CUSTOMER_ROWS, company("company-t1269-customer", CUSTOMER, BARBERSHOP)],
    handle: phone(CUSTOMER_NUMBER),
    outcome: undecided("anotherOwner", CUSTOMER_HANDLE, CUSTOMER),
  },
  {
    shows:
      "a company at a business where one of the handle's people holds the live owner role beside an ended staff role: that business",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [
      role("role-t1269-sam-owner", SAM, BARBERSHOP, "owner"),
      role("role-t1269-sam-staff-ended", SAM, BARBERSHOP, "staff", "2026-09-30T12:00:00Z"),
    ],
    handle: phone(SAM_NUMBER),
    outcome: { handleId: SAM_HANDLE, businessId: BARBERSHOP, personId: SAM, zone: NEW_YORK },
  },
  {
    shows:
      "a role whose ended_at is after now is ended: Riley's one staff role with a last day still to come leaves no business",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [],
    then: (sql) =>
      sql`update person_roles set ended_at = ${LATER}, version = version + 1 where id = 'role-riley-barber'`,
    handle: phone(RILEY_NUMBER),
    outcome: { handleId: RILEY_HANDLE, businessId: null, personId: "person-riley", zone: null },
  },
  {
    shows:
      "a role whose ended_at is after now is ended: the company's business where the one owner role of theirs ends later: roleEnded",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [role("role-t1269-sam-owner-to-end", SAM, BARBERSHOP, "owner", LATER)],
    handle: phone(SAM_NUMBER),
    outcome: undecided("roleEnded", SAM_HANDLE, SAM),
  },
  {
    shows:
      "three reasons at once (default 100's order): anotherOwner, though roleEnded's business, the barbershop, sorts before the yoga studio",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [
      role("role-t1269-sam-barber-ended", SAM, BARBERSHOP, "owner", HANDOVER),
      person(YOGA_OWNER),
      role("role-t1269-yoga-owner", YOGA_OWNER, YOGA, "owner"),
      company("company-t1269-sam-yoga", SAM, YOGA),
    ],
    handle: phone(SAM_NUMBER),
    outcome: undecided("anotherOwner", SAM_HANDLE, SAM),
  },
  {
    shows: "two reasons at once (default 100's order): roleEnded before severalBusinesses",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [
      role("role-t1269-sam-barber-ended", SAM, BARBERSHOP, "owner", HANDOVER),
      role("role-t1269-sam-yoga-customer", SAM, YOGA, "customer"),
    ],
    handle: phone(SAM_NUMBER),
    outcome: undecided("roleEnded", SAM_HANDLE, SAM),
  },
  {
    shows: "two reasons at once (default 100's order): anotherOwner before severalBusinesses",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [...HUGO_OWNER_ROWS, role("role-t1269-sam-yoga-customer", SAM, YOGA, "customer")],
    handle: phone(SAM_NUMBER),
    outcome: undecided("anotherOwner", SAM_HANDLE, SAM),
  },
  {
    shows:
      "the lead's note (DL-511): two live owner roles at the company's business, one held by the handle's person: anotherOwner, the closed reading",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [role("role-t1269-sam-owner", SAM, BARBERSHOP, "owner"), ...HUGO_OWNER_ROWS],
    handle: phone(SAM_NUMBER),
    outcome: undecided("anotherOwner", SAM_HANDLE, SAM),
  },
  {
    shows:
      "the company's business with the one live owner role the handle's person's own: that business (default 99: the company agrees)",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [role("role-t1269-sam-owner", SAM, BARBERSHOP, "owner")],
    handle: phone(SAM_NUMBER),
    outcome: { handleId: SAM_HANDLE, businessId: BARBERSHOP, personId: SAM, zone: NEW_YORK },
  },
  {
    shows:
      "the business's live owner role held by a person who writes from the handle too: that business, personId null, not anotherOwner",
    seeds: [BUSINESS_HEAD],
    skeleton: true,
    rows: [...HUGO_OWNER_ROWS, link(HUGO, SAM_HANDLE)],
    handle: phone(SAM_NUMBER),
    outcome: { handleId: SAM_HANDLE, businessId: BARBERSHOP, personId: null, zone: NEW_YORK },
  },
  {
    shows:
      "a request whose kind is not the stored handle's: unknown, every field null (Sam's number named as an email handle)",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [],
    handle: { kind: "email", address: SAM_NUMBER },
    outcome: UNKNOWN,
  },
  {
    shows:
      "a request whose kind is not the stored handle's: unknown, every field null (Alex's email address named as a phone)",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [],
    handle: { kind: "phone", address: "alex@example.com" },
    outcome: UNKNOWN,
  },
  {
    shows:
      "an email handle is read by its kind too: Alex's email address, his live customer roles at two businesses: severalBusinesses",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [],
    handle: { kind: "email", address: "alex@example.com" },
    outcome: undecided("severalBusinesses", "handle-alex-email", "person-alex"),
  },
  {
    shows: "the zone is the one business's own: a staff role at a business in Los Angeles gives its zone",
    seeds: [BUSINESS_HEAD],
    skeleton: false,
    rows: [
      business(WEST, LOS_ANGELES),
      person(WEST_STAFF),
      phoneHandle(WEST_HANDLE, WEST_NUMBER),
      link(WEST_STAFF, WEST_HANDLE),
      role("role-t1269-west-staff", WEST_STAFF, WEST, "staff"),
    ],
    handle: phone(WEST_NUMBER),
    outcome: { handleId: WEST_HANDLE, businessId: WEST, personId: WEST_STAFF, zone: LOS_ANGELES },
  },
  {
    shows:
      "a handle no person writes from: no business and no person (default 4), whatever roles the person it named holds",
    seeds: [PERSON_ROLES],
    skeleton: false,
    rows: [],
    then: (sql) => sql`delete from person_handles where handle_id = 'handle-tomas'`,
    handle: phone(TOMAS_NUMBER),
    outcome: { handleId: "handle-tomas", businessId: null, personId: null, zone: null },
  },
];

/** Loads a case's seeds, T-1148's seed when it asks, its rows, and what it changes after them. */
async function givenCase(spec: Case): Promise<void> {
  await loadSeeds(spec.seeds);
  await writeRows(spec.skeleton, spec.rows);
  if (spec.then !== undefined) {
    await spec.then(db.sql);
  }
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

/** One read run: its label, the address it asked about, what it sent, its outcome and how often it logged. */
interface Run {
  label: string;
  address: string;
  statements: Sent[];
  outcome: unknown;
  logged: number;
}

/** Runs one read on the rosie_job client, keeping the statements it sent. */
async function watched(label: string, handle: Handle): Promise<Run> {
  sent.length = 0;
  const { outcome, logged } = await unlogged(() => readTurnParty(job, { handle }));
  return { label, address: handle.address, statements: [...sent], outcome, logged };
}

/** Every v1.11 fixture's read and every case's, each over its own rows, with what it sent. */
async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  for (const file of PARTY_FIXTURES) {
    const exchange = await given(file);
    runs.push(await watched(file, requestOf(exchange).handle));
  }
  for (const spec of CASES) {
    await givenCase(spec);
    runs.push(await watched(spec.shows, spec.handle));
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

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the role the read runs as (K-05 v1.11 item 52: rosie_job, no business scope; T-191)", () => {
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
    "a Tool API client's read is refused by PostgreSQL's own privilege check (no grant on handles: 0012), naming no value: no definer function, no bypass",
    SLOW,
    async () => {
      await given("read-turn-party-one-role.json");
      const error = await thrownBy(readTurnParty(app, { handle: phone(RILEY_NUMBER) }));
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      const text = (error as Error).message;
      for (const value of [RILEY_NUMBER, RILEY_HANDLE, BARBERSHOP]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );
});

describe("each v1.11 fixture of item 52 gives its outcome (K-05 v1.11 item 52; defaults 96 to 102)", () => {
  it("the index lists item 52's nine exchanges, each valid against data-access v1.11, and its four refused twins, each refused by its definition", () => {
    expect([...PARTY_FIXTURES].sort()).toEqual([
      "read-turn-party-first-text.json",
      "read-turn-party-handed-over.json",
      "read-turn-party-one-role.json",
      "read-turn-party-owner-role-ended.json",
      "read-turn-party-several-businesses.json",
      "read-turn-party-several-companies.json",
      "read-turn-party-sign-up-before-business.json",
      "read-turn-party-test-owner-1.json",
      "read-turn-party-unknown.json",
    ]);
    for (const file of PARTY_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(exchange.call, file).toBe("readTurnParty");
      expect(schemaErrors("readTurnParty.exchange", exchange), file).toEqual([]);
    }
    expect(REFUSED_FIXTURES.map((entry) => `${entry.file} by ${entry.def ?? ""}`).sort()).toEqual([
      "invalid/refuse-turn-party-business-zone-null.json by readTurnParty.response",
      "invalid/refuse-turn-party-caller-business.json by readTurnParty.exchange",
      "invalid/refuse-turn-party-no-business-zone-utc.json by readTurnParty.response",
      "invalid/refuse-turn-party-undecided-names-businesses.json by readTurnParty.errors",
    ]);
    for (const entry of REFUSED_FIXTURES) {
      const value = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(entry.def ?? "", value), entry.file).not.toEqual([]);
    }
  });

  for (const file of PARTY_FIXTURES) {
    it(
      `${file}: as rosie_job, the read answers the fixture's outcome, valid against its v1.11 definition`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const outcome = await readTurnParty(job, requestOf(exchange));
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(outcome)).toEqual([]);
        expect(schemaErrors("readTurnParty.exchange", { ...exchange, outcome })).toEqual([]);
      },
    );
  }

  it(
    "refuse-turn-party-caller-business: a request naming the business it wants beside the handle is refused before any statement; put right, it is test owner 1's",
    SLOW,
    async () => {
      const twin = await given("read-turn-party-test-owner-1.json");
      const refused = readJson(
        new URL("invalid/refuse-turn-party-caller-business.json", ACCESS_DIR),
      ) as Exchange;
      sent.length = 0;
      const error = await thrownBy(readTurnParty(job, requestOf(refused)));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("readTurnParty: the request takes only handle");
      expect(sent).toEqual([]);
      const { businessId, ...putRight } = refused.request;
      expect(businessId).toBe(BARBERSHOP);
      expect(putRight).toEqual(twin.request);
      expect(await readTurnParty(job, putRight as unknown as ReadTurnPartyRequest)).toEqual(twin.outcome);
    },
  );

  it(
    "refuse-turn-party-business-zone-null, -no-business-zone-utc and -undecided-names-businesses: the read answers each accepted twin, never the refused form, and each refused value put right is its twin's outcome",
    SLOW,
    async () => {
      const refusedOf = (file: string): Row => readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as Row;

      const owner = await given("read-turn-party-test-owner-1.json");
      const zoneNull = refusedOf("refuse-turn-party-business-zone-null.json");
      const atBusiness = await readTurnParty(job, requestOf(owner));
      expect(atBusiness).toEqual(owner.outcome);
      expect(atBusiness).not.toEqual(zoneNull);
      expect({ ...zoneNull, zone: NEW_YORK }).toEqual(owner.outcome);

      const firstText = await given("read-turn-party-first-text.json");
      const zoneUtc = refusedOf("refuse-turn-party-no-business-zone-utc.json");
      const noBusiness = await readTurnParty(job, requestOf(firstText));
      expect(noBusiness).toEqual(firstText.outcome);
      expect(noBusiness).toMatchObject({ businessId: null, zone: null });
      expect(noBusiness).not.toEqual(zoneUtc);
      expect({ ...zoneUtc, zone: null }).toEqual(firstText.outcome);

      const several = await given("read-turn-party-several-businesses.json");
      const named = refusedOf("refuse-turn-party-undecided-names-businesses.json");
      const undecidedAnswer = await readTurnParty(job, requestOf(several));
      expect(undecidedAnswer).toEqual(several.outcome);
      expect(Object.keys(undecidedAnswer).sort()).toEqual(["error", "handleId", "personId", "reason"]);
      const { businessIds, ...withoutBusinesses } = named;
      expect(businessIds).toEqual([BARBERSHOP, MOVERS, YOGA]);
      expect(withoutBusinesses).toEqual(several.outcome);
    },
  );
});

describe("item 52's consumers line, case by case (README v1.11 'What the new tasks must hold to'; defaults 97 to 102; DL-511)", () => {
  it("the cases' later last day is after the database's now(), so a role ending then is one whose ended_at is after now", async () => {
    const [row] = await job<{ later: boolean }[]>`select ${LATER}::timestamptz > now() as later`;
    expect(row?.later).toBe(true);
  });

  for (const spec of CASES) {
    it(spec.shows, SLOW, async () => {
      await givenCase(spec);
      const outcome = await readTurnParty(job, { handle: spec.handle });
      expect(outcome).toEqual(spec.outcome);
      expect(answerErrors(outcome)).toEqual([]);
    });
  }

  it(
    "the company is what turns the customer's business into anotherOwner: the same rows answer the barbershop without it, and anotherOwner once it names the business",
    SLOW,
    async () => {
      await loadSeeds([PERSON_ROLES]);
      await writeRows(false, CUSTOMER_ROWS);
      const request = { handle: phone(CUSTOMER_NUMBER) };
      expect(await readTurnParty(job, request)).toEqual({
        handleId: CUSTOMER_HANDLE,
        businessId: BARBERSHOP,
        personId: CUSTOMER,
        zone: NEW_YORK,
      });
      await writeRows(false, [company("company-t1269-customer", CUSTOMER, BARBERSHOP)]);
      expect(await readTurnParty(job, request)).toEqual(undecided("anotherOwner", CUSTOMER_HANDLE, CUSTOMER));
    },
  );

  it(
    "a record the answer would have to guess around (default 3): the one business's row hidden from rosie_job throws BrokenRecordError, naming no value, and answers nothing",
    SLOW,
    async () => {
      await given("read-turn-party-one-role.json");
      // person_roles_business_fk keeps the row, so a restrictive policy of this file's schema hides the
      // barbershop's row from rosie_job alone, and is dropped after.
      const schema = `"${db.schema}"`;
      try {
        await db.sql.unsafe(
          `create policy t_hide_barbershop on ${schema}.businesses as restrictive for select to ${JOB_ROLE} ` +
            `using (id <> '${BARBERSHOP}')`,
        );
        const run = await watched("hidden business", phone(RILEY_NUMBER));
        expect(run.outcome).toBeInstanceOf(BrokenRecordError);
        expect((run.outcome as Error).message).toBe("readTurnParty: the business the rows give is missing");
        for (const value of [RILEY_NUMBER, RILEY_HANDLE, "person-riley", BARBERSHOP, NEW_YORK]) {
          expect((run.outcome as Error).message.includes(value), value).toBe(false);
        }
        expect(run.statements.at(-1)?.text).toBe("rollback");
        expect(run.logged).toBe(0);
      } finally {
        await db.sql.unsafe(`drop policy if exists t_hide_barbershop on ${schema}.businesses`);
      }
      expect(await readTurnParty(job, { handle: phone(RILEY_NUMBER) })).toEqual(
        exchangeOf("read-turn-party-one-role.json").outcome,
      );
    },
  );

  it(
    "a request of the wrong shape is refused before any statement, naming the field, never a value (default 2)",
    SLOW,
    async () => {
      await given("read-turn-party-one-role.json");
      const refused: [unknown, string][] = [
        [null, "readTurnParty: the request is an object"],
        [[], "readTurnParty: the request is an object"],
        [{}, "readTurnParty: the request needs handle, an object"],
        [{ handle: RILEY_NUMBER }, "readTurnParty: the request needs handle, an object"],
        [
          { handle: phone(RILEY_NUMBER), personId: "person-riley" },
          "readTurnParty: the request takes only handle",
        ],
        [
          { handle: { ...phone(RILEY_NUMBER), id: RILEY_HANDLE } },
          "readTurnParty: handle takes only kind and address",
        ],
        [{ handle: { kind: "sms", address: RILEY_NUMBER } }, "readTurnParty: handle.kind is phone or email"],
        [{ handle: { address: RILEY_NUMBER } }, "readTurnParty: handle.kind is phone or email"],
        [
          { handle: { kind: "phone", address: "5555550102" } },
          "readTurnParty: handle.address is an E.164 number or an email address in lower case",
        ],
        [
          { handle: { kind: "phone", address: "+1 555 555 0102" } },
          "readTurnParty: handle.address is an E.164 number or an email address in lower case",
        ],
        [
          { handle: { kind: "email", address: "Alex@Example.com" } },
          "readTurnParty: handle.address is an E.164 number or an email address in lower case",
        ],
        [
          { handle: { kind: "phone" } },
          "readTurnParty: handle.address is an E.164 number or an email address in lower case",
        ],
      ];
      for (const [request, message] of refused) {
        sent.length = 0;
        const error = await thrownBy(readTurnParty(job, request as ReadTurnPartyRequest));
        expect(error, JSON.stringify(request)).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(message);
        for (const value of [
          "5555550102",
          "555 0102",
          "Alex@Example.com",
          "alex@example.com",
          RILEY_HANDLE,
        ]) {
          expect((error as Error).message.includes(value), value).toBe(false);
        }
        expect(sent).toEqual([]);
      }
    },
  );
});

describe("one read-only transaction per read, and nothing written (item 52: 'writing nothing')", () => {
  it(
    "a write inside the read's own transaction is refused (25006, thrown scrubbed) and leaves nothing; the same write goes through in a transaction that allows it",
    SLOW,
    async () => {
      await given("read-turn-party-one-role.json");
      // A probe that writes whenever a row of handles is read as rosie_job: a policy's function.
      const schema = `"${db.schema}"`;
      const probe = `${schema}.t_write_probe`;
      const probeOf = `${schema}.t_write_probe_of`;
      const probeRows = async (): Promise<number> => {
        const [row] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${probe}`);
        return row?.n ?? -1;
      };
      await db.sql.unsafe(`create table ${probe} (n integer not null)`);
      await db.sql.unsafe(`grant select, insert on ${probe} to ${JOB_ROLE}`);
      await db.sql.unsafe(
        `create function ${probeOf}() returns boolean language plpgsql volatile as $probe$ ` +
          `begin insert into ${probe} (n) values (1); return true; end $probe$`,
      );
      try {
        await db.sql.unsafe(`alter table ${schema}.handles enable row level security`);
        await db.sql.unsafe(
          `create policy t_write_probe on ${schema}.handles for select to ${JOB_ROLE} using (${probeOf}())`,
        );
        // In a transaction that may write, the probe writes when handles is read.
        await job.begin(async (tx) => {
          await tx`select kind from handles where id = ${RILEY_HANDLE}`;
        });
        expect(await probeRows()).toBeGreaterThan(0);
        await db.sql.unsafe(`truncate ${probe}`);
        const before = await fingerprint();
        // In the read's own transaction the same write is refused, so it answers nothing and writes nothing.
        const run = await watched("probe", phone(RILEY_NUMBER));
        expect(run.outcome).toBeInstanceOf(DataAccessDatabaseError);
        expect((run.outcome as DataAccessDatabaseError).code).toBe("25006");
        expect((run.outcome as Error).message).toContain(
          "readTurnParty: the database refused the call (SQLSTATE 25006",
        );
        for (const value of [RILEY_NUMBER, RILEY_HANDLE]) {
          expect((run.outcome as Error).message.includes(value), value).toBe(false);
        }
        expect(run.statements.some((statement) => statement.text === "rollback")).toBe(true);
        expect(await probeRows()).toBe(0);
        expect(await fingerprint()).toEqual(before);
      } finally {
        await db.sql.unsafe(`drop policy if exists t_write_probe on ${schema}.handles`);
        await db.sql.unsafe(`alter table ${schema}.handles disable row level security`);
        await db.sql.unsafe(`drop function if exists ${probeOf}()`);
        await db.sql.unsafe(`drop table if exists ${probe}`);
      }
    },
  );

  it(
    "nothing is written: every table's row count and content are the same before and after a read of every handle, by its own kind and the other, an unknown number, refused requests and the Tool API's role",
    SLOW,
    async () => {
      await given("read-turn-party-first-text.json");
      await writeRows(false, [
        company("company-t1269-riley-sign-up", "person-riley", null),
        company("company-t1269-tomas-movers", "person-tomas", MOVERS),
      ]);
      const handles = await db.sql<{ kind: "phone" | "email"; address: string }[]>`
        select kind, address from handles order by id
      `;
      expect(handles.length).toBeGreaterThan(8);
      const before = await fingerprint();
      for (const { kind, address } of handles) {
        await readTurnParty(job, { handle: { kind, address } });
        await readTurnParty(job, { handle: { kind: kind === "phone" ? "email" : "phone", address } });
      }
      await readTurnParty(job, { handle: phone("+15555550198") });
      await thrownBy(readTurnParty(job, { handle: phone("not a number") }));
      await thrownBy(readTurnParty(app, { handle: phone(SAM_NUMBER) }));
      expect(await fingerprint()).toEqual(before);
      // The seeds' sealing keys and the stopped phone are among what stayed as it was.
      expect(before.sealing_keys).toMatch(/^3 rows, /);
      expect(before.phones).toMatch(/^1 rows, /);
    },
  );
});

// ---- the statements the read sends ------------------------------------------------------------------------------------

/** Item 52's tables, and per table the columns its reads select (its consumers line), and none other. */
const SELECTED: Readonly<Record<string, readonly string[]>> = {
  handles: ["id", "kind"],
  person_handles: ["person_id"],
  person_roles: ["business_id", "ended_at", "person_id", "role"],
  companies: ["business_id"],
  businesses: ["time_zone"],
};

/** The columns each read finds its rows by: the address only here, never selected back. */
const FOUND_BY: Readonly<Record<string, readonly string[]>> = {
  handles: ["address"],
  person_handles: ["handle_id", "person_id"],
  person_roles: ["business_id", "ended_at", "person_id", "role"],
  companies: ["owner_person_id"],
  businesses: ["id"],
};

/** The words item 52's statements are made of, beside their one table, its columns, parameters and punctuation. */
const SQL_WORDS = new Set(["select", "from", "where", "and", "in", "is", "not", "null", "order", "by"]);

/** The tables no statement may name a column of (item 52's consumers line). */
const NEVER_READ = ["sealing_keys", "phones", "threads", "messages", "bookings", "consents"];

/**
 * Item 52's six reads, each as sent (whitespace folded, each parameter as `$`, a list of parameters as `($...)`): one
 * table each, no join, no `*`, the address bound and never selected (README v1.11 item 52, steps 1 to 6).
 */
const STEP_STATEMENTS: Readonly<Record<number, string>> = {
  1: "select id, kind from handles where address = $",
  2: 'select person_id from person_handles where handle_id = $ order by person_id collate "C"',
  3: "select business_id, person_id, role, ended_at from person_roles where person_id in ($...)",
  4: "select business_id from companies where owner_person_id in ($...)",
  5: "select business_id, person_id from person_roles where business_id in ($...) and role = 'owner' and ended_at is null",
  6: "select time_zone from businesses where id = $",
};

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

const isTable = (token: string): boolean => schemaColumns.has(token);
const isName = (token: string): boolean => /^[a-z_][a-z0-9_$]*$/.test(token);
const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();
/** The statement with each parameter as `$` and each list of parameters as `($...)`. */
const canonical = (text: string): string =>
  normalized(text)
    .replace(/\$\d+/g, "$")
    .replace(/\(\s*\$(?:\s*,\s*\$)*\s*\)/g, "($...)");

/** The names no statement may hold: the six tables and every column of theirs that none of item 52's tables has. */
function neverNamed(): Set<string> {
  const own = new Set(Object.keys(SELECTED).flatMap((table) => [...(schemaColumns.get(table) ?? [])]));
  const theirs = NEVER_READ.flatMap((table) => [...(schemaColumns.get(table) ?? [])]);
  return new Set([...NEVER_READ, ...theirs.filter((column) => !own.has(column))]);
}

/**
 * What is wrong with one statement that reads a table: a name never named, `*`, more than one table or one beyond item
 * 52's, anything in the select list but its table's listed columns, or any other name but its table's listed columns and
 * the plain words of a select.
 */
function problemsOf(statement: string): string[] {
  const tokens = tokensOf(statement);
  const forbidden = neverNamed();
  const problems: string[] = [];
  for (const token of tokens) {
    if (forbidden.has(token)) {
      problems.push(`never named: ${token}`);
    }
    if (token === "*") {
      problems.push("*");
    }
  }
  const tables = tokens.filter(isTable);
  const [table, ...more] = tables;
  if (table === undefined) {
    return [...problems, "no table"];
  }
  if (more.length > 0) {
    problems.push(`more than one table: ${tables.join(", ")}`);
  }
  const selected = SELECTED[table];
  const foundBy = FOUND_BY[table];
  if (selected === undefined || foundBy === undefined) {
    return [...problems, `a table beyond its own: ${table}`];
  }
  const from = tokens.indexOf("from");
  if (tokens[0] !== "select" || from < 2 || tokens[from + 1] !== table) {
    problems.push("not a select from its one table");
  }
  tokens.forEach((token, index) => {
    if (index === 0 || index === from || index === from + 1) {
      return;
    }
    if (index < from) {
      if (token !== "," && !selected.includes(token)) {
        problems.push(`selected beyond its list: ${token}`);
      }
    } else if (
      isName(token) &&
      !SQL_WORDS.has(token) &&
      !selected.includes(token) &&
      !foundBy.includes(token)
    ) {
      problems.push(`a name beyond its own: ${token}`);
    }
  });
  return problems;
}

/** Which of item 52's six reads a statement is: its table, and for person_roles the column it finds rows by. */
function stepOf(statement: string): number {
  const tokens = tokensOf(statement);
  const key = tokens[tokens.indexOf("where") + 1];
  switch (tokens.find(isTable)) {
    case "handles":
      return 1;
    case "person_handles":
      return 2;
    case "person_roles":
      return key === "person_id" ? 3 : 5;
    case "companies":
      return 4;
    case "businesses":
      return 6;
    default:
      return 0;
  }
}

/** What no answer may hold: an address or a number, a role, a company, a name. */
const NEVER_ANSWERED = [
  "+1555",
  "@example.com",
  "role-",
  "company-",
  "LLC",
  "Sam Lee",
  "Hugo P.",
  "Riley",
  WRAP_NAME,
];

describe("the statements the read sends: item 52's reads, its columns alone, never a column of sealing_keys, phones, threads, messages, bookings or consents", () => {
  it("the six tables exist in this schema, so the check below is about real columns", () => {
    for (const table of [...NEVER_READ, ...Object.keys(SELECTED)]) {
      expect(schemaColumns.has(table), table).toBe(true);
    }
  });

  it("the check refuses a stray table, column or word, the address selected back, a whole row and a column of the six tables (shown on statements made to fail)", () => {
    const caught: { statement: string; problems: string[] }[] = [
      {
        statement: "select id, kind, address from handles where address = $1",
        problems: ["selected beyond its list: address"],
      },
      {
        statement: "select * from handles where address = $1",
        problems: ["*", "selected beyond its list: *"],
      },
      {
        statement: "select to_jsonb(h) from handles h where h.address = $1",
        problems: [
          "selected beyond its list: to_jsonb",
          "selected beyond its list: h",
          "a name beyond its own: h",
        ],
      },
      {
        statement:
          "select h.id, p.number from handles h join phones p on p.handle_id = h.id where h.address = $1",
        problems: ["never named: phones", "never named: number", "more than one table: handles, phones"],
      },
      {
        statement: 'select k.wrapped_key from "sealing_keys" k where k.person_id = $1',
        problems: [
          "never named: sealing_keys",
          "never named: wrapped_key",
          "a table beyond its own: sealing_keys",
        ],
      },
      {
        statement:
          "select id, business_id, person_id, role, ended_at from person_roles where person_id in ($1)",
        problems: ["selected beyond its list: id"],
      },
      {
        statement: "select id, name, business_id from companies where owner_person_id in ($1)",
        problems: ["selected beyond its list: id", "selected beyond its list: name"],
      },
      {
        statement: "select name, time_zone from businesses where id = $1",
        problems: ["selected beyond its list: name"],
      },
      {
        statement:
          "select business_id from companies where owner_person_id in ($1) or business_id is not null",
        problems: ["a name beyond its own: or"],
      },
      {
        statement:
          "select person_id from person_handles where handle_id = $1 union select person_id from consents",
        problems: ["never named: consents", "more than one table: person_handles, consents"],
      },
    ];
    for (const { statement, problems } of caught) {
      const found = problemsOf(statement);
      for (const problem of problems) {
        expect(found, statement).toContain(problem);
      }
    }
    // Item 52's own statements pass, with parameters as postgres.js binds them.
    const own = [
      "select id, kind from handles where address = $1",
      'select person_id from person_handles where handle_id = $1 order by person_id collate "C"',
      "select business_id, person_id, role, ended_at from person_roles where person_id in ($1,$2)",
      "select business_id from companies where owner_person_id in ($1)",
      "select business_id, person_id from person_roles where business_id in ($1,$2) and role = 'owner' and ended_at is null",
      "select time_zone from businesses where id = $1",
    ];
    own.forEach((statement, index) => {
      expect(problemsOf(statement), statement).toEqual([]);
      expect(canonical(statement)).toBe(STEP_STATEMENTS[index + 1]);
      expect(stepOf(statement)).toBe(index + 1);
    });
  });

  it(
    "over every fixture and every case: one read-only transaction per read, item 52's reads in its order and as written, only its columns, the address step 1's one parameter and nowhere else, nothing logged, and no answer holding an address, a role, a company or another business",
    HEAVY,
    async () => {
      const runs = await everyRun();
      expect(runs).toHaveLength(PARTY_FIXTURES.length + CASES.length);
      const stepsSeen = new Set<number>();
      for (const run of runs) {
        const { label } = run;
        expect(run.logged, label).toBe(0);
        expect(run.outcome, label).not.toBeInstanceOf(Error);
        expect(answerErrors(run.outcome), label).toEqual([]);

        // One transaction: one read-only begin on one connection, the scope cleared, the reads, then commit.
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
          expect(tokensOf(statement.text).some(isTable), `${label}: ${statement.text}`).toBe(true);
        }
        // Outside the transaction nothing reads a table (inRuntimeTransaction's `select 1` alone).
        const outside = [...run.statements.slice(0, begin), ...inside.slice(end + 1)];
        for (const statement of outside) {
          expect(tokensOf(statement.text).some(isTable), `${label}: ${statement.text}`).toBe(false);
        }

        // Item 52's reads, in its order, each as written, each at most once, and only its columns.
        const steps = reads.map((statement) => stepOf(statement.text));
        expect(steps[0], label).toBe(1);
        steps.forEach((step, index) => {
          if (index > 0) {
            expect(step, `${label}: steps ${steps.join(", ")}`).toBeGreaterThan(steps[index - 1] ?? 0);
          }
          stepsSeen.add(step);
        });
        for (const statement of reads) {
          expect(problemsOf(statement.text), `${label}: ${statement.text}`).toEqual([]);
          expect(canonical(statement.text), label).toBe(STEP_STATEMENTS[stepOf(statement.text)]);
        }
        const outcome = run.outcome as Record<string, unknown>;
        const isUnknown = outcome.handleId === null;
        const isAtBusiness = typeof outcome.businessId === "string";
        if (isUnknown) {
          expect(steps, label).toEqual([1]);
        }
        expect(steps.includes(6), label).toBe(isAtBusiness);

        // The address: bound as step 1's one parameter, never in a statement's text or another statement's parameters.
        const first = reads[0];
        expect(first?.parameters, label).toEqual([run.address]);
        for (const statement of run.statements) {
          expect(statement.text.includes(run.address), label).toBe(false);
          if (statement !== first) {
            expect(statement.parameters.includes(run.address), `${label}: ${statement.text}`).toBe(false);
          }
        }

        // The answer: ids and a zone, never an address, a role, a company, a name or another business (default 102).
        const text = JSON.stringify(run.outcome);
        expect(text.includes(run.address), label).toBe(false);
        for (const value of NEVER_ANSWERED) {
          expect(text.includes(value), `${label}: ${value}`).toBe(false);
        }
        const businesses = text.match(/biz-[a-z0-9-]+/g) ?? [];
        expect(businesses, label).toEqual(isAtBusiness ? [outcome.businessId] : []);
      }
      // Every one of item 52's six reads was sent by some run.
      expect([...stepsSeen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    },
  );
});

describe("a lost connection answers transient, with no address, id or connection detail (K-05 transientError)", () => {
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

  it(
    "the read, its backend terminated while it waits on handles, answers transient with its SQLSTATE alone, writes nothing, and the same request then answers",
    SLOW,
    async () => {
      const exchange = await given("read-turn-party-one-role.json");
      const url = new URL(resolvePrimaryUrl());
      const neverInAnswer = [
        RILEY_NUMBER,
        RILEY_HANDLE,
        "person-riley",
        BARBERSHOP,
        NEW_YORK,
        resolvePrimaryUrl(),
        url.host,
        url.username,
        url.password,
      ].filter((value) => value !== "");
      const before = await fingerprint();
      const application = "rosie-t1269-cut-handles";
      // A one-connection rosie_job client of its own; its one connection is dead after, and never released
      // (targets.ts inRuntimeTransaction), so it is closed at once.
      const victim = roleClient(JOB_ROLE, application, 1, false);
      let outcome: unknown;
      try {
        outcome = await db.sql.begin(async (tx) => {
          await tx`lock table handles in access exclusive mode`;
          const pending = readTurnParty(victim, requestOf(exchange));
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
      expect(answerErrors(outcome)).toEqual([]);
      const text = JSON.stringify(outcome);
      for (const value of neverInAnswer) {
        expect(text.includes(value), value).toBe(false);
      }
      expect(await fingerprint()).toEqual(before);
      expect(await readTurnParty(job, requestOf(exchange))).toEqual(exchange.outcome);
    },
  );
});
