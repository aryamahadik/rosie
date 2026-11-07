# db-schema/safety-incidents (K-34): the database schema, safety and incidents part

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-043. The freeze takes effect when T-043 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: database engineer, action-layer engineer, runtime engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the database engineer that the migrations can produce exactly this table list, with the rules below (C-170 safety and incidents tables, with C-154 migrations queue and C-155 seeds); the action-layer engineer the rows C-104 safety and hand-offs writes through the commit: an outcome per text, its hold and the hold's release, harm reports, privacy incidents and the check-out timer; the runtime engineer the outcome the safety read on arrival hands on (C-047, K-02's safetyResult), the gate's and dispatcher's reads of open holds, and the actor's copy of a running timer (arch 11 line 566); QA and eval the seeds and refused rows (C-147; the contract test T-111) and the outcome labels and tense the gold set's danger cases carry. The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Table list:** `safety-incidents.v1.tables.json`, checked against `../tables.meta.schema.json` (02-contracts section 2 item 3). **Checked by:** `npm run contracts:check` (the list's shape, that every column a key, constraint, index, scope, version or seal names exists, and the fixtures index). **Contract test:** `tests/contract/db-schema.safety-incidents.v1.test.ts` (QA, T-111): migrate a fresh schema with the core part, compare the catalog with the table list, load the seeds, refuse the refused rows. A change after the freeze is a new file, `safety-incidents.v1.1.tables.json` (additive) or `safety-incidents.v2.tables.json` (breaking, with the CTO's OK), with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's table list, its fixtures or their index entries.

## What it defines

The five tables of arch 09's "Safety and incidents" domain (arch 09 line 471: 5 tables), under Q-33's default (arch 09's shape; FS section 9 lists no safety table, so the sources are the steps and arch 06). Arch 09 gives only the count; the five follow 02-contracts section 7 row K-34. The paused flag a threat sets is K-04 core's `pauses` row (arch 03 line 175), and an emergency contact is a core `persons` row (K-22 adds the staff link later). Every table and column names its source in `safety-incidents.v1.tables.json`.

| Table               | What it holds                                                                                                                                                                                                                                                                               | Source                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `safety_outcomes`   | One row per raw text (or page or agent free text): the read's labels and their tense, the danger words' list and kind, the timeout marker, what holds after code's rules (K-02 safetyResult); the evidence words, who is at risk, who wrote it and the words matched, sealed. Never edited. | arch 02 lines 111, 129; arch 03 line 183; arch 06 lines 283, 315 to 329; A3-22; B3-17; K-02 v1 |
| `safety_holds`      | What an outcome holds and its release: at once, when the booking is private, after a clear "we're safe", or never; plug-in stop words still block booking.                                                                                                                                  | arch 06 lines 315 to 327; A3-24, A3-25, A3-26, A3-48, A3-50; S13-10                            |
| `harm_reports`      | Reports Rosie's team follows up that day: harm to a child or older adult, a report about the owner or staff (never told to the one named), a risk at home only the team hears of; the hotline given first.                                                                                  | A3-49; S13-10; arch 06 line 329; RULES 4.12; Q-18                                              |
| `safety_timers`     | Check-out timers for a pro alone: the pro, the emergency contact who said yes and their handle, due time and zone, the job's address (sealed), the core clock row, the state (running, missed, safe) and who was alerted after a miss.                                                      | S13-10; B8-86; S1-78; RULES 4.9, 4.12; arch 11 lines 566, 568; Q-06                            |
| `privacy_incidents` | Privacy slips: a detail never kept that arrived (deleted, the person told where it goes, the business only that one came) or a detail that reached the wrong person (sends stopped, codes replaced, everyone told, the team's look within 1 business day). Never the detail.                | S12-29, S12-30, S12-31; RULES 4.5, 4.10                                                        |

### Safety outcomes (K-02's values, kept)

- **Labels and tense** are K-02 v1's: `labels` and `outcomes` hold `safetyOutcome` values (the 8 outcomes of A3-22 and B3-17 word for word, or Unsure), `tenses` hold `tense` values (now, could restart, over, joke, unknown), `danger_word_lists` K-02's `dangerWords.list` (general, plugin) and `danger_word_kinds` its `kind` (selfHarm, other). CHECKs hold each list to K-02's values (`safety_outcomes_labels_known`, `_tenses_known`, `_outcomes_known`, `_danger_words_known`); a K-02 minor version that adds a value needs a K-34 minor version that widens the CHECK.
- **Read and result**: `labels` and `tenses` are the read's labels in order (pre-code); `outcomes` is K-02 `safetyResult.outcomes`, what holds after code's rules (a danger word lifts No to Unsure; on a timeout a danger word counts as Unsure, and with none the list is empty and the outage line goes). CHECKs: one tense per label; a timeout has no labels and a verdict at least one; the timeout rule; a lift gives Unsure.
- **Sealed:** `sealed_words`, under the key of `person_id` (the writer): each label's evidence words, who is at risk and who wrote it, and the danger words matched, as one JSON value (02-contracts row K-34: "sealed"; arch 09 line 492). Deleting the key erases the words; the labels and tense stay, plain, because the gate, the actor's danger-first order on return and the gold set read them without the person's key (README open gaps).
- **Never edited** (rule 5): what was read stays; a new text is a new row, unique on `event_id`.

### Holds and their release (arch 06 lines 315 to 327)

- One hold per outcome row (`safety_holds_one_per_outcome`), with the strictest rule of its outcomes: `never` (A threat to staff or others) over `after_safe` (An emergency, Crisis words, Unsure) over `when_private` (Unsafe at home) over `at_once` (No, Safety steps then go on, Harm to a child or older adult, Needs the business's own line). The visit never releases one: nothing commits, no fee.
- `released_why` fits the rule (`safety_holds_why_fits_rule`): `outcome_message_sent`, `booking_private`, `safe_readback`. A `never` hold is never released; the owner's decision clears the core pause, not the hold.
- A safe release names the turn of the clear "we're safe" and that text's own safety read (`safety_holds_safe_release_has_read`), which must hold no danger (S13-10: a fire, gas or a threat that could start again still gets the message). The held actions are then decided again from today's record with the booking's own fresh read-back and exact yes (limit 3); this row records only the release.
- `blocks_booking`: plug-in stop words still block booking after an at-once release (A3-26).
- A threat's paused flag is one or more core `pauses` rows set by the same turn (`pauses.set_by_turn_id`): the person, their phone, their place (A3-48).

### Harm reports (A3-49; S13-10)

- `kind`: `harm_to_child_or_elder`, `about_owner_or_staff` (names `named_person_id`, who is never told: `harm_reports_named_only_about_owner_or_staff`), `unsafe_at_home`. Harm to an animal goes to the owner, who decides any report (A3-49), so it is not a kind here.
- A child-or-elder report carries the hotline given first, from Rosie's safety list (`child_abuse`, `youth_crisis`, `family_violence`, `elder_care`: S13-10). The list's numbers are not stored here and never made up.
- "That day" is the calendar day of `reported_at` in `day_zone`; `followed_up_at` and `followed_up_by_person_id` (a person on Rosie's team, Q-18) record the follow-up.

### Safety timers (S13-10; B8-86; Q-06)

- No timer without a contact who said yes: `emergency_contact_person_id`, `emergency_contact_handle_id` and `contact_yes_at` are NOT NULL, and the yes comes before the start (`safety_timers_yes_before_start`). The contact is not the pro.
- The actor's copy (arch 11 line 566): `due_at`, `due_zone`, the sealed `address` and the contact's handle are in this one row, so the actor reloads them and a running timer fires while PostgreSQL is down; the core `clock_rows` row (`clock_row_id`, kind `step`) fires the miss when PostgreSQL is up (arch 01 line 83; arch 10 line 540).
- `state`: running, missed (stays missed until SAFE; reaching someone never closes it), safe. Alerts after a miss go to the pro, then the contact, then the owner (B8-86), by text to open chats and by email (Q-06); `*_alerted_at` is set only after `missed_at`.
- The address is sealed under the key of `address_for_person_id` (the customer whose place it is) and is secure-page-only, except that the contact is told it, and only it, after a missed check (RULES 4.9's one exception).

### Privacy incidents (S12-29 to S12-31)

- `detail_never_kept` (S12-30) names the kind of detail (`card_number`, `ssn`, `password`, `door_code`, `plugin_list`) and the inbound event, never the detail; `wrong_person` (S12-31) names the handle it reached, the outbox row where Rosie sent it, and the fields it showed by name (`name`, `visit_time`), never their values.
- The steps are times: deleted, stopped, codes replaced, person told, business told, the team's review; each comes after `found_at`. The 1-business-day deadlines are counted by code from `found_at`.

## Database rules beyond the table list

The table list's meta-schema has no place for these; the migrations must produce them too, and T-111 checks them.

1. **Same schema as core:** the five tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (`businesses.id`, `persons.id`, `handles.id`, `bookings.id`, `turns.id`, `clock_rows.id`, `outbox_rows.id`), so the references carry no schema prefix.
2. **Versions:** `safety_holds`, `harm_reports`, `safety_timers` and `privacy_incidents` are updated (released, followed up, missed or safe, each step of an incident), so each has `version integer not null default 1`, raised by every update and compared and set by a commit (arch 01 line 85; K-04 v1 rule 2). `safety_outcomes` is only appended and carries none.
3. **Ids** are `text`, opaque strings code makes (CQ-09).
4. **Row-level security** (arch 10 line 546; K-04 v1 rule 4): `safety_outcomes`, `safety_holds`, `safety_timers` and `privacy_incidents` are scoped by `business_id`; a row whose business is null (a text before there is a business) is seen by no business scope, and the actor, the guard and the dispatcher read unscoped (the `runtime` side). **`harm_reports` is Rosie's team's:** the Tool API role may insert into it (the commit writes the report) and has no `SELECT`, `UPDATE` or `DELETE` on it, so no business reads it, its owner included (SQLSTATE 42501); Rosie's team's side reads and follows up unscoped. Its table list says `scope: none` for that reason.
5. **Safety outcomes refuse edits by privilege**, as K-04 does for `event_log` (K-04 v1 rule 5): the application roles may insert and select on `safety_outcomes`, never update or delete it (SQLSTATE 42501).
6. **Sealed fields:** `safety_outcomes.sealed_words` (by `person_id`), `harm_reports.sealed_details` (by `sealed_for_person_id`) and `safety_timers.address` (by `address_for_person_id`), each under that person's key in core's `sealing_keys` (arch 01 line 93). The wrapping key is a Workers secret, named and never stored (rule 7).

## Seed and refused-row fixtures (`fixtures/`, listed in `fixtures/index.json`)

The fixture file format is K-04's (`../core/README.md`, "Seed and refused-row fixtures"): `after`, `rows`, and for a refused fixture `refused` with `role`, `scope`, `action` and `expect`. Each `after` path is relative to the `fixtures/` folder of this part, so its seeds name K-04's as `../../core/fixtures/<file>`; a loader loads each file once, its own `after` first. This part needs no K-29 seed. `npm run contracts:check` counts each entry as a seed row and leaves it to the contract test (02-contracts section 2 item 12).

Accepted (6): the four of 02-contracts row K-34, `seed-outcome-crisis` (Alex's crisis words after booking: the outcome and its open after-safe hold), `seed-hold-released` (Alex's emergency, released by a later "we're safe, it's handled" read as No, over), `seed-threat-pause` (Alex's threat to Riley: a never-released hold and the core pauses on Alex and Alex's phone), `seed-safety-timer` (Sam, alone on an in-home survey for the movers, TIMER 2 hours at 9:20am: due 11:20am, Morgan Lee as the contact); and two beyond its list, so every table has a seed row, as K-04 added `seed-pause`: `seed-harm-report` (Alex's report of harm to an older adult, with the elder-care hotline, and a report naming Riley) and `seed-privacy-slip` (S12-30's Dee W. card photo; S12-31's text about Ben T.'s booking to an old number). Refused (4, in `fixtures/invalid/`, beyond the row's list): `refuse-outcome-update` (42501), `refuse-timer-without-contact` (NOT NULL, 23502), `refuse-owner-reads-harm-report` (42501), `refuse-unknown-outcome-label` (CHECK `safety_outcomes_labels_known`, 23514). Each is refused for its one reason: a new row for a new text, the same timer with Morgan Lee and her yes, the same read on the team's side, and the same row labelled Crisis words each pass.

Names and values come from fixture set v1's demo shops (the barber as Lee's Barbershop, the movers: `fixtures/v1/test-kit/shops/barber.json`, `movers.json`) and the master's sample cast (Sam, Alex M., Riley, Ben T., Dee W. from S12-30, Morgan Lee from S1-78), never a real person (rule 9). The read texts are K-02 v1's own safety fixtures (`safety-crisis-words`, `safety-emergency-now`, `safety-threat`, `safety-child-or-elder`, by event id); the timer's times are B8-86's ("TIMER 2 hours", "check out by 11:20am"). Phone numbers are in the 555-01xx range (+15555550108 to +15555550110 are new here). Sealed values are short stand-in bytes, not real ciphertext; event ids, turn ids, trace ids and the clock row's `fires` object are examples.

**Checked on 2026-11-07** by a throwaway script against PostgreSQL 17 with PostGIS 3.5 in a private Docker container (the local image `postgis/postgis:17-3.5`, stopped and removed after): DDL built from the core, conversations-consent and this part's table lists (31 tables), with K-04's roles and row-level security, no update or delete on `safety_outcomes`, and insert-only `harm_reports` for the Tool API role; every listed column with its nullability found in the catalog; all 28 seed files of the three parts loaded together, and each of these 6 alone with its `after` chain; each refused fixture refused as its `expect` says (42501, 23502, 42501, 23514 `safety_outcomes_labels_known`; a delete of an outcome 42501 too) and passed once its fault was removed; every other CHECK and unique key of the five tables refused a row that broke it (41 rows); a timeout with a self-harm word passed as Unsure; a Tool API call scoped to the yoga studio saw none of the barbershop's outcomes, holds or incidents, or the movers' timer, and each was seen in its own scope; the timer's due time, zone, sealed address and contact's mobile read back in one row. T-111 writes the real test.

## Producers and consumers (02-contracts K-34 and section 7)

- **Producers:** database engineer: C-170 safety and incidents tables, with C-154 migrations queue and C-155 seeds from fixture set v1.
- **Consumers:** action-layer engineer: C-104 safety and hand-offs (outcomes, holds and their release, harm reports, privacy incidents, timers), C-080 policy gate (open holds), C-087 one commit per turn; runtime engineer: C-047 safety read on arrival (the outcome per text), C-051 guard and C-124 outbox dispatcher (holds, safety first), the actor's copy of a running timer (arch 11 line 566), C-054 clock rows (the timer's miss); AI engineer and QA: C-139 gold-set generator, C-140 eval harness (danger cases' labels and tense); database engineer: C-202 staging seeded state; QA: C-147 scenario tests, T-111 contract test; journey 8 (B8-86, the check-out timer) and journey 12 (S12-29 to S12-31) at their K-09 minor versions (02-contracts section 6 v1.6, v1.10).
- **Frozen before it:** K-04 (frozen, #55). K-02 v1 (merged) gives the outcome's values. **Frozen with it:** K-36 notifications (F13), which holds pages to Rosie's team and their acknowledgement; a harm report or a missed timer may page through K-36, which refers to rows here, not the other way.

## Defaults used (T-043)

1. **Q-33** (arch 09's shape, FS section 9 as the checklist): five tables, named from 02-contracts row K-34; FS section 9 has no safety table.
2. **Q-06** (lone-pro alerts by text to open chats and by email; the timer runs only with a contact who said yes by texting Rosie): the timer row carries the contact's handle and `contact_yes_at`, NOT NULL; the alert times are channel-free.
3. **Q-18** (Rosie's team is Jay and the CTO until launch): `harm_reports.followed_up_by_person_id` names a person row; no seed names a team member.
4. **CQ-05** (whose zone): "that day" for a harm report is counted in the business's zone (`day_zone`).
5. **Labels plain, words sealed:** the 02-contracts row lists the labels, tense, evidence words, who is at risk and who wrote it as sealed; this part seals the person's words and keeps the closed-list labels and tense plain, as K-02's values, so the gate, the actor and the gold set read them without the key (open gap below).
6. **K-34's own refused fixtures** (beyond the row's list, which names none) and two extra seeds, so every table has a seed row.

## Open gaps

- **Whether the labels themselves are private** (RULES 4.5: "When unsure, treat it as private"; 02-contracts row K-34 "sealed"): v1 keeps `labels`, `tenses` and `outcomes` plain and seals the words, so after a key is deleted the row still shows, for example, that a person's text read Crisis words. If they must be sealed too, it is a v2 (a moved column) with the CTO's OK. Proposed for QUESTIONS.md.
- **Rosie's safety list's numbers** (S13-10: lines for child abuse, youth crisis, family violence and elder care; A3-49 "Never make up or guess a hotline number"): not in the sources. `hotline` names the line's kind only; the numbers belong in the bundle's fixed lines (K-01) once Jay gives them. Proposed for QUESTIONS.md with CQ-18.
- **"That day"** (A3-49; arch 06 line 329): whose day, and until what hour, is not in the sources; `day_zone` is the business's zone under CQ-05, and the deadline is the end of that calendar day. Proposed for QUESTIONS.md.
- **"Held until a person has spoken with them"** (S13-10: "Where the plug-in says, the booking is held until a person has spoken with them"): not a `release_rule` in v1, since arch 06's table does not place it among the four and its order against them is not given. If needed, a v1.1 value (a CHECK that only widens).
- **A running timer whose contact's yes ends** (S13-10: "An emergency contact's STOP or removal ends their yes. No timer runs"): v1 has no cancelled state; whether a running timer stops at once or runs to its due time is not in the sources. Proposed for QUESTIONS.md with Q-06.
- **The contact's yes itself** is K-22's (staff emergency contact with their own yes; S1-78); here it is only the copied time `contact_yes_at`, since K-22 is not frozen yet and K-29's consent kinds have no safety-calls kind.
- **Who at risk and who wrote it as closed lists** (CQ-22): free text in K-02 v1, sealed here; no plain column until CQ-22 is ruled.
- **Self-harm words** (CQ-24): `danger_word_kinds` stores the kind code set; the list is the AI engineer's (C-113).
- **K-36's pages** (paging every 5 minutes until acknowledged, arch 06 line 329; who is paged, QUESTIONS.md M3-M3b.5) are K-36's; nothing here records a page.
- **CQ-09's id forms:** ids are opaque text until the CTO rules.

## Change log

- v1, 2026-11-07 (T-043): first version, frozen.
