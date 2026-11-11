// What the merged runtime does not write yet, which the skeleton's run inside workerd meets (T-1149). They are known gaps
// of the runtime's own trace test (runtime/test/trace-e2e.worker.test.ts GAPS; T-260 round 2, DL-168), each with the task
// that closes it. The run judges around each one in a named way, never by dropping it in silence, and asserts that each
// still holds, with a message that says to take it off this list. So the list only shrinks: the task that writes what is
// missing fails the skeleton's run and takes its gap off here, with what judges around it.
//
// T-1108 closed three: the handle actor writes no receive span of its own, so each text has one, the gateway's
// (actorReceive); the batch window writes the batch span, so the batch hop is judged with the others (batchSpans); and
// seq is one run 1, 2, 3 ... across a trace's writers, each hop taking its place as it starts, so by seq, as written,
// the hops stand in the order they started (seqPerWriter). What is left of the last is narrower, and is not the runtime's
// trace writers': the spans the model calls write beside the hops (modelCallOrder).

import type { Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import type { SkeletonHop } from "../_driver/prefix";

export const GAPS = {
  modelCallOrder: {
    task: "T-1108's NEED (the safety read's span and @rosie/ai's gateway)",
    what: "seq is one run 1, 2, 3 ... across the trace's writers, and by seq the hops stand in the order they started; but a model call's own portCall span does not: the safety read's span takes its place when the read ends, after its model call's span (runtime/src/safety/arrival.ts), and @rosie/ai's gateway stamps a model call's span on Date.now(), not on the trace's clock, which this run moves on for the quiet close (ai/src/gateway/gateway.ts), so by seq three spans start before the span before them. T-465's checkHops judges the trace in the order its spans started, numbered 1, 2, 3 ... again",
  },
} as const;

export type Gap = keyof typeof GAPS;

/** What a gap's check says when it fails: the gap no longer holds, so its task takes it off GAPS. */
export function stillHolds(gap: Gap): string {
  return `known gap ${gap} (${GAPS[gap].task}) no longer holds, so take it off tests/e2e/skeleton/gaps.ts: ${GAPS[gap].what}`;
}

/** Skeleton hops nothing writes yet, each by its gap: left out of the hops judged. None: every hop is judged. */
export const NOT_WRITTEN: Readonly<Partial<Record<SkeletonHop, Gap>>> = {};

/** The hops of `hops` the run can judge: those with a writer (NOT_WRITTEN's are left out). */
export function writtenHops(hops: readonly SkeletonHop[]): SkeletonHop[] {
  return hops.filter((hop) => NOT_WRITTEN[hop] === undefined);
}

/**
 * `trace` as T-465's checkHops judges it while gap modelCallOrder holds: its spans in the order they started (`at`:
 * K-08's "when it started"; spans that started at one instant keep the order seq gives them, then the trace's) and
 * numbered 1, 2, 3 ... again. Nothing else changes, and no span is set aside: each span keeps its hop, ids, bundle id,
 * times and what it got and decided.
 */
export function judgedTraceOf(trace: Trace): Trace {
  const started = trace.spans
    .map((span, place) => ({ span, place }))
    .sort(
      (a, b) => Date.parse(a.span.at) - Date.parse(b.span.at) || a.span.seq - b.span.seq || a.place - b.place,
    );
  const [first, ...rest] = started.map(({ span }, index) => ({ ...span, seq: index + 1 }));
  if (first === undefined) throw new Error(`trace ${trace.trace_id} has no span`);
  return { ...trace, spans: [first, ...rest] };
}
