# inbound-event (K-06): the inbound event, gateway to handle actor

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-015. The freeze takes effect when T-015 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: runtime engineer, integrations engineer, frontend engineer, action-layer engineer.

Each reviewer checks its own side (02-contracts section 1): the runtime engineer the gateway's output and what the actor, the safety read on arrival, the batch, the lease, clock arming, the two-part send and the duplicate, late or edited text path read (C-044, C-045, C-046 to C-049, C-055, C-127, C-184); the integrations engineer that the Linq webhook events and the email inbound replies and delivery events can be parsed into it (C-207, C-213); the frontend engineer that the test-phone page's signed webhooks through the Linq double come out the same (C-205); the action-layer engineer that a poll vote reaches limit 3 as an exact yes and an edit after its turn committed as a new answer (C-083; S13-25 rules 20, 21). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `inbound-event.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/inbound-event/inbound-event.v1.schema.json`); its root is one event. **Named rule:** `inbound-event.rules.mjs` (`scrubbed`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/inbound-event.v1.test.ts` (QA, T-085). A change after the freeze is a new minor version file, `inbound-event.v1.1.schema.json`, with new fixtures (build prompt 6.4). The frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries; it does not cover the rules file (a release-engineer task already named by T-011).

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

## Producers and consumers (02-contracts K-06)

- **Producers:** integrations engineer: C-207 Linq webhook events, C-213 email (inbound replies and delivery events); runtime engineer: C-044 gateway Worker (verifies through the port, seals, drops known event ids), C-045 card and SSN scrub; frontend engineer: C-205 test-phone page (signed webhooks through the Linq double, C-211).
- **Consumers:** runtime engineer: C-046 handle actor, C-047 safety read on arrival, C-048 batch, C-049 turn lease, C-055 clock arming, C-127 two-part send, C-184 duplicate, late or edited text; action-layer engineer: C-083 limit 3 (a poll vote is an exact yes; an edit after its turn committed is a new answer: S13-25 rules 20, 21).
- **Contract test** (QA, its own task, T-085): `tests/contract/inbound-event.v1.test.ts`: the Linq and email doubles' parsed output and the test-phone page's webhook all match this schema and the rule; the actor accepts every valid fixture; a duplicate event id is dropped (`duplicate-event.json` against `text-imessage.json`). What the schema and the rule leave to code and that test: the order the actor takes events in (default 2); the drop of a known event id; that a `pollVote`'s ids are those of a poll part K-04 holds, and an unknown option id reads as typed words (S13-24 rule 6); that `scrubbed`'s counts match the tags.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted, the 16 02-contracts K-06 lists: `text-imessage.json`, `photo.json`, `reaction-from-customer.json`, `reaction-from-rosie.json`, `poll-vote.json`, `poll-vote-removed.json`, `edit-after-commit.json`, `delivered.json`, `sent.json`, `poll-failed.json`, `duplicate-event.json`, `email-reply-check-passed.json`, `email-reply-check-failed.json`, `text-with-card-number.json` (the tag in its place), `text-with-ssn.json`, `test-phone-page.json`. Refused, in `fixtures/invalid/`: `refuse-unscrubbed-card.json` and `refuse-no-event-id.json` (02-contracts K-06), and `refuse-unscrubbed-ssn.json` (added: the rule's other half). Each refused fixture is the accepted one it names with one fault.

Names and values come only from the master's sample cast (Sam, Alex, Avery; Lee's Barbershop and its $20 fee, fixture set v1's `barber.json`) and K-04's seed rows, so the ids line up across contracts: `evt-alex-0001` and `linq-chat-demo-alex` (seed-thread-messages), the read-back part `linq-msg-demo-0001` and A7-03's poll `linq-msg-demo-0002` with option `linq-opt-demo-2`, "Sat 2:00pm" (seed-outbox-row), the reply address `booking-alex-haircut@reply.example.com`. Phone numbers are the fictional 555-01xx range (+1 555 555 0100 to 0106); email addresses use `example.com`. The card number in the refused fixture is a public test number (4242 4242 4242 4242), and the Social Security number the commonly printed sample 123-45-6789; no real person's data (rule 9). Provider ids (`linq-msg-demo-*`, `linq-chat-demo-*`, `email-msg-demo-*`) are placeholders: their real forms are K-11's and K-12's.

## Defaults used (T-015)

1. **The tags and the Social Security number forms.** Arch 02 line 109 says "a tag" but not its words. Default: a card number becomes `[card number]` and a Social Security number `[SSN]`; a Social Security number is three digits, two, then four, separated by the same dash or space each time (123-45-6789, 123 45 6789). Nine bare digits are not matched, since no source says they are one. A source naming the tags or the forms changes the gateway and a new rule name, not this version's fields.
2. **Order.** The actor takes its events in `receivedAt` order, a tie by `eventId` compared as a whole (arch 02 line 113 counts the batch from each text's arrival; CQ-09: ids are compared, never parsed).
3. **The zone.** The gateway knows no zone, so `sentAt` is UTC only; C-114 pairs it with the zone dates resolve in (S13-03; CQ-05) to make K-02's `text.sentAt`.
4. **A sender check that did not run** is `failed`: an email counts only when the check passes (RULES 6.1).
5. **An email reply is kind `text`**, its files are attachments of any media type, and `photo` is Linq's photo message only. An incoming contact card stays an attachment nothing reads (Q-43).
6. **A receipt's handle** is the handle Rosie's part went to, so clock arming finds the handle's clock rows.
7. **`chatId`** is carried, though 02-contracts K-06 does not list it, because K-04's `threads.linq_chat_id` waits for "Linq reports it" and the inbound event is where Linq reports it (S1-01).

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
