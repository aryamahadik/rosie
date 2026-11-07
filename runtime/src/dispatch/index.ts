// The outbox dispatcher (T-257; C-124). See dispatcher.ts.

export {
  handleDeliveryReceipt,
  runDispatch,
  type DeliveryReceipt,
  type DispatchDeps,
  type DispatchOptions,
  type DispatchReport,
  type ReceiptDeps,
  type ReceiptResult,
  type RowOutcome,
  type RowReport,
} from "./dispatcher";
export { decideLimit8, type Limit8Decision, type Limit8Input } from "./limit8";
export type * from "./types";
