#!/usr/bin/env bash
# Preview of one branch (factory spec 6; build prompt 5.3): npm run deploy:preview -- <branch>
#  1. migrations into the branch's own schema on the staging database, when STAGING_DATABASE_URL is set
#     (skipped with a notice when it is not);
#  2. a Worker version uploaded to rosie-staging under the preview alias <slug>, with DB_SCHEMA and GIT_SHA set
#     (an upload, not a deploy: staging traffic keeps its current version);
#  3. the preview URL printed, and given to GitHub Actions as the step output preview_url.
# <slug>: the branch in lower case, [a-z0-9-] only, at most 40 characters. Schema: preview_<slug> with "_" for "-".
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

[[ $# -eq 1 && -n "$1" ]] || die "usage: deploy-preview.sh <branch>"
branch="$1"
slug="$(branch_slug "$branch")"
schema="$(preview_schema "$slug")"
sha="$(git_sha)"
log "preview: branch $branch, alias $slug, schema $schema, commit $sha"

load_dev_var STAGING_DATABASE_URL
if [[ -n "${STAGING_DATABASE_URL:-}" ]]; then
  log "preview: migrate schema $schema"
  DATABASE_URL="$STAGING_DATABASE_URL" DB_SCHEMA="$schema" node infra/scripts/migrate.mjs
else
  log "preview: NOTICE: STAGING_DATABASE_URL is not set, so no preview schema was migrated"
fi

output="$(mktemp)"
trap 'rm -f "$output"' EXIT
log "preview: upload a version of rosie-staging with alias $slug"
WRANGLER_OUTPUT_FILE_PATH="$output" "$CF" versions upload --env staging --preview-alias "$slug" \
  --var "DB_SCHEMA:$schema" --var "GIT_SHA:$sha"

url="$(wrangler_output "$output" version-upload preview_alias_url)"
if [[ -z "$url" ]]; then
  url="$(wrangler_output "$output" version-upload preview_url)"
fi
[[ -n "$url" ]] || die "wrangler reported no preview URL (is preview_urls on in wrangler.jsonc?)"
log "preview: ready"
echo "Preview URL: $url"
gh_output preview_url "$url"
gh_summary "Preview of \`$branch\` (schema \`$schema\`): $url"
