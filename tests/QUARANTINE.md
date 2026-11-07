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

## Rules

1. **Only QA edits this file** (5.2). Every row is QA's, whoever asked for it. A branch from any other role that changes this file is refused at merge (6.5).
2. **Every row has its task id and who allowed it.** The guard ignores, with a notice, a row that lacks either, and the test it names then counts as removed or skipped. The task id is the task whose branch removes or skips the test; "Allowed by" is one of the three values above, spelled so (the guard looks for `QA`, `architect` or `contract`).
3. **QA quarantines a test only after showing, in its report on the task's card, that the failure comes from the test or the environment, not the code** (7.8). The row names a fix task and an owner. The test is never re-run until it happens to pass, and a failure caused by an outside service is not quarantined (see above).
4. **Never a test that guards a hard invariant or a concurrency rule.** The hard invariants are no double booking, no charge without a bound yes, and no text after STOP beyond what the stopped flag allows. A concurrency rule is any rule about two things happening at once (two requests for one slot, one outbox row sent twice, a second worker taking a lease). An intermittent failure in such a test is a bug: the line stops for it (7.8), and no row may name the test, whoever allowed it, whatever the reason.
5. **A ruling is the architect's and is final** (6.6). QA records it here with the card section that holds the builder's one statement and QA's answer. The replacement test (the fix task) is written by the task the ruling names, or the row says `none` and why.
6. **A contract-removal task** (6.4) lists the removed version's contract tests: the row's Test cell may name the test file alone, which covers every test in it. The row names the contract and the version removed, and its fix task is `none`. QA records the row (rule 1).
7. **One test per row,** written in full as the "How to fill a row" shape says. A file or a describe title alone is for rule 6 only.
8. **No other way to drop a test.** Deleting, skipping, marking todo or loosening a test is forbidden (rule 10, 7.9); `npm run guard:tests` fails a branch with fewer tests, or more skipped, todo or `.only` tests, than `origin/main` unless a valid row covers each one. A new `.only` is never allowed, row or no row.
9. **The guard reads the table below by its header.** It needs a column titled Test, one titled Task (or Task id) and one titled Allowed by, and it reads every line that starts with a pipe as a table row. So this file holds no other table, and no example row is written out in a line that starts with a pipe.
10. **A row leaves with its fix.** QA removes it once the fix task has merged and the test runs again, in the same change that shows the test running.

## Entries

None.

| Test | Task id | Allowed by | Reason | Fix task | Owner | Date |
| ---- | ------- | ---------- | ------ | -------- | ----- | ---- |
