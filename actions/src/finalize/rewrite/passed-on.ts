// The passed-on path (arch 02 line 123: "None passes: 'I've passed this on. Rosie's team will reply within 1 business
// day.' (S13-29; DD after S12-24); the question is withdrawn, so no clock arms (RULES 5.2), and the team is paged"; arch 07
// line 417; K-03 v1 check-passed-on.json). What goes is K-01's fixed line passedOn word for word (arch 07 line 361), in
// the reader's language, else English; its question is withdrawn with K-05 v1 cancelClock (item 5); one team review item
// is opened, due within 1 business day, the reply the line promises (K-37 v1 review_items; Q-18). Paging the team is
// T-319's (M3b): this card opens no page, so the answer's teamPageId stays null.

import type { CheckContext } from "../checks";
import type { CancelClockRequest, FinalParts, FinalizeRow, PassedOnReview, RowPlan } from "./types";
import { PASSED_ON_REVIEW } from "./types";

/** K-01 v1's fixed line for a message nothing passed (fixed-lines.json `passedOn`; arch 02 line 123). */
export const PASSED_ON_LINE = "passedOn";

/** The passed-on line's words in the reader's language, else English (K-01 v1 `fixedLine`); null when the bundle has none. */
export function passedOnWords(context: CheckContext): string | null {
  const lines = context.lists.fixedLines.lines.filter((line) => line.id === PASSED_ON_LINE);
  const line =
    lines.find((candidate) => candidate.lang === context.language && candidate.text !== null) ??
    lines.find((candidate) => candidate.lang === "en" && candidate.text !== null);
  return line?.text ?? null;
}

/** The passed-on message's parts: the line alone, word for word, no slot filled (K-09 v1 finalize-passed-on.json). */
export function passedOnParts(row: FinalizeRow, plan: RowPlan, words: string): FinalParts {
  return {
    row: row.outboxRowId,
    channel: row.channel,
    sends: [{ kind: "words", text: words, calendarFile: "none", options: [], link: null }],
    fixedLines: [PASSED_ON_LINE],
    slotValues: [],
    threadReplyTo: plan.plan.threadReplyTo,
  };
}

/** K-05 v1 cancelClock for the row's question: its clock row cancelled and the question withdrawn together. */
export function withdrawRequest(row: FinalizeRow, at: string): CancelClockRequest | null {
  const question = row.question;
  if (question === null) return null;
  return {
    clockRowId: question.clockRowId,
    expectVersion: question.clockVersion,
    withdrawQuestion: {
      openQuestionId: question.openQuestionId,
      expectVersion: question.openQuestionVersion,
    },
    at,
  };
}

/**
 * The review item a passed-on message opens: the row under review, and a summary in plain words naming only the step and
 * what happened, never a value or a text's words (K-37 v1 rule 4: "summary ... without private values").
 */
export function passedOnReview(row: FinalizeRow, caller: PassedOnReview["caller"]): PassedOnReview {
  return {
    caller,
    kind: PASSED_ON_REVIEW,
    subject: { table: "outbox_rows", rowId: row.outboxRowId },
    summary: `No reply for step ${row.step} passed the message checks, so the passed-on line went and its question was withdrawn. Reply within 1 business day.`,
  };
}
