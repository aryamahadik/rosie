// The AI layer's checks on a composer row (T-373, C-118): the input before any call, the model's answer before it
// leaves the AI layer. Each failure is a typed refusal (types.ts REFUSAL_CHECKS), never a plan.
//
//   inputProblems   the input is a K-03 v1.1 `composeInput` (each fact a slot fact or a term fact; every v1 input is
//                   one), and carries no frontier (arch 07 line 397: "never the frontier"; refuse-frontier-in-input.json);
//                   one rule stricter than the schema: no term fact's words hold "{{" (DL-163 rule 3), since the filler
//                   would fill that slot inside Rosie's own line, such as the business's late-cancel fee in Rosie's fee;
//   planProblems    the answer is a K-03 v1 `plan` (refuse-format-not-allowed.json: a format outside the five;
//                   refuse-hold-slot.json: {{hold}}, refused since D66);
//   allowedFormatProblems  each format is one the input's allowedFormats lists (arch 07 line 365);
//   literalProblems no number, date or price is typed in the plan's words, outside its slots, unless a fact of the
//                   input holds it (rule 4: code fills every value; arch 07 line 403: only <facts> may be stated). The
//                   facts are composeInput.facts[].value, slot facts' and term facts' alike, never a term's source (K-03
//                   v1.1 README "Where the composer's literal check reads these facts"). Its numbers are K-03 v1.1's
//                   named rule numbersHeldByFacts exactly: every run of digits outside the slots is held by a run of
//                   some fact's value. Dates and prices written in words are the check's alone (README line 87;
//                   DL-163): a day or month name, or a day said in words, is held by a fact's value with the same word;
//                   a price in words ("two dollars", "dos dólares") by a fact's value with the same amount of money, in
//                   digits or in words.
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
/**
 * Words that hold "{{": a slot, or the start of one. Rosie's own term never does (DL-163 rule 3; the security review's
 * N3): the filler would fill it inside Rosie's own line, so such a term is refused, though v1.1's pattern "." takes it.
 */
const holdsSlot = (words: unknown): boolean => typeof words === "string" && words.includes("{{");
/**
 * A term fact (K-03 v1.1 `termFact`): one of Rosie's own fixed terms, its words and its source line, and no slot; its
 * words hold no "{{".
 */
const isTermFact = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["value", "source"]) &&
  matches(TERM_FACT_VALUE, value.value) &&
  !holdsSlot(value.value) &&
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
 * Each way `value` is not a K-03 v1.1 `composeInput`, one problem per place; a frontier field is its own check, and a
 * term fact whose words hold "{{" is refused at its place (DL-163 rule 3). Empty when the input is whole.
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
// time, date, price, code, phone, link and name), read the way T-372's prompt test reads its examples' words. Dates
// and prices written in words are literals too (K-03 README line 87: "Dates and prices written in words, such as
// 'Saturday' or 'two dollars', stay with the composer's literal check"; DL-163 rules 1 and 2). A number word outside a
// price ("one more thing") is not one: the Values check after the fill is its backstop (DL-163).

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
/**
 * Dates in words (DL-163 rule 2), each held only by a fact's value with the same word: the English day names (and their
 * plurals) and month names in full, in any case, but for May, March and August, which with every short form ("Sat",
 * "Oct") count only as written, capitalized, so "you may cancel", "we march on" and "she sat down" stay words; the days
 * said in words; the Spanish day names (with and without their accent, and the plurals sábados and domingos) and month
 * names, in any case.
 */
const DATE_WORDS = [
  /(?<!\p{L})(?:Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?|January|February|April|June|July|September|October|November|December)(?!\p{L})/giu,
  /(?<!\p{L})(?:May|March|August|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)(?!\p{L})/gu,
  /(?<!\p{L})(?:today|tomorrow|tonight|yesterday)(?!\p{L})/giu,
  /(?<!\p{L})(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábados?|sabados?|domingos?|hoy|mañana|ayer)(?!\p{L})/giu,
  /(?<!\p{L})(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?!\p{L})/giu,
];
const DIGITS = /\d+/gu;
const WORD = /\p{L}+/gu;

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

// Prices in words (DL-163 rule 1): number words, then a money word ("two dollars", "a buck", "fifty cents", "dos
// dólares", "treinta y cinco dólares"). Such a price is held only by a fact's value that states the same amount of
// money, in digits or in words: "$2 a booking" holds "two dollars", but "About 5 minutes" holds no "five dollars".

/** What a money word or sign names: a currency, counted in its whole units or in its hundredths (cents). */
interface MoneyUnit {
  readonly currency: string;
  readonly hundredths: boolean;
}
const DOLLAR: MoneyUnit = { currency: "USD", hundredths: false };
const CENT: MoneyUnit = { currency: "USD", hundredths: true };
const EURO: MoneyUnit = { currency: "EUR", hundredths: false };
const EURO_CENT: MoneyUnit = { currency: "EUR", hundredths: true };
const PESO: MoneyUnit = { currency: "PESO", hundredths: false };

/**
 * The money words a price ends with, in English and Spanish, lowercased, each with what it names. No pound: "fifty
 * pounds" may be a dog's weight.
 */
const MONEY_WORDS: ReadonlyMap<string, MoneyUnit> = new Map([
  ["dollar", DOLLAR],
  ["dollars", DOLLAR],
  ["buck", DOLLAR],
  ["bucks", DOLLAR],
  ["usd", DOLLAR],
  ["dólar", DOLLAR],
  ["dólares", DOLLAR],
  ["dolar", DOLLAR],
  ["dolares", DOLLAR],
  ["cent", CENT],
  ["cents", CENT],
  ["centavo", CENT],
  ["centavos", CENT],
  ["euro", EURO],
  ["euros", EURO],
  ["eur", EURO],
  ["céntimo", EURO_CENT],
  ["céntimos", EURO_CENT],
  ["centimo", EURO_CENT],
  ["centimos", EURO_CENT],
  ["peso", PESO],
  ["pesos", PESO],
]);
/** The signs, written before digits, of the currencies a money word names; "¢" is written after them. */
const MONEY_SIGNS: ReadonlyMap<string, MoneyUnit> = new Map([
  ["$", DOLLAR],
  ["€", EURO],
]);

/** Number words with their values: each word of `words`, the first worth `first` and each next one `step` more. */
function counted(words: string, first: number, step: number): [string, number][] {
  return words.split(" ").map((word, k): [string, number] => [word, first + step * k]);
}

const EN_UNITS: ReadonlyMap<string, number> = new Map(
  counted(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen",
    0,
    1,
  ),
);
const EN_TENS: ReadonlyMap<string, number> = new Map(
  counted("twenty thirty forty fifty sixty seventy eighty ninety", 20, 10),
);
const EN_SCALES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1000],
  ["million", 1_000_000],
]);
/** Spanish 0 to 19 and 21 to 29 (20 is a ten), then their other spellings: un and una, and the words without accents. */
const ES_UNITS: ReadonlyMap<string, number> = new Map([
  ...counted(
    "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve",
    0,
    1,
  ),
  ...counted(
    "veintiuno veintidós veintitrés veinticuatro veinticinco veintiséis veintisiete veintiocho veintinueve",
    21,
    1,
  ),
  ...counted("un una", 1, 0),
  ...counted("veintiún veintiun veintiuna", 21, 0),
  ...counted("dieciseis", 16, 0),
  ...counted("veintidos veintitres", 22, 1),
  ...counted("veintiseis", 26, 0),
]);
const ES_TENS: ReadonlyMap<string, number> = new Map(
  counted("veinte treinta cuarenta cincuenta sesenta setenta ochenta noventa", 20, 10),
);
/** Spanish hundreds, in both genders; cien and ciento are 100. */
const ES_HUNDREDS: ReadonlyMap<string, number> = new Map([
  ...counted("cien ciento", 100, 0),
  ...counted(
    "doscientos trescientos cuatrocientos quinientos seiscientos setecientos ochocientos novecientos",
    200,
    100,
  ),
  ...counted(
    "doscientas trescientas cuatrocientas quinientas seiscientas setecientas ochocientas novecientas",
    200,
    100,
  ),
]);

/** Every word that can be part of a number said in words, in English or Spanish, "and" and "y" between its parts included. */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "a",
  "and",
  "hundred",
  "y",
  "mil",
  ...[EN_UNITS, EN_TENS, EN_SCALES, ES_UNITS, ES_TENS, ES_HUNDREDS].flatMap((words) => [...words.keys()]),
]);

/**
 * The number some English words say, the whole of them, or undefined: "two", "twenty-five" (as "twenty", "five"),
 * "a hundred and fifty", "fifteen hundred", "two thousand five hundred"; "a" is 1 only first ("a dollar", "a hundred").
 */
function englishNumber(words: readonly string[]): number | undefined {
  let total = 0;
  let group = 0;
  let last: "start" | "a" | "unit" | "teen" | "tens" | "hundred" | "scale" | "and" = "start";
  for (const word of words) {
    const unit = EN_UNITS.get(word);
    const tens = EN_TENS.get(word);
    const scale = EN_SCALES.get(word);
    // Where a new part of the number may start: first, or after a hundred, a thousand or "and".
    const partMayStart = last === "start" || last === "hundred" || last === "scale" || last === "and";
    if (word === "a" && last === "start") {
      group = 1;
      last = "a";
    } else if (word === "and" && (last === "hundred" || last === "scale")) {
      last = "and";
    } else if (unit !== undefined && (partMayStart || (last === "tens" && unit >= 1 && unit <= 9))) {
      group += unit;
      last = unit < 10 ? "unit" : "teen";
    } else if (tens !== undefined && partMayStart) {
      group += tens;
      last = "tens";
    } else if (word === "hundred" && last !== "hundred" && last !== "and") {
      group = (group === 0 ? 1 : group) * 100;
      last = "hundred";
    } else if (scale !== undefined && last !== "scale" && last !== "and") {
      total += (group === 0 ? 1 : group) * scale;
      group = 0;
      last = "scale";
    } else {
      return undefined;
    }
  }
  return last === "start" || last === "and" ? undefined : total + group;
}

/**
 * The number some Spanish words say, the whole of them, or undefined: "dos", "veinticinco", "treinta y cinco",
 * "ciento cincuenta", "dos mil quinientos"; "y" joins only tens and units.
 */
function spanishNumber(words: readonly string[]): number | undefined {
  let total = 0;
  let group = 0;
  let last: "start" | "unit" | "tens" | "y" | "hundreds" | "mil" = "start";
  for (const word of words) {
    const unit = ES_UNITS.get(word);
    const tens = ES_TENS.get(word);
    const hundreds = ES_HUNDREDS.get(word);
    const groupStart = last === "start" || last === "hundreds" || last === "mil";
    if (word === "y" && last === "tens") {
      last = "y";
    } else if (unit !== undefined && (groupStart || (last === "y" && unit >= 1 && unit <= 9))) {
      group += unit;
      last = "unit";
    } else if (tens !== undefined && groupStart) {
      group += tens;
      last = "tens";
    } else if (hundreds !== undefined && (last === "start" || last === "mil")) {
      group += hundreds;
      last = "hundreds";
    } else if (word === "mil" && last !== "mil" && last !== "y") {
      total += (group === 0 ? 1 : group) * 1000;
      group = 0;
      last = "mil";
    } else {
      return undefined;
    }
  }
  return last === "start" || last === "y" ? undefined : total + group;
}

/** An amount of money as one atom: its currency and its value in hundredths ("USD 200" for $2 or two dollars). */
const amountOf = (unit: MoneyUnit, value: number): string =>
  `${unit.currency} ${String(Math.round(unit.hundredths ? value : value * 100))}`;

/** At most this many number words make one amount: "two thousand five hundred and twenty-five" is seven. */
const MAX_NUMBER_WORDS = 12;
/** What may join the words of a number said in words, and the number to its money word: spaces and hyphens. */
const JOINER = /^[-\s]+$/u;

/** One price in words: where it starts and ends, and its amount. */
interface WordPrice extends Found {
  readonly amount: string;
}

/**
 * The prices in words of a text: each money word with the number words right before it, joined by spaces or hyphens
 * ("fifteen-dollar fee"). The amount is the longest run of those words, ending at the money word, that says one number
 * in English or in Spanish: "a five-dollar fee" is five dollars, and "a dollar" is one.
 */
function wordPricesIn(text: string): WordPrice[] {
  const words = found(WORD, text);
  /** Whether the word before word k is a number word, joined to word k by spaces or hyphens alone. */
  const numberWordBefore = (k: number): boolean => {
    const before = words[k - 1];
    const after = words[k];
    return (
      before !== undefined &&
      after !== undefined &&
      NUMBER_WORDS.has(before.text.toLowerCase()) &&
      JOINER.test(text.slice(before.end, after.start))
    );
  };
  const prices: WordPrice[] = [];
  words.forEach((money, at) => {
    const unit = MONEY_WORDS.get(money.text.toLowerCase());
    if (unit === undefined) return;
    let from = at;
    while (at - from < MAX_NUMBER_WORDS && numberWordBefore(from)) from -= 1;
    for (let start = from; start < at; start += 1) {
      const said = words.slice(start, at).map((word) => word.text.toLowerCase());
      const value = englishNumber(said) ?? spanishNumber(said);
      const first = words[start];
      if (value !== undefined && first !== undefined) {
        prices.push({
          start: first.start,
          end: money.end,
          text: text.slice(first.start, money.end),
          amount: amountOf(unit, value),
        });
        break;
      }
    }
  });
  return prices;
}

/**
 * A number in digits as a price writes it, or undefined: "2", "2.50", "1,200", "1,200.50"; a comma before its last one
 * or two digits is a decimal comma ("2,50"); a stop or comma ending a sentence is not part of it.
 */
function priceNumber(digits: string): number | undefined {
  const text = digits.replace(/[.,]+$/u, "");
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)) return Number(text.replace(/,/gu, ""));
  if (/^\d+,\d{1,2}$/u.test(text)) return Number(text.replace(",", "."));
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  return undefined;
}

const SIGN_THEN_DIGITS = /([$€])\s*(\d[\d.,]*)/gu;
const DIGITS_THEN_WORD = /(\d[\d.,]*)\s*(\p{L}+)/gu;
const DIGITS_THEN_CENTS = /(\d[\d.,]*)\s*¢/gu;

/**
 * Every amount of money a fact's value states, in digits ("$2", "2 dollars", "50¢") or in words ("two dollars"), each
 * as one atom: "$2 a booking" states "USD 200".
 */
function amountsIn(text: string): string[] {
  const amounts: string[] = [];
  const add = (unit: MoneyUnit | undefined, digits: string | undefined): void => {
    const value = priceNumber(digits ?? "");
    if (unit !== undefined && value !== undefined) amounts.push(amountOf(unit, value));
  };
  for (const match of text.matchAll(SIGN_THEN_DIGITS)) add(MONEY_SIGNS.get(match[1] ?? ""), match[2]);
  for (const match of text.matchAll(DIGITS_THEN_WORD))
    add(MONEY_WORDS.get((match[2] ?? "").toLowerCase()), match[1]);
  for (const match of text.matchAll(DIGITS_THEN_CENTS)) add(CENT, match[1]);
  for (const price of wordPricesIn(text)) amounts.push(price.amount);
  return amounts;
}

/** What a fact's value must hold for a literal to be held: a run of digits, a date word, or an amount of money. */
interface Atom {
  readonly kind: "digits" | "word" | "amount";
  readonly text: string;
}

/** One literal value in words: its kind and the atoms a fact must hold. */
interface Literal {
  readonly start: number;
  readonly end: number;
  readonly kind: LiteralKind;
  readonly atoms: readonly Atom[];
}

/**
 * The literal values in words outside slots: prices in digits and in words, dates and times, date words, and any other
 * digits. A literal's digits are the whole runs of digits of the words it touches, never part of one ("10/255" holds 10
 * and 255), and a run no price or date touches is a number of its own, so every run of digits is an atom of some
 * literal: the runs K-03 v1.1's numbersHeldByFacts reads, each held or refused as that rule holds it. A price in words
 * holds no digit; its atom is its amount.
 */
function literalsIn(words: string): Literal[] {
  const runs = found(DIGITS, words);
  const runsTouching = (match: Found): Atom[] =>
    runs.filter((run) => overlaps(run, match)).map((run): Atom => ({ kind: "digits", text: run.text }));
  const literals: Literal[] = [];
  const take = (patterns: readonly RegExp[], kind: LiteralKind, atomsOf: (match: Found) => Atom[]): void => {
    for (const pattern of patterns)
      for (const match of found(pattern, words))
        literals.push({ start: match.start, end: match.end, kind, atoms: atomsOf(match) });
  };
  take(PRICES, "price", runsTouching);
  for (const price of wordPricesIn(words))
    literals.push({
      start: price.start,
      end: price.end,
      kind: "price",
      atoms: [{ kind: "amount", text: price.amount }],
    });
  take(DATES_WITH_DIGITS, "date", runsTouching);
  take(DATE_WORDS, "date", (match) => [{ kind: "word", text: match.text.toLowerCase() }]);
  for (const run of runs) {
    if (!literals.some((literal) => overlaps(run, literal)))
      literals.push({
        start: run.start,
        end: run.end,
        kind: "number",
        atoms: [{ kind: "digits", text: run.text }],
      });
  }
  return literals;
}

/**
 * Each words field of the plan (its lines' text and its question's) that types a number, a date or a price outside its
 * slots that no fact of the input holds: one problem per field and kind. A digit run is held when a fact's value, a
 * slot fact's or a term fact's, has the same digit run; a date word when a fact's value has that word; a price in words
 * when a fact's value states the same amount of money, in digits or in words. A term fact holds a literal only by its
 * own words, never by its source. Words inside a slot, its example words included, are code's to replace, so they are
 * never literals. Words are read in one Unicode form (NFC), so an accent typed as its own mark reads the same.
 */
export function literalProblems(plan: MessagePlan, input: ComposeInput): ComposeProblem[] {
  const values = input.facts.map((fact) => fact.value.normalize("NFC"));
  const held: Readonly<Record<Atom["kind"], ReadonlySet<string>>> = {
    digits: new Set(values.flatMap(digitRuns)),
    word: new Set(values.flatMap(wordsIn)),
    amount: new Set(values.flatMap(amountsIn)),
  };
  const isHeld = (atom: Atom): boolean => held[atom.kind].has(atom.text);
  const fields: [string, string][] = plan.lines.map((line, k): [string, string] => [
    `lines[${String(k)}].text`,
    line.text,
  ]);
  if (plan.question !== null) fields.push(["question.text", plan.question.text]);

  const problems: ComposeProblem[] = [];
  for (const [at, words] of fields) {
    for (const literal of literalsIn(words.normalize("NFC").replace(SLOT_ANYWHERE, " "))) {
      if (literal.atoms.every(isHeld)) continue;
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
