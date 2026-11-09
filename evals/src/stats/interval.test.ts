// Tests of the Wilson score interval (T-480, C-140; QUESTIONS.md CQ-10). Each expected value is a figure a source
// prints, written as it prints it, and each bound is compared at the rounding it prints: whole percents for arch 08
// line 449's example, one decimal for BP section 10's release card and BP 8's. The library itself never rounds (K-10
// v1 README default 19), so only these tests do.

import { describe, expect, it } from "vitest";

import { Z_ONE_SIDED_95, Z_TWO_SIDED_95, wilsonInterval } from "./interval";

/** A proportion in percent with `decimals` places, as a source prints it: 0.848 at 0 places is "85". */
const percent = (proportion: number, decimals: number): string => (proportion * 100).toFixed(decimals);

describe("wilsonInterval: the two-sided 95% Wilson score interval (CQ-10)", () => {
  it("uses z = 1.959963984540054, the 97.5th percentile of the standard normal (K-10 v1 README 'The interval')", () => {
    expect(Z_TWO_SIDED_95).toBe(1.959963984540054);
  });

  it("gives 83 right out of 90 a 95% interval of 85–96% (arch 08 line 449)", () => {
    const { lower, upper } = wilsonInterval(83, 90);
    expect(percent(lower, 0)).toBe("85");
    expect(percent(upper, 0)).toBe("96");
  });

  it("gives 157 of 160 a 95% interval of 94.6–99.4% (BP section 10's release card)", () => {
    const { lower, upper } = wilsonInterval(157, 160);
    expect(percent(lower, 1)).toBe("94.6");
    expect(percent(upper, 1)).toBe("99.4");
  });

  it("gives 300 of 300 a two-sided 95% interval of 98.7–100% (BP 8 'Eval gate')", () => {
    const { lower, upper } = wilsonInterval(300, 300);
    expect(percent(lower, 1)).toBe("98.7");
    expect(upper).toBe(1);
  });

  it("makes 381 of 381 the first n of n whose lower bound clears 99%, and 380 of 380 does not (BP 8 'Eval gate')", () => {
    expect(wilsonInterval(380, 380).lower).toBeLessThan(0.99);
    expect(wilsonInterval(381, 381).lower).toBeGreaterThanOrEqual(0.99);
    const volumes = Array.from({ length: 1000 }, (_, k) => k + 1);
    expect(volumes.find((n) => wilsonInterval(n, n).lower >= 0.99)).toBe(381);
  });

  it("is exact at the edges: none right has the lower bound 0, all right the upper bound 1 (K-10 v1 rule 2)", () => {
    for (const total of [1, 9, 90, 160, 300, 380, 381, 500]) {
      expect(wilsonInterval(0, total).lower).toBe(0);
      expect(wilsonInterval(total, total).upper).toBe(1);
    }
  });
});

describe("wilsonInterval with another z", () => {
  it("gives a one-sided 95% bound with z = 1.6448536269514722: 300 of 300 shows 99% only one-sided, and only with all 300 found (BP 8)", () => {
    expect(Z_ONE_SIDED_95).toBe(1.6448536269514722);
    expect(wilsonInterval(300, 300).lower).toBeLessThan(0.99);
    expect(wilsonInterval(300, 300, Z_ONE_SIDED_95).lower).toBeGreaterThanOrEqual(0.99);
    expect(wilsonInterval(299, 300, Z_ONE_SIDED_95).lower).toBeLessThan(0.99);
  });
});

describe("wilsonInterval refuses", () => {
  it("a total of 0: with nothing counted there is no interval (K-10 v1 writes it null)", () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
  });

  it("counts that are not whole numbers with 0 <= count <= total", () => {
    const refused: [number, number][] = [
      [91, 90],
      [-1, 90],
      [1.5, 90],
      [83, 90.5],
      [Number.NaN, 90],
      [83, Number.POSITIVE_INFINITY],
      [0, -1],
    ];
    for (const [count, total] of refused) expect(() => wilsonInterval(count, total)).toThrow(RangeError);
  });

  it("a z that is not a positive number", () => {
    for (const z of [0, -1.959963984540054, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wilsonInterval(83, 90, z)).toThrow(RangeError);
    }
  });
});
