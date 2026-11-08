# The walking skeleton's end-to-end test (C-148, D-017)

`skeleton.test.ts` sends one JOIN webhook (Sam, test owner 1, from the master's sample cast) through T-465's local target with every double, and judges the run with T-551's `checkSkeletonRun`. It is in its prefix form (T-1103, CQ-78). T-466 completes the same file later.

## A hop join proves its prefix (T-552 to T-563)

1. Write the hop's contract test report:
   `npm run test:contract -- tests/contract/<file> --reporter=json --outputFile=scratch/<hop>-report.json`
2. Run the skeleton test up to the hop, with that report:
   `SKELETON_UPTO=<name> CONTRACT_REPORT=scratch/<hop>-report.json npm run test:e2e -- skeleton`

For example, the gateway (row 1 of 02-contracts section 11, K-11) uses `tests/contract/port-linq.v1.test.ts` and `SKELETON_UPTO=gateway`.

- `SKELETON_UPTO` takes a hop of 02-contracts section 11: a K-08 hop name, or the name a join card gives its row (`gateway`, `actor-inbox`, `safety-read`, ...). T-551's `tests/e2e/_driver/prefix/section-11.ts` holds the rows and their contracts. An unknown name fails the test, and the error names it.
- `CONTRACT_REPORT` is the path, from the repository root, of the Vitest JSON report from step 1. It must hold every v1 contract test of the hop's row, each with all tests passed. With no report, the hop fails and the message names the missing report. A skipped or missing test is no pass.
- The run passes when its trace shows hops 1 to n once each, in turn order. Spans after hop n belong to hops not joined yet, and they are not judged.

## With SKELETON_UPTO unset

`npm run test:e2e` (the merge check) runs T-465's full check. Only the gateway is joined today, so the file asserts only what T-465's driver already proves. Nothing is skipped.

T-466 then completes the file with D-017's automated tests:

- exactly 1 outbox row, and 1 send to the Linq double carrying S1-02's question;
- every hop once, in order, under one trace id and one bundle id;
- the repeated webhook adds nothing;
- 20 consecutive runs give the same result.
