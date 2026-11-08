// Staging's Fire now (T-254; BP 9.4 'A fake clock': the team console's "Fire now" on any test handle's clock row,
// "Never in production"). The button is the frontend engineer's (C-203, through K-21); this is the entry point it
// reaches. It fires the row by `fireNow` through the very path the alarm takes: a row a handle owns goes to that
// handle's actor, whose `fireClockRow` runs the same in-flight guard and the same `fireOnce` as its alarm; a row no handle
// owns runs `fireOnce` as a job, as the sweep's rows do. K-05 v1 fireClock lets `fireNow` fire before the due time
// (staging only; K-21 allows it on staging alone), so this entry refuses anywhere but staging before it reads or sends
// anything, and `fireOnce` checks it again.

import type { LogContext } from "../trace";
import { actorOf } from "./actors";
import { clockDeps, fireOnce, isDueClock, jobFirings, type FireHost } from "./fire";
import type { ClockActors, DueClock, FireReport } from "./types";

export interface FireNowOptions {
  /** The row as the console lists it (K-05 v1 dueClock): its version is the one compared. */
  row: DueClock;
  /** The HandleActor namespace, or null where none is bound. */
  actors: ClockActors | null;
  /** The Worker's ENVIRONMENT: only "staging" fires. */
  environment: string;
  log: LogContext;
  /** Epoch milliseconds; Date.now in the Worker. */
  now?: () => number;
}

/** Fires one row now, on staging only, through the alarm's own path. Never throws. */
export async function fireNow(options: FireNowOptions): Promise<FireReport> {
  const { row } = options;
  const report = (outcome: "refused" | "failed", errorCode: string): FireReport => ({
    clockRowId: isDueClock(row) ? row.clockRowId : "",
    by: "fireNow",
    outcome,
    repeated: false,
    turnId: null,
    traceId: null,
    errorCode,
  });
  if (options.environment !== "staging") return report("refused", "notStaging");
  if (!isDueClock(row)) return report("refused", "badRow");
  const set = clockDeps();
  if (set === null) return report("failed", "unwired");
  const handleId = row.handleId;
  if (handleId === null) {
    const host: FireHost = {
      now: options.now ?? Date.now,
      context: () => ({ holds: [], unread: [] }),
      logContext: () => options.log,
      staging: () => options.environment === "staging",
    };
    return jobFirings.run(row.clockRowId, () => fireOnce(row, "fireNow", host));
  }
  const actor = await actorOf(set, options.actors, handleId);
  if (actor === null) return report("refused", "noActor");
  try {
    return await actor.fireClockRow({ row, by: "fireNow" });
  } catch {
    return report("failed", "noAnswer");
  }
}
