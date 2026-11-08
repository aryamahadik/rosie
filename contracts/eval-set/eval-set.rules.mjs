// K-10's named rule (T-019): the arithmetic of an accuracy report, which one JSON Schema cannot state.
// `npm run contracts:check` runs the rule a fixtures/index.json entry names ("rule") on a fixture of
// $defs/accuracyReport that has already passed the schema (contracts/scripts/check-fixtures.mjs). The eval harness
// (C-140) computes the same numbers and the deploy gate (C-041) reads them; this file states them in the contract and
// is not their implementation. README "The named rule reportNumbers".
//
// A rule takes a report and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes this one.

/** The two-sided 95% normal quantile, the 97.5th percentile of the standard normal distribution (CQ-10). */
export const Z95 = 1.959963984540054;

/** How far a stored proportion may sit from the one computed here: JSON keeps a double exactly, so only rounding. */
const EPSILON = 1e-9;

/**
 * The two-sided 95% Wilson score interval of count out of total (CQ-10's default). It gives every example the sources
 * print: 83 of 90 is 85-96% (arch 08 line 449); 300 of 300 is 98.7-100% and 381 of 381 the first to clear 99% (BP 8);
 * 157 of 160 is 94.6-99.4% (BP section 10's release card). At the edges the bound is exact: 0 out of any total has
 * the lower bound 0, and all of them the upper bound 1, where floating point would leave a trace either side.
 * @param {number} count
 * @param {number} total  at least 1
 * @returns {{ lower: number, upper: number }}
 */
export function wilson(count, total, z = Z95) {
  const p = count / total;
  const z2 = z * z;
  const scale = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / scale;
  const half = (z / scale) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    lower: count === 0 ? 0 : Math.max(0, centre - half),
    upper: count === total ? 1 : Math.min(1, centre + half),
  };
}

/**
 * The status a measure must carry (BP 8 "Eval gate"; Q-16 and J-19): miss when the point estimate misses its target,
 * at any volume (rule 7.10); met only at or past a sized volume with the bound facing the target clearing it (the
 * lower bound for atLeast, the upper for atMost: BP 8's sizing rule); otherwise notYetProven, below the volume, with
 * none sized, or with nothing counted.
 */
export function statusOf({ direction, target, count, total, sizedVolume }) {
  if (total === 0) return "notYetProven";
  const point = count / total;
  const misses = direction === "atLeast" ? point < target - EPSILON : point > target + EPSILON;
  if (misses) return "miss";
  const { lower, upper } = wilson(count, total);
  const clears = direction === "atLeast" ? lower >= target - EPSILON : upper <= target + EPSILON;
  return sizedVolume !== null && total >= sizedVolume && clears ? "met" : "notYetProven";
}

const close = (stored, computed) => Math.abs(stored - computed) <= EPSILON;

/** The problems of one measure result at `where`. */
function measureProblems(where, result) {
  const problems = [];
  const { count, total } = result;
  if (count > total) {
    problems.push(`${where}: counts ${String(count)} out of ${String(total)}, more than its total`);
    return problems;
  }
  if (total > 0) {
    const point = count / total;
    if (!close(result.point, point)) {
      problems.push(
        `${where}.point is ${String(result.point)}, but ${String(count)} / ${String(total)} is ${String(point)}`,
      );
    }
    const { lower, upper } = wilson(count, total);
    if (!close(result.interval.lower, lower) || !close(result.interval.upper, upper)) {
      problems.push(
        `${where}.interval is ${String(result.interval.lower)} to ${String(result.interval.upper)}, but the two-sided 95% ` +
          `Wilson interval of ${String(count)} of ${String(total)} is ${String(lower)} to ${String(upper)}`,
      );
    }
  }
  const status = statusOf(result);
  if (result.status !== status) {
    const volume =
      result.sizedVolume === null ? "no sized volume" : `a sized volume of ${String(result.sizedVolume)}`;
    problems.push(
      `${where}.status is ${result.status}, but ${String(count)} of ${String(total)} against ${result.direction} ` +
        `${String(result.target)} with ${volume} is ${status} (BP 8: below a bar's sized volume, never met)`,
    );
  }
  return problems;
}

/** The problems of every measure in a measures object. */
function measuresProblems(where, measures) {
  return Object.entries(measures).flatMap(([name, result]) => measureProblems(`${where}.${name}`, result));
}

const sameBundle = (a, b) => a !== null && b !== null && a.hash === b.hash && a.build === b.build;

/**
 * reportNumbers: every point estimate is its count over its total; every interval is the two-sided 95% Wilson score
 * interval of them (CQ-10); every status follows its target, its direction and its sized volume (BP 8; Q-16; J-19);
 * the journeys broken down are the journeys the slice holds, each once (BP 8 "Journey milestone"); a hard invariant
 * lists breaching items only when it has breaches (arch 08 line 427); the cost per booking is the cost over the
 * completed bookings, met only at or under the target (arch 10 line 552; CQ-12); p50 is not above p95 (K-08 v1
 * replyTime); the last passing bundle is another bundle; and each changed effect differs, holds effects of its own
 * class, and is counted in its class (BP 8 "Bundle").
 */
export function reportNumbers(report) {
  const problems = [...measuresProblems("measures", report.measures)];

  const journeys = new Set(report.journeys);
  const brokenDown = new Set();
  report.byJourney.forEach((entry, k) => {
    if (brokenDown.has(entry.journey))
      problems.push(`byJourney[${String(k)}]: journey ${String(entry.journey)} twice`);
    brokenDown.add(entry.journey);
    if (!journeys.has(entry.journey)) {
      problems.push(
        `byJourney[${String(k)}]: journey ${String(entry.journey)} is not one of the slice's journeys`,
      );
    }
    problems.push(...measuresProblems(`byJourney[${String(k)}].measures`, entry.measures));
  });
  for (const journey of journeys) {
    if (!brokenDown.has(journey))
      problems.push(`byJourney: journey ${String(journey)} of the slice has no entry`);
  }

  for (const [name, result] of Object.entries(report.hardInvariants)) {
    if (result.breaches === 0 && result.items.length > 0) {
      problems.push(`hardInvariants.${name}: lists items with no breach`);
    }
    if (result.breaches > 0 && result.items.length === 0) {
      problems.push(`hardInvariants.${name}: ${String(result.breaches)} breaches but no item`);
    }
    if (result.items.length > result.breaches) {
      problems.push(`hardInvariants.${name}: more items than breaches`);
    }
  }

  const { cost } = report;
  if (cost.completedBookings > 0) {
    const perBooking = cost.costMicroUsd / cost.completedBookings;
    if (Math.abs(cost.perBookingMicroUsd - perBooking) > 1e-6) {
      problems.push(
        `cost.perBookingMicroUsd is ${String(cost.perBookingMicroUsd)}, but the cost per booking is ${String(perBooking)}`,
      );
    }
    const status = perBooking <= cost.targetMicroUsd ? "met" : "miss";
    if (cost.status !== status)
      problems.push(`cost.status is ${cost.status}, but the cost per booking is ${status}`);
  }

  if (report.replyTime !== null && report.replyTime.p50Ms > report.replyTime.p95Ms) {
    problems.push("replyTime: p50Ms is above p95Ms");
  }

  if (sameBundle(report.lastPassingBundleId, report.bundleId)) {
    problems.push(
      "lastPassingBundleId is the bundle run: a bundle is compared with the last one that passed before it",
    );
  }

  const counted = { money: 0, booking: 0, consent: 0, safety: 0 };
  report.changedEffects.effects.forEach((entry, k) => {
    counted[entry.class] += 1;
    if (JSON.stringify(entry.last) === JSON.stringify(entry.now)) {
      problems.push(
        `changedEffects.effects[${String(k)}]: what the last passing bundle committed is unchanged`,
      );
    }
    for (const effect of [...entry.last, ...entry.now]) {
      if (effect.class !== entry.class) {
        problems.push(
          `changedEffects.effects[${String(k)}]: holds a ${effect.class} effect in a ${entry.class} entry`,
        );
      }
    }
  });
  for (const [name, count] of Object.entries(counted)) {
    if (report.changedEffects.counts[name] !== count) {
      problems.push(
        `changedEffects.counts.${name} is ${String(report.changedEffects.counts[name])}, but ${String(count)} ${name} effects are listed`,
      );
    }
  }
  return problems;
}

/** The named rules, by the name a fixtures/index.json entry gives in "rule". */
export const rules = Object.freeze({ reportNumbers });
