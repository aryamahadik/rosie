// The card number and Social Security number scrub (T-242, widened by T-1070; C-045). The gateway (C-044) runs it on
// every inbound body and on an email's subject before any write: arch 02 line 109 ("Before any write it swaps card
// numbers (13 to 19 digits, Luhn) and Social Security numbers for a tag"); arch 10 line 516 ("Cards and SSNs scrubbed
// at the edge"); RULES 4.5. Pure: no clock, no I/O, the same text in gives the same text out (the one module-level
// Map only remembers the value of a digit, which never changes).
//
// What counts as a number is exactly what K-06 v1.1's named rule `scrubbedV1dot1` refuses (contracts/inbound-event/
// inbound-event.rules.mjs, README "Named rule (v1.1)"), so the output of this scrub passes that rule, and v1's
// `scrubbed` too, for any input; the tests run both over every K-06 fixture and over random text, and hold this
// file's reading of digits equal to the rule's reference function over every Unicode decimal digit.
//
//   1. Digits of any script (Unicode Nd) are the ASCII digit they stand for.
//   2. A run is digits with any run of separators (Unicode Zs, a tab, Unicode Pd) between two of them.
//   3. A card number is any 13 to 19 digit window of a run that passes the Luhn check. The tag goes where README
//      "Where the tag goes" puts it: from the left, the first window that passes, the longest at its start, is swapped
//      for the tag with the separators inside it; the digits outside it stay; this repeats until no window passes.
//   4. Then each Social Security number (3, 2 and 4 digits with a run of separators between the groups and no digit
//      next to it) is swapped. Nine bare digits are not one (K-06 v1 default 1, kept by v1.1).
//
// The tags and the counts are K-06's: a card number becomes "[card number]", a Social Security number "[SSN]".
//
// Cost: one pass over the code points to classify them, one pass over each run's digits trying at most seven windows
// of at most 19 digits at each start, and one pass over the digit groups for the Social Security numbers: linear in
// the length of the text, never a repeat over the whole text (a speed test holds the growth).

/** The tag a card number is swapped for: K-06's CARD_TAG (a test holds the two equal). */
export const CARD_TAG = "[card number]";

/** The tag a Social Security number is swapped for: K-06's SSN_TAG (a test holds the two equal). */
export const SSN_TAG = "[SSN]";

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

// ---------------------------------------------------------------------------------------------------------------
// Reading characters: digit, separator or other

// A unit's kind is 0 (anything else: it ends a run), KIND_DIGIT or KIND_SEPARATOR.
const KIND_DIGIT = 1;
const KIND_SEPARATOR = 2;

/** A decimal digit of any script (Unicode Nd). */
const ANY_DIGIT = /\p{Nd}/u;

/** A separator beyond ASCII: any space separator (Zs) or any dash (Pd); ASCII's space, tab and hyphen-minus are handled first. */
const WIDE_SEPARATOR = /[\p{Zs}\p{Pd}]/u;

/** The values of the non-ASCII decimal digits met so far, by code point (a digit's value never changes). */
const digitValues = new Map<number, number>();

/**
 * The value of one decimal digit of any script. Unicode encodes every set of decimal digits (Nd) as ten consecutive
 * code points from 0 to 9, so a digit's value is its distance from the start of its run of Nd code points, modulo ten:
 * the same reading as K-06's toAsciiDigits (a test holds them equal over every Nd code point).
 */
export function digitValueOf(point: number): number {
  let start = point;
  while (start > 0 && ANY_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (point - start) % 10;
}

/** The code points of a text, each as its UTF-16 offset, its kind and, for a digit, its value. */
interface Units {
  /** `offsets[k]` is where unit k starts in the text; `offsets[count]` is the text's length. */
  readonly offsets: Uint32Array;
  readonly kinds: Uint8Array;
  readonly values: Uint8Array;
  readonly count: number;
}

function classify(text: string): Units {
  const length = text.length;
  const offsets = new Uint32Array(length + 1);
  const kinds = new Uint8Array(length);
  const values = new Uint8Array(length);
  let count = 0;
  for (let at = 0; at < length;) {
    const point = text.codePointAt(at) ?? 0;
    offsets[count] = at;
    if (point >= 48 && point <= 57) {
      kinds[count] = KIND_DIGIT;
      values[count] = point - 48;
    } else if (point === 32 || point === 9 || point === 45) {
      kinds[count] = KIND_SEPARATOR;
    } else if (point >= 128) {
      const char = String.fromCodePoint(point);
      if (ANY_DIGIT.test(char)) {
        kinds[count] = KIND_DIGIT;
        let value = digitValues.get(point);
        if (value === undefined) {
          value = digitValueOf(point);
          digitValues.set(point, value);
        }
        values[count] = value;
      } else if (WIDE_SEPARATOR.test(char)) {
        kinds[count] = KIND_SEPARATOR;
      }
    }
    count += 1;
    at += point > 0xffff ? 2 : 1;
  }
  offsets[count] = length;
  return { offsets, kinds, values, count };
}

// ---------------------------------------------------------------------------------------------------------------
// Card numbers

/** Whether the `length` digits of a run starting at digit `from` pass the Luhn check (values are 0 to 9). */
function windowPassesLuhn(values: readonly number[], from: number, length: number): boolean {
  let sum = 0;
  let double = false;
  for (let k = from + length - 1; k >= from; k -= 1) {
    let d = values[k] ?? 0;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Swaps every card number for its tag, left to right, and counts them. */
function swapCards(text: string): { text: string; count: number } {
  const { offsets, kinds, values, count: units } = classify(text);
  const parts: string[] = [];
  const runUnits: number[] = [];
  const runValues: number[] = [];
  let copied = 0;
  let cards = 0;
  let at = 0;
  while (at < units) {
    if (kinds[at] !== KIND_DIGIT) {
      at += 1;
      continue;
    }
    // One run: a digit, then any number of (separators, digit).
    runUnits.length = 0;
    runValues.length = 0;
    runUnits.push(at);
    runValues.push(values[at] ?? 0);
    let end = at + 1;
    for (;;) {
      let next = end;
      while (next < units && kinds[next] === KIND_SEPARATOR) next += 1;
      if (next < units && kinds[next] === KIND_DIGIT) {
        runUnits.push(next);
        runValues.push(values[next] ?? 0);
        end = next + 1;
      } else {
        break;
      }
    }
    at = end;
    // Left to right: the first window that passes, the longest at its start; then on from the digit after it.
    const digits = runValues.length;
    let start = 0;
    while (start + MIN_CARD_DIGITS <= digits) {
      let found = 0;
      for (let length = Math.min(MAX_CARD_DIGITS, digits - start); length >= MIN_CARD_DIGITS; length -= 1) {
        if (windowPassesLuhn(runValues, start, length)) {
          found = length;
          break;
        }
      }
      if (found === 0) {
        start += 1;
        continue;
      }
      const first = runUnits[start] ?? 0;
      const last = runUnits[start + found - 1] ?? 0;
      parts.push(text.slice(copied, offsets[first]), CARD_TAG);
      copied = offsets[last + 1] ?? text.length;
      cards += 1;
      start += found;
    }
  }
  if (cards === 0) return { text, count: 0 };
  parts.push(text.slice(copied));
  return { text: parts.join(""), count: cards };
}

// ---------------------------------------------------------------------------------------------------------------
// Social Security numbers

/** Swaps every Social Security number (groups of 3, 2 and 4 digits, a run of separators between) for its tag. */
function swapSsns(text: string): { text: string; count: number } {
  const { offsets, kinds, count: units } = classify(text);
  // The digit groups: maximal runs of digit units, with whether only separators lie between a group and the one before.
  const groupFirst: number[] = [];
  const groupEnd: number[] = [];
  const separatedBefore: boolean[] = [];
  let onlySeparators = false;
  for (let at = 0; at < units;) {
    const kind = kinds[at];
    if (kind === KIND_DIGIT) {
      groupFirst.push(at);
      separatedBefore.push(onlySeparators);
      while (at < units && kinds[at] === KIND_DIGIT) at += 1;
      groupEnd.push(at);
      onlySeparators = true;
    } else {
      if (kind !== KIND_SEPARATOR) onlySeparators = false;
      at += 1;
    }
  }
  const size = (group: number): number => (groupEnd[group] ?? 0) - (groupFirst[group] ?? 0);
  const parts: string[] = [];
  let copied = 0;
  let ssns = 0;
  for (let group = 0; group + 2 < groupFirst.length;) {
    if (
      size(group) === 3 &&
      size(group + 1) === 2 &&
      size(group + 2) === 4 &&
      separatedBefore[group + 1] === true &&
      separatedBefore[group + 2] === true
    ) {
      parts.push(text.slice(copied, offsets[groupFirst[group] ?? 0]), SSN_TAG);
      copied = offsets[groupEnd[group + 2] ?? 0] ?? text.length;
      ssns += 1;
      group += 3;
    } else {
      group += 1;
    }
  }
  if (ssns === 0) return { text, count: 0 };
  parts.push(text.slice(copied));
  return { text: parts.join(""), count: ssns };
}

/**
 * Swaps every card number and every Social Security number in `text` for its tag, and counts them: cards first (a
 * longer run is never part of a Social Security number), then Social Security numbers. What comes out holds neither,
 * by K-06 v1.1's rule, whatever came in: a swap only removes digits, and a tag ends the run it sits in.
 */
export function scrub(text: string): ScrubResult {
  const cards = swapCards(text);
  const ssns = swapSsns(cards.text);
  return { text: ssns.text, cards: cards.count, ssns: ssns.count };
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
