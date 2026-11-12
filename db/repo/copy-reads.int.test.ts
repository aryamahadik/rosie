// T-1301: K-05 v1.12's readLiveTimers and readStoppedFlag (items 56 and 57), the handle actor's copy sources, against
// local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/copy-reads`). The schema comes from migrating a
// fresh test schema (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The reads run as K-05 v1.12 names them (README "v1.12", items 56 and 57): through a client whose connections run as
// rosie_job, the runtime side's role, with no business scope, so the grants and row-level security are the ones the reads
// meet; the role is the connection's. The tables' owner (the migrations' role) loads the seeds a fixture's `given` names
// (K-04's, and K-34's as partSeeds, each with its own `after` chain) and writes the rows a case adds. The exchanges a
// fixture's `after` chain names run first for real through db/repo, each answering its own fixture's outcome: reserve as
// rosie_app under its business (K-05 v1 item 8), followed by the saved-time clock row it does not write yet, which the
// owner writes as tests/contract/data-access.v1.db-side.test.ts does; then commitTurn, writePlan and K-05 v1's own
// claimOutbox as rosie_job. Every answer is checked against its data-access v1.12 definition with Ajv 2020-12, strict, as
// contracts:check runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its parameters,
// kept in memory for the checks and never printed), so the checks read what the reads sent, not a copy of their SQL: one
// read-only transaction per read, the business scope set empty first; each read's statements as items 56 and 57 name them,
// with their columns alone and the handle's id the one parameter of each table read; and no column of sealing_keys,
// messages, consents or proof_codes.
//
// Names are the master's sample cast and fixture set v1's demo shops as K-04's and K-34's seeds hold them (rule 9). The
// timers and clock rows a case adds carry example ids (t1301), and their sealed addresses are stand-in bytes, never a real
// address, a real key or anything sealed under one.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import {
  type LiveTimer,
  readLiveTimers,
  type ReadLiveTimersRequest,
  type ReadLiveTimersResponse,
  readStoppedFlag,
  type ReadStoppedFlagRequest,
} from "./copy-reads";
import { claimOutbox, writePlan } from "./outbox";
import { reserve } from "./reservations";
import { BusinessScopeError, SCOPE_SETTING, type Sql, type Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { BrokenRecordError } from "./turn-face-reads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 240_000 };

const CALLS = ["readLiveTimers", "readStoppedFlag"] as const;
type Call = (typeof CALLS)[number];

/** K-34's seed of Sam's timer (the partSeeds of read-live-timers-*), and the K-04 seed the stopped-flag cases load. */
const TIMER_SEED = "safety-incidents/seed-safety-timer.json";
const PHONES = "seed-phone-chat-open.json";

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
const NEW_YORK = "America/New_York";
const CHICAGO = "America/Chicago";

const SAM_HANDLE = "handle-sam";
const RILEY_HANDLE = "handle-riley";
const ALEX = "person-alex";
const ALEX_HANDLE = "handle-alex";
const ALEX_EMAIL_HANDLE = "handle-alex-email";
const ALEX_NUMBER = "+15555550101";
const MORGAN = "person-morgan-lee";
const MORGAN_HANDLE = "handle-morgan-lee";
/** The fiction-range numbers the seeds give the cast: none may reach an answer, an error or a log. */
const NUMBERS = [
  "+15555550100",
  ALEX_NUMBER,
  "+15555550102",
  "+15555550103",
  "+15555550104",
  "+15555550105",
  "+15555550108",
];
/** K-34's seed timer: Sam's, on Alex's move survey for the movers (read-live-timers-sam). */
const SEED_TIMER = "timer-sam-survey";
const SAM_FIXTURE = "read-live-timers-sam.json";
const STOPPED_FIXTURE = "read-stopped-flag-alex-stopped.json";
const STARTED_FIXTURE = "read-stopped-flag-alex-started.json";
/** When Morgan Lee said yes to being the contact (K-34's seed), before every timer a case starts. */
const CONTACT_YES_AT = "2026-10-20T14:00:00Z";

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
const refusedOf = (file: string): Row => readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as Row;
const handleOf = (exchange: Exchange): { handleId: string } =>
  exchange.request as unknown as ReadLiveTimersRequest & ReadStoppedFlagRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** Items 56 and 57's accepted exchanges, as the index lists them. */
const ACCEPTED = INDEX.filter(
  (entry) => entry.expect === "accept" && CALLS.some((call) => entry.def === `${call}.exchange`),
).map((entry) => entry.file);
/** Their refused twins, each refused by one of the two calls' definitions. */
const REFUSED = INDEX.filter(
  (entry) => entry.expect === "refuse" && CALLS.some((call) => (entry.def ?? "").startsWith(`${call}.`)),
);
const callOf = (exchange: Exchange): Call => {
  const call = CALLS.find((name) => name === exchange.call);
  if (call === undefined) {
    throw new Error(`this test runs no ${exchange.call} read`);
  }
  return call;
};

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
/** Bytes as hex digits: two lower-case digits a byte. */
const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
/** Bytes in PostgreSQL's hex text form: a backslash, x and two lower-case hex digits a byte (K-05 v1.12 sealedBytes). */
const hexText = (bytes: Uint8Array): string => `\\x${hexOf(bytes)}`;

/** Sam's seed timer as read-live-timers-sam answers it: the address as K-34's seed stores it. */
function seedLiveTimer(): LiveTimer {
  const [timer] = exchangeOf(SAM_FIXTURE).outcome.timers as unknown as LiveTimer[];
  if (timer === undefined) {
    throw new Error(`${SAM_FIXTURE} answers no timer`);
  }
  return timer;
}
/** What the seed's stand-in bytes spell, were they ever opened as text: never in an answer, an error or a log. */
const SEED_ADDRESS_WORDS = String.fromCharCode(...fromHex(seedLiveTimer().address.slice(2)));

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
const V112_ID = (readJson(new URL("data-access/data-access.v1.12.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.12, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V112_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.12 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

const isAnswerError = (outcome: unknown): boolean =>
  typeof outcome === "object" && outcome !== null && "error" in outcome;

/** An answer checked against its own definition: an error against <call>.errors, else <call>.response. */
function answerErrors(call: Call, outcome: unknown): string[] {
  return schemaErrors(isAnswerError(outcome) ? `${call}.errors` : `${call}.response`, outcome);
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
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first; every statement recorded. */
let app: Sql;
let typedColumns: Map<string, string>;
/** Every base table of this file's schema, in name order. */
let schemaTables: string[];
/** Every table's columns, by table. */
const schemaColumns = new Map<string, Set<string>>();
/** Every statement the rosie_job client sent, in order. */
const sent: Sent[] = [];
/** Every statement the rosie_app client sent, in order. */
const appSent: Sent[] = [];

function roleClient(role: string, applicationName: string, max: number, record: Sent[] | null): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    ...(record === null
      ? {}
      : {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            record.push({ connection, text, parameters: [...parameters] });
          },
        }),
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "copy_reads" });
  job = roleClient(JOB_ROLE, "rosie-t1301-job", 5, sent);
  app = roleClient(APP_ROLE, "rosie-t1301-app", 2, appSent);
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

/** Empties every table and restarts its identity (truncating the heads cascades to the rest; this file's schema only). */
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

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it; each file once. */
function seedRows(file: URL, seen: Set<string>): TableRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(new URL(before, file), seen)), ...seed.rows];
}

const coreSeed = (name: string): URL => new URL(name, CORE_DIR);

/** `<part>/<file>`, a seed of another database part (K-05 given.partSeeds), in that part's fixtures folder. */
function partSeed(name: string): URL {
  const slash = name.indexOf("/");
  if (slash < 1) {
    throw new Error(`partSeeds names <part>/<file>, not ${name}`);
  }
  return new URL(`${name.slice(0, slash)}/fixtures/${name.slice(slash + 1)}`, DB_SCHEMA_DIR);
}

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const exchange = exchangeOf(file);
  const seeds = [...exchange.given.k04Seeds.map(coreSeed), ...(exchange.given.partSeeds ?? []).map(partSeed)];
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

/** Empties the tables, then loads the seeds and their chains, each row once, as the owner, in one transaction. */
async function loadSeeds(seeds: readonly URL[]): Promise<void> {
  await reset();
  const seen = new Set<string>();
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** Rows a case adds, as the owner, in one transaction. */
async function writeRows(rows: readonly TableRow[]): Promise<void> {
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

// ---- the exchanges a chain runs first, through db/repo --------------------------------------------------------------

/**
 * Each call a chain runs first, through db/repo in the role K-05 gives it: reserve under its business as rosie_app (v1
 * item 8), the commit, the plan and K-05 v1's own claim on the runtime side as rosie_job (v1 items 1 to 3).
 */
const STEPS: Readonly<Record<string, (step: Exchange) => Promise<unknown>>> = {
  reserve: (step) => reserve(app, structuredClone(step.request) as never),
  commitTurn: (step) =>
    commitTurn(job, structuredClone(step.request) as unknown as CommitTurnRequest, {
      now: new Date(step.given.now),
    }),
  writePlan: (step) => writePlan(job, structuredClone(step.request) as never),
  claimOutbox: (step) => claimOutbox(job, structuredClone(step.request) as never),
};

/**
 * A held time's saved-time clock row (K-05 v1 item 8), which db/repo's reserve does not write yet (reservations.ts: "the
 * answer names its id"): written by the owner from the reservation reserve wrote and its answer, once it is checked not
 * to be there, as tests/contract/data-access.v1.db-side.test.ts writes it. The commit that books the time cancels it.
 */
async function writeSavedTimeClock(step: Exchange): Promise<void> {
  const { reservationId, savedTimeClockId, heldUntil } = step.outcome;
  if (
    typeof reservationId !== "string" ||
    typeof savedTimeClockId !== "string" ||
    typeof heldUntil !== "string"
  ) {
    throw new Error("a held time's answer names its reservation, its clock row and its end");
  }
  const [there] = await db.sql<{ rows: number }[]>`
    select count(*)::int as rows from clock_rows where id = ${savedTimeClockId}
  `;
  expect(there?.rows, `${savedTimeClockId}: db/repo's reserve writes no saved-time clock row yet`).toBe(0);
  const [held] = await db.sql<
    { business_id: string; booking_id: string | null; handle_id: string | null; zone: string }[]
  >`
    select r.business_id, r.booking_id, p.handle_id, b.time_zone as zone
    from reservations r
    join businesses b on b.id = r.business_id
    left join phones p on p.number = r.for_phone_number
    where r.id = ${reservationId}
  `;
  if (held === undefined) {
    throw new Error("the held reservation is missing");
  }
  await insertRow(db.sql, "clock_rows", {
    id: savedTimeClockId,
    kind: "saved_time",
    reservation_id: reservationId,
    handle_id: held.handle_id,
    business_id: held.business_id,
    booking_id: held.booking_id,
    due_at: heldUntil,
    due_zone: held.zone,
    state: "armed",
    armed_at: step.request.at ?? null,
    fires: { release: reservationId, why: "expired" },
  });
}

/** Runs a chain's step for real through db/repo; its answer is its own fixture's outcome. */
async function runStep(file: string): Promise<void> {
  const step = exchangeOf(file);
  const run = STEPS[step.call];
  if (run === undefined) {
    throw new Error(`${file}: this test runs no ${step.call} step`);
  }
  expect(await run(step), `${file}, run first`).toEqual(step.outcome);
  if (step.call === "reserve" && step.outcome.result === "held") {
    await writeSavedTimeClock(step);
  }
}

/** Loads a fixture's seeds and runs its chain's steps for real. */
async function given(file: string): Promise<Exchange> {
  const chain = chainOf(file);
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    await runStep(step);
  }
  return exchangeOf(file);
}

// ---- the timers a case adds beside K-34's seed timer -----------------------------------------------------------------

type TimerState = "running" | "missed" | "safe";

/** A pro working alone: their person and the handle their actor is named by. */
interface Pro {
  readonly personId: string;
  readonly handleId: string;
}

const SAM_PRO: Pro = { personId: "person-sam", handleId: SAM_HANDLE };
const RILEY_PRO: Pro = { personId: "person-riley", handleId: RILEY_HANDLE };

/** A timer a case adds: Morgan Lee the contact who said yes, the address sealed for Alex (stand-in bytes). */
interface TimerSpec {
  readonly id: string;
  readonly businessId: string;
  readonly pro: Pro;
  readonly dueAt: string;
  readonly dueZone: string;
  readonly state: TimerState;
  readonly address: Uint8Array;
}

/** A UTC instant `minutes` after `at` (before, when negative), in the contract's form. */
const shifted = (at: string, minutes: number): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString().replace(".000Z", "Z");

const timer = (
  id: string,
  businessId: string,
  pro: Pro,
  dueAt: string,
  state: TimerState,
  dueZone = NEW_YORK,
): TimerSpec => ({ id, businessId, pro, dueAt, dueZone, state, address: Uint8Array.from(randomBytes(40)) });

/**
 * The case's clock row (kind step: K-34's "the core clock row fires the miss while PostgreSQL is up"; armed while it
 * runs, fired once missed) and its timer, with K-34's times in the order its checks ask: the yes, then the start two
 * hours before the due time, a miss a minute after it, a SAFE half an hour after it. No booking.
 */
function timerRows(spec: TimerSpec): TableRow[] {
  const clockRowId = `clock-${spec.id}`;
  const startedAt = shifted(spec.dueAt, -120);
  const running = spec.state === "running";
  return [
    {
      table: "clock_rows",
      values: {
        id: clockRowId,
        kind: "step",
        handle_id: spec.pro.handleId,
        business_id: spec.businessId,
        booking_id: null,
        due_at: spec.dueAt,
        due_zone: spec.dueZone,
        state: running ? "armed" : "fired",
        armed_at: startedAt,
        fired_at: running ? null : spec.dueAt,
        fires: { step: "B8-86", safetyTimer: spec.id },
      },
    },
    {
      table: "safety_timers",
      values: {
        id: spec.id,
        business_id: spec.businessId,
        booking_id: null,
        worker_person_id: spec.pro.personId,
        worker_handle_id: spec.pro.handleId,
        emergency_contact_person_id: MORGAN,
        emergency_contact_handle_id: MORGAN_HANDLE,
        contact_yes_at: CONTACT_YES_AT,
        started_at: startedAt,
        due_at: spec.dueAt,
        due_zone: spec.dueZone,
        address: hexText(spec.address),
        address_for_person_id: ALEX,
        clock_row_id: clockRowId,
        state: spec.state,
        missed_at: running ? null : shifted(spec.dueAt, 1),
        safe_at: spec.state === "safe" ? shifted(spec.dueAt, 30) : null,
      },
    },
  ];
}

/** A live timer as item 56 answers it: the thirteen columns in K-05's names, the address its bytes' hex text. */
function liveTimerOf(spec: TimerSpec): LiveTimer {
  if (spec.state === "safe") {
    throw new Error(`${spec.id} is safe: never a live timer`);
  }
  return {
    id: spec.id,
    businessId: spec.businessId,
    bookingId: null,
    workerHandleId: spec.pro.handleId,
    emergencyContactPersonId: MORGAN,
    emergencyContactHandleId: MORGAN_HANDLE,
    dueAt: spec.dueAt,
    dueZone: spec.dueZone,
    address: hexText(spec.address),
    addressForPersonId: ALEX,
    clockRowId: `clock-${spec.id}`,
    state: spec.state,
    version: 1,
  };
}

// Sam's seed timer (biz-movers) is due 15:20Z; each timer below is due on the same day, Oct 27.
/** At the yoga studio, due before the seed timer, though its business, its id and its insertion come after it. */
const YOGA_TIMER = timer("timer-t1301-sam-yoga", YOGA, SAM_PRO, "2026-10-27T14:40:00Z", "running");
/** Closed by SAFE, due before every other timer of Sam's: never live. */
const SAFE_TIMER = timer("timer-t1301-sam-safe", BARBERSHOP, SAM_PRO, "2026-10-27T13:00:00Z", "safe");
/** A missed check at the barbershop, given in another zone: open until SAFE (S13-10). */
const MISSED_TIMER = timer(
  "timer-t1301-sam-missed",
  BARBERSHOP,
  SAM_PRO,
  "2026-10-27T13:30:00Z",
  "missed",
  CHICAGO,
);
/** Riley's own timer at the barbershop: another pro's, another handle's. */
const RILEY_TIMER = timer("timer-t1301-riley", BARBERSHOP, RILEY_PRO, "2026-10-27T12:30:00Z", "running");
/** Two timers due at one time: byte by byte (collate "C") the upper-case T comes first, as a locale would not have it. */
const TIE_LOWER_CASE = timer("timer-t1301-sam-tie", YOGA, SAM_PRO, "2026-10-27T16:00:00Z", "running");
const TIE_UPPER_CASE = timer("timer-t1301-sam-Tie", MOVERS, SAM_PRO, "2026-10-27T16:00:00Z", "running");
const CASE_TIMERS = [YOGA_TIMER, SAFE_TIMER, MISSED_TIMER, RILEY_TIMER, TIE_LOWER_CASE, TIE_UPPER_CASE];

/** One of item 56's cases: the timers added beside K-34's seed timer, whose actor reads, and what it is answered. */
interface TimersCase {
  readonly shows: string;
  readonly timers: readonly TimerSpec[];
  readonly handleId: string;
  /** The timers answered, in order, by id: K-34's seed timer or one of the case's. */
  readonly answered: readonly string[];
}

const TIMERS_CASES: readonly TimersCase[] = [
  {
    shows:
      "timers at two businesses of one handle: both, in due order (the yoga studio's first, though its business, its id and its insertion come after the movers')",
    timers: [YOGA_TIMER],
    handleId: SAM_HANDLE,
    answered: [YOGA_TIMER.id, SEED_TIMER],
  },
  {
    shows: "a safe timer is left out, though it is due first",
    timers: [SAFE_TIMER],
    handleId: SAM_HANDLE,
    answered: [SEED_TIMER],
  },
  {
    shows: "a missed timer is listed, as missed, with the zone it was given in (open until SAFE: S13-10)",
    timers: [MISSED_TIMER],
    handleId: SAM_HANDLE,
    answered: [MISSED_TIMER.id, SEED_TIMER],
  },
  {
    shows: "another handle's timer is left out: Riley's, at the barbershop, due first",
    timers: [RILEY_TIMER],
    handleId: SAM_HANDLE,
    answered: [SEED_TIMER],
  },
  {
    shows: "another handle's actor reads its own timers alone: Riley's, never Sam's",
    timers: [RILEY_TIMER],
    handleId: RILEY_HANDLE,
    answered: [RILEY_TIMER.id],
  },
  {
    shows:
      "a tie in due time goes to the lower id, byte by byte (collate C: an upper-case letter before a lower-case one)",
    timers: [TIE_LOWER_CASE, TIE_UPPER_CASE],
    handleId: SAM_HANDLE,
    answered: [SEED_TIMER, TIE_UPPER_CASE.id, TIE_LOWER_CASE.id],
  },
  {
    shows:
      "all at once: Sam's live timers at three businesses in due order, the missed one listed, the safe one and Riley's left out",
    timers: CASE_TIMERS,
    handleId: SAM_HANDLE,
    answered: [MISSED_TIMER.id, YOGA_TIMER.id, SEED_TIMER, TIE_UPPER_CASE.id, TIE_LOWER_CASE.id],
  },
  {
    shows: "the contact's own actor reads none of the timers it is the contact of: an empty list, an answer",
    timers: CASE_TIMERS,
    handleId: MORGAN_HANDLE,
    answered: [],
  },
];

/** A case's answer, built from its timers: K-34's seed timer as read-live-timers-sam answers it, else the case's own. */
function timersAnswerOf(spec: TimersCase): ReadLiveTimersResponse {
  const byId = new Map(spec.timers.map((added) => [added.id, added]));
  const timers = spec.answered.map((id) => {
    if (id === SEED_TIMER) {
      return seedLiveTimer();
    }
    const added = byId.get(id);
    if (added === undefined) {
      throw new Error(`${spec.shows}: ${id} is not among the case's timers`);
    }
    return liveTimerOf(added);
  });
  return { handleId: spec.handleId, timers };
}

/** Loads K-34's seed timer and its chain, then the case's timers with their clock rows. */
async function givenTimers(timers: readonly TimerSpec[]): Promise<void> {
  await loadSeeds([partSeed(TIMER_SEED)]);
  await writeRows(timers.flatMap(timerRows));
}

// ---- item 57's cases beyond the fixtures --------------------------------------------------------------------------------

/** When the owner writes a STOP on Riley's phone in a case. */
const RILEY_STOP_AT = "2026-11-07T15:30:00Z";

/** One of item 57's cases: K-04's seeds, what the owner changes after them, whose actor re-reads, and the answer. */
interface FlagCase {
  readonly shows: string;
  readonly seeds: readonly string[];
  readonly change?: (sql: Sql) => Promise<unknown>;
  readonly handleId: string;
  readonly outcome: Row;
}

const phoneNotFound = (handleId: string): Row => ({ error: "notFound", table: "phones", rowId: handleId });
const stopRiley = (sql: Db): Promise<unknown> => sql`
  update phones set stopped = true, stop_at = ${RILEY_STOP_AT}, chat_open = false, version = version + 1
  where handle_id = ${RILEY_HANDLE}
`;

const FLAG_CASES: readonly FlagCase[] = [
  {
    shows: "an email handle has no phone row: notFound, table phones, never not stopped",
    seeds: [PHONES],
    handleId: ALEX_EMAIL_HANDLE,
    outcome: phoneNotFound(ALEX_EMAIL_HANDLE),
  },
  {
    shows: "a handle K-04 does not hold: notFound, table phones, never not stopped",
    seeds: [PHONES],
    handleId: "handle-t1301-unknown",
    outcome: phoneNotFound("handle-t1301-unknown"),
  },
  {
    shows: "a phone never stopped: not stopped, at its row's version (Sam's)",
    seeds: [PHONES],
    handleId: SAM_HANDLE,
    outcome: { handleId: SAM_HANDLE, stopped: false, phoneVersion: 2 },
  },
  {
    shows: "the flag is the handle's own row's: Riley's phone, stopped by the owner, at its raised version",
    seeds: [PHONES],
    change: stopRiley,
    handleId: RILEY_HANDLE,
    outcome: { handleId: RILEY_HANDLE, stopped: true, phoneVersion: 3 },
  },
  {
    shows:
      "another handle's stop is not this handle's: Sam's phone beside Riley's stopped one is not stopped",
    seeds: [PHONES],
    change: stopRiley,
    handleId: SAM_HANDLE,
    outcome: { handleId: SAM_HANDLE, stopped: false, phoneVersion: 2 },
  },
];

async function givenFlag(spec: FlagCase): Promise<void> {
  await loadSeeds(spec.seeds.map(coreSeed));
  if (spec.change !== undefined) {
    await spec.change(db.sql);
  }
}

// ---- watching one read: what it sent, what it answered, what it logged ------------------------------------------------

/** Each read by its call, on the client given. */
const READS: Readonly<Record<Call, (sql: Sql, request: { handleId: string }) => Promise<unknown>>> = {
  readLiveTimers: (sql, request) => readLiveTimers(sql, request),
  readStoppedFlag: (sql, request) => readStoppedFlag(sql, request),
};

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

/** One read run: its label, its call, the handle it asked about, what it sent, its outcome and how often it logged. */
interface Run {
  label: string;
  call: Call;
  handleId: string;
  statements: Sent[];
  outcome: unknown;
  logged: number;
}

/** Runs one read on the rosie_job client, keeping the statements it sent. */
async function watched(label: string, call: Call, handleId: string): Promise<Run> {
  sent.length = 0;
  const { outcome, logged } = await unlogged(() => READS[call](job, { handleId }));
  return { label, call, handleId, statements: [...sent], outcome, logged };
}

/** Every fixture's read and every case's, each over its own rows, with what it sent. */
async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  for (const file of ACCEPTED) {
    const exchange = await given(file);
    runs.push(await watched(file, callOf(exchange), handleOf(exchange).handleId));
  }
  for (const spec of TIMERS_CASES) {
    await givenTimers(spec.timers);
    runs.push(await watched(spec.shows, "readLiveTimers", spec.handleId));
  }
  for (const spec of FLAG_CASES) {
    await givenFlag(spec);
    runs.push(await watched(spec.shows, "readStoppedFlag", spec.handleId));
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

/** What no answer, error or log may hold: a number, the sealed address opened into words, a wrapping key's name. */
const NEVER_ANSWERED = [...NUMBERS, "+1555", SEED_ADDRESS_WORDS, "SEALING_WRAP_KEY"];

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the role the reads run as (K-05 v1.12 items 56 and 57: rosie_job, no business scope; T-191)", () => {
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
    "a Tool API client's readStoppedFlag is refused by PostgreSQL's own privilege check (no grant on phones: 0012), naming no value: never answered as not stopped",
    SLOW,
    async () => {
      await given(STOPPED_FIXTURE);
      const error = await thrownBy(readStoppedFlag(app, { handleId: ALEX_HANDLE }));
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      for (const value of [ALEX_HANDLE, ALEX_NUMBER]) {
        expect((error as Error).message.includes(value), value).toBe(false);
      }
    },
  );

  it(
    "a Tool API client's readLiveTimers is refused before safety_timers is read (default 2): rosie_app sees no timer without a scope, so its empty list would empty the copy of a live one",
    SLOW,
    async () => {
      await given(SAM_FIXTURE);
      // The premise: with no scope rosie_app sees none of the timers the owner and rosie_job see.
      const count = async (client: Sql): Promise<number> => {
        const [row] = await client<{ n: number }[]>`select count(*)::int as n from safety_timers`;
        return row?.n ?? -1;
      };
      expect(await count(db.sql)).toBe(1);
      expect(await count(job)).toBe(1);
      expect(await count(app)).toBe(0);
      appSent.length = 0;
      const error = await thrownBy(readLiveTimers(app, { handleId: SAM_HANDLE }));
      expect(error).toBeInstanceOf(BusinessScopeError);
      expect((error as Error).message).toBe(
        "readLiveTimers runs on the runtime side, as rosie_job: rosie_app sees no timer without a business scope",
      );
      expect(appSent.some((statement) => statement.text.includes("safety_timers"))).toBe(false);
      expect(appSent.at(-1)?.text).toBe("rollback");
      expect(await readLiveTimers(job, { handleId: SAM_HANDLE })).toEqual(exchangeOf(SAM_FIXTURE).outcome);
    },
  );

  it(
    "a rosie_job connection that kept a business scope of its own still reads every business's timers: the scope is set empty for the read's transaction (default 110)",
    SLOW,
    async () => {
      await givenTimers([YOGA_TIMER]);
      const kept = roleClient(JOB_ROLE, "rosie-t1301-kept-scope", 1, null);
      try {
        await kept`select set_config(${SCOPE_SETTING}, ${YOGA}, false)`;
        const seen = await kept<{ id: string }[]>`select id from safety_timers order by id collate "C"`;
        expect(seen.map((row) => row.id)).toEqual([YOGA_TIMER.id]);
        expect(await readLiveTimers(kept, { handleId: SAM_HANDLE })).toEqual(
          timersAnswerOf({
            shows: "kept scope",
            timers: [YOGA_TIMER],
            handleId: SAM_HANDLE,
            answered: [YOGA_TIMER.id, SEED_TIMER],
          }),
        );
        const [after] = await kept<{ scope: string }[]>`select current_setting(${SCOPE_SETTING}) as scope`;
        expect(after?.scope).toBe(YOGA);
      } finally {
        await kept.end({ timeout: 5 });
      }
    },
  );
});

describe("each v1.12 fixture of items 56 and 57 gives its outcome (K-05 v1.12; defaults 110 and 111)", () => {
  it("the index lists the five exchanges of items 56 and 57, each valid against data-access v1.12, and their five refused twins, each refused by its definition", () => {
    expect([...ACCEPTED].sort()).toEqual([
      "read-live-timers-none.json",
      "read-live-timers-sam.json",
      STARTED_FIXTURE,
      STOPPED_FIXTURE,
      "read-stopped-flag-no-phone.json",
    ]);
    for (const file of ACCEPTED) {
      const exchange = exchangeOf(file);
      expect(schemaErrors(`${callOf(exchange)}.exchange`, exchange), file).toEqual([]);
    }
    expect(REFUSED.map((entry) => `${entry.file} by ${entry.def ?? ""}`).sort()).toEqual([
      "invalid/refuse-live-timers-address-opened.json by readLiveTimers.response",
      "invalid/refuse-live-timers-business-scope.json by readLiveTimers.exchange",
      "invalid/refuse-live-timers-safe-listed.json by readLiveTimers.response",
      "invalid/refuse-stopped-flag-by-number.json by readStoppedFlag.exchange",
      "invalid/refuse-stopped-flag-no-version.json by readStoppedFlag.response",
    ]);
    for (const entry of REFUSED) {
      const value = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(entry.def ?? "", value), entry.file).not.toEqual([]);
    }
  });

  for (const file of ACCEPTED) {
    it(
      `${file}: as rosie_job, the read answers the fixture's outcome, valid against its v1.12 definition`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const call = callOf(exchange);
        const outcome = await READS[call](job, handleOf(exchange));
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(call, outcome)).toEqual([]);
        expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome })).toEqual([]);
      },
    );
  }

  it(
    "refuse-live-timers-business-scope and refuse-stopped-flag-by-number: a business beside the handle, or a number in its place, is refused before any statement; put right, each is its twin",
    SLOW,
    async () => {
      const sam = await given(SAM_FIXTURE);
      const scoped = exchangeOf("invalid/refuse-live-timers-business-scope.json");
      sent.length = 0;
      const scopedError = await thrownBy(readLiveTimers(job, scoped.request as never));
      expect(scopedError).toBeInstanceOf(TypeError);
      expect((scopedError as Error).message).toBe("readLiveTimers: the request takes only handleId");
      expect(sent).toEqual([]);
      const { businessId, ...withoutBusiness } = scoped.request;
      expect(businessId).toBe(MOVERS);
      expect(withoutBusiness).toEqual(sam.request);
      expect(await readLiveTimers(job, handleOf({ ...scoped, request: withoutBusiness }))).toEqual(
        sam.outcome,
      );

      const stopped = await given(STOPPED_FIXTURE);
      const byNumber = exchangeOf("invalid/refuse-stopped-flag-by-number.json");
      sent.length = 0;
      const numberError = await thrownBy(readStoppedFlag(job, byNumber.request as never));
      expect(numberError).toBeInstanceOf(TypeError);
      expect((numberError as Error).message).toBe("readStoppedFlag: the request takes only handleId");
      expect((numberError as Error).message.includes(ALEX_NUMBER)).toBe(false);
      expect(sent).toEqual([]);
      const { number, ...withoutNumber } = byNumber.request;
      expect(number).toBe(ALEX_NUMBER);
      expect(withoutNumber).toEqual({});
      expect(byNumber.outcome).toEqual(stopped.outcome);
      expect(await readStoppedFlag(job, handleOf(stopped))).toEqual(byNumber.outcome);
    },
  );

  it(
    "refuse-live-timers-address-opened and refuse-live-timers-safe-listed: the read answers the twin, the address sealed as stored and a safe timer never; each refused answer put right is the twin's outcome",
    SLOW,
    async () => {
      const sam = await given(SAM_FIXTURE);
      const sealed = seedLiveTimer().address;

      const opened = refusedOf("refuse-live-timers-address-opened.json");
      const answer = await readLiveTimers(job, handleOf(sam));
      expect(answer).toEqual(sam.outcome);
      expect(answer).not.toEqual(opened);
      expect(JSON.stringify(answer).includes(SEED_ADDRESS_WORDS)).toBe(false);
      const openedTimers = opened.timers as Row[];
      expect(openedTimers.map((one) => one.address)).not.toEqual([sealed]);
      expect({ ...opened, timers: openedTimers.map((one) => ({ ...one, address: sealed })) }).toEqual(
        sam.outcome,
      );

      const safeListed = refusedOf("refuse-live-timers-safe-listed.json");
      await db.sql`
        update safety_timers set state = 'safe', safe_at = ${shifted("2026-10-27T15:20:00Z", 30)},
                                 missed_at = ${shifted("2026-10-27T15:20:00Z", 1)}, version = version + 1
        where id = ${SEED_TIMER}
      `;
      const afterSafe = await readLiveTimers(job, handleOf(sam));
      expect(afterSafe).toEqual({ handleId: SAM_HANDLE, timers: [] });
      expect(afterSafe).not.toEqual(safeListed);
      expect(answerErrors("readLiveTimers", afterSafe)).toEqual([]);
      const safeTimers = safeListed.timers as Row[];
      expect(safeTimers.map((one) => one.state)).toEqual(["safe"]);
      expect({ ...safeListed, timers: safeTimers.map((one) => ({ ...one, state: "running" })) }).toEqual(
        sam.outcome,
      );
    },
  );

  it(
    "refuse-stopped-flag-no-version: the read answers Alex's flag with its version; the refused answer with the version put back is the twin's outcome",
    SLOW,
    async () => {
      const twin = await given(STOPPED_FIXTURE);
      const refused = refusedOf("refuse-stopped-flag-no-version.json");
      const answer = await readStoppedFlag(job, handleOf(twin));
      expect(answer).toEqual(twin.outcome);
      expect(answer).not.toEqual(refused);
      expect(Object.keys(answer).sort()).toEqual(["handleId", "phoneVersion", "stopped"]);
      expect({ ...refused, phoneVersion: twin.outcome.phoneVersion ?? null }).toEqual(twin.outcome);
    },
  );
});

describe("readLiveTimers, case by case (item 56; README v1.12 'What the new tasks must hold to'; default 110)", () => {
  for (const spec of TIMERS_CASES) {
    it(spec.shows, SLOW, async () => {
      await givenTimers(spec.timers);
      const outcome = await readLiveTimers(job, { handleId: spec.handleId });
      expect(outcome).toEqual(timersAnswerOf(spec));
      expect(answerErrors("readLiveTimers", outcome)).toEqual([]);
    });
  }

  it(
    "the address is answered in PostgreSQL's hex text form, byte for byte as stored: K-34's seed's, and stand-in bytes no text decoding would keep (a NUL, a backslash and x, quotes, invalid UTF-8), never opened or put in plain words",
    SLOW,
    async () => {
      // A NUL, a backslash and x, both quotes, 0xff, a lone continuation byte, a broken two-byte sequence, a newline, a
      // comma, braces and a NUL again; then random bytes.
      const edgeBytes = Uint8Array.from([...fromHex("005c782722ff80c3280a2c7b7d00"), ...randomBytes(48)]);
      const edge: TimerSpec = { ...YOGA_TIMER, id: "timer-t1301-sam-bytes", address: edgeBytes };
      await givenTimers([edge]);
      const answer = await readLiveTimers(job, { handleId: SAM_HANDLE });
      expect(answerErrors("readLiveTimers", answer)).toEqual([]);
      const timers = (answer as ReadLiveTimersResponse).timers;
      expect(timers.map((one) => one.id)).toEqual([edge.id, SEED_TIMER]);
      expect(timers[0]?.address).toBe(hexText(edgeBytes));
      expect(timers[1]?.address).toBe(seedLiveTimer().address);

      // As stored: the owner's own read of the bytes, and PostgreSQL's own text of them in its hex output.
      let stored: { id: string; bytes: Uint8Array; text: string }[] = [];
      await db.sql.begin(async (tx) => {
        await tx`set local bytea_output = 'hex'`;
        stored = [
          ...(await tx<{ id: string; bytes: Uint8Array; text: string }[]>`
            select id, address as bytes, address::text as text from safety_timers
            where worker_handle_id = ${SAM_HANDLE} order by id collate "C"
          `),
        ];
      });
      expect(stored).toHaveLength(2);
      for (const row of stored) {
        const read = timers.find((one) => one.id === row.id);
        expect(read?.address, row.id).toBe(row.text);
        expect([...fromHex((read?.address ?? "").slice(2))], row.id).toEqual([...row.bytes]);
      }
      expect([...(stored.find((row) => row.id === edge.id)?.bytes ?? [])]).toEqual([...edgeBytes]);
      expect(JSON.stringify(answer).includes(SEED_ADDRESS_WORDS)).toBe(false);
    },
  );

  it(
    "a live timer whose stored address is no bytes throws BrokenRecordError, naming no value, and answers nothing (default 3): never a list without it",
    SLOW,
    async () => {
      await givenTimers([{ ...YOGA_TIMER, address: new Uint8Array() }]);
      const run = await watched("empty address", "readLiveTimers", SAM_HANDLE);
      expect(run.outcome).toBeInstanceOf(BrokenRecordError);
      expect((run.outcome as Error).message).toBe(
        "readLiveTimers: a live timer's sealed address holds no bytes",
      );
      for (const value of [SAM_HANDLE, YOGA_TIMER.id, YOGA, SEED_TIMER]) {
        expect((run.outcome as Error).message.includes(value), value).toBe(false);
      }
      expect(run.statements.at(-1)?.text).toBe("rollback");
      expect(run.logged).toBe(0);
    },
  );

  it(
    "a request of the wrong shape is refused before any statement, naming the field, never a value (default 1)",
    SLOW,
    async () => {
      await given(SAM_FIXTURE);
      for (const call of CALLS) {
        const refused: [unknown, string][] = [
          [null, `${call}: the request is an object`],
          [[], `${call}: the request is an object`],
          [{}, `${call}: the request needs handleId`],
          [{ handleId: SAM_HANDLE, businessId: MOVERS }, `${call}: the request takes only handleId`],
          [{ handleId: SAM_HANDLE, number: ALEX_NUMBER }, `${call}: the request takes only handleId`],
          [{ number: ALEX_NUMBER }, `${call}: the request takes only handleId`],
          [
            { handleId: null },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
          [
            { handleId: "" },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
          [
            { handleId: ALEX_NUMBER },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
          [
            { handleId: "5555550101" },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
          [
            { handleId: "alex@example.com" },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
          [
            { handleId: "handle sam" },
            `${call}: handleId is a K-04 handle id (a K-08 safe id), never a number or an address`,
          ],
        ];
        for (const [request, message] of refused) {
          sent.length = 0;
          const error = await thrownBy(READS[call](job, request as never));
          expect(error, `${call} ${JSON.stringify(request)}`).toBeInstanceOf(TypeError);
          expect((error as Error).message).toBe(message);
          for (const value of [ALEX_NUMBER, "5555550101", "alex@example.com", MOVERS]) {
            expect((error as Error).message.includes(value), value).toBe(false);
          }
          expect(sent).toEqual([]);
        }
      }
    },
  );
});

describe("readStoppedFlag, case by case (item 57; default 111): the phone row's flag, fresh, and notFound for no row", () => {
  for (const spec of FLAG_CASES) {
    it(spec.shows, SLOW, async () => {
      await givenFlag(spec);
      const outcome = await readStoppedFlag(job, { handleId: spec.handleId });
      expect(outcome).toEqual(spec.outcome);
      expect(answerErrors("readStoppedFlag", outcome)).toEqual([]);
    });
  }

  it(
    "each re-read is fresh: Alex's STOP read stopped at version 4, then his START committed, and the next re-read reads it at version 5",
    SLOW,
    async () => {
      const stopped = await given(STOPPED_FIXTURE);
      expect(await readStoppedFlag(job, handleOf(stopped))).toEqual(stopped.outcome);
      await runStep("commit-alex-start.json");
      expect(await readStoppedFlag(job, handleOf(stopped))).toEqual(exchangeOf(STARTED_FIXTURE).outcome);
    },
  );

  it(
    "a re-read reads what is committed, waiting on no write: a STOP still being written is not read, and the re-read after its commit reads it",
    SLOW,
    async () => {
      await loadSeeds([coreSeed(PHONES)]);
      await db.sql.begin(async (tx) => {
        await stopRiley(tx);
        expect(await readStoppedFlag(job, { handleId: RILEY_HANDLE })).toEqual({
          handleId: RILEY_HANDLE,
          stopped: false,
          phoneVersion: 2,
        });
      });
      expect(await readStoppedFlag(job, { handleId: RILEY_HANDLE })).toEqual({
        handleId: RILEY_HANDLE,
        stopped: true,
        phoneVersion: 3,
      });
    },
  );
});

describe("one read-only transaction per read, and nothing written (items 56 and 57: 'writing nothing')", () => {
  /** A probe table and a function that writes a row into it whenever it runs: a policy's function makes a read write. */
  async function withProbe(
    policy: { table: string; enable: boolean; restrictive: boolean },
    body: (probeRows: () => Promise<number>) => Promise<void>,
  ): Promise<void> {
    const schema = `"${db.schema}"`;
    const probe = `${schema}.t_write_probe`;
    const probeOf = `${schema}.t_write_probe_of`;
    const table = `${schema}.${policy.table}`;
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
      if (policy.enable) {
        await db.sql.unsafe(`alter table ${table} enable row level security`);
      }
      await db.sql.unsafe(
        `create policy t_write_probe on ${table} ${policy.restrictive ? "as restrictive " : ""}` +
          `for select to ${JOB_ROLE} using (${probeOf}())`,
      );
      await body(probeRows);
    } finally {
      await db.sql.unsafe(`drop policy if exists t_write_probe on ${table}`);
      if (policy.enable) {
        await db.sql.unsafe(`alter table ${table} disable row level security`);
      }
      await db.sql.unsafe(`drop function if exists ${probeOf}()`);
      await db.sql.unsafe(`drop table if exists ${probe}`);
    }
  }

  /** The read in its own transaction meets the probe's write: refused (25006), scrubbed, rolled back, nothing left. */
  async function expectWriteRefused(
    call: Call,
    handleId: string,
    probeRows: () => Promise<number>,
  ): Promise<void> {
    const before = await fingerprint();
    const run = await watched("probe", call, handleId);
    expect(run.outcome).toBeInstanceOf(DataAccessDatabaseError);
    expect((run.outcome as DataAccessDatabaseError).code).toBe("25006");
    expect((run.outcome as Error).message).toContain(
      `${call}: the database refused the call (SQLSTATE 25006`,
    );
    for (const value of [handleId, ...NEVER_ANSWERED]) {
      expect((run.outcome as Error).message.includes(value), value).toBe(false);
    }
    expect(run.statements.some((statement) => statement.text === "rollback")).toBe(true);
    expect(run.logged).toBe(0);
    expect(await probeRows()).toBe(0);
    expect(await fingerprint()).toEqual(before);
  }

  it(
    "readLiveTimers: a write inside its own transaction is refused (25006, thrown scrubbed) and leaves nothing; the same write goes through in a transaction that allows it",
    SLOW,
    async () => {
      await given(SAM_FIXTURE);
      await withProbe({ table: "safety_timers", enable: false, restrictive: true }, async (probeRows) => {
        // In a transaction that may write, the probe writes when Sam's timers are read.
        await job.begin(async (tx) => {
          await tx`select id from safety_timers where worker_handle_id = ${SAM_HANDLE}`;
        });
        expect(await probeRows()).toBeGreaterThan(0);
        await db.sql.unsafe(`truncate "${db.schema}".t_write_probe`);
        await expectWriteRefused("readLiveTimers", SAM_HANDLE, probeRows);
      });
      expect(await readLiveTimers(job, { handleId: SAM_HANDLE })).toEqual(exchangeOf(SAM_FIXTURE).outcome);
    },
  );

  it(
    "readStoppedFlag: a write inside its own transaction is refused (25006, thrown scrubbed) and leaves nothing; the same write goes through in a transaction that allows it",
    SLOW,
    async () => {
      const stopped = await given(STOPPED_FIXTURE);
      await withProbe({ table: "phones", enable: true, restrictive: false }, async (probeRows) => {
        await job.begin(async (tx) => {
          await tx`select stopped from phones where handle_id = ${ALEX_HANDLE}`;
        });
        expect(await probeRows()).toBeGreaterThan(0);
        await db.sql.unsafe(`truncate "${db.schema}".t_write_probe`);
        await expectWriteRefused("readStoppedFlag", ALEX_HANDLE, probeRows);
      });
      expect(await readStoppedFlag(job, handleOf(stopped))).toEqual(stopped.outcome);
    },
  );

  it(
    "nothing is written: every table's row count and content are the same before and after both reads of every handle, an unknown one, refused requests and the Tool API's role",
    SLOW,
    async () => {
      await loadSeeds([partSeed(TIMER_SEED), coreSeed(PHONES)]);
      await writeRows([MISSED_TIMER, RILEY_TIMER].flatMap(timerRows));
      await stopRiley(db.sql);
      const handles = await db.sql<{ id: string }[]>`select id from handles order by id collate "C"`;
      expect(handles.length).toBeGreaterThan(7);
      const before = await fingerprint();
      for (const { id } of handles) {
        expect(answerErrors("readLiveTimers", await readLiveTimers(job, { handleId: id }))).toEqual([]);
        expect(answerErrors("readStoppedFlag", await readStoppedFlag(job, { handleId: id }))).toEqual([]);
      }
      await readLiveTimers(job, { handleId: "handle-t1301-unknown" });
      await readStoppedFlag(job, { handleId: "handle-t1301-unknown" });
      await thrownBy(readLiveTimers(job, { handleId: ALEX_NUMBER }));
      await thrownBy(readStoppedFlag(job, { number: ALEX_NUMBER } as never));
      await thrownBy(readLiveTimers(app, { handleId: SAM_HANDLE }));
      await thrownBy(readStoppedFlag(app, { handleId: SAM_HANDLE }));
      expect(await fingerprint()).toEqual(before);
      // Live timers and a stopped phone are among what stayed as it was.
      expect(before.safety_timers).toMatch(/^3 rows, /);
      expect(before.phones).toMatch(/^7 rows, /);
    },
  );
});

// ---- the statements the reads send ------------------------------------------------------------------------------------

/** Each statement the reads send, as sent: whitespace folded, each parameter as `$`. */
const STATEMENT = {
  scope: "select set_config($, '', true)",
  rights:
    "select pg_has_role(current_user, 'rosie_app', 'USAGE') as app, pg_has_role(current_user, 'rosie_job', 'USAGE') as job",
  timers:
    "select id, business_id, booking_id, worker_handle_id, emergency_contact_person_id, emergency_contact_handle_id, " +
    "due_at, due_zone, encode(address, 'hex') as address_hex, address_for_person_id, clock_row_id, state, version " +
    "from safety_timers where worker_handle_id = $ and state in ('running', 'missed') order by due_at, id collate \"C\"",
  flag: "select stopped, version from phones where handle_id = $",
} as const;

/** Each read's statements inside its transaction, after the scope is set empty, in order. */
const READ_STATEMENTS: Readonly<Record<Call, readonly string[]>> = {
  readLiveTimers: [STATEMENT.rights, STATEMENT.timers],
  readStoppedFlag: [STATEMENT.flag],
};

/** Each table the reads read, and the columns its statement selects: item 56's thirteen, and item 57's two. */
const SELECTED: Readonly<Record<string, readonly string[]>> = {
  safety_timers: [
    "address",
    "address_for_person_id",
    "booking_id",
    "business_id",
    "clock_row_id",
    "due_at",
    "due_zone",
    "emergency_contact_handle_id",
    "emergency_contact_person_id",
    "id",
    "state",
    "version",
    "worker_handle_id",
  ],
  phones: ["stopped", "version"],
};

/** The columns each finds and orders its rows by: never a number. */
const FOUND_BY: Readonly<Record<string, readonly string[]>> = {
  safety_timers: ["worker_handle_id", "state", "due_at", "id"],
  phones: ["handle_id"],
};

/** The words the statements are made of beside their one table, its columns, parameters and punctuation. */
const SQL_WORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "in",
  "order",
  "by",
  "as",
  "encode",
  "address_hex",
]);

/** The tables no statement may name a column of (README v1.12, "What the new tasks must hold to"). */
const NEVER_READ = ["sealing_keys", "messages", "consents", "proof_codes"];

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
/** The statement with whitespace folded and each parameter as `$`. */
const canonical = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\$\d+/g, "$");

/** The names no statement may hold: the four tables and every column of theirs that neither read's table has. */
function neverNamed(): Set<string> {
  const own = new Set(Object.keys(SELECTED).flatMap((table) => [...(schemaColumns.get(table) ?? [])]));
  const theirs = NEVER_READ.flatMap((table) => [...(schemaColumns.get(table) ?? [])]);
  return new Set([...NEVER_READ, ...theirs.filter((column) => !own.has(column))]);
}

/**
 * What is wrong with one statement that reads a table: a name never named, `*`, more than one table or one beyond the
 * reads', a select list that is not its table's listed columns (one missing, or anything more but encode() and its
 * alias), or any other name but its table's finding columns and the plain words of a select.
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
    return [...problems, `a table beyond the reads': ${table}`];
  }
  const from = tokens.indexOf("from");
  if (tokens[0] !== "select" || from < 2 || tokens[from + 1] !== table) {
    problems.push("not a select from its one table");
  }
  const listed = new Set<string>();
  tokens.forEach((token, index) => {
    if (index === 0 || index === from || index === from + 1 || !isName(token)) {
      if (index > 0 && index < from && token !== "," && token !== "(" && token !== ")" && !isName(token)) {
        problems.push(`selected beyond its list: ${token}`);
      }
      return;
    }
    if (index < from) {
      if (selected.includes(token)) {
        listed.add(token);
      } else if (!SQL_WORDS.has(token)) {
        problems.push(`selected beyond its list: ${token}`);
      }
    } else if (!SQL_WORDS.has(token) && !foundBy.includes(token)) {
      problems.push(`a name beyond its own: ${token}`);
    }
  });
  for (const column of selected) {
    if (!listed.has(column)) {
      problems.push(`a listed column not selected: ${column}`);
    }
  }
  return problems;
}

describe("the statements the reads send: items 56 and 57's reads, their columns alone, never a column of sealing_keys, messages, consents or proof_codes", () => {
  it("the four tables and the reads' two exist in this schema, so the check below is about real columns", () => {
    for (const table of [...NEVER_READ, ...Object.keys(SELECTED)]) {
      expect(schemaColumns.has(table), table).toBe(true);
    }
  });

  it("the check refuses a stray table, column or word, a number read, a whole row, a listed column left out and a column of the four tables (shown on statements made to fail)", () => {
    const caught: { statement: string; problems: string[] }[] = [
      {
        statement: "select stopped, version, number from phones where handle_id = $1",
        problems: ["selected beyond its list: number"],
      },
      {
        statement: "select * from phones where handle_id = $1",
        problems: ["*", "selected beyond its list: *"],
      },
      {
        statement: "select stopped from phones where handle_id = $1",
        problems: ["a listed column not selected: version"],
      },
      {
        statement: "select stopped, version from phones where number = $1",
        problems: ["a name beyond its own: number"],
      },
      {
        statement:
          "select p.stopped, p.version from phones p join sealing_keys k on k.person_id = p.handle_id where p.handle_id = $1",
        problems: [
          "never named: sealing_keys",
          "never named: person_id",
          "more than one table: phones, sealing_keys",
        ],
      },
      {
        statement:
          "select stopped, version from phones where handle_id = $1 union select words, version from messages",
        problems: ["never named: messages", "never named: words", "more than one table: phones, messages"],
      },
      {
        statement: "select code_hash from proof_codes where id = $1",
        problems: ["never named: proof_codes", "never named: code_hash"],
      },
      {
        statement: "select exact_words from consents where handle_id = $1",
        problems: ["never named: consents", "never named: exact_words"],
      },
      {
        statement: "select to_jsonb(t) from safety_timers t where t.worker_handle_id = $1",
        problems: [
          "selected beyond its list: to_jsonb",
          "selected beyond its list: t",
          "a name beyond its own: t",
        ],
      },
      {
        statement: "select id, state, version from safety_timers where worker_handle_id = $1",
        problems: ["a listed column not selected: address", "a listed column not selected: due_at"],
      },
      {
        statement:
          "select id, business_id, booking_id, worker_handle_id, worker_person_id, emergency_contact_person_id, " +
          "emergency_contact_handle_id, due_at, due_zone, encode(address, 'hex') as address_hex, address_for_person_id, " +
          "clock_row_id, state, version from safety_timers where worker_handle_id = $1",
        problems: ["selected beyond its list: worker_person_id"],
      },
    ];
    for (const { statement, problems } of caught) {
      const found = problemsOf(statement);
      for (const problem of problems) {
        expect(found, statement).toContain(problem);
      }
    }
    // The reads' own statements pass, with parameters as postgres.js binds them.
    const own = [STATEMENT.timers, STATEMENT.flag].map((statement) => statement.replace("$", () => "$1"));
    for (const statement of own) {
      expect(problemsOf(statement), statement).toEqual([]);
    }
    expect(problemsOf(STATEMENT.rights)).toEqual(["no table"]);
  });

  it(
    "over every fixture and every case: one read-only transaction per read with the scope set empty, each read's statements as written, only its columns, the handle's id each table read's one parameter, nothing logged, and no answer holding a number or an address opened",
    HEAVY,
    async () => {
      const runs = await everyRun();
      expect(runs).toHaveLength(ACCEPTED.length + TIMERS_CASES.length + FLAG_CASES.length);
      for (const run of runs) {
        const { label } = run;
        expect(run.logged, label).toBe(0);
        expect(run.outcome, label).not.toBeInstanceOf(Error);
        expect(answerErrors(run.call, run.outcome), label).toEqual([]);

        // One transaction: one read-only begin on one connection, the scope set empty, the reads, then commit.
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
        expect(inside[end]?.text, label).toBe("commit");
        expect(canonical(inside[0]?.text ?? ""), label).toBe(STATEMENT.scope);
        expect(inside[0]?.parameters, label).toEqual([SCOPE_SETTING]);
        const reads = inside.slice(1, end);
        expect(
          reads.map((statement) => canonical(statement.text)),
          label,
        ).toEqual(READ_STATEMENTS[run.call]);
        for (const statement of inside.slice(0, end + 1)) {
          expect(statement.connection, label).toBe(connection);
        }
        // Outside the transaction nothing reads a table (inRuntimeTransaction's `select 1` alone).
        const outside = [...run.statements.slice(0, begin), ...inside.slice(end + 1)];
        expect(
          outside.map((statement) => statement.text),
          label,
        ).toEqual(["select 1"]);

        // Each table read: its columns alone, never a column of the four tables, the handle's id its one parameter.
        for (const statement of reads) {
          if (tokensOf(statement.text).some(isTable)) {
            expect(problemsOf(statement.text), `${label}: ${statement.text}`).toEqual([]);
            expect(statement.parameters, label).toEqual([run.handleId]);
          } else {
            expect(statement.parameters, label).toEqual([]);
          }
        }

        // The answer: no number, no address opened into words; a timer's address only as sealed bytes' hex text.
        const text = JSON.stringify(run.outcome);
        for (const value of NEVER_ANSWERED) {
          expect(text.includes(value), `${label}: ${value}`).toBe(false);
        }
        if (run.call === "readLiveTimers") {
          for (const one of (run.outcome as ReadLiveTimersResponse).timers) {
            expect(one.address, label).toMatch(/^\\x(?:[0-9a-f]{2})+$/);
          }
        }
      }
    },
  );
});

describe("a lost connection answers transient, with no address, number, id or connection detail (K-05 transientError)", () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The backend of `applicationName` once it waits on a lock, polling every 20 ms for at most 120 s: a resource guard
   * for a loaded build Mac, not part of the test's claim (the test's own limit is HEAVY's).
   */
  async function lockWaiter(applicationName: string): Promise<number> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const [row] = await db.sql<{ pid: number }[]>`
        select pid from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'
      `;
      if (row !== undefined) {
        return row.pid;
      }
      await pause(20);
    }
    throw new Error(`waited 120 s, and ${applicationName} never waited on a lock`);
  }

  const cases: { call: Call; fixture: string; table: string }[] = [
    { call: "readLiveTimers", fixture: SAM_FIXTURE, table: "safety_timers" },
    { call: "readStoppedFlag", fixture: STOPPED_FIXTURE, table: "phones" },
  ];

  for (const { call, fixture, table } of cases) {
    it(
      `${call}, its backend terminated while it waits on ${table}, answers transient with its SQLSTATE alone, writes nothing, and the same request then answers`,
      HEAVY,
      async () => {
        const exchange = await given(fixture);
        const url = new URL(resolvePrimaryUrl());
        const neverInAnswer = [
          ...NEVER_ANSWERED,
          seedLiveTimer().address,
          handleOf(exchange).handleId,
          resolvePrimaryUrl(),
          url.host,
          url.username,
          url.password,
        ].filter((value) => value !== "");
        const before = await fingerprint();
        const application = `rosie-t1301-cut-${table}`;
        // A one-connection rosie_job client of its own; its one connection is dead after, and never released
        // (targets.ts inRuntimeTransaction), so it is closed at once.
        const victim = roleClient(JOB_ROLE, application, 1, null);
        let outcome: unknown;
        try {
          outcome = await db.sql.begin(async (tx) => {
            await tx`lock table ${tx(table)} in access exclusive mode`;
            const pending = READS[call](victim, handleOf(exchange));
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
        expect(answerErrors(call, outcome)).toEqual([]);
        const text = JSON.stringify(outcome);
        for (const value of neverInAnswer) {
          expect(text.includes(value), value).toBe(false);
        }
        expect(await fingerprint()).toEqual(before);
        expect(await READS[call](job, handleOf(exchange))).toEqual(exchange.outcome);
      },
    );
  }
});
