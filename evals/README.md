# evals (`@rosie/evals`)

**Owner:** the QA and eval engineer (build prompt section 4).

The gold set, the accuracy report (architecture section 08) and replay.

- Evals never decide whether `main` is green (build prompt 5.2). A branch that changes what the AI does runs a fixed smoke slice of the gold set before its merge; the full gold set runs nightly and for each bundle release candidate, within the daily budget.
- Gold-set items come from walking the step graph and from fixture set v1; real customer data never enters them (hard rule 9).
- Unit tests for the eval code sit beside it (`src/**/*.test.ts`, Vitest project `unit`).

D-000 holds only this file and `package.json`.
