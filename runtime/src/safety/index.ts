// The safety read on arrival (T-246; C-047): the handle actor's part, with the resume of a read cut off by an eviction
// (T-1088). The safety prompt and labels are T-365's.

export {
  SafetyOnArrival,
  isReadable,
  isReadableEvent,
  setSafetyDeps,
  type HoldEntry,
  type OpenHold,
  type ResumedRead,
  type SafetyEntry,
  type SafetyHost,
  type StoredText,
} from "./arrival";
export {
  checkedLineFor,
  dangerOutcomes,
  matchDangerWords,
  normalizeWords,
  strictestHold,
  timeoutLineId,
  timeoutResult,
} from "./rules";
export * from "./types";
