// The Stripe webhook door, run inside the Workers runtime (T-275). The Stripe port is a double that checks each
// signature with the shared helper (adapters/src/shared/hmac.ts) under made-up secrets, over K-14's fixtures signed at
// test time; K-05 v1.1's recordProviderEvent is a fake that stores once by (provider, provider event id), as K-05's
// provider-event-recorded.json and provider-event-duplicate.json state (the fake is held to them in the calendar file).
// Fixtures: contracts/port-stripe and contracts/outbox-effects. Test values only: the fixtures' demo shop and cast.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { createWorker } from "../../index";
import providerEventStripe from "../../../../contracts/outbox-effects/fixtures/provider-event-stripe.json";
import badSignature from "../../../../contracts/port-stripe/fixtures/verify-bad-signature.json";
import ignoredType from "../../../../contracts/port-stripe/fixtures/verify-ignored.json";
import billCardSaved from "../../../../contracts/port-stripe/fixtures/webhook-bill-card-saved.json";
import cardDetails from "../../../../contracts/port-stripe/fixtures/webhook-card-details.json";
import webhookEvent from "../../../../contracts/port-stripe/fixtures/webhook-event.json";
import { unconfiguredGateway } from "..";
import { countedStream, postOf, present, xBytes } from "../test-support";
import { unconfiguredProviders } from ".";
import { handleStripeWebhook, MAX_SIGNATURE_ENTRIES, STRIPE_BODY_LIMIT_BYTES } from "./stripe-webhook";
import {
  businessLookupDouble,
  captureLogLines,
  changeOneByte,
  endpointOf,
  providerEventStoreFake,
  providerSpans,
  signedHeaderOf,
  STRIPE_TEST_SECRETS,
  stripePath,
  stripePortDouble,
  stripeRequest,
  stripeSignature,
  timestampOf,
  type BusinessLookupDouble,
  type ProviderEventStoreFake,
  type StripeExchange,
  type StripePortDouble,
} from "./test-support";
import type { ProviderDeps, StripeBusinessLookup, StripePort } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WHERE = { environment: "staging", version: "test-sha" };
const ALL: StripeExchange[] = [webhookEvent, badSignature, ignoredType, billCardSaved, cardDetails];
const EVENT = webhookEvent.outcome.event;

interface World {
  port: StripePortDouble;
  store: ProviderEventStoreFake;
  businesses: BusinessLookupDouble;
  deps: ProviderDeps;
}

/** The doors with the K-14 double, the K-05 fake and the business lookup's double, the clock at `now`. */
function worldAt(now: string, exchanges: readonly StripeExchange[] = ALL): World {
  const port = stripePortDouble(exchanges);
  const store = providerEventStoreFake();
  const businesses = businessLookupDouble();
  const deps: ProviderDeps = {
    ...unconfiguredProviders(),
    stripe: port,
    stripeBusinesses: businesses,
    events: store,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => Date.parse(now),
  };
  return { port, store, businesses, deps };
}

/** A fixture's webhook, signed now as its given.signing says, posted to its endpoint's door. */
async function send(exchange: StripeExchange, deps: ProviderDeps, where = WHERE): Promise<Response> {
  const endpoint = endpointOf(exchange);
  const header = await signedHeaderOf(exchange);
  return handleStripeWebhook(
    stripeRequest(stripePath(endpoint), header, exchange.request.raw),
    endpoint,
    deps,
    where,
  );
}

/** webhook-event as Stripe's live mode would send it: livemode true in the body, testMode false in the port's event. */
const liveEvent: StripeExchange = {
  ...webhookEvent,
  request: {
    ...webhookEvent.request,
    raw: webhookEvent.request.raw.replace('"livemode":false', '"livemode":true'),
  },
  outcome: { ...webhookEvent.outcome, event: { ...EVENT, testMode: false } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhooks/stripe/<endpoint>", () => {
  it("webhook-event: 200 in under 1 s, stored once as a K-07 provider event with its effect, business and trace", async () => {
    const logLines = captureLogLines();
    const { port, store, businesses, deps } = worldAt(webhookEvent.given.now);

    const started = performance.now();
    const response = await send(webhookEvent, deps);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: true, trace_id: traceId });

    expect(port.requests).toEqual([
      {
        endpoint: "businesses",
        signatureHeader: await signedHeaderOf(webhookEvent),
        raw: webhookEvent.request.raw,
        receivedAt: "2026-11-07T15:20:03.000Z",
        traceId,
      },
    ]);
    expect(businesses.calls).toEqual([{ account: EVENT.account, effectId: "eff-alex-grooms-deposit" }]);
    expect(store.rows).toEqual([
      {
        provider: "stripe",
        providerEventId: "stripe-evt-demo-0001",
        eventType: "payment_intent.succeeded",
        occurredAt: "2026-11-07T15:20:02Z",
        receivedAt: "2026-11-07T15:20:03.000Z",
        businessId: "biz-lees-barbershop",
        effectId: "eff-alex-grooms-deposit",
        payload: {
          kind: "paymentSucceeded",
          account: EVENT.account,
          testMode: true,
          payload: EVENT.payload,
        },
        traceId,
      },
    ]);

    // As K-07's provider-event-stripe.json stores the same event: its fields, id, business, effect and both times.
    const row = present(store.rows[0], "the stored row");
    const stored = providerEventStripe.event;
    expect(Object.keys(row).sort()).toEqual(Object.keys(stored).sort());
    expect(row).toMatchObject({
      provider: stored.provider,
      providerEventId: stored.providerEventId,
      businessId: stored.businessId,
      effectId: stored.effectId,
    });
    expect(Date.parse(present(row.occurredAt))).toBe(Date.parse(stored.occurredAt));
    expect(Date.parse(row.receivedAt)).toBe(Date.parse(stored.receivedAt));

    const spans = providerSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      hop: "providerWebhook",
      provider: "stripe",
      call: "verifyWebhook",
      event_id: "stripe-evt-demo-0001",
      business_id: "biz-lees-barbershop",
      outcome: "ok",
      got: { endpoint: "businesses", kind: "paymentSucceeded", stripeType: "payment_intent.succeeded" },
      decided: { signatureValid: true, knownEventId: false, answered: 200 },
      error_code: null,
      environment: "staging",
      version: "test-sha",
    });
  });

  it("verify-bad-signature: 401 and nothing stored, the event never parsed", async () => {
    const logLines = captureLogLines();
    const { port, store, businesses, deps } = worldAt(badSignature.given.now);

    const response = await send(badSignature, deps);

    expect(response.status).toBe(401);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
    expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
    expect(port.requests).toHaveLength(1);
    expect(businesses.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    const spans = providerSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      outcome: "refused",
      error_code: "badSignature",
      decided: { signatureValid: false, answered: 401 },
    });
    expect(spans[0]).not.toHaveProperty("event_id");
  });

  it("a body signed under the other endpoint's secret: 401 and nothing stored (each endpoint has its own secret)", async () => {
    captureLogLines();
    const { store, deps } = worldAt(webhookEvent.given.now);
    const t = timestampOf(webhookEvent);
    const underRosfield = await stripeSignature(STRIPE_TEST_SECRETS.rosfield, t, webhookEvent.request.raw);

    const response = await handleStripeWebhook(
      stripeRequest(stripePath("businesses"), `t=${t},v1=${underRosfield}`, webhookEvent.request.raw),
      "businesses",
      deps,
      WHERE,
    );

    expect(response.status).toBe(401);
    expect(store.calls).toHaveLength(0);
  });

  it("verify-ignored: a signed type Rosie does not use is 200 and nothing stored", async () => {
    const logLines = captureLogLines();
    const { store, deps } = worldAt(ignoredType.given.now);

    const response = await send(ignoredType, deps);

    expect(response.status).toBe(200);
    expect(store.calls).toHaveLength(0);
    expect(providerSpans(logLines())[0]).toMatchObject({
      outcome: "dropped",
      got: { endpoint: "businesses", stripeType: "customer.created" },
      decided: { signatureValid: true, ignoredType: true, answered: 200 },
    });
  });

  it("webhook-bill-card-saved on Rosfield's endpoint: stored with the business of the effect it names", async () => {
    captureLogLines();
    const { store, businesses, deps } = worldAt(billCardSaved.given.now);

    const response = await send(billCardSaved, deps);

    expect(response.status).toBe(200);
    expect(businesses.calls).toEqual([
      { account: { kind: "rosfield" }, effectId: "eff-sam-bill-card-lees-barbershop" },
    ]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      providerEventId: "stripe-evt-demo-0201",
      eventType: "setup_intent.succeeded",
      businessId: "biz-lees-barbershop",
      effectId: "eff-sam-bill-card-lees-barbershop",
      payload: { kind: "cardSaved", account: { kind: "rosfield" }, testMode: true },
    });
  });

  it("an event of no known business is stored with businessId null (K-07: the business when known)", async () => {
    const logLines = captureLogLines();
    const world = worldAt(cardDetails.given.now);
    const none: StripeBusinessLookup = { businessOf: () => Promise.resolve(null) };

    const response = await send(cardDetails, { ...world.deps, stripeBusinesses: none });

    expect(response.status).toBe(200);
    expect(world.store.rows[0]).toMatchObject({ providerEventId: "stripe-evt-demo-0102", businessId: null });
    expect(providerSpans(logLines())[0]).toMatchObject({ business_id: null, outcome: "ok" });
  });

  it("never keeps the request's own x-trace-id: the trace is opened at receipt", async () => {
    captureLogLines();
    const { store, deps } = worldAt(webhookEvent.given.now);
    const incoming = "11111111-2222-4333-8444-555555555555";
    const request = stripeRequest(
      stripePath("businesses"),
      await signedHeaderOf(webhookEvent),
      webhookEvent.request.raw,
    );
    request.headers.set("x-trace-id", incoming);

    const response = await handleStripeWebhook(request, "businesses", deps, WHERE);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).not.toBe(incoming);
    expect(store.rows[0]?.traceId).toBe(response.headers.get("x-trace-id"));
  });
});

describe("the same event id twice (K-05 v1.1 recordProviderEvent; provider-event-duplicate.json)", () => {
  it("webhook-event twice: 200 both times, stored once, the second a known event id with nothing more stored", async () => {
    const logLines = captureLogLines();
    const { store, deps } = worldAt(webhookEvent.given.now);

    const first = await send(webhookEvent, deps);
    const second = await send(webhookEvent, deps);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.calls).toHaveLength(2);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.traceId).toBe(first.headers.get("x-trace-id"));
    const spans = providerSpans(logLines());
    expect(spans.map((span) => span.outcome)).toEqual(["ok", "dropped"]);
    expect(spans[1]).toMatchObject({
      event_id: "stripe-evt-demo-0001",
      decided: { signatureValid: true, knownEventId: true, answered: 200 },
    });
    expect(spans[0]?.trace_id).not.toBe(spans[1]?.trace_id);
  });

  it("five deliveries of one event at once: each 200, stored once (the store decides it in the write itself)", async () => {
    captureLogLines();
    const { store, deps } = worldAt(webhookEvent.given.now);

    const responses = await Promise.all(Array.from({ length: 5 }, () => send(webhookEvent, deps)));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(store.calls).toHaveLength(5);
    expect(store.rows).toHaveLength(1);
  });
});

describe("odd input refused by the door itself before any HMAC: 401, nothing stored (fail closed ahead of T-1079)", () => {
  const t = timestampOf(webhookEvent);
  const raw = webhookEvent.request.raw;
  const good = (): Promise<string> =>
    stripeSignature(STRIPE_TEST_SECRETS.businesses, t, webhookEvent.request.raw);

  async function sendHeader(header: string | null, now = webhookEvent.given.now) {
    const logLines = captureLogLines();
    const world = worldAt(now);
    const response = await handleStripeWebhook(
      stripeRequest(stripePath("businesses"), header, raw),
      "businesses",
      world.deps,
      WHERE,
    );
    return { response, spans: providerSpans(logLines()), ...world };
  }

  it("a missing Stripe-Signature header", async () => {
    const { response, port, store, spans } = await sendHeader(null);
    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "badHeader" });
  });

  it.each([
    ["an empty header", (): Promise<string> => Promise.resolve("")],
    ["no t=", async () => `v1=${await good()}`],
    ["a t= that is not whole seconds", async () => `t=${t}.5,v1=${await good()}`],
    ["a t= that is not a number", async () => `t=NaN,v1=${await good()}`],
    ["two t=", async () => `t=${t},t=${t},v1=${await good()}`],
    ["no v1=", async () => `t=${t},v0=${await good()}`],
  ])("%s: badHeader", async (_name, header) => {
    const { response, port, store, spans } = await sendHeader(await header());
    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "badHeader" });
  });

  it(`more than ${String(MAX_SIGNATURE_ENTRIES)} v1= entries, the good one last: badSignature, no HMAC`, async () => {
    const signature = await good();
    const wrong = Array.from({ length: MAX_SIGNATURE_ENTRIES }, () => `v1=${changeOneByte(signature)}`);
    const { response, port, store, spans } = await sendHeader(`t=${t},${wrong.join(",")},v1=${signature}`);
    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "badSignature" });
  });

  it(`${String(MAX_SIGNATURE_ENTRIES)} v1= entries, the good one last: passed to the verify call, and stored`, async () => {
    const signature = await good();
    const wrong = Array.from({ length: MAX_SIGNATURE_ENTRIES - 1 }, () => `v1=${changeOneByte(signature)}`);
    const { response, port, store } = await sendHeader(`t=${t},${wrong.join(",")},v1=${signature}`);
    expect(response.status).toBe(200);
    expect(port.requests).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it.each([
    ["301 s before receipt", -301],
    ["301 s after receipt", 301],
  ])("a t= %s, its signature right for it: staleTimestamp", async (_name, offset) => {
    const at = String(Number(t) + offset);
    const signature = await stripeSignature(STRIPE_TEST_SECRETS.businesses, at, raw);
    const { response, port, store, spans } = await sendHeader(`t=${at},v1=${signature}`);
    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "refused", error_code: "staleTimestamp" });
  });

  it("a t= 300 s before receipt is inside the window: passed to the verify call", async () => {
    const at = String(Number(t) - 300);
    const signature = await stripeSignature(STRIPE_TEST_SECRETS.businesses, at, raw);
    const { response, port } = await sendHeader(`t=${at},v1=${signature}`);
    expect(port.requests).toHaveLength(1);
    // The double's own window holds it too, and it finds the event by its body: stored.
    expect(response.status).toBe(200);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("a clock that reads %s: refused, the verify call never asked", async (_name, reading) => {
    captureLogLines();
    const world = worldAt(webhookEvent.given.now);
    const response = await handleStripeWebhook(
      stripeRequest(stripePath("businesses"), `t=${t},v1=${await good()}`, raw),
      "businesses",
      { ...world.deps, now: () => reading },
      WHERE,
    );
    expect(response.status).toBe(401);
    expect(world.port.requests).toHaveLength(0);
    expect(world.store.calls).toHaveLength(0);
  });
});

describe("test mode (K-14 README 'Test mode')", () => {
  it("a live event on staging: 200, nothing stored", async () => {
    const logLines = captureLogLines();
    const { store, businesses, deps } = worldAt(webhookEvent.given.now, [liveEvent]);

    const response = await send(liveEvent, deps);

    expect(response.status).toBe(200);
    expect(businesses.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(providerSpans(logLines())[0]).toMatchObject({
      outcome: "dropped",
      decided: { signatureValid: true, testModeDropped: true, answered: 200 },
    });
  });

  it("on production: a test event is 200 and not stored; a live one is stored", async () => {
    captureLogLines();
    const production = { environment: "production", version: "test-sha" };
    const { store, deps } = worldAt(webhookEvent.given.now, [webhookEvent, liveEvent]);

    const test = await send(webhookEvent, deps, production);
    const live = await send(liveEvent, deps, production);

    expect(test.status).toBe(200);
    expect(live.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.payload).toMatchObject({ testMode: false });
  });
});

describe("a failure answers 503 with nothing stored, so Stripe retries", () => {
  async function sendWith(change: (deps: ProviderDeps, world: World) => ProviderDeps) {
    const logLines = captureLogLines();
    const world = worldAt(webhookEvent.given.now);
    const response = await send(webhookEvent, change(world.deps, world));
    return { response, spans: providerSpans(logLines()), ...world };
  }

  it("a verify call that cannot answer (an unset secret, the adapter down)", async () => {
    const down: StripePort = { verifyWebhook: () => Promise.reject(new Error("secret is not set")) };
    const { response, store, spans } = await sendWith((deps) => ({ ...deps, stripe: down }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: "verifyUnavailable" });
  });

  it.each([
    ["a result K-14 v1 does not have", { result: "verified", httpStatus: 200 }, "unknownVerifyResult"],
    ["no answer object", null, "unknownVerifyResult"],
    [
      "an event without its account",
      { result: "event", httpStatus: 200, event: { ...EVENT, account: undefined } },
      "badVerifyAnswer",
    ],
    [
      "an event whose test mode is not a yes or no",
      { result: "event", httpStatus: 200, event: { ...EVENT, testMode: "true" } },
      "badVerifyAnswer",
    ],
  ])("a verify answer off the contract: %s", async (_name, answer, code) => {
    const odd = { verifyWebhook: () => Promise.resolve(answer) } as unknown as StripePort;
    const { response, store, spans } = await sendWith((deps) => ({ ...deps, stripe: odd }));
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: code });
  });

  it("a business lookup that cannot answer", async () => {
    const down: StripeBusinessLookup = { businessOf: () => Promise.reject(new Error("no read")) };
    const { response, store, spans } = await sendWith((deps) => ({ ...deps, stripeBusinesses: down }));
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: "businessUnavailable" });
  });

  it("a business lookup that answers something that is not an id", async () => {
    const odd = { businessOf: () => Promise.resolve(42) } as unknown as StripeBusinessLookup;
    const { response, store, spans } = await sendWith((deps) => ({ ...deps, stripeBusinesses: odd }));
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: "badBusinessAnswer" });
  });

  it.each([
    ["a write that throws", "throw", "writeFailed"],
    ["K-05's transient error", { error: "transient", sqlstate: "40001" }, "transient"],
    [
      "K-05's constraint error",
      { error: "constraint", sqlstate: "23503", constraint: "provider_events_effect_fk" },
      "constraint",
    ],
    ["an answer K-05 v1.1 does not have", { result: "stored" }, "unknownStoreAnswer"],
    [
      "a recorded answer for another event",
      {
        result: "recorded",
        provider: "stripe",
        providerEventId: "stripe-evt-demo-9999",
        repeated: false,
        receivedAt: "2026-11-07T15:20:03Z",
        effectId: null,
      },
      "unknownStoreAnswer",
    ],
  ] as const)("%s", async (_name, failure, code) => {
    const { response, store, spans } = await sendWith((deps, world) => {
      world.store.failNext.push(failure);
      return deps;
    });
    expect(response.status).toBe(503);
    expect(store.rows).toHaveLength(0);
    expect(spans[0]).toMatchObject({
      outcome: "failed",
      error_code: code,
      decided: { signatureValid: true, answered: 503 },
    });
  });

  it("Stripe's retry after a failed write is stored once", async () => {
    captureLogLines();
    const { store, deps } = worldAt(webhookEvent.given.now);
    store.failNext.push("throw");

    const failedOnce = await send(webhookEvent, deps);
    const retried = await send(webhookEvent, deps);

    expect(failedOnce.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(store.rows).toHaveLength(1);
  });

  it("a body that cannot be read: 400, nothing stored", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(webhookEvent.given.now);
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("the connection dropped"));
      },
    });
    const request = new Request(`https://rosie.test${stripePath("businesses")}`, {
      method: "POST",
      headers: { "stripe-signature": await signedHeaderOf(webhookEvent) },
      body: broken,
    });

    const response = await handleStripeWebhook(request, "businesses", deps, WHERE);

    expect(response.status).toBe(400);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });
});

describe("the edge rules the door holds whatever an adapter sends", () => {
  it("a card number or a Social Security number in an event's text is swapped for its tag before the write", async () => {
    const logLines = captureLogLines();
    const world = worldAt(webhookEvent.given.now);
    // Off the contract on purpose: K-14 never carries such text, so the event is not K-14's type.
    const leaky = {
      verifyWebhook: () =>
        Promise.resolve({
          result: "event",
          httpStatus: 200,
          event: {
            ...EVENT,
            payload: { ...EVENT.payload, note: "card 4242 4242 4242 4242, ssn 078-05-1120" },
          },
        }),
    } as unknown as StripePort;

    const response = await send(webhookEvent, { ...world.deps, stripe: leaky });

    expect(response.status).toBe(200);
    expect(world.store.rows[0]?.payload.payload).toMatchObject({ note: "card [card number], ssn [SSN]" });
    // Whole numbers only: a fragment could turn up by chance inside a random trace id.
    expect(JSON.stringify(world.store.rows)).not.toMatch(/4242 4242 4242 4242|078-05-1120/);
    expect(providerSpans(logLines())[0]).toMatchObject({ decided: { scrubbed: 2 } });
  });

  it("writes no signature, secret, body or card detail to any log line, even when an error's message holds the event", async () => {
    const logLines = captureLogLines();
    const world = worldAt(cardDetails.given.now);
    world.store.failNext.push("throw");

    await send(cardDetails, world.deps);
    await send(cardDetails, world.deps);
    await sendBadSignature();

    const text = JSON.stringify(logLines());
    const header = await signedHeaderOf(cardDetails);
    expect(text).not.toContain(header.slice(header.indexOf("v1=") + 3));
    expect(text).not.toMatch(/whsec_|stripe-signature/i);
    // Only a raw body holds Stripe's API version; only a body or a payload holds the customer and the card.
    expect(text).not.toContain("2026-10-28.endive");
    expect(text).not.toMatch(/last4|visa|stripe-customer-demo/);
  });

  async function sendBadSignature(): Promise<void> {
    const world = worldAt(badSignature.given.now);
    await send(badSignature, world.deps);
  }
});

describe("the Worker's Stripe routes", () => {
  // The gateway never reads the context; the Workers runtime's own context has members this test cannot build.
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  it("answers a POST on each endpoint's path under BASE_PATH through its door", async () => {
    captureLogLines();
    const world = worldAt(webhookEvent.given.now);
    const routed = createWorker(() => ({
      ...unconfiguredGateway(),
      now: () => Date.parse(webhookEvent.given.now),
      providers: world.deps,
    }));

    const businesses = await routed.fetch(
      stripeRequest(stripePath("businesses"), await signedHeaderOf(webhookEvent), webhookEvent.request.raw),
      env,
      context,
    );
    const rosfieldNow = createWorker(() => ({
      ...unconfiguredGateway(),
      now: () => Date.parse(billCardSaved.given.now),
      providers: world.deps,
    }));
    const rosfield = await rosfieldNow.fetch(
      stripeRequest(stripePath("rosfield"), await signedHeaderOf(billCardSaved), billCardSaved.request.raw),
      env,
      context,
    );

    expect(businesses.status).toBe(200);
    expect(rosfield.status).toBe(200);
    expect(world.store.rows.map((row) => row.providerEventId)).toEqual([
      "stripe-evt-demo-0001",
      "stripe-evt-demo-0201",
    ]);
  });

  it("answers any other method on a Stripe path with 405", async () => {
    captureLogLines();
    const routed = createWorker(() => unconfiguredGateway());

    const response = await routed.fetch(
      new Request(`https://rosie.test${stripePath("businesses")}`, { method: "GET" }),
      env,
      context,
    );

    expect(response.status).toBe(405);
  });

  it("answers 503 while the Stripe adapter and the store are not connected, and 401 to a header it cannot read", async () => {
    captureLogLines();
    const t = String(Math.floor(Date.now() / 1000));
    const signature = await stripeSignature(STRIPE_TEST_SECRETS.businesses, t, webhookEvent.request.raw);

    const signed = await worker.fetch(
      stripeRequest(stripePath("businesses"), `t=${t},v1=${signature}`, webhookEvent.request.raw),
      env,
      context,
    );
    const unsigned = await worker.fetch(
      stripeRequest(stripePath("rosfield"), null, webhookEvent.request.raw),
      env,
      context,
    );

    expect(signed.status).toBe(503);
    expect(signed.headers.get("x-trace-id")).toMatch(UUID);
    expect(unsigned.status).toBe(401);
  });
});

describe("the Stripe door's body cap (T-1195; ../body.ts, as the page entry and the Linq webhook since T-1180)", () => {
  // The gateway never reads the context; the Workers runtime's own context has members this test cannot build.
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  /** webhook-event with its raw body followed by spaces to exactly `bytes` bytes: still its JSON, signed over it whole. */
  function paddedEvent(bytes: number): StripeExchange {
    const { raw } = webhookEvent.request;
    const padded = raw + " ".repeat(bytes - new TextEncoder().encode(raw).byteLength);
    return { ...webhookEvent, request: { ...webhookEvent.request, raw: padded } };
  }

  /** webhook-event's signed header on a streamed body to the businesses endpoint, with these headers besides. */
  async function streamedEvent(
    stream: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ): Promise<Request> {
    return postOf(
      stream,
      { "stripe-signature": await signedHeaderOf(webhookEvent), ...headers },
      `https://rosie.test${stripePath("businesses")}`,
    );
  }

  it("a body one byte over its cap: 413 with the trace id, never verified, nothing stored, only a refused span logged", async () => {
    const logLines = captureLogLines();
    const over = paddedEvent(STRIPE_BODY_LIMIT_BYTES + 1);
    const { port, store, businesses, deps } = worldAt(webhookEvent.given.now, [over]);

    const response = await send(over, deps);

    expect(response.status).toBe(413);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large", trace_id: traceId });
    expect(port.requests).toEqual([]);
    expect(businesses.calls).toEqual([]);
    expect(store.calls).toEqual([]);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    const spans = providerSpans(lines);
    expect(spans).toMatchObject([
      {
        trace_id: traceId,
        hop: "providerWebhook",
        provider: "stripe",
        call: "verifyWebhook",
        outcome: "refused",
        error_code: "bodyTooLarge",
      },
    ]);
    expect(spans[0]?.got).toEqual({ endpoint: "businesses" });
    expect(spans[0]?.decided).toEqual({ answered: 413 });
    expect(spans[0]).not.toHaveProperty("event_id");
    const text = JSON.stringify(lines);
    const header = await signedHeaderOf(over);
    expect(text).not.toContain(header.slice(header.indexOf("v1=") + 3));
    expect(text).not.toContain("2026-10-28.endive");
    expect(text).not.toMatch(/stripe-evt-demo-0001|stripe-customer-demo/);
  });

  it("a body exactly at its cap is verified as sent, its signature over the whole body, and stored", async () => {
    captureLogLines();
    const atCap = paddedEvent(STRIPE_BODY_LIMIT_BYTES);
    const { port, store, deps } = worldAt(webhookEvent.given.now, [atCap]);

    const response = await send(atCap, deps);

    expect(response.status).toBe(200);
    expect(port.requests).toHaveLength(1);
    const raw = present(port.requests[0], "the verify request").raw;
    expect(raw).toBe(atCap.request.raw);
    expect(new TextEncoder().encode(raw).byteLength).toBe(STRIPE_BODY_LIMIT_BYTES);
    expect(store.rows.map((row) => row.providerEventId)).toEqual(["stripe-evt-demo-0001"]);
  });

  it("a declared length over its cap is answered 413 before a byte of the body is read, never verified", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(webhookEvent.given.now);
    const source = countedStream(1024, () => xBytes(1024));

    const response = await handleStripeWebhook(
      await streamedEvent(source.stream, { "content-length": String(STRIPE_BODY_LIMIT_BYTES + 1) }),
      "businesses",
      deps,
      WHERE,
    );

    expect(response.status).toBe(413);
    expect(source.pulled()).toBe(0);
    expect(port.requests).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("a body that declares no length is cut off at the chunk that takes it over its cap: a 1 GiB body is never read whole", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(webhookEvent.given.now);
    const source = countedStream(1024 * 1024, () => xBytes(1024));

    const response = await handleStripeWebhook(await streamedEvent(source.stream), "businesses", deps, WHERE);

    expect(response.status).toBe(413);
    expect(source.pulled()).toBeGreaterThan(STRIPE_BODY_LIMIT_BYTES / 1024);
    expect(source.pulled()).toBeLessThan((2 * STRIPE_BODY_LIMIT_BYTES) / 1024);
    expect(source.cancelled()).toBe(true);
    expect(port.requests).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it("over its cap, 413 comes before every signature check: no header, a stale t= and a clock that is not a number are each 401 under it", async () => {
    captureLogLines();
    const t = timestampOf(webhookEvent);
    const stale = String(Number(t) - 301);
    const under = webhookEvent.request.raw;
    const over = paddedEvent(STRIPE_BODY_LIMIT_BYTES + 1).request.raw;
    const answer = async (raw: string, header: string | null, now?: () => number) => {
      const world = worldAt(webhookEvent.given.now);
      const deps = now === undefined ? world.deps : { ...world.deps, now };
      const response = await handleStripeWebhook(
        stripeRequest(stripePath("businesses"), header, raw),
        "businesses",
        deps,
        WHERE,
      );
      return { status: response.status, verified: world.port.requests.length };
    };
    const staleHeader = async (raw: string): Promise<string> =>
      `t=${stale},v1=${await stripeSignature(STRIPE_TEST_SECRETS.businesses, stale, raw)}`;
    const goodHeader = async (raw: string): Promise<string> =>
      `t=${t},v1=${await stripeSignature(STRIPE_TEST_SECRETS.businesses, t, raw)}`;
    const notANumber = (): number => Number.NaN;

    expect(await answer(under, null)).toEqual({ status: 401, verified: 0 });
    expect(await answer(over, null)).toEqual({ status: 413, verified: 0 });
    expect(await answer(under, await staleHeader(under))).toEqual({ status: 401, verified: 0 });
    expect(await answer(over, await staleHeader(over))).toEqual({ status: 413, verified: 0 });
    expect(await answer(under, await goodHeader(under), notANumber)).toEqual({ status: 401, verified: 0 });
    expect(await answer(over, await goodHeader(over), notANumber)).toEqual({ status: 413, verified: 0 });
  });

  it("its cap is its own config value: ProviderDoors.stripeBodyLimitBytes sets it, the calendar doors' does not, and a mistyped value leaves the default", async () => {
    captureLogLines();
    const size = new TextEncoder().encode(webhookEvent.request.raw).byteLength;
    const answer = async (more: Partial<ProviderDeps>): Promise<number> => {
      const world = worldAt(webhookEvent.given.now);
      return (await send(webhookEvent, { ...world.deps, ...more })).status;
    };

    expect(await answer({ stripeBodyLimitBytes: size - 1 })).toBe(413);
    expect(await answer({ stripeBodyLimitBytes: size })).toBe(200);
    expect(await answer({ calendarBodyLimitBytes: 1 })).toBe(200);
    expect(await answer({ stripeBodyLimitBytes: Number.NaN })).toBe(200);
    expect(await answer({ stripeBodyLimitBytes: -1 })).toBe(200);
  });

  it("through the Worker's routes: GatewayDeps.providers carries the cap, and the Worker with none set refuses a body one byte over 256 KiB", async () => {
    captureLogLines();
    const world = worldAt(webhookEvent.given.now);
    const routed = createWorker(() => ({
      ...unconfiguredGateway(),
      now: () => Date.parse(webhookEvent.given.now),
      providers: { ...world.deps, stripeBodyLimitBytes: 64 },
    }));

    const capped = await routed.fetch(
      stripeRequest(stripePath("businesses"), await signedHeaderOf(webhookEvent), webhookEvent.request.raw),
      env,
      context,
    );
    const overDefault = await worker.fetch(
      stripeRequest(stripePath("rosfield"), null, paddedEvent(STRIPE_BODY_LIMIT_BYTES + 1).request.raw),
      env,
      context,
    );

    expect(capped.status).toBe(413);
    expect(capped.headers.get("x-trace-id")).toMatch(UUID);
    expect(world.port.requests).toEqual([]);
    expect(world.store.calls).toEqual([]);
    expect(overDefault.status).toBe(413);
    expect(await overDefault.json()).toMatchObject({ ok: false, error: "payload_too_large" });
  });
});
