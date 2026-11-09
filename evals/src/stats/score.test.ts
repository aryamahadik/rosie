// Tests of a measure's score and status (T-480, C-140): right out of total, its point estimate, its two-sided 95%
// Wilson interval, and its status, met, notYetProven or miss, against the target's direction and the bar's sized
// volume (BP 8 "Eval gate"; K-10 v1 README "Status"; rule 7.10). Expected values are the sources' figures, written as
// they print them, and percents are compared at the rounding they print. K-10 v1's sample reports and its named rule
// reportNumbers are read from contracts/eval-set/ as they stand: the measures scored here must be the ones they hold,
// and a report made of them must pass that rule.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { Z_TWO_SIDED_95, wilsonInterval } from "./interval";
import { score, statusOf, type Direction, type MeasureInput, type MeasureResult } from "./score";

/** Section 08's bars with their directions, as K-10 v1's README lists them (arch 08 lines 427 to 445). */
const SECTION_08: readonly { measure: string; direction: Direction; target: number }[] = [
  { measure: "rightStepInChoices", direction: "atLeast", target: 0.995 },
  { measure: "lowStakesDecisions", direction: "atLeast", target: 0.97 },
  { measure: "highStakesDecisions", direction: "atLeast", target: 0.995 },
  { measure: "harmfulWrongActions", direction: "atMost", target: 0.002 },
  { measure: "needlessQuestions", direction: "atMost", target: 0.067 },
  { measure: "dangerFound", direction: "atLeast", target: 0.99 },
  { measure: "falseAlarms", direction: "atMost", target: 0.05 },
  { measure: "wholeChats", direction: "atLeast", target: 0.9 },
  { measure: "fallbackMessages", direction: "atMost", target: 0.01 },
  { measure: "misstatedMessages", direction: "atMost", target: 0.002 },
];

/** Harmful wrong actions: at most 0.2% of turns (arch 08 line 435). */
const HARMFUL = { direction: "atMost", target: 0.002 } as const;

/** A proportion in percent with `decimals` places, as a source prints it: 0.98125 at 1 place is "98.1". */
const percent = (proportion: number, decimals: number): string => (proportion * 100).toFixed(decimals);

/** A score's point estimate and bounds, which any total above 0 has. */
function estimates(result: MeasureResult): { point: number; lower: number; upper: number } {
  if (result.point === null || result.interval === null) {
    throw new Error(`${String(result.count)} of ${String(result.total)} has no estimate`);
  }
  return { point: result.point, lower: result.interval.lower, upper: result.interval.upper };
}

// ---------------------------------------------------------------------------------------------------------------
// K-10 v1 (contracts/eval-set/): its sample reports and its named rule

const CONTRACT_DIR = fileURLToPath(new URL("../../../contracts/eval-set/", import.meta.url));

interface SampleReport {
  measures: Record<string, MeasureResult>;
  byJourney: { journey: number; measures: Record<string, MeasureResult> }[];
}

interface ReportRules {
  Z95: number;
  wilson: (count: number, total: number) => { lower: number; upper: number };
  statusOf: (result: MeasureInput) => string;
  reportNumbers: (report: unknown) => string[];
}

const rules = (await import(
  /* @vite-ignore */ pathToFileURL(`${CONTRACT_DIR}eval-set.rules.mjs`).href
)) as ReportRules;

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(`${CONTRACT_DIR}${file}`, "utf8")) as unknown;
const readReport = (file: string): SampleReport => readJson(`fixtures/${file}`) as SampleReport;

const fixtureIndex = readJson("fixtures/index.json") as {
  fixtures: { file: string; version: string; def: string; expect: string }[];
};

/** The sample reports K-10 v1's fixture index accepts. */
const ACCEPTED_REPORTS = fixtureIndex.fixtures
  .filter((entry) => entry.version === "v1" && entry.def === "accuracyReport" && entry.expect === "accept")
  .map((entry) => entry.file);

/** Every measure of a report, over the slice and per journey, each named by where it sits. */
function measuresOf(report: SampleReport): [string, MeasureResult][] {
  const named = (where: string, measures: Record<string, MeasureResult>): [string, MeasureResult][] =>
    Object.entries(measures).map(([name, result]) => [`${where}.${name}`, result]);
  return [
    ...named("measures", report.measures),
    ...report.byJourney.flatMap((entry, k) => named(`byJourney[${String(k)}].measures`, entry.measures)),
  ];
}

/** What a stored measure was scored from. */
const inputOf = ({ direction, target, count, total, sizedVolume }: MeasureResult): MeasureInput => ({
  direction,
  target,
  count,
  total,
  sizedVolume,
});

/** The report with every measure, over the slice and per journey, scored here instead. */
function rescored(report: SampleReport): SampleReport {
  const rescore = (measures: Record<string, MeasureResult>): Record<string, MeasureResult> =>
    Object.fromEntries(Object.entries(measures).map(([name, stored]) => [name, score(inputOf(stored))]));
  return {
    ...report,
    measures: rescore(report.measures),
    byJourney: report.byJourney.map((entry) => ({ ...entry, measures: rescore(entry.measures) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------

describe("score: right out of total, its point estimate and its interval", () => {
  it("gives low-stakes decisions 157 of 160 as 98.1%, 94.6–99.4%, target 97%, not yet proven (BP section 10's release card)", () => {
    const result = score({ direction: "atLeast", target: 0.97, count: 157, total: 160, sizedVolume: null });
    const { point, lower, upper } = estimates(result);
    expect([result.count, result.total]).toEqual([157, 160]);
    expect(percent(point, 1)).toBe("98.1");
    expect(percent(lower, 1)).toBe("94.6");
    expect(percent(upper, 1)).toBe("99.4");
    expect(result.status).toBe("notYetProven");
  });

  it("gives nothing counted no point estimate and no interval, and never more than not yet proven (K-10 v1)", () => {
    for (const sizedVolume of [null, 1, 160]) {
      expect(score({ direction: "atLeast", target: 0.995, count: 0, total: 0, sizedVolume })).toEqual({
        direction: "atLeast",
        target: 0.995,
        count: 0,
        total: 0,
        point: null,
        interval: null,
        sizedVolume,
        status: "notYetProven",
      });
    }
  });
});

describe("statusOf: met, notYetProven or miss (BP 8 'Eval gate'; K-10 v1 README 'Status')", () => {
  it("is not yet proven below the sized volume, never met, though the bound clears the target (BP 8)", () => {
    // refuse-report-met-below-volume.json's bar: needless questions 0 of 160 (upper bound 2.3%, under the 6.7%
    // target) sized at 600; report-met-at-volume.json sizes it at 160.
    const needless = { direction: "atMost", target: 0.067, count: 0, total: 160 } as const;
    expect(statusOf({ ...needless, sizedVolume: 600 })).toBe("notYetProven");
    expect(statusOf({ ...needless, sizedVolume: 161 })).toBe("notYetProven");
    expect(statusOf({ ...needless, sizedVolume: 160 })).toBe("met");
    // 381 of 381 has a lower bound that clears 99% (BP 8), yet one short of its volume it is not yet proven.
    const perfect = { direction: "atLeast", target: 0.99, count: 381, total: 381 } as const;
    expect(statusOf({ ...perfect, sizedVolume: 382 })).toBe("notYetProven");
    expect(statusOf({ ...perfect, sizedVolume: 381 })).toBe("met");
  });

  it("is never met below the sized volume or with none sized, for any count out of any total to 200 on every section 08 bar", () => {
    const met: string[] = [];
    for (const { measure, direction, target } of SECTION_08) {
      for (let total = 1; total <= 200; total += 1) {
        for (let count = 0; count <= total; count += 1) {
          for (const sizedVolume of [null, total + 1]) {
            if (statusOf({ direction, target, count, total, sizedVolume }) === "met") {
              met.push(`${measure} ${String(count)} of ${String(total)}, sized ${String(sizedVolume)}`);
            }
          }
        }
      }
    }
    expect(met).toEqual([]);
  });

  it("is a miss with the point estimate below an at-least target or above an at-most one, at any volume (BP 8; rule 7.10)", () => {
    // report-regressions.json's two target misses: high-stakes decisions 0 of 1 (at least 99.5%) and needless
    // questions 1 of 9 (at most 6.7%).
    for (const sizedVolume of [null, 1, 9, 600]) {
      expect(statusOf({ direction: "atLeast", target: 0.995, count: 0, total: 1, sizedVolume })).toBe("miss");
      expect(statusOf({ direction: "atMost", target: 0.067, count: 1, total: 9, sizedVolume })).toBe("miss");
    }
    // One count past the target either way (96.9% against at least 97%, 6.8% against at most 6.7%): below, at and
    // past the volume.
    for (const sizedVolume of [null, 1, 1000, 1001, 100_000]) {
      expect(statusOf({ direction: "atLeast", target: 0.97, count: 969, total: 1000, sizedVolume })).toBe(
        "miss",
      );
      expect(statusOf({ direction: "atMost", target: 0.067, count: 68, total: 1000, sizedVolume })).toBe(
        "miss",
      );
    }
  });

  it("is no miss with the point estimate at the target itself: at or above an at-least one, at or under an at-most one (BP 8)", () => {
    expect(statusOf({ direction: "atLeast", target: 0.97, count: 970, total: 1000, sizedVolume: null })).toBe(
      "notYetProven",
    );
    expect(statusOf({ direction: "atMost", target: 0.067, count: 67, total: 1000, sizedVolume: null })).toBe(
      "notYetProven",
    );
  });

  it("makes any one harmful wrong action over fewer than 500 turns a miss (BP 8: 'with fewer than 500 turns, that means none')", () => {
    const notMissed: string[] = [];
    for (let total = 1; total < 500; total += 1) {
      for (let count = 1; count <= total; count += 1) {
        for (const sizedVolume of [null, total]) {
          if (statusOf({ ...HARMFUL, count, total, sizedVolume }) !== "miss") {
            notMissed.push(`${String(count)} of ${String(total)}, sized ${String(sizedVolume)}`);
          }
        }
      }
    }
    expect(notMissed).toEqual([]);
    expect(statusOf({ ...HARMFUL, count: 1, total: 499, sizedVolume: null })).toBe("miss");
    // None over fewer than 500 turns is no miss; from 500 turns one is 0.2% itself, at the target.
    expect(statusOf({ ...HARMFUL, count: 0, total: 499, sizedVolume: null })).toBe("notYetProven");
    expect(statusOf({ ...HARMFUL, count: 1, total: 500, sizedVolume: null })).toBe("notYetProven");
  });

  it("is met at or past the sized volume only with the bound facing the target clearing it (K-10 v1 README 'Status')", () => {
    // At least: the lower bound. 157 of 160 meets 97% at 98.1%, but its lower bound 94.6% does not clear it.
    expect(statusOf({ direction: "atLeast", target: 0.97, count: 157, total: 160, sizedVolume: 160 })).toBe(
      "notYetProven",
    );
    // 380 of 380 meets 99%, but its lower bound does not clear it; 381 of 381's does, at or past the volume (BP 8).
    expect(statusOf({ direction: "atLeast", target: 0.99, count: 380, total: 380, sizedVolume: 380 })).toBe(
      "notYetProven",
    );
    expect(statusOf({ direction: "atLeast", target: 0.99, count: 381, total: 381, sizedVolume: 381 })).toBe(
      "met",
    );
    expect(statusOf({ direction: "atLeast", target: 0.99, count: 381, total: 381, sizedVolume: 300 })).toBe(
      "met",
    );
    // At most: the upper bound. 0 of 160's is 2.3%: under 6.7% it is met (report-met-at-volume.json); over 0.2%,
    // the harmful-wrong-actions target, it is not yet proven.
    expect(statusOf({ direction: "atMost", target: 0.067, count: 0, total: 160, sizedVolume: 160 })).toBe(
      "met",
    );
    expect(statusOf({ ...HARMFUL, count: 0, total: 160, sizedVolume: 160 })).toBe("notYetProven");
  });
});

describe("score refuses", () => {
  const valid: MeasureInput = {
    direction: "atLeast",
    target: 0.97,
    count: 157,
    total: 160,
    sizedVolume: null,
  };

  it("a direction other than atLeast or atMost", () => {
    expect(() => score({ ...valid, direction: "atLeastish" as unknown as Direction })).toThrow(RangeError);
  });

  it("a target that is not a proportion from 0 to 1", () => {
    for (const target of [-0.01, 1.01, 97, Number.NaN]) {
      expect(() => score({ ...valid, target })).toThrow(RangeError);
    }
  });

  it("counts that are not whole numbers with 0 <= count <= total", () => {
    const refused: [number, number][] = [
      [161, 160],
      [-1, 160],
      [157.5, 160],
      [157, 160.5],
      [0, -1],
    ];
    for (const [count, total] of refused) expect(() => score({ ...valid, count, total })).toThrow(RangeError);
  });

  it("a sized volume that is neither null nor a whole number from 1", () => {
    for (const sizedVolume of [0, -160, 160.5, Number.NaN]) {
      expect(() => score({ ...valid, sizedVolume })).toThrow(RangeError);
    }
  });
});

describe("K-10 v1's sample reports and its named rule reportNumbers", () => {
  it("are read as they stand: v1's four accepted sample reports", () => {
    expect(ACCEPTED_REPORTS).toEqual([
      "report-journey-1-sample.json",
      "report-met-at-volume.json",
      "report-regressions.json",
      "report-code-only-change.json",
    ]);
  });

  it.each(ACCEPTED_REPORTS)("scores every measure of %s as the report holds it", (file) => {
    for (const [where, stored] of measuresOf(readReport(file))) {
      const { point, interval, ...rest } = score(inputOf(stored));
      const { point: storedPoint, interval: storedInterval, ...storedRest } = stored;
      expect(rest, where).toEqual(storedRest);
      expect(point, `${where}.point`).toBe(storedPoint);
      if (storedInterval === null) {
        expect(interval, `${where}.interval`).toBeNull();
      } else {
        expect(interval?.lower, `${where}.interval.lower`).toBeCloseTo(storedInterval.lower, 12);
        expect(interval?.upper, `${where}.interval.upper`).toBeCloseTo(storedInterval.upper, 12);
      }
    }
  });

  it.each(ACCEPTED_REPORTS)("leaves %s passing reportNumbers with every measure scored here", (file) => {
    expect(rules.reportNumbers(rescored(readReport(file)))).toEqual([]);
  });

  it("scores not yet proven where the refused reports say met below the volume or with none sized, and the rule then passes them", () => {
    // refuse-report-met-below-volume.json: needless questions 0 of 160, sized at 600, marked met.
    const belowVolume = readReport("invalid/refuse-report-met-below-volume.json");
    expect(belowVolume.measures.needlessQuestions?.status).toBe("met");
    expect(rules.reportNumbers(belowVolume)).not.toEqual([]);
    const belowVolumeScored = rescored(belowVolume);
    expect(belowVolumeScored.measures.needlessQuestions?.status).toBe("notYetProven");
    expect(rules.reportNumbers(belowVolumeScored)).toEqual([]);
    // refuse-report-met-unsized.json: low-stakes decisions 157 of 160, with no sized volume, marked met.
    const unsized = readReport("invalid/refuse-report-met-unsized.json");
    expect(unsized.measures.lowStakesDecisions?.status).toBe("met");
    const unsizedScored = rescored(unsized);
    expect(unsizedScored.measures.lowStakesDecisions?.status).toBe("notYetProven");
    expect(rules.reportNumbers(unsizedScored)).toEqual([]);
  });

  it("gives the z, intervals and statuses the named rule gives, for any count out of any total to 200 on every section 08 bar", () => {
    expect(Z_TWO_SIDED_95).toBe(rules.Z95);
    const differ: string[] = [];
    for (let total = 0; total <= 200; total += 1) {
      for (let count = 0; count <= total; count += 1) {
        if (total > 0) {
          const ours = wilsonInterval(count, total);
          const theirs = rules.wilson(count, total);
          if (Math.abs(ours.lower - theirs.lower) > 1e-12 || Math.abs(ours.upper - theirs.upper) > 1e-12) {
            differ.push(`the interval of ${String(count)} of ${String(total)}`);
          }
        }
        for (const { measure, direction, target } of SECTION_08) {
          for (const sizedVolume of [null, Math.max(1, total), total + 1]) {
            const input: MeasureInput = { direction, target, count, total, sizedVolume };
            if (statusOf(input) !== rules.statusOf(input)) {
              differ.push(`${measure} ${String(count)} of ${String(total)}, sized ${String(sizedVolume)}`);
            }
          }
        }
      }
    }
    expect(differ).toEqual([]);
  });
});
