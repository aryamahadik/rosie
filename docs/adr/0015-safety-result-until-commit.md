# ADR-015: Where the arrival safety read's result is kept until its turn commits

- Status: proposed, default in use (T-1241; the D-017 path audit's ruling R3, DL-492; round 2 rules round 1's three failing review points, DL-499)
- Date: 2026-11-11
- Owner: architect. Decides: the CTO.
- Contracts: none changes. K-02 v1 `safetyResult` is kept and handed on as the read gave it; K-05, K-06, K-08, K-09 and K-34 stay as they are.

Every line number below was read on main 58acd53 (T-1108 moved none of the arrival.ts lines named here; its last change there is T-1208's).

## Context

- **What the commit needs.** Each text's outcome, No included, is a `recordSafetyOutcome` core action of the turn its text joins, since K-34 v1 writes one outcome row per text with that turn's id (K-09 README default 5; `safety_outcomes_text_has_handle_and_turn`, `db/migrations/0016_safety_incidents.sql` lines 81 to 83; `actions/src/domain/safety/record.ts` lines 319 to 321 refuse a text's record outside its turn). The request carries the text's whole K-02 v1 `safetyResult` (`runtime/src/turn/turn.ts` lines 557 to 574). The turn gets it from `resultsOf` (`runtime/src/turn/types.ts` lines 639 to 645: "The actor keeps only labels (runtime/src/safety), so the store behind this joins at D-017"), once per run, after the guard (turn.ts lines 368 to 373 and 543 to 551).
- **What the actor keeps today.** The safety read applies each result in one place, `applyResult` (`runtime/src/safety/arrival.ts` lines 1146 to 1222), and keeps its outcome labels only (lines 255 to 257 and 1163 to 1174). The whole result is kept nowhere, except a danger's record queued, sealed under the handle's key, while the core does not answer (lines 253 to 254 and 1272 to 1293). The labels insert (lines 1170 to 1174) is the one write of `applyResult` outside a guard: a throw there ends `applyResult` before any line is sent. A text counts as read by `unreadAmong` (lines 601 to 617) from its state, its danger flag and its unread hold alone; the flag is set by `markDanger` (line 1186), by `finish` (line 1219) and by `resumeCutOff`'s `finish` for a cut-off danger (line 440).
- **What a text with no result does today:**
  - a turn that decides anything ends its run before the frontier when one of its readable texts has no result (`noSafetyResult`, turn.ts lines 423 to 426): nothing is decided or committed, the lease reruns the turn at each 60 s lapse and parks it after the third (`runtime/src/actor/lease.ts` lines 17 to 33). The check covers every readable text, keyword texts included, and runs before `keywordTurn` (line 433), so a STOP batched beside a decided text and a text with no result is never committed, and the park carries no core action (K-05 v1 parkTurn: types.ts lines 563 to 572);
  - a turn that decides nothing (keyword texts alone, or only events K-02 has no text for) leaves the text out of its records (turn.ts lines 411 to 421 and 553 to 574) and commits;
  - in the commit, the openHolds port names each of the turn's texts whose record is not among the core actions (`actions/src/tool-api/turn-face/commit.ts` lines 192 to 201 and 231 to 232), `readOpenHolds` lists each that K-34 holds no row for as unread (`db/repo/turn-face-reads.ts` lines 324 to 340), and while any is unread every part but a protective one is held (`actions/src/commit/hold.ts` lines 182 to 184). The core actions run whatever is open (`actions/src/commit/commit.ts` lines 141 to 160).
- **A danger outlives its turn.** A danger whose line or record is not done stays in `safety_pending` and counts as read meanwhile (lines 601 to 617), so its batch goes on and its turn can commit and end. It is read again every 30 s whatever its turn has done (lines 477 to 496 and 534 to 546), and each danger answer is applied again (lines 981 to 992 and 1007). On staging today every danger stays pending: its arrival record goes as a job, which the core refuses (`textNeedsTurn`, record.ts lines 319 to 321), and `linqDirect` is closed.
- **What the result holds** (K-02 v1 `safetyLabel` and `safetyResult`, `contracts/model/model.v1.schema.json` lines 1453 to 1595): labels (outcome and tense), the model tries, the timeout marker and what holds after code's rules, and the person's words: each label's evidence words, who is at risk and who wrote it, and the danger words matched. K-34 keeps the labels plain and seals those words under the person's key (`sealed_words`: 0016 lines 16 to 21; K-34 README line 29 and rule 6).
- **Where a turn runs.** One actor per handle (arch 10 line 502), with single-writer storage; a turn runs in its actor's instance, but `TurnDeps`, where `resultsOf` sits today, is set once per Worker isolate for every actor in it (turn.ts lines 112 to 121; `runtime/src/wiring/root.ts` lines 467 to 470).
- **The audit's ruling R3** (`ops/reviews/D-017-path-audit/order_d017.txt` line 75; DL-492): "the result kept sealed in the actor's own storage. Reason: the commit must record the very result the actor read, with no second model call and no unsealed evidence words."

## Decision

### 1. Where: in the handle actor's own storage, sealed

- The actor keeps each text's K-02 result in a table of its own SQLite storage, `safety_results` (`event_id TEXT PRIMARY KEY`, `box TEXT`), made with the safety read's other tables (arrival.ts lines 231 to 264). One row per text. A row whose `box` is null is **owed**: a result was applied and could not be kept (section 2).
- **Sealed:** the whole K-02 v1 `safetyResult` the read gave, as one JSON text, sealed as `sealWords` seals (`runtime/src/gateway/seal.ts` lines 121 to 136: AES-256-GCM, a fresh IV per seal) under the handle's sealing key (QUESTIONS.md NQ-RT-1's default), the key the text's own words are sealed under. Its additional data is the actor name and `result:<event id>` (seal.ts lines 86 to 88 join them), as the write-on-return queue names `return:<key>` (arrival.ts lines 1281 to 1286), so a box opens only as its own text's result: never as a text's words, under another event id or in another actor.
- **Unsealed:** the event id alone (K-06's id: a label, never words). Each label's evidence words, who is at risk and who wrote it, and the danger words matched are inside the box, the words K-34 seals (0016 lines 16 to 21; arch 01 line 93: "Encrypted under a per-person key"). The read's model calls are not part of the result and are not kept here. The actor's labels table stays labels only (arrival.ts lines 255 to 257).
- **Nowhere else** between the read and the commit: not in PostgreSQL, KV or R2; not in a span, log line, error or event-log value (K-08 README line 79; arrival.ts lines 50 to 51); not in decide's context. The turn hands it only to its commit's `recordSafetyOutcome` (turn.ts lines 557 to 574), and the commit seals the words into K-34 under the person's key, as it does today.
- **How the turn reaches it:** through its leased turn, never through an isolate-wide port (section 3). `TurnDeps.safety` (types.ts lines 639 to 645 and 652) and `Ports.stateReads.turn.safety` (`runtime/src/wiring/ports.ts` lines 140 to 141; `closed.ts` line 53; root.ts line 470) go.

Why here:

- The commit records the very result the actor read and acted on (its line, its hold and its labels came from it), with no second model call: the actor is where the read runs and its result is applied.
- The actor's storage outlives an eviction and needs no database (arch 11 line 566), and it holds the sealed texts the turn reruns from (arch 01 line 61; arch 02 line 113; arch 11 line 576), so a rerun reads the same results.
- Sealed under the handle's key, because the evidence words are the person's own words and who is at risk and who wrote it name people: whatever keeps a person's words keeps them sealed under a per-person key, so that deleting the key erases them (arch 01 line 93; arch 09 line 492; arch 10 line 516; RULES 4.10; RULES 4.5: "When unsure, treat it as private"; K-34 rule 6). It is the text's own key, so one deletion erases a text and its kept result together.
- It is no second system of record (arch 10 line 504): a row lives only until its text can reach no commit (section 2).
- Through the leased turn, because the store is one actor's and `TurnDeps` is every actor's in the isolate: no isolate-wide port can reach one actor's storage without module state shared across Durable Object instances, which could hand one handle's results to another.

### 2. Its life

**Written** by `applyResult` (lines 1146 to 1222), for each result it applies to a text whose words were opened: on time, by the timeout rule, late, on a re-read, or a danger applied again (lines 866 to 921 and 948 to 1021). In three steps, the first before anything else in `applyResult`:

1. **Owed, before any await or send.** One guarded synchronous write: an owed row (`box` null) for the text, unless it has a row already or is closed (`INSERT OR IGNORE`, guarded by `NOT EXISTS` on `safety_closed`); and, for a danger, the pending note `markDangerPending` writes (lines 1044 to 1050), moved from line 1180 into this step. A storage that throws here stops nothing.
2. **Sealed in memory,** under the key the read opened the words with: `queueRead` (lines 833 to 864) resolves it, and `Started` (lines 186 to 188) and `LateAnswer` (lines 180 to 183) carry it to `applyResult`; it is never stored. A seal that throws gives no box. No key call and no network call are added before a danger's line, which goes first (RULES 4.12), within 5 s of arrival (arch 04 line 211) and while PostgreSQL is down (arch 11 line 566).
3. **Kept,** in one guarded `transactionSync` in place of the labels insert (lines 1170 to 1174): the labels row, as today, and `UPDATE safety_results SET box = ?` on the text's row, with the box, or null (owed) when step 2 gave none. It fills only a row that exists, so a text closed since step 1 keeps nothing. A throw is caught: nothing of the step is written, and the danger's line still goes. **This is the seam that keeps the labels insert from stopping a line.**

The danger block then runs as today (lines 1176 to 1213: `holdFromOutcomes`, `markDanger`, `sendDanger`), then lines 1217 to 1221.

**Owed, and how it survives.** The owed row lives in `safety_results`, which `finish`, `markDanger` and `resumeCutOff` never write. So **lines 440, 1186 and 1219 do not change**: the danger flag keeps its meaning (the read found danger, and the open batch closes at once: `runtime/src/actor/batch.ts` lines 308 to 312), and the owed row alone keeps the text back, whatever they write:

- `unreadAmong` (lines 601 to 617): an owed text is unread, whatever its state, danger flag or holds. A cut-off danger that `resumeCutOff` finishes as lineFailed with danger (line 440) stays unread while it is owed;
- `unreadTexts` (lines 647 to 659): an owed text is listed whatever holds are open, so a commit while it is owed holds every part but a protective one (turn-face/commit.ts default 1; hold.ts lines 182 to 184);
- `routineHeld` (lines 662 to 670): true while a text is owed;
- `waiting` (lines 534 to 546): an owed text waits, so it is read again every 30 s on its own re-read (`rereadDue`, lines 477 to 496), and `onReturn` (lines 1135 to 1144) never makes it due for another text's verdict, as a pending danger (T-1088 round 3 gap B);
- `applyLate` (line 970): an owed text's answer is used, never dropped as "complete". Without an open danger a verdict is applied as a late verdict is (lines 978 to 980), and line 1016 keeps the text's next re-read while it is still owed;
- a danger whose result is owed stays pending: `sendDanger` clears it (lines 1362, 1385 and 1393) only once the result is settled, that is kept or the text closed. So a danger is complete when its line has gone (or none is needed), its record is kept and its result is settled (DL-132 widened), and while it is not, its re-read applies only a danger again ("the first verdict stands": lines 957 and 978 to 993) with the line it noted (below), and keeps it then.

No row is written for a text with no result to keep: words that open to nothing (lines 848 and 882 to 885; open point 1) and the stand-in of words that could not be opened (`unreadable`, lines 833 to 847 and 895 to 907), which has no key and keeps its unread hold (lines 1195 to 1204) until a read opens its words. A storage that throws at both step 1 and step 3 keeps nothing, and the text may then count as read with no row: `resultsOf` leaves it out, and section 3 still keeps every routine part from committing unrecorded; a danger stays pending, since its result is not settled, so its re-read tries again.

So no text whose applied result is not kept counts as read, except where the storage refuses every write, which section 3 covers.

**Replaced** by each later result the actor applies to the text (step 3's update): the late verdict after a timeout stand-in (lines 948 to 1021), or a danger applied again after a cut or a failed line (lines 434 to 445 and 978 to 993). The row holds the result the actor applied last (open point 3, ruled below). Step 1 adds no row over a kept box, so until a later result's box is ready the earlier one stays: a crash during a seal leaves the result the actor last acted on. An answer the actor does not use never replaces it: a re-read with no verdict (lines 994 to 1002), any answer but a danger while a danger is pending (lines 957 and 978 to 993), or a second answer while one lands (line 968).

**Read** by each run of the turn that carries the text, through its leased turn (section 3), once, after the guard and before the frontier (turn.ts lines 368 to 373). A restart's run, a lapse's rerun and a rerun after the commit read it again.

**Removed, and the text closed,** when its text can no longer reach a commit, and only then. Card A's `closeResults(eventIds)`, synchronous, deletes the named rows and notes the ids in `safety_closed` (event ids only), inside the caller's storage transaction:

- in the transaction that ends the turn for good: the reply ended (`replied`, lease.ts lines 767 to 773); `finish` (lines 789 to 800) for a commit with no reply, a park (line 968), alreadyCommitted (lines 969 to 971) and K-05's turnParked (lines 716 to 717); the reply given up at its third lapse (line 893, inside `onAlarm`'s and `resume`'s transactions, lines 819 to 835 and 847 to 860). A crash leaves both the turn's end and the removal, or neither;
- at the PostgreSQL-down hand-off, for the STOP and START texts that path took alone, which never join a turn (`runtime/src/outage/db/outage.ts` lines 21 to 28 and 340 to 342; `runtime/src/actor/handle-actor.ts` lines 679 to 683). A crash before the batch is handed hands it again, and the call is idempotent.

Never at a restart (lease.ts lines 540 to 543: the texts move to the restart's turn), a lapse's rerun, a commit that keeps the lease for its reply (`holdForReply`, lines 741 to 759), a turn held while PostgreSQL is down (T-270), an eviction, or a third lapse with no park wired (lines 870 to 882: the turn and its rows stay as they are, as the lease leaves them). The actor's labels rows and holds are not touched: they serve the holds (CQ-65 as DL-119 replaced it).

**After its turn has ended, nothing is kept** (round 1's security finding). A closed text gets no owed row in step 1, and step 3 has no row to fill, so a danger left pending and applied again by its 30 s re-read after its turn ended, or after the PostgreSQL-down hand-off took it, keeps nothing. Its line and record still complete as before (with the noted line), and its pending note clears, since a closed text's result is settled. The closed check and each write are synchronous, with no await between them, so no turn can end in between.

**What a crash leaves:**

- Before the result is applied (the read in flight, or its answer still in memory): nothing for it. The text is still being read and is resumed (lines 404 to 467) or read again; the result that lands then is kept. The lost answer was never acted on, so no record needs it.
- After step 1, before step 3 (during the seal): the owed row (and a danger's pending note). The text counts as unread whatever `resumeCutOff` writes; it is resumed or read again, and its result is kept then.
- After step 3, before the text counts as read (a danger's line under way): the row and its labels. A danger whose line or record is not done is read again and applied again with its noted line and key (DL-132), and its row then holds the last applied.
- After the text counted as read, before the commit: the row. The lease's lapse reruns the turn, the rerun reads the same row, and a third lapse parks the turn and removes the row.
- After the commit, before the reply ends: the row. The rerun reads it and its commit answers repeated with nothing written (K-05 README item 1: "whatever the repeat's body"), so a result replaced in the meantime is never recorded; the row goes when the reply ends or is given up.
- In the step that ends the turn: both or neither, in one storage transaction.
- After the turn ended: a danger still pending is read again and applied again, and nothing is kept.
- PostgreSQL down at any point: the row waits with the held turn (T-270); nothing here needs the database.

In no case does a commit record a result the actor did not apply.

#### Open point 3, ruled: two danger reads of one text that differ

- **Which result K-34 records.** K-34 holds one outcome row per text, and a repeat returns the first (K-09 v1 `recordSafetyOutcome`: "one outcome row per text, and a repeat returns the first", `contracts/tool-api/tool-api.v1.schema.json` line 2395). So whichever of a text's records reaches the core first is the one K-34 keeps: today the turn's commit (the arrival record is refused, record.ts lines 319 to 321); once journey 3's arrival record is built, that record (K-09 README default 36, line 429: the batch turn's record then answers repeated). Every record the actor sends carries the result it applied last when it sends it: the arrival record the result being applied (lines 1345 to 1351), the write-on-return queue the newer box of the same record (lines 1266 to 1271), and the turn's commit the kept result as its run read it. **Default: the first record stands.** A later, different read changes no K-34 row; the actor's hold, the strictest of every read (lines 1295 to 1323), binds every commit of the handle beside K-34's holds (turn-face/commit.ts defaults 1 and 2), and the labels row keeps every outcome the reads found (lines 1163 to 1169). Left open: who is told follows the recorded outcome (arch 06 line 329), so a stricter outcome a later read finds is told to no one beyond what K-34's first row names (open point 5).
- **No second line from a different read.** A text's danger line is chosen once. The first application of a danger that reaches the direct send notes the chosen line, its K-01 id and its words as the bundle gave them (`checkedLineFor`, `runtime/src/safety/rules.ts` lines 159 to 174), in the actor's storage before it sends (a table of its own, event id and line, cleared with the pending note); every later application of a danger to that text sends the noted line, not the one its own read would choose. So the key at line 1463 (`safety:<event id>:<line id>`) never changes for a text, and Linq takes a repeated key as one message (`runtime/src/safety/types.ts` lines 230 to 231). The queued record names the noted line in `sentByActor` (line 1392). The later read still widens the labels, tightens the hold and replaces the kept result. Card A changes lines 1372 to 1394.

### 3. What `resultsOf` answers, a missing result, and the keyword texts beside it

**What it answers:**

- For each asked event id with a row whose box opens under the handle's key, with the actor name and `result:<event id>`, to a K-02 result naming that same event id: that result, as kept.
- For any other id (no row; an owed row; a box that does not open or parse; a result naming another event): nothing. The list leaves it out. Never a made-up result, a stand-in, a No by default, another text's result or a second read.
- A read that cannot be done at all (the key store or the storage throws, or nothing is wired) throws, and the turn takes that as no results (turn.ts lines 371 to 373).

**Where the turn reads it: a function on the leased turn, not an eager field.** `LeasedTurn` gains `resultsOf(eventIds)`, which the lease builds in `start` beside `commit` and `replied` (lease.ts lines 622 to 634) from a new `LeaseHost` member; the actor's lease host (handle-actor.ts lines 262 to 281) answers it from the safety read's `resultsOf`. It answers only for ids among the turn's own `eventIds`, and is read when the turn calls it, where it calls `TurnDeps.safety` today (turn.ts lines 368 to 373, through `safetyOf`, lines 543 to 551). Not an eager field beside `holds` (line 654), because `holds` is a synchronous read and results need the handle's key and an AES-GCM open, both asynchronous: an eager read would await inside the lease's start, where a throw is a crash and a lapse (lines 645 to 660), not the turn's "no results", which still lets the keyword texts commit (below).

**So a missing result never lets a routine part commit unrecorded, and never keeps a STOP back:**

- **A turn with no keyword texts** that decides anything ends its run at turn.ts lines 423 to 426 (`noSafetyResult`), unchanged: no frontier, no decide and no gate. It reruns at each lapse and parks after the third (T-253), and the person hears once that nothing changed (arch 11 line 576).
- **A turn with keyword texts** (STOP or another opt-out word, START, HELP: `runtime/src/guard/guard.ts` lines 53 to 59) never ends because a result is missing (card C). Its run goes on with the text that has no result left out of the records:
  - when the decided part can be made, its one commit carries the keyword texts' core actions, the records of the texts that have results and the decided input, as a STOP beside decided texts commits today (turn.ts lines 432 to 434; K-09 README default 10). The text with no record is listed unread, so every routine part is held (hold.ts lines 182 to 184), while the protective parts and every core action commit (commit.ts lines 141 to 160);
  - when, with a result missing, it cannot be made on that run (the targets read failed, line 428; the frontier, decide or the one re-read failed, lines 430 to 431), the keyword texts commit at once, as a turn of keyword texts alone does (`keywordTurn` with no decided input, line 413: input coreOnly), with the records the run has. A rerun would find the same result missing, the routine parts would be held anyway, and a park after three runs records no STOP.
  - So the STOP's `recordStopOrStart`, START's and HELP's actions commit on the run that has them (RULES 7.2: "at once"; RULES 7.8: "After an outage, stops come first"; arch 06 line 329: changes that only protect commit at once).
- **A turn of keyword texts alone** commits its STOP or START with that text left out of its records (turn.ts lines 413 and 553 to 574), unchanged (open point 2).
- **In the commit,** for any request that reaches it without a text's record: that text is named to `readOpenHolds` and listed unread while K-34 holds no row for it (turn-face/commit.ts lines 231 to 232; turn-face-reads.ts lines 324 to 340), and every routine part is held before the gate (hold.ts lines 182 to 184 and 194 to 204).

### 4. No contract changes

- K-02 v1 `safetyResult`: kept and handed on as the read gave it.
- K-09: v1's `recordSafetyOutcome` and v1.5's `gateAndCommit` are unchanged; the turn already sends each text's result as a core action (default 5).
- K-05: no new call and no new row. `commitTurn`, `readOpenHolds` (v1.3) and `readSafetyOutcomeOfEvent` (v1.4) are used as they are.
- K-34 v1: the commit writes `safety_outcomes` and `sealed_words` as today. K-06 v1: rows are keyed by the event id only. K-08 v1: no new span, kind or value.
- The actor's storage layout is not a contract: its tables are the runtime's own (arrival.ts lines 231 to 264; `runtime/src/actor/inbox.ts`; lease.ts), and 02-contracts lists none. `TurnDeps`, `LeasedTurn`, `LeaseHost` and `Ports` are the runtime's hand-written shapes, changed inside the runtime engineer's cards below. So no version card is needed, and no contract test changes.

### 5. Who builds what

Three cards for the runtime engineer, each inside `runtime/`. Nothing for the database engineer: no row is ruled. Order: card C and card A side by side (no file in common), then card B.

**Card A: the store** (the audit's STORE, order_d017.txt line 41)

- Reads: ADR-015 sections 1 to 3; `runtime/src/safety/arrival.ts`, `types.ts` and `rules.ts`; `runtime/src/gateway/seal.ts`; K-02 v1 `safetyResult` and `safety-no.json`.
- Gives: (1) the tables `safety_results`, `safety_closed` and the noted danger lines, in `createSafetyTables`; (2) the key carried in `Started` and `LateAnswer` from `queueRead`; (3) `applyResult`'s three steps of section 2 (the owed note with the pending note first; the seal; the keep step in place of lines 1170 to 1174), with lines 440, 1186 and 1219 unchanged; (4) the owed text in `unreadAmong`, `unreadTexts`, `routineHeld`, `waiting`, `onReturn`, `applyLate` (lines 970 and 1016) and `sendDanger`'s clears (lines 1362, 1385 and 1393); (5) the noted danger line on the direct path (lines 1372 to 1394); (6) `resultsOf(eventIds)` as section 3 answers; (7) `closeResults(eventIds)`, synchronous, for a caller's storage transaction; (8) nothing of a result in a span, log line, error or plain column.
- May touch: `runtime/src/safety/**`.
- Depends on: nothing unmerged. Never beside T-1245, which changes arrival.ts.
- Proves it with: `npm run test:workers -- runtime/src/safety`:
  - a No verdict on `safety-no.json`'s text keeps one row whose box opens, under the handle's key, the actor name and `result:<event id>`, to exactly the result the read port answered, and opens under no other event id or actor name nor as the text's words; no plain value in any of the actor's tables holds an evidence word, who is at risk, who wrote it or a danger word;
  - a danger verdict: its row is kept before the text counts as read; with the labels insert throwing, its line still goes; with the seal failing, the owed row keeps the text unread (`unreadAmong`, `unreadTexts`, `routineHeld`) while `finish` writes danger, and through an eviction after step 1 and a new instance's `resumeCutOff` (line 440), the danger stays pending, and its next re-read keeps the result, after which the text counts as read;
  - **the order "a crash or failed line during a danger, the turn ends, then the re-read":** a danger whose direct line fails, and separately one whose instance is evicted mid-line, then `closeResults([its id])`, then its 30 s re-read applying the danger again: no row for the text afterwards, the line's key in the direct double's sends is the noted one only, and the pending note clears once the line and record are done; and a text closed between step 1 and step 3 keeps nothing;
  - a re-read whose danger chooses another line than the first: the double's sends hold only the first line's key, and the queued record's `sentByActor` names it;
  - a timeout with no danger word and then a late verdict leaves the verdict in the row, kept before the unread hold lifts; a re-read with no verdict, a non-danger answer while a danger is pending and a second answer while one lands leave the row as it was; a danger applied again replaces it, and the earlier box stays until the new one is kept;
  - no row for words that open to nothing or cannot be opened; a new instance over the same storage answers a kept row;
  - `resultsOf` leaves out an id with no row, an owed row, a box moved onto another row and a result naming another event, and throws when the key store throws; `closeResults` takes exactly the named rows and closes them;
  - the span sink and the logs hold no word of a result.
  - Then `npm test`, lint (after `npm run contracts:types`), typecheck, format:check and guard:tests.
- Reviews: QA; the security reviewer (the seal and its key, held in memory only while a read is out, as the read's opened words already are, lines 180 to 196; the plain columns; the owed and closed paths).
- Estimate: 4 h.

**Card C: the keyword part never waits for a missing result** (round 1's runtime finding 2)

- Reads: ADR-015 section 3; `runtime/src/turn/turn.ts` lines 330 to 435 and 594 to 664; `turn.worker.test.ts` and `test-support.ts`; `actions/src/commit/hold.ts` lines 173 to 204; RULES 7.2.
- Gives: section 3's rule for a turn with keyword texts: the run goes past a missing result (lines 423 to 426) with the text left out of the records, and when the decided part cannot be made on that run (lines 428 and 430 to 431) the keyword texts commit through `keywordTurn` with no decided input; a turn with no keyword texts unchanged.
- May touch: `runtime/src/turn/turn.ts` (lines 411 to 435 only) and tests under `runtime/src/turn`, each named in the report.
- Depends on: nothing unmerged. Never beside card B, nor any other card that changes turn.ts.
- Proves it with: `npm run test:workers -- runtime/src/turn`: a batch of a decided text, a STOP and a text with no result commits on its first run, with the STOP's `recordStopOrStart`, the decided text's record, no record for the text with no result, and the decided input, and no rerun or park; the same with START and with HELP; the same batch whose targets read, frontier or decide fails commits the STOP core-only on its first run; a batch with no keyword text and a missing result still ends `noSafetyResult` with no frontier, decide or gate call; a turn of keyword texts alone is unchanged. Then `npm test`, lint (after `npm run contracts:types`), typecheck, format:check and guard:tests.
- Reviews: QA; the security reviewer (STOP, RULES 7.2).
- Estimate: 2 h.

**Card B: the turn reads it from its leased turn, and the lease removes it**

- Reads: ADR-015; card A's `resultsOf` and `closeResults`; `runtime/src/actor/lease.ts` (`LeasedTurn`, `LeaseHost`, `start`, `commit`, `holdForReply`, `replied`, `finish`, `lapse`, `park`) and `handle-actor.ts` (the lease host, `handOff`); `runtime/src/turn/turn.ts` lines 368 to 373 and 543 to 551, `types.ts` lines 639 to 663 and `test-support.ts`; `runtime/src/wiring/ports.ts`, `closed.ts`, `root.ts`, `real.ts` and `test-support.ts` where they hold `stateReads.turn.safety` or T-1242's `turnSafety`; `runtime/src/outage/db/outage.ts` lines 325 to 346.
- Gives: (1) `LeasedTurn.resultsOf`, as section 3 rules it, and the turn's safety step reading it; `TurnDeps.safety` and `Ports.stateReads.turn.safety` removed, with T-1242's `RootOptions.turnSafety`, `StateReadInputs.turnSafety` and `realStateReads`' `resultsOf` (task/T-1242, 90d6019, its architect review's note N1); (2) `closeResults` called for a turn's event ids inside each storage transaction that ends the turn for good, and at no other lease step (section 2); (3) the PostgreSQL-down hand-off calling it for the texts that path took alone.
- May touch: `runtime/src/actor/lease.ts`, `runtime/src/actor/handle-actor.ts`, `runtime/src/turn/types.ts`, `turn.ts` (lines 368 to 373 and 543 to 551 only) and `test-support.ts`, `runtime/src/wiring/ports.ts`, `closed.ts`, `root.ts`, `real.ts` and `test-support.ts` (the turn's deps and T-1242's input only), and tests under `runtime/src/actor`, `runtime/src/turn` and `runtime/src/wiring`: new ones, and those that pin `TurnDeps.safety` or `stateReads.turn.safety` (such as `turn.worker.test.ts` lines 843 to 854 and `root.test.ts` line 240), each named in the report.
- Depends on: card A and card C; T-1242 and T-1243 merged (they change root.ts, ports.ts, closed.ts, real.ts and test-support.ts). Never beside T-1244 (root.ts, test-support.ts).
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/turn runtime/src/wiring`, through the hop rig with the real actor and store and no `resultsOf` double:
  - the JOIN turn's gateAndCommit request carries in its `recordSafetyOutcome` exactly the result the safety double answered for JOIN; a crash before the commit gives a rerun whose request carries the same result; a crash after the commit, before the reply ends, gives a rerun that reads the same result, whose commit answers repeated and composes only rows with no plan;
  - once the reply ends the turn's rows are gone and its texts closed, and a later turn's rows are kept; a park removes them; a restart keeps them for the restart's run; a run asking for an id outside its turn gets nothing for it;
  - a danger text whose line fails, in a turn that commits and whose reply ends, then its 30 s re-read: no row for it afterwards;
  - a text whose row is gone before the run gives no frontier, decide or gate call (`noSafetyResult`), and its third lapse parks the turn with its one "nothing changed" row;
  - a STOP taken while PostgreSQL is down has its row removed and its text closed at the hand-off; a STOP in a turn with PostgreSQL up is recorded with its result.
  - Then `npm run test:e2e -- skeleton` (after `npm run db:up`), unchanged and green, `npm test`, lint (after `npm run contracts:types`), typecheck, format:check and guard:tests.
- Reviews: QA; the architect (the seam against this record); the security reviewer (what is removed when, and the missing-result path).
- Estimate: 4 h.

**Notes for the lead on existing cards:**

- T-1242 (passed, in train 117) added a RootOptions input for `resultsOf`. Under this record the turn reads results from its leased turn, so card B removes it (above).
- The audit's state-reads card (order_d017.txt line 42) binds `partyOf`, `idsOf` and `isStopped` only, and no longer waits for the store. T-570 needs cards A and B: without them every run of the JOIN turn ends at turn.ts lines 423 to 426. Card C is not on T-570's path; it keeps RULES 7.2 once results can be missing.

## Consequences

- The commit records the very K-02 result the actor read and acted on, with no second model call, and the person's words in it are sealed under a per-person key from the read to K-34: in the actor under the handle's key, in K-34 under the person's.
- No text whose applied result is not kept counts as read; a danger whose result is not kept stays pending and is read again until it is.
- The actor holds one sealed row per text in flight, only until its turn is done; a text whose turn has ended never gets one again, and deleting the handle's key erases a text and its row together.
- A STOP, START or HELP commits on the run that carries it, whatever result is missing.
- A text's danger line goes once from the actor's direct path, whatever later reads choose.
- The hop rig's results come from the real arrival path once card B lands, so the hop and skeleton tests prove the store end to end instead of a double's second answer.
- Not changed here: the danger path's own record on arrival (K-09 v1.1 default 36, journey 3's lane). When it is built, a danger text's batch-turn record answers repeated (K-09 README line 394), and the kept result still rides as that core action.
- A parked turn's texts get no K-34 outcome row, since K-05 v1 parkTurn carries no core actions (types.ts lines 563 to 572), and their kept results go with the park.

## Alternatives not chosen

- **A K-05 row written at arrival** (a new table, or K-34's row before the turn): K-34 holds a text's outcome to a turn (0016 lines 81 to 83) and K-09 v1.1 refuses an arrival record of No (README line 395), so it needs a migration and a minor version for a second home of one fact; it puts a database write on the arrival path, where the danger line must not wait (arch 04 line 211) and which must work while PostgreSQL is down (arch 11 line 566); and with no person known, K-34's key is not there to seal under (K-34 README line 29).
- **Every text recorded on arrival in its own arrival turn** (K-09 v1.1's `actorOnArrival` widened to No): K-09 keeps No out on purpose (default 36), it costs a K-05 transaction per text on the arrival path, it writes K-34's row under the arrival turn instead of the turn the text joins (default 5), and it does nothing while PostgreSQL is down.
- **Reading the text again for the commit** (a second model call): the commit must record the result the actor acted on; a second read can differ, costs a model call per text per run, and fails while the AI provider is down (arch 11 line 564).
- **Memory only:** an eviction loses it, and a rerun after a lapse (arch 11 line 576) must read the same result.
- **The actor's storage unsealed, or labels only:** unsealed keeps a person's words outside a per-person key (arch 01 line 93; RULES 4.10). Labels only is not the result K-09 takes, and rebuilding a result from labels makes one up.
- **A column on the inbox row:** the inbox keeps the event as the gateway handed it and never opens a box (`runtime/src/actor/inbox.ts` lines 6 to 7), and a result is replaced and removed on its own life while the text is kept.
- **KV or R2:** not transactional with the actor's storage, eventually consistent (KV takes about 60 s: arch 10 line 518), and one more place for a person's words.
- **An isolate-wide `resultsOf` bound by the root:** an isolate serves many actors, and reaching one actor's storage needs module state shared across Durable Objects that could hand one handle's results to another.
- **A result not kept marked by the danger flag** (writing danger 0, or skipping `markDanger` and `finish`'s flag): the flag also closes the open batch at once (batch.ts lines 308 to 312), `resumeCutOff` sets it again (line 440), and the late path makes a text read by replacing its unread hold (`writeHold`, lines 1301 to 1323), so no flag survives every path. **Keeping the unread hold as the mark:** a text has one hold row, and a danger's hold must replace it. A separate owed row, which none of them writes, does.
- **A result written after its turn and removed by a later sweep:** it would keep a person's words for no commit until the sweep; the closed note refuses it in the same step instead.
- **A direct line keyed by the text alone** (`safety:<event id>:danger`): the queued record's `sentByActor` would name a line Linq may not have sent, and the port's own rule is one key per event and line (types.ts line 230). Noting the first chosen line keeps both.
- **`resultsOf` as an eager field of the leased turn:** section 3.

## Open points (proposed for QUESTIONS.md, each with its default)

1. **A text whose words open to nothing** (an empty or spaces-only body or subject, which the gateway seals: `runtime/src/gateway/hand-off.ts` lines 187 to 198; the read finds nothing: arrival.ts lines 848 and 882 to 885) has no K-02 result. Its blast radius is its whole turn: with no keyword text, every run of the turn ends `noSafetyResult` and the third lapse parks it, taking the batch's other texts (up to three, or a restart's union) with it; with a keyword text, the keyword texts commit (card C) and every routine part is held. Default: unchanged, failing closed. To rule: whether such a text needs a record at all, on both the turn's side and the commit's (K-02 has no shape for nothing to read; K-34 holds a row per read text). Owner: the architect with the runtime and action-layer engineers.
2. **A turn whose keyword texts commit while a text has no kept result** leaves that text out, so K-34 never holds its outcome. Default: unchanged (a stop never waits: RULES 7.2; arch 06 line 329).
3. **Two danger reads of one text that differ:** ruled in section 2.
4. **A text read before card A is deployed** has no row, so a turn that decides it parks once, or with a keyword text commits it with routine parts held. Default: accepted; no staging turn runs today (the turn's directory is closed: closed.ts line 52), and production runs nothing.
5. **A stricter outcome a later read finds once K-34 holds a text's first record** binds the actor's hold, but who is told follows K-34's first row. Default: the first record stands (K-09 v1's repeat rule). Owner: the architect with the security reviewer.
6. **A direct line whose answer was lost, then the core answering a later application** sends the core's own outbox line too: the noted line rules the direct path only, and the outbox row has keys of its own. Default: unchanged (two safety lines are the safer failure than none: RULES 4.12). Owner: the runtime engineer with the action-layer engineer.

## New tasks found (recorded, not fixed here)

- **Retention of the actor's storage:** the inbox's sealed texts (inbox.ts; never deleted), the safety read's labels rows, `safety_events` and `safety_holds`, and this record's closed notes and noted lines have no rule that removes them, while RULES 4.10 and arch 10 line 516 promise 45-day deletes. Owner: the architect for the rule, then the runtime engineer.
- **The keyword texts beside decided ones with every result present** still wait on the decided part: the targets read failing (turn.ts line 428) or the frontier, decide or re-read failing (lines 430 to 431) ends the run with the STOP uncommitted, and a park after three such runs records no STOP (K-05 v1 parkTurn carries no core actions). Card C covers only the missing-result case, because a retry there may find the decided part ready. Owner: the lead, for the trade-off, then the runtime engineer.
- **The commit names every event of the turn** whose record is not in the commit (turn-face/commit.ts lines 231 to 232), and K-34 holds no row for an event the safety read never reads (a customer's tapback: arrival.ts line 267), so a turn with a tapback holds every routine part (hold.ts line 183), though K-05 README item 34 names "the turn's texts". Checked in the code, not run. Owner: the action-layer engineer.

## Sources

- Build prompt section 10, D-017; 3.3 and 6.4 (contracts; a gap is never filled by a guess); 7.5.
- `ops/reviews/D-017-path-audit/order_d017.txt` (section 0's `resultsOf` line, line 8; STORE, line 41; the state reads, line 42; R3, line 75) and `audit_actor-entries.txt` (part a item 3); `ops/cards/T-1241.md` (round 1's verdicts), `T-1242.md`, `T-1245.md`; DL-492, DL-495, DL-497, DL-499.
- Architecture (`scratch/text/architecture.txt`): 01 lines 61 and 93; 02 lines 111, 113 and 115; 04 line 211; 06 lines 317 to 329; 09 line 492; 10 lines 502, 504, 516 and 518; 11 lines 564, 566 and 576.
- Master Corrections: no line names the safety read, its result or sealing (its one safety line, G1, is about the trade files' stop-word spellings); C1 keeps a STOP for every business (RULES 7.2, 7.5), which section 3 relies on.
- RULES 4.5, 4.10, 4.12, 7.2, 7.5, 7.6 and 7.8.
- Contracts: K-02 v1 (`contracts/model/model.v1.schema.json` lines 1453 to 1595); K-05 README items 1, 34 and 37; K-08 README line 79; K-09 README defaults 5, 10, 35 and 36 (lines 253, 258, 292, 390 to 395 and 429) and `tool-api.v1.schema.json` line 2395; K-34 README line 29 and rule 6, `db/migrations/0016_safety_incidents.sql` lines 16 to 21 and 52 to 112; QUESTIONS.md NQ-RT-1 and CQ-65 (DL-119, DL-127, DL-132).
- Code on main 58acd53: `runtime/src/safety/arrival.ts`, `rules.ts`, `types.ts`; `runtime/src/turn/turn.ts`, `types.ts`, `turn.worker.test.ts`; `runtime/src/actor/lease.ts`, `handle-actor.ts`, `inbox.ts`, `batch.ts`; `runtime/src/guard/guard.ts`; `runtime/src/outage/db/outage.ts`; `runtime/src/gateway/seal.ts`, `hand-off.ts`; `runtime/src/wiring/ports.ts`, `closed.ts`, `picks.ts`, `root.ts`, `root.test.ts`, `test-support.ts`; `actions/src/tool-api/turn-face/commit.ts`; `actions/src/commit/hold.ts`, `commit.ts`; `actions/src/domain/safety/record.ts`; `db/repo/turn-face-reads.ts`.
