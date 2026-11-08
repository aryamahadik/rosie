// The effects runner's clock (T-323): the time now and a wait, given to the runner so the tests run a run's 10 minutes
// on a fake clock (test-support.ts). The system clock reads Date.now and waits with setTimeout, which the Worker and Node
// both give; a wait ends early when its signal aborts, and never rejects.
//
// A timer can fire before its instant by Date.now (DL-195: 1 ms early, under load), so each time the system clock's timer
// fires it reads the time again and, until the instant has come, waits once more for the time left (T-1112): a wait never
// ends before its instant. Its timer and its time are ports, so a test can give a timer that fires early.

import type { RunnerClock } from "./types";

/** An instant as the contracts write it (common formats `utc`): RFC 3339 in UTC, whole seconds without a fraction. */
export function utc(epochMs: number): string {
  const text = new Date(epochMs).toISOString();
  return text.endsWith(".000Z") ? `${text.slice(0, -5)}Z` : text;
}

/** Epoch milliseconds of a contract instant; throws on one that is not a date, since every instant here is code's. */
export function epochOf(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError("not an instant in UTC");
  return ms;
}

/** A one-shot timer. */
export interface ClockTimer<Handle = unknown> {
  /** Calls `wake` once, about `ms` milliseconds on by the runtime's own reckoning (it can fire early by Date.now). */
  set(wake: () => void, ms: number): Handle;
  /** Stops a timer that has not fired. */
  clear(handle: Handle): void;
}

/** What the system clock runs on, each the runtime's own when left out. */
export interface ClockPorts {
  /** Default: setTimeout and clearTimeout. */
  readonly timer?: ClockTimer;
  /** Epoch milliseconds; default: Date.now. */
  readonly now?: () => number;
}

/** The longest delay one setTimeout keeps (2^31 - 1 ms, about 24.8 days): Node fires a longer one after 1 ms. */
const LONGEST_DELAY_MS = 2_147_483_647;

const setRuntimeTimer = (wake: () => void, ms: number) => setTimeout(wake, ms);

/** setTimeout and clearTimeout, which the Worker and Node both give. */
const RUNTIME_TIMER: ClockTimer<ReturnType<typeof setRuntimeTimer>> = {
  set: setRuntimeTimer,
  clear: (handle) => {
    clearTimeout(handle);
  },
};

/** The delay to set for a wait of `ms`: 0 once passed, and at most the longest, so a longer wait goes in parts. */
const delayFor = (ms: number): number => Math.min(Math.max(0, ms), LONGEST_DELAY_MS);

/** Date.now and setTimeout, or the ports given in their place. */
export function systemClock(ports: ClockPorts = {}): RunnerClock {
  const now = ports.now ?? ((): number => Date.now());
  const timer: ClockTimer = ports.timer ?? RUNTIME_TIMER;
  return {
    now,
    sleepUntil: (at, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        // The one timer pending: the first one, then each one set for the time left.
        let pending: unknown;
        const onAbort = (): void => {
          timer.clear(pending);
          resolve();
        };
        const wake = (): void => {
          const left = at - now();
          if (left > 0) {
            pending = timer.set(wake, delayFor(left));
            return;
          }
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        pending = timer.set(wake, delayFor(at - now()));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  };
}
