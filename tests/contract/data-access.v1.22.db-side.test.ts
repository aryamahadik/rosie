// Contract test for K-05 v1.22, an outbox row carries its own step and line: the database side (T-1522; T-1476's
// db/repo/commit-turn.ts writeOutboxRows and db/repo/turn-face-reads.ts readOutboxRowIn; DL-999, DL-1030, DL-1101;
// contracts/data-access/README.md section "v1.22", items 82 and 83, defaults 206 to 214, "Consumers of v1.22", "What the
// new tasks must hold to", and "Fixtures", v1.22).
//
// The schema side, data-access.v1.22.test.ts with data-access.v1.test.ts, checks every v1.22 fixture against the schema
// of v1.22. This part is the producer's side (C-152) of v1.22: the database engineer's build of items 82 and 83 (T-1476),
// commitTurn writing a row's step and line and readOutboxRow reading the row's own first. Every entry of
// fixtures/index.json whose version is one of DB_SIDE_VERSIONS runs here, selected by its version, never by a pinned list
// or count (DL-124, DL-125), against local PostgreSQL with every migration applied to a fresh schema (db/repo/test-db.ts,
// K-04 core v1.2's 0039 among them), each call through rosie_job, the runtime side's role, as the README gives both
// (README "Scope": commitTurn per write; item 35: readOutboxRow as rosie_job under the row's business):
//   - each accepted exchange: its given is loaded as the tables' owner (its k04Seeds, each with its own after chain, each
//     file once), then the commits its after chain names run first through db/repo's commitTurn, each answering its own
//     fixture's outcome, valid at its own version; then its request goes through its call at given.now. The answer is the
//     fixture's outcome, whole, valid at v1.22 (a commit's as commitTurn's response or one of its errors, a read's as
//     readOutboxRow.v1dot6Response, the answer a v1.6 or later call gives), the exchange with it valid at its definition.
//     A commit stores each row's step and line as its request names them, and both null where it names neither, every
//     earlier row of the chain with both null (item 82; default 212: nothing backfilled), so commit-s1-04-sam-lines
//     stores S1-08 and 0 and S1-09 and 0; a read writes nothing and answers its line from the row exactly when the row
//     stores a step, from its question otherwise (item 83, default 208), so read-outbox-row-s1-08-sam answers "row" and
//     read-outbox-row-s1-02-older-row "openQuestion";
//   - the refused exchange, whose one fault is its request (REQUEST_TWINS: a step with no lineNo): in its own given, its
//     twin's but for its note, db/repo throws before any statement reaches the database (default 206; db/repo's default
//     1), nothing written; and with its one fault taken out, its twin's request, db/repo answers the twin's outcome and
//     stores the twin's pairs;
//   - what no fixture shows (README "What the new tasks must hold to", T-1476's checkRequest): a lineNo with no step, a
//     negative lineNo and a step not in K-01's form each throw before any statement, nothing written.
// So a commit or read of db/repo that drifts from the frozen v1.22 fails this test. db/repo's own tests
// (db/repo/commit-turn.int.test.ts and db/repo/turn-face-reads.int.test.ts, T-1476) hold the rest: a row that asks a
// question and stores its own step, a stored step with no line_no, and the one select's columns.
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
  commitTurn,
  type CommitTurnAskAgainRequest,
  type CommitTurnRequest,
} from "../../db/repo/commit-turn";
import type { Sql, Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { readOutboxRow } from "../../db/repo/turn-face-reads";
import { CONTRACTS_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const CORE_SEEDS_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");
const SLOW = { timeout: 60_000 };

/** The versions with a database side here: v1.22 (T-1476). */
const DB_SIDE_VERSIONS = ["v1.22"];
/** The definitions README "Fixtures" (v1.22) lists the v1.22 fixtures under, by call. */
const FIXTURE_DEFS: Readonly<Record<string, string>> = {
  commitTurn: "commitTurn.rowLineExchange",
  readOutboxRow: "readOutboxRow.exchange",
};
/** The role both calls run as (README "Scope": commitTurn on the runtime side, per write; item 35: rosie_job). */
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

/** A version's major and minor number: v1.6 is [1, 6]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

/**
 * The definition an answer is judged by at `version`: its call's errors when it is one; a readOutboxRow answer from v1.6
 * on as readOutboxRow.v1dot6Response, the answer a v1.6 or later call gives (README item 45; T-1476 "valid at v1.22's
 * readOutboxRow.v1dot6Response"); else its call's response.
 */
function answerDefOf(version: string, call: string, answer: unknown): string {
  if (isError(answer)) return `${call}.errors`;
  if (call === "readOutboxRow" && placeOf(version)[1] >= 6) return "readOutboxRow.v1dot6Response";
  return `${call}.response`;
}

/** An answer against the definition answerDefOf names for it at `version`. */
function answerErrors(version: string, call: string, answer: unknown): string[] {
  return errorsOf(validatorOf(version, answerDefOf(version, call, answer)), answer);
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

/** The two calls v1.22 changes (items 82 and 83), each db/repo's own, on the runtime side as rosie_job. */
async function run(sql: Sql, exchange: Exchange): Promise<unknown> {
  switch (exchange.call) {
    case "commitTurn":
      return commit(sql, exchange.request, exchange.given.now);
    case "readOutboxRow":
      return readOutboxRow(sql, exchange.request as unknown as Parameters<typeof readOutboxRow>[1], {
        now: new Date(exchange.given.now),
      });
    default:
      throw new Error(`this test runs no ${exchange.call} exchange`);
  }
}

/**
 * The refused exchange of v1.22, whose one fault is its request, with its twin: the accepted exchange whose given (but
 * its note) and outcome it shares, and whose request it is with the fault taken out (README "Fixtures", v1.22: "put
 * right, it is commit-s1-04-sam-lines"); and `faults`, the places of the refused request that carry its fault.
 */
const REQUEST_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // S1-08's row naming its step and no lineNo: both or neither (default 206)
  "invalid/refuse-commit-s1-04-sam-step-without-line.json": {
    twin: "commit-s1-04-sam-lines.json",
    faults: ["writes.outboxRows.0"],
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
  db = await createTestDatabase({ name: "data_access_v122_db_side" });
  job = db.connect({
    max: 2,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: "rosie-t1522-v122", search_path: `${db.schema}, public`, role: JOB_ROLE },
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
    throw new Error(`${file}: a v1.22 chain names no partSeeds`);
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

interface StoredPair {
  id: string;
  step: string | null;
  line_no: number | null;
}

/** Every outbox row's stored step and line, as the tables' owner, in commit order. */
async function storedPairs(): Promise<StoredPair[]> {
  return db.sql<StoredPair[]>`select id, step, line_no from outbox_rows order by commit_seq, id collate "C"`;
}

/** The pairs a commit's request names for its rows, each both null where it names neither (item 82). */
function requestedPairs(request: Record<string, Json>): StoredPair[] {
  const rows = (request.writes as { outboxRows: { id: string; step?: string; lineNo?: number }[] })
    .outboxRows;
  return rows.map((row) => ({ id: row.id, step: row.step ?? null, line_no: row.lineNo ?? null }));
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

/** A copy of a commit's request with one change to its first row: a field set, or taken out for undefined. */
function withFirstRow(
  request: Record<string, Json>,
  field: string,
  value: Json | undefined,
): Record<string, Json> {
  const copy = structuredClone(request);
  const rows = (copy.writes as { outboxRows: Record<string, Json>[] }).outboxRows;
  const first = must(rows[0], "the request's first row");
  if (value === undefined) Reflect.deleteProperty(first, field);
  else first[field] = value;
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

const COMMIT = "commit-s1-04-sam-lines.json";

describe("data-access v1.22 database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.22, accepted and refused, each a commit or a read under the definition README 'Fixtures' lists it under", () => {
    for (const version of DB_SIDE_VERSIONS) {
      const ofVersion = sideEntries.filter((entry) => entry.version === version);
      expect(ofVersion.filter((entry) => entry.expect === "accept").length, version).toBeGreaterThan(0);
      expect(ofVersion.filter((entry) => entry.expect === "refuse").length, version).toBeGreaterThan(0);
    }
    for (const entry of sideEntries) {
      const { call } = exchangeOf(entry.file);
      expect(entry.def, entry.file).toBe(must(FIXTURE_DEFS[call], `${entry.file}: a call v1.22 changes`));
    }
    const calls = new Set(sideAccepted.map((entry) => exchangeOf(entry.file).call));
    expect([...calls].sort()).toEqual(Object.keys(FIXTURE_DEFS).sort());
  });

  it("has a twin for every refused request, and for no other file: an accepted v1.22 exchange with its given but its note and its outcome, its request but for the fault", () => {
    expect(Object.keys(REQUEST_TWINS).sort()).toEqual(sideRefused.map((entry) => entry.file).sort());
    for (const [file, twin] of Object.entries(REQUEST_TWINS)) {
      const twinEntry = entryOf(twin.twin);
      expect([twinEntry.version, twinEntry.expect, twinEntry.def], `${file}'s twin`).toEqual([
        entryOf(file).version,
        "accept",
        entryOf(file).def,
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

  it(
    "runs every call as rosie_job, the runtime side's role, with no business scope between calls",
    SLOW,
    async () => {
      const [who] = await job<{ role: string; scope: string | null }[]>`
      select current_user as role, current_setting('rosie.business_id', true) as scope
    `;
      expect(who?.role).toBe(JOB_ROLE);
      expect(who?.scope ?? "").toBe("");
    },
  );
});

describe("data-access v1.22 database side: each accepted exchange gives its outcome through db/repo, a row's own pair stored and read first", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file}: as rosie_job, after its chain, ${exchangeOf(entry.file).call} answers the fixture's outcome, valid at ${entry.version}`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const before = await snapshot();
        const pairsBefore = await storedPairs();
        sent.length = 0;
        const answer = await run(job, exchange);
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer), "the answer").toEqual([]);
        expect(
          errorsOf(validatorOf(entry.version, must(entry.def)), { ...exchange, outcome: answer }),
          "the exchange with db/repo's answer",
        ).toEqual([]);
        expect(sent.length, "the call reached the database").toBeGreaterThan(0);
        if (exchange.call === "commitTurn") {
          // The rows the commit wrote store the pair its request names, and every earlier row keeps both null (item 82;
          // default 212: nothing backfilled).
          expect(pairsBefore.every((pair) => pair.step === null && pair.line_no === null)).toBe(true);
          expect(await storedPairs()).toEqual([...pairsBefore, ...requestedPairs(exchange.request)]);
          return;
        }
        // A read writes nothing, and answers its line from the row exactly when the row stores a step (item 83).
        expect(await snapshot()).toEqual(before);
        const id = exchange.request.outboxRowId;
        if (typeof id !== "string") throw new Error(`${entry.file} names no row`);
        const stored = must(
          pairsBefore.find((pair) => pair.id === id),
          `${id} stored`,
        );
        const line = isRecord(answer) ? answer.line : undefined;
        if (stored.step === null) {
          expect(isRecord(line) ? line.from : null, `${id} stores no step`).not.toBe("row");
        } else {
          expect(line, `${id} stores its pair`).toEqual({
            step: stored.step,
            index: stored.line_no,
            from: "row",
          });
        }
      },
    );
  }

  it(
    `${COMMIT} stores S1-08 and 0 on out-s1-08-sam and S1-09 and 0 on out-s1-09-sam, and turn 1's row neither; the S1-08 row reads from row, the older row from openQuestion`,
    SLOW,
    async () => {
      const exchange = await given(COMMIT);
      expect(await run(job, exchange)).toEqual(exchange.outcome);
      expect(await storedPairs()).toEqual([
        { id: "outbox-s1-02-sam-1", step: null, line_no: null },
        { id: "out-s1-08-sam", step: "S1-08", line_no: 0 },
        { id: "out-s1-09-sam", step: "S1-09", line_no: 0 },
      ]);
      // Each read in its own given, whose chain runs the commit again and whose seeds give Sam's phone its chat.
      const froms: Record<string, unknown> = {};
      for (const file of ["read-outbox-row-s1-08-sam.json", "read-outbox-row-s1-02-older-row.json"]) {
        const read = await given(file);
        const answer = await run(job, read);
        expect(answer, file).toEqual(read.outcome);
        froms[file] = isRecord(answer) && isRecord(answer.line) ? answer.line.from : null;
      }
      expect(froms).toEqual({
        "read-outbox-row-s1-08-sam.json": "row",
        "read-outbox-row-s1-02-older-row.json": "openQuestion",
      });
    },
  );
});

describe("data-access v1.22 database side: the refused fixture is refused by db/repo before the database", () => {
  for (const entry of sideRefused) {
    it(
      `${entry.file}: in its own given db/repo throws on its request before any statement, nothing written, and answers it put right as its twin`,
      SLOW,
      async () => {
        const twin = must(REQUEST_TWINS[entry.file], `${entry.file}'s twin`);
        expect(errorsOf(validatorOf(entry.version, must(entry.def)), exchangeOf(entry.file))).not.toEqual([]);
        const exchange = await given(entry.file);
        const before = await snapshot();
        const pairsBefore = await storedPairs();
        sent.length = 0;
        expect(await thrownBy(run(job, exchange))).toBeInstanceOf(TypeError);
        expect(sent, "no statement was sent").toEqual([]);
        expect(await snapshot()).toEqual(before);
        // With its one fault taken out the request is its twin's, and db/repo answers the outcome both state.
        const right = exchangeOf(twin.twin);
        const answer = await run(job, { ...exchange, request: right.request });
        expect(answer, "the twin's outcome, which the refused fixture states too").toEqual(exchange.outcome);
        expect(answerErrors(entry.version, exchange.call, answer)).toEqual([]);
        expect(errorsOf(validatorOf(entry.version, must(entry.def)), { ...right, outcome: answer })).toEqual(
          [],
        );
        expect(await storedPairs()).toEqual([...pairsBefore, ...requestedPairs(right.request)]);
      },
    );
  }
});

describe("data-access v1.22 database side: what no fixture shows, each thrown before any statement (T-1476's checkRequest)", () => {
  const cases: [string, string, Json | undefined][] = [
    ["a lineNo with no step", "step", undefined],
    ["a negative lineNo", "lineNo", -1],
    ["a step not in K-01's form", "step", "s1-08"],
  ];
  for (const [what, field, value] of cases) {
    it(
      `${COMMIT} with ${what} on its first row: db/repo throws before any statement, nothing written`,
      SLOW,
      async () => {
        const exchange = await given(COMMIT);
        const changed: Exchange = { ...exchange, request: withFirstRow(exchange.request, field, value) };
        expect(
          errorsOf(validatorOf("v1.22", "commitTurn.exchange"), changed),
          "the schema refuses it",
        ).not.toEqual([]);
        const before = await snapshot();
        sent.length = 0;
        expect(await thrownBy(run(job, changed))).toBeInstanceOf(TypeError);
        expect(sent, "no statement was sent").toEqual([]);
        expect(await snapshot()).toEqual(before);
      },
    );
  }
});
