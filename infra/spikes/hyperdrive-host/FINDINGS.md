# T-1124 findings: the staging PostgreSQL host through Hyperdrive (J-06)

**Round 1 of 2, Nov 11 2026. Not finished.** This file holds only what was measured on the build Mac's local database and what the hosts' documents say. Nothing here was measured on the staging database or through Hyperdrive: those answers come in round 2, from the lead's run of `run.sh` (README.md, "The steps, in order"). No local number below says anything about staging's latency.

For the CTO and T-567. Staging's host is Neon (project rosie-staging, PostgreSQL 17, AWS us-east-1, free plan; the card's lead note, DL-476, citing DL-036 and DL-042).

## The card's questions, as they stand

| Question                                                                    | Answer so far                                                                                                                                                                                                  | Source                                       |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Does the host give postgis, btree_gist and pgcrypto?                        | Yes on staging: postgis 3.5.7, btree_gist 1.7, pgcrypto 1.3, since migration 0001 ran there. Not re-read in this round; the probe's `extensions` and `postgis` steps confirm it through Hyperdrive in round 2. | The card's lead note (DL-476), citing DL-042 |
| Does an EXCLUDE constraint refuse an overlapping insert through Hyperdrive? | Open (round 2). Locally: refused, SQLSTATE 23P01.                                                                                                                                                              | Section 1                                    |
| p50 and p95 of a one-row compare-and-set commit, beside 300 ms              | Open (round 2). The local times in section 1 only show that the loop runs.                                                                                                                                     | Section 1                                    |
| Does a transaction hold across Hyperdrive's pooling?                        | Open (round 2). Locally, through wrangler's stand-in, which does not pool: held.                                                                                                                               | Sections 1 and 2                             |
| Synchronous standby, read replica, point-in-time recovery (T-1006)          | From Neon's documents: no standby compute; read replicas, asynchronous; point-in-time recovery inside a history window of 6 hours on the free plan.                                                            | Section 2                                    |

## 1. What ran locally (Nov 11 2026)

The probe (`probe.mjs`; README.md lists each query) ran against the local rosie-pg (PostgreSQL 17.5 with postgis 3.5.2, btree_gist 1.7 and pgcrypto 1.3 in `public`), two ways:

- **Plain Node:** `node infra/spikes/hyperdrive-host/local.mjs 60`, and `node --test infra/spikes/hyperdrive-host/probe.test.mjs` (14 tests, 14 passed).
- **A Worker through wrangler's local Hyperdrive stand-in:** `bash infra/spikes/hyperdrive-host/run.sh local`, which starts `cf.sh dev --env staging` from a temporary config whose `HYPERDRIVE` binding names the local database, and calls the Worker. This is the code path of the live run, with postgres.js's Workers build inside workerd; only the staging database and the real Hyperdrive are missing.

Every run ended `"ok": true` with no failed step. The Worker column is the run of 15:45Z.

| Step                                                        | Query                                                                                                                                                                      | Plain Node                                                                                               | Worker, local stand-in               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Extensions                                                  | `select extname, extversion, extnamespace from pg_extension where extname in ('postgis', 'btree_gist', 'pgcrypto')`                                                        | all three found                                                                                          | all three found                      |
| PostGIS, pgcrypto                                           | `ST_DWithin(geog, point, 16093.44)` over a gist index; `digest(text, 'sha256')`                                                                                            | 2 of 3 places within 10 miles; digest equals the runtime's SHA-256                                       | the same                             |
| EXCLUDE                                                     | `exclude using gist (worker_id with =, during with &&)`; 15:00 to 16:00, then 15:30 to 16:30, same worker                                                                  | refused, 23P01, `booking_no_overlap`                                                                     | refused, 23P01, `booking_no_overlap` |
| Compare-and-set, one statement                              | `update state set version = version + 1 where id = 1 and version = $read returning version`                                                                                | 60 commits: p50 0.9 ms, p95 1.1 ms                                                                       | 60 commits: p50 0 ms, p95 1 ms       |
| Compare-and-set, transaction                                | `begin`; `insert into turn (turn_id)`; the update; `commit`                                                                                                                | 60 commits: p50 2.4 ms, p95 2.9 ms                                                                       | 60 commits: p50 1 ms, p95 2 ms       |
| Compare-and-set, transaction, both statements sent together | the same transaction, pipelined                                                                                                                                            | 60 commits: p50 1.7 ms, p95 2.4 ms                                                                       | 60 commits: p50 1 ms, p95 1 ms       |
| An older version                                            | the update with `version = $read - 1`                                                                                                                                      | changed nothing                                                                                          | changed nothing                      |
| The same turn id again                                      | the transaction replayed with a used `turn_id`                                                                                                                             | refused, 23505; version unchanged                                                                        | refused, 23505; version unchanged    |
| One-row read                                                | `select version, last_turn from state where id = 1`                                                                                                                        | 60 reads: p50 0.5 ms, p95 0.7 ms                                                                         | 60 reads: p50 0 ms, p95 1 ms         |
| Read after write                                            | an update, then the same `select`, 20 times                                                                                                                                | 0 stale reads                                                                                            | 0 stale reads                        |
| Transaction                                                 | `set_config(..., true)`, an insert and `for update`, then 5 rounds of `pg_backend_pid()`, `txid_current()`, `current_setting()` while 3 other queries run; then a rollback | 1 backend, 1 transaction id, value held, lock held (55P03), row gone after the rollback, no value leaked | the same                             |
| Cleanup                                                     | `drop schema if exists spike_hyperdrive cascade`; count in `pg_namespace`                                                                                                  | dropped                                                                                                  | dropped                              |

- The Worker's times are whole milliseconds: inside a Worker the clock moves only when I/O completes. On the same Mac as the database that hides almost everything; through Hyperdrive each round trip is expected to take many milliseconds, so the resolution is enough for round 2.
- Three more Worker runs gave a transaction p95 between 1 and 7 ms; the 7 ms run shared the Mac with a full test run.
- A run that fails part way still drops its schema: `probe.test.mjs` breaks two tables after setup, sees the `exclude` and `cas` steps fail, and finds no `spike_hyperdrive` in `pg_namespace` afterwards.

## 2. What the hosts' documents say

Read on Nov 11 2026 with a fetch tool that summarizes each page through a small model, so the wording of a quoted claim is worth a check on the live page before the CTO relies on it. "Not stated" means the page read does not say.

### Neon: synchronous standby

- **No standby compute.** Neon avoids "idle standby compute replicas" and calls compute stateless; compute instances "run in a single AZ at any given time" [N2]. No page read uses the words "synchronous standby" [N1][N2].
- **What stands in its place, for durability:** "A transaction is considered committed once a quorum of safekeepers has acknowledged the WAL record"; safekeepers do "durable replication of WAL" [N1] and "are distributed across multiple Availability Zones" [N2].
- **What stands in its place, for availability:** after a failure a compute is restarted or re-attached, not failed over to a waiting copy. The page's typical times: a PostgreSQL crash or a VM failure, seconds; a node failure, 1 to 2 minutes; an availability-zone failure, 1 to 10 minutes; an unresponsive endpoint is re-attached to a new compute after 5 minutes [N2]. Prepared statements and temporary tables do not survive it [N2].
- **Across regions:** not supported; Neon does not currently support "real-time replication across different cloud regions" [N2].
- Not stated on the pages read: a recovery point or recovery time as a commitment, or which of this the free plan gets.
- So Q-21's "one primary, a synchronous standby" is not something Neon offers in those words. Whether a safekeeper quorum across zones, with a compute restart of seconds to minutes, meets what production needs is the CTO's call (T-1006).

### Neon: read replica

- Yes. Read replicas are "independent read-only compute instances that serve requests from the same storage as the primary compute"; "No data is duplicated or replicated" [N3].
- They are "asynchronous, which means they are eventually consistent" [N3]. That fits architecture 10: the replica serves search and reports only, never a decision.
- "You can add up to 6 read replicas per branch on any plan"; the free plan is "limited to 3 read replica computes per project" [N3].
- Not read: how a replica is connected to (the page points to a separate guide), so whether a second Hyperdrive configuration can name a replica is open for T-567 or T-1006.

### Neon: point-in-time recovery

- Yes, inside a window. Instant restore is "Neon's point-in-time recovery feature" [N5]: it restores "a root branch to an earlier state in its own or another root branch's history", as "a complete overwrite of the database timeline, not a merge or refresh"; child branches do not support it [N4].
- The window (the "history window") by plan: free, "6 hours (capped at 1 GB of history)", default and maximum; Launch, default 1 day, maximum 7 days; Scale, default 1 day, maximum 30 days [N5].
- So staging, on the free plan, can go back at most 6 hours. What production needs is the CTO's call (T-1006); the pages read give no price for any of this.

### Cloudflare: Hyperdrive with Neon, and local runs

- Cloudflare's Neon page says to create a dedicated role (it suggests `hyperdrive-user`) and to take Neon's connection string with connection pooling unchecked, that is the direct host, not the pooled one [C1]. `run.sh create` refuses a pooled host for that reason. Which host and role staging's stored connection string names was not read (no agent opens it): a question for the lead before the create step.
- With `localConnectionString` (plain `wrangler dev`), "Hyperdrive's connection pooling and query caching do not take effect"; under `wrangler dev --remote` the Worker runs on Cloudflare and "Hyperdrive's connection pooling and query caching are active" [C2]. So section 1 says nothing about pooling or caching, and round 2's run is a `--remote` session.
- Caching off is a property of the Hyperdrive configuration (`--caching-disabled`, ADR-007). Wrangler 4.158.0's list prints it as `disabled` in its caching column; the probe's `read_after_write` step is the check from inside a Worker.

## 3. Read at Cloudflare in this round (nothing was changed)

- `npm run cf -- hyperdrive list` ran with the Rosfield sign-in and exited 0, printing "Listing Hyperdrive configs" and no table: the sign-in can read Hyperdrive, and the account holds no Hyperdrive configuration yet. `run.sh status` printed the same: no configuration is named rosie-staging-hyperdrive.
- `npm run cf -- whoami` lists the sign-in's scopes. None is named for Hyperdrive, so whether the sign-in may create a configuration is not known until the create step runs.

## 4. Open for round 2

Each comes from the output of `run.sh create` and `run.sh probe`:

1. The id of `rosie-staging-hyperdrive` and its `caching disabled` line, for T-567.
2. The three extensions and their versions, read through Hyperdrive.
3. The EXCLUDE refusal through Hyperdrive.
4. p50 and p95 of the compare-and-set commit in its three shapes, beside 300 ms, and of the one-row read, beside 150 ms; the first query's time on a new connection.
5. The transaction check through Hyperdrive's pool, and how many backends the queries outside it used.
6. `read_after_write`: 0 stale reads with caching disabled.
7. What staging reports for `synchronous_commit` and `synchronous_standby_names`.
8. That staging serves the same version before and after the probe.

## Sources

- [N1] Neon, architecture overview (last updated 2026-08-07): https://neon.com/docs/introduction/architecture-overview
- [N2] Neon, high availability (last updated 2026-10-23): https://neon.com/docs/introduction/high-availability
- [N3] Neon, read replicas (last updated 2026-08-26): https://neon.com/docs/introduction/read-replicas
- [N4] Neon, instant restore (last updated 2026-09-25): https://neon.com/docs/introduction/branch-restore
- [N5] Neon, history window (last updated 2026-08-24): https://neon.com/docs/introduction/history-window
- [C1] Cloudflare, Hyperdrive with Neon (last updated Apr 21 2026): https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/
- [C2] Cloudflare, Hyperdrive local development (last updated Apr 21 2026): https://developers.cloudflare.com/hyperdrive/configuration/local-development/
- Wrangler 4.158.0 as installed (`node_modules/wrangler/wrangler-dist/cli.js`): how `hyperdrive create` reads a connection string, what `hyperdrive list` prints, and the `edge-preview` upload of a remote session.
