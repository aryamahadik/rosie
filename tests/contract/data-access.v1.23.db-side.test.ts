// Contract test for K-05 v1.23, a final refusal is parked at once with the passedOn line and Rosie's team's record: the
// database side (T-1550, T-1529's ruling card 3; T-1542's db/repo/park.ts, ruling card 4; DL-1142, DL-1144, DL-1185,
// DL-1195; contracts/data-access/README.md section "v1.23", item 84, defaults 216 to 224, "Consumers of v1.23", "What the
// new tasks must hold to" (card 4), and "Fixtures", v1.23).
//
// The schema side, data-access.v1.23.test.ts with data-access.v1.test.ts, checks every v1.23 fixture against the schema
// of v1.23. This part is the producer's side (C-152) of v1.23: the database engineer's build of item 84 (T-1542),
// parkTurn in v1.23's form. Every entry of fixtures/index.json whose version is one of DB_SIDE_VERSIONS runs here,
// selected by its version, never by a pinned list or count (DL-124, DL-125), against local PostgreSQL with every
// migration applied to a fresh schema (db/repo/test-db.ts; K-04 v1's 0009 and 0010 and K-37 v1's 0014 among them), each
// call through rosie_job with no business scope, as README item 84 gives it ("In one transaction on the runtime side"):
//   - each accepted exchange: its given is loaded as the tables' owner (its k04Seeds, each with its own after chain, each
//     file once), then the parks its after chain names run first through db/repo's parkTurn, each answering its own
//     fixture's outcome; then its request goes through parkTurn. The answer is the fixture's outcome, whole, valid at
//     v1.23's parkTurn.response, the exchange with it valid at parkTurn.lineExchange. A first park writes, and the tables
//     read back as the tables' owner show, item 84's four steps: the turn parked with its tries and parkedAt, never
//     committed; K-37's parked_turns row open, with default 220's summary built here from the reason's labels and the try
//     (the crash's fixed text with no reason) and person_told_at null; the one row checked at version 2 with the
//     request's plan and final parts, a quick reply to the turn's own handle about no booking, question or copy
//     (defaults 219 and 221), and no part, claim or opener mark beside it (default 221); and the one turn.parked entry,
//     its why the request's (default 222). A repeat writes nothing and answers the first park (default 223);
//   - each refused exchange, whose one fault is its request (REQUEST_TWINS, the README's "put right, it is
//     park-turn-sam-refused-at-once"): in its own given, its twin's but for its note, db/repo throws a TypeError before
//     any statement reaches the database, nothing written (card 4: "anything else throws a TypeError before the database
//     is reached"); and its twin's request, its one fault taken out, answers the twin's outcome;
//   - what no fixture shows (README "What the new tasks must hold to", QA's task and card 4): a reason at tries 3 parks
//     with "on try 3 of 3"; a park on try 2 without a reason, a reason that reads as a number, a second row, no row, a
//     row without its plan, a row with versions read or another send class, the words with straight apostrophes,
//     another fixed line beside passedOn, and the code checks the schema leaves to the producer (the plan's row and the
//     recipient the turn's handle: default 219), each thrown before any statement, nothing written; and v1's park-turn,
//     in v1's form, answering as before ("a park in v1's form writing as today").
// So a park of db/repo that drifts from the frozen v1.23 fails this test. db/repo's own tests (db/repo/park.int.test.ts,
// T-1542) hold the rest: the reply's due day, the claim that sends the row, and parks sent at once.
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database (DATABASE_URL) in CI.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listEventsForTurn } from "../../db/repo/event-log";
import { parkTurn, type ParkTurnRequest } from "../../db/repo/park";
import type { Sql, Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, type FixtureEntry } from "./_harness";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const DATA_ACCESS_DIR = path.join(CONTRACTS_ROOT, "data-access");
const FIXTURES_DIR = path.join(DATA_ACCESS_DIR, "fixtures");
const CORE_SEEDS_DIR = path.join(CONTRACTS_ROOT, "db-schema", "core", "fixtures");
const SLOW = { timeout: 60_000 };

/** The versions with a database side here: v1.23 (T-1542). */
const DB_SIDE_VERSIONS = ["v1.23"];
const VERSION = "v1.23";
/** The definition README "Fixtures" (v1.23) lists the v1.23 fixtures under. */
const LINE_DEF = "parkTurn.lineExchange";
/** The role the call runs as (README item 84: "on the runtime side"; item 12: rosie_job with no business scope). */
const JOB_ROLE = "rosie_job";

interface Reason {
  from: string;
  fault: string;
  ids: string[];
}

interface ParkRow {
  id: string;
  recipientHandleId: string;
  recipientPersonId: string | null;
  businessId: string | null;
  channel: string;
  plan: Json;
  finalParts: Json;
}

interface ParkRequest {
  turn: { id: string; handleId: string; eventIds: string[]; traceId: string; tries: number };
  parkedAt: string;
  reason?: Reason;
  outboxRows: ParkRow[];
  events: { id: string; why: Json }[];
}

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; partSeeds?: string[]; after: string[]; now: string; note?: string };
  request: ParkRequest;
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
/** A fixture's request as db/repo's call takes it. */
const requestOf = (exchange: Exchange): ParkTurnRequest => exchange.request as unknown as ParkTurnRequest;

// ---------------------------------------------------------------------------------------------------------------
// The schemas: every schema under contracts/, as contracts:check loads them, so each $ref resolves; one strict
// validator (Ajv 2020-12)

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

/** A park's answer against v1.23's parkTurn.response, or its errors when it is one. */
const answerErrors = (version: string, answer: unknown): string[] =>
  errorsOf(validatorOf(version, isError(answer) ? "parkTurn.errors" : "parkTurn.response"), answer);

// ---------------------------------------------------------------------------------------------------------------
// The README: default 220's form of Rosie's team's summary, as the README writes it

const readme = readFileSync(path.join(DATA_ACCESS_DIR, "README.md"), "utf8");
const DEFAULT_220 = must(
  readme.split("\n").find((line) => line.startsWith("220. **The team's record")),
  "README default 220",
);
/** The crash's summary, db/repo's fixed text, as default 220 quotes it. */
const CRASH_SUMMARY = "Crashed three times before the commit (try 3 of 3); nothing was committed";

/**
 * Default 220's summary: for a refusal `Refused as final (<from>: <fault>) on try <tries> of 3; nothing was committed`,
 * with `; ` and the ids joined by `, ` after the fault when there are ids; for a crash db/repo's fixed text.
 */
function summaryOf(reason: Reason | undefined, tries: number): string {
  if (reason === undefined) return CRASH_SUMMARY;
  const ids = reason.ids.length === 0 ? "" : `; ${reason.ids.join(", ")}`;
  return `Refused as final (${reason.from}: ${reason.fault}${ids}) on try ${String(tries)} of 3; nothing was committed`;
}

// ---------------------------------------------------------------------------------------------------------------
// The refused fixtures' twins, and the dotted paths two values differ at

/**
 * The refused exchanges of v1.23, whose one fault is their request, each with its twin: the accepted exchange whose
 * given (but its note) and outcome it shares, and whose request it is with the fault taken out (README "Fixtures",
 * v1.23: "put right, it is park-turn-sam-refused-at-once"); and `faults`, the places of the refused request that carry
 * its fault.
 */
const AT_ONCE = "park-turn-sam-refused-at-once.json";
const MAYA = "park-turn-maya-crash-with-line.json";
const V1_PARK = "park-turn.json";
const REQUEST_TWINS: Readonly<Record<string, { twin: string; faults: string[] }>> = {
  // no reason on try 1 (default 218)
  "invalid/refuse-park-turn-sam-refused-no-reason.json": { twin: AT_ONCE, faults: ["reason"] },
  // the row's words not the passedOn line (default 216)
  "invalid/refuse-park-turn-sam-refused-line-reworded.json": {
    twin: AT_ONCE,
    faults: ["outboxRows.0.finalParts.sends.0.text"],
  },
  // the reason's fault in words, no label (default 217)
  "invalid/refuse-park-turn-sam-refused-reason-words.json": { twin: AT_ONCE, faults: ["reason.fault"] },
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
  db = await createTestDatabase({ name: "data_access_v123_db_side" });
  job = db.connect({
    max: 2,
    onnotice: () => undefined,
    debug: (_connection: number, query: string) => {
      sent.push(query);
    },
    connection: { application_name: "rosie-t1550-v123", search_path: `${db.schema}, public`, role: JOB_ROLE },
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
    throw new Error(`${file}: a v1.23 chain names no partSeeds`);
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
 * each file once; then each park its after chain names, through db/repo as rosie_job, each answering its own fixture's
 * outcome, valid at its own version.
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
    expect(before.call, `${file}'s chain: ${step}`).toBe("parkTurn");
    const answer = await parkTurn(job, requestOf(before));
    expect(answer, `${file}'s chain: ${step}`).toEqual(before.outcome);
    expect(answerErrors(entryOf(step).version, answer), `${file}'s chain: ${step}`).toEqual([]);
  }
  return exchange;
}

/** The tables a park writes, and those it must leave alone (default 221: no part, claim or opener mark). */
const WRITTEN = ["turns", "parked_turns", "outbox_rows", "event_log"];
const LEFT_ALONE = ["outbox_parts", "outbox_claims", "openers_sent", "open_questions", "clock_rows"];

/** What those tables hold, as the tables' owner: equal before and after means nothing was written. */
async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of [...WRITTEN, ...LEFT_ALONE]) {
    out[table] = await db.sql`select * from ${db.sql(table)} order by 1`;
  }
  return out;
}

/** Each table's row count, as the tables' owner. */
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of [...WRITTEN, ...LEFT_ALONE]) {
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)}`;
    out[table] = row?.n ?? -1;
  }
  return out;
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

/** A copy of a request with one change: the field at a dotted path set, or taken out for undefined. */
function withChange(request: ParkRequest, at: string, value: Json | undefined): ParkRequest {
  const copy = structuredClone(request) as unknown as Record<string, unknown>;
  const steps = at.split(".");
  const last = must(steps.pop(), `the last step of ${at}`);
  let parent: unknown = copy;
  for (const step of steps) {
    parent = Array.isArray(parent) ? parent[Number(step)] : isRecord(parent) ? parent[step] : undefined;
  }
  if (Array.isArray(parent)) {
    if (value === undefined) parent.splice(Number(last), 1);
    else parent[Number(last)] = value;
  } else if (isRecord(parent)) {
    if (value === undefined) Reflect.deleteProperty(parent, last);
    else parent[last] = value;
  } else {
    throw new Error(`${at} is inside no object`);
  }
  return copy as unknown as ParkRequest;
}

/**
 * What a first park in v1.23's form left in the tables, read back as the tables' owner, against item 84's four steps
 * and defaults 219 to 222: each way it differs, none when it holds.
 */
async function parkWritten(request: ParkRequest): Promise<string[]> {
  const problems: string[] = [];
  const { turn } = request;
  const row = must(request.outboxRows[0], "the park's row");
  const iso = (date: unknown): string | null =>
    date instanceof Date ? date.toISOString().replace(".000Z", "Z") : null;

  // 1. The turn: parked with its tries and parked_at, never committed.
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select state, tries, parked_at, committed_at, handle_id from turns where id = ${turn.id}
  `;
  const turnRow = {
    state: stored?.state,
    tries: stored?.tries,
    parkedAt: iso(stored?.parked_at),
    committedAt: stored?.committed_at,
    handleId: stored?.handle_id,
  };
  const turnExpected = {
    state: "parked",
    tries: turn.tries,
    parkedAt: request.parkedAt,
    committedAt: null,
    handleId: turn.handleId,
  };
  if (!isDeepStrictEqual(turnRow, turnExpected)) problems.push(`the turn: ${JSON.stringify(turnRow)}`);

  // 2. Rosie's team's record: open, default 220's summary, person_told_at null, its reply due after the park.
  const [team] = await db.sql<Record<string, unknown>[]>`
    select state, version, error_summary, person_told_at, reply_due_at from parked_turns where turn_id = ${turn.id}
  `;
  const summary = summaryOf(request.reason, turn.tries);
  if (team?.error_summary !== summary) {
    problems.push(`the team's summary is ${JSON.stringify(team?.error_summary)}, not ${summary}`);
  }
  if (team?.state !== "open" || team.person_told_at !== null) {
    problems.push("the team's record is not open with no one told");
  }
  const due = team?.reply_due_at instanceof Date ? team.reply_due_at.getTime() : Number.NaN;
  if (!(due > Date.parse(request.parkedAt))) problems.push("the team's reply is not due after the park");

  // 3. The one row: checked at version 2, the request's plan and final parts, a quick reply to the turn's handle about
  //    no booking, question or copy, decided on no versions.
  const rows = await db.sql<Record<string, unknown>[]>`
    select id, state, version, plan, final_parts, recipient_handle_id, recipient_person_id, business_id, booking_id,
           open_question_id, copy_of_row_id, channel, send_class, versions_read
    from outbox_rows where turn_id = ${turn.id}
  `;
  const expectedRow = {
    id: row.id,
    state: "checked",
    version: 2,
    plan: row.plan,
    final_parts: row.finalParts,
    recipient_handle_id: turn.handleId,
    recipient_person_id: row.recipientPersonId,
    business_id: row.businessId,
    booking_id: null,
    open_question_id: null,
    copy_of_row_id: null,
    channel: row.channel,
    send_class: "quick_reply",
    versions_read: [],
  };
  if (rows.length !== 1) problems.push(`the park wrote ${String(rows.length)} rows, not one`);
  else if (!isDeepStrictEqual({ ...rows[0] }, expectedRow)) {
    problems.push(`the row differs at ${differences({ ...rows[0] }, expectedRow).join(", ")}`);
  }

  // 4. The entries: the request's one turn.parked, its why the request's (the reason's labels, or v1's outage path).
  const events = await listEventsForTurn(db.sql, turn.id);
  const written = events.map((event) => [event.id, event.kind, event.tableName, event.rowId, event.why]);
  const asked = request.events.map((event) => [event.id, "turn.parked", "turns", turn.id, event.why]);
  if (!isDeepStrictEqual(written, asked)) problems.push(`the entries are ${JSON.stringify(written)}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

describe("data-access v1.23 database side: the versions with one, each entry selected by its version", () => {
  it("runs every entry of v1.23, accepted and refused, each a park under parkTurn.lineExchange", () => {
    for (const version of DB_SIDE_VERSIONS) {
      const ofVersion = sideEntries.filter((entry) => entry.version === version);
      expect(ofVersion.filter((entry) => entry.expect === "accept").length, version).toBeGreaterThan(0);
      expect(ofVersion.filter((entry) => entry.expect === "refuse").length, version).toBeGreaterThan(0);
    }
    for (const entry of sideEntries) {
      expect(entry.def, entry.file).toBe(LINE_DEF);
      expect(exchangeOf(entry.file).call, entry.file).toBe("parkTurn");
    }
  });

  it("has a twin for every refused request, and for no other file: an accepted v1.23 exchange with its given but its note and its outcome, its request but for the fault", () => {
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

  it("runs every call as rosie_job, the runtime side's role, with no business scope", SLOW, async () => {
    const [who] = await job<{ role: string; scope: string | null }[]>`
      select current_user as role, current_setting('rosie.business_id', true) as scope
    `;
    expect(who?.role).toBe(JOB_ROLE);
    expect(who?.scope ?? "").toBe("");
  });

  it("states default 220's form and the crash's text as this file builds them (README default 220)", () => {
    const atOnce = exchangeOf(AT_ONCE).request;
    expect(DEFAULT_220).toContain(`\`${summaryOf(atOnce.reason, atOnce.turn.tries)}\``);
    expect(DEFAULT_220).toContain(`\`${CRASH_SUMMARY}\``);
  });
});

describe("data-access v1.23 database side: each accepted exchange gives its outcome through db/repo, and a first park writes item 84's four steps", () => {
  for (const entry of sideAccepted) {
    it(
      `${entry.file}: as rosie_job, after its chain, parkTurn answers the fixture's outcome, valid at ${entry.version}`,
      SLOW,
      async () => {
        const exchange = await given(entry.file);
        const before = await snapshot();
        sent.length = 0;
        const answer = await parkTurn(job, requestOf(exchange));
        expect(answer).toEqual(exchange.outcome);
        expect(answerErrors(entry.version, answer), "the answer").toEqual([]);
        expect(
          errorsOf(validatorOf(entry.version, must(entry.def)), { ...exchange, outcome: answer }),
          "the exchange with db/repo's answer",
        ).toEqual([]);
        expect(sent.length, "the call reached the database").toBeGreaterThan(0);
        if (exchange.given.after.length > 0) {
          // A repeat writes nothing and answers the first park, repeated (default 223).
          expect(answer).toMatchObject({ repeated: true });
          expect(await snapshot(), "a repeat writes nothing").toEqual(before);
          return;
        }
        expect(await parkWritten(exchange.request)).toEqual([]);
        // Nothing beside item 84's four steps: no part, claim, opener mark, question or clock (default 221).
        const after = await counts();
        expect(after).toEqual({
          turns: 1,
          parked_turns: 1,
          outbox_rows: 1,
          event_log: exchange.request.events.length,
          outbox_parts: 0,
          outbox_claims: 0,
          openers_sent: 0,
          open_questions: 0,
          clock_rows: 0,
        });
      },
    );
  }

  it(
    `${AT_ONCE} keeps Rosie's team's summary to the labels and the try: "${summaryOf(exchangeOf(AT_ONCE).request.reason, 1)}"; ${MAYA} the crash's text`,
    SLOW,
    async () => {
      for (const [file, summary] of [
        [AT_ONCE, "Refused as final (walk: stepNotInBundle; S1-04) on try 1 of 3; nothing was committed"],
        [MAYA, CRASH_SUMMARY],
      ] as const) {
        const exchange = await given(file);
        expect(await parkTurn(job, requestOf(exchange)), file).toEqual(exchange.outcome);
        const [team] = await db.sql<{ error_summary: string }[]>`
          select error_summary from parked_turns where turn_id = ${exchange.request.turn.id}
        `;
        expect(team?.error_summary, file).toBe(summary);
      }
    },
  );

  it(
    "has the read-back fire on a park the tables do not hold: another try, another row's words, no entry",
    SLOW,
    async () => {
      const exchange = await given(AT_ONCE);
      await parkTurn(job, requestOf(exchange));
      const asked = exchange.request;
      expect(await parkWritten(withChange(asked, "turn.tries", 2))).toEqual([
        `the turn: ${JSON.stringify({ state: "parked", tries: 1, parkedAt: asked.parkedAt, committedAt: null, handleId: asked.turn.handleId })}`,
        'the team\'s summary is "Refused as final (walk: stepNotInBundle; S1-04) on try 1 of 3; nothing was committed", not Refused as final (walk: stepNotInBundle; S1-04) on try 2 of 3; nothing was committed',
      ]);
      const reworded = withChange(asked, "outboxRows.0.finalParts.sends.0.text", "Something went wrong.");
      expect(await parkWritten(reworded)).toEqual(["the row differs at final_parts.sends.0.text"]);
      // The stored why is jsonb, whose keys come back in PostgreSQL's order, so the line is matched by its entry alone.
      expect(await parkWritten(withChange(asked, "events", []))).toEqual([
        expect.stringMatching(
          /^the entries are \[\["log-turn-sam-refused-1-parked","turn\.parked","turns","turn-sam-refused-1",\{"refused":/,
        ),
      ]);
    },
  );
});

describe("data-access v1.23 database side: each refused fixture is refused by db/repo before the database", () => {
  for (const entry of sideRefused) {
    it(
      `${entry.file}: in its own given db/repo throws on its request before any statement, nothing written, and answers it put right as its twin`,
      SLOW,
      async () => {
        const twin = must(REQUEST_TWINS[entry.file], `${entry.file}'s twin`);
        expect(errorsOf(validatorOf(entry.version, must(entry.def)), exchangeOf(entry.file))).not.toEqual([]);
        const exchange = await given(entry.file);
        const before = await snapshot();
        sent.length = 0;
        expect(await thrownBy(parkTurn(job, requestOf(exchange)))).toBeInstanceOf(TypeError);
        expect(sent, "no statement was sent").toEqual([]);
        expect(await snapshot()).toEqual(before);
        // With its one fault taken out the request is its twin's, and db/repo answers the outcome both state.
        const right = exchangeOf(twin.twin);
        const answer = await parkTurn(job, requestOf(right));
        expect(answer, "the twin's outcome, which the refused fixture states too").toEqual(exchange.outcome);
        expect(answerErrors(entry.version, answer)).toEqual([]);
        expect(await parkWritten(right.request)).toEqual([]);
      },
    );
  }
});

describe("data-access v1.23 database side: what no fixture shows (README QA's task and card 4)", () => {
  const A_NUMBER = "5555550100";
  const line = (): string => {
    const parts = must(exchangeOf(AT_ONCE).request.outboxRows[0]).finalParts as {
      sends: { text: string }[];
    };
    return must(parts.sends[0]).text;
  };
  /** Each a request db/repo refuses before any statement: the change, from which accepted fixture, and why. */
  const thrown: [string, string, string, Json | undefined][] = [
    ["a park on try 2 without a reason (default 218)", MAYA, "turn.tries", 2],
    ["a reason's from that reads as a number (default 217)", AT_ONCE, "reason.from", A_NUMBER],
    ["a reason's id that reads as a number (default 217)", AT_ONCE, "reason.ids.0", A_NUMBER],
    ["a reason's id given twice (K-08 labels, each once)", AT_ONCE, "reason.ids", ["S1-04", "S1-04"]],
    [
      "a second row (item 84: exactly one)",
      AT_ONCE,
      "outboxRows.1",
      {
        ...(must(exchangeOf(AT_ONCE).request.outboxRows[0]) as unknown as Record<string, Json>),
        id: "out-2",
      },
    ],
    ["no row (item 84: exactly one)", AT_ONCE, "outboxRows", []],
    ["a row without its plan (default 221)", AT_ONCE, "outboxRows.0.plan", undefined],
    [
      "a row with versions read (default 219)",
      AT_ONCE,
      "outboxRows.0.versionsRead",
      [{ table: "phones", rowId: "+15555550100", version: 1 }],
    ],
    ["a row of another send class (default 219)", MAYA, "outboxRows.0.sendClass", "routine"],
    [
      "the words with straight apostrophes (default 216)",
      AT_ONCE,
      "outboxRows.0.finalParts.sends.0.text",
      line().replaceAll("’", "'"),
    ],
    [
      "another fixed line beside passedOn (default 216)",
      AT_ONCE,
      "outboxRows.0.finalParts.fixedLines",
      ["passedOn", "opener"],
    ],
    ["a plan naming another row (default 219, a code check)", AT_ONCE, "outboxRows.0.plan.row", "out-other"],
    [
      "final parts on another channel (default 219, a code check)",
      AT_ONCE,
      "outboxRows.0.finalParts.channel",
      "email",
    ],
    [
      "a row to another handle than the turn's (default 219, a code check)",
      AT_ONCE,
      "outboxRows.0.recipientHandleId",
      "handle-alex",
    ],
  ];

  for (const [what, from, at, value] of thrown) {
    it(`${from} with ${what}: db/repo throws before any statement, nothing written`, SLOW, async () => {
      const exchange = await given(from);
      const changed = withChange(exchange.request, at, value);
      const before = await snapshot();
      sent.length = 0;
      expect(await thrownBy(parkTurn(job, changed as unknown as ParkTurnRequest))).toBeInstanceOf(TypeError);
      expect(sent, "no statement was sent").toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  }

  it(
    `${AT_ONCE} on its third try, with its reason (default 218): parked, its summary "on try 3 of 3"`,
    SLOW,
    async () => {
      const exchange = await given(AT_ONCE);
      const third = withChange(exchange.request, "turn.tries", 3);
      const answer = await parkTurn(job, third as unknown as ParkTurnRequest);
      expect(answer).toEqual(exchange.outcome);
      expect(await parkWritten(third)).toEqual([]);
      expect(summaryOf(third.reason, 3)).toContain("on try 3 of 3");
    },
  );

  it(
    `${V1_PARK}, in v1's form, still answers its outcome through the same call: its row unworded and planned (item 84: "In v1's form it is item 12's call")`,
    SLOW,
    async () => {
      const exchange = await given(V1_PARK);
      const answer = await parkTurn(job, requestOf(exchange));
      expect(answer).toEqual(exchange.outcome);
      expect(answerErrors(VERSION, answer)).toEqual([]);
      const rows = await db.sql<{ state: string; version: number; plan: unknown; final_parts: unknown }[]>`
        select state, version, plan, final_parts from outbox_rows where turn_id = ${exchange.request.turn.id}
      `;
      expect(rows.map((row) => ({ ...row }))).toEqual([
        { state: "planned", version: 1, plan: null, final_parts: null },
      ]);
      const [team] = await db.sql<{ error_summary: string }[]>`
        select error_summary from parked_turns where turn_id = ${exchange.request.turn.id}
      `;
      expect(team?.error_summary).toBe(CRASH_SUMMARY);
    },
  );
});
