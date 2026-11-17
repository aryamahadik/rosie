// The change home's module for the home registry (T-594 through T-586's createHomeRegistry; S13-30; S13-56).
//
// S13-30: a step points to a home by meaning, and where its words differ the home wins. A step's words reach the
// registry as claims, a point and a value per home, labels only (T-586 default 1); this module rules on the change home's
// points from the change reading (change.ts changeOffer), so a step that says a stand-in is offered for a booking that
// named a person, that no reply moves the customer to someone else, or that says why the pro is out, gets the home's value,
// and the registry logs the difference by label. Its points:
//   - changePath: offer, laterStart, businessStaffs, calledOff or notOffered;
//   - anotherPro, anotherTime, freeCancel: "offer" or "no" (S13-56: "another pro, only where the booking didn't name a
//     person. Or another time, or a free cancel with everything back");
//   - offerDeadline: dayBefore, sameDay, timeToAct, visitStart, or none where no question has a deadline (S13-56: "7pm the
//     day before, or 2 hours before for a visit today");
//   - silenceOutcome: callOff, laterStartStands, staysBooked or none; silenceMoves: "nobody", or "laterStart" for a pro
//     running late (S13-56: "Nothing moves on silence"; "The one exception, a pro running late");
//   - personReaches: owner ("Sam calls them"), rosieTeam (judgment rule 57) or none;
//   - notReached: ownerListThenTeam ("A customer not reached their way by then: the owner gets a named list to call. Not
//     marked reached: Rosie's team calls");
//   - changeFee: none (A7-93: "Every choice is free: no fee"); sayWhyProOut: never ("Never say why the pro is out");
//   - bareOk: askWhich ("A bare 'ok' picks nothing: ask once which").
// A context with no change reading (a step about no booking, such as S1-03's stand-ins block, whose safe default is
// "Nobody moves on silence") is ruled as a booking about which nothing is known: every fact not known, so it fails closed
// (no other pro, nobody moves, a person reaches them), and the points that need a visit say so (offerDeadline
// dayBeforeOrSameDay: the rule with no visit to read it from). Nothing is bound here: no turn face, gate or wiring calls
// this module yet.

import { isLabel } from "../../../../runtime/src/trace";
import type { HomeModule } from "../registry";
import { changeOffer, type ChangeReading } from "./change";
import { ChangeHomeError } from "./errors";

/** The context the registry hands the change home's rule (beside the other homes' parts of one context). */
export interface ChangeHomeContext {
  /** One booking and why the business can't give it as booked; absent for a step about no booking. */
  readonly change?: ChangeReading;
}

/** The change home's points, each a label (T-586: unique across the homes). */
export const CHANGE_POINTS = [
  "changePath",
  "anotherPro",
  "anotherTime",
  "freeCancel",
  "offerDeadline",
  "silenceOutcome",
  "silenceMoves",
  "personReaches",
  "notReached",
  "changeFee",
  "sayWhyProOut",
  "bareOk",
] as const;
export type ChangePoint = (typeof CHANGE_POINTS)[number];

/** The points that hold whatever the booking: S13-56's own words. */
const ALWAYS: Readonly<Record<"notReached" | "changeFee" | "sayWhyProOut" | "bareOk", string>> = {
  notReached: "ownerListThenTeam",
  changeFee: "none",
  sayWhyProOut: "never",
  bareOk: "askWhich",
};

/** A booking about which nothing is known: no other pro, nobody moves, a person reaches them (fails closed). */
const NOTHING_KNOWN: Readonly<Record<Exclude<ChangePoint, keyof typeof ALWAYS>, string>> = {
  changePath: "offer",
  anotherPro: "no",
  anotherTime: "offer",
  freeCancel: "offer",
  offerDeadline: "dayBeforeOrSameDay",
  silenceOutcome: "callOff",
  silenceMoves: "nobody",
  personReaches: "owner",
};

function isPoint(point: string): point is ChangePoint {
  return (CHANGE_POINTS as readonly string[]).includes(point);
}

const offerOrNo = (offered: boolean): string => (offered ? "offer" : "no");

/** The change home's ruling on one point, a label. Throws ChangeHomeError for a point it does not settle. */
export function changeRule(point: string, context: ChangeHomeContext): string {
  if (!isPoint(point))
    throw new ChangeHomeError(
      `${isLabel(point) ? point : "the point given"} is not a point of the change home`,
    );
  if (point === "notReached" || point === "changeFee" || point === "sayWhyProOut" || point === "bareOk")
    return ALWAYS[point];
  const given: unknown = context;
  const reading =
    typeof given === "object" && given !== null ? (given as Partial<ChangeHomeContext>).change : undefined;
  if (reading === undefined) return NOTHING_KNOWN[point];
  const offer = changeOffer(reading);
  switch (point) {
    case "changePath":
      return offer.path;
    case "anotherPro":
      return offerOrNo(offer.anotherPro.offered);
    case "anotherTime":
      return offerOrNo(offer.anotherTime.offered);
    case "freeCancel":
      return offerOrNo(offer.freeCancel);
    case "offerDeadline":
      return offer.deadline?.rule ?? "none";
    case "silenceOutcome":
      return offer.silence.outcome;
    case "silenceMoves":
      return offer.silence.moves;
    case "personReaches":
      return offer.personReaches;
  }
}

/** The change home's module, for createHomeRegistry({ flows, modules }): the S13-56 home (record.homes.change). */
export function changeHome(): HomeModule<ChangeHomeContext> {
  return { home: "change", points: CHANGE_POINTS, rule: changeRule };
}
