# T-1255: the live check of staging's two Hyperdrive configurations

ADR-014 section 4's piece 7. Through each of staging's two Hyperdrive configurations, from a Worker in a `wrangler dev --remote` session: does every backend the configuration opens answer as that configuration's own login, with the answers ADR-014 section 2's table expects; is each binding refused where the other side's answers are expected; is caching disabled; and (DL-733) do both logins still log in after the compute has suspended or restarted since T-1252's run set their passwords. The lead runs it after this card merges, and it must pass before the first deploy whose Worker opens a client through either binding (ADR-014's Order). Its output goes on the card T-1255 as the record ADR-014 asks for.

It is built in the spike T-1124's way (`infra/spikes/hyperdrive-host/`: a temporary config, a remote dev session, no deploy) and is not product code: no file outside this folder imports it, and nothing here is deployed.

| Configuration                  | Binding          | Login it stores    | Its one role |
| ------------------------------ | ---------------- | ------------------ | ------------ |
| `rosie-staging-hyperdrive-job` | `HYPERDRIVE_JOB` | `rosie_worker_job` | `rosie_job`  |
| `rosie-staging-hyperdrive-app` | `HYPERDRIVE_APP` | `rosie_worker_app` | `rosie_app`  |

## Files

| File                   | What it is                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`              | The run script: one Node process (it holds no secret, so no shell wrapper loads one). It calls wrangler only through `infra/scripts/cf.sh`, reads the list with T-1252's parser (`infra/scripts/hyperdrive-list.mjs`), prints the record and the verdict. |
| `worker.mjs`           | The Worker the session runs: it answers only requests that carry the run's random token, opens postgres.js clients from `HYPERDRIVE_JOB` and `HYPERDRIVE_APP`, and runs the probe. Never deployed.                                                        |
| `probe.mjs`            | The probe: the guard's select, the expected answers (`failedChecks`), the reads (`runProbe`), the record (`printable`), the verdict and the postmaster start's reading (`verdict`, `parseStart`). It never sees a password or a connection string.        |
| `probe.test.mjs`       | Checks of the probe, its verdict, `run.mjs`'s pieces and the Worker against `standin-postgres.mjs`: `node --test infra/spikes/hyperdrive-roles/probe.test.mjs` (no database, no network).                                                                 |
| `run.test.mjs`         | Checks of `run.mjs` itself in a throwaway checkout, with the real `cf.sh`, `lib.sh` and parser and a stand-in for wrangler: `node --test infra/spikes/hyperdrive-roles/run.test.mjs` (no database, no network).                                           |
| `local-db.test.mjs`    | The probe's select on a real PostgreSQL, the local rosie-pg (`npm run db:up`) or `DATABASE_URL`'s server as a superuser, under logins and a database of the run's own, all dropped after: `node --test infra/spikes/hyperdrive-roles/local-db.test.mjs`.  |
| `standin-postgres.mjs` | The stand-in for the postgres.js clients the Worker opens: it answers the guard's select as PostgreSQL would for the login a binding stores. Tests only.                                                                                                  |
| `standin-wrangler.mjs` | The stand-in for wrangler that `run.test.mjs` puts behind `cf.sh`: the list, the serving version, and a session answering `/ready` and `/probe`. It reaches nothing. Tests only.                                                                          |

None of the three test files is part of `npm test` or `npm run test:ci-scripts` (they live here, with the probe, as the spike's do).

## What the probe reads

Through each binding, the guard's reads of ADR-014 section 2's table as one select (`probe.mjs`, `guardQuery`), with `pg_backend_pid()` and `pg_postmaster_start_time()`:

| Read                                                                                    | Expected through `HYPERDRIVE_JOB`                              | Expected through `HYPERDRIVE_APP`  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| `session_user`, `current_user`                                                          | both `rosie_worker_job`                                        | both `rosie_worker_app`            |
| the login's memberships, the rows of `pg_auth_members` whose `member` is it (by member) | exactly one: `rosie_job`, inherit true, set false, admin false | exactly one: `rosie_app`, the same |
| `pg_has_role(current_user, <its own role>, 'USAGE')`                                    | `rosie_job`: true                                              | `rosie_app`: true                  |
| `pg_has_role(current_user, <the other role>, 'MEMBER')`                                 | `rosie_app`: false                                             | `rosie_job`: false                 |
| `row_security_active('businesses')`                                                     | true                                                           | true                               |
| `current_schema()`                                                                      | `public`                                                       | `public`                           |

- **50 reads outside a transaction** (10 rounds of 5 at once on one client of at most 5 connections, so the pool serves them from several backends), then **5 inside one read-only transaction** on a client of its own, which must stay on one backend.
- **Then the crossed reads:** `HYPERDRIVE_JOB` read with the Tool API side's select and expected answers, and `HYPERDRIVE_APP` with the runtime side's. Each must be refused by those answers.
- At most 5 connections are open at once (a Worker may hold 6), 14 in all. No startup parameter is sent (no `application_name`, `search_path` or `role`), as the Worker's own handle sends none.
- **It writes nothing:** no table, setting, role or password. It never sees a password: Hyperdrive gives the Worker its connection strings, and every error message passes through a redactor made from them.

## How the lead runs it

From the code folder (the rosie checkout), with nothing else on port 8799 (`PROBE_PORT` picks another), one argument: the postmaster start that T-1252's run printed (`postmaster started ...`; DL-754 records it), quoted as one word, exactly as printed:

```sh
node infra/spikes/hyperdrive-roles/run.mjs '<YYYY-MM-DD HH:MM:SS.ffffff+00, as that run printed it>'
```

The time is always the lead's input, never a value in this folder. ISO 8601 (`2026-01-02T03:04:05.123456Z`) is taken too; a time without its zone is refused. `.claude/settings.json` has no allow entry for this command.

In order (each refusal exits 1 before anything after it starts):

1. `cf.sh hyperdrive list`, read with T-1252's parser. Refused when either configuration is missing, either's caching is not `disabled` (ADR-007), or either's stored user is not its login ("another user (not shown)"). Prints `<name>: id <id>, caching disabled, stores <login>: yes` for each.
2. `cf.sh deployments status --env staging --json`: the version that serves staging. If it cannot be read, nothing is started.
3. A temporary folder (the system's temp folder, mode 700) with one file, a wrangler config: the Rosfield account, `env.staging.name` `rosie-staging` (which `cf.sh` requires), `worker.mjs` as `main`, and the two configurations bound by those ids as `HYPERDRIVE_JOB` and `HYPERDRIVE_APP`. No variable, route, trigger or other binding. The checkout's `wrangler.jsonc` is never read or changed.
4. `cf.sh dev --env staging --remote --ip 127.0.0.1 --port=<port> --var PROBE_TOKEN:<a random token>` with `CF_BUILD_DIR` set to that folder, in its own process group. `/ready` must show both bindings within 120 s; then `/probe` once.
5. The session is stopped, the serving version read again (it must be the one from before), and the folder removed. The folder is removed and the session stopped on failure too, Ctrl-C included.

No child gets `STAGING_DATABASE_URL`, `DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, a Cloudflare key or email (wrangler would take those before the sign-in), and wrangler writes no log file (`WRANGLER_WRITE_LOGS=false`). The run's token is in the session's arguments (as the spike's was) and in each request's header, in no environment, and never printed; wrangler's own output, which may list it, goes only to the session's log in the temporary folder, shown after a failure with the token, the hosts and the other users taken out.

A remote dev session may keep the deployed Worker's vars and secrets inside the preview (the spike's README, "Why the deployed rosie-staging Worker is not touched"). `worker.mjs` reads only `HYPERDRIVE_JOB`, `HYPERDRIVE_APP` and `PROBE_TOKEN` from its environment and returns none of their values (`/ready` says only whether each binding is there), so no other var or secret is read, logged or sent back.

## What it prints

- The record: the Worker's result rebuilt for printing (`printable`): for each binding the backend pids seen outside and inside the transaction, the answers grouped with their reads and pids, the postmaster starts with their reads, any errors; the crossed reads with the checks that refused them. A name prints only if it is one of the two logins, their two roles, a `pg_` role or `neon_superuser`; any other ("another login", the migrations' role above all) prints as `(not shown)`. Every other text is cleared of the run's token and of every host and every other user in the list, and the Worker has already cleared it of its connection strings. No password, connection string or host is printed.
- The verdict, which `run.mjs` recomputes from what it prints (the Worker's own `ok` and labels are never trusted): `roles:` for each binding, `crossed:` for each crossed read, `postmaster:` (each binding's start, to the microsecond, with its reads), `persistence:`, `caching:` and `result:`.

## The persistence proof (DL-733) and the exit code

T-1252's run set each password through T-1371's route, and whether Neon keeps a password set that way across a compute suspend or restart was not measured. The probe reads `pg_postmaster_start_time()` through each binding on every read, in two forms (the text in UTC and microseconds since 1970, both read by the server), which must agree.

| Exit | When                                                                                                                                                                                                              | Says                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 0    | every check passed, and every read through both bindings came from a postmaster started after the run's: the compute restarted since, and both logins still log in                                                | `persistence: proved`, `result: passed`                          |
| 3    | every role check passed, but a read came from the run's own postmaster (the same start): the compute has not restarted since. **Not a pass:** run again once it has suspended                                     | `persistence: NOT YET PROVED`, `result: NOT YET PROVED (exit 3)` |
| 1    | anything else: a refusal, a check failed, a crossed read not refused, fewer than 50 and 5 reads, a start before the run's (not the run's time, or another server), no readable start, the serving version changed | `result: FAILED` and each problem                                |
| 2    | misuse: not exactly one argument, or not a timestamp with its zone                                                                                                                                                | the usage                                                        |

DL-754 records that the compute woke for T-1252's run, so staging's compute suspends when idle: a run made once it has suspended should find a later start. **A login refused once the compute has restarted means Neon did not keep the password:** the Worker's ports stay closed, nothing is repaired by hand, and CQ-225 returns to the architect and the security reviewer (DL-733). The run prints that rule whenever a read fails.

## Not known until the live run

- Whether a remote session binds two Hyperdrive configurations at once on this account (ADR-014's "Not measured": piece 3's dry run and piece 7). If not, `/ready` shows a binding missing and the run stops.
- Whether a login can read its own rows of `pg_auth_members` on Neon (ADR-014's "Not measured": piece 7). On the local PostgreSQL 17 it can (`local-db.test.mjs`); if not, the read fails and the run fails, closed.
- Which pids and how many backends Hyperdrive's pool hands out: the run prints what it saw, and fails only on a wrong answer, never on the number of backends.
