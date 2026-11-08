// The gate's check of the record flags (T-317; C-078), before limits 1 to 6: a paused person's booking work and a
// deceased booking's new charge wait for the owner. Registered in actions/src/gate/limits.ts. See flags.ts.

export {
  ASKED_DECIDER,
  decideFlags,
  flagsDatabaseOf,
  flagsFirst,
  gateFlagReadsOf,
  type BookingFlags,
  type FlagDecision,
  type FlagsFirstLimit,
  type FlagsFirstRegistry,
  type GateFlag,
  type GateFlagReads,
  type GateFlagsDeps,
  type PauseRef,
} from "./flags";
