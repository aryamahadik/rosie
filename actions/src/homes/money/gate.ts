// The money-topic gate (T-593 rounds 3 to 8; DL-182, DL-187, DL-194, DL-204, DL-214, DL-224; S13-55; card line 9: "A
// message naming a card hold or a charge on silence fails the check"; RULES 3.2 to 3.4).
//
// Reading a card hold or a charge on silence from word patterns always left a new wording through, and so did every rule
// that needs two words to meet in one sentence. So one money word is enough (DL-187): a sentence that holds one passes
// only as words the record or the master already wrote. Listing the ways to hide a word one by one did not end either
// (rounds 4 and 5), so a character of a class that hides a word makes a money sentence too (DL-204 1). A class judged
// only on a folded form let the fold erase the very letter the class looks for (rounds 6 and 7), so every class is
// judged on the text as written, before any fold, as well as on the folded forms (DL-224 1).
//   - A sentence ends only at . ! ? or a line break; commas, dashes, parentheses, quotes and semicolons stay inside it.
//     Each sentence is judged alone, so a hold is never split away from its card: "We'll place a hold." is a money
//     sentence by "hold". It is read after the apostrophe folding the Values check reads with (values.ts: ’ and ‘ as
//     '), with the modifier letter apostrophe and the okina (U+02BC, U+02BB) folded the same way (DL-214 3), in lower
//     case.
//   - A money sentence holds one money word: a word that begins with charg, bill, pay, paid, cost, pric, refund,
//     deposit, debit, auth (authori, authed, pre-authed: DL-194 2), hold, held, owe, deduct, invoic, withdraw, fund,
//     dollar, buck, money or amount; the whole word fee, fees, cent or cents; a word that ends in card or cards
//     (Mastercard, postcard); a money sign anywhere: every Unicode currency sign ($, €, £, ¢, ¥, ₹, ₩ and ₽ among them), a
//     currency code said as a word (USD, EUR, GBP, CHF, CAD, AUD; DL-194 2) or a money emoji (💲 💳 💰 💵 💴 💶 💷 💸 🤑;
//     DL-204 2a, default 14); or a K-03 money slot. A stem counts only at the start of a word, so "feel", "coffee",
//     "recently" and "percent" are no money words. Round 3's pairs still make one too (default 4).
//   - A money sentence is also one that holds, anywhere, a character that hides a word (DL-204 1), whatever closes or
//     follows it. Each class is judged in every text the sentence is read from (as written, joined and split), as
//     written before any fold and after the folds (DL-224 1, default 16), so no fold erases what a class looks for:
//       a. a bidi control: U+061C, U+200E, U+200F, U+202A to U+202E or U+2066 to U+2069; or any other default-ignorable
//          code point (DL-224 2, default 16): the soft hyphen, the combining grapheme joiner, the zero-width space,
//          non-joiner and joiner, the word joiner and the invisible operators, the variation selectors, the zero-width
//          no-break space, the tags, the Hangul fillers, and the code points Unicode keeps default-ignorable while it
//          assigns them nothing (U+2065, U+FFF0 to U+FFF8 and most of U+E0000 to U+E0FFF);
//       b. a compatibility letter: a character whose NFKC form differs from its NFC form and holds a letter (fullwidth,
//          mathematical, circled, squared, parenthesized, modifier, superscript and subscript letters, ligatures, and
//          ™ ℠ ᵗᵐ ˢᴹ ᴹᴰ); a compatibility character that holds no letter ("…", a no-break space, "½") is none;
//       c. a letter-shaped character with no plain form: a Latin small capital (U+1D00 to U+1D22, and ʙ ɢ ʜ ɪ ʟ ɴ ʀ ʏ ɶ;
//          default 11) or a negative circled or negative squared letter (U+1F150 to U+1F169, U+1F170 to U+1F189);
//       d. a word that mixes Latin letters with letters of another script (Cyrillic, Greek or any other), digits between
//          or not (DL-214 1): a word is read as letters, marks, digits, @ and $ together, in every text the sentence is
//          read from (as written, joined and split: default 10), so "h0ld" with an Armenian h (U+0570) or "c4rd" with a
//          Coptic c (U+2CA5) is one; before NFKD as well as after it (DL-224 1), so "hold" with the Greek ypogegrammeni
//          (U+037A) or an Arabic isolated form (U+FE70) after its h is one too, though NFKD reads each of those letters
//          as a space and marks; a word whose letters are all in one script, such as a Greek or Cyrillic name, is none,
//          and so is a Latin word with marks, since a mark is no letter;
//       e. a control character other than tab, line feed and carriage return: C0 (U+0000 to U+0008, U+000B, U+000C,
//          U+000E to U+001F) or C1 (U+0080 to U+009F; DL-214 2), and DEL (U+007F; default 15).
//   - Money words, and the hold and silence words of the labels, are found in every reading form of a sentence, and one
//     in any form counts (DL-194, DL-204 2):
//       - the folded form (default 8: NFKD, marks, invisible format characters and default-ignorable code points left
//         out, look-alike letters read as Latin ones, 1c's letters read as the letters they show) and the reading form
//         in lower case (DL-194 1), both with trademark marks (™ ℠ ® © ᵀᴹ) read as word ends and bidi controls left out;
//       - of the sentence as written, where every space separator splits words; with every space separator but U+0020,
//         and every control character but line feed and carriage return, left out, so the words it splits read
//         joined; and with each of those read as a space, so it splits words (DL-204 2b, DL-214 2, default 10); and,
//         when it holds a bidi control, as the controls show it and backwards whole (default 9);
//       - and each of those with every word that mixes letters and digits read with its digits as letters (DL-204 2c:
//         0 as o, 1 as l and as i, 3 as e, 4 as a, 5 as s, 7 as t, 8 as b, @ as a, $ as s; default 12).
//   - A money sentence passes only if it is, word for word, a sentence of an approved line, each slot standing for the
//     value the slot filler gave it: one of the record's rows (both flows), S13-55's own lines or a message text of
//     either master flow.
//   - Every other money sentence fails, a denial included: neverHold when it holds a hold word (hold, held, authori ...),
//     neverChargeOnSilence when it names a reply, an answer, a confirmation, a response or silence, otherwise
//     moneyNotFromRecord.
// A false refusal costs a fallback (one rewrite, then the fixed words), never a wrong promise: a time the model says it
// is "holding" falls back to the approved wording, since Rosie's word for a time is "saved". Approved lines then go
// through the claim check (claims.ts) for the booking at hand. What comes back holds labels only, never the words.
//
// Residual risk, a closed form (DL-204 4, widened by DL-214 4 and DL-224 3; CQ-120): a wording with no money word, sign
// or slot in any reading form above and none of DL-204 1's characters (a to e) in any form a class is judged in is not
// caught here. That is a card hold or a charge on silence said in other words ("We'll put a temporary stop on your
// plastic until the visit.", "If we don't hear back by 7pm, it goes through anyway."), a word parted by a plain space or
// a mark a reader sees ("ch arge", "ch-arge"), a digit or sign DL-204 2c does not read as a letter ("char9e"), a
// letter-shaped symbol outside 1c's two lists (○ for o, ℮ for e, regional indicator letters), and, by DL-214 4:
//   - a whole word in a script the fold does not read as Latin: Lisu letters that show HOLD (U+A4E7 U+A4F3 U+A4E1
//     U+A4D3), Cherokee letters that show CARD (U+13DF U+13AA U+13A1 U+13A0); a word whose letters are all in such a
//     script is one with a digit among them too (those Lisu letters with a 0 for the O), since 1d needs a Latin letter
//     in the word;
//   - a Latin letter NFKD leaves alone, standing for a plain one: h, b, l with a stroke or bar and the dental click
//     (U+0127, U+0180, U+019A, U+01C0) in "hold" or "bill";
//   - another script's digit shaped like a letter: the Arabic-Indic five (U+0665), shaped like an o, which default 12
//     reads as 5 ("h", U+0665, "ld");
//   - and, by DL-224 3, a word that mixes two scripts other than Latin: Armenian letters with Cyrillic ones that show
//     "hold" ("հօӏԁ": U+0570 U+0585 U+04CF U+0501), since 1d needs a Latin letter in the word and only the folded
//     form, which 1d is never judged on (default 16), reads the Cyrillic look-alikes as Latin ("հօld").
// The composer prompt rule (STATE note 56: money sentences come from the record's rows, filled by T-310, never the
// model's own) and the Values check (an amount needs a fact) back it up.
//
// Defaults (each fail-closed):
//   1. A sentence ends at . ! ? only before a space or the end of the text, so "$40.00" and "rosfield.com" end none;
//      "7 p.m." reads "7pm". A slot is read whole: words inside its braces never end a sentence.
//   2. Approved lines are read sentence by sentence, as a message is: a message's money sentence passes when it is one
//      sentence of an approved line, compared with runs of spaces as one, each slot written {{name}} and its end marks
//      left out.
//   3. A slot stands for the value the slot filler gave it (finalParts.slotValues), filled into the approved sentence
//      that holds it, never re-split after filling; a slot given no value matches only the slot as written. A value that
//      holds a sentence end (. ! ? before a space or its end, or a line break) is refused: it stands for no slot, so a
//      money sentence that holds it is no approved line. A value stands for its slot alone, never for words around it.
//   4. Forms of the listed money words that do not begin with the stem's letters count too: a stem after un, non, pre,
//      re, post, over, under, sur, with, co, auto, mis, up, down or e (unauthorized, prepaid, surcharge, withhold, copay,
//      upcharge, pre-authed), owing, withdrew and cardholder. Round 3's money sentences stay money sentences, read in
//      every form a money word is read in: a hold, charge or other money action word (reserve, block, freeze, set or put
//      aside, keep, collect, take ...) with a money object (an amount also in words, "40 euros"), a card with an amount,
//      a reply, an answer or silence with a charge or other money action word. Money slots are K-03's money slots,
//      {{keep}} and the money home's slots (pay.*, clock.pay, link.pay).
//   5. Hold words, for the label: a word that begins with hold, held or auth (with a prefix of default 4: authorize,
//      authed, pre-auth, pre-authed), reserve, block, freeze, set or put aside. Silence words, for the label: reply,
//      answer, confirm, respond, response, responsive and silence in any form (unanswered, unconfirmed, unresponsive),
//      hear, heard, ignore, "no word", and "text back", "write back", "get back" or "call back". Both are read in every
//      form a money word is read in.
//   6. A sentence that names a reply, an answer or silence and asks or trails off ("No reply by 7pm?") reads with the
//      sentence after it, as round 2 read it; such a pair passes only when each of its sentences is approved.
//   7. A message text is every string of a step's say and of its variants' say and addSay (words, plain text and
//      elements), and the step's fallback text; S13-55's own lines are the money home step's does, more and rule.
//   8. Money words are found as a person reads them (foldedForm): compatibility forms as their plain letters and signs
//      (a fullwidth ＄ is $), combining marks, invisible format characters and default-ignorable code points left out
//      (a soft hyphen, a zero-width space or an unassigned default-ignorable code point such as U+2065 inside "charge";
//      DL-224 2), Cyrillic and Greek letters that look like Latin ones read as those ("сharge" with a Cyrillic с),
//      and 1c's letters as the letters they show (default 11). The reading form in lower case is read beside it
//      (DL-194 1), so a sign NFKD turns into letters (№, 🅪, ₨) hides no word either. The claim check reads its claims
//      in the folded form of each text the gate reads (foldedForms: defaults 9, 10 and 12), where NFKD reads most
//      space separators as a space. Approved sentences are still compared as written (default 2).
//   9. A text that holds a bidi control is also read as its controls show it (UAX #9, simplified): embeddings, overrides
//      and isolates nest and set each character's level; a pop (U+202C) ends the latest embedding or override, an
//      isolate's end (U+2069) ends the isolate and every one opened inside it, and a line break ends them all; an
//      override shows its characters in its own direction, any other character reads left to right as a Latin letter
//      does; then each run, from the highest level down to the lowest odd one, is shown reversed. So "egrahc" after
//      U+202E reads "charge" whether U+202C, U+2069 or the line's end closes it, and an override nested in another
//      shows its own run in its own place. The text is also read backwards whole, its controls left out.
//   10. A word split by a space separator other than U+0020 (DL-204 2b), a tab, vertical tab, form feed, line or
//       paragraph separator, the braille blank (DL-194 2), a Hangul filler (letters that show as a blank) or any other
//       control character but line feed and carriage return (DL-214 2) is read both ways: joined ("ch arge" with a hair
//       space reads "charge"), and split, each of them read as a space, so two words with such a space between them
//       ("the fee") keep each its own reading, a Hangul filler's too.
//   11. The other letters Unicode names Latin small capitals (U+0281, U+029B, U+1D7B, U+1D7E, U+A730, U+A731, U+A7AE,
//       U+A7AF, U+A7FA: ʁ ʛ ᵻ ᵾ ꜰ ꜱ Ɪ ꞯ ꟺ) are 1c's too, and a capital whose small letter is one of them (U+01A6) is read
//       in lower case. Each of 1c's letters is read as the letter it shows (🅷🅾🅻🅳 reads "hold", ᴄʜᴀʀɢᴇ "charge"), so
//       its money word and its label are read too.
//   12. A decimal digit of any script is read by its value (a Devanagari zero as 0, so as o). A word that mixes letters
//       and digits is also read with every 1, i and l as l, against money and label words read the same way, so a
//       word whose 1s stand for both letters ("b1l1") reads as one of them.
//   13. A slot value that holds a bidi control, or a control character of DL-214 2 (1e), is refused, as one that holds
//       a sentence end is (default 3): a control reorders or changes what follows it, past the value. A value with
//       DL-204 1b to 1d's characters, or a default-ignorable code point that is no bidi control (DL-224 2: a variation
//       selector after an emoji, a joiner inside one), stands for its slot ("Acme™"), since what such a character hides
//       ends with the value; the sentence that holds it is a money sentence, which passes only as an approved line
//       with the value standing for its slot.
//   14. The money emoji are U+1F4B0 to U+1F4B8 (DL-204 2a's eight there, and 💱) and 🤑 (U+1F911).
//   15. DEL (U+007F), a control character between C0 and C1, counts with DL-214 2's (1e). None of them is read as a
//       space where a sentence is cut out and compared, VT and FF (U+000B, U+000C) included, and neither is the
//       zero-width no-break space (U+FEFF), a default-ignorable code point of DL-224 2 that JavaScript's white space
//       holds: they never end a sentence, are never trimmed from one, never fold away in "7 p.m." and stay in its
//       compared form. So each is always inside a sentence, and an approved line with one in it is another sentence.
//   16. DL-224's forms and characters. Each class of DL-204 1 is judged in each text a sentence is read from (as
//       written, joined, split, and as its bidi controls show it and backwards: defaults 9 and 10), in four forms: the
//       reading form as written and in lower case (its apostrophes and "7 p.m." folded as defaults 1 and 8 read them,
//       which folds no character of a class), the reading form in lower case with its trademark marks read as word
//       ends and its bidi controls left out (lowerForm), and the plain form after NFKD (plainForm, the form round 7
//       judged 1d on). 1d is never judged on the folded form, which reads look-alike letters as Latin ones, so a Greek
//       or Cyrillic name stays none. Every default-ignorable code point counts in 1a: DL-224 2 names those other than
//       the joiners rounds 5 to 7 read, and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the joiners among
//       them, count as well, so the class is the property whole, whichever characters "the joiners" names; they are
//       still read joined and split too (default 10).

import { pieces, type Piece } from "../../finalize/slots/syntax";
import { VOCABULARY } from "../../finalize/slots/vocabulary";
import type { ClaimRefusal } from "./claims";
import { MoneyHomeError, readMoneyRecord, type FlowLetter, type MoneyRecord } from "./record";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * White space read as a space where a sentence is cut out and compared: every kind but VT and FF (U+000B, U+000C),
 * which are DL-214 2's control characters, and the zero-width no-break space (U+FEFF), a default-ignorable code point of
 * DL-224 2 that JavaScript's white space holds: each stays in the sentence as written (default 15).
 */
const SPACE = String.raw`[^\S\v\f\u{FEFF}]`;

/**
 * The apostrophes read as ' (DL-214 3): ’ and ‘ (U+2019, U+2018), as values.ts wordForm and matchForm read them, and the
 * modifier letter apostrophe and the okina (U+02BC, U+02BB), letters of the Common script that 1d would otherwise read
 * as another script's ("don" U+02BC "t").
 */
const APOSTROPHES = /[\u{2019}\u{2018}\u{2BC}\u{2BB}]/gu;

/** "7 p.m." and "7 a.m.", with no control character between (default 15). */
const POINTED_TIME = new RegExp(String.raw`(\d)${SPACE}*([ap])\.m\.?`, "giu");

/**
 * The form money words are read in: the apostrophe folding the Values check reads with (values.ts wordForm and
 * matchForm: ’ and ‘ read as '), so "don’t" is "don't", with the modifier letter apostrophe and the okina folded the
 * same way (DL-214 3); and "7 p.m." read as "7pm", so its points end no sentence.
 */
export function readingForm(text: string): string {
  return text.replace(APOSTROPHES, "'").replace(POINTED_TIME, "$1$2m");
}

/**
 * Letters that look like Latin ones, in lower case, and the Latin letter each reads as (default 8). The keys are
 * Cyrillic letters, then Greek ones, then Latin letters NFKD leaves as they are (dotless i, script a and g).
 */
const LOOKALIKE: ReadonlyMap<string, string> = new Map(
  Object.entries({
    а: "a",
    в: "b",
    ь: "b",
    с: "c",
    ԁ: "d",
    е: "e",
    һ: "h",
    н: "h",
    і: "i",
    ј: "j",
    к: "k",
    ӏ: "l",
    м: "m",
    п: "n",
    о: "o",
    р: "p",
    ԛ: "q",
    г: "r",
    ѕ: "s",
    т: "t",
    у: "y",
    ү: "y",
    х: "x",
    ԝ: "w",
    α: "a",
    β: "b",
    ϲ: "c",
    ε: "e",
    η: "h",
    ι: "i",
    ϳ: "j",
    κ: "k",
    μ: "m",
    ν: "v",
    ο: "o",
    ρ: "p",
    τ: "t",
    υ: "u",
    χ: "x",
    ı: "i",
    ɑ: "a",
    ɡ: "g",
  }),
);

/**
 * Trademark and similar marks (DL-194 1): ᵀᴹ (U+1D40 U+1D39), ™ (U+2122), ℠ (U+2120), ® (U+00AE) and © (U+00A9). Each
 * ends a word and is never a letter, so "Mastercard™" holds "card".
 */
const TRADE_MARKS = /\u{1D40}\u{1D39}|[\u{2122}\u{2120}\u{AE}\u{A9}]/gu;

/**
 * Bidi controls (DL-194 2, DL-204 1a): the Arabic letter mark U+061C, the marks U+200E and U+200F, the embeddings and
 * overrides U+202A to U+202E and the isolates U+2066 to U+2069.
 */
const BIDI = String.raw`[\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]`;
const BIDI_CONTROL = new RegExp(BIDI, "u");
const BIDI_CONTROLS = new RegExp(BIDI, "gu");

/**
 * DL-214 2 (1e): a control character other than tab, line feed and carriage return, C0 or C1, and DEL between them
 * (default 15). A sentence that holds one is a money sentence, wherever it stands.
 */
const CONTROL = /(?![\t\n\r])\p{Cc}/u;

/**
 * DL-224 2 (1a): a default-ignorable code point, Unicode's Default_Ignorable_Code_Point, every one (default 16). A
 * sentence that holds one is a money sentence, wherever it stands; the plain form leaves each out, so the words one
 * parts read joined (default 8).
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const DEFAULT_IGNORABLES = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * What a word split by one is read joined across, and split at, too (DL-204 2b, DL-214 2, default 10): every space
 * separator but U+0020, every control character but line feed and carriage return (a tab, vertical tab and form feed
 * among them), a line or paragraph separator, the braille blank and the Hangul fillers.
 */
const JOINING = /(?![\n\r\u{20}])[\p{Zs}\p{Cc}\u{2028}\u{2029}\u{2800}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/** A text with its trademark marks read as word ends and its bidi controls removed (DL-194 1 and 2). */
function unmarked(text: string): string {
  return text.replace(TRADE_MARKS, " ").replace(BIDI_CONTROLS, "");
}

/**
 * The reading form in lower case, its marks read as word ends and its bidi controls removed, compatibility forms as
 * their plain letters and signs (a fullwidth ＄ is $), combining marks, invisible format characters and default-ignorable
 * code points left out (default 8; DL-224 2).
 */
function plainForm(text: string): string {
  return unmarked(readingForm(text))
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(DEFAULT_IGNORABLES, "")
    .toLowerCase();
}

/**
 * The reading form in lower case, before NFKD (DL-194 1), its marks read as word ends and its bidi controls removed: a
 * sign NFKD turns into letters glued to a word ("Fee№" folded is "feeno") leaves the word whole here.
 */
function lowerForm(text: string): string {
  return unmarked(readingForm(text)).toLowerCase();
}

/** Any one of the look-alike letters. */
const LOOKALIKE_LETTER = new RegExp(`[${[...LOOKALIKE.keys()].join("")}]`, "gu");

/**
 * DL-204 1c: letter-shaped characters with no plain form. The Latin small capitals U+1D00 to U+1D22 and ʙ ɢ ʜ ɪ ʟ ɴ ʀ ʏ ɶ
 * (U+0299, U+0262, U+029C, U+026A, U+029F, U+0274, U+0280, U+028F, U+0276), and default 11's (U+0281, U+029B, U+1D7B,
 * U+1D7E, U+A730, U+A731, U+A7AE, U+A7AF, U+A7FA); the negative circled letters U+1F150 to U+1F169 and the negative
 * squared letters U+1F170 to U+1F189.
 */
const NO_PLAIN_FORM = String.raw`[\u{1D00}-\u{1D22}\u{0299}\u{0262}\u{029C}\u{026A}\u{029F}\u{0274}\u{0280}\u{028F}\u{0276}\u{0281}\u{029B}\u{1D7B}\u{1D7E}\u{A730}\u{A731}\u{A7AE}\u{A7AF}\u{A7FA}\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]`;
const NO_PLAIN_LETTER = new RegExp(NO_PLAIN_FORM, "u");
const NO_PLAIN_LETTERS = new RegExp(NO_PLAIN_FORM, "gu");

/** The letters U+1D00 to U+1D22 show, in order (default 11): a turned or sideways letter reads as its letter. */
const SMALL_CAPITAL_RUN = "a ae ae b c d d e e i j k l m n o o o o o oe ou o o p r r t u u u m v w z".split(
  " ",
);

/** The letters the other Latin small capitals show, by code point (1c's list, then default 11's). */
const SMALL_CAPITALS: ReadonlyMap<number, string> = new Map([
  [0x0299, "b"],
  [0x0262, "g"],
  [0x029c, "h"],
  [0x026a, "i"],
  [0x029f, "l"],
  [0x0274, "n"],
  [0x0280, "r"],
  [0x028f, "y"],
  [0x0276, "oe"],
  [0x0281, "r"],
  [0x029b, "g"],
  [0x1d7b, "i"],
  [0x1d7e, "u"],
  [0xa730, "f"],
  [0xa731, "s"],
  [0xa7ae, "i"],
  [0xa7af, "q"],
  [0xa7fa, "m"],
]);

/** The letter one of 1c's characters shows (default 11): a negative circled or squared letter its own, a small capital its. */
function shownLetter(char: string): string {
  const point = char.codePointAt(0) ?? 0;
  if (point >= 0x1f150 && point <= 0x1f169) return String.fromCodePoint(0x61 + point - 0x1f150);
  if (point >= 0x1f170 && point <= 0x1f189) return String.fromCodePoint(0x61 + point - 0x1f170);
  if (point >= 0x1d00 && point <= 0x1d22) return SMALL_CAPITAL_RUN[point - 0x1d00] ?? char;
  return SMALL_CAPITALS.get(point) ?? char;
}

/**
 * The form money words are found in (default 8): the plain form, with look-alike letters read as Latin ones and 1c's
 * letters as the letters they show (default 11).
 */
export function foldedForm(text: string): string {
  return plainForm(text)
    .replace(LOOKALIKE_LETTER, (letter) => LOOKALIKE.get(letter) ?? letter)
    .replace(NO_PLAIN_LETTERS, (char) => shownLetter(char));
}

/** A letter of any script. */
const LETTER = /\p{L}/u;

/** DL-204 1b: a compatibility letter, a character whose NFKC form differs from its NFC form and holds a letter. */
function isCompatibilityLetter(char: string): boolean {
  if ((char.codePointAt(0) ?? 0) < 0x80) return false;
  const compatible = char.normalize("NFKC");
  return compatible !== char.normalize("NFC") && LETTER.test(compatible);
}

/** A Latin letter, and a letter of any other script, or of none (DL-204 1d). */
const LATIN_LETTER = /\p{Script=Latin}/u;
const OTHER_LETTER = /[^\P{L}\p{Script=Latin}]/u;

/**
 * DL-204 1d: does a word of a form mix Latin letters with letters of another script, digits between or not? A word is
 * read as DIGIT_WORD reads it, letters, marks, digits, @ and $ together (DL-214 1). A word whose letters are all in one
 * script (a Greek or Cyrillic name) is none, and so is a Latin word with marks: a mark is no letter.
 */
function mixesScripts(form: string): boolean {
  return (form.match(DIGIT_WORD) ?? []).some((word) => LATIN_LETTER.test(word) && OTHER_LETTER.test(word));
}

/**
 * Does a form hold a character of DL-204 1a to 1c or of DL-214 2 (1e): a bidi control or another default-ignorable code
 * point (a; DL-224 2), a compatibility letter (b), a letter-shaped character with no plain form (c) or a control
 * character other than tab, line feed and carriage return (e)?
 */
function holdsHidingCharacter(form: string): boolean {
  return (
    BIDI_CONTROL.test(form) ||
    DEFAULT_IGNORABLE.test(form) ||
    CONTROL.test(form) ||
    Array.from(form).some((char) => isCompatibilityLetter(char)) ||
    NO_PLAIN_LETTER.test(form)
  );
}

/**
 * The forms DL-204 1's classes are judged in (DL-224 1, default 16): each text a sentence is read from (textsOf: as
 * written, joined and split, and as its bidi controls show it and backwards), in the reading form as written and in
 * lower case, before any fold; in lower case with its trademark marks read as word ends and its bidi controls left out
 * (lowerForm); and after NFKD (plainForm). The form before each fold is judged as well as the fold, so no fold erases a
 * character a class looks for. None reads look-alike letters as Latin ones, so a Greek or Cyrillic name mixes nothing.
 */
function classForms(text: string): string[] {
  return [
    ...new Set(
      textsOf(text).flatMap((one) => {
        const written = readingForm(one);
        return [written, written.toLowerCase(), lowerForm(one), plainForm(one)];
      }),
    ),
  ];
}

/** A character beyond printable ASCII: a text of printable ASCII alone holds none of DL-204 1's characters. */
const BEYOND_ASCII = /[^\u{20}-\u{7E}]/u;

/**
 * Does a text hold a character that hides a word (DL-204 1, DL-214 2, DL-224): a bidi control or another
 * default-ignorable code point (a), a compatibility letter (b), a letter-shaped character with no plain form (c, in
 * lower case too: default 11), a word that mixes Latin letters with another script's (d) or a control character other
 * than tab, line feed and carriage return (e), in any form a class is judged in (classForms)?
 */
function hidesWord(text: string): boolean {
  if (!BEYOND_ASCII.test(text)) return false;
  return classForms(text).some((form) => holdsHidingCharacter(form) || mixesScripts(form));
}

/** The letter each digit or sign is also read as in a word that mixes letters and digits (DL-204 2c); 1 is l and i. */
const DIGIT_LETTERS: ReadonlyMap<string, string> = new Map([
  ["0", "o"],
  ["3", "e"],
  ["4", "a"],
  ["5", "s"],
  ["7", "t"],
  ["8", "b"],
  ["@", "a"],
  ["$", "s"],
]);

/** A word, for reading digits as letters: a run of letters, marks, digits, @ and $. */
const DIGIT_WORD = /[\p{L}\p{M}\p{Nd}@$]+/gu;
const DIGIT = /\p{Nd}/u;
const DIGIT_OR_SIGN = /[\p{Nd}@$]/u;

/** Does a word mix letters and digits (DL-204 2c): a letter, and a digit, @ or $? */
function mixesDigits(word: string): boolean {
  return LETTER.test(word) && DIGIT_OR_SIGN.test(word);
}

/**
 * The value of a decimal digit of any script (default 12): Unicode writes each script's digits 0 to 9 in a row, so the
 * value is the count of digits just before it, modulo 10.
 */
function digitValue(digit: string): string {
  let point = digit.codePointAt(0) ?? 0;
  let before = 0;
  while (point > 0 && DIGIT.test(String.fromCodePoint(point - 1))) {
    point -= 1;
    before += 1;
  }
  return String(before % 10);
}

/** A word read with its digits as letters (DL-204 2c), each 1 as `one`. */
function digitsRead(word: string, one: string): string {
  return Array.from(word, (char) => {
    const digit = DIGIT.test(char) ? digitValue(char) : char;
    return digit === "1" ? one : (DIGIT_LETTERS.get(digit) ?? digit);
  }).join("");
}

/** A form with every word that mixes letters and digits read with its digits as letters, each 1 as `one`. */
function digitsAsLetters(form: string, one: string): string {
  return form.replace(DIGIT_WORD, (word) => (mixesDigits(word) ? digitsRead(word, one) : word));
}

/** The digit readings of a form (DL-204 2c): every 1 as l, then every 1 as i; none when no word mixes letters and digits. */
function digitForms(form: string): string[] {
  if (!DIGIT_OR_SIGN.test(form)) return [];
  return (form.match(DIGIT_WORD) ?? []).some(mixesDigits)
    ? [digitsAsLetters(form, "l"), digitsAsLetters(form, "i")]
    : [];
}

/** A word read the skeleton's way (default 12): i as l, so a 1 read as l stands for both. */
function skeleton(word: string): string {
  return word.replaceAll("i", "l");
}

/** The words of a form that mix letters and digits, each with its digits as letters and every 1, i and l as l (default 12). */
function skeletonWords(form: string): string {
  if (!DIGIT_OR_SIGN.test(form)) return "";
  return (form.match(DIGIT_WORD) ?? [])
    .filter(mixesDigits)
    .map((word) => skeleton(digitsRead(word, "l")))
    .join(" ");
}

/** A text read backwards, every run of it as an override would show it (default 9). */
function backwards(text: string): string {
  return Array.from(text).reverse().join("");
}

/** An entry of the directional status (UAX #9 X1 to X8, simplified): its level, its override, whether an isolate. */
interface Embedding {
  readonly level: number;
  readonly override: "L" | "R" | null;
  readonly isolate: boolean;
}

/** What an embedding, override or isolate opens: its direction, its override and whether it is an isolate. */
interface Opening {
  readonly rightToLeft: boolean;
  readonly override: "L" | "R" | null;
  readonly isolate: boolean;
}

/** The controls that open an embedding (U+202A, U+202B), an override (U+202D, U+202E) or an isolate (U+2066 to U+2068). */
const OPENS: ReadonlyMap<string, Opening> = new Map<string, Opening>([
  ["\u{202A}", { rightToLeft: false, override: null, isolate: false }],
  ["\u{202B}", { rightToLeft: true, override: null, isolate: false }],
  ["\u{202D}", { rightToLeft: false, override: "L", isolate: false }],
  ["\u{202E}", { rightToLeft: true, override: "R", isolate: false }],
  ["\u{2066}", { rightToLeft: false, override: null, isolate: true }],
  ["\u{2067}", { rightToLeft: true, override: null, isolate: true }],
  // The first-strong isolate reads as a left-to-right one: what it holds is read as Latin letters.
  ["\u{2068}", { rightToLeft: false, override: null, isolate: true }],
]);

/** The pop of an embedding or override (U+202C) and the end of an isolate (U+2069). */
const POP = "\u{202C}";
const ISOLATE_END = "\u{2069}";

/** UAX #9's deepest embedding level. */
const DEEPEST = 125;

/** The least level above a level that is odd (right to left) or even (left to right). */
function levelAbove(level: number, rightToLeft: boolean): number {
  const odd = level % 2 === 1;
  return odd === rightToLeft ? level + 2 : level + 1;
}

/** Where the latest isolate stands in the directional status, or -1 when none is open. */
function latestIsolate(stack: readonly Embedding[]): number {
  for (let at = stack.length - 1; at > 0; at -= 1) if (stack[at]?.isolate === true) return at;
  return -1;
}

/** Items from start to end (not included) put in the other order, in their place. */
function reverseIn(items: unknown[], start: number, end: number): void {
  items
    .slice(start, end)
    .reverse()
    .forEach((item, offset) => {
      items[start + offset] = item;
    });
}

/** Characters at their levels as they show (UAX #9 L2): from the highest level down to the lowest odd one, each run at that level or above reversed. */
function reordered(chars: readonly string[], levels: readonly number[]): string {
  const shownChars = [...chars];
  const at = [...levels];
  const highest = at.reduce((high, level) => Math.max(high, level), 0);
  const lowest = at.reduce((low, level) => Math.min(low, level), highest);
  const lowestOdd = lowest % 2 === 1 ? lowest : lowest + 1;
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let start = 0;
    while (start < shownChars.length) {
      if ((at[start] ?? 0) < level) {
        start += 1;
        continue;
      }
      let end = start;
      while (end < shownChars.length && (at[end] ?? 0) >= level) end += 1;
      reverseIn(shownChars, start, end);
      reverseIn(at, start, end);
      start = end;
    }
  }
  return shownChars.join("");
}

/**
 * One line as its bidi controls show it (default 9; UAX #9 X1 to X8, I1, I2 and L2, simplified): each control opens,
 * pops or ends an entry of the directional status; an override shows its characters in its own direction, any other
 * character reads left to right; the marks (U+061C, U+200E, U+200F) and the controls are left out.
 */
function shownLine(line: string): string {
  const stack: Embedding[] = [{ level: 0, override: null, isolate: false }];
  let overflowIsolates = 0;
  let overflowEmbeddings = 0;
  const chars: string[] = [];
  const levels: number[] = [];
  for (const char of line) {
    const top = stack[stack.length - 1] ?? { level: 0, override: null, isolate: false };
    const opening = OPENS.get(char);
    if (opening !== undefined) {
      const level = levelAbove(top.level, opening.rightToLeft);
      if (level <= DEEPEST && overflowIsolates === 0 && overflowEmbeddings === 0)
        stack.push({ level, override: opening.override, isolate: opening.isolate });
      else if (opening.isolate) overflowIsolates += 1;
      else if (overflowIsolates === 0) overflowEmbeddings += 1;
      continue;
    }
    if (char === ISOLATE_END) {
      const at = latestIsolate(stack);
      if (overflowIsolates > 0) overflowIsolates -= 1;
      else if (at > 0) {
        overflowEmbeddings = 0;
        stack.length = at;
      }
      continue;
    }
    if (char === POP) {
      if (overflowIsolates === 0 && overflowEmbeddings > 0) overflowEmbeddings -= 1;
      else if (overflowIsolates === 0 && stack.length > 1 && !top.isolate) stack.pop();
      continue;
    }
    if (BIDI_CONTROL.test(char)) continue;
    chars.push(char);
    const odd = top.level % 2 === 1;
    levels.push(odd === (top.override === "R") ? top.level : top.level + 1);
  }
  return reordered(chars, levels);
}

/** A text as its bidi controls show it (default 9), each line on its own: a line break ends every control. */
function shown(text: string): string {
  return text
    .split(/(\r\n?|[\n\u{85}\u{2029}])/u)
    .map((part, index) => (index % 2 === 1 ? part : shownLine(part)))
    .join("");
}

/**
 * The texts a text's words are read from: as written; with the words a space separator but U+0020, or a control
 * character but line feed and carriage return, splits joined; and with each of those read as a space, so it splits
 * words, a Hangul filler (a letter) too (DL-204 2b, DL-214 2, default 10); and, when it holds a bidi control, each of
 * those as its controls show it and backwards whole (default 9).
 */
function textsOf(text: string): string[] {
  const texts = [...new Set([text, text.replace(JOINING, ""), text.replace(JOINING, " ")])];
  return BIDI_CONTROL.test(text)
    ? [...texts, ...texts.flatMap((one) => [shown(one), backwards(one)])]
    : texts;
}

/**
 * The folded forms of a text (defaults 8 to 10 and 12): the folded form of each text it is read from, and each of those
 * with its words that mix letters and digits read with digits as letters. The claim check's forms.
 */
export function foldedForms(text: string): string[] {
  const folded = textsOf(text).map(foldedForm);
  return [...new Set([...folded, ...folded.flatMap(digitForms)])];
}

/**
 * The base forms a text's money words are read in (DL-194; defaults 8 to 10): the folded form and the reading form in
 * lower case of each text it is read from.
 */
function baseForms(text: string): string[] {
  return [...new Set(textsOf(text).flatMap((one) => [foldedForm(one), lowerForm(one)]))];
}

/** Every reading form (DL-204 2c): the base forms, and each with its words that mix letters and digits read as letters. */
function readForms(base: readonly string[]): string[] {
  return [...new Set([...base, ...base.flatMap(digitForms)])];
}

/**
 * Where a sentence ends inside plain words: after . ! ? before a space, or at a line break (default 1); never at a
 * control character (default 15).
 */
const SENTENCE_END = new RegExp(String.raw`(?<=[.!?])${SPACE}+|[\r\n]+`, "u");

/** Spaces at either edge of a text, never a control character (default 15). */
const EDGE_SPACES = new RegExp(`^${SPACE}+|${SPACE}+$`, "gu");

/** A text with the spaces at its edges left out, its control characters kept (default 15). */
function trimmed(text: string): string {
  return text.replace(EDGE_SPACES, "");
}

/** A text's sentences, in the reading form, each as its pieces: a slot is read whole, never cut by a sentence end. */
function sentencePieces(text: string): Piece[][] {
  const sentences: Piece[][] = [];
  let current: Piece[] = [];
  const close = (): void => {
    if (current.length > 0) sentences.push(current);
    current = [];
  };
  for (const piece of pieces(readingForm(text))) {
    if (piece.kind === "slot") {
      current.push(piece);
      continue;
    }
    piece.text.split(SENTENCE_END).forEach((part, index) => {
      if (index > 0) close();
      if (part !== "") current.push({ kind: "words", text: part });
    });
  }
  close();
  return sentences;
}

/** A sentence as written, its slots whole, trimmed (its control characters kept: default 15). */
function sentenceText(parts: readonly Piece[]): string {
  return trimmed(parts.map((piece) => (piece.kind === "slot" ? piece.ref.raw : piece.text)).join(""));
}

/** A text's sentences, in the reading form: one ends only at . ! ? (before a space or the end) or at a line break. */
export function sentencesOf(text: string): string[] {
  return sentencePieces(text)
    .map(sentenceText)
    .filter((sentence) => sentence !== "");
}

/** A part of a compared form: lower-case words, or a slot by its name. An approved sentence is filled from its parts. */
export type FormPart = string | { readonly slot: string };

function formParts(parts: readonly Piece[]): FormPart[] {
  return parts.map((piece) => (piece.kind === "slot" ? { slot: piece.ref.name } : piece.text.toLowerCase()));
}

/** Runs of spaces in a compared form, and its end marks, never a control character (default 15). */
const SPACES = new RegExp(`${SPACE}+`, "gu");
const END_MARKS = new RegExp(String.raw`(?:${SPACE}|[.!?])+$`, "u");

/** Runs of spaces as one, trimmed, the end marks left out; a control character stays as written (default 15). */
function compared(words: string): string {
  return trimmed(words.replace(SPACES, " ")).replace(END_MARKS, "");
}

/** Joins a compared form's parts, each slot given a value written as that value, any other as {{name}}. */
function joined(parts: readonly FormPart[], values: ReadonlyMap<string, string>): string {
  return compared(
    parts
      .map((part) => (typeof part === "string" ? part : (values.get(part.slot) ?? `{{${part.slot}}}`)))
      .join(""),
  );
}

const NO_VALUES: ReadonlyMap<string, string> = new Map();

/** A sentence as it is compared: lower case, each slot written {{name}}, spaces as one, its end marks left out. */
function comparedForm(parts: readonly Piece[]): string {
  return joined(formParts(parts), NO_VALUES);
}

// Round 4 (DL-187 1): one money word is enough. A stem counts at the start of a word (never after a letter), so
// "coffee", "recently" and "percent" hold none; a whole word (fee, cent) has no letter after it either, so "feel" is none.
const NOT_AFTER_LETTER = String.raw`(?<![\p{L}\p{M}])`;
const NOT_BEFORE_LETTER = String.raw`(?![\p{L}\p{M}])`;
/** The prefixes a money stem may carry (default 4): unauthorized, prepaid, surcharge, withhold, copay, upcharge. */
const STEM_PREFIXES = [
  "un",
  "non",
  "pre",
  "re",
  "post",
  "over",
  "under",
  "sur",
  "with",
  "co",
  "auto",
  "mis",
  "up",
  "down",
  "e",
];
/**
 * DL-187's stems, with auth for authori (DL-194 2: authed, pre-authed), and owing and withdrew (default 4), which do not
 * begin with the letters of owe and withdraw.
 */
const MONEY_STEMS = [
  "charg",
  "bill",
  "pay",
  "paid",
  "cost",
  "pric",
  "refund",
  "deposit",
  "debit",
  "auth",
  "hold",
  "held",
  "owe",
  "owing",
  "deduct",
  "invoic",
  "withdr[ae]w",
  "fund",
  "dollar",
  "buck",
  "money",
  "amount",
];
/** The currency codes said as a word that are money signs (DL-194 2). */
const CURRENCY_CODES = ["usd", "eur", "gbp", "chf", "cad", "aud"];
/** The money emoji (DL-204 2a, default 14): U+1F4B0 to U+1F4B8 and U+1F911. */
const MONEY_EMOJI = String.raw`[\u{1F4B0}-\u{1F4B8}\u{1F911}]`;
/** The hold stems of the label (DL-187 4, default 5). */
const HOLD_STEMS = ["hold", "held", "auth"];
/** The silence stems of the label (DL-187 4, default 5), and the prefixes they may carry. */
const SILENCE_STEMS = ["repl(?:y|ies|ied|ying)", "answer", "confirm", "respon(?:d|se|siv)", "silen"];
const SILENCE_PREFIXES = ["un", "non", "re"];

/** How the listed words are written in a pattern: as they are, or the skeleton's way (default 12). */
type WordReading = (word: string) => string;
const AS_WRITTEN: WordReading = (word) => word;

/** The optional prefix of a stem (default 4). */
function stemPrefix(read: WordReading): string {
  return `(?:(?:${STEM_PREFIXES.map(read).join("|")})-?)?`;
}

/**
 * One money word: a stem at the start of a word; fee, fees, cent or cents, or a currency code, as a whole word; a word
 * ending in card(s); a currency sign (Unicode Sc: $ € £ ¢ ¥ ₹ ₩ ₽ and every other; DL-194 2); a money emoji (DL-204 2a).
 */
function oneMoneyWord(read: WordReading): RegExp {
  return new RegExp(
    [
      `${NOT_AFTER_LETTER}${stemPrefix(read)}(?:${MONEY_STEMS.map(read).join("|")})`,
      `${NOT_AFTER_LETTER}(?:${["fees?", "cents?", ...CURRENCY_CODES].map(read).join("|")})${NOT_BEFORE_LETTER}`,
      `${read("card(?:holder)?s?")}${NOT_BEFORE_LETTER}`,
      String.raw`\p{Sc}`,
      MONEY_EMOJI,
    ].join("|"),
    "iu",
  );
}

/** Hold words, for the label (DL-187 4, default 5): a word that begins with hold, held or auth (authori, pre-auth). */
function holdStem(read: WordReading): RegExp {
  return new RegExp(`${NOT_AFTER_LETTER}${stemPrefix(read)}(?:${HOLD_STEMS.map(read).join("|")})`, "iu");
}

/** Silence words, for the label (DL-187 4, default 5): reply, answer, confirm, respond and silence, in any form. */
function silenceStem(read: WordReading): RegExp {
  return new RegExp(
    `${NOT_AFTER_LETTER}(?:(?:${SILENCE_PREFIXES.map(read).join("|")})-?)?(?:${SILENCE_STEMS.map(read).join("|")})`,
    "iu",
  );
}

const ONE_MONEY_WORD = oneMoneyWord(AS_WRITTEN);
const HOLD_STEM = holdStem(AS_WRITTEN);
const SILENCE_STEM = silenceStem(AS_WRITTEN);
/** The same words read the skeleton's way, for the words that mix letters and digits (default 12). */
const SKELETON_MONEY_WORD = oneMoneyWord(skeleton);
const SKELETON_HOLD_STEM = holdStem(skeleton);
const SKELETON_SILENCE_STEM = silenceStem(skeleton);

// Round 3's pairs (DL-182 1), kept: each sentence they made a money sentence stays one.

/** Hold words, any form (DL-182): hold (held, holding, hold onto, on hold), authorize or authorise (authorization,
 * pre-authorize, pre-auth), reserve, block, freeze, set aside, put aside. */
const HOLD_WORD = new RegExp(
  [
    String.raw`\b(?:pre-?|with)?(?:hold|holds|holding|held)\b`,
    String.raw`\b(?:pre-?|un)?authori[sz]\w*`,
    String.raw`\b(?:pre-?)?auths?\b`,
    String.raw`\breserv(?:e|es|ed|ing|ation|ations)\b`,
    String.raw`\b(?:un)?block(?:s|ed|ing)?\b`,
    String.raw`\b(?:un)?(?:freez(?:e|es|ing)|froze|frozen)\b`,
    String.raw`\b(?:set|sets|setting|put|puts|putting)(?:\s+\S+){0,3}?\s+aside\b`,
  ].join("|"),
  "iu",
);
/** Charge words, any form (DL-182): charge, bill, debit, collect, take. */
const CHARGE_WORD =
  /\b(?:(?:sur|re|over|pre-?)?charg(?:e|es|ed|ing)|(?:pre-?)?bill(?:s|ed|ing)?|debit(?:s|ed|ing)?|collect(?:s|ed|ing|ion|ions)?|take|takes|taking|took|taken)\b/iu;
/** The other money action words, any form (DL-182: keep, kept, pay, paid, refund, refunded), and owe, deduct, withdraw, invoice. */
const OTHER_ACTION =
  /\b(?:keep|keeps|keeping|kept|(?:pre-?|re|un|over|under)?pa(?:y|ys|ying|id|yable)|(?:non-?)?refund\w*|owe|owes|owed|owing|deduct\w*|withdr[ae]w\w*|invoic\w*)\b/iu;
/** A reply, an answer or silence, any form (DL-182: reply, answer, respond, response, hear, silence, silent, no word,
 * ignore), and a reply said as "text back", "write back", "get back" or "call back". */
const SILENCE_WORD =
  /\b(?:repl(?:y|ies|ied|ying)|(?:un)?answer(?:s|ed|ing)?|respond(?:s|ed|ing)?|responses?|hear(?:s|d|ing)?|silen(?:ce|t|tly)|no\s+word|ignor(?:e|es|ed|ing))\b|\b(?:text|texts|texted|texting|write|writes|wrote|writing|get|gets|got|getting|call|calls|called|calling)\s+back\b/iu;

/** A card (a saved card, a card on file) or a payment method. */
const CARD = /\bcards?\b|\bpayment\s+methods?\b/iu;
/** An amount in $, € or £, or in words ("40 dollars", "USD 40"). */
const AMOUNT =
  /[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|euros?|pounds?|usd|eur|gbp)\b|\b(?:usd|eur|gbp)\s?\d/iu;
/** Money named: a deposit, a fee, a payment, funds, an amount, money. */
const MONEY_NAMED = /\b(?:deposits?|fees?|(?:pre-?)?payments?|funds?|amounts?|money)\b/iu;
/** The slots that stand for money (in the compared form, {{name}}): K-03's money slots, {{keep}}, the money home's slots. */
const MONEY_SLOT_NAMES: readonly string[] = [
  ...new Set([
    ...VOCABULARY.filter((slot) => slot.valueType === "money" || /^pay\.|\.pay$/u.test(slot.name)).map(
      (slot) => slot.name,
    ),
    "keep",
  ]),
];
const MONEY_SLOT = new RegExp(
  String.raw`\{\{(?:${MONEY_SLOT_NAMES.map((name) => name.replace(/\./gu, String.raw`\.`)).join("|")})\}\}`,
  "u",
);

/** Round 3's money sentence (DL-182 1), read on the compared form: a money action word with a money object, a card with
 * an amount or a money slot, or a reply, an answer or silence with a charge or other money action word or object. */
function pairedMoney(form: string): boolean {
  const hold = HOLD_WORD.test(form);
  const silence = SILENCE_WORD.test(form);
  const charge = CHARGE_WORD.test(form);
  const other = OTHER_ACTION.test(form);
  const card = CARD.test(form);
  const amount = AMOUNT.test(form) || MONEY_SLOT.test(form);
  const object = card || amount || MONEY_NAMED.test(form);
  return (
    ((hold || charge || other) && object) || (card && amount) || (silence && (charge || other || object))
  );
}

/** What a sentence speaks of: money, and whether it holds a hold word or names a reply, an answer or silence. */
interface Topic {
  readonly money: boolean;
  readonly hold: boolean;
  readonly silence: boolean;
}

/** One sentence of a text, read for the gate. */
interface ReadSentence {
  /** As written, trimmed. */
  readonly text: string;
  /** Folded (default 8), its slots as written (their example words read too). */
  readonly words: string;
  /** Every reading form of it (readForms; DL-194, DL-204 2, defaults 8 to 10 and 12), its slots as written. */
  readonly forms: readonly string[];
  /** Its words that mix letters and digits, read the skeleton's way in each base form (default 12). */
  readonly skeletons: readonly string[];
  /** It holds a character that hides a word (DL-204 1). */
  readonly hiding: boolean;
  /** The compared form (default 2). */
  readonly form: string;
}

function readSentences(text: string): ReadSentence[] {
  return sentencePieces(text).flatMap((parts) => {
    const form = comparedForm(parts);
    if (form === "") return [];
    const written = sentenceText(parts);
    const base = baseForms(written);
    return [
      {
        text: written,
        words: foldedForm(written),
        forms: readForms(base),
        skeletons: base.map(skeletonWords).filter((words) => words !== ""),
        hiding: hidesWord(written),
        form,
      },
    ];
  });
}

/**
 * The topic of a sentence, or of a question read with the sentence after it: from its words in every reading form
 * (folded, joined across the group as round 4 read them, and each sentence's other forms; slots as written), its words
 * that mix letters and digits read the skeleton's way, its compared form (slots as {{name}}, read folded for round 3's
 * pairs) and whether it holds a character that hides a word (DL-204 1).
 */
function topicOf(group: readonly ReadSentence[]): Topic {
  const read = [
    group.map((sentence) => sentence.words).join(" "),
    ...group.flatMap((sentence) => sentence.forms),
  ];
  const skeletons = group.flatMap((sentence) => sentence.skeletons);
  const form = group.map((sentence) => sentence.form).join(" ");
  return {
    money:
      read.some((words) => ONE_MONEY_WORD.test(words)) ||
      skeletons.some((words) => SKELETON_MONEY_WORD.test(words)) ||
      group.some((sentence) => sentence.hiding) ||
      MONEY_SLOT.test(form) ||
      [foldedForm(form), ...read].some(pairedMoney),
    hold:
      read.some((words) => HOLD_STEM.test(words) || HOLD_WORD.test(words)) ||
      skeletons.some((words) => SKELETON_HOLD_STEM.test(words)),
    silence:
      read.some((words) => SILENCE_STEM.test(words) || SILENCE_WORD.test(words)) ||
      skeletons.some((words) => SKELETON_SILENCE_STEM.test(words)),
  };
}

/** Does a sentence name a reply, an answer or silence (round 2's question, default 6), in any form it is read in? */
function namesSilence(sentence: ReadSentence): boolean {
  return [foldedForm(sentence.form), ...sentence.forms].some((words) => SILENCE_WORD.test(words));
}

/** A unit of a text: one sentence, or a reply, answer or silence question with the sentence after it (default 6). */
interface Unit {
  readonly forms: readonly string[];
  readonly topic: Topic;
}

function unitsOf(text: string): Unit[] {
  const groups: ReadSentence[][] = [];
  let open: ReadSentence[] | null = null;
  for (const sentence of readSentences(text)) {
    if (open === null) {
      open = [sentence];
      groups.push(open);
    } else open.push(sentence);
    if (!(/(?:\?|\.\.\.)$/u.test(sentence.text) && namesSilence(sentence))) open = null;
  }
  return groups.map((group) => ({ forms: group.map((sentence) => sentence.form), topic: topicOf(group) }));
}

/** An approved sentence that holds a slot: its compared form, its slots' names and its parts to fill. */
export interface ApprovedSentence {
  readonly form: string;
  readonly slots: ReadonlySet<string>;
  readonly parts: readonly FormPart[];
}

/** The approved lines, read for the gate. */
export interface ApprovedMoneyLines {
  /** Every sentence of every approved line, in the compared form (slots as {{name}}). */
  readonly sentences: ReadonlySet<string>;
  /** The approved sentences that hold a slot: filled with a message's slot values when checked, never re-split. */
  readonly slotted: readonly ApprovedSentence[];
}

/** A slot and the value the slot filler gave it (K-03 finalParts.slotValues; T-310 SlotValue). */
export interface GivenSlotValue {
  readonly slot: string;
  readonly value: string;
}

/** What the gate checks a text by: the approved lines, and the values its slots were filled with (none: as written). */
export interface MoneyGate {
  readonly approved: ApprovedMoneyLines;
  readonly slotValues?: readonly GivenSlotValue[];
}

/** A text through the gate: the money sentences it refuses, by label (one refusal per label). */
export interface GateCheck {
  readonly ok: boolean;
  readonly refused: readonly ClaimRefusal[];
}

/** Reads approved lines for the gate: each line's sentences in the compared form, its slots read whole (default 2). */
export function approvedMoneyLines(lines: Iterable<string>): ApprovedMoneyLines {
  const sentences = new Set<string>();
  const slotted = new Map<string, ApprovedSentence>();
  for (const line of lines)
    for (const parts of sentencePieces(line)) {
      const form = comparedForm(parts);
      if (form === "") continue;
      sentences.add(form);
      const slots = new Set(parts.flatMap((piece) => (piece.kind === "slot" ? [piece.ref.name] : [])));
      if (slots.size > 0 && !slotted.has(form)) slotted.set(form, { form, slots, parts: formParts(parts) });
    }
  return { sentences, slotted: [...slotted.values()] };
}

/**
 * Does a slot value stand for no slot: does it hold a sentence end (default 3: . ! ? before a space or its end, or a
 * line break), a bidi control or a control character of DL-214 2 (default 13)?
 */
function standsForNoSlot(value: string): boolean {
  return /[.!?](?:\s|$)|[\r\n]/u.test(readingForm(value)) || BIDI_CONTROL.test(value) || CONTROL.test(value);
}

/**
 * Is a sentence, in the compared form, an approved sentence: as written, or with its slots standing for the values
 * given, filled into the approved sentence and never re-split (default 3)? A value that holds a sentence end or a bidi
 * control is refused (defaults 3 and 13).
 */
function approvedIn(gate: MoneyGate): (form: string) => boolean {
  const { sentences, slotted } = gate.approved;
  const values = new Map<string, string>();
  for (const { slot, value } of gate.slotValues ?? [])
    if (!standsForNoSlot(value)) values.set(slot, readingForm(value).toLowerCase());
  if (values.size === 0) return (form) => sentences.has(form);
  const filled = new Set<string>();
  for (const sentence of slotted)
    if ([...sentence.slots].some((slot) => values.has(slot))) filled.add(joined(sentence.parts, values));
  return (form) => sentences.has(form) || filled.has(form);
}

const HOLD_REFUSAL: ClaimRefusal = { claim: "cardHold", why: "neverHold" };
const SILENCE_REFUSAL: ClaimRefusal = { claim: "chargeOnSilence", why: "neverChargeOnSilence" };
const NOT_FROM_RECORD: ClaimRefusal = { claim: "moneySentence", why: "moneyNotFromRecord" };

/** The refusals of money sentences: neverHold, neverChargeOnSilence, else (when the record is asked) moneyNotFromRecord. */
function refusalsOf(topics: readonly Topic[], notFromRecord: boolean): ClaimRefusal[] {
  const out: ClaimRefusal[] = [];
  if (topics.some((topic) => topic.hold)) out.push(HOLD_REFUSAL);
  if (topics.some((topic) => topic.silence)) out.push(SILENCE_REFUSAL);
  if (notFromRecord && topics.some((topic) => !topic.hold && !topic.silence)) out.push(NOT_FROM_RECORD);
  return out;
}

/** The money units of a text, with what each speaks of. */
function moneyUnits(text: string): Unit[] {
  return unitsOf(text).filter((unit) => unit.topic.money);
}

/**
 * The money-topic gate: every money sentence of the text must be an approved sentence, word for word, its slots
 * standing for the values given; any other money sentence is refused (neverHold, neverChargeOnSilence or
 * moneyNotFromRecord).
 */
export function gateMoneyText(text: string, gate: MoneyGate): GateCheck {
  const units = moneyUnits(text);
  if (units.length === 0) return { ok: true, refused: [] };
  const approved = approvedIn(gate);
  const refused = refusalsOf(
    units.filter((unit) => !unit.forms.every(approved)).map((unit) => unit.topic),
    true,
  );
  return { ok: refused.length === 0, refused };
}

/**
 * The hold and the silence topics with no line approved, for the claim check alone (checkMoneyLine): a money sentence
 * that holds a hold word is a card hold, one that names a reply, an answer or silence a charge on silence, a denial
 * included.
 */
export function topicRefusals(text: string): ClaimRefusal[] {
  return refusalsOf(
    moneyUnits(text).map((unit) => unit.topic),
    false,
  );
}

function rowTexts(record: MoneyRecord): string[] {
  return Object.values(record.rows).flatMap((rows) => rows.map((row) => row.text));
}

const BY_ROWS = new WeakMap<object, ApprovedMoneyLines>();

/** The gate a record's own rows pass (the slot filler's rows, C-088): its approved lines are the record's rows. */
export function recordGate(record: MoneyRecord): MoneyGate {
  const known = BY_ROWS.get(record.rows);
  if (known !== undefined) return { approved: known };
  const approved = approvedMoneyLines(rowTexts(record));
  BY_ROWS.set(record.rows, approved);
  return { approved };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isObj(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

/**
 * The approved lines of both flows of a bundle (K-01 v1 flowGraph, the bundle's flows.A and flows.B): each record's
 * rows, S13-55's own lines (the money home step's does, more and rule) and every message text (default 7). Throws
 * MoneyHomeError, naming labels only, when a flow cannot be read.
 */
export function readApprovedLines(flows: Readonly<Record<FlowLetter, unknown>>): ApprovedMoneyLines {
  const lines: string[] = [];
  for (const flow of ["A", "B"] as const) {
    const graph = flows[flow];
    if (!isObj(graph)) throw new MoneyHomeError(`flow ${flow} is not a flow graph`);
    const record = readMoneyRecord(flow, graph.record);
    lines.push(...rowTexts(record));
    const steps = graph.steps;
    if (!isObj(steps)) throw new MoneyHomeError(`flow ${flow} has no steps`);
    const home = steps[record.home];
    if (!isObj(home)) throw new MoneyHomeError(`flow ${flow} has no money home step ${record.home}`);
    for (const field of ["does", "more", "rule"]) lines.push(...stringsIn(home[field]));
    for (const step of Object.values(steps)) {
      if (!isObj(step)) continue;
      lines.push(...stringsIn(step.say));
      if (isObj(step.vary))
        for (const patch of Object.values(step.vary))
          if (isObj(patch)) lines.push(...stringsIn(patch.say), ...stringsIn(patch.addSay));
      if (typeof step.fallbackText === "string") lines.push(step.fallbackText);
    }
  }
  return approvedMoneyLines(lines);
}
