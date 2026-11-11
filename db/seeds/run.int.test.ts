// T-201: the seed runner, db/seeds/run.mjs, run the way deploy-preview runs it after migrate: `node db/seeds/run.mjs
// --set <name>` in a process of its own, with DATABASE_URL and DB_SCHEMA in its environment. Against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/seeds/run`). Each block that seeds migrates a fresh test schema of
// its own (db/repo/test-db.ts) and drops it at the end; the public schema is only read, before and after.
//
// The card's proofs: `--set core` seeds the schema DB_SCHEMA names and no other, the public schema untouched, and a
// second run writes nothing; the output holds a line of row counts for each table and no part of the database URL (its
// user, password, host, port or database name); an unknown set name exits non-zero; sets are found by file name. The
// lead's (DL-341): `--set skeleton` runs only on a database on this machine or on the staging database (the one
// STAGING_DATABASE_URL names), and is refused on any other, production included.
//
// What the rows must be is read here from fixture set v1's shop files (node:fs), never through the seed. The made-up
// URLs below name no real host (.invalid never resolves, RFC 6761), user, password or database.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import type { Sql } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { TEST_OWNER_1 } from "./skeleton";

const SLOW = { timeout: 120_000 };
const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEEDS_DIR = fileURLToPath(new URL("./", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const SHOPS_DIR = fileURLToPath(new URL("../../fixtures/v1/test-kit/shops/", import.meta.url));
const CORE_TABLES = ["businesses", "persons", "person_roles", "handles", "person_handles", "phones"] as const;
const SKELETON_TABLES = [
  "businesses",
  "persons",
  "handles",
  "person_handles",
  "companies",
  "company_kinds",
] as const;
// Every table the two sets write: the public schema's copy of each must be as it was.
const SEEDED_TABLES = [...new Set<string>([...CORE_TABLES, ...SKELETON_TABLES])];
// The variables the runner reads: each run sets only the ones it names.
const RUNNER_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
]);

/** The integration project's database, on this machine (127.0.0.1:54329 here, localhost in CI). */
const LOCAL_URL = resolvePrimaryUrl();
const LOCAL = "the local database";
const STAGING = "the staging database (STAGING_DATABASE_URL)";
// Made up (see the top of this file).
const PRODUCTION_URL =
  "postgres://seed_owner_t201:Pw7kQ2xN9vR4@db-t201-prod.example.invalid:5432/t201_prod_db";
const OTHER_STAGING_URL =
  "postgres://stage_owner_t201:Sx3mH8qL5tB6@db-t201-stage.example.invalid:6543/t201_stage_db";
const REMOTE_STAGING_URL =
  "postgres://stage_owner_t201:Kd9pW2zF7nC3@db-t201-staging.example.invalid:5432/t201_staging_db";

/** fixture set v1's shops: one business head, owner, role, handle, link and phone each (T-200). Read here, not seeded. */
const SHOPS = readdirSync(SHOPS_DIR).filter((file) => file.endsWith(".json")).length;
/** The sets, found as the runner finds them: each db/seeds/<name>.ts whose name is plain (so never a test file). */
const SETS = readdirSync(SEEDS_DIR)
  .filter((file) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.ts$/.test(file))
  .map((file) => file.slice(0, -".ts".length))
  .sort();
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/.test(file))
  .sort();
const USAGE = "usage: node db/seeds/run.mjs --set <name>";
const NOT_LOCAL_OR_STAGING =
  "seed: refused: DATABASE_URL names neither a database on this machine (127.0.0.1, localhost or ::1) nor the " +
  "staging database (the one STAGING_DATABASE_URL names): the seed sets are fixture data for a local database, " +
  "staging and its previews only, never production; nothing was read or written";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node db/seeds/run.mjs <args>` with this environment's variables, less the runner's own, plus `env`. */
function runSeed(args: readonly string[], env: Readonly<Record<string, string>>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !RUNNER_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, ...args],
      { cwd: REPO_ROOT, env: childEnv, timeout: 110_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the runner ended with no exit code"));
        }
      },
    );
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/** Fails when the run's output holds any part of `url`: the whole, its user, password, host, port or database name. */
function expectNoPartOf(url: string, run: Run): void {
  const parsed = new URL(url);
  const texts = [
    url,
    parsed.username,
    decodeURIComponent(parsed.username),
    parsed.password,
    decodeURIComponent(parsed.password),
    parsed.hostname,
    parsed.pathname.slice(1),
  ].filter((part) => part !== "");
  const out = `${run.stdout}${run.stderr}`;
  expect(
    texts.filter((part) => out.includes(part)),
    out,
  ).toEqual([]);
  const port = parsed.port === "" ? "5432" : parsed.port;
  expect(new RegExp(`(?<![0-9A-Za-z])${port}(?![0-9A-Za-z])`).test(out), out).toBe(false);
}

/** The lines a successful run prints: the target, one line of row counts per table, and the totals. */
function seededLines(
  set: string,
  schema: string,
  where: string,
  tables: readonly (readonly [string, number, number])[],
): string[] {
  const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
  const sum = (pick: (table: readonly [string, number, number]) => number): number =>
    tables.reduce((total, table) => total + pick(table), 0);
  const rows = sum(([, n]) => n);
  const inserted = sum(([, , added]) => added);
  return [
    `seed: set ${set} into schema ${schema} on ${where}`,
    ...tables.map(
      ([table, n, added]) =>
        `seed: ${table}: ${plural(n, "row", "rows")} (${String(added)} inserted, ${String(n - added)} kept)`,
    ),
    `seed: done: set ${set} into schema ${schema}: ${plural(rows, "row", "rows")} in ` +
      `${plural(tables.length, "table", "tables")} (${String(inserted)} inserted, ${String(rows - inserted)} kept)`,
  ];
}

/** Row counts of each table in `schema`. */
async function countsIn(
  sql: Sql,
  schema: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(schema)}.${sql(table)}`;
    counts[table] = row?.n ?? -1;
  }
  return counts;
}

/** Every row of each table in `schema`, as text, in order: what a second run must leave as it was. */
async function rowsIn(
  sql: Sql,
  schema: string,
  tables: readonly string[],
): Promise<Record<string, string[]>> {
  const rows: Record<string, string[]> = {};
  for (const table of tables) {
    const found = await sql<{ row: string }[]>`
      select t::text as row from ${sql(schema)}.${sql(table)} as t order by 1
    `;
    rows[table] = found.map((each) => each.row);
  }
  return rows;
}

/** Each seeded table of the public schema: its row count and a digest of every row (null: public has no such table). */
async function publicState(sql: Sql): Promise<Record<string, { rows: number; digest: string } | null>> {
  const state: Record<string, { rows: number; digest: string } | null> = {};
  for (const table of SEEDED_TABLES) {
    const [found] = await sql<{ present: boolean }[]>`
      select to_regclass(${`public.${table}`}) is not null as present
    `;
    if (found?.present !== true) {
      state[table] = null;
      continue;
    }
    const [row] = await sql<{ rows: number; digest: string }[]>`
      select count(*)::int as rows, md5(coalesce(string_agg(t::text, ',' order by t::text), '')) as digest
      from public.${sql(table)} as t
    `;
    state[table] = row === undefined ? null : { rows: row.rows, digest: row.digest };
  }
  return state;
}

/** Whether a schema of that name exists. */
async function schemaExists(sql: Sql, schema: string): Promise<boolean> {
  const [row] = await sql<
    { n: number }[]
  >`select count(*)::int as n from pg_namespace where nspname = ${schema}`;
  return row?.n === 1;
}

// The public schema as it was before any run of this file, read again at its end.
let reader: Sql;
let publicBefore: Awaited<ReturnType<typeof publicState>>;

beforeAll(async () => {
  reader = postgres(LOCAL_URL, { max: 1, onnotice: () => undefined });
  publicBefore = await publicState(reader);
});

afterAll(async () => {
  await reader.end({ timeout: 5 });
});

describe("node db/seeds/run.mjs --set core: the schema DB_SCHEMA names, and no other", () => {
  let db: TestDatabase;
  const CORE_COUNTS = CORE_TABLES.map((table) => [table, SHOPS, SHOPS] as const);
  const CORE_KEPT = CORE_TABLES.map((table) => [table, SHOPS, 0] as const);

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_run" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it(
    "seeds the schema DB_SCHEMA names: each demo shop's row in each of the six core tables, a line of row counts for each table, and no part of the URL",
    SLOW,
    async () => {
      expect(SHOPS).toBe(245);
      const run = await runSeed(["--set", "core"], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(seededLines("core", db.schema, LOCAL, CORE_COUNTS));
      expectNoPartOf(LOCAL_URL, run);
      expect(await countsIn(db.sql, db.schema, CORE_TABLES)).toEqual(
        Object.fromEntries(CORE_TABLES.map((table) => [table, SHOPS])),
      );
    },
  );

  it(
    "runs twice with no change: the second run writes nothing, keeps every row, and leaves each row as it was, version included",
    SLOW,
    async () => {
      const before = await rowsIn(db.sql, db.schema, CORE_TABLES);
      const run = await runSeed(["--set", "core"], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(seededLines("core", db.schema, LOCAL, CORE_KEPT));
      expectNoPartOf(LOCAL_URL, run);
      expect(await rowsIn(db.sql, db.schema, CORE_TABLES)).toEqual(before);
    },
  );

  it(
    "runs --set skeleton on a database on this machine: test owner 1's rows land in the schema DB_SCHEMA names",
    SLOW,
    async () => {
      const run = await runSeed(["--set", "skeleton"], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(
        seededLines(
          "skeleton",
          db.schema,
          LOCAL,
          SKELETON_TABLES.map((table) => [table, 1, 1] as const),
        ),
      );
      expectNoPartOf(LOCAL_URL, run);
      const [owner] = await db.sql<{ businesses: number; persons: number; handles: number }[]>`
        select
          (select count(*)::int from ${db.sql(db.schema)}.businesses where id = ${TEST_OWNER_1.businessId}) as businesses,
          (select count(*)::int from ${db.sql(db.schema)}.persons where id = ${TEST_OWNER_1.personId}) as persons,
          (select count(*)::int from ${db.sql(db.schema)}.handles where id = ${TEST_OWNER_1.handleId}) as handles
      `;
      expect(owner).toEqual({ businesses: 1, persons: 1, handles: 1 });
      expect((await countsIn(db.sql, db.schema, ["businesses"])).businesses).toBe(SHOPS + 1);
    },
  );

  it(
    "runs --set skeleton on the staging database, the one STAGING_DATABASE_URL names (here this machine's), writing nothing new",
    SLOW,
    async () => {
      const before = await rowsIn(db.sql, db.schema, SKELETON_TABLES);
      const run = await runSeed(["--set", "skeleton"], {
        DATABASE_URL: LOCAL_URL,
        STAGING_DATABASE_URL: LOCAL_URL,
        DB_SCHEMA: db.schema,
      });
      expect(run.code, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(
        seededLines(
          "skeleton",
          db.schema,
          STAGING,
          SKELETON_TABLES.map((table) => [table, 1, 0] as const),
        ),
      );
      expectNoPartOf(LOCAL_URL, run);
      expect(await rowsIn(db.sql, db.schema, SKELETON_TABLES)).toEqual(before);
    },
  );
});

describe("--set skeleton runs only on a database on this machine or the staging database, never on another (DL-341)", () => {
  it("refuses skeleton, and every other set, on a database that is neither, with or without a different staging database named, before anything is read", async () => {
    const stagings: Record<string, string>[] = [{}, { STAGING_DATABASE_URL: OTHER_STAGING_URL }];
    for (const set of ["skeleton", "core"]) {
      for (const staging of stagings) {
        const run = await runSeed(["--set", set], { DATABASE_URL: PRODUCTION_URL, ...staging });
        const label = `${set} ${JSON.stringify(Object.keys(staging))}`;
        expect(run.code, label).toBe(1);
        // No "seed: set ... into" line: the set was never loaded, and no connection was made.
        expect(run.stdout, label).toBe("");
        expect(lines(run.stderr), label).toEqual([NOT_LOCAL_OR_STAGING]);
        expectNoPartOf(PRODUCTION_URL, run);
        expectNoPartOf(OTHER_STAGING_URL, run);
      }
    }
  });

  it(
    "takes a staging database on another host past the check: it loads the set and connects there, and the failed connection prints no part of the URL",
    SLOW,
    async () => {
      const run = await runSeed(["--set", "skeleton"], {
        DATABASE_URL: REMOTE_STAGING_URL,
        STAGING_DATABASE_URL: REMOTE_STAGING_URL,
      });
      expect(run.code, run.stderr).toBe(1);
      expect(lines(run.stdout)).toEqual([`seed: set skeleton into schema public on ${STAGING}`]);
      // ENOTFOUND, or EAI_AGAIN where no name server answers.
      expect(run.stderr).toMatch(
        /^seed: failed \((ENOTFOUND|EAI_AGAIN)\): getaddrinfo (ENOTFOUND|EAI_AGAIN) /,
      );
      expectNoPartOf(REMOTE_STAGING_URL, run);
    },
  );
});

describe("what the runner refuses, writing nothing", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_run_refusals" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const local = (): Record<string, string> => ({ DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });

  it("exits 2 on an unknown set name, naming every set in db/seeds/", async () => {
    expect(SETS).toEqual(expect.arrayContaining(["core", "skeleton"]));
    for (const name of ["nope", "lib", "run"]) {
      const run = await runSeed(["--set", name], local());
      expect(run.code, name).toBe(2);
      expect(run.stdout, name).toBe("");
      expect(lines(run.stderr), name).toEqual([
        `seed: no set ${name}: there is no db/seeds/${name}.ts; the sets: ${SETS.join(", ")}`,
        USAGE,
      ]);
    }
  });

  it("exits 2 on a set name that is not a plain lower-case name, so no other file is ever loaded", async () => {
    for (const name of [
      "../repo/client",
      "lib/demo-shops",
      "core.int.test",
      "core.ts",
      "Core",
      "-core",
      "core-",
    ]) {
      const run = await runSeed([`--set=${name}`], local());
      expect(run.code, name).toBe(2);
      expect(lines(run.stderr), name).toEqual([
        `seed: the set name is not a plain lower-case name (a-z, 0-9 and -); the sets: ${SETS.join(", ")}`,
        USAGE,
      ]);
    }
  });

  it("exits 2 on a command line it does not take, echoing none of it", async () => {
    const cases: [readonly string[], string][] = [
      [[], "seed: name the set with --set"],
      [["--set"], "seed: --set needs a set name"],
      [["--set="], "seed: --set needs a set name"],
      [["--set", "core", "--set", "skeleton"], "seed: one set at a time: --set is given more than once"],
      [["--set", "core", "--force"], "seed: unknown argument"],
      [[PRODUCTION_URL], "seed: unknown argument"],
    ];
    for (const [args, says] of cases) {
      const run = await runSeed(args, local());
      expect(run.code, args.join(" ")).toBe(2);
      expect(lines(run.stderr), args.join(" ")).toEqual([says, USAGE]);
      expectNoPartOf(PRODUCTION_URL, run);
    }
  });

  it("exits 2 on a DB_SCHEMA that is not a plain lower-case SQL name, and when CI is set with no DATABASE_URL", async () => {
    for (const schema of ["Preview_Test", "preview-test", "a;drop schema public", `p${"x".repeat(63)}`]) {
      // Misuse is found before the database is judged, so a local and a production URL both exit 2.
      for (const url of [LOCAL_URL, PRODUCTION_URL]) {
        const run = await runSeed(["--set", "core"], { DATABASE_URL: url, DB_SCHEMA: schema });
        expect(run.code, schema).toBe(2);
        expect(lines(run.stderr), schema).toEqual([
          "seed: DB_SCHEMA is not a plain lower-case SQL name ([a-z_][a-z0-9_]*, at most 63 characters)",
          USAGE,
        ]);
        expectNoPartOf(url, run);
      }
    }
    const ci = await runSeed(["--set", "core"], { CI: "true", DB_SCHEMA: db.schema });
    expect(ci.code).toBe(2);
    expect(lines(ci.stderr)).toEqual([
      "seed: DATABASE_URL is not set (the local default is never used when CI is set)",
      USAGE,
    ]);
  });

  it("refuses a DATABASE_URL that does not parse, naming its fault and no part of it", async () => {
    const url = "postgres://seed_owner_t201:2718#Wm5yH8@db-t201-prod.example.invalid:5432/t201_prod_db";
    const run = await runSeed(["--set", "core"], { DATABASE_URL: url, DB_SCHEMA: db.schema });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(
      /^seed: refused: DATABASE_URL does not parse: it holds a # .+; nothing was read or written\n$/,
    );
    for (const part of [
      "seed_owner_t201",
      "2718#Wm5yH8",
      "Wm5yH8",
      "db-t201-prod.example.invalid",
      "t201_prod_db",
    ]) {
      expect(run.stderr.includes(part), part).toBe(false);
    }
  });

  it(
    "refuses a schema that lacks a migration of db/migrations/, so no row can land in public's copy of a table",
    SLOW,
    async () => {
      const newest = MIGRATIONS.at(-1) ?? "";
      expect(newest).toMatch(/^\d{4}_/);
      await db.sql`delete from ${db.sql(db.schema)}.schema_migrations where version = ${newest.slice(0, 4)}`;
      const run = await runSeed(["--set", "core"], local());
      expect(run.code, run.stderr).toBe(1);
      expect(lines(run.stdout)).toEqual([`seed: set core into schema ${db.schema} on ${LOCAL}`]);
      expect(lines(run.stderr)).toEqual([
        `seed: refused: schema ${db.schema} on ${LOCAL} lacks 1 of the ${String(MIGRATIONS.length)} migrations ` +
          `of db/migrations/ (${newest} first): run DB_SCHEMA=${db.schema} npm run migrate first; nothing was written`,
      ]);
      expectNoPartOf(LOCAL_URL, run);
    },
  );

  it("wrote nothing in any of those runs", async () => {
    expect(await countsIn(db.sql, db.schema, SEEDED_TABLES)).toEqual(
      Object.fromEntries(SEEDED_TABLES.map((table) => [table, 0])),
    );
  });
});

describe("sets are found by file name", () => {
  it(
    "loads every db/seeds/<name>.ts under Node, finds its seed function, and refuses a schema that is not there, creating nothing",
    SLOW,
    async () => {
      const absent = `t_seeds_run_absent_${randomBytes(4).toString("hex")}`;
      expect(await schemaExists(reader, absent)).toBe(false);
      expect(SETS.length).toBeGreaterThanOrEqual(2);
      for (const set of SETS) {
        const run = await runSeed(["--set", set], { DATABASE_URL: LOCAL_URL, DB_SCHEMA: absent });
        expect(run.code, `${set}: ${run.stderr}`).toBe(1);
        // This line is printed only once the set's file has loaded and exports seed().
        expect(lines(run.stdout), set).toEqual([`seed: set ${set} into schema ${absent} on ${LOCAL}`]);
        expect(lines(run.stderr), set).toEqual([
          `seed: refused: schema ${absent} on ${LOCAL} is missing or not migrated: ` +
            `run DB_SCHEMA=${absent} npm run migrate first; nothing was written`,
        ]);
        expectNoPartOf(LOCAL_URL, run);
      }
      expect(await schemaExists(reader, absent)).toBe(false);
    },
  );
});

describe("the public schema", () => {
  it("is as it was before any run of this file: every table the sets write holds the same rows", async () => {
    expect(await publicState(reader)).toEqual(publicBefore);
  });
});
