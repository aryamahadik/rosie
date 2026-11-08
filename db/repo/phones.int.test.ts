// T-183: handles, person_handles, phones with the stopped flag, and pauses against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/phones`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBusiness, createPerson } from "./people";
import {
  addPersonHandle,
  clearPause,
  createHandle,
  createPause,
  createPhone,
  getHandle,
  getHandleByAddress,
  getPause,
  getPhone,
  getPhoneByHandle,
  listHandleIdsOfPerson,
  listOpenPausesOfPerson,
  listOpenPausesOfPhone,
  listPersonIdsOfHandle,
  type Phone,
  recordChatOpened,
  recordLinqContactAdded,
  recordOptoutLineDelivered,
  recordPollVoted,
  removePersonHandle,
  setPhoneStopped,
  startPhone,
  stopPhone,
} from "./phones";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const OWN_TABLES = ["handles", "person_handles", "phones", "pauses"] as const;
// Tables the fixtures' `after` chains bring in from the earlier migrations (0002).
const EARLIER_TABLES = ["businesses", "persons", "person_roles"];
const LOADABLE_TABLES: readonly string[] = [...EARLIER_TABLES, ...OWN_TABLES];

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
  unique?: { name: string; columns: string[] }[];
  indexes?: { name: string; columns: string[]; where?: string }[];
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

async function loadFixture(
  sql: Sql,
  file: string,
): Promise<{ loaded: Record<string, number>; skipped: string[] }> {
  const loaded: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const row of fixtureRows(file)) {
    if (!LOADABLE_TABLES.includes(row.table)) {
      skipped.add(row.table);
      continue;
    }
    const values: Record<string, string | number | boolean | Uint8Array | null> = { ...row.values };
    // A sealed address is written as \x and hex in the fixture; the driver wants the bytes.
    if (row.table === "pauses" && typeof values.address === "string") {
      values.address = fromHex(values.address.replace(/^\\x/, ""));
    }
    await sql`insert into ${sql(row.table)} ${sql(values)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return { loaded, skipped: [...skipped].sort() };
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Later migrations add tables that reference these (0005's threads, openers_sent and messages first), so the
// truncate cascades to them. Each test file runs in its own schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate pauses, turns, phones, person_handles, handles, person_roles, sealing_keys, persons, businesses cascade`;
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
let counter = 0;

/** A new handle and its phone row, on a number made from the counter: a test number, never a real one. */
async function newPhone(sql: Sql = db.sql): Promise<Phone> {
  counter += 1;
  const number = `+1555555${String(1000 + counter).padStart(4, "0")}`;
  await createHandle(sql, { id: `handle-t${String(counter)}`, kind: "phone", address: number });
  return createPhone(sql, { number, handleId: `handle-t${String(counter)}` });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "phones" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    boolean: "boolean",
    bytea: "bytea",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the four tables of the card", () => {
    expect(tables.map((table) => table.name)).toEqual(["handles", "person_handles", "phones", "pauses"]);
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
      // pauses_turn_fk is here too: the turns migration (T-188) adds it.
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
      for (const rule of table.unique ?? []) {
        const index = indexes.find((candidate) => candidate.name === rule.name);
        expect(index?.definition).toContain("CREATE UNIQUE INDEX");
        expect(index?.definition).toContain(`(${rule.columns.join(", ")})`);
      }
      for (const wanted of table.indexes ?? []) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
        if (wanted.where !== undefined) {
          expect(index?.definition).toContain("WHERE (cleared_at IS NULL)");
        }
      }
    });

    it(`${table.name}: foreign keys name the table list's targets and refuse deletes`, async () => {
      const keys = await db.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass and contype = 'f'
      `;
      for (const key of keys) {
        expect(key.definition, key.name).toContain("ON DELETE RESTRICT");
      }
    });

    it(`${table.name}: has a version column and a version trigger exactly when the table list says versioned`, async () => {
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

  it("is expand only: the four tables are plain tables, and the table list has no row-level security yet here", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('handles', 'person_handles', 'phones', 'pauses')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind])).toEqual([
      ["handles", "r"],
      ["pauses", "r"],
      ["person_handles", "r"],
      ["phones", "r"],
    ]);
  });

  it("is recorded in schema_migrations after 0001 to 0003", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name).slice(0, 4)).toEqual([
      "init",
      "core_business_people",
      "core_sealing_keys",
      "core_handles_phones",
    ]);
  });
});

describe("fixtures seed-phone-chat-open, seed-phone-stopped and seed-pause", () => {
  it("seed-phone-chat-open loads with its after chain: 6 phones, chat open, with their stored versions", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-phone-chat-open.json");
    expect(result).toEqual({
      loaded: { businesses: 3, persons: 6, handles: 7, person_handles: 7, person_roles: 9, phones: 6 },
      skipped: [],
    });
    const phones = await db.sql<{ number: string; way: string | null; open: boolean; version: number }[]>`
      select number, chat_way as way, chat_open as open, version from phones order by number
    `;
    expect(phones).toEqual([
      { number: "+15555550100", way: "imessage", open: true, version: 2 },
      { number: "+15555550101", way: "imessage", open: true, version: 3 },
      { number: "+15555550102", way: "imessage", open: true, version: 2 },
      { number: "+15555550103", way: "imessage", open: true, version: 2 },
      { number: "+15555550104", way: "imessage", open: true, version: 2 },
      { number: "+15555550105", way: "rcs", open: true, version: 2 },
    ]);
    const alex = await getPhone(db.sql, "+15555550101");
    expect(alex).toMatchObject({
      handleId: "handle-alex",
      stopped: false,
      stopAt: null,
      startAt: null,
      chatOpenAt: new Date("2026-10-12T16:20:00Z"),
      linqContactAddedAt: new Date("2026-10-12T16:20:00Z"),
      optoutLineDeliveredAt: new Date("2026-10-12T16:20:00Z"),
      pollVotedAt: new Date("2026-10-23T14:06:10Z"),
    });
    // Poll vote is stored for Alex only.
    const voted = await db.sql<
      { number: string }[]
    >`select number from phones where poll_voted_at is not null`;
    expect(voted.map((row) => row.number)).toEqual(["+15555550101"]);
    // Alex writes from a phone and an email; one handle each.
    expect(await listHandleIdsOfPerson(db.sql, "person-alex")).toEqual(["handle-alex", "handle-alex-email"]);
    expect(await listPersonIdsOfHandle(db.sql, "handle-alex-email")).toEqual(["person-alex"]);
    expect(await getHandleByAddress(db.sql, "alex@example.com")).toEqual({
      id: "handle-alex-email",
      kind: "email",
      address: "alex@example.com",
    });
    expect(await getPhoneByHandle(db.sql, "handle-tomas")).toMatchObject({
      number: "+15555550105",
      chatWay: "rcs",
    });
  });

  it("seed-phone-stopped loads with its after chain: Ben's phone is stopped, with its stop time and no start", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-phone-stopped.json");
    expect(result).toEqual({
      loaded: { businesses: 3, persons: 1, handles: 1, person_handles: 1, person_roles: 1, phones: 1 },
      skipped: [],
    });
    expect(await getPhone(db.sql, "+15555550106")).toEqual({
      number: "+15555550106",
      handleId: "handle-ben",
      chatOpen: false,
      chatOpenAt: new Date("2026-10-05T17:00:00Z"),
      chatWay: "imessage",
      stopped: true,
      stopAt: new Date("2026-10-20T13:00:00Z"),
      startAt: null,
      linqContactAddedAt: new Date("2026-10-05T17:00:00Z"),
      pollVotedAt: null,
      optoutLineDeliveredAt: new Date("2026-10-05T17:00:02Z"),
      version: 3,
    });
  });

  it("seed-pause loads after both: a phone pause and a cleared sealed address pause", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-pause.json");
    expect(result).toEqual({
      loaded: {
        businesses: 3,
        persons: 7,
        handles: 8,
        person_handles: 8,
        person_roles: 10,
        phones: 1,
        pauses: 2,
      },
      skipped: [],
    });
    const phonePause = await getPause(db.sql, "pause-ben-phone");
    expect(phonePause).toMatchObject({
      businessId: "biz-lees-barbershop",
      target: "phone",
      phoneNumber: "+15555550106",
      address: null,
      clearedAt: null,
      version: 1,
    });
    const addressPause = await getPause(db.sql, "pause-alex-address");
    expect(addressPause).toMatchObject({
      target: "address",
      sealedForPersonId: "person-alex",
      clearedAt: new Date("2026-10-22T19:30:00Z"),
      clearedByPersonId: "person-sam",
      version: 2,
    });
    expect(toHex(addressPause?.address ?? new Uint8Array())).toBe(
      "6b30342d736565642d7365616c65642d616464726573732d6e6f742d7265616c",
    );
    expect((await listOpenPausesOfPhone(db.sql, "+15555550106")).map((pause) => pause.id)).toEqual([
      "pause-ben-phone",
    ]);
    expect(await listOpenPausesOfPerson(db.sql, "person-alex")).toEqual([]);
  });

  it("every fixture row of these three files loaded: nothing was skipped for want of a table", () => {
    for (const file of ["seed-phone-chat-open.json", "seed-phone-stopped.json", "seed-pause.json"]) {
      const tablesNeeded = new Set(fixtureRows(file).map((row) => row.table));
      for (const table of tablesNeeded) {
        expect(LOADABLE_TABLES, `${file} needs ${table}`).toContain(table);
      }
    }
  });
});

describe("handles and person_handles", () => {
  it("one handle per address; the address is an E.164 phone or a lower-case email", async () => {
    await emptyTables(db.sql);
    const made = await createHandle(db.sql, { id: "h-1", kind: "phone", address: "+15555559001" });
    expect(made).toEqual({ id: "h-1", kind: "phone", address: "+15555559001" });
    expect(await getHandle(db.sql, "h-1")).toEqual(made);
    expect(await getHandle(db.sql, "h-none")).toBeNull();
    expect(
      await refusal(createHandle(db.sql, { id: "h-2", kind: "phone", address: "+15555559001" })),
    ).toEqual({
      code: "23505",
      constraint: "handles_address_key",
    });
    expect(
      await refusal(createHandle(db.sql, { id: "h-1", kind: "phone", address: "+15555559002" })),
    ).toEqual({
      code: "23505",
      constraint: "handles_pkey",
    });
    for (const address of [
      "5555559003",
      "+05555559003",
      "+1555",
      "+1555555900312345",
      "+1 555 555 9003",
      "",
    ]) {
      expect(await refusal(createHandle(db.sql, { id: "h-bad", kind: "phone", address }))).toEqual({
        code: "23514",
        constraint: "handles_address_form",
      });
    }
    for (const address of ["Sam@Example.com", "sam@", "@example.com", "sam example@x.com", "sam"]) {
      expect(await refusal(createHandle(db.sql, { id: "h-bad", kind: "email", address }))).toEqual({
        code: "23514",
        constraint: "handles_address_form",
      });
    }
    // A phone address under kind email, and an email under kind phone, are refused.
    expect(
      await refusal(createHandle(db.sql, { id: "h-bad", kind: "email", address: "+15555559004" })),
    ).toEqual({
      code: "23514",
      constraint: "handles_address_form",
    });
    expect(await refusal(createHandle(db.sql, { id: "h-bad", kind: "phone", address: "a@b.co" }))).toEqual({
      code: "23514",
      constraint: "handles_address_form",
    });
    expect(
      await refusal(createHandle(db.sql, { id: "h-bad", kind: "sms" as "phone", address: "+15555559005" })),
    ).toMatchObject({ code: "23514" });
    await createHandle(db.sql, { id: "h-mail", kind: "email", address: "sam@example.com" });
    expect(await getHandleByAddress(db.sql, "sam@example.com")).toMatchObject({
      id: "h-mail",
      kind: "email",
    });
    expect(await getHandleByAddress(db.sql, "nobody@example.com")).toBeNull();
  });

  it("one handle can be several people, and a person can have several handles; rows are added and removed", async () => {
    await createPerson(db.sql, { id: "p-1", name: "Demo One" });
    await createPerson(db.sql, { id: "p-2", name: "Demo Two" });
    await addPersonHandle(db.sql, "p-1", "h-1");
    await addPersonHandle(db.sql, "p-2", "h-1");
    await addPersonHandle(db.sql, "p-1", "h-mail");
    // Saying it twice changes nothing.
    await addPersonHandle(db.sql, "p-1", "h-1");
    expect(await listPersonIdsOfHandle(db.sql, "h-1")).toEqual(["p-1", "p-2"]);
    expect(await listHandleIdsOfPerson(db.sql, "p-1")).toEqual(["h-1", "h-mail"]);

    await expect(addPersonHandle(db.sql, "p-none", "h-1")).rejects.toMatchObject({
      code: "23503",
      constraint_name: "person_handles_person_fk",
    });
    await expect(addPersonHandle(db.sql, "p-1", "h-none")).rejects.toMatchObject({
      code: "23503",
      constraint_name: "person_handles_handle_fk",
    });
    // Neither side can be deleted while a row names it.
    expect(await refusal(db.sql`delete from persons where id = 'p-1'`)).toEqual({
      code: "23503",
      constraint: "person_handles_person_fk",
    });
    expect(await refusal(db.sql`delete from handles where id = 'h-1'`)).toEqual({
      code: "23503",
      constraint: "person_handles_handle_fk",
    });

    expect(await removePersonHandle(db.sql, "p-2", "h-1")).toBe(true);
    expect(await removePersonHandle(db.sql, "p-2", "h-1")).toBe(false);
    expect(await listPersonIdsOfHandle(db.sql, "h-1")).toEqual(["p-1"]);
  });
});

describe("a phone row is unique per mobile across every business", () => {
  it("starts closed and not stopped at version 1; a second row for the number or the handle is refused", async () => {
    const phone = await newPhone();
    expect(phone).toEqual({
      number: phone.number,
      handleId: `handle-t${String(counter)}`,
      chatOpen: false,
      chatOpenAt: null,
      chatWay: null,
      stopped: false,
      stopAt: null,
      startAt: null,
      linqContactAddedAt: null,
      pollVotedAt: null,
      optoutLineDeliveredAt: null,
      version: 1,
    });
    expect(await refusal(createPhone(db.sql, { number: phone.number, handleId: phone.handleId }))).toEqual({
      code: "23505",
      constraint: "phones_pkey",
    });
    // Another number for the same handle: one phone row per handle.
    expect(await refusal(createPhone(db.sql, { number: "+15555558999", handleId: phone.handleId }))).toEqual({
      code: "23505",
      constraint: "phones_handle_key",
    });
    expect(await getPhone(db.sql, "+15555558999")).toBeNull();
    const rows = await db.sql`select 1 from phones where number = ${phone.number}`;
    expect(rows).toHaveLength(1);
  });

  it("a phone needs a handle whose address is its number, and an email handle cannot have one", async () => {
    await createHandle(db.sql, { id: "h-own", kind: "phone", address: "+15555558001" });
    await createHandle(db.sql, { id: "h-other", kind: "phone", address: "+15555558002" });
    expect(await refusal(createPhone(db.sql, { number: "+15555558001", handleId: "h-other" }))).toEqual({
      code: "23503",
      constraint: "phones_handle_fk",
    });
    expect(await refusal(createPhone(db.sql, { number: "+15555558001", handleId: "h-none" }))).toEqual({
      code: "23503",
      constraint: "phones_handle_fk",
    });
    expect(await refusal(createPhone(db.sql, { number: "bad", handleId: "h-own" }))).toEqual({
      code: "23514",
      constraint: "phones_number_form",
    });
    await createHandle(db.sql, { id: "h-email-only", kind: "email", address: "e@example.com" });
    expect(await refusal(createPhone(db.sql, { number: "e@example.com", handleId: "h-email-only" }))).toEqual(
      {
        code: "23514",
        constraint: "phones_number_form",
      },
    );
    const made = await createPhone(db.sql, { number: "+15555558001", handleId: "h-own" });
    expect(made.number).toBe("+15555558001");
    // A handle with a phone row cannot be deleted.
    expect(await refusal(db.sql`delete from handles where id = 'h-own'`)).toEqual({
      code: "23503",
      constraint: "phones_handle_fk",
    });
  });

  it("is one row every business reads: STOP from one business's scope shows in another's", async () => {
    await createBusiness(db.sql, { id: "biz-a", name: "A", displayName: "A", timeZone: "UTC" });
    await createBusiness(db.sql, { id: "biz-b", name: "B", displayName: "B", timeZone: "UTC" });
    const phone = await newPhone();
    const stopped = await db.client.withBusiness("biz-a", (tx) => setPhoneStopped(tx, phone.number, true));
    expect(stopped).toMatchObject({ changed: true, phone: { stopped: true, version: 2 } });
    const seenByB = await db.client.withBusiness("biz-b", (tx) => getPhone(tx, phone.number));
    expect(seenByB).toMatchObject({ stopped: true, chatOpen: false, version: 2 });
    const started = await db.client.withBusiness("biz-b", (tx) => setPhoneStopped(tx, phone.number, false));
    expect(started).toMatchObject({ changed: true, phone: { stopped: false, version: 3 } });
    const seenByA = await db.client.withBusiness("biz-a", (tx) => getPhone(tx, phone.number));
    expect(seenByA).toMatchObject({ stopped: false, version: 3 });
  });
});

describe("the stopped flag", () => {
  it("STOP records the stop time and closes the chat; START clears the flag with a start time and opens it", async () => {
    const phone = await newPhone();
    const opened = await recordChatOpened(db.sql, phone.number, 1, {
      chatWay: "imessage",
      at: new Date("2026-11-01T10:00:00Z"),
    });
    expect(opened).toMatchObject({
      ok: true,
      row: { chatOpen: true, chatOpenAt: new Date("2026-11-01T10:00:00Z"), chatWay: "imessage", version: 2 },
    });

    const stop = await stopPhone(db.sql, phone.number, 2, new Date("2026-11-02T10:00:00Z"));
    expect(stop).toMatchObject({
      ok: true,
      row: {
        stopped: true,
        chatOpen: false,
        stopAt: new Date("2026-11-02T10:00:00Z"),
        startAt: null,
        chatOpenAt: new Date("2026-11-01T10:00:00Z"),
        version: 3,
      },
    });

    // A text while stopped is not a START: the chat stays closed.
    const text = await recordChatOpened(db.sql, phone.number, 3, { at: new Date("2026-11-02T11:00:00Z") });
    expect(text).toMatchObject({ ok: true, row: { stopped: true, chatOpen: false, version: 4 } });

    const start = await startPhone(db.sql, phone.number, 4, new Date("2026-11-03T10:00:00Z"));
    expect(start).toMatchObject({
      ok: true,
      row: {
        stopped: false,
        chatOpen: true,
        // The stop time stays as the last STOP's.
        stopAt: new Date("2026-11-02T10:00:00Z"),
        startAt: new Date("2026-11-03T10:00:00Z"),
        version: 5,
      },
    });
  });

  it("without a given time, STOP and START take the database clock, and START never comes before its STOP", async () => {
    const phone = await newPhone();
    const stopped = await setPhoneStopped(db.sql, phone.number, true);
    const started = await setPhoneStopped(db.sql, phone.number, false);
    expect(stopped?.phone.stopAt).toBeInstanceOf(Date);
    expect(started?.phone.startAt).toBeInstanceOf(Date);
    expect(started?.phone.startAt?.getTime()).toBeGreaterThanOrEqual(
      stopped?.phone.stopAt?.getTime() ?? Infinity,
    );
    // START on a phone never opened sets the first-text time too.
    expect(started?.phone.chatOpenAt).toBeInstanceOf(Date);
  });

  it("a stale STOP or START changes nothing and returns the row as it is now", async () => {
    const phone = await newPhone();
    const first = await stopPhone(db.sql, phone.number, 1);
    expect(first.ok).toBe(true);
    const stale = await startPhone(db.sql, phone.number, 1);
    expect(stale).toEqual({ ok: false, current: await getPhone(db.sql, phone.number) });
    expect(stale.ok ? null : stale.current).toMatchObject({ stopped: true, version: 2 });
    expect(await stopPhone(db.sql, "+15555550000", 1)).toEqual({ ok: false, current: null });
    await expect(stopPhone(db.sql, phone.number, 0)).rejects.toThrow(TypeError);
    await expect(startPhone(db.sql, phone.number, 1.5)).rejects.toThrow(TypeError);
  });

  it("setPhoneStopped leaves a repeat alone: no write, no version spent, the first stop time kept", async () => {
    const phone = await newPhone();
    const first = await setPhoneStopped(db.sql, phone.number, true, { at: new Date("2026-11-04T09:00:00Z") });
    const again = await setPhoneStopped(db.sql, phone.number, true, { at: new Date("2026-11-04T09:30:00Z") });
    expect(first).toMatchObject({ changed: true });
    expect(again).toEqual({ changed: false, phone: first?.phone });
    expect(again?.phone.stopAt).toEqual(new Date("2026-11-04T09:00:00Z"));
    expect(again?.phone.version).toBe(2);
    expect(await setPhoneStopped(db.sql, "+15555550000", true)).toBeNull();
    await expect(setPhoneStopped(db.sql, phone.number, false, { maxAttempts: 0 })).rejects.toThrow(
      /lost 0 rounds/,
    );
  });

  it("the table refuses a stopped phone with its chat open, or with no stop time", async () => {
    const phone = await newPhone();
    expect(
      await refusal(
        db.sql`update phones set stopped = true, chat_open = true, stop_at = now(), version = 2 where number = ${phone.number}`,
      ),
    ).toEqual({ code: "23514", constraint: "phones_stop_closes_chat" });
    expect(
      await refusal(db.sql`update phones set stopped = true, version = 2 where number = ${phone.number}`),
    ).toEqual({ code: "23514", constraint: "phones_stopped_has_time" });
    expect(await getPhone(db.sql, phone.number)).toMatchObject({ stopped: false, version: 1 });
  });

  it("the way Linq reports is imessage, rcs or sms, or null", async () => {
    const phone = await newPhone();
    for (const [index, way] of (["imessage", "rcs", "sms"] as const).entries()) {
      const result = await recordChatOpened(db.sql, phone.number, index + 1, { chatWay: way });
      expect(result).toMatchObject({ ok: true, row: { chatWay: way } });
    }
    expect(
      await refusal(db.sql`update phones set chat_way = 'mms', version = 5 where number = ${phone.number}`),
    ).toEqual({ code: "23514", constraint: "phones_chat_way_known" });
    // A later text without a way keeps the last one reported.
    expect(await recordChatOpened(db.sql, phone.number, 4)).toMatchObject({
      ok: true,
      row: { chatWay: "sms" },
    });
  });

  it("Linq contact, poll vote and opt-out line are each recorded once: the first time stays", async () => {
    const phone = await newPhone();
    const t1 = new Date("2026-11-05T10:00:00Z");
    const t2 = new Date("2026-11-05T11:00:00Z");
    expect(await recordLinqContactAdded(db.sql, phone.number, 1, t1)).toMatchObject({
      ok: true,
      row: { linqContactAddedAt: t1, version: 2 },
    });
    expect(await recordLinqContactAdded(db.sql, phone.number, 2, t2)).toMatchObject({
      ok: true,
      row: { linqContactAddedAt: t1, version: 3 },
    });
    expect(await recordPollVoted(db.sql, phone.number, 3, t1)).toMatchObject({
      ok: true,
      row: { pollVotedAt: t1, version: 4 },
    });
    expect(await recordPollVoted(db.sql, phone.number, 4, t2)).toMatchObject({
      ok: true,
      row: { pollVotedAt: t1, version: 5 },
    });
    expect(await recordOptoutLineDelivered(db.sql, phone.number, 5, t1)).toMatchObject({
      ok: true,
      row: { optoutLineDeliveredAt: t1, version: 6 },
    });
    expect(await recordOptoutLineDelivered(db.sql, phone.number, 5, t2)).toMatchObject({
      ok: false,
      current: { optoutLineDeliveredAt: t1, version: 6 },
    });
  });
});

describe("the version rule on phones and pauses: an update that does not raise the version by one is refused", () => {
  it("phones", async () => {
    const phone = await newPhone();
    const refusedAs = { code: "23514", constraint: "phones_version_raised" };
    expect(await refusal(db.sql`update phones set chat_way = 'sms' where number = ${phone.number}`)).toEqual(
      refusedAs,
    );
    expect(
      await refusal(db.sql`update phones set chat_way = 'sms', version = 1 where number = ${phone.number}`),
    ).toEqual(refusedAs);
    expect(await refusal(db.sql`update phones set version = 3 where number = ${phone.number}`)).toEqual(
      refusedAs,
    );
    expect(await getPhone(db.sql, phone.number)).toMatchObject({ chatWay: null, version: 1 });
    await db.sql`update phones set chat_way = 'sms', version = version + 1 where number = ${phone.number}`;
    expect(await getPhone(db.sql, phone.number)).toMatchObject({ chatWay: "sms", version: 2 });
  });

  it("pauses", async () => {
    await createBusiness(db.sql, { id: "biz-pv", name: "PV", displayName: "PV", timeZone: "UTC" });
    await createPerson(db.sql, { id: "p-pv", name: "Demo" });
    await createPause(db.sql, { id: "pause-pv", businessId: "biz-pv", target: "person", personId: "p-pv" });
    const refusedAs = { code: "23514", constraint: "pauses_version_raised" };
    expect(await refusal(db.sql`update pauses set cleared_at = now() where id = 'pause-pv'`)).toEqual(
      refusedAs,
    );
    expect(
      await refusal(db.sql`update pauses set cleared_at = now(), version = 4 where id = 'pause-pv'`),
    ).toEqual(refusedAs);
    expect(await getPause(db.sql, "pause-pv")).toMatchObject({ clearedAt: null, version: 1 });
  });
});

describe("parallel STOP and START writes on one phone", () => {
  it("50 compare-and-set writes from the same read: exactly one wins, the rest get the row as it now is", async () => {
    const phone = await newPhone();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        index % 2 === 0 ? stopPhone(db.sql, phone.number, 1) : startPhone(db.sql, phone.number, 1),
      ),
    );
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const final = await getPhone(db.sql, phone.number);
    expect(final?.version).toBe(2);
    expect(final).toEqual(winners[0]?.ok ? winners[0].row : null);
    for (const result of results) {
      if (!result.ok) {
        expect(result.current).toEqual(final);
      }
    }
  });

  it("50 parallel STOP and START calls: every applied change has its own version, the final state is the last one's", async () => {
    const phone = await newPhone();
    const asks = Array.from({ length: 50 }, (_, index) => index % 2 === 0);
    const results = await Promise.all(asks.map((stop) => setPhoneStopped(db.sql, phone.number, stop)));

    // Every call answered, and a call that wrote nothing found the state already as it asked.
    expect(results.every((result) => result !== null)).toBe(true);
    const changes = results
      .flatMap((result, index) =>
        result?.changed === true ? [{ ask: asks[index], phone: result.phone }] : [],
      )
      .sort((a, b) => a.phone.version - b.phone.version);
    for (const [index, result] of results.entries()) {
      if (result?.changed === false) {
        expect(result.phone.stopped, `call ${String(index)} found the phone as asked`).toBe(asks[index]);
      }
    }
    expect(changes.length).toBeGreaterThanOrEqual(1);

    // The versions are 2, 3, 4 ... with no gap and no repeat: every change spent exactly one version.
    const final = await getPhone(db.sql, phone.number);
    expect(changes.map((change) => change.phone.version)).toEqual(
      Array.from({ length: changes.length }, (_, index) => index + 2),
    );
    expect(final?.version).toBe(1 + changes.length);

    // The changes alternate from "not stopped": STOP, START, STOP ...; each wrote the state it asked for.
    changes.forEach((change, index) => {
      expect(change.phone.stopped).toBe(index % 2 === 0);
      expect(change.ask).toBe(change.phone.stopped);
    });
    expect(final?.stopped).toBe(changes[changes.length - 1]?.phone.stopped);

    // The flag, its times and the chat flag agree, and the times never run backwards from one version to the next.
    if (final?.stopped === true) {
      expect(final.chatOpen).toBe(false);
      expect(final.stopAt).toBeInstanceOf(Date);
    } else {
      expect(final?.chatOpen).toBe(true);
      expect(final?.startAt).toBeInstanceOf(Date);
      expect(final?.startAt?.getTime()).toBeGreaterThanOrEqual(final?.stopAt?.getTime() ?? Infinity);
    }
    const times = changes.map((change) =>
      change.phone.stopped ? change.phone.stopAt : change.phone.startAt,
    );
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]?.getTime()).toBeGreaterThanOrEqual(times[index - 1]?.getTime() ?? Infinity);
    }
  });

  it("50 parallel STOPs: one change, the stop time of the first, and no version spent by the others", async () => {
    const phone = await newPhone();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => setPhoneStopped(db.sql, phone.number, true)),
    );
    const changed = results.filter((result) => result?.changed === true);
    expect(changed).toHaveLength(1);
    const final = await getPhone(db.sql, phone.number);
    expect(final).toMatchObject({ stopped: true, chatOpen: false, version: 2 });
    expect(final?.stopAt).toEqual(changed[0]?.phone.stopAt);
  });

  it("50 parallel STARTs on a stopped phone: one change, the rest find it started", async () => {
    const phone = await newPhone();
    await setPhoneStopped(db.sql, phone.number, true);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => setPhoneStopped(db.sql, phone.number, false)),
    );
    expect(results.filter((result) => result?.changed === true)).toHaveLength(1);
    expect(await getPhone(db.sql, phone.number)).toMatchObject({
      stopped: false,
      chatOpen: true,
      version: 3,
    });
  });
});

describe("pauses: the paused flag for a person, a phone or an address", () => {
  const SEALED = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it("sets a pause on each target and refuses a row that names the wrong fields", async () => {
    await createBusiness(db.sql, { id: "biz-pz", name: "PZ", displayName: "PZ", timeZone: "UTC" });
    await createPerson(db.sql, { id: "p-pz", name: "Demo" });
    const phone = await newPhone();
    // pauses_turn_fk (0009) checks setByTurnId, so the turn "turn-demo" exists first, on a registered bundle.
    const bundleHash = "a".repeat(64);
    await db.sql`
      insert into bundles (hash, build, manifest_key, built_at)
      values (${bundleHash}, 1, ${`bundle/${bundleHash}/1/manifest`}, now())
      on conflict do nothing
    `;
    await db.sql`
      insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
      values ('turn-demo', ${phone.handleId}, ${["evt-demo-1"]}, 'committed', ${bundleHash}, 1, 'trace-demo', now())
    `;

    const person = await createPause(db.sql, {
      id: "pz-person",
      businessId: "biz-pz",
      target: "person",
      personId: "p-pz",
      setAt: new Date("2026-11-06T10:00:00Z"),
    });
    expect(person).toEqual({
      id: "pz-person",
      businessId: "biz-pz",
      target: "person",
      personId: "p-pz",
      phoneNumber: null,
      address: null,
      sealedForPersonId: null,
      setByTurnId: null,
      setAt: new Date("2026-11-06T10:00:00Z"),
      clearedAt: null,
      clearedByPersonId: null,
      version: 1,
    });
    const byPhone = await createPause(db.sql, {
      id: "pz-phone",
      businessId: "biz-pz",
      target: "phone",
      phoneNumber: phone.number,
      setByTurnId: "turn-demo",
    });
    expect(byPhone).toMatchObject({ target: "phone", phoneNumber: phone.number, setByTurnId: "turn-demo" });
    expect(byPhone.setAt).toBeInstanceOf(Date);
    const byAddress = await createPause(db.sql, {
      id: "pz-address",
      businessId: "biz-pz",
      target: "address",
      address: SEALED,
      sealedForPersonId: "p-pz",
    });
    expect(Array.from(byAddress.address ?? [])).toEqual(Array.from(SEALED));
    expect(byAddress.sealedForPersonId).toBe("p-pz");

    const oneTarget = { code: "23514", constraint: "pauses_one_target" };
    expect(
      await refusal(
        db.sql`insert into pauses (id, business_id, target, person_id, phone_number, set_at)
               values ('pz-bad-1', 'biz-pz', 'person', 'p-pz', ${phone.number}, now())`,
      ),
    ).toEqual(oneTarget);
    expect(
      await refusal(
        db.sql`insert into pauses (id, business_id, target, set_at) values ('pz-bad-2', 'biz-pz', 'phone', now())`,
      ),
    ).toEqual(oneTarget);
    expect(
      await refusal(
        db.sql`insert into pauses (id, business_id, target, address, set_at)
               values ('pz-bad-3', 'biz-pz', 'address', ${SEALED}, now())`,
      ),
    ).toEqual(oneTarget);
    expect(
      await refusal(
        db.sql`insert into pauses (id, business_id, target, person_id, set_at)
               values ('pz-bad-4', 'biz-pz', 'team', 'p-pz', now())`,
      ),
    ).toMatchObject({ code: "23514" });
  });

  it("keys: business, person, phone, sealed-for and cleared-by must exist and cannot be deleted under a pause", async () => {
    const target = { id: "pz-fk", businessId: "biz-pz", target: "person" as const, personId: "p-pz" };
    expect(await refusal(createPause(db.sql, { ...target, businessId: "biz-none" }))).toEqual({
      code: "23503",
      constraint: "pauses_business_fk",
    });
    expect(await refusal(createPause(db.sql, { ...target, personId: "p-none" }))).toEqual({
      code: "23503",
      constraint: "pauses_person_fk",
    });
    expect(
      await refusal(
        createPause(db.sql, {
          id: "pz-fk",
          businessId: "biz-pz",
          target: "phone",
          phoneNumber: "+15555550000",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "pauses_phone_fk" });
    expect(
      await refusal(
        createPause(db.sql, {
          id: "pz-fk",
          businessId: "biz-pz",
          target: "address",
          address: SEALED,
          sealedForPersonId: "p-none",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "pauses_sealed_for_fk" });
    expect(await refusal(clearPause(db.sql, "pz-person", 1, "p-none"))).toEqual({
      code: "23503",
      constraint: "pauses_cleared_by_fk",
    });
    expect(await refusal(db.sql`delete from persons where id = 'p-pz'`)).toMatchObject({ code: "23503" });
    expect(await refusal(db.sql`delete from businesses where id = 'biz-pz'`)).toEqual({
      code: "23503",
      constraint: "pauses_business_fk",
    });
    const phonePause = await getPause(db.sql, "pz-phone");
    expect(await refusal(db.sql`delete from phones where number = ${phonePause?.phoneNumber ?? ""}`)).toEqual(
      {
        code: "23503",
        constraint: "pauses_phone_fk",
      },
    );
  });

  it("open pauses are listed for a person and a phone; the owner clears one once, and the row stays", async () => {
    await createPerson(db.sql, { id: "p-owner", name: "Owner" });
    const open = await listOpenPausesOfPerson(db.sql, "p-pz");
    expect(open.map((pause) => pause.id)).toEqual(["pz-person"]);
    const phonePause = await getPause(db.sql, "pz-phone");
    const phoneNumber = phonePause?.phoneNumber ?? "";
    expect((await listOpenPausesOfPhone(db.sql, phoneNumber)).map((pause) => pause.id)).toEqual(["pz-phone"]);

    const cleared = await clearPause(db.sql, "pz-person", 1, "p-owner", new Date("2026-11-06T12:00:00Z"));
    expect(cleared).toMatchObject({
      ok: true,
      row: {
        id: "pz-person",
        clearedAt: new Date("2026-11-06T12:00:00Z"),
        clearedByPersonId: "p-owner",
        version: 2,
      },
    });
    expect(await listOpenPausesOfPerson(db.sql, "p-pz")).toEqual([]);
    // Clearing again, or from an old read, changes nothing and returns the row as it is.
    const again = await clearPause(db.sql, "pz-person", 2, "p-owner");
    expect(again).toEqual({ ok: false, current: await getPause(db.sql, "pz-person") });
    expect(await clearPause(db.sql, "pz-phone", 9, "p-owner")).toMatchObject({
      ok: false,
      current: { id: "pz-phone", clearedAt: null, version: 1 },
    });
    expect(await clearPause(db.sql, "pz-none", 1, "p-owner")).toEqual({ ok: false, current: null });
    expect(await getPause(db.sql, "pz-person")).toMatchObject({ clearedByPersonId: "p-owner", version: 2 });
    // A cleared pause stays, and a new one can be set on the same target.
    await createPause(db.sql, {
      id: "pz-person-2",
      businessId: "biz-pz",
      target: "person",
      personId: "p-pz",
    });
    expect((await listOpenPausesOfPerson(db.sql, "p-pz")).map((pause) => pause.id)).toEqual(["pz-person-2"]);
  });

  it("works inside a business scoped transaction too", async () => {
    const seen = await db.client.withBusiness("biz-pz", async (tx) => {
      await createPause(tx, { id: "pz-scoped", businessId: "biz-pz", target: "person", personId: "p-owner" });
      return listOpenPausesOfPerson(tx, "p-owner");
    });
    expect(seen.map((pause) => pause.id)).toEqual(["pz-scoped"]);
  });
});
