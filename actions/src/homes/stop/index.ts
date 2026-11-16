// The stop home (T-590; C-102, C-078; S13-32 with Master Corrections C1): texts only with the person's own yes (never on
// someone else's word), one number stops every business until START, the opt-out line on the very first text only, and a
// stop word that stops texts and never cancels a visit. See words.ts, stop.ts, reads.ts and home.ts.
export { StopHomeError } from "./errors";
export {
  STOP_POINTS,
  stopHome,
  stopRule,
  type StopHomeContext,
  type StopPoint,
  type StopRuling,
} from "./home";
export { readStop, type StopHomeReads, type StopReadRequest } from "./reads";
export {
  STOP_ANSWERS,
  TEXT_RULINGS,
  mayText,
  numberStop,
  optOutLine,
  stopWordEffect,
  textsYes,
  type MayTextWhy,
  type NumberStop,
  type OptOutLine,
  type StopAnswers,
  type StopMessage,
  type StopPhone,
  type StopReading,
  type StopWord,
  type StopWordEffect,
  type TextDecision,
  type TextRuling,
  type TextsRow,
  type TextsYes,
  type TextsYesWhy,
  type TurnRef,
} from "./stop";
export {
  WHOSE_WORDS,
  YES_WAYS,
  yesCounts,
  type WhoseWord,
  type YesCounts,
  type YesCountsWhy,
  type YesGiven,
  type YesWay,
} from "./words";
