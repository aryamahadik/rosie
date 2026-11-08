// The turn loop (T-251, T-252; C-046): what runs inside the lease for each run of a turn: the guard, the frontier, decide
// and its one re-read, then gate and commit through the lease (turn.ts); after the commit, each outbox row composed and
// finalized, an email copy taking its text row's plan, and the dispatcher woken once (compose.ts). D-017 joins it:
// `setLeaseHooks(turnHooks)`, `setTurnDeps(...)` (its composer, rows and dispatcher ports included), and `turnReplyCore`
// as the guard's replies' core (`setReplyDeps`).

export {
  composeCommitted,
  SENDS_PER_CALL,
  type CommittedTurn,
  type ComposeReport,
  type RowComposed,
} from "./compose";
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
