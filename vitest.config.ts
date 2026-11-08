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

export default defineConfig({
  test: {
    passWithNoTests: true,
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
          include: ["runtime/src/**/*.worker.test.ts", "runtime/test/**/*.worker.test.ts"],
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
          include: ["db/**/*.int.test.ts", "actions/**/*.int.test.ts"],
          env: databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl },
          // One file at a time in every run (T-1113, DL-106, DL-196): each file opens its own pools, and
          // files side by side on a many-core Mac passed PostgreSQL's 100 connections. Tests inside a file
          // keep their own concurrency.
          fileParallelism: false,
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
        },
      },
    ],
  },
});
