// What the merged runtime does not write yet, which the skeleton's run inside workerd meets (T-1149). They are known gaps
// of the runtime's own trace test (runtime/test/trace-e2e.worker.test.ts GAPS; T-260 round 2, DL-168), each with the task
// that closes it. The run judges around each one in a named way, never by dropping it in silence, and asserts that each
// still holds, with a message that says to take it off this list. So the list only shrinks: the task that writes what is
// missing fails the skeleton's run and takes its gap off here, with what judges around it.

import type { Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import type { SkeletonHop } from "../_driver/prefix";

export const GAPS = {
  actorReceive: {
    task: "T-1108",
    what: "the handle actor writes its own receive span (got.door handleActor) beside the gateway's, where K-08 shows one receive per text: it is the actor's inbox entry, set aside from the hops T-465's checkHops counts and judged on its own",
  },
  seqPerWriter: {
    task: "T-1108",
    what: "seq (and so span_id) restarts at 1 in each writer's trace context (the gateway, the actor, the safety read, its model call, the turn), so a trace is not one run by seq: T-465's checkHops judges it in the order its spans started, numbered 1, 2, 3 ... again",
  },
  batchSpans: {
    task: "T-1108",
    what: "the batch window writes no batch span (runtime/src/trace closeBatch has no caller), so the batch hop is left out of the hops judged, and is named as unexpected once it is written",
  },
} as const;

export type Gap = keyof typeof GAPS;

/** What a gap's check says when it fails: the gap no longer holds, so its task takes it off GAPS. */
export function stillHolds(gap: Gap): string {
  return `known gap ${gap} (${GAPS[gap].task}) no longer holds, so take it off tests/e2e/skeleton/gaps.ts: ${GAPS[gap].what}`;
}

/** Skeleton hops nothing writes yet, each by its gap: left out of the hops judged. */
export const NOT_WRITTEN: Readonly<Partial<Record<SkeletonHop, Gap>>> = { batch: "batchSpans" };

/** The hops of `hops` the run can judge: those with a writer (NOT_WRITTEN's are left out). */
export function writtenHops(hops: readonly SkeletonHop[]): SkeletonHop[] {
  return hops.filter((hop) => NOT_WRITTEN[hop] === undefined);
}

/** The handle actor's own receive span (gap actorReceive): written at its door when the gateway's hand-off reaches it. */
export function isActorReceive(span: Span): boolean {
  return span.hop === "receive" && span.got?.door === "handleActor";
}

/** A trace as T-465's checkHops judges it while gaps actorReceive and seqPerWriter hold. */
export interface JudgedTrace {
  /**
   * The trace without the actor's own receive span, its spans in the order they started (`at`: K-08's "when it started";
   * spans that started at one instant keep their writer's seq, then the trace's order) and numbered 1, 2, 3 ... again.
   * Nothing else changes: each span keeps its hop, ids, bundle id, times and what it got and decided.
   */
  readonly trace: Trace;
  /** The actor's own receive spans, set aside (gap actorReceive): the actor's inbox entry. */
  readonly actorReceives: readonly Span[];
}

/** `trace` as T-465's checkHops judges it while gaps actorReceive and seqPerWriter hold. */
export function judgedTraceOf(trace: Trace): JudgedTrace {
  const actorReceives = trace.spans.filter(isActorReceive);
  const started = trace.spans
    .map((span, place) => ({ span, place }))
    .filter(({ span }) => !isActorReceive(span))
    .sort(
      (a, b) => Date.parse(a.span.at) - Date.parse(b.span.at) || a.span.seq - b.span.seq || a.place - b.place,
    );
  const [first, ...rest] = started.map(({ span }, index) => ({ ...span, seq: index + 1 }));
  if (first === undefined) throw new Error(`trace ${trace.trace_id} has no span but the actor's own receive`);
  return { trace: { ...trace, spans: [first, ...rest] }, actorReceives };
}
