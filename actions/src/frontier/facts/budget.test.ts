// T-295's time proof: build the frontier within 150 ms (arch 04 line 215: "Build the frontier (uncached reads) ≤ 150
// ms"; K-09 v1 buildFrontier: "Time budget: at most 150 ms"). buildFrontier on the sample state, through the Tool API
// base on the fake repo (T-291's: it answers K-05 v1.2 readTurnState from seeded rows and holds every request and
// answer to K-05's frozen schema), 50 runs each, the median under 150 ms:
//   - build-frontier-s1-02.json on Sam's stored state, as the frontier ships (no fact home listed yet);
//   - the facts path whole: Sam's turn on Alex's request (fixtures/two-homes-one-key.json), its facts read strong and
//     its second value refused.
// The bound is the architecture's and is never loosened; a run slowed only by other builders loading the Mac is re-run
// alone once and both runs reported (DL-212).

import { describe, expect, it } from "vitest";

import { s102Exchange, type Called } from "../assemble/test-support";
import { callFrontier, callTwoHomes, responseOf, twoHomesFixture } from "./test-support";

const RUNS = 50;
const BUDGET_MS = 150;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.POSITIVE_INFINITY;
  const lower = sorted[middle - 1] ?? upper;
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

/** Each run's time in milliseconds, and each run's call. */
async function timed(run: () => Promise<Called>): Promise<{ ms: number[]; calls: Called[] }> {
  const ms: number[] = [];
  const calls: Called[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const start = performance.now();
    const called = await run();
    ms.push(performance.now() - start);
    calls.push(called);
  }
  return { ms, calls };
}

describe("buildFrontier within 150 ms on the sample state (median of 50 runs, fake repo)", () => {
  it("build-frontier-s1-02.json on Sam's stored state, as the frontier ships", async () => {
    const exchange = s102Exchange();
    const { ms, calls } = await timed(() => callFrontier(exchange.request));
    for (const called of calls) expect(responseOf(called).context.choices).toHaveLength(3);
    expect(ms).toHaveLength(RUNS);
    expect(median(ms)).toBeLessThan(BUDGET_MS);
  });

  it("with the facts read strong and a second value refused (two-homes-one-key.json)", async () => {
    const fixture = twoHomesFixture();
    const { ms, calls } = await timed(() => callTwoHomes(fixture));
    for (const called of calls) {
      const { context, flagged } = responseOf(called);
      expect(context.facts).toEqual(fixture.outcome.facts);
      expect(flagged).toEqual(fixture.outcome.flagged);
    }
    expect(ms).toHaveLength(RUNS);
    expect(median(ms)).toBeLessThan(BUDGET_MS);
  });

  it("the median is the middle run's time", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
