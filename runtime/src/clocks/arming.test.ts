// The clock arming's other behaviours (T-255; C-055), beside due.test.ts's table: the zone through the ports (a flow B
// visit address's zone from the geo port, K-17; CQ-08), the never-delivered row cancelled once delivered, a question
// closed before its receipt, transient answers, an actor it cannot reach, an input it cannot use, the clockArmed span and
// what never reaches a log line, and the receipt path's join: the dispatcher's own receipt handler with this arming as
// its ClockArming, whose partDelivered rejects when the arming ended failed and resolves on every other end (T-1244).
// Doubles: ./arming-support.ts. Test values only (rule 9).
import { afterEach, describe, expect, it, vi } from "vitest";

import activeBundle from "../../../contracts/data-access/fixtures/active-bundle.json";
import markA703Delivered from "../../../contracts/data-access/fixtures/mark-a7-03-delivered-by-key.json";
import geoUnavailable from "../../../contracts/port-geo/fixtures/error-unavailable.json";
import geocodeStreet from "../../../contracts/port-geo/fixtures/geocode-street.json";
import { handleDeliveryReceipt } from "../dispatch";
import type { ClockArming, MarkPartRequest, OutboxStore } from "../dispatch/types";
import { openTrace, type Span, type TraceContext } from "../trace";
import { schemaErrors } from "../trace/test-support";
import {
  armAtDelivery,
  ARMING_TRIES,
  ArmingMemory,
  ArmingNotDone,
  clockArming,
  type ArmingOptions,
  type DeliveredPart,
} from "./arming";
import {
  A7_03_ARM_REQUEST,
  A7_03_CLOCK_ROW,
  A7_03_DELIVERED,
  A7_03_FACTS,
  A7_03_QUESTION,
  ALEX_ACTOR,
  ALEX_HANDLE,
  TRANSIENT,
  wireArming,
  type WiredArming,
} from "./arming-support";
import type { GeocodeAnswer } from "./types";

const NY = "America/New_York";
const CHICAGO = "America/Chicago";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A test question on a flow B visit Mon Nov 2 at 16:00Z, asked of Alex's handle, with its own waiting clock row. */
const FLOW_B_QUESTION = "oq-test-flow-b";
const FLOW_B_ROW = "clock-oq-test-flow-b";
const FLOW_B_DELIVERED: DeliveredPart = {
  outboxRowId: "out-test-flow-b",
  partNo: 1,
  tryNo: 1,
  firstDelivery: true,
  openQuestionId: FLOW_B_QUESTION,
  deliveredAt: "2026-10-30T14:00:00Z",
};

/** The flow B question's facts: a business in Chicago, the visit at an address the geo double knows (New York's zone). */
function withFlowB(wired: WiredArming, visit: { addressZone: string | null; address: string | null }): void {
  wired.data.make({
    clockRowId: FLOW_B_ROW,
    kind: "question",
    openQuestionId: FLOW_B_QUESTION,
    handleId: ALEX_HANDLE,
  });
  wired.facts.facts.set(FLOW_B_QUESTION, {
    openQuestionId: FLOW_B_QUESTION,
    clockLine: null,
    businessZone: CHICAGO,
    visit: { startsAt: "2026-11-02T16:00:00Z", flow: "B", ...visit },
    neverDelivered: null,
  });
}

describe("the zone through the ports (CQ-05, CQ-08; S13-03)", () => {
  it("flow B: the visit address's zone from the geo port (geocode-street.json), 7pm Sun EST, not the business's", async () => {
    const wired = wireArming();
    withFlowB(wired, { addressZone: null, address: geocodeStreet.request.text });
    const report = await armAtDelivery(FLOW_B_DELIVERED, wired.options);

    expect(wired.geo.requests).toEqual([geocodeStreet.request]);
    expect(wired.data.armRequests).toEqual([
      {
        openQuestionId: FLOW_B_QUESTION,
        deliveredAt: FLOW_B_DELIVERED.deliveredAt,
        dueAt: "2026-11-02T00:00:00Z",
        dueZone: geocodeStreet.outcome.matches[0]?.timeZone,
      },
    ]);
    expect(report).toMatchObject({ outcome: "armed", branch: "dayBefore", zoneFrom: "visitAddress" });
  });

  it("flow B: a zone stored with the visit is used as it is, with no geo call", async () => {
    const wired = wireArming();
    withFlowB(wired, { addressZone: NY, address: geocodeStreet.request.text });
    await armAtDelivery(FLOW_B_DELIVERED, wired.options);
    expect(wired.geo.requests).toEqual([]);
    expect(wired.data.armRequests[0]).toMatchObject({ dueAt: "2026-11-02T00:00:00Z", dueZone: NY });
  });

  it.each([
    { name: "the geo port fails (error-unavailable.json)", next: geoUnavailable.outcome as GeocodeAnswer },
    { name: "the geo port answers not found", next: { result: "notFound" } as GeocodeAnswer },
    { name: "the geo port throws", next: "throw" as const },
  ])("flow B, $name: the business's zone (7pm Sun CST)", async ({ next }) => {
    const wired = wireArming();
    withFlowB(wired, { addressZone: null, address: geocodeStreet.request.text });
    wired.geo.next = next;
    const report = await armAtDelivery(FLOW_B_DELIVERED, wired.options);
    expect(wired.data.armRequests[0]).toMatchObject({ dueAt: "2026-11-02T01:00:00Z", dueZone: CHICAGO });
    expect(report).toMatchObject({ outcome: "armed", zoneFrom: "business" });
  });

  it("flow B with no geo port joined: the business's zone", async () => {
    const wired = wireArming();
    withFlowB(wired, { addressZone: null, address: geocodeStreet.request.text });
    await armAtDelivery(FLOW_B_DELIVERED, { ...wired.options, geo: null });
    expect(wired.data.armRequests[0]).toMatchObject({ dueZone: CHICAGO });
  });

  it("a receipt time with a fraction: armed at its second, due a whole span after the receipt itself", async () => {
    const wired = wireArming();
    await armAtDelivery({ ...A7_03_DELIVERED, deliveredAt: "2026-10-23T14:05:04.250Z" }, wired.options);
    expect(wired.data.armRequests).toEqual([
      { ...A7_03_ARM_REQUEST, deliveredAt: "2026-10-23T14:05:04Z", dueAt: "2026-10-24T14:05:05Z" },
    ]);
  });

  it("flow A never asks the geo port: the business's zone (A7-03)", async () => {
    const wired = wireArming();
    await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(wired.geo.requests).toEqual([]);
    expect(wired.data.armRequests).toEqual([A7_03_ARM_REQUEST]);
  });
});

describe("the never-delivered row, once the question is delivered", () => {
  const NEVER_ROW = "clock-oq-a7-03-alex-never-delivered";

  /** A7-03 with a never-delivered row its commit made, armed at the visit (neverDeliveredDueOf). */
  function withNeverDelivered(wired: WiredArming): void {
    wired.data.make({
      clockRowId: NEVER_ROW,
      kind: "never_delivered",
      openQuestionId: A7_03_QUESTION,
      handleId: ALEX_HANDLE,
      due: { armedAt: "2026-10-23T14:05:02Z", dueAt: "2026-10-24T15:00:00Z", dueZone: NY },
    });
    wired.facts.facts.set(A7_03_QUESTION, {
      ...A7_03_FACTS,
      neverDelivered: { clockRowId: NEVER_ROW, version: 1 },
    });
  }

  it("is cancelled, compared on the version read, and the question's own clock arms", async () => {
    const wired = wireArming();
    withNeverDelivered(wired);
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);

    expect(wired.data.cancelRequests).toEqual([
      { clockRowId: NEVER_ROW, expectVersion: 1, withdrawQuestion: null, at: A7_03_DELIVERED.deliveredAt },
    ]);
    expect(wired.data.rowOf(NEVER_ROW).state).toBe("cancelled");
    expect(wired.data.rowOf(A7_03_CLOCK_ROW).state).toBe("armed");
    expect(report).toMatchObject({ outcome: "armed", neverDelivered: "cancelled", synced: true });
  });

  it("one that already fired stays fired; the question's clock still arms", async () => {
    const wired = wireArming();
    withNeverDelivered(wired);
    wired.data.move(NEVER_ROW, "fired", "2026-10-24T15:00:00Z");
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(wired.data.rowOf(NEVER_ROW).state).toBe("fired");
    expect(report).toMatchObject({ outcome: "armed", neverDelivered: "alreadyFired" });
  });

  it("a cancel that keeps failing is reported; the arming stands", async () => {
    const wired = wireArming();
    withNeverDelivered(wired);
    wired.data.cancelScript.push(TRANSIENT, TRANSIENT, TRANSIENT);
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(wired.data.cancelRequests).toHaveLength(3);
    expect(report).toMatchObject({ outcome: "armed", neverDelivered: "failed", synced: true });
  });
});

describe("when nothing arms", () => {
  it("a question answered before its receipt: K-05 clockClosed, no actor told, and a later receipt makes no call", async () => {
    const wired = wireArming();
    wired.data.move(A7_03_CLOCK_ROW, "cancelled", "2026-10-23T14:05:03Z");
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(report).toMatchObject({
      outcome: "closed",
      clockRowId: A7_03_CLOCK_ROW,
      errorCode: "clockClosed",
    });
    expect(wired.actors.syncs).toEqual([]);
    expect(wired.data.openedQuestions).toEqual([]);

    expect((await armAtDelivery(A7_03_DELIVERED, wired.options)).outcome).toBe("repeated");
    expect(wired.data.armRequests).toHaveLength(1);
  });

  it("a question that does not exist: no armClock call", async () => {
    const wired = wireArming();
    const report = await armAtDelivery({ ...A7_03_DELIVERED, openQuestionId: "oq-unknown" }, wired.options);
    expect(report).toMatchObject({ outcome: "notFound", errorCode: "questionNotFound" });
    expect(wired.data.armRequests).toEqual([]);
  });

  it("a question with no clock row: K-05 notFound", async () => {
    const wired = wireArming();
    wired.facts.facts.set("oq-no-clock", { ...A7_03_FACTS, openQuestionId: "oq-no-clock" });
    const report = await armAtDelivery({ ...A7_03_DELIVERED, openQuestionId: "oq-no-clock" }, wired.options);
    expect(report).toMatchObject({ outcome: "notFound", errorCode: "clockNotFound" });
    expect(wired.actors.syncs).toEqual([]);
  });

  it.each([
    { name: "an id that is not a label", part: { ...A7_03_DELIVERED, outboxRowId: "out a7 03" } },
    { name: "a time that is not UTC", part: { ...A7_03_DELIVERED, deliveredAt: "Fri Oct 23 10:05am" } },
    { name: "a try that is not a count", part: { ...A7_03_DELIVERED, tryNo: 0 } },
  ])("an input it cannot use, $name: refused, with nothing read or sent", async ({ part }) => {
    const wired = wireArming();
    const report = await armAtDelivery(part, wired.options);
    expect(report).toMatchObject({ outcome: "refused", errorCode: "badPart" });
    expect(wired.facts.reads).toEqual([]);
    expect(wired.data.armRequests).toEqual([]);
  });
});

describe("transient answers (each K-05 call here is safe to repeat)", () => {
  it("armClock transient, then no answer, then armed: armed on the third try", async () => {
    const wired = wireArming();
    wired.data.armScript.push(TRANSIENT, "throw");
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(wired.data.armRequests).toHaveLength(3);
    expect(report.outcome).toBe("armed");
    expect(wired.actors.syncs).toHaveLength(1);
  });

  it("armClock transient three times: failed, nothing remembered, so the next receipt still arms", async () => {
    const wired = wireArming();
    wired.data.armScript.push(TRANSIENT, TRANSIENT, TRANSIENT);
    const failed = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(failed).toMatchObject({ outcome: "failed", errorCode: "transient", synced: false });
    expect(wired.data.rowOf(A7_03_CLOCK_ROW).state).toBe("waiting");

    const again = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(again.outcome).toBe("armed");
    expect(wired.data.armRequests).toHaveLength(4);
  });

  it("the facts read transient three times: failed, with no armClock call", async () => {
    const wired = wireArming();
    wired.facts.script.push(TRANSIENT, TRANSIENT, TRANSIENT);
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(report).toMatchObject({ outcome: "failed", errorCode: "transient" });
    expect(wired.facts.reads).toHaveLength(3);
    expect(wired.data.armRequests).toEqual([]);
  });
});

describe("the handle's actor", () => {
  it("one it cannot reach: the row stays armed for the minute sweep, and the report says so", async () => {
    const wired = wireArming();
    wired.actors.failing = true;
    const report = await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(report).toMatchObject({ outcome: "armed", synced: false, errorCode: "syncFailed" });
    expect(wired.data.rowOf(A7_03_CLOCK_ROW).state).toBe("armed");
  });

  it("no namespace bound, or a handle the directory does not know: noActor", async () => {
    const unbound = wireArming();
    expect(await armAtDelivery(A7_03_DELIVERED, { ...unbound.options, actors: null })).toMatchObject({
      outcome: "armed",
      synced: false,
      errorCode: "noActor",
    });
    const unknown = wireArming();
    unknown.actors.names.clear();
    expect(await armAtDelivery(A7_03_DELIVERED, unknown.options)).toMatchObject({ errorCode: "noActor" });
    expect(unknown.actors.syncs).toEqual([]);
  });

  it("is told by the handle K-05's arming names, through the directory's actor name", async () => {
    const wired = wireArming();
    await armAtDelivery(A7_03_DELIVERED, wired.options);
    expect(wired.actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
  });
});

/** A trace for a receipt, as the gateway opens one, keeping its spans. */
function receiptTrace(): { trace: TraceContext; spans: Span[] } {
  const spans: Span[] = [];
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: activeBundle.outcome.bundleId,
    sink: (span) => {
      spans.push(span);
    },
  });
  return { trace, spans };
}

/** Every console.log line a call writes. */
function logLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(typeof line === "string" ? line : JSON.stringify(line));
  });
  return lines;
}

describe("traces and logs: labels and counts only", () => {
  it("one clockArmed span on the receipt's trace, valid against K-08 v1, with no due time, zone or Clock line words", async () => {
    const wired = wireArming();
    const { trace, spans } = receiptTrace();
    await armAtDelivery(A7_03_DELIVERED, { ...wired.options, trace });

    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(schemaErrors("span", span)).toEqual([]);
    expect(span).toMatchObject({
      trace_id: trace.traceId,
      hop: "clockArmed",
      outcome: "ok",
      got: { firstDelivery: true, partNo: 1, tryNo: 1 },
      decided: {
        result: "armed",
        branch: "clockLine",
        zoneFrom: "business",
        clockLineUnread: false,
        neverDelivered: "none",
        synced: true,
      },
      rows: [{ table: "clock_rows", id: A7_03_CLOCK_ROW }],
      error_code: null,
    });
    const text = JSON.stringify(span);
    for (const secret of [A7_03_ARM_REQUEST.dueAt, A7_03_ARM_REQUEST.dueZone, "24 h"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("with no trace, one JSON line of its own, and never the due time, the zone, the Clock line or an address", async () => {
    const lines = logLines();
    const wired = wireArming();
    withFlowB(wired, { addressZone: null, address: geocodeStreet.request.text });
    await armAtDelivery(FLOW_B_DELIVERED, wired.options);
    await armAtDelivery(A7_03_DELIVERED, wired.options);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        level: "info",
        msg: "clockArming",
        outcome: "armed",
        synced: true,
        error_code: null,
        environment: "staging",
        version: "test-sha",
      });
      expect(typeof parsed.trace_id).toBe("string");
      expect(["visitAddress", "business"]).toContain(parsed.zone_from);
      for (const secret of [
        "2026-11-02T00:00:00Z",
        A7_03_ARM_REQUEST.dueAt,
        NY,
        CHICAGO,
        "24 h",
        geocodeStreet.request.text,
        "Springfield",
      ]) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it("a refused input still gives one span, refused, with nothing from the input in it", async () => {
    const wired = wireArming();
    const { trace, spans } = receiptTrace();
    await armAtDelivery({ ...A7_03_DELIVERED, outboxRowId: "+1 555 555 0101" }, { ...wired.options, trace });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ hop: "clockArmed", outcome: "refused", got: {}, error_code: "badPart" });
    expect(JSON.stringify(spans[0])).not.toContain("+1 555");
  });
});

describe("the receipt path's join: the dispatcher's receipt handler with this arming as its ClockArming", () => {
  it("A7-03's receipt (mark-a7-03-delivered-by-key.json) is marked delivered and arms its clock", async () => {
    const lines = logLines();
    const wired = wireArming();
    const arming: ClockArming = clockArming(wired.options);
    const marks: MarkPartRequest[] = [];
    const store: Pick<OutboxStore, "markPart"> = {
      markPart(request) {
        marks.push(request);
        return Promise.resolve(markA703Delivered.outcome as Awaited<ReturnType<OutboxStore["markPart"]>>);
      },
    };
    const { trace, spans } = receiptTrace();
    const result = await handleDeliveryReceipt(
      { store: store as OutboxStore, clockArming: arming, trace },
      {
        providerMessageId: markA703Delivered.request.providerMessageId,
        partKey: markA703Delivered.request.idempotencyKey,
        at: markA703Delivered.request.at,
      },
    );

    expect(result).toEqual({
      result: "delivered",
      outboxRowId: markA703Delivered.outcome.outboxRowId,
      partNo: 1,
      firstDelivery: true,
    });
    expect(marks).toHaveLength(1);
    expect(wired.data.armRequests).toEqual([A7_03_ARM_REQUEST]);
    expect(wired.actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
    // Joined with no trace of its own, the arming writes its own line; the receipt's trace holds the delivered span.
    expect(spans.map((span) => span.hop)).toEqual(["delivered"]);
    expect(lines.map((line) => (JSON.parse(line) as Record<string, unknown>).msg)).toEqual(["clockArming"]);
  });

  it("with the receipt's trace given to the arming: delivered, then clockArmed, on one trace id", async () => {
    const wired = wireArming();
    const { trace, spans } = receiptTrace();
    const arming = clockArming({ ...wired.options, trace });
    const store: Pick<OutboxStore, "markPart"> = {
      markPart: () =>
        Promise.resolve(markA703Delivered.outcome as Awaited<ReturnType<OutboxStore["markPart"]>>),
    };
    await handleDeliveryReceipt(
      { store: store as OutboxStore, clockArming: arming, trace },
      {
        providerMessageId: markA703Delivered.request.providerMessageId,
        partKey: null,
        at: markA703Delivered.request.at,
      },
    );
    expect(spans.map((span) => [span.hop, span.trace_id])).toEqual([
      ["delivered", trace.traceId],
      ["clockArmed", trace.traceId],
    ]);
  });

  it("an arming that ends failed rejects the receipt with ArmingNotDone after its part is marked (the root answers Linq 503)", async () => {
    const wired = wireArming();
    wired.data.armScript.push(TRANSIENT, TRANSIENT, TRANSIENT);
    const { trace, spans } = receiptTrace();
    const marks: MarkPartRequest[] = [];
    const store: Pick<OutboxStore, "markPart"> = {
      markPart(request) {
        marks.push(request);
        return Promise.resolve(markA703Delivered.outcome as Awaited<ReturnType<OutboxStore["markPart"]>>);
      },
    };

    await expect(
      handleDeliveryReceipt(
        { store: store as OutboxStore, clockArming: clockArming({ ...wired.options, trace }), trace },
        {
          providerMessageId: markA703Delivered.request.providerMessageId,
          partKey: markA703Delivered.request.idempotencyKey,
          at: markA703Delivered.request.at,
        },
      ),
    ).rejects.toThrow(ArmingNotDone);
    expect(marks).toHaveLength(1);
    expect(wired.data.rowOf(A7_03_CLOCK_ROW).state).toBe("waiting");
    expect(spans.map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
      ["delivered", "ok", null],
      ["clockArmed", "failed", "transient"],
    ]);
  });
});

describe("the receipt path's port: an arming that ended failed is not done (T-1244)", () => {
  it("armClock transient on every try: partDelivered rejects with ArmingNotDone and nothing is remembered, so the receipt's repeat arms the clock once and is done", async () => {
    const wired = wireArming();
    const { trace, spans } = receiptTrace();
    const arming = clockArming({ ...wired.options, trace });
    wired.data.armScript.push(TRANSIENT, TRANSIENT, TRANSIENT);

    const failed = arming.partDelivered(A7_03_DELIVERED);
    await expect(failed).rejects.toThrow(ArmingNotDone);
    // Its message is fixed: no id, time or code from the arming.
    await expect(failed).rejects.toThrow(/^the clock arming of a delivered part ended failed$/u);
    expect(wired.data.armRequests).toEqual(Array.from({ length: ARMING_TRIES }, () => A7_03_ARM_REQUEST));
    expect(wired.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "waiting", version: 1 });
    expect(wired.data.openedQuestions).toEqual([]);
    expect(wired.actors.syncs).toEqual([]);

    // The provider's repeat, handed on by the dispatcher as the same first delivery (T-1228): armed once, and done.
    await expect(arming.partDelivered(A7_03_DELIVERED)).resolves.toBeUndefined();
    expect(wired.data.armRequests).toEqual(Array.from({ length: ARMING_TRIES + 1 }, () => A7_03_ARM_REQUEST));
    expect(wired.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "armed", version: 2 });
    expect(wired.data.openedQuestions).toEqual([A7_03_QUESTION]);
    expect(wired.actors.syncs).toEqual([{ actor: ALEX_ACTOR, handleId: ALEX_HANDLE }]);
    expect(spans.map((span) => [span.hop, span.outcome, span.error_code])).toEqual([
      ["clockArmed", "failed", "transient"],
      ["clockArmed", "ok", null],
    ]);
  });

  const failedEnds: readonly {
    name: string;
    code: string;
    setUp: (wired: WiredArming) => Partial<ArmingOptions>;
  }[] = [
    {
      name: "armClock gives no answer on any try (it throws)",
      code: "noAnswer",
      setUp: (wired) => {
        wired.data.armScript.push("throw", "throw", "throw");
        return {};
      },
    },
    {
      name: "the question's facts read answers transient on every try",
      code: "transient",
      setUp: (wired) => {
        wired.facts.script.push(TRANSIENT, TRANSIENT, TRANSIENT);
        return {};
      },
    },
    {
      name: "the question's facts read throws on every try (a read the arming needs)",
      code: "noAnswer",
      setUp: () => ({
        facts: { questionFacts: () => Promise.reject(new Error("no database is bound")) },
      }),
    },
  ];

  it.each(failedEnds)("$name: rejects with ArmingNotDone, nothing armed", async ({ code, setUp }) => {
    const wired = wireArming();
    const { trace, spans } = receiptTrace();
    const options = { ...wired.options, trace, ...setUp(wired) };

    await expect(clockArming(options).partDelivered(A7_03_DELIVERED)).rejects.toThrow(ArmingNotDone);
    expect(wired.data.rowOf(A7_03_CLOCK_ROW)).toMatchObject({ state: "waiting", version: 1 });
    expect(spans).toMatchObject([
      { hop: "clockArmed", outcome: "failed", error_code: code, decided: { result: "failed" } },
    ]);
  });

  /** Arms A7-03 once before the part under test is handed on, in this isolate (`memory`) or another. */
  const armedBefore = async (wired: WiredArming, memory: ArmingMemory): Promise<void> => {
    await armAtDelivery(A7_03_DELIVERED, { ...wired.options, memory, trace: receiptTrace().trace });
  };

  const doneEnds: readonly {
    name: string;
    result: string;
    part?: DeliveredPart;
    setUp?: (wired: WiredArming) => Promise<void> | void;
  }[] = [
    { name: "armed", result: "armed" },
    {
      name: "armed, its actor unreachable (the minute sweep fires the row)",
      result: "armed",
      setUp: (wired) => {
        wired.actors.failing = true;
      },
    },
    {
      name: "armed before in this isolate",
      result: "repeated",
      setUp: (wired) => armedBefore(wired, wired.options.memory ?? new ArmingMemory()),
    },
    {
      name: "armed before in another isolate (K-05 armClock answers repeated)",
      result: "repeated",
      setUp: (wired) => armedBefore(wired, new ArmingMemory()),
    },
    {
      name: "a question answered before its receipt (K-05 clockClosed)",
      result: "closed",
      setUp: (wired) => {
        wired.data.move(A7_03_CLOCK_ROW, "cancelled", "2026-10-23T14:05:03Z");
      },
    },
    {
      name: "a question that does not exist",
      result: "notFound",
      part: { ...A7_03_DELIVERED, openQuestionId: "oq-unknown" },
    },
    {
      name: "not the row's first delivery",
      result: "notFirst",
      part: { ...A7_03_DELIVERED, firstDelivery: false },
    },
    {
      name: "a row that asks no question",
      result: "noQuestion",
      part: { ...A7_03_DELIVERED, openQuestionId: null },
    },
    { name: "an input it cannot use", result: "refused", part: { ...A7_03_DELIVERED, tryNo: 0 } },
  ];

  it.each(doneEnds)(
    "$name: resolves, so the receipt is answered as before",
    async ({ result, part, setUp }) => {
      const wired = wireArming();
      await setUp?.(wired);
      const { trace, spans } = receiptTrace();

      await expect(
        clockArming({ ...wired.options, trace }).partDelivered(part ?? A7_03_DELIVERED),
      ).resolves.toBeUndefined();
      expect(spans).toMatchObject([{ hop: "clockArmed", decided: { result } }]);
    },
  );
});
