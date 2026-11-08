// The handle actor (T-244; C-046): one Durable Object per handle with an ordered, persisted inbox of sealed events, the
// safety read on arrival (T-246), the batch window (T-247) and the turn lease (T-248).

export {
  ActorRefusal,
  HandleActor,
  setReceiptHooks,
  type ReceiptHandoff,
  type ReceiptHooks,
} from "./handle-actor";
export type { InboxEntry } from "./inbox";
export {
  setBatchHooks,
  MAX_MS,
  MAX_TEXTS,
  QUIET_MS,
  type BatchClock,
  type BatchEntry,
  type BatchHooks,
  type ClosedBatch,
  type CloseReason,
} from "./batch";
export {
  setLeaseHooks,
  turnIdOf,
  LEASE_MS,
  MAX_TRIES,
  type CommitAnswer,
  type CommitTurnAnswer,
  type CommitTurnCommitted,
  type CommitTurnError,
  type CommitTurnRef,
  type CommitTurnRequest,
  type LeasedTurn,
  type LeaseHooks,
  type LeaseRefusal,
  type TurnEntry,
  type TurnState,
} from "./lease";
export { setSafetyDeps, type HoldEntry, type SafetyEntry } from "../safety";
