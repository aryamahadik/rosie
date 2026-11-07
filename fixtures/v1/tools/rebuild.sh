#!/usr/bin/env bash
# T-001: turn a fresh copy of the master into regenerated forms/, test-kit/ and PROFESSION-MAP.md.
# usage: bash fixtures/v1/tools/rebuild.sh <fresh copy> [out dir]     (out dir default: scratch/rebuilt)
# NO_PATCH=1 skips G1 to G3 (to compare with the master). The fresh copy is only read; work happens in a temp copy.
set -euo pipefail
SRC="${1:?usage: rebuild.sh <fresh copy> [out dir]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/../patch/G1-G3.patch"
OUT="${2:-$HERE/../../../scratch/rebuilt}"
[ -d "$SRC/engine/work/phase4/tools" ] || { echo "not a master copy: $SRC" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rosie-rebuild.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cp -R "$SRC/." "$WORK/"
chmod -R u+w "$WORK"
printf '{"type": "commonjs"}\n' > "$WORK/package.json"
if [ -z "${NO_PATCH:-}" ]; then
  (cd "$WORK" && patch -p1 < "$PATCH")
fi
if [ -n "${NO_PATCH:-}" ]; then mkdir -p "$WORK/engine/santiago-handover"; cp "$WORK/FRONTEND-SPEC.md" "$WORK/engine/santiago-handover/"; fi
rm -rf "$WORK/forms" "$WORK/test-kit"
(cd "$WORK" && node engine/work/phase4/tools/test-kit.js --out "$WORK/test-kit")
(cd "$WORK" && node engine/work/phase4/tools/frontend-map.js)
(cd "$WORK" && node engine/work/phase4/tools/frontend-map.js --check > "$WORK/frontend-map-check.txt" || true)
if [ -n "${NO_PATCH:-}" ]; then mv "$WORK/engine/santiago-handover/forms" "$WORK/forms"; mv "$WORK/engine/santiago-handover/PROFESSION-MAP.md" "$WORK/PROFESSION-MAP.md"; fi
mkdir -p "$OUT"
rm -rf "$OUT/forms" "$OUT/test-kit" "$OUT/PROFESSION-MAP.md" "$OUT/frontend-map-check.txt"
cp -R "$WORK/forms" "$WORK/test-kit" "$WORK/PROFESSION-MAP.md" "$WORK/frontend-map-check.txt" "$OUT/"
echo "rebuilt into $OUT"
