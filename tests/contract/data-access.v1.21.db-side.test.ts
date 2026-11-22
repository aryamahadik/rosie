// Contract test for K-05 v1.21, a commit asks one open question again: the database side (T-1522; T-1509's
// db/repo/commit-turn.ts raise and db/repo/clocks.ts checkFire; DL-1030, DL-1045, DL-1101; contracts/data-access/README.md
// section "v1.21", item 81, defaults 192 to 199, "Consumers of v1.21", "What the new tasks must hold to", and "Fixtures",
// v1.21).
//
// The schema side, data-access.v1.21.test.ts with data-access.v1.test.ts, checks every v1.21 fixture against the schema
// of v1.21. This part is the producer's side (C-152) of v1.21: the database engineer's raise (T-1509), K-05 v1's
// commitTurn with writes.openQuestions.askAgain. Every entry of fixtures/index.json whose version is one of
// DB_SIDE_VERSIONS runs here, selected by its version, never by a pinned list or count (DL-124, DL-125), against local
// PostgreSQL with every migration applied to a fresh schema (db/repo/test-db.ts), each call through rosie_job, the
// runtime side's role, as the README gives commitTurn (README "Scope": per write; item 81: "as rosie_job per write"):
//   - each accepted exchange: its given is loaded as the tables' owner (its k04Seeds, each with its own after chain,
//     each file once), then the exchanges its after chain names run first through db/repo's own calls (commitTurn, and
//     clocks.ts's armClock, dueClocks and fireClock, which commit-a7-03-alex-asks-again-defaulted's chain runs: arm-clock,
//     due-for-handle, fire-once), each answering its own fixture's outcome, valid at its own version; then its request
//     goes through commitTurn at given.now. The answer is the fixture's outcome, whole, valid at v1.21 as commitTurn's
//     response or one of its errors, the exchange with it valid at commitTurn.askAgainExchange. The raise is at the version
//     read: the question stands at the raise's expectVersion before the commit unless the answer is versionChanged; a
//     committed raise leaves the question at ask_count and version one higher and every other column as it was (defaults
//     192 and 195); a refused one writes nothing (item 81 step 2), the question included;
//   - each refused exchange, whose one fault is its request (REQUEST_TWINS: the same question raised twice, a raise beside
//     a close): in its own given, its twin's but for its note, db/repo throws before any statement reaches the database
//     (default 194; db/repo's default 1), nothing written; and with its one fault taken out, its twin's request, db/repo
//     answers the twin's outcome;
//   - what no fixture shows (default 199): a firing that carries askAgain throws in db/repo's checkFire before any
//     statement, in fire-once's own given, nothing written, and fire-once's request as it stands answers its outcome.
// So a commit of db/repo that drifts from the frozen v1.21 fails this test. db/repo's own test
// (db/repo/commit-turn-ask-again.int.test.ts, T-1509) holds the rest: the asked_again entry under the turn, every
// malformed raise, a repeated turn id, a question that does not exist or that the same commit opens, and two parallel
// raises at one version.
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  armClock,
  type ArmClockRequest,
  dueClocks,
  type DueClocksRequest,
  fireClock,
  type FireClockRequest,
} from "../../db/repo/clocks";
import {
  commitTurn,
  type CommitTurnAskAgainRequest,
  type CommitTurnRequest,
} from "../../db/repo/commit-turn";
import type { Sql, Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const CORE_SEEDS_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");
const SLOW = { timeout: 60_000 };

/** The versions with a database side here: v1.21 (T-1509). */
const DB_SIDE_VERSIONS = ["v1.21"];
/** The definition README "Fixtures" (v1.21) lists every v1.21 fixture under. */
const FIXTURE_DEF = "commitTurn.askAgainExchange";
/** The role every commit runs as (README "Scope": the runtime side, per write; item 81). */
const JOB_ROLE = "rosie_job";

interface Given {
  k04Seeds: string[];
  partSeeds?: string[];
  after: string[];
  now: string;
  note?: string;
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

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an answer is one of its call's errors. */
const isError = (answer: unknown): boolean => isRecord(answer) && "error" in answer;

const index = readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] };
const entries = index.fixtures;
const entryOf = (file: string): FixtureEntry =>
  must(
    entries.find((candidate) => candidate.file === file),
    `the index entry ${file}`,
  );
/** Every entry of a version with a database side, in the index's order. */
const sideEntries = entries.filter((entry) => DB_SIDE_VERSIONS.includes(entry.version));
const sideAccepted = sideEntries.filter((entry) => entry.expect === "accept");
const sideRefused = sideEntries.filter((entry) => entry.expect === "refuse");

/** A fresh copy of a fixture of this folder. */
const fixture = (file: string): unknown => readJson(path.join(FIXTURES_DIR, ...file.split("/")));
const exchangeOf = (file: string): Exchange => fixture(file) as Exchange;

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12), each definition taken from the schema of the version an entry lists

const SKIPPED = new Set(["node_modules", "generated"]);

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : schemaFiles(full);
    return entry.isFile() && entry.name.endsWith(".schema.json") ? [full] : [];
  });
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS_ROOT)) ajv.addSchema(readJson(file) as object);

const idOf = (version: string): string =>
  (readJson(path.join(DATA_ACCESS_DIR, `data-access.${version}.schema.json`)) as { $id: string }).$id;

/** The validator of one definition of a version's schema. */
function validatorOf(version: string, def: string): ValidateFunction {
  const key = `${idOf(version)}#/$defs/${def}`;
  return must(ajv.getSchema(key), `the schema ${key}`);
}

/** Ajv's errors as one line each; none when `value` is valid. */
function errorsOf(validate: ValidateFunction, value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? ""}`);
}

/** An answer against its call's errors when it is one, else its call's response, at `version`. */
function answerErrors(version: string, call: string, answer: unknown): string[] {
  return errorsOf(validatorOf(version, `${call}.${isError(answer) ? "errors" : "response"}`), answer);
}

// ---------------------------------------------------------------------------------------------------------------
// The calls, through db/repo, as rosie_job

/** commitTurn on a fixture's request: v1.21's overload when it asks a question again, else v1.20's (default 199). */
async function commit(sql: Sql, request: Record<string, Json>, now: string): Promise<unknown> {
  const writes = request.writes as { openQuestions: Record<string, Json> };
  return writes.openQuestions.askAgain === undefined
    ? commitTurn(sql, request as unknown as CommitTurnRequest, { now: new Date(now) })
    : commitTurn(sql, request as unknown as CommitTurnAskAgainRequest, { now: new Date(now) });
}

/**
 * The call an exchange runs through: commitTurn, the call v1.21 changes, and clocks.ts's armClock, dueClocks and
 * fireClock, the steps of commit-a7-03-alex-asks-again-defaulted's chain (README "Fixtures", v1.21: "after v1's
 * fire-once"), each db/repo's own and on the runtime side as rosie_job (v1 items 1, 4 and 5).
 */
async function run(sql: Sql, exchange: Exchange): Promise<unknown> {
  switch (exchange.call) {
    case "commitTurn":
      return commit(sql, exchange.request, exchange.given.now);
    case "armClock":
      return armClock(sql, exchange.request as unknown as ArmClockRequest);
    case "dueClocks":
      return dueClocks(sql, exchange.request as unknown as DueClocksRequest);
    case "fireClock":
      return fireClock(sql, exchange.request as unknown as FireClockRequest);
    default:
      throw new Error(`this test runs no ${exchange.call} exchange`);
  }
}

/**
 * Each refused exchange of v1.21, whose one fault is its request, with its twin: the accepted exchange whose given (but
 * its note) and outcome it shares, and whose request it is with the fault taken out (README "Fixtures", v1.21: "put
 * right, it is commit-s1-02-sam-asks-again"); and `faults`, the places of the refused request that carry its fault.
 */
const REQUEST_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // The same raise listed twice: one raise a commit (default 194)
  "invalid/refuse-commit-s1-02-asks-again-twice.json": {
    twin: "commit-s1-02-sam-asks-again.json",
    faults: ["writes.openQuestions.askAgain.1"],
  },
  // The question it asks again also closed: a commit that raises closes none (default 194)
  "invalid/refuse-commit-s1-02-asks-again-and-closes.json": {
    twin: "commit-s1-02-sam-asks-again.json",
    faults: ["writes.openQuestions.close.0"],
  },
};

/** The dotted paths at which two JSON values differ; an item one array holds past the other's end differs alone. */
function differences(a: unknown, b: unknown, at = ""): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const inside = (step: string | number): string => (at === "" ? String(step) : `${at}.${String(step)}`);
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    return Array.from({ length }, (_, place) =>
      place < a.length && place < b.length ? differences(a[place], b[place], inside(place)) : [inside(place)],
    ).flat();
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      Object.hasOwn(a, key) && Object.hasOwn(b, key)
        ? differences(a[key], b[key], inside(key))
        : [inside(key)],
    );
  }
  return [at];
}

/** Whether a place is the field at `at` or inside it. */
const within = (place: string, at: string): boolean => place === at || place.startsWith(`${at}.`);

// ---------------------------------------------------------------------------------------------------------------
// The database

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side's role, with this file's schema first. */
let job: Sql;
let typedColumns: Map<string, string>;
/** Every statement the role client sent, in order (postgres.js debug: the text, never the values). */
const sent: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ name: "data_access_v121_db_side" });
  job = db.connect({
    max: 2,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: "rosie-t1522-v121", search_path: `${db.schema}, public`, role: JOB_ROLE },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 120_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table the seeds write (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** One seed row, its jsonb values as JSON and its bytea values as the bytes their hex names. */
async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) converted = sql.json(value);
    else if (type === "bytea" && typeof value === "string") converted = fromHex(value.replace(/^\\x/, ""));
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed file's rows after those of its `after` chain, each named relative to the file that names it, each file once. */
function seedRows(file: string, seen: Set<string>): SeedRow[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const seed = readJson(file) as SeedFile;
  return [
    ...seed.after.flatMap((before) => seedRows(path.join(path.dirname(file), before), seen)),
    ...seed.rows,
  ];
}

/** A fixture's chain: the K-04 seeds of every exchange in it, and the exchanges its `after` runs first, in order. */
function chainOf(file: string, seen = new Set<string>()): { seeds: string[]; steps: string[] } {
  const exchange = exchangeOf(file);
  if ((exchange.given.partSeeds ?? []).length > 0)
    throw new Error(`${file}: a v1.21 chain names no partSeeds`);
  const seeds = exchange.given.k04Seeds.map((seed) => path.join(CORE_SEEDS_DIR, seed));
  const steps: string[] = [];
  for (const before of exchange.given.after) {
    if (seen.has(before)) continue;
    seen.add(before);
    const inner = chainOf(before, seen);
    seeds.push(...inner.seeds);
    steps.push(...inner.steps, before);
  }
  return { seeds, steps };
}

/**
 * Loads a fixture's given into the emptied schema: its seeds and their chains as the tables' owner, in one transaction,
 * each file once; then each exchange its after chain names, through db/repo as rosie_job, each answering its own
 * fixture's outcome, valid at its own version.
 */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  const chain = chainOf(file);
  await reset();
  const seen = new Set<string>();
  const rows = chain.seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) await insertRow(tx, row.table, row.values);
  });
  for (const step of chain.steps) {
    const before = exchangeOf(step);
    const answer = await run(job, before);
    expect(answer, `${file}'s chain: ${step}`).toEqual(before.outcome);
    expect(answerErrors(entryOf(step).version, before.call, answer), `${file}'s chain: ${step}`).toEqual([]);
  }
  return exchange;
}

/** The core tables a commit writes: each versioned one's row count and sum of versions, each other's row count. */
const VERSIONED = ["turns", "open_questions", "clock_rows", "outbox_rows", "phones", "bookings"];
const WRITTEN_ONCE = ["event_log", "handles", "person_handles"];

/** What the core tables hold, as the tables' owner: equal before and after means nothing was written. */
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

/** An open question's stored row, every column, as the tables' owner. */
async function questionRow(id: string): Promise<Row> {
  const [row] = await db.sql<Row[]>`select * from open_questions where id = ${id}`;
  return must(row, `the open question ${id}`);
}

/** The raise a v1.21 request names: the question's id and the version the turn read (README item 81). */
function raiseOf(request: Record<string, Json>): { id: string; expectVersion: number } {
  const writes = request.writes as { openQuestions: { askAgain?: { id: string; expectVersion: number }[] } };
  return must(writes.openQuestions.askAgain?.[0], "the request's raise");
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

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("data-access v1.21 database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.21, accepted and refused, each a commit under commitTurn.askAgainExchange", () => {
    for (const version of DB_SIDE_VERSIONS) {
      const ofVersion = sideEntries.filter((entry) => entry.version === version);
      expect(ofVersion.filter((entry) => entry.expect === "accept").length, version).toBeGreaterThan(0);
      expect(ofVersion.filter((entry) => entry.expect === "refuse").length, version).toBeGreaterThan(0);
    }
    for (const entry of sideEntries) {
      expect(entry.def, entry.file).toBe(FIXTURE_DEF);
      expect(exchangeOf(entry.file).call, entry.file).toBe("commitTurn");
    }
  });

  it("has a twin for every refused request, and for no other file: an accepted v1.21 exchange with its given but its note and its outcome, its request but for the fault", () => {
    expect(Object.keys(REQUEST_TWINS).sort()).toEqual(sideRefused.map((entry) => entry.file).sort());
    for (const [file, twin] of Object.entries(REQUEST_TWINS)) {
      const twinEntry = entryOf(twin.twin);
      expect([twinEntry.version, twinEntry.expect, twinEntry.def], `${file}'s twin`).toEqual([
        entryOf(file).version,
        "accept",
        FIXTURE_DEF,
      ]);
      const refused = exchangeOf(file);
      const right = exchangeOf(twin.twin);
      expect({ ...refused.given, note: null }, `${file}: its twin's given`).toEqual({
        ...right.given,
        note: null,
      });
      expect(refused.outcome, `${file}: its twin's outcome`).toEqual(right.outcome);
      const differ = differences(refused.request, right.request);
      expect(differ.length, `${file}: its request differs`).toBeGreaterThan(0);
      for (const place of differ) {
        expect(
          twin.faults.some((fault) => within(place, fault)),
          `${file}: ${place} is the fault`,
        ).toBe(true);
      }
    }
  });

  it("runs every commit as rosie_job, the runtime side's role, with no business scope", SLOW, async () => {
    const [who] = await job<{ role: string; scope: string | null }[]>`
      select current_user as role, current_setting('rosie.business_id', true) as scope
    `;
    expect(who?.role).toBe(JOB_ROLE);
    expect(who?.scope ?? "").toBe("");
  });
});

describe("data-access v1.21 database side: each accepted exchange gives its outcome through db/repo, the raise at the version read", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file}: as rosie_job, after its chain, commitTurn answers the fixture's outcome, valid at ${entry.version}, and writes all or nothing`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const { id, expectVersion } = raiseOf(exchange.request);
        const before = await snapshot();
        const question = await questionRow(id);
        // The raise names the version the turn read: the question stands there now unless a later version refuses it.
        expect(question.version === expectVersion, "the question at the version read").toBe(
          exchange.outcome.error !== "versionChanged",
        );
        sent.length = 0;
        const answer = await commit(job, exchange.request, exchange.given.now);
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer), "the answer").toEqual([]);
        expect(
          errorsOf(validatorOf(entry.version, FIXTURE_DEF), { ...exchange, outcome: answer }),
          "the exchange with db/repo's answer",
        ).toEqual([]);
        expect(sent.length, "the commit reached the database").toBeGreaterThan(0);
        if (isError(answer)) {
          // Refused: nothing written, neither the row, nor its entries, nor a raised ask count (item 81 step 2).
          expect(await snapshot()).toEqual(before);
          expect(await questionRow(id)).toEqual(question);
          return;
        }
        // Committed: the question at ask count and version one higher, every other column as it was (defaults 192, 195).
        expect(await questionRow(id)).toEqual({
          ...question,
          ask_count: Number(question.ask_count) + 1,
          version: expectVersion + 1,
        });
        expect(await snapshot()).not.toEqual(before);
      },
    );
  }
});

describe("data-access v1.21 database side: each refused fixture is refused by db/repo before the database", () => {
  for (const entry of sideRefused) {
    it(
      `${entry.file}: in its own given db/repo throws on its request before any statement, nothing written, and answers it put right as its twin`,
      SLOW,
      async () => {
        const twin = must(REQUEST_TWINS[entry.file], `${entry.file}'s twin`);
        expect(errorsOf(validatorOf(entry.version, FIXTURE_DEF), exchangeOf(entry.file))).not.toEqual([]);
        const exchange = await given(entry.file);
        const before = await snapshot();
        sent.length = 0;
        expect(await thrownBy(commit(job, exchange.request, exchange.given.now))).toBeInstanceOf(TypeError);
        expect(sent, "no statement was sent").toEqual([]);
        expect(await snapshot()).toEqual(before);
        // With its one fault taken out the request is its twin's, and db/repo answers the outcome both state.
        const right = exchangeOf(twin.twin);
        const answer = await commit(job, right.request, exchange.given.now);
        expect(answer, "the twin's outcome, which the refused fixture states too").toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer)).toEqual([]);
        expect(errorsOf(validatorOf(entry.version, FIXTURE_DEF), { ...right, outcome: answer })).toEqual([]);
      },
    );
  }
});

describe("data-access v1.21 database side: what no fixture shows (default 199)", () => {
  it(
    "fire-once.json carrying askAgain: in its own given db/repo's checkFire throws before any statement, nothing written; as it stands it answers its outcome",
    SLOW,
    async () => {
      const file = "fire-once.json";
      const exchange = await given(file);
      const writes = exchange.request.writes as { openQuestions: Record<string, Json> };
      const raising: Exchange = {
        ...exchange,
        request: {
          ...exchange.request,
          writes: {
            ...(exchange.request.writes as Record<string, Json>),
            openQuestions: { ...writes.openQuestions, askAgain: [{ id: "oq-a7-03-alex", expectVersion: 2 }] },
          },
        },
      };
      expect(errorsOf(validatorOf("v1.21", "fireClock.exchange"), raising)).not.toEqual([]);
      const before = await snapshot();
      sent.length = 0;
      expect(await thrownBy(run(job, raising))).toBeInstanceOf(TypeError);
      expect(sent, "no statement was sent").toEqual([]);
      expect(await snapshot()).toEqual(before);
      const answer = await run(job, exchange);
      expect(answer).toEqual(exchange.outcome);
      expect(answerErrors(entryOf(file).version, exchange.call, answer)).toEqual([]);
    },
  );
});
