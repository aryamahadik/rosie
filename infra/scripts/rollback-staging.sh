#!/usr/bin/env bash
# Back-only rollback of staging (factory spec 6; build prompt 5.4): npm run rollback:staging [-- <version-id>]
# With no version id: the newest earlier deployment whose version is older than the live one. A given version id
# must be older than the live version. It never goes forward, and it leaves migrations in place.
# Prints what it rolled back to, then runs check:staging against STAGING_BASE_URL.
# ROLLBACK_REASON (optional) becomes the rollback message.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

[[ $# -le 1 ]] || die "usage: rollback-staging.sh [version-id]"
requested="${1:-}"
reason="${ROLLBACK_REASON:-rollback}"
reason="${reason:0:100}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# json <file> <JavaScript expression over `data`>: prints the result; wrangler's --json output may follow other
# lines, so parsing starts at the first line that opens an array or an object.
json() {
  node -e '
    const [file, expression] = process.argv.slice(1);
    const text = require("node:fs").readFileSync(file, "utf8");
    const start = text.search(/^[\[{]/m);
    if (start < 0) { console.error("no JSON in the wrangler output"); process.exit(1); }
    const data = JSON.parse(text.slice(start));
    const result = new Function("data", `return (${expression});`)(data);
    if (result !== undefined && result !== null) console.log(Array.isArray(result) ? result.join("\n") : String(result));
  ' "$1" "$2"
}

# created_on <version id>: when that version was uploaded (ISO 8601, so it sorts as text).
created_on() {
  "$CF" versions view "$1" --env staging --json >"$work/version.json"
  json "$work/version.json" 'data.metadata.created_on'
}

"$CF" deployments status --env staging --json >"$work/status.json"
live="$(json "$work/status.json" \
  '[...data.versions].sort((a, b) => b.percentage - a.percentage)[0].version_id')"
live_created="$(created_on "$live")"
log "rollback: live version $live (uploaded $live_created)"

target=""
target_created=""
if [[ -n "$requested" ]]; then
  target_created="$(created_on "$requested")"
  if [[ ! "$target_created" < "$live_created" ]]; then
    die "refusing: version $requested is not older than the live version $live (a rollback only goes back)"
  fi
  target="$requested"
else
  "$CF" deployments list --env staging --json >"$work/deployments.json"
  candidates="$(json "$work/deployments.json" '[...new Set([...data]
    .sort((a, b) => b.created_on.localeCompare(a.created_on))
    .flatMap((d) => d.versions.filter((v) => v.percentage === 100).map((v) => v.version_id)))]')"
  for candidate in $candidates; do
    [[ "$candidate" != "$live" ]] || continue
    candidate_created="$(created_on "$candidate")"
    if [[ "$candidate_created" < "$live_created" ]]; then
      target="$candidate"
      target_created="$candidate_created"
      break
    fi
  done
  [[ -n "$target" ]] || die "no earlier deployment has a version older than the live one; nothing to go back to"
fi

log "rollback: to version $target (uploaded $target_created); migrations stay in place"
"$CF" rollback "$target" --env staging --message "$reason" --yes
log "rollback: done, live version is now $target"

[[ -n "${STAGING_BASE_URL:-}" ]] ||
  die "rolled back, but STAGING_BASE_URL is not set, so check:staging could not run"
bash "$ROOT/infra/scripts/post-deploy-check.sh" "$STAGING_BASE_URL"
