# ADR-017: How long the handle actor keeps what it stores

- Status: proposed, default in use (T-1265; ADR-015's new task "Retention of the actor's storage", the lead's card under DL-508 with its note DL-524)
- Date: 2026-11-12
- Owner: architect. Decides: the CTO, with the security reviewer for the open points marked for them.
- Contracts: none changes. The actor's tables are the runtime's own, and 02-contracts lists none of them (ADR-015 section 4). `forget` (section 5) is a method of the handle actor written by hand, as `accept` is (`runtime/src/gateway/types.ts` lines 100 to 116).
- This record changes nothing by itself: section 8 names the runtime cards that build it. Not here: the database's own 45-day deletes and the job that runs them (C-156's database cards).

Every line number below was read on main 4062130. T-1262 (886e82c) is the last change to `runtime/src/safety/arrival.ts`, `runtime/src/actor/inbox.ts`, `lease.ts` and `handle-actor.ts`. "Arch NN line L" is a line of `scratch/text/architecture.txt`; "RULES" is `1 Read First/RULES.md` in the master folder; "0016" and the like are files in `db/migrations/`.

## Context

### What the sources promise

- **RULES 4.10** (lines 233 to 235): "Records and every yes are kept 7 years, or longer where the trade's rules say. A copy or delete is done in 45 days after a check it is the person (one 45-day extension, with the reason) ... The "don't text me" record and the proof of every yes stay." The 45 days run from a person's checked request, not from a text's arrival, and two records outlive a delete.
- **RULES 4.5** (lines 199 to 202): "Never kept at all: full card numbers outside the card box, full Social Security numbers, passwords. If one comes anyway: not repeated, deleted, said once where it goes." The gateway swaps card numbers and Social Security numbers for a tag "before any write" (arch 02 line 109), so the actor never holds them; anything else a person types reaches the actor sealed.
- **Sealing.** "Encrypted under a per-person key. Deleting the key erases the data (RULES 4.10)" (arch 01 line 93). The event log "is sealed per person: deleting one key erases their private details, while consent proofs survive as hashes and the words shown" (arch 09 line 492). "Privacy | Cards and SSNs scrubbed at the edge; private data sealed under a per-person key | "Never kept" and 45-day deletes hold, even with an append-only log" (arch 10 line 516). `ops/plan/01-inventory.md` C-156 (line 264): "Private data sealed under one key per person; deleting the key erases it; ... "never kept" and 45-day deletes hold with an append-only log" (owner: the database engineer).
- **The database side's two ways.** A sealed value goes with its key: `erasePerson` empties the person's wrapped key, "so nothing that was sealed under that key can be opened again, by this code or by anyone holding the wrapping key" (`db/repo/sealing.ts` lines 9 to 11 and 312 to 347; 0003 lines 4 to 7 and 21). A plain value is deleted: "A person's name, handle address and message words are plain, and the 45-day delete (RULES 4.10) erases them by the sealing-key job (C-156) deleting or redacting them" (K-04's open gap, `contracts/db-schema/core/README.md` line 112; the same for K-28's plain columns, 0027 lines 44 to 48). K-34 seals a safety outcome's words and keeps its labels plain, "so the gate, the actor's danger-first order and the gold set read them without the person's key" (0016 lines 16 to 21).
- **No guess:** a gap the sources leave is an open point with its default (build prompt 3.3, as `.claude/agents/architect.md` line 30 states it).

### Whose key the actor seals under

The gateway seals each event under the handle's key, "made on first sight and linked to the person once known" (NQ-RT-1's default, as `runtime/src/gateway/seal.ts` lines 1 to 2 quote it). On K-04 a key is a person's, so the handle's key is the oldest held key among the handle's people; once every person on the handle has had their key erased, the next key call makes a person with no name and a new key, and "the erased keys stay erased" (`db/repo/handle-keys.ts` lines 4 to 18 and 213 to 224). One handle can be several people (arch 01 line 55).

### What the actor is for

One Durable Object per handle: "ordered inbox, safety read on arrival, batching, turn lease, clock alarm" (arch 01 line 57). It keeps a text until its turn has used it ("the turn reruns from its sealed texts": arch 01 line 61; arch 02 line 113; arch 11 line 576), the safety read's state until a danger's line and record are done (arch 02 line 111; ADR-015 section 2), and what the PostgreSQL-down path needs: "Turns queue in order in each handle's actor, which keeps the stopped flag ... Safety and STOP lines go from the actor and are written on return" (arch 11 line 566). It is no system of record: for that, arch 10 line 504 chose PostgreSQL over "Durable Object storage alone".

### What it holds, sealed and plain

- **Sealed under the handle's key**, each box with additional data of its own, so that it opens only in its own place: an inbox event's words (`<actor name>|<event id>`: seal.ts lines 86 to 88 and 121 to 136; inbox.ts lines 6 to 7), a kept safety result (`result:<event id>`: arrival.ts lines 224 to 228 and 1236 to 1261) and a record queued for PostgreSQL's return (`return:<key>`: arrival.ts lines 1539 to 1566; `runtime/src/outage/db/outage.ts` lines 959 to 981). A live safety timer's address is K-34's own box, under its own person's key, copied as it is (`runtime/src/actor/copies/copies.ts` lines 28 to 30 and 255).
- **Plain:** every other field of a stored event, which the actor orders, dedupes and routes on "in the clear" (`runtime/src/gateway/types.ts` lines 63 to 78), the handle's address among them, and a poll vote's option words, which nothing seals yet (QUESTIONS.md CQ-58, line 214); the actor's own name, which is the handle's kind and address (seal.ts lines 68 to 71), kept in `safety_meta` and `outage_meta` (arrival.ts lines 413 to 416; outage.ts lines 262 to 265); event ids, trace ids, Linq ids, K-04 ids, times and labels; and the bundle's own words (a noted danger line, the copied lines and keywords).

### What deletes it today

The handle actor's constructor makes every table (handle-actor.ts lines 218 to 322). Only these rows are ever deleted today: a kept result (`closeResults`, arrival.ts lines 774 to 797, which no lease step calls yet: ADR-015's card B, T-1264, is not merged); a danger's pending note with its noted line and line-done note (`clearDangerPending`, lines 1330 to 1345); a re-read's time (lines 1156 to 1161 and 1339 to 1344); a record the core took (`runtime/src/actor/copies/return-queue.ts` lines 277 to 298); the outage path's rows of texts a commit took (`prune`, outage.ts lines 1043 to 1065); trace counts past the newest 64 (handle-actor.ts lines 176 to 180 and 853 to 857); and the state each owner replaces or clears itself (the lease, the schedule's entries, the outage state, a held turn, the copies). Everything else stays for good: the inbox's words and plain fields, receipts' ids (but a failed hook's: inbox.ts lines 91 to 94), the safety read's events, labels, holds, closed notes and name, the batch window's and the lease's bookkeeping, the pins and the handle's ids. `lease_turns` is kept on purpose, its newest `seq` being the lease's turn order (handle-actor.ts lines 616 to 626; DL-427).

### ADR-015's new task

"The inbox's sealed texts (inbox.ts; never deleted), the safety read's labels rows, `safety_events` and `safety_holds`, and this record's closed notes and noted lines have no rule that removes them, while RULES 4.10 and arch 10 line 516 promise 45-day deletes. The rule must keep a text's closed note for as long as its danger is pending (on staging, for good while the core refuses the arrival record and `linqDirect` is closed): a closed note removed sooner lets the next danger re-read write a row again for a text no commit can take" (ADR-015 line 216). T-1262 added `safety_line_done`, which `closeResults` reads to clear a danger whose line and record are done (arrival.ts lines 300 to 309 and 774 to 797; DL-524).

## Decision

### 1. The rule's shape

- **A row is kept only while something the actor does can still read it**, and goes at the first sweep after that (sections 2 and 6). The 7 years of RULES 4.10 are PostgreSQL's records (K-04's turns, K-34's outcomes, the event log), never the actor's.
- **A person's words are in the actor only sealed under the handle's key**, so erasing that key erases them wherever they lie, at once (section 4). No deletion here is needed for that. Deletion is needed for the plain fields, and so that a text no key opens any more holds no work and wakes no alarm.
- **The plain fields that name a person** (the handle's address, a vote's option words) go with their text's rows (section 2), and at a person's 45-day delete through `forget` (section 5), as the database's plain columns go by C-156's job (K-04 README line 112).
- **Two things outlive every rule here, as on the database side:** the stopped flag's copy, since the "don't text me" record stays (RULES 4.10); and an open outcome hold with its labels, which binds every commit while it is open (QUESTIONS.md CQ-65 as DL-119 replaced it, line 221; arch 06 lines 325 and 327) and is labels only, as K-34's is (0016 lines 16 to 21).

### 2. A text's rows: kept until it is settled

An event E in the inbox is **settled** when all five hold:

1. **Its turn is over:** `safety_closed` holds E, because its turn ended for good or the PostgreSQL-down hand-off took it alone (ADR-015 section 2, "Removed"; T-1264 calls `closeResults` with the turn's event ids); or E starts no turn (Rosie's own reaction: inbox.ts line 19), so nothing reads it again but the duplicate check.
2. **Its safety work is over:** E has no `safety_events` row, or its row is `done`, or `lineFailed` with its danger flag set; and E has no `safety_pending`, `safety_line_done`, `safety_noted_lines`, `safety_reread` or `safety_results` row and no unread hold not released. Each of those still has the actor read E again or send for it (`waiting`, arrival.ts lines 575 to 595; `dangerPending` and `resultOwed`, lines 1177 to 1195).
3. **The PostgreSQL-down path no longer follows E:** E has no `outage_texts` row. That path reads E's stored text until a commit takes it (outage.ts lines 576 to 610 and 822 to 864) and drops its own row after (`prune`).
4. **No queued write is keyed by E** (`recordSafetyOutcome:E`, `sendFixedLine:E` or `recordStopOrStart:E`), waiting or refused: the replay of a STOP or START reads E's inbox row for its handle (outage.ts lines 371 to 374).
5. **Nothing holds E for a turn:** E is not among the batch window's texts not handed on (`runtime/src/actor/batch.ts` lines 560 to 569) or the lease's texts no commit has taken (lease.ts lines 1060 to 1076).

**Once E is settled, the sweep (section 6) deletes E's rows**, in one storage transaction:

- **The inbox row**, replaced by a **tombstone** (`inbox_gone`: E's event id, trace id and the time it went). A provider's retry is still dropped by its event id (arch 02 line 109: "Known event id: 200, dropped"; "Linq retries for 30 minutes"), and `firstTraceOf` still answers the first trace (handle-actor.ts lines 394 to 401). A tombstone holds no words and no address, and goes 24 hours after (open point 2). A receipt's id (`seen_receipts`, inbox.ts lines 81 to 94) gets the time it was seen and goes 24 hours after, for the same reason.
- **The safety read's rows:** `safety_events`, `safety_closed`, E's released holds and its outcome labels (`safety_outcomes`). An outcome hold still open stays, with its labels, until it is released, and both go at the first sweep after: `openHolds` reads only open holds, with their labels (arrival.ts lines 668 to 687), and a released hold binds nothing (handle-actor.ts lines 426 to 434). A threat's hold is never released (arrival.ts lines 835 to 836; arch 06 line 325), so it stays as labels while the actor lives, as K-34's row does.
- **The turn's bookkeeping:** `batch_items`, `batch_reads` and `batch_span_texts` of E, and a `batches` row with no item left; a `lease_batches` row once every item of it is settled; a `lease_turns` row in a final state (committed and holding no lease, parked, or replaced) once every item of it is settled, **never the newest row**, whose `seq` is the lease's turn order (DL-427; handle-actor.ts lines 616 to 626); and, with each turn row removed, its `lease_commit_handles`, `turn_bundles` and `batch_spans` rows.
- **The queue's done keys that name E** (`return_done`: return-queue.ts lines 123 to 124 and 286 to 291): nothing queues a write for a settled text again.

**The closed note lives exactly as long as ADR-015 needs.** It goes only with E's other rows. A danger still pending keeps E unsettled (condition 2 reads `safety_pending`, `safety_line_done` and `safety_noted_lines`), so the note stays while the danger is pending; on staging, for good, while the core refuses the arrival record and `linqDirect` is closed (ADR-015 line 216). Nothing can keep a result for E after its note goes: a re-read or a resumed read finds a text only through its `safety_events` row (arrival.ts lines 462 to 471 and 581 to 595), which goes in the same transaction, and an answer already out when E settles is dropped by `applyLate`'s first check, E being neither pending, held unread nor owed (line 1109).

**A text with no end but `forget`** keeps all its rows, words included: a read left unresolved (`giveUp`, arrival.ts lines 597 to 603), a text that arrived unwired, a danger pending for good, a write the core refused (QUESTIONS.md CQ-104 (e), line 260: "the rank stays held"), a turn left at its third lapse with no park wired (lease.ts lines 866 to 882). Each already holds routine work and fails closed. This record keeps that, and `forget` ends it at a person's 45-day delete (open point 4).

### 3. Every table's rule

Each table the actor's storage holds, what keeps it, what deletes it, and what `forget` (section 5) does to it.

**The inbox** (inbox.ts lines 33 to 49; handle-actor.ts line 873)

- `inbox`: kept until its text is settled; then the sweep replaces it by its tombstone. `forget`: goes.
- `inbox_gone` (new): kept 24 hours; the sweep. `forget`: kept until its 24 hours end.
- `seen_receipts`, with the time each id was seen (new): kept 24 hours; the sweep. `forget`: kept until its 24 hours end.
- `trace_seq`: the newest 64 traces, as today (`beginTraceSeq`'s trim). `forget`: goes.

**The safety read** (arrival.ts lines 263 to 310)

- `safety_events` (event id, arrival time, state, danger flag, the line's path and id, the time to hand-off): until settled; the sweep. `forget`: goes.
- `safety_meta` (the actor's name: the handle's kind and address): while the actor exists, as K-04 keeps the address plain until the 45-day delete (QUESTIONS.md CQ-26, line 182; K-04 README line 112). `forget`: goes, with the name the safety read holds in memory, so the next hand-off writes it again (arrival.ts lines 413 to 416 write it only when the name in memory differs).
- `safety_holds`: an open outcome hold until the core's release (`markHoldReleased`, `releaseAtOnce`: arrival.ts lines 830 to 850 and 1786 to 1806), an unread hold until a verdict lifts it (line 1150); then the sweep, once its text is settled. `forget`: open outcome holds kept; unread and released holds go.
- `safety_outcomes` (labels): while its text is unsettled or its outcome hold open; the sweep. `forget`: kept beside an open outcome hold; else goes.
- `safety_reread`: while its text waits for a read; `applyLate` and `clearDangerPending`, unchanged. `forget`: goes.
- `safety_pending`: while the danger is not complete; `clearDangerPending`, unchanged. `forget`: goes.
- `safety_results` (sealed): until its text is closed; `closeResults` (ADR-015; T-1264). `forget`: goes.
- `safety_closed`: until settled, and so for as long as its danger is pending; the sweep. `forget`: goes.
- `safety_noted_lines` (the bundle's line id and words, never a person's): while the danger is pending; `clearDangerPending`, unchanged. `forget`: goes.
- `safety_line_done`: while the danger is pending and its result unsettled; `clearDangerPending`, also through `closeResults`, unchanged. `forget`: goes.

**The batch window** (batch.ts lines 151 to 154 and 199 to 225)

- `batch_items`, `batch_reads`, `batch_span_texts`: until settled; the sweep. `forget`: go.
- `batches`: until no item of it is left; the sweep. `forget`: goes.
- `batch_spans` (turn ids): until its turn's row goes; the sweep. `forget`: goes.
- `batch_schedule` (one due time per kind: the batch window's, the lease's, the safety read's, the clocks', the outage path's, and section 6's `retention`): each owner sets and clears its own entry, unchanged. `forget`: kept; each owner clears its entry once nothing is left.

**The lease and the pin** (lease.ts lines 375 to 412; `runtime/src/bundle/pin.ts` lines 150 to 160)

- `lease_batches`: until its turn is over and every item settled; the sweep. `forget`: goes.
- `lease_turns`: until final with every item settled, never the newest row; the sweep. `forget`: the newest row stays with its items emptied; the rest go.
- `turn_lease`, `lease_held`: the lease's own steps, unchanged. `forget`: refused while a lease is live (section 5); a lapsed lease and held turns go.
- `lease_commit_handles` (a turn's K-04 handle id) and `turn_bundles` (a turn's bundle id): until their turn's row goes; the sweep. `forget`: go.

**The copies and the write-on-return queue** (copies.ts lines 225 to 294; return-queue.ts lines 110 to 134)

- `copy_stopped`, `copy_note`, `copy_lost_commits`: the copies' own rules (DL-167, DL-427, DL-431: copies.ts lines 6 to 23), unchanged; the stopped flag's copy is the "don't text me" record's, which stays (RULES 4.10). `forget`: kept.
- `copy_lines`, `copy_keywords`: the bundle's words, replaced on each refresh. `forget`: kept.
- `copy_timers`, `copy_meta`: the live safety timers K-34 holds, replaced on each reload (copies.ts lines 28 to 36). `forget`: kept; K-34's own rules govern its timers, and each address is sealed under its own person's key.
- `return_queue` (sealed): until the core takes the write (return-queue.ts line 286); a write the core refuses keeps its place and, in the danger and stop ranks, holds its rank (lines 15 to 25; CQ-104 (e)). `forget`: refused while a write waits for the core (section 5); refused stop writes kept; refused danger and rest writes go.
- `return_done`: until the text its key names is settled; the sweep. `forget`: goes.
- `return_held`: until its rank is written (line 295), unchanged. `forget`: the stop rank's row kept; the others go.

**The PostgreSQL-down path** (outage.ts lines 170 to 212)

- `outage_state`: while PostgreSQL is known down, unchanged. `forget`: refused while it exists.
- `outage_texts`: until a commit takes the text (`prune`), unchanged. `forget`: goes.
- `outage_timers`: while its timer is copied (`prune`), unchanged. `forget`: kept, with the copied timers.
- `outage_ids` (K-04 handle, business and person ids) and `outage_meta` (the actor's name): while the actor exists, as K-04 keeps them. `forget`: go.

**The clocks** (`runtime/src/clocks/actor-clocks.ts` lines 58 to 61)

- `clock_handle` (K-04 handle id): while the actor exists. `forget`: goes; the arming names the handle again (lines 84 to 97).

### 4. How a deleted key erases what the actor sealed

- **What is sealed, and under what.** The three boxes the actor stores (an inbox event's, which the gateway seals, and a kept result and a queued record, which the actor seals) are sealed under the key the key store answers for the handle at the time of the seal (seal.ts lines 34 to 47; arrival.ts lines 962 to 995, 1243 to 1261 and 1545 to 1566; outage.ts lines 604 to 610 and 965 to 981): the oldest held key among the handle's people. The actor stores no key. It asks the key store at each seal and open, and holds a key in memory only while a read is out (arrival.ts lines 194 to 205; ADR-015 section 2, step 2).
- **What erasing does.** Once `erasePerson` has erased the person whose key it is, every box sealed under that key, in every row that holds one, is unreadable for good, with nothing done in the actor (arch 01 line 93; sealing.ts lines 9 to 11). The next key call answers another key, the handle's next held key or a new one (handle-keys.ts lines 13 to 18), under which no old box opens: AES-GCM refuses it (seal.ts lines 138 to 160). K-34's box in a timer copy goes the same way, by its own person's key.
- **What it leaves.** The plain fields are untouched by any key. And a text in flight whose box no longer opens becomes work with no end: its read and re-reads find it unreadable, so its unread hold stays and it is read again every 30 s for good (arrival.ts lines 962 to 995 and 1133 to 1141); a turn cannot read it; a queued record of it is refused `unopened` and, in the danger or stop rank, holds its rank (arrival.ts lines 888 to 899; outage.ts lines 381 to 392; return-queue.ts lines 15 to 20). So the 45-day delete needs `forget` as well as the key.
- **A handle of several people** (arch 01 line 55): the actor seals under one person's key, so erasing another person's key erases nothing the actor holds. That person's texts in it go as they settle, and the rest by `forget`, which removes every text of the handle (open point 3).

### 5. `forget`: the 45-day delete reaches the actor

`forget()` is a call on the handle actor, for C-156's job. It answers **`notNow`**, with one label and nothing changed, or **`forgotten`**, with counts: labels and counts only, never an id or a word.

**`notNow`, while deleting could lose what must not be lost:**

- `turnRunning`: a turn holds the lease and its lease has not lapsed (`turn_lease.until_ms` after now). A run may be reading the texts.
- `readOut`: a safety read or re-read is out in this instance. Its answer would write rows after the delete.
- `returnsWaiting`: PostgreSQL is known down (`outage_state`), or the write-on-return queue holds a write the core has not answered (no refusal). A STOP's record waits there, and the "don't text me" record must reach PostgreSQL before the key that seals it goes (RULES 4.10; RULES 7.2, lines 312 to 315: "It stops texts from the number it answers, at once").
- `textsOpen`: a text whose words still open under the handle's key now waits for a turn (condition 5 of section 2), or has a danger pending. A STOP among them must still be recorded, and a danger's line must still go (RULES 4.12, lines 244 to 247). A text with no words, or whose words no longer open, never holds `forget` back: nothing can read it again, so nothing waiting on it can happen.

**`forgotten`:** in one storage transaction, which repeats every check but the key's (an open is asynchronous: if the texts it checked changed meanwhile, the answer is `notNow` `textsOpen`), every row of the actor's storage is deleted except:

1. the stopped flag's copy and what keeps it reading stopped: `copy_stopped`, `copy_note`, `copy_lost_commits`, the stop rank's refused writes and its `return_held` row (the "don't text me" record stays: RULES 4.10; arch 11 line 566; CQ-104 (e)). These are labels, and boxes the erased key leaves unreadable;
2. each open outcome hold and its labels (section 1);
3. the bundle's words: `copy_lines`, `copy_keywords`;
4. the copies of the live safety timers, `copy_timers`, `copy_meta` and `outage_timers`, which K-34's own rules govern;
5. the newest `lease_turns` row, with its items emptied (DL-427);
6. the tombstones and receipt ids whose 24 hours have not ended: event ids and trace ids only, so a provider's retry is still dropped (arch 02 line 109);
7. the stored schedule, whose entries their owners clear once nothing is left.

Everything else goes: every inbox row, so every text's words and plain fields, the handle's address among them; every other row of the safety read, the batch window, the lease and the pin; the actor's name (`safety_meta`, `outage_meta`, and the name the safety read holds in memory) and the handle's ids (`outage_ids`, `clock_handle`, `lease_commit_handles`); `outage_texts`, `trace_seq` and `return_done`; the queue's refused danger and rest writes. The safety read's schedule entry is then set again from what is left (nothing is left to read). After `forget`, the next hand-off writes the actor's name again and runs as on a new actor.

**The job's order** (for C-156's job card, which the lead writes): for each handle of the person, read before anything is redacted, (1) `forget` until `forgotten`; (2) `erasePerson`; (3) `forget` again until `forgotten`, for what arrived between (1) and (2), whose words the erased key no longer opens; (4) the database's own deletes and redactions (K-04 README line 112). A step answered `notNow`, or failing, is tried again later, all within RULES 4.10's 45 days. Step (1) comes before (2) so that a STOP in flight or queued is recorded before its key goes. The waits are short: a lease lasts 60 s and a turn starts at most 3 times (lease.ts lines 79 to 82), a read's deadline is 4 s (arrival.ts line 4), and while PostgreSQL is down the job cannot erase a key anyway.

### 6. When the sweep runs, and its bounds

- **What it is:** one synchronous storage transaction in the handle actor, which finds the settled texts (at most 50 a sweep, in arrival order), deletes their rows (section 2), deletes the tombstones and receipt ids past their 24 hours and the released holds and labels of settled texts, and sets the stored schedule's `retention` entry. A throw changes nothing and sets the entry an hour on.
- **When it runs:** after each storage transaction that ends a turn for good (the reply ended, a commit with no reply, a park, alreadyCommitted, `turnParked`, a reply given up: the steps where T-1264 calls `closeResults`), after it and never inside it; after the PostgreSQL-down hand-off; after each text's safety work settles and each late answer is dealt with (the actor's `afterLate` and `settleAfter`, handle-actor.ts lines 235 to 245 and 529 to 542); after each check of the PostgreSQL-down path (its `arm` call, handle-actor.ts line 308); and at the end of every alarm.
- **The `retention` entry** is due at the earliest of: at once, when the 50 left settled texts behind; an hour on, while any inbox row is unsettled, so that a text settled by a path none of the above follows is swept within the hour; the end of the earliest tombstone or receipt id. It is removed when none of these applies, so an actor with nothing left sets no alarm for it.
- **What it writes:** no span and no log line. Nothing of a text is logged or put in a span (arrival.ts lines 50 to 51), and the sweep has nothing else to say.

### 7. What a test can measure

- **The whole storage, by a scan:** every table the actor's storage holds, read from `sqlite_master` (never a fixed list), every row as text. After a sweep, a settled text's event id appears only in its tombstone, the newest `lease_turns` row, an open outcome hold's two rows and the stopped copy's note while the copies keep it (`copy_note`, copies.ts lines 277 to 284). After `forgotten`, no row outside section 5's survivors holds an event id, a box or the handle's address, and the survivors are unchanged. A table the scan finds that this record does not name fails the test, so a table added later gets its rule first.
- **Each condition of settled, alone:** cases in which exactly one condition fails (still reading; unwired; unresolved; a pending note, a noted line or a line-done note; a re-read; an open unread hold; an owed result; an outage row; a waiting write; a refused write; in the batch window; in the lease; not closed) keep the text whole; with none failing, its rows go.
- **ADR-015's exception:** a danger whose line fails, in a turn that ends, keeps its closed note, pending note, noted line and words; its re-read 30 s later sends the noted line; the sweep at that alarm's end then removes them; no `safety_results` row is written in between.
- **The duplicate check:** a retry of a settled text within 24 hours answers duplicate and stores nothing (no batch item, safety row or outage row), and `firstTraceOf` answers its first trace; after 24 hours (a fake clock and the alarm) the tombstone is gone and the same event is stored as new.
- **Holds:** after the sweep, `openHolds` still answers an open danger hold and an open threat hold with their outcomes, and a commit is handed them; once a hold is released, the next sweep removes it with its labels.
- **`forget`:** each `notNow` label in its state, with the scan the same before and after; the same open texts and danger no longer holding it back once the key store answers another key for the handle (the erased key's stand-in); `forgotten`, with the scan above; the next text after it read, batched and turned as before, an eviction in the middle of its read included (its name written again).
- **Erasure by key:** with the key store answering another key, no inbox box, kept result or queued box opens, `resultsOf` answers none of them, and a re-read of such a text finds it unreadable.
- **When:** the sweep after each turn-ending step, after `afterLate`, after the outage path's check and at the end of the alarm; the `retention` entry due as section 6 says, and absent on an actor with nothing left; at most 50 texts a sweep.
- **Not measurable here:** what the platform keeps of an emptied Durable Object or its name (open point 7); the job's own 45 days (C-156's); real Linq's retry window.

### 8. Who builds what

Five cards for the runtime engineer, each inside `runtime/`, one at a time in this order (they share files): R1, R2, R3, R4, R5. Each waits for T-1264 (ADR-015's card B, which waits for T-1263): without its `closeResults` calls no text is ever closed, so none settles. Nothing for the database engineer here: C-156's job and its call are the lead's to card (below).

**Card R1: settled, and a text's own rows (the inbox and the safety read)**

- Reads: this record, sections 2, 3 and 7; `runtime/src/actor/inbox.ts`; `runtime/src/safety/arrival.ts` lines 263 to 310, 575 to 603, 668 to 725, 774 to 850 and 1098 to 1195; handle-actor.ts lines 394 to 401 and 456 to 497; outage.ts lines 1043 to 1065 (the prune it follows); return-queue.ts lines 110 to 134.
- Gives: (1) `runtime/src/actor/retention.ts` (new): `settledTexts(sql, pending, limit)`, section 2's five conditions as one read, in arrival order, the pending texts of condition 5 handed in by the caller; (2) in inbox.ts: the `inbox_gone` table; `retireTexts(sql, eventIds, now)`, each inbox row to its tombstone; `writeToInbox` answering duplicate for a tombstone's id; a read of a first trace from either table, which `firstTraceOf` uses; `dropTombstones(sql, before)`; (3) in arrival.ts, new exported functions only: `forgetSettled(sql, eventIds)` and `dropReleasedHolds(sql)`, synchronous, deleting the safety rows section 2 lists and keeping each open outcome hold with its labels.
- May touch: `runtime/src/actor/retention.ts` (new), `inbox.ts`, `handle-actor.ts` (`firstTraceOf` only), `runtime/src/safety/arrival.ts` (new exported functions only), and new tests under `runtime/src/actor` and `runtime/src/safety`.
- Depends on: T-1264 merged. Never beside another card that changes arrival.ts or inbox.ts.
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/safety`: section 7's "each condition of settled, alone" through `settledTexts`, and Rosie's own reaction settled once stored; `retireTexts` leaves a tombstone of the event id, trace id and time only, a retry answers duplicate with nothing stored, `firstTraceOf` answers, and after `dropTombstones` the event is stored as new; `forgetSettled` deletes exactly the named texts' rows and keeps an open danger hold and an open threat hold with their outcomes, which `openHolds` still answers; `dropReleasedHolds` removes a released hold of a settled text with its outcomes; section 7's "ADR-015's exception". Then `npm test`, lint (after `npm run contracts:types`), typecheck, format:check and guard:tests.
- Reviews: QA; the security reviewer (the settled test, the tombstone, the holds kept).
- Estimate: 3 h.

**Card R2: a turn's bookkeeping goes with its texts (the batch window, the lease, the pin)**

- Reads: this record, sections 2 and 3; `runtime/src/actor/batch.ts`; lease.ts lines 375 to 412, 530 to 576, 661 to 804 and 1026 to 1124; `runtime/src/bundle/pin.ts` lines 143 to 199; handle-actor.ts lines 616 to 626; R1's `retention.ts`.
- Gives: `forgetBatchTexts(sql, eventIds)` in batch.ts (items, reads and span texts; a batch with no item left); `forgetEndedTurns(sql, settled)` in lease.ts (lease batches and final turns whose every item is settled, never the newest turn row, and their commit handles), answering the turn ids removed; `forgetPins(sql, turnIds)` in pin.ts and `forgetSpans(sql, turnIds)` in batch.ts; `retention.ts` composing them for the sweep; lease.ts's own note that only the newest turn row is kept for good.
- May touch: `runtime/src/actor/batch.ts`, `lease.ts`, `retention.ts`, `runtime/src/bundle/pin.ts`, and new tests under `runtime/src/actor` and `runtime/src/bundle`.
- Depends on: R1.
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/bundle`: after a turn of three texts ends with every text settled, no batch item, batch, read, span text, lease batch, commit handle, turn bundle or batch span names the turn or its texts, and no `lease_turns` row is left but the newest; with one text unsettled, every row of the turn stays; a restart's replaced turn goes with the restart; the newest row stays, and the copies' turn order (`turnsOpened`) answers the same before and after; the batch window hands no removed batch again, and the lease opens no turn for it. Then the checks R1 lists.
- Reviews: QA.
- Estimate: 2.5 h.

**Card R3: the sweep: when it runs, its bound and the 24-hour windows**

- Reads: this record, sections 2, 6 and 7; handle-actor.ts; lease.ts (`replied`, `finish`, `lapse`, `act`, `park`, and the steps where T-1264 calls `closeResults`); inbox.ts lines 81 to 94; R1's and R2's functions.
- Gives: the actor's sweep (section 6: one transaction, at most 50 texts, the tombstones and receipt ids past 24 hours, the released holds, the `retention` entry), run where section 6 says; an optional `LeaseHost` member the lease calls after each storage transaction that ends a turn for good, outside it; `seen_receipts` gains the time each id was seen (an actor whose table has no such column gains it as it starts, and the ids written before count as seen at its first sweep); handle-actor.ts's note at lines 616 to 626 changed to "the newest row".
- May touch: `runtime/src/actor/handle-actor.ts`, `lease.ts` (that call only), `inbox.ts` (receipts only), `retention.ts`, and new tests under `runtime/src/actor`.
- Depends on: R2.
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/wiring`: section 7's "When" and "The duplicate check", and the same 24 hours for receipt ids; a throw inside the sweep leaves every row and sets the entry an hour on; through the hop rig with the real actor, once the JOIN turn's reply ends, its texts leave their tombstones only; then `npm run test:e2e -- skeleton` (after `npm run db:up`), unchanged and green, and the checks R1 lists.
- Reviews: QA; the security reviewer (when the words go).
- Estimate: 3 h.

**Card R4: `forget`, part 1: its checks and the texts' rows**

- Reads: this record, sections 4, 5 and 7; handle-actor.ts; arrival.ts lines 378 to 448, 544 to 553, 668 to 725 and 950 to 995; inbox.ts; batch.ts; lease.ts; pin.ts; outage.ts lines 297 to 323; return-queue.ts lines 200 to 220.
- Gives: the actor's `forget()`, with its four `notNow` checks (`textsOpen` opens each waiting text's box, and each pending danger's, under the key the store answers now, through a new method of the safety read) and the transaction that repeats the others and deletes every row of the inbox (tombstones within their 24 hours kept), the safety read (open outcome holds and their labels kept; its name in storage and in memory gone), the batch window, the lease (the newest turn row kept with its items emptied; a lapsed lease gone) and the pin; counts answered.
- May touch: `runtime/src/actor/handle-actor.ts`, `inbox.ts`, `batch.ts`, `lease.ts`, `retention.ts`, `runtime/src/safety/arrival.ts` (new exported functions and methods only), `runtime/src/bundle/pin.ts`, and new tests under `runtime/src/actor` and `runtime/src/safety`.
- Depends on: R3.
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/safety`: each `notNow` label in its state, with the scan unchanged; with the key store answering another key for the handle, the same texts and danger no longer hold it back; `forgotten`: no inbox row but the live tombstones, no safety row but open outcome holds and their labels, no batch, lease (but the newest row, its items empty) or pin row, and the safety read's name gone from storage and memory; `openHolds` still answers the open outcome holds; the next text after it is read, batched and turned, and an eviction in the middle of its read resumes it under the right name. Then the checks R1 lists.
- Reviews: QA; the security reviewer (what `forget` keeps, and the job's order).
- Estimate: 3 h.

**Card R5: `forget`, part 2: the handle's rows, and the whole-storage scan**

- Reads: this record, sections 3, 5 and 7; copies.ts lines 1 to 50 and 225 to 294; return-queue.ts; outage.ts lines 170 to 212 and 1006 to 1083; actor-clocks.ts lines 53 to 97; handle-actor.ts lines 176 to 193 and 864 to 883; R4's `forget`.
- Gives: `forget` also deletes the outage path's texts, ids and name, `clock_handle`, `trace_seq`, `return_done`, and the queue's refused danger and rest writes with their held ranks, keeping the stop rank's refused writes and held row and every copy section 5 keeps; section 7's whole-storage scan as a test over every table in `sqlite_master`, each named by this record as swept, kept or deleted by `forget`.
- May touch: `runtime/src/actor/handle-actor.ts`, `runtime/src/actor/copies/return-queue.ts`, `runtime/src/outage/db/outage.ts` and `runtime/src/clocks/actor-clocks.ts` (new exported functions only in the last three), and new tests under `runtime/src/actor`.
- Depends on: R4. Never beside another card that changes outage.ts or return-queue.ts.
- Proves it with: `npm run test:workers -- runtime/src/actor runtime/src/outage runtime/src/clocks`: section 7's whole-storage scan after a sweep and after `forgotten` (no event id, box or address outside the survivors; the survivors unchanged; a refused stop write still holding its rank and the stopped copy still reading stopped; a refused danger write gone; the copied lines, keywords and timers unchanged); the arming naming the handle again after `forget`. Then the checks R1 lists.
- Reviews: QA; the security reviewer (nothing of a person's words outlives its rule; erasure by key).
- Estimate: 2.5 h.

**Notes for the lead:**

- C-156's job card (the database engineer's lane, inventory line 264) calls `forget` in section 5's order for each of the person's handles, reading the handles' addresses before it redacts them. Reaching a handle's actor from that job (a Durable Object call by `actorNameOf`, seal.ts lines 68 to 71) is a small runtime wiring card once the job exists; if the job runs outside the runtime, the call needs a contract then.
- R1 to R5 wait for T-1264, which waits for T-1263.

## Consequences

- A text's words stay in the actor only while a turn, a re-read or a queued record still needs them, sealed under the handle's key throughout. After that its event id and trace id stay 24 hours, then nothing of it. In the usual case that moment is the end of its turn, or the outage path's check about 20 s after it arrived (outage.ts line 81), whichever comes later.
- Erasing the person whose key is the handle's makes every box the actor holds unreadable at once, and `forget` then removes the rows, so no erased text holds work, wakes an alarm or keeps a plain field.
- After a person's 45-day delete the actor holds none of their plain fields and no word of theirs that opens. What stays is labels (the stopped flag's copy, open outcome holds with their labels, the newest turn's order, tombstones for at most 24 hours), the bundle's words, the copies of K-34's live timers (each address sealed under its own person's key) and refused stop writes the erased key leaves unreadable. The database keeps the same kinds of thing (RULES 4.10; 0016 lines 16 to 21).
- ADR-015's closed note lives exactly while its danger is pending. On staging a danger pending for good keeps its text whole for good, and `forget` waits on it (test phones only).
- The actor gains one alarm kind, due at most hourly while a text is in flight and never on an idle actor. An actor holding a text with no end wakes hourly for it, as a pending danger already wakes every 30 s.
- `lease_turns` is no longer kept whole: only its newest row stays for good (DL-427's order).
- Not changed: ADR-015's rules, the safety read's own deletes, the outage path's `prune`, the queue's replay, the copies' rules, and every contract.

## Alternatives not chosen

- **A time limit on every row** (delete whatever is older than so many days): it would take the words of an unread hold or a pending danger the actor still reads (arch 02 line 111; DL-127), and drop texts queued while PostgreSQL is down (arch 11 line 566); and no source gives the limit, since RULES 4.10's 45 days run from a person's request, not from a text's arrival.
- **Erasure by key alone:** it leaves the plain fields (the address, a vote's option words, the ids), and it leaves erased texts as work with no end (section 4).
- **Deleting the inbox row when its turn ends** (with ADR-015's removal): the safety read still reads a pending danger's words after its turn ends (ADR-015 section 2, "After its turn has ended"), the outage path reads a text until its own check (outage.ts lines 576 to 610), and a queued STOP's replay reads its inbox row (outage.ts lines 371 to 374).
- **No tombstone:** a provider's retry within Linq's 30 minutes (arch 02 line 109) would be stored again and start a second turn.
- **Deleting the whole storage for `forget`:** it would delete the stopped flag's copy (the "don't text me" record stays: RULES 4.10; nothing goes to a stopped number while PostgreSQL is down: arch 11 lines 564 and 566) and the open holds that bind every commit (DL-119).
- **`forget` waiting for every pending danger:** once the key is erased a danger's words never open again, so no re-read can send its line, and the wait would never end. `textsOpen` waits only for a danger whose words still open.
- **Each module deleting its own rows on its own schedule:** several alarms and several meanings of "done"; one settled test keeps ADR-015's exception in one place.
- **The actor counting 45 days itself:** the actor never learns of a person's request; C-156's job holds it (K-04 README line 112).

## Open points (proposed for QUESTIONS.md, each with its default)

1. **How soon a settled text's rows go, and how many a sweep takes.** No source says. Default: at once after the turn-ending step, the safety step, the outage path's check or the alarm that settles it, else within the hour; at most 50 texts a sweep (section 6). Owner: the CTO with the security reviewer.
2. **How long an event id is kept after its text.** Arch 02 line 109 gives Linq's 30 minutes of retries; no source says how long a seen id must be kept. Default: 24 hours after its text settles (a receipt's id: after it is seen). Owner: the CTO.
3. **A handle of several people.** The actor seals under one person's key (handle-keys.ts lines 4 to 18, where an erased person also keeps their link to the handle: open gap 28, C-156's, lines 16 to 18), so another person's 45-day delete erases nothing in it by key. Default: that person's delete calls `forget` on the handle's actor too, which deletes every text of the handle the actor still holds once none is open, the other people's included: an over-delete of rows already used, never a kept word of the erased person. Owner: the CTO with the security reviewer, with C-156.
4. **Texts with no end but `forget`** (section 2). Default: kept whole and failing closed, as today. Proposed new task: Rosie's team told of a text unsettled for more than a day, beside CQ-79 (a)'s ten re-reads (QUESTIONS.md line 235). Owner: the lead.
5. **The seconds between `forget` and `erasePerson`.** A STOP that arrives between the job's steps (1) and (2) and is not committed before the key goes is lost with the key. Default: accepted; the job erases at once after `forgotten`. Owner: the CTO with the security reviewer.
6. **What outlives the 45-day delete in the actor** (section 5's survivors): labels and the stopped flag's copy. Default: kept, as K-34 keeps outcome labels and K-04 the "don't text me" record. Owner: the CTO with the security reviewer.
7. **The platform's own copy.** Whether Cloudflare keeps anything of an emptied Durable Object, or of its name (the handle's address: seal.ts lines 68 to 71), was not checked: no vendor document was read for this record. Default: this record rules the actor's storage only. Owner: the release engineer (a check against Cloudflare's documents).
8. **A vote's option words** are plain in the inbox row until its text settles (CQ-58). Default: CQ-58's, until K-06's minor version seals them; this record bounds them by section 2 and `forget`. Owner: the architect (K-06), then the runtime engineer.

## New tasks found (recorded, not fixed here)

- **C-156's job calls `forget`** in section 5's order for each of the person's handles, with a way to reach a handle's actor. Owner: the lead (C-156's database cards and a runtime wiring card).
- **A text unsettled for more than a day is told to Rosie's team** (open point 4). Owner: the lead, then the runtime engineer.
- **The platform check** (open point 7). Owner: the release engineer.

## Sources

- Build prompt 3.3, as `.claude/agents/architect.md` line 30 states it.
- RULES (`1 Read First/RULES.md`): 4.5 (lines 199 to 202), 4.10 (lines 233 to 235), 4.12 (lines 244 to 247), 7.2 (lines 312 to 315).
- Architecture (`scratch/text/architecture.txt`): 01 lines 55, 57, 61 and 93; 02 lines 109, 111 and 113; 06 lines 325, 327 and 329; 09 line 492; 10 lines 504 and 516; 11 lines 564, 566 and 576.
- `ops/plan/01-inventory.md` C-156 (line 264).
- ADR-015: section 2 ("Removed, and the text closed"; "After its turn has ended"), section 4 and "New tasks found" (line 216). `ops/cards/T-1264.md` (card B) and `T-1263.md` (card C). DL-508, DL-524. QUESTIONS.md CQ-26 (line 182), CQ-58 (line 214), CQ-65 as DL-119 and DL-127 replaced it (line 221), CQ-79 (line 235), CQ-104 (line 260); NQ-RT-1, as seal.ts lines 1 to 2 quote it.
- Contracts: K-04 README (`contracts/db-schema/core/README.md` line 112).
- Database: `db/migrations/0003_core_sealing_keys.sql` lines 4 to 7 and 21; `0016_safety_incidents.sql` lines 16 to 21; `0027_customers.sql` lines 44 to 48; `db/repo/sealing.ts` lines 9 to 11 and 312 to 347; `db/repo/handle-keys.ts` lines 4 to 18 and 213 to 224.
- Code on main 4062130: `runtime/src/actor/inbox.ts`, `handle-actor.ts`, `batch.ts`, `lease.ts`, `copies/copies.ts`, `copies/return-queue.ts`; `runtime/src/safety/arrival.ts`; `runtime/src/bundle/pin.ts`; `runtime/src/clocks/actor-clocks.ts`; `runtime/src/outage/db/outage.ts`; `runtime/src/gateway/seal.ts`, `types.ts`.
