---
name: run-evals
description: Checklist for running a Rosie eval (smoke slice, full gold set or bundle candidate) and reporting it - the budget, what counts as met, the 95% interval, newly wrong items, target misses and the forbidden re-run. Use before any eval run and when writing its result.
---

# Run evals

Evals never decide whether `main` is green (build prompt 5.2). They decide whether an AI change or a bundle may ship.

## When

- **Smoke slice** (fixed, sized in the plan): a branch that changes what the AI does (a prompt, a bundle, the frontier, the composer or model routing) runs it before its merge (5.2, 3.5 (f)). The merge check runs it with `ai_change: true` (factory spec 7).
- **Full gold set**: nightly, and for each bundle release candidate, within J-02's daily budget. A drop seen nightly opens a task; it does not stop the line.

## Before a run

1. **Budget**: run only when your card or the lead says so, within the budget named. At 80% of the day's budget no new eval run starts (7.11).
2. **Candidate**: note its commit and bundle id. Never re-run an eval on an unchanged candidate to get a better number (7.9).
3. **Key**: it comes from the run's environment (a CI secret or the eval job), never from a file you open (rule 7). If none is available where you run, report NEED (lead); never look for one.
4. **Data**: the gold set comes only from walking the step graph and fixture set v1, labeled only from approved overlays (J-18); never real customer data (rule 9). Never change the gold set, a label or a threshold to pass (7.9, rule 10).

## What counts as met (8, "Eval gate")

- Every accuracy number is right out of total with its 95% interval. The interval is the Wilson score interval, which reproduces every example in the build prompt: 83 of 90 is 85–96%; 300 of 300 is 98.7–100%; 381 of 381 is the first to clear 99%.
- A measure counts as met only at its sized volume (J-19), with the interval's lower bound clearing an "at least" target, or its upper bound clearing an "at most" target. Below that volume, write the interval and "not yet proven", never "met".
- The gate: zero hard-invariant breaches; each section 08 measure's point estimate at or above its target, harmful wrong actions included (at most 0.2% of turns; with fewer than 500 turns, none); cost at most $0.16 per completed booking on the gold set; and a list of every item the last passing bundle got right that this one gets wrong, each explained.
- A bundle also lists every money, booking, consent or safety effect that differs from the last passing bundle on the same replay; any such change makes it tier 3 (8, "Bundle").
- A journey milestone also needs each measure's point estimate at or above its target on that journey's items.

## When it fails

- A point estimate below its target is a target miss: it stops that ship and goes to Jay through the lead. There is no open-ended retry (7.10).
- A 429 or 5xx from the model provider is not an attempt and not a miss: wait, re-run once; still failing, report NEED "waiting on Anthropic" (7.8).

## Report lines

```
Eval · <smoke slice or full gold set> · candidate <commit, bundle id> · baseline <last passing bundle>
<measure>: <right> of <total> (<point>%; 95% interval <low>–<high>%; target <t>%; met / not yet proven / MISS)
Hard-invariant breaches: <n> · Harmful wrong actions: <n> of <turns> · Cost per completed booking: $<x>
Newly wrong against the baseline: <item ids, each with its explanation, or none>
Changed effects (bundles): money <n>, booking <n>, consent <n>, safety <n>
```
