#!/usr/bin/env bash
# Post-deploy check (factory spec 3 and 6): npm run check:staging -- <base-url>
# <base-url> includes the base path, for example https://rosie-staging.<subdomain>.workers.dev/test.
#  1. health: GET <base-url>/health answers 200 with ok: true and a trace id of its own;
#  2. one traced request: the same call with our x-trace-id, which must come back in the header and the body;
#  3. the host rule on the edge (T-1321; T-1237's security review, note b): after the GETs, one form POST to
#     <base-url>/sign-in, the sign-in form's route (web/src/auth/pages.ts SIGN_IN_PATH, route auth.signIn), sent
#     only when <base-url> is a workers.dev address (https, a host ending in .workers.dev). Its small form has no
#     field a handler reads, and its Origin is this site's own (https:// + env.staging's LINK_HOST in wrangler.jsonc,
#     as web/src/shell/post-guard.ts siteOrigin builds it), so the origin check would take it and only the host rule
#     can refuse it. It must answer the guard's 403 page (post-guard.ts guardPost; the 403 page of
#     web/src/shell/error-pages.ts): HTTP 403, with our x-trace-id back in the header and shown on the page as its
#     reference. Any other answer (a 200, a redirect, a 404, a 405, a 413, a 5xx, a 403 that is not that page) or
#     none fails the check, and deploy-staging.sh then rolls the deploy back. The 403 comes before any handler runs,
#     so the POST writes nothing; on a version without the host rule the form reaches the handler, which refuses it
#     (no request id) before any call. It is sent once, never retried, and never anywhere else: a POST to the site's
#     own host (rosfield.com) would reach a handler, so for any other <base-url> one NOTICE line says that no POST
#     was sent. Its line holds the status and its trace id, never a body or a value.
# Prints the trace id of the traced request (search it in Workers Logs). EXPECT_VERSION, when set, is the version
# (GIT_SHA) the health answer must report. Exits non-zero on failure.
# Retries while a new deployment spreads, and gives up fast, so deploy-staging.sh's rollback after a failed
# check finishes well under 5 minutes (D-000 check 5):
#   CHECK_ATTEMPTS   GET requests in all, for checks 1 and 2 (default 10; the traced request always gets one);
#                    check 3's POST is one more
#   CHECK_TIMEOUT_S  seconds each request may take, the POST's too (default 3; /health answers in well under a
#                    second)
# with 3 s between attempts, so a deployment that is still spreading gets about half a minute. Worst case with
# the defaults: 57 s when health never passes (10 x 3 s + 9 x 3 s), 60 s when it passes only on the last
# request and the traced request then fails, 63 s when the traced request then passes and the POST gets no answer.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[[ $# -eq 1 && -n "$1" ]] || die "usage: post-deploy-check.sh <base-url>"
base="${1%/}"
url="$base/health"
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

# Check 3's form POST (above). The site's own origin is https:// + env.staging's LINK_HOST in wrangler.jsonc, and
# the path is web/src/auth/pages.ts SIGN_IN_PATH: post-deploy-check.test.mjs fails when either differs from these.
site_origin="https://rosfield.com"
form_path="/sign-in"
form_body="check=host-rule" # a small form; no request id, so no handler that reads it calls anything
# The POST's address: <base-url>'s origin and path, as the URL standard parses them, then /sign-in, when <base-url>
# is an https address on workers.dev; else nothing, and no POST is sent.
post_url="$(node -e '
  try {
    const base = new URL(process.argv[1]);
    if (base.protocol === "https:" && base.hostname.endsWith(".workers.dev"))
      process.stdout.write(base.origin + base.pathname.replace(/\/+$/, "") + process.argv[2]);
  } catch {}
' "$base" "$form_path")"

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

# host_rule <trace id>: check 3's one form POST; prints a one-line verdict (the status and why, never a body or a
# value) and returns 0 when the answer is the guard's 403 page. --disable, first, keeps any ~/.curlrc out, so nothing
# can make curl follow a redirect and send the POST on to another address.
host_rule() {
  local sent="$1"
  if ! curl --disable --silent --show-error --max-time "$timeout_s" --request POST \
    --header "x-trace-id: $sent" --header "origin: $site_origin" \
    --header "content-type: application/x-www-form-urlencoded" --data-binary "$form_body" \
    --output "$work/post-body" --dump-header "$work/post-headers" \
    --write-out '%{http_code}' "$post_url" >"$work/post-status" 2>"$work/post-error"; then
    printf 'no answer: %s\n' "$(tr '\n' ' ' <"$work/post-error")"
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    const [statusFile, headersFile, bodyFile, sent] = process.argv.slice(1);
    const fail = (why) => { console.log(why); process.exit(1); };
    const status = fs.readFileSync(statusFile, "utf8").trim();
    const why = {
      "404": "no route takes a POST at that address",
      "405": "the route there does not take a POST",
      "413": "refused for its size, not by the host rule",
    };
    if (status !== "403") {
      if (why[status]) fail(`HTTP ${status}: ${why[status]}`);
      if (/^2[0-9][0-9]$/.test(status)) fail(`HTTP ${status}: the form was taken, so the host rule did not refuse it`);
      if (/^3[0-9][0-9]$/.test(status)) fail(`HTTP ${status}: a redirect, not the 403 from the guard`);
      if (/^5[0-9][0-9]$/.test(status)) fail(`HTTP ${status}: the Worker failed`);
      fail(`HTTP ${status}: not the 403 from the guard`);
    }
    const headerIds = [...fs.readFileSync(headersFile, "utf8").matchAll(/^x-trace-id:[ \t]*(\S+)/gim)];
    const headerId = headerIds.length > 0 ? headerIds[headerIds.length - 1][1] : undefined;
    if (headerId !== sent) fail("HTTP 403, but not from the Worker: the x-trace-id sent did not come back");
    if (!fs.readFileSync(bodyFile, "utf8").includes(sent))
      fail("HTTP 403, but not from the guard: the page does not show the trace id");
    console.log("HTTP 403 from the guard");
  ' "$work/post-status" "$work/post-headers" "$work/post-body" "$sent"
}

log "check: $url (at most $attempts requests of up to ${timeout_s}s each)"
if ! check "health" "" || ! check "traced request" "$trace_id"; then
  die "check failed at $url"
fi
if [[ -n "$post_url" ]]; then
  post_trace_id="$(node -e 'process.stdout.write(crypto.randomUUID())')"
  if ! verdict="$(host_rule "$post_trace_id")"; then
    log "check: host rule FAILED: POST $post_url: $verdict, trace_id=$post_trace_id"
    die "check failed at $post_url: a form POST to the workers.dev address must answer the guard's 403 (T-1237)"
  fi
  log "check: host rule OK: POST $post_url: $verdict, trace_id=$post_trace_id"
else
  log "check: host rule: NOTICE: no POST sent, as $base is not an https address on workers.dev (a POST to the" \
    "site's own host would reach a handler)"
fi
echo "trace_id=$trace_id"
