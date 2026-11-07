# bundle (K-01): the step-graph bundle format

**Status: v1, frozen** (`frozen.json`: `{"frozen": ["v1"]}`). Drafted by T-008; the shared lists, the lint marks, the fixtures and the freeze by T-010. The freeze takes effect when T-010 merges, and the merge waits for every review below (build prompt 6.2, 6.5).

## Freeze record

Frozen v1, 2026-11-07, reviews required: playbook engineer, runtime engineer, action-layer engineer, AI engineer, QA and eval engineer, release engineer, database engineer.

Each reviewer checks its own side (02-contracts section 1): the playbook engineer that the compiler can write every field (C-058 to C-073, C-255); the runtime engineer the bundle pin, the guard's keywords and the Clock lines (C-050, C-051, C-053, C-055); the action-layer engineer the frontier, hubs, doors, any-time rows, cards, effects and fixed lines (C-075 to C-089, C-092, C-093); the AI engineer the cards, prompts, models and routing by stakes (C-114, C-118, C-119, C-121, C-122); QA and eval the sample bundles and the out-of-scope markers (C-139, C-142, C-147, C-149); the release engineer the KV keys and the publish-then-switch order (C-020); the database engineer the bundle registry and the PostgreSQL copy (C-151). The lead records the freeze in `ops/DECISIONS.md` and on the board (build prompt 5.7).

**Owner:** the architect. **Schema:** `bundle.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/bundle/bundle.v1.schema.json`). **Checked by:** `npm run contracts:check`. **Contract test:** `tests/contract/bundle.v1.test.ts` (QA, T-080). A change after the freeze is a new minor version file, `bundle.v1.1.schema.json`, with new fixtures (build prompt 6.4); the frozen-contract guard fails any edit to v1's schema, its fixtures or their index entries.

## What it defines

A bundle is "the step graph, prompts, model ids and policy one turn ran on, stored under one id" (arch 01 line 87). Under Q-34's default it is one manifest, one master graph per flow and one compiled overlay per trade, each its own KV value under the bundle id (arch 10 line 536).

| Part                                                                                                                                                                                                                   | Where in the schema                                                            | Source                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| The whole bundle as one document (compiler output before it splits it; the shape of sample bundles)                                                                                                                    | the root                                                                       | 02-contracts K-01                                                              |
| Manifest: bundle id, build time, compiler version, every input's hash (fixture set v1's `MANIFEST.sha256` among them), prompts, model ids, routing by stakes, lint summary, which journeys may ship, the stored values | `$defs/manifest` (a KV value)                                                  | arch 01 line 87; arch 12 line 592; Q-17, Q-26, Q-36; CQ-09                     |
| Master graph per flow: sections, every step with its card, branches with tag, gates, end, answer fields and effects, fallback text, messages with plain-text forms, stop markers, layer lines, page types              | `$defs/flowGraph` (a KV value), `step`, `branch`, `card`, `message`            | SPEC-master 4, 5, 5b to 5k; arch 03 lines 159 to 191; arch 02 line 123         |
| Routing tables: hubs, doors, the 21 any-time rows with their handlers, the always-on rules as the cached prefix, the homes, the 67 judgment rules                                                                      | `$defs/routingTables`, `anytimeTable`, `judgmentRules`, inside each flow graph | arch 03 lines 163 to 181; Q-40; MC R6                                          |
| The 67 numbered judgment rules, a field of the bundle: number, text word for word, the step it comes from; a step's pointers to them by number                                                                         | `$defs/judgmentRules` (`routing.judgmentRules`), step `judgmentRules`          | MC R6; DECISIONS.md D2                                                         |
| The lint: each step's failing rules, and the manifest's summary and journey gate                                                                                                                                       | step `lint`, `$defs/lintReport`, `journeyGate`                                 | arch 12 line 592; Q-14, Q-17, Q-39                                             |
| Journey membership: each journey's steps, so the gold set is made journey by journey and the compiler fills each journey's failing steps                                                                               | `journeyGate.steps` (manifest `journeys`)                                      | 02-contracts K-09 (v1 Defines; its journey table); BP starting shape; BP 3.6   |
| Shared lists: the guard's keywords, the fixed lines, the plug-in key map, the out-of-scope markers                                                                                                                     | `$defs/sharedLists` (manifest `lists`)                                         | arch 02 line 115; arch 07 line 361; arch 12 line 592; 01-inventory.md group 11 |
| The record: money ways, the 16 named slots, services, the 11 fixtures, the record's lint tables, one fee, live switches and facts, cut values, merged names, ledger rules                                              | `$defs/record`, inside each flow graph                                         | the flow files' `record`                                                       |
| One compiled overlay per trade: facts, switches and settings typed, the 11 pf blocks whole, money per flow, the ops in order (C8's void offs dropped), renames, own slot rows                                          | `$defs/tradeOverlay` (a KV value)                                              | SPEC-prof 3 and 8; MC R3, C5, C8; overlay-core.js `apply()` lines 1794 to 1866 |
| Path model: price, before, after, booking values, switches, facts, services, fixture                                                                                                                                   | `$defs/path`                                                                   | overlay-core.js lines 6 to 12; lib.js `parsePath` line 338                     |
| Storage: the KV keys per bundle id and each value's size and hash; the PostgreSQL copy read on a KV miss                                                                                                               | `$defs/kvKey`, `$defs/storedValue`, manifest `storage`                         | arch 10 line 536; 02-contracts K-01                                            |

Every field's `description` names its source (02-contracts section 2 item 4). Fields copied from the master keep the master's names (`when`, `vary`, `took`, `ledger_rules`, ...), so parity runs against the same lib.js and overlay-core.js functions (Q-35). Authoring fields are left out (MC R2), and so are the sample cast, names and story, which are illustrations (MC C6).

Line numbers "arch NN line N" are those of `scratch/text/architecture.txt`, the text form of the architecture page (revision 5.1) that `ops/plan/02-contracts.md` cites. The HTML file's own line numbers differ (its line 87 is CSS).

## Storage

```text
bundle/<hash>/<build>/manifest        the manifest
bundle/<hash>/<build>/flow/A          flow A's graph, with its routing tables and record
bundle/<hash>/<build>/flow/B          flow B's graph
bundle/<hash>/<build>/trade/<id>      one per trade (243)
```

- The actor reads the active bundle id from PostgreSQL (K-04's bundle registry), then the manifest, the flow graph and the trade overlay from KV, or from PostgreSQL's copy on a miss (arch 10 line 536). A turn reads 3 values.
- Keys are written once per bundle id and never overwritten, so KV's propagation time (about 60 s, arch 10 line 518) and its limit of one write per second to one key never matter: the deploy publishes the bundle, then switches the active id (BP 5.4).
- The values carry no bundle id; the key does. The bundle id's hash is the sha256, in lowercase hex, of the UTF-8 text made of one line `<sha256 of the value>  <key after bundle/<hash>/<build>/>` per stored value, sorted by that key part, each ending in a newline. Equal content gives an equal hash; the build number counts publishes from 1.

## KV value size (Q-34's spike)

**Cloudflare's limit:** a value is at most **25 MiB** (26,214,400 bytes) on the Free and the Paid plan; a key at most 512 bytes; metadata at most 1,024 bytes. Source: Cloudflare, "Workers KV · Limits", <https://developers.cloudflare.com/kv/platform/limits/>, read 2026-11-07 (page marked last updated Oct 30, 2026). The schema holds every stored value to that limit (`storedValue.bytes`, `maximum` 26214400) and every key to 512 bytes (`kvKey`).

**Measured** on 2026-11-07 from the fresh master copy `scratch/fixture-v1-copy` (the same files as `scratch/master-copy`; read only). "File" is the file's bytes (`wc -c`); "minified" is `JSON.stringify(JSON.parse(file))` in UTF-8, the form a value is stored in.

| Input                                                       |        File |                  Minified | Share of 25 MiB |
| ----------------------------------------------------------- | ----------: | ------------------------: | --------------: |
| `engine/work/master/master-A.json`                          | 1,296,732 B |     860,956 B (0.821 MiB) |            3.3% |
| `engine/work/master/master-B.json`, the largest flow        | 1,363,869 B |     891,835 B (0.851 MiB) |            3.4% |
| `engine/work/prof/property-manager.json`, the largest trade |   731,818 B |     540,952 B (0.516 MiB) |            2.1% |
| `engine/work/prof/dance.json`, the next largest             |   689,987 B |     534,038 B (0.509 MiB) |            2.0% |
| all 243 trade files together                                |             | 26,164,132 B (24.952 MiB) |           99.8% |
| both flows and all 243 trades as one value                  |             | 27,916,923 B (26.624 MiB) |          106.5% |

**Q-34's layout fits.** The largest flow graph's input uses 3.4% of a value and the largest trade's 2.1%, so a compiled graph can grow about 29 times, and a compiled overlay about 48 times, before it reaches the limit. The other layout, one value holding every trade, does not fit: the 243 trade files alone come to 99.8% of a value before anything is compiled in, and with both flows 106.5%.

What this does not measure: the compiled values themselves, since no compiler exists yet. A compiled graph adds cards, plain-text forms, branch edges and fallback text, and drops `src` and `prop` (without them, master-B.json is 878,093 B minified). The compiler's publish step (C-072) records each value's size in the manifest, and the schema refuses one over the limit.

Also from the same page: the Free plan allows 1,000 writes a day to different keys. One publish writes 246 keys (the manifest, 2 flows, 243 trades), so the Free plan allows 4 full publishes a day; the Paid plan has no daily limit. Each Worker invocation may make at most 1,000 KV operations; a turn makes 3.

## Producers and consumers (02-contracts K-01)

- **Producers:** playbook engineer: C-058 step-graph compiler, C-059 overlay applier, C-060 Master Corrections layer, C-061 record engine, C-062 sample-value slotting, C-063 plug-in key map, C-064 element text forms and opt-out words, C-065 to C-070 lint rules, C-071 overlays for failing steps, C-072 bundle ids and publishing, C-073 parity harness, C-255 judgment-rule numbers.
- **Consumers:** runtime engineer: C-050, C-051, C-053, C-055; action-layer engineer: C-075 to C-089, C-092, C-093; AI engineer: C-114, C-118, C-119, C-121, C-122; QA: C-139, C-142, C-147, C-149; release engineer: C-020; database engineer: C-151 (the bundle registry and the copy).
- **Contract test** (QA, its own task, T-080): `tests/contract/bundle.v1.test.ts`, as 02-contracts K-01 describes. What the schema cannot check and the test must: each judgment rule 1 to 67 once, and every step's `judgmentRules` number resolving to one; each any-time row once; each fixed-line id once; every group 11 id, C-222 to C-254, with a marker in a full bundle; every input listed (2 flows, 243 trades, Master Corrections, LINES.md, fixture set v1's manifest); the bundle id's hash recomputed from `storage.values`; a lookup's field sourced on every path, and a loop across steps (the compiler's own lint); every step in a journey's `steps` a step of a flow, and every `failingSteps` id one of its journey's steps.

## The lint in the bundle (T-010)

A failing step stays in the bundle and says so: its `lint` lists the rules it fails, the manifest's `lint` counts them, and a journey with a failing step does not ship (arch 12 line 592; Q-17). The schema refuses a step whose own fields show a failure its `lint` does not list, so the frontier never takes an unmarked failing step for a good one:

| Rule                         | What the schema sees on the step                                                                           | Source                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `guard-keyword-button`       | a button in `say` (or a variant's `say` or `addSay`) whose whole label, trimmed, in any case, is a keyword | arch 12 line 592; Q-14; msgtext.js 95   |
| `unknown-slot`               | a message text naming `{{x}}` with x outside the slot list below                                           | 02-contracts K-01; overlay-core.js 1508 |
| `no-safe-default-or-clock`   | a `card` with neither `safeDefault` nor `clock`                                                            | arch 12 line 592                        |
| `choice-without-definition`  | a `card.means` entry with `from: "none"` (no Means line and no first sentence)                             | arch 12 line 592                        |
| `lookup-without-field`       | a branch tagged `lookup` without `reads`                                                                   | arch 12 line 592; Q-39                  |
| `loop`                       | a `walk` (the loop rule's path through relative `t` and flow-switch ends) that repeats a step              | Q-39; SPEC-master 5g; arch 03 line 191  |
| `judgment-rule-out-of-range` | a `more` line saying "judgment rule N" with N outside 1 to 67                                              | MC R6                                   |

A step's `judgmentRules` number outside 1 to 67 is refused outright, whatever its `lint` says (MC R6). What needs the whole graph (a lookup's field with no source on some path, a cycle across steps, the record's own lint tables) is the compiler's to find and mark (C-065 to C-070). Words in a trade's `words` ops are linted by the compiler and reported with the trade's id in `lintFailure.trade`; the schema does not read them.

**The slot list** a message may name: overlay-core.js `SLOTS` (line 1285: `alex.staff`, `name.staff`, `svc.intext`, `arrive`, `window`, `cutoff`, `day`, `keep`, `price`, `fee`, `deposit`, `rest`, `hold`, `paid`), the ledger amounts (`LEDGER_AMOUNTS` line 597 and `AMOUNT_RE` line 983: `paidnow`, `due`, `back`, `later`, `backlate`, `name`) and the record's 16 named slots (`pay.asks` ... `who.ok`). These are all the master and the 243 trade files use today.

## A branch with no end merges (`/$defs/branch/properties/end`)

A branch's `end` is left out where the master leaves it out, and the walker reads a branch with no `end` as `merge`: it rejoins the path after its split (lib.js line 649, `b.end || "merge"`, and the path walks at lines 835 and 873, `(b.end || "merge") !== "end"`). Every consumer that walks the graph (the frontier, the gold-set generator, parity) reads it the same way. In the master, 63 branches of master-A.json and 64 of master-B.json have no `end` (47 of each with steps of their own), all on section 11 and 12 splits, such as the S11-12 hub's (counted 2026-11-07 in `scratch/fixture-v1-copy`, branches nested in branches included).

## Journey membership (`journeyGate.steps`)

Each journey in the manifest's `journeys` lists its steps, so the gold-set generator (C-139) can tell which journey a walked step belongs to and which journey to label next (K-10 puts a journey on every gold item; BP's starting shape makes the gold set journey by journey, once that journey's steps pass the lint), and the compiler fills each journey's `failingSteps` from the same list. Journey N holds section N's steps of both flows and the steps of other sections that ride with it; a step may be in more than one journey.

| Journey | Its steps                                                                                                      | Source                                                                                                                           |
| ------: | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
|       1 | section 1: S1-01 to S1-84                                                                                      | 02-contracts K-09 v1 Defines, "Journey 1" (headed S1-01 to S1-79; its list also names S1-80 to S1-84); BP starting shape, M4 row |
|       2 | section 2: S2-02 to S2-31                                                                                      | 02-contracts K-09 v1 Defines, "Journey 2" (headed S2-02 to S2-24; its list also names S2-27 to S2-31); BP starting shape, M4 row |
|       3 | section 3 (A3-, B3-); S11-62                                                                                   | K-09 table "Tool API minor versions, one per journey", v1.1; BP starting shape, M5 row ("S11-62 with journey 3")                 |
|       4 | section 4; S12-01 to S12-05, S12-28                                                                            | K-09 table, v1.2                                                                                                                 |
|       5 | section 5; S12-16 to S12-18, S12-26                                                                            | K-09 table, v1.3                                                                                                                 |
|       6 | section 6; S12-33                                                                                              | K-09 table, v1.4                                                                                                                 |
|       7 | section 7; S11-22                                                                                              | K-09 table, v1.5; BP starting shape, M6 row ("S11-22 with journey 7")                                                            |
| 8 to 10 | sections 8, 9 and 10                                                                                           | K-09 table, v1.6 to v1.8                                                                                                         |
|      11 | section 11: S11-02 to S11-106, S11-22 and S11-62 included                                                      | K-09 table, v1.9                                                                                                                 |
|      12 | the section 12 steps not already shipped: S12-06 to S12-08, S12-19, S12-23 to S12-25, S12-27, S12-29 to S12-32 | K-09 table, v1.10 ("the section 12 steps not already shipped")                                                                   |

- A section 12 step rides with the first journey that uses it (BP 3.6), as the K-09 table places it; it is listed there and in no later journey. S12-09 to S12-14, K-09 v1's shared core (M3b), are in no journey yet (open gaps below).
- Out-of-scope steps (group 11, such as S1-26, S11-37 to S11-40, S12-19) stay in their journey's list, where K-09 marks them "out" (no Tool API call is built for them); their `lists.outOfScope` markers keep them unreachable, and a journey's "every in-scope step is reachable" check counts them as out (01-inventory.md N-5).
- Section 13's rule nodes and homes are in no journey: every journey calls them (BP 3.5).
- What the schema checks: each journey's list has at least one step, each once. What the contract test checks in a full bundle: every listed step is a step of a flow, and every `failingSteps` id is one of its journey's steps.

## Fixtures (`fixtures/`, listed in `fixtures/index.json`)

Accepted: `bundle-v0-skeleton.json` (D-007's S1-01 and S1-02), `bundle-mini-a.json`, `bundle-mini-b.json` (whole bundles, the schema's root), `manifest.json`, `trade-overlay.json`, `anytime-table.json`, `fixed-lines.json`, `keywords.json`, `key-map.json`, `lint-report.json`, `out-of-scope-c9-first-texts.json` and `judgment-rules.json` (each against its `$defs` entry). Refused, each a compiled step (`$defs/step`): `refuse-loop`, `refuse-no-safe-default-or-clock`, `refuse-choice-without-definition`, `refuse-guard-keyword-button` (S1-37 as the master writes it), `refuse-lookup-without-field`, `refuse-unknown-slot` and `refuse-judgment-rule-out-of-range` (rule 68), in `fixtures/invalid/`. Each refused step is accepted once its lint names the rule (rule 68 aside), so each is refused for the one reason it shows. Also refused, a journey gate (`$defs/journeyGate`): `refuse-journey-ships-with-failing-step`, journey 1 marked to ship while it lists the failing step S1-37; it is accepted with `ships: false`.

Their words and values are the master's own, copied from `scratch/fixture-v1-copy` (master-A.json, master-B.json, `engine/work/prof/barber.json`, whose trade is also one of fixture set v1's demo shops): the sample cast and businesses (Sam, Alex, Riley, Lee's Barbershop), never a real person (rule 9). The sample bundles are partial (`manifest.partial`): they hold a few steps each, while their routing tables, sections and branches name the master's step ids, and a step a bundle does not hold is not reachable. Their hashes and sizes are computed from the values as stored; the input hashes are the files' own. The prompts are placeholders until the AI engineer writes them (C-119), and the barber overlay carries the first two ops of each kind in each flow, not all of them. The journey gates of `manifest.json` and `bundle-mini-a.json` list journey 1's steps, the 45 section 1 steps of master-A.json and master-B.json (the same ids in both); `bundle-v0-skeleton.json` and `bundle-mini-b.json` list no journey.

## Defaults used in this draft (T-008)

1. **The bundle id's hash and the key spelling** (above). CQ-09 leaves the hash's algorithm and spelling to this contract (`common/formats.v1.schema.json`, `bundleId`).
2. **Messages are objects** `{ from, to, text, elements, plainText }`, not the master's `[from, to, text, elements]` tuples: a tuple needs `prefixItems`, whose generated type is wider than the schema (ADR-005).
3. **Each pf block is stored as the trade's value written as JSON text, unchanged** (MC R3: "stored whole as a text block"; Q-39).
4. **The routing tables, the record and the judgment rules ride inside each flow graph**, so a turn needs one value per flow; the shared S steps' rows are the same in both.
5. **A compiled overlay keeps the trade's ops in order**, with added steps compiled and fields overlay-core ignores left out, rather than pre-applied words per step, so parity runs against `apply()` as written (Q-35).
6. **A branch's answer fields are typed** text, integer, boolean, money, time, zone, id or choice (the shared formats, CQ-09). **Journeys are numbered 1 to 12** (02-contracts sections 9 and 10).
7. **An any-time row's handler may be null**: no clear step, so it goes to Jay (Q-40).

## Defaults added at the freeze (T-010)

8. **The shared lists ride in the manifest** (`lists`), which a turn reads first, so the guard, the lint and the message checks read one list and a turn still reads 3 values.
9. **A failing step is marked, not dropped** (`lint`, above): arch 12 line 592 keeps failing steps out of shipping journeys, not out of the bundle.
10. **A lookup branch names the field it reads** (`reads`: a needs key, a record value or a path value), and **the loop rule's walk is kept on the step** (`walk`), so the schema can see those two rules (Q-39's definitions).
11. **A card's clock is optional and a definition may be missing** (`from: "none"`), so a failing card can be written down and marked; a compiled card normally carries step 9's default (arch 12 line 592).
12. **The judgment rules are an object** `{ rules: [67] }` and **the any-time table** `{ rows: [21] }`, each its own definition, so their fixtures check alone.
13. **The fixed lines** are the sources' words exactly; the stop, START and HELP replies have none yet (`status: "pendingJay"`, `text: null`): Q-01 sends their drafted words to Jay. The PostgreSQL outage line (arch 11 line 566) is the AI outage line of line 564, the only one the page quotes.
14. **The key map** lists the trade file's top keys: four typed (pf.facts, pf.switches, pf.settings, money), the 11 free-text pf keys as text blocks, the ops, and the authoring and story keys left out (MC R2, R3, C6; Q-39).
15. **The any-time handlers in the samples** are the steps BP's M3b row names, the danger check standing for the first and third rows; every other row is null (Q-40).
16. **A partial bundle says so** (`manifest.partial`); a full bundle leaves it out.
17. **A journey that ships lists no failing step**: the schema refuses `ships: true` with one (arch 12 line 592).
18. **Journey N's steps are section N's, whole** (T-010 rework, "Journey membership" above): the K-09 headings and ranges end below some of the master's own ids in those sections (K-09 v1's Journey 1 is headed S1-01 to S1-79 and Journey 2 S2-02 to S2-24, while their lists name S1-80 to S1-84 and S2-27 to S2-31; the table's v1.2 range ends at B4-115, v1.5's at B7-88, v1.6's at B8-93 and v1.8's at B10-36, while master-B.json has B4-117, B7-89, B7-90, B7-91, B7-93, B7-94, B8-96, B8-97, B10-37 and B10-38). Each of those ids lies in its journey's section, so the bundle lists the whole section.

## Keywords beyond ADR-005's list

`allOf` (once, to narrow the shared `bundleId`), `propertyNames` and `minProperties` (T-008); `if`/`then`/`else`, `dependentSchemas`, `contains`, `not` and `uniqueItems` (T-010, for the lint marks and the conditional fields). The generated types are wider than the schema there: a map's keys are typed `string`, and the lint and conditional checks are not in the types. The step's lint checks sit in `dependentSchemas` rather than `allOf`, because json-schema-to-typescript turns an object with `allOf` into an untyped one.

## Open gaps

Q-34 (layout: the spike above), Q-35 (parity), Q-39 (the plug-in key map; the lookup and loop rules), Q-40 (any-time handlers), Q-14 (S1-37's "Start"), Q-30 (where the opt-out line goes), Q-01 (stop replies, and the START and HELP replies' words), Q-17 and J-18 (the overlay batch), Q-26 (model routing), Q-05 (call lines), CQ-09 (formats).

- **CQ-16** (raised by T-008): no source lists the page types a step may open (arch 01 line 97: "one page type or none"), so `pageTypes` holds free strings until K-03 (the message plan's page type) or K-21 (the page calls) names the closed list. v1 keeps them free strings, so that list is then a code check against K-03 or K-21: narrowing v1's field would be a breaking change (build prompt 6.4).
- **New at the freeze:** arch 12 line 592 has the compiler turn sample cast names, dates, times, prices and places in message lines into slots, but no source names those slots yet; K-03 (T-012) names the composer's slots. Until a minor version adds them to the slot list, the bundle's slot list is the master's own (above), and a message naming another slot fails `unknown-slot`.
- **New at the freeze:** the safety lines in languages other than English (arch 06: "in their language") have no words in the sources; `fixedLines` carries the English ones, and each other language is added as its own line with its `lang` once written.
- **New at the rework (journeys):** S12-09 to S12-14 (texting or Rosie down, calendar links) are shared core in K-09 v1 (BP starting shape, M3b row), and BP 3.6 ships them "with the first journey that uses them", but no source names that journey and no step of sections 1 to 11 leads to them in the master; the K-09 table's journey 12 leaves them out as already shipped. Until the lead names their journey, they are in no journey's `steps`; adding them to one later is a compiler output change, not a schema change.
- **New at the rework (journeys):** the K-09 headings and table ranges that end below the master's own ids (default 18) are for the lead to correct in `ops/plan/02-contracts.md`; the bundle lists whole sections meanwhile.
- **New at the rework (overlays per journey):** an input of kind `approvedOverlay` (`$defs/inputFile`) names no journey and no step, so J-18's rule that a journey's gold set is "labeled only from its approved overlays" (BP starting shape, last paragraph) cannot be checked per journey from the manifest. Not filled by a guess: Q-17 and J-18 settle the overlay batch and what an approved overlay records.
- **New at the rework (stakes):** a choice's stakes, high or low (arch 01 line 79: "High when the target question, or the first read's pick, can charge, refund, book, move or cancel"), is not a bundle field: the manifest's `policy` routes by stakes, but K-02 (T-011) carries each choice's stakes and settles how it is derived.

## Change log

- v1 draft, 2026-11-07 (T-008): first draft.
- v1, 2026-11-07 (T-010), before the freeze: the shared lists (`sharedLists` in the manifest: keywords, fixed lines, key map, out-of-scope markers); each step's `lint`, `judgmentRules` and `walk`, with the schema's lint checks; a lookup branch's `reads`; a card's optional clock and `from: "none"`; `judgmentRules`, `anytimeTable` and `lintReport` as their own definitions; `manifest.partial`; a shipping journey with no failing step; the fixtures and their index; the freeze record and `frozen.json`.
- v1, 2026-11-07 (T-010 rework after review), before the freeze: each journey's `steps` (journey membership, required) with its sources; the walker's rule for a branch with no `end`; the refused fixture `refuse-journey-ships-with-failing-step`; journey 1's steps in `manifest.json` and `bundle-mini-a.json`; open gaps for S12-09 to S12-14, the K-09 ranges, `approvedOverlay` per journey and stakes.
