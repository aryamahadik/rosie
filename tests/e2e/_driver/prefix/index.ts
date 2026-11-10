// The end-to-end driver's hop-prefix mode (T-551; C-148), on T-465's driver (../index.ts). A join task (T-552 to T-563)
// proves its own prefix of the walking skeleton:
//
//   const report = checkSkeletonRun(collected, { contracts: readContractReport(reportFile) });
//   expect(report.problems).toEqual([]);
//
// run as `SKELETON_UPTO=<hop> npm run test:e2e -- <tests>`, after the hop's contract test wrote its Vitest JSON report
// (`npm run test:contract -- <file> --reporter=json --outputFile=<reportFile>`). With SKELETON_UPTO unset the same call
// is T-465's checkRun.

export {
  contractReportProblems,
  contractTestResult,
  readContractReport,
  type ContractAssertion,
  type ContractFileResult,
  type ContractReport,
  type ContractTestOutcome,
  type ContractTestResult,
} from "./contract-report";
export {
  SKELETON_UPTO,
  SKELETON_UPTO_NAMES,
  checkPrefixRun,
  checkSkeletonRun,
  judgePrefixRun,
  prefixOf,
  prefixTrace,
  skeletonUpto,
  type PrefixReading,
  type PrefixRunReport,
  type SkeletonPrefix,
  type SkeletonRunOptions,
} from "./prefix";
export { CONTRACT_REPORT, SKELETON_PLAN, skeletonPlanOf, type SkeletonPlan } from "./plan";
export {
  SECTION_11_ROWS,
  contractTestOf,
  rowOfHop,
  type ContractId,
  type ContractTest,
  type Section11Row,
  type SkeletonHop,
} from "./section-11";
