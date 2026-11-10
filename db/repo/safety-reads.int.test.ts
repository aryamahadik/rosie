// T-1161: K-05 v1.4's seven safety reads against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/safety-reads`). The schema comes from migrating a fresh test schema, which
// test-db.ts drops when the file ends.
//
// Every call runs in the role K-05 v1.4 names (items 37 to 43, default 55; DL-348): the five record reads and the zone,
// with a business, through a client whose connections run as rosie_app, the Tool API's role; the five with no business
// as rosie_job on the runtime side; readBusinessOwner as rosie_job under the business's scope. The tables' owner (the
// migrations' role) loads the seeds a fixture's `given` names (K-04's, and K-34's and K-22's as partSeeds) and writes
// the extra rows a test adds; the owner is not bound by row-level security, so only the reads under test meet it. The
// commits a fixture's `after` chain names run for real through db/repo's commitTurn as rosie_job.
//
// Both role clients record every statement they send (postgres.js `debug`), so the column-list test reads what the
// seven reads sent, not a copy of their SQL. It pins each read's tables and its column list, refuses whole-row
// references (a bare row alias, to_jsonb, row_to_json) and every sealed column, event_log.sealed_values and
// harm_reports.sealed_details among them, and shows on statements made to fail that it catches each (DL-345, as T-1168
// does for T-1138's reads).
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import {
  readBusinessOwner,
  readBusinessOwnerIn,
  type ReadBusinessOwnerResponse,
  readBusinessZone,
  readBusinessZoneIn,
  readOutboxRowWritten,
  readOutboxRowWrittenIn,
  readSafetyHold,
  readSafetyHoldIn,
  readSafetyHoldOfOutcome,
  readSafetyHoldOfOutcomeIn,
  type ReadSafetyHoldOfOutcomeResponse,
  type ReadSafetyHoldResponse,
  readSafetyOutcome,
  readSafetyOutcomeIn,
  readSafetyOutcomeOfEvent,
  readSafetyOutcomeOfEventIn,
  type ReadSafetyOutcomeOfEventResponse,
  type ReadSafetyOutcomeResponse,
  type SafetyRead,
  type StoredHold,
  type StoredOutcome,
} from "./safety-reads";
import { BusinessScopeError, setBusinessScope, type Sql, type Tx, withBusiness } from "./scope";
import { inRuntimeTransaction, type ReadOptions } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Request = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const APP_ROLE = "rosie_app";
const JOB_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
/** K-34's stand-in for sealed words (its seeds' sealed_words), as text and as the hex its bytes are written in. */
const SEALED_TEXT = "k34-seed-sealed-words-not-real";
const SEALED_HEX = "6b33342d736565642d7365616c65642d776f7264732d6e6f742d7265616c";
const TRIES = [{ model: "haiku", result: "verdict" }];

const CALLS = [
  "readSafetyOutcomeOfEvent",
  "readSafetyOutcome",
  "readSafetyHold",
  "readSafetyHoldOfOutcome",
  "readOutboxRowWritten",
  "readBusinessOwner",
  "readBusinessZone",
] as const satisfies readonly SafetyRead[];
type Call = (typeof CALLS)[number];

/** Each read's tables, and no others (DL-345): the business found first, then the read's own rows. */
const TABLES_OF: Readonly<Record<Call, readonly string[]>> = {
  readSafetyOutcomeOfEvent: ["businesses", "safety_outcomes"],
  readSafetyOutcome: ["businesses", "safety_outcomes"],
  readSafetyHold: ["businesses", "safety_holds"],
  readSafetyHoldOfOutcome: ["businesses", "safety_holds"],
  readOutboxRowWritten: ["businesses", "outbox_rows"],
  readBusinessOwner: ["businesses", "handles", "person_handles", "person_roles"],
  readBusinessZone: ["businesses"],
};

/** StoredOutcome's fifteen columns (item 37; default 60): never sealed_words, tries or danger_word_lists. */
const OUTCOME_COLUMNS = [
  "booking_id",
  "business_id",
  "danger_word_kinds",
  "event_id",
  "handle_id",
  "id",
  "labels",
  "lifted_to_unsure",
  "outcomes",
  "person_id",
  "read_at",
  "source",
  "tenses",
  "timed_out",
  "turn_id",
];
/** Every column of safety_holds, none sealed (item 39). */
const HOLD_COLUMNS = [
  "blocks_booking",
  "booking_id",
  "business_id",
  "handle_id",
  "held_at",
  "id",
  "person_id",
  "release_rule",
  "released_at",
  "released_by_outcome_id",
  "released_by_turn_id",
  "released_why",
  "safety_outcome_id",
  "turn_id",
  "version",
];

/**
 * Each read's column list, and no other column of its tables (item 37: the barrier is the column list; DL-345): the
 * business's id and business_id, by which every read names the business, among them.
 */
const COLUMNS_OF: Readonly<Record<Call, readonly string[]>> = {
  readSafetyOutcomeOfEvent: OUTCOME_COLUMNS,
  readSafetyOutcome: OUTCOME_COLUMNS,
  readSafetyHold: HOLD_COLUMNS,
  readSafetyHoldOfOutcome: HOLD_COLUMNS,
  readOutboxRowWritten: ["business_id", "id"],
  readBusinessOwner: ["business_id", "ended_at", "handle_id", "id", "kind", "person_id", "role"],
  readBusinessZone: ["id", "time_zone"],
};

interface Given {
  k04Seeds: string[];
  after: string[];
  now: string;
  note?: string;
  partSeeds?: string[];
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

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const acceptedOf = (def: string): string[] =>
  INDEX.filter((entry) => entry.def === def && entry.expect === "accept").map((entry) => entry.file);
const READ_FIXTURES = CALLS.flatMap((call) => acceptedOf(`${call}.exchange`));
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -----------------

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
const V14_ID = (readJson(new URL("data-access/data-access.v1.4.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.4, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V14_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.4 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** The outcome checked against the call's response, or its errors when it is one. */
function outcomeErrors(call: Call, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? `${call}.errors` : `${call}.response`, outcome);
}

/** The outcome as the call's response, refused when it is anything else. */
function answerOf<T extends { result: string }>(outcome: unknown, result: T["result"]): T {
  if ((outcome as { result?: unknown }).result !== result) {
    throw new Error(`expected the answer ${result}`);
  }
  return outcome as T;
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
/** Every statement the two role clients sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

function roleClient(role: string, applicationName: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 5,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: applicationName, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "safety_reads" });
  app = roleClient(APP_ROLE, "rosie-t1161-app");
  job = roleClient(JOB_ROLE, "rosie-t1161-job");
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
}, 60_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await job.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table and restarts its identity (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
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

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it. */
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

/** Inserts the rows of these seed files and their chains, each row once, in one transaction as the owner. */
async function loadSeeds(files: readonly URL[]): Promise<void> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => seedRows(file, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** A fixture's chain: the seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: URL[]; steps: string[] } {
  const exchange = exchangeOf(file);
  const seeds = [
    ...exchange.given.k04Seeds.map((seed) => new URL(seed, CORE_DIR)),
    ...(exchange.given.partSeeds ?? []).map(partSeedUrl),
  ];
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

/** Loads a fixture's seeds and runs its chain's commits for real (commitTurn, T-195, as rosie_job). */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    if (before.call !== "commitTurn") {
      throw new Error(`${step}: this test runs no ${before.call} step`);
    }
    const outcome = await commitTurn(job, structuredClone(before.request) as unknown as CommitTurnRequest, {
      now: new Date(before.given.now),
    });
    expect(outcome, step).toEqual(before.outcome);
  }
  return exchange;
}

const nowOf = (exchange: Exchange): { now: Date } => ({ now: new Date(exchange.given.now) });
const businessOf = (request: Request): string | null =>
  typeof request.businessId === "string" ? request.businessId : null;

// ---- the reads, each in its role ------------------------------------------------------------------------------------

type OwnRead = (sql: Sql, request: never, options?: ReadOptions) => Promise<unknown>;
type InRead = (db: Db, request: never, options?: ReadOptions) => Promise<unknown>;

/** Each call in a read-only transaction of its own. */
const OWN: Readonly<Record<Call, OwnRead>> = {
  readSafetyOutcomeOfEvent,
  readSafetyOutcome,
  readSafetyHold,
  readSafetyHoldOfOutcome,
  readOutboxRowWritten,
  readBusinessOwner,
  readBusinessZone,
};

/** Each call inside a transaction its caller holds. */
const IN: Readonly<Record<Call, InRead>> = {
  readSafetyOutcomeOfEvent: readSafetyOutcomeOfEventIn,
  readSafetyOutcome: readSafetyOutcomeIn,
  readSafetyHold: readSafetyHoldIn,
  readSafetyHoldOfOutcome: readSafetyHoldOfOutcomeIn,
  readOutboxRowWritten: readOutboxRowWrittenIn,
  readBusinessOwner: readBusinessOwnerIn,
  readBusinessZone: readBusinessZoneIn,
};

/** The client of the role K-05 v1.4 gives a call (default 55): rosie_job for the owner and with no business. */
const clientFor = (call: Call, businessId: string | null): Sql =>
  call === "readBusinessOwner" || businessId === null ? job : app;

/** The read an exchange names, in its own transaction, in the role K-05 v1.4 gives it. */
async function runRead(exchange: Exchange): Promise<unknown> {
  const call = exchange.call as Call;
  return await OWN[call](
    clientFor(call, businessOf(exchange.request)),
    exchange.request as never,
    nowOf(exchange),
  );
}

/** The In read inside the call's own transaction: withBusiness on its role's client, or the runtime side's. */
async function runIn(call: Call, request: Request, options: ReadOptions): Promise<unknown> {
  const businessId = businessOf(request);
  const sql = clientFor(call, businessId);
  const read = (tx: Db): Promise<unknown> => IN[call](tx, request as never, options);
  return businessId === null
    ? await inRuntimeTransaction(sql, { readOnly: true }, read)
    : await withBusiness(sql, businessId, read, { readOnly: true });
}

/** The In read run by the tables' owner, whom row-level security does not bind, under `scope` or with none. */
async function asTablesOwner(
  call: Call,
  request: Request,
  scope: string | null,
  options: ReadOptions = {},
): Promise<unknown> {
  return await db.sql.begin(async (tx) => {
    if (scope !== null) {
      await setBusinessScope(tx, scope);
    }
    return IN[call](tx, request as never, options);
  });
}

// ---- rows of other businesses and of none, beside K-34's barbershop rows ----------------------------------------------

/** K-03 v1 final parts carrying words, so an answer that leaked a row's words would show them. */
function wordsParts(row: string, text: string): Json {
  return {
    row,
    channel: "imessage",
    sends: [{ kind: "words", text, calendarFile: "none", options: [], link: null }],
    fixedLines: [],
    slotValues: [],
    threadReplyTo: null,
  };
}

/** One business's (or no business's) safety outcome, its hold and an outbox row, each on Alex's handle. */
interface Home {
  businessId: string | null;
  turnId: string;
  eventId: string;
  outcomeId: string;
  holdId: string;
  outboxRowId: string;
  words: string;
}

/** K-34's seed-outcome-crisis rows at the barbershop, with an outbox row of its turn that the test adds. */
const BARBERSHOP_HOME: Home = {
  businessId: BARBERSHOP,
  turnId: "turn-alex-0203",
  eventId: "evt-alex-0203",
  outcomeId: "safety-alex-0203",
  holdId: "hold-alex-0203",
  outboxRowId: "out-alex-barber-1",
  words: "Words of the barbershop's checked line",
};
const YOGA_HOME: Home = {
  businessId: YOGA,
  turnId: "turn-alex-yoga-1",
  eventId: "evt-alex-yoga-1",
  outcomeId: "safety-alex-yoga-1",
  holdId: "hold-alex-yoga-1",
  outboxRowId: "out-alex-yoga-1",
  words: "Words of the yoga studio's checked line",
};
const NO_BUSINESS_HOME: Home = {
  businessId: null,
  turnId: "turn-alex-nobiz-1",
  eventId: "evt-alex-nobiz-1",
  outcomeId: "safety-alex-nobiz-1",
  holdId: "hold-alex-nobiz-1",
  outboxRowId: "out-alex-nobiz-1",
  words: "Words of Rosie's own checked line",
};
const HOMES: readonly Home[] = [BARBERSHOP_HOME, YOGA_HOME, NO_BUSINESS_HOME];
const SCOPES: readonly (string | null)[] = [BARBERSHOP, YOGA, null];

/** The yoga studio's read of a text: No, lifted to Unsure by a danger word, its words sealed. */
const YOGA_OUTCOME: StoredOutcome = {
  id: "safety-alex-yoga-1",
  eventId: "evt-alex-yoga-1",
  source: "text",
  handleId: "handle-alex",
  personId: "person-alex",
  businessId: YOGA,
  bookingId: "booking-alex-workshop",
  turnId: "turn-alex-yoga-1",
  readAt: "2026-10-26T10:00:01Z",
  timedOut: false,
  labels: ["No"],
  tenses: ["joke"],
  dangerWordKinds: ["selfHarm"],
  outcomes: ["Unsure"],
  liftedToUnsure: true,
};
const YOGA_HOLD: StoredHold = {
  id: "hold-alex-yoga-1",
  safetyOutcomeId: "safety-alex-yoga-1",
  businessId: YOGA,
  handleId: "handle-alex",
  personId: "person-alex",
  bookingId: "booking-alex-workshop",
  turnId: "turn-alex-yoga-1",
  releaseRule: "after_safe",
  blocksBooking: true,
  heldAt: "2026-10-26T10:00:03Z",
  releasedAt: null,
  releasedWhy: null,
  releasedByTurnId: null,
  releasedByOutcomeId: null,
  version: 1,
};
/** A text before there is a business: an emergency, its hold released once the outcome's message went. */
const NO_BUSINESS_OUTCOME: StoredOutcome = {
  id: "safety-alex-nobiz-1",
  eventId: "evt-alex-nobiz-1",
  source: "text",
  handleId: "handle-alex",
  personId: "person-alex",
  businessId: null,
  bookingId: null,
  turnId: "turn-alex-nobiz-1",
  readAt: "2026-10-20T10:00:01Z",
  timedOut: false,
  labels: ["An emergency"],
  tenses: ["now"],
  dangerWordKinds: ["other"],
  outcomes: ["An emergency"],
  liftedToUnsure: false,
};
const NO_BUSINESS_HOLD: StoredHold = {
  id: "hold-alex-nobiz-1",
  safetyOutcomeId: "safety-alex-nobiz-1",
  businessId: null,
  handleId: "handle-alex",
  personId: "person-alex",
  bookingId: null,
  turnId: "turn-alex-nobiz-1",
  releaseRule: "at_once",
  blocksBooking: false,
  heldAt: "2026-10-20T10:00:03Z",
  releasedAt: "2026-10-20T10:00:09Z",
  releasedWhy: "outcome_message_sent",
  releasedByTurnId: "turn-alex-nobiz-1",
  releasedByOutcomeId: null,
  version: 2,
};

/**
 * Beside K-34's barbershop crisis rows on Alex's handle (seed-outcome-crisis): the yoga studio's outcome and open hold
 * and a text's outcome and released hold with no business, each from its own turn, every outcome with sealed words;
 * and a safety outbox row for each of the three, its plan and final parts carrying words.
 */
async function addRowsElsewhere(): Promise<void> {
  await db.sql.begin(async (tx) => {
    for (const [home, at] of [
      [YOGA_HOME, "2026-10-26T10:00:03Z"],
      [NO_BUSINESS_HOME, "2026-10-20T10:00:03Z"],
    ] as const) {
      await insertRow(tx, "turns", {
        id: home.turnId,
        handle_id: "handle-alex",
        event_ids: [home.eventId],
        state: "committed",
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        trace_id: `trace-${home.eventId}`,
        committed_at: at,
      });
    }
    await insertRow(tx, "safety_outcomes", {
      id: YOGA_OUTCOME.id,
      event_id: YOGA_OUTCOME.eventId,
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: YOGA,
      booking_id: "booking-alex-workshop",
      turn_id: YOGA_HOME.turnId,
      read_at: YOGA_OUTCOME.readAt,
      tries: TRIES,
      timed_out: false,
      labels: ["No"],
      tenses: ["joke"],
      danger_word_lists: ["general"],
      danger_word_kinds: ["selfHarm"],
      sealed_words: `\\x${SEALED_HEX}`,
      outcomes: ["Unsure"],
      lifted_to_unsure: true,
    });
    await insertRow(tx, "safety_holds", {
      id: YOGA_HOLD.id,
      safety_outcome_id: YOGA_OUTCOME.id,
      business_id: YOGA,
      handle_id: "handle-alex",
      person_id: "person-alex",
      booking_id: "booking-alex-workshop",
      turn_id: YOGA_HOME.turnId,
      release_rule: "after_safe",
      blocks_booking: true,
      held_at: YOGA_HOLD.heldAt,
    });
    await insertRow(tx, "safety_outcomes", {
      id: NO_BUSINESS_OUTCOME.id,
      event_id: NO_BUSINESS_OUTCOME.eventId,
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: null,
      turn_id: NO_BUSINESS_HOME.turnId,
      read_at: NO_BUSINESS_OUTCOME.readAt,
      tries: TRIES,
      timed_out: false,
      labels: ["An emergency"],
      tenses: ["now"],
      danger_word_lists: ["plugin"],
      danger_word_kinds: ["other"],
      sealed_words: `\\x${SEALED_HEX}`,
      outcomes: ["An emergency"],
    });
    await insertRow(tx, "safety_holds", {
      id: NO_BUSINESS_HOLD.id,
      safety_outcome_id: NO_BUSINESS_OUTCOME.id,
      business_id: null,
      handle_id: "handle-alex",
      person_id: "person-alex",
      turn_id: NO_BUSINESS_HOME.turnId,
      release_rule: "at_once",
      blocks_booking: false,
      held_at: NO_BUSINESS_HOLD.heldAt,
      released_at: "2026-10-20T10:00:09Z",
      released_why: "outcome_message_sent",
      released_by_turn_id: NO_BUSINESS_HOME.turnId,
      version: 2,
    });
    for (const home of HOMES) {
      await insertRow(tx, "outbox_rows", {
        id: home.outboxRowId,
        turn_id: home.turnId,
        recipient_handle_id: "handle-alex",
        recipient_person_id: "person-alex",
        business_id: home.businessId,
        channel: "imessage",
        send_class: "safety",
        versions_read: [],
        plan: { row: home.outboxRowId },
        final_parts: wordsParts(home.outboxRowId, home.words),
        state: "sent",
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        trace_id: `trace-${home.outboxRowId}`,
      });
    }
  });
}

/** The five record reads of one home's rows, as requests under `businessId` (items 37 to 41). */
function recordRequests(home: Home, businessId: string | null): [Call, Request][] {
  return [
    ["readSafetyOutcomeOfEvent", { eventId: home.eventId, businessId }],
    ["readSafetyOutcome", { outcomeId: home.outcomeId, businessId }],
    ["readSafetyHold", { holdId: home.holdId, businessId }],
    ["readSafetyHoldOfOutcome", { outcomeId: home.outcomeId, businessId }],
    ["readOutboxRowWritten", { outboxRowId: home.outboxRowId, businessId }],
  ];
}

/** What a record read found: the row's own id, or null when it saw none (written false). */
function foundOf(call: Call, outcome: unknown): string | null {
  const answer = outcome as {
    safetyOutcome?: { id: string } | null;
    hold?: { id: string } | null;
    written?: boolean;
    outboxRowId?: string;
  };
  if (call === "readSafetyOutcomeOfEvent" || call === "readSafetyOutcome") {
    return answer.safetyOutcome?.id ?? null;
  }
  if (call === "readSafetyHold" || call === "readSafetyHoldOfOutcome") {
    return answer.hold?.id ?? null;
  }
  if (call === "readOutboxRowWritten") {
    return answer.written === true ? (answer.outboxRowId ?? null) : null;
  }
  throw new Error(`${call} is not a record read`);
}

/** The id a record read of a home's row finds when it sees the row. */
function idOf(call: Call, home: Home): string {
  if (call === "readSafetyHold" || call === "readSafetyHoldOfOutcome") {
    return home.holdId;
  }
  return call === "readOutboxRowWritten" ? home.outboxRowId : home.outcomeId;
}

/** A handle linked to a person, as the tables' owner writes it (K-04: added once, never updated). */
async function addHandle(
  id: string,
  kind: "phone" | "email",
  address: string,
  personId: string,
): Promise<void> {
  await insertRow(db.sql, "handles", { id, kind, address });
  await insertRow(db.sql, "person_handles", { person_id: personId, handle_id: id });
}

/** A live role, as the tables' owner writes it. */
async function addRole(id: string, personId: string, businessId: string, role: string): Promise<void> {
  await insertRow(db.sql, "person_roles", { id, person_id: personId, business_id: businessId, role });
}

/** Ends a role: K-04 keeps its row with ended_at, its version raised. */
async function endRole(id: string): Promise<void> {
  await db.sql`
    update person_roles set ended_at = '2026-10-26T12:00:00Z', version = version + 1 where id = ${id}
  `;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the roles the reads run as (K-05 v1.4 items 37 to 43, default 55; T-191)", () => {
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

describe("each v1.4 fixture of the seven reads gives its outcome (K-05 v1.4 items 37 to 43)", () => {
  it("the index lists the seven reads' eighteen exchanges, each valid against data-access v1.4", SLOW, () => {
    expect(Object.fromEntries(CALLS.map((call) => [call, acceptedOf(`${call}.exchange`).sort()]))).toEqual({
      readSafetyOutcomeOfEvent: [
        "read-safety-outcome-of-event-alex.json",
        "read-safety-outcome-of-event-other-business.json",
        "read-safety-outcome-of-event-s1-01.json",
      ],
      readSafetyOutcome: ["read-safety-outcome-alex-safe.json", "read-safety-outcome-no-business.json"],
      readSafetyHold: [
        "read-safety-hold-alex-open.json",
        "read-safety-hold-alex-released.json",
        "read-safety-hold-other-business.json",
      ],
      readSafetyHoldOfOutcome: [
        "read-safety-hold-of-outcome-alex-threat.json",
        "read-safety-hold-of-outcome-none.json",
      ],
      readOutboxRowWritten: [
        "outbox-row-written-alex-safety.json",
        "outbox-row-written-not-yet.json",
        "outbox-row-written-other-business.json",
      ],
      readBusinessOwner: [
        "business-owner-barbershop.json",
        "business-owner-none.json",
        "business-owner-phone-first.json",
      ],
      readBusinessZone: ["business-zone-barbershop.json", "business-zone-no-business-row.json"],
    });
    expect(READ_FIXTURES).toHaveLength(18);
    for (const file of READ_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(schemaErrors(`${exchange.call}.exchange`, exchange), file).toEqual([]);
    }
  });

  for (const file of READ_FIXTURES) {
    it(`${file}: in its role and on its side, the call answers the fixture's outcome`, SLOW, async () => {
      const exchange = await given(file);
      const outcome = await runRead(exchange);
      expect(outcome).toEqual(exchange.outcome);
      expect(outcomeErrors(exchange.call as Call, outcome)).toEqual([]);
    });
  }

  it(
    "each In read inside the call's own transaction (withBusiness on its role, or the runtime side's) answers the same",
    SLOW,
    async () => {
      for (const file of READ_FIXTURES) {
        const exchange = await given(file);
        const outcome = await runIn(exchange.call as Call, exchange.request, nowOf(exchange));
        expect(outcome, file).toEqual(exchange.outcome);
      }
    },
  );

  it(
    "turn 1: the No record's first read finds nothing before its commit, nor while the commit writing its row is open; once it commits, a repeat finds the row (primary, uncached)",
    SLOW,
    async () => {
      const exchange = await given("read-safety-outcome-of-event-s1-01.json");
      const request = exchange.request as never;
      await db.sql.begin(async (tx) => {
        await insertRow(tx, "turns", {
          id: "turn-s1-01-sam",
          handle_id: "handle-sam",
          event_ids: ["evt-sam-s1-01"],
          state: "committed",
          bundle_hash: BUNDLE_HASH,
          bundle_build: 1,
          trace_id: "trace-sam-s1-01",
          committed_at: "2026-10-19T18:05:05Z",
        });
        await insertRow(tx, "safety_outcomes", {
          id: "safety-sam-s1-01",
          event_id: "evt-sam-s1-01",
          source: "text",
          handle_id: "handle-sam",
          person_id: "person-sam",
          business_id: BARBERSHOP,
          turn_id: "turn-s1-01-sam",
          read_at: "2026-10-19T18:05:05Z",
          tries: TRIES,
          timed_out: false,
          labels: ["No"],
          tenses: ["over"],
          outcomes: ["No"],
        });
        expect(await readSafetyOutcomeOfEvent(app, request, nowOf(exchange))).toEqual(exchange.outcome);
      });
      const repeat = await readSafetyOutcomeOfEvent(app, request, nowOf(exchange));
      expect(repeat).toEqual({
        ...exchange.outcome,
        safetyOutcome: {
          id: "safety-sam-s1-01",
          eventId: "evt-sam-s1-01",
          source: "text",
          handleId: "handle-sam",
          personId: "person-sam",
          businessId: BARBERSHOP,
          bookingId: null,
          turnId: "turn-s1-01-sam",
          readAt: "2026-10-19T18:05:05Z",
          timedOut: false,
          labels: ["No"],
          tenses: ["over"],
          dangerWordKinds: [],
          outcomes: ["No"],
          liftedToUnsure: false,
        },
      });
      expect(outcomeErrors("readSafetyOutcomeOfEvent", repeat)).toEqual([]);
      // A No read held nothing.
      const hold = await readSafetyHoldOfOutcome(app, {
        outcomeId: "safety-sam-s1-01",
        businessId: BARBERSHOP,
      });
      expect(answerOf<ReadSafetyHoldOfOutcomeResponse>(hold, "safetyHoldOfOutcome").hold).toBeNull();
    },
  );
});

describe("one business's rows, never another's, and with no business only rows with none (defaults 25, 56, 57)", () => {
  it(
    "each record read under each side sees only its own side's row: the barbershop's, the yoga studio's or the one with no business; run by the tables' owner, whom row-level security does not bind, the same (the reads' own filters)",
    SLOW,
    async () => {
      await given("read-safety-outcome-of-event-alex.json");
      await addRowsElsewhere();
      for (const scope of SCOPES) {
        for (const home of HOMES) {
          for (const [call, request] of recordRequests(home, scope)) {
            const label = `${call} of ${home.outcomeId}, under ${scope ?? "no business"}`;
            const seen = home.businessId === scope ? idOf(call, home) : null;
            const outcome = await OWN[call](clientFor(call, scope), request as never);
            expect(outcomeErrors(call, outcome), label).toEqual([]);
            expect(foundOf(call, outcome), label).toBe(seen);
            expect(foundOf(call, await asTablesOwner(call, request, scope)), `${label}, by the owner`).toBe(
              seen,
            );
          }
        }
      }
    },
  );

  it(
    "the yoga studio's rows under its own scope, and the rows with no business on the runtime side, come back whole in the port's shapes",
    SLOW,
    async () => {
      await given("read-safety-outcome-of-event-alex.json");
      await addRowsElsewhere();
      const answers: [Call, unknown][] = [];
      for (const [home, outcome, hold] of [
        [YOGA_HOME, YOGA_OUTCOME, YOGA_HOLD],
        [NO_BUSINESS_HOME, NO_BUSINESS_OUTCOME, NO_BUSINESS_HOLD],
      ] as const) {
        const sql = home.businessId === null ? job : app;
        const { businessId } = home;
        const ofEvent = await readSafetyOutcomeOfEvent(sql, { eventId: home.eventId, businessId });
        const byId = await readSafetyOutcome(sql, { outcomeId: home.outcomeId, businessId });
        const holdById = await readSafetyHold(sql, { holdId: home.holdId, businessId });
        const holdOfOutcome = await readSafetyHoldOfOutcome(sql, { outcomeId: home.outcomeId, businessId });
        const written = await readOutboxRowWritten(sql, { outboxRowId: home.outboxRowId, businessId });
        expect(
          answerOf<ReadSafetyOutcomeOfEventResponse>(ofEvent, "safetyOutcomeOfEvent").safetyOutcome,
        ).toEqual(outcome);
        expect(answerOf<ReadSafetyOutcomeResponse>(byId, "safetyOutcome").safetyOutcome).toEqual(outcome);
        expect(answerOf<ReadSafetyHoldResponse>(holdById, "safetyHold").hold).toEqual(hold);
        expect(answerOf<ReadSafetyHoldOfOutcomeResponse>(holdOfOutcome, "safetyHoldOfOutcome").hold).toEqual(
          hold,
        );
        expect(written).toMatchObject({ result: "outboxRowWritten", businessId, written: true });
        answers.push(
          ["readSafetyOutcomeOfEvent", ofEvent],
          ["readSafetyOutcome", byId],
          ["readSafetyHold", holdById],
          ["readSafetyHoldOfOutcome", holdOfOutcome],
          ["readOutboxRowWritten", written],
        );
      }
      for (const [call, answer] of answers) {
        expect(outcomeErrors(call, answer), call).toEqual([]);
      }
    },
  );

  it(
    "with no business on rosie_app, which sees no row without a scope, each record read refuses to run rather than answer none (default 1)",
    SLOW,
    async () => {
      await given("read-safety-outcome-of-event-alex.json");
      await addRowsElsewhere();
      for (const [call, request] of recordRequests(NO_BUSINESS_HOME, null)) {
        await expect(OWN[call](app, request as never), call).rejects.toThrow(BusinessScopeError);
        await expect(
          inRuntimeTransaction(app, { readOnly: true }, (tx) => IN[call](tx, request as never)),
          call,
        ).rejects.toThrow("rosie_app sees no row without a scope");
      }
    },
  );

  it(
    "a business that does not exist is notFound for each of the seven, never null or false (default 56)",
    SLOW,
    async () => {
      await given("read-safety-outcome-of-event-alex.json");
      const nobody = "biz-nobody";
      const requests: [Call, Request][] = [
        ...recordRequests(BARBERSHOP_HOME, nobody),
        ["readBusinessOwner", { businessId: nobody }],
        ["readBusinessZone", { businessId: nobody }],
      ];
      for (const [call, request] of requests) {
        const outcome = await OWN[call](clientFor(call, nobody), request as never);
        expect(outcome, call).toEqual({ error: "notFound", table: "businesses", rowId: nobody });
        expect(outcomeErrors(call, outcome), call).toEqual([]);
      }
    },
  );
});

describe("readBusinessOwner: the one live owner and the handle they write from (item 42, defaults 58 and 59)", () => {
  const BARBERSHOP_OWNER = { businessId: BARBERSHOP };

  it(
    "an owner whose email handle's id sorts before the phone's still gets the line on the phone handle",
    SLOW,
    async () => {
      const exchange = await given("business-owner-phone-first.json");
      await addHandle("handle-a-sam-email", "email", "sam.lee@example.com", "person-sam");
      const [first] = await db.sql<{ id: string }[]>`
        select handles.id from person_handles join handles on handles.id = person_handles.handle_id
        where person_handles.person_id = 'person-sam' order by handles.id collate "C" limit 1
      `;
      expect(first?.id).toBe("handle-a-sam-email");
      const outcome = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(outcome).toEqual(exchange.outcome);
      expect(answerOf<ReadBusinessOwnerResponse>(outcome, "businessOwner").owner?.handleId).toBe(
        "handle-sam",
      );
    },
  );

  it(
    "of several phone handles the lowest id byte by byte; with none, the lowest email handle id",
    SLOW,
    async () => {
      const exchange = await given("business-owner-barbershop.json");
      // 'S' sorts before 's' byte by byte (collate "C"), though not in a natural language's order.
      await addHandle("handle-Sam-work", "phone", "+15555550110", "person-sam");
      const twoPhones = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(twoPhones).toEqual({
        ...exchange.outcome,
        owner: { personId: "person-sam", handleId: "handle-Sam-work" },
      });
      await db.sql`delete from person_handles where person_id = 'person-sam'`;
      await addHandle("handle-sam-mail-2", "email", "sam2@example.com", "person-sam");
      await addHandle("handle-sam-mail-1", "email", "sam1@example.com", "person-sam");
      const emailsOnly = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(emailsOnly).toEqual({
        ...exchange.outcome,
        owner: { personId: "person-sam", handleId: "handle-sam-mail-1" },
      });
      expect(outcomeErrors("readBusinessOwner", emailsOnly)).toEqual([]);
    },
  );

  it(
    "two live owner roles at one business answer moreThanOneOwner and nothing else, never one of them; an ended role no longer counts",
    SLOW,
    async () => {
      const exchange = await given("business-owner-barbershop.json");
      // No seed holds two live owners at one business, so the second role is written here (README v1.4 fixtures).
      await addRole("role-riley-barber-owner", "person-riley", BARBERSHOP, "owner");
      const two = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(two).toEqual({ error: "moreThanOneOwner", businessId: BARBERSHOP });
      expect(outcomeErrors("readBusinessOwner", two)).toEqual([]);
      expect(await asTablesOwner("readBusinessOwner", BARBERSHOP_OWNER, BARBERSHOP)).toEqual(two);
      await endRole("role-sam-barber");
      const riley = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(riley).toEqual({
        ...exchange.outcome,
        owner: { personId: "person-riley", handleId: "handle-riley" },
      });
      await endRole("role-riley-barber-owner");
      expect(await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange))).toEqual({
        ...exchange.outcome,
        owner: null,
      });
    },
  );

  it(
    "an owner who writes from no handle answers owner null, since nothing can reach them",
    SLOW,
    async () => {
      const exchange = await given("business-owner-barbershop.json");
      await db.sql`delete from person_handles where person_id = 'person-sam'`;
      const outcome = await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange));
      expect(outcome).toEqual({ ...exchange.outcome, owner: null });
      expect(outcomeErrors("readBusinessOwner", outcome)).toEqual([]);
    },
  );

  it(
    "another business's owner roles never count: the yoga studio's own owner, then two there, leave the barbershop's answer as it is",
    SLOW,
    async () => {
      const exchange = await given("business-owner-barbershop.json");
      await endRole("role-sam-yoga");
      await addRole("role-maya-yoga-owner", "person-maya", YOGA, "owner");
      const yoga = await readBusinessOwner(job, { businessId: YOGA }, nowOf(exchange));
      expect(yoga).toEqual({
        result: "businessOwner",
        businessId: YOGA,
        readAt: exchange.given.now,
        owner: { personId: "person-maya", handleId: "handle-maya" },
      });
      expect(await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange))).toEqual(exchange.outcome);
      await addRole("role-riley-yoga-owner", "person-riley", YOGA, "owner");
      expect(await readBusinessOwner(job, { businessId: YOGA })).toEqual({
        error: "moreThanOneOwner",
        businessId: YOGA,
      });
      expect(await readBusinessOwner(job, BARBERSHOP_OWNER, nowOf(exchange))).toEqual(exchange.outcome);
      expect(await asTablesOwner("readBusinessOwner", BARBERSHOP_OWNER, BARBERSHOP, nowOf(exchange))).toEqual(
        exchange.outcome,
      );
      await expect(
        withBusiness(job, YOGA, (tx) => readBusinessOwnerIn(tx, BARBERSHOP_OWNER)),
      ).rejects.toThrow(BusinessScopeError);
    },
  );

  it(
    "on rosie_app, which holds no grant on person_handles or handles, the read refuses to run before any read, owner or not (default 1)",
    SLOW,
    async () => {
      for (const file of ["business-owner-barbershop.json", "business-owner-none.json"]) {
        await given(file);
        await expect(readBusinessOwner(app, BARBERSHOP_OWNER), file).rejects.toThrow(
          "readBusinessOwner runs as rosie_job",
        );
        await expect(
          withBusiness(app, BARBERSHOP, (tx) => readBusinessOwnerIn(tx, BARBERSHOP_OWNER)),
          file,
        ).rejects.toThrow(BusinessScopeError);
      }
    },
  );
});

describe("readBusinessZone: the call's own business's zone (item 43)", () => {
  it(
    "each business answers its own zone under its own scope, by the tables' owner too; a request naming another business than the scope is refused",
    SLOW,
    async () => {
      const exchange = await given("business-zone-barbershop.json");
      await db.sql`update businesses set time_zone = 'America/Chicago', version = version + 1 where id = ${YOGA}`;
      expect(await readBusinessZone(app, { businessId: BARBERSHOP }, nowOf(exchange))).toEqual(
        exchange.outcome,
      );
      const yoga = await readBusinessZone(app, { businessId: YOGA }, nowOf(exchange));
      expect(yoga).toEqual({
        result: "businessZone",
        businessId: YOGA,
        readAt: exchange.given.now,
        timeZone: "America/Chicago",
      });
      expect(outcomeErrors("readBusinessZone", yoga)).toEqual([]);
      expect(
        await asTablesOwner("readBusinessZone", { businessId: BARBERSHOP }, BARBERSHOP, nowOf(exchange)),
      ).toEqual(exchange.outcome);
      await expect(
        withBusiness(app, BARBERSHOP, (tx) => readBusinessZoneIn(tx, { businessId: YOGA })),
      ).rejects.toThrow(BusinessScopeError);
    },
  );
});

describe("the side and the request (STATE notes 5 and 22; T-1094's note N2; defaults 1 and 2)", () => {
  /** One request of each call under the barbershop. */
  const UNDER_BARBERSHOP: [Call, Request][] = [
    ...recordRequests(BARBERSHOP_HOME, BARBERSHOP),
    ["readBusinessOwner", { businessId: BARBERSHOP }],
    ["readBusinessZone", { businessId: BARBERSHOP }],
  ];

  it(
    "each In read runs only on its request's side: its own business's scope, or with no business none at all",
    SLOW,
    async () => {
      await given("read-safety-outcome-of-event-alex.json");
      for (const [call, request] of UNDER_BARBERSHOP) {
        const sql = clientFor(call, BARBERSHOP);
        const read = (tx: Db): Promise<unknown> => IN[call](tx, request as never);
        await expect(withBusiness(sql, YOGA, read), call).rejects.toThrow(BusinessScopeError);
        await expect(inRuntimeTransaction(sql, { readOnly: true }, read), call).rejects.toThrow(
          BusinessScopeError,
        );
      }
      for (const [call, request] of recordRequests(NO_BUSINESS_HOME, null)) {
        await expect(
          withBusiness(job, BARBERSHOP, (tx) => IN[call](tx, request as never)),
          call,
        ).rejects.toThrow("with no business runs on the runtime side");
      }
    },
  );

  it("the refused v1.4 requests are refused before any read, as the schema refuses them", SLOW, async () => {
    await reset();
    const noScope = readJson(new URL("invalid/refuse-safety-outcome-no-scope.json", ACCESS_DIR)) as Request;
    const noBusiness = readJson(
      new URL("invalid/refuse-business-owner-no-business.json", ACCESS_DIR),
    ) as Request;
    expect(schemaErrors("readSafetyOutcome.request", noScope)).not.toEqual([]);
    expect(schemaErrors("readBusinessOwner.request", noBusiness)).not.toEqual([]);
    await expect(readSafetyOutcome(app, noScope as never)).rejects.toThrow(
      "readSafetyOutcome: the request needs businessId",
    );
    await expect(readBusinessOwner(job, noBusiness as never)).rejects.toThrow(
      "readBusinessOwner: the request names its business, never null",
    );
    await expect(readBusinessZone(app, { businessId: null } as never)).rejects.toThrow(
      "readBusinessZone: the request names its business, never null",
    );
    const refused: [Call, Request, string][] = [
      ["readSafetyOutcomeOfEvent", { eventId: "evt-alex-0203" }, "the request needs businessId"],
      [
        "readSafetyOutcomeOfEvent",
        { eventId: "evt-alex-0203", businessId: BARBERSHOP, handleId: "handle-alex" },
        "the request takes only eventId, businessId",
      ],
      ["readSafetyHold", { holdId: "", businessId: BARBERSHOP }, "holdId is a non-empty id"],
      ["readSafetyHoldOfOutcome", { outcomeId: 7, businessId: BARBERSHOP }, "outcomeId is a non-empty id"],
      [
        "readOutboxRowWritten",
        { outboxRowId: "out-alex-barber-1", businessId: "" },
        "businessId is a non-empty id",
      ],
      [
        "readSafetyOutcome",
        { outcomeId: "safety-alex-0203", businessId: " " },
        "a business scope needs a non-empty business id",
      ],
      ["readBusinessZone", { businessId: BARBERSHOP, zone: "UTC" }, "the request takes only businessId"],
      ["readBusinessOwner", {}, "readBusinessOwner: the request needs businessId"],
    ];
    for (const [call, request, message] of refused) {
      await expect(OWN[call](clientFor(call, BARBERSHOP), request as never), message).rejects.toThrow(
        message,
      );
    }
    sent.length = 0;
    await expect(readSafetyOutcome(app, noScope as never)).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("with no clock given, readAt is the database's now, in UTC", SLOW, async () => {
    const exchange = await given("business-zone-barbershop.json");
    const before = Date.now();
    const zone = answerOf<{ result: "businessZone"; readAt: string }>(
      await readBusinessZone(app, exchange.request as never),
      "businessZone",
    );
    expect(Math.abs(Date.parse(zone.readAt) - before)).toBeLessThan(60_000);
    expect(zone.readAt.endsWith("Z")).toBe(true);
  });
});

describe("sealed values: never selected, never answered, never logged (item 37; README T-1161; DL-345)", () => {
  /** Never named by a statement of the seven reads: sealed and personal columns, the message's words, key columns. */
  const NEVER_NAMED = new Set([
    "sealed_words",
    "tries",
    "danger_word_lists",
    "plan",
    "final_parts",
    "address",
    "number",
    "words",
    "sealed_values",
    "sealed_details",
    "sealing_keys",
    "wrapped_key",
    "wrapping_key_name",
  ]);
  /** Functions that turn a whole row into a value. */
  const WHOLE_ROW_FUNCTIONS = new Set([
    "to_json",
    "to_jsonb",
    "row_to_json",
    "json_agg",
    "jsonb_agg",
    "json_object_agg",
    "jsonb_object_agg",
    "array_agg",
    "jsonb_populate_record",
    "hstore",
    "row",
  ]);
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
    "fetch",
    "for",
    "union",
    "except",
    "intersect",
    "window",
    "returning",
    "tablesample",
  ]);
  /** What no answer may hold: numbers, email addresses, K-34's sealed stand-in, a row's words, a key's name. */
  const NEVER_ANSWERED = ["+1555", "@example.com", SEALED_TEXT, SEALED_HEX, "Words of", "SEALING_WRAP_KEY"];

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

  /** The tables and aliases a statement declares after FROM and JOIN, and the places it declares them. */
  function declarationsOf(tokens: readonly string[]): { names: Set<string>; places: Set<number> } {
    const names = new Set<string>();
    const places = new Set<number>();
    tokens.forEach((token, index) => {
      // `is [not] distinct from x` compares; a function after FROM is no table.
      if ((token !== "from" && token !== "join") || tokens[index - 1] === "distinct") {
        return;
      }
      const table = tokens[index + 1];
      if (!isName(table) || tokens[index + 2] === "(") {
        return;
      }
      names.add(table);
      places.add(index + 1);
      const aliasAt = tokens[index + 2] === "as" ? index + 3 : index + 2;
      const alias = tokens[aliasAt];
      if (isName(alias) && !NOT_AN_ALIAS.has(alias)) {
        names.add(alias);
        places.add(aliasAt);
      }
    });
    return { names, places };
  }

  /** Every table of this file's schema a statement names, wherever it names it. */
  const tablesOf = (statement: string): string[] =>
    tokensOf(statement).filter((token) => schemaTables.has(token));

  /** Every column of `call`'s own tables a statement names, wherever it names it. */
  const columnsOf = (statement: string, call: Call): string[] =>
    tokensOf(statement).filter((token) =>
      TABLES_OF[call].some((table) => schemaColumns.get(table)?.has(token) === true),
    );

  /**
   * What is wrong with one statement of `call`: a column never read, `*`, a whole row (a function that takes one, or a
   * table or alias not followed by one of its columns), a table beyond the read's own, or a column of its tables
   * beyond its column list.
   */
  function problemsOf(statement: string, call: Call): string[] {
    const tables = new Set(TABLES_OF[call]);
    const columns = new Set(COLUMNS_OF[call]);
    const tokens = tokensOf(statement);
    const { names, places } = declarationsOf(tokens);
    const problems: string[] = [];
    tokens.forEach((token, index) => {
      const next = tokens[index + 1];
      if (NEVER_NAMED.has(token)) {
        problems.push(`a column never read: ${token}`);
      }
      if (token === "*") {
        problems.push("*");
      }
      if (WHOLE_ROW_FUNCTIONS.has(token) && next === "(") {
        problems.push(`a whole row: ${token}()`);
      }
      if ((names.has(token) || schemaTables.has(token)) && !places.has(index) && next !== ".") {
        problems.push(`a whole row: ${token}`);
      }
      if (schemaTables.has(token) && !tables.has(token)) {
        problems.push(`a table beyond its own: ${token}`);
      }
    });
    for (const column of columnsOf(statement, call)) {
      if (!columns.has(column)) {
        problems.push(`a column beyond its own: ${column}`);
      }
    }
    return problems;
  }

  /** Runs `read` with every console method watched; answers the outcome and how many times anything was logged. */
  async function unlogged<T>(read: () => Promise<T>): Promise<{ outcome: T; logged: number }> {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "trace").mockImplementation(() => undefined),
    ];
    try {
      const outcome = await read();
      return { outcome, logged: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  }

  it("the check refuses a whole row, a stray table or column and each sealed column (shown on statements made to fail)", () => {
    const caught: [string, Call, string][] = [
      [
        "select to_jsonb(p) from person_roles p where p.business_id = $1",
        "readBusinessOwner",
        "a whole row: to_jsonb()",
      ],
      [
        "select to_jsonb(p) from person_roles p where p.business_id = $1",
        "readBusinessOwner",
        "a whole row: p",
      ],
      [
        "select row_to_json(o) from safety_outcomes o where o.id = $1",
        "readSafetyOutcome",
        "a whole row: row_to_json()",
      ],
      ["select h from handles h where h.id = $1", "readBusinessOwner", "a whole row: h"],
      ["select (h).kind from handles as h", "readBusinessOwner", "a whole row: h"],
      ["select handles from handles where handles.id = $1", "readBusinessOwner", "a whole row: handles"],
      ["select json_agg(o) from safety_outcomes o", "readSafetyOutcome", "a whole row: json_agg()"],
      ["select o.* from safety_outcomes o where o.id = $1", "readSafetyOutcome", "*"],
      [
        "select id from safety_outcomes where id = $1 and exists (select 1 from messages where messages.id = $2)",
        "readSafetyOutcome",
        "a table beyond its own: messages",
      ],
      [
        "select safety_outcomes.id from safety_outcomes join phones on true",
        "readSafetyOutcome",
        "a table beyond its own: phones",
      ],
      [
        "select id, sealed_words from safety_outcomes where id = $1",
        "readSafetyOutcome",
        "a column never read: sealed_words",
      ],
      [
        "select id, sealed_words from safety_outcomes where id = $1",
        "readSafetyOutcome",
        "a column beyond its own: sealed_words",
      ],
      [
        "select id, tries, danger_word_lists from safety_outcomes",
        "readSafetyOutcomeOfEvent",
        "a column never read: tries",
      ],
      [
        "select id, plan, final_parts from outbox_rows where id = $1",
        "readOutboxRowWritten",
        "a column never read: final_parts",
      ],
      [
        "select id, state, version from outbox_rows where id = $1",
        "readOutboxRowWritten",
        "a column beyond its own: state",
      ],
      ["select id, kind, address from handles", "readBusinessOwner", "a column never read: address"],
      [
        "select id, name, time_zone from businesses where id = $1",
        "readBusinessZone",
        "a column beyond its own: name",
      ],
      [
        "select e.sealed_values from event_log e",
        "readSafetyOutcomeOfEvent",
        "a column never read: sealed_values",
      ],
      [
        "select e.sealed_values from event_log e",
        "readSafetyOutcomeOfEvent",
        "a table beyond its own: event_log",
      ],
      [
        'select "r"."sealed_details" from "harm_reports" "r"',
        "readSafetyHold",
        "a column never read: sealed_details",
      ],
    ];
    for (const [statement, call, problem] of caught) {
      expect(problemsOf(statement, call), statement).toContain(problem);
    }
    // Statements shaped as the reads' own pass, a collation and a literal among them.
    const clean: [string, Call][] = [
      [
        'select handles.id, handles.kind from person_handles join handles on handles.id = person_handles.handle_id where person_handles.person_id = $1 order by handles.id collate "C"',
        "readBusinessOwner",
      ],
      [
        "select id, person_id from person_roles where business_id = $1 and role = 'owner' and ended_at is null",
        "readBusinessOwner",
      ],
      ["select id from outbox_rows where id = $1 and business_id is null", "readOutboxRowWritten"],
      ["select time_zone from businesses where id = $1", "readBusinessZone"],
    ];
    for (const [statement, call] of clean) {
      expect(problemsOf(statement, call), statement).toEqual([]);
    }
  });

  it(
    "every statement the seven reads send, over every fixture, both other sides and the owner's cases, names only its read's tables and columns, no sealed column, no * and no whole row, and names the business; nothing is logged; no answer holds a sealed value",
    SLOW,
    async () => {
      const runs: { call: Call; businessId: string | null; statements: string[]; outcome: unknown }[] = [];
      let logged = 0;
      const watch = async (
        call: Call,
        businessId: string | null,
        read: () => Promise<unknown>,
      ): Promise<void> => {
        sent.length = 0;
        const run = await unlogged(read);
        runs.push({ call, businessId, statements: [...sent], outcome: run.outcome });
        logged += run.logged;
      };
      for (const file of READ_FIXTURES) {
        const exchange = await given(file);
        await watch(exchange.call as Call, businessOf(exchange.request), () => runRead(exchange));
      }
      await given("read-safety-outcome-of-event-alex.json");
      await addRowsElsewhere();
      for (const scope of SCOPES) {
        for (const home of HOMES) {
          for (const [call, request] of recordRequests(home, scope)) {
            await watch(call, scope, () => OWN[call](clientFor(call, scope), request as never));
          }
        }
      }
      await addHandle("handle-a-sam-email", "email", "sam.lee@example.com", "person-sam");
      await addHandle("handle-Sam-work", "phone", "+15555550110", "person-sam");
      await watch("readBusinessOwner", BARBERSHOP, () => readBusinessOwner(job, { businessId: BARBERSHOP }));
      await addRole("role-riley-barber-owner", "person-riley", BARBERSHOP, "owner");
      await watch("readBusinessOwner", BARBERSHOP, () => readBusinessOwner(job, { businessId: BARBERSHOP }));
      await watch("readBusinessOwner", YOGA, () => readBusinessOwner(job, { businessId: YOGA }));
      await watch("readBusinessZone", YOGA, () => readBusinessZone(app, { businessId: YOGA }));

      // The record was read: each read named its own tables and columns, all of them and no other.
      for (const call of CALLS) {
        const statements = runs.filter((run) => run.call === call).flatMap((run) => run.statements);
        const tables = new Set(statements.flatMap(tablesOf));
        expect([...tables].sort(), call).toEqual([...TABLES_OF[call]].sort());
        const columns = new Set(statements.flatMap((statement) => columnsOf(statement, call)));
        expect([...columns].sort(), call).toEqual([...COLUMNS_OF[call]].sort());
      }
      for (const run of runs) {
        for (const statement of run.statements) {
          expect(problemsOf(statement, run.call), `${run.call}: ${statement}`).toEqual([]);
          // Every read of a business-scoped table names the business (README line 190), by its row's column or id.
          if (/\b(safety_outcomes|safety_holds|outbox_rows|person_roles)\b/.test(statement)) {
            expect(statement, run.call).toMatch(/\bbusiness_id (is null|= \$\d+)/);
          }
          if (/\bfrom businesses\b/.test(statement)) {
            expect(statement, run.call).toMatch(/\bwhere id = \$\d+/);
          }
        }
        // With no business the read itself names `business_id is null` (item 37), else the business.
        if (TABLES_OF[run.call].length === 2 && TABLES_OF[run.call].includes("businesses")) {
          const filter = run.businessId === null ? "business_id is null" : "business_id = $";
          expect(
            run.statements.some((statement) => statement.includes(filter)),
            `${run.call} under ${run.businessId ?? "no business"}`,
          ).toBe(true);
        }
        const text = JSON.stringify(run.outcome);
        for (const value of NEVER_ANSWERED) {
          expect(text.includes(value), `${run.call}: ${value}`).toBe(false);
        }
      }
      expect(logged).toBe(0);
      expect(runs).toHaveLength(READ_FIXTURES.length + SCOPES.length * HOMES.length * 5 + 4);
    },
  );

  it("an error names a call, a field or a rule, never a value or an id", SLOW, async () => {
    await given("read-safety-outcome-of-event-alex.json");
    const words = "Haircut at Lee's Barbershop this Saturday?";
    const refused: [() => Promise<unknown>, string][] = [
      [
        () =>
          readSafetyOutcomeOfEvent(app, {
            eventId: "+15555550101",
            businessId: BARBERSHOP,
            to: "alex@example.com",
          } as never),
        "the request takes only eventId, businessId",
      ],
      [() => readSafetyOutcome(app, { outcomeId: words } as never), "the request needs businessId"],
      [() => readSafetyHold(app, { holdId: "", businessId: words }), "holdId is a non-empty id"],
      [
        () => readSafetyHoldOfOutcome(app, { outcomeId: words, businessId: words.repeat(5) }),
        "a business scope needs a non-empty business id",
      ],
      [
        () => readOutboxRowWritten(app, { outboxRowId: words, businessId: 7 } as never),
        "businessId is a non-empty id",
      ],
      [
        () => readBusinessZone(app, { businessId: "+15555550101", words } as never),
        "the request takes only businessId",
      ],
    ];
    for (const [read, message] of refused) {
      const error = await read().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, message).toBeInstanceOf(TypeError);
      const text = (error as Error).message;
      expect(text).toContain(message);
      for (const value of ["+1555", "alex@example.com", words, "7"]) {
        expect(text.includes(value), value).toBe(false);
      }
    }
    const misplaced: (() => Promise<unknown>)[] = [
      () =>
        withBusiness(app, YOGA, (tx) =>
          readSafetyOutcomeOfEventIn(tx, { eventId: "evt-alex-0203", businessId: BARBERSHOP }),
        ),
      () => readSafetyHold(app, { holdId: "hold-alex-0203", businessId: null }),
      () => readBusinessOwner(app, { businessId: BARBERSHOP }),
      () =>
        withBusiness(job, BARBERSHOP, (tx) =>
          readOutboxRowWrittenIn(tx, { outboxRowId: "out-alex-barber-1", businessId: null }),
        ),
    ];
    for (const read of misplaced) {
      const error = await read().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BusinessScopeError);
      const text = (error as Error).message;
      for (const value of [BARBERSHOP, YOGA, "evt-alex", "hold-alex", "out-alex", "handle-", "person-"]) {
        expect(text.includes(value), value).toBe(false);
      }
    }
  });
});
