// The contract tests' result as the hop-prefix mode reads it (T-551, "the hop's contract test file passed"): Vitest's JSON
// report of the contract project, given by the caller. A file passes only when the report holds it, its status is passed
// and every one of its tests (at least one) passed; no report, a file the report lacks, a failure, or a skipped, todo or
// pending test is no pass. Run by `npm run test:e2e -- _driver/prefix`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, expectTypeOf, it } from "vitest";
import type { JsonTestResults } from "vitest/node";

import { REPO_ROOT } from "../../../contract/_harness";
import {
  contractReportProblems,
  contractTestOf,
  contractTestResult,
  readContractReport,
  type ContractReport,
} from "./index";
import { contractReport } from "./test-support";

const linq = contractTestOf("K-11");
const LINQ_FILE = "tests/contract/port-linq.v1.test.ts";

/** One test of a file as Vitest's JSON reporter writes it (JsonAssertionResult). */
function assertion(title: string, status: string): Record<string, unknown> {
  return {
    ancestorTitles: ["port-linq fixtures"],
    fullName: `port-linq fixtures ${title}`,
    status,
    title,
    duration: 0.2,
    failureMessages: [],
    meta: {},
    tags: [],
    benchmarks: [],
  };
}

/** A report as `npm run test:contract -- port-linq.v1 --reporter=json --outputFile=<file>` writes it. */
const written = {
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  snapshot: { added: 0, failure: false, filesAdded: 0, matched: 0, total: 0, unmatched: 0, updated: 0 },
  startTime: 1794122108308,
  success: true,
  testResults: [
    {
      assertionResults: [
        assertion("accepts verify-ok.json", "passed"),
        assertion("accepts send-text.json", "passed"),
      ],
      startTime: 1794122108626,
      endTime: 1794122108770.1443,
      status: "passed",
      message: "",
      name: path.join(REPO_ROOT, LINQ_FILE),
    },
  ],
};

const scratch = mkdtempSync(path.join(tmpdir(), "rosie-t551-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fileWith(name: string, text: string): string {
  const file = path.join(scratch, name);
  writeFileSync(file, text);
  return file;
}

describe("Vitest's JSON report of the contract project", () => {
  it("is every report Vitest writes: its own report type is one the mode reads", () => {
    expectTypeOf<JsonTestResults>().toExtend<ContractReport>();
    expect(linq.file).toBe(LINQ_FILE);
  });

  it("is read from the file `--reporter=json --outputFile` wrote", () => {
    const report = readContractReport(fileWith("report.json", JSON.stringify(written)));
    expect(contractTestResult(linq, report)).toEqual({ ...linq, outcome: "passed", tests: 2, passed: 2 });
  });

  it("is refused, naming the file, when the file is not JSON", () => {
    const file = fileWith("not-json.json", "JSON report written to somewhere");
    expect(() => readContractReport(file)).toThrow(`contract report ${file} cannot be read as JSON`);
  });

  it("is refused, naming the file and what is wrong, when the JSON is not such a report", () => {
    const file = fileWith("not-report.json", JSON.stringify({ success: true }));
    expect(() => readContractReport(file)).toThrow(
      `contract report ${file} is not Vitest's JSON report: it has no testResults list`,
    );
    expect(contractReportProblems([])).toEqual(["it is not a JSON object"]);
    expect(
      contractReportProblems({
        testResults: [7, { name: 1, status: "passed", assertionResults: [{ title: "no status" }] }],
      }),
    ).toEqual([
      "testResults[0] is not an object",
      "testResults[1] has no file name",
      "testResults[1] has no assertionResults list of tests, each with a status",
    ]);
    expect(contractReportProblems(written)).toEqual([]);
  });
});

describe("a contract test file's result", () => {
  it("is a pass when the report holds the file, passed, with every test passed", () => {
    const report = contractReport([LINQ_FILE], ["passed", "passed", "passed"]);
    expect(contractTestResult(linq, report)).toEqual({ ...linq, outcome: "passed", tests: 3, passed: 3 });
  });

  it("is no pass without a report", () => {
    expect(contractTestResult(linq, null)).toEqual({ ...linq, outcome: "noReport", tests: 0, passed: 0 });
  });

  it("is no pass when the report holds other files only, near names included", () => {
    const report: ContractReport = {
      testResults: [
        ...contractReport([
          "tests/contract/inbound-event.v1.test.ts",
          "tests/contract/port-linq.v1.1.test.ts",
        ]).testResults,
        {
          name: path.join(REPO_ROOT, "x" + LINQ_FILE),
          status: "passed",
          assertionResults: [{ status: "passed" }],
        },
      ],
    };
    expect(contractTestResult(linq, report)).toEqual({
      ...linq,
      outcome: "notInReport",
      tests: 0,
      passed: 0,
    });
  });

  it("finds the file under a Windows path or a repository path too", () => {
    const tests = [{ status: "passed" }];
    for (const name of [`C:\\rosie\\${LINQ_FILE.replace(/\//g, "\\")}`, LINQ_FILE]) {
      const report: ContractReport = { testResults: [{ name, status: "passed", assertionResults: tests }] };
      expect(contractTestResult(linq, report).outcome).toBe("passed");
    }
  });

  it("is a failure when a test failed, or the file failed with no test run (it did not load)", () => {
    expect(contractTestResult(linq, contractReport([LINQ_FILE], ["passed", "failed"]))).toEqual({
      ...linq,
      outcome: "failed",
      tests: 2,
      passed: 1,
    });
    const notLoaded: ContractReport = {
      testResults: [{ name: LINQ_FILE, status: "failed", assertionResults: [] }],
    };
    expect(contractTestResult(linq, notLoaded)).toEqual({ ...linq, outcome: "failed", tests: 0, passed: 0 });
  });

  it("is a failure when the file failed in any one of the results that hold it (two projects)", () => {
    const report: ContractReport = {
      testResults: [
        ...contractReport([LINQ_FILE]).testResults,
        ...contractReport([LINQ_FILE], ["failed"]).testResults,
      ],
    };
    expect(contractTestResult(linq, report)).toEqual({ ...linq, outcome: "failed", tests: 2, passed: 1 });
  });

  it.each(["skipped", "todo", "pending", "disabled"])("is no pass when a test is %s", (status) => {
    expect(contractTestResult(linq, contractReport([LINQ_FILE], ["passed", status]))).toEqual({
      ...linq,
      outcome: "notAllPassed",
      tests: 2,
      passed: 1,
    });
  });

  it("is no pass when the file ran no test", () => {
    expect(contractTestResult(linq, contractReport([LINQ_FILE], []))).toEqual({
      ...linq,
      outcome: "notAllPassed",
      tests: 0,
      passed: 0,
    });
  });
});
