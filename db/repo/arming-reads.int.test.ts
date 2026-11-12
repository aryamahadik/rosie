// T-1258: K-05 v1.10's readQuestionFacts and readHandle (items 49 and 50) against local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/repo/arming-reads`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// Both reads run as K-05 v1.10 names them (items 49 and 50; README "The calls v1.10 adds"): through a client whose
// connections run as rosie_job, the runtime side's role, with no business scope, so the grants and row-level security
// are the ones the reads meet; the role is the connection's. The tables' owner (the migrations' role) loads the K-04
// seeds a fixture's `given` names and writes the rows a test adds (among them the never-delivered rows default 92 orders,
// which no seed or commit holds yet); the commits a fixture's `after` chain names run for real through db/repo's
// commitTurn as rosie_job. Every answer is checked against its data-access v1.10 definition with Ajv 2020-12, strict, as
// contracts:check runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its
// parameters, kept in memory for the checks and never printed), so the checks read what the two reads sent, not a copy
// of their SQL: their tables and columns, no visit's address, no message's words and no column of sealing_keys, the
// question's own business named beside each key, and one read-only transaction per read.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readHandle,
  type ReadHandleRequest,
  readQuestionFacts,
  type ReadQuestionFactsRequest,
  type ReadQuestionFactsResponse,
} from "./arming-reads";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import { BusinessScopeError, type Sql, type Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { BrokenRecordError } from "./turn-face-reads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const JOB_ROLE = "rosie_job";
const APP_ROLE = "rosie_app";
const SLOW = { timeout: 60_000 };

const BARBERSHOP = "biz-lees-barbershop";
const YOGA = "biz-yoga-studio";
const MOVERS = "biz-movers";
/** A business this file adds, in another zone than the seeds' three, so a zone is seen to be the question's own. */
const WEST = "biz-t1258-west";
const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";
const S1_02 = "oq-s1-02-sam-1";
const A7_03 = "oq-a7-03-alex";
const HAIRCUT = "booking-alex-haircut";
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
/** The read-back and options the added questions carry: words no answer and no statement may hold. */
const READBACK = "Move your haircut to Sat 2:00pm with Riley?";
const OPTION_LABELS = ["Sat 12:00pm", "Sat 2:00pm", "Sat 3:30pm"];

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

interface SeedFile {
  after: string[];
  rows: { table: string; values: Row }[];
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const CALLS = ["readQuestionFacts", "readHandle"] as const;
type Call = (typeof CALLS)[number];

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const isCallDef = (def: string | undefined, part: string): boolean =>
  CALLS.some((call) => def === `${call}.${part}`);
/** Items 49's and 50's accepted exchanges, as the index lists them. */
const READ_FIXTURES = INDEX.filter(
  (entry) => entry.expect === "accept" && isCallDef(entry.def, "exchange"),
).map((entry) => entry.file);
/** Their refused twins, each refused by its exchange or its response. */
const REFUSED_FIXTURES = INDEX.filter(
  (entry) =>
    entry.expect === "refuse" && (isCallDef(entry.def, "exchange") || isCallDef(entry.def, "response")),
);
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
const V110_ID = (readJson(new URL("data-access/data-access.v1.10.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.10, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V110_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.10 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** A read's answer checked against its own definition: an error against <call>.errors, else <call>.response. */
function answerErrors(call: Call, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(`${call}.${isError ? "errors" : "response"}`, outcome);
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
  db = await createTestDatabase({ name: "arming_reads" });
  job = roleClient(JOB_ROLE, "rosie-t1258-job", 5, true);
  app = roleClient(APP_ROLE, "rosie-t1258-app", 2, false);
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

/** A K-04 seed file's rows after those of its `after` chain, each file once. */
function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
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

/** Loads a fixture's seeds and runs its chain's commits for real (commitTurn, T-195, as rosie_job). */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  const seen = new Set<string>();
  const rows = chain.seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
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

/** The read an exchange names, on the rosie_job client. */
function readOf(call: Call, request: Row, sql: Sql = job): Promise<unknown> {
  return call === "readQuestionFacts"
    ? readQuestionFacts(sql, request as unknown as ReadQuestionFactsRequest)
    : readHandle(sql, request as unknown as ReadHandleRequest);
}

const callOf = (exchange: Exchange): Call => {
  const call = CALLS.find((name) => name === exchange.call);
  if (call === undefined) {
    throw new Error(`items 49 and 50 have no call ${exchange.call}`);
  }
  return call;
};

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

// ---- the rows this file adds beside A7-03's (read-question-facts-a7-03.json's chain) ---------------------------------

const HELD_UNTIL = "2026-10-23T14:15:00Z";

/** A reservation of a barbershop worker, as the owner writes it. */
function workerReservation(id: string, worker: "riley" | "avery", during: string, rest: Row): Row {
  return {
    id,
    business_id: BARBERSHOP,
    resource_id: `res-${worker}`,
    resource_kind: "worker",
    worker_person_id: `person-${worker}`,
    during,
    ...rest,
  };
}

/** The haircut's rows beside its one booked 15:00 seed row (rsv-alex-haircut, Riley). */
const HAIRCUT_ROWS: readonly Row[] = [
  // Held, later than the booked row: the booked one is the earlier, so its start is given.
  workerReservation("rsv-t1258-held-later", "avery", "[2026-10-24T16:00:00Z,2026-10-24T16:30:00Z)", {
    state: "held",
    held_until: HELD_UNTIL,
    booking_id: HAIRCUT,
  }),
  // Released and waiting, earlier than both: neither holds the visit's time (default 90), so neither is read.
  workerReservation("rsv-t1258-released-earlier", "riley", "[2026-10-24T13:00:00Z,2026-10-24T13:30:00Z)", {
    state: "released",
    released_at: "2026-10-22T10:00:00Z",
    released_why: "let_go",
    booking_id: HAIRCUT,
  }),
  workerReservation("rsv-t1258-waiting-earlier", "riley", "[2026-10-24T12:00:00Z,2026-10-24T12:30:00Z)", {
    state: "waiting",
    queued_at: "2026-10-22T09:00:00Z",
    booking_id: HAIRCUT,
  }),
  // Another business's booked row that names the haircut (a broken record), earliest of all: never read.
  {
    id: "rsv-t1258-other-business",
    business_id: MOVERS,
    resource_id: "res-truck-20",
    resource_kind: "vehicle",
    worker_person_id: null,
    during: "[2026-10-24T11:00:00Z,2026-10-24T12:00:00Z)",
    state: "booked",
    booking_id: HAIRCUT,
  },
];

/** Held, earlier than every held or booked row of the haircut: once added, its start is the visit's. */
const HELD_EARLIER: Row = workerReservation(
  "rsv-t1258-held-earlier",
  "avery",
  "[2026-10-24T14:00:00Z,2026-10-24T14:30:00Z)",
  { state: "held", held_until: HELD_UNTIL, booking_id: HAIRCUT },
);

const BOOKINGS: readonly Row[] = [
  // Every reservation released: no time, so no visit.
  {
    id: "booking-t1258-released",
    business_id: BARBERSHOP,
    flow: "A",
    stage: "cancelled",
    booker_person_id: "person-alex",
  },
  // No reservation at all: no time either.
  {
    id: "booking-t1258-no-time",
    business_id: BARBERSHOP,
    flow: "A",
    stage: "entry",
    booker_person_id: "person-alex",
  },
  // Flow B, as stored: the business goes to the customer.
  {
    id: "booking-t1258-flow-b",
    business_id: BARBERSHOP,
    flow: "B",
    stage: "booked",
    booker_person_id: "person-alex",
  },
];

const OTHER_RESERVATIONS: readonly Row[] = [
  workerReservation("rsv-t1258-all-released-1", "riley", "[2026-10-25T15:00:00Z,2026-10-25T15:30:00Z)", {
    state: "released",
    released_at: "2026-10-22T11:00:00Z",
    released_why: "cancelled",
    booking_id: "booking-t1258-released",
  }),
  workerReservation("rsv-t1258-all-released-2", "avery", "[2026-10-25T15:00:00Z,2026-10-25T15:30:00Z)", {
    state: "released",
    held_until: "2026-10-22T11:10:00Z",
    released_at: "2026-10-22T11:10:00Z",
    released_why: "expired",
    booking_id: "booking-t1258-released",
  }),
  workerReservation("rsv-t1258-flow-b", "riley", "[2026-10-26T15:00:00Z,2026-10-26T16:00:00Z)", {
    state: "booked",
    booking_id: "booking-t1258-flow-b",
  }),
];

/** An open question of Alex's from A7-03's turn, with a read-back, options and versions read that no answer holds. */
function question(
  id: string,
  businessId: string | null,
  bookingId: string | null,
  clock: string | null,
): Row {
  return {
    id,
    turn_id: "turn-alex-move-1",
    handle_id: "handle-alex",
    person_id: "person-alex",
    business_id: businessId,
    booking_id: bookingId,
    step: "A7-03",
    options: OPTION_LABELS.map((label, index) => ({ id: `A7-03/${String(index + 1)}`, label })),
    readback: READBACK,
    versions_read: [{ table: "bookings", rowId: HAIRCUT, version: 7 }],
    bundle_hash: BUNDLE_HASH,
    bundle_build: 1,
    clock,
    status: "open",
  };
}

const QUESTIONS: readonly Row[] = [
  question("oq-t1258-released", BARBERSHOP, "booking-t1258-released", "2 h"),
  question("oq-t1258-no-time", BARBERSHOP, "booking-t1258-no-time", null),
  question("oq-t1258-flow-b", BARBERSHOP, "booking-t1258-flow-b", "24 h"),
  question("oq-t1258-west", WEST, null, "1 h"),
  // A sign-up's question, before there is a business: none of businesses, bookings and reservations is read.
  question("oq-t1258-no-business", null, null, "24 h"),
  // Broken records (default 1): a booking of another business, and a booking with no business on the question.
  question("oq-t1258-booking-elsewhere", BARBERSHOP, "booking-alex-workshop", "24 h"),
  question("oq-t1258-no-business-booking", null, HAIRCUT, "24 h"),
];

type ClockState = "waiting" | "armed" | "fired" | "cancelled";

/** A never-delivered clock row of a question, in `state`, at `version` (written once, as the owner). */
function neverDelivered(
  id: string,
  questionId: string,
  businessId: string | null,
  state: ClockState,
  version: number,
): Row {
  const row: Row = {
    id,
    kind: "never_delivered",
    open_question_id: questionId,
    handle_id: "handle-alex",
    business_id: businessId,
    state,
    fires: { step: "A7-03" },
    version,
  };
  if (state === "armed" || state === "fired") {
    Object.assign(row, {
      due_at: "2026-10-24T14:05:04Z",
      due_zone: NEW_YORK,
      armed_at: "2026-10-23T14:05:04Z",
    });
  }
  if (state === "fired") {
    row.fired_at = "2026-10-24T14:05:04Z";
  }
  if (state === "cancelled") {
    row.cancelled_at = "2026-10-23T14:06:00Z";
  }
  return row;
}

const NEVER_DELIVERED_ROWS: readonly Row[] = [
  // A7-03: two live rows and a cancelled one. The live one with the lowest id, compared byte by byte (default 92):
  // nd-t1258-a7-10 before nd-t1258-a7-2, never parsed as numbers; the cancelled nd-t1258-a7-1 is lower still but not live.
  neverDelivered("nd-t1258-a7-1", A7_03, BARBERSHOP, "cancelled", 2),
  neverDelivered("nd-t1258-a7-10", A7_03, BARBERSHOP, "armed", 3),
  neverDelivered("nd-t1258-a7-2", A7_03, BARBERSHOP, "waiting", 1),
  // Another business's live row on A7-03, the lowest id of all (a broken record): never read.
  neverDelivered("nd-t1258-a7-0", A7_03, MOVERS, "waiting", 1),
  // A fired row alone: still given (default 92).
  neverDelivered("nd-t1258-no-time-1", "oq-t1258-no-time", BARBERSHOP, "fired", 4),
  // No live row: the lowest id, cancelled before fired.
  neverDelivered("nd-t1258-flow-b-b", "oq-t1258-flow-b", BARBERSHOP, "fired", 3),
  neverDelivered("nd-t1258-flow-b-a", "oq-t1258-flow-b", BARBERSHOP, "cancelled", 2),
  // A question with no business: its row with none, never another business's.
  neverDelivered("nd-t1258-no-business-1", "oq-t1258-no-business", null, "waiting", 1),
  neverDelivered("nd-t1258-no-business-0", "oq-t1258-no-business", BARBERSHOP, "waiting", 1),
];

/** A7-03's chain, then every row above but HELD_EARLIER. */
async function givenArmingRows(): Promise<void> {
  await given("read-question-facts-a7-03.json");
  await db.sql.begin(async (tx) => {
    await insertRow(tx, "businesses", {
      id: WEST,
      name: "West barbers",
      display_name: "West barbers",
      time_zone: LOS_ANGELES,
    });
    for (const row of BOOKINGS) {
      await insertRow(tx, "bookings", row);
    }
    for (const row of [...HAIRCUT_ROWS, ...OTHER_RESERVATIONS]) {
      await insertRow(tx, "reservations", row);
    }
    for (const row of QUESTIONS) {
      await insertRow(tx, "open_questions", row);
    }
    for (const row of NEVER_DELIVERED_ROWS) {
      await insertRow(tx, "clock_rows", row);
    }
  });
}

/** The answers once givenArmingRows has run (HELD_EARLIER not yet added). */
const FACTS: Readonly<Record<string, ReadQuestionFactsResponse>> = {
  [A7_03]: {
    openQuestionId: A7_03,
    clockLine: "24 h",
    businessZone: NEW_YORK,
    visit: { flow: "A", startsAt: "2026-10-24T15:00:00Z" },
    neverDelivered: { clockRowId: "nd-t1258-a7-10", version: 3 },
  },
  "oq-t1258-released": {
    openQuestionId: "oq-t1258-released",
    clockLine: "2 h",
    businessZone: NEW_YORK,
    visit: null,
    neverDelivered: null,
  },
  "oq-t1258-no-time": {
    openQuestionId: "oq-t1258-no-time",
    clockLine: null,
    businessZone: NEW_YORK,
    visit: null,
    neverDelivered: { clockRowId: "nd-t1258-no-time-1", version: 4 },
  },
  "oq-t1258-flow-b": {
    openQuestionId: "oq-t1258-flow-b",
    clockLine: "24 h",
    businessZone: NEW_YORK,
    visit: { flow: "B", startsAt: "2026-10-26T15:00:00Z" },
    neverDelivered: { clockRowId: "nd-t1258-flow-b-a", version: 2 },
  },
  "oq-t1258-west": {
    openQuestionId: "oq-t1258-west",
    clockLine: "1 h",
    businessZone: LOS_ANGELES,
    visit: null,
    neverDelivered: null,
  },
  "oq-t1258-no-business": {
    openQuestionId: "oq-t1258-no-business",
    clockLine: "24 h",
    businessZone: null,
    visit: null,
    neverDelivered: { clockRowId: "nd-t1258-no-business-1", version: 1 },
  },
};

/** The two broken records' questions (default 1): each read throws BrokenRecordError and answers nothing. */
const BROKEN: Readonly<Record<string, string>> = {
  "oq-t1258-booking-elsewhere":
    "readQuestionFacts: the question's booking is not under the question's business",
  "oq-t1258-no-business-booking": "readQuestionFacts: a question with no business names a booking",
};

/** Each question's own business (null: none), for the statement checks; an unknown question names none. */
const BUSINESS_OF: Readonly<Record<string, string | null>> = {
  [S1_02]: BARBERSHOP,
  [A7_03]: BARBERSHOP,
  "oq-t1258-released": BARBERSHOP,
  "oq-t1258-no-time": BARBERSHOP,
  "oq-t1258-flow-b": BARBERSHOP,
  "oq-t1258-west": WEST,
  "oq-t1258-no-business": null,
  "oq-t1258-booking-elsewhere": BARBERSHOP,
  "oq-t1258-no-business-booking": null,
};

/** Every question and handle a read is asked about once givenArmingRows has run, unknown ones among them. */
const QUESTION_IDS = [...Object.keys(FACTS), ...Object.keys(BROKEN), "oq-t1258-unknown"];
const HANDLE_IDS = ["handle-sam", "handle-alex", "handle-alex-email", "handle-riley", "handle-t1258-nobody"];

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

/** One read run: its call, the question's own business (undefined for a handle or an unknown question), what it sent. */
interface Run {
  call: Call;
  id: string;
  business: string | null | undefined;
  statements: Sent[];
  outcome: unknown;
  logged: number;
}

/** Runs one read on the rosie_job client, keeping the statements it sent. */
async function watched(call: Call, id: string): Promise<Run> {
  sent.length = 0;
  const request = call === "readQuestionFacts" ? { openQuestionId: id } : { handleId: id };
  const { outcome, logged } = await unlogged(() => readOf(call, request));
  return { call, id, business: BUSINESS_OF[id], statements: [...sent], outcome, logged };
}

/** Every read over givenArmingRows's rows and over S1-02's turn 1, each with what it sent. */
async function everyRun(): Promise<Run[]> {
  const runs: Run[] = [];
  await given("read-question-facts-s1-02.json");
  runs.push(await watched("readQuestionFacts", S1_02), await watched("readHandle", "handle-sam"));
  await givenArmingRows();
  for (const id of QUESTION_IDS) {
    runs.push(await watched("readQuestionFacts", id));
  }
  for (const id of HANDLE_IDS) {
    runs.push(await watched("readHandle", id));
  }
  return runs;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the role the reads run as (K-05 v1.10 items 49 and 50; T-191)", () => {
  it("the two clients run as rosie_job and rosie_app, with this file's schema first and no business scope", async () => {
    for (const [client, role] of [
      [job, JOB_ROLE],
      [app, APP_ROLE],
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

  it(
    "a Tool API client is refused before any answer: readQuestionFacts by its role check (default 3), readHandle by privilege (no grant on handles: 0012)",
    SLOW,
    async () => {
      await given("read-question-facts-s1-02.json");
      const facts = await thrownBy(readQuestionFacts(app, { openQuestionId: S1_02 }));
      expect(facts).toBeInstanceOf(BusinessScopeError);
      expect((facts as Error).message).toBe(
        "readQuestionFacts runs on the runtime side, as rosie_job: rosie_app sees no question without a scope",
      );
      const handle = await thrownBy(readHandle(app, { handleId: "handle-sam" }));
      expect(handle).toBeInstanceOf(DataAccessDatabaseError);
      expect((handle as DataAccessDatabaseError).code).toBe("42501");
      for (const error of [facts, handle]) {
        const text = (error as Error).message;
        for (const value of [S1_02, "handle-sam", "+15555550100", BARBERSHOP]) {
          expect(text.includes(value), value).toBe(false);
        }
      }
    },
  );
});

describe("each v1.10 fixture of items 49 and 50 gives its outcome (K-05 v1.10 items 49 and 50)", () => {
  it("the index lists the two reads' six exchanges, each valid against data-access v1.10, and their three refused twins, each refused", () => {
    expect([...READ_FIXTURES].sort()).toEqual([
      "read-handle-alex-email.json",
      "read-handle-sam.json",
      "read-handle-unknown.json",
      "read-question-facts-a7-03.json",
      "read-question-facts-s1-02.json",
      "read-question-facts-unknown.json",
    ]);
    for (const file of READ_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(schemaErrors(`${exchange.call}.exchange`, exchange), file).toEqual([]);
    }
    expect(REFUSED_FIXTURES.map((entry) => `${entry.file} by ${entry.def ?? ""}`).sort()).toEqual([
      "invalid/refuse-question-facts-caller-business.json by readQuestionFacts.exchange",
      "invalid/refuse-question-facts-visit-address.json by readQuestionFacts.response",
      "invalid/refuse-read-handle-phone-not-e164.json by readHandle.response",
    ]);
    for (const entry of REFUSED_FIXTURES) {
      const value = readJson(new URL(entry.file, ACCESS_DIR));
      expect(schemaErrors(entry.def ?? "", value), entry.file).not.toEqual([]);
    }
  });

  for (const file of READ_FIXTURES) {
    it(
      `${file}: as rosie_job, the read answers the fixture's outcome, valid against its v1.10 definition`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const call = callOf(exchange);
        const outcome = await readOf(call, exchange.request);
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(call, outcome)).toEqual([]);
      },
    );
  }

  it(
    "refuse-question-facts-caller-business: a request naming a business beside the question is refused before any statement; put right, it is S1-02's",
    SLOW,
    async () => {
      const twin = await given("read-question-facts-s1-02.json");
      const refused = readJson(
        new URL("invalid/refuse-question-facts-caller-business.json", ACCESS_DIR),
      ) as Exchange;
      sent.length = 0;
      const error = await thrownBy(readOf("readQuestionFacts", refused.request));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("readQuestionFacts: the request takes only openQuestionId");
      expect(sent).toEqual([]);
      const { businessId, ...putRight } = refused.request;
      expect(businessId).toBe(YOGA);
      expect(putRight).toEqual(twin.request);
      expect(await readOf("readQuestionFacts", putRight)).toEqual(twin.outcome);
    },
  );

  it(
    "refuse-question-facts-visit-address and refuse-read-handle-phone-not-e164: the reads answer their accepted twins, never an address with a visit nor a number in another form",
    SLOW,
    async () => {
      const a703 = await given("read-question-facts-a7-03.json");
      const facts = await readOf("readQuestionFacts", a703.request);
      expect(facts).toEqual(a703.outcome);
      expect(Object.keys((facts as ReadQuestionFactsResponse).visit ?? {}).sort()).toEqual([
        "flow",
        "startsAt",
      ]);
      const sam = await given("read-handle-sam.json");
      const handle = await readOf("readHandle", sam.request);
      expect(handle).toEqual(sam.outcome);
      expect((handle as { handle: { address: string } }).handle.address).toMatch(/^\+[1-9][0-9]{6,14}$/);
    },
  );
});

describe("readQuestionFacts: the question's visit, zone and never-delivered row (item 49; defaults 90 to 92)", () => {
  it(
    "each added question answers its facts, each valid against readQuestionFacts.response",
    SLOW,
    async () => {
      await givenArmingRows();
      for (const [id, facts] of Object.entries(FACTS)) {
        const outcome = await readQuestionFacts(job, { openQuestionId: id });
        expect(outcome, id).toEqual(facts);
        expect(answerErrors("readQuestionFacts", outcome), id).toEqual([]);
      }
    },
  );

  it(
    "a booking whose held or booked reservations start at two times gives the earlier: the booked 15:00 before a held 16:00, then a held 14:00 before the booked 15:00; a released and a waiting row earlier still, and another business's row, are never read (default 90)",
    SLOW,
    async () => {
      await givenArmingRows();
      const before = await readQuestionFacts(job, { openQuestionId: A7_03 });
      expect(before).toEqual(FACTS[A7_03]);
      await insertRow(db.sql, "reservations", HELD_EARLIER);
      const after = await readQuestionFacts(job, { openQuestionId: A7_03 });
      expect(after).toEqual({ ...FACTS[A7_03], visit: { flow: "A", startsAt: "2026-10-24T14:00:00Z" } });
      expect(answerErrors("readQuestionFacts", after)).toEqual([]);
      // Released, the held 14:00 row no longer holds the visit's time: the booked 15:00 is the start again.
      await db.sql`
        update reservations
        set state = 'released', released_at = '2026-10-23T14:20:00Z', released_why = 'expired', version = version + 1
        where id = 'rsv-t1258-held-earlier'
      `;
      expect(await readQuestionFacts(job, { openQuestionId: A7_03 })).toEqual(FACTS[A7_03]);
    },
  );

  it(
    "a booking whose reservations are all released, and one with none, has no time: visit null",
    SLOW,
    async () => {
      await givenArmingRows();
      const states = await db.sql<{ state: string }[]>`
        select state from reservations where booking_id = 'booking-t1258-released' order by id
      `;
      expect(states.map((row) => row.state)).toEqual(["released", "released"]);
      expect(await readQuestionFacts(job, { openQuestionId: "oq-t1258-released" })).toMatchObject({
        visit: null,
      });
      expect(await readQuestionFacts(job, { openQuestionId: "oq-t1258-no-time" })).toMatchObject({
        visit: null,
      });
    },
  );

  it(
    "a question with no business: businessZone and visit null, its own never-delivered row with none, and no statement reads businesses, bookings or reservations",
    SLOW,
    async () => {
      await givenArmingRows();
      const run = await watched("readQuestionFacts", "oq-t1258-no-business");
      expect(run.outcome).toEqual(FACTS["oq-t1258-no-business"]);
      const tables = new Set(run.statements.flatMap((statement) => tablesOf(statement.text)));
      expect([...tables].sort()).toEqual(["clock_rows", "open_questions"]);
    },
  );

  it(
    "the never-delivered row (default 92): of several, the waiting or armed one with the lowest id, ids compared byte by byte; a fired one alone; with none live, the lowest id; never another business's or another kind's",
    SLOW,
    async () => {
      await givenArmingRows();
      const rows = await db.sql<{ id: string; kind: string; state: string }[]>`
        select id, kind, state from clock_rows where open_question_id = ${A7_03} order by id collate "C"
      `;
      expect(rows).toEqual([
        { id: "clock-oq-a7-03-alex", kind: "question", state: "waiting" },
        { id: "nd-t1258-a7-0", kind: "never_delivered", state: "waiting" },
        { id: "nd-t1258-a7-1", kind: "never_delivered", state: "cancelled" },
        { id: "nd-t1258-a7-10", kind: "never_delivered", state: "armed" },
        { id: "nd-t1258-a7-2", kind: "never_delivered", state: "waiting" },
      ]);
      const neverDeliveredOf = async (id: string): Promise<unknown> =>
        ((await readQuestionFacts(job, { openQuestionId: id })) as ReadQuestionFactsResponse).neverDelivered;
      expect(await neverDeliveredOf(A7_03)).toEqual({ clockRowId: "nd-t1258-a7-10", version: 3 });
      expect(await neverDeliveredOf("oq-t1258-no-time")).toEqual({
        clockRowId: "nd-t1258-no-time-1",
        version: 4,
      });
      expect(await neverDeliveredOf("oq-t1258-flow-b")).toEqual({
        clockRowId: "nd-t1258-flow-b-a",
        version: 2,
      });
      expect(await neverDeliveredOf("oq-t1258-no-business")).toEqual({
        clockRowId: "nd-t1258-no-business-1",
        version: 1,
      });
      // Once the armed row fires, the waiting nd-t1258-a7-2 is the one live row left.
      await db.sql`
        update clock_rows set state = 'fired', fired_at = '2026-10-24T14:05:04Z', version = version + 1
        where id = 'nd-t1258-a7-10'
      `;
      expect(await neverDeliveredOf(A7_03)).toEqual({ clockRowId: "nd-t1258-a7-2", version: 1 });
    },
  );

  it(
    "an unknown question answers notFound (table open_questions), with nothing else read",
    SLOW,
    async () => {
      await givenArmingRows();
      const run = await watched("readQuestionFacts", "oq-t1258-unknown");
      expect(run.outcome).toEqual({ error: "notFound", table: "open_questions", rowId: "oq-t1258-unknown" });
      expect(answerErrors("readQuestionFacts", run.outcome)).toEqual([]);
      expect([...new Set(run.statements.flatMap((statement) => tablesOf(statement.text)))]).toEqual([
        "open_questions",
      ]);
    },
  );

  it(
    "a record the answer would have to guess around throws BrokenRecordError, naming no value (default 1): a booking of another business, a booking on a question with no business",
    SLOW,
    async () => {
      await givenArmingRows();
      for (const [id, message] of Object.entries(BROKEN)) {
        const run = await watched("readQuestionFacts", id);
        expect(run.outcome, id).toBeInstanceOf(BrokenRecordError);
        expect((run.outcome as Error).message).toBe(message);
        for (const value of [id, BARBERSHOP, YOGA, HAIRCUT, "booking-alex-workshop"]) {
          expect((run.outcome as Error).message.includes(value), value).toBe(false);
        }
      }
      // With no business, none of businesses, bookings and reservations is read before it throws.
      const noBusiness = await watched("readQuestionFacts", "oq-t1258-no-business-booking");
      expect([...new Set(noBusiness.statements.flatMap((statement) => tablesOf(statement.text)))]).toEqual([
        "open_questions",
      ]);
    },
  );

  it(
    "a request of the wrong shape is refused before any statement, naming the field, never a value",
    SLOW,
    async () => {
      await given("read-question-facts-s1-02.json");
      const refused: [unknown, string][] = [
        [{}, "readQuestionFacts: the request needs openQuestionId"],
        [{ openQuestionId: "" }, "openQuestionId is a non-empty id"],
        [
          { openQuestionId: S1_02, bookingId: HAIRCUT },
          "readQuestionFacts: the request takes only openQuestionId",
        ],
        [null, "readQuestionFacts: the request is an object"],
      ];
      for (const [request, message] of refused) {
        sent.length = 0;
        const error = await thrownBy(readQuestionFacts(job, request as ReadQuestionFactsRequest));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(message);
        expect((error as Error).message.includes(HAIRCUT)).toBe(false);
        expect(sent).toEqual([]);
      }
    },
  );
});

describe("readHandle: a handle's kind and address, by its id (item 50; defaults 93 and 95)", () => {
  it(
    "a known id answers its kind and address as stored, in K-06 v1's handle shape; an unknown id answers handle null",
    SLOW,
    async () => {
      await givenArmingRows();
      const expected: Record<string, unknown> = {
        "handle-sam": { kind: "phone", address: "+15555550100" },
        "handle-alex": { kind: "phone", address: "+15555550101" },
        "handle-alex-email": { kind: "email", address: "alex@example.com" },
        "handle-riley": { kind: "phone", address: "+15555550102" },
        "handle-t1258-nobody": null,
      };
      for (const id of HANDLE_IDS) {
        const outcome = await readHandle(job, { handleId: id });
        expect(outcome, id).toEqual({ handleId: id, handle: expected[id] });
        expect(answerErrors("readHandle", outcome), id).toEqual([]);
      }
    },
  );

  it(
    "the request names a handle id alone: an address, a number or another field is refused before any statement (default 4)",
    SLOW,
    async () => {
      await given("read-handle-sam.json");
      const refused: unknown[] = [
        { handleId: "+15555550100" },
        { handleId: "alex@example.com" },
        { handleId: "5555550100" },
        { handleId: "" },
        { handleId: 7 },
        { handleId: "handle-sam", kind: "phone" },
        {},
      ];
      for (const request of refused) {
        sent.length = 0;
        const error = await thrownBy(readHandle(job, request as ReadHandleRequest));
        expect(error, JSON.stringify(request)).toBeInstanceOf(TypeError);
        const text = (error as Error).message;
        for (const value of ["+1555", "5555550100", "alex@example.com"]) {
          expect(text.includes(value), value).toBe(false);
        }
        expect(sent).toEqual([]);
      }
    },
  );
});

describe("one read-only transaction per read, and nothing written (item 49 and 50: 'writing nothing')", () => {
  it(
    "each read sends its statements on one connection inside one 'begin isolation level repeatable read read only', ending in commit, or rollback when it throws",
    SLOW,
    async () => {
      for (const run of await everyRun()) {
        const label = `${run.call} ${run.id}`;
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
        expect(end, label).toBeGreaterThan(0);
        expect(inside[end]?.text, label).toBe(run.outcome instanceof Error ? "rollback" : "commit");
        for (const statement of run.statements) {
          if (tablesOf(statement.text).length > 0) {
            const at = run.statements.indexOf(statement);
            expect(at, label).toBeGreaterThan(begin);
            expect(at, label).toBeLessThan(begin + 1 + end);
            expect(statement.connection, label).toBe(connection);
          }
        }
      }
    },
  );

  it(
    "a write inside either read's own transaction is refused (25006, thrown scrubbed) and leaves nothing; the same write goes through in a transaction that allows it",
    SLOW,
    async () => {
      await given("read-question-facts-s1-02.json");
      // A probe that writes whenever a row of open_questions or handles is read as rosie_job: a policy's function.
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
        await db.sql.unsafe(
          `create policy t_write_probe on ${schema}.open_questions as restrictive for select to ${JOB_ROLE} ` +
            `using (${probeOf}())`,
        );
        await db.sql.unsafe(`alter table ${schema}.handles enable row level security`);
        await db.sql.unsafe(
          `create policy t_write_probe on ${schema}.handles for select to ${JOB_ROLE} using (${probeOf}())`,
        );
        // In a transaction that may write, the probe writes when either table is read.
        await job.begin(async (tx) => {
          await tx`select clock from open_questions where id = ${S1_02}`;
        });
        expect(await probeRows()).toBeGreaterThan(0);
        await db.sql.unsafe(`truncate ${probe}`);
        await job.begin(async (tx) => {
          await tx`select kind from handles where id = 'handle-sam'`;
        });
        expect(await probeRows()).toBeGreaterThan(0);
        await db.sql.unsafe(`truncate ${probe}`);
        const before = await fingerprint();
        // In each read's own transaction the same write is refused, so the read answers nothing and writes nothing.
        const reads: [Call, () => Promise<unknown>][] = [
          ["readQuestionFacts", () => readQuestionFacts(job, { openQuestionId: S1_02 })],
          ["readHandle", () => readHandle(job, { handleId: "handle-sam" })],
        ];
        for (const [call, read] of reads) {
          const error = await thrownBy(read());
          expect(error, call).toBeInstanceOf(DataAccessDatabaseError);
          expect((error as DataAccessDatabaseError).code, call).toBe("25006");
          expect((error as Error).message, call).toContain(
            `${call}: the database refused the call (SQLSTATE 25006`,
          );
        }
        expect(await probeRows()).toBe(0);
        expect(await fingerprint()).toEqual(before);
      } finally {
        await db.sql.unsafe(`drop policy if exists t_write_probe on ${schema}.handles`);
        await db.sql.unsafe(`alter table ${schema}.handles disable row level security`);
        await db.sql.unsafe(`drop policy if exists t_write_probe on ${schema}.open_questions`);
        await db.sql.unsafe(`drop function if exists ${probeOf}()`);
        await db.sql.unsafe(`drop table if exists ${probe}`);
      }
    },
  );

  it(
    "nothing is written by either read: every table's row count and content are the same before and after every read, the refused and the thrown among them",
    SLOW,
    async () => {
      await givenArmingRows();
      const before = await fingerprint();
      for (const id of QUESTION_IDS) {
        await thrownBy(readQuestionFacts(job, { openQuestionId: id }));
      }
      for (const id of HANDLE_IDS) {
        await thrownBy(readHandle(job, { handleId: id }));
      }
      await thrownBy(readQuestionFacts(app, { openQuestionId: A7_03 }));
      await thrownBy(readHandle(app, { handleId: "handle-alex" }));
      expect(await fingerprint()).toEqual(before);
      // A7-03's question with the seven added, and its question clock row with the nine never-delivered rows.
      expect(before.open_questions).toMatch(/^8 rows, /);
      expect(before.clock_rows).toMatch(/^10 rows, /);
    },
  );
});

// ---- the statements both reads send ------------------------------------------------------------------------------

/** Each read's tables, and no others. */
const TABLES_OF: Readonly<Record<Call, readonly string[]>> = {
  readQuestionFacts: ["bookings", "businesses", "clock_rows", "open_questions", "reservations"],
  readHandle: ["handles"],
};

/**
 * Each read's columns of its own tables, and no other: nothing of a question's options, read-back, versions read,
 * handle, person or status (item 49), and of a handle its kind and address alone, found by its id (item 50).
 */
const COLUMNS_OF: Readonly<Record<Call, readonly string[]>> = {
  readQuestionFacts: [
    "booking_id",
    "business_id",
    "clock",
    "during",
    "flow",
    "id",
    "kind",
    "open_question_id",
    "state",
    "time_zone",
    "version",
  ],
  readHandle: ["address", "id", "kind"],
};

/** readHandle's one statement (item 50: kind and address alone; default 93: no actor name built in SQL). */
const READ_HANDLE_STATEMENT = "select kind, address from handles where id = $1";

/**
 * Never named by a statement of either read (the card's security review): a visit's address and its zone (K-30's
 * booking_addresses, migrated by 0029; default 91), a message's words (messages.words and every other table's words or
 * sealed words) and sealing_keys. The columns of sealing_keys no table of the read has are added per read below; the
 * table itself is never named, so no column of it can be.
 */
const NEVER_NAMED_BASE = [
  "booking_addresses",
  "zone",
  "messages",
  "words",
  "sealed_words",
  "sealed_values",
  "sealed_details",
  "plan",
  "final_parts",
  "sealing_keys",
];

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

/** What no answer of readQuestionFacts may hold: an address or a number, an id of another row, the question's words. */
const NEVER_ANSWERED_FACTS = [
  "+1555",
  "@example.com",
  "biz-",
  "booking-",
  "rsv-",
  "person-",
  "handle-",
  "turn-",
  READBACK,
  ...OPTION_LABELS,
  "SEALING_WRAP_KEY",
];
/** What no answer of readHandle may hold: anything of the handle's people, threads, phone or keys. */
const NEVER_ANSWERED_HANDLE = [
  "person-",
  "biz-",
  "thread-",
  "linq-chat",
  "Sam Lee",
  "Alex M.",
  "SEALING_WRAP_KEY",
];

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
const isName = (token: string | undefined): token is string =>
  token !== undefined && /^[a-z_][a-z0-9_$]*$/.test(token);

/** Every table of this file's schema a statement names, wherever it names it. */
function tablesOf(statement: string): string[] {
  return tokensOf(statement).filter(isTable);
}

/** A table a statement reads after FROM or JOIN, its alias (null with none), and the tokens that declare them. */
interface Declaration {
  table: string;
  alias: string | null;
  places: number[];
}

/** The tables a statement reads, each where FROM or JOIN declares it. */
function declarationsOf(tokens: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  tokens.forEach((token, index) => {
    const table = tokens[index + 1];
    // `is [not] distinct from x` compares; a function or a subquery after FROM or JOIN is no table.
    if ((token !== "from" && token !== "join") || tokens[index - 1] === "distinct") {
      return;
    }
    if (!isName(table) || tokens[index + 2] === "(") {
      return;
    }
    const aliasAt = tokens[index + 2] === "as" ? index + 3 : index + 2;
    const alias = tokens[aliasAt];
    if (isName(alias) && !NOT_AN_ALIAS.has(alias)) {
      declarations.push({ table, alias, places: [index + 1, aliasAt] });
    } else {
      declarations.push({ table, alias: null, places: [index + 1] });
    }
  });
  return declarations;
}

/** The column a business-scoped table names its business by: a business's own id, else its business_id. */
const businessColumnOf = (table: string): string => (table === "businesses" ? "id" : "business_id");

/**
 * Whether a statement names the business of a table it reads after declaring it (item 49: each read after the question
 * names the question's own business beside its key): `alias.column`, or for a table with no alias its bare column or
 * `table.column`. open_questions is read first, by its key alone: it is where the business comes from.
 */
function namesBusiness(tokens: readonly string[], declaration: Declaration): boolean {
  const { table, alias, places } = declaration;
  const column = businessColumnOf(table);
  if (table === "open_questions" || schemaColumns.get(table)?.has(column) !== true) {
    return true;
  }
  const declared = Math.max(...places);
  return tokens.some((token, index) => {
    if (index <= declared || token !== column) {
      return false;
    }
    const owner = tokens[index - 1] === "." ? tokens[index - 2] : null;
    return alias === null ? owner === null || owner === table : owner === alias;
  });
}

/** Never named by `call`'s statements: the base list, sealing_keys' columns no own table has, and for the facts any address. */
function neverNamedOf(call: Call): Set<string> {
  const own = new Set(TABLES_OF[call].flatMap((table) => [...(schemaColumns.get(table) ?? [])]));
  const keyColumns = [...(schemaColumns.get("sealing_keys") ?? [])].filter((column) => !own.has(column));
  return new Set([...NEVER_NAMED_BASE, ...keyColumns, ...(call === "readQuestionFacts" ? ["address"] : [])]);
}

/**
 * What is wrong with one statement of `call`: a name never named, `*`, a whole row (a function that takes one, or a
 * table or alias not followed by one of its columns), a table beyond the read's own, a column of its tables beyond its
 * list, or a business's table read without naming its business.
 */
function problemsOf(statement: string, call: Call): string[] {
  const own = new Set(TABLES_OF[call]);
  const columns = new Set(COLUMNS_OF[call]);
  const neverNamed = neverNamedOf(call);
  const tokens = tokensOf(statement);
  const declarations = declarationsOf(tokens);
  const declared = new Set<string>();
  const places = new Set<number>();
  for (const declaration of declarations) {
    declared.add(declaration.table).add(declaration.alias ?? declaration.table);
    for (const place of declaration.places) {
      places.add(place);
    }
  }
  const problems: string[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (neverNamed.has(token)) {
      problems.push(`never named: ${token}`);
    }
    if (token === "*") {
      problems.push("*");
    }
    if (WHOLE_ROW_FUNCTIONS.has(token) && next === "(") {
      problems.push(`a whole row: ${token}()`);
    }
    if ((declared.has(token) || isTable(token)) && !places.has(index) && next !== ".") {
      problems.push(`a whole row: ${token}`);
    }
    if (isTable(token) && !own.has(token)) {
      problems.push(`a table beyond its own: ${token}`);
    }
    const ownColumn = TABLES_OF[call].some((table) => schemaColumns.get(table)?.has(token) === true);
    if (ownColumn && !columns.has(token)) {
      problems.push(`a column beyond its own: ${token}`);
    }
  });
  for (const declaration of declarations) {
    if (!namesBusiness(tokens, declaration)) {
      const name =
        declaration.alias === null ? declaration.table : `${declaration.table} ${declaration.alias}`;
      problems.push(`a business's table read without its business: ${name}`);
    }
  }
  return problems;
}

/** The value a statement binds beside the business column of the one table it reads, or undefined when it binds none. */
function businessBound(statement: Sent): unknown {
  const [declaration] = declarationsOf(tokensOf(statement.text));
  if (declaration === undefined) {
    return undefined;
  }
  const column = businessColumnOf(declaration.table);
  const bound = new RegExp(`\\b${column}\\s+(?:=|is not distinct from)\\s+\\$(\\d+)`).exec(statement.text);
  return bound?.[1] === undefined ? undefined : statement.parameters[Number(bound[1]) - 1];
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("no statement names a visit's address, a message's words or any column of sealing_keys (items 49 and 50; default 91)", () => {
  it("the check refuses a whole row, a stray table or column, an address, words, a key and a business's table read without its business (shown on statements made to fail)", () => {
    const caught: { call: Call; statement: string; problems: string[] }[] = [
      {
        call: "readQuestionFacts",
        statement:
          "select a.address, a.zone from booking_addresses a where a.booking_id = $1 and a.business_id = $2",
        problems: [
          "never named: address",
          "never named: zone",
          "never named: booking_addresses",
          "a table beyond its own: booking_addresses",
        ],
      },
      {
        call: "readQuestionFacts",
        statement: "select m.words from messages m where m.business_id = $1",
        problems: ["never named: words", "never named: messages", "a table beyond its own: messages"],
      },
      {
        call: "readHandle",
        statement: 'select k.wrapped_key, k.wrapping_key_name from "sealing_keys" k where k.person_id = $1',
        problems: [
          "never named: wrapped_key",
          "never named: wrapping_key_name",
          "never named: sealing_keys",
          "never named: person_id",
          "a table beyond its own: sealing_keys",
        ],
      },
      {
        call: "readQuestionFacts",
        statement: "select q.business_id, q.readback, q.options from open_questions q where q.id = $1",
        problems: ["a column beyond its own: readback", "a column beyond its own: options"],
      },
      {
        call: "readQuestionFacts",
        statement: "select handle_id, person_id, status, versions_read from open_questions where id = $1",
        problems: [
          "a column beyond its own: handle_id",
          "a column beyond its own: person_id",
          "a column beyond its own: status",
          "a column beyond its own: versions_read",
        ],
      },
      {
        call: "readQuestionFacts",
        statement: "select time_zone from businesses",
        problems: ["a business's table read without its business: businesses"],
      },
      {
        call: "readQuestionFacts",
        statement: "select flow from bookings where id = $1",
        problems: ["a business's table read without its business: bookings"],
      },
      {
        call: "readQuestionFacts",
        statement: "select min(lower(r.during)) from reservations r where r.booking_id = $1",
        problems: ["a business's table read without its business: reservations r"],
      },
      {
        call: "readQuestionFacts",
        statement: "select id, version from clock_rows where open_question_id = $1",
        problems: ["a business's table read without its business: clock_rows"],
      },
      {
        call: "readHandle",
        statement: "select * from handles where id = $1",
        problems: ["*"],
      },
      {
        call: "readHandle",
        statement: "select to_jsonb(h) from handles h where h.id = $1",
        problems: ["a whole row: to_jsonb()", "a whole row: h"],
      },
      {
        call: "readHandle",
        statement:
          "select h.kind, p.number from handles h join phones p on p.handle_id = h.id where h.id = $1",
        problems: ["a table beyond its own: phones"],
      },
    ];
    for (const { call, statement, problems } of caught) {
      const found = problemsOf(statement, call);
      for (const problem of problems) {
        expect(found, statement).toContain(problem);
      }
    }
    // An actor name built in SQL, or any other column beside kind and address, is not readHandle's one statement.
    for (const statement of [
      "select kind || ':' || address as actor from handles where id = $1",
      "select id, kind, address from handles where id = $1",
    ]) {
      expect(problemsOf(statement, "readHandle"), statement).toEqual([]);
      expect(normalized(statement)).not.toBe(READ_HANDLE_STATEMENT);
    }
    // Statements shaped as the reads' own pass.
    const clean: [string, Call][] = [
      ["select business_id, booking_id, clock from open_questions where id = $1", "readQuestionFacts"],
      ["select time_zone from businesses where id = $1", "readQuestionFacts"],
      ["select flow from bookings where id = $1 and business_id = $2", "readQuestionFacts"],
      [
        "select min(lower(during)) as starts_at from reservations where booking_id = $1 and business_id = $2 and state in ('held', 'booked')",
        "readQuestionFacts",
      ],
      [
        `select id, version from clock_rows where open_question_id = $1 and kind = 'never_delivered' and business_id is not distinct from $2 order by state in ('waiting', 'armed') desc, id collate "C" limit 1`,
        "readQuestionFacts",
      ],
      [READ_HANDLE_STATEMENT, "readHandle"],
    ];
    for (const [statement, call] of clean) {
      expect(problemsOf(statement, call), statement).toEqual([]);
    }
  });

  it(
    "every statement both reads send, over every case, names only its read's tables and columns and none never named; each read of businesses, bookings, reservations and clock_rows binds the question's own business; readHandle sends its one statement; nothing is logged; no answer holds another row's id, a number, an address or the question's words",
    SLOW,
    async () => {
      const runs = await everyRun();
      expect(runs).toHaveLength(2 + QUESTION_IDS.length + HANDLE_IDS.length);
      for (const run of runs) {
        const label = `${run.call} ${run.id}`;
        expect(run.logged, label).toBe(0);
        const reading = run.statements.filter((statement) => tablesOf(statement.text).length > 0);
        for (const statement of run.statements) {
          expect(problemsOf(statement.text, run.call), `${label}: ${statement.text}`).toEqual([]);
        }
        if (run.call === "readHandle") {
          expect(
            reading.map((statement) => normalized(statement.text)),
            label,
          ).toEqual([READ_HANDLE_STATEMENT]);
          expect(reading[0]?.parameters, label).toEqual([run.id]);
          const text = JSON.stringify(run.outcome);
          for (const value of NEVER_ANSWERED_HANDLE) {
            expect(text.includes(value), `${label}: ${value}`).toBe(false);
          }
          continue;
        }
        // The question first, by its key; every later read binds the question's own business (null: none).
        expect(normalized(reading[0]?.text ?? ""), label).toBe(
          "select business_id, booking_id, clock from open_questions where id = $1",
        );
        expect(reading[0]?.parameters, label).toEqual([run.id]);
        for (const statement of reading.slice(1)) {
          expect(businessBound(statement), `${label}: ${statement.text}`).toBe(run.business);
        }
        if (!(run.outcome instanceof Error)) {
          expect(answerErrors("readQuestionFacts", run.outcome), label).toEqual([]);
          const text = JSON.stringify(run.outcome);
          for (const value of NEVER_ANSWERED_FACTS) {
            expect(text.includes(value), `${label}: ${value}`).toBe(false);
          }
        }
      }
      // Over every case each read named all of its tables and columns, and no other.
      for (const call of CALLS) {
        const statements = runs
          .filter((run) => run.call === call)
          .flatMap((run) => run.statements.map((statement) => statement.text));
        expect([...new Set(statements.flatMap(tablesOf))].sort(), call).toEqual([...TABLES_OF[call]].sort());
        const columns = statements.flatMap((statement) =>
          tokensOf(statement).filter((token) =>
            TABLES_OF[call].some((table) => schemaColumns.get(table)?.has(token) === true),
          ),
        );
        expect([...new Set(columns)].sort(), call).toEqual([...COLUMNS_OF[call]].sort());
      }
    },
  );
});

describe("a lost connection answers transient, with no row, address or connection string (K-05 transientError)", () => {
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

  /**
   * Runs `read` on a one-connection rosie_job client of its own while the owner holds `table` locked, and terminates the
   * read's backend (pg_terminate_backend) once it waits on that lock: the read's answer.
   */
  async function answerWhenCut(table: string, read: (sql: Sql) => Promise<unknown>): Promise<unknown> {
    const application = `rosie-t1258-cut-${table.replace(/_/g, "-")}`;
    const victim = roleClient(JOB_ROLE, application, 1, false);
    try {
      return await db.sql.begin(async (tx) => {
        await tx`lock table ${tx(table)} in access exclusive mode`;
        const pending = read(victim);
        const pid = await lockWaiter(application);
        await db.sql`select pg_terminate_backend(${pid})`;
        return pending;
      });
    } finally {
      // Its one connection is dead and never released (targets.ts inRuntimeTransaction): close it at once.
      await victim.end({ timeout: 0 });
    }
  }

  it(
    "each read, its backend terminated while it waits, answers transient with its SQLSTATE alone, writes nothing, and the same request then answers",
    SLOW,
    async () => {
      await given("read-question-facts-s1-02.json");
      const url = new URL(resolvePrimaryUrl());
      const neverInAnswer = [
        S1_02,
        BARBERSHOP,
        NEW_YORK,
        "handle-sam",
        "+15555550100",
        resolvePrimaryUrl(),
        url.host,
        url.username,
        url.password,
      ].filter((value) => value !== "");
      const before = await fingerprint();
      const cases: [Call, string, Row, unknown][] = [
        [
          "readQuestionFacts",
          "open_questions",
          { openQuestionId: S1_02 },
          exchangeOf("read-question-facts-s1-02.json").outcome,
        ],
        ["readHandle", "handles", { handleId: "handle-sam" }, exchangeOf("read-handle-sam.json").outcome],
      ];
      for (const [call, table, request, answer] of cases) {
        const outcome = await answerWhenCut(table, (sql) => readOf(call, request, sql));
        expect(outcome, call).toMatchObject({ error: "transient" });
        expect(Object.keys(outcome as object).sort(), call).toEqual(["error", "sqlstate"]);
        expect((outcome as { sqlstate: string }).sqlstate, call).toMatch(/^(08[0-9A-Z]{3}|57P0[123])$/);
        expect(answerErrors(call, outcome), call).toEqual([]);
        const text = JSON.stringify(outcome);
        for (const value of neverInAnswer) {
          expect(text.includes(value), call).toBe(false);
        }
        expect(await readOf(call, request), call).toEqual(answer);
      }
      expect(await fingerprint()).toEqual(before);
    },
  );
});
