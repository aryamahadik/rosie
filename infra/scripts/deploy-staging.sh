#!/usr/bin/env bash
# Staging deploy in the order of build prompt 5.4 (factory spec 6; DL-024):
#   npm run deploy:staging [-- --bundle <bundle folder>]
# Runs on the build Mac with the Rosfield sign-in (cf.sh). Each step is logged to stdout, for
# ops/releases/D-xxx.md:
#  1. migrate: the expanding migrations on the staging database, when STAGING_DATABASE_URL is set
#     (guard:migrations has checked before the merge that they only expand);
#  2. code: wrangler deploy --env staging --var GIT_SHA:<sha>, with --var ROSIE_NUMBER:<number> when that is set
#     in E.164 form (below), flags off;
#  3. bundle: publish-bundle.sh publishes the bundle folder --bundle names (default bundles/v0, D-017's bundle v0):
#     PostgreSQL's copy, the KV bulk file into the BUNDLES namespace, then the active bundle id (T-569);
#  4. flags: flags.sh applies the staging flag set, infra/flags/staging.json, which turns the skeleton flag on
#     (production's set has it off; T-569);
#  then check:staging.
# Steps 3 and 4 need the staging database, which holds the active bundle id and the flags: while
# STAGING_DATABASE_URL is not set (J-06) they are skipped with a notice, as step 1 is.
# The rollback job of 5.4, with no click: before step 2 the script records the version staging runs. If
# anything fails from step 2 on (the deploy, the bundle, the flags, the check, no base URL, unreadable deploy
# output, a signal), it first undoes what steps 4 and 3 did (each flag step 4 turned on goes off again, and the
# active bundle id goes back to the one before, when there was one), then runs rollback-staging.sh back to that
# version and exits non-zero; if staging still runs that version, there is nothing to roll back. If the version
# before is unknown, it goes back to the previous deployment, but only once step 2 has finished. It only goes
# back, and migrations stay in place.
# Base URL of the check: STAGING_BASE_URL when set, else this deploy's workers.dev URL plus /test (BASE_PATH
# of env.staging in wrangler.jsonc).
# Staging only: it takes no --env, and production deploys and flags run only from the protected release job.
# Rosie's own number, staging's Linq line (T-1304; CQ-253 as DL-542 refines it): ROSIE_NUMBER is read
# by name, from the environment, else from the git-ignored .dev.vars (load_dev_var), and kept in rosie_number, a
# variable of the script's own that is never marked for export, so of the deploy's commands only step 2's wrangler
# deploy gets it, as --var ROSIE_NUMBER:<number> (T-1343). A value from the environment leaves it before anything is
# started (dirname, which finds lib.sh, included); a value from .dev.vars leaves it as soon as load_dev_var has read
# it. It is never written in wrangler.jsonc or any tracked file: the repository is public (DL-436). Why a var given at
# deploy:
#  - it is no key: people text it, and every chat link carries it (K-09 issueChatLink's sms: form);
#  - wrangler 4.158 prints a --var's value as "(hidden)" (D-000 check 5's log: env.GIT_SHA ("(hidden)")),
#    and wrangler.jsonc's vars as they are, so the number stays out of the deploy's log;
#  - a deploy keeps no var of the version before (wrangler.jsonc sets no keep_vars), so a deploy without it
#    leaves the Worker without it, and each version, a rollback's target too, keeps the number it was
#    deployed with; a secret, once put, would stay on every later version, and putting one at each deploy
#    would make every deploy a secret write.
# Only a value in E.164 form is given (a + and 7 to 15 digits, nothing else: K-04's handles_address_form,
# K-11's phone). A missing or malformed value deploys without it, and one line says chat links stay off
# (K-05 default 109). The value itself is never printed.
# The staging database's URL (T-1343; read as deploy-preview.sh reads it, T-1310): STAGING_DATABASE_URL, from the
# environment, else from .dev.vars by name (load_dev_var, before step 1), never printed. It leaves this shell's
# environment before anything is started, with DATABASE_URL, which this script never reads, and is kept in
# database_url, never marked for export. Only the commands that use the database get it, each on its own command line:
# step 1's migrate.mjs as DATABASE_URL, and publish-bundle.sh and flags.sh (steps 3 and 4, and their undo) as
# STAGING_DATABASE_URL, which each of them hands on to its own database program alone. No other command gets any
# database URL: git, cf.sh and wrangler, the check and the rollback among them.
# Tracing, allexport and keyword are switched off first, whatever the caller's shell asked for (DL-581, T-1343; as
# cf.sh does, T-1261): bash -x, xtrace handed down in SHELLOPTS, or a BASH_ENV that turns it on never prints the number
# or the URL; allexport would mark rosie_number and database_url for export; and under keyword lib.sh's
# `local name=...` would declare nothing.
set +x
set +a
set +k
set -euo pipefail
# The variables that hold the number or the URL are dropped before they are set: bash marks every variable it inherits
# for export, so one of the same name in the caller's environment would make it an exported one (rosie_number_var too,
# which holds step 2's --var).
unset -v rosie_number rosie_number_var database_url
rosie_number="${ROSIE_NUMBER:-}"
database_url="${STAGING_DATABASE_URL:-}"
unset -v ROSIE_NUMBER STAGING_DATABASE_URL DATABASE_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

bundle_dir="$ROOT/bundles/v0" # D-017's bundle v0 (T-163); --bundle names another bundle folder
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      [[ $# -ge 2 && -n "$2" ]] || die "--bundle needs a bundle folder"
      bundle_dir="$2"
      shift 2
      ;;
    --bundle=?*)
      bundle_dir="${1#*=}"
      shift
      ;;
    --env | --env=*)
      die "refused: deploy-staging.sh deploys staging only and takes no --env: production deploys and flags run" \
        "only from the protected release job, after Jay or the CTO acts from his own login (build prompt 5.4)"
      ;;
    *)
      die "usage: deploy-staging.sh [--bundle <bundle folder>] (default: bundles/v0)"
      ;;
  esac
done
if [[ "$bundle_dir" != /* ]]; then
  bundle_dir="$PWD/$bundle_dir"
fi
cd "$ROOT"

# Rosie's own number (above), from .dev.vars by name when the environment gave none: load_dev_var exports what it
# reads, so the name is unset again at once, before any command is started.
# E164 is the form K-04's handles_address_form and K-11's phone write a number in.
E164='^[+][1-9][0-9]{6,14}$'
if [[ -z "$rosie_number" ]]; then
  load_dev_var ROSIE_NUMBER
  rosie_number="${ROSIE_NUMBER:-}"
  unset -v ROSIE_NUMBER
fi

sha="$(git_sha)"
log "deploy-staging: start, commit $sha"

work="$(mktemp -d)"
before=""   # the version staging ran before this deploy (empty: unknown)
started=""  # set when step 2 starts: from then on, a failure rolls back
deployed="" # set when step 2 has finished
base_url="${STAGING_BASE_URL:-}"
bundle_record="$work/bundle.json" # step 3's switch: {"before": <id or null>, "after": <id>}
flags_record="$work/flags-on.txt" # each flag step 4 turned on, one per line

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

# record_field <before|after>: that field of step 3's record; prints nothing for null.
record_field() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (typeof value === "string") console.log(value);
  ' "$bundle_record" "$1"
}

# undo_release: build prompt 5.4's "undo what can be undone" for steps 4 and 3, run from the exit trap before the
# code goes back: each flag step 4 turned on goes off again (flag off), then the active bundle id goes back to the
# one before step 3 (the previous bundle id). Returns non-zero when something could not be undone; each such line
# says what to run. flags.sh and publish-bundle.sh get the staging database's URL on their command lines alone (above).
undo_release() {
  local failed=0 flag id_before id_after
  if [[ -s "$flags_record" ]]; then
    while IFS= read -r flag; do
      [[ -n "$flag" ]] || continue
      log "undo: flag $flag off again (step 4 turned it on)"
      if ! STAGING_DATABASE_URL="$database_url" bash "$ROOT/infra/scripts/flags.sh" --env staging off "$flag"; then
        log "undo: FAILED to turn the flag $flag off: run bash infra/scripts/flags.sh off $flag now"
        failed=1
      fi
    done <"$flags_record"
  fi
  if [[ -s "$bundle_record" ]]; then
    id_before="$(record_field before)" || id_before="unreadable"
    id_after="$(record_field after)" || id_after="unreadable"
    if [[ -z "$id_before" ]]; then
      log "undo: the active bundle id stays $id_after: no bundle was active before this deploy, and K-05 has no" \
        "call that clears it"
    elif [[ "$id_before" == "unreadable" || "$id_after" == "unreadable" ]]; then
      log "undo: FAILED to read step 3's switch: run bash infra/scripts/publish-bundle.sh --status, then" \
        "--activate the bundle id staging had before this deploy"
      failed=1
    elif [[ "$id_before" != "$id_after" ]]; then
      log "undo: the active bundle id goes back to $id_before (step 3 switched it to $id_after)"
      if ! STAGING_DATABASE_URL="$database_url" bash "$ROOT/infra/scripts/publish-bundle.sh" --env staging \
        --activate "$id_before"; then
        log "undo: FAILED to switch the active bundle id back: run" \
          "bash infra/scripts/publish-bundle.sh --activate $id_before now"
        failed=1
      fi
    fi
  fi
  return "$failed"
}

finish() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && -n "$started" ]]; then
    log "deploy-staging: FAILED (exit $status) after step 2 started; undoing steps 4 and 3, then rolling back" \
      "the code, with no click"
    undo_release || true
    roll_back || true
    status=1
  fi
  # The undo above is the last use of the staging database's URL: it is dropped.
  database_url=""
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT
# A deploy stopped by a signal counts as failed too (bash would otherwise run the exit trap with status 0).
trap 'exit 130' INT
trap 'exit 143' TERM

# The staging database's URL (above), from .dev.vars by name when the environment gave none: load_dev_var exports what
# it reads, so the name is unset again at once, before any command is started.
if [[ -z "$database_url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  database_url="${STAGING_DATABASE_URL:-}"
  unset -v STAGING_DATABASE_URL
fi
if [[ -n "$database_url" && ! -f "$bundle_dir/manifest.json" && ! -f "$bundle_dir/bundle/manifest.json" ]]
then
  die "$bundle_dir holds no bundle (no manifest.json in it or in its bundle/ folder): nothing was deployed"
fi
if [[ -n "$database_url" ]]; then
  log "step 1/4 migrate: start"
  DATABASE_URL="$database_url" DB_SCHEMA="" node infra/scripts/migrate.mjs
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

# Step 2's var for Rosie's own number (above): given only in E.164 form, and its value never printed.
rosie_number_var=()
if [[ -z "$rosie_number" ]]; then
  log "step 2/4 code: NOTICE: ROSIE_NUMBER is not set, so the Worker gets no number and chat links" \
    "stay off (K-05 default 109)"
elif [[ "$rosie_number" =~ $E164 ]]; then
  rosie_number_var=(--var "ROSIE_NUMBER:$rosie_number")
  log "step 2/4 code: ROSIE_NUMBER goes to the Worker by name, as a var (wrangler prints its value as" \
    "(hidden))"
else
  log "step 2/4 code: NOTICE: ROSIE_NUMBER is not in E.164 form (a + and 7 to 15 digits), so the Worker" \
    "gets no number and chat links stay off (K-05 default 109); the value is not printed"
fi

started=1
output="$work/deploy.ndjson"
log "step 2/4 code: wrangler deploy --env staging (flags stay off)"
WRANGLER_OUTPUT_FILE_PATH="$output" "$CF" deploy --env staging --var "GIT_SHA:$sha" \
  ${rosie_number_var[@]+"${rosie_number_var[@]}"}
deployed=1
version_id="$(wrangler_output "$output" deploy version_id)"
log "step 2/4 code: done, version ${version_id:-unknown} is live"

# The check's base URL, known before steps 3 and 4 change anything.
if [[ -z "$base_url" ]]; then
  host="$(wrangler_output "$output" deploy targets | grep -oE '[a-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
  [[ -n "$host" ]] || die "no workers.dev URL in the deploy output; set STAGING_BASE_URL"
  base_url="https://$host/test"
fi

if [[ -n "$database_url" ]]; then
  log "step 3/4 bundle: publish $bundle_dir, then switch the active bundle id"
  STAGING_DATABASE_URL="$database_url" bash "$ROOT/infra/scripts/publish-bundle.sh" --env staging \
    --record "$bundle_record" "$bundle_dir"
  log "step 3/4 bundle: done"
  log "step 4/4 flags: the staging flag set, infra/flags/staging.json"
  STAGING_DATABASE_URL="$database_url" bash "$ROOT/infra/scripts/flags.sh" --env staging apply --record "$flags_record"
  log "step 4/4 flags: done"
else
  log "step 3/4 bundle: skipped (NOTICE: STAGING_DATABASE_URL is not set; the staging database holds the active" \
    "bundle id, J-06)"
  log "step 4/4 flags: skipped (NOTICE: STAGING_DATABASE_URL is not set; the staging database holds the flags," \
    "J-06; meanwhile the Worker binds no flags, so every flag reads off)"
fi

log "check: start"
if ! EXPECT_VERSION="$sha" bash "$ROOT/infra/scripts/post-deploy-check.sh" "$base_url"; then
  log "check: FAILED at $base_url"
  exit 1
fi
log "deploy-staging: done, version ${version_id:-unknown} at $base_url"
