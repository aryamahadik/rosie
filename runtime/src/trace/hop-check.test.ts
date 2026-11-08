// Tests of the hop check (T-260; K-08 v1; D-017 "every hop once, in order"). K-08's own trace fixtures pass it against
// their own hops; each rule is then broken on a copy, one at a time, and named. The leak check finds K-08's refused raw
// phone and raw words, and nothing in K-08's accepted traces. Test values only: the fixtures' sample cast and the 555-01xx
// range (rule 9).

import { describe, expect, it } from "vitest";

import { checkHops, hopsOfTrace, leaks, seqProblems, spansOfLogLines, spansOfTrace } from "./hop-check";
import { eventTraceFixture } from "./test-support";
import type { Hop, Span, Trace } from "./types";

const skeleton = eventTraceFixture("trace-skeleton.json") as Trace;
const duplicate = eventTraceFixture("trace-duplicate-webhook.json") as Trace;
const batch = (eventTraceFixture("trace-batch-three-texts.json") as { traces: Trace[] }).traces;
const clockFire = eventTraceFixture("trace-clock-fire.json") as Trace;

/** A copy of a trace's spans (a test changes its copy, never the fixture). */
const spansOf = (trace: Trace): Span[] => structuredClone(trace.spans);

const nth = (spans: Span[], place: number): Span => {
  const span = spans[place];
  if (span === undefined) throw new Error(`no span at place ${String(place)}`);
  return span;
};

describe("K-08's trace fixtures pass the hop check against their own hops", () => {
  it.each([
    ["trace-skeleton.json", skeleton],
    ["trace-duplicate-webhook.json", duplicate],
    ["trace-clock-fire.json", clockFire],
    ["trace-batch-three-texts.json, the turn's trace", batch[0]],
    ["trace-batch-three-texts.json, the second text's", batch[1]],
    ["trace-batch-three-texts.json, the third text's", batch[2]],
  ])("%s", (_name, trace) => {
    if (trace === undefined) throw new Error("the fixture has no such trace");
    const report = checkHops(spansOfTrace(trace.spans, trace.trace_id), {
      traceId: trace.trace_id,
      expected: hopsOfTrace(trace),
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.hops).toEqual(hopsOfTrace(trace));
    expect(seqProblems(trace.spans)).toEqual([]);
  });

  it("reads trace-skeleton.json's hops in seq order", () => {
    expect(hopsOfTrace(skeleton)).toEqual([
      "receive",
      "scrub",
      "safetyRead",
      "batch",
      "lease",
      "guard",
      "frontier",
      "decideReads",
      "gate",
      "commit",
      "compose",
      "fillAndChecks",
      "dispatch",
      "providerAccepted",
      "delivered",
      "clockArmed",
    ]);
  });
});

describe("each rule broken on a copy of trace-skeleton.json is named", () => {
  const expected = hopsOfTrace(skeleton);
  const judge = (spans: Span[], extra: Partial<Parameters<typeof checkHops>[1]> = {}) =>
    checkHops(spansOfTrace(spans, skeleton.trace_id), { traceId: skeleton.trace_id, expected, ...extra });

  it("a hop that runs twice is repeated", () => {
    const spans = spansOf(skeleton);
    spans.push({ ...nth(spans, 4), span_id: "span-sam-0000-17", seq: 17, at: "2026-10-19T14:02:01Z" });
    expect(judge(spans).problems).toEqual([
      { kind: "repeated", hop: "lease", message: "hop lease runs 2 times: every hop runs once" },
    ]);
  });

  it("a hop with no span is missing, and a hop the list does not hold is unexpected", () => {
    const spans = spansOf(skeleton).filter((span) => span.hop !== "guard");
    spans.push({ ...nth(spans, 6), hop: "reread", span_id: "span-sam-0000-17", seq: 17 });
    expect(judge(spans).problems.map((problem) => [problem.kind, problem.hop])).toEqual([
      ["missing", "guard"],
      ["unexpected", "reread"],
    ]);
  });

  it("a hop that starts before one the turn order puts first is out of order", () => {
    const spans = spansOf(skeleton);
    nth(spans, 5).at = "2026-10-19T14:01:53.000Z"; // the guard now starts before the lease (14:01:53.100)
    const report = judge(spans);
    expect(report.problems).toEqual([
      {
        kind: "outOfOrder",
        hop: "guard",
        message: "hop guard starts before hop lease, which the turn order puts first",
      },
    ]);
  });

  it("hops that start at one instant are in order", () => {
    const spans = spansOf(skeleton);
    nth(spans, 5).at = nth(spans, 4).at;
    expect(judge(spans).problems).toEqual([]);
  });

  it("a span under another trace id, or naming another bundle, is named", () => {
    const spans = spansOf(skeleton);
    nth(spans, 2).trace_id = "trace-sam-9999";
    nth(spans, 7).bundle_id = { hash: "a".repeat(64), build: 2 };
    const report = checkHops(spans, { traceId: skeleton.trace_id, expected });
    expect(report.problems.map((problem) => [problem.kind, problem.hop])).toEqual([
      ["traceId", "safetyRead"],
      ["bundleId", "decideReads"],
    ]);
  });

  it("a hop not written yet leaves the check; once it shows up it is unexpected", () => {
    const withoutScrub = spansOf(skeleton).filter((span) => span.hop !== "scrub");
    const notWritten: Hop[] = ["scrub"];
    const report = judge(withoutScrub, { notWritten });
    expect(report.ok).toBe(true);
    expect(report.judged).not.toContain("scrub");
    expect(judge(spansOf(skeleton), { notWritten }).problems).toEqual([
      {
        kind: "unexpected",
        hop: "scrub",
        message: "hop scrub is written now: take it off the hops not written yet",
      },
    ]);
  });

  it("extra spans are set aside from the count and handed back", () => {
    const spans = spansOf(skeleton);
    const second: Span = { ...nth(spans, 0), span_id: "span-sam-0000-00", got: { door: "handleActor" } };
    spans.splice(1, 0, second);
    expect(judge(spans).problems.map((problem) => problem.kind)).toEqual(["repeated"]);
    const report = judge(spans, { extra: (span) => span.got?.door === "handleActor" });
    expect(report.ok).toBe(true);
    expect(report.extra).toEqual([second]);
  });
});

describe("seq is one run 1, 2, 3 ...", () => {
  it("a seq taken twice, or a place left out, is named", () => {
    const spans = spansOf(skeleton).slice(0, 4);
    nth(spans, 2).seq = 1;
    nth(spans, 3).seq = 5;
    expect(seqProblems(spans)).toEqual([
      "seq 1 is taken twice, by hop receive and hop safetyRead",
      "seq 5 stands where 3 comes next",
    ]);
  });
});

describe("spans are read from log lines", () => {
  it("keeps the lines whose msg is span, without ADR-009's line fields, in the order written", () => {
    const first = nth(spansOf(skeleton), 0);
    const second = nth(spansOf(skeleton), 1);
    const lines = [
      JSON.stringify({ level: "info", msg: "span", ...first, environment: "staging", version: "test-sha" }),
      "not json",
      JSON.stringify({ level: "info", msg: "health", trace_id: first.trace_id }),
      { level: "info", msg: "span", ...second, environment: "staging", version: "test-sha" },
      42,
    ];
    expect(spansOfLogLines(lines)).toEqual([first, second]);
  });
});

describe("no span carries a raw phone number or words", () => {
  const CAST_NUMBERS = ["+15555550100", "15555550100", "+15555550101", "15555550101"];
  const SAM_WORDS = "Barbershop, plumbing, electrical";

  it("finds K-08's refused raw phone and raw words, naming the span, never the secret", () => {
    const phone = eventTraceFixture("invalid/refuse-raw-phone-in-span.json") as Span;
    const words = eventTraceFixture("invalid/refuse-raw-text-in-span.json") as Span;
    expect(leaks([phone])).toEqual(["hop receive (seq 1) of trace trace-sam-0000 holds a raw phone number"]);
    expect(leaks([words], [SAM_WORDS])).toEqual([
      "hop receive (seq 1) of trace trace-sam-0001 holds secret 1",
    ]);
    expect(leaks([words], [SAM_WORDS]).join(" ")).not.toContain(SAM_WORDS);
  });

  it("reads each line of a secret, ignoring case", () => {
    const words = eventTraceFixture("invalid/refuse-raw-text-in-span.json") as Span;
    expect(leaks([words], [`Nothing like this\n${SAM_WORDS.toUpperCase()}`])).toEqual([
      "hop receive (seq 1) of trace trace-sam-0001 holds secret 1",
    ]);
  });

  it("finds nothing in K-08's accepted traces", () => {
    const all = [skeleton, duplicate, clockFire, ...batch].flatMap((trace) => trace.spans);
    expect(leaks(all, [...CAST_NUMBERS, SAM_WORDS])).toEqual([]);
  });
});
