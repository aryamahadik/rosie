#!/usr/bin/env bash
# Preview of one branch (factory spec 6; build prompt 5.3; DL-024): npm run deploy:preview -- <branch>
# Runs on the build Mac, where the Rosfield sign-in is, before anyone has reviewed the branch, so nothing of
# the branch's runs here unreviewed: its install scripts are skipped, no npm script of its runs, its infra/
# (migrate.mjs, cf.sh, build/tool-api-validators.mjs) must be unchanged from origin/main, and the upload uses
# this checkout's cf.sh and wrangler. Its code runs only on Cloudflare (the preview), and its migrations run
# with its own schema as the search path. It deploys the branch's pushed commit, never this checkout's files:
#  0. it fetches origin/<branch> and origin/main and refuses the branch, listing the files, when its own
#     changes (its diff against origin/main from their merge base, as in a pull request) touch a file that
#     controls the install, the build or the deploy: wrangler.jsonc (or a wrangler.json or wrangler.toml),
#     infra/, .github/, any package.json, package-lock.json or npm-shrinkwrap.json, .npmrc, and anything
#     named node_modules or inside one, at any depth (step 2's imports would load it in place of what npm ci
#     installed), each in any letter case (this Mac's volume ignores case, so a PACKAGE.JSON is package.json
#     to npm and node); or when they add, change or remove a symbolic link, which could point the build's
#     writes or its cleanup at any folder on this Mac; or a path holding a byte outside printable ASCII (0x20
#     to 0x7E), since the volume also folds letters git's icase does not (U+017F to s, U+212A to k), so a
#     node_modules spelt with U+017F is node_modules to node. The lead reviews that diff and reruns with
#     PREVIEW_ALLOW_INFRA=1 to preview it anyway;
#  1. it checks that commit out in a temporary worktree (removed afterwards) and installs it with
#     npm ci --ignore-scripts, so no install script runs;
#  2. the Tool API's standalone validators built there (T-1153, T-1144): node runs the worktree's own
#     infra/build/tool-api-validators.mjs, which step 0 holds to origin/main's, never an npm script of the
#     branch's. It writes the git-ignored actions/src/tool-api/generated/ (from the branch's contracts/) that
#     validator.ts imports, so the Worker has its prebuilt code. A failed build stops the preview: nothing is
#     migrated or uploaded;
#  3. migrations into the branch's own schema on the staging database, when STAGING_DATABASE_URL is set
#     (skipped with a notice when it is not);
#  4. a Worker version of that commit uploaded to rosie-staging under the preview alias <slug> by THIS
#     checkout's cf.sh and wrangler (never the branch's), with CF_BUILD_DIR=<worktree>: cf.sh checks the
#     worktree's wrangler.jsonc as it checks its own, then uploads from there with DB_SCHEMA and GIT_SHA (that
#     commit) set (an upload, not a deploy: staging traffic keeps its current version);
#  5. the preview URL printed.
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

# The files whose changes the lead reviews before a preview runs the branch's install and build here. The
# validators' code imports Ajv's run-time helpers by package name, which node looks up in every node_modules
# from actions/src/tool-api/generated/ up, so a node_modules the branch adds (a folder, a link of that name, or
# anything in one) would run in place of the installed package. Every entry ignores letter case (icase), as
# this Mac's volume does: a branch's Node_Modules, PACKAGE.JSON or .NPMRC is the same folder or file to node and
# npm as node_modules, package.json or .npmrc. icase folds ASCII letters only, so a path with any other
# character is refused on its own below.
GUARDED_PATHS=(':(glob,icase)wrangler.jsonc' ':(glob,icase)wrangler.json' ':(glob,icase)wrangler.toml'
  ':(glob,icase)infra' ':(glob,icase).github' ':(glob,icase).npmrc'
  ':(glob,icase)**/package.json' ':(glob,icase)**/package-lock.json' ':(glob,icase)**/npm-shrinkwrap.json'
  ':(glob,icase)**/node_modules' ':(glob,icase)**/node_modules/**')

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
# Its symbolic links: every entry of its raw diff with mode 120000 on either side. A link, say at
# actions/src/tool-api/generated, would point the build's writes and its cleanup at any folder on this Mac.
links="$(git -C "$ROOT" diff --no-renames --raw "$base" "$sha" |
  awk -F '\t' '{ split($1, mode, " "); if (mode[1] == ":120000" || mode[2] == "120000") print $2 }')"
# Its paths that hold a byte outside printable ASCII (0x20 to 0x7E), on either side of its raw diff (DL-456):
# the volume can take such a name for a guarded one that icase above does not match. node reads the diff
# NUL-separated (-z), so no tab or newline in a name can split a path, and byte by byte (latin1). It prints each
# such path quoted as git quotes it (\ooo for each byte outside printable ASCII), so none of its bytes reaches
# the terminal as it is. main held no such path when this check came in (git ls-files, 3502 paths).
nonascii="$(git -C "$ROOT" diff --no-renames --raw -z "$base" "$sha" | node -e '
  const fields = require("node:fs").readFileSync(0).toString("latin1").split("\0");
  const fail = () => {
    console.error("deploy-preview.sh: git diff --raw -z gave output it cannot read");
    process.exit(1);
  };
  if (fields.pop() !== "") fail();
  const named = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: "\"", 92: "\\" };
  const escape = (b) => {
    if (named[b]) return "\\" + named[b];
    return b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b);
  };
  const quote = (name) => "\"" + Array.from(name, (c) => escape(c.charCodeAt(0))).join("") + "\"";
  for (let i = 0; i < fields.length; ) {
    const entry = /^:[0-7]+ [0-7]+ \S+ \S+ ([A-Z])[0-9]*$/.exec(fields[i++]);
    const count = entry && "CR".includes(entry[1]) ? 2 : 1;
    if (!entry || i + count > fields.length) fail();
    for (const name of fields.slice(i, (i += count))) {
      if (/[^\x20-\x7e]/.test(name)) console.log(quote(name));
    }
  }
')"
if [[ -n "$changed" || -n "$links" || -n "$nonascii" ]]; then
  if [[ "${PREVIEW_ALLOW_INFRA:-}" != "1" ]]; then
    {
      printf '%s: refusing to preview %s: its changes since origin/main' "$(basename "$0")" "$branch"
      if [[ -n "$changed" ]]; then
        printf ' touch files that control the install, the build or the deploy, which would run here with the'
        printf ' Rosfield sign-in before review:\n'
        printf '%s\n' "$changed" | sed 's/^/  /'
      fi
      if [[ -n "$links" ]]; then
        [[ -z "$changed" ]] || printf 'and they'
        printf ' add, change or remove symbolic links, which could point the build at folders outside its'
        printf ' worktree:\n'
        printf '%s\n' "$links" | sed 's/^/  /'
      fi
      if [[ -n "$nonascii" ]]; then
        [[ -z "$changed" && -z "$links" ]] || printf 'and they'
        printf ' add, change or remove paths with characters outside printable ASCII, which this Mac could take'
        printf ' for files that control the install, the build or the deploy (each quoted as git quotes it):\n'
        printf '%s\n' "$nonascii" | sed 's/^/  /'
      fi
      printf 'Review them (git diff %s %s -- <file>), then rerun with PREVIEW_ALLOW_INFRA=1' "$base" "$sha"
      printf ' to preview anyway.\n'
    } >&2
    exit 1
  fi
  log "preview: NOTICE: PREVIEW_ALLOW_INFRA=1, so these changed files are used as reviewed:"
  printf '%s\n' "$changed" "$links" "$nonascii" | awk '$0 != "" && !seen[$0]++ { print "  " $0 }'
fi

log "preview: check out $sha in a temporary worktree and install it (npm ci --ignore-scripts)"
git -C "$ROOT" worktree add --quiet --detach "$tree" "$sha"
(cd "$tree" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error)

# Step 2: the worktree's own build script (infra/ is guarded above), run by node itself, so no npm script of
# the branch's runs; it writes the generated folder beside the worktree's validator.ts. Before the database
# key is loaded, and before anything is migrated or uploaded.
log "preview: build the Tool API's validators in the worktree (node infra/build/tool-api-validators.mjs)"
(cd "$tree" && node infra/build/tool-api-validators.mjs) ||
  die "the Tool API's validators did not build for $branch ($sha): nothing was migrated or uploaded"

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
