// The recorded-model double (T-004, C-123). See recordings.ts for what a recording is and what the loader refuses; the
// composer's call (T-1071) is composer-recordings.ts, over K-03 v1 instead of K-02 v1.

export { loadRecordedModel, buildRecordedModel, RECORDINGS_FILE, type LoadOptions } from "./recordings";
export {
  buildRecordedComposer,
  loadRecordedComposer,
  loadRecordedDouble,
  COMPOSER_RECORDINGS_FILE,
} from "./composer-recordings";
export {
  COMPOSER_KIND,
  type ComposeInput,
  type MessagePlan,
  type RecordedComposer,
  type RecordedDouble,
} from "./composer-types";
export { loadPlanContract, type PlanContract, type PlanFixtures } from "./plan-contract";
export { loadModelContract, type ModelContract, type ModelFixtures } from "./contract";
export { NoRecordingError, RecordingRefusedError } from "./errors";
export { canonicalJson, requestKey } from "./key";
export type {
  Context,
  DecideRead,
  DecideRequest,
  DecideRole,
  JsonObject,
  PlannerOutput,
  PlannerRequest,
  RecordedModel,
  RecordingKind,
  SafetyRead,
  SafetyReadRequest,
} from "./types";
