---
name: migration
description: Checklist for one Rosie database migration - expand-only rules, the single migration queue, file naming, the migration guard, local checks and what the handoff tells reviewers. Use for every change under db/migrations/.
---

# Migration

Only the database engineer writes migrations, one at a time. Migrations are one queue, numbered at merge, even inside the database role (build prompt 4, 3.5 (e)).

## Rules

- **Expand only** (5.4): new tables, nullable columns, indexes built concurrently. Rolling code back never needs a down-migration.
- **Safe to ship dark** (5.4): the code already on `main` keeps working with the new schema before any code uses it.
- **No contracting change in an ordinary file.** Dropping or renaming a table, column, index, constraint, type or schema; `ALTER ... TYPE`; `SET NOT NULL`; `DROP DEFAULT`; `TRUNCATE`; `DELETE FROM`: such a change ships later as its own deployment, once no live code uses the old shape, in a file whose name contains `_contract_` ("contracting", not an API contract). The guard prints a notice for it, and the architect and the lead review it (factory spec 5).
- **An index on an existing table** uses `CREATE INDEX CONCURRENTLY`. PostgreSQL refuses that inside a transaction, so put it alone in its own file. If `npm run migrate` cannot apply it, report NEED (release engineer).
- **Never edit a merged or applied migration**: the migrate script refuses a changed checksum. Change the schema with a new file.
- **The file**: plain SQL, `db/migrations/9999_<slug>.sql` on your branch; the lead renumbers it at merge. Only the files your card's "May touch" names.
- **Seeds** come only from fixture set v1, never from real customer data (rule 9).
- **Hard invariants in the schema** (no double booking: EXCLUDE; capacity: CHECK) are proved by the tests the card names, with a concurrency test where it says so. Those tests are never quarantined (7.8).

## Checklist

1. `npm run db:up` (local PostgreSQL 17 with PostGIS, on 127.0.0.1:54329).
2. Write the file, then re-read it against the rules above.
3. `npm run guard:migrations`: green, or only the `_contract_` notice when the card is a contracting change.
4. `npm run migrate`, then `npm run migrate -- --status`: your file applied, nothing pending.
5. `npm run test:integration`: the card's proof (constraints, data-access calls, concurrency).
6. Commit. In the handoff, name the tables, columns, indexes and constraints added, what code may use them now, and whether a later `_contract_` step is needed. Say it needs the architect's review, and the security reviewer's if it holds personal data, money, consent or STOP (6.2).

## At deploy (for the handoff)

The deploy runs the expanding migration first, then the code with flags off (5.4). If a later step fails, the added migration stays in place.
