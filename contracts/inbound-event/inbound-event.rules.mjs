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

// ---------------------------------------------------------------------------------------------------------------------
// K-06 v1.1 (T-1069): the wider rule `scrubbedV1dot1`, added beside `scrubbed`, which stays exactly as it was. It
// refuses everything `scrubbed` refuses, and also (README "Named rule (v1.1)"):
//   1. a card number inside a longer digit run: any 13 to 19 digit window of the run that passes the Luhn check, so
//      "4111111111111111 123" (a card, then its security code) is caught although the 19-digit run fails the check;
//   2. any run of spaces or dashes between the groups, not just one;
//   3. digits of any script, read as the digits they stand for before matching (fullwidth, Arabic-Indic, ...).
// Its Social Security number takes the same three widenings to its v1 forms; nine bare digits stay unmatched (README
// default 1, kept by T-1069: no source names that form). The name says v1.1 in the letters the fixtures index allows.

/** v1.1: a space or a dash between digits, by Unicode category: any space separator (Zs), a tab, any dash (Pd). */
const SEPARATOR_V1DOT1 = String.raw`[\p{Zs}\t\p{Pd}]`;

/** v1.1: a run of digits with any run of separators between two of them; it runs on words after toAsciiDigits. */
const DIGIT_RUN_V1DOT1 = new RegExp(String.raw`[0-9](?:${SEPARATOR_V1DOT1}*[0-9])*`, "gu");

/** v1.1: three, two and four digits with a run of separators between the groups and no digit on either side. */
const SSN_FORM_V1DOT1 = new RegExp(
  String.raw`(?<![0-9])[0-9]{3}${SEPARATOR_V1DOT1}+[0-9]{2}${SEPARATOR_V1DOT1}+[0-9]{4}(?![0-9])`,
  "u",
);

/** A decimal digit of any script (Unicode Nd), and one that is not ASCII. */
const ANY_DIGIT = /\p{Nd}/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;

/**
 * The value of one decimal digit of any script. Unicode encodes every set of decimal digits (Nd) as ten consecutive
 * code points from 0 to 9, so a digit's value is its distance from the start of its run of Nd code points, modulo ten
 * (two sets side by side, as the mathematical digits are, still start at a multiple of ten).
 */
function digitValue(digit) {
  const point = digit.codePointAt(0) ?? 0;
  let start = point;
  while (start > 0 && ANY_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (point - start) % 10;
}

/** The words with every non-ASCII decimal digit read as the ASCII digit it stands for (v1.1 widening 3). */
export function toAsciiDigits(words) {
  return words.replace(NON_ASCII_DIGIT, (digit) => String(digitValue(digit)));
}

/** Whether a string of digits holds a 13 to 19 digit window that passes the Luhn check (v1.1 widening 1). */
export function holdsCardWindow(digits) {
  for (let start = 0; start + 13 <= digits.length; start += 1) {
    for (let length = 13; length <= 19 && start + length <= digits.length; length += 1) {
      if (passesLuhn(digits.slice(start, start + length))) return true;
    }
  }
  return false;
}

/** v1.1: the digit runs left in some words that hold a card number, each as its count of digits (never the digits). */
export function cardRunsInV1dot1(words) {
  const found = [];
  for (const match of toAsciiDigits(words).matchAll(DIGIT_RUN_V1DOT1)) {
    const digits = match[0].replace(/[^0-9]/g, "");
    if (holdsCardWindow(digits)) found.push(digits.length);
  }
  return found;
}

/** v1.1: whether some words still hold a Social Security number in a form v1.1 names. */
export function hasSsnV1dot1(words) {
  return SSN_FORM_V1DOT1.test(toAsciiDigits(words));
}

/**
 * scrubbedV1dot1 (K-06 v1.1): the body and an email's subject hold no card number and no Social Security number,
 * read the wider way above. Sources: arch 02 line 109 ("Before any write it swaps card numbers (13 to 19 digits, Luhn)
 * and Social Security numbers for a tag"); arch 10 line 516 ("Cards and SSNs scrubbed at the edge"); master S12-30
 * ("Never kept from a text: card numbers, full Social Security numbers") and S13-05; T-242's security review
 * (cards/T-242.md: a whole-run rule misses a card next to other digits).
 */
export function scrubbedV1dot1(event) {
  const problems = [];
  const fields = [
    ["body", event.body],
    ["email.subject", event.email?.subject],
  ];
  for (const [where, words] of fields) {
    if (typeof words !== "string") continue;
    for (const count of cardRunsInV1dot1(words)) {
      problems.push(
        `${where}: holds a card number (a 13 to 19 digit Luhn window in a run of ${String(count)} digits); it must be ${CARD_TAG}`,
      );
    }
    if (hasSsnV1dot1(words)) problems.push(`${where}: holds a Social Security number; it must be ${SSN_TAG}`);
  }
  return problems;
}

/** The named rules fixtures/index.json may name. */
export const rules = Object.freeze({ scrubbed, scrubbedV1dot1 });
