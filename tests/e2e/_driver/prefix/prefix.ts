// The end-to-end driver's hop-prefix mode (T-551; C-148). D-017 joins the walking skeleton one hop at a time, in turn
// order, and each hop's contract test is green before the next joins (build prompt section 10). So each join task proves
// its own prefix:
//
//   SKELETON_UPTO=gateway npm run test:e2e -- skeleton
//
// SKELETON_UPTO names a hop of 02-contracts section 11 (section-11.ts): a skeleton hop by its K-08 v1 name
// (SKELETON_HOPS), or a row by the name its join task gives it, which stands for the row's last K-08 hop. The run is then
// judged on hops 1 to n, the skeleton's hops up to and including that one: each once, in turn order, by T-465's checkRun
// over the trace's spans up to the last span of a prefix hop. The spans after it are the hops not joined yet, still on
// their fakes (T-550), and are not judged; a hop that runs before the prefix ends and is not one of its hops is named.
// The hop's contract tests (its section 11 row's) must have passed in the contract report the caller gives.
//
// With SKELETON_UPTO unset (or empty), checkSkeletonRun is T-465's full check: it returns checkRun's report itself.
// A name that is no hop of section 11 is refused before anything is checked, and the error names it.

import type { Trace } from "../../../../contracts/generated/event-trace/event-trace.v1";
import { SKELETON_HOPS, checkRun, spansInOrder, type Collected, type RunReport } from "../index";
import { contractTestResult, type ContractReport, type ContractTestResult } from "./contract-report";
import { SECTION_11_ROWS, contractTestOf, rowOfHop, type Section11Row, type SkeletonHop } from "./section-11";

/** The environment variable that names the prefix. */
export const SKELETON_UPTO = "SKELETON_UPTO";

/** The prefix a name stands for: hops 1 to n of 02-contracts section 11. */
export interface SkeletonPrefix {
  /** The name given (SKELETON_UPTO's value). */
  readonly name: string;
  /** The prefix's last hop, by K-08's name: hop n. */
  readonly hop: SkeletonHop;
  /** The section 11 row hop n belongs to: its contracts are the ones checked. */
  readonly row: Section11Row;
  /** Hops 1 to n, in turn order: SKELETON_HOPS up to and including `hop`. */
  readonly hops: readonly SkeletonHop[];
}

function isSkeletonHop(name: string): name is SkeletonHop {
  return (SKELETON_HOPS as readonly string[]).includes(name);
}

/** The join names that are not K-08 hop names, in section 11's order. */
const JOIN_ONLY_NAMES = SECTION_11_ROWS.flatMap((row) =>
  row.join === null || isSkeletonHop(row.join) ? [] : [row.join],
);

/** Every name SKELETON_UPTO takes: the skeleton's hops by K-08's names, then the other join names. */
export const SKELETON_UPTO_NAMES: readonly string[] = [...SKELETON_HOPS, ...JOIN_ONLY_NAMES];

/** The K-08 hop a name stands for: the hop itself, or a join name's row's last hop; undefined for any other name. */
function hopNamed(name: string): SkeletonHop | undefined {
  if (isSkeletonHop(name)) return name;
  return SECTION_11_ROWS.find((row) => row.join === name)?.hops.at(-1);
}

/**
 * The prefix `name` stands for, or null when it is undefined or empty: no prefix, the full check. Throws, naming it,
 * when it is no hop of 02-contracts section 11 (spelled exactly: no case folding, no trimming).
 */
export function prefixOf(name: string | undefined): SkeletonPrefix | null {
  if (name === undefined || name === "") return null;
  const hop = hopNamed(name);
  if (hop === undefined) {
    throw new Error(
      `${SKELETON_UPTO}=${JSON.stringify(name)} names no hop of 02-contracts section 11: give a skeleton hop by its K-08 name (${SKELETON_HOPS.join(", ")}) or a join's name for its row (${JOIN_ONLY_NAMES.join(", ")})`,
    );
  }
  return { name, hop, row: rowOfHop(hop), hops: SKELETON_HOPS.slice(0, SKELETON_HOPS.indexOf(hop) + 1) };
}

/** The prefix SKELETON_UPTO names in `env` (default: this process's environment), or null when it is unset or empty. */
export function skeletonUpto(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SkeletonPrefix | null {
  return prefixOf(env[SKELETON_UPTO]);
}

/**
 * The part of `trace` a prefix judges: its spans in seq order up to and including the last span of one of `hops`, or
 * the whole trace when no span is one of them. The spans after it belong to the hops not joined yet.
 */
export function prefixTrace(trace: Trace, hops: readonly SkeletonHop[]): Trace {
  const spans = spansInOrder(trace);
  let last = -1;
  spans.forEach((span, index) => {
    if ((hops as readonly string[]).includes(span.hop)) last = index;
  });
  const [first, ...rest] = spans.slice(0, last + 1);
  return first === undefined ? trace : { ...trace, spans: [first, ...rest] };
}

/** What a prefix run read, beside T-465's report. */
export interface PrefixReading {
  readonly name: string;
  readonly hop: SkeletonHop;
  /** Hop n's place in 02-contracts section 11. */
  readonly row: number;
  readonly hops: readonly SkeletonHop[];
  /** The spans after the prefix's last hop, which the prefix does not judge. */
  readonly spansAfter: number;
  /** Hop n's contract tests (its row's contracts, at v1) and how each fared in the report. */
  readonly contractTests: readonly ContractTestResult[];
}

export interface PrefixRunReport extends RunReport {
  readonly prefix: PrefixReading;
}

/** How a problem names the prefix's hop: by its K-08 name, and by the name given when that differs. */
function hopLabel(prefix: SkeletonPrefix): string {
  return prefix.name === prefix.hop ? `hop ${prefix.hop}` : `hop ${prefix.hop} (${prefix.name})`;
}

/** The problem line for a contract test that is not shown to pass, naming the hop; null when it passed. */
function contractProblem(prefix: SkeletonPrefix, result: ContractTestResult): string | null {
  const test = `contract test ${result.file} (${result.contract})`;
  const counts = `${String(result.passed)} of ${String(result.tests)} tests passed`;
  switch (result.outcome) {
    case "passed":
      return null;
    case "noReport":
      return `${hopLabel(prefix)}: no contract test report was given, so its ${test} is not shown to pass: each hop's contract test passes before it joins`;
    case "notInReport":
      return `${hopLabel(prefix)}: its ${test} is not in the contract test report: each hop's contract test passes before it joins`;
    case "failed":
      return `${hopLabel(prefix)}: its ${test} failed (${counts}): each hop's contract test passes before it joins`;
    case "notAllPassed":
      return `${hopLabel(prefix)}: its ${test} did not pass every test (${counts}; a skipped, todo or pending test is no pass): each hop's contract test passes before it joins`;
  }
}

/**
 * Judges `collected` on the prefix: T-465's checkRun with hops 1 to n over the trace's spans up to the prefix's last
 * hop (prefixTrace), then hop n's contract tests in `contracts`, Vitest's JSON report of the contract project (null when
 * the caller gave none, which is no pass). Every problem names its hop.
 */
export function checkPrefixRun(
  collected: Collected,
  prefix: SkeletonPrefix,
  contracts: ContractReport | null,
): PrefixRunReport {
  const contractTests = prefix.row.contracts.map((contract) =>
    contractTestResult(contractTestOf(contract), contracts),
  );
  return judgePrefixRun(collected, prefix, contractTests);
}

/**
 * checkPrefixRun with hop n's contract tests already read (each contract's v1 test and how it fared in the report): what
 * a run that cannot read contracts/ or the report itself is judged with, such as the skeleton's run inside workerd, whose
 * results were read in Node (T-1149, ./plan.ts). The tests must be hop n's row's, one per contract, in the row's order.
 */
export function judgePrefixRun(
  collected: Collected,
  prefix: SkeletonPrefix,
  contractTests: readonly ContractTestResult[],
): PrefixRunReport {
  const named = contractTests.map((result) => result.contract);
  if (named.length !== prefix.row.contracts.length || named.some((id, i) => id !== prefix.row.contracts[i])) {
    throw new Error(
      `${hopLabel(prefix)}: the contract tests given are ${named.join(", ") || "none"}, where its row's are ${prefix.row.contracts.join(", ")}`,
    );
  }
  const trace = collected.trace === null ? null : prefixTrace(collected.trace, prefix.hops);
  const report = checkRun({ ...collected, trace }, prefix.hops);
  const contractProblems = contractTests.flatMap((result) => contractProblem(prefix, result) ?? []);
  return {
    ...report,
    problems: [...report.problems, ...contractProblems],
    prefix: {
      name: prefix.name,
      hop: prefix.hop,
      row: prefix.row.row,
      hops: prefix.hops,
      spansAfter: (collected.trace?.spans.length ?? 0) - (trace?.spans.length ?? 0),
      contractTests: [...contractTests],
    },
  };
}

export interface SkeletonRunOptions {
  /** Where SKELETON_UPTO is read. Default: this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Vitest's JSON report of the contract project (readContractReport); read only under a prefix. Default: none. */
  readonly contracts?: ContractReport | null;
}

/**
 * The skeleton's check as SKELETON_UPTO asks: unset or empty, T-465's full check (checkRun's report itself, no contract
 * report read); set, the prefix it names (checkPrefixRun). Throws, naming it, when it names no hop of section 11.
 */
export function checkSkeletonRun(
  collected: Collected,
  options: SkeletonRunOptions = {},
): RunReport | PrefixRunReport {
  const prefix = skeletonUpto(options.env);
  return prefix === null ? checkRun(collected) : checkPrefixRun(collected, prefix, options.contracts ?? null);
}
