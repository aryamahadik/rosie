// The Linq webhook entry, run inside the Workers runtime (T-241). The Linq port is a double that answers exactly as
// K-11's fixtures state (it knows no signature algorithm: that is the adapter's); the actor is a stub that models the
// seen-event-id check. Fixtures: contracts/port-linq/fixtures and contracts/inbound-event/fixtures.
// T-1180: a body over its own cap is answered 413 before it is read whole, with nothing verified or handed on.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { createWorker } from "../index";
import doubleSigned from "../../../contracts/port-linq/fixtures/double-signed-webhook.json";
import badSignature from "../../../contracts/port-linq/fixtures/verify-bad-signature.json";
import deliveredAfter4006 from "../../../contracts/port-linq/fixtures/verify-delivered-after-4006.json";
import verifyOk from "../../../contracts/port-linq/fixtures/verify-ok.json";
import staleTimestamp from "../../../contracts/port-linq/fixtures/verify-stale-timestamp.json";
import duplicateEvent from "../../../contracts/inbound-event/fixtures/duplicate-event.json";
import { LINQ_BODY_LIMIT_BYTES } from "./body";
import { handleLinqWebhook } from "./linq-webhook";
import { countedStream, fakeKeyStore, postOf, xBytes } from "./test-support";
import type { SealingKeyStore } from "./seal";
import type {
  ActorHandoff,
  ActorStub,
  GatewayDeps,
  LinqPort,
  ReceiptSink,
  SealedHandoff,
  VerifyWebhookRequest,
  VerifyWebhookResult,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOW = Date.parse("2026-10-12T16:20:01Z");
const WHERE = { environment: "staging", version: "test-sha" };

interface Fixture {
  given?: { signing?: string };
  request: { webhookId: string; timestamp: string; signature: string; raw: string };
  outcome: unknown;
}

/** The byte a fixture's "oneByteChanged" signature differs by, in the placeholder form fixtures hold. */
const CHANGED_BYTE = "!";

/** A webhook request as Linq sends it, from a fixture's own headers and raw body (its signature as its signing says). */
function webhookOf(fixture: Fixture, path = "/test/webhooks/linq"): Request {
  const changed = fixture.given?.signing === "oneByteChanged" ? CHANGED_BYTE : "";
  return new Request(`https://rosie.test${path}`, {
    method: "POST",
    headers: {
      "webhook-id": fixture.request.webhookId,
      "webhook-timestamp": fixture.request.timestamp,
      "webhook-signature": fixture.request.signature + changed,
    },
    body: fixture.request.raw,
  });
}

/**
 * The K-11 double: answers a request with the outcome of the fixture that holds the same id, timestamp, body and
 * signature (a fixture signed "oneByteChanged" holds the placeholder with one byte changed). It checks no HMAC.
 */
function portDouble(fixtures: readonly Fixture[]): LinqPort & { requests: VerifyWebhookRequest[] } {
  const requests: VerifyWebhookRequest[] = [];
  return {
    requests,
    verifyWebhook(request) {
      requests.push(request);
      const fixture = fixtures.find(
        (candidate) =>
          candidate.request.webhookId === request.webhookId &&
          candidate.request.timestamp === request.timestamp &&
          candidate.request.raw === request.raw &&
          candidate.request.signature +
            (candidate.given?.signing === "oneByteChanged" ? CHANGED_BYTE : "") ===
            request.signature,
      );
      if (fixture === undefined) return Promise.reject(new Error("no fixture for this webhook"));
      const outcome = fixture.outcome as VerifyWebhookResult;
      if (outcome.result !== "event") return Promise.resolve(outcome);
      return Promise.resolve({ ...outcome, event: { ...outcome.event, traceId: request.traceId } });
    },
  };
}

/** The actor stub: writes an event once and calls a known event id a duplicate, as T-243's actor will. */
function actorStub(): ActorStub & { written: SealedHandoff[]; calls: SealedHandoff[] } {
  const seen = new Set<string>();
  const written: SealedHandoff[] = [];
  const calls: SealedHandoff[] = [];
  return {
    written,
    calls,
    accept(handoff) {
      calls.push(handoff);
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      written.push(handoff);
      return Promise.resolve("written");
    },
  };
}

/** The receipts' door: stores each receipt once, as the dispatcher's will. */
function receiptsStub(): ReceiptSink & { written: ActorHandoff[] } {
  const seen = new Set<string>();
  const written: ActorHandoff[] = [];
  return {
    written,
    accept(handoff) {
      if (seen.has(handoff.event.eventId)) return Promise.resolve("duplicate");
      seen.add(handoff.event.eventId);
      written.push(handoff);
      return Promise.resolve("written");
    },
  };
}

function depsOf(
  linq: LinqPort,
  actor: ActorStub,
  receipts: ReceiptSink = receiptsStub(),
  keys: SealingKeyStore = fakeKeyStore(),
): GatewayDeps {
  return {
    linq,
    actor,
    receipts,
    keys,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => NOW,
  };
}

/** double-signed-webhook is a `doubleWebhook` exchange: its signed webhook verifies back to its own event and key. */
const doubleVerified: Fixture = {
  request: doubleSigned.outcome.webhook,
  outcome: {
    result: "event",
    httpStatus: 200,
    event: doubleSigned.request.event,
    partKey: doubleSigned.request.partKey,
  },
};

const ALL = [verifyOk, badSignature, staleTimestamp, deliveredAfter4006, doubleVerified];

function captureLogLines(): () => Record<string, unknown>[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function receiveSpans(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line.msg === "span" && line.hop === "receive");
}

describe("POST /webhooks/linq", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verify-ok: 200 in under 1 s, an x-trace-id header, one receive span, the event handed on once", async () => {
    const logLines = captureLogLines();
    const linq = portDouble(ALL);
    const actor = actorStub();

    const started = performance.now();
    const response = await handleLinqWebhook(webhookOf(verifyOk), depsOf(linq, actor), WHERE);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: true, trace_id: traceId });

    expect(linq.requests).toEqual([
      {
        webhookId: verifyOk.request.webhookId,
        timestamp: verifyOk.request.timestamp,
        signature: verifyOk.request.signature,
        raw: verifyOk.request.raw,
        receivedAt: "2026-10-12T16:20:01.000Z",
        traceId,
      },
    ]);
    expect(actor.written).toHaveLength(1);
    expect(actor.written[0]).toMatchObject({
      partKey: null,
      traceId,
      event: { eventId: "evt-alex-0001", kind: "text", traceId },
    });

    const spans = receiveSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      hop: "receive",
      provider: "linq",
      event_id: "evt-alex-0001",
      outcome: "ok",
      got: { kind: "text", service: "imessage" },
      decided: { signatureValid: true, knownEventId: false, answered: 200 },
      environment: "staging",
      version: "test-sha",
    });
  });

  it("hands a receipt's partKey on beside the event, to the dispatcher's door and not the actor (verify-delivered-after-4006)", async () => {
    captureLogLines();
    const actor = actorStub();
    const receipts = receiptsStub();

    const response = await handleLinqWebhook(
      webhookOf(deliveredAfter4006),
      depsOf(portDouble(ALL), actor, receipts),
      WHERE,
    );

    expect(response.status).toBe(200);
    expect(actor.calls).toHaveLength(0);
    expect(receipts.written).toHaveLength(1);
    expect(receipts.written[0]?.partKey).toBe("out-sam-booked-riley/1/1");
    expect(receipts.written[0]?.event).not.toHaveProperty("partKey");
    expect(receipts.written[0]?.event.kind).toBe("delivered");
  });

  it("accepts the double's signed webhook (double-signed-webhook)", async () => {
    captureLogLines();
    const actor = actorStub();

    const response = await handleLinqWebhook(
      webhookOf(doubleVerified),
      depsOf(portDouble(ALL), actor),
      WHERE,
    );

    expect(response.status).toBe(200);
    expect(actor.written).toHaveLength(1);
  });

  it.each([
    ["verify-bad-signature", badSignature, "badSignature"],
    ["verify-stale-timestamp (outside 300 s)", staleTimestamp, "staleTimestamp"],
  ])("%s: 401, nothing handed on, a refused receive span", async (_name, fixture, reason) => {
    const logLines = captureLogLines();
    const actor = actorStub();

    const response = await handleLinqWebhook(webhookOf(fixture), depsOf(portDouble(ALL), actor), WHERE);

    expect(response.status).toBe(401);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
    expect(actor.calls).toHaveLength(0);
    const spans = receiveSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      outcome: "refused",
      error_code: reason,
      decided: { signatureValid: false, answered: 401 },
    });
    expect(spans[0]).not.toHaveProperty("event_id");
  });

  it("a known event id (duplicate-event): 200 both times, handed on once, the second span dropped", async () => {
    const logLines = captureLogLines();
    const duplicate: Fixture = {
      request: { ...verifyOk.request, raw: `${verifyOk.request.raw} ` },
      outcome: { result: "event", httpStatus: 200, event: duplicateEvent, partKey: null },
    };
    const linq = portDouble([...ALL, duplicate]);
    const actor = actorStub();
    const deps = depsOf(linq, actor);

    const first = await handleLinqWebhook(webhookOf(verifyOk), deps, WHERE);
    const second = await handleLinqWebhook(webhookOf(duplicate), deps, WHERE);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(actor.calls).toHaveLength(2);
    expect(actor.written).toHaveLength(1);
    const spans = receiveSpans(logLines());
    expect(spans.map((span) => span.outcome)).toEqual(["ok", "dropped"]);
    expect(spans[1]).toMatchObject({
      event_id: "evt-alex-0001",
      decided: { signatureValid: true, knownEventId: true, answered: 200 },
    });
    expect(spans[0]?.trace_id).not.toBe(spans[1]?.trace_id);
  });

  it("a failing hand-off: 503 so Linq retries, and a failed receive span", async () => {
    const logLines = captureLogLines();
    const actor: ActorStub = { accept: () => Promise.reject(new Error("actor write failed")) };

    const response = await handleLinqWebhook(webhookOf(verifyOk), depsOf(portDouble(ALL), actor), WHERE);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
    const spans = receiveSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: "handoffFailed" });
  });

  it("a verifier that cannot answer: 503, nothing handed on", async () => {
    captureLogLines();
    const actor = actorStub();
    const linq: LinqPort = { verifyWebhook: () => Promise.reject(new Error("secret is not set")) };

    const response = await handleLinqWebhook(webhookOf(verifyOk), depsOf(linq, actor), WHERE);

    expect(response.status).toBe(503);
    expect(actor.calls).toHaveLength(0);
  });

  it("a signed event type Rosie does not use: 200 and handed on to no one", async () => {
    const logLines = captureLogLines();
    const actor = actorStub();
    const linq: LinqPort = {
      verifyWebhook: () => Promise.resolve({ result: "ignored", httpStatus: 200, eventType: "message.read" }),
    };

    const response = await handleLinqWebhook(webhookOf(verifyOk), depsOf(linq, actor), WHERE);

    expect(response.status).toBe(200);
    expect(actor.calls).toHaveLength(0);
    expect(receiveSpans(logLines())[0]).toMatchObject({
      outcome: "dropped",
      got: { eventType: "message.read" },
    });
  });

  it("missing headers go to the port as empty text, which it rejects", async () => {
    captureLogLines();
    const linq = portDouble([]);
    const request = new Request("https://rosie.test/test/webhooks/linq", { method: "POST", body: "{}" });

    const response = await handleLinqWebhook(request, depsOf(linq, actorStub()), WHERE);

    expect(linq.requests[0]).toMatchObject({ webhookId: "", timestamp: "", signature: "", raw: "{}" });
    expect(response.status).toBe(503);
  });

  it("writes no body, phone number or secret to any log line", async () => {
    const logLines = captureLogLines();
    const actor: ActorStub = { accept: () => Promise.reject(new Error(verifyOk.request.raw)) };

    await handleLinqWebhook(webhookOf(verifyOk), depsOf(portDouble(ALL), actor), WHERE);
    await handleLinqWebhook(webhookOf(verifyOk), depsOf(portDouble(ALL), actorStub()), WHERE);

    const text = JSON.stringify(logLines());
    expect(text).not.toContain("Haircut");
    expect(text).not.toContain("5555550101");
    expect(text).not.toContain(verifyOk.request.signature);
  });
});

describe("the Linq webhook's body cap (T-1180)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The gateway never reads the context; the Workers runtime's own context has members this test cannot build.
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  /** verify-ok's webhook, its raw body followed by spaces to exactly `bytes` bytes. */
  function paddedWebhook(bytes: number): { request: Request; raw: string } {
    const raw =
      verifyOk.request.raw + " ".repeat(bytes - new TextEncoder().encode(verifyOk.request.raw).byteLength);
    return { request: webhookOf({ ...verifyOk, request: { ...verifyOk.request, raw } }), raw };
  }

  /** verify-ok's headers on a streamed body, with these headers besides. */
  function streamedWebhook(
    stream: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ): Request {
    return postOf(
      stream,
      {
        "webhook-id": verifyOk.request.webhookId,
        "webhook-timestamp": verifyOk.request.timestamp,
        "webhook-signature": verifyOk.request.signature,
        ...headers,
      },
      "https://rosie.test/test/webhooks/linq",
    );
  }

  it("a body one byte over its cap: 413 with the trace id, nothing verified, written or handed on, a refused receive span, nothing of the body logged", async () => {
    const logLines = captureLogLines();
    const linq = portDouble(ALL);
    const actor = actorStub();
    const receipts = receiptsStub();
    const { request } = paddedWebhook(LINQ_BODY_LIMIT_BYTES + 1);

    const response = await handleLinqWebhook(request, depsOf(linq, actor, receipts), WHERE);

    expect(response.status).toBe(413);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large", trace_id: traceId });
    expect(linq.requests).toEqual([]);
    expect(actor.calls).toEqual([]);
    expect(receipts.written).toEqual([]);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(receiveSpans(lines)).toMatchObject([
      { trace_id: traceId, provider: "linq", outcome: "refused", error_code: "bodyTooLarge" },
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("Haircut");
    expect(text).not.toContain("5555550101");
    expect(text).not.toContain(verifyOk.request.signature);
  });

  it("a body exactly at its cap reaches the verify as sent", async () => {
    captureLogLines();
    const linq = portDouble(ALL);
    const { request, raw } = paddedWebhook(LINQ_BODY_LIMIT_BYTES);

    await handleLinqWebhook(request, depsOf(linq, actorStub()), WHERE);

    expect(linq.requests).toHaveLength(1);
    expect(linq.requests[0]?.raw).toBe(raw);
  });

  it("a declared length over its cap is answered 413 before a byte of the body is read", async () => {
    captureLogLines();
    const linq = portDouble(ALL);
    const source = countedStream(1024, () => xBytes(1024));

    const response = await handleLinqWebhook(
      streamedWebhook(source.stream, { "content-length": String(LINQ_BODY_LIMIT_BYTES + 1) }),
      depsOf(linq, actorStub()),
      WHERE,
    );

    expect(response.status).toBe(413);
    expect(source.pulled()).toBe(0);
    expect(linq.requests).toEqual([]);
  });

  it("a body that declares no length is cut off at the chunk that takes it over its cap: a 1 GiB body is never read whole", async () => {
    captureLogLines();
    const linq = portDouble(ALL);
    const source = countedStream(1024 * 1024, () => xBytes(1024));

    const response = await handleLinqWebhook(
      streamedWebhook(source.stream),
      depsOf(linq, actorStub()),
      WHERE,
    );

    expect(response.status).toBe(413);
    expect(source.pulled()).toBeGreaterThan(LINQ_BODY_LIMIT_BYTES / 1024);
    expect(source.pulled()).toBeLessThan((2 * LINQ_BODY_LIMIT_BYTES) / 1024);
    expect(source.cancelled()).toBe(true);
    expect(linq.requests).toEqual([]);
  });

  it("its cap is its own config value: GatewayDeps.linqBodyLimitBytes sets it, the page entry's cap does not, and a mistyped value leaves the default", async () => {
    captureLogLines();
    const answer = async (more: Partial<GatewayDeps>): Promise<number> => {
      const deps = { ...depsOf(portDouble(ALL), actorStub()), ...more };
      return (await handleLinqWebhook(webhookOf(verifyOk), deps, WHERE)).status;
    };

    expect(await answer({ linqBodyLimitBytes: 64 })).toBe(413);
    expect(
      await answer({ linqBodyLimitBytes: new TextEncoder().encode(verifyOk.request.raw).byteLength }),
    ).toBe(200);
    expect(await answer({ pageBodyLimitBytes: 1 })).toBe(200);
    expect(await answer({ linqBodyLimitBytes: Number.NaN })).toBe(200);
    expect(await answer({ linqBodyLimitBytes: -1 })).toBe(200);
  });

  it("through the Worker's route, a webhook over its cap is answered 413 and reaches no door", async () => {
    captureLogLines();
    const linq = portDouble(ALL);
    const actor = actorStub();
    const routed = createWorker(() => depsOf(linq, actor));

    const response = await routed.fetch(paddedWebhook(LINQ_BODY_LIMIT_BYTES + 1).request, env, context);

    expect(response.status).toBe(413);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
    expect(linq.requests).toEqual([]);
    expect(actor.calls).toEqual([]);
  });
});

describe("the Worker's webhook route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The gateway never reads the context; the Workers runtime's own context has members this test cannot build.
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  it("answers a POST under BASE_PATH through the gateway", async () => {
    captureLogLines();
    const actor = actorStub();
    const routed = createWorker(() => depsOf(portDouble(ALL), actor));

    const response = await routed.fetch(webhookOf(verifyOk), env, context);

    expect(response.status).toBe(200);
    expect(actor.written).toHaveLength(1);
  });

  it("answers any other method on the webhook path with 405", async () => {
    captureLogLines();
    const routed = createWorker(() => depsOf(portDouble(ALL), actorStub()));

    const response = await routed.fetch(
      new Request("https://rosie.test/test/webhooks/linq", { method: "GET" }),
      env,
      context,
    );

    expect(response.status).toBe(405);
  });

  it("answers 404 while the skeleton flag is off: the Worker's route is the composition root's, and no release flags are bound to it (T-553)", async () => {
    captureLogLines();

    const response = await worker.fetch(webhookOf(verifyOk), env, context);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
  });
});
