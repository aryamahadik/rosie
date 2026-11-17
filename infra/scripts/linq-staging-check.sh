#!/usr/bin/env bash
# Linq's webhook for staging (T-572; D-018; DL-940; K-11 v1 default 1; QUESTIONS Q-52): the webhook subscriptions Linq
# holds, and the one that sends the events of Rosie's line to staging's Linq route. Run from the build Mac:
#   npm run linq:staging:check -- <base-url>     (bash infra/scripts/linq-staging-check.sh <base-url>)
#   npm run linq:staging:create -- <base-url>    (bash infra/scripts/linq-staging-check.sh --create <base-url>)
# <base-url> is staging's base URL with its base path, as check:staging takes it (post-deploy-check.sh), for example
# https://rosfield.com/test, staging's own route (wrangler.jsonc env.staging: LINK_HOST plus BASE_PATH). A trailing / is
# dropped. Staging's Linq route is <base-url> plus LINQ_WEBHOOK_PATH (runtime/src/gateway/index.ts: /webhooks/linq).
#
# The check (the default) asks and changes nothing: one GET /webhook-subscriptions on Linq's API (T-414's base and bearer
# key: adapters/src/linq/send/wire.ts LINQ_API_BASE), then, on standard output, staging's Linq route, one line for each
# subscription Linq lists and one verdict line:
#     <id>: <target>, active <yes|no|unknown>, Rosie's number <yes|no|...>, events <each event it lists>
#   The target is "staging's Linq route", or "another target" shown by its host alone (a path may hold a token). Rosie's
#   number says whether the subscription's phone_numbers filter holds ROSIE_NUMBER (an empty filter is every number),
#   never the number. Only an id, a host or an event name in a plain form is shown.
#   PASS (exit 0) only when exactly one active subscription targets staging's Linq route, its events hold every event on
#   EVENTS below, and its filter holds Rosie's number; else FAIL, with why (exit 1).
# --create lists first, as the check does, and is refused when an active subscription already targets staging's Linq
# route. Otherwise one POST /webhook-subscriptions with target_url staging's Linq route, subscribed_events exactly EVENTS
# and phone_numbers [ROSIE_NUMBER]. Linq answers the new subscription with its signing_secret, given once only (it cannot
# be read back later): the secret goes, straight from the answer, on standard input to
# `wrangler secret put LINQ_WEBHOOK_SECRET --env staging` through cf.sh, as put-staging-secrets.sh puts a value, with
# wrangler's debug log told to leave request bodies out (WRANGLER_LOG_SANITIZE). It is never printed, logged, written to
# a file, or put in any command's arguments or environment, and what wrangler prints is kept off the terminal: dropped
# after a put that worked, shown with the secret taken out after one that failed. Then the new subscription's id and
# PASS. If the put fails, the run says so plainly and prints the one call that deletes that subscription by id, so
# --create can run again. Before anything is asked of Linq, --create checks that wrangler reaches staging
# (`wrangler secret list --env staging`, names only), so the put is not refused for a sign-in after the secret is given.
# Neither mode changes, disables or deletes any other subscription: the old demo's keeps the line's events
# (adapters/spikes/linq-live/FINDINGS.md answer 8) until the user decides. Each put makes a new version of the staging
# Worker and deploys it at once (wrangler secret put); wrangler refuses a put while the Worker's latest version is not the
# deployed one (a branch preview's upload): run npm run deploy:staging first.
#
# The values, each read by name and never printed: LINQ_API_TOKEN (Linq's key) and ROSIE_NUMBER (Rosie's line, E.164),
# each from the environment, else from the checkout's git-ignored .dev.vars through lib.sh's load_dev_var, as
# deploy-staging.sh reads ROSIE_NUMBER. Each goes into a variable of the script's own, never exported, and its name leaves
# the environment before any command is started. Both reach node on its standard input alone, one a line, written by
# printf, a builtin (as adapters/spikes/linq-live/probe.sh hands its values on): never in any command's arguments or
# environment. Node puts the key in the Authorization header of its requests and nowhere else, follows no redirect, and
# shows no part of Linq's answers but a status, a code, ids, hosts and event names.
#
# Refused before anything is asked of Linq (exit 1): a <base-url> that is not https with a host and a plain path (never
# echoed); CLOUDFLARE_ENV other than staging, with --create; a .dev.vars that cannot be read; no key, or one holding a
# space, a quote, a #, or a sign that is not plain ASCII; no ROSIE_NUMBER, or one not in E.164 form; with --create, a
# secret list that fails.
# Exit: 0 PASS; 1 refused, FAIL, a request with no answer or with an answer that is not the one Linq's documents give, or
# a create or a put that failed (each says which); 2 misuse (an argument it does not take; none is echoed).
set +x
set +a
set +k
set -euo pipefail
# No variable of this script starts out marked for export, or with the caller's text in it (put-staging-secrets.sh's
# note): every name this script, and lib.sh's load_dev_var that reads for it, keeps a variable under is dropped here,
# before anything is read, sourced or started: lib.sh's ROOT and CF and the fixed texts in capitals included. So is
# BASH_REMATCH, where load_dev_var's match leaves what it read; bash never exports an array. A new variable goes on these
# lines too: linq-staging-check.test.mjs fails until it does.
unset -v mode base route key number status listed name file line value BASH_REMATCH
unset -v ROOT CF USAGE DEV_VARS E164 NOT_IN_A_KEY BASE_FORM LINQ_API_BASE EVENTS PROGRAM
# The values, when the caller's environment holds them, go into variables of the script's own, and their names leave
# the environment at once, before any command is started (finding lib.sh runs dirname).
key="${LINQ_API_TOKEN:-}"
number="${ROSIE_NUMBER:-}"
unset -v LINQ_API_TOKEN ROSIE_NUMBER
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Linq's API base: T-414's, adapters/src/linq/send/wire.ts LINQ_API_BASE (linq-staging-check.test.mjs holds the two
# equal). The subscriptions are /webhook-subscriptions under it.
LINQ_API_BASE="https://api.linqapp.com/api/partner/v3"
# The events staging's subscription sends: exactly the Linq event types T-413's parser maps to K-06 events
# (adapters/src/linq/webhook/parse.ts USED_EVENT_TYPES; linq-staging-check.test.mjs holds the two equal). Linq's other
# types would reach the gateway only to be ignored.
EVENTS=(
  message.received
  message.sent
  message.delivered
  message.failed
  message.edited
  reaction.added
  poll.vote.added
  poll.vote.removed
  poll.failed
)
USAGE="usage: linq-staging-check.sh [--create] <base-url>   (staging's base URL with its base path, as check:staging takes it: https://rosfield.com/test)"
DEV_VARS="$ROOT/.dev.vars"
# E.164: the form K-04's handles_address_form and K-11's phone write a number in (deploy-staging.sh's E164).
E164='^[+][1-9][0-9]{6,14}$'
# What no key holds: white space, a control sign, a quote, a #.
NOT_IN_A_KEY="[[:space:][:cntrl:]\"'#]"
# A <base-url> this script takes: https, a host (and a port), then a plain path or none; no query, fragment or sign-in.
BASE_FORM='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'

# misuse <why>: a command line this script does not take (exit 2). No argument is echoed: one could be a pasted key.
misuse() {
  printf '%s: %s\n%s\n' "$(basename "$0")" "$*" "$USAGE" >&2
  exit 2
}

mode="check"
base=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --create)
      if [[ "$mode" == "create" ]]; then
        misuse "--create is given twice"
      fi
      mode="create"
      ;;
    -*)
      misuse "an option it does not take (arguments are never echoed)"
      ;;
    *)
      if [[ -n "$base" ]]; then
        misuse "more than one <base-url> (arguments are never echoed)"
      fi
      base="$1"
      ;;
  esac
  shift
done
if [[ -z "$base" ]]; then
  misuse "no <base-url>"
fi
base="${base%/}"
if [[ ! "$base" =~ $BASE_FORM ]]; then
  die "refused: <base-url> must be an https address with a host and a plain path, and no query, fragment or sign-in," \
    "such as https://rosfield.com/test (it is not echoed); nothing was asked of Linq"
fi
route="$base/webhooks/linq"

if [[ "$mode" == "create" && -n "${CLOUDFLARE_ENV:-}" && "$CLOUDFLARE_ENV" != "staging" ]]; then
  die "refused: CLOUDFLARE_ENV names an environment other than staging, so cf.sh would refuse the put of Linq's signing" \
    "secret, which Linq gives only once; nothing was asked of Linq"
fi
if [[ -e "$DEV_VARS" && ! -r "$DEV_VARS" ]]; then
  die "refused: this checkout's .dev.vars cannot be read; nothing was asked of Linq"
fi

# The values from .dev.vars by name, when the environment gave none: load_dev_var exports what it reads, so each value
# goes into the script's own variable and its name leaves the environment again at once, before any command is started.
if [[ -z "$key" ]]; then
  load_dev_var LINQ_API_TOKEN
  key="${LINQ_API_TOKEN:-}"
  unset -v LINQ_API_TOKEN
fi
if [[ -z "$number" ]]; then
  load_dev_var ROSIE_NUMBER
  number="${ROSIE_NUMBER:-}"
  unset -v ROSIE_NUMBER
fi
if [[ -z "$key" ]]; then
  die "refused: LINQ_API_TOKEN is not set (Linq's key, read by name from the environment, else from .dev.vars);" \
    "nothing was asked of Linq"
fi
if [[ "$key" =~ $NOT_IN_A_KEY ]]; then
  key=""
  number=""
  [[ "" =~ ^$ ]]
  die "refused: LINQ_API_TOKEN holds a space, a quote, a # or a control sign, which no key does (no part of it is" \
    "shown): write its line in .dev.vars as LINQ_API_TOKEN=value, with nothing after the value; nothing was asked of Linq"
fi
if [[ -z "$number" ]]; then
  key=""
  die "refused: ROSIE_NUMBER is not set (Rosie's line, read by name from the environment, else from .dev.vars);" \
    "nothing was asked of Linq"
fi
if [[ ! "$number" =~ $E164 ]]; then
  key=""
  number=""
  die "refused: ROSIE_NUMBER is not in E.164 form (a + and 7 to 15 digits; the value is not shown); nothing was" \
    "asked of Linq"
fi
# What a match left in BASH_REMATCH (the number, or a line's value from load_dev_var) is overwritten by a match of
# nothing.
[[ "" =~ ^$ ]]

# --create's check that wrangler reaches staging, before Linq is asked for anything: its list (names only) is dropped,
# and its other words reach the terminal as they are.
if [[ "$mode" == "create" ]]; then
  status=0
  listed="$("$CF" secret list --env staging --format json)" || status=$?
  listed=""
  if [[ "$status" -ne 0 ]]; then
    key=""
    number=""
    die "refused: wrangler secret list --env staging failed (exit $status, for the reason above), so staging could" \
      "not take Linq's signing secret, which Linq gives only once; nothing was asked of Linq or created. Once the" \
      "cause is fixed, run it again."
  fi
fi

# The node program: argv mode, staging's Linq route, Linq's API base, cf.sh's path, then EVENTS; standard input the key
# and the number, one a line. It writes the lines above, and returns the exit status. It holds no apostrophe, so it sits
# in one quoted text: Q, made from its character code, stands for one inside its strings.
PROGRAM='
"use strict";
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [mode, route, api, cf, ...events] = process.argv.slice(1);
const Q = String.fromCharCode(39);
const NAME = "linq-staging-check.sh";
const OURS = `staging${Q}s Linq route`;
const ROSIES = `Rosie${Q}s number`;
const LINQS_KEY = `Linq${Q}s key`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EVENT = /^[a-z][a-z0-9_]{0,31}(?:[.][a-z0-9_]{1,31}){0,7}$/;
const CODE = /^[A-Za-z0-9_]{1,16}$/;
const E164 = /^[+][1-9][0-9]{6,14}$/;
const PLAIN = /^[\x21-\x7e]+$/;
// The form the gateway verify takes (adapters/src/shared/hmac.ts importLinqKey): whsec_, then base64.
const SECRET_FORM = /^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMEOUT_MS = 20000;
const AGENT = "rosie-linq-staging-check/1";
const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${NAME}: ${line}\n`);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const shownId = (id) => (typeof id === "string" && ID.test(id) ? id : "(an id in another form)");

const [key = "", number = ""] = readFileSync(0, "utf8").split("\n");
const ourRoute = new URL(route).href;

// One request to Linq: the key in the Authorization header alone, no redirect followed, a time limit. No error text is
// kept: a refused header can carry its value.
async function linq(method, body) {
  const headers = { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": AGENT };
  if (body !== null) headers["content-type"] = "application/json";
  let answer;
  try {
    answer = await fetch(`${api}/webhook-subscriptions`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { status: null, json: undefined };
  }
  let json;
  try {
    json = JSON.parse(await answer.text());
  } catch {
    json = undefined;
  }
  return { status: answer.status, json };
}

const answered = (call) => call.status !== null && call.status >= 200 && call.status <= 299;

// What a failed call is shown as: its status and Linq code, never its message.
function failure(what, call) {
  if (call.status === null) return `${what}: no answer from Linq (nothing is retried)`;
  const code = isObject(call.json) && isObject(call.json.error) ? call.json.error.code : undefined;
  const shown = Number.isSafeInteger(code) || (typeof code === "string" && CODE.test(code)) ? `, Linq code ${code}` : "";
  return `${what}: Linq answered HTTP ${call.status}${shown}`;
}

// One subscription as the lines above show it.
function read(item) {
  const sub = isObject(item) ? item : {};
  let ours = false;
  let target = "a target that is no https address";
  if (typeof sub.target_url === "string") {
    try {
      const url = new URL(sub.target_url);
      ours = url.href === ourRoute;
      if (ours) target = OURS;
      else if (url.protocol === "https:" || url.protocol === "http:") target = `another target, host ${url.host}`;
    } catch {}
  }
  const active = sub.is_active === true;
  const named = Array.isArray(sub.subscribed_events) ? sub.subscribed_events : [];
  const shown = named.map((event) => (typeof event === "string" && EVENT.test(event) ? event : "(an event in another form)"));
  const missing = events.filter((event) => !named.includes(event));
  const filter = sub.phone_numbers;
  let holds = false;
  let rosie = "no";
  if (filter === undefined || filter === null || (Array.isArray(filter) && filter.length === 0)) {
    holds = true;
    rosie = "yes (no number filter: every number)";
  } else if (!Array.isArray(filter)) {
    rosie = "unknown (a filter in another form)";
  } else if (filter.includes(number)) {
    holds = true;
    rosie = "yes";
  }
  const state = active ? "yes" : sub.is_active === false ? "no" : "unknown";
  const id = shownId(sub.id);
  const line = `${id}: ${target}, active ${state}, ${ROSIES} ${rosie}, events ${shown.length > 0 ? shown.join(" ") : "none"}`;
  return { id, ours, active, missing, holds, line };
}

function verdict(subs) {
  const ours = subs.filter((sub) => sub.ours && sub.active);
  if (ours.length === 0) {
    return [1, `FAIL: no active subscription targets ${OURS}: npm run linq:staging:create makes one`];
  }
  if (ours.length > 1) {
    const ids = ours.map((sub) => sub.id).join(", ");
    return [1, `FAIL: ${ours.length} active subscriptions target ${OURS} (${ids}): Linq would send staging each event more than once, so one must go`];
  }
  const [one] = ours;
  const faults = [];
  if (one.missing.length > 0) faults.push(`its events lack ${one.missing.join(", ")}`);
  if (!one.holds) faults.push(`its number filter leaves out ${ROSIES}`);
  if (faults.length > 0) return [1, `FAIL: ${one.id}, the active subscription for ${OURS}: ${faults.join("; ")}`];
  return [0, `PASS: exactly one active subscription, ${one.id}, sends every event on the list (${events.length}) for ${ROSIES} to ${OURS}`];
}

// The new subscription in the create answer: the answer itself, or the object it holds it in.
function created(json) {
  if (!isObject(json)) return {};
  if ("signing_secret" in json || "id" in json) return json;
  for (const field of ["subscription", "data"]) if (isObject(json[field])) return json[field];
  return json;
}

// wrangler secret put LINQ_WEBHOOK_SECRET --env staging through cf.sh, the secret on its standard input alone. What it
// prints, on both streams, is kept here.
function put(secret) {
  return new Promise((resolve) => {
    const child = spawn("bash", [cf, "secret", "put", "LINQ_WEBHOOK_SECRET", "--env", "staging"], {
      env: { ...process.env, WRANGLER_LOG_SANITIZE: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const said = [];
    child.stdout.on("data", (chunk) => said.push(chunk));
    child.stderr.on("data", (chunk) => said.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", () => resolve({ code: null, said: "" }));
    child.on("close", (code) => resolve({ code, said: Buffer.concat(said).toString("utf8") }));
    child.stdin.end(secret);
  });
}

async function main() {
  if (!PLAIN.test(key) || !E164.test(number)) {
    err("refused: the key or the number did not reach the program in its form; nothing was asked of Linq");
    return 1;
  }
  out(`${OURS}: ${route}`);
  const listed = await linq("GET", null);
  if (!answered(listed)) {
    err(`${failure("the list of webhook subscriptions", listed)}; nothing was created or changed`);
    return 1;
  }
  if (!isObject(listed.json) || !Array.isArray(listed.json.subscriptions)) {
    err("refused: Linq answered the list with no subscriptions list ({ subscriptions: [...] }, as its documents give it); nothing was created or changed");
    return 1;
  }
  const subs = listed.json.subscriptions.map(read);
  out(`Linq lists ${subs.length} webhook subscription${subs.length === 1 ? "" : "s"}${subs.length === 0 ? "" : ":"}`);
  for (const sub of subs) out(`  ${sub.line}`);
  if (mode === "check") {
    const [code, line] = verdict(subs);
    out(line);
    return code;
  }

  const already = subs.filter((sub) => sub.ours && sub.active);
  if (already.length > 0) {
    const ids = already.map((sub) => sub.id).join(", ");
    err(`refused: ${ids} already sends to ${OURS} and is active, so --create makes no second one (npm run linq:staging:check says whether it is right); nothing was created`);
    return 1;
  }
  const made = await linq("POST", { target_url: route, subscribed_events: events, phone_numbers: [number] });
  if (!answered(made)) {
    err(`${failure("the create", made)}: whether a subscription was made is not known (npm run linq:staging:check lists them), and nothing was put on staging`);
    return 1;
  }
  const sub = created(made.json);
  const id = shownId(sub.id);
  const remove = id === shownId(undefined)
    ? `npm run linq:staging:check lists the subscriptions; delete the new one by its id with ${LINQS_KEY}`
    : `DELETE ${api}/webhook-subscriptions/${encodeURIComponent(sub.id)} with the header Authorization: Bearer and ${LINQS_KEY} (LINQ_API_TOKEN, never shown)`;
  let secret = typeof sub.signing_secret === "string" ? sub.signing_secret : "";
  if (!PLAIN.test(secret)) {
    secret = "";
    err(`FAILED: Linq made ${id} for ${OURS}, but its answer held no signing_secret staging can hold (no part of it is shown), and Linq gives it only once, so staging could not check its webhooks. Delete ${id}, then run --create again: ${remove}`);
    return 1;
  }
  out(`created ${id}: ${OURS}, the ${events.length} events on the list, ${ROSIES} alone`);
  const done = await put(secret);
  if (done.code !== 0) {
    let said = done.said.split(secret).join("[value not shown]");
    if (secret.startsWith("whsec_") && secret.length > 6) said = said.split(secret.slice(6)).join("[value not shown]");
    secret = "";
    if (said.trim() !== "") process.stderr.write(said.endsWith("\n") ? said : `${said}\n`);
    err(`FAILED: wrangler secret put LINQ_WEBHOOK_SECRET --env staging failed (exit ${done.code === null ? "none" : done.code}, for the reason above): staging does not hold the signing secret of ${id}, and Linq gives it only once. Delete ${id}, then, once the cause is fixed, run --create again. The call that deletes it: ${remove}`);
    return 1;
  }
  const form = SECRET_FORM.test(secret) && secret.length > "whsec_".length;
  secret = "";
  out("LINQ_WEBHOOK_SECRET set");
  if (!form) {
    err(`NOT PASS: staging holds the signing secret of ${id} as LINQ_WEBHOOK_SECRET, but it is not whsec_ and base64 (no part of it is shown), the one form the gateway verify takes (adapters/src/shared/hmac.ts), so the webhooks Linq sends are refused (401) until the verify takes this form`);
    return 1;
  }
  out(`PASS: ${id} sends the ${events.length} events on the list for ${ROSIES} to ${OURS}, and staging holds its signing secret as LINQ_WEBHOOK_SECRET`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    err("failed (no detail is shown: it could hold a value)");
    process.exitCode = 1;
  },
);
'

# The values, one a line, on node's standard input alone (printf is a builtin, so no command's arguments hold them).
status=0
printf '%s\n' "$key" "$number" | node -e "$PROGRAM" "$mode" "$route" "$LINQ_API_BASE" "$CF" "${EVENTS[@]}" ||
  status=$?
key=""
number=""
exit "$status"
