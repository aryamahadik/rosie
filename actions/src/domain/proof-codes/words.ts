// What a proof code's person reads (T-322; ADR-016 section 1, "The words"; DL-526): the code's own line, code-built, in
// the words the sources give, with every value filled by code (rules 3 and 4): the code itself and its 10 minutes.
//
//   - The email row holds only the code's own line, "Code NNNNNN: type it on the sign-in page. It works for 10 minutes."
//     (K-12 v1 send-code.json's form), naming no business or booking (K-09 v1 tool-api schema line 4065: words that
//     never confirm a booking exists). The subject, the automated-assistant line and the sender are the email path's, as
//     for every email row (K-12 README line 29), never this row's.
//   - The ready text a person texts from that mobile (MC C9) is K-09 v1 proof-code-text-from-mobile.json's, "My Rosie
//     sign-in code is NNNNNN".
//   - The row's plan is code-built, as a fixed line's row is (CQ-177 item 128; write-plan-alex-safety.json): K-03 v1
//     rowPlan with no lines of its own, and final parts of one words send with the line in it. There is no K-03 v1 slot
//     for a code (K-09 README open gap 25), so the line names no slot and no fixed line.
//
// Both lines are stand-ins for Jay's words (ADR-016 open point 5). The sources give words for a sign-in code only, so a
// code of any other purpose has none here (wordsFor answers null) and is not sent (send.ts default 3).

import type { Purpose } from "./rules";
import { CODE_LIFE_MINUTES } from "./rules";

/** The words of one purpose's code. */
export interface CodeWords {
  /** The email row's one line, with the code in it. */
  email(code: string): string;
  /** The ready text the person texts from the mobile the code proves, with the code in it. */
  readyText(code: string): string;
}

const SIGN_IN_WORDS: CodeWords = {
  email: (code) =>
    `Code ${code}: type it on the sign-in page. It works for ${String(CODE_LIFE_MINUTES)} minutes.`,
  readyText: (code) => `My Rosie sign-in code is ${code}`,
};

/** The words of a purpose's code, or null when no source gives any. */
export function wordsFor(purpose: Purpose): CodeWords | null {
  return purpose === "signIn" ? SIGN_IN_WORDS : null;
}

/** K-03 v1 `send` of a code's line: one words part. */
export interface CodeWordsSend {
  readonly kind: "words";
  /** The line with the code in it: never logged, never in a span or an event-log entry. */
  readonly text: string;
  readonly calendarFile: "none";
  readonly options: readonly never[];
  readonly link: null;
}

/** K-03 v1 `rowPlan` of a code's email row: no lines of its own, since code builds the line. */
export interface CodeRowPlan {
  readonly row: string;
  readonly channel: "email";
  readonly copyOf: null;
  readonly plan: {
    readonly formats: readonly ["text"];
    readonly lines: readonly never[];
    readonly question: null;
    readonly pageType: null;
    readonly threadReplyTo: null;
  };
}

/** K-03 v1 `finalParts` of a code's email row: its one line, no fixed line and no slot (no K-03 v1 slot for a code). */
export interface CodeFinalParts {
  readonly row: string;
  readonly channel: "email";
  readonly sends: readonly [CodeWordsSend];
  readonly fixedLines: readonly never[];
  readonly slotValues: readonly never[];
  readonly threadReplyTo: null;
}

/** The plan of the email row `rowId`. */
export function codeRowPlan(rowId: string): CodeRowPlan {
  return {
    row: rowId,
    channel: "email",
    copyOf: null,
    plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
  };
}

/** The final parts of the email row `rowId`, holding `line`. */
export function codeFinalParts(rowId: string, line: string): CodeFinalParts {
  return {
    row: rowId,
    channel: "email",
    sends: [{ kind: "words", text: line, calendarFile: "none", options: [], link: null }],
    fixedLines: [],
    slotValues: [],
    threadReplyTo: null,
  };
}
