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
//
// T-1185: a bytea value a state write gives in K-04's text form ("\x" and hex) is written as the bytes it spells, and a
// sealed safety record opens with its person's key (sealing.ts, under a wrapping key made here from random bytes for the
// run and never written to a file); any other form is refused with nothing written. Assertions on sealed bytes compare
// to true or false, so a failing run prints none.
//
// T-1417 (K-05 v1.17 item 71): a request that carries answerPhoneRowsBy "handleId" is answered with each phones row
// named by its handle id; its section, at the end, checks those answers against v1.17's commitTurn.handleIdExchange.
import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
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
import {
  DEFAULT_WRAPPING_KEY_NAME,
  SEAL_OVERHEAD_BYTES,
  SealingError,
  type SealingErrorCode,
  seal,
  unseal,
  unsealText,
  type WrappingKeys,
} from "./sealing";
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
  it("the index lists twenty commitTurn exchanges, each valid against data-access v1.1 and the version it is listed under (Ajv strict)", () => {
    expect([...COMMIT_FIXTURES].sort()).toEqual([
      "commit-adds-dee-booking.json",
      "commit-alex-cancels-while-sending.json",
      "commit-alex-ready-text.json",
      "commit-alex-safety.json",
      "commit-alex-start.json",
      "commit-alex-stop.json",
      "commit-evening-notice.json",
      "commit-first.json",
      "commit-lets-go-outage-effect.json",
      "commit-opens-question.json",
      "commit-repeat-same-turn.json",
      "commit-reservation-lost.json",
      "commit-s1-01-sam.json",
      "commit-sam-books-alex-nov21.json",
      "commit-sam-enters-alex-yes.json",
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

// ---- bytea values (T-1185; commit-turn.ts default 11) ---------------------------------------------------------------

const MODEL_DIR = new URL("model/fixtures/", CONTRACTS);
const encoder = new TextEncoder();

/** One wrapping key per run: random, in memory only, named like the Workers secret that holds the real one. */
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? WRAP_KEY : undefined),
};

/** Bytes in K-04's text form, "\x" and lower-case hex: how actions' byteaText puts a sealed value into a commit. */
const byteaText = (bytes: Uint8Array): string =>
  `\\x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Whether `needle` appears anywhere inside `haystack`. */
function holds(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (sameBytes(haystack.subarray(start, start + needle.length), needle)) {
      return true;
    }
  }
  return false;
}

/** The SealingError code a promise fails with. Any other outcome is a failed test. */
async function sealingFailure(promise: Promise<unknown>): Promise<SealingErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SealingError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("the value opened; it should not have");
}

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** K-02 v1's safety-emergency-now read: an emergency, now, in the words of the person at the handle. */
interface SafetyRead {
  tries: { model: string; result: string }[];
  read: { labels: { outcome: string; tense: string; evidence: string; atRisk: string; writer: string }[] };
  timedOut: boolean;
  dangerWords: { words: string; list: string; kind: string }[];
  outcomes: string[];
  liftedToUnsure: boolean;
}
const EMERGENCY = readJson(new URL("safety-emergency-now.json", MODEL_DIR)) as SafetyRead;

/** The read's words that name people, as one JSON value: what a safety record seals (actions' wordsOf, default 7). */
const EMERGENCY_WORDS = JSON.stringify({
  labels: EMERGENCY.read.labels.map(({ evidence, atRisk, writer }) => ({ evidence, atRisk, writer })),
  dangerWords: EMERGENCY.dangerWords.map((match) => match.words),
});

const OUTCOME_ID = "safety-alex-0050";
const PAUSE_ID = "pause-alex-address-t1185";
const NOT_TEXT_FORM = 'a value that is not "\\x" and hex digit pairs';

/**
 * commit-alex-safety.json's turn with its text's safety record (K-34 safety_outcomes: evt-alex-0050 read as K-02's
 * emergency), its sealed words given as `sealedWords`.
 */
function safetyCommit(sealedWords: unknown): CommitTurnRequest {
  const request = requestOf("commit-alex-safety.json");
  request.writes.state.push({
    op: "insert",
    table: "safety_outcomes",
    values: {
      id: OUTCOME_ID,
      event_id: "evt-alex-0050",
      source: "text",
      handle_id: "handle-alex",
      person_id: "person-alex",
      business_id: "biz-lees-barbershop",
      booking_id: null,
      turn_id: request.turn.id,
      read_at: "2026-11-07T15:59:57Z",
      tries: EMERGENCY.tries,
      timed_out: EMERGENCY.timedOut,
      labels: EMERGENCY.read.labels.map((label) => label.outcome),
      tenses: EMERGENCY.read.labels.map((label) => label.tense),
      danger_word_lists: EMERGENCY.dangerWords.map((match) => match.list),
      danger_word_kinds: EMERGENCY.dangerWords.map((match) => match.kind),
      sealed_words: sealedWords,
      outcomes: EMERGENCY.outcomes,
      lifted_to_unsure: EMERGENCY.liftedToUnsure,
    },
  });
  return request;
}

/** The safety record's sealed words as stored, as postgres.js reads a bytea column (its bytes). */
async function storedWords(): Promise<Uint8Array> {
  const [row] = await db.sql<{ sealed_words: Uint8Array | null }[]>`
    select sealed_words from safety_outcomes where id = ${OUTCOME_ID}
  `;
  if (row?.sealed_words === null || row?.sealed_words === undefined) {
    throw new Error("the safety record holds no sealed words");
  }
  return new Uint8Array(row.sealed_words);
}

async function safetyRecords(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from safety_outcomes`;
  return row?.n ?? 0;
}

describe("a bytea value a commit writes: K-04's text form as its bytes (T-1185; default 11)", () => {
  it(
    "a safety record written by a commit opens with the person's key to the exact sealed words",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-safety.json");
      // Alex's key is made by the first seal, as the gateway makes it at first sight; the read's words go under it.
      const sealed = await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS);
      const request = safetyCommit(byteaText(sealed));
      expect(schemaErrors("commitTurn.request", request)).toEqual([]);
      const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
      // safety_outcomes carries no version, so the answer lists no row for it: the fixture's own answer.
      expect(outcome).toEqual(exchange.outcome);
      expect(await safetyRecords()).toBe(1);
      expect(await unsealText(db.sql, KEYS, "person-alex", await storedWords())).toBe(EMERGENCY_WORDS);
    },
  );

  it("the stored bytes equal the hex form's bytes, byte for byte", SLOW, async () => {
    const exchange = await given("commit-alex-safety.json");
    const sealed = await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS);
    const text = byteaText(sealed);
    committed(await commitTurn(runtime, safetyCommit(text), { now: new Date(exchange.given.now) }));
    const [row] = await db.sql<{ same: boolean; hex: string; length: number }[]>`
      select sealed_words = decode(${text.slice(2)}, 'hex') as same, encode(sealed_words, 'hex') as hex,
             octet_length(sealed_words) as length
      from safety_outcomes where id = ${OUTCOME_ID}
    `;
    // The database's own reading of the hex, and the column back as hex: the same bytes, one per pair of digits.
    expect(row?.same, "sealed_words is decode(hex) of the text form").toBe(true);
    expect(`\\x${row?.hex ?? ""}` === text, "sealed_words read back as hex is the text form").toBe(true);
    expect(row?.length).toBe(sealed.length);
    expect(sealed.length).toBe(SEAL_OVERHEAD_BYTES + encoder.encode(EMERGENCY_WORDS).length);
    expect(sameBytes(await storedWords(), sealed), "postgres.js reads back the sealed bytes").toBe(true);
  });

  it("a value that is not hex is refused, and nothing is written", SLOW, async () => {
    const exchange = await given("commit-alex-safety.json");
    const now = new Date(exchange.given.now);
    const sealed = await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS);
    const text = byteaText(sealed);
    const notTextForm: [string, unknown][] = [
      ["hex with no \\x", text.slice(2)],
      ["an odd number of hex digits", `${text}0`],
      ["a character that is not hex", `${text.slice(0, -1)}g`],
      ["a space between the pairs", `${text.slice(0, 4)} ${text.slice(4)}`],
      ["a doubled backslash", `\\${text}`],
      ["an upper-case \\X", `\\X${text.slice(2)}`],
      ["the escape format", "Words of a text\\000"],
      ["the words themselves", EMERGENCY_WORDS],
      ["a number", 171],
      ["a list of byte values", [...sealed]],
      ["an object", { base64: "AQI=" }],
      ["bytes already made", sealed],
    ];
    const before = await snapshot();
    for (const [what, value] of notTextForm) {
      const error = await thrownBy(commitTurn(runtime, safetyCommit(value), { now }));
      // Thrown before the record's insert is sent, naming the column and never the value; the turn row rolls back.
      expect(error, what).toBeInstanceOf(TypeError);
      expect((error as Error).message, what).toBe(
        `commitTurn: a state insert into safety_outcomes gives safety_outcomes.sealed_words ${NOT_TEXT_FORM}`,
      );
      expect(await snapshot(), what).toEqual(before);
      expect(await footprint("turn-alex-safety-1"), what).toEqual(NO_FOOTPRINT);
      expect(await safetyRecords(), what).toBe(0);
    }
    // Refused for its value alone: the same commit with the text form commits.
    expect(await commitTurn(runtime, safetyCommit(text), { now })).toEqual(exchange.outcome);
    expect(await safetyRecords()).toBe(1);
  });

  it(
    "the sealed words stay sealed: not in the row in the clear, and another person's key does not open them",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-safety.json");
      const sealed = await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS);
      const now = new Date(exchange.given.now);
      committed(await commitTurn(runtime, safetyCommit(byteaText(sealed)), { now }));
      const stored = await storedWords();
      for (const label of EMERGENCY.read.labels) {
        expect(holds(stored, encoder.encode(label.evidence)), "the evidence words in the clear").toBe(false);
      }
      for (const match of EMERGENCY.dangerWords) {
        expect(holds(stored, encoder.encode(match.words)), "the danger words in the clear").toBe(false);
      }
      // Sam gets a key of his own; Alex's words do not open under it (sealing.ts binds a value to its person).
      await seal(db.sql, KEYS, "person-sam", "Sam's own stand-in words, so Sam has a key");
      expect(await sealingFailure(unseal(db.sql, KEYS, "person-sam", stored))).toBe("cannot_open");
      expect(await unsealText(db.sql, KEYS, "person-alex", stored)).toBe(EMERGENCY_WORDS);
    },
  );

  it(
    "a state update writes a bytea column as its bytes too, and refuses one that is not hex (a pause's sealed address)",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-safety.json");
      const now = new Date(exchange.given.now);
      const firstAddress = "A stand-in address for Alex, not real (1)";
      const secondAddress = "A stand-in address for Alex, not real (2)";
      const first = await seal(db.sql, KEYS, "person-alex", firstAddress);
      const second = await seal(db.sql, KEYS, "person-alex", secondAddress);
      const pause = requestOf("commit-alex-safety.json");
      pause.writes.state.push({
        op: "insert",
        table: "pauses",
        values: {
          id: PAUSE_ID,
          business_id: "biz-lees-barbershop",
          target: "address",
          address: byteaText(first),
          sealed_for_person_id: "person-alex",
          set_by_turn_id: pause.turn.id,
          set_at: exchange.given.now,
        },
      });
      const inserted = committed(await commitTurn(runtime, pause, { now }));
      expect(inserted.committed.written).toEqual([{ table: "pauses", rowId: PAUSE_ID, version: 1 }]);

      const storedAddress = async (): Promise<{ address: Uint8Array; version: number }> => {
        const [row] = await db.sql<{ address: Uint8Array; version: number }[]>`
          select address, version from pauses where id = ${PAUSE_ID}
        `;
        if (row === undefined) {
          throw new Error("the pause was not written");
        }
        return { address: new Uint8Array(row.address), version: row.version };
      };
      const move = (address: unknown): CommitTurnRequest => {
        const request = requestOf("commit-alex-safety.json");
        request.turn = {
          ...request.turn,
          id: "turn-alex-address-2",
          eventIds: ["evt-alex-0051"],
          traceId: "trace-alex-0051",
        };
        request.writes.outboxRows = [];
        request.writes.state = [
          { op: "update", table: "pauses", key: { id: PAUSE_ID }, expectVersion: 1, set: { address } },
        ];
        return request;
      };

      const before = await snapshot();
      const error = await thrownBy(commitTurn(runtime, move(byteaText(second).slice(2)), { now }));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        `commitTurn: a state update of pauses gives pauses.address ${NOT_TEXT_FORM}`,
      );
      expect(await snapshot()).toEqual(before);
      expect(await footprint("turn-alex-address-2")).toEqual(NO_FOOTPRINT);
      const kept = await storedAddress();
      expect(kept.version).toBe(1);
      expect(sameBytes(kept.address, first), "the refused update left the first address").toBe(true);

      const updated = committed(await commitTurn(runtime, move(byteaText(second)), { now }));
      expect(updated.committed.written).toEqual([{ table: "pauses", rowId: PAUSE_ID, version: 2 }]);
      const moved = await storedAddress();
      expect(moved.version).toBe(2);
      expect(sameBytes(moved.address, second), "the stored address is the second address's bytes").toBe(true);
      expect(await unsealText(db.sql, KEYS, "person-alex", moved.address)).toBe(secondAddress);
    },
  );
});

// ---- T-1339: postgres.js's statement errors leave scrubbed (T-1322's handoff a; as clocks.ts's scrubbed, T-1268) ----
//
// Five errors are made for real on local PostgreSQL by postgres.js as installed, each around a made-up number (rule 9: a
// 555-01xx number) that postgres.js keeps among the statement's values (args): its own UNDEFINED_VALUE; the TypeError its
// bytea serializer throws, the number in its message too; PostgreSQL's refusal of a statement (22P02, the number in its
// message); a unique constraint's refusal of a row (23505, the number in its detail, with its table's and constraint's
// names); and a serialization failure (40001, raised with the number in its message). Each reaches commitTurn as
// postgres.js rejects the call's first statement with it, on a client whose socket fails with it (as
// connect-failures.int.test.ts delivers a socket's error), so the call's own catch meets it as it meets the error of any
// statement of the commit. postgres.js's two leave as a new Error with the call's name and the code alone, and 22P02 as
// CommitTurnDatabaseError with its SQLSTATE alone; 23505 still answers constraint with its SQLSTATE and the constraint's
// name (K-05 item 1), and 40001 still answers transient. Nothing that leaves holds the number: not its message, its stack
// or any other own property, walked deeply.

describe("commitTurn: postgres.js's statement errors leave with the call's name and code alone (T-1339)", () => {
  type Kind = "undefinedValue" | "serialize" | "refusal" | "unique" | "serialization";
  /** Thrown with a client's code, thrown as CommitTurnDatabaseError (its message's SQLSTATE: `shown`), or answered. */
  type Expected =
    | { client: string }
    | { database: { code: string; table: string | null; constraint: string | null; shown: string } }
    | { answer: unknown };
  const NUMBER = "+15555550139";
  const KINDS: { kind: Kind; name: string; expected: Expected }[] = [
    {
      kind: "undefinedValue",
      name: "postgres.js's UNDEFINED_VALUE, the number in its args, leaves with its code alone",
      expected: { client: "UNDEFINED_VALUE" },
    },
    {
      kind: "serialize",
      name: "the TypeError of postgres.js's bytea serializer, the number in its message, leaves with its code alone",
      expected: { client: "ERR_INVALID_ARG_TYPE" },
    },
    {
      kind: "refusal",
      name: "PostgreSQL's 22P02, the number in its message, still leaves as CommitTurnDatabaseError, its SQLSTATE alone",
      expected: { database: { code: "22P02", table: null, constraint: null, shown: "22P02" } },
    },
    {
      kind: "unique",
      name: "a unique constraint's 23505, the number in its detail, still answers constraint with its SQLSTATE and name",
      expected: { answer: { error: "constraint", sqlstate: "23505", constraint: "t1339_numbers_key" } },
    },
    {
      kind: "serialization",
      name: "PostgreSQL's 40001, the number in its message, still answers transient with its SQLSTATE",
      expected: { answer: { error: "transient", sqlstate: "40001" } },
    },
  ];
  let made: Record<Kind, Error>;

  /** Every text `value` holds, deeply: its own keys and their values, enumerable or not, its stack among them. */
  const textsOf = (value: unknown, seen = new Set<object>()): string[] => {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return Reflect.ownKeys(value).flatMap((key) => [
      String(key),
      ...textsOf((value as Record<PropertyKey, unknown>)[key], seen),
    ]);
  };
  const holdsNumber = (value: unknown): boolean =>
    textsOf(value).some((text) => text.includes(NUMBER.slice(1)));

  /** The error `statement` is refused with. */
  const refusalOf = async (statement: Promise<unknown>): Promise<Error> => {
    try {
      await statement;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
    }
    throw new Error("the statement was not refused with an error");
  };

  /** commitTurn's outcome on a client whose socket fails with `raw`, which rejects its first statement with it. */
  const outcomeOn = async (raw: Error): Promise<{ answer: unknown } | { thrown: unknown }> => {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    const sql = postgres("postgres://t1339@db-t1339.example.invalid:65123/t1339", options);
    try {
      return { answer: await commitTurn(sql, requestOf("commit-first.json")) };
    } catch (error) {
      return { thrown: error };
    } finally {
      await sql.end({ timeout: 0 });
    }
  };

  beforeAll(async () => {
    const sql = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
    try {
      await sql`create temp table t1339_numbers (number text constraint t1339_numbers_key unique)`;
      await sql`insert into t1339_numbers (number) values (${NUMBER})`;
      await sql.unsafe(`
        create function pg_temp.t1339_serialization(number text) returns void language plpgsql as $$
        begin
          raise exception using errcode = '40001', message = 'could not serialize ' || number;
        end $$
      `);
      made = {
        refusal: await refusalOf(sql`select ${NUMBER}::uuid as id`),
        unique: await refusalOf(sql`insert into t1339_numbers (number) values (${NUMBER})`),
        undefinedValue: await refusalOf(
          sql`select ${NUMBER}::text as number, ${undefined as never}::text as gone`,
        ),
        serialization: await refusalOf(sql`select pg_temp.t1339_serialization(${NUMBER})`),
        serialize: await refusalOf(sql`select ${sql.typed(Number(NUMBER.slice(1)), 17)} as bytes`),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each(KINDS)("$name", async ({ kind, expected }) => {
    const raw = made[kind];
    // The error holds the number, so the check means something; postgres.js put the statement on it.
    expect(holdsNumber(raw)).toBe(true);
    expect(Object.hasOwn(raw, "args")).toBe(true);
    const outcome = await outcomeOn(raw);
    // Booleans first, so a failing run prints neither error's text.
    expect(holdsNumber(outcome)).toBe(false);
    if ("answer" in expected) {
      expect(outcome).toEqual({ answer: expected.answer });
      return;
    }
    if (!("thrown" in outcome)) {
      throw new Error("commitTurn answered");
    }
    const { thrown } = outcome;
    expect(thrown === raw).toBe(false);
    if ("database" in expected) {
      const { code, table, constraint, shown } = expected.database;
      expect(Object.getPrototypeOf(thrown) === CommitTurnDatabaseError.prototype).toBe(true);
      expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
        "code",
        "constraint",
        "message",
        "name",
        "stack",
        "table",
      ]);
      expect(thrown).toMatchObject({
        name: "CommitTurnDatabaseError",
        code,
        table,
        constraint,
        message: `commitTurn: the database refused the commit (SQLSTATE ${shown})`,
      });
      return;
    }
    // A plain Error of its own: no subclass, cause or property of the original's.
    expect(Object.getPrototypeOf(thrown) === Error.prototype).toBe(true);
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
    expect(thrown).toMatchObject({
      name: "Error",
      call: "commitTurn",
      code: expected.client,
      message: `commitTurn: the database call failed (code ${expected.client})`,
    });
  });
});

// ---- T-1417: a phones row named by its handle id when the request asks (K-05 v1.17 item 71; DL-872, DL-876) --------
//
// K-08 v1 names a phone row by its handle id (phones.handle_id, unique in K-04), never by its number
// (contracts/event-trace/README.md lines 42 and 263), and the turn's span copies the rows commitTurn answers
// (actions/src/commit/commit.ts spanRowsOf). K-05 v1.17 (T-1418) gives the request one optional field,
// answerPhoneRowsBy "handleId": with it, every row reference the call answers names a phones row by the handle id of
// the row as the commit locked or wrote it; without it the answer is v1.16's, byte for byte, as the fixture loop above
// and the other files that run v1 to v1.16's commit exchanges show, unchanged. A request still names a phones row by
// its primary key, the number, and the commit locks, compares and writes the row by it.
//
// Each answer to a request that asks is checked, with its exchange, against v1.17's commitTurn.handleIdExchange with
// Ajv, never by the generated types alone (they are wider than the schema: K-05 v1.17 default 150), and each phones row
// it names is checked equal to the handle id stored on that row (K-08's safeId alone takes a number wrapped in
// letters: DL-885). Every number here is a whole 555-01xx literal (rule 9), and each check that could show one is a
// boolean, asked first, so a failing run prints none.

const V117_ID = schemaIdOf("v1.17");
const K08_ID = (readJson(new URL("event-trace/event-trace.v1.schema.json", CONTRACTS)) as { $id: string })
  .$id;
/** Alex's number (K-04's seeds) and Dee W.'s (K-05 v1.1's chain). */
const ALEX_NUMBER = "+15555550101";
const DEE_NUMBER = "+15555550107";
/** A phones row this file writes with an empty handle id, which no CHECK of K-04 refuses. */
const BLANK_NUMBER = "+15555550176";
const HANDLE_ID_ENTRIES = INDEX.filter((entry) => entry.def === "commitTurn.handleIdExchange");
const HANDLE_ID_FIXTURES = HANDLE_ID_ENTRIES.filter((entry) => entry.expect === "accept").map(
  (entry) => entry.file,
);
/** Each v1.17 commit that is an earlier commit in its v1.17 form, with that earlier twin (K-05 README "Fixtures"). */
const TWINS: readonly (readonly [string, string])[] = [
  ["commit-alex-stop-handle-id.json", "commit-alex-stop.json"],
  ["commit-alex-start-handle-id.json", "commit-alex-start.json"],
  ["commit-adds-dee-booking-handle-id.json", "commit-adds-dee-booking.json"],
];

/** Every row the answer names, as K-08 v1's span row reference (table and id), the way spanRowsOf copies them. */
function rowsNamed(outcome: CommitTurnOutcome): { table: string; id: string }[] {
  if ("result" in outcome) {
    const { written, waitingChat } = outcome.committed;
    return [...written, ...(waitingChat?.superseded ?? []), ...(waitingChat?.withdrawn ?? [])].map((row) => ({
      table: row.table,
      id: row.rowId,
    }));
  }
  switch (outcome.error) {
    case "versionChanged":
      return outcome.changed.map((row) => ({ table: row.table, id: row.rowId }));
    case "wrongState":
      return [{ table: outcome.table, id: outcome.rowId }];
    case "reservationLost":
      return outcome.reservations.map((row) => ({ table: "reservations", id: row.id }));
    default:
      return [];
  }
}

/** The ids the answer names phones rows by, in its order. */
function phonesNamed(outcome: CommitTurnOutcome): string[] {
  return rowsNamed(outcome)
    .filter((row) => row.table === "phones")
    .map((row) => row.id);
}

/**
 * Whether every row the answer names is a K-08 v1 rowRef (its id a safeId: no "+", never seven or more digits and
 * phone punctuation), and the answer holds the digits of none of `numbers` anywhere.
 */
function namesNoNumber(outcome: CommitTurnOutcome, numbers: readonly string[]): boolean {
  const text = JSON.stringify(outcome);
  return (
    rowsNamed(outcome).every((row) => schemaErrors("rowRef", row, K08_ID).length === 0) &&
    numbers.every((number) => !text.includes(number.slice(1)))
  );
}

/** The phones rows a request names, by number: its versions read, its state updates' keys and its inserted rows. */
function phoneNumbersOf(request: CommitTurnRequest): string[] {
  const numbers = new Set<string>();
  for (const ref of request.versionsRead) {
    if (ref.table === "phones") {
      numbers.add(ref.rowId);
    }
  }
  for (const write of request.writes.state) {
    const number = write.op === "update" ? write.key.number : write.values.number;
    if (write.table === "phones" && typeof number === "string") {
      numbers.add(number);
    }
  }
  return [...numbers];
}

/** The handle id stored on the phones row under `number` (this file's own read, as the tables' owner), or null. */
async function handleIdOf(number: string): Promise<string | null> {
  const [row] = await db.sql<{ handle_id: string }[]>`select handle_id from phones where number = ${number}`;
  return row?.handle_id ?? null;
}

/** The phones row stored under `number`, with what this card checks. */
async function phoneRow(
  number: string,
): Promise<{ handle_id: string; stopped: boolean; chat_open: boolean; version: number }[]> {
  return db.sql<{ handle_id: string; stopped: boolean; chat_open: boolean; version: number }[]>`
    select handle_id, stopped, chat_open, version from phones where number = ${number}
  `;
}

/** Ajv's errors for the exchange a commit makes, at v1.17's commitTurn.handleIdExchange (none when it passes). */
function handleIdExchangeErrors(
  given: Given,
  request: CommitTurnRequest,
  outcome: CommitTurnOutcome,
): string[] {
  return schemaErrors(
    "commitTurn.handleIdExchange",
    { call: "commitTurn", given, request, outcome },
    V117_ID,
  );
}

describe("a phones row is named by its handle id when the request asks, never its number (K-05 v1.17; T-1417)", () => {
  it("v1.17 lists four commits that ask and one refused; it refuses a phones row answered by its number, and so does K-08 v1's rowRef, so the checks below mean something", () => {
    expect(HANDLE_ID_ENTRIES.map((entry) => entry.file).sort()).toEqual([
      "commit-adds-dee-booking-handle-id.json",
      "commit-alex-phone-changed-handle-id.json",
      "commit-alex-start-handle-id.json",
      "commit-alex-stop-handle-id.json",
      "invalid/refuse-commit-alex-stop-answers-number.json",
    ]);
    for (const file of HANDLE_ID_FIXTURES) {
      const exchange = exchangeOf(file);
      expect(exchange.request.answerPhoneRowsBy, file).toBe("handleId");
      expect(schemaErrors("commitTurn.handleIdExchange", exchange, V117_ID), file).toEqual([]);
    }
    // The STOP's answer with Alex's phone row named by his number, though its request asks: refused for that alone.
    const refused = exchangeOf("invalid/refuse-commit-alex-stop-answers-number.json");
    const errors = schemaErrors("commitTurn.handleIdExchange", refused, V117_ID);
    expect(errors.some((error) => error.startsWith("/outcome/committed/written/0/rowId "))).toBe(true);
    const mended = structuredClone(refused) as unknown as {
      outcome: { committed: { written: { rowId: string }[] } };
    };
    const [written] = mended.outcome.committed.written;
    if (written === undefined) {
      throw new Error("the refused fixture writes one row");
    }
    written.rowId = "handle-alex";
    expect(schemaErrors("commitTurn.handleIdExchange", mended, V117_ID)).toEqual([]);
    // The rule binds a request that asks: the same answer to a request that does not is v1.16's, and v1.17 takes it.
    const unasked = structuredClone(refused);
    delete unasked.request.answerPhoneRowsBy;
    expect(schemaErrors("commitTurn.exchange", unasked, V117_ID)).toEqual([]);
    expect(schemaErrors("commitTurn.handleIdExchange", unasked, V117_ID).length > 0).toBe(true);
    // K-08 v1's span row reference, which spanRowsOf fills from this answer, refuses a number in either form.
    expect(schemaErrors("rowRef", { table: "phones", id: ALEX_NUMBER }, K08_ID).length > 0).toBe(true);
    expect(schemaErrors("rowRef", { table: "phones", id: ALEX_NUMBER.slice(1) }, K08_ID).length > 0).toBe(
      true,
    );
    expect(schemaErrors("rowRef", { table: "phones", id: "handle-alex" }, K08_ID)).toEqual([]);
  });

  for (const file of HANDLE_ID_FIXTURES) {
    it(
      `${file}: as rosie_job, the call answers the fixture's outcome, each phones row by the handle id stored on it, all or nothing`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const request = exchange.request as unknown as CommitTurnRequest;
        const numbers = phoneNumbersOf(request);
        const before = await snapshot();
        const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
        expect(numbers.length > 0 && namesNoNumber(outcome, numbers)).toBe(true);
        expect(phonesNamed(outcome)).toEqual(await Promise.all(numbers.map((number) => handleIdOf(number))));
        expect(outcome).toEqual(exchange.outcome);
        expect(handleIdExchangeErrors(exchange.given, request, outcome)).toEqual([]);
        if ("error" in outcome) {
          // Refused: nothing at all was written.
          expect(await snapshot()).toEqual(before);
          expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
          return;
        }
        expect(outcome.repeated).toBe(false);
        expect(await footprint(request.turn.id)).toEqual({
          ...NO_FOOTPRINT,
          turns: 1,
          outbox: request.writes.outboxRows.length,
          events: request.writes.events.length,
        });
      },
    );
  }

  it(
    "a STOP's state update of a phones row, keyed by its number, answers written with the row's own handle id; so does the START after it",
    SLOW,
    async () => {
      const stopExchange = await given("commit-alex-stop-handle-id.json");
      const stop = requestOf("commit-alex-stop-handle-id.json");
      const [stopWrite] = stop.writes.state;
      // The request asks, and still names the row by its primary key, the number (K-05 v1.17 item 71, step 4).
      expect(
        stop.answerPhoneRowsBy === "handleId" &&
          stopWrite?.op === "update" &&
          stopWrite.table === "phones" &&
          stopWrite.key.number === ALEX_NUMBER,
      ).toBe(true);
      const stopped = await commitTurn(runtime, stop, { now: new Date(stopExchange.given.now) });
      expect(namesNoNumber(stopped, [ALEX_NUMBER])).toBe(true);
      expect(phonesNamed(stopped)).toEqual([await handleIdOf(ALEX_NUMBER)]);
      expect(handleIdExchangeErrors(stopExchange.given, stop, stopped)).toEqual([]);
      expect(committed(stopped).committed).toEqual({
        written: [{ table: "phones", rowId: "handle-alex", version: 4 }],
        outboxRows: [{ id: "out-alex-stop-reply", commitSeq: 3 }],
        promoted: [],
      });
      // The write went by the number: that row is stopped, its chat closed, at version 4.
      expect(await phoneRow(ALEX_NUMBER)).toEqual([
        { handle_id: "handle-alex", stopped: true, chat_open: false, version: 4 },
      ]);

      // His START fourteen minutes later, after the STOP that asked, as its chain runs it.
      const startExchange = exchangeOf("commit-alex-start-handle-id.json");
      expect(startExchange.given.after).toEqual(["commit-alex-stop-handle-id.json"]);
      const start = requestOf("commit-alex-start-handle-id.json");
      const started = await commitTurn(runtime, start, { now: new Date(startExchange.given.now) });
      expect(namesNoNumber(started, [ALEX_NUMBER])).toBe(true);
      expect(phonesNamed(started)).toEqual([await handleIdOf(ALEX_NUMBER)]);
      expect(handleIdExchangeErrors(startExchange.given, start, started)).toEqual([]);
      expect(committed(started).committed).toEqual({
        written: [{ table: "phones", rowId: "handle-alex", version: 5 }],
        outboxRows: [{ id: "out-alex-start-reply", commitSeq: 4 }],
        promoted: [],
      });
      expect(await phoneRow(ALEX_NUMBER)).toEqual([
        { handle_id: "handle-alex", stopped: false, chat_open: true, version: 5 },
      ]);
    },
  );

  it(
    "an insert of a phones row answers written with the handle id its own insert returned, at version 1; every other row by its key",
    SLOW,
    async () => {
      const exchange = await given("commit-adds-dee-booking-handle-id.json");
      const request = requestOf("commit-adds-dee-booking-handle-id.json");
      // Dee has no phones row before the commit: her handle id can come from nothing but the insert's own returning.
      expect((await phoneRow(DEE_NUMBER)).length).toBe(0);
      const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
      expect(namesNoNumber(outcome, [DEE_NUMBER])).toBe(true);
      expect(phonesNamed(outcome)).toEqual([await handleIdOf(DEE_NUMBER)]);
      expect(handleIdExchangeErrors(exchange.given, request, outcome)).toEqual([]);
      // Her person, role and booking keep their primary keys; handles and person_handles carry no version.
      expect(committed(outcome).committed).toEqual({
        written: [
          { table: "persons", rowId: "person-dee", version: 1 },
          { table: "phones", rowId: "handle-dee", version: 1 },
          { table: "person_roles", rowId: "role-dee-lees-customer", version: 1 },
          { table: "bookings", rowId: "booking-dee-riley-nov14", version: 1 },
        ],
        outboxRows: [{ id: "out-dee-booked-riley", commitSeq: 1 }],
        promoted: [],
      });
      expect(await phoneRow(DEE_NUMBER)).toEqual([
        { handle_id: "handle-dee", stopped: false, chat_open: false, version: 1 },
      ]);
    },
  );

  it(
    "a stale version of a phones row, read or written, answers versionChanged naming the row's own handle id, and writes nothing",
    SLOW,
    async () => {
      // Read (FOR SHARE), the v1.17 twin: Sam's turn read Alex's phone at version 3, and Alex's STOP, which asked,
      // has moved it to 4.
      const readExchange = await given("commit-alex-phone-changed-handle-id.json");
      const read = requestOf("commit-alex-phone-changed-handle-id.json");
      const readBefore = await snapshot();
      const readOutcome = await commitTurn(runtime, read, { now: new Date(readExchange.given.now) });
      expect(namesNoNumber(readOutcome, [ALEX_NUMBER])).toBe(true);
      expect(phonesNamed(readOutcome)).toEqual([await handleIdOf(ALEX_NUMBER)]);
      expect(handleIdExchangeErrors(readExchange.given, read, readOutcome)).toEqual([]);
      expect(readOutcome).toEqual({
        error: "versionChanged",
        changed: [{ table: "phones", rowId: "handle-alex", readVersion: 3, currentVersion: 4 }],
      });
      expect(await snapshot()).toEqual(readBefore);
      expect(await footprint(read.turn.id)).toEqual(NO_FOOTPRINT);

      // Written (FOR UPDATE), which no fixture shows: Alex's STOP expects his phone at version 2; it is at 3.
      const writeExchange = await given("commit-alex-stop-handle-id.json");
      const written = requestOf("commit-alex-stop-handle-id.json");
      written.versionsRead = [];
      const [stopWrite] = written.writes.state;
      if (stopWrite?.op !== "update") {
        throw new Error("the fixture's first state write is the phone's update");
      }
      stopWrite.expectVersion = 2;
      const writeBefore = await snapshot();
      const writeOutcome = await commitTurn(runtime, written, { now: new Date(writeExchange.given.now) });
      expect(namesNoNumber(writeOutcome, [ALEX_NUMBER])).toBe(true);
      expect(phonesNamed(writeOutcome)).toEqual([await handleIdOf(ALEX_NUMBER)]);
      expect(handleIdExchangeErrors(writeExchange.given, written, writeOutcome)).toEqual([]);
      expect(writeOutcome).toEqual({
        error: "versionChanged",
        changed: [{ table: "phones", rowId: "handle-alex", readVersion: 2, currentVersion: 3 }],
      });
      expect(await snapshot()).toEqual(writeBefore);
      expect(await footprint(written.turn.id)).toEqual(NO_FOOTPRINT);
    },
  );

  it(
    "a phones row with an empty handle id fails closed when the request asks: the commit throws naming no number, and writes nothing",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-stop-handle-id.json");
      const now = new Date(exchange.given.now);
      // K-04 takes an empty handle id (no CHECK names it); the answer must never name this row by its number instead.
      await insertRow(db.sql, "handles", { id: "", kind: "phone", address: BLANK_NUMBER });
      await insertRow(db.sql, "phones", { number: BLANK_NUMBER, handle_id: "" });
      const blank = (version: number): CommitTurnRequest => {
        // The STOP twin's request, which asks (answerPhoneRowsBy "handleId"), turned on the blank row.
        const request = requestOf("commit-alex-stop-handle-id.json");
        request.turn = {
          ...request.turn,
          id: "turn-t1417-blank",
          eventIds: ["evt-t1417-0002"],
          traceId: "trace-t1417-0002",
        };
        request.versionsRead = [];
        request.writes.state = [
          {
            op: "update",
            table: "phones",
            key: { number: BLANK_NUMBER },
            expectVersion: version,
            set: { poll_voted_at: exchange.given.now },
          },
        ];
        request.writes.outboxRows = [];
        request.writes.events = [];
        return request;
      };
      const before = await snapshot();
      // Its write (version 1, current) and its compare (version 2, stale) each throw before any answer is made.
      for (const version of [1, 2]) {
        const what = `expecting version ${String(version)}`;
        const request = blank(version);
        expect(request.answerPhoneRowsBy, what).toBe("handleId");
        const error = await thrownBy(commitTurn(runtime, request, { now }));
        expect(error instanceof Error, what).toBe(true);
        const message = error instanceof Error ? error.message : "";
        expect(message.includes(BLANK_NUMBER.slice(1)), what).toBe(false);
        expect(message, what).toBe("commitTurn: a phones row has no handle_id to name it by in the answer");
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint("turn-t1417-blank"), what).toEqual(NO_FOOTPRINT);
      }
      expect(await phoneRow(BLANK_NUMBER)).toEqual([
        { handle_id: "", stopped: false, chat_open: false, version: 1 },
      ]);
    },
  );

  it(
    "a repeat names no phones row, whether its first commit asked or not, and writes nothing (K-05 v1.17 default 151)",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-stop-handle-id.json");
      const now = new Date(exchange.given.now);
      const request = requestOf("commit-alex-stop-handle-id.json");
      // The first commit's answer, whatever either request asked: written and promoted empty (K-05 item 1).
      const firstCommit = {
        result: "committed",
        turnId: "turn-alex-stop-1",
        committedAt: "2026-11-07T15:06:36Z",
        repeated: true,
        committed: { written: [], outboxRows: [{ id: "out-alex-stop-reply", commitSeq: 3 }], promoted: [] },
      };
      const later = new Date("2026-11-07T15:06:40Z");

      // The first commit asked.
      expect(committed(await commitTurn(runtime, request, { now })).repeated).toBe(false);
      const asked = await snapshot();
      const repeat = await commitTurn(runtime, request, { now: later });
      expect(namesNoNumber(repeat, [ALEX_NUMBER])).toBe(true);
      expect(phonesNamed(repeat)).toEqual([]);
      expect(repeat).toEqual(firstCommit);
      expect(handleIdExchangeErrors(exchange.given, request, repeat)).toEqual([]);
      expect(await snapshot()).toEqual(asked);

      // The first commit did not ask (v1.16's answer); a repeat that asks is still that commit's answer.
      await given("commit-alex-stop-handle-id.json");
      const unasked = requestOf("commit-alex-stop-handle-id.json");
      delete unasked.answerPhoneRowsBy;
      expect(committed(await commitTurn(runtime, unasked, { now })).repeated).toBe(false);
      const notAsked = await snapshot();
      const askingRepeat = await commitTurn(runtime, request, { now: later });
      expect(namesNoNumber(askingRepeat, [ALEX_NUMBER])).toBe(true);
      expect(askingRepeat).toEqual(firstCommit);
      expect(handleIdExchangeErrors(exchange.given, request, askingRepeat)).toEqual([]);
      expect(await snapshot()).toEqual(notAsked);
    },
  );

  it(
    "an answered handle id passed back where a request names a phones row names no row: the call throws and writes nothing",
    SLOW,
    async () => {
      // Alex's STOP has committed, answering his phone as phones/handle-alex at version 4 (the START twin's chain).
      const exchange = await given("commit-alex-start-handle-id.json");
      const now = new Date(exchange.given.now);
      const asRead = requestOf("commit-alex-start-handle-id.json");
      asRead.versionsRead = [{ table: "phones", rowId: "handle-alex", version: 4 }];
      const asKey = requestOf("commit-alex-start-handle-id.json");
      const [startWrite] = asKey.writes.state;
      if (startWrite?.op !== "update") {
        throw new Error("the fixture's first state write is the phone's update");
      }
      startWrite.key = { number: "handle-alex" };
      const before = await snapshot();
      for (const [what, request] of [
        ["as a version read", asRead],
        ["as the update's key", asKey],
      ] as const) {
        // A name, never a key (K-05 v1.17 item 71, step 4): no phones row is stored under it (db/repo default 1).
        const error = await thrownBy(commitTurn(runtime, request, { now }));
        expect(error instanceof TypeError, what).toBe(true);
        expect(error instanceof Error ? error.message : "", what).toBe(
          "commitTurn: a row of phones the request names does not exist (default 1)",
        );
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint(request.turn.id), what).toEqual(NO_FOOTPRINT);
      }
      // Named by its number, as every request names it, the same START commits.
      expect(await commitTurn(runtime, requestOf("commit-alex-start-handle-id.json"), { now })).toEqual(
        exchange.outcome,
      );
    },
  );

  for (const [twin, earlier] of TWINS) {
    it(
      `${twin} without the field is ${earlier}'s request, and answers its outcome: the field alone changes the answer`,
      SLOW,
      async () => {
        const exchange = await given(twin);
        const request = requestOf(twin);
        delete request.answerPhoneRowsBy;
        const before = exchangeOf(earlier);
        // Booleans, so a failing run prints no number: the earlier answer names the phones row by its number.
        expect(isDeepStrictEqual(request, before.request)).toBe(true);
        const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
        expect(isDeepStrictEqual(outcome, before.outcome)).toBe(true);
        expect(answerErrors(outcome, V117_ID)).toEqual([]);
        expect(schemaErrors("commitTurn.exchange", { ...before, outcome }, V117_ID)).toEqual([]);
      },
    );
  }

  it(
    "an answerPhoneRowsBy other than handleId is refused before the database is reached, naming the field alone (default 12)",
    SLOW,
    async () => {
      await given("commit-alex-stop-handle-id.json");
      const before = await snapshot();
      for (const value of [null, true, false, "", "handle_id", "HandleId", "number", ["handleId"], {}]) {
        const what = JSON.stringify(value);
        const request = requestOf("commit-alex-stop-handle-id.json") as unknown as Record<string, unknown>;
        request.answerPhoneRowsBy = value;
        const error = await thrownBy(commitTurn(runtime, request as unknown as CommitTurnRequest));
        expect(error instanceof TypeError, what).toBe(true);
        expect(error instanceof Error ? error.message : "", what).toBe(
          'commitTurn: answerPhoneRowsBy is neither left out nor "handleId"',
        );
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint("turn-alex-stop-1"), what).toEqual(NO_FOOTPRINT);
      }
    },
  );
});

// ---- T-1442: a state row naming a clock or outbox row of its own commit (K-36 v1; commit-turn.ts default 17) --------
//
// K-36 v1's three foreign keys from a state row to a clock row or an outbox row are not deferrable (0017:
// hand_offs_alert_outbox_fk, hand_offs_clock_fk, team_pages_clock_fk), so each is checked at the state row's own write.
// A hand-off names its alert to the owner (written in the same commit: K-36 README rule 5) and its escalation clock row;
// a repeating page names its next page's clock row; T-319's paging makes each in the commit that writes the row naming
// it. The commit writes those clock and outbox rows first (T-1442; DL-930, DL-936).
//
// Two danger records, each one turn's commit, written as T-319's paging writes them (actions/src/domain/paging):
//   - Alex's emergency at Lee's Barbershop (commit-alex-safety.json's turn and safety record, K-02 v1's
//     safety-emergency-now read), handed to Sam with an alert, escalating through a clock row 5 minutes on;
//   - Alex's crisis words (K-34 v1's seed-outcome-crisis.json: the turn and the read of evt-alex-0203), handed to Sam at
//     once with an alert, and paged to Rosie's team at once, every 5 minutes from its next page's clock row.
// The owner lines are the master's and K-36's (A3-25 for crisis words; seed-page-acknowledged.json's for an emergency);
// the team's summary is an example, as the seeds' are. No seed names a member of Rosie's team (Q-18's members are real
// people), so the one member paged is a stand-in persons row with no name, on a stand-in handle in the fixtures'
// made-up range, as T-581's notifications test makes it.

const SAFETY_SEEDS = new URL("db-schema/safety-incidents/fixtures/", CONTRACTS);
const NOTIFICATION_SEEDS = new URL("db-schema/notifications/fixtures/", CONTRACTS);
const BARBERSHOP = "biz-lees-barbershop";
const NEW_YORK = "America/New_York";

type ClockNew = CommitTurnRequest["writes"]["clockRows"]["make"][number];
type OutboxRowNew = CommitTurnRequest["writes"]["outboxRows"][number];

/** The values of a part's seed row (K-34, K-36): the seed's first row of `table`. */
function seedRowOf(dir: URL, file: string, table: string): Record<string, Json> {
  const row = (readJson(new URL(file, dir)) as SeedFile).rows.find((candidate) => candidate.table === table);
  if (row === undefined) {
    throw new Error(`${file} has no ${table} row`);
  }
  return row.values;
}

/** A seed's value that is text. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") {
    throw new Error("a seed value that should be text is not");
  }
  return value;
}

/** The instant `minutes` after `at`, as the contracts write a time (whole seconds, ending in Z). */
const minutesAfter = (at: string, minutes: number): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString().replace(".000Z", "Z");

/** A clock row the minute sweep owns (kind job, no handle), armed at the commit, due at `dueAt` in New York (T-319). */
function jobClock(id: string, dueAt: string, fires: Record<string, Json>): ClockNew {
  return {
    id,
    kind: "job",
    openQuestionId: null,
    reservationId: null,
    handleId: null,
    businessId: BARBERSHOP,
    bookingId: null,
    fires,
    due: { dueAt, dueZone: NEW_YORK },
  };
}

/** One safety row of a danger record, to one person, under Lee's Barbershop, naming no booking (T-319's default 9). */
function safetyRow(id: string, handleId: string, personId: string): OutboxRowNew {
  return {
    id,
    recipientHandleId: handleId,
    recipientPersonId: personId,
    businessId: BARBERSHOP,
    bookingId: null,
    channel: "imessage",
    sendClass: "safety",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
  };
}

/** The values of the request's state insert into `table`, to change for a refused case. */
function insertInto(request: CommitTurnRequest, table: string): Record<string, unknown> {
  const write = request.writes.state.find((each) => each.table === table && each.op === "insert");
  if (write?.op !== "insert") {
    throw new Error(`the request inserts no ${table} row`);
  }
  return write.values;
}

/** commit-alex-safety.json's moment, the hand-off's, and its escalation 5 minutes on (K-36's five-minute CHECK). */
const EMERGENCY_AT = "2026-11-07T15:59:58Z";
const EMERGENCY_ESCALATES = minutesAfter(EMERGENCY_AT, 5);
const EMERGENCY_HAND_OFF = "handoff-alex-0050";
const EMERGENCY_ALERT = "out-sam-handoff-alex-0050";
const EMERGENCY_CLOCK = "clock-handoff-alex-0050";
/** K-36 v1's owner line for an emergency (seed-page-acknowledged.json; A3-48). */
const EMERGENCY_LINE = textOf(
  seedRowOf(NOTIFICATION_SEEDS, "seed-page-acknowledged.json", "hand_offs").summary,
);

/**
 * commit-alex-safety.json's turn with its safety record (safetyCommit), handed to Sam as an emergency (T-319
 * openHandOff): the hand-off names its alert to Sam and its escalation clock row due 5 minutes on, both of this commit.
 */
function emergencyHandOff(sealedWords: string): CommitTurnRequest {
  const request = safetyCommit(sealedWords);
  request.writes.state.push({
    op: "insert",
    table: "hand_offs",
    values: {
      id: EMERGENCY_HAND_OFF,
      business_id: BARBERSHOP,
      kind: "emergency",
      safety_outcome_id: OUTCOME_ID,
      turn_id: request.turn.id,
      booking_id: null,
      about_person_id: "person-alex",
      told_person_id: "person-sam",
      told_as: "owner",
      alert_outbox_row_id: EMERGENCY_ALERT,
      summary: EMERGENCY_LINE,
      handed_at: EMERGENCY_AT,
      escalate_at: EMERGENCY_ESCALATES,
      escalation_clock_row_id: EMERGENCY_CLOCK,
    },
  });
  request.writes.clockRows.make.push(
    jobClock(EMERGENCY_CLOCK, EMERGENCY_ESCALATES, {
      job: "hand-off-escalation",
      handOff: EMERGENCY_HAND_OFF,
    }),
  );
  request.writes.outboxRows.push(safetyRow(EMERGENCY_ALERT, "handle-sam", "person-sam"));
  return request;
}

/** K-34 v1's crisis-words read of Alex's text evt-alex-0203 (seed-outcome-crisis.json), and the turn that read it. */
const CRISIS_OUTCOME = seedRowOf(SAFETY_SEEDS, "seed-outcome-crisis.json", "safety_outcomes");
const CRISIS_TURN = seedRowOf(SAFETY_SEEDS, "seed-outcome-crisis.json", "turns");
const CRISIS_AT = textOf(CRISIS_TURN.committed_at);
const CRISIS_HAND_OFF = "handoff-alex-0203";
const CRISIS_LINE = "out-alex-crisis-0203";
const CRISIS_ALERT = "out-sam-handoff-alex-0203";
const CRISIS_PAGE = "page-alex-0203";
const CRISIS_PAGE_ROW = "out-team-page-alex-0203-1";
const CRISIS_PAGE_CLOCK = "clock-page-alex-0203-2";
const CRISIS_NEXT_CLOCK = "clock-page-alex-0203-3";
/** The master's owner line for crisis words, word for word, never the words (A3-25; K-36 hand_offs.summary). */
const CRISIS_OWNER_LINE = "Urgent: a customer may need help";
/** The page's summary for Rosie's team: ids, the kind and plain words (K-36 team_pages.summary), an example. */
const CRISIS_PAGE_SUMMARY =
  "Hand-off handoff-alex-0203 (biz-lees-barbershop): crisis words, read from safety-alex-0203; paged at once.";
/** Rosie's team's one member here: a stand-in with no name and no role (T-581's notifications test). */
const TEAM_MEMBER = "person-team-stand-in";
const TEAM_HANDLE = "handle-team-stand-in";

/** The stand-in member's rows, written as the tables' owner, as a seed would be. */
async function teamStandIn(): Promise<void> {
  await insertRow(db.sql, "persons", { id: TEAM_MEMBER });
  await insertRow(db.sql, "handles", { id: TEAM_HANDLE, kind: "phone", address: "+15555550190" });
  await insertRow(db.sql, "person_handles", { person_id: TEAM_MEMBER, handle_id: TEAM_HANDLE });
}

/**
 * The turn that read Alex's crisis words (K-34's seed: turn-alex-0203), committing its read, its hand-off to Sam at once
 * with an alert (escalate_at = handed_at and no clock row: hand_offs_crisis_words_at_once), and the page to Rosie's team
 * at once, repeating every 5 minutes from its next page's clock row (T-319 openHandOff and openPage). The page comes
 * after the hand-off it points at (team_pages_hand_off_fk). Its rows: the crisis line to Alex first (the safety message
 * first), the alert to Sam, the page to the team's member.
 */
function crisisHandOff(): CommitTurnRequest {
  const request = requestOf("commit-alex-safety.json");
  request.turn = {
    ...request.turn,
    id: textOf(CRISIS_TURN.id),
    eventIds: [textOf(CRISIS_OUTCOME.event_id)],
    traceId: textOf(CRISIS_TURN.trace_id),
  };
  request.writes.state = [
    { op: "insert", table: "safety_outcomes", values: CRISIS_OUTCOME },
    {
      op: "insert",
      table: "hand_offs",
      values: {
        id: CRISIS_HAND_OFF,
        business_id: BARBERSHOP,
        kind: "crisis_words",
        safety_outcome_id: textOf(CRISIS_OUTCOME.id),
        turn_id: request.turn.id,
        booking_id: CRISIS_OUTCOME.booking_id ?? null,
        about_person_id: "person-alex",
        told_person_id: "person-sam",
        told_as: "owner",
        alert_outbox_row_id: CRISIS_ALERT,
        summary: CRISIS_OWNER_LINE,
        handed_at: CRISIS_AT,
        escalate_at: CRISIS_AT,
        escalation_clock_row_id: null,
        escalated_at: CRISIS_AT,
      },
    },
    {
      op: "insert",
      table: "team_pages",
      values: {
        id: CRISIS_PAGE,
        reason: "hand_off",
        business_id: BARBERSHOP,
        hand_off_id: CRISIS_HAND_OFF,
        turn_id: request.turn.id,
        named_person_id: null,
        summary: CRISIS_PAGE_SUMMARY,
        opened_at: CRISIS_AT,
        last_paged_at: CRISIS_AT,
        times_paged: 1,
        repeat_minutes: 5,
        next_page_clock_row_id: CRISIS_PAGE_CLOCK,
        state: "open",
      },
    },
  ];
  request.writes.clockRows.make = [
    jobClock(CRISIS_PAGE_CLOCK, minutesAfter(CRISIS_AT, 5), { job: "team-page", page: CRISIS_PAGE }),
  ];
  request.writes.outboxRows = [
    safetyRow(CRISIS_LINE, "handle-alex", "person-alex"),
    safetyRow(CRISIS_ALERT, "handle-sam", "person-sam"),
    safetyRow(CRISIS_PAGE_ROW, TEAM_HANDLE, TEAM_MEMBER),
  ];
  return request;
}

/**
 * The write each repeat makes (K-36: each page arms a new clock row and next_page_clock_row_id moves to it), as a state
 * update in a later commit: the page paged a second time, its next page's clock row `nextClock`, made by this commit when
 * `made`. A repeat itself rides its clock row's firing (clocks.ts fireClock, not this card's), so the turn here is a
 * stand-in that carries the same writes.
 */
function pagedAgain(nextClock: string | null, made: boolean): CommitTurnRequest {
  const request = requestOf("commit-alex-safety.json");
  request.turn = {
    ...request.turn,
    id: "turn-t1442-paged-again",
    eventIds: ["evt-t1442-paged-again"],
    traceId: "trace-t1442-paged-again",
  };
  request.writes.state = [
    {
      op: "update",
      table: "team_pages",
      key: { id: CRISIS_PAGE },
      expectVersion: 1,
      set: { times_paged: 2, last_paged_at: minutesAfter(CRISIS_AT, 5), next_page_clock_row_id: nextClock },
    },
  ];
  request.writes.clockRows.make = made
    ? [jobClock(CRISIS_NEXT_CLOCK, minutesAfter(CRISIS_AT, 10), { job: "team-page", page: CRISIS_PAGE })]
    : [];
  request.writes.outboxRows = [];
  return request;
}

/** How many rows K-34's safety_outcomes and K-36's hand_offs and team_pages hold. */
async function dangerRows(): Promise<{ safety_outcomes: number; hand_offs: number; team_pages: number }> {
  const [row] = await db.sql<{ safety_outcomes: number; hand_offs: number; team_pages: number }[]>`
    select (select count(*)::int from safety_outcomes) as safety_outcomes,
           (select count(*)::int from hand_offs) as hand_offs,
           (select count(*)::int from team_pages) as team_pages
  `;
  if (row === undefined) {
    throw new Error("dangerRows: no row");
  }
  return row;
}

/**
 * Commits `request` through a rosie_job client that records each statement it sends, and gives the answer with each
 * insert and update in the order sent: its table and the business scope in force ('' for the runtime side).
 */
async function writesInOrder(
  request: CommitTurnRequest,
  now: Date,
): Promise<{ outcome: CommitTurnOutcome; writes: [string, string][] }> {
  const statements: { text: string; parameters: unknown[] }[] = [];
  const watched = postgres(resolvePrimaryUrl(), {
    max: 1,
    onnotice: () => undefined,
    debug: (_connection: number, text: string, parameters: unknown[]) => {
      statements.push({ text, parameters });
    },
    connection: {
      application_name: "rosie-t1442-order",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  let outcome: CommitTurnOutcome;
  try {
    outcome = await commitTurn(watched, request, { now });
  } finally {
    await watched.end({ timeout: 5 });
  }
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
  return { outcome, writes };
}

describe("a state row naming a clock or outbox row of its own commit is written after it (K-36 v1; T-1442)", () => {
  it("K-36's three foreign keys to clock and outbox rows are checked at the write, never deferred (0017)", async () => {
    const keys = await db.sql<{ name: string; deferrable: boolean; deferred: boolean }[]>`
      select conname as name, condeferrable as deferrable, condeferred as deferred from pg_constraint
      where connamespace = ${db.schema}::regnamespace
        and conname in ('hand_offs_alert_outbox_fk', 'hand_offs_clock_fk', 'team_pages_clock_fk')
      order by conname
    `;
    expect(keys).toEqual([
      { name: "hand_offs_alert_outbox_fk", deferrable: false, deferred: false },
      { name: "hand_offs_clock_fk", deferrable: false, deferred: false },
      { name: "team_pages_clock_fk", deferrable: false, deferred: false },
    ]);
  });

  it(
    "a turn writing a hand-off with its alert and its escalation clock commits: the clock and outbox rows go first",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-safety.json");
      const now = new Date(exchange.given.now);
      const request = emergencyHandOff(byteaText(await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS)));
      expect(schemaErrors("commitTurn.request", request)).toEqual([]);
      const { outcome, writes } = await writesInOrder(request, now);
      expect(outcome).toEqual({
        result: "committed",
        turnId: "turn-alex-safety-1",
        committedAt: EMERGENCY_AT,
        repeated: false,
        committed: {
          // safety_outcomes carries no version, so no row of it is answered; the hand-off is answered where it is written.
          written: [
            { table: "clock_rows", rowId: EMERGENCY_CLOCK, version: 1 },
            { table: "hand_offs", rowId: EMERGENCY_HAND_OFF, version: 1 },
          ],
          outboxRows: [
            { id: "out-alex-safety-emergency", commitSeq: 1 },
            { id: EMERGENCY_ALERT, commitSeq: 2 },
          ],
          promoted: [],
        },
      });
      expect(answerErrors(outcome)).toEqual([]);
      // The clock row and the alert before the hand-off naming them, each under its business (the scope per write).
      expect(writes).toEqual([
        ["turns", ""],
        ["safety_outcomes", BARBERSHOP],
        ["clock_rows", BARBERSHOP],
        ["outbox_rows", BARBERSHOP],
        ["outbox_rows", BARBERSHOP],
        ["hand_offs", BARBERSHOP],
      ]);
      const [handOff] = await db.sql<
        { alert_outbox_row_id: string; escalation_clock_row_id: string; escalate_at: Date; version: number }[]
      >`
        select alert_outbox_row_id, escalation_clock_row_id, escalate_at, version from hand_offs
        where id = ${EMERGENCY_HAND_OFF}
      `;
      expect(handOff).toEqual({
        alert_outbox_row_id: EMERGENCY_ALERT,
        escalation_clock_row_id: EMERGENCY_CLOCK,
        escalate_at: new Date(EMERGENCY_ESCALATES),
        version: 1,
      });
      const [clock] = await db.sql<{ state: string; due_at: Date; created_by_turn_id: string }[]>`
        select state, due_at, created_by_turn_id from clock_rows where id = ${EMERGENCY_CLOCK}
      `;
      expect(clock).toEqual({
        state: "armed",
        due_at: new Date(EMERGENCY_ESCALATES),
        created_by_turn_id: "turn-alex-safety-1",
      });
      const [alert] = await db.sql<{ recipient_handle_id: string; send_class: string; state: string }[]>`
        select recipient_handle_id, send_class, state from outbox_rows where id = ${EMERGENCY_ALERT}
      `;
      expect(alert).toEqual({ recipient_handle_id: "handle-sam", send_class: "safety", state: "planned" });
    },
  );

  it(
    "a turn writing a crisis-words hand-off and its repeating page commits: the page's clock row and the rows first, the page after its hand-off",
    SLOW,
    async () => {
      await given("commit-opens-question.json");
      await teamStandIn();
      const request = crisisHandOff();
      expect(schemaErrors("commitTurn.request", request)).toEqual([]);
      const { outcome, writes } = await writesInOrder(request, new Date(CRISIS_AT));
      expect(outcome).toEqual({
        result: "committed",
        turnId: "turn-alex-0203",
        committedAt: CRISIS_AT,
        repeated: false,
        committed: {
          written: [
            { table: "clock_rows", rowId: CRISIS_PAGE_CLOCK, version: 1 },
            { table: "hand_offs", rowId: CRISIS_HAND_OFF, version: 1 },
            { table: "team_pages", rowId: CRISIS_PAGE, version: 1 },
          ],
          outboxRows: [
            { id: CRISIS_LINE, commitSeq: 1 },
            { id: CRISIS_ALERT, commitSeq: 2 },
            { id: CRISIS_PAGE_ROW, commitSeq: 3 },
          ],
          promoted: [],
        },
      });
      expect(answerErrors(outcome)).toEqual([]);
      // team_pages is Rosie's team's (scope none), so the page goes on the runtime side.
      expect(writes).toEqual([
        ["turns", ""],
        ["safety_outcomes", BARBERSHOP],
        ["clock_rows", BARBERSHOP],
        ["outbox_rows", BARBERSHOP],
        ["outbox_rows", BARBERSHOP],
        ["outbox_rows", BARBERSHOP],
        ["hand_offs", BARBERSHOP],
        ["team_pages", ""],
      ]);
      const [page] = await db.sql<
        { hand_off_id: string; next_page_clock_row_id: string; state: string; times_paged: number }[]
      >`
        select hand_off_id, next_page_clock_row_id, state, times_paged from team_pages where id = ${CRISIS_PAGE}
      `;
      expect(page).toEqual({
        hand_off_id: CRISIS_HAND_OFF,
        next_page_clock_row_id: CRISIS_PAGE_CLOCK,
        state: "open",
        times_paged: 1,
      });
      const [handOff] = await db.sql<
        { alert_outbox_row_id: string; escalation_clock_row_id: string | null; summary: string }[]
      >`
        select alert_outbox_row_id, escalation_clock_row_id, summary from hand_offs where id = ${CRISIS_HAND_OFF}
      `;
      expect(handOff).toEqual({
        alert_outbox_row_id: CRISIS_ALERT,
        escalation_clock_row_id: null,
        summary: CRISIS_OWNER_LINE,
      });
      expect(await dangerRows()).toEqual({ safety_outcomes: 1, hand_offs: 1, team_pages: 1 });
    },
  );

  it(
    "a state update moving a page to a next clock row its own commit makes waits for it too; left out, K-36 refuses it",
    SLOW,
    async () => {
      await given("commit-opens-question.json");
      await teamStandIn();
      committed(await commitTurn(runtime, crisisHandOff(), { now: new Date(CRISIS_AT) }));
      const now = new Date(minutesAfter(CRISIS_AT, 5));
      const pageNow = async (): Promise<{
        next_page_clock_row_id: string;
        times_paged: number;
        version: number;
      }> => {
        const [page] = await db.sql<
          { next_page_clock_row_id: string; times_paged: number; version: number }[]
        >`
          select next_page_clock_row_id, times_paged, version from team_pages where id = ${CRISIS_PAGE}
        `;
        if (page === undefined) {
          throw new Error("the page was not written");
        }
        return page;
      };
      const before = await snapshot();
      for (const [what, request, refusal] of [
        [
          "the next clock row left out, the page naming none",
          pagedAgain(null, false),
          "team_pages_open_repeat_has_clock",
        ],
        [
          "the next clock row left out, the page still naming it",
          pagedAgain(CRISIS_NEXT_CLOCK, false),
          "team_pages_clock_fk",
        ],
      ] as const) {
        const outcome = await commitTurn(runtime, request, { now });
        expect(outcome, what).toEqual({
          error: "constraint",
          sqlstate: refusal === "team_pages_clock_fk" ? "23503" : "23514",
          constraint: refusal,
        });
        expect(answerErrors(outcome), what).toEqual([]);
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint(request.turn.id), what).toEqual(NO_FOOTPRINT);
        expect(await pageNow(), what).toEqual({
          next_page_clock_row_id: CRISIS_PAGE_CLOCK,
          times_paged: 1,
          version: 1,
        });
      }
      const outcome = committed(await commitTurn(runtime, pagedAgain(CRISIS_NEXT_CLOCK, true), { now }));
      expect(outcome.committed.written).toEqual([
        { table: "clock_rows", rowId: CRISIS_NEXT_CLOCK, version: 1 },
        { table: "team_pages", rowId: CRISIS_PAGE, version: 2 },
      ]);
      expect(answerErrors(outcome)).toEqual([]);
      expect(await pageNow()).toEqual({
        next_page_clock_row_id: CRISIS_NEXT_CLOCK,
        times_paged: 2,
        version: 2,
      });
    },
  );

  it(
    "the same hand-off with its named clock row or alert left out is refused as K-36 says, and nothing is written",
    SLOW,
    async () => {
      const exchange = await given("commit-alex-safety.json");
      const now = new Date(exchange.given.now);
      const sealedWords = byteaText(await seal(db.sql, KEYS, "person-alex", EMERGENCY_WORDS));
      const cases: [string, (request: CommitTurnRequest) => void, string, string][] = [
        [
          "the clock row left out, the hand-off naming none",
          (request) => {
            request.writes.clockRows.make = [];
            insertInto(request, "hand_offs").escalation_clock_row_id = null;
          },
          "23514",
          "hand_offs_clock_unless_at_once",
        ],
        [
          "the clock row left out, the hand-off still naming it",
          (request) => {
            request.writes.clockRows.make = [];
          },
          "23503",
          "hand_offs_clock_fk",
        ],
        [
          "the alert left out, the hand-off still naming it",
          (request) => {
            request.writes.outboxRows = request.writes.outboxRows.filter((row) => row.id !== EMERGENCY_ALERT);
          },
          "23503",
          "hand_offs_alert_outbox_fk",
        ],
      ];
      const before = await snapshot();
      for (const [what, leaveOut, sqlstate, constraint] of cases) {
        const request = emergencyHandOff(sealedWords);
        leaveOut(request);
        const outcome = await commitTurn(runtime, request, { now });
        expect(outcome, what).toEqual({ error: "constraint", sqlstate, constraint });
        expect(answerErrors(outcome), what).toEqual([]);
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint(request.turn.id), what).toEqual(NO_FOOTPRINT);
        expect(await dangerRows(), what).toEqual({ safety_outcomes: 0, hand_offs: 0, team_pages: 0 });
      }
      // Refused for what was left out alone: the whole hand-off commits.
      committed(await commitTurn(runtime, emergencyHandOff(sealedWords), { now }));
      expect(await dangerRows()).toEqual({ safety_outcomes: 1, hand_offs: 1, team_pages: 0 });
    },
  );

  it(
    "the same page with its next clock row left out is refused as K-36 says, and nothing is written",
    SLOW,
    async () => {
      await given("commit-opens-question.json");
      await teamStandIn();
      const now = new Date(CRISIS_AT);
      const cases: [string, (request: CommitTurnRequest) => void, string, string][] = [
        [
          "the next clock row left out, the page naming none",
          (request) => {
            request.writes.clockRows.make = [];
            insertInto(request, "team_pages").next_page_clock_row_id = null;
          },
          "23514",
          "team_pages_open_repeat_has_clock",
        ],
        [
          "the next clock row left out, the page still naming it",
          (request) => {
            request.writes.clockRows.make = [];
          },
          "23503",
          "team_pages_clock_fk",
        ],
      ];
      const before = await snapshot();
      for (const [what, leaveOut, sqlstate, constraint] of cases) {
        const request = crisisHandOff();
        leaveOut(request);
        const outcome = await commitTurn(runtime, request, { now });
        expect(outcome, what).toEqual({ error: "constraint", sqlstate, constraint });
        expect(answerErrors(outcome), what).toEqual([]);
        expect(await snapshot(), what).toEqual(before);
        expect(await footprint(request.turn.id), what).toEqual(NO_FOOTPRINT);
        expect(await dangerRows(), what).toEqual({ safety_outcomes: 0, hand_offs: 0, team_pages: 0 });
      }
      committed(await commitTurn(runtime, crisisHandOff(), { now }));
      expect(await dangerRows()).toEqual({ safety_outcomes: 1, hand_offs: 1, team_pages: 1 });
    },
  );
});
