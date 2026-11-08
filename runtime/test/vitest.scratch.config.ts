// Scratch config, deleted before commit: the root workers project with runtime/test/** in its include.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc", environment: "staging" },
            miniflare: { bindings: { GIT_SHA: "test-sha" } },
          }),
        ],
        test: {
          name: "workers",
          include: ["runtime/test/**/*.worker.test.ts"],
        },
      },
    ],
  },
});
