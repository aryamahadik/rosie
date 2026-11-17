// The real Linq capability check (T-415; C-209; K-11 v1 capabilityCheck). It caches nothing: the caller keeps a checked
// answer for its cacheSeconds (runtime C-128).
export {
  CACHE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  LINQ_API_TOKEN,
  NOT_E164,
  NO_PHONE,
  createLinqCapabilityChecker,
  type LinqCapabilityChecker,
  type LinqCapabilityCheckerOptions,
  type LinqCapabilityEnv,
} from "./capability";
export type {
  CapabilityCheckChecked,
  CapabilityCheckFailed,
  CapabilityCheckOutcome,
  CapabilityCheckRequest,
  LinqService,
} from "./types";
export { CHECK_IMESSAGE_PATH, CHECK_RCS_PATH, LINQ_API_BASE, USER_AGENT } from "./wire";
