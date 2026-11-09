// Numbers written as words, in English and Spanish (T-304; A3-07: "By default: English and Spanish"), read from folded
// words (words.ts): "twenty-five", "a hundred and five", "fifteen hundred", "treinta y cinco", "veintidós", "doscientos",
// "dos mil". A run that cannot be one number ("five twenty") is two. "once" is Spanish eleven only when the text is
// Spanish, since in English it means one time; "un" and "una" are Spanish one. The number edge and the mark that joins
// numbers live here too (moved from times.ts by T-1133), below every reader, so the time reader, the count reader and
// the party reading (parties.ts) share one definition of each with no import between them going round.

import { BOTH_LANGUAGES, type ValueLanguage } from "./words";

// The number edge, by construction (T-304 round 7, DL-228 item 1): a mark (any character that is neither a digit nor a
// letter) is part of a number only when a digit stands right before it and right after it; anywhere else it ends the
// number, before it and after it. Rounds 5 and 6 (DL-209, DL-217) let the comma and then the period end an hour one mark
// at a time, which left the colon hiding one ("see you tomorrow at 3:)"); here no mark is listed as an end. Between two
// digits the readers read the period, the colon and the slash as part of the number ("3.30", "3.5", "3:30", "10/24"),
// and the comma as part of it where it marks thousands, three digits after it ("1,200"); any other mark between two
// digits joins two numbers, as before ("2-5pm" is a range, so several; "3:30,4:30" two times). So every pattern of the
// time reader starts a number only where neither a digit nor a digit and such a mark stands right before it
// (NUMBER_START), and ends one only where neither a digit nor such a mark and a digit stands right after it (NUMBER_END):
// "see you tomorrow at 3:)", "tomorrow at 3:", "tomorrow at 3.", "Thursday, 3:)", "tomorrow morning, 9:)", "Update:3pm
// tomorrow" and "hmm...3pm tomorrow" read their hour, while "3:30", "3.5", "10/24", "1,200" and "$3.50" keep their
// readings (no hour 3, 10, 1 or 50 in them). A unit glued to a number is no edge but what the number is, as before: a
// "%" right after it (a share) or a "$" beside it (money) makes it no hour, and a letter glued to a bare number makes it
// no bare number ("3rd"). An underscore is a mark, never a letter. The count reader starts and ends its counts at the
// same edges (T-1130: parties.ts NUMERAL), so a count glued to a mark ("table for 4 or 5:)", "re:4 or 5") is read as one.
export const NUMBER_START = String.raw`(?<!\d|\d[.:/]|\d,(?=\d{3}(?!\d)))`;
export const NUMBER_END = String.raw`(?!\d|[.:/]\d|,\d{3}(?!\d))`;
/** A letter or digit of the folded words: \w without the underscore, which is a mark. */
export const LETTER_OR_DIGIT = String.raw`[^\W_]`;
/** The sentence marks, as characters of a pattern's character class: ". ! ? ;" and Spanish "¿ ¡" ("…" folds to "..."). */
export const SENTENCE_MARKS = ".!?;¿¡";
/**
 * One mark that joins amounts or counts (values/phrase.ts), and the ground of a time's joining mark (times.ts
 * JOINING_MARK): any character but a letter or a digit of any script (\p{L}\p{N}) or a sentence mark. A pattern using it
 * takes the "u" flag.
 */
export const NUMBER_JOINING_MARK = String.raw`[^\p{L}\p{N}${SENTENCE_MARKS}]`;

type WordKind = "zero" | "unit" | "teen" | "ten" | "hundred" | "hundreds" | "thousand";

interface NumberWord {
  readonly value: number;
  readonly kind: WordKind;
}

const word = (value: number, kind: WordKind): NumberWord => ({ value, kind });

const ENGLISH: Readonly<Record<string, NumberWord>> = {
  zero: word(0, "zero"),
  one: word(1, "unit"),
  two: word(2, "unit"),
  three: word(3, "unit"),
  four: word(4, "unit"),
  five: word(5, "unit"),
  six: word(6, "unit"),
  seven: word(7, "unit"),
  eight: word(8, "unit"),
  nine: word(9, "unit"),
  ten: word(10, "teen"),
  eleven: word(11, "teen"),
  twelve: word(12, "teen"),
  thirteen: word(13, "teen"),
  fourteen: word(14, "teen"),
  fifteen: word(15, "teen"),
  sixteen: word(16, "teen"),
  seventeen: word(17, "teen"),
  eighteen: word(18, "teen"),
  nineteen: word(19, "teen"),
  twenty: word(20, "ten"),
  thirty: word(30, "ten"),
  forty: word(40, "ten"),
  fifty: word(50, "ten"),
  sixty: word(60, "ten"),
  seventy: word(70, "ten"),
  eighty: word(80, "ten"),
  ninety: word(90, "ten"),
  hundred: word(100, "hundred"),
  thousand: word(1000, "thousand"),
};

/** Spanish, folded (accents off: "veintidós" is "veintidos", "dieciséis" "dieciseis"). */
const SPANISH: Readonly<Record<string, NumberWord>> = {
  cero: word(0, "zero"),
  un: word(1, "unit"),
  una: word(1, "unit"),
  uno: word(1, "unit"),
  dos: word(2, "unit"),
  tres: word(3, "unit"),
  cuatro: word(4, "unit"),
  cinco: word(5, "unit"),
  seis: word(6, "unit"),
  siete: word(7, "unit"),
  ocho: word(8, "unit"),
  nueve: word(9, "unit"),
  diez: word(10, "teen"),
  doce: word(12, "teen"),
  trece: word(13, "teen"),
  catorce: word(14, "teen"),
  quince: word(15, "teen"),
  dieciseis: word(16, "teen"),
  diecisiete: word(17, "teen"),
  dieciocho: word(18, "teen"),
  diecinueve: word(19, "teen"),
  veintiun: word(21, "teen"),
  veintiuno: word(21, "teen"),
  veintiuna: word(21, "teen"),
  veintidos: word(22, "teen"),
  veintitres: word(23, "teen"),
  veinticuatro: word(24, "teen"),
  veinticinco: word(25, "teen"),
  veintiseis: word(26, "teen"),
  veintisiete: word(27, "teen"),
  veintiocho: word(28, "teen"),
  veintinueve: word(29, "teen"),
  veinte: word(20, "ten"),
  treinta: word(30, "ten"),
  cuarenta: word(40, "ten"),
  cincuenta: word(50, "ten"),
  sesenta: word(60, "ten"),
  setenta: word(70, "ten"),
  ochenta: word(80, "ten"),
  noventa: word(90, "ten"),
  cien: word(100, "hundreds"),
  ciento: word(100, "hundreds"),
  doscientos: word(200, "hundreds"),
  doscientas: word(200, "hundreds"),
  trescientos: word(300, "hundreds"),
  trescientas: word(300, "hundreds"),
  cuatrocientos: word(400, "hundreds"),
  cuatrocientas: word(400, "hundreds"),
  quinientos: word(500, "hundreds"),
  quinientas: word(500, "hundreds"),
  seiscientos: word(600, "hundreds"),
  seiscientas: word(600, "hundreds"),
  setecientos: word(700, "hundreds"),
  setecientas: word(700, "hundreds"),
  ochocientos: word(800, "hundreds"),
  ochocientas: word(800, "hundreds"),
  novecientos: word(900, "hundreds"),
  novecientas: word(900, "hundreds"),
  mil: word(1000, "thousand"),
};

/** Spanish eleven, read only in a Spanish text: English "once" is one time. */
const SPANISH_ONLY: Readonly<Record<string, NumberWord>> = { once: word(11, "teen") };

/** The number words of the languages given, by folded word. */
export function numberWordsOf(languages: readonly ValueLanguage[]): ReadonlyMap<string, NumberWord> {
  const words = new Map<string, NumberWord>();
  if (languages.includes("en")) for (const [key, value] of Object.entries(ENGLISH)) words.set(key, value);
  if (languages.includes("es")) for (const [key, value] of Object.entries(SPANISH)) words.set(key, value);
  if (languages.length === 1 && languages[0] === "es") {
    for (const [key, value] of Object.entries(SPANISH_ONLY)) words.set(key, value);
  }
  return words;
}

/** One number written in words, where it stands in the folded text. */
export interface NumberPhrase {
  readonly value: number;
  readonly at: number;
  readonly end: number;
}

interface Token {
  readonly text: string;
  readonly at: number;
  readonly end: number;
}

const TOKEN = /[\p{L}\p{N}]+/gu;

function tokensOf(folded: string): Token[] {
  return [...folded.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    at: match.index,
    end: match.index + match[0].length,
  }));
}

type Last = "none" | WordKind | "a";

/** Whether a word of `kind` may follow `last` inside one number. */
function canFollow(last: Last, kind: WordKind): boolean {
  switch (kind) {
    case "zero":
      return last === "none";
    case "unit":
      return (
        last === "none" || last === "ten" || last === "hundred" || last === "hundreds" || last === "thousand"
      );
    case "teen":
    case "ten":
      return last === "none" || last === "hundred" || last === "hundreds" || last === "thousand";
    case "hundred":
      return last === "a" || last === "unit" || last === "teen";
    case "hundreds":
      return last === "none" || last === "thousand";
    case "thousand":
      return last !== "none" && last !== "thousand" && last !== "zero";
  }
}

/** One number being read, word by word. */
class Building {
  total = 0;
  current = 0;
  last: Last = "none";
  end: number;

  constructor(readonly at: number) {
    this.end = at;
  }

  add(found: NumberWord, end: number): void {
    switch (found.kind) {
      case "hundred":
        this.current = Math.max(this.current, 1) * 100;
        break;
      case "thousand":
        this.total += Math.max(this.current, 1) * 1000;
        this.current = 0;
        break;
      default:
        this.current += found.value;
    }
    this.last = found.kind;
    this.end = end;
  }

  phrase(): NumberPhrase | null {
    if (this.last === "none" || this.last === "a") return null;
    return { value: this.total + this.current, at: this.at, end: this.end };
  }
}

/** Whether `token` joins the number being read to the next word: "and" after a hundred, Spanish "y" after a ten. */
function joins(
  token: string,
  building: Building | null,
  next: NumberWord | undefined,
  languages: readonly ValueLanguage[],
): boolean {
  if (building === null || next === undefined) return false;
  if (languages.includes("en") && token === "and") {
    return (
      (building.last === "hundred" || building.last === "thousand") &&
      (next.kind === "unit" || next.kind === "teen" || next.kind === "ten")
    );
  }
  return languages.includes("es") && token === "y" && building.last === "ten" && next.kind === "unit";
}

/**
 * Every number written in words in a folded text, in order. English "a" or "an" counts as one only before "hundred" or
 * "thousand"; "and" joins after a hundred or a thousand; Spanish "y" joins a ten and a unit.
 */
export function numberPhrasesIn(
  folded: string,
  languages: readonly ValueLanguage[] = BOTH_LANGUAGES,
): NumberPhrase[] {
  const words = numberWordsOf(languages);
  const tokens = tokensOf(folded);
  const phrases: NumberPhrase[] = [];
  let building: Building | null = null;
  const close = (open: Building | null): null => {
    const phrase = open?.phrase() ?? null;
    if (phrase !== null) phrases.push(phrase);
    return null;
  };
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const nextWord = next === undefined ? undefined : words.get(next.text);
    const article = token.text === "a" || token.text === "an";
    if (
      languages.includes("en") &&
      article &&
      building === null &&
      (nextWord?.kind === "hundred" || nextWord?.kind === "thousand")
    ) {
      building = new Building(token.at);
      building.current = 1;
      building.last = "a";
      building.end = token.end;
      continue;
    }
    if (joins(token.text, building, nextWord, languages)) continue;
    const found = words.get(token.text);
    if (found === undefined) {
      building = close(building);
      continue;
    }
    if (building === null || !canFollow(building.last, found.kind)) {
      close(building);
      building = new Building(token.at);
    }
    building.add(found, token.end);
    if (found.kind === "zero") building = close(building);
  }
  close(building);
  return phrases;
}
