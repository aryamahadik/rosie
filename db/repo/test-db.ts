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
// `database: "own"` makes the schema in a database of the file's own, made from template_postgis (else template1) and
// dropped with the file, so no other run's lock or row is in it, and a read of pg_stat_activity (which spans the
// server) kept to current_database() sees none of another run's sessions. Such a file opens the connections it makes
// itself with `connect`: the URL of DATABASE_URL names the shared database.
//
// Uses the database of DATABASE_URL, else the local Docker database when CI is unset (the integration project sets
// it). Only schemas and databases this helper made (names starting `t_`) are ever dropped. Connection strings are never
// printed.
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
// The template a database of a file's own is made from: the PostGIS image's (infra/docker-compose.yml, and the CI
// service), which already holds postgis, as the local merge check makes its run database; else PostgreSQL's own.
const POSTGIS_TEMPLATE = "template_postgis";
const PLAIN_TEMPLATE = "template1";

/** What a client a test opens itself takes (postgres.js), with no custom types, so it answers as `Sql`. */
export type ConnectOptions = postgres.Options<Record<string, postgres.PostgresType>>;

export interface TestDatabase {
  /** The schema made for this file: `t_<name>_<8 hex>`. With `database: "own"`, its database has the same name. */
  readonly schema: string;
  readonly client: DbClient;
  /** The client's primary handle, searching the test schema first. */
  readonly sql: Sql;
  /**
   * A client of the test's own on the database the schema is in, as postgres.js takes its options (the test sets its
   * search path, role and application name); the test ends it. The connection string stays inside this helper.
   */
  connect(options?: ConnectOptions): Sql;
  /**
   * Ends the client and drops the schema (with `database: "own"`, its database) with everything in it. Safe to call
   * twice.
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
   * `own`: in a database made for this file alone on the same server and dropped with it, so nothing PostgreSQL keeps
   * per database (an advisory lock above all, as the outbox claim's) is shared with another run (T-1251).
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
  const own = new URL(url);
  own.pathname = `/${name}`;
  return own.href;
}

/**
 * Makes the database `name` on the server `url` names, from template_postgis when the server has it, else template1;
 * answers its URL. PostgreSQL refuses a template a session is connected to; nothing connects to these, and files
 * making theirs at once share the template without waiting on each other.
 */
async function createDatabase(url: string, name: string): Promise<string> {
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const [found] = await admin<{ postgis: boolean }[]>`
      select exists (select 1 from pg_database where datname = ${POSTGIS_TEMPLATE} and datistemplate) as postgis
    `;
    const template = found?.postgis === true ? POSTGIS_TEMPLATE : PLAIN_TEMPLATE;
    await admin`create database ${admin(name)} template ${admin(template)}`;
  } finally {
    await admin.end({ timeout: 5 });
  }
  return urlOfDatabase(url, name);
}

/** Drops the database `name` this helper made, from the database `url` names, ending any session still in it. */
async function dropDatabase(url: string, name: string): Promise<void> {
  if (!name.startsWith(TEST_SCHEMA_PREFIX)) {
    throw new Error(`test database: refusing to drop database ${name}: not made by the test helper`);
  }
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await admin`drop database if exists ${admin(name)} with (force)`;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Makes a fresh schema, applies every migration of db/migrations/ into it, and opens a client on it; with
 * `database: "own"`, first makes the database it is in.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const sharedUrl = resolvePrimaryUrl();
  const schema = schemaNameFor(options.name ?? "test");
  const own = options.database === "own";
  const url = own ? await createDatabase(sharedUrl, schema) : sharedUrl;
  const remove = async (): Promise<void> => {
    await (own ? dropDatabase(sharedUrl, schema) : dropSchema(url, schema));
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
