#!/usr/bin/env bash
# Spike T-1124: the run script. One step per call, on the build Mac (README.md has the order and what each prints):
#   bash infra/spikes/hyperdrive-host/run.sh status        reads: is rosie-staging-hyperdrive there, its id, its caching
#   bash infra/spikes/hyperdrive-host/run.sh local         the probe in wrangler dev's local Hyperdrive stand-in,
#                                                          against the local rosie-pg (nothing at Cloudflare)
#   bash infra/spikes/hyperdrive-host/run.sh create        creates rosie-staging-hyperdrive, caching disabled, only
#                                                          when the list does not show it; prints its id
#   bash infra/spikes/hyperdrive-host/run.sh probe         the probe on Cloudflare through the binding, as a
#                                                          wrangler dev --remote session: no deploy, no version
#   bash infra/spikes/hyperdrive-host/run.sh probe-upload  the fallback if a remote session cannot bind Hyperdrive:
#                                                          a version of rosie-staging uploaded under the preview
#                                                          alias spike-hyperdrive, never deployed
#
# Limits it keeps (the card's lead note, DL-476):
#  - Wrangler runs only through infra/scripts/cf.sh (the Rosfield sign-in, the pinned account), never with --name or
#    --config, and with no --env but staging. Nothing is deleted. No `deploy`: the Worker rosie-staging serves, its
#    routes, its cron, its queues and its bindings are never changed.
#  - The probe's Worker runs from a wrangler config this script writes to a temporary folder and hands to cf.sh as
#    CF_BUILD_DIR, as deploy-preview.sh does. cf.sh checks that file as it checks its own (the Rosfield account, and
#    env.staging.name exactly rosie-staging). The checkout's wrangler.jsonc is never read or written here.
#  - The database URL is used by `create` alone. lib.sh's load_dev_var reads STAGING_DATABASE_URL by name; this
#    script takes it out of its environment at once and keeps it in one shell variable. It travels to: cf.sh and
#    wrangler as the one --connection-string argument (wrangler has no other way to take it), from wrangler to
#    Cloudflare's API over HTTPS, and to two short node processes in their environment (never as an argument): one
#    reads the host's name to refuse a pooled host, one removes the URL from wrangler's output when the create
#    fails. It is never printed, logged, echoed or written to a file, and this script refuses to run under xtrace.
#  - `probe` and `probe-upload` never see the database URL: the Worker gets it from the Hyperdrive binding.
#  - Every probe table lives in the schema spike_hyperdrive; the probe drops it at the end, on failure too, and
#    this script then asks the Worker once more to drop it if it is still there.
#
# PROBE_COMMITS (default 60, at least 50): timed commits per shape. PROBE_PORT (default 8799): wrangler dev's port.
set -euo pipefail
if [[ "$-" == *x* || "${SHELLOPTS:-}" == *xtrace* ]]; then
  echo "run.sh: refused: xtrace (set -x) is on; it would print the database URL" >&2
  exit 1
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../../scripts/lib.sh"

NAME="rosie-staging-hyperdrive"
ALIAS="spike-hyperdrive"
# The Rosfield account: cf.sh pins the same id and refuses a config that names another.
ACCOUNT_ID="ecb06e7bc9129fa81104d331e9652362"
# The local Docker database of infra/docker-compose.yml: local only, not a secret (db/README.md).
LOCAL_DATABASE_URL="postgres://rosie:rosie@127.0.0.1:54329/rosie"
COMMITS="${PROBE_COMMITS:-60}"
PORT="${PROBE_PORT:-8799}"
[[ "$COMMITS" =~ ^[0-9]+$ ]] || die "PROBE_COMMITS must be a whole number"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PROBE_PORT must be a whole number"

work=""
dev_pid=""
token=""

finish() {
  local status=$?
  trap - EXIT
  if [[ -n "$dev_pid" ]]; then
    # wrangler dev runs in its own process group (set -m below), so workerd and esbuild stop with it.
    kill -TERM -- "-$dev_pid" 2>/dev/null || kill -TERM "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
  fi
  if [[ -n "$work" ]]; then
    rm -rf "$work"
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# show_log <file>: the last lines of one of wrangler's logs, with this run's probe token removed.
show_log() {
  [[ -f "$1" ]] || return 0
  tail -n 40 "$1" | PROBE_REDACT="$token" node "$HERE/redact.mjs" >&2 || true
}

# Prints "<id><tab><caching>" for the Hyperdrive configuration named $1, or nothing when there is none. `hyperdrive
# list` prints the account's configurations as a table (cells between "│", with an "id" and a "name" column), and no
# table when there are none. The table's other cells (each origin's host, user and database) are read here and never
# printed; the caching cell is printed as wrangler shows it, or "?" when the table has no such column.
hyperdrive_row() {
  local listing status=0
  listing="$(bash "$CF" hyperdrive list)" ||
    die "could not list the Hyperdrive configurations (wrangler's error is above): does the sign-in cover Hyperdrive?"
  node "$HERE/helpers.mjs" row "$1" <<<"$listing" || status=$?
  case "$status" in
    0) ;;
    3) die "more than one Hyperdrive configuration is named $1" ;;
    *) die "could not read the Hyperdrive list (its text is not shown: it names each origin's host and user)" ;;
  esac
}

# The id of the version that serves the most staging traffic now, or nothing when wrangler cannot tell (a read, as
# deploy-staging.sh's live_version).
live_version() {
  local text
  text="$(bash "$CF" deployments status --env staging --json 2>/dev/null)" || return 0
  node "$HERE/helpers.mjs" live-version <<<"$text" || true
}

# same_version <before> <after>: the proof that a probe left staging alone. Fails when the version that serves staging
# is not the one that served before the probe.
same_version() {
  if [[ -z "$1" || -z "$2" ]]; then
    log "staging: NOTICE: the serving version could not be read (before: ${1:-unknown}, after: ${2:-unknown});" \
      "check with: npm run cf -- deployments status --env staging"
    return 0
  fi
  if [[ "$1" != "$2" ]]; then
    log "staging: the serving version CHANGED during the probe: $1 before, $2 after. The probe deploys nothing, so" \
      "look for another deploy in that time: npm run cf -- deployments status --env staging"
    return 1
  fi
  log "staging: still serves version $2, the same as before the probe"
}

step_status() {
  local row
  row="$(hyperdrive_row "$NAME")"
  if [[ -z "$row" ]]; then
    log "status: no Hyperdrive configuration is named $NAME on the Rosfield account"
  else
    log "status: $NAME exists: id ${row%%$'\t'*}, caching ${row#*$'\t'}"
  fi
}

step_create() {
  local row url kind created status=0
  row="$(hyperdrive_row "$NAME")"
  if [[ -n "$row" ]]; then
    log "create: $NAME already exists: not created again (id ${row%%$'\t'*}, caching ${row#*$'\t'})"
    return 0
  fi
  load_dev_var STAGING_DATABASE_URL
  url="${STAGING_DATABASE_URL:-}"
  # From here the value is in one shell variable, not in the environment a child process is given.
  unset STAGING_DATABASE_URL
  [[ -n "$url" ]] || die "STAGING_DATABASE_URL is not set: run this from the code folder, which holds it by name"
  kind="$(PROBE_URL="$url" node "$HERE/helpers.mjs" host-kind)" ||
    die "STAGING_DATABASE_URL is not a postgres:// URL (its value is not shown)"
  if [[ "$kind" == "pooled" && "${PROBE_ALLOW_POOLED:-}" != "1" ]]; then
    die "refused: STAGING_DATABASE_URL names a pooled host (-pooler). Cloudflare's Neon page says to give Hyperdrive" \
      "the direct connection string (connection pooling unchecked), and a configuration cannot be removed through" \
      "cf.sh. Nothing was created. To create it on the pooled host anyway, rerun with PROBE_ALLOW_POOLED=1"
  fi
  log "create: $NAME does not exist: creating it with caching disabled (ADR-007)"
  # --update-config=false: wrangler never writes a wrangler config from here. Its output is kept, not shown.
  # WRANGLER_LOG_SANITIZE=true (wrangler's default, held here): its debug log leaves out every request body.
  # WRANGLER_SEND_METRICS=false: no usage event is sent for this call.
  created="$(WRANGLER_LOG_SANITIZE=true WRANGLER_SEND_METRICS=false bash "$CF" hyperdrive create "$NAME" \
    "--connection-string=$url" --caching-disabled --update-config=false 2>&1)" || status=$?
  if [[ "$status" -ne 0 ]]; then
    printf '%s\n' "$created" | PROBE_REDACT="$url" node "$HERE/redact.mjs" >&2 || true
    url=""
    die "wrangler could not create $NAME (exit $status; its output is above, with the database URL, password, user" \
      "and host removed)"
  fi
  url=""
  row="$(hyperdrive_row "$NAME")"
  [[ -n "$row" ]] || die "wrangler reported success, but no Hyperdrive configuration is named $NAME"
  log "create: $NAME created: id ${row%%$'\t'*}, caching ${row#*$'\t'}"
  log "create: T-567 binds this id in wrangler.jsonc's env.staging (binding HYPERDRIVE) by a reviewed change"
}

# write_config <local|remote> <Hyperdrive id>: the spike's own wrangler config, in the temporary folder. Its top-level
# name is no Worker that exists (every call here names --env staging); env.staging.name is what cf.sh requires.
write_config() {
  node "$HERE/helpers.mjs" config "$work/wrangler.jsonc" "$HERE/worker.mjs" "$ACCOUNT_ID" "$1" "$2" \
    "$LOCAL_DATABASE_URL"
}

new_token() {
  node "$HERE/helpers.mjs" token
}

# wait_ready <base URL> <seconds>: until the probe's own Worker answers /ready with this run's token.
wait_ready() {
  local base="$1" tries="$2" i body
  for ((i = 0; i < tries; i++)); do
    if [[ -n "$dev_pid" ]] && ! kill -0 "$dev_pid" 2>/dev/null; then
      return 1
    fi
    body="$(curl --silent --fail --max-time 10 --header "x-probe-token: $token" "$base/ready" 2>/dev/null)" || body=""
    if [[ "$body" == *'"ready": true'* && "$body" == *'T-1124 hyperdrive-host'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# call_probe <base URL>: runs the probe, prints its JSON, asks for the cleanup, and returns 0 only when the probe's
# own verdict is ok.
call_probe() {
  local base="$1" code
  log "probe: running ($COMMITS timed commits per shape); this can take a few minutes"
  code="$(curl --silent --show-error --max-time 900 --header "x-probe-token: $token" \
    --output "$work/result.json" --write-out '%{http_code}' "$base/probe?commits=$COMMITS")" || code="none (curl failed)"
  log "probe: HTTP $code; the probe's result:"
  if [[ -s "$work/result.json" ]]; then
    cat "$work/result.json"
  else
    log "probe: no result came back"
  fi
  log "cleanup: asking the Worker to drop the schema spike_hyperdrive if it is still there:"
  curl --silent --show-error --max-time 120 --header "x-probe-token: $token" "$base/cleanup" ||
    log "cleanup: FAILED to reach the Worker: check for the schema spike_hyperdrive on the database by hand"
  [[ "$code" == "200" ]] || return 1
  node "$HERE/helpers.mjs" verdict "$work/result.json"
}

# step_dev <local|remote>: the probe's Worker as a wrangler dev session, then the probe through it.
step_dev() {
  local mode="$1" id="00000000000000000000000000000000" row base="http://127.0.0.1:$PORT" before="" passed=1
  local args=(dev --env staging --ip 127.0.0.1 "--port=$PORT" --show-interactive-dev-session=false)
  if [[ "$mode" == "remote" ]]; then
    row="$(hyperdrive_row "$NAME")"
    [[ -n "$row" ]] || die "no Hyperdrive configuration is named $NAME: run the create step first"
    id="${row%%$'\t'*}"
    args+=(--remote)
    log "probe: $NAME is id $id, caching ${row#*$'\t'}"
    before="$(live_version)"
    log "staging: serves version ${before:-unknown} before the probe"
  fi
  if curl --silent --output /dev/null --max-time 2 "$base/"; then
    die "port $PORT on 127.0.0.1 already answers: set PROBE_PORT to a free port"
  fi
  work="$(mktemp -d)"
  token="$(new_token)"
  write_config "$mode" "$id"
  args+=(--var "PROBE_TOKEN:$token")
  log "$mode: starting wrangler dev through cf.sh from a temporary config (no deploy; the session ends with this script)"
  set -m
  CF_BUILD_DIR="$work" bash "$CF" "${args[@]}" </dev/null >"$work/dev.log" 2>&1 &
  dev_pid=$!
  set +m
  if ! wait_ready "$base" 120; then
    show_log "$work/dev.log"
    die "wrangler dev did not answer on $base within 120 s (the end of its log is above)"
  fi
  log "$mode: the probe's Worker answers on $base"
  call_probe "$base" || passed=0
  if [[ "$mode" == "remote" ]]; then
    same_version "$before" "$(live_version)" || passed=0
  fi
  if [[ "$passed" -ne 1 ]]; then
    show_log "$work/dev.log"
    die "the probe did not pass (its result and the end of wrangler's log are above)"
  fi
  log "$mode: done, the probe passed and its schema is dropped"
}

# The fallback: a version of rosie-staging that only this script's requests can run, for 15 minutes. An upload is
# not a deploy: staging's traffic, routes, cron and queues stay on the version that serves now.
step_upload() {
  local row id expires output url version before passed=1
  row="$(hyperdrive_row "$NAME")"
  [[ -n "$row" ]] || die "no Hyperdrive configuration is named $NAME: run the create step first"
  id="${row%%$'\t'*}"
  before="$(live_version)"
  log "staging: serves version ${before:-unknown} before the probe"
  work="$(mktemp -d)"
  token="$(new_token)"
  expires="$((($(date +%s) + 900) * 1000))"
  write_config remote "$id"
  output="$work/upload.ndjson"
  log "probe-upload: uploading a version of rosie-staging with alias $ALIAS (cf.sh, versions upload; not a deploy)"
  if ! WRANGLER_OUTPUT_FILE_PATH="$output" CF_BUILD_DIR="$work" bash "$CF" versions upload --env staging \
    --preview-alias "$ALIAS" --tag "spike-t1124" --message "T-1124 Hyperdrive probe, uploaded only" \
    --var "PROBE_TOKEN:$token" --var "PROBE_EXPIRES:$expires" </dev/null >"$work/upload.log" 2>&1; then
    show_log "$work/upload.log"
    die "wrangler did not upload the version (the end of its output is above); nothing serves it"
  fi
  [[ -f "$output" ]] || die "wrangler wrote no upload record"
  version="$(wrangler_output "$output" version-upload version_id)"
  url="$(wrangler_output "$output" version-upload preview_alias_url)"
  if [[ -z "$url" ]]; then
    url="$(wrangler_output "$output" version-upload preview_url)"
  fi
  [[ -n "$url" ]] || die "wrangler reported no preview URL for version ${version:-unknown}"
  url="${url%/}"
  log "probe-upload: version ${version:-unknown} uploaded, not deployed; it refuses every request after 15 minutes"
  log "probe-upload: preview URL $url"
  if ! wait_ready "$url" 90; then
    same_version "$before" "$(live_version)" || true
    die "the preview did not answer /ready within 90 s"
  fi
  call_probe "$url" || passed=0
  same_version "$before" "$(live_version)" || passed=0
  [[ "$passed" -eq 1 ]] || die "the probe did not pass (its result is above)"
  log "probe-upload: done, the probe passed and its schema is dropped"
}

case "${1:-}" in
  status) step_status ;;
  create) step_create ;;
  local) step_dev local ;;
  probe) step_dev remote ;;
  probe-upload) step_upload ;;
  *) die "usage: run.sh status | local | create | probe | probe-upload (README.md has the order)" ;;
esac
