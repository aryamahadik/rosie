// Step cards (T-144; K-01 v1 `card`; C-058): for each decision (a split) the card the model is given: the question, each
// branch's definition, the Never lines, the safe default and the Clock.
//
//   question     the split's `q`.
//   means        one entry per branch, in the branch order: the step's own `Means '<label>': ...` line (from meansLine);
//                else the first sentence of the step the branch leads to, standing in (from firstSentence); else, with
//                neither, none (the lint rule choice-without-definition is T-155's to judge).
//   never        every `more` line that starts with Never, word for word.
//   safeDefault  the words of the `Safe default` line; left out when the step has none.
//   clock        the step's own `Clock` line, word for word (from clockLine); else step 9's default (from step9Default:
//                7pm the day before the visit, 2 hours before a same-day visit, at least 1 hour after delivery; 8pm the
//                day after delivery with no visit: arch 02 step 9, arch 12 line 592).
//
// The step a branch leads to: its own first step; for a branch that rejoins and has no steps (`end: "merge"`, or no
// `end`), the step the split's list goes on with, or, at the end of a branch's list, the step after the enclosing split;
// the master's step printer shows such a branch as "rejoins, first step undefined", but the step after the rejoin is where
// the choice leads. A branch that ends the flow with no steps (`end: "end"`) leads to no step: its `endText` (the words of
// its ending) stands in; with none either, the branch has no definition.
//
// A card is read from the step as it is written (the master's, or a trade's applied step), never per path: the Means,
// Never, Safe default and Clock lines are never in a `vary` entry of the master, and a trade's own words change them for
// every path alike (cards.test.ts walks the paths of two trades to prove it).
import type { FlowLetter, MasterGraphs, StepId } from "../graph/types.ts";
import type { AppliedTrade } from "../overlay/apply";
import { clockLineOf, firstSentence, hasMeansLine, meansOf, neverLines, safeDefaultOf } from "./lines";

/** Where a branch's definition comes from (K-01 card.means[].from). */
export type MeansFrom = "meansLine" | "firstSentence" | "none";

/** One branch's definition (K-01 card.means[]). `text` is left out when `from` is none. */
export interface CardMeans {
  branch: string;
  text?: string;
  from: MeansFrom;
}

/** The step's clock (K-01 clock): its own line, word for word, or step 9's default. */
export interface CardClock {
  from: "clockLine" | "step9Default";
  text?: string;
}

/** The card of one decision (K-01 card). */
export interface StepCard {
  question: string;
  means: CardMeans[];
  never: string[];
  safeDefault?: string;
  clock: CardClock;
}

/** The part of a branch a card reads: the master's branch and an applied trade's both fit. */
export interface CardBranch {
  label: string;
  steps: readonly CardStep[];
  end?: "merge" | "end";
  endText?: string;
  /** An ending branch that goes on in the other flow: it leads to no step of this one. */
  flow?: FlowLetter;
  /** An `off` op switched the branch off: it is not a choice, and is left out of the card. */
  off?: string;
}

/** The part of a step a card reads: the master's step and an applied trade's both fit. */
export interface CardStep {
  id: StepId;
  type?: string;
  q?: string;
  does: string;
  more?: readonly string[];
  say?: readonly unknown[];
  branches?: readonly CardBranch[];
  off?: string;
}

/** A decision the card cannot be made for. */
export class CardError extends Error {
  override name = "CardError";
}

/** Where a branch leads: a step (its first), the words of an ending, or nowhere. */
export type Leads = { step: CardStep } | { endText: string } | null;

/** One decision with the places its branches lead to, in the branch order (off branches left out). */
export interface Decision {
  step: CardStep;
  branches: { label: string; leads: Leads }[];
}

/**
 * Every decision of a flow's main list (steps with their branches nested), each with where its branches lead. `list` is
 * the flow's main path in the master's order (FlowGraph.path, AppliedFlow.steps). A step an `off` op switched off is
 * skipped, with its branches.
 */
export function decisionsOf(list: readonly CardStep[]): Decision[] {
  const out: Decision[] = [];

  /** `after`: the step reached when this list runs out by rejoining (null: the list ends the flow, or its branch ends). */
  const visit = (steps: readonly CardStep[], after: CardStep | null): void => {
    const live = steps.filter((step) => step.off === undefined);
    live.forEach((step, k) => {
      const next = live[k + 1] ?? after;
      if (step.type === "split") {
        const branches = (step.branches ?? [])
          .filter((branch) => branch.off === undefined)
          .map((branch): { label: string; leads: Leads } => {
            const first = branch.steps.find((candidate) => candidate.off === undefined);
            if (first !== undefined) return { label: branch.label, leads: { step: first } };
            if (branch.end !== "end" && branch.flow === undefined && next !== null)
              return { label: branch.label, leads: { step: next } };
            if (typeof branch.endText === "string" && branch.endText.trim() !== "")
              return { label: branch.label, leads: { endText: branch.endText } };
            return { label: branch.label, leads: null };
          });
        out.push({ step, branches });
      }
      for (const branch of step.branches ?? []) {
        if (branch.off !== undefined) continue;
        visit(branch.steps, branch.end === "end" ? null : next);
      }
    });
  };
  visit(list, null);
  return out;
}

/** The words that stand in for a missing Means line: the first sentence of the step the branch leads to, or of its ending. */
function standIn(leads: Leads): string | null {
  if (leads === null) return null;
  const text = "step" in leads ? leads.step.does : leads.endText;
  const sentence = firstSentence(text);
  return sentence === "" ? null : sentence;
}

/** The card of one decision. */
export function cardOf(decision: Decision): StepCard {
  const { step } = decision;
  const more = step.more ?? [];
  const question = step.q;
  if (typeof question !== "string" || question.trim() === "")
    throw new CardError(`${step.id}: a decision with no question (q)`);

  const labels = decision.branches.map((branch) => branch.label);
  const given = new Map(meansOf(more, labels).map((entry) => [entry.label, entry.text]));
  const means = decision.branches.map(({ label, leads }): CardMeans => {
    const line = given.get(label);
    if (line !== undefined) return { branch: label, text: line, from: "meansLine" };
    const stood = standIn(leads);
    if (stood !== null) return { branch: label, text: stood, from: "firstSentence" };
    return { branch: label, from: "none" };
  });

  const card: StepCard = { question, means, never: neverLines(more), clock: { from: "step9Default" } };
  const safeDefault = safeDefaultOf(more, step.id);
  if (safeDefault !== null) card.safeDefault = safeDefault;
  const clock = clockLineOf(more, step.id);
  if (clock !== null) card.clock = { from: "clockLine", text: clock };
  return card;
}

/** The cards of a flow, by step id: one per decision. */
export function compileCards(list: readonly CardStep[]): Record<StepId, StepCard> {
  const cards: Record<StepId, StepCard> = {};
  for (const decision of decisionsOf(list)) {
    if (decision.step.id in cards)
      throw new CardError(`${decision.step.id}: two decisions with one id in one flow`);
    cards[decision.step.id] = cardOf(decision);
  }
  return cards;
}

/**
 * The master's cards for both flows. A step both flows share has the same question, Means lines, Never lines, safe default
 * and Clock in each; only a stand-in can differ, where the step a rejoining branch leads to is the next one of its own flow.
 */
export function compileMasterCards(master: MasterGraphs): Record<FlowLetter, Record<StepId, StepCard>> {
  return { A: compileCards(master.A.path), B: compileCards(master.B.path) };
}

/** One trade's cards for one flow, from the applied flow (its own words and branches in, switched-off branches out). */
export function compileTradeCards(applied: AppliedTrade): Record<StepId, StepCard> {
  return compileCards(applied.flow.steps);
}

/** Does this decision state no Means line at all? Each of its choices then takes a stand-in. */
export function lacksMeans(step: CardStep): boolean {
  return !hasMeansLine(step.more ?? []);
}
