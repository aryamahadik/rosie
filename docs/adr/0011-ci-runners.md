# ADR-011: CI runners

- Status: proposed, default in use (D-000)
- Date: 2026-11-05; revised the same day for DL-024, before D-000 merged (nothing was built on the earlier text)
- Owner: architect. Decides: the CTO.

## Context

- CI runs on every push (format, lint, type check, unit and contract tests, the test and migration guards) and before every merge (adding integration, scenario and end-to-end tests) (build prompt 5.2, 6.5). Previews, staging deploys and the back-only rollback job (5.3, 5.4) do not run in CI: under DL-024 they run on the build Mac.
- The repository is private, on GitHub Free (MC 8, "GitHub"). Spend, meaning a new paid plan or usage past the budget, needs Jay's OK (rule 6, 7.11).
- The build machine holds `.dev.vars` and the Rosfield wrangler sign-in; keys never enter a worktree (5.1; MC 8, "Build machine").
- DL-024: no Cloudflare API token and no GitHub secrets.

## Decision

- GitHub-hosted `ubuntu-latest` runners only, within GitHub Free's included usage: $12 of Actions compute a month, about 2,000 minutes on Linux 2-core runners at $0.006 a minute.
- **Checks only, with no secrets** (DL-024): `ci.yml` on every push and pull request, and `merge-check.yml`, which the lead starts before a merge. CI never touches Cloudflare or any other outside service, and no deploy, preview, staging or rollback workflow exists.
- Previews, staging deploys and the back-only rollback run on the build Mac through the npm scripts (`deploy:preview`, `preview:cleanup`, `deploy:staging`, `rollback:staging`), with `cf.sh`'s Rosfield OAuth sign-in (ADR-008). `deploy:staging` rolls staging back by itself, with no click, when its post-deploy check fails, and the lead can run `rollback:staging` at any hour.
- Lean jobs: the npm cache; `concurrency` with cancel-in-progress per branch; path filters only where safe; the heavy suites only in the merge check the lead runs before a merge; the eval smoke slice a placeholder until the eval tasks exist (D-000 spec, section 7).
- Minutes used are logged in `ops/STATE.md`; Jay is asked before any overage, paid plan or self-hosted runner (Q-28).

## Consequences

- Round-the-clock CI may use up the allowance. With no payment method on file, jobs are blocked once it is used up, until the next month; with one, extra usage is billed unless a budget caps it. Adding a payment method or a budget is spend, so Jay decides (rule 6).
- macOS and Windows runners cost more per minute ($0.062 and $0.010), so no job uses them.
- Runners hold no secrets at all: the repository has none, so no workflow on any branch, an agent's included, can read a key (ADR-012).
- Deploys and rollbacks need the build Mac up, with the Rosfield sign-in; the Mac stays on (DL-024's trade-off).
- Artifact storage on Free is 500 MB, shared with Packages, so jobs upload only small reports.

## Alternatives not chosen

- **A self-hosted runner on the build Mac:** free, and it does not use the included usage, but workflow code would run on the machine that holds `.dev.vars` and the Rosfield sign-in (rule 7), and CI would depend on that one machine.
- **Paid minutes or a paid plan:** spend (rule 6); asked in Q-28 when the allowance runs low.
- **A second CI system (for example Cloudflare Workers Builds):** checks would live in two places, while the merge check is a GitHub workflow and deploys run on the build Mac.
- **Previews, staging deploys and the rollback job in CI, with a Cloudflare API token as a GitHub secret:** the design DL-024 replaced. Cloudflare cannot limit a token to one Worker (ADR-008), and without branch protection any workflow on any branch could read a repository secret (ADR-012).

## Sources

- Build prompt 2 (rules 6 and 7), 5.1, 5.2, 5.3, 5.4, 6.5, 7.11.
- Architecture: silent on CI. The gates CI runs come from architecture 10, "Every platform area" (Deploy).
- MC 8, "GitHub" and "Build machine".
- Q-28; DL-024.
- D-000 spec, sections 6 and 7.
- Checked 2026-11-05: GitHub docs, "GitHub Actions billing" (included usage, per-minute rates, self-hosted runners, storage).
