// Compose input's term facts (C-091, T-1174; K-09 README v1.6 defaults 137, 138 and 141; K-03 v1.1 termFact; CQ-82,
// CQ-86; DL-145, DL-355, DL-359): Rosie's own fixed terms that the row's step card states, given to the composer as
// facts so that a plan may state them in words (arch 07 line 403: only <facts> may be stated).
//
//   - Which lines (default 137, CQ-86's default, on every step): each line of the card of the message the row carries
//     (K-01 step.say[<i>].elements.card.lines), from the bundle the row was committed under, that names no slot, copied
//     word for word. A line that names a slot (it holds `{{`, as K-09 v1.6's rule termFactsFromCard reads it) is never a
//     term fact: its values reach the composer only as slot facts, through limit 7 (arch 12 line 592: the compiler
//     slots the sample cast's values, Rosie's own fee terms excepted). So no value of the sample cast becomes a term
//     fact. A line that is not words, or holds the bundle's opt-out line, is none either: that line reaches a text only
//     through the fixed-line inserter (DL-245).
//   - The source line (default 138; open gap 126): the bundle gives a card line and its place, never the master's line
//     or the rule that sets a term. So S1-02's four lines take their source words from a small fixed table (S1_02_SOURCES),
//     word for word as K-03 v1.1's input-s1-02-v1.1.json writes them (compose-input-s1-02-v1.6.json; the double's
//     recording 4 is keyed on them, DL-367), and every other line the generic form "<step>'s card, line <n> (K-01
//     flows.<flow>.steps.<step>.say[<i>].elements.card.lines[<j>])", built from where the line sits in the bundle. A
//     table entry stands only for the place and the words it was written for: a line the bundle words otherwise takes
//     the generic form, so a source never describes words it was not written for. A K-01 minor version that carries
//     each card line's source in the bundle replaces this table (open gap 126; QUESTIONS CQ-177).
//   - The order (default 141): the slot facts as T-309 gives them, then the term facts in the card's order, line 1
//     first (build.ts). One order, so one row always gives the same input.
// Never logged: a card's words.

import type { MasterLine } from "./master-line";
import type { FlowLetter, TermFact } from "./types";

/** A card line names a slot when it holds `{{` (K-03 slottedText; K-09 v1.6 tool-api.rules.mjs NAMES_A_SLOT). */
const SLOT_OPENS = "{{";

/** A card line's place in the bundle: the flow, the step, its message in `say` and the line in that message's card. */
export interface CardPlace {
  readonly flow: FlowLetter;
  readonly step: string;
  /** The message's place in the step's `say`, 0 for the first. */
  readonly say: number;
  /** The line's place on the card, 0 for line 1. */
  readonly line: number;
}

/** A source line written for one card line: its place, the words it was written for, and the source. */
export interface KnownSource extends CardPlace {
  readonly words: string;
  readonly source: string;
}

/**
 * S1-02's four card lines on bundle v0 (MASTER-FLOW-A.md line 28; K-01 flows.A.steps.S1-02.say[0].elements.card.lines)
 * with their source lines, word for word as K-03 v1.1's input-s1-02-v1.1.json writes them (open gap 126; DL-359). A
 * K-01 minor version that carries each card line's source in the bundle replaces this table.
 */
export const S1_02_SOURCES: readonly KnownSource[] = [
  {
    flow: "A",
    step: "S1-02",
    say: 0,
    line: 0,
    words: "About 15 minutes for your first kind of work",
    source:
      "S1-02's card, line 1: Rosie's setup time for the first kind of work (K-01 flows.A.steps.S1-02.say[0].elements.card.lines[0]; MASTER-FLOW-A.md line 28)",
  },
  {
    flow: "A",
    step: "S1-02",
    say: 0,
    line: 1,
    words: "About 5 minutes for each one after",
    source:
      "S1-02's card, line 2: Rosie's setup time for each later kind of work (K-01 flows.A.steps.S1-02.say[0].elements.card.lines[1]; MASTER-FLOW-A.md line 28)",
  },
  {
    flow: "A",
    step: "S1-02",
    say: 0,
    line: 2,
    words: "Free to use",
    source:
      "S1-02's card, line 3 (K-01 flows.A.steps.S1-02.say[0].elements.card.lines[2]; MASTER-FLOW-A.md line 28)",
  },
  {
    flow: "A",
    step: "S1-02",
    say: 0,
    line: 3,
    words: "$2 a booking, counted at its check-in or DONE, explained before you go live",
    source:
      "S1-02's card, line 4 (K-01 flows.A.steps.S1-02.say[0].elements.card.lines[3]; MASTER-FLOW-A.md line 28); RULES 3.15 (Rosie's own fee: $2 a booking, counted at the first check-in code or at DONE, paid by the business); arch 12 line 592 (Rosie's own fee terms are not slots)",
  },
];

/** The generic source of a card line, from its place in the bundle (open gap 126). */
export function genericSource(place: CardPlace): string {
  const { flow, step, say, line } = place;
  const path = `flows.${flow}.steps.${step}.say[${String(say)}].elements.card.lines[${String(line)}]`;
  return `${step}'s card, line ${String(line + 1)} (K-01 ${path})`;
}

/** A card line's source: the table's, when it was written for this place and these words; else the generic form. */
export function sourceOf(place: CardPlace, words: string): string {
  const known = S1_02_SOURCES.find(
    (entry) =>
      entry.flow === place.flow &&
      entry.step === place.step &&
      entry.say === place.say &&
      entry.line === place.line &&
      entry.words === words,
  );
  return known?.source ?? genericSource(place);
}

/** Whether a card line is one of Rosie's own fixed terms: words, naming no slot, never the opt-out line. */
function isTerm(words: string | null, optOutLines: readonly string[]): words is string {
  if (words === null || words.trim() === "" || words.includes(SLOT_OPENS)) return false;
  return !optOutLines.some((line) => line !== "" && words.includes(line));
}

/**
 * The term facts of the row's message card, in the card's order: each line that names no slot, word for word, with its
 * source line (see the top); none when the message has no card or its card states no term.
 */
export function termFactsOf(master: MasterLine): TermFact[] {
  return master.cardLines.flatMap((words, line): TermFact[] =>
    isTerm(words, master.optOutLines)
      ? [
          {
            value: words,
            source: sourceOf({ flow: master.flow, step: master.step, say: master.say, line }, words),
          },
        ]
      : [],
  );
}
