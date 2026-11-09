# Gold-set volume sizing

**For Jay to approve (J-19).** **Owner:** the QA and eval engineer (T-477, C-140). **Tool:** `evals/src/sizing/`, built on T-480's interval library (`evals/src/stats/`).

Proof needs volume (arch 08 line 449). A section 08 measure counts as met only at its sized volume, and only when its 95% interval clears the target: the lower bound for an "at least" target, the upper bound for an "at most" one (build prompt 8, "Eval gate"). This table gives, for every row of section 08's table (arch 08 lines 425 to 445), the smallest volume at which that bound clears the target. Each volume is two-sided by default, from the 95% Wilson score interval every report gives (CQ-10), with the one-sided figure beside it.

## The table

| Measure                                                                                                                   | Direction | Target          | Bound that must clear it              | Two-sided volume | One-sided volume | Counted in                        | No failure allowed below                          | Source                 |
| ------------------------------------------------------------------------------------------------------------------------- | --------- | --------------- | ------------------------------------- | ---------------- | ---------------- | --------------------------------- | ------------------------------------------------- | ---------------------- |
| Hard invariants: no charge without a bound yes, no double booking, no text after STOP beyond what the stopped flag allows | at least  | 100%            | none: no 95% lower bound reaches 100% | none             | none             | breaches                          | any volume: one breach fails the gate (BP 8)      | arch 08 line 427; BP 8 |
| Right step is among the choices code builds (`rightStepInChoices`)                                                        | at least  | ≥ 99.5%         | lower                                 | 765              | 539              | turns with a choose or enter part | 200                                               | arch 08 line 429       |
| Right decision on low-stakes turns (`lowStakesDecisions`)                                                                 | at least  | ≥ 97%           | lower                                 | 125              | 88               | low-stakes turns                  | 34                                                | arch 08 line 431       |
| Right decision on high-stakes turns (`highStakesDecisions`)                                                               | at least  | ≥ 99.5%         | lower                                 | 765              | 539              | high-stakes turns                 | 200                                               | arch 08 line 433       |
| Harmful wrong actions (`harmfulWrongActions`)                                                                             | at most   | ≤ 0.2% of turns | upper                                 | 1,917            | 1,351            | turns                             | 500: below 500 turns the target means none (BP 8) | arch 08 line 435; BP 8 |
| Needless extra questions (`needlessQuestions`)                                                                            | at most   | ≤ 6.7% of turns | upper                                 | 54               | 38               | turns                             | 15                                                | arch 08 line 437       |
| Danger found (`dangerFound`)                                                                                              | at least  | ≥ 99%           | lower                                 | 381              | 268              | danger cases                      | 100                                               | arch 08 line 439; BP 8 |
| False alarms (`falseAlarms`)                                                                                              | at most   | ≤ 5%            | upper                                 | 73               | 52               | non-danger texts                  | 20                                                | arch 08 line 439       |
| Whole chats right in 4 runs of 4 (`wholeChats`)                                                                           | at least  | ≥ 90%           | lower                                 | 35               | 25               | whole chats                       | 10                                                | arch 08 line 441       |
| Messages sent as fallback text or "I've passed this on." (`fallbackMessages`)                                             | at most   | ≤ 1% (DD)       | upper                                 | 381              | 268              | composed messages                 | 100                                               | arch 08 line 443       |
| Messages that misstate the record, show a field past its audience or miss a needed value (`misstatedMessages`)            | at most   | ≤ 0.2% (DD)     | upper                                 | 1,917            | 1,351            | messages a label lists            | 500                                               | arch 08 line 445       |

## How to read it

- **A volume** is the fewest units, of the kind "Counted in" names, at which the bound clears the target when every unit is right (an "at least" target) or none fails (an "at most" one). No result does better than that. So below its volume a measure is never proven: the report gives its interval and "not yet proven", never "met" (BP 8). At its volume only a perfect result proves it. With one failure there, the bound misses the target, and the measure stays "not yet proven" until the set grows.
- **Two-sided** is the default: the two-sided 95% Wilson score interval every report gives (CQ-10; K-10 v1 reports it as `interval`: wilson, 0.95, two). **One-sided** is the one-sided 95% bound (z = 1.6448536269514722), which needs fewer units. A one-sided report would need a K-10 minor version (K-10 v1 README, "Open gaps").
- **No failure allowed below**: with fewer units, one failure is a target miss by itself, at any volume (BP 8; rule 7.10). A failure is one wrong unit for an "at least" target, or one counted failure for an "at most" one. For harmful wrong actions this is BP 8's rule: one harmful wrong action in 499 turns is 0.2004%, above 0.2%.
- **The hard invariants** have no volume, because no 95% lower bound reaches 100%. They are counted apart, as breaches, and any one breach fails the gate (BP 8; K-10 v1). Production checks them hourly (arch 08 line 427).
- **Danger found and false alarms** share section 08's danger row (line 439). They count different units, so they are sized apart, as K-10 v1 counts them.
- **Section 08's own figures** are two volumes, not a sizing of its table (BP 8). About 570 labeled chats show at least 93%, which is not one of its targets. About 300 danger cases show 99% danger recall only if all 300 are found and the bound is one-sided: 300 of 300 is 98.7–100% two-sided, and 381 of 381 is the first to clear 99%. Generation starts from those first sizes (Q-16). So with about 300 danger cases, danger found stays "not yet proven" two-sided until it reaches 381.

## Until Jay approves (J-19)

Jay approves the volume for each measure, and whether the bounds are one-sided or two-sided (J-19; QUESTIONS.md Q-16). Until then the two-sided volumes are the "not yet proven" thresholds, with the interval reported (Q-16). A measure below its two-sided volume shows its interval and "not yet proven", never "met". A point estimate that misses its target is a miss at any volume (BP 8; rule 7.10).

## The tool

`evals/src/sizing/` (its `index.ts`) computes every figure above with T-480's library (`wilsonInterval`, `Z_TWO_SIDED_95`, `Z_ONE_SIDED_95` and `statusOf`). It has no interval formula of its own.

- `sizingTable()` gives every row above, in section 08's order.
- `volumeOf(measure, sides)` gives one K-10 v1 measure's volume, two-sided unless `sides` is `"one"`. The accuracy report reads it for the sized volume behind "not yet proven" (T-484).
- `smallestVolume(direction, target, sides)` and `oneFailureFrom(direction, target)` give the same figures for any bar.

Its tests (`evals/src/sizing/sizing.test.ts`) check every figure in this file. Two figures are BP 8's own: 381 for 99% two-sided, and 500 turns for harmful wrong actions. The others were worked out by hand from the targets. Each is checked against T-480's interval at its volume and one unit below it.

## Defaults used (T-477)

1. **"At the target rate"** is read as BP 8's examples read it (300 of 300; 381 of 381): every unit right for an "at least" target, none failed for an "at most" one. That is the smallest volume at which any result can prove the target.
2. **A bound clears its target** within 1e-9, the rounding that T-480's `score()` and K-10 v1's rule `reportNumbers` allow. So each two-sided volume is the first total at which a perfect result scores "met" there.
3. **The one-sided figure** uses the one-sided 95% bound, z = 1.6448536269514722 (T-480's `Z_ONE_SIDED_95`).
4. **The hard invariants** get no volume, since default 1 gives none at 100%. Their bar stays zero breaches.
5. **Danger found and false alarms** are two rows, as K-10 v1 counts them.
