#!/usr/bin/env node
// npm run test:count (factory spec 3). ES module, so strict mode is on.
// Runs the Vitest projects that need no PostgreSQL (unit, workers, contract) with Vitest's JSON reporter and
// prints one line on stdout: {"tests": <n>, "skipped": <n>, "todo": <n>}. "tests" counts every test Vitest
// collected, skipped and todo ones included. Vitest's own output goes to stderr. A failing test is still counted
// (npm test reports failures); the exit code is non-zero only when Vitest gave no report.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECTS = ["unit", "workers", "contract"];
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rosie-test-count-"));
const reportFile = join(dir, "report.json");

try {
  const vitest = spawnSync(
    join(root, "node_modules", ".bin", "vitest"),
    [
      "run",
      ...PROJECTS.flatMap((project) => ["--project", project]),
      "--reporter=json",
      `--outputFile=${reportFile}`,
    ],
    { cwd: root, stdio: ["ignore", 2, 2] },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    console.error(`test:count: Vitest gave no report (exit code ${vitest.status ?? vitest.signal})`);
    process.exitCode = 1;
  }
  if (report !== undefined) {
    if (report.numFailedTests > 0 || report.numFailedTestSuites > 0) {
      console.error(
        `test:count: ${report.numFailedTests} failed test(s), counted anyway; npm test reports them`,
      );
    }
    console.log(
      `{"tests": ${report.numTotalTests}, "skipped": ${report.numPendingTests}, "todo": ${report.numTodoTests}}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
