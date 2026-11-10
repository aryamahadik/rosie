// The plan a run inside workerd is given (T-1149, ./plan.ts): SKELETON_UPTO and CONTRACT_REPORT read in Node, as T-551's
// checkSkeletonRun reads them, and judged with judgePrefixRun. Unset, no prefix and no report read; a name that is no hop
// of 02-contracts section 11, or a file that is not Vitest's JSON report, refused and named; otherwise the prefix and its
// row's contract tests with how each fared, which judgePrefixRun turns into exactly checkPrefixRun's report. The plan
// survives the structured clone Vitest's provide passes it as. Run by `npm run test:e2e -- _driver/prefix`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../../contract/_harness";
import {
  CONTRACT_REPORT,
  SKELETON_PLAN,
  SKELETON_UPTO,
  SKELETON_UPTO_NAMES,
  checkPrefixRun,
  contractTestOf,
  judgePrefixRun,
  prefixOf,
  skeletonPlanOf,
  type SkeletonPrefix,
} from "./index";
import {
  collectedOf,
  contractFilesOf,
  contractReport,
  cutAfter,
  passedFor,
  skeleton,
  withoutHop,
} from "./test-support";

function prefix(name: string): SkeletonPrefix {
  const found = prefixOf(name);
  if (found === null) throw new Error(`"${name}" names no prefix`);
  return found;
}

/** A folder for this file's reports, removed when it ends. */
const folder = mkdtempSync(path.join(tmpdir(), "rosie-plan-"));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** Writes `value` as JSON to `name` in this file's folder; answers the name. */
function written(name: string, value: unknown): string {
  writeFileSync(path.join(folder, name), JSON.stringify(value));
  return name;
}

describe("the plan read in Node for the run inside workerd", () => {
  it("is provided under skeletonPlan, and reads the variables T-551 reads", () => {
    expect([SKELETON_PLAN, SKELETON_UPTO, CONTRACT_REPORT]).toEqual([
      "skeletonPlan",
      "SKELETON_UPTO",
      "CONTRACT_REPORT",
    ]);
  });

  it("with SKELETON_UPTO unset or empty: no prefix, T-465's full check, and no report read", () => {
    const none = { upto: null, prefix: null, contractTests: [], refused: null, hint: null };
    expect(skeletonPlanOf({})).toEqual(none);
    expect(skeletonPlanOf({ [SKELETON_UPTO]: "" })).toEqual(none);
    // A report that is not there is not read either.
    expect(skeletonPlanOf({ [CONTRACT_REPORT]: "no-such-report.json" }, folder)).toEqual(none);
  });

  it("refuses a name that is no hop of 02-contracts section 11, naming it as prefixOf does", () => {
    let thrown = "";
    try {
      prefixOf("gatway");
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toContain('"gatway"');
    expect(skeletonPlanOf({ [SKELETON_UPTO]: "gatway" })).toEqual({
      upto: "gatway",
      prefix: null,
      contractTests: [],
      refused: thrown,
      hint: null,
    });
  });

  it.each(SKELETON_UPTO_NAMES)(
    "SKELETON_UPTO=%s with no CONTRACT_REPORT: its prefix, and each of its row's contract tests no pass, named in the hint",
    (name) => {
      const plan = skeletonPlanOf({ [SKELETON_UPTO]: name });
      const expected = prefix(name);
      expect(plan.refused).toBeNull();
      expect(plan.upto).toBe(name);
      expect(plan.prefix).toEqual(expected);
      expect(plan.contractTests).toEqual(
        expected.row.contracts.map((contract) => ({
          ...contractTestOf(contract),
          outcome: "noReport",
          tests: 0,
          passed: 0,
        })),
      );
      expect(plan.hint).toBe(
        `${SKELETON_UPTO}=${name}: hops ${expected.hops.join(", ")} once each, in turn order, and hop ${expected.hop}'s contract tests (${contractFilesOf(expected).join(", ")}) passed in a Vitest JSON report (${CONTRACT_REPORT} is not set)`,
      );
      expect(structuredClone(plan)).toEqual(plan);
    },
  );

  it("reads CONTRACT_REPORT from the repository root, and gives each contract test as the report holds it", () => {
    const guard = prefix("guard");
    const [first, ...others] = contractFilesOf(guard);
    if (first === undefined) throw new Error("the guard's row names no contract");
    const name = written("guard-report.json", contractReport([first]));
    const plan = skeletonPlanOf({ [SKELETON_UPTO]: "guard", [CONTRACT_REPORT]: name }, folder);
    expect(plan.refused).toBeNull();
    expect(plan.contractTests.map((test) => [test.file, test.outcome])).toEqual([
      [first, "passed"],
      ...others.map((file) => [file, "notInReport"]),
    ]);
    expect(plan.hint).toContain(`(${CONTRACT_REPORT}=${name})`);
    // A whole path is read as it is.
    const whole = skeletonPlanOf({ [SKELETON_UPTO]: "guard", [CONTRACT_REPORT]: path.join(folder, name) });
    expect(whole.contractTests).toEqual(plan.contractTests);
    // By default a relative path is read from the repository root, where this report is not.
    expect(skeletonPlanOf({ [SKELETON_UPTO]: "guard", [CONTRACT_REPORT]: name }).refused).toContain(
      path.join(REPO_ROOT, name),
    );
  });

  it("refuses a CONTRACT_REPORT that is not Vitest's JSON report, naming the file", () => {
    const name = written("not-a-report.json", { results: [] });
    const plan = skeletonPlanOf({ [SKELETON_UPTO]: "receive", [CONTRACT_REPORT]: name }, folder);
    expect(plan).toMatchObject({ upto: "receive", prefix: null, contractTests: [], hint: null });
    expect(plan.refused).toContain(path.join(folder, name));
    expect(plan.refused).toContain("is not Vitest's JSON report");
  });
});

describe("judgePrefixRun, with the plan's contract tests", () => {
  it.each(SKELETON_UPTO_NAMES)(
    "SKELETON_UPTO=%s: gives checkPrefixRun's own report, on a passing run and on one with a hop missing",
    (name) => {
      const expected = prefix(name);
      const report = passedFor(expected);
      const file = written(`${name}-report.json`, report);
      const plan = skeletonPlanOf({ [SKELETON_UPTO]: name, [CONTRACT_REPORT]: file }, folder);
      const passing = collectedOf(cutAfter(skeleton, expected.hop));
      const failing = collectedOf(withoutHop(skeleton, expected.hop));
      expect(judgePrefixRun(passing, expected, plan.contractTests)).toStrictEqual(
        checkPrefixRun(passing, expected, report),
      );
      expect(judgePrefixRun(passing, expected, plan.contractTests).problems).toEqual([]);
      expect(judgePrefixRun(failing, expected, plan.contractTests)).toStrictEqual(
        checkPrefixRun(failing, expected, report),
      );
      expect(judgePrefixRun(failing, expected, plan.contractTests).problems).not.toEqual([]);
    },
  );

  it("refuses contract tests that are not the prefix's row's, naming them", () => {
    const guard = prefix("guard");
    const receive = skeletonPlanOf({ [SKELETON_UPTO]: "receive" });
    expect(() => judgePrefixRun(collectedOf(skeleton), guard, receive.contractTests)).toThrow(
      "hop guard: the contract tests given are K-11, where its row's are K-01, K-04",
    );
    expect(() => judgePrefixRun(collectedOf(skeleton), guard, [])).toThrow(
      "hop guard: the contract tests given are none, where its row's are K-01, K-04",
    );
  });
});
