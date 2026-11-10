#!/usr/bin/env bash
# Creates the Cloudflare resources behind wrangler.jsonc's env.staging bindings (T-566; C-021; NQ-RT-5): the bundle KV
# namespace (BUNDLES) and the retry queue with its dead-letter queue (RETRY_QUEUE: 5 tries, then the dead-letter queue).
# The HandleActor Durable Object (its class migration) and the one-minute cron need nothing made here: the staging deploy
# makes them from wrangler.jsonc.
# Safe to run again: it lists what exists first and creates only what is missing, so a second run creates nothing and
# prints the existing ids. It never deletes or changes a resource and never writes wrangler.jsonc: the KV namespace's id
# goes into env.staging.kv_namespaces by a reviewed change.
# Wrangler runs only through cf.sh (the Rosfield sign-in and the pinned account). cf.sh refuses any other account id, in
# CLOUDFLARE_ACCOUNT_ID or in wrangler.jsonc, before wrangler starts, and the first call here is a read, so a refusal
# stops this script before anything is made. No call names --env: these resources belong to no Worker until a deploy
# binds them.
# Usage: bash infra/scripts/create-staging-bindings.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Keep in step with wrangler.jsonc's env.staging: kv_namespaces (BUNDLES) and queues (RETRY_QUEUE and its consumer).
KV_TITLE="rosie-staging-bundles"
RETRY_QUEUE="rosie-retry"
DEAD_LETTER_QUEUE="rosie-retry-dlq"

# Prints the id of the KV namespace titled $1, or nothing. `kv namespace list` prints every namespace of the account as
# a JSON array of {id, title, ...}.
kv_id_of() {
  local listing status=0
  listing="$("$CF" kv namespace list)" || die "could not list the KV namespaces"
  node -e '
    const title = process.argv[1];
    const text = require("node:fs").readFileSync(0, "utf8");
    const start = text.search(/^\[/m);
    if (start < 0) process.exit(2);
    let list;
    try {
      list = JSON.parse(text.slice(start));
    } catch {
      process.exit(2);
    }
    if (!Array.isArray(list)) process.exit(2);
    const found = list.filter((item) => item !== null && typeof item === "object" && item.title === title);
    if (found.length > 1) process.exit(3);
    if (found.length === 1) {
      if (!/^[0-9a-f]{32}$/.test(String(found[0].id))) process.exit(2);
      console.log(found[0].id);
    }
  ' "$1" <<<"$listing" || status=$?
  case "$status" in
    0) ;;
    3) die "more than one KV namespace is titled $1" ;;
    *) die "could not read the KV namespace list" ;;
  esac
}

# Prints the id of the queue named $1, or nothing. `queues list` prints the account's queues as a table (cells between
# "│", with an "id" and a "name" column), and no table when there are none. It shows one page, and the account holds
# a handful of queues; a queue it missed is still never made twice, since Cloudflare refuses a second queue of the
# same name, which stops this script.
queue_id_of() {
  local listing status=0
  listing="$("$CF" queues list)" || die "could not list the queues"
  node -e '
    const name = process.argv[1];
    const text = require("node:fs").readFileSync(0, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
    const rows = text
      .split("\n")
      .filter((line) => line.startsWith("│"))
      .map((line) => line.split("│").slice(1, -1).map((cell) => cell.trim()));
    if (rows.length === 0) process.exit(0);
    const [head, ...data] = rows;
    const idAt = head.indexOf("id");
    const nameAt = head.indexOf("name");
    if (idAt < 0 || nameAt < 0) process.exit(2);
    const found = data.filter((row) => row[nameAt] === name);
    if (found.length > 1) process.exit(3);
    if (found.length === 1) {
      if (!/^[0-9A-Za-z-]+$/.test(found[0][idAt] ?? "")) process.exit(2);
      console.log(found[0][idAt]);
    }
  ' "$1" <<<"$listing" || status=$?
  case "$status" in
    0) ;;
    3) die "more than one queue is named $1" ;;
    *) die "could not read the queue list" ;;
  esac
}

# Makes the KV namespace KV_TITLE unless it exists; sets kv_id.
kv_id=""
ensure_kv() {
  local created
  kv_id="$(kv_id_of "$KV_TITLE")"
  if [[ -n "$kv_id" ]]; then
    log "KV namespace $KV_TITLE already exists: not created again (id $kv_id)"
    return 0
  fi
  log "KV namespace $KV_TITLE does not exist: creating it"
  # --update-config=false: wrangler never writes wrangler.jsonc from here.
  created="$("$CF" kv namespace create "$KV_TITLE" --update-config=false)" ||
    die "could not create the KV namespace $KV_TITLE"
  kv_id="$(kv_id_of "$KV_TITLE")"
  if [[ -z "$kv_id" ]]; then
    printf '%s\n' "$created" >&2
    die "wrangler made a KV namespace, but none is titled $KV_TITLE (wrangler's output is above)"
  fi
  log "KV namespace $KV_TITLE created (id $kv_id)"
}

# Makes the queue $1 unless it exists; sets queue_id.
queue_id=""
ensure_queue() {
  local name="$1"
  queue_id="$(queue_id_of "$name")"
  if [[ -n "$queue_id" ]]; then
    log "queue $name already exists: not created again (id $queue_id)"
    return 0
  fi
  log "queue $name does not exist: creating it"
  "$CF" queues create "$name" >/dev/null || die "could not create the queue $name"
  queue_id="$(queue_id_of "$name")"
  [[ -n "$queue_id" ]] || die "created the queue $name, but it is not in the queue list"
  log "queue $name created (id $queue_id)"
}

ensure_kv
# The dead-letter queue first: the retry queue's consumer names it.
ensure_queue "$DEAD_LETTER_QUEUE"
dead_letter_id="$queue_id"
ensure_queue "$RETRY_QUEUE"
retry_id="$queue_id"

log "staging bindings ready on the Rosfield account (wrangler.jsonc env.staging):"
log "  BUNDLES: KV namespace $KV_TITLE, id $kv_id"
log "  RETRY_QUEUE: queue $RETRY_QUEUE, id $retry_id; its dead-letter queue $DEAD_LETTER_QUEUE, id $dead_letter_id"
log "  HANDLE_ACTOR (class HandleActor, migration v1-handle-actor) and the one-minute cron: made by the staging deploy"
