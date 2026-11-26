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

// ---- v1.4 (T-1546): typed fields for S1-12, S1-13 and S1-21 (README "v1.4") -----------------------------------------

/**
 * The typed fields' families (README v1.4 defaults 25 to 27): the step each serves, how many groups a part may hold,
 * and each group's fields in the order a part gives them. A group's first field is its key.
 */
export const TYPED_FAMILIES = Object.freeze({
  line: Object.freeze({
    step: "S1-12",
    cap: 20,
    fields: Object.freeze(["service", "price_kind", "amount", "length"]),
  }),
  edit: Object.freeze({
    step: "S1-13",
    cap: 10,
    fields: Object.freeze(["letter", "place", "before", "amount", "after"]),
  }),
  rule: Object.freeze({ step: "S1-21", cap: 5, fields: Object.freeze(["row", "value"]) }),
});

const TYPED_NAME = /^(line|edit|rule)\.([1-9][0-9]?)\.([a-z_]+)$/;

/** A typed field's family, group number and field, or undefined for a name that is none of v1.4's. */
export function typedFieldOf(name) {
  const match = TYPED_NAME.exec(name);
  if (match === null) return undefined;
  const family = TYPED_FAMILIES[match[1]];
  const group = Number(match[2]);
  if (group > family.cap || !family.fields.includes(match[3])) return undefined;
  return { family: match[1], group, field: match[3] };
}

/**
 * The cents a price's words write: the first number in them (1,200 and 12.50 included), or 0 for words that call it
 * free with no number (S1-12: "A service the list calls free is set as free"); undefined when they write neither. The
 * plain case of limit 6's money re-parse (actions/src/values/money.ts), which stays the full one at runtime.
 */
export function centsInWords(words) {
  const number = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(words);
  if (number !== null) {
    const whole = Number(number[1].replaceAll(",", ""));
    const cents = number[2] === undefined ? 0 : Number(number[2].padEnd(2, "0"));
    return whole * 100 + cents;
  }
  return /\bfree\b/i.test(words) ? 0 : undefined;
}

/**
 * typedValueInWords (v1.4): in every choose or enter part, each typed text field's value is its words, character for
 * character, and each typed amount is the number its words write, in cents. Sources: arch 03 line 185 ("code ... re-parses
 * every value from its words"); arch 06 line 309 (limit 6); S1-12 ("Never: make up a price"); README v1.4 default 26.
 */
export function typedValueInWords({ decide }) {
  const problems = [];
  for (const { where, part } of partsOf(decide)) {
    if (part.verb !== "choose" && part.verb !== "enter") continue;
    for (const field of part.fields) {
      const typed = typedFieldOf(field.name);
      if (typed === undefined) continue;
      if (typed.field === "amount") {
        const cents = centsInWords(field.words);
        if (cents === undefined) {
          problems.push(`${where}: the words "${field.words}" of the field ${field.name} write no amount`);
        } else if (field.value?.cents !== cents) {
          problems.push(
            `${where}: the field ${field.name} is ${String(field.value?.cents)} cents, but its words "${field.words}" write ${cents}`,
          );
        }
      } else if (field.value !== field.words) {
        problems.push(
          `${where}: the value of the field ${field.name} is not its words "${field.words}", character for character`,
        );
      }
    }
  }
  return problems;
}

/**
 * letterOnCard (v1.4): every edit's letter is one S1-13's card shows, which the context gives as the fact card.<letter>
 * (README v1.4 default 28). Sources: S1-13 line 337 ("Send only what's different, by letter"; the card's "A) Haircut ...
 * I) Style consult"); arch 06 line 333 (code hands decide what it may choose).
 */
export function letterOnCard({ context, decide }) {
  const problems = [];
  const letters = new Set(
    context.facts
      .map((fact) => /^card\.([a-z])$/.exec(fact.name))
      .filter((match) => match !== null)
      .map((match) => match[1]),
  );
  for (const { where, part } of partsOf(decide)) {
    if (part.verb !== "choose" && part.verb !== "enter") continue;
    for (const field of part.fields) {
      if (typedFieldOf(field.name)?.field !== "letter") continue;
      const letter = String(field.value).toLowerCase();
      if (!letters.has(letter)) {
        problems.push(
          `${where}: the letter ${String(field.value)} of the field ${field.name} is not on the card (no fact card.${letter})`,
        );
      }
    }
  }
  return problems;
}

/** The named rules, by the name a fixtures/index.json entry gives in "rule". */
export const rules = Object.freeze({ optionOffered, quoteInText, typedValueInWords, letterOnCard });
