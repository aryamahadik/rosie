# T-1126 findings: GitHub Actions minutes on GitHub Free, projected over the plan

Spike T-1126, Nov 7 2026, by the release engineer. The lead wrote this file from the builder's report: the tool refused the builder's own write of a findings file (DL-063, DL-064). The data comes from `gh run list` and `gh run view` of 38 completed runs, fetched by the lead on Nov 7 2026 because builders cannot reach GitHub.

## Minutes per run (billed minutes round up per job)

| Workflow                  | Runs          | Job time                | Billed per run        | Runs used                                                                                                                                         |
| ------------------------- | ------------- | ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ci.yml (`checks`)         | 31 with a job | 22 to 51 s, mean 40.5 s | 1 min                 | 42344979490 (38 s), 42344942225 (49 s), 42344877894 (45 s), 42343556215 (51 s), 42343565580 (49 s), 42344786057 (40 s), failed 42344711661 (22 s) |
| ci.yml on main, cancelled | 3             | none                    | 0 min                 | 42344356720, 42344351422, 42344346048                                                                                                             |
| merge-check.yml           | 4             | 39 to 66 s              | 1 to 2 min, mean 1.25 | 42344823865 (66 s), 42344780710 (60 s), failed 42344722820 (44 s), failed 42344550685 (39 s)                                                      |

- Already used: about 36 billed minutes (a floor).
- The main driver: every pull-request branch runs ci.yml twice per push (push and pull_request). Its concurrency group includes `event_name`, so the two never cancel each other. The sample had 1.3 pushes per branch.
- None of the merge-check runs had integration or end-to-end suites yet, so later runs will be longer.

## Projection

783 tasks. Each task is assumed to take 2 pushes × 2 ci runs, plus 2 merge-checks × 1.25, plus 1 run on main: 7.5 minutes. The two counts are the builder's assumptions, not measured. Weekly task counts come from `ops/plan/07-schedule.md`, scaled by 783/827.

| Week            | Tasks | No change (7.5 min)            | Levers 1 and 3 (4.25 min) | Levers 1, 3 and 4 (3.25 min) |
| --------------- | ----- | ------------------------------ | ------------------------- | ---------------------------- |
| Nov 9 to 15     | 281   | 2,107                          | 1,194                     | 913                          |
| Nov 16 to 22    | 408   | 3,060                          | 1,734                     | 1,326                        |
| Nov 23 to 29    | 90    | 675                            | 383                       | 293                          |
| Nov 30 to Dec 6 | 4     | 30                             | 17                        | 13                           |
| **Total**       | 783   | **5,872 (2.9× the allowance)** | **3,328 (1.7×)**          | **2,545 (1.3×)**             |

### When the allowance runs out (1,964 minutes left after the 36 used)

| Case                                            | Runs out                                   |
| ----------------------------------------------- | ------------------------------------------ |
| No change                                       | Sun Nov 15, about 15:30 ET                 |
| Levers 1 and 3                                  | Thu Nov 19, about 03:00 ET                 |
| Levers 1, 3 and 4                               | Sat Nov 21, about 15:00 ET                 |
| Jobs grow to 2 min (ci) and 4 min (merge-check) | Thu Nov 12, about 20:00 ET (an assumption) |

- **The billing date, when the allowance resets, is unknown.** No source gives it, and Q-28 says "to be confirmed". If it falls between Nov 9 and the run-out day, a fresh 2,000 minutes arrives then.
- **On one Claude account** (about 98 tasks a week), the build uses about 735 minutes a week at 7.5 minutes per task, which runs out in 2.7 weeks. With levers 1 and 3 it uses about 1,810 a month, which fits the allowance.

## Levers that need no spend (a later release-engineer task changes the workflows)

1. **One ci run per push:** pull_request, plus push to main only. Saves 2.0 min per task, 1,566 in all. Not on the card's list, but the biggest.
2. **Concurrency cancel:** saves about 0. It is already set for branches other than main, and pushes came 2 to 3 minutes apart.
3. **Merge check once per branch:** saves 1.25 min per task, 980 in all.
4. **Skip the ci run on main after a merge:** saves 1.0 min per task, 783 in all. It loses the signal that main is green.
5. **Path filters:** saves about 0.1 min per task, about 80 in all (spikes and docs-only branches). Build prompt 5.2 says every branch runs the checks.

**Any overage, paid plan or self-hosted runner goes to Jay (Q-28).** Even with every lever, the fast schedule needs about 1.3× the allowance.

## The Free plan's gaps

From SETUP.md, Q-50 and the factory spec; not re-tested live.

- `main` cannot be protected. Local rules and a hook stand in (ADR-012).
- There are no environments or required reviewers on a private Free repository, so there is no protected release job: the CTO deploys production by hand.
- There is one login, so build actions look like one person's. Jay's and the CTO's logins are still unnamed (Q-50).
- CODEOWNERS is informational only.
- Linux runners only. 2,000 minutes a month is the card's figure.

## Handoff

- Jay decides on overage, a paid plan or a self-hosted runner before about Nov 15 (Q-28).
- Ask Jay for the billing date and the minutes used, and log them in STATE.md.
- New release-engineer tasks:
  - change the ci triggers (lever 1);
  - the merge-check dispatch rule (lever 3);
  - optionally, skip the main run (lever 4);
  - measure again once the integration and end-to-end suites exist.
- Time: about 25 minutes, one attempt.
