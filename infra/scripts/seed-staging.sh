#!/usr/bin/env bash
# Staging's seeded state, from the build Mac (T-571; build prompt 9.4 'Seeded state'; C-202, C-011; QUESTIONS NQ-DB-2;
# STATE note 67; DL-308; the check tester's set and its token's hash: T-1303, K-05 v1.12 default 105, QUESTIONS CQ-214
# (a), DL-542, DL-561):
#   npm run seed:staging
#       D-017's sets, in this order: core (T-200: the demo shops' core rows), staging-core (T-202: the test businesses,
#       and a customer person, handle and phone row for each test phone but test owner 1), skeleton (T-1148: test
#       owner 1, whose JOIN is a first text), then check-tester (T-1302: staging's check tester, a person with a live
#       team row and a live session whose token_sha256 is its token's sha256, handed in by name: see below).
#   npm run seed:staging -- --set <name> [--set <name>]...
#       the sets named, in the order given: a later set (T-216's, T-218's) runs by its name, db/seeds/<name>.ts.
# Each set is one run of T-201's seed runner (node db/seeds/run.mjs --set <name>), which writes it idempotently, in one
# transaction as rosie_job, and prints its row counts: a second run writes nothing. A set that fails stops the script:
# nothing of that set is written, the sets before it stay seeded (each committed on its own) and the ones after it do
# not run. Once the cause is fixed, the same command runs again.
#
# The database is staging's alone: STAGING_DATABASE_URL, from the environment, else from .dev.vars by name, never
# printed. The runner gets it as DATABASE_URL too, which is how it knows staging (T-201's handoff). Only the commands
# that use the database get a database URL (T-1310; T-1303's security review, note c): the URL leaves this shell's
# environment before anything is started (dirname included), with the caller's DATABASE_URL, which is only compared
# with it (below); it is kept in a variable of the script's own that is never exported, and handed by name to each run
# of the seed runner, as both names, and to the read of the session's end (below), as DATABASE_URL, on those commands'
# lines alone; then it is dropped. The token's hasher, and every other command, gets none. The schema is public, the
# one staging's Worker reads (DB_SCHEMA is empty in wrangler.jsonc's env.staging), named explicitly, since the runner
# seeds public whenever DB_SCHEMA is unset (T-201's security review, note c). Refused before any set runs, with the
# database untouched (exit 1):
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
#
# The check tester's token (T-1303; CQ-214 (a); K-05 v1.12 default 105): the session token with which T-570's check and
# T-467's run sign in to staging's test-phone page. It is made at random on the build Mac by
# `npm run check-tester:token:make` (infra/scripts/make-check-tester-token.mjs: 32 random bytes written as 43 characters
# of base64url, as T-322's newSessionToken makes a session token; the user's step, a secret write: DL-497, DL-514) and
# kept there by name, STAGING_CHECK_TESTER_TOKEN: from the environment, else from .dev.vars, as lib.sh's load_dev_var
# reads a name. Only when check-tester is among the sets, and all before the first set runs, this script reads it,
# checks that it is in the form it is made in, and makes its sha256 (lower-case hex) with node, which gets the token on
# standard input alone. Only the hash goes on, by name, as STAGING_CHECK_TESTER_TOKEN_SHA256 (the name T-1302's set
# reads), to the check-tester set's run of the seed runner and to no other command. The token is never printed, put in
# a command's arguments or put in any command's environment: the name is dropped from this script's environment before
# any command is started, whatever the sets, and the token is kept in a variable of the script's own only until its
# hash is made. A STAGING_CHECK_TESTER_TOKEN_SHA256 in the caller's environment is dropped too: the hash is always made
# here, from the token. Neither is ever printed. Refused before any set runs, with the database untouched (exit 1),
# whenever check-tester is among the sets:
#   - STAGING_CHECK_TESTER_TOKEN is not set, or empty: make it first (npm run check-tester:token:make);
#   - it is not in the form it is made in: 43 characters of base64url that are 32 bytes. A sha256 (64 hex characters)
#     in the token's place is refused so, as T-1302's set refuses a token in the hash's place (DL-561).
# The check tester's session lasts 30 days from the run that first seeded its token's hash (T-1302; CQ-238). The seed
# runner prints row counts alone, so once check-tester's run has passed, this script reads that session's end back from
# the staging database (T-1302's sessionExpiresAt) and prints it: as rosie_job, in a read-only transaction, by the check
# tester's person id (never by the hash), the one live session the set leaves it. To replace a lost or lapsing token:
# `npm run check-tester:token:make -- --rotate`, then `npm run seed:staging -- --set check-tester`, which ends the old
# token's session (T-1302). A lapsed or ended token's hash is refused by the set, so such a token is always replaced.
#
# Nothing here prints a database URL or any part of it, a phone number, the token or its hash: the runner prints the set,
# the schema, "the staging database" and row counts, and a failure only as its code and its message with every part of
# the URL taken out (infra/scripts/db-url.mjs), as does the read of the session's end.
# Exit: 0 every set seeded; 1 refused, or a set refused or failed (the runner's exit is passed on), or the check tester's
# session end could not be read after its set; 2 misuse (an argument or a set name it does not take), found before
# anything runs.
set +x
set +a
set +k
set -euo pipefail
# No variable of this script starts out marked for export, or with the caller's text in it, whatever the caller's
# environment holds (as make-staging-secrets.sh does). bash marks every variable it inherits for export, and under
# allexport (bash -a, or handed down in SHELLOPTS) every variable as it is set; a variable marked so goes to every
# command started from here (basename, date, node) with whatever it holds then, so one named token or hash would hand
# the token or its hash on. A function's local takes the mark of the variable of the same name outside it. Under keyword
# (bash -k) an assignment anywhere on a command line goes to that command's environment, and xtrace (bash -x) would
# print each command with the token in it. So the three are switched off above, and every name this script, and lib.sh's
# load_dev_var that reads .dev.vars for it, keeps a variable of its own under is dropped here, before anything is read,
# sourced or started (lib.sh's ROOT and CF with them). BASH_REMATCH, where load_dev_var's match leaves what it read, goes
# too; bash never exports an array. A new variable, here or in load_dev_var, goes on these lines too:
# seed-staging.test.mjs fails until it does.
unset -v token hash ends status with_tester sets named name file list line value ROOT CF db_url caller_url
unset -v D017_SETS CHECK_TESTER_SET SET_NAME USAGE BASE64URL_SIGNS LAST_SIGNS HEX_SIGNS ISO_TIME SHA256_OF_INPUT
unset -v SESSION_END BASH_REMATCH
# The check tester's token, when the caller's environment holds it, goes into a variable of the script's own, which is
# never exported, and the name is dropped from the environment at once, with its hash's, before any command is started
# (sourcing lib.sh runs dirname): no command started from here finds either in its environment, whatever the sets.
token="${STAGING_CHECK_TESTER_TOKEN:-}"
unset -v STAGING_CHECK_TESTER_TOKEN STAGING_CHECK_TESTER_TOKEN_SHA256
# The staging database's URL and the caller's DATABASE_URL go the same way, before any command is started (T-1310):
# db_url is handed on by name to the commands that use the database alone, and caller_url is only compared with it
# (below), then dropped.
db_url="${STAGING_DATABASE_URL:-}"
caller_url="${DATABASE_URL:-}"
unset -v STAGING_DATABASE_URL DATABASE_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# D-017's sets, in their order (STATE note 67; T-202's handoff; the check tester's, T-1302, last).
D017_SETS=(core staging-core skeleton check-tester)
# The set that takes the check tester's token's sha256 (T-1302's db/seeds/check-tester.ts).
CHECK_TESTER_SET="check-tester"
# A set's name, as the runner takes it (db/seeds/run.mjs SET_NAME): test files and lib/ are never sets.
SET_NAME='^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
USAGE="usage: seed-staging.sh [--set <name>]... (with no --set: D-017's sets, ${D017_SETS[*]})"
# The 64 signs of base64url, one by one (a range such as A-Z takes in other letters in some locales), and the signs
# the 43rd of a token may be: 32 bytes leave its last two bits 0. With the length, the token's made form exactly.
BASE64URL_SIGNS="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
LAST_SIGNS="AEIMQUYcgkosw048"
HEX_SIGNS="0123456789abcdef"
# A time as the read of the session's end prints it (JavaScript's toISOString).
ISO_TIME='^[[:digit:]]{4}-[[:digit:]]{2}-[[:digit:]]{2}T[[:digit:]]{2}:[[:digit:]]{2}:[[:digit:]]{2}\.[[:digit:]]{3}Z$'
# node program: reads the token on standard input and prints its sha256 as lower-case hex, with no line end, as T-322's
# sha256Hex makes a session token's (the text's UTF-8 bytes). Anything but the made form fails (exit 1) and prints
# nothing.
SHA256_OF_INPUT='
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (chunk) {
    text += chunk;
  });
  process.stdin.on("end", function () {
    const bytes = /^[A-Za-z0-9_-]{43}$/.test(text) ? Buffer.from(text, "base64url") : Buffer.alloc(0);
    if (bytes.length !== 32 || bytes.toString("base64url") !== text) process.exit(1);
    process.stdout.write(require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex"));
  });
'
# node program (an ES module): prints when the check tester's one live session ends, read back after its set ran: on the
# database of DATABASE_URL, as rosie_job (the role the set writes as) with the business scope set empty, in a read-only
# transaction, by the check tester's person id from the set's own module. Argument: the checkout's root. Anything but one
# live session fails (exit 1). Every error line has every part of the URL taken out (infra/scripts/db-url.mjs), as in the
# seed runner. db/ imports its neighbours without an extension, so a relative import from a .ts file is completed with
# .ts or /index.ts, as the seed runner does.
SESSION_END='
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      if (!/^\.\.?\//.test(specifier) || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});

const [root] = process.argv.slice(1);
const load = (file) => import(pathToFileURL(root + "/" + file).href);
const { DatabaseUrlFault, checkDatabaseUrl, describeError, printStrayErrors } = await load(
  "infra/scripts/db-url.mjs",
);
let secrets = [process.env.DATABASE_URL ?? ""];
printStrayErrors("seed-staging", () => secrets);
const fail = (line) => {
  console.error("seed-staging: " + line);
  process.exitCode = 1;
};
let db;
try {
  secrets = checkDatabaseUrl(process.env.DATABASE_URL ?? "");
  const { CHECK_TESTER } = await load("db/seeds/check-tester.ts");
  const { SEED_ROLE } = await load("db/seeds/core.ts");
  const { SCOPE_SETTING } = await load("db/repo/scope.ts");
  const { createClient } = await load("db/repo/client.ts");
  db = createClient({ max: 1, env: { DATABASE_URL: process.env.DATABASE_URL } });
  const live = await db.primary.begin("read only", async (tx) => {
    await tx.unsafe("set local role " + SEED_ROLE);
    await tx`select set_config(${SCOPE_SETTING}, ${""}, true)`;
    return tx`
      select expires_at from sessions
      where person_id = ${CHECK_TESTER.personId} and ended_at is null and expires_at > now()
    `;
  });
  if (live.length === 1) process.stdout.write(live[0].expires_at.toISOString());
  else fail("the check tester holds " + String(live.length) + " live sessions, not one");
} catch (error) {
  if (error instanceof DatabaseUrlFault) fail("refused: DATABASE_URL does not parse: " + error.message);
  else fail("reading the end of the check tester session failed" + describeError(error, secrets));
} finally {
  await db?.close().catch((error) => fail("closing the database client failed" + describeError(error, secrets)));
}
'

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

# session_end: prints when the check tester's session ends, read back after its set ran (the program above prints the
# time alone). A read that fails, or prints anything else, stops the run.
session_end() {
  status=0
  ends="$(DATABASE_URL="$db_url" DB_SCHEMA="public" node --disable-warning=ExperimentalWarning \
    --input-type=module -e "$SESSION_END" "$ROOT")" || status=$?
  if [[ "$status" -ne 0 || ! "$ends" =~ $ISO_TIME ]]; then
    log "seed-staging: FAILED after set $CHECK_TESTER_SET: the end of the check tester's session could not be read" \
      "back (for the reason above); every set before it, $CHECK_TESTER_SET included, stays seeded, and the ones after" \
      "it did not run. Run npm run seed:staging -- --set $CHECK_TESTER_SET again to read it: a second run writes" \
      "nothing." >&2
    exit 1
  fi
  log "seed-staging: the check tester's session ends at $ends (30 days after the run that first seeded its token's" \
    "hash): before then, make a new token (npm run check-tester:token:make -- --rotate) and run" \
    "npm run seed:staging -- --set $CHECK_TESTER_SET"
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

# The staging database's URL from .dev.vars by name, when the environment gave none (see the top of this file):
# load_dev_var exports what it reads, so the value goes into the script's own variable and the name is dropped again at
# once, before any command is started.
if [[ -z "$db_url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  db_url="${STAGING_DATABASE_URL:-}"
  unset -v STAGING_DATABASE_URL
fi
[[ -n "$db_url" ]] ||
  die "refused: STAGING_DATABASE_URL is not set: staging has no database yet (J-06); nothing was read or written"
if [[ -n "$caller_url" && "$caller_url" != "$db_url" ]]; then
  caller_url=""
  die "refused: DATABASE_URL is set and names a database other than STAGING_DATABASE_URL's: this script seeds the" \
    "staging database alone (unset DATABASE_URL to seed it; node db/seeds/run.mjs seeds a local database); nothing" \
    "was read or written"
fi
caller_url=""
if [[ -n "${DB_SCHEMA:-}" && "$DB_SCHEMA" != "public" ]]; then
  die "refused: DB_SCHEMA names a schema other than public: this script seeds the staging database's own schema," \
    "public, which staging's Worker reads (a preview's schema is deploy-preview's to seed, C-010); nothing was read" \
    "or written"
fi

# The check tester's token, only when check-tester is among the sets (see the top of this file): read by name, its
# form checked and its sha256 made, all before the first set runs. Otherwise it is dropped unread.
with_tester=0
for name in "${sets[@]}"; do
  if [[ "$name" == "$CHECK_TESTER_SET" ]]; then
    with_tester=1
  fi
done
hash=""
if [[ "$with_tester" == 1 ]]; then
  if [[ -z "$token" ]]; then
    # load_dev_var exports what it reads: the value goes into the script's own variable and the name is dropped again
    # at once, before any command is started. What its match left in BASH_REMATCH (the line's value) is overwritten by
    # a match of nothing: bash 3.2 keeps BASH_REMATCH read-only once a match has run, and never exports it.
    load_dev_var STAGING_CHECK_TESTER_TOKEN
    token="${STAGING_CHECK_TESTER_TOKEN:-}"
    unset -v STAGING_CHECK_TESTER_TOKEN
    [[ "" =~ ^$ ]]
  fi
  if [[ -z "$token" ]]; then
    die "refused: STAGING_CHECK_TESTER_TOKEN is not set (the check tester's token, read by name from the environment," \
      "else from .dev.vars): the $CHECK_TESTER_SET set takes its sha256, and the token is made on the build Mac with" \
      "npm run check-tester:token:make (the user's step); no set ran: nothing was read or written"
  fi
  if [[ "${#token}" -ne 43 || "$token" == *[!$BASE64URL_SIGNS]* || "${token:42:1}" != [$LAST_SIGNS] ]]; then
    token=""
    die "refused: STAGING_CHECK_TESTER_TOKEN is not the check tester's token in the form it is made in (43 characters" \
      "of base64url that are 32 random bytes, as npm run check-tester:token:make makes it; a sha256 in its place is" \
      "refused too), and no part of it is shown; no set ran: nothing was read or written"
  fi
  status=0
  hash="$(printf '%s' "$token" | node -e "$SHA256_OF_INPUT")" || status=$?
  token=""
  if [[ "$status" -ne 0 || "${#hash}" -ne 64 || "$hash" == *[!$HEX_SIGNS]* ]]; then
    hash=""
    die "refused: node did not give the token's sha256 as 64 lower-case hex characters (what it gave is not shown);" \
      "no set ran: nothing was read or written"
  fi
fi
token=""

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
if [[ "$with_tester" == 1 ]]; then
  log "seed-staging: $CHECK_TESTER_SET gets the sha256 of the check tester's token (STAGING_CHECK_TESTER_TOKEN)" \
    "by name, as STAGING_CHECK_TESTER_TOKEN_SHA256: neither is shown, and no other command gets either"
fi

for name in "${sets[@]}"; do
  log "seed-staging: set $name"
  status=0
  # The staging database's URL, by name, to the seed runner's run alone: as DATABASE_URL, and as STAGING_DATABASE_URL,
  # the same URL, which is how the runner knows staging (T-201).
  if [[ "$name" == "$CHECK_TESTER_SET" ]]; then
    # The token's sha256, by name, to this run of the seed runner alone.
    STAGING_CHECK_TESTER_TOKEN_SHA256="$hash" DATABASE_URL="$db_url" STAGING_DATABASE_URL="$db_url" DB_SCHEMA="public" \
      node --disable-warning=ExperimentalWarning "$ROOT/db/seeds/run.mjs" --set "$name" || status=$?
  else
    DATABASE_URL="$db_url" STAGING_DATABASE_URL="$db_url" DB_SCHEMA="public" \
      node --disable-warning=ExperimentalWarning "$ROOT/db/seeds/run.mjs" --set "$name" || status=$?
  fi
  if [[ "$status" -ne 0 ]]; then
    hash=""
    db_url=""
    log "seed-staging: FAILED at set $name (the seed runner's exit $status, for the reason above): nothing of set" \
      "$name was written; the sets before it stay seeded, and the ones after it did not run. Once the cause is fixed" \
      "(a missing migration: npm run deploy:staging migrates the staging database, step 1), run the same command" \
      "again." >&2
    exit "$status"
  fi
  if [[ "$name" == "$CHECK_TESTER_SET" ]]; then
    session_end
  fi
done
hash=""
db_url=""
log "seed-staging: done: sets ${sets[*]} seeded into schema public on the staging database"
