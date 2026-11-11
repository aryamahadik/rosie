# ADR-014: The Worker's database roles: one login for each side, each behind its own Hyperdrive configuration

- Status: proposed, default in use (T-1239; the lead's ruling DL-492)
- Date: 2026-11-11
- Owner: architect. Decides: the CTO, with the database engineer (CQ-208).
- This record changes nothing by itself: no contract, migration, code, config or live step. Section 4 lists who makes each piece. Production is not touched (section 5).

## Context

- **Two roles, one for each side.** Migration 0012 makes `rosie_app` for the Tool API and `rosie_job` for the runtime side (the guard, the dispatcher, the clock sweep, the gateway, the publisher). With no business scope `rosie_app` sees no row and `rosie_job` sees every business's rows (`db/migrations/0012_core_rls.sql` lines 15 to 27). Both are NOLOGIN: "the deploy names the login role that is granted one of them (never both: a member of both would take both policies)" (lines 13 to 14).
- **Who is not bound.** "A superuser and a table's owner (the migrations' role) bypass row-level security; no table forces it on its owner" (0012 line 28). PostgreSQL's page says the same of superusers, roles with BYPASSRLS and table owners [P2].
- **The code already takes one client for each side.** `pgTurnCalls(runtime, toolApi, ...)`: "`runtime` is a client whose connections run as rosie_job, `toolApi` one whose connections run as rosie_app" (`actions/src/tool-api/turn-face/pg/calls.ts` lines 93 to 96; `pgCallScope(toolApi)` line 40, `pgSafetyReads(runtime)` line 45, `pgRowData(runtime)` line 83, `pgReadOnlySealer(runtime, ...)` line 102). Each `RootOptions` comment names the role of its calls (`runtime/src/wiring/root.ts` lines 183 to 301; for example lines 233 to 240).
- **db/repo sets no role, and says whose the role is.** `createClient` passes `application_name` and, when a schema is set, `search_path`, and nothing else (`db/repo/client.ts` lines 114 to 123). `withBusiness` opens its own transaction (`db/repo/scope.ts` line 99); `bundles.ts` reserves a connection and begins (lines 158 to 187); `flags.ts` (lines 76, 142) and `bundles.ts` (lines 224, 246) send one bare statement with no transaction. A search of the history (`git log -i -G` for `set role`, `set local role` and `set session authorization`, Nov 11 2026) finds no commit that ever put a role switch in a db/repo file that is not a test. "The role is the connection's: the caller passes the client of the role the read names" (`db/repo/turn-face-reads.ts` lines 26 to 27; `db/repo/safety-reads.ts` lines 18 to 19). Only the seeds switch role, under Node as the migrations' role (`db/seeds/core.ts` line 90), and local tests set a `role` startup option on a direct connection (`actions/src/commit/pg/test-support.ts` line 72). So CQ-208's default, "switching to rosie_job or rosie_app per call as db/repo does", rests on a wrong premise (the D-017 path audit, `ops/reviews/D-017-path-audit/order_d017.txt` line 12, confirmed here).
- **The one configuration that exists stores the wrong role.** The spike made `rosie-staging-hyperdrive` from `STAGING_DATABASE_URL` (`infra/spikes/hyperdrive-host/FINDINGS.md` section 1, "The origin"; `run.sh` lines 160 to 178), the string migrations and seeds use. Which role that is was "not checked" (FINDINGS.md line 40). As the migrations' role it owns the tables (0012 line 28). Neon's page adds that a role made in its console or API joins a group role that carries BYPASSRLS, and a role made with SQL does not [N6]. Either way, a Worker bound to that configuration would read and write past every policy.
- **What the spike measured.** Through Hyperdrive a transaction stayed on one backend, a setting made with `set_config(..., true)` held inside it and was not found on the pool afterwards (FINDINGS.md section 4). That is how `withBusiness` sets the business scope (`scope.ts` lines 42 to 45), so the scope holds through the pool.
- **What the spike did not measure.** State that outlives a transaction on a pooled connection (FINDINGS.md line 165). The probe set no startup option: "It sets nothing else" (FINDINGS.md line 35). `hyperdrive update` was not run (FINDINGS.md line 40).
- **What Cloudflare's pages say.** The pool "operates in transaction mode"; "Hyperdrive supports `SET` statements for the duration of a transaction or a query"; "When a connection is returned to the pool, the connection is `RESET` such that the `SET` commands will not take effect on subsequent queries" [C3]. Among the unsupported features: "Any modification to per-session state not explicitly documented as supported elsewhere" [C4]. A configuration is made from one connection string, or one origin user and one origin password [C5]. Not stated on the pages read: what happens to a startup option a client sends, and which reset a pooled connection gets.
- **A local test sees none of this.** The local and CI login `rosie` is the container's first user (`.github/workflows/ci.yml` lines 34 to 36; ADR-006). Read on the local database on Nov 11 2026: it is a superuser with BYPASSRLS, `pg_has_role(current_user, ..., 'USAGE')` answers true for both roles, and `row_security_active` answers false for it on every `businesses` table there, each with row-level security switched on.
- **Two cards wait.** T-567 (the binding) waits for this record, "so it binds the right login or logins once" (DL-492, ruling 2). T-1093 is carded with a deploy-time check that the Worker's login is a member of exactly one of the two roles and owns nothing (`ops/cards/T-1093.md`, "Gives").

## Decision

### 1. How each side gets its role: two dedicated logins (the card's option (a))

| Side                                  | Login role         | Inherits         | Staging's Hyperdrive configuration | Binding          |
| ------------------------------------- | ------------------ | ---------------- | ---------------------------------- | ---------------- |
| The runtime side (K-05 scope runtime) | `rosie_worker_job` | `rosie_job` only | `rosie-staging-hyperdrive-job`     | `HYPERDRIVE_JOB` |
| The Tool API (K-05 scope business)    | `rosie_worker_app` | `rosie_app` only | `rosie-staging-hyperdrive-app`     | `HYPERDRIVE_APP` |

- **Each login** is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`. It is a member of its one role and of no other, granted with INHERIT true and SET false (the membership options of PostgreSQL 17's GRANT [P3]). It owns nothing and holds no grant of its own, so 0012's grants and each later migration's stay the whole list of what the Worker may do.
- **Made with SQL, never in the host's console or API.** On Neon a console or API role joins a group with BYPASSRLS; a role made with SQL does not [N6]. The check in section 4 proves the result either way.
- **The Worker's database handle** makes the runtime side's clients from `HYPERDRIVE_JOB` only and the Tool API's from `HYPERDRIVE_APP` only. No code that runs in the Worker sets a role: no `SET ROLE`, no `SET LOCAL ROLE`, no `role` startup option.
- **Both configurations have caching disabled** (ADR-007: both sides make decision reads).

Why:

1. **The role is fixed by the connection.** No call can forget a switch and run as another role, because there is no switch. Nothing the Worker can send widens a login: it is a member of one role only, and with SET false it cannot change to any other role.
2. **The Worker never holds the migrations' role.** That role can change or drop the schema and reads past every policy (0012 line 28).
3. **Its safety rests on nothing unmeasured.** It needs PostgreSQL's own login and grants, and from Hyperdrive only what the spike measured: queries, transactions and a transaction-scoped setting (FINDINGS.md section 4). No session state has to cross the pool.
4. **It fits what is written.** 0012 lines 13 to 14 and T-1093's check hold word for word, once for each login.
5. **db/repo and @rosie/actions need no change.** They already take a client for each side and say the role is the connection's (Context). db/repo's own role checks read rights, not a name: `pg_has_role(current_user, 'rosie_app', 'USAGE')` (`turn-face-reads.ts` lines 233 to 243; `safety-reads.ts` lines 198 to 206), which a login that inherits the role answers as the role does [P1].
6. Cloudflare's Neon page suggests a dedicated role (FINDINGS.md section 6, [C1]).

One premise is PostgreSQL's and is not yet measured in this repository: that a policy written `to rosie_app` binds a login that inherits `rosie_app`. PostgreSQL's page says "normal role membership and inheritance rules apply" [P2], and 0012 lines 13 to 14 assume it. Every test so far switches to the role itself (`test-support.ts` line 72; `core.ts` line 90). If the premise were wrong the login would see no row at all (row-level security with no policy that applies shows nothing), so it would fail closed. The test rig's first test measures it (section 4, piece 5).

### 2. The guard in every call

**Where.** In the Worker's database handle (the audit's part P1a: `runtime/src/wiring/staging/db.ts`, `order_d017.txt` line 29). For each call the handle opens a client for the call's side. That client's first statement is the guard: one `select` that reads no table. Only when it passes is the client handed to the call's code.

**What it reads, and what it must get:**

| The guard reads                                   | Runtime side             | Tool API side            | A wrong answer means                                                                                |
| ------------------------------------------------- | ------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `session_user` and `current_user`                 | both `rosie_worker_job`  | both `rosie_worker_app`  | another login is behind the binding, or the bindings are crossed                                    |
| `pg_has_role(current_user, 'rosie_job', 'USAGE')` | true                     | false                    | the login holds the wrong role's rights, or both (a superuser answers true to both)                 |
| `pg_has_role(current_user, 'rosie_app', 'USAGE')` | false                    | true                     | the same                                                                                            |
| `row_security_active('businesses')`               | true                     | true                     | PostgreSQL says row-level security is not in force for this user: a superuser, BYPASSRLS, the owner |
| `current_schema()`                                | `DB_SCHEMA`, or `public` | `DB_SCHEMA`, or `public` | the call would read and write another schema                                                        |

- The functions are PostgreSQL's own [P1]. `row_security_active` is its answer to "Is row-level security active for the specified table in the context of the current user and current environment?", so the guard does not have to list every way a role can bypass. `businesses` is the first of 0012's business-scoped tables and both roles may read it (0012 lines 90 to 93, 106 to 109).
- The schema is checked always, not only where `DB_SCHEMA` is set: with none set the expected answer is `public`. The server's path is `"$user", public` (FINDINGS.md section 2), so a schema named after a login would come first, and this catches it.
- **A wrong answer throws and writes nothing.** On a wrong answer, a missing row or any error from the statement, the handle ends the client and throws. The call's code never runs, so none of its statements is sent; the guard itself is a read of system functions. The port fails closed exactly as it does with no binding.
- **What the error and the log line carry:** the side, the binding's name and the failed check's label. Never a connection string, a host, a password or a row. It is never answered as `transient`: a retry cannot fix it.
- **Every call, never remembered.** Not once for an isolate, not once for a request: a configuration or a role's memberships can change while an isolate lives.
- **What it costs:** one more round trip in each call. On staging a one-row read on an open connection took p50 18 ms and p95 19 ms (FINDINGS.md section 3). That is arithmetic from the spike, not a measurement of the guard. If a later measurement shows the guard breaking a budget, it comes back to the architect; nobody drops or caches it on their own.

**Why the answer holds for the whole call**, though Hyperdrive may serve the call's later statements from another backend (3 backends were seen outside the transaction: FINDINGS.md section 4). Everything the guard reads about the role is a property of the login the configuration stores: who it is, what it inherits, what it owns. A configuration is made from one origin user and one password [C5], so it has no other to open a backend with, and no code switches role. The guard still reads it in every call. So the guard can sit in the handle, outside db/repo's own transactions. Under a role switch (options (b) and (c) below) the role would be transaction or session state, and the guard would have to run inside each of db/repo's transactions.

**The schema check has one limit.**

- Staging and production: `DB_SCHEMA` is empty (`wrangler.jsonc` lines 50, 67, 126), so `client.ts` sends no `search_path` (lines 90 to 99, 121). The path is then the server's default for the login, not session state, and the check is sound.
- A direct connection (local runs, the test rig): one connection is one backend, and the check is sound.
- A branch preview through Hyperdrive: `DB_SCHEMA` is `preview_<slug>` (`wrangler.jsonc` line 61) and reaches PostgreSQL as a startup option (`client.ts` lines 119 to 122). That is per-session state, which Cloudflare's page lists as unsupported unless documented [C4], and it was not measured (FINDINGS.md lines 35, 165). There the guard catches a path that is missing on the backend that answers it, but it does not prove the path on the backend that runs the call. Default until measured: a preview's Worker gets neither binding, so its database ports stay closed (Consequences, open question 1).

**Why a local or CI test cannot prove this by itself.**

1. The local and CI login is a superuser (Context). It bypasses row-level security, passes every privilege check and may set any role. So a test that connects as `rosie` passes whichever connection the handle picked, and "current_user is rosie_job" after a role option passes locally under any design (the T-1154 map's critics: `ops/reviews/T-1154-map/critic_size.txt` B2, `critic_collisions.txt` B1).
2. With the rig's own two logins a local test proves the guard's logic against local roles. It cannot show which login staging's configuration stores, what that login owns or inherits on staging's server, or what the host added to it.

So three proofs, each for what the others cannot see:

- **The rig, local and in CI:** the guard passes on the right login and refuses the superuser, crossed bindings, a login that inherits both roles, a login that owns `businesses` and a wrong schema; after each refusal the call's code did not run and the row counts are unchanged.
- **T-1093's check, at deploy:** the catalog of the real server, before traffic.
- **The guard itself, in the deployed Worker, in every call,** and once the lead's live proof (section 4, piece 7).

### 3. Names

| What                                         | Name                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Login roles, on every server                 | `rosie_worker_job`, `rosie_worker_app`                                                       |
| Staging's Hyperdrive configurations          | `rosie-staging-hyperdrive-job`, `rosie-staging-hyperdrive-app`, caching disabled             |
| Bindings in `wrangler.jsonc`'s `env.staging` | `HYPERDRIVE_JOB`, `HYPERDRIVE_APP`                                                           |
| A binding named `HYPERDRIVE`                 | none in `env.staging`, and the Worker's handle reads none                                    |
| Production's configurations (T-1006)         | `rosie-production-hyperdrive-job`, `rosie-production-hyperdrive-app`, the same binding names |
| The spike's `rosie-staging-hyperdrive`       | left unbound, used once more as the live proof's refused case, then deleted                  |

- **The binding names carry the role**, so a mix-up shows in review, and code written against the spike's one name finds no binding and fails closed.
- **The login names are the same on every server** (local, CI, staging, production: each is its own server), so the guard and T-1093's check need no setting to know them.
- **The spike's configuration is never bound in a deployed environment.** It stores the migrations' role. The two new configurations are made with `create`, the step the spike ran (FINDINGS.md line 33); nothing here rests on `hyperdrive update`, which was not run. Deleting it also takes the migrations' password out of Cloudflare, where nothing needs it. `cf.sh` cannot remove a configuration (FINDINGS.md line 34; `run.sh` lines 170 to 171), so the delete is the lead's own step. Until then a test pins that its id is in no environment of `wrangler.jsonc`. If the lead keeps it for a second run of the spike's probe, which needs the right to make a schema, it stays unbound and the pin stays. This replaces DL-482's default (the stored role, moved to a dedicated one later by an update in place).

### 4. Who makes what

| #   | Piece                                                  | Owner                                                                         | Files or live step                                                                                                                                                                                                                                                                            | Card                                                         |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | The two logins' shape                                  | release engineer; reviewed by the database engineer and the security reviewer | One new SQL file under `infra/` (suggested: `infra/scripts/worker-logins.sql`) and its test on the local database. It makes each login only when missing, with section 1's attributes and its one grant, and no password. It refuses a login it finds in another shape; it never repairs one. | new (the audit's "ROLE", `order_d017.txt` line 26)           |
| 2   | The logins' passwords and staging's two configurations | release engineer's script; the lead's live step                               | `infra/scripts/create-staging-hyperdrive.sh` and its test under `infra/ci/` (T-567's files). The rules are below the table. The lead runs it while no other agent runs, after the script's security review (as DL-482 set for the spike).                                                     | T-567's script part, or with piece 1                         |
| 3   | The bindings                                           | release engineer                                                              | `wrangler.jsonc` `env.staging`: `HYPERDRIVE_JOB` and `HYPERDRIVE_APP` with the two ids the live step printed. `infra/ci/wrangler-env.test.mjs` pins exactly those two, no `HYPERDRIVE` in `env.staging`, the spike's id nowhere, `env.production` unchanged. The dry run lists both. For local runs each binding's local connection string names the local login of its side, never the superuser (how wrangler is given it is the lead's note R2, `order_d017.txt` line 74).          | T-567, after piece 2's live step                             |
| 4   | The deploy-time check                                  | release engineer                                                              | T-1093's files as carded, with the notes below the table.                                                                                                                                                                                                                                     | T-1093, with a lead note                                     |
| 5   | The Workers test rig's logins                          | release engineer                                                              | The rig (`vitest.config.ts`, `infra/**`) runs piece 1's file on the local and CI server, gives each login a local-only password that is not a secret (as `rosie` is: ADR-006), and points the pool's two bindings at the local database as those logins. Never the superuser.                 | the audit's "P0" (`order_d017.txt` line 28)                  |
| 6   | The handle and its guard                               | runtime engineer                                                              | `runtime/src/wiring/staging/db.ts` and its Workers test on piece 5's rig (section 2's refusals).                                                                                                                                                                                              | the audit's "P1a" (`order_d017.txt` line 29)                 |
| 7   | The live proof                                         | the lead                                                                      | A remote dev session, as the spike's (FINDINGS.md section 1), runs the guard through each configuration: each side passes on its own; crossed, each is refused; the spike's configuration is refused on both sides. The output goes on the card. Then piece 8.                                | the audit's "LIVE" (`order_d017.txt` line 50), after piece 6 |
| 8   | The spike's configuration                              | the lead                                                                      | Deleted after piece 7 (section 3).                                                                                                                                                                                                                                                            | with piece 7                                                 |
| 9   | db/repo                                                | nobody                                                                        | No change. A stale comment (`client.ts` lines 7 to 8 say "the Hyperdrive binding") can ride any later db/repo card.                                                                                                                                                                           | none                                                         |
| 10  | CQ-208's row                                           | the lead                                                                      | `ops/QUESTIONS.md`: section 6's paragraph, and the open questions under Consequences.                                                                                                                                                                                                         | none                                                         |

Order: 1, then 2 and its live step, then 3, then 4. Piece 5 needs piece 1; piece 6 needs pieces 3 and 5; piece 7 needs piece 6. The ids exist only after piece 2's live step, so the binding is a second change in any case, as it was after the spike.

**The script's rules (piece 2).** They follow T-1236's way with staging's secrets (CQ-210) and the spike's `run.sh` (lines 14 to 27; DL-482's lesson).

- It lists first and makes only what is missing (T-567's lead note, DL-476). Where a configuration of the name exists it changes nothing: never over an existing one.
- For a missing configuration it makes a password at random, sets it on the login, creates the configuration with caching disabled, and forgets the password. The host, port and database come from `STAGING_DATABASE_URL`, read by name and never shown; the user is the login. It refuses a pooled host as `run.sh` does (lines 166 to 172).
- The password is held nowhere else: not printed, not written to a file, not in `.dev.vars`. It exists in PostgreSQL and in the configuration. A run that fails between the two steps is safe to repeat: the next run sets a fresh password, since nothing else holds the old one.
- It reaches wrangler as one argument, as the spike's string did (`run.sh` lines 23 to 24: wrangler takes it no other way; the security reviewer accepted those seconds on the build Mac, DL-482). No export marks, no xtrace, wrangler's output redacted on failure.
- Where the host accepts it, PostgreSQL is sent the password's SCRAM-SHA-256 verifier and not the clear password, so no statement's text holds it. Whether PostgreSQL stores a verifier as given, and whether staging's host accepts one: not checked (the CREATE ROLE page was not read). The script's card settles it on the local database first.
- Changing a password later (a new one, then `hyperdrive update`, which Cloudflare's page lists with `--origin-password` [C5]) is its own card. That command has not been run.

**T-1093's notes (piece 4).** Its "Gives" stands. Under this record:

- It runs once for each login, by name: `rosie_worker_job` inherits `rosie_job` and not `rosie_app`; `rosie_worker_app` the reverse.
- Each login's memberships are exactly that one role, directly, with INHERIT true and SET false. On a host whose console adds a group, this is the line that catches it.
- As carded: no table or function owned, no superuser, no BYPASSRLS, and neither `rosie_app` nor `rosie_job` a member of the migrations' role or of each other. Added: no CREATEROLE, CREATEDB or REPLICATION on a login.
- The configuration behind each binding stores its login. `hyperdrive list` prints each origin's user (`run.sh` lines 94 to 97, Wrangler 4.158.0 as installed); the check compares that cell with the login's name and never prints the host. Both configurations show caching disabled.
- A failure stops the deploy before traffic.

**The rig's first tests (piece 5)** measure section 1's premise: as `rosie_worker_app` with no scope, no business row, and with a scope that business only; a table that spans businesses is refused (42501); as `rosie_worker_job` with no scope, every business.

### 5. Production

The same shape, owned by T-1006: the same two logins on production's server from piece 1's file, two configurations (section 3's names; every production resource carries "production": `wrangler.jsonc` lines 112 to 113), caching disabled, bound as `HYPERDRIVE_JOB` and `HYPERDRIVE_APP`. They replace today's placeholder binding `HYPERDRIVE` (`wrangler.jsonc` lines 153 to 156), in T-1006's own reviewed change, made by the protected release step. T-1093's check runs before production's first traffic, and the guard is the same code. Production gets dedicated logins from the start, as CQ-208's first default already said.

Nothing here changes production now. The placeholder stays. Since the Worker's handle reads only the two new names, production has no database until T-1006 binds them.

### 6. CQ-208: the corrected default

For the lead to put in `ops/QUESTIONS.md`:

> Staging's Worker reaches PostgreSQL through two Hyperdrive configurations, never the one the spike made (ADR-014, T-1239). `rosie-staging-hyperdrive-job` stores the login `rosie_worker_job`, which inherits rosie_job only, and is bound as HYPERDRIVE_JOB for the runtime side. `rosie-staging-hyperdrive-app` stores `rosie_worker_app`, which inherits rosie_app only, and is bound as HYPERDRIVE_APP for the Tool API. Neither login owns anything, is a superuser or may bypass row-level security. The release engineer's script makes both with SQL, with passwords made in place and held nowhere else. Nothing switches role per call: db/repo sets no role (the earlier default's premise was wrong) and needs no change, because each call is handed the client of its side. In every call the Worker's database handle checks its login, its one role, that row-level security is in force, and its schema, and refuses the call otherwise. T-1093's check proves the same on the server before traffic. `rosie-staging-hyperdrive` stores the migrations' role, which owns the tables and bypasses row-level security: it is bound nowhere and is deleted after the live proof. Until the two configurations exist the Worker's database ports stay closed. Production takes the same shape from the start (T-1006).

## Consequences

- **T-567's card changes:** two bindings, neither named `HYPERDRIVE`, and not "the id T-1124 reports". Nothing was built on CQ-208's earlier default: T-567 has not started, and no code switches role.
- **Words that stay as history:** FINDINGS.md section 1 and `run.sh` line 189 say T-567 binds the spike's id as `HYPERDRIVE`. They are the spike's record and are not rewritten.
- **Two pools.** Cloudflare gives each configuration at least 5 origin connections and, as a soft limit, about 20 on the free plan and about 100 on a paid one; an account holds 10 configurations on the free plan and 25 on a paid one [C3][C6]. This design needs two on staging and two on production. The host's own connection limit on staging and the account's plan: not checked. The live step of piece 2 reads `show max_connections` first, and the script takes each configuration's `--origin-connection-limit` [C5] as an argument.
- **Connections inside one call are as before.** The gate holds a Tool API transaction while it opens runtime-side clients (`calls.ts` lines 53, 99, 102). The handle's cap on connections is piece 6's (`critic_collisions.txt` N2).
- **Nobody can connect as a Worker login by hand,** since nobody holds its password. Looking at staging as the Worker does goes through a remote dev session.
- **The local integration tests keep their `role` startup option** (`test-support.ts` line 72). On a direct connection they do test db/repo and the policies. They are not a test of the Worker's path.

Open questions, for the lead's `ops/QUESTIONS.md`:

1. **Branch previews and `DB_SCHEMA` through Hyperdrive** (the release engineer, with the architect). Default: a preview upload carries neither Hyperdrive binding, so its database ports stay closed, until a spike sets a startup `search_path` through the pool and reads `current_schema()` on many backends, inside and outside a transaction, or the schema is set another way. `infra/scripts/deploy-preview.sh` was not read for this record.
2. **Deleting the spike's configuration** (the lead; the CTO if he would keep it). Default: section 3.

### Not measured, and who measures it

| What                                                                                               | If it fails                                             | Who measures               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| A policy `to rosie_app` binds a login that inherits `rosie_app` [P2]                               | the login sees no row: closed                           | piece 5's first tests      |
| `row_security_active` and `pg_has_role` for an owner and a plain login (only a superuser was read) | the guard refuses a good login: closed                  | piece 6's Workers test     |
| The migrations' role may grant the two roles with `INHERIT TRUE, SET FALSE` on staging             | the script stops; a login with no grant passes no guard | piece 2's live step        |
| Two Hyperdrive bindings in one Worker on this account (ADR-007 names a second binding)             | a binding is missing: closed                            | piece 3's dry run, piece 7 |
| Every backend of a configuration answers as its one stored user                                    | the guard refuses that call: closed                     | the guard, in every call   |
| The guard's cost on staging                                                                        | a budget is missed; back to the architect               | piece 6, then T-570's run  |
| A startup `search_path` through the pool                                                           | previews get no database (open question 1)              | a later spike              |
| `hyperdrive update` and `hyperdrive delete`                                                        | nothing rests on update; the delete is the lead's       | the password card; piece 8 |
| The host's connection limit on staging, and the account's plan                                     | connections are refused under load, not a wrong read    | piece 2's live step        |

## Alternatives not chosen

- **(b) One login that switches with `SET LOCAL ROLE` in each transaction.** Whether Hyperdrive carries it was not measured: `SET` for the length of a transaction is documented [C3], and the spike measured a transaction-scoped setting, though not this one. It is rejected for what it needs elsewhere:
  - The login must be able to become both roles, against 0012 lines 13 to 14 and T-1093 as written.
  - A forgotten switch runs as the login. If the login inherits both roles, both sets of policies apply and are joined with OR [P2], so a Tool API call with no scope sees every business. If it is today's stored login, it bypasses row-level security. Only a login that inherits nothing fails closed, and that login would have to be made anyway, so (b) saves no live step.
  - db/repo has no place for the switch. Each call opens its own transaction or sends a bare statement (Context), so every K-05 call's code would change, every bare read would become a transaction (72 ms against 18 ms at p50 on staging: FINDINGS.md section 3), and each new call would have to remember.
- **(c) A `role` startup option, as the local tests set.** It is per-session state: unsupported unless documented [C4], never measured (FINDINGS.md line 35), and which reset a pooled connection gets is not stated [C3]. If the option were dropped, the call would run as the stored login, which today is the migrations' role: it fails open.
- **Binding the spike's configuration now and moving to a dedicated role later** (CQ-208's earlier default; DL-482). Staging holds test data only, but every call would run past the policies, so staging would prove nothing about row-level security, and T-570's pass would not show production's shape.
- **One login for both sides, as `rosie_job`, with the scope checks alone.** The Tool API would lose `rosie_app`'s "no scope, no row" and its narrower grants (0012 lines 15 to 20; `scope.ts` lines 8 to 12).
- **Forcing row-level security on the tables' owner.** It does not bind a role with BYPASSRLS, it changes every table (a K-04 change), and the Worker would still hold the role that can drop them.
- **The logins in a migration.** 0012 lines 13 to 14 leave the login to the deploy. A migration runs in every schema of a server and its text is public and frozen, so the password could not be in it, and the login would then be made in two places. One SQL file that the staging script and the rig both run is one source, and T-1093's check proves it on the server.
- **Turning the spike's configuration into one of the two with `hyperdrive update`.** The command exists [C5] and was not run (FINDINGS.md line 40); `create` was.
- **A guard that checks the name alone, or once for an isolate.** A name says nothing of what the login inherits or owns, and an isolate can outlive a change to a configuration.

## Sources

- The card T-1239 and the lead's rulings DL-482 and DL-492; `ops/QUESTIONS.md` CQ-208 and CQ-210; `ops/cards/T-1093.md` and `ops/cards/T-567.md`.
- `db/migrations/0012_core_rls.sql` (lines 13 to 28, 49 to 74, 90 to 109); `db/repo/client.ts`, `scope.ts`, `flags.ts`, `bundles.ts`, `turn-face-reads.ts`, `safety-reads.ts`; `db/seeds/core.ts`; `actions/src/commit/pg/test-support.ts`; `actions/src/tool-api/turn-face/pg/calls.ts`; `runtime/src/wiring/root.ts` (lines 183 to 301); `wrangler.jsonc`; `.github/workflows/ci.yml`.
- `infra/spikes/hyperdrive-host/FINDINGS.md` (the live run of Nov 11 2026, and its sources [C1] and [C2]) and `run.sh`.
- `ops/reviews/D-017-path-audit/order_d017.txt` (lines 12, 26 to 29, 50, 73) and `ops/reviews/T-1154-map/` (the map's section 2; `critic_size.txt` B2; `critic_collisions.txt` B1, N2, N7). They were leads; each fact used here was read in the code.
- ADR-006 (the local database) and ADR-007 (Hyperdrive, caching off, a second binding).
- Read on the local database, Nov 11 2026, one read-only query: the login `rosie`'s attributes and what `pg_has_role` and `row_security_active` answer for it.
- The pages below were read on Nov 11 2026 with a fetch tool that summarizes each page through a small model, so the wording of a quote is worth a check on the live page before anyone relies on it. "Not stated" means the page read does not say; "not checked" means no page was read for it.
  - [C3] Cloudflare, Hyperdrive connection pooling (last updated Aug 20 2026): https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
  - [C4] Cloudflare, Hyperdrive supported databases and features (last updated Nov 3 2026): https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
  - [C5] Cloudflare, Hyperdrive Wrangler commands (last updated Apr 21 2026): https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/
  - [C6] Cloudflare, Hyperdrive limits (last updated Jun 9 2026): https://developers.cloudflare.com/hyperdrive/platform/limits/
  - [N6] Neon, manage roles (last updated 2026-11-05): https://neon.com/docs/manage/roles
  - [P1] PostgreSQL 17, System Information Functions and Operators (`row_security_active`, `pg_has_role`, `session_user`, `current_user`, `current_schema`): https://www.postgresql.org/docs/17/functions-info.html
  - [P2] PostgreSQL 17, Row Security Policies: https://www.postgresql.org/docs/17/ddl-rowsecurity.html
  - [P3] PostgreSQL 17, GRANT (role membership `WITH INHERIT` and `SET`): https://www.postgresql.org/docs/17/sql-grant.html
