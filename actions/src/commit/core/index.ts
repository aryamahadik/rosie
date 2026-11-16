// The commit's runCore (C-087 with C-104 and C-078, T-1140, T-1163, T-1414): each K-09 v1 core action of a turn run by
// its shared-core service inside the turn's one commit: recordSafetyOutcome and releaseSafetyHold through the safety
// service (T-318), recordStopOrStart and setRecordFlag through the flags service (T-317) with the flags port the
// wiring binds, and sendFixedLine (HELP's reply) through the fixed-lines service on the same port; every other core
// action answers notBuilt. See core.ts.

export { createRunCore, type CoreDeps, type CoreFlagsDeps, type CoreSafetyDeps } from "./core";
export { CoreNotBuiltError, CoreRefusedError, type CoreFault, type CoreGap } from "./errors";
export { FIXED_LINE_OF, STRICTEST_LINE, coreSafetyLines } from "./lines";
