// The guard's fixed replies (T-267; C-052): STOP, START and HELP alone get their fixed reply from code, no composer. See
// replies.ts; the words are words.ts's.

export {
  actionFor,
  fixedLinePlan,
  replyToKeywords,
  setReplyDeps,
  type KeywordReply,
  type RepliesResult,
  type ReplyTurn,
} from "./replies";
export * from "./types";
export {
  HELP_REPLY,
  K09_LINE_IN_K01,
  Q01_DRAFTED,
  START_REPLY,
  STOP_REPLY,
  fixedLinesOf,
  wordsFor,
} from "./words";
