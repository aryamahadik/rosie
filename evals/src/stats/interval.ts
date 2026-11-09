// The Wilson score interval of right out of total (T-480, C-140; QUESTIONS.md CQ-10).
//
// Every accuracy number is reported as right out of total with its 95% interval (BP 8 "Eval gate"; arch 08 line 449),
// and every interval is the two-sided 95% Wilson score interval (CQ-10; K-10 v1 README "The interval"). It gives the
// examples the sources print: 83 right of 90 is 85–96% (arch 08 line 449); 157 of 160 is 94.6–99.4% (BP section 10's
// release card); 300 of 300 is 98.7–100% and 381 of 381 is the first n of n to clear 99% (BP 8).
//
// Bounds are proportions from 0 to 1, never rounded here (K-10 v1 README default 19): a report or a release card
// rounds them when it shows them.
import type { Interval } from "../../../contracts/generated/eval-set/eval-set.v1";

export type { Interval };

/** The 97.5th percentile of the standard normal distribution: the z of a two-sided 95% interval (CQ-10; K-10 v1). */
export const Z_TWO_SIDED_95 = 1.959963984540054;

/**
 * The 95th percentile of the standard normal distribution: the z of a one-sided 95% bound. A report gives the
 * two-sided interval only (K-10 v1 `interval.sides` "two"). This is for the one-sided figure BP 8 sets beside it
 * ("about 300 danger cases show 99% danger recall only if all 300 are found and the bound is one-sided"), which the
 * sizing table states beside the two-sided one for J-19 (T-477).
 */
export const Z_ONE_SIDED_95 = 1.6448536269514722;

/**
 * The Wilson score interval of `count` right out of `total`, with the normal quantile `z`: by default the two-sided
 * 95% interval (CQ-10). For c of n its bounds are (2c + z^2 -/+ z * sqrt(z^2 + 4c(n - c) / n)) / (2(n + z^2)). They
 * are exact at the edges, as K-10 v1's named rule requires: none right has the lower bound 0, and all right the upper
 * bound 1, where floating point would leave a trace either side.
 *
 * Throws a RangeError unless count and total are whole numbers with 0 <= count <= total and total >= 1 (with nothing
 * counted there is no interval: K-10 v1 writes it null), and z is a positive number.
 */
export function wilsonInterval(count: number, total: number, z: number = Z_TWO_SIDED_95): Interval {
  assertCounts(count, total);
  if (total === 0) {
    throw new RangeError(
      "there is no interval out of a total of 0: with nothing counted, K-10 v1 writes it null",
    );
  }
  if (!Number.isFinite(z) || z <= 0) throw new RangeError(`z must be a positive number, not ${String(z)}`);
  const z2 = z * z;
  const middle = 2 * count + z2;
  const spread = z * Math.sqrt(z2 + (4 * count * (total - count)) / total);
  const scale = 2 * (total + z2);
  return {
    lower: count === 0 ? 0 : (middle - spread) / scale,
    upper: count === total ? 1 : (middle + spread) / scale,
  };
}

/**
 * Throws a RangeError unless `count` and `total` are whole numbers with 0 <= count <= total: right out of total (BP 8
 * "Eval gate"; K-10 v1 rule 1, a count is at most its total). Shared with score.ts.
 */
export function assertCounts(count: number, total: number): void {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError(`a total must be a whole number from 0, not ${String(total)}`);
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > total) {
    throw new RangeError(
      `a count must be a whole number from 0 to its total of ${String(total)}, not ${String(count)}`,
    );
  }
}
