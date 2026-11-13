#!/usr/bin/env bash
# Staging's own secrets, made in place from the build Mac (T-1236; T-1276, ADR-016 card G; C-022; CQ-210; DL-485; build
# prompt rule 7: keys are named, never shown):
#   npm run secrets:staging:make   (bash infra/scripts/make-staging-secrets.sh [--env staging] [NAME ...])
# The secrets on MADE below are staging's own: no vendor issues them and nobody is given them, so
# put-staging-secrets.sh (npm run secrets:staging) never puts one, whatever .dev.vars holds for it, and prints it as
# made in place, never put (T-1261; DL-549). This script makes them where they are used. It first asks staging which
# names it holds (`wrangler secret list --env staging --format json`, through cf.sh: names only). Then, for each name
# in MADE below, or only for the names given (each must be on that list), standard output gets one line, in the list's
# order, and nothing else:
#   <NAME> already set
#       staging holds the name. It is left exactly as it is: a secret is never replaced from here. Replacing the sealing
#       key would orphan everything sealed under it, and replacing the proof-code hash key would void every live sign-in
#       code and restart every contact's day count and pause (ADR-016 section 4); rotation is a task of its own, never
#       this script's (DL-495; CQ-218).
#   <NAME> has a value in .dev.vars, which is not used: the name is made in place, so remove its line from .dev.vars
#       staging does not hold the name, and this checkout's .dev.vars has a value for it (read as lib.sh's load_dev_var
#       reads a name). That value is never used: this script never takes it, and secrets:staging never puts a name made
#       here (T-1261; DL-549; T-1310). Nothing is made for the name while that line is there, since the line would read
#       as staging's value, which it never is: remove it, then run this again, and the name is made in place. The value
#       is never shown.
#   <NAME> made and set
#       staging did not hold the name and .dev.vars had no value for it: a fresh random value in the name's form went to
#       `wrangler secret put <NAME> --env staging` through cf.sh, on standard input, and wrangler took it. Only
#       staging's Worker holds it now: it is kept nowhere else, so it cannot be read back or put a second time.
# Every name's line is decided before the first value is made: the names staging holds, and what .dev.vars has.
#
# A value:
#   - is made here and nowhere else: 32 random bytes from node's crypto.randomBytes (node's own cryptographic generator;
#     no package), as base64, with the name's prefix in front. It is checked to be exactly that form before it is put,
#     so an empty or cut-short value is never put.
#   - is made only for a name on MADE. A vendor's key is never made here, nor the testers' inbox list:
#     ANTHROPIC_API_KEY, RESEND_API_KEY, STAGING_TEST_INBOXES, or any other name that is not on the list, is refused as
#     an argument before anything is listed, made or put.
#   - is never printed, logged, exported, put on a command line or written to a file: it is held in one shell variable
#     and goes down one pipe to cf.sh. No here-document or here-string is used (bash 3.2 writes those to a temporary
#     file), and tracing is switched off first, whatever the caller's shell asked for. So are allexport and keyword, and
#     the script's own variables are dropped before anything is read, so a variable of the same name in the caller's
#     environment never makes one of them an exported one (the note above `unset -v` below).
#   - is never shown by wrangler either: what wrangler prints for a put is kept off the terminal, dropped after a put
#     that worked and printed after one that failed with the value taken out; and wrangler's own debug log is told to
#     leave request bodies out (WRANGLER_LOG_SANITIZE).
# A value in .dev.vars is never put, printed or kept by this script: it only finds out whether there is one.
# Refused before anything is read, listed or made (exit 1):
#   - --env other than staging, in any form, or given twice: production's secrets are set by the CTO from his own login
#     (ADR-012), and no other environment is set from here;
#   - CLOUDFLARE_ENV other than staging, which cf.sh refuses too;
#   - a name that is not on MADE.
# Refused before anything is made (exit 1):
#   - a .dev.vars that cannot be read: whether it has a value for a name is not known;
#   - a `secret list` that fails, or prints anything but its JSON list of names: which names staging holds is not known.
#     A Worker that does not exist yet fails here too, so a put never creates one.
# A value that does not come out in the right form, or a put that fails, stops the run (exit 1): the names printed as
# made and set stay set, and no name after it is tried. The value that was not put is dropped. Run it again once the
# cause is fixed: a name that did get set is then "already set", and one that did not gets a new value.
# Each put makes a new version of the staging Worker and deploys it at once (wrangler secret put). wrangler refuses a
# put while the Worker's latest version is not the deployed one (a version uploaded since the last deploy, as a branch
# preview's is): deploy staging first (npm run deploy:staging), then run this again.
# Afterwards, `npm run cf -- secret list --env staging` lists the names staging holds (names only).
# Exit: 0 every name is on staging (made and set, or already set); 1 refused, or a list or a put failed; 2 misuse (an
# option it does not take), found before anything is read; 3 one or more names have a value in .dev.vars, which is not
# used, and were not made (remove each such line, then run this again); the others are on staging.
set +x
set +a
set +k
set -euo pipefail
# No variable of this script starts out marked for export, or with the caller's text in it, whatever names the caller's
# environment holds. bash marks every variable it inherits for export, and under allexport (bash -a, or handed down in
# SHELLOPTS) every variable as it is set; a variable marked so goes to every command started from here, cf.sh, node and
# wrangler among them, with whatever it holds then. A function's local takes the mark of the variable of the same name
# outside it. Under keyword (bash -k, or handed down in SHELLOPTS) an assignment anywhere on a command line goes to that
# command's environment instead: `export NAME=value`, here and in cf.sh, would run as a bare export, which prints every
# exported variable, and lib.sh's `local name=...` would declare nothing. So allexport and keyword are switched off
# above, and every name this script and lib.sh's load_dev_var keep a variable of their own under is dropped here,
# before anything is read or sourced: value and said (a value made here; wrangler's words about a put), line (a line
# of .dev.vars), and the rest, the fixed texts in capitals included (names, counts, a path, the arguments).
# BASH_REMATCH, where load_dev_var's match leaves what it read, goes with them; bash keeps it as an array from the
# first match on, and never exports an array. A new variable, here or in load_dev_var, goes on these lines too:
# make-staging-secrets.test.mjs fails until it does.
unset -v value said line name file each prefix found status listed held plan wanted given left index env_name env_count
unset -v MADE USAGE DEV_VARS BASE64_SIGNS NEWLINE RANDOM_BYTES LISTED_NAMES BASH_REMATCH
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The secrets staging makes for itself, by name. Each is also on put-staging-secrets.sh's list, beside the code that
# reads it, and has its form in make_value below.
MADE=(
  # The environment key that wraps every person's sealing key (NQ-DB-1): 32 random bytes as base64 (db/repo/sealing.ts
  # WrappingKeys.resolve; runtime/src/wiring/real.ts SEALING_WRAP_KEY).
  SEALING_WRAP_KEY
  # The Linq webhook signing secret: "whsec_" and base64 (runtime/src/wiring/real.ts LinqVerifyInputs; the key bytes
  # after the prefix are what adapters/src/shared/hmac.ts signs and checks under). Until J-08 it is the one the
  # test-phone page's Linq double signs with (T-412): staging's own, never Linq's.
  LINQ_WEBHOOK_SECRET
  # The key every sign-in code's hash and every typed contact's hash is made under: HMAC-SHA-256, with a fixed, distinct
  # prefix for each (ADR-016 section 4; one key for both, CQ-240). 32 random bytes as base64, as SEALING_WRAP_KEY. Its
  # name is the one K-22's rows keep in hash_key_name (contracts/db-schema/people-access); staging's root hands a hashing
  # port over it, read by name, to the sign-in calls (T-1289). DL-495's conditions hold for it as for the sealing key.
  PROOF_CODE_HASH_KEY
)
# A variable of one of those names in the caller's shell (another tool's key on this Mac) is dropped before any command
# is started: it never counts as a value, and never travels on to cf.sh, node or wrangler.
unset -v "${MADE[@]}"
USAGE="usage: make-staging-secrets.sh [--env staging] [NAME ...]   (names: ${MADE[*]})"
DEV_VARS="$ROOT/.dev.vars"
# The 64 signs of base64, one by one: a range such as A-Z takes in other letters in some locales.
BASE64_SIGNS="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
NEWLINE=$'\n'
# node program: 32 random bytes as base64 on standard output, with no line end. 44 signs, the last one "=".
RANDOM_BYTES='process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"));'
# node program: reads what `wrangler secret list --format json` printed on standard input and prints the names, one
# per line. Anything but a JSON array of objects that each have a name fails (exit 1) and prints nothing.
LISTED_NAMES='
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (chunk) {
    text += chunk;
  });
  process.stdin.on("end", function () {
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      process.exit(1);
    }
    if (!Array.isArray(list)) process.exit(1);
    let names = "";
    for (const item of list) {
      const name = typeof item === "object" && item !== null ? item.name : undefined;
      if (typeof name !== "string" || name === "" || /[\r\n]/.test(name)) process.exit(1);
      names += name + "\n";
    }
    process.stdout.write(names);
  });
'

# misuse <why>: a command line this script does not take (exit 2). No argument is echoed: one could be a pasted key.
misuse() {
  printf '%s: %s\n%s\n' "$(basename "$0")" "$*" "$USAGE" >&2
  exit 2
}

# is_made <text>: whether the text is a name on MADE.
is_made() {
  local each
  for each in "${MADE[@]}"; do
    if [[ "$1" == "$each" ]]; then
      return 0
    fi
  done
  return 1
}

env_name="staging"
env_count=0
given=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      env_count=$((env_count + 1))
      if [[ $# -ge 2 ]]; then
        env_name="$2"
        shift 2
      else
        env_name=""
        shift
      fi
      ;;
    --env=*)
      env_count=$((env_count + 1))
      env_name="${1#*=}"
      shift
      ;;
    -*)
      misuse "an option it does not take (arguments are never echoed)"
      ;;
    *)
      given+=("$1")
      shift
      ;;
  esac
done
if [[ "$env_name" == "production" ]]; then
  die "refused: --env production is never run from here: production's secrets are set by the CTO from his own login" \
    "(ADR-012); nothing was read, listed or made"
fi
if [[ "$env_count" -gt 1 ]]; then
  die "refused: --env is given more than once; nothing was read, listed or made"
fi
if [[ "$env_name" != "staging" ]]; then
  die "refused: --env names an environment other than staging (the name is not echoed): this script makes staging's" \
    "secrets alone; nothing was read, listed or made"
fi
if [[ -n "${CLOUDFLARE_ENV:-}" && "$CLOUDFLARE_ENV" != "staging" ]]; then
  die "refused: CLOUDFLARE_ENV names an environment other than staging: this script makes staging's secrets alone;" \
    "nothing was read, listed or made"
fi
for name in ${given[@]+"${given[@]}"}; do
  if ! is_made "$name"; then
    name=""
    die "refused: an argument is not a name this script makes (it makes ${MADE[*]}; arguments are never echoed): a" \
      "vendor's key, or any other name, is never made here; nothing was read, listed or made"
  fi
done

# The names of this run, in MADE's order: all of them, or the ones given, each once.
wanted=()
for name in "${MADE[@]}"; do
  if [[ "${#given[@]}" -eq 0 ]]; then
    wanted+=("$name")
    continue
  fi
  for each in "${given[@]}"; do
    if [[ "$each" == "$name" ]]; then
      wanted+=("$name")
      break
    fi
  done
done

if [[ -e "$DEV_VARS" && ! -r "$DEV_VARS" ]]; then
  die "refused: this checkout's .dev.vars cannot be read, so whether it has a value for a name is not known; nothing" \
    "was listed or made"
fi

# dev_var_found <NAME>: sets `found` to 1 when .dev.vars holds a value for the name, to "" when it has none (no line, or
# an empty one), read as lib.sh's load_dev_var reads a name. A variable of that name is dropped first, so only the file
# counts. lib.sh's load_dev_var exports what it reads, so the name is unset again at once, before any command is
# started: the value is not kept, and no command started from here finds it in its environment.
found=""
dev_var_found() {
  local name="$1"
  found=""
  unset "$name"
  load_dev_var "$name"
  if [[ -n "${!name:-}" ]]; then
    found=1
  fi
  unset "$name"
}

# make_value <NAME>: sets `value` to a fresh random value in the name's form. A name with no form here is refused before
# anything is made, and so is anything but 44 signs of base64 that end in one "=" (32 bytes) from the generator.
value=""
make_value() {
  local prefix
  case "$1" in
    SEALING_WRAP_KEY | PROOF_CODE_HASH_KEY) prefix="" ;;
    LINQ_WEBHOOK_SECRET) prefix="whsec_" ;;
    *) die "refused: $1 is on MADE with no form in make_value: nothing was made or put for it" ;;
  esac
  value="$(node -e "$RANDOM_BYTES")" || value=""
  if [[ "${#value}" -ne 44 || "$value" != *= || "${value%=}" == *[!$BASE64_SIGNS]* ]]; then
    value=""
    die "refused: node did not give 32 random bytes as base64 (what it gave is not shown): $1 was not made or put, and" \
      "no name after it was tried; the names printed as made and set stay set"
  fi
  value="$prefix$value"
}

# wrangler's debug log leaves request bodies out, whatever the caller's shell set.
export WRANGLER_LOG_SANITIZE=true

# The names staging holds. Standard output is wrangler's JSON list, kept here; its other words go to the terminal as
# they are (a list holds names, never a value, and nothing has been made yet).
status=0
listed="$("$CF" secret list --env staging --format json)" || status=$?
if [[ "$status" -ne 0 ]]; then
  if [[ -n "$listed" ]]; then
    printf '%s\n' "$listed" >&2
  fi
  die "wrangler secret list --env staging failed (exit $status, for the reason above): which names staging holds is" \
    "not known, so nothing was made or put. Once the cause is fixed, run it again."
fi
status=0
held="$(printf '%s' "$listed" | node -e "$LISTED_NAMES")" || status=$?
listed=""
if [[ "$status" -ne 0 ]]; then
  die "refused: what wrangler secret list --env staging printed is not its JSON list of names: which names staging" \
    "holds is not known, so nothing was made or put"
fi

# Every name's line is decided before the first value is made: held (staging holds it), left (.dev.vars has a value for
# it, which is not used: its line goes first) or make.
plan=()
for name in "${wanted[@]}"; do
  dev_var_found "$name"
  case "$NEWLINE$held$NEWLINE" in
    *"$NEWLINE$name$NEWLINE"*)
      plan+=("held")
      ;;
    *)
      if [[ -n "$found" ]]; then
        plan+=("left")
      else
        plan+=("make")
      fi
      ;;
  esac
done
found=""

left=0
index=0
for name in "${wanted[@]}"; do
  case "${plan[$index]}" in
    held)
      printf '%s already set\n' "$name"
      ;;
    left)
      printf '%s has a value in .dev.vars, which is not used: the name is made in place, so remove its line from .dev.vars\n' \
        "$name"
      left=$((left + 1))
      ;;
    make)
      make_value "$name"
      status=0
      said="$(printf '%s' "$value" | "$CF" secret put "$name" --env staging 2>&1)" || status=$?
      if [[ "$status" -ne 0 ]]; then
        said=${said//"$value"/[value not shown]}
        said=${said//"${value#whsec_}"/[value not shown]}
        value=""
        printf '%s\n' "$said" >&2
        die "wrangler secret put $name --env staging failed (exit $status, for the reason above): $name was not put," \
          "and no name after it was tried; the names printed as made and set stay set. The value made for it is" \
          "dropped. Once the cause is fixed, run it again."
      fi
      value=""
      said=""
      printf '%s made and set\n' "$name"
      ;;
    *)
      die "refused: no line was decided for $name: nothing was made or put for it"
      ;;
  esac
  index=$((index + 1))
done

if [[ "$left" -gt 0 ]]; then
  printf '%s: a value in .dev.vars for %s of the %s names, each printed with remove its line from .dev.vars: no such value is ever used (secrets:staging never puts a name made in place), so nothing was made for such a name, and staging does not hold it yet. Remove each such line from .dev.vars, then run this again: the name is then made in place.\n' \
    "$(basename "$0")" "$left" "${#wanted[@]}" >&2
  exit 3
fi
