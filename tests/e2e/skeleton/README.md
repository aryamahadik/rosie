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
  - scrub: the actor's inbox entry comes once, its words sealed under the key K-05 gave the handle;
  - the safety read: the JOIN reads No, on one Haiku call;
  - the lease: one batch and one turn, bundle v0 pinned, and the turn's one K-04 row;
  - the guard: no keyword and no target.

## Joined so far

Joins 1 to 5 (T-552 to T-556): receive, scrub with the actor's inbox entry, the safety read, the lease and the guard. Each later join moves `JOINED_THROUGH` to its row's last hop and adds its row's claims.

## With SKELETON_UPTO unset

`npm run test:e2e` (the merge check) runs T-465's check over every hop joined so far, from receive to the guard, with every joined row's claims. No contract report is read. Nothing is skipped.

## Known gaps (`gaps.ts`)

The runtime's own trace test names what the merged runtime does not write yet (`runtime/test/trace-e2e.worker.test.ts` GAPS, DL-168). T-1108 closes all three below. The run judges around each gap by name and asserts that it still holds, so a writer that lands fails the run, and its task takes the gap off `gaps.ts`.

- `actorReceive`: the handle actor writes its own receive span beside the gateway's. That span is the actor's inbox entry: it is set aside from the hops `checkHops` counts and judged on its own.
- `seqPerWriter`: seq restarts at 1 in each writer. The trace is judged in the order its spans started, numbered again.
- `batchSpans`: nothing writes the batch span. The batch hop is left out of the hops judged, and `SKELETON_UPTO=batch` fails, naming the gap.

## Inside workerd

- The trace is checked against K-08 with the code T-1144 prebuilds for the Worker (K-08 v1.1's span, which is v1's). Ajv's compiler cannot run in workerd. `npm run test:e2e` builds that code first.
- The local target starts capturing log lines before the root is composed, because the root binds its span sinks to `console.log` at that moment.
- The dispatcher still sends to the root's fake Linq port, not to the local target's recording Linq double. So the parts the full check reads are wired by the send join (T-563) or by T-466.

T-466 then completes the file with D-017's automated tests:

- exactly 1 outbox row, and 1 send to the Linq double carrying S1-02's question;
- every hop once, in order, under one trace id and one bundle id;
- the repeated webhook adds nothing;
- 20 consecutive runs give the same result.
