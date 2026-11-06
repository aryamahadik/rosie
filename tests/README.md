# tests (`@rosie/tests`)

**Owner:** the QA and eval engineer (build prompt section 4). QA gives the PASS or FAIL verdict and never fixes what it judges.

The harness, and the contract, scenario and end-to-end tests.

```text
tests/
  contract/       Vitest project `contract`: npm run test:contract, on every branch (part of npm test)
  scenarios/      project `scenario`: npm run test:scenario, in the merge check
  e2e/            project `e2e`: npm run test:e2e, in the merge check
  src/            the harness, with unit tests beside it (project `unit`)
  QUARANTINE.md   tests allowed to be removed or skipped; only QA edits it, read by npm run guard:tests
```

- Test data comes from walking the step graph and from fixture set v1, with doubles for every outside service; real customer data never enters a test (hard rule 9).
- A test is never weakened to pass (hard rule 10). A test that guards a hard invariant or a concurrency rule is never quarantined (rule 7.8).
