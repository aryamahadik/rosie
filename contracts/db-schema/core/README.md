# db-schema/core (K-04): the database schema, core part

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-013. The freeze takes effect when T-013 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: database engineer, action-layer engineer, runtime engineer, release engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the database engineer that the migrations can produce exactly this table list, with the rules below (C-150 to C-156, C-135); the action-layer engineer the rows the commit writes and the frontier reads: versions, open questions, reservations, booking heads, the outbox row's plan (C-075, C-087, C-100, C-134); the runtime engineer turns, clock rows, phones, pauses, threads, the outbox and its parts, the bundle registry (C-046, C-049 to C-051, C-054, C-055, C-124, C-125); the release engineer the bundle registry and copy, release flags and the event log's trace ids (C-013, C-018, C-020); QA and eval the seeds and refused rows (C-147; the contract test T-083). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Table list:** `core.v1.tables.json`, checked against `../tables.meta.schema.json` (02-contracts section 2 item 3). **Checked by:** `npm run contracts:check` (the list's shape, that every column a key, constraint, index, scope, version or seal names exists, and the fixtures index). **Contract test:** `tests/contract/db-schema.core.v1.test.ts` (QA, T-083): migrate a fresh schema, compare the catalog with the table list, load the seeds, refuse the refused rows. A change after the freeze is a new file, `core.v1.1.tables.json` (additive) or `core.v2.tables.json` (breaking, with the CTO's OK), with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's table list, its fixtures or their index entries.

## What it defines

The tables the runtime and the action layer need from M2 (BP starting shape, M2 row; arch 12 line 594: "Core tables with versions, reservations, open questions, clock rows, turns and outbox rows"), plus the minimal rows CQ-03 keeps in core. 24 tables; every table and column names its source in `core.v1.tables.json`.

| Group               | Tables                                                 | Source                                                          |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Business head       | `businesses`                                           | CQ-03; FS line 721; arch 10 line 546                            |
| People and handles  | `persons`, `person_roles`, `handles`, `person_handles` | FS lines 723, 743; arch 01 line 55; arch 09 line 457            |
| Phones              | `phones`                                               | FS line 728; RULES 4.1b, 4.3, 7.5; MC C1, C9; Q-33; Q-03; Q-30  |
| Threads             | `threads`, `openers_sent`, `messages`                  | S1-01; RULES 4.1; arch 07 line 361; FS line 734; arch 03 l. 181 |
| Turns               | `turns`                                                | arch 01 lines 59, 61; arch 10 line 508; arch 11 line 576        |
| Open questions      | `open_questions`                                       | arch 01 lines 63, 89; arch 09 line 490; tour lines 423 to 427   |
| Clocks              | `clock_rows`                                           | arch 01 line 83; arch 02 line 127; arch 10 line 540             |
| Outbox              | `outbox_rows`, `outbox_parts`                          | arch 01 line 65; arch 02 lines 121 to 127; K-03 v1              |
| Event log           | `event_log`                                            | arch 09 lines 457, 492; arch 10 line 516                        |
| Bookings and pauses | `bookings` (the head row), `pauses`                    | CQ-03; FS line 729; arch 03 lines 163, 175, 177                 |
| No double booking   | `resources`, `reservations`, `class_seats`             | arch 05 line 255; arch 10 line 510; BP section 10 card T-041    |
| Bundles             | `bundles` (the registry), `bundle_values` (the copy)   | CQ-03; arch 10 line 536; K-01 v1 bundleId, kvKey, storedValue   |
| Release             | `release_flags`                                        | BP 5.4; the D-000 spec's ADR-010 draft                          |
| Sealing             | `sealing_keys`                                         | arch 01 line 93; arch 09 line 492; RULES 4.10                   |

### No double booking (BP section 10, card T-041)

- **EXCLUDE** `reservations_no_overlap_per_resource`: `gist (resource_id with =, during with &&) where resource_kind in ('worker', 'room', 'vehicle') and state in ('held', 'booked')`. Two overlapping held or booked reservations of one worker, room or vehicle are refused by the database, SQLSTATE 23P01 (arch 10 line 510; arch 05 line 255).
- **EXCLUDE** `reservations_no_overlap_per_worker`: the same on `worker_person_id`, so a worker who is staff at two businesses cannot be booked twice at once (FS line 743: "A booking in any of their businesses blocks that time in all of them").
- **CHECK** `class_seats_taken_within_capacity`: `taken <= capacity` on the class session's counter row, SQLSTATE 23514 (arch 10 line 510: "class seats as a counter with CHECK (taken ≤ capacity)"). A reservation of a class session raises `taken` by its `seats` in the same commit; class-session reservations are outside EXCLUDE, since many people share one session.
- A waiting row (next in line, A4-18) and a released row are outside EXCLUDE. `resource_kind` and `worker_person_id` are copies held to `resources` by composite foreign keys, so EXCLUDE can read them from the row.
- **Queue order:** `queued_at timestamptz not null default now()`, written with the row and never changed. When a saved or booked time is released, the next in line is the waiting row of that resource whose time overlaps it with the earliest `queued_at`, a tie broken by the lower `id`; release promotes that one row (A4-18; arch 05 line 247: "they wait next in line"; 02-contracts K-05 item 6: "Release: ... promoting the next in line"). Ids are opaque (CQ-09), so no id gives the order; the id only breaks a tie. The partial index `reservations_waiting_queue_idx` on `(resource_id, queued_at, id) where state = 'waiting'` finds that row. Added before the freeze took effect, at the database engineer's review of e0d1d32.

### Rows the frozen contracts need from K-04

- **K-01 (bundle):** `bundles` is keyed on K-01's bundleId `{hash, build}` (CQ-03), with `active` (at most one, `bundles_one_active`) and the manifest's KV key; `bundle_values` is PostgreSQL's copy of each bundle value, keyed by K-01's KV key with its bytes and sha256 (K-01 storedValue), and CHECKs that the stored bytes match both. Turns, open questions and outbox rows carry `bundle_hash` and `bundle_build` (arch 10 line 548).
- **K-02 (model):** a fact's `table`, `rowId` and `version` are a table here (or in a domain part), its primary key and its `version` column (limit 4). `open_questions.versions_read` and `outbox_rows.versions_read` hold the same `{"table", "rowId", "version"}` references. `open_questions.options` holds K-03's option `{"id", "label"}`, the ids K-02's choices carry.
- **K-03 (message plan):** `outbox_rows.plan` holds K-03's `rowPlan` and `outbox_rows.final_parts` its `finalParts`, one JSON value each; `outbox_rows.channel` is K-03's channel list.
- **K-07 and K-08** (frozen later, F3): K-07 gives the outbox row's states and moves and the parts' kinds and states, which `outbox_rows.state`, `outbox_parts.kind` and `outbox_parts.state` hold as text; K-08 gives the event log's kinds and the shape of `why`, `approved_by` and `proofs`. Neither adds a column here without a K-04 minor version.

## Database rules beyond the table list

The table list's meta-schema has no place for these; the migrations must produce them too, and T-083 checks them.

1. **Extension:** `btree_gist`, for EXCLUDE's `=` on text columns. The core part uses no PostGIS type (Q-21's local PostgreSQL with PostGIS serves the domain parts).
2. **Versions:** every table with `versioned: true` has `version integer not null default 1`; every update raises it by one, and a commit compares and sets it (arch 01 line 85; arch 10 line 506). Tables whose rows are written once or only appended carry none: `handles`, `person_handles`, `openers_sent`, `event_log`, `bundle_values`.
3. **Ids** are `text`: opaque strings code makes (CQ-09). `outbox_rows.commit_seq` is `bigint generated always as identity` (its `default` in the list says so), so commit order is the database's.
4. **Row-level security per business** (arch 10 line 546): on every table whose `rowLevelSecurity.scope` is `business`, a Tool API call sees and writes only rows whose business column equals the call's business scope; a row whose business column is null is seen by no business scope. The jobs that work across businesses by handle (the actor's guard, the dispatcher, the clock sweep) run unscoped. The fixtures name these two sides `toolApi` (with `scope.businessId`) and `runtime`; the role names, and how a call sets its scope (proposed: the setting `rosie.business_id`), are the database engineer's and K-05's, which states each call's scope.
5. **The event log is never edited** (arch 09 lines 457, 492): the application roles may insert and select on `event_log`, never update or delete; an update is refused with SQLSTATE 42501. Erasure deletes the person's key (`sealing_keys`), never a log row.
6. **Sealed fields:** `event_log.sealed_values` and `pauses.address`, each sealed under the key of the person its `sealedBy` column names (arch 01 line 93). The wrapping key is a Workers secret, named in `sealing_keys.wrapping_key_name`, never stored (rule 7).

## Seed and refused-row fixtures (`fixtures/`, listed in `fixtures/index.json`)

Each index entry names its `table` (the table the fixture is about), so `npm run contracts:check` counts it as a seed row and leaves it to the contract test, which loads it into a migrated database (02-contracts section 2 item 12; contracts/README.md convention 5). A fixture file is:

```json
{
  "after": ["seed-business-head.json"],
  "rows": [{ "table": "persons", "values": { "id": "person-alex", "name": "Alex M." } }],
  "refused": {
    "role": "toolApi",
    "scope": { "businessId": "biz-lees-barbershop" },
    "action": "insert",
    "table": "reservations",
    "values": {},
    "expect": { "sqlstate": "23P01", "constraintOneOf": ["reservations_no_overlap_per_resource"] }
  }
}
```

- `after`: the fixtures loaded first, with their own `after`, in order. `rows`: inserted in order, as the `runtime` side. Values are PostgreSQL text input for the column's type (a `tstzrange` as `[start,end)`, a `bytea` as `\x` and hex, a `timestamptz` in UTC ending in `Z`), except `jsonb` columns, which take JSON, and `text[]` columns, which take a JSON array. A column left out takes its default; `commit_seq` is always left out.
- `refused` (refused fixtures only): one `insert`, `update` (`set`, `where`) or `select` (`where`), run as `role` under `scope`, and what must happen: an error with `sqlstate` (and, where given, one of the named constraints), or `rows: 0` for a read row-level security hides.

Accepted (18): `seed-business-head`, `seed-bundle-registry`, `seed-person-roles`, `seed-phone-chat-open`, `seed-phone-stopped`, `seed-sealing-key`, `seed-booking-head`, `seed-resources`, `seed-class-seats`, `seed-reservation` (two waiting rows for Avery's saved time, queued at 15:02 and 15:04 but inserted in the other order, so the queue order comes from `queued_at`), `seed-turn`, `seed-open-question` (the tour's example: A7-03, the options as sent, booking v7, a 24-hour clock, asked once, open), `seed-clock-row`, `seed-outbox-row`, `seed-thread-messages`, `seed-event-log`, `seed-flag`, and `seed-pause` (beyond 02-contracts' list, so every table has a seed row). Refused (5, in `fixtures/invalid/`): `refuse-overlapping-reservation` (EXCLUDE, 23P01), `refuse-seats-over-capacity` (CHECK, 23514), `refuse-duplicate-turn-id` (the primary key, 23505), `refuse-event-log-update` (42501), `refuse-cross-business-read` (no row). Each is refused for its one reason: without it (a time that does not overlap, taken = 10, a new turn id, the barbershop's own scope) the same action passes.

Names and values come from fixture set v1's demo shops (barber, yoga studio, movers: `fixtures/v1/test-kit/shops/`) and the master's sample cast (Sam, Lee's Barbershop, Alex M., Riley, Avery, Ben T.; MASTER-FLOW-A A7-03), never a real person (rule 9). Phone numbers are in the 555-01xx range, as K-02's fixtures use; the email domain is example.com. The bundle id is K-01's `bundle-v0-skeleton.json`; its manifest copy is a short stand-in value whose bytes and sha256 match each other, not the real manifest. Flag names, the wrapping key's name, Linq ids and agent tokens are examples.

**Checked on 2026-11-07** by a throwaway script against PostgreSQL 17 with PostGIS 3.5 in a private Docker container (the local image `postgis/postgis:17-3.5`): DDL built from the table list and the rules above applied; every listed column (with its nullability), constraint and index found in the catalog; all 18 seeds loaded together, and each alone with its `after` chain (24 of 24 tables get rows); each refused fixture refused as its `expect` says, and passed once its fault was removed; a worker booked at two businesses at once refused by `reservations_no_overlap_per_worker`; the stored plan and final parts valid against K-03 v1's `rowPlan` and `finalParts`. **Re-checked on 2026-11-07 after the queue-order rework**, the same way (a throwaway script and container): all 24 tables built from the table list with every foreign key, CHECK, EXCLUDE, unique and index; all 18 seeds loaded (24 of 24 tables get rows); the overlap (23P01), seats past capacity (23514) and duplicate turn id (23505) refused; `queued_at` is `timestamptz not null default now()`; for Avery's saved time the next in line is `rsv-agent-waiting-avery` (15:02) though inserted after the 15:04 row, and the query uses `reservations_waiting_queue_idx`. T-083 writes the real test.

## Producers and consumers (02-contracts K-04)

- **Producers:** database engineer: C-150 schema baseline, C-151 core tables, C-153 row-level security, C-154 migrations queue, C-155 seeds from fixture set v1, C-156 per-person sealing keys, C-135 double-booking guard.
- **Consumers:** action-layer engineer (through K-05): C-075 frontier builder, C-087 one commit per turn, C-100 reservations, C-134 saved-time rules; runtime engineer: C-046 handle actor, C-049 turn lease, C-050 bundle pin, C-051 guard, C-054 clock rows, alarm and sweep, C-055 clock arming, C-124 outbox dispatcher, C-125 limit 8 at send; release engineer: C-013 flags, C-018 breach and latency monitor, C-020 deploy script (publish the bundle, then switch the active id: BP 5.4); database engineer: C-202 staging seeded state; QA: C-147 scenario tests, T-083 contract test.
- **Frozen before it:** K-01, K-02, K-03 (all frozen). **Frozen with it:** K-05 (F2).

## Defaults used (T-013)

1. **CQ-03's minimal rows**, and the business head also holds `name` and `display_name` (FS B01, B02), because M2 reads them: the frontier labels choices by business (arch 03 line 159) and the opener names it (arch 07 line 361). K-23 holds the rest of FS line 721.
2. **Versioned means ever updated** (rule 2 above); append-only and write-once tables carry no version.
3. **Row-level security's two sides** (rule 4 above): Tool API calls scoped by business; the runtime's cross-business jobs unscoped.
4. **The event log refuses edits by privilege** (rule 5), SQLSTATE 42501, and seals one person per row.
5. **A worker is a person across businesses** (FS line 743): the second EXCLUDE.
6. **Turn states** are 02-contracts K-04's (leased, committed, parked) with `lease_until`. QUESTIONS.md NQ-RT-3's default keeps the 60 s lease in the actor and writes the row once as committed or parked; both fit this table.
7. **Closed lists named here** where a source gives the values: booking stages from the hubs (entry, booked, checked_in, done; cancelled added), clock kinds (question, never_delivered, saved_time, step, job), send classes (RULES 4.3: routine, quick_reply, visit_now, safety), message channels (FS line 734 without call, Q-05), pause targets, resource kinds. The outbox's and parts' states and kinds stay free text for K-07.
8. **Release flags** are scoped `global`, `business:<id>` or `phone:<number>`, so staging's text-hours override is a flag row per test phone (QUESTIONS.md M3-M3b.4).
9. **Text hours** for a customer use the visit's zone, else the business's `time_zone` (CQ-05); no person carries a zone.

## Open gaps

- **Q-33** (the full table list; `first_sms_at` becomes `first_link_given_at`, a K-30 booking field; `chat_way` holds the service Linq reports, here `phones.chat_way`): default in use.
- **CQ-03** (what core holds beyond the build prompt's list): default in use, with default 1 above; the CTO rules.
- **CQ-05** (the person's own zone for text hours): default 9 above.
- **Q-21** (the host): local PostgreSQL with PostGIS meanwhile; the core part needs `btree_gist` only.
- **Erasure of plain columns:** only `event_log.sealed_values` and `pauses.address` are sealed in core. A person's name, handle address and message words are plain, and the 45-day delete (RULES 4.10) erases them by the sealing-key job (C-156) deleting or redacting them; no source says which core fields beyond the event log must be sealed. Proposed for QUESTIONS.md.
- **K-07 and K-08 vocabularies** (outbox states, part kinds, event kinds and the shapes of why, approved by and proofs): free text and JSON here until they freeze (F3).
- **Ids from other contracts:** `reservations.for_agent_token` (K-20's tokens) and `threads.linq_chat_id`, `outbox_parts.linq_message_id` (K-11's ids) are text with no foreign key until those contracts name them.
- **Partitioning** of messages and the event log by month at 10,000 businesses (arch 10 line 534): not in v1.
- **From the database engineer's review of e0d1d32 (not in v1):** outbox rows carry no claim-time column, so how a claim lapses is K-05's and K-07's to state (a K-04 minor version if it needs one); and the cap of 2 saved times per mobile, or per agent token per business (arch 05 line 247), is not a constraint here, so reserve must take a lock (for example on the phone row) to keep two parallel calls from both passing it. K-05 states both.

## Change log

- v1, 2026-11-07 (T-013): first version, frozen.
- v1, 2026-11-07 (T-013 rework, before merge, so before the freeze took effect): `reservations.queued_at` and `reservations_waiting_queue_idx` added, so release promotes the next in line deterministically; the seed shows two waiting rows in order. Nothing else changed.
