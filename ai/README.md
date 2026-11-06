# ai (`@rosie/ai`)

**Owner:** the AI engineer (build prompt section 4). **Checked by:** QA, through evals.

The safety read, decide (two reads), the Sonnet re-read, the planner, the composer, the AI gateway and prompt caching (architecture sections 03, 06 and 07). This code never touches the database, builds the frontier or checks a limit.

- Every routine message comes from the step graph through the composer (hard rule 3), and the model never writes a number a person reads (hard rule 4).
- Unit tests sit beside the code (`src/**/*.test.ts`, Vitest project `unit`) and use doubles for the model; no key enters a test. Accuracy is measured by evals in `evals/` (QA).

D-000 holds only this file and `package.json`.
