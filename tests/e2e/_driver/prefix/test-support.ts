// Traces, runs and contract reports for the hop-prefix mode's tests (T-551). The traces are K-08 v1's trace-skeleton.json
// (Sam's first text to S1-02's question, every hop once, in order: the master's sample cast, no real data) and copies cut
// or damaged from it in the test. The reports are Vitest JSON reports in the shape `npm run test:contract --
// --reporter=json` writes, each file under its absolute path.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Span, Trace } from "../../../../contracts/generated/event-trace/event-trace.v1";
import { CONTRACTS_ROOT, REPO_ROOT } from "../../../contract/_harness";
import { asTrace, type Collected } from "../index";
import type { ContractReport } from "./contract-report";
import type { SkeletonPrefix } from "./prefix";
import { contractTestOf, type SkeletonHop } from "./section-11";

/** K-08 v1's trace-skeleton.json, read as a trace (the schema checks it first). */
export const skeleton: Trace = asTrace(
  JSON.parse(
    readFileSync(path.join(CONTRACTS_ROOT, "event-trace", "fixtures", "trace-skeleton.json"), "utf8"),
  ),
);

/** A copy of `trace` with these spans, numbered 1, 2, 3 ... again. */
export function withSpans(trace: Trace, spans: readonly Span[]): Trace {
  const [first, ...rest] = spans.map((span, index) => ({ ...structuredClone(span), seq: index + 1 }));
  if (first === undefined) throw new Error("a trace has at least one span");
  return { ...structuredClone(trace), spans: [first, ...rest] };
}

function placeOf(trace: Trace, hop: SkeletonHop): number {
  const place = trace.spans.findIndex((span) => span.hop === hop);
  if (place < 0) throw new Error(`the trace has no span of hop ${hop}`);
  return place;
}

/** `trace` cut after `hop`: its spans up to and including that hop's first span. */
export function cutAfter(trace: Trace, hop: SkeletonHop): Trace {
  return withSpans(trace, trace.spans.slice(0, placeOf(trace, hop) + 1));
}

/** `trace` without the spans of `hop`. */
export function withoutHop(trace: Trace, hop: SkeletonHop): Trace {
  return withSpans(
    trace,
    trace.spans.filter((span) => span.hop !== hop),
  );
}

/** `trace` with `hop` run a second time, right after the first, as a span of its own. */
export function withHopRepeated(trace: Trace, hop: SkeletonHop): Trace {
  return withSpans(
    trace,
    trace.spans.flatMap((span) =>
      span.hop === hop ? [span, { ...span, span_id: `${span.span_id}-again` }] : [span],
    ),
  );
}

/** `trace` with the spans of hops `a` and `b` in each other's place; each place keeps its start time, so time runs on. */
export function withHopsSwapped(trace: Trace, a: SkeletonHop, b: SkeletonHop): Trace {
  const spans = [...trace.spans];
  const [i, j] = [placeOf(trace, a), placeOf(trace, b)];
  const [first, second] = [spans[i], spans[j]];
  if (first === undefined || second === undefined)
    throw new Error(`the trace has no span of hop ${a} or ${b}`);
  spans[i] = { ...second, at: first.at };
  spans[j] = { ...first, at: second.at };
  return withSpans(trace, spans);
}

/** A local run collected with `trace`, no part sent and no outbox reader, unless `more` gives them. */
export function collectedOf(trace: Trace | null, more: Partial<Collected> = {}): Collected {
  return {
    target: "local",
    traceId: trace?.trace_id ?? skeleton.trace_id,
    trace,
    traceProblems: [],
    parts: [],
    linqEvents: [],
    outbox: null,
    ...more,
  };
}

/** A Vitest JSON report holding `files` (repository paths), each with tests of these statuses. */
export function contractReport(
  files: readonly string[],
  statuses: readonly string[] = ["passed"],
): ContractReport {
  return {
    testResults: files.map((file) => ({
      name: path.join(REPO_ROOT, file),
      status: statuses.includes("failed") ? "failed" : "passed",
      assertionResults: statuses.map((status) => ({ status })),
    })),
  };
}

/** The repository paths of the prefix's hop's contract tests: its section 11 row's contracts, at v1. */
export function contractFilesOf(prefix: SkeletonPrefix): string[] {
  return prefix.row.contracts.map((contract) => contractTestOf(contract).file);
}

/** A report in which every contract test of the prefix's hop passed. */
export function passedFor(prefix: SkeletonPrefix): ContractReport {
  return contractReport(contractFilesOf(prefix));
}
