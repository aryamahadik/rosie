# ADR-005: Contract format

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Before two components are built side by side, the interface between them is defined. Each contract has an owner (the architect), a version, its consumers, sample payloads as fixtures, and a contract test. It is frozen at v1 before the first task that builds against it starts (build prompt 3.3).
- Generated contract types belong to the architect and are built in CI, never committed by hand (3.5(c); section 4).
- The contract comes first: the model's verbs, the composer's message plan, the Tool API and the eval set, generated from the master's needs and gives keys, with the AI and the schema both behind it (architecture 12). The model answers with verbs and fields (architecture 03, "The model's contract"), and outside AIs call the Agent API over MCP and REST (architecture 02). All of it is JSON on the wire.

## Decision

- Every contract is a set of **JSON Schema 2020-12** files (`"$schema": "https://json-schema.org/draft/2020-12/schema"`) with fixtures, in `contracts/<name>/v<N>/`, where `<N>` is the major version. The layout and the change rules are in `contracts/README.md`.
- Each version folder has a `CONTRACT.md`: version (major.minor), status (draft or frozen), owner, consumers, sources, and a change log with the reason for each version (3.3, 6.4).
- Versions follow build prompt 6.4: an additive change is a minor version made inside `v<N>/`; a breaking change is a new `v<N+1>/` beside the old one, with the CTO's OK.
- **Types** are generated from the schemas in CI, into `contracts/generated/`, which is git-ignored: never committed, never edited. Locally, the same generator writes the same folder.
- **Tools (proposed; the release engineer adds them with the first contract, M1):** `json-schema-to-typescript` (its `json2ts` command) for the types; Ajv 8 with its 2020-12 class (`ajv/dist/2020`) to check fixtures and payloads.
- Schemas keep to keywords both tools handle: `type`, `properties`, `required`, `additionalProperties`, `$defs` and `$ref`, `enum`, `const`, `oneOf`, `anyOf`, `items`, and string and number limits. With `prefixItems`, `dependentRequired`, `dependentSchemas` or `unevaluatedProperties`, the generated type is wider than the schema; a contract that needs one says so in its `CONTRACT.md`.

## Consequences

- One language-neutral format for every boundary. The model's tool definitions and MCP's tool schemas are JSON Schema too, and 2020-12 is MCP's default dialect (MCP specification 2025-11-25).
- Types cannot drift from the schemas, since nothing generated is committed. The type check needs the generated folder, so CI generates before it type-checks. The npm script and the CI step arrive with the first contract; D-000 has none.
- Fixtures are also the sample data for doubles and mocks (M2: page and console shells "against a Tool API mock generated from the contract's fixtures").
- Contract tests are QA's, in `tests/contract/`; each consumer reviews its side (build prompt section 4).
- The database schema contract (3.3) describes rows and data-access calls in these schemas; the SQL in `db/migrations/` implements them, and its contract test checks that the two agree.

## Alternatives not chosen

- **Zod or TypeBox as the source:** the contract would be TypeScript code tied to one library, and the types would be inferred rather than generated (3.5(c) has them generated).
- **OpenAPI for everything:** it fits REST, not the model's verbs, the bundle format or table rows. OpenAPI 3.1 embeds JSON Schema 2020-12, so a REST contract can reuse these schemas later.
- **Protocol Buffers:** binary-first, and another toolchain; every boundary here is JSON.
- **Committing generated types:** drift and merge conflicts between lanes, which 3.5(c) forbids.
- **An older draft (draft-07):** works with the same tools, but 2020-12 is current and is MCP's default.

## Sources

- Build prompt 3.3, 3.4, 3.5(b) and (c), 4, 6.4, and "The starting shape" (M1, M2).
- Architecture 02 (Agent API: MCP and REST); architecture 03, "The model's contract"; architecture 12, "What comes first, and what blocks what" (the contract first).
- D-000 spec, section 11.
- Checked 2026-11-05: MCP specification 2025-11-25, changelog (SEP-1613); `json-schema-to-typescript` README (draft support table); Ajv docs, "JSON Schema" (draft 2020-12); npm registry (ajv 8.20.0, json-schema-to-typescript 16.0.0).
