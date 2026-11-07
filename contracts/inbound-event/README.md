# inbound-event (K-06): the inbound event, gateway to handle actor

**Status: v1 and v1.1, frozen** (`frozen.json`: `{"frozen": ["v1", "v1.1"]}`). v1 written and frozen by T-015. v1.1, a minor version that adds the wider card-number and Social Security number rule `scrubbedV1dot1` and its fixtures, written and frozen by T-1069; its freeze takes effect when T-1069 merges, and the merge waits for every review below (build prompt 6.2, 6.4, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: runtime engineer, integrations engineer, frontend engineer, action-layer engineer.

Frozen v1.1, 2026-11-07 (T-1069), reviews required: runtime engineer, integrations engineer, frontend engineer, action-layer engineer, and the security reviewer (personal data at the edge, build prompt 6.2). Each checks that v1.1 changes nothing on its side but the rule: the shape is v1's, so every v1 event is a v1.1 event; the runtime engineer that the scrub (C-045, T-1070) can make `scrubbedV1dot1` hold and that the tags and counts are v1's; the integrations and frontend engineers that their producers' bodies and subjects go through that scrub unchanged in shape (C-207, C-213, C-205); the action-layer engineer that nothing it reads changes (C-083); the security reviewer the rule itself (README "Named rule (v1.1)").

Each reviewer checks its own side (02-contracts section 1): the runtime engineer the gateway's output and what the actor, the safety read on arrival, the batch, the lease, clock arming, the two-part send and the duplicate, late or edited text path read (C-044, C-045, C-046 to C-049, C-055, C-127, C-184); the integrations engineer that the Linq webhook events and the email inbound replies and delivery events can be parsed into it (C-207, C-213); the frontend engineer that the test-phone page's signed webhooks through the Linq double come out the same (C-205); the action-layer engineer that a poll vote reaches limit 3 as an exact yes and an edit after its turn committed as a new answer (C-083; S13-25 rules 20, 21). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `inbound-event.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/inbound-event/inbound-event.v1.schema.json`); its root is one event. **Named rule:** `inbound-event.rules.mjs` (`scrubbed`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/inbound-event.v1.test.ts` (QA, T-085). A change after the freeze is a new minor version file, `inbound-event.v1.1.schema.json`, with new fixtures (build prompt 6.4). The frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries; it does not cover the rules file (a release-engineer task already named by T-011).

**v1.1 (T-1069):** `inbound-event.v1.1.schema.json` (`$id` `https://rosie.invalid/contracts/inbound-event/inbound-event.v1.1.schema.json`) is v1's shape exactly: it refers to `inbound-event.v1.schema.json` and adds no field, so `npm run contracts:check` also checks every accepted v1 fixture against it. **Named rule (v1.1):** `scrubbedV1dot1`, added to `inbound-event.rules.mjs` beside `scrubbed`, which is unchanged (the rule name spells v1.1 in the letters the fixtures index allows: `^[A-Za-z][A-Za-z0-9]*$`). **Contract test:** `tests/contract/inbound-event.v1.1.test.ts` (QA, its own task). The guard now also fails an edit to v1.1's schema, its fixtures or their index entries.

## What it defines

The one shape every inbound message, reaction, poll vote, edit and delivery receipt takes after the gateway (C-044) has checked the signature, scrubbed card numbers and Social Security numbers, and dropped known event ids (arch 02 line 109). The provider's wire format stays inside the Linq and email adapters (K-11, K-12; 02-contracts section 5): these are Rosie's names, and a bad signature never becomes an event (401, dropped). Stripe and calendar events go to PostgreSQL, not here (arch 02 line 109; K-05 v1.1, K-07).

| Field             | What                                                                                                                                | Source                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `eventId`         | The provider's event id: the dedupe key, and what a turn id hashes                                                                  | arch 02 line 109; arch 11 line 584; arch 01 line 59        |
| `provider`        | `linq` or `email`                                                                                                                   | 02-contracts K-06, K-11, K-12                              |
| `handle`          | `{kind, address}`: the phone in E.164 or the email in lower case, as K-04's `handles.address` writes it                             | arch 01 line 55; K-04 handles                              |
| `service`         | `imessage`, `rcs`, `sms` (Linq's) or `email`; null only on a Linq receipt that does not report it                                   | 02-contracts K-06; arch 07 line 365; Q-33; DL-012, DL-031  |
| `kind`            | `text`, `photo`, `reaction`, `pollVote`, `voteRemoved`, `edit`, `delivered`, `sent`, `failed`                                       | 02-contracts K-06; arch 12 line 610                        |
| `messageId`       | For a text or photo, the provider's id of the message, so reactions, edits and threaded replies can name it; null otherwise         | arch 07 lines 389, 391; arch 11 line 584                   |
| `chatId`          | Linq's chat id when Linq reports it (fills K-04 `threads.linq_chat_id`); null for email                                             | S1-01; K-04 threads                                        |
| `sentAt`          | The sender's send time, UTC; null on a receipt                                                                                      | arch 06 line 309 (limit 6)                                 |
| `receivedAt`      | When the gateway received it, UTC                                                                                                   | 02-contracts K-06; arch 02 line 113; Q-41                  |
| `body`            | The words after the scrub (text; photo caption or ""; an edit's new words; an email's text); null for reactions, votes and receipts | arch 02 line 109                                           |
| `scrubbed`        | `{cards, ssns}`: how many were swapped for their tags                                                                               | arch 02 line 109; arch 10 line 516                         |
| `attachments`     | K-02's `attachment` (`attachmentId`, `mediaType`), reused by `$ref`; K-13 turns the id into a file reference                        | 02-contracts K-06 and K-02                                 |
| `threadedReplyTo` | The message a threaded reply sits under                                                                                             | 02-contracts K-06; arch 07 line 389                        |
| `poll`            | `{pollId, optionId, optionWords}` for a vote or a vote removed                                                                      | arch 07 line 379; arch 03 line 187; arch 12 line 610       |
| `reaction`        | `{reaction, onMessageId}` for a reaction                                                                                            | arch 03 line 187; arch 07 line 391                         |
| `edit`            | `{messageId}` of the message edited                                                                                                 | arch 11 line 584; arch 12 line 610                         |
| `status`          | For a receipt: `{messageId, at, failure}`, the part Rosie sent, when, and for `failed` the provider's `code` (or null) and `reason` | arch 02 lines 125, 127; arch 07 line 367; arch 12 line 610 |
| `fromRosie`       | Linq's is_from_me: Rosie's own reactions start no turn; always false for email                                                      | arch 07 line 391                                           |
| `email`           | For an email reply: `{replyAddress, subject, senderCheck}` (`passed` or `failed`)                                                   | RULES 4.1, 6.1; 02-contracts K-12                          |
| `traceId`         | The trace id opened at receipt (K-08 gives its form; an opaque id until then)                                                       | 02-contracts K-06; arch 10 line 548; CQ-06                 |

Every field's `description` names its source (02-contracts section 2 item 4). Line numbers "arch NN line N" are those of `scratch/text/architecture.txt`. Every field is required, with `null` where a kind does not use it; `dependentSchemas` on `provider` and `kind` say which kind fills which field, so a vote without its poll, a photo without an image, a delivered receipt with a failure, an email from a phone or an email reply without its sender check is refused.

### Routing (arch 02 lines 113, 127; arch 07 line 367)

- **To the handle's actor, in order:** `text`, `photo`, `reaction`, `pollVote`, `voteRemoved`, `edit`. Each raw text goes to the safety read on arrival, before batching (arch 02 line 111). A reaction with `fromRosie` true starts no turn (arch 07 line 391). An edit or a vote change after its turn committed is a new answer (arch 11 line 584; C-184).
- **To the dispatcher and to clock arming:** `delivered`, `sent`, `failed`. The question's clock row arms at the first delivery receipt: `delivered` on iMessage, RCS and email, `sent` on SMS (arch 02 line 127). The second send waits for the words' receipt (arch 07 line 367). A failure starts the next way after 15 minutes (arch 02 line 125); a failed poll goes again plain, options typed (arch 07 line 367).

### How K-02's context bundle reads it

K-06 keeps K-02's names where the meaning is the same, so the context bundle (C-114) copies rather than renames:

| K-02 `text`   | From K-06                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `eventId`     | `eventId`                                                                                                        |
| `kind`        | `text` and `photo` → `text`; `pollVote` → `pollVote`; `reaction` → `tapback`                                     |
| `words`       | `body`; for a vote, `poll.optionWords` (K-02: "the option's words as sent"); for a reaction, `reaction.reaction` |
| `sentAt`      | `{utc: sentAt, zone}`, the zone added by C-114 (default 3)                                                       |
| `attachments` | `attachments` (the same `$defs/attachment`)                                                                      |
| `poll`        | `{pollId, optionId}` from `poll`                                                                                 |
| `tapback`     | `reaction` as is (`reaction`, `onMessageId`)                                                                     |

`voteRemoved`, `edit` and the receipts have no K-02 text kind: C-184 decides what a vote taken back or an edit does (arch 11 line 584), and receipts never reach decide.

## Named rule: `scrubbed`

Card numbers (13 to 19 digits, Luhn) and Social Security numbers are swapped for a tag before any write (arch 02 line 109), so no event after the gateway holds one. One JSON Schema cannot run the Luhn check, so `inbound-event.rules.mjs` states it by name: the body and an email's subject hold no run of 13 to 19 digits (single spaces or dashes allowed between them) that passes the Luhn check, and no Social Security number in a form default 1 names. Every fixture names the rule in `fixtures/index.json`; the accepted ones pass it, and `refuse-unscrubbed-card.json` and `refuse-unscrubbed-ssn.json` pass the schema and are refused by the rule alone (`contracts/scripts/check-fixtures.mjs`). At runtime the gateway's scrub (C-044, C-045) makes it hold; the rule's problem lines never print the number they found.

## Named rule (v1.1): `scrubbedV1dot1`

**Why:** T-242's security review (`ops/cards/T-242.md`) found three ways a card number passes v1's whole-run rule and so is stored untagged: (1) a card next to other digits in the same run ("4111111111111111 123", a card then its security code with one space, is one 19-digit run that fails the Luhn check); (2) a card typed with two or more spaces or dashes between groups; (3) a card in non-ASCII digits. The same widenings apply to a Social Security number. The tags (`[card number]`, `[SSN]`), the fields and `scrubbed`'s counts are v1's.

**What it states.** The body and an email's subject hold no card number and no Social Security number, read this way (sources: arch 02 line 109 "Before any write it swaps card numbers (13 to 19 digits, Luhn) and Social Security numbers for a tag"; arch 10 line 516 "Cards and SSNs scrubbed at the edge"; master S12-30 "Never kept from a text: card numbers, full Social Security numbers", and S13-05; T-242's security review):

1. **Digits of any script** are first read as the ASCII digit they stand for: every Unicode decimal digit (general category Nd: fullwidth, Arabic-Indic, Devanagari, mathematical and the rest). Superscripts, fractions and other number signs that are not Nd are not digits. (`toAsciiDigits`.)
2. **A digit run** is digits with any run of separators between two of them; a separator is a space of any kind (Unicode Zs, so the no-break and ideographic spaces too), a tab, or a dash of any kind (Unicode Pd, so the hyphen-minus, the en and em dashes and the fullwidth hyphen too). Anything else (a letter, a dot, a slash, a comma, a line break) ends a run.
3. **A card number** is any 13 to 19 digit window of a run's digits that passes the Luhn check, wherever it sits in the run, so other digits before or after it in the same run do not hide it. (`holdsCardWindow`, `cardRunsInV1dot1`.)
4. **A Social Security number** is three, two and four digits with a run of one or more separators between the groups and no digit right before or after it (123-45-6789, 123 45 6789, 123-45 6789, 123 - 45 - 6789, and the same in any script). Nine bare digits are still not one (default 1, kept: see "Defaults used (T-1069, v1.1)"). (`hasSsnV1dot1`.)

**It only widens.** Whatever `scrubbed` refuses, `scrubbedV1dot1` refuses: a v1 run is part of a v1.1 run, and its digits are one window of it; v1's two Social Security forms are two of v1.1's. Every accepted v1 fixture passes `scrubbedV1dot1`, and both v1 fixtures `scrubbed` refuses are refused by it (checked when T-1069 was written; the v1.1 contract test holds it).

**Where the tag goes** (the v1.1 fixtures' convention, for the scrub, T-1070): from the left, the first window that passes, the longest at its start, is swapped for `[card number]` with the separators inside it; digits outside it stay ("[card number] 123"); this repeats until no window passes, then Social Security numbers are swapped. The rule holds for any placement that leaves no window; the convention makes the fixtures' tagged bodies the one right answer.

**What it costs.** A long digit run is more often read as a card: a run of 20 digits has 35 windows of 13 to 19 digits, so most such runs hold one that passes the Luhn check by chance, and the scrub swaps it. Arch 02 line 109 puts the scrub before any write, so a number wrongly tagged is lost words, while a card wrongly kept is kept for good; v1.1 takes the first. The rule's problem lines give a count of digits, never the digits.

## Producers and consumers (02-contracts K-06)

- **Producers:** integrations engineer: C-207 Linq webhook events, C-213 email (inbound replies and delivery events); runtime engineer: C-044 gateway Worker (verifies through the port, seals, drops known event ids), C-045 card and SSN scrub; frontend engineer: C-205 test-phone page (signed webhooks through the Linq double, C-211).
- **Consumers:** runtime engineer: C-046 handle actor, C-047 safety read on arrival, C-048 batch, C-049 turn lease, C-055 clock arming, C-127 two-part send, C-184 duplicate, late or edited text; action-layer engineer: C-083 limit 3 (a poll vote is an exact yes; an edit after its turn committed is a new answer: S13-25 rules 20, 21).
- **Contract test** (QA, its own task, T-085): `tests/contract/inbound-event.v1.test.ts`: the Linq and email doubles' parsed output and the test-phone page's webhook all match this schema and the rule; the actor accepts every valid fixture; a duplicate event id is dropped (`duplicate-event.json` against `text-imessage.json`). What the schema and the rule leave to code and that test: the order the actor takes events in (default 2); the drop of a known event id; that a `pollVote`'s ids are those of a poll part K-04 holds, and an unknown option id reads as typed words (S13-24 rule 6); that `scrubbed`'s counts match the tags.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted, the 16 02-contracts K-06 lists: `text-imessage.json`, `photo.json`, `reaction-from-customer.json`, `reaction-from-rosie.json`, `poll-vote.json`, `poll-vote-removed.json`, `edit-after-commit.json`, `delivered.json`, `sent.json`, `poll-failed.json`, `duplicate-event.json`, `email-reply-check-passed.json`, `email-reply-check-failed.json`, `text-with-card-number.json` (the tag in its place), `text-with-ssn.json`, `test-phone-page.json`. Refused, in `fixtures/invalid/`: `refuse-unscrubbed-card.json` and `refuse-no-event-id.json` (02-contracts K-06), and `refuse-unscrubbed-ssn.json` (added: the rule's other half). Each refused fixture is the accepted one it names with one fault.

Names and values come only from the master's sample cast (Sam, Alex, Avery; Lee's Barbershop and its $20 fee, fixture set v1's `barber.json`) and K-04's seed rows, so the ids line up across contracts: `evt-alex-0001` and `linq-chat-demo-alex` (seed-thread-messages), the read-back part `linq-msg-demo-0001` and A7-03's poll `linq-msg-demo-0002` with option `linq-opt-demo-2`, "Sat 2:00pm" (seed-outbox-row), the reply address `booking-alex-haircut@reply.example.com`. Phone numbers are the fictional 555-01xx range (+1 555 555 0100 to 0106); email addresses use `example.com`. The card number in the refused fixture is a public test number (4242 4242 4242 4242), and the Social Security number the commonly printed sample 123-45-6789; no real person's data (rule 9). Provider ids (`linq-msg-demo-*`, `linq-chat-demo-*`, `email-msg-demo-*`) are placeholders: their real forms are K-11's and K-12's.

**v1.1 (T-1069)**, each listed for v1.1 and the rule `scrubbedV1dot1`, one pair per case: the refused one (in `fixtures/invalid/`) passes the schema and v1's `scrubbed` and is refused by `scrubbedV1dot1` alone; the accepted one is the same event with the tag in its place, by the convention above.

| Case                           | Refused raw                                    | Accepted tagged                        | Body (raw)                                                          |
| ------------------------------ | ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| 1. A card next to other digits | `refuse-unscrubbed-card-next-to-digits.json`   | `text-with-card-next-to-digits.json`   | `My card is 4111111111111111 123, ...`; tagged, the tag then ` 123` |
| 2. A run of spaces             | `refuse-unscrubbed-card-wide-spaces.json`      | `text-with-card-wide-spaces.json`      | `My card is 4242  4242  4242  4242, ...`, two spaces between groups |
| 3. Non-ASCII digits            | `refuse-unscrubbed-card-non-ascii-digits.json` | `text-with-card-non-ascii-digits.json` | the same card in fullwidth digits (U+FF10 to U+FF19)                |
| 4. A wider SSN form            | `refuse-unscrubbed-ssn-wide-form.json`         | `text-with-ssn-wide-form.json`         | `Do you need my social? It's 123 - 45 - 6789`                       |

And `text-with-nine-bare-digits.json` (accepted): "My booking code is 123456789" is kept as it is, which records the bare nine-digit decision. Test values only (rule 9): the public test cards 4111 1111 1111 1111 (Visa) and 4242 4242 4242 4242 (Stripe), and the printed sample number 123-45-6789; the cast and ids are v1's (Alex, Avery; `evt-alex-0016` to `0018`, `evt-avery-0004`, `0005`).

## Defaults used (T-015)

1. **The tags and the Social Security number forms.** Arch 02 line 109 says "a tag" but not its words. Default: a card number becomes `[card number]` and a Social Security number `[SSN]`; a Social Security number is three digits, two, then four, separated by the same dash or space each time (123-45-6789, 123 45 6789). Nine bare digits are not matched, since no source says they are one. A source naming the tags or the forms changes the gateway and a new rule name, not this version's fields.
2. **Order.** The actor takes its events in `receivedAt` order, a tie by `eventId` compared as a whole (arch 02 line 113 counts the batch from each text's arrival; CQ-09: ids are compared, never parsed).
3. **The zone.** The gateway knows no zone, so `sentAt` is UTC only; C-114 pairs it with the zone dates resolve in (S13-03; CQ-05) to make K-02's `text.sentAt`.
4. **A sender check that did not run** is `failed`: an email counts only when the check passes (RULES 6.1).
5. **An email reply is kind `text`**, its files are attachments of any media type, and `photo` is Linq's photo message only. An incoming contact card stays an attachment nothing reads (Q-43).
6. **A receipt's handle** is the handle Rosie's part went to, so clock arming finds the handle's clock rows.
7. **`chatId`** is carried, though 02-contracts K-06 does not list it, because K-04's `threads.linq_chat_id` waits for "Linq reports it" and the inbound event is where Linq reports it (S1-01).

## Defaults used (T-1069, v1.1)

1. **Nine bare digits stay unmatched (default 1, kept).** No source names the forms of a Social Security number: arch 02 line 109 says "Social Security numbers", arch 10 line 516 "SSNs", and master S12-30 and S13-05 "full Social Security numbers". Nine bare digits are also a booking or order code, a ZIP+4 typed without its dash, or a phone number short a digit, and no source says to give those up. So v1.1 widens the two forms default 1 names (separators and scripts) and leaves nine bare digits as words; `text-with-nine-bare-digits.json` records it. Open question below; if the answer is yes, it is a new minor version with a new rule name.
2. **Spaces and dashes are by Unicode category** (Zs, a tab, Pd): the card says "any run of spaces or dashes" and names no list. A line break is not a space here, so numbers on separate lines are separate runs.
3. **Digits are Unicode's decimal digits (Nd)**, read by their place in their set of ten (Unicode encodes each set as ten consecutive code points, 0 to 9); the card says "non-ASCII digits normalised" and names no list.
4. **Where the tag goes** is the fixtures' convention in "Named rule (v1.1)" (leftmost window, longest at its start); arch 02 line 109 says only "swaps ... for a tag".

## Open gaps (v1.1)

- **Nine bare digits as a Social Security number** (for `QUESTIONS.md`, default 1 in use): should "123456789" be swapped for `[SSN]`? A yes costs the same lost words as a 20-digit run does for cards.
- **Other characters between digits** end a run: a dot, a slash, a comma or a zero-width character between groups ("4242.4242.4242.4242") is not read as one card. No source or review names them; a later minor version can add them.
- **The digits next to a card stay** ("[card number] 123"): a security code or an expiry date is not a card number by arch 02 line 109, and no source asks for it to be swapped. Master S13-05 keeps "full card numbers" out; whether a security code counts is not said.
- **The rules file is not under the frozen-contract guard** (unchanged since v1): `scrubbedV1dot1` is frozen by this README and the rules file's header ("Rules are only ever added"), not by the guard, until the release-engineer task named by T-011 covers `*.rules.mjs`.
- **The fixture check runs a fixture's own rule only:** that every accepted v1 fixture also passes `scrubbedV1dot1` is held by the v1.1 contract test (QA), not by `npm run contracts:check`, which checks it against the v1.1 schema.

## Open gaps

- **The vendor mapping (K-11, F6; K-12, F7):** which Linq webhook field and which Resend field fills each of these is the ports' spikes' to find (02-contracts K-11 and K-12 "Spike before freeze"), never guessed here: the event id, message, chat and option ids and their forms; whether a receipt reports the service (hence `service` may be null on a Linq receipt) and the recipient; Linq's reaction names (kept a plain string, as in K-02); the poll.failed codes and the bounce codes (`failure.code` a plain string or null); whether poll.updated carries the option's words; whether Linq reports is_from_me on events other than reactions. A port that cannot fill a required field is a NEED for the architect, answered by a minor version.
- **Q-52** (the five events added at the webhook move): until message.sent, message.edited, poll.updated, poll.vote.removed and poll.failed are subscribed, `sent`, `edit`, `pollVote`, `voteRemoved` and poll failures do not arrive; polls also carry their options typed, so a typed answer arrives as `text` (arch 07 line 379).
- **Q-43** (incoming contact cards): no contact kind in v1; default 5.
- **CQ-11, answered by DL-031:** a text Linq reports as SMS or RCS is an ordinary event with that `service`; the reply goes back through Linq in that chat, text only. No SMS provider (DL-012).
- **K-13 (F8):** `attachments` keeps K-02's id and media type; the file reference comes with K-13 and K-02 v1.1.
- **K-08 (F3):** `traceId` is an opaque id until K-08 gives its form; a turn carries the first text's trace id and lists the others (CQ-06).
- **New (no provider message id on K-04's messages in):** K-04's `messages` holds a message in by its `event_id` only, so a later reaction, edit or threaded reply, which names the provider's `messageId`, is matched to its message by the actor (its inbox keeps both ids). If the database must match them, it is a K-04 minor version (a nullable `provider_message_id` on `messages`).
- **New (K-02 has no edit or vote-removed kind):** decide never sees a `voteRemoved` or an `edit` as such; C-184 turns an edit after commit into a new answer. If decide must read either, that is a K-02 minor version.

## Keywords beyond ADR-005's list

`dependentSchemas` with `if`/`then`, `minItems`, `maxItems` and `minimum`, as K-02 uses them; nothing here is model-facing, so the structured-outputs subset does not apply. The consistency checks sit in `dependentSchemas` rather than `allOf`, so json-schema-to-typescript keeps the types (T-010's finding); the generated types are wider than the schema there.

## Change log

- v1, 2026-11-07 (T-015): first version, frozen: the event and its nine kinds, the named rule `scrubbed`, the fixtures and their index, the freeze record and `frozen.json`.
- v1.1, 2026-11-07 (T-1069): a minor version, additive, frozen at merge. Why: T-242's security review (a card next to other digits, a run of spaces or dashes, non-ASCII digits pass v1's rule untagged). What: `inbound-event.v1.1.schema.json` (v1's shape by reference, no new field); the named rule `scrubbedV1dot1` in `inbound-event.rules.mjs` beside the unchanged `scrubbed`; nine v1.1 fixtures and their index entries (four refused raw, four accepted tagged, one bare nine-digit record); "v1.1" in `frozen.json`; this README's v1.1 sections. No v1 file, fixture or index entry changed. Consumers: as v1 (runtime, integrations, frontend and action-layer engineers); the scrub adopts it in T-1070.
