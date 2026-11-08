// Instants as the clock home reads and writes them (T-591): K-05's UTC instants to the whole second, ending in Z (CQ-09),
// the form the due rule (../due.ts) and armClock (arm-clock.json) use. A malformed one is a DueError, as in the due rule.

import { DueError } from "../due";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** An instant given as text (any form Date.parse reads, offsets included), in epoch milliseconds; else DueError. */
export function instantOf(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new DueError(`${what} is not an instant`);
  return ms;
}

/** An instant as K-05 writes it: UTC to the whole second, ending in Z. */
export function utcOf(ms: number): string {
  return new Date(floorSecond(ms)).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** The whole second at or after the instant: "at least", never a part-second short. */
export const ceilSecond = (ms: number): number => Math.ceil(ms / SECOND) * SECOND;

/** The whole second at or before the instant: a visit's start, or an arrival estimate, is never passed. */
export const floorSecond = (ms: number): number => Math.floor(ms / SECOND) * SECOND;
