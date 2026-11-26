# T-1125 findings: local PostgreSQL with PostGIS under emulation (Apple-silicon build Mac)

Spike T-1125, Nov 7 2026. Measured by the release engineer with `bench.mjs` (one run, one JSON line) and `repeat.mjs` (N runs, counting differing digests): `node infra/spikes/postgis-emulation/repeat.mjs 10`. The lead wrote this file from the builder's report: the spike rules let a builder return findings as text (DL-063).

## Timings (10 runs each)

| Step                                           | Local, emulated amd64 `postgis/postgis:17-3.5` | CI, native                                                                                     | Local, native arm64 `imresamu/postgis:17-3.5-bookworm` |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Start, existing volume (`npm run db:up`)       | 6.0 s                                          | 19 s (merge-check's "Initialize containers", which includes the PostGIS service's health wait) | about 1 s                                              |
| Start, fresh volume, to ready                  | 5.1 s                                          | 19 s (CI always starts a fresh service)                                                        | about 1 s                                              |
| Migrate, empty schema (median)                 | 124 ms                                         | under 1 s (merge-check's "Apply the migrations", 0001_init only)                               | 60 ms                                                  |
| 2,000 GiST EXCLUDE inserts                     | 598 ms (0.3 ms each)                           | not run in CI (the bench is not a CI step); `test:integration` total: 1 s with no DB tests yet | 835 ms (noisy: 553 to 2,308)                           |
| Overlapping insert refused (SQLSTATE 23P01)    | 3 ms                                           | not run in CI (the bench is not a CI step)                                                     | 1 ms                                                   |
| 25 nearest-50 PostGIS queries on 20,000 points | 75 ms                                          | not run in CI (the bench is not a CI step)                                                     | 21 ms                                                  |

The CI column comes from merge-check run 42344823865 on this branch (Nov 7 2026), the native postgis/postgis:17-3.5 service on ubuntu-latest. CI runs no bench step, so the per-operation timings and the 10-run repeat exist only locally; running the bench in CI would change a workflow, which is outside this spike (a later release-engineer task, with T-1057's database tests in merge-check).

## Repeat runs

- Emulated: 0 differences in 10 runs (digest `3b9fca49b24977dc`), 0 failures.
- Native arm64: also 0 differences, the same digest as emulated.
- The first runs after a quiet spell were up to 2x slower (migrate 266 ms, inserts 806 ms), then settled.

## arm64

- The official `postgis/postgis:17-3.5` image is amd64 only (`docker manifest inspect`).
- `imresamu/postgis:17-3.5-bookworm`, a community build, has an arm64 image: PostgreSQL 17.6 and PostGIS 3.5.3 (GEOS 3.11.1, PROJ 9.1.1).
- CI's image has PostgreSQL 17.5 and PostGIS 3.5.2 (GEOS 3.9.0, PROJ 7.2.1): the same major and minor versions, with different patch versions and library builds.

## Recommendation

**Keep the emulated image locally.**

- Every step is under 1 s except the start, which takes about 6 s.
- Results are stable and identical to the native ones.
- Local and CI keep one image and one set of patch versions.

The arm64 image is a fallback that needs the CTO's OK and a later release-engineer task. Running integration tests only in the merge check is not needed.

### Addendum, Nov 24 2026 (T-1560, DL-1220): the build Mac moves to the arm64 image

- Under heavy parallel load (five workflows at once, the Workers test rigs, the 1,000-parallel tests) the emulated image crashed six times Nov 23-24: each time one server process "exited with exit code 2" with no error before it, followed by a recovery of 8 to 25 minutes (DL-1206, DL-1207, DL-1216, DL-1218, DL-1220). This spike measured one connection and no parallel writers (see Limits), so it could not see this.
- The local build Mac now runs the arm64 image, `imresamu/postgis:17-3.5-bookworm`, natively (`infra/docker-compose.yml`, DL-1220): no platform line, `max_locks_per_transaction=512` on its command line (DL-358), and a new volume, `rosie-pg-data-arm64`. The emulated image's volume, `rosie-pg-data`, is left untouched as a fallback.
- CI keeps the official `postgis/postgis:17-3.5`: PostGIS 3.5.2 there and 3.5.3 locally (PostgreSQL 17.5 and 17.6), the same major and minor versions.

## Limits

- This was a small data set, one connection and no parallel writers.
- The 1,000-parallel `reserve()` test (T-041) is the load most likely to be slow under emulation. The database engineer should time it and revisit the arm64 option if it is slow.

## What the spike changed

No product code, compose file or CI file changed. `rosie-pg` was restarted once (same volume) and is up and healthy. The throwaway containers on ports 54330 and 54331 were removed. The `imresamu` image stays in the local Docker cache.
