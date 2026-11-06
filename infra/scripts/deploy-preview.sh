#!/usr/bin/env bash
# Preview of one branch (factory spec 6; build prompt 5.3; DL-024): npm run deploy:preview -- <branch>
# Runs on the build Mac, where the Rosfield sign-in is, before anyone has reviewed the branch, so nothing of
# the branch's runs here unreviewed: its install scripts are skipped, its infra/ (migrate.mjs, cf.sh) must be
# unchanged from origin/main, and the upload uses this checkout's cf.sh and wrangler. Its code runs only on
# Cloudflare (the preview), and its migrations run with its own schema as the search path. It deploys the
# branch's pushed commit, never this checkout's files:
#  0. it fetches origin/<branch> and origin/main and refuses the branch, listing the files, when its own
#     changes (its diff against origin/main from their merge base, as in a pull request) touch a file that
#     controls the install, the build or the deploy: wrangler.jsonc (or a wrangler.json or wrangler.toml),
#     infra/, .github/, any package.json, package-lock.json or npm-shrinkwrap.json, .npmrc. The lead reviews
#     that diff and reruns with PREVIEW_ALLOW_INFRA=1 to preview it anyway;
#  1. it checks that commit out in a temporary worktree (removed afterwards) and installs it with
#     npm ci --ignore-scripts, so no install script runs;
#  2. migrations into the branch's own schema on the staging database, when STAGING_DATABASE_URL is set
#     (skipped with a notice when it is not);
#  3. a Worker version of that commit uploaded to rosie-staging under the preview alias <slug> by THIS
#     checkout's cf.sh and wrangler (never the branch's), with CF_BUILD_DIR=<worktree>: cf.sh checks the
#     worktree's wrangler.jsonc as it checks its own, then uploads from there with DB_SCHEMA and GIT_SHA (that
#     commit) set (an upload, not a deploy: staging traffic keeps its current version);
#  4. the preview URL printed.
# <slug>: the branch in lower case, [a-z0-9-] only, at most 40 characters. Schema: preview_<slug> with "_"
# for "-".
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

[[ $# -eq 1 && -n "$1" ]] || die "usage: deploy-preview.sh <branch>"
branch="$1"
git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "\"$branch\" is not a valid branch name"
slug="$(branch_slug "$branch")"
schema="$(preview_schema "$slug")"

# The files whose changes the lead reviews before a preview runs the branch's install and build here.
GUARDED_PATHS=(wrangler.jsonc wrangler.json wrangler.toml infra .github .npmrc
  ':(glob)**/package.json' ':(glob)**/package-lock.json' ':(glob)**/npm-shrinkwrap.json')

work="$(mktemp -d)"
tree="$work/tree"
cleanup() {
  if [[ -e "$tree" ]] && ! git -C "$ROOT" worktree remove --force "$tree" >/dev/null 2>&1; then
    rm -rf "$tree"
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

log "preview: fetch $branch and main from origin (a preview carries only what is pushed)"
git -C "$ROOT" fetch --quiet origin "+refs/heads/$branch:refs/remotes/origin/$branch" ||
  die "could not fetch $branch from origin; push it first"
git -C "$ROOT" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" ||
  die "could not fetch main from origin"
sha="$(git -C "$ROOT" rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}")" ||
  die "origin/$branch is not a commit"
main_sha="$(git -C "$ROOT" rev-parse --verify --quiet "refs/remotes/origin/main^{commit}")" ||
  die "origin/main is not a commit"
log "preview: branch $branch, alias $slug, schema $schema, commit $sha"

# The branch's own changes, as in a pull request: from where it left origin/main (the merge base) to its
# commit.
base="$(git -C "$ROOT" merge-base "$main_sha" "$sha")" ||
  die "$branch has no history in common with origin/main; refusing to preview it"
changed="$(git -C "$ROOT" diff --no-renames --name-only "$base" "$sha" -- "${GUARDED_PATHS[@]}")"
if [[ -n "$changed" ]]; then
  if [[ "${PREVIEW_ALLOW_INFRA:-}" != "1" ]]; then
    {
      printf '%s: refusing to preview %s: its changes since origin/main touch files that control the' \
        "$(basename "$0")" "$branch"
      printf ' install, the build or the deploy, which would run here with the Rosfield sign-in before'
      printf ' review:\n'
      printf '%s\n' "$changed" | sed 's/^/  /'
      printf 'Review them (git diff %s %s -- <file>), then rerun with PREVIEW_ALLOW_INFRA=1' "$base" "$sha"
      printf ' to preview anyway.\n'
    } >&2
    exit 1
  fi
  log "preview: NOTICE: PREVIEW_ALLOW_INFRA=1, so these changed files are used as reviewed:"
  printf '%s\n' "$changed" | sed 's/^/  /'
fi

log "preview: check out $sha in a temporary worktree and install it (npm ci --ignore-scripts)"
git -C "$ROOT" worktree add --quiet --detach "$tree" "$sha"
(cd "$tree" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

load_dev_var STAGING_DATABASE_URL
if [[ -n "${STAGING_DATABASE_URL:-}" ]]; then
  log "preview: migrate schema $schema"
  (cd "$tree" && DATABASE_URL="$STAGING_DATABASE_URL" DB_SCHEMA="$schema" node infra/scripts/migrate.mjs)
else
  log "preview: NOTICE: STAGING_DATABASE_URL is not set, so no preview schema was migrated"
fi

output="$work/upload.ndjson"
log "preview: upload a version of rosie-staging with alias $slug (this checkout's cf.sh, from the worktree)"
WRANGLER_OUTPUT_FILE_PATH="$output" CF_BUILD_DIR="$tree" bash "$CF" versions upload --env staging \
  --preview-alias "$slug" --var "DB_SCHEMA:$schema" --var "GIT_SHA:$sha"

url="$(wrangler_output "$output" version-upload preview_alias_url)"
if [[ -z "$url" ]]; then
  url="$(wrangler_output "$output" version-upload preview_url)"
fi
[[ -n "$url" ]] || die "wrangler reported no preview URL (is preview_urls on in wrangler.jsonc?)"
log "preview: ready, commit $sha"
echo "Preview URL: $url"
