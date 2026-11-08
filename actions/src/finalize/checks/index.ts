// The message checks (C-092; T-312): what the finalize call (C-093, T-313) runs on each attempt's final parts.

export {
  BLOCKING_CHECKS,
  CHECKS,
  CHECK_NAMES,
  MAX_LINES,
  MAX_OPTIONS,
  MAX_OPTION_CHARACTERS,
  checkOutcome,
  fixedLinesFaults,
  formatFaults,
  formatsOf,
  lengthAndReadingFaults,
  neverInMessageFaults,
  oneQuestionFaults,
  runMessageChecks,
  shapeFaults,
  valuesFaults,
  type Check,
} from "./checks";
export { LIMITS, grade, longestSentence, sentencesOf, syllables, wordsOf } from "./grade";
export { isOptOutOnly } from "./opt-out";
export type {
  CheckContext,
  CheckLists,
  CheckName,
  CheckOutcome,
  FinalParts,
  FixedLine,
  Format,
  MessageCheckResult,
  Option,
  Send,
  SlotValue,
} from "./types";
