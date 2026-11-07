// T-184: threads, the opener-sent mark and the message log against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/threads`). The schema comes from migrating a fresh test schema.
// The wrapping key of every run is made here from random bytes and never written to a file.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusiness, createPerson } from "./people";
import { createHandle } from "./phones";
import type { Sql } from "./scope";
import { SealingError, type WrappingKeys, erasePerson, unsealText } from "./sealing";
import { createTestDatabase, type TestDatabase } from "./test-db";
import {
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_MESSAGE_MAX_AGE_DAYS,
  type NewMessage,
  SEALED_WORDS_PREFIX,
  createThread,
  ensureChatThread,
  getChatThread,
  getEmailThreadOfBooking,
  getMessage,
  getOpenerSent,
  getThread,
  getThreadByLinqChatId,
  getThreadByReplyAddress,
  hasOpenerBeenSent,
  listRecentMessages,
  listThreadsOfHandle,
  markMessageDelivered,
  markOpenerSent,
  setLinqChatId,
  writeMessage,
} from "./threads";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const OWN_TABLES = ["threads", "openers_sent", "messages"] as const;
// Tables the fixtures' `after` chains bring in from the earlier migrations (0002 to 0004).
const EARLIER_TABLES = [
  "businesses",
  "persons",
  "person_roles",
  "sealing_keys",
  "handles",
  "person_handles",
  "phones",
  "pauses",
];
const LOADABLE_TABLES: readonly string[] = [...EARLIER_TABLES, ...OWN_TABLES];
// Foreign keys of the table list whose target table a later migration makes. The key is added there.
const WAITING_FOREIGN_KEYS = [
  "threads_booking_fk",
  "messages_booking_fk",
  "openers_sent_outbox_fk",
  "messages_outbox_fk",
];

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, string | number | boolean | null> }[];
}

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  foreignKeys?: { name: string }[];
  unique?: { name: string; columns: string[]; where?: string }[];
  indexes?: { name: string; columns: string[] }[];
  versioned: boolean;
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));
}

/** The rows of a fixture and of the fixtures it names in `after`, in load order. */
function fixtureRows(file: string, seen = new Set<string>()): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readJson(`fixtures/${file}`) as FixtureFile;
  return [...fixture.after.flatMap((before) => fixtureRows(before, seen)), ...fixture.rows];
}

/** Loads the loadable rows as the fixture has them. A row of a table no migration makes yet is skipped and named. */
async function loadFixture(
  sql: Sql,
  file: string,
  sealWords?: (values: Record<string, string | number | boolean | null>) => Promise<void>,
): Promise<{ loaded: Record<string, number>; skipped: string[] }> {
  const loaded: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const row of fixtureRows(file)) {
    if (!LOADABLE_TABLES.includes(row.table)) {
      skipped.add(row.table);
      continue;
    }
    if (row.table === "messages" && sealWords !== undefined) {
      await sealWords(row.values);
    } else {
      await sql`insert into ${sql(row.table)} ${sql(row.values)}`;
    }
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return { loaded, skipped: [...skipped].sort() };
}

// Later migrations add tables that reference these, so the truncate cascades to them. Each test file runs in its
// own schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate messages, openers_sent, threads, pauses, phones, person_handles, handles, person_roles, sealing_keys, persons, businesses cascade`;
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

// A key for this run only: 32 random bytes held in memory.
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const keys: WrappingKeys = { resolve: () => WRAP_BYTES };

let db: TestDatabase;

/** The fixture's message as the input of writeMessage. */
function asNewMessage(values: Record<string, string | number | boolean | null>): NewMessage {
  return {
    id: String(values.id),
    threadId: String(values.thread_id),
    businessId: (values.business_id as string | null | undefined) ?? null,
    bookingId: (values.booking_id as string | null | undefined) ?? null,
    direction: values.direction as NewMessage["direction"],
    channel: values.channel as NewMessage["channel"],
    service: (values.service as NewMessage["service"] | undefined) ?? null,
    fromRole: values.from_role as NewMessage["fromRole"],
    toRole: values.to_role as NewMessage["toRole"],
    personId: String(values.person_id),
    words: String(values.words),
    eventId: (values.event_id as string | null | undefined) ?? null,
    outboxRowId: (values.outbox_row_id as string | null | undefined) ?? null,
    sentAt: new Date(String(values.sent_at)),
    deliveredAt: values.delivered_at === undefined ? null : new Date(String(values.delivered_at)),
  };
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "threads" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the three tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["messages", "openers_sent", "threads"]);
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
      const regclass = `${db.schema}.${table.name}`;
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${regclass}::regclass
      `;
      const pk = constraints.find((constraint) => constraint.kind === "p");
      expect(pk?.definition).toBe(`PRIMARY KEY (${(table.primaryKey ?? []).join(", ")})`);
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual(
        (table.foreignKeys ?? [])
          .map((key) => key.name)
          .filter((name) => !WAITING_FOREIGN_KEYS.includes(name))
          .sort(),
      );
      // A unique rule with a `where` is a partial index, not a constraint.
      expect(named("u")).toEqual(
        (table.unique ?? [])
          .filter((rule) => rule.where === undefined)
          .map((rule) => rule.name)
          .sort(),
      );

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
      for (const rule of table.unique ?? []) {
        const index = indexes.find((candidate) => candidate.name === rule.name);
        expect(index?.definition).toContain("CREATE UNIQUE INDEX");
        expect(index?.definition).toContain(`(${rule.columns.join(", ")})`);
        if (rule.where !== undefined) {
          expect(index?.definition).toContain("WHERE (kind = 'chat'::text)");
        }
      }
      for (const wanted of table.indexes ?? []) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
      }
    });

    it(`${table.name}: foreign keys refuse deletes, and the version trigger exists exactly when versioned`, async () => {
      const keysFound = await db.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass and contype = 'f'
      `;
      for (const key of keysFound) {
        expect(key.definition, key.name).toContain("ON DELETE RESTRICT");
      }
      const triggers = await db.sql<{ name: string }[]>`
        select tgname as name from pg_trigger
        where tgrelid = ${`${db.schema}.${table.name}`}::regclass and not tgisinternal
      `;
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        table.versioned ? [`${table.name}_version_raised`] : [],
      );
      expect(table.columns.some((column) => column.name === "version")).toBe(table.versioned);
    });
  }

  it("is expand only: plain tables, no row-level security here (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('threads', 'openers_sent', 'messages')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["messages", "r", false],
      ["openers_sent", "r", false],
      ["threads", "r", false],
    ]);
  });

  it("is recorded in schema_migrations after 0001 to 0004", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name).slice(0, 5)).toEqual([
      "init",
      "core_business_people",
      "core_sealing_keys",
      "core_handles_phones",
      "core_threads_messages",
    ]);
  });
});

describe("fixture seed-thread-messages", () => {
  it("loads as the fixture has it; rows of tables no migration makes yet are skipped and named", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-thread-messages.json");
    expect(result.loaded).toMatchObject({ threads: 2, openers_sent: 1, messages: 5 });
    // Turns, outbox rows and the booking head wait for their own migrations.
    expect(result.skipped).toEqual(expect.arrayContaining(["outbox_rows", "turns"]));
    for (const table of result.skipped) {
      expect(LOADABLE_TABLES).not.toContain(table);
    }
    const threads = await db.sql<{ id: string; kind: string; version: number }[]>`
      select id, kind, version from threads order by id
    `;
    expect(threads).toEqual([
      { id: "thread-alex-chat", kind: "chat", version: 2 },
      { id: "thread-alex-haircut-email", kind: "email", version: 1 },
    ]);
    const mark = await getOpenerSent(db.sql, "handle-alex", "biz-lees-barbershop");
    expect(mark).toEqual({
      handleId: "handle-alex",
      businessId: "biz-lees-barbershop",
      sentAt: new Date("2026-10-12T16:20:03Z"),
      outboxRowId: "out-alex-first",
    });
  });

  it("the tables that wait for a later migration are named, and none of this card's tables is among them", () => {
    const needed = new Set(fixtureRows("seed-thread-messages.json").map((row) => row.table));
    for (const table of OWN_TABLES) {
      expect(needed.has(table), table).toBe(true);
      expect(LOADABLE_TABLES, table).toContain(table);
    }
    const later = [...needed].filter((table) => !LOADABLE_TABLES.includes(table)).sort();
    expect(later).toContain("outbox_rows");
    expect(later).toContain("turns");
    expect(later).toContain("bundle_values");
  });
});

describe("threads per handle and channel", () => {
  it("loads the fixture's threads, one chat per handle and one email thread per booking", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-thread-messages.json");
    expect(await getChatThread(db.sql, "handle-alex")).toEqual({
      id: "thread-alex-chat",
      handleId: "handle-alex",
      kind: "chat",
      bookingId: null,
      linqChatId: "linq-chat-demo-alex",
      replyAddress: null,
      version: 2,
    });
    expect(await getChatThread(db.sql, "handle-alex-email")).toBeNull();
    expect((await listThreadsOfHandle(db.sql, "handle-alex-email")).map((thread) => thread.id)).toEqual([
      "thread-alex-haircut-email",
    ]);
    expect(await listThreadsOfHandle(db.sql, "handle-alex-email", "chat")).toEqual([]);
    expect(await listThreadsOfHandle(db.sql, "handle-alex", "chat")).toHaveLength(1);
    expect(await listThreadsOfHandle(db.sql, "handle-alex", "email")).toEqual([]);
    expect((await getEmailThreadOfBooking(db.sql, "booking-alex-haircut"))?.id).toBe(
      "thread-alex-haircut-email",
    );
    expect((await getThreadByReplyAddress(db.sql, "booking-alex-haircut@reply.example.com"))?.id).toBe(
      "thread-alex-haircut-email",
    );
    expect((await getThreadByLinqChatId(db.sql, "linq-chat-demo-alex"))?.id).toBe("thread-alex-chat");
    expect(await getThreadByLinqChatId(db.sql, "none")).toBeNull();
    expect(await getThread(db.sql, "none")).toBeNull();
  });

  it("the database refuses a second chat for a handle, and a chat or email thread that is the wrong shape", async () => {
    expect(
      await refusal(createThread(db.sql, { id: "t-second", handleId: "handle-alex", kind: "chat" })),
    ).toEqual({ code: "23505", constraint: "threads_one_chat_per_handle" });
    expect(
      await refusal(createThread(db.sql, { id: "t-nohandle", handleId: "handle-none", kind: "chat" })),
    ).toEqual({ code: "23503", constraint: "threads_handle_fk" });
    expect(
      await refusal(
        createThread(db.sql, {
          id: "t-dup-reply",
          handleId: "handle-alex-email",
          kind: "email",
          bookingId: "booking-x",
          replyAddress: "booking-alex-haircut@reply.example.com",
        }),
      ),
    ).toEqual({ code: "23505", constraint: "threads_reply_address_key" });
    expect(
      await refusal(
        createThread(db.sql, {
          id: "t-dup-linq",
          handleId: "handle-alex-email",
          kind: "chat",
          linqChatId: "linq-chat-demo-alex",
        }),
      ),
    ).toEqual({ code: "23505", constraint: "threads_linq_chat_key" });
    const shape = { code: "23514", constraint: "threads_chat_or_email" };
    expect(
      await refusal(
        db.sql`insert into threads (id, handle_id, kind, booking_id) values ('t-bad-1', 'handle-alex-email', 'chat', 'b-1')`,
      ),
    ).toEqual(shape);
    expect(
      await refusal(
        db.sql`insert into threads (id, handle_id, kind) values ('t-bad-2', 'handle-alex-email', 'email')`,
      ),
    ).toEqual(shape);
    expect(
      await refusal(
        db.sql`insert into threads (id, handle_id, kind, booking_id, reply_address) values ('t-bad-3', 'handle-alex-email', 'email', 'b-1', null)`,
      ),
    ).toEqual(shape);
    expect(
      await refusal(
        db.sql`insert into threads (id, handle_id, kind) values ('t-bad-4', 'handle-alex', 'sms')`,
      ),
    ).toMatchObject({ code: "23514" });
    expect(await refusal(db.sql`delete from handles where id = 'handle-alex'`)).toMatchObject({
      code: "23503",
    });
  });

  it("several email threads for one handle are fine; a handle's chat stays one", async () => {
    await createHandle(db.sql, { id: "h-mail-2", kind: "email", address: "second@example.com" });
    for (const n of [1, 2]) {
      await createThread(db.sql, {
        id: `t-mail-${String(n)}`,
        handleId: "h-mail-2",
        kind: "email",
        bookingId: `b-mail-${String(n)}`,
        replyAddress: `b-mail-${String(n)}@reply.example.com`,
      });
    }
    expect((await listThreadsOfHandle(db.sql, "h-mail-2", "email")).map((thread) => thread.id)).toEqual([
      "t-mail-1",
      "t-mail-2",
    ]);
  });

  it("ensureChatThread: 30 parallel calls for a new handle make one thread and all return it", async () => {
    await createHandle(db.sql, { id: "h-chat-new", kind: "phone", address: "+15555559101" });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        ensureChatThread(db.sql, "h-chat-new", `t-new-${String(index)}`),
      ),
    );
    expect(new Set(results.map((thread) => thread.id)).size).toBe(1);
    expect(await listThreadsOfHandle(db.sql, "h-chat-new")).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "chat", version: 1, linqChatId: null });
  });

  it("setLinqChatId is a compare-and-set; a stale write returns the row as it is", async () => {
    const thread = await ensureChatThread(db.sql, "h-chat-new", "t-unused");
    const first = await setLinqChatId(db.sql, thread.id, 1, "linq-new-1");
    expect(first).toMatchObject({ ok: true, row: { linqChatId: "linq-new-1", version: 2 } });
    const stale = await setLinqChatId(db.sql, thread.id, 1, "linq-new-2");
    expect(stale).toMatchObject({ ok: false, current: { linqChatId: "linq-new-1", version: 2 } });
    expect(await setLinqChatId(db.sql, "t-none", 1, "x")).toEqual({ ok: false, current: null });
    await expect(setLinqChatId(db.sql, thread.id, 0, "x")).rejects.toThrow(TypeError);
  });

  it("the version rule: an update that does not raise the version by one is refused", async () => {
    const refusedAs = { code: "23514", constraint: "threads_version_raised" };
    expect(await refusal(db.sql`update threads set linq_chat_id = 'z' where id = 't-mail-1'`)).toEqual(
      refusedAs,
    );
    expect(await refusal(db.sql`update threads set version = 5 where id = 't-mail-1'`)).toEqual(refusedAs);
  });
});

describe("the opener-sent mark per business", () => {
  it("is false until marked, then true for that business only, and the first mark stays", async () => {
    expect(await hasOpenerBeenSent(db.sql, "handle-alex", "biz-lees-barbershop")).toBe(true);
    const other = await db.sql<
      { id: string }[]
    >`select id from businesses where id <> 'biz-lees-barbershop' limit 1`;
    const otherId = other[0]?.id ?? "";
    expect(otherId).not.toBe("");
    expect(await hasOpenerBeenSent(db.sql, "handle-alex", otherId)).toBe(false);
    expect(await getOpenerSent(db.sql, "handle-alex", otherId)).toBeNull();

    const marked = await markOpenerSent(db.sql, {
      handleId: "handle-alex",
      businessId: otherId,
      outboxRowId: "out-other-1",
      sentAt: new Date("2026-10-25T10:00:00Z"),
    });
    expect(marked).toEqual({
      created: true,
      mark: {
        handleId: "handle-alex",
        businessId: otherId,
        sentAt: new Date("2026-10-25T10:00:00Z"),
        outboxRowId: "out-other-1",
      },
    });
    const again = await markOpenerSent(db.sql, {
      handleId: "handle-alex",
      businessId: otherId,
      outboxRowId: "out-other-2",
    });
    expect(again).toEqual({ created: false, mark: marked.mark });
    expect(await hasOpenerBeenSent(db.sql, "handle-alex", otherId)).toBe(true);
  });

  it("30 parallel marks give exactly one created", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        markOpenerSent(db.sql, {
          handleId: "h-chat-new",
          businessId: "biz-lees-barbershop",
          outboxRowId: `out-par-${String(index)}`,
        }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.mark.outboxRowId)).size).toBe(1);
  });

  it("keys: the handle and the business must exist and cannot be deleted under a mark", async () => {
    expect(
      await refusal(
        markOpenerSent(db.sql, {
          handleId: "handle-none",
          businessId: "biz-lees-barbershop",
          outboxRowId: "o",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "openers_sent_handle_fk" });
    expect(
      await refusal(
        markOpenerSent(db.sql, { handleId: "handle-alex", businessId: "biz-none", outboxRowId: "o" }),
      ),
    ).toEqual({ code: "23503", constraint: "openers_sent_business_fk" });
    expect(await refusal(db.sql`delete from businesses where id = 'biz-lees-barbershop'`)).toMatchObject({
      code: "23503",
    });
  });
});

describe("the message log: words sealed, last 6 with one business up to 30 days old", () => {
  const alexNow = new Date("2026-10-23T15:00:00Z");

  it("writes the fixture's messages with their words sealed; the table holds no plain words", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-thread-messages.json", async (values) => {
      await writeMessage(db.sql, keys, asNewMessage(values));
    });
    expect(result.loaded).toMatchObject({ threads: 2, openers_sent: 1, messages: 5 });

    const stored = await db.sql<{ id: string; words: string; version: number }[]>`
      select id, words, version from messages order by sent_at
    `;
    expect(stored.map((row) => row.id)).toEqual([
      "msg-alex-0001",
      "msg-alex-0002",
      "msg-alex-0007",
      "msg-alex-0008",
      "msg-alex-0009",
    ]);
    for (const row of stored) {
      expect(row.words.startsWith(SEALED_WORDS_PREFIX)).toBe(true);
      expect(row.version).toBe(1);
    }
    const plain = ["Haircut at", "This is Rosie", "Pick a new time", "Which time works"];
    for (const row of stored) {
      for (const fragment of plain) {
        expect(row.words.includes(fragment), `${row.id} holds "${fragment}"`).toBe(false);
      }
    }
    // Sealing twice gives different bytes: the same words are not recognisable across rows.
    expect(new Set(stored.map((row) => row.words)).size).toBe(stored.length);

    const message = await getMessage(db.sql, keys, "msg-alex-0002");
    expect(message).toMatchObject({
      words: "This is Rosie, the automated booking assistant for Lee's Barbershop.",
      readable: true,
      direction: "out",
      outboxRowId: "out-alex-first",
      deliveredAt: new Date("2026-10-12T16:20:05Z"),
      // The log writes a new message at version 1, whatever version the fixture row was stored at.
      version: 1,
    });
  });

  it("the words are unsealed with the person's key and the sealed text is for that person only", async () => {
    await createPerson(db.sql, { id: "person-other", name: "Demo Other" });
    const [row] = await db.sql<{ words: string }[]>`select words from messages where id = 'msg-alex-0001'`;
    const sealed = Uint8Array.from(atob((row?.words ?? "").slice(SEALED_WORDS_PREFIX.length)), (c) =>
      c.charCodeAt(0),
    );
    expect(await unsealText(db.sql, keys, "person-alex", sealed)).toBe(
      "Haircut at Lee's Barbershop this Saturday?",
    );
    // Person-other has no key at all, so there is nothing to open it with.
    await expect(unsealText(db.sql, keys, "person-other", sealed)).rejects.toMatchObject({ code: "no_key" });
  });

  it("returns the messages with one business, oldest first, up to 30 days old", async () => {
    const all = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
      now: alexNow,
    });
    expect(all.map((message) => message.id)).toEqual([
      "msg-alex-0001",
      "msg-alex-0002",
      "msg-alex-0007",
      "msg-alex-0008",
      "msg-alex-0009",
    ]);
    expect(all.map((message) => message.words)).toEqual([
      "Haircut at Lee's Barbershop this Saturday?",
      "This is Rosie, the automated booking assistant for Lee's Barbershop.",
      "1",
      "Sure. Pick a new time for your haircut at Lee's Barbershop with Riley.\nWhich time works?",
      "A",
    ]);
    // On 2026-11-15 the two messages of 2026-10-12 are more than 30 days old.
    const later = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(later.map((message) => message.id)).toEqual(["msg-alex-0007", "msg-alex-0008", "msg-alex-0009"]);
    // Exactly 30 days is still in; a moment more is out.
    const edge = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
      now: new Date("2026-11-11T16:20:00Z"),
    });
    expect(edge.map((message) => message.id)).toContain("msg-alex-0001");
    const past = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
      now: new Date("2026-11-11T16:20:01Z"),
    });
    expect(past.map((message) => message.id)).not.toContain("msg-alex-0001");
    expect(
      await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
        now: new Date("2027-03-01T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("keeps the latest 6 of many, in order, and leaves out another business's messages", async () => {
    await createBusiness(db.sql, { id: "biz-more", name: "More", displayName: "More", timeZone: "UTC" });
    const base = new Date("2026-10-30T10:00:00Z").getTime();
    const write = async (n: number, businessId: string, minutes: number): Promise<void> => {
      await writeMessage(db.sql, keys, {
        id: `msg-many-${businessId}-${String(n)}`,
        threadId: "thread-alex-chat",
        businessId,
        direction: "in",
        channel: "text",
        service: "imessage",
        fromRole: "customer",
        toRole: "rosie",
        personId: "person-alex",
        words: `many ${String(n)}`,
        eventId: `evt-many-${businessId}-${String(n)}`,
        sentAt: new Date(base + minutes * 60_000),
      });
    };
    // Written out of order on purpose: the order comes from sent_at, not from the insert.
    for (const n of [5, 1, 8, 3, 9, 2, 7, 4, 6]) {
      await write(n, "biz-lees-barbershop", n);
      await write(n, "biz-more", n + 0.5);
    }
    const now = new Date("2026-10-31T10:00:00Z");
    const six = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", { now });
    expect(CONTEXT_MESSAGE_LIMIT).toBe(6);
    expect(CONTEXT_MESSAGE_MAX_AGE_DAYS).toBe(30);
    expect(six.map((message) => message.words)).toEqual([
      "many 4",
      "many 5",
      "many 6",
      "many 7",
      "many 8",
      "many 9",
    ]);
    expect(new Set(six.map((message) => message.businessId))).toEqual(new Set(["biz-lees-barbershop"]));
    const more = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-more", { now, limit: 2 });
    expect(more.map((message) => message.words)).toEqual(["many 8", "many 9"]);
    await expect(
      listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-more", { limit: -1 }),
    ).rejects.toThrow(TypeError);
  });

  it("after erasePerson() the words are unreadable: the read gives null, and the stored text cannot be opened", async () => {
    await createPerson(db.sql, { id: "person-erase", name: "Demo Erase" });
    await createHandle(db.sql, { id: "h-erase", kind: "email", address: "erase@example.com" });
    const thread = await createThread(db.sql, {
      id: "t-erase",
      handleId: "h-erase",
      kind: "email",
      bookingId: "b-erase",
      replyAddress: "b-erase@reply.example.com",
    });
    const words = "Please move my appointment to Friday.";
    for (const [n, from, to, direction] of [
      [1, "customer", "rosie", "in"],
      [2, "rosie", "customer", "out"],
    ] as const) {
      await writeMessage(db.sql, keys, {
        id: `msg-erase-${String(n)}`,
        threadId: thread.id,
        businessId: "biz-lees-barbershop",
        direction,
        channel: "email",
        fromRole: from,
        toRole: to,
        personId: "person-erase",
        words: `${words} ${String(n)}`,
        eventId: direction === "in" ? "evt-erase-1" : null,
        outboxRowId: direction === "out" ? "out-erase-2" : null,
        sentAt: new Date(`2026-10-30T09:0${String(n)}:00Z`),
      });
    }
    const now = new Date("2026-10-31T00:00:00Z");
    const before = await listRecentMessages(db.sql, keys, thread.id, "biz-lees-barbershop", { now });
    expect(before.map((message) => message.words)).toEqual([`${words} 1`, `${words} 2`]);

    const [row] = await db.sql<{ words: string }[]>`select words from messages where id = 'msg-erase-1'`;
    const sealed = Uint8Array.from(atob((row?.words ?? "").slice(SEALED_WORDS_PREFIX.length)), (c) =>
      c.charCodeAt(0),
    );

    const erased = await erasePerson(db.sql, "person-erase");
    expect(erased.ok).toBe(true);

    const after = await listRecentMessages(db.sql, keys, thread.id, "biz-lees-barbershop", { now });
    expect(after.map((message) => [message.id, message.words, message.readable])).toEqual([
      ["msg-erase-1", null, false],
      ["msg-erase-2", null, false],
    ]);
    expect(await getMessage(db.sql, keys, "msg-erase-1")).toMatchObject({ words: null, readable: false });
    await expect(unsealText(db.sql, keys, "person-erase", sealed)).rejects.toMatchObject({ code: "erased" });
    // Nothing new can be sealed for them either.
    await expect(
      writeMessage(db.sql, keys, {
        id: "msg-erase-3",
        threadId: thread.id,
        businessId: "biz-lees-barbershop",
        direction: "in",
        channel: "email",
        fromRole: "customer",
        toRole: "rosie",
        personId: "person-erase",
        words: "again",
        eventId: "evt-erase-3",
        sentAt: new Date("2026-10-30T10:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(SealingError);
    // The other people's words are still readable.
    const alex = await listRecentMessages(db.sql, keys, "thread-alex-chat", "biz-lees-barbershop", {
      now: alexNow,
    });
    expect(alex.every((message) => message.readable)).toBe(true);
  });

  it("a read refuses stored words that are not sealed words, and a missing environment key", async () => {
    await db.sql`
      insert into messages (id, thread_id, business_id, direction, channel, from_role, to_role, person_id, words, event_id, sent_at)
      values ('msg-plain', 'thread-alex-chat', 'biz-lees-barbershop', 'in', 'text', 'customer', 'rosie', 'person-alex',
              'plain words', 'evt-plain', '2026-10-30T12:00:00Z')
    `;
    await expect(getMessage(db.sql, keys, "msg-plain")).rejects.toMatchObject({ code: "bad_format" });
    await expect(getMessage(db.sql, { resolve: () => undefined }, "msg-alex-0001")).rejects.toMatchObject({
      code: "wrapping_key_missing",
    });
    await db.sql`delete from messages where id = 'msg-plain'`;
  });

  it("markMessageDelivered is a compare-and-set and keeps the first delivery time", async () => {
    const written = await writeMessage(db.sql, keys, {
      id: "msg-deliver",
      threadId: "thread-alex-chat",
      businessId: "biz-lees-barbershop",
      direction: "out",
      channel: "text",
      service: "imessage",
      fromRole: "rosie",
      toRole: "customer",
      personId: "person-alex",
      words: "Delivered soon.",
      outboxRowId: "out-deliver",
      sentAt: new Date("2026-10-30T13:00:00Z"),
    });
    expect(written).toMatchObject({ version: 1, deliveredAt: null, words: "Delivered soon." });
    const t1 = new Date("2026-10-30T13:00:05Z");
    const first = await markMessageDelivered(db.sql, keys, "msg-deliver", 1, t1);
    expect(first).toMatchObject({ ok: true, row: { deliveredAt: t1, version: 2, words: "Delivered soon." } });
    const stale = await markMessageDelivered(
      db.sql,
      keys,
      "msg-deliver",
      1,
      new Date("2026-10-30T14:00:00Z"),
    );
    expect(stale).toMatchObject({ ok: false, current: { deliveredAt: t1, version: 2 } });
    expect(await markMessageDelivered(db.sql, keys, "msg-none", 1)).toEqual({ ok: false, current: null });
    expect(await refusal(db.sql`update messages set delivered_at = now() where id = 'msg-deliver'`)).toEqual({
      code: "23514",
      constraint: "messages_version_raised",
    });
  });

  it("the table refuses a message that breaks a rule of the table list", async () => {
    const base: NewMessage = {
      id: "msg-rule",
      threadId: "thread-alex-chat",
      businessId: "biz-lees-barbershop",
      direction: "in",
      channel: "text",
      service: "imessage",
      fromRole: "customer",
      toRole: "rosie",
      personId: "person-alex",
      words: "rule",
      eventId: "evt-rule",
      sentAt: new Date("2026-10-30T15:00:00Z"),
    };
    const refused = (changes: Partial<NewMessage>) =>
      refusal(writeMessage(db.sql, keys, { ...base, ...changes }));
    expect(await refused({ threadId: "t-none" })).toEqual({
      code: "23503",
      constraint: "messages_thread_fk",
    });
    expect(await refused({ businessId: "biz-none" })).toEqual({
      code: "23503",
      constraint: "messages_business_fk",
    });
    expect(await refused({ eventId: null })).toEqual({ code: "23514", constraint: "messages_in_has_event" });
    expect(await refused({ eventId: "evt-alex-0001" })).toEqual({
      code: "23505",
      constraint: "messages_event_id_key",
    });
    expect(await refused({ channel: "page", service: "imessage" })).toEqual({
      code: "23514",
      constraint: "messages_service_only_for_text",
    });
    expect(await refused({ service: "mms" as "sms" })).toEqual({
      code: "23514",
      constraint: "messages_service_known",
    });
    expect(await refused({ channel: "voice" as "text", service: null })).toEqual({
      code: "23514",
      constraint: "messages_channel_known",
    });
    expect(await refused({ direction: "sideways" as "in" })).toEqual({
      code: "23514",
      constraint: "messages_direction_known",
    });
    expect(await refused({ fromRole: "robot" as "ai" })).toEqual({
      code: "23514",
      constraint: "messages_from_role_known",
    });
    expect(await refused({ toRole: "robot" as "ai" })).toEqual({
      code: "23514",
      constraint: "messages_to_role_known",
    });
    expect(await refused({ direction: "out", eventId: null, outboxRowId: null })).toEqual({
      code: "23514",
      constraint: "messages_out_has_row",
    });
    // A page or AI message out needs no outbox row; a message with no business is allowed (sign-up's first texts).
    await writeMessage(db.sql, keys, {
      ...base,
      id: "msg-page-out",
      direction: "out",
      channel: "page",
      service: null,
      fromRole: "rosie",
      toRole: "customer",
      eventId: null,
      businessId: null,
    });
    expect(await getMessage(db.sql, keys, "msg-page-out")).toMatchObject({
      businessId: null,
      readable: true,
    });
    // Words are never stored as given: nothing but sealed text reaches the column.
    const [row] = await db.sql<{ words: string }[]>`select words from messages where id = 'msg-page-out'`;
    expect(row?.words.includes("rule")).toBe(false);
  });

  it("a message's thread, business and person cannot be deleted while it names them", async () => {
    expect(await refusal(db.sql`delete from threads where id = 'thread-alex-chat'`)).toEqual({
      code: "23503",
      constraint: "messages_thread_fk",
    });
    expect(await refusal(db.sql`delete from persons where id = 'person-alex'`)).toMatchObject({
      code: "23503",
    });
  });
});
