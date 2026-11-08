// T-188: turns, open questions and clock rows against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/turns`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const OWN_TABLES = ["turns", "open_questions", "clock_rows"] as const;
const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
  refused?: {
    action: string;
    table: string;
    values: Record<string, Json>;
    expect: { sqlstate: string; constraintOneOf: string[] };
  };
}

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  foreignKeys?: { name: string }[];
  unique?: { name: string; columns: string[] }[];
  indexes?: { name: string; columns: string[]; where?: string }[];
  versioned: boolean;
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));
}

function fixture(file: string): FixtureFile {
  return readJson(`fixtures/${file}`) as FixtureFile;
}

/** The rows of a fixture and of the fixtures it names in `after`, in load order. */
function fixtureRows(file: string, seen = new Set<string>()): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const loaded = fixture(file);
  return [...loaded.after.flatMap((before) => fixtureRows(before, seen)), ...loaded.rows];
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** Loads a fixture and its `after` chain as the fixture has it, returning the row count per table. */
async function loadFixture(sql: Sql, file: string): Promise<Record<string, number>> {
  const jsonbColumns = new Set(
    (
      await sql<{ table: string; column: string }[]>`
        select table_name as table, column_name as column from information_schema.columns
        where table_schema = current_schema() and data_type = 'jsonb'
      `
    ).map((row) => `${row.table}.${row.column}`),
  );
  const loaded: Record<string, number> = {};
  for (const row of fixtureRows(file)) {
    await insertRow(sql, row.table, row.values, jsonbColumns);
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return loaded;
}

async function insertRow(
  sql: Sql,
  table: string,
  rowValues: Record<string, Json>,
  jsonbColumns: Set<string>,
): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(rowValues)) {
    let converted: unknown = value;
    if (jsonbColumns.has(`${table}.${column}`) && value !== null) {
      converted = sql.json(value);
    } else if (table === "bundle_values" && column === "value" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

// Truncating the first tables cascades to everything that refers to them. Each test file runs in its own schema
// (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate clock_rows, open_questions, turns, pauses, phones, person_handles, handles, bookings, person_roles, sealing_keys, persons, businesses, bundle_values, bundles cascade`;
}

/** What the database says about a failed statement: its SQLSTATE and the constraint it names. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string };
    return { code: failure.code, constraint: failure.constraint_name };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "turns" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    "text[]": "ARRAY",
    integer: "integer",
    jsonb: "jsonb",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the three tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["clock_rows", "open_questions", "turns"]);
  });

  for (const table of tables) {
    it(`${table.name}: columns, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
        select column_name as name, data_type as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
        expect(actual?.nullable === "YES", `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === undefined) {
          expect(actual?.default, `${table.name}.${column.name} default`).toBeNull();
        } else {
          expect((actual?.default ?? "").replace(/::.*$/, ""), `${table.name}.${column.name} default`).toBe(
            column.default,
          );
        }
      }
    });

    it(`${table.name}: primary key, checks, foreign keys, unique rules and indexes are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      const pk = constraints.find((constraint) => constraint.kind === "p");
      expect(pk?.definition).toBe(`PRIMARY KEY (${(table.primaryKey ?? []).join(", ")})`);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual((table.foreignKeys ?? []).map((key) => key.name).sort());
      expect(named("u")).toEqual((table.unique ?? []).map((rule) => rule.name).sort());

      const indexes = await db.sql<{ name: string; definition: string }[]>`
        select indexname as name, indexdef as definition from pg_indexes
        where schemaname = ${db.schema} and tablename = ${table.name}
      `;
      const expected = [
        `${table.name}_pkey`,
        ...(table.unique ?? []).map((rule) => rule.name),
        ...(table.indexes ?? []).map((index) => index.name),
      ].sort();
      expect(indexes.map((index) => index.name).sort()).toEqual(expected);
      for (const wanted of table.indexes ?? []) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
        expect(index?.definition.includes("WHERE"), `${wanted.name} partial`).toBe(
          wanted.where !== undefined,
        );
      }
    });

    it(`${table.name}: foreign keys refuse deletes, and the version trigger exists exactly when versioned`, async () => {
      const keys = await db.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass and contype = 'f'
      `;
      for (const key of keys) {
        expect(key.definition, key.name).toContain("ON DELETE RESTRICT");
      }
      const triggers = await db.sql<{ name: string }[]>`
        select tgname as name from pg_trigger
        where tgrelid = ${`${db.schema}.${table.name}`}::regclass and not tgisinternal
      `;
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        table.versioned ? [`${table.name}_version_raised`] : [],
      );
    });
  }

  it("is expand only: plain tables; row-level security per business on open_questions and clock_rows, none on turns (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('turns', 'open_questions', 'clock_rows')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["clock_rows", "r", true],
      ["open_questions", "r", true],
      ["turns", "r", false],
    ]);
  });

  it("pauses_turn_fk was added by this migration, on pauses (set_by_turn_id) to turns (id), refusing deletes", async () => {
    const rows = await db.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${`${db.schema}.pauses`}::regclass and conname = 'pauses_turn_fk'
    `;
    expect(rows.map((row) => row.definition)).toEqual([
      "FOREIGN KEY (set_by_turn_id) REFERENCES turns(id) ON DELETE RESTRICT",
    ]);
  });
});

describe("fixtures seed-turn, seed-open-question and seed-clock-row", () => {
  it("seed-turn loads with its after chain: one committed turn on the registered bundle", async () => {
    await emptyTables(db.sql);
    const loaded = await loadFixture(db.sql, "seed-turn.json");
    expect(loaded.turns).toBe(1);
    const rows = await db.sql<
      {
        id: string;
        handle_id: string;
        state: string;
        bundle_hash: string;
        bundle_build: number;
        version: number;
      }[]
    >`select id, handle_id, state, bundle_hash, bundle_build, version from turns`;
    expect(rows).toEqual([
      {
        id: "turn-alex-move-1",
        handle_id: "handle-alex",
        state: "committed",
        bundle_hash: HASH,
        bundle_build: 1,
        version: 2,
      },
    ]);
    const turn = await db.sql<{ event_ids: string[]; joined: string[]; tries: number }[]>`
      select event_ids, joined_trace_ids as joined, tries from turns`;
    expect(turn).toEqual([{ event_ids: ["evt-alex-0007"], joined: [], tries: 1 }]);
  });

  it("seed-open-question loads: A7-03, booking v7, a 24 hour clock, asked once, open", async () => {
    await emptyTables(db.sql);
    const loaded = await loadFixture(db.sql, "seed-open-question.json");
    expect(loaded.open_questions).toBe(1);
    const rows = await db.sql<
      {
        step: string;
        status: string;
        clock: string | null;
        ask_count: number;
        options: { id: string; label: string }[];
        versions_read: { table: string; rowId: string; version: number }[];
        turn_id: string;
        bundle_hash: string;
      }[]
    >`select step, status, clock, ask_count, options, versions_read, turn_id, bundle_hash from open_questions`;
    expect(rows).toEqual([
      {
        step: "A7-03",
        status: "open",
        clock: "24 h",
        ask_count: 1,
        options: [
          { id: "A7-03/1", label: "Sat 12:00pm" },
          { id: "A7-03/2", label: "Sat 2:00pm" },
          { id: "A7-03/3", label: "Sat 3:30pm" },
        ],
        versions_read: [{ table: "bookings", rowId: "booking-alex-haircut", version: 7 }],
        turn_id: "turn-alex-move-1",
        bundle_hash: HASH,
      },
    ]);
  });

  it("seed-clock-row loads: a question's clock owned by a handle, and a monthly billing job no handle owns", async () => {
    await emptyTables(db.sql);
    const loaded = await loadFixture(db.sql, "seed-clock-row.json");
    expect(loaded.clock_rows).toBe(2);
    const rows = await db.sql<
      { id: string; kind: string; handle_id: string | null; state: string; due_zone: string | null }[]
    >`select id, kind, handle_id, state, due_zone from clock_rows order by id`;
    expect(rows).toEqual([
      {
        id: "clock-monthly-billing-2026-12",
        kind: "job",
        handle_id: null,
        state: "armed",
        due_zone: "America/New_York",
      },
      {
        id: "clock-oq-a7-03-alex",
        kind: "question",
        handle_id: "handle-alex",
        state: "armed",
        due_zone: "America/New_York",
      },
    ]);
  });

  it("refuse-duplicate-turn-id is refused: the turn id is unique", async () => {
    await emptyTables(db.sql);
    const refusedFixture = fixture("invalid/refuse-duplicate-turn-id.json");
    await loadFixture(db.sql, "invalid/refuse-duplicate-turn-id.json");
    const refused = refusedFixture.refused;
    if (refused === undefined) {
      throw new Error("the fixture names no refused statement");
    }
    expect(refused.table).toBe("turns");
    const failure = await refusal(insertRow(db.sql, refused.table, refused.values, new Set()));
    expect(failure.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(failure.constraint);
    expect(await db.sql`select id from turns`).toHaveLength(1);
  });
});

describe("what the database refuses", () => {
  async function seedTurn(): Promise<void> {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-open-question.json");
  }

  const turnInsert = (id: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const row = {
      id,
      handle_id: "handle-alex",
      event_ids: ["evt-x"],
      state: "committed",
      bundle_hash: HASH,
      bundle_build: 1,
      trace_id: "trace-x",
      committed_at: new Date("2026-11-07T10:00:00Z"),
      ...extra,
    };
    return db.sql`insert into turns ${db.sql(row as never)}`;
  };

  const questionInsert = (id: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const row = {
      id,
      turn_id: "turn-alex-move-1",
      handle_id: "handle-alex",
      step: "A7-03",
      options: db.sql.json([]),
      versions_read: db.sql.json([]),
      bundle_hash: HASH,
      bundle_build: 1,
      ...extra,
    };
    return db.sql`insert into open_questions ${db.sql(row as never)}`;
  };

  it("an open question's status accepts waiting, open, answered, defaulted and withdrawn only", async () => {
    await seedTurn();
    const closedAt = new Date("2026-11-07T11:00:00Z");
    await questionInsert("oq-waiting");
    await questionInsert("oq-open", { status: "open" });
    await questionInsert("oq-answered", {
      status: "answered",
      closed_at: closedAt,
      answered_option_id: "A7-03/1",
    });
    await questionInsert("oq-defaulted", { status: "defaulted", closed_at: closedAt });
    await questionInsert("oq-withdrawn", { status: "withdrawn", closed_at: closedAt });
    const statuses = await db.sql<{ status: string }[]>`
      select status from open_questions where id like 'oq-%' and id <> 'oq-a7-03-alex' order by id`;
    expect(statuses.map((row) => row.status)).toEqual([
      "answered",
      "defaulted",
      "open",
      "waiting",
      "withdrawn",
    ]);
    expect(await refusal(questionInsert("oq-bad-status", { status: "closed" }))).toEqual({
      code: "23514",
      constraint: "open_questions_status_known",
    });
    expect(await refusal(questionInsert("oq-bad-status-2", { status: "OPEN" }))).toEqual({
      code: "23514",
      constraint: "open_questions_status_known",
    });
  });

  it("an open question refuses a bad step, a non-array options, a closed row with no time and an answer when not answered", async () => {
    await seedTurn();
    expect(await refusal(questionInsert("oq-b1", { step: "A7-3" }))).toEqual({
      code: "23514",
      constraint: "open_questions_step_form",
    });
    expect(await refusal(questionInsert("oq-b2", { options: db.sql.json({}) }))).toEqual({
      code: "23514",
      constraint: "open_questions_options_list",
    });
    expect(await refusal(questionInsert("oq-b3", { versions_read: db.sql.json({}) }))).toEqual({
      code: "23514",
      constraint: "open_questions_versions_list",
    });
    expect(await refusal(questionInsert("oq-b4", { ask_count: 0 }))).toEqual({
      code: "23514",
      constraint: "open_questions_ask_count",
    });
    expect(await refusal(questionInsert("oq-b5", { status: "answered" }))).toEqual({
      code: "23514",
      constraint: "open_questions_closed_has_time",
    });
    expect(await refusal(questionInsert("oq-b6", { status: "open", answered_option_id: "A7-03/1" }))).toEqual(
      {
        code: "23514",
        constraint: "open_questions_answer_only_when_answered",
      },
    );
  });

  it("an open question and a turn refuse a bundle id that is not registered", async () => {
    await seedTurn();
    expect(await refusal(questionInsert("oq-b7", { bundle_build: 9 }))).toEqual({
      code: "23503",
      constraint: "open_questions_bundle_fk",
    });
    expect(await refusal(turnInsert("turn-b1", { bundle_build: 9 }))).toEqual({
      code: "23503",
      constraint: "turns_bundle_fk",
    });
    expect(await refusal(questionInsert("oq-b8", { turn_id: "turn-missing" }))).toEqual({
      code: "23503",
      constraint: "open_questions_turn_fk",
    });
  });

  it("a turn refuses a bad state, no events, a lease that is missing and a state with the wrong time", async () => {
    await seedTurn();
    expect(await refusal(turnInsert("turn-c1", { state: "done", committed_at: null }))).toEqual({
      code: "23514",
      constraint: "turns_state_known",
    });
    expect(await refusal(turnInsert("turn-c2", { event_ids: [] }))).toEqual({
      code: "23514",
      constraint: "turns_has_events",
    });
    expect(await refusal(turnInsert("turn-c3", { state: "leased", committed_at: null }))).toEqual({
      code: "23514",
      constraint: "turns_leased_has_lease",
    });
    expect(await refusal(turnInsert("turn-c4", { committed_at: null }))).toEqual({
      code: "23514",
      constraint: "turns_committed_has_time",
    });
    expect(await refusal(turnInsert("turn-c5", { state: "parked", committed_at: null }))).toEqual({
      code: "23514",
      constraint: "turns_parked_has_time",
    });
    expect(await refusal(turnInsert("turn-c6", { tries: 4 }))).toEqual({
      code: "23514",
      constraint: "turns_tries_range",
    });
    await turnInsert("turn-leased", {
      state: "leased",
      committed_at: null,
      lease_until: new Date("2026-11-07T10:01:00Z"),
    });
    await turnInsert("turn-parked", {
      state: "parked",
      committed_at: null,
      parked_at: new Date("2026-11-07T10:05:00Z"),
      tries: 3,
    });
  });

  it("a turn refuses an unknown handle", async () => {
    await seedTurn();
    expect(await refusal(turnInsert("turn-d1", { handle_id: "handle-nobody" }))).toEqual({
      code: "23503",
      constraint: "turns_handle_fk",
    });
  });

  it("a turn's version can only be raised by one, as every versioned table's", async () => {
    await seedTurn();
    const failure = await refusal(
      db.sql`update turns set version = version + 2 where id = 'turn-alex-move-1'`,
    );
    expect(failure.code).toBeDefined();
    await db.sql`update turns set tries = 2, version = version + 1 where id = 'turn-alex-move-1'`;
    const rows = await db.sql<{ version: number }[]>`select version from turns where id = 'turn-alex-move-1'`;
    expect(rows).toEqual([{ version: 3 }]);
  });

  it("a clock row refuses a bad kind or state, an armed row with no due time, and a row that names nothing it needs", async () => {
    await seedTurn();
    const clockInsert = (id: string, extra: Record<string, unknown>): Promise<unknown> =>
      db.sql`insert into clock_rows ${db.sql({ id, fires: db.sql.json({ job: "x" }), ...extra } as never)}`;
    expect(await refusal(clockInsert("c1", { kind: "alarm" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_kind_known",
    });
    expect(await refusal(clockInsert("c2", { kind: "job", state: "snoozed" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_state_known",
    });
    expect(await refusal(clockInsert("c3", { kind: "job", state: "armed" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_armed_has_due",
    });
    expect(await refusal(clockInsert("c4", { kind: "question" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_question_has_question",
    });
    expect(await refusal(clockInsert("c5", { kind: "saved_time" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_saved_time_has_reservation",
    });
    expect(await refusal(clockInsert("c6", { kind: "job", handle_id: "handle-alex" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_job_has_no_handle",
    });
    expect(await refusal(clockInsert("c7", { kind: "job", state: "fired" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_armed_has_due",
    });
    expect(
      await refusal(
        clockInsert("c8", {
          kind: "job",
          state: "armed",
          due_at: new Date("2026-12-01T13:00:00Z"),
          armed_at: new Date("2026-11-01T13:00:00Z"),
          due_zone: "not a zone",
        }),
      ),
    ).toEqual({ code: "23514", constraint: "clock_rows_due_zone_form" });
    expect(await refusal(clockInsert("c9", { kind: "job", state: "cancelled" }))).toEqual({
      code: "23514",
      constraint: "clock_rows_cancelled_has_time",
    });
    expect(await refusal(clockInsert("c10", { kind: "job", fires: db.sql.json([]) }))).toEqual({
      code: "23514",
      constraint: "clock_rows_fires_object",
    });
    expect(await refusal(clockInsert("c11", { kind: "job", open_question_id: "oq-missing" }))).toEqual({
      code: "23503",
      constraint: "clock_rows_question_fk",
    });
    await clockInsert("c-ok", { kind: "job" });
  });
});

describe("pauses_turn_fk (DL-103 item 4)", () => {
  it("a pause naming a turn that exists is accepted, and one naming a missing turn is refused with 23503", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-turn.json");
    await db.sql`insert into businesses (id, name, display_name, time_zone) values ('biz-pf', 'PF', 'PF', 'UTC')`;
    await db.sql`insert into phones (number, handle_id) select address, id from handles where id = 'handle-alex'`;
    const pause = (id: string, turnId: string): Promise<unknown> =>
      db.sql`
        insert into pauses (id, business_id, target, phone_number, set_by_turn_id, set_at)
        select ${id}, 'biz-pf', 'phone', number, ${turnId}, now() from phones where handle_id = 'handle-alex'
      `;
    await pause("pause-ok", "turn-alex-move-1");
    expect(await refusal(pause("pause-missing-turn", "turn-missing"))).toEqual({
      code: "23503",
      constraint: "pauses_turn_fk",
    });
    const rows = await db.sql<{ id: string }[]>`select id from pauses order by id`;
    expect(rows).toEqual([{ id: "pause-ok" }]);
  });
});
