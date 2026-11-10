// Sensitive work (T-375, C-118; S13-22: "For sensitive work, texts never name the service or the reason, and staff texts
// use initials ... Customer texts say 'your visit'"; RULES 4.6; arch 07 line 355: sensitive work says "your 2:00pm
// visit"; K-03 slots.json sensitiveForm). Under the sensitive switch limit 7 gives the composer each of these names as
// its sensitive form (C-091): initials for alex.staff and name.staff, and for the service, svc.intext and name, nothing
// or the words after "|" (emptyOrAlternate). So the model never reads the service or a full name, and a plan keeps it so
// when:
//
//   1. its own words hold no sample service or name: no example words of a service or name slot, in the master line or
//      in the plan's own slots (they are the sample cast's, never the booking's: S13-28 rule 51; MC C6). Typed outside
//      its slot, a service or a name reaches the reader whole, where the switch can hide only a slot. A service is held
//      as its whole example ("First session"); a name by each of its words of three letters or more ("Alex"; not the
//      initial "M.", and not a short word such as "al" or "de", which Spanish writes every day);
//   2. a service slot carries words after "|" only as the master line gives that slot: under the switch the slot filler
//      writes those words in place of the service (C-088 emptyOrAlternate), so words of the model's own there could name
//      it ("{{svc.intext|therapy}}").
//
// "Your visit": where the service would be named, the plan says "your visit" in its own words (the prompt's rules 6 and
// 11), and the check above holds it to naming nothing else.
//
// Which rows: K-03's input does not name the switch, only the tag, and gentle is grief, safety or sensitive work, the
// first tag that fits (arch 07 line 357), so a sensitive row is always gentle (C-090, T-309). The composer cannot tell
// the three apart, so it holds every gentle row to these rules, which no gentle message needs to break; and a row whose
// service limit 7 gave as nothing is sensitive work whatever its tag.

import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeProblem } from "../types";
import { addOnce, holdsRun, ownWords, planFields, slotsIn, termWords, wordsOf } from "./words";

/** The service's slots, whose sensitive form is nothing or the words after "|" (K-03 slots.json emptyOrAlternate). */
export const SERVICE_SLOTS: readonly string[] = Object.freeze(["svc.intext", "name"]);
/** The names a staff or owner text gives as initials under the switch (K-03 slots.json initials). */
export const PERSON_SLOTS: readonly string[] = Object.freeze(["alex.staff", "name.staff"]);

/** The fewest letters a word of a sample name has to be held as a name ("Alex"; "M." is an initial). */
const NAME_WORD = 3;

/** Whether limit 7 gave a service slot as nothing: the service's sensitive form (RULES 4.6; S13-22). */
export const serviceHidden = (input: ComposeInput): boolean =>
  input.facts.some((fact) => "slot" in fact && SERVICE_SLOTS.includes(fact.slot) && fact.value.trim() === "");

/**
 * A gentle row: tagged gentle (grief, safety or sensitive work: arch 07 line 357), or one whose service limit 7 gave as
 * nothing (the sensitive switch), whatever its tag. The sensitive-work and tone rules hold for it.
 */
export const gentleRow = (input: ComposeInput): boolean =>
  input.situation === "gentle" || serviceHidden(input);

/** The texts whose slots tell the plan's samples: the master line, then each of the plan's words fields. */
const slotTexts = (plan: MessagePlan, input: ComposeInput): string[] => [
  input.masterText.text,
  ...planFields(plan).map((field) => field.text),
];

/** The runs of words a typed service or name would be: each service sample whole, each name's longer words alone. */
function sampleRuns(plan: MessagePlan, input: ComposeInput): string[][] {
  const runs: string[][] = [];
  for (const text of slotTexts(plan, input))
    for (const slot of slotsIn(text)) {
      if (slot.example === null) continue;
      const said = wordsOf(slot.example);
      if (SERVICE_SLOTS.includes(slot.name) && said.length > 0) runs.push(said);
      if (PERSON_SLOTS.includes(slot.name))
        for (const word of said) if (word.length >= NAME_WORD) runs.push([word]);
    }
  return runs;
}

/** The words after "|" (its first part, as the slot filler reads it), trimmed and lowercased; "" when there are none. */
const otherWords = (other: string | null): string => (other?.split("|")[0] ?? "").trim().toLowerCase();

/**
 * Each words field of a gentle row's plan that types a sample service or name, or gives a service slot words after "|"
 * the master line does not give it: one problem per field. Empty for any other row. Names the check and the place,
 * never words.
 */
export function sensitiveProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  if (!gentleRow(input)) return [];
  const terms = termWords(input);
  const samples = sampleRuns(plan, input);
  const masterOthers = new Set(
    slotsIn(input.masterText.text)
      .filter((slot) => SERVICE_SLOTS.includes(slot.name))
      .map((slot) => otherWords(slot.other))
      .filter((words) => words !== ""),
  );
  const problems: ComposeProblem[] = [];
  for (const field of planFields(plan)) {
    const own = wordsOf(ownWords(field.text, terms));
    if (samples.some((run) => holdsRun(own, run)))
      addOnce(problems, { check: "sensitiveWork", at: field.at });
    for (const slot of slotsIn(field.text)) {
      const other = otherWords(slot.other);
      if (SERVICE_SLOTS.includes(slot.name) && other !== "" && !masterOthers.has(other))
        addOnce(problems, { check: "sensitiveWork", at: field.at });
    }
  }
  return problems;
}
