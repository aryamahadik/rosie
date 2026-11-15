#!/usr/bin/env bash
# What one trace wrote on staging's database, read only, by labels and states alone (T-1407; D-017's walking skeleton;
# DL-809: the first live JOIN got no reply, and the lead had no sanctioned way to see where it stopped without reading a
# key, DL-604):
#   npm run staging:trace -- <trace id> [--since <time>]
# <trace id> is a UUID, the form the runtime gives every trace (runtime/src/trace/context.ts isValidTraceId; ADR-009), as
# npm run check:staging prints it and Workers Logs shows it, in either case. <time> is a UTC time, such as
# 2026-11-15T11:28:00Z. For the trace, and with --since for every row written at or after that time, it prints the turns,
# event-log entries, outbox rows and parts, and messages, each by its id, labels, states and times alone
# (infra/scripts/staging-trace.mjs names each column it prints and those it never reads), then
# "staging-trace: done: read only, nothing was written". Nothing is written: the reader's one transaction is READ ONLY
# (PostgreSQL refuses any write in it, 25006), as rosie_job with the business scope empty, and each setting it makes ends
# with it.
#
# The database is staging's alone: STAGING_DATABASE_URL, from the environment, else from .dev.vars by name (lib.sh's
# load_dev_var), never printed, as seed-staging.sh reads it (T-1310, T-1343). The URL and the caller's DATABASE_URL (only
# compared with it) leave this shell's environment before anything is started (dirname included), with a caller's
# DATABASE_REPLICA_URL; the URL is kept in a variable of the script's own that is never exported, and handed by name, as
# STAGING_DATABASE_URL, to the one command that reads the database, node running staging-trace.mjs, on that command's
# line alone; then it is dropped. No other command gets it. The schema is public, the one staging's Worker reads
# (DB_SCHEMA is empty in wrangler.jsonc's env.staging), unless DB_SCHEMA names another schema of the same database (a
# preview's preview_<slug>, C-010); the report's first line names it.
# Refused before any connection, with nothing read (exit 1):
#   - STAGING_DATABASE_URL is not set: the line names the variable alone;
#   - DATABASE_URL is set to another database: this script reads the staging database alone, as seed-staging.sh seeds it
#     alone (a DATABASE_URL equal to STAGING_DATABASE_URL is taken, and dropped);
#   - DB_SCHEMA is not a plain lower-case SQL name;
#   - --env, whatever it names: staging only, as seed-staging.sh.
# Misuse, exit 2, found before anything is read: no trace id, or one that is not a UUID; a --since that is not a UTC
# time; an argument it does not take. No argument is ever echoed.
# Exit: 0 the report printed; 1 refused, or the reader refused or failed, its exit passed on (a URL that does not parse,
# a schema that is not there, a database that does not answer: a failure prints only its code and its message, with
# every part of the URL taken out, infra/scripts/db-url.mjs); 2 misuse.
set +x
set +a
set +k
set -euo pipefail
# As in seed-staging.sh: no variable of this script starts out marked for export, or with the caller's text in it. bash
# marks every variable it inherits for export, and under allexport every variable as it is set, so one named as the URL's
# would hand the URL to every command started from here; a function's local takes the mark of the variable of the same
# name outside it; under keyword an assignment anywhere on a command line goes to that command's environment; and xtrace
# would print each command. So the three are switched off above, and every name this script, and lib.sh's load_dev_var
# that reads .dev.vars for it, keeps a variable of its own under is dropped here, before anything is read, sourced or
# started (lib.sh's ROOT and CF with them; BASH_REMATCH, where load_dev_var's match leaves what it read, too).
unset -v trace since schema named reader status db_url caller_url name file line value ROOT CF BASH_REMATCH
unset -v USAGE TRACE_ID UTC_TIME SCHEMA_NAME
# The staging database's URL and the caller's DATABASE_URL go into variables of the script's own, never exported, and
# their names leave the environment at once, before any command is started (sourcing lib.sh runs dirname): db_url is
# handed on by name to the reader alone, and caller_url is only compared with it (below), then dropped.
db_url="${STAGING_DATABASE_URL:-}"
caller_url="${DATABASE_URL:-}"
unset -v STAGING_DATABASE_URL DATABASE_URL DATABASE_REPLICA_URL
schema="${DB_SCHEMA:-}"
unset -v DB_SCHEMA
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

USAGE="usage: staging-trace.sh <trace id> [--since <time>] (the trace id a UUID; the time in UTC, such as 2026-11-15T11:28:00Z)"
# A trace id: a UUID, in either case (the reader takes it in lower case, as the runtime keeps it).
TRACE_ID='^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$'
# A UTC time, to the millisecond (the reader also checks that its day exists).
UTC_TIME='^[[:digit:]]{4}-[[:digit:]]{2}-[[:digit:]]{2}T[[:digit:]]{2}:[[:digit:]]{2}:[[:digit:]]{2}(\.[[:digit:]]{1,3})?Z$'
# A plain lower-case SQL name, its letters one by one (a range such as a-z takes in other letters in some locales).
SCHEMA_NAME='^[abcdefghijklmnopqrstuvwxyz_][abcdefghijklmnopqrstuvwxyz0123456789_]{0,62}$'

# misuse <why>: a command line this script does not take (exit 2). No argument is echoed.
misuse() {
  printf '%s: %s\n%s\n' "$(basename "$0")" "$*" "$USAGE" >&2
  exit 2
}

trace=""
since=""
named=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      [[ $# -ge 2 && -n "$2" ]] || misuse "--since needs a time"
      [[ -z "$since" ]] || misuse "--since is given twice"
      since="$2"
      shift 2
      ;;
    --since=*)
      [[ -n "${1#*=}" ]] || misuse "--since needs a time"
      [[ -z "$since" ]] || misuse "--since is given twice"
      since="${1#*=}"
      shift
      ;;
    --env | --env=*)
      die "refused: staging-trace.sh reads the staging database alone and takes no --env (production is never read" \
        "here); nothing was read"
      ;;
    -*)
      misuse "an option it does not take (arguments are never echoed)"
      ;;
    *)
      [[ "$named" == 0 ]] || misuse "one trace id at a time (arguments are never echoed)"
      trace="$1"
      named=1
      shift
      ;;
  esac
done
[[ "$named" == 1 ]] || misuse "name the trace id"
[[ "$trace" =~ $TRACE_ID ]] ||
  misuse "the trace id is not a UUID, the form the runtime gives every trace (it is not shown)"
if [[ -n "$since" && ! "$since" =~ $UTC_TIME ]]; then
  misuse "--since is not a UTC time such as 2026-11-15T11:28:00Z (it is not shown)"
fi

# The staging database's URL from .dev.vars by name, when the environment gave none: load_dev_var exports what it reads,
# so the value goes into the script's own variable and the name is dropped again at once, before any command is started.
# What its match left in BASH_REMATCH (the line's value) is overwritten by a match of nothing (bash never exports it).
if [[ -z "$db_url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  db_url="${STAGING_DATABASE_URL:-}"
  unset -v STAGING_DATABASE_URL
  [[ "" =~ ^$ ]]
fi
[[ -n "$db_url" ]] ||
  die "refused: STAGING_DATABASE_URL is not set (the staging database's URL, read by name from the environment, else" \
    "from .dev.vars): nothing was read"
if [[ -n "$caller_url" && "$caller_url" != "$db_url" ]]; then
  caller_url=""
  db_url=""
  die "refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's: this script reads the" \
    "staging database alone (unset DATABASE_URL to read it); nothing was read"
fi
caller_url=""
if [[ -z "$schema" ]]; then
  schema="public"
fi
if [[ ! "$schema" =~ $SCHEMA_NAME ]]; then
  db_url=""
  die "refused: DB_SCHEMA is not a plain lower-case SQL name (a-z, 0-9 and _, at most 63 characters; unset, the" \
    "reader reads public, the schema staging's Worker reads): nothing was read"
fi

reader=(--trace "$trace" --schema "$schema")
if [[ -n "$since" ]]; then
  reader+=(--since "$since")
fi
status=0
# The staging database's URL, by name, to the reader's run alone.
STAGING_DATABASE_URL="$db_url" node "$ROOT/infra/scripts/staging-trace.mjs" "${reader[@]}" || status=$?
db_url=""
exit "$status"
