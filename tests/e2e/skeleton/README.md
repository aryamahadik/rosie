# The walking skeleton's end-to-end test (C-148, D-017)

The run goes through the Worker's own composition root, inside workerd (T-1149, DL-332). `skeleton.worker.test.ts` sends one JOIN webhook (Sam, test owner 1, from the master's sample cast) through T-465's local target to `runtime/src/wiring`'s `root.linqWebhook`, with the HandleActor installed and every joined port fed its double (`root-run.ts`), and runs it as far as its turn's reply. T-465's `checkHops` judges its trace, through T-551's `judgePrefixRun`. The actor's inbox, safety state and batches, and the rows the K-05 doubles wrote, are read back. It is in its prefix form (T-1103, CQ-78). T-466 completes it later.

`skeleton.test.ts` is its half in Node: it checks the JOIN (`join.ts`) against K-06 v1 with Ajv's compiler, which cannot run inside workerd. `npm run test:e2e` runs both, in the `e2e` project (Node) and the `e2e-workers` project (workerd).

## A hop join proves its prefix (T-552 to T-563)

1. Write the hop's contract test report:
   `npm run test:contract -- tests/contract/<file> --reporter=json --outputFile=scratch/<hop>-report.json`
2. Run the skeleton test up to the hop, with that report:
   `SKELETON_UPTO=<name> CONTRACT_REPORT=scratch/<hop>-report.json npm run test:e2e -- skeleton`

For example, the guard (row 5 of 02-contracts section 11, K-01 and K-04) uses `tests/contract/bundle.v1.test.ts` and `tests/contract/db-schema.core.v1.test.ts`, and `SKELETON_UPTO=guard`.

- `SKELETON_UPTO` takes a hop of 02-contracts section 11: a K-08 hop name, or the name a join card gives its row (`gateway`, `actor-inbox`, `safety-read`, `lease`, `guard`, ...). T-551's `tests/e2e/_driver/prefix/section-11.ts` holds the rows and their contracts. An unknown name fails the test, and the error names it.
- `CONTRACT_REPORT` is the path, from the repository root, of the Vitest JSON report from step 1. It must hold every v1 contract test of the hop's row, each with all tests passed. With no report, the hop fails and the message names the missing report. A skipped or missing test is no pass.
- Both are read in Node before the run, as T-551's `checkSkeletonRun` reads them: `tests/e2e/_driver/prefix/plan.ts`, run by the `e2e-workers` project's global setup. The run gets the plan through Vitest's `inject`. Inside workerd there is no such environment variable, and neither `contracts/` nor the report is on disk.
- The run passes when its trace shows hops 1 to n once each, in turn order, under one trace id and one bundle id. Spans after hop n belong to hops not joined yet, and they are not judged.
- Each joined row up to the prefix's also holds what its join proved in its own Workers test (`CLAIMS`):
  - receive: the signature is valid and the event id is new;
  - scrub: the actor's inbox entry comes once, on the text's arrival, its words sealed under the key K-05 gave the handle;
  - the safety read: the JOIN reads No, on one Haiku call, read from the text's arrival (its model-call span is the one whose calls are all safety reads);
  - the lease: one batch and one turn, bundle v0 pinned, and the turn's one K-04 row;
  - the guard: no keyword and no target;
  - the frontier: @rosie/actions' turn face reads test owner 1's stored state once, under Lee's Barbershop's scope, and gives the JOIN `build-frontier-s1-01.json`'s one choice, the sign-up door to S1-01. KV is empty, so its bundle part comes from PostgreSQL's copy, and its one frontier span, under bundle v0's id, says so (the Tool API base's span; the turn records none, CQ-159);
  - decide: @rosie/ai's decider, over the recorded-model double's recording 2 (the JOIN run's own context, as `ai/recordings` keys it, DL-347), gives the JOIN turn two Haiku reads, first and check, which agree, and no re-read. Both enter c-01, the sign-up door, with the quote JOIN and no field, as `decide-s1-01-enter.json`'s reads do. The turn records one decideReads span, labels and counts only; each of the reads' four model calls has its own portCall span beside it. Reads that disagree (`decide-reads-disagree.json`: one Sonnet re-read, then one question, nothing committed) are proven in `runtime/src/wiring/hop7.worker.test.ts`, since the JOIN on bundle v0 cannot reach them. The decided result row 7 reads is the request the turn handed the gate (`gateCalls`: `root-run.ts` watches the turn's gate calls on their way to the root's own gateAndCommit, and changes nothing they are sent or answer);
  - the gate and one commit: @rosie/actions' turn face's gateAndCommit, its reads over test owner 1's seeded rows and its one K-05 commitTurn through the root's turn-row port, gives the JOIN turn one gate span with `commit-s1-01.json`'s limits (`trace-skeleton.json`'s: 1, 4 and 6 pass) and one commit span naming `commit-s1-01.json`'s rows. The turn records both spans and the Tool API base records none (DL-376). The K-05 double then holds exactly 1 turn row (K-05's seven fields alone), 1 thread row, 1 open question, 1 clock row (waiting, unarmed), 1 outbox row, the safety record's outcome row and the event-log entries, under one turn id and one trace id. Each row id is built from the turn's own id, and each value is the one `commit-s1-01.json`'s `given.stated.writes` states. The thread row and the outbox row took the JOIN event's chat id and service, and no span or event-log entry holds the chat id. The replay (the first commit again, nothing written) and two actors committing one turn id in parallel (one commit) are proven in `runtime/src/wiring/hop8.worker.test.ts`.

## Joined so far

Joins 1 to 8 (T-552 to T-559): receive, scrub with the actor's inbox entry, the safety read, the lease, the guard, the frontier, decide's two reads, and the gate with its one commit. Each later join moves `JOINED_THROUGH` to its row's last hop and adds its row's claims.

## With SKELETON_UPTO unset

`npm run test:e2e` (the merge check) runs T-465's check over every hop joined so far, from receive to the commit, with every joined row's claims. No contract report is read. Nothing is skipped.

## Known gaps (`gaps.ts`)

The runtime's own trace test names what the merged runtime does not write yet (`runtime/test/trace-e2e.worker.test.ts` GAPS, DL-168). T-1108 closes all three below. The run judges around each gap by name and asserts that it still holds, so a writer that lands fails the run, and its task takes the gap off `gaps.ts`.

- `actorReceive`: the handle actor writes its own receive span beside the gateway's. That span is the actor's inbox entry: it is set aside from the hops `checkHops` counts and judged on its own.
- `seqPerWriter`: seq restarts at 1 in each writer. The trace is judged in the order its spans started, numbered again.
- `batchSpans`: nothing writes the batch span. The batch hop is left out of the hops judged, and `SKELETON_UPTO=batch` fails, naming the gap.

## Inside workerd

- The trace is checked against K-08 with the code T-1144 prebuilds for the Worker (K-08 v1.1's span, which is v1's). Ajv's compiler cannot run in workerd. `npm run test:e2e` builds that code first.
- The local target starts capturing log lines before the root is composed, because the root binds its span sinks to `console.log` at that moment.
- The actor's inbox entry's span starts when the hand-off reaches the actor, as K-08 says: the actor reads its clock once as the call begins and stamps the span from that reading when it answers (T-1170). The inbox entry is timed on the gateway's own readings, which are exact: after its scrub, before its answer. The safety read starts no earlier than the inbox entry, since the actor stores the text and starts its read in one step, and before the gateway's answer.
- The dispatcher still sends to the root's fake Linq port, not to the local target's recording Linq double. So the parts the full check reads are wired by the send join (T-563) or by T-466.

T-466 then completes the file with D-017's automated tests:

- exactly 1 outbox row, and 1 send to the Linq double carrying S1-02's question;
- every hop once, in order, under one trace id and one bundle id;
- the repeated webhook adds nothing;
- 20 consecutive runs give the same result.
