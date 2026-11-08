// T-197: K-05 v1's parkTurn (README item 12; arch 11 line 576; K-37 v1 parked_turns) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/park`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts); the public schema is never touched.
//
// Every park runs as K-05 states it (README "Scope": runtime; T-191's roles): through a client whose connections run as
// rosie_job with no business scope at the start of each transaction. The tables' owner (the migrations' role) loads
// K-04's seeds. Each answer is checked against data-access v1.1 with Ajv 2020-12, strict, as contracts:check runs it.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import { commitTurn, type CommitTurnRequest } from "./commit-turn";
import { PARKED_ERROR_SUMMARY, parkTurn, type ParkTurnOutcome, type ParkTurnRequest } from "./park";
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
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const PARK = exchangeOf("park-turn.json");
/** A fresh copy of park-turn.json's request. */
const parkRequest = (): ParkTurnRequest => structuredClone(PARK.request) as unknown as ParkTurnRequest;
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

/** Empties every table, then loads park-turn.json's K-04 seeds (it runs no exchange first). */
async function given(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  expect(PARK.given.after).toEqual([]);
  const seen = new Set<string>();
  const rows = PARK.given.k04Seeds.flatMap((seed) => seedRows(seed, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
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
