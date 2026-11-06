# contracts (`@rosie/contracts`)

**Owner:** the architect (build prompt section 4). **Checked by:** each consumer, for its own side.

The interfaces between components. Before two components are built side by side, the interface between them is defined here (build prompt 3.3). Each contract has an owner (the architect), a version, its consumers, sample payloads as fixtures, and a contract test. The format is ADR-005 (`docs/adr/0005-contract-format.md`).

D-000 has no contracts yet: this folder holds this file and the workspace's `package.json`. Contracts are written and frozen one lane at a time in M1.

## What lives here

```text
contracts/
  README.md
  package.json          the @rosie/contracts workspace
  <name>/
    v<N>/               one folder per major version
      CONTRACT.md       version (major.minor), status (draft or frozen), owner, consumers, sources, change log
      *.schema.json     JSON Schema 2020-12
      fixtures/         sample payloads, each valid against its schema
                        (invalid samples in fixtures/invalid/, where a rule needs proving)
  generated/            TypeScript types built from the schemas: git-ignored, never committed or edited
```

The contracts and their names come from the plan (`ops/plan/02-contracts.md`; build prompt 3.3): the model's contract (verbs, choices, facts); the composer's message plan and slots; the Tool API; the eval-set format; the step-graph bundle format; the database schema and the data-access calls; the outbox and effect rows, and the event and trace format; and each port's interface. The build prompt's own example name is `db-schema` (section 10).

Not here: contract tests (QA, in `tests/contract/`, run by `npm run test:contract` on every branch, 5.2); the code that implements a contract (its owner's folder); migrations (`db/migrations/`, the database engineer).

## Frozen means

A contract is frozen at v1 before the first task that builds against it starts. Freezing follows the critical path: the bundle format and the model's contract; the core-table schema and data-access calls; the outbox, effect rows and trace format; the Tool API calls journeys 1 and 2 use; then each port; then the rest of the schema, domain by domain (3.3). A task is ready only when every contract it reads is frozen (3.4), and two tasks run side by side only if every contract both use is frozen at the same version (3.5(b)). A gap goes to `ops/QUESTIONS.md` with its default; it is never filled by a guess (3.3).

## Versions (build prompt 6.4)

Only the architect changes a contract, using the `contract-change` skill. Each change has a new version, its reason, every consumer listed, and updated fixtures and contract tests.

- **Additive** (a new optional field, endpoint or fixture): a minor version, such as v1 to v1.1, made inside `v1/`; `CONTRACT.md` records 1.1 and why. Old consumers keep working, and nobody pauses. A consumer adopts it only in a task that needs it.
- **Breaking** (a rename, a removal, or a changed meaning or type): a major version, with the CTO's OK, in a new folder `v2/` beside `v1/`. One migration task per consumer is created at once. `v1/` keeps working until the last consumer has moved; then it is removed in its own task, and its contract tests leave with it, listed in `tests/QUARANTINE.md` as a contract-removal task.
- Tasks already building finish on the version they started with. Only tasks not yet started wait.
- A second breaking change to the same contract within 7 days goes to the CTO as a design problem.
- When Jay decides against a default the team built on, the architect lists what was built on it, and the lead turns the rework into tasks. Nothing in flight stops.
- Nobody changes a contract mid-task to make their own task easier.

## Generated types are never committed

TypeScript types are generated from the schemas in CI, into `contracts/generated/`, which is git-ignored (build prompt 3.5(c): generated contract types belong to the architect and are built in CI, never committed by hand). Nobody edits or commits them. CI generates them before the type check, and locally the same generator writes the same folder. The generator, its npm script and the CI step come with the first contract (M1); ADR-005 proposes `json-schema-to-typescript` for the types and Ajv's 2020-12 class for checking fixtures.
