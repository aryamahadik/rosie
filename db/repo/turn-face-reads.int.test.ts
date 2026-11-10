// T-1138: K-05 v1.3's three turn-face reads, readOpenHolds, readOutboxRow and readFixedLineFacts, against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/turn-face-reads`). The schema comes from migrating a
// fresh test schema, which test-db.ts drops when the file ends.
//
// Every call runs in the role K-05 v1.3 names (items 34 to 36; DL-326): readOpenHolds with a business through a client
// whose connections run as rosie_app, the Tool API's role, and with no business as rosie_job; readOutboxRow and
// readFixedLineFacts as rosie_job, under the request's business scope or on the runtime side. The tables' owner (the
// migrations' role) loads the seeds a fixture's `given` names (K-04's, and K-34's as partSeeds) and writes the extra rows
// a test adds; the owner is not bound by row-level security, so only the reads under test meet it. The commits a
// fixture's `after` chain names run for real through db/repo's commitTurn as rosie_job, each answering its own fixture.
//
// Both role clients record every statement they send (postgres.js `debug`), so the column-list test reads what the three
// reads sent, not a copy of their SQL (DL-326 note a).
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import { BusinessScopeError, setBusinessScope, type Sql, type Tx, withBusiness } from "./scope";
import { inRuntimeTransaction } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";
import {
  BrokenRecordError,
  readFixedLineFacts,
  readFixedLineFactsIn,
  type ReadFixedLineFactsRequest,
  type ReadFixedLineFactsResponse,
  readOpenHolds,
  readOpenHoldsIn,
  type ReadOpenHoldsRequest,
  type ReadOpenHoldsResponse,
  readOutboxRow,
  readOutboxRowIn,
  type ReadOutboxRowRequest,
  type ReadOutboxRowResponse,
} from "./turn-face-reads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

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
const BUNDLE = { hash: BUNDLE_HASH, build: 1 };

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
  request: Record<string, Json>;
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
const OPEN_HOLDS_FIXTURES = acceptedOf("readOpenHolds.exchange");
const OUTBOX_ROW_FIXTURES = acceptedOf("readOutboxRow.exchange");
const FIXED_LINE_FIXTURES = acceptedOf("readFixedLineFacts.exchange");
const READ_FIXTURES = [...OPEN_HOLDS_FIXTURES, ...OUTBOX_ROW_FIXTURES, ...FIXED_LINE_FIXTURES];
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
const V13_ID = (readJson(new URL("data-access/data-access.v1.3.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.3, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V13_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.3 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** The outcome checked against the call's response, or its errors when it is one. */
function outcomeErrors(call: string, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? `${call}.errors` : `${call}.response`, outcome);
}

function asHolds(outcome: unknown): ReadOpenHoldsResponse {
  if ((outcome as { result?: unknown }).result !== "openHolds") {
    throw new Error("expected open holds");
  }
  return outcome as ReadOpenHoldsResponse;
}

function asRow(outcome: unknown): ReadOutboxRowResponse {
  if ((outcome as { result?: unknown }).result !== "outboxRow") {
    throw new Error("expected an outbox row");
  }
  return outcome as ReadOutboxRowResponse;
}

function asFacts(outcome: unknown): ReadFixedLineFactsResponse {
  if ((outcome as { result?: unknown }).result !== "fixedLineFacts") {
    throw new Error("expected fixed-line facts");
  }
  return outcome as ReadFixedLineFactsResponse;
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_app, the Tool API's role, with this file's schema first. */
let app: Sql;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;
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
  db = await createTestDatabase({ name: "turn_face_reads" });
  app = roleClient(APP_ROLE, "rosie-t1138-app");
  job = roleClient(JOB_ROLE, "rosie-t1138-job");
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
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

/** The read an exchange names, in the role K-05 v1.3 gives it (items 34 to 36). */
async function runRead(exchange: Exchange): Promise<unknown> {
  const options = nowOf(exchange);
  if (exchange.call === "readOpenHolds") {
    const request = exchange.request as unknown as ReadOpenHoldsRequest;
    return readOpenHolds(request.businessId === null ? job : app, request, options);
  }
  if (exchange.call === "readOutboxRow") {
    return readOutboxRow(job, exchange.request as unknown as ReadOutboxRowRequest, options);
  }
  if (exchange.call === "readFixedLineFacts") {
    return readFixedLineFacts(job, exchange.request as unknown as ReadFixedLineFactsRequest, options);
  }
  throw new Error(`no v1.3 read is called ${exchange.call}`);
}

// ---- rows of other businesses and of none, beside a fixture's state --------------------------------------------------

const TRIES = [{ model: "haiku", result: "verdict" }];
const ALEX_PHONE = {
  stopped: false,
  chatOpen: true,
  chatWay: "imessage",
  pollVotedAt: "2026-10-23T14:06:10Z",
  version: 3,
};
const ALEX_OPT_OUT_AT = "2026-10-12T16:20:00Z";

/** K-03 v1 final parts with one words send (and the fixed lines given). */
function wordsParts(row: string, text: string, fixedLines: string[] = []): Json {
  return {
    row,
    channel: "imessage",
    sends: [{ kind: "words", text, calendarFile: "none", options: [], link: null }],
    fixedLines,
    slotValues: [],
    threadReplyTo: null,
  };
}

/** A hold with its outcome, as the owner writes them (K-34 v1: one hold per outcome). */
async function addHold(
  tx: Db,
  hold: {
    id: string;
    eventId: string;
    businessId: string | null;
    turnId: string;
    rule: string;
    blocksBooking: boolean;
    heldAt: string;
  },
): Promise<void> {
  const outcomeId = hold.id.replace(/^hold-/, "safety-");
  await insertRow(tx, "safety_outcomes", {
    id: outcomeId,
    event_id: hold.eventId,
    source: "text",
    handle_id: "handle-alex",
    person_id: "person-alex",
    business_id: hold.businessId,
    turn_id: hold.turnId,
    read_at: hold.heldAt,
    tries: TRIES,
    timed_out: false,
    labels: ["Unsure"],
    tenses: ["unknown"],
    outcomes: ["Unsure"],
  });
  await insertRow(tx, "safety_holds", {
    id: hold.id,
    safety_outcome_id: outcomeId,
    business_id: hold.businessId,
    handle_id: "handle-alex",
    person_id: "person-alex",
    turn_id: hold.turnId,
    release_rule: hold.rule,
    blocks_booking: hold.blocksBooking,
    held_at: hold.heldAt,
  });
}

/**
 * Beside K-34's barbershop holds on Alex's handle (read-open-holds-alex): a yoga studio hold and a hold with no business,
 * each open with its outcome, and a barbershop hold held at the same moment as hold-alex-0203 whose id sorts before it
 * byte by byte ('A' before 'a'), though not in a natural language's order.
 */
async function addHoldsElsewhere(): Promise<void> {
  await db.sql.begin(async (tx) => {
    for (const [turnId, eventId, at] of [
      ["turn-alex-yoga-1", "evt-alex-yoga-1", "2026-10-26T10:00:03Z"],
      ["turn-alex-nobiz-1", "evt-alex-nobiz-1", "2026-10-20T10:00:03Z"],
    ] as const) {
      await insertRow(tx, "turns", {
        id: turnId,
        handle_id: "handle-alex",
        event_ids: [eventId],
        state: "committed",
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        trace_id: `trace-${eventId}`,
        committed_at: at,
      });
    }
    await addHold(tx, {
      id: "hold-alex-yoga-1",
      eventId: "evt-alex-yoga-1",
      businessId: YOGA,
      turnId: "turn-alex-yoga-1",
      rule: "after_safe",
      blocksBooking: true,
      heldAt: "2026-10-26T10:00:03Z",
    });
    await addHold(tx, {
      id: "hold-alex-nobiz-1",
      eventId: "evt-alex-nobiz-1",
      businessId: null,
      turnId: "turn-alex-nobiz-1",
      rule: "after_safe",
      blocksBooking: false,
      heldAt: "2026-10-20T10:00:03Z",
    });
    await addHold(tx, {
      id: "hold-Alex-tie",
      eventId: "evt-alex-tie",
      businessId: BARBERSHOP,
      turnId: "turn-alex-0203",
      rule: "at_once",
      blocksBooking: true,
      heldAt: "2026-10-25T23:10:02Z",
    });
  });
}

const TIE_HOLD = {
  holdId: "hold-Alex-tie",
  releaseRule: "at_once",
  blocksBooking: true,
  safetyOutcomeId: "safety-Alex-tie",
  bookingId: null,
  turnId: "turn-alex-0203",
  heldAt: "2026-10-25T23:10:02Z",
  version: 1,
};
const YOGA_HOLD = {
  holdId: "hold-alex-yoga-1",
  releaseRule: "after_safe",
  blocksBooking: true,
  safetyOutcomeId: "safety-alex-yoga-1",
  bookingId: null,
  turnId: "turn-alex-yoga-1",
  heldAt: "2026-10-26T10:00:03Z",
  version: 1,
};
const NO_BUSINESS_HOLD = {
  holdId: "hold-alex-nobiz-1",
  releaseRule: "after_safe",
  blocksBooking: false,
  safetyOutcomeId: "safety-alex-nobiz-1",
  bookingId: null,
  turnId: "turn-alex-nobiz-1",
  heldAt: "2026-10-20T10:00:03Z",
  version: 1,
};

/**
 * Beside the barbershop's rows to Alex (seed-thread-messages): the yoga studio's question to his handle with its armed
 * clock row and the row that asked it, which has gone, from his first text's turn; and the yoga studio's safety row for
 * that text (evt-alex-0001), which only the yoga studio's scope may read.
 */
async function addYogaRows(): Promise<void> {
  await db.sql.begin(async (tx) => {
    await insertRow(tx, "open_questions", {
      id: "oq-yoga-alex",
      turn_id: "turn-alex-first",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: YOGA,
      booking_id: "booking-alex-workshop",
      step: "A7-03",
      options: [{ id: "A7-03/1", label: "Sun 9:00am" }],
      versions_read: [],
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      clock: "24 h",
      status: "open",
    });
    await insertRow(tx, "clock_rows", {
      id: "clock-oq-yoga-alex",
      kind: "question",
      open_question_id: "oq-yoga-alex",
      handle_id: "handle-alex",
      business_id: YOGA,
      booking_id: "booking-alex-workshop",
      due_at: "2026-10-24T15:00:00Z",
      due_zone: "America/New_York",
      state: "armed",
      armed_at: "2026-10-23T15:00:01Z",
      fires: { step: "A7-03", safeDefault: "the time stays as booked" },
    });
    await insertRow(tx, "outbox_rows", {
      id: "out-yoga-alex",
      turn_id: "turn-alex-first",
      recipient_handle_id: "handle-alex",
      recipient_person_id: "person-alex",
      business_id: YOGA,
      booking_id: "booking-alex-workshop",
      channel: "imessage",
      versions_read: [],
      open_question_id: "oq-yoga-alex",
      plan: { row: "out-yoga-alex" },
      final_parts: wordsParts("out-yoga-alex", "Yoga words as sent"),
      state: "delivered",
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: "trace-yoga-0001",
    });
    await insertRow(tx, "outbox_parts", {
      outbox_row_id: "out-yoga-alex",
      part_no: 1,
      try_no: 1,
      idempotency_key: "out-yoga-alex/1/1",
      kind: "words",
      linq_message_id: "linq-msg-demo-0090",
      state: "delivered",
      sent_at: "2026-10-23T15:00:00Z",
      delivered_at: "2026-10-23T15:00:01Z",
    });
    await insertRow(tx, "safety_outcomes", {
      id: "safety-alex-0001-yoga",
      event_id: "evt-alex-0001",
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: YOGA,
      turn_id: "turn-alex-first",
      read_at: "2026-10-12T16:20:01Z",
      tries: TRIES,
      timed_out: false,
      labels: ["Unsure"],
      tenses: ["unknown"],
      outcomes: ["Unsure"],
    });
  });
}

/**
 * Rows to Alex with no business (Rosie's own lines before there is one): a question with its waiting clock row, the row
 * that asked it, which has gone and carried the opener, and a later row that asks nothing, both from a turn whose two
 * texts have a safety row with no business (read on the runtime side) and the yoga studio's (never read there).
 */
async function addNoBusinessRows(): Promise<void> {
  await db.sql.begin(async (tx) => {
    await insertRow(tx, "turns", {
      id: "turn-alex-nobiz-2",
      handle_id: "handle-alex",
      event_ids: ["evt-alex-nobiz-2", "evt-alex-0001"],
      state: "committed",
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: "trace-alex-nobiz-2",
      committed_at: "2026-11-01T11:59:58Z",
    });
    await insertRow(tx, "open_questions", {
      id: "oq-nobiz-alex",
      turn_id: "turn-alex-nobiz-2",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: null,
      booking_id: null,
      step: "S1-02",
      options: [],
      versions_read: [],
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
    });
    await insertRow(tx, "clock_rows", {
      id: "clock-oq-nobiz-alex",
      kind: "question",
      open_question_id: "oq-nobiz-alex",
      handle_id: "handle-alex",
      business_id: null,
      fires: { step: "S1-02", safeDefault: null },
    });
    await insertRow(tx, "outbox_rows", {
      id: "out-nobiz-alex",
      turn_id: "turn-alex-nobiz-2",
      recipient_handle_id: "handle-alex",
      recipient_person_id: "person-alex",
      business_id: null,
      channel: "imessage",
      versions_read: [],
      open_question_id: "oq-nobiz-alex",
      final_parts: wordsParts("out-nobiz-alex", "No-business words as sent", ["opener"]),
      state: "sent",
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: "trace-nobiz-0001",
    });
    await insertRow(tx, "outbox_parts", {
      outbox_row_id: "out-nobiz-alex",
      part_no: 1,
      try_no: 1,
      idempotency_key: "out-nobiz-alex/1/1",
      kind: "words",
      linq_message_id: "linq-msg-demo-0091",
      state: "sent",
      sent_at: "2026-11-01T12:00:00Z",
    });
    await insertRow(tx, "outbox_rows", {
      id: "out-nobiz-alex-later",
      turn_id: "turn-alex-nobiz-2",
      recipient_handle_id: "handle-alex",
      recipient_person_id: "person-alex",
      business_id: null,
      channel: "imessage",
      versions_read: [],
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: "trace-nobiz-0002",
    });
    await insertRow(tx, "safety_outcomes", {
      id: "safety-alex-nobiz-2",
      event_id: "evt-alex-nobiz-2",
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: null,
      turn_id: "turn-alex-nobiz-2",
      read_at: "2026-11-01T11:59:57Z",
      tries: TRIES,
      timed_out: false,
      labels: ["No"],
      tenses: ["over"],
      outcomes: ["No"],
    });
  });
}

const NO_BUSINESS_TEXTS = [
  { eventId: "evt-alex-nobiz-2", outcomes: ["No"], tenses: ["over"] },
  { eventId: "evt-alex-0001", outcomes: null, tenses: null },
];

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the roles the reads run as (K-05 v1.3 items 34 to 36; T-191)", () => {
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

describe("each v1.3 fixture of the three reads gives its outcome (K-05 v1.3 items 34 to 36)", () => {
  it("the index lists the three reads' twelve exchanges, each valid against data-access v1.3", SLOW, () => {
    expect([...OPEN_HOLDS_FIXTURES].sort()).toEqual([
      "read-open-holds-alex.json",
      "read-open-holds-other-business.json",
      "read-open-holds-s1-02.json",
    ]);
    expect([...OUTBOX_ROW_FIXTURES].sort()).toEqual([
      "read-outbox-row-a7-03.json",
      "read-outbox-row-no-question.json",
      "read-outbox-row-other-business.json",
      "read-outbox-row-s1-02.json",
      "read-outbox-row-safety-line.json",
    ]);
    expect([...FIXED_LINE_FIXTURES].sort()).toEqual([
      "fixed-line-facts-opener-row.json",
      "fixed-line-facts-other-business.json",
      "fixed-line-facts-s1-02.json",
      "fixed-line-facts-texted-before.json",
    ]);
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
      expect(outcomeErrors(exchange.call, outcome)).toEqual([]);
    });
  }

  it(
    "readOpenHoldsIn inside the Tool API's own call transaction (withBusiness, as rosie_app) answers the same",
    SLOW,
    async () => {
      for (const file of OPEN_HOLDS_FIXTURES) {
        const exchange = await given(file);
        const request = exchange.request as unknown as ReadOpenHoldsRequest;
        const businessId = request.businessId;
        if (businessId === null) {
          throw new Error(`${file} names a business`);
        }
        const outcome = await withBusiness(app, businessId, (tx) =>
          readOpenHoldsIn(tx, request, nowOf(exchange)),
        );
        expect(outcome, file).toEqual(exchange.outcome);
      }
    },
  );
});

describe("readOpenHolds: one business's holds, never another's (K-34 v1 rule 4; defaults 43 to 46)", () => {
  const EVENTS = ["evt-alex-0231", "evt-alex-nobiz-1", "evt-alex-yoga-1", "evt-alex-0204", "evt-alex-tie"];
  const requestOf = (businessId: string | null): ReadOpenHoldsRequest => ({
    handleId: "handle-alex",
    businessId,
    eventIds: EVENTS,
  });

  it(
    "under the barbershop (rosie_app): its open holds in held_at order, a tie to the lower id byte by byte; the yoga studio's hold, the hold with no business and their texts' safety rows unseen",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      const fixture = asHolds(exchange.outcome);
      const outcome = await readOpenHolds(app, requestOf(BARBERSHOP), nowOf(exchange));
      expect(outcome).toEqual({
        ...fixture,
        holds: [TIE_HOLD, ...fixture.holds],
        unreadEventIds: ["evt-alex-0231", "evt-alex-nobiz-1", "evt-alex-yoga-1"],
      });
      expect(outcomeErrors("readOpenHolds", outcome)).toEqual([]);
    },
  );

  it(
    "under the yoga studio: its own hold only, and the barbershop's texts count unread there (default 44)",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      const outcome = await readOpenHolds(app, requestOf(YOGA), nowOf(exchange));
      expect(outcome).toEqual({
        result: "openHolds",
        handleId: "handle-alex",
        businessId: YOGA,
        readAt: exchange.given.now,
        holds: [YOGA_HOLD],
        unreadEventIds: ["evt-alex-0231", "evt-alex-nobiz-1", "evt-alex-0204", "evt-alex-tie"],
      });
      expect(outcomeErrors("readOpenHolds", outcome)).toEqual([]);
    },
  );

  it(
    "with no business (rosie_job, the runtime side): only the hold and the safety row with no business, none of any business's",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      const outcome = await readOpenHolds(job, requestOf(null), nowOf(exchange));
      expect(outcome).toEqual({
        result: "openHolds",
        handleId: "handle-alex",
        businessId: null,
        readAt: exchange.given.now,
        holds: [NO_BUSINESS_HOLD],
        unreadEventIds: ["evt-alex-0231", "evt-alex-yoga-1", "evt-alex-0204", "evt-alex-tie"],
      });
      expect(outcomeErrors("readOpenHolds", outcome)).toEqual([]);
    },
  );

  it(
    "with no business on rosie_app, which sees no row without a scope, the read refuses to run rather than answer nothing open (DL-326 note 4)",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      await expect(readOpenHolds(app, requestOf(null), nowOf(exchange))).rejects.toThrow(BusinessScopeError);
      await expect(
        inRuntimeTransaction(app, { readOnly: true }, (tx) => readOpenHoldsIn(tx, requestOf(null))),
      ).rejects.toThrow("rosie_app sees no row without a scope");
    },
  );

  it(
    "the call's own filters, not only the scope: run by the tables' owner, whom row-level security does not bind, each side still answers its own rows",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      const barbershop = await db.sql.begin(async (tx) => {
        await setBusinessScope(tx, BARBERSHOP);
        return readOpenHoldsIn(tx, requestOf(BARBERSHOP), nowOf(exchange));
      });
      expect(asHolds(barbershop).holds.map((hold) => hold.holdId)).toEqual([
        "hold-Alex-tie",
        "hold-alex-0203",
        "hold-alex-0204",
      ]);
      expect(asHolds(barbershop).unreadEventIds).toEqual([
        "evt-alex-0231",
        "evt-alex-nobiz-1",
        "evt-alex-yoga-1",
      ]);
      const none = await db.sql.begin((tx) => readOpenHoldsIn(tx, requestOf(null), nowOf(exchange)));
      expect(asHolds(none).holds).toEqual([NO_BUSINESS_HOLD]);
      expect(asHolds(none).unreadEventIds).toEqual([
        "evt-alex-0231",
        "evt-alex-yoga-1",
        "evt-alex-0204",
        "evt-alex-tie",
      ]);
    },
  );

  it("a business that does not exist is notFound, never 'nothing open'", SLOW, async () => {
    const exchange = await given("read-open-holds-alex.json");
    const outcome = await readOpenHolds(app, requestOf("biz-nobody"), nowOf(exchange));
    expect(outcome).toEqual({ error: "notFound", table: "businesses", rowId: "biz-nobody" });
    expect(outcomeErrors("readOpenHolds", outcome)).toEqual([]);
  });

  it(
    "primary, no cache: a hold opened in a transaction still open is not seen; after its commit the next read sees it, and a release takes it out",
    SLOW,
    async () => {
      const exchange = await given("read-open-holds-alex.json");
      const request = exchange.request as unknown as ReadOpenHoldsRequest;
      await db.sql.begin(async (tx) => {
        await insertRow(tx, "turns", {
          id: "turn-alex-0232",
          handle_id: "handle-alex",
          event_ids: ["evt-alex-0231"],
          state: "committed",
          bundle_hash: BUNDLE_HASH,
          bundle_build: 1,
          trace_id: "trace-alex-0232",
          committed_at: "2026-10-27T09:00:02Z",
        });
        await addHold(tx, {
          id: "hold-alex-0232",
          eventId: "evt-alex-0231",
          businessId: BARBERSHOP,
          turnId: "turn-alex-0232",
          rule: "after_safe",
          blocksBooking: false,
          heldAt: "2026-10-27T09:00:02Z",
        });
        expect(await readOpenHolds(app, request, nowOf(exchange))).toEqual(exchange.outcome);
      });
      const after = asHolds(await readOpenHolds(app, request, nowOf(exchange)));
      expect(after.holds.map((hold) => hold.holdId)).toEqual([
        "hold-alex-0203",
        "hold-alex-0204",
        "hold-alex-0232",
      ]);
      expect(after.unreadEventIds).toEqual([]);
      await db.sql`
        update safety_holds
        set released_at = '2026-10-27T09:05:00Z', released_why = 'safe_readback', released_by_turn_id = 'turn-alex-0232',
            released_by_outcome_id = 'safety-alex-0232', version = version + 1
        where id = 'hold-alex-0203'
      `;
      const released = asHolds(await readOpenHolds(app, request, nowOf(exchange)));
      expect(released.holds.map((hold) => hold.holdId)).toEqual(["hold-alex-0204", "hold-alex-0232"]);
      expect(outcomeErrors("readOpenHolds", released)).toEqual([]);
    },
  );
});

describe("readOutboxRow: one business's row and record, never another's (K-05 v1.3 item 35)", () => {
  const ALEX_FIRST: ReadOutboxRowRequest = { outboxRowId: "out-alex-first", businessId: BARBERSHOP };

  it(
    "under the barbershop: the yoga studio's question, role and safety row for the same text stay out, and the answer is the fixture's",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await addNoBusinessRows();
      const outcome = await readOutboxRow(job, ALEX_FIRST, nowOf(exchange));
      expect(outcome).toEqual(exchange.outcome);
    },
  );

  it(
    "under the yoga studio: only the yoga studio's record, its safety row for the text read there, none of the barbershop's questions",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await addNoBusinessRows();
      const outcome = await readOutboxRow(
        job,
        { outboxRowId: "out-yoga-alex", businessId: YOGA },
        nowOf(exchange),
      );
      expect(outcome).toEqual({
        result: "outboxRow",
        outboxRowId: "out-yoga-alex",
        businessId: YOGA,
        readAt: exchange.given.now,
        row: {
          turnId: "turn-alex-first",
          bundleId: BUNDLE,
          state: "delivered",
          version: 1,
          channel: "imessage",
          sendClass: "routine",
          bookingId: "booking-alex-workshop",
          openQuestionId: "oq-yoga-alex",
          copyOfRowId: null,
          hasPlan: true,
          finalParts: wordsParts("out-yoga-alex", "Yoga words as sent"),
        },
        line: { step: "A7-03", index: 0, from: "openQuestion" },
        recipient: {
          handleId: "handle-alex",
          kind: "phone",
          personId: "person-alex",
          name: "Alex M.",
          storedLanguage: "en",
          roles: [{ roleId: "role-alex-yoga", role: "customer", version: 1 }],
          phone: ALEX_PHONE,
        },
        answers: {
          handleId: "handle-alex",
          texts: [{ eventId: "evt-alex-0001", outcomes: ["Unsure"], tenses: ["unknown"] }],
        },
        slotSource: {
          business: {
            id: YOGA,
            name: "Yoga studio",
            displayName: "Yoga studio",
            timeZone: "America/New_York",
            version: 2,
          },
          booking: {
            id: "booking-alex-workshop",
            businessId: YOGA,
            flow: "A",
            stage: "booked",
            bookerPersonId: "person-alex",
            servedPersonId: "person-alex",
            payerPersonId: "person-alex",
            private: false,
            deceased: false,
            version: 2,
          },
          question: {
            id: "oq-yoga-alex",
            step: "A7-03",
            status: "open",
            options: [{ id: "A7-03/1", label: "Sun 9:00am" }],
            readback: null,
            clock: "24 h",
            askCount: 1,
            version: 1,
            clockRow: {
              id: "clock-oq-yoga-alex",
              state: "armed",
              dueAt: "2026-10-24T15:00:00Z",
              dueZone: "America/New_York",
              version: 1,
            },
          },
        },
        openQuestions: [],
      });
      expect(outcomeErrors("readOutboxRow", outcome)).toEqual([]);
    },
  );

  it(
    "the call's own filters, not only the scope: run by the tables' owner under the barbershop's scope, the answer is still the fixture's",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await addNoBusinessRows();
      const outcome = await db.sql.begin(async (tx) => {
        await setBusinessScope(tx, BARBERSHOP);
        return readOutboxRowIn(tx, ALEX_FIRST, nowOf(exchange));
      });
      expect(outcome).toEqual(exchange.outcome);
    },
  );

  it(
    "default 48: a row that asks no question answers line null, never a guess from its booking's question, its turn's or another live one",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-no-question.json");
      await insertRow(db.sql, "outbox_rows", {
        id: "out-alex-haircut-note",
        turn_id: "turn-alex-move-1",
        recipient_handle_id: "handle-alex",
        recipient_person_id: "person-alex",
        business_id: BARBERSHOP,
        booking_id: "booking-alex-haircut",
        channel: "imessage",
        versions_read: [],
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        trace_id: "trace-alex-0007",
      });
      const row = asRow(
        await readOutboxRow(
          job,
          { outboxRowId: "out-alex-haircut-note", businessId: BARBERSHOP },
          nowOf(exchange),
        ),
      );
      // The turn that committed it opened A7-03 about the same booking, and A7-03 is live with Alex: still no line.
      expect(row.line).toBeNull();
      expect(row.slotSource.question).toBeNull();
      expect(row.slotSource.booking?.id).toBe("booking-alex-haircut");
      expect(row.answers.texts).toEqual([{ eventId: "evt-alex-0007", outcomes: null, tenses: null }]);
      expect(row.openQuestions).toEqual(asRow(exchange.outcome).openQuestions);
      expect(outcomeErrors("readOutboxRow", row)).toEqual([]);
    },
  );

  it(
    "a row whose question is another business's is a broken record: refused whole, never answered half (default 2)",
    SLOW,
    async () => {
      await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await db.sql`
        update outbox_rows set open_question_id = 'oq-yoga-alex', version = version + 1 where id = 'out-alex-first'
      `;
      await expect(readOutboxRow(job, ALEX_FIRST)).rejects.toThrow(BrokenRecordError);
    },
  );
});

describe("no business yet: the runtime side returns no row that has a business (items 35 and 36)", () => {
  it(
    "readOutboxRow with no business: a row with none, with no role, no business head and none of any business's questions or safety rows",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await addNoBusinessRows();
      const later = await readOutboxRow(
        job,
        { outboxRowId: "out-nobiz-alex-later", businessId: null },
        nowOf(exchange),
      );
      expect(later).toEqual({
        result: "outboxRow",
        outboxRowId: "out-nobiz-alex-later",
        businessId: null,
        readAt: exchange.given.now,
        row: {
          turnId: "turn-alex-nobiz-2",
          bundleId: BUNDLE,
          state: "planned",
          version: 1,
          channel: "imessage",
          sendClass: "routine",
          bookingId: null,
          openQuestionId: null,
          copyOfRowId: null,
          hasPlan: false,
          finalParts: null,
        },
        line: null,
        recipient: {
          handleId: "handle-alex",
          kind: "phone",
          personId: "person-alex",
          name: "Alex M.",
          storedLanguage: "en",
          roles: [],
          phone: ALEX_PHONE,
        },
        answers: { handleId: "handle-alex", texts: NO_BUSINESS_TEXTS },
        slotSource: { business: null, booking: null, question: null },
        openQuestions: [{ id: "oq-nobiz-alex", step: "S1-02", text: "No-business words as sent" }],
      });
      expect(outcomeErrors("readOutboxRow", later)).toEqual([]);

      const asking = asRow(
        await readOutboxRow(job, { outboxRowId: "out-nobiz-alex", businessId: null }, nowOf(exchange)),
      );
      expect(asking.line).toEqual({ step: "S1-02", index: 0, from: "openQuestion" });
      expect(asking.slotSource.question).toEqual({
        id: "oq-nobiz-alex",
        step: "S1-02",
        status: "waiting",
        options: [],
        readback: null,
        clock: null,
        askCount: 1,
        version: 1,
        clockRow: { id: "clock-oq-nobiz-alex", state: "waiting", dueAt: null, dueZone: null, version: 1 },
      });
      expect(asking.openQuestions).toEqual([]);
      expect(asking.answers.texts).toEqual(NO_BUSINESS_TEXTS);
      expect(outcomeErrors("readOutboxRow", asking)).toEqual([]);

      const scoped = await readOutboxRow(
        job,
        { outboxRowId: "out-alex-first", businessId: null },
        nowOf(exchange),
      );
      expect(scoped).toEqual({ error: "notFound", table: "outbox_rows", rowId: "out-alex-first" });
      const hidden = await readOutboxRow(
        job,
        { outboxRowId: "out-nobiz-alex-later", businessId: BARBERSHOP },
        nowOf(exchange),
      );
      expect(hidden).toEqual({ error: "notFound", table: "outbox_rows", rowId: "out-nobiz-alex-later" });
    },
  );

  it(
    "readFixedLineFacts with no business: an earlier row with none that carried the opener; a business's row, opener and all, never counts (default 50)",
    SLOW,
    async () => {
      const exchange = await given("fixed-line-facts-texted-before.json");
      await addYogaRows();
      // The barbershop's first reply to Alex, before every row with no business, carries the opener too.
      await db.sql`
        update outbox_rows set final_parts = ${db.sql.json(wordsParts("out-alex-first", "Hi Alex", ["opener"]))},
          version = version + 1
        where id = 'out-alex-first'
      `;
      await addNoBusinessRows();
      const later = await readFixedLineFacts(
        job,
        { outboxRowId: "out-nobiz-alex-later", businessId: null },
        nowOf(exchange),
      );
      expect(later).toEqual({
        result: "fixedLineFacts",
        outboxRowId: "out-nobiz-alex-later",
        businessId: null,
        recipientHandleId: "handle-alex",
        readAt: exchange.given.now,
        textedAboutBusiness: true,
        openerRowId: "out-nobiz-alex",
        optOutLineDeliveredAt: ALEX_OPT_OUT_AT,
      });
      expect(outcomeErrors("readFixedLineFacts", later)).toEqual([]);
      const first = asFacts(
        await readFixedLineFacts(job, { outboxRowId: "out-nobiz-alex", businessId: null }, nowOf(exchange)),
      );
      expect([first.textedAboutBusiness, first.openerRowId]).toEqual([false, null]);
      expect(
        await readFixedLineFacts(job, { outboxRowId: "out-alex-first", businessId: null }, nowOf(exchange)),
      ).toEqual({ error: "notFound", table: "outbox_rows", rowId: "out-alex-first" });
    },
  );
});

describe("readFixedLineFacts: one business's opener mark, never another's (item 36)", () => {
  it(
    "under the yoga studio, the barbershop's mark on the same handle is not the yoga studio's first text; its own mark is",
    SLOW,
    async () => {
      const exchange = await given("fixed-line-facts-texted-before.json");
      await addYogaRows();
      const request: ReadFixedLineFactsRequest = { outboxRowId: "out-yoga-alex", businessId: YOGA };
      const before = await readFixedLineFacts(job, request, nowOf(exchange));
      expect(before).toEqual({
        result: "fixedLineFacts",
        outboxRowId: "out-yoga-alex",
        businessId: YOGA,
        recipientHandleId: "handle-alex",
        readAt: exchange.given.now,
        textedAboutBusiness: false,
        openerRowId: null,
        optOutLineDeliveredAt: ALEX_OPT_OUT_AT,
      });
      expect(outcomeErrors("readFixedLineFacts", before)).toEqual([]);
      // Run by the tables' owner, who sees every business's marks, under the yoga studio's scope: the same answer.
      const owner = await db.sql.begin(async (tx) => {
        await setBusinessScope(tx, YOGA);
        return readFixedLineFactsIn(tx, request, nowOf(exchange));
      });
      expect(owner).toEqual(before);
      await insertRow(db.sql, "openers_sent", {
        handle_id: "handle-alex",
        business_id: YOGA,
        sent_at: "2026-10-23T15:00:01Z",
        outbox_row_id: "out-yoga-alex",
      });
      const marked = asFacts(await readFixedLineFacts(job, request, nowOf(exchange)));
      expect([marked.textedAboutBusiness, marked.openerRowId]).toEqual([false, "out-yoga-alex"]);
      expect(
        await readFixedLineFacts(
          job,
          exchange.request as unknown as ReadFixedLineFactsRequest,
          nowOf(exchange),
        ),
      ).toEqual(exchange.outcome);
    },
  );
});

describe("sealed values: never selected, never answered, never logged (item 35's reason 1; DL-326 note a)", () => {
  /** Never named by a statement of the three reads: the four sealed or personal columns and the key table. */
  const NEVER_NAMED = new Set([
    "words",
    "sealed_words",
    "address",
    "number",
    "sealing_keys",
    "wrapped_key",
    "wrapping_key_name",
  ]);
  /** What no answer may hold: numbers, the email address, an inbound text's words, K-34's sealed stand-in bytes. */
  const NEVER_ANSWERED = [
    "+1555555",
    "alex@example.com",
    "Haircut at Lee's Barbershop this Saturday?",
    "k34-seed-sealed-words-not-real",
    "6b33342d736565642d7365616c65642d776f7264732d6e6f742d7265616c",
    "SEALING_WRAP_KEY",
  ];

  /** A statement's names: string literals dropped, quoted names unquoted, lower case. */
  function namesOf(statement: string): string[] {
    return (
      statement
        .replace(/'(?:[^']|'')*'/g, " ")
        .replaceAll('"', "")
        .toLowerCase()
        .match(/[a-z_][a-z0-9_$]*/g) ?? []
    );
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

  it(
    "every statement the three reads send, in every fixture and on the runtime side, names no sealed column and selects no *; nothing is logged; no answer holds a sealed value",
    SLOW,
    async () => {
      const statements: string[] = [];
      const outcomes: unknown[] = [];
      let logged = 0;
      const watch = async (read: () => Promise<unknown>): Promise<void> => {
        sent.length = 0;
        const run = await unlogged(read);
        statements.push(...sent);
        outcomes.push(run.outcome);
        logged += run.logged;
      };
      for (const file of READ_FIXTURES) {
        const exchange = await given(file);
        await watch(() => runRead(exchange));
      }
      const noQuestion = await given("read-outbox-row-no-question.json");
      await addYogaRows();
      await addNoBusinessRows();
      for (const outboxRowId of ["out-nobiz-alex", "out-nobiz-alex-later"]) {
        await watch(() => readOutboxRow(job, { outboxRowId, businessId: null }, nowOf(noQuestion)));
        await watch(() => readFixedLineFacts(job, { outboxRowId, businessId: null }, nowOf(noQuestion)));
      }
      await watch(() =>
        readOutboxRow(job, { outboxRowId: "out-yoga-alex", businessId: YOGA }, nowOf(noQuestion)),
      );
      const holds = await given("read-open-holds-alex.json");
      await addHoldsElsewhere();
      await watch(() =>
        readOpenHolds(
          job,
          { handleId: "handle-alex", businessId: null, eventIds: ["evt-alex-nobiz-1"] },
          nowOf(holds),
        ),
      );

      // The record was read: every table the three reads name was named.
      const named = new Set(statements.flatMap(namesOf));
      for (const table of [
        "safety_holds",
        "safety_outcomes",
        "businesses",
        "outbox_rows",
        "outbox_parts",
        "open_questions",
        "clock_rows",
        "turns",
        "persons",
        "person_roles",
        "handles",
        "phones",
        "bookings",
        "openers_sent",
      ]) {
        expect(named.has(table), table).toBe(true);
      }
      for (const statement of statements) {
        expect(
          namesOf(statement).filter((name) => NEVER_NAMED.has(name)),
          statement,
        ).toEqual([]);
        expect(statement.includes("*"), statement).toBe(false);
      }
      expect(logged).toBe(0);
      expect(outcomes).toHaveLength(READ_FIXTURES.length + 6);
      for (const outcome of outcomes) {
        const text = JSON.stringify(outcome);
        for (const value of NEVER_ANSWERED) {
          expect(text.includes(value), value).toBe(false);
        }
      }
    },
  );

  it(
    "an error names a field, a table or a call, never a value or an id: refused requests and a broken record",
    SLOW,
    async () => {
      await given("read-outbox-row-no-question.json");
      await addYogaRows();
      const words = "Haircut at Lee's Barbershop this Saturday?";
      const refused: [() => Promise<unknown>, string][] = [
        [
          () =>
            readOpenHolds(app, {
              handleId: "+15555550101",
              businessId: BARBERSHOP,
              eventIds: [words, words],
            }),
          "eventIds names each text once",
        ],
        [
          () => readOpenHolds(app, { handleId: "+15555550101", businessId: " ", eventIds: [] }),
          "a business scope needs a non-empty business id",
        ],
        [
          () =>
            readOutboxRow(job, {
              outboxRowId: "+15555550101",
              businessId: BARBERSHOP,
              to: "alex@example.com",
            } as unknown as ReadOutboxRowRequest),
          "the request takes only outboxRowId, businessId",
        ],
        [
          () =>
            readFixedLineFacts(job, {
              outboxRowId: words,
              businessId: 7,
            } as unknown as ReadFixedLineFactsRequest),
          "businessId is a non-empty id",
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
      await db.sql`
        update outbox_rows set open_question_id = 'oq-yoga-alex', version = version + 1 where id = 'out-alex-first'
      `;
      const broken = await readOutboxRow(job, { outboxRowId: "out-alex-first", businessId: BARBERSHOP }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(broken).toBeInstanceOf(BrokenRecordError);
      const text = (broken as Error).message;
      for (const value of [
        "out-alex-first",
        "oq-yoga-alex",
        "handle-alex",
        "person-alex",
        "+1555",
        BARBERSHOP,
      ]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );
});

describe("the side and the request (STATE notes 5 and 22; T-1094's note N2)", () => {
  it(
    "each In read runs only on its request's side: its business's scope, or with no business none",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-a7-03.json");
      const holds: ReadOpenHoldsRequest = { handleId: "handle-alex", businessId: BARBERSHOP, eventIds: [] };
      const row: ReadOutboxRowRequest = { outboxRowId: "out-a7-03-alex", businessId: BARBERSHOP };
      expect(await withBusiness(job, BARBERSHOP, (tx) => readOutboxRowIn(tx, row, nowOf(exchange)))).toEqual(
        exchange.outcome,
      );
      const scoped: ((tx: Db) => Promise<unknown>)[] = [
        (tx) => readOpenHoldsIn(tx, holds),
        (tx) => readOutboxRowIn(tx, row),
        (tx) => readFixedLineFactsIn(tx, row),
      ];
      for (const read of scoped) {
        await expect(withBusiness(job, YOGA, read)).rejects.toThrow(BusinessScopeError);
        await expect(inRuntimeTransaction(job, { readOnly: true }, read)).rejects.toThrow(BusinessScopeError);
      }
      const unscoped: ((tx: Db) => Promise<unknown>)[] = [
        (tx) => readOpenHoldsIn(tx, { ...holds, businessId: null }),
        (tx) => readOutboxRowIn(tx, { ...row, businessId: null }),
        (tx) => readFixedLineFactsIn(tx, { ...row, businessId: null }),
      ];
      for (const read of unscoped) {
        await expect(withBusiness(job, BARBERSHOP, read)).rejects.toThrow(
          "with no business runs on the runtime side",
        );
      }
    },
  );

  it(
    "readOutboxRow and readFixedLineFacts read runtime-only tables, so on rosie_app they are refused by privilege (42501)",
    SLOW,
    async () => {
      const exchange = await given("read-outbox-row-a7-03.json");
      const request = exchange.request as unknown as ReadOutboxRowRequest;
      await expect(readOutboxRow(app, request)).rejects.toMatchObject({ code: "42501" });
      await expect(readFixedLineFacts(app, request)).rejects.toMatchObject({ code: "42501" });
    },
  );

  it("the refused v1.3 requests are refused before any read, as the schema refuses them", SLOW, async () => {
    await reset();
    const noScope = readJson(
      new URL("invalid/refuse-open-holds-no-scope.json", ACCESS_DIR),
    ) as ReadOpenHoldsRequest;
    const callerHandle = readJson(
      new URL("invalid/refuse-fixed-line-facts-caller-handle.json", ACCESS_DIR),
    ) as ReadFixedLineFactsRequest;
    expect(schemaErrors("readOpenHolds.request", noScope)).not.toEqual([]);
    expect(schemaErrors("readFixedLineFacts.request", callerHandle)).not.toEqual([]);
    await expect(readOpenHolds(app, noScope)).rejects.toThrow("readOpenHolds: the request needs businessId");
    await expect(readFixedLineFacts(job, callerHandle)).rejects.toThrow(
      "readFixedLineFacts: the request takes only outboxRowId, businessId",
    );
    const valid: ReadOpenHoldsRequest = { handleId: "handle-alex", businessId: BARBERSHOP, eventIds: [] };
    const refused: [unknown, string][] = [
      [{ ...valid, extra: true }, "the request takes only handleId, businessId, eventIds"],
      [{ ...valid, handleId: "" }, "handleId is a non-empty id"],
      [{ ...valid, eventIds: "evt-alex-0231" }, "eventIds is a list"],
      [{ ...valid, eventIds: [""] }, "each of eventIds is a non-empty id"],
    ];
    for (const [request, message] of refused) {
      await expect(readOpenHolds(app, request as ReadOpenHoldsRequest), message).rejects.toThrow(message);
    }
    await expect(
      readOutboxRow(job, { businessId: BARBERSHOP } as unknown as ReadOutboxRowRequest),
    ).rejects.toThrow("readOutboxRow: the request needs outboxRowId");
  });

  it("with no clock given, readAt is the database's now, in UTC", SLOW, async () => {
    const exchange = await given("read-open-holds-s1-02.json");
    const before = Date.now();
    const holds = asHolds(await readOpenHolds(app, exchange.request as unknown as ReadOpenHoldsRequest));
    expect(Math.abs(Date.parse(holds.readAt) - before)).toBeLessThan(60_000);
    expect(holds.readAt.endsWith("Z")).toBe(true);
    expect(outcomeErrors("readOpenHolds", holds)).toEqual([]);
  });
});

describe("a reader's open questions are read through the handle's rows, newest first (DL-326 note 2)", () => {
  const S1_02: ReadOutboxRowRequest = { outboxRowId: "outbox-s1-02-sam-1", businessId: BARBERSHOP };
  let exchange: Exchange;

  /** K-07's row state beside its one part's state. */
  const ROW_STATE_OF_PART: Readonly<Record<string, string>> = {
    pending: "sending",
    sent: "sent",
    delivered: "delivered",
    failed: "sending",
  };

  /** One row to Sam at the barbershop from turn-s1-01-sam asking `question`, with its words and its one part. */
  async function rowToSam(id: string, question: string, text: string, part: string): Promise<void> {
    await insertRow(db.sql, "outbox_rows", {
      id,
      turn_id: "turn-s1-01-sam",
      recipient_handle_id: "handle-sam",
      recipient_person_id: "person-sam",
      business_id: BARBERSHOP,
      channel: "imessage",
      versions_read: [],
      open_question_id: question,
      final_parts: wordsParts(id, text),
      state: ROW_STATE_OF_PART[part] ?? "planned",
      bundle_hash: BUNDLE_HASH,
      bundle_build: 1,
      trace_id: "trace-sam-0000",
    });
    await insertRow(db.sql, "outbox_parts", {
      outbox_row_id: id,
      part_no: 1,
      try_no: 1,
      idempotency_key: `${id}/1/1`,
      kind: "words",
      state: part,
      sent_at: part === "pending" ? null : "2026-10-19T18:06:00Z",
      delivered_at: part === "delivered" ? "2026-10-19T18:06:01Z" : null,
      failed_at: part === "failed" ? "2026-10-19T18:06:01Z" : null,
    });
  }

  /**
   * `perHandle` delivered rows that ask nothing to each of `handles`, each with its delivered words part, after every row
   * so far: to Sam, or to other numbers in the 555-01xx range, so the table holds many handles' rows, as it will.
   */
  async function rowsTo(prefix: string, handles: readonly string[], perHandle: number): Promise<void> {
    await db.sql`
      insert into outbox_rows (id, turn_id, recipient_handle_id, recipient_person_id, business_id, channel, versions_read,
                               state, bundle_hash, bundle_build, trace_id)
      select ${prefix}::text || h || '-' || n::text, 'turn-s1-01-sam', h, null, ${BARBERSHOP}, 'imessage', '[]'::jsonb,
             'delivered', ${BUNDLE_HASH}, 1, 'trace-sam-0000'
      from unnest(${handles}::text[]) as h, generate_series(1, ${perHandle}::integer) as n
    `;
    await db.sql`
      insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, kind, state, sent_at, delivered_at)
      select ${prefix}::text || h || '-' || n::text, 1, 1, ${prefix}::text || h || '-' || n::text || '/1/1', 'words',
             'delivered', '2026-10-19T18:06:00Z', '2026-10-19T18:06:01Z'
      from unnest(${handles}::text[]) as h, generate_series(1, ${perHandle}::integer) as n
    `;
  }

  const OTHERS = Array.from({ length: 20 }, (_, n) => `handle-other-${String(10 + n)}`);

  beforeAll(async () => {
    exchange = await given("read-outbox-row-s1-02.json");
    await db.sql`
      insert into handles (id, kind, address)
      select h, 'phone', '+155555501' || substr(h, length('handle-other-') + 1) from unnest(${OTHERS}::text[]) as h
    `;
    for (const [id, step] of [
      ["oq-s1-03-sam", "S1-03"],
      ["oq-s1-04-sam", "S1-04"],
    ] as const) {
      await insertRow(db.sql, "open_questions", {
        id,
        turn_id: "turn-s1-01-sam",
        handle_id: "handle-sam",
        person_id: "person-sam",
        business_id: BARBERSHOP,
        step,
        options: [],
        versions_read: [],
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        status: "open",
      });
    }
    // S1-04's only asking row never went: the scan for it walks every row to Sam (the read's worst case).
    await rowToSam("out-s1-04-sam-1", "oq-s1-04-sam", "Words that never went", "pending");
    await rowToSam("out-s1-03-sam-1", "oq-s1-03-sam", "First words", "delivered");
    await rowsTo("out-before-", ["handle-sam"], 3000);
    await rowToSam("out-s1-03-sam-2", "oq-s1-03-sam", "Newest words that went", "sent");
    await rowsTo("out-after-", ["handle-sam"], 2000);
    await rowToSam("out-s1-03-sam-3", "oq-s1-03-sam", "Words still pending", "pending");
    await rowToSam("out-s1-03-sam-4", "oq-s1-03-sam", "Words that failed", "failed");
    // Twenty other handles' 20,000 rows, the newest of all, so a scan in commit order alone would meet them first.
    await rowsTo("out-other-", OTHERS, 1000);
    await db.sql`analyze outbox_rows, outbox_parts`;
  }, 60_000);

  it(
    "of 5,000 rows to Sam among 25,000, the words come from the newest asking row that has gone: never a pending or failed one, never an older one; a question that never went is not listed",
    SLOW,
    async () => {
      const row = asRow(await readOutboxRow(job, S1_02, nowOf(exchange)));
      expect(row.openQuestions).toEqual([
        { id: "oq-s1-03-sam", step: "S1-03", text: "Newest words that went" },
      ]);
      expect(outcomeErrors("readOutboxRow", row)).toEqual([]);
    },
  );

  it("twenty reads of that row in a row, each the same answer", SLOW, async () => {
    const first = await readOutboxRow(job, S1_02, nowOf(exchange));
    for (let round = 0; round < 20; round += 1) {
      expect(await readOutboxRow(job, S1_02, nowOf(exchange))).toEqual(first);
    }
  });
});
