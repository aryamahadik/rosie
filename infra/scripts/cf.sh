#!/usr/bin/env bash
# Wrangler with the Rosfield sign-in and the account guard (factory spec 2 and 6). Every local wrangler command
# goes through here: npm run cf -- <wrangler arguments>.
#  - Refuses to run unless CLOUDFLARE_ACCOUNT_ID (when set) and wrangler.jsonc's account_id are the Rosfield
#    account.
#  - Locally, uses the Rosfield sign-in kept in ~/.config/rosfield (apart from the Mac's default wrangler login);
#    in CI, wrangler uses the CLOUDFLARE_API_TOKEN secret.
#  - Staging only: a command that changes a Worker needs --env staging, and --env production is always refused.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

ROSFIELD_ACCOUNT_ID="ecb06e7bc9129fa81104d331e9652362"

if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && "$CLOUDFLARE_ACCOUNT_ID" != "$ROSFIELD_ACCOUNT_ID" ]]; then
  die "CLOUDFLARE_ACCOUNT_ID is not the Rosfield account; refusing to run"
fi
pinned="$(grep -vE '^[[:space:]]*//' wrangler.jsonc |
  grep -oE '"account_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*"([^"]*)"$/\1/' | sort -u || true)"
if [[ "$pinned" != "$ROSFIELD_ACCOUNT_ID" ]]; then
  die "wrangler.jsonc must pin account_id to the Rosfield account; refusing to run"
fi
export CLOUDFLARE_ACCOUNT_ID="$ROSFIELD_ACCOUNT_ID"

if [[ -z "${CI:-}" ]]; then
  export XDG_CONFIG_HOME="$HOME/.config/rosfield"
fi

# Find the wrangler command, its subcommand and the --env value.
command_words=""
env_name=""
expect_value=""
for arg in "$@"; do
  if [[ -n "$expect_value" ]]; then
    [[ "$expect_value" == "env" ]] && env_name="$arg"
    expect_value=""
    continue
  fi
  case "$arg" in
    --env=* | -e=*) env_name="${arg#*=}" ;;
    --env | -e) expect_value="env" ;;
    --config | -c | --cwd | --env-file | --profile) expect_value="other" ;;
    -*) ;;
    *) command_words="$command_words $arg" ;;
  esac
done
read -r cmd sub _ <<<"$command_words" || true

if [[ "$env_name" == "production" ]]; then
  die "--env production is never run from here (no production deploy exists in D-000)"
fi
case "${cmd:-} ${sub:-}" in
  "deploy "* | "rollback "* | "delete "* | "secret "* | "versions upload" | "versions deploy" | \
    "versions secret" | "triggers deploy")
    if [[ "$env_name" != "staging" ]]; then
      die "wrangler $cmd needs --env staging: only staging is deployed from here"
    fi
    ;;
esac

[[ -x "$ROOT/node_modules/.bin/wrangler" ]] || die "wrangler is not installed: run npm ci"
exec "$ROOT/node_modules/.bin/wrangler" "$@"
