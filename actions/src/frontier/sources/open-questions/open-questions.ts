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
//   - the question in the context's open questions (its send time in the visit's zone, else the business's), and the
//     step's full card once.
// The guard's open question ids that this business's read does not hold are logged (frontier_question_unread): another
// business's question is read in its own business's call (K-05 v1.2 readTurnState: one business per call).
//
// The branch gates of T-292 (fact, switch and record gates on the branches below), hubs and doors (T-293), any-time rows
// (T-294) and facts with the 60 cap (T-295) are other sources'. Never logged: a label, a definition or a name.

import { findStep, ownStakes } from "../../assemble/bundle";
import {
  bundleKey,
  type AnswerField,
  type BundleBranch,
  type BundleStep,
  type DraftChoice,
  type FrontierInput,
  type FrontierSource,
  type LogFields,
  type OpenQuestion,
  type OpenQuestionRow,
  type SourceOffer,
  type StepCard,
  type Target,
} from "../../assemble/types";

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
  card: StepCard;
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
  if (found === null || card === null) {
    log.warn("frontier_step_missing", idsOf(row));
    return null;
  }

  const choices: DraftChoice[] = [];
  for (const means of card.means) {
    const branch = found.step.branches.find((each) => each.label === means.branch);
    if (branch?.tag !== "message" || means.from === "none" || means.text === undefined) {
      log.warn("frontier_option_unusable", idsOf(row));
      continue;
    }
    const reasons = ownStakes(bundle, found.flow, found.step, branch);
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
      fields: fieldsOf(found.step, branch),
      stakes: reasons.length > 0 ? "high" : "low",
      stakesFrom: reasons,
    });
  }
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
    card: { step: row.step, card },
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
    if (!offer.cards.some((card) => card.step === asked.card.step)) offer.cards.push(asked.card);
    offer.choices.push(...asked.choices);
  }
  return offer;
}

/** The open-questions source, the frontier's first slot. */
export const openQuestionsSource: FrontierSource = {
  name: OPEN_QUESTIONS,
  offer: offerOpenQuestions,
};
