# Fixture set v1 (C-027)

The 243 demo shops and their owner forms, regenerated from the master with the G1 to G3 fixes of Master Corrections section 5. Every file here is written by the master's own scripts through `tools/rebuild.sh` (T-001). **Never hand-edit any of it** (build prompt rule 9). Never seed or test from the handover's own `forms/` or `test-kit/`: without G1, 112 of the 243 demo shops have no stop words.

## What is here

| Path | What it is |
|---|---|
| `forms/<id>.json` | 243 owner forms (`frontend-map.js`) |
| `test-kit/shops/<id>.json` | 243 demo shops plus `test-mixed-A.json` and `test-mixed-B.json` (`test-kit.js`) |
| `test-kit/COVERAGE.md`, `coverage.json`, `SCENARIOS.md`, `IMAGES.md` | coverage map, scenarios with expected results, image list |
| `PROFESSION-MAP.md` | the profession map (the master ships none; `frontend-map.js` writes it) |
| `MANIFEST.sha256` | sha256 of the 493 files above, `<hash>  <path>`, sorted by path. `shasum -a 256 -c MANIFEST.sha256` works from this folder |
| `INPUTS.sha256` | sha256 of the rebuild's inputs: `master-A.json`, `master-B.json`, the 243 trade files, `test-kit.js`, `frontend-map.js`, `waves.json` and `FRONTEND-SPEC.md` in the fresh copy, plus `./patch/G1-G3.patch` and `./tools/rebuild.sh` in this folder |
| `patch/G1-G3.patch` | the three fixes (T-001) |
| `KNOWN-STALE.md` | stale scenario lines (C9 wins in tests) and known gaps in the demo shops |
| `tools/rebuild.sh`, `tools/README.md` | the rebuild (T-001) |
| `tools/verify.mjs`, `tools/verify.test.ts` | the check (T-002) |

## Check it

```
node fixtures/v1/tools/verify.mjs                      # every file against MANIFEST.sha256; the patch and rebuild script against INPUTS.sha256
node fixtures/v1/tools/verify.mjs <fresh copy>         # also the master inputs in a fresh copy
node fixtures/v1/tools/verify.mjs --compare <rebuilt>  # a new rebuild against these files, apart from the three date lines
```

Exit code 0 means everything checked matched. A changed byte, a missing file or a file the manifest does not list fails (exit 1). `verify.test.ts` runs the first form on a temporary copy, so CI needs no master copy.

## How it was made

1. A fresh copy of the three handover folders (`1 Read First`, `2 Read When Building`, `3 Build Data and Tools`) at `scratch/fixture-v1-copy`, made by the lead (Master Corrections section 5). It was only read.
2. `bash fixtures/v1/tools/rebuild.sh scratch/fixture-v1-copy <out>` worked in a temporary copy: it applied the patch, ran `test-kit.js` and `frontend-map.js`, and wrote `forms/`, `test-kit/` and `PROFESSION-MAP.md`.
3. The output was copied here unchanged, and `node fixtures/v1/tools/verify.mjs --write <fresh copy>` wrote `MANIFEST.sha256` and `INPUTS.sha256`.
4. A second rebuild gave the same files apart from the three date lines (`--compare` exits 0).

Results of the rebuild: 243 professions read, 0 skipped, 0 problems; `frontend-map.js --check` fails one line only ("share" inside "shared-number"); 46 of 56 money combos are used by a profession, the rest by the two `test-mixed` shops. See `KNOWN-STALE.md` for the stale lines and the known gaps.

## The three date lines (Q-36)

The scripts stamp the time of day on line 3 of three files, so two rebuilds differ in these lines and nowhere else (Eastern time, Nov 7 2026):

```
PROFESSION-MAP.md line 3: Made by `node work/phase4/tools/frontend-map.js` on Sat Nov 07 2026 02:15:56. ...
test-kit/COVERAGE.md line 3: Generated Sat Nov 07 2026 02:15 from 243 profession files and the master (...)
test-kit/SCENARIOS.md line 3: Generated Sat Nov 07 2026 02:15. Run each on the demo shop named; ...
```

## To regenerate (a new rebuild is a new task)

Rebuild into a scratch folder, replace `forms/`, `test-kit/` and `PROFESSION-MAP.md` with the output, run `verify.mjs --write <fresh copy>`, and commit. If the patch or a master input changes, the inputs check fails first: that is the signal to rebuild.
