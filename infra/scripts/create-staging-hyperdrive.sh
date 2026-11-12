#!/usr/bin/env bash
# Staging's two Hyperdrive configurations, each storing one of the Worker's own logins (ADR-014 section 4's piece 2;
# T-1252; the name T-567's card held):
#   npm run hyperdrive:staging:create   (bash infra/scripts/create-staging-hyperdrive.sh; it takes no argument)
# The user runs it, from the rosie folder, once the card has merged and while no agent runs (ADR-014 section 4, "Live
# steps"; DL-482, DL-486, DL-497): it sets each login's password in PostgreSQL and stores it in Cloudflare.
#   rosie-staging-hyperdrive-job  stores rosie_worker_job (inherits rosie_job), for HYPERDRIVE_JOB
#   rosie-staging-hyperdrive-app  stores rosie_worker_app (inherits rosie_app), for HYPERDRIVE_APP
# This file readies the shell and starts one Node process, create-staging-hyperdrive.mjs, which does the rest; its top
# says what it does, prints and refuses. No password exists until that process makes one, and none ever leaves it but
# in ALTER ROLE over its own database connection and in the body of one HTTPS request to Cloudflare's API: never in an
# argument, an environment variable, a file, a log or the output.
# The database is staging's: STAGING_DATABASE_URL, from the environment, else from .dev.vars by name (lib.sh's
# load_dev_var), never printed. It leaves this shell's environment before anything is started (dirname included), is
# kept in one variable that is never marked for export, and goes to node alone, in its environment, as migrate.mjs and
# the seed runner get theirs; node takes it out at once and starts nothing that finds it there. DATABASE_URL, which
# this script never reads, leaves the environment too, so no copy of a database URL reaches anything started here.
# Exit: 0 both configurations exist, store their logins and have caching disabled; 1 refused, failed or not so (the
# line before says why); 2 misuse (any argument), found before anything is read.
set +x
set +a
set +k
set -euo pipefail
# Tracing, allexport and keyword are switched off above, whatever the caller's shell asked for. And no variable of this
# script, or of lib.sh's load_dev_var, starts out marked for export or holding the caller's text: bash marks every
# variable it inherits for export, and a local takes the mark of the variable of the same name outside it, so a name
# of the same spelling in the caller's environment would go to node, and to everything node starts, with whatever it
# held here (as make-staging-secrets.sh explains, T-1236). Each name is dropped before anything is read or sourced:
# USAGE and url (this script's own), and name, file, line, value and BASH_REMATCH (load_dev_var's, the last where its
# match leaves what it read). A new variable, here or in load_dev_var, goes on this line too:
# create-staging-hyperdrive.test.mjs fails until it does.
unset -v USAGE url name file line value BASH_REMATCH
url="${STAGING_DATABASE_URL-}"
unset -v STAGING_DATABASE_URL DATABASE_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

USAGE="usage: create-staging-hyperdrive.sh   (no arguments: it makes rosie-staging-hyperdrive-job and -app, each only when missing)"
if [[ $# -gt 0 ]]; then
  url=""
  printf '%s: %s\n%s\n' "$(basename "$0")" "it takes no arguments (they are never echoed)" "$USAGE" >&2
  exit 2
fi

if [[ -z "$url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  url="${STAGING_DATABASE_URL-}"
  unset -v STAGING_DATABASE_URL
fi
STAGING_DATABASE_URL="$url" exec node "$ROOT/infra/scripts/create-staging-hyperdrive.mjs"
