// The commit's runCore (C-087 with C-104, T-1140): each K-09 v1 core action of a turn run by its shared-core service inside
// the turn's one commit, first recordSafetyOutcome and releaseSafetyHold through the safety service (T-318); every other
// core action answers notBuilt. See core.ts.

export { createRunCore, type CoreDeps, type CoreSafetyDeps } from "./core";
export { CoreNotBuiltError, type CoreGap } from "./errors";
export { FIXED_LINE_OF, STRICTEST_LINE, coreSafetyLines } from "./lines";
