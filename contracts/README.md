# contracts (`@rosie/contracts`)

**Owner:** the architect (build prompt section 4). **Checked by:** each consumer, for its own side.

The interfaces between components. Before two components are built side by side, the interface between them is defined here (build prompt 3.3). Each contract has an owner (the architect), a version, its consumers, sample payloads as fixtures, and a contract test. The format is ADR-005 (`docs/adr/0005-contract-format.md`); the conventions below fill it in (`ops/plan/02-contracts.md` sections 1 and 2).

No real contract is here yet: contracts are written and frozen one lane at a time from M1 (T-008 onward). This folder holds the conventions, the shared formats, the meta-schemas and the tools.

## What lives here

```text
contracts/
  README.md                      this file
  package.json                   the @rosie/contracts workspace: its "types" and "check" scripts
  common/
    formats.v1.schema.json       shared formats: ids, money, times (CQ-09)
    fixtures-index.meta.schema.json   the shape of every fixtures/index.json
    frozen.meta.schema.json      the shape of every frozen.json
    fixtures/                    samples of the shared formats, accepted and refused
  db-schema/
    tables.meta.schema.json      the shape of every database part's table list
    <part>/                      one folder per database part (core, then the domain parts), from T-008 onward
      <part>.v1.tables.json      the part's table list
      fixtures/                  seed rows, with their index.json
  <name>/                        one folder per contract (bundle, model, message-plan, tool-api, ...), from T-008 onward
    README.md                    what it defines, owner, consumers, sources, freeze record, change log, open gaps
    <name>.v1.schema.json        JSON Schema 2020-12, one file per version
    <name>.v1.1.schema.json      a minor version: a new file that only adds
    fixtures/
      index.json                 every fixture: file, version, accept or refuse, what it shows, source
      *.json                     sample payloads (refused ones in fixtures/invalid/ by habit)
    frozen.json                  the frozen versions: {"frozen": ["v1"]}
  scripts/
    check-fixtures.mjs           the check behind `npm run contracts:check`
    gen-types.mjs                the generator behind `npm run contracts:types`
    lib.mjs                      what the two share
    contract-tools.test.mjs      the tools' own tests
    test-sample/                 not a contract: the sample the tools are proven on
  generated/                     TypeScript types built from the schemas: git-ignored, never committed or edited
```

The contracts and their names come from the plan (`ops/plan/02-contracts.md` section 3; build prompt 3.3): the model's contract (verbs, choices, facts); the composer's message plan and slots; the Tool API; the eval-set format; the step-graph bundle format; the database schema and the data-access calls; the outbox and effect rows, and the event and trace format; and each port's interface.

Not here: contract tests (QA, in `tests/contract/<name>.v<N>.test.ts`, run by `npm run test:contract` on every branch, 5.2); the code that implements a contract (its owner's folder); migrations (`db/migrations/`, the database engineer); the Tool API mock (C-186, an M2 task).

## Conventions (02-contracts section 2)

1. **One folder per contract**, `contracts/<name>/`, with the version in each schema file's name: `<name>.v1.schema.json`, then `<name>.v1.1.schema.json` for a minor version (CQ-02). There are no `v<N>/` folders.
2. **JSON Schema 2020-12.** Every schema file starts with `"$schema": "https://json-schema.org/draft/2020-12/schema"` and `"$id": "https://rosie.invalid/contracts/<its path inside contracts/>"`. The `.invalid` name never resolves, so no tool fetches a schema over the network. A schema refers to another file with a relative `$ref`, such as `"../common/formats.v1.schema.json#/$defs/money"`; it resolves the same way from the `$id` (Ajv) and from the file on disk (the type generator). A call contract holds each call's request, response and errors under `$defs` (`<call>.request`, `<call>.response`, `<call>.errors`); its README states each call's meaning where a source gives it (primary or replica read, whether repeating it is safe, time budget). Closed lists are enums.
3. **Database parts as table lists**: `contracts/db-schema/<part>/<part>.v1.tables.json`, checked against `db-schema/tables.meta.schema.json`. Per table: columns (type, null, default), primary key, foreign keys, unique, EXCLUDE and CHECK constraints, indexes, row-level security scope, whether rows carry a version, whether they carry effective dates, which fields are sealed under a per-person key, each field's audience (customer, staff, owner, secure page only, or never) and whether it is written once at booking. The database engineer's migrations produce exactly this list.
4. **Every field names its source** in its `description`: a step id, an architecture line, a RULES section or an FS row.
5. **Fixtures** live in `<name>/fixtures/`, each listed in `fixtures/index.json` (shape: `common/fixtures-index.meta.schema.json`) with the version it was written for, `accept` or `refuse`, what it shows and its source. An entry checks against `<name>.<version>.schema.json` unless it names another `schema`, and against the schema's root unless it names a `def` under `$defs`. A database seed row names its `table` instead; the part's contract test checks it against a migrated database. No real customer data, ever (rule 9): names and values are made up or come from fixture set v1's demo shops. A minor version adds fixtures and never edits an old one.
6. **Shared formats** (`common/formats.v1.schema.json`, CQ-09's default until the CTO rules): an opaque id is a non-empty string; a turn id is a hash of its texts' event ids; a bundle id is a content hash plus a build number; money is whole cents with a three-letter currency code, never a decimal; every time is an instant in UTC (RFC 3339, ending in `Z`) with its IANA zone. Contracts refer to these with `$ref` rather than restating them.
7. **Model-facing schemas stay inside the structured-outputs subset.** The schemas the model answers in (K-02's decide, safety read and planner outputs; K-03's message plan) use only what the model API's structured outputs accept: no recursive schemas, no number limits (`minimum`, `maximum`, `multipleOf`), no string-length limits (`minLength`, `maxLength`), no array limits beyond what the subset allows, and `additionalProperties` only as `false`. Limits such as "at most one question" or "2 to 5 poll options" are code checks (C-092 message checks, C-128 allowed formats), not schema keywords. The shared formats keep to the same subset, so a model-facing schema may refer to them. A spike confirms the subset on the models in use once the model key lands (DL-021, DL-026).
8. **One validator**: Ajv 8 with its 2020-12 class, in strict mode, for the fixture check, the contract tests and the Tool API mock.
9. **Keys are named, never shown** (rule 7): a port contract names the secret a call needs and never holds a value.

## Checking and generating

- `npm run contracts:check` (the workspace's `check` script) checks every schema (2020-12, compiles in strict mode, `$id` and file name follow convention 2), every `fixtures/index.json` and each fixture it lists (accepted ones pass, refused ones fail, every fixture file is listed, an accepted fixture also passes every later minor version), every `frozen.json` and every table list (shape, and every column a key, constraint, index, scope, version, effective-date or seal names exists). Then it runs the tools' own tests. CI runs it on every branch.
- `npm run contracts:types` (the workspace's `types` script) writes one TypeScript module per contract schema into `contracts/generated/`, for example `generated/common/formats.v1.ts`, with `json-schema-to-typescript`. Meta-schemas and `scripts/test-sample/` get no types. CI runs it before the type check; locally, run it before `npm run typecheck` once a contract is in use.

## Frozen means unchanged

A contract is frozen at v1 before the first task that builds against it starts. Freezing follows the critical path: the bundle format and the model's contract; the core-table schema and data-access calls; the outbox, effect rows and trace format; the Tool API calls journeys 1 and 2 use; then each port; then the rest of the schema, domain by domain (3.3). A task is ready only when every contract it reads is frozen (3.4), and two tasks run side by side only if every contract both use is frozen at the same version (3.5(b)). A gap goes to `ops/QUESTIONS.md` with its default; it is never filled by a guess (3.3).

- **`frozen.json`** sits at `contracts/<name>/frozen.json`, in the shape `{"frozen": ["v1", "v1.1"]}` (`common/frozen.meta.schema.json`): versions oldest first, only ever added. The frozen-contract guard (`npm run guard:contracts`, `infra/ci/contract-freeze-guard.mjs`, T-005) reads it as it is on `main` and fails a branch that edits or removes a schema or table list whose file name carries a frozen version, a fixture that `fixtures/index.json` lists for a frozen version, that version's index entries, or a version in `frozen.json`. Adding files always passes, so a frozen version changes only by a new minor version file and new fixtures.
- **The freeze record** goes in the contract's README: "Frozen v1, <date>, reviewed by <consumer roles>". The lead records it in `ops/DECISIONS.md` and on the board (5.7).
- **Database parts:** the guard reads `frozen.json` only at `contracts/<name>/`, so every part shares `contracts/db-schema/frozen.json`. Once v1 is listed there, an edit to any part's v1 table list fails, even a part that freezes later (3.3: domain by domain). Until the guard reads a `frozen.json` per part, a part's table list is merged only when it is ready to freeze (open with the lead: a guard change is the release engineer's).

## Versions (build prompt 6.4)

Only the architect changes a contract, using the `contract-change` skill. Each change has a new version, its reason, every consumer listed, and updated fixtures and contract tests.

- **Additive** (a new optional field, endpoint or fixture): a minor version, such as v1 to v1.1: a new file `<name>.v1.1.schema.json` beside `<name>.v1.schema.json`, which stays as it is; the README's change log records 1.1 and why. Old consumers keep working, and nobody pauses. A consumer adopts it only in a task that needs it.
- **Breaking** (a rename, a removal, or a changed meaning or type): a major version, with the CTO's OK, as `<name>.v2.schema.json` beside v1. One migration task per consumer is created at once. v1 keeps working until the last consumer has moved; then it is removed in its own task, and its contract tests leave with it, listed in `tests/QUARANTINE.md` as a contract-removal task.
- Tasks already building finish on the version they started with. Only tasks not yet started wait.
- A second breaking change to the same contract within 7 days goes to the CTO as a design problem.
- When Jay decides against a default the team built on, the architect lists what was built on it, and the lead turns the rework into tasks. Nothing in flight stops.
- Nobody changes a contract mid-task to make their own task easier.

## Generated types are never committed

TypeScript types are generated from the schemas into `contracts/generated/`, which is git-ignored (build prompt 3.5(c): generated contract types belong to the architect and are built in CI, never committed by hand). Nobody edits or commits them; the generator empties the folder each time it runs.
