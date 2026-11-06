# ADR-003: Tests

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Every branch runs unit and contract tests; the merge queue adds integration, scenario and end-to-end tests on the branch rebased onto `main` (build prompt 5.2, 6.5).
- Whether `main` is green depends only on tests that give the same result every run, with doubles for every outside service. Evals never decide it (5.2).
- The conversation runtime runs on Workers and Durable Objects (architecture 02), so its tests must run inside the Workers runtime.
- A test is never weakened (rule 10, 7.9). A branch that lowers the test count or adds a skip fails unless `tests/QUARANTINE.md` lists it (5.2).

## Decision

- **Vitest 5** (root manifest: `^5.1.0`), one root config with `projects`:
  - `unit`: every workspace's `src/**/*.test.ts`, except Workers tests;
  - `workers`: `runtime/src/**/*.worker.test.ts`, run inside the Workers runtime by `@cloudflare/vitest-plugin`;
  - `contract`: `tests/contract/**/*.test.ts`;
  - `integration`: `db/**/*.int.test.ts`, against PostgreSQL;
  - `scenario`: `tests/scenarios/**/*.test.ts`;
  - `e2e`: `tests/e2e/**/*.test.ts`.
- Empty projects pass. `npm test` runs `unit`, `workers` and `contract` on every branch; `merge-check.yml` adds `integration`, `scenario` and `e2e` against a PostGIS service container. `npm run guard:tests` holds the test count (D-000 spec, sections 3 and 7).
- **Playwright** for browser tests of `web/`, added by the first page task that needs it. Not installed in D-000.
- Evals stay outside this suite, in `evals/`, run through the `run-evals` skill.

## Consequences

- The D-000 spec named `@cloudflare/vitest-pool-workers`, whose latest release (0.23.0) supports only Vitest `^4.1.0`. Cloudflare's docs now name `@cloudflare/vitest-plugin` as the Workers Vitest integration and point pool users to a migration guide. The plugin (1.6.0) accepts Vitest `^4.1.0 || ^5.0.0`, so the root uses it with Vitest 5.
- `integration` needs PostgreSQL: `npm run db:up` locally, with Docker running; in CI, only the merge check has it.
- Scenario and end-to-end tests use fixture set v1 and doubles, never real customer data (rule 9) and never a live outside service.
- Only QA may call a test flaky. A test that guards a hard invariant or a concurrency rule is never quarantined (7.8).

## Alternatives not chosen

- **Jest:** Cloudflare's Workers test integration is built for Vitest, and Vitest runs TypeScript and ES modules without extra setup.
- **`node:test` for product suites:** no Workers integration and no projects. It stays for the hook's own tests (`infra/ci/guard.test.mjs`), where a runner with no dependencies matters.
- **Playwright now:** no page exists in D-000.

## Sources

- Build prompt 2 (rules 9 and 10), 4 ("Unit tests live beside the code"), 5.2, 6.5, 7.8, 7.9.
- Architecture 02 (Workers; a Durable Object per handle); architecture 08 (accuracy is measured by evals on the gold set, not by tests); architecture 10, "Every platform area" (Deploy).
- D-000 spec, sections 2, 3, 7 and 9; the root `package.json`.
- Checked 2026-11-05: Cloudflare, "Vitest integration"; npm registry (vitest 5.1.0; `@cloudflare/vitest-plugin` 1.6.0 and `@cloudflare/vitest-pool-workers` 0.23.0 peer ranges).
