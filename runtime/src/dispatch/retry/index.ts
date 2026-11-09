// The dispatcher's retries (T-258; C-124): K-07's key rules for each Linq failure (rules.ts), the wait's job on the retry
// queue (plan.ts, T-256's producer), and the queue's send door (door.ts). See ../dispatcher.ts.

export { dispatchSendDoor, type DoorOutcome, type SendDoorOptions } from "./door";
export {
  queueRetries,
  retryBodyOf,
  retryJobKey,
  retryPlanOf,
  type RetryBody,
  type RetryChain,
  type RetryPlan,
  type RetryPlanInput,
  type RetryScheduler,
  type RetryWhy,
} from "./plan";
export {
  GIVE_UP_AFTER_MS,
  mayOverrideOptout,
  RECEIPT_WAIT_S,
  RETRY_SPACING_S,
  retryRuleFor,
  triesOver,
  waitSecondsFor,
  type RetryRule,
  type RetryRuleName,
} from "./rules";
