# evals/gold: the gold set

**Owner:** the QA and eval engineer (build prompt section 4). **Format:** K-10 v1, the eval-set contract's `goldItem` (`contracts/eval-set/`). **Store:** `evals/src/gold/store/` (T-470, C-139).

The gold set's items, kept by the gold-set item store. Items come only from walking the step graph and from fixture set v1, labelled only from approved overlays (BP starting shape, last paragraph; J-18), so every item has a known right step (arch 08 line 449). Generating them is T-471 to T-476, and each journey's gold set is T-492 to T-496. No real customer data ever enters this folder (BP rule 9): the store refuses a human-labelled live turn.

## Layout

One folder per set version, then by journey and flow:

```text
evals/gold/
  README.md                                   this file
  <set version>/
    manifest.json                             every item file with its sha256, and the counts (below)
    journey-<NN>/flow-<A|B>/<item id>.json    one K-10 v1 gold item
```

- The **set version** is the item's own `setVersion`, "the gold-set version that added it" (K-10 v1). So a set version's folder holds the items that version added. How a run combines set versions is the eval runs' (C-141), not the store's.
- The **journey** is the item's `journey` (K-01 v1's 1 to 12), written with two digits so the folders sort in order; the **flow** is its `path.flow`; the file is named by its `itemId`.
- Each file is the item's JSON as Prettier formats it with this repository's settings, keys in the item's own order, so `npm run format:check` passes on every file the store writes and the same item always gives the same bytes.

## Rules the store keeps

- **Checked against K-10 v1.** Every item is checked against `eval-set.v1.schema.json#/$defs/goldItem` with the one validator (Ajv 8, its 2020-12 class, strict mode: contracts README convention 8, T-003's setup). A refused item is named with every fault, one line each in the lines `contracts:check` prints, and a fault in a gold field also names the field: `/turns/0/label/parts/0/fields/0 must have required property 'value' (field "kinds")` (`refuse-item-without-field-values.json`).
- **Walked items only.** A human-labelled live turn (`labelledBy` human, a `liveTurn` seed) holds a real person's words, so it never enters the repository, a fixture or a test (BP rule 9; K-10 README "The seed state"). The store refuses it, though K-10 v1 accepts its shape.
- **Written once, never rewritten** (K-10 README "The gold-set item"; QUESTIONS.md M2-qa-frontend.2). An id the set already holds with other content is refused; the same item again is left as it is. An item whose `setVersion` is not the set written is refused.
- **All or nothing.** One refused item and nothing of that write is written.
- **The set on disk is checked first**, on every read and before every write: each file is an item K-10 v1 and the store accept, in the folder its set version, journey, flow and id name, its id once in the set; the manifest lists every file with its sha256 and no other. A read also checks the manifest's counts. Names starting with a dot (`.DS_Store`) are passed over.
- **One writer at a time.** The store takes no lock.

## The manifest

`manifest.json` is a function of the set's files alone (no clock, no outside path), so the same items give the same manifest byte for byte, in whatever order and however many writes they were written in. Its sha256, the sha256 of its bytes (`shasum -a 256`), names the set's exact content.

| Field                              | What it holds                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contract`                         | `eval-set.v1#goldItem`: what the items are checked against                                                               |
| `setVersion`                       | the set version, the folder's name                                                                                       |
| `items`, `turns`, `texts`, `flows` | how many items, turns and texts the set holds, and items per flow (`{ "A": n, "B": n }`)                                 |
| `measures`                         | each section 08 measure's units in the set, in K-10 v1's order (below)                                                   |
| `byJourney`                        | the same, one entry per journey the set holds, in journey order, each with its `journey` number                          |
| `files`                            | every item file in path order: `path`, `itemId`, `journey`, `flow`, `kind` and the `sha256` of its bytes (lowercase hex) |

Each measure counts the units K-10 v1's README "How each measure is counted" gives as its total, so the volume each bar has is in view (arch 08 line 449: "Proof needs volume"; BP 8 and J-19):

| Measure               | Units the set holds                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `rightStepInChoices`  | turns with a choose or enter part                                                                              |
| `lowStakesDecisions`  | turns whose label has stakes low                                                                               |
| `highStakesDecisions` | turns whose label has stakes high                                                                              |
| `harmfulWrongActions` | every turn (a whole chat's turns each count)                                                                   |
| `needlessQuestions`   | every turn                                                                                                     |
| `dangerFound`         | danger cases: texts with a safety label other than No whose tense is now, could restart or unknown             |
| `falseAlarms`         | every other text                                                                                               |
| `wholeChats`          | whole-chat items                                                                                               |
| `fallbackMessages`    | `null`: its total is the messages the composer plans (fixed lines are never composed), which only a run counts |
| `misstatedMessages`   | the messages the labels list: the most a run counts, since it counts those it sent                             |

K-10's own sample report of its eight sample items, `report-code-only-change.json` (every message a label lists was sent), has exactly these totals for every measure but `fallbackMessages`, overall and per journey; the store's tests check it.

## Using the store

The store is the module `evals/src/gold/store` (its `index.ts`):

```ts
const result = await writeGoldItems(items, { setVersion: "gs-1" }); // GoldItemRefused: nothing written
const journeyOne = readGoldItems({ setVersion: "gs-1", journey: 1, flow: "A" }); // GoldSetError: the set is not sound
const { manifest, sha256 } = readGoldManifest({ setVersion: "gs-1" });
```

- `writeGoldItems(items, { setVersion, root? })` checks every item, then writes the new ones and the manifest; it returns the files written, the items already held as they are, the manifest and its sha256. A write of no items to an existing set rebuilds its manifest from its checked files.
- `readGoldItems({ setVersion, root?, journey?, flow? })`, `readGoldItem({ setVersion, root?, itemId })`, `readGoldManifest({ setVersion, root? })` and `goldSetVersions(root?)` read.
- `root` is `evals/gold/` unless another is given; tests give a scratch folder, never this one.
- `checkGoldItem(value)` gives the problems of one item without a set; `countItems(items)` gives the counts.
- The store runs where the repository's own tools run (Node, with the root's dev dependencies Ajv and Prettier), never in a Worker. It does not import T-003's harness, which imports Vitest; its tests check its validator against the harness on every K-10 item fixture.

## Defaults used (T-470)

1. A set version's folder holds the items whose `setVersion` it is, the version that added them; a run over several versions reads each (C-141 decides).
2. `fallbackMessages` is `null` in the manifest: the items do not hold its units. `misstatedMessages` counts the messages the labels list.
3. A danger case is a text with any safety label other than No in tense now, could restart or unknown (K-10 README; default 10's "found" is the harness's).
4. Files are hashed by their bytes, as written through Prettier with this repository's settings.
