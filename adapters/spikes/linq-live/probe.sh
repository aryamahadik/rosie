#!/usr/bin/env bash
# The outbound Linq probe (T-1121; K-11 v1; the lead note DL-841 on the card): Rosie's real Linq line, outbound only.
#   bash adapters/spikes/linq-live/probe.sh --dry-run [--step <step>]... [--out <folder>] [--stub-url <url>]
#       every chosen step against a local stand-in for Linq on 127.0.0.1 (stub.mjs, or the one --stub-url names, which
#       must be http://127.0.0.1:<port>): no network, no real key and no real number.
#   bash adapters/spikes/linq-live/probe.sh --live [--step <step>]... [--out <folder>]
#       Linq's API itself, on Rosie's real line: phase 2 alone, run by the lead with the user present (FINDINGS.md).
# The steps: capability, contact, send, stopped, stopped-override (lib.mjs says what each does). A dry run's default is
# every step; a live run's is capability and send, and a live run takes the stopped steps alone, after the phone has
# texted STOP. A message step sends one message at most and never retries.
#
# The values, each read by name and never printed (the lead note, item 2):
#   LINQ_API_TOKEN           Linq's API key
#   ROSIE_NUMBER             Rosie's sending line; LINQ_FROM when ROSIE_NUMBER is not set
#   STAGING_LINQ_ALLOWLIST   the numbers the probe may reach: E.164, joined by commas with no space
#   LINQ_PROBE_TO            the one destination, which must be on that list (needed only when it holds more than one)
# A live run reads each from the environment, else from the git-ignored .dev.vars at the checkout's root through
# infra/scripts/lib.sh's load_dev_var, as seed-staging.sh reads its names. A dry run reads the environment alone, never
# opens .dev.vars, and takes fiction numbers alone (+1, an area code, then 555-0100 to 555-0199).
#
# How the values travel (as seed-staging.sh keeps its token): each goes into a variable of this script's own, which is
# never exported, and its name leaves the environment at once, before any command is started. They reach the Node probe
# (probe.mjs) on its standard input alone, one a line, written there by printf, a builtin: never in any command's
# arguments or environment. No here-string or here-document carries them: bash 3.2 makes those a temporary file. The
# Node probe puts the key in the Authorization header of its requests and nowhere else, and every line it prints and
# every file it writes shows a number as its last 2 digits alone (***01). It refuses before any request: no list, an
# empty one, an entry that is not E.164, a destination off the list, no key, no sending line (lib.mjs checkValues).
#
# Exit: 0 every chosen step ran and each request had an answer, whatever Linq said; 1 refused before any request, or a
# request had no answer (nothing is retried); 2 misuse (no argument is ever echoed).
set +x
set +a
set +k
set -euo pipefail
# No variable of this script starts out marked for export or holding the caller's text (seed-staging.sh's note): every
# name this script, and lib.sh's load_dev_var that reads for it, keeps a variable under is dropped first (lib.sh's ROOT
# and CF with them). BASH_REMATCH, where load_dev_var's match leaves what it read, goes too; bash never exports an array.
unset -v mode key rosie_number linq_from allow_list probe_to status here ROOT CF name file line value BASH_REMATCH
# The values, when the caller's environment holds them, go into variables of the script's own, and their names leave
# the environment at once, before any command is started (finding this folder runs dirname).
key="${LINQ_API_TOKEN:-}"
rosie_number="${ROSIE_NUMBER:-}"
linq_from="${LINQ_FROM:-}"
allow_list="${STAGING_LINQ_ALLOWLIST:-}"
probe_to="${LINQ_PROBE_TO:-}"
unset -v LINQ_API_TOKEN ROSIE_NUMBER LINQ_FROM STAGING_LINQ_ALLOWLIST LINQ_PROBE_TO

# misuse <why>: a command line this script does not take (exit 2), before anything is read.
misuse() {
  printf 'probe.sh: misuse: %s\n' "$1" >&2
  printf '%s\n' "usage: bash adapters/spikes/linq-live/probe.sh --dry-run|--live [--step <step>]... [--out <folder>]" >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  --dry-run | --live)
    shift
    ;;
  *)
    misuse "the first argument is --dry-run or --live (arguments are never echoed)"
    ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../../../infra/scripts/lib.sh"

if [[ "$mode" == "--live" ]]; then
  # load_dev_var exports what it reads, so each value goes into the script's own variable and its name leaves the
  # environment again at once, before any command is started. ROSIE_NUMBER is read first; LINQ_FROM only without it.
  if [[ -z "$key" ]]; then
    load_dev_var LINQ_API_TOKEN
    key="${LINQ_API_TOKEN:-}"
    unset -v LINQ_API_TOKEN
  fi
  if [[ -z "$rosie_number" ]]; then
    load_dev_var ROSIE_NUMBER
    rosie_number="${ROSIE_NUMBER:-}"
    unset -v ROSIE_NUMBER
  fi
  if [[ -z "$rosie_number" && -z "$linq_from" ]]; then
    load_dev_var LINQ_FROM
    linq_from="${LINQ_FROM:-}"
    unset -v LINQ_FROM
  fi
  if [[ -z "$allow_list" ]]; then
    load_dev_var STAGING_LINQ_ALLOWLIST
    allow_list="${STAGING_LINQ_ALLOWLIST:-}"
    unset -v STAGING_LINQ_ALLOWLIST
  fi
  if [[ -z "$probe_to" ]]; then
    load_dev_var LINQ_PROBE_TO
    probe_to="${LINQ_PROBE_TO:-}"
    unset -v LINQ_PROBE_TO
  fi
  # What load_dev_var's match left in BASH_REMATCH (a line's value) is overwritten by a match of nothing.
  [[ "" =~ ^$ ]]
fi

# The values, one a line, on the Node probe's standard input alone (printf is a builtin, so no command's arguments hold
# them); the rest of the command line goes to it as given, never echoed.
status=0
printf '%s\n' "$key" "$rosie_number" "$linq_from" "$allow_list" "$probe_to" |
  node "$here/probe.mjs" "$mode" ${1+"$@"} || status=$?
key=""
rosie_number=""
linq_from=""
allow_list=""
probe_to=""
exit "$status"
