// A counted party, the one reading the count reader (reparse.ts), the time reader (times.ts) and the phrase builder
// (phrase.ts) share, so the readers agree on which number is which (T-1133, DL-259: T-1130's re-judge found the time
// reader's new reach taking a count away from the count reader). A number the count reader reads as a count with its
// unit ("4 people", "150 guests", "12 of us", "two adults") or with the words before it that write it as a party
// ("party of 4", "for 2", "mesa para 4") is a counted party; so is every number a range or choice word joins to one
// ("4 to 6 people", "10, maybe 12 people", "para 4 tal vez 5"), since the unit and the lead words are the whole range's.
// A counted party is never an hour, whatever mark or approximate word stands before it (times.ts). An adding word joins
// two counts into one phrase ("2 adults and 1 child") but carries no unit from one to the other ("at 3 and 4 people"
// keeps its 3 apart), and a mark alone joins none ("at 3, 4 people"). Nothing here keeps or logs words.

import { LETTER_OR_DIGIT, NUMBER_END, NUMBER_JOINING_MARK, NUMBER_START, numberPhrasesIn } from "./numbers";
import { findAll, type Span, type ValueLanguage } from "./words";

/**
 * A count in digits: "4", "1,200", "2.5". It starts and ends at the time reader's number edge (T-1130; numbers.ts
 * NUMBER_START and NUMBER_END, DL-228 item 1): a mark is part of the number only with a digit right before it and right
 * after it, and a comma only as a thousands mark, so a count glued to a mark is read ("table for 4 or 5:)", "re:4 or 5",
 * "Update:2 adults + 1 child") and "4, 5" or "3,4" are two. A letter glued to it ("3rd", "4pm"), a "$" beside it or a
 * "%" after it makes it no count, as before. Its first group is the whole number, its second the digits after a period.
 */
export const NUMERAL = new RegExp(
  String.raw`${NUMBER_START}(?<!${LETTER_OR_DIGIT}|\$)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?${NUMBER_END}(?!${LETTER_OR_DIGIT}|[%$])`,
  "g",
);

/**
 * A count's units, part of its words and not its value (DL-199 item 1: "the number with its unit"); "ppl" and "pax" as
 * people write them in a booking (T-1130).
 */
const COUNT_UNITS = String.raw`people|ppl|pax|persons?|adults?|kids?|children|child|guests?|of us|personas?|adultos?|ninos?|ninas?|invitados?`;
/** A count's unit right after it ("4 people"). */
export const COUNT_UNIT = new RegExp(String.raw`^ (?:${COUNT_UNITS})\b`);
/** Whether a count's folded words end with its unit ("2 people", "two adults", "4 pax"). */
export const ENDS_WITH_COUNT_UNIT = new RegExp(String.raw` (?:${COUNT_UNITS})$`);

/**
 * The words before a count that write it as a party (T-1130): "for" and "para", or the words that name what it counts,
 * "party of", "table for", "group of", "mesa para", "somos".
 */
export const COUNT_LEAD =
  /(?<![\p{L}\p{N}])(?:(?:an? )?(?:party|table|group|reservation|booking) (?:of|for) |(?:una? )?(?:mesa|reserva|reservacion|grupo) (?:para|de) |somos |for |para )$/u;

/**
 * The words that make two counts one range or choice ("4 to 6", "4 or 5", "4, maybe 5", "4 tal vez 5"), so a unit or
 * lead words of one are the other's too.
 */
export const RANGE_OR_CHOICE_WORDS: readonly string[] = [
  "to",
  "or",
  "maybe",
  "perhaps",
  "possibly",
  "probably",
  "o",
  "a",
  "quizas",
  "quiza",
  "tal vez",
];
/** The words that add one count to another ("2 adults and 1 child", "2 adultos y 1 niño"): they join, carrying no unit. */
export const ADDING_WORDS: readonly string[] = ["and", "y"];

/** Words joined at their edges: no letter or digit right before or after them (an underscore is a mark: "_or_"). */
export const asWords = (words: readonly string[]): string =>
  String.raw`(?<![\p{L}\p{N}])(?:${words.join("|")})(?![\p{L}\p{N}])`;

/**
 * What makes two counts one range or choice: range or choice words, or a dash or slash, with any joining marks beside
 * them ("4 to 6", "4-6", "4, maybe 5", "4 (or 5", "4 or maybe 5"); a mark alone ("3, 4 people") or an adding word joins
 * no range.
 */
const RANGE_OR_CHOICE = new RegExp(
  String.raw`^(?:${NUMBER_JOINING_MARK})*(?:(?:${asWords(RANGE_OR_CHOICE_WORDS)}|[-/])(?:${NUMBER_JOINING_MARK})*)+$`,
  "u",
);

/** One number in the folded words, and whether it is whole. */
interface Numbered extends Span {
  readonly whole: boolean;
}

/**
 * Every whole number the count reader reads as a counted party in folded words, where it stands: with its unit right
 * after it, with the words that write it as a party right before it, or joined to one of those by a range or choice word
 * ("4 or 5 people": both). Digits at the number edge (NUMERAL) and numbers in words (numbers.ts) are read; a number with
 * digits after a period ("3.30") is no party.
 */
export function partiesIn(folded: string, languages: readonly ValueLanguage[]): Span[] {
  const numbers: Numbered[] = [
    ...findAll(folded, NUMERAL).map(({ at, end, groups }) => ({ at, end, whole: groups[1] === undefined })),
    ...numberPhrasesIn(folded, languages).map(({ at, end }) => ({ at, end, whole: true })),
  ].sort((a, b) => a.at - b.at);
  const party = numbers.map(
    (number) =>
      number.whole &&
      (COUNT_UNIT.test(folded.slice(number.end)) || COUNT_LEAD.test(folded.slice(0, number.at))),
  );
  const joins = (a: Numbered | undefined, b: Numbered | undefined): boolean =>
    a !== undefined && b !== undefined && RANGE_OR_CHOICE.test(folded.slice(a.end, b.at));
  for (let grew = true; grew;) {
    grew = false;
    numbers.forEach((number, index) => {
      if (party[index] === true || !number.whole) return;
      const before = party[index - 1] === true && joins(numbers[index - 1], number);
      const after = party[index + 1] === true && joins(number, numbers[index + 1]);
      if (before || after) {
        party[index] = true;
        grew = true;
      }
    });
  }
  return numbers.filter((_, index) => party[index] === true).map(({ at, end }) => ({ at, end }));
}
