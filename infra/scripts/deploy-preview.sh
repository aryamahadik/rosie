#!/usr/bin/env bash
# Preview of one branch (factory spec 6; build prompt 5.3; DL-024): npm run deploy:preview -- <branch>
# Runs on the build Mac, where the Rosfield sign-in is, before anyone has reviewed the branch, so nothing of
# the branch's runs here unreviewed: its install scripts are skipped, no npm script of its runs, its infra/
# (migrate.mjs, cf.sh, build/tool-api-validators.mjs) must be unchanged from origin/main, and the upload uses
# this checkout's cf.sh and wrangler. Its code runs only on Cloudflare (the preview), with no Hyperdrive binding
# (step 3), and its migrations run with its own schema as the search path. It deploys the branch's pushed
# commit, never this checkout's files:
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
#  3. the upload's config (ADR-014 new task a; T-1256): the worktree's wrangler.jsonc is rewritten in place,
#     inside this script's temporary folder, without env.staging's hyperdrive list and with everything else as
#     it was, so the preview gets no Hyperdrive binding whatever env.staging holds (HYPERDRIVE_JOB and
#     HYPERDRIVE_APP reach the staging database, and the branch's code runs there unreviewed). The file is read
#     back, and one that still names a Hyperdrive binding stops the preview: nothing is migrated or uploaded;
#  4. migrations into the branch's own schema on the staging database, when STAGING_DATABASE_URL is set
#     (skipped with a notice when it is not): the URL goes to migrate.mjs alone (below);
#  5. a Worker version of that commit uploaded to rosie-staging under the preview alias <slug> by THIS
#     checkout's cf.sh and wrangler (never the branch's), with CF_BUILD_DIR=<worktree>: cf.sh checks the
#     worktree's wrangler.jsonc (step 3's) as it checks its own, then uploads from there with DB_SCHEMA and
#     GIT_SHA (that commit) set (an upload, not a deploy: staging traffic keeps its current version);
#  6. the preview URL printed.
# <slug>: the branch in lower case, [a-z0-9-] only, at most 40 characters. Schema: preview_<slug> with "_"
# for "-".
# The staging database's URL (T-1310; read as create-staging-hyperdrive.sh reads it): STAGING_DATABASE_URL, from the
# environment, else from this checkout's .dev.vars by name (lib.sh's load_dev_var, at step 4), never printed. It
# leaves this shell's environment before anything is started (dirname included), and DATABASE_URL, which this script
# never reads, leaves with it, so no copy of a database URL reaches git, npm, node, cf.sh, wrangler or any other
# command started here: the branch's install and build among them. It is kept in one variable that is never marked
# for export, handed to step 4's migrate.mjs alone (as DATABASE_URL, on that command's line), and then dropped.
# Tracing, allexport and keyword are switched off first, whatever the caller's shell asked for: a trace would print
# the URL, allexport would mark the variable for export, and under keyword lib.sh's `local name=...` would declare
# nothing (as make-staging-secrets.sh explains, T-1236).
set +x
set +a
set +k
set -euo pipefail
# The variable is dropped before it is set: bash marks every variable it inherits for export, so one of that name in
# the caller's environment would make it an exported one.
unset -v database_url
database_url="${STAGING_DATABASE_URL-}"
unset -v STAGING_DATABASE_URL DATABASE_URL
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

# Step 3: the upload's config (ADR-014 new task a; T-1256). The branch's code runs unreviewed on the preview,
# so the preview gets no Hyperdrive binding, whatever env.staging holds. node reads the worktree's wrangler.jsonc
# as cf.sh reads it (comments and trailing commas dropped outside strings), leaves out env.staging's hyperdrive
# list and writes the rest back in place as JSON, so cf.sh checks this file as it checks any build folder's and
# wrangler uploads exactly it (cf.sh passes it as --config, so wrangler searches for no other). In the installed
# wrangler's code (4.158.0), an environment inherits no hyperdrive list from the top level (notInheritable), and
# a version upload keeps only secrets, and vars with keep_vars, from the version before (keep_bindings). The
# file is then read back, and the preview stops when it still names a Hyperdrive binding: a key or a text that
# holds "hyperdrive" in any letter case, or the name of a binding left out, at the top level or in env.staging
# (no other environment is uploaded here). That takes in a top-level list, an unsafe binding or unsafe metadata
# (wrangler sends both as they are), and a required secret named as a binding left out (wrangler sends it as an
# inherit binding, which takes the deployed version's binding of that name). Only names and paths are printed,
# never a value: a local connection string holds a password. Before the database key is loaded, and before
# anything is migrated or uploaded.
log "preview: write the upload's config: the worktree's wrangler.jsonc without env.staging's hyperdrive list"
if ! config_note="$(node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const fail = (why) => {
    console.log(why);
    process.exit(1);
  };
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  // The file as cf.sh reads it: comments and trailing commas dropped outside strings, the rest JSON.
  const read = () => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      fail("cannot be read");
    }
    // A link would send the write below to the file it points at, outside the temporary folder.
    if (!stat.isFile()) fail("is not a regular file");
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
        if (end < 0) fail("has a /* comment that is not closed");
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
    } catch {
      // Without the parser message, which can quote the text around the fault.
      fail("does not parse");
    }
    if (!isObject(config) || !isObject(config.env) || !isObject(config.env.staging)) fail("has no env.staging");
    return config;
  };

  const config = read();
  const staging = config.env.staging;
  const listed = Object.hasOwn(staging, "hyperdrive");
  const left = (Array.isArray(staging.hyperdrive) ? staging.hyperdrive : [])
    .map((entry) => (isObject(entry) ? entry.binding : undefined))
    .filter((name) => typeof name === "string" && name !== "");
  delete staging.hyperdrive;
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  } catch {
    fail("cannot be written");
  }

  // What wrangler will read: the file as written, read back.
  const written = read();
  const names = (text) => /hyperdrive/i.test(text) || left.includes(text);
  const step = (at, key) =>
    /^[A-Za-z_$][\w$]*$/.test(key) ? (at === "" ? key : `${at}.${key}`) : `${at}[${JSON.stringify(key)}]`;
  const found = new Set();
  const scan = (value, at) => {
    if (typeof value === "string") {
      if (names(value)) found.add(at);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${at}[${index}]`));
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (names(key)) found.add(step(at, key));
        scan(item, step(at, key));
      }
    }
  };
  const { env, ...top } = written;
  scan(top, "");
  scan(env.staging, "env.staging");
  if (found.size > 0) {
    const at = [...found].join(", ");
    fail(`still names a Hyperdrive binding once the hyperdrive list of env.staging is left out, at ${at}`);
  }
  if (!listed) {
    console.log("env.staging holds no hyperdrive list: the upload has none");
  } else {
    const named = left.map((name) => JSON.stringify(name)).join(", ") || "no binding named";
    console.log(`the upload leaves out the hyperdrive list of env.staging (${named})`);
  }
' "$tree/wrangler.jsonc")"; then
  die "refusing to upload $branch ($sha): its wrangler.jsonc $config_note. A preview never gets a Hyperdrive" \
    "binding (ADR-014): nothing was migrated or uploaded"
fi
log "preview: $config_note"

# Step 4: the staging database's URL (see the top of this file), from .dev.vars by name when the environment gave none.
# load_dev_var exports what it reads, so the name is unset again at once, before any command is started. The URL goes
# to migrate.mjs alone, on its command line, and is dropped as soon as migrate.mjs has run, whatever its exit.
if [[ -z "$database_url" ]]; then
  load_dev_var STAGING_DATABASE_URL
  database_url="${STAGING_DATABASE_URL-}"
  unset -v STAGING_DATABASE_URL
fi
if [[ -n "$database_url" ]]; then
  log "preview: migrate schema $schema"
  status=0
  (cd "$tree" && DATABASE_URL="$database_url" DB_SCHEMA="$schema" node infra/scripts/migrate.mjs) || status=$?
  database_url=""
  if [[ "$status" -ne 0 ]]; then
    exit "$status"
  fi
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
