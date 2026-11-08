// The hop checker against K-08 v1's frozen fixtures (T-465, "Proves it with"): trace-skeleton.json passes, every hop
// once and in order; a copy with any one hop missing or repeated fails, naming that hop; trace-duplicate-webhook.json is
// read as dropped at receipt. Run by `npm run test:e2e -- _driver`.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Hop, Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { CONTRACTS_ROOT } from "../../contract/_harness";
import { SKELETON_HOPS, asTrace, checkHops, checkRepeat, readReceipt } from "./index";

const FIXTURES = path.join(CONTRACTS_ROOT, "event-trace", "fixtures");

/** A K-08 v1 fixture, read as a trace (the schema checks it first). */
function fixture(name: string): Trace {
  return asTrace(JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")));
}

const skeleton = fixture("trace-skeleton.json");
const duplicate = fixture("trace-duplicate-webhook.json");

/** A copy of `trace` with these spans; numbered 1, 2, 3 ... again unless `renumber` is false. */
function withSpans(trace: Trace, spans: readonly Span[], renumber = true): Trace {
  const numbered = spans.map((span, index) => ({
    ...structuredClone(span),
    seq: renumber ? index + 1 : span.seq,
  }));
  const [first, ...rest] = numbered;
  if (first === undefined) throw new Error("a trace has at least one span");
  return { ...structuredClone(trace), spans: [first, ...rest] };
}

function withoutHop(trace: Trace, hop: Hop, renumber = true): Trace {
  return withSpans(
    trace,
    trace.spans.filter((span) => span.hop !== hop),
    renumber,
  );
}

/** The hop run a second time, right after the first, as a span of its own. */
function withHopRepeated(trace: Trace, hop: Hop): Trace {
  return withSpans(
    trace,
    trace.spans.flatMap((span) =>
      span.hop === hop ? [span, { ...span, span_id: `${span.span_id}-again` }] : [span],
    ),
  );
}

/** The hop order of K-08 v1's `hop` definition, which lists the hops as a turn runs them (README hop table). */
function k08HopOrder(): string[] {
  const schema = JSON.parse(
    readFileSync(path.join(CONTRACTS_ROOT, "event-trace", "event-trace.v1.schema.json"), "utf8"),
  ) as { $defs: { hop: { enum: string[] } } };
  return schema.$defs.hop.enum;
}

describe("the walking skeleton's hops", () => {
  it("are 16 K-08 v1 hops, each once, in the order K-08 lists them (02-contracts section 11)", () => {
    const order = k08HopOrder();
    expect(SKELETON_HOPS).toHaveLength(16);
    expect(new Set(SKELETON_HOPS).size).toBe(SKELETON_HOPS.length);
    const places = SKELETON_HOPS.map((hop) => order.indexOf(hop));
    expect(places.every((place) => place >= 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
  });
});

describe("the hop checker", () => {
  it("passes trace-skeleton.json: every hop once, in order, under one trace id and one bundle id", () => {
    const check = checkHops(skeleton);
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.traceId).toBe("trace-sam-0000");
    expect(check.hops).toEqual([...SKELETON_HOPS]);
  });

  it.each(SKELETON_HOPS)("fails a copy of trace-skeleton.json without %s, naming that hop", (hop) => {
    const copy = withoutHop(skeleton, hop);
    expect(asTrace(copy)).toBe(copy);
    const check = checkHops(copy);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      { kind: "missing", hop, message: `hop ${hop} is missing: every hop runs once` },
    ]);
  });

  it.each(SKELETON_HOPS)("fails a copy of trace-skeleton.json with %s repeated, naming that hop", (hop) => {
    const copy = withHopRepeated(skeleton, hop);
    expect(asTrace(copy)).toBe(copy);
    const check = checkHops(copy);
    const seq = SKELETON_HOPS.indexOf(hop) + 1;
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      {
        kind: "repeated",
        hop,
        message: `hop ${hop} runs 2 times (seq ${String(seq)}, ${String(seq + 1)}): every hop runs once`,
      },
    ]);
  });

  it("names the missing hop when its span is gone from the log and the seqs keep the gap", () => {
    const check = checkHops(withoutHop(skeleton, "guard", false));
    expect(check.ok).toBe(false);
    expect(check.problems).toContainEqual({
      kind: "missing",
      hop: "guard",
      message: "hop guard is missing: every hop runs once",
    });
    expect(check.problems.map((problem) => problem.kind)).toContain("seq");
  });

  it("fails two hops run in the wrong order, naming them", () => {
    const spans = [...skeleton.spans];
    const lease = spans[4];
    const guard = spans[5];
    if (lease === undefined || guard === undefined) throw new Error("trace-skeleton.json has 16 spans");
    spans[4] = { ...guard, at: lease.at };
    spans[5] = { ...lease, at: guard.at };
    const check = checkHops(withSpans(skeleton, spans));
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([
      {
        kind: "outOfOrder",
        hop: "lease",
        message: "hop lease (seq 6) runs after hop guard (seq 5), but the turn order puts lease first",
      },
    ]);
  });

  it("fails a hop the skeleton does not run, naming it", () => {
    const spans = skeleton.spans.flatMap((span) =>
      span.hop === "decideReads"
        ? [span, { ...span, hop: "reread" as const, span_id: "span-sam-0000-08b" }]
        : [span],
    );
    const check = checkHops(withSpans(skeleton, spans));
    expect(check.problems).toEqual([
      { kind: "unexpected", hop: "reread", message: "hop reread (seq 9) is not one of this trace's hops" },
    ]);
  });

  it("fails a span under another trace id, another bundle, or starting before the hop before it", () => {
    const spans = skeleton.spans.map((span) => {
      if (span.hop === "frontier") return { ...span, trace_id: "trace-other-0001" };
      if (span.hop === "gate") return { ...span, bundle_id: { hash: "a".repeat(64), build: 2 } };
      if (span.hop === "compose") return { ...span, at: "2026-10-19T14:01:50Z" };
      return span;
    });
    const check = checkHops(withSpans(skeleton, spans));
    expect(check.problems.map((problem) => [problem.kind, problem.hop])).toEqual([
      ["traceId", "frontier"],
      ["bundleId", "gate"],
      ["time", "compose"],
    ]);
  });

  it("checks against the hops it is given: a receive-only trace passes as receive", () => {
    const check = checkHops(duplicate, ["receive"]);
    expect(check.problems).toEqual([]);
    expect(check.hops).toEqual(["receive"]);
  });

  it("fails trace-duplicate-webhook.json as a skeleton turn, naming each hop that never ran", () => {
    const check = checkHops(duplicate);
    expect(check.problems.map((problem) => [problem.kind, problem.hop])).toEqual(
      SKELETON_HOPS.slice(1).map((hop) => ["missing", hop]),
    );
  });
});

describe("reading a webhook's receipt", () => {
  it("reads trace-duplicate-webhook.json as dropped at receipt: a known event id, no hop after receive", () => {
    expect(readReceipt(duplicate)).toEqual({
      traceId: "trace-alex-0008-repeat",
      eventId: "evt-alex-0008",
      outcome: "dropped",
      signatureValid: true,
      knownEventId: true,
      answered: 200,
      firstTraceId: "trace-alex-0008",
      hopsAfter: [],
      droppedAtReceipt: true,
      repeatedWebhook: true,
    });
  });

  it("reads trace-skeleton.json as taken at receipt, with every later hop after it", () => {
    const receipt = readReceipt(skeleton);
    expect(receipt.droppedAtReceipt).toBe(false);
    expect(receipt.repeatedWebhook).toBe(false);
    expect(receipt.knownEventId).toBe(false);
    expect(receipt.signatureValid).toBe(true);
    expect(receipt.eventId).toBe("evt-sam-0000");
    expect(receipt.hopsAfter).toEqual(SKELETON_HOPS.slice(1));
  });

  it("does not read a dropped receive with a hop after it as dropped at receipt", () => {
    const [receive, ...rest] = skeleton.spans;
    const copy = withSpans(skeleton, [{ ...receive, outcome: "dropped" }, ...rest]);
    expect(readReceipt(copy).droppedAtReceipt).toBe(false);
  });

  it("refuses a trace that a webhook did not open", () => {
    expect(() => readReceipt(fixture("trace-clock-fire.json"))).toThrow(/not a webhook's trace/);
  });
});

describe("a repeated webhook", () => {
  /** trace-skeleton.json as the first arrival of the event trace-duplicate-webhook.json repeats. */
  const first = withSpans(
    { ...skeleton, trace_id: "trace-alex-0008" },
    skeleton.spans.map((span) => ({
      ...span,
      trace_id: "trace-alex-0008",
      ...(span.hop === "receive" ? { event_id: "evt-alex-0008" } : {}),
    })),
  );

  it("is dropped at receipt under the first arrival's event id, with nothing after it", () => {
    expect(checkRepeat(first, duplicate)).toEqual([]);
  });

  it("is not a repeat when it ran on past receive, or carried another event id", () => {
    expect(checkRepeat(first, first)).toEqual([
      "the repeat trace-alex-0008 was not dropped at receipt as a known event id (outcome ok, knownEventId false, 15 hops after receive)",
      "the repeat reuses trace id trace-alex-0008: each webhook opens its own",
    ]);
    expect(checkRepeat(skeleton, duplicate)).toEqual([
      "the repeat's receive names event evt-alex-0008, the first's evt-sam-0000: a repeat carries the same event id",
      "the repeat names first trace trace-alex-0008, not trace-sam-0000",
    ]);
  });
});
