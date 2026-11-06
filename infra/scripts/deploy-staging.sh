#!/usr/bin/env bash
# Staging deploy in the order of build prompt 5.4 (factory spec 6): npm run deploy:staging
# Each step is logged to stdout, for ops/releases/D-xxx.md:
#  1. migrate: the expanding migrations on the staging database, when STAGING_DATABASE_URL is set
#     (guard:migrations has checked before the merge that they only expand);
#  2. code: wrangler deploy --env staging --var GIT_SHA:<sha>, flags off;
#  3. bundles: later;  4. flags: later;
#  then check:staging. A failed check exits non-zero, and CI then runs the rollback job (no click).
# Base URL of the check: STAGING_BASE_URL when set, else this deploy's workers.dev URL plus /test (BASE_PATH of
# env.staging in wrangler.jsonc). The step outputs version_id, base_url and trace_id go to GitHub Actions.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

sha="$(git_sha)"
log "deploy-staging: start, commit $sha"

load_dev_var STAGING_DATABASE_URL
if [[ -n "${STAGING_DATABASE_URL:-}" ]]; then
  log "step 1/4 migrate: start"
  DATABASE_URL="$STAGING_DATABASE_URL" DB_SCHEMA="" node infra/scripts/migrate.mjs
  log "step 1/4 migrate: done"
else
  log "step 1/4 migrate: skipped (NOTICE: STAGING_DATABASE_URL is not set)"
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT
log "step 2/4 code: wrangler deploy --env staging (flags stay off)"
WRANGLER_OUTPUT_FILE_PATH="$output" "$CF" deploy --env staging --var "GIT_SHA:$sha"
version_id="$(wrangler_output "$output" deploy version_id)"
log "step 2/4 code: done, version ${version_id:-unknown} is live"
log "step 3/4 bundles: none yet (later)"
log "step 4/4 flags: none yet (later)"

base_url="${STAGING_BASE_URL:-}"
if [[ -z "$base_url" ]]; then
  host="$(wrangler_output "$output" deploy targets | grep -oE '[a-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
  [[ -n "$host" ]] || die "no workers.dev URL in the deploy output; set STAGING_BASE_URL"
  base_url="https://$host/test"
fi
gh_output version_id "${version_id:-}"
gh_output base_url "$base_url"
gh_summary "Staging deploy of \`$sha\`: version \`${version_id:-unknown}\` at $base_url"

log "check: start"
if ! EXPECT_VERSION="$sha" bash "$ROOT/infra/scripts/post-deploy-check.sh" "$base_url"; then
  log "check: FAILED. Roll back with npm run rollback:staging (CI's rollback job does it with no click)"
  exit 1
fi
log "deploy-staging: done, version ${version_id:-unknown} at $base_url"
