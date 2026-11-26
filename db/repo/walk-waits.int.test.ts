// T-1574: migration 0043, walk_waits, against K-04 v1.3 core's frozen table list and its README's rules V1 to V3
// (contracts/db-schema/core, core.v1.3.tables.json and section "v1.3"; DL-1244, DL-1253), on local PostgreSQL
// (`npm run test:integration -- db/repo/walk-waits.int.test.ts`). The schema comes from migrating a fresh test schema.
// It proves the catalog (the table, its columns, keys, CHECKs, index, grants and policy) and that the database refuses
// each refused v1.3 fixture for its one reason and passes it put right. Every fixture row is loaded inside a transaction
// that is rolled back, so the table stays as the migration left it: empty.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const TABLE = "walk_waits";
const RUNTIME = "rosie_job";
const TOOL_API = "rosie_app";
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey: string[];
  foreignKeys: {
    name: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete: string;
  }[];
  unique: { name: string; columns: string[]; where?: string }[];
  checks: { name: string; expression: string }[];
  rowLevelSecurity: { scope: string; column: string };
  versioned: boolean;
}

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
  refused?: {
    role: string;
    scope: string | null;
    action: "insert" | "update";
    table: string;
    values?: Record<string, Json>;
    set?: Record<string, Json>;
    where?: Record<string, Json>;
    expect: { sqlstate: string; constraintOneOf: string[] };
  };
}

const readCore = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));

const LIST = readCore("core.v1.3.tables.json") as { version: string; tables: ContractTable[] };
const WALK_WAITS = LIST.tables.find((table) => table.name === TABLE);
if (WALK_WAITS === undefined) {
  throw new Error("core.v1.3.tables.json lists no walk_waits");
}
const CONTRACT: ContractTable = WALK_WAITS;
const INDEX = readCore("fixtures/index.json") as {
  fixtures: { file: string; version: string; table: string; expect: string }[];
};

/** The rows of a fixture and of the fixtures it names in `after`, each file once, in load order. */
function fixtureRows(file: string, seen: Set<string>): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const loaded = readCore(`fixtures/${file}`) as FixtureFile;
  return [...loaded.after.flatMap((before) => fixtureRows(before, seen)), ...loaded.rows];
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;

/** Runs `fn` in one transaction as the tables' owner, then rolls it back, returning `fn`'s answer. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    throw error;
  }
  throw new Error("the check's transaction was not rolled back");
}

/**
 * Runs `fn` in a savepoint as `role` ("none": the session's own role, the tables' owner), scoped to `businessId` for
 * the savepoint (null: no scope), then rolls the savepoint back, so the role and the scope end with it. A refused
 * statement's error comes back as the answer.
 */
async function asRole<T>(
  tx: Tx,
  role: string,
  businessId: string | null,
  fn: (sp: Tx) => Promise<T>,
): Promise<T | { code: string | undefined; constraint: string | undefined }> {
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(`set local role ${role}`);
      if (businessId !== null) {
        await sp`select set_config('rosie.business_id', ${businessId}, true)`;
      }
      throw new RolledBack(await fn(sp as Tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return error.answer as T;
    }
    const failure = error as { code?: string; constraint_name?: string };
    if (failure.code === undefined) {
      throw error;
    }
    return { code: failure.code, constraint: failure.constraint_name };
  }
  throw new Error("the savepoint was not rolled back");
}

/** Loads a fixture's rows and its `after` chain as the owner, inside `tx`, skipping the files `seen` holds. */
async function loadFixture(tx: Tx, file: string, seen = new Set<string>()): Promise<void> {
  const typed = await tx<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  const typeOf = new Map(typed.map((column) => [column.key, column.type]));
  for (const row of fixtureRows(file, seen)) {
    const values: Record<string, never> = {};
    for (const [column, value] of Object.entries(row.values)) {
      const type = typeOf.get(`${row.table}.${column}`);
      let converted: unknown = value;
      if (type === "jsonb" && value !== null) {
        converted = tx.json(value);
      } else if (type === "bytea" && typeof value === "string") {
        converted = fromHex(value.replace(/^\\x/, ""));
      }
      values[column] = converted as never;
    }
    await tx`insert into ${tx(row.table)} ${tx(values)}`;
  }
}

/** The refused fixture's own action, as its `refused` block states it, with `put` laid over its values or set. */
function refusedAction(
  sp: Tx,
  refused: NonNullable<FixtureFile["refused"]>,
  put: Record<string, Json> = {},
): Promise<unknown> {
  if (refused.action === "insert") {
    return sp`insert into ${sp(refused.table)} ${sp({ ...refused.values, ...put } as Record<string, never>)}`;
  }
  const where = Object.entries(refused.where ?? {});
  const [first] = where;
  if (first === undefined || where.length !== 1) {
    throw new Error("the refused update names one where column");
  }
  return sp`
    update ${sp(refused.table)} set ${sp({ ...refused.set, ...put } as Record<string, never>)}
    where ${sp(first[0])} = ${first[1] as string}
  `;
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "walk_waits" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("migration 0043: walk_waits against K-04 v1.3 core's table list", () => {
  const typeNames: Record<string, string> = { text: "text", timestamptz: "timestamp with time zone" };

  it("the list is v1.3's and walk_waits is its last table, unversioned, scoped by business on business_id", () => {
    expect(LIST.version).toBe("v1.3");
    expect(LIST.tables.at(-1)?.name).toBe(TABLE);
    expect(CONTRACT.versioned).toBe(false);
    expect(CONTRACT.rowLevelSecurity).toEqual({ scope: "business", column: "business_id" });
  });

  it("is a plain table, empty as made, with row-level security on and not forced on its owner", async () => {
    const rows = await db.sql<{ kind: string; rls: boolean; forced: boolean }[]>`
      select c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c where c.oid = ${`${db.schema}.${TABLE}`}::regclass
    `;
    expect(rows).toEqual([{ kind: "r", rls: true, forced: false }]);
    expect(await db.sql`select 1 from walk_waits`).toHaveLength(0);
  });

  it("columns: the list's nine in its order, with its types and nulls and no defaults", async () => {
    const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
      select column_name as name, data_type as type, is_nullable as nullable, column_default as default
      from information_schema.columns
      where table_schema = ${db.schema} and table_name = ${TABLE}
      order by ordinal_position
    `;
    expect(found.map((column) => column.name)).toEqual([
      "id",
      "business_id",
      "person_id",
      "step_id",
      "key",
      "waiting_since",
      "turn_id",
      "ended_at",
      "ended_by_turn_id",
    ]);
    expect(found).toEqual(
      CONTRACT.columns.map((column) => ({
        name: column.name,
        type: typeNames[column.type],
        nullable: column.null ? "YES" : "NO",
        default: column.default ?? null,
      })),
    );
  });

  it("keys: the primary key and the four foreign keys, each as the list names it, on delete restrict", async () => {
    const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
      select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = ${`${db.schema}.${TABLE}`}::regclass and contype in ('p', 'f', 'u', 'x')
      order by conname
    `;
    const wanted = [
      { name: "walk_waits_pkey", kind: "p", definition: `PRIMARY KEY (${CONTRACT.primaryKey.join(", ")})` },
      ...CONTRACT.foreignKeys.map((key) => {
        expect(key.onDelete, key.name).toBe("restrict");
        return {
          name: key.name,
          kind: "f",
          definition:
            `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(` +
            `${key.references.columns.join(", ")}) ON DELETE RESTRICT`,
        };
      }),
    ].sort((a, b) => a.name.localeCompare(b.name));
    expect(CONTRACT.foreignKeys.map((key) => key.name).sort()).toEqual([
      "walk_waits_business_fk",
      "walk_waits_ended_by_turn_fk",
      "walk_waits_person_fk",
      "walk_waits_turn_fk",
    ]);
    // No unique or exclusion constraint: the one-live rule is a partial unique index (the next case).
    expect(constraints).toEqual(wanted);
  });

  it("checks: the list's two, its expressions word for word as PostgreSQL holds them, each validated", async () => {
    const found = await db.sql<{ name: string; definition: string; validated: boolean }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition, convalidated as validated
      from pg_constraint where conrelid = ${`${db.schema}.${TABLE}`}::regclass and contype = 'c'
      order by conname
    `;
    expect(found.map((row) => row.name)).toEqual([
      "walk_waits_ended_after_waiting",
      "walk_waits_ended_by_turn",
    ]);
    expect(found.every((row) => row.validated)).toBe(true);
    // The list's own text, put on a throwaway twin of the columns, deparses to what the migration made: the same
    // expression, never a looser or a stricter one. The twin is dropped with the rolled-back transaction.
    const twin = await rolledBack(async (tx) => {
      await tx`create temp table walk_waits_twin (waiting_since timestamptz, ended_at timestamptz, ended_by_turn_id text)`;
      for (const check of CONTRACT.checks) {
        await tx.unsafe(
          `alter table walk_waits_twin add constraint ${check.name} check (${check.expression})`,
        );
      }
      return tx<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = to_regclass('pg_temp.walk_waits_twin') order by conname
      `;
    });
    expect(twin).toHaveLength(2);
    expect(found.map((row) => ({ name: row.name, definition: row.definition }))).toEqual(
      twin.map((row) => ({ name: row.name, definition: row.definition })),
    );
  });

  it("index: walk_waits_one_live, unique on (person_id, business_id, step_id) where ended_at is null, and no other but the key's", async () => {
    const [unique] = CONTRACT.unique;
    expect(CONTRACT.unique).toHaveLength(1);
    expect(unique).toEqual(
      expect.objectContaining({
        name: "walk_waits_one_live",
        columns: ["person_id", "business_id", "step_id"],
        where: "ended_at is null",
      }),
    );
    const indexes = await db.sql<{ name: string; definition: string }[]>`
      select indexname as name, indexdef as definition from pg_indexes
      where schemaname = ${db.schema} and tablename = ${TABLE} order by indexname
    `;
    expect(indexes.map((index) => index.name)).toEqual(["walk_waits_one_live", "walk_waits_pkey"]);
    const shape = async (
      tx: Tx | TestDatabase["sql"],
      table: string,
      name: string,
    ): Promise<{ unique: boolean; valid: boolean; columns: string[]; predicate: string | null }[]> =>
      tx<{ unique: boolean; valid: boolean; columns: string[]; predicate: string | null }[]>`
        select i.indisunique as unique, i.indisvalid as valid,
               array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum, n)
                       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum order by k.n) as columns,
               pg_get_expr(i.indpred, i.indrelid) as predicate
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = ${table}::regclass and c.relname = ${name}
      `;
    const made = await shape(db.sql, `${db.schema}.${TABLE}`, "walk_waits_one_live");
    // The list's own columns and predicate, put on a throwaway twin, give the same index.
    const twin = await rolledBack(async (tx) => {
      await tx`create temp table walk_waits_twin (person_id text, business_id text, step_id text, ended_at timestamptz)`;
      await tx.unsafe(
        `create unique index walk_waits_one_live_twin on walk_waits_twin (${(unique?.columns ?? []).join(", ")}) ` +
          `where ${unique?.where ?? "false"}`,
      );
      return shape(tx, "pg_temp.walk_waits_twin", "walk_waits_one_live_twin");
    });
    expect(made).toEqual([
      {
        unique: true,
        valid: true,
        columns: ["person_id", "business_id", "step_id"],
        predicate: "(ended_at IS NULL)",
      },
    ]);
    expect(made).toEqual(twin);
  });

  it("no trigger of its own: no version to raise (rule V3), and only the foreign keys' internal ones", async () => {
    const triggers = await db.sql<{ name: string }[]>`
      select tgname as name from pg_trigger
      where tgrelid = ${`${db.schema}.${TABLE}`}::regclass and not tgisinternal
    `;
    expect(triggers).toEqual([]);
  });

  it("grants (rule V1): rosie_job SELECT and INSERT on the table and UPDATE of ended_at and ended_by_turn_id alone; rosie_app and PUBLIC nothing; no DELETE, TRUNCATE, REFERENCES or TRIGGER", async () => {
    const tableGrants = await db.sql<{ grantee: string; privilege: string }[]>`
      select case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_class c cross join lateral aclexplode(c.relacl) g
      where c.oid = ${`${db.schema}.${TABLE}`}::regclass and g.grantee <> c.relowner
      order by 1, 2
    `;
    expect(tableGrants).toEqual([
      { grantee: RUNTIME, privilege: "INSERT" },
      { grantee: RUNTIME, privilege: "SELECT" },
    ]);
    const columnGrants = await db.sql<{ column: string; grantee: string; privilege: string }[]>`
      select a.attname as column,
             case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee) end as grantee,
             g.privilege_type as privilege
      from pg_attribute a cross join lateral aclexplode(a.attacl) g
      where a.attrelid = ${`${db.schema}.${TABLE}`}::regclass and a.attacl is not null
      order by 1, 2, 3
    `;
    expect(columnGrants).toEqual([
      { column: "ended_at", grantee: RUNTIME, privilege: "UPDATE" },
      { column: "ended_by_turn_id", grantee: RUNTIME, privilege: "UPDATE" },
    ]);
    // What each role holds on the whole table, as PostgreSQL answers it (a column grant is not a table privilege).
    const held = await db.sql<{ role: string; privilege: string }[]>`
      select r.role, p.privilege
      from unnest(${[RUNTIME, TOOL_API]}::text[]) as r(role)
        cross join unnest(${[...PRIVILEGES]}::text[]) as p(privilege)
      where has_table_privilege(r.role, ${`${db.schema}.${TABLE}`}::regclass, p.privilege)
      order by 1, 2
    `;
    expect(held).toEqual([
      { role: RUNTIME, privilege: "INSERT" },
      { role: RUNTIME, privilege: "SELECT" },
    ]);
    const anyColumn = await db.sql<{ role: string; privilege: string }[]>`
      select r.role, p.privilege
      from unnest(${[RUNTIME, TOOL_API]}::text[]) as r(role)
        cross join unnest(${["SELECT", "INSERT", "UPDATE", "REFERENCES"]}::text[]) as p(privilege)
      where has_any_column_privilege(r.role, ${`${db.schema}.${TABLE}`}::regclass, p.privilege)
      order by 1, 2
    `;
    expect(anyColumn).toEqual([
      { role: RUNTIME, privilege: "INSERT" },
      { role: RUNTIME, privilege: "SELECT" },
      { role: RUNTIME, privilege: "UPDATE" },
    ]);
  });

  it("policy (rule V2): one, walk_waits_runtime, for rosie_job and every command, in 0012's form", async () => {
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
      from pg_policies where schemaname = ${db.schema} and tablename in (${TABLE}, 'person_roles')
        and policyname in ('walk_waits_runtime', 'walk_waits_tool_api', 'person_roles_runtime')
      order by tablename, policyname
    `;
    const own = policies.filter((policy) => policy.table === TABLE);
    expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
      ["walk_waits_runtime", "PERMISSIVE", [RUNTIME], "ALL"],
    ]);
    const all = await db.sql<{ name: string }[]>`
      select policyname as name from pg_policies where schemaname = ${db.schema} and tablename = ${TABLE}
    `;
    expect(all).toEqual([{ name: "walk_waits_runtime" }]);
    // 0012's runtime form on a business_id column, as person_roles_runtime holds it, in using and with check alike.
    const pattern = policies.find((policy) => policy.name === "person_roles_runtime");
    expect(pattern).toBeDefined();
    expect(own[0]?.using).toBe(pattern?.using);
    expect(own[0]?.check).toBe(pattern?.check);
    expect(own[0]?.using).toContain("business_id");
    expect(own[0]?.using).toContain("rosie.business_id");
  });
});

describe("the v1.3 fixtures on PostgreSQL (README section v1.3)", () => {
  const v13 = INDEX.fixtures.filter((entry) => entry.version === "v1.3");

  it("the index lists two accepted and two refused v1.3 fixtures, all on walk_waits", () => {
    expect(v13.map((entry) => [entry.file, entry.table, entry.expect])).toEqual([
      ["seed-walk-wait-live.json", TABLE, "accept"],
      ["seed-walk-wait-ended.json", TABLE, "accept"],
      ["invalid/refuse-walk-wait-second-live.json", TABLE, "refuse"],
      ["invalid/refuse-walk-wait-ended-without-turn.json", TABLE, "refuse"],
    ]);
  });

  it("both accepted fixtures load; rosie_job reads Sam's one live wait at the barbershop by item 97's read, with no scope and in its scope, and nothing in another's", async () => {
    const answer = await rolledBack(async (tx) => {
      await loadFixture(tx, "seed-walk-wait-live.json");
      const rows = await tx<{ id: string; ended: boolean }[]>`
        select id, ended_at is not null as ended from walk_waits order by id
      `;
      const read = (sp: Tx): Promise<{ step_id: string; key: string }[]> => sp<
        { step_id: string; key: string }[]
      >`
        select step_id, key from walk_waits
        where person_id = 'person-sam' and business_id = 'biz-lees-barbershop' and ended_at is null
      `;
      return {
        rows,
        unscoped: await asRole(tx, RUNTIME, null, read),
        scoped: await asRole(tx, RUNTIME, "biz-lees-barbershop", read),
        otherBusiness: await asRole(tx, RUNTIME, "biz-yoga-studio", (sp) => sp`select id from walk_waits`),
      };
    });
    expect(answer).toEqual({
      rows: [
        { id: "wait-s1-10-sam", ended: true },
        { id: "wait-s1-32-sam", ended: false },
      ],
      unscoped: [{ step_id: "S1-32", key: "control_proven" }],
      scoped: [{ step_id: "S1-32", key: "control_proven" }],
      otherBusiness: [],
    });
  });

  for (const file of [
    "invalid/refuse-walk-wait-second-live.json",
    "invalid/refuse-walk-wait-ended-without-turn.json",
  ]) {
    it(`${file} is refused by the database for its one reason`, async () => {
      const fixture = readCore(`fixtures/${file}`) as FixtureFile;
      const refused = fixture.refused;
      if (refused === undefined) {
        throw new Error(`${file} has no refused block`);
      }
      // The runtime side with no scope, as each refused block states.
      expect([refused.role, refused.scope, refused.table]).toEqual(["runtime", null, TABLE]);
      const answer = await rolledBack(async (tx) => {
        await loadFixture(tx, file);
        return asRole(tx, RUNTIME, null, (sp) => refusedAction(sp, refused));
      });
      expect(answer).toEqual({
        code: refused.expect.sqlstate,
        constraint: refused.expect.constraintOneOf[0],
      });
    });
  }

  it("each refused fixture passes put right: the second live row at the yoga studio; the end with its turn", async () => {
    const second = readCore("fixtures/invalid/refuse-walk-wait-second-live.json") as FixtureFile;
    const ended = readCore("fixtures/invalid/refuse-walk-wait-ended-without-turn.json") as FixtureFile;
    if (second.refused === undefined || ended.refused === undefined) {
      throw new Error("a refused fixture has no refused block");
    }
    const secondRefused = second.refused;
    const endedRefused = ended.refused;
    const answer = await rolledBack(async (tx) => {
      // Both twins' rows, their shared after chain once.
      const seen = new Set<string>();
      await loadFixture(tx, "invalid/refuse-walk-wait-second-live.json", seen);
      await loadFixture(tx, "invalid/refuse-walk-wait-ended-without-turn.json", seen);
      const yoga = await asRole(tx, RUNTIME, null, async (sp) => {
        await refusedAction(sp, secondRefused, { business_id: "biz-yoga-studio" });
        return sp<{ id: string; business_id: string }[]>`
          select id, business_id from walk_waits where id = 'wait-s1-32-sam-again'
        `;
      });
      const end = await asRole(tx, RUNTIME, null, async (sp) => {
        await refusedAction(sp, endedRefused, { ended_by_turn_id: "turn-control-proven-sam" });
        return sp<{ ended_at: Date; ended_by_turn_id: string }[]>`
          select ended_at, ended_by_turn_id from walk_waits where id = 'wait-s1-32-sam'
        `;
      });
      return { yoga, end };
    });
    expect(answer).toEqual({
      yoga: [{ id: "wait-s1-32-sam-again", business_id: "biz-yoga-studio" }],
      end: [{ ended_at: new Date("2026-10-19T15:02:40Z"), ended_by_turn_id: "turn-control-proven-sam" }],
    });
  });
});

describe("what else the database holds (rules V1 to V3)", () => {
  it("rosie_job cannot change a row's other columns or delete it (42501); rosie_app cannot read or write it (42501)", async () => {
    const answer = await rolledBack(async (tx) => {
      await loadFixture(tx, "seed-walk-wait-live.json");
      const otherColumns: Record<string, unknown> = {};
      for (const column of ["id", "business_id", "person_id", "step_id", "key", "waiting_since", "turn_id"]) {
        otherColumns[column] = await asRole(tx, RUNTIME, null, (sp) =>
          sp.unsafe(`update walk_waits set ${column} = ${column} where id = 'wait-s1-32-sam'`),
        );
      }
      return {
        otherColumns,
        remove: await asRole(
          tx,
          RUNTIME,
          null,
          (sp) => sp`delete from walk_waits where id = 'wait-s1-32-sam'`,
        ),
        appRead: await asRole(tx, TOOL_API, "biz-lees-barbershop", (sp) => sp`select id from walk_waits`),
        appInsert: await asRole(
          tx,
          TOOL_API,
          "biz-lees-barbershop",
          (sp) => sp`
            insert into walk_waits (id, business_id, person_id, step_id, key, waiting_since, turn_id)
            values ('wait-app', 'biz-lees-barbershop', 'person-sam', 'S1-09', 'id_checked', now(), 'turn-s1-32-sam')
          `,
        ),
      };
    });
    const denied = { code: "42501", constraint: undefined };
    expect(answer).toEqual({
      otherColumns: {
        id: denied,
        business_id: denied,
        person_id: denied,
        step_id: denied,
        key: denied,
        waiting_since: denied,
        turn_id: denied,
      },
      remove: denied,
      appRead: denied,
      appInsert: denied,
    });
  });

  it("an end at the stop's own instant is refused (walk_waits_ended_after_waiting, 23514); a key to a missing row is refused (23503); the owner cannot delete a turn a wait names", async () => {
    const answer = await rolledBack(async (tx) => {
      await loadFixture(tx, "seed-walk-wait-live.json");
      const sameInstant = await asRole(
        tx,
        RUNTIME,
        null,
        (sp) => sp`
          update walk_waits set ended_at = waiting_since, ended_by_turn_id = 'turn-s1-32-sam' where id = 'wait-s1-32-sam'
        `,
      );
      const insert = (values: Record<string, unknown>): Promise<unknown> =>
        asRole(
          tx,
          RUNTIME,
          null,
          (sp) => sp`
            insert into walk_waits ${sp({
              id: "wait-fk",
              business_id: "biz-lees-barbershop",
              person_id: "person-sam",
              step_id: "S1-09",
              key: "id_checked",
              waiting_since: "2026-10-19T14:40:00Z",
              turn_id: "turn-s1-32-sam",
              ...values,
            } as never)}
          `,
        );
      const keys = {
        business: await insert({ business_id: "biz-none" }),
        person: await insert({ person_id: "person-none" }),
        turn: await insert({ turn_id: "turn-none" }),
        endedBy: await insert({ ended_at: "2026-10-19T14:50:00Z", ended_by_turn_id: "turn-none" }),
      };
      // As the tables' owner (role none: the session's own), whom no grant limits.
      const deleteTurn = await asRole(
        tx,
        "none",
        null,
        (sp) => sp`delete from turns where id = 'turn-s1-32-sam'`,
      );
      return { sameInstant, keys, deleteTurn };
    });
    expect(answer).toEqual({
      sameInstant: { code: "23514", constraint: "walk_waits_ended_after_waiting" },
      keys: {
        business: { code: "23503", constraint: "walk_waits_business_fk" },
        person: { code: "23503", constraint: "walk_waits_person_fk" },
        turn: { code: "23503", constraint: "walk_waits_turn_fk" },
        endedBy: { code: "23503", constraint: "walk_waits_ended_by_turn_fk" },
      },
      deleteTurn: { code: "23503", constraint: "walk_waits_turn_fk" },
    });
  });
});

describe("the migration queue", () => {
  it("records 0043 as walk_waits, the newest file", async () => {
    const rows = await db.sql<{ version: string; name: string }[]>`
      select version, name from schema_migrations order by version
    `;
    expect(rows.at(-1)).toEqual({ version: "0043", name: "walk_waits" });
  });
});
