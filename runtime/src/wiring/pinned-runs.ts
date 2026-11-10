// The bundle each run of a turn pinned (T-557; T-249; arch 10 line 518: "bundle id pinned per turn"), kept for the
// frontier port (./real.ts realFrontier). The pin (runtime/src/bundle/pin.ts) reads the turn's manifest at its start, KV
// first and PostgreSQL's copy on a miss, and "the turn's work then reads the step graph ... through the pinned bundle":
// so the frontier reads its flow graphs through the same pinned bundle, each value once per run, under the pinned id.
//
// The turn hands each Tool API call the run's own trace (runtime/src/turn/turn.ts: `run.set.toolApi.buildFrontier(request,
// run.trace)`), the trace the pin opened for the run (LeasedTurn.trace). So the root's lease hooks keep each run's pinned
// bundle under that trace before the run starts, and the frontier port finds it by the trace it is handed. The memory is
// weak: a run's entry goes with its trace. A trace that is no pinned run's (a call from anywhere else) finds none. Nothing
// here logs.

import type { LeaseHooks } from "../actor/lease";
import type { PinnedBundle } from "../bundle/types";
import type { TraceContext } from "../trace";

export class PinnedRuns {
  private readonly runs = new WeakMap<TraceContext, PinnedBundle>();

  /** The lease's hooks with each run's pinned bundle kept under its trace before the run's work starts. */
  around(hooks: Required<LeaseHooks>): Required<LeaseHooks> {
    return {
      ...hooks,
      runTurn: (turn) => {
        this.runs.set(turn.trace, turn.bundle);
        return hooks.runTurn(turn);
      },
    };
  }

  /** The bundle the run whose trace this is pinned; null for a trace that is no pinned run's. */
  of(trace: TraceContext): PinnedBundle | null {
    return this.runs.get(trace) ?? null;
  }
}
