---
name: deploy-staging
description: Checklist for a Rosie staging deploy in the order of build prompt 5.4 - expanding migration, code with flags off, bundle, flags, then the post-deploy check with its trace id - and what to do when a step fails. Use for every staging deploy and when checking one.
---

# Deploy to staging

Staging only. Production deploys run only from the protected release job, after Jay or the CTO acts from his own login (build prompt section 2's table, 5.4).

## Before

- The change is merged in `main` with the merge checks green, and every deployment it depends on is already on staging (6.1).
- Staging is not frozen: no deploy from 30 minutes before a review window until its answers are in, or 2 hours after the window opens, whichever comes first (9.3). The lead says when a freeze is on.
- Every migration in it is expand-only (`npm run guard:migrations` green).

## How it runs

- On the build Mac, never in CI (DL-024: CI runs checks only and holds no secrets): `npm run deploy:staging`, only from `main`'s commit. The lead runs it after each merge; you run it only when your card says so.
- It rolls back by itself: if the post-deploy check fails (or anything else fails once the code step has started), it runs `rollback-staging.sh` with no click, back to the version staging ran before, and exits non-zero. If staging still runs that version, it logs "nothing to roll back". Migrations stay in place.
- A manual rollback, back only: `npm run rollback:staging [-- <version-id>]` (it runs `check:staging` after).
- Never `wrangler deploy` directly, never `--env production`, and `gh workflow run` only for `merge-check.yml`.
- Wrangler runs only inside these scripts or through `npm run cf`, which use the Rosfield sign-in and pin the Rosfield account. Keys come from the environment at run time and are never echoed; never open `.dev.vars` (rule 7).

## The order (5.4)

Each step's log line goes in your report, for `ops/releases/D-xxx.md`.

1. The expanding migration: `migrate` on the staging database when `STAGING_DATABASE_URL` is set (otherwise the script says it skipped).
2. The code, flags off: `wrangler deploy --env staging` with `GIT_SHA`, inside the script.
3. For a bundle (once bundles exist): publish it, then switch the active bundle id.
4. The flags the approved cards name (once flags exist).
5. `npm run check:staging <base-url>`: health, one traced request, the trace id printed.

## If a step fails (5.4)

- Stop. Undo what can be undone: flag off, the previous bundle id, the previous code (`npm run deploy:staging` already rolled it back on a failed check; otherwise `npm run rollback:staging`, back only; skill canary-and-rollback).
- Leave an added migration in place; never write a down-migration.
- Do not retry in the same window; report it, and it goes to the next review.

## Report

The commit deployed (`GIT_SHA`), each step's log line, the check's trace id and the staging URL. On a failure: the failing step, its log, and the version it rolled back to.
