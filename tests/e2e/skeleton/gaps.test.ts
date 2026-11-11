// The skeleton's known gaps (T-1149, ./gaps.ts) judge around only what they name. T-1108 closed three of them: on a trace
// written as the merged runtime writes one now (K-08 trace-skeleton.json's spans through the guard: one receive span, the
// gateway's; the batch span; one run by seq across the writers, whatever order their lines are written in), T-465's
// checkHops finds nothing, as written: nothing is set aside, numbered again or left out. And it still names what the
// closed gaps used to be, were one to come back: a trace whose writers each count from 1, a second receive span beside
// the gateway's, a trace with no batch span; and a hop missing, repeated, out of order, starting before the one seq puts
// before it, or on another trace. The one gap left (modelCallOrder) is a model call's own span out of start order by seq:
// judgedTraceOf puts the spans in the order they started, numbers them again and changes nothing else. Run by
// `npm run test:e2e -- skeleton`.

import { describe, expect, it } from "vitest";

import type { Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { checkHops } from "../_driver";
import { prefixOf, type SkeletonHop } from "../_driver/prefix";
import { skeleton } from "../_driver/prefix/test-support";
import { GAPS, NOT_WRITTEN, judgedTraceOf, stillHolds, writtenHops } from "./gaps";

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

/** A trace of `spans`, with trace-skeleton.json's own fields. */
function traceOf(spans: readonly Span[]): Trace {
  const [first, ...rest] = spans;
  if (first === undefined) throw new Error("no span");
  return { ...structuredClone(skeleton), spans: [first, ...rest] };
}

/**
 * Hops 1 to 5 as the merged runtime writes them, in the order their lines are written: the safety read first (it ends
 * while the gateway still waits for its actor), then the gateway's receive and scrub (logged once the hand-off is
 * answered), then the batch window's span and the turn's lease and guard. Each keeps the place it took as it started, so
 * by seq they are trace-skeleton.json's: receive 1, scrub 2, safetyRead 3, batch 4, lease 5, guard 6.
 */
function written(): Trace {
  return traceOf([
    span("safetyRead"),
    span("receive"),
    span("scrub"),
    span("batch"),
    span("lease"),
    span("guard"),
  ]);
}

/** The same spans as each writer numbered them before T-1108: every writer's own count from 1. */
function perWriter(): Trace {
  return traceOf([
    { ...span("safetyRead"), seq: 1 },
    { ...span("receive"), seq: 1 },
    { ...span("scrub"), seq: 2 },
    { ...span("batch"), seq: 1 },
    { ...span("lease"), seq: 1 },
    { ...span("guard"), seq: 2 },
  ]);
}

/** The handle actor's own receive span, as it wrote one before T-1108: at its door, as the hand-off reached it. */
function actorReceive(): Span {
  return {
    ...span("receive"),
    at: after("safetyRead", 2),
    ms: 2,
    got: { door: "handleActor", route: "inbox", kind: "text" },
    decided: { stored: true, startsTurn: true },
  };
}

/** `spans` in the order given, numbered 1, 2, 3 ...: a trace built with one fault and no other. */
function numbered(spans: readonly Span[]): Trace {
  return traceOf(spans.map((one, index) => ({ ...one, seq: index + 1 })));
}

/** The skeleton's spans through the guard, in seq order. */
function inOrder(): Span[] {
  return [...written().spans].sort((a, b) => a.seq - b.seq);
}

/** Hops 1 to 5, through the guard: what the run judges. Every one has a writer. */
const JUDGED: readonly SkeletonHop[] = writtenHops(prefixOf("guard")?.hops ?? []);

const kindsOf = (trace: Trace): string[] => checkHops(trace, JUDGED).problems.map((problem) => problem.kind);

describe("the skeleton's known gaps", () => {
  it("name each gap by its task, and leave no hop out of the hops judged: the batch hop is judged with the rest", () => {
    expect(Object.keys(GAPS)).toEqual(["modelCallOrder"]);
    expect(stillHolds("modelCallOrder")).toBe(
      `known gap modelCallOrder (${GAPS.modelCallOrder.task}) no longer holds, so take it off tests/e2e/skeleton/gaps.ts: ${GAPS.modelCallOrder.what}`,
    );
    expect(NOT_WRITTEN).toEqual({});
    expect(JUDGED).toEqual(["receive", "scrub", "safetyRead", "batch", "lease", "guard"]);
    expect(JUDGED).toEqual(prefixOf("guard")?.hops);
    // The three gaps T-1108 closed are no longer named.
    for (const closed of ["actorReceive", "seqPerWriter", "batchSpans"]) {
      expect(Object.keys(GAPS)).not.toContain(closed);
    }
    // K-08 draws one receive span, the gateway's, and none with the actor's door.
    expect(skeleton.spans.filter((one) => one.hop === "receive")).toHaveLength(1);
    expect(skeleton.spans.filter((one) => one.got?.door === "handleActor")).toEqual([]);
  });

  it("as written, the trace is one run by seq across its writers: T-465's checkHops finds nothing, with nothing set aside, numbered again or left out", () => {
    const trace = written();
    // Written in another order than they started in, and read by seq.
    expect(trace.spans.map((one) => one.hop)).not.toEqual(JUDGED);
    const report = checkHops(trace, JUDGED);
    expect(report.problems).toEqual([]);
    expect(report.hops).toEqual(JUDGED);
    expect(inOrder().map((one) => [one.seq, one.hop])).toEqual([
      [1, "receive"],
      [2, "scrub"],
      [3, "safetyRead"],
      [4, "batch"],
      [5, "lease"],
      [6, "guard"],
    ]);
  });

  it("a trace whose writers each count from 1 is named: seq is no one run (what gap seqPerWriter judged around)", () => {
    expect(kindsOf(perWriter()).filter((kind) => kind === "seq")).not.toEqual([]);
    expect(kindsOf(written()).filter((kind) => kind === "seq")).toEqual([]);
  });

  it("spans that started at one instant keep the order seq gives them", () => {
    const sameInstant = traceOf(
      written().spans.map((one) => (one.hop === "guard" ? { ...one, at: span("lease").at } : one)),
    );
    const report = checkHops(sameInstant, JUDGED);
    expect(report.problems).toEqual([]);
    expect(report.hops).toEqual(["receive", "scrub", "safetyRead", "batch", "lease", "guard"]);
  });

  it("still let T-465's checkHops name a hop missing, repeated, out of order, starting too early or on another trace", () => {
    expect(kindsOf(numbered(inOrder().filter((one) => one.hop !== "safetyRead")))).toEqual(["missing"]);

    const guard = span("guard");
    expect(kindsOf(numbered([...inOrder(), { ...guard, at: after("guard", 5) }]))).toEqual(["repeated"]);

    // The guard numbered before the lease, and starting no later: out of the turn's order.
    const beforeLease = inOrder().filter((one) => one.hop !== "lease" && one.hop !== "guard");
    const lease = span("lease");
    expect(kindsOf(numbered([...beforeLease, { ...guard, at: lease.at }, lease]))).toEqual(["outOfOrder"]);

    // The guard numbered after the lease but starting before it: by seq, time goes back.
    const early = written().spans.map((one) =>
      one.hop === "guard" ? { ...one, at: after("lease", -1) } : one,
    );
    expect(kindsOf(traceOf(early))).toEqual(["time"]);

    const elsewhere = written().spans.map((one) =>
      one.hop === "scrub" ? { ...one, trace_id: "trace-other" } : one,
    );
    expect(kindsOf(traceOf(elsewhere))).toEqual(["traceId"]);
  });

  it("gap modelCallOrder: a model call's span numbered before the hop it ran inside is named as written, and judgedTraceOf puts the spans in the order they started, numbers them again and changes nothing else", () => {
    // The safety read's model call, written (and so numbered) before the read's own span, which started first.
    const call: Span = {
      ...span("safetyRead"),
      hop: "portCall",
      provider: "anthropic",
      call: "messages",
      attempt: 1,
      at: after("safetyRead", 5),
    };
    const [receive, scrub, read, ...rest] = inOrder();
    if (receive === undefined || scrub === undefined || read === undefined) throw new Error("no span");
    const asWritten = numbered([receive, scrub, call, read, ...rest]);
    expect(checkHops(asWritten, JUDGED).problems).toEqual([
      expect.objectContaining({ kind: "time", hop: "safetyRead" }),
    ]);

    const judged = judgedTraceOf(asWritten);
    expect(judged.spans.map((one) => [one.seq, one.hop])).toEqual([
      [1, "receive"],
      [2, "scrub"],
      [3, "safetyRead"],
      [4, "portCall"],
      [5, "batch"],
      [6, "lease"],
      [7, "guard"],
    ]);
    // No span is set aside or changed but for its place.
    expect(judged.spans).toHaveLength(asWritten.spans.length);
    for (const one of judged.spans) {
      const before = asWritten.spans.find((other) => other.hop === one.hop);
      expect(one).toEqual({ ...before, seq: one.seq });
    }
    expect({ ...judged, spans: [] }).toEqual({ ...asWritten, spans: [] });
    expect(checkHops(judged, JUDGED).problems).toEqual([]);
    // A trace already in start order by seq is judged as it is.
    expect(judgedTraceOf(written()).spans).toEqual(inOrder());
  });

  it("a trace with no batch span is named: the batch hop is judged (what gap batchSpans left out)", () => {
    const withoutBatch = numbered(inOrder().filter((one) => one.hop !== "batch"));
    expect(checkHops(withoutBatch, JUDGED).problems).toEqual([
      expect.objectContaining({ kind: "missing", hop: "batch" }),
    ]);
  });

  it("a second receive span, the actor's own beside the gateway's, is named: one receive span per text (what gap actorReceive set aside)", () => {
    const [receive, scrub, read, ...rest] = inOrder();
    if (receive === undefined || scrub === undefined || read === undefined) throw new Error("no span");
    const twice = numbered([receive, scrub, read, actorReceive(), ...rest]);
    expect(checkHops(twice, JUDGED).problems).toEqual([
      expect.objectContaining({ kind: "repeated", hop: "receive" }),
    ]);
  });
});
