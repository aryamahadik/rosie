// The card number and Social Security number scrub (T-242, C-045). The gateway (C-044) runs it on every inbound body
// and on an email's subject before any write: arch 02 line 109 ("Before any write it swaps card numbers (13 to 19
// digits, Luhn) and Social Security numbers for a tag"); arch 10 line 516 ("Cards and SSNs scrubbed at the edge");
// RULES 4.5. Pure: no clock, no I/O, no state, the same text in gives the same text out.
//
// What counts as a number is exactly what K-06 v1's named rule `scrubbed` refuses (contracts/inbound-event/
// inbound-event.rules.mjs), so the output of this scrub passes that rule for any input; the tests run both over every
// K-06 fixture and over random text. The tags and the forms are K-06's defaults (its README, "Defaults used (T-015)",
// item 1): a card number becomes "[card number]", a Social Security number "[SSN]".

/** The tag a card number is swapped for: K-06's CARD_TAG (a test holds the two equal). */
export const CARD_TAG = "[card number]";

/** The tag a Social Security number is swapped for: K-06's SSN_TAG (a test holds the two equal). */
export const SSN_TAG = "[SSN]";

/** A run of digits, with one space or dash at most between two digits, as card numbers are typed. */
const DIGIT_RUN = /\d(?:[ -]?\d)*/g;

/** 123-45-6789 or 123 45 6789: the same separator both times, standing alone (not inside a longer digit or dash run). */
const SSN_FORM = /(?<![\d-])\d{3}([- ])\d{2}\1\d{4}(?![\d-])/g;

const MIN_CARD_DIGITS = 13;
const MAX_CARD_DIGITS = 19;

/** What the scrub gives back: the words with each number swapped for its tag, and how many of each it swapped. */
export interface ScrubResult {
  readonly text: string;
  readonly cards: number;
  readonly ssns: number;
}

/** The Luhn check over a string of digits only. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let k = digits.length - 1; k >= 0; k -= 1) {
    let d = digits.charCodeAt(k) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Whether a digit run (with its separators) is a card number: 13 to 19 digits that pass the Luhn check. */
function isCardNumber(run: string): boolean {
  const digits = run.replace(/[ -]/g, "");
  return digits.length >= MIN_CARD_DIGITS && digits.length <= MAX_CARD_DIGITS && passesLuhn(digits);
}

/**
 * Swaps every card number and every Social Security number in `text` for its tag, and counts them. Cards go first
 * (a longer run is never part of a Social Security number); the passes repeat until none swaps anything, which
 * ends because each swap removes digits, so what comes out holds neither whatever came in.
 */
export function scrub(text: string): ScrubResult {
  let current = text;
  let cards = 0;
  let ssns = 0;
  for (;;) {
    let swapped = 0;
    current = current.replace(DIGIT_RUN, (run) => {
      if (!isCardNumber(run)) return run;
      swapped += 1;
      cards += 1;
      return CARD_TAG;
    });
    current = current.replace(SSN_FORM, () => {
      swapped += 1;
      ssns += 1;
      return SSN_TAG;
    });
    if (swapped === 0) return { text: current, cards, ssns };
  }
}

/** The inbound event's two scrubbed fields: its body and, for an email, its subject (K-06 `body`, `email.subject`). */
export interface InboundWords {
  readonly body: string | null;
  readonly subject: string | null;
}

/** The same words scrubbed, with the counts of both fields together: K-06's `scrubbed` `{cards, ssns}`. */
export interface ScrubbedInboundWords {
  readonly body: string | null;
  readonly subject: string | null;
  readonly cards: number;
  readonly ssns: number;
}

/** Scrubs an event's body and an email's subject; a null stays null. */
export function scrubInbound(words: InboundWords): ScrubbedInboundWords {
  const body = words.body === null ? null : scrub(words.body);
  const subject = words.subject === null ? null : scrub(words.subject);
  return {
    body: body === null ? null : body.text,
    subject: subject === null ? null : subject.text,
    cards: (body?.cards ?? 0) + (subject?.cards ?? 0),
    ssns: (body?.ssns ?? 0) + (subject?.ssns ?? 0),
  };
}
