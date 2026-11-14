# db (`@rosie/db`)

**Owner:** the database engineer (build prompt section 4). **Checked by:** the architect and security.

The schema, the migrations (the database engineer is the only role that writes them, one at a time), seeds from fixture set v1, the data-access calls and row-level security. PostgreSQL 17 with PostGIS (ADR-006).

```text
db/
  migrations/   plain SQL, applied in order by `npm run migrate`
  repo/         the data-access calls (unit tests beside them, *.test.ts)
  seeds/        seeds from fixture set v1
```

## Migrations (build prompt 5.4)

- **Expand only:** new tables, nullable columns, indexes built concurrently. Dropping or renaming ships later in its own deployment, once no live code uses the old shape, in a file whose name contains `_contract_` (reviewed by the architect and the lead). `npm run guard:migrations` checks every branch.
- **Names:** a new file on a task branch is `9999_<slug>.sql`; the lead renumbers it to the next free 4-digit number at merge. A merged migration is never edited: `migrate` refuses to run when an applied file's sha256 has changed.
- **Transactions:** each file runs in one transaction, together with its row in `schema_migrations`, so a file holds no `BEGIN` or `COMMIT`. PostgreSQL refuses some statements inside a transaction, so two kinds of file run outside one, a statement at a time: (1) a file of only `CREATE INDEX CONCURRENTLY` statements, found by itself; (2) a file whose first line is `-- migrate:no-transaction`, holding exactly one statement of any kind (`DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `DETACH PARTITION ... CONCURRENTLY`) or several that are all `CREATE INDEX CONCURRENTLY`. A file that mixes `CREATE INDEX CONCURRENTLY` with other statements is refused before anything runs. Write the statements with `IF NOT EXISTS`.
- `0001_init.sql` creates `schema_migrations` and the extensions `postgis`, `btree_gist` and `pgcrypto`, all in `public`.
- **Locks:** `migrate` gives each file a `lock_timeout` of 5 s and, in a transaction, each of its statements a `statement_timeout` of 60 s, for that file alone. A file that turns on row-level security or adds a policy needs its table's ACCESS EXCLUSIVE lock; behind a long transaction it would otherwise wait, and every query on that table would queue behind it. Now it fails after 5 s, rolled back and not recorded, and the queue goes on: run it again once the long transaction has ended. A file run outside a transaction (concurrent index work) takes the `lock_timeout` alone (T-1093).

## Roles and logins (row-level security)

- `0012_core_rls.sql` makes two roles, both `NOLOGIN`, owning nothing and a member of no role: `rosie_app` for the Tool API (K-05 scope business: no business scope, no row) and `rosie_job` for the runtime side (the guard, the dispatcher, the clock sweep, the gateway and the publisher; with no scope it sees every business). Row-level security binds them; it does not bind a superuser, a role with `BYPASSRLS`, a table's owner (the migrations' role) or a role that inherits an owner.
- The Worker logs in as one dedicated login for each side, never as the migrations' role (ADR-014): the Tool API as `rosie_worker_app`, which inherits `rosie_app` alone (Hyperdrive binding `HYPERDRIVE_APP`), and the guard, the dispatcher, the sweep and the gateway as `rosie_worker_job`, which inherits `rosie_job` alone (`HYPERDRIVE_JOB`). Each is granted its role `WITH INHERIT TRUE, SET FALSE` (PostgreSQL 16 or later), owns nothing and holds no grant of its own. `infra/scripts/worker-logins.sql` makes them, never a migration.
- Before the code of every staging deploy, `infra/scripts/worker-logins-check.mjs` reads the catalog as the migrations' role and refuses the deploy unless each login and its role are in that shape and each binding's Hyperdrive configuration stores its login with caching disabled (T-1093; `deploy-staging.sh`).
- **The staging migrations' role needs `CREATEROLE` once:** `0012` makes `rosie_app` and `rosie_job` as that role, and `worker-logins.sql` makes the two logins and grants them those roles, which needs the `ADMIN` option PostgreSQL 16 gives a role's maker. Locally and in CI the migrations' role is the superuser `rosie`.

## Local database (Docker)

- `npm run db:up` starts PostgreSQL with PostGIS on `127.0.0.1:54329` (`infra/docker-compose.yml`); `npm run db:down` stops it and keeps the data; `npm run db:psql` opens `psql` inside the container.
- `npm run migrate` applies the pending files; `npm run migrate -- --status` lists applied and pending files.
- With `DATABASE_URL` and `CI` both unset, `migrate` and the integration tests use `postgres://rosie:rosie@127.0.0.1:54329/rosie` (local only, not a secret). `DB_SCHEMA=<name>` migrates into its own schema; branch previews use `preview_<slug>`.

## Tests

- Unit tests beside the code (`repo/**/*.test.ts`, `seeds/**/*.test.ts`, `src/**/*.test.ts`): Vitest project `unit`.
- Tests that need PostgreSQL are named `*.int.test.ts` (project `integration`): `npm run test:integration`, run locally after `npm run db:up` and by the merge check against a PostGIS service container.
