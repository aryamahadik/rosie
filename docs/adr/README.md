# Architecture decision records

The architect's design records (build prompt section 4: the architect owns `contracts/`, `docs/adr/` and the generated contract types). Each record states one technical choice: its context, the decision, its consequences, the alternatives not chosen, and its sources.

## Status

Every record below is **proposed, default in use (D-000)**. The D-000 factory spec (`ops/plan/d000-factory-spec.md`, section 11) proposes it to the CTO, and the build uses it until he rules (build prompt section 1: never guess silently; use the default, log it, ask). The lead lists each record in `ops/DECISIONS.md` as a default in use and asks the CTO in `ops/QUESTIONS.md`; the architect never writes `ops/`. ADR-013 comes from a task card, T-1142 (the lead's ruling DL-322), not from D-000, and is proposed and in use the same way.

When the CTO rules:

- **Accepted:** the status becomes "accepted", with who answered, when and where. An answer counts only as build prompt 9.1 says.
- **Changed:** a new record supersedes this one, and both say so. The architect lists what was built on the old default, and the lead turns the rework into tasks. Nothing in flight stops (build prompt 6.4).

A record that work is built on is never rewritten to say something else; it is superseded.

## Records

| ADR                                                  | Title                              | Decision in one line                                                                                                                             | Status                            |
| ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| [ADR-001](0001-language-and-runtime.md)              | Language and runtime               | TypeScript 5 (strict) on Cloudflare Workers; Node 22 for tools, scripts and tests                                                                | proposed, default in use (D-000)  |
| [ADR-002](0002-monorepo-and-package-manager.md)      | Monorepo and package manager       | One repository, npm workspaces, one root lockfile, `npm ci` only                                                                                 | proposed, default in use (D-000)  |
| [ADR-003](0003-tests.md)                             | Tests                              | Vitest 5 projects; Cloudflare's Vitest plugin for Workers code; Playwright later for web                                                         | proposed, default in use (D-000)  |
| [ADR-004](0004-lint-and-format.md)                   | Lint and format                    | ESLint 10 flat config with typescript-eslint's type-checked strict and stylistic rules; Prettier 3                                               | proposed, default in use (D-000)  |
| [ADR-005](0005-contract-format.md)                   | Contract format                    | JSON Schema 2020-12 with fixtures in `contracts/<name>/`, the version in each file name; types generated in CI into a git-ignored folder         | proposed, default in use (D-000)  |
| [ADR-006](0006-postgresql-postgis-and-migrations.md) | PostgreSQL, PostGIS and migrations | PostgreSQL 17 with PostGIS; local Docker; plain SQL migrations, expand only, one queue                                                           | proposed, default in use (D-000)  |
| [ADR-007](0007-database-access-from-workers.md)      | Database access from Workers       | Hyperdrive with caching off for decision reads; postgres.js                                                                                      | proposed, default in use (D-000)  |
| [ADR-008](0008-environments.md)                      | Environments                       | Local; a preview per branch with its own schema; staging at `rosfield.com/test`; production later                                                | proposed, default in use (D-000)  |
| [ADR-009](0009-traces.md)                            | Traces                             | One trace id from webhook to delivery receipt; JSON logs; Workers Logs                                                                           | proposed, default in use (D-000)  |
| [ADR-010](0010-flags.md)                             | Flags                              | A PostgreSQL table per environment with allow-listed handles; production flags only from the protected release step                              | proposed, default in use (D-000)  |
| [ADR-011](0011-ci-runners.md)                        | CI runners                         | GitHub-hosted Linux runners within GitHub Free's included usage; checks only, no secrets (DL-024)                                                | proposed, default in use (D-000)  |
| [ADR-012](0012-github-free-gaps.md)                  | GitHub Free gaps                   | No branch protection, no environments, one login: local permission rules and hooks are the controls; production keys never in GitHub             | proposed, default in use (D-000)  |
| [ADR-013](0013-walking-skeleton-turn-one.md)         | The walking skeleton's turn        | Turn 1, Sam's first text (S1-01) to S1-02's question, through decide's two reads and one commit; each hop's fixture named (K-02 v1.1, K-09 v1.5) | proposed, default in use (T-1142) |
| [ADR-015](0015-safety-result-until-commit.md)        | The safety result until its commit | Each text's K-02 safety result is kept sealed in its handle actor's storage until its turn ends; the turn reads it there; no contract changes    | proposed, default in use (T-1241) |

## Short names used in the records

- **Build prompt:** `3 Build Plan Prompt for Claude.md` in the handover folder. "5.3" means its section 5.3.
- **Architecture NN:** section NN of `2 Technical Architecture/2 System Architecture.html` (revision 5.1), with the heading or table row named.
- **Tour:** `2 Technical Architecture/1 System Diagram and Tour.html`.
- **MC 8:** section 8 of `2 Technical Architecture/3 Master Corrections.md`, the decisions of Nov 5 2026. They win over older sources where they differ (its section 2, rule 4).
- **D-000 spec:** `ops/plan/d000-factory-spec.md`.
- **DL-nnn, Q-nn:** the lead's records in `ops/DECISIONS.md` and `ops/QUESTIONS.md`.
- Vendor documents and package registries are cited with the date they were checked.

## Adding a record

Take the next number, name the file `NNNN-short-title.md`, keep the same sections (context, decision, consequences, alternatives not chosen, sources, status), and add a row to the table above. Only the architect writes in this folder.
