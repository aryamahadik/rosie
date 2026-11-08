// The contract tests' result, as the caller gives it to the hop-prefix mode (T-551; C-148): Vitest's JSON report of the
// contract project, made by
//
//   npm run test:contract -- <file> --reporter=json --outputFile=<report.json>
//
// and passed as an object or read with readContractReport. A pass is never assumed (D-017: "Each hop's contract test is
// green before the next joins"): a contract test file passed only when the report holds it with status passed, it ran
// at least one test, and every test it ran passed. A skipped, todo or pending test is not a pass; a file the report does
// not hold, or no report at all, is no pass either.

import { readFileSync } from "node:fs";

import type { ContractTest } from "./section-11";

/** One test of a file, as Vitest's JSON report gives it (JsonAssertionResult): only its status is read. */
export interface ContractAssertion {
  /** "passed", "failed", "skipped", "pending", "todo" or "disabled". */
  readonly status: string;
}

/** One test file's result, as Vitest's JSON report gives it (JsonTestResult). */
export interface ContractFileResult {
  /** The file's path; Vitest writes it absolute. */
  readonly name: string;
  /** "passed" or "failed". */
  readonly status: string;
  readonly assertionResults: readonly ContractAssertion[];
}

/** The parts of Vitest's JSON report (JsonTestResults) the mode reads. */
export interface ContractReport {
  readonly testResults: readonly ContractFileResult[];
}

/** How one contract test file fared in the report. */
export type ContractTestOutcome = "passed" | "noReport" | "notInReport" | "failed" | "notAllPassed";

export interface ContractTestResult extends ContractTest {
  readonly outcome: ContractTestOutcome;
  /** The tests the report holds for the file, and how many of them passed. */
  readonly tests: number;
  readonly passed: number;
}

/** True when `name`, a path as the report writes it, is the repository file `file` ("tests/contract/<name>.test.ts"). */
function isFile(name: string, file: string): boolean {
  const posix = name.replace(/\\/g, "/");
  return posix === file || posix.endsWith(`/${file}`);
}

/** How `test` fared in `report`: passed only when every result the report holds for its file passed, each test too. */
export function contractTestResult(test: ContractTest, report: ContractReport | null): ContractTestResult {
  if (report === null) return { ...test, outcome: "noReport", tests: 0, passed: 0 };
  const results = report.testResults.filter((result) => isFile(result.name, test.file));
  const assertions = results.flatMap((result) => result.assertionResults);
  const tests = assertions.length;
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const failed =
    results.some((result) => result.status === "failed") ||
    assertions.some((assertion) => assertion.status === "failed");
  const allPassed = tests > 0 && passed === tests && results.every((result) => result.status === "passed");
  const outcome: ContractTestOutcome =
    results.length === 0 ? "notInReport" : failed ? "failed" : allPassed ? "passed" : "notAllPassed";
  return { ...test, outcome, tests, passed };
}

/** Why `value` is not Vitest's JSON report as the mode reads it, one line each; empty when it is. */
export function contractReportProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["it is not a JSON object"];
  const { testResults } = value as { testResults?: unknown };
  if (!Array.isArray(testResults)) return ["it has no testResults list"];
  const problems: string[] = [];
  testResults.forEach((result: unknown, index) => {
    const place = `testResults[${String(index)}]`;
    if (typeof result !== "object" || result === null) {
      problems.push(`${place} is not an object`);
      return;
    }
    const { name, status, assertionResults } = result as Record<string, unknown>;
    if (typeof name !== "string") problems.push(`${place} has no file name`);
    if (typeof status !== "string") problems.push(`${place} has no status`);
    if (
      !Array.isArray(assertionResults) ||
      !assertionResults.every(
        (assertion: unknown) =>
          typeof assertion === "object" &&
          assertion !== null &&
          typeof (assertion as { status?: unknown }).status === "string",
      )
    ) {
      problems.push(`${place} has no assertionResults list of tests, each with a status`);
    }
  });
  return problems;
}

/** Reads Vitest's JSON report from `file`; throws, naming the file, when it is not one. */
export function readContractReport(file: string): ContractReport {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`contract report ${file} cannot be read as JSON`, { cause: error });
  }
  const problems = contractReportProblems(value);
  if (problems.length > 0) {
    throw new Error(`contract report ${file} is not Vitest's JSON report: ${problems.join("; ")}`);
  }
  return value as ContractReport;
}
