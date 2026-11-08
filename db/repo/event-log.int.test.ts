// T-190: the event log against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/event-log`). The schema comes from migrating a fresh test
// schema. The wrapping key of every run is made here from random bytes and never written anywhere.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendEvent,
  appendEvents,
  appendSealedEvent,
  getEvent,
  listEventsForBusiness,
  listEventsForRow,
  listEventsForTurn,
  openSealedValues,
  type EventContext,
} from "./event-log";
import { SealingError, erasePerson, unseal, type WrappingKeys } from "./sealing";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";

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
  unique?: { name: string }[];
  indexes?: { name: string; columns: string[] }[];
  versioned: boolean;
}

interface RefusedFixture {
  after: string[];
  refused: {
    role: string;
    action: string;
    table: string;
    set: Record<string, Json>;
    where: Record<string, string>;
    expect: { sqlstate: string };
  };
}

function readCore(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));
}

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

const BYTEA_COLUMNS = new Set(["event_log.sealed_values", "sealing_keys.wrapped_key", "bundle_values.value"]);

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
    const values: Record<string, never> = {};
    for (const [column, value] of Object.entries(row.values)) {
      const key = `${row.table}.${column}`;
      let converted: unknown = value;
      if (jsonbColumns.has(key) && value !== null) {
        converted = sql.json(value);
      } else if (BYTEA_COLUMNS.has(key) && typeof value === "string") {
        converted = fromHex(value.replace(/^\\x/, ""));
      }
      values[column] = converted as never;
    }
    await sql`insert into ${sql(row.table)} ${sql(values)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return loaded;
}

// Truncating turns, persons and businesses cascades to event_log (the log has no row-level delete, truncate is only the
// test's reset inside its own schema).
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate event_log, outbox_parts, outbox_rows, clock_rows, open_questions, turns, pauses, phones, person_handles, handles, bookings, person_roles, sealing_keys, persons, businesses, bundle_values, bundles cascade`;
}

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

const wrappingBytes = crypto.getRandomValues(new Uint8Array(32));
const keys: WrappingKeys = { resolve: () => wrappingBytes };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "evlog" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    jsonb: "jsonb",
    bytea: "bytea",
    timestamptz: "timestamp with time zone",
  };
  const table = (readCore("core.v1.tables.json") as { tables: ContractTable[] }).tables.find(
    (candidate) => candidate.name === "event_log",
  );

  it("the table list names event_log", () => {
    expect(table?.name).toBe("event_log");
  });

  it("columns, types, nulls and defaults are the table list's", async () => {
    const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
      select column_name as name, data_type as type, is_nullable as nullable, column_default as default
      from information_schema.columns
      where table_schema = ${db.schema} and table_name = 'event_log'
      order by ordinal_position
    `;
    expect(found.map((column) => column.name)).toEqual((table?.columns ?? []).map((column) => column.name));
    for (const column of table?.columns ?? []) {
      const actual = found.find((candidate) => candidate.name === column.name);
      expect(actual?.type, `${column.name} type`).toBe(typeNames[column.type]);
      expect(actual?.nullable === "YES", `${column.name} null`).toBe(column.null);
      if (column.default === undefined) {
        expect(actual?.default, `${column.name} default`).toBeNull();
      } else {
        expect((actual?.default ?? "").replace(/::.*$/, ""), `${column.name} default`).toBe(column.default);
      }
    }
  });

  it("primary key, checks, foreign keys and indexes are the table list's; no version column or trigger but the refusal", async () => {
    const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
      select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = ${`${db.schema}.event_log`}::regclass
    `;
    expect(constraints.find((constraint) => constraint.kind === "p")?.definition).toBe("PRIMARY KEY (id)");
    const named = (kind: string): string[] =>
      constraints
        .filter((constraint) => constraint.kind === kind)
        .map((constraint) => constraint.name)
        .sort();
    expect(named("c")).toEqual((table?.checks ?? []).map((check) => check.name).sort());
    expect(named("f")).toEqual((table?.foreignKeys ?? []).map((key) => key.name).sort());
    expect(named("u")).toEqual([]);
    for (const constraint of constraints.filter((candidate) => candidate.kind === "f")) {
      expect(constraint.definition, constraint.name).toContain("ON DELETE RESTRICT");
    }
    const indexes = await db.sql<{ name: string; definition: string }[]>`
      select indexname as name, indexdef as definition from pg_indexes
      where schemaname = ${db.schema} and tablename = 'event_log'
    `;
    expect(indexes.map((index) => index.name).sort()).toEqual(
      ["event_log_pkey", ...(table?.indexes ?? []).map((index) => index.name)].sort(),
    );
    for (const wanted of table?.indexes ?? []) {
      const index = indexes.find((candidate) => candidate.name === wanted.name);
      expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
    }
    const triggers = await db.sql<{ name: string }[]>`
      select tgname as name from pg_trigger
      where tgrelid = ${`${db.schema}.event_log`}::regclass and not tgisinternal
    `;
    expect(triggers.map((trigger) => trigger.name)).toEqual(["event_log_never_edited"]);
  });

  it("is expand only: a plain table, no row-level security here (T-191)", async () => {
    const rows = await db.sql<{ kind: string; rls: boolean }[]>`
      select c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname = 'event_log'
    `;
    expect(rows).toEqual([{ kind: "r", rls: false }]);
  });

  it("is recorded in schema_migrations as core_event_log, after core_outbox", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("core_event_log");
    expect(names.indexOf("core_event_log")).toBeGreaterThan(names.indexOf("core_outbox"));
  });
});

describe("fixture seed-event-log", () => {
  it("loads with its after chain: three rows, one sealed, one by a job", async () => {
    await emptyTables(db.sql);
    const loaded = await loadFixture(db.sql, "seed-event-log.json");
    expect(loaded.event_log).toBe(3);
    const one = await getEvent(db.sql, "evlog-0001");
    expect(one).toMatchObject({
      turnId: "turn-alex-move-1",
      traceId: "trace-alex-0007",
      bundle: { hash: HASH, build: 1 },
      businessId: "biz-lees-barbershop",
      actorKind: "person",
      actorPersonId: "person-alex",
      actorRole: "customer",
      kind: "open_question.opened",
      tableName: "open_questions",
      rowId: "oq-a7-03-alex",
      oldValues: null,
      newValues: { step: "A7-03", status: "waiting", ask_count: 1 },
      why: { step: "A7-02", choice: "Alex moves it" },
      approvedBy: null,
      sealedValues: null,
    });
    const two = await getEvent(db.sql, "evlog-0002");
    expect(two?.sealedForPersonId).toBe("person-alex");
    expect(two?.sealedValues?.length).toBeGreaterThan(0);
    expect(two?.newValues).toBeNull();
    const three = await getEvent(db.sql, "evlog-0003");
    expect(three).toMatchObject({ turnId: null, jobId: "job-sweep-2026-11-01T13:00Z", bundle: null });
    expect(await getEvent(db.sql, "evlog-none")).toBeNull();
  });

  it("the reads: by turn, by row and by business", async () => {
    expect((await listEventsForTurn(db.sql, "turn-alex-move-1")).map((row) => row.id)).toEqual([
      "evlog-0001",
      "evlog-0002",
    ]);
    expect((await listEventsForRow(db.sql, "bookings", "booking-alex-haircut")).map((row) => row.id)).toEqual(
      ["evlog-0002"],
    );
    expect((await listEventsForBusiness(db.sql, "biz-lees-barbershop")).map((row) => row.id)).toEqual([
      "evlog-0002",
      "evlog-0001",
    ]);
    expect(
      await listEventsForBusiness(db.sql, "biz-lees-barbershop", {
        limit: 1,
        before: new Date("2026-10-23T14:05:02Z"),
      }),
    ).toEqual([]);
  });
});

describe("the log is never edited", () => {
  it("refuse-event-log-update: the fixture's update is refused with its sqlstate, and the row is unchanged", async () => {
    const fixture = readCore("fixtures/invalid/refuse-event-log-update.json") as RefusedFixture;
    expect(fixture.refused.action).toBe("update");
    expect(fixture.refused.table).toBe("event_log");
    await emptyTables(db.sql);
    for (const file of fixture.after) {
      await loadFixture(db.sql, file);
    }
    const before = await getEvent(db.sql, "evlog-0001");
    const failure = await refusal(
      db.sql`update event_log set new_values = ${db.sql.json(fixture.refused.set.new_values ?? null)}
             where id = ${fixture.refused.where.id ?? ""}`,
    );
    expect(failure.code).toBe(fixture.refused.expect.sqlstate);
    expect(await getEvent(db.sql, "evlog-0001")).toEqual(before);
  });

  it("every update and every delete raises 42501, whatever the column or the where", async () => {
    const statements: Promise<unknown>[] = [
      db.sql`update event_log set kind = 'x' where id = 'evlog-0001'`,
      db.sql`update event_log set why = null`,
      db.sql`update event_log set sealed_values = null, sealed_for_person_id = null where id = 'evlog-0002'`,
      db.sql`update event_log set id = 'evlog-9999' where id = 'evlog-0003'`,
      db.sql`delete from event_log where id = 'evlog-0001'`,
      db.sql`delete from event_log`,
    ];
    for (const statement of statements) {
      expect((await refusal(statement)).code).toBe("42501");
    }
    // An update that matches no row changes nothing and is not an edit.
    await db.sql`update event_log set kind = 'x' where id = 'evlog-none'`;
    expect(await db.sql`select 1 from event_log`).toHaveLength(3);
  });

  it("the refusal names the table and never a value", async () => {
    try {
      await db.sql`update event_log set kind = 'secret-kind-value' where id = 'evlog-0001'`;
      throw new Error("accepted");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("event_log");
      expect(message).not.toContain("secret-kind-value");
      expect(message).not.toContain("evlog-0001");
    }
  });

  it("an update inside a transaction is refused and rolls the transaction back", async () => {
    const failure = await refusal(
      db.sql.begin(async (tx) => {
        await tx`insert into event_log (id, trace_id, job_id, actor_kind, kind)
                 values ('evlog-tx', 'trace-tx', 'job-tx', 'job', 'x.y')`;
        await tx`delete from event_log where id = 'evlog-0001'`;
      }),
    );
    expect(failure.code).toBe("42501");
    expect(await getEvent(db.sql, "evlog-tx")).toBeNull();
  });

  it("the two rights are taken from PUBLIC", async () => {
    const rows = await db.sql<{ privilege: string }[]>`
      select privilege_type as privilege from information_schema.role_table_grants
      where table_schema = ${db.schema} and table_name = 'event_log' and grantee = 'PUBLIC'
    `;
    const privileges = rows.map((row) => row.privilege);
    expect(privileges).not.toContain("UPDATE");
    expect(privileges).not.toContain("DELETE");
  });
});

describe("append and what the table refuses", () => {
  const context: EventContext = {
    turnId: "turn-alex-move-1",
    traceId: "trace-append",
    bundle: { hash: HASH, build: 1 },
  };
  const entry = {
    id: "evlog-new",
    kind: "booking.moved",
    businessId: "biz-lees-barbershop",
    actorKind: "rosie" as const,
    tableName: "bookings",
    rowId: "booking-alex-haircut",
    oldValues: { starts: "10:00" },
    newValues: { starts: "11:00" },
    why: { step: "A7-03" },
  };

  it("appends a row that carries the turn, trace id and bundle, and reads it back as written", async () => {
    const row = await appendEvent(db.sql, context, entry);
    expect(row).toMatchObject({
      id: "evlog-new",
      turnId: "turn-alex-move-1",
      jobId: null,
      traceId: "trace-append",
      bundle: { hash: HASH, build: 1 },
      kind: "booking.moved",
      oldValues: { starts: "10:00" },
      newValues: { starts: "11:00" },
      approvedBy: null,
      proofs: null,
    });
    expect(row.at).toBeInstanceOf(Date);
    expect(await getEvent(db.sql, "evlog-new")).toEqual(row);
  });

  it("a job entry needs no turn and no bundle; an entry with neither turn nor job is refused", async () => {
    await appendEvent(db.sql, { jobId: "job-x", traceId: "trace-job" }, { ...entry, id: "evlog-job" });
    expect(await getEvent(db.sql, "evlog-job")).toMatchObject({ turnId: null, jobId: "job-x", bundle: null });
    expect(await refusal(appendEvent(db.sql, { traceId: "t" }, { ...entry, id: "evlog-none-1" }))).toEqual({
      code: "23514",
      constraint: "event_log_turn_or_job",
    });
  });

  it("refuses a repeated id, an unknown actor kind, a person with no person, a seal with no person, half a bundle and missing parents", async () => {
    expect(await refusal(appendEvent(db.sql, context, entry))).toEqual({
      code: "23505",
      constraint: "event_log_pkey",
    });
    const cases: [string, EventContext, Record<string, unknown>][] = [
      ["event_log_actor_kind_known", context, { actorKind: "robot" }],
      ["event_log_person_actor", context, { actorKind: "person" }],
      ["event_log_bundle_pair", { ...context, bundle: null }, {}],
      ["event_log_turn_fk", { ...context, turnId: "turn-none" }, {}],
      ["event_log_business_fk", context, { businessId: "biz-none" }],
      ["event_log_actor_fk", context, { actorKind: "person", actorPersonId: "person-none" }],
    ];
    let n = 0;
    for (const [constraint, ctx, extra] of cases) {
      n += 1;
      const failure =
        constraint === "event_log_bundle_pair"
          ? await refusal(
              db.sql`insert into event_log (id, trace_id, turn_id, bundle_hash, actor_kind, kind)
                   values (${`evlog-c${String(n)}`}, 't', 'turn-alex-move-1', ${HASH}, 'rosie', 'x.y')`,
            )
          : await refusal(appendEvent(db.sql, ctx, { ...entry, id: `evlog-c${String(n)}`, ...extra }));
      expect(failure).toEqual({ code: constraint.endsWith("_fk") ? "23503" : "23514", constraint });
    }
  });

  it("a seal with no person is refused by event_log_sealed_has_person", async () => {
    expect(
      await refusal(
        db.sql`insert into event_log (id, trace_id, job_id, actor_kind, kind, sealed_values)
               values ('evlog-nosealer', 't', 'j', 'rosie', 'x.y', ${new Uint8Array([1, 2, 3])})`,
      ),
    ).toEqual({ code: "23514", constraint: "event_log_sealed_has_person" });
  });

  it("appendEvents writes in order and rolls back with its transaction", async () => {
    const failure = await refusal(
      db.sql.begin(async (tx) => {
        await appendEvents(tx, context, [
          { ...entry, id: "evlog-b1" },
          { ...entry, id: "evlog-b2" },
          { ...entry, id: "evlog-b1" },
        ]);
      }),
    );
    expect(failure.code).toBe("23505");
    expect(await getEvent(db.sql, "evlog-b1")).toBeNull();
    const rows = await appendEvents(db.sql, context, [
      { ...entry, id: "evlog-b3" },
      { ...entry, id: "evlog-b4" },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["evlog-b3", "evlog-b4"]);
  });
});

describe("private values sealed per person, and erasure", () => {
  const proof = [
    {
      what: "optOut",
      text_hash: "04dedf8afeb8a4177a009f41bb78018af601e341ed4322d4073911c9ac879726",
      words_shown: "Reply STOP to opt out. Msg & data rates may apply. Reply HELP for help.",
      shown_at: "2026-10-05T17:00:02Z",
      open_question_id: null,
      fixed_line: "optOutLine",
    },
  ];

  it("seals the private values, keeps them out of the plain columns, and opens them while the key is held", async () => {
    await db.sql`insert into persons (id) values ('person-seal-a'), ('person-seal-b')`;
    const privateValues = { old: { note: "allergic to latex" }, new: { note: "allergic to latex and nuts" } };
    const row = await appendSealedEvent(
      db.sql,
      keys,
      { jobId: "job-seal", traceId: "trace-seal" },
      {
        id: "evlog-seal-a",
        kind: "booking.note_sealed",
        actorKind: "rosie",
        tableName: "bookings",
        rowId: "booking-x",
        oldValues: { changed: true },
        newValues: { changed: true },
        approvedBy: { kind: "consentRow", consent_id: "consent-a" },
        proofs: proof,
      },
      "person-seal-a",
      privateValues,
    );
    expect(row.sealedForPersonId).toBe("person-seal-a");
    expect(row.sealedValues).not.toBeNull();
    // The stored bytes hold no plain text of the private values.
    const stored = new TextDecoder("latin1").decode(row.sealedValues ?? new Uint8Array());
    expect(stored.includes("latex")).toBe(false);
    const rawColumns = JSON.stringify([row.oldValues, row.newValues, row.why, row.approvedBy, row.proofs]);
    expect(rawColumns.includes("latex")).toBe(false);
    expect(await openSealedValues(db.sql, keys, row)).toEqual(privateValues);
    // Sealed for one person, it cannot be opened as another's.
    await expect(
      unseal(db.sql, keys, "person-seal-b", new Uint8Array(row.sealedValues ?? [])),
    ).rejects.toMatchObject({ code: "no_key" });
  });

  it("after erasePerson the sealed fields are unreadable, and the proof hash and the words shown remain", async () => {
    const before = await getEvent(db.sql, "evlog-seal-a");
    expect(before?.sealedValues).not.toBeNull();
    const erased = await erasePerson(db.sql, "person-seal-a");
    expect(erased.ok).toBe(true);

    const after = await getEvent(db.sql, "evlog-seal-a");
    // The row is whole: nothing was deleted or edited, the sealed bytes are still there but can never be opened.
    expect(after).toEqual(before);
    expect(
      await openSealedValues(db.sql, keys, after ?? { sealedValues: null, sealedForPersonId: null }),
    ).toBeNull();
    const direct = after?.sealedValues;
    await expect(unseal(db.sql, keys, "person-seal-a", new Uint8Array(direct ?? []))).rejects.toBeInstanceOf(
      SealingError,
    );
    await expect(unseal(db.sql, keys, "person-seal-a", new Uint8Array(direct ?? []))).rejects.toMatchObject({
      code: "erased",
    });
    // The proof hash, the words shown, who, what and why stay readable.
    expect(after?.proofs).toEqual(proof);
    expect(after?.approvedBy).toEqual({ kind: "consentRow", consent_id: "consent-a" });
    expect(after?.kind).toBe("booking.note_sealed");
    // And nothing new can be sealed for an erased person.
    await expect(
      appendSealedEvent(
        db.sql,
        keys,
        { jobId: "job-seal", traceId: "trace-seal" },
        { id: "evlog-seal-late", kind: "booking.note_sealed", actorKind: "rosie" },
        "person-seal-a",
        { new: { note: "x" } },
      ),
    ).rejects.toMatchObject({ code: "erased" });
    expect(await getEvent(db.sql, "evlog-seal-late")).toBeNull();
  });

  it("a row with no sealed values opens to null", async () => {
    const row = await getEvent(db.sql, "evlog-new");
    expect(
      await openSealedValues(db.sql, keys, row ?? { sealedValues: null, sealedForPersonId: null }),
    ).toBeNull();
  });
});
