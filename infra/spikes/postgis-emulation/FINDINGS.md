# T-1125 findings: local PostgreSQL with PostGIS under emulation (Apple-silicon build Mac)

Spike T-1125, Nov 7 2026. Measured by the release engineer with `bench.mjs` (one run, one JSON line) and `repeat.mjs` (N runs, counting differing digests): `node infra/spikes/postgis-emulation/repeat.mjs 10`. The lead wrote this file from the builder's report: the spike rules let a builder return findings as text (DL-063).

## Timings (10 runs each)

| Step                                           | Local, emulated amd64 `postgis/postgis:17-3.5` | CI, native                                           | Local, native arm64 `imresamu/postgis:17-3.5-bookworm` |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Start, existing volume (`npm run db:up`)       | 6.0 s                                          | Not measured yet (the PostGIS service's health wait) | about 1 s                                              |
| Start, fresh volume, to ready                  | 5.1 s                                          | Not measured yet                                     | about 1 s                                              |
| Migrate, empty schema (median)                 | 124 ms                                         | Not measured yet (merge-check's `migrate` step)      | 60 ms                                                  |
| 2,000 GiST EXCLUDE inserts                     | 598 ms (0.3 ms each)                           | Not measured yet (`test:integration` total)          | 835 ms (noisy: 553 to 2,308)                           |
| Overlapping insert refused (SQLSTATE 23P01)    | 3 ms                                           | Not measured yet                                     | 1 ms                                                   |
| 25 nearest-50 PostGIS queries on 20,000 points | 75 ms                                          | Not measured yet                                     | 21 ms                                                  |

The CI column is filled from the first merge-check run that runs this spike (`node infra/spikes/postgis-emulation/repeat.mjs 10` against the service, 0 differences expected).

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

## Limits

- This was a small data set, one connection and no parallel writers.
- The 1,000-parallel `reserve()` test (T-041) is the load most likely to be slow under emulation. The database engineer should time it and revisit the arm64 option if it is slow.

## What the spike changed

No product code, compose file or CI file changed. `rosie-pg` was restarted once (same volume) and is up and healthy. The throwaway containers on ports 54330 and 54331 were removed. The `imresamu` image stays in the local Docker cache.
