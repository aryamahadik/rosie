#!/usr/bin/env bash
# Release flags (build prompt 5.4, deploy step 4; ADR-010; D-017 'Flag: skeleton (staging only)'; T-569). Flags live
# in the release_flags table of each environment's database (db/repo/flags.ts, T-185). The Worker reads them where it
# gates a route: its Linq webhook route answers 404 while the skeleton flag is off (runtime/src/wiring/skeleton.ts).
#
#   bash infra/scripts/flags.sh [--env staging|local] apply [--record <file>]
#       sets every flag of the staging flag set, infra/flags/staging.json, at the global scope: deploy-staging.sh's
#       step 4. That set turns the skeleton flag on; production's set, infra/flags/production.json, has it off.
#       --record appends the name of each flag it turned on (deploy-staging.sh's undo turns those off again).
#   bash infra/scripts/flags.sh [--env staging|local] off <flag>
#       turns one flag off in every scope. The walking skeleton's rollback is this one command:
#           bash infra/scripts/flags.sh off skeleton
#       and the Linq webhook route answers 404 from the next webhook on.
#   bash infra/scripts/flags.sh [--env staging|local] list
#       every flag row (a phone's number is never shown).
# The work is infra/flags/flags.mjs's (no `on` command: a flag goes on only through a flag set). This script picks
# the database:
#   --env staging (the default)  the staging database: STAGING_DATABASE_URL, from the environment, else .dev.vars;
#                                its public schema. While it is not set (J-06) the script refuses; meanwhile the staging
#                                Worker binds no flags, so every flag reads off there.
#   --env local                  the local database: DATABASE_URL (only a host on this machine), else the local Docker
#                                database of infra/docker-compose.yml; DB_SCHEMA as set. Local runs the staging set.
#   --env production             refused, as is any other name: production's flags are set only by the protected
#                                release job, after Jay or the CTO acts from his own login (build prompt 5.4).
# Nothing here prints a connection string.
# The database's URL (T-1343; read as deploy-preview.sh reads it, T-1310): STAGING_DATABASE_URL and DATABASE_URL leave
# this shell's environment before anything is started (dirname included), each kept in a variable of the script's own
# that is never marked for export (.dev.vars' line is read the same way). flags.mjs alone gets the URL --env picks, as
# DATABASE_URL on its command line: no other command gets any database URL. Tracing, allexport and keyword are switched
# off first, whatever the caller's shell asked for: a trace would print the URL, allexport would mark the variables for
# export, and under keyword lib.sh's `local name=...` would declare nothing (as make-staging-secrets.sh explains, T-1236).
set +x
set +a
set +k
set -euo pipefail
# The variables that hold a URL are dropped before they are set: bash marks every variable it inherits for export, so one
# of the same name in the caller's environment would make it an exported one.
unset -v staging_url local_url db_url LOCAL_DATABASE_URL
staging_url="${STAGING_DATABASE_URL:-}"
local_url="${DATABASE_URL:-}"
unset -v STAGING_DATABASE_URL DATABASE_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The local Docker database (factory spec 4): local only, not a secret.
LOCAL_DATABASE_URL="postgres://rosie:rosie@127.0.0.1:54329/rosie"
# A connection string whose host is this machine (--env local writes no other).
LOCAL_HOST_URL='^postgres(ql)?://([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$)'

env_name="staging"
env_count=0
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || die "--env needs a name: staging (the default) or local"
      env_name="$2"
      env_count=$((env_count + 1))
      shift 2
      ;;
    --env=*)
      env_name="${1#*=}"
      env_count=$((env_count + 1))
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done
if [[ "$env_name" == "production" ]]; then
  die "refused: --env production is never run from here: production's flags (infra/flags/production.json, the" \
    "skeleton flag off) are set only by the protected release job, after Jay or the CTO acts from his own login" \
    "(build prompt 5.4)"
fi
((env_count <= 1)) || die "refused: --env is given more than once"

case "$env_name" in
  staging)
    # From .dev.vars by name when the environment gave none: load_dev_var exports what it reads, so the name is unset
    # again at once, before any command is started.
    if [[ -z "$staging_url" ]]; then
      load_dev_var STAGING_DATABASE_URL
      staging_url="${STAGING_DATABASE_URL:-}"
      unset -v STAGING_DATABASE_URL
    fi
    [[ -n "$staging_url" ]] ||
      die "refused: STAGING_DATABASE_URL is not set: staging has no database yet (J-06), so its Worker binds no" \
        "flags and every flag reads off there; for the local database, use --env local"
    db_url="$staging_url"
    db_schema=""
    where="the staging database"
    ;;
  local)
    db_url="${local_url:-$LOCAL_DATABASE_URL}"
    [[ "$db_url" =~ $LOCAL_HOST_URL ]] ||
      die "refused: --env local writes only a database on this machine (127.0.0.1, localhost or ::1), and" \
        "DATABASE_URL names another host"
    db_schema="${DB_SCHEMA:-}"
    where="the local database${db_schema:+, schema $db_schema}"
    ;;
  *)
    die "refused: --env ${env_name:-(empty)}: only --env staging (the default) or --env local"
    ;;
esac

log "flags: on $where (--env $env_name)"
# flags.mjs alone gets the URL (above), on its command line.
DATABASE_URL="$db_url" DB_SCHEMA="$db_schema" exec node --disable-warning=ExperimentalWarning \
  "$ROOT/infra/flags/flags.mjs" ${args[@]+"${args[@]}"}
