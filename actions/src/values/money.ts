// Amounts of money in a person's words (T-304; CQ-09: money in whole cents with its currency code), in English and
// Spanish: "$12 a foot" (K-02 decide-two-requests.json), "$1,200", "$12.50", "12 dollars", "twelve dollars", "doce
// dólares", "50 cents", "free" (S1-13: "Free on your board"), and a bare number when nothing else in the words is money:
// "raise haircut to 40" (S11-20), "A at their home too, 75" (S1-13). A bare number that is a time ("3pm", "10:30"), a date
// ("10/24", "24th"), a share ("10%") or a span of time ("40 minutes") is no amount. Nothing here keeps or logs the words.

import { numberPhrasesIn } from "./numbers";
import { BOTH_LANGUAGES, findAll, foldWords, overlaps, type Found, type ValueLanguage } from "./words";

/** An amount of money: whole cents and the currency code (K-02 fieldValue money; CQ-09). */
export interface Money {
  readonly cents: number;
  readonly currency: string;
}

/**
 * The currency of a "$" or a bare amount: every business is in the US (K-04 v1 holds no currency; Stripe runs on US test
 * accounts), so a dollar is USD (default, for ops/QUESTIONS.md).
 */
export const DEFAULT_CURRENCY = "USD";

/** One amount and where it stands in the folded words. */
export interface FoundAmount {
  readonly money: Money;
  readonly at: number;
  readonly end: number;
  /** True when a currency mark, a currency word or "free" says it is money; false for a bare number. */
  readonly marked: boolean;
}

/** A number as people type it: 1200, 1,200, 12.5, 12.50; never a digit or a decimal point right after it. */
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d|[.,]\d)`;
const DOLLAR_WORD = String.raw`(?:dollars?|bucks?|dolares|dolar)`;
const CENT_WORD = String.raw`(?:cents?|centavos?)`;

/** "$12", "US$12", "USD 12", and with a currency word after it said twice ("$12 dollars"). */
const PREFIXED = new RegExp(
  String.raw`(?<![\w$])(?:us ?\$|\$|usd ?) ?${NUMBER}(?: ?(?:${DOLLAR_WORD}|usd)\b)?`,
  "g",
);
const SUFFIXED = new RegExp(String.raw`(?<![\w.,])${NUMBER} ?(?:\$|usd\b|${DOLLAR_WORD}\b)`, "g");
const CENTS = new RegExp(String.raw`(?<![\w.,])(\d+) ?(?:${CENT_WORD}\b|¢)`, "g");
const FREE = /\b(?:free|gratis|no charge|sin costo|sin cargo)\b/g;
const BARE = new RegExp(String.raw`(?<![\w.,:/$])${NUMBER}`, "g");
/** What a bare number may not be followed by: a time of day, a date, an ordinal, a share or a span of time. */
const NOT_AMOUNT_AFTER =
  /^(?: ?(?:am|pm)\b|[ap]\b|:\d|\/\d|(?:st|nd|rd|th)\b| ?%| ?(?:percent|per cent|pct|por ciento)\b| ?(?:min|mins|minutes?|minutos?|h|hrs?|hours?|horas?|days?|dias?|weeks?|semanas?|months?|mes|meses|years?|anos?|oclock)\b)/;
/** A number right after an amount by a dash or "to": the other end of a range, so an amount too. */
const RANGE_TAIL = new RegExp(String.raw`^ ?(?:-|to) ?\$? ?${NUMBER}`);

/** Whole cents from a number's whole part (with any thousands commas) and its one or two decimals. */
function centsOf(whole: string | undefined, decimals: string | undefined): number {
  const units = Number((whole ?? "").replaceAll(",", ""));
  const fraction = decimals === undefined ? 0 : Number(decimals.padEnd(2, "0"));
  return units * 100 + fraction;
}

const usd = (cents: number): Money => ({ cents, currency: DEFAULT_CURRENCY });

function amountsAt(found: readonly Found[], marked: boolean, cents: (found: Found) => number): FoundAmount[] {
  return found.map((each) => ({ money: usd(cents(each)), at: each.at, end: each.end, marked }));
}

/**
 * Every amount of money in a person's words, in the order they stand. Marked amounts come first in reading: a bare number
 * counts only when the words hold no marked amount and no "free" (but the far end of a "$12-15" range does).
 */
export function amountsIn(
  words: string,
  languages: readonly ValueLanguage[] = BOTH_LANGUAGES,
): FoundAmount[] {
  const folded = foldWords(words);
  const marked: FoundAmount[] = [];
  const take = (found: readonly FoundAmount[]): void => {
    for (const each of found) if (!overlaps(each, marked)) marked.push(each);
  };
  take(amountsAt(findAll(folded, PREFIXED), true, (each) => centsOf(each.groups[0], each.groups[1])));
  take(amountsAt(findAll(folded, SUFFIXED), true, (each) => centsOf(each.groups[0], each.groups[1])));
  take(amountsAt(findAll(folded, CENTS), true, (each) => Number(each.groups[0])));
  const wordAmounts: FoundAmount[] = [];
  for (const phrase of numberPhrasesIn(folded, languages)) {
    const after = folded.slice(phrase.end);
    const dollars = new RegExp(String.raw`^ ${DOLLAR_WORD}\b`).exec(after);
    const cents = new RegExp(String.raw`^ ${CENT_WORD}\b`).exec(after);
    if (dollars !== null) {
      wordAmounts.push({
        money: usd(phrase.value * 100),
        at: phrase.at,
        end: phrase.end + dollars[0].length,
        marked: true,
      });
    } else if (cents !== null) {
      wordAmounts.push({
        money: usd(phrase.value),
        at: phrase.at,
        end: phrase.end + cents[0].length,
        marked: true,
      });
    }
  }
  take(wordAmounts);
  take(amountsAt(findAll(folded, FREE), true, () => 0));
  const tails: FoundAmount[] = [];
  for (const each of marked) {
    const tail = RANGE_TAIL.exec(folded.slice(each.end));
    if (tail !== null) {
      tails.push({
        money: usd(centsOf(tail[1], tail[2])),
        at: each.end,
        end: each.end + tail[0].length,
        marked: true,
      });
    }
  }
  take(tails);
  if (marked.length > 0) return [...marked].sort((a, b) => a.at - b.at);
  const bare = findAll(folded, BARE).filter((each) => !NOT_AMOUNT_AFTER.test(folded.slice(each.end)));
  return amountsAt(bare, false, (each) => centsOf(each.groups[0], each.groups[1]));
}

/** Whether two amounts are the same: equal cents in one currency. */
export function sameMoney(a: Money, b: Money): boolean {
  return a.cents === b.cents && a.currency === b.currency;
}

/** The distinct amounts in a list, first seen first. */
export function distinctMoney(amounts: readonly Money[]): Money[] {
  const out: Money[] = [];
  for (const amount of amounts) if (!out.some((each) => sameMoney(each, amount))) out.push(amount);
  return out;
}
