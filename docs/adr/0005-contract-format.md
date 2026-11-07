# ADR-005: Contract format

- Status: proposed, default in use (D-000; layout revised by T-006 to CQ-02's default, see "Revisions")
- Date: 2026-11-05; revised 2026-11-07 (T-006)
- Owner: architect. Decides: the CTO.

## Context

- Before two components are built side by side, the interface between them is defined. Each contract has an owner (the architect), a version, its consumers, sample payloads as fixtures, and a contract test. It is frozen at v1 before the first task that builds against it starts (build prompt 3.3).
- Generated contract types belong to the architect and are built in CI, never committed by hand (3.5(c); section 4).
- The contract comes first: the model's verbs, the composer's message plan, the Tool API and the eval set, generated from the master's needs and gives keys, with the AI and the schema both behind it (architecture 12). The model answers with verbs and fields (architecture 03, "The model's contract"), and outside AIs call the Agent API over MCP and REST (architecture 02). All of it is JSON on the wire.
- The contracts plan (`ops/plan/02-contracts.md` section 2) fills in this record's first draft, and its CQ-02 proposes one folder per contract with the version in each schema file's name, instead of a folder per version (`ops/QUESTIONS.md` CQ-02: "ADR-005 matches").

## Decision

- Every contract is a set of **JSON Schema 2020-12** files (`"$schema": "https://json-schema.org/draft/2020-12/schema"`) with fixtures, in **one folder per contract, `contracts/<name>/`, with the version in each schema file's name**: `<name>.v1.schema.json`, then `<name>.v1.1.schema.json` for a minor version (CQ-02). A database part is a table list, `contracts/db-schema/<part>/<part>.v1.tables.json`, checked against `contracts/db-schema/tables.meta.schema.json`. The layout and conventions are in `contracts/README.md`.
- Each schema's `$id` is `https://rosie.invalid/contracts/<its path inside contracts/>`. The name never resolves, so nothing is fetched over the network; a relative `$ref` between files resolves the same way from the `$id` and from the file on disk.
- Each contract folder has a `README.md`: what it defines, owner, consumers, sources, the freeze record ("Frozen v1, <date>, reviewed by <consumer roles>"), a change log with the reason for each version, and open gaps (3.3, 6.4).
- **Fixtures** are listed in `contracts/<name>/fixtures/index.json` (shape: `contracts/common/fixtures-index.meta.schema.json`): file, version, accept or refuse, what it shows, source. A minor version adds fixtures and never edits an old one.
- **Frozen versions** are listed in `contracts/<name>/frozen.json` as `{"frozen": ["v1"]}` (shape: `contracts/common/frozen.meta.schema.json`). The frozen-contract guard (`npm run guard:contracts`, T-005) reads it from `main` and fails a branch that edits a frozen version's files or fixtures or lifts a freeze.
- Versions follow build prompt 6.4: an additive change is a new minor-version file that only adds; a breaking change is a new major-version file beside the old one, with the CTO's OK.
- **Shared formats** (ids, money, times) are one schema, `contracts/common/formats.v1.schema.json`, that contracts refer to with `$ref` (CQ-09's default).
- **Model-facing schemas** stay inside the JSON Schema subset the model API's structured outputs accept (02-contracts section 2 item 7): limits such as minimum or maximum counts are code checks, not schema keywords.
- **Types** are generated from the schemas into `contracts/generated/`, which is git-ignored: never committed, never edited. CI generates them before the type check; locally the same generator writes the same folder.
- **Tools:** `json-schema-to-typescript` (15.0.4 in the root manifest) for the types, through `npm run contracts:types` (`contracts/scripts/gen-types.mjs`); Ajv 8 (8.20.0) with its 2020-12 class (`ajv/dist/2020`), in strict mode, to check fixtures, table lists and `frozen.json`, through `npm run contracts:check` (`contracts/scripts/check-fixtures.mjs`). Both run in CI on every branch.
- Schemas keep to keywords both tools handle: `type`, `properties`, `required`, `additionalProperties`, `$defs` and `$ref`, `enum`, `const`, `oneOf`, `anyOf`, `items`, and string and number limits (outside model-facing schemas). With `prefixItems`, `dependentRequired`, `dependentSchemas` or `unevaluatedProperties`, the generated type is wider than the schema; a contract that needs one says so in its README.

## Consequences

- One language-neutral format for every boundary. The model's tool definitions and MCP's tool schemas are JSON Schema too, and 2020-12 is MCP's default dialect (MCP specification 2025-11-25).
- One folder per contract keeps every version of a contract side by side, so a minor version is visibly a new file beside the frozen one, and the frozen-contract guard can tell a file's version from its name alone.
- Types cannot drift from the schemas, since nothing generated is committed. The type check needs the generated folder, so CI generates before it type-checks.
- Fixtures are also the sample data for doubles and mocks (M2: page and console shells "against a Tool API mock generated from the contract's fixtures").
- Contract tests are QA's, in `tests/contract/<name>.v<N>.test.ts`; each consumer reviews its side (build prompt section 4).
- The database schema contract (3.3) describes rows in table lists and the data-access calls in schemas; the SQL in `db/migrations/` implements them, and its contract test checks that the two agree.
- The guard reads `frozen.json` only at `contracts/<name>/`, so the database parts share `contracts/db-schema/frozen.json` until the guard reads one per part (`contracts/README.md`, "Frozen means unchanged").

## Alternatives not chosen

- **A folder per major version (`contracts/<name>/v<N>/`), this record's first draft:** a minor version would edit files inside a frozen folder, and the version would live in the folder rather than the file. CQ-02 proposes the file-name layout instead.
- **Zod or TypeBox as the source:** the contract would be TypeScript code tied to one library, and the types would be inferred rather than generated (3.5(c) has them generated).
- **OpenAPI for everything:** it fits REST, not the model's verbs, the bundle format or table rows. OpenAPI 3.1 embeds JSON Schema 2020-12, so a REST contract can reuse these schemas later.
- **Protocol Buffers:** binary-first, and another toolchain; every boundary here is JSON.
- **Committing generated types:** drift and merge conflicts between lanes, which 3.5(c) forbids.
- **An older draft (draft-07):** works with the same tools, but 2020-12 is current and is MCP's default.

## Revisions

- 2026-11-07, T-006: the layout changes from `contracts/<name>/v<N>/` (with a `CONTRACT.md` per version folder) to `contracts/<name>/` with the version in each file's name and one `README.md` per contract, matching CQ-02's default, which the frozen-contract guard (T-005) already reads. Nothing had been built on the `v<N>/` folders (no contract existed), so this revises a default no work stands on rather than superseding it (`docs/adr/README.md`). The tools, the `$id` convention, the fixtures index, `frozen.json` and the shared formats are added.

## Sources

- Build prompt 3.3, 3.4, 3.5(b) and (c), 4, 6.4, and "The starting shape" (M1, M2).
- `ops/plan/02-contracts.md` sections 1 and 2 (items 1 to 13); `ops/QUESTIONS.md` CQ-02 (layout) and CQ-09 (ids, money and times).
- Architecture 02 (Agent API: MCP and REST); architecture 03, "The model's contract"; architecture 12, "What comes first, and what blocks what" (the contract first).
- D-000 spec, section 11.
- Checked 2026-11-05: MCP specification 2025-11-25, changelog (SEP-1613); `json-schema-to-typescript` README (draft support table); Ajv docs, "JSON Schema" (draft 2020-12). Installed versions checked 2026-11-07 with `npm ls`: ajv 8.20.0, json-schema-to-typescript 15.0.4.
