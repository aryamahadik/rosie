// The frontier's first source (T-291; C-075; S13-12): every open question sent to this handle, each with its options
// (arch 03 line 159: "Open questions: every one sent to this handle (S13-12). Questions about other bookings add only
// their options, labeled by business, date and time"). It reads the stored state the assembler was given: the open
// question rows (K-04 v1 open_questions as K-05 v1.2 readTurnState reads them: the step, the bundle it was asked under,
// when it went and its poll), the business's name and the open questions' bookings' visit times.
//
// For each open question, in the stored order:
//   - not sent yet (no part gone, K-05 v1.2 sentAt null): not offered (frontier_question_not_sent);
//   - its target labelled by business, date and time (K-02 v1 target): the business's name, and for a booking its
//     visit's date and time in the visit's zone; a target that cannot be labelled (another business's question, or a
//     booking whose visit time was not read) is not offered (frontier_question_unlabelled), so two bookings' options are
//     never told apart by guesswork;
//   - its step and card from the bundle it was asked under (K-04 v1 open_questions.bundle_hash, bundle_build), so the
//     options are the ones that question offered; a step or card that bundle does not hold: not offered
//     (frontier_step_missing, frontier_bundle_missing);
//   - one option per branch the card defines (K-01 v1 card.means, in order), each the branch's label word for word and
//     its definition, tagged message (arch 03 line 161: only message branches enter the list; code settles lookups and
//     clock rows settle clocks); a means entry with no definition or no such branch is left out
//     (frontier_option_unusable);
//   - each option's fields (the branch's answer fields; with none listed, the step's gives keys as text fields: the
//     default K-02's context-s1-02.json shows for S1-02's "kinds") and its stakes from its own walk (bundle.ts);
//   - a plain step with no card whose message carries buttons (S1-04: T-1478; K-09 README v1.11 defaults 179, 180 and
//     188): one option per button, in order, from the bundle the question was asked under, when K-09's table
//     (buttons.ts) lists that step's buttons word for word, all of them and in order: `label` and `branch` the button's
//     words, `definition` and `fields` the table's, and stakes from the walk every answer takes (bundle.ts
//     plainStepStakes: the step's gives, then the walk from its next). Such a step has no card to give (a K-01 card is a
//     split's). A buttons step the table does not list so, or whose buttons cannot be read, is not offered
//     (frontier_buttons_unlisted: fail closed); a step with no card that is a split, or that carries no buttons, is not
//     offered (frontier_step_missing), as before;
//   - the question in the context's open questions (its send time in the visit's zone, else the business's), and the
//     step's full card once, when it has one.
// The guard's open question ids that this business's read does not hold are logged (frontier_question_unread): another
// business's question is read in its own business's call (K-05 v1.2 readTurnState: one business per call).
//
// The branch gates of T-292 (fact, switch and record gates on the branches below), hubs and doors (T-293), any-time rows
// (T-294) and facts with the 60 cap (T-295) are other sources'. Never logged: a label, a definition or a name.

import { findStep, ownStakes, plainStepStakes } from "../../assemble/bundle";
import {
  bundleKey,
  type AnswerField,
  type BundleBranch,
  type BundleStep,
  type BundleView,
  type DraftChoice,
  type FlowView,
  type FrontierInput,
  type FrontierSource,
  type LogFields,
  type OpenQuestion,
  type OpenQuestionRow,
  type SourceOffer,
  type StepCard,
  type Target,
} from "../../assemble/types";
import { buttonsOptionsOf, type ButtonsOption } from "./buttons";

/** This source's slot name (registry.ts). */
export const OPEN_QUESTIONS = "openQuestions";

/** The branch's answer fields; with none listed, the step's gives keys, each a text field (see above). */
function fieldsOf(step: BundleStep, branch: BundleBranch): AnswerField[] {
  if (branch.answerFields.length > 0) return branch.answerFields.map((field) => ({ ...field }));
  return step.gives.map((name) => ({ name, type: "text" }));
}

/** The question's target, labelled by business, date and time; null when it cannot be labelled under this read. */
function targetOf(row: OpenQuestionRow, input: FrontierInput): Target | null {
  if (row.businessId !== input.business.id) return null;
  const base = { businessId: input.business.id, businessName: input.business.name };
  if (row.bookingId === null) return { ...base, bookingId: null, visitAt: null };
  const visitAt = input.visits.get(row.bookingId) ?? null;
  if (visitAt === null) return null;
  return { ...base, bookingId: row.bookingId, visitAt: { utc: visitAt.utc, zone: visitAt.zone } };
}

/** The ids one row is logged by. */
function idsOf(row: OpenQuestionRow): LogFields {
  return row.bookingId === null
    ? { open_question_id: row.id, step: row.step }
    : { open_question_id: row.id, step: row.step, booking_id: row.bookingId };
}

interface Asked {
  question: OpenQuestion;
  choices: DraftChoice[];
  /** The step's full card; null for a plain step asked with buttons, which has none (a K-01 card is a split's). */
  card: StepCard | null;
}

/** Where one open question's step was found: the bundle it was asked under, the flow graph holding it, and the step. */
interface AskedAt {
  row: OpenQuestionRow;
  target: Target;
  bundle: BundleView;
  flow: FlowView;
  step: BundleStep;
}

/** The options a split's card defines, one per message branch its Means lines define; a branch it cannot use is logged. */
function cardChoices(at: AskedAt, card: StepCard["card"], input: FrontierInput): DraftChoice[] {
  const { row, target, bundle, flow, step } = at;
  const choices: DraftChoice[] = [];
  for (const means of card.means) {
    const branch = step.branches.find((each) => each.label === means.branch);
    if (branch?.tag !== "message" || means.from === "none" || means.text === undefined) {
      input.log.warn("frontier_option_unusable", idsOf(row));
      continue;
    }
    const reasons = ownStakes(bundle, flow, step, branch);
    choices.push({
      kind: "option",
      question: row.id,
      branch: branch.label,
      anytimeRow: null,
      door: null,
      hub: null,
      label: branch.label,
      definition: means.text,
      step: row.step,
      target,
      fields: fieldsOf(step, branch),
      stakes: reasons.length > 0 ? "high" : "low",
      stakesFrom: reasons,
    });
  }
  return choices;
}

/** Whether a step is a plain step with no card whose message carries buttons, readable or not (K-09 default 179). */
function asksWithButtons(step: BundleStep): boolean {
  const carries = step.buttons === null || (step.buttons !== undefined && step.buttons.length > 0);
  return step.split === null && step.card === null && carries;
}

/**
 * Each button of the step with the table's option for it, in the buttons' order; null when the buttons cannot be read,
 * the table lists no such step, or the step's buttons are not the table's labels word for word, all of them and in the
 * table's order (a button reworded, dropped, added or moved: the table no longer says what each one means, so none is
 * offered on a guess, and every question the frontier offers keeps K-09's rule buttonsOptionChoices).
 */
function listedButtons(step: BundleStep, stepId: string): { button: string; option: ButtonsOption }[] | null {
  const buttons = step.buttons ?? null;
  const options = buttonsOptionsOf(stepId);
  if (buttons === null || options === null) return null;
  if (buttons.length !== options.length) return null;
  const listed: { button: string; option: ButtonsOption }[] = [];
  for (const [index, button] of buttons.entries()) {
    const option = options[index];
    if (option?.label !== button) return null;
    listed.push({ button, option });
  }
  return listed;
}

/**
 * The options of a plain step asked with buttons (K-09 README v1.11 defaults 179 and 180): one per button, in order, the
 * button's words its label and branch, the table's definition and fields, and the stakes of the walk every answer takes;
 * none when the table does not list the step's buttons so (listedButtons; logged by ids, never a label or a definition).
 */
function buttonsChoices(at: AskedAt, input: FrontierInput): DraftChoice[] {
  const { row, target, bundle, flow, step } = at;
  const listed = listedButtons(step, row.step);
  if (listed === null) {
    input.log.warn("frontier_buttons_unlisted", idsOf(row));
    return [];
  }
  const reasons = plainStepStakes(bundle, flow, step);
  return listed.map(({ button, option }) => ({
    kind: "option",
    question: row.id,
    branch: button,
    anytimeRow: null,
    door: null,
    hub: null,
    label: button,
    definition: option.definition,
    step: row.step,
    target,
    fields: option.fields.map((field) => ({ ...field })),
    stakes: reasons.length > 0 ? "high" : "low",
    stakesFrom: reasons.map((reason) => ({ ...reason })),
  }));
}

/** One open question's entry, options and card, or null when it is not offered (logged). */
function askedOf(row: OpenQuestionRow, input: FrontierInput): Asked | null {
  const { log } = input;
  if (row.sentAt === null) {
    log.warn("frontier_question_not_sent", idsOf(row));
    return null;
  }
  const target = targetOf(row, input);
  if (target === null) {
    log.warn("frontier_question_unlabelled", idsOf(row));
    return null;
  }
  const bundle = input.bundles.get(bundleKey(row.bundleId)) ?? null;
  if (bundle === null) {
    log.warn("frontier_bundle_missing", idsOf(row));
    return null;
  }
  const found = findStep(bundle, row.step, input.flow);
  const card = found?.step.card ?? null;
  if (found === null || (card === null && !asksWithButtons(found.step))) {
    log.warn("frontier_step_missing", idsOf(row));
    return null;
  }

  const at: AskedAt = { row, target, bundle, flow: found.flow, step: found.step };
  const choices = card === null ? buttonsChoices(at, input) : cardChoices(at, card, input);
  if (choices.length === 0) return null;

  const zone = target.visitAt?.zone ?? input.business.zone;
  return {
    question: {
      openQuestionId: row.id,
      step: row.step,
      target,
      sentAt: { utc: row.sentAt, zone },
      pollId: row.pollId,
      askCount: row.askCount,
    },
    choices,
    card: card === null ? null : { step: row.step, card },
  };
}

/** Every open question sent to this handle that this business's read holds, with its options and its step's card. */
export function offerOpenQuestions(input: FrontierInput): SourceOffer {
  const offer: SourceOffer = { openQuestions: [], choices: [], cards: [] };
  const rows = input.state.openQuestions;
  for (const id of input.request.targets.openQuestionIds) {
    if (!rows.some((row) => row.id === id))
      input.log.warn("frontier_question_unread", { open_question_id: id });
  }
  for (const row of rows) {
    const asked = askedOf(row, input);
    if (asked === null) continue;
    offer.openQuestions.push(asked.question);
    const { card } = asked;
    if (card !== null && !offer.cards.some((each) => each.step === card.step)) offer.cards.push(card);
    offer.choices.push(...asked.choices);
  }
  return offer;
}

/** The open-questions source, the frontier's first slot. */
export const openQuestionsSource: FrontierSource = {
  name: OPEN_QUESTIONS,
  offer: offerOpenQuestions,
};
