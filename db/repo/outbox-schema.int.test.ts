// T-189: outbox rows and outbox parts against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/outbox-schema`). The schema comes from migrating a fresh test
// schema. Claiming and moving rows is T-196's; this file proves the tables, their states and the rules they hold.
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const OUTBOX_DIR = new URL("../../contracts/outbox-effects/fixtures/", import.meta.url);
const OWN_TABLES = ["outbox_rows", "outbox_parts"] as const;
const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
// The three CHECKs this migration adds for K-07 v1's closed lists (the table list holds them as free text).
const K07_CHECKS = ["outbox_rows_state_known", "outbox_parts_kind_known", "outbox_parts_state_known"];

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
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

interface K07Record {
  row: {
    id: string;
    channel: string;
    port?: string;
    sendClass: string;
    state: string;
    traceId: string;
    finalParts: Json;
  };
  parts: {
    outboxRowId: string;
    partNo: number;
    tryNo: number;
    idempotencyKey?: string;
    attempts: number;
    kind: string;
    state: string;
  }[];
  moves: { subject: string; from: string | null; to: string }[];
}

function readCore(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));
}

function readK07(relative: string): K07Record {
  return JSON.parse(readFileSync(new URL(relative, OUTBOX_DIR), "utf8")) as K07Record;
}

/** The rows of a fixture and of the fixtures it names in `after`, in load order. */
function fixtureRows(file: string, seen = new Set<string>()): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const loaded = readCore(`fixtures/${file}`) as FixtureFile;
  return [...loaded.after.flatMap((before) => fixtureRows(before, seen)), ...loaded.rows];
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
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

// Truncating the first tables cascades to everything that refers to them (messages and openers_sent included). Each
// test file runs in its own schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate outbox_parts, outbox_rows, clock_rows, open_questions, turns, pauses, phones, person_handles, handles, bookings, person_roles, sealing_keys, persons, businesses, bundle_values, bundles cascade`;
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
  db = await createTestDatabase({ name: "outbox" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    bigint: "bigint",
    jsonb: "jsonb",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readCore("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the two tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["outbox_parts", "outbox_rows"]);
  });

  for (const table of tables) {
    it(`${table.name}: columns, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<
        {
          name: string;
          type: string;
          nullable: string;
          default: string | null;
          identity: string;
          generation: string | null;
        }[]
      >`
        select column_name as name, data_type as type, is_nullable as nullable, column_default as default,
               is_identity as identity, identity_generation as generation
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
        expect(actual?.nullable === "YES", `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === "generated always as identity") {
          expect(actual?.identity, `${table.name}.${column.name} identity`).toBe("YES");
          expect(actual?.generation, `${table.name}.${column.name} identity`).toBe("ALWAYS");
        } else if (column.default === undefined) {
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
      // The table list's checks, plus the K-07 closed lists this migration adds.
      expect(named("c")).toEqual(
        [
          ...(table.checks ?? []).map((check) => check.name),
          ...K07_CHECKS.filter((name) => name.startsWith(table.name)),
        ].sort(),
      );
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

  it("is expand only: plain tables, no row-level security here (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('outbox_rows', 'outbox_parts')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["outbox_parts", "r", false],
      ["outbox_rows", "r", false],
    ]);
  });

  it("the outbox row has no SMS provider, port or claim column: the channel is K-03's", async () => {
    const columns = await db.sql<{ name: string }[]>`
      select column_name as name from information_schema.columns
      where table_schema = ${db.schema} and table_name = 'outbox_rows'
    `;
    const names = columns.map((column) => column.name);
    for (const absent of ["port", "provider", "claimed_by", "claimed_at", "lapses_at"]) {
      expect(names).not.toContain(absent);
    }
  });
});

describe("the foreign keys earlier migrations left for outbox_rows (DL-103 item 4)", () => {
  async function definition(table: string, name: string): Promise<string[]> {
    const rows = await db.sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${`${db.schema}.${table}`}::regclass and conname = ${name}
    `;
    return rows.map((row) => row.definition);
  }

  it("openers_sent_outbox_fk and messages_outbox_fk were added by this migration, refusing deletes", async () => {
    expect(await definition("openers_sent", "openers_sent_outbox_fk")).toEqual([
      "FOREIGN KEY (outbox_row_id) REFERENCES outbox_rows(id) ON DELETE RESTRICT",
    ]);
    expect(await definition("messages", "messages_outbox_fk")).toEqual([
      "FOREIGN KEY (outbox_row_id) REFERENCES outbox_rows(id) ON DELETE RESTRICT",
    ]);
  });

  it("a mark or a message naming a missing outbox row is refused with 23503; one naming a real row is accepted", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-outbox-row.json");
    await db.sql`
      insert into threads (id, handle_id, kind) values ('thread-fk', 'handle-alex', 'chat')
    `;
    const opener = (rowId: string): Promise<unknown> => db.sql`
      insert into openers_sent (handle_id, business_id, sent_at, outbox_row_id)
      values ('handle-alex', 'biz-lees-barbershop', now(), ${rowId})
    `;
    const message = (id: string, rowId: string): Promise<unknown> => db.sql`
      insert into messages (id, thread_id, direction, channel, service, from_role, to_role, words, sent_at,
                            outbox_row_id)
      values (${id}, 'thread-fk', 'out', 'text', 'imessage', 'rosie', 'customer', 'sealed', now(), ${rowId})
    `;
    expect(await refusal(opener("out-missing"))).toEqual({
      code: "23503",
      constraint: "openers_sent_outbox_fk",
    });
    expect(await refusal(message("msg-missing", "out-missing"))).toEqual({
      code: "23503",
      constraint: "messages_outbox_fk",
    });
    await opener("out-a7-03-alex");
    await message("msg-real", "out-a7-03-alex");
    expect(await refusal(db.sql`delete from outbox_rows where id = 'out-a7-03-alex'`)).toMatchObject({
      code: "23503",
    });
    await db.sql`delete from messages where id = 'msg-real'`;
    await db.sql`delete from openers_sent where handle_id = 'handle-alex'`;
  });
});

describe("fixture seed-outbox-row and the refused rows", () => {
  it("seed-outbox-row loads with its after chain: a delivered poll row with two parts, and its email copy", async () => {
    await emptyTables(db.sql);
    const loaded = await loadFixture(db.sql, "seed-outbox-row.json");
    expect(loaded.outbox_rows).toBe(2);
    expect(loaded.outbox_parts).toBe(2);
    const rows = await db.sql<
      {
        id: string;
        channel: string;
        send_class: string;
        state: string;
        copy_of_row_id: string | null;
        bundle_hash: string;
        bundle_build: number;
        open_question_id: string | null;
        version: number;
        has_plan: boolean;
        has_parts: boolean;
      }[]
    >`
      select id, channel, send_class, state, copy_of_row_id, bundle_hash, bundle_build, open_question_id, version,
             plan is not null as has_plan, final_parts is not null as has_parts
      from outbox_rows order by commit_seq
    `;
    expect(rows).toEqual([
      {
        id: "out-a7-03-alex",
        channel: "imessage",
        send_class: "quick_reply",
        state: "delivered",
        copy_of_row_id: null,
        bundle_hash: HASH,
        bundle_build: 1,
        open_question_id: "oq-a7-03-alex",
        version: 6,
        has_plan: true,
        has_parts: true,
      },
      {
        id: "out-a7-03-alex-email",
        channel: "email",
        send_class: "quick_reply",
        state: "planned",
        copy_of_row_id: "out-a7-03-alex",
        bundle_hash: HASH,
        bundle_build: 1,
        open_question_id: "oq-a7-03-alex",
        version: 2,
        has_plan: true,
        has_parts: false,
      },
    ]);
    const parts = await db.sql<
      {
        part_no: number;
        try_no: number;
        key: string;
        kind: string;
        state: string;
        options: string[] | null;
      }[]
    >`
      select part_no, try_no, idempotency_key as key, kind, state, linq_option_ids as options
      from outbox_parts order by part_no
    `;
    expect(parts).toEqual([
      { part_no: 1, try_no: 1, key: "out-a7-03-alex/1/1", kind: "words", state: "delivered", options: null },
      {
        part_no: 2,
        try_no: 1,
        key: "out-a7-03-alex/2/1",
        kind: "poll",
        state: "delivered",
        options: ["linq-opt-demo-1", "linq-opt-demo-2", "linq-opt-demo-3"],
      },
    ]);
  });

  /**
   * Writes a K-07 refused record's row as outbox_rows, on the seeded turn, so the refusal is the record's own reason.
   * The record's turn, booking and claim are K-07's own and are not in the core seeds, so the seeded ones stand in.
   */
  function rowOf(record: K07Record): Record<string, unknown> {
    return {
      id: record.row.id,
      turn_id: "turn-alex-move-1",
      recipient_handle_id: "handle-alex",
      channel: record.row.channel,
      send_class: record.row.sendClass,
      versions_read: db.sql.json([]),
      final_parts: db.sql.json(record.row.finalParts),
      state: record.row.state,
      bundle_hash: HASH,
      bundle_build: 1,
      trace_id: record.row.traceId,
    };
  }

  it("refuse-part-without-key is refused: a part with no idempotency key is not written", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-outbox-row.json");
    const record = readK07("invalid/refuse-part-without-key.json");
    const part = record.parts[0];
    if (part === undefined) {
      throw new Error("the fixture names no part");
    }
    expect(part.idempotencyKey).toBeUndefined();
    await db.sql`insert into outbox_rows ${db.sql(rowOf(record) as never)}`;
    const failure = await refusal(
      db.sql`
        insert into outbox_parts (outbox_row_id, part_no, try_no, attempts, kind, state)
        values (${part.outboxRowId}, ${part.partNo}, ${part.tryNo}, ${part.attempts}, ${part.kind}, ${part.state})
      `,
    );
    expect(failure.code).toBe("23502");
    // The same part with its key passes: the key is the one reason.
    await db.sql`
      insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, state)
      values (${part.outboxRowId}, ${part.partNo}, ${part.tryNo}, ${`${part.outboxRowId}/1/1`}, ${part.attempts},
              ${part.kind}, ${part.state})
    `;
    expect(await db.sql`select 1 from outbox_parts where outbox_row_id = ${part.outboxRowId}`).toHaveLength(
      1,
    );
  });

  it("refuse-sms-channel is refused: the fixture's reason is an SMS port; no SMS provider can be named in the row", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-outbox-row.json");
    const record = readK07("invalid/refuse-sms-channel.json");
    // K-07's reason is the port: there is no SMS port (DL-012). The table has no port column, and the channel list is
    // K-03's, where sms is Linq's own SMS service. So the row is refused when it names an SMS provider as its channel.
    expect(record.row.port).toBe("sms");
    for (const provider of ["twilio", "sms_provider", "mms", "SMS"]) {
      const row = { ...rowOf(record), id: `out-${provider}`, channel: provider };
      expect(await refusal(db.sql`insert into outbox_rows ${db.sql(row as never)}`)).toEqual({
        code: "23514",
        constraint: "outbox_rows_channel_known",
      });
    }
    // No column can carry the port, so a provider cannot be named any other way.
    await expect(
      db.sql`insert into outbox_rows ${db.sql({ ...rowOf(record), id: "out-with-port", port: "sms" } as never)}`,
    ).rejects.toMatchObject({ code: "42703" });
    // Linq's own channels and email are accepted.
    for (const channel of ["imessage", "rcs", "sms", "email"]) {
      await db.sql`insert into outbox_rows ${db.sql({ ...rowOf(record), id: `out-ok-${channel}`, channel } as never)}`;
    }
  });
});

describe("commit order per recipient", () => {
  function rowInsert(sql: Sql, id: string, handle: string): Promise<unknown> {
    return sql`
      insert into outbox_rows (id, turn_id, recipient_handle_id, channel, versions_read, bundle_hash, bundle_build,
                               trace_id)
      values (${id}, 'turn-alex-move-1', ${handle}, 'imessage', '[]'::jsonb, ${HASH}, 1, 'trace-order')
    `;
  }

  it("rows written in one commit get unique, consecutive commit_seq values in the order written", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-outbox-row.json");
    await db.sql`insert into handles (id, kind, address) values ('handle-order-2', 'phone', '+15555550142')`;
    const ids = ["out-order-1", "out-order-2", "out-order-3", "out-order-4"];
    // Two recipients interleaved inside one transaction: each recipient's rows still come out in the order written.
    await db.sql.begin(async (tx) => {
      await rowInsert(tx as unknown as Sql, ids[0] ?? "", "handle-alex");
      await rowInsert(tx as unknown as Sql, ids[1] ?? "", "handle-order-2");
      await rowInsert(tx as unknown as Sql, ids[2] ?? "", "handle-alex");
      await rowInsert(tx as unknown as Sql, ids[3] ?? "", "handle-order-2");
    });
    const rows = await db.sql<{ id: string; seq: string; handle: string }[]>`
      select id, commit_seq::text as seq, recipient_handle_id as handle from outbox_rows
      where id like 'out-order-%' order by commit_seq
    `;
    expect(rows.map((row) => row.id)).toEqual(ids);
    const seqs = rows.map((row) => BigInt(row.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    seqs.forEach((seq, index) => {
      if (index > 0) {
        expect(seq - (seqs[index - 1] ?? 0n), `gap before ${rows[index]?.id ?? ""}`).toBe(1n);
      }
    });
    const alex = rows.filter((row) => row.handle === "handle-alex").map((row) => row.id);
    expect(alex).toEqual(["out-order-1", "out-order-3"]);
  });

  it("commit_seq cannot be set by a writer, and cannot repeat even when forced", async () => {
    // generated always: a plain insert or update naming it is refused (428C9).
    expect(
      await refusal(
        db.sql`
          insert into outbox_rows (id, turn_id, recipient_handle_id, channel, versions_read, bundle_hash,
                                   bundle_build, trace_id, commit_seq)
          values ('out-set-seq', 'turn-alex-move-1', 'handle-alex', 'imessage', '[]'::jsonb, ${HASH}, 1, 't', 99)
        `,
      ),
    ).toMatchObject({ code: "428C9" });
    expect(
      await refusal(
        db.sql`update outbox_rows set commit_seq = 1000, version = version + 1 where id = 'out-order-1'`,
      ),
    ).toMatchObject({ code: "428C9" });
    // Overriding the identity with a value already used is refused by the unique rule.
    expect(
      await refusal(
        db.sql`
          insert into outbox_rows (id, turn_id, recipient_handle_id, channel, versions_read, bundle_hash,
                                   bundle_build, trace_id, commit_seq)
          overriding system value
          select 'out-dup-seq', 'turn-alex-move-1', 'handle-alex', 'imessage', '[]'::jsonb, ${HASH}, 1, 't',
                 commit_seq from outbox_rows where id = 'out-order-1'
        `,
      ),
    ).toEqual({ code: "23505", constraint: "outbox_rows_commit_seq_key" });
  });

  it("30 parallel writers each get their own commit_seq", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `out-par-${String(index)}`);
    await Promise.all(ids.map((id) => rowInsert(db.sql, id, "handle-alex")));
    const rows = await db.sql<{ seq: string }[]>`
      select commit_seq::text as seq from outbox_rows where id like 'out-par-%'
    `;
    expect(new Set(rows.map((row) => row.seq)).size).toBe(30);
  });
});

describe("what the database refuses", () => {
  const rowInsert = (id: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const row = {
      id,
      turn_id: "turn-alex-move-1",
      recipient_handle_id: "handle-alex",
      channel: "imessage",
      versions_read: db.sql.json([]),
      bundle_hash: HASH,
      bundle_build: 1,
      trace_id: "trace-x",
      ...extra,
    };
    return db.sql`insert into outbox_rows ${db.sql(row as never)}`;
  };

  const partInsert = (
    rowId: string,
    partNo: number,
    tryNo: number,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const part = {
      outbox_row_id: rowId,
      part_no: partNo,
      try_no: tryNo,
      idempotency_key: `${rowId}/${String(partNo)}/${String(tryNo)}`,
      kind: "words",
      state: "pending",
      ...extra,
    };
    return db.sql`insert into outbox_parts ${db.sql(part as never)}`;
  };

  async function seed(): Promise<void> {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-outbox-row.json");
  }

  it("a row's state accepts exactly K-07's twelve states, and starts as planned", async () => {
    await seed();
    const states = [
      "planned",
      "checked",
      "sending",
      "sent",
      "delivered",
      "held",
      "dropped_stopped",
      "stale",
      "withdrawn",
      "failed",
      "waiting_chat",
      "superseded",
    ];
    for (const state of states) {
      await rowInsert(`out-state-${state}`, { state });
    }
    await rowInsert("out-state-default");
    const stored = await db.sql<{ state: string }[]>`
      select state from outbox_rows where id = 'out-state-default'`;
    expect(stored).toEqual([{ state: "planned" }]);
    for (const bad of ["queued", "Planned", "claimed", "", "sms"]) {
      expect(await refusal(rowInsert(`out-bad-${bad}`, { state: bad }))).toEqual({
        code: "23514",
        constraint: "outbox_rows_state_known",
      });
    }
    expect(
      await refusal(
        db.sql`update outbox_rows set state = 'queued', version = version + 1 where id = 'out-state-sent'`,
      ),
    ).toEqual({ code: "23514", constraint: "outbox_rows_state_known" });
  });

  it("every state, kind and part state K-07's own records use is accepted", async () => {
    await seed();
    const rowStates = new Set<string>();
    const partStates = new Set<string>();
    const kinds = new Set<string>();
    const files = readdirSync(OUTBOX_DIR).filter(
      (name) => name.startsWith("outbox-") && name.endsWith(".json"),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const record = readK07(file);
      rowStates.add(record.row.state);
      for (const move of record.moves) {
        (move.subject === "row" ? rowStates : partStates).add(move.to);
        if (move.from !== null) {
          (move.subject === "row" ? rowStates : partStates).add(move.from);
        }
      }
      for (const part of record.parts) {
        kinds.add(part.kind);
        partStates.add(part.state);
      }
    }
    let n = 0;
    for (const state of rowStates) {
      await rowInsert(`out-k07-${String((n += 1))}`, { state });
    }
    await rowInsert("out-k07-parts");
    let partNo = 0;
    for (const state of partStates) {
      partNo += 1;
      await partInsert("out-k07-parts", 1, partNo, { state });
    }
    for (const kind of kinds) {
      partNo += 1;
      await partInsert("out-k07-parts", 2, partNo, { kind });
    }
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["poll", "words"]));
  });

  it("a row refuses a bad send class, a plan or parts that are not objects, versions that are not a list, and a text copy", async () => {
    await seed();
    expect(await refusal(rowInsert("out-r1", { send_class: "urgent" }))).toEqual({
      code: "23514",
      constraint: "outbox_rows_send_class_known",
    });
    for (const sendClass of ["routine", "quick_reply", "visit_now", "safety"]) {
      await rowInsert(`out-class-${sendClass}`, { send_class: sendClass });
    }
    expect(await refusal(rowInsert("out-r2", { plan: db.sql.json([]) }))).toEqual({
      code: "23514",
      constraint: "outbox_rows_plan_object",
    });
    expect(await refusal(rowInsert("out-r3", { final_parts: db.sql.json([]) }))).toEqual({
      code: "23514",
      constraint: "outbox_rows_final_parts_object",
    });
    expect(await refusal(rowInsert("out-r4", { versions_read: db.sql.json({}) }))).toEqual({
      code: "23514",
      constraint: "outbox_rows_versions_list",
    });
    expect(await refusal(rowInsert("out-r5", { copy_of_row_id: "out-a7-03-alex" }))).toEqual({
      code: "23514",
      constraint: "outbox_rows_copy_is_email",
    });
    await rowInsert("out-r6", { channel: "email", copy_of_row_id: "out-a7-03-alex" });
    expect(await refusal(rowInsert("out-r7", { channel: "email", copy_of_row_id: "out-none" }))).toEqual({
      code: "23503",
      constraint: "outbox_rows_copy_of_fk",
    });
  });

  it("a row refuses a turn, handle, person, business, booking, question or bundle that does not exist", async () => {
    await seed();
    const cases: [string, Record<string, unknown>][] = [
      ["outbox_rows_turn_fk", { turn_id: "turn-none" }],
      ["outbox_rows_handle_fk", { recipient_handle_id: "handle-none" }],
      ["outbox_rows_person_fk", { recipient_person_id: "person-none" }],
      ["outbox_rows_business_fk", { business_id: "biz-none" }],
      ["outbox_rows_booking_fk", { booking_id: "booking-none" }],
      ["outbox_rows_question_fk", { open_question_id: "oq-none" }],
      ["outbox_rows_bundle_fk", { bundle_build: 9 }],
    ];
    for (const [constraint, extra] of cases) {
      expect(await refusal(rowInsert(`out-fk-${constraint}`, extra))).toEqual({ code: "23503", constraint });
    }
    expect(await refusal(rowInsert("out-a7-03-alex"))).toEqual({
      code: "23505",
      constraint: "outbox_rows_pkey",
    });
    expect(await refusal(rowInsert("out-nulls", { trace_id: null }))).toMatchObject({ code: "23502" });
  });

  it("a part: the key is '<row>/<part>/<try>' and unique; at most two parts; kind and state are K-07's", async () => {
    await seed();
    await rowInsert("out-p1");
    await partInsert("out-p1", 1, 1);
    await partInsert("out-p1", 2, 1, { kind: "poll" });
    // A reported failure gets a new key, the next try.
    await partInsert("out-p1", 1, 2);
    expect(await refusal(partInsert("out-p1", 1, 1))).toEqual({
      code: "23505",
      constraint: "outbox_parts_pkey",
    });
    expect(await refusal(partInsert("out-p1", 1, 3, { idempotency_key: "out-p1/1/1" }))).toEqual({
      code: "23514",
      constraint: "outbox_parts_key_form",
    });
    expect(await refusal(partInsert("out-p1", 1, 3, { idempotency_key: "wrong" }))).toEqual({
      code: "23514",
      constraint: "outbox_parts_key_form",
    });
    expect(await refusal(partInsert("out-p1", 3, 1))).toEqual({
      code: "23514",
      constraint: "outbox_parts_part_no",
    });
    expect(await refusal(partInsert("out-p1", 1, 0))).toEqual({
      code: "23514",
      constraint: "outbox_parts_try_no",
    });
    expect(await refusal(partInsert("out-p1", 1, 4, { attempts: 0 }))).toEqual({
      code: "23514",
      constraint: "outbox_parts_attempts",
    });
    expect(await refusal(partInsert("out-p1", 1, 5, { kind: "photo" }))).toEqual({
      code: "23514",
      constraint: "outbox_parts_kind_known",
    });
    expect(await refusal(partInsert("out-p1", 1, 6, { state: "queued" }))).toEqual({
      code: "23514",
      constraint: "outbox_parts_state_known",
    });
    expect(await refusal(partInsert("out-none", 1, 1))).toEqual({
      code: "23503",
      constraint: "outbox_parts_row_fk",
    });
    expect(await refusal(db.sql`delete from outbox_rows where id = 'out-p1'`)).toMatchObject({
      code: "23503",
    });
    // A key can only be held once even by another row's part: the key form ties it to its own row.
    await rowInsert("out-p2");
    expect(await refusal(partInsert("out-p2", 1, 1, { idempotency_key: "out-p1/1/1" }))).toMatchObject({
      code: "23514",
    });
  });

  it("a row's and a part's version can only be raised by one", async () => {
    await seed();
    await rowInsert("out-v1");
    await partInsert("out-v1", 1, 1);
    expect(await refusal(db.sql`update outbox_rows set state = 'checked' where id = 'out-v1'`)).toEqual({
      code: "23514",
      constraint: "outbox_rows_version_raised",
    });
    expect(
      await refusal(
        db.sql`update outbox_rows set state = 'checked', version = version + 2 where id = 'out-v1'`,
      ),
    ).toEqual({ code: "23514", constraint: "outbox_rows_version_raised" });
    await db.sql`update outbox_rows set state = 'checked', version = version + 1 where id = 'out-v1'`;
    expect(
      await refusal(db.sql`update outbox_parts set attempts = 2 where outbox_row_id = 'out-v1'`),
    ).toEqual({
      code: "23514",
      constraint: "outbox_parts_version_raised",
    });
    await db.sql`update outbox_parts set attempts = 2, version = version + 1 where outbox_row_id = 'out-v1'`;
    const rows = await db.sql<{ version: number; state: string }[]>`
      select version, state from outbox_rows where id = 'out-v1'`;
    expect(rows).toEqual([{ version: 2, state: "checked" }]);
    const parts = await db.sql<{ version: number; attempts: number }[]>`
      select version, attempts from outbox_parts where outbox_row_id = 'out-v1'`;
    expect(parts).toEqual([{ version: 2, attempts: 2 }]);
  });
});

describe("the migration queue", () => {
  it("is recorded in schema_migrations as core_outbox, after the migrations before it", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("core_outbox");
    expect(names.indexOf("core_outbox")).toBeGreaterThan(names.indexOf("core_turns_questions_clocks"));
  });
});
