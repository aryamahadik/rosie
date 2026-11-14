#!/usr/bin/env node
// Migration runner (factory spec 3 and 5). ES module, so strict mode is on.
//
//   node infra/scripts/migrate.mjs            apply the pending files of db/migrations/, in order
//   node infra/scripts/migrate.mjs --status   list applied and pending files; change nothing
//
// DATABASE_URL  the database. When DATABASE_URL and CI are both unset: the local Docker database
//               (infra/docker-compose.yml). The URL is never printed. For a pooled host (Neon) use its direct URL.
//               It is checked before the client is built (db-url.mjs, as publish-bundle.sh and flags.sh do): one that
//               does not parse is refused with its fault named (exit 1), and an error printed holds no part of it
//               (its user, password, host, port or database name).
// DB_SCHEMA     optional schema, for example preview_<slug>: created when missing and searched first, then public.
//
// Each file runs in its own transaction, together with its row in <schema>.schema_migrations (version, name,
// sha256, applied_at); 0001_init.sql creates that table. Files hold no BEGIN or COMMIT of their own.
// Two kinds of file run outside a transaction, one statement at a time, because PostgreSQL refuses these inside one
// (the migration guard asks for CONCURRENTLY on existing tables): (1) a file of only CREATE INDEX CONCURRENTLY
// statements, found by itself; (2) a file whose first line is `-- migrate:no-transaction` and that holds exactly one
// statement of any kind (DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, DETACH PARTITION ... CONCURRENTLY), or
// several that are all CREATE INDEX CONCURRENTLY. The file is recorded after its last statement. A file that mixes
// CREATE INDEX CONCURRENTLY with other statements, or a marker file with several other statements, is refused
// before anything runs. A failed concurrent build leaves an invalid index: the next run drops it first, then builds again.
// Write the statements with IF NOT EXISTS, so a rerun after a partial failure skips the ones already built.
// The runner refuses to apply anything while an applied file has changed or is missing.
// Locks (T-1093, from T-191's architect note c): a file waits at most LOCK_TIMEOUT for any lock (lock_timeout), and in a
// transaction each of its statements runs at most STATEMENT_TIMEOUT (statement_timeout), both set for that file alone.
// A statement that needs a table's ACCESS EXCLUSIVE lock (ALTER TABLE ... ENABLE ROW LEVEL SECURITY, CREATE POLICY)
// behind a long transaction would otherwise wait, and every query on that table would queue behind its request; now
// the file fails after LOCK_TIMEOUT, rolled back and not recorded, and the queue goes on. A file run outside a
// transaction (concurrent index work) takes the lock_timeout alone: its statements hold no lock that keeps queries
// out, and a large table's build may rightly run long. Run it again once the long transaction has ended.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";

import { DatabaseUrlFault, checkDatabaseUrl, printStrayErrors, scrub } from "./db-url.mjs";

const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? pathToFileURL(`${process.env.MIGRATIONS_DIR.replace(/\/+$/, "")}/`)
  : new URL("../../db/migrations/", import.meta.url);
const FILE_NAME = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const NO_TRANSACTION = /^--\s*migrate:no-transaction\s*$/;
const CONCURRENT_INDEX =
  /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?((?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*))?)/i;
const LOCK_WAIT_SECONDS = 120;
// Each file's lock_timeout and, in a transaction, statement_timeout (the top of this file).
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "60s";
const USAGE = "Usage: node infra/scripts/migrate.mjs [--status]";

class UsageError extends Error {}
/** A run refused before anything is read or written (exit 1). */
class Refusal extends Error {}

// The parts of the database URL taken out of every error printed (db-url.mjs; DL-363): the whole string until the URL
// is checked, then each part. An error that no catch takes (a stray rejection) is printed the same way.
let secrets = [process.env.DATABASE_URL ?? ""];
printStrayErrors("migrate", () => secrets);

function databaseTarget() {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, label: "DATABASE_URL" };
  }
  if (process.env.CI) {
    throw new UsageError("DATABASE_URL is not set (the local default is never used when CI is set)");
  }
  return { url: LOCAL_DATABASE_URL, label: "local database 127.0.0.1:54329/rosie" };
}

// The URL, checked before any client is built: one that does not parse is refused with its fault named and no part of
// it, and from then on its parts are taken out of every error printed.
function checkTarget(target) {
  try {
    secrets = checkDatabaseUrl(target.url);
  } catch (error) {
    if (!(error instanceof DatabaseUrlFault)) {
      throw error;
    }
    throw new Refusal(`${target.label} does not parse: ${error.message}; nothing was read or written`);
  }
}

function schemaName() {
  const schema = (process.env.DB_SCHEMA ?? "").trim() || "public";
  if (!SCHEMA_NAME.test(schema)) {
    throw new UsageError(`DB_SCHEMA "${schema}" is not a plain lower-case SQL name ([a-z_][a-z0-9_]*)`);
  }
  return schema;
}

// Splits SQL text into statements: skips comments, keeps quoted text (strings, identifiers, dollar quotes) whole.
function splitStatements(text) {
  const statements = [];
  let current = "";
  let i = 0;
  const flush = () => {
    if (current.trim() !== "") {
      statements.push(current.trim());
    }
    current = "";
  };
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if (rest.startsWith("--")) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      current += " ";
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
    } else if ((m = /^\$([A-Za-z_]*)\$/.exec(rest))) {
      const end = text.indexOf(m[0], i + m[0].length);
      const stop = end === -1 ? text.length : end + m[0].length;
      current += text.slice(i, stop);
      i = stop;
    } else if (text[i] === ";") {
      flush();
      i += 1;
    } else {
      current += text[i];
      i += 1;
    }
  }
  flush();
  return statements;
}

// Returns the statements of a file that must run outside a transaction, or null for an ordinary file.
// Throws UsageError for a file that mixes concurrent index builds with other statements.
function concurrentIndexStatements(file, marker) {
  const statements = splitStatements(file);
  const concurrent = statements.filter((statement) => CONCURRENT_INDEX.test(statement));
  if (concurrent.length === statements.length && statements.length > 0) {
    return statements;
  }
  if (marker && statements.length === 1) {
    return statements;
  }
  if (concurrent.length > 0 || marker) {
    return undefined;
  }
  return null;
}

function readMigrationFiles() {
  const versions = new Map();
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = FILE_NAME.exec(file);
      if (!match) {
        throw new UsageError(`${file}: migration files are named NNNN_<slug>.sql (lower case)`);
      }
      const [, version, name] = match;
      if (versions.has(version)) {
        throw new UsageError(`${versions.get(version)} and ${file} share version ${version}`);
      }
      versions.set(version, file);
      const bytes = readFileSync(new URL(file, MIGRATIONS_DIR));
      const text = bytes.toString("utf8");
      const firstLine = text.split("\n", 1)[0] ?? "";
      const marker = NO_TRANSACTION.test(firstLine.trim());
      const statements = concurrentIndexStatements(text, marker);
      if (statements === undefined) {
        throw new UsageError(
          `${file}: a statement that cannot run in a transaction needs its own file: either only CREATE INDEX ` +
            `CONCURRENTLY statements, or one statement under a first line "-- migrate:no-transaction". ` +
            `Put the other statements in another file. Nothing was run.`,
        );
      }
      return {
        file,
        version,
        name,
        text,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        noTransaction: statements !== null,
        statements: statements ?? [],
      };
    });
}

async function readApplied(sql, schema) {
  const [row] = await sql`select to_regclass(${`${schema}.schema_migrations`}) is not null as present`;
  if (!row.present) {
    return [];
  }
  return sql`
    select version, name, sha256, applied_at
    from ${sql(schema)}.schema_migrations
    order by version
  `;
}

function compare(files, applied) {
  const fileByVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set(applied.map((row) => row.version));
  const problems = [];
  for (const row of applied) {
    const file = fileByVersion.get(row.version);
    if (!file) {
      problems.push(`${row.version}_${row.name}.sql was applied, but the file is gone`);
    } else if (file.name !== row.name || file.sha256 !== row.sha256) {
      problems.push(
        `${file.file} differs from the applied ${row.version}_${row.name}.sql ` +
          `(sha256 ${row.sha256.slice(0, 12)} applied, ${file.sha256.slice(0, 12)} now)`,
      );
    }
  }
  return { pending: files.filter((file) => !appliedVersions.has(file.version)), problems };
}

function printStatus(label, schema, applied, pending, problems) {
  console.log(`migrate: ${label}, schema ${schema}: ${applied.length} applied, ${pending.length} pending`);
  for (const row of applied) {
    const at = row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at);
    console.log(`  applied  ${row.version}_${row.name}.sql  ${at}  sha256 ${row.sha256.slice(0, 12)}`);
  }
  for (const file of pending) {
    console.log(`  pending  ${file.file}${file.noTransaction ? "  (no transaction)" : ""}`);
  }
  for (const problem of problems) {
    console.log(`  CHANGED  ${problem}`);
  }
}

// One migrate run per schema at a time; a second run waits, then gives up.
async function takeLock(sql, schema) {
  const key = `rosie-migrate:${schema}`;
  for (let second = 0; second <= LOCK_WAIT_SECONDS; second += 1) {
    const [row] = await sql`select pg_try_advisory_lock(hashtext(${key})) as locked`;
    if (row.locked) {
      return async () => {
        await sql`select pg_advisory_unlock(hashtext(${key}))`;
      };
    }
    if (second === 0) {
      console.log(
        `migrate: another migrate run holds schema ${schema}; waiting up to ${LOCK_WAIT_SECONDS} s`,
      );
    }
    await sleep(1000);
  }
  throw new Error(`another migrate run still holds schema ${schema} after ${LOCK_WAIT_SECONDS} s`);
}

// A concurrent build that failed leaves an invalid index of that name; IF NOT EXISTS would then skip it for good.
// Only the target schema is searched (an unqualified name never reaches public's index of the same name).
async function dropInvalidIndex(sql, schema, statement) {
  const match = CONCURRENT_INDEX.exec(statement);
  if (!match) {
    return;
  }
  const parts = [...match[1].matchAll(/"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*)/gi)].map((part) =>
    part[1] === undefined ? part[2].toLowerCase() : part[1].replaceAll('""', '"'),
  );
  const indexSchema = parts.length > 1 ? parts[0] : schema;
  const indexName = parts.at(-1);
  const [row] = await sql`
    select i.indisvalid as valid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${indexSchema} and c.relname = ${indexName}
  `;
  if (row && !row.valid) {
    console.log(`migrate: dropping invalid index ${indexSchema}.${indexName} left by a failed run`);
    await sql.unsafe(`drop index concurrently if exists ${quoteIdent(indexSchema)}.${quoteIdent(indexName)}`);
  }
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function applyFile(sql, schema, file) {
  const searchPath = schema === "public" ? "public" : `"${schema}", public`;
  const record = (db) => db`
    insert into ${db(schema)}.schema_migrations (version, name, sha256)
    values (${file.version}, ${file.name}, ${file.sha256})
  `;
  if (file.noTransaction) {
    await sql.unsafe(`set search_path to ${searchPath}`);
    await sql.unsafe(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    for (const statement of file.statements) {
      await dropInvalidIndex(sql, schema, statement);
      await sql.unsafe(statement);
    }
    await record(sql);
    // The session's own value again: the lock_timeout above was this file's alone (a failure ends the run).
    await sql.unsafe("reset lock_timeout");
    return;
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await tx.unsafe(`set local search_path to ${searchPath}`);
    await tx.unsafe(file.text);
    await record(tx);
  });
}

// An error as printed: its message, code, detail, hint, where and position, with every part of the database URL taken
// out; never another field (postgres.js keeps a URL it cannot read, password included, in `input`).
function describeError(error) {
  if (!(error instanceof Error)) {
    return scrub(String(error), secrets, error);
  }
  const details = [error.message];
  for (const key of ["code", "detail", "hint", "where", "position"]) {
    if (error[key] !== undefined && error[key] !== "") {
      details.push(`${key}: ${error[key]}`);
    }
  }
  return scrub(details.join("\n  "), secrets, error);
}

async function main(args) {
  const unknown = args.filter((arg) => arg !== "--status");
  if (unknown.length > 0) {
    throw new UsageError(`unknown argument ${unknown.join(" ")}\n${USAGE}`);
  }
  const statusOnly = args.includes("--status");
  const target = databaseTarget();
  checkTarget(target);
  const schema = schemaName();
  const files = readMigrationFiles();

  // Notices ("extension already exists, skipping") are not printed.
  const sql = postgres(target.url, { max: 1, connect_timeout: 15, onnotice: () => undefined });
  try {
    if (statusOnly) {
      const applied = await readApplied(sql, schema);
      const { pending, problems } = compare(files, applied);
      printStatus(target.label, schema, applied, pending, problems);
      return problems.length === 0 ? 0 : 1;
    }

    const unlock = await takeLock(sql, schema);
    try {
      const applied = await readApplied(sql, schema);
      const { pending, problems } = compare(files, applied);
      if (problems.length > 0) {
        printStatus(target.label, schema, applied, pending, problems);
        console.error("migrate: refusing to run: an applied migration changed (migrations are never edited)");
        return 1;
      }
      if (pending.length === 0) {
        console.log(`migrate: ${target.label}, schema ${schema}: up to date (${applied.length} applied)`);
        return 0;
      }
      console.log(`migrate: ${target.label}, schema ${schema}: applying ${pending.length} file(s)`);
      if (schema !== "public") {
        await sql`create schema if not exists ${sql(schema)}`;
      }
      const newest = applied.at(-1)?.version;
      for (const file of pending) {
        if (newest !== undefined && file.version < newest) {
          console.log(`migrate: note: ${file.file} is older than the newest applied file (${newest})`);
        }
        const started = performance.now();
        try {
          await applyFile(sql, schema, file);
        } catch (error) {
          console.error(`migrate: ${file.file} failed and was not recorded:\n  ${describeError(error)}`);
          if (error?.code === "55P03" || error?.code === "57014") {
            console.error(
              `migrate: it waited for a lock longer than lock_timeout ${LOCK_TIMEOUT}, or ran a statement longer than ` +
                `statement_timeout ${STATEMENT_TIMEOUT}, so it stopped rather than hold other queries back; run it ` +
                `again once the long transaction has ended`,
            );
          }
          return 1;
        }
        console.log(`migrate: applied ${file.file} (${Math.round(performance.now() - started)} ms)`);
      }
      console.log(`migrate: done, schema ${schema}: ${applied.length + pending.length} applied`);
      return 0;
    } finally {
      await unlock();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`migrate: refused: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`migrate: ${error instanceof UsageError ? error.message : describeError(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
