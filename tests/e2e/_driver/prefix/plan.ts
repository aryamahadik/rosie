// What SKELETON_UPTO and CONTRACT_REPORT ask of a run, read in Node for a run that cannot read them itself (T-1149;
// C-148). The skeleton's end-to-end run goes through the Worker's composition root inside workerd (DL-332): its
// environment holds neither variable, and it has neither contracts/ nor the report on disk. So the e2e-workers project's
// global setup (./global-setup.ts) reads them here, as T-551's checkSkeletonRun reads them, and provides the plan to the
// run (Vitest's provide and inject), which judges it with judgePrefixRun:
//
//   - SKELETON_UPTO unset or empty: no prefix, so T-465's full check, and no report is read (T-551 default 5);
//   - a name that is no hop of 02-contracts section 11: refused, and the reason names it (prefixOf's error);
//   - CONTRACT_REPORT: the path, from the repository root, of the contract project's Vitest JSON report
//     (readContractReport). Unset or empty, no report is given, so each of the hop's contract tests is no pass
//     (noReport); a file that is not such a report is refused, naming it;
//   - hop n's contract tests: its section 11 row's contracts at v1, as their READMEs name them (contractTestOf), each with
//     how it fared in the report (contractTestResult).
//
// The plan is plain data (provide passes it as a structured clone). A refused plan fails the run that reads it, naming why.

import path from "node:path";

import { REPO_ROOT } from "../../../contract/_harness";
import {
  contractTestResult,
  readContractReport,
  type ContractReport,
  type ContractTestResult,
} from "./contract-report";
import { SKELETON_UPTO, skeletonUpto, type SkeletonPrefix } from "./prefix";
import { contractTestOf } from "./section-11";

/** The environment variable that names the hop's contract test report (CQ-78's default (b)). */
export const CONTRACT_REPORT = "CONTRACT_REPORT";

/** The name the plan is provided under (Vitest's provide and inject). */
export const SKELETON_PLAN = "skeletonPlan";

/** What SKELETON_UPTO and CONTRACT_REPORT ask of a run. */
export interface SkeletonPlan {
  /** SKELETON_UPTO as given, or null when it is unset or empty. */
  readonly upto: string | null;
  /** The prefix it names: null when it is unset (T-465's full check) or refused. */
  readonly prefix: SkeletonPrefix | null;
  /** Hop n's contract tests, each with how it fared in CONTRACT_REPORT's report; none without a prefix. */
  readonly contractTests: readonly ContractTestResult[];
  /** Why SKELETON_UPTO or CONTRACT_REPORT was refused, naming it; null when neither was. */
  readonly refused: string | null;
  /** What the prefix run must show, said when it fails; null without a prefix. */
  readonly hint: string | null;
}

declare module "vitest" {
  export interface ProvidedContext {
    skeletonPlan: SkeletonPlan;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/** What a prefix run must show: hops 1 to n, and the report that holds the hop's contract tests. */
function hintOf(
  prefix: SkeletonPrefix,
  tests: readonly ContractTestResult[],
  file: string | undefined,
): string {
  const given = isSet(file) ? `${CONTRACT_REPORT}=${file}` : `${CONTRACT_REPORT} is not set`;
  return `${SKELETON_UPTO}=${prefix.name}: hops ${prefix.hops.join(", ")} once each, in turn order, and hop ${prefix.hop}'s contract tests (${tests.map((test) => test.file).join(", ")}) passed in a Vitest JSON report (${given})`;
}

/**
 * The plan SKELETON_UPTO and CONTRACT_REPORT in `env` ask for (default: this process's environment). The report's path is
 * read from `repoRoot` (default: the repository root).
 */
export function skeletonPlanOf(env: Env = process.env, repoRoot: string = REPO_ROOT): SkeletonPlan {
  const given = env[SKELETON_UPTO];
  const upto = isSet(given) ? given : null;
  try {
    const prefix = skeletonUpto(env);
    if (prefix === null) return { upto: null, prefix: null, contractTests: [], refused: null, hint: null };
    const file = env[CONTRACT_REPORT];
    const contracts: ContractReport | null = isSet(file)
      ? readContractReport(path.resolve(repoRoot, file))
      : null;
    const contractTests = prefix.row.contracts.map((contract) =>
      contractTestResult(contractTestOf(contract), contracts),
    );
    return { upto, prefix, contractTests, refused: null, hint: hintOf(prefix, contractTests, file) };
  } catch (error) {
    return {
      upto,
      prefix: null,
      contractTests: [],
      refused: error instanceof Error ? error.message : String(error),
      hint: null,
    };
  }
}
