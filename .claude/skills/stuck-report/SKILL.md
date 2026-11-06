---
name: stuck-report
description: When to stop and hand a Rosie task back, and how to write the STUCK report of build prompt section 10 (tried, do not try again, cause, need, meanwhile, time), naming the branch and its last commit. Use the moment a stop rule fires.
---

# Stuck report

## When to stop (build prompt 7.1 to 7.5)

Stop and write this report when any one is true:

- 3 attempts at the same failing check (an attempt is a code change followed by a run of that check);
- 90 minutes on the same failing check;
- 1.5 times the card's estimate for the whole task, counted from its Started time (a restart never resets it);
- your turn cap is near (keep the last turns to commit, push and report);
- the same check failed the same way twice and you have no different approach: never a third identical try (7.3);
- the card needs something that does not exist yet: a contract field, a decision, an input, unmerged work.

Stuck means handed back (7.4): you stop; the lead marks the task blocked and changes what it lacked (a split, a new contract version, a decision, a spike's answer or a missing input) before anyone tries again.

Not a stuck report:

- An outside service failing (a 429 or 5xx, a staging outage): wait, re-run once, then report NEED "waiting on <service>" (7.8).
- An unclear requirement that has a documented default: use it and list it under "Defaults used" in DONE (7.5).

## Before you write it

1. Commit what you have, work in progress included, and `git push origin task/T-xxx`.
2. `git status --short` is empty; note `git log -1 --format=%h`.
3. Gather your attempt notes: the time (`date`), the change, the check, the result.

## The form

Section 10's lines in its order; the last line is 5.1's (every report names the branch and its last commit).

```
STUCK · T-xxx · <card title>
Tried: 1. <what you changed>: <what happened>. 2. <what you changed>: <what happened>. Stopped.
Do not try again: <attempt numbers> (<why each is a dead end, or until what changes>)
Cause: <what is missing or wrong, with its source: contract version, section, file:line>
Need: <the one change that unblocks it, and from which role>
Meanwhile: <the documented default in use, or "no safe default; task handed back">. Time: <n> min, <n> attempts.
Branch: task/T-xxx · last commit <short sha> (pushed)
```

## Example (build prompt section 10, verbatim)

```
STUCK · T-077 · Composer fills the price slot
Tried: 1. Read the price from the service row: passes, but breaks RULES 3.7 (a booking keeps the price it was
  made with). 2. Read it from the booking line: the contract has no field for it. Stopped.
Do not try again: 1 (wrong source of the price); 2 (until the field exists)
Cause: db-schema v1 has no "price at booking" field on the booking line (section 09: the price is copied in).
Need: the architect adds it as an additive change (v1 → v1.1), or says where it lives.
Meanwhile: no safe default; task handed back. Time: 70 min, 2 attempts.
```

## Rules

- Every failed attempt goes in "Tried"; the next agent reads "Do not try again" first (7.2).
- The cause is a fact you found, not a guess (7.5). If you do not know it, say what you checked.
- "Need" names one role: the architect for a contract, the database engineer for the schema, the lead for a decision, Jay or the CTO, an outside item or a split.
- Never weaken a test or go green another way to avoid this report (7.9).
