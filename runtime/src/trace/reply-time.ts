// Reply time read from a turn's traces (K-08 v1 `replyTime`; Q-41 default; CQ-06 default; arch 04 line 229).
//
// From the arrival of the turn's LAST text (the start of its `receive` span) to the moment Linq accepts the first part
// of the reply (the start of the `providerAccepted` span of the first outbox row's part 1). The one Sonnet re-read
// counts inside, a rewrite on top: both are simply time that passed between the two instants. The turn's trace is the
// first text's (CQ-06); the other texts' traces are the ones it lists in `joined_trace_ids`.

import { TraceError, type ReplyTime, type Span, type Trace } from "./types";
import { isLabel } from "./validate";

const firstSpan = (trace: Trace, hop: Span["hop"]): Span | undefined =>
  trace.spans.find((span) => span.hop === hop);

function labelFact(span: Span | undefined, name: string): string | null {
  const value = span?.got?.[name];
  return typeof value === "string" && isLabel(value) ? value : null;
}

/**
 * The turn's reply time. `turnTrace` is the trace that carries the turn (the first text's); `joinedTraces` are the
 * traces of the other texts it lists, in any order. Throws a TraceError when the traces cannot give it: a text with
 * no receive span, a joined trace the turn does not list, no first part accepted yet, or an acceptance before arrival.
 */
export function replyTimeOf(turnTrace: Trace, joinedTraces: readonly Trace[] = []): ReplyTime {
  const problems: string[] = [];
  if (turnTrace.turn_id === null) problems.push("the turn trace carries no turn");
  const listed = new Set(turnTrace.joined_trace_ids);
  for (const joined of joinedTraces) {
    if (!listed.has(joined.trace_id))
      problems.push(`trace ${joined.trace_id} is not listed by the turn's trace`);
  }
  for (const id of listed) {
    if (!joinedTraces.some((joined) => joined.trace_id === id))
      problems.push(`joined trace ${id} was not given`);
  }

  // The last text's arrival: the latest receive span among the turn's texts; a tie goes to the later text.
  let lastReceive: Span | undefined;
  for (const trace of [turnTrace, ...joinedTraces]) {
    const receive = firstSpan(trace, "receive");
    if (receive === undefined) {
      problems.push(`trace ${trace.trace_id} has no receive span`);
    } else if (lastReceive === undefined || Date.parse(receive.at) >= Date.parse(lastReceive.at)) {
      lastReceive = receive;
    }
  }
  const lastEventId = lastReceive?.event_id ?? null;
  if (lastReceive !== undefined && lastEventId === null)
    problems.push("the last text's receive span names no event");

  // The first part: the turn trace's first providerAccepted span for part 1 (a span with no part is part 1).
  const accepted = turnTrace.spans.find(
    (span) => span.hop === "providerAccepted" && (span.got?.part === undefined || span.got.part === 1),
  );
  if (accepted === undefined) problems.push("no first part has been accepted by the provider");
  let rowId: string | null = null;
  if (accepted !== undefined) {
    rowId = labelFact(accepted, "row");
    if (rowId === null) {
      // The row is named by the dispatch span before it, which sent that part.
      const sent = turnTrace.spans
        .filter((span) => span.hop === "dispatch" && span.seq < accepted.seq)
        .at(-1);
      rowId = labelFact(sent, "row");
    }
    if (rowId === null) problems.push("the first part's outbox row is named by no dispatch or accepted span");
  }
  if (
    problems.length > 0 ||
    lastReceive === undefined ||
    lastEventId === null ||
    accepted === undefined ||
    rowId === null ||
    turnTrace.turn_id === null
  ) {
    throw new TraceError("cannot read the reply time", problems);
  }

  const last = lastReceive;
  const first = accepted;
  const ms = Date.parse(first.at) - Date.parse(last.at);
  if (ms < 0)
    throw new TraceError("cannot read the reply time", [
      "the first part was accepted before the last text arrived",
    ]);

  const calls = [turnTrace, ...joinedTraces]
    .flatMap((trace) => trace.spans)
    .flatMap((span) => span.model_calls ?? []);
  const ranHop = turnTrace.spans.some((span) => span.hop === "reread");
  return {
    trace_id: turnTrace.trace_id,
    turn_id: turnTrace.turn_id,
    bundle_id: { hash: turnTrace.bundle_id.hash, build: turnTrace.bundle_id.build },
    texts: 1 + joinedTraces.length,
    last_text_event_id: lastEventId,
    last_text_at: last.at,
    first_part_row_id: rowId,
    first_part_accepted_at: first.at,
    ms,
    reread: ranHop || calls.some((call) => call.purpose === "reread"),
    rewrite: calls.some((call) => call.purpose === "rewrite"),
  };
}
