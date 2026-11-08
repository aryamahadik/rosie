// The minute sweep (T-254; C-054; arch 10 line 540: "a cron sweep each minute fires missed rows and rows no handle owns,
// such as monthly billing"). The Worker's scheduled handler (runtime/src/index.ts) runs it on T-278's one-minute cron
// (wrangler.jsonc triggers; NQ-RT-5: the trigger binding is the release engineer's).
//
// Each run reads K-05 v1 dueClocks for: sweep (armed rows no handle owns due by now, and handle rows due before
// `missedBefore`, the rows an actor missed: due-for-sweep.json), with `missedBefore` one minute before now (K-05 open gap
// 4 leaves the margin to the runtime; one sweep's period, as due-for-sweep.json has it). Then:
//
//   - a row no handle owns fires here, as a sweep job with no turn, through the one fire path (./fire.ts);
//   - a row a handle owns goes to that handle's actor (`fireClockRow`, by sweep), which fires it through the same path
//     as its alarm, under its own holds, and sets its alarm again from what is left. When no actor can be named for it
//     (no namespace bound, the directory does not know the handle), it is left armed for the next sweep and the
//     actor's own alarm (fails closed: a clock turn never runs without its handle's holds).
//
// A row the alarm fires while the sweep hands it on fires once: the actor's in-flight guard and K-05's compare-and-set
// (a repeat answers `repeated`). One JSON log line per run, with its own trace id (each firing has its own trace too):
// counts and labels only.

import type { LogContext } from "../trace";
import { actorOf } from "./actors";
import { clockDeps, codeOf, dueReadOf, fireOnce, jobFirings, utcOf, type FireHost } from "./fire";
import type { ClockActors, FireReport } from "./types";

/** A handle row due this long before now counts as missed (one sweep's period; due-for-sweep.json). */
export const SWEEP_MISSED_MS = 60_000;
/** How many due rows one run takes (due-for-sweep.json's limit); the rest wait for the next minute. */
export const SWEEP_LIMIT = 100;

export interface SweepOptions {
  /** The cron's time, in epoch milliseconds: the sweep's now. */
  scheduledTime: number;
  /** The HandleActor namespace, or null where none is bound. */
  actors: ClockActors | null;
  log: LogContext;
  /** True on staging (the firing's Fire now check; the sweep itself never fires by fireNow). */
  staging: boolean;
  /** Epoch milliseconds, for the spans' timing; Date.now in the Worker. */
  clock?: () => number;
}

export interface SweepReport {
  /** The run's own trace id (one JSON log line). */
  traceId: string;
  outcome: "ok" | "unwired" | "failed";
  rows: number;
  /** Firings that came back fired (a repeat included). */
  fired: number;
  /** Rows handed to their handle's actor. */
  handed: number;
  /** Rows left for the next sweep: no actor could be named for them. */
  skipped: number;
  /** Rows whose actor did not answer. */
  failed: number;
  errorCode: string | null;
  reports: FireReport[];
}

/** One minute's sweep. Never throws. */
export async function sweepClocks(options: SweepOptions): Promise<SweepReport> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const now = options.scheduledTime;
  const host: FireHost = {
    now: () => now + Math.max(0, clock() - startedAt),
    // A row no handle owns has no actor, so no holds and no unread texts.
    context: () => ({ holds: [], unread: [] }),
    logContext: () => options.log,
    staging: () => options.staging,
  };
  const result: SweepReport = {
    traceId: crypto.randomUUID(),
    outcome: "ok",
    rows: 0,
    fired: 0,
    handed: 0,
    skipped: 0,
    failed: 0,
    errorCode: null,
    reports: [],
  };
  const done = (): SweepReport => {
    result.fired = result.reports.filter((report) => report.outcome === "fired").length;
    try {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "clockSweep",
          trace_id: result.traceId,
          job_id: `sweep-${utcOf(now)}`,
          outcome: result.outcome,
          rows: result.rows,
          fired: result.fired,
          handed: result.handed,
          skipped: result.skipped,
          failed: result.failed,
          error_code: result.errorCode,
          environment: options.log.environment,
          version: options.log.version,
        }),
      );
    } catch {
      // No line; the report says it.
    }
    return result;
  };

  const set = clockDeps();
  if (set === null) {
    result.outcome = "unwired";
    result.errorCode = "unwired";
    return done();
  }
  let answer: unknown;
  try {
    answer = await set.data.dueClocks({
      for: "sweep",
      now: utcOf(now),
      missedBefore: utcOf(now - SWEEP_MISSED_MS),
      limit: SWEEP_LIMIT,
    });
  } catch {
    answer = { error: "noAnswer" };
  }
  const read = dueReadOf(answer);
  if (read === null) {
    result.outcome = "failed";
    result.errorCode = codeOf(answer);
    return done();
  }
  result.rows = read.rows.length;
  for (const row of read.rows) {
    const handleId = row.handleId;
    if (handleId === null) {
      result.reports.push(await jobFirings.run(row.clockRowId, () => fireOnce(row, "sweep", host)));
      continue;
    }
    const actor = await actorOf(set, options.actors, handleId);
    if (actor === null) {
      result.skipped += 1;
      continue;
    }
    try {
      result.reports.push(await actor.fireClockRow({ row, by: "sweep" }));
      result.handed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return done();
}
