# ADR-001: Language and runtime

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Rosie's edge (gateway, secure pages, agent API) runs on Cloudflare Workers, and its conversation runtime is one Durable Object per handle (architecture 02, layer table; architecture 10, "Load balancing"). The Cloudflare account is on Workers Paid (MC 8, "Cloudflare").
- Many agents build lanes side by side against frozen contracts, and every branch runs a type check (build prompt 3.5, 5.2).
- Tools, scripts, the Claude Code hook and the tests run on the build Mac and in CI, outside Workers.

## Decision

- **Language:** TypeScript 5 (root manifest: `~5.9.3`), strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. ES modules; `module` ESNext with `moduleResolution` Bundler; target ES2022.
- **Product runtime:** Cloudflare Workers, `compatibility_date` 2026-11-01, `nodejs_compat`. Workers code is typed with `@cloudflare/workers-types`.
- **Outside Workers:** Node 22 (`.nvmrc`: `22`; root `engines`: `^22.12.0`) with npm 10. CI guards, the deploy and migrate scripts and the hook may be plain Node ES modules (`.mjs`, strict mode), so they run without a build step.

## Consequences

- One language from the webhook to the tests; contract types are generated once for every workspace (ADR-005).
- The linter bounds the TypeScript major: typescript-eslint 8.72.1 accepts TypeScript `>=4.8.4 <6.1.0`. TypeScript 7, the current release, waits until typescript-eslint supports it.
- Node 22 is in maintenance and reaches end of life on 2027-04-30; Node 24 and 26 are newer LTS lines. The build runs 10 to 30 days, so 22 holds. Move before April 2027: `.nvmrc`, `engines` and `@types/node`, then a green CI run.
- `nodejs_compat` is on by default from compatibility date 2026-08-04. Listing it is redundant, and the tools ignore the redundant flag.
- Workers rules apply to all product code: work that outlives the response needs `ctx.waitUntil()` (ADR-004), and the database is reached through Hyperdrive (ADR-007).

## Alternatives not chosen

- **JavaScript with JSDoc types:** weaker checks across lanes built in parallel.
- **Another runtime or host (containers, VMs, another edge):** the architecture fixes Workers and Durable Objects (architecture 02, 10).
- **Bun or Deno for tools:** a second runtime to install and pin; wrangler and the Workers test integration run under Node.
- **Node 24 or 26 now:** the build machine has Node 22.23.1, and nothing in D-000 needs a newer one.

## Sources

- Build prompt 3.5 (the parallel test), 4 (one owner per path), 5.2 (type check on every branch), 5.6 (the test, lint and type-check commands).
- Architecture 02, "From a text to a reply", layer table (Edge on Cloudflare Workers; conversation runtime on a Durable Object per handle). Architecture 10, "Every platform area" (Load balancing; Security: secrets in Workers secrets).
- MC 8, "Cloudflare" and "Build machine".
- D-000 spec, section 2; the root `package.json`.
- Checked 2026-11-05: the Node.js release schedule (`nodejs/Release`, `schedule.json`); Cloudflare, "Compatibility flags"; npm registry (typescript 7.0.2 is `latest`; typescript-eslint 8.72.1 peer range); build machine versions in `ops/SETUP.md`.
