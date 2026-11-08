// Money words follow what the booking took (T-593; S13-55; RULES 3.2 to 3.4 and 3.14; arch 07 line 409).
//
// S13-55: "After the money step, messages speak only of what it took. ... A message never says deposit paid, paid in
// full, charged or refunded unless the record says it happened." A money line makes claims: a deposit paid, a card
// saved, nothing taken, a fee that may apply, what goes back. Each claim is a label, and it stands only when the
// booking's record holds what it says; the others are refused. Four are refused on every booking:
//   - a card hold (S13-55 "Nothing is ever held on a card"; RULES 3.2; MC: never a card hold; D66);
//   - a charge on silence (S13-55 "Rosie NEVER makes a new charge on silence"; RULES 3.4; arch 01 "silence never books
//     or charges");
//   - a fee per service (S13-55 "One late-cancel and no-show fee per booking"; the record's banned phrases);
//   - a money sentence the record did not write (DL-182: the money-topic gate, gate.ts).
// The claims are read from the words with the record's own money phrases (record.lint.phrases.money: "deposit paid",
// "paid in full", "card is saved", "no card saved", "nothing taken", "keep the deposit", "goes back to your card",
// "refunded to your card", "paid with a credit", "credit from your pack") and the words of S13-55's rules, after the
// apostrophe folding the Values check reads with (values.ts: ’ and ‘ as '). What comes back holds labels only, never
// the words read, so a refusal reaches a log or the rewrite as labels.
//
// Round 3 (DL-182). Card holds and charges on silence are no longer read by meaning: the money-topic gate (gate.ts)
// refuses every money sentence that is not an approved line, a denial included. Two checks:
//   - checkMoneyText(text, reading, gate): the gate, then the claim check on the booking. For the message checks
//     (C-092) and the slot filler (C-088): a message goes through this one;
//   - checkMoneyLine(text, reading): the claim check alone, with the hold and silence topics refused on every booking
//     and no line approved (any money sentence that holds a hold word, or names a reply, an answer or silence).
// "Charged" and "you paid" say money was taken, and so do "deposit paid" and "paid in full" said as statements and
// "refunded", "was refunded" and "we refunded" (DL-182 2): they hold only once the booking took it (moneyTaken: from
// the money step on, written, something paid now), never on money only asked for before the money step. A term keeps
// the record's reading (round 2's default 1): "Paid in full when you book" says what the booking asks, "the {{back}} you
// paid goes back to the card" what goes back on a cancel.

import { gateMoneyText, readingForm, topicRefusals, type MoneyGate } from "./gate";
import { depositTaken, holds, moneyTaken, type MoneyReading } from "./money";

/** The claims a money line can make (labels). */
export const MONEY_CLAIMS = [
  "cardHold",
  "chargeOnSilence",
  "feePerService",
  "moneySentence",
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
export type RefusalWhy =
  "neverHold" | "neverChargeOnSilence" | "oneFeePerBooking" | "moneyNotFromRecord" | "notTaken";

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

/** One fee per booking: words of a fee per service are the record's banned phrases (record.lint.banned; S13-55 rule 5). */
const FEE_PER_SERVICE: readonly RegExp[] = [
  /\beach service's own (?:late )?terms\b/i,
  /\breads as a deposit booking\b/i,
  /\b(?:a|one) fee (?:for|per) each service\b/i,
];

/** The same pattern, global, to take every match out of the words. */
function everyMatch(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

/**
 * A term, not a statement: the words say what the booking asks when it is booked ("Paid in full when you book"), later
 * in the same sentence (DL-182 2, round 2's default 1).
 */
const TERM = String.raw`(?=[^.!?\n]*\b(?:when (?:you|they) book|when booking|at booking|on booking|to book)\b)`;

/** A claim's words; `said` marks words that say the money was taken, which hold only once it was (DL-182 2). */
interface ClaimWords {
  readonly claim: MoneyClaim;
  readonly said?: true;
  readonly patterns: readonly RegExp[];
}

/**
 * The claims read from words, in order: a claim's words are taken out before the next is read, so "no card saved" is
 * never also "card saved", "no fee" never also "a fee", "nothing was charged" never also "charged", and a term is never
 * also read as a statement.
 */
const CLAIM_WORDS: readonly ClaimWords[] = [
  { claim: "noCardSaved", patterns: [/\bno card (?:is |was )?saved\b/i] },
  {
    claim: "noFee",
    patterns: [
      new RegExp(String.raw`\bno (?:${FEE_KIND} )?fees?\b`, "i"),
      /\bwon't charge anything\b/i,
      /\bwithout a fee\b/i,
    ],
  },
  {
    claim: "depositPaid",
    patterns: [
      new RegExp(String.raw`\bdeposit (?:was |is |has been )?paid\b${TERM}`, "i"),
      new RegExp(String.raw`\bpaid (?:a |the |your )?(?:${AMOUNT} )?deposit\b${TERM}`, "i"),
    ],
  },
  {
    claim: "depositPaid",
    said: true,
    patterns: [
      /\bdeposit (?:was |is |has been )?paid\b/i,
      new RegExp(String.raw`\bpaid (?:a |the |your )?(?:${AMOUNT} )?deposit\b`, "i"),
    ],
  },
  { claim: "paidInFull", patterns: [new RegExp(String.raw`\bpaid in full\b${TERM}`, "i")] },
  { claim: "paidInFull", said: true, patterns: [/\bpaid in full\b/i] },
  { claim: "keepDeposit", patterns: [/\bkeeps? (?:your|the|its) [^.]{0,12}deposit\b/i] },
  {
    claim: "paidByCredit",
    patterns: [
      /\bpaid (?:with|by) (?:a |1 |one )?credit\b/i,
      /\bcredits? from your pack\b/i,
      /\b(?:uses?|used) (?:1|one|a|your) credit\b(?!\s*card)/i,
      /\byour credit\b(?!\s*card)/i,
    ],
  },
  // "Refunded", "was refunded", "we refunded": money went back, so it was taken (DL-182 2).
  {
    claim: "backToCard",
    said: true,
    patterns: [
      /\b(?:was|were|been|got)\s+(?:(?:already|just|now|fully|also)\s+)?refunded\b/i,
      /\b(?:we|we've|we have|we had|i|i've|they|they've)\s+(?:(?:already|just|now|fully|also)\s+)?refunded\b/i,
      /(?<=(?:^|[.!?]\s+|\n)\s*)refunded\b/i,
      /(?<!\b(?:is|are|be|gets?)\s)\brefunded (?:to|on) (?:your|the) card\b/i,
    ],
  },
  // What goes back on a cancel in time: a term.
  {
    claim: "backToCard",
    patterns: [
      /\bgoes back to (?:your|the) card\b/i,
      /\brefund(?:ed)? (?:to|on) (?:your|the) card\b/i,
      /\banything above it goes back\b/i,
    ],
  },
  {
    claim: "nothingDue",
    patterns: [
      /\bnothing (?:more )?(?:is )?due\b/i,
      /\bnothing (?:more )?to pay at the visit\b/i,
      /\bnothing more to pay\b/i,
      /\bnothing to collect\b/i,
    ],
  },
  {
    claim: "nothingTaken",
    patterns: [
      /\bnothing (?:was |is )?taken\b/i,
      /\bnothing (?:was |is )?paid\b/i,
      /\bnothing to pay when you book\b/i,
      /\bnothing (?:was |is )?charged\b(?![^.]*\buntil\b)/i,
    ],
  },
  {
    claim: "paidNow",
    patterns: [
      /\bpaid now\b/i,
      /\bwhat you paid\b/i,
      new RegExp(String.raw`${AMOUNT} you paid\b`, "i"),
      /\bdue when you book\b/i,
      /\bin one payment\b/i,
    ],
  },
  // "You paid $55", "you've already paid": a statement that the person paid. Read after paidNow, so the money named in a
  // term or a refund line ("from what you paid", "the {{back}} you paid goes back") stays paidNow; a clause that only
  // supposes a payment ("if you paid", "anything you paid the business", "back the way you paid") states none.
  {
    claim: "youPaid",
    patterns: [
      /(?<!\b(?:anything|everything|whatever|all|that|which|way|how|if|unless|whether|once|until|till|when|whenever|before|after)\s+)\byou(?:'ve|\s+have|\s+had)?(?:\s+(?:already|just))?\s+paid\b/i,
    ],
  },
  {
    claim: "charged",
    patterns: [
      /\b(?:you were|you've been|you have been|we've|we have|we|was|were|has been|have been|got)(?: already| just)? charged\b/i,
    ],
  },
  {
    claim: "cardSaved",
    patterns: [
      /\bcard (?:is |was |has been |stays )?saved\b/i,
      /\bsaved card\b/i,
      /\bsaves? (?:a|your|the) card\b/i,
    ],
  },
  {
    claim: "fee",
    patterns: [
      /\bfees? may (?:apply|be kept|be charged)\b/i,
      /\bmay (?:charge|keep) (?:its|the|a|your) [^.]{0,24}?fee\b/i,
      new RegExp(String.raw`\bfor an? (?:${AMOUNT} )?(?:${FEE_KIND} )?fee\b`, "i"),
      new RegExp(String.raw`\b(?:its|the|a|your) ${AMOUNT} fee\b`, "i"),
      new RegExp(String.raw`\b${FEE_KIND} fees?\b`, "i"),
      /\bfee (?:is|will be|gets) (?:charged|kept|taken)\b/i,
    ],
  },
];

/** A claim read from words: `said` when the words say the money was taken. */
interface ReadClaim {
  readonly claim: MoneyClaim;
  readonly said: boolean;
}

/** The claims read from a text's words, in the reading form (gate.ts readingForm); the words are not kept. */
function readClaims(text: string): ReadClaim[] {
  const words = readingForm(text);
  const found: ReadClaim[] = [];
  if (HOLD_SLOT.test(words)) found.push({ claim: "cardHold", said: false });
  if (FEE_PER_SERVICE.some((pattern) => pattern.test(words)))
    found.push({ claim: "feePerService", said: false });
  let rest = words;
  for (const { claim, said, patterns } of CLAIM_WORDS)
    for (const pattern of patterns) {
      const every = everyMatch(pattern);
      if (!every.test(rest)) continue;
      found.push({ claim, said: said === true });
      rest = rest.replace(every, " ");
    }
  return found;
}

/**
 * The claims a money line makes (labels, in MONEY_CLAIMS order), read from its words: the record's money phrases, a
 * `{{hold}}` slot and a fee per service. A card hold or a charge on silence said in words is the gate's to refuse.
 */
export function moneyClaims(text: string): MoneyClaim[] {
  const found = new Set(readClaims(text).map(({ claim }) => claim));
  return MONEY_CLAIMS.filter((claim) => found.has(claim));
}

/**
 * Does the booking's record hold what the claim says? A hold, a charge on silence, a fee per service and a money
 * sentence the record did not write never do. "Charged" and "you paid" need money the booking took (moneyTaken), never
 * money only asked for before the money step; so do the statements read as `said` (checkMoneyLine).
 */
export function claimHolds(claim: MoneyClaim, reading: MoneyReading): boolean {
  switch (claim) {
    case "cardHold":
    case "chargeOnSilence":
    case "feePerService":
    case "moneySentence":
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
  if (claim === "moneySentence") return "moneyNotFromRecord";
  return "notTaken";
}

/** The claims refused for this booking: each one its record does not hold (a hold or a charge on silence, always). */
export function refusedClaims(claims: readonly MoneyClaim[], reading: MoneyReading): ClaimRefusal[] {
  return claims
    .filter((claim) => !claimHolds(claim, reading))
    .map((claim) => ({ claim, why: whyRefused(claim) }));
}

/** The claims read, checked on the booking: a statement that money was taken holds only once it was. */
function claimRefusals(read: readonly ReadClaim[], reading: MoneyReading): ClaimRefusal[] {
  return read
    .filter(({ claim, said }) => !claimHolds(claim, reading) || (said && !moneyTaken(reading)))
    .map(({ claim }) => ({ claim, why: whyRefused(claim) }));
}

/** The check's result: every claim made (the gate's and the words'), and each refusal once, in MONEY_CLAIMS order. */
function checked(
  read: readonly ReadClaim[],
  gated: readonly ClaimRefusal[],
  reading: MoneyReading,
): MoneyLineCheck {
  const found = new Set<MoneyClaim>([...gated.map(({ claim }) => claim), ...read.map(({ claim }) => claim)]);
  const refused = new Map<MoneyClaim, ClaimRefusal>();
  for (const refusal of [...gated, ...claimRefusals(read, reading)])
    if (!refused.has(refusal.claim)) refused.set(refusal.claim, refusal);
  const ordered = MONEY_CLAIMS.flatMap((claim) => {
    const refusal = refused.get(claim);
    return refusal === undefined ? [] : [refusal];
  });
  return {
    ok: ordered.length === 0,
    claims: MONEY_CLAIMS.filter((claim) => found.has(claim)),
    refused: ordered,
  };
}

/**
 * The claim check alone: a money line, or a message's words, passes only when every claim it makes holds on the
 * booking's record. With no line approved, a money sentence that holds a hold word is a card hold and one that names a
 * reply, an answer or silence a charge on silence, a denial included (DL-182). A message goes through checkMoneyText.
 */
export function checkMoneyLine(text: string, reading: MoneyReading): MoneyLineCheck {
  return checked(readClaims(text), topicRefusals(text), reading);
}

/**
 * The money-topic gate, then the claim check (DL-182): every money sentence of the text must be an approved line (its
 * slots standing for the values the slot filler gave), and every claim the text makes must hold on the booking's
 * record. For the message checks (C-092) and the slot filler (C-088).
 */
export function checkMoneyText(text: string, reading: MoneyReading, gate: MoneyGate): MoneyLineCheck {
  return checked(readClaims(text), gateMoneyText(text, gate).refused, reading);
}
