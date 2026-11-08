// The guard (T-250; C-051): START, HELP and the pinned bundle's 16 opt-out words by code alone, then the handle's targets.
// See guard.ts. The fixed replies are ./replies (T-267); the after-stop rules (T-268) build beside them in this folder.

export { guardTurn, type GuardTurn } from "./guard";
export {
  actionFor,
  fixedLinePlan,
  fixedLinesOf,
  replyToKeywords,
  setReplyDeps,
  wordsFor,
  HELP_REPLY,
  K09_LINE_IN_K01,
  Q01_DRAFTED,
  START_REPLY,
  STOP_REPLY,
  type BusinessTold,
  type CoreCommitAnswer,
  type CoreCommitRequest,
  type CoreCommitted,
  type FixedLineRow,
  type KeywordReply,
  type RecordStopOrStartRequest,
  type RecordStopOrStartResponse,
  type RepliesResult,
  type ReplyCore,
  type ReplyCoreAction,
  type ReplyCoreResult,
  type ReplyDeps,
  type ReplyOutcome,
  type ReplyRows,
  type ReplyTurn,
  type ReplyWords,
  type SendFixedLineRequest,
  type SendFixedLineResponse,
  type TurnCaller,
  type UnplannedRow,
  type WordsFrom,
  type WritePlanAnswer,
  type WritePlanRequest,
} from "./replies";
export { keyOf, keywordOf, keywordsOf, KeywordList } from "./keywords";
export {
  readTargets,
  setGuardDeps,
  targetsOf,
  type GuardDeps,
  type TargetCounts,
  type TargetsRead,
} from "./targets";
export * from "./types";
