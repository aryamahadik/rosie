// What a set of gold items holds for each section 08 measure (T-470; arch 08 lines 427 to 449): the units each measure
// is counted out of, as K-10 v1's README "How each measure is counted" gives each measure's total. The manifest lists
// them for the whole set and per journey, so the volume each bar has is in view (arch 08 line 449: "Proof needs
// volume"; BP 8 and J-19: a bar is met only at its sized volume).
//
//   rightStepInChoices   turns with a choose or enter part
//   lowStakesDecisions   turns whose label has stakes low
//   highStakesDecisions  turns whose label has stakes high
//   harmfulWrongActions  every turn (every graded turn; a whole chat's turns each count)
//   needlessQuestions    every turn
//   dangerFound          danger cases: texts with a safety label other than No whose tense is now, could restart or
//                        unknown (over and joke are not danger: arch 06 line 329)
//   falseAlarms          every other text
//   wholeChats           whole-chat items
//   misstatedMessages    the messages the labels list: the most a run can count, since it counts those it sent
//   fallbackMessages     null: its total is the messages the composer plans (fixed lines are never composed), which
//                        only a run knows; the labels list only the messages whose values are graded
//
// K-10's own sample reports bear these out on the eight sample items: report-code-only-change.json, in which every
// message a label lists was sent, has exactly these totals for every measure but fallbackMessages, overall and per
// journey (store.test.ts).
import type { GoldItem, GoldText, MeasureName } from "../../../../contracts/generated/eval-set/eval-set.v1";

/** Section 08's measures in K-10 v1's order (eval-set.v1.schema.json $defs.measureName). */
export const MEASURES = [
  "rightStepInChoices",
  "lowStakesDecisions",
  "highStakesDecisions",
  "harmfulWrongActions",
  "needlessQuestions",
  "dangerFound",
  "falseAlarms",
  "wholeChats",
  "fallbackMessages",
  "misstatedMessages",
] as const satisfies readonly MeasureName[];

/** The measures whose units the items hold: every one but fallbackMessages (see the top of this file). */
export type CountedMeasure = Exclude<MeasureName, "fallbackMessages">;

/** Each measure's count of units; fallbackMessages is null, since only a run counts it. */
export type MeasureCounts = Record<CountedMeasure, number> & { fallbackMessages: null };

/** How many items of the set ride each flow (K-01 v1 path.flow). */
export interface FlowCounts {
  A: number;
  B: number;
}

/** What a set of items holds: items, turns, texts, items per flow, and each measure's units. */
export interface SetCounts {
  items: number;
  turns: number;
  texts: number;
  flows: FlowCounts;
  measures: MeasureCounts;
}

/** The tenses in which a label other than No makes a danger case (K-10 README; arch 06 line 329). */
const DANGER_TENSES: ReadonlySet<string> = new Set(["now", "could restart", "unknown"]);

/** Whether a text is a danger case: a gold safety label other than No in tense now, could restart or unknown. */
export function isDangerCase(text: GoldText): boolean {
  return text.safety.some((label) => label.outcome !== "No" && DANGER_TENSES.has(label.tense));
}

/** What `items` hold (see the top of this file). */
export function countItems(items: readonly GoldItem[]): SetCounts {
  const counts: SetCounts = {
    items: items.length,
    turns: 0,
    texts: 0,
    flows: { A: 0, B: 0 },
    measures: {
      rightStepInChoices: 0,
      lowStakesDecisions: 0,
      highStakesDecisions: 0,
      harmfulWrongActions: 0,
      needlessQuestions: 0,
      dangerFound: 0,
      falseAlarms: 0,
      wholeChats: 0,
      fallbackMessages: null,
      misstatedMessages: 0,
    },
  };
  const measures = counts.measures;
  for (const item of items) {
    counts.flows[item.path.flow] += 1;
    if (item.kind === "wholeChat") measures.wholeChats += 1;
    for (const turn of item.turns) {
      counts.turns += 1;
      measures.harmfulWrongActions += 1;
      measures.needlessQuestions += 1;
      const { label } = turn;
      if (label.parts.some((part) => part.verb === "choose" || part.verb === "enter"))
        measures.rightStepInChoices += 1;
      if (label.stakes === "low") measures.lowStakesDecisions += 1;
      if (label.stakes === "high") measures.highStakesDecisions += 1;
      measures.misstatedMessages += label.messages.length;
      for (const text of turn.texts) {
        counts.texts += 1;
        if (isDangerCase(text)) measures.dangerFound += 1;
        else measures.falseAlarms += 1;
      }
    }
  }
  return counts;
}
