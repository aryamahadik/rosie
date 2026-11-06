# ADR-012: GitHub Free gaps

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- The build prompt's release controls assume: `main` protected with "a pull request and green checks" (5.1; "How to use" step 1); a separate build login with write access only ("How to use" step 1); production keys as secrets of a GitHub environment usable only from `main` and train branches, with Jay or the CTO as its required reviewer (GitHub Enterprise), or else a `github.triggering_actor` check plus CODEOWNERS review of `.github/` (section 2, the table).
- The repository is private, on GitHub Free, with one login, and Free cannot protect a private repository's `main` (MC 8, "GitHub"). On Free, environment secrets and required reviewers exist only for public repositories (GitHub docs).
- Hooks can be bypassed, so a hook is never the only control (section 2).

## Decision

- **Pushes to `main`** are blocked locally by Claude Code's permission deny rules (`git push origin main`, `HEAD:main`, `--force`, `-f`) and by the PreToolUse hook (any push to `main` or `master`, a force push to a non-task branch, a bare push while on `main`). Only the lead merges, by pull request, after `merge-check.yml` passes (5.1, 6.5).
- **Production keys are never in GitHub,** and none is in any agent session: no production deploy script, workflow or secret exists (Q-50's default: until the CTO decides, he deploys production by hand). The hook and the deny rules block production deploys; the workflows touch staging only.
- **Approvals** count only as build prompt 9.1 allows: the user's answers in this build's chat, speaking for Jay (DL-009, DL-011). No GitHub action counts as Jay's or the CTO's, since one login cannot tell them apart from the build.
- **CODEOWNERS** (`/.github/` and `/.claude/` to `@aryamahadik`) is informational only.

## Consequences

- The local rules bind only Claude Code sessions on this Mac. GitHub does not stop a push to `main` made any other way; CI on `main`, the staging check and the back-only rollback job are what catch and undo it.
- Status checks and reviews cannot block a merge; the lead's merge queue (6.5) is the control.
- With one login, `github.triggering_actor` cannot tell the build from Jay or the CTO, so section 2's gate for plans without Enterprise cannot work as written. Production stays outside GitHub until the CTO decides (Q-50).
- The hook and the rules are the gate on the agent side, so their tests (`infra/ci/guard.test.mjs`) and D-000 check 2 (each blocked attempt shown) are the evidence that they work (5.9).
- Closing the gaps costs money: GitHub Pro or Team adds branch protection and environment secrets for a private repository; required reviewers on a private repository need GitHub Enterprise. Any of these is spend (rule 6). A second, write-only build login ("How to use" step 1; asked in Q-50) would separate the build's actions from a person's at no cost.

## Alternatives not chosen

- **A paid GitHub plan now:** spend that needs Jay's OK (rule 6); not asked for D-000.
- **Making the repository public to get Free's protections:** exposes the code; the repository is private by the team's choice (MC 8).
- **Production keys as plain repository secrets:** with no branch protection, any workflow on any branch, an agent's included, could read them (against section 2: "agent sessions hold none").

## Sources

- Build prompt "How to use" step 1; 2 (the table, and "a hook is never the only control"); 5.1; 5.4; 5.6; 5.9 (check 2); 6.5; 9.1.
- Architecture: silent on GitHub. Architecture 10, "Every platform area" (Security), keeps runtime secrets in Workers secrets, not in GitHub.
- MC 8, "GitHub".
- Q-50; DL-009, DL-011.
- D-000 spec, sections 7 and 9.
- Checked 2026-11-05: GitHub docs, "Deployments and environments" (required reviewers and environment secrets by plan).
