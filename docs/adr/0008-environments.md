# ADR-008: Environments

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Build prompt 5.3: local PostgreSQL with PostGIS; a preview per branch with its own database or schema, removed after merge; staging with test doubles or test modes for every paid or outside service, plus the test tools of 9.4; production before launch with flags on only for the allow-listed test phones, and live keys only at M8 with Jay's OK.
- One Cloudflare account on Workers Paid holds staging and, for now, production. Wrangler runs with `XDG_CONFIG_HOME=$HOME/.config/rosfield` and a pinned `account_id` (MC 8, "Cloudflare"). This overrides J-05's separate production account for now (MC section 2, rule 4).
- The build lives under rosfield.com/test. rosfield.com's DNS is on Cloudflare, and that path serves a page today (DL-014, DL-023).
- D-000's first check: a trivial change goes from branch to CI to preview to staging, with its trace visible (5.9).

## Decision

- **Local:** wrangler only through `npm run cf` (`infra/scripts/cf.sh`: the Rosfield sign-in and the account guard), and PostgreSQL in Docker (ADR-006). Keys only in the git-ignored `.dev.vars`; none in a worktree (5.1).
- **A preview per branch:** `npm run deploy:preview` uploads a version of the staging Worker under a preview alias (`wrangler versions upload --env staging --preview-alias <slug>`), with its own schema `preview_<slug>` in the staging database once that exists. `preview-cleanup.sh` drops the schema when the pull request closes or the branch is deleted.
- **Staging:** Worker `rosie-staging`, `BASE_PATH` `/test`, on its workers.dev address until the user's OK switches on the route `rosfield.com/test*` (written, commented out). It deploys only from `main`, in the order of 5.4, with doubles and test modes only (Stripe test mode, J-12).
- **Production:** the Worker name `rosie` is reserved. No production deploy script, workflow or secret exists in D-000; until the CTO decides, he deploys production by hand (Q-50). The hook and the deny rules block every production deploy (D-000 spec, section 9).

## Consequences

- **This preview method stops working when the first Durable Object lands.** Cloudflare generates no version URLs for a Worker that implements a Durable Object, and the handle actor is one (architecture 02). Before that runtime task (M2), a new record picks the replacement: Cloudflare's Worker Previews (`wrangler preview`, open beta in Wrangler 4.158.0: a copy per branch with its own Durable Object namespace), or the Durable Object in a Worker of its own. Either needs new hook and permission rules.
- Requests to version URLs do not reach Workers Logs or `wrangler tail`, so a preview's trace id is read from its response. D-000's trace check reads Workers Logs on staging (ADR-009).
- Version URLs exist only on workers.dev. A preview alias must start with a lowercase letter, and alias plus Worker name must fit in 63 characters; slugs of `task/T-xxx` branches (`task-t-xxx`, at most 40 characters) fit.
- Until the staging database exists (J-06), previews and staging run without one and skip migrations with a notice.
- Cloudflare grants Workers permissions per account, and its permissions reference lists no way to limit a token to one Worker. A staging CI token could therefore change any Worker in the account. The controls: only `--env staging` in scripts and workflows; the hook and the deny rules; no production secret in GitHub (ADR-012); and Q-51 (production in its own account before live keys).
- `BASE_PATH` is `/test` on workers.dev too, so URLs keep their shape when the route goes live.

## Alternatives not chosen

- **A database per preview (for example a branch per preview on a hosted PostgreSQL):** stronger isolation, but it needs the host (J-06) and its API key. Schemas work on any PostgreSQL. Revisit with J-06.
- **A separate Worker per preview:** more Workers to clean up, and more deploy commands for the hook to allow. It becomes an option again when the Durable Object lands (above).
- **Staging on test.rosfield.com:** the user asked for "rosfield/test", and that path already serves the build's page (DL-014, DL-023).
- **A separate production account now (J-05):** MC 8 keeps one account for now; asked again in Q-51.

## Sources

- Build prompt "How to use" step 1; 3.7 (J-05, J-06, J-12); 5.1; 5.3; 5.4; 5.9 (check 1); 9.4.
- Architecture 02 (a Durable Object per handle); architecture 10, "Every platform area" (Deploy; Security: secrets in Workers secrets); architecture 12, "Critical path outside the code" (the Linq webhook moves to staging once staging is up).
- MC 8, "Cloudflare"; MC section 2, rule 4.
- DL-014, DL-023; Q-50, Q-51.
- D-000 spec, sections 6 and 7.
- Checked 2026-11-05: Cloudflare docs ("Version URLs"; "Previews"; API token permissions reference); `wrangler versions upload --help` and `wrangler preview --help` (Wrangler 4.158.0).
