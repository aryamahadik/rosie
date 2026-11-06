# ADR-007: Database access from Workers

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- PostgreSQL is reached through Hyperdrive with decision reads uncached, because Hyperdrive caches reads for 60 s by default (architecture 10, "System of record"). "Decision reads skip Hyperdrive's cache" (architecture 10, "Caching").
- Decisions need strong consistency: the primary, with compare-and-set; the read replica serves only search and reports (architecture 10, "Consistency" and "Concurrency"). Caches never decide (architecture 01, "One home for every fact").
- A turn commits once, unique on its turn id: state, outbox rows, clock rows and the event log in one transaction (architecture 01, "One turn, one transaction, once"; architecture 10, "Exactly once").
- Budgets: frontier at most 150 ms; gate and commit at most 300 ms (architecture 04, "Latency budget targets").

## Decision

- Workers reach PostgreSQL only through **Hyperdrive**. The configuration for decisions is created with caching disabled (`wrangler hyperdrive create ... --caching-disabled`), and every turn reads and writes through it.
- Caching is set per Hyperdrive configuration, not per query. If a later task wants cached reads (for example search on the read replica), it adds a second configuration and binding.
- **Driver: postgres.js** (the `postgres` package; root manifest `^3.4.9`), on the 3.x line that Cloudflare documents for Hyperdrive (3.4.5 or later). `infra/scripts/migrate.mjs` uses the same package under Node.
- Product code reaches tables through the database engineer's data-access calls in `db/repo/` (build prompt 3.3, section 4).
- No Hyperdrive binding exists in D-000; it comes with the first task that reads the staging database.

## Consequences

- No stale decision reads. Hyperdrive's defaults are a 60 s `max_age` and 15 s stale-while-revalidate; writes, and queries that call STABLE or VOLATILE functions, are never cached.
- postgres.js 4.0.0 came out on 2026-10-29. Cloudflare's Hyperdrive page names only 3.4.5 as a minimum and does not mention 4, so the root manifest stays on 3.x until a spike shows 4 works through Hyperdrive.
- Cloudflare calls node-postgres (`pg`, 8.16.3 or later) its recommended driver for Hyperdrive. If postgres.js gives trouble, `pg` is the fallback; the data-access calls keep the driver hidden from callers.
- One spike stays open: Hyperdrive with caching off, plus EXCLUDE constraints and PostGIS, on a candidate host, inside the 150 ms and 300 ms budgets (J-06).

## Alternatives not chosen

- **Hyperdrive's default cache for every read:** a 60-second-old row could decide (architecture 10 rejects it).
- **Direct connections without Hyperdrive:** a new database connection per request from the edge; architecture 10 chose Hyperdrive.
- **A host's own HTTP driver:** ties the code to one host before J-06 picks it.
- **An ORM or query builder:** a layer over the SQL that EXCLUDE, PostGIS and compare-and-set use directly.
- **node-postgres now:** see Consequences.

## Sources

- Build prompt 3.3 (data-access calls: commit a turn, claim outbox rows, arm and fire clock rows, reserve and release), 3.7 (J-06), 4.
- Architecture 01 ("One home for every fact"; "One turn, one transaction, once"); architecture 04, "Latency budget targets"; architecture 10 ("System of record", "Concurrency", "Exactly once", "Caching", "Consistency").
- D-000 spec, sections 5 and 6; the root `package.json`.
- Checked 2026-11-05: Cloudflare Hyperdrive docs ("Query caching"; "Connect to PostgreSQL", supported drivers); `wrangler hyperdrive create --help` (Wrangler 4.158.0); npm registry (postgres 3.4.9 on 3.x; 4.0.0 published 2026-10-29).
