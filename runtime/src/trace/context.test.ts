// Tests of the trace context (T-240; K-08 v1; CQ-06; ADR-009). Every span and trace the context emits is validated
// against K-08 v1's own schema with Ajv 2020. Test values only: the contract fixtures' sample cast (rule 9).

import { describe, expect, it } from "vitest";

import {
  beginSeq,
  closeBatch,
  isValidTraceId,
  logSink,
  openTrace,
  resumeSeq,
  seqOf,
  takeSeq,
  traceIdFromHeader,
  type SpanFields,
  type TraceContext,
} from "./context";
import { replyTimeOf } from "./reply-time";
import { eventTraceFixture, schemaErrors } from "./test-support";
import { TraceError, type Span, type Trace } from "./types";

const BUNDLE = { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 };
const UUID = "3f2b8c1e-5d4a-4e7b-9a60-1c2d3e4f5a6b";

/** A clock the test moves by hand. */
function fakeClock(start: string): {
  now: () => number;
  set: (iso: string) => void;
  advance: (ms: number) => void;
} {
  let time = Date.parse(start);
  return {
    now: () => time,
    set: (iso) => {
      time = Date.parse(iso);
    },
    advance: (ms) => {
      time += ms;
    },
  };
}

/** Readable ids, in order, for the fixtures' sake. */
function ids(...list: string[]): () => string {
  let next = 0;
  return () => {
    const id = list[next];
    next += 1;
    if (id === undefined) throw new Error("out of ids");
    return id;
  };
}

/** Records the three hops of a text that precede the batch, with the fixture's times. */
function arrive(context: TraceContext, eventId: string, at: string, safetyMs: number): void {
  const received = Date.parse(at);
  context.record({
    hop: "receive",
    at,
    ms: 150,
    outcome: "ok",
    eventId,
    provider: "linq",
    got: { kind: "text", service: "imessage" },
    decided: { signatureValid: true, knownEventId: false, sealedToActor: true },
  });
  context.record({
    hop: "scrub",
    at: new Date(received + 10).toISOString(),
    ms: 3,
    outcome: "ok",
    eventId,
    decided: { cardNumbersTagged: 0, ssnsTagged: 0 },
  });
  context.record({
    hop: "safetyRead",
    at: new Date(received + 200).toISOString(),
    ms: safetyMs,
    outcome: "ok",
    eventId,
    decided: { labels: ["No"], dangerWords: 0, timedOut: false },
    modelCalls: [
      {
        model: "claude-haiku-5-5",
        role: "haiku",
        purpose: "safetyRead",
        input_tokens: 300,
        cached_tokens: 1800,
        cache_write_tokens: 0,
        output_tokens: 40,
        cost_micro_usd: 680,
        ms: safetyMs - 20,
        outcome: "ok",
      },
    ],
  });
}

describe("opening a trace: one trace id per start", () => {
  it("reuses a valid incoming x-trace-id, trimmed and lowercased", () => {
    const context = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE,
      incomingTraceId: `  ${UUID.toUpperCase()} `,
      handleRef: "handle-alex",
    });
    expect(context.traceId).toBe(UUID);
    expect(context.reusedIncoming).toBe(true);
    expect(context.headers()).toEqual({ "x-trace-id": UUID });
  });

  it("makes a new id when none comes in, or the one that comes in is not valid", () => {
    for (const incoming of [
      undefined,
      null,
      "",
      "not-a-trace-id",
      "evt-alex-0003",
      "3f2b8c1e-5d4a-4e7b-9a60",
    ]) {
      const context = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, incomingTraceId: incoming });
      expect(isValidTraceId(context.traceId)).toBe(true);
      expect(context.traceId).not.toBe(incoming);
      expect(context.reusedIncoming).toBe(false);
    }
  });

  it("traceIdFromHeader keeps the health endpoint's rule", () => {
    expect(traceIdFromHeader(UUID)).toBe(UUID);
    expect(traceIdFromHeader("nope", ids("made-up"))).toBe("made-up");
    expect(traceIdFromHeader(null, ids("made-up"))).toBe("made-up");
  });

  it("a clock firing, a page request and an Agent API request each open their own trace id (CQ-06)", () => {
    const clock = openTrace({
      openedBy: "clockFiring",
      bundleId: BUNDLE,
      jobId: "fire-clock-oq-a7-03-alex-yoga",
    });
    const page = openTrace({ openedBy: "pageRequest", bundleId: BUNDLE, jobId: "page-sam-1" });
    const agent = openTrace({ openedBy: "agentApiRequest", bundleId: BUNDLE, jobId: "agent-sam-1" });
    const all = [clock.traceId, page.traceId, agent.traceId];
    expect(new Set(all).size).toBe(3);
    for (const id of all) expect(isValidTraceId(id)).toBe(true);
    expect(clock.jobId).toBe("fire-clock-oq-a7-03-alex-yoga");
  });

  it("two requests of the same kind do not share an id", () => {
    const first = openTrace({ openedBy: "pageRequest", bundleId: BUNDLE });
    const second = openTrace({ openedBy: "pageRequest", bundleId: BUNDLE });
    expect(first.traceId).not.toBe(second.traceId);
  });

  it("a start that is not a request ignores an incoming x-trace-id and opens its own", () => {
    for (const openedBy of ["clockFiring", "sweep", "reconciliation"] as const) {
      const context = openTrace({ openedBy, bundleId: BUNDLE, jobId: "job-1", incomingTraceId: UUID });
      expect(context.traceId).not.toBe(UUID);
      expect(context.reusedIncoming).toBe(false);
    }
  });

  it("a page request and an Agent API request keep a valid incoming id", () => {
    for (const openedBy of ["pageRequest", "agentApiRequest", "providerWebhook"] as const) {
      expect(openTrace({ openedBy, bundleId: BUNDLE, incomingTraceId: UUID }).traceId).toBe(UUID);
    }
  });

  it("refuses to open without a bundle id, without a job id for a job, or with a number as the handle", () => {
    expect(() => openTrace({ openedBy: "textWebhook", bundleId: undefined as never })).toThrow(TraceError);
    expect(() => openTrace({ openedBy: "textWebhook", bundleId: { hash: "abc", build: 1 } })).toThrow(
      TraceError,
    );
    expect(() => openTrace({ openedBy: "clockFiring", bundleId: BUNDLE })).toThrow(/job id/u);
    expect(() => openTrace({ openedBy: "sweep", bundleId: BUNDLE })).toThrow(/job id/u);
    expect(() => openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, handleRef: "+15555550100" })).toThrow(
      TraceError,
    );
    expect(() => openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, jobId: "call me please" })).toThrow(
      TraceError,
    );
  });
});

describe("spans the context emits", () => {
  it("every span validates against K-08 v1's span schema, carries the bundle id, and is numbered in order", () => {
    const clock = fakeClock("2026-10-22T16:00:00Z");
    const logged: Span[] = [];
    const context = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE,
      incomingTraceId: UUID,
      handleRef: "handle-alex",
      sink: (span) => logged.push(span),
      now: clock.now,
    });
    arrive(context, "evt-alex-0003", "2026-10-22T16:00:00Z", 820);
    clock.advance(1200);
    context.record({
      hop: "lease",
      ms: 12,
      outcome: "ok",
      decided: { leaseSeconds: 60, bundlePinned: true, tries: 1 },
    });
    context.record({
      hop: "gate",
      ms: 70,
      outcome: "ok",
      businessId: "biz-lees-barbershop",
      limits: [
        { limit: 1, result: "pass", outcome: null },
        { limit: 2, result: "fail", outcome: "held" },
      ],
    });
    context.record({
      hop: "dispatch",
      ms: 270,
      outcome: "ok",
      provider: "linq",
      call: "sendPart",
      attempt: 1,
      got: { row: "out-a7-03-alex-first" },
      limits: [{ limit: 8, result: "pass", outcome: null }],
    });
    context.record({ hop: "providerAccepted", ms: 0, outcome: "ok", provider: "linq", got: { part: 1 } });

    expect(logged).toHaveLength(7);
    expect(context.spans).toEqual(logged);
    logged.forEach((span, index) => {
      expect(schemaErrors("span", span)).toEqual([]);
      expect(span.seq).toBe(index + 1);
      expect(span.trace_id).toBe(UUID);
      expect(span.bundle_id).toEqual(BUNDLE);
      expect(span.handle_ref).toBe("handle-alex");
      expect(span.error_code).toBeNull();
    });
    expect(logged[3]?.at).toBe("2026-10-22T16:00:01.200Z");
    expect(schemaErrors("trace", context.toTrace())).toEqual([]);
  });

  it("a job's spans carry its job id and no turn; a started hop is timed by the clock", () => {
    const clock = fakeClock("2026-10-28T13:00:00.050Z");
    const context = openTrace({
      openedBy: "clockFiring",
      bundleId: BUNDLE,
      jobId: "fire-clock-oq-a7-03-alex-yoga",
      handleRef: "handle-alex",
      now: clock.now,
    });
    const timing = context.start("clockFired");
    clock.advance(15);
    const span = timing.finish({
      outcome: "ok",
      businessId: "biz-yoga-studio",
      got: { clockRow: "clock-oq-a7-03-alex-yoga", kind: "question", firedBy: "alarm" },
      decided: { step: "A7-03", safeDefault: true, decideReads: false },
    });
    expect(span).toMatchObject({
      job_id: "fire-clock-oq-a7-03-alex-yoga",
      turn_id: null,
      at: "2026-10-28T13:00:00.050Z",
      ms: 15,
    });
    expect(schemaErrors("span", span)).toEqual([]);
    const trace = context.toTrace();
    expect(trace).toMatchObject({ opened_by: "clockFiring", turn_id: null, joined_trace_ids: [] });
    expect(schemaErrors("trace", trace)).toEqual([]);
  });

  it("writes one JSON log line per span: level, msg, the span's fields with trace_id, environment, version (ADR-009)", () => {
    const lines: string[] = [];
    const context = openTrace({
      openedBy: "pageRequest",
      bundleId: BUNDLE,
      incomingTraceId: UUID,
      sink: logSink({ environment: "staging", version: "abc123" }, (line) => lines.push(line)),
    });
    context.record({ hop: "pageRequest", ms: 40, outcome: "ok", got: { route: "poll" } });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      msg: "span",
      trace_id: UUID,
      environment: "staging",
      version: "abc123",
      hop: "pageRequest",
    });
    expect(line.bundle_id).toEqual(BUNDLE);
    expect(lines[0]).not.toContain("\n");
  });

  it("refuses a span built from a phone number or message words: nothing is kept or logged", () => {
    const logged: Span[] = [];
    const context = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE,
      handleRef: "handle-sam",
      sink: (span) => logged.push(span),
    });
    const base = { hop: "receive", ms: 10, outcome: "ok", provider: "linq" } as const satisfies SpanFields;
    const phone: SpanFields = { ...base, got: { from: "+15555550100" } };
    const words: SpanFields = { ...base, got: { text: "Barbershop, plumbing, electrical" } };
    const email: SpanFields = { ...base, eventId: "sam@example.com" };
    for (const fields of [phone, words, email]) expect(() => context.record(fields)).toThrow(TraceError);
    expect(() => {
      context.setHandle("+15555550100");
    }).toThrow(TraceError);
    expect(logged).toEqual([]);
    expect(context.spans).toEqual([]);
    // The failed tries took no place in the order.
    expect(context.record({ ...base, got: { kind: "text" } }).seq).toBe(1);
  });

  it("refuses an outside call that names no provider, call or attempt", () => {
    const context = openTrace({ openedBy: "pageRequest", bundleId: BUNDLE });
    expect(() => context.record({ hop: "portCall", ms: 5, outcome: "ok" })).toThrow(/provider is required/u);
    const span = context.record({
      hop: "portCall",
      ms: 5,
      outcome: "ok",
      provider: "google_places",
      call: "search",
      attempt: 1,
    });
    expect(schemaErrors("span", span)).toEqual([]);
  });

  it("a trace with no span has no trace document yet", () => {
    expect(() => openTrace({ openedBy: "sweep", bundleId: BUNDLE, jobId: "sweep-1" }).toTrace()).toThrow(
      TraceError,
    );
  });
});

type Texts = [TraceContext, TraceContext, TraceContext];

describe("a batch of three texts (CQ-06; trace-batch-three-texts.json)", () => {
  /** Three texts of Alex's, arriving at 0 s, 2 s and 4 s; the batch closes at the third text's safety read plus. */
  function threeTexts(): {
    contexts: Texts;
    turnId: string;
    result: ReturnType<typeof closeBatch>;
    clock: ReturnType<typeof fakeClock>;
  } {
    const clock = fakeClock("2026-10-22T16:00:04.900Z");
    const sequence = ids("trace-alex-0003", "trace-alex-0004", "trace-alex-0005");
    const open = (): TraceContext =>
      openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE,
        handleRef: "handle-alex",
        newId: sequence,
        now: clock.now,
      });
    const first = open();
    const second = open();
    const third = open();
    const contexts: Texts = [first, second, third];
    arrive(first, "evt-alex-0003", "2026-10-22T16:00:00Z", 820);
    arrive(second, "evt-alex-0004", "2026-10-22T16:00:02Z", 790);
    arrive(third, "evt-alex-0005", "2026-10-22T16:00:04Z", 680);
    const turnId = "turn-alex-three-1";
    const result = closeBatch({
      turnId,
      closedBy: "thirdText",
      texts: [
        { context: first, eventId: "evt-alex-0003" },
        { context: second, eventId: "evt-alex-0004" },
        { context: third, eventId: "evt-alex-0005" },
      ],
    });
    return { contexts, turnId, result, clock };
  }

  it("the turn carries the first text's trace id and lists the others", () => {
    const { contexts, turnId, result } = threeTexts();
    expect(result).toEqual({
      turnTraceId: "trace-alex-0003",
      joinedTraceIds: ["trace-alex-0004", "trace-alex-0005"],
    });
    const turnTrace = contexts[0].toTrace();
    expect(turnTrace).toMatchObject({
      trace_id: "trace-alex-0003",
      turn_id: turnId,
      joined_trace_ids: ["trace-alex-0004", "trace-alex-0005"],
    });
  });

  it("each text's trace ends at 'joined turn T', and the first text's batch span matches the fixture", () => {
    const { contexts, turnId } = threeTexts();
    const fixture = eventTraceFixture("trace-batch-three-texts.json") as { traces: Trace[] };
    contexts.forEach((context, index) => {
      const trace = context.toTrace();
      const expected = fixture.traces[index];
      const last = trace.spans[trace.spans.length - 1];
      const expectedBatch = expected?.spans.find((span) => span.hop === "batch");
      expect(last?.hop).toBe("batch");
      expect(last?.turn_id).toBe(turnId);
      expect(last?.decided).toEqual(expectedBatch?.decided);
      expect(trace.turn_id).toBe(expected?.turn_id);
      expect(trace.joined_trace_ids).toEqual(expected?.joined_trace_ids);
      if (index === 0) {
        expect(last?.outcome).toBe("ok");
        expect(last?.got).toEqual(expectedBatch?.got);
        expect(context.isEnded).toBe(false);
      } else {
        expect(last?.outcome).toBe("joinedTurn");
        expect(last?.event_id).toBe(expectedBatch?.event_id);
        expect(context.isEnded).toBe(true);
        expect(trace.spans.filter((span) => span.outcome === "joinedTurn")).toHaveLength(1);
      }
    });
  });

  it("the batch span's time is the wait, from the end of the text's last hop to the close", () => {
    const { contexts } = threeTexts();
    const firstBatch = contexts[0].spans.find((span) => span.hop === "batch");
    // The first text's safety read ended at 16:00:01.020; the batch closed at 16:00:04.900.
    expect(firstBatch).toMatchObject({ at: "2026-10-22T16:00:01.020Z", ms: 3880 });
  });

  it("a joined trace takes no span after it ended, and the first text's trace carries on", () => {
    const { contexts } = threeTexts();
    const joined = contexts[1];
    expect(() => joined.record({ hop: "lease", ms: 1, outcome: "ok" })).toThrow(/ended/u);
    const turn = contexts[0];
    const span = turn.record({
      hop: "lease",
      ms: 12,
      outcome: "ok",
      rows: [{ table: "turns", id: "turn-alex-three-1" }],
    });
    expect(span.turn_id).toBe("turn-alex-three-1");
  });

  it("the three traces together are a K-08 v1 trace set, valid against the schema", () => {
    const { contexts } = threeTexts();
    const set = { traces: contexts.map((context) => context.toTrace()) };
    expect(schemaErrors("traceSet", set)).toEqual([]);
    for (const trace of set.traces) {
      expect(trace.spans.map((span) => span.seq)).toEqual(trace.spans.map((_, index) => index + 1));
    }
  });

  it("the turn's reply time runs from the last text's arrival to the first part accepted", () => {
    const { contexts, clock } = threeTexts();
    const [first, second, third] = contexts;
    clock.set("2026-10-22T16:00:10.530Z");
    first.record({
      hop: "dispatch",
      ms: 270,
      outcome: "ok",
      provider: "linq",
      call: "sendPart",
      attempt: 1,
      got: { row: "out-a7-03-alex-first" },
    });
    first.record({
      hop: "providerAccepted",
      at: "2026-10-22T16:00:10.800Z",
      ms: 0,
      outcome: "ok",
      provider: "linq",
      got: { part: 1 },
    });
    const reply = replyTimeOf(first.toTrace(), [second.toTrace(), third.toTrace()]);
    expect(schemaErrors("replyTime", reply)).toEqual([]);
    expect(reply).toMatchObject({
      trace_id: "trace-alex-0003",
      turn_id: "turn-alex-three-1",
      texts: 3,
      last_text_event_id: "evt-alex-0005",
      last_text_at: "2026-10-22T16:00:04Z",
      first_part_row_id: "out-a7-03-alex-first",
      first_part_accepted_at: "2026-10-22T16:00:10.800Z",
      ms: 6800,
    });
  });

  it("refuses a batch of no texts, two texts on one trace, a text already in a turn, or an ended trace", () => {
    expect(() => closeBatch({ turnId: "turn-1", closedBy: "quiet", texts: [] })).toThrow(TraceError);
    const lone = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE });
    expect(() =>
      closeBatch({
        turnId: "turn-1",
        closedBy: "quiet",
        texts: [
          { context: lone, eventId: "evt-1" },
          { context: lone, eventId: "evt-2" },
        ],
      }),
    ).toThrow(/share one trace id/u);
    expect(
      closeBatch({ turnId: "turn-1", closedBy: "quiet", texts: [{ context: lone, eventId: "evt-1" }] }),
    ).toEqual({
      turnTraceId: lone.traceId,
      joinedTraceIds: [],
    });
    expect(() =>
      closeBatch({ turnId: "turn-2", closedBy: "quiet", texts: [{ context: lone, eventId: "evt-1" }] }),
    ).toThrow(/already carries a turn/u);
  });

  it("a single text's batch is a turn of one: no trace joins it", () => {
    const only = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, handleRef: "handle-alex" });
    arrive(only, "evt-alex-0001", "2026-10-22T15:00:00Z", 700);
    closeBatch({
      turnId: "turn-alex-1",
      closedBy: "quiet",
      texts: [{ context: only, eventId: "evt-alex-0001" }],
    });
    const trace = only.toTrace();
    expect(trace.joined_trace_ids).toEqual([]);
    expect(trace.turn_id).toBe("turn-alex-1");
    expect(schemaErrors("trace", trace)).toEqual([]);
  });

  it("a single text's batch span is trace-skeleton.json's: closed by three seconds of quiet, the turn, and no other trace named", () => {
    const skeleton = eventTraceFixture("trace-skeleton.json") as Trace;
    const drawn = skeleton.spans.find((span) => span.hop === "batch");
    const only = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, handleRef: "handle-sam" });
    arrive(only, "evt-sam-0000", "2026-10-19T14:01:50.100Z", 880);
    closeBatch({
      turnId: "turn-s1-01-sam-join",
      closedBy: "threeSecondsQuiet",
      texts: [{ context: only, eventId: "evt-sam-0000" }],
    });
    const batch = only.spans.find((span) => span.hop === "batch");
    expect(batch?.got).toEqual(drawn?.got);
    expect(batch?.decided).toEqual(drawn?.decided);
    expect(batch?.decided).not.toHaveProperty("joinedTraces");
    expect(schemaErrors("trace", only.toTrace())).toEqual([]);
  });

  it("the batch window's texts (T-1108): each span starts where the window says the text's last hop ended and lasts to the close it names; texts under one trace id share its span", () => {
    const clock = fakeClock("2026-10-22T16:00:09Z");
    const sequence = ids("trace-alex-0003", "trace-alex-0004");
    const open = (): TraceContext =>
      openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, newId: sequence, now: clock.now });
    const first = open();
    const second = open();
    const closedAt = Date.parse("2026-10-22T16:00:04Z");
    closeBatch({
      turnId: "turn-alex-three-1",
      closedBy: "thirdText",
      closedAt,
      // The second trace carried two texts (handed in under one trace id): three texts, two traces.
      eventIds: ["evt-alex-0003", "evt-alex-0004", "evt-alex-0005"],
      texts: [
        { context: first, eventId: "evt-alex-0003", waitedFrom: Date.parse("2026-10-22T16:00:01.020Z") },
        // Its safety read ended after the close: the span starts there and takes no time.
        { context: second, eventId: "evt-alex-0004", waitedFrom: Date.parse("2026-10-22T16:00:04.880Z") },
      ],
    });
    expect(first.spans).toMatchObject([
      {
        hop: "batch",
        at: "2026-10-22T16:00:01.020Z",
        ms: 2980,
        outcome: "ok",
        got: { texts: 3, eventIds: ["evt-alex-0003", "evt-alex-0004", "evt-alex-0005"] },
        decided: { closedBy: "thirdText", turn: "turn-alex-three-1", joinedTraces: ["trace-alex-0004"] },
      },
    ]);
    expect(second.spans).toMatchObject([
      {
        hop: "batch",
        at: "2026-10-22T16:00:04.880Z",
        ms: 0,
        outcome: "joinedTurn",
        event_id: "evt-alex-0004",
        decided: { turn: "turn-alex-three-1", turnTrace: "trace-alex-0003" },
      },
    ]);
    for (const context of [first, second]) expect(schemaErrors("trace", context.toTrace())).toEqual([]);
  });
});

describe("one run by seq across a trace's writers (T-1108; K-08 v1 README: a trace is read by ordering by seq)", () => {
  /** A writer's own context over one trace id, as the gateway, the safety read, the batch window and the pin each open one. */
  function writer(
    traceId: string,
    logged: Span[],
    clock = fakeClock("2026-10-19T14:01:50.100Z"),
  ): TraceContext {
    return openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE,
      incomingTraceId: traceId,
      sink: (span) => {
        logged.push(span);
      },
      now: clock.now,
    });
  }
  const hop = { ms: 1, outcome: "ok" } as const;

  it("a trace nobody began: each context counts its own spans from 1, as before", () => {
    const traceId = "0a1b2c3d-0000-4000-8000-000000000001";
    const logged: Span[] = [];
    expect(seqOf(traceId)).toBeNull();
    expect(writer(traceId, logged).record({ hop: "guard", ...hop }).seq).toBe(1);
    expect(writer(traceId, logged).record({ hop: "guard", ...hop }).seq).toBe(1);
    expect(seqOf(traceId)).toBeNull();
  });

  it("a trace begun: every context over its id takes the next place, after the places another writer took before", () => {
    const traceId = "0a1b2c3d-0000-4000-8000-000000000002";
    const logged: Span[] = [];
    // The actor's side: the gateway's receive and scrub took places 1 and 2 (its hand-off's seqBefore).
    beginSeq(traceId, 2);
    const safety = writer(traceId, logged);
    const batch = writer(traceId, logged);
    const turn = writer(traceId, logged);
    safety.record({ hop: "guard", ...hop });
    batch.record({ hop: "batch", ...hop });
    turn.record({ hop: "lease", ...hop });
    turn.record({ hop: "guard", ...hop });
    safety.record({ hop: "guard", ...hop });
    expect(logged.map((span) => [span.seq, span.span_id])).toEqual([
      [3, `${traceId}:03`],
      [4, `${traceId}:04`],
      [5, `${traceId}:05`],
      [6, `${traceId}:06`],
      [7, `${traceId}:07`],
    ]);
    expect(seqOf(traceId)).toBe(7);
    // Another trace's count is its own.
    const other = "0a1b2c3d-0000-4000-8000-000000000003";
    beginSeq(other);
    expect(writer(other, logged).record({ hop: "guard", ...hop }).seq).toBe(1);
    expect(seqOf(traceId)).toBe(7);
  });

  it("a count brought back is never lowered, and a trace begun again starts again", () => {
    const traceId = "0a1b2c3d-0000-4000-8000-000000000004";
    const logged: Span[] = [];
    beginSeq(traceId, 2);
    writer(traceId, logged).record({ hop: "guard", ...hop });
    // A restart brings back what was kept: an older count changes nothing, a newer one moves it on.
    resumeSeq(traceId, 1);
    expect(seqOf(traceId)).toBe(3);
    resumeSeq(traceId, 9);
    expect(writer(traceId, logged).record({ hop: "guard", ...hop }).seq).toBe(10);
    // A trace nobody began here is brought back at its kept count.
    const evicted = "0a1b2c3d-0000-4000-8000-000000000005";
    resumeSeq(evicted, 4);
    expect(writer(evicted, logged).record({ hop: "lease", ...hop }).seq).toBe(5);
    beginSeq(traceId, 0);
    expect(writer(traceId, logged).record({ hop: "guard", ...hop }).seq).toBe(1);
    // A count that is no whole number from 0 begins at none.
    beginSeq(traceId, -3);
    expect(seqOf(traceId)).toBe(0);
  });

  it("a hop takes its place as it starts: a span recorded inside it comes after it, so by seq the spans are in start order", () => {
    const traceId = "0a1b2c3d-0000-4000-8000-000000000006";
    const logged: Span[] = [];
    const clock = fakeClock("2026-10-19T14:01:59.530Z");
    beginSeq(traceId);
    const gateway = writer(traceId, logged, clock);
    const actor = writer(traceId, logged, clock);
    // The gateway's receive starts, the actor's first hop is recorded inside it, then receive ends.
    const receive = gateway.start("receive");
    const scrub = gateway.reserve();
    clock.advance(5);
    actor.record({ hop: "guard", ...hop });
    clock.advance(5);
    receive.finish({ outcome: "ok", provider: "linq" });
    gateway.record({ hop: "scrub", at: "2026-10-19T14:01:59.531Z", ms: 1, outcome: "ok", seq: scrub });
    // Written last, numbered first.
    expect(logged.map((span) => [span.seq, span.hop])).toEqual([
      [3, "guard"],
      [1, "receive"],
      [2, "scrub"],
    ]);
    const bySeq = [...logged].sort((a, b) => a.seq - b.seq);
    expect(bySeq.map((span) => span.hop)).toEqual(["receive", "scrub", "guard"]);
    bySeq.forEach((span, place) => {
      const before = bySeq[place - 1];
      if (before !== undefined) expect(Date.parse(span.at)).toBeGreaterThanOrEqual(Date.parse(before.at));
    });
    // The same in one writer alone, with no shared count (the dispatcher's dispatch around providerAccepted).
    const alone = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, now: clock.now });
    const dispatch = alone.start("dispatch");
    clock.advance(270);
    alone.record({ hop: "providerAccepted", ms: 0, outcome: "ok", provider: "linq" });
    dispatch.finish({ outcome: "ok", provider: "linq", call: "sendPart", attempt: 1 });
    expect([...alone.spans].sort((a, b) => a.seq - b.seq).map((span) => [span.seq, span.hop])).toEqual([
      [1, "dispatch"],
      [2, "providerAccepted"],
    ]);
  });

  it("a refused span takes no place on a shared count either", () => {
    const traceId = "0a1b2c3d-0000-4000-8000-000000000007";
    const logged: Span[] = [];
    beginSeq(traceId, 2);
    const context = writer(traceId, logged);
    expect(() => context.record({ hop: "guard", ...hop, got: { text: "two words" } })).toThrow(TraceError);
    expect(seqOf(traceId)).toBe(2);
    expect(context.record({ hop: "guard", ...hop }).seq).toBe(3);
  });

  it("a place taken before a span's context is open (takeSeq) is that span's: a batch span written once its bundle is known comes before the lease span recorded meanwhile", () => {
    const turnTrace = "0a1b2c3d-0000-4000-8000-000000000008";
    const joinedTrace = "0a1b2c3d-0000-4000-8000-000000000009";
    const logged: Span[] = [];
    // A trace nobody began has no place to take: its span takes its own context's next place, as before.
    expect(takeSeq(turnTrace)).toBeUndefined();
    expect(seqOf(turnTrace)).toBeNull();
    // Each text's receive, scrub and safety read took places 1 to 3.
    beginSeq(turnTrace, 3);
    beginSeq(joinedTrace, 3);
    const turnPlace = takeSeq(turnTrace);
    const joinedPlace = takeSeq(joinedTrace);
    if (turnPlace === undefined || joinedPlace === undefined) throw new Error("no place taken");
    expect([turnPlace, joinedPlace, seqOf(turnTrace), seqOf(joinedTrace)]).toEqual([4, 4, 4, 4]);
    // The pin answers and records its lease span, at the next place; then the batch spans are written.
    const pin = writer(turnTrace, logged);
    pin.setTurn("turn-alex-three-1");
    pin.record({ hop: "lease", ...hop });
    closeBatch({
      turnId: "turn-alex-three-1",
      closedBy: "thirdText",
      texts: [
        { context: writer(turnTrace, logged), eventId: "evt-alex-0003", seq: turnPlace },
        { context: writer(joinedTrace, logged), eventId: "evt-alex-0004", seq: joinedPlace },
      ],
    });
    expect(logged.map((span) => [span.trace_id, span.seq, span.hop, span.outcome])).toEqual([
      [turnTrace, 5, "lease", "ok"],
      [turnTrace, 4, "batch", "ok"],
      [joinedTrace, 4, "batch", "joinedTurn"],
    ]);
    expect([seqOf(turnTrace), seqOf(joinedTrace)]).toEqual([5, 4]);
  });

  it("a webhook's door shares its own count once the signature has passed: the places it took alone stand, and every writer goes on from them", () => {
    const logged: Span[] = [];
    const clock = fakeClock("2026-10-19T14:01:50.100Z");
    const door = openTrace({
      openedBy: "textWebhook",
      bundleId: BUNDLE,
      sink: (span) => {
        logged.push(span);
      },
      now: clock.now,
    });
    // Until the signature has passed the door's context counts alone: nothing is kept for its trace.
    const receive = door.start("receive");
    expect(seqOf(door.traceId)).toBeNull();
    door.shareSeq();
    expect(seqOf(door.traceId)).toBe(1);
    const scrub = door.reserve();
    // Another writer in this isolate (a receipt's hooks, the handle's actor) goes on from the door's places.
    writer(door.traceId, logged, clock).record({ hop: "guard", ...hop });
    receive.finish({ outcome: "ok", provider: "linq" });
    door.record({ hop: "scrub", ms: 1, outcome: "ok", seq: scrub });
    expect([...logged].sort((a, b) => a.seq - b.seq).map((span) => [span.seq, span.hop])).toEqual([
      [1, "receive"],
      [2, "scrub"],
      [3, "guard"],
    ]);
    // Shared already: sharing again changes nothing.
    door.shareSeq();
    expect(seqOf(door.traceId)).toBe(3);
  });

  it("a trace id is one count however it is written, and a context's own trace document reads in order by seq", () => {
    const traceId = "0A1B2C3D-0000-4000-8000-00000000000A";
    const logged: Span[] = [];
    beginSeq(` ${traceId} `, 2);
    expect(seqOf(traceId.toLowerCase())).toBe(2);
    const context = writer(traceId, logged);
    expect(context.traceId).toBe(traceId.toLowerCase());
    const dispatch = context.start("dispatch");
    context.record({ hop: "providerAccepted", ms: 0, outcome: "ok", provider: "linq" });
    dispatch.finish({ outcome: "ok", provider: "linq", call: "sendPart", attempt: 1 });
    // Kept in the order written; the trace document reads by seq (K-08: "the spans of one trace id in order").
    expect(context.spans.map((span) => [span.seq, span.hop])).toEqual([
      [4, "providerAccepted"],
      [3, "dispatch"],
    ]);
    const trace = context.toTrace();
    expect(trace.spans.map((span) => [span.seq, span.hop])).toEqual([
      [3, "dispatch"],
      [4, "providerAccepted"],
    ]);
    expect(schemaErrors("trace", trace)).toEqual([]);
  });

  it("a batch span counts an id that is no label and does not name it, so the span is kept", () => {
    const first = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE });
    // A trace id with no letter in it, and a provider's event id of digits alone: each reads as a number, which no span
    // may carry (K-08: never a long run of digits).
    const digits = "11111111-2222-4333-8444-555555555555";
    const joined = openTrace({ openedBy: "textWebhook", bundleId: BUNDLE, newId: () => digits });
    const result = closeBatch({
      turnId: "turn-alex-9",
      closedBy: "thirdText",
      texts: [
        { context: first, eventId: "evt-alex-0009" },
        { context: joined, eventId: "0000000" },
      ],
    });
    expect(result).toEqual({ turnTraceId: first.traceId, joinedTraceIds: [digits] });
    expect(first.spans.map((span) => [span.hop, span.got, span.decided])).toEqual([
      [
        "batch",
        { texts: 2, eventIds: ["evt-alex-0009"] },
        { closedBy: "thirdText", turn: "turn-alex-9", joinedTraces: [] },
      ],
    ]);
    // The trace itself still lists the text that joined it.
    expect(first.toTrace().joined_trace_ids).toEqual([digits]);
    expect(joined.spans).toMatchObject([{ hop: "batch", outcome: "joinedTurn" }]);
    expect(joined.spans[0]).not.toHaveProperty("event_id");
    for (const context of [first, joined]) expect(schemaErrors("trace", context.toTrace())).toEqual([]);
  });
});
