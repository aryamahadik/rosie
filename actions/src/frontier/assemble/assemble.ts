// The frontier assembler (T-291; C-075; arch 03 lines 151 to 167): the closed list of choices for one turn, built by
// code from pluggable sources, each reading the same stored state, in the order of their slots (registry.ts). No model
// is involved (arch 03 line 153: "built every turn by code, in milliseconds ... no model involved").
//
// Each source fails closed (the card's Gives: "sources not yet built fail closed (offer nothing)"):
//   - a slot whose module is not built yet offers nothing, and is logged (frontier_source_missing);
//   - a source that throws or rejects offers nothing, and is logged with its error's kind (frontier_source_failed);
//   - a source whose offer K-02 v1 refuses (a choice, an open question or a card that breaks the contract) offers
//     nothing, and is logged with the count of problems (frontier_source_refused), so one faulty source never reaches
//     decide and never takes the rest of the frontier down with it.
// Then an option naming an open question the frontier does not list is left out (frontier_option_orphaned), the
// choices get their ids in frontier order (c-01, c-02, ...: a choice id appears once, K-02 README "Named rules"), and
// every option of an open question is high when one of its options is high (K-02 README, "Stakes": "question").
// An open question or a card two sources both give is listed once, the first slot's.

import type { FrontierChecker } from "./check";
import type {
  Choice,
  DraftChoice,
  FrontierInput,
  LogFields,
  OpenQuestion,
  SourceOffer,
  SourceSlot,
  StakesReason,
  StepCard,
} from "./types";

/** What the sources gave, as the context lists it. */
export interface Assembled {
  openQuestions: OpenQuestion[];
  choices: Choice[];
  cards: StepCard[];
}

/** The id a draft is checked under before it has its own. */
const DRAFT_ID = "c-00";

/** The id of the choice at `index` in frontier order: c-01, c-02, ... */
export function choiceIdOf(index: number): string {
  return `c-${String(index + 1).padStart(2, "0")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The kind of a thrown value, as a label for the log (never its message, which may hold words). */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "thrown";
}

/** What one slot gave: its offer, or why it offers nothing (logged in slot order once every slot has settled). */
type SlotResult =
  | { offer: SourceOffer }
  | {
      event: "frontier_source_missing" | "frontier_source_failed" | "frontier_source_refused";
      fields: LogFields;
    };

/** One slot's offer, or why it offers nothing: not built, thrown, or refused by K-02 v1. */
async function offerOf(
  slot: SourceSlot,
  input: FrontierInput,
  checker: FrontierChecker,
): Promise<SlotResult> {
  if (slot.source === null) return { event: "frontier_source_missing", fields: { source: slot.name } };
  let offer: unknown;
  try {
    offer = await slot.source.offer(input);
  } catch (error) {
    return { event: "frontier_source_failed", fields: { source: slot.name, error: errorKind(error) } };
  }
  const problems = problemsIn(offer, checker);
  if (problems > 0) return { event: "frontier_source_refused", fields: { source: slot.name, problems } };
  return { offer: offer as SourceOffer };
}

/** How many problems K-02 v1 finds in an offer: each open question, each choice (under a draft id) and each card. */
function problemsIn(offer: unknown, checker: FrontierChecker): number {
  if (
    !isRecord(offer) ||
    !Array.isArray(offer.openQuestions) ||
    !Array.isArray(offer.choices) ||
    !Array.isArray(offer.cards)
  ) {
    return 1;
  }
  let problems = 0;
  for (const question of offer.openQuestions) problems += checker.check("openQuestion", question).length;
  for (const choice of offer.choices) {
    const draft: unknown = isRecord(choice) ? { ...choice, choiceId: DRAFT_ID } : choice;
    problems += checker.check("choice", draft).length;
  }
  for (const card of offer.cards) problems += checker.check("stepCard", card).length;
  return problems;
}

/** Every option of an open question is high when any one of its options is high by its own walk (K-02 README). */
function spreadQuestionStakes(choices: readonly Choice[]): Choice[] {
  const high = new Map<string, string[]>();
  for (const choice of choices) {
    if (choice.kind === "option" && choice.question !== null && choice.stakes === "high") {
      high.set(choice.question, [...(high.get(choice.question) ?? []), choice.choiceId]);
    }
  }
  return choices.map((choice) => {
    if (choice.kind !== "option" || choice.question === null || choice.stakes === "high") return choice;
    const siblings = high.get(choice.question) ?? [];
    if (siblings.length === 0) return choice;
    const stakesFrom: StakesReason[] = siblings.map((id) => ({ why: "question", step: null, ref: id }));
    return { ...choice, stakes: "high", stakesFrom };
  });
}

/** Runs every slot on the same input and assembles what they offer, in slot order. */
export async function assemble(
  slots: readonly SourceSlot[],
  input: FrontierInput,
  checker: FrontierChecker,
): Promise<Assembled> {
  const results = await Promise.all(slots.map((slot) => offerOf(slot, input, checker)));

  const openQuestions: OpenQuestion[] = [];
  const cards: StepCard[] = [];
  const drafts: { source: string; draft: DraftChoice }[] = [];
  results.forEach((result, index) => {
    if (!("offer" in result)) {
      input.log.warn(result.event, result.fields);
      return;
    }
    const { offer } = result;
    const source = slots[index]?.name ?? "unknown";
    for (const question of offer.openQuestions) {
      if (!openQuestions.some((listed) => listed.openQuestionId === question.openQuestionId)) {
        openQuestions.push(question);
      }
    }
    for (const card of offer.cards) {
      if (!cards.some((listed) => listed.step === card.step)) cards.push(card);
    }
    for (const draft of offer.choices) drafts.push({ source, draft });
  });

  const listed = new Set(openQuestions.map((question) => question.openQuestionId));
  const kept = drafts.filter(({ source, draft }) => {
    if (draft.kind !== "option" || draft.question === null || listed.has(draft.question)) return true;
    input.log.warn("frontier_option_orphaned", { source, open_question_id: draft.question });
    return false;
  });

  const numbered: Choice[] = kept.map(({ draft }, index) => ({ ...draft, choiceId: choiceIdOf(index) }));
  return { openQuestions, choices: spreadQuestionStakes(numbered), cards };
}
