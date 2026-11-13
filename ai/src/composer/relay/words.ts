// How T-375's checks read a plan (C-118): the slots each words field writes, the model's own words in it, and those
// words as a list. Shared by the relay, sensitive-work, tone and language checks (./quote.ts, ./sensitive.ts, ./tone.ts,
// ./language.ts).
//
// The model's own words are a field's words with every slot taken out (code fills each slot, its example words
// included: MC C6) and each of Rosie's own fixed terms taken out where it stands whole (a K-03 v1.1 term fact: code
// supplies it, word for word, and it is never changed or translated). They are read in one Unicode form (NFC), as the
// literal check reads them (../check.ts).

import type { ComposeInput, MessagePlan } from "../prompt";

/** The relay's quote slot (K-03 slots.json relay.quote; arch 07 line 359: "quote them in a code-filled slot"). */
export const QUOTE_SLOT = "relay.quote";

/** A slot as a text writes it (K-03 `slottedText`; SPEC-master 5h): its name, its example words and its other words. */
export interface WrittenSlot {
  readonly name: string;
  /** The words after ':', illustrations code replaces (MC C6), or null. */
  readonly example: string | null;
  /** The words after '|', which the slot filler writes in place of the service under the sensitive switch, or null. */
  readonly other: string | null;
}

/** A slot anywhere in words K-03's pattern accepts: a name, then any example after ':', then any other words after '|'. */
const SLOT = /\{\{([^:{}|]*)(?::([^{}|]*))?(?:\|([^{}]*))?\}\}/gu;
/** Any slot, to take it out of the words. */
const SLOT_ANYWHERE = /\{\{[^{}]*\}\}/gu;
/** A word: letters, marks and digits, with any apostrophe inside it ("you're", "can't"). */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

/** Every slot a text writes, in order. */
export function slotsIn(text: string): WrittenSlot[] {
  return [...text.normalize("NFC").matchAll(SLOT)].map((match) => ({
    name: match[1] ?? "",
    example: match[2] ?? null,
    other: match[3] ?? null,
  }));
}

/** One words field of a plan: where it is and its words. */
export interface PlanField {
  readonly at: string;
  readonly text: string;
}

/** The plan's words fields, in order: each line's text, then the question's. */
export function planFields(plan: MessagePlan): PlanField[] {
  const fields: PlanField[] = plan.lines.map((line, k) => ({
    at: `lines[${String(k)}].text`,
    text: line.text,
  }));
  if (plan.question !== null) fields.push({ at: "question.text", text: plan.question.text });
  return fields;
}

/** The words of Rosie's own fixed terms the input gives (K-03 v1.1 term facts), in one Unicode form. */
export function termWords(input: ComposeInput): string[] {
  return input.facts.flatMap((fact) => ("slot" in fact ? [] : [fact.value.normalize("NFC")]));
}

/** The model's own words in a field: its slots out, and each of Rosie's own terms out where it stands whole. */
export function ownWords(text: string, terms: readonly string[]): string {
  let own = text.normalize("NFC").replace(SLOT_ANYWHERE, " ");
  for (const term of terms) if (term.trim() !== "") own = own.split(term).join(" ");
  return own;
}

/** The words of a text, lowercased, in order, a curly apostrophe read as a straight one. */
export function wordsOf(text: string): string[] {
  return [...text.normalize("NFC").toLowerCase().matchAll(WORD)].map((match) => match[0].replace(/’/gu, "'"));
}

/** Whether `run` stands in `words` as words in a row. */
export function holdsRun(words: readonly string[], run: readonly string[]): boolean {
  return (
    run.length > 0 &&
    words.some(
      (_word, start) =>
        start + run.length <= words.length && run.every((word, k) => words[start + k] === word),
    )
  );
}

/** Every run of `size` words in a row. */
export function runsOf(words: readonly string[], size: number): string[][] {
  const runs: string[][] = [];
  for (let start = 0; start + size <= words.length; start += 1) runs.push(words.slice(start, start + size));
  return runs;
}

/** One problem per check and place: adds it unless it is already named. */
export function addOnce<T extends { readonly check: string; readonly at: string }>(
  problems: T[],
  problem: T,
): void {
  if (!problems.some((each) => each.check === problem.check && each.at === problem.at))
    problems.push(problem);
}
