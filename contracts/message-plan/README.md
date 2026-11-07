# message-plan (K-03): the composer's message plan and slots

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Written and frozen by T-012. The freeze takes effect when T-012 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: AI engineer, action-layer engineer, runtime engineer, database engineer, playbook engineer, QA and eval engineer.

Each reviewer checks its own side (02-contracts section 1): the AI engineer the composer's input and the plan it returns, inside the structured-outputs subset (C-118, C-119); the action-layer engineer the slot vocabulary, the final parts and the check result (C-088 slot filler, C-089 fixed-line inserter, C-090 situation tag, C-091 claim check, C-092 message checks, C-093 rewrite and fallback path); the runtime engineer the formats, the two sends and the email row (C-124, C-127, C-128, C-129); the database engineer the plan an outbox row stores (`rowPlan`, for K-04 and K-07); the playbook engineer the slot names the compiler writes and the proposed CQ-17 names (C-062, C-064); QA and eval the fixtures and the check cases (C-140; the contract test T-082). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `message-plan.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/message-plan/message-plan.v1.schema.json`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/message-plan.v1.test.ts` (QA, T-082). A change after the freeze is a new minor version file, `message-plan.v1.1.schema.json`, with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries.

## What it defines

Step 7 of a turn: "The composer returns a message plan (section 07). Code inserts its options and fixed lines and fills its slots, then the claim check runs limit 7 and the message checks" (arch 02 line 123). Each outbox row gets its own composer call, in parallel, and stores the plan it gets back (arch 07 lines 347, 397).

| Document                                                                                                                                                                                                                     | Where in the schema                              | Source                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| The composer's input, one per outbox row: conversation, master text, facts, audience, language, channel, situation, allowed formats, allowed links, then inbound; plus the options, page types and open questions code lists | `$defs/composeInput`                             | arch 07 lines 365, 389, 397; 02-contracts K-03                          |
| The plan, the composer's structured output: formats, lines with slots (first, fact, action), at most one question with option ids, one page type or none, a threaded-reply target                                            | `$defs/plan` (model-facing)                      | arch 01 line 97; arch 07 lines 353, 365 to 393, 397; 02-contracts K-03  |
| The plan as the outbox row stores it; an email copy reuses its text row's plan                                                                                                                                               | `$defs/rowPlan`                                  | arch 07 lines 347, 371, 397; 02-contracts K-04, K-07                    |
| The slot vocabulary: each slot's kind, value type, what it reads, audience, sensitive form, who fills it, an example and its source                                                                                          | `$defs/slotVocabulary`, `slot`, `slotName`       | record.slots; SPEC-master 5h; arch 07 line 409; arch 12 line 592; MC C9 |
| The final parts after code: at most two sends (the words with any calendar file, then one poll or card), the fixed lines added, the slot values filled                                                                       | `$defs/finalParts`, `send`                       | arch 02 line 123; arch 07 lines 361, 367, 379 to 383                    |
| The check result: each check's pass or failure, and what happens next (send, one rewrite, the fallback text, passed on)                                                                                                      | `$defs/checkResult`, `checkOutcome`, `checkName` | arch 02 line 123; arch 07 lines 405 to 417                              |

The root is any one of the six documents (an `anyOf` of their `$ref`s), so the type generator writes a type for each (it writes types only for what the root reaches); every fixture names its definition. Every field's `description` names its source (02-contracts section 2 item 4).

### The plan is the model's output

- **It stays inside the structured-outputs subset** (contracts/README.md convention 7; 02-contracts section 2 item 7). `$defs/plan` and the definitions it refers to (`format`, `line`, `lineRole`, `question`, `slottedText`) use no other file, no recursion, no number, string-length or array limits beyond `minItems: 1`, no `if`, `not`, `allOf` or `dependentSchemas`, only scalar enums, and `additionalProperties: false` on every object. Every property is required, so it has 0 optional properties (the limit is 24 per request); `question`, `pageType` and `threadReplyTo` are its 3 unions (the limit is 16). It is static: the slot list and the formats are fixed enums, never built per turn. Checked on 2026-11-07 by a throwaway script against T-360's reading of Anthropic's structured-outputs documentation; T-011's subset lint adds the plan to its list in a follow-up, and a spike confirms the subset on the models once Q-20 lands (DL-021, DL-026).
- **What goes to the model is `$defs/plan` alone**, bundled with the four definitions it uses, never the root: the other documents use `dependentSchemas`, `maxItems` and other files, which the subset refuses, and are code's.
- **Slots are written in the text** as the master writes them (`{{name}}`, `{{name:example}}`, `{{name:example|other words}}`: SPEC-master 5h, overlay-core.js SLOT_RE line 1284). The `slottedText` pattern accepts a `{{` only as the start of a slot from the vocabulary, so the plan cannot name `{{hold}}` or any slot outside the list; it uses no lookaround, which the subset leaves out.
- **Order:** the lines in order (one first line, up to four fact lines, one action line with its link), then the question. With a poll, the question goes as text first and the options go in the poll (arch 07 line 379). With a link card, the action line's link is also the card's link, the second send (arch 07 line 381). With options and a page, the link ends the words, then the poll goes (arch 07 line 365).
- **Formats** are a closed list: `text`, `poll`, `linkCard`, `calendarFile`, `tapback` (arch 07 lines 373 to 393). Bold text decorations and read receipts are not formats in v1: MC 8 keeps every format not yet tested off until its test, and the Nov 5 iPhone tests covered neither. Typing dots are code's (arch 07 line 385); a threaded reply is `threadReplyTo` (arch 07 line 389); contact cards are never a format (arch 07 line 393; Q-43). A plan with any other format is refused (`refuse-format-not-allowed`).
- **What the schema does not check, and code does:** a plan format outside the input's `allowedFormats`, a page type outside the input's `pageTypes`, an option id outside the input's `options`, a link slot outside `allowedLinks`, a thread target outside `openQuestions`, and the combination rules (at most two sends; a tapback alone; 2 to 5 poll options; at most 5 buttons). These rules join two documents, the input and the plan, so they are the message checks' and the allowed-format rules' (C-092, C-128): a plan outside the list goes as text alone and is logged (arch 07 line 365), shown as the non-blocking `format` check in a check result.

### The slot vocabulary (`fixtures/slots.json`)

52 slots. `slotName` lists them; the plan's `slottedText` pattern and `slots.json` hold the same 52 names (checked 2026-11-07; the contract test checks it again).

| Kind                    | Slots                                                                                                                                                                    | Source                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| record (16)             | pay.asks, pay.price, pay.took, pay.left, pay.cancel, pay.late, pay.noshow, pay.back, pay.after, pay.staff, pay.failed, clock.pay, two.count, reach.way, reach.to, who.ok | master-A.json and master-B.json `record.slots`                |
| autofill (8)            | alex.staff, name.staff, svc.intext, arrive, window, cutoff, day, keep                                                                                                    | SPEC-master 5h; overlay-core.js SLOTS line 1285               |
| amount (6)              | price, fee, deposit, rest, paid, name                                                                                                                                    | SPEC-master 5h; overlay-core.js AMOUNTS line 981              |
| ledger (5)              | paidnow, due, back, later, backlate                                                                                                                                      | overlay-core.js LEDGER_AMOUNTS line 597, AMOUNT_RE line 983   |
| send (2)                | today, tomorrow                                                                                                                                                          | arch 07 line 409: "slots filled at send"                      |
| link (4), proposed      | link.secure, link.pay, link.chat, link.chatqr                                                                                                                            | 02-contracts K-03 "links"; MC C9; RULES 4.1b; CQ-17           |
| compiler (11), proposed | biz.name, biz.phone, owner.name, pro.name, visit.time, visit.place, visit.code, ask.by, change.when, change.price, relay.quote                                           | arch 12 line 592; arch 07 lines 359, 409; A6-14; MC C6; CQ-17 |

- **hold is refused** since D66 (SPEC-master D66 amendments, #3 and the 5h amendment: a `{{hold}}` slot is an error), so K-01's 36-name list less hold is 35 names, all here. A bare `{{keep}}` is the ledger amount kept; `{{keep:words}}` is the auto-fill slot (overlay-core.js line 983).
- **Audience.** For each slot the master uses in a message, the readers the master sends it to (counted on 2026-11-07 over the 1,480 message lines of master-A.json and master-B.json in `scratch/fixture-v1-copy`); for a slot no message uses yet, its means line, and for an amount RULES 4.5 (an amount may be in a text; money details beyond an amount may not). Limit 7 applies it at the claim check (arch 06 line 311; C-091): a secure-page-only field reads "Read it on the secure page", and one the reader may never see is cut with its sentence.
- **Sensitive form** (RULES 4.6; S13-22; SPEC-master 5h; D41): `initials` for alex.staff and name.staff; `emptyOrAlternate` for svc.intext and name (nothing, with one " · " or ", " next to it, or the words after "|"); `displayName` for biz.name; `asIs` for the rest.
- **Proposed names (CQ-17).** No source names the slots the compiler makes from the sample cast's names, dates, times, prices and places (arch 12 line 592), nor the link slots, nor the relay's quote slot (arch 07 line 359 has relays "quote them in a code-filled slot"). Each is marked `status: "proposedCQ17"`, and its `means` says "Proposed name (CQ-17)". K-01 v1's closed slot list (`/$defs/messagesWithUnknownSlot`) does not hold them: a bundle message naming one fails `unknown-slot` until a K-01 v1.1 adds them, in its own task. The compiler's mapping rules (which sample value becomes which slot) are the playbook engineer's (C-062).

### Final parts and the check result

- **Final parts** are what code sends: options inserted word for word, fixed lines added (by K-01 `fixedLine` id; arch 07 line 361; the opt-out line's place per Q-30), slots filled; at most two sends, the words with any calendar file and then one poll or card (arch 07 line 367). The schema holds a poll to 2 to 5 options with no words and no file, and a link card to its link. `slotValues` are the code-supplied facts the Values check matches every number, time, date, price, code, phone, link and name against (arch 07 line 409).
- **The check result** names the attempt (`composed`, `rewrite`, `fallback`), the final parts checked, each check's result with what failed, and the outcome (arch 02 line 123; arch 07 line 417): `send`; `rewrite` on a first miss; `sendAndLog` when only shape, length and reading or format still miss after the rewrite; `fallback` when the rewrite misses a blocking check (fixed lines, values, one question, never in a message); `passedOn` when the fallback text misses too, with the question withdrawn and the team paged (the schema requires both exactly then). That each check appears once, and that each `check-*` fixture's outcome follows from its checked parts, are QA's contract-test checks.

## Producers and consumers (02-contracts K-03)

- **Producers:** AI engineer: C-118 composer, C-119 composer prompt and style rules; action-layer engineer: C-090 situation tag, C-091 claim check (which facts a reader may see), served through the Tool API's compose input (K-09); runtime engineer: C-128 allowed formats and format rules.
- **Consumers:** action-layer engineer: C-088 slot filler, C-089 fixed-line inserter, C-091 claim check, C-092 message checks, C-093 rewrite and fallback path; runtime engineer: C-124 outbox dispatcher, C-127 two-part send, C-129 email rows; database engineer: the outbox row stores the plan (K-04, K-07); playbook engineer: C-062 sample-value slotting and C-064 element text forms (slot names); QA: C-140 eval harness.
- **Contract test** (QA, its own task, T-082): `tests/contract/message-plan.v1.test.ts`, as 02-contracts K-03 describes: every fixture against its definition; every slot in K-01's sample bundles is in `slots.json`; the message checks turn each `check-*` fixture into its stated outcome. What the schema cannot check and the test must: `slotName`, the `slottedText` pattern and `slots.json` name the same slots, each once; each check once per check result; a plan's formats, page type, option ids, links and thread target are the input's (C-092, C-128).
- The prompt texts are the AI engineer's (C-119) and ship inside the bundle (K-01 `prompts`).

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted: `slots.json` (`slotVocabulary`); `input-s1-02.json` (`composeInput`); `plan-s1-02.json`, `plan-block-readback-poll.json`, `plan-confirmation-a6-14.json`, `plan-relay-private-a7-12.json`, `plan-sensitive.json`, `plan-tapback-thanks.json` (`plan`); `plan-email-copy.json` (`rowPlan`); `final-two-sends.json` (`finalParts`); `check-pass.json`, `check-two-questions.json`, `check-raw-price.json`, `check-emoji.json`, `check-unfilled-slot.json`, `check-optout-only-option.json`, `check-fallback.json`, `check-passed-on.json` (`checkResult`). Refused, in `fixtures/invalid/`: `refuse-format-not-allowed` (a contact card), `refuse-frontier-in-input` (the input with a frontier field), `refuse-hold-slot` (a plan line naming `{{hold}}`). Each refused fixture is refused for its one reason: without it (the contact card dropped, the frontier dropped, `{{hold}}` read as `{{deposit}}`) it is accepted (checked 2026-11-07).

Names and values come from the master's sample cast (SPEC-master 6: Sam, Lee's Barbershop, Alex M., Riley, Avery, Ben T., the $35 haircut, check-in code 5160, 88 Elm St, Springfield) and fixture set v1's therapist demo shop ("First session"), never a real person (rule 9). Option ids such as `S11-13/1` and row and turn ids are placeholders: K-02 owns the choices' ids and K-04 the row ids.

## Defaults used (T-012)

1. **The root is the union of the six documents**, and every fixture names its definition: json-schema-to-typescript fails on a root `$ref` and types only what the root reaches.
2. **The plan's formats are a list** (`formats`), from the same closed list as `allowedFormats`, so code compares the two directly; the order of the sends is code's (arch 07 line 367).
3. **The question is its own field after the lines**, never inside them, so One question is a code check on the words and the option ids ride with the question.
4. **Every plan property is required**, with `null` for none (the subset's limit on optional properties).
5. **The proposed slot names** above (CQ-17), and the audience counted from the master.
6. **The check result carries the final parts it checked**, so QA's test can run the message checks on each `check-*` fixture alone.
7. **`sms` is a channel** for Linq's SMS service on an Android phone in the same chat (RULES 4.1b), not an SMS provider (MC C9; DL-012).
8. **The situation tag's names** (`gentle`, `problem`, `moneyOrConsent`, `routine`) name arch 07 line 357's four tones.

## Open gaps

- **Q-30** (where the opt-out line and the privacy link go): default in use, on Rosie's first reply in a chat the person opened, as K-01's `optOutLine` says; code adds it (`fixedLines`), never the composer.
- **Q-01** (the stop replies' words): K-01's `stopReply`, `startReply` and `helpReply` are `pendingJay`; this contract only names fixed lines by id.
- **Q-43** (contact cards): not a format; incoming contact cards wait for a spike.
- **MC 8** (bold and read receipts off until tested): v1 carries neither. Each one, once tested, is a minor version adding it to `format` (an additive change).
- **CQ-07** (which stage reports a text's language): `language` is given to the composer; default in use, the two decide reads, which must agree.
- **CQ-16** (the page types): `pageType` and `pageTypes` are free strings until K-21 names the closed list; checking the plan's pick against the input's is code's.
- **CQ-17** (the compiler-made slot names): the 15 names marked `proposedCQ17` are proposals until the CTO rules; K-01 v1.1 adds them to the bundle's slot list in its own task.

## Change log

- v1, 2026-11-07 (T-012): first version, frozen.
