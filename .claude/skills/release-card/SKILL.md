---
name: release-card
description: How to draft a Rosie release card that a human answers with Ship or Hold - the template of build prompt section 10, plain words first, the right tier, a human test of at most 5 steps and 5 minutes, and proof from the frozen build. Use for every card in a review window.
---

# Release card

You draft it; the lead sends it in the review window and records the answer. You never write `ops/`: put the card in your DONE report.

## The template (build prompt section 10, verbatim)

```
Ready to ship: D-052 · Owners can tell Rosie their kinds of work and companies
Tier 2 · Rides this train with: D-049 (a new index), D-050 (trace fields). Neither changes what anyone sees.
What's new: a new owner names their kinds of work, says which share one company, and gets a plan.
In plain words: every test passed. In 160 practice decisions during sign-up, Rosie chose right 157 times. The
  goal is 97 in 100, and there are not yet enough practice chats to be sure. 95 in 100 replies came within about
  11 seconds. Nothing broke a money, safety or stop rule.
Try it (3 minutes, on <staging test-phone page link>, signed in with your tester login, as test owner 3, a new number):
  1. Text JOIN. Rosie asks what kinds of work you do.
  2. Text: Barbershop, plumbing, electrical. Rosie asks which share one company (1, 2 or 3).
  3. Text: 1 Plumbing and electrical share Lee Home Services. Rosie lays out the plan, step by step.
You should see: one question per text, all three kinds of work kept, nothing live yet.
Hold if: a kind of work you named is missing, one text asks two things, or anything says it is live.
Proof (for the CTO): all 31 sign-up scenario tests pass; on journey 1's gold set so far, low-stakes decisions 157 of 160
  right (98.1%; 95% interval 94.6–99.4%; target 97%, not yet proven); 0 harmful wrong actions; nothing the
  last bundle got right is now wrong; reply p95 11.2 s; 0 invariant breaches.
Changed effects: none (money 0, booking 0, consent 0, safety 0).
Goes live: in production for the test phones only (they can text it once J-08 is done).
If it goes wrong: one switch turns it off; nobody outside the test phones sees it before launch.
Should we make it live? Reply "Ship D-052" or "Hold D-052: <reason>"
```

## Checklist

1. **Tier** (9.2). 1: a production release nobody could notice (no message, page, console, timing, notice or charge changes) that touches no money, consent, STOP, safety, personal data or hard invariant; approved from its proof, no human test, and all tier-1 cards of a window go on one card answered with one reply. 2: any change someone could notice that is not tier 3; hands-on test. 3: money, consent, STOP, safety lines, a hard invariant, the message checks, legal or fee wording, a bundle whose replay changes a money, booking, consent or safety effect, an overlay fixing a failing step, a journey milestone's walk-through, the launch canary; Jay approves, hands-on test.
2. **Plain words first** (9.3): every line before "Proof (for the CTO)" is written for a non-engineer; engineering terms come only after it.
3. **Rides this train with**: everything on the train (5.4), and whether each changes what anyone sees.
4. **Numbers**: each accuracy number as right out of total with its 95% interval; below its sized volume, "not yet proven", never "met" (8). Reply p95 against 18 s. Any invariant breach means it does not ship.
5. **Changed effects**: money, booking, consent and safety counts against the last passing bundle, each change listed for the approver to review before "Ship"; any change makes it tier 3 (8, "Bundle").
6. **Try it** (9.4): at most 5 steps and 5 minutes, on a phone or in a browser, against staging, covering only the change, with "You should see" and "Hold if". Payments only with Stripe test mode and its published test cards. A clock wait names the "Fire now" button to press. Safety tests only on test handles. Never a bare STOP, CANCEL, END, QUIT, UNSUBSCRIBE, OPTOUT or another opt-out word alone from a real test phone, except a STOP test from a phone named for it, which ends "Text START. You get one reply, and texts work again."; a cancel test says "Text: cancel my 2pm haircut".
7. **Proof from the frozen build** (9.3): re-run the card's automated checks on the train's commit; a card whose proof comes from an older build is not shown.
8. **Goes live**: before launch, production for the test phones only. Until J-08 gives production a Linq line they cannot text it: say so, and keep the hands-on test on staging (6.2).
9. **If it goes wrong**: the flag that turns it off, and who could notice before launch.
10. **The last line, exactly**: Should we make it live? Reply "Ship D-xxx" or "Hold D-xxx: <reason>"

## After the answers (the lead acts; know it for the train)

- Release in dependency order: a deployment is released only after every deployment it depends on is released (9.3).
- A Hold holds that deployment and every deployment that depends on it; a held change with no flag comes off the train by revert (5.4).
