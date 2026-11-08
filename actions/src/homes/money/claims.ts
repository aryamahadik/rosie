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

import { depositTaken, holds, type MoneyReading } from "./money";

/** The claims a money line can make (labels). */
export const MONEY_CLAIMS = [
  "cardHold",
  "chargeOnSilence",
  "feePerService",
  "depositPaid",
  "paidInFull",
  "paidNow",
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
const CARD = String.raw`(?:your|the|a|their|this)\s+(?:saved\s+)?card`;
const FEE_KIND = String.raw`(?:late[- ]cancel(?:lation)?|no-show|cancel(?:lation)?|missed[- ]visit)`;

/** A `{{hold}}` slot (D66): a hold on any booking, whatever the words around it. */
const HOLD_SLOT = /\{\{\s*hold\s*(?:[:|}])/i;

/** A card hold in words: a hold on a card, a held amount, an authorization hold. "Your spot is held" is no card hold. */
const CARD_HOLD: readonly RegExp[] = [
  /\bcard\s+holds?\b/i,
  new RegExp(
    String.raw`\b(?:hold|holds|held|holding)\s+(?:[\w$.,{}]+\s+){0,3}?(?:on|against|from)\s+${CARD}\b`,
    "i",
  ),
  new RegExp(String.raw`\b(?:hold|holds|holding)\s+(?:of\s+)?${AMOUNT}`, "i"),
  new RegExp(String.raw`${AMOUNT}\s+(?:is\s+|will\s+be\s+|gets\s+)?(?:hold|held)\b`, "i"),
  /\bpre-?authori[sz](?:e|es|ed|ing|ation)\b/i,
  /\bauthori[sz]ation\s+holds?\b/i,
];

/** One fee per booking: words of a fee per service are the record's banned phrases (record.lint.banned; S13-55 rule 5). */
const FEE_PER_SERVICE: readonly RegExp[] = [
  /\beach service's own (?:late )?terms\b/i,
  /\breads as a deposit booking\b/i,
  /\b(?:a|one) fee (?:for|per) each service\b/i,
];

/** Silence: no answer, no reply, nothing heard back. */
const SILENCE =
  /\b(?:no (?:answer|reply|response|word)|silence|(?:don't|doesn't|didn't|do not|does not|did not|never) (?:answer|reply|respond|hear back|get back)|without (?:an? )?(?:answer|reply|response)|if we don't hear|unless (?:you|they) (?:answer|reply|respond)|not (?:answered|replied))\b/gi;
/** A charge: charged, billed (not "the bill"), a fee or deposit kept or taken. */
const CHARGE =
  /\b(?:charg(?:e|es|ed|ing)|billed|billing|(?:will|we|they) bill|(?:fee|deposit|money|amount) (?:is|will be|gets|goes) (?:kept|taken|used|on)|keeps? (?:the|your|its|a|their) [^,;:]{0,24}?(?:fee|deposit|money))\b/i;
/** A clause that denies what it names ("nothing is charged", "never held"); "no-show" denies nothing. */
const DENIED =
  /\b(?:no(?!-)|not|never|nothing|none|won't|wont|isn't|aren't|doesn't|don't|can't|cannot|without|nobody)\b/i;

/** The sentences of a text (a period before a digit, as in $40.00, ends none), each split into its clauses. */
function clausesOf(text: string): string[][] {
  return text.split(/[.!?]+(?=\s|$)|\n+/).map((sentence) => sentence.split(/(?:[,;:](?=\s)|[()–—])+/));
}

/** Does a clause the words do not deny name a card hold? */
function namesCardHold(text: string): boolean {
  if (HOLD_SLOT.test(text)) return true;
  return clausesOf(text).some((clauses) =>
    clauses.some((clause) => !DENIED.test(clause) && CARD_HOLD.some((pattern) => pattern.test(clause))),
  );
}

/** Does a sentence tie a charge to silence, the charge not denied in its own clause? */
function chargesOnSilence(text: string): boolean {
  return clausesOf(text).some((clauses) => {
    const sentence = clauses.join(", ");
    if (sentence.search(SILENCE) < 0) return false;
    return clausesOf(sentence.replace(SILENCE, ", "))
      .flat()
      .some((clause) => CHARGE.test(clause) && !DENIED.test(clause));
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
  ["charged", [/\b(?:you were|you've been|we|was|were|has been|have been|got) charged\b/i]],
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

/** The claims a money line makes (labels, in MONEY_CLAIMS order), read from its words; the words are not kept. */
export function moneyClaims(text: string): MoneyClaim[] {
  const found = new Set<MoneyClaim>();
  if (namesCardHold(text)) found.add("cardHold");
  if (chargesOnSilence(text)) found.add("chargeOnSilence");
  if (FEE_PER_SERVICE.some((pattern) => pattern.test(text))) found.add("feePerService");
  let rest = text;
  for (const [claim, patterns] of CLAIM_WORDS)
    for (const pattern of patterns) {
      const every = new RegExp(pattern.source, `${pattern.flags}g`);
      if (!every.test(rest)) continue;
      found.add(claim);
      rest = rest.replace(every, " ");
    }
  return MONEY_CLAIMS.filter((claim) => found.has(claim));
}

/** Does the booking's record hold what the claim says? A hold, a charge on silence and a fee per service never do. */
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
    case "paidNow":
    case "charged":
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
