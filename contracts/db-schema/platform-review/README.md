# db-schema/platform-review (K-37): the database schema, platform and review part

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-046. The freeze takes effect when T-046 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: database engineer, action-layer engineer, runtime engineer, frontend engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the database engineer that the migrations can produce exactly this table list, with the rules below (C-173, with C-154 migrations queue and C-155 seeds); the action-layer engineer the rows the commit writes for a gap case and a review item, with no private value outside a sealed column (C-087, C-104); the runtime engineer the parked turn its crash handling writes and the dead letters its queues write (C-180, C-056); the frontend engineer what the team console lists and changes: parked turns, dead letters, gap cases, the review queue and the live-turn sample (C-194); QA and eval the seeds and refused rows and the labelled live turns (C-145, C-147; the contract test T-114). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Table list:** `platform-review.v1.tables.json`, checked against `../tables.meta.schema.json` (02-contracts section 2 item 3). **Checked by:** `npm run contracts:check` (the list's shape, that every column a key, constraint, index, scope, version or seal names exists, and the fixtures index). **Contract test:** `tests/contract/db-schema.platform-review.v1.test.ts` (QA, T-114): migrate a fresh schema with the core part, compare the catalog with the table list, load the seeds, refuse the refused rows. A change after the freeze is a new file, `platform-review.v1.1.tables.json` (additive) or `platform-review.v2.tables.json` (breaking, with the CTO's OK), with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's table list, its fixtures or their index entries.

## What it defines

The tables of arch 09's "Platform and review" domain (arch 09 line 474: 6 tables) that the core part does not already hold, under Q-33's default (arch 09's shape, FS section 9 as the checklist; FS section 9 has no table for this domain, so C-173 defines it from the architecture). The bundle registry and release flags are in K-04 core v1 (`bundles`, `bundle_values`, `release_flags`: CQ-03). Arch 09 gives only the count, not the table names. Every table and column names its source in `platform-review.v1.tables.json`.

| Table              | What it holds                                                                                                                                                                                                                                       | Source                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `parked_turns`     | Rosie's team's record of a turn parked after a third crash before its commit: the error, when the person was told once that nothing changed, when the reply is due (1 business day), and the reply. The turn itself is core's `turns` row (parked). | arch 11 line 576; C-180; C-194; NQ-RT-3                      |
| `dead_letters`     | Each queued job other than a send that failed its 5 tries: queue, job kind and id, the message as enqueued, tries, last error, business, trace id; the team replays or closes it.                                                                   | arch 10 lines 540, 548; C-056; C-194                         |
| `gap_cases`        | A turn no choice fit, with its state (open questions, versions read) and frontier (K-02 choices), the planner's outcome and sealed summary, and the weekly review with the test and fix each miss becomes.                                          | arch 01 line 95; arch 03 line 189; arch 06 line 291; K-02 v1 |
| `review_items`     | The team review queue: new work (S1-03), control (S1-75), listing match (S1-76), owner claims (S11-52), booking caps (S12-28) within 1 business day; harm reports (A3-49; S11-70) and missed legal deadlines (S11-70) the same day.                 | S1-03, S1-75, S1-76, S11-52, S12-28, A3-49, S11-70; Q-18     |
| `live_turn_labels` | The 300 live turns sampled each month after launch, each waiting in the team console for a person's label (sealed), then the gold-set item it became.                                                                                               | arch 08 lines 447, 449; C-145; QUESTIONS.md M6-M8.7          |

### Parked turns (arch 11 line 576)

- A third crash before the commit parks the turn for Rosie's team and frees the inbox for later texts. Core's `turns` row holds the state (`parked`, `parked_at`, `tries` 3; NQ-RT-3's default writes it once, as parked). `parked_turns` adds what the team needs: `error_summary` (the error, never a value from the turn's sealed texts), `person_told_at` (the person hears once that nothing changed and that the team will reply within 1 business day), `reply_due_at`, and the reply (`state` open or replied, `replied_at`, `replied_by_person_id`, `resolution`).

### Dead letters (arch 10 line 540)

- Queues carry retries only. Sends follow step 8 and never land here; effects take their service's outage row (arch 10 line 542). Other jobs get 5 tries, then the dead-letter queue in the team console. CHECK `dead_letters_after_five_tries` (`tries >= 5`) refuses a job that has not used them (SQLSTATE 23514).
- `job_id` is the id the event log's `job_id` carries for the job's writes (K-04 v1), so a dead letter and its writes are found together. `state`: open, replayed (sent back to its queue unchanged) or closed.

### Gap cases (arch 01 line 95; arch 03 line 189)

- Nothing fits: meaning search adds the 3 closest entry steps and the turn's one re-read runs; still nothing: the planner; a reply to its question that fits nothing goes to a person. "Each such turn is a gap case": one row per turn, keyed on `turn_id`. `outcome` is the planner's verb (K-02 v1 `plannerOutput`: answer, ask, pass_on, hand_off, log_gap) or `to_person`.
- **State and frontier:** `open_question_ids` and `versions_read` (K-04's `{"table", "rowId", "version"}` references) are the state; `frontier` is the K-02 v1 `choice` array as offered on the last read, with meaning search's `searchEntry` choices. References only: the values are re-read from the rows and the event log.
- **The summary is sealed** (`summary_sealed`, under `sealed_for_person_id`'s key): K-02's `plannerLogGap.summary` is the planner's plain words about what the person wanted, which may carry a private detail (RULES 4.5). Deleting the key erases it (arch 09 line 492).
- The weekly review: `review_state` open or reviewed, who reviewed it, and the test (`test_ref`, a K-10 gold-set item id) and fix (`fix_ref`) each miss becomes (HANDOFF 10).

### The team review queue (Q-18; C-194)

- `kind` is a closed list from the steps that send a thing to a person on Rosie's team, never the AI alone: `new_work` (S1-03), `control` (S1-75), `listing_match` (S1-76), `owner_claim` (S11-52), `booking_cap` (S12-28), within 1 business day; `harm_report` (A3-49; S11-70) and `missed_deadline` (S11-70), the same day. `due_at` holds the deadline code computes from the kind.
- The thing under review lives in its own part (a business row, a new-work draft, a harm report); `subject_table` and `subject_row_id` point at it as K-04's event log names a row, with no foreign key, since it may be in any part.
- `state`: open, waiting (S11-52: the account owner is told and has 3 business days to send their own papers, until `wait_until`), done (`decided_at`, `decided_by_person_id`, `outcome`). What the decision changes (a business going live, a claim granted) is written to the row under review in its own part.
- `summary` and `outcome` carry no private value: private words stay in the row under review, sealed where its part seals them.

### Labelled live turns (arch 08 line 449)

- 300 live turns a month are sampled after launch and labelled by people (C-145): Jay and the CTO until Jay names other labellers (QUESTIONS.md M6-M8.7). One row per sampled turn, with `sample_month` (its first day), `state` waiting or labelled, the label sealed under the writer's key (`label_sealed`: the right choices and every field value, arch 08 line 447, which can be private), who labelled it, and the gold-set item it became (`gold_item_id`).

## Database rules beyond the table list

The table list's meta-schema has no place for these; the migrations must produce them too, and T-114 checks them.

1. **Same schema as core:** the five tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (`turns.id`, `businesses.id`, `persons.id`), so the references carry no schema prefix. Event-log rows are reached through K-04's keys too: a dead letter's `job_id` is `event_log.job_id`, and a review item's `subject_table` and `subject_row_id` follow `event_log.table_name` and `row_id`.
2. **Rosie's team only, by privilege:** every table here is `rowLevelSecurity.scope: none`, and the Tool API roles (a call scoped to one business: K-04 rule 4's `toolApi` side) have no grant on any of them, so a select, insert or update from a Tool API call is refused with SQLSTATE 42501. Some items must never reach the business they are about (S11-70: a report that the owner or staff harmed someone comes here, never only to the one named; S12-28: patterns across businesses are seen only by Rosie's team). The runtime side reads and writes them unscoped, as K-04 rule 4 allows for jobs across businesses. The team console's calls (C-194, through K-21) work on that side until K-21 names the team console's role; the fixtures use `runtime` for it.
3. **Versions:** all five tables are updated (a reply, a replay, a review, a decision, a label), so each has `version integer not null default 1`, raised by every update and compared and set by a commit (arch 01 line 85; K-04 v1 rule 2).
4. **No private value in a plain column:** `error_summary`, `last_error`, `message_body`, `summary` and `outcome` hold ids, references and plain descriptions, never a person's private details; jobs carry ids, not values. The two columns that may hold private words are sealed under a per-person key (`gap_cases.summary_sealed`, `live_turn_labels.label_sealed`; arch 01 line 93), and the wrapping key stays a Workers secret (K-04 rule 6).
5. **Rules across tables, kept by code** (not constraints): a `parked_turns` row's turn has state `parked` in core; a `review_items` row's subject exists; a `live_turn_labels` row's turn is a committed live turn; `due_at` and `reply_due_at` follow the business-day rule of their kind.
6. **Ids** are `text`, opaque strings code makes (CQ-09); `test_ref`, `fix_ref` and `gold_item_id` name things outside the database and carry no foreign key.

## Seed and refused-row fixtures (`fixtures/`, listed in `fixtures/index.json`)

The fixture file format is K-04's (`../core/README.md`, "Seed and refused-row fixtures"): `after`, `rows`, and for a refused fixture `refused` with `role`, `scope`, `action` and `expect`. Each `after` path is relative to the `fixtures/` folder of the file that names it, so this part's seeds name K-04's as `../../core/fixtures/<file>`; a loader loads each file once, its own `after` first. `npm run contracts:check` counts each entry as a seed row and leaves it to the contract test (02-contracts section 2 item 12).

Accepted (5): `seed-parked-turn` (Riley's DONE text parked after its third crash, with its core `turns` row; Riley told once; the reply due 1 business day later, Saturday to Monday), `seed-dead-letter` (the daily reconciliation, across every business, and a calendar poll for Riley at Lee's Barbershop, each after 5 tries), `seed-gap-case` (Alex's "do you sell gift cards?" from K-02's `decide-none-fits`, logged by the planner's `log_gap` with its summary sealed under Alex's key, its state and its frontier), `seed-review-item` (new work and Movers' control check due in 1 business day, Lee's Barbershop's booking-cap flag, a harm report and a missed legal deadline due the same day), and `seed-live-turn-label` (Alex's committed turn sampled for October, waiting for a label; beyond 02-contracts' list, so every table has a seed row). Refused (2, in `fixtures/invalid/`): `refuse-review-item-tool-api-read` (a Tool API call scoped to Lee's Barbershop reads the review queue, 42501) and `refuse-dead-letter-early` (a dead letter after 3 tries, CHECK `dead_letters_after_five_tries`, 23514). Each is refused for its one reason: the same read on the runtime side, or the same row with tries 5, passes.

Names and values come from fixture set v1's demo shops (the barber as Lee's Barbershop and the movers: `fixtures/v1/test-kit/shops/barber.json`, `movers.json`) and the master's sample cast (Sam, Alex M., Riley; S12-28's flag words; S11-70's membership refund), never a real person (rule 9). Ids, handles and phones are K-04's seeds (555-01xx). The gap case's frontier is one K-02 v1 choice copied from `contracts/model/fixtures/context-s1-02.json`, and its turn id is K-02's `decide-none-fits`. Sealed values are short stand-in bytes, not ciphertext. Queue names, job kinds, error texts, trace ids and every due time are examples: code computes due times (open gaps below). No seed shows a decided, replied, reviewed or labelled row, since Rosie's team has no member in the sample cast (open gaps); T-114 builds those rows itself.

**Checked on 2026-11-07** by a throwaway script against PostgreSQL 17 with PostGIS 3.5 in a private Docker container (the local image `postgis/postgis:17-3.5`, removed after): DDL built from the core and this part's table lists, with K-04's two sides, row-level security and no Tool API grant on this part's tables; every listed column found with its nullability; each of the 5 seeds loaded alone with its `after` chain, then all 18 core seeds and these 5 together (each of the 5 tables gets rows); `refuse-review-item-tool-api-read` refused with 42501 and the same read on the runtime side returned the row; a Tool API select on each other table, and an insert and update on `review_items`, refused with 42501; `refuse-dead-letter-early` refused by `dead_letters_after_five_tries` with 23514, and the row with tries 5 passed; every other CHECK refused a row that broke it, and the same change made whole passed (a reply with its time, person and resolution; a replay; a review; a wait with its end; a decision; a label with its key, time and labeller); a second gap case for one turn refused by the primary key (23505); a parked turn for an unknown turn refused by its foreign key (23503); the queue and parked-turn reads use `review_items_queue_idx` and `parked_turns_open_due_idx`. T-114 writes the real test.

## Producers and consumers (02-contracts K-37 and section 7)

- **Producers:** database engineer: C-173 platform and review tables, with C-154 migrations queue and C-155 seeds from fixture set v1.
- **Consumers:** runtime engineer: C-180 crash in the middle of a turn (parks the turn, tells the person once), C-056 queues and dead letters (C-035); action-layer engineer: C-087 one commit per turn (a gap case, with the C-117 planner's outcome and `log_gap` summary, and a review item written in the turn's commit), C-104 safety and hand-offs (harm reports to the team that day), the journey steps that raise a review (S1-03, S1-75, S1-76, S11-52, S12-28, S11-70); frontend engineer: C-194 team console; QA and eval engineer: C-145 human-labelled live turns, C-147 scenario tests, T-114 contract test; database engineer: C-202 staging seeded state.
- **Frozen before it:** K-04 (frozen, #55). **Frozen with it:** K-29 (F4, frozen, #59). **Before it is read:** K-09 v1 freezes after it (F5), with K-37 among its "frozen before it" (team review items).

## Defaults used (T-046)

1. **Q-33** (arch 09's shape, FS section 9 as the checklist): five tables here; the bundle registry and release flags stay in core (CQ-03).
2. **Q-18** (Rosie's team is Jay and the CTO until launch): the deciding, replying, reviewing and labelling person is a `persons.id`; on staging every team item goes to the test console (BP 9.4).
3. **Rosie's team only, by privilege** (rule 2): no Tool API grant on any table here, so no business sees its own review items; the team console works on the runtime side until K-21 names its role.
4. **Every turn the planner handles is a gap case** (arch 03 line 189: "Each such turn is a gap case"), with `outcome` saying what the planner did; arch 06 line 291's `log_gap` is one of those outcomes and the one that brings a summary.
5. **Private words sealed** (arch 09 line 492; RULES 4.5, 4.10): the planner's summary and a live turn's label are sealed under the writer's key, as K-04's event log seals its private values.
6. **Dead letters are replayed or closed** by the team (arch 10 line 540 names the queue, not the actions).
7. **NQ-RT-3** (the turns row written once, as committed or parked): the parked turn's core row is written once with `tries` 3.

## Open gaps

- **Arch 09's count:** 6 tables for "Platform and review"; this part holds 5, and core holds the bundle registry, the bundle copy and the release flags. Arch 09 gives no names, so the count cannot be matched table for table (as K-29 found for its domain).
- **The business-day calendar** (S1-03, S1-75, S1-76, S11-52, S12-28 "1 business day"; arch 11 line 576; S11-52 "3 business days"; A3-49 "today"): which zone and which holidays count is not in the sources. Code computes `due_at`, `reply_due_at` and `wait_until`; the fixtures' times are examples. Proposed for QUESTIONS.md with Q-18.
- **Rosie's team as people:** K-04's `person_roles` has no team role, so a team member is a `persons` row with no role. Whether the team gets a role, and how the team console signs them in, is K-22's and K-21's (QUESTIONS.md M2-qa-frontend.5); a team role would be a K-04 or K-22 minor version, not a change here.
- **Subjects in parts not yet frozen:** K-24's new-work draft (S1-03), K-34's harm report (A3-49), K-22's owner-of-record papers (S11-52) and the ID upload record. A review item names them by `subject_table` and `subject_row_id` once those parts freeze; until then it has none.
- **Other team reviews** the sources name but 02-contracts' K-37 row does not: reconciliation leftovers (arch 10 line 550; S12-24) and K-36's pages. Not a `kind` in v1; adding one is a v1.1 change (a CHECK that only widens).
- **Job kinds and queue names** are free text: no source closes the list. C-056's task names them.
- **Event kinds** for these writes (a turn parked, a dead letter replayed, a review decided) are K-08's (T-017, freezing in parallel); free text in core's `event_log.kind` until it freezes.
- **The label's shape** is K-10's (F5, not yet frozen); sealed bytes here.
- **Labelled live turns and rule 9:** arch 08 line 449 adds 300 labelled live turns a month to the gold set, and BP rule 9 keeps real customer data out of every fixture and test. How a live turn's label enters the gold set without its private values (kept sealed here, never committed) is K-10's and QA's to state. Proposed for QUESTIONS.md with M6-M8.7.
- **Erasure of plain columns** (K-04's open gap): the plain columns here are written without private values (rule 4), so the 45-day delete has nothing to redact in them; a slip would need K-04's answer.

## Change log

- v1, 2026-11-07 (T-046): first version, frozen.
