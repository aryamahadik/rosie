// The hop-prefix mode under the run's own SKELETON_UPTO (T-551, "Proves it with"):
//
//   SKELETON_UPTO=gateway npm run test:e2e -- _driver/prefix
//
// passes trace-skeleton.json cut after the hop it names, and fails, naming the hop, on a copy with a hop of the prefix
// repeated or missing (a later one too, when the prefix has more than one hop), or with the hop's contract test not shown
// to pass. A name that is no hop of 02-contracts section 11 fails this file as it loads, with an error that names it.
// With SKELETON_UPTO unset (as in `npm run test:e2e`), the same checks run as T-465's full check over every hop.
// prefix.test.ts proves each case for every name SKELETON_UPTO takes.

import { describe, expect, it } from "vitest";

import { SKELETON_HOPS, checkRun } from "../index";
import { checkSkeletonRun, contractTestOf, skeletonUpto } from "./index";
import {
  collectedOf,
  contractFilesOf,
  contractReport,
  cutAfter,
  passedFor,
  skeleton,
  withHopRepeated,
  withoutHop,
} from "./test-support";

/** The prefix this run's SKELETON_UPTO names, read as the driver reads it; null when it is unset. */
const prefix = skeletonUpto();
/** The hops judged: the prefix's, or every skeleton hop under the full check. */
const hops = prefix?.hops ?? SKELETON_HOPS;
/** The trace the run judges: trace-skeleton.json cut after the prefix's last hop, or whole. */
const trace = prefix === null ? skeleton : cutAfter(skeleton, prefix.hop);
/** A contract report in which the hop's contract tests passed; the full check reads none. */
const contracts = prefix === null ? null : passedFor(prefix);

describe(`the run's own SKELETON_UPTO (${prefix === null ? "unset: T-465's full check" : `SKELETON_UPTO=${prefix.name}, hops ${hops.join(", ")}`})`, () => {
  it("passes trace-skeleton.json cut after the hop it names (whole, when unset)", () => {
    const run = collectedOf(trace);
    const report = checkSkeletonRun(run, { contracts });
    expect(report.problems).toEqual([]);
    expect(report.hops?.hops).toEqual([...hops]);
    if (prefix === null) expect(report).toStrictEqual(checkRun(run));
  });

  it("fails a copy with a hop of the prefix repeated, naming that hop, for each of its hops", () => {
    hops.forEach((hop, index) => {
      expect(checkSkeletonRun(collectedOf(withHopRepeated(trace, hop)), { contracts }).problems).toEqual([
        `hop ${hop} runs 2 times (seq ${String(index + 1)}, ${String(index + 2)}): every hop runs once`,
      ]);
    });
  });

  it("fails a copy with a hop of the prefix missing, naming that hop, for each of its hops", () => {
    hops.forEach((hop) => {
      const problems = checkSkeletonRun(collectedOf(withoutHop(skeleton, hop)), { contracts }).problems;
      expect(problems[0]).toBe(`hop ${hop} is missing: every hop runs once`);
      // While another hop of the prefix is there, its last span ends what is judged, and nothing else is named. A
      // one-hop prefix without its hop has none: the hops in the trace are then named too (prefix.test.ts).
      if (hops.length > 1) expect(problems).toEqual([`hop ${hop} is missing: every hop runs once`]);
    });
  });

  it("fails, naming the hop, when the hop's contract test is not shown to pass (the full check reads none)", () => {
    const run = collectedOf(trace);
    const none = checkSkeletonRun(run, { contracts: null }).problems;
    if (prefix === null) {
      expect(none).toEqual([]);
      expect(checkSkeletonRun(run, { contracts: contractReport([], ["failed"]) }).problems).toEqual([]);
      return;
    }
    const label = prefix.name === prefix.hop ? `hop ${prefix.hop}` : `hop ${prefix.hop} (${prefix.name})`;
    const why = "each hop's contract test passes before it joins";
    const tests = prefix.row.contracts.map(
      (contract) => `contract test ${contractTestOf(contract).file} (${contract})`,
    );
    const failed = checkSkeletonRun(run, {
      contracts: contractReport(contractFilesOf(prefix), ["passed", "failed"]),
    });
    expect(none).toEqual(
      tests.map(
        (test) => `${label}: no contract test report was given, so its ${test} is not shown to pass: ${why}`,
      ),
    );
    expect(failed.problems).toEqual(
      tests.map((test) => `${label}: its ${test} failed (1 of 2 tests passed): ${why}`),
    );
  });
});
