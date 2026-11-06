#!/usr/bin/env bash
# Removes a branch preview's database schema (factory spec 6; build prompt 5.3, "removed after merge"):
# npm run preview:cleanup -- <branch>  (the lead runs it on the build Mac after a merge or drop; DL-024)
# Drops preview_<slug> on the staging database, computed exactly as deploy-preview.sh does, and refuses any
# schema whose name does not start with preview_. Skipped with a notice when STAGING_DATABASE_URL is not set.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

[[ $# -eq 1 && -n "$1" ]] || die "usage: preview-cleanup.sh <branch>"
schema="$(preview_schema "$(branch_slug "$1")")"
if [[ ! "$schema" =~ ^preview_[a-z0-9_]+$ ]]; then
  die "refusing to remove \"$schema\": only preview_ schemas are removed"
fi

load_dev_var STAGING_DATABASE_URL
if [[ -z "${STAGING_DATABASE_URL:-}" ]]; then
  log "cleanup: NOTICE: STAGING_DATABASE_URL is not set, so schema $schema was left in place"
  exit 0
fi

log "cleanup: remove schema $schema"
DATABASE_URL="$STAGING_DATABASE_URL" PREVIEW_SCHEMA="$schema" node --input-type=module -e '
  import postgres from "postgres";
  const schema = process.env.PREVIEW_SCHEMA ?? "";
  if (!/^preview_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`refusing to remove "${schema}": only preview_ schemas are removed`);
  }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => undefined });
  try {
    await sql`drop schema if exists ${sql(schema)} cascade`;
  } finally {
    await sql.end({ timeout: 5 });
  }
'
log "cleanup: schema $schema removed"
