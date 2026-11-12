// Test-database helper (factory spec 4 and 5): one fresh schema per test file, migrated with infra/scripts/migrate.mjs,
// dropped when the file ends. Parallel test files never share a schema, so they never share rows.
//
//   let db: TestDatabase;
//   beforeAll(async () => { db = await createTestDatabase({ name: "reservations" }); });
//   afterAll(async () => { await db.drop(); });
//
// A schema keeps a file's rows apart, but not what PostgreSQL keeps per database, an advisory lock above all. The
// outbox claim takes each recipient's lock with pg_try_advisory_xact_lock and skips a recipient whose lock another
// session holds (db/repo/outbox.ts default 10), so a claim test that shares its database with another run on the same
// server skips a fixture's recipient whenever that run claims the same one at the same moment (T-1251, CQ-221).
// `database: "own"` makes the schema in a database no other file uses while this one runs: one of a pool on the server
// (t_own_1, t_own_2, ...), each held by one file at a time through a session-level advisory lock taken in the server's
// maintenance database, made from template_postgis (else template1) the first time it is needed, and kept. So no other
// run's lock or row is in it, and a read of pg_stat_activity (which spans the server) kept to current_database() sees
// none of another run's sessions. The file drops only its schema at its end, as in the shared database: never the
// database, because DROP DATABASE waits for a checkpoint, which took more than a minute on the loaded build Mac. Such a
// file opens the connections it makes itself with `connect`: the URL of DATABASE_URL names the shared database.
//
// Uses the database of DATABASE_URL, else the local Docker database when CI is unset (the integration project sets
// it). Only schemas this helper made (names starting `t_`) are ever dropped, and no database. Connection strings are
// never printed.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { createClient, type ClientOptions, type DbClient, redact, resolvePrimaryUrl } from "./client";
import type { Sql } from "./scope";

const run = promisify(execFile);
const MIGRATE_SCRIPT = fileURLToPath(new URL("../../infra/scripts/migrate.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_SCHEMA_PREFIX = "t_";
// Held while migrating, so two test files starting together never race on `create extension` in a fresh database.
const MIGRATE_LOCK_KEY = "rosie-test-db-migrate";
// The pool's databases: `t_own_<n>`, n from 1, at most POOL_SIZE on a server (the runs at once on the build Mac hold
// a few), each held under the advisory lock `rosie-test-db-own:<its name>` in the maintenance database.
const POOL_PREFIX = `${TEST_SCHEMA_PREFIX}own_`;
const POOL_SIZE = 50;
const POOL_LOCK_PREFIX = "rosie-test-db-own:";
// Where the pool's locks are taken and its databases made: the server's maintenance database, which initdb makes on
// every server (the image's and the CI service's included), so no statement of the pool's holds a snapshot in the
// shared database, where another run's CREATE INDEX CONCURRENTLY waits out every older snapshot.
const MAINTENANCE_DATABASE = "postgres";
// The template a pool database is made from: the PostGIS image's (infra/docker-compose.yml, and the CI service), which
// already holds postgis, as the local merge check makes its run database; else PostgreSQL's own.
const POSTGIS_TEMPLATE = "template_postgis";
const PLAIN_TEMPLATE = "template1";

/** What a client a test opens itself takes (postgres.js), with no custom types, so it answers as `Sql`. */
export type ConnectOptions = postgres.Options<Record<string, postgres.PostgresType>>;

export interface TestDatabase {
  /** The schema made for this file: `t_<name>_<8 hex>`. */
  readonly schema: string;
  /**
   * With `database: "own"`, the pool database this file holds, which the schema is in; else null: the schema is in the
   * database DATABASE_URL names.
   */
  readonly database: string | null;
  readonly client: DbClient;
  /** The client's primary handle, searching the test schema first. */
  readonly sql: Sql;
  /**
   * A client of the test's own on the database the schema is in, as postgres.js takes its options (the test sets its
   * search path, role and application name); the test ends it. The connection string stays inside this helper.
   */
  connect(options?: ConnectOptions): Sql;
  /**
   * Ends the client and drops the schema with everything in it; with `database: "own"`, then lets the pool database
   * go. Safe to call twice.
   */
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Part of the schema name, for the reader of a failure: lower-case letters, digits and `_`. Default `test`. */
  name?: string;
  /** Passed on to the client (replica URL, pool size, log); the URL and schema are the helper's. */
  client?: Pick<ClientOptions, "replicaUrl" | "max" | "log">;
  /**
   * Where the schema is made. `shared` (the default): in the database DATABASE_URL names, beside other runs' schemas.
   * `own`: in a pool database on the same server that no other file uses until this one drops its schema, so nothing
   * PostgreSQL keeps per database (an advisory lock above all, as the outbox claim's) is shared with another run
   * (T-1251).
   */
  database?: "shared" | "own";
}

function schemaNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 30);
  return `${TEST_SCHEMA_PREFIX}${slug === "" ? "test" : slug}_${randomBytes(4).toString("hex")}`;
}

async function migrate(url: string, schema: string): Promise<void> {
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await admin`select pg_advisory_lock(hashtext(${MIGRATE_LOCK_KEY}))`;
    try {
      await run(process.execPath, [MIGRATE_SCRIPT], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: url, DB_SCHEMA: schema },
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const output = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n");
      throw new Error(`test database: migrating schema ${schema} failed:\n${redact(output, [url])}`, {
        cause: error,
      });
    } finally {
      await admin`select pg_advisory_unlock(hashtext(${MIGRATE_LOCK_KEY}))`;
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropSchema(url: string, schema: string): Promise<void> {
  if (!schema.startsWith(TEST_SCHEMA_PREFIX)) {
    throw new Error(`test database: refusing to drop schema ${schema}: not made by the test helper`);
  }
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await admin`drop schema if exists ${admin(schema)} cascade`;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** The URL of the database `name` on the server `url` names: its path changed, nothing else. */
function urlOfDatabase(url: string, name: string): string {
  const other = new URL(url);
  other.pathname = `/${name}`;
  return other.href;
}

/** A pool database this file holds until `release`, and its URL. */
interface Held {
  readonly name: string;
  readonly url: string;
  release(): Promise<void>;
}

/**
 * Makes the pool database `name` from the template when the server has none of that name. Run under its lock, so no
 * other file makes or uses it meanwhile. PostgreSQL refuses a template a session is connected to; nothing connects to
 * these, and files making theirs at once share the template without waiting on each other.
 */
async function makePoolDatabase(holder: Sql, name: string): Promise<void> {
  const [found] = await holder<{ present: boolean; postgis: boolean }[]>`
    select exists (select 1 from pg_database where datname = ${name}) as present,
           exists (select 1 from pg_database where datname = ${POSTGIS_TEMPLATE} and datistemplate) as postgis
  `;
  if (found?.present !== true) {
    const template = found?.postgis === true ? POSTGIS_TEMPLATE : PLAIN_TEMPLATE;
    await holder`create database ${holder(name)} template ${holder(template)}`;
  }
}

/** The schemas this helper made in a pool database that are still there: a file that held it ended before its afterAll. */
async function dropLeftSchemas(url: string): Promise<void> {
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  let left: string[];
  try {
    const rows = await admin<{ name: string }[]>`
      select nspname as name from pg_namespace where starts_with(nspname, ${TEST_SCHEMA_PREFIX})
    `;
    left = rows.map((row) => row.name);
  } finally {
    await admin.end({ timeout: 5 });
  }
  for (const schema of left) {
    await dropSchema(url, schema);
  }
}

/**
 * Holds the first pool database no other file holds: its session-level advisory lock, taken on one connection to the
 * maintenance database that stays open until `release` (the session's end lets the lock go, so a file whose process
 * dies lets its database go too). The database is made on first use, and schemas a file before left in it are dropped.
 */
async function holdPoolDatabase(sharedUrl: string): Promise<Held> {
  // One connection for the file's whole run: no lifetime limit, so postgres.js never swaps it and loses the lock.
  const holder = postgres(urlOfDatabase(sharedUrl, MAINTENANCE_DATABASE), {
    max: 1,
    max_lifetime: null,
    onnotice: () => undefined,
  });
  const release = async (): Promise<void> => {
    await holder.end({ timeout: 5 });
  };
  try {
    for (let slot = 1; slot <= POOL_SIZE; slot += 1) {
      const name = `${POOL_PREFIX}${String(slot)}`;
      const [lock] = await holder<{ taken: boolean }[]>`
        select pg_try_advisory_lock(hashtext(${`${POOL_LOCK_PREFIX}${name}`})) as taken
      `;
      if (lock?.taken === true) {
        await makePoolDatabase(holder, name);
        const url = urlOfDatabase(sharedUrl, name);
        await dropLeftSchemas(url);
        return { name, url, release };
      }
    }
    throw new Error(`test database: all ${String(POOL_SIZE)} pool databases are held by other files`);
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Makes a fresh schema, applies every migration of db/migrations/ into it, and opens a client on it; with
 * `database: "own"`, in a pool database it holds until `drop`.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const sharedUrl = resolvePrimaryUrl();
  const schema = schemaNameFor(options.name ?? "test");
  const held = options.database === "own" ? await holdPoolDatabase(sharedUrl) : null;
  const url = held?.url ?? sharedUrl;
  const remove = async (): Promise<void> => {
    try {
      await dropSchema(url, schema);
    } finally {
      await held?.release();
    }
  };
  try {
    await migrate(url, schema);
  } catch (error) {
    await remove();
    throw error;
  }
  const client = createClient({ ...options.client, primaryUrl: url, schema });
  let dropped = false;
  return {
    schema,
    database: held?.name ?? null,
    client,
    sql: client.primary,
    connect: (connectOptions = {}) => postgres(url, connectOptions),
    drop: async () => {
      if (dropped) {
        return;
      }
      dropped = true;
      await client.close();
      await remove();
    },
  };
}
