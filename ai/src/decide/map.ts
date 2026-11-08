// From the two steps' answers to K-02 v1's `decideRead` (T-368; CQ-25's two-step form, as lib.mjs's mapTwoStep maps it):
// step 1 gives the language and each part's quote and verb, each step 2 its part's own fields, spread into the part in
// K-02's order. A part that is no_op has no step 2. A step-2 answer is never allowed to give its part's verb or quote
// again: step 1's stand.
//
// The model reads the turn's texts escaped as data (context/tags.ts: "<" as &lt;, ">" as &gt;, "&" as &amp; where it
// would read as an entity) and is asked to quote them as typed. Either way, a quote, a field's words or value, and
// pass_on's or redact's words are mapped back to the text's own characters before code confirms them (T-367's handoff):
// the unescaped form when the turn's texts hold it, else the form as given when they hold that, else the unescaped form
// (which the quote check then refuses).

import { unescapeData } from "../context";
import { decidePartProblems, foundIn } from "./check";
import { PART_KEYS } from "./schema";
import { VERBS, type DecidePart, type PartHead, type Verb } from "./types";

/** The most parts one read may have: past it, the read is refused before any step-2 call (a cost guard; a default). */
export const MAX_PARTS = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LANGUAGE = /^[a-z]{2}$/u;
const HAS_TEXT = /\S/u;

/** Words the model copied, in the turn's own characters (see the head of this file). */
export function asTyped(words: string, texts: readonly string[]): string {
  const plain = unescapeData(words);
  if (plain === words || foundIn(texts, plain)) return plain;
  return foundIn(texts, words) ? words : plain;
}

/** Step 1's answer, checked and mapped, or why it cannot be used. */
export type StageOne =
  | { readonly ok: true; readonly language: string; readonly parts: readonly PartHead[] }
  | { readonly ok: false; readonly problems: readonly string[]; readonly unmappedParts: readonly number[] };

/**
 * Checks step 1's answer against its schema (the language, at least one part, each with exactly a quote with words and
 * one of the eight verbs), against MAX_PARTS, and each quote against the turn's texts (quoteInText, before any step-2
 * call is spent). Problems name parts and fields, never words.
 */
export function readStageOne(output: unknown, texts: readonly string[]): StageOne {
  if (!isRecord(output))
    return { ok: false, problems: ["step 1's answer is not an object"], unmappedParts: [] };
  const problems: string[] = [];
  const unmapped = new Set<number>();
  if (Object.keys(output).some((key) => key !== "language" && key !== "parts"))
    problems.push("step 1's answer holds a key its schema does not give it");
  if (!(typeof output.language === "string" && LANGUAGE.test(output.language)))
    problems.push("language is not a two-letter lowercase code");
  const parts = output.parts;
  if (!Array.isArray(parts)) {
    problems.push("parts is not a list");
    return { ok: false, problems, unmappedParts: [] };
  }
  if (parts.length === 0) problems.push("parts is empty: a read has at least one part");
  if (parts.length > MAX_PARTS)
    problems.push(
      `parts holds ${String(parts.length)} parts, more than the ${String(MAX_PARTS)} one read may have`,
    );
  const heads: PartHead[] = [];
  parts.forEach((part: unknown, k) => {
    const at = `parts[${String(k)}]`;
    const fail = (line: string): void => {
      problems.push(line);
      unmapped.add(k);
    };
    if (!isRecord(part)) {
      fail(`${at} is not a part`);
      return;
    }
    if (Object.keys(part).some((key) => key !== "quote" && key !== "verb"))
      fail(`${at} holds a key step 1 does not give a part`);
    const verb = part.verb;
    if (typeof verb !== "string" || !(VERBS as readonly string[]).includes(verb))
      fail(`${at}.verb is not one of the eight verbs`);
    const quote = part.quote;
    if (typeof quote !== "string" || !HAS_TEXT.test(quote)) {
      fail(`${at}.quote is empty`);
      return;
    }
    const typed = asTyped(quote, texts);
    if (!foundIn(texts, typed)) fail(`${at}.quote is not found in the turn's texts (quoteInText)`);
    heads.push({ quote: typed, verb: verb as Verb });
  });
  if (problems.length > 0) return { ok: false, problems, unmappedParts: [...unmapped].sort((a, b) => a - b) };
  return { ok: true, language: output.language as string, parts: heads };
}

/** A field's words and a text value in the text's own characters; anything else is left for the K-02 check. */
function typedFields(fields: unknown, texts: readonly string[]): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map((field: unknown) => {
    if (!isRecord(field)) return field;
    const out: Record<string, unknown> = { ...field };
    if (typeof field.words === "string") out.words = asTyped(field.words, texts);
    if (typeof field.value === "string") out.value = asTyped(field.value, texts);
    return out;
  });
}

/** One part as K-02 writes it, or the problems of its step-2 answer. */
export type MappedPart =
  | { readonly ok: true; readonly part: DecidePart }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Part `k` from its step-1 head and its step-2 answer (undefined for no_op): verb and quote from step 1, then the verb's
 * own fields from step 2 in K-02's order, in the text's characters; checked against K-02's `decidePart`.
 */
export function mapPart(head: PartHead, answer: unknown, k: number, texts: readonly string[]): MappedPart {
  const at = `parts[${String(k)}]`;
  const part: Record<string, unknown> = { verb: head.verb, quote: head.quote };
  if (head.verb !== "no_op") {
    if (!isRecord(answer)) return { ok: false, problems: [`${at}: its step-2 answer is not an object`] };
    if ("verb" in answer || "quote" in answer)
      return { ok: false, problems: [`${at}: its step-2 answer gives the part's verb or quote again`] };
    const own = PART_KEYS[head.verb].slice(2);
    if (Object.keys(answer).some((key) => !own.includes(key)))
      return { ok: false, problems: [`${at}: its step-2 answer holds a key its verb does not take`] };
    for (const key of own) if (key in answer) part[key] = answer[key];
    if ("fields" in part) part.fields = typedFields(part.fields, texts);
    if (typeof part.words === "string") part.words = asTyped(part.words, texts);
  }
  const problems = decidePartProblems(part, at);
  return problems.length === 0 ? { ok: true, part: part as unknown as DecidePart } : { ok: false, problems };
}
