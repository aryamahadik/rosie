// T-192: the conversations and consent part (K-29 v1: chat_links and consents) against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/consent`). The schema comes from migrating a fresh test schema.
//
// The test's connection is the migrations' role, which owns the tables and is not bound by row-level security. A check
// made as the Tool API (rosie_app, K-05 scope business) or the runtime side (rosie_job: the guard, limit 8, the actor)
// runs in its own transaction under SET LOCAL ROLE, scoped by withBusiness() as a call is scoped, and is rolled back.
// Seed fixtures are loaded the same way, as the runtime side (K-04's fixture format: rows are inserted as the runtime
// side), and committed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendConsent,
  findChatLinkByShortCode,
  getChatLink,
  getConsent,
  issueChatLink,
  listConsentsOfPersons,
  newestTextsConsent,
  type NewChatLink,
  type NewConsent,
} from "./consent";
import { type Sql, type Tx, withBusiness } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const PART_DIR = new URL("../../contracts/db-schema/conversations-consent/", import.meta.url);
const FIXTURES_DIR = new URL("fixtures/", PART_DIR);
const TOOL_API = "rosie_app";
const RUNTIME = "rosie_job";
type Role = typeof TOOL_API | typeof RUNTIME;
const ROLES: readonly Role[] = [TOOL_API, RUNTIME];
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const OWN_TABLES = ["chat_links", "consents"];
const BARBERSHOP = "biz-lees-barbershop";
const CLINIC = "biz-lee-nutrition-clinic";
const YOGA = "biz-yoga-studio";
const SLOW = { timeout: 60_000 };

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey: string[];
  foreignKeys: { name: string; columns: string[]; references: { table: string; columns: string[] } }[];
  unique?: { name: string; columns: string[] }[];
  checks: { name: string }[];
  indexes: { name: string; columns: string[]; where?: string }[];
  rowLevelSecurity: { scope: string; column?: string };
  versioned: boolean;
}

interface FixtureRow {
  table: string;
  values: Record<string, Json>;
}

interface Refused {
  role: string;
  scope: { businessId: string } | null;
  action: string;
  table: string;
  values?: Record<string, Json>;
  set?: Record<string, Json>;
  where?: Record<string, Json>;
  expect: { sqlstate?: string; constraintOneOf?: string[] };
}

interface FixtureFile {
  after: string[];
  rows: FixtureRow[];
  refused?: Refused;
}

interface IndexEntry {
  file: string;
  version: string;
  table: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

const TABLES = (
  readJson(new URL("conversations-consent.v1.tables.json", PART_DIR)) as { tables: ContractTable[] }
).tables;
const INDEX = (readJson(new URL("index.json", FIXTURES_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const SEEDS = INDEX.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

const fixtureFile = (file: string): FixtureFile => readJson(new URL(file, FIXTURES_DIR)) as FixtureFile;

function refusedOf(file: string): { fixture: FixtureFile; refused: Refused } {
  const fixture = fixtureFile(file);
  if (fixture.refused === undefined) {
    throw new Error(`${file} has no refused action`);
  }
  return { fixture, refused: fixture.refused };
}

/** The fixtures/ folder a fixture file sits in: a refused fixture sits in fixtures/invalid/. */
function fixturesFolderOf(file: URL): URL {
  const folder = new URL(".", file);
  return folder.href.endsWith("/invalid/") ? new URL("..", folder) : folder;
}

/**
 * A fixture's rows, after those of every fixture its `after` names (each path relative to the fixtures/ folder of the
 * file that names it, so K-29's seeds name K-04's as ../../core/fixtures/<file>), each file once.
 */
function fixtureRows(file: URL, seen: Set<string>): FixtureRow[] {
  if (seen.has(file.href)) {
    return [];
  }
  seen.add(file.href);
  const fixture = readJson(file) as FixtureFile;
  const folder = fixturesFolderOf(file);
  return [...fixture.after.flatMap((before) => fixtureRows(new URL(before, folder), seen)), ...fixture.rows];
}

const sha256Hex = (words: string): string => createHash("sha256").update(words, "utf8").digest("hex");

/** A fixture value as text: a string as it is, anything else as JSON. */
const text = (value: Json | undefined): string => (typeof value === "string" ? value : JSON.stringify(value));

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Thrown to roll a check's transaction back with its answer. */
class RolledBack extends Error {
  constructor(readonly answer: unknown) {
    super("rolled back on purpose");
  }
}

let db: TestDatabase;

/** Runs `fn` in one transaction as `role`, scoped to `businessId` (null: no scope), then rolls it back. */
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

/** Runs `fn` in one transaction as `role`, scoped to `businessId` (null: no scope), and commits it. */
async function committedAs<T>(role: Role, businessId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx): Promise<T> => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  };
  if (businessId !== null) {
    return withBusiness(db.sql, businessId, run);
  }
  const result = await db.sql.begin(run);
  return result as T;
}

/** The SQLSTATE, constraint and message of a refused statement. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string };
    return { code: failure.code, constraint: failure.constraint_name, message: failure.message ?? "" };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

/** Empties every table the fixtures write (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles cascade`;
}

/** Loads fixture files with their `after` chains, each file once, as the runtime side; returns the rows per table. */
async function loadFixtures(files: readonly string[]): Promise<Record<string, number>> {
  const seen = new Set<string>();
  const rows = files.flatMap((file) => fixtureRows(new URL(file, FIXTURES_DIR), seen));
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = current_schema() and data_type in ('jsonb', 'bytea')
  `;
  const typeOf = new Map(typed.map((column) => [column.key, column.type]));
  return committedAs(RUNTIME, null, async (tx) => {
    const loaded: Record<string, number> = {};
    for (const row of rows) {
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
      loaded[row.table] = (loaded[row.table] ?? 0) + 1;
    }
    return loaded;
  });
}

/** A stored value next to the fixture's, a time compared as the instant it names. */
function comparable(stored: unknown, given: Json): [unknown, unknown] {
  if (stored instanceof Date && typeof given === "string") {
    return [stored.toISOString(), new Date(given).toISOString()];
  }
  return [stored, given];
}

/** Every column the fixture gives is stored as given, read back as the owner. */
async function expectStored(row: FixtureRow): Promise<void> {
  expect(typeof row.values.id, `${row.table} row id`).toBe("string");
  const id = text(row.values.id);
  const [stored] = await db.sql<Record<string, unknown>[]>`
    select * from ${db.sql(row.table)} where id = ${id}
  `;
  expect(stored, `${row.table} ${id}`).toBeDefined();
  for (const [column, value] of Object.entries(row.values)) {
    const [actual, wanted] = comparable(stored?.[column], value);
    expect(actual, `${row.table} ${id} ${column}`).toEqual(wanted);
  }
}

async function countRows(sql: Sql | Tx, table: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return row?.n ?? -1;
}

async function visibleIds(sql: Sql | Tx, table: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from ${sql(table)} order by id`;
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "consent" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-29 v1 conversations and consent)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    "text[]": "ARRAY",
    integer: "integer",
    boolean: "boolean",
    timestamptz: "timestamp with time zone",
  };

  it("the table list names chat_links and consents, each scoped by business_id", () => {
    expect(TABLES.map((table) => table.name).sort()).toEqual(OWN_TABLES);
    for (const table of TABLES) {
      expect(table.rowLevelSecurity, table.name).toEqual({ scope: "business", column: "business_id" });
    }
  });

  for (const table of TABLES) {
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

    it(`${table.name}: primary key, checks, foreign keys (on delete restrict), unique rules and indexes are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(constraints.find((constraint) => constraint.kind === "p")?.definition).toBe(
        `PRIMARY KEY (${table.primaryKey.join(", ")})`,
      );
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual(table.checks.map((check) => check.name).sort());
      expect(named("f")).toEqual(table.foreignKeys.map((key) => key.name).sort());
      expect(named("u")).toEqual((table.unique ?? []).map((rule) => rule.name).sort());
      for (const key of table.foreignKeys) {
        expect(constraints.find((constraint) => constraint.name === key.name)?.definition, key.name).toBe(
          `FOREIGN KEY (${key.columns.join(", ")}) REFERENCES ${key.references.table}(${key.references.columns.join(", ")}) ON DELETE RESTRICT`,
        );
      }
      for (const rule of table.unique ?? []) {
        expect(constraints.find((constraint) => constraint.name === rule.name)?.definition, rule.name).toBe(
          `UNIQUE (${rule.columns.join(", ")})`,
        );
      }

      const indexes = await db.sql<{ name: string; definition: string }[]>`
        select indexname as name, indexdef as definition from pg_indexes
        where schemaname = ${db.schema} and tablename = ${table.name}
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...(table.unique ?? []).map((rule) => rule.name),
          ...table.indexes.map((index) => index.name),
        ].sort(),
      );
      for (const wanted of table.indexes) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition, wanted.name).toContain(`(${wanted.columns.join(", ")})`);
        expect(index?.definition.includes(" WHERE "), `${wanted.name} partial`).toBe(
          wanted.where !== undefined,
        );
      }
    });
  }

  it("triggers: chat_links raises its version on every update (0002's rule); consents refuses every edit", async () => {
    const triggers = await db.sql<{ table: string; name: string; definition: string }[]>`
      select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and not t.tgisinternal
      order by 1, 2
    `;
    expect(triggers.map((trigger) => [trigger.table, trigger.name])).toEqual([
      ["chat_links", "chat_links_version_raised"],
      ["consents", "consents_never_edited"],
    ]);
    expect(triggers[0]?.definition).toContain("BEFORE UPDATE ON");
    expect(triggers[0]?.definition).toContain("FOR EACH ROW EXECUTE FUNCTION enforce_version_raise()");
    expect(triggers[1]?.definition).toContain("BEFORE DELETE OR UPDATE ON");
    expect(triggers[1]?.definition).toContain("FOR EACH ROW EXECUTE FUNCTION consents_refuse_edit()");
    for (const table of TABLES) {
      expect(table.versioned, table.name).toBe(table.name === "chat_links");
    }
  });

  it("row-level security is on and not forced, with T-191's two policies on business_id: <table>_tool_api and <table>_runtime", async () => {
    const flags = await db.sql<{ name: string; on: boolean; forced: boolean }[]>`
      select relname as name, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relnamespace = ${db.schema}::regnamespace and relname in ${db.sql(OWN_TABLES)}
      order by relname
    `;
    expect(flags).toEqual(OWN_TABLES.map((name) => ({ name, on: true, forced: false })));
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
      from pg_policies where schemaname = ${db.schema} and tablename in ${db.sql(OWN_TABLES)}
      order by tablename, policyname
    `;
    for (const table of OWN_TABLES) {
      const own = policies.filter((policy) => policy.table === table);
      expect(own.map((policy) => [policy.name, policy.permissive, policy.roles, policy.command])).toEqual([
        [`${table}_runtime`, "PERMISSIVE", [RUNTIME], "ALL"],
        [`${table}_tool_api`, "PERMISSIVE", [TOOL_API], "ALL"],
      ]);
      for (const policy of own) {
        expect(policy.using, policy.name).toContain(
          "business_id = NULLIF(current_setting('rosie.business_id'",
        );
        expect(policy.check, policy.name).toBe(policy.using);
      }
      // Only the runtime side has the unscoped branch.
      expect(own[0]?.using).toContain("IS NULL");
      expect(own[1]?.using).not.toContain("IS NULL");
    }
  });

  it("grants: both roles select, insert and update chat_links, and only select and insert consents; PUBLIC holds nothing", async () => {
    const held = await db.sql<{ role: string; table: string; privilege: string }[]>`
      select r.role, c.relname as table, p.privilege
      from unnest(${[...ROLES]}::text[]) as r(role)
        cross join pg_class c
        cross join unnest(${PRIVILEGES}::text[]) as p(privilege)
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
        and has_table_privilege(r.role, c.oid, p.privilege)
      order by 1, 2, 3
    `;
    expect(held).toEqual(
      ROLES.flatMap((role) => [
        { role, table: "chat_links", privilege: "INSERT" },
        { role, table: "chat_links", privilege: "SELECT" },
        { role, table: "chat_links", privilege: "UPDATE" },
        { role, table: "consents", privilege: "INSERT" },
        { role, table: "consents", privilege: "SELECT" },
      ]),
    );
    const publicGrants = await db.sql<{ table: string }[]>`
      select c.relname as table from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)} and a.grantee = 0
    `;
    expect(publicGrants).toEqual([]);
  });

  it("neither role owns a table or the trigger function: they stay the migrations' role's", async () => {
    const owners = await db.sql<{ name: string; owner: string; me: string }[]>`
      select c.relname as name, pg_get_userbyid(c.relowner) as owner, current_user as me from pg_class c
      where c.relnamespace = ${db.schema}::regnamespace and c.relname in ${db.sql(OWN_TABLES)}
      union all
      select p.proname, pg_get_userbyid(p.proowner), current_user from pg_proc p
      where p.pronamespace = ${db.schema}::regnamespace and p.proname = 'consents_refuse_edit'
      order by 1
    `;
    expect(owners.map((row) => row.name)).toEqual(["chat_links", "consents", "consents_refuse_edit"]);
    for (const row of owners) {
      expect(row.owner, row.name).toBe(row.me);
      expect(ROLES, row.name).not.toContain(row.owner);
    }
  });

  it("is recorded in schema_migrations as consent, after core_rls", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("consent");
    expect(names.indexOf("consent")).toBeGreaterThan(names.indexOf("core_rls"));
  });
});

describe("the four seed fixtures load (fixtures/index.json)", () => {
  it("the index lists four seeds and two refused rows, all K-29 v1", () => {
    expect([...SEEDS].sort()).toEqual([
      "seed-chat-link.json",
      "seed-consent-fee-ok.json",
      "seed-consent-health-agreement.json",
      "seed-consent-stop-row.json",
    ]);
    expect(
      INDEX.filter((entry) => entry.expect === "refuse")
        .map((entry) => entry.file)
        .sort(),
    ).toEqual(["invalid/refuse-consent-update.json", "invalid/refuse-face-match-kind.json"]);
    expect(INDEX.every((entry) => entry.version === "v1" && OWN_TABLES.includes(entry.table))).toBe(true);
  });

  for (const file of SEEDS) {
    it(
      `${file} loads alone with its after chain, as the runtime side, and every K-29 row is stored as given`,
      SLOW,
      async () => {
        await reset();
        const chain = fixtureRows(new URL(file, FIXTURES_DIR), new Set());
        const loaded = await loadFixtures([file]);
        for (const table of OWN_TABLES) {
          const given = chain.filter((row) => row.table === table);
          expect(loaded[table] ?? 0, `${file}: ${table}`).toBe(given.length);
          expect(await countRows(db.sql, table), `${file}: ${table} stored`).toBe(given.length);
          for (const row of given) {
            await expectStored(row);
          }
        }
        expect(fixtureFile(file).rows.some((row) => OWN_TABLES.includes(row.table))).toBe(true);
      },
    );
  }

  it(
    "all four load together, each after chain once: five consent rows and three chat links",
    SLOW,
    async () => {
      await reset();
      const loaded = await loadFixtures(SEEDS);
      expect([loaded.consents, loaded.chat_links, loaded.businesses]).toEqual([5, 3, 4]);
      expect(await visibleIds(db.sql, "consents")).toEqual([
        "consent-avery-texts-yes",
        "consent-ben-stop",
        "consent-ben-texts-yes",
        "consent-sam-fee-ok-barbershop",
        "consent-sam-health-agreement",
      ]);
      expect(await visibleIds(db.sql, "chat_links")).toEqual([
        "chatlink-avery-invite",
        "chatlink-ben-haircut",
        "chatlink-pat-invite",
      ]);
    },
  );

  it("every words_sha256 is the sha256 of its words in UTF-8, lowercase hex, as the database and Node compute it", async () => {
    const rows = await db.sql<{ id: string; words: string; hash: string; computed: string }[]>`
      select id, exact_words as words, words_sha256 as hash,
             encode(sha256(convert_to(exact_words, 'UTF8')), 'hex') as computed
      from consents order by id
    `;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.hash, row.id).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hash, row.id).toBe(row.computed);
      expect(row.hash, row.id).toBe(sha256Hex(row.words));
    }
  });

  it("the reads give the seeded rows back: a consent with its words, a link by its id and by its short code", async () => {
    expect(await getConsent(db.sql, "consent-sam-fee-ok-barbershop")).toMatchObject({
      personId: "person-sam",
      businessId: BARBERSHOP,
      kind: "fee_ok",
      revoked: false,
      handleId: null,
      channel: "text",
      at: new Date("2026-10-19T14:20:00Z"),
      wordsSha256: "1c065e4d9d3e2a53701ddf2b34ff3458938c9a123574777f29f9511f45c5d290",
    });
    expect(await getConsent(db.sql, "consent-none")).toBeNull();
    const ben = await getChatLink(db.sql, "chatlink-ben-haircut");
    expect(ben).toEqual({
      id: "chatlink-ben-haircut",
      shortCode: "4K7Q",
      purpose: "booking",
      businessId: BARBERSHOP,
      bookingId: "booking-ben-haircut",
      personId: "person-ben",
      phoneNumber: "+15555550106",
      readyText: "Hey, send me further updates about my booking. Ref 4K7Q",
      givenVia: ["booking_page", "confirmation_email"],
      issuedAt: new Date("2026-10-05T17:00:00Z"),
      ownerRetoldAt: null,
      usedAt: new Date("2026-10-05T17:00:00Z"),
      version: 3,
    });
    expect(await findChatLinkByShortCode(db.sql, "4K7Q")).toEqual(ben);
    expect(await findChatLinkByShortCode(db.sql, "P5J3")).toMatchObject({
      id: "chatlink-pat-invite",
      purpose: "staff_invite",
      bookingId: null,
      usedAt: null,
      ownerRetoldAt: new Date("2026-10-21T14:40:00Z"),
    });
    expect(await findChatLinkByShortCode(db.sql, "NONE")).toBeNull();
  });
});

describe("refuse-consent-update.json: a consent row is never edited", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-consent-update.json");
  const where = Object.entries(refused.where ?? {});
  const update = (tx: Tx): Promise<unknown> => {
    const sets = Object.entries(refused.set ?? {}).map(
      ([column, value]) => tx`${tx(column)} = ${value as never}`,
    );
    const conditions = where.map(([column, value]) => tx`${tx(column)} = ${value as never}`);
    const set = sets.reduce((all, one) => tx`${all}, ${one}`);
    const condition = conditions.reduce((all, one) => tx`${all} and ${one}`);
    return tx`update ${tx(refused.table)} set ${set} where ${condition}`;
  };
  const targetId = text(refused.where?.id);

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the runtime side, with no scope, updates Sam's fee OK in place; refused by privilege (42501), the row unchanged", async () => {
    expect([refused.role, refused.scope, refused.action, refused.table]).toEqual([
      "runtime",
      null,
      "update",
      "consents",
    ]);
    expect(where.map(([column]) => column)).toEqual(["id"]);
    const before = await getConsent(db.sql, targetId);
    expect(before?.revoked).toBe(false);
    const outcome = await refusal(as(RUNTIME, null, update));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(outcome.message).toContain("permission denied for table consents");
    expect(await getConsent(db.sql, targetId)).toEqual(before);
  });

  it(
    "an update or a delete by either role, scoped or not, is refused by privilege (42501); so is a truncate",
    SLOW,
    async () => {
      const statements = [
        `update consents set revoked = true where id = '${targetId}'`,
        "update consents set exact_words = 'edited'",
        `delete from consents where id = '${targetId}'`,
        "delete from consents",
        "truncate consents",
      ];
      for (const role of ROLES) {
        for (const scope of [BARBERSHOP, null]) {
          for (const statement of statements) {
            const outcome = await refusal(as(role, scope, (tx) => tx.unsafe(statement)));
            expect(outcome.code, `${role} ${String(scope)}: ${statement}`).toBe("42501");
            expect(outcome.message, `${role} ${String(scope)}: ${statement}`).toContain(
              "permission denied for table consents",
            );
          }
        }
      }
      expect(await countRows(db.sql, "consents")).toBe(1);
    },
  );

  it("the tables' owner is refused too, by the trigger (42501), which names the table and never a value", async () => {
    const before = await getConsent(db.sql, targetId);
    for (const statement of [
      db.sql`update consents set revoked = true where id = ${targetId}`,
      db.sql`update consents set exact_words = 'secret-edit-value', words_sha256 = 'x'`,
      db.sql`delete from consents where id = ${targetId}`,
      db.sql`delete from consents`,
    ]) {
      const outcome = await refusal(statement);
      expect(outcome.code).toBe("42501");
      expect(outcome.message).toContain("consents");
      expect(outcome.message).toContain("never edited");
      expect(outcome.message).not.toContain(targetId);
      expect(outcome.message).not.toContain("secret-edit-value");
    }
    expect(await getConsent(db.sql, targetId)).toEqual(before);
  });

  it("without its one fault, the same change as a new row passes, and the earlier row stays as it was", async () => {
    const before = await getConsent(db.sql, targetId);
    if (before === null) {
      throw new Error("the fixture's row is missing");
    }
    const withdrawn = await as(RUNTIME, null, async (tx) => {
      const row = await appendConsent(tx, {
        id: `${targetId}-withdrawn`,
        personId: before.personId,
        businessId: before.businessId,
        kind: before.kind,
        revoked: refused.set?.revoked === true,
        exactWords: "I take back my OK to the fee",
        at: new Date("2026-10-26T09:00:00Z"),
        channel: before.channel,
      });
      return { row, earlier: await getConsent(tx, targetId) };
    });
    expect(withdrawn.row).toMatchObject({ businessId: BARBERSHOP, kind: "fee_ok", revoked: true });
    expect(withdrawn.earlier).toEqual(before);
  });
});

describe("refuse-face-match-kind.json: no face-match consent (MC C10)", () => {
  const { fixture, refused } = refusedOf("invalid/refuse-face-match-kind.json");
  const values = refused.values ?? {};
  const insert = (row: Record<string, Json>) => (tx: Tx) =>
    tx<
      { id: string; kind: string }[]
    >`insert into consents ${tx(row as Record<string, never>)} returning id, kind`;

  beforeAll(async () => {
    await reset();
    await loadFixtures(fixture.after);
  }, 60_000);

  it("the fixture: the Tool API scoped to Lee's Barbershop inserts kind face_match; refused by consents_kind_known (23514)", async () => {
    expect([refused.role, refused.scope?.businessId, refused.action, refused.table]).toEqual([
      "toolApi",
      BARBERSHOP,
      "insert",
      "consents",
    ]);
    expect(values.kind).toBe("face_match");
    const outcome = await refusal(as(TOOL_API, refused.scope?.businessId ?? null, insert(values)));
    expect(outcome.code).toBe(refused.expect.sqlstate);
    expect(refused.expect.constraintOneOf).toContain(outcome.constraint);
  });

  it("without its one fault (kind photos_shown) the same row passes", async () => {
    expect(await as(TOOL_API, BARBERSHOP, insert({ ...values, kind: "photos_shown" }))).toEqual([
      { id: values.id, kind: "photos_shown" },
    ]);
  });

  it("FS line 735's automated calls are refused the same way (no voice provider, Q-05)", async () => {
    const outcome = await refusal(as(TOOL_API, BARBERSHOP, insert({ ...values, kind: "automated_calls" })));
    expect([outcome.code, outcome.constraint]).toEqual(["23514", "consents_kind_known"]);
  });
});

describe("a STOP adds a revoking row and leaves the earlier row untouched (FS line 753; RULES 7.2, 7.5)", () => {
  const stopFixture = fixtureFile("seed-consent-stop-row.json");
  const stopValues = stopFixture.rows.find((row) => row.table === "consents")?.values ?? {};
  const stop: NewConsent = {
    id: text(stopValues.id),
    personId: text(stopValues.person_id),
    businessId: null,
    kind: "texts",
    revoked: true,
    handleId: text(stopValues.handle_id),
    exactWords: text(stopValues.exact_words),
    at: new Date(text(stopValues.at)),
    channel: "text",
  };

  beforeAll(async () => {
    await reset();
    await loadFixtures(["seed-chat-link.json"]);
  }, 60_000);

  it("before: Ben's texts yes, given by his link's ready text, is the newest texts row for his mobile", async () => {
    expect(stopValues.business_id).toBeNull();
    expect(await newestTextsConsent(db.sql, "handle-ben", BARBERSHOP)).toEqual({
      consentId: "consent-ben-texts-yes",
      businessId: BARBERSHOP,
      revoked: false,
      at: new Date("2026-10-05T17:00:00Z"),
    });
    // For a business it was not given for, nothing covers the mobile.
    expect(await newestTextsConsent(db.sql, "handle-ben", YOGA)).toBeNull();
    expect(await newestTextsConsent(db.sql, "handle-ben", null)).toBeNull();
  });

  it("the STOP, appended by the runtime side, is a new row for every business: revoked, texts, his mobile, the hash of its words", async () => {
    const before = await getConsent(db.sql, "consent-ben-texts-yes");
    const row = await committedAs(RUNTIME, null, (tx) => appendConsent(tx, stop));
    expect(row).toEqual({
      ...stop,
      bookingId: null,
      chatLinkId: null,
      turnId: null,
      wordsSha256: stopValues.words_sha256,
    });
    // The seed fixture holds this same STOP row: what the call stored is what the fixture gives.
    await expectStored({ table: "consents", values: stopValues });
    // The earlier row is untouched, every column of it.
    expect(await getConsent(db.sql, "consent-ben-texts-yes")).toEqual(before);
  });

  it("after: the STOP is the newest texts row covering his mobile for every business, and both rows stay", async () => {
    const stopRead = { consentId: stop.id, businessId: null, revoked: true, at: stop.at };
    for (const business of [BARBERSHOP, YOGA, null]) {
      expect(await newestTextsConsent(db.sql, "handle-ben", business), String(business)).toEqual(stopRead);
    }
    expect(
      (await as(RUNTIME, null, (tx) => listConsentsOfPersons(tx, ["person-ben"]))).map((row) => [
        row.id,
        row.revoked,
      ]),
    ).toEqual([
      ["consent-ben-texts-yes", false],
      [stop.id, true],
    ]);
  });

  it("the STOP row has no business, so no business scope reads it, under either role; the runtime side with no scope does", async () => {
    for (const role of ROLES) {
      const scoped = await as(role, BARBERSHOP, async (tx) => ({
        list: (await listConsentsOfPersons(tx, ["person-ben"])).map((row) => row.id),
        stop: await getConsent(tx, stop.id),
      }));
      expect(scoped, role).toEqual({ list: ["consent-ben-texts-yes"], stop: null });
    }
    expect((await as(RUNTIME, null, (tx) => getConsent(tx, stop.id)))?.revoked).toBe(true);
    expect(await as(TOOL_API, null, (tx) => getConsent(tx, stop.id))).toBeNull();
  });

  it("so the newest texts row is read only with no scope: under a business scope the read refuses, never answering the yes", async () => {
    for (const role of ROLES) {
      await expect(
        as(role, BARBERSHOP, (tx) => newestTextsConsent(tx, "handle-ben", BARBERSHOP)),
        role,
      ).rejects.toThrow("newestTextsConsent runs with no business scope");
    }
    expect((await as(RUNTIME, null, (tx) => newestTextsConsent(tx, "handle-ben", BARBERSHOP)))?.revoked).toBe(
      true,
    );
  });

  it("the read without words carries the hash, never the words (K-05 default 36)", async () => {
    const [read] = await as(RUNTIME, null, (tx) => listConsentsOfPersons(tx, ["person-ben"]));
    expect(read).toEqual({
      id: "consent-ben-texts-yes",
      personId: "person-ben",
      businessId: BARBERSHOP,
      kind: "texts",
      revoked: false,
      handleId: "handle-ben",
      bookingId: "booking-ben-haircut",
      wordsSha256: sha256Hex("Hey, send me further updates about my booking. Ref 4K7Q"),
      at: new Date("2026-10-05T17:00:00Z"),
      channel: "text",
      chatLinkId: "chatlink-ben-haircut",
      turnId: null,
    });
    expect(Object.keys(read ?? {})).not.toContain("exactWords");
    expect(await listConsentsOfPersons(db.sql, [])).toEqual([]);
  });

  it("START is one more row, not an edit: it decides now, and the two rows before it stay as they were", async () => {
    const yes = await getConsent(db.sql, "consent-ben-texts-yes");
    const stopped = await getConsent(db.sql, stop.id);
    await committedAs(RUNTIME, null, (tx) =>
      appendConsent(tx, {
        ...stop,
        id: "consent-ben-start",
        revoked: false,
        exactWords: "START",
        at: new Date("2026-10-22T09:00:00Z"),
      }),
    );
    expect(await newestTextsConsent(db.sql, "handle-ben", BARBERSHOP)).toEqual({
      consentId: "consent-ben-start",
      businessId: null,
      revoked: false,
      at: new Date("2026-10-22T09:00:00Z"),
    });
    expect(await getConsent(db.sql, "consent-ben-texts-yes")).toEqual(yes);
    expect(await getConsent(db.sql, stop.id)).toEqual(stopped);
  });

  it("two rows at the same time: the lower id decides (ids compared, never parsed)", async () => {
    const at = new Date("2026-10-23T09:00:00Z");
    await committedAs(RUNTIME, null, async (tx) => {
      await appendConsent(tx, { ...stop, id: "consent-ben-tie-b", revoked: true, at });
      await appendConsent(tx, { ...stop, id: "consent-ben-tie-a", revoked: false, exactWords: "START", at });
    });
    expect(await newestTextsConsent(db.sql, "handle-ben", BARBERSHOP)).toEqual({
      consentId: "consent-ben-tie-a",
      businessId: null,
      revoked: false,
      at,
    });
  });

  it("a switch of contact adds a revoked row for the old contact and a yes for the new one (FS line 756; RULES 9.1)", async () => {
    const mobileYes = await committedAs(RUNTIME, null, (tx) =>
      appendConsent(tx, {
        id: "consent-alex-texts-yes",
        personId: "person-alex",
        businessId: BARBERSHOP,
        kind: "texts",
        handleId: "handle-alex",
        exactWords: "Yes, text me about my booking",
        at: new Date("2026-10-12T16:20:00Z"),
        channel: "text",
      }),
    );
    await committedAs(RUNTIME, BARBERSHOP, async (tx) => {
      await appendConsent(tx, {
        id: "consent-alex-mobile-off",
        personId: "person-alex",
        businessId: BARBERSHOP,
        kind: "texts",
        revoked: true,
        handleId: "handle-alex",
        exactWords: "Send my updates to my email instead",
        at: new Date("2026-10-24T10:00:00Z"),
        channel: "text",
      });
      await appendConsent(tx, {
        id: "consent-alex-email-yes",
        personId: "person-alex",
        businessId: BARBERSHOP,
        kind: "texts",
        handleId: "handle-alex-email",
        exactWords: "Send my updates to my email instead",
        at: new Date("2026-10-24T10:00:00Z"),
        channel: "text",
      });
    });
    expect((await newestTextsConsent(db.sql, "handle-alex", BARBERSHOP))?.consentId).toBe(
      "consent-alex-mobile-off",
    );
    expect((await newestTextsConsent(db.sql, "handle-alex", BARBERSHOP))?.revoked).toBe(true);
    expect(await newestTextsConsent(db.sql, "handle-alex-email", BARBERSHOP)).toMatchObject({
      consentId: "consent-alex-email-yes",
      revoked: false,
    });
    expect(await getConsent(db.sql, mobileYes.id)).toEqual(mobileYes);
  });
});

describe("row-level security on chat_links and consents (K-29 rule 4)", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(SEEDS);
  }, 60_000);

  const seen = (role: Role, scope: string | null): Promise<{ consents: string[]; chatLinks: string[] }> =>
    as(role, scope, async (tx) => ({
      consents: await visibleIds(tx, "consents"),
      chatLinks: await visibleIds(tx, "chat_links"),
    }));
  const allLinks = ["chatlink-avery-invite", "chatlink-ben-haircut", "chatlink-pat-invite"];
  const barbershopConsents = [
    "consent-avery-texts-yes",
    "consent-ben-texts-yes",
    "consent-sam-fee-ok-barbershop",
  ];

  it(
    "a Tool API call sees only its business's rows: never another business's, never a STOP row",
    SLOW,
    async () => {
      expect(await seen(TOOL_API, BARBERSHOP)).toEqual({ consents: barbershopConsents, chatLinks: allLinks });
      expect(await seen(TOOL_API, CLINIC)).toEqual({
        consents: ["consent-sam-health-agreement"],
        chatLinks: [],
      });
      expect(await seen(TOOL_API, YOGA)).toEqual({ consents: [], chatLinks: [] });
    },
  );

  it("with no scope, or a scope that ended (''), the Tool API sees nothing", SLOW, async () => {
    expect(await seen(TOOL_API, null)).toEqual({ consents: [], chatLinks: [] });
    expect(
      await as(TOOL_API, null, async (tx) => {
        await tx`select set_config('rosie.business_id', '', true)`;
        return [await countRows(tx, "consents"), await countRows(tx, "chat_links")];
      }),
    ).toEqual([0, 0]);
  });

  it(
    "the runtime side with no scope sees every row, the STOP row included; with a scope set, only that business's",
    SLOW,
    async () => {
      expect(await seen(RUNTIME, null)).toEqual({
        consents: await visibleIds(db.sql, "consents"),
        chatLinks: allLinks,
      });
      expect((await seen(RUNTIME, null)).consents).toContain("consent-ben-stop");
      expect(await seen(RUNTIME, BARBERSHOP)).toEqual({ consents: barbershopConsents, chatLinks: allLinks });
      expect(await seen(RUNTIME, CLINIC)).toEqual({
        consents: ["consent-sam-health-agreement"],
        chatLinks: [],
      });
    },
  );

  it("matching a sent ready text to its link is runtime work: unscoped it finds any code, a scope finds only its own", async () => {
    expect((await as(RUNTIME, null, (tx) => findChatLinkByShortCode(tx, "R2V9")))?.id).toBe(
      "chatlink-avery-invite",
    );
    expect((await as(TOOL_API, BARBERSHOP, (tx) => findChatLinkByShortCode(tx, "R2V9")))?.id).toBe(
      "chatlink-avery-invite",
    );
    expect(await as(TOOL_API, YOGA, (tx) => findChatLinkByShortCode(tx, "R2V9"))).toBeNull();
    expect(await as(RUNTIME, CLINIC, (tx) => getChatLink(tx, "chatlink-avery-invite"))).toBeNull();
  });

  it("a Tool API call writes only its own business's rows: another business's consent or link, or a row with no business, is refused (42501)", async () => {
    const yes: NewConsent = {
      id: "consent-rls-photos",
      personId: "person-sam",
      businessId: YOGA,
      kind: "photos_shown",
      exactWords: "Photos of the studio shown on the page",
      at: new Date("2026-10-25T10:00:00Z"),
      channel: "page",
    };
    expect((await refusal(as(TOOL_API, BARBERSHOP, (tx) => appendConsent(tx, yes)))).code).toBe("42501");
    expect((await as(TOOL_API, YOGA, (tx) => appendConsent(tx, yes))).businessId).toBe(YOGA);
    const everyBusiness: NewConsent = {
      ...yes,
      businessId: null,
      kind: "texts",
      revoked: true,
      handleId: "handle-sam",
      exactWords: "STOP",
    };
    expect((await refusal(as(TOOL_API, BARBERSHOP, (tx) => appendConsent(tx, everyBusiness)))).code).toBe(
      "42501",
    );
    expect((await refusal(as(RUNTIME, BARBERSHOP, (tx) => appendConsent(tx, everyBusiness)))).code).toBe(
      "42501",
    );
    expect((await as(RUNTIME, null, (tx) => appendConsent(tx, everyBusiness))).revoked).toBe(true);
    const link: NewChatLink = {
      id: "chatlink-rls-invite",
      shortCode: "W8N2",
      purpose: "staff_invite",
      businessId: YOGA,
      bookingId: null,
      personId: "person-maya",
      phoneNumber: "+15555550104",
      readyText: "YES. Ref W8N2",
      givenVia: ["owner"],
    };
    expect((await refusal(as(TOOL_API, BARBERSHOP, (tx) => issueChatLink(tx, link)))).code).toBe("42501");
    expect((await as(TOOL_API, YOGA, (tx) => issueChatLink(tx, link))).version).toBe(1);
  });

  it("a Tool API update of another business's link finds no row; of its own, it raises the version", async () => {
    const give = (tx: Tx): Promise<readonly unknown[]> =>
      tx`update chat_links set given_via = given_via || '{customer_ai}'::text[], version = version + 1
         where id = 'chatlink-ben-haircut' returning version`;
    expect(await as(TOOL_API, YOGA, give)).toHaveLength(0);
    expect(await as(TOOL_API, BARBERSHOP, give)).toEqual([{ version: 4 }]);
    const move = (tx: Tx): Promise<unknown> =>
      tx`update chat_links set business_id = ${YOGA}, version = version + 1 where id = 'chatlink-ben-haircut'`;
    expect((await refusal(as(TOOL_API, BARBERSHOP, move))).code).toBe("42501");
  });
});

describe("each rule of the table list refuses a row that breaks it, for that one reason", () => {
  beforeAll(async () => {
    await reset();
    await loadFixtures(["seed-chat-link.json"]);
  }, 60_000);

  const consent: NewConsent = {
    id: "consent-rule-base",
    personId: "person-sam",
    businessId: BARBERSHOP,
    kind: "fee_ok",
    exactWords: "1",
    at: new Date("2026-10-19T14:20:00Z"),
    channel: "text",
  };
  const link: NewChatLink = {
    id: "chatlink-rule-base",
    shortCode: "Z9X4",
    purpose: "booking",
    businessId: BARBERSHOP,
    bookingId: "booking-ben-haircut",
    personId: "person-ben",
    phoneNumber: "+15555550106",
    readyText: "Hey, send me further updates about my booking. Ref Z9X4",
    givenVia: ["booking_page"],
  };
  const refusedConsent = async (
    fault: Partial<NewConsent>,
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(as(RUNTIME, null, (tx) => appendConsent(tx, { ...consent, ...fault })));
    return [outcome.code, outcome.constraint];
  };
  const refusedLink = async (
    fault: Partial<NewChatLink>,
  ): Promise<[string | undefined, string | undefined]> => {
    const outcome = await refusal(as(RUNTIME, null, (tx) => issueChatLink(tx, { ...link, ...fault })));
    return [outcome.code, outcome.constraint];
  };

  it("the base consent and link pass, and the hash is the database's sha256 of the words, multi-byte words included", async () => {
    expect(await as(RUNTIME, null, (tx) => appendConsent(tx, consent))).toMatchObject({
      id: consent.id,
      revoked: false,
      wordsSha256: sha256Hex("1"),
    });
    const words = "Sí, Tomás está de acuerdo 👍";
    expect(
      (await as(RUNTIME, null, (tx) => appendConsent(tx, { ...consent, exactWords: words }))).wordsSha256,
    ).toBe(sha256Hex(words));
    expect(await as(RUNTIME, null, (tx) => issueChatLink(tx, link))).toMatchObject({
      id: link.id,
      givenVia: ["booking_page"],
      ownerRetoldAt: null,
      usedAt: null,
      version: 1,
    });
  });

  it(
    "consents: kind, channel, words, every-business, contact, ticked terms' booking and the chat link's kind",
    SLOW,
    async () => {
      expect(await refusedConsent({ kind: "face_match" as never })).toEqual(["23514", "consents_kind_known"]);
      expect(await refusedConsent({ channel: "call" as never })).toEqual(["23514", "consents_channel_known"]);
      expect(await refusedConsent({ exactWords: "   " })).toEqual(["23514", "consents_words_given"]);
      expect(await refusedConsent({ businessId: null })).toEqual([
        "23514",
        "consents_every_business_only_texts",
      ]);
      expect(await refusedConsent({ kind: "texts" })).toEqual(["23514", "consents_texts_has_contact"]);
      expect(await refusedConsent({ kind: "ticked_terms" })).toEqual([
        "23514",
        "consents_ticked_terms_has_booking",
      ]);
      expect(await refusedConsent({ chatLinkId: "chatlink-ben-haircut" })).toEqual([
        "23514",
        "consents_chat_link_only_texts",
      ]);
      // Each passes without its fault.
      for (const fixed of [
        { kind: "texts" as const, handleId: "handle-sam" },
        { kind: "texts" as const, handleId: "handle-sam", businessId: null },
        { kind: "ticked_terms" as const, bookingId: "booking-ben-haircut" },
        { kind: "texts" as const, handleId: "handle-ben", chatLinkId: "chatlink-ben-haircut" },
        { channel: "ai" as const },
      ]) {
        expect((await as(RUNTIME, null, (tx) => appendConsent(tx, { ...consent, ...fixed }))).id).toBe(
          consent.id,
        );
      }
    },
  );

  it("consents: a hash that is not its words' is refused (consents_words_sha256_match)", async () => {
    const insert = (hash: string) => (tx: Tx) =>
      tx`insert into consents (id, person_id, business_id, kind, exact_words, words_sha256, at, channel)
         values ('consent-rule-hash', 'person-sam', ${BARBERSHOP}, 'fee_ok', '1', ${hash}, now(), 'text')`;
    const outcome = await refusal(as(RUNTIME, null, insert(sha256Hex("2"))));
    expect([outcome.code, outcome.constraint]).toEqual(["23514", "consents_words_sha256_match"]);
    const upper = await refusal(as(RUNTIME, null, insert(sha256Hex("1").toUpperCase())));
    expect([upper.code, upper.constraint]).toEqual(["23514", "consents_words_sha256_match"]);
    expect(await as(RUNTIME, null, insert(sha256Hex("1")))).toHaveLength(0);
  });

  it("consents: a repeated id, and a missing person, contact, booking, chat link or turn", async () => {
    await committedAs(RUNTIME, null, (tx) => appendConsent(tx, { ...consent, id: "consent-rule-kept" }));
    expect(await refusedConsent({ id: "consent-rule-kept" })).toEqual(["23505", "consents_pkey"]);
    expect(await refusedConsent({ personId: "person-none" })).toEqual(["23503", "consents_person_fk"]);
    expect(await refusedConsent({ businessId: "biz-none" })).toEqual(["23503", "consents_business_fk"]);
    expect(await refusedConsent({ kind: "texts", handleId: "handle-none" })).toEqual([
      "23503",
      "consents_handle_fk",
    ]);
    expect(await refusedConsent({ bookingId: "booking-none" })).toEqual(["23503", "consents_booking_fk"]);
    expect(
      await refusedConsent({ kind: "texts", handleId: "handle-ben", chatLinkId: "chatlink-none" }),
    ).toEqual(["23503", "consents_chat_link_fk"]);
    expect(await refusedConsent({ turnId: "turn-none" })).toEqual(["23503", "consents_turn_fk"]);
  });

  it(
    "chat links: purpose, a booking's link and an invite's, the code's form, the code in the ready text, the places",
    SLOW,
    async () => {
      expect(await refusedLink({ purpose: "owner_signup" as never, bookingId: null })).toEqual([
        "23514",
        "chat_links_purpose_known",
      ]);
      expect(await refusedLink({ bookingId: null })).toEqual([
        "23514",
        "chat_links_booking_only_for_booking",
      ]);
      expect(await refusedLink({ purpose: "staff_invite" })).toEqual([
        "23514",
        "chat_links_booking_only_for_booking",
      ]);
      expect(await refusedLink({ shortCode: "Z9 X4", readyText: "Ref Z9 X4" })).toEqual([
        "23514",
        "chat_links_short_code_form",
      ]);
      expect(await refusedLink({ shortCode: "", readyText: "Hey" })).toEqual([
        "23514",
        "chat_links_short_code_form",
      ]);
      expect(await refusedLink({ readyText: "Hey, send me further updates about my booking." })).toEqual([
        "23514",
        "chat_links_ready_text_has_code",
      ]);
      expect(await refusedLink({ givenVia: [] })).toEqual(["23514", "chat_links_given_via_known"]);
      expect(await refusedLink({ givenVia: ["booking_page", "sms" as never] })).toEqual([
        "23514",
        "chat_links_given_via_known",
      ]);
      // Each passes without its fault.
      for (const fixed of [
        {
          purpose: "staff_invite" as const,
          bookingId: null,
          readyText: "YES. Ref Z9X4",
          givenVia: ["owner" as const],
        },
        {
          givenVia: [
            "booking_page" as const,
            "confirmation_email" as const,
            "customer_ai" as const,
            "owner" as const,
          ],
        },
      ]) {
        expect((await as(RUNTIME, null, (tx) => issueChatLink(tx, { ...link, ...fixed }))).id).toBe(link.id);
      }
    },
  );

  it("chat links: the owner told again only for a staff invite, and a ready text arriving only after the link was issued", async () => {
    const insert =
      (extra: { purpose: string; booking: string | null; retold: string | null; used: string | null }) =>
      (tx: Tx) =>
        tx`insert into chat_links (
             id, short_code, purpose, business_id, booking_id, person_id, phone_number, ready_text, given_via,
             issued_at, owner_retold_at, used_at
           ) values (
             'chatlink-rule-raw', 'Q7R1', ${extra.purpose}, ${BARBERSHOP}, ${extra.booking}, 'person-ben',
             '+15555550106', 'Ref Q7R1', '{owner}', '2026-10-19T14:40:00Z', ${extra.retold}::timestamptz,
             ${extra.used}::timestamptz
           )`;
    const retoldBooking = await refusal(
      as(
        RUNTIME,
        null,
        insert({
          purpose: "booking",
          booking: "booking-ben-haircut",
          retold: "2026-10-21T14:40:00Z",
          used: null,
        }),
      ),
    );
    expect([retoldBooking.code, retoldBooking.constraint]).toEqual(["23514", "chat_links_retold_only_staff"]);
    const usedEarly = await refusal(
      as(
        RUNTIME,
        null,
        insert({ purpose: "staff_invite", booking: null, retold: null, used: "2026-10-19T14:39:59Z" }),
      ),
    );
    expect([usedEarly.code, usedEarly.constraint]).toEqual(["23514", "chat_links_used_after_issued"]);
    expect(
      await as(
        RUNTIME,
        null,
        insert({
          purpose: "staff_invite",
          booking: null,
          retold: "2026-10-21T14:40:00Z",
          used: "2026-10-19T14:40:00Z",
        }),
      ),
    ).toHaveLength(0);
  });

  it("chat links: a short code already used, and a missing business, booking, person or phone", async () => {
    expect(await refusedLink({ shortCode: "4K7Q", readyText: "Ref 4K7Q" })).toEqual([
      "23505",
      "chat_links_short_code_key",
    ]);
    expect(await refusedLink({ id: "chatlink-ben-haircut" })).toEqual(["23505", "chat_links_pkey"]);
    expect(await refusedLink({ businessId: "biz-none" })).toEqual(["23503", "chat_links_business_fk"]);
    expect(await refusedLink({ bookingId: "booking-none" })).toEqual(["23503", "chat_links_booking_fk"]);
    expect(await refusedLink({ personId: "person-none" })).toEqual(["23503", "chat_links_person_fk"]);
    expect(await refusedLink({ phoneNumber: "+15555550199" })).toEqual(["23503", "chat_links_phone_fk"]);
  });

  it("chat links: an update must raise the version by exactly one (chat_links_version_raised)", async () => {
    const outcome = await refusal(
      as(RUNTIME, null, (tx) => tx`update chat_links set used_at = now() where id = 'chatlink-pat-invite'`),
    );
    expect([outcome.code, outcome.constraint]).toEqual(["23514", "chat_links_version_raised"]);
    expect(
      await as(
        RUNTIME,
        null,
        (tx) =>
          tx`update chat_links set used_at = '2026-10-22T08:00:00Z', version = version + 1
             where id = 'chatlink-pat-invite' returning version`,
      ),
    ).toEqual([{ version: 3 }]);
  });
});
