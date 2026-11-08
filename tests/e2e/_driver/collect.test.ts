// What the driver collects after a text, from the frozen fixtures (T-465, "Gives"): the trace by its trace id from span
// log lines (K-08 v1; ADR-009), the outbox rows under it (K-07 v1 schema and lifeChain), the Linq double's parts
// (K-11 v1), and the run's report. Run by `npm run test:e2e -- _driver`.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Span, Trace } from "../../../contracts/generated/event-trace/event-trace.v1";
import { LinqDouble } from "../../../adapters/src/linq/double";
import { CONTRACTS_ROOT } from "../../contract/_harness";
import {
  K07,
  RecordingLinqDouble,
  SKELETON_HOPS,
  asTrace,
  captureConsoleLog,
  checkOutboxRows,
  checkParts,
  checkRun,
  lifeChain,
  partsOf,
  schemaProblems,
  spansOfLogLines,
  traceOf,
  type Collected,
} from "./index";

function json(...parts: string[]): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...parts), "utf8"));
}

const skeleton = asTrace(json("event-trace", "fixtures", "trace-skeleton.json"));
const duplicate = asTrace(json("event-trace", "fixtures", "trace-duplicate-webhook.json"));
const outboxDelivered = json("outbox-effects", "fixtures", "outbox-delivered.json") as {
  row: { id: string; traceId: string };
};
const sendText = json("port-linq", "fixtures", "send-text.json") as { request: Record<string, unknown> };

/** A span as one ADR-009 log line: level, msg "span", the span's fields, environment and version. */
function logLine(span: Span): string {
  return JSON.stringify({ level: "info", msg: "span", ...span, environment: "staging", version: "test-sha" });
}

describe("collecting a trace by its trace id", () => {
  const lines = [
    JSON.stringify({ level: "info", msg: "health", trace_id: "3f0c7a52-0d6e-4b1e-9a43-2f1d0f1e9b10" }),
    "not a JSON line",
    ...duplicate.spans.map(logLine),
    ...[...skeleton.spans].reverse().map(logLine),
  ];

  it("reads trace-skeleton.json back from its spans' log lines, among other lines and traces", () => {
    const collected = traceOf("trace-sam-0000", spansOfLogLines(lines));
    expect(collected.problems).toEqual([]);
    expect(collected.trace).toEqual(skeleton);
  });

  it("reads trace-duplicate-webhook.json back from the same lines", () => {
    const collected = traceOf("trace-alex-0008-repeat", spansOfLogLines(lines));
    expect(collected.problems).toEqual([]);
    expect(collected.trace).toEqual(duplicate);
  });

  it("says when no span carries the trace id", () => {
    expect(traceOf("trace-none-0001", spansOfLogLines(lines))).toEqual({
      trace: null,
      problems: ["no span carries trace id trace-none-0001"],
    });
  });

  it("names a span K-08 refuses by place and rule, never by its value", () => {
    const phone = "+15555550101";
    const spans = skeleton.spans.map((span) =>
      span.hop === "guard" ? { ...span, got: { ...span.got, from: phone } } : span,
    );
    const collected = traceOf("trace-sam-0000", spans);
    expect(collected.problems).toContain(
      '/spans/5/got/from must match pattern "^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$"',
    );
    expect(collected.problems.join("\n")).not.toContain(phone);
  });

  it("captures console.log lines without printing them, and puts console.log back", () => {
    const before = Object.getOwnPropertyDescriptor(console, "log");
    const capture = captureConsoleLog();
    console.log(logLine(duplicate.spans[0]));
    console.log("words", { n: 1 });
    capture.stop();
    capture.stop();
    expect(capture.lines).toEqual([logLine(duplicate.spans[0]), 'words {"n":1}']);
    expect(Object.getOwnPropertyDescriptor(console, "log")).toEqual(before);
    expect(traceOf("trace-alex-0008-repeat", spansOfLogLines(capture.lines)).trace).toEqual(duplicate);
  });

  it("gives every line to each capture running, and puts console.log back after the last stops, in any order", () => {
    const before = Object.getOwnPropertyDescriptor(console, "log");
    const first = captureConsoleLog();
    console.log("one");
    const second = captureConsoleLog();
    console.log("two");
    first.stop();
    console.log("three");
    expect(Object.getOwnPropertyDescriptor(console, "log")).not.toEqual(before);
    second.stop();
    expect(Object.getOwnPropertyDescriptor(console, "log")).toEqual(before);
    expect(first.lines).toEqual(["one", "two"]);
    expect(second.lines).toEqual(["two", "three"]);
  });
});

describe("reading the outbox rows under a trace (K-07 v1)", () => {
  it("passes outbox-delivered.json under its own trace id", async () => {
    const check = await checkOutboxRows([outboxDelivered], "trace-alex-0012");
    expect(check.problems).toEqual([]);
    expect(check.rows.map((life) => life.row.id)).toEqual(["out-alex-booked-riley"]);
  });

  it("names a row written under another trace", async () => {
    const check = await checkOutboxRows([outboxDelivered], "trace-sam-0000");
    expect(check.problems).toEqual([
      "row out-alex-booked-riley was written under trace trace-alex-0012, not trace-sam-0000",
    ]);
  });

  it("refuses a move K-07 does not allow (refuse-row-move-not-allowed.json), naming the row", async () => {
    const record = json("outbox-effects", "fixtures", "invalid", "refuse-row-move-not-allowed.json");
    const check = await checkOutboxRows([record]);
    expect(check.rows).toEqual([]);
    expect(check.problems.length).toBeGreaterThan(0);
    expect(check.problems.every((line) => line.startsWith("row out-"))).toBe(true);
  });

  it("refuses moves that do not chain under the retry rules (refuse-4006-new-key-too-soon.json, lifeChain)", async () => {
    const record = json("outbox-effects", "fixtures", "invalid", "refuse-4006-new-key-too-soon.json");
    expect(schemaProblems(K07, undefined, record)).toEqual([]);
    const rule = await lifeChain();
    const check = await checkOutboxRows([record]);
    expect(rule(record).length).toBeGreaterThan(0);
    expect(check.problems).toEqual(rule(record).map((line) => `row out-sam-booked-riley: ${line}`));
  });

  it("refuses a record that is not an outbox row (an effect row)", async () => {
    const effect = json("outbox-effects", "fixtures", "effect-charge.json");
    expect((await checkOutboxRows([effect])).problems).toEqual([
      'record 1 is not a K-07 v1 outbox row (record "outboxRow")',
    ]);
  });
});

describe("the Linq double's parts", () => {
  const request = sendText.request;
  const retry = { ...request, idempotencyKey: "out-a7-03-alex/1/2" };

  it("records each new part with the outcome the double gave, and not a repeat under the same key", () => {
    const linq = new RecordingLinqDouble({ now: () => "2026-10-23T14:05:03Z" });
    linq.failNextSend({ kind: "transient" });
    linq.sendPart(request);
    linq.sendPart(retry);
    linq.sendPart(retry);
    const parts = partsOf(linq);
    expect(parts.map((part) => [part.sent.idempotencyKey, part.outcome?.result])).toEqual([
      ["out-a7-03-alex/1/1", "failed"],
      ["out-a7-03-alex/1/2", "accepted"],
    ]);
    expect(checkParts(parts)).toEqual({ parts: 2, sends: 1, duplicateSends: [], repeatedKeys: [] });
    linq.reset();
    expect(partsOf(linq)).toEqual([]);
  });

  it("finds a part accepted under two keys: the person got it twice", () => {
    const linq = new RecordingLinqDouble();
    linq.sendPart(request);
    linq.sendPart(retry);
    expect(checkParts(partsOf(linq))).toEqual({
      parts: 2,
      sends: 2,
      duplicateSends: ["out-a7-03-alex/1"],
      repeatedKeys: [],
    });
  });

  it("reads a plain Linq double's requests, with no outcome", () => {
    const linq = new LinqDouble();
    linq.sendPart(request);
    expect(partsOf(linq)).toEqual([{ at: null, sent: request, outcome: null }]);
  });
});

describe("the run's report", () => {
  const part = new RecordingLinqDouble();
  part.sendPart(sendText.request);

  async function collected(trace: Trace, parts = partsOf(part)): Promise<Collected> {
    return {
      target: "local",
      traceId: trace.trace_id,
      trace,
      traceProblems: [],
      parts,
      outbox: await checkOutboxRows(
        [{ ...outboxDelivered, row: { ...outboxDelivered.row, traceId: trace.trace_id } }],
        trace.trace_id,
      ),
    };
  }

  it("passes the skeleton's trace with one row and one send", async () => {
    const report = checkRun(await collected(skeleton));
    expect(report.problems).toEqual([]);
    expect(report.hops?.hops).toEqual([...SKELETON_HOPS]);
    expect(report.outboxRows).toBe(1);
    expect(report.parts.sends).toBe(1);
  });

  it("lists a missing hop and a part sent twice", async () => {
    const [first, ...rest] = skeleton.spans;
    const shorter: Trace = { ...skeleton, spans: [first, ...rest.filter((span) => span.hop !== "commit")] };
    const twice = new RecordingLinqDouble();
    twice.sendPart(sendText.request);
    twice.sendPart({ ...sendText.request, idempotencyKey: "out-a7-03-alex/1/2" });
    const report = checkRun(await collected(shorter, partsOf(twice)));
    expect(report.problems).toContain("hop commit is missing: every hop runs once");
    expect(report.problems).toContain("part out-a7-03-alex/1 was accepted under more than one key");
  });
});
