# T-362 findings: real model times per stage, beside arch 04's budgets

**Status: source 2, staging's own spans since deploy 43, is read, and it answers Q-41 and DL-836 for a quiet bundle
below. Source 1, the spike's one live run of at most 40 calls, is not made yet:** the auto-mode classifier refused the
builder's run (`bash ai/spikes/model-times/run.sh --live`, Nov 16 about 01:12Z), so, as the card's lead note (DL-860)
says, it was not tried another way. The lead, or the user's `!`, runs that one command ("Source 1" below); its printed
tables go into that section, and the answers below then take its warm numbers beside staging's cold ones.

Card: T-362 (C-121; M2; deployment ai-spikes), with its lead note DL-860. For the CTO: p50 and p95 per stage (safety
read, decide read, Sonnet re-read, composer call) and model, through the AI gateway's client and spans (T-361), beside
arch 04's "Latency budget targets" (architecture.txt lines 203 to 231); whether decide plus re-read plus one rewrite
fits 18 s (Q-41); whether the safety read's 2 s per-try budget fits the measured p95 (DL-836). The spike changes no
code path: any change to routing or budgets is the CTO's (the card's "Not here").

## The budgets (arch 04, architecture.txt lines 203 to 231)

- Safety read, on arrival: at most 2 s. Each model's one try times out at 2 s, Haiku then Sonnet, so the safety line
  still meets its 5 s from arrival (line 231).
- Batch of texts: 3 s after the last. Build the frontier: at most 150 ms. One indexed search: at most 200 ms (DD).
- Decide: 2 to 4 s. Each call times out at twice the upper budget, 8 s (`STAGE_TIMEOUT_MS`, ai/src/gateway).
- Sonnet re-read, on disagreement: 3 to 6 s more; 12 s a call.
- Gate and commit: at most 300 ms. Send: at most 1 s.
- Write the reply, or one rewrite: 2 to 3 s; 6 s a call.
- Reply, end to end: p50 at most 10 s, p95 at most 18 s.

## The answers so far (from staging's spans; the live run adds the warm end)

1. **DL-836, the safety read's 2 s try.** It holds Haiku's warm reads with room: the 34 tries that answered took p50
   1,051 ms, p95 1,569 ms, max 1,611 ms. It does not hold the first try after a quiet spell: 2 of 36 tries ran past
   2 s, the version's very first model call (17:43:03Z; its Sonnet try timed out too, so that read gave no verdict, and
   its re-read 35 s later answered in 1,047 ms, writing the cache: DL-836) and one 39 minutes after the last safety
   read (18:22:49Z; its Sonnet try then answered in 1,389 ms, writing the cache). Counting those two, the nearest-rank
   p95 of Haiku's try is the 2,000 ms limit itself. The try cannot simply grow: two 2 s tries and the line's 1 s send
   already make the safety line's 5 s. A cold prompt cache alone does not explain the two (the cold re-read at
   17:43:38Z answered in 1,047 ms); the spans do not say what did.
2. **Q-41, decide plus re-read plus one rewrite within 18 s.** Not on a quiet bundle. Staging's p50s are the decide
   stage 3,943 ms, the Sonnet re-read 4,326 ms (its one read) and the composer call 4,031 ms (its one call); no staging
   turn has needed a rewrite yet, so one more composer call stands in for it (the same prompt and schema). That is
   16.3 s of model time and 4.65 s of fixed stages at their budgets: 21.0 s at p50, past 18 s before any p95 (adding
   the p95s instead: 24.2 s). Without the rewrite it is 17.0 s; without the re-read and the rewrite 12.6 s, past the
   10 s p50 target. The re-read and the composer call are one cold read and one cold call, so this is the cold end of
   the answer; the live run gives the warm end.
3. **Warm and cold decide it.** Staging made 65 model calls in 84 minutes, so most prefixes had expired between turns
   (an entry lives 5 minutes from its last read): 16 of the 65 calls wrote the cache, every re-read and composer call
   among them. A cold decide call's p95 was 5.5 s; a warm one's 2.0 s (first reads) and 3.4 s (check reads). The
   decide stage's p95 was 7.1 s in all and 4.7 s warm.
4. **Decide against its 2 to 4 s.** The stage's p50 is inside (3.9 s; 3.3 s warm); its p95 is not (7.1 s; 4.7 s warm,
   n 3). A read is two calls in series (step 1, then step 2: CQ-25's two-step form, T-1068), so 2 to 4 s leaves 1 to
   2 s a call, and a warm Haiku call takes about 1.6 s.
5. **The re-read and the composer.** The one re-read (cold) took 4.3 s, inside its 3 to 6 s. The one composer call
   (cold) took 4.0 s, past its 2 to 3 s and inside its 6 s timeout.

## For the CTO (options, not changes: the card's "Not here")

1. Keep the prefixes warm on a quiet bundle: Anthropic's 1-hour cache lifetime (its write costs twice the 5-minute
   write, which the gateway's price table does not hold yet, NQ-AI-2), or a keep-warm call per stage and model inside
   every 5 minutes. Each costs money and is the CTO's call.
2. Decide's 2 to 4 s was set before decide became two calls in series (CQ-25, T-1068): whether it is a read's budget
   or a call's is open question 2.
3. Q-41's own page budgets add up to 21.65 s with a re-read and a rewrite, and staging's cold p50s to 21.0 s: either
   18 s holds for warm turns alone, or the path needs a cut.

## How the times are measured

**Through the production code alone** (`units.mjs`), with the readers `runtime/src/wiring/staging/models.ts` builds on
staging: `createSafetyReader` (the safety read's own path: one 2 s try per model, Haiku then Sonnet),
`createDecider` and `createDecideReader` (decide's two-step reads through the gateway) and `createComposer` (a composer
call and its one rewrite through the gateway), on staging's own bundle, `bundles/v0/bundle` (`baefa1e9c103…/2`: the
prompts safety-read-1, decide-1 and composer-4; claude-haiku-5-5 and claude-sonnet-5-5; its routing policy: Haiku twice
on low stakes, Sonnet first and Haiku checking on high, the re-read on Sonnet). Every time is a K-08 span's `ms`, as
the gateway (or the safety read) records it on the unit's own trace; nothing changes a prompt, a model, a timeout or a
route. The inputs are the contracts' fiction: K-02's S1-02 turn (`context-s1-02.json`, put on bundle v0's id, rules
and S1-02 card), K-03's S1-02 composer input (`input-s1-02-v1.1.json`), and the rewrite tests' A7-17 case, told what
`check-two-questions.json` tells.

**The plan** (22 units, run one at a time, in rounds, so a slow minute at Anthropic falls on every stage): 5 safety
reads on Haiku; 3 low-stakes decide stages (two Haiku reads side by side, each step 1 then step 2: 4 calls); 2 Sonnet
re-reads (2 calls each); 3 composer calls on Haiku; 2 rewrites on Haiku; 3 safety reads whose Haiku try is answered
locally as overloaded, so their Sonnet try runs for real; 2 decide reads on Sonnet (a high-stakes first read); and 2
composer calls whose two Haiku attempts are answered locally as overloaded, so the gateway's fallback, Sonnet, runs
for real. That is 35 calls when each answers first time, 5 under the card's 40. The gateway's retries count too; past
40 in all, counting every earlier live run's calls, a call is answered locally and never sent. A call answered locally
is never counted, timed or charged.

**The one way out** (`wire.mjs`): the `fetch` every reader is handed. It takes the gateway's Messages endpoint alone
and sends to Anthropic (live) or to the stub on 127.0.0.1 (dry) alone. It times each call to its last byte without
passing on the stage's abort signal, so a call its stage timed out still shows its real time (the "wire times"), and
its records hold labels and counts alone: never a header, a prompt or an answer's words. It counts each call before
the call goes out: a live run puts it on disk first, one line in `runs/sent.jsonl` flushed to the disk, and a call
that cannot be counted is not sent. With `runs/live.lock`, which one live run at a time holds, that keeps the cap of
40 across runs, however a run ends ("How the count is kept", under "Source 1").

**Warm and cold.** A call that wrote the prompt cache (`cache_write_tokens` above 0) found its prefix uncached: a cold
call. A call that answered and wrote nothing read its prefix from the cache: a warm one. A call with no answer (timed
out, failed) has no usage, so it is neither. A read or a stage is warm when every call of it is. The cache lives 5
minutes from its last read (`ai/src/cache/rules.ts`), so a busy bundle runs warm and a quiet one, like staging today,
mostly cold.

**Percentiles are nearest-rank**: the p-th percentile of n times is the ceil(p/100 × n)-th smallest, always a time
that was measured. With fewer than 20 times a p95 is the largest one, so every p95 here is the worst of a handful: a
first look, not a proven bound.

**The key** (the lead note, item 1): `run.sh` reads `ANTHROPIC_API_KEY` by name, from the environment, else (a live run
alone) from `.dev.vars` through `infra/scripts/lib.sh`'s `load_dev_var`, as `seed-staging.sh` does; never exported,
never an argument, never printed. `run.mjs` takes it on standard input alone and hands it to the readers as their
`env`. A dry run reads no key. Neither mode runs with `CI` set.

## Source 1: the live run

Not made yet. The auto-mode classifier refused the builder's one live run (`bash ai/spikes/model-times/run.sh --live`,
Nov 16 about 01:12Z), so, as the card's lead note (DL-860) says, it was not tried another way. The one command, by the
lead or the user's `!`, from the main checkout (whose `.dev.vars` holds `ANTHROPIC_API_KEY`; a worktree holds no key)
once `task/T-362` is merged:

```sh
bash ai/spikes/model-times/run.sh --live
```

It refuses with `CI` set or without a key, makes at most 40 calls (35 planned), prints its tables ready for this
section, and writes `ai/spikes/model-times/runs/live-<time>.json` (commit it beside this file, with
`runs/sent.jsonl`). The command `node ai/spikes/model-times/report.mjs <that file>` prints the same tables again.

**How the count is kept** (DL-870): on disk, before any call goes out, so the cap of 40 holds across runs however a
run ends.

1. A live run first holds `runs/` alone: it creates `runs/live.lock` exclusively (`wx`). Of two runs started
   together, one holds it and the other is refused before it reads the count or sends a call.
2. Holding it, the run reads the calls made so far: for each earlier run, the larger of its lines in
   `runs/sent.jsonl` and the calls its results file lists as gone out. If its 35 planned calls would pass 40, it is
   refused.
3. Before each call goes out, the run appends one line for it to `runs/sent.jsonl` and flushes it to the disk: the
   run's start, the call's number in all, its unit, kind, call and model, and the time; never a header, a prompt, an
   answer's words or the key. A call that cannot be counted is not sent.
4. At its end the run writes its results file and gives up the hold; a run that ends by a throw gives it up too.

So a run stopped at any point leaves every call it sent counted, the one going out included. One whose process is
stopped (Ctrl-C, a closed terminal or session, a cut-off `!` command) also leaves `runs/live.lock`: the next run is
refused until a person, once no live run is going, removes it. That run's cap is then 40 less every call counted, and
it is refused if its 35 would pass 40; a second run after a whole one is refused (35 and 35 pass 40).
`model-times.test.mjs` proves it: a run killed during its 3rd call (SIGKILL, as Ctrl-C stops it) leaves 3 counted
and its hold, the next run is refused until the hold is removed and then starts from 3, and two runs started
together, in one process or in two, never both send.

The dry run (`bash ai/spikes/model-times/run.sh --dry-run`: the same 22 units against the stub on 127.0.0.1, no key,
no network) walks every unit through the production readers: 35 calls out, 7 Haiku calls answered locally as the
fallback on purpose, every unit answered.

## Source 2: staging's own spans since deploy 43

From the lead's `wrangler tail --format json` capture of staging (`b2zzfuf4l.output`, labels only, as staging logs
them), read with `node ai/spikes/model-times/staging-spans.mjs <capture>`: every portCall span to Anthropic of deploy
43's version (main c244c38, deployed 17:42Z Nov 15, DL-836), each span once, to the capture's end. The version before
it (19f574a) failed its model calls at 0 ms, before sending, so these are staging's first real model calls: tp-01's
JOIN (DL-836), the user's tries (DL-844, DL-846) and the safety read's 30 s re-reads of one text (DL-846). There are 65
model calls, from 17:43:03Z to 19:06:54Z:

| Purpose · model         |   n |      p50 |      p95 |      max | warm n | warm p50 | warm p95 | cold | timed out | failed |
| ----------------------- | --: | -------: | -------: | -------: | -----: | -------: | -------: | ---: | --------: | -----: |
| safetyRead · haiku-5-5  |  36 | 1,071 ms | 2,000 ms | 2,000 ms |     32 | 1,051 ms | 1,569 ms |    2 |         2 |      0 |
| safetyRead · sonnet-5-5 |   2 | 1,389 ms | 2,000 ms | 2,000 ms |      0 |        - |        - |    1 |         1 |      0 |
| decideFirst · haiku-5-5 |  12 | 1,581 ms | 5,549 ms | 5,549 ms |      7 | 1,565 ms | 2,021 ms |    5 |         0 |      0 |
| decideCheck · haiku-5-5 |  12 | 1,765 ms | 5,402 ms | 5,402 ms |      7 | 1,560 ms | 3,427 ms |    5 |         0 |      0 |
| reread · sonnet-5-5     |   2 | 2,042 ms | 2,284 ms | 2,284 ms |      0 |        - |        - |    2 |         0 |      0 |
| compose · haiku-5-5     |   1 | 4,031 ms | 4,031 ms | 4,031 ms |      0 |        - |        - |    1 |         0 |      0 |

Decide's reads are joined from the spans (a call starting within 1,000 ms of the read's last end is its next step);
the decide stage is a first and a check read of one trace whose times overlap:

| Read · model                                     |   n |      p50 |      p95 |      max | warm n | warm p50 | warm p95 | budget |
| ------------------------------------------------ | --: | -------: | -------: | -------: | -----: | -------: | -------: | ------ |
| decideFirst · haiku-5-5                          |   6 | 3,232 ms | 7,114 ms | 7,114 ms |      3 | 3,056 ms | 3,232 ms | 2–4 s  |
| decideCheck · haiku-5-5                          |   6 | 3,673 ms | 6,374 ms | 6,374 ms |      3 | 3,325 ms | 4,651 ms | 2–4 s  |
| reread · sonnet-5-5                              |   1 | 4,326 ms | 4,326 ms | 4,326 ms |      0 |        - |        - | 3–6 s  |
| decide stage (first and check read side by side) |   6 | 3,943 ms | 7,114 ms | 7,114 ms |      3 | 3,325 ms | 4,651 ms | 2–4 s  |

Safety read, Haiku: 36 tries; 2 timed out at the 2 s try (17:43:03.688Z, the version's first model call; 18:22:49.246Z,
39 minutes after the last safety read); the 34 that answered took p50 1,051 ms, p95 1,569 ms, max 1,611 ms. The
version's first safety-read calls: Haiku timed out at 2,000 ms (17:43:03Z), then Sonnet timed out at 2,000 ms
(17:43:05Z); at 17:43:38Z Haiku answered in 1,047 ms, writing the cache.

## Defaults used

1. The fallback on purpose: Sonnet's safety read and Sonnet's composer call are reached by answering the Haiku calls
   locally as overloaded (HTTP 529), so the production fallback runs for real; no code changes for it.
2. The decide stage is measured on low stakes (bundle v0 routes S1-02 to Haiku twice); Sonnet's decide is one
   high-stakes first read, and a high-stakes stage is the slower of a Sonnet read and a Haiku read side by side.
3. Q-41's path runs from the last text's arrival (Q-41's default): the batch's 3 s, the frontier's 150 ms, one
   search's 200 ms, the gate's 300 ms and the send's 1 s at their budgets, plus the measured decide stage, Sonnet
   re-read, one Haiku composer call and one Haiku rewrite. The ack is left out (the reply clock starts at the last
   text); a p95 line adds the stages' p95s, an upper bound on the path's own p95; the safety read is off the path (it
   runs on arrival, inside the batch's 3 s).
4. No rewrite has run on staging, so staging's path takes one more composer call for it (the same prompt and schema).
5. Percentiles are nearest-rank; with n under 20 a p95 is the largest time measured.
6. Warm: answered and wrote no cache; cold: wrote the cache; a call with no answer is neither; a read or a stage is
   warm when every call of it is.
7. Staging's source is deploy 43's version alone (c244c38); its decide reads are joined from spans by a 1,000 ms gap,
   and a stage is a first and a check read of one trace whose times overlap.
8. The live run's plan: 35 calls (5 safety reads on Haiku, 3 decide stages, 2 re-reads, 3 composer calls, 2 rewrites,
   3 safety reads on Sonnet, 2 decide reads on Sonnet, 2 composer calls on Sonnet), under the card's 40.
9. The inputs: K-02's S1-02 context, K-03's S1-02 composer input and the rewrite tests' A7-17 case; the safety reads
   alternate two ordinary texts from those fixtures (no danger text).

## Open questions (for QUESTIONS.md)

1. (CTO, Q-41) Is 18 s at p95 for warm turns only, or also for a quiet bundle's cold turns? Staging's cold p50s
   already add up to 21.0 s with a re-read and a rewrite.
2. (CTO) Is decide's 2 to 4 s (arch 04 line 219) a read's budget, two calls in series since CQ-25 (T-1068) as
   two-reads.ts reads it, or a call's? The gateway times each call out at 8 s.
3. (CTO, DL-836) After a quiet spell both safety tries can time out (17:43:03Z): keep 2 s a try (the 5 s safety line)
   and the actor's no-verdict rule, or keep the safety prefix warm at a cost?

## Files

- `run.sh`: the entry point; reads the key by name and hands it over on standard input.
- `run.mjs`: the run: refusals, the hold on `runs/` and the count on disk, the units, the results file and the
  tables.
- `units.mjs`: the units, on the production readers and staging's bundle v0.
- `wire.mjs`: the one way out (the endpoint, the cap, each call counted before it goes out, the fallback on purpose,
  the wire times).
- `stub.mjs`: the dry run's stand-in on 127.0.0.1, answering from the contracts' fixtures.
- `stats.mjs`: percentiles, arch 04's budgets and Q-41's path.
- `report.mjs`: the tables (`node ai/spikes/model-times/report.mjs <results.json>`).
- `staging-spans.mjs`: staging's spans from a tail capture.
- `model-times.test.mjs`: 32 tests (`node --test ai/spikes/model-times/model-times.test.mjs`): the percentile and
  timing maths, the wire's refusals and cap, a whole dry run, a whole live-mode run on a stand-in transport, the
  refusals, the count on disk and the hold (a run killed during a call; two runs started together, in one process and
  in two), and the staging reader. No Vitest project includes it, so CI runs none of it.
