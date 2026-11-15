#!/usr/bin/env bash
# Post-deploy check (factory spec 3 and 6): npm run check:staging -- [--join] <base-url>
# <base-url> includes the base path, for example https://rosie-staging.<subdomain>.workers.dev/test.
#  1. health: GET <base-url>/health answers 200 with ok: true and a trace id of its own, and reports the environment
#     staging (T-570). A health answer from any other environment is refused at once: no retry, and nothing more is
#     sent, so the check's later steps (the JOIN above all) never reach a Worker that is not staging's;
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
#  4. the JOIN, only with --join (T-570; DL-789's R6 as the lead ruled it; build prompt section 8's "one traced test
#     turn"): test owner 1's JOIN, the walking skeleton's first text (tp-01 on K-21 v1 test-roster.json; S1-01), through
#     staging's test-phone page calls, K-21 v1 testPhoneSend and testPhoneParts (each a POST to
#     <base-url>/page-api/<call>, the page entry's route), signed in as the seeded check tester (T-1302, T-1303):
#     a. before sending: tp-01's parts, read through testPhoneParts, must be none. JOIN is a first text once per schema
#        (DL-451), and a part's record names no trace, so a tp-01 that already has parts is refused, naming the reset (a
#        fresh seed), and nothing is sent;
#     b. the send: testPhoneSend with the words JOIN as tp-01. Its answer must carry the gateway's 200 and the trace id
#        the gateway opened, which is printed (search it in Workers Logs). The time from the send to that answer, as curl
#        measures it without the connection's setup, is a named timing line against C-044's 1 s (DL-757): OK, or BREACH,
#        which is reported to the architect as a NEED and never fixed by a cache (ADR-014 section 2). K-21's answer
#        carries no time of the gateway's own, so the line bounds the inbound path's time to the gateway's 200 from
#        above: the page entry's own reads (the session, the roster) and one round trip are in it too, and a BREACH line
#        says so, with the trace whose receive span gives the gateway's part alone. The line is a report: it does not
#        change the exit status, which the reply decides;
#     c. the reply: exactly one new part to tp-01 after the send's time, read through testPhoneParts (its `since`: the
#        parts' times are whole seconds, so it is the send's own second, less one, and a part in that second counts).
#        The first read comes at once, since the first text after a deploy gets its verdict on arrival (T-1397's seam);
#        without the part, one re-read, timed so that it ends within 30 s of the send (DL-757). No part then, or more
#        than one, fails the check, and its line names the missing reply and the trace id.
#     deploy-staging.sh never asks for it: tp-01's JOIN is a first text once per schema, so a JOIN in every deploy's
#     check would fail, and roll back, every healthy deploy after the first. The lead runs it once after
#     npm run seed:staging (DL-451's order: deploy:staging, seed:staging, then this). The automatic rollback on a broken
#     turn path waits for a first text that can repeat (QUESTIONS CQ-321).
#     The check tester's token: STAGING_CHECK_TESTER_TOKEN, read by name from the environment, else from the checkout's
#     git-ignored .dev.vars (lib.sh load_dev_var), as seed-staging.sh reads it; with --join alone (without it, the name is
#     dropped unread). It must be in the form make-check-tester-token.mjs makes it, 43 characters of base64url that are
#     32 bytes. It is never printed, logged or written to a file, and never in a command's arguments or environment:
#     every name that could hold it is dropped before any command is started, and each page call's JSON body, the one
#     place the token goes, reaches curl on its standard input alone (bash's printf, a builtin, writes it there). Each
#     page call's curl starts with --disable, so no ~/.curlrc can add a trace or a redirect. Refused before any request,
#     exit 1:
#     no token (the line names the variable), a token not in that form (no part of it shown), and a <base-url> that is
#     neither https nor http on this machine's own loopback (127.0.0.1, localhost or [::1], for wrangler dev), so the
#     token never crosses a network unencrypted.
# Prints the trace id of the traced request (search it in Workers Logs), and with --join the JOIN's, last. EXPECT_VERSION,
# when set, is the version (GIT_SHA) the health answer must report. Exits non-zero on failure.
# Retries while a new deployment spreads, and gives up fast, so deploy-staging.sh's rollback after a failed
# check finishes well under 5 minutes (D-000 check 5):
#   CHECK_ATTEMPTS   GET requests in all, for checks 1 and 2 (default 10; the traced request always gets one);
#                    check 3's POST is one more
#   CHECK_TIMEOUT_S  seconds each request may take, the POST's too (default 3; /health answers in well under a
#                    second)
# with 3 s between attempts, so a deployment that is still spreading gets about half a minute. Worst case with
# the defaults: 57 s when health never passes (10 x 3 s + 9 x 3 s), 60 s when it passes only on the last
# request and the traced request then fails, 63 s when the traced request then passes and the POST gets no answer.
# The JOIN's page calls may take 10 s each; its read before the send and the send add at most 20 s, and the reply's
# reads end within about 30 s of the send.
set +x
set +a
set +k
set -euo pipefail
# The check tester's token and the request bodies that carry it stay in variables of the script's own, never marked for
# export, whatever the caller's environment holds (as seed-staging.sh keeps the token): bash marks every variable it
# inherits for export, so one of the same name would hand the token to every command started from here, and so would
# allexport (bash -a, or SHELLOPTS); xtrace (bash -x) would print it, and under keyword (bash -k) an assignment on a
# command line goes to that command's environment. So the three are switched off above, and the names that hold it,
# lib.sh's load_dev_var's own and BASH_REMATCH (where its match leaves the line's value) among them, are dropped here,
# before anything is read, sourced or started. The token from the environment goes into `token`, and its name is dropped
# at once.
unset -v token request line value BASH_REMATCH
token="${STAGING_CHECK_TESTER_TOKEN:-}"
unset -v STAGING_CHECK_TESTER_TOKEN
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage="usage: post-deploy-check.sh [--join] <base-url>"
join=0
base=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --join)
      [[ "$join" == 0 ]] || die "--join is given twice; $usage"
      join=1
      ;;
    -*)
      die "an option it does not take (arguments are never echoed); $usage"
      ;;
    *)
      [[ -z "$base" && -n "$1" ]] || die "$usage"
      base="$1"
      ;;
  esac
  shift
done
[[ -n "$base" ]] || die "$usage"
if [[ "$join" == 0 ]]; then
  token="" # the JOIN's alone: without --join it is never used
fi
base="${base%/}"
url="$base/health"
expect_version="${EXPECT_VERSION:-}"
attempts="${CHECK_ATTEMPTS:-10}"
timeout_s="${CHECK_TIMEOUT_S:-3}"
pause_s=3
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || die "CHECK_ATTEMPTS must be a whole number of requests, at least 1"
[[ "$timeout_s" =~ ^[1-9][0-9]*$ ]] || die "CHECK_TIMEOUT_S must be a whole number of seconds, at least 1"

# Check 4's fixed values: the phone (test owner 1, K-21 v1 test-roster.json's tp-01; db/seeds/skeleton.ts), the words
# (tests/e2e/skeleton/join.ts: Sam's JOIN), each page call's limit, the reply's poll from the send, and C-044's budget.
JOIN_PHONE="tp-01"
JOIN_WORDS="JOIN"
join_timeout_s=10
poll_s=30
budget_ms=1000
# The signs of base64url, one by one, and those the 43rd sign of a token may be (32 bytes leave its last two bits 0):
# with the length, the form make-check-tester-token.mjs makes a token in, as seed-staging.sh checks it.
BASE64URL_SIGNS="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
LAST_SIGNS="AEIMQUYcgkosw048"

if [[ "$join" == 1 ]]; then
  # https, or http on this machine's own loopback (wrangler dev), as the URL standard parses <base-url>; else nothing.
  scheme_ok="$(node -e '
    try {
      const base = new URL(process.argv[1]);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
      if (base.protocol === "https:" || (base.protocol === "http:" && loopback)) process.stdout.write("ok");
    } catch {}
  ' "$base")"
  if [[ "$scheme_ok" != "ok" ]]; then
    token=""
    die "refused: --join sends the check tester's token, so <base-url> must be https, or http on this machine's own" \
      "loopback (127.0.0.1, localhost or [::1], for wrangler dev); nothing was sent"
  fi
  # The token from .dev.vars by name, when the environment gave none: load_dev_var exports what it reads, so the value
  # goes into the script's own variable and the name is dropped again at once, before any command is started. What its
  # match left in BASH_REMATCH (the line's value) is overwritten by a match of nothing.
  if [[ -z "$token" ]]; then
    load_dev_var STAGING_CHECK_TESTER_TOKEN
    token="${STAGING_CHECK_TESTER_TOKEN:-}"
    unset -v STAGING_CHECK_TESTER_TOKEN
    [[ "" =~ ^$ ]]
  fi
  if [[ -z "$token" ]]; then
    die "refused: STAGING_CHECK_TESTER_TOKEN is not set (the check tester's token, read by name from the" \
      "environment, else from .dev.vars): --join signs in to staging's test-phone page calls with it (make it with" \
      "npm run check-tester:token:make, then seed its hash with npm run seed:staging); nothing was sent"
  fi
  if [[ "${#token}" -ne 43 || "$token" == *[!$BASE64URL_SIGNS]* || "${token:42:1}" != [$LAST_SIGNS] ]]; then
    token=""
    die "refused: STAGING_CHECK_TESTER_TOKEN is not the check tester's token in the form it is made in (43" \
      "characters of base64url that are 32 random bytes, as npm run check-tester:token:make makes it), and no part" \
      "of it is shown; nothing was sent"
  fi
fi

used=0 # requests made so far, by both checks
not_staging=0 # set when a health answer reports an environment other than staging
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

# probe <trace id or empty>: one request; prints a one-line verdict and returns 0 when it passes, 2 when the answer is
# healthy but reports an environment other than staging (refused: never retried), else 1.
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
    const refuse = (why) => { console.log(why); process.exit(2); };
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
    if (body.environment !== "staging") {
      if (typeof body.environment !== "string") refuse("the Worker reports no environment, not staging");
      refuse(`the Worker reports environment ${JSON.stringify(body.environment.slice(0, 40))}, not staging`);
    }
    if (expectVersion !== "" && body.version !== expectVersion) fail(`version ${body.version}, expected ${expectVersion}`);
    console.log(`environment=${body.environment} version=${body.version} trace_id=${body.trace_id}`);
  ' "$work/status" "$work/headers" "$work/body" "$sent" "$expect_version"
}

# check <name> <trace id or empty>: probes until one passes, while requests are left (at least one). An answer from an
# environment other than staging stops it at once (not_staging).
check() {
  local name="$1" sent="$2" verdict tries=0 status
  while ((tries == 0 || used < attempts)); do
    tries=$((tries + 1))
    used=$((used + 1))
    status=0
    verdict="$(probe "$sent")" || status=$?
    if [[ "$status" == 0 ]]; then
      log "check: $name OK: $verdict"
      return 0
    fi
    if [[ "$status" == 2 ]]; then
      log "check: $name REFUSED: $verdict"
      not_staging=1
      return 1
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

# Check 4's verdict on one page call's answer (node program). Arguments: what the answer must be (send or parts), the
# files curl wrote (its status line: the HTTP status and two times; the headers; the body), the x-trace-id sent, the
# `since` sent (empty for none) and the phone. Prints one line and exits 0 when the call gave that outcome, else prints
# why and exits 1. A send prints "<trace id> <ms> <event id>": the trace id the gateway opened, from the answer, and the
# time from the send to the answer, without the connection's setup. A read prints the count of the parts after `since`
# (every part with none), followed, when it is one, by that part's time, kind and outcome. Nothing of a part's words, a
# number or a chat goes in a line: only ids, times, kinds, counts and K-21's own error names.
PAGE_VERDICT='
  const fs = require("node:fs");
  const [want, statusFile, headersFile, bodyFile, sent, since, phone] = process.argv.slice(1);
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
  const WORD = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
  const fail = (why) => { console.log(why); process.exit(1); };
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  const [status = "", pretransfer = "", total = ""] = fs.readFileSync(statusFile, "utf8").trim().split(/\s+/);
  const edge = {
    400: "the page entry found no JSON object in the request",
    404: "no page entry at that address",
    405: "that address takes no POST",
    413: "the request was over the page entry cap",
    503: "the handler failed or is not connected (a closed port, no database, no test-phone line)",
  };
  if (status !== "200") fail(`HTTP ${status}: ${own(edge, status) ?? "not the 200 of the page entry"}, so no outcome`);
  const headerIds = [...fs.readFileSync(headersFile, "utf8").matchAll(/^x-trace-id:[ \t]*(\S+)/gim)];
  const headerId = headerIds.length > 0 ? headerIds[headerIds.length - 1][1] : undefined;
  if (headerId !== sent) fail("HTTP 200, but not from the page entry: the x-trace-id sent did not come back");
  let body;
  try { body = JSON.parse(fs.readFileSync(bodyFile, "utf8")); } catch { fail("HTTP 200, but the body is not JSON"); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("HTTP 200, but the body is no JSON object");
  const errors = {
    stagingOnly: "stagingOnly: the Worker there is not staging, and it read nothing",
    signInNeeded:
      "signInNeeded: no live session has the check tester token (STAGING_CHECK_TESTER_TOKEN): npm run seed:staging" +
      " -- --set check-tester seeds its hash (make a new one first when it lapsed: npm run check-tester:token:make" +
      " -- --rotate)",
    notTester: "notTester: the session of that token is neither a roster tester nor on the team",
    notTestPhone: `notTestPhone: staging has no test phone ${phone} (npm run seed:staging)`,
    transient: "transient: nothing was done (K-05 v1), so the call may be made again",
  };
  if (Object.hasOwn(body, "error")) {
    const error = typeof body.error === "string" ? own(errors, body.error) : undefined;
    fail(error ?? "an error K-21 v1 does not give this call");
  }
  if (want === "send") {
    if (body.result !== "sent") fail("an answer that is not the one testPhoneSend gives");
    if (typeof body.traceId !== "string" || !ID.test(body.traceId)) fail("the answer carries no trace id");
    if (body.gatewayStatus !== 200) {
      const why = {
        401: "the gateway refused the signature of the Linq double (LINQ_WEBHOOK_SECRET)",
        503: "the gateway took nothing (a closed port, or the database out of reach)",
      };
      const gateway = String(body.gatewayStatus).slice(0, 12);
      const reason = own(why, gateway);
      fail(`the gateway answered ${gateway}${reason ? ": " + reason : ""}, not 200, trace_id=${body.traceId}`);
    }
    const ms = Math.round((Number(total) - Number(pretransfer)) * 1000);
    if (!Number.isSafeInteger(ms) || ms < 0) fail("curl gave no time for the send");
    const eventId = typeof body.eventId === "string" && ID.test(body.eventId) ? body.eventId : "unknown";
    console.log(`${body.traceId} ${String(ms)} ${eventId}`);
    process.exit(0);
  }
  if (body.result !== "parts" || !Array.isArray(body.parts)) fail("an answer that is not the one testPhoneParts gives");
  const shown = body.phone;
  if (typeof shown !== "object" || shown === null || shown.testPhoneId !== phone)
    fail(`the parts of a phone other than ${phone}`);
  const after = since === "" ? null : Date.parse(since);
  const fresh = body.parts.filter(
    (part) => after === null || (typeof part?.at === "string" && UTC.test(part.at) && Date.parse(part.at) > after),
  );
  if (fresh.length !== 1) {
    console.log(String(fresh.length));
    process.exit(0);
  }
  const [part] = fresh;
  const at = typeof part?.at === "string" && UTC.test(part.at) ? part.at : "unknown";
  const kind = typeof part?.sent?.kind === "string" && WORD.test(part.sent.kind) ? part.sent.kind : "unknown";
  const outcome =
    typeof part?.outcome?.result === "string" && WORD.test(part.outcome.result) ? part.outcome.result : "unknown";
  console.log(`1 at ${at}, a ${kind} part, ${outcome}`);
'

# new_ids: a new request id (K-21 page.requestId, once per call) and trace id (page.traceId, sent as x-trace-id too)
# for the next page call, in request_id and page_trace_id.
new_ids() {
  local ids
  ids="$(node -e 'process.stdout.write(crypto.randomUUID() + " " + crypto.randomUUID())')"
  request_id="${ids%% *}"
  page_trace_id="${ids#* }"
}

# parts_request <since, as JSON>: K-21 v1 testPhoneParts' request for the phone, signed in, into `request`.
parts_request() {
  printf -v request '{"page":{"requestId":"%s","traceId":"%s","sessionToken":"%s","linkCode":null},"testPhoneId":"%s","since":%s}' \
    "$request_id" "$page_trace_id" "$token" "$JOIN_PHONE" "$1"
}

# page_call <call> <send|parts> <name>: one K-21 call, POST <base-url>/page-api/<call>, its JSON body (`request`, which
# holds the token) on curl's standard input alone, under page_trace_id, its answer in $work/<name>.*; prints the verdict
# line (PAGE_VERDICT's) and returns 0 when it gave the outcome asked for, else prints why and returns 1. Never retried.
page_call() {
  local call="$1" want="$2" name="$3"
  if ! printf '%s' "$request" | curl --disable --silent --show-error --max-time "$join_timeout_s" --request POST \
    --header "x-trace-id: $page_trace_id" --header "content-type: application/json" --data-binary @- \
    --output "$work/$name.body" --dump-header "$work/$name.headers" \
    --write-out '%{http_code} %{time_pretransfer} %{time_total}' "$base/page-api/$call" \
    >"$work/$name.status" 2>"$work/$name.error"; then
    printf 'no answer: %s\n' "$(tr '\n' ' ' <"$work/$name.error")"
    return 1
  fi
  node -e "$PAGE_VERDICT" "$want" "$work/$name.status" "$work/$name.headers" "$work/$name.body" "$page_trace_id" \
    "$since" "$JOIN_PHONE"
}

log "check: $url (at most $attempts requests of up to ${timeout_s}s each)"
if ! check "health" "" || ! check "traced request" "$trace_id"; then
  if [[ "$not_staging" == 1 ]]; then
    die "refused: $url reports an environment other than staging: check:staging checks staging alone, so nothing" \
      "more was sent"
  fi
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

if [[ "$join" == 1 ]]; then
  # 4a. tp-01's parts before the send: none, or the JOIN is refused with nothing sent.
  since=""
  new_ids
  parts_request null
  status=0
  verdict="$(page_call testPhoneParts parts before)" || status=$?
  if [[ "$status" != 0 ]]; then
    log "check: join FAILED: $JOIN_PHONE's parts could not be read before the send: $verdict," \
      "page trace_id=$page_trace_id"
    die "check failed at $base/page-api/testPhoneParts: the JOIN's read before the send failed; nothing was sent"
  fi
  count="${verdict%% *}"
  if [[ "$count" != 0 ]]; then
    die "refused: $JOIN_PHONE already has $count part(s) on staging's test-phone line, so its JOIN would be no first" \
      "text and a new reply could not be told apart: --join sends $JOIN_PHONE's JOIN once per reset of the test state" \
      "(a fresh seed: a fresh schema, then npm run seed:staging; DL-451, DL-789), and the test-phone line must hold" \
      "no part to $JOIN_PHONE (it keeps its parts across a seed: CQ-321); nothing was sent"
  fi
  log "check: join: $JOIN_PHONE has no parts yet, so its JOIN is a first text (page trace_id=$page_trace_id)"

  # 4b. The send. `since` is the send's second, less one: the parts' times are whole seconds.
  since="$(node -e '
    const second = Math.floor(Date.now() / 1000) * 1000;
    process.stdout.write(new Date(second - 1000).toISOString().replace(/[.][0-9]+Z$/, "Z"));
  ')"
  new_ids
  printf -v request '{"page":{"requestId":"%s","traceId":"%s","sessionToken":"%s","linkCode":null},"testPhoneId":"%s","words":"%s","threadedReplyTo":null}' \
    "$request_id" "$page_trace_id" "$token" "$JOIN_PHONE" "$JOIN_WORDS"
  SECONDS=0 # bash's own clock, in whole seconds from here: the reply's poll ends within poll_s of the send
  status=0
  verdict="$(page_call testPhoneSend send send)" || status=$?
  if [[ "$status" != 0 ]]; then
    log "check: join FAILED: testPhoneSend as $JOIN_PHONE: $verdict, page trace_id=$page_trace_id"
    die "check failed at $base/page-api/testPhoneSend: the JOIN did not get the gateway's 200 (with no answer at" \
      "all it may still have been sent: a later --join reads $JOIN_PHONE's parts first)"
  fi
  join_trace_id="${verdict%% *}"
  verdict="${verdict#* }"
  send_ms="${verdict%% *}"
  event_id="${verdict#* }"
  log "check: join sent: $JOIN_WORDS as $JOIN_PHONE through testPhoneSend, the gateway answered 200:" \
    "event_id=$event_id trace_id=$join_trace_id"
  if ((send_ms <= budget_ms)); then
    log "check: join timing OK: ${send_ms} ms from the send to testPhoneSend's answer with the gateway's 200 (the" \
      "connection's setup not counted), within C-044's 1 s (DL-757)"
  else
    log "check: join timing BREACH: ${send_ms} ms from the send to testPhoneSend's answer with the gateway's 200" \
      "(the connection's setup not counted), over C-044's 1 s: report it to the architect as a NEED, never fix it" \
      "with a cache (DL-757; ADR-014 section 2). It bounds the gateway's part from above: the page entry's own reads" \
      "and one round trip are in it, and the gateway's receive span under trace_id=$join_trace_id gives that part alone"
  fi

  # 4c. The reply: exactly one new part to tp-01 after the send's time; the first read at once, then one re-read that
  # ends within poll_s of the send.
  reads=0
  while :; do
    reads=$((reads + 1))
    new_ids
    parts_request "\"$since\""
    status=0
    verdict="$(page_call testPhoneParts parts "after-$reads")" || status=$?
    seen="none"
    if [[ "$status" == 0 ]]; then
      seen="${verdict%% *}"
    fi
    if [[ "$seen" == 1 ]]; then
      break
    fi
    if [[ "$status" == 0 && "$seen" != 0 ]]; then
      log "check: join FAILED: $seen new parts to $JOIN_PHONE after the send (read $reads of 2), not exactly one:" \
        "trace_id=$join_trace_id"
      die "check failed at $base/page-api/testPhoneParts: the JOIN's reply was not exactly one part (search" \
        "trace_id=$join_trace_id in Workers Logs)"
    fi
    if [[ "$status" != 0 ]]; then
      log "check: join: read $reads of 2 of $JOIN_PHONE's parts failed: $verdict, page trace_id=$page_trace_id"
    fi
    if ((reads >= 2)); then
      log "check: join FAILED: no reply part to $JOIN_PHONE within ${poll_s} s of the send (2 reads through" \
        "testPhoneParts): the reply is missing, trace_id=$join_trace_id"
      die "check failed at $base/page-api/testPhoneParts: the JOIN's reply is missing (search" \
        "trace_id=$join_trace_id in Workers Logs)"
    fi
    pause=$((poll_s - SECONDS - join_timeout_s))
    if ((pause < 0)); then
      pause=0
    fi
    log "check: join: no reply part to $JOIN_PHONE yet (read 1 of 2); one re-read in ${pause} s, to end within" \
      "${poll_s} s of the send (DL-757)"
    if ((pause > 0)); then
      sleep "$pause"
    fi
  done
  request=""
  token=""
  # The verdict without its count: "at <time>, a <kind> part, <outcome>".
  log "check: join OK: exactly one new part to $JOIN_PHONE after the send (${verdict#1 }; read $reads of 2):" \
    "trace_id=$join_trace_id"
fi
echo "trace_id=$trace_id"
if [[ "$join" == 1 ]]; then
  echo "join_trace_id=$join_trace_id"
fi
