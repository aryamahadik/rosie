// Clock rows (T-254; C-054, C-035): each actor's one alarm at its earliest row (actor-clocks.ts), the minute sweep
// (sweep.ts), staging's Fire now (fire-now.ts), and the one fire path every firing goes through (fire.ts). D-017 joins
// the ports: `setClockDeps({ data, gate, registry, directory })`.

export {
  ActorClocks,
  CLOCK_RETRY_MS,
  HANDLE_LIMIT,
  SCHEDULE_CLOCK,
  type ActorClocksHost,
} from "./actor-clocks";
export { actorOf, clockActorsOf } from "./actors";
export { fireNow, type FireNowOptions } from "./fire-now";
export { clockDeps, fireOnce, isDueClock, jobIdOf, setClockDeps, utcOf, type FireHost } from "./fire";
export { sweepClocks, SWEEP_LIMIT, SWEEP_MISSED_MS, type SweepOptions, type SweepReport } from "./sweep";
export * from "./types";
