// Limit 8 at send (T-259; C-125, C-241). See limit8.ts.

export {
  CUSTOMER_OPENS,
  STAFF_OPENS,
  decideLimit8,
  isStopReply,
  versionsChanged,
  type Limit8Decision,
  type Limit8Input,
  type SendReason,
} from "./limit8";
export { checkTextHours, instantOfLocal, minutesOf, partsInZone } from "./text-hours";
