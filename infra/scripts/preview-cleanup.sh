#!/usr/bin/env bash
# Removes a branch preview's database schema (factory spec 6; build prompt 5.3, "removed after merge"):
# npm run preview:cleanup -- <branch>  (the lead runs it on the build Mac after a merge or drop; DL-024)
# Drops preview_<slug> on the staging database, computed exactly as deploy-preview.sh does, and refuses any
# schema whose name does not start with preview_. Skipped with a notice when STAGING_DATABASE_URL is not set.
# The staging database's URL (T-1343; read as deploy-preview.sh reads it, T-1310): STAGING_DATABASE_URL, from the
# environment, else from this checkout's .dev.vars by name (lib.sh's load_dev_var), never printed. It leaves this
# shell's environment before anything is started (dirname included), and DATABASE_URL, which this script never reads,
# leaves with it. It is kept in one variable that is never marked for export, handed to the node that drops the schema
# alone (as DATABASE_URL, on that command's line), and then dropped: no other command gets any database URL. Tracing,
# allexport and keyword are switched off first, whatever the caller's shell asked for: a trace would print the URL,
# allexport would mark the variable for export, and under keyword lib.sh's `local name=...` would declare nothing (as
# make-staging-secrets.sh explains, T-1236).
set +x
set +a
set +k
set -euo pipefail
# The variable is dropped before it is set: bash marks every variable it inherits for export, so one of that name in the
# caller's environment would make it an exported one.
unset -v database_url
database_url="${STAGING_DATABASE_URL:-}"
unset -v STAGING_DATABASE_URL DATABASE_URL DATABASE_REPLICA_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

[[ $# -eq 1 && -n "$1" ]] || die "usage: preview-cleanup.sh <branch>"
schema="$(preview_schema "$(branch_slug "$1")")"
if [[ ! "$schema" =~ ^preview_[a-z0-9_]+$ ]]; then
  die "refusing to remove \"$schema\": only preview_ schemas are removed"
fi

# From .dev.vars by name when the environment gave none: load_dev_var exports what it reads, so the name is unset again
# at once, before any command is started.
if [[ -z "$database_url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  database_url="${STAGING_DATABASE_URL:-}"
  unset -v STAGING_DATABASE_URL
fi
if [[ -z "$database_url" ]]; then
  log "cleanup: NOTICE: STAGING_DATABASE_URL is not set, so schema $schema was left in place"
  exit 0
fi

log "cleanup: remove schema $schema"
# The drop (T-1349; the security review of T-1343, new task a): the URL is checked by infra/scripts/db-url.mjs before
# the client is built, as flags.mjs and migrate.mjs check theirs (DL-356, DL-363), and a failure is printed as one line
# with no part of it: a URL that does not parse is refused with its fault named, and any other error (a connection
# refused, a login refused) as its code and its message with every part of the URL taken out, never its other fields.
# postgres.js would otherwise throw a URL error whose input property holds the whole URL, password included, or an
# error that names the host, port or user, and Node prints each field of an error no catch takes. It exits 1, as before.
DATABASE_URL="$database_url" PREVIEW_SCHEMA="$schema" node --input-type=module -e '
  import postgres from "postgres";
  import {
    DatabaseUrlFault,
    checkDatabaseUrl,
    describeError,
    printStrayErrors,
  } from "./infra/scripts/db-url.mjs";
  // The parts of the URL taken out of every line printed: the whole string until it is checked, then each part.
  let secrets = [process.env.DATABASE_URL ?? ""];
  printStrayErrors("cleanup", () => secrets);
  const schema = process.env.PREVIEW_SCHEMA ?? "";
  if (!/^preview_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`refusing to remove "${schema}": only preview_ schemas are removed`);
  }
  let sql;
  try {
    secrets = checkDatabaseUrl(process.env.DATABASE_URL ?? "");
    sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => undefined });
    await sql`drop schema if exists ${sql(schema)} cascade`;
  } catch (error) {
    process.exitCode = 1;
    console.error(
      error instanceof DatabaseUrlFault
        ? `cleanup: refused: STAGING_DATABASE_URL does not parse: ${error.message}; schema ${schema} was left in place`
        : `cleanup: FAILED to remove schema ${schema}${describeError(error, secrets)}`,
    );
  } finally {
    await sql?.end({ timeout: 5 }).catch((error) => {
      process.exitCode = 1;
      console.error(`cleanup: closing the database client failed${describeError(error, secrets)}`);
    });
  }
'
database_url=""
log "cleanup: schema $schema removed"
