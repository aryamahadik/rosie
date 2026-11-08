// The turn loop, first half (T-251; C-046): what runs inside the lease for each run of a turn: the guard, the frontier,
// decide and its one re-read, then gate and commit through the lease. See turn.ts. D-017 joins it: `setLeaseHooks
// (turnHooks)`, `setTurnDeps(...)`, and `turnReplyCore` as the guard's replies' core (`setReplyDeps`).

export { turnReplyCore } from "./keywords";
export {
  commitThroughToolApi,
  runTurn,
  runTurnLoop,
  setTurnDeps,
  turnHooks,
  KEYWORD_RUNS,
  type OpenedText,
  type TurnCommitted,
  type TurnNotCommitted,
  type TurnOutcome,
} from "./turn";
export * from "./types";
