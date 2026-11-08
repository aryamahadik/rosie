// Money words follow what the booking took (T-593; S13-55; RULES 3.2 to 3.4 and 3.14; arch 07 line 409).
//
// S13-55: "After the money step, messages speak only of what it took. ... A message never says deposit paid, paid in
// full, charged or refunded unless the record says it happened." A money line makes claims: a deposit paid, a card
// saved, nothing taken, a fee that may apply, what goes back. Each claim is a label, and it stands only when the
// booking's record holds what it says; the others are refused. Three are refused on every booking:
//   - a card hold (S13-55 "Nothing is ever held on a card"; RULES 3.2; MC: never a card hold; D66);
//   - a charge on silence (S13-55 "Rosie NEVER makes a new charge on silence"; RULES 3.4; arch 01 "silence never books
//     or charges");
//   - a fee per service (S13-55 "One late-cancel and no-show fee per booking"; the record's banned phrases).
// The claims are read from the words with the record's own money phrases (record.lint.phrases.money: "deposit paid",
// "paid in full", "card is saved", "no card saved", "nothing taken", "keep the deposit", "goes back to your card",
// "refunded to your card", "paid with a credit", "credit from your pack") and the words of S13-55's rules. What comes
// back holds labels only, never the words read, so a refusal reaches a log or the rewrite as labels.
//
// Round 2 (DL-179). The words are read after the apostrophe folding the Values check reads with (values.ts: ’ and ‘ as
// '). A card hold and a charge on silence are read by meaning, not by one word order:
//   - a card hold: a hold word (hold, held, holding, authorize or authorise, pre-authorize, reserve, block, freeze)
//     said of a card, a saved card or an amount, in any order and either voice, in one part of a sentence. A part ends
//     at ; : ( ) – — ·, before a word that opens a clause (if, unless, until ...), and before "and", "or", "but" when
//     a new subject follows. A hold of a time or a place ("your spot is held", "hold your time") is none;
//   - a charge on silence: a charge word (charge, bill, debit, take payment, a fee or deposit kept, a fee that applies)
//     tied to the person's silence or a missing answer, in any order, in one segment of a sentence (cut at ; and ·).
//     A question that names silence reads with the sentence after it ("No reply by 7pm? We'll charge the card.");
//   - a clause that denies what it names ("we never hold", "nothing is held", "we won't charge", "no charge without
//     your yes") makes no claim. The silence words are taken out first, so their own "don't" denies nothing, and a
//     silence its clause denies ("silence never does") ties no charge. A denial heading ("Never: ...") denies its
//     whole sentence.
// "Charged" and "you paid" say money was taken: they hold only once the booking took it (moneyTaken: from the money
// step on, written, something paid now), never on money only asked for before the money step.

import { VOCABULARY } from "../../finalize/slots/vocabulary";
import { depositTaken, holds, moneyTaken, type MoneyReading } from "./money";

/** The claims a money line can make (labels). */
export const MONEY_CLAIMS = [
  "cardHold",
  "chargeOnSilence",
  "feePerService",
  "depositPaid",
  "paidInFull",
  "paidNow",
  "youPaid",
  "charged",
  "cardSaved",
  "noCardSaved",
  "nothingTaken",
  "nothingDue",
  "keepDeposit",
  "backToCard",
  "paidByCredit",
  "fee",
  "noFee",
] as const;
export type MoneyClaim = (typeof MONEY_CLAIMS)[number];

/** Why a claim is refused (labels). */
export type RefusalWhy = "neverHold" | "neverChargeOnSilence" | "oneFeePerBooking" | "notTaken";

export interface ClaimRefusal {
  readonly claim: MoneyClaim;
  readonly why: RefusalWhy;
}

/** A money line checked against a booking: the claims it makes and those refused. */
export interface MoneyLineCheck {
  readonly ok: boolean;
  readonly claims: readonly MoneyClaim[];
  readonly refused: readonly ClaimRefusal[];
}

/** An amount or a slot standing for one: "$40", "$1,200.50", "{{deposit}}", "{{keep}}". */
const AMOUNT = String.raw`(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\{\{[^{}]*\}\})`;
const FEE_KIND = String.raw`(?:late[- ]cancel(?:lation)?|no-show|cancel(?:lation)?|missed[- ]visit)`;

/** A `{{hold}}` slot (D66): a hold on any booking, whatever the words around it. */
const HOLD_SLOT = /\{\{\s*hold\s*(?:[:|}])/i;

/**
 * The form the claims are read in: the apostrophe folding the Values check reads with (values.ts wordForm and
 * matchForm: ’ and ‘ read as '), so "don’t" is "don't"; and "7 p.m." read as "7pm", so its points end no sentence.
 */
function readingForm(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/(\d)\s*([ap])\.m\.?/gi, "$1$2m");
}

/** A text's sentences, each with its end mark (a point inside an amount, as in $40.00, ends none). */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/).filter((sentence) => sentence.trim() !== "");
}

/**
 * Where a part of a sentence ends: before a word that opens a clause of its own (if, unless, until ...), and before
 * "and", "or", "but", "so" or "then" when a new subject follows ("and nothing is charged"), not when one denial covers
 * both verbs ("silence never books or charges").
 */
const CLAUSE_OPENER =
  /(?=\b(?:if|unless|because|since|once|while|whereas|when|whenever|until|till|although|though|after|before)\b)|(?=\b(?:and|or|but|so|then)\s+(?:we|you|they|it|he|she|i|there|the|your|a|an|this|that|these|those|our|their|its|my|his|her|nothing|no|none|nobody|never|not|any|every|each|all|[$€£]|\{\{))/i;

/** A sentence's parts: cut at ; : ( ) – — · and where a clause of its own begins. */
function partsOf(sentence: string): string[] {
  return sentence.split(/(?:[;:](?=\s)|[()–—·])+/).flatMap((piece) => piece.split(CLAUSE_OPENER));
}

/** A part's clauses, cut at its commas: what one clause denies, it denies alone. */
function clausesOf(part: string): string[] {
  return part.split(/,(?=\s)/);
}

/** A sentence's segments, cut at ; and ·: what one segment says is tied together. */
function segmentsOf(sentence: string): string[] {
  return sentence.split(/;(?=\s)|·/);
}

/** A clause that denies what it names ("nothing is charged", "never held", "won't"); "no-show" denies nothing. */
const DENIED = /\b(?:no(?!-)|not|never|nothing|none|nobody|neither|nor|cannot|without|wont)\b|\b\w+n't\b/i;
/** A denial that heads its sentence ("Never: charge a fee on silence."): it denies all that follows. */
const DENIAL_HEADING = /^\W*(?:never|no|not|nothing|none)\s*:/i;

/** The same pattern, global, to take every match out of the words. */
function everyMatch(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/** Takes each pattern's words out of a text, leaving `instead` where they were. */
function takeOut(text: string, patterns: readonly RegExp[], instead: string): string {
  return patterns.reduce((rest, pattern) => rest.replace(everyMatch(pattern), instead), text);
}

/** The hold words the round 2 rulings name (DL-179): hold, authorize or authorise, pre-authorize, reserve, block, freeze. */
const HOLD_WORD = String.raw`(?:hold|holds|held|holding|(?:pre-?)?authori[sz](?:e|es|ed|ing|ation|ations)|reserv(?:e|es|ed|ing)|block|blocks|blocked|blocking|freeze|freezes|freezing|froze|frozen)`;
const HOLD = new RegExp(String.raw`\b${HOLD_WORD}\b`, "i");
/** Words that are a hold on their own, whatever they are said of. */
const HOLD_ITSELF = /\b(?:card\s+holds?|pre-?authori[sz]\w*|authori[sz]ation\s+holds?)\b/i;

/** A card: "your card", "the saved card", "a card on file". */
const CARD = /\bcards?\b/i;
/**
 * The slots that stand for an amount: K-03's money slots (slots.json valueType money) and a bare {{keep}}, the ledger
 * amount kept (slots.json keep: "A bare {{keep}} is the ledger amount kept").
 */
const MONEY_SLOTS: readonly string[] = VOCABULARY.filter((slot) => slot.valueType === "money").map(
  (slot) => slot.name,
);
const MONEY_SLOT = String.raw`\{\{\s*(?:${MONEY_SLOTS.map((name) => name.replace(/\./g, String.raw`\.`)).join("|")})\s*(?:[:|][^{}]*)?\}\}|\{\{\s*keep\s*\}\}`;
/**
 * An amount a hold can be said of: a sum in a currency, a money slot, or money named (the deposit, the fee). "Money"
 * alone is left out: the master's words use it of a kind of line or step ("each money line", "the money step").
 */
const HELD_AMOUNT = new RegExp(
  String.raw`[$€£]\s?\d|${MONEY_SLOT}|\b(?:deposit|deposits|fee|fees|payment|payments|funds|amount)\b`,
  "i",
);

/** What a hold word is said of when it is a time or a place, not money: "your spot", "the time", "a table". */
const THING = String.raw`(?:spot|spots|time|times|slot|slots|seat|seats|place|places|appointment|appointments|booking|bookings|visit|visits|table|tables|day|days|date|dates|window|windows|room|rooms|chair|chairs|session|sessions|class|classes|space|spaces|calendar|line|request|requests|offer|offers|turn)`;
/** A hold word said of a time or a place, or no hold at all ("hold on to this text"): taken out before holds are read. */
const NOT_MONEY_HOLD: readonly RegExp[] = [
  /\bhold(?:s|ing)?\s+(?:on\s+to\b|onto\b|on\s*,|on\s*$|off\b|tight\b|still\b)/i,
  new RegExp(
    String.raw`\b${HOLD_WORD}\s+(?:(?:off|out)\s+)?(?:your|the|a|an|this|that|these|those|their|our|its|my|his|her|one|some)\s+(?:[\w'-]+\s+){0,2}?${THING}\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b${THING}(?:'s|'re)?\s+(?:(?:is|are|was|were|be|been|being|stay|stays|stayed|remain|remains|remained|get|gets|got|will|would|can|may|has|have)\s+){0,2}(?:(?:still|now|already|safely|just)\s+)?(?:held|reserved|blocked|frozen|kept)\b`,
    "i",
  ),
];

/** One fee per booking: words of a fee per service are the record's banned phrases (record.lint.banned; S13-55 rule 5). */
const FEE_PER_SERVICE: readonly RegExp[] = [
  /\beach service's own (?:late )?terms\b/i,
  /\breads as a deposit booking\b/i,
  /\b(?:a|one) fee (?:for|per) each service\b/i,
];

/** A missing answer: what the person did not send (a reply, an answer, a yes). */
const ANSWER = String.raw`(?:answer|answers|reply|replies|response|responses|word|yes|confirmation|reaction)`;
/** A word that negates the verb after it: "don't", "haven't", "isn't", "not", "never", "fail to". */
const NOT_DONE = String.raw`(?:\b\w+n't|\bnot|\bnever|\bfail(?:s|ed)?\s+to)\s+(?:yet\s+|ever\s+|already\s+)?`;
/** The same, said of a person who acts, not of a thing ("you haven't confirmed", never "it isn't confirmed"). */
const NOT_DID = String.raw`(?:\b(?:do|does|did|have|has|had|wo|ca|could|would|should)n't|\b(?:do|does|did|have|has|had|will|can)\s+not|\bnever|\bfail(?:s|ed)?\s+to)\s+(?:yet\s+|ever\s+|already\s+)?`;
/** The person's silence or a missing answer, in the words a message may use. */
const SILENCE: readonly RegExp[] = [
  /\bsilence\b/i,
  /\b(?:go|goes|went|gone|going|stay|stays|stayed|staying|remain|remains|remained|keep|keeps|kept|are|is|were|was|be|been|being)\s+(?:silent|quiet)\b/i,
  new RegExp(String.raw`\b(?:no|without(?:\s+(?:an?|any|your|their))?)\s+${ANSWER}\b`, "i"),
  /\b(?:nobody|no one)\s+(?:answer|answers|answered|replies|replied|responds|responded)\b/i,
  new RegExp(
    String.raw`${NOT_DONE}(?:answer|answers|answered|reply|replies|replied|respond|responds|responded|(?:get|got|gotten|hear|heard|write|wrote|written|text|texted|call|called)\s+back)\b`,
    "i",
  ),
  new RegExp(String.raw`${NOT_DID}(?:confirm|confirms|confirmed|(?:say|said|tap|tapped)\s+yes)\b`, "i"),
  new RegExp(
    String.raw`${NOT_DONE}(?:hear|heard)\b(?:\s+(?:back|from\s+(?:you|them|him|her)|anything))?`,
    "i",
  ),
  new RegExp(
    String.raw`${NOT_DONE}(?:get|got|gotten|receive|received|have|had|see|seen)\s+(?:back\s+)?(?:(?:a|an|any|your|their)\s+)?${ANSWER}\b`,
    "i",
  ),
  /\b(?:hear|heard|get|got|receive|received)\s+nothing\b/i,
  /\bnothing\s+(?:back|from\s+(?:you|them))\b/i,
  /\b(?:say|says|said|do|does|did)\s+nothing\b/i,
  /\bunanswered\b/i,
  /\bignor(?:e|es|ed|ing)\b/i,
  /\bunless\s+(?:you|they|we|he|she)\s+(?:answer|reply|respond|confirm|say|tell|hear|get|write|text|call|let|object|decline)\b/i,
  /\b(?:unless|if)\s+we\s+(?:don't\s+)?hear\s+otherwise\b/i,
  /\b(?:time|times|timed|timing)\s+out\b/i,
  /\b(?:clock|timer|time|deadline|window)\s+(?:runs|ran|has\s+run|is|has)\s+(?:out|up|passed)\b/i,
];
/** "Free of charge" says no charge; "in charge" is no money at all. */
const NOT_A_CHARGE: readonly (readonly [RegExp, string])[] = [
  [/\bfree of charge\b/i, " no charge "],
  [/\bin charge\b/i, " "],
];
/** A charge: charge, bill (not "the bill"), debit, take payment, a fee or deposit kept or taken, a fee that applies. */
const CHARGE: readonly RegExp[] = [
  /\bcharg(?:e|es|ed|ing)\b/i,
  /\bdebit(?:s|ed|ing)?\b/i,
  /\bbill(?:ed|ing)\b/i,
  /(?:\b(?:will|we|they|to|may|can|could|would|should|shall|must|then)|'ll)\s+(?:then\s+|still\s+|just\s+|also\s+)?bill\b/i,
  /\bbills?\s+(?:you|your|the\s+(?:saved\s+)?card|it|them)\b/i,
  new RegExp(
    String.raw`\b(?:take|takes|took|taken|taking)\s+(?:(?:the|a|your|its|their|full|any)\s+)?(?:payment|fee|deposit|money|${AMOUNT})`,
    "i",
  ),
  /\b(?:fee|deposit|money|amount|charge)s?\s+(?:is|are|will\s+be|gets?|goes|go)\s+(?:kept|taken|used|on\b)/i,
  /\bkeeps?\s+(?:the|your|its|a|their)\s+[^,;:]{0,24}?(?:fee|deposit|money)\b/i,
  /\bfees?\s+(?:may\s+|will\s+|would\s+|then\s+|still\s+)?appl(?:y|ies)\b/i,
];

/**
 * Does a part of a sentence, in clauses its words do not deny, say a hold of a card or an amount (in any order and
 * either voice)? A sentence headed by a denial ("Never: ...") says none.
 */
function namesCardHold(text: string): boolean {
  if (HOLD_SLOT.test(text)) return true;
  return sentencesOf(text).some(
    (sentence) =>
      !DENIAL_HEADING.test(sentence) &&
      partsOf(takeOut(sentence, NOT_MONEY_HOLD, " ")).some((part) => {
        const live = clausesOf(part).filter((clause) => !DENIED.test(clause));
        if (live.some((clause) => HOLD_ITSELF.test(clause))) return true;
        return (
          live.some((clause) => HOLD.test(clause)) &&
          live.some((clause) => CARD.test(clause) || HELD_AMOUNT.test(clause))
        );
      }),
  );
}

/** Does the sentence name the person's silence or a missing answer? */
function namesSilence(sentence: string): boolean {
  return SILENCE.some((pattern) => pattern.test(sentence));
}

/** Where the silence words stood once taken out: a mark no other pattern reads. */
const SILENT = "§";

/**
 * Does a sentence tie a charge to silence, in any order? In one segment of it, the silence and the charge each stand in
 * a clause its words do not deny: the silence words are taken out first (their own "don't" or "no" denies nothing), so
 * "if you don't reply, we charge" ties them, while "we won't charge", "nothing is charged" and "silence never charges"
 * do not. A question or a trailing-off that names silence reads with the sentence after it; a sentence headed by a
 * denial ("Never: charge on silence.") ties none.
 */
function chargesOnSilence(text: string): boolean {
  const sentences = sentencesOf(text);
  return sentences.some((sentence, index) => {
    if (DENIAL_HEADING.test(sentence) || !namesSilence(sentence)) return false;
    const next = sentences[index + 1];
    const read =
      /(?:\?|…|\.\.\.)$/.test(sentence.trim()) && next !== undefined ? `${sentence} ${next}` : sentence;
    const marked = NOT_A_CHARGE.reduce(
      (words, [pattern, instead]) => words.replace(everyMatch(pattern), instead),
      takeOut(read, SILENCE, ` ${SILENT} `),
    );
    return segmentsOf(marked).some((segment) => {
      const live = partsOf(segment)
        .flatMap(clausesOf)
        .filter((clause) => !DENIED.test(clause));
      return (
        live.some((clause) => clause.includes(SILENT)) &&
        live.some((clause) => CHARGE.some((pattern) => pattern.test(clause)))
      );
    });
  });
}

/**
 * The claims read from words, in order: a claim's words are taken out before the next is read, so "no card saved" is
 * never also "card saved", "no fee" never also "a fee", "nothing was charged" never also "charged".
 */
const CLAIM_WORDS: readonly (readonly [MoneyClaim, readonly RegExp[]])[] = [
  ["noCardSaved", [/\bno card (?:is |was )?saved\b/i]],
  [
    "noFee",
    [
      new RegExp(String.raw`\bno (?:${FEE_KIND} )?fees?\b`, "i"),
      /\bwon't charge anything\b/i,
      /\bwithout a fee\b/i,
    ],
  ],
  [
    "depositPaid",
    [
      /\bdeposit (?:was |is |has been )?paid\b/i,
      new RegExp(String.raw`\bpaid (?:a |the |your )?(?:${AMOUNT} )?deposit\b`, "i"),
    ],
  ],
  ["paidInFull", [/\bpaid in full\b/i]],
  ["keepDeposit", [/\bkeeps? (?:your|the|its) [^.]{0,12}deposit\b/i]],
  [
    "paidByCredit",
    [
      /\bpaid (?:with|by) (?:a |1 |one )?credit\b/i,
      /\bcredits? from your pack\b/i,
      /\b(?:uses?|used) (?:1|one|a|your) credit\b(?!\s*card)/i,
      /\byour credit\b(?!\s*card)/i,
    ],
  ],
  [
    "backToCard",
    [
      /\bgoes back to (?:your|the) card\b/i,
      /\brefund(?:ed)? (?:to|on) (?:your|the) card\b/i,
      /\banything above it goes back\b/i,
      /\b(?:was|were|has been|have been|got) refunded\b/i,
      /\bwe refunded\b/i,
    ],
  ],
  [
    "nothingDue",
    [
      /\bnothing (?:more )?(?:is )?due\b/i,
      /\bnothing (?:more )?to pay at the visit\b/i,
      /\bnothing more to pay\b/i,
      /\bnothing to collect\b/i,
    ],
  ],
  [
    "nothingTaken",
    [
      /\bnothing (?:was |is )?taken\b/i,
      /\bnothing (?:was |is )?paid\b/i,
      /\bnothing to pay when you book\b/i,
      /\bnothing (?:was |is )?charged\b(?![^.]*\buntil\b)/i,
    ],
  ],
  [
    "paidNow",
    [
      /\bpaid now\b/i,
      /\bwhat you paid\b/i,
      new RegExp(String.raw`${AMOUNT} you paid\b`, "i"),
      /\bdue when you book\b/i,
      /\bin one payment\b/i,
    ],
  ],
  // "You paid $55", "you've already paid": a statement that the person paid. Read after paidNow, so the money named in a
  // term or a refund line ("from what you paid", "the {{back}} you paid goes back") stays paidNow; a clause that only
  // supposes a payment ("if you paid", "anything you paid the business", "back the way you paid") states none.
  [
    "youPaid",
    [
      /(?<!\b(?:anything|everything|whatever|all|that|which|way|how|if|unless|whether|once|until|till|when|whenever|before|after)\s+)\byou(?:'ve|\s+have|\s+had)?(?:\s+(?:already|just))?\s+paid\b/i,
    ],
  ],
  [
    "charged",
    [
      /\b(?:you were|you've been|you have been|we've|we have|we|was|were|has been|have been|got)(?: already| just)? charged\b/i,
    ],
  ],
  [
    "cardSaved",
    [/\bcard (?:is |was |has been |stays )?saved\b/i, /\bsaved card\b/i, /\bsaves? (?:a|your|the) card\b/i],
  ],
  [
    "fee",
    [
      /\bfees? may (?:apply|be kept|be charged)\b/i,
      /\bmay (?:charge|keep) (?:its|the|a|your) [^.]{0,24}?fee\b/i,
      new RegExp(String.raw`\bfor an? (?:${AMOUNT} )?(?:${FEE_KIND} )?fee\b`, "i"),
      new RegExp(String.raw`\b(?:its|the|a|your) ${AMOUNT} fee\b`, "i"),
      new RegExp(String.raw`\b${FEE_KIND} fees?\b`, "i"),
      /\bfee (?:is|will be|gets) (?:charged|kept|taken)\b/i,
    ],
  ],
];

/**
 * The claims a money line makes (labels, in MONEY_CLAIMS order), read from its words in the reading form (the Values
 * check's apostrophe folding); the words are not kept.
 */
export function moneyClaims(text: string): MoneyClaim[] {
  const words = readingForm(text);
  const found = new Set<MoneyClaim>();
  if (namesCardHold(words)) found.add("cardHold");
  if (chargesOnSilence(words)) found.add("chargeOnSilence");
  if (FEE_PER_SERVICE.some((pattern) => pattern.test(words))) found.add("feePerService");
  let rest = words;
  for (const [claim, patterns] of CLAIM_WORDS)
    for (const pattern of patterns) {
      const every = everyMatch(pattern);
      if (!every.test(rest)) continue;
      found.add(claim);
      rest = rest.replace(every, " ");
    }
  return MONEY_CLAIMS.filter((claim) => found.has(claim));
}

/**
 * Does the booking's record hold what the claim says? A hold, a charge on silence and a fee per service never do.
 * "Charged" and "you paid" need money the booking took (moneyTaken), never money only asked for before the money step.
 */
export function claimHolds(claim: MoneyClaim, reading: MoneyReading): boolean {
  switch (claim) {
    case "cardHold":
    case "chargeOnSilence":
    case "feePerService":
      return false;
    case "depositPaid":
      return depositTaken(reading);
    case "paidInFull":
      return holds(reading, "full");
    case "charged":
    case "youPaid":
      return moneyTaken(reading);
    case "paidNow":
    case "backToCard":
      return holds(reading, "paid");
    case "cardSaved":
      return holds(reading, "card");
    case "noCardSaved":
      return !holds(reading, "card");
    case "nothingTaken":
      return !holds(reading, "paid");
    case "nothingDue":
      return !holds(reading, "rest");
    case "keepDeposit":
      return depositTaken(reading) && reading.oneFee.applies;
    case "paidByCredit":
      return holds(reading, "credit");
    case "fee":
      return reading.oneFee.applies;
    case "noFee":
      return !holds(reading, "keep");
  }
}

function whyRefused(claim: MoneyClaim): RefusalWhy {
  if (claim === "cardHold") return "neverHold";
  if (claim === "chargeOnSilence") return "neverChargeOnSilence";
  if (claim === "feePerService") return "oneFeePerBooking";
  return "notTaken";
}

/** The claims refused for this booking: each one its record does not hold (a hold or a charge on silence, always). */
export function refusedClaims(claims: readonly MoneyClaim[], reading: MoneyReading): ClaimRefusal[] {
  return claims
    .filter((claim) => !claimHolds(claim, reading))
    .map((claim) => ({ claim, why: whyRefused(claim) }));
}

/**
 * Checks a money line, or a message's words, against what the booking took: it passes only when every money claim it
 * makes holds on the booking's record. For the message checks (C-092) and the slot filler's rows (C-088).
 */
export function checkMoneyLine(text: string, reading: MoneyReading): MoneyLineCheck {
  const claims = moneyClaims(text);
  const refused = refusedClaims(claims, reading);
  return { ok: refused.length === 0, claims, refused };
}
