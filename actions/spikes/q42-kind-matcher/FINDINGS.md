# T-631 findings: how the kind matcher maps words to the 243 kinds (Q-42)

**The answer.** Method **A**: plain text on K-24 v1's `kinds.name`, `style` and `pattern` of the 243 `trade_file` rows,
in code, with no model and **no stored index**, as K-09 v1's `matchKinds` for an owner's words at S1-02. QUESTIONS
M4.1's default holds: no K-24 version, no migration, no database task. It puts the right kind first for 16 of the 18
owner words that name a kind, and in the pick-list's top 3 for 17 of 18, in about 2 to 3 µs a match from a 22 KB table
built in under 1 ms. It does **not** match a customer's request by meaning: 4 of 25 customer words (A4-03, B4-04 and
the master's cast) and 0 of 12 words that fit two kinds. No plain-text method does: adding each trade's own services and
questions text (B) brings 18 of the 25 customer words' kinds into its top 3, but its outcome is right for only 10 of 25,
it offers a kind for all 4 of S1-02's "not a service we book" words, and its 427 KB word table is not in K-24. So
journey 4's match (search's trade filter; A4-03's and B4-04's "which?") needs a meaning read, a model's (C) or an
embedding index's (D), and neither could be run here: open questions 1 and 2, for the architect and the CTO before M5.

Card: T-631 (C-130; M4; deployment spike-kind-matcher), with its lead note (DL-867, DL-880). Reads: Q-42 and M4.1
(`ops/QUESTIONS.md`); K-24 v1 (`contracts/db-schema/kinds-of-work/README.md` lines 41 and 88); arch 05 line 237
(`scratch/text/architecture.txt`); RULES 1.4; S1-02, A4-03 and B4-04 printed from the read-only master copy. Nothing
here is built into the product: the matcher is T-632's and the design record the architect's (the card's "Not here").
The tables below are `compare.mjs`'s output, and `q42-kind-matcher.test.mjs` holds them to it cell by cell.

## The question

- **Q-42:** "Which model or index does the meaning match use? It maps a person's words to one of the 243 kinds of
  work". Default: none is named; a 2-hour spike picks one (for example vector search inside PostgreSQL).
- **Arch 05 line 237:** "an owner's words at sign-up are matched by meaning to the closest of the 243 kinds, and the
  owner picks (S1-02); a customer's request is matched the same way; words that fit two kinds get one 'which?' first
  (A4-03, B4-04), and the kind picked is search's trade filter. Words that fit no kind, or work Rosie never books
  (RULES 1.4) or can't book (A4-99): nothing is searched".
- **K-09 v1 `matchKinds`** (`contracts/tool-api/tool-api.v1.schema.json`): each part of the owner's words gets an
  outcome, `listed` (one kind), `which` (two), `new_work` or `not_booked` (none); "Reads: the primary, uncached, and
  the meaning-match index (Q-42)"; it may answer `indexUnavailable`, and has a proposed budget of at most 200 ms
  (README default 3). It is called by the frontier builder for S1-02's facts and by registration screen 1.
- **K-24 v1** (README line 41) **and M4.1:** the matcher reads `kinds.name`, `style` and `pattern` of the `trade_file`
  rows; no stored index unless this spike shows one is needed, and then an additive K-24 version and one migration.

## The candidates

- **A0**, plain text on `kinds.name` alone. No model, no stored index. Run.
- **A**, plain text on `kinds.name`, `style` and `pattern`: K-24 v1 as frozen. No model, no stored index. Run.
- **B**, A plus each trade's `pf.services` and `pf.questions` text blocks (K-01 v1 `tradeOverlay.pluginText`, each read
  whole, never by a sub-key: MC R3). No model; its words are not in K-24 (see "Cost"). Run.
- **C**, a model read: K-24's 243 kinds in a Haiku 5.5 read through the AI gateway, answering `matchKinds`' outcome,
  the ids checked against the catalog by code. No stored index; one model call a match. **Not run:** the lead note
  allows no live model call and no key here, and no recorded output of such a read exists in the repository (the
  decide-wire and structured-outputs spikes recorded decide, safety, planner and message-plan reads, not kind picks).
- **D**, vector search in PostgreSQL: an embedding of each kind and of the words, nearest by cosine (pgvector).
  Stored index: a vector per kind, so a K-24 v1.1 and a migration. **Not run:** the AI gateway (`ai/src/gateway`) has
  no embedding call, so an embedding model is a new port and provider (an account, a key and spend: rule 6, Jay's OK),
  and no recorded embedding exists.
- **E**, a PostgreSQL full-text or trigram index over A's or B's words. Stored index: a GIN index, so a K-24 v1.1 and
  a migration. **Not run:** no throwaway database on the shared Mac (DL-769). It matches the same words A or B reads,
  so it can only rank them differently; it cannot add a meaning the words lack ("a leaking pipe under my sink" shares
  no word with Plumber's name, style or pattern), and at 243 kinds it adds no speed (A matches in microseconds).

**How A0, A and B match** (`words.mjs`, `matchers.mjs`): a person's words are lower-cased, numbers and a short list of
function words dropped and plurals folded. A word meets a catalog word when they are the same, when one starts the
other (4 letters or more: "hair", "haircut") or when both start with the same 5 letters ("plumbing", "plumber"),
weighed by the share of the longer word they have in common. The 243 kinds are ranked by Okapi BM25 (k1 1.2, b 0.75)
over what each candidate reads, a kind's name words counted 3 times. The outcome: `none` when the top score is under
1.5; `which` with the top two when the second scores at least 0.8 of the first; else `listed` with the top one. Every
setting was fixed before the first run and none was tuned on these samples; the ratio table shows the others.

## The samples (47)

- **S1-02** (7): the owner's "Barbershop, plumbing, electrical" (K-24's `seed-business-kinds.json` picks barber,
  plumber and electrician), and S1-02's own "Not a service we book" words, which fit no kind: "Gift cards", "goods with
  no visit", "delivery only", "renting a thing alone".
- **S1-02 trades** (15): S1-02's answer as nine trade files word it (`step.js A S1-02 --prof <trade>`), each part that
  names one kind ("Overnight camp", "ski lessons", "personal training", "massage", ...).
- **A4-03** (2): "haircut" (A4-03: "A haircut could mean a salon or a barbershop": hair and barber) and "facial" (A4-03
  as the barber trade words it: "a barbershop or a skin care studio": barber and esthetician).
- **B4-04** (3): "clog" and "leak" (B4-04: "Its questions: where the clog or leak is": plumber) and "water heater"
  (B4-04 as the plumber trade words it: "a plumber or a heating tech": plumber and hvac).
- **cast** (20): the master's customers' and their AIs' requests (A3-02, A3-20, A3-27, B3-02, B3-42, B3-05, B4-44,
  B4-48) and the sample story's services (master-A.json's and master-B.json's amounts), each its business's kind; a
  cut, a color or a style fits hair too (A4-03's rule), and a water heater hvac too (B4-04's rule as the plumber words
  it).
- **Words that fit two kinds:** 12 of the 47, across the groups.

Each sample is scored three ways: **right**, the outcome `matchKinds` should answer (`listed` with the one kind,
`which` with both of two, `none` for words that fit no kind); **found**, every kind the words fit is among the
outcome's kinds (for words that fit no kind: none offered); **top 3**, every kind the words fit is among the three
closest, the S1-02 pick-list ("Sam picks. A pick-list helps").

## Hit rates

<!-- hit-rates -->

| Sample words | n   | A0 right | A0 found | A0 top 3 | A right | A found | A top 3 | B right | B found | B top 3 |
| ------------ | --- | -------- | -------- | -------- | ------- | ------- | ------- | ------- | ------- | ------- |
| S1-02        | 7   | 6/7      | 6/7      | 3/3      | 5/7     | 5/7     | 3/3     | 2/7     | 3/7     | 3/3     |
| S1-02 trades | 15  | 10/15    | 14/15    | 14/15    | 10/15   | 13/15   | 14/15   | 9/15    | 14/15   | 15/15   |
| A4-03        | 2   | 0/2      | 0/2      | 0/2      | 0/2     | 0/2     | 0/2     | 0/2     | 0/2     | 2/2     |
| B4-04        | 3   | 0/3      | 0/3      | 0/3      | 0/3     | 0/3     | 0/3     | 1/3     | 2/3     | 2/3     |
| cast         | 20  | 4/20     | 4/20     | 4/20     | 4/20    | 4/20    | 4/20    | 9/20    | 11/20   | 14/20   |
| two kinds    | 12  | 0/12     | 0/12     | 0/12     | 0/12    | 0/12    | 0/12    | 2/12    | 2/12    | 7/12    |
| all          | 47  | 20/47    | 24/47    | 21/43    | 19/47   | 22/47   | 21/43   | 21/47   | 30/47   | 36/43   |

C, D and E: not run (above), so no hit rate.

## Each sample

A "✓" marks a right outcome.

<!-- per-sample -->

| Words                                                                                 | Step                                                     | Fits                | A0 outcome                   | A outcome                           | B outcome                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------- |
| Barbershop                                                                            | S1-02 (owner → san); K-24 seed-business-kinds            | barber              | ✓ listed barber              | ✓ listed barber                     | ✓ listed barber                          |
| plumbing                                                                              | S1-02 (owner → san); K-24 seed-business-kinds            | plumber             | ✓ listed plumber             | ✓ listed plumber                    | ✓ listed plumber                         |
| electrical                                                                            | S1-02 (owner → san); K-24 seed-business-kinds            | electrician         | ✓ listed electrician         | ✓ listed electrician                | which electrician, boat-repair           |
| Gift cards                                                                            | S1-02 'Gift cards are never set up'                      | none                | listed cardiologist          | listed cardiologist                 | which personal-shopper, teeth-whitening  |
| goods with no visit                                                                   | S1-02 'Not a service we book'                            | none                | ✓ none                       | which electrician, handyman         | which vet, medspa                        |
| delivery only                                                                         | S1-02 'Not a service we book'                            | none                | ✓ none                       | ✓ none                              | which baker, florist                     |
| renting a thing alone                                                                 | S1-02 'Not a service we book'                            | none                | ✓ none                       | ✓ none                              | which organizer, flight-school           |
| Overnight camp                                                                        | S1-02 --prof camp                                        | camp                | ✓ listed camp                | ✓ listed camp                       | ✓ listed camp                            |
| backyard camps                                                                        | S1-02 --prof camp                                        | camp                | ✓ listed camp                | ✓ listed camp                       | ✓ listed camp                            |
| Golf academy                                                                          | S1-02 --prof golf-instructor                             | golf-instructor     | ✓ listed golf-instructor     | ✓ listed golf-instructor            | ✓ listed golf-instructor                 |
| golf lessons                                                                          | S1-02 --prof golf-instructor                             | golf-instructor     | which golf-instructor, music | which golf-instructor, music        | ✓ listed golf-instructor                 |
| course coaching                                                                       | S1-02 --prof golf-instructor                             | golf-instructor     | which tennis-coach, coach    | which tennis-coach, coach           | which coding-classes, mini-golf          |
| party rentals                                                                         | S1-02 --prof rentals                                     | rentals             | ✓ listed rentals             | ✓ listed rentals                    | which rentals, auto-body                 |
| Ski school                                                                            | S1-02 --prof ski-instructor                              | ski-instructor      | ✓ listed ski-instructor      | ✓ listed ski-instructor             | ✓ listed ski-instructor                  |
| ski lessons                                                                           | S1-02 --prof ski-instructor                              | ski-instructor      | which ski-instructor, music  | which ski-instructor, music         | ✓ listed ski-instructor                  |
| snowboard lessons                                                                     | S1-02 --prof ski-instructor                              | ski-instructor      | which music, ski-instructor  | which ski-instructor, music         | ✓ listed ski-instructor                  |
| private coaching                                                                      | S1-02 --prof sports-coach                                | sports-coach        | ✓ listed sports-coach        | ✓ listed sports-coach               | which coach, sports-coach                |
| Surf school                                                                           | S1-02 --prof surf-school                                 | surf-school         | ✓ listed surf-school         | ✓ listed surf-school                | ✓ listed surf-school                     |
| Swim school                                                                           | S1-02 --prof swim                                        | swim                | ✓ listed swim                | ✓ listed swim                       | ✓ listed swim                            |
| Training studio                                                                       | S1-02 --prof trainer                                     | trainer             | which dog-trainer, trainer   | which cpr-training, dog-trainer     | which trainer, massage                   |
| personal training                                                                     | S1-02 --prof trainer                                     | trainer             | ✓ listed trainer             | ✓ listed trainer                    | which trainer, cpr-training              |
| massage                                                                               | S1-02 --prof trainer                                     | massage             | ✓ listed massage             | ✓ listed massage                    | which massage, spa                       |
| haircut                                                                               | A4-03 'a salon or a barbershop'                          | hair, barber        | which hair, hair-restoration | which hair, hair-restoration        | which hair, hair-restoration             |
| facial                                                                                | A4-03 --prof barber 'a barbershop or a skin care studio' | barber, esthetician | none                         | none                                | which esthetician, spa                   |
| clog                                                                                  | B4-04 'where the clog or leak is'                        | plumber             | none                         | none                                | ✓ listed plumber                         |
| leak                                                                                  | B4-04 'where the clog or leak is'                        | plumber             | none                         | none                                | which rv-repair, plumber                 |
| water heater                                                                          | B4-04 --prof plumber 'a plumber or a heating tech'       | plumber, hvac       | listed restoration           | listed restoration                  | which plumber, rv-repair                 |
| Book me a haircut at Lee's Barbershop on Saturday.                                    | A3-02                                                    | barber              | ✓ listed barber              | ✓ listed barber                     | ✓ listed barber                          |
| Walk-in for a haircut                                                                 | A3-20 (A4-03's rule)                                     | hair, barber        | which dog-walker, hair       | which dog-walker, hair              | ✓ which barber, hair                     |
| Can Lee's Barbershop do a haircut on Saturday morning? What does it cost?             | A3-27                                                    | barber              | ✓ listed barber              | ✓ listed barber                     | ✓ listed barber                          |
| Groom's package                                                                       | master-A amounts                                         | barber              | listed groomer               | listed groomer                      | which groomer, barber                    |
| Signature cut and hot towel shave                                                     | master-A amounts                                         | barber              | listed pool-builder          | listed pool-builder                 | ✓ listed barber                          |
| Style consult                                                                         | master-A amounts (A4-03's rule)                          | hair, barber        | which pharmacist, lactation  | which college-admissions, architect | which image-consultant, personal-shopper |
| Color and cut                                                                         | master-A amounts (A4-03's rule)                          | hair, barber        | none                         | none                                | ✓ which barber, hair                     |
| Color touch-up                                                                        | master-A amounts (A4-03's rule)                          | hair, barber        | none                         | none                                | which pmu, hair                          |
| Color correction                                                                      | master-A amounts (A4-03's rule)                          | hair, barber        | none                         | none                                | listed hair                              |
| My kitchen drain is clogged. Can a plumber come Thursday morning? I'm in Springfield. | B3-02                                                    | plumber             | ✓ listed plumber             | ✓ listed plumber                    | ✓ listed plumber                         |
| Hi, it's about a leaking pipe under my sink. A text back is fine.                     | B3-42                                                    | plumber             | none                         | none                                | ✓ listed plumber                         |
| Can a plumber clear a yard drain this Thursday? What does it cost?                    | B3-05                                                    | plumber             | ✓ listed plumber             | ✓ listed plumber                    | ✓ listed plumber                         |
| Can you flush my water heater every year, too?                                        | B4-44 (B4-04's rule)                                     | plumber, hvac       | listed restoration           | listed restoration                  | listed plumber                           |
| Can Jordan also look at a dripping faucet?                                            | B4-48                                                    | plumber             | none                         | none                                | ✓ listed plumber                         |
| Kitchen drain clearing                                                                | master-B amounts                                         | plumber             | none                         | none                                | listed excavation                        |
| Water heater flush                                                                    | master-B amounts (B4-04's rule)                          | plumber, hvac       | listed restoration           | listed restoration                  | listed plumber                           |
| Water pressure check                                                                  | master-B amounts                                         | plumber             | listed pressure              | listed pressure                     | which well-pump, pressure                |
| Water heater replacement                                                              | master-B amounts (B4-04's rule)                          | plumber, hvac       | listed restoration           | listed restoration                  | which rv-repair, plumber                 |
| Water heater fix                                                                      | master-B amounts (B4-04's rule)                          | plumber, hvac       | listed restoration           | which restoration, tv-repair        | which plumber, aquarium                  |
| Leak repair                                                                           | master-B amounts                                         | plumber             | which appliance, auto-repair | which tv-repair, appliance          | which rv-repair, plumber                 |

## Shortlists: how far down the ranking the right kinds are

For the words that fit a kind, the share whose every kind is among the k closest. An owner's words name a trade, and
the kinds' names carry them; a customer's words describe the work, and only the trades' own text (B) carries some of
them.

<!-- shortlists -->

| Candidate · words                   | n   | top 1 | top 2 | top 3 | top 5 | top 10 |
| ----------------------------------- | --- | ----- | ----- | ----- | ----- | ------ |
| A0 · owners (S1-02, S1-02 trades)   | 18  | 15/18 | 17/18 | 17/18 | 17/18 | 17/18  |
| A0 · customers (A4-03, B4-04, cast) | 25  | 4/25  | 4/25  | 4/25  | 4/25  | 4/25   |
| A · owners (S1-02, S1-02 trades)    | 18  | 16/18 | 16/18 | 17/18 | 17/18 | 17/18  |
| A · customers (A4-03, B4-04, cast)  | 25  | 4/25  | 4/25  | 4/25  | 4/25  | 5/25   |
| B · owners (S1-02, S1-02 trades)    | 18  | 16/18 | 17/18 | 18/18 | 18/18 | 18/18  |
| B · customers (A4-03, B4-04, cast)  | 25  | 8/25  | 14/25 | 18/25 | 20/25 | 22/25  |

## The "which?" ratio

"Right" over all 47 samples when the second kind counts as close at other shares of the first's score (0.8 is in
force). No ratio makes plain text right on most samples.

<!-- ratios -->

| Candidate | right at 0.6 | right at 0.7 | right at 0.8 | right at 0.9 |
| --------- | ------------ | ------------ | ------------ | ------------ |
| A0        | 13/47        | 15/47        | 20/47        | 20/47        |
| A         | 13/47        | 13/47        | 19/47        | 20/47        |
| B         | 14/47        | 18/47        | 21/47        | 23/47        |

## Cost per match

**Measured** with `node actions/spikes/q42-kind-matcher/compare.mjs` on the build Mac (Node 22.23.1), Nov 16 2026,
with other builders running: each table built 5 times (median), then 200 rounds of the 47 samples (9,400 matches) per
candidate. Four runs that morning gave A's match p50 between 2.0 and 3.1 µs and B's between 24.9 and 30.2 µs; the
last run's numbers:

| Candidate | Table build | Words | Table as JSON | Match p50 | Match p95 |
| --------- | ----------- | ----- | ------------- | --------- | --------- |
| A0        | 0.4 ms      | 449   | 19,321 B      | 2.3 µs    | 7.8 µs    |
| A         | 0.5 ms      | 458   | 21,823 B      | 2.0 µs    | 5.5 µs    |
| B         | 56.0 ms     | 4,185 | 427,324 B     | 28.6 µs   | 140.4 µs  |

- **A0 and A** read only K-24's columns: 243 rows, read once per bundle (the catalog changes only with a bundle: K-24
  rule 7) and held in memory. `matchKinds`' proposed 200 ms holds with room. No stored index, no model, no money.
- **B**'s words are not in K-24 ("The rest of a trade file (its money examples, amounts, services, ...) is K-01's
  bundle, never stored here": K-24 README line 30). Built at run time, B needs every trade overlay, 243 KV values
  holding 24.952 MiB of trade files (K-01 README lines 42 and 61), where a turn reads 3 values (line 45). So B needs its
  word table stored once per bundle: a new K-01 part (one KV value of about 427 KB, written by the compiler), or a K-24
  column filled by the catalog seed (an additive K-24 version and a migration, against line 30's rule).
- **C** (not run; an estimate from the repository's own numbers): the catalog as the read would carry it, one
  "id · name · style" line per kind (`compare.mjs` `catalogLines`), is 10,382 characters, about 2,600 tokens at about 4
  characters a token (an assumption: counting tokens needs a call). At `ai/src/gateway/prices.ts`'s Haiku 5.5 prices
  (not yet confirmed by the CTO: NQ-AI-2), with the catalog and about 400 tokens of instructions cached, about 30
  tokens of words and an answer of about 40 tokens, a match costs about 53 micro-dollars warm and about 400 when the
  cache is written (the cache lives 5 minutes from its last read: `ai/src/cache/rules.ts`). Its time: T-362's staging
  spans put a warm Haiku call at p50 1,051 to 1,565 ms and a cold one up to 5,549 ms (`ai/spikes/model-times`), far
  past `matchKinds`' 200 ms: a model read fits only inside decide's 2 to 4 s stage, as a field of a read decide
  already makes (a K-02 and K-09 change), not as a Tool API read.
- **D** (not run): one outside embedding call per match, at a price and time set by a provider not chosen; the
  vectors are a stored index in K-24 (v1.1 and a migration, with pgvector on the host); at 243 rows an exact scan
  needs no approximate index.
- **E** (not run): a GIN index in K-24 (v1.1 and a migration) for no speed that A lacks.

## The named method, for the design record

**A**, plain text on `kinds.name`, `style` and `pattern` of the `trade_file` rows (K-24 v1 as frozen), as
`matchKinds` for S1-02:

1. **Stored index: none.** M4.1's default holds: no K-24 version, no migration, no database task. The catalog is read
   as data (README line 41), 243 rows once per bundle, and held in memory.
2. **Cost:** under 1 ms to build per bundle and isolate, about 22 KB, 2 to 3 µs a match (p95 under 12 µs in every
   run); no model call and no money.
3. **What it gives S1-02:** the owner's pick-list. The right kind is first for 16 of 18 owner words and in the top 3
   for 17 of 18 ("course coaching" is the miss). A0, the name alone, does as well within one word, so style and pattern
   add nothing measurable either way; A keeps K-24's README as written.
4. **Its limits, which T-632 and T-633 must not hide:**
   1. Its `none` cannot say whether the words are new work or not booked: K-09's `not_booked` (RULES 1.4) needs a
      meaning read. A answers `none` for 2 of S1-02's 4 not-booked words and offers a kind for the other 2 ("Gift
      cards" → cardiologist, through the shared start "card"; "goods with no visit" → electrician or handyman, through
      the style "Home visit"). S1-02's safe default stands: a part with no kind is drafted as new work, offline until
      Rosie's team reviews it, and the owner's pick decides.
   2. A `which` from A comes from a shared word ("lessons" in "Music lessons"), not from meaning: it is right for 0 of
      the 12 words that fit two kinds.
   3. It is not the customer-side matcher: 4 of 25 customer words.

## Journey 4 (search's trade filter, M5): not decided here

Plain text does not match a customer's request by meaning. B, the best of it, has 18 of 25 customer words' kinds in
its top 3 and 22 of 25 in its top 10, but its own outcome is right for 10 of 25, it names wrong trades with confidence
("Kitchen drain clearing" → excavation; "Water pressure check" → well-pump or pressure), and it offers a kind for all 4
not-booked words. A wrong trade filter searches the wrong businesses ("the kind picked is search's trade filter": arch
05 line 237), so B's own outcome must never drive search. The choice is the architect's and the CTO's (open
question 1): C, a model read with the whole catalog (10,382 characters) in its cached prefix, so no shortlist is
needed and no index is stored; or D, an embedding index (a new provider and a K-24 v1.1). Either needs its hit rate
measured on these 47 samples and more before it is relied on (open question 2).

## Notes for T-632 (not decisions)

1. Read the catalog once per bundle id and hold A's table in memory; `matchKinds`' own read of the primary is then the
   bundle's kinds rows, not an index.
2. "Gift cards" → cardiologist comes from a 4-letter shared start (4 of 12 letters). A rule that a meeting shares at
   least half of the longer word is worth testing on a bigger sample; it was not applied here (no setting was tuned).
3. Split an owner's answer at commas, semicolons and line breaks, never at "and": a kind's own name can hold it ("Pet
   boarding and doggy daycare").

## Defaults used

1. **The catalog** is fixture set v1's trade files read the way the kinds seed (T-212, `db/seeds/kinds.ts`) reads
   them: each file checked against `fixtures/master/SHA256SUMS`, then T-133's `parseTrade`. No seeded database was
   started on the shared Mac; the test holds the values to K-24's `seed-kinds-sample.json`.
2. **Sample words** come from S1-02, A4-03 and B4-04 as printed from the read-only master copy, with `--prof` for a
   trade's own words of the same step (S1-02 by 9 trades, A4-03 by the barber, B4-04 by the plumber), and from the
   master's cast, read as master-A.json's and master-B.json's customers' requests (A3-02, A3-20, A3-27, B3-02, B3-42,
   B3-05, B4-44, B4-48) and sample services (amounts). RULES 1.4's own examples (horse boarding, stall-only rental,
   shooting lane-only) were not used: the lead note limits sample words to those steps and the cast.
3. **Right answers** come from the steps' own words: S1-02's three from K-24's `seed-business-kinds.json`; "salon" is
   hair (Hair salon), "skin care studio" esthetician (Esthetician / skin care), "heating tech" hvac (HVAC technician);
   a cast service is its business's kind, and also hair for a cut, a color or a style (A4-03's rule) and hvac for a
   water heater (B4-04's rule as the plumber words it). Parts that name no kind clearly were left out ("parties",
   "lifeguards", "event lighting", "Party supply store", "Coaching gym", "field coaching", and enrichment's whole
   answer).
4. **The words rules** (`words.mjs`): lower case; accents, possessives, numbers and a short list of function words
   dropped; plurals folded; a word meets a catalog word when the same, when one starts the other (4 letters or more)
   or when both start with the same 5 letters, weighed by the share of the longer word.
5. **Ranking and outcome** (`matchers.mjs`): BM25 (k1 1.2, b 0.75), a kind's name words counted 3 times; `none` under
   1.5, `which` when the second is at least 0.8 of the first, else `listed`; at most two kinds, as K-09 allows. All
   fixed before the first run; none tuned on these samples.
6. **`none`** stands for K-09's `new_work` or `not_booked`: plain text cannot tell them apart.
7. **B reads `pf.services` and `pf.questions`** (A4-03 and B4-04: "its services and prices", "its questions"), never
   `pf.edges` (work that "belongs elsewhere": other kinds' words).
8. **C's cost** assumes about 4 characters a token, about 400 tokens of instructions, 30 of words and 40 of answer, at
   `ai/src/gateway/prices.ts`'s Haiku 5.5 prices; its times are T-362's staging spans.

## Open questions (for QUESTIONS.md)

1. (The architect and the CTO, before M5's search trade filter.) Which method matches a customer's request to a kind
   (arch 05 line 237: "a customer's request is matched the same way")? This spike shows plain text cannot. C, a model
   read (no stored index; inside decide's stage: a K-02 and K-09 change), or D, an embedding index (a new provider and
   spend, Jay's OK, and a K-24 v1.1 with a migration)? Default meanwhile: no customer-side kind match; A serves S1-02.
2. (The CTO; the user for the live run.) Measure C on these 47 samples and more before it is chosen: about 50 Haiku
   calls, about 2 cents at most at the estimate above, run as T-362's phase 2 ran its live calls.
3. (The architect.) K-09 `matchKinds` lists `not_booked` among its outcomes, but no code method tells not booked from
   new work (RULES 1.4). Should `not_booked` come only from decide's read and the owner's pick, with `matchKinds`
   answering `new_work` for a part with no kind (S1-02's safe default)?
4. (The architect.) K-09 `matchKinds` reads "the meaning-match index (Q-42)" and may answer `indexUnavailable`. With A
   there is no index: does the error then mean the catalog (the bundle's kinds rows) cannot be read, or does a later
   K-09 version reword it?
5. (The architect.) Q-42's second half, "searches steps when nothing fits" (`closestEntries`' meaning search over a
   business's step graph, arch 03 "Nothing fits"; its fixture names the index `meaning-index-q42-placeholder`), is not
   this card's and needs its own spike or card.

## Files

- `words.mjs`: the tokenizer, the plural fold, the meeting rule and the split of an owner's answer.
- `catalog.mjs`: the 243 kinds, read and checked as the kinds seed reads them.
- `matchers.mjs`: the candidates A0, A and B, BM25 and the outcome rule.
- `samples.mjs`: the 47 samples, each with its step and the kinds it fits.
- `compare.mjs`: the comparison and the cost (`node actions/spikes/q42-kind-matcher/compare.mjs`).
- `q42-kind-matcher.test.mjs`: 13 tests (`node --test actions/spikes/q42-kind-matcher/q42-kind-matcher.test.mjs`):
  the catalog against the seed's source and K-24's sample seed, a changed file refused, the words rules, the outcome
  rule, which columns each candidate reads, S1-02's three picks, the samples, and this file's tables against
  `compare.mjs`. No Vitest project includes this folder, so CI runs none of it. Two of them read this file: until the
  lead writes it (the harness refused the builder's write), they fail with "FINDINGS.md is missing".

## Time

Started 04:29 EST (09:29Z) Nov 16 2026; built, checked and committed by 05:13 EST (10:13Z): 44 minutes, inside the
card's 2 hours.
