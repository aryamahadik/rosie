// The hop-prefix mode (T-551, "Proves it with") on K-08 v1's trace-skeleton.json and copies cut or damaged from it, with
// the hop name as the test's parameter, so `npm run test:e2e -- _driver/prefix` proves every case for every name
// SKELETON_UPTO takes:
//   - a trace cut after the prefix's last hop passes, and so does the whole trace (the hops after it are not joined yet);
//   - a hop of the prefix missing (a later one included) or repeated fails, naming that hop; so does a hop after the
//     prefix that runs before the prefix ends;
//   - the hop's contract test not shown to pass in the caller's report fails, naming the hop;
//   - a name that is no hop of 02-contracts section 11 is refused, named;
//   - with SKELETON_UPTO unset the mode is T-465's full check: checkRun's report itself, on a passing and a failing run.
// skeleton-upto.test.ts checks the hop the run's own SKELETON_UPTO names (`SKELETON_UPTO=gateway npm run test:e2e --
// _driver/prefix`).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Trace } from "../../../../contracts/generated/event-trace/event-trace.v1";
import { CONTRACTS_ROOT } from "../../../contract/_harness";
import {
  RecordingLinqDouble,
  SKELETON_HOPS,
  checkOutboxRows,
  checkRun,
  partsOf,
  type Collected,
} from "../index";
import {
  SECTION_11_ROWS,
  SKELETON_UPTO_NAMES,
  checkPrefixRun,
  checkSkeletonRun,
  prefixOf,
  prefixTrace,
  skeletonUpto,
  type SkeletonPrefix,
} from "./index";
import {
  collectedOf,
  contractFilesOf,
  contractReport,
  cutAfter,
  passedFor,
  skeleton,
  withHopRepeated,
  withHopsSwapped,
  withSpans,
  withoutHop,
} from "./test-support";

function prefix(name: string): SkeletonPrefix {
  const found = prefixOf(name);
  if (found === null) throw new Error(`"${name}" names no prefix`);
  return found;
}

/** Every name SKELETON_UPTO takes, with each hop of its prefix. */
const NAME_AND_HOP = SKELETON_UPTO_NAMES.flatMap((name) =>
  prefix(name).hops.map((hop) => [name, hop] as const),
);

describe("SKELETON_UPTO's names", () => {
  it.each(SKELETON_HOPS)("takes skeleton hop %s by its K-08 name: hops 1 to n end at it", (hop) => {
    const found = prefix(hop);
    expect(found.hop).toBe(hop);
    expect(found.hops).toEqual(SKELETON_HOPS.slice(0, SKELETON_HOPS.indexOf(hop) + 1));
    expect(found.row.hops).toContain(hop);
  });

  const joins = SECTION_11_ROWS.flatMap((row) => (row.join === null ? [] : [[row.join, row.row] as const]));

  it.each(joins)(
    "takes join name %s for section 11 row %i: hops 1 to n end at the row's last hop",
    (join, row) => {
      const found = prefix(join);
      expect(found.row).toBe(SECTION_11_ROWS[row - 1]);
      expect(found.hop).toBe(found.row.hops.at(-1));
      expect(found.hops).toEqual(SKELETON_HOPS.slice(0, SKELETON_HOPS.indexOf(found.hop) + 1));
    },
  );

  it("takes gateway, the card's own example, for section 11's first hop: the webhook in, K-08's receive", () => {
    const gateway = prefix("gateway");
    expect([gateway.hop, gateway.hops, gateway.row.row, gateway.row.words]).toEqual([
      "receive",
      ["receive"],
      1,
      "Webhook in, signature checked",
    ]);
  });

  it("lists the names it takes: the K-08 hop names, then the join names that are not one", () => {
    expect(SKELETON_UPTO_NAMES).toEqual([
      ...SKELETON_HOPS,
      "gateway",
      "actor-inbox",
      "safety-read",
      "decide",
      "finalize",
      "send",
    ]);
  });

  it.each([
    "gatway",
    "Gateway",
    "gateway ",
    " gateway",
    "portCall",
    "reread",
    "rewriteOrFallback",
    "clockFired",
    "Webhook in, signature checked",
    "All under one trace id",
    "skeleton",
    "1",
  ])("refuses %j, naming it, before anything is checked", (name) => {
    const refusal = `SKELETON_UPTO=${JSON.stringify(name)} names no hop of 02-contracts section 11: give a skeleton hop by its K-08 name (${SKELETON_HOPS.join(", ")}) or a join's name for its row (gateway, actor-inbox, safety-read, decide, finalize, send)`;
    expect(() => prefixOf(name)).toThrow(refusal);
    expect(() => skeletonUpto({ SKELETON_UPTO: name })).toThrow(refusal);
    expect(() => checkSkeletonRun(collectedOf(skeleton), { env: { SKELETON_UPTO: name } })).toThrow(refusal);
  });

  it("reads no prefix when SKELETON_UPTO is unset or empty: the full check", () => {
    expect(prefixOf(undefined)).toBeNull();
    expect(skeletonUpto({})).toBeNull();
    expect(skeletonUpto({ SKELETON_UPTO: "" })).toBeNull();
    expect(skeletonUpto({ OTHER: "gateway" })).toBeNull();
  });
});

describe("the prefix up to a hop, on trace-skeleton.json", () => {
  it.each(SKELETON_UPTO_NAMES)(
    "SKELETON_UPTO=%s passes the trace cut after the prefix's last hop",
    (name) => {
      const found = prefix(name);
      const report = checkPrefixRun(collectedOf(cutAfter(skeleton, found.hop)), found, passedFor(found));
      expect(report.problems).toEqual([]);
      expect(report.hops?.hops).toEqual(found.hops);
      expect(report.prefix).toMatchObject({ name, hop: found.hop, row: found.row.row, spansAfter: 0 });
      expect(report.prefix.contractTests.map((test) => [test.file, test.outcome])).toEqual(
        contractFilesOf(found).map((file) => [file, "passed"]),
      );
    },
  );

  it.each(SKELETON_UPTO_NAMES)(
    "SKELETON_UPTO=%s passes the whole trace too: the hops after the prefix are not judged",
    (name) => {
      const found = prefix(name);
      const report = checkPrefixRun(collectedOf(skeleton), found, passedFor(found));
      expect(report.problems).toEqual([]);
      expect(report.hops?.hops).toEqual(found.hops);
      expect(report.prefix.spansAfter).toBe(SKELETON_HOPS.length - found.hops.length);
    },
  );

  const missing = NAME_AND_HOP.filter(([name]) => prefix(name).hops.length > 1);

  it.each(missing)(
    "SKELETON_UPTO=%s fails the trace cut after the prefix without hop %s, naming that hop",
    (name, hop) => {
      const found = prefix(name);
      const copy = withoutHop(cutAfter(skeleton, found.hop), hop);
      expect(checkPrefixRun(collectedOf(copy), found, passedFor(found)).problems).toEqual([
        `hop ${hop} is missing: every hop runs once`,
      ]);
      expect(
        checkPrefixRun(collectedOf(withoutHop(skeleton, hop)), found, passedFor(found)).problems,
      ).toEqual([`hop ${hop} is missing: every hop runs once`]);
    },
  );

  it.each(NAME_AND_HOP)(
    "SKELETON_UPTO=%s fails the trace cut after the prefix with hop %s repeated, naming that hop",
    (name, hop) => {
      const found = prefix(name);
      const seq = found.hops.indexOf(hop) + 1;
      const repeated = `hop ${hop} runs 2 times (seq ${String(seq)}, ${String(seq + 1)}): every hop runs once`;
      const copy = withHopRepeated(cutAfter(skeleton, found.hop), hop);
      expect(checkPrefixRun(collectedOf(copy), found, passedFor(found)).problems).toEqual([repeated]);
      const whole = withHopRepeated(skeleton, hop);
      expect(checkPrefixRun(collectedOf(whole), found, passedFor(found)).problems).toEqual([repeated]);
    },
  );

  const early = SKELETON_UPTO_NAMES.flatMap((name) => {
    const found = prefix(name);
    const next = SKELETON_HOPS[found.hops.length];
    return next === undefined ? [] : [[name, next] as const];
  });

  it.each(early)(
    "SKELETON_UPTO=%s fails a trace in which the next hop, %s, runs before the prefix's last hop, naming it",
    (name, next) => {
      const found = prefix(name);
      const copy = withHopsSwapped(skeleton, found.hop, next);
      expect(checkPrefixRun(collectedOf(copy), found, passedFor(found)).problems).toEqual([
        `hop ${next} (seq ${String(found.hops.length)}) is not one of this trace's hops`,
      ]);
    },
  );

  it("SKELETON_UPTO=gateway names receive missing when the trace holds no hop of the prefix, and each hop it holds", () => {
    const found = prefix("gateway");
    const copy = withoutHop(skeleton, "receive");
    expect(prefixTrace(copy, found.hops)).toBe(copy);
    expect(checkPrefixRun(collectedOf(copy), found, passedFor(found)).problems).toEqual([
      "hop receive is missing: every hop runs once",
      ...SKELETON_HOPS.slice(1).map(
        (hop, index) => `hop ${hop} (seq ${String(index + 1)}) is not one of this trace's hops`,
      ),
    ]);
  });

  it("judges the spans up to the prefix's last hop, in seq order, whatever order the trace lists them in", () => {
    const found = prefix("guard");
    const [last, ...before] = [...skeleton.spans].reverse();
    if (last === undefined) throw new Error("trace-skeleton.json has 16 spans");
    const shuffled: Trace = { ...skeleton, spans: [last, ...before] };
    expect(prefixTrace(shuffled, found.hops).spans.map((span) => span.hop)).toEqual(found.hops);
    expect(checkPrefixRun(collectedOf(shuffled), found, passedFor(found)).problems).toEqual([]);
  });

  it("checks every span it judges under one trace id and bundle id, with time running on", () => {
    const found = prefix("frontier");
    const copy = withSpans(
      skeleton,
      skeleton.spans.map((span) => {
        if (span.hop === "scrub") return { ...span, trace_id: "trace-other-0001" };
        if (span.hop === "guard") return { ...span, bundle_id: { hash: "a".repeat(64), build: 2 } };
        if (span.hop === "frontier") return { ...span, at: "2026-10-19T14:01:50Z" };
        if (span.hop === "compose") return { ...span, trace_id: "trace-other-0002" };
        return span;
      }),
    );
    expect(
      checkPrefixRun(collectedOf(copy), found, passedFor(found)).hops?.problems.map((problem) => [
        problem.kind,
        problem.hop,
      ]),
    ).toEqual([
      ["traceId", "scrub"],
      ["bundleId", "guard"],
      ["time", "frontier"],
    ]);
  });

  it("passes on T-465's trace problems, and judges no hop when no trace was read", () => {
    const found = prefix("gateway");
    const run = collectedOf(null, {
      traceId: "trace-none-0001",
      traceProblems: ["no span carries trace id trace-none-0001"],
    });
    const report = checkPrefixRun(run, found, passedFor(found));
    expect(report.hops).toBeNull();
    expect(report.problems).toEqual(["no span carries trace id trace-none-0001"]);
    expect(report.prefix.spansAfter).toBe(0);
  });
});

describe("the hop's contract test under a prefix", () => {
  const gateway = prefix("gateway");
  const cut = collectedOf(cutAfter(skeleton, "receive"));
  const linq = "contract test tests/contract/port-linq.v1.test.ts (K-11)";
  const why = "each hop's contract test passes before it joins";

  it("fails SKELETON_UPTO=gateway, naming hop receive, when no contract test report was given", () => {
    expect(checkPrefixRun(cut, gateway, null).problems).toEqual([
      `hop receive (gateway): no contract test report was given, so its ${linq} is not shown to pass: ${why}`,
    ]);
    expect(checkSkeletonRun(cut, { env: { SKELETON_UPTO: "gateway" } }).problems).toEqual(
      checkPrefixRun(cut, gateway, null).problems,
    );
  });

  it("fails SKELETON_UPTO=gateway, naming hop receive, when the report does not hold K-11's test", () => {
    const report = contractReport(["tests/contract/inbound-event.v1.test.ts"]);
    expect(checkPrefixRun(cut, gateway, report).problems).toEqual([
      `hop receive (gateway): its ${linq} is not in the contract test report: ${why}`,
    ]);
  });

  it("fails SKELETON_UPTO=gateway, naming hop receive, when K-11's test failed", () => {
    const report = contractReport(["tests/contract/port-linq.v1.test.ts"], ["passed", "failed", "passed"]);
    expect(checkPrefixRun(cut, gateway, report).problems).toEqual([
      `hop receive (gateway): its ${linq} failed (2 of 3 tests passed): ${why}`,
    ]);
  });

  it("fails SKELETON_UPTO=receive, naming the hop, when a test of K-11's was skipped", () => {
    const report = contractReport(["tests/contract/port-linq.v1.test.ts"], ["passed", "skipped"]);
    expect(checkPrefixRun(cut, prefix("receive"), report).problems).toEqual([
      `hop receive: its ${linq} did not pass every test (1 of 2 tests passed; a skipped, todo or pending test is no pass): ${why}`,
    ]);
  });

  it.each(SKELETON_UPTO_NAMES)(
    "SKELETON_UPTO=%s names its hop once for each contract test of its row, with no report given",
    (name) => {
      const found = prefix(name);
      const label = name === found.hop ? `hop ${found.hop}` : `hop ${found.hop} (${name})`;
      const problems = checkPrefixRun(collectedOf(cutAfter(skeleton, found.hop)), found, null).problems;
      expect(problems).toHaveLength(found.row.contracts.length);
      problems.forEach((problem, index) => {
        const contract = found.row.contracts[index] ?? "";
        expect(problem.startsWith(`${label}: no contract test report was given, so its contract test `)).toBe(
          true,
        );
        expect(problem).toContain(`${contractFilesOf(found)[index] ?? ""} (${contract})`);
      });
    },
  );

  it("checks only the hop's own row: earlier rows' tests passed before they joined", () => {
    const guard = prefix("guard");
    const report = contractReport(contractFilesOf(guard));
    expect(contractFilesOf(guard)).toEqual([
      "tests/contract/bundle.v1.test.ts",
      "tests/contract/db-schema.core.v1.test.ts",
    ]);
    expect(checkPrefixRun(collectedOf(cutAfter(skeleton, "guard")), guard, report).problems).toEqual([]);
  });
});

describe("the rest of T-465's check under a prefix", () => {
  const sendText = JSON.parse(
    readFileSync(path.join(CONTRACTS_ROOT, "port-linq", "fixtures", "send-text.json"), "utf8"),
  ) as { request: Record<string, unknown> };

  it("still names a part that reached the person twice, and an outbox row under another trace", async () => {
    const twice = new RecordingLinqDouble();
    twice.sendPart(sendText.request);
    twice.sendPart({ ...sendText.request, idempotencyKey: "out-a7-03-alex/1/2" });
    const delivered = JSON.parse(
      readFileSync(path.join(CONTRACTS_ROOT, "outbox-effects", "fixtures", "outbox-delivered.json"), "utf8"),
    ) as unknown;
    const found = prefix("dispatch");
    const run = collectedOf(cutAfter(skeleton, "dispatch"), {
      parts: partsOf(twice),
      linqEvents: twice.events(),
      outbox: await checkOutboxRows([delivered], skeleton.trace_id),
    });
    expect(checkPrefixRun(run, found, passedFor(found)).problems).toEqual([
      "part out-a7-03-alex/1 reached the person 2 times (out-a7-03-alex/1/1 (linq-msg-double-0001), out-a7-03-alex/1/2 (linq-msg-double-0002)): each part once",
      "row out-alex-booked-riley was written under trace trace-alex-0012, not trace-sam-0000",
    ]);
  });
});

describe("SKELETON_UPTO unset: T-465's full check", () => {
  const sendText = JSON.parse(
    readFileSync(path.join(CONTRACTS_ROOT, "port-linq", "fixtures", "send-text.json"), "utf8"),
  ) as { request: Record<string, unknown> };
  const delivered = JSON.parse(
    readFileSync(path.join(CONTRACTS_ROOT, "outbox-effects", "fixtures", "outbox-delivered.json"), "utf8"),
  ) as { row: { traceId: string } };

  /** A run as the local target collects it: the trace, the parts the double sent, one outbox row under the trace. */
  async function run(trace: typeof skeleton, sends: readonly string[]): Promise<Collected> {
    const linq = new RecordingLinqDouble();
    for (const key of sends) linq.sendPart({ ...sendText.request, idempotencyKey: key });
    return collectedOf(trace, {
      parts: partsOf(linq),
      linqEvents: linq.events(),
      outbox: await checkOutboxRows(
        [{ ...delivered, row: { ...delivered.row, traceId: trace.trace_id } }],
        trace.trace_id,
      ),
    });
  }

  const unset = [{}, { SKELETON_UPTO: "" }, { OTHER: "gateway" }];

  it("gives a passing run exactly checkRun's report, the contract report given or not", async () => {
    const passing = await run(skeleton, ["out-a7-03-alex/1/1"]);
    const full = checkRun(passing);
    expect(full.problems).toEqual([]);
    expect(full.hops?.hops).toEqual([...SKELETON_HOPS]);
    for (const env of unset) {
      expect(checkSkeletonRun(passing, { env })).toStrictEqual(full);
      expect(checkSkeletonRun(passing, { env, contracts: null })).toStrictEqual(full);
      expect(checkSkeletonRun(passing, { env, contracts: contractReport([]) })).toStrictEqual(full);
    }
  });

  it("gives a failing run exactly checkRun's report: a missing hop and a part sent twice", async () => {
    const failing = await run(withoutHop(skeleton, "commit"), ["out-a7-03-alex/1/1", "out-a7-03-alex/1/2"]);
    const full = checkRun(failing);
    expect(full.problems).toEqual([
      "hop commit is missing: every hop runs once",
      "part out-a7-03-alex/1 reached the person 2 times (out-a7-03-alex/1/1 (linq-msg-double-0001), out-a7-03-alex/1/2 (linq-msg-double-0002)): each part once",
    ]);
    for (const env of unset) {
      expect(checkSkeletonRun(failing, { env })).toStrictEqual(full);
      expect(checkSkeletonRun(failing, { env, contracts: contractReport([]) })).toStrictEqual(full);
    }
  });

  it("matches the prefix up to the last hop on the whole trace, apart from the prefix's own reading", async () => {
    const passing = await run(skeleton, ["out-a7-03-alex/1/1"]);
    const last = prefix("clockArmed");
    const { prefix: reading, ...report } = checkPrefixRun(passing, last, passedFor(last));
    expect(report).toStrictEqual(checkRun(passing));
    expect(reading.hops).toEqual([...SKELETON_HOPS]);
  });
});
