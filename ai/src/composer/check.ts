// The AI layer's checks on a composer row (T-373, C-118): the input before any call, the model's answer before it
// leaves the AI layer. Each failure is a typed refusal (types.ts REFUSAL_CHECKS), never a plan.
//
//   inputProblems   the input is a K-03 v1.1 `composeInput` (each fact a slot fact or a term fact; every v1 input is
//                   one), and carries no frontier (arch 07 line 397: "never the frontier"; refuse-frontier-in-input.json);
//   planProblems    the answer is a K-03 v1 `plan` (refuse-format-not-allowed.json: a format outside the five;
//                   refuse-hold-slot.json: {{hold}}, refused since D66);
//   allowedFormatProblems  each format is one the input's allowedFormats lists (arch 07 line 365);
//   literalProblems no number, date or price is typed in the plan's words, outside its slots, unless a fact of the
//                   input holds it (rule 4: code fills every value; arch 07 line 403: only <facts> may be stated). The
//                   facts are composeInput.facts[].value, slot facts' and term facts' alike, never a term's source (K-03
//                   v1.1 README "Where the composer's literal check reads these facts"). Its numbers are K-03 v1.1's
//                   named rule numbersHeldByFacts exactly: every run of digits outside the slots is held by a run of
//                   some fact's value; dates written in words are held the same way, by a fact's words.
//
// Structured outputs keep a model to its schema, but a refusal or a cut-off answer may not match it (T-360 finding 4),
// and no grammar knows the row's allowed formats or facts, so every answer is checked. The Worker cannot run Ajv (it
// compiles schemas with new Function), so the schema checks are written here, reading K-03's own lists and patterns
// (schema.ts); the tests hold them to Ajv over the contract files. The other rules that join the input and the plan
// (option ids, page type, thread target, link slots, 2 to 5 poll options) are the message checks' and the format
// rules' (C-092, C-128; K-03 README "What the schema does not check, and code does"), as are the Values check on the
// filled message and every other check of arch 07 lines 405 to 417.
//
// A problem names a check and a place, never words: no value, line or label of the row or the plan, since a problem
// may reach a log (K-08 README line 75: never a message's words in a span or a log line).

import formatsContract from "../../../contracts/common/formats.v1.schema.json";
import {
  CHANNELS,
  FORMATS,
  LANGUAGE,
  LINE_ROLES,
  LINK_SLOTS,
  READER_ROLES,
  REACHES,
  SITUATIONS,
  SLOT_NAMES,
  SLOTTED_TEXT,
  TERM_FACT_SOURCE,
  TERM_FACT_VALUE,
} from "./schema";
import type { ComposeInput, ComposeProblem, LiteralKind, MessagePlan, RefusalCheck } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The shared formats' patterns (contracts/common/formats.v1.schema.json), as Ajv reads them. */
const FORMAT_DEFS = (formatsContract as unknown as { $defs: Readonly<Record<string, { pattern?: unknown }>> })
  .$defs;
function formatPattern(name: string): RegExp {
  const pattern = FORMAT_DEFS[name]?.pattern;
  if (typeof pattern !== "string") throw new Error(`formats.v1 has no pattern for ${name}`);
  return new RegExp(pattern, "u");
}
const ID = formatPattern("id");
const TURN_ID = formatPattern("turnId");
const UTC = formatPattern("utc");
const ZONE = formatPattern("zone");
/** K-01 v1 `stepId` (contracts/bundle/bundle.v1.schema.json), as the prompt layout writes it. */
const STEP_ID = /^[SAB](1[0-3]|[1-9])-x?[0-9]{2,3}$/u;
/** K-03 `conversationMessage.from`. */
const FROM = ["reader", "rosie"] as const;

const INPUT_KEYS = [
  "row",
  "turn",
  "conversation",
  "masterText",
  "facts",
  "audience",
  "language",
  "channel",
  "situation",
  "allowedFormats",
  "allowedLinks",
  "options",
  "pageTypes",
  "openQuestions",
  "inbound",
] as const;
const PLAN_KEYS = ["formats", "lines", "question", "pageType", "threadReplyTo"] as const;

const matches = (pattern: RegExp, value: unknown): boolean =>
  typeof value === "string" && pattern.test(value);
const isIn = (values: readonly string[], value: unknown): boolean =>
  typeof value === "string" && values.includes(value);
const isText = (value: unknown): boolean => typeof value === "string";
const isNullableText = (value: unknown): boolean => value === null || typeof value === "string";

/** Exactly these keys, each present (K-03: every property required, additionalProperties false). */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

const isTime = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["utc", "zone"]) &&
  matches(UTC, value.utc) &&
  matches(ZONE, value.zone);
const isMessage = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["from", "text", "sentAt"]) &&
  isIn(FROM, value.from) &&
  isText(value.text) &&
  isTime(value.sentAt);
const isMasterText = (value: unknown): boolean =>
  isRecord(value) && exactKeys(value, ["step", "text"]) && matches(STEP_ID, value.step) && isText(value.text);
/** A slot fact (K-03 `fact`): a slot of the vocabulary and its value. */
const isSlotFact = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["slot", "value"]) &&
  isIn(SLOT_NAMES, value.slot) &&
  isText(value.value);
/** A term fact (K-03 v1.1 `termFact`): one of Rosie's own fixed terms, its words and its source line, and no slot. */
const isTermFact = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["value", "source"]) &&
  matches(TERM_FACT_VALUE, value.value) &&
  matches(TERM_FACT_SOURCE, value.source);
/** One fact of the input (K-03 v1.1 `inputFact`): a slot fact or a term fact. */
const isFact = (value: unknown): boolean => isSlotFact(value) || isTermFact(value);
const isAudience = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["role", "name", "way", "handlingLine"]) &&
  isIn(READER_ROLES, value.role) &&
  isNullableText(value.name) &&
  isIn(REACHES, value.way) &&
  isNullableText(value.handlingLine);
const isOption = (value: unknown): boolean =>
  isRecord(value) && exactKeys(value, ["id", "label"]) && matches(ID, value.id) && isText(value.label);
const isOpenQuestion = (value: unknown): boolean =>
  isRecord(value) && exactKeys(value, ["id", "text"]) && matches(ID, value.id) && isText(value.text);
const isInbound = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) && exactKeys(value, ["text", "sentAt"]) && isText(value.text) && isTime(value.sentAt));

/** The places of a list that fail: the list itself when it is not one (or is too short), else each bad item. */
function listPlaces(value: unknown, at: string, item: (entry: unknown) => boolean, minItems = 0): string[] {
  if (!Array.isArray(value) || value.length < minItems) return [at];
  return (value as unknown[]).flatMap((entry, k) => (item(entry) ? [] : [`${at}[${String(k)}]`]));
}

/**
 * Each way `value` is not a K-03 v1.1 `composeInput`, one problem per place; a frontier field is its own check. Empty
 * when the input is whole.
 */
export function inputProblems(value: unknown): ComposeProblem[] {
  if (!isRecord(value)) return [{ check: "input", at: "(root)" }];
  const problems: ComposeProblem[] = [];
  const keys = Object.keys(value);
  if (keys.includes("frontier")) problems.push({ check: "frontier", at: "frontier" });
  const places: string[] = [];
  if (keys.some((key) => key !== "frontier" && !(INPUT_KEYS as readonly string[]).includes(key)))
    places.push("(root)");
  if (!matches(ID, value.row)) places.push("row");
  if (!matches(TURN_ID, value.turn)) places.push("turn");
  places.push(...listPlaces(value.conversation, "conversation", isMessage));
  if (!isMasterText(value.masterText)) places.push("masterText");
  places.push(...listPlaces(value.facts, "facts", isFact));
  if (!isAudience(value.audience)) places.push("audience");
  if (!matches(LANGUAGE, value.language)) places.push("language");
  if (!isIn(CHANNELS, value.channel)) places.push("channel");
  if (!isIn(SITUATIONS, value.situation)) places.push("situation");
  places.push(...listPlaces(value.allowedFormats, "allowedFormats", (format) => isIn(FORMATS, format), 1));
  places.push(...listPlaces(value.allowedLinks, "allowedLinks", (link) => isIn(LINK_SLOTS, link)));
  places.push(...listPlaces(value.options, "options", isOption));
  places.push(...listPlaces(value.pageTypes, "pageTypes", isText));
  places.push(...listPlaces(value.openQuestions, "openQuestions", isOpenQuestion));
  if (!isInbound(value.inbound)) places.push("inbound");
  for (const at of places) problems.push({ check: "input", at });
  return problems;
}

type Add = (check: RefusalCheck, at: string) => void;

/** A slot at the start of a text: its name, then any example words, then any other words (SPEC-master 5h). */
const SLOT_AT = /^\{\{([^:{}|]*)(?::[^{}|]*)?(?:\|[^{}]*)?\}\}/u;

/** Words with slots (K-03 `slottedText`): a {{hold}} and a slot outside the vocabulary are named as such. */
function textProblems(value: unknown, at: string, add: Add): void {
  if (typeof value !== "string") {
    add("plan", at);
    return;
  }
  if (SLOTTED_TEXT.test(value)) return;
  let named = false;
  for (let from = value.indexOf("{{"); from >= 0; from = value.indexOf("{{", from + 2)) {
    const name = SLOT_AT.exec(value.slice(from))?.[1];
    if (name === "hold") {
      add("holdSlot", at);
      named = true;
    } else if (name === undefined || !SLOT_NAMES.includes(name)) {
      add("unknownSlot", at);
      named = true;
    }
  }
  if (!named) add("plan", at);
}

/**
 * Each way `value` is not a K-03 v1 `plan`, one problem per check and place: a format outside K-03's five is
 * formatNotAllowed, a {{hold}} slot holdSlot, another slot outside the vocabulary unknownSlot, anything else plan.
 * Empty exactly when K-03's schema accepts it.
 */
export function planProblems(value: unknown): ComposeProblem[] {
  if (!isRecord(value)) return [{ check: "plan", at: "(root)" }];
  const problems: ComposeProblem[] = [];
  const add: Add = (check, at) => {
    if (!problems.some((problem) => problem.check === check && problem.at === at))
      problems.push({ check, at });
  };
  if (!exactKeys(value, PLAN_KEYS)) add("plan", "(root)");

  const formats = value.formats;
  if (!Array.isArray(formats) || formats.length < 1) add("plan", "formats");
  else
    (formats as unknown[]).forEach((format, k) => {
      const at = `formats[${String(k)}]`;
      if (typeof format !== "string") add("plan", at);
      else if (!FORMATS.includes(format)) add("formatNotAllowed", at);
    });

  if (!Array.isArray(value.lines)) add("plan", "lines");
  else
    (value.lines as unknown[]).forEach((line, k) => {
      const at = `lines[${String(k)}]`;
      if (!isRecord(line)) {
        add("plan", at);
        return;
      }
      if (!exactKeys(line, ["role", "text"])) add("plan", at);
      if (!isIn(LINE_ROLES, line.role)) add("plan", `${at}.role`);
      textProblems(line.text, `${at}.text`, add);
    });

  const question = value.question;
  if (question !== null) {
    if (!isRecord(question)) add("plan", "question");
    else {
      if (!exactKeys(question, ["text", "optionIds"])) add("plan", "question");
      textProblems(question.text, "question.text", add);
      const ids = question.optionIds;
      if (!Array.isArray(ids) || !(ids as unknown[]).every(isText)) add("plan", "question.optionIds");
    }
  }
  if (!isNullableText(value.pageType)) add("plan", "pageType");
  if (!isNullableText(value.threadReplyTo)) add("plan", "threadReplyTo");
  return problems;
}

/** Each of the plan's formats that K-03 knows but this row's allowedFormats does not list (arch 07 line 365). */
export function allowedFormatProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  return plan.formats.flatMap((format, k): ComposeProblem[] =>
    FORMATS.includes(format) && !input.allowedFormats.includes(format)
      ? [{ check: "formatNotAllowed", at: `formats[${String(k)}]` }]
      : [],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Literal values: what a number, a date or a price looks like in a plan's own words (arch 07 line 409: each number,
// time, date, price, code, phone, link and name), read the way T-372's prompt test reads its examples' words.

/** A slot in words K-03's pattern accepts: every {{ opens one, and a slot holds no brace. */
const SLOT_ANYWHERE = /\{\{[^{}]*\}\}/gu;
const PRICES = [/[$€£¥]\s?\d[\d.,]*/gu, /\d[\d.,]*\s?(?:dollars?|cents?|USD|EUR|pesos?)(?!\p{L})/giu];
const DATES_WITH_DIGITS = [
  /\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?!\p{L})/giu,
  /\d{1,2}:\d{2}/gu,
  /\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/gu,
  /\d{4}-\d{2}-\d{2}/gu,
  /(?<!\p{L})(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\p{L}*\.?\s+\d{1,2}(?!\d)/gu,
];
const DATE_WORDS = [
  /(?<!\p{L})(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)(?!\p{L})/gu,
  /(?<!\p{L})(?:today|tomorrow|tonight|yesterday)(?!\p{L})/giu,
  /(?<!\p{L})(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo|hoy|mañana|ayer)(?!\p{L})/giu,
  /(?<!\p{L})(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?!\p{L})/giu,
];
const DIGITS = /\d+/gu;
const WORD = /\p{L}+/gu;
const ALL_DIGITS = /^\d+$/u;

interface Found {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Every match of a global pattern in a text, with where it starts and ends. */
function found(pattern: RegExp, text: string): Found[] {
  const out: Found[] = [];
  const search = new RegExp(pattern.source, pattern.flags);
  for (let match = search.exec(text); match !== null; match = search.exec(text)) {
    out.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    if (match[0] === "") search.lastIndex += 1;
  }
  return out;
}

const digitRuns = (text: string): string[] => found(DIGITS, text).map((run) => run.text);
const wordsIn = (text: string): string[] => found(WORD, text).map((word) => word.text.toLowerCase());
const overlaps = (a: Found | Literal, b: Found | Literal): boolean => a.start < b.end && b.start < a.end;

/** One literal value in words: its kind and the parts a fact must hold, each digit run and each date word. */
interface Literal {
  readonly start: number;
  readonly end: number;
  readonly kind: LiteralKind;
  readonly atoms: readonly string[];
}

/**
 * The literal values in words outside slots: prices, dates and times, date words, and any other digits. A literal's
 * digits are the whole runs of digits of the words it touches, never part of one ("10/255" holds 10 and 255), and a
 * run no price or date touches is a number of its own, so every run of digits is an atom of some literal: the runs
 * K-03 v1.1's numbersHeldByFacts reads, each held or refused as that rule holds it.
 */
function literalsIn(words: string): Literal[] {
  const runs = found(DIGITS, words);
  const runsTouching = (match: Found): string[] =>
    runs.filter((run) => overlaps(run, match)).map((run) => run.text);
  const literals: Literal[] = [];
  const take = (
    patterns: readonly RegExp[],
    kind: LiteralKind,
    atomsOf: (match: Found) => string[],
  ): void => {
    for (const pattern of patterns)
      for (const match of found(pattern, words))
        literals.push({ start: match.start, end: match.end, kind, atoms: atomsOf(match) });
  };
  take(PRICES, "price", runsTouching);
  take(DATES_WITH_DIGITS, "date", runsTouching);
  take(DATE_WORDS, "date", (match) => [match.text.toLowerCase()]);
  for (const run of runs) {
    if (!literals.some((literal) => overlaps(run, literal)))
      literals.push({ start: run.start, end: run.end, kind: "number", atoms: [run.text] });
  }
  return literals;
}

/**
 * Each words field of the plan (its lines' text and its question's) that types a number, a date or a price outside its
 * slots that no fact of the input holds: one problem per field and kind. A digit run is held when a fact's value, a
 * slot fact's or a term fact's, has the same digit run; a date word when a fact's value has that word. A term fact holds
 * a literal only by its own words, never by its source. Words inside a slot, its example words included, are code's to
 * replace, so they are never literals.
 */
export function literalProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  const values = input.facts.map((fact) => fact.value);
  const heldDigits = new Set(values.flatMap(digitRuns));
  const heldWords = new Set(values.flatMap(wordsIn));
  const held = (atom: string): boolean =>
    ALL_DIGITS.test(atom) ? heldDigits.has(atom) : heldWords.has(atom);
  const fields: [string, string][] = plan.lines.map((line, k): [string, string] => [
    `lines[${String(k)}].text`,
    line.text,
  ]);
  if (plan.question !== null) fields.push(["question.text", plan.question.text]);

  const problems: ComposeProblem[] = [];
  for (const [at, words] of fields) {
    for (const literal of literalsIn(words.replace(SLOT_ANYWHERE, " "))) {
      if (literal.atoms.every(held)) continue;
      if (!problems.some((problem) => problem.at === at && problem.kind === literal.kind))
        problems.push({ check: "literalValue", at, kind: literal.kind });
    }
  }
  return problems;
}

/**
 * Every check a model's answer passes before it leaves the AI layer, for the row it answers: K-03's plan first; only a
 * whole plan is then held to the row (its allowed formats, then its facts).
 */
export function planAgainstInput(answer: unknown, input: ComposeInput): ComposeProblem[] {
  const shape = planProblems(answer);
  if (shape.length > 0) return shape;
  const plan = answer as MessagePlan;
  return [...allowedFormatProblems(plan, input), ...literalProblems(plan, input)];
}
