// One section 08 measure scored as K-10 v1's measureResult holds it (T-480, C-140): right out of total, the point
// estimate, its two-sided 95% Wilson interval (interval.ts) and its status against the target's direction and the
// bar's sized volume. The status follows BP 8 "Eval gate" and K-10 v1's README "Status":
//
//   miss          the point estimate misses its target, at any volume (rule 7.10): below an atLeast target, or above
//                 an atMost one. So any one harmful wrong action (at most 0.2% of turns) over fewer than 500 turns is
//                 a miss, since 1 of 499 is above 0.2% (BP 8: "with fewer than 500 turns, that means none").
//   met           only at or past the bar's sized volume (J-19), with the bound facing the target clearing it: the
//                 lower bound at or above an atLeast target, the upper bound at or under an atMost one (BP 8's sizing
//                 rule).
//   notYetProven  otherwise, and never met: below the sized volume, with none sized (null until J-19 sizes the bar:
//                 Q-16), at or past it while the bound does not yet clear the target, or with nothing counted.
//
// Each comparison allows 1e-9 for floating-point rounding, as K-10 v1's named rule reportNumbers does
// (contracts/eval-set/eval-set.rules.mjs), so the status given here is the one that rule requires of a report.
import type { MeasureResult } from "../../../contracts/generated/eval-set/eval-set.v1";
import { assertCounts, wilsonInterval, type Interval } from "./interval";

export type { MeasureResult };

/** atLeast: the point estimate must reach the target; atMost: it must stay at or under it (K-10 v1). */
export type Direction = MeasureResult["direction"];

/** K-10 v1's status words: met, notYetProven (written "not yet proven") and miss. */
export type Status = MeasureResult["status"];

/** What a measure is scored from: right out of total, against its target and its bar's sized volume (K-10 v1). */
export interface MeasureInput {
  /** atLeast or atMost, fixed by the measure (arch 08's table). */
  direction: Direction;
  /** The target as a proportion from 0 to 1, such as 0.97 for 97% (arch 08 lines 427 to 445). */
  target: number;
  /** The right ones for an atLeast measure, the failures for an atMost one (K-10 v1 "How each measure is counted"). */
  count: number;
  /** Out of how many units: turns, texts, chats or messages, as the measure counts them. */
  total: number;
  /** The total at which the bar is proven, as J-19 sizes it; null until it does (Q-16). */
  sizedVolume: number | null;
}

/** How far a proportion may sit past a target and still reach it: rounding only (K-10 v1 eval-set.rules.mjs). */
const ROUNDING = 1e-9;

const DIRECTIONS: ReadonlySet<string> = new Set<Direction>(["atLeast", "atMost"]);

/**
 * The measure scored: its inputs as given, the point estimate count / total and its two-sided 95% Wilson interval,
 * both unrounded and both null with nothing counted, and its status (the top of this file).
 *
 * Throws a RangeError on a direction other than K-10 v1's two, a target outside 0 to 1, counts that are not whole
 * numbers with 0 <= count <= total, or a sized volume that is neither null nor a whole number from 1 (K-10 v1
 * measureResult).
 */
export function score(input: MeasureInput): MeasureResult {
  assertMeasure(input);
  const { direction, target, count, total, sizedVolume } = input;
  if (total === 0) {
    return {
      direction,
      target,
      count,
      total,
      point: null,
      interval: null,
      sizedVolume,
      status: "notYetProven",
    };
  }
  const point = count / total;
  const interval = wilsonInterval(count, total);
  return {
    direction,
    target,
    count,
    total,
    point,
    interval,
    sizedVolume,
    status: statusFrom(input, point, interval),
  };
}

/** The measure's status alone: met, notYetProven or miss (the top of this file). Throws as score() does. */
export function statusOf(input: MeasureInput): Status {
  return score(input).status;
}

function statusFrom(input: MeasureInput, point: number, interval: Interval): Status {
  const { direction, target, total, sizedVolume } = input;
  const misses = direction === "atLeast" ? point < target - ROUNDING : point > target + ROUNDING;
  if (misses) return "miss";
  const clears =
    direction === "atLeast" ? interval.lower >= target - ROUNDING : interval.upper <= target + ROUNDING;
  return sizedVolume !== null && total >= sizedVolume && clears ? "met" : "notYetProven";
}

function assertMeasure({ direction, target, count, total, sizedVolume }: MeasureInput): void {
  if (!DIRECTIONS.has(direction)) {
    throw new RangeError(`a direction must be atLeast or atMost, not ${JSON.stringify(direction)}`);
  }
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new RangeError(`a target must be a proportion from 0 to 1, not ${String(target)}`);
  }
  assertCounts(count, total);
  if (sizedVolume !== null && (!Number.isSafeInteger(sizedVolume) || sizedVolume < 1)) {
    throw new RangeError(`a sized volume must be null or a whole number from 1, not ${String(sizedVolume)}`);
  }
}
