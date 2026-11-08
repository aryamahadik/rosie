// The effects runner's clock (T-323): the time now and a wait, given to the runner so the tests run a run's 10 minutes
// on a fake clock (test-support.ts). The system clock reads Date.now and waits with setTimeout, which the Worker and Node
// both give; a wait ends early when its signal aborts, and never rejects.

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

/** Date.now and setTimeout. */
export function systemClock(): RunnerClock {
  return {
    now: () => Date.now(),
    sleepUntil: (at, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        const timer = setTimeout(
          () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          Math.max(0, at - Date.now()),
        );
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  };
}
