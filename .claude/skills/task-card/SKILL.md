---
name: task-card
description: How to work from a Rosie task card (T-xxx) - what each line binds you to, the checklist from first command to report, and the card template of build prompt section 10. Use at the start of every task and before every report.
---

# Working from a task card

The lead gives you the whole card in your first message. The card is the job: build what it gives, only where it allows, and prove it the way it says (build prompt 3.4, 6.2, 7.6). QA checks only its "Proves it with", its scope and rule 7.9 (6.6).

## The template (build prompt section 10, verbatim)

```
T-041 · Reservations table that refuses a double booking
Owner: database engineer · Tier of its deployment: 3 (a hard invariant)
Reads: contract db-schema v1 (reservations); architecture section 10, "No double booking"
Gives: a migration for the reservations table; reserve() and release() data-access calls, with unit tests beside them
May touch: db/migrations/<new file>, db/repo/reservations.*
Depends on: T-005, because it reads db-schema v1, which must be frozen. T-012, because the table refers to
  workers, rooms and vehicles.
Proves it with: two overlapping reservations for one worker are refused by the database (EXCLUDE);
  class seats never exceed capacity (CHECK); 1,000 parallel reserve() calls on one slot give exactly one success
Not here: QA writes contract test reservations.v1 in tests/contract/ as its own task (T-042)
Estimate: 3 h · Budget: 4.5 h, or 3 attempts / 90 min per failing check · Started: <lead fills>
Do not try again: (none yet)
```

The card's branch is `task/<card id>`, here `task/T-041` (5.1).

## What each line binds you to

- **Owner**: must be your role; if not, report NEED (lead).
- **Tier**: the tier of the deployment it rides (9.2). A change that touches personal data, money, consent, STOP or keys is also reviewed by the security reviewer (6.2).
- **Reads**: the only sources and contract versions you use. A contract not frozen at that version: NEED (architect).
- **Gives**: what must exist when you finish, with unit tests beside the code.
- **May touch**: the only paths you change (scope lock, 7.6). Anything else is a new task: name it in your handoff.
- **Depends on**: each one merged in `main`. If what you need is not there, NEED (lead); never build on another task's branch (5.1).
- **Proves it with**: the checks QA re-runs. Make each one a test or a command with a clear result.
- **Not here**: not yours on this card; do not build it.
- **Estimate · Budget · Started**: your limits (7.1): 1.5 times the estimate for the whole task, counted from Started; 3 attempts or 90 minutes per failing check; your turn cap. A restart never resets them.
- **Do not try again**: read it first and never repeat those approaches (7.2).

## Checklist

1. Read the card, its "Do not try again" lines and every earlier report on it. Read only the files it names.
2. `date`; work out the time left from Started and Budget.
3. `git fetch origin`; `git switch task/T-xxx` (if it does not exist yet: `git switch -c task/T-xxx`); `npm ci`.
4. Build "Gives" inside "May touch". Before each attempt at a failing check, run `date` and note the attempt.
5. Self-check: each "Proves it with" check, then `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run guard:tests`, `npm run guard:migrations`.
6. After each passing self-check: `git add <your files>`, `git commit -m "T-xxx: <what changed>"`.
7. Before any report: `git status --short` is empty; `git diff --name-only origin/main...HEAD` lists only "May touch" paths; `git push origin task/T-xxx`; note `git log -1 --format=%h`.
8. Report DONE, STUCK (skill stuck-report) or NEED as your role file shows, naming the branch and its last commit.

QA verifying another role's branch follows its own role file instead of steps 3 to 7: it checks out with `git switch --detach task/T-xxx` and changes nothing.
