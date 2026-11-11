#!/usr/bin/env bash
# Staging's seeded state, from the build Mac (T-571; build prompt 9.4 'Seeded state'; C-202, C-011; QUESTIONS NQ-DB-2;
# STATE note 67; DL-308):
#   npm run seed:staging
#       D-017's sets, in this order: core (T-200: the demo shops' core rows), staging-core (T-202: the test businesses,
#       and a customer person, handle and phone row for each test phone but test owner 1), then skeleton (T-1148: test
#       owner 1, whose JOIN is a first text).
#   npm run seed:staging -- --set <name> [--set <name>]...
#       the sets named, in the order given: a later set (T-216's, T-218's) runs by its name, db/seeds/<name>.ts.
# Each set is one run of T-201's seed runner (node db/seeds/run.mjs --set <name>), which writes it idempotently, in one
# transaction as rosie_job, and prints its row counts: a second run writes nothing. A set that fails stops the script:
# nothing of that set is written, the sets before it stay seeded (each committed on its own) and the ones after it do
# not run. Once the cause is fixed, the same command runs again.
#
# The database is staging's alone: STAGING_DATABASE_URL, from the environment, else from .dev.vars by name, never
# printed. The runner gets it as DATABASE_URL too, which is how it knows staging (T-201's handoff). The schema is
# public, the one staging's Worker reads (DB_SCHEMA is empty in wrangler.jsonc's env.staging), named explicitly, since
# the runner seeds public whenever DB_SCHEMA is unset (T-201's security review, note c). Refused before any set runs,
# with the database untouched (exit 1):
#   - STAGING_DATABASE_URL is not set: staging has no database yet (J-06);
#   - DATABASE_URL is set to another database: this script seeds staging's alone (a local database is seeded with
#     node db/seeds/run.mjs; production never is: the sets are fixture data, rule 9);
#   - DB_SCHEMA names a schema other than public: a preview's schema is deploy-preview's to seed (C-010);
#   - --env, whatever it names: staging only, as deploy-staging.sh.
# Before it runs:
#   - The staging database is migrated: it holds every migration of db/migrations/ (npm run deploy:staging, step 1).
#     The runner refuses a schema that lacks one, writing nothing.
#   - The role STAGING_DATABASE_URL logs in as can SET ROLE rosie_job (T-200's handoff; J-06). The runner needs Node
#     22.18 or later.
#   - No test phone has texted staging: run it once on the freshly migrated database, before any text from a test
#     phone. A handle made at first sight for a test number makes staging-core refuse, and once a turn from test owner
#     1 has committed, skeleton refuses (only a fresh schema makes his JOIN a first text again). Both write nothing.
# The test phones' numbers (NQ-DB-2's default): STAGING_TEST_PHONES, from the environment, else from .dev.vars by name,
# never printed; staging-core reads it at run time ("tp-02=+1...,tp-03=+1..."). Leave it unset until a Linq line serves
# staging (J-08): each test phone is then seeded at its fixed fake handle, the 555-01xx number the test-phone page sends
# as.
# Nothing here prints a database URL or any part of it, or a phone number: the runner prints the set, the schema, "the
# staging database" and row counts, and a failure only as its code and its message with every part of the URL taken
# out (infra/scripts/db-url.mjs).
# Exit: 0 every set seeded; 1 refused, or a set refused or failed (the runner's exit is passed on); 2 misuse (an
# argument or a set name it does not take), found before anything runs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# D-017's sets, in their order (STATE note 67; T-202's handoff).
D017_SETS=(core staging-core skeleton)
# A set's name, as the runner takes it (db/seeds/run.mjs SET_NAME): test files and lib/ are never sets.
SET_NAME='^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
USAGE="usage: seed-staging.sh [--set <name>]... (with no --set: D-017's sets, ${D017_SETS[*]})"

# misuse <why>: a command line this script does not take (exit 2). No argument is echoed, only a set's plain name.
misuse() {
  printf '%s: %s\n%s\n' "$(basename "$0")" "$*" "$USAGE" >&2
  exit 2
}

# The sets: each db/seeds/<name>.ts whose name is a set name, as the runner finds them.
set_list() {
  local file name list=""
  for file in "$ROOT"/db/seeds/*.ts; do
    name="${file##*/}"
    name="${name%.ts}"
    if [[ "$name" =~ $SET_NAME ]]; then
      list="${list:+$list, }$name"
    fi
  done
  printf '%s' "$list"
}

# is_set <name>: whether db/seeds/<name>.ts is a set, matched exactly (a file system that ignores case finds Core.ts as
# core.ts, and the runner refuses the name Core).
is_set() {
  local file
  for file in "$ROOT"/db/seeds/*.ts; do
    if [[ "${file##*/}" == "$1.ts" && "$1" =~ $SET_NAME ]]; then
      return 0
    fi
  done
  return 1
}

sets=()
named=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set)
      [[ $# -ge 2 && -n "$2" ]] || misuse "--set needs a set name"
      sets+=("$2")
      named=1
      shift 2
      ;;
    --set=*)
      [[ -n "${1#*=}" ]] || misuse "--set needs a set name"
      sets+=("${1#*=}")
      named=1
      shift
      ;;
    --env | --env=*)
      die "refused: seed-staging.sh seeds the staging database alone and takes no --env: production is never seeded" \
        "(the sets are fixture data, rule 9), and a local database is seeded with node db/seeds/run.mjs; nothing was" \
        "read or written"
      ;;
    *)
      misuse "an argument it does not take (arguments are never echoed)"
      ;;
  esac
done
if [[ "$named" == 0 ]]; then
  sets=("${D017_SETS[@]}")
fi
# Every name is checked before the first set runs, so a typo in the last one leaves the database untouched.
for name in "${sets[@]}"; do
  [[ "$name" =~ $SET_NAME ]] ||
    misuse "a set name is not a plain lower-case name (a-z, 0-9 and -); the sets: $(set_list)"
  is_set "$name" || misuse "no set $name: there is no db/seeds/$name.ts; the sets: $(set_list)"
done

load_dev_var STAGING_DATABASE_URL
[[ -n "${STAGING_DATABASE_URL:-}" ]] ||
  die "refused: STAGING_DATABASE_URL is not set: staging has no database yet (J-06); nothing was read or written"
if [[ -n "${DATABASE_URL:-}" && "$DATABASE_URL" != "$STAGING_DATABASE_URL" ]]; then
  die "refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's: this script seeds the" \
    "staging database alone (unset DATABASE_URL to seed it; node db/seeds/run.mjs seeds a local database); nothing" \
    "was read or written"
fi
if [[ -n "${DB_SCHEMA:-}" && "$DB_SCHEMA" != "public" ]]; then
  die "refused: DB_SCHEMA names a schema other than public: this script seeds the staging database's own schema," \
    "public, which staging's Worker reads (a preview's schema is deploy-preview's to seed, C-010); nothing was read" \
    "or written"
fi
load_dev_var STAGING_TEST_PHONES
cd "$ROOT"

log "seed-staging: sets ${sets[*]}, one run each in this order, into schema public on the staging database" \
  "(STAGING_DATABASE_URL)"
log "seed-staging: the staging database must hold every migration of db/migrations/ (npm run deploy:staging migrates" \
  "it, step 1); the seed runner refuses a schema that lacks one, writing nothing"
if [[ "${STAGING_TEST_PHONES:-}" =~ [^[:space:]] ]]; then
  log "seed-staging: STAGING_TEST_PHONES is set: the test phones it names are seeded at its numbers (never shown)"
else
  log "seed-staging: STAGING_TEST_PHONES is not set: each test phone is seeded at its fixed fake handle (555-01xx)," \
    "the number the test-phone page sends as (J-08)"
fi

for name in "${sets[@]}"; do
  log "seed-staging: set $name"
  status=0
  DATABASE_URL="$STAGING_DATABASE_URL" DB_SCHEMA="public" \
    node --disable-warning=ExperimentalWarning "$ROOT/db/seeds/run.mjs" --set "$name" || status=$?
  if [[ "$status" -ne 0 ]]; then
    log "seed-staging: FAILED at set $name (the seed runner's exit $status, for the reason above): nothing of set" \
      "$name was written; the sets before it stay seeded, and the ones after it did not run. Once the cause is fixed" \
      "(a missing migration: npm run deploy:staging migrates the staging database, step 1), run the same command" \
      "again." >&2
    exit "$status"
  fi
done
log "seed-staging: done: sets ${sets[*]} seeded into schema public on the staging database"
