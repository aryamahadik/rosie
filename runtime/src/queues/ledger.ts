// This isolate's job ledger (T-256; C-056): which try of each job key has begun here and how it ended, so a message the
// queue delivers twice runs its job once (Cloudflare Queues deliver at least once). Keyed by the job key, as the job's
// event-log entries are (K-04 event_log.job_id).
//
// Within one isolate it is exact: JavaScript runs one call at a time, so `begin` is a compare-and-set. Across isolates a
// lasting ledger is needed (a K-05 call or a Durable Object; none is built yet: D-017 joins one through
// `QueueDeps.ledger`); until then a job's own writes, compared and set by K-05 under its job key, keep a second run from
// writing twice.

import type { FailedTry, JobLedger, LedgerBegin, LedgerSettle } from "./types";

/** How many job keys one isolate remembers; the one touched longest ago is forgotten first. */
export const JOB_MEMORY = 4096;

type State = "running" | "failed" | "waiting" | "done" | "dead";

interface Kept {
  tries: number;
  state: State;
  /** When the state was set (epoch milliseconds). */
  since: number;
  /** The failed try whose next step is not handed on yet (state failed only). */
  failed: FailedTry | null;
}

const isFinished = (state: State): boolean => state === "done" || state === "dead";

export class JobMemory implements JobLedger {
  private readonly kept = new Map<string, Kept>();

  constructor(private readonly limit: number = JOB_MEMORY) {}

  begin(jobKey: string, tryNo: number, at: number): Promise<LedgerBegin> {
    return Promise.resolve(this.beginNow(jobKey, tryNo, at));
  }

  settle(jobKey: string, tryNo: number, settled: LedgerSettle, at: number): Promise<void> {
    const kept = this.kept.get(jobKey);
    // A finished job stays finished, and an older try's end changes nothing once a later try has begun.
    if (kept === undefined || (!isFinished(kept.state) && kept.tries <= tryNo)) {
      this.keep(jobKey, {
        tries: tryNo,
        state: settled.state,
        since: at,
        failed: settled.state === "failed" ? { ...settled.failed } : null,
      });
    }
    return Promise.resolve();
  }

  private beginNow(jobKey: string, tryNo: number, at: number): LedgerBegin {
    const kept = this.kept.get(jobKey);
    if (kept !== undefined) {
      if (isFinished(kept.state)) return { go: false, why: "finished" };
      if (kept.tries > tryNo) return { go: false, why: "seen" };
      if (kept.tries === tryNo) {
        if (kept.state === "running") return { go: false, why: "running", since: kept.since };
        if (kept.state === "failed" && kept.failed !== null) {
          return { go: false, why: "handOff", failed: { ...kept.failed } };
        }
        return { go: false, why: "seen" };
      }
    }
    this.keep(jobKey, { tries: tryNo, state: "running", since: at, failed: null });
    return { go: true };
  }

  private keep(jobKey: string, kept: Kept): void {
    this.kept.delete(jobKey);
    this.kept.set(jobKey, kept);
    while (this.kept.size > this.limit) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
  }
}

/** This isolate's ledger (a Worker isolate handles many batches in turn). */
export const isolateJobs = new JobMemory();
