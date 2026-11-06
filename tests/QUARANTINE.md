# Test quarantine

**Only the QA and eval engineer edits this file** (build prompt 5.2). QA also records here the architect's rulings and the contract-removal tasks. A branch from any other role that changes this file touches a file outside its card and is refused at merge (6.5).

**Never quarantined: a test that guards a hard invariant** (no charge without a bound yes, no double booking, no text after STOP beyond what the stopped flag allows) **or a concurrency rule.** An intermittent failure there is a bug, and the line stops for it (7.8). No row below may name such a test, whoever allowed it. If a task seems to need one, stop and ask (build prompt section 2).

## What a row allows

`npm run guard:tests` fails a branch that has fewer tests, or more skipped, todo or `.only` tests, than `origin/main`, unless each missing or skipped test has a row here with its task id and who allowed it (5.2; D-000 spec, section 3). A row is allowed by exactly one of:

- `QA quarantine (7.8)`: QA showed on the task's card that the failure comes from the test or the environment, not the code. The test gets a fix task and an owner, and is never re-run until it happens to pass.
- `architect ruling (6.6)`: the builder said once on the card why the test is wrong; QA disagreed, or the task failed QA twice; the architect ruled, and the ruling is final.
- `contract-removal task (6.4)`: the last consumer has moved off an old contract version, and this task removes that version together with its contract tests.

Nothing else allows a row. A failure caused by an outside service (a 429 or 5xx from Anthropic, Linq, Stripe, Google or Microsoft, or a staging outage) is not quarantined: wait, re-run once, then mark the task `waiting on <service>` (7.8). Deleting, skipping or loosening a test to go green is forbidden (rule 10, 7.9).

## How to fill a row

- **Test:** in backticks, the test file's path from the repository root, then each describe title, then the test title, joined by a `>` with one space on each side. These are the file `name`, the `ancestorTitles` and the `title` of Vitest's JSON report. Shape: `<path> > <describe> > <test>`.
- **Task id:** the task whose branch removes or skips the test (`T-xxx`).
- **Allowed by:** exactly one of `QA quarantine (7.8)`, `architect ruling (6.6)`, `contract-removal task (6.4)`.
- **Reason:** one line, with where the evidence is: the card section, the ruling, or the contract and version removed.
- **Fix task:** the task that restores or replaces the test (`T-xxx`). Required for a QA quarantine. For a ruling or a removal: the task that writes the replacement test, or `none`, with the reason in Reason.
- **Owner:** the role that owns the fix task.
- **Date:** the day QA added the row (`YYYY-MM-DD`).

QA removes a row once its fix task has merged and the test runs again.

## Entries

None in D-000.

| Test | Task id | Allowed by | Reason | Fix task | Owner | Date |
| ---- | ------- | ---------- | ------ | -------- | ----- | ---- |
