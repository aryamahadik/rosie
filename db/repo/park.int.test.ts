// T-197: K-05 v1's parkTurn (README item 12; arch 11 line 576; K-37 v1 parked_turns) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/park`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts); the public schema is never touched.
//
// Every park runs as K-05 states it (README "Scope": runtime; T-191's roles): through a client whose connections run as
// rosie_job with no business scope at the start of each transaction. The tables' owner (the migrations' role) loads
// K-04's seeds. Each answer is checked against data-access v1.1 with Ajv 2020-12, strict, as contracts:check runs it.
//
// T-1542 (K-05 v1.23 item 84, defaults 216 to 224; T-1529's ruling card 4; DL-1185), the last three describe blocks:
// parkTurn in v1.23's form, the fixtures listed under parkTurn.lineExchange (never under parkTurn.exchange, so the first
// case's pin of park-turn.json stays), each answer checked against data-access v1.23, and what each park writes: the
// turn parked with its tries, K-37's row with default 220's summary, the one row planned and then checked at version 2
// with its plan and final parts, the entry; then the claim taking that row, where it still passes v1's unworded one.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import { listEventsForTurn } from "./event-log";
import { claimOutbox } from "./outbox";
import {
  PARKED_ERROR_SUMMARY,
  PASSED_ON_LINE,
  parkTurn,
  type ParkTurnOutcome,
  type ParkTurnRequest,
  type ParkTurnV1Request,
} from "./park";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };
const TURN = "turn-maya-0004";

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string };
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

interface IndexEntry {
  file: string;
  def?: string;
  version?: string;
  expect?: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const PARK = exchangeOf("park-turn.json");
/** A fresh copy of park-turn.json's request (v1's form). */
const parkRequest = (): ParkTurnV1Request => structuredClone(PARK.request) as unknown as ParkTurnV1Request;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

// ---- the contract's own schema (Ajv 2020-12, strict, as contracts:check runs it) -------------------------------------

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

function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V11_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.1 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

function answerErrors(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors(isError ? "parkTurn.errors" : "parkTurn.response", outcome);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

beforeAll(async () => {
  db = await createTestDatabase({ name: "park" });
  runtime = postgres(resolvePrimaryUrl(), {
    max: 10,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t197-park",
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

/** Empties every table, then loads these K-04 seeds, each after its own `after` chain, as the tables' owner. */
async function loadSeeds(seeds: readonly string[]): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const seen = new Set<string>();
  const rows = seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}

/** Empties every table, then loads park-turn.json's K-04 seeds (it runs no exchange first). */
async function given(): Promise<void> {
  expect(PARK.given.after).toEqual([]);
  await loadSeeds(PARK.given.k04Seeds);
}

const TABLES = ["turns", "parked_turns", "outbox_rows", "event_log"];

/** Each table the park writes: its rows' count (and versions where it has them). Equal before and after = nothing. */
async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)}`;
    out[table] = row?.n ?? -1;
  }
  return out;
}

interface ParkedRow {
  error_summary: string;
  person_told_at: Date | null;
  reply_due_at: Date;
  state: string;
  version: number;
}

async function parkedRow(turnId: string): Promise<ParkedRow | undefined> {
  const [row] = await db.sql<ParkedRow[]>`
    select error_summary, person_told_at, reply_due_at, state, version from parked_turns where turn_id = ${turnId}
  `;
  return row;
}

const iso = (date: Date | null | undefined): string | null =>
  date === null || date === undefined ? null : date.toISOString().replace(".000Z", "Z");

function parked(outcome: ParkTurnOutcome): Extract<ParkTurnOutcome, { result: "parked" }> {
  if (!("result" in outcome)) {
    throw new Error(`expected a park, got ${outcome.error}`);
  }
  return outcome;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("parkTurn: park-turn.json's request gives its response (K-05 v1 item 12)", () => {
  it("the index lists park-turn.json as the one parkTurn exchange, valid against data-access v1.1", () => {
    expect(INDEX.filter((entry) => entry.def === "parkTurn.exchange").map((entry) => entry.file)).toEqual([
      "park-turn.json",
    ]);
    expect(schemaErrors("parkTurn.exchange", PARK)).toEqual([]);
    expect(answerErrors(PARK.outcome)).toEqual([]);
  });

  it(
    "as rosie_job: the turn parked with tries 3, K-37's row, one 'nothing changed' row and its entry",
    SLOW,
    async () => {
      await given();
      const [who] = await runtime<{ who: string }[]>`select current_user as who`;
      expect(who?.who).toBe(RUNTIME_ROLE);
      const outcome = await parkTurn(runtime, parkRequest());
      expect(outcome).toEqual(PARK.outcome);
      expect(answerErrors(outcome)).toEqual([]);

      const [turn] = await db.sql<
        {
          state: string;
          tries: number;
          parked_at: Date | null;
          committed_at: Date | null;
          event_ids: string[];
        }[]
      >`select state, tries, parked_at, committed_at, event_ids from turns where id = ${TURN}`;
      expect([turn?.state, turn?.tries, iso(turn?.parked_at), turn?.committed_at, turn?.event_ids]).toEqual([
        "parked",
        3,
        "2026-11-07T15:20:00Z",
        null,
        ["evt-maya-0004"],
      ]);
      // K-37's row for Rosie's team: open, the fixed error, the reply due 1 business day on (Saturday to Monday).
      const row = await parkedRow(TURN);
      expect(row).toEqual({
        error_summary: PARKED_ERROR_SUMMARY,
        person_told_at: null,
        reply_due_at: new Date("2026-11-09T15:20:00Z"),
        state: "open",
        version: 1,
      });
      // The one "nothing changed" row, with no plan (the runtime never words it), under the turn's id and trace.
      const rows = await db.sql<
        {
          id: string;
          state: string;
          plan: unknown;
          send_class: string;
          trace_id: string;
          business_id: string;
        }[]
      >`select id, state, plan, send_class, trace_id, business_id from outbox_rows where turn_id = ${TURN}`;
      expect(rows).toEqual([
        {
          id: "out-maya-parked",
          state: "planned",
          plan: null,
          send_class: "quick_reply",
          trace_id: "trace-maya-0004",
          business_id: "biz-yoga-studio",
        },
      ]);
      const entries = await db.sql<
        { id: string; kind: string; at: Date; trace_id: string; job_id: string | null }[]
      >`
      select id, kind, at, trace_id, job_id from event_log where turn_id = ${TURN}
    `;
      expect(entries).toEqual([
        {
          id: "log-turn-maya-0004-parked",
          kind: "turn.parked",
          at: new Date("2026-11-07T15:20:00Z"),
          trace_id: "trace-maya-0004",
          job_id: null,
        },
      ]);
    },
  );

  it(
    "the error summary holds no value from the turn or the request, whatever the request carries",
    SLOW,
    async () => {
      await given();
      const request = parkRequest();
      const [entry] = request.events;
      if (entry === undefined) {
        throw new Error("park-turn.json carries an entry");
      }
      request.events = [
        {
          ...entry,
          why: { outage: "third crash before the commit: Maya wrote 'my card is 4111 1111 1111 1111'" },
          sealed: { forPersonId: "person-maya", base64: "c2VhbGVkIHdvcmRz" },
        },
      ];
      parked(await parkTurn(runtime, request));
      const summary = (await parkedRow(TURN))?.error_summary ?? "";
      expect(summary).toBe(PARKED_ERROR_SUMMARY);
      for (const value of [
        TURN,
        "evt-maya-0004",
        "trace-maya-0004",
        "handle-maya",
        "person-maya",
        "4111",
        "card",
      ]) {
        expect(summary).not.toContain(value);
      }
    },
  );
});

describe("parkTurn: once per turn id (K-05 item 12: a parked turn answers repeated, a committed one alreadyCommitted)", () => {
  it(
    "the same park sent again answers the first park, repeated, whatever its body, and writes nothing",
    SLOW,
    async () => {
      await given();
      parked(await parkTurn(runtime, parkRequest()));
      const before = await snapshot();
      const rerun = parkRequest();
      rerun.parkedAt = "2026-11-07T15:21:00Z";
      rerun.outboxRows = [];
      rerun.events = [];
      const outcome = await parkTurn(runtime, rerun);
      expect(outcome).toEqual({ ...PARK.outcome, repeated: true });
      expect(answerErrors(outcome)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(iso((await parkedRow(TURN))?.reply_due_at)).toBe("2026-11-09T15:20:00Z");
    },
  );

  it("20 parallel parks of one turn write one set of rows and all answer the same park", SLOW, async () => {
    await given();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => parkTurn(runtime, parkRequest())));
    const parks = outcomes.map(parked);
    expect(parks.filter((each) => !each.repeated)).toEqual([PARK.outcome]);
    for (const each of parks) {
      expect(each).toEqual({ ...PARK.outcome, repeated: each.repeated });
    }
    expect(await snapshot()).toEqual({ turns: 1, parked_turns: 1, outbox_rows: 1, event_log: 1 });
  });

  it("a committed turn answers alreadyCommitted and is never parked; nothing is written", SLOW, async () => {
    await given();
    const request = parkRequest();
    const commit: CommitTurnRequest = {
      turn: { ...request.turn, tries: 3 },
      versionsRead: [],
      writes: {
        state: [],
        openQuestions: { open: [], close: [] },
        clockRows: { make: [], cancel: [] },
        outboxRows: [],
        reservations: { confirm: [], release: [] },
        events: [],
      },
    };
    const committedAt = new Date("2026-11-07T15:19:58Z");
    expect(await commitTurn(runtime, commit, { now: committedAt })).toMatchObject({ result: "committed" });
    const before = await snapshot();
    const outcome = await parkTurn(runtime, request);
    expect(outcome).toEqual({ error: "alreadyCommitted", turnId: TURN, committedAt: "2026-11-07T15:19:58Z" });
    expect(answerErrors(outcome)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await parkedRow(TURN)).toBeUndefined();
  });
});

describe("parkTurn: all or nothing, and the team's reply due 1 business day on (K-37)", () => {
  it(
    "a write the database refuses rolls the whole park back and throws only codes and names",
    SLOW,
    async () => {
      await given();
      const request = parkRequest();
      const [row] = request.outboxRows;
      if (row === undefined) {
        throw new Error("park-turn.json writes a row");
      }
      request.outboxRows = [{ ...row, recipientHandleId: "handle-unknown" }];
      const before = await snapshot();
      const failure = await parkTurn(runtime, request).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DataAccessDatabaseError);
      const refused = failure as DataAccessDatabaseError;
      expect([refused.code, refused.table, refused.constraint]).toEqual([
        "23503",
        "outbox_rows",
        "outbox_rows_handle_fk",
      ]);
      expect(refused.message).not.toContain("handle-unknown");
      expect(await snapshot()).toEqual(before);
    },
  );

  it(
    "the reply is due the next weekday at the same New York time: Friday to Monday, a weekday to the next",
    SLOW,
    async () => {
      const cases = [
        { turn: "turn-park-friday", parkedAt: "2026-11-06T22:30:00Z", due: "2026-11-09T22:30:00Z" },
        { turn: "turn-park-sunday", parkedAt: "2026-11-08T12:00:00Z", due: "2026-11-09T12:00:00Z" },
        // Monday 22:00 in New York (Tuesday in UTC) is due Tuesday 22:00 there.
        { turn: "turn-park-monday-night", parkedAt: "2026-11-10T03:00:00Z", due: "2026-11-11T03:00:00Z" },
        // Across the end of daylight time (Sunday Nov 1 2026): Friday 9:00 EDT is due Monday 9:00 EST.
        { turn: "turn-park-dst", parkedAt: "2026-10-30T13:00:00Z", due: "2026-11-02T14:00:00Z" },
      ];
      await given();
      for (const each of cases) {
        const request = parkRequest();
        request.turn.id = each.turn;
        request.parkedAt = each.parkedAt;
        request.outboxRows = [];
        request.events = [];
        parked(await parkTurn(runtime, request));
        expect(iso((await parkedRow(each.turn))?.reply_due_at), each.turn).toBe(each.due);
      }
    },
  );

  it("a request it cannot carry out is thrown before anything is read", async () => {
    const notThird = parkRequest();
    (notThird.turn as { tries: number }).tries = 2;
    await expect(parkTurn(runtime, notThird)).rejects.toThrow(TypeError);
    const twoRows = parkRequest();
    const [row] = twoRows.outboxRows;
    if (row === undefined) {
      throw new Error("park-turn.json writes a row");
    }
    // Two rows, which the schema's maxItems 1 (and so its type) refuses: the call refuses them too.
    twoRows.outboxRows = [row, { ...row, id: "out-maya-parked-2" }] as unknown as typeof twoRows.outboxRows;
    await expect(parkTurn(runtime, twoRows)).rejects.toThrow(TypeError);
    const planned = parkRequest();
    planned.outboxRows = [{ ...row, plan: {} } as unknown as (typeof planned.outboxRows)[number]];
    await expect(parkTurn(runtime, planned)).rejects.toThrow(TypeError);
  });
});

// ==== T-1542: K-05 v1.23's form (item 84; defaults 216 to 224; T-1529's ruling card 4) ===============================

const V123_ID = (readJson(new URL("data-access/data-access.v1.23.schema.json", CONTRACTS)) as { $id: string })
  .$id;

function schemaErrors123(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V123_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.23 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

function answerErrors123(outcome: unknown): string[] {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  return schemaErrors123(isError ? "parkTurn.errors" : "parkTurn.response", outcome);
}

/** v1.23's park fixtures: the ones listed under parkTurn.lineExchange, which no v1 loop selects (line 196's pin). */
const LINE = INDEX.filter((entry) => entry.def === "parkTurn.lineExchange");
const LINE_ACCEPTED = LINE.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
const LINE_REFUSED = LINE.filter((entry) => entry.expect === "refuse").map((entry) => entry.file);
const SAM_FILE = "park-turn-sam-refused-at-once.json";
const SAM_REPEAT_FILE = "park-turn-sam-refused-repeat.json";
const MAYA_FILE = "park-turn-maya-crash-with-line.json";
const SAM_TURN = "turn-sam-refused-1";
const MAYA_TURN = "turn-maya-0005";

/** A fresh copy of a fixture's request, in whatever form it takes. */
const requestOf = (file: string): ParkTurnRequest =>
  structuredClone(exchangeOf(file).request) as unknown as ParkTurnRequest;

/**
 * An exchange's given: its K-04 seeds, then each exchange its `after` names, sent as it is and answering its own
 * outcome (the v1.23 fixtures' chain is one park deep, on the same seeds).
 */
async function givenOf(exchange: Exchange): Promise<void> {
  await loadSeeds(exchange.given.k04Seeds);
  for (const file of exchange.given.after) {
    const before = exchangeOf(file);
    expect([before.call, before.given.k04Seeds, before.given.after], file).toEqual([
      "parkTurn",
      exchange.given.k04Seeds,
      [],
    ]);
    expect(await parkTurn(runtime, requestOf(file)), file).toEqual(before.outcome);
  }
}

const EVERY_TABLE = [
  ...TABLES,
  "outbox_parts",
  "outbox_claims",
  "openers_sent",
  "open_questions",
  "clock_rows",
  "effects",
];

/** Every table a park could touch, and the rows near it: equal before and after = nothing written. */
async function everything(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const table of EVERY_TABLE) {
    out[table] = await db.sql`select * from ${db.sql(table)} order by 1`;
  }
  return out;
}

/** The fixture request's one row, as v1.23 writes it (parkedRowNew). */
function lineRowOf(request: ParkTurnRequest): Record<string, Json> {
  const [row] = request.outboxRows;
  if (row === undefined || !("plan" in row)) {
    throw new Error("a v1.23 request writes one row with its plan");
  }
  return row as unknown as Record<string, Json>;
}

/** The one row of a v1.23 park as stored: checked at version 2, the request's plan and final parts, the line alone. */
async function expectLineRow(request: ParkTurnRequest): Promise<void> {
  const row = lineRowOf(request);
  const { turn } = request;
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select id, turn_id, job_id, state, version, plan, final_parts, recipient_handle_id, recipient_person_id,
           business_id, booking_id, open_question_id, copy_of_row_id, channel, send_class, versions_read, trace_id,
           bundle_hash, bundle_build, step, line_no, held_until
    from outbox_rows where turn_id = ${turn.id}
  `;
  expect(stored).toEqual({
    id: row.id,
    turn_id: turn.id,
    job_id: null,
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
    trace_id: turn.traceId,
    bundle_hash: turn.bundleId.hash,
    bundle_build: turn.bundleId.build,
    step: null,
    line_no: null,
    held_until: null,
  });
  const parts =
    (stored?.final_parts as { sends: { text: string }[]; fixedLines: string[] } | undefined) ?? null;
  expect([parts?.sends.map((send) => send.text), parts?.fixedLines]).toEqual([
    [PASSED_ON_LINE],
    ["passedOn"],
  ]);
}

/** The turns row a park wrote: parked with its tries, never committed. */
async function expectParkedTurn(request: ParkTurnRequest): Promise<void> {
  const { turn } = request;
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select handle_id, event_ids, state, tries, parked_at, committed_at, trace_id, joined_trace_ids
    from turns where id = ${turn.id}
  `;
  expect(stored).toEqual({
    handle_id: turn.handleId,
    event_ids: turn.eventIds,
    state: "parked",
    tries: turn.tries,
    parked_at: new Date(request.parkedAt),
    committed_at: null,
    trace_id: turn.traceId,
    joined_trace_ids: turn.joinedTraceIds,
  });
}

/** The request's one entry, written as given under the turn's id, trace and bundle, at parkedAt; nothing sealed. */
async function expectEntry(request: ParkTurnRequest, why: Record<string, Json>): Promise<void> {
  const { turn } = request;
  const [entry] = request.events;
  if (entry === undefined) {
    throw new Error("a v1.23 fixture writes one entry");
  }
  expect(entry.why).toEqual(why);
  expect(await listEventsForTurn(db.sql, turn.id)).toEqual([
    {
      id: entry.id,
      at: new Date(request.parkedAt),
      zone: null,
      turnId: turn.id,
      jobId: null,
      traceId: turn.traceId,
      bundle: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      businessId: entry.businessId,
      actorKind: "rosie",
      actorPersonId: null,
      actorRole: null,
      kind: "turn.parked",
      tableName: "turns",
      rowId: turn.id,
      oldValues: null,
      newValues: { state: "parked", tries: turn.tries },
      sealedValues: null,
      sealedForPersonId: null,
      why,
      approvedBy: null,
      proofs: null,
    },
  ]);
}

describe("parkTurn in K-05 v1.23's form: each v1.23 fixture gives its answer and its rows (T-1542; item 84)", () => {
  it("v1.23's park fixtures are listed under parkTurn.lineExchange alone, each valid or refused at v1.23", () => {
    expect(LINE_ACCEPTED).toEqual(expect.arrayContaining([SAM_FILE, SAM_REPEAT_FILE, MAYA_FILE]));
    expect(LINE_REFUSED).toHaveLength(3);
    for (const file of LINE_ACCEPTED) {
      const exchange = exchangeOf(file);
      expect(schemaErrors123("parkTurn.lineExchange", exchange), file).toEqual([]);
      expect(answerErrors123(exchange.outcome), file).toEqual([]);
      // v1.1's parkTurn.exchange never takes one: v1.23's request is no v1 request.
      expect(schemaErrors("parkTurn.exchange", exchange), file).not.toEqual([]);
    }
    for (const file of LINE_REFUSED) {
      expect(schemaErrors123("parkTurn.lineExchange", exchangeOf(file)), file).not.toEqual([]);
    }
    expect(
      LINE.filter((entry) =>
        INDEX.some((other) => other.file === entry.file && other.def === "parkTurn.exchange"),
      ),
    ).toEqual([]);
  });

  for (const file of LINE_ACCEPTED) {
    it(
      `${file}: as rosie_job, after its given, the park answers its outcome, valid at v1.23`,
      SLOW,
      async () => {
        const exchange = exchangeOf(file);
        await givenOf(exchange);
        const outcome = await parkTurn(runtime, requestOf(file));
        expect(outcome).toEqual(exchange.outcome);
        expect(answerErrors123(outcome)).toEqual([]);
      },
    );
  }

  it(
    "Sam refused at once on try 1: the turn parked with tries 1, K-37's row with default 220's summary, the row " +
      "checked at version 2 with its plan and final parts, one entry with the labels; nothing else",
    SLOW,
    async () => {
      const exchange = exchangeOf(SAM_FILE);
      await givenOf(exchange);
      const phonesBefore = await db.sql`select * from phones order by 1`;
      const request = requestOf(SAM_FILE);
      expect(await parkTurn(runtime, request)).toEqual(exchange.outcome);
      await expectParkedTurn(request);
      expect(await parkedRow(SAM_TURN)).toEqual({
        error_summary: "Refused as final (walk: stepNotInBundle; S1-04) on try 1 of 3; nothing was committed",
        person_told_at: null,
        // Sunday 10:00 in New York is due Monday 10:00 there.
        reply_due_at: new Date("2026-11-23T15:00:05Z"),
        state: "open",
        version: 1,
      });
      await expectLineRow(request);
      await expectEntry(request, { refused: { from: "walk", fault: "stepNotInBundle", ids: ["S1-04"] } });
      // No part, claim, opener mark or opt-out time, no question or clock: the row carries the line alone.
      const all = await everything();
      expect(
        ["outbox_parts", "outbox_claims", "openers_sent", "open_questions", "clock_rows", "effects"].map(
          (table) => [table, (all[table] as unknown[]).length],
        ),
      ).toEqual([
        ["outbox_parts", 0],
        ["outbox_claims", 0],
        ["openers_sent", 0],
        ["open_questions", 0],
        ["clock_rows", 0],
        ["effects", 0],
      ]);
      // No opt-out time on Sam's phone (markPart's, at a delivery: default 203): the phones rows are as seeded.
      expect(await db.sql`select * from phones order by 1`).toEqual(phonesBefore);
      expect(await snapshot()).toEqual({ turns: 1, parked_turns: 1, outbox_rows: 1, event_log: 1 });
    },
  );

  it(
    "the same park sent again (park-turn-sam-refused-repeat) answers the first park, repeated, and writes nothing",
    SLOW,
    async () => {
      const exchange = exchangeOf(SAM_REPEAT_FILE);
      await givenOf(exchange);
      const before = await everything();
      const outcome = await parkTurn(runtime, requestOf(SAM_REPEAT_FILE));
      expect(outcome).toEqual(exchange.outcome);
      expect(outcome).toMatchObject({ parkedAt: "2026-11-22T15:00:05Z", repeated: true });
      expect(await everything()).toEqual(before);
      await expectLineRow(requestOf(SAM_FILE));
    },
  );

  it(
    "Maya's third crash with the line: tries 3, the fixed crash summary, the row checked at version 2, v1's outage " +
      "path in the entry",
    SLOW,
    async () => {
      const exchange = exchangeOf(MAYA_FILE);
      await givenOf(exchange);
      const request = requestOf(MAYA_FILE);
      expect(await parkTurn(runtime, request)).toEqual(exchange.outcome);
      expect("reason" in request).toBe(false);
      await expectParkedTurn(request);
      expect(await parkedRow(MAYA_TURN)).toEqual({
        error_summary: PARKED_ERROR_SUMMARY,
        person_told_at: null,
        reply_due_at: new Date("2026-11-23T16:20:00Z"),
        state: "open",
        version: 1,
      });
      await expectLineRow(request);
      await expectEntry(request, { outage: "third crash before the commit" });
    },
  );

  it(
    "each refused v1.23 fixture's request is thrown before any statement, and nothing is written",
    SLOW,
    async () => {
      await givenOf(exchangeOf(SAM_FILE));
      const before = await everything();
      for (const file of LINE_REFUSED) {
        await expect(parkTurn(runtime, requestOf(file)), file).rejects.toThrow(TypeError);
      }
      expect(await everything()).toEqual(before);
    },
  );
});

describe("parkTurn in K-05 v1.23's form: the claim takes the line's row; v1's unworded row is still passed (default 183)", () => {
  const claimFor = (handle: string, now: string) => ({
    claimer: "dispatcher-1",
    recipientHandleId: handle,
    now,
    limit: 10,
  });

  it(
    "after Sam's park, his claim and the sweep take the row, checked to sending at version 3, the line its one part",
    SLOW,
    async () => {
      for (const request of [
        claimFor("handle-sam", "2026-11-22T15:00:06Z"),
        { claimer: "dispatcher-1", now: "2026-11-22T15:00:06Z", limit: 10 },
      ]) {
        const exchange = exchangeOf(SAM_FILE);
        await givenOf(exchange);
        parked(await parkTurn(runtime, requestOf(SAM_FILE)));
        const answer = await claimOutbox(runtime, request);
        if (!("claimed" in answer)) {
          throw new Error(`the claim answered ${answer.error}`);
        }
        expect(
          answer.claimed.map((row) => [
            row.outboxRowId,
            row.version,
            row.commitSeq,
            row.recipientHandleId,
            row.sendClass,
            row.finalParts.sends.map((send) => send.text),
            row.parts.length,
          ]),
          JSON.stringify(request),
        ).toEqual([
          ["out-turn-sam-refused-1-parked", 3, 1, "handle-sam", "quick_reply", [PASSED_ON_LINE], 1],
        ]);
        const [row] = await db.sql<{ state: string; version: number }[]>`
          select state, version from outbox_rows where id = 'out-turn-sam-refused-1-parked'
        `;
        expect(row).toEqual({ state: "sending", version: 3 });
      }
    },
  );

  it("after Maya's crash park with the line, her claim takes the row as well", SLOW, async () => {
    await givenOf(exchangeOf(MAYA_FILE));
    parked(await parkTurn(runtime, requestOf(MAYA_FILE)));
    const answer = await claimOutbox(runtime, claimFor("handle-maya", "2026-11-22T16:20:01Z"));
    expect(
      "claimed" in answer ? answer.claimed.map((row) => [row.outboxRowId, row.version]) : answer,
    ).toEqual([["out-turn-maya-0005-parked", 3]]);
  });

  it("after v1's park, the claim and the sweep still pass its unworded row, untouched", SLOW, async () => {
    await given();
    parked(await parkTurn(runtime, parkRequest()));
    const before = await everything();
    for (const request of [
      claimFor("handle-maya", "2026-11-07T15:20:01Z"),
      { claimer: "dispatcher-1", now: "2026-11-07T15:20:01Z", limit: 10 },
    ]) {
      expect(await claimOutbox(runtime, request), JSON.stringify(request)).toEqual({
        result: "claimed",
        claimed: [],
        passedHeld: [],
      });
    }
    expect(await everything()).toEqual(before);
    const [row] = await db.sql<{ state: string; version: number; unplanned: boolean }[]>`
      select state, version, plan is null and final_parts is null as unplanned from outbox_rows where id = 'out-maya-parked'
    `;
    expect(row).toEqual({ state: "planned", version: 1, unplanned: true });
  });
});

describe("parkTurn in K-05 v1.23's form: once per turn id, whatever the form, and all or nothing (defaults 221, 223)", () => {
  it("20 parallel parks of Sam's turn write one set of rows and all answer the same park", SLOW, async () => {
    const exchange = exchangeOf(SAM_FILE);
    await givenOf(exchange);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => parkTurn(runtime, requestOf(SAM_FILE))),
    );
    const parks = outcomes.map(parked);
    expect(parks.filter((each) => !each.repeated)).toEqual([exchange.outcome]);
    for (const each of parks) {
      expect(each).toEqual({ ...exchange.outcome, repeated: each.repeated });
    }
    expect(await snapshot()).toEqual({ turns: 1, parked_turns: 1, outbox_rows: 1, event_log: 1 });
    await expectLineRow(requestOf(SAM_FILE));
  });

  it(
    "a park first written in v1's form and sent again in v1.23's answers the first; the line is never added after",
    SLOW,
    async () => {
      await given();
      parked(await parkTurn(runtime, parkRequest()));
      const before = await everything();
      const again = requestOf(MAYA_FILE);
      again.turn.id = TURN;
      const outcome = await parkTurn(runtime, again);
      expect(outcome).toEqual({ ...PARK.outcome, repeated: true });
      expect(await everything()).toEqual(before);
      expect(await parkedRow(TURN)).toMatchObject({ error_summary: PARKED_ERROR_SUMMARY });
    },
  );

  it(
    "a park first written in v1.23's form and sent again in v1's answers the first, its line kept",
    SLOW,
    async () => {
      const exchange = exchangeOf(SAM_FILE);
      await givenOf(exchange);
      parked(await parkTurn(runtime, requestOf(SAM_FILE)));
      const before = await everything();
      const again = parkRequest();
      again.turn = { ...again.turn, id: SAM_TURN, handleId: "handle-sam" };
      again.outboxRows = [];
      expect(await parkTurn(runtime, again)).toEqual({ ...exchange.outcome, repeated: true });
      expect(await everything()).toEqual(before);
      await expectLineRow(requestOf(SAM_FILE));
    },
  );

  it("a committed turn answers alreadyCommitted in v1.23's form too; nothing is written", SLOW, async () => {
    await givenOf(exchangeOf(SAM_FILE));
    const request = requestOf(SAM_FILE);
    const commit: CommitTurnRequest = {
      turn: { ...request.turn, tries: 1 },
      versionsRead: [],
      writes: {
        state: [],
        openQuestions: { open: [], close: [] },
        clockRows: { make: [], cancel: [] },
        outboxRows: [],
        reservations: { confirm: [], release: [] },
        events: [],
      },
    };
    expect(await commitTurn(runtime, commit, { now: new Date("2026-11-22T15:00:03Z") })).toMatchObject({
      result: "committed",
    });
    const before = await everything();
    const outcome = await parkTurn(runtime, request);
    expect(outcome).toEqual({
      error: "alreadyCommitted",
      turnId: SAM_TURN,
      committedAt: "2026-11-22T15:00:03Z",
    });
    expect(answerErrors123(outcome)).toEqual([]);
    expect(await everything()).toEqual(before);
    expect(await parkedRow(SAM_TURN)).toBeUndefined();
  });

  it(
    "a write the database refuses after the turn and the team's row rolls the whole v1.23 park back, codes only",
    SLOW,
    async () => {
      await givenOf(exchangeOf(SAM_FILE));
      parked(await parkTurn(runtime, requestOf(SAM_FILE)));
      const before = await everything();
      // Maya's crash park whose row takes Sam's row's id, already taken: refused at the row's insert.
      const taken = requestOf(MAYA_FILE);
      const row = lineRowOf(taken);
      row.id = "out-turn-sam-refused-1-parked";
      (row.plan as Record<string, Json>).row = row.id;
      (row.finalParts as Record<string, Json>).row = row.id;
      const failure = await parkTurn(runtime, taken).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DataAccessDatabaseError);
      const refused = failure as DataAccessDatabaseError;
      expect([refused.code, refused.table, refused.constraint]).toEqual([
        "23505",
        "outbox_rows",
        "outbox_rows_pkey",
      ]);
      expect(refused.message).not.toContain("out-turn-sam-refused-1-parked");
      expect(await everything()).toEqual(before);
      expect(await parkedRow(MAYA_TURN)).toBeUndefined();
    },
  );
});
