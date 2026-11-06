# ADR-010: Flags

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- Every change people can notice sits behind a flag (build prompt 5.4). Before launch, production flags are on only for the allow-listed test phones (5.3). The deploy order ends with "the flags the approved cards name" (5.4).
- Turning a production flag on runs only from the protected release job, after Jay or the CTO acts from his own login (5.4; section 2, the table, rule 6). A rollback turns a flag off with no human (5.4).
- From launch, a change serves 5% of handles for 24 hours, then everyone (section 8, "Deployment"; architecture 10, "Deploy").
- Each fact has one home in PostgreSQL, and caches never decide (architecture 01, "One home for every fact"). The actor reads the active bundle id from PostgreSQL at turn start (architecture 10, "Caching"); KV takes about 60 s to propagate (architecture 10, "Playbook").

## Decision

- Flags are rows in a PostgreSQL table, in each environment's own database; a preview's schema gets its own from migrations and seeds.
- A flag has a key and a state: off; on for its allow-listed handles; on for a share of handles; on for everyone. A handle's place in a share comes from a stable hash of the handle, so it stays in or out.
- The actor reads flags at turn start, with the active bundle id, from the primary, uncached (ADR-007). A flag change is a write like any other, so the event log records who, when, why and who approved it (architecture 09, audit layer).
- On previews and staging, flags change without approval (tier 0, 9.2). In production, a flag goes on only in the protected release step after the approver's "Ship" (9.3), and goes off from the rollback job or the lead at any hour (5.4).
- Who builds it: the database engineer (table, migration, data-access call); the release engineer (the flag steps of deploy and rollback; section 4); the runtime and action-layer engineers (reading flags). No flag table exists in D-000 (`deploy-staging.sh` step 4 is "later").

## Consequences

- A flag change takes effect at the next turn, with no deploy and no KV delay.
- Turning a production flag on is a database write, so production database credentials stay out of agent sessions and GitHub until the release gate exists (ADR-012, Q-50).
- The walking skeleton's card already names a flag ("skeleton", staging only: D-017 in build prompt section 10), so the flag table and its read call come before the skeleton.
- The flag table is part of the database schema contract and is versioned like any other (6.4).

## Alternatives not chosen

- **Workers KV:** about 60 s to propagate, and a cache would decide (architecture 01, 10).
- **Wrangler vars or secrets:** a deploy per change, and no scope per handle.
- **A hosted flag service:** a new account and spend (rule 6), a second home for a fact, and an outside call on every turn.
- **Flags inside the step-graph bundle:** bundles go through replay and the eval gate (section 8, "Bundle") and switch by bundle id (5.4, step 3); flags switch code paths without a new bundle.

## Sources

- Build prompt 2 (the table: rule 6, release), 5.3, 5.4, 8 ("Deployment", "Bundle"), 9.2, 9.3, 9.4, 10 (the D-017 card).
- Architecture 01, "One home for every fact"; architecture 09, "One schema for every trade" (the audit layer's event log); architecture 10 ("Caching", "Playbook", "Deploy").
- Q-50.
- D-000 spec, section 6 (deploy order: flags later).
