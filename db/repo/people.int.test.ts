// T-181: the business head, persons and per-business roles against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/people`). The schema comes from migrating a fresh test schema.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPersonRole,
  createBusiness,
  createPerson,
  endPersonRole,
  getBusiness,
  getPerson,
  getPersonRole,
  listLiveRolesOfBusiness,
  listLiveRolesOfPerson,
  updateBusiness,
  updatePerson,
} from "./people";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
// The tables this migration makes. The role fixture also holds handles and person_handles rows: those tables are a
// later migration's, so their rows wait for it.
const OWN_TABLES = ["businesses", "persons", "person_roles"] as const;
const LATER_TABLES = ["handles", "person_handles"];

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
  indexes?: { name: string }[];
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
    if (!(OWN_TABLES as readonly string[]).includes(row.table)) {
      skipped.add(row.table);
      continue;
    }
    await sql`insert into ${sql(row.table)} ${sql(row.values)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return { loaded, skipped: [...skipped].sort() };
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
  db = await createTestDatabase({ name: "people" });
});

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    time: "time without time zone",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.filter((table) =>
    (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the three tables of the card", () => {
    expect(tables.map((table) => table.name)).toEqual([...OWN_TABLES]);
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
          // The catalog prints a default with its cast, and a time with its seconds: '08:00' is '08:00:00'::time ...
          const printed = (actual?.default ?? "").replace(/::.*$/, "");
          const wanted = column.type === "time" ? column.default.replace(/'$/, ":00'") : column.default;
          expect(printed, `${table.name}.${column.name} default`).toBe(wanted);
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
      expect(named("f")).toEqual((table.foreignKeys ?? []).map((key) => key.name).sort());

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
          expect(index?.definition).toContain("WHERE (ended_at IS NULL)");
        }
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

  it("is one database with no partitions: plain tables, no inheritance (C-032 launch shape)", async () => {
    const rows = await db.sql<{ name: string; kind: string; partitioned: boolean; parts: string }[]>`
      select c.relname as name, c.relkind as kind, c.relispartition as partitioned,
             (select count(*) from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid) as parts
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('businesses', 'persons', 'person_roles')
      order by c.relname
    `;
    expect(rows).toEqual([
      { name: "businesses", kind: "r", partitioned: false, parts: "0" },
      { name: "person_roles", kind: "r", partitioned: false, parts: "0" },
      { name: "persons", kind: "r", partitioned: false, parts: "0" },
    ]);
    const [partitioned] = await db.sql<{ n: string }[]>`
      select count(*) as n from pg_partitioned_table p join pg_class c on c.oid = p.partrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${db.schema}
    `;
    expect(Number(partitioned?.n)).toBe(0);
  });

  it("is recorded in schema_migrations after 0001", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name)).toEqual(["init", "core_business_people"]);
  });
});

describe("fixtures seed-business-head and seed-person-roles", () => {
  let seeded: TestDatabase;

  beforeAll(async () => {
    seeded = await createTestDatabase({ name: "people_seed" });
  }, 30_000);

  afterAll(async () => {
    await seeded.drop();
  });

  it("seed-business-head loads: 3 businesses with their stored versions", async () => {
    const result = await loadFixture(seeded.sql, "seed-business-head.json");
    expect(result).toEqual({ loaded: { businesses: 3 }, skipped: [] });
    const businesses = await seeded.sql<{ id: string; status: string; version: number; zone: string }[]>`
      select id, status, version, time_zone as zone from businesses order by id
    `;
    expect(businesses).toEqual([
      { id: "biz-lees-barbershop", status: "live", version: 3, zone: "America/New_York" },
      { id: "biz-movers", status: "saved", version: 1, zone: "America/New_York" },
      { id: "biz-yoga-studio", status: "live", version: 2, zone: "America/New_York" },
    ]);
    expect(await getBusiness(seeded.sql, "biz-lees-barbershop")).toEqual({
      id: "biz-lees-barbershop",
      name: "Lee's Barbershop",
      displayName: "Lee's Barbershop",
      status: "live",
      timeZone: "America/New_York",
      textHoursStart: "08:00:00",
      textHoursEnd: "20:00:00",
      version: 3,
    });
  });

  it("seed-person-roles loads after it: 6 persons and 9 roles; the handle rows wait for their migration", async () => {
    await seeded.sql`delete from businesses`;
    const result = await loadFixture(seeded.sql, "seed-person-roles.json");
    expect(result.loaded).toEqual({ businesses: 3, persons: 6, person_roles: 9 });
    expect(result.skipped).toEqual([...LATER_TABLES].sort());

    expect(await getPerson(seeded.sql, "person-sam")).toEqual({
      id: "person-sam",
      name: "Sam Lee",
      language: "en",
      version: 1,
    });
    const sam = await listLiveRolesOfPerson(seeded.sql, "person-sam");
    expect(sam.map((role) => [role.businessId, role.role])).toEqual([
      ["biz-lees-barbershop", "owner"],
      ["biz-movers", "owner"],
      ["biz-yoga-studio", "owner"],
    ]);
    // Alex is a customer at two businesses; Riley and Avery are the barbershop's staff.
    const alex = await listLiveRolesOfPerson(seeded.sql, "person-alex");
    expect(alex.map((role) => [role.businessId, role.role])).toEqual([
      ["biz-lees-barbershop", "customer"],
      ["biz-yoga-studio", "customer"],
    ]);
    const barberStaff = await listLiveRolesOfBusiness(seeded.sql, "biz-lees-barbershop", "staff");
    expect(barberStaff.map((role) => role.personId)).toEqual(["person-avery", "person-riley"]);
    const barberRoles = await listLiveRolesOfBusiness(seeded.sql, "biz-lees-barbershop");
    expect(barberRoles.map((role) => role.role)).toEqual(["customer", "owner", "staff", "staff"]);
  });
});

describe("defaults and CHECK constraints", () => {
  it("a business made with only its required fields is offline, with text hours 8am to 8pm, at version 1", async () => {
    const made = await createBusiness(db.sql, {
      id: "biz-default",
      name: "Demo shop",
      displayName: "Demo shop",
      timeZone: "America/Chicago",
    });
    expect(made).toEqual({
      id: "biz-default",
      name: "Demo shop",
      displayName: "Demo shop",
      status: "offline",
      timeZone: "America/Chicago",
      textHoursStart: "08:00:00",
      textHoursEnd: "20:00:00",
      version: 1,
    });
    const [raw] = await db.sql<{ start: string; end: string }[]>`
      insert into businesses (id, name, display_name, time_zone) values ('biz-raw', 'Raw', 'Raw', 'UTC')
      returning text_hours_start::text as start, text_hours_end::text as end
    `;
    expect(raw).toEqual({ start: "08:00:00", end: "20:00:00" });
  });

  it("refuses an unknown status, a zone that is not an IANA name, and text hours that do not run forward", async () => {
    const base = { id: "biz-bad", name: "Bad", displayName: "Bad", timeZone: "UTC" };
    expect(await refusal(createBusiness(db.sql, { ...base, status: "open" as "live" }))).toEqual({
      code: "23514",
      constraint: "businesses_status_known",
    });
    for (const timeZone of ["", "New York", "9/Zone", "America/", "/UTC", "America//New_York"]) {
      expect(await refusal(createBusiness(db.sql, { ...base, timeZone }))).toEqual({
        code: "23514",
        constraint: "businesses_time_zone_form",
      });
    }
    for (const [textHoursStart, textHoursEnd] of [
      ["20:00", "08:00"],
      ["09:00", "09:00"],
    ] as const) {
      expect(await refusal(createBusiness(db.sql, { ...base, textHoursStart, textHoursEnd }))).toEqual({
        code: "23514",
        constraint: "businesses_text_hours_order",
      });
    }
    expect(await getBusiness(db.sql, "biz-bad")).toBeNull();
  });

  it("refuses a business with no name, and a duplicate id", async () => {
    expect(
      (await refusal(db.sql`insert into businesses (id, display_name, time_zone) values ('x', 'X', 'UTC')`))
        .code,
    ).toBe("23502");
    expect(
      await refusal(
        createBusiness(db.sql, { id: "biz-default", name: "Again", displayName: "Again", timeZone: "UTC" }),
      ),
    ).toEqual({ code: "23505", constraint: "businesses_pkey" });
  });

  it("a person's language is null or a BCP 47 tag", async () => {
    expect(await createPerson(db.sql, { id: "person-lang-1" })).toEqual({
      id: "person-lang-1",
      name: null,
      language: null,
      version: 1,
    });
    for (const language of ["en", "es", "pt-BR", "zh-Hant-TW"]) {
      const made = await createPerson(db.sql, { id: `person-lang-${language}`, name: "Demo", language });
      expect(made.language).toBe(language);
    }
    for (const language of ["", "EN", "english", "e", "en_US", "en-"]) {
      expect(await refusal(createPerson(db.sql, { id: "person-lang-bad", language }))).toEqual({
        code: "23514",
        constraint: "persons_language_form",
      });
    }
  });

  it("refuses a role that is not owner, admin, staff, own_business or customer", async () => {
    await createPerson(db.sql, { id: "person-role-known", name: "Demo" });
    for (const role of ["owner", "admin", "staff", "own_business", "customer"] as const) {
      const made = await addPersonRole(db.sql, {
        id: `role-known-${role}`,
        personId: "person-role-known",
        businessId: "biz-default",
        role,
      });
      expect(made).toMatchObject({ role, endedAt: null, version: 1 });
    }
    expect(
      await refusal(
        addPersonRole(db.sql, {
          id: "role-known-bad",
          personId: "person-role-known",
          businessId: "biz-default",
          role: "manager" as "staff",
        }),
      ),
    ).toEqual({ code: "23514", constraint: "person_roles_role_known" });
  });
});

describe("keys", () => {
  it("a role needs a person and a business that exist, and neither can be deleted while a role names it", async () => {
    await createBusiness(db.sql, { id: "biz-keys", name: "Keys", displayName: "Keys", timeZone: "UTC" });
    await createPerson(db.sql, { id: "person-keys", name: "Demo" });
    expect(
      await refusal(
        addPersonRole(db.sql, {
          id: "role-k1",
          personId: "person-nobody",
          businessId: "biz-keys",
          role: "staff",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "person_roles_person_fk" });
    expect(
      await refusal(
        addPersonRole(db.sql, {
          id: "role-k2",
          personId: "person-keys",
          businessId: "biz-nowhere",
          role: "staff",
        }),
      ),
    ).toEqual({ code: "23503", constraint: "person_roles_business_fk" });

    await addPersonRole(db.sql, {
      id: "role-k3",
      personId: "person-keys",
      businessId: "biz-keys",
      role: "staff",
    });
    expect(await refusal(db.sql`delete from persons where id = 'person-keys'`)).toEqual({
      code: "23503",
      constraint: "person_roles_person_fk",
    });
    expect(await refusal(db.sql`delete from businesses where id = 'biz-keys'`)).toEqual({
      code: "23503",
      constraint: "person_roles_business_fk",
    });
  });

  it("one live role per person, business and role; an ended role can be given again; other roles are separate", async () => {
    await createPerson(db.sql, { id: "person-live", name: "Demo" });
    const first = await addPersonRole(db.sql, {
      id: "role-live-1",
      personId: "person-live",
      businessId: "biz-keys",
      role: "staff",
    });
    expect(
      await refusal(
        addPersonRole(db.sql, {
          id: "role-live-2",
          personId: "person-live",
          businessId: "biz-keys",
          role: "staff",
        }),
      ),
    ).toEqual({ code: "23505", constraint: "person_roles_one_live_role" });
    // Another role, and the same role at another business, are different rows.
    await addPersonRole(db.sql, {
      id: "role-live-3",
      personId: "person-live",
      businessId: "biz-keys",
      role: "customer",
    });
    await addPersonRole(db.sql, {
      id: "role-live-4",
      personId: "person-live",
      businessId: "biz-default",
      role: "staff",
    });

    const ended = await endPersonRole(db.sql, first.id, first.version);
    expect(ended.ok).toBe(true);
    const again = await addPersonRole(db.sql, {
      id: "role-live-5",
      personId: "person-live",
      businessId: "biz-keys",
      role: "staff",
    });
    expect(again.endedAt).toBeNull();
    // The ended row stays, with its end time.
    expect((await getPersonRole(db.sql, first.id))?.endedAt).toBeInstanceOf(Date);
    const live = await listLiveRolesOfPerson(db.sql, "person-live");
    expect(live.map((role) => role.id).sort()).toEqual(["role-live-3", "role-live-4", "role-live-5"]);
  });
});

describe("the version rule: an update that does not raise the version by one is refused by a trigger", () => {
  const refusedAs = (table: string): { code: string; constraint: string } => ({
    code: "23514",
    constraint: `${table}_version_raised`,
  });

  it("businesses", async () => {
    await createBusiness(db.sql, { id: "biz-ver", name: "Ver", displayName: "Ver", timeZone: "UTC" });
    // A change to a field that leaves the version alone.
    expect(await refusal(db.sql`update businesses set name = 'Changed' where id = 'biz-ver'`)).toEqual(
      refusedAs("businesses"),
    );
    // The same version written back, a jump of two, and a step down.
    expect(
      await refusal(db.sql`update businesses set name = 'Changed', version = 1 where id = 'biz-ver'`),
    ).toEqual(refusedAs("businesses"));
    expect(await refusal(db.sql`update businesses set version = 3 where id = 'biz-ver'`)).toEqual(
      refusedAs("businesses"),
    );
    expect(await refusal(db.sql`update businesses set version = 0 where id = 'biz-ver'`)).toEqual(
      refusedAs("businesses"),
    );
    // The trigger runs before NOT NULL is checked, and null is not old + 1.
    expect(await refusal(db.sql`update businesses set version = null where id = 'biz-ver'`)).toEqual(
      refusedAs("businesses"),
    );
    const unchanged = await getBusiness(db.sql, "biz-ver");
    expect(unchanged).toMatchObject({ name: "Ver", version: 1 });

    await db.sql`update businesses set name = 'Changed', version = version + 1 where id = 'biz-ver'`;
    expect(await getBusiness(db.sql, "biz-ver")).toMatchObject({ name: "Changed", version: 2 });
  });

  it("persons", async () => {
    await createPerson(db.sql, { id: "person-ver", name: "Demo" });
    expect(await refusal(db.sql`update persons set language = 'es' where id = 'person-ver'`)).toEqual(
      refusedAs("persons"),
    );
    expect(
      await refusal(db.sql`update persons set language = 'es', version = 5 where id = 'person-ver'`),
    ).toEqual(refusedAs("persons"));
    expect(await getPerson(db.sql, "person-ver")).toMatchObject({ language: null, version: 1 });
    await db.sql`update persons set language = 'es', version = version + 1 where id = 'person-ver'`;
    expect(await getPerson(db.sql, "person-ver")).toMatchObject({ language: "es", version: 2 });
  });

  it("person_roles", async () => {
    await createPerson(db.sql, { id: "person-ver-role", name: "Demo" });
    await addPersonRole(db.sql, {
      id: "role-ver",
      personId: "person-ver-role",
      businessId: "biz-ver",
      role: "staff",
    });
    expect(await refusal(db.sql`update person_roles set ended_at = now() where id = 'role-ver'`)).toEqual(
      refusedAs("person_roles"),
    );
    expect(
      await refusal(db.sql`update person_roles set role = 'admin', version = 1 where id = 'role-ver'`),
    ).toEqual(refusedAs("person_roles"));
    expect(await getPersonRole(db.sql, "role-ver")).toMatchObject({
      role: "staff",
      endedAt: null,
      version: 1,
    });
    await db.sql`update person_roles set role = 'admin', version = version + 1 where id = 'role-ver'`;
    expect(await getPersonRole(db.sql, "role-ver")).toMatchObject({ role: "admin", version: 2 });
  });

  it("a refused update inside a transaction undoes the transaction's other writes", async () => {
    await expect(
      db.sql.begin(async (tx) => {
        await tx`update persons set name = 'Kept?', version = version + 1 where id = 'person-ver'`;
        await tx`update businesses set name = 'Sneaky' where id = 'biz-ver'`;
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await getPerson(db.sql, "person-ver")).toMatchObject({ name: "Demo", version: 2 });
  });

  it("two parallel compare-and-set writes from the same read: one wins, one gets the row as it is now", async () => {
    await createPerson(db.sql, { id: "person-race", name: "Demo" });
    const results = await Promise.all(
      ["Ana", "Ben", "Cam", "Dee", "Eli", "Fay", "Gus", "Hal"].map((name) =>
        updatePerson(db.sql, "person-race", 1, { name }),
      ),
    );
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const final = await getPerson(db.sql, "person-race");
    expect(final?.version).toBe(2);
    expect(final?.name).toBe(winners[0]?.ok ? winners[0].row.name : "never");
    for (const result of results) {
      if (!result.ok) {
        expect(result.current).toEqual(final);
      }
    }
  });
});

describe("the data-access calls", () => {
  it("updateBusiness changes the named fields, raises the version by one, and refuses a stale read", async () => {
    const made = await createBusiness(db.sql, {
      id: "biz-calls",
      name: "Calls",
      displayName: "Calls",
      timeZone: "America/Denver",
    });
    const live = await updateBusiness(db.sql, made.id, made.version, { status: "live", name: "Calls & Co" });
    expect(live).toEqual({
      ok: true,
      row: { ...made, status: "live", name: "Calls & Co", version: 2 },
    });
    const hours = await updateBusiness(db.sql, made.id, 2, {
      textHoursStart: "09:30",
      textHoursEnd: "18:00",
    });
    expect(hours).toMatchObject({
      ok: true,
      row: { textHoursStart: "09:30:00", textHoursEnd: "18:00:00", version: 3 },
    });

    // A write made from the first read (version 1) changes nothing and returns the row as it now is.
    const stale = await updateBusiness(db.sql, made.id, 1, { name: "Old news" });
    expect(stale).toEqual({ ok: false, current: await getBusiness(db.sql, made.id) });
    expect(stale.ok ? null : stale.current).toMatchObject({ name: "Calls & Co", version: 3 });
    // A touch: an empty patch still raises the version.
    expect(await updateBusiness(db.sql, made.id, 3, {})).toMatchObject({ ok: true, row: { version: 4 } });
    // A row that does not exist.
    expect(await updateBusiness(db.sql, "biz-none", 1, { name: "x" })).toEqual({ ok: false, current: null });
    // The database still checks the new values.
    await expect(updateBusiness(db.sql, made.id, 4, { status: "closed" as "live" })).rejects.toMatchObject({
      code: "23514",
    });
    expect(await getBusiness(db.sql, made.id)).toMatchObject({ status: "live", version: 4 });
    // Not a version.
    await expect(updateBusiness(db.sql, made.id, 0, {})).rejects.toThrow(TypeError);
    await expect(updateBusiness(db.sql, made.id, 1.5, {})).rejects.toThrow(TypeError);
  });

  it("updatePerson sets, keeps or clears each field", async () => {
    const made = await createPerson(db.sql, { id: "person-calls", name: "Riley", language: "en" });
    const renamed = await updatePerson(db.sql, made.id, 1, { name: "Riley T." });
    expect(renamed).toEqual({
      ok: true,
      row: { id: "person-calls", name: "Riley T.", language: "en", version: 2 },
    });
    const cleared = await updatePerson(db.sql, made.id, 2, { language: null });
    expect(cleared).toEqual({
      ok: true,
      row: { id: "person-calls", name: "Riley T.", language: null, version: 3 },
    });
    const both = await updatePerson(db.sql, made.id, 3, { name: null, language: "es" });
    expect(both).toEqual({ ok: true, row: { id: "person-calls", name: null, language: "es", version: 4 } });
    expect(await updatePerson(db.sql, made.id, 3, { name: "stale" })).toEqual({
      ok: false,
      current: { id: "person-calls", name: null, language: "es", version: 4 },
    });
    expect(await updatePerson(db.sql, "person-none", 1, { name: "x" })).toEqual({ ok: false, current: null });
  });

  it("endPersonRole ends a role once, keeps the row, and lists skip it afterwards", async () => {
    await createPerson(db.sql, { id: "person-end", name: "Demo" });
    const role = await addPersonRole(db.sql, {
      id: "role-end",
      personId: "person-end",
      businessId: "biz-calls",
      role: "admin",
    });
    expect(await listLiveRolesOfBusiness(db.sql, "biz-calls", "admin")).toHaveLength(1);

    const stale = await endPersonRole(db.sql, role.id, 7);
    expect(stale).toEqual({ ok: false, current: role });
    const ended = await endPersonRole(db.sql, role.id, role.version);
    expect(ended).toMatchObject({ ok: true, row: { id: role.id, version: 2 } });
    expect(ended.ok ? ended.row.endedAt : null).toBeInstanceOf(Date);

    // Ending it again is refused as a conflict, with the row as it is.
    const again = await endPersonRole(db.sql, role.id, 2);
    expect(again.ok).toBe(false);
    expect(again.ok ? null : again.current).toMatchObject({ id: role.id, version: 2 });
    expect(await listLiveRolesOfBusiness(db.sql, "biz-calls", "admin")).toEqual([]);
    expect(await listLiveRolesOfPerson(db.sql, "person-end")).toEqual([]);
    expect(await getPersonRole(db.sql, "role-none")).toBeNull();
  });

  it("works inside a business scoped transaction too", async () => {
    const seen = await db.client.withBusiness("biz-calls", async (tx) => {
      const person = await createPerson(tx, { id: "person-scoped", name: "Demo" });
      await addPersonRole(tx, {
        id: "role-scoped",
        personId: person.id,
        businessId: "biz-calls",
        role: "owner",
      });
      return listLiveRolesOfBusiness(tx, "biz-calls", "owner");
    });
    expect(seen.map((role) => role.id)).toEqual(["role-scoped"]);
  });
});
