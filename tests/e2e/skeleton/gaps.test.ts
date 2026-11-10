// The skeleton's known gaps (T-1149, ./gaps.ts) judge around only what they name. On a trace written as the merged runtime
// writes one (K-08 trace-skeleton.json's spans through the guard, with no batch span, the handle actor's own receive span,
// and each writer's own seq), T-465's checkHops finds nothing once the actor's span is set aside and the spans are put in
// the order they started; and it still names a hop missing, repeated, out of order or on another trace, a batch span once
// one is written, and every actor receive span is handed back. Run by `npm run test:e2e -- skeleton`.

import { describe, expect, it } from "vitest";

import type { Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { checkHops } from "../_driver";
import { prefixOf, type SkeletonHop } from "../_driver/prefix";
import { skeleton } from "../_driver/prefix/test-support";
import { GAPS, NOT_WRITTEN, isActorReceive, judgedTraceOf, stillHolds, writtenHops } from "./gaps";

/** trace-skeleton.json's span of `hop`, copied. */
function span(hop: SkeletonHop): Span {
  const found = skeleton.spans.find((candidate) => candidate.hop === hop);
  if (found === undefined) throw new Error(`trace-skeleton.json has no ${hop} span`);
  return structuredClone(found);
}

/** `ms` milliseconds after trace-skeleton.json's `hop` span started. */
function after(hop: SkeletonHop, ms: number): string {
  return new Date(Date.parse(span(hop).at) + ms).toISOString();
}

/** The handle actor's own receive span, as runtime/src/actor/handle-actor.ts writes it: at the hand-off's end. */
function actorReceive(): Span {
  return {
    ...span("receive"),
    seq: 1,
    at: after("safetyRead", 2),
    ms: 2,
    got: { door: "handleActor", route: "inbox", kind: "text" },
    decided: { stored: true, startsTurn: true },
  };
}

/**
 * Hops 1 to 5 as the merged runtime writes them, in the order their lines are written: the actor's receive, the safety read
 * (each its writer's seq 1), the gateway's receive and scrub (1, 2, logged once the hand-off is answered), then the turn's
 * lease and guard (1, 2). No batch span.
 */
function written(): Trace {
  const spans: Span[] = [
    actorReceive(),
    { ...span("safetyRead"), seq: 1 },
    { ...span("receive"), seq: 1 },
    { ...span("scrub"), seq: 2 },
    { ...span("lease"), seq: 1 },
    { ...span("guard"), seq: 2 },
  ];
  const [first, ...rest] = spans;
  if (first === undefined) throw new Error("no span");
  return { ...structuredClone(skeleton), spans: [first, ...rest] };
}

/** Hops 1 to 5, through the guard, less the ones nothing writes yet: what the run judges. */
const JUDGED: readonly SkeletonHop[] = writtenHops(prefixOf("guard")?.hops ?? []);

/** `trace` with the span of `hop` changed by `change`. */
function changed(trace: Trace, hop: SkeletonHop, change: (span: Span) => Span): Trace {
  const spans = trace.spans.map((one) => (one.hop === hop && !isActorReceive(one) ? change(one) : one));
  const [first, ...rest] = spans;
  if (first === undefined) throw new Error("no span");
  return { ...trace, spans: [first, ...rest] };
}

describe("the skeleton's known gaps", () => {
  it("name each gap by its task, and leave out of the hops judged only the batch hop, which nothing writes yet", () => {
    expect(Object.keys(GAPS)).toEqual(["actorReceive", "seqPerWriter", "batchSpans"]);
    expect(stillHolds("batchSpans")).toBe(
      `known gap batchSpans (T-1108) no longer holds, so take it off tests/e2e/skeleton/gaps.ts: ${GAPS.batchSpans.what}`,
    );
    expect(NOT_WRITTEN).toEqual({ batch: "batchSpans" });
    expect(JUDGED).toEqual(["receive", "scrub", "safetyRead", "lease", "guard"]);
    expect(isActorReceive(actorReceive())).toBe(true);
    expect(skeleton.spans.filter(isActorReceive)).toEqual([]);
  });

  it("as written, the trace is no one run by seq: T-465's checkHops names it (gap seqPerWriter)", () => {
    expect(checkHops(written(), JUDGED).problems.filter((problem) => problem.kind === "seq")).not.toEqual([]);
  });

  it("set the actor's receive span aside, put the rest in the order they started, number them 1, 2, 3 ... and change nothing else", () => {
    const trace = written();
    const judged = judgedTraceOf(trace);
    expect(judged.actorReceives).toEqual([actorReceive()]);
    expect(judged.trace.spans.map((one) => [one.seq, one.hop])).toEqual([
      [1, "receive"],
      [2, "scrub"],
      [3, "safetyRead"],
      [4, "lease"],
      [5, "guard"],
    ]);
    for (const one of judged.trace.spans) {
      const before = trace.spans.find((other) => other.hop === one.hop && !isActorReceive(other));
      expect(one).toEqual({ ...before, seq: one.seq });
    }
    expect({ ...judged.trace, spans: [] }).toEqual({ ...trace, spans: [] });
    expect(checkHops(judged.trace, JUDGED).problems).toEqual([]);
  });

  it("keep their writer's seq, then the trace's order, for spans that started at one instant", () => {
    const sameInstant = changed(written(), "guard", (one) => ({ ...one, at: span("lease").at }));
    expect(judgedTraceOf(sameInstant).trace.spans.map((one) => one.hop)).toEqual([
      "receive",
      "scrub",
      "safetyRead",
      "lease",
      "guard",
    ]);
  });

  it("still let T-465's checkHops name a hop missing, repeated, out of order or on another trace", () => {
    const trace = written();
    const without = { ...trace, spans: trace.spans.filter((one) => one.hop !== "safetyRead") } as Trace;
    expect(checkHops(judgedTraceOf(without).trace, JUDGED).problems.map((problem) => problem.kind)).toEqual([
      "missing",
    ]);

    const guard = trace.spans.find((one) => one.hop === "guard");
    if (guard === undefined) throw new Error("no guard span");
    const twice = { ...trace, spans: [...trace.spans, { ...guard, seq: 3, at: after("guard", 5) }] } as Trace;
    expect(checkHops(judgedTraceOf(twice).trace, JUDGED).problems.map((problem) => problem.kind)).toEqual([
      "repeated",
    ]);

    const early = changed(trace, "guard", (one) => ({ ...one, at: after("lease", -1) }));
    expect(checkHops(judgedTraceOf(early).trace, JUDGED).problems.map((problem) => problem.kind)).toEqual([
      "outOfOrder",
    ]);

    const elsewhere = changed(trace, "scrub", (one) => ({ ...one, trace_id: "trace-other" }));
    expect(checkHops(judgedTraceOf(elsewhere).trace, JUDGED).problems.map((problem) => problem.kind)).toEqual(
      ["traceId"],
    );
  });

  it("name a batch span as unexpected once one is written (the gap's task then takes batch off NOT_WRITTEN)", () => {
    const trace = written();
    const batch = { ...span("batch"), seq: 3, at: after("safetyRead", 900) };
    const withBatch = { ...trace, spans: [...trace.spans, batch] } as Trace;
    expect(checkHops(judgedTraceOf(withBatch).trace, JUDGED).problems).toEqual([
      expect.objectContaining({ kind: "unexpected", hop: "batch" }),
    ]);
  });

  it("hand every actor receive span back, so a second one is seen", () => {
    const trace = written();
    const twice = {
      ...trace,
      spans: [...trace.spans, { ...actorReceive(), at: after("safetyRead", 5) }],
    } as Trace;
    expect(judgedTraceOf(twice).actorReceives).toHaveLength(2);
  });
});
