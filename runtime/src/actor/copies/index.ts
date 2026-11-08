// The actor's own copies for the database-down path (T-269; C-053): the stopped flag, the checked safety lines, each live
// safety timer's due time, address and emergency contact, and the queue of writes to replay when PostgreSQL returns.

export { ActorCopies, createCopyTables, readCommit, setCopyDeps, type CopiesHost } from "./copies";
export {
  createReturnTables,
  RETURN_RANKS,
  ReturnQueue,
  type Enqueued,
  type QueuedEntry,
  type QueuedWrite,
  type ReplayReport,
  type ReplayStep,
  type ReturnQueueHost,
  type ReturnRank,
  type ReturnWrite,
} from "./return-queue";
export type {
  CheckedLineCopy,
  CommitCopies,
  CopyDeps,
  LineRead,
  LiveTimersAnswer,
  SafetyTimerCopy,
  SafetyTimerRow,
  SafetyTimerSource,
  StoppedCopy,
  StoppedWrite,
  TimerRefresh,
} from "./types";
