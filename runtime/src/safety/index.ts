// The safety read on arrival (T-246; C-047): the handle actor's part. The safety prompt and labels are T-365's.

export {
  SafetyOnArrival,
  isReadable,
  setSafetyDeps,
  type HoldEntry,
  type SafetyEntry,
  type SafetyHost,
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
