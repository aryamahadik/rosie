# Helpers shared by the infra/scripts/*.sh scripts (sourced, never run). Works with macOS's bash 3.2.
# Nothing here prints a key, a token or a database URL.
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CF="$ROOT/infra/scripts/cf.sh"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  printf '%s: %s\n' "$(basename "$0")" "$*" >&2
  exit 1
}

# A branch name as a preview alias: lower case, only [a-z0-9-], at most 40 characters, starting with a letter
# (wrangler's alias rule; "b-" is put in front of a name that starts with a digit).
branch_slug() {
  local slug
  slug="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-//')"
  [[ -n "$slug" ]] || die "branch name \"$1\" leaves nothing for a preview name"
  if [[ ! "$slug" =~ ^[a-z] ]]; then
    slug="b-$slug"
  fi
  slug="${slug:0:40}"
  slug="${slug%-}"
  printf '%s' "$slug"
}

# A preview's database schema: preview_<slug>, with "_" for "-" so it is a plain SQL name.
preview_schema() {
  printf 'preview_%s' "${1//-/_}"
}

# The commit being deployed: GIT_SHA when set, else the checked-out commit.
git_sha() {
  if [[ -n "${GIT_SHA:-}" ]]; then
    printf '%s' "$GIT_SHA"
  else
    git -C "$ROOT" rev-parse HEAD
  fi
}

# Loads one named key from the git-ignored .dev.vars into the environment, unless it is already set. The value
# is never printed.
load_dev_var() {
  local name="$1" file="$ROOT/.dev.vars" line value
  if [[ -n "${!name:-}" || ! -f "$file" ]]; then
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
      export "$name=$value"
      return 0
    fi
  done <"$file"
}

# Reads one field of the last entry of a type from wrangler's ND-JSON output file (WRANGLER_OUTPUT_FILE_PATH).
# Arrays print one item per line. Prints nothing when the entry or field is missing.
wrangler_output() {
  node -e '
    const [file, type, field] = process.argv.slice(1);
    const lines = require("node:fs").readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const entry = lines.map((line) => JSON.parse(line)).filter((item) => item.type === type).pop();
    const value = entry === undefined ? undefined : entry[field];
    if (value !== undefined && value !== null) console.log(Array.isArray(value) ? value.join("\n") : String(value));
  ' "$1" "$2" "$3"
}
