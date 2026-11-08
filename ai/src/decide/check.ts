// The AI layer's validator of a decide read (T-368): before a read leaves the AI layer it must be a K-02 v1
// `decideRead` (the schema) and keep K-02's two named rules against its context (contracts/model/model.rules.mjs:
// optionOffered and quoteInText), so each refused K-02 fixture is refused here. Structured outputs keep a model to its
// schema, but a refusal or a cut-off answer may not match it (K-02 README item 5), and no grammar knows the turn's
// choices or texts, so every read is checked.
//
// The Worker cannot run Ajv (it compiles schemas with new Function), so the schema check is written here, and the
// rules file is the contract's statement, not code the Worker can load; the tests hold both to the contract (Ajv over
// the schema files, and model.rules.mjs itself). What this does not do is the gate's (T-298, C-080 and C-083): re-parse
// each value from its words, resolve dates from the send time, check limits.
//
// A problem names a part, a field and a rule, never words: no quote, value, name or id the model wrote, since a problem
// may reach a log (K-08 README: never the raw number or words).

import type { Choice, DecideContext } from "../context";
import { PART_KEYS } from "./schema";
import { HAND_OFF_ABOUT, VERBS, type DecidePart, type DecideRead, type Verb } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** K-02 `language`: a two-letter lowercase code. */
const LANGUAGE = /^[a-z]{2}$/u;
/** K-02 `nonEmptyText`: at least one character that is not a space. */
const HAS_TEXT = /\S/u;
/** The shared formats (contracts/common/formats.v1.schema.json): currency, utc and zone. */
const CURRENCY = /^[A-Z]{3}$/u;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/u;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;

const isWords = (value: unknown): boolean => typeof value === "string" && HAS_TEXT.test(value);
const isVerb = (value: unknown): value is Verb =>
  typeof value === "string" && (VERBS as readonly string[]).includes(value);

/** Exactly these keys, each present: one problem per key missing, one for any key too many (never named). */
function keyProblems(value: Record<string, unknown>, keys: readonly string[], at: string): string[] {
  const problems: string[] = [];
  if (Object.keys(value).some((key) => !keys.includes(key)))
    problems.push(`${at} holds a key K-02 does not give it`);
  for (const key of keys) if (!(key in value)) problems.push(`${at}.${key} is missing`);
  return problems;
}

function isMoney(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    Number.isInteger(value.cents) &&
    typeof value.currency === "string" &&
    CURRENCY.test(value.currency)
  );
}

function isTime(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    typeof value.utc === "string" &&
    UTC.test(value.utc) &&
    typeof value.zone === "string" &&
    ZONE.test(value.zone)
  );
}

/** K-02 `fieldValue`: text, a whole number, true or false, money or a time as the shared formats write them. */
function isFieldValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isInteger(value);
  return isRecord(value) && (isMoney(value) || isTime(value));
}

function fieldProblems(value: unknown, at: string): string[] {
  if (!isRecord(value)) return [`${at} is not a field`];
  const problems = keyProblems(value, ["name", "value", "words"], at);
  if ("name" in value && typeof value.name !== "string") problems.push(`${at}.name is not text`);
  if ("value" in value && !isFieldValue(value.value))
    problems.push(`${at}.value is not text, a whole number, true or false, money or a time`);
  if ("words" in value && !isWords(value.words))
    problems.push(`${at}.words are empty: a value without words is refused`);
  return problems;
}

/** Every way `value` is not a K-02 v1 `decidePart`, one line each, naming fields and never their words. */
export function decidePartProblems(value: unknown, at: string): string[] {
  if (!isRecord(value)) return [`${at} is not a part`];
  if (!isVerb(value.verb)) return [`${at}.verb is not one of the eight verbs`];
  const verb = value.verb;
  const problems = keyProblems(value, PART_KEYS[verb], at);
  const has = (key: string): boolean => key in value;
  if (has("quote") && !isWords(value.quote)) problems.push(`${at}.quote is empty`);
  for (const key of ["question", "choice", "unclear", "why", "reason"]) {
    if (PART_KEYS[verb].includes(key) && has(key) && typeof value[key] !== "string")
      problems.push(`${at}.${key} is not text`);
  }
  if (PART_KEYS[verb].includes("fields") && has("fields")) {
    if (!Array.isArray(value.fields)) problems.push(`${at}.fields is not a list`);
    else
      value.fields.forEach((field: unknown, k) => {
        problems.push(...fieldProblems(field, `${at}.fields[${String(k)}]`));
      });
  }
  if (verb === "ask" && has("questions")) {
    if (!Array.isArray(value.questions) || value.questions.some((q: unknown) => typeof q !== "string"))
      problems.push(`${at}.questions is not a list of text`);
  }
  if ((verb === "pass_on" || verb === "redact") && has("words") && !isWords(value.words))
    problems.push(`${at}.words are empty`);
  if (verb === "hand_off" && has("about") && !(HAND_OFF_ABOUT as readonly unknown[]).includes(value.about))
    problems.push(`${at}.about is not ownerOrStaff or other`);
  return problems;
}

/**
 * Every way `value` is not a K-02 v1 `decideRead`, one line each, naming fields and never their words; empty when it is
 * one: exactly a two-letter language and at least one part, each one of the eight verbs with exactly its own fields.
 */
export function decideReadProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["the read is not an object"];
  const problems = keyProblems(value, ["language", "parts"], "the read");
  if ("language" in value && !(typeof value.language === "string" && LANGUAGE.test(value.language)))
    problems.push("language is not a two-letter lowercase code");
  if (!("parts" in value)) return problems;
  if (!Array.isArray(value.parts)) {
    problems.push("parts is not a list");
    return problems;
  }
  if (value.parts.length === 0) problems.push("parts is empty: a read has at least one part");
  value.parts.forEach((part: unknown, k) => {
    problems.push(...decidePartProblems(part, `parts[${String(k)}]`));
  });
  return problems;
}

/** True when `value` is a K-02 v1 `decideRead`. */
export function isDecideRead(value: unknown): value is DecideRead {
  return decideReadProblems(value).length === 0;
}

/** Choice kinds choose takes and enter takes (model.rules.mjs CHOOSE_KINDS and ENTER_KINDS; arch 03 line 183). */
export const CHOOSE_KINDS: readonly string[] = Object.freeze(["option", "hub", "whichBooking"]);
export const ENTER_KINDS: readonly string[] = Object.freeze(["door", "anytime", "searchEntry"]);

/** What the named rules read of a context: its choices by id, the questions they answer, and the turn's words. */
export interface RuleView {
  readonly offered: ReadonlyMap<string, Choice>;
  readonly questions: ReadonlySet<string>;
  readonly texts: readonly string[];
}

export function ruleView(context: DecideContext): RuleView {
  const offered = new Map<string, Choice>();
  for (const choice of context.choices)
    if (!offered.has(choice.choiceId)) offered.set(choice.choiceId, choice);
  const questions = new Set<string>();
  for (const choice of context.choices) if (choice.question !== null) questions.add(choice.question);
  return { offered, questions, texts: context.texts.map((text) => text.words) };
}

/** Words found exactly in the words of one of the turn's texts (quoteInText's test). */
export const foundIn = (texts: readonly string[], words: string): boolean =>
  texts.some((text) => text.includes(words));

/**
 * The two named rules for one K-02-valid part against its context, one line per break, naming no words:
 *   optionOffered: a chosen or entered choice is one the context offers, of a kind its verb takes; choose names that
 *     choice's question; each field is one the choice carries; ask names only questions an offered choice answers;
 *   quoteInText: the quote, each field's words, and pass_on's or redact's words are found in one of the turn's texts.
 */
export function partRuleProblems(view: RuleView, part: DecidePart, at: string): string[] {
  const problems: string[] = [];
  if (part.verb === "choose" || part.verb === "enter") {
    const choice = view.offered.get(part.choice);
    if (choice === undefined) {
      problems.push(`${at}: ${part.verb} names a choice the context does not offer (optionOffered)`);
    } else {
      const kinds = part.verb === "choose" ? CHOOSE_KINDS : ENTER_KINDS;
      if (!kinds.includes(choice.kind))
        problems.push(
          `${at}: ${part.verb} takes a choice of kind ${kinds.join(", ")}, not ${choice.kind} (optionOffered)`,
        );
      if (part.verb === "choose" && part.question !== choice.question)
        problems.push(`${at}.question is not its choice's question (optionOffered)`);
      const carried = new Set(choice.fields.map((field) => field.name));
      part.fields.forEach((field, k) => {
        if (!carried.has(field.name))
          problems.push(`${at}.fields[${String(k)}] is not a field its choice carries (optionOffered)`);
      });
    }
  } else if (part.verb === "ask") {
    part.questions.forEach((question, k) => {
      if (!view.questions.has(question))
        problems.push(
          `${at}.questions[${String(k)}] is a question no offered choice answers (optionOffered)`,
        );
    });
  }
  if (!foundIn(view.texts, part.quote))
    problems.push(`${at}.quote is not found in the turn's texts (quoteInText)`);
  if (part.verb === "choose" || part.verb === "enter") {
    part.fields.forEach((field, k) => {
      if (!foundIn(view.texts, field.words))
        problems.push(`${at}.fields[${String(k)}].words are not found in the turn's texts (quoteInText)`);
    });
  }
  if ((part.verb === "pass_on" || part.verb === "redact") && !foundIn(view.texts, part.words))
    problems.push(`${at}.words are not found in the turn's texts (quoteInText)`);
  return problems;
}

/**
 * Everything that keeps `read` from leaving the AI layer for this context: what K-02's schema refuses, then, for each
 * part the schema accepts, what the named rules refuse. Empty when the read may be returned.
 */
export function readProblems(context: DecideContext, read: unknown): string[] {
  const problems = decideReadProblems(read);
  if (!isRecord(read) || !Array.isArray(read.parts)) return problems;
  const view = ruleView(context);
  read.parts.forEach((part: unknown, k) => {
    const at = `parts[${String(k)}]`;
    if (decidePartProblems(part, at).length === 0)
      problems.push(...partRuleProblems(view, part as DecidePart, at));
  });
  return problems;
}
