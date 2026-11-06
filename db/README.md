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
- **Transactions:** each file runs in one transaction, together with its row in `schema_migrations`, so a file holds no `BEGIN` or `COMMIT`. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction: put it alone in a file whose first line is `-- migrate:no-transaction`, written with `IF NOT EXISTS`.
- `0001_init.sql` creates `schema_migrations` and the extensions `postgis`, `btree_gist` and `pgcrypto`, all in `public`.

## Local database (Docker)

- `npm run db:up` starts PostgreSQL with PostGIS on `127.0.0.1:54329` (`infra/docker-compose.yml`); `npm run db:down` stops it and keeps the data; `npm run db:psql` opens `psql` inside the container.
- `npm run migrate` applies the pending files; `npm run migrate -- --status` lists applied and pending files.
- With `DATABASE_URL` and `CI` both unset, `migrate` and the integration tests use `postgres://rosie:rosie@127.0.0.1:54329/rosie` (local only, not a secret). `DB_SCHEMA=<name>` migrates into its own schema; branch previews use `preview_<slug>`.

## Tests

- Unit tests beside the code (`repo/**/*.test.ts`, `seeds/**/*.test.ts`, `src/**/*.test.ts`): Vitest project `unit`.
- Tests that need PostgreSQL are named `*.int.test.ts` (project `integration`): `npm run test:integration`, run locally after `npm run db:up` and by the merge check against a PostGIS service container.
