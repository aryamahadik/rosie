// When a run's tries go (schedule.ts) and the clock they are read on (clock.ts), T-323: 5 tries, every 2 minutes from the
// run's first try, sooner on a shorter Retry-After, all inside K-07 v1's 10 minutes; the claim's budget for a port call.

import { describe, expect, it } from "vitest";

import { epochOf, systemClock, utc } from "./clock";
import {
  CLAIM_MS,
  EFFECT_TRIES,
  EFFECT_WINDOW_MS,
  PORT_CALL_BUDGET_MS,
  TRY_SPACING_MS,
  claimLeavesBudget,
  nextTryAt,
} from "./schedule";
import { k07Rules } from "./test-support";

const FIRST = Date.parse("2026-11-07T15:06:33Z");
const MINUTE = 60_000;

describe("the tries of one run", () => {
  it("are K-07 v1's 5 tries in 10 minutes", async () => {
    const rules = await k07Rules();
    expect(EFFECT_TRIES).toBe(rules.EFFECT_TRIES);
    expect(EFFECT_WINDOW_MS).toBe(rules.EFFECT_WINDOW_MS);
    expect((EFFECT_TRIES - 1) * TRY_SPACING_MS).toBeLessThanOrEqual(EFFECT_WINDOW_MS);
  });

  it("go at 0, 2, 4, 6 and 8 minutes from the run's first try, and none after the 5th", () => {
    expect(
      [1, 2, 3, 4].map((tries) => nextTryAt(FIRST, tries, FIRST + tries * 2 * MINUTE - MINUTE, null)),
    ).toEqual([2, 4, 6, 8].map((minutes) => FIRST + minutes * MINUTE));
    expect(nextTryAt(FIRST, 5, FIRST + 8 * MINUTE, null)).toBeNull();
    expect(nextTryAt(FIRST, 6, FIRST + 9 * MINUTE, 1_000)).toBeNull();
  });

  it("go sooner on a provider's shorter Retry-After, never later than the slot, and at once when the slot has passed", () => {
    const at = FIRST + 1_000;
    expect(nextTryAt(FIRST, 1, at, 20_000)).toBe(at + 20_000);
    expect(nextTryAt(FIRST, 1, at, 5 * MINUTE)).toBe(FIRST + 2 * MINUTE);
    expect(nextTryAt(FIRST, 1, at, 0)).toBe(at);
    const late = FIRST + 3 * MINUTE;
    expect(nextTryAt(FIRST, 1, late, null)).toBe(late);
    expect(nextTryAt(FIRST, 2, late, null)).toBe(FIRST + 4 * MINUTE);
  });

  it("ignore a Retry-After that is not a time from 0", () => {
    for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextTryAt(FIRST, 1, FIRST, odd)).toBe(FIRST + 2 * MINUTE);
    }
  });

  it("start a port call only while the claim leaves it its whole budget", () => {
    expect(PORT_CALL_BUDGET_MS).toBeLessThan(CLAIM_MS);
    const lapsesAt = FIRST + CLAIM_MS;
    expect(claimLeavesBudget(FIRST, lapsesAt)).toBe(true);
    expect(claimLeavesBudget(lapsesAt - PORT_CALL_BUDGET_MS, lapsesAt)).toBe(true);
    expect(claimLeavesBudget(lapsesAt - PORT_CALL_BUDGET_MS + 1, lapsesAt)).toBe(false);
  });
});

describe("the runner's clock", () => {
  it("writes instants as the contracts do, whole seconds with no fraction", () => {
    expect(utc(FIRST)).toBe("2026-11-07T15:06:33Z");
    expect(utc(FIRST + 500)).toBe("2026-11-07T15:06:33.500Z");
    expect(epochOf("2026-11-07T15:06:33Z")).toBe(FIRST);
    expect(() => epochOf("soon")).toThrow(RangeError);
  });

  it("waits until an instant, at once for one passed, and stops waiting when its signal aborts", async () => {
    const clock = systemClock();
    const before = clock.now();
    await clock.sleepUntil(before - 1_000);
    await clock.sleepUntil(before + 5);
    expect(clock.now()).toBeGreaterThanOrEqual(before + 5);

    const stop = new AbortController();
    const waiting = clock.sleepUntil(clock.now() + 60 * MINUTE, stop.signal);
    stop.abort();
    await waiting;
    const aborted = new AbortController();
    aborted.abort();
    await clock.sleepUntil(clock.now() + 60 * MINUTE, aborted.signal);
    expect(clock.now() - before).toBeLessThan(MINUTE);
  });
});
