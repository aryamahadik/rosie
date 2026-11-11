#!/usr/bin/env bash
# Staging's Worker secrets, set by name from the build Mac (T-568; C-022; build prompt rule 7: keys are named, never
# shown; DL-017, DL-024):
#   npm run secrets:staging        (bash infra/scripts/put-staging-secrets.sh [--env staging])
# For each name in SECRETS below, the value is read by name from this checkout's git-ignored .dev.vars and handed to
# `wrangler secret put <NAME> --env staging` through cf.sh, on standard input. Standard output is one line per name, in
# the list's order, and nothing else:
#   <NAME> set       wrangler took the value: staging's Worker reads it by that name from now on
#   <NAME> missing   .dev.vars holds no value for the name (no line, or an empty one): nothing was put for it, never an
#                    empty secret
# The names are the ones staging's Worker reads, each beside the code that reads it. The model key is the one scoped to
# Rosie's workspace (DL-027), so no workspace id is a secret: no code reads one.
#
# A value:
#   - comes from .dev.vars alone. A variable of the same name in the caller's shell is dropped before the file is read,
#     so the key of another tool on this Mac is never put on staging.
#   - is never printed, logged, exported, put on a command line or written to a file: it is held in one shell variable
#     and goes down one pipe to cf.sh. No here-document or here-string is used (bash 3.2 writes those to a temporary
#     file), and tracing is switched off first, whatever the caller's shell asked for. So is allexport, and the
#     script's own variables are dropped before anything is read, so a variable of the same name in the caller's
#     environment never makes one of them an exported one (the note above `unset -v` below).
#   - is never shown by wrangler either: what wrangler prints is kept off the terminal, dropped after a put that worked
#     and printed after one that failed with the value taken out; and wrangler's own debug log is told to leave request
#     bodies out (WRANGLER_LOG_SANITIZE).
# Refused before any value is read (exit 1):
#   - --env other than staging, in any form, or given twice: production's secrets are set by the CTO from his own login
#     (ADR-012), and no other environment is set from here;
#   - CLOUDFLARE_ENV other than staging, which cf.sh refuses too.
# Refused before any value is put (exit 1):
#   - a .dev.vars that cannot be read;
#   - a value that holds a space, a quote or a #: no key, base64 or whsec_ value does, so its line is not a plain
#     NAME=value (a comment after the value, a quote left open: lib.sh's load_dev_var keeps those in the value). Every
#     name is checked before the first put, so staging is untouched.
# A put that fails stops the run (exit 1): the names before it stay set, and the ones after it are not put. cf.sh's own
# refusals arrive the same way.
# Each put makes a new version of the staging Worker and deploys it at once (wrangler secret put), so run this when a
# value changes, not with every deploy. A second run puts every value again. wrangler refuses a put while the Worker's
# latest version is not the deployed one (a version uploaded since the last deploy, as a branch preview's is): deploy
# staging first (npm run deploy:staging), then run this again.
# Afterwards, `npm run cf -- secret list --env staging` lists the names staging holds (names only).
# Exit: 0 every name set; 1 refused, or a put failed; 2 misuse (an argument it does not take), found before anything is
# read; 3 one or more names missing, the others set.
set +x
set +a
set -euo pipefail
# No variable of this script starts out marked for export, or with the caller's text in it, whatever names the caller's
# environment holds. bash marks every variable it inherits for export, and under allexport (bash -a, or handed down in
# SHELLOPTS) every variable as it is set; a variable marked so goes to every command started from here, cf.sh and
# wrangler among them, with whatever it holds then. So allexport is switched off above, and every name this script and
# lib.sh's load_dev_var keep a variable of their own under is dropped here, before anything is read: value, line and
# said (a value, a line of .dev.vars, wrangler's words) and the rest (names, counts, a path, the --env argument).
# BASH_REMATCH, where load_dev_var's match leaves the value, goes with them; bash keeps it as an array from the first
# match on, and never exports an array. A new variable, here or in load_dev_var, goes on this line too:
# put-staging-secrets.test.mjs fails until it does.
unset -v value said line name file bad status missing env_name env_count BASH_REMATCH
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The secrets staging's Worker reads, by name.
SECRETS=(
  # The model key: ai/src/gateway/gateway.ts KEY_VARIABLE (the AI gateway, T-361; the safety read reads it too).
  ANTHROPIC_API_KEY
  # The environment key that wraps every person's sealing key (NQ-DB-1): runtime/src/wiring/real.ts SEALING_WRAP_KEY and
  # db/repo/sealing.ts DEFAULT_WRAPPING_KEY_NAME (T-182). 32 random bytes as base64.
  SEALING_WRAP_KEY
  # The Linq webhook signing secret: runtime/src/wiring/real.ts LINQ_WEBHOOK_SECRET. "whsec_" and base64. Until J-08 it
  # is the one the test-phone page's Linq double signs with (T-412): staging's own, never Linq's.
  LINQ_WEBHOOK_SECRET
)
USAGE="usage: put-staging-secrets.sh [--env staging]"
DEV_VARS="$ROOT/.dev.vars"
# What no value in SECRETS holds: white space, a quote, a #.
NOT_IN_A_VALUE="[[:space:]\"'#]"

# misuse <why>: a command line this script does not take (exit 2). No argument is echoed: one could be a pasted key.
misuse() {
  printf '%s: %s\n%s\n' "$(basename "$0")" "$*" "$USAGE" >&2
  exit 2
}

env_name="staging"
env_count=0
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
    *)
      misuse "an argument it does not take (arguments are never echoed)"
      ;;
  esac
done
if [[ "$env_name" == "production" ]]; then
  die "refused: --env production is never run from here: production's secrets are set by the CTO from his own login" \
    "(ADR-012); nothing was read or put"
fi
if [[ "$env_count" -gt 1 ]]; then
  die "refused: --env is given more than once; nothing was read or put"
fi
if [[ "$env_name" != "staging" ]]; then
  die "refused: --env names an environment other than staging (the name is not echoed): this script sets staging's" \
    "secrets alone; nothing was read or put"
fi
if [[ -n "${CLOUDFLARE_ENV:-}" && "$CLOUDFLARE_ENV" != "staging" ]]; then
  die "refused: CLOUDFLARE_ENV names an environment other than staging: this script sets staging's secrets alone;" \
    "nothing was read or put"
fi

if [[ -e "$DEV_VARS" && ! -r "$DEV_VARS" ]]; then
  die "refused: this checkout's .dev.vars cannot be read; nothing was put"
fi

# value_of <NAME>: sets `value` to the name's value in .dev.vars, "" when it has none. The caller's own variable of that
# name is dropped first, so it is never the value put. lib.sh's load_dev_var exports what it reads, so the name is unset
# again at once: no command started from here finds a value in its environment.
value=""
value_of() {
  local name="$1"
  unset "$name"
  load_dev_var "$name"
  value="${!name:-}"
  unset "$name"
}

# Every name's value is checked before the first put.
bad=""
for name in "${SECRETS[@]}"; do
  value_of "$name"
  if [[ "$value" =~ $NOT_IN_A_VALUE ]]; then
    bad="${bad:+$bad, }$name"
  fi
done
value=""
if [[ -n "$bad" ]]; then
  die "refused: in .dev.vars the value of $bad holds a space, a quote or a #, which no key does: write its line as" \
    "NAME=value, with nothing after the value; nothing was put"
fi

# wrangler's debug log leaves request bodies out, whatever the caller's shell set.
export WRANGLER_LOG_SANITIZE=true

missing=0
for name in "${SECRETS[@]}"; do
  value_of "$name"
  if [[ -z "$value" ]]; then
    printf '%s missing\n' "$name"
    missing=$((missing + 1))
    continue
  fi
  status=0
  said="$(printf '%s' "$value" | "$CF" secret put "$name" --env staging 2>&1)" || status=$?
  if [[ "$status" -ne 0 ]]; then
    said=${said//"$value"/[value not shown]}
    value=""
    printf '%s\n' "$said" >&2
    die "wrangler secret put $name --env staging failed (exit $status, for the reason above): $name was not put, and" \
      "no name after it was tried; the names printed as set stay set. Once the cause is fixed, run it again."
  fi
  value=""
  said=""
  printf '%s set\n' "$name"
done

if [[ "$missing" -gt 0 ]]; then
  printf '%s: no value in .dev.vars for %s of the %s names, each printed as missing: nothing was put for a missing name. Add each as NAME=value, then run it again.\n' \
    "$(basename "$0")" "$missing" "${#SECRETS[@]}" >&2
  exit 3
fi
