// Amounts of money in a person's words (T-304; CQ-09: money in whole cents with its currency code), in English and
// Spanish: "$12 a foot" (K-02 decide-two-requests.json), "$1,200", "$12.50", "12 dollars", "twelve dollars", "doce
// dólares", "50 cents", "free" (S1-13: "Free on your board"), and a bare number when nothing else in the words is money:
// "raise haircut to 40" (S11-20), "A at their home too, 75" (S1-13). A bare number that is a time ("3pm", "10:30"), a date
// ("10/24", "24th"), a share ("10%") or a span of time ("40 minutes") is no amount.
//
// Each amount is read whole, with its span (T-304 round 4, DL-199 items 1 and 2): its sign or code ("$", "US$", "€",
// "USD"); its currency word, in currencies other than the dollar too ("40 euros", "40 pesos", "€40" are no dollars, and a
// currency sign the reader does not know is no dollar either); its scale ("$2k", "$40 thousand", "$1 million", "2 mil
// pesos"); the per-unit after it ("$40/hr", "$12 a foot", "$35 each": part of its words, never of its value); and the far
// end of a range ("$12-15", "$12 to 15", "$12 or 15", "$12～15"). Nothing here keeps or logs the words.

import { numberPhrasesIn } from "./numbers";
import { BOTH_LANGUAGES, foldWords, overlaps, type ValueLanguage } from "./words";

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

/** ISO 4217's code for no currency: an amount in a currency sign the reader does not know ("₿40"), never a dollar. */
export const UNKNOWN_CURRENCY = "XXX";

/** One amount and where it stands in the folded words. */
export interface FoundAmount {
  readonly money: Money;
  readonly at: number;
  readonly end: number;
  /** True when a currency mark, a currency word or "free" says it is money; false for a bare number. */
  readonly marked: boolean;
}

/** A number as people type it: 1200, 1,200, 12.5, 12.50; never a digit or a decimal point right after it. */
const NUMBER = String.raw`(?<whole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<decimals>\d{1,2}))?(?!\d|[.,]\d)`;

/** The currencies of signs: "$" is the dollar (DEFAULT_CURRENCY); any other sign the reader does not know is none. */
const SIGN_CURRENCIES: Readonly<Partial<Record<string, string>>> = {
  $: DEFAULT_CURRENCY,
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
  "₱": "PHP",
  "₽": "RUB",
};
/** A sign before the number: "$", "US$", "MX$", or any currency sign but the cent's. */
const SIGN = String.raw`(?<sign>us ?\$|mx ?\$|(?!¢)\p{Sc})`;
/** A sign after the number: "12$", "12 €". */
const SIGN_AFTER = String.raw`(?<signAfter>(?!¢)\p{Sc})`;
/** A currency code before the number: "USD 12". */
const CODE = String.raw`(?<code>usd|eur|mxn|gbp|cad|aud|jpy)`;

/** Currency words, folded, longest first where one starts another, and the currency each names. */
const CURRENCY_WORDS: readonly (readonly [string, string])[] = [
  ["canadian dollars?", "CAD"],
  ["australian dollars?", "AUD"],
  ["mexican pesos?", "MXN"],
  ["(?:us |american )?dollars?", "USD"],
  ["bucks?", "USD"],
  ["dolares", "USD"],
  ["dolar", "USD"],
  ["euros?", "EUR"],
  ["pesos?", "MXN"],
  ["pounds?", "GBP"],
  ["libras?", "GBP"],
  ["quid", "GBP"],
  ["yen", "JPY"],
  ["rupees?", "INR"],
  ["yuan|rmb", "CNY"],
  ["reais|reales|real", "BRL"],
  ["soles", "PEN"],
  ["quetzales|quetzal", "GTQ"],
  ["colones", "CRC"],
  ["lempiras?", "HNL"],
  ["bolivares", "VES"],
  ["usd", "USD"],
  ["eur", "EUR"],
  ["mxn", "MXN"],
  ["gbp", "GBP"],
  ["cad", "CAD"],
  ["aud", "AUD"],
  ["jpy", "JPY"],
];
const WORD = String.raw`(?<word>${CURRENCY_WORDS.map(([words]) => words).join("|")})`;
const CENT_WORD = String.raw`(?:cents?|centavos?)`;

/**
 * Scale words, by what each multiplies by: "k", "thousand", "grand", "hundred", "million", "billion"; Spanish "mil" (a
 * thousand), "millón". "mil" in an English text is a million ("2 mil"), in a Spanish one or one of either language a
 * thousand, as numbers.ts reads it.
 */
const SCALES: Readonly<Partial<Record<string, number>>> = {
  k: 1_000,
  thousand: 1_000,
  grand: 1_000,
  hundred: 100,
  million: 1_000_000,
  millions: 1_000_000,
  billion: 1_000_000_000,
  billions: 1_000_000_000,
  millon: 1_000_000,
  millones: 1_000_000,
};
const ENGLISH_SCALES = ["thousand", "grand", "hundred", "millions", "million", "billions", "billion", "mil"];
const SPANISH_SCALES = ["millones", "millon", "mil"];

/** A per-unit after an amount ("/hr", "a foot", "per person", "each", "la hora"): part of its words, not its value. */
const UNIT = /^(?: ?\/ ?[a-z]+\b| (?:per|a|an|por|cada|la|el) (?!cent\b|ciento\b)[a-z]+\b| each\b)/;
/** What a bare number may not be followed by: a time of day, a date, an ordinal, a share or a span of time. */
const NOT_AMOUNT_AFTER =
  /^(?: ?(?:am|pm)\b|[ap]\b|:\d|\/\d|(?:st|nd|rd|th)\b| ?%| ?(?:percent|per cent|pct|por ciento)\b| ?(?:min|mins|minutes?|minutos?|h|hrs?|hours?|horas?|days?|dias?|weeks?|semanas?|months?|mes|meses|years?|anos?|oclock)\b)/;
const FREE = /\b(?:free|gratis|no charge|sin costo|sin cargo)\b/g;

/** The patterns of one set of languages (their scale words differ). */
interface MoneyPatterns {
  /** "$12", "US$12", "USD 12", "€40", "$2k", "$1 million", "$12 dollars", "$40 pesos". */
  readonly prefixed: RegExp;
  /** "12 dollars", "12$", "40 euros", "2 mil pesos", "40 thousand dollars". */
  readonly suffixed: RegExp;
  /** "50 cents", "50¢". */
  readonly cents: RegExp;
  /** After a number in words: " dollars", " million dollars", " cents". */
  readonly wordsAfter: RegExp;
  /** A bare number: "40", "2k". */
  readonly bare: RegExp;
  /** A scale right after a bare number: "k", " thousand". */
  readonly scaleAfter: RegExp;
  /** The far end of a range right after an amount: "-15", " to 15", " or $15", " o 15". */
  readonly tail: RegExp;
}

const patternsByLanguages = new Map<string, MoneyPatterns>();

function patternsOf(languages: readonly ValueLanguage[]): MoneyPatterns {
  const key = languages.join(",");
  const known = patternsByLanguages.get(key);
  if (known !== undefined) return known;
  const scaleWords = [
    ...(languages.includes("en") ? ENGLISH_SCALES : []),
    ...(languages.includes("es") ? SPANISH_SCALES : []),
  ].join("|");
  const scale = String.raw`(?: ?(?<k>k)(?![\p{L}\p{N}])| (?<scale>${scaleWords})\b)`;
  const patterns: MoneyPatterns = {
    prefixed: new RegExp(
      String.raw`(?<![\w$])(?:${SIGN}|${CODE} ?) ?${NUMBER}${scale}?(?: ?${WORD}\b)?`,
      "gu",
    ),
    suffixed: new RegExp(String.raw`(?<![\w.,])${NUMBER}${scale}? ?(?:${WORD}\b|${SIGN_AFTER})`, "gu"),
    cents: new RegExp(String.raw`(?<![\w.,])(?<count>\d+) ?(?:${CENT_WORD}\b|¢)`, "gu"),
    wordsAfter: new RegExp(String.raw`^${scale}? (?:${WORD}|(?<cent>${CENT_WORD}))\b`, "u"),
    bare: new RegExp(String.raw`(?<![\w.,:/$])${NUMBER}`, "gu"),
    scaleAfter: new RegExp(String.raw`^${scale}`, "u"),
    tail: new RegExp(String.raw`^ ?(?:-|to\b|or\b|o\b) ?(?:\$|(?!¢)\p{Sc})? ?${NUMBER}${scale}?`, "u"),
  };
  patternsByLanguages.set(key, patterns);
  return patterns;
}

type Groups = Partial<Record<string, string>>;

/** Whole cents from a number's whole part (with any thousands commas), its one or two decimals, and its scale. */
function centsOf(groups: Groups, languages: readonly ValueLanguage[]): number {
  const units = Number((groups.whole ?? "").replaceAll(",", ""));
  const fraction = groups.decimals === undefined ? 0 : Number(groups.decimals.padEnd(2, "0"));
  return (units * 100 + fraction) * scaleOf(groups, languages);
}

/** What a number's scale word multiplies it by; 1 for none. */
function scaleOf(groups: Groups, languages: readonly ValueLanguage[]): number {
  const word = groups.k ?? groups.scale;
  if (word === undefined) return 1;
  if (word === "mil") return languages.includes("es") ? 1_000 : 1_000_000;
  return SCALES[word] ?? 1;
}

/** The currency a currency word names. */
function currencyOfWord(word: string): string {
  const found = CURRENCY_WORDS.find(([words]) => new RegExp(String.raw`^(?:${words})$`, "u").test(word));
  return found?.[1] ?? UNKNOWN_CURRENCY;
}

/** The currency an amount's own words name: its currency word, else its code, else its sign; else the dollar. */
function currencyOf(groups: Groups): string {
  if (groups.word !== undefined) return currencyOfWord(groups.word);
  if (groups.code !== undefined) return groups.code.toUpperCase();
  const sign = groups.sign ?? groups.signAfter;
  if (sign === undefined) return DEFAULT_CURRENCY;
  if (sign.startsWith("us")) return DEFAULT_CURRENCY;
  if (sign.startsWith("mx")) return "MXN";
  return SIGN_CURRENCIES[sign] ?? UNKNOWN_CURRENCY;
}

/** Where an amount ending at `end` ends with the per-unit after it ("$40/hr", "$12 a foot"). */
function withUnit(folded: string, end: number): number {
  return end + (UNIT.exec(folded.slice(end))?.[0].length ?? 0);
}

interface Matched {
  readonly at: number;
  readonly end: number;
  readonly groups: Groups;
}

function matchesOf(folded: string, pattern: RegExp): Matched[] {
  return [...folded.matchAll(pattern)].map((match) => ({
    at: match.index,
    end: match.index + match[0].length,
    groups: match.groups ?? {},
  }));
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
  const patterns = patternsOf(languages);
  const marked: FoundAmount[] = [];
  const take = (amount: FoundAmount): void => {
    if (!overlaps(amount, marked)) marked.push(amount);
  };
  const amount = (at: number, end: number, cents: number, currency: string): FoundAmount => ({
    money: { cents, currency },
    at,
    end: withUnit(folded, end),
    marked: true,
  });
  for (const each of matchesOf(folded, patterns.prefixed)) {
    take(amount(each.at, each.end, centsOf(each.groups, languages), currencyOf(each.groups)));
  }
  for (const each of matchesOf(folded, patterns.suffixed)) {
    take(amount(each.at, each.end, centsOf(each.groups, languages), currencyOf(each.groups)));
  }
  for (const each of matchesOf(folded, patterns.cents)) {
    take(amount(each.at, each.end, Number(each.groups.count ?? ""), DEFAULT_CURRENCY));
  }
  for (const phrase of numberPhrasesIn(folded, languages)) {
    const after = patterns.wordsAfter.exec(folded.slice(phrase.end));
    if (after === null) continue;
    const groups: Groups = after.groups ?? {};
    const cents = groups.cent === undefined ? phrase.value * 100 * scaleOf(groups, languages) : phrase.value;
    const currency = groups.cent === undefined ? currencyOf(groups) : DEFAULT_CURRENCY;
    take(amount(phrase.at, phrase.end + after[0].length, cents, currency));
  }
  for (const each of matchesOf(folded, FREE)) take(amount(each.at, each.end, 0, DEFAULT_CURRENCY));
  for (const head of [...marked]) {
    const tail = patterns.tail.exec(folded.slice(head.end));
    if (tail === null) continue;
    const cents = centsOf(tail.groups ?? {}, languages);
    take(amount(head.end, head.end + tail[0].length, cents, head.money.currency));
  }
  if (marked.length > 0) return [...marked].sort((a, b) => a.at - b.at);
  const bare: FoundAmount[] = [];
  for (const each of matchesOf(folded, patterns.bare)) {
    if (NOT_AMOUNT_AFTER.test(folded.slice(each.end))) continue;
    const scale = patterns.scaleAfter.exec(folded.slice(each.end));
    const groups: Groups = { ...each.groups, ...(scale?.groups ?? {}) };
    const end = withUnit(folded, each.end + (scale?.[0].length ?? 0));
    const money = { cents: centsOf(groups, languages), currency: DEFAULT_CURRENCY };
    bare.push({ money, at: each.at, end, marked: false });
  }
  return bare;
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
