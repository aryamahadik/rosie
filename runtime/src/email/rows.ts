// The email rows (T-1286, "T-264a": the part of T-264 the sign-in lane needs; C-129; K-12 v1 README 'The email row';
// ADR-016 sections 1, 3 and 5; arch 07 line 371): the K-12 `sendEmail` request an email outbox row goes as, built by code
// from the claimed row and its recipient's address. K-07 v1's final parts carry the words; the email rows add what they
// carry none of (K-12 README line 29; K-07 open gap 7): the subject, the automated-assistant line, which also opens the
// email's text (RULES 1.11), the From, and for an email about a booking its reply address, manage link and thread.
//
// Built here: the one email the sign-in lane sends, a code row about no business, booking or question (K-05 v1.13 item
// 59: sendSignInCode's row, email_purpose `code`), whose final parts are one words send holding the code's own line
// (ADR-016 section 1; T-322's words). It goes in K-12 send-code.json's form: from "Rosie" (K-12 default 3: an email Rosie
// writes for no business) at the configured address, the subject "Your Rosie code", the assistant line with no business
// and then the words, and no reply address, manage link, chat link or thread (an email about no booking has none: K-04
// threads_chat_or_email). The words and the line are stand-ins for Jay's (ADR-016 open point 5).
//
// Not built here, so never sent (the dispatcher ends the row `notBuilt` and leaves its claim to lapse): any other
// purpose, a row that names none, and a code row about a business, a booking or a question. A business's From name, its
// assistant line (S1-10's code says "setting up <business>"), a booking's reply address, manage link and thread, typed
// options and copies need what the claimed row does not carry: T-264's.
//
// Pure: no I/O, and nothing is logged. A NotBuilt reason is a label, never a value.

import type { ClaimedRow } from "../dispatch/types";
import type { EmailSendRequest } from "./types";

/** K-12 default 3: the From name of an email Rosie writes for no business, such as a sign-in code. */
export const ROSIE_NAME = "Rosie";

/**
 * K-12 default 2's example of the one confirmation address on mail.rosfield.com (DL-028; T-1032's live check sends from
 * it): a config value the wiring hands the dispatcher (EmailRowsDeps.fromAddress), this one until a config names another.
 */
export const ROSIE_FROM_ADDRESS = "rosie@mail.rosfield.com";

/** A code email's subject, built by code (K-12 send-code.json; ADR-016 section 1). */
export const CODE_SUBJECT = "Your Rosie code";

/**
 * The automated-assistant line of an email about no business (RULES 1.11; ADR-016 section 1: "with no business: This is
 * Rosie, an automated assistant."), the text's first line. A stand-in for Jay's words (ADR-016 open point 5).
 */
export const ASSISTANT_LINE = "This is Rosie, an automated assistant.";

/** Why an email row is not built here: a label for the dispatch span. */
export type NotBuilt =
  /** Not a code row: a confirmation, copy, emailWay, nextWay or notice (T-264's), or a row that names no purpose. */
  | "purposeNotBuilt"
  /** A code row about a business, a booking or a question: its line, its From and a thread need T-264's reads. */
  | "aboutNotBuilt"
  /** Final parts that are not one words send of words alone (no file, option, link, fixed line or thread). */
  | "partsNotBuilt";

/** The words of a row's one words send, or null when its final parts are anything else. */
function wordsOf(row: ClaimedRow): string | null {
  const { sends, fixedLines, threadReplyTo } = row.finalParts;
  const [send, ...more] = sends;
  if (send === undefined || more.length > 0 || fixedLines.length > 0 || threadReplyTo !== null) return null;
  if (send.kind !== "words" || send.calendarFile !== "none" || send.options.length > 0 || send.link !== null)
    return null;
  return send.text !== null && send.text.trim() !== "" ? send.text : null;
}

/**
 * The words of an email row these email rows build (a code row about no business, booking or question, whose final
 * parts are one words send), or why it is not built here. Reads the row alone: no recipient is read for a row that is
 * not built.
 */
export function emailWordsOf(row: ClaimedRow): { words: string } | { notBuilt: NotBuilt } {
  if (row.emailPurpose !== "code") return { notBuilt: "purposeNotBuilt" };
  if (row.businessId !== null || row.bookingId !== null || row.openQuestionId !== null)
    return { notBuilt: "aboutNotBuilt" };
  const words = wordsOf(row);
  return words === null ? { notBuilt: "partsNotBuilt" } : { words };
}

/** One address, as K-12 sends to it: one @, no white space. */
const ADDRESS = /^[^@\s]+@[^@\s]+$/u;

/**
 * The recipient's address as K-12 sends to it, in lower case (K-12 `to`; K-04 handles.address), or null when the value is
 * no address: nothing is then sent.
 */
export function emailAddressOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return ADDRESS.test(address) ? address : null;
}

export interface CodeEmailInput {
  /** The part's K-07 key, `<row>/1/<try>`. */
  idempotencyKey: string;
  /** The row's words, as emailWordsOf gave them. */
  words: string;
  /** The recipient's address, as emailAddressOf gave it. */
  to: string;
  /** The one confirmation address on mail.rosfield.com (EmailRowsDeps.fromAddress). */
  fromAddress: string;
}

/**
 * The K-12 request of a code row: send-code.json's form for an email about no business or booking. The text is the
 * assistant line, a blank line and the words.
 */
export function codeEmailRequest(input: CodeEmailInput): EmailSendRequest {
  return {
    idempotencyKey: input.idempotencyKey,
    purpose: "code",
    bookingId: null,
    from: { name: ROSIE_NAME, address: input.fromAddress },
    to: input.to,
    replyTo: null,
    subject: CODE_SUBJECT,
    text: `${ASSISTANT_LINE}\n\n${input.words}`,
    assistantLine: ASSISTANT_LINE,
    manageLink: null,
    chatLink: null,
    thread: { inReplyTo: null, references: [] },
  };
}
