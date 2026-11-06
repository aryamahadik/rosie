---
name: canary-and-rollback
description: Checklist for Rosie's canary and back-only rollback - when a deployment counts as released, the 5% of handles for 24 hours canary from launch, what rolls back automatically, how to run the rollback job, and what to record and report. Use for any post-release check, breach or rollback.
---

# Canary and rollback

## When a deployment counts as released (build prompt 8, "Deployment")

- **Before launch** there is no traffic to watch, so no canary wait: it counts as released once the post-release check passes (health checks, one traced test turn, no breach). On staging that check is `npm run check:staging <base-url>`.
- **From launch**, it goes through the canary (architecture section 10's bundle rule, used for code flags too): 5% of handles for 24 hours with no hard-invariant breach, reply p95 at or under 18 s and error rates within the card's limits; then everyone. One bundle is in canary at a time; changes ready meanwhile ride the next bundle.

## Rollback never waits for a human (5.4)

- **Triggers**: a hard-invariant breach (a charge without a bound yes, a double booking, a text after STOP beyond what the stopped flag allows) or reply p95 over 18 s (sections 08 and 10). The automated check rolls back: flag off, the last passing bundle, or the last approved release.
- **How** (DL-024: on the build Mac, never in CI): the rollback needs no click and can only go back, never forward. `npm run deploy:staging` runs it by itself when its post-deploy check fails, back to the version staging ran before. The lead may roll back at any hour (5.4), and you run it when your card or the lead says so: `npm run rollback:staging [-- <version-id>]` (back to the previous deployment or to the older version given; it runs `check:staging` after; put the reason in your report). `gh workflow run` is only for `merge-check.yml`.
- **Migrations stay** in place: rolling code back never needs a down-migration.
- Never fix forward instead of rolling back.

## After a rollback

1. Record what triggered it, the trace ids, the version rolled back from and to, the time, and the check's result afterwards.
2. Report it at once: your report goes to the lead, who alerts Jay and the CTO at once, with the trace ids (5.4).
3. An unbound charge is refunded at once (section 08; S12-26): name it in the report.
4. The fix becomes the top task. Going forward again needs the normal approval.

## D-000's proof (5.9, check 5)

On staging, a deploy that fails after its migration is rolled back in under 5 minutes, by the rollback job, with no click (the rollback inside `npm run deploy:staging`, DL-024).
