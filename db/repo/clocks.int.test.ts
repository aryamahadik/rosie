// T-197: K-05 v1's clock calls (armClock, cancelClock, dueClocks, fireClock: README items 5 to 7) against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/clocks`). The schema comes from migrating a fresh
// test schema (db/repo/test-db.ts); the public schema is never touched.
//
// Every call runs as K-05 states it (README "Scope": runtime; T-191's roles): through a client whose connections run as
// rosie_job, the runtime side's role (the sweep's job role), with no business scope at the start of each transaction, so
// the grants and row-level security are the ones the calls meet. The tables' owner (the migrations' role) loads K-04's
// seeds and writes the rows a fixture's `given` names.
//
// A fixture's `given.after` names the exchanges that run first, each with its own `given`. commitTurn (T-195) and this
// task's four calls run for real in every chain. The plan, claim and mark calls are other tasks', so each of those steps
// writes, as the owner, the rows its exchange states in its request and its outcome: what the call that follows sees.
// Each answer is checked against data-access v1.1 with Ajv 2020-12, strict, as contracts:check runs it.
//
// T-1185: a firing's state write gives a bytea column in K-04's text form ("\x" and hex), written as the bytes it
// spells; a sealed value opens with its person's key (sealing.ts, under a wrapping key made here from random bytes for
// the run and never written to a file), and any other form is thrown with nothing written.
//
// T-1437 (DL-927, DL-935): a firing takes the targets a turn's commit takes, through commit-turn.ts's own helpers. Its
// tests add setup parts' seeds of fixture set v1's demo shops (K-22, K-23 and K-27: Lee's Barbershop, Lee Home Services,
// the movers and the master's sample cast), each with its chain, as the tables' owner, over what a fixture's `given`
// loaded; a row a firing writes there is one of those rows, or a seed row under a new id. A two-column row is named by
// K-05 v1.18 item 77's "/" name, compared under the businesses the firing writes; a row of a table scoped none (sessions,
// accounts, proof codes, calendar links, busy blocks) only under T-667 round 2's rules (items 8a and 8b), with the clock
// row's business and its handle's people; and no update moves a row of a business to another business (item 8d).
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import {
  armClock,
  type ArmClockRequest,
  cancelClock,
  type CancelClockRequest,
  DataAccessDatabaseError,
  dueClocks,
  type DueClocksRequest,
  dueForHandle,
  dueForSweep,
  fireClock,
  type FireClockOutcome,
  type FireClockRequest,
} from "./clocks";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import type { Sql, Tx } from "./scope";
import { DEFAULT_WRAPPING_KEY_NAME, seal, unsealText, type WrappingKeys } from "./sealing";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Step = (exchange: Exchange) => Promise<void>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };
const CLOCK_ROW = "clock-oq-a7-03-alex";
const QUESTION = "oq-a7-03-alex";

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
/** A fresh copy of a fixture's request, as each call's own type. */
const requestOf = (file: string): unknown => structuredClone(exchangeOf(file).request);
const armRequest = (): ArmClockRequest => requestOf("arm-clock.json") as ArmClockRequest;
const cancelRequest = (): CancelClockRequest => requestOf("cancel-clock.json") as CancelClockRequest;
const fireRequest = (): FireClockRequest => requestOf("fire-once.json") as FireClockRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const CLOCK_DEFS = ["armClock.exchange", "cancelClock.exchange", "dueClocks.exchange", "fireClock.exchange"];
const CLOCK_FIXTURES = INDEX.filter((entry) => CLOCK_DEFS.includes(entry.def ?? "")).map(
  (entry) => entry.file,
);

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One wrapping key per run (T-1185's test): random, in memory only, named like the Workers secret. */
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_KEY : undefined),
};
const PAUSE_ID = "pause-alex-address-t1185";

/** Bytes in K-04's text form, "\x" and lower-case hex: how actions' byteaText puts a sealed value into a write. */
const byteaText = (bytes: Uint8Array): string =>
  `\\x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

// ---- the contract's own schema, for every request and answer (Ajv 2020-12, strict, as contracts:check runs it) ------

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
const V11_ID = (readJson(new URL("data-access/data-access.v1.1.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.1, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V11_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.1 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** A call's answer checked against its own definition: an error against <call>.errors, else <call>.response. */
function answerErrors(call: string, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(`${call}.${isError ? "errors" : "response"}`, outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

beforeAll(async () => {
  db = await createTestDatabase({ name: "clocks" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 20,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t197-clocks",
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

// ---- the steps a chain runs first -----------------------------------------------------------------------------------

async function expectOne(rows: Promise<readonly unknown[]>, what: string): Promise<void> {
  expect((await rows).length, what).toBe(1);
}

/** The calls under test and commitTurn, for real, as rosie_job: each must answer its exchange's outcome. */
async function realStep(exchange: Exchange): Promise<void> {
  const answer = await callOf(exchange);
  expect(answer).toEqual(exchange.outcome);
}

async function callOf(exchange: Exchange): Promise<unknown> {
  switch (exchange.call) {
    case "commitTurn":
      return commitTurn(runtime, exchange.request as unknown as CommitTurnRequest, {
        now: new Date(exchange.given.now),
      });
    case "armClock":
      return armClock(runtime, exchange.request as unknown as ArmClockRequest);
    case "cancelClock":
      return cancelClock(runtime, exchange.request as unknown as CancelClockRequest);
    case "dueClocks":
      return dueClocks(runtime, exchange.request as unknown as DueClocksRequest);
    case "fireClock":
      return fireClock(runtime, exchange.request as unknown as FireClockRequest);
    default:
      throw new Error(`this test calls no ${exchange.call}`);
  }
}

/** writePlan: the plan and final parts, the row checked, its version raised (K-05 item 2; K-07). */
async function writePlanStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as {
    outboxRowId: string;
    expectVersion: number;
    plan: Json;
    finalParts: Json;
  };
  const { version } = exchange.outcome as { version: number };
  await expectOne(
    db.sql`
      update outbox_rows set plan = ${db.sql.json(request.plan)}, final_parts = ${db.sql.json(request.finalParts)},
        state = 'checked', version = ${version}
      where id = ${request.outboxRowId} and version = ${request.expectVersion}
      returning id
    `,
    "writePlan",
  );
}

interface ClaimedRow {
  outboxRowId: string;
  version: number;
  finalParts: { sends: { kind: string }[] };
  parts: { partNo: number; tryNo: number; idempotencyKey: string; attempts: number }[];
}

/** claimOutbox: each claimed row sending at its new version, its parts pending. */
async function claimStep(exchange: Exchange): Promise<void> {
  for (const claimed of exchange.outcome.claimed as unknown as ClaimedRow[]) {
    await expectOne(
      db.sql`
        update outbox_rows set state = 'sending', version = ${claimed.version}
        where id = ${claimed.outboxRowId} returning id
      `,
      "claim",
    );
    for (const part of claimed.parts) {
      await insertRow(db.sql, "outbox_parts", {
        outbox_row_id: claimed.outboxRowId,
        part_no: part.partNo,
        try_no: part.tryNo,
        idempotency_key: part.idempotencyKey,
        attempts: part.attempts,
        kind: claimed.finalParts.sends[part.partNo - 1]?.kind ?? "words",
        state: "pending",
      });
    }
  }
}

/** markPart: the part failed or delivered as its request says, and the row at the state and version its outcome gives. */
async function markPartStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as {
    outcome: string;
    at: string;
    errorCode?: string | null;
    providerMessageId?: string | null;
  };
  const outcome = exchange.outcome as {
    outboxRowId: string;
    partNo: number;
    tryNo: number;
    row: { state: string; version: number };
  };
  const key = `${outcome.outboxRowId}/${String(outcome.partNo)}/${String(outcome.tryNo)}`;
  if (request.outcome === "failed") {
    await expectOne(
      db.sql`
        update outbox_parts set state = 'failed', failed_at = ${request.at}, error_code = ${request.errorCode ?? null},
          version = version + 1
        where idempotency_key = ${key} returning idempotency_key
      `,
      "markPart failed",
    );
  } else if (request.outcome === "delivered") {
    await expectOne(
      db.sql`
        update outbox_parts set state = 'delivered', delivered_at = ${request.at},
          linq_message_id = coalesce(linq_message_id, ${request.providerMessageId ?? null}), version = version + 1
        where idempotency_key = ${key} returning idempotency_key
      `,
      "markPart delivered",
    );
  } else {
    throw new Error("this test's markPart step writes failed and delivered only");
  }
  await expectOne(
    db.sql`
      update outbox_rows set state = ${outcome.row.state}, version = ${outcome.row.version}
      where id = ${outcome.outboxRowId} returning id
    `,
    "markPart row",
  );
}

/** The chain steps, by call. */
const STEPS: Readonly<Record<string, Step>> = {
  commitTurn: realStep,
  armClock: realStep,
  cancelClock: realStep,
  dueClocks: realStep,
  fireClock: realStep,
  writePlan: writePlanStep,
  claimOutbox: claimStep,
  markPart: markPartStep,
};

/** Loads a fixture's seeds and runs its chain, so the database holds what its `given` says. */
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
    const run = STEPS[before.call];
    if (run === undefined) {
      throw new Error(`${step}: this test runs no ${before.call} step`);
    }
    await run(before);
  }
  return exchange;
}

// ---- what a call leaves behind ---------------------------------------------------------------------------------------

const VERSIONED = [
  "businesses",
  "persons",
  "phones",
  "bookings",
  "reservations",
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "outbox_parts",
  "effects",
];
const WRITTEN_ONCE = ["handles", "event_log"];

/** Every table's row count, and for a versioned one the sum of its versions: equal before and after = nothing written. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of VERSIONED) {
    const [row] = await db.sql<{ n: number; v: number }[]>`
      select count(*)::int as n, coalesce(sum(version), 0)::int as v from ${db.sql(table)}
    `;
    out[table] = `${String(row?.n)} rows, versions ${String(row?.v)}`;
  }
  for (const table of WRITTEN_ONCE) {
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)}`;
    out[table] = `${String(row?.n)} rows`;
  }
  return out;
}

interface ClockState {
  state: string;
  version: number;
  due_at: Date | null;
  due_zone: string | null;
  armed_at: Date | null;
  fired_at: Date | null;
  cancelled_at: Date | null;
}

async function clockRow(id: string): Promise<ClockState | undefined> {
  const [row] = await db.sql<ClockState[]>`
    select state, version, due_at, due_zone, armed_at, fired_at, cancelled_at from clock_rows where id = ${id}
  `;
  return row;
}

async function question(id: string): Promise<{ status: string; version: number; closed_at: Date | null }> {
  const [row] = await db.sql<{ status: string; version: number; closed_at: Date | null }[]>`
    select status, version, closed_at from open_questions where id = ${id}
  `;
  if (row === undefined) {
    throw new Error("no such open question");
  }
  return row;
}

const iso = (date: Date | null | undefined): string | null =>
  date === null || date === undefined ? null : date.toISOString().replace(".000Z", "Z");

function fired(outcome: FireClockOutcome): Extract<FireClockOutcome, { result: "fired" }> {
  if (!("result" in outcome)) {
    throw new Error(`expected a firing, got ${outcome.error}`);
  }
  return outcome;
}

/** An armed clock row a handle owns, written by the owner, for the due reads' tests. */
async function armedRow(id: string, handleId: string | null, dueAt: string, state = "armed"): Promise<void> {
  await insertRow(db.sql, "clock_rows", {
    id,
    kind: handleId === null ? "job" : "step",
    handle_id: handleId,
    business_id: "biz-lees-barbershop",
    due_at: dueAt,
    due_zone: "America/New_York",
    state,
    armed_at: state === "armed" ? "2026-10-20T12:00:00Z" : null,
    fires:
      handleId === null ? { job: "test-job" } : { step: "A7-03", safeDefault: "the time stays as booked" },
  });
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** This file's calls (rosie_job's connections) that wait on a lock now. */
async function lockWaiters(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where application_name = 'rosie-t197-clocks' and wait_event_type = 'Lock'
  `;
  return row?.n ?? 0;
}

/** Waits until at least `count` of the calls wait on a lock (at most 15 s). */
async function untilLockWaiters(count: number): Promise<void> {
  const until = Date.now() + 15_000;
  while ((await lockWaiters()) < count) {
    if (Date.now() > until) {
      throw new Error(`fewer than ${String(count)} calls came to wait on a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `calls` while the owner holds the clock row's lock (FOR UPDATE), and lets go only once `waiting` of them wait on
 * a lock, so they all reach the row together instead of one after another.
 */
async function racingOn<T>(clockRowId: string, waiting: number, calls: () => Promise<T>[]): Promise<T[]> {
  const taken = deferred();
  const letGo = deferred();
  const holder = db.sql.begin(async (tx) => {
    await tx`select id from clock_rows where id = ${clockRowId} for update`;
    taken.resolve();
    await letGo.promise;
  });
  await taken.promise;
  const running = Promise.all(calls());
  try {
    await untilLockWaiters(waiting);
  } finally {
    letGo.resolve();
    await holder;
  }
  return running;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the runtime side the calls run on (K-05 README 'Scope'; T-191)", () => {
  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await runtime<{ who: string; path: string; scope: string | null }[]>`
      select current_user as who, current_setting('search_path') as path,
             current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.path).toBe(`${db.schema}, public`);
    expect(row?.scope ?? "").toBe("");
  });
});

describe("each K-05 clock fixture's request gives its response (K-05 v1 items 5 to 7)", () => {
  it("the index lists seven clock exchanges, each valid against data-access v1.1 (Ajv strict)", () => {
    expect([...CLOCK_FIXTURES].sort()).toEqual([
      "arm-clock-a7-03-after-4006.json",
      "arm-clock.json",
      "cancel-clock.json",
      "due-for-handle.json",
      "due-for-sweep.json",
      "fire-once.json",
      "fire-repeat.json",
    ]);
    for (const file of CLOCK_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(schemaErrors(`${exchange.call}.exchange`, exchange), file).toEqual([]);
      expect(schemaErrors(`${exchange.call}.request`, exchange.request), file).toEqual([]);
      expect(answerErrors(exchange.call, exchange.outcome), file).toEqual([]);
    }
  });

  for (const file of CLOCK_FIXTURES) {
    it(`${file}: as rosie_job, the call answers the fixture's outcome`, SLOW, async () => {
      const exchange = await given(file);
      const before = await snapshot();
      const outcome = await callOf(exchange);
      expect(outcome).toEqual(exchange.outcome);
      expect(answerErrors(exchange.call, outcome)).toEqual([]);

      const repeated = (outcome as { repeated?: boolean }).repeated === true;
      if (exchange.call === "dueClocks" || repeated) {
        // A read, and a repeat, write nothing.
        expect(await snapshot()).toEqual(before);
        return;
      }
      const row = await clockRow(CLOCK_ROW);
      if (exchange.call === "armClock") {
        const request = exchange.request as { deliveredAt: string; dueAt: string; dueZone: string };
        expect([row?.state, row?.version, iso(row?.armed_at), iso(row?.due_at), row?.due_zone]).toEqual([
          "armed",
          2,
          request.deliveredAt,
          request.dueAt,
          request.dueZone,
        ]);
        // K-05 default 8: its open question moves from waiting to open in the same transaction.
        expect(await question(QUESTION)).toMatchObject({ status: "open", version: 2 });
      } else if (exchange.call === "cancelClock") {
        expect([row?.state, row?.version, iso(row?.cancelled_at)]).toEqual([
          "cancelled",
          2,
          exchange.request.at,
        ]);
        expect(await question(QUESTION)).toMatchObject({ status: "withdrawn", version: 2 });
      } else {
        // fire-once: the row fired at firedAt, with its turn, its one outbox row and its entry, in one transaction.
        expect([row?.state, row?.version, iso(row?.fired_at)]).toEqual([
          "fired",
          3,
          exchange.request.firedAt,
        ]);
        const [turn] = await db.sql<{ state: string; event_ids: string[]; committed_at: Date }[]>`
          select state, event_ids, committed_at from turns where id = 'turn-clock-oq-a7-03-alex'
        `;
        expect([turn?.state, turn?.event_ids, iso(turn?.committed_at)]).toEqual([
          "committed",
          [CLOCK_ROW],
          exchange.request.firedAt,
        ]);
        expect(await question(QUESTION)).toMatchObject({ status: "defaulted", version: 3 });
        const entries = await db.sql<
          { id: string; turn_id: string | null; job_id: string | null; trace_id: string }[]
        >`
          select id, turn_id, job_id, trace_id from event_log where turn_id = 'turn-clock-oq-a7-03-alex'
        `;
        expect(entries).toEqual([
          {
            id: "log-oq-a7-03-alex-defaulted",
            turn_id: "turn-clock-oq-a7-03-alex",
            job_id: "job-fire-clock-oq-a7-03-alex",
            trace_id: "trace-clock-oq-a7-03-alex",
          },
        ]);
      }
    });
  }
});

describe("armClock: arm at the first delivery receipt (K-05 item 5)", () => {
  it(
    "a second receipt arms nothing twice: the first arming comes back with repeated true",
    SLOW,
    async () => {
      const exchange = await given("arm-clock.json");
      await realStep(exchange);
      const before = await snapshot();
      const later = await armClock(runtime, {
        openQuestionId: QUESTION,
        deliveredAt: "2026-10-23T14:09:00Z",
        dueAt: "2026-10-24T14:09:00Z",
        dueZone: "America/Chicago",
      });
      expect(later).toEqual({ ...exchange.outcome, repeated: true });
      expect(answerErrors("armClock", later)).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("named by its clock row, it arms that row, as by its question", SLOW, async () => {
    const exchange = await given("arm-clock.json");
    const request = armRequest();
    const outcome = await armClock(runtime, {
      clockRowId: CLOCK_ROW,
      deliveredAt: request.deliveredAt,
      dueAt: request.dueAt,
      dueZone: request.dueZone,
    });
    expect(outcome).toEqual(exchange.outcome);
  });

  it("20 parallel receipts for one question arm its row once", SLOW, async () => {
    const exchange = await given("arm-clock.json");
    const request = armRequest();
    // The receipts start while the row is locked, and run once 10 of them wait on a lock: they reach it together.
    const outcomes = await racingOn(CLOCK_ROW, 10, () =>
      Array.from({ length: 20 }, () => armClock(runtime, structuredClone(request))),
    );
    const first = outcomes.filter((each) => "result" in each && !each.repeated);
    expect(first).toEqual([exchange.outcome]);
    for (const each of outcomes) {
      expect(each).toEqual({ ...exchange.outcome, repeated: "result" in each && each.repeated });
    }
    expect((await clockRow(CLOCK_ROW))?.version).toBe(2);
    expect(await question(QUESTION)).toMatchObject({ status: "open", version: 2 });
  });

  it("a cancelled or fired row answers clockClosed and nothing arms", SLOW, async () => {
    const request = armRequest();
    await given("cancel-clock.json");
    await realStep(exchangeOf("cancel-clock.json"));
    let before = await snapshot();
    const onCancelled = await armClock(runtime, request);
    expect(onCancelled).toEqual({ error: "clockClosed", clockRowId: CLOCK_ROW, state: "cancelled" });
    expect(answerErrors("armClock", onCancelled)).toEqual([]);
    expect(await snapshot()).toEqual(before);

    await given("fire-repeat.json");
    before = await snapshot();
    const onFired = await armClock(runtime, request);
    expect(onFired).toEqual({ error: "clockClosed", clockRowId: CLOCK_ROW, state: "fired" });
    expect(await snapshot()).toEqual(before);
  });

  it(
    "notFound: no such clock row, no such question, or a question with no clock row of its own",
    SLOW,
    async () => {
      await given("arm-clock.json");
      const times = {
        deliveredAt: "2026-10-23T14:05:04Z",
        dueAt: "2026-10-24T14:05:04Z",
        dueZone: "America/New_York",
      };
      expect(await armClock(runtime, { clockRowId: "clock-unknown", ...times })).toEqual({
        error: "notFound",
        table: "clock_rows",
        rowId: "clock-unknown",
      });
      expect(await armClock(runtime, { openQuestionId: "oq-unknown", ...times })).toEqual({
        error: "notFound",
        table: "open_questions",
        rowId: "oq-unknown",
      });
      const [asked] = await db.sql<
        Record<string, Json>[]
      >`select * from open_questions where id = ${QUESTION}`;
      await insertRow(db.sql, "open_questions", { ...asked, id: "oq-a7-03-alex-again", version: 1 });
      const noClock = await armClock(runtime, { openQuestionId: "oq-a7-03-alex-again", ...times });
      expect(noClock).toEqual({ error: "notFound", table: "clock_rows", rowId: "oq-a7-03-alex-again" });
      expect(answerErrors("armClock", noClock)).toEqual([]);
    },
  );

  it(
    "its question moves to open only from waiting: a question already open is left as it is",
    SLOW,
    async () => {
      await given("arm-clock.json");
      await db.sql`update open_questions set status = 'open', version = 2 where id = ${QUESTION}`;
      const outcome = await armClock(runtime, armRequest());
      expect("result" in outcome && !outcome.repeated).toBe(true);
      expect(await question(QUESTION)).toMatchObject({ status: "open", version: 2 });
    },
  );

  it("a request it cannot carry out is thrown before anything is read", async () => {
    const times = { deliveredAt: "2026-10-23T14:05:04Z", dueAt: "2026-10-24T14:05:04Z" };
    await expect(
      armClock(runtime, { openQuestionId: QUESTION, ...times, dueZone: "Not/AZone" }),
    ).rejects.toThrow(TypeError);
    // Named both ways at once: exactly one is allowed.
    await expect(
      armClock(runtime, {
        openQuestionId: QUESTION,
        clockRowId: CLOCK_ROW,
        ...times,
        dueZone: "America/New_York",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      armClock(runtime, {
        openQuestionId: QUESTION,
        ...times,
        dueAt: "2026-02-30T10:00:00Z",
        dueZone: "UTC",
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("cancelClock: cancel outside a commit (K-05 item 5; the passed-on path)", () => {
  it("a cancelled row answers its cancellation again, repeated, and writes nothing", SLOW, async () => {
    const exchange = await given("cancel-clock.json");
    await realStep(exchange);
    const before = await snapshot();
    const again = await cancelClock(runtime, cancelRequest());
    expect(again).toEqual({ ...exchange.outcome, repeated: true });
    expect(answerErrors("cancelClock", again)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("a cancelled row never fires: fireClock answers notArmed and no due read lists it", SLOW, async () => {
    await given("arm-clock.json");
    await realStep(exchangeOf("arm-clock.json"));
    const cancelled = await cancelClock(runtime, {
      clockRowId: CLOCK_ROW,
      expectVersion: 2,
      withdrawQuestion: { openQuestionId: QUESTION, expectVersion: 2 },
      at: "2026-10-23T18:00:00Z",
    });
    expect(cancelled).toEqual({
      result: "cancelled",
      clockRowId: CLOCK_ROW,
      version: 3,
      cancelledAt: "2026-10-23T18:00:00Z",
      repeated: false,
    });
    const before = await snapshot();
    for (const by of ["alarm", "sweep", "fireNow"] as const) {
      for (const expectVersion of [2, 3]) {
        const request = { ...fireRequest(), by, expectVersion };
        const outcome = await fireClock(runtime, request);
        expect(outcome).toEqual({ error: "notArmed", clockRowId: CLOCK_ROW, state: "cancelled" });
        expect(answerErrors("fireClock", outcome)).toEqual([]);
      }
    }
    const later = "2026-10-25T14:05:30Z";
    expect(await dueForHandle(runtime, { handleId: "handle-alex", now: later, limit: 10 })).toEqual({
      result: "due",
      rows: [],
      nextDueAt: null,
    });
    expect(await dueForSweep(runtime, { now: later, missedBefore: later, limit: 100 })).toEqual({
      result: "due",
      rows: [],
      nextDueAt: null,
    });
    expect(await snapshot()).toEqual(before);
    expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "cancelled", version: 3, fired_at: null });
  });

  it("a fired row answers alreadyFired: the firing stands, nothing written", SLOW, async () => {
    await given("fire-repeat.json");
    const before = await snapshot();
    const outcome = await cancelClock(runtime, {
      clockRowId: CLOCK_ROW,
      expectVersion: 3,
      withdrawQuestion: null,
      at: "2026-10-24T15:00:00Z",
    });
    expect(outcome).toEqual({
      error: "alreadyFired",
      clockRowId: CLOCK_ROW,
      firedAt: "2026-10-24T14:05:31Z",
    });
    expect(answerErrors("cancelClock", outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("versionChanged: stale versions are refused with every changed row, nothing written", SLOW, async () => {
    await given("arm-clock.json");
    await realStep(exchangeOf("arm-clock.json"));
    const before = await snapshot();
    const outcome = await cancelClock(runtime, cancelRequest());
    expect(outcome).toEqual({
      error: "versionChanged",
      changed: [
        { table: "clock_rows", rowId: CLOCK_ROW, readVersion: 1, currentVersion: 2 },
        { table: "open_questions", rowId: QUESTION, readVersion: 1, currentVersion: 2 },
      ],
    });
    expect(answerErrors("cancelClock", outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it(
    "notFound for a row that does not exist; another question than the row's own is thrown",
    SLOW,
    async () => {
      await given("cancel-clock.json");
      const request = cancelRequest();
      expect(await cancelClock(runtime, { ...request, clockRowId: "clock-unknown" })).toEqual({
        error: "notFound",
        table: "clock_rows",
        rowId: "clock-unknown",
      });
      const before = await snapshot();
      await expect(
        cancelClock(runtime, {
          ...request,
          withdrawQuestion: { openQuestionId: "oq-other", expectVersion: 1 },
        }),
      ).rejects.toThrow(TypeError);
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("dueClocks: the actor's and the sweep's reads (K-05 item 6)", () => {
  it(
    "an unarmed row is never due: a waiting row is listed by neither read and does not fire",
    SLOW,
    async () => {
      await given("cancel-clock.json");
      // The question's row as the commit wrote it (waiting, no due time), and a waiting row with a due time long past.
      await armedRow("clock-step-waiting", "handle-alex", "2026-10-01T00:00:00Z", "waiting");
      const now = "2026-12-01T00:00:00Z";
      const forHandle = await dueForHandle(runtime, { handleId: "handle-alex", now, limit: 100 });
      expect(forHandle).toEqual({ result: "due", rows: [], nextDueAt: null });
      const forSweep = await dueForSweep(runtime, { now, missedBefore: now, limit: 1000 });
      expect(forSweep).toEqual({ result: "due", rows: [], nextDueAt: null });
      expect(answerErrors("dueClocks", forSweep)).toEqual([]);
      const before = await snapshot();
      for (const clockRowId of [CLOCK_ROW, "clock-step-waiting"]) {
        const outcome = await fireClock(runtime, {
          ...fireRequest(),
          clockRowId,
          expectVersion: 1,
          turn: null,
          writes: { ...fireRequest().writes, outboxRows: [] },
        });
        expect(outcome).toEqual({ error: "notArmed", clockRowId, state: "waiting" });
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "for a handle: its due rows earliest first, at most the limit, and nextDueAt its earliest after now",
    SLOW,
    async () => {
      await given("due-for-handle.json");
      await armedRow("clock-alex-early", "handle-alex", "2026-10-24T09:00:00Z");
      await armedRow("clock-alex-later", "handle-alex", "2026-10-24T16:00:00Z");
      await armedRow("clock-alex-latest", "handle-alex", "2026-10-25T09:00:00Z");
      await armedRow("clock-sam-due", "handle-sam", "2026-10-24T09:00:00Z");
      const now = "2026-10-24T14:05:30Z";
      const all = await dueClocks(runtime, { for: "handle", handleId: "handle-alex", now, limit: 10 });
      expect("result" in all && all.rows.map((row) => row.clockRowId)).toEqual([
        "clock-alex-early",
        CLOCK_ROW,
      ]);
      expect("result" in all && all.nextDueAt).toBe("2026-10-24T16:00:00Z");
      expect(answerErrors("dueClocks", all)).toEqual([]);
      const one = await dueForHandle(runtime, { handleId: "handle-alex", now, limit: 1 });
      expect("result" in one && one.rows.map((row) => row.clockRowId)).toEqual(["clock-alex-early"]);
      // A row due exactly now is due; one second later is the next alarm.
      const atDue = await dueForHandle(runtime, {
        handleId: "handle-alex",
        now: "2026-10-24T16:00:00Z",
        limit: 10,
      });
      expect("result" in atDue && atDue.rows.map((row) => row.clockRowId)).toEqual([
        "clock-alex-early",
        CLOCK_ROW,
        "clock-alex-later",
      ]);
      expect("result" in atDue && atDue.nextDueAt).toBe("2026-10-25T09:00:00Z");
    },
  );

  it(
    "the sweep lists rows no handle owns and missed handle rows, never a row an actor may still fire",
    SLOW,
    async () => {
      const exchange = await given("due-for-sweep.json");
      const request = exchange.request as { now: string; missedBefore: string; limit: number };
      // Due after missedBefore and by now: its actor's alarm may still fire it, so the sweep leaves it.
      await armedRow("clock-alex-just-due", "handle-alex", "2026-12-01T13:00:00Z");
      // No handle owns it, but it is not due yet.
      await armedRow("clock-job-tomorrow", null, "2026-12-02T13:00:00Z");
      const outcome = await dueForSweep(runtime, request);
      expect(outcome).toEqual(exchange.outcome);
      // A smaller limit keeps the earliest first.
      const one = await dueForSweep(runtime, { ...request, limit: 1 });
      expect("result" in one && one.rows.map((row) => row.clockRowId)).toEqual([CLOCK_ROW]);
      await expect(
        dueForSweep(runtime, { now: request.missedBefore, missedBefore: request.now, limit: 100 }),
      ).rejects.toThrow(TypeError);
    },
  );
});

describe("fireClock: fire a row exactly once (K-05 item 7)", () => {
  it("100 parallel fireClock() calls on one row: exactly one fires", SLOW, async () => {
    const exchange = await given("fire-once.json");
    const request = fireRequest();
    // The calls start while the row is locked, and run once 10 of them wait on a lock: they reach the row together.
    const outcomes = await racingOn(CLOCK_ROW, 10, () =>
      Array.from({ length: 100 }, () => fireClock(runtime, structuredClone(request))),
    );
    const firings = outcomes.map(fired);
    const first = firings.filter((each) => !each.repeated);
    expect(first).toEqual([exchange.outcome]);
    const repeat = exchangeOf("fire-repeat.json").outcome;
    for (const each of firings.filter((one) => one.repeated)) {
      expect(each).toEqual(repeat);
      expect(answerErrors("fireClock", each)).toEqual([]);
    }
    expect(firings.filter((each) => each.repeated)).toHaveLength(99);
    const [counts] = await db.sql<{ turns: number; outbox: number; events: number }[]>`
      select (select count(*)::int from turns where id = 'turn-clock-oq-a7-03-alex') as turns,
             (select count(*)::int from outbox_rows where turn_id = 'turn-clock-oq-a7-03-alex') as outbox,
             (select count(*)::int from event_log where job_id = 'job-fire-clock-oq-a7-03-alex') as events
    `;
    expect(counts).toEqual({ turns: 1, outbox: 1, events: 1 });
    expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "fired", version: 3 });
    expect(await question(QUESTION)).toMatchObject({ status: "defaulted", version: 3 });
  });

  it(
    "notDue: before its due time neither the alarm nor the sweep fires it, and nothing is written",
    SLOW,
    async () => {
      await given("fire-once.json");
      const before = await snapshot();
      for (const by of ["alarm", "sweep"] as const) {
        const request = { ...fireRequest(), by, firedAt: "2026-10-24T14:05:03Z" };
        const outcome = await fireClock(runtime, request);
        expect(outcome).toEqual({ error: "notDue", clockRowId: CLOCK_ROW, dueAt: "2026-10-24T14:05:04Z" });
        expect(answerErrors("fireClock", outcome)).toEqual([]);
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "Fire now (staging's console, BP 9.4) fires through the same call before the due time",
    SLOW,
    async () => {
      await given("fire-once.json");
      const early = "2026-10-23T20:00:00Z";
      const request = { ...fireRequest(), by: "fireNow" as const, firedAt: early };
      const outcome = fired(await fireClock(runtime, request));
      expect(outcome).toEqual({ ...exchangeOf("fire-once.json").outcome, firedAt: early });
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "fired", version: 3 });
    },
  );

  it(
    "versionChanged: a stale row version or a row read that moved refuses it; the row stays armed",
    SLOW,
    async () => {
      await given("fire-once.json");
      const before = await snapshot();
      const staleRow = await fireClock(runtime, { ...fireRequest(), expectVersion: 1 });
      expect(staleRow).toEqual({
        error: "versionChanged",
        changed: [{ table: "clock_rows", rowId: CLOCK_ROW, readVersion: 1, currentVersion: 2 }],
      });
      const staleRead = fireRequest();
      staleRead.versionsRead = [{ table: "bookings", rowId: "booking-alex-haircut", version: 6 }];
      const outcome = await fireClock(runtime, staleRead);
      expect(outcome).toEqual({
        error: "versionChanged",
        changed: [{ table: "bookings", rowId: "booking-alex-haircut", readVersion: 6, currentVersion: 7 }],
      });
      expect(answerErrors("fireClock", outcome)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "armed", version: 2, fired_at: null });
    },
  );

  it(
    "a database rule's refusal answers constraint and writes nothing, the row still armed",
    SLOW,
    async () => {
      await given("fire-once.json");
      const before = await snapshot();
      const request = fireRequest();
      const [row] = request.writes.outboxRows;
      if (row === undefined) {
        throw new Error("fire-once.json writes an outbox row");
      }
      // The question's own row id, already taken by the commit that asked it.
      request.writes.outboxRows = [{ ...row, id: "out-a7-03-alex" }];
      const outcome = await fireClock(runtime, request);
      expect(outcome).toEqual({ error: "constraint", sqlstate: "23505", constraint: "outbox_rows_pkey" });
      expect(answerErrors("fireClock", outcome)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "armed", version: 2 });
    },
  );

  it(
    "a row no handle owns fires with no turn: its effect under the job id, its entry with the job id",
    SLOW,
    async () => {
      await given("due-for-sweep.json");
      const jobId = "job-fire-clock-monthly-billing-2026-12";
      const request: FireClockRequest = {
        clockRowId: "clock-monthly-billing-2026-12",
        expectVersion: 1,
        firedAt: "2026-12-01T13:00:30Z",
        by: "sweep",
        jobId,
        turn: null,
        versionsRead: [],
        writes: {
          state: [],
          openQuestions: { open: [], close: [] },
          clockRows: { make: [], cancel: [] },
          outboxRows: [],
          reservations: { confirm: [], release: [] },
          effects: {
            write: [
              {
                effectId: "eff-monthly-billing-lees-2026-12",
                kind: "rosfield_monthly_charge",
                port: "stripe",
                businessId: "biz-lees-barbershop",
                bookingId: null,
                calendarProvider: null,
                visitId: null,
                personId: null,
                handleId: null,
                amount: { cents: 4900, currency: "USD" },
                portRequest: { bill: "2026-12" },
                idempotencyKey: "monthly-billing/biz-lees-barbershop/2026-12",
                traceId: "trace-monthly-billing-2026-12",
              },
            ],
            letGo: [],
          },
          events: [
            {
              id: "log-monthly-billing-lees-2026-12",
              kind: "effect.created",
              zone: "America/New_York",
              businessId: "biz-lees-barbershop",
              actorKind: "job",
              actorPersonId: null,
              actorRole: null,
              tableName: "effects",
              rowId: "eff-monthly-billing-lees-2026-12",
              oldValues: null,
              newValues: { state: "pending" },
              sealed: null,
              why: { step: "S11-66" },
              approvedBy: null,
              proofs: null,
            },
          ],
        },
      };
      expect(schemaErrors("fireClock.request", request)).toEqual([]);
      const outcome = await fireClock(runtime, structuredClone(request));
      expect(outcome).toEqual({
        result: "fired",
        clockRowId: "clock-monthly-billing-2026-12",
        version: 2,
        firedAt: "2026-12-01T13:00:30Z",
        turnId: null,
        repeated: false,
        committed: {
          written: [{ table: "effects", rowId: "eff-monthly-billing-lees-2026-12", version: 1 }],
          outboxRows: [],
          promoted: [],
        },
      });
      expect(answerErrors("fireClock", outcome)).toEqual([]);
      const [effect] = await db.sql<{ turn_id: string | null; job_id: string | null; state: string }[]>`
      select turn_id, job_id, state from effects where id = 'eff-monthly-billing-lees-2026-12'
    `;
      expect(effect).toEqual({ turn_id: null, job_id: jobId, state: "pending" });
      const [entry] = await db.sql<
        { turn_id: string | null; job_id: string | null; trace_id: string; bundle_hash: string | null }[]
      >`select turn_id, job_id, trace_id, bundle_hash from event_log where id = 'log-monthly-billing-lees-2026-12'`;
      expect(entry).toEqual({ turn_id: null, job_id: jobId, trace_id: jobId, bundle_hash: null });

      const before = await snapshot();
      const again = await fireClock(runtime, structuredClone(request));
      expect(again).toEqual({
        result: "fired",
        clockRowId: "clock-monthly-billing-2026-12",
        version: 2,
        firedAt: "2026-12-01T13:00:30Z",
        turnId: null,
        repeated: true,
        committed: { written: [], outboxRows: [], promoted: [] },
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "a firing that is not the row's clock turn, or a turnless one with an outbox row, is thrown",
    SLOW,
    async () => {
      await given("fire-once.json");
      const before = await snapshot();
      const otherEvent = fireRequest();
      if (otherEvent.turn === null) {
        throw new Error("fire-once.json has a turn");
      }
      otherEvent.turn.eventIds = ["evt-alex-0007"];
      await expect(fireClock(runtime, otherEvent)).rejects.toThrow(TypeError);
      const otherHandle = fireRequest();
      if (otherHandle.turn === null) {
        throw new Error("fire-once.json has a turn");
      }
      otherHandle.turn.handleId = "handle-sam";
      await expect(fireClock(runtime, otherHandle)).rejects.toThrow(TypeError);
      const turnless = { ...fireRequest(), turn: null };
      await expect(fireClock(runtime, turnless)).rejects.toThrow(TypeError);
      const ownRow = fireRequest();
      ownRow.versionsRead = [{ table: "clock_rows", rowId: CLOCK_ROW, version: 2 }];
      await expect(fireClock(runtime, ownRow)).rejects.toThrow(TypeError);
      expect(await snapshot()).toEqual(before);
      const unknownRow = fireRequest();
      if (unknownRow.turn === null) {
        throw new Error("fire-once.json has a turn");
      }
      unknownRow.clockRowId = "clock-unknown";
      unknownRow.turn.eventIds = ["clock-unknown"];
      expect(await fireClock(runtime, unknownRow)).toEqual({
        error: "notFound",
        table: "clock_rows",
        rowId: "clock-unknown",
      });
    },
  );

  it(
    "a firing whose writes carry askAgain, with any value, throws before any statement, naming the field alone, and its clock row, the question and the event log stay as they were (K-05 v1.21 default 199; T-1509)",
    SLOW,
    async () => {
      await given("fire-once.json");
      const before = await snapshot();
      const clockBefore = await clockRow(CLOCK_ROW);
      const questionBefore = await question(QUESTION);
      const entriesBefore = await db.sql<{ id: string }[]>`select id from event_log order by id`;
      // A rosie_job client that records every statement it sends: none means the firing threw before the database.
      const statements: string[] = [];
      const watched = postgres(resolvePrimaryUrl(), {
        max: 1,
        onnotice: () => undefined,
        debug: (_connection: number, text: string) => {
          statements.push(text);
        },
        connection: {
          application_name: "rosie-t1509-clocks-watched",
          search_path: `${db.schema}, public`,
          role: RUNTIME_ROLE,
        },
      });
      const values: [string, unknown][] = [
        ["a raise of the firing's own question", [{ id: QUESTION, expectVersion: 2 }]],
        ["an empty list", []],
        ["null", null],
        ["undefined", undefined],
        ["a raise not in a list", { id: QUESTION, expectVersion: 2 }],
      ];
      try {
        for (const [what, value] of values) {
          const request = fireRequest();
          (request.writes.openQuestions as unknown as Record<string, unknown>).askAgain = value;
          const error = await thrownBy(fireClock(watched, request));
          expect(error, what).toBeInstanceOf(TypeError);
          expect((error as Error).message, what).toBe(
            "fireClock: writes.openQuestions.askAgain is not a firing's: only a turn's commit asks a question again",
          );
        }
      } finally {
        await watched.end({ timeout: 5 });
      }
      expect(statements).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await clockRow(CLOCK_ROW)).toEqual(clockBefore);
      expect(clockBefore).toMatchObject({ state: "armed", version: 2, fired_at: null });
      expect(await question(QUESTION)).toEqual(questionBefore);
      expect(await db.sql<{ id: string }[]>`select id from event_log order by id`).toEqual(entriesBefore);
      // The same firing without the field fires as fire-once.json says.
      expect(await fireClock(runtime, fireRequest())).toEqual(exchangeOf("fire-once.json").outcome);
    },
  );

  it(
    "a firing's state write gives a bytea column the bytes of its hex form, and refuses any other form (T-1185)",
    SLOW,
    async () => {
      await given("fire-once.json");
      const address = "A stand-in address for Alex, not real";
      const sealed = await seal(db.sql, KEYS, "person-alex", address);
      const text = byteaText(sealed);
      const pausing = (value: unknown): FireClockRequest => {
        const request = fireRequest();
        request.writes.state = [
          {
            op: "insert",
            table: "pauses",
            values: {
              id: PAUSE_ID,
              business_id: "biz-lees-barbershop",
              target: "address",
              address: value,
              sealed_for_person_id: "person-alex",
              set_at: request.firedAt,
            },
          },
        ];
        return request;
      };
      const pauseRows = async (): Promise<Uint8Array[]> => {
        const rows = await db.sql<{ address: Uint8Array }[]>`
          select address from pauses where id = ${PAUSE_ID}
        `;
        return rows.map((row) => new Uint8Array(row.address));
      };

      const before = await snapshot();
      const notTextForm: [string, unknown][] = [
        ["hex with no \\x", text.slice(2)],
        ["an odd number of hex digits", `${text}0`],
        ["a character that is not hex", `${text.slice(0, -1)}g`],
        ["bytes already made", sealed],
      ];
      for (const [what, value] of notTextForm) {
        const error = await thrownBy(fireClock(runtime, pausing(value)));
        expect(error, what).toBeInstanceOf(TypeError);
        expect((error as Error).message, what).toBe(
          'fireClock: a state insert into pauses gives pauses.address a value that is not "\\x" and hex digit pairs',
        );
        expect(await snapshot(), what).toEqual(before);
        expect((await pauseRows()).length, what).toBe(0);
        expect(await clockRow(CLOCK_ROW), what).toMatchObject({ state: "armed", version: 2, fired_at: null });
      }

      const outcome = fired(await fireClock(runtime, pausing(text)));
      expect(outcome.committed.written).toContainEqual({ table: "pauses", rowId: PAUSE_ID, version: 1 });
      const stored = await pauseRows();
      expect(stored.length).toBe(1);
      const [bytes = new Uint8Array(0)] = stored;
      expect(sameBytes(bytes, sealed), "the stored address is the sealed address's bytes").toBe(true);
      expect(await unsealText(db.sql, KEYS, "person-alex", bytes)).toBe(address);
    },
  );
});

// ---- T-1437: a firing's targets are a turn's commit's (commit-turn.ts RowWriter) ------------------------------------------

type StateWrite = FireClockRequest["writes"]["state"][number];
type RowRef = FireClockRequest["versionsRead"][number];
type Fired = Extract<FireClockOutcome, { result: "fired" }>;

const DB_SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const SETUP_SLOW = { timeout: 120_000 };
const BARBERSHOP = "biz-lees-barbershop";
const MOVERS = "biz-movers";
/** The moment of this block's own firings: after its seeds' links were read and Sam's dropped (Nov 2026). */
const SETUP_FIRED_AT = "2026-11-11T21:30:00Z";

const partSeedUrl = (part: string, file: string): URL => new URL(`${part}/fixtures/${file}`, DB_SCHEMA_DIR);

/** A seed's rows after those of every seed its `after` names (each path from the naming file's folder), each file once. */
function chainRowsOf(file: URL, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const seed = readJson(file) as SeedFile;
  return [...seed.after.flatMap((before) => chainRowsOf(new URL(before, file), seen)), ...seed.rows];
}

/**
 * Loads setup parts' seeds of fixture set v1, each with its chain, as the tables' owner, over what `file`'s given
 * loaded: the K-04 seed files its chain loaded (with their own chains) are not loaded twice.
 */
async function givenParts(file: string, parts: readonly (readonly [string, string])[]): Promise<void> {
  const seen = new Set<string>();
  for (const seed of chainOf(file).seeds) {
    chainRowsOf(new URL(seed, CORE_DIR), seen);
  }
  const rows = parts.flatMap(([part, seed]) => chainRowsOf(partSeedUrl(part, seed), seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** The one own row of `table` in a setup part's seed whose values hold each of `match`'s. */
function partSeedRow(
  part: string,
  file: string,
  table: string,
  match: Record<string, Json>,
): Record<string, Json> {
  const [row, ...more] = (readJson(partSeedUrl(part, file)) as SeedFile).rows.filter(
    (each) =>
      each.table === table && Object.entries(match).every(([column, value]) => each.values[column] === value),
  );
  if (row === undefined || more.length > 0) {
    throw new Error(`${file} has no one ${table} row that matches`);
  }
  return row.values;
}

/** The setup tables this block's firings read or write, counted beside snapshot()'s. */
const SETUP_VERSIONED = [
  "companies",
  "company_kinds",
  "flow_defaults",
  "accounts",
  "proof_codes",
  "sessions",
  "calendar_links",
  "calendar_link_shares",
  "busy_blocks",
];

/** snapshot(), and each setup table's rows and the sum of their versions: equal before and after = nothing written. */
async function everything(): Promise<Record<string, string>> {
  const out = await snapshot();
  for (const table of SETUP_VERSIONED) {
    const [row] = await db.sql<{ n: number; v: number }[]>`
      select count(*)::int as n, coalesce(sum(version), 0)::int as v from ${db.sql(table)}
    `;
    out[table] = `${String(row?.n)} rows, versions ${String(row?.v)}`;
  }
  return out;
}

/** An armed step clock row of `handleId` at `businessId` (or none), due before SETUP_FIRED_AT, written by the owner. */
async function armedFor(id: string, handleId: string, businessId: string | null): Promise<void> {
  await insertRow(db.sql, "clock_rows", {
    id,
    kind: "step",
    handle_id: handleId,
    business_id: businessId,
    due_at: "2026-11-11T21:00:00Z",
    due_zone: "America/New_York",
    state: "armed",
    armed_at: "2026-11-10T21:00:00Z",
    fires: { step: "S11-100", safeDefault: "nothing changes" },
  });
}

/** A turnless firing of an armed row armedFor wrote (version 1) that reads `versionsRead` and writes `state` alone. */
function firingOf(clockRowId: string, versionsRead: RowRef[], state: StateWrite[] = []): FireClockRequest {
  return {
    clockRowId,
    expectVersion: 1,
    firedAt: SETUP_FIRED_AT,
    by: "alarm",
    jobId: `job-fire-${clockRowId}`,
    turn: null,
    versionsRead,
    writes: {
      state,
      openQuestions: { open: [], close: [] },
      clockRows: { make: [], cancel: [] },
      outboxRows: [],
      reservations: { confirm: [], release: [] },
      events: [],
    },
  };
}

/** A state update of `ref`'s row by its id, at `expectVersion` (by default the version `ref` names). */
function updateOf(ref: RowRef, set: Record<string, Json>, expectVersion = ref.version): StateWrite {
  return {
    op: "update",
    table: ref.table,
    key: { id: ref.rowId },
    expectVersion,
    set,
  } as unknown as StateWrite;
}

/** A row a firing may not reach: it finds no row and throws (commit-turn.ts default 1, fail closed). */
const notFoundIn = (table: string): RegExp =>
  new RegExp(`^fireClock: a row of ${table} the request names does not exist`);

/**
 * A firing refused before anything is written: it throws a TypeError whose message matches `pattern`, every table stands
 * as it was, and its clock row is still armed.
 */
async function expectRefused(request: FireClockRequest, pattern: RegExp, what: string): Promise<void> {
  const before = await everything();
  const error = await thrownBy(fireClock(runtime, structuredClone(request)));
  expect(error, what).toBeInstanceOf(TypeError);
  expect((error as Error).message, what).toMatch(pattern);
  expect(await everything(), what).toEqual(before);
  expect(await clockRow(request.clockRowId), what).toMatchObject({ state: "armed", fired_at: null });
}

describe("fireClock takes the setup tables a turn's commit takes (T-1437; K-05 v1.18 item 77; T-667 round 2)", () => {
  const SHOP_SEEDS = [
    ["business-setup", "seed-business-demo-shop.json"],
    ["business-setup", "seed-company-two-kinds.json"],
  ] as const;
  const ELECTRICIAN = partSeedRow("business-setup", "seed-company-two-kinds.json", "company_kinds", {
    kind_id: "electrician",
  });
  const BARBER: RowRef = { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 1 };
  /** The barbershop's barber kind and flow B defaults, read by item 77's names at `version`. */
  const shopReads = (version = 1): RowRef[] => [
    { ...BARBER, version },
    { table: "flow_defaults", rowId: `${BARBERSHOP}/B`, version },
  ];
  /**
   * The barbershop's flow A defaults kept at 48 hours (S1-21) and its barber kind's trade name, each updated by its key
   * (the key's columns in any order), and an electrician kind added (S1-04): two-column rows of K-23.
   */
  const shopWrites = (): StateWrite[] =>
    [
      {
        op: "update",
        table: "flow_defaults",
        key: { flow: "A", business_id: BARBERSHOP },
        expectVersion: 1,
        set: { cutoff_before: "48 hours" },
      },
      {
        op: "update",
        table: "company_kinds",
        key: { kind_id: "barber", company_id: "company-lees-barbershop" },
        expectVersion: 1,
        set: { trade_name: "Lee's Barbershop" },
      },
      {
        op: "insert",
        table: "company_kinds",
        values: {
          ...ELECTRICIAN,
          company_id: "company-lees-barbershop",
          business_id: BARBERSHOP,
          version: undefined,
        },
      },
    ] as unknown as StateWrite[];
  /** The setup rows shopWrites writes, as the answer names them: by item 77's names. */
  const SHOP_WRITTEN = [
    { table: "flow_defaults", rowId: `${BARBERSHOP}/A`, version: 2 },
    { table: "company_kinds", rowId: "company-lees-barbershop/barber", version: 2 },
    { table: "company_kinds", rowId: "company-lees-barbershop/electrician", version: 1 },
  ];

  it(
    "compares two-column rows by their '/' names and updates them by their keys, answered by those names; another business's name, a kind's id alone or a stale version writes nothing",
    SETUP_SLOW,
    async () => {
      const exchange = await given("fire-once.json");
      await givenParts("fire-once.json", SHOP_SEEDS);
      const firing = (reads: RowRef[]): FireClockRequest => {
        const request = fireRequest();
        request.versionsRead.push(...reads);
        request.writes.state = shopWrites();
        return request;
      };
      // Alex's A7-03 firing writes the barbershop's rows: another business's kind by its name (a row that is there), or
      // a kind's id alone, finds no row, and the firing throws with nothing written (N2, N3).
      const plumbing: RowRef = {
        table: "company_kinds",
        rowId: "company-lee-home-services/plumber",
        version: 1,
      };
      expect(
        await db.sql`select version from company_kinds where company_id || '/' || kind_id = ${plumbing.rowId}`,
      ).toEqual([{ version: 1 }]);
      await expectRefused(
        firing([plumbing]),
        notFoundIn("company_kinds"),
        "Lee Home Services' kind by its name",
      );
      await expectRefused(
        firing([{ ...BARBER, rowId: "barber" }]),
        notFoundIn("company_kinds"),
        "the barber kind by its kind's id alone",
      );
      // Versions read that moved: versionChanged names each changed row by its name (limit 4), nothing written.
      const before = await everything();
      const stale = await fireClock(runtime, firing(shopReads(2)));
      expect(stale).toEqual({
        error: "versionChanged",
        changed: [
          {
            table: "company_kinds",
            rowId: "company-lees-barbershop/barber",
            readVersion: 2,
            currentVersion: 1,
          },
          { table: "flow_defaults", rowId: `${BARBERSHOP}/B`, readVersion: 2, currentVersion: 1 },
        ],
      });
      expect(answerErrors("fireClock", stale)).toEqual([]);
      expect(await everything()).toEqual(before);
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "armed", version: 2 });

      const outcome = fired(await fireClock(runtime, firing(shopReads())));
      expect(answerErrors("fireClock", outcome)).toEqual([]);
      const first = exchange.outcome as unknown as Fired;
      expect(outcome).toEqual({
        ...first,
        committed: { ...first.committed, written: [...SHOP_WRITTEN, ...first.committed.written] },
      });
      const [cutoff] = await db.sql<{ minutes: number; version: number }[]>`
        select (extract(epoch from cutoff_before) / 60)::integer as minutes, version from flow_defaults
        where business_id = ${BARBERSHOP} and flow = 'A'
      `;
      expect(cutoff).toEqual({ minutes: 2880, version: 2 });
      const kinds = await db.sql<{ kind_id: string; trade_name: string | null; version: number }[]>`
        select kind_id, trade_name, version from company_kinds where company_id = 'company-lees-barbershop'
        order by kind_id
      `;
      expect(kinds).toEqual([
        { kind_id: "barber", trade_name: "Lee's Barbershop", version: 2 },
        { kind_id: "electrician", trade_name: ELECTRICIAN.trade_name, version: 1 },
      ]);
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "fired", version: 3 });
    },
  );

  it(
    "answers the same two-column reads and writes as a turn's commit answers them (one shared reading)",
    SETUP_SLOW,
    async () => {
      await given("fire-once.json");
      await givenParts("fire-once.json", SHOP_SEEDS);
      const request = fireRequest();
      request.versionsRead.push(...shopReads());
      request.writes.state = shopWrites();
      const firing = fired(await fireClock(runtime, request));
      // The same reads and writes in a turn of Sam's, from the same rows.
      await given("fire-once.json");
      await givenParts("fire-once.json", SHOP_SEEDS);
      const commit = await commitTurn(
        runtime,
        {
          turn: {
            id: "turn-t1437-shop",
            handleId: "handle-sam",
            eventIds: ["evt-t1437-shop"],
            bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
            traceId: "trace-t1437-shop",
            joinedTraceIds: [],
            tries: 1,
          },
          versionsRead: shopReads(),
          writes: {
            state: shopWrites(),
            openQuestions: { open: [], close: [] },
            clockRows: { make: [], cancel: [] },
            outboxRows: [],
            reservations: { confirm: [], release: [] },
            events: [],
          },
        },
        { now: new Date(SETUP_FIRED_AT) },
      );
      expect("result" in commit ? commit.committed.written : commit).toEqual(SHOP_WRITTEN);
      expect(firing.committed.written.slice(0, SHOP_WRITTEN.length)).toEqual(SHOP_WRITTEN);
    },
  );

  it(
    "compares a two-column read under the firing's own clock row's business too, when it writes nothing else (default 11)",
    SETUP_SLOW,
    async () => {
      await given("fire-once.json");
      await givenParts("fire-once.json", SHOP_SEEDS);
      await armedFor("clock-t1437-sam-shop", "handle-sam", BARBERSHOP);
      const plumbing: RowRef = {
        table: "company_kinds",
        rowId: "company-lee-home-services/plumber",
        version: 1,
      };
      await expectRefused(
        firingOf("clock-t1437-sam-shop", [plumbing]),
        notFoundIn("company_kinds"),
        "Lee Home Services' kind, from the barbershop's clock",
      );
      const outcome = await fireClock(runtime, firingOf("clock-t1437-sam-shop", shopReads()));
      expect(answerErrors("fireClock", outcome)).toEqual([]);
      expect(outcome).toEqual({
        result: "fired",
        clockRowId: "clock-t1437-sam-shop",
        version: 2,
        firedAt: SETUP_FIRED_AT,
        turnId: null,
        repeated: false,
        committed: { written: [], outboxRows: [], promoted: [] },
      });
    },
  );

  // K-22's and K-27's rows bound to a person (seed-session's chain: Sam's codes, sessions and account; seed-busy-block's:
  // the links of Sam, Riley and Avery, their shares, two calendar blocks and the movers' photo block).
  const PERSON_SEEDS = [
    ["people-access", "seed-session.json"],
    ["availability", "seed-busy-block.json"],
  ] as const;
  const SESSION: RowRef = { table: "sessions", rowId: "session-sam-oct26", version: 2 };
  const ACCOUNT: RowRef = { table: "accounts", rowId: "person-sam", version: 3 };
  const SIGN_IN_CODE: RowRef = { table: "proof_codes", rowId: "code-sam-sign-in-oct26", version: 3 };
  const OWNER_EMAIL_CODE: RowRef = { table: "proof_codes", rowId: "code-sam-owner-email", version: 2 };
  const SAM_LINK: RowRef = { table: "calendar_links", rowId: "callink-sam-microsoft", version: 9 };
  const RILEY_LINK: RowRef = { table: "calendar_links", rowId: "callink-riley-google", version: 7 };
  const SAM_BLOCK: RowRef = { table: "busy_blocks", rowId: "busy-sam-thu-nov-12", version: 1 };
  const RILEY_BLOCK: RowRef = { table: "busy_blocks", rowId: "busy-riley-sat-nov-7", version: 1 };
  const MOVERS_PHOTO: RowRef = {
    table: "busy_blocks",
    rowId: "busy-sam-movers-photo-sat-nov-14",
    version: 1,
  };
  const CONNECTING = partSeedRow("availability", "seed-calendar-link.json", "calendar_links", {
    state: "connecting",
  });
  /** K-27's connecting link (Avery's, the seed's one) under a new id for `personId`, as a connect's start writes it. */
  const newLink = (id: string, personId: string): StateWrite =>
    ({
      op: "insert",
      table: "calendar_links",
      values: { ...CONNECTING, id, person_id: personId, version: undefined },
    }) as unknown as StateWrite;
  const END_SESSION = { ended_at: SETUP_FIRED_AT, ended_why: "handed_over" };

  it(
    "reaches a row scoped none only under round 2's rules: the clock's handle's people's own, and a link or block through a live share to its business (items 8a, 8b)",
    SETUP_SLOW,
    async () => {
      await given("fire-once.json");
      await givenParts("fire-once.json", PERSON_SEEDS);
      await armedFor("clock-t1437-alex", "handle-alex", BARBERSHOP);
      await armedFor("clock-t1437-sam", "handle-sam", BARBERSHOP);
      await armedFor("clock-t1437-sam-later", "handle-sam", BARBERSHOP);
      await armedFor("clock-t1437-sam-none", "handle-sam", null);

      // Alex's clock at the barbershop reaches none of Sam's own rows, read or written: each finds no row.
      for (const [what, request, table] of [
        ["Sam's session read", firingOf("clock-t1437-alex", [SESSION]), "sessions"],
        ["Sam's account read", firingOf("clock-t1437-alex", [ACCOUNT]), "accounts"],
        ["Sam's sign-in code read", firingOf("clock-t1437-alex", [SIGN_IN_CODE]), "proof_codes"],
        [
          "Sam's session ended",
          firingOf("clock-t1437-alex", [], [updateOf(SESSION, END_SESSION)]),
          "sessions",
        ],
      ] as const) {
        await expectRefused(request, notFoundIn(table), what);
      }
      // A link written for another person (Maya, who shares none with the barbershop) is refused before any write, so
      // Alex's own link written ahead of it is not written either.
      await expectRefused(
        firingOf(
          "clock-t1437-alex",
          [],
          [newLink("callink-alex-google", "person-alex"), newLink("callink-maya-google", "person-maya")],
        ),
        /^fireClock: a state insert into calendar_links writes a row outside its rule for a firing \(default 10\)$/,
        "a link for Maya",
      );
      // Alex's own link is written, on the runtime side, and the links and blocks the barbershop reads through a live
      // share are compared.
      const alex = fired(
        await fireClock(
          runtime,
          firingOf(
            "clock-t1437-alex",
            [SAM_LINK, RILEY_LINK, RILEY_BLOCK],
            [newLink("callink-alex-google", "person-alex")],
          ),
        ),
      );
      expect(answerErrors("fireClock", alex)).toEqual([]);
      expect(alex.committed.written).toEqual([
        { table: "calendar_links", rowId: "callink-alex-google", version: 1 },
      ]);

      // Sam's clock at the barbershop: never the movers' photo block; his own session, account and codes, his link,
      // and the calendar blocks of the links the barbershop reads through a live share.
      await expectRefused(
        firingOf("clock-t1437-sam", [MOVERS_PHOTO]),
        notFoundIn("busy_blocks"),
        "the movers' photo",
      );
      // An update of his own row that would leave it outside the rule is refused before any write, on the row as it will
      // stand (DL-941 item 3): his session given to Maya, and his sign-in code of no business given to the movers.
      for (const [what, write] of [
        ["Sam's session given to Maya", updateOf(SESSION, { person_id: "person-maya" })],
        ["Sam's sign-in code given to the movers", updateOf(SIGN_IN_CODE, { business_id: MOVERS })],
      ] as const) {
        await expectRefused(
          firingOf("clock-t1437-sam", [], [write]),
          /^fireClock: a state update of (sessions|proof_codes) leaves a row outside its rule for a firing \(default 10\)$/,
          what,
        );
      }
      const sam = fired(
        await fireClock(
          runtime,
          firingOf(
            "clock-t1437-sam",
            [ACCOUNT, OWNER_EMAIL_CODE, SIGN_IN_CODE, SAM_BLOCK, RILEY_BLOCK],
            [updateOf(SESSION, END_SESSION), updateOf(SAM_LINK, { drop_reminded_at: SETUP_FIRED_AT })],
          ),
        ),
      );
      expect(answerErrors("fireClock", sam)).toEqual([]);
      expect(sam.committed.written).toEqual([
        { table: "sessions", rowId: SESSION.rowId, version: 3 },
        { table: "calendar_links", rowId: SAM_LINK.rowId, version: 10 },
      ]);

      // A share that has ended: the barbershop reaches neither Riley's link nor its block.
      await db.sql`
        update calendar_link_shares set ended_at = ${SETUP_FIRED_AT}, version = version + 1
        where id = 'share-riley-barbershop'
      `;
      for (const ref of [RILEY_LINK, RILEY_BLOCK]) {
        await expectRefused(
          firingOf("clock-t1437-sam-later", [ref]),
          notFoundIn(ref.table),
          `${ref.rowId}, share ended`,
        );
      }

      // With no business (a sign-up's clock): no busy block, not even Sam's own, and no code of a business; his own link,
      // code of no business, session and account are compared.
      for (const ref of [SAM_BLOCK, OWNER_EMAIL_CODE]) {
        await expectRefused(
          firingOf("clock-t1437-sam-none", [ref]),
          notFoundIn(ref.table),
          `${ref.rowId}, no business`,
        );
      }
      const none = await fireClock(
        runtime,
        firingOf("clock-t1437-sam-none", [
          { ...SAM_LINK, version: 10 },
          SIGN_IN_CODE,
          ACCOUNT,
          { ...SESSION, version: 3 },
        ]),
      );
      expect(answerErrors("fireClock", none)).toEqual([]);
      expect(none).toMatchObject({ result: "fired", turnId: null, committed: { written: [] } });
    },
  );

  it(
    "refuses an update that gives a row's business another value, with nothing written: in code where row-level security does not hold it, by row-level security where it does (item 8d)",
    SETUP_SLOW,
    async () => {
      await given("fire-once.json");
      await givenParts("fire-once.json", PERSON_SEEDS);
      await armedFor("clock-t1437-sam", "handle-sam", BARBERSHOP);
      await armedFor("clock-t1437-sam-movers", "handle-sam", MOVERS);
      // K-22's codes and K-27's photo blocks: rosie_job's policy is true, so the firing refuses the move itself.
      const moved =
        /^fireClock: a state update of (proof_codes|busy_blocks) may not move a row of a business to another business$/;
      for (const [what, request] of [
        [
          "Sam's owner-email code to the movers",
          firingOf("clock-t1437-sam", [], [updateOf(OWNER_EMAIL_CODE, { business_id: MOVERS })]),
        ],
        [
          "Sam's owner-email code to none",
          firingOf("clock-t1437-sam", [], [updateOf(OWNER_EMAIL_CODE, { business_id: null })]),
        ],
        [
          "the movers' photo block to the barbershop",
          firingOf("clock-t1437-sam-movers", [], [updateOf(MOVERS_PHOTO, { business_id: BARBERSHOP })]),
        ],
        [
          "the movers' photo block to none",
          firingOf("clock-t1437-sam-movers", [], [updateOf(MOVERS_PHOTO, { business_id: null })]),
        ],
      ] as const) {
        await expectRefused(request, moved, what);
      }
      // A stale move is answered versionChanged first, as any stale write, and writes nothing.
      const before = await everything();
      const stale = await fireClock(
        runtime,
        firingOf("clock-t1437-sam", [], [updateOf(OWNER_EMAIL_CODE, { business_id: MOVERS }, 1)]),
      );
      expect(stale).toEqual({
        error: "versionChanged",
        changed: [{ table: "proof_codes", rowId: OWNER_EMAIL_CODE.rowId, readVersion: 1, currentVersion: 2 }],
      });
      expect(await everything()).toEqual(before);
      // Where row-level security holds the business (Alex's booking), it refuses the write under the row's own scope:
      // 42501, scrubbed to its SQLSTATE, nothing written.
      const booking = fireRequest();
      booking.writes.state = [
        updateOf(
          { table: "bookings", rowId: "booking-alex-haircut", version: 7 },
          { business_id: "biz-yoga-studio" },
        ),
      ];
      const refusal = await thrownBy(fireClock(runtime, booking));
      expect(refusal).toBeInstanceOf(DataAccessDatabaseError);
      expect(refusal).toMatchObject({ code: "42501", constraint: null });
      expect((refusal as Error).message).toMatch(
        /^fireClock: the database refused the call \(SQLSTATE 42501/,
      );
      expect(await everything()).toEqual(before);
      expect(await clockRow(CLOCK_ROW)).toMatchObject({ state: "armed", version: 2 });
      // The row's own business named again moves nothing, and a code with no business may be given the clock's
      // business (S1-09's way): both fire.
      const kept = fired(
        await fireClock(
          runtime,
          firingOf("clock-t1437-sam-movers", [], [updateOf(MOVERS_PHOTO, { business_id: MOVERS })]),
        ),
      );
      expect(kept.committed.written).toEqual([
        { table: "busy_blocks", rowId: MOVERS_PHOTO.rowId, version: 2 },
      ]);
      const placed = fired(
        await fireClock(
          runtime,
          firingOf("clock-t1437-sam", [], [updateOf(SIGN_IN_CODE, { business_id: BARBERSHOP })]),
        ),
      );
      expect(placed.committed.written).toEqual([
        { table: "proof_codes", rowId: SIGN_IN_CODE.rowId, version: 4 },
      ]);
      const [code] = await db.sql<{ business_id: string | null }[]>`
        select business_id from proof_codes where id = ${SIGN_IN_CODE.rowId}
      `;
      expect(code?.business_id).toBe(BARBERSHOP);
    },
  );
});
