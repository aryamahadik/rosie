// Decide's output, checked by code before any limit runs (T-298; C-080): "each part is quoted exactly, and code confirms
// the quote and re-parses every value from its words" (arch 03 line 185); "Code hands it the choices" (arch 06 line 333).
// The re-parse itself is limit 6's (T-304); here every value must have its source words.
//
// These are K-02 v1's two named rules, optionOffered and quoteInText (contracts/model/model.rules.mjs states them and
// "does not implement them"; K-09 v1 gateAndCommit.request: "its named rules are the gate's"), with the verbs and the
// non-empty words the K-02 schema holds, so a decide output that reaches the gate unvalidated is refused the same way.
// Each part, in order, is checked for its verb, then its quote, then its option, then each value's words; the first
// check a part fails is its problem. The agreed parts (decide.parts) come first, then every read's parts, as the named
// rules check them all.
//
// What comes back names a rule, a part's index, a check and a reason as a label: never a quote's or a value's words,
// which may be a person's own (K-08 v1 README: "never the raw number or words").

import type { Choice, Decided, DecidePart, DecideRefused } from "./types";

/** decide's eight verbs (K-02 v1 `decidePart`; arch 03 line 183). */
export const DECIDE_VERBS = [
  "choose",
  "enter",
  "ask",
  "none_fits",
  "pass_on",
  "hand_off",
  "redact",
  "no_op",
] as const;

/** Choice kinds choose takes: an open question's option, a hub case, a which-booking choice (K-02 v1 named rules). */
export const CHOOSE_KINDS: readonly Choice["kind"][] = ["option", "hub", "whichBooking"];

/** Choice kinds enter takes: a door, an any-time row, an entry step meaning search added (K-02 v1 named rules). */
export const ENTER_KINDS: readonly Choice["kind"][] = ["door", "anytime", "searchEntry"];

/** The checks, in the order each part takes them. */
export type DecideCheck = "verb" | "quote" | "option" | "valueWords";

/** Why a check failed, as a label (never the words it looked at). */
export type DecideWhy =
  | "unknownVerb"
  | "noQuote"
  | "quoteNotInText"
  | "wordsNotInText"
  | "notOffered"
  | "offeredTwice"
  | "wrongKind"
  | "wrongQuestion"
  | "questionNotOpen"
  | "fieldNotCarried"
  | "askNotOffered"
  | "noWords"
  | "valueNotInText";

/** One part's first failing check. */
export interface DecideProblem {
  /** Where the part sits: the parts handed to the gate (decide.parts), or one read's output. */
  readonly from: "decide" | "read";
  /** For a read's part, the read's index in decide.reads; null for decide.parts. */
  readonly read: number | null;
  /** The part's index in its list: the same part of the text in decide.parts and in each read. */
  readonly part: number;
  readonly check: DecideCheck;
  readonly why: DecideWhy;
}

/** The K-02 v1 named rule each check stands for (K-09 v1 `decideRefused.rule`). */
export const RULE_OF_CHECK: Readonly<Record<DecideCheck, DecideRefused["rule"]>> = {
  // A verb none of the eight can take no offered choice (K-02 README: optionOffered also refuses "a verb that does not
  // fit the choice's kind").
  verb: "optionOffered",
  quote: "quoteInText",
  option: "optionOffered",
  // A value whose words are empty, or not in the turn's texts, has no source words there (quoteInText: "also a field's
  // words ... not found there").
  valueWords: "quoteInText",
};

const NOT_SPACE = /\S/u;

/** What the checks read of the context, built once per turn. */
interface Offered {
  /** Each text's words after the edge scrub (K-02 v1 `text.words`). */
  readonly texts: readonly string[];
  /** Each offered choice by id, and how many times the id appears. */
  readonly choices: ReadonlyMap<string, { readonly choice: Choice; readonly count: number }>;
  /** The open questions sent to this handle (K-02 v1 `context.openQuestions`). */
  readonly openQuestions: ReadonlySet<string>;
  /** Every question an offered choice answers (K-02 v1 `choice.question`). */
  readonly questions: ReadonlySet<string>;
}

function offeredIn(decided: Decided): Offered {
  const { context } = decided;
  const choices = new Map<string, { choice: Choice; count: number }>();
  for (const choice of context.choices) {
    const seen = choices.get(choice.choiceId);
    choices.set(choice.choiceId, { choice: seen?.choice ?? choice, count: (seen?.count ?? 0) + 1 });
  }
  const questions = new Set<string>();
  for (const choice of context.choices) if (choice.question !== null) questions.add(choice.question);
  return {
    texts: context.texts.map((text) => text.words),
    choices,
    openQuestions: new Set(context.openQuestions.map((question) => question.openQuestionId)),
    questions,
  };
}

/** Words that are there and found, exactly, in the words of one of the turn's texts (K-02 v1 quoteInText). */
function inText(offered: Offered, words: string): boolean {
  return NOT_SPACE.test(words) && offered.texts.some((text) => text.includes(words));
}

type Failed = Pick<DecideProblem, "check" | "why">;

function quoteProblem(offered: Offered, part: DecidePart): Failed | null {
  if (!NOT_SPACE.test(part.quote)) return { check: "quote", why: "noQuote" };
  if (!inText(offered, part.quote)) return { check: "quote", why: "quoteNotInText" };
  if ((part.verb === "pass_on" || part.verb === "redact") && !inText(offered, part.words)) {
    return { check: "quote", why: "wordsNotInText" };
  }
  return null;
}

function optionProblem(offered: Offered, part: DecidePart): Failed | null {
  if (part.verb === "ask") {
    const askable = part.questions.every((question) => offered.questions.has(question));
    return askable ? null : { check: "option", why: "askNotOffered" };
  }
  if (part.verb !== "choose" && part.verb !== "enter") return null;
  const found = offered.choices.get(part.choice);
  if (found === undefined) return { check: "option", why: "notOffered" };
  if (found.count > 1) return { check: "option", why: "offeredTwice" };
  const { choice } = found;
  const kinds = part.verb === "choose" ? CHOOSE_KINDS : ENTER_KINDS;
  if (!kinds.includes(choice.kind)) return { check: "option", why: "wrongKind" };
  if (part.verb === "choose" && part.question !== choice.question) {
    return { check: "option", why: "wrongQuestion" };
  }
  // An open question's option is offered only while that question is open to this handle ("its options are choices of
  // kind option that name it": K-02 v1 `openQuestion`).
  if (choice.kind === "option" && (choice.question === null || !offered.openQuestions.has(choice.question))) {
    return { check: "option", why: "questionNotOpen" };
  }
  const carried = new Set(choice.fields.map((field) => field.name));
  if (!part.fields.every((field) => carried.has(field.name))) {
    return { check: "option", why: "fieldNotCarried" };
  }
  return null;
}

function valueWordsProblem(offered: Offered, part: DecidePart): Failed | null {
  if (part.verb !== "choose" && part.verb !== "enter") return null;
  for (const field of part.fields) {
    if (!NOT_SPACE.test(field.words)) return { check: "valueWords", why: "noWords" };
    if (!inText(offered, field.words)) return { check: "valueWords", why: "valueNotInText" };
  }
  return null;
}

/** One part's first failing check, in order: its verb, its quote, its option, each value's words. */
function problemOf(offered: Offered, part: DecidePart): Failed | null {
  if (!(DECIDE_VERBS as readonly string[]).includes(part.verb)) return { check: "verb", why: "unknownVerb" };
  return quoteProblem(offered, part) ?? optionProblem(offered, part) ?? valueWordsProblem(offered, part);
}

/** Every part's first failing check: the agreed parts first, then each read's parts. Empty when decide's output holds. */
export function findDecideProblems(decided: Decided): DecideProblem[] {
  const offered = offeredIn(decided);
  const problems: DecideProblem[] = [];
  decided.decide.parts.forEach((entry, part) => {
    const failed = problemOf(offered, entry.part);
    if (failed !== null) problems.push({ from: "decide", read: null, part, ...failed });
  });
  decided.decide.reads.forEach((read, index) => {
    read.output.parts.forEach((entry, part) => {
      const failed = problemOf(offered, entry);
      if (failed !== null) problems.push({ from: "read", read: index, part, ...failed });
    });
  });
  return problems;
}

/**
 * Decide's output checked before any limit runs: null when it holds, else K-09 v1's `decideRefused` with the rule the
 * first problem breaks and every part that breaks the same rule (by its index), so nothing is written and the AI layer
 * treats it as a failed read (arch 06 line 293).
 */
export function checkDecideOutput(decided: Decided): DecideRefused | null {
  const problems = findDecideProblems(decided);
  const [first] = problems;
  if (first === undefined) return null;
  const rule = RULE_OF_CHECK[first.check];
  const parts = [
    ...new Set(
      problems.filter((problem) => RULE_OF_CHECK[problem.check] === rule).map((problem) => problem.part),
    ),
  ].sort((a, b) => a - b);
  const [lowest, ...rest] = parts;
  return { error: "decideRefused", rule, parts: [lowest ?? first.part, ...rest] };
}
