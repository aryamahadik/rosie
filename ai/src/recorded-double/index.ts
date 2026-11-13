// The recorded-model double (T-004, C-123). See recordings.ts for what a recording is and what the loader refuses: K-02
// v1's recordings and K-02 v1.1's (the walking skeleton's turn 1, T-1145), each file checked against its own version;
// the composer's call (T-1071) is composer-recordings.ts, over K-03 instead of K-02: K-03 v1's recordings and K-03
// v1.1's (inputs with term facts, T-1175), each file checked against its own version too.

export {
  loadRecordedModel,
  buildRecordedModel,
  buildRecordedModelFromFiles,
  RECORDINGS_FILE,
  RECORDINGS_V1_1_FILE,
  RECORDINGS_FILES,
  type LoadOptions,
} from "./recordings";
export {
  buildRecordedComposer,
  buildRecordedComposerFromFiles,
  loadRecordedComposer,
  loadRecordedDouble,
  COMPOSER_RECORDINGS_FILE,
  COMPOSER_RECORDINGS_V1_1_FILE,
  COMPOSER_RECORDINGS_FILES,
} from "./composer-recordings";
export {
  COMPOSER_KIND,
  type ComposeInput,
  type MessagePlan,
  type RecordedComposer,
  type RecordedDouble,
} from "./composer-types";
export {
  loadPlanContract,
  PLAN_VERSIONS,
  type PlanContract,
  type PlanFixtures,
  type PlanVersion,
} from "./plan-contract";
export {
  loadModelContract,
  MODEL_VERSIONS,
  type ModelContract,
  type ModelFixtures,
  type ModelVersion,
} from "./contract";
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
