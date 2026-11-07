// T-185: release flags against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/flags`).
// The schema comes from migrating a fresh test schema. The seed is contracts/db-schema/core's seed-flag.json.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GLOBAL_SCOPE,
  businessScope,
  createFlag,
  getFlag,
  isFlagOn,
  listFlags,
  phoneScope,
  readFlag,
  updateFlag,
} from "./flags";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  versioned: boolean;
}

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, unknown> }[];
}

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));

function seedRows(file: string, seen = new Set<string>()): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readJson(`fixtures/${file}`) as SeedFile;
  return [...fixture.after.flatMap((before) => seedRows(before, seen)), ...fixture.rows];
}

async function loadSeed(sql: Sql, file: string): Promise<number> {
  const rows = seedRows(file);
  for (const row of rows) {
    const values = { ...row.values };
    // jsonb goes in through sql.json; a null stays null.
    if (values.value !== null && values.value !== undefined) {
      values.value = sql.json(values.value as never);
    }
    await sql`insert into ${sql(row.table)} ${sql(values as never)}`;
  }
  return rows.length;
}

// Later migrations add tables that reference these, so the truncate cascades to them. Each test file runs in its
// own schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate release_flags cascade`;
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

// Test phones of the 555-01xx range (never a real number).
const ALLOWED_PHONE = "+15555550101";
const OTHER_PHONE = "+15555550102";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "flags" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const found = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.find(
    (candidate) => candidate.name === "release_flags",
  );
  if (found === undefined) {
    throw new Error("release_flags is not in the table list");
  }
  const table: ContractTable = found;
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    boolean: "boolean",
    jsonb: "jsonb",
  };

  it("columns, types, nulls and defaults are the table list's", async () => {
    const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
      select column_name as name, data_type as type, is_nullable as nullable, column_default as default
      from information_schema.columns
      where table_schema = ${db.schema} and table_name = 'release_flags'
      order by ordinal_position
    `;
    expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
    for (const column of table.columns) {
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

  it("primary key, checks, and the version trigger are the table list's; no foreign keys, no row-level security", async () => {
    const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
      select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = ${`${db.schema}.release_flags`}::regclass
    `;
    expect(constraints.find((constraint) => constraint.kind === "p")?.definition).toBe(
      `PRIMARY KEY (${(table.primaryKey ?? []).join(", ")})`,
    );
    expect(
      constraints
        .filter((constraint) => constraint.kind === "c")
        .map((constraint) => constraint.name)
        .sort(),
    ).toEqual((table.checks ?? []).map((check) => check.name).sort());
    expect(constraints.filter((constraint) => constraint.kind === "f" || constraint.kind === "u")).toEqual(
      [],
    );
    const triggers = await db.sql<{ name: string }[]>`
      select tgname as name from pg_trigger
      where tgrelid = ${`${db.schema}.release_flags`}::regclass and not tgisinternal
    `;
    expect(triggers.map((trigger) => trigger.name)).toEqual(["release_flags_version_raised"]);
    const [rls] = await db.sql<{ rls: boolean }[]>`
      select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname = 'release_flags'
    `;
    expect(rls?.rls).toBe(false);
  });

  it("refuses a name or a scope in the wrong form, and a second row for one name and scope", async () => {
    await emptyTables(db.sql);
    expect((await refusal(createFlag(db.sql, { name: "Bad Name" }))).constraint).toBe(
      "release_flags_name_form",
    );
    expect((await refusal(createFlag(db.sql, { name: "1flag" }))).constraint).toBe("release_flags_name_form");
    for (const scope of ["business:", "phone:5555550101", "phone:+0555", "team:a", "Global"]) {
      expect((await refusal(createFlag(db.sql, { name: "ok.flag", scope }))).constraint, scope).toBe(
        "release_flags_scope_form",
      );
    }
    await createFlag(db.sql, { name: "ok.flag" });
    expect((await refusal(createFlag(db.sql, { name: "ok.flag" }))).constraint).toBe("release_flags_pkey");
  });

  it("refuses an update that does not raise the version by one", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "ver.flag" });
    expect(
      (await refusal(db.sql`update release_flags set enabled = true where name = 'ver.flag'`)).code,
    ).toBeDefined();
    expect(
      (await refusal(db.sql`update release_flags set enabled = true, version = 5 where name = 'ver.flag'`))
        .code,
    ).toBeDefined();
    expect((await getFlag(db.sql, "ver.flag"))?.enabled).toBe(false);
  });
});

describe("fixture seed-flag", () => {
  it("loads as the fixture has it", async () => {
    await emptyTables(db.sql);
    expect(await loadSeed(db.sql, "seed-flag.json")).toBe(3);
    const rows = await listFlags(db.sql);
    expect(rows).toEqual([
      { name: "journey.1", scope: "global", enabled: false, value: null, version: 1 },
      { name: "skeleton.d-017", scope: "global", enabled: true, value: null, version: 2 },
      {
        name: "staging.text-hours-override",
        scope: "phone:+15555550101",
        enabled: true,
        value: { anyHour: true },
        version: 1,
      },
    ]);
  });

  it("reads as the seed says: journey.1 off, skeleton.d-017 on, the text-hours override on for its phone alone", async () => {
    await emptyTables(db.sql);
    await loadSeed(db.sql, "seed-flag.json");
    expect(await isFlagOn(db.sql, "journey.1")).toBe(false);
    expect(await isFlagOn(db.sql, "skeleton.d-017")).toBe(true);
    expect(await isFlagOn(db.sql, "staging.text-hours-override")).toBe(false);
    expect(await isFlagOn(db.sql, "staging.text-hours-override", { phone: ALLOWED_PHONE })).toBe(true);
    expect(await isFlagOn(db.sql, "staging.text-hours-override", { phone: OTHER_PHONE })).toBe(false);
    expect(
      (await readFlag(db.sql, "staging.text-hours-override", { phone: ALLOWED_PHONE })).decidedBy?.value,
    ).toEqual({
      anyHour: true,
    });
  });
});

describe("a flag can be on for an allow-listed handle only", () => {
  it("is off everywhere but the allow-listed phone: global off, phone on", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "journey.2" });
    await createFlag(db.sql, { name: "journey.2", scope: phoneScope(ALLOWED_PHONE), enabled: true });
    expect(await isFlagOn(db.sql, "journey.2", { phone: ALLOWED_PHONE })).toBe(true);
    expect(await isFlagOn(db.sql, "journey.2", { phone: OTHER_PHONE })).toBe(false);
    expect(await isFlagOn(db.sql, "journey.2", { businessId: "biz-1" })).toBe(false);
    expect(await isFlagOn(db.sql, "journey.2")).toBe(false);
    // The business of an allow-listed phone is not on: only the phone is.
    expect(await isFlagOn(db.sql, "journey.2", { businessId: "biz-1", phone: OTHER_PHONE })).toBe(false);
  });

  it("is off when no row exists at all, whatever the subject", async () => {
    await emptyTables(db.sql);
    expect(await readFlag(db.sql, "nothing.here", { phone: ALLOWED_PHONE, businessId: "biz-1" })).toEqual({
      enabled: false,
      decidedBy: null,
    });
  });

  it("the most specific row decides: phone over business over global, off as well as on", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "layers", enabled: true });
    await createFlag(db.sql, { name: "layers", scope: businessScope("biz-1"), enabled: false });
    await createFlag(db.sql, { name: "layers", scope: phoneScope(ALLOWED_PHONE), enabled: true });
    expect(await isFlagOn(db.sql, "layers")).toBe(true);
    expect(await isFlagOn(db.sql, "layers", { businessId: "biz-2" })).toBe(true);
    expect(await isFlagOn(db.sql, "layers", { businessId: "biz-1" })).toBe(false);
    expect(await isFlagOn(db.sql, "layers", { businessId: "biz-1", phone: ALLOWED_PHONE })).toBe(true);
    expect(await isFlagOn(db.sql, "layers", { businessId: "biz-1", phone: OTHER_PHONE })).toBe(false);
    expect(
      (await readFlag(db.sql, "layers", { businessId: "biz-1", phone: ALLOWED_PHONE })).decidedBy?.scope,
    ).toBe(phoneScope(ALLOWED_PHONE));
  });

  it("a business or phone value that only looks like a scope is matched exactly, never as a pattern", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "exact", scope: businessScope("biz-1"), enabled: true });
    expect(await isFlagOn(db.sql, "exact", { businessId: "biz-%" })).toBe(false);
    expect(await isFlagOn(db.sql, "exact", { businessId: "biz-_" })).toBe(false);
    expect(await isFlagOn(db.sql, "exact", { businessId: "biz-1" })).toBe(true);
  });
});

describe("creating and changing flags", () => {
  it("a flag starts off at version 1 with the global scope; a value rides along", async () => {
    await emptyTables(db.sql);
    expect(await createFlag(db.sql, { name: "fresh.flag" })).toEqual({
      name: "fresh.flag",
      scope: GLOBAL_SCOPE,
      enabled: false,
      value: null,
      version: 1,
    });
    const withValue = await createFlag(db.sql, {
      name: "fresh.flag",
      scope: businessScope("b"),
      value: { n: [1, 2] },
    });
    expect(withValue.value).toEqual({ n: [1, 2] });
  });

  it("updateFlag turns it on at the expected version and raises the version; a stale version changes nothing", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "switch" });
    const on = await updateFlag(db.sql, "switch", GLOBAL_SCOPE, 1, { enabled: true });
    expect(on).toMatchObject({ ok: true, row: { enabled: true, version: 2, value: null } });
    const stale = await updateFlag(db.sql, "switch", GLOBAL_SCOPE, 1, { enabled: false });
    expect(stale).toMatchObject({ ok: false, current: { enabled: true, version: 2 } });
    expect(await updateFlag(db.sql, "absent", GLOBAL_SCOPE, 1, { enabled: true })).toEqual({
      ok: false,
      current: null,
    });
    expect((await getFlag(db.sql, "switch"))?.enabled).toBe(true);
  });

  it("updateFlag sets a value, keeps it when none is given, and clears it with null", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "carry" });
    const set = await updateFlag(db.sql, "carry", GLOBAL_SCOPE, 1, { value: { anyHour: true } });
    expect(set).toMatchObject({ ok: true, row: { value: { anyHour: true }, enabled: false, version: 2 } });
    const keep = await updateFlag(db.sql, "carry", GLOBAL_SCOPE, 2, { enabled: true });
    expect(keep).toMatchObject({ ok: true, row: { value: { anyHour: true }, enabled: true, version: 3 } });
    const clear = await updateFlag(db.sql, "carry", GLOBAL_SCOPE, 3, { value: null });
    expect(clear).toMatchObject({ ok: true, row: { value: null, enabled: true, version: 4 } });
  });

  it("20 parallel updates from one read: exactly one wins, the version rises once", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "race" });
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => updateFlag(db.sql, "race", GLOBAL_SCOPE, 1, { enabled: true })),
    );
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(await getFlag(db.sql, "race")).toMatchObject({ enabled: true, version: 2 });
  });

  it("listFlags lists one flag's rows or every row, in name and scope order", async () => {
    await emptyTables(db.sql);
    await createFlag(db.sql, { name: "b.flag" });
    await createFlag(db.sql, { name: "a.flag", scope: phoneScope(ALLOWED_PHONE) });
    await createFlag(db.sql, { name: "a.flag" });
    expect((await listFlags(db.sql)).map((flag) => `${flag.name} ${flag.scope}`)).toEqual([
      "a.flag global",
      `a.flag ${phoneScope(ALLOWED_PHONE)}`,
      "b.flag global",
    ]);
    expect(await listFlags(db.sql, "b.flag")).toHaveLength(1);
  });
});
