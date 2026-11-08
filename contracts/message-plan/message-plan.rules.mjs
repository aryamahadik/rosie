// K-03's named rule (v1.1, T-1104): what one JSON Schema cannot state about a composer input and the plan made from it.
// `npm run contracts:check` runs the rule a fixtures/index.json entry names ("rule") on a fixture of
// $defs/inputAndPlan that has already passed the schema (contracts/scripts/check-fixtures.mjs). At run time the
// composer's literal check (C-118) and the message checks' Values check (C-092; arch 07 line 409) hold the whole plan
// rule; this file states its number part in the contract and is not their implementation. README "Named rule (v1.1)".
//
// A rule takes { input, plan } and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes this one.

/** A slot as the plan writes it: {{name}}, {{name:example}} or {{name:example|other words}} (K-03 slottedText). */
const SLOT = /\{\{[^{}]*\}\}/g;

/** A number as words state it: a run of the digits 0 to 9 (an amount, a time, a date, a duration, a count, a code). */
const DIGIT_RUN = /[0-9]+/g;

/** The runs of digits in some words, in order. */
export function numbersIn(words) {
  return words.match(DIGIT_RUN) ?? [];
}

/**
 * The words a plan states, each with where it sits: every line's text, then the question's, with each slot taken out.
 * A slot's example words are illustrations the slot filler replaces (MC C6; S13-28 rule 51: "never the example"), so
 * they are never the composer's; a slot leaves a space, so no run of digits joins across it.
 */
export function statedWords(plan) {
  const out = plan.lines.map((line, k) => ({
    where: `plan.lines[${k}].text`,
    words: line.text.replace(SLOT, " "),
  }));
  if (plan.question !== null) {
    out.push({ where: "plan.question.text", words: plan.question.text.replace(SLOT, " ") });
  }
  return out;
}

/**
 * numbersHeldByFacts: every number the plan states outside its slots is held by a fact of the input, that is, some
 * fact's value (a slot fact's or a term fact's) holds the same run of digits. Sources: arch 07 line 403 ("Only <facts>
 * may be stated"); arch 07 line 409 (each number, time, date and price matches a code-supplied fact); CQ-82 and DL-145
 * (Rosie's own fixed terms that a step's card states reach the composer as term facts, so a plan may state them, and no
 * list of allowed words exists); T-373's reading of "held" (a fact's value has the same digit run).
 */
export function numbersHeldByFacts({ input, plan }) {
  const held = new Set(input.facts.flatMap((fact) => numbersIn(fact.value)));
  const problems = [];
  for (const { where, words } of statedWords(plan)) {
    for (const number of numbersIn(words)) {
      if (!held.has(number)) {
        problems.push(`${where}: states the number ${number}, which no fact of the input holds`);
      }
    }
  }
  return problems;
}

/** The named rules fixtures/index.json may name. */
export const rules = Object.freeze({ numbersHeldByFacts });
