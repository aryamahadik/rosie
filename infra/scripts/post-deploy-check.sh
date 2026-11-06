#!/usr/bin/env bash
# Post-deploy check (factory spec 3 and 6): npm run check:staging -- <base-url>
# <base-url> includes the base path, for example https://rosie-staging.<subdomain>.workers.dev/test.
#  1. health: GET <base-url>/health answers 200 with ok: true and a trace id of its own;
#  2. one traced request: the same call with our x-trace-id, which must come back in the header and the body.
# Prints the trace id (search it in Workers Logs). EXPECT_VERSION, when set, is the version (GIT_SHA) the health
# answer must report. Exits non-zero on failure.
# Retries while a new deployment spreads, and gives up fast, so deploy-staging.sh's rollback after a failed
# check finishes well under 5 minutes (D-000 check 5):
#   CHECK_ATTEMPTS   requests in all, for both checks (default 10; the traced request always gets one)
#   CHECK_TIMEOUT_S  seconds each request may take (default 3; /health answers in well under a second)
# with 3 s between attempts, so a deployment that is still spreading gets about half a minute. Worst case with
# the defaults: 57 s when health never passes (10 x 3 s + 9 x 3 s), 60 s when it passes only on the last
# request and the traced request then fails.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 1 && -n "$1" ]] || die "usage: post-deploy-check.sh <base-url>"
url="${1%/}/health"
expect_version="${EXPECT_VERSION:-}"
attempts="${CHECK_ATTEMPTS:-10}"
timeout_s="${CHECK_TIMEOUT_S:-3}"
pause_s=3
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || die "CHECK_ATTEMPTS must be a whole number of requests, at least 1"
[[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || die "CHECK_TIMEOUT_S must be a whole number of seconds, at least 1"
used=0 # requests made so far, by both checks
trace_id="$(node -e 'process.stdout.write(crypto.randomUUID())')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# probe <trace id or empty>: one request; prints a one-line verdict and returns 0 when it passes.
probe() {
  local sent="$1"
  local -a header=()
  if [[ -n "$sent" ]]; then
    header=(--header "x-trace-id: $sent")
  fi
  if ! curl --silent --show-error --max-time "$timeout_s" --output "$work/body" \
    --dump-header "$work/headers" \
    --write-out '%{http_code}' ${header[@]+"${header[@]}"} "$url" >"$work/status" 2>"$work/error"; then
    printf 'request failed: %s\n' "$(tr '\n' ' ' <"$work/error")"
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    const [statusFile, headersFile, bodyFile, sent, expectVersion] = process.argv.slice(1);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const fail = (why) => { console.log(why); process.exit(1); };
    const status = fs.readFileSync(statusFile, "utf8").trim();
    const headerIds = [...fs.readFileSync(headersFile, "utf8").matchAll(/^x-trace-id:[ \t]*(\S+)/gim)];
    const headerId = headerIds.length > 0 ? headerIds[headerIds.length - 1][1] : undefined;
    let body;
    try { body = JSON.parse(fs.readFileSync(bodyFile, "utf8")); } catch { fail(`HTTP ${status}, body is not JSON`); }
    if (status !== "200") fail(`HTTP ${status}`);
    if (body.ok !== true) fail("ok is not true");
    if (typeof body.trace_id !== "string" || !uuid.test(body.trace_id)) fail("no valid trace_id in the body");
    if (headerId !== body.trace_id) fail("the x-trace-id header does not match the body");
    if (sent !== "" && body.trace_id !== sent) fail("the trace id sent did not come back");
    if (expectVersion !== "" && body.version !== expectVersion) fail(`version ${body.version}, expected ${expectVersion}`);
    console.log(`environment=${body.environment} version=${body.version} trace_id=${body.trace_id}`);
  ' "$work/status" "$work/headers" "$work/body" "$sent" "$expect_version"
}

# check <name> <trace id or empty>: probes until one passes, while requests are left (at least one).
check() {
  local name="$1" sent="$2" verdict tries=0
  while ((tries == 0 || used < attempts)); do
    tries=$((tries + 1))
    used=$((used + 1))
    if verdict="$(probe "$sent")"; then
      log "check: $name OK: $verdict"
      return 0
    fi
    log "check: $name, request $used/$attempts: $verdict"
    if ((used < attempts)); then
      sleep "$pause_s"
    fi
  done
  return 1
}

log "check: $url (at most $attempts requests of up to ${timeout_s}s each)"
if ! check "health" "" || ! check "traced request" "$trace_id"; then
  die "check failed at $url"
fi
echo "trace_id=$trace_id"
