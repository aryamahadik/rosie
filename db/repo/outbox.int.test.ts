// T-196: K-05 v1 items 2 to 4, write a plan, list the rows a crash left unplanned, claim outbox rows in commit order
// and move a row's parts, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/outbox`). The
// schema comes from migrating a fresh test schema (db/repo/test-db.ts); the public schema is never touched. T-1251: the
// schema is in a database of this file's own, because the claim's recipient lock is an advisory lock, which PostgreSQL
// keeps per database: a run sharing the database claimed the same fixture recipient at the same moment, and the claim
// here skipped it. Its last test shows that a recipient's lock held in the shared database is not seen here, and held
// in this file's database is.
//
// Every call runs as K-05 states it (README "Scope": runtime; T-191's roles): through a client whose connections run as
// rosie_job with no business scope. The tables' owner (the migrations' role) loads K-04's seeds and the rows a test adds
// for itself: an outbox row as a commit writes it (planned, no plan) and, for the parallel claim, its recipients' handles
// and its rows already checked.
//
// A fixture's `given.after` names the exchanges that run first, each compared with its own outcome: commitTurn (T-195)
// and reserve (T-187) for real, with the saved-time clock row K-05 item 8 says reserve makes (reservations.ts writes
// none), and this task's calls for real.
//
// Each answer is checked against data-access v1 with Ajv 2020-12, strict, as contracts:check runs it; a wrongState
// answer, which K-05 v1.1 adds, against v1.1.
//
// T-1135 adds the v1.2 outbox calls' tests at the end of this file (K-05 v1.1 items 13 to 16, v1.2 items 30 to 32): the
// v1 tests above run unchanged.
//
// T-1227 adds, after them, the tests of K-05 v1.9 item 48: markPartV12's answer says what a repeated delivery receipt
// repeats (repeatedDelivery). T-1135's tests run unchanged: its helpers now check markPartV12's answers against v1.9.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { armClock, type ArmClockRequest } from "./clocks";
import { resolvePrimaryUrl } from "./client";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import {
  claimOutbox,
  claimOutboxV12,
  type ClaimedRowV12,
  type ClaimOutboxRequest,
  type ClaimOutboxResponse,
  type ClaimOutboxV12Response,
  markPart,
  type MarkPartOutcome,
  type MarkPartRequest,
  markPartV12,
  type MarkPartV12Outcome,
  type MarkPartV12Request,
  markRow,
  type MarkRowOutcome,
  type MarkRowRequest,
  markRowV12,
  type MarkRowV12Outcome,
  type MarkRowV12Request,
  type Move,
  PART_MOVES,
  renewClaim,
  type RenewClaimOutcome,
  type RenewClaimRequest,
  ROW_MOVES,
  unplannedRows,
  type UnplannedRowsOutcome,
  writePlan,
  type WritePlanOutcome,
  type WritePlanRequest,
} from "./outbox";
import { reserve, type ReserveRequest } from "./reservations";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };
const PARALLEL = { timeout: 240_000 };
/** K-01's bundle-v0-skeleton id, the bundle K-04's seed-bundle-registry registers. */
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const OUTBOX_CALLS = ["writePlan", "unplannedRows", "claimOutbox", "markPart", "markRow"];
/** The fixtures the card names (T-196 "Reads"). */
const CARD_FIXTURES = [
  "write-plan.json",
  "claim-in-order.json",
  "claim-held-lets-later-pass.json",
  "mark-delivered.json",
];

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

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
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
/** K-05 v1's accepted exchanges of this task's five calls. */
const OUTBOX_FIXTURES = INDEX.filter(
  (entry) =>
    entry.version === "v1" &&
    entry.expect === "accept" &&
    OUTBOX_CALLS.some((call) => entry.def === `${call}.exchange`),
).map((entry) => entry.file);

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
const schemaId = (file: string): string => (readJson(new URL(file, CONTRACTS)) as { $id: string }).$id;
const V1_ID = schemaId("data-access/data-access.v1.schema.json");
const V11_ID = schemaId("data-access/data-access.v1.1.schema.json");

/** Checks `value` against one $defs entry of a data-access version, returning Ajv's errors (none when it passes). */
function schemaErrors(id: string, def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${id}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${id} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer against its call's definition: data-access v1, or v1.1 for wrongState, which v1.1 adds. */
function answerErrors(call: string, outcome: unknown): string[] {
  const error = isRecord(outcome) ? outcome.error : undefined;
  if (error === undefined) {
    return schemaErrors(V1_ID, `${call}.response`, outcome);
  }
  return schemaErrors(error === "wrongState" ? V11_ID : V1_ID, `${call}.errors`, outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

beforeAll(async () => {
  db = await createTestDatabase({ name: "outbox", database: "own" });
  runtime = db.connect({
    max: 20,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t196-outbox",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

// A resource guard, not part of any test's claim (T-1251): the drop is a DROP DATABASE, whose checkpoint ran past the
// 30 s hook limit while other suites loaded the build Mac.
afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
}, 120_000);

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

function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

async function loadSeeds(seeds: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** A fixture's chain: the K-04 seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: string[]; steps: string[] } {
  const exchange = exchangeOf(file);
  if (exchange.given.partSeeds !== undefined && exchange.given.partSeeds.length > 0) {
    throw new Error(`${file}: partSeeds are not loaded by this test`);
  }
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

/** The saved-time clock row K-05 item 8 gives a held row: armed at `at`, due at its end in its business's zone. */
async function savedTimeClock(reservationId: string, heldUntil: string, at: string): Promise<void> {
  const [row] = await db.sql<
    { business_id: string; booking_id: string | null; handle_id: string | null; zone: string }[]
  >`
    select r.business_id, r.booking_id, p.handle_id, b.time_zone as zone
    from reservations r
    join businesses b on b.id = r.business_id
    left join phones p on p.number = r.for_phone_number
    where r.id = ${reservationId}
  `;
  if (row === undefined) {
    throw new Error("savedTimeClock: no such reservation");
  }
  await insertRow(db.sql, "clock_rows", {
    id: `${reservationId}/saved-time`,
    kind: "saved_time",
    reservation_id: reservationId,
    handle_id: row.handle_id,
    business_id: row.business_id,
    booking_id: row.booking_id,
    due_at: heldUntil,
    due_zone: row.zone,
    state: "armed",
    armed_at: at,
    fires: { release: reservationId, why: "expired" },
  });
}

/** Runs one exchange's request: this task's calls, commitTurn and reserve, each for real. */
async function runExchange(exchange: Exchange): Promise<unknown> {
  const request: unknown = structuredClone(exchange.request);
  switch (exchange.call) {
    case "writePlan":
      return writePlan(runtime, request as WritePlanRequest);
    case "unplannedRows":
      return unplannedRows(runtime, request as { turnId: string });
    case "claimOutbox":
      return claimOutbox(runtime, request as ClaimOutboxRequest);
    case "markPart":
      return markPart(runtime, request as MarkPartRequest);
    case "markRow":
      return markRow(runtime, request as MarkRowRequest);
    case "commitTurn":
      return commitTurn(runtime, request as CommitTurnRequest, { now: new Date(exchange.given.now) });
    case "reserve": {
      const reserveRequest = request as ReserveRequest;
      const outcome = await reserve(db.sql, reserveRequest);
      if ("result" in outcome && outcome.result === "held") {
        await savedTimeClock(outcome.reservationId, outcome.heldUntil, reserveRequest.at);
      }
      return outcome;
    }
    default:
      throw new Error(`this test runs no ${exchange.call} step`);
  }
}

/** Loads a fixture's seeds and runs its chain, each step's answer its fixture's outcome. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    expect(await runExchange(before), step).toEqual(before.outcome);
  }
  return exchange;
}

/** Runs a fixture's own request after its chain, its answer its outcome. */
async function ran(file: string): Promise<void> {
  const exchange = await given(file);
  expect(await runExchange(exchange), file).toEqual(exchange.outcome);
}

// ---- the calls, each answer checked against the contract ------------------------------------------------------------

async function claim(request: ClaimOutboxRequest): Promise<ClaimOutboxResponse> {
  const outcome = await claimOutbox(runtime, request);
  expect(answerErrors("claimOutbox", outcome)).toEqual([]);
  if ("error" in outcome) {
    throw new Error(`claimOutbox answered ${outcome.error}`);
  }
  return outcome;
}

async function mark(request: MarkPartRequest): Promise<MarkPartOutcome> {
  const outcome = await markPart(runtime, request);
  expect(answerErrors("markPart", outcome)).toEqual([]);
  return outcome;
}

async function limit8(request: MarkRowRequest): Promise<MarkRowOutcome> {
  const outcome = await markRow(runtime, request);
  expect(answerErrors("markRow", outcome)).toEqual([]);
  return outcome;
}

async function plan(request: WritePlanRequest): Promise<WritePlanOutcome> {
  const outcome = await writePlan(runtime, request);
  expect(answerErrors("writePlan", outcome)).toEqual([]);
  return outcome;
}

async function unplanned(turnId: string): Promise<UnplannedRowsOutcome> {
  const outcome = await unplannedRows(runtime, { turnId });
  expect(answerErrors("unplannedRows", outcome)).toEqual([]);
  return outcome;
}

// ---- rows a test adds, and what the outbox holds --------------------------------------------------------------------

const WORDS: Json = {
  kind: "words",
  text: "Your visit is confirmed.",
  calendarFile: "none",
  options: [],
  link: null,
};
const POLL: Json = {
  kind: "poll",
  text: null,
  calendarFile: "none",
  options: [
    { id: "opt-1", label: "Sat 12:00pm" },
    { id: "opt-2", label: "Sat 2:00pm" },
  ],
  link: null,
};
const PLAN_BODY: Json = {
  formats: ["text"],
  lines: [{ role: "first", text: "Your visit is confirmed." }],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

/** A writePlan request for one of these test rows (K-03 rowPlan and finalParts of that row). */
function planRequest(id: string, expectVersion: number, sends: Json[]): WritePlanRequest {
  const request: Json = {
    outboxRowId: id,
    expectVersion,
    plan: { row: id, channel: "imessage", copyOf: null, plan: PLAN_BODY },
    finalParts: { row: id, channel: "imessage", sends, fixedLines: [], slotValues: [], threadReplyTo: null },
  };
  return request as unknown as WritePlanRequest;
}

/**
 * An outbox row as a commit writes it (planned, no plan), as the owner, under a turn its chain committed:
 * commit-first.json's by default.
 */
async function addRow(
  id: string,
  recipientHandleId: string,
  turn = { id: "turn-alex-book-1", traceId: "trace-alex-0012" },
): Promise<void> {
  await insertRow(db.sql, "outbox_rows", {
    id,
    turn_id: turn.id,
    recipient_handle_id: recipientHandleId,
    business_id: "biz-lees-barbershop",
    channel: "imessage",
    send_class: "routine",
    versions_read: [],
    bundle_hash: BUNDLE_HASH,
    bundle_build: 1,
    trace_id: turn.traceId,
  });
}

/** A test row planned with these sends and claimed by its recipient's own claim: its claimed row. */
async function claimedRow(id: string, recipientHandleId: string, sends: Json[], now: string) {
  await addRow(id, recipientHandleId);
  expect(await plan(planRequest(id, 1, sends))).toEqual({ result: "written", outboxRowId: id, version: 2 });
  const answer = await claim({ claimer: "dispatcher-1", recipientHandleId, now, limit: 10 });
  const [row] = answer.claimed;
  if (row === undefined || answer.claimed.length !== 1 || row.outboxRowId !== id) {
    throw new Error("the test row is its recipient's one claimed row");
  }
  return row;
}

async function rowNow(id: string): Promise<{ state: string; version: number; held_until: Date | null }> {
  const [row] = await db.sql<{ state: string; version: number; held_until: Date | null }[]>`
    select state, version, held_until from outbox_rows where id = ${id}
  `;
  if (row === undefined) {
    throw new Error("no such outbox row");
  }
  return row;
}

async function partsNow(rowId: string): Promise<Record<string, unknown>[]> {
  return [
    ...(await db.sql<Record<string, unknown>[]>`
      select idempotency_key, kind, state, attempts, linq_message_id, linq_option_ids, error_code,
             sent_at is not null as sent, delivered_at is not null as delivered, failed_at is not null as failed
      from outbox_parts where outbox_row_id = ${rowId}
      order by part_no, try_no
    `),
  ];
}

/** Everything the outbox holds: equal before and after = nothing was written. */
async function outboxNow(): Promise<unknown> {
  const rows = await db.sql`
    select id, state, version, held_until, plan, final_parts from outbox_rows order by id collate "C"
  `;
  const parts = await db.sql`
    select idempotency_key, kind, state, attempts, linq_message_id, linq_option_ids, sent_at, delivered_at, failed_at,
           error_code, version
    from outbox_parts order by idempotency_key collate "C"
  `;
  return { rows: [...rows], parts: [...parts] };
}

function marked(outcome: MarkPartOutcome) {
  if (!("result" in outcome)) {
    throw new Error(`markPart answered ${outcome.error}`);
  }
  return outcome;
}

// ---- K-05 v1's fixtures ---------------------------------------------------------------------------------------------

describe("K-05 v1's outbox fixtures: each request gives its response", () => {
  it("covers the four fixtures the card names, among K-05 v1's twelve exchanges of these calls", () => {
    expect(OUTBOX_FIXTURES).toEqual(expect.arrayContaining(CARD_FIXTURES));
    expect(OUTBOX_FIXTURES).toHaveLength(12);
  });

  for (const file of OUTBOX_FIXTURES) {
    it(file, SLOW, async () => {
      const exchange = await given(file);
      const outcome = await runExchange(exchange);
      expect(outcome).toEqual(exchange.outcome);
      expect(answerErrors(exchange.call, outcome)).toEqual([]);
    });
  }

  it(
    "refuse-mark-held-without-time.json: held with no time is refused, and nothing is written",
    SLOW,
    async () => {
      await given("mark-held-for-text-hours.json");
      const request = readJson(
        new URL("invalid/refuse-mark-held-without-time.json", ACCESS_DIR),
      ) as MarkRowRequest;
      expect(schemaErrors(V1_ID, "markRow.request", request)).not.toEqual([]);
      const before = await outboxNow();
      await expect(markRow(runtime, request)).rejects.toThrow(TypeError);
      expect(await outboxNow()).toEqual(before);
      expect(await rowNow("out-sam-passon-evening")).toMatchObject({ state: "sending", version: 3 });
    },
  );
});

// ---- K-07 v1's moves ------------------------------------------------------------------------------------------------

interface MoveBranch {
  properties: Record<"from" | "to" | "by", { const?: string; enum?: string[]; type?: string }>;
}

/** Every (from, to, by) a K-07 move definition allows, each branch's enums spread out. */
function k07Moves(def: "rowMove" | "partMove"): string[] {
  const schema = readJson(new URL("outbox-effects/outbox-effects.v1.schema.json", CONTRACTS)) as {
    $defs: Record<string, { anyOf: MoveBranch[] }>;
  };
  const branches = schema.$defs[def]?.anyOf ?? [];
  const values = (prop: MoveBranch["properties"]["from"]): (string | null)[] => {
    if (prop.type === "null") {
      return [null];
    }
    if (prop.const !== undefined) {
      return [prop.const];
    }
    if (prop.enum !== undefined) {
      return prop.enum;
    }
    throw new Error(`${def}: a branch names no value`);
  };
  return branches.flatMap((branch) =>
    values(branch.properties.from).flatMap((from) =>
      values(branch.properties.to).flatMap((to) =>
        values(branch.properties.by).map((by) => `${from ?? "(new)"} -> ${to ?? ""} by ${by ?? ""}`),
      ),
    ),
  );
}

const named = (moves: readonly Move<string>[]): string[] =>
  moves.map((move) => `${move.from ?? "(new)"} -> ${move.to} by ${move.by}`);

describe("K-07 v1's allowed moves", () => {
  it("the row moves and part moves every call checks are K-07's lists, word for word", () => {
    expect(k07Moves("rowMove")).toHaveLength(18);
    expect([...named(ROW_MOVES)].sort()).toEqual([...k07Moves("rowMove")].sort());
    expect(k07Moves("partMove")).toHaveLength(9);
    expect([...named(PART_MOVES)].sort()).toEqual([...k07Moves("partMove")].sort());
  });
});

// ---- claimOutbox --------------------------------------------------------------------------------------------------

const RECIPIENTS = 25;
const ROWS = 1000;
const CLAIMERS = 20;
const handleOf = (n: number): string => `handle-par-${String(n).padStart(2, "0")}`;

/** 1,000 checked rows over 25 recipients, commit_seq interleaving the recipients; every third row has two parts. */
async function parallelRows(): Promise<void> {
  await reset();
  await loadSeeds(["seed-bundle-registry.json"]);
  await db.sql.begin(async (tx) => {
    for (let n = 0; n < RECIPIENTS; n += 1) {
      await insertRow(tx, "handles", {
        id: handleOf(n),
        kind: "phone",
        address: `+1555555${String(150 + n).padStart(4, "0")}`,
      });
    }
    await tx`
      insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
      values ('turn-par', ${handleOf(0)}, ${["evt-par-1"]}, 'committed', ${BUNDLE_HASH}, 1, 'trace-par',
              '2026-11-09T14:59:00Z')
    `;
    await tx`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, channel, send_class, versions_read, plan, final_parts, state,
        bundle_hash, bundle_build, trace_id
      )
      select
        'out-par-' || lpad(g::text, 4, '0'),
        'turn-par',
        'handle-par-' || lpad(((g * 7) % ${RECIPIENTS})::text, 2, '0'),
        'imessage',
        'routine',
        '[]'::jsonb,
        jsonb_build_object(
          'row', 'out-par-' || lpad(g::text, 4, '0'), 'channel', 'imessage', 'copyOf', null,
          'plan', ${tx.json(PLAN_BODY)}::jsonb
        ),
        jsonb_build_object(
          'row', 'out-par-' || lpad(g::text, 4, '0'), 'channel', 'imessage',
          'sends', case when g % 3 = 0 then ${tx.json([WORDS, POLL])}::jsonb else ${tx.json([WORDS])}::jsonb end,
          'fixedLines', '[]'::jsonb, 'slotValues', '[]'::jsonb, 'threadReplyTo', null
        ),
        'checked',
        ${BUNDLE_HASH},
        1,
        'trace-par'
      from generate_series(0, ${ROWS - 1}) as g
      order by g
    `;
  });
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A call answered again while it answers transient (nothing was written: K-05), as the dispatcher repeats it. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  let answer = await call();
  for (let tries = 1; tries < 10 && isRecord(answer) && answer.error === "transient"; tries += 1) {
    answer = await call();
  }
  return answer;
}

describe("claimOutbox: each recipient's rows in commit order, each row to one sender", () => {
  it(
    "20 parallel claimers over 1,000 rows: every row is claimed exactly once and each recipient's rows come out in " +
      "commit order",
    PARALLEL,
    async () => {
      await parallelRows();
      const now = "2026-11-09T15:00:00Z";
      const log: { rowId: string; recipient: string; commitSeq: number; claimer: number }[] = [];
      const unfinished = async (): Promise<number> => {
        const [row] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from outbox_rows where state in ('checked', 'sending')
        `;
        return row?.n ?? -1;
      };

      // Each claimer is a dispatcher: claim, record the claim at once, then send every part (markPart sent), so the
      // recipient's next rows become sendable only after these finish.
      const dispatcher = async (claimer: number): Promise<void> => {
        for (let round = 0; round < 5000; round += 1) {
          const answer = await settled(() =>
            claimOutbox(runtime, { claimer: `dispatcher-${String(claimer)}`, now, limit: 7 }),
          );
          if ("error" in answer) {
            throw new Error(`claimOutbox answered ${answer.error} ten times`);
          }
          if (answer.claimed.length === 0) {
            if ((await unfinished()) === 0) {
              return;
            }
            await pause(5);
            continue;
          }
          for (const row of answer.claimed) {
            log.push({
              rowId: row.outboxRowId,
              recipient: row.recipientHandleId,
              commitSeq: row.commitSeq,
              claimer,
            });
          }
          for (const row of answer.claimed) {
            for (const part of row.parts) {
              const sent = await settled(() =>
                markPart(runtime, {
                  outcome: "sent",
                  idempotencyKey: part.idempotencyKey,
                  providerMessageId: `linq-par-${part.idempotencyKey}`,
                  providerOptionIds: null,
                  at: now,
                }),
              );
              expect(sent).toMatchObject({ result: "marked", repeated: false });
            }
          }
        }
        throw new Error("a claimer did not finish in 5,000 rounds");
      };
      await Promise.all(Array.from({ length: CLAIMERS }, (_, claimer) => dispatcher(claimer)));

      // Exactly once: 1,000 claims of 1,000 distinct rows, and no part handed out twice (a second claim of a row would
      // raise its parts' attempts).
      expect(log).toHaveLength(ROWS);
      expect(new Set(log.map((entry) => entry.rowId)).size).toBe(ROWS);
      expect(new Set(log.map((entry) => entry.claimer)).size).toBeGreaterThan(1);
      const parts = await db.sql<{ n: number; attempts: number; pending: number }[]>`
        select count(*)::int as n, max(attempts)::int as attempts,
               count(*) filter (where state <> 'sent')::int as pending
        from outbox_parts
      `;
      expect(parts[0]).toEqual({ n: ROWS + Math.ceil(ROWS / 3), attempts: 1, pending: 0 });
      const states = await db.sql<{ state: string; n: number }[]>`
        select state, count(*)::int as n from outbox_rows group by state
      `;
      expect([...states]).toEqual([{ state: "sent", n: ROWS }]);

      // Commit order: each recipient's claims are its rows, all of them, in commit_seq order.
      const stored = await db.sql<{ recipient_handle_id: string; commit_seq: string }[]>`
        select recipient_handle_id, commit_seq from outbox_rows order by commit_seq
      `;
      for (let n = 0; n < RECIPIENTS; n += 1) {
        const recipient = handleOf(n);
        const claimed = log.filter((entry) => entry.recipient === recipient).map((entry) => entry.commitSeq);
        const committed = stored
          .filter((row) => row.recipient_handle_id === recipient)
          .map((row) => Number(row.commit_seq));
        expect(committed).toHaveLength(ROWS / RECIPIENTS);
        expect(claimed, recipient).toEqual(committed);
      }
    },
  );

  it(
    "takes recipients earliest commit first, at most `limit` rows, and stops at a row claimed and not finished",
    SLOW,
    async () => {
      await given("claim-in-order.json");
      const now = "2026-11-07T15:06:35Z";
      const first = await claim({ claimer: "dispatcher-1", now, limit: 1 });
      expect(first.claimed.map((row) => row.outboxRowId)).toEqual(["out-alex-booked-riley"]);
      // Alex's next row waits behind his sending row; Sam's goes to the next claim.
      await addRow("out-alex-second", "handle-alex");
      expect(await plan(planRequest("out-alex-second", 1, [WORDS]))).toMatchObject({ result: "written" });
      const second = await claim({ claimer: "dispatcher-2", now, limit: 10 });
      expect(second.claimed.map((row) => row.outboxRowId)).toEqual(["out-sam-booked-riley"]);
      expect(
        await claim({ claimer: "dispatcher-2", recipientHandleId: "handle-alex", now, limit: 10 }),
      ).toEqual({
        result: "claimed",
        claimed: [],
        passedHeld: [],
      });
      // Once Alex's first row is sent, his next one goes.
      expect(
        marked(
          await mark({
            outcome: "sent",
            idempotencyKey: "out-alex-booked-riley/1/1",
            providerMessageId: "linq-test-0001",
            providerOptionIds: null,
            at: now,
          }),
        ),
      ).toMatchObject({ repeated: false });
      const third = await claim({ claimer: "dispatcher-2", now, limit: 10 });
      expect(third.claimed.map((row) => row.outboxRowId)).toEqual(["out-alex-second"]);
    },
  );
});

describe("a row held for text hours lets that recipient's later rows pass (arch 02 line 125, DD)", () => {
  it("later rows pass it in commit order, and it is claimed again once its time passes", SLOW, async () => {
    await ran("claim-held-lets-later-pass.json");
    // A third row for Sam, after the quick reply: it waits behind the reply (sending), not behind the held row.
    await addRow("out-sam-third", "handle-sam", { id: "turn-sam-evening-1", traceId: "trace-sam-0031" });
    expect(await plan(planRequest("out-sam-third", 1, [WORDS]))).toMatchObject({ result: "written" });
    const evening = "2026-11-08T01:32:00Z";
    expect(
      await claim({ claimer: "dispatcher-2", recipientHandleId: "handle-sam", now: evening, limit: 10 }),
    ).toEqual({
      result: "claimed",
      claimed: [],
      passedHeld: [{ outboxRowId: "out-sam-passon-evening", heldUntil: "2026-11-08T13:00:00Z" }],
    });
    marked(
      await mark({
        outcome: "sent",
        idempotencyKey: "out-sam-reply-evening/1/1",
        providerMessageId: "linq-test-0031",
        providerOptionIds: null,
        at: evening,
      }),
    );
    const later = await claim({
      claimer: "dispatcher-2",
      recipientHandleId: "handle-sam",
      now: evening,
      limit: 10,
    });
    expect(later.claimed.map((row) => row.outboxRowId)).toEqual(["out-sam-third"]);
    expect(later.passedHeld).toEqual([
      { outboxRowId: "out-sam-passon-evening", heldUntil: "2026-11-08T13:00:00Z" },
    ]);
    marked(
      await mark({
        outcome: "sent",
        idempotencyKey: "out-sam-third/1/1",
        providerMessageId: "linq-test-0032",
        providerOptionIds: null,
        at: evening,
      }),
    );

    // A minute before 8am in New York the sweep leaves it; at 8am it is claimed again, its part under its stored key.
    expect(await claim({ claimer: "dispatcher-3", now: "2026-11-08T12:59:59Z", limit: 10 })).toEqual({
      result: "claimed",
      claimed: [],
      passedHeld: [],
    });
    const morning = await claim({ claimer: "dispatcher-3", now: "2026-11-08T13:00:05Z", limit: 10 });
    expect(morning.passedHeld).toEqual([]);
    expect(morning.claimed).toHaveLength(1);
    expect(morning.claimed[0]).toMatchObject({
      outboxRowId: "out-sam-passon-evening",
      version: 5,
      commitSeq: 1,
      parts: [
        {
          partNo: 1,
          tryNo: 1,
          idempotencyKey: "out-sam-passon-evening/1/1",
          attempts: 2,
          sent: false,
        },
      ],
    });
    expect(await rowNow("out-sam-passon-evening")).toEqual({
      state: "sending",
      version: 5,
      held_until: new Date("2026-11-08T13:00:00Z"),
    });
  });
});

// ---- moves K-07 does not allow ----------------------------------------------------------------------------------------

describe("a move K-07 v1 does not allow is refused, and nothing is written", () => {
  it("a delivered row never goes back to sending, and no mark moves it", SLOW, async () => {
    await ran("mark-delivered.json");
    const id = "out-alex-booked-riley";
    const key = "out-alex-booked-riley/1/1";
    const at = "2026-11-07T15:06:40Z";
    expect(await rowNow(id)).toMatchObject({ state: "delivered", version: 5 });
    const before = await outboxNow();

    expect(
      await claim({ claimer: "dispatcher-2", recipientHandleId: "handle-alex", now: at, limit: 10 }),
    ).toEqual({
      result: "claimed",
      claimed: [],
      passedHeld: [],
    });
    for (const outcome of ["held", "droppedStopped", "stale", "withdrawn"] as const) {
      expect(
        await limit8({
          outboxRowId: id,
          expectVersion: 5,
          outcome,
          heldUntil: outcome === "held" ? "2026-11-08T14:00:00Z" : null,
          at,
        }),
      ).toEqual({ error: "wrongState", table: "outbox_rows", rowId: id, state: "delivered" });
    }
    expect(await mark({ outcome: "attempt", idempotencyKey: key, at })).toEqual({
      error: "wrongState",
      table: "outbox_parts",
      rowId: key,
      state: "delivered",
    });
    expect(
      await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4001", retry: true, at }),
    ).toEqual({
      error: "wrongState",
      table: "outbox_parts",
      rowId: key,
      state: "delivered",
    });
    // A second sent and a second receipt are repeats: they change nothing.
    expect(
      await mark({
        outcome: "sent",
        idempotencyKey: key,
        providerMessageId: "linq-msg-demo-0101",
        providerOptionIds: null,
        at,
      }),
    ).toMatchObject({ result: "marked", repeated: true, firstDelivery: false, nextKey: null });
    expect(await mark({ outcome: "delivered", providerMessageId: "linq-msg-demo-0101", at })).toMatchObject({
      result: "marked",
      repeated: true,
      firstDelivery: false,
    });
    const again = exchangeOf("write-plan.json").request as unknown as WritePlanRequest;
    expect(await plan({ ...again, expectVersion: 5 })).toEqual({
      error: "alreadyPlanned",
      outboxRowId: id,
      version: 5,
    });
    expect(await outboxNow()).toEqual(before);
  });

  it("nothing moves out of dropped_stopped: no claim, no limit-8 outcome, no part mark", SLOW, async () => {
    await given("claim-in-order.json");
    const id = "out-riley-two";
    const now = "2026-11-07T15:07:00Z";
    const row = await claimedRow(id, "handle-riley", [WORDS, POLL], now);
    expect(row).toMatchObject({ version: 3, parts: [{ attempts: 1 }, { attempts: 1 }] });
    // The words go; then a STOP drops the row before the poll (limit 8 at the second send: arch 06 line 313).
    marked(
      await mark({
        outcome: "sent",
        idempotencyKey: `${id}/1/1`,
        providerMessageId: "linq-test-0201",
        providerOptionIds: null,
        at: now,
      }),
    );
    expect(
      await limit8({
        outboxRowId: id,
        expectVersion: 4,
        outcome: "droppedStopped",
        heldUntil: null,
        at: now,
      }),
    ).toEqual({ result: "marked", outboxRowId: id, version: 5, outcome: "droppedStopped" });
    const before = await outboxNow();

    const dropped = { error: "wrongState", table: "outbox_rows", rowId: id, state: "dropped_stopped" };
    expect(await mark({ outcome: "delivered", providerMessageId: "linq-test-0201", at: now })).toEqual(
      dropped,
    );
    expect(
      await mark({
        outcome: "sent",
        idempotencyKey: `${id}/2/1`,
        providerMessageId: "linq-test-0202",
        providerOptionIds: ["linq-opt-1", "linq-opt-2"],
        at: now,
      }),
    ).toEqual(dropped);
    expect(await mark({ outcome: "attempt", idempotencyKey: `${id}/2/1`, at: now })).toEqual(dropped);
    expect(
      await mark({ outcome: "failed", idempotencyKey: `${id}/1/1`, errorCode: "4001", retry: true, at: now }),
    ).toEqual(dropped);
    expect(
      await mark({
        outcome: "failed",
        idempotencyKey: `${id}/2/1`,
        errorCode: "4001",
        retry: false,
        at: now,
      }),
    ).toEqual(dropped);
    for (const outcome of ["held", "droppedStopped", "stale", "withdrawn"] as const) {
      expect(
        await limit8({
          outboxRowId: id,
          expectVersion: 5,
          outcome,
          heldUntil: outcome === "held" ? "2026-11-08T14:00:00Z" : null,
          at: now,
        }),
      ).toEqual(dropped);
    }
    expect(
      await claim({ claimer: "dispatcher-2", recipientHandleId: "handle-riley", now, limit: 10 }),
    ).toEqual({
      result: "claimed",
      claimed: [],
      passedHeld: [],
    });
    expect(await plan(planRequest(id, 5, [WORDS]))).toEqual({
      error: "alreadyPlanned",
      outboxRowId: id,
      version: 5,
    });
    expect(await outboxNow()).toEqual(before);
    // The sweep claims the other recipients' checked rows and never this one.
    const sweep = await claim({ claimer: "dispatcher-3", now, limit: 10 });
    expect(sweep.claimed.map((one) => one.outboxRowId)).toEqual([
      "out-alex-booked-riley",
      "out-sam-booked-riley",
    ]);
    expect(await rowNow(id)).toMatchObject({ state: "dropped_stopped", version: 5 });
  });

  it("limit 8's outcomes start only from sending, compared and set on the row's version", SLOW, async () => {
    const exchange = await given("mark-held-for-text-hours.json");
    const request = exchange.request as unknown as MarkRowRequest;
    expect(await limit8({ ...request, expectVersion: 2 })).toEqual({
      error: "versionChanged",
      changed: [{ table: "outbox_rows", rowId: "out-sam-passon-evening", readVersion: 2, currentVersion: 3 }],
    });
    expect(await limit8(request)).toEqual(exchange.outcome);
    expect(await limit8({ ...request, expectVersion: 4 })).toEqual({
      error: "wrongState",
      table: "outbox_rows",
      rowId: "out-sam-passon-evening",
      state: "held",
    });
    expect(await limit8({ ...request, outboxRowId: "out-none" })).toEqual({
      error: "notFound",
      table: "outbox_rows",
      rowId: "out-none",
    });
    expect(await rowNow("out-sam-passon-evening")).toEqual({
      state: "held",
      version: 4,
      held_until: new Date("2026-11-08T13:00:00Z"),
    });
  });

  it("a part mark K-07's part moves do not list is refused", SLOW, async () => {
    await ran("mark-sent.json");
    const key = "out-sam-booked-riley/1/1";
    const at = "2026-11-07T15:06:36Z";
    expect(
      marked(await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4006", retry: false, at })),
    ).toMatchObject({ repeated: false, nextKey: null });
    const before = await outboxNow();
    const failed = { error: "wrongState", table: "outbox_parts", rowId: key, state: "failed" };
    expect(
      await mark({
        outcome: "sent",
        idempotencyKey: key,
        providerMessageId: "linq-test-0301",
        providerOptionIds: null,
        at,
      }),
    ).toEqual(failed);
    expect(await mark({ outcome: "attempt", idempotencyKey: key, at })).toEqual(failed);
    expect(await mark({ outcome: "delivered", providerMessageId: "linq-msg-none", at })).toEqual({
      error: "notFound",
      table: "outbox_parts",
      rowId: "linq-msg-none",
    });
    expect(await mark({ outcome: "attempt", idempotencyKey: "out-none/1/1", at })).toEqual({
      error: "notFound",
      table: "outbox_parts",
      rowId: "out-none/1/1",
    });
    expect(await outboxNow()).toEqual(before);
    expect(await rowNow("out-sam-booked-riley")).toMatchObject({ state: "sending", version: 4 });
  });
});

// ---- after a crash -------------------------------------------------------------------------------------------------

describe("after a crash, only rows without a plan are returned for composing (arch 11 line 576)", () => {
  it(
    "a stale row is listed again, composed again from today's record and claimed under its stored key",
    SLOW,
    async () => {
      await ran("claim-in-order.json");
      const id = "out-alex-booked-riley";
      const at = "2026-11-07T15:06:36Z";
      expect(await unplanned("turn-alex-book-1")).toEqual({ result: "rows", rows: [] });
      expect(
        await limit8({ outboxRowId: id, expectVersion: 3, outcome: "stale", heldUntil: null, at }),
      ).toEqual({
        result: "marked",
        outboxRowId: id,
        version: 4,
        outcome: "stale",
      });
      expect(await unplanned("turn-alex-book-1")).toEqual({
        result: "rows",
        rows: [
          {
            outboxRowId: id,
            version: 4,
            commitSeq: 1,
            recipientHandleId: "handle-alex",
            channel: "imessage",
            copyOfRowId: null,
          },
        ],
      });
      // No final parts: the walk stops at it.
      expect(
        await claim({ claimer: "dispatcher-1", recipientHandleId: "handle-alex", now: at, limit: 10 }),
      ).toEqual({
        result: "claimed",
        claimed: [],
        passedHeld: [],
      });
      const again = exchangeOf("write-plan.json").request as unknown as WritePlanRequest;
      expect(await plan({ ...again, expectVersion: 4 })).toEqual({
        result: "written",
        outboxRowId: id,
        version: 5,
      });
      expect(await unplanned("turn-alex-book-1")).toEqual({ result: "rows", rows: [] });
      const reclaimed = await claim({
        claimer: "dispatcher-1",
        recipientHandleId: "handle-alex",
        now: at,
        limit: 10,
      });
      expect(reclaimed.claimed).toHaveLength(1);
      expect(reclaimed.claimed[0]).toMatchObject({
        outboxRowId: id,
        version: 6,
        parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${id}/1/1`, attempts: 2, sent: false }],
      });
    },
  );

  it("a turn with no rows, or none unplanned, lists nothing", SLOW, async () => {
    await given("write-plan-owner.json");
    expect(await unplanned("turn-none")).toEqual({ result: "rows", rows: [] });
    expect(await unplanned("turn-alex-book-1")).toEqual({
      result: "rows",
      rows: [
        {
          outboxRowId: "out-sam-booked-riley",
          version: 1,
          commitSeq: 2,
          recipientHandleId: "handle-sam",
          channel: "imessage",
          copyOfRowId: null,
        },
      ],
    });
  });
});

// ---- markPart: the row follows its parts -----------------------------------------------------------------------------

describe("markPart moves the row with its parts (K-07 'How K-05 v1's calls use them')", () => {
  it(
    "a two-part row: each part sent and delivered, the row following its latest tries, firstDelivery once",
    SLOW,
    async () => {
      await given("claim-in-order.json");
      const id = "out-avery-two";
      const now = "2026-11-07T15:07:00Z";
      const row = await claimedRow(id, "handle-avery", [WORDS, POLL], now);
      expect(row.parts).toEqual([
        { partNo: 1, tryNo: 1, idempotencyKey: `${id}/1/1`, attempts: 1, sent: false },
        { partNo: 2, tryNo: 1, idempotencyKey: `${id}/2/1`, attempts: 1, sent: false },
      ]);

      expect(
        await mark({
          outcome: "sent",
          idempotencyKey: `${id}/1/1`,
          providerMessageId: "linq-test-0401",
          providerOptionIds: null,
          at: now,
        }),
      ).toEqual({
        result: "marked",
        outboxRowId: id,
        partNo: 1,
        tryNo: 1,
        attempts: 1,
        repeated: false,
        firstDelivery: false,
        openQuestionId: null,
        nextKey: null,
      });
      expect(await rowNow(id)).toMatchObject({ state: "sending", version: 4 });
      expect(
        await mark({ outcome: "delivered", providerMessageId: "linq-test-0401", at: now }),
      ).toMatchObject({
        partNo: 1,
        repeated: false,
        firstDelivery: true,
      });
      expect(await rowNow(id)).toMatchObject({ state: "sending", version: 5 });
      expect(
        await mark({ outcome: "delivered", providerMessageId: "linq-test-0401", at: now }),
      ).toMatchObject({
        repeated: true,
        firstDelivery: false,
      });
      expect(await rowNow(id)).toMatchObject({ state: "sending", version: 5 });

      expect(
        await mark({
          outcome: "sent",
          idempotencyKey: `${id}/2/1`,
          providerMessageId: "linq-test-0402",
          providerOptionIds: ["linq-opt-1", "linq-opt-2"],
          at: now,
        }),
      ).toMatchObject({ partNo: 2, repeated: false });
      expect(await rowNow(id)).toMatchObject({ state: "sent", version: 6 });
      expect(
        await mark({ outcome: "delivered", providerMessageId: "linq-test-0402", at: now }),
      ).toMatchObject({
        partNo: 2,
        repeated: false,
        firstDelivery: false,
      });
      expect(await rowNow(id)).toMatchObject({ state: "delivered", version: 7 });
      expect(await partsNow(id)).toEqual([
        {
          idempotency_key: `${id}/1/1`,
          kind: "words",
          state: "delivered",
          attempts: 1,
          linq_message_id: "linq-test-0401",
          linq_option_ids: null,
          error_code: null,
          sent: true,
          delivered: true,
          failed: false,
        },
        {
          idempotency_key: `${id}/2/1`,
          kind: "poll",
          state: "delivered",
          attempts: 1,
          linq_message_id: "linq-test-0402",
          linq_option_ids: ["linq-opt-1", "linq-opt-2"],
          error_code: null,
          sent: true,
          delivered: true,
          failed: false,
        },
      ]);
    },
  );

  it(
    "an accepted poll reported failed goes again plain: the next try as words, the row back to checked, then claimed",
    SLOW,
    async () => {
      await given("claim-in-order.json");
      const id = "out-maya-poll";
      const now = "2026-11-07T15:07:00Z";
      await claimedRow(id, "handle-maya", [WORDS, POLL], now);
      for (const [partNo, message] of [
        [1, "linq-test-0501"],
        [2, "linq-test-0502"],
      ] as const) {
        marked(
          await mark({
            outcome: "sent",
            idempotencyKey: `${id}/${String(partNo)}/1`,
            providerMessageId: message,
            providerOptionIds: null,
            at: now,
          }),
        );
      }
      marked(await mark({ outcome: "delivered", providerMessageId: "linq-test-0501", at: now }));
      expect(await rowNow(id)).toMatchObject({ state: "sent", version: 6 });

      // K-07 outbox-poll-failed-plain: Linq reports the accepted poll failed; a refused part goes again plain.
      expect(
        await mark({
          outcome: "failed",
          idempotencyKey: `${id}/2/1`,
          errorCode: "poll.failed",
          retry: true,
          at: now,
        }),
      ).toEqual({
        result: "marked",
        outboxRowId: id,
        partNo: 2,
        tryNo: 1,
        attempts: 1,
        repeated: false,
        firstDelivery: false,
        openQuestionId: null,
        nextKey: `${id}/2/2`,
      });
      expect(await rowNow(id)).toMatchObject({ state: "checked", version: 7 });
      expect(
        await mark({
          outcome: "failed",
          idempotencyKey: `${id}/2/1`,
          errorCode: "poll.failed",
          retry: true,
          at: now,
        }),
      ).toMatchObject({ repeated: true, nextKey: `${id}/2/2` });
      expect(await rowNow(id)).toMatchObject({ state: "checked", version: 7 });

      const again = await claim({
        claimer: "dispatcher-2",
        recipientHandleId: "handle-maya",
        now,
        limit: 10,
      });
      expect(again.claimed).toHaveLength(1);
      expect(again.claimed[0]?.version).toBe(8);
      expect(again.claimed[0]?.parts).toEqual([
        { partNo: 1, tryNo: 1, idempotencyKey: `${id}/1/1`, attempts: 1, sent: true },
        { partNo: 2, tryNo: 2, idempotencyKey: `${id}/2/2`, attempts: 2, sent: false },
      ]);
      marked(
        await mark({
          outcome: "sent",
          idempotencyKey: `${id}/2/2`,
          providerMessageId: "linq-test-0503",
          providerOptionIds: null,
          at: now,
        }),
      );
      expect(await rowNow(id)).toMatchObject({ state: "sent", version: 9 });
      expect(
        await mark({ outcome: "delivered", providerMessageId: "linq-test-0503", at: now }),
      ).toMatchObject({
        repeated: false,
        firstDelivery: false,
      });
      expect(await rowNow(id)).toMatchObject({ state: "delivered", version: 10 });
      expect(
        (await partsNow(id)).map((part) => [part.idempotency_key, part.kind, part.state, part.error_code]),
      ).toEqual([
        [`${id}/1/1`, "words", "delivered", null],
        [`${id}/2/1`, "poll", "failed", "poll.failed"],
        [`${id}/2/2`, "words", "delivered", null],
      ]);
    },
  );

  it("a 4006 waits for its receipt; a minute later the next try gets a new key, once", SLOW, async () => {
    await given("claim-in-order.json");
    const id = "out-tomas-4006";
    const now = "2026-11-07T15:07:00Z";
    await claimedRow(id, "handle-tomas", [WORDS], now);
    const key = `${id}/1/1`;
    // K-07 outbox-4006-new-key: no next try at once (rule 2), and a repeat of the failure changes nothing.
    expect(
      await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4006", retry: false, at: now }),
    ).toMatchObject({ result: "marked", repeated: false, nextKey: null });
    expect(await rowNow(id)).toMatchObject({ state: "sending", version: 4 });
    expect(
      await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4006", retry: false, at: now }),
    ).toMatchObject({ repeated: true, nextKey: null });
    const minute = "2026-11-07T15:08:00Z";
    expect(
      await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4006", retry: true, at: minute }),
    ).toMatchObject({ repeated: false, tryNo: 1, nextKey: `${id}/1/2` });
    expect(await rowNow(id)).toMatchObject({ state: "sending", version: 5 });
    expect(
      await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4006", retry: true, at: minute }),
    ).toMatchObject({ repeated: true, nextKey: `${id}/1/2` });
    expect(await mark({ outcome: "attempt", idempotencyKey: `${id}/1/2`, at: minute })).toMatchObject({
      repeated: false,
      tryNo: 2,
      attempts: 2,
    });
    marked(
      await mark({
        outcome: "sent",
        idempotencyKey: `${id}/1/2`,
        providerMessageId: "linq-test-0601",
        providerOptionIds: null,
        at: minute,
      }),
    );
    expect(await rowNow(id)).toMatchObject({ state: "sent", version: 7 });
    marked(await mark({ outcome: "delivered", providerMessageId: "linq-test-0601", at: minute }));
    expect(await rowNow(id)).toMatchObject({ state: "delivered", version: 8 });
    expect((await partsNow(id)).map((part) => [part.idempotency_key, part.state, part.attempts])).toEqual([
      [key, "failed", 1],
      [`${id}/1/2`, "delivered", 2],
    ]);
  });

  it(
    "an accepted part reported failed with no next try may still deliver: its receipt moves it and the row",
    SLOW,
    async () => {
      await given("claim-in-order.json");
      const id = "out-riley-late";
      const now = "2026-11-07T15:07:00Z";
      await claimedRow(id, "handle-riley", [WORDS], now);
      const key = `${id}/1/1`;
      marked(
        await mark({
          outcome: "sent",
          idempotencyKey: key,
          providerMessageId: "linq-test-0701",
          providerOptionIds: null,
          at: now,
        }),
      );
      expect(await rowNow(id)).toMatchObject({ state: "sent", version: 4 });
      marked(
        await mark({ outcome: "failed", idempotencyKey: key, errorCode: "4001", retry: false, at: now }),
      );
      // K-07 lists no move for the row here: it stays sent, its part failed (default 9).
      expect(await rowNow(id)).toMatchObject({ state: "sent", version: 5 });
      expect(
        await mark({ outcome: "delivered", providerMessageId: "linq-test-0701", at: now }),
      ).toMatchObject({
        repeated: false,
        firstDelivery: true,
      });
      expect(await rowNow(id)).toMatchObject({ state: "delivered", version: 6 });
      expect(
        (await partsNow(id)).map((part) => [part.state, part.error_code, part.failed, part.delivered]),
      ).toEqual([["delivered", "4001", true, true]]);
    },
  );
});

// ---- writePlan ------------------------------------------------------------------------------------------------------

describe("writePlan writes only this row's plan, at the version read", () => {
  it(
    "refuses another row's plan or channel, an unknown send kind, an unknown row and a changed version",
    SLOW,
    async () => {
      await given("write-plan.json");
      const request = exchangeOf("write-plan.json").request as unknown as WritePlanRequest;
      const before = await outboxNow();
      const otherRow = structuredClone(request);
      otherRow.plan.row = "out-sam-booked-riley";
      await expect(writePlan(runtime, otherRow)).rejects.toThrow("plan.row is not the row");
      const otherParts = structuredClone(request);
      otherParts.finalParts.channel = "sms";
      await expect(writePlan(runtime, otherParts)).rejects.toThrow(
        "finalParts.channel is not the plan's channel",
      );
      const email = structuredClone(request);
      email.plan.channel = "email";
      email.finalParts.channel = "email";
      await expect(writePlan(runtime, email)).rejects.toThrow("is not the row's");
      const photo = structuredClone(request) as unknown as { finalParts: { sends: Record<string, Json>[] } };
      const [send] = photo.finalParts.sends;
      if (send === undefined) {
        throw new Error("the fixture sends words");
      }
      send.kind = "photo";
      await expect(writePlan(runtime, photo as unknown as WritePlanRequest)).rejects.toThrow("send kinds");
      expect(await outboxNow()).toEqual(before);

      expect(await plan({ ...request, expectVersion: 2 })).toEqual({
        error: "versionChanged",
        changed: [
          { table: "outbox_rows", rowId: "out-alex-booked-riley", readVersion: 2, currentVersion: 1 },
        ],
      });
      const none = planRequest("out-none", 1, [WORDS]);
      expect(await plan(none)).toEqual({ error: "notFound", table: "outbox_rows", rowId: "out-none" });
      expect(await outboxNow()).toEqual(before);
    },
  );
});

// ==== T-1135: K-05 v1.1 items 13 to 16 and v1.2 items 30 to 32, the v1.2 outbox calls ================================
//
// claimOutboxV12, renewClaim, markPartV12 and markRowV12: the dispatcher's send loop, as runtime/src/dispatch/types.ts's
// OutboxStore calls it, on this file's schema and as rosie_job. A fixture's chain runs through these calls (and
// commitTurn, writePlan and armClock, each for real). Each step's answer, and the fixture's own, is compared with its
// outcome as that step's version states it: the fields a later version adds are left out (v1.1's claim, claimedFrom and
// row for a v1 exchange; v1.2's port and recipient for a v1.1 exchange), since every v1 and v1.1 exchange is a v1.2
// exchange (K-05 v1.2). Each answer of these calls is checked against data-access v1.2 in full, the added fields with it.
//
// From T-1227 markPartV12 answers as K-05 v1.9 says (item 48): its answer also states repeatedDelivery. So each of its
// answers is checked against v1.9's markPart.v1dot9Response in full, and repeatedDelivery is left out when an answer is
// compared with an exchange of v1 to v1.8, as the other added fields are: every v1 to v1.8 exchange is a v1.9 one.

const V12_ID = schemaId("data-access/data-access.v1.2.schema.json");
const V19_ID = schemaId("data-access/data-access.v1.9.schema.json");
const LATEST_CALLS = ["claimOutbox", "renewClaim", "markPart", "markRow"];
/** The v1.1 and v1.2 fixtures T-1135's card names (its "Reads"). */
const CARD_LATEST_FIXTURES = [
  "claim-dee.json",
  "renew-claim-first-send.json",
  "renew-claim-not-yet.json",
  "renew-claim-lost.json",
  "renew-claim-dee-answer.json",
  "claim-lapsed-reclaimed.json",
  "mark-failed-retry-after.json",
  "mark-row-wrong-state.json",
  "renew-claim-reads-phone.json",
  "renew-claim-stopped.json",
];
/** A failed safety line's followUps are T-1136's (the card's "Not here"); here they are refused (default 19). */
const LATER_FIXTURES = ["mark-safety-failed-other-way.json"];
const fixtureVersion = (file: string): string => INDEX.find((entry) => entry.file === file)?.version ?? "v1";
/** K-05 v1.1's and v1.2's accepted exchanges of the four calls, but T-1136's. */
const LATEST_FIXTURES = INDEX.filter(
  (entry) =>
    (entry.version === "v1.1" || entry.version === "v1.2") &&
    entry.expect === "accept" &&
    LATEST_CALLS.some((call) => entry.def === `${call}.exchange`) &&
    !LATER_FIXTURES.includes(entry.file),
).map((entry) => entry.file);

type Fields = Record<string, unknown>;

const without = (record: Fields, keys: readonly string[]): Fields =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** A K-05 version's minor number: 0 for v1, 9 for v1.9. */
const minorOf = (version: string): number => Number(version.split(".")[1] ?? "0");

/**
 * A v1.2 call's answer as an exchange of `version` states it: the fields a later version adds left out. markPartV12's
 * answer is v1.9's (T-1227), so its repeatedDelivery is left out for an exchange of v1 to v1.8.
 */
function asVersion(call: string, answer: unknown, version: string): unknown {
  if (!isRecord(answer) || "error" in answer) {
    return answer;
  }
  if (call === "markPart") {
    const added = minorOf(version) >= 9 ? [] : ["repeatedDelivery"];
    return without(answer, version === "v1" ? ["row", ...added] : added);
  }
  if (version === "v1.2") {
    return answer;
  }
  switch (call) {
    case "claimOutbox": {
      const added = version === "v1" ? ["claim", "claimedFrom", "port"] : ["port"];
      return { ...answer, claimed: (answer.claimed as Fields[]).map((row) => without(row, added)) };
    }
    case "renewClaim":
      return without(answer, ["recipient"]);
    default:
      return answer;
  }
}

/**
 * An answer against data-access v1.2: its call's response, or its errors. markPartV12's answer is checked against
 * v1.9's markPart.v1dot9Response, the answer a v1.9 call gives (T-1227): row and repeatedDelivery always stated.
 */
function latestErrors(call: string, outcome: unknown): string[] {
  const error = isRecord(outcome) ? outcome.error : undefined;
  if (call === "markPart" && error === undefined) {
    return schemaErrors(V19_ID, "markPart.v1dot9Response", outcome);
  }
  return schemaErrors(V12_ID, error === undefined ? `${call}.response` : `${call}.errors`, outcome);
}

/**
 * A markPart request with its answer as one K-05 v1.9 exchange. markPart.v1dot9Response alone cannot see the request;
 * markPart.exchange ties repeatedDelivery to it: a delivery receipt answered repeated states the delivery it repeats,
 * never null, and a mark that is no delivery states none (T-1226's security note a).
 */
function markExchangeErrors(request: unknown, outcome: unknown): string[] {
  const given: Given = { k04Seeds: [], after: [], now: "2026-11-07T15:07:00Z" };
  return schemaErrors(V19_ID, "markPart.exchange", { call: "markPart", given, request, outcome });
}

/** Runs one exchange's request: the four v1.2 calls and armClock here, and the rest as runExchange runs them. */
async function runLatest(exchange: Exchange): Promise<unknown> {
  const request: unknown = structuredClone(exchange.request);
  switch (exchange.call) {
    case "claimOutbox":
      return claimOutboxV12(runtime, request as ClaimOutboxRequest);
    case "renewClaim":
      return renewClaim(runtime, request as RenewClaimRequest);
    case "markPart":
      return markPartV12(runtime, request as MarkPartV12Request);
    case "markRow":
      return markRowV12(runtime, request as MarkRowV12Request);
    case "armClock":
      return armClock(runtime, request as ArmClockRequest);
    default:
      return runExchange(exchange);
  }
}

/** Loads a fixture's seeds and runs its chain through the v1.2 calls, each step's answer its outcome at its version. */
async function givenLatest(file: string): Promise<Exchange> {
  const chain = chainOf(file);
  await reset();
  await loadSeeds(chain.seeds);
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    expect(asVersion(before.call, await runLatest(before), fixtureVersion(step)), step).toEqual(
      before.outcome,
    );
  }
  return exchangeOf(file);
}

/** Runs a fixture's own request after its chain, its answer its outcome at its version. */
async function ranLatest(file: string): Promise<void> {
  const exchange = await givenLatest(file);
  const answer = await runLatest(exchange);
  expect(asVersion(exchange.call, answer, fixtureVersion(file)), file).toEqual(exchange.outcome);
}

async function claimV12(request: ClaimOutboxRequest): Promise<ClaimOutboxV12Response> {
  const outcome = await claimOutboxV12(runtime, request);
  expect(latestErrors("claimOutbox", outcome)).toEqual([]);
  if ("error" in outcome) {
    throw new Error(`claimOutboxV12 answered ${outcome.error}`);
  }
  return outcome;
}

async function renew(request: RenewClaimRequest): Promise<RenewClaimOutcome> {
  const outcome = await renewClaim(runtime, request);
  expect(latestErrors("renewClaim", outcome)).toEqual([]);
  return outcome;
}

/** markPartV12's answer in full, as K-05 v1.9 states it: checked against its answer's definition and as an exchange. */
async function markV19(request: MarkPartV12Request): Promise<MarkPartV12Outcome> {
  const outcome = await markPartV12(runtime, request);
  expect(latestErrors("markPart", outcome)).toEqual([]);
  expect(markExchangeErrors(request, outcome)).toEqual([]);
  return outcome;
}

/**
 * markPartV12's answer as K-05 v1.2 states it, for T-1135's tests: checked in full first (markV19), then v1.9's
 * repeatedDelivery left out.
 */
async function markV12(request: MarkPartV12Request): Promise<unknown> {
  return asVersion("markPart", await markV19(request), "v1.2");
}

async function limit8V12(request: MarkRowV12Request): Promise<MarkRowV12Outcome> {
  const outcome = await markRowV12(runtime, request);
  expect(latestErrors("markRow", outcome)).toEqual([]);
  return outcome;
}

/** A row's claim as it stands, or undefined when it has none. */
async function claimNow(rowId: string): Promise<Fields | undefined> {
  const [claim] = await db.sql<Fields[]>`
    select claimer, claimed_at, lapses_at, claim_no, first_try_at, next_try_not_before, version
    from outbox_claims where outbox_row_id = ${rowId}
  `;
  return claim;
}

/** Everything the outbox and its claims hold: equal before and after = nothing was written. */
async function everythingNow(): Promise<unknown> {
  const claims = await db.sql`
    select outbox_row_id, claimer, claimed_at, lapses_at, claim_no, first_try_at, next_try_not_before, version
    from outbox_claims order by outbox_row_id collate "C"
  `;
  return { outbox: await outboxNow(), claims: [...claims] };
}

/** An outbox row as a commit writes it on any channel (planned, no plan), under commit-first.json's turn. */
async function addChannelRow(id: string, recipientHandleId: string, channel: string): Promise<void> {
  await insertRow(db.sql, "outbox_rows", {
    id,
    turn_id: "turn-alex-book-1",
    recipient_handle_id: recipientHandleId,
    business_id: "biz-lees-barbershop",
    channel,
    send_class: "routine",
    versions_read: [],
    bundle_hash: BUNDLE_HASH,
    bundle_build: 1,
    trace_id: "trace-alex-0012",
  });
  const request: Json = {
    outboxRowId: id,
    expectVersion: 1,
    plan: { row: id, channel, copyOf: null, plan: PLAN_BODY },
    finalParts: { row: id, channel, sends: [WORDS], fixedLines: [], slotValues: [], threadReplyTo: null },
  };
  expect(await plan(request as unknown as WritePlanRequest)).toEqual({
    result: "written",
    outboxRowId: id,
    version: 2,
  });
}

/** Waits until `check` holds, polling every 20 ms for at most 20 s. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 1000; tries += 1) {
    if (await check()) {
      return;
    }
    await pause(20);
  }
  throw new Error(`waited 20 s, and still not ${what}`);
}

const ALEX_ROW = "out-alex-booked-riley";
const ALEX_KEY = "out-alex-booked-riley/1/1";

// ---- the fixtures -----------------------------------------------------------------------------------------------------

describe("K-05 v1.1's and v1.2's outbox fixtures: each request gives its response (T-1135)", () => {
  it("covers the fixtures the card names, among the 21 v1.1 and v1.2 exchanges of the four calls", () => {
    expect(LATEST_FIXTURES).toEqual(expect.arrayContaining(CARD_LATEST_FIXTURES));
    expect(LATEST_FIXTURES).toHaveLength(21);
  });

  for (const file of LATEST_FIXTURES) {
    it(file, SLOW, async () => {
      const exchange = await givenLatest(file);
      const answer = await runLatest(exchange);
      expect(asVersion(exchange.call, answer, fixtureVersion(file))).toEqual(exchange.outcome);
      expect(latestErrors(exchange.call, answer)).toEqual([]);
    });
  }
});

describe("K-05 v1.1's and v1.2's refused outbox requests are refused, and nothing is written (T-1135)", () => {
  const refused = (file: string): Fields => readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as Fields;

  it("refuse-mark-delivered-key-only.json: a receipt always carries its message id", SLOW, async () => {
    await givenLatest("mark-delivered-by-key.json");
    const request = refused("refuse-mark-delivered-key-only.json");
    expect(schemaErrors(V12_ID, "markPart.request", request)).not.toEqual([]);
    expect(
      schemaErrors(V12_ID, "markPart.request", { ...request, providerMessageId: "linq-msg-demo-0101" }),
    ).toEqual([]);
    const before = await everythingNow();
    await expect(markPartV12(runtime, request as unknown as MarkPartV12Request)).rejects.toThrow(TypeError);
    expect(await everythingNow()).toEqual(before);
  });

  it(
    "refuse-failed-no-retry-with-not-before.json: a Retry-After goes only with a next try",
    SLOW,
    async () => {
      await givenLatest("mark-failed-retry-after.json");
      const request = refused("refuse-failed-no-retry-with-not-before.json");
      expect(schemaErrors(V12_ID, "markPart.request", request)).not.toEqual([]);
      expect(schemaErrors(V12_ID, "markPart.request", { ...request, nextTryNotBefore: null })).toEqual([]);
      const before = await everythingNow();
      await expect(markPartV12(runtime, request as unknown as MarkPartV12Request)).rejects.toThrow(TypeError);
      expect(await everythingNow()).toEqual(before);
    },
  );

  it(
    "refuse-mark-waiting-chat-with-time.json: a row waiting for the chat has no held_until",
    SLOW,
    async () => {
      await givenLatest("mark-waiting-chat.json");
      const request = refused("refuse-mark-waiting-chat-with-time.json");
      expect(schemaErrors(V12_ID, "markRow.request", request)).not.toEqual([]);
      expect(schemaErrors(V12_ID, "markRow.request", { ...request, heldUntil: null })).toEqual([]);
      const before = await everythingNow();
      await expect(markRowV12(runtime, request as unknown as MarkRowV12Request)).rejects.toThrow(TypeError);
      expect(await everythingNow()).toEqual(before);
      expect(await rowNow("out-dee-booked-riley")).toMatchObject({ state: "sending", version: 3 });
    },
  );

  it(
    "refuse-claimed-row-sms-port.json: no claimed row names an SMS port; sms and rcs rows go by linq, email by email",
    SLOW,
    async () => {
      const smsPort = refused("refuse-claimed-row-sms-port.json");
      expect(schemaErrors(V12_ID, "claimedRow", smsPort)).not.toEqual([]);
      expect(schemaErrors(V12_ID, "claimedRow", { ...smsPort, port: "linq" })).toEqual([]);

      await givenLatest("claim-in-order-with-port.json");
      await addChannelRow("out-riley-sms", "handle-riley", "sms");
      await addChannelRow("out-tomas-rcs", "handle-tomas", "rcs");
      await addChannelRow("out-alex-email", "handle-alex-email", "email");
      const now = "2026-11-07T15:07:00Z";
      const ports: [string, string, string][] = [];
      for (const recipientHandleId of ["handle-riley", "handle-tomas", "handle-alex-email"]) {
        const answer = await claimV12({ claimer: "dispatcher-1", recipientHandleId, now, limit: 10 });
        ports.push(
          ...answer.claimed.map((row): [string, string, string] => [row.outboxRowId, row.channel, row.port]),
        );
      }
      expect(ports).toEqual([
        ["out-riley-sms", "sms", "linq"],
        ["out-tomas-rcs", "rcs", "linq"],
        ["out-alex-email", "email", "email"],
      ]);

      // The renewal reads the recipient's phone row; an email handle has none.
      const renewal = (outboxRowId: string): RenewClaimRequest => ({
        outboxRowId,
        claimer: "dispatcher-1",
        claimNo: 1,
        idempotencyKey: `${outboxRowId}/1/1`,
        at: now,
      });
      expect(await renew(renewal("out-alex-email"))).toMatchObject({ result: "renewed", recipient: null });
      expect(await renew(renewal("out-riley-sms"))).toMatchObject({
        result: "renewed",
        recipient: { stopped: false, chatOpen: true, version: 2 },
      });
    },
  );

  it(
    "a failed safety line's followUps are T-1136's: refused here, and nothing is written",
    SLOW,
    async () => {
      const exchange = await givenLatest("mark-safety-failed-other-way.json");
      const before = await everythingNow();
      await expect(
        markPartV12(runtime, structuredClone(exchange.request) as unknown as MarkPartV12Request),
      ).rejects.toThrow("followUps");
      expect(await everythingNow()).toEqual(before);
    },
  );
});

// ---- claimOutboxV12: the claim and the re-claim ---------------------------------------------------------------------

const LAPSE_RECIPIENTS = 25;
const LAPSE_ROWS = 1000;
/** The claimers' now: the dead dispatcher's claims (taken 15:00:00) lapsed at 15:01:00; the live ones lapse 15:05:30. */
const LAPSE_NOW = "2026-11-09T15:05:00Z";
const lapseHandleOf = (n: number): string => `handle-lap-${String(n).padStart(2, "0")}`;

type Hold = "lapsed" | "live" | "none";

/** How a recipient's first row is held when the claimers start: a lapsed claim, a live claim, or no claim row. */
function holdOf(n: number): Hold {
  if (n % 3 === 0) {
    return "lapsed";
  }
  return n % 3 === 1 ? "live" : "none";
}

/**
 * 1,000 rows over 25 recipients, commit_seq interleaving them; every third row has two parts. Each recipient's first row
 * is sending, its parts out as far as a two-part row's accepted words, under a claim a dead dispatcher took at 15:00:00
 * (lapsed at 15:01:00), under a live claim taken at 15:04:30 (lapsing at 15:05:30), or with no claim row (a v1 claim),
 * by recipient (holdOf). The rest are checked. Each recipient has a phone row.
 */
async function lapsedRows(): Promise<void> {
  await reset();
  await loadSeeds(["seed-bundle-registry.json"]);
  await db.sql.begin(async (tx) => {
    for (let n = 0; n < LAPSE_RECIPIENTS; n += 1) {
      const address = `+1555555${String(150 + n).padStart(4, "0")}`;
      await insertRow(tx, "handles", { id: lapseHandleOf(n), kind: "phone", address });
      await insertRow(tx, "phones", { number: address, handle_id: lapseHandleOf(n) });
    }
    await tx`
      insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
      values ('turn-lap', ${lapseHandleOf(0)}, ${["evt-lap-1"]}, 'committed', ${BUNDLE_HASH}, 1, 'trace-lap',
              '2026-11-09T14:59:00Z')
    `;
    await tx`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, channel, send_class, versions_read, plan, final_parts, state, version,
        bundle_hash, bundle_build, trace_id
      )
      select
        'out-lap-' || lpad(g::text, 4, '0'),
        'turn-lap',
        'handle-lap-' || lpad(((g * 7) % ${LAPSE_RECIPIENTS})::text, 2, '0'),
        'imessage',
        'routine',
        '[]'::jsonb,
        jsonb_build_object(
          'row', 'out-lap-' || lpad(g::text, 4, '0'), 'channel', 'imessage', 'copyOf', null,
          'plan', ${tx.json(PLAN_BODY)}::jsonb
        ),
        jsonb_build_object(
          'row', 'out-lap-' || lpad(g::text, 4, '0'), 'channel', 'imessage',
          'sends', case when g % 3 = 0 then ${tx.json([WORDS, POLL])}::jsonb else ${tx.json([WORDS])}::jsonb end,
          'fixedLines', '[]'::jsonb, 'slotValues', '[]'::jsonb, 'threadReplyTo', null
        ),
        case when g < ${LAPSE_RECIPIENTS} then 'sending' else 'checked' end,
        case when g < ${LAPSE_RECIPIENTS} then 3 else 2 end,
        ${BUNDLE_HASH},
        1,
        'trace-lap'
      from generate_series(0, ${LAPSE_ROWS - 1}) as g
      order by g
    `;
    // The first rows' parts: a two-part row's words were accepted and its poll was not; a one-part row's words were not.
    await tx`
      insert into outbox_parts (
        outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state, linq_message_id, sent_at
      )
      select
        'out-lap-' || lpad(g::text, 4, '0'), 1, 1, 'out-lap-' || lpad(g::text, 4, '0') || '/1/1', 1, 'words',
        case when g % 3 = 0 then 'sent' else 'pending' end,
        case when g % 3 = 0 then 'linq-lap-' || g::text else null end,
        case when g % 3 = 0 then '2026-11-09T15:00:01Z'::timestamptz else null end
      from generate_series(0, ${LAPSE_RECIPIENTS - 1}) as g
    `;
    await tx`
      insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state)
      select 'out-lap-' || lpad(g::text, 4, '0'), 2, 1, 'out-lap-' || lpad(g::text, 4, '0') || '/2/1', 1, 'poll',
             'pending'
      from generate_series(0, ${LAPSE_RECIPIENTS - 1}) as g
      where g % 3 = 0
    `;
    // Their claims, by recipient (holdOf): the dead dispatcher's, lapsed; the live one's; or none.
    await tx`
      insert into outbox_claims (outbox_row_id, claimer, claimed_at, lapses_at, claim_no, first_try_at)
      select
        'out-lap-' || lpad(g::text, 4, '0'),
        case when r % 3 = 0 then 'dispatcher-dead' else 'dispatcher-alive' end,
        case when r % 3 = 0 then '2026-11-09T15:00:00Z'::timestamptz else '2026-11-09T15:04:30Z'::timestamptz end,
        case when r % 3 = 0 then '2026-11-09T15:01:00Z'::timestamptz else '2026-11-09T15:05:30Z'::timestamptz end,
        1,
        case when r % 3 = 0 then '2026-11-09T15:00:01Z'::timestamptz else null end
      from (
        select g, (g * 7) % ${LAPSE_RECIPIENTS} as r from generate_series(0, ${LAPSE_RECIPIENTS - 1}) as g
      ) as first_rows
      where r % 3 <> 2
    `;
  });
}

interface Claimed {
  rowId: string;
  recipient: string;
  commitSeq: number;
  claimer: number;
  claimedFrom: string;
  claimNo: number;
  firstTryAt: string | null;
  port: string;
  parts: ClaimedRowV12["parts"];
}

describe("claimOutboxV12: each row's claim, taken again once it lapses (T-1135)", () => {
  it(
    "20 parallel claimers: each lapsed claim is re-claimed exactly once, and a live claim stops the walk",
    PARALLEL,
    async () => {
      await lapsedRows();
      const recipients = Array.from({ length: LAPSE_RECIPIENTS }, (_, n) => n);
      const claimable = recipients.filter((n) => holdOf(n) !== "live").map(lapseHandleOf);
      const live = recipients.filter((n) => holdOf(n) === "live").map(lapseHandleOf);
      const holdOfHandle = new Map(recipients.map((n) => [lapseHandleOf(n), holdOf(n)]));
      const rowsEach = LAPSE_ROWS / LAPSE_RECIPIENTS;
      const log: Claimed[] = [];
      const unsent = async (): Promise<number> => {
        const [row] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from outbox_rows where state <> 'sent' and recipient_handle_id = any(${claimable})
        `;
        return row?.n ?? -1;
      };

      // Each claimer is a dispatcher: claim, record the claim at once, then for each part not yet accepted renew the
      // claim (reading the phone) and send it (markPartV12 sent), so a recipient's next rows become claimable only after
      // these finish.
      const dispatcher = async (claimer: number): Promise<void> => {
        const name = `dispatcher-${String(claimer)}`;
        for (let round = 0; round < 5000; round += 1) {
          const answer = await settled(() =>
            claimOutboxV12(runtime, { claimer: name, now: LAPSE_NOW, limit: 7 }),
          );
          if ("error" in answer) {
            throw new Error(`claimOutboxV12 answered ${answer.error} ten times`);
          }
          if (answer.claimed.length === 0) {
            if ((await unsent()) === 0) {
              return;
            }
            await pause(5);
            continue;
          }
          for (const row of answer.claimed) {
            log.push({
              rowId: row.outboxRowId,
              recipient: row.recipientHandleId,
              commitSeq: row.commitSeq,
              claimer,
              claimedFrom: row.claimedFrom,
              claimNo: row.claim.claimNo,
              firstTryAt: row.claim.firstTryAt,
              port: row.port,
              parts: row.parts,
            });
          }
          for (const row of answer.claimed) {
            for (const part of row.parts) {
              if (part.sent) {
                continue;
              }
              const renewed = await settled(() =>
                renewClaim(runtime, {
                  outboxRowId: row.outboxRowId,
                  claimer: name,
                  claimNo: row.claim.claimNo,
                  idempotencyKey: part.idempotencyKey,
                  at: LAPSE_NOW,
                }),
              );
              expect(renewed).toMatchObject({
                result: "renewed",
                recipient: { stopped: false, chatOpen: false, version: 1 },
              });
              const sent = await settled(() =>
                markPartV12(runtime, {
                  outcome: "sent",
                  idempotencyKey: part.idempotencyKey,
                  providerMessageId: `linq-lap-${part.idempotencyKey}`,
                  providerOptionIds: null,
                  at: LAPSE_NOW,
                }),
              );
              expect(sent).toMatchObject({ result: "marked", repeated: false });
            }
          }
        }
        throw new Error("a claimer did not finish in 5,000 rounds");
      };
      await Promise.all(Array.from({ length: CLAIMERS }, (_, claimer) => dispatcher(claimer)));

      // Every row of the recipients with no live claim was claimed exactly once, each by one claimer, all by linq.
      expect(log).toHaveLength(claimable.length * rowsEach);
      expect(new Set(log.map((entry) => entry.rowId)).size).toBe(claimable.length * rowsEach);
      expect(new Set(log.map((entry) => entry.claimer)).size).toBeGreaterThan(1);
      expect(log.every((entry) => entry.port === "linq")).toBe(true);

      // The first rows: each lapsed claim, or a row with none, taken again exactly once from sending, keeping its
      // first try's time; its parts not accepted handed out again under their keys with attempts raised, an accepted
      // part listed as sent. A first row under a live claim was never taken.
      const firsts = await db.sql<{ id: string; recipient_handle_id: string; parts: number }[]>`
        select distinct on (r.recipient_handle_id) r.id, r.recipient_handle_id,
               (select count(*)::int from outbox_parts p where p.outbox_row_id = r.id) as parts
        from outbox_rows r
        order by r.recipient_handle_id, r.commit_seq
      `;
      expect(firsts).toHaveLength(LAPSE_RECIPIENTS);
      for (const first of firsts) {
        const hold = holdOfHandle.get(first.recipient_handle_id);
        const taken = log.filter((entry) => entry.rowId === first.id);
        const claim = await claimNow(first.id);
        if (hold === "live") {
          expect(taken, first.id).toEqual([]);
          expect(claim, first.id).toMatchObject({ claimer: "dispatcher-alive", claim_no: 1, version: 1 });
          expect(await rowNow(first.id)).toMatchObject({ state: "sending", version: 3 });
          continue;
        }
        expect(taken, first.id).toHaveLength(1);
        const [entry] = taken;
        const reclaimed = { claimedFrom: "sending", claimNo: hold === "lapsed" ? 2 : 1 };
        expect(entry, first.id).toMatchObject({
          ...reclaimed,
          firstTryAt: hold === "lapsed" ? "2026-11-09T15:00:01Z" : null,
        });
        expect(entry?.parts, first.id).toEqual(
          first.parts === 2
            ? [
                { partNo: 1, tryNo: 1, idempotencyKey: `${first.id}/1/1`, attempts: 1, sent: true },
                { partNo: 2, tryNo: 1, idempotencyKey: `${first.id}/2/1`, attempts: 2, sent: false },
              ]
            : [{ partNo: 1, tryNo: 1, idempotencyKey: `${first.id}/1/1`, attempts: 2, sent: false }],
        );
        expect(claim, first.id).toMatchObject({
          claimer: `dispatcher-${String(entry?.claimer)}`,
          claim_no: reclaimed.claimNo,
          first_try_at: new Date(hold === "lapsed" ? "2026-11-09T15:00:01Z" : LAPSE_NOW),
          next_try_not_before: null,
        });
      }
      const firstIds = new Set(firsts.map((first) => first.id));
      expect(
        log.filter((entry) => !firstIds.has(entry.rowId)).every((entry) => entry.claimedFrom === "checked"),
      ).toBe(true);
      expect(log.filter((entry) => !firstIds.has(entry.rowId)).every((entry) => entry.claimNo === 1)).toBe(
        true,
      );
      const [claims] = await db.sql<{ n: number; most: number }[]>`
        select count(*)::int as n, max(claim_no)::int as most from outbox_claims
      `;
      expect(claims).toEqual({ n: claimable.length * rowsEach + live.length, most: 2 });

      // Every part of theirs went once; a live claim's later rows were never claimed: no part, still checked.
      const parts = await db.sql<{ recipient: string; state: string; n: number }[]>`
        select r.recipient_handle_id as recipient, p.state, count(*)::int as n
        from outbox_parts p join outbox_rows r on r.id = p.outbox_row_id
        where p.state <> 'sent'
        group by r.recipient_handle_id, p.state
        order by r.recipient_handle_id collate "C", p.state
      `;
      expect(parts.every((part) => live.includes(part.recipient))).toBe(true);
      const liveRows = await db.sql<{ state: string; n: number }[]>`
        select state, count(*)::int as n from outbox_rows where recipient_handle_id = any(${live})
        group by state order by state
      `;
      expect([...liveRows]).toEqual([
        { state: "checked", n: live.length * (rowsEach - 1) },
        { state: "sending", n: live.length },
      ]);

      // Commit order: each recipient's claims are its rows, all of them, in commit_seq order.
      const stored = await db.sql<{ recipient_handle_id: string; commit_seq: string }[]>`
        select recipient_handle_id, commit_seq from outbox_rows order by commit_seq
      `;
      for (const recipient of claimable) {
        const claimed = log.filter((entry) => entry.recipient === recipient).map((entry) => entry.commitSeq);
        const committed = stored
          .filter((row) => row.recipient_handle_id === recipient)
          .map((row) => Number(row.commit_seq));
        expect(committed).toHaveLength(rowsEach);
        expect(claimed, recipient).toEqual(committed);
      }

      // Once the live claim lapses, its row is taken again, once, and the recipient's rows behind it go with it.
      const [liveHandle] = live;
      if (liveHandle === undefined) {
        throw new Error("a recipient holds a live claim");
      }
      const after = await claimV12({
        claimer: "dispatcher-late",
        recipientHandleId: liveHandle,
        now: "2026-11-09T15:05:30Z",
        limit: 100,
      });
      expect(after.claimed).toHaveLength(rowsEach);
      expect(after.claimed.map((row) => [row.claimedFrom, row.claim.claimNo])).toEqual([
        ["sending", 2],
        ...Array.from({ length: rowsEach - 1 }, () => ["checked", 1]),
      ]);
      expect(
        await claimV12({
          claimer: "dispatcher-later",
          recipientHandleId: liveHandle,
          now: "2026-11-09T15:05:30Z",
          limit: 100,
        }),
      ).toEqual({ result: "claimed", claimed: [], passedHeld: [] });
    },
  );

  it("a held row keeps its claim through the night: its morning claim is claim 2", SLOW, async () => {
    await ranLatest("claim-held-lets-later-pass.json");
    const held = "out-sam-passon-evening";
    expect(await claimNow(held)).toMatchObject({ claimer: "dispatcher-1", claim_no: 1, first_try_at: null });
    // Sam's quick reply goes; the held row stays where it is.
    expect(
      await renew({
        outboxRowId: "out-sam-reply-evening",
        claimer: "dispatcher-1",
        claimNo: 1,
        idempotencyKey: "out-sam-reply-evening/1/1",
        at: "2026-11-08T01:31:09Z",
      }),
    ).toMatchObject({ result: "renewed", claim: { claimNo: 1, firstTryAt: "2026-11-08T01:31:09Z" } });
    expect(
      await markV12({
        outcome: "sent",
        idempotencyKey: "out-sam-reply-evening/1/1",
        providerMessageId: "linq-test-1201",
        providerOptionIds: null,
        at: "2026-11-08T01:31:10Z",
      }),
    ).toMatchObject({ result: "marked", row: { state: "sent", version: 4 } });
    expect(
      await claimV12({
        claimer: "dispatcher-3",
        recipientHandleId: "handle-sam",
        now: "2026-11-08T12:59:59Z",
        limit: 10,
      }),
    ).toEqual({
      result: "claimed",
      claimed: [],
      passedHeld: [{ outboxRowId: held, heldUntil: "2026-11-08T13:00:00Z" }],
    });
    // At 8am the sweep takes it again: claim 2, from held, its part under its stored key.
    const morning = await claimV12({ claimer: "dispatcher-3", now: "2026-11-08T13:00:05Z", limit: 10 });
    expect(morning.claimed).toHaveLength(1);
    expect(morning.claimed[0]).toMatchObject({
      outboxRowId: held,
      version: 5,
      claimedFrom: "held",
      port: "linq",
      parts: [{ partNo: 1, tryNo: 1, idempotencyKey: `${held}/1/1`, attempts: 2, sent: false }],
      claim: {
        claimer: "dispatcher-3",
        claimedAt: "2026-11-08T13:00:05Z",
        lapsesAt: "2026-11-08T13:01:05Z",
        claimNo: 2,
        firstTryAt: null,
        nextTryNotBefore: null,
      },
    });
  });

  it(
    "a lapsed row whose part failed with no next try waits for its receipt: the walk stops at it (default 13)",
    SLOW,
    async () => {
      await ranLatest("mark-failed-4006.json");
      // Both claims lapsed at 15:07:35. Sam's row is taken again; Alex's, whose words failed with 4006 and wait for a
      // receipt, stops his walk, unclaimed.
      const sweep = await claimV12({ claimer: "dispatcher-2", now: "2026-11-07T15:08:00Z", limit: 10 });
      expect(sweep.claimed.map((row) => [row.outboxRowId, row.claimedFrom, row.claim.claimNo])).toEqual([
        ["out-sam-booked-riley", "sending", 2],
      ]);
      expect(await rowNow(ALEX_ROW)).toMatchObject({ state: "sending", version: 4 });
      expect(await claimNow(ALEX_ROW)).toMatchObject({ claimer: "dispatcher-1", claim_no: 1 });
      // Its receipt, found by its key, moves it.
      const receipt = exchangeOf("mark-delivered-by-key.json");
      expect(await markV12(structuredClone(receipt.request) as unknown as MarkPartV12Request)).toEqual(
        receipt.outcome,
      );
      expect(await rowNow(ALEX_ROW)).toMatchObject({ state: "delivered", version: 5 });
    },
  );
});

// ---- renewClaim -------------------------------------------------------------------------------------------------------

describe("renewClaim: the claim renewed just before a part goes, and the stop read with it (T-1135)", () => {
  it("a STOP committing during a renewal is waited for and seen (FOR SHARE)", SLOW, async () => {
    await ranLatest("claim-in-order-with-port.json");
    const stop = await db.sql.reserve();
    let open = false;
    try {
      // The STOP's commit (commit-alex-stop.json's phone write), held open before it commits.
      await stop.unsafe("begin");
      open = true;
      await stop`
        update phones set stopped = true, stop_at = ${"2026-11-07T15:06:36Z"}, chat_open = false,
                          version = version + 1
        where number = ${"+15555550101"}
      `;
      const [backend] = await stop<{ pid: number }[]>`select pg_backend_pid() as pid`;
      if (backend === undefined) {
        throw new Error("no backend pid");
      }
      let done = false;
      const renewal = renew({
        outboxRowId: ALEX_ROW,
        claimer: "dispatcher-1",
        claimNo: 1,
        idempotencyKey: ALEX_KEY,
        at: "2026-11-07T15:06:37Z",
      }).finally(() => {
        done = true;
      });
      // The renewal waits on the phone row the STOP is writing: a backend blocked by the STOP's.
      await until(async () => {
        const [blocked] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where ${backend.pid}::int = any(pg_blocking_pids(pid))
        `;
        return (blocked?.n ?? 0) > 0;
      }, "the renewal waits for the STOP");
      expect(done).toBe(false);
      await stop.unsafe("commit");
      open = false;
      expect(await renewal).toEqual({
        result: "renewed",
        outboxRowId: ALEX_ROW,
        claim: {
          claimer: "dispatcher-1",
          claimedAt: "2026-11-07T15:06:35Z",
          lapsesAt: "2026-11-07T15:07:37Z",
          claimNo: 1,
          firstTryAt: "2026-11-07T15:06:37Z",
          nextTryNotBefore: null,
        },
        recipient: { stopped: true, chatOpen: false, version: 4 },
      });
      // Only the claim's version rose, not the row's.
      expect(await rowNow(ALEX_ROW)).toMatchObject({ state: "sending", version: 3 });
      expect(await claimNow(ALEX_ROW)).toMatchObject({ claim_no: 1, version: 2 });
    } finally {
      if (open) {
        await stop.unsafe("rollback");
      }
      stop.release();
    }
  });

  it("the stopped phone is no refusal: limit 8 drops the row, and its claim row stays", SLOW, async () => {
    await ranLatest("renew-claim-stopped.json");
    expect(
      await limit8V12({
        outboxRowId: ALEX_ROW,
        expectVersion: 3,
        outcome: "droppedStopped",
        heldUntil: null,
        at: "2026-11-07T15:06:37Z",
      }),
    ).toEqual({ result: "marked", outboxRowId: ALEX_ROW, version: 4, outcome: "droppedStopped" });
    expect(await claimNow(ALEX_ROW)).toMatchObject({
      claimer: "dispatcher-1",
      claim_no: 1,
      first_try_at: new Date("2026-11-07T15:06:37Z"),
    });
    expect(
      await renew({
        outboxRowId: ALEX_ROW,
        claimer: "dispatcher-1",
        claimNo: 1,
        idempotencyKey: ALEX_KEY,
        at: "2026-11-07T15:06:38Z",
      }),
    ).toEqual({
      error: "claimLost",
      table: "outbox_rows",
      rowId: ALEX_ROW,
      claimer: "dispatcher-1",
      claimNo: 1,
      state: "dropped_stopped",
    });
  });

  it(
    "refusals write nothing; a lapsed claim nobody took again is still the caller's, and only its version rises",
    SLOW,
    async () => {
      await ranLatest("claim-in-order-with-port.json");
      const at = "2026-11-07T15:06:36Z";
      const request: RenewClaimRequest = {
        outboxRowId: ALEX_ROW,
        claimer: "dispatcher-1",
        claimNo: 1,
        idempotencyKey: ALEX_KEY,
        at,
      };
      const lost = {
        error: "claimLost",
        table: "outbox_rows",
        rowId: ALEX_ROW,
        claimer: "dispatcher-1",
        claimNo: 1,
        state: "sending",
      };
      const before = await everythingNow();
      expect(await renew({ ...request, claimer: "dispatcher-2" })).toEqual(lost);
      expect(await renew({ ...request, claimNo: 2 })).toEqual(lost);
      expect(await renew({ ...request, idempotencyKey: "out-sam-booked-riley/1/1" })).toEqual({
        error: "wrongState",
        table: "outbox_parts",
        rowId: "out-sam-booked-riley/1/1",
        state: "pending",
      });
      expect(await renew({ ...request, idempotencyKey: `${ALEX_ROW}/2/1` })).toEqual({
        error: "notFound",
        table: "outbox_parts",
        rowId: `${ALEX_ROW}/2/1`,
      });
      expect(await renew({ ...request, outboxRowId: "out-none" })).toEqual({
        error: "notFound",
        table: "outbox_rows",
        rowId: "out-none",
      });
      await expect(renewClaim(runtime, { ...request, claimNo: 0 })).rejects.toThrow(TypeError);
      expect(await everythingNow()).toEqual(before);

      // The claim lapsed at 15:07:35 and nobody took it again: at 15:08:00 it is still dispatcher-1's.
      const renewed = {
        result: "renewed",
        outboxRowId: ALEX_ROW,
        claim: {
          claimer: "dispatcher-1",
          claimedAt: "2026-11-07T15:06:35Z",
          lapsesAt: "2026-11-07T15:09:00Z",
          claimNo: 1,
          firstTryAt: "2026-11-07T15:08:00Z",
          nextTryNotBefore: null,
        },
        recipient: { stopped: false, chatOpen: true, version: 3 },
      };
      expect(await renew({ ...request, at: "2026-11-07T15:08:00Z" })).toEqual(renewed);
      // A repeat renews again; firstTryAt is set once.
      expect(await renew({ ...request, at: "2026-11-07T15:08:10Z" })).toEqual({
        ...renewed,
        claim: { ...renewed.claim, lapsesAt: "2026-11-07T15:09:10Z" },
      });
      expect(await rowNow(ALEX_ROW)).toMatchObject({ state: "sending", version: 3 });
      expect(await claimNow(ALEX_ROW)).toMatchObject({ claim_no: 1, version: 3 });

      // Once limit 8 holds the row, it is not sending: the claim is lost to its holder, and the claim row stays.
      expect(
        await limit8V12({
          outboxRowId: ALEX_ROW,
          expectVersion: 3,
          outcome: "held",
          heldUntil: "2026-11-08T14:00:00Z",
          at: "2026-11-07T15:08:11Z",
        }),
      ).toEqual({ result: "marked", outboxRowId: ALEX_ROW, version: 4, outcome: "held" });
      expect(await renew({ ...request, at: "2026-11-07T15:08:12Z" })).toEqual({ ...lost, state: "held" });
      expect(await claimNow(ALEX_ROW)).toMatchObject({ claimer: "dispatcher-1", claim_no: 1 });
    },
  );

  it("a part already accepted is not renewed: wrongState with its state", SLOW, async () => {
    await givenLatest("claim-in-order-with-port.json");
    const id = "out-avery-two";
    const now = "2026-11-07T15:07:00Z";
    await addRow(id, "handle-avery");
    expect(await plan(planRequest(id, 1, [WORDS, POLL]))).toMatchObject({ result: "written", version: 2 });
    const [row] = (
      await claimV12({ claimer: "dispatcher-1", recipientHandleId: "handle-avery", now, limit: 10 })
    ).claimed;
    expect(row).toMatchObject({ outboxRowId: id, version: 3, claimedFrom: "checked", claim: { claimNo: 1 } });
    const request = (key: string): RenewClaimRequest => ({
      outboxRowId: id,
      claimer: "dispatcher-1",
      claimNo: 1,
      idempotencyKey: key,
      at: now,
    });
    expect(await renew(request(`${id}/1/1`))).toMatchObject({
      result: "renewed",
      recipient: { stopped: false, chatOpen: true, version: 2 },
    });
    expect(
      await markV12({
        outcome: "sent",
        idempotencyKey: `${id}/1/1`,
        providerMessageId: "linq-test-1301",
        providerOptionIds: null,
        at: now,
      }),
    ).toMatchObject({ result: "marked", row: { state: "sending", version: 4 } });
    expect(await renew(request(`${id}/1/1`))).toEqual({
      error: "wrongState",
      table: "outbox_parts",
      rowId: `${id}/1/1`,
      state: "sent",
    });
    expect(await renew(request(`${id}/2/1`))).toMatchObject({ result: "renewed" });
  });
});

// ---- markPartV12 and markRowV12 ---------------------------------------------------------------------------------------

describe("markPartV12: the row moves with its parts, a failure keeps its message id and Retry-After (T-1135)", () => {
  it("a receipt after a 4006 finds its part by key and moves failed to delivered", SLOW, async () => {
    await ranLatest("mark-failed-4006.json");
    const part = {
      idempotency_key: ALEX_KEY,
      kind: "words",
      state: "failed",
      attempts: 1,
      linq_message_id: null,
      linq_option_ids: null,
      error_code: "4006",
      sent: false,
      delivered: false,
      failed: true,
    };
    expect(await partsNow(ALEX_ROW)).toEqual([part]);
    const exchange = exchangeOf("mark-delivered-by-key.json");
    const request = exchange.request as unknown as {
      outcome: "delivered";
      providerMessageId: string;
      at: string;
      idempotencyKey: string;
    };
    const notFound = { error: "notFound", table: "outbox_parts", rowId: "linq-msg-demo-0101" };
    const before = await everythingNow();
    // With no key, or a key no part holds, no part holds the receipt.
    expect(
      await markV12({
        outcome: "delivered",
        providerMessageId: "linq-msg-demo-0101",
        at: "2026-11-07T15:06:49Z",
      }),
    ).toEqual(notFound);
    expect(await markV12({ ...request, idempotencyKey: "out-none/1/1" })).toEqual(notFound);
    expect(await everythingNow()).toEqual(before);

    // By its key: the part moves failed to delivered and keeps the receipt's message id; its acceptance was never
    // recorded (sent_at null). The row moves sending to delivered: its first delivery.
    expect(await markV12(structuredClone(request))).toEqual(exchange.outcome);
    expect(await partsNow(ALEX_ROW)).toEqual([
      { ...part, state: "delivered", linq_message_id: "linq-msg-demo-0101", delivered: true },
    ]);
    expect(await rowNow(ALEX_ROW)).toMatchObject({ state: "delivered", version: 5 });
    // A second receipt finds it the first way, by its message id: a repeat, the row as it stands.
    expect(
      await markV12({
        outcome: "delivered",
        providerMessageId: "linq-msg-demo-0101",
        at: "2026-11-07T15:06:51Z",
      }),
    ).toMatchObject({ repeated: true, firstDelivery: false, row: { state: "delivered", version: 5 } });
    // A receipt with another message id under the same key is not this part's.
    expect(await markV12({ ...request, providerMessageId: "linq-msg-demo-0199" })).toEqual({
      ...notFound,
      rowId: "linq-msg-demo-0199",
    });
  });

  it(
    "a receipt by key for a part never accepted is refused: K-07 has no pending to delivered",
    SLOW,
    async () => {
      await ranLatest("renew-claim-reads-phone.json");
      const before = await everythingNow();
      expect(
        await markV12({
          outcome: "delivered",
          providerMessageId: "linq-msg-demo-0121",
          at: "2026-11-07T15:06:40Z",
          idempotencyKey: ALEX_KEY,
        }),
      ).toEqual({ error: "wrongState", table: "outbox_parts", rowId: ALEX_KEY, state: "pending" });
      expect(await everythingNow()).toEqual(before);
    },
  );

  it("a failure's message id is kept, so its late receipt finds the part by it", SLOW, async () => {
    await ranLatest("renew-claim-first-send.json");
    expect(
      await markV12({
        outcome: "failed",
        idempotencyKey: ALEX_KEY,
        errorCode: "4001",
        retry: false,
        at: "2026-11-07T15:06:36Z",
        providerMessageId: "linq-msg-demo-0111",
      }),
    ).toEqual({
      result: "marked",
      outboxRowId: ALEX_ROW,
      partNo: 1,
      tryNo: 1,
      attempts: 1,
      repeated: false,
      firstDelivery: false,
      openQuestionId: null,
      nextKey: null,
      row: { state: "sending", version: 4 },
    });
    expect(await partsNow(ALEX_ROW)).toMatchObject([
      { state: "failed", linq_message_id: "linq-msg-demo-0111", error_code: "4001", sent: false },
    ]);
    expect(
      await markV12({
        outcome: "delivered",
        providerMessageId: "linq-msg-demo-0111",
        at: "2026-11-07T15:06:50Z",
      }),
    ).toMatchObject({ repeated: false, firstDelivery: true, row: { state: "delivered", version: 5 } });
  });

  it("the Retry-After waits in the claim across a re-claim; the try that goes clears it", SLOW, async () => {
    await ranLatest("renew-claim-not-yet.json");
    const key = `${ALEX_ROW}/1/2`;
    expect(await claimNow(ALEX_ROW)).toMatchObject({
      claimer: "dispatcher-2",
      claim_no: 2,
      first_try_at: new Date("2026-11-07T15:06:35Z"),
      next_try_not_before: new Date("2026-11-07T15:08:36Z"),
    });
    expect(
      await renew({
        outboxRowId: ALEX_ROW,
        claimer: "dispatcher-2",
        claimNo: 2,
        idempotencyKey: key,
        at: "2026-11-07T15:08:36Z",
      }),
    ).toEqual({
      result: "renewed",
      outboxRowId: ALEX_ROW,
      claim: {
        claimer: "dispatcher-2",
        claimedAt: "2026-11-07T15:07:40Z",
        lapsesAt: "2026-11-07T15:09:36Z",
        claimNo: 2,
        firstTryAt: "2026-11-07T15:06:35Z",
        nextTryNotBefore: null,
      },
      recipient: { stopped: false, chatOpen: true, version: 3 },
    });
    expect(
      await markV12({
        outcome: "sent",
        idempotencyKey: key,
        providerMessageId: "linq-test-1101",
        providerOptionIds: null,
        at: "2026-11-07T15:08:37Z",
      }),
    ).toMatchObject({
      result: "marked",
      tryNo: 2,
      attempts: 2,
      repeated: false,
      row: { state: "sent", version: 6 },
    });
    expect(
      await markV12({
        outcome: "delivered",
        providerMessageId: "linq-test-1101",
        at: "2026-11-07T15:08:40Z",
      }),
    ).toMatchObject({ repeated: false, firstDelivery: true, row: { state: "delivered", version: 7 } });
  });

  it(
    "a Retry-After needs a claim to wait in: a row a v1 claim took has none, so it is refused (default 18)",
    SLOW,
    async () => {
      await given("claim-in-order.json");
      const claimed = await claimOutbox(runtime, {
        claimer: "dispatcher-1",
        recipientHandleId: "handle-alex",
        now: "2026-11-07T15:06:35Z",
        limit: 10,
      });
      expect(claimed).toMatchObject({ claimed: [{ outboxRowId: ALEX_ROW, version: 3 }] });
      expect(await claimNow(ALEX_ROW)).toBeUndefined();
      const before = await everythingNow();
      await expect(
        markPartV12(runtime, {
          outcome: "failed",
          idempotencyKey: ALEX_KEY,
          errorCode: "429",
          retry: true,
          at: "2026-11-07T15:06:36Z",
          providerMessageId: null,
          nextTryNotBefore: "2026-11-07T15:08:36Z",
        }),
      ).rejects.toThrow("no claim");
      expect(await everythingNow()).toEqual(before);
    },
  );
});

describe("markRowV12: waitingChat lets the claim go; the other outcomes keep it (T-1135)", () => {
  it(
    "waitingChat: the row waits with no held_until and no claim, and no claim or renewal takes it",
    SLOW,
    async () => {
      await ranLatest("mark-waiting-chat.json");
      const id = "out-dee-booked-riley";
      expect(await rowNow(id)).toEqual({ state: "waiting_chat", version: 4, held_until: null });
      expect(await claimNow(id)).toBeUndefined();
      const before = await everythingNow();
      expect(
        await claimV12({
          claimer: "dispatcher-2",
          recipientHandleId: "handle-dee",
          now: "2026-11-09T15:02:00Z",
          limit: 10,
        }),
      ).toEqual({ result: "claimed", claimed: [], passedHeld: [] });
      expect(await claimV12({ claimer: "dispatcher-2", now: "2026-11-09T15:02:00Z", limit: 10 })).toEqual({
        result: "claimed",
        claimed: [],
        passedHeld: [],
      });
      expect(
        await renew({
          outboxRowId: id,
          claimer: "dispatcher-1",
          claimNo: 1,
          idempotencyKey: `${id}/1/1`,
          at: "2026-11-09T15:02:00Z",
        }),
      ).toEqual({
        error: "claimLost",
        table: "outbox_rows",
        rowId: id,
        claimer: null,
        claimNo: null,
        state: "waiting_chat",
      });
      expect(await everythingNow()).toEqual(before);
    },
  );

  it("waitingChat clears a held row's held_until once it is claimed again", SLOW, async () => {
    await ranLatest("claim-held-lets-later-pass.json");
    const held = "out-sam-passon-evening";
    const [row] = (
      await claimV12({
        claimer: "dispatcher-3",
        recipientHandleId: "handle-sam",
        now: "2026-11-08T13:00:05Z",
        limit: 1,
      })
    ).claimed;
    expect(row).toMatchObject({ outboxRowId: held, claimedFrom: "held", claim: { claimNo: 2 } });
    expect(await rowNow(held)).toMatchObject({ held_until: new Date("2026-11-08T13:00:00Z") });
    expect(
      await limit8V12({
        outboxRowId: held,
        expectVersion: 5,
        outcome: "waitingChat",
        heldUntil: null,
        at: "2026-11-08T13:00:06Z",
      }),
    ).toEqual({ result: "marked", outboxRowId: held, version: 6, outcome: "waitingChat" });
    expect(await rowNow(held)).toEqual({ state: "waiting_chat", version: 6, held_until: null });
    expect(await claimNow(held)).toBeUndefined();
  });
});

// ==== T-1227: K-05 v1.9 item 48, a repeated delivery receipt says what it repeats ====================================
//
// markPartV12 answers every mark with repeatedDelivery. On a delivery receipt that repeats a recorded delivery it is
// { firstOfRow, deliveredAt }: firstOfRow is true when no other part try of the row holds an earlier delivered_at, a
// tie counting as first (K-05 default 85), and deliveredAt is the part try's stored delivered_at, never the repeat's
// own time (default 86). On every other answer it is null (default 87). A repeat writes nothing, and firstDelivery
// keeps v1's meaning: false on every repeat (default 88). Each answer is checked against v1.9's
// markPart.v1dot9Response and, with its request, as a v1.9 markPart.exchange (markV19), since the answer's definition
// alone cannot see the request.

/** K-05 v1.9's accepted markPart exchanges (T-1226), each on A7-03's two-part row. */
const V19_FIXTURES = INDEX.filter(
  (entry) => entry.version === "v1.9" && entry.expect === "accept" && entry.def === "markPart.exchange",
).map((entry) => entry.file);
/** K-05 v1.9's refused markPart fixtures (T-1226). */
const V19_REFUSED = INDEX.filter(
  (entry) =>
    entry.version === "v1.9" && entry.expect === "refuse" && (entry.def ?? "").startsWith("markPart."),
).map((entry) => entry.file);
/** K-05 v1 to v1.8's accepted markPart exchanges, but T-1136's: none of them repeats a delivery. */
const EARLIER_MARK_FIXTURES = INDEX.filter(
  (entry) =>
    minorOf(entry.version) < 9 &&
    entry.expect === "accept" &&
    entry.def === "markPart.exchange" &&
    !LATER_FIXTURES.includes(entry.file),
).map((entry) => entry.file);

describe("K-05 v1.9's markPart fixtures: each request gives its response (T-1227)", () => {
  const WORDS_REPEAT = "mark-a7-03-delivered-repeat.json";
  const POLL_REPEAT = "mark-a7-03-poll-delivered-repeat.json";
  const refusedAnswer = (file: string): Fields => readJson(new URL(`invalid/${file}`, ACCESS_DIR)) as Fields;

  it("covers v1.9's three accepted and three refused markPart fixtures", () => {
    expect(V19_FIXTURES).toEqual([WORDS_REPEAT, "mark-a7-03-poll-delivered.json", POLL_REPEAT]);
    expect(V19_REFUSED).toEqual([
      "invalid/refuse-mark-repeat-delivery-left-out.json",
      "invalid/refuse-mark-repeat-says-first-delivery.json",
      "invalid/refuse-mark-delivered-repeat-null.json",
    ]);
  });

  for (const file of V19_FIXTURES) {
    it(file, SLOW, async () => {
      const exchange = await givenLatest(file);
      const answer = await runLatest(exchange);
      // The whole answer, repeatedDelivery with it: nothing is left out for a v1.9 exchange.
      expect(fixtureVersion(file)).toBe("v1.9");
      expect(asVersion(exchange.call, answer, fixtureVersion(file))).toEqual(answer);
      expect(answer).toEqual(exchange.outcome);
      expect(latestErrors(exchange.call, answer)).toEqual([]);
      // As an exchange too, with the fixture's own request: is it a delivery receipt, and is the answer a repeat?
      expect(schemaErrors(V19_ID, "markPart.exchange", { ...exchange, outcome: answer })).toEqual([]);
    });
  }

  it(
    "a repeat writes nothing: no row, part or claim changes, and it answers the same again",
    SLOW,
    async () => {
      for (const file of [WORDS_REPEAT, POLL_REPEAT]) {
        const exchange = await givenLatest(file);
        const before = await everythingNow();
        expect(await runLatest(exchange), file).toEqual(exchange.outcome);
        expect(await runLatest(exchange), file).toEqual(exchange.outcome);
        expect(await everythingNow(), file).toEqual(before);
      }
    },
  );

  it(
    "refuse-mark-repeat-delivery-left-out.json: the call's answer to a repeat always states what it repeats",
    SLOW,
    async () => {
      const leftOut = refusedAnswer("refuse-mark-repeat-delivery-left-out.json");
      expect(schemaErrors(V19_ID, "markPart.v1dot9Response", leftOut)).not.toEqual([]);
      const twin = await givenLatest(WORDS_REPEAT);
      const answer = await runLatest(twin);
      // Put right, it is its twin's outcome: what the call answers on that chain.
      expect(answer).toEqual({
        ...leftOut,
        repeatedDelivery: { firstOfRow: true, deliveredAt: "2026-10-23T14:05:04Z" },
      });
      expect(answer).toEqual(twin.outcome);
      expect(schemaErrors(V19_ID, "markPart.v1dot9Response", answer)).toEqual([]);
    },
  );

  it(
    "refuse-mark-repeat-says-first-delivery.json: a repeat of the row's first delivery never says firstDelivery",
    SLOW,
    async () => {
      const saysFirst = refusedAnswer("refuse-mark-repeat-says-first-delivery.json");
      expect(schemaErrors(V19_ID, "markPart.response", saysFirst)).not.toEqual([]);
      const twin = await givenLatest(WORDS_REPEAT);
      const answer = await runLatest(twin);
      // Put right, it is its twin's outcome: firstDelivery false beside the first delivery it repeats.
      expect(answer).toEqual({ ...saysFirst, firstDelivery: false });
      expect(answer).toEqual(twin.outcome);
      expect(schemaErrors(V19_ID, "markPart.response", answer)).toEqual([]);
    },
  );

  it(
    "refuse-mark-delivered-repeat-null.json: a repeated receipt is never answered null; only the exchange refuses it",
    SLOW,
    async () => {
      const file = "invalid/refuse-mark-delivered-repeat-null.json";
      const refused = exchangeOf(file);
      expect(schemaErrors(V19_ID, "markPart.exchange", refused)).not.toEqual([]);
      // Its answer alone passes markPart.v1dot9Response, which cannot see the request (T-1226's security note a): so
      // every answer here is checked as an exchange too.
      expect(schemaErrors(V19_ID, "markPart.v1dot9Response", refused.outcome)).toEqual([]);
      const exchange = await givenLatest(file);
      const answer = await runLatest(exchange);
      // Put right, its outcome is its twin's: the poll's delivery, not the row's first.
      expect(answer).not.toEqual(refused.outcome);
      expect(answer).toEqual(exchangeOf(POLL_REPEAT).outcome);
      expect(schemaErrors(V19_ID, "markPart.exchange", { ...refused, outcome: answer })).toEqual([]);
    },
  );
});

describe("K-05 v1 to v1.8's markPart fixtures: each answer is its outcome with repeatedDelivery null (T-1227)", () => {
  it("covers every earlier accepted markPart exchange but T-1136's", () => {
    expect([...EARLIER_MARK_FIXTURES].sort()).toEqual([
      "mark-a7-03-delivered-by-key.json",
      "mark-a7-03-failed-4006.json",
      "mark-a7-03-poll-failed.json",
      "mark-a7-03-poll-sent.json",
      "mark-delivered-by-key.json",
      "mark-delivered.json",
      "mark-failed-4006.json",
      "mark-failed-retry-after.json",
      "mark-sent.json",
    ]);
  });

  for (const file of EARLIER_MARK_FIXTURES) {
    it(file, SLOW, async () => {
      const exchange = await givenLatest(file);
      const answer = await runLatest(exchange);
      // None of them repeats a delivery: the field is stated, null. v1's exchanges have no row, which the call adds.
      const stated = isRecord(answer) && fixtureVersion(file) === "v1" ? without(answer, ["row"]) : answer;
      expect(stated).toEqual({ ...exchange.outcome, repeatedDelivery: null });
      expect(latestErrors(exchange.call, answer)).toEqual([]);
      expect(schemaErrors(V19_ID, "markPart.exchange", { ...exchange, outcome: answer })).toEqual([]);
    });
  }
});

describe("markPartV12: a repeated delivery receipt says what it repeats (T-1227; K-05 v1.9 item 48)", () => {
  const NOW = "2026-11-07T15:07:00Z";
  const id = "out-avery-repeat";
  const WORDS_MESSAGE = "linq-test-1401";
  const POLL_MESSAGE = "linq-test-1402";
  const keyOf = (partNo: number, tryNo = 1): string => `${id}/${String(partNo)}/${String(tryNo)}`;

  /** The test row, Avery's, with these sends: planned, then claimed by a v1.2 claim (sending, version 3, claim 1). */
  async function claimedV12(sends: Json[]): Promise<void> {
    await givenLatest("claim-in-order-with-port.json");
    await addRow(id, "handle-avery");
    expect(await plan(planRequest(id, 1, sends))).toMatchObject({ result: "written", version: 2 });
    const { claimed } = await claimV12({
      claimer: "dispatcher-1",
      recipientHandleId: "handle-avery",
      now: NOW,
      limit: 10,
    });
    expect(claimed.map((row) => [row.outboxRowId, row.version, row.claim.claimNo])).toEqual([[id, 3, 1]]);
  }

  const sent = (partNo: number, providerMessageId: string, tryNo = 1): MarkPartV12Request => ({
    outcome: "sent",
    idempotencyKey: keyOf(partNo, tryNo),
    providerMessageId,
    providerOptionIds: null,
    at: NOW,
  });
  /** A delivery receipt: Linq's message id and time, and the part's key when it echoes one. */
  const receipt = (providerMessageId: string, at: string, idempotencyKey?: string): MarkPartV12Request =>
    idempotencyKey === undefined
      ? { outcome: "delivered", providerMessageId, at }
      : { outcome: "delivered", providerMessageId, at, idempotencyKey };

  /** markPartV12's whole answer for try 1 of a part of the test row, which asks no question; `fields` over it. */
  const answerOf = (partNo: number, fields: Fields): Fields => ({
    result: "marked",
    outboxRowId: id,
    partNo,
    tryNo: 1,
    attempts: 1,
    repeated: false,
    firstDelivery: false,
    openQuestionId: null,
    nextKey: null,
    repeatedDelivery: null,
    ...fields,
  });
  /** A repeated receipt's whole answer: repeated, never firstDelivery, the row as it stands, and what it repeats. */
  const repeatOf = (
    partNo: number,
    row: Fields,
    firstOfRow: boolean,
    deliveredAt: string,
    fields: Fields = {},
  ): Fields =>
    answerOf(partNo, { repeated: true, row, repeatedDelivery: { firstOfRow, deliveredAt }, ...fields });

  it(
    "a repeat of a row's only delivery: the row's first, at the stored time, never the repeat's own; nothing written",
    SLOW,
    async () => {
      await claimedV12([WORDS]);
      expect(await markV19(sent(1, WORDS_MESSAGE))).toEqual(
        answerOf(1, { row: { state: "sent", version: 4 } }),
      );
      const deliveredAt = "2026-11-07T15:07:04Z";
      expect(await markV19(receipt(WORDS_MESSAGE, deliveredAt))).toEqual(
        answerOf(1, { firstDelivery: true, row: { state: "delivered", version: 5 } }),
      );
      const before = await everythingNow();
      const repeat = repeatOf(1, { state: "delivered", version: 5 }, true, deliveredAt);
      // Linq's retry is the same event, with the same time (STATE note 38's crash before armClock).
      expect(await markV19(receipt(WORDS_MESSAGE, deliveredAt))).toEqual(repeat);
      // A second report of the part may carry another time, later or earlier: the answer is the record's.
      expect(await markV19(receipt(WORDS_MESSAGE, "2026-11-07T15:09:30Z"))).toEqual(repeat);
      expect(await markV19(receipt(WORDS_MESSAGE, "2026-11-07T15:00:00Z", keyOf(1)))).toEqual(repeat);
      // Twenty at once: each answers the same, one after the other under the row's lock.
      const together = await Promise.all(
        Array.from({ length: 20 }, () =>
          settled(() => markPartV12(runtime, receipt(WORDS_MESSAGE, "2026-11-07T15:09:31Z"))),
        ),
      );
      expect(together).toEqual(Array.from({ length: 20 }, () => repeat));
      expect(await everythingNow()).toEqual(before);
    },
  );

  it(
    "a repeat of a later part's delivery says firstOfRow false; the first part's repeat says true, before and after",
    SLOW,
    async () => {
      await claimedV12([WORDS, POLL]);
      const wordsAt = "2026-11-07T15:07:04Z";
      const pollAt = "2026-11-07T15:07:06Z";
      expect(await markV19(sent(1, WORDS_MESSAGE))).toEqual(
        answerOf(1, { row: { state: "sending", version: 4 } }),
      );
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toEqual(
        answerOf(1, { firstDelivery: true, row: { state: "sending", version: 5 } }),
      );
      // The words' receipt again while the poll is still to go: the row's first delivery.
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toEqual(
        repeatOf(1, { state: "sending", version: 5 }, true, wordsAt),
      );
      expect(await markV19(sent(2, POLL_MESSAGE))).toEqual(
        answerOf(2, { row: { state: "sent", version: 6 } }),
      );
      // The poll's delivery is recorded: the row's second, and no repeat.
      expect(await markV19(receipt(POLL_MESSAGE, pollAt))).toEqual(
        answerOf(2, { row: { state: "delivered", version: 7 } }),
      );
      const before = await everythingNow();
      const row = { state: "delivered", version: 7 };
      expect(await markV19(receipt(POLL_MESSAGE, pollAt))).toEqual(repeatOf(2, row, false, pollAt));
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toEqual(repeatOf(1, row, true, wordsAt));
      expect(await everythingNow()).toEqual(before);
    },
  );

  it("two parts delivered at one time: a tie counts as first for each", SLOW, async () => {
    await claimedV12([WORDS, POLL]);
    const at = "2026-11-07T15:07:04Z";
    expect(await markV19(sent(1, WORDS_MESSAGE))).toMatchObject({ repeated: false, repeatedDelivery: null });
    expect(await markV19(sent(2, POLL_MESSAGE))).toEqual(answerOf(2, { row: { state: "sent", version: 5 } }));
    expect(await markV19(receipt(WORDS_MESSAGE, at))).toEqual(
      answerOf(1, { firstDelivery: true, row: { state: "sent", version: 6 } }),
    );
    expect(await markV19(receipt(POLL_MESSAGE, at))).toEqual(
      answerOf(2, { row: { state: "delivered", version: 7 } }),
    );
    const before = await everythingNow();
    const row = { state: "delivered", version: 7 };
    expect(await markV19(receipt(WORDS_MESSAGE, at))).toEqual(repeatOf(1, row, true, at));
    expect(await markV19(receipt(POLL_MESSAGE, at))).toEqual(repeatOf(2, row, true, at));
    expect(await everythingNow()).toEqual(before);
  });

  it(
    "receipts recorded out of the order of their times: a repeat reads the row's first delivery from the times",
    SLOW,
    async () => {
      await claimedV12([WORDS, POLL]);
      const wordsAt = "2026-11-07T15:07:04Z";
      const pollAt = "2026-11-07T15:07:16Z";
      expect(await markV19(sent(1, WORDS_MESSAGE))).toMatchObject({
        repeated: false,
        repeatedDelivery: null,
      });
      expect(await markV19(sent(2, POLL_MESSAGE))).toMatchObject({ repeated: false, repeatedDelivery: null });
      // The poll's receipt is recorded first and says firstDelivery; the words' receipt, late, holds the earlier time.
      expect(await markV19(receipt(POLL_MESSAGE, pollAt))).toEqual(
        answerOf(2, { firstDelivery: true, row: { state: "sent", version: 6 } }),
      );
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toEqual(
        answerOf(1, { row: { state: "delivered", version: 7 } }),
      );
      const before = await everythingNow();
      const row = { state: "delivered", version: 7 };
      // By the times the record holds (K-05 default 85; open gap 54): the earlier-timed delivery is the row's first.
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toEqual(repeatOf(1, row, true, wordsAt));
      expect(await markV19(receipt(POLL_MESSAGE, pollAt))).toEqual(repeatOf(2, row, false, pollAt));
      expect(await everythingNow()).toEqual(before);
    },
  );

  it(
    "a late receipt of an earlier try after a 4006: each try's repeat is read by the times, across the part's tries",
    SLOW,
    async () => {
      await claimedV12([WORDS]);
      const minute = "2026-11-07T15:08:00Z";
      const failure = { outcome: "failed", idempotencyKey: keyOf(1), errorCode: "4006" } as const;
      expect(await markV19({ ...failure, retry: false, at: NOW })).toEqual(
        answerOf(1, { row: { state: "sending", version: 4 } }),
      );
      // K-07 rule 2: no receipt within a minute, so the next try under a new key.
      expect(await markV19({ ...failure, retry: true, at: minute })).toEqual(
        answerOf(1, { nextKey: keyOf(1, 2), row: { state: "sending", version: 5 } }),
      );
      const retryMessage = "linq-test-1403";
      const retryAt = "2026-11-07T15:08:10Z";
      const lateAt = "2026-11-07T15:07:30Z";
      expect(await markV19(sent(1, retryMessage, 2))).toEqual(
        answerOf(1, { tryNo: 2, row: { state: "sent", version: 6 } }),
      );
      expect(await markV19(receipt(retryMessage, retryAt))).toEqual(
        answerOf(1, { tryNo: 2, firstDelivery: true, row: { state: "delivered", version: 7 } }),
      );
      // The first try's receipt comes late, with its earlier time, found by its key (a 4006 gave no message id).
      expect(await markV19(receipt(WORDS_MESSAGE, lateAt, keyOf(1)))).toEqual(
        answerOf(1, { row: { state: "delivered", version: 8 } }),
      );
      const before = await everythingNow();
      const row = { state: "delivered", version: 8 };
      expect(await markV19(receipt(WORDS_MESSAGE, lateAt, keyOf(1)))).toEqual(repeatOf(1, row, true, lateAt));
      expect(await markV19(receipt(retryMessage, retryAt))).toEqual(
        repeatOf(1, row, false, retryAt, { tryNo: 2 }),
      );
      expect(await everythingNow()).toEqual(before);
    },
  );

  it(
    "an attempt, a sent mark and a failure, each also when repeated, state repeatedDelivery null",
    SLOW,
    async () => {
      await claimedV12([WORDS, POLL]);
      const sending = (version: number): Fields => ({ state: "sending", version });
      expect(await markV19({ outcome: "attempt", idempotencyKey: keyOf(1), at: NOW })).toEqual(
        answerOf(1, { attempts: 2, row: sending(4) }),
      );
      expect(await markV19(sent(1, WORDS_MESSAGE))).toEqual(answerOf(1, { attempts: 2, row: sending(5) }));
      expect(await markV19(sent(1, WORDS_MESSAGE))).toEqual(
        answerOf(1, { attempts: 2, repeated: true, row: sending(5) }),
      );
      const failure: MarkPartV12Request = {
        outcome: "failed",
        idempotencyKey: keyOf(2),
        errorCode: "poll.failed",
        retry: true,
        at: NOW,
      };
      expect(await markV19(failure)).toEqual(answerOf(2, { nextKey: keyOf(2, 2), row: sending(6) }));
      expect(await markV19(failure)).toEqual(
        answerOf(2, { repeated: true, nextKey: keyOf(2, 2), row: sending(6) }),
      );
      expect(await markV19(receipt(WORDS_MESSAGE, "2026-11-07T15:07:04Z"))).toEqual(
        answerOf(1, { attempts: 2, firstDelivery: true, row: sending(7) }),
      );
      // A sent mark repeated after its part's delivery is no delivery receipt: null, though the part is delivered.
      expect(await markV19(sent(1, WORDS_MESSAGE))).toEqual(
        answerOf(1, { attempts: 2, repeated: true, row: sending(7) }),
      );
    },
  );

  it(
    "a delivered part that holds no delivered_at fails loudly, never by a guess, and nothing is written",
    SLOW,
    async () => {
      await claimedV12([WORDS, POLL]);
      const wordsAt = "2026-11-07T15:07:04Z";
      const pollAt = "2026-11-07T15:07:06Z";
      expect(await markV19(sent(1, WORDS_MESSAGE))).toMatchObject({
        repeated: false,
        repeatedDelivery: null,
      });
      expect(await markV19(sent(2, POLL_MESSAGE))).toMatchObject({ repeated: false, repeatedDelivery: null });
      expect(await markV19(receipt(WORDS_MESSAGE, wordsAt))).toMatchObject({ firstDelivery: true });
      expect(await markV19(receipt(POLL_MESSAGE, pollAt))).toMatchObject({ row: { state: "delivered" } });
      // No K-05 call leaves a delivered part without its time, and K-04 v1 has no CHECK against it: the tables' owner
      // takes the poll's away here.
      await db.sql`
        update outbox_parts set delivered_at = null, version = version + 1 where idempotency_key = ${keyOf(2)}
      `;
      const before = await everythingNow();
      // The repeated part try itself holds no time to answer with.
      await expect(markPartV12(runtime, receipt(POLL_MESSAGE, pollAt))).rejects.toThrow(
        "a delivered part holds no delivered_at",
      );
      // Nor can the words' repeat say whether theirs was the row's first: another delivered part try holds no time.
      await expect(markPartV12(runtime, receipt(WORDS_MESSAGE, wordsAt))).rejects.toThrow(
        "a delivered part holds no delivered_at",
      );
      expect(await everythingNow()).toEqual(before);
      // A mark that is no delivery receipt reads none of it, and v1's markPart answers its repeat as it always did.
      expect(await markV19(sent(1, WORDS_MESSAGE))).toMatchObject({ repeated: true, repeatedDelivery: null });
      expect(await mark({ outcome: "delivered", providerMessageId: POLL_MESSAGE, at: pollAt })).toEqual({
        result: "marked",
        outboxRowId: id,
        partNo: 2,
        tryNo: 1,
        attempts: 1,
        repeated: true,
        firstDelivery: false,
        openQuestionId: null,
        nextKey: null,
      });
      expect(await everythingNow()).toEqual(before);
    },
  );
});

// ---- the claim's recipient lock, in this file's own database (T-1251) -------------------------------------------------

describe("claimOutbox's recipient lock is this file's database's own, never another run's (T-1251, CQ-221)", () => {
  it(
    "a recipient's lock held in the shared database stops no claim here; held in this file's database, it does",
    SLOW,
    async () => {
      // A recipient named after this run's schema, so its lock held in the shared database is no other run's; its one
      // row checked, as the parallel claim's rows are written.
      const recipient = `handle-${db.schema}`;
      const rowId = `out-${db.schema}`;
      const rowPlan = { row: rowId, channel: "imessage", copyOf: null, plan: PLAN_BODY };
      const finalParts = {
        row: rowId,
        channel: "imessage",
        sends: [WORDS],
        fixedLines: [],
        slotValues: [],
        threadReplyTo: null,
      };
      await reset();
      await loadSeeds(["seed-bundle-registry.json"]);
      await db.sql.begin(async (tx) => {
        await insertRow(tx, "handles", { id: recipient, kind: "phone", address: "+15555550198" });
        await tx`
          insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
          values ('turn-t1251', ${recipient}, ${["evt-t1251-1"]}, 'committed', ${BUNDLE_HASH}, 1, 'trace-t1251',
                  '2026-11-09T14:59:00Z')
        `;
        await tx`
          insert into outbox_rows (
            id, turn_id, recipient_handle_id, channel, send_class, versions_read, plan, final_parts, state,
            bundle_hash, bundle_build, trace_id
          )
          values (
            ${rowId}, 'turn-t1251', ${recipient}, 'imessage', 'routine', '[]'::jsonb, ${tx.json(rowPlan)}::jsonb,
            ${tx.json(finalParts)}::jsonb, 'checked', ${BUNDLE_HASH}, 1, 'trace-t1251'
          )
        `;
      });
      const request: ClaimOutboxRequest = {
        claimer: "dispatcher-1",
        recipientHandleId: recipient,
        now: "2026-11-09T15:00:00Z",
        limit: 10,
      };
      // A session in the database DATABASE_URL names, where another run's claims take their locks, and one in this
      // file's own.
      const shared = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
      const here = db.connect({ max: 1, onnotice: () => undefined });
      /** The claim, run while `holder` holds the recipient's lock as the claim takes it (outbox.ts default 10). */
      const claimWhileHeld = (holder: Sql): Promise<ClaimOutboxResponse> =>
        holder.begin(async (tx) => {
          const [lock] = await tx<{ taken: boolean }[]>`
            select pg_try_advisory_xact_lock(hashtextextended(${`outbox-recipient:${recipient}`}, 0)) as taken
          `;
          expect(lock?.taken, "the holder takes the recipient's lock").toBe(true);
          return claim(request);
        });
      try {
        const [sharedDatabase] = await shared<{ name: string }[]>`select current_database() as name`;
        const [ownDatabase] = await here<{ name: string }[]>`select current_database() as name`;
        expect(ownDatabase?.name).toBe(db.schema);
        expect(sharedDatabase?.name).not.toBe(db.schema);
        // Held in this file's database, it is the claim's own lock: the recipient is skipped, nothing is written.
        expect(await claimWhileHeld(here)).toEqual({ result: "claimed", claimed: [], passedHeld: [] });
        expect(await rowNow(rowId)).toMatchObject({ state: "checked", version: 1 });
        // Held in the shared database, as another run's claim of a recipient of the same id holds it: not seen here.
        const taken = await claimWhileHeld(shared);
        expect(taken.claimed.map((row) => [row.outboxRowId, row.version])).toEqual([[rowId, 2]]);
        expect(await rowNow(rowId)).toMatchObject({ state: "sending", version: 2 });
      } finally {
        await shared.end({ timeout: 5 });
        await here.end({ timeout: 5 });
      }
    },
  );
});
