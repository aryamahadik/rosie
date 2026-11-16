#!/usr/bin/env bash
# The real model times spike (T-362; the lead note DL-860 on the card): p50 and p95 per stage and model, through the AI
# gateway's client and spans, beside arch 04's budgets.
#   bash ai/spikes/model-times/run.sh --dry-run [--out <folder>]
#       every unit against the local stub on 127.0.0.1 (stub.mjs): no key is read, nothing leaves the Mac.
#   bash ai/spikes/model-times/run.sh --live
#       the one live run: at most 40 smoke-size calls in all to Anthropic's Messages endpoint, never in CI. run.mjs keeps
#       the count on disk: it holds runs/ alone (runs/live.lock) and puts each call in runs/sent.jsonl before it goes
#       out, so a run stopped at any point leaves every call it sent counted.
#
# The key, read by name and never printed (the lead note, item 1): ANTHROPIC_API_KEY from the environment, else (a live
# run alone) from the git-ignored .dev.vars at the checkout's root through infra/scripts/lib.sh's load_dev_var, as
# seed-staging.sh reads its names. It goes into a variable of this script's own, never exported, and its name leaves the
# environment at once, before any command is started. It reaches the Node half (run.mjs) on its standard input alone,
# written there by printf, a builtin: never in any command's arguments or environment (no here-string: bash 3.2 makes
# one a temporary file). A dry run reads no key at all and drops one the environment holds.
#
# Exit: run.mjs's (0 the run ran; 1 a dry run's unit did not answer; 2 refused: misuse, CI, no key, runs/ held, the
# cap).
set +x
set +a
set +k
set -euo pipefail
# No variable of this script starts out holding the caller's text; lib.sh's ROOT and CF and load_dev_var's names go too.
unset -v mode key status here ROOT CF name file line value BASH_REMATCH
key="${ANTHROPIC_API_KEY:-}"
unset -v ANTHROPIC_API_KEY

misuse() {
  printf 'run.sh: misuse: %s\n' "$1" >&2
  printf '%s\n' "usage: bash ai/spikes/model-times/run.sh --dry-run [--out <folder>] | --live" >&2
  key=""
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

if [[ -n "${CI:-}" ]]; then
  key=""
  printf '%s\n' "run.sh: refused: CI is set; this spike never runs in CI (T-362, J-02)" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/../../../infra/scripts/lib.sh"

if [[ "$mode" == "--live" ]]; then
  # load_dev_var exports what it reads, so the value goes into the script's own variable and its name leaves the
  # environment again at once, before any command is started.
  if [[ -z "$key" ]]; then
    load_dev_var ANTHROPIC_API_KEY
    key="${ANTHROPIC_API_KEY:-}"
    unset -v ANTHROPIC_API_KEY
  fi
  # What load_dev_var's match left in BASH_REMATCH (a line's value) is overwritten by a match of nothing.
  [[ "" =~ ^$ ]]
else
  key=""
fi

# The key on the Node half's standard input alone (printf is a builtin, so no command's arguments hold it); the rest of
# the command line goes to it as given, never echoed.
status=0
printf '%s\n' "$key" | node "$here/run.mjs" "$mode" ${1+"$@"} || status=$?
key=""
exit "$status"
