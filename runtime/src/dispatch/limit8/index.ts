// Limit 8 at send (T-259, T-1099; C-125, C-241). See limit8.ts.

export {
  CUSTOMER_OPENS,
  STAFF_OPENS,
  decideLimit8,
  isSafety,
  isSmsPort,
  isStopReply,
  stopStands,
  versionsChanged,
  yesAfterStop,
  type Limit8Decision,
  type Limit8Input,
  type SendReason,
  type YesAfterStop,
  type YesRefused,
} from "./limit8";
export { checkTextHours, instantOfLocal, minutesOf, partsInZone } from "./text-hours";
