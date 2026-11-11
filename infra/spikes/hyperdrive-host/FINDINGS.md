# T-1124 findings: the staging PostgreSQL host through Hyperdrive (J-06)

**Final, Nov 11 2026.** For the CTO and T-567. This replaces the round 1 text.

Where each part comes from:

- **Sections 1 to 5:** one live run on Nov 11 2026, from 17:27Z to 17:41Z. The lead ran `run.sh status`, `create`, `probe` and `status` again on the build Mac (README.md's steps 1, 3, 4 and 6; the task card counts the rehearsal as two steps and calls them 1, 4, 5 and 7). The appendix holds that output word for word, and every number in sections 1 to 5 is copied from it.
- **Section 6:** the hosts' documents, read on Nov 11 2026. Nothing in it was measured.
- Round 1's local rehearsal numbers are left out: they said nothing about staging. They are in this file's first version (commit 54219e0).

What was tested: a Worker, in a `wrangler dev --remote` session, reaching staging's PostgreSQL (Neon, AWS us-east-1, free plan; the card's lead note, DL-476) through the Hyperdrive configuration `rosie-staging-hyperdrive` with caching disabled. The server reported PostgreSQL `17.11 (9045acd)`. The whole probe passed: `"ok": true`, `"failed_steps": []`, and its schema `spike_hyperdrive` was dropped at the end.

## The card's questions, answered

| Question                                                                                  | Answer                                                                                                                                                                                        | Section |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Does the host give postgis, btree_gist and pgcrypto?                                      | Yes. postgis 3.5.7, btree_gist 1.7 and pgcrypto 1.3, all in `public`, read through Hyperdrive. Each one also did its work: a distance query, an EXCLUDE constraint, a digest.                 | 2       |
| Does an EXCLUDE constraint refuse an overlapping insert through Hyperdrive?               | Yes. Refused with SQLSTATE 23P01 by the constraint `booking_no_overlap`. A back-to-back hour and another worker's same time were accepted.                                                    | 2       |
| p50 and p95 of a one-row compare-and-set commit from a Worker, caching off, beside 300 ms | One statement: p50 18 ms, p95 20 ms. As a transaction with the turn id: p50 72 ms, p95 75 ms. The same transaction with both statements sent together: p50 63 ms, p95 66 ms. 60 commits each. | 3       |
| Does a transaction hold across Hyperdrive's pooling?                                      | Yes. One backend and one transaction id across 5 rounds while other queries ran through the pool; the SET LOCAL value and the row lock held, and nothing was left behind after the rollback.  | 4       |
| Synchronous standby, read replica, point-in-time recovery (T-1006)                        | From Neon's documents: no standby compute (a quorum of safekeepers instead); read replicas, asynchronous; point-in-time recovery inside a history window of 6 hours on the free plan.         | 6       |

## 1. For T-567: the configuration to bind

| Item                               | Value                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Name                               | `rosie-staging-hyperdrive`                                              |
| Id                                 | `68f4e670e62b41a99ab5a9ef0b176d2d`                                      |
| Caching                            | disabled (ADR-007)                                                      |
| Binding name                       | `HYPERDRIVE`, in `wrangler.jsonc`'s `env.staging`, by a reviewed change |
| `probe-upload` (the fallback step) | never needed, never run                                                 |

- **Created** by `run.sh create` at 17:39:02Z. Before it, `run.sh status` (17:27:03Z) found no configuration of that name. After the probe, `run.sh status` (17:41:35Z) printed `status: rosie-staging-hyperdrive exists: id 68f4e670e62b41a99ab5a9ef0b176d2d, caching disabled`.
- **The id is not a secret:** it goes into `wrangler.jsonc`. The configuration stays, and `cf.sh` cannot remove it.
- **The binding name is the one the probe used.** `worker.mjs` reads `env.HYPERDRIVE.connectionString` and hands it to postgres.js with `max: 4` (a second client with `max: 1`), `fetch_types: false`, `connect_timeout: 15` and notices silenced. It sets nothing else.
- **Two things round 1 did not know** (README.md, "What could stop a step") are answered: the Rosfield sign-in can create a Hyperdrive configuration, and a remote dev session can bind it. That is why `probe-upload` was not needed. It never ran, so it left no version and no preview alias on rosie-staging.
- **The deployed Worker was not touched.** Staging served version `8c47953f-740e-4079-aee2-a9b6a1f6e181` before the probe and the same version after it. The run deployed nothing.
- **The origin.** The configuration was made from the connection string staging's scripts already hold by name (`STAGING_DATABASE_URL`). No agent read it, and no part of it is in this folder.
  - Host: the create step refuses a host with `-pooler.` in its name unless `PROBE_ALLOW_POOLED=1` is set. The steps as written do not set it, and the step went ahead, so by that check the stored host is not a pooled one, as Cloudflare's Neon page asks [C1].
  - Role: not checked. It is the role staging's Worker will connect as once T-567 binds the configuration (CQ-208). Cloudflare's Neon page suggests a dedicated role [C1]; whether to move to one is the CTO's call. The lead's ruling DL-482 keeps the stored role for now and says a configuration can be changed in place later with `hyperdrive update`; that command was not run here.

## 2. Extensions and EXCLUDE

### What the server reported

Query: `current_setting(...)` for each setting below and `pg_is_in_recovery()` (`probe.mjs`, the `server` step). Reported, not judged.

| Field                       | Result            |
| --------------------------- | ----------------- |
| `version`                   | `17.11 (9045acd)` |
| `in_recovery`               | `false`           |
| `synchronous_commit`        | `on`              |
| `isolation`                 | `read committed`  |
| `search_path`               | `"$user", public` |
| `synchronous_standby_names` | `walproposer`     |

What `walproposer` stands for on Neon: not checked in any document (section 6).

### The three extensions

Query, as the output prints it: `select extname, extversion, extnamespace from pg_extension where extname in (the three)`. The three are `'postgis'`, `'btree_gist'` and `'pgcrypto'` (README.md).

| Extension  | Version | Schema |
| ---------- | ------- | ------ |
| btree_gist | 1.7     | public |
| pgcrypto   | 1.3     | public |
| postgis    | 3.5.7   | public |

`missing` is empty (`[]`). The versions are the ones migration 0001 installed (DL-042, by the card's lead note DL-476). The probe created no extension.

### PostGIS and pgcrypto at work

Query, as the output prints it: `ST_DWithin(geog, point, 16093.44) over a gist index; PostGIS_Version(); digest(text, 'sha256')`.

- Within 10 miles (16,093.44 m) of the point: `Cambridge MA` at 0 m, then `Boston MA` at 4445 m. The probe's third place did not come back (README.md: three places, two of them within 10 miles).
- `PostGIS_Version()`: `3.5 USE_GEOS=1 USE_PROJ=1 USE_STATS=1`.
- pgcrypto's SHA-256 digest equals the one the Worker's own Web Crypto gives: `pgcrypto_digest_matches_web_crypto` is `true`.

### EXCLUDE

Query, as the output prints it: `exclude using gist (worker_id with =, during with &&); insert 15:00-16:00, then 15:30-16:30 for the same worker`.

| Insert                                                       | Result                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| 15:30 to 16:30 for the same worker (overlaps 15:00 to 16:00) | refused, SQLSTATE `23P01`, constraint `booking_no_overlap` |
| A back-to-back hour for the same worker                      | accepted                                                   |
| The same time for another worker                             | accepted                                                   |
| Rows in the table at the end                                 | 3                                                          |

This is also the check that btree_gist does its work (`probe.mjs`'s header: each extension is shown working by a distance, an EXCLUDE and a digest).

## 3. Timings: the compare-and-set commit and the one-row read

All times are milliseconds, measured inside the Worker around each awaited call (README.md), through Hyperdrive with caching disabled.

| What was timed                                                                      | n   | min | p50 | p95 | max | mean | Budget | p95 inside the budget |
| ----------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ---- | ------ | --------------------- |
| Compare-and-set, one statement                                                      | 60  | 18  | 18  | 20  | 20  | 18.5 | 300    | yes                   |
| Compare-and-set as a transaction: `begin`, insert the turn id, the update, `commit` | 60  | 70  | 72  | 75  | 79  | 72.4 | 300    | yes                   |
| The same transaction, both statements sent together                                 | 60  | 62  | 63  | 66  | 68  | 63.9 | 300    | yes                   |
| One-row read                                                                        | 60  | 17  | 18  | 19  | 23  | 17.8 | 150    | yes                   |

- **Commit query,** as the output prints it: `update state set version = version + 1 where id = 1 and version = $read returning version; alone, then inside begin / insert turn (turn_id primary key) / commit, then with both statements sent together`.
- **Read query:** `select version, last_turn from state where id = 1`.
- **The budgets** are the probe's constants, which cite architecture 04's "Latency budget targets": gate and commit at most 300 ms; build the frontier at most 150 ms. The probe timed the database call only, so the gate's own time is not in these numbers.
- **Warm-up:** 5 commits per shape ran before the 60 and were not timed (`warm_up_commits_not_timed`: 5). The read loop skips its first 5 the same way (`probe.mjs`).
- **The clock:** p50 and p95 are by nearest rank. A Worker's clock gives whole milliseconds and moves only when I/O completes (README.md), which is why a min and a p50 can be the same number.
- **A new connection costs more.** The first query on the first client took 140 ms and the first query on the second client took 93 ms (`connect`, one `select 1` each). They are not in the table: the table's times are on connections already open.
- **Arithmetic on the table, not a new measurement:** the slowest p95 is 75 ms, a quarter of 300 ms. The transaction's p50 (72 ms) is four times the one-statement p50 (18 ms); README.md counts four round trips for that shape and one for the single statement.

The same step checked that the compare-and-set is correct, not only fast:

| Check                                                            | Result             |
| ---------------------------------------------------------------- | ------------------ |
| A commit that read an older version (`stale_version_commit`)     | changed nothing    |
| The same turn id again (`replayed_turn_id`)                      | refused (23505)    |
| The version after that replay (`version_after_replay_unchanged`) | unchanged (`true`) |
| `final_version`                                                  | 195                |
| `turn_rows`                                                      | 130                |

195 is 3 shapes of 5 + 60 commits, and 130 is the turn rows of the 2 transaction shapes; the probe fails the step if either count is off (`probe.mjs`).

## 4. A transaction across the pool, and reads after a write

### The transaction

Query, as the output prints it: `begin; set_config(marker, 'held', true); insert; select ... for update; then 5 rounds of pg_backend_pid(), txid_current(), current_setting(marker) while 3 other queries run; rollback`.

| Field                               | Result       |
| ----------------------------------- | ------------ |
| `rounds`                            | 5            |
| `backends_inside_transaction`       | 1            |
| `transaction_ids_inside`            | 1            |
| `set_local_value_held`              | `true`       |
| `own_uncommitted_row_seen_inside`   | `true`       |
| `uncommitted_row_seen_outside`      | `false`      |
| `row_lock_while_open`               | held (55P03) |
| `row_after_rollback`                | gone         |
| `row_lock_after_rollback`           | free         |
| `set_local_value_leaked_to_pool`    | `false`      |
| `committed_transaction_visible`     | `true`       |
| `backends_seen_outside_transaction` | 3            |

- **It held.** From `begin` to the rollback the transaction kept one backend and one transaction id, while 3 other queries per round went through the pool (2 on the same client, 1 on a second client; `probe.mjs`). Those other queries were seen on 3 backends. The probe counts the two sets apart and does not report whether they share a backend.
- **Transaction-scoped state stayed inside it.** The value set with `set_config(..., true)` (SET LOCAL, the way `db/repo/scope.ts` scopes a transaction; `probe.mjs`) was read back in every round, and the 4 queries that looked for it after the rollback did not find it (`set_local_value_leaked_to_pool`: `false`). A second client could not see the uncommitted row and could not take the row lock (`for update nowait` was refused with 55P03).
- **The rollback left nothing:** the row was gone and the lock was free. A later transaction that did commit was visible from the second client.

### Reads after a write, with caching disabled

Query, as the output prints it: `update state ... where id = 2 returning version; then the same select version ... where id = 2, 20 times`.

- `rounds`: 20. `stale_reads`: 0.
- The `select` has the same text and parameters every round, so a cache keyed on them would have answered with an older row (`probe.mjs`). None did. This is the check from inside a Worker of ADR-007's caching off for decision reads; `run.sh status` printed `caching disabled` for the configuration as well.

## 5. What this run does not show

- **One run.** 60 timed commits per shape and 60 timed reads, once, at one time of day (17:39Z). The probe took 13,661 ms in all. No second run was made to see how the numbers move.
- **No load.** Each loop sent one commit at a time. Nothing here says how the commit behaves with many Workers committing at once, with a contended row, or with the pool full.
- **A dev session, not a deployed Worker.** The Worker ran in a `wrangler dev --remote` session started on the build Mac. Cloudflare's page says such a Worker runs on Cloudflare with Hyperdrive's pooling and caching active [C2]. Which Cloudflare location ran it: not checked. A deployed Worker serving a caller far from the database was not measured.
- **The compute was awake.** The first query took 140 ms, so the Neon compute was already awake or woke fast. The wake-up time of a suspended compute was not measured, and when staging's compute suspends was not checked.
- **Warmed, open connections.** The table's times come after 5 untimed commits per shape, on connections already open. The first query on a new connection was seen twice (140 ms, 93 ms).
- **Staging only.** Neon's free plan in AWS us-east-1. It says nothing about production's host, plan or region (T-1006).
- **The database call only.** The 300 ms is for gate and commit together; the gate was not part of the probe.
- **A stand-in for the commit.** The probe's tables are its own (one row moved, one turn row inserted, three rows in `state`). The product's commit writes more than that; its time is T-567's and the walking skeleton's to measure.
- **Transaction-scoped state only.** SET LOCAL and a row lock were tested. State that outlives a transaction on a pooled connection (a plain `SET`, a session advisory lock, `LISTEN`) was not.
- **A 1 ms clock.** Differences under a millisecond do not show.

## 6. What the hosts' documents say

Read on Nov 11 2026, in round 1, with a fetch tool that summarizes each page through a small model, so the wording of a quoted claim is worth a check on the live page before the CTO relies on it. No page was read again for this final text. "Not stated" means the page read does not say; "not checked" means no page was read for it.

### Neon: synchronous standby

- **No standby compute.** Neon avoids "idle standby compute replicas" and calls compute stateless; compute instances "run in a single AZ at any given time" [N2]. No page read uses the words "synchronous standby" [N1][N2].
- **What stands in its place, for durability:** "A transaction is considered committed once a quorum of safekeepers has acknowledged the WAL record"; safekeepers do "durable replication of WAL" [N1] and "are distributed across multiple Availability Zones" [N2].
- **What stands in its place, for availability:** after a failure a compute is restarted or re-attached, not failed over to a waiting copy. The page's typical times: a PostgreSQL crash or a VM failure, seconds; a node failure, 1 to 2 minutes; an availability-zone failure, 1 to 10 minutes; an unresponsive endpoint is re-attached to a new compute after 5 minutes [N2]. Prepared statements and temporary tables do not survive it [N2].
- **Across regions:** not supported; Neon does not currently support "real-time replication across different cloud regions" [N2].
- Not stated on the pages read: a recovery point or recovery time as a commitment, or which of this the free plan gets.
- From the run, beside the documents: staging reported `synchronous_commit` `on` and `synchronous_standby_names` `walproposer` (section 2). Whether that setting is the safekeeper quorum of [N1]: not checked.
- So Q-21's "one primary, a synchronous standby" is not something Neon offers in those words. Whether a safekeeper quorum across zones, with a compute restart of seconds to minutes, meets what production needs is the CTO's call (T-1006).

### Neon: read replica

- Yes. Read replicas are "independent read-only compute instances that serve requests from the same storage as the primary compute"; "No data is duplicated or replicated" [N3].
- They are "asynchronous, which means they are eventually consistent" [N3]. That fits architecture 10: the replica serves search and reports only, never a decision.
- "You can add up to 6 read replicas per branch on any plan"; the free plan is "limited to 3 read replica computes per project" [N3].
- Not checked: how a replica is connected to (the page points to a separate guide, which was not read), so whether a second Hyperdrive configuration can name a replica is open for T-567 or T-1006. The run made no replica and read from none.

### Neon: point-in-time recovery

- Yes, inside a window. Instant restore is "Neon's point-in-time recovery feature" [N5]: it restores "a root branch to an earlier state in its own or another root branch's history", as "a complete overwrite of the database timeline, not a merge or refresh"; child branches do not support it [N4].
- The window (the "history window") by plan: free, "6 hours (capped at 1 GB of history)", default and maximum; Launch, default 1 day, maximum 7 days; Scale, default 1 day, maximum 30 days [N5].
- So staging, on the free plan, can go back at most 6 hours. What production needs is the CTO's call (T-1006); the pages read give no price for any of this.
- Not checked: a restore itself. The run restored nothing.

### Cloudflare: Hyperdrive with Neon, and local runs

- Cloudflare's Neon page says to create a dedicated role (it suggests `hyperdrive-user`) and to take Neon's connection string with connection pooling unchecked, that is the direct host, not the pooled one [C1]. `run.sh create` refuses a pooled host for that reason; section 1 says what the run shows about the host and the role.
- With `localConnectionString` (plain `wrangler dev`), "Hyperdrive's connection pooling and query caching do not take effect"; under `wrangler dev --remote` the Worker runs on Cloudflare and "Hyperdrive's connection pooling and query caching are active" [C2]. That is why the live run was a `--remote` session, and why round 1's local numbers are not here.
- Caching off is a property of the Hyperdrive configuration (`--caching-disabled`, ADR-007). Wrangler 4.158.0's list prints it as `disabled` in its caching column, which `run.sh status` read; section 4's read-after-write check is the same thing seen from inside a Worker.

## 7. Still open after this spike

1. Whether Neon's safekeeper quorum and compute restart stand in for the synchronous standby production needs, and which plan production takes for its history window: the CTO's call (T-1006).
2. Which role the Hyperdrive configuration connects as, and whether to move it to a dedicated role [C1]: the CTO's call (section 1).
3. How a read replica is reached, and whether it needs a Hyperdrive configuration of its own: not checked.
4. The commit's time under load, on a cold compute, from a deployed Worker, and in production's region: not measured (section 5).

## Sources

- The live run: the lead's record on task card T-1124, "The live run" (Nov 11 2026), copied into the appendix below.
- [N1] Neon, architecture overview (last updated 2026-08-07; read Nov 11 2026): https://neon.com/docs/introduction/architecture-overview
- [N2] Neon, high availability (last updated 2026-10-23; read Nov 11 2026): https://neon.com/docs/introduction/high-availability
- [N3] Neon, read replicas (last updated 2026-08-26; read Nov 11 2026): https://neon.com/docs/introduction/read-replicas
- [N4] Neon, instant restore (last updated 2026-09-25; read Nov 11 2026): https://neon.com/docs/introduction/branch-restore
- [N5] Neon, history window (last updated 2026-08-24; read Nov 11 2026): https://neon.com/docs/introduction/history-window
- [C1] Cloudflare, Hyperdrive with Neon (last updated Apr 21 2026; read Nov 11 2026): https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/
- [C2] Cloudflare, Hyperdrive local development (last updated Apr 21 2026; read Nov 11 2026): https://developers.cloudflare.com/hyperdrive/configuration/local-development/
- Wrangler 4.158.0 as installed (`node_modules/wrangler/wrangler-dist/cli.js`), read in round 1: how `hyperdrive create` reads a connection string, what `hyperdrive list` prints, and the `edge-preview` upload of a remote session.
- `probe.mjs`, `worker.mjs`, `run.sh` and README.md in this folder: what each step runs and how it is timed.

## Appendix: the run's output, word for word

Copied from the task card. The lead's record of the conditions: the lead's shell did not export `STAGING_DATABASE_URL` (the script read it by name itself and never showed it); the create step ran while no agent was running on the Mac; `probe-upload` was not run.

`run.sh status` (README.md step 1; a read):

```text
[2026-11-11T17:27:03Z] status: no Hyperdrive configuration is named rosie-staging-hyperdrive on the Rosfield account
```

`run.sh create` (README.md step 3):

```text
[2026-11-11T17:38:58Z] create: rosie-staging-hyperdrive does not exist: creating it with caching disabled (ADR-007)
[2026-11-11T17:39:02Z] create: rosie-staging-hyperdrive created: id 68f4e670e62b41a99ab5a9ef0b176d2d, caching disabled
[2026-11-11T17:39:02Z] create: T-567 binds this id in wrangler.jsonc's env.staging (binding HYPERDRIVE) by a reviewed change
```

`run.sh probe` (README.md step 4; a remote dev session, no deploy):

```text
[2026-11-11T17:39:13Z] probe: rosie-staging-hyperdrive is id 68f4e670e62b41a99ab5a9ef0b176d2d, caching disabled
[2026-11-11T17:39:14Z] staging: serves version 8c47953f-740e-4079-aee2-a9b6a1f6e181 before the probe
[2026-11-11T17:39:14Z] remote: starting wrangler dev through cf.sh from a temporary config (no deploy; the session ends with this script)
[2026-11-11T17:39:17Z] remote: the probe's Worker answers on http://127.0.0.1:8799
[2026-11-11T17:39:17Z] probe: running (60 timed commits per shape); this can take a few minutes
[2026-11-11T17:39:31Z] probe: HTTP 200; the probe's result:
{
  "probe": "T-1124 hyperdrive-host",
  "via": "worker",
  "schema": "spike_hyperdrive",
  "timed_commits_per_shape": 60,
  "ok": true,
  "failed_steps": [],
  "connect": {
    "ok": true,
    "first_query_ms": 140,
    "second_client_first_query_ms": 93
  },
  "server": {
    "ok": true,
    "version": "17.11 (9045acd)",
    "in_recovery": false,
    "synchronous_commit": "on",
    "isolation": "read committed",
    "search_path": "\"$user\", public",
    "synchronous_standby_names": "walproposer"
  },
  "extensions": {
    "ok": true,
    "query": "select extname, extversion, extnamespace from pg_extension where extname in (the three)",
    "found": {
      "btree_gist": {
        "version": "1.7",
        "schema": "public"
      },
      "pgcrypto": {
        "version": "1.3",
        "schema": "public"
      },
      "postgis": {
        "version": "3.5.7",
        "schema": "public"
      }
    },
    "missing": []
  },
  "setup": {
    "ok": true,
    "tables": [
      "booking",
      "place",
      "state",
      "turn",
      "txn"
    ]
  },
  "postgis": {
    "ok": true,
    "query": "ST_DWithin(geog, point, 16093.44) over a gist index; PostGIS_Version(); digest(text, 'sha256')",
    "within_10_miles": [
      {
        "name": "Cambridge MA",
        "meters": 0
      },
      {
        "name": "Boston MA",
        "meters": 4445
      }
    ],
    "postgis_version": "3.5 USE_GEOS=1 USE_PROJ=1 USE_STATS=1",
    "pgcrypto_digest_matches_web_crypto": true
  },
  "exclude": {
    "ok": true,
    "query": "exclude using gist (worker_id with =, during with &&); insert 15:00-16:00, then 15:30-16:30 for the same worker",
    "overlapping_insert": "refused",
    "sqlstate": "23P01",
    "constraint": "booking_no_overlap",
    "adjacent_insert": "accepted",
    "other_worker_insert": "accepted",
    "rows": 3
  },
  "cas": {
    "ok": true,
    "query": "update state set version = version + 1 where id = 1 and version = $read returning version; alone, then inside begin / insert turn (turn_id primary key) / commit, then with both statements sent together",
    "budget_ms": 300,
    "warm_up_commits_not_timed": 5,
    "one_statement": {
      "n": 60,
      "min_ms": 18,
      "p50_ms": 18,
      "p95_ms": 20,
      "max_ms": 20,
      "mean_ms": 18.5
    },
    "transaction": {
      "n": 60,
      "min_ms": 70,
      "p50_ms": 72,
      "p95_ms": 75,
      "max_ms": 79,
      "mean_ms": 72.4
    },
    "transaction_pipelined": {
      "n": 60,
      "min_ms": 62,
      "p50_ms": 63,
      "p95_ms": 66,
      "max_ms": 68,
      "mean_ms": 63.9
    },
    "p95_within_budget": {
      "one_statement": true,
      "transaction": true,
      "transaction_pipelined": true
    },
    "stale_version_commit": "changed nothing",
    "replayed_turn_id": "refused (23505)",
    "version_after_replay_unchanged": true,
    "final_version": 195,
    "turn_rows": 130
  },
  "reads": {
    "ok": true,
    "query": "select version, last_turn from state where id = 1",
    "budget_ms": 150,
    "n": 60,
    "min_ms": 17,
    "p50_ms": 18,
    "p95_ms": 19,
    "max_ms": 23,
    "mean_ms": 17.8,
    "p95_within_budget": true
  },
  "read_after_write": {
    "ok": true,
    "query": "update state ... where id = 2 returning version; then the same select version ... where id = 2, 20 times",
    "rounds": 20,
    "stale_reads": 0
  },
  "transaction": {
    "ok": true,
    "query": "begin; set_config(marker, 'held', true); insert; select ... for update; then 5 rounds of pg_backend_pid(), txid_current(), current_setting(marker) while 3 other queries run; rollback",
    "rounds": 5,
    "backends_inside_transaction": 1,
    "transaction_ids_inside": 1,
    "set_local_value_held": true,
    "own_uncommitted_row_seen_inside": true,
    "uncommitted_row_seen_outside": false,
    "row_lock_while_open": "held (55P03)",
    "row_after_rollback": "gone",
    "row_lock_after_rollback": "free",
    "set_local_value_leaked_to_pool": false,
    "committed_transaction_visible": true,
    "backends_seen_outside_transaction": 3
  },
  "cleanup": {
    "ok": true,
    "schema": "spike_hyperdrive",
    "present_before": true,
    "schema_dropped": true
  },
  "elapsed_ms": 13661
}
[2026-11-11T17:39:31Z] cleanup: asking the Worker to drop the schema spike_hyperdrive if it is still there:
{
  "ok": true,
  "schema": "spike_hyperdrive",
  "present_before": false,
  "schema_dropped": true
}
[2026-11-11T17:39:32Z] staging: still serves version 8c47953f-740e-4079-aee2-a9b6a1f6e181, the same as before the probe
[2026-11-11T17:39:32Z] remote: done, the probe passed and its schema is dropped
```

`run.sh status` again (README.md step 6):

```text
[2026-11-11T17:41:35Z] status: rosie-staging-hyperdrive exists: id 68f4e670e62b41a99ab5a9ef0b176d2d, caching disabled
```
