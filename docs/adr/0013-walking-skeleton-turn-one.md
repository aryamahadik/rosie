# ADR-013: The walking skeleton's one turn: Sam's first text (S1-01) to S1-02's question

- Status: proposed, default in use (T-1142; the lead's ruling DL-322)
- Date: 2026-11-10
- Owner: architect. Decides: the CTO.
- Contracts: K-02 v1.1 (`contracts/model/`, README "v1.1") and K-09 v1.5 (`contracts/tool-api/`, README "v1.5"), both frozen by T-1142.

## Context

- D-017's card (build prompt section 10, lines 521 to 548) runs one text through every hop: gateway, handle actor, safety read, batch and lease, guard, "frontier from the Tool API → decide (two reads) → gate and one commit (state, the open question and its clock row, one outbox row, event log, under the turn id)", composer, finalize, dispatcher, the Linq double. Its human test: "text JOIN (how the sign-up link starts an owner's chat, S1-01) ... Rosie answers once, with the first sign-up question (S1-02: what kinds of work you do)".
- The skeleton's fixtures spanned two turns (T-315 round 1, CQ-156 a; T-1139 round 1, CQ-157). K-09 v1's `compose-input-s1-02.json` and `finalize-pass.json`, T-563's send proof and the human test are turn 1, Sam's first text, whose reply is S1-02's question as `outbox-s1-02-sam-1`. K-09 v1's `build-frontier-s1-02.json` and `commit-s1-02.json` and K-02 v1's `context-s1-02.json` and `decide-s1-02-choose.json` are turn 2, Sam's answer, which walks to S1-11 and S1-04's question, steps bundle v0 does not hold. The lead ruled (DL-322): the skeleton's end-to-end turn is turn 1; turn 2 leaves the skeleton for journey 1's lane.
- Turn 1 has two forms with one shape. The human test and `tests/e2e/skeleton` send JOIN, the text the sign-up link types ("By plain text, the link types JOIN for Sam": S1-01), with K-08 v1 `trace-skeleton.json`'s ids (`evt-sam-0000`, `trace-sam-0000`, `turn-s1-01-sam-join`). The fixture chain carries the master's words ("Hi, I want to put my barbershop on Rosie": S1-01's say), the text `compose-input-s1-02.json` answers (`turn-s1-01-sam`).
- K-08 v1's `trace-skeleton.json` shows turn 1's frontier as one door, S1-01, which both decide reads enter with no re-read. K-01 v1's routing doors and K-02 v1's door list hold the five doors of arch 03 line 165, and none of them is S1-01.

## Decision

### 1. The turn

The skeleton's end-to-end turn is turn 1. In the fixture chain it is `turn-s1-01-sam` (trace `trace-sam-0000`, event `evt-sam-s1-01`, the master's words at 2026-10-19 18:05:00Z), under the caller `compose-input-s1-02.json` names: business `biz-lees-barbershop`, person `person-sam`. Its fixtures, in hop order: K-09 v1.5 `build-frontier-s1-01.json`, K-02 v1.1 `context-s1-01.json` and `decide-s1-01-enter.json`, K-09 v1.5 `commit-s1-01.json`, then K-09 v1's `compose-input-s1-02.json` and `finalize-pass.json` on the commit's row `outbox-s1-02-sam-1`. Each call's output feeds the next (CQ-156 a is settled).

### 2. Turn 1 reaches the commit through decide

No keyword or door routes a new number's first text in code (the card's item 3 does not apply, and K-02 changes):

- JOIN is none of K-01's keywords (`lists.keywords`: START, HELP and the 16 opt-out words), so the guard acts on nothing and lists the handle's targets (arch 02 line 115).
- A new number has no role, no open question and no booking (K-05 v1.2 `targets-first-text.json`): "No target: the doors" (arch 02 line 115; arch 03 line 165).
- The frontier offers one choice, the sign-up door to S1-01 (K-02 v1.1 default 9: `door: "signUp"`, label "Business onboarding", S1-01's first sentence as its definition, the turn's business as its target, no field, low stakes).
- Decide's two Haiku reads enter it with the turn's whole text as the quote; no re-read (K-02 v1.1 default 10).
- The gate passes it (limits 1, 4 and 6 pass; 2, 3 and 5 are not checked, as K-08's gate span logs them), and the walk after the choice (arch 03 line 191) writes S1-01's thread and stops at S1-02's question, the first step that asks someone.

### 3. The frontier on bundle v0 (K-09 v1.5 default 129)

A door is offered only when the pinned bundle holds its entry step (K-01 README: "a step a bundle does not hold is not reachable"), so of the doors only S1-01's. No any-time row is offered: rows 1 to 3 come from the safety read alone, when it labels them (arch 03 line 173; T-294's card), and Sam's text reads No; rows 4 to 21 need a handler step the bundle holds (K-02 default 4), and bundle v0 holds none. Until a K-01 minor version adds `signUp: "S1-01"` to `routingTables.doors`, the frontier takes the door's step as the first step of section 1 of the turn's flow graph.

### 4. The commit's writes (K-09 v1.5 defaults 130 to 134)

| Row                    | Id                     | Values and their sources                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K-04 `threads` (state) | `thread-s1-01-sam-1`   | Handle `handle-sam`, kind chat, no booking, Linq's chat id from the text's event, no reply address: S1-01 gives thread, the handle's first commit (K-09 README, journey 1 table)                                                                                          |
| K-05 open question     | `oq-s1-02-sam-1`       | Handle `handle-sam`, person `person-sam`, business `biz-lees-barbershop`, no booking, step S1-02, no options (the kinds typed), no read-back, no versions read, `clock` null (step 9's default: S1-02's card)                                                             |
| K-05 clock row         | `clock-oq-s1-02-sam-1` | The commit's own (T-305, `actions/src/commit/build.ts`): kind question, waiting, `fires` S1-02 with its card's safe default; armed at the first delivery receipt (arch 02 line 127; T-564), due 8pm the day after delivery with no visit (arch 02 line 127, DD)           |
| K-05 outbox row        | `outbox-s1-02-sam-1`   | Recipient `handle-sam` and `person-sam`, business `biz-lees-barbershop`, no booking, channel `imessage` (default 132), send class `quick_reply` (default 133), the open question's id, no copy, no versions read, no plan (words go in after the commit: arch 01 line 41) |
| Event log              | `log-<row id>-<move>`  | One entry per row (T-305 default 1), each with the turn id, its trace and bundle                                                                                                                                                                                          |
| Core action            | named in its response  | `recordSafetyOutcome` for the text, read No (K-09 v1 README default 5)                                                                                                                                                                                                    |

- **Business** (default 130): the business head test owner 1's phone is seeded for (K-21 `test-roster.json` tp-01; K-04 `seed-business-head.json`), as v1's `compose-input-s1-02.json` names the caller; Sam holds no role yet.
- **Row ids** (default 131; T-1139 item 4): `<kind>-<step>-<turn key>-<n>`, the turn key the turn's own id in production (a hash of its texts' event ids: arch 01 line 59; CQ-09), so each id is unique per turn, the same on a rerun and free of the person's words. A fixture writes the turn key as the handle's sample name (`sam` for `turn-s1-01-sam`), as v1 already names `outbox-s1-02-sam-1`; a proof on the fixture takes the turn key `sam`, so the walk's ids equal the fixture's.
- **Channel** (default 132; T-1139 item 5): the service the turn's last text came in on (K-06 `service`), since a number with no phone row has no stored way (K-04 `phones.chat_way`, Q-33).
- **Send class** (default 133; T-1139 item 5): `quick_reply`, a reply in the same turn (RULES 4.3; Q-15), which goes at any hour.

### 5. Each hop's turn 1 fixture (02-contracts section 11)

| Hop | Card  | Turn 1's fixture                                                                                                                                                                                                                                        |
| --: | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | T-552 | The JOIN event of `tests/e2e/skeleton` (K-06 v1 `text-imessage.json`'s form; K-08 `trace-skeleton.json`'s ids), signed by the Linq double (K-11 v1 `double-signed-webhook.json`'s way). No card change (merged; its proof does not depend on the turn). |
|   2 | T-553 | The same JOIN event, sealed into Sam's actor; K-06 v1 `text-imessage.json` and `duplicate-event.json` as carded. No card change.                                                                                                                        |
|   3 | T-554 | K-02 v1 `safety-no.json`: the JOIN text reads No, through the double's recording of the text `JOIN` (K-02 README "v1.1", recording 3). Lines below.                                                                                                     |
|   4 | T-555 | The JOIN event's id; K-05 v1 `commit-first.json` and `park-turn.json` as carded; the turn id is T-248's hash of `["evt-sam-0000"]`. No card change.                                                                                                     |
|   5 | T-556 | K-05 v1.2 `targets-first-text.json`: no role, no open question, no booking, no phone row; K-01 bundle v0's keywords (JOIN is none). Lines below.                                                                                                        |
|   6 | T-557 | K-09 v1.5 `build-frontier-s1-01.json` (K-02 v1.1 `context-s1-01.json` unchanged). Lines below.                                                                                                                                                          |
|   7 | T-558 | K-02 v1.1 `context-s1-01.json` and `decide-s1-01-enter.json`; v1 `decide-reads-disagree.json` stays the disagreement case. Lines below.                                                                                                                 |
|   8 | T-559 | K-09 v1.5 `commit-s1-01.json`; K-05 v1 `commit-opens-question.json` (the same K-05 shape: an open question, its clock row, a quick_reply row) and `commit-repeat-same-turn.json`. Lines below.                                                          |
|   9 | T-560 | K-09 v1 `compose-input-s1-02.json` (already turn 1's row); K-03 v1 `input-s1-02.json`, `plan-s1-02.json`. Lines below.                                                                                                                                  |
|  10 | T-561 | K-09 v1 `finalize-pass.json` as the plan in; its outcome is not turn 1's final parts under Q-30 (K-09 v1.5 open gap 121). Lines below.                                                                                                                  |
|  11 | T-562 | K-09 v1.5 `commit-s1-01.json`'s row (`quick_reply`); K-05 claim fixtures as carded. Lines below.                                                                                                                                                        |
|  12 | T-563 | The same row; K-11 v1 send; K-07 v1 `outbox-delivered.json`, `outbox-two-sends.json` as carded. No card change.                                                                                                                                         |
|  13 | T-564 | K-06 v1 `delivered.json`, K-05 v1 `mark-delivered.json`, `arm-clock.json`; S1-02's clock due 8pm the day after delivery (K-09 v1.5 default 134). Lines below.                                                                                           |

### 6. The card lines that change, for the lead to apply

Each line replaces the card's line of the same name; "add" adds to it.

**T-554** (join 3)

- Reads, add: `K-02 v1.1 README "v1.1", recording 3 (the double's safety read of the text JOIN, seeded from safety-no.json); ADR-013.`
- Depends on, add: `the recordings task (ADR-013, new task 1), because the double has no recording of the text JOIN.`

**T-556** (join 5)

- Reads, add: `K-05 v1.2 targets-first-text.json (turn 1's targets: none); ADR-013.`
- Proves it with: `npm run test:contract -- bundle.v1 and db-schema.core.v1 are green; SKELETON_UPTO=guard npm run test:e2e -- skeleton: JOIN from the seeded test owner gives a guard span with no keyword and no target, its targets those of targets-first-text.json (no role, no open question, no booking, no phone row); A bare HELP from the same phone takes the code path and reaches no model call`
- Note: test owner 1's seed must be a handle and a person with no role and no phone row (new task 4).

**T-557** (join 6)

- Reads: `K-09 v1.5 (build-frontier-s1-01.json); K-02 v1.1 (context-s1-01.json: the sign-up door); K-01 v1 (bundle-v0-skeleton.json: S1-01); K-05 v1 (active-bundle.json) and v1.2 (readTurnState; targets-first-text.json); ops/plan/02-contracts.md section 11, row 'Frontier from the Tool API'; ADR-013`
- Proves it with: `npm run test:contract -- tool-api.v1 is green; SKELETON_UPTO=frontier npm run test:e2e -- skeleton: the frontier span carries bundle v0's id, and the JOIN turn's choices equal build-frontier-s1-01.json's: one choice, c-01, the sign-up door to S1-01 (kind door, door signUp, label 'Business onboarding', low stakes, target Lee's Barbershop); With KV empty the bundle part is read from PostgreSQL and the span says so`
- Depends on: T-293 with its new lines (new task 3); T-294 is no longer needed for this proof, since turn 1 offers no any-time row on bundle v0 (K-09 v1.5 default 129).

**T-558** (join 7)

- Reads: `K-02 v1.1 (context-s1-01.json, decide-s1-01-enter.json) and v1 (decide-reads-disagree.json); K-02 README "v1.1", the recordings the double needs; build prompt section 10, D-017 ('decide joins between the frontier and the gate'); QUESTIONS Q-41 default (re-read, then one question; never commit on a difference), Q-26 default (Sonnet first on high stakes); ADR-013`
- Proves it with: `SKELETON_UPTO=decide npm run test:e2e -- skeleton: two decide spans, both Haiku, then no re-read for the JOIN turn: both reads enter c-01, the sign-up door, with the quote JOIN and no field, as decide-s1-01-enter.json's reads do with its own text; With decide-reads-disagree.json one re-read span follows, then the turn asks one question and commits nothing for that part`
- Depends on, add: `the recordings task (ADR-013, new task 1): the double reads K-02 v1.1 and holds turn 1's recordings.`

**T-559** (join 8)

- Reads: `K-09 v1.5 (commit-s1-01.json), K-05 v1 (commit-opens-question.json, commit-repeat-same-turn.json); K-07 v1 (outbox rows); K-08 v1 (event-commit.json); K-09 README v1.5 defaults 130 to 134 (business, row ids, channel, send class, S1-02's question and clock row); ops/plan/02-contracts.md section 11, row 'Gate and one commit'; ADR-013`
- Proves it with: `SKELETON_UPTO=commit npm run test:e2e -- skeleton: exactly 1 turn row, 1 thread row (S1-01), 1 open question (S1-02's, no options), 1 clock row (waiting, unarmed; with the never_delivered row once note 37's task has merged, CQ-156 b), 1 outbox row (imessage, quick_reply, no plan) and the event-log entries, all with one turn id and one trace id, each row id built by K-09 v1.5 default 131 from the turn's id; Hard invariant (exactly once): replaying the same turn id returns the first result and writes nothing; Concurrency: two actors forced to commit the same turn id in parallel give one commit`

**T-560** (join 9)

- Reads, add: `ADR-013 (the JOIN run's composer input differs from input-s1-02.json only in inbound: K-02 README "v1.1", recording 4).`
- Proves it with: `npm run test:contract -- message-plan.v1 is green; SKELETON_UPTO=compose npm run test:e2e -- skeleton: one composer span for the one outbox row (S1-02, routine), and its plan matches plan-s1-02.json's shape; An input carrying the frontier is refused (refuse-frontier-in-input.json)`
- Depends on, add: `the recordings task (ADR-013, new task 1).`

**T-561** (join 10)

- Reads, add: `K-09 README v1.5 open gap 121 (finalize-pass.json predates T-314's first-text lines); T-314's handoff item 3 (privacyLink); ADR-013.`
- Depends on, add: `the bundle's privacyLink fixed line (new task 2), because T-314's inserter refuses Rosie's first text whole without it (lineNotInBundle), so this proof cannot pass on bundle v0 before it.`

**T-562** (join 11)

- Reads, add: `K-09 v1.5 (commit-s1-01.json: the row's send class quick_reply, default 133).`

**T-564** (join 13)

- Reads, add: `K-09 README v1.5 default 134 (S1-02's clock: step 9's default, no visit: 8pm the day after delivery).`

**T-315** (the frontier hop, round 2: ruling 8 already reads `build-frontier-s1-01.json` once T-1142 merges)

- Reads, add: `K-09 v1.5 (build-frontier-s1-01.json); K-02 v1.1 (the sign-up door); ADR-013.`
- Proves it with: `npm run test:unit -- actions/src/tool-api/turn-face: build-frontier-s1-01.json's request gives the fixture's frontier as far as main's frontier sources give it; its one choice, the sign-up door, waits for T-293's new lines and is named in the test as waiting for that task, never faked; npm run test:integration -- actions/src/tool-api/turn-face: buildFrontier for turn 1 on local PostgreSQL, over readTurnState under the call's business scope; a call under another business's scope sees nothing of this one. Then npm test, lint, typecheck and format:check.`

**T-1139** (the walk, round 2)

- Reads: `arch 03 line 191 (the walk after a choice); K-01 v1 (bundle-v0-skeleton.json: S1-01, S1-02); K-02 v1.1 (the sign-up door); K-09 v1.5 commit-s1-01.json (the writes its part gives) and README v1.5 defaults 130 to 134 (business, row ids, channel, send class, S1-02's question, its clock row, the thread row); K-05 v1 commitTurn's writes; actions/src/commit/types.ts and commit.ts; STATE notes 1, 30, 37, 52 and 53; DL-128; ADR-013`
- Proves it with: `npm run test:unit -- actions/src/commit/walk: commit-s1-01.json's part (entering c-01, the sign-up door) gives exactly the writes that fixture shows, with the ids of default 131 for its turn key sam: S1-01's thread row (handle-sam, chat, no booking), S1-02's open question (Sam, Lee's Barbershop, no options, clock null) whose clock row fires S1-02's safe default, and outbox-s1-02-sam-1 (Sam, Lee's Barbershop, imessage, quick_reply, the question's id, no plan), and gives exactly thread; the walk stops at S1-02's question; S1-02's branches walk only as far as bundle v0 holds them ('Not a service we book' ends with its end text; the other two need S1-03 and S1-11, which bundle v0 does not hold, and are refused, never guessed); an open safety hold stops the walk at its first routine row; the same part twice gives the same writes; a step or branch the bundle lacks is refused, never guessed. Then npm test, lint, typecheck and format:check.`

**T-1141** (the turn face, part 2)

- Reads, add: `K-02 v1.1; K-09 README v1.5 open gap 121; ADR-013.`
- Proves it with, the unit line: `npm run test:unit -- actions/src/tool-api/turn-face: one turn's fixtures chain, each call's output feeding the next: build-frontier-s1-01.json, then commit-s1-01.json (K-09 v1.5), then compose-input-s1-02.json on that commit's row, outbox-s1-02-sam-1, then finalize with finalize-pass.json's plan: on bundle v0 it answers lineNotInBundle for privacyLink (T-314; K-09 v1.5 open gap 121), asserted as the chain's end until the bundle carries the line; with it, the final parts carry the bundle's opener, the opt-out line and the privacy link (Q-30), not finalize-pass.json's outcome.`

**T-293** (the frontier's hubs and doors; new task 3)

- Reads, add: `K-02 v1.1 (default 9: the sign-up door); K-09 v1.5 (build-frontier-s1-01.json; README default 129); ADR-013.`
- Gives, add: `the sign-up door to S1-01 when the guard finds no target and the pinned bundle holds S1-01; a door only when the pinned bundle holds its entry step.`
- Proves it with, add: `build-frontier-s1-01.json's request gives exactly its one choice on bundle v0.`

### 7. New tasks found (outside this card)

1. **The double's turn 1 recordings** (AI engineer; `ai/src/recorded-double/**`, `ai/recordings/**`): read K-02 v1.1's schema and fixtures, and add the four recordings of K-02 README "v1.1" (decide on `context-s1-01.json`; decide on the JOIN run's context; the safety reads of JOIN and of the master's words; the composer on the JOIN run's input). Before T-554's, T-558's and T-560's proofs.
2. **The bundle's `privacyLink` fixed line** (playbook engineer, with Q-30's words and address from Jay; T-314's handoff item 3). Before T-561 and the human test.
3. **T-293's lines above** (the sign-up door).
4. **Test owner 1's seed for D-017** (database engineer; T-200 and T-202): a handle and a person, no role and no phone row, so JOIN is a first text (K-05 v1.2 `targets-first-text.json`). K-04's `seed-person-roles.json` gives Sam owner roles, C-202's M3 row a customer role, and K-21's `test-roster.json` an owner of a live business; each makes JOIN a turn with a target, not turn 1.
5. **K-01 minor version**: `routingTables.doors.signUp` (K-02 README "v1.1" open gap).
6. **The Tool API mock** generated again for K-09 v1.5 (`contracts/mock/**`).
7. **The contract tests**: `tests/contract/model.v1.test.ts` checks each entry by its own version (DL-124, DL-125), and `contracts/scripts/model-contract.test.mjs` names K-02's frozen versions as `frozen.json` holds them and adds a minor version that does not exist yet (v1.2): both pin K-02 to v1 alone today.
8. **Renumbering**: T-054's journey 7 freeze becomes K-09 v1.6 (DL-322); T-070's photo reading becomes K-02 v1.2.

## Consequences

- D-017's hops run one turn end to end, and every fixture they read is that turn's. T-1141's unit chain is one turn; T-1139 builds turn 1's walk; joins 6 to 8 read turn 1's fixtures.
- The frontier gains a sixth door, from K-02 v1.1; K-01's routing table names it only in a later minor version, so until then the frontier takes S1-01 from the flow graph.
- Finalize on bundle v0 refuses turn 1's reply until the bundle carries the privacy link (K-09 v1.5 open gap 121): the human test cannot pass before new task 2, whatever the joins do.
- Turn 2's fixtures stay as they are for journey 1's lane, which meets their unheld door and any-time row with the full bundle (K-09 v1.5 open gap 118).

## Alternatives not chosen

- **A keyword or code route for JOIN, with no decide.** JOIN is no keyword in K-01 or the master, the master's own first text ("Hi, I want to put my barbershop on Rosie") is no keyword at all, and D-017's card and K-08's trace both run decide on this turn.
- **Meaning search's entry step (`searchEntry`).** It needs decide to answer none_fits first, then meaning search (C-079, Q-42's spike) and the Sonnet re-read: three reads and an unbuilt part, where D-017 and K-08 show two reads and a door.
- **An existing door value (`newBooking`).** That door is "a new booking or a question about the business" (arch 03 line 165), not a sign-up.
- **Turn 2 as the skeleton's turn.** It needs S1-03, S1-04, S1-11, S1-74 and the kinds matcher, none of which bundle v0 holds (DL-322).

## Open points (proposed for QUESTIONS.md, each with its default)

1. A new owner's first text before any business head exists (K-09 v1.5 open gap 119). Default: the skeleton runs under test owner 1's seeded business; journey 1 decides.
2. Turn 1's final parts under Q-30 (K-09 v1.5 open gap 121). Default: finalize refuses the first text until the bundle carries `privacyLink`.
3. Test owner 1's seeded state for D-017 (new task 4). Default: a handle and a person, no role, no phone row.
4. Turn 2's unheld door and any-time row on bundle v0 (K-09 v1.5 open gap 118). Default: journey 1's lane, with the full bundle.

## Sources

- Build prompt section 10, D-017 (lines 521 to 548); 6.4 (contract changes).
- `ops/plan/02-contracts.md` section 11 (the skeleton's hops and their contracts).
- `ops/cards/T-552.md` to `T-564.md` (each hop's Reads and Proves it with; T-555, T-556 and T-564 from `ops/plan/03-tasks.md`); `ops/cards/T-1139.md` and `T-315.md` (round 1 reports and rulings); `ops/cards/T-1141.md`, `T-314.md`; DL-319, DL-322; CQ-156, CQ-157.
- MASTER-FLOW-A S1-01 and S1-02 as K-01's `bundle-v0-skeleton.json` holds them.
- Architecture (`scratch/text/architecture.txt`): 01 lines 59 and 65; 02 lines 115, 119, 121, 125, 127; 03 lines 159 to 191.
- K-01 v1 `bundle-v0-skeleton.json`; K-02 v1 `context-s1-02.json`, `decide-s1-02-choose.json`; K-03 v1 `input-s1-02.json`, `plan-s1-02.json`; K-05 v1 `commit-opens-question.json`, v1.2 `targets-first-text.json`, `read-turn-state-first-text.json`; K-06 v1 `text-imessage.json`; K-08 v1 `trace-skeleton.json`; K-09 v1 `build-frontier-s1-02.json`, `commit-s1-02.json`, `compose-input-s1-02.json`, `finalize-pass.json`; K-21 v1 `test-roster.json`; `tests/e2e/skeleton/skeleton.test.ts`; `ai/src/recorded-double/` (T-004); `actions/src/commit/build.ts` (T-305); `actions/src/finalize/fixed-lines/` (T-314).
- RULES 4.3, 4.8; Q-15, Q-26, Q-30, Q-33, Q-41; CQ-09, CQ-11.
