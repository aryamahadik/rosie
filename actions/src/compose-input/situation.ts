// The situation tag (C-090, T-309; arch 07 line 357): "Tone by situation tag, set by code; the first that fits wins
// (DD). Grief, safety or sensitive work (a safety outcome other than No, a death report, the sensitive switch): gentle,
// no '!' (S13-22). A problem (one getting worse, a payment problem, a complaint, damage, lateness, a business that can't
// make it, a platform failure): calm, saying what happened, what is kept and the next step, with no blame (S13-29 rule
// 59). Money or consent (a read-back, charge, refund or fee): exact amounts and dates, never words that describe them
// (S13-48). Else routine: brief and warm." K-03 v1 `situation` names the four tones gentle, problem, moneyOrConsent and
// routine (T-012's default 8).
//
// What fits, each a signal:
//   - from the committed turn (the row read's SituationFacts): a safety outcome other than No, and what the row is about
//     in the line's own words (a death report; the seven problems; a read-back, charge, refund or fee);
//   - from what code holds itself: the sensitive switch, on in the row's slot source or the record's live switches, as
//     limit 7 reads it (the claim check's switched()); and an amount, when the input names a money slot (its master
//     line, its facts or its links), since the composer then words money and S13-48 wants exact amounts.
// The tags go in arch 07 line 357's order and the first that fits wins, so a row about a death is gentle even when it
// also names money.

import { RECORD_SLOT_NAMES, VOCABULARY, type SlotSource } from "../finalize/slots";
import type { Concern, Situation, SituationFacts } from "./types";

/** One thing about a row that fits a tag. */
export type Signal = Concern | "safetyOutcome" | "sensitiveSwitch" | "amount";

/** The tags in arch 07 line 357's order: the first that fits wins. */
export const SITUATIONS: readonly Situation[] = ["gentle", "problem", "moneyOrConsent", "routine"];

/** The tag each signal fits (arch 07 line 357); nothing fits routine, which is what is left. */
export const SIGNAL_TAGS: Readonly<Record<Signal, Exclude<Situation, "routine">>> = {
  safetyOutcome: "gentle",
  deathReport: "gentle",
  sensitiveSwitch: "gentle",
  gettingWorse: "problem",
  paymentProblem: "problem",
  complaint: "problem",
  damage: "problem",
  lateness: "problem",
  businessCannotMakeIt: "problem",
  platformFailure: "problem",
  readBack: "moneyOrConsent",
  charge: "moneyOrConsent",
  refund: "moneyOrConsent",
  fee: "moneyOrConsent",
  amount: "moneyOrConsent",
};

/** The one safety outcome that is not gentle (K-02 v1 safetyOutcome; arch 07 line 357: "other than No"). */
export const NO_DANGER = "No";

/** The sensitive switch among the record's live switches (K-01 record.live), as limit 7 reads it. */
const SENSITIVE_SWITCH = "sensitive";

/**
 * The money slots: the record's money rows (K-01 record.slots pay.*, home S13-55), the pay link's deadline (clock.pay,
 * S13-35) and Rosie's $2 line (two.count, A9-21), every slot whose value is an amount (K-03 v1 slots.json valueType
 * money: the amounts, the ledger and change.price), and the pay link.
 */
export const MONEY_SLOTS: ReadonlySet<string> = new Set<string>([
  ...RECORD_SLOT_NAMES.filter((name) => name.startsWith("pay.")),
  "clock.pay",
  "two.count",
  ...VOCABULARY.filter((slot) => slot.valueType === "money").map((slot) => slot.name),
  "link.pay",
]);

/** The sensitive switch, on when the slot source or the record's live switches say so (the claim check's rule). */
export function sensitiveOn(source: SlotSource): boolean {
  return source.sensitive || source.record?.switches.includes(SENSITIVE_SWITCH) === true;
}

/** What fits the row, each once: the turn's facts, the sensitive switch, and an amount among the slots the input names. */
export function signalsOf(
  facts: SituationFacts,
  sensitive: boolean,
  slotsNamed: readonly string[],
): Signal[] {
  const signals: Signal[] = [];
  const add = (signal: Signal): void => {
    if (!signals.includes(signal)) signals.push(signal);
  };
  if (facts.safetyOutcomes.some((outcome) => outcome !== NO_DANGER)) add("safetyOutcome");
  if (sensitive) add("sensitiveSwitch");
  for (const concern of facts.about) add(concern);
  if (slotsNamed.some((slot) => MONEY_SLOTS.has(slot))) add("amount");
  return signals;
}

/** The tag: the first in arch 07 line 357's order that a signal fits, else routine. */
export function situationOf(signals: readonly Signal[]): Situation {
  for (const tag of SITUATIONS) {
    if (signals.some((signal) => SIGNAL_TAGS[signal] === tag)) return tag;
  }
  return "routine";
}
