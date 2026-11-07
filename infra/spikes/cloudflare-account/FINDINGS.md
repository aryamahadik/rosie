# T-1129 findings: one Cloudflare account for staging and production (Q-51)

Spike T-1129, Nov 7 2026, for the CTO and Jay before production is configured. A research agent with web access read Cloudflare's developer documents (DL-064); the lead wrote this file from its text report (DL-063). Research only: no account, token, login or script changed. Time: about 14 minutes of research, about 15 pages read (limit 2 hours).

Every claim cites a Cloudflare page listed at the end, read on Nov 7 2026, with the page's own "Last updated" date. "Unknown" means no page read answered it. The fetch tool summarizes each page through a small model, so the wording of a cited claim is worth a check on the live page before the CTO relies on it.

**Today (DECISIONS.md):** staging deploys and rollbacks run through wrangler's one-click OAuth login (DL-024); `infra/scripts/cf.sh` refuses `--name`, `--config` and name overrides that could reach anything but the `rosie-staging` Worker (DL-033, DL-037). The staging and production split is therefore enforced by Rosie's own script and hook, not by Cloudflare.

## 1. API token permissions for Workers

- Workers permissions are split by level: at account level, Workers Scripts (Read, Edit), Workers KV Storage, Workers R2 Storage, Queues, Hyperdrive and Workers Tail Read; at zone level, Workers Routes (Read, Edit) [S1].
- A token's policy is of type Account, User or Zone, and its resource rules name the accounts or zones it covers (the page's example: "Zone DNS Read for example.com") [S2].
- So Workers Scripts can be limited to one account, and Workers Routes to named zones such as rosfield.com. Neither page says a token can be limited to named Workers scripts, and the permission list shows no such option: **per-script scoping is unknown, with no sign that it exists.** A token with Workers Scripts Edit can edit every Worker in the account, staging and production alike.
- Cloudflare's GitHub Actions guide uses the "Edit Cloudflare Workers" token template and advises scoping a token to the account and zones it needs [S9].

## 2. Account member roles

- Roles that touch Workers: Workers Platform Admin (edit and read on Workers, Pages, Durable Objects, KV, R2, zones and others), Workers Platform (Read-only), Workers Editor (the Workers Playground only), Administrator (the whole account except members and billing), Secrets Store Admin and Secrets Store Deployer [S3]. No role named "Workers Admin" is listed.
- Domain-scoped roles exist (Domain Administrator, Domain DNS, Cache Domain Purge, Zone Versioning and others), and none is a Workers role. The only resource-scoped roles (beta) cover Access, Gateway and Tunnel items [S3].
- **A member cannot be limited to some Workers or environments: account roles apply to the whole account** [S3].

## 3. Wrangler's OAuth login and a scoped API token

- `wrangler login` asks for all available scopes by default; `--scopes-list` prints them and `--scopes` takes a narrower list, for example `wrangler login --scopes account:read user:read` [S5].
- The page does not list the scope names, so which scopes `wrangler deploy`, KV, Queues and Hyperdrive need is unknown; the build Mac could list them with `wrangler login --scopes-list` (a local listing). Narrowed scopes limit kinds of API (for example, no R2), not single Workers: the login stays account-wide for the Workers it can reach [S5].
- API tokens may be used instead of the login in headless or CI use, through `CLOUDFLARE_API_TOKEN` [S5][S6]. Neither page states the permissions `wrangler deploy` needs; the CI guide names only the "Edit Cloudflare Workers" template [S9].
- So a scoped token can run `wrangler deploy --env staging`, but it would be account-wide for Workers Scripts, with zone-limited routes. Against Q-51 it gains nothing over the OAuth login except expiry and revocation.

## 4. Other separation inside one account

- **Wrangler environments** create a separate Worker named `<top-level-name>-<environment-name>`; bindings and variables are not inherited and secrets are per environment; `account_id`, `route` and `routes` are inherited [S7][S8]. The pages describe no access control between environments: a naming and configuration split, not a permission boundary.
- **Separate scripts** are the same: two Worker names in one account, both covered by the same permissions.
- **Workers for Platforms** isolates customers' untrusted code in dispatch namespaces [S10]. The overview says nothing about scoping a deployer and shows no price (both unknown); it does not fit a staging and production split.
- **Organizations** group several accounts under central member and policy management, for Enterprise customers and MSSP or distributor partners [S11]. The page does not cover other plans or shared billing, so it is not shown to be open to a Workers Paid account (unknown). No page read confirms several self-serve accounts under one billing; the multiple-accounts page returned 404.
- **Result:** no Cloudflare setting inside one account stops a deployer from reaching the production Worker; only Rosie's own guard does.

## 5. Moving production to its own account

- **Plan:** Workers Paid is "a minimum charge of $5 USD per month per account", plus usage beyond the included amounts [S12]. A second account costs another $5 a month plus its own usage, with its own allowance. Whether one login and one card can hold two accounts: unknown.
- **The zone:** to move rosfield.com, add it to the new account, change the nameservers at the registrar, then re-check [S13]. DNS records do not carry over (export and import them); Universal SSL is reissued and custom certificates re-uploaded; the domain cannot proxy through Cloudflare while Pending (no duration given); the old zone shows "Moved Away" and is deleted after 7 days; DNSSEC and add-ons are removed first [S13]. Domains registered with Cloudflare Registrar need a separate inter-account transfer (a page seen only in search results, not read; unknown detail). Workers routes are not mentioned (unknown); they belong to the zone, so they would be recreated.
- **Keeping rosfield.com where it is** and giving production another host: the pages read do not cover routes across accounts, so a production account would need its own zone for any custom domain; a workers.dev address needs none. Whether production must serve on rosfield.com (secure links at rosfield.com/<code>, Q-51) is the CTO's call (unknown here).
- **Bindings and secrets:** bindings and secrets are declared per environment [S7], so KV, Queues, R2, Hyperdrive and secrets are created and filled afresh in a new account; no page read describes a built-in way to copy them between accounts (unknown). R2 must be enabled in the new account (it was off by default here, DL-025); the Hyperdrive configuration is per account; secrets are set again, never copied through logs.

## Options for Q-51

| Option                                                                  | Work                                                                                                                                                                                                                                                                                                                           | Money                                 | What it gives                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. One account until M8, keep Rosie's guard** (today's default)       | None new: keep `account_id` pinned, production Workers under their own names, `cf.sh`'s refusals and the production-deploy hook                                                                                                                                                                                                | $5 a month, as now                    | A guard written by Rosie, not enforced by Cloudflare: the login or any token can still edit production. Fits while no live keys exist; the risk grows once production holds live keys |
| **B. A second account for production, before live keys**                | New account and plan; R2 enabled; new KV, Queues and Hyperdrive; every secret re-entered; a second wrangler login with its own config folder; `cf.sh` and the deploy hook updated; a zone move or new routes if production uses rosfield.com (about half a day, plus the DNS and SSL wait, for which no page gives a duration) | Another $5 a month plus its own usage | A hard Cloudflare boundary: the staging login or token never reaches production                                                                                                       |
| **C. One account, a scoped API token for staging instead of the login** | Small: create and store a token (DL-024 chose no token)                                                                                                                                                                                                                                                                        | None                                  | Only expiry, revocation and zone-limited routes; Workers Scripts stays account-wide, so it is **not a boundary**                                                                      |
| **D. Organizations or Workers for Platforms**                           | Unknown                                                                                                                                                                                                                                                                                                                        | Not shown                             | Organizations: Enterprise or partners only on the page read; Workers for Platforms: built for untrusted customer code; neither fits                                                   |

**For the CTO and Jay:** Cloudflare cannot narrow deploy rights to staging inside one account. Option A is acceptable until M8 only while the guard stays and production holds no live keys. Option B, before live keys, is the only real boundary, at about $5 a month plus the move work. Both depend on the CTO's decision on whether production serves on rosfield.com.

## Sources

All read on Nov 7 2026.

- [S1] API token permissions (last updated Oct 30 2026): https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [S2] Create API token (last updated Nov 6 2026): https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- [S3] Account roles (last updated Oct 12 2026): https://developers.cloudflare.com/fundamentals/manage-members/roles/
- [S4] Wrangler commands, index (last updated Apr 23 2026): https://developers.cloudflare.com/workers/wrangler/commands/
- [S5] Wrangler general commands, `login` and `--scopes` (last updated Sep 2 2026): https://developers.cloudflare.com/workers/wrangler/commands/general/
- [S6] Wrangler system environment variables (last updated Oct 1 2026): https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- [S7] Wrangler configuration, environments section (last updated Oct 29 2026): https://developers.cloudflare.com/workers/wrangler/configuration/
- [S8] Workers environments (last updated Oct 18 2026): https://developers.cloudflare.com/workers/wrangler/environments/
- [S9] GitHub Actions, external CI/CD (last updated Oct 18 2026): https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- [S10] Workers for Platforms (last updated Oct 15 2026): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- [S11] Organizations (last updated Oct 7 2026): https://developers.cloudflare.com/fundamentals/organizations/
- [S12] Workers pricing (last updated Oct 2 2026): https://developers.cloudflare.com/workers/platform/pricing/
- [S13] Move a domain between Cloudflare accounts (last updated Apr 20 2026): https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/
- Not used: the Registrar inter-account transfer page (seen only in search results, not opened, no date read): https://developers.cloudflare.com/registrar/account-options/inter-account-transfer/; the multiple-accounts page (404): https://developers.cloudflare.com/fundamentals/account/account-security/multiple-accounts/
