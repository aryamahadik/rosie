# compiler (`@rosie/compiler`)

**Owner:** the playbook engineer (build prompt section 4). **Checked by:** QA.

Fixture set v1 and the step-graph compiler: from the master JSON, the trade files and Master Corrections to step-graph bundles. Also the lint, the plug-in key map, bundle ids, and parity with `step.js`.

The playbook engineer owns three folders:

- `compiler/`: the compiler's code in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`).
- `fixtures/`: fixture set v1, the master's `forms/` and `test-kit/` regenerated in `scratch/master-copy/` with G1 to G3 applied, committed with checksums and never edited by hand (hard rule 9). Prettier and ESLint skip it.
- `bundles/`: compiled step-graph bundles, each with its bundle id. Prettier and ESLint skip it.

The master's scripts run only in `scratch/master-copy/` (made writable with `chmod -R u+w`), never in the handover folder (hard rule 2). Tests never use the handover's own `forms/` or `test-kit/`.

D-000 holds only this file and `package.json`.
