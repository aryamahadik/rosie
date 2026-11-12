#!/usr/bin/env bash
# Wrangler with the Rosfield sign-in and the guards (factory spec 2 and 6; DL-024). Every wrangler command
# goes through here: npm run cf -- <wrangler arguments>. It runs this checkout's wrangler with the Rosfield
# sign-in kept in ~/.config/rosfield (apart from the Mac's default wrangler login), always with
# --config <checkout>/wrangler.jsonc, so wrangler reads exactly the file checked here (no search of parent
# folders, no .wrangler/deploy redirect, no autoconfig). Before wrangler starts, it refuses (wrangler 4.158):
#  - another account or Worker in the config: CLOUDFLARE_ACCOUNT_ID (when set) and every account_id in
#    wrangler.jsonc must be the Rosfield account, and env.staging.name must be exactly rosie-staging;
#  - anything that picks another Worker, config or environment: --name, --worker-name, --config/-c, --cwd,
#    --env-file, --experimental-new-config (--x-new-config), --route(s) and --domain(s), in any spelling
#    (--x=y, camelCase, --no-x, after --), and combined or attached short options (-yc, -cfile);
#    WRANGLER_CI_OVERRIDE_NAME (wrangler's only Worker-name override variable) or any other WRANGLER_*_NAME
#    when set at all; CLOUDFLARE_ENV other than staging; and the .env files wrangler loads into its own
#    environment (.env, .env.local, .env.staging, .env.staging.local);
#  - --env other than staging, or given twice, and a command that changes a Worker without --env staging
#    (deploy, versions upload, versions deploy, rollback, secret, triggers deploy, preview);
#  - delete, in any command (no script deletes anything).
# CF_BUILD_DIR (deploy-preview.sh sets it to a branch's temporary worktree): run there, with that folder's
# wrangler.jsonc checked the same way and still this checkout's wrangler; only for versions upload.
# Tracing, allexport and keyword are switched off first, whatever the caller's shell asked for (T-1261), as
# make-staging-secrets.sh and put-staging-secrets.sh do: the note above `unset -v` below.
set +x
set +a
set +k
set -euo pipefail
# No variable of cf.sh's own starts out marked for export, or with the caller's text in it, whatever names the
# caller's environment holds. bash marks every variable it inherits for export, and under allexport (bash -a, or
# handed down in SHELLOPTS) every variable as it is set; a variable marked so goes to every command started from
# here, node and wrangler among them, with whatever it holds then (an argument, a word of one, a path). Under
# keyword (bash -k, or handed down in SHELLOPTS) an assignment anywhere on a command line goes to that command's
# environment instead: the two `export NAME=value` lines below would run as bare exports, which print every
# exported variable, and wrangler would start without the Rosfield sign-in and account; lib.sh's `local name=...`
# would declare nothing. So allexport and keyword are switched off above, and every name cf.sh and lib.sh keep a
# variable of their own under is dropped here, before anything is read or sourced: lib.sh's ROOT and CF, the fixed
# texts in capitals, and the rest (paths, the arguments and their words, counts). The variables cf.sh reads from
# the caller (CF_BUILD_DIR, CLOUDFLARE_ENV, CLOUDFLARE_ACCOUNT_ID, the WRANGLER_*_NAME overrides) are not its own,
# and are checked below as they are. A new variable here goes on these lines too: cf.test.mjs fails until it does.
unset -v ROOT CF ROSFIELD_ACCOUNT_ID STAGING_WORKER dir config variable arg key env_name env_count words expect
unset -v ended changes_worker command_words word why file wrangler
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROSFIELD_ACCOUNT_ID="ecb06e7bc9129fa81104d331e9652362"
STAGING_WORKER="rosie-staging"

refuse() {
  die "refused: $*"
}

# The folder wrangler runs in and the config it reads.
dir="$ROOT"
if [[ -n "${CF_BUILD_DIR:-}" ]]; then
  [[ -d "$CF_BUILD_DIR" ]] || refuse "CF_BUILD_DIR ($CF_BUILD_DIR) is not a folder"
  dir="$(cd "$CF_BUILD_DIR" && pwd -P)"
fi
config="$dir/wrangler.jsonc"

# Variables wrangler reads that would change the account, the Worker or the environment.
if [[ -n "${WRANGLER_CI_OVERRIDE_NAME+set}" ]]; then
  refuse "WRANGLER_CI_OVERRIDE_NAME is set: wrangler would use it as the Worker name instead of" \
    "wrangler.jsonc's (unset it)"
fi
for variable in $(compgen -e); do
  case "$variable" in
    WRANGLER_*_NAME) refuse "$variable is set: a wrangler name override is never used from here (unset it)" ;;
  esac
done
if [[ -n "${CLOUDFLARE_ENV:-}" && "$CLOUDFLARE_ENV" != "staging" ]]; then
  refuse "CLOUDFLARE_ENV=$CLOUDFLARE_ENV: only staging is run from here"
fi
if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && "$CLOUDFLARE_ACCOUNT_ID" != "$ROSFIELD_ACCOUNT_ID" ]]; then
  refuse "CLOUDFLARE_ACCOUNT_ID is not the Rosfield account"
fi

# Options that pick another Worker, config or environment, wherever they are (values and after -- included).
for arg in "$@"; do
  case "$arg" in
    -- | -) ;;
    --?*)
      # The option's name as wrangler's parser (yargs) reads it: without =value or .key, camelCase as kebab
      # case, and without the no- of a negation.
      key="$(printf '%s' "${arg%%=*}" | sed -E 's/^-+//; s/\..*$//; s/([A-Z])/-\1/g')"
      key="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
      key="${key#-}"
      key="${key#no-}"
      case "$key" in
        name | worker-name)
          refuse "$arg: the Worker name comes only from wrangler.jsonc ($STAGING_WORKER with --env staging)"
          ;;
        config | cwd | experimental-new-config | x-new-config)
          refuse "$arg: wrangler reads only $config"
          ;;
        env-file)
          refuse "$arg: a variables file could set WRANGLER_CI_OVERRIDE_NAME or CLOUDFLARE_ENV" \
            "past these checks"
          ;;
        route | routes | domain | domains)
          refuse "$arg: routes and custom domains come only from wrangler.jsonc"
          ;;
      esac
      ;;
    -c*) refuse "$arg: wrangler reads only $config" ;;
    -? | -e=*) ;;
    -*) refuse "$arg: combined or attached short options are not accepted here; give each one on its own" ;;
  esac
done

# The --env value and the positional arguments (wrangler's command words come first). The values of the
# options listed are skipped, so a preview alias or a rollback message is never read as a command word.
env_name=""
env_count=0
words=()
expect=""
ended=""
for arg in "$@"; do
  if [[ -n "$expect" ]]; then
    if [[ "$expect" == "env" ]]; then
      env_name="$arg"
    fi
    expect=""
    continue
  fi
  if [[ -n "$ended" ]]; then
    words+=("$arg")
    continue
  fi
  case "$arg" in
    --) ended=1 ;;
    --env=* | -e=*)
      env_name="${arg#*=}"
      env_count=$((env_count + 1))
      ;;
    --env | -e)
      expect="env"
      env_count=$((env_count + 1))
      ;;
    --var | --define | --alias | --preview-alias | --message | --tag | --outdir | --outfile | --profile | \
      --compatibility-date | --compatibility-flag | --compatibility-flags | --format | --search | --status | \
      --header | --method | --sampling-rate | --ip | --binding | --namespace-id | --secrets-file)
      expect="value"
      ;;
    -*) ;;
    *) words+=("$arg") ;;
  esac
done
if [[ "$expect" == "env" ]]; then
  env_name=""
fi

if ((env_count > 1)); then
  refuse "--env is given more than once"
fi
if ((env_count == 1)) && [[ "$env_name" != "staging" ]]; then
  if [[ "$env_name" == "production" ]]; then
    refuse "--env production is never run from here (no production deploy exists in D-000)"
  fi
  refuse "--env ${env_name:-(empty)}: only --env staging is run from here (an empty --env is production)"
fi

changes_worker="" # the command words up to the first one that changes a Worker, as in "versions upload"
command_words=""
for word in ${words[@]+"${words[@]}"}; do
  if [[ "$word" == "delete" ]]; then
    refuse "delete: nothing is deleted through here (no script needs it)"
  fi
  if [[ -z "$changes_worker" ]]; then
    command_words="${command_words:+$command_words }$word"
    case "$word" in
      deploy | upload | rollback | secret | preview) changes_worker="$command_words" ;;
    esac
  fi
done
if [[ -n "$changes_worker" && "$env_name" != "staging" ]]; then
  refuse "wrangler $changes_worker needs --env staging: only staging is changed from here"
fi
if [[ -n "${CF_BUILD_DIR:-}" && -n "$changes_worker" && "$changes_worker" != "versions upload" ]]; then
  refuse "CF_BUILD_DIR is only for versions upload (a branch preview), not for wrangler $changes_worker"
fi

# check_config <wrangler.jsonc>: prints why the file is refused, if it is. Comments and trailing commas are
# dropped as wrangler drops them (outside strings); anything else that is not JSON is refused.
check_config() {
  node -e '
    const fs = require("node:fs");
    const [file, account, stagingWorker] = process.argv.slice(1);
    const fail = (why) => {
      console.log(`${file}: ${why}`);
      process.exit(1);
    };
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      fail("cannot be read");
    }
    let json = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "\"") {
        let j = i + 1;
        while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
        json += text.slice(i, j + 1);
        i = j;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("a /* comment is not closed");
        json += " ";
        i = end + 1;
      } else if (c === "}" || c === "]") {
        json = json.replace(/,\s*$/, "") + c;
      } else {
        json += c;
      }
    }
    let config;
    try {
      config = JSON.parse(json);
    } catch (error) {
      fail(`does not parse (${error.message})`);
    }
    const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!isObject(config)) fail("is not an object");
    if (config.account_id !== account) fail(`account_id must be the Rosfield account ${account}`);
    const envs = config.env ?? {};
    if (!isObject(envs)) fail("env is not an object");
    for (const [name, env] of Object.entries(envs)) {
      if (isObject(env) && "account_id" in env && env.account_id !== account) {
        fail(`env.${name}.account_id must be the Rosfield account ${account}`);
      }
    }
    if (!isObject(envs.staging)) fail("env.staging is missing");
    if (envs.staging.name !== stagingWorker) {
      fail(`env.staging.name is ${JSON.stringify(envs.staging.name)}; it must be exactly ${stagingWorker}`);
    }
  ' "$1" "$ROSFIELD_ACCOUNT_ID" "$STAGING_WORKER"
}
if ! why="$(check_config "$config")"; then
  refuse "$why"
fi

for file in .env .env.local .env.staging .env.staging.local; do
  if [[ -e "$dir/$file" || -L "$dir/$file" ]]; then
    refuse "$dir/$file exists: wrangler would load it into its own environment, past these checks" \
      "(move it away)"
  fi
done

export CLOUDFLARE_ACCOUNT_ID="$ROSFIELD_ACCOUNT_ID"
export XDG_CONFIG_HOME="$HOME/.config/rosfield"
unset CF_BUILD_DIR

wrangler="$ROOT/node_modules/.bin/wrangler"
[[ -x "$wrangler" ]] || die "wrangler is not installed: run npm ci"
cd "$dir"
exec "$wrangler" --config "$config" "$@"
