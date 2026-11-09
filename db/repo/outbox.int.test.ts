// T-196: K-05 v1 items 2 to 4, write a plan, list the rows a crash left unplanned, claim outbox rows in commit order
// and move a row's parts, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/outbox`). The
// schema comes from migrating a fresh test schema (db/repo/test-db.ts); the public schema is never touched.
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
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import {
  claimOutbox,
  type ClaimOutboxRequest,
  type ClaimOutboxResponse,
  markPart,
  type MarkPartOutcome,
  type MarkPartRequest,
  markRow,
  type MarkRowOutcome,
  type MarkRowRequest,
  type Move,
  PART_MOVES,
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
  db = await createTestDatabase({ name: "outbox" });
  runtime = postgres(resolvePrimaryUrl(), {
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

afterAll(async () => {
  await runtime.end({ timeout: 5 });
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
