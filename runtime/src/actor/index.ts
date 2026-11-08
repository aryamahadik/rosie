// The handle actor (T-244; C-046): one Durable Object per handle with an ordered, persisted inbox of sealed events, the
// safety read on arrival (T-246), the batch window (T-247), the turn lease (T-248) with its crash path and park (T-253), and
// the bundle pin at turn start (T-249).

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
  SCHEDULE_SAFETY,
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
  PARK_RETRY_MS,
  type CommitAnswer,
  type CommitContext,
  type CommitOptions,
  type CommitTurnAnswer,
  type CommitTurnCommitted,
  type CommitTurnError,
  type CommitTurnRef,
  type CommitTurnRequest,
  type LeasedTurn,
  type LeaseHooks,
  type LeaseRefusal,
  type ParkAlreadyCommitted,
  type ParkAnswer,
  type ParkingTurn,
  type ParkNotDone,
  type ParkParked,
  type ParkTraceRequest,
  type TurnEntry,
  type TurnState,
} from "./lease";
export { setSafetyDeps, type HoldEntry, type OpenHold, type SafetyEntry } from "../safety";
export { setBundleDeps, type PinEntry } from "../bundle";
