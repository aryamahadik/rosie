// The money home's module for the home registry (T-593 through T-586's createHomeRegistry; S13-30; S13-55).
//
// S13-30: a step points to a home by meaning, and where its words differ the home wins. A step's words reach the
// registry as claims, a point and a value per home, labels only (T-586 default 1); this module rules on the money home's
// points from the booking's money reading, so a step that says a fee is charged on silence, a card held or a deposit
// paid that never was gets the home's value, and the registry logs the difference by label. Its points:
//   - chargeOnSilence: "none", or "keepSignedShare" where a signed dated schedule keeps its share of money already
//     taken (S13-55: "Rosie NEVER makes a new charge on silence. Silence: no fee, unless a signed schedule keeps part.
//     A signed schedule keeps only its share of money already taken. It never makes a new charge."; RULES 3.4). Money
//     already taken is moneyTaken: from the money step on and written, never money only asked for (DL-179);
//   - cardHold: "never" (S13-55: "Nothing is ever held on a card");
//   - feeFrom: where the booking's one fee would come from: "none", "paidNow" (out of what was paid now, never more) or
//     "savedCard" (nothing paid now: the saved card, only with the owner's yes, S11-22);
//   - each money claim a line can make (depositPaid, cardSaved, fee ...): "yes" when the booking's record holds it,
//     else "no" (a fee per service, never).

import { isLabel } from "../../../../runtime/src/trace";
import type { HomeModule } from "../registry";
import { MONEY_CLAIMS, claimHolds, type MoneyClaim } from "./claims";
import { moneyTaken, type MoneyReading } from "./money";
import { MoneyHomeError } from "./record";

/** What the money home rules by: the booking's money reading, and whether a signed dated schedule is in force. */
export interface MoneyHomeContext {
  readonly money: MoneyReading;
  /** A signed dated schedule keeps its share of money already taken (S13-55; RULES 3.4). Default false. */
  readonly signedSchedule?: boolean;
}

/**
 * The claim points: every money claim but the two that have points of their own, and the gate's money sentence the
 * record did not write (DL-182), which is a refusal of words, never a claim a step makes about a booking.
 */
const CLAIM_POINTS: readonly MoneyClaim[] = MONEY_CLAIMS.filter(
  (claim) => claim !== "cardHold" && claim !== "chargeOnSilence" && claim !== "moneySentence",
);

/** The money home's points, each a label (T-586: unique across the homes). */
export const MONEY_POINTS: readonly string[] = ["chargeOnSilence", "cardHold", "feeFrom", ...CLAIM_POINTS];

function isClaimPoint(point: string): point is MoneyClaim {
  return (CLAIM_POINTS as readonly string[]).includes(point);
}

/** The money home's ruling on one point, a label. */
export function moneyRule(point: string, context: MoneyHomeContext): string {
  const { money } = context as Partial<MoneyHomeContext>;
  if (money === undefined) throw new MoneyHomeError("the money home was asked to rule with no money reading");
  if (point === "chargeOnSilence")
    return context.signedSchedule === true && moneyTaken(money) ? "keepSignedShare" : "none";
  if (point === "cardHold") return "never";
  if (point === "feeFrom") return money.oneFee.from;
  if (isClaimPoint(point)) return claimHolds(point, money) ? "yes" : "no";
  throw new MoneyHomeError(`${isLabel(point) ? point : "the point given"} is not a point of the money home`);
}

/** The money home's module, for createHomeRegistry({ flows, modules }). */
export function moneyHome(): HomeModule<MoneyHomeContext> {
  return { home: "money", points: MONEY_POINTS, rule: moneyRule };
}
