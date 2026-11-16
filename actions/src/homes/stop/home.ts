// The stop home's module for the home registry (T-590 through T-586's createHomeRegistry; S13-30; S13-32).
//
// S13-30: a step points to a home by meaning, and where its words differ the home wins. A step's words reach the
// registry as claims, a point and a value per home, labels only (T-586 default 1); this module rules on the stop home's
// points from the stop reading (the person's contact at the business, the message and any stop word), so a step that says
// it texts a stopped number, or that a stop cancels the visit, gets the home's value, and the registry logs the difference
// by label. Its points:
//   - textsYes: "yes" or "no": the person holds a yes to texts at the business (stop.ts textsYes);
//   - mayText: "texts" or "noTexts": one number stops every business, until START (stop.ts mayText);
//   - optOutLine: "carry" on Rosie's very first text to the number, else "omit" (Q-30);
//   - stopVisit: "keep", or "flag" for a bare Cancel: a stop word never cancels, moves or skips a booked visit; with no
//     stop word nothing changes, so "keep";
//   - stopSoldWork: "keep", or "cancel" in the one case (stop.ts default 5); with no stop word, "keep".
// Nothing is bound here: no turn face, guard or wiring calls this module yet (DL-867).

import { isLabel } from "../../../../runtime/src/trace";
import type { HomeModule } from "../registry";
import { StopHomeError } from "./errors";
import {
  mayText,
  optOutLine,
  stopWordEffect,
  textsYes,
  type StopMessage,
  type StopReading,
  type StopWord,
} from "./stop";

/** What the stop home rules by: one person's contact at one business, one message, and the stop word, if any. */
export interface StopRuling {
  readonly reading: StopReading;
  readonly message: StopMessage;
  /** The stop word the step answers, or null when there is none. */
  readonly word: StopWord | null;
}

/** The context the registry hands the stop home's rule (beside the other homes' parts of one context). */
export interface StopHomeContext {
  readonly stop: StopRuling;
}

/** The stop home's points, each a label (T-586: unique across the homes). */
export const STOP_POINTS = ["textsYes", "mayText", "optOutLine", "stopVisit", "stopSoldWork"] as const;
export type StopPoint = (typeof STOP_POINTS)[number];

/** The stop home's ruling on one point, a label. */
export function stopRule(point: string, context: StopHomeContext): string {
  const { stop } = context as Partial<StopHomeContext>;
  if (stop === undefined) throw new StopHomeError("the stop home was asked to rule with no stop reading");
  if (point === "textsYes") return textsYes(stop.reading, stop.message).yes ? "yes" : "no";
  if (point === "mayText") return mayText(stop.reading, stop.message).ruling;
  if (point === "optOutLine") return optOutLine(stop.reading);
  if (point === "stopVisit") return stop.word === null ? "keep" : stopWordEffect(stop.word).visit;
  if (point === "stopSoldWork") return stop.word === null ? "keep" : stopWordEffect(stop.word).soldWork;
  throw new StopHomeError(`${isLabel(point) ? point : "the point given"} is not a point of the stop home`);
}

/** The stop home's module, for createHomeRegistry({ flows, modules }): the S13-32 home (record.homes.stop). */
export function stopHome(): HomeModule<StopHomeContext> {
  return { home: "stop", points: STOP_POINTS, rule: stopRule };
}
