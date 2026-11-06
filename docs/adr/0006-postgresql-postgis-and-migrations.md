# ADR-006: PostgreSQL 17 with PostGIS, local Docker, migrations

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- PostgreSQL is the system of record: transactions, location and meaning search, queries across businesses (architecture 10, "System of record"). One schema of 119 tables in 16 domains (architecture 09); distance search with PostGIS (architecture 05).
- No double booking: one reservation table with EXCLUDE overlaps per worker, room or vehicle, and a CHECK on class seats (architecture 10, "No double booking"; architecture 06, limit 5).
- The host is open (J-06, Q-21). Until it is chosen: local PostgreSQL with PostGIS (architecture 12, "Waiting on Jay"; build prompt 5.3).
- Migrations are one queue, numbered at merge, written only by the database engineer (3.5(e); section 4). They only expand (new tables, nullable columns, indexes built concurrently), and rolling code back never needs a down-migration (5.4).

## Decision

- **PostgreSQL 17 with PostGIS**, locally in Docker: `infra/docker-compose.yml`, service `rosie-pg`, image `postgis/postgis:17-3.5`, port `127.0.0.1:54329`, database, user and password `rosie` (local only, not a secret). `npm run db:up`, `db:down` and `db:psql`. CI's merge check uses the same image. Staging runs the same major once J-06 names the host.
- **Migrations:** plain SQL in `db/migrations/`. A task branch names its file `9999_<slug>.sql`; the lead renumbers it at merge. `0001_init.sql` creates only the `schema_migrations` bookkeeping and the extensions `postgis`, `btree_gist` (EXCLUDE constraints that mix equality and ranges) and `pgcrypto` (hashes and random ids).
- `infra/scripts/migrate.mjs` applies pending files in order, one transaction each, records version, name, sha256 and time, and refuses to run if an applied file has changed.
- **Expand only**, held by `npm run guard:migrations`: drops, renames, type changes, `SET NOT NULL`, `DROP DEFAULT`, `TRUNCATE`, `DELETE FROM`, a non-concurrent index on an existing table, and edits to a merged file all fail. A contracting change ships only in a `_contract_` file, which the architect and the lead review.

## Consequences

- No down-migrations: a rollback is code only (5.4), and a wrong column stays until a later contracting deployment removes it.
- PostgreSQL refuses `CREATE INDEX CONCURRENTLY` inside a transaction block, and the guard requires it on existing tables. So `migrate.mjs` needs a per-file way to run outside a transaction (for example a marker on the file's first line), used only by a file that holds just that statement.
- Previews apply a branch's `9999_` file only to their own schema (ADR-008); staging only ever sees renumbered files from `main`.
- `npm run test:integration` needs Docker running on the build machine.
- The `17-3.5` image was last refreshed on 2026-08-31, while `17-3.6` and `18-3.6` were refreshed on 2026-10-26 (Docker Hub). The image should follow the staging host's PostGIS version once J-06 is answered.

## Alternatives not chosen

- **PostgreSQL 18 now:** newer, but hosts and extensions often trail a new major, and local, CI and staging must match. If the chosen host runs 18, all three move together.
- **D1, Durable Object storage alone, or NoSQL:** rejected by architecture 10, "System of record".
- **A migration framework or ORM (Prisma, Drizzle Kit, node-pg-migrate):** plain SQL keeps EXCLUDE, PostGIS and concurrent indexes first-class, and the expand-only guard can read it directly.
- **PostgreSQL installed on the Mac:** Docker runs the same image as CI.

## Sources

- Build prompt 3.5(e), 3.7 (J-06), 4 (database engineer), 5.3, 5.4.
- Architecture 05 (PostGIS in search); architecture 06, "Eight hard limits at three checkpoints" (limit 5, Reserved); architecture 09, "One schema for every trade"; architecture 10 ("System of record", "Concurrency", "No double booking"); architecture 12, "Waiting on Jay" (PostgreSQL host).
- Q-21 (the host, and the default meanwhile).
- D-000 spec, sections 4 and 5.
- Checked 2026-11-05: Docker Hub tags for `postgis/postgis`.
