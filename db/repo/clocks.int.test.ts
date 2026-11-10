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
