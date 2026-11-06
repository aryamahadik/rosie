#!/usr/bin/env bash
# Post-deploy check (factory spec 3 and 6): npm run check:staging -- <base-url>
# <base-url> includes the base path, for example https://rosie-staging.<subdomain>.workers.dev/test.
#  1. health: GET <base-url>/health answers 200 with ok: true and a trace id of its own;
#  2. one traced request: the same call with our x-trace-id, which must come back in the header and the body.
# Prints the trace id (search it in Workers Logs). EXPECT_VERSION, when set, is the version (GIT_SHA) the health
# answer must report. Retries for about a minute while a new deployment spreads. Exits non-zero on failure.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 1 && -n "$1" ]] || die "usage: post-deploy-check.sh <base-url>"
url="${1%/}/health"
expect_version="${EXPECT_VERSION:-}"
attempts="${CHECK_ATTEMPTS:-20}"
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
  if ! curl --silent --show-error --max-time 10 --output "$work/body" --dump-header "$work/headers" \
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

check() {
  local name="$1" sent="$2" verdict i
  for ((i = 1; i <= attempts; i++)); do
    if verdict="$(probe "$sent")"; then
      log "check: $name OK: $verdict"
      return 0
    fi
    log "check: $name, attempt $i/$attempts: $verdict"
    if ((i < attempts)); then
      sleep 3
    fi
  done
  return 1
}

log "check: $url"
if ! check "health" "" || ! check "traced request" "$trace_id"; then
  gh_summary "Staging check FAILED at $url"
  die "check failed at $url"
fi
echo "trace_id=$trace_id"
gh_output trace_id "$trace_id"
gh_summary "Staging check passed at $url. Trace id: \`$trace_id\` (search it in Workers Logs)."
