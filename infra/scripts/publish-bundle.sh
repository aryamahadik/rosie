#!/usr/bin/env bash
# Publishing a bundle, then switching the active bundle id: deploy step 3 (build prompt 5.4; K-05 v1 item 7 and
# NQ-PB-5, whose setActiveBundle only this step calls; C-020; T-569).
#
#   bash infra/scripts/publish-bundle.sh [--env staging|local] [--record <file>] <bundle folder>
#     1. PostgreSQL's copy: `compiler publish` (T-152): the registry row, not active, and every part, each read back
#        by its key and compared byte for byte, and the KV bulk file, written to a temporary folder. The same bundle
#        again writes nothing new.
#     2. KV: on staging, the KV bulk file goes into the BUNDLES namespace through cf.sh (wrangler kv bulk put
#        --binding BUNDLES --env staging --remote). Local has no KV namespace (the Worker reads PostgreSQL's copy on a
#        KV miss), so the step is skipped there.
#     3. The active bundle id: K-05 setActiveBundle, compare-and-set against the id read before step 1; then
#        readActiveBundle must return the bundle's id.
#     A step that fails stops the script with a non-zero exit, and nothing after it runs. The active id changes only
#     in step 3, in one transaction, so a failed publish leaves the old active id.
#     <bundle folder>: a folder `compiler build` wrote (manifest.json in it), or one that holds it as bundle/, as
#     bundles/v0 does. Whatever it holds is published; the script names no bundle id.
#   bash infra/scripts/publish-bundle.sh [--env staging|local] [--record <file>] --activate <hash>/<build>
#     makes a bundle published before the active one again: a bundle rollback is the same switch with the earlier id
#     (K-05; tour line 658). An id never published is refused (notPublished), and nothing changes.
#   bash infra/scripts/publish-bundle.sh [--env staging|local] --status
#     prints the active bundle id.
# --record <file>: right after a switch, {"before": <id, or null when none was active>, "after": <id>} as JSON, for
# deploy-staging.sh's undo.
# The database, as in flags.sh:
#   --env staging (the default)  the staging database: STAGING_DATABASE_URL, from the environment, else .dev.vars; its
#                                public schema. While it is not set (J-06) the script refuses.
#   --env local                  the local database: DATABASE_URL (only a host on this machine), else the local Docker
#                                database of infra/docker-compose.yml; DB_SCHEMA as set.
#   --env production             refused, as is any other name: production's bundle is switched only by the protected
#                                release job, after Jay or the CTO acts from his own login (build prompt 5.4).
# Nothing here prints the database URL or any part of it (its user, password, host, port or database name): the URL
# is checked before anything reads it, a URL that does not parse is refused with its fault named, and a failed
# database call is printed with every part of the URL taken out (the registry program below, through
# infra/scripts/db-url.mjs, which migrate.mjs and flags.sh use too).
# Nor does any command but the registry program's database calls get the URL (T-1343; read as deploy-preview.sh reads
# it, T-1310): STAGING_DATABASE_URL and DATABASE_URL leave this shell's environment before anything is started (dirname
# included), each kept in a variable of the script's own that is never marked for export (.dev.vars' line is read the
# same way). Each run of the registry program but manifest-id gets the URL --env picks, as DATABASE_URL on its command
# line (registry, below); manifest-id, cf.sh and wrangler, and every other command get none. Tracing, allexport and
# keyword are switched off first, whatever the caller's shell asked for: a trace would print the URL, allexport would
# mark the variables for export, and under keyword lib.sh's `local name=...` would declare nothing (as
# make-staging-secrets.sh explains, T-1236).
set +x
set +a
set +k
set -euo pipefail
# The variables that hold a URL are dropped before they are set: bash marks every variable it inherits for export, so one
# of the same name in the caller's environment would make it an exported one.
unset -v staging_url local_url db_url LOCAL_DATABASE_URL
staging_url="${STAGING_DATABASE_URL:-}"
local_url="${DATABASE_URL:-}"
unset -v STAGING_DATABASE_URL DATABASE_URL DATABASE_REPLICA_URL
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The local Docker database (factory spec 4): local only, not a secret.
LOCAL_DATABASE_URL="postgres://rosie:rosie@127.0.0.1:54329/rosie"
# A connection string whose host is this machine (--env local writes no other).
LOCAL_HOST_URL='^postgres(ql)?://([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$)'
BUNDLE_ID='^[0-9a-f]{64}/[1-9][0-9]{0,8}$'
USAGE="usage: publish-bundle.sh [--env staging|local] [--record <file>] (<bundle folder> | --activate <hash>/<build> | --status)"

env_name="staging"
env_count=0
record=""
action=""
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || die "--env needs a name: staging (the default) or local"
      env_name="$2"
      env_count=$((env_count + 1))
      shift 2
      ;;
    --env=*)
      env_name="${1#*=}"
      env_count=$((env_count + 1))
      shift
      ;;
    --record)
      [[ $# -ge 2 && -n "$2" ]] || die "--record needs a file"
      record="$2"
      shift 2
      ;;
    --activate)
      [[ $# -ge 2 && -z "$action" ]] || die "$USAGE"
      action="activate"
      target="$2"
      shift 2
      ;;
    --status)
      [[ -z "$action" ]] || die "$USAGE"
      action="status"
      shift
      ;;
    -*)
      die "unknown option $1; $USAGE"
      ;;
    *)
      [[ -z "$action" ]] || die "$USAGE"
      action="publish"
      target="$1"
      shift
      ;;
  esac
done
if [[ "$env_name" == "production" ]]; then
  die "refused: --env production is never run from here: production's bundle is published and switched only by" \
    "the protected release job, after Jay or the CTO acts from his own login (build prompt 5.4)"
fi
((env_count <= 1)) || die "refused: --env is given more than once"
[[ -n "$action" ]] || die "$USAGE"
# Paths from the command line are read from the folder the script was started in.
if [[ "$action" == "publish" && "$target" != /* ]]; then
  target="$PWD/$target"
fi
if [[ -n "$record" && "$record" != /* ]]; then
  record="$PWD/$record"
fi

case "$env_name" in
  staging)
    # From .dev.vars by name when the environment gave none: load_dev_var exports what it reads, so the name is unset
    # again at once, before any command is started.
    if [[ -z "$staging_url" ]]; then
      load_dev_var STAGING_DATABASE_URL
      staging_url="${STAGING_DATABASE_URL:-}"
      unset -v STAGING_DATABASE_URL
    fi
    [[ -n "$staging_url" ]] ||
      die "refused: STAGING_DATABASE_URL is not set: staging has no database yet (J-06) to hold the active bundle" \
        "id; for the local database, use --env local"
    db_url="$staging_url"
    db_schema=""
    where="the staging database"
    ;;
  local)
    db_url="${local_url:-$LOCAL_DATABASE_URL}"
    [[ "$db_url" =~ $LOCAL_HOST_URL ]] ||
      die "refused: --env local writes only a database on this machine (127.0.0.1, localhost or ::1), and" \
        "DATABASE_URL names another host"
    db_schema="${DB_SCHEMA:-}"
    where="the local database${db_schema:+, schema $db_schema}"
    ;;
  *)
    die "refused: --env ${env_name:-(empty)}: only --env staging (the default) or --env local"
    ;;
esac
cd "$ROOT"

# The registry's calls (db/repo/bundles.ts: K-05 v1 item 7) and the compiler's publish command, run by node on the
# database of DATABASE_URL and DB_SCHEMA. Arguments: <root> <env name> <command> [arguments]. Commands:
# manifest-id <bundle dir>; active (the id, or none); status; publish <bundle dir> <KV bulk file>;
# activate <id> <the id read before, or none> [<record file>].
# db/repo/client.ts imports its neighbours without an extension, so a relative import from a .ts file is completed
# with .ts or /index.ts, as compiler/src/cli/commands/publish.ts does.
# The database URL (the security reviews of rounds 1 and 2; DL-356, DL-363): every command but manifest-id runs in one
# try. It first checks the URL (infra/scripts/db-url.mjs), then builds the client, or runs compiler publish, whose own
# client reads the same URL. Its catch prints the fault alone: a URL that does not parse is refused by name, and any
# other error is printed with every part of the URL taken out, as is each error line of compiler publish. postgres.js
# would otherwise throw a URL error whose input property holds the whole string, password included, and Node prints
# that property for an error not caught.
REGISTRY='
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? "";
      if (!/^\.\.?\//.test(specifier) || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // not this form: try the next one
        }
      }
      throw error;
    }
  },
});

const [root, envName, command, ...args] = process.argv.slice(1);
const load = (file) => import(pathToFileURL(root + "/" + file).href);
const { DatabaseUrlFault, checkDatabaseUrl, describeError, printStrayErrors, scrub } = await load(
  "infra/scripts/db-url.mjs",
);
const say = (line) => console.log(`[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] ${line}`);
const label = (id) => `${id.hash}/${String(id.build)}`;
const idOf = (text) => {
  const match = /^([0-9a-f]{64})\/([1-9][0-9]{0,8})$/.exec(text);
  if (match === null) throw new Error(`"${text}" is not a bundle id (<hash>/<build>)`);
  return { hash: match[1], build: Number(match[2]) };
};
const fail = (line) => {
  console.error(`publish-bundle.sh: ${line}`);
  process.exitCode = 1;
};

// The parts of the URL taken out of every error line: the whole string until the URL is checked, then each part
// (db-url.mjs). An error that no catch below takes (a stray rejection) is printed the same way, never its fields.
let secrets = [process.env.DATABASE_URL ?? ""];
printStrayErrors("publish-bundle.sh", () => secrets);

/** The registry commands (active, status, activate) on `sql`, through K-05 readActiveBundle and setActiveBundle. */
async function registryCall(sql, { readActiveBundle, setActiveBundle }) {
  const active = await readActiveBundle(sql);
  if ("error" in active && active.error === "transient") {
    fail(`refused: PostgreSQL could not answer now (K-05 readActiveBundle: transient, SQLSTATE ${active.sqlstate}); nothing changed; run it again`);
  } else if (command === "active") {
    console.log("result" in active ? label(active.bundleId) : "none");
  } else if (command === "status") {
    say("result" in active ? `active bundle id: ${label(active.bundleId)} (active since ${active.activatedAt})` : "active bundle id: none (K-05 readActiveBundle: noActiveBundle)");
  } else if (command === "activate") {
    const [wanted, expected, record] = args;
    const answer = await setActiveBundle(sql, {
      bundleId: idOf(wanted),
      expectActive: expected === "none" ? null : idOf(expected),
      at: new Date().toISOString(),
    });
    if (answer.error === "notPublished") {
      fail(`refused: bundle ${wanted} is not published (K-05 setActiveBundle: notPublished); the active bundle id stays ${expected}`);
    } else if (answer.error === "activeChanged") {
      fail(`refused: the active bundle id is ${answer.active === null ? "none" : label(answer.active)}, not ${expected} as read before (K-05 setActiveBundle: activeChanged); nothing switched`);
    } else if (answer.error !== undefined) {
      fail(`refused: PostgreSQL could not answer now (K-05 setActiveBundle: transient, SQLSTATE ${answer.sqlstate}); nothing switched; run it again`);
    } else {
      const before = answer.repeated ? wanted : expected === "none" ? null : expected;
      if (record) writeFileSync(record, `${JSON.stringify({ before, after: wanted })}\n`);
      say(answer.repeated ? `active bundle id: ${wanted}, already active (K-05 setActiveBundle: repeated)` : `active bundle id: ${expected} -> ${wanted} (K-05 setActiveBundle)`);
      const now = await readActiveBundle(sql);
      if ("result" in now && label(now.bundleId) === wanted) say(`readActiveBundle: ${wanted} (active since ${now.activatedAt})`);
      else fail(`readActiveBundle after the switch does not return ${wanted}`);
    }
  } else {
    fail(`unknown registry command ${command}`);
  }
}

if (command === "manifest-id") {
  const manifest = JSON.parse(readFileSync(`${args[0]}/manifest.json`, "utf8"));
  console.log(label(idOf(label(manifest.bundleId ?? {}))));
} else {
  let db;
  try {
    secrets = checkDatabaseUrl(process.env.DATABASE_URL ?? "");
    if (command === "publish") {
      const { command: publish } = await load("compiler/src/cli/commands/publish.ts");
      const io = { out: (line) => console.log(line), err: (line) => console.error(scrub(line, secrets)) };
      process.exitCode = await publish.run([args[0], "--kv", args[1]], io);
    } else {
      const { createClient } = await load("db/repo/client.ts");
      const calls = await load("db/repo/bundles.ts");
      db = createClient({ max: 1 });
      await registryCall(db.primary, calls);
    }
  } catch (error) {
    if (error instanceof DatabaseUrlFault) {
      fail(`refused: the ${envName} database URL does not parse: ${error.message}; nothing was read or written`);
    } else {
      fail(`the database call failed${describeError(error, secrets)}`);
    }
  } finally {
    await db?.close().catch((error) => fail(`closing the database client failed${describeError(error, secrets)}`));
  }
}
'

# registry <command> [arguments]: the program above, on the database --env names, whose URL it gets as DATABASE_URL on
# its command line alone; manifest-id reads the bundle folder alone, and gets no URL.
registry() {
  if [[ "$1" == "manifest-id" ]]; then
    DB_SCHEMA="$db_schema" node --disable-warning=ExperimentalWarning --input-type=module -e "$REGISTRY" "$ROOT" \
      "$env_name" "$@"
  else
    DATABASE_URL="$db_url" DB_SCHEMA="$db_schema" node --disable-warning=ExperimentalWarning --input-type=module \
      -e "$REGISTRY" "$ROOT" "$env_name" "$@"
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$action" in
  status)
    registry status
    ;;
  activate)
    [[ "$target" =~ $BUNDLE_ID ]] || die "--activate takes a bundle id, <hash>/<build>"
    before="$(registry active)"
    log "publish-bundle: on $where, switch the active bundle id to $target (active now: $before)"
    registry activate "$target" "$before" "$record"
    ;;
  publish)
    if [[ -f "$target/manifest.json" ]]; then
      bundle="$target"
    elif [[ -f "$target/bundle/manifest.json" ]]; then
      bundle="$target/bundle"
    else
      die "$target holds no bundle: no manifest.json in it or in its bundle/ folder"
    fi
    id="$(registry manifest-id "$bundle")"
    before="$(registry active)"
    log "publish-bundle: bundle $id from $bundle, on $where (active now: $before)"
    log "step 1/3 PostgreSQL's copy: compiler publish"
    registry publish "$bundle" "$work/bundle.kv.json"
    log "step 1/3: done"
    if [[ "$env_name" == "staging" ]]; then
      log "step 2/3 KV: wrangler kv bulk put --binding BUNDLES --env staging --remote"
      "$CF" kv bulk put "$work/bundle.kv.json" --binding BUNDLES --env staging --remote
      log "step 2/3: done"
    else
      log "step 2/3 KV: skipped (local has no KV namespace; the Worker reads PostgreSQL's copy on a KV miss)"
    fi
    log "step 3/3 the active bundle id: $before -> $id"
    registry activate "$id" "$before" "$record"
    log "publish-bundle: done, bundle $id is the active bundle on $where"
    ;;
esac
