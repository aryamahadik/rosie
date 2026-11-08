// The record flags (T-317; C-078 with C-102): recordStopOrStart (STOP, START and a work phone's answer to "which texts?",
// each as consent rows through T-307's messages-and-consent service, with the phone's stopped flag) and setRecordFlag
// (private and deceased on a booking head, paused on a person, a phone or an address), in a turn's commit or made alone,
// including the handle actor's writes on return; and the stopped flag's hard invariant over a commit's rows. The gate's
// own check of the flags is actions/src/gate/flags.

export { FlagRefusedError, type FlagFault } from "./errors";
export { KEYED_IDS, type FlagIds, type FlagRow } from "./ids";
export {
  NO_VISIT_TIMES,
  flagsReaderOf,
  type CoveredVisit,
  type FlagsReader,
  type PauseTargetRef,
  type VisitsCovered,
} from "./reads";
export {
  NO_ALONE_COMMIT,
  databaseOf,
  recordFlagCore,
  recordStopOrStartAlone,
  recordStopOrStartHandler,
  runtimeStopCall,
  setRecordFlagAlone,
  setRecordFlagHandler,
  stopOrStartCore,
  type AloneCommit,
  type AloneCommitAnswer,
  type AloneCommitRequest,
  type FlagCoreRun,
  type FlagsDeps,
  type RecordFlagCoreRun,
  type RuntimeSide,
} from "./handlers";
export {
  CALL_OFF_STEP,
  FLAG_STEPS,
  callOffDueAt,
  planRecordFlag,
  type AddressSealer,
  type RecordFlagAnswer,
  type RecordFlagCall,
  type RecordFlagError,
  type RecordFlagPlan,
  type RecordFlagPorts,
  type RecordFlagRequest,
  type RecordFlagResponse,
} from "./record-flag";
export {
  EVERY_BUSINESS,
  NO_EVENT_SOURCES,
  START_REPLY,
  STOP_REPLY,
  STOP_STEP,
  WHICH_TEXTS_CLOCK,
  WHICH_TEXTS_DEFAULT,
  keyOf,
  planStopOrStart,
  timeOf,
  type CarryingTurn,
  type EventSources,
  type StopOrStartAnswer,
  type StopOrStartCall,
  type StopOrStartError,
  type StopOrStartPlan,
  type StopOrStartPorts,
  type StopOrStartRequest,
  type StopOrStartResponse,
} from "./stop-start";
export {
  assertStopKept,
  isTextRow,
  keepStop,
  rowsAfterFreshYes,
  rowsAfterStop,
  type CommitStop,
  type CommitTurnRef,
  type Dropped,
  type LetThrough,
  type StopKept,
  type StopReads,
} from "./stopped";
export {
  aloneWritesOf,
  eventEntry,
  noWrites,
  unitWritesOf,
  writesNothing,
  type DueClock,
  type EntryActor,
  type FlagWrites,
} from "./writes";
