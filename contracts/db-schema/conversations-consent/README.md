# db-schema/conversations-consent (K-29): the database schema, conversations and consent part

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-038. The freeze takes effect when T-038 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: database engineer, action-layer engineer, runtime engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the database engineer that the migrations can produce exactly this table list, with the rules below (C-165, with C-154 migrations queue and C-155 seeds); the action-layer engineer the rows the messages-and-consent service writes: a consent row bound to the read-back, never edited, a STOP or a contact switch as a new row, and the chat links it issues (C-102); the runtime engineer the STOP record the guard writes and reads and the texts check limit 8 makes (C-051, C-125), and matching a sent ready text to its link; QA and eval the seeds and refused rows (C-147; the contract test T-106). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Table list:** `conversations-consent.v1.tables.json`, checked against `../tables.meta.schema.json` (02-contracts section 2 item 3). **Checked by:** `npm run contracts:check` (the list's shape, that every column a key, constraint, index, scope, version or seal names exists, and the fixtures index). **Contract test:** `tests/contract/db-schema.conversations-consent.v1.test.ts` (QA, T-106): migrate a fresh schema with the core part, compare the catalog with the table list, load the seeds, refuse the refused rows. A change after the freeze is a new file, `conversations-consent.v1.1.tables.json` (additive) or `conversations-consent.v2.tables.json` (breaking, with the CTO's OK), with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's table list, its fixtures or their index entries.

## What it defines

The two tables of arch 09's "Conversations and consent" domain (arch 09 line 466: 11 tables) that the core part does not already hold, under Q-33's default (arch 09's shape, FS section 9 as the checklist). The rest of the domain is in K-04 core v1: `phones` (FS line 728), `threads`, `openers_sent`, `messages` (FS line 734), `open_questions`, `clock_rows`, `outbox_rows` and `outbox_parts` (02-contracts section 7 row K-29: "open questions, outbox, phones and threads are in core"). Arch 09 gives only the count, not the table names. Every table and column names its source in `conversations-consent.v1.tables.json`.

| Table        | What it holds                                                                                                                                                                                                                                                                          | Source                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `consents`   | Every yes and every stop as its own row: person, business, kind (texts, photos shown, ticked terms, plan terms, fee OK, health agreement), revoked, the contact, the booking, the exact words shown and their sha256, the time, the channel, the chat link and the turn. Never edited. | FS lines 735, 752, 753, 756; arch 01 line 89; arch 09 lines 457, 492; RULES 4.10, 6.7, 7.1 to 7.5, 9.1 |
| `chat_links` | Each chat link issued: its short code and ready text, its purpose (a booking, or a staff invite), the business, booking, person and mobile it is for, where it was given, when it was issued, when the owner was told again, and when its ready text arrived.                          | MC C9; RULES 4.1b; S2-05; Q-03                                                                         |

### Consent rows: never edited

- **Kinds** are FS line 735's, without automated calls (no voice provider: Q-05; arch 12 "Phone calls (D5)") and face match (C10 removed it). CHECK `consents_kind_known` refuses both (SQLSTATE 23514). Each source: texts (S13-32; RULES 7.1), photos shown (B4-69), ticked terms (A5-07), plan terms (A5-21), fee OK (S1-25; FS M03), health agreement (S1-72; RULES 4.10).
- **Never edited** (FS line 753): the application roles may insert and select on `consents`, never update or delete; an update or delete is refused with SQLSTATE 42501, as K-04 does for `event_log` (K-04 v1 rule 5). The proof of every yes and the "don't text me" record stay through a 45-day delete and for 7 years (RULES 4.10), so no consent column is sealed: deleting a person's key leaves the words shown and their hash (arch 09 line 492).
- **Revoked is a row, not an edit.** FS line 735 names `revoked_at`, and FS line 753 says the row is never edited. So a withdrawal is a new row with `revoked = true`, whose `at` is the revoked time: a STOP in any words (RULES 7.2), the old contact when updates move to a new one (RULES 9.1; FS line 756: "a contact switched adds a consent and a contact change"). START, or a fresh yes on a new booking from that number, is a new row with `revoked = false` (RULES 7.5). For one person, kind, business and contact, the newest row (by `at`, then the lower `id`, compared and never parsed: CQ-09) decides.
- **A STOP covers every business** (D102; RULES 7.2; MC C1): its row has `business_id` null, `kind = 'texts'` and the mobile in `handle_id`. Only texts rows may have no business (CHECK `consents_every_business_only_texts`), and every texts row names its contact (CHECK `consents_texts_has_contact`). The core `phones.stopped` flag and `stop_at` are written in the same commit as the STOP row (one commit per turn: arch 10 line 508); the row is the record, the flag what limit 8 reads.
- **Bound to the read-back** (arch 01 line 89; arch 06 line 303; arch 09 line 457): `exact_words` holds the words shown (the read-back, the card, the terms ticked), and `turn_id` the turn whose read-back the yes answered, where a turn wrote it; that turn's open question holds the versions read. `words_sha256` is the sha256 of `exact_words` in UTF-8, lowercase hex, and CHECK `consents_words_sha256_match` holds it to the words, so the event log's proofs (K-08) can carry the hash.
- **Ticked terms name their booking** (CHECK `consents_ticked_terms_has_booking`; A5-07): the same words are K-30's `terms_text`, written once at booking (FS line 752).

### Chat links (MC C9; RULES 4.1b)

- A link opens Messages to Rosie's number with a ready text and a short code; sending it opens the chat. For a booking, the ready text is "Hey, send me further updates about my booking" and a short booking ref (RULES 4.1b). CHECK `chat_links_ready_text_has_code` holds the code inside the ready text, and `chat_links_short_code_key` makes each code find one link.
- `purpose`: `booking` (the booking page, the confirmation email, the customer's own AI, or the owner for a booking the business adds) or `staff_invite` (the owner passes it on; that person's sent ready text is their yes to join, S2-05 under C9). A booking link names its booking and a staff invite none (CHECK `chat_links_booking_only_for_booking`).
- `given_via` grows as the link is given in a new place (`booking_page`, `confirmation_email`, `customer_ai`, `owner`); `owner_retold_at` records the owner told once, 48 hours after an unanswered staff invite (C9); `used_at` records the ready text arriving from `phone_number`. A ready text that gives a yes adds a consent row of kind texts naming the link (`consents.chat_link_id`; RULES 7.1, "a yes on a forwarded link").
- The link is issued only for a mobile already added as a Linq contact (`phones.linq_contact_added_at`; Q-03). That spans two tables, so code checks it before issuing; it is not a constraint.
- A booking's first link time is K-30's `first_link_given_at` (Q-33); K-30 may read it from here.

## Database rules beyond the table list

The table list's meta-schema has no place for these; the migrations must produce them too, and T-106 checks them.

1. **Same schema as core:** both tables live beside K-04's tables, and their foreign keys name core tables by K-04's keys (`businesses.id`, `persons.id`, `handles.id`, `bookings.id`, `phones.number`, `turns.id`), so the references carry no schema prefix.
2. **Versions:** `chat_links` is updated (given in a new place, owner told again, used), so it has `version integer not null default 1`, raised by every update and compared and set by a commit (arch 01 line 85; K-04 v1 rule 2). `consents` is only appended and carries none.
3. **Ids** are `text`, opaque strings code makes (CQ-09). Short codes too: code makes them and never parses them.
4. **Row-level security per business** (arch 10 line 546; K-04 v1 rule 4): both tables are scoped by `business_id`. A STOP or START row (business null) is seen by no business scope; the guard and limit 8 read consents unscoped (the `runtime` side), as K-04 rule 4 allows for jobs that work across businesses by handle. Matching a sent ready text to its link is also runtime work, unscoped.
5. **Consents refuse edits by privilege** (rule above): no `UPDATE` or `DELETE` grant on `consents` for the application roles, SQLSTATE 42501.

## Seed and refused-row fixtures (`fixtures/`, listed in `fixtures/index.json`)

The fixture file format is K-04's (`../core/README.md`, "Seed and refused-row fixtures"): `after`, `rows`, and for a refused fixture `refused` with `role`, `scope`, `action` and `expect`. Each `after` path is relative to the `fixtures/` folder of the file that names it, so this part's seeds name K-04's as `../../core/fixtures/<file>`; a loader loads each file once, its own `after` first. `npm run contracts:check` counts each entry as a seed row and leaves it to the contract test (02-contracts section 2 item 12).

Accepted (4): `seed-consent-fee-ok` (Sam's fee OK for Lee's Barbershop: S1-25's card word for word and Sam's "1"), `seed-consent-stop-row` (Ben T.'s STOP as a new revoked row for every business, after his texts yes; its time is the core phone row's `stop_at`), `seed-consent-health-agreement` (Sam signs the health privacy agreement on the secure page for Lee Nutrition Clinic, the dietitian demo shop, which it adds with Sam's owner role), and `seed-chat-link` (Ben's booking link and the texts yes its ready text gave; Avery's staff invite, answered; Pat's, unanswered, with the owner told again 48 hours later; it adds Ben's booking head and Pat's person, handle and phone). Refused (2, in `fixtures/invalid/`): `refuse-consent-update` (an update of a consent row, 42501) and `refuse-face-match-kind` (kind `face_match`, CHECK `consents_kind_known`, 23514). Each is refused for its one reason: the same change as a new row, or the same row as `photos_shown`, passes.

Names and values come from fixture set v1's demo shops (the barber as Lee's Barbershop, and the dietitian's Lee Nutrition Clinic: `fixtures/v1/test-kit/shops/barber.json`, `dietitian.json`) and the master's sample cast (Sam, Ben T., Avery, and Pat from S2-05), never a real person (rule 9). Phone numbers are in the 555-01xx range, as K-04's fixtures use. Words shown are the master's own lines: S1-25's cost card, S1-72's agreement card, S1-10's face-match lines, and RULES 4.1b's ready text. Short codes (`4K7Q`, `R2V9`, `P5J3`), the "Ref" form of the ready text and the staff invite's "YES" ready text (from S2-05's "Reply YES to join") are examples (open gaps below).

**Checked on 2026-11-07** by a throwaway script against PostgreSQL 17 with PostGIS 3.5 in a private Docker container (the local image `postgis/postgis:17-3.5`, removed after): DDL built from the core and this part's table lists, with K-04's roles and row-level security and no update or delete on `consents`; all 18 core seeds and these 4 loaded together, and each of these 4 alone with its `after` chain; `refuse-consent-update` refused with 42501 (a delete too), and the same change as a new row passed; `refuse-face-match-kind` refused by `consents_kind_known` with 23514, and the row as `photos_shown` passed; a Tool API call scoped to Lee's Barbershop saw its fee OK row and not Ben's STOP row, which the runtime side saw; each other CHECK (contact, hash, ticked terms' booking, texts-only for no business, channel, a booking link's booking, the code in the ready text, the places, the owner told only for staff) and the unique short code refused a row that broke it; every words_sha256 equals the hash of its words. T-106 writes the real test.

## Producers and consumers (02-contracts K-29 and section 7)

- **Producers:** database engineer: C-165 conversations and consent tables, with C-154 migrations queue and C-155 seeds from fixture set v1.
- **Consumers:** action-layer engineer: C-102 messages and consent (consent rows bound to the read-back and never edited; the chat links it issues), the journey 1 steps that write consent (S1-25 fee OK, S1-72 agreement, S1-29 ticked terms with K-23); runtime engineer: C-051 guard (the STOP record), C-125 limit 8 at send (no texts after STOP, none to a mobile with no open chat), and the actor matching a sent ready text to its link; frontend engineer (through K-21): C-191 fee consent card, C-185 signed links and C-197 booking page (the chat link and its QR); database engineer: C-202 staging seeded state; QA: C-147 scenario tests, T-106 contract test.
- **Frozen before it:** K-04 (frozen, #55). **Frozen with it:** K-37 (F4). **Before it is read:** K-09 v1 freezes after it (F5), with K-29 among its "frozen before it".

## Defaults used (T-038)

1. **Q-33** (arch 09's shape, FS section 9 as the checklist): this part holds only consents and chat links; the rest of the domain is in core.
2. **Revoked as a row** (FS line 735 `revoked_at` against line 753 "never edited"): a withdrawal is a new row with `revoked = true` and its own `at`; the newest row decides. Proposed for QUESTIONS.md as the reading of FS lines 735 and 753.
3. **A STOP or START row has no business** (D102; RULES 7.2, 7.5): one number, so it covers every business; only texts rows may.
4. **Consent rows carry their contact, booking, chat link and turn** where there is one (FS line 756; A5-07; RULES 7.1, 7.5; MC C9; arch 01 line 89), beyond FS line 735's list, so a contact switch, a booking's terms and an exact yes can each be traced.
5. **The hash** is sha256 over the words in UTF-8, lowercase hex, as K-04's `bundle_values.sha256` (arch 09 line 492 names hashes, not the algorithm).
6. **Q-01** (the STOP reply's words) and **Q-30** (the opt-out line on Rosie's first reply in a chat the person opened): neither adds a column here; the STOP row stores the person's own words, and the opt-out line's delivery is core's `phones.optout_line_delivered_at`.

## Open gaps

- **The short code's form and the ready text's layout** (C9 says "a ready text and a short code"; RULES 4.1b "a short booking ref"): not in the sources. Here a short code is any text without spaces that appears in the ready text; the fixtures' "Ref 4K7Q" form is an example. The composer's fixed lines (K-01, K-03) or CQ-09 should name it; proposed for QUESTIONS.md.
- **The staff invite's ready text** (C9: "that person's sent ready text is their yes to join"): its words are not given; the fixture uses S2-05's "YES" with the code. Proposed for QUESTIONS.md with the short code's form.
- **The health privacy agreement's own words** (RULES 4.10 [lawyer]; S1-72): not in the sources; the fixture stores S1-72's card. The words stored in production are the agreement as shown.
- **The owner sign-up chat link for a chair renter** (QUESTIONS.md M4.8, default pending Jay): not a `purpose` in v1; if Jay keeps the default it is a v1.1 value (a CHECK that only widens), with `business_id` nullable for it, since the renter has no business yet.
- **Contact changes** (D75, D77, D100; FS line 756): the contact change row itself is K-22's; here a switch is only its two consent rows.
- **A STOP's own words may carry a private detail** (RULES 4.5: "When unsure, treat it as private"): consent rows are not sealed because the proof must survive (RULES 4.10). Whether a STOP row stores the person's whole text or only the stop word is not in the sources; proposed for QUESTIONS.md with K-04's "erasure of plain columns" gap.
- **CQ-09's id forms:** ids and short codes are opaque text until the CTO rules.

## Change log

- v1, 2026-11-07 (T-038): first version, frozen.
