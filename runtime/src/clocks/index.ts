// Clock rows (T-254; C-054, C-035): each actor's one alarm at its earliest row (actor-clocks.ts), the minute sweep
// (sweep.ts), staging's Fire now (fire-now.ts), and the one fire path every firing goes through (fire.ts). D-017 joins
// the ports: `setClockDeps({ data, gate, registry, directory })`.
//
// Clock arming and the due rule (T-255; C-055): step 9's due rule (due.ts, on zone.ts's wall-clock arithmetic) and the
// arming at a question's first delivery receipt (arming.ts), which the receipt path calls as its ClockArming
// (`clockArming({ data, facts, geo, directory, actors, log, trace })`); D-017 joins it.

export {
  ActorClocks,
  CLOCK_RETRY_MS,
  HANDLE_LIMIT,
  SCHEDULE_CLOCK,
  type ActorClocksHost,
} from "./actor-clocks";
export { actorOf, clockActorsOf } from "./actors";
export {
  ARMING_TRIES,
  armAtDelivery,
  ArmingMemory,
  clockArming,
  isolateArmings,
  PART_MEMORY,
  type ArmingOptions,
  type ClockArmingPort,
  type DeliveredPart,
} from "./arming";
export {
  clockLineMs,
  DAY_AFTER_HOUR,
  DAY_BEFORE_HOUR,
  DELIVERY_FLOOR_MS,
  DueError,
  dueOf,
  isDeliveryReceipt,
  neverDeliveredDueOf,
  SAME_DAY_LEAD_MS,
  zoneFor,
  type Due,
  type DueBranch,
  type DueInput,
  type NeverDeliveredBranch,
  type NeverDeliveredDue,
  type NeverDeliveredInput,
  type ZoneFrom,
  type ZoneInput,
} from "./due";
export { fireNow, type FireNowOptions } from "./fire-now";
export { clockDeps, fireOnce, isDueClock, jobIdOf, setClockDeps, utcOf, type FireHost } from "./fire";
export { sweepClocks, SWEEP_LIMIT, SWEEP_MISSED_MS, type SweepOptions, type SweepReport } from "./sweep";
export * from "./types";
