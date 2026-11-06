# ADR-011: CI runners

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- CI runs on every push (format, lint, type check, unit and contract tests, the test and migration guards), before every merge (adding integration, scenario and end-to-end tests), for previews, for staging deploys, and for the back-only rollback job (build prompt 5.2, 5.4, 6.5).
- The repository is private, on GitHub Free (MC 8, "GitHub"). Spend, meaning a new paid plan or usage past the budget, needs Jay's OK (rule 6, 7.11).
- The build machine holds `.dev.vars` and the Rosfield wrangler sign-in; keys never enter a worktree (5.1; MC 8, "Build machine").

## Decision

- GitHub-hosted `ubuntu-latest` runners only, within GitHub Free's included usage: $12 of Actions compute a month, about 2,000 minutes on Linux 2-core runners at $0.006 a minute.
- Lean jobs: the npm cache; `concurrency` with cancel-in-progress per branch; path filters only where safe; the heavy suites only in the merge check the lead runs before a merge; the eval smoke slice a placeholder until the eval tasks exist (D-000 spec, section 7).
- Minutes used are logged in `ops/STATE.md`; Jay is asked before any overage, paid plan or self-hosted runner (Q-28).

## Consequences

- Round-the-clock CI may use up the allowance. With no payment method on file, jobs are blocked once it is used up, until the next month; with one, extra usage is billed unless a budget caps it. Adding a payment method or a budget is spend, so Jay decides (rule 6).
- macOS and Windows runners cost more per minute ($0.062 and $0.010), so no job uses them.
- Runners hold only the CI secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_DATABASE_URL`), never a production secret (ADR-012).
- Artifact storage on Free is 500 MB, shared with Packages, so jobs upload only small reports.

## Alternatives not chosen

- **A self-hosted runner on the build Mac:** free, and it does not use the included usage, but workflow code would run on the machine that holds `.dev.vars` and the Rosfield sign-in (rule 7), and CI would depend on that one machine.
- **Paid minutes or a paid plan:** spend (rule 6); asked in Q-28 when the allowance runs low.
- **A second CI system (for example Cloudflare Workers Builds):** checks would live in two places, while the merge check and the rollback job are GitHub workflows.

## Sources

- Build prompt 2 (rules 6 and 7), 5.1, 5.2, 5.4, 6.5, 7.11.
- Architecture: silent on CI. The gates CI runs come from architecture 10, "Every platform area" (Deploy).
- MC 8, "GitHub" and "Build machine".
- Q-28.
- D-000 spec, section 7.
- Checked 2026-11-05: GitHub docs, "GitHub Actions billing" (included usage, per-minute rates, self-hosted runners, storage).
