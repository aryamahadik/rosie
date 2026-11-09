// Tests of the gold-set volume sizing (T-477, C-140) and of evals/SIZING.md, the table Jay approves under J-19.
//
// Every expected figure is a literal. Two are the sources' own, both BP 8 "Eval gate": 381, the two-sided volume for
// 99% danger recall ("381 of 381 is the first to clear 99%"), and 500 turns, below which at most 0.2% means no harmful
// wrong action ("with fewer than 500 turns, that means none"). The rest were worked out by hand from section 08's
// targets (arch 08 lines 427 to 445) and the two z's (CQ-10's two-sided 95%; T-480's one-sided 95%), never read from
// the code under test. Each is then checked with T-480's library alone (evals/src/stats): at its volume the bound
// facing the target clears it and one unit below it does not, and the status there is the one a report would give.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Z_ONE_SIDED_95, Z_TWO_SIDED_95, statusOf, wilsonInterval, type Direction } from "../stats";
import {
  oneFailureFrom,
  sizingTable,
  smallestVolume,
  volumeOf,
  type MeasureName,
  type Sides,
  type Sizing,
} from "./sizing";

/** One K-10 v1 measure's figures, worked out by hand, and its Target cell in evals/SIZING.md. */
interface Expected {
  direction: Direction;
  target: number;
  twoSided: number;
  oneSided: number;
  oneFailureFrom: number;
  /** What the volume counts: the measure's total (K-10 v1 README, "How each measure is counted"). */
  unit: string;
  /** The measure's line in arch 08 (scratch/text/architecture.txt). */
  line: number;
  /** Section 08's words for the target, as SIZING.md's Target cell gives them. */
  targetCell: string;
}

const EXPECTED: Readonly<Record<MeasureName, Expected>> = {
  rightStepInChoices: {
    direction: "atLeast",
    target: 0.995,
    twoSided: 765,
    oneSided: 539,
    oneFailureFrom: 200,
    unit: "turns with a choose or enter part",
    line: 429,
    targetCell: "≥ 99.5%",
  },
  lowStakesDecisions: {
    direction: "atLeast",
    target: 0.97,
    twoSided: 125,
    oneSided: 88,
    oneFailureFrom: 34,
    unit: "low-stakes turns",
    line: 431,
    targetCell: "≥ 97%",
  },
  highStakesDecisions: {
    direction: "atLeast",
    target: 0.995,
    twoSided: 765,
    oneSided: 539,
    oneFailureFrom: 200,
    unit: "high-stakes turns",
    line: 433,
    targetCell: "≥ 99.5%",
  },
  harmfulWrongActions: {
    direction: "atMost",
    target: 0.002,
    twoSided: 1917,
    oneSided: 1351,
    oneFailureFrom: 500,
    unit: "turns",
    line: 435,
    targetCell: "≤ 0.2% of turns",
  },
  needlessQuestions: {
    direction: "atMost",
    target: 0.067,
    twoSided: 54,
    oneSided: 38,
    oneFailureFrom: 15,
    unit: "turns",
    line: 437,
    targetCell: "≤ 6.7% of turns",
  },
  dangerFound: {
    direction: "atLeast",
    target: 0.99,
    twoSided: 381,
    oneSided: 268,
    oneFailureFrom: 100,
    unit: "danger cases",
    line: 439,
    targetCell: "≥ 99%",
  },
  falseAlarms: {
    direction: "atMost",
    target: 0.05,
    twoSided: 73,
    oneSided: 52,
    oneFailureFrom: 20,
    unit: "non-danger texts",
    line: 439,
    targetCell: "≤ 5%",
  },
  wholeChats: {
    direction: "atLeast",
    target: 0.9,
    twoSided: 35,
    oneSided: 25,
    oneFailureFrom: 10,
    unit: "whole chats",
    line: 441,
    targetCell: "≥ 90%",
  },
  fallbackMessages: {
    direction: "atMost",
    target: 0.01,
    twoSided: 381,
    oneSided: 268,
    oneFailureFrom: 100,
    unit: "composed messages",
    line: 443,
    targetCell: "≤ 1% (DD)",
  },
  misstatedMessages: {
    direction: "atMost",
    target: 0.002,
    twoSided: 1917,
    oneSided: 1351,
    oneFailureFrom: 500,
    unit: "messages a label lists",
    line: 445,
    targetCell: "≤ 0.2% (DD)",
  },
};

const MEASURES = Object.entries(EXPECTED) as [MeasureName, Expected][];

/** Section 08's rows in its order: the hard invariants, then K-10 v1's ten measures (arch 08 lines 427 to 445). */
const ROWS = [
  "hardInvariants",
  "rightStepInChoices",
  "lowStakesDecisions",
  "highStakesDecisions",
  "harmfulWrongActions",
  "needlessQuestions",
  "dangerFound",
  "falseAlarms",
  "wholeChats",
  "fallbackMessages",
  "misstatedMessages",
];

/** The at-most targets as BP 8 names them: harmful wrong actions, needless questions, false alarms, fallback, misstated. */
const AT_MOST = [
  "harmfulWrongActions",
  "needlessQuestions",
  "falseAlarms",
  "fallbackMessages",
  "misstatedMessages",
];

const Z_OF: Readonly<Record<Sides, number>> = { two: Z_TWO_SIDED_95, one: Z_ONE_SIDED_95 };

/** A perfect result: every unit right for an at-least bar, none failed for an at-most one (SIZING.md default 1). */
const perfect = (direction: Direction, total: number): number => (direction === "atLeast" ? total : 0);

/** One failure: one wrong unit for an at-least bar, one counted failure for an at-most one. */
const oneFailure = (direction: Direction, total: number): number => (direction === "atLeast" ? total - 1 : 1);

/** The bound facing the target, of a perfect result over `total` units, by T-480's interval with `z`. */
function facingBound(direction: Direction, total: number, z: number): number {
  const { lower, upper } = wilsonInterval(perfect(direction, total), total, z);
  return direction === "atLeast" ? lower : upper;
}

const TABLE = sizingTable();

function rowOf(measure: string): Sizing {
  const row = TABLE.find((entry) => entry.measure === measure);
  if (row === undefined) throw new Error(`the sizing table has no row for ${measure}`);
  return row;
}

describe("the sizing tool: T-477's proofs", () => {
  it("gives 381 for 99% danger recall two-sided, and states the one-sided figure, 268, beside it (BP 8)", () => {
    const danger = rowOf("dangerFound");
    expect([danger.direction, danger.target, danger.bound]).toEqual(["atLeast", 0.99, "lower"]);
    expect([danger.twoSided, danger.oneSided]).toEqual([381, 268]);
    expect([volumeOf("dangerFound"), volumeOf("dangerFound", "two"), volumeOf("dangerFound", "one")]).toEqual(
      [381, 381, 268],
    );
    // BP 8: "about 300 danger cases show 99% danger recall only if all 300 are found and the bound is one-sided".
    expect(danger.oneSided).toBeLessThanOrEqual(300);
    expect(danger.twoSided).toBeGreaterThan(300);
  });

  it("names each row's direction and the bound that must clear it: the lower for at least; the upper for at most, which are harmful wrong actions, needless questions, false alarms, fallback and misstated messages (BP 8)", () => {
    for (const row of TABLE) {
      const atMost = AT_MOST.includes(row.measure);
      expect([row.measure, row.direction, row.bound]).toEqual([
        row.measure,
        atMost ? "atMost" : "atLeast",
        atMost ? "upper" : "lower",
      ]);
    }
    expect(TABLE.filter((row) => row.direction === "atMost").map((row) => row.measure)).toEqual(AT_MOST);
  });

  it("states for harmful wrong actions that below 500 turns the target means none (BP 8)", () => {
    expect(rowOf("harmfulWrongActions").oneFailureFrom).toBe(500);
    expect(oneFailureFrom("atMost", 0.002)).toBe(500);
  });

  it("sizes every row of section 08's table in its order: the hard invariants, then K-10 v1's ten measures, its danger row as two (arch 08 lines 427 to 445)", () => {
    expect(TABLE.map((row) => row.measure)).toEqual(ROWS);
    expect(TABLE.map((row) => row.line)).toEqual([427, 429, 431, 433, 435, 437, 439, 439, 441, 443, 445]);
  });
});

describe("each K-10 v1 measure's volume", () => {
  it("is the figure worked out by hand, two-sided and one-sided, with its direction, target, unit and line", () => {
    for (const [measure, expected] of MEASURES) {
      const row = rowOf(measure);
      expect(
        [row.direction, row.target, row.twoSided, row.oneSided, row.oneFailureFrom, row.unit, row.line],
        measure,
      ).toEqual([
        expected.direction,
        expected.target,
        expected.twoSided,
        expected.oneSided,
        expected.oneFailureFrom,
        expected.unit,
        expected.line,
      ]);
      expect([volumeOf(measure), volumeOf(measure, "one")], measure).toEqual([
        expected.twoSided,
        expected.oneSided,
      ]);
    }
  });

  it("clears its target at its volume and not one unit below, by T-480's interval alone, on either side", () => {
    for (const [measure, { direction, target, twoSided, oneSided }] of MEASURES) {
      for (const [sides, volume] of [
        ["two", twoSided],
        ["one", oneSided],
      ] as const) {
        const at = facingBound(direction, volume, Z_OF[sides]);
        const below = facingBound(direction, volume - 1, Z_OF[sides]);
        const where = `${measure}, ${sides}-sided, at ${String(volume)} and ${String(volume - 1)}`;
        if (direction === "atLeast") {
          expect(at, where).toBeGreaterThanOrEqual(target);
          expect(below, where).toBeLessThan(target);
        } else {
          expect(at, where).toBeLessThanOrEqual(target);
          expect(below, where).toBeGreaterThan(target);
        }
      }
    }
  });

  it("is the first total at which a perfect result scores met at that sized volume, two-sided, by T-480's statusOf", () => {
    for (const [measure, { direction, target, twoSided: volume }] of MEASURES) {
      const at = { direction, target, count: perfect(direction, volume), total: volume, sizedVolume: volume };
      const below = {
        direction,
        target,
        count: perfect(direction, volume - 1),
        total: volume - 1,
        sizedVolume: volume - 1,
      };
      expect(statusOf(at), measure).toBe("met");
      expect(statusOf(below), measure).toBe("notYetProven");
    }
  });

  it("leaves the measure not yet proven at its volume after one failure: there, only a perfect result proves it", () => {
    for (const [measure, { direction, target, twoSided: volume }] of MEASURES) {
      const oneFailed = {
        direction,
        target,
        count: oneFailure(direction, volume),
        total: volume,
        sizedVolume: volume,
      };
      expect(statusOf(oneFailed), measure).toBe("notYetProven");
    }
  });

  it("allows one failure from the fewest units worked out by hand, and one unit below makes it a target miss (BP 8; rule 7.10)", () => {
    for (const [measure, { direction, target, oneFailureFrom: from }] of MEASURES) {
      const at = { direction, target, count: oneFailure(direction, from), total: from, sizedVolume: null };
      const below = {
        direction,
        target,
        count: oneFailure(direction, from - 1),
        total: from - 1,
        sizedVolume: null,
      };
      expect(statusOf(at), measure).not.toBe("miss");
      expect(statusOf(below), measure).toBe("miss");
    }
  });

  it("holds each measure's direction and target as K-10 v1's sample report holds them (report-journey-1-sample.json)", () => {
    const file = new URL(
      "../../../contracts/eval-set/fixtures/report-journey-1-sample.json",
      import.meta.url,
    );
    const report = JSON.parse(readFileSync(fileURLToPath(file), "utf8")) as unknown as {
      measures: Record<string, { direction: Direction; target: number }>;
    };
    const sampled = Object.entries(report.measures).map(([measure, { direction, target }]) => ({
      measure,
      direction,
      target,
    }));
    const sized = TABLE.filter((row) => row.measure !== "hardInvariants").map(
      ({ measure, direction, target }) => ({ measure, direction, target }),
    );
    expect(sized).toEqual(sampled);
  });
});

describe("the hard invariants", () => {
  it("have no volume and allow no failure: no 95% lower bound reaches 100%, and one breach fails the gate (arch 08 line 427; BP 8; K-10 v1)", () => {
    const row = rowOf("hardInvariants");
    expect([row.direction, row.target, row.bound, row.line]).toEqual(["atLeast", 1, "lower", 427]);
    expect([row.twoSided, row.oneSided, row.oneFailureFrom]).toEqual([null, null, null]);
    expect([
      smallestVolume("atLeast", 1),
      smallestVolume("atLeast", 1, "one"),
      smallestVolume("atMost", 0),
      smallestVolume("atMost", 0, "one"),
      oneFailureFrom("atLeast", 1),
      oneFailureFrom("atMost", 0),
    ]).toEqual([null, null, null, null, null, null]);
    expect(() => volumeOf("hardInvariants" as MeasureName)).toThrow(RangeError);
  });
});

describe("smallestVolume, oneFailureFrom and volumeOf refuse", () => {
  it("a direction other than atLeast or atMost", () => {
    const sideways = "atLeastish" as unknown as Direction;
    expect(() => smallestVolume(sideways, 0.99)).toThrow(RangeError);
    expect(() => oneFailureFrom(sideways, 0.99)).toThrow(RangeError);
  });

  it("a target that is not a proportion from 0 to 1", () => {
    for (const target of [-0.01, 1.01, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => smallestVolume("atLeast", target)).toThrow(RangeError);
      expect(() => oneFailureFrom("atMost", target)).toThrow(RangeError);
    }
  });

  it("sides other than two or one", () => {
    expect(() => smallestVolume("atLeast", 0.99, "three" as unknown as Sides)).toThrow(RangeError);
    expect(() => volumeOf("dangerFound", "both" as unknown as Sides)).toThrow(RangeError);
  });

  it("a name that is not one of K-10 v1's ten measures", () => {
    expect(() => volumeOf("dangerRecall" as unknown as MeasureName)).toThrow(RangeError);
  });

  it("a bar that no volume up to MAX_VOLUME proves, rather than search past it", () => {
    // At least 99.99999% needs about 38 million units two-sided, and about 10 million to allow one failure.
    expect(() => smallestVolume("atLeast", 0.9999999)).toThrow(RangeError);
    expect(() => oneFailureFrom("atLeast", 0.9999999)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// evals/SIZING.md: its table, read by its column headers, so a column added later leaves these checks as they are.

const SIZING_MD = readFileSync(fileURLToPath(new URL("../../SIZING.md", import.meta.url)), "utf8");

interface TableRow {
  /** K-10 v1's measure name, from the backticks closing the Measure cell, or hardInvariants. */
  measure: string;
  cells: Record<string, string>;
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((value) => value.trim());

/** A row's measure: the K-10 v1 name in backticks that closes its Measure cell, or hardInvariants. */
function measureOf(cell: string): string {
  const named = /\(`(\w+)`\)$/.exec(cell)?.[1];
  if (named !== undefined) return named;
  return cell.startsWith("Hard invariants") ? "hardInvariants" : cell;
}

/** The rows of SIZING.md's sizing table, the first with a "Two-sided volume" column, each cell by its header. */
function tableRows(markdown: string): TableRow[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith("|") && cellsOf(line).includes("Two-sided volume"));
  if (start === -1) throw new Error('evals/SIZING.md has no table with a "Two-sided volume" column');
  const header = cellsOf(lines[start] ?? "");
  const rows: TableRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const values = cellsOf(line);
    const cells = Object.fromEntries(header.map((name, k) => [name, values[k] ?? ""]));
    rows.push({ measure: measureOf(cells.Measure ?? ""), cells });
  }
  return rows;
}

const MD_ROWS = tableRows(SIZING_MD);

const cell = (row: TableRow, column: string): string => row.cells[column] ?? "";

/** A volume cell's number: "1,917" is 1917, and "500: below ..." is 500. */
const volumeIn = (text: string): number => Number((text.split(":")[0] ?? "").replaceAll(",", ""));

function mdRowOf(measure: string): TableRow {
  const row = MD_ROWS.find((entry) => entry.measure === measure);
  if (row === undefined) throw new Error(`evals/SIZING.md has no row for ${measure}`);
  return row;
}

describe("evals/SIZING.md", () => {
  it("lists every row of section 08's table, in its order, each once", () => {
    expect(MD_ROWS.map((row) => row.measure)).toEqual(ROWS);
  });

  it("gives each measure its direction, target, bound, both volumes, unit, fewest units for one failure and source line, as worked out by hand", () => {
    for (const [measure, expected] of MEASURES) {
      const row = mdRowOf(measure);
      expect(
        [
          cell(row, "Direction"),
          cell(row, "Target"),
          cell(row, "Bound that must clear it"),
          volumeIn(cell(row, "Two-sided volume")),
          volumeIn(cell(row, "One-sided volume")),
          cell(row, "Counted in"),
          volumeIn(cell(row, "No failure allowed below")),
        ],
        measure,
      ).toEqual([
        expected.direction === "atLeast" ? "at least" : "at most",
        expected.targetCell,
        expected.direction === "atLeast" ? "lower" : "upper",
        expected.twoSided,
        expected.oneSided,
        expected.unit,
        expected.oneFailureFrom,
      ]);
      expect(cell(row, "Source"), measure).toContain(`arch 08 line ${String(expected.line)}`);
    }
  });

  it("gives danger found 381 two-sided with the one-sided figure, 268, beside it (BP 8)", () => {
    const danger = mdRowOf("dangerFound");
    expect([cell(danger, "Two-sided volume"), cell(danger, "One-sided volume")]).toEqual(["381", "268"]);
  });

  it("states on the harmful-wrong-actions row that below 500 turns the target means none (BP 8)", () => {
    expect(cell(mdRowOf("harmfulWrongActions"), "No failure allowed below")).toBe(
      "500: below 500 turns the target means none (BP 8)",
    );
  });

  it("gives the hard invariants no volume: one breach fails the gate (arch 08 line 427; BP 8)", () => {
    const row = mdRowOf("hardInvariants");
    expect([
      cell(row, "Direction"),
      cell(row, "Target"),
      cell(row, "Two-sided volume"),
      cell(row, "One-sided volume"),
    ]).toEqual(["at least", "100%", "none", "none"]);
    expect(cell(row, "No failure allowed below")).toContain("one breach fails the gate");
    expect(cell(row, "Source")).toContain("arch 08 line 427");
  });
});
