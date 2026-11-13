// The outbox dispatcher (T-257, T-258; C-124). See dispatcher.ts.

export {
  handleDeliveryReceipt,
  runDispatch,
  type DeliveryReceipt,
  type DispatchDeps,
  type DispatchOptions,
  type DispatchReport,
  type ReceiptDeps,
  type ReceiptResult,
  type RetryReport,
  type RowOutcome,
  type RowReport,
} from "./dispatcher";
export {
  decideLimit8,
  stopStands,
  yesAfterStop,
  type Limit8Decision,
  type Limit8Input,
  type YesAfterStop,
  type YesRefused,
} from "./limit8";
export {
  dispatchSendDoor,
  mayOverrideOptout,
  queueRetries,
  retryRuleFor,
  type DoorOutcome,
  type RetryPlan,
  type RetryRule,
  type RetryScheduler,
} from "./retry";
export type * from "./types";
