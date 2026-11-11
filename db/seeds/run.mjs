#!/usr/bin/env node
// T-201: the seed runner (C-155; factory spec 6; build prompt 5.3). ES module, so strict mode is on.
//
//   node db/seeds/run.mjs --set <name>
//
// Seeds one set into the schema DB_SCHEMA names (a branch preview's preview_<slug>; unset, the public schema: the local
// default) on the database DATABASE_URL names (with DATABASE_URL and CI both unset, the local Docker database of
// infra/docker-compose.yml, as migrate.mjs does), then prints how many rows of each table the set holds, wrote and
// kept. deploy-preview.sh calls it after migrate (C-010, the release engineer's).
//
// A set is the file db/seeds/<name>.ts, found by its name alone, so a new set joins without a change here. It exports
// `seed(sql)`, which writes its rows idempotently (a second run writes nothing) and returns
// { tables: { <table>: { rows, inserted, kept } } }. A name that is not a plain lower-case name, or names no such file,
// is refused with the list of sets.
//
// Before anything is written, in order, stopping at the first refusal (1 and 2 before the set's file is loaded or the
// database is reached):
//   1. The database URL is checked (infra/scripts/db-url.mjs, as migrate.mjs does): one that does not parse is refused
//      with its fault named. No line printed holds any part of it (its user, password, host, port or database name):
//      a failure is printed as its code and its message, with every part taken out.
//   2. Only a local database or the staging database is seeded, never production or any other: the sets are fixture
//      data (rule 9), and skeleton writes a fictional business with status live (DL-341). The signals are the ones the
//      deploy scripts use: a host on this machine (127.0.0.1, localhost or ::1, as LOCAL_HOST_URL in flags.sh and
//      publish-bundle.sh) is local, and the database STAGING_DATABASE_URL names (deploy-preview.sh, deploy-staging.sh,
//      flags.sh, publish-bundle.sh) is staging, previews included. So the caller passes both, the same URL, for staging.
//   3. The schema must come first on the search path and hold every migration of db/migrations/, so every table a set
//      writes is that schema's own and no row reaches public or another schema.
// Then the set runs as it was written: each set writes in one transaction as the job role, rosie_job (T-191), which the
// connecting role must be able to SET ROLE to.
//
// Exit: 0 seeded; 1 refused (nothing written) or failed (a set rolls its transaction back); 2 misuse, found before
// anything else (an argument or a set name it does not take, a DB_SCHEMA that is not a plain name, CI set with no
// DATABASE_URL).
import { readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

import {
  DatabaseUrlFault,
  checkDatabaseUrl,
  describeError,
  printStrayErrors,
} from "../../infra/scripts/db-url.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");
// The local Docker database (factory spec 4): local only, not a secret.
const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
// Hosts on this machine, as Node's URL writes them (flags.sh and publish-bundle.sh: LOCAL_HOST_URL).
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
// A set's name: its file's name without .ts. Test files (core.int.test.ts) and helpers in lib/ are never sets.
const SET_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/;
const USAGE = "usage: node db/seeds/run.mjs --set <name>";

/** A command line this runner does not take (exit 2). */
class Misuse extends Error {}
/** A run refused before anything was read or written (exit 1). */
class Refusal extends Error {}

// db/ and compiler/ import their neighbours without an extension, as the bundler resolves them; Node completes a
// relative import from a .ts file with .ts or /index.ts here, as infra/flags/flags.mjs does for the same files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});

// The parts of the database URL taken out of every line printed: the whole string until the URL is checked, then each
// part. An error that no catch takes (a stray rejection) is printed the same way, never its fields.
let secrets = [process.env.DATABASE_URL ?? ""];
printStrayErrors("seed", () => secrets);

/** The set's name from `--set <name>` or `--set=<name>`, given once. No argument is echoed. */
function parseArgs(argv) {
  let name;
  for (let i = 0; i < argv.length; i += 1) {
    let value;
    if (argv[i] === "--set") {
      value = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith("--set=")) {
      value = argv[i].slice("--set=".length);
    } else {
      throw new Misuse("unknown argument");
    }
    if (value === undefined || value === "") throw new Misuse("--set needs a set name");
    if (name !== undefined) throw new Misuse("one set at a time: --set is given more than once");
    name = value;
  }
  if (name === undefined) throw new Misuse("name the set with --set");
  return name;
}

/** The sets: each regular file db/seeds/<name>.ts whose name is a set name, in code-point order. */
function setNames() {
  return readdirSync(HERE, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.slice(0, -".ts".length))
    .filter((name) => SET_NAME.test(name))
    .sort();
}

/** The set's file, db/seeds/<name>.ts; an unknown name is refused with the list of sets. */
function setFile(name) {
  const known = setNames();
  const list = `the sets: ${known.join(", ")}`;
  if (!SET_NAME.test(name)) {
    throw new Misuse(`the set name is not a plain lower-case name (a-z, 0-9 and -); ${list}`);
  }
  if (!known.includes(name)) throw new Misuse(`no set ${name}: there is no db/seeds/${name}.ts; ${list}`);
  return path.join(HERE, `${name}.ts`);
}

/** DATABASE_URL; with it and CI both unset, the local Docker database (migrate.mjs's rule). */
function databaseUrl(env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.CI) throw new Misuse("DATABASE_URL is not set (the local default is never used when CI is set)");
  return LOCAL_DATABASE_URL;
}

/** The URL, checked before any client is built; from then on its parts are taken out of every line printed. */
function checkUrl(url) {
  try {
    secrets = checkDatabaseUrl(url);
  } catch (error) {
    if (!(error instanceof DatabaseUrlFault)) throw error;
    throw new Refusal(`DATABASE_URL does not parse: ${error.message}; nothing was read or written`);
  }
}

/** Where the database is, by the deploy scripts' own signals (see the top of this file): staging, local or refused. */
function placeOf(url, env) {
  const staging = env.STAGING_DATABASE_URL ?? "";
  if (staging !== "" && url === staging) return "the staging database (STAGING_DATABASE_URL)";
  if (LOCAL_HOSTS.has(new URL(url).hostname)) return "the local database";
  throw new Refusal(
    "DATABASE_URL names neither a database on this machine (127.0.0.1, localhost or ::1) nor the staging database " +
      "(the one STAGING_DATABASE_URL names): the seed sets are fixture data for a local database, staging and its " +
      "previews only, never production; nothing was read or written",
  );
}

/** DB_SCHEMA, a plain lower-case SQL name; unset or empty, public. */
function schemaName(env) {
  const schema = (env.DB_SCHEMA ?? "").trim() || "public";
  if (!SCHEMA_NAME.test(schema)) {
    throw new Misuse(
      "DB_SCHEMA is not a plain lower-case SQL name ([a-z_][a-z0-9_]*, at most 63 characters)",
    );
  }
  return schema;
}

/** The migration files of db/migrations/, by version. */
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .map((file) => MIGRATION_FILE.exec(file))
    .filter((match) => match !== null)
    .map((match) => ({ version: match[1], file: match[0] }))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** Refuses, writing nothing, unless the schema comes first on the search path and holds every migration. */
async function requireMigrated(sql, schema, where) {
  const migrate = schema === "public" ? "npm run migrate" : `DB_SCHEMA=${schema} npm run migrate`;
  const [row] = await sql`
    select current_schema() as current, to_regclass(${`${schema}.schema_migrations`}) is not null as migrated
  `;
  if (row.current !== schema || !row.migrated) {
    throw new Refusal(
      `schema ${schema} on ${where} is missing or not migrated: run ${migrate} first; nothing was written`,
    );
  }
  const applied = new Set(
    (await sql`select version from ${sql(schema)}.schema_migrations`).map((r) => r.version),
  );
  const files = migrationFiles();
  const pending = files.filter((file) => !applied.has(file.version));
  if (pending.length > 0) {
    throw new Refusal(
      `schema ${schema} on ${where} lacks ${pending.length} of the ${files.length} migrations of db/migrations/ ` +
        `(${pending[0].file} first): run ${migrate} first; nothing was written`,
    );
  }
}

const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The row counts a set returned, table by table; a set that returned none is a fault of that set. */
function countsOf(name, result) {
  const tables = result?.tables;
  const entries = tables !== null && typeof tables === "object" ? Object.entries(tables) : [];
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  const valid = ([, count]) => whole(count?.rows) && whole(count?.inserted) && whole(count?.kept);
  if (entries.length === 0 || !entries.every(valid)) {
    throw new Error(
      `set ${name} ran but returned no row counts (its seed(sql) returns { tables: { <table>: { rows, inserted, kept } } })`,
    );
  }
  return entries;
}

async function main(argv, env) {
  const name = parseArgs(argv);
  const file = setFile(name);
  const schema = schemaName(env);
  const url = databaseUrl(env);
  checkUrl(url);
  const where = placeOf(url, env);

  const set = await import(pathToFileURL(file).href);
  if (typeof set.seed !== "function") {
    throw new Refusal(`db/seeds/${name}.ts exports no seed function; nothing was read or written`);
  }
  console.log(`seed: set ${name} into schema ${schema} on ${where}`);
  const searchPath = schema === "public" ? "public" : `${schema}, public`;
  // Notices ("relation already exists, skipping") are not printed.
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 15,
    onnotice: () => undefined,
    connection: { application_name: "rosie-seed", search_path: searchPath },
  });
  try {
    await requireMigrated(sql, schema, where);
    const counts = countsOf(name, await set.seed(sql));
    const total = { rows: 0, inserted: 0, kept: 0 };
    for (const [table, count] of counts) {
      const rows = counted(count.rows, "row", "rows");
      console.log(`seed: ${table}: ${rows} (${count.inserted} inserted, ${count.kept} kept)`);
      total.rows += count.rows;
      total.inserted += count.inserted;
      total.kept += count.kept;
    }
    const tables = counted(counts.length, "table", "tables");
    console.log(
      `seed: done: set ${name} into schema ${schema}: ${counted(total.rows, "row", "rows")} in ${tables} ` +
        `(${total.inserted} inserted, ${total.kept} kept)`,
    );
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  if (error instanceof Misuse) {
    console.error(`seed: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof Refusal) {
    console.error(`seed: refused: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`seed: failed${describeError(error, secrets)}`);
    process.exitCode = 1;
  }
}
