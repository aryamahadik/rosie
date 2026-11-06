#!/usr/bin/env bash
# Staging deploy in the order of build prompt 5.4 (factory spec 6; DL-024): npm run deploy:staging
# Runs on the build Mac with the Rosfield sign-in (cf.sh). Each step is logged to stdout, for
# ops/releases/D-xxx.md:
#  1. migrate: the expanding migrations on the staging database, when STAGING_DATABASE_URL is set
#     (guard:migrations has checked before the merge that they only expand);
#  2. code: wrangler deploy --env staging --var GIT_SHA:<sha>, flags off;
#  3. bundles: later;  4. flags: later;
#  then check:staging.
# The rollback job of 5.4, with no click: before step 2 the script records the version staging runs. If
# anything fails from step 2 on (the deploy, the check, no base URL, unreadable deploy output, a signal), it
# runs rollback-staging.sh back to that version and exits non-zero; if staging still runs that version,
# there is nothing to roll back. If the version before is unknown, it goes back to the previous deployment,
# but only once step 2 has finished. It only goes back, and migrations stay in place.
# Base URL of the check: STAGING_BASE_URL when set, else this deploy's workers.dev URL plus /test (BASE_PATH
# of env.staging in wrangler.jsonc).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

sha="$(git_sha)"
log "deploy-staging: start, commit $sha"

work="$(mktemp -d)"
before=""   # the version staging ran before this deploy (empty: unknown)
started=""  # set when step 2 starts: from then on, a failure rolls back
deployed="" # set when step 2 has finished
base_url="${STAGING_BASE_URL:-}"

# live_version: the version id serving the most staging traffic now; prints nothing if wrangler cannot tell.
live_version() {
  "$CF" deployments status --env staging --json >"$work/status.json" || return 0
  node -e '
    const text = require("node:fs").readFileSync(process.argv[1], "utf8");
    try {
      const status = JSON.parse(text.slice(text.search(/^\{/m), text.lastIndexOf("}") + 1));
      const top = [...(status.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
      const id = top?.version_id ?? "";
      if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) console.log(id);
    } catch {}
  ' "$work/status.json" || true
}

# roll_back: the no-click rollback after a failed deploy (run from the exit trap). Returns non-zero when
# staging may not be back on a checked version.
roll_back() {
  local live
  live="$(live_version)"
  if [[ -n "$before" && "$live" == "$before" ]]; then
    log "rollback: nothing to roll back, staging still runs $before (the version before this deploy)"
    return 0
  fi
  if [[ -z "$before" && -z "$deployed" ]]; then
    log "rollback: NOT RUN: the version before this deploy is unknown and step 2 did not finish, so" \
      "going back could pass a version this deploy never replaced. Check:" \
      "npm run cf -- deployments status --env staging; then, if needed: npm run rollback:staging"
    return 1
  fi
  log "rollback: staging runs ${live:-an unknown version}; going back to ${before:-the previous deployment}" \
    "(no click; migrations stay in place)"
  if STAGING_BASE_URL="$base_url" EXPECT_VERSION="" ROLLBACK_REASON="staging deploy of $sha failed" \
    bash "$ROOT/infra/scripts/rollback-staging.sh" ${before:+"$before"}; then
    log "rollback: done, staging is back on ${before:-the previous deployment} and its check passed"
    return 0
  fi
  live="$(live_version)"
  if [[ -n "$before" && "$live" == "$before" ]]; then
    log "rollback: staging is back on $before, but its check failed or could not run (see above)"
  else
    log "rollback: FAILED, staging runs ${live:-an unknown version}: run npm run rollback:staging now"
  fi
  return 1
}

finish() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && -n "$started" ]]; then
    log "deploy-staging: FAILED (exit $status) after step 2 started; rolling back with no click"
    roll_back || true
    status=1
  fi
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT
# A deploy stopped by a signal counts as failed too (bash would otherwise run the exit trap with status 0).
trap 'exit 130' INT
trap 'exit 143' TERM

load_dev_var STAGING_DATABASE_URL
if [[ -n "${STAGING_DATABASE_URL:-}" ]]; then
  log "step 1/4 migrate: start"
  DATABASE_URL="$STAGING_DATABASE_URL" DB_SCHEMA="" node infra/scripts/migrate.mjs
  log "step 1/4 migrate: done"
else
  log "step 1/4 migrate: skipped (NOTICE: STAGING_DATABASE_URL is not set)"
fi

before="$(live_version)"
if [[ -n "$before" ]]; then
  log "before: staging runs version $before (a failed deploy goes back to it)"
else
  log "before: NOTICE: no live staging version could be read (a first deploy?); if this deploy fails" \
    "after step 2 finishes, it goes back to the previous deployment"
fi

started=1
output="$work/deploy.ndjson"
log "step 2/4 code: wrangler deploy --env staging (flags stay off)"
WRANGLER_OUTPUT_FILE_PATH="$output" "$CF" deploy --env staging --var "GIT_SHA:$sha"
deployed=1
version_id="$(wrangler_output "$output" deploy version_id)"
log "step 2/4 code: done, version ${version_id:-unknown} is live"
log "step 3/4 bundles: none yet (later)"
log "step 4/4 flags: none yet (later)"

if [[ -z "$base_url" ]]; then
  host="$(wrangler_output "$output" deploy targets | grep -oE '[a-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
  [[ -n "$host" ]] || die "no workers.dev URL in the deploy output; set STAGING_BASE_URL"
  base_url="https://$host/test"
fi

log "check: start"
if ! EXPECT_VERSION="$sha" bash "$ROOT/infra/scripts/post-deploy-check.sh" "$base_url"; then
  log "check: FAILED at $base_url"
  exit 1
fi
log "deploy-staging: done, version ${version_id:-unknown} at $base_url"
