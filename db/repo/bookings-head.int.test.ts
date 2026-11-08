// T-186: bookable resources and the booking head row against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/bookings-head`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPerson } from "./people";
import {
  createBookingHead,
  createResource,
  getBookingHead,
  getResource,
  listBookingHeadsOfBusiness,
  listBookingHeadsOfPerson,
  listResources,
  setResourceActive,
  updateBookingHead,
} from "./bookings-head";
import { createHandle } from "./phones";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { createThread } from "./threads";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const OWN_TABLES = ["resources", "bookings"] as const;
// Tables the fixtures' `after` chains bring in from the earlier migrations (0002 to 0005).
const EARLIER_TABLES = ["businesses", "persons", "person_roles", "sealing_keys", "handles", "person_handles"];
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
): Promise<{ loaded: Record<string, number>; skipped: string[] }> {
  const loaded: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const row of fixtureRows(file)) {
    if (!LOADABLE_TABLES.includes(row.table)) {
      skipped.add(row.table);
      continue;
    }
    await sql`insert into ${sql(row.table)} ${sql(row.values)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return { loaded, skipped: [...skipped].sort() };
}

// Later migrations add tables that reference these, so the truncate cascades to them. Each test file runs in its own
// schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate messages, openers_sent, threads, bookings, resources, pauses, phones, person_handles, handles, person_roles, sealing_keys, persons, businesses cascade`;
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
  db = await createTestDatabase({ name: "bookings_head" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    boolean: "boolean",
  };
  const tables = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the two tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["bookings", "resources"]);
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
      for (const rule of table.unique ?? []) {
        const index = indexes.find((candidate) => candidate.name === rule.name);
        expect(index?.definition).toContain(`(${rule.columns.join(", ")})`);
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
    });
  }

  it("is expand only: plain tables, each with row-level security per business (T-191)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('resources', 'bookings')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["bookings", "r", true],
      ["resources", "r", true],
    ]);
  });

  it("adds the two foreign keys 0005 left for it, both on delete restrict", async () => {
    for (const [table, name] of [
      ["threads", "threads_booking_fk"],
      ["messages", "messages_booking_fk"],
    ] as const) {
      const [key] = await db.sql<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = ${`${db.schema}.${table}`}::regclass and conname = ${name}
      `;
      expect(key?.definition, name).toBe(
        "FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT",
      );
    }
  });

  it("is recorded in schema_migrations after 0001 to 0006", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name)).toContain("core_resources_booking_head");
  });
});

describe("fixtures seed-resources and seed-booking-head", () => {
  it("seed-resources loads as the fixture has it: seven resources of four kinds", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-resources.json");
    expect(result.loaded).toMatchObject({ resources: 7 });
    const kinds = await db.sql<{ kind: string; n: number }[]>`
      select kind, count(*)::int as n from resources group by kind order by kind
    `;
    expect(kinds).toEqual([
      { kind: "class_session", n: 1 },
      { kind: "room", n: 1 },
      { kind: "vehicle", n: 2 },
      { kind: "worker", n: 3 },
    ]);
    expect(await getResource(db.sql, "res-riley")).toEqual({
      id: "res-riley",
      businessId: "biz-lees-barbershop",
      kind: "worker",
      name: "Riley",
      personId: "person-riley",
      active: true,
      version: 1,
    });
    expect(await getResource(db.sql, "none")).toBeNull();
  });

  it("seed-booking-head loads as the fixture has it, versions as stored", async () => {
    await emptyTables(db.sql);
    const result = await loadFixture(db.sql, "seed-booking-head.json");
    expect(result.loaded).toMatchObject({ bookings: 2 });
    expect(await getBookingHead(db.sql, "booking-alex-haircut")).toEqual({
      id: "booking-alex-haircut",
      businessId: "biz-lees-barbershop",
      flow: "A",
      stage: "booked",
      bookerPersonId: "person-alex",
      servedPersonId: "person-alex",
      payerPersonId: "person-alex",
      private: false,
      deceased: false,
      version: 7,
    });
    expect(await getBookingHead(db.sql, "booking-alex-workshop")).toMatchObject({
      businessId: "biz-yoga-studio",
      version: 2,
    });
    expect(await getBookingHead(db.sql, "none")).toBeNull();
  });
});

describe("resources", () => {
  it("lists a business's resources, by kind and by whether they can be booked now", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-resources.json");
    expect((await listResources(db.sql, "biz-yoga-studio")).map((resource) => resource.id)).toEqual([
      "res-handstand-workshop",
      "res-maya",
      "res-studio-room",
    ]);
    expect(
      (await listResources(db.sql, "biz-movers", { kind: "vehicle" })).map((resource) => resource.id),
    ).toEqual(["res-truck-20", "res-truck-26"]);
    expect(await listResources(db.sql, "biz-movers", { kind: "worker" })).toEqual([]);

    const first = await setResourceActive(db.sql, "res-truck-20", 1, false);
    expect(first).toMatchObject({ ok: true, row: { active: false, version: 2 } });
    expect((await listResources(db.sql, "biz-movers", { activeOnly: true })).map((r) => r.id)).toEqual([
      "res-truck-26",
    ]);
    expect(await listResources(db.sql, "biz-movers")).toHaveLength(2);
  });

  it("a stale version update is refused and returns the row as it is; a missing row gives null", async () => {
    const stale = await setResourceActive(db.sql, "res-truck-20", 1, true);
    expect(stale).toMatchObject({ ok: false, current: { active: false, version: 2 } });
    expect(await setResourceActive(db.sql, "none", 1, true)).toEqual({ ok: false, current: null });
    await expect(setResourceActive(db.sql, "res-truck-20", 0, true)).rejects.toThrow(TypeError);
    const refusedAs = { code: "23514", constraint: "resources_version_raised" };
    expect(await refusal(db.sql`update resources set name = 'x' where id = 'res-truck-20'`)).toEqual(
      refusedAs,
    );
    expect(await refusal(db.sql`update resources set version = 9 where id = 'res-truck-20'`)).toEqual(
      refusedAs,
    );
  });

  it("the database refuses a worker with no person, a person on a room, an unknown kind and a missing owner", async () => {
    const worker = { id: "r-w", businessId: "biz-movers", kind: "worker" as const, name: "W" };
    expect(await refusal(createResource(db.sql, worker))).toEqual({
      code: "23514",
      constraint: "resources_worker_is_person",
    });
    expect(
      await refusal(createResource(db.sql, { ...worker, id: "r-r", kind: "room", personId: "person-riley" })),
    ).toEqual({ code: "23514", constraint: "resources_worker_is_person" });
    expect(await refusal(createResource(db.sql, { ...worker, id: "r-k", kind: "boat" as "room" }))).toEqual({
      code: "23514",
      constraint: "resources_kind_known",
    });
    expect(
      await refusal(createResource(db.sql, { ...worker, id: "r-b", businessId: "biz-none", kind: "room" })),
    ).toEqual({ code: "23503", constraint: "resources_business_fk" });
    expect(await refusal(createResource(db.sql, { ...worker, id: "r-p", personId: "person-none" }))).toEqual({
      code: "23503",
      constraint: "resources_person_fk",
    });
    expect(await refusal(createResource(db.sql, { ...worker, id: "res-riley", kind: "room" }))).toEqual({
      code: "23505",
      constraint: "resources_pkey",
    });
    expect(await refusal(db.sql`delete from businesses where id = 'biz-movers'`)).toMatchObject({
      code: "23503",
    });
    expect(await refusal(db.sql`delete from persons where id = 'person-riley'`)).toMatchObject({
      code: "23503",
    });
  });

  it("createResource defaults: active, version 1", async () => {
    const made = await createResource(db.sql, {
      id: "r-new",
      businessId: "biz-movers",
      kind: "room",
      name: "Garage",
    });
    expect(made).toEqual({
      id: "r-new",
      businessId: "biz-movers",
      kind: "room",
      name: "Garage",
      personId: null,
      active: true,
      version: 1,
    });
  });
});

describe("the booking head", () => {
  it("keeps the booker, the person served and the payer as three references", async () => {
    await emptyTables(db.sql);
    await loadFixture(db.sql, "seed-booking-head.json");
    await createPerson(db.sql, { id: "person-parent", name: "Demo Parent" });
    await createPerson(db.sql, { id: "person-child", name: "Demo Child" });
    await createPerson(db.sql, { id: "person-grandma", name: "Demo Grandma" });
    const made = await createBookingHead(db.sql, {
      id: "booking-three",
      businessId: "biz-lees-barbershop",
      flow: "B",
      bookerPersonId: "person-parent",
      servedPersonId: "person-child",
      payerPersonId: "person-grandma",
    });
    expect(made).toEqual({
      id: "booking-three",
      businessId: "biz-lees-barbershop",
      flow: "B",
      stage: "entry",
      bookerPersonId: "person-parent",
      servedPersonId: "person-child",
      payerPersonId: "person-grandma",
      private: false,
      deceased: false,
      version: 1,
    });
    // The guard lists a handle's bookings by booker or by person served.
    expect((await listBookingHeadsOfPerson(db.sql, "person-child")).map((b) => b.id)).toEqual([
      "booking-three",
    ]);
    expect((await listBookingHeadsOfPerson(db.sql, "person-parent")).map((b) => b.id)).toEqual([
      "booking-three",
    ]);
    // The payer alone does not list it.
    expect(await listBookingHeadsOfPerson(db.sql, "person-grandma")).toEqual([]);
    expect(
      (await listBookingHeadsOfPerson(db.sql, "person-alex", { stage: "booked" })).map((b) => b.id),
    ).toEqual(["booking-alex-haircut", "booking-alex-workshop"]);
    expect(await listBookingHeadsOfPerson(db.sql, "person-alex", { stage: "done" })).toEqual([]);
    expect((await listBookingHeadsOfBusiness(db.sql, "biz-yoga-studio", "booked")).map((b) => b.id)).toEqual([
      "booking-alex-workshop",
    ]);
  });

  it("served and payer may be unknown at first, then set; each is its own reference", async () => {
    const made = await createBookingHead(db.sql, {
      id: "booking-open",
      businessId: "biz-lees-barbershop",
      flow: "A",
      bookerPersonId: "person-parent",
    });
    expect(made).toMatchObject({ servedPersonId: null, payerPersonId: null, stage: "entry" });
    const served = await updateBookingHead(db.sql, "booking-open", 1, { servedPersonId: "person-child" });
    expect(served).toMatchObject({
      ok: true,
      row: {
        servedPersonId: "person-child",
        payerPersonId: null,
        bookerPersonId: "person-parent",
        version: 2,
      },
    });
    const payer = await updateBookingHead(db.sql, "booking-open", 2, { payerPersonId: "person-grandma" });
    expect(payer).toMatchObject({
      ok: true,
      row: { servedPersonId: "person-child", payerPersonId: "person-grandma", version: 3 },
    });
    const cleared = await updateBookingHead(db.sql, "booking-open", 3, { payerPersonId: null });
    expect(cleared).toMatchObject({ ok: true, row: { payerPersonId: null, servedPersonId: "person-child" } });
  });

  it("a stale version update is refused with the row as it is; a fresh one raises the version by one", async () => {
    const first = await updateBookingHead(db.sql, "booking-alex-haircut", 7, {
      stage: "checked_in",
      private: true,
    });
    expect(first).toMatchObject({
      ok: true,
      row: { stage: "checked_in", private: true, deceased: false, version: 8 },
    });
    const stale = await updateBookingHead(db.sql, "booking-alex-haircut", 7, { stage: "done" });
    expect(stale).toMatchObject({ ok: false, current: { stage: "checked_in", version: 8 } });
    expect(await getBookingHead(db.sql, "booking-alex-haircut")).toMatchObject({ stage: "checked_in" });
    expect(await updateBookingHead(db.sql, "none", 1, { stage: "done" })).toEqual({
      ok: false,
      current: null,
    });
    await expect(updateBookingHead(db.sql, "booking-alex-haircut", 0, {})).rejects.toThrow(TypeError);
    const flagged = await updateBookingHead(db.sql, "booking-alex-haircut", 8, {
      private: false,
      deceased: true,
    });
    expect(flagged).toMatchObject({ ok: true, row: { private: false, deceased: true, version: 9 } });
  });

  it("the database refuses an update that does not raise the version by one", async () => {
    const refusedAs = { code: "23514", constraint: "bookings_version_raised" };
    expect(
      await refusal(db.sql`update bookings set stage = 'done' where id = 'booking-alex-workshop'`),
    ).toEqual(refusedAs);
    expect(await refusal(db.sql`update bookings set version = 9 where id = 'booking-alex-workshop'`)).toEqual(
      refusedAs,
    );
    expect(await refusal(db.sql`update bookings set version = 1 where id = 'booking-alex-workshop'`)).toEqual(
      refusedAs,
    );
  });

  it("30 parallel updates at one version give exactly one success", async () => {
    await createBookingHead(db.sql, {
      id: "booking-race",
      businessId: "biz-lees-barbershop",
      flow: "A",
      bookerPersonId: "person-parent",
    });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => updateBookingHead(db.sql, "booking-race", 1, { stage: "booked" })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await getBookingHead(db.sql, "booking-race"))?.version).toBe(2);
  });

  it("the table refuses a booking that breaks a rule of the table list", async () => {
    const base = {
      id: "booking-rule",
      businessId: "biz-lees-barbershop",
      flow: "A" as const,
      bookerPersonId: "person-parent",
    };
    expect(await refusal(createBookingHead(db.sql, { ...base, flow: "C" as "A" }))).toEqual({
      code: "23514",
      constraint: "bookings_flow_known",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, stage: "lost" as "done" }))).toEqual({
      code: "23514",
      constraint: "bookings_stage_known",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, businessId: "biz-none" }))).toEqual({
      code: "23503",
      constraint: "bookings_business_fk",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, bookerPersonId: "person-none" }))).toEqual({
      code: "23503",
      constraint: "bookings_booker_fk",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, servedPersonId: "person-none" }))).toEqual({
      code: "23503",
      constraint: "bookings_served_fk",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, payerPersonId: "person-none" }))).toEqual({
      code: "23503",
      constraint: "bookings_payer_fk",
    });
    expect(await refusal(createBookingHead(db.sql, { ...base, id: "booking-alex-haircut" }))).toEqual({
      code: "23505",
      constraint: "bookings_pkey",
    });
    expect(await refusal(db.sql`delete from persons where id = 'person-parent'`)).toMatchObject({
      code: "23503",
    });
    expect(await refusal(db.sql`delete from businesses where id = 'biz-yoga-studio'`)).toMatchObject({
      code: "23503",
    });
  });
});

describe("thread and message keys to the booking (threads_booking_fk, messages_booking_fk)", () => {
  it("a thread or a message naming a missing booking is refused with 23503", async () => {
    await createHandle(db.sql, { id: "h-fk", kind: "email", address: "fk@example.com" });
    expect(
      await refusal(
        createThread(db.sql, {
          id: "t-fk-missing",
          handleId: "h-fk",
          kind: "email",
          bookingId: "booking-missing",
          replyAddress: "booking-missing@reply.example.com",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "threads_booking_fk" });

    const thread = await createThread(db.sql, {
      id: "t-fk-ok",
      handleId: "h-fk",
      kind: "email",
      bookingId: "booking-alex-haircut",
      replyAddress: "booking-alex-haircut@reply.example.com",
    });
    expect(thread.bookingId).toBe("booking-alex-haircut");

    expect(
      await refusal(
        db.sql`
          insert into messages (id, thread_id, business_id, booking_id, direction, channel, from_role, to_role, words, event_id, sent_at)
          values ('msg-fk-missing', 't-fk-ok', 'biz-lees-barbershop', 'booking-missing', 'in', 'email', 'customer', 'rosie', 'w', 'evt-fk-1', now())
        `,
      ),
    ).toEqual({ code: "23503", constraint: "messages_booking_fk" });
    await db.sql`
      insert into messages (id, thread_id, business_id, booking_id, direction, channel, from_role, to_role, words, event_id, sent_at)
      values ('msg-fk-ok', 't-fk-ok', 'biz-lees-barbershop', 'booking-alex-haircut', 'in', 'email', 'customer', 'rosie', 'w', 'evt-fk-2', now())
    `;
  });

  it("a booking cannot be deleted while a thread or a message names it", async () => {
    expect(await refusal(db.sql`delete from bookings where id = 'booking-alex-haircut'`)).toMatchObject({
      code: "23503",
    });
    await db.sql`delete from messages where id = 'msg-fk-ok'`;
    expect(await refusal(db.sql`delete from bookings where id = 'booking-alex-haircut'`)).toEqual({
      code: "23503",
      constraint: "threads_booking_fk",
    });
  });
});
