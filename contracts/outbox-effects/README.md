# outbox-effects (K-07): outbox rows and effect rows

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-016. The freeze takes effect when T-016 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: action-layer engineer, database engineer, runtime engineer, integrations engineer, frontend engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the action-layer engineer the rows the commit writes, the final parts, the effects runner's moves and reconciliation's effect id and ledger line (C-087, C-088 to C-093, C-101, C-109, C-112); the database engineer that K-05's calls can make exactly these moves on K-04 v1's outbox tables and that the migrations can produce this contract's table list (C-151, C-152); the runtime engineer the row and part states, the claim and its lapse, limit 8's outcomes, the retry rules, the two-part send, the email rows and the outage paths (C-124 to C-129, C-055, C-174 to C-176); the integrations engineer that the Linq, email, Stripe and calendar adapters can produce the part and effect results and the provider events (C-206, C-208, C-213 to C-217); the frontend engineer what the team console shows of failed rows and effects (C-194; dead letters are K-37's); QA and eval the fixtures, the moves and the named rule (C-148, C-140; the contract test T-086). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `outbox-effects.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/outbox-effects/outbox-effects.v1.schema.json`); its root is one record: an outbox row's life, an effect row's life, or a provider event. **Table list:** `outbox-effects.v1.tables.json` (the schema addition, checked against `../db-schema/tables.meta.schema.json`). **Named rule:** `outbox-effects.rules.mjs` (`lifeChain`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/outbox-effects.v1.test.ts` (QA, T-086). A change after the freeze is a new minor version file, `outbox-effects.v1.1.schema.json` or `outbox-effects.v1.1.tables.json`, with new fixtures (build prompt 6.4). The frozen-contract guard fails any edit to v1's schema, its table list, its fixtures or their index entries; it does not cover the rules file (a release-engineer task T-011 already named).

## What it defines

The state words K-04 v1 holds as text (`outbox_rows.state`, `outbox_parts.kind`, `outbox_parts.state`) and K-05 v1's calls move (K-05 README: "its state moves to K-07's claimed state"; "The state words are K-07's"), the only moves between them, the retry rules, the email copy row, and the effect rows and provider events with their tables. Every field's `description` names its source; "arch NN line N" are the lines of `scratch/text/architecture.txt`.

### The outbox row's states (`rowState`; arch 02 lines 123 to 127; arch 06 line 313)

| State             | Meaning                                                                                                  | Holds                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| `planned`         | Committed; final parts not written (K-04's default). An email copy may already hold its text row's plan. | no final parts            |
| `checked`         | Plan and final parts written after the message checks (K-05 `writePlan`)                                 | final parts               |
| `sending`         | Claimed by one dispatcher, which sends its parts in order (K-05 `claimOutbox`: "K-07's claimed state")   | final parts, a claim      |
| `sent`            | Every part's latest try accepted by the provider                                                         | final parts               |
| `delivered`       | Every part's latest try delivered (on SMS, Linq's sent receipt is the receipt: arch 02 line 127)         | final parts               |
| `held`            | Limit 8: outside text hours, held to 9am, or 8am for owner and team (K-05 `markRow` held)                | final parts, `held_until` |
| `dropped_stopped` | Limit 8: the phone is stopped; its question takes step 9's never-delivered path                          |                           |
| `stale`           | Limit 8: versions changed; plan and final parts cleared, composed again from today's record (S13-57)     | no final parts            |
| `withdrawn`       | Limit 8: stale, and its booking or question has closed; or waiting, and it closed before the chat opened |                           |
| `failed`          | Sends still failing after 15 minutes of tries; the next way follows (S12-09, S12-10)                     |                           |
| `waiting_chat`    | Limit 8: a customer mobile with no open chat; waits until it texts in (arch 06 line 313; RULES 4.1b)     | no claim, no `held_until` |
| `superseded`      | Was waiting; the mobile texted in and one message giving each booking as it stands took its place        | no claim, no `held_until` |

A waiting row has no clock: it is not held, it keeps no claim (the move to `waiting_chat` deletes its `outbox_claims` row), and no question clock arms, since it is never delivered (arch 06 line 313: "other rows wait, with no clock, until it texts in"; RULES 4.1b: "No clock or fee runs on a message they didn't get"). Under MC C9 no first-contact SMS goes either: Rosie never writes first, and the chat link reaches the person through the booking page, the confirmation email, their own AI or the owner. When the mobile texts in, the turn that answers it writes one row, the one message giving each booking as it stands, and in the same commit every waiting row of that mobile moves to `superseded`, naming that row (`followUps` `chatOpenAnswer`); "Nothing sent before is sent again" (RULES 4.1b).

### Allowed moves (`rowMove`, `partMove`, `effectMove`; nothing else is accepted)

| Row move                  | By                  | Source                                                         |
| ------------------------- | ------------------- | -------------------------------------------------------------- |
| (new) → planned           | `commitTurn`        | arch 01 lines 39 to 41; K-05 item 1                            |
| planned → checked         | `writePlan`         | arch 02 line 123; K-05 item 2                                  |
| stale → checked           | `writePlan`         | arch 06 line 313; S13-57                                       |
| checked → sending         | `claimOutbox`       | arch 02 line 125; K-05 item 3                                  |
| held → sending            | `claimOutbox`       | arch 02 line 125; K-05 item 4 (held returns to the open rows)  |
| sending → sending         | `claimOutbox`       | a lapsed claim taken again (below); arch 11 line 576           |
| sending → sent            | `markPart`          | the last part accepted                                         |
| sent → delivered          | `markPart`          | every receipt in (arch 02 line 127)                            |
| sending → delivered       | `markPart`          | a receipt after a 4001 or 4006 (arch 01 line 65)               |
| sent → checked            | `markPart`          | an accepted part reported failed goes again (arch 07 line 367) |
| sending → held            | `markRow`           | arch 06 line 313                                               |
| sending → dropped_stopped | `markRow`           | arch 06 line 313                                               |
| sending → stale           | `markRow`           | arch 06 line 313                                               |
| sending → withdrawn       | `markRow`           | arch 06 line 313                                               |
| sending → failed          | `dispatcherGivesUp` | arch 02 line 125 (K-05 v1.1's call: open gap 2)                |
| sending → waiting_chat    | `markRow`           | arch 06 line 313; RULES 4.1b (K-05 v1.1's `waitingChat`)       |
| waiting_chat → superseded | `commitTurn`        | arch 06 line 313; RULES 4.1b (K-05 v1.1)                       |
| waiting_chat → withdrawn  | `commitTurn`        | arch 06 line 313 (K-05 v1.1; default 10)                       |

| Part move                | By                                                                 | Source                                               |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| (new) → pending          | `claimOutbox`, or `markPart` failed with retry (next try, new key) | arch 01 line 65; K-05 items 3, 4                     |
| pending → pending        | `markPart` attempt, or a re-claim: same key, `attempts` + 1        | arch 01 line 65; arch 11 line 576                    |
| pending → sent           | `markPart` sent                                                    | K-05 item 4                                          |
| sent → delivered         | `markPart` delivered                                               | arch 02 line 127                                     |
| pending or sent → failed | `markPart` failed                                                  | arch 01 line 65; arch 07 line 367                    |
| failed → delivered       | `markPart` delivered                                               | a 4001 or 4006 "may still deliver" (arch 01 line 65) |

| Effect move         | By                                                                     | Source                                |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| (new) → pending     | `commitTurn`, or `fireClock` with no turn                              | arch 10 lines 508, 540                |
| (new) → pending     | `reconciliationJob`, a `stripe_refund` only, written by a job          | arch 10 line 550; S12-26 (K-05 v1.1)  |
| pending → running   | `claimEffects`                                                         | K-05 v1.1 (claim effect rows)         |
| running → running   | a network error retried on the same key, or a lapsed claim taken again | arch 10 line 542                      |
| running → succeeded | `recordEffectResult` ok                                                | K-05 v1.1 (record an effect's result) |
| running → declined  | a card decline: never retried                                          | arch 10 line 542; RULES 3.11          |
| running → outage    | the 5th try in 10 minutes failed                                       | arch 10 line 542; S12-16              |
| outage → running    | `serviceBack`: runs once                                               | arch 11 line 582; S12-16, S12-18      |
| outage → cancelled  | `letGo`: still down with no yes                                        | arch 11 line 582; S12-17              |

### How K-05 v1's calls use them (K-05 v1 as frozen)

- **`claimOutbox`** takes `checked` rows, `held` rows whose `held_until` has passed, and (from K-05 v1.1) `sending` rows whose claim lapsed, and moves them to `sending`. In its walk, `planned` and `stale` rows (no final parts) and `sending` rows with a live claim stop the walk for that recipient; `held` rows not yet due are passed (`passedHeld`); `waiting_chat` rows are passed too, as a held row lets later rows pass (arch 02 line 125): they wait for the chat to open, not for the dispatcher; `sent`, `delivered`, `dropped_stopped`, `withdrawn`, `failed` and `superseded` rows are finished and skipped. New parts are written `pending` with K-03's send kind.
- **`markPart`** moves the part, and the row with it in the same transaction, raising the row's version: the last part accepted moves `sending` to `sent`; every part's latest try delivered moves the row to `delivered`; `failed` with `retry` on a part of a `sent` row moves the row back to `checked`. The row follows the latest try of each part. Storing the provider's Retry-After in the claim's `next_try_not_before` with a failure is K-05 v1.1's (v1's `markPart` takes no such field).
- **`markRow`**'s outcomes are the states: `held`, `droppedStopped` → `dropped_stopped`, `stale`, `withdrawn`; and, from K-05 v1.1, `waitingChat` → `waiting_chat` (no K-05 v1 call writes it), which clears `held_until` and deletes the row's `outbox_claims` row. Whether the mobile's chat is open is K-05 v1.2's read of a recipient's send state (limit 8's reads).
- **`writePlan`** moves `planned` or `stale` to `checked`.
- **`commitTurn`** writes rows as `planned`. From K-05 v1.1 (no K-05 v1 call writes these moves), the commit of the turn that answers a mobile's first text writes the one message and moves every `waiting_chat` row of that mobile to `superseded`; a commit that closes a booking or question moves its `waiting_chat` rows to `withdrawn`.
- **Effects:** the `effects` table and every call that writes it are K-05 v1.1's (open gap 2). The daily reconciliation's write of a refund effect, under neither a turn nor a clock firing (`reconciliationJob`), is a K-05 v1.1 need of its own: no K-05 v1 call writes it.

### Parts (`outboxPart`; arch 01 line 65; arch 07 line 367)

- **Kind** is K-03 v1's send kind (`words`, `poll`, `linkCard`, `tapback`), as K-05's claim copies it and K-04's seed holds it. Of the formats tested on Nov 5 (MC 8 "iPhone tests"), a calendar file rides with the words (K-03 `calendarFile`: new, move, cancel), and a threaded reply is the final parts' `threadReplyTo`. A plain retry of a refused part is `words` (options typed, a card's bare link, words without their file).
- **The key** is `<row>/<part>/<try>` (K-04 `outbox_parts_key_form`).

### The retry rules (named rule `lifeChain`, and the constants it exports)

1. A retry after a timeout or crash reuses the key (`attempts` + 1); one after a reported failure gets a new key, the next try (arch 01 line 65).
2. After a 4001 or 4006, a new key only if no delivery receipt comes within 1 minute; a receipt that comes moves the failed part to `delivered` (arch 01 line 65).
3. A failed safety line retries every 10 s for 15 minutes, and goes at once every other way the person allows (`followUps` `safetyOtherWay`) (arch 02 line 125; RULES 4.12).
4. The second send waits for the words' delivery receipt, at most 10 s after Linq accepts them; a refused part goes again plain (arch 07 line 367).
5. Sends still failing after 15 minutes of tries: the row is `failed` and the next way follows (`followUps` `nextWay`, such as email); none left, the owner gets the number to call (`ownerGetsNumber`) (arch 02 line 125; S12-09, S12-10). The 15 minutes count from the claim's `firstTryAt`, when the first part went, which a re-claim keeps although `claimedAt` changes.
6. Each try goes after any Retry-After (arch 10 line 540): the claim's `nextTryNotBefore` holds it while the next try waits, so a dispatcher that claims the row again after a lapse sends no earlier; the try clears it.
7. A 403 with code 2024: Linq blocks sends after an exact STOP, UNSUBSCRIBE, OPTOUT, CANCEL, END or QUIT, and only the sends the rules allow go with `override_optout` (arch 10 line 524). Which sends those are is K-11's port call and the guard's (RULES 4.3, 7.4); in v1 a 2024 is a reported failure like any other, and the row's `markRow` at send has already dropped a stopped phone.
8. Effects: one idempotency key over all tries; network errors retried, at most 5 tries in 10 minutes from the run's start, then that service's outage row; a card decline never retried (arch 10 line 542). After the outage the effect runs once more on the same key (a new run) or is cancelled when its booking is let go (arch 11 line 582).

`lifeChain` also checks that each subject's moves start when it is written, chain `to` → `from` in time order and end in its stated state; that a `sending` row has its claim and `claimNo` counts its claims; that the claim's `firstTryAt` falls between the first part move and the first part outcome, and is set once a part has had one; that `nextTryNotBefore` is set only while the row is `sending` with a part pending whose latest move came before it; that a `superseded` row names exactly one `chatOpenAnswer`, written in the commit that superseded it, to the same mobile, and that only a superseded row names one; that `tries`, `runs` and `firstTryAt` match the effect's moves. The schema itself keeps a `waiting_chat` or `superseded` row without a claim or `held_until`, and a `reconciliationJob` effect a `stripe_refund` written by a job. A provider event has no moves.

### How a claim lapses (K-05 v1 open gap 1)

K-04 v1 has no claim-time column, so this contract adds `outbox_claims` (one row per claimed outbox row: `claimer`, `claimed_at`, `lapses_at`, `claim_no`, and the two times a re-claim must keep: `first_try_at`, when the first part went, which the 15 minutes count from (arch 02 line 125), and `next_try_not_before`, the provider's Retry-After for the pending next try (arch 10 line 540)). A move to `waiting_chat` deletes the row's claim. The claim lapses at `lapses_at`: `claimed_at` plus 60 s, renewed by 60 s at each part attempt the claimer makes (default 2). A `sending` row whose claim has lapsed may be claimed again by compare-and-set (row version and `claim_no`); its unsent parts go under their stored keys with `attempts` raised (arch 11 line 576), so a send the dead dispatcher made is not doubled. Effects carry their claim in their own row (`claimed_by`, `claim_lapses_at`), the same way. Writing and renewing the claim, and the re-claim, are K-05 v1.1's (T-071); until it lands a claim never lapses, as K-05 v1's README says.

### Email rows (arch 07 line 371; RULES 4.1)

An email copy is its own row on the `email` channel and port with `copyOfRowId` naming the text row whose plan it reuses; its final parts are one `words` send with the options typed. The next way after a failed text row (S12-10) is an email row too, with no `copyOfRowId`. No SMS channel of its own: `sms` is Linq's SMS service in the same chat, through the `linq` port, text only (DL-012; DL-031); there is no SMS port.

### Effect rows (`effectRow`; table `effects`)

The effect id (reconciliation matches by it: arch 10 line 550); the turn id, or the job id for a clock firing with no turn; the business and booking; the kind (Stripe save a card, charge, refund, pay link, dispute evidence on the owner's yes; Rosfield's monthly charge; calendar write, update or delete keyed by booking, visit and person; Linq's contacts/add: CQ-04); the port; the calendar provider; the visit, person and handle the kind needs; the amount in cents; the request in the port's terms (`portRequest`, an object whose shape K-14, K-16 and K-11 give); one idempotency key; the state, tries, runs and first try; the provider's object id; the last error; the ledger line it writes or matches (K-28); the trace id.

### Provider events (`providerEvent`; table `provider_events`)

Stripe and calendar events, stored once by `(provider, provider_event_id)` after the gateway verifies them, and linked to their effect row when they report on one (arch 02 line 109). A calendar push about a person's own event links to none (S12-33).

### The schema addition (`outbox-effects.v1.tables.json`)

Three tables in the same schema as K-04's core tables, migrated with K-05 v1.1 (02-contracts K-07: "a small schema addition ... migrated with K-05 v1.1"). The list lives here, in this contract's folder, and follows the database parts' format (`../db-schema/tables.meta.schema.json`), so `npm run contracts:check` checks it and the freeze guard protects it; its part name is `outbox-effects`.

| Table             | Holds                                                                                    | Row-level security         |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| `effects`         | the effect rows; unique key; CHECKs for kind, port, state, tries, calendar keys, amounts | business (`business_id`)   |
| `provider_events` | Stripe and calendar events, primary key `(provider, provider_event_id)`                  | business (`business_id`)   |
| `outbox_claims`   | the claim on a sending outbox row and when it lapses                                     | none (the dispatcher only) |

The commit writes effects under its per-write business scope (K-05 v1 scope), so `effects` is scoped by business; a contact effect has no business and is written on the runtime side. Rules beyond the list, kept by code: an effect's `portRequest` and a provider event's `payload` never hold a key or a card number (rule 7; arch 02 line 109); a `calendar_update` or `calendar_delete` finds the visit's event by `effects_calendar_event_idx`. Not checked against a database in this task: T-086 (and the K-05 v1.1 task's test) migrates it.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted (29; each names the rule `lifeChain`): the outbox lives `outbox-delivered`, `outbox-held-text-hours`, `outbox-dropped-stopped`, `outbox-stale-recomposed`, `outbox-fallback-email`, `outbox-safety-retry`, `outbox-4006-new-key`, `outbox-two-sends`, `outbox-email-copy` (02-contracts K-07's nine) and `outbox-4001-delivered-anyway`, `outbox-poll-failed-plain`, `outbox-claim-lapsed`, `outbox-withdrawn`, `outbox-waiting-chat-superseded`, `outbox-waiting-chat-withdrawn` (added, so every allowed move appears in a fixture), `outbox-retry-after-reclaimed` (added: the claim's `nextTryNotBefore` and `firstTryAt` kept across a re-claim); the effect lives `effect-charge`, `effect-charge-declined`, `effect-refund`, `effect-gave-up-outage`, `effect-calendar-write`, `effect-calendar-move`, `effect-calendar-delete`, `effect-linq-contact-add` (02-contracts' eight) and `effect-outage-runs-once`, `effect-outage-let-go` (added: the outage's two ends), `effect-reconciliation-refund` (added: reconciliation's refund of a charge with no agreed booking, S12-26); `provider-event-stripe`, `provider-event-calendar`. Refused (9, in `fixtures/invalid/`): `refuse-sms-channel` (an SMS port: DL-012), `refuse-part-without-key`, `refuse-effect-without-key` (02-contracts' three), and `refuse-sms-row-with-poll` (DL-031: text only), `refuse-row-move-not-allowed` (delivered → sending), `refuse-decline-retried` (declined → running), `refuse-waiting-with-claim` (a waiting row keeping its claim), `refuse-waiting-by-wrong-actor` (sending → waiting_chat by `markPart`), all refused by the schema; `refuse-4006-new-key-too-soon` passes the schema and is refused by `lifeChain` alone. Each refused fixture is an accepted one with one fault; fixed, it passes (checked by a throwaway probe, 2026-11-07, with 22 more wrong lives refused; and again for round 2, with 20 more wrong lives around the waiting states, the reconciliation actor and the claim's two times refused).

Names and values come only from fixture set v1's barber shop (`fixtures/v1/test-kit/shops/barber.json`: the $35 haircut and $20 fee, the $140 Groom's package with its $40 deposit, the $179 home grooming visit, the 24-hour cutoff) and the master's sample cast (Sam, Alex M., Riley, Avery, Maya, Ben T.; Dee W. and her $20 payment charged twice, S12-26; S12-09's booking; A7-03's poll), with K-04's and K-05's ids where the rows are theirs (`out-alex-booked-riley`, `out-sam-passon-evening`, `out-a7-03-alex` with `linq-msg-demo-0001` and `0002`). Phones are 555-01xx and email addresses `example.com`. Provider ids, card references, event types and error codes (`503`, `429`, `network`, `card_declined`, `poll.failed`) are placeholders: their real forms are K-11's, K-12's, K-14's and K-16's.

## Producers and consumers (02-contracts K-07)

- **Producers:** action-layer engineer: C-087 one commit per turn (rows at commit), C-088 to C-093 (final parts), C-109 effects runner (results); database engineer: C-151 core tables, C-152 data-access calls.
- **Consumers:** runtime engineer: C-124 outbox dispatcher, C-125 limit 8, C-126 channel fallback, C-127 two-part send, C-128 allowed formats, C-129 email rows, C-055 clock arming, C-174 to C-176 outage paths; action-layer engineer: C-101 payments and ledger, C-109 effects runner, C-112 reconciliation job; integrations engineer: C-206 Linq send, C-208 Linq contacts registrar, C-213 email, C-214 Stripe Connect, C-215 Stripe platform billing, C-216 Google calendar, C-217 Microsoft calendar; frontend engineer: C-194 team console (failed rows and effects); QA: C-148 end-to-end tests ("a webhook fixture in gives exactly one outbox row and one send": BP section 10, D-017), C-140 eval harness (a harmful wrong action is a committed effect: arch 08 line 447).
- **Contract test** (QA, its own task, T-086): `tests/contract/outbox-effects.v1.test.ts`: every state move in the fixtures is allowed and no other; the Linq, email, Stripe and calendar doubles accept every effect request; a repeated effect with one key runs once.
- **Frozen before it:** K-03 v1 (the plan inside a row, #46), K-04 v1 (#55), K-05 v1 (#61). **Frozen with it:** K-06 (#58), K-08 (F3).

## Defaults used (T-016)

1. **The plan's "composed" and "checked" are one stored state, `checked`:** K-05 v1 `writePlan` writes the plan and the final parts together after the checks, so no stored row is ever composed but unchecked. A passed-on row (step 7's last line) is `checked` with K-01's fixed line `passedOn` in its final parts, not a state of its own.
2. **A claim lapses 60 s after it is taken or renewed**, renewed at each part attempt; no source gives the time, so it mirrors the turn lease's 60 s (arch 01 line 61, DD). Proposed for QUESTIONS.md.
3. **"5 times in 10 minutes" is 5 tries in all** (arch 10 line 542), as arch 10 line 540 counts other jobs' 5 tries; the 10 minutes count from the run's first try.
4. **Q-15:** a quick reply is a reply in the same turn (`quick_reply`).
5. **CQ-04:** Linq's contacts/add is an effect row (`linq_contact_add`).
6. **CQ-11, answered by DL-031:** an `sms` row is Linq's SMS service in the same chat, text only; no SMS port (DL-012).
7. **Q-55, Q-56:** until Stripe test keys and the calendar OAuth apps exist, the Stripe and calendar effects run against the doubles (C-214 to C-217); nothing here depends on the vendor's live fields.
8. **A failure with no provider code** (Linq's poll failed: K-06 `poll-failed`) is recorded with the event's kind as its code (`poll.failed`), since K-05 v1 `markPart` failed requires one.
9. **A waiting row gives way, not sends:** when the mobile texts in, its waiting rows end `superseded`, moved by the commit of the turn that answers that first text, which writes the one message giving each booking as it stands; each names that row (`chatOpenAnswer`). Arch 06 line 313 and RULES 4.1b say one message replaces them and "Nothing sent before is sent again", but name no end state or actor.
10. **A waiting row whose booking or question closes is `withdrawn`** by the commit that closes it, as arch 06 line 313 withdraws a stale row whose booking or question has closed; the sources say nothing of waiting rows that close before the chat opens.
11. **Limit 8 finds the closed chat at send**, after the claim, like its other outcomes, so the waiting row's part is written `pending` at the claim and stays so; the move to `waiting_chat` lets the claim go (deletes the `outbox_claims` row) and clears `held_until`.
12. **Reconciliation writes only `stripe_refund`:** arch 10 line 550 refunds a charge with no agreed booking "at once"; a charge with no line gets a ledger line (no effect), and a line with no charge takes A6-32's path, whose one pay link waits for the owner's OK in a turn. The refund has `bookingId` null, since no agreed booking is behind the charge.
13. **The claim's `firstTryAt` is when the first part went to the provider**, not the first claim: a row limit 8 held overnight starts its 15 minutes when it is sent in the morning (arch 02 line 125 counts "15 minutes of tries").

## Open gaps

1. **Q-22** (which payment Rosfield's $2 comes from, and when): `rosfield_monthly_charge` is a kind, but its amount and whether a per-booking charge kind is needed wait on Q-22; no fixture shows it.
2. **K-05 v1.1 (T-071):** the calls that write `effects` and `provider_events` (claim effect rows, record an effect's result, record a provider event once), the claim's write, renewal and re-claim in `outbox_claims` (with its `first_try_at` and `next_try_not_before`, and `markPart` failed carrying the provider's Retry-After), the dispatcher's move to `failed` (`dispatcherGivesUp`), `markRow`'s `waitingChat` outcome, the commit's moves of `waiting_chat` rows to `superseded` or `withdrawn`, and the daily reconciliation's write of a refund effect with no turn (`reconciliationJob`) are K-05 v1.1's. Re-routing a failed row to the next way (C-126) and limit 8's reads (v1.2: whether a mobile's chat is open is a recipient's send state) come later.
3. **No link between a row and the rows that followed it:** K-04 v1 stores no column for `followUps` (next way, safety's other ways, the owner's number, the one message a waiting row gave way to); the event log holds it until a K-04 or K-05 minor version adds one.
4. **Closed (T-016 round 2): waiting for a chat to open** (arch 06 line 313, RULES 4.1b; MC C9) is the states `waiting_chat` and `superseded` and their three moves (defaults 9 to 11). What stays open: how the one message is composed from each booking as it stands is K-03's and the composer's; K-04 stores no link from a waiting row to it (gap 3).
5. **A provider refusal other than a decline or a network error** (an invalid request): no effect state; the sources name only network errors and declines. Proposed: a v1.1 state that goes to Rosie's team (S12-24).
6. **Photo and typing dots** (tested Nov 5, MC 8): K-03 v1 has no such format, so no part kind; a K-03 minor version first.
7. **The email row's subject, automated-assistant line, manage link and reply thread** (arch 07 line 371): K-03's final parts carry none; K-12 (F7) names them.
8. **Port terms (K-11, K-12, K-14, K-16):** `portRequest`, `payload`, provider ids, event types and error codes are placeholders until each port freezes; whether a 4001 or 4006 response carries the message id (the receipt finds the part by it) is K-11's spike.
9. **Q-55, Q-56:** Stripe and calendar accounts and keys (the CTO).
10. **Sealing:** a provider event's `payload` may name a person; whether it is sealed under a per-person key is K-04's erasure gap (CQ-26).
11. **K-04's seed email copy** (`seed-outbox-row`) holds its plan while `planned`; under K-05 v1 `writePlan` answers `alreadyPlanned` for such a row, so how a copy's final parts are written is K-05's to state (a minor version).
12. **S12-09's "all set"** (arch 02 line 125: "once texts work, one short 'all set'"): which rows get it after a failed row, and when texts count as working, is the dispatcher's (C-126); it is an ordinary new row here, with no follow-up kind of its own.
13. **`markPart` failed and the message id** (K-05 v1): a failure reported with the provider's message id has nowhere to record it in K-05 v1's `markPart` failed, though a 4001 or 4006 receipt later finds the part by it (gap 8); K-05 v1.1.
14. **When `ledgerLineId` is set:** the fixtures set it at the effect's result (the line written or matched); whether the commit writes it with the row, or reconciliation fills it in, is K-28's and C-101's.
15. **An owner's refund with no turn** (through a page or the Agent API): an effect row needs a turn or a job; whether such a refund runs as a turn (K-09) or needs an actor of its own is open.

## Change log

- v1, 2026-11-07 (T-016): first version, frozen: the row, part and effect states and their allowed moves, the retry rules and the named rule `lifeChain`, the email row, the effect rows and provider events, the table list for `effects`, `provider_events` and `outbox_claims`, the fixtures and their index, the freeze record and `frozen.json`.
- v1, 2026-11-07 (T-016 round 2, before merge, after the runtime and action-layer engineers' FAILs): the row states `waiting_chat` and `superseded` with their three moves and the follow-up `chatOpenAnswer` (arch 06 line 313; RULES 4.1b; MC C9); the effect actor `reconciliationJob`, writing only a `stripe_refund` as a job (arch 10 line 550; S12-26); the claim's `firstTryAt` and `nextTryNotBefore` and their `outbox_claims` columns (arch 02 line 125; arch 10 line 540); four accepted and two refused fixtures; open gap 4 closed, gaps 12 to 15 added.
