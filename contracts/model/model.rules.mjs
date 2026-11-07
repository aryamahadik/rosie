// K-02's named rules (T-011): what holds across a context and the decide result made from it, which one JSON Schema
// cannot state. `npm run contracts:check` runs the rule a fixtures/index.json entry names ("rule") on a fixture of
// $defs/contextAndDecide that has already passed the schema (contracts/scripts/check-fixtures.mjs). At runtime the gate
// (C-080) and code's quote check (arch 03 line 185) enforce the same rules; this file is their statement in the
// contract, not their implementation. README "Named rules".
//
// Each rule takes { context, decide } and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes these.

/** Choice kinds choose takes: an open question's option, a hub case, a which-booking choice (arch 03 lines 163, 167, 183). */
export const CHOOSE_KINDS = Object.freeze(["option", "hub", "whichBooking"]);

/** Choice kinds enter takes: a door, an any-time row, an entry step meaning search added (arch 03 lines 165, 171, 183, 189). */
export const ENTER_KINDS = Object.freeze(["door", "anytime", "searchEntry"]);

/** Every part of a decide result with where it sits: each read's parts, then the parts handed to the gate. */
function partsOf(decide) {
  const out = [];
  (decide.reads ?? []).forEach((read, r) => {
    (read.output?.parts ?? []).forEach((part, k) =>
      out.push({ where: `reads[${r}].output.parts[${k}]`, part }),
    );
  });
  (decide.parts ?? []).forEach((entry, k) => out.push({ where: `parts[${k}].part`, part: entry.part }));
  return out;
}

/**
 * optionOffered: every choice a part chooses or enters is one the context offers, with the verb its kind takes; choose
 * names the question that choice answers; each field is one the choice carries; ask names only questions an offered
 * choice answers. Sources: arch 06 line 333 ("Search the master. Code hands it the choices"); arch 01 line 69 (the
 * frontier is a closed list); arch 03 line 183 (the verbs); T-360 finding 3 (option ids are checked in code, never an
 * enum in a model-facing schema).
 */
export function optionOffered({ context, decide }) {
  const problems = [];
  const offered = new Map();
  for (const choice of context.choices) {
    if (offered.has(choice.choiceId))
      problems.push(`context: the choice id ${choice.choiceId} appears twice`);
    offered.set(choice.choiceId, choice);
  }
  const questions = new Set(
    context.choices.map((choice) => choice.question).filter((question) => question !== null),
  );
  for (const { where, part } of partsOf(decide)) {
    if (part.verb === "choose" || part.verb === "enter") {
      const choice = offered.get(part.choice);
      if (choice === undefined) {
        problems.push(`${where}: ${part.verb}s ${part.choice}, which the context's choices do not hold`);
        continue;
      }
      const kinds = part.verb === "choose" ? CHOOSE_KINDS : ENTER_KINDS;
      if (!kinds.includes(choice.kind)) {
        problems.push(
          `${where}: ${part.verb} takes ${kinds.join(", ")}, but ${part.choice} is ${choice.kind}`,
        );
      }
      if (part.verb === "choose" && part.question !== choice.question) {
        problems.push(
          `${where}: names the question ${part.question}, but ${part.choice} answers ${String(choice.question)}`,
        );
      }
      const carried = new Set(choice.fields.map((field) => field.name));
      for (const field of part.fields) {
        if (!carried.has(field.name))
          problems.push(`${where}: the field ${field.name} is not one ${part.choice} carries`);
      }
    } else if (part.verb === "ask") {
      for (const question of part.questions) {
        if (!questions.has(question))
          problems.push(`${where}: asks about ${question}, which no offered choice answers`);
      }
    }
  }
  return problems;
}

/**
 * quoteInText: every part's quote, every field's words, and the words of pass_on and redact are found, exactly, in the
 * words of one of the turn's texts. Sources: arch 03 line 185 ("each part is quoted exactly, and code confirms the quote
 * and re-parses every value from its words"); arch 06 line 309 (limit 6).
 */
export function quoteInText({ context, decide }) {
  const problems = [];
  const texts = context.texts.map((text) => text.words);
  const found = (words) => texts.some((text) => text.includes(words));
  for (const { where, part } of partsOf(decide)) {
    if (!found(part.quote)) problems.push(`${where}: the quote "${part.quote}" is not in the turn's texts`);
    for (const field of part.fields ?? []) {
      if (!found(field.words)) {
        problems.push(
          `${where}: the words "${field.words}" of the field ${field.name} are not in the turn's texts`,
        );
      }
    }
    if ((part.verb === "pass_on" || part.verb === "redact") && !found(part.words)) {
      problems.push(`${where}: the words "${part.words}" are not in the turn's texts`);
    }
  }
  return problems;
}

/** The named rules, by the name a fixtures/index.json entry gives in "rule". */
export const rules = Object.freeze({ optionOffered, quoteInText });
