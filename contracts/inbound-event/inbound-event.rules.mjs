// K-06's named rule (T-015): what one JSON Schema cannot state about an inbound event. `npm run contracts:check` runs
// the rule a fixtures/index.json entry names ("rule") on a fixture that has already passed the schema
// (contracts/scripts/check-fixtures.mjs). At runtime the gateway's scrub (C-044, C-045) makes it hold before any write
// (arch 02 line 109); this file is its statement in the contract. README "Named rule".
//
// A rule takes one event and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes this one.

/** The tag a card number is swapped for (README default 1; arch 02 line 109 names "a tag", not its words). */
export const CARD_TAG = "[card number]";

/** The tag a Social Security number is swapped for (README default 1). */
export const SSN_TAG = "[SSN]";

/** A run of digits, single spaces or dashes allowed between them, as card numbers are typed. */
const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

/** A Social Security number as typed with its separators: 123-45-6789 or 123 45 6789 (README default 1). */
const SSN_FORM = /(?<![\d-])\d{3}([- ])\d{2}\1\d{4}(?![\d-])/;

/** The Luhn check over a string of digits (arch 02 line 109: "13 to 19 digits, Luhn"). */
export function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let k = digits.length - 1; k >= 0; k -= 1) {
    let d = Number(digits[k]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The card numbers left in some words: each run of 13 to 19 digits that passes the Luhn check. */
export function cardNumbersIn(words) {
  const found = [];
  for (const match of words.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) found.push(match[0]);
  }
  return found;
}

/** Whether some words still hold a Social Security number in a form README default 1 names. */
export function hasSsn(words) {
  return SSN_FORM.test(words);
}

/**
 * scrubbed: the body and an email's subject hold no card number (13 to 19 digits that pass the Luhn check) and no
 * Social Security number; the gateway swapped each for its tag before any write. Sources: arch 02 line 109 ("Before
 * any write it swaps card numbers (13 to 19 digits, Luhn) and Social Security numbers for a tag"); arch 10 line 516
 * ("Cards and SSNs scrubbed at the edge"); 02-contracts K-06 (refuse-unscrubbed-card).
 */
export function scrubbed(event) {
  const problems = [];
  const fields = [
    ["body", event.body],
    ["email.subject", event.email?.subject],
  ];
  for (const [where, words] of fields) {
    if (typeof words !== "string") continue;
    for (const card of cardNumbersIn(words)) {
      problems.push(`${where}: holds a card number (${card.length} characters); it must be ${CARD_TAG}`);
    }
    if (hasSsn(words)) problems.push(`${where}: holds a Social Security number; it must be ${SSN_TAG}`);
  }
  return problems;
}

/** The named rules fixtures/index.json may name. */
export const rules = Object.freeze({ scrubbed });
