// The money-topic gate (T-593 round 3; DL-182; S13-55; card line 9: "A message naming a card hold or a charge on
// silence fails the check"; RULES 3.2 to 3.4).
//
// Two rounds showed that reading a card hold or a charge on silence from word patterns always leaves a new wording
// through. So a sentence that speaks of money passes only as words the record or the master already wrote (DL-182 1):
//   - a sentence ends only at . ! ? or a line break; commas, dashes, parentheses, quotes and semicolons stay inside it.
//     It is read after the apostrophe folding the Values check reads with (values.ts: ’ and ‘ as '), in lower case;
//   - it is a money sentence when it pairs a money action word with a money object anywhere in it, in any order, tense
//     or voice; when it names a card with an amount or a money slot, whatever its verb ("your card will be used for
//     $40"); or when it names a reply, an answer or silence with a charge word;
//   - a money sentence passes only if it is, word for word, an approved line, each slot standing for the value the slot
//     filler gave it: one of the record's rows (both flows), S13-55's own lines or a message text of either master flow;
//   - every other money sentence fails, a denial included (DL-179's denied clause is withdrawn for these topics):
//     neverHold when it holds a hold word, neverChargeOnSilence when it names a reply, an answer or silence, otherwise
//     moneyNotFromRecord.
// A false refusal costs a fallback (one rewrite, then the fixed words), never a wrong promise. Approved lines then go
// through the claim check (claims.ts) for the booking at hand. What comes back holds labels only, never the words.
//
// Defaults (each fail-closed):
//   1. A sentence ends at . ! ? only before a space or the end of the text, so "$40.00" and "rosfield.com" end none;
//      "7 p.m." reads "7pm".
//   2. Approved lines are read sentence by sentence, as a message is: its money sentence passes when it is one sentence
//      of an approved line, compared with runs of spaces as one, each slot written {{name}} and its end marks left out.
//   3. A slot stands for the value the slot filler gave it (finalParts.slotValues); a slot given no value matches only
//      the slot as written. A value stands for its slot alone, never for other words around it.
//   4. Money action words also count in their other forms (surcharge, prepaid, withhold, reservation, unblock) and as
//      owe, deduct, withdraw and invoice; money objects also as "payment method" and an amount in words ("40 dollars");
//      money slots are K-03's money slots, {{keep}} and the money home's slots (pay.*, clock.pay, link.pay).
//   5. A reply, an answer or silence with a money object, or with pay, keep, refund, owe or deduct, is a money sentence
//      too (DL-182 names it with a charge word).
//   6. A sentence that names a reply, an answer or silence and asks or trails off ("No reply by 7pm?") reads with the
//      sentence after it, as round 2 read it; such a pair passes only when each of its sentences is approved.
//   7. A message text is every string of a step's say and of its variants' say and addSay (words, plain text and
//      elements), and the step's fallback text; S13-55's own lines are the money home step's does, more and rule.

import { pieces } from "../../finalize/slots/syntax";
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

/** A text's sentences, in the reading form: one ends only at . ! ? (before a space or the end) or at a line break. */
export function sentencesOf(text: string): string[] {
  return readingForm(text)
    .split(/(?<=[.!?])\s+|[\r\n]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** A sentence as it is compared: lower case, each slot written {{name}}, spaces as one, its end marks left out. */
function comparedForm(sentence: string): string {
  return pieces(sentence.toLowerCase())
    .map((piece) => (piece.kind === "slot" ? `{{${piece.ref.name}}}` : piece.text))
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.!?]+$/u, "");
}

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
const MONEY_WORD = /\b(?:deposits?|fees?|(?:pre-?)?payments?|funds?|amounts?|money)\b/iu;
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

/** What a sentence speaks of: money, and whether it holds a hold word or names a reply, an answer or silence. */
interface Topic {
  readonly money: boolean;
  readonly hold: boolean;
  readonly silence: boolean;
}

function topicOf(words: string): Topic {
  const hold = HOLD_WORD.test(words);
  const silence = SILENCE_WORD.test(words);
  const charge = CHARGE_WORD.test(words);
  const other = OTHER_ACTION.test(words);
  const card = CARD.test(words);
  const amount = AMOUNT.test(words) || MONEY_SLOT.test(words);
  const object = card || amount || MONEY_WORD.test(words);
  const money =
    ((hold || charge || other) && object) || (card && amount) || (silence && (charge || other || object));
  return { money, hold, silence };
}

/**
 * A text's units in the compared form: each sentence alone, except that a sentence naming a reply, an answer or silence
 * that asks or trails off reads with the sentence after it (default 6).
 */
function unitsOf(text: string): (readonly string[])[] {
  const units: string[][] = [];
  let open: string[] | null = null;
  for (const sentence of sentencesOf(text)) {
    const form = comparedForm(sentence);
    if (form === "") continue;
    if (open === null) {
      open = [form];
      units.push(open);
    } else open.push(form);
    if (!(/(?:\?|\.\.\.)$/u.test(sentence) && SILENCE_WORD.test(form))) open = null;
  }
  return units;
}

/** The approved lines, read for the gate. */
export interface ApprovedMoneyLines {
  /** Every sentence of every approved line, in the compared form (slots as {{name}}). */
  readonly sentences: ReadonlySet<string>;
  /** The approved lines that hold a slot, with their slots' names: filled with a message's slot values when checked. */
  readonly slotted: readonly { readonly text: string; readonly slots: ReadonlySet<string> }[];
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

/** Reads approved lines for the gate: each line's sentences in the compared form. */
export function approvedMoneyLines(lines: Iterable<string>): ApprovedMoneyLines {
  const sentences = new Set<string>();
  const slotted: { text: string; slots: ReadonlySet<string> }[] = [];
  for (const line of lines) {
    for (const sentence of sentencesOf(line)) sentences.add(comparedForm(sentence));
    const slots = new Set(pieces(line).flatMap((piece) => (piece.kind === "slot" ? [piece.ref.name] : [])));
    if (slots.size > 0) slotted.push({ text: line, slots });
  }
  return { sentences, slotted };
}

/** A line with each slot it holds that was given a value written as that value (default 3). */
function filledWith(text: string, values: ReadonlyMap<string, string>): string {
  return pieces(text)
    .map((piece) => (piece.kind === "slot" ? (values.get(piece.ref.name) ?? piece.ref.raw) : piece.text))
    .join("");
}

/** Is a sentence, in the compared form, an approved line's: as written, or with its slots standing for their values? */
function approvedIn(gate: MoneyGate): (form: string) => boolean {
  const { sentences, slotted } = gate.approved;
  const values = new Map<string, string>((gate.slotValues ?? []).map(({ slot, value }) => [slot, value]));
  if (values.size === 0) return (form) => sentences.has(form);
  const filled = new Set<string>();
  for (const line of slotted) {
    if (![...line.slots].some((slot) => values.has(slot))) continue;
    for (const sentence of sentencesOf(filledWith(line.text, values))) filled.add(comparedForm(sentence));
  }
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
function moneyUnits(text: string): { readonly forms: readonly string[]; readonly topic: Topic }[] {
  return unitsOf(text)
    .map((forms) => ({ forms, topic: topicOf(forms.join(" ")) }))
    .filter((unit) => unit.topic.money);
}

/**
 * The money-topic gate: every money sentence of the text must be an approved line, word for word, its slots standing
 * for the values given; any other money sentence is refused (neverHold, neverChargeOnSilence or moneyNotFromRecord).
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
