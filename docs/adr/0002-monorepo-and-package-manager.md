# ADR-002: Monorepo and package manager

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Every component has exactly one owner and one folder (build prompt section 4). Two tasks run side by side only if they touch no common file; the root package manifest, lockfile, wrangler config and CI belong to the release engineer (3.5(c)).
- Builders work in worktrees branched from `main` and install from the lockfile only (5.1, 5.6).
- There is one `main`, one merge queue, and contracts that every lane shares (3.3, 6.5).

## Decision

- One repository, `aryamahadik/rosie`: trunk-based, one short branch per task, `task/T-xxx` (5.1).
- npm workspaces, each private, named `@rosie/<folder>`, `"type": "module"`: `contracts`, `compiler`, `db`, `runtime`, `actions`, `ai`, `adapters`, `web`, `evals`, `tests`. `infra/`, `.github/`, `.claude/`, `docs/`, `bundles/` and `fixtures/` are plain folders.
- npm 10 with one root `package-lock.json`. Builders and CI install with `npm ci` only. Only the release engineer changes the root manifest and the lockfile; a builder who needs a package reports a NEED (6.3).
- Unit tests live beside the code, in the owner's workspace (section 4).

## Consequences

- Dependency changes form one queue through the release engineer, so parallel tasks never fight over the lockfile.
- A lane's use of other lanes shows in its `package.json` (`@rosie/...`), which reviewers can check against the card.
- npm hoists packages to the root, so code can import a package its own workspace does not declare. Reviews check each workspace's `package.json`.
- Every fresh worktree runs `npm ci` and uses disk; the lead stops assigning under 20 GB free (5.1).

## Alternatives not chosen

- **pnpm or Yarn:** pnpm's strict isolation would stop undeclared imports, but it is another tool to install, pin and teach every builder. npm ships with Node and is on the build machine (npm 10.9.8).
- **A build orchestrator (Nx, Turborepo):** task graphs and caches the build prompt does not ask for; TypeScript and the Vitest projects cover D-000.
- **Several repositories:** a contract change would span repositories, and the one merge queue (6.5) would split.

## Sources

- Build prompt 3.3, 3.5(c), 4, 5.1, 5.6, 6.3, 6.5.
- Architecture 02, "From a text to a reply" (the components that become workspaces); architecture 12, "What comes first, and what blocks what" (contract, step graph, core tables, runtime).
- D-000 spec, sections 1 and 2; the root `package.json`.
