// Tests of the reply-time measure (T-240; Q-41 default; CQ-06 default; K-08 v1 `replyTime`): from the last text's
// arrival to the provider-accepted span of the first part. Held to K-08's fixtures and schema.

import { describe, expect, it } from "vitest";

import { replyTimeOf } from "./reply-time";
import { eventTraceFixture, schemaErrors } from "./test-support";
import { TraceError, type ModelCall, type ReplyTime, type Span, type Trace } from "./types";

const batch = eventTraceFixture("trace-batch-three-texts.json") as { traces: [Trace, Trace, Trace] };
const expectedBatch = eventTraceFixture("measure-reply-time.json") as ReplyTime;
const skeleton = eventTraceFixture("trace-skeleton.json") as Trace;

/** A deep copy the test can change. */
const copy = <T>(value: T): T => structuredClone(value);

function modelCall(purpose: ModelCall["purpose"]): ModelCall {
  return {
    model: "claude-sonnet-5-5",
    role: "sonnet",
    purpose,
    input_tokens: 1,
    cached_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 1,
    cost_micro_usd: 1,
    ms: 1,
    outcome: "ok",
  };
}

function spanOf(trace: Trace, hop: Span["hop"]): Span {
  const found = trace.spans.find((span) => span.hop === hop);
  if (found === undefined) throw new Error(`no ${hop} span`);
  return found;
}

describe("reply time (Q-41, CQ-06)", () => {
  it("a three-text batch is measured from the last text's arrival, and equals measure-reply-time.json", () => {
    const [turn, second, third] = batch.traces;
    const reply = replyTimeOf(turn, [second, third]);
    expect(reply).toEqual(expectedBatch);
    expect(schemaErrors("replyTime", reply)).toEqual([]);
    // Not from the first text (16:00:00), which would read 10800 ms.
    expect(reply.ms).toBe(6800);
    expect(reply.last_text_event_id).toBe("evt-alex-0005");
  });

  it("the order the joined traces are given in does not matter", () => {
    const [turn, second, third] = batch.traces;
    expect(replyTimeOf(turn, [third, second])).toEqual(expectedBatch);
  });

  it("a single text is measured from its own arrival to its first part", () => {
    const reply = replyTimeOf(skeleton);
    expect(schemaErrors("replyTime", reply)).toEqual([]);
    expect(reply.texts).toBe(1);
    expect(reply.last_text_at).toBe(spanOf(skeleton, "receive").at);
    expect(reply.first_part_accepted_at).toBe(spanOf(skeleton, "providerAccepted").at);
    expect(reply.ms).toBe(Date.parse(reply.first_part_accepted_at) - Date.parse(reply.last_text_at));
  });

  it("ends at the first part's acceptance, not at a later part", () => {
    const [turn, second, third] = copy(batch.traces);
    const accepted = spanOf(turn, "providerAccepted");
    turn.spans.push({
      ...accepted,
      span_id: "span-alex-0003-15",
      seq: 15,
      at: "2026-10-22T16:00:12Z",
      got: { messageId: "linq-msg-demo-0032", part: 2 },
    });
    expect(replyTimeOf(turn, [second, third]).ms).toBe(6800);
  });

  it("takes the row from the span before when the accepted span names none", () => {
    const [turn, second, third] = copy(batch.traces);
    expect(spanOf(turn, "providerAccepted").got?.row).toBeUndefined();
    expect(replyTimeOf(turn, [second, third]).first_part_row_id).toBe("out-a7-03-alex-first");
  });

  it("counts a re-read inside and a rewrite on top, both reported", () => {
    const [turn, second, third] = copy(batch.traces);
    expect(replyTimeOf(turn, [second, third])).toMatchObject({ reread: false, rewrite: false });
    const decide = spanOf(turn, "decideReads");
    decide.model_calls = [...(decide.model_calls ?? []), modelCall("reread")];
    const compose = spanOf(turn, "compose");
    compose.model_calls = [...(compose.model_calls ?? []), modelCall("rewrite")];
    const reply = replyTimeOf(turn, [second, third]);
    expect(reply).toMatchObject({ reread: true, rewrite: true, ms: 6800 });
    expect(schemaErrors("replyTime", reply)).toEqual([]);
  });

  it("a text that arrives last but was joined late still sets the start", () => {
    const [turn, second, third] = copy(batch.traces);
    spanOf(second, "receive").at = "2026-10-22T16:00:05Z";
    expect(replyTimeOf(turn, [second, third])).toMatchObject({
      last_text_event_id: "evt-alex-0004",
      ms: 5800,
    });
  });
});

describe("a reply time that cannot be read", () => {
  it("refuses a turn whose first part was never accepted", () => {
    const [turn, second, third] = copy(batch.traces);
    turn.spans = turn.spans.filter((span) => span.hop !== "providerAccepted");
    expect(() => replyTimeOf(turn, [second, third])).toThrow(/no first part/u);
  });

  it("refuses joined traces that the turn does not list, or that were not given", () => {
    const [turn, second, third] = batch.traces;
    expect(() => replyTimeOf(turn, [second])).toThrow(/joined trace trace-alex-0005 was not given/u);
    expect(() => replyTimeOf(turn, [second, third, { ...third, trace_id: "trace-other-1" }])).toThrow(
      /not listed/u,
    );
  });

  it("refuses a text with no receive span, such as a clock firing", () => {
    const fire = eventTraceFixture("trace-clock-fire.json") as Trace;
    expect(() => replyTimeOf(fire)).toThrow(TraceError);
  });

  it("refuses an acceptance before the last text arrived", () => {
    const [turn, second, third] = copy(batch.traces);
    spanOf(turn, "providerAccepted").at = "2026-10-22T16:00:03Z";
    expect(() => replyTimeOf(turn, [second, third])).toThrow(/before the last text arrived/u);
  });

  it("refuses when no span names the first part's row", () => {
    const [turn, second, third] = copy(batch.traces);
    turn.spans = turn.spans.filter((span) => span.hop !== "dispatch");
    expect(() => replyTimeOf(turn, [second, third])).toThrow(/outbox row/u);
  });
});
