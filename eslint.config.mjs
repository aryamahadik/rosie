// Lint rules (factory spec 2, ADR-004). `npm run lint` allows no warnings.
// TypeScript: typescript-eslint strictTypeChecked and stylisticTypeChecked, typed through tsconfig.json.
// Plain JavaScript (the Node scripts): ESLint's recommended rules with Node globals.
// eslint-config-prettier comes last, so Prettier alone decides formatting.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/coverage/",
    "**/.wrangler/",
    ".claude/worktrees/",
    "ops/",
    "scratch/",
    "contracts/generated/",
    "bundles/",
    "fixtures/",
    "infra/rosfield-test-backup/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Lets Workers code type its bindings with `declare global { namespace Cloudflare { interface Env {} } }`.
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
