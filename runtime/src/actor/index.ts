// The handle actor (T-244; C-046): one Durable Object per handle with an ordered, persisted inbox of sealed events.

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
export { setSafetyDeps, type HoldEntry, type SafetyEntry } from "../safety";
