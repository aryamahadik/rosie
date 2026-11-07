# bundle (K-01): the step-graph bundle format

**Status: draft v1 (T-008), not frozen.** T-010 adds the shared lists, the sample bundles and refused fixtures, runs the consumer reviews and freezes it. Nothing may build against it until then (build prompt 3.3, 3.4).

**Owner:** the architect. **Schema:** `bundle.v1.schema.json` (JSON Schema 2020-12, `$id` `https://rosie.invalid/contracts/bundle/bundle.v1.schema.json`). **Checked by:** `npm run contracts:check`.

## What it defines

A bundle is "the step graph, prompts, model ids and policy one turn ran on, stored under one id" (arch 01 line 87). Under Q-34's default it is one manifest, one master graph per flow and one compiled overlay per trade, each its own KV value under the bundle id (arch 10 line 536).

| Part                                                                                                                                                                                                                   | Where in the schema                                                 | Source                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The whole bundle as one document (compiler output before it splits it; the shape of sample bundles)                                                                                                                    | the root                                                            | 02-contracts K-01                                                              |
| Manifest: bundle id, build time, compiler version, every input's hash (fixture set v1's `MANIFEST.sha256` among them), prompts, model ids, routing by stakes, lint summary, which journeys may ship, the stored values | `$defs/manifest` (a KV value)                                       | arch 01 line 87; arch 12 line 592; Q-17, Q-26, Q-36; CQ-09                     |
| Master graph per flow: sections, every step with its card, branches with tag, gates, end, answer fields and effects, fallback text, messages with plain-text forms, stop markers, layer lines, page types              | `$defs/flowGraph` (a KV value), `step`, `branch`, `card`, `message` | SPEC-master 4, 5, 5b to 5k; arch 03 lines 159 to 191; arch 02 line 123         |
| Routing tables: hubs, doors, the 21 any-time rows with their handlers, the always-on rules as the cached prefix, the homes, the 67 judgment rules                                                                      | `$defs/routingTables`, inside each flow graph                       | arch 03 lines 163 to 181; Q-40; MC R6                                          |
| The record: money ways, the 16 named slots, services, the 11 fixtures, the record's lint tables, one fee, live switches and facts, cut values, merged names, ledger rules                                              | `$defs/record`, inside each flow graph                              | the flow files' `record`                                                       |
| One compiled overlay per trade: facts, switches and settings typed, the 11 pf blocks whole, money per flow, the ops in order (C8's void offs dropped), renames, own slot rows                                          | `$defs/tradeOverlay` (a KV value)                                   | SPEC-prof 3 and 8; MC R3, C5, C8; overlay-core.js `apply()` lines 1794 to 1866 |
| Path model: price, before, after, booking values, switches, facts, services, fixture                                                                                                                                   | `$defs/path`                                                        | overlay-core.js lines 6 to 12; lib.js `parsePath` line 338                     |
| Storage: the KV keys per bundle id and each value's size and hash; the PostgreSQL copy read on a KV miss                                                                                                               | `$defs/kvKey`, `$defs/storedValue`, manifest `storage`              | arch 10 line 536; 02-contracts K-01                                            |

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
- **Contract test** (QA, its own task): `tests/contract/bundle.v1.test.ts`, as 02-contracts K-01 describes.

## Defaults used in this draft (T-008)

1. **The bundle id's hash and the key spelling** (above). CQ-09 leaves the hash's algorithm and spelling to this contract (`common/formats.v1.schema.json`, `bundleId`).
2. **Messages are objects** `{ from, to, text, elements, plainText }`, not the master's `[from, to, text, elements]` tuples: a tuple needs `prefixItems`, whose generated type is wider than the schema (ADR-005).
3. **Each pf block is stored as the trade's value written as JSON text, unchanged** (MC R3: "stored whole as a text block"; Q-39).
4. **The routing tables, the record and the judgment rules ride inside each flow graph**, so a turn needs one value per flow; the shared S steps' rows are the same in both.
5. **A compiled overlay keeps the trade's ops in order**, with added steps compiled and fields overlay-core ignores left out, rather than pre-applied words per step, so parity runs against `apply()` as written (Q-35).
6. **A branch's answer fields are typed** text, integer, boolean, money, time, zone, id or choice (the shared formats, CQ-09). **Journeys are numbered 1 to 12** (02-contracts sections 9 and 10).
7. **An any-time row's handler may be null**: no clear step, so it goes to Jay (Q-40).

## Keywords beyond ADR-005's list

`allOf` (once, to narrow the shared `bundleId`), `propertyNames` and `minProperties`. The generated types are wider than the schema there: a map's keys are typed `string`.

## Open gaps

Q-34 (layout: the spike above), Q-35 (parity), Q-39 (the plug-in key map; the lookup and loop rules), Q-40 (any-time handlers), Q-14 (S1-37's "Start"), Q-30 (where the opt-out line goes), Q-01 (stop replies), Q-17 and J-18 (the overlay batch), Q-26 (model routing), Q-05 (call lines), CQ-09 (formats). New in this draft: no source lists the page types a step allows (arch 01 line 97), so `pageTypes` holds free strings until K-03 or K-21 names them.

## Not here (T-010)

The shared lists (keywords, START, HELP and the 16 opt-out words, the fixed lines, the plug-in key map, the out-of-scope markers C-222 to C-254), `fixtures/` with `index.json`, the sample bundles and refused fixtures, the consumer reviews, the freeze record and `frozen.json`.

## Change log

- v1 draft, 2026-11-07 (T-008): first draft.
