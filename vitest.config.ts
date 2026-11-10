// Vitest projects (factory spec 2, ADR-003). `npm test` runs unit, workers and contract; each project also has its
// own script (`npm run test:<project>`). A project with no test files passes. The parity project is outside
// `npm test` (T-1067).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const workspaces = [
  "contracts",
  "compiler",
  "db",
  "runtime",
  "actions",
  "ai",
  "adapters",
  "web",
  "evals",
  "tests",
];

// The overlay parity shards (T-135, 243 trades through both flows): their own project, outside `npm test`, run by
// `npm run test:parity` when the parity's inputs change (T-1067; ci.yml and merge-check.yml hold the path list).
const PARITY_GLOB = "compiler/src/**/parity.shard-*.test.ts";

// The local database of infra/docker-compose.yml, used when DATABASE_URL and CI are both unset.
const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const databaseUrl = process.env.DATABASE_URL ?? (process.env.CI ? undefined : LOCAL_DATABASE_URL);

// At most this many test workers in every run, shared by every project (T-1117, DL-215): a resource guard on the build
// Mac, not part of any test's claim, so several suites at once fit its CPUs and memory. VITEST_MAX_WORKERS sets it
// when it is a positive whole number; unset or anything else gives 3.
const workersSetting = Number(process.env.VITEST_MAX_WORKERS?.match(/^\d+$/)?.[0]);
const MAX_WORKERS = Number.isSafeInteger(workersSetting) && workersSetting >= 1 ? workersSetting : 3;

export default defineConfig({
  test: {
    passWithNoTests: true,
    maxWorkers: MAX_WORKERS,
    // The 30 s resource guard for every project with no limit of its own: workers, contract, scenario and e2e (T-1131,
    // DL-236: an e2e test timed out at Vitest's 5 s default while three builders ran on the build Mac). Not part of any
    // test's claim. A project's own limits and a test's own longer limit still win.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        // Unit tests beside the code: each workspace's src/, plus db/repo/ and db/seeds/ (db's layout).
        test: {
          name: "unit",
          include: [
            ...workspaces.map((workspace) => `${workspace}/src/**/*.test.ts`),
            "db/repo/**/*.test.ts",
            "db/seeds/**/*.test.ts",
            "fixtures/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "**/*.worker.test.ts", "**/*.int.test.ts", PARITY_GLOB],
          // A resource guard, not part of any test's claim (T-1073): CPU-heavy unit tests time out at Vitest's 5 s
          // default when several builders run vitest at once on the build Mac.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Not in `npm test`: `npm run test:parity`. Same exclusions as unit, so no other file lands here.
        test: {
          name: "parity",
          include: [PARITY_GLOB],
          exclude: ["**/node_modules/**"],
          // The unit project's resource guard, not part of any test's claim (T-1073; T-1114, DL-200): routing parity
          // tests took 6 to 14 s each, past Vitest's 5 s default, while builders ran vitest on the build Mac.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Runs inside the Workers runtime with wrangler.jsonc's staging environment.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
            miniflare: { bindings: { GIT_SHA: "test-sha" } },
          }),
        ],
        test: {
          name: "workers",
          // T-1144: the action layer's checks that must hold inside the Workers runtime (the Tool API's validator).
          include: [
            "runtime/src/**/*.worker.test.ts",
            "runtime/test/**/*.worker.test.ts",
            "actions/src/**/*.worker.test.ts",
          ],
        },
      },
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.test.ts"],
        },
      },
      {
        // Needs PostgreSQL: `npm run db:up` locally, a service container in CI.
        test: {
          name: "integration",
          include: ["db/**/*.int.test.ts", "actions/**/*.int.test.ts", "compiler/**/*.int.test.ts"],
          env: databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl },
          // One file at a time in every run (T-1113, DL-106, DL-196): each file opens its own pools, and
          // files side by side on a many-core Mac passed PostgreSQL's 100 connections. Tests inside a file
          // keep their own concurrency.
          fileParallelism: false,
          // The unit project's resource guard, not part of any test's claim (T-1073; T-1118, DL-227): on the build
          // Mac's emulated PostgreSQL, a test that made two test databases timed out at Vitest's 5 s default.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "scenario",
          include: ["tests/scenarios/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          // The e2e files that run inside the Workers runtime are the next project's (T-1149).
          exclude: ["**/node_modules/**", "**/*.worker.test.ts"],
        },
      },
      {
        // The walking skeleton's end-to-end test inside the Workers runtime (T-1149, DL-332): the local target posts
        // through runtime/src/wiring's composition root with the HandleActor installed, as the workers project runs it.
        // `npm run test:e2e` runs it with the e2e project.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
            miniflare: { bindings: { GIT_SHA: "test-sha" } },
          }),
        ],
        test: {
          name: "e2e-workers",
          include: ["tests/e2e/**/*.worker.test.ts"],
          // Reads SKELETON_UPTO and CONTRACT_REPORT in Node and provides them to the run (tests/e2e/skeleton/README.md).
          globalSetup: ["tests/e2e/_driver/prefix/global-setup.ts"],
        },
      },
    ],
  },
});
