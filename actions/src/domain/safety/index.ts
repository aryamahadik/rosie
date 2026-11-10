// The safety service (T-318; C-104): each text's safety outcome recorded with its words sealed, its hold on routine work
// (a threat pauses the person and their phone, unsafe at home makes the booking private), and the hold's release only by
// its rule: at once after the message, once the booking is private, or after a clear "we're safe" with a fresh read-back;
// a threat's never. The commit's runCore (T-1140) calls recordSafetyOutcomeCore and releaseSafetyHoldCore; paging and
// hand-offs are T-319's (the SafetyTelling port).

export { SafetyRefusedError, type SafetyFault } from "./errors";
export {
  recordSafetyOutcomeAlone,
  recordSafetyOutcomeCore,
  recordSafetyOutcomeHandler,
  releaseSafetyHoldAlone,
  releaseSafetyHoldCore,
  releaseSafetyHoldHandler,
  type RecordCoreRun,
  type ReleaseCoreRun,
  type SafetyCoreRun,
  type SafetyDeps,
} from "./handlers";
export { KEYED_SAFETY_IDS, type SafetyIds, type SafetyRow } from "./ids";
export {
  FIXED_SAFETY_LINES,
  NOT_TOLD_YET,
  PLUGIN_LISTS_NO_STOP_WORDS,
  STOP_WORDS_NOT_WIRED,
  noSafetyReads,
  type HotlineKind,
  type OwnerContact,
  type SafetyLineChoice,
  type SafetyLines,
  type SafetyReader,
  type SafetyTelling,
  type SafetyTold,
  type StopWords,
  type StoredHold,
  type StoredOutcome,
  type TellPlan,
  type TellRequest,
  type WordsSealer,
} from "./ports";
export {
  RECORD_STEP,
  base64Of,
  byteaText,
  carriedByTurn,
  joinWrites,
  planRecordSafetyOutcome,
  wordsOf,
  type CarryingTurn,
  type RecordAnswer,
  type RecordCall,
  type RecordError,
  type RecordPlan,
  type RecordPorts,
  type RecordRequest,
  type RecordResponse,
} from "./record";
export {
  RELEASE_STEP,
  planReleaseSafetyHold,
  type ReleaseAnswer,
  type ReleaseCall,
  type ReleaseError,
  type ReleasePlan,
  type ReleasePorts,
  type ReleaseRequest,
  type ReleaseResponse,
} from "./release";
export {
  HOLD_OF,
  LINE_ORDER,
  SAFETY_OUTCOMES,
  STRICTNESS,
  TELLS,
  WHY_OF_RULE,
  dangerOf,
  isClearSafe,
  labelsOf,
  lineOutcomeOf,
  mustSendLine,
  nothingBooksUnder,
  ruleOf,
  stricter,
  strictestOf,
  tellsOf,
  type ReleaseRule,
  type ReleasedWhy,
  type SafetyOutcome,
  type SafetyResult,
  type Tense,
} from "./rules";
