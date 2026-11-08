// The money-topic gate (T-593 rounds 3 and 4; DL-182, DL-187; S13-55; card line 9: "A message naming a card hold or a
// charge on silence fails the check"; RULES 3.2 to 3.4).
//
// Reading a card hold or a charge on silence from word patterns always left a new wording through, and so did every rule
// that needs two words to meet in one sentence. So one money word is enough (DL-187): a sentence that holds one passes
// only as words the record or the master already wrote.
//   - A sentence ends only at . ! ? or a line break; commas, dashes, parentheses, quotes and semicolons stay inside it.
//     Each sentence is judged alone, so a hold is never split away from its card: "We'll place a hold." is a money
//     sentence by "hold". It is read after the apostrophe folding the Values check reads with (values.ts: ’ and ‘ as
//     '), in lower case.
//   - A money sentence holds one money word: a word that begins with charg, bill, pay, paid, cost, pric, refund,
//     deposit, debit, authori, hold, held, owe, deduct, invoic, withdraw, fund, dollar, buck, money or amount; the whole
//     word fee, fees, cent or cents; a word that ends in card or cards (Mastercard, postcard); a $, € or £ anywhere; or a
//     K-03 money slot. A stem counts only at the start of a word, so "feel", "coffee", "recently" and "percent" are no
//     money words. Round 3's pairs still make one too (default 4).
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
// Residual risk (DL-187 5; CQ-120): a card hold or a charge on silence worded with no money word, sign or slot at all
// ("We'll put a stop on your plastic until the visit.", "If we don't hear back by 7pm, it goes through anyway.") is not
// caught here, nor one spelled with digits or symbols for letters ("h0ld") or with look-alike letters default 8 does not
// know. The composer prompt rule (STATE note 56: money sentences come from the record's rows, filled by T-310, never the
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
//      upcharge), owing, withdrew, cardholder, auth and pre-auth, and a ¢ sign. Round 3's money sentences stay money
//      sentences: a hold, charge or other money action word (reserve, block, freeze, set or put aside, keep, collect,
//      take ...) with a money object (an amount also in words, "40 euros"), a card with an amount, a reply, an answer or
//      silence with a charge or other money action word. Money slots are K-03's money slots, {{keep}} and the money
//      home's slots (pay.*, clock.pay, link.pay).
//   5. Hold words, for the label: a word that begins with hold, held or authori (with a prefix of default 4), auth,
//      pre-auth, reserve, block, freeze, set or put aside. Silence words, for the label: reply, answer, confirm, respond,
//      response, responsive and silence in any form (unanswered, unconfirmed, unresponsive), hear, heard, ignore, "no
//      word", and "text back", "write back", "get back" or "call back".
//   6. A sentence that names a reply, an answer or silence and asks or trails off ("No reply by 7pm?") reads with the
//      sentence after it, as round 2 read it; such a pair passes only when each of its sentences is approved.
//   7. A message text is every string of a step's say and of its variants' say and addSay (words, plain text and
//      elements), and the step's fallback text; S13-55's own lines are the money home step's does, more and rule.
//   8. Money words are found as a person reads them (foldedForm): compatibility forms as their plain letters and signs
//      (a fullwidth ＄ is $), combining marks and invisible format characters left out (a soft hyphen or a zero-width
//      space inside "charge"), and Cyrillic and Greek letters that look like Latin ones read as those ("сharge" with a
//      Cyrillic с). A word that mixes Latin letters with another script's letters counts as a money word (a word all in
//      one script, such as a Russian one, does not). The claim check reads its claims in the same form. Approved
//      sentences are still compared as written (default 2).

import { pieces, type Piece } from "../../finalize/slots/syntax";
import { VOCABULARY } from "../../finalize/slots/vocabulary";
import type { ClaimRefusal } from "./claims";
import { MoneyHomeError, readMoneyRecord, type FlowLetter, type MoneyRecord } from "./record";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The form money words are read in: the apostrophe folding the Values check reads with (values.ts wordForm and
 * matchForm: ’ and ‘ read as '), so "don’t" is "don't"; and "7 p.m." read as "7pm", so its points end no sentence.
 */
export function readingForm(text: string): string {
  return text.replace(/[’‘]/gu, "'").replace(/(\d)\s*([ap])\.m\.?/giu, "$1$2m");
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
 * The reading form in lower case, compatibility forms as their plain letters and signs (a fullwidth ＄ is $), combining
 * marks and invisible format characters left out (default 8).
 */
function plainForm(text: string): string {
  return readingForm(text)
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLowerCase();
}

/** Any one of the look-alike letters. */
const LOOKALIKE_LETTER = new RegExp(`[${[...LOOKALIKE.keys()].join("")}]`, "gu");

/** The form money words are found in (default 8): the plain form, with look-alike letters read as Latin ones. */
export function foldedForm(text: string): string {
  return plainForm(text).replace(LOOKALIKE_LETTER, (letter) => LOOKALIKE.get(letter) ?? letter);
}

/**
 * Does a word of the text mix Latin letters with letters of another script (default 8)? Such a word may hide a money
 * word. Read on the plain form, before look-alike letters are read as Latin ones, so a word of one script is none.
 */
function mixesScripts(text: string): boolean {
  return (plainForm(text).match(/\p{L}+/gu) ?? []).some(
    (word) => /\p{Script=Latin}/u.test(word) && /[^\P{L}\p{Script=Latin}]/u.test(word),
  );
}

/** Where a sentence ends inside plain words: after . ! ? before a space, or at a line break (default 1). */
const SENTENCE_END = /(?<=[.!?])\s+|[\r\n]+/u;

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

/** A sentence as written, its slots whole, trimmed. */
function sentenceText(parts: readonly Piece[]): string {
  return parts
    .map((piece) => (piece.kind === "slot" ? piece.ref.raw : piece.text))
    .join("")
    .trim();
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

/** Runs of spaces as one, trimmed, the end marks left out. */
function compared(words: string): string {
  return words
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.!?]+$/u, "");
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
/** A prefix a money stem may carry (default 4): unauthorized, prepaid, surcharge, withhold, copay, upcharge. */
const STEM_PREFIX = String.raw`(?:(?:un|non|pre|re|post|over|under|sur|with|co|auto|mis|up|down|e)-?)?`;
/** DL-187's stems, and owing and withdrew (default 4), which do not begin with the letters of owe and withdraw. */
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
  "authori",
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
/** One money word: a stem at the start of a word; fee, fees, cent or cents; a word ending in card(s); a money sign. */
const ONE_MONEY_WORD = new RegExp(
  [
    `${NOT_AFTER_LETTER}${STEM_PREFIX}(?:${MONEY_STEMS.join("|")})`,
    `${NOT_AFTER_LETTER}(?:fees?|cents?|(?:pre-?)?auths?)${NOT_BEFORE_LETTER}`,
    `card(?:holder)?s?${NOT_BEFORE_LETTER}`,
    "[$€£¢]",
  ].join("|"),
  "iu",
);
/** Hold words, for the label (DL-187 4, default 5): a word that begins with hold, held or authori; auth, pre-auth. */
const HOLD_STEM = new RegExp(
  `${NOT_AFTER_LETTER}${STEM_PREFIX}(?:hold|held|authori)|${NOT_AFTER_LETTER}(?:pre-?)?auths?${NOT_BEFORE_LETTER}`,
  "iu",
);
/** Silence words, for the label (DL-187 4, default 5): reply, answer, confirm, respond and silence, in any form. */
const SILENCE_STEM = new RegExp(
  `${NOT_AFTER_LETTER}(?:(?:un|non|re)-?)?(?:repl(?:y|ies|ied|ying)|answer|confirm|respon(?:d|se|siv)|silen)`,
  "iu",
);

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
  /** A word of it mixes Latin letters with another script's (default 8). */
  readonly mixed: boolean;
  /** The compared form (default 2). */
  readonly form: string;
}

function readSentences(text: string): ReadSentence[] {
  return sentencePieces(text).flatMap((parts) => {
    const form = comparedForm(parts);
    if (form === "") return [];
    const written = sentenceText(parts);
    return [{ text: written, words: foldedForm(written), mixed: mixesScripts(written), form }];
  });
}

/**
 * The topic of a sentence, or of a question read with the sentence after it: from its words (folded, slots as written),
 * its compared form (slots as {{name}}, read folded for round 3's pairs) and whether a word mixes scripts (default 8).
 */
function topicOf(group: readonly ReadSentence[]): Topic {
  const words = group.map((sentence) => sentence.words).join(" ");
  const form = group.map((sentence) => sentence.form).join(" ");
  return {
    money:
      ONE_MONEY_WORD.test(words) ||
      group.some((sentence) => sentence.mixed) ||
      MONEY_SLOT.test(form) ||
      pairedMoney(foldedForm(form)),
    hold: HOLD_STEM.test(words) || HOLD_WORD.test(words),
    silence: SILENCE_STEM.test(words) || SILENCE_WORD.test(words),
  };
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
    if (!(/(?:\?|\.\.\.)$/u.test(sentence.text) && SILENCE_WORD.test(foldedForm(sentence.form)))) open = null;
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

/** Does a slot value hold a sentence end (default 3): . ! ? before a space or its end, or a line break? */
function holdsSentenceEnd(value: string): boolean {
  return /[.!?](?:\s|$)|[\r\n]/u.test(readingForm(value));
}

/**
 * Is a sentence, in the compared form, an approved sentence: as written, or with its slots standing for the values
 * given, filled into the approved sentence and never re-split (default 3)? A value that holds a sentence end is refused.
 */
function approvedIn(gate: MoneyGate): (form: string) => boolean {
  const { sentences, slotted } = gate.approved;
  const values = new Map<string, string>();
  for (const { slot, value } of gate.slotValues ?? [])
    if (!holdsSentenceEnd(value)) values.set(slot, readingForm(value).toLowerCase());
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
