// T-1333: migration 0035 (db/migrations/0035_core_migrator_set_role.sql) against a migrations' role that is no
// superuser, as staging's is (Neon; DL-634), on local PostgreSQL (`npm run db:up`;
// `npm run test:integration -- db/test/core-migrator-set-role`).
//
// The local and CI login, rosie, is a superuser and may become any role, so no other test meets staging's gap. This file
// makes a login of its own that is no superuser (LOGIN CREATEROLE, as staging's migrations' role), which migrates a
// throwaway schema of its own with infra/scripts/migrate.mjs: first every file before 0035, then 0035, each run reading
// a folder that holds only the files given so far (MIGRATIONS_DIR). The seed runner then runs as it. rosie_app and
// rosie_job are cluster-wide and were made on this server by rosie, so this login did not make them: rosie gives it the
// row PostgreSQL 16 and later add for a maker that is no superuser (WITH ADMIN TRUE, INHERIT FALSE, SET FALSE, granted
// by the bootstrap superuser), and the first test shows that a role the login makes itself gets exactly that row.
//
// Roles are cluster-wide and the build Mac's one server is shared with other runs, so every role and schema here is
// named after this run (t1333_<6 hex>), and all are dropped at the file's end, pass or fail; another run's are never
// touched. A role that needs no login is checked inside a transaction of rosie's under SET LOCAL ROLE: that changes
// the current user, which is all 0035 reads and grants by, while SET ROLE itself is checked against the session's
// login, so the refusals below are checked on the login's own session.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import type { Sql, Tx } from "../repo/scope";
import { seedCore } from "../seeds/core";

const SLOW = { timeout: 240_000 };
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATE_SCRIPT = fileURLToPath(new URL("../../infra/scripts/migrate.mjs", import.meta.url));
const SEED_RUNNER = fileURLToPath(new URL("../seeds/run.mjs", import.meta.url));
const SHOPS_DIR = fileURLToPath(new URL("../../fixtures/v1/test-kit/shops/", import.meta.url));
const THIS_FILE = "0035_core_migrator_set_role.sql";
const ALL_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/.test(file))
  .sort();
const BEFORE = ALL_FILES.filter((file) => file < THIS_FILE);
const AFTER = ALL_FILES.filter((file) => file > THIS_FILE);
const BYTES = readFileSync(path.join(MIGRATIONS_DIR, THIS_FILE));
const TEXT = BYTES.toString("utf8");
const ROLES = ["rosie_app", "rosie_job"] as const;
const CORE_TABLES = ["businesses", "persons", "person_roles", "handles", "person_handles", "phones"] as const;
const SHOPS = readdirSync(SHOPS_DIR).filter((file) => file.endsWith(".json")).length;

const RUN = `t1333_${randomBytes(3).toString("hex")}`;
/** The login: staging's migrations' role (LOGIN CREATEROLE, no superuser). */
const MAKER = `${RUN}_maker`;
/** A role the login makes itself. */
const MADE = `${RUN}_made`;
/** A second maker, for two runs of 0035 at once. */
const TWIN = `${RUN}_twin`;
/** The login's schema, which it makes and migrates itself. */
const SCHEMA = `t_${RUN}`;
/** rosie's schema of probe tables. */
const PROBE = `t_${RUN}_probe`;
const MIGRATE_LOCK_KEY = "rosie-test-db-migrate";
// The variables the two scripts read: each run sets only the ones it names.
const SCRIPT_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  "MIGRATIONS_DIR",
]);

const ADMIN_URL = resolvePrimaryUrl();
const MAKER_PASSWORD = randomBytes(16).toString("hex");
const MAKER_URL = ((): string => {
  const url = new URL(ADMIN_URL);
  url.username = MAKER;
  url.password = MAKER_PASSWORD;
  return url.href;
})();

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Failure {
  readonly code: string;
  readonly message: string;
}

/** A membership row of pg_auth_members, by member. */
interface Membership {
  readonly role: string;
  readonly grantor: string;
  readonly admin: boolean;
  readonly inherit: boolean;
  readonly set: boolean;
}

interface Rights {
  readonly role: string;
  readonly member: boolean;
  readonly usage: boolean;
  readonly set: boolean;
}

let admin: Sql;
let maker: Sql;
let bootstrap: string;
let staged: string;

/** The error `work` throws, as its SQLSTATE and message; undefined when it runs. */
async function failureOf(work: () => Promise<unknown>): Promise<Failure | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs a Node script of the repository with this environment's variables, less the scripts' own, plus `env`. */
function runScript(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRIPT_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: REPO_ROOT, env: childEnv, timeout: 230_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the script ended with no exit code"));
        }
      },
    );
  });
}

/**
 * Holds the test helper's migrate lock (db/repo/test-db.ts) while `work` runs, taken by polling as that helper takes it,
 * so this file's migrate never runs beside another file's in the same database (T-1278).
 */
async function withMigrateLock<T>(work: () => Promise<T>): Promise<T> {
  const holder = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    const giveUpAt = Date.now() + 120_000;
    for (;;) {
      const [lock] = await holder<{ taken: boolean }[]>`
        select pg_try_advisory_lock(hashtext(${MIGRATE_LOCK_KEY})) as taken
      `;
      if (lock?.taken === true) {
        break;
      }
      if (Date.now() >= giveUpAt) {
        throw new Error("another file still holds the test helper's migrate lock after 120 s");
      }
      await sleep(100);
    }
    try {
      return await work();
    } finally {
      await holder`select pg_advisory_unlock(hashtext(${MIGRATE_LOCK_KEY}))`;
    }
  } finally {
    await holder.end({ timeout: 5 });
  }
}

/** Adds `files` to the login's folder of migrations and runs migrate.mjs as the login on its schema. */
async function migrateAsMaker(files: readonly string[]): Promise<Run> {
  for (const file of files) {
    copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(staged, file));
  }
  return withMigrateLock(() =>
    runScript(MIGRATE_SCRIPT, [], { DATABASE_URL: MAKER_URL, DB_SCHEMA: SCHEMA, MIGRATIONS_DIR: staged }),
  );
}

/** The files a migrate run applied, from its output. */
const appliedIn = (run: Run): string[] =>
  lines(run.stdout).flatMap((line) => {
    const match = /^migrate: applied (\S+) \(\d+ ms\)$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });

/** Fails when the output holds the login's name or password. */
function expectNoLoginIn(run: Run): void {
  const out = `${run.stdout}${run.stderr}`;
  expect(out.includes(MAKER_PASSWORD), "the login's password").toBe(false);
  expect(out.includes(MAKER), "the login's name").toBe(false);
}

/** `member`'s rows of pg_auth_members on `roles`, by member, the maker's row first. */
async function membershipsOf(sql: Sql | Tx, member: string, roles: readonly string[]): Promise<Membership[]> {
  const rows = await sql<Membership[]>`
    select r.rolname as role, g.rolname as grantor, m.admin_option as admin, m.inherit_option as inherit,
           m.set_option as set
    from pg_auth_members m
    join pg_roles r on r.oid = m.roleid
    join pg_roles s on s.oid = m.member
    join pg_roles g on g.oid = m.grantor
    where s.rolname = ${member} and r.rolname in ${sql([...roles])}
    order by r.rolname, m.admin_option desc, g.rolname
  `;
  return rows.map((row) => ({ ...row }));
}

/** What pg_has_role answers for `member` on each of rosie_app and rosie_job. */
async function rightsOf(sql: Sql | Tx, member: string): Promise<Rights[]> {
  const rows = await sql<Rights[]>`
    select r.role,
           pg_has_role(${member}::name, r.role::name, 'MEMBER') as member,
           pg_has_role(${member}::name, r.role::name, 'USAGE') as usage,
           pg_has_role(${member}::name, r.role::name, 'SET') as set
    from unnest(${sql.array([...ROLES])}::text[]) as r(role)
    order by r.role
  `;
  return rows.map((row) => ({ ...row }));
}

/** The maker's row PostgreSQL 16 and later add for a role made by `member`, on each role named. */
const makersRow = (roles: readonly string[]): Membership[] =>
  roles.map((role) => ({ role, grantor: bootstrap, admin: true, inherit: false, set: false }));

/** Runs `work` in a transaction of rosie's on one connection, then rolls it back. */
async function rolledBack<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
  const reserved = await admin.reserve();
  try {
    await reserved`begin`;
    try {
      return await work(reserved);
    } finally {
      await reserved`rollback`;
    }
  } finally {
    reserved.release();
  }
}

beforeAll(async () => {
  // The clients and the folder first, before any statement, so afterAll can always end and remove them.
  admin = postgres(ADMIN_URL, { max: 3, onnotice: () => undefined, connect_timeout: 15 });
  maker = postgres(MAKER_URL, {
    max: 1,
    onnotice: () => undefined,
    connect_timeout: 15,
    connection: { application_name: "rosie-t1333", search_path: `${SCHEMA}, public` },
  });
  staged = mkdtempSync(path.join(tmpdir(), "rosie-t1333-migrations-"));
  const [server] = await admin<{ version: number; superuser: boolean; bootstrap: string }[]>`
    select current_setting('server_version_num')::int as version,
           (select rolsuper from pg_roles where rolname = current_user) as superuser,
           (select rolname from pg_roles where oid = 10) as bootstrap
  `;
  // The local and CI containers' first user: the bootstrap superuser, which records the maker's row.
  expect(server?.superuser, "the tests' login must be a superuser").toBe(true);
  expect(
    server?.version,
    "the maker's row and a grant's SET option are new in PostgreSQL 16",
  ).toBeGreaterThanOrEqual(160000);
  bootstrap = server?.bootstrap ?? "";
  // 0001's extensions, made by the superuser as any migrate run of the helper's makes them: the login may not make one.
  await withMigrateLock(async () => {
    await admin.unsafe(`
      create extension if not exists postgis with schema public;
      create extension if not exists btree_gist with schema public;
      create extension if not exists pgcrypto with schema public;
    `);
  });
  // The login, as staging's migrations' role: no superuser, CREATEROLE, and the right to make its own schema.
  await admin.unsafe(
    `create role ${quote(MAKER)} login nosuperuser createrole nocreatedb noreplication nobypassrls ` +
      `password '${MAKER_PASSWORD}'`,
  );
  const [database] = await admin<{ name: string }[]>`select current_database() as name`;
  await admin.unsafe(`grant create on database ${quote(database?.name ?? "")} to ${quote(MAKER)}`);
  // The row PostgreSQL 16 and later add when a CREATEROLE role that is no superuser makes a role ("just as if the
  // bootstrap superuser had executed the command GRANT created_user TO creating_user WITH ADMIN TRUE, SET FALSE,
  // INHERIT FALSE": PostgreSQL 17, Role Attributes). rosie is a superuser, so the grant is recorded as the bootstrap
  // superuser's.
  await admin.unsafe(
    `grant rosie_app, rosie_job to ${quote(MAKER)} with admin true, inherit false, set false`,
  );
}, 180_000);

afterAll(async () => {
  try {
    await maker.end({ timeout: 5 });
    await admin.unsafe(`drop schema if exists ${quote(SCHEMA)} cascade`);
    await admin.unsafe(`drop schema if exists ${quote(PROBE)} cascade`);
    const roles = await admin<{ name: string }[]>`
      select rolname as name from pg_roles where starts_with(rolname, ${RUN}) order by rolname
    `;
    for (const { name } of roles) {
      await admin.unsafe(`drop owned by ${quote(name)}`);
      await admin.unsafe(`drop role ${quote(name)}`);
    }
    const [left] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_roles where starts_with(rolname, ${RUN})
    `;
    expect(left?.n, `roles of this run are left on the server (${RUN}_*)`).toBe(0);
  } finally {
    rmSync(staged, { recursive: true, force: true });
    await admin.end({ timeout: 5 });
  }
}, 120_000);

describe("PostgreSQL's rule, on this server", () => {
  it("a role the login makes is granted back to it WITH ADMIN TRUE, INHERIT FALSE, SET FALSE by the bootstrap superuser, so SET ROLE to it is refused (42501); the login holds that same row on rosie_app and rosie_job", async () => {
    const [setting] = await maker<
      { value: string }[]
    >`select current_setting('createrole_self_grant') as value`;
    expect(setting?.value, "createrole_self_grant (its default is empty)").toBe("");
    await maker.unsafe(`create role ${quote(MADE)} nologin`);
    expect(await membershipsOf(admin, MAKER, [MADE])).toEqual(makersRow([MADE]));
    expect(await failureOf(() => maker.unsafe(`set role ${quote(MADE)}`))).toEqual({
      code: "42501",
      message: `permission denied to set role "${MADE}"`,
    });
    expect(await membershipsOf(admin, MAKER, ROLES)).toEqual(makersRow(ROLES));
  });
});

describe("0035 as a migrations' role that is no superuser (staging's case, DL-634)", () => {
  let membershipsBefore: string[];

  it(
    "before 0035: the login migrates every file before it into its own schema, may still not SET ROLE rosie_app or rosie_job (42501), and the core seed fails as seed:staging did, writing nothing",
    SLOW,
    async () => {
      expect(existsSync(path.join(MIGRATIONS_DIR, THIS_FILE))).toBe(true);
      expect(BEFORE.length).toBeGreaterThan(0);
      const run = await migrateAsMaker(BEFORE);
      expect(run.code, run.stderr).toBe(0);
      expect(appliedIn(run)).toEqual(BEFORE);
      expectNoLoginIn(run);
      const [schema] = await admin<{ owner: string }[]>`
        select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${SCHEMA}
      `;
      expect(schema?.owner).toBe(MAKER);

      expect(await rightsOf(admin, MAKER)).toEqual(
        ROLES.map((role) => ({ role, member: true, usage: false, set: false })),
      );
      for (const role of ROLES) {
        expect(await failureOf(() => maker.begin((tx) => tx.unsafe(`set local role ${role}`))), role).toEqual(
          {
            code: "42501",
            message: `permission denied to set role "${role}"`,
          },
        );
      }
      // The seed's own code, on the login's connection, as seed:staging ran it: "seed: failed (42501): permission
      // denied to set role "rosie_job"".
      expect(await failureOf(() => seedCore(maker))).toEqual({
        code: "42501",
        message: 'permission denied to set role "rosie_job"',
      });
      const [businesses] = await admin<{ n: number }[]>`
        select count(*)::int as n from ${admin(SCHEMA)}.businesses
      `;
      expect(businesses?.n).toBe(0);
      const before = await admin<{ role: string }[]>`
        select distinct r.rolname as role from pg_auth_members m join pg_roles r on r.oid = m.roleid
        join pg_roles s on s.oid = m.member where s.rolname = ${MAKER} order by 1
      `;
      membershipsBefore = before.map((row) => row.role);
      expect(membershipsBefore).toEqual([...ROLES, MADE].sort());
    },
  );

  it(
    "0035, applied by the login: it grants the login SET without INHERIT on each role, on a row of its own beside the maker's row, and nothing to any other role",
    SLOW,
    async () => {
      const run = await migrateAsMaker([THIS_FILE]);
      expect(run.code, run.stderr).toBe(0);
      expect(appliedIn(run)).toEqual([THIS_FILE]);
      expectNoLoginIn(run);
      const [recorded] = await admin<{ name: string; sha256: string }[]>`
        select name, sha256 from ${admin(SCHEMA)}.schema_migrations where version = ${THIS_FILE.slice(0, 4)}
      `;
      expect(recorded).toEqual({
        name: THIS_FILE.slice(5, -".sql".length),
        sha256: createHash("sha256").update(BYTES).digest("hex"),
      });

      expect(await membershipsOf(admin, MAKER, ROLES)).toEqual(
        ROLES.flatMap((role) => [
          { role, grantor: bootstrap, admin: true, inherit: false, set: false },
          { role, grantor: MAKER, admin: false, inherit: false, set: true },
        ]),
      );
      expect(await rightsOf(admin, MAKER)).toEqual(
        ROLES.map((role) => ({ role, member: true, usage: false, set: true })),
      );
      // Every row the login granted, on this whole server: its own two, and no other role's.
      const granted = await admin<{ role: string; member: string }[]>`
        select r.rolname as role, s.rolname as member from pg_auth_members m join pg_roles r on r.oid = m.roleid
        join pg_roles s on s.oid = m.member join pg_roles g on g.oid = m.grantor
        where g.rolname = ${MAKER} order by 1, 2
      `;
      expect(granted.map((row) => ({ ...row }))).toEqual(ROLES.map((role) => ({ role, member: MAKER })));
      // The roles it is a member of are the ones it was before: no membership it did not have.
      const after = await admin<{ role: string }[]>`
        select distinct r.rolname as role from pg_auth_members m join pg_roles r on r.oid = m.roleid
        join pg_roles s on s.oid = m.member where s.rolname = ${MAKER} order by 1
      `;
      expect(after.map((row) => row.role)).toEqual(membershipsBefore);

      // Any file after 0035, so the schema holds every migration of db/migrations/, as the seed runner asks.
      if (AFTER.length > 0) {
        const rest = await migrateAsMaker(AFTER);
        expect(rest.code, rest.stderr).toBe(0);
        expect(appliedIn(rest)).toEqual(AFTER);
      }
      const versions = await admin<{ version: string }[]>`
        select version from ${admin(SCHEMA)}.schema_migrations order by version
      `;
      expect(versions.map((row) => row.version)).toEqual(ALL_FILES.map((file) => file.slice(0, 4)));
    },
  );

  it(
    "after 0035: the login may SET ROLE to each, and the seed runner's set core runs as the login and writes as rosie_job",
    SLOW,
    async () => {
      for (const role of ROLES) {
        const who = await maker.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          const [row] = await tx<{ current: string; session: string }[]>`
            select current_user as current, session_user as session
          `;
          return row === undefined ? undefined : { ...row };
        });
        expect(who, role).toEqual({ current: role, session: MAKER });
      }

      const run = await runScript(SEED_RUNNER, ["--set", "core"], {
        DATABASE_URL: MAKER_URL,
        DB_SCHEMA: SCHEMA,
      });
      expect(run.code, run.stderr).toBe(0);
      const total = SHOPS * CORE_TABLES.length;
      expect(lines(run.stdout)).toEqual([
        `seed: set core into schema ${SCHEMA} on the local database`,
        ...CORE_TABLES.map(
          (table) => `seed: ${table}: ${String(SHOPS)} rows (${String(SHOPS)} inserted, 0 kept)`,
        ),
        `seed: done: set core into schema ${SCHEMA}: ${String(total)} rows in ${String(CORE_TABLES.length)} tables ` +
          `(${String(total)} inserted, 0 kept)`,
      ]);
      expectNoLoginIn(run);

      // The seed's own result says whose rows they are: written as rosie_job, all kept on this second run.
      const again = await seedCore(maker);
      expect(again.ranAs).toBe("rosie_job");
      expect(again.tables).toEqual(
        Object.fromEntries(CORE_TABLES.map((table) => [table, { rows: SHOPS, inserted: 0, kept: SHOPS }])),
      );
    },
  );

  it("a role that is a member of rosie_job only through this grant inherits none of its privileges or policies: the login is refused a table only rosie_job may read and sees no row behind rosie_job's policy, and reads both once it is rosie_job", async () => {
    await admin.unsafe(`
      create schema ${quote(PROBE)};
      create table ${quote(PROBE)}.only_job (id int);
      insert into ${quote(PROBE)}.only_job values (1);
      create table ${quote(PROBE)}.behind_policy (id int);
      insert into ${quote(PROBE)}.behind_policy values (1);
      alter table ${quote(PROBE)}.behind_policy enable row level security;
      create policy behind_policy_job on ${quote(PROBE)}.behind_policy for select to rosie_job using (true);
      grant usage on schema ${quote(PROBE)} to rosie_job, ${quote(MAKER)};
      grant select on ${quote(PROBE)}.only_job to rosie_job;
      grant select on ${quote(PROBE)}.behind_policy to rosie_job, ${quote(MAKER)};
    `);
    const [privilege] = await maker<{ may: boolean }[]>`
      select has_table_privilege(current_user, ${`${PROBE}.only_job`}, 'SELECT') as may
    `;
    expect(privilege?.may).toBe(false);
    expect(await failureOf(() => maker.unsafe(`select count(*) from ${quote(PROBE)}.only_job`))).toEqual({
      code: "42501",
      message: "permission denied for table only_job",
    });
    const [behind] = await maker.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${quote(PROBE)}.behind_policy`,
    );
    expect(behind?.n).toBe(0);

    const asJob = await maker.begin(async (tx) => {
      await tx.unsafe("set local role rosie_job");
      const [onlyJob] = await tx.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${quote(PROBE)}.only_job`,
      );
      const [policy] = await tx.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${quote(PROBE)}.behind_policy`,
      );
      return { onlyJob: onlyJob?.n, behindPolicy: policy?.n };
    });
    expect(asJob).toEqual({ onlyJob: 1, behindPolicy: 1 });
  });
});

describe("where 0035 changes nothing", () => {
  it("as the superuser, as on the local and CI servers: no membership of the superuser in either role, before it or after it", async () => {
    const [self] = await admin<{ name: string }[]>`select current_user as name`;
    const superuser = self?.name ?? "";
    expect(await membershipsOf(admin, superuser, ROLES)).toEqual([]);
    const inside = await rolledBack(async (sql) => {
      await sql.unsafe(TEXT);
      return { rows: await membershipsOf(sql, superuser, ROLES), rights: await rightsOf(sql, superuser) };
    });
    expect(inside).toEqual({
      rows: [],
      rights: ROLES.map((role) => ({ role, member: true, usage: true, set: true })),
    });
  });

  it("a role that is no superuser and holds no maker's row gains nothing, even one that holds ADMIN OPTION through another role: 0035 never makes a membership", async () => {
    const plain = `${RUN}_plain`;
    const via = `${RUN}_via`;
    const through = `${RUN}_through`;
    const found = await rolledBack(async (sql) => {
      await sql.unsafe(`
        create role ${quote(plain)} nologin nosuperuser createrole;
        create role ${quote(via)} nologin nosuperuser;
        create role ${quote(through)} nologin nosuperuser createrole;
        grant rosie_app, rosie_job to ${quote(via)} with admin true, inherit false, set false;
        grant ${quote(via)} to ${quote(through)} with inherit true, set false;
      `);
      const rows: Record<string, Membership[]> = {};
      for (const member of [plain, through]) {
        await sql.unsafe(`set local role ${quote(member)}`);
        await sql.unsafe(TEXT);
        await sql.unsafe("reset role");
        rows[member] = await membershipsOf(sql, member, ROLES);
      }
      const [admits] = await sql<{ admin: boolean }[]>`
        select pg_has_role(${through}::name, 'rosie_job'::name, 'MEMBER WITH ADMIN OPTION') as admin
      `;
      // The grant 0035 holds back would have worked for that role, through the other role's ADMIN OPTION.
      await sql.unsafe(`set local role ${quote(through)}`);
      await sql.unsafe("grant rosie_job to current_user with set true, inherit false");
      await sql.unsafe("reset role");
      return {
        rows,
        admits: admits?.admin,
        withoutTheCheck: await membershipsOf(sql, through, ["rosie_job"]),
      };
    });
    expect(found).toEqual({
      rows: { [plain]: [], [through]: [] },
      admits: true,
      withoutTheCheck: [{ role: "rosie_job", grantor: via, admin: false, inherit: false, set: true }],
    });
  });
});

describe("two runs at once", () => {
  it("as two schemas migrating together: the second waits for the first's grant, then finds it made and adds nothing", async () => {
    await admin.unsafe(`
      create role ${quote(TWIN)} nologin nosuperuser createrole;
      grant rosie_app, rosie_job to ${quote(TWIN)} with admin true, inherit false, set false;
    `);
    const first = await admin.reserve();
    const second = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
    let open = false;
    try {
      const [backend] = await second<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await first`begin`;
      open = true;
      await first.unsafe(`set local role ${quote(TWIN)}`);
      await first.unsafe(TEXT);
      await second.unsafe(`set role ${quote(TWIN)}`);
      const secondRun = failureOf(() => second.unsafe(TEXT));
      let waiting = false;
      for (let tries = 0; tries < 200 && !waiting; tries += 1) {
        const [row] = await admin<{ wait: string | null }[]>`
          select wait_event_type as wait from pg_stat_activity where pid = ${backend?.pid ?? 0}
        `;
        waiting = row?.wait === "Lock";
        if (!waiting) {
          await sleep(25);
        }
      }
      expect(waiting, "the second run never waited on the first's grant").toBe(true);
      await first`commit`;
      open = false;
      expect(await secondRun).toBeUndefined();
      expect(await membershipsOf(admin, TWIN, ROLES)).toEqual(
        ROLES.flatMap((role) => [
          { role, grantor: bootstrap, admin: true, inherit: false, set: false },
          { role, grantor: TWIN, admin: false, inherit: false, set: true },
        ]),
      );
    } finally {
      if (open) {
        await first`rollback`;
      }
      first.release();
      await second.end({ timeout: 5 });
    }
  });
});
