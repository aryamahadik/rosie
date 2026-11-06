# ADR-004: Lint and format

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Format, lint and type check run on every branch (build prompt 5.2). Turning off lint or type checks is a forbidden way to go green (7.9).
- A turn's writes and sends must happen exactly once (architecture 01, "One turn, one transaction, once"; architecture 10, "Exactly once"). In Workers, a promise that is not awaited, returned or passed to `ctx.waitUntil()` can be lost: "The Workers runtime may terminate your isolate before a floating promise completes" (Cloudflare, "Workers best practices").
- Many agents edit in parallel; formatting must never cause merge conflicts or review noise.

## Decision

- **ESLint 10** (root manifest: `^10.14.0`) with a flat config, `eslint.config.mjs`: typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`, with `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` as errors. `npm run lint` allows zero warnings.
- The D-000 spec said ESLint 9. typescript-eslint 8.72.1 accepts `^8.57.0 || ^9.0.0 || ^10.0.0`, and 10 has been the current major since 2026-02-06, so the default in use is 10.
- **Prettier 3:** `printWidth` 110, double quotes, `trailingComma` all. `eslint-config-prettier` turns off the lint rules that clash with it.
- Rules change only in `eslint.config.mjs`, by the release engineer.

## Consequences

- Floating promises, the bug most likely to lose a write or a send, fail the branch, as Cloudflare recommends.
- Type-aware rules need the TypeScript program, so lint is slower than syntax-only lint.
- The TypeScript major follows typescript-eslint's range (ADR-001).
- Generated contract types (`contracts/generated/`, ADR-005) are excluded: Prettier 3 skips git-ignored files by default; ESLint needs the folder in its `ignores`.
- Lowering a rule to get a branch green is 7.9's "turning off lint checks".

## Alternatives not chosen

- **Lint without type information:** faster, but blind to floating promises.
- **Biome (lint and format in one tool):** the rule sets this record relies on (`strictTypeChecked`, `no-floating-promises`, `no-misused-promises`) are typescript-eslint's; two linters would split the rule set.
- **No formatter:** style debates and noisy diffs across parallel branches.

## Sources

- Build prompt 5.2, 5.6, 7.9.
- Architecture 01, "One turn, one transaction, once"; architecture 10, "Decisions and trade-offs" (Exactly once).
- D-000 spec, sections 2 and 3; the root `package.json`.
- Checked 2026-11-05: Cloudflare, "Workers best practices" (floating promises; the `no-floating-promises` rule); npm registry (eslint 10.14.0, 9.39.5 on 9.x, 10.0.0 published 2026-02-06; typescript-eslint 8.72.1 peer range).
