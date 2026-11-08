// T-191: row-level security per business on every business-scoped core table, with the Tool API's role and the runtime
// side's role, against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/rls`). The schema comes
// from migrating a fresh test schema, with every accepted K-04 v1 seed loaded.
//
// The test's connection is the migrations' role (locally a superuser that owns every table), which bypasses row-level
// security. So every check runs in its own transaction under SET LOCAL ROLE: rosie_app, the Tool API (K-05 scope
// business), or rosie_job, the runtime side (the guard, the dispatcher, the clock sweep), scoped by withBusiness() as a
// call is scoped. Each of those transactions is rolled back, so the seeds stay as loaded.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResource } from "./bookings-head";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const FUNCTIONS = ["reservations_booked_overlap", "reservations_saved_times"];
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ContractTable {
  name: string;
  columns: { name: string; null: boolean }[];
  rowLevelSecurity: { scope: "business"; column: string } | { scope: "none"; why: string };
  versioned: boolean;
}

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

interface RefusedFixture {
  after: string[];
  refused: {
    role: string;
    scope: { businessId: string } | null;
    action: string;
    table: string;
    set?: Record<string, Json>;
    where: Record<string, string>;
    expect: { rows?: number; sqlstate?: string };
  };
}

const readCore = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));

const TABLES = (readCore("core.v1.tables.json") as { tables: ContractTable[] }).tables;
/**
 * Every table the migrations make: K-04 v1 core, K-29 v1 conversations and consent (T-192), and K-37 v1 platform and
 * review (T-193).
 */
const ALL_TABLES = [
  ...TABLES,
  ...(
    JSON.parse(
      readFileSync(
        new URL(
          "../../contracts/db-schema/conversations-consent/conversations-consent.v1.tables.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
  ...(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/db-schema/platform-review/platform-review.v1.tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tables: ContractTable[] }
  ).tables,
];
/** The business-scoped tables, each with the column its policies key on and whether that column may be null. */
const scopedOf = (tables: readonly ContractTable[]): { name: string; column: string; nullable: boolean }[] =>
  tables.flatMap((table) => {
    const security = table.rowLevelSecurity;
    if (security.scope !== "business") {
      return [];
    }
    const nullable = table.columns.find((column) => column.name === security.column)?.null === true;
    return [{ name: table.name, column: security.column, nullable }];
  });
/** The core tables scoped by business, which the core seeds fill. */
const SCOPED = scopedOf(TABLES);
/** Every business-scoped table in the schema, for the catalog's lists. */
const ALL_SCOPED = scopedOf(ALL_TABLES);
/** The tables that span businesses (scope none). */
const SPANNING = TABLES.filter((table) => table.rowLevelSecurity.scope === "none").map((table) => table.name);

function fixtureRows(file: string, seen: Set<string>): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readCore(`fixtures/${file}`) as FixtureFile;
  return [...fixture.after.flatMap((before) => fixtureRows(before, seen)), ...fixture.rows];
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Loads every accepted K-04 seed fixture as the owner, each `after` chain once, as the contract test loads them. */
async function loadSeeds(sql: Sql): Promise<void> {
  const typed = await sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  const typeOf = new Map(typed.map((column) => [column.key, column.type]));
  const index = readCore("fixtures/index.json") as { fixtures: { file: string; expect: string }[] };
  const seen = new Set<string>();
  for (const entry of index.fixtures.filter((fixture) => fixture.expect === "accept")) {
    for (const row of fixtureRows(entry.file, seen)) {
      const values: Record<string, never> = {};
      for (const [column, value] of Object.entries(row.values)) {
        const type = typeOf.get(`${row.table}.${column}`);
        let converted: unknown = value;
        if (type === "jsonb" && value !== null) {
          converted = sql.json(value);
        } else if (type === "bytea" && typeof value === "string") {
          converted = fromHex(value.replace(/^\\x/, ""));
        }
        values[column] = converted as never;
      }
      await sql`insert into ${sql(row.table)} ${sql(values)}`;
    }
  }
}

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;

/**
 * Runs `fn` in one transaction as `role`, scoped by withBusiness() to `businessId` (null: no scope, a plain
 * transaction), then rolls it back. A statement the database refuses rejects with its error.
 */
async function as<T>(role: Role, businessId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx): Promise<never> => {
    await tx.unsafe(`set local role ${role}`);
    throw new RolledBack(await fn(tx));
  };
  try {
    if (businessId === null) {
      await db.sql.begin(run);
    } else {
      await withBusiness(db.sql, businessId, run);
    }
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/** The SQLSTATE and message of a refused statement. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: failure.message ?? "" };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

async function rowCount(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

/** Rows each business-scoped table shows the caller, by table. */
async function visibleRows(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    counts[table.name] = await rowCount(sql, table.name);
  }
  return counts;
}

/** Rows of each business-scoped table whose business column is `businessId` (null: no business), read as the owner. */
async function ownerRows(businessId: string | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from ${db.sql(table.name)}
      where ${businessId === null ? db.sql`${db.sql(table.column)} is null` : db.sql`${db.sql(table.column)} = ${businessId}`}
    `;
    counts[table.name] = row?.n ?? -1;
  }
  return counts;
}

/** Rows each business-scoped table shows the caller whose business column is null. */
async function visibleRowsWithNoBusiness(sql: Sql | Tx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table.name)} where ${sql(table.column)} is null
    `;
    counts[table.name] = row?.n ?? -1;
  }
  return counts;
}

async function businessIds(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`select id from businesses order by id`;
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "rls" });
  await loadSeeds(db.sql);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration: row-level security on every business-scoped core table (K-04 v1 rule 4)", () => {
  it("the frozen table list names 13 business-scoped tables and 11 that span businesses", () => {
    expect(SCOPED.map((table) => table.name).sort()).toEqual([
      "bookings",
      "businesses",
      "class_seats",
      "clock_rows",
      "event_log",
      "messages",
      "open_questions",
      "openers_sent",
      "outbox_rows",
      "pauses",
      "person_roles",
      "reservations",
      "resources",
    ]);
    expect(SPANNING).toHaveLength(11);
  });

  it("every business-scoped table has row-level security on: the catalog lists none without it", async () => {
    const names = ALL_SCOPED.map((table) => table.name);
    const found = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r' and c.relname in ${db.sql(names)}
    `;
    expect(found).toHaveLength(names.length);
    const without = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(names)}
        and not c.relrowsecurity
    `;
    expect(without).toEqual([]);
  });

  it("tables that span businesses keep it off (scope none), and no table forces it on its owner", async () => {
    const on = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(SPANNING)} and c.relrowsecurity
    `;
    expect(on).toEqual([]);
    const forced = await db.sql<{ name: string }[]>`
      select c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relforcerowsecurity
    `;
    expect(forced).toEqual([]);
  });

  it("each business-scoped table has two policies on its business column: <table>_tool_api for rosie_app, <table>_runtime for rosie_job", async () => {
    const policies = await db.sql<
      {
        table: string;
        name: string;
        permissive: string;
        roles: string[];
        command: string;
        using: string;
        check: string;
      }[]
    >`
      select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd as command,
             qual as using, with_check as check
      from pg_policies where schemaname = ${db.schema}
      order by tablename, policyname
    `;
    expect([...new Set(policies.map((policy) => policy.table))]).toEqual(
      ALL_SCOPED.map((table) => table.name).sort(),
    );
    for (const table of ALL_SCOPED) {
      const own = policies.filter((policy) => policy.table === table.name);
      expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
        [`${table.name}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table.name}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      for (const policy of own) {
        expect(policy.using, policy.name).toContain(
          `${table.column} = NULLIF(current_setting('rosie.business_id'`,
        );
        expect(policy.check, policy.name).toBe(policy.using);
      }
      // Only the runtime side has the unscoped branch: with no scope, it reads every business's rows.
      expect(own[0]?.using).toContain("IS NULL");
      expect(own[1]?.using).not.toContain("IS NULL");
    }
  });

  it("is recorded in schema_migrations as core_rls, after core_event_log", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("core_rls");
    expect(names.indexOf("core_rls")).toBeGreaterThan(names.indexOf("core_event_log"));
  });
});

describe("the two roles", () => {
  const roleRows = (): Promise<
    { name: string; oid: number; super: boolean; bypass: boolean; login: boolean }[]
  > =>
    db.sql`
      select rolname as name, oid::int as oid, rolsuper as super, rolbypassrls as bypass, rolcanlogin as login
      from pg_roles where rolname in (${TOOL_API}, ${RUNTIME}) order by rolname
    `;

  it("rosie_app and rosie_job exist, cannot log in, are no superusers, and neither bypasses row-level security", async () => {
    const roles = await roleRows();
    expect(
      roles.map(({ name, super: superuser, bypass, login }) => ({ name, superuser, bypass, login })),
    ).toEqual([
      { name: TOOL_API, superuser: false, bypass: false, login: false },
      { name: RUNTIME, superuser: false, bypass: false, login: false },
    ]);
    const powers = await db.sql<
      { name: string; createrole: boolean; createdb: boolean; replication: boolean }[]
    >`
      select rolname as name, rolcreaterole as createrole, rolcreatedb as createdb, rolreplication as replication
      from pg_roles where rolname in (${TOOL_API}, ${RUNTIME}) order by rolname
    `;
    for (const role of powers) {
      expect(role, role.name).toEqual({
        name: role.name,
        createrole: false,
        createdb: false,
        replication: false,
      });
    }
  });

  it("neither role owns a table or a function: event_log, its trigger function and the two functions stay the migrations' role's", async () => {
    const owned = await db.sql<{ owner: string; name: string }[]>`
      select pg_get_userbyid(c.relowner) as owner, c.relname as name from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and pg_get_userbyid(c.relowner) in (${TOOL_API}, ${RUNTIME})
      union all
      select pg_get_userbyid(p.proowner), p.proname from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and pg_get_userbyid(p.proowner) in (${TOOL_API}, ${RUNTIME})
    `;
    expect(owned).toEqual([]);
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.oid = ${`${db.schema}.event_log`}::regclass
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(["event_log_refuse_edit", ...FUNCTIONS])}
      order by 1
    `;
    expect(owners.map((row) => row.name)).toEqual(["event_log", "event_log_refuse_edit", ...FUNCTIONS]);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
    }
  });

  it(
    "are made only when missing: a second schema migrated on the same server keeps them and gets its own grants and policies",
    SLOW,
    async () => {
      const before = await roleRows();
      const again = await createTestDatabase({ name: "rls_again" });
      try {
        expect(await roleRows()).toEqual(before);
        const [row] = await again.sql<{ on: number; policies: number; usage: boolean }[]>`
          select count(*) filter (where c.relrowsecurity)::int as on,
                 (select count(*)::int from pg_policies where schemaname = ${again.schema}) as policies,
                 has_schema_privilege(${TOOL_API}, ${again.schema}, 'USAGE')
                   and has_schema_privilege(${RUNTIME}, ${again.schema}, 'USAGE') as usage
          from pg_class c where c.relnamespace = ${again.schema}::regnamespace and c.relkind = 'r'
        `;
        expect(row).toEqual({ on: ALL_SCOPED.length, policies: 2 * ALL_SCOPED.length, usage: true });
      } finally {
        await again.drop();
      }
    },
  );
});

describe("refuse-cross-business-read.json (K-04 v1): another business's row is hidden from a Tool API call", () => {
  const fixture = readCore("fixtures/invalid/refuse-cross-business-read.json") as RefusedFixture;
  const { refused } = fixture;
  const read = (sql: Sql | Tx): Promise<readonly unknown[]> => {
    const conditions = Object.entries(refused.where).map(([column, value]) => sql`${sql(column)} = ${value}`);
    const where = conditions.reduce((all, condition) => sql`${all} and ${condition}`);
    return sql`select * from ${sql(refused.table)} where ${where}`;
  };

  it("scoped to the yoga studio, the read of Lee's Barbershop's booking returns no row, as the fixture expects", async () => {
    expect([refused.role, refused.action]).toEqual(["toolApi", "select"]);
    expect(await read(db.sql)).toHaveLength(1);
    const scope = refused.scope?.businessId ?? null;
    expect(scope).toBe("biz-yoga-studio");
    expect(await as(TOOL_API, scope, read)).toHaveLength(refused.expect.rows ?? -1);
  });

  it("without its one fault (Lee's Barbershop's own scope) the same read returns the row", async () => {
    expect(await as(TOOL_API, "biz-lees-barbershop", read)).toHaveLength(1);
  });
});

describe("a query with no scope, each business's scope, and rows with no business", () => {
  it(
    "with no scope, the Tool API role reads no row of any business-scoped table, though each has rows",
    SLOW,
    async () => {
      const zeros = Object.fromEntries(SCOPED.map((table) => [table.name, 0]));
      const seeded = await visibleRows(db.sql);
      expect(Object.entries(seeded).filter(([, n]) => n === 0)).toEqual([]);
      expect(await as(TOOL_API, null, visibleRows)).toEqual(zeros);
      // A scope that ended reads back as '' on its connection: no scope either.
      expect(
        await as(TOOL_API, null, async (tx) => {
          await tx`select set_config('rosie.business_id', '', true)`;
          return visibleRows(tx);
        }),
      ).toEqual(zeros);
    },
  );

  it(
    "each business's scope shows the Tool API role exactly that business's rows, in every business-scoped table",
    SLOW,
    async () => {
      const businesses = await businessIds();
      expect(businesses).toEqual(["biz-lees-barbershop", "biz-movers", "biz-yoga-studio"]);
      for (const business of businesses) {
        expect(await as(TOOL_API, business, visibleRows), business).toEqual(await ownerRows(business));
      }
      // A business with no rows at all: nothing.
      expect(await as(TOOL_API, "biz-nobody", visibleRows)).toEqual(await ownerRows("biz-nobody"));
    },
  );

  it(
    "a row whose business column is null is seen by no business scope, under either role",
    SLOW,
    async () => {
      const withNone = await ownerRows(null);
      expect(withNone.event_log).toBeGreaterThan(0);
      for (const table of SCOPED.filter((candidate) => !candidate.nullable)) {
        expect(withNone[table.name], table.name).toBe(0);
      }
      const zeros = Object.fromEntries(SCOPED.map((table) => [table.name, 0]));
      for (const business of await businessIds()) {
        for (const role of ROLES) {
          expect(await as(role, business, visibleRowsWithNoBusiness), `${role} at ${business}`).toEqual(
            zeros,
          );
        }
      }
      // The runtime side, unscoped, works with them (a sweep's job rows, sign-up before there is a business).
      expect(await as(RUNTIME, null, visibleRowsWithNoBusiness)).toEqual(withNone);
    },
  );

  it(
    "the runtime side with no scope reads every business's rows; with a scope set (per write) only that business's",
    SLOW,
    async () => {
      expect(await as(RUNTIME, null, visibleRows)).toEqual(await visibleRows(db.sql));
      for (const business of await businessIds()) {
        expect(await as(RUNTIME, business, visibleRows), business).toEqual(await ownerRows(business));
      }
    },
  );
});

describe("writes under a scope", () => {
  const room = {
    id: "res-rls-room",
    businessId: "biz-lees-barbershop",
    kind: "room" as const,
    name: "Back room",
  };
  const jobEntry = {
    id: "evlog-rls-job",
    trace_id: "trace-rls-0001",
    job_id: "job-rls-sweep",
    actor_kind: "job",
    kind: "clock_row.armed",
  };

  it("the Tool API role writes only its scope's rows: another business's insert is refused (42501), its update finds no row", async () => {
    expect((await refusal(as(TOOL_API, "biz-yoga-studio", (tx) => createResource(tx, room)))).code).toBe(
      "42501",
    );
    expect(await as(TOOL_API, "biz-lees-barbershop", (tx) => createResource(tx, room))).toMatchObject({
      id: room.id,
      businessId: room.businessId,
    });
    const bump = (tx: Tx): Promise<readonly unknown[]> =>
      tx`update bookings set version = version + 1 where id = 'booking-alex-haircut' returning id`;
    expect(await as(TOOL_API, "biz-yoga-studio", bump)).toHaveLength(0);
    expect(await as(TOOL_API, "biz-lees-barbershop", bump)).toHaveLength(1);
  });

  it("the Tool API role cannot move a row to another business, write with no scope, or delete", async () => {
    expect(
      (
        await refusal(
          as(
            TOOL_API,
            "biz-lees-barbershop",
            (tx) =>
              tx`update bookings set business_id = 'biz-yoga-studio', version = version + 1 where id = 'booking-alex-haircut'`,
          ),
        )
      ).code,
    ).toBe("42501");
    expect((await refusal(as(TOOL_API, null, (tx) => createResource(tx, room)))).code).toBe("42501");
    expect(
      (
        await refusal(
          as(
            TOOL_API,
            "biz-lees-barbershop",
            (tx) => tx`delete from bookings where id = 'booking-alex-haircut'`,
          ),
        )
      ).code,
    ).toBe("42501");
  });

  it("the runtime side scoped to one business (per write) cannot write another's row, nor one with no business", async () => {
    expect((await refusal(as(RUNTIME, "biz-yoga-studio", (tx) => createResource(tx, room)))).code).toBe(
      "42501",
    );
    expect(
      (await refusal(as(RUNTIME, "biz-yoga-studio", (tx) => tx`insert into event_log ${tx(jobEntry)}`))).code,
    ).toBe("42501");
    // With no scope, both go on the runtime side.
    expect(
      await as(RUNTIME, null, async (tx) => {
        await createResource(tx, room);
        await tx`insert into event_log ${tx(jobEntry)}`;
        return [await rowCount(tx, "resources"), await rowCount(tx, "event_log")];
      }),
    ).toEqual([(await rowCount(db.sql, "resources")) + 1, (await rowCount(db.sql, "event_log")) + 1]);
  });

  it("an outbox row, whose commit_seq is an identity column, is written with no grant on its sequence", async () => {
    const [row] = await db.sql<{ id: string; business: string }[]>`
      select id, business_id as business from outbox_rows where business_id is not null order by commit_seq limit 1
    `;
    expect(row).toBeDefined();
    const copy = (tx: Tx): Promise<readonly unknown[]> => tx`
      insert into outbox_rows (
        id, turn_id, recipient_handle_id, recipient_person_id, business_id, channel, versions_read, bundle_hash,
        bundle_build, trace_id
      )
      select 'outbox-rls-copy', turn_id, recipient_handle_id, recipient_person_id, business_id, channel, versions_read,
             bundle_hash, bundle_build, trace_id
      from outbox_rows where id = ${row?.id ?? ""}
      returning commit_seq
    `;
    expect(await as(RUNTIME, null, copy)).toHaveLength(1);
    expect(await as(TOOL_API, row?.business ?? "", copy)).toHaveLength(1);
  });
});

describe("tables that span businesses: phones, handles and sealing keys stay the guard's (MC C1)", () => {
  const guarded = ["phones", "handles", "sealing_keys"];

  it("the Tool API role is refused them (42501), scoped or not; the runtime side reads every row", async () => {
    for (const table of guarded) {
      const all = await rowCount(db.sql, table);
      expect(all, table).toBeGreaterThan(0);
      for (const scope of ["biz-lees-barbershop", null]) {
        const refused = await refusal(as(TOOL_API, scope, (tx) => rowCount(tx, table)));
        expect(refused.code, `${table} ${String(scope)}`).toBe("42501");
        expect(refused.message).toContain(`permission denied for table ${table}`);
      }
      expect(await as(RUNTIME, null, (tx) => rowCount(tx, table)), table).toBe(all);
    }
  });

  it("only the runtime side and the tables' owner hold a grant to read them: never PUBLIC or the Tool API role", async () => {
    const grants = await db.sql<{ table: string; grantee: string }[]>`
      select c.relname as table, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(guarded)}
        and a.privilege_type = 'SELECT'
      order by 1, 2
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    const owner = me?.name ?? "";
    expect(grants).toEqual(
      [...guarded].sort().flatMap((table) => [owner, RUNTIME].sort().map((grantee) => ({ table, grantee }))),
    );
  });

  it("the Tool API role holds no privilege on any table that spans businesses, release_flags included (CQ-59)", async () => {
    const held = await db.sql<{ table: string; privilege: string }[]>`
      select c.relname as table, p.privilege from pg_class c cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(SPANNING)}
        and has_table_privilege(${TOOL_API}, c.oid, p.privilege)
    `;
    expect(held).toEqual([]);
    const refused = await refusal(as(TOOL_API, "biz-lees-barbershop", (tx) => rowCount(tx, "release_flags")));
    expect(refused.code).toBe("42501");
    expect(await as(RUNTIME, null, (tx) => rowCount(tx, "release_flags"))).toBeGreaterThan(0);
  });
});

describe("grants: select and insert, update only on versioned tables, delete only of a person's handle link", () => {
  it("each role holds exactly the privileges the migration names, and no truncate, references or trigger anywhere", async () => {
    const expected = (role: Role, table: ContractTable): string[] => {
      if (role === TOOL_API && table.rowLevelSecurity.scope !== "business") {
        return [];
      }
      return [
        "SELECT",
        "INSERT",
        ...(table.versioned ? ["UPDATE"] : []),
        ...(role === RUNTIME && table.name === "person_handles" ? ["DELETE"] : []),
      ].sort();
    };
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relkind = 'r'
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    const tables = [...ALL_TABLES].sort((a, b) => a.name.localeCompare(b.name));
    const want = ROLES.flatMap((role) =>
      tables.flatMap((table) =>
        expected(role, table).map((privilege) => ({ role, table: table.name, privilege })),
      ),
    );
    expect(held).toEqual(want);
    // The migrations' own table is no role's.
    expect(held.filter((row) => row.table === "schema_migrations")).toEqual([]);
  });

  it("refuse-event-log-update.json under the runtime side: refused by privilege (42501), before the trigger", async () => {
    const fixture = readCore("fixtures/invalid/refuse-event-log-update.json") as RefusedFixture;
    const { refused } = fixture;
    expect([refused.role, refused.action, refused.scope]).toEqual(["runtime", "update", null]);
    const outcome = await refusal(
      as(
        RUNTIME,
        null,
        (tx) =>
          tx`update ${tx(refused.table)} set new_values = ${tx.json(refused.set?.new_values ?? null)}
             where id = ${refused.where.id ?? ""}`,
      ),
    );
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table event_log");
  });

  it("event_log: both roles insert and select; an update, a delete or a truncate is refused by privilege (42501)", async () => {
    for (const role of ROLES) {
      const entry = {
        id: `evlog-rls-${role}`,
        trace_id: "trace-rls-0002",
        job_id: "job-rls-append",
        actor_kind: "job",
        kind: "clock_row.armed",
        business_id: "biz-lees-barbershop",
      };
      expect(
        await as(role, "biz-lees-barbershop", async (tx) => {
          await tx`insert into event_log ${tx(entry)}`;
          return (await tx`select id from event_log where id = ${entry.id}`).length;
        }),
        role,
      ).toBe(1);
      for (const statement of [
        "update event_log set kind = 'edited' where id = 'evlog-0001'",
        "delete from event_log where id = 'evlog-0001'",
        "truncate event_log",
      ]) {
        const refused = await refusal(as(role, "biz-lees-barbershop", (tx) => tx.unsafe(statement)));
        expect(refused.code, `${role}: ${statement}`).toBe("42501");
        expect(refused.message, `${role}: ${statement}`).toContain("permission denied for table event_log");
      }
    }
  });

  it("bundle_values is written once: neither role may update it (CQ-59)", async () => {
    for (const role of ROLES) {
      const refused = await refusal(as(role, null, (tx) => tx`update bundle_values set sha256 = sha256`));
      expect(refused.code, role).toBe("42501");
    }
  });
});

describe("the two functions that read across businesses (K-05 item 8; T-1085)", () => {
  it("are security definer, owned by the tables' owner (not bound by row-level security), bound when made, with a pinned search_path", async () => {
    const rows = await db.sql<
      {
        name: string;
        definer: boolean;
        owner: string;
        config: string[];
        bound: boolean;
        args: string;
        result: string;
      }[]
    >`
      select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
             p.prosqlbody is not null as bound, pg_get_function_identity_arguments(p.oid) as args,
             pg_get_function_result(p.oid) as result
      from pg_proc p where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(FUNCTIONS)}
      order by p.proname
    `;
    const [table] = await db.sql<{ owner: string }[]>`
      select pg_get_userbyid(relowner) as owner from pg_class where oid = ${`${db.schema}.reservations`}::regclass
    `;
    const shared = {
      definer: true,
      owner: table?.owner,
      config: ["search_path=pg_catalog, pg_temp"],
      bound: true,
    };
    expect(rows).toEqual([
      {
        name: "reservations_booked_overlap",
        ...shared,
        args: "resource_wanted text, worker_wanted text, during_wanted tstzrange",
        result: "boolean",
      },
      {
        name: "reservations_saved_times",
        ...shared,
        args: "phone_wanted text, held_after timestamp with time zone",
        result: "TABLE(id text, held_until timestamp with time zone)",
      },
    ]);
  });

  it("only the two roles may run them (and their owner): never PUBLIC", async () => {
    const grants = await db.sql<{ name: string; grantee: string }[]>`
      select p.proname as name, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
      from pg_proc p cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = ${db.schema}::regnamespace and p.proname in ${db.sql(FUNCTIONS)}
        and a.privilege_type = 'EXECUTE'
      order by 1, 2
    `;
    const [me] = await db.sql<{ name: string }[]>`select current_user as name`;
    expect(grants).toEqual(
      FUNCTIONS.flatMap((name) =>
        [me?.name ?? "", TOOL_API, RUNTIME].sort().map((grantee) => ({ name, grantee })),
      ),
    );
  });

  it("run as the Tool API role under one business's scope, they read every business's rows, and the scope stays", async () => {
    // Alex's mobile holds a saved time at Lee's Barbershop (seed-reservation); the yoga studio's scope cannot see it.
    const answer = await as(TOOL_API, "biz-yoga-studio", async (tx) => {
      const direct = await tx<{ id: string }[]>`
        select id from reservations where for_phone_number = '+15555550101' and state = 'held'
      `;
      const saved = await tx<{ id: string }[]>`
        select id from reservations_saved_times('+15555550101', '2026-11-07T15:05:00Z')
      `;
      const [overlap] = await tx<{ yes: boolean }[]>`
        select reservations_booked_overlap('res-maya', 'person-riley',
          tstzrange('2026-10-24T15:10:00Z', '2026-10-24T15:20:00Z', '[)')) as yes
      `;
      const [scope] = await tx<{ value: string }[]>`select current_setting('rosie.business_id') as value`;
      return {
        direct: direct.map((row) => row.id),
        saved: saved.map((row) => row.id),
        overlap: overlap?.yes,
        scope: scope?.value,
      };
    });
    // Riley's booked haircut at Lee's Barbershop covers that time, though the yoga studio's scope cannot see it.
    expect(answer).toEqual({
      direct: [],
      saved: ["rsv-alex-saved-avery"],
      overlap: true,
      scope: "biz-yoga-studio",
    });
  });
});
