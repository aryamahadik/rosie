// The fixed-line inserter (C-089, T-314): the finalize call's insertFixedLines port (T-313; rewrite/types.ts
// FinalizePorts), which adds each fixed line a row carries word for word, outside the length counts, before the message
// checks run (insert.ts). Wiring: `{ ...finalizePorts, insertFixedLines: fixedLineInserter(fixedLinePorts) }`, with the
// send-state reader as fixedLinePorts once it is built; until then notBuiltFixedLinePorts() keeps the call failing closed
// (notBuilt, nothing written). That reader hands K-05 v1.3 readFixedLineFacts' two facts and readOutboxRow's
// answers.texts as read (FixedLineFacts.answeredTexts), from which the inserter adds the danger question (T-1164).

import { FinalizeNotBuiltError, type FinalizePorts } from "../rewrite";
import { insertFixedLines } from "./insert";
import type { FixedLinePorts } from "./types";

export { FixedLineRefusedError, type FixedLineFault } from "./errors";
export {
  asksIfInDanger,
  claimedBusiness,
  dangerQuestionAfter,
  firstTextLines,
  fixedLineText,
  insertFixedLines,
} from "./insert";
export {
  FIRST_TEXT_LINES,
  OPENER_LINE,
  OPT_OUT_LINE,
  PRIVACY_LINK_LINE,
  SAFETY_ASK_LINE,
  SAFETY_LINES,
  STOP_REPLY_LINE,
  type AnsweredText,
  type FirstTextLines,
  type FixedLineFacts,
  type FixedLinePorts,
} from "./types";

/**
 * The finalize call's insertFixedLines port: reads the row's send-state facts through `ports`, in the call's own
 * transaction and business scope, then adds the row's fixed lines (insertFixedLines).
 */
export function fixedLineInserter<Repo>(
  ports: FixedLinePorts<Repo>,
): FinalizePorts<Repo>["insertFixedLines"] {
  return async (parts, row, call) => insertFixedLines(parts, row, await ports.readFixedLines(row, call));
}

/** The send-state reader before its task lands: every read throws, so the finalize call answers notBuilt. */
export function notBuiltFixedLinePorts<Repo = unknown>(): FixedLinePorts<Repo> {
  return {
    readFixedLines: () => Promise.reject(new FinalizeNotBuiltError("insertFixedLines")),
  };
}
