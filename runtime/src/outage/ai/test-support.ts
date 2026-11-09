// Doubles for the AI-down path's tests (T-271). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - `fakeLines` is the shared core's K-09 v1 `sendFixedLine`, kept in memory: one row per request id (a repeat answers
//     `repeated` with the first row, "Safe: once per text"), `phoneStopped` for a stopped number with nothing written,
//     and `transient` or no answer when a test says so;
//   - `outageHarness` sets them with a clock that moves only when a test says so (the safety read's fake clock), the
//     handle's stopped flag and the dispatcher's wake.
// Test values only: the master's sample cast and the fixtures' ids (rule 9).

import type { CoreError, SendFixedLineRequest, SendFixedLineResponse } from "../../safety/types";
import { fakeClock, type FakeClock } from "../../safety/test-support";
import type { OutageDeps, OutageWake } from "./types";

export interface FakeLines {
  /** Every sendFixedLine request, with the clock time it came at, in order. */
  readonly requests: { at: number; request: SendFixedLineRequest }[];
  /** The rows written, by request id: one per request id. */
  readonly rows: Map<string, string>;
  /** The recipient handles whose number is stopped: their lines are refused (`phoneStopped`), nothing written. */
  readonly stopped: Set<string>;
  /** While true every call throws, as a core that is not answering. */
  down: boolean;
  /** How many of the next calls answer `transient` (nothing written). */
  transient: number;
  sendFixedLine(request: SendFixedLineRequest): Promise<SendFixedLineResponse | CoreError>;
}

export function fakeLines(clock: FakeClock): FakeLines {
  const lines: FakeLines = {
    requests: [],
    rows: new Map(),
    stopped: new Set(),
    down: false,
    transient: 0,
    sendFixedLine(request) {
      lines.requests.push({ at: clock.now(), request: structuredClone(request) });
      if (lines.down) return Promise.reject(new Error("the core is not answering"));
      if (lines.transient > 0) {
        lines.transient -= 1;
        return Promise.resolve({ error: "transient" });
      }
      if (lines.stopped.has(request.recipientHandleId)) {
        return Promise.resolve({
          error: "phoneStopped",
          recipientHandleId: request.recipientHandleId,
        } as CoreError);
      }
      const key = request.caller.requestId;
      const known = lines.rows.get(key);
      if (known !== undefined) return Promise.resolve({ outboxRowId: known, repeated: true });
      const row = `out-${key.replace(/[^a-z0-9-]/giu, "-")}-${request.fixedLineId}`;
      lines.rows.set(key, row);
      return Promise.resolve({ outboxRowId: row, repeated: false });
    },
  };
  return lines;
}

export interface OutageHarness {
  readonly clock: FakeClock;
  readonly lines: FakeLines;
  /** The handle's stopped flag, as the actor keeps it. */
  readonly stopped: { value: boolean };
  /** The actor names the stopped flag was read for, in order. */
  readonly stoppedReads: string[];
  /** Each wake of the dispatcher, in order. */
  readonly wakes: OutageWake[];
  /** Each wait the path began on the clock: when, and for how long (a test moves the clock only once a wait has begun). */
  readonly waits: { at: number; ms: number }[];
  readonly deps: OutageDeps;
}

/** The AI-down path's doubles for one test, on their own fake clock (or the one given: the actor's, in an actor test). */
export function outageHarness(clock: FakeClock = fakeClock()): OutageHarness {
  const lines = fakeLines(clock);
  const stopped = { value: false };
  const stoppedReads: string[] = [];
  const wakes: OutageWake[] = [];
  const waits: { at: number; ms: number }[] = [];
  return {
    clock,
    lines,
    stopped,
    stoppedReads,
    wakes,
    waits,
    deps: {
      clock: {
        now: () => clock.now(),
        after: (ms) => {
          waits.push({ at: clock.now(), ms });
          return clock.after(ms);
        },
      },
      lines,
      isStopped: (actorName) => {
        stoppedReads.push(actorName);
        return stopped.value;
      },
      wake: (request) => {
        wakes.push(structuredClone(request));
        return Promise.resolve();
      },
    },
  };
}
