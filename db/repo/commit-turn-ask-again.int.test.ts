// T-1509: K-05 v1.21's raise (README item 81 and defaults 192 to 199; DL-1030, DL-1045): commitTurn asks one live open
// question again, its ask count and its version each raised by one, with the turn's other writes, all or nothing, against
// local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/commit-turn`). The schema comes from migrating
// a fresh test schema (db/repo/test-db.ts); the public schema is never touched.
//
// The v1.21 fixtures are listed under commitTurn.askAgainExchange, and this file selects them by that definition, never
// through commit-turn.int.test.ts's COMMIT_ENTRIES (commitTurn.exchange), whose list that file pins. Every call runs as
// K-05 states it (README "Scope": per write; T-191's roles), through a client whose connections run as rosie_job with no
// business scope at the start of each transaction; the tables' owner (the migrations' role) loads K-04's seeds.
//
// A fixture's `given.after` names the exchanges that run first, each with its own `given`, and each runs for real:
// commitTurn (T-195, with this task's raise) and clocks.ts's armClock, dueClocks and fireClock (T-197), the steps
// commit-a7-03-alex-asks-again-defaulted's chain (arm-clock, due-for-handle, fire-once) needs. Every answer, the chain's
// and the call's, is checked against data-access v1.21 with Ajv 2020-12, strict, as contracts:check runs it.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import {
  armClock,
  type ArmClockRequest,
  dueClocks,
  type DueClocksRequest,
  fireClock,
  type FireClockRequest,
} from "./clocks";
import {
  commitTurn,
  type CommitTurnAskAgainOutcome,
  type CommitTurnAskAgainRequest,
  type CommitTurnRequest,
} from "./commit-turn";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const RUNTIME_APP = "rosie-t1509-ask-again";
const SLOW = { timeout: 60_000 };
const ASK_AGAIN = "commit-s1-02-sam-asks-again.json";
const STALE = "commit-s1-02-sam-asks-again-stale.json";
const DEFAULTED = "commit-a7-03-alex-asks-again-defaulted.json";
const S1_02 = "oq-s1-02-sam-1";
const A7_03 = "oq-a7-03-alex";

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
/** A fresh copy of a v1.21 fixture's request, which asks a question again. */
const raisingOf = (file: string): CommitTurnAskAgainRequest =>
  structuredClone(exchangeOf(file).request) as unknown as CommitTurnAskAgainRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
/** The v1.21 commits, by their definition (README "Consumers of v1.21": never COMMIT_ENTRIES). */
const ASK_AGAIN_ENTRIES = INDEX.filter((entry) => entry.def === "commitTurn.askAgainExchange");
const ACCEPTED = ASK_AGAIN_ENTRIES.filter((entry) => entry.expect === "accept");
const REFUSED = ASK_AGAIN_ENTRIES.filter((entry) => entry.expect === "refuse");

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** What the call throws for each refused fixture's request: its one fault, named by its field alone. */
const REFUSED_MESSAGES: Readonly<Record<string, string>> = {
  "invalid/refuse-commit-s1-02-asks-again-twice.json":
    "commitTurn: writes.openQuestions.askAgain does not hold exactly one raise (K-05 v1.21 default 194)",
  "invalid/refuse-commit-s1-02-asks-again-and-closes.json":
    "commitTurn: writes.openQuestions.close is not empty beside askAgain (K-05 v1.21 default 194)",
};

// ---- the contract's own schema at v1.21 (Ajv 2020-12, strict, as contracts:check runs it) ----------------------------

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
const V121_ID = (readJson(new URL("data-access/data-access.v1.21.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.21, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V121_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.21 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** A call's answer checked against its own v1.21 definition: an error against <call>.errors, else <call>.response. */
function answerErrors(call: string, outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(`${call}.${isError ? "errors" : "response"}`, outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

/** A rosie_job client of this file's schema; with `statements`, it records the text of every statement it sends. */
function runtimeClient(applicationName: string, max: number, statements?: string[]): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    ...(statements === undefined
      ? {}
      : {
          debug: (_connection: number, text: string) => {
            statements.push(text);
          },
        }),
    connection: {
      application_name: applicationName,
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "commit_ask_again" });
  runtime = runtimeClient(RUNTIME_APP, 10);
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

// ---- the calls, for real, as rosie_job ------------------------------------------------------------------------------

/** commitTurn on a fixture's request: v1.21's overload when it asks a question again, else v1.20's. */
async function commitOf(request: Record<string, Json>, now: Date): Promise<CommitTurnAskAgainOutcome> {
  const writes = request.writes as { openQuestions: Record<string, Json> };
  return writes.openQuestions.askAgain === undefined
    ? commitTurn(runtime, request as unknown as CommitTurnRequest, { now })
    : commitTurn(runtime, request as unknown as CommitTurnAskAgainRequest, { now });
}

/** A chain's call: commitTurn, or clocks.ts's armClock, dueClocks or fireClock, each the real call. */
async function callOf(exchange: Exchange): Promise<unknown> {
  switch (exchange.call) {
    case "commitTurn":
      return commitOf(exchange.request, new Date(exchange.given.now));
    case "armClock":
      return armClock(runtime, exchange.request as unknown as ArmClockRequest);
    case "dueClocks":
      return dueClocks(runtime, exchange.request as unknown as DueClocksRequest);
    case "fireClock":
      return fireClock(runtime, exchange.request as unknown as FireClockRequest);
    default:
      throw new Error(`this test runs no ${exchange.call} step`);
  }
}

/** Loads a fixture's seeds and runs its chain, each step answering its exchange's outcome, valid at v1.21. */
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
    const answer = await callOf(before);
    expect(answer, step).toEqual(before.outcome);
    expect(answerErrors(before.call, answer), step).toEqual([]);
  }
  return exchange;
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

// ---- what a commit leaves behind -------------------------------------------------------------------------------------

const VERSIONED = [
  "businesses",
  "persons",
  "phones",
  "person_roles",
  "bookings",
  "turns",
  "open_questions",
  "clock_rows",
  "outbox_rows",
];
const WRITTEN_ONCE = ["handles", "person_handles", "event_log"];

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
  questions: number;
  clocks: number;
}

const NO_FOOTPRINT: Footprint = { turns: 0, outbox: 0, events: 0, questions: 0, clocks: 0 };

/** The rows that carry a turn's id. */
async function footprint(turnId: string): Promise<Footprint> {
  const [row] = await db.sql<Footprint[]>`
    select (select count(*)::int from turns where id = ${turnId}) as turns,
           (select count(*)::int from outbox_rows where turn_id = ${turnId}) as outbox,
           (select count(*)::int from event_log where turn_id = ${turnId}) as events,
           (select count(*)::int from open_questions where turn_id = ${turnId}) as questions,
           (select count(*)::int from clock_rows where created_by_turn_id = ${turnId}) as clocks
  `;
  if (row === undefined) {
    throw new Error("footprint: no row");
  }
  return row;
}

/** An open question's row, every column. */
async function questionRow(id: string): Promise<Row> {
  const [row] = await db.sql<Row[]>`select * from open_questions where id = ${id}`;
  if (row === undefined) {
    throw new Error("no such open question");
  }
  return row;
}

/** The clock rows of an open question, every column, in id order. */
async function questionClocks(id: string): Promise<Row[]> {
  return db.sql<Row[]>`select * from clock_rows where open_question_id = ${id} order by id`;
}

/** The question a v1.21 request asks again. */
function raiseOf(request: CommitTurnAskAgainRequest): { id: string; expectVersion: number } {
  const [raise] = request.writes.openQuestions.askAgain;
  return raise;
}

/** This file's rosie_job calls that wait on a lock now. */
async function lockWaiters(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where application_name = ${RUNTIME_APP} and wait_event_type = 'Lock'
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

describe("commitTurn: each v1.21 fixture, selected by commitTurn.askAgainExchange (K-05 v1.21 item 81)", () => {
  it("the index lists five v1.21 commits under commitTurn.askAgainExchange, three accepted and two refused at v1.21 (Ajv strict), none under commitTurn.exchange", () => {
    expect(ASK_AGAIN_ENTRIES.map((entry) => entry.file).sort()).toEqual([
      DEFAULTED,
      STALE,
      ASK_AGAIN,
      "invalid/refuse-commit-s1-02-asks-again-and-closes.json",
      "invalid/refuse-commit-s1-02-asks-again-twice.json",
    ]);
    expect(ACCEPTED.map((entry) => entry.file).sort()).toEqual([DEFAULTED, STALE, ASK_AGAIN]);
    for (const entry of ASK_AGAIN_ENTRIES) {
      expect(entry.version, entry.file).toBe("v1.21");
    }
    for (const { file } of ACCEPTED) {
      const exchange = exchangeOf(file);
      expect(schemaErrors("commitTurn.askAgainExchange", exchange), file).toEqual([]);
      expect(answerErrors("commitTurn", exchange.outcome), file).toEqual([]);
    }
    for (const { file } of REFUSED) {
      expect(schemaErrors("commitTurn.askAgainExchange", exchangeOf(file)), file).not.toEqual([]);
    }
    const files = new Set(ASK_AGAIN_ENTRIES.map((entry) => entry.file));
    expect(INDEX.filter((entry) => entry.def === "commitTurn.exchange" && files.has(entry.file))).toEqual([]);
  });

  for (const { file } of ACCEPTED) {
    it(
      `${file}: as rosie_job, the call answers the fixture's outcome, valid at v1.21, and writes all or nothing`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const request = raisingOf(file);
        const { id } = raiseOf(request);
        const before = await snapshot();
        const questionBefore = await questionRow(id);
        const clocksBefore = await questionClocks(id);
        const outcome = await commitTurn(runtime, request, { now: new Date(exchange.given.now) });
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors("commitTurn", outcome)).toEqual([]);
        expect(schemaErrors("commitTurn.askAgainExchange", { ...exchange, outcome })).toEqual([]);
        // The clock row, never made, cancelled, armed or moved by the commit (default 195).
        expect(await questionClocks(id)).toEqual(clocksBefore);

        if ("error" in outcome) {
          // Refused: nothing at all was written, neither the row, nor its entries, nor a raised ask count.
          expect(await snapshot()).toEqual(before);
          expect(await footprint(request.turn.id)).toEqual(NO_FOOTPRINT);
          expect(await questionRow(id)).toEqual(questionBefore);
          return;
        }
        // The question at ask count and version one higher, every other column as it was (defaults 192 and 195).
        expect(await questionRow(id)).toEqual({
          ...questionBefore,
          ask_count: Number(questionBefore.ask_count) + 1,
          version: Number(questionBefore.version) + 1,
        });
        expect(await footprint(request.turn.id)).toEqual({
          turns: 1,
          outbox: request.writes.outboxRows.length,
          events: request.writes.events.length,
          questions: 0,
          clocks: 0,
        });
      },
    );
  }

  it(
    `${ASK_AGAIN}: S1-02's question at ask count 2 and version 2, its status, options, read-back, Clock line, bundle and turn and its clock row as commit-s1-01-sam wrote them, its asked_again entry under the turn (defaults 195, 196)`,
    SLOW,
    async () => {
      const exchange = await given(ASK_AGAIN);
      const asked = await questionRow(S1_02);
      expect(asked).toMatchObject({
        status: "waiting",
        ask_count: 1,
        version: 1,
        turn_id: "turn-s1-01-sam",
        step: "S1-02",
        options: [],
        readback: null,
        clock: null,
        closed_at: null,
      });
      const [clock] = await questionClocks(S1_02);
      expect(clock).toMatchObject({ id: "clock-oq-s1-02-sam-1", state: "waiting", version: 1 });

      const outcome = await commitTurn(runtime, raisingOf(ASK_AGAIN), { now: new Date(exchange.given.now) });
      expect(outcome).toEqual(exchange.outcome);
      expect(await questionRow(S1_02)).toEqual({ ...asked, ask_count: 2, version: 2 });
      expect(await questionClocks(S1_02)).toEqual([clock]);

      const [entry] = await db.sql<Row[]>`
        select turn_id, trace_id, bundle_hash, bundle_build, business_id, actor_kind, kind, table_name, row_id,
               old_values, new_values, why
        from event_log where id = 'log-oq-s1-02-sam-1-asked_again'
      `;
      expect(entry).toEqual({
        turn_id: "turn-s1-02-sam-asked",
        trace_id: "trace-sam-0002",
        bundle_hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037",
        bundle_build: 1,
        business_id: "biz-lees-barbershop",
        actor_kind: "rosie",
        kind: "open_question.asked_again",
        table_name: "open_questions",
        row_id: S1_02,
        old_values: { ask_count: 1 },
        new_values: { ask_count: 2 },
        why: { step: "S1-02" },
      });
      const rows = await db.sql<Row[]>`
        select id, state, open_question_id, plan, final_parts from outbox_rows where turn_id = 'turn-s1-02-sam-asked'
      `;
      expect(rows).toEqual([
        {
          id: "outbox-s1-02-sam-asked-1",
          state: "planned",
          open_question_id: S1_02,
          plan: null,
          final_parts: null,
        },
      ]);
    },
  );

  it(
    `${DEFAULTED}: its chain runs on clocks.ts's real calls, arm-clock, due-for-handle and fire-once, leaving A7-03's question defaulted at version 3, and the raise answers wrongState at v1.21`,
    SLOW,
    async () => {
      const exchange = await given(DEFAULTED);
      expect(await questionRow(A7_03)).toMatchObject({ status: "defaulted", version: 3, ask_count: 1 });
      expect(await questionClocks(A7_03)).toMatchObject([
        { id: "clock-oq-a7-03-alex", state: "fired", version: 3 },
      ]);
      const outcome = await commitTurn(runtime, raisingOf(DEFAULTED), { now: new Date(exchange.given.now) });
      expect(outcome).toEqual({
        error: "wrongState",
        table: "open_questions",
        rowId: A7_03,
        state: "defaulted",
      });
      expect(schemaErrors("openQuestionWrongStateError", outcome)).toEqual([]);
      expect(answerErrors("commitTurn", outcome)).toEqual([]);
    },
  );
});

describe("refused before the database: what the schema refuses throws, naming the field alone (default 194; db/repo default 1)", () => {
  for (const { file } of REFUSED) {
    it(`${file}: its request throws before any statement, and nothing is written`, SLOW, async () => {
      await given(file);
      const before = await snapshot();
      const statements: string[] = [];
      const watched = runtimeClient("rosie-t1509-watched", 1, statements);
      try {
        const error = await thrownBy(commitTurn(watched, raisingOf(file)));
        expect(error).toBeInstanceOf(TypeError);
        expect(error instanceof Error ? error.message : "").toBe(REFUSED_MESSAGES[file]);
      } finally {
        await watched.end({ timeout: 5 });
      }
      expect(statements).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  }

  it(
    "an empty askAgain, one that is not a list, and a raise with a count, another field, no id or no version each throw before any statement",
    SLOW,
    async () => {
      await given(ASK_AGAIN);
      const before = await snapshot();
      const cases: [string, unknown, string][] = [
        [
          "an empty list",
          [],
          "writes.openQuestions.askAgain does not hold exactly one raise (K-05 v1.21 default 194)",
        ],
        ["null", null, "writes.openQuestions.askAgain is not a list"],
        [
          "a raise not in a list",
          { id: S1_02, expectVersion: 1 },
          "writes.openQuestions.askAgain is not a list",
        ],
        [
          "a raise with a count",
          [{ id: S1_02, expectVersion: 1, askCount: 2 }],
          "writes.openQuestions.askAgain[] is not a raise: an id and an expectVersion alone",
        ],
        [
          "an id alone",
          [S1_02],
          "writes.openQuestions.askAgain[] is not a raise: an id and an expectVersion alone",
        ],
        [
          "no version",
          [{ id: S1_02 }],
          "writes.openQuestions.askAgain[].expectVersion is not a version (a positive integer)",
        ],
        [
          "version 0",
          [{ id: S1_02, expectVersion: 0 }],
          "writes.openQuestions.askAgain[].expectVersion is not a version (a positive integer)",
        ],
        [
          "an empty id",
          [{ id: "", expectVersion: 1 }],
          "writes.openQuestions.askAgain[].id is not a non-empty id",
        ],
      ];
      const statements: string[] = [];
      const watched = runtimeClient("rosie-t1509-watched", 1, statements);
      try {
        for (const [what, value, message] of cases) {
          const request = raisingOf(ASK_AGAIN);
          (request.writes.openQuestions as unknown as Record<string, unknown>).askAgain = value;
          const error = await thrownBy(commitTurn(watched, request));
          expect(error, what).toBeInstanceOf(TypeError);
          expect(error instanceof Error ? error.message : "", what).toBe(`commitTurn: ${message}`);
        }
      } finally {
        await watched.end({ timeout: 5 });
      }
      expect(statements).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("the raise among the commit's rows (K-05 v1.21 item 81)", () => {
  it(
    "a repeat of the turn id answers its first commit with written empty, and raises nothing again",
    SLOW,
    async () => {
      const exchange = await given(ASK_AGAIN);
      const now = new Date(exchange.given.now);
      expect(await commitTurn(runtime, raisingOf(ASK_AGAIN), { now })).toEqual(exchange.outcome);
      const before = await snapshot();
      const again = await commitTurn(runtime, raisingOf(ASK_AGAIN), {
        now: new Date("2026-10-19T18:09:00Z"),
      });
      expect(again).toEqual({
        result: "committed",
        turnId: "turn-s1-02-sam-asked",
        committedAt: "2026-10-19T18:07:04Z",
        repeated: true,
        committed: {
          written: [],
          outboxRows: [{ id: "outbox-s1-02-sam-asked-1", commitSeq: 2 }],
          promoted: [],
        },
      });
      expect(answerErrors("commitTurn", again)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await questionRow(S1_02)).toMatchObject({ ask_count: 2, version: 2 });
    },
  );

  it(
    "a raise of a question that does not exist, or of one the same commit opens, throws, and nothing is written (db/repo default 1)",
    SLOW,
    async () => {
      await given(ASK_AGAIN);
      const before = await snapshot();
      const missing = raisingOf(ASK_AGAIN);
      missing.writes.openQuestions.askAgain = [{ id: "oq-s1-02-sam-nobody", expectVersion: 1 }];
      missing.writes.outboxRows = [];
      missing.writes.events = [];
      await expect(commitTurn(runtime, missing)).rejects.toThrow(
        "commitTurn: a row of open_questions the request names does not exist (default 1)",
      );
      expect(await snapshot()).toEqual(before);
      expect(await footprint(missing.turn.id)).toEqual(NO_FOOTPRINT);

      // A question this commit opens, S1-02's as commit-s1-01-sam opened it under a new id, raised in the same commit.
      const opens = raisingOf(ASK_AGAIN);
      const s101 = exchangeOf("commit-s1-01-sam.json").request as unknown as CommitTurnRequest;
      const [opened] = s101.writes.openQuestions.open;
      if (opened === undefined) {
        throw new Error("commit-s1-01-sam opens S1-02's question");
      }
      opens.writes.openQuestions.open = [{ ...opened, id: "oq-s1-02-sam-opened-now" }];
      opens.writes.openQuestions.askAgain = [{ id: "oq-s1-02-sam-opened-now", expectVersion: 1 }];
      opens.writes.outboxRows = [];
      opens.writes.events = [];
      await expect(commitTurn(runtime, opens)).rejects.toThrow(
        "commitTurn: a row of open_questions the request names does not exist (default 1)",
      );
      expect(await snapshot()).toEqual(before);
      expect(await footprint(opens.turn.id)).toEqual(NO_FOOTPRINT);
    },
  );

  it(
    "two commits raising one question at one version in parallel give one commit and one versionChanged, never an ask count of 3 (default 192)",
    SLOW,
    async () => {
      for (let round = 0; round < 5; round += 1) {
        const exchange = await given(ASK_AGAIN);
        const now = new Date(exchange.given.now);
        const requests = [raisingOf(ASK_AGAIN), raisingOf(STALE)] as const;
        // Both commits reach the question's lock together: the owner holds it until both wait on it.
        let letGo: () => void = () => undefined;
        const released = new Promise<void>((done) => {
          letGo = done;
        });
        let taken: () => void = () => undefined;
        const held = new Promise<void>((done) => {
          taken = done;
        });
        const holder = db.sql.begin(async (tx) => {
          await tx`select id from open_questions where id = ${S1_02} for update`;
          taken();
          await released;
        });
        await held;
        const running = Promise.all(requests.map((request) => commitTurn(runtime, request, { now })));
        try {
          await untilLockWaiters(2);
        } finally {
          letGo();
          await holder;
        }
        const outcomes = await running;
        // A transient (a serialization failure or a deadlock) is retried once: it then meets the other's commit.
        const settled = await Promise.all(
          outcomes.map(async (outcome, index) =>
            "error" in outcome && outcome.error === "transient"
              ? commitTurn(runtime, raisingOf(index === 0 ? ASK_AGAIN : STALE), { now })
              : outcome,
          ),
        );
        const commits = settled.filter((outcome) => "result" in outcome);
        const refusals = settled.filter((outcome) => "error" in outcome);
        expect(commits, `round ${String(round)}`).toHaveLength(1);
        expect(refusals, `round ${String(round)}`).toEqual([
          {
            error: "versionChanged",
            changed: [{ table: "open_questions", rowId: S1_02, readVersion: 1, currentVersion: 2 }],
          },
        ]);
        for (const outcome of settled) {
          expect(answerErrors("commitTurn", outcome), `round ${String(round)}`).toEqual([]);
        }
        expect(await questionRow(S1_02), `round ${String(round)}`).toMatchObject({
          ask_count: 2,
          version: 2,
        });
        const [entries] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from event_log where kind = 'open_question.asked_again'
        `;
        expect(entries?.n, `round ${String(round)}`).toBe(1);
      }
    },
  );
});
