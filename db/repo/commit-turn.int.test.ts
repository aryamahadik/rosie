// T-195: K-05 v1.1's commitTurn, commit a turn all or nothing, once per turn id, against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/commit-turn`). The schema comes from migrating a fresh test
// schema (db/repo/test-db.ts); the public schema is never touched.
//
// Every commit runs as K-05 states it (README "Scope": per write; T-191's roles): through a client whose connections run
// as rosie_job with no business scope at the start of each transaction, so the grants and row-level security are the ones
// the commit meets. The tables' owner (the migrations' role) loads K-04's seeds and writes the rows a fixture's `given`
// names.
//
// A fixture's `given.after` names the exchanges that run first, each with its own `given`. commitTurn, this task's, runs
// for real in every chain, and so do reserve and release (T-187), which name their saved-time clock row but write none
// (reservations.ts: clock_rows came later), so the step adds the row K-05 item 8 says they make. The plan, claim, mark
// and effect calls (T-196, T-199) are not built yet, so each of those steps writes, as the owner, the rows its exchange
// states in its request and its outcome: what the commit that follows sees.
//
// Each answer is checked against data-access v1.1 with Ajv 2020-12, strict, as contracts:check runs it, and each commit
// exchange and its answer also against the version its index entry lists (T-1137 round 3, DL-334).
import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import {
  commitTurn,
  CommitTurnDatabaseError,
  type CommitTurnOutcome,
  type CommitTurnRequest,
} from "./commit-turn";
import { release, reserve, type ReleaseRequest, type ReserveRequest } from "./reservations";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Step = (exchange: Exchange) => Promise<void>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const CRASH_APP = "rosie-t195-crash";
const SLOW = { timeout: 60_000 };

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
const requestOf = (file: string): CommitTurnRequest =>
  structuredClone(exchangeOf(file).request) as unknown as CommitTurnRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const COMMIT_ENTRIES = INDEX.filter((entry) => entry.def === "commitTurn.exchange");
const COMMIT_FIXTURES = COMMIT_ENTRIES.map((entry) => entry.file);

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

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
/** The $id of data-access at one version (`data-access.<version>.schema.json`, the version an index entry lists). */
function schemaIdOf(version: string): string {
  return (readJson(new URL(`data-access/data-access.${version}.schema.json`, CONTRACTS)) as { $id: string })
    .$id;
}
const V11_ID = schemaIdOf("v1.1");

/** Checks `value` against one $defs entry of data-access v1.1, or of the schema given, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown, schemaId = V11_ID): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${schemaId} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** The answer checked against its own definition: an error against commitTurn.errors, else the response. */
function answerErrors(outcome: unknown, schemaId = V11_ID): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? "commitTurn.errors" : "commitTurn.response", outcome, schemaId);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

function runtimeClient(applicationName: string, max: number): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    connection: {
      application_name: applicationName,
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "commit_turn" });
  runtime = runtimeClient("rosie-t195-commit", 10);
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

/** commitTurn, for real, as rosie_job: the chain's commits are this task's own call. */
async function commitStep(exchange: Exchange): Promise<void> {
  const outcome = await commitTurn(runtime, exchange.request as unknown as CommitTurnRequest, {
    now: new Date(exchange.given.now),
  });
  expect(outcome).toEqual(exchange.outcome);
}

/** reserve (T-187), for real, then the saved-time clock row it names (K-05 item 8). */
async function reserveStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as unknown as ReserveRequest;
  const outcome = await reserve(db.sql, request);
  expect(outcome).toEqual(exchange.outcome);
  if ("result" in outcome && outcome.result === "held") {
    await savedTimeClock(outcome.reservationId, outcome.heldUntil, request.at);
  }
}

/** release (T-187), for real, then the clock rows K-05 item 9 moves: its own cancelled, the promoted row's made. */
async function releaseStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as unknown as ReleaseRequest;
  const outcome = await release(db.sql, request);
  expect(outcome).toEqual(exchange.outcome);
  if (!("result" in outcome)) {
    return;
  }
  await db.sql`
    update clock_rows set state = 'cancelled', cancelled_at = ${request.at}, version = version + 1
    where id = ${`${request.reservationId}/saved-time`} and state in ('waiting', 'armed')
  `;
  if (outcome.promoted !== null) {
    await savedTimeClock(outcome.promoted.reservationId, outcome.promoted.heldUntil, request.at);
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
  claim?: {
    claimer: string;
    claimedAt: string;
    lapsesAt: string;
    claimNo: number;
    firstTryAt: string | null;
    nextTryNotBefore: string | null;
  };
}

/** claimOutbox: each claimed row sending at its new version, its parts pending, and its claim (v1.1) when given. */
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
    if (claimed.claim !== undefined) {
      await insertRow(db.sql, "outbox_claims", {
        outbox_row_id: claimed.outboxRowId,
        claimer: claimed.claim.claimer,
        claimed_at: claimed.claim.claimedAt,
        lapses_at: claimed.claim.lapsesAt,
        claim_no: claimed.claim.claimNo,
        first_try_at: claimed.claim.firstTryAt,
        next_try_not_before: claimed.claim.nextTryNotBefore,
      });
    }
  }
}

/** K-07's row state for each markRow outcome this test's chains use. */
const MARKED_STATES: Readonly<Record<string, string | undefined>> = {
  held: "held",
  waitingChat: "waiting_chat",
};

/** markRow: held until a time, or waiting for the chat (held_until cleared, the claim deleted: K-05 v1.1 item 16). */
async function markRowStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as { outboxRowId: string; outcome: string; heldUntil: string | null };
  const { version } = exchange.outcome as { version: number };
  const state = MARKED_STATES[request.outcome];
  if (state === undefined) {
    throw new Error("this test's markRow step writes held and waitingChat only");
  }
  await expectOne(
    db.sql`
      update outbox_rows set state = ${state}, held_until = ${request.heldUntil}, version = ${version}
      where id = ${request.outboxRowId} returning id
    `,
    "markRow",
  );
  if (state === "waiting_chat") {
    await db.sql`delete from outbox_claims where outbox_row_id = ${request.outboxRowId}`;
  }
}

interface ClaimedEffect {
  effect: { effectId: string; state: string; tries: number; runs: number; firstTryAt: string | null };
  version: number;
  claimedBy: string;
  claimLapsesAt: string;
}

/** claimEffects: each claimed effect running, claimed, at its new version (K-05 v1.1 item 20). */
async function claimEffectsStep(exchange: Exchange): Promise<void> {
  for (const claimed of exchange.outcome.claimed as unknown as ClaimedEffect[]) {
    await expectOne(
      db.sql`
        update effects set state = ${claimed.effect.state}, tries = ${claimed.effect.tries}, runs = ${claimed.effect.runs},
          first_try_at = ${claimed.effect.firstTryAt}, claimed_by = ${claimed.claimedBy},
          claim_lapses_at = ${claimed.claimLapsesAt}, version = ${claimed.version}
        where id = ${claimed.effect.effectId} returning id
      `,
      "claimEffects",
    );
  }
}

/** recordEffectResult: the try's outcome on the effect, its claim kept while running (K-05 v1.1 item 21). */
async function effectResultStep(exchange: Exchange): Promise<void> {
  const request = exchange.request as {
    effectId: string;
    at: string;
    errorCode: string | null;
    providerObjectId: string | null;
    ledgerLineId: string | null;
  };
  const outcome = exchange.outcome as {
    version: number;
    state: string;
    tries: number;
    runs: number;
    claimLapsesAt: string | null;
  };
  await expectOne(
    db.sql`
      update effects set state = ${outcome.state}, tries = ${outcome.tries}, runs = ${outcome.runs},
        last_try_at = ${request.at}, error_code = ${request.errorCode},
        provider_object_id = ${request.providerObjectId}, ledger_line_id = ${request.ledgerLineId},
        claimed_by = case when ${outcome.state} = 'running' then claimed_by end,
        claim_lapses_at = ${outcome.claimLapsesAt}, version = ${outcome.version}
      where id = ${request.effectId} returning id
    `,
    "recordEffectResult",
  );
}

/** The chain steps, by call. */
const STEPS: Readonly<Record<string, Step>> = {
  commitTurn: commitStep,
  reserve: reserveStep,
  release: releaseStep,
  writePlan: writePlanStep,
  claimOutbox: claimStep,
  markRow: markRowStep,
  claimEffects: claimEffectsStep,
  recordEffectResult: effectResultStep,
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

// ---- what a commit leaves behind -------------------------------------------------------------------------------------

const VERSIONED = [
  "businesses",
  "persons",
  "phones",
  "person_roles",
  "bookings",
  "resources",
  "reservations",
  "class_seats",
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
  "effects",
];
const WRITTEN_ONCE = ["handles", "person_handles", "consents", "event_log"];

/** Every core table's row count, and for a versioned one the sum of its versions: equal before and after = nothing written. */
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

interface Footprint {
  turns: number;
  outbox: number;
  events: number;
  effects: number;
  questions: number;
  clocks: number;
}

const NO_FOOTPRINT: Footprint = { turns: 0, outbox: 0, events: 0, effects: 0, questions: 0, clocks: 0 };

/** The rows that carry a turn's id. */
async function footprint(turnId: string): Promise<Footprint> {
  const [row] = await db.sql<Footprint[]>`
    select (select count(*)::int from turns where id = ${turnId}) as turns,
           (select count(*)::int from outbox_rows where turn_id = ${turnId}) as outbox,
           (select count(*)::int from event_log where turn_id = ${turnId}) as events,
           (select count(*)::int from effects where turn_id = ${turnId}) as effects,
           (select count(*)::int from open_questions where turn_id = ${turnId}) as questions,
           (select count(*)::int from clock_rows where created_by_turn_id = ${turnId}) as clocks
  `;
  if (row === undefined) {
    throw new Error("footprint: no row");
  }
  return row;
}

function committed(outcome: CommitTurnOutcome): Extract<CommitTurnOutcome, { result: "committed" }> {
  if (!("result" in outcome)) {
    throw new Error(`expected a commit, got ${outcome.error}`);
  }
  return outcome;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("the runtime side the commit runs on (K-05 README 'Scope'; T-191)", () => {
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

describe("commitTurn: each K-05 commit fixture's request gives its response (K-05 v1 and v1.1, item 1)", () => {
  it("the index lists sixteen commitTurn exchanges, each valid against data-access v1.1 and the version it is listed under (Ajv strict)", () => {
    expect([...COMMIT_FIXTURES].sort()).toEqual([
      "commit-adds-dee-booking.json",
      "commit-alex-cancels-while-sending.json",
      "commit-alex-safety.json",
      "commit-alex-stop.json",
      "commit-evening-notice.json",
      "commit-first.json",
      "commit-lets-go-outage-effect.json",
      "commit-opens-question.json",
      "commit-repeat-same-turn.json",
      "commit-reservation-lost.json",
      "commit-s1-01-sam.json",
      "commit-sam-quick-reply.json",
      "commit-supersedes-waiting.json",
      "commit-version-changed.json",
      "commit-withdraws-waiting.json",
      "commit-writes-effect.json",
    ]);
    for (const { file, version } of COMMIT_ENTRIES) {
      const exchange = exchangeOf(file);
      for (const schemaId of [V11_ID, schemaIdOf(version)]) {
        const at = `${file} against ${schemaId}`;
        expect(schemaErrors("commitTurn.exchange", exchange, schemaId), at).toEqual([]);
        expect(schemaErrors("commitTurn.request", exchange.request, schemaId), at).toEqual([]);
        expect(answerErrors(exchange.outcome, schemaId), at).toEqual([]);
      }
    }
  });

  for (const { file, version } of COMMIT_ENTRIES) {
    it(
      `${file}: as rosie_job, the call answers the fixture's outcome and writes all or nothing`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const request = exchange.request as unknown as CommitTurnRequest;
        const before = await snapshot();
        const footprintBefore = await footprint(request.turn.id);
        const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors(outcome)).toEqual([]);
        expect(answerErrors(outcome, schemaIdOf(version))).toEqual([]);

        if ("error" in outcome) {
          // Refused: nothing at all was written.
          expect(await snapshot()).toEqual(before);
          expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
          return;
        }
        if (outcome.repeated) {
          // A repeat writes nothing.
          expect(await snapshot()).toEqual(before);
          expect(await footprint(request.turn.id)).toEqual(footprintBefore);
          return;
        }
        // One turn row, committed at the commit's moment, and every row it carries the turn's id on.
        const [turn] = await db.sql<{ state: string; committed_at: Date; tries: number }[]>`
        select state, committed_at, tries from turns where id = ${request.turn.id}
      `;
        expect(turn?.state).toBe("committed");
        expect(turn?.committed_at.toISOString()).toBe(new Date(exchange.given.now).toISOString());
        const waiting = outcome.committed.waitingChat;
        const ended = (waiting?.superseded.length ?? 0) + (waiting?.withdrawn.length ?? 0);
        expect(await footprint(request.turn.id)).toEqual({
          turns: 1,
          outbox: request.writes.outboxRows.length,
          events: request.writes.events.length + ended,
          effects: request.writes.effects?.write.length ?? 0,
          questions: request.writes.openQuestions.open.length,
          clocks: request.writes.clockRows.make.length,
        });
        // Outbox rows with no plan yet, in K-04's first state (arch 01 lines 39 to 41).
        const rows = await db.sql<{ id: string; state: string; plan: unknown; final_parts: unknown }[]>`
        select id, state, plan, final_parts from outbox_rows where turn_id = ${request.turn.id} order by commit_seq
      `;
        expect(rows.map((row) => [row.id, row.state, row.plan, row.final_parts])).toEqual(
          request.writes.outboxRows.map((row) => [row.id, "planned", null, null]),
        );
      },
    );
  }
});

describe("a repeated turn id (K-05 item 1: the turn id is the key)", () => {
  it(
    "50 parallel commitTurn() calls with one turn id write exactly one set of rows and all answer the same commit",
    SLOW,
    async () => {
      const exchange = await given("commit-writes-effect.json");
      const request = exchange.request as unknown as CommitTurnRequest;
      const now = new Date(exchange.given.now);
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () => commitTurn(runtime, structuredClone(request), { now })),
      );
      const commits = outcomes.map(committed);
      const first = commits.filter((each) => !each.repeated);
      expect(first).toHaveLength(1);
      expect(first[0]).toEqual(exchange.outcome);
      for (const each of commits) {
        expect(answerErrors(each)).toEqual([]);
        expect([each.turnId, each.committedAt, each.committed.outboxRows]).toEqual([
          "turn-alex-book-1",
          "2026-11-07T15:06:30Z",
          [
            { id: "out-alex-booked-riley", commitSeq: 1 },
            { id: "out-sam-booked-riley", commitSeq: 2 },
          ],
        ]);
        if (each.repeated) {
          expect([each.committed.written, each.committed.promoted]).toEqual([[], []]);
        }
      }
      expect(await footprint(request.turn.id)).toEqual({
        ...NO_FOOTPRINT,
        turns: 1,
        outbox: 2,
        events: 2,
        effects: 1,
      });
      const [reservation] = await db.sql<{ state: string; version: number }[]>`
        select state, version from reservations where id = 'rsv-alex-riley-nov14'
      `;
      expect(reservation).toEqual({ state: "booked", version: 2 });
      const [clock] = await db.sql<{ state: string; version: number }[]>`
        select state, version from clock_rows where id = 'rsv-alex-riley-nov14/saved-time'
      `;
      expect(clock).toEqual({ state: "cancelled", version: 2 });
    },
  );

  it("a repeat answers the first commit whatever its body, and writes nothing", SLOW, async () => {
    const exchange = await given("commit-repeat-same-turn.json");
    const request = exchange.request as unknown as CommitTurnRequest;
    // A rerun that would write something else under the same turn id.
    request.writes.outboxRows = [];
    request.writes.events = [];
    request.versionsRead = [{ table: "businesses", rowId: "biz-lees-barbershop", version: 1 }];
    const before = await snapshot();
    const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:09:00Z") });
    expect(outcome).toEqual(exchange.outcome);
    expect(await snapshot()).toEqual(before);
  });

  it("a parked turn id answers turnParked and writes nothing", SLOW, async () => {
    await given("commit-opens-question.json");
    await insertRow(db.sql, "turns", {
      id: "turn-alex-move-1",
      handle_id: "handle-alex",
      event_ids: ["evt-alex-0007"],
      state: "parked",
      bundle_hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
      bundle_build: 1,
      trace_id: "trace-alex-0007",
      tries: 3,
      parked_at: "2026-10-23T14:05:01Z",
    });
    const before = await snapshot();
    const outcome = await commitTurn(runtime, requestOf("commit-opens-question.json"));
    expect(outcome).toEqual({
      error: "turnParked",
      turnId: "turn-alex-move-1",
      parkedAt: "2026-10-23T14:05:01Z",
    });
    expect(answerErrors(outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("limit 4 and limit 5: refused with the rows that changed, nothing written", () => {
  it("a stale read version is refused with every changed row listed once (limit 4)", SLOW, async () => {
    await given("commit-version-changed.json");
    const request = requestOf("commit-version-changed.json");
    request.versionsRead.push({ table: "businesses", rowId: "biz-lees-barbershop", version: 2 });
    const before = await snapshot();
    const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:07:00Z") });
    expect(outcome).toEqual({
      error: "versionChanged",
      changed: [
        { table: "bookings", rowId: "booking-alex-haircut", readVersion: 6, currentVersion: 7 },
        { table: "businesses", rowId: "biz-lees-barbershop", readVersion: 2, currentVersion: 3 },
      ],
    });
    expect(answerErrors(outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
  });

  it(
    "a saved time still held but past its held_until is lost, before its version is compared (limit 5)",
    SLOW,
    async () => {
      await given("commit-first.json");
      const request = requestOf("commit-first.json");
      // Its version read is also stale: limit 5 is checked first.
      request.versionsRead = [{ table: "businesses", rowId: "biz-lees-barbershop", version: 2 }];
      const before = await snapshot();
      const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:15:00Z") });
      expect(outcome).toEqual({
        error: "reservationLost",
        reservations: [
          { id: "rsv-alex-riley-nov14", state: "held", heldUntil: "2026-11-07T15:15:00Z", releasedWhy: null },
        ],
      });
      expect(answerErrors(outcome)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
    },
  );

  it(
    "an effect let go that is not in outage is refused with wrongState (K-05 v1.1 item 18)",
    SLOW,
    async () => {
      // claim-effects' chain ends at the commit that wrote the effect: it is pending, at version 1.
      await given("claim-effects.json");
      const request = requestOf("commit-lets-go-outage-effect.json");
      const letGo = request.writes.effects?.letGo[0];
      if (letGo === undefined) {
        throw new Error("the fixture lets one effect go");
      }
      letGo.expectVersion = 1;
      const before = await snapshot();
      const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:06:32Z") });
      expect(outcome).toEqual({
        error: "wrongState",
        table: "effects",
        rowId: "eff-cal-riley-alex-nov14-write",
        state: "pending",
      });
      expect(answerErrors(outcome)).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("all or nothing: a crash or a refusal mid-transaction leaves no partial row (arch 01 lines 39 to 41)", () => {
  async function lockWaiter(applicationName: string): Promise<number> {
    for (let tries = 0; tries < 500; tries += 1) {
      const [row] = await db.sql<{ pid: number }[]>`
        select pid from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock'
      `;
      if (row !== undefined) {
        return row.pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the commit never reached the event log");
  }

  it(
    "the commit's backend killed at the event log, after every other write, answers transient and leaves nothing",
    SLOW,
    async () => {
      const exchange = await given("commit-writes-effect.json");
      const request = exchange.request as unknown as CommitTurnRequest;
      const before = await snapshot();
      const crashing = runtimeClient(CRASH_APP, 1);
      try {
        const outcome = await db.sql.begin(async (tx) => {
          // The log's inserts wait behind this lock, so the commit stops at its first entry, its other rows written.
          await tx`lock table event_log in exclusive mode`;
          const pending = commitTurn(crashing, request, { now: new Date(exchange.given.now) });
          const pid = await lockWaiter(CRASH_APP);
          const [wrote] = await db.sql<{ wrote: boolean }[]>`
            select exists (select 1 from pg_locks where pid = ${pid} and locktype = 'transactionid') as wrote
          `;
          expect(wrote?.wrote, "the commit had written rows when it was killed").toBe(true);
          await db.sql`select pg_terminate_backend(${pid})`;
          return pending;
        });
        expect(outcome).toMatchObject({ error: "transient" });
        expect(answerErrors(outcome)).toEqual([]);
      } finally {
        // Its one connection is dead and never released (targets.ts inRuntimeTransaction): close it at once.
        await crashing.end({ timeout: 0 });
      }
      expect(await snapshot()).toEqual(before);
      expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
    },
  );

  it("a database rule refusing the last write answers constraint and leaves nothing", SLOW, async () => {
    const exchange = await given("commit-writes-effect.json");
    const request = exchange.request as unknown as CommitTurnRequest;
    // The commit's second entry id is already taken, by a job's entry: its insert is the commit's very last write.
    await insertRow(db.sql, "event_log", {
      id: "log-eff-cal-riley-alex-nov14-write",
      job_id: "job-t195-taken",
      trace_id: "trace-t195-taken",
      actor_kind: "job",
      kind: "effect.created",
    });
    const before = await snapshot();
    const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
    expect(outcome).toEqual({ error: "constraint", sqlstate: "23505", constraint: "event_log_pkey" });
    expect(answerErrors(outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
  });

  it(
    "a calendar effect with no provider answers effects_calendar_keyed's refusal and leaves nothing",
    SLOW,
    async () => {
      await given("commit-writes-effect.json");
      const request = requestOf("commit-writes-effect.json");
      const effect = request.writes.effects?.write[0];
      if (effect === undefined) {
        throw new Error("the fixture writes one effect");
      }
      effect.calendarProvider = null;
      const before = await snapshot();
      const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:06:30Z") });
      expect(outcome).toEqual({
        error: "constraint",
        sqlstate: "23514",
        constraint: "effects_calendar_keyed",
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("a row the request names that does not exist throws, and nothing is written", SLOW, async () => {
    await given("commit-version-changed.json");
    const request = requestOf("commit-opens-question.json");
    request.versionsRead.push({ table: "bookings", rowId: "booking-nobody", version: 1 });
    const before = await snapshot();
    await expect(commitTurn(runtime, request)).rejects.toThrow(
      "a row of bookings the request names does not exist",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("a state write to a table with its own list is refused before the database is reached", async () => {
    const request = requestOf("commit-first.json");
    request.writes.state.push({ op: "insert", table: "effects", values: { id: "eff-by-hand" } });
    await expect(commitTurn(runtime, request)).rejects.toThrow("a state write may not name effects");
  });
});

describe("per write scope (K-05 README 'Scope'; T-191: rosie_job with the scope set before each write)", () => {
  it("a turn touching two businesses writes each row under its own business", SLOW, async () => {
    await given("commit-opens-question.json");
    const request = requestOf("commit-evening-notice.json");
    request.turn.id = "turn-alex-two-businesses";
    request.versionsRead = [
      { table: "bookings", rowId: "booking-alex-haircut", version: 7 },
      { table: "bookings", rowId: "booking-alex-workshop", version: 2 },
    ];
    request.writes.state = [
      {
        op: "update",
        table: "bookings",
        key: { id: "booking-alex-workshop" },
        expectVersion: 2,
        set: { stage: "cancelled" },
      },
    ];
    const notice = request.writes.outboxRows[0];
    const entry = request.writes.events[0];
    if (notice === undefined || entry === undefined) {
      throw new Error("the fixture writes one row and one entry");
    }
    request.writes.outboxRows.push({
      ...notice,
      id: "out-yoga-workshop-cancelled",
      businessId: "biz-yoga-studio",
      bookingId: "booking-alex-workshop",
      versionsRead: [{ table: "bookings", rowId: "booking-alex-workshop", version: 3 }],
    });
    request.writes.events.push({
      ...entry,
      id: "log-yoga-workshop-cancelled",
      businessId: "biz-yoga-studio",
    });
    request.writes.events.push({ ...entry, id: "log-runtime-side", businessId: null });
    // A rosie_job client that records each statement it sends, in order, with its parameters.
    const statements: { text: string; parameters: unknown[] }[] = [];
    const watched = postgres(resolvePrimaryUrl(), {
      max: 1,
      onnotice: () => undefined,
      debug: (_connection: number, text: string, parameters: unknown[]) => {
        statements.push({ text, parameters });
      },
      connection: {
        application_name: "rosie-t195-scope",
        search_path: `${db.schema}, public`,
        role: RUNTIME_ROLE,
      },
    });
    let outcome: CommitTurnOutcome;
    try {
      outcome = await commitTurn(watched, request, { now: new Date("2026-11-08T01:30:00Z") });
    } finally {
      await watched.end({ timeout: 5 });
    }
    // The scope in force at each insert and update: the row's own business, '' (the runtime side) for none.
    let scope = "";
    const writes: [string, string][] = [];
    for (const { text, parameters } of statements) {
      if (text.includes("select set_config($1, '', true)")) {
        scope = "";
      } else if (text.includes("select set_config($1, $2, true)")) {
        scope = String(parameters[1]);
      }
      const write = /^\s*(?:insert into|update)\s+"?([a-z_]+)"?/.exec(text);
      if (write?.[1] !== undefined) {
        writes.push([write[1], scope]);
      }
    }
    expect(writes).toEqual([
      ["turns", ""],
      ["bookings", "biz-yoga-studio"],
      ["outbox_rows", "biz-lees-barbershop"],
      ["outbox_rows", "biz-yoga-studio"],
      ["event_log", "biz-lees-barbershop"],
      ["event_log", "biz-yoga-studio"],
      ["event_log", ""],
    ]);
    expect(committed(outcome).committed).toEqual({
      written: [{ table: "bookings", rowId: "booking-alex-workshop", version: 3 }],
      outboxRows: [
        { id: "out-sam-passon-evening", commitSeq: 1 },
        { id: "out-yoga-workshop-cancelled", commitSeq: 2 },
      ],
      promoted: [],
    });
    const logged = await db.sql<{ id: string; business_id: string | null }[]>`
      select id, business_id from event_log where turn_id = ${request.turn.id} order by id
    `;
    expect(logged).toEqual([
      { id: "log-alex-evening-passed-on", business_id: "biz-lees-barbershop" },
      { id: "log-runtime-side", business_id: null },
      { id: "log-yoga-workshop-cancelled", business_id: "biz-yoga-studio" },
    ]);
  });

  it(
    "a write that would move a row to another business is refused by row-level security, nothing written",
    SLOW,
    async () => {
      await given("commit-version-changed.json");
      const request = requestOf("commit-version-changed.json");
      request.versionsRead = [{ table: "bookings", rowId: "booking-alex-haircut", version: 7 }];
      request.writes.state = [
        {
          op: "update",
          table: "bookings",
          key: { id: "booking-alex-haircut" },
          expectVersion: 7,
          set: { business_id: "biz-yoga-studio" },
        },
      ];
      const before = await snapshot();
      const refusal: unknown = await commitTurn(runtime, request).then(
        () => null,
        (error: unknown) => error,
      );
      // Row-level security's refusal, scrubbed to its SQLSTATE: nothing of PostgresError's message or detail leaves.
      expect(refusal).toBeInstanceOf(CommitTurnDatabaseError);
      expect(refusal).toMatchObject({ code: "42501", constraint: null });
      expect(Object.keys(refusal as object)).not.toContain("detail");
      expect((refusal as Error).message).toMatch(
        /^commitTurn: the database refused the commit \(SQLSTATE 42501/,
      );
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("reservations in the commit (K-05 items 1 and 9)", () => {
  it(
    "a release promotes the next in line, as release does, with its own saved-time clock row (default 4)",
    SLOW,
    async () => {
      // K-04's seed-reservation: Alex's saved time with Avery (to 15:10) and two agent tokens waiting behind it.
      await given("commit-first.json");
      const request = requestOf("commit-sam-quick-reply.json");
      request.turn.id = "turn-alex-lets-avery-go";
      request.turn.handleId = "handle-alex";
      request.writes.outboxRows = [];
      request.writes.reservations.release = [{ id: "rsv-alex-saved-avery", expectVersion: 1, why: "let_go" }];
      const outcome = committed(
        await commitTurn(runtime, request, { now: new Date("2026-11-07T15:05:00Z") }),
      );
      expect(answerErrors(outcome)).toEqual([]);
      expect(outcome.committed).toEqual({
        written: [
          { table: "reservations", rowId: "rsv-alex-saved-avery", version: 2 },
          { table: "reservations", rowId: "rsv-agent-waiting-avery", version: 2 },
          { table: "clock_rows", rowId: "rsv-agent-waiting-avery/saved-time", version: 1 },
        ],
        outboxRows: [],
        promoted: [
          {
            reservationId: "rsv-agent-waiting-avery",
            version: 2,
            heldUntil: "2026-11-07T15:15:00Z",
            forPhoneNumber: null,
            forAgentToken: "agent-token-demo-2",
            bookingId: null,
            savedTimeClockId: "rsv-agent-waiting-avery/saved-time",
          },
        ],
      });
      const [clock] = await db.sql<Record<string, unknown>[]>`
        select kind, state, reservation_id, handle_id, business_id, due_at, due_zone, armed_at, fires, created_by_turn_id
        from clock_rows where id = 'rsv-agent-waiting-avery/saved-time'
      `;
      expect(clock).toEqual({
        kind: "saved_time",
        state: "armed",
        reservation_id: "rsv-agent-waiting-avery",
        handle_id: null,
        business_id: "biz-lees-barbershop",
        due_at: new Date("2026-11-07T15:15:00Z"),
        due_zone: "America/New_York",
        armed_at: new Date("2026-11-07T15:05:00Z"),
        fires: { release: "rsv-agent-waiting-avery", why: "expired" },
        created_by_turn_id: "turn-alex-lets-avery-go",
      });
    },
  );
});

describe("waiting rows the commit ends (K-05 v1.1 item 19)", () => {
  it(
    "each waiting row moved gets its own event-log entry under the turn, and the answer row must be this commit's",
    SLOW,
    async () => {
      await given("commit-supersedes-waiting.json");
      const stray = requestOf("commit-supersedes-waiting.json");
      const supersede = stray.writes.waitingChat?.supersede;
      if (supersede === undefined || supersede === null) {
        throw new Error("the fixture supersedes");
      }
      supersede.answerRowId = "out-dee-booked-riley";
      const before = await snapshot();
      await expect(commitTurn(runtime, stray)).rejects.toThrow(
        "answer row is not one of this commit's outbox rows",
      );
      expect(await snapshot()).toEqual(before);

      const exchange = exchangeOf("commit-supersedes-waiting.json");
      const outcome = await commitTurn(runtime, requestOf("commit-supersedes-waiting.json"), {
        now: new Date(exchange.given.now),
      });
      expect(outcome).toEqual(exchange.outcome);
      const [entry] = await db.sql<Record<string, unknown>[]>`
      select id, at, zone, turn_id, trace_id, business_id, actor_kind, kind, table_name, row_id, old_values, new_values,
             why, approved_by
      from event_log where row_id = 'out-dee-booked-riley' and turn_id = 'turn-dee-chat-open-1'
    `;
      expect(entry).toEqual({
        id: "out-dee-booked-riley/superseded",
        at: new Date(exchange.given.now),
        zone: "America/New_York",
        turn_id: "turn-dee-chat-open-1",
        trace_id: "trace-dee-0011",
        business_id: "biz-lees-barbershop",
        actor_kind: "rosie",
        kind: "outbox_row.state_changed",
        table_name: "outbox_rows",
        row_id: "out-dee-booked-riley",
        old_values: { state: "waiting_chat" },
        new_values: { state: "superseded" },
        why: { followUp: "chatOpenAnswer", supersededBy: "out-dee-chat-open-answer" },
        approved_by: null,
      });
    },
  );
});

describe("time budget (arch 04 line 223: gate and commit within 300 ms)", () => {
  it("p95 of a commit on local PostgreSQL is under 300 ms, in this test's timing", SLOW, async () => {
    await given("commit-writes-effect.json");
    const count = 40;
    const at = "2026-11-07T15:05:00Z";
    await db.sql.begin(async (tx) => {
      for (let i = 0; i < count; i += 1) {
        const start = new Date(Date.parse("2026-12-01T14:00:00Z") + i * 3_600_000);
        const end = new Date(start.getTime() + 1_800_000);
        await insertRow(tx, "reservations", {
          id: `rsv-p95-${String(i)}`,
          business_id: "biz-lees-barbershop",
          resource_id: "res-riley",
          resource_kind: "worker",
          worker_person_id: "person-riley",
          during: `[${start.toISOString()},${end.toISOString()})`,
          state: "held",
          queued_at: at,
          held_until: "2026-11-07T15:15:00Z",
          for_agent_token: "agent-token-p95",
        });
      }
    });
    const base = requestOf("commit-writes-effect.json");
    const durations: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = String(i);
      const request = structuredClone(base);
      request.turn.id = `turn-p95-${n}`;
      const bookingId = `booking-p95-${n}`;
      const [insert] = request.writes.state;
      if (insert?.op !== "insert") {
        throw new Error("the fixture inserts its booking first");
      }
      insert.values.id = bookingId;
      request.writes.outboxRows = request.writes.outboxRows.map((row) => ({
        ...row,
        id: `${row.id}-p95-${n}`,
        bookingId,
        versionsRead: [{ table: "bookings", rowId: bookingId, version: 1 }],
      }));
      request.writes.reservations.confirm = [{ id: `rsv-p95-${n}`, expectVersion: 1, bookingId }];
      request.writes.events = request.writes.events.map((entry) => ({
        ...entry,
        id: `${entry.id}-p95-${n}`,
      }));
      const effects = request.writes.effects;
      if (effects === undefined) {
        throw new Error("the fixture writes an effect");
      }
      effects.write = effects.write.map((effect) => ({
        ...effect,
        effectId: `eff-p95-${n}`,
        idempotencyKey: `eff-p95-${n}`,
        bookingId,
        visitId: `visit-p95-${n}`,
      }));
      const started = performance.now();
      const outcome = await commitTurn(runtime, request, { now: new Date("2026-11-07T15:06:30Z") });
      durations.push(performance.now() - started);
      expect(committed(outcome).repeated).toBe(false);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * count) - 1] ?? Number.POSITIVE_INFINITY;
    console.info(`commitTurn p95 over ${String(count)} commits: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(300);
  });
});
