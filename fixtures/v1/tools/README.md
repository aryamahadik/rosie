# Fixture set v1 tools (T-001)

`rebuild.sh <fresh copy> [out dir]` turns a fresh copy of the master (made as Master Corrections section 5 says) into regenerated `forms/`, `test-kit/` and `PROFESSION-MAP.md`. The default out dir is `scratch/rebuilt`. The fresh copy is only read: the script works in a temp copy, applies `../patch/G1-G3.patch`, runs the master's `test-kit.js` and `frontend-map.js`, and also saves `frontend-map.js --check` output as `frontend-map-check.txt`.

`NO_PATCH=1` skips the patch (the output then matches the master except the date on line 3 of `test-kit/COVERAGE.md` and `test-kit/SCENARIOS.md`; the master copy ships no `PROFESSION-MAP.md`).

The patch (`patch -p1` from the copy's top folder):

- G1: `test-kit.js` reads `safety.stop`, `questions.beforeTimes` and `messages.never` under the spellings of the `KEYS` table in `frontend-map.js`.
- G2: `test-kit.js` offers flow B `list|card|bill`.
- G3: `frontend-map.js` lines 22, 24, 25 and 131 point at the copy's top folder.

Known results: `--check` fails one line ("share" inside "shared-number"). After G1, 5 shops still have no stop words (florist uses "danger words", which `KEYS` does not map; laundry, shoe-repair, tailor and upholstery list none) and 4 have no never-in-a-text rule (their `pf.messages` is plain text). Not fixed: that needs a fourth change the corrections do not name. `test-kit.js` lines 176 and 179 stay as they are (known stale, Q-36).
