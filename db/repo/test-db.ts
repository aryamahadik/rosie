// Test-database helper (factory spec 4 and 5): one fresh schema per test file, migrated with infra/scripts/migrate.mjs,
// dropped when the file ends. Parallel test files never share a schema, so they never share rows.
//
//   let db: TestDatabase;
//   beforeAll(async () => { db = await createTestDatabase({ name: "reservations" }); });
//   afterAll(async () => { await db.drop(); });
//
// Uses the database of DATABASE_URL, else the local Docker database when CI is unset (the integration project sets
// it). Only schemas this helper made (names starting `t_`) are ever dropped. Connection strings are never printed.
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

export interface TestDatabase {
  /** The schema made for this file: `t_<name>_<8 hex>`. */
  readonly schema: string;
  readonly client: DbClient;
  /** The client's primary handle, searching the test schema first. */
  readonly sql: Sql;
  /** Ends the client and drops the schema with everything in it. Safe to call twice. */
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Part of the schema name, for the reader of a failure: lower-case letters, digits and `_`. Default `test`. */
  name?: string;
  /** Passed on to the client (replica URL, pool size, log); the URL and schema are the helper's. */
  client?: Pick<ClientOptions, "replicaUrl" | "max" | "log">;
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

/** Makes a fresh schema, applies every migration of db/migrations/ into it, and opens a client on it. */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const url = resolvePrimaryUrl();
  const schema = schemaNameFor(options.name ?? "test");
  try {
    await migrate(url, schema);
  } catch (error) {
    await dropSchema(url, schema);
    throw error;
  }
  const client = createClient({ ...options.client, primaryUrl: url, schema });
  let dropped = false;
  return {
    schema,
    client,
    sql: client.primary,
    drop: async () => {
      if (dropped) {
        return;
      }
      dropped = true;
      await client.close();
      await dropSchema(url, schema);
    },
  };
}
