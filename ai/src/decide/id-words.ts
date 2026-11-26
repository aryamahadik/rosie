// The backstop for an id field's value (T-1555 Gives 5; the lead's ruling, DL-1214; K-09 README default 200).
//
// K-09 default 200: at S1-09 the `business` field's value is its words, character for character, "never an id, never a
// listing's words and never the claim's words". Limit 6 re-parses an id value one way (actions/src/values/reparse.ts
// lines 343 to 345): the folded value must stand as whole words, in order, inside its folded words; anything else is
// noValue, which the gate reports as valueFailsWords, and the one re-read can never commit a corrected value
// (result.ts: an agreed part named failing goes only if the re-read gives it alike). On the user's iPhone (DL-1213) the
// agreed Haiku value was not a run of its words, so S1-09 was asked again.
//
// decide-3's rule d asks the model for the typed words exactly. This is the fixed half: before a read leaves the AI layer,
// and so before two reads are compared (agree.ts) and before any part reaches the gate, each field of a choose or enter
// part whose type on its choice is `id` (K-01 v1 `answerField.type`, as the context's choice lists it) has its value set
// to its own words. The words are what the model quoted, which read.ts has confirmed stand in the turn's texts
// (quoteInText), so the value is a run of its words by construction and two reads that quote the same words give the
// same value. Every other type is unchanged: a text, integer, boolean, money or time value keeps what the model gave and
// is re-parsed by limit 6 as before. Nothing reads an id field's value after the gate but limit 6 (K-09 defaults 201,
// 202 and 204: the settler reads the words, the writer the settler's reading), so nothing downstream loses a value.
//
// Pure: nothing here calls a model or logs. A part whose choice the context does not offer, or a field its choice does
// not carry, is left as it is: the named rules refuse it (check.ts, optionOffered) before this matters.

import type { Choice } from "../context";
import type { DecideContext, DecidePart, DecideRead, Field } from "./types";

/** K-01 v1 `answerField.type` of an id field. */
export const ID_TYPE = "id";

/** The names of a choice's id-typed fields. */
function idFieldsOf(choice: Choice): ReadonlySet<string> {
  return new Set(choice.fields.filter((field) => field.type === ID_TYPE).map((field) => field.name));
}

/** One part with each id-typed field's value set to its words; the same object when nothing changes. */
export function idValuesAsWordsInPart(choices: ReadonlyMap<string, Choice>, part: DecidePart): DecidePart {
  if (part.verb !== "choose" && part.verb !== "enter") return part;
  const choice = choices.get(part.choice);
  if (choice === undefined) return part;
  const ids = idFieldsOf(choice);
  if (ids.size === 0 || !part.fields.some((field) => ids.has(field.name) && field.value !== field.words))
    return part;
  const fields: Field[] = part.fields.map((field) =>
    ids.has(field.name) ? { name: field.name, value: field.words, words: field.words } : field,
  );
  return { ...part, fields };
}

/** The choices a context offers, by id (the first of an id given twice, as check.ts's ruleView keeps it). */
export function choicesById(context: DecideContext): ReadonlyMap<string, Choice> {
  const offered = new Map<string, Choice>();
  for (const choice of context.choices)
    if (!offered.has(choice.choiceId)) offered.set(choice.choiceId, choice);
  return offered;
}

/**
 * The read with each id-typed field's value set to its own words (see the head of this file): a new read when any value
 * changes, else `read` itself. Never changes a quote, a verb, a choice, a field's name or words, or a field of any
 * other type.
 */
export function idValuesAsWords(context: DecideContext, read: DecideRead): DecideRead {
  const choices = choicesById(context);
  const parts = read.parts.map((part) => idValuesAsWordsInPart(choices, part));
  return parts.every((part, k) => part === read.parts[k]) ? read : { language: read.language, parts };
}
