// The message checks (C-092): the checks on every message, run on its final parts after code has inserted the options
// and fixed lines and filled the slots, before anything is sent (arch 07 lines 405 to 417; arch 02 line 123; D-017).
// Each check returns the faults it finds, in the words the rewrite is told; none means it passed. The first four block
// the message and take step 7's path; Shape, Length and reading, and Format never block (arch 07 line 417). What
// happens next (one rewrite, the fallback, the passed-on line) is the rewrite and fallback path's (C-093, T-313).

import { LIMITS, grade, ideasIn, sentencesOf, wordsOf } from "./grade";
import { isOptOutOnly } from "./opt-out";
import {
  blankOut,
  fixedLineWords,
  insertedWords,
  markOut,
  optionsOf,
  ownWords,
  quotesOf,
  sendTexts,
  valuesOf,
  withoutInserted,
  wordsText,
} from "./reading";
import { statedBy, unstatedValues } from "./values";
import type {
  CheckContext,
  CheckName,
  CheckOutcome,
  FinalParts,
  Format,
  MessageCheckResult,
  SendKind,
} from "./types";

/** Each check, in K-03's order (K-03 `checkName`). */
export const CHECK_NAMES: readonly CheckName[] = [
  "fixedLines",
  "values",
  "oneQuestion",
  "neverInMessage",
  "shape",
  "lengthAndReading",
  "format",
];

/** The checks whose miss blocks the message and takes step 7's path (arch 07 line 417). */
export const BLOCKING_CHECKS: ReadonlySet<CheckName> = new Set<CheckName>([
  "fixedLines",
  "values",
  "oneQuestion",
  "neverInMessage",
]);

/** A check: the faults it finds in the final parts, each a sentence the rewrite is told; none when it passes. */
export type Check = (parts: FinalParts, context: CheckContext) => string[];

const unique = (faults: readonly string[]): string[] => [...new Set(faults)];

// ---------------------------------------------------------------------------------------------------------------
// Fixed lines: each matches its source word for word (arch 07 line 361), poll options included.

/** Each fixed line code added, the typed options and each poll option are their source's words, word for word. */
export const fixedLinesFaults: Check = (parts, context) => {
  const words = wordsText(parts);
  const faults: string[] = [];
  for (const id of parts.fixedLines) {
    const source = fixedLineWords(id, context);
    if ("fault" in source) faults.push(source.fault);
    else if (!words.includes(source.words)) {
      faults.push(`The fixed line ${id} is not in the text word for word: "${source.words}"`);
    }
  }
  if (context.typedOptions !== null && !words.includes(context.typedOptions)) {
    faults.push(`The typed options are not in the text word for word: "${context.typedOptions}"`);
  }
  for (const option of optionsOf(parts)) {
    const step = context.options.find((candidate) => candidate.id === option.id);
    if (step === undefined) faults.push(`The option ${option.id} is not one of the step's options.`);
    else if (step.label !== option.label) {
      faults.push(`The option '${option.label}' is not the step's words, '${step.label}'.`);
    }
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// Values (arch 07 line 409; S13-28 rule 51): each value matches a code-supplied fact; no "{{", "null" or "undefined".

/** Every value a code-supplied fact, every slot filled, every link a link slot's value. */
export const valuesFaults: Check = (parts, context) => {
  const faults: string[] = [];
  const texts = sendTexts(parts);
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([^{}:|\s]*)/g)) {
      const name = match[1] ?? "";
      faults.push(
        name === ""
          ? "A slot is left unfilled, so '{{' is in the text."
          : `The slot {{${name}}} has no value, so '{{' is left in the text.`,
      );
    }
    for (const match of text.matchAll(/\b(?:null|undefined)\b/g)) {
      faults.push(`The text says "${match[0]}" where code left a value empty.`);
    }
  }
  const values = valuesOf(parts);
  for (const send of parts.sends) {
    if (send.link !== null && !values.includes(send.link)) {
      faults.push(`The card's link ${send.link} is not a code-supplied fact; give the link as its slot.`);
    }
  }
  const stated = statedBy(parts, context);
  const inserted = insertedWords(parts, context);
  for (const text of texts) {
    // Fixed lines and typed options out, then every slot value (a quote is one): what is left is the model's.
    const own = markOut(withoutInserted(text, inserted), values, " ");
    faults.push(...unstatedValues(own, parts, stated));
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// One question (S13-28 rule 50; arch 07 line 411): at most one question per text.

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** At most one question mark in the message's words, outside a quote and the typed options. */
export const oneQuestionFaults: Check = (parts, context) => {
  const typed = context.typedOptions === null ? [] : [context.typedOptions];
  const quotes = quotesOf(parts);
  const asked = sendTexts(parts)
    .map((text) => blankOut(withoutInserted(text, typed), quotes))
    .join("\n")
    .match(/\?+/g)?.length;
  if (asked === undefined || asked <= 1) return [];
  const count = COUNT_WORDS[asked] ?? String(asked);
  return [`The text asks ${count} questions; ask at most one question per text.`];
};

// ---------------------------------------------------------------------------------------------------------------
// Never in a message (arch 07 line 415; S13-32; RULES 4.4; PLAIN-WORDS §2 and §3).

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u;
const MARKDOWN = /\*\*|`/;
const LEADING_MARK = /^[ \t]*(?:#|[•◦▪‣]|[-*+–—](?=\s))/m;
/** A step id such as A4-12, S1-02 or S11-102: a flow letter, a section, a dash and the step (SPEC-master section 4). */
const STEP_ID = /\b[SAB]\d{1,2}-\d{2,3}\b/;
/** Words that never go in a message (arch 07 line 415; RULES 4.4: no offers and no "book again"). */
const NEVER_SAID = [
  /\bthe user\b/i,
  /\bthe system prompt\b/i,
  /\bbook again\b/i,
  /\bcoupons?\b/i,
  /%\s?off\b/i,
];

/** Outside a quote: no emoji, markdown, leading # or bullet, step id or word that never goes in; no opt-out-only option. */
export const neverInMessageFaults: Check = (parts, context) => {
  const quotes = quotesOf(parts);
  const options = optionsOf(parts);
  const texts = [
    ...sendTexts(parts).map((text) => blankOut(text, quotes)),
    ...options.map((option) => option.label),
  ];
  const faults: string[] = [];
  for (const text of texts) {
    if (EMOJI.test(text)) faults.push("The text holds an emoji; write it without one.");
    if (MARKDOWN.test(text)) faults.push("The text holds markdown (** or a backtick); write plain words.");
    if (LEADING_MARK.test(text)) faults.push("A line starts with # or a bullet; write plain lines.");
    const step = STEP_ID.exec(text);
    if (step !== null) faults.push(`The text names the step id ${step[0]}; never name a step.`);
    for (const pattern of NEVER_SAID) {
      const said = pattern.exec(text);
      if (said !== null) faults.push(`The text says "${said[0]}", which never goes in a message.`);
    }
  }
  for (const option of options) {
    if (isOptOutOnly(option.label, context.lists.keywords.optOut)) {
      faults.push(
        `The option '${option.label}' is only an opt-out word; name what it does, such as 'Cancel visit'.`,
      );
    }
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// Shape (arch 07 line 353): one first line, up to four fact lines, one action line, then the question; at most 5
// buttons of at most 24 characters. Fixed lines sit outside it (arch 07 line 361).

/** The lines a message holds before its question: the first line, four fact lines and the action line. */
export const MAX_LINES = 6;
/** Buttons, and the characters of each (arch 07 line 353; msgtext.js lines 92 and 93). */
export const MAX_OPTIONS = 5;
export const MAX_OPTION_CHARACTERS = 24;

/** No more lines than the shape holds, and no more or longer options than a phone shows. */
export const shapeFaults: Check = (parts, context) => {
  const faults: string[] = [];
  const lines = withoutInserted(wordsText(parts), insertedWords(parts, context))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const body = lines.at(-1)?.endsWith("?") === true ? lines.slice(0, -1) : lines;
  if (body.length > MAX_LINES) {
    faults.push(
      `The message has ${String(body.length)} lines before its question, past four fact lines; write one first line, at most four fact lines and one action line.`,
    );
  }
  for (const send of parts.sends) {
    if (send.options.length > MAX_OPTIONS) {
      faults.push(
        `The ${send.kind} has ${String(send.options.length)} options; give at most ${String(MAX_OPTIONS)}.`,
      );
    }
  }
  for (const option of optionsOf(parts)) {
    if (option.label.length > MAX_OPTION_CHARACTERS) {
      faults.push(`The option '${option.label}' is over ${String(MAX_OPTION_CHARACTERS)} characters.`);
    }
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// Length and reading (arch 07 line 413; PLAIN-WORDS §2; SPEC-master section 4), on the model's own words only: not
// fixed lines, options, slot values, links or quotes (arch 07 line 417).

/** Whether the message has an element, a poll or a card, which lowers the length limit (lib.js line 527). */
const hasElement = (parts: FinalParts): boolean =>
  parts.sends.some((send) => send.kind === "poll" || send.kind === "linkCard");

/** Sentences of at most 22 words and 4 commas, semicolons or brackets; at most 260 or 320 characters; grade 9.5. */
export const lengthAndReadingFaults: Check = (parts, context) => {
  const faults: string[] = [];
  const own = ownWords(parts, context, "$");
  for (const sentence of sentencesOf(own)) {
    const words = wordsOf(sentence);
    const opening = words.slice(0, 4).join(" ");
    if (words.length > LIMITS.sentenceWords) {
      faults.push(
        `The sentence "${opening} ..." has ${String(words.length)} words; keep each sentence to ${String(LIMITS.sentenceWords)} words or fewer.`,
      );
    }
    const ideas = ideasIn(sentence);
    if (ideas > LIMITS.ideas) {
      faults.push(
        `The sentence "${opening} ..." has ${String(ideas)} commas, semicolons or brackets; keep it to ${String(LIMITS.ideas)}.`,
      );
    }
  }
  const characters = ownWords(parts, context, "").replace(/\s+/g, " ").trim().length;
  const limit = hasElement(parts) ? LIMITS.withElement : LIMITS.plain;
  if (characters > limit) {
    faults.push(
      `The message's own words run ${String(characters)} characters; keep them to ${String(limit)}${hasElement(parts) ? " with a poll or card" : ""}.`,
    );
  }
  if (context.language === "en") {
    const level = grade(own);
    if (level !== null && level > LIMITS.grade) {
      faults.push(
        `The words read at grade ${level.toFixed(1)}; use shorter words and sentences, to grade ${String(LIMITS.grade)} or lower.`,
      );
    }
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// Format (arch 07 lines 365, 367, 391): only formats this phone allows now, in at most two sends.

const FORMAT_OF_SEND: Readonly<Record<SendKind, Format>> = {
  words: "text",
  poll: "poll",
  linkCard: "linkCard",
  tapback: "tapback",
};
const FORMAT_WORDS: Readonly<Record<Format, string>> = {
  text: "text",
  poll: "poll",
  linkCard: "link card",
  calendarFile: "calendar file",
  tapback: "tapback",
};

/** The formats the final parts use: each send's, and a calendar file the words carry (arch 07 lines 367, 383). */
export function formatsOf(parts: FinalParts): Format[] {
  const used = new Set<Format>();
  for (const send of parts.sends) {
    used.add(FORMAT_OF_SEND[send.kind]);
    if (send.calendarFile !== "none") used.add("calendarFile");
  }
  return [...used];
}

/** Each format allowed here; the words, then one poll or card; a tapback alone; a poll of 2 to 5 options. */
export const formatFaults: Check = (parts, context) => {
  const faults: string[] = [];
  for (const format of formatsOf(parts)) {
    if (!context.allowedFormats.includes(format)) {
      faults.push(
        `A ${FORMAT_WORDS[format]} is not allowed on this phone now, so the message goes as text alone.`,
      );
    }
  }
  const kinds = parts.sends.map((send) => send.kind);
  if (kinds.includes("tapback") && kinds.length > 1) {
    faults.push("A tapback goes alone, never with words, a poll or a card.");
  } else if (
    kinds.length > 2 ||
    (kinds.length === 2 && (kinds[0] !== "words" || (kinds[1] !== "poll" && kinds[1] !== "linkCard")))
  ) {
    faults.push("A message goes as the words, then at most one poll or card.");
  }
  for (const send of parts.sends) {
    if (send.kind === "poll" && (send.options.length < 2 || send.options.length > MAX_OPTIONS)) {
      faults.push(`A poll carries 2 to 5 options, not ${String(send.options.length)}.`);
    }
  }
  return unique(faults);
};

// ---------------------------------------------------------------------------------------------------------------
// All seven

/** Each check by its name. */
export const CHECKS: Readonly<Record<CheckName, Check>> = {
  fixedLines: fixedLinesFaults,
  values: valuesFaults,
  oneQuestion: oneQuestionFaults,
  neverInMessage: neverInMessageFaults,
  shape: shapeFaults,
  lengthAndReading: lengthAndReadingFaults,
  format: formatFaults,
};

/** One check's result (K-03 `checkOutcome`): the faults as one detail, or null when it passed. */
export function checkOutcome(check: CheckName, faults: readonly string[]): CheckOutcome {
  return { check, passed: faults.length === 0, detail: faults.length === 0 ? null : faults.join(" ") };
}

/** Runs every message check on one attempt's final parts: each check once, in K-03's order. */
export function runMessageChecks(parts: FinalParts, context: CheckContext): MessageCheckResult {
  const checks = CHECK_NAMES.map((name) => checkOutcome(name, CHECKS[name](parts, context)));
  return {
    checks,
    passed: checks.every((check) => check.passed),
    blocked: checks.some((check) => !check.passed && BLOCKING_CHECKS.has(check.check)),
  };
}
