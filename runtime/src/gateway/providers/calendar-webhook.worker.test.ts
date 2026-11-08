// The calendar webhook doors, run inside the Workers runtime (T-275). The calendar port is a double that compares each
// push's verifier with one made at test time for its watch and answers the K-16 fixture holding the same push; K-05
// v1.1's recordProviderEvent is a fake that stores once by (provider, provider event id), held here to K-05's own
// provider-event-recorded.json and provider-event-duplicate.json. Fixtures: contracts/port-calendar,
// contracts/outbox-effects, contracts/data-access. Test values only: the fixtures' demo shop and cast.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { createWorker } from "../../index";
import providerEventDuplicate from "../../../../contracts/data-access/fixtures/provider-event-duplicate.json";
import providerEventRecorded from "../../../../contracts/data-access/fixtures/provider-event-recorded.json";
import providerEventCalendar from "../../../../contracts/outbox-effects/fixtures/provider-event-calendar.json";
import googleSync from "../../../../contracts/port-calendar/fixtures/notification-google-sync.json";
import google from "../../../../contracts/port-calendar/fixtures/notification-google.json";
import lifecycle from "../../../../contracts/port-calendar/fixtures/notification-microsoft-lifecycle.json";
import validation from "../../../../contracts/port-calendar/fixtures/notification-microsoft-validation.json";
import microsoft from "../../../../contracts/port-calendar/fixtures/notification-microsoft.json";
import wrongVerifier from "../../../../contracts/port-calendar/fixtures/notification-rejected.json";
import { unconfiguredGateway } from "..";
import { present } from "../test-support";
import { unconfiguredProviders } from ".";
import { handleCalendarWebhook } from "./calendar-webhook";
import {
  calendarPath,
  calendarPortDouble,
  captureLogLines,
  googlePushRequest,
  graphBodyRequest,
  graphNotificationsRequest,
  graphValidationRequest,
  providerEventStoreFake,
  providerSpans,
  type CalendarExchange,
  type CalendarPortDouble,
  type ProviderEventStoreFake,
} from "./test-support";
import type { CalendarPort, ProviderDeps, ProviderEvent } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WHERE = { environment: "staging", version: "test-sha" };
const ALL: CalendarExchange[] = [google, googleSync, wrongVerifier, microsoft, lifecycle, validation];

/** K-16 calendar.span's closed lists of what a push's span got and decided. */
const SPAN_GOT = [
  "step",
  "link",
  "watch",
  "trigger",
  "purpose",
  "effect",
  "booking",
  "visit",
  "idempotencyKey",
  "previousTry",
  "notices",
];
const SPAN_DECIDED = [
  "result",
  "full",
  "blocks",
  "removed",
  "busy",
  "stored",
  "unknownWatches",
  "eventWritten",
  "eventUpdated",
  "eventDeleted",
  "alreadyDone",
  "outageRow",
];

interface World {
  port: CalendarPortDouble;
  store: ProviderEventStoreFake;
  deps: ProviderDeps;
}

/** The doors with the K-16 double and the K-05 fake, the clock at `now`. */
function worldAt(now: string, exchanges: readonly CalendarExchange[] = ALL): World {
  const port = calendarPortDouble(exchanges);
  const store = providerEventStoreFake();
  const deps: ProviderDeps = {
    ...unconfiguredProviders(),
    calendar: port,
    events: store,
    bundleId: () => ({ hash: "a".repeat(64), build: 1 }),
    now: () => Date.parse(now),
  };
  return { port, store, deps };
}

/** A K-16 fixture's Google push, its token the one made for its channel (or another, when it is to be wrong). */
function googleRequest(port: CalendarPortDouble, push: Record<string, unknown>, token?: string): Request {
  return googlePushRequest(push, token ?? port.verifierOf(String(push.channelId)));
}

/** A K-16 fixture's Graph notifications, each clientState the one made for its subscription. */
function graphRequest(
  port: CalendarPortDouble,
  exchange: { request: { notifications: unknown[] } },
): Request {
  return graphNotificationsRequest(
    exchange.request.notifications as Record<string, unknown>[],
    port.verifierOf,
  );
}

function expectClosedSpanFacts(span: Record<string, unknown> | undefined): void {
  const facts = present(span, "the span");
  for (const name of Object.keys(facts.got as object)) expect(SPAN_GOT).toContain(name);
  for (const name of Object.keys(facts.decided as object)) expect(SPAN_DECIDED).toContain(name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhooks/calendar/google", () => {
  it("notification-google: 200 in under 1 s, stored once and linked as provider-event-calendar.json shows", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(google.given.now);
    const token = port.verifierOf(google.request.channelId);

    const started = performance.now();
    const response = await handleCalendarWebhook(googleRequest(port, google.request), "google", deps, WHERE);
    const elapsed = performance.now() - started;

    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(UUID);
    expect(await response.json()).toEqual({ ok: true, trace_id: traceId });

    expect(port.requests).toEqual([
      {
        provider: "google",
        kind: "push",
        channelId: "gcal-channel-riley-03",
        channelToken: token,
        resourceId: "gcal-resource-riley-primary",
        resourceState: "exists",
        messageNumber: "7",
        channelExpiration: "Mon, 16 Nov 2026 15:02:00 GMT",
        receivedAt: "2026-11-12T21:15:00.000Z",
        traceId,
      },
    ]);
    expect(store.rows).toEqual([
      {
        provider: "google_calendar",
        providerEventId: "gcal-channel-riley-03:7",
        eventType: "exists",
        occurredAt: null,
        receivedAt: "2026-11-12T21:15:00.000Z",
        businessId: null,
        effectId: null,
        payload: {
          calendarLinkId: "callink-riley-google",
          watchId: "gcal-channel-riley-03",
          notice: "changed",
        },
        traceId,
      },
    ]);

    // K-07's provider-event-calendar.json is this same push (received 2026-11-12T21:15:00Z under trace-gcal-0001, as
    // notification-google.json is) in K-07's placeholder shape: the stored row has its fields, its provider and its
    // receipt time, links to no effect row as it does (S12-33), and carries the trace opened at receipt.
    const row = present(store.rows[0], "the stored row");
    const shown = providerEventCalendar.event;
    expect(providerEventCalendar.record).toBe("providerEvent");
    expect(Object.keys(row).sort()).toEqual(Object.keys(shown).sort());
    expect(row.provider).toBe(shown.provider);
    expect(row.effectId).toBe(shown.effectId);
    expect(row.occurredAt).toBe(shown.occurredAt);
    expect(Date.parse(row.receivedAt)).toBe(Date.parse(shown.receivedAt));
    expect(row.traceId).toBe(traceId);

    const spans = providerSpans(logLines());
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      trace_id: traceId,
      hop: "providerWebhook",
      provider: "google_calendar",
      call: "verifyNotification",
      outcome: "ok",
      got: { watch: "gcal-channel-riley-03", link: "callink-riley-google", notices: 1 },
      decided: { result: "accepted", stored: 1, unknownWatches: 0 },
      error_code: null,
    });
    expectClosedSpanFacts(spans[0]);
  });

  it("notification-rejected (a token not made for the channel): 401 and nothing stored", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(wrongVerifier.given.now);

    const response = await handleCalendarWebhook(
      googleRequest(port, wrongVerifier.request, "a-token-made-for-another-channel"),
      "google",
      deps,
      WHERE,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
    expect(port.requests).toHaveLength(1);
    expect(store.calls).toHaveLength(0);
    const spans = providerSpans(logLines());
    expect(spans[0]).toMatchObject({
      outcome: "refused",
      error_code: "verifierMismatch",
      decided: { result: "rejected", stored: 0 },
    });
    expect(spans[0]?.got).not.toHaveProperty("watch");
    expectClosedSpanFacts(spans[0]);
  });

  it("a push with no token: the check gets an empty one and refuses it, 401 and nothing stored", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(google.given.now);
    const request = googlePushRequest(google.request, null);

    const response = await handleCalendarWebhook(request, "google", deps, WHERE);

    expect(response.status).toBe(401);
    expect(port.requests[0]).toMatchObject({ channelToken: "" });
    expect(store.calls).toHaveLength(0);
  });

  it("notification-google-sync: Google's sync message is 200 and nothing stored", async () => {
    const logLines = captureLogLines();
    const { store, port, deps } = worldAt(googleSync.given.now);

    const response = await handleCalendarWebhook(
      googleRequest(port, googleSync.request),
      "google",
      deps,
      WHERE,
    );

    expect(response.status).toBe(200);
    expect(store.calls).toHaveLength(0);
    const spans = providerSpans(logLines());
    expect(spans[0]).toMatchObject({
      outcome: "dropped",
      got: { watch: "gcal-channel-riley-01", notices: 1 },
      decided: { result: "ignored", stored: 0 },
    });
    expectClosedSpanFacts(spans[0]);
  });

  it.each([
    ["no channel id", "X-Goog-Channel-ID"],
    ["no resource state", "X-Goog-Resource-State"],
    ["no message number", "X-Goog-Message-Number"],
  ])(
    "a push the door cannot read (%s): 401, the check never asked, nothing stored",
    async (_name, header) => {
      const logLines = captureLogLines();
      const { port, store, deps } = worldAt(google.given.now);
      const request = googleRequest(port, google.request);
      request.headers.delete(header);

      const response = await handleCalendarWebhook(request, "google", deps, WHERE);

      expect(response.status).toBe(401);
      expect(port.requests).toHaveLength(0);
      expect(store.calls).toHaveLength(0);
      expect(providerSpans(logLines())[0]).toMatchObject({ outcome: "refused", error_code: "unreadable" });
    },
  );

  it("a message number that is not whole digits: 401, the check never asked", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(google.given.now);
    const request = googleRequest(port, { ...google.request, messageNumber: "7; drop" });

    const response = await handleCalendarWebhook(request, "google", deps, WHERE);

    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });
});

describe("POST /webhooks/calendar/microsoft", () => {
  it("notification-microsoft: 200, stored once under Graph's notification id", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(microsoft.given.now);

    const response = await handleCalendarWebhook(graphRequest(port, microsoft), "microsoft", deps, WHERE);

    expect(response.status).toBe(200);
    const traceId = response.headers.get("x-trace-id");
    expect(port.requests).toEqual([
      {
        provider: "microsoft",
        kind: "notifications",
        notifications: [
          {
            notificationId: "graph-notif-demo-0001",
            subscriptionId: "graph-sub-sam-01",
            clientState: port.verifierOf("graph-sub-sam-01"),
            changeType: "updated",
            lifecycleEvent: null,
            subscriptionExpirationDateTime: "2026-11-13T09:20:30Z",
          },
        ],
        receivedAt: "2026-11-08T16:00:00.000Z",
        traceId,
      },
    ]);
    expect(store.rows).toEqual([
      {
        provider: "microsoft_calendar",
        providerEventId: "graph-notif-demo-0001",
        eventType: "updated",
        occurredAt: null,
        receivedAt: "2026-11-08T16:00:00.000Z",
        businessId: null,
        effectId: null,
        payload: { calendarLinkId: "callink-sam-microsoft", watchId: "graph-sub-sam-01", notice: "changed" },
        traceId,
      },
    ]);
    const spans = providerSpans(logLines());
    expect(spans[0]).toMatchObject({
      provider: "microsoft_calendar",
      got: { watch: "graph-sub-sam-01", link: "callink-sam-microsoft", notices: 1 },
      decided: { result: "accepted", stored: 1, unknownWatches: 0 },
    });
    expectClosedSpanFacts(spans[0]);
  });

  it("notification-microsoft-lifecycle: both stored once; the same POST again is 200 and stores nothing more", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(lifecycle.given.now);

    const first = await handleCalendarWebhook(graphRequest(port, lifecycle), "microsoft", deps, WHERE);
    const again = await handleCalendarWebhook(graphRequest(port, lifecycle), "microsoft", deps, WHERE);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(store.calls).toHaveLength(4);
    expect(store.rows.map((row) => [row.providerEventId, row.eventType])).toEqual([
      ["graph-sub-sam-01:reauthorizationRequired:2026-11-13T09:20:30Z", "reauthorizationRequired"],
      ["graph-sub-sam-01:missed:2026-11-13T09:20:30Z", "missed"],
    ]);
    const spans = providerSpans(logLines());
    expect(spans.map((span) => [span.outcome, (span.decided as { stored: number }).stored])).toEqual([
      ["ok", 2],
      ["dropped", 0],
    ]);
  });

  it("notification-microsoft-validation: 200, text/plain, the token itself, and nothing stored", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(validation.given.now);

    const response = await handleCalendarWebhook(
      graphValidationRequest(validation.request.validationToken),
      "microsoft",
      deps,
      WHERE,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("graph-validation-demo-0001");
    const traceId = response.headers.get("x-trace-id");
    expect(port.requests).toEqual([
      {
        provider: "microsoft",
        kind: "validation",
        validationToken: "graph-validation-demo-0001",
        receivedAt: "2026-11-02T21:21:58.000Z",
        traceId,
      },
    ]);
    expect(store.calls).toHaveLength(0);
    const spans = providerSpans(logLines());
    expect(spans[0]).toMatchObject({ outcome: "dropped", decided: { result: "validation", stored: 0 } });
    expectClosedSpanFacts(spans[0]);
  });

  it("a notification whose clientState was not made for its subscription: 401 and nothing stored", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(microsoft.given.now);
    const request = graphNotificationsRequest(
      microsoft.request.notifications,
      () => "a-client-state-made-for-another-subscription",
    );

    const response = await handleCalendarWebhook(request, "microsoft", deps, WHERE);

    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(1);
    expect(store.calls).toHaveLength(0);
  });

  it.each([
    ["a body that is not JSON", "value=1"],
    ["no value list", "{}"],
    ["an empty value list", '{"value":[]}'],
    ["an item with no subscription", '{"value":[{"id":"n1","clientState":"x","changeType":"updated"}]}'],
    [
      "an item with both a change and a lifecycle event",
      '{"value":[{"subscriptionId":"s1","clientState":"x","changeType":"updated","lifecycleEvent":"missed"}]}',
    ],
    ["an item with neither", '{"value":[{"subscriptionId":"s1","clientState":"x"}]}'],
    [
      "a change type Graph does not send",
      '{"value":[{"subscriptionId":"s1","clientState":"x","changeType":"moved"}]}',
    ],
    [
      "a clientState that is not text",
      '{"value":[{"subscriptionId":"s1","clientState":7,"changeType":"updated"}]}',
    ],
  ])("a POST the door cannot read (%s): 401, the check never asked, nothing stored", async (_name, body) => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(microsoft.given.now);

    const response = await handleCalendarWebhook(graphBodyRequest(body), "microsoft", deps, WHERE);

    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
    expect(providerSpans(logLines())[0]).toMatchObject({ outcome: "refused", error_code: "unreadable" });
  });

  it("an empty validation token: 401, the check never asked", async () => {
    captureLogLines();
    const { port, deps } = worldAt(validation.given.now);

    const response = await handleCalendarWebhook(graphValidationRequest(""), "microsoft", deps, WHERE);

    expect(response.status).toBe(401);
    expect(port.requests).toHaveLength(0);
  });
});

describe("the same event id twice (K-05 v1.1 recordProviderEvent; provider-event-duplicate.json)", () => {
  it("the store fake answers K-05's own exchanges: recorded, then the repeat with the stored row and nothing written", async () => {
    const store = providerEventStoreFake();

    const recorded = await store.recordProviderEvent(
      providerEventRecorded.request as unknown as ProviderEvent,
    );
    const repeated = await store.recordProviderEvent(
      providerEventDuplicate.request as unknown as ProviderEvent,
    );

    expect(recorded).toEqual(providerEventRecorded.outcome);
    expect(repeated).toEqual(providerEventDuplicate.outcome);
    expect(store.rows).toEqual([providerEventRecorded.request]);
  });

  it("notification-google twice (Google sends the same push again): 200 both times, stored once", async () => {
    const logLines = captureLogLines();
    const { port, store, deps } = worldAt(google.given.now);

    const first = await handleCalendarWebhook(googleRequest(port, google.request), "google", deps, WHERE);
    const again = await handleCalendarWebhook(googleRequest(port, google.request), "google", deps, WHERE);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(store.calls).toHaveLength(2);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.traceId).toBe(first.headers.get("x-trace-id"));
    const spans = providerSpans(logLines());
    expect(spans.map((span) => span.outcome)).toEqual(["ok", "dropped"]);
    expect(spans[1]).toMatchObject({ decided: { result: "accepted", stored: 0, unknownWatches: 0 } });
  });
});

describe("a failure answers 503 with nothing stored, so the provider retries", () => {
  async function sendGoogle(change: (deps: ProviderDeps, world: World) => ProviderDeps) {
    const logLines = captureLogLines();
    const world = worldAt(google.given.now);
    const response = await handleCalendarWebhook(
      googleRequest(world.port, google.request),
      "google",
      change(world.deps, world),
      WHERE,
    );
    return { response, spans: providerSpans(logLines()), ...world };
  }

  it("a check that cannot answer (the push secret unset, the adapter down)", async () => {
    const down: CalendarPort = { verifyNotification: () => Promise.reject(new Error("no secret")) };
    const { response, store, spans } = await sendGoogle((deps) => ({ ...deps, calendar: down }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "unavailable" });
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: "verifyUnavailable" });
    expectClosedSpanFacts(spans[0]);
  });

  const event = google.outcome.events[0];
  it.each([
    ["a result K-16 v1 does not have", { result: "stored", httpStatus: 200 }, "unknownVerifyResult"],
    [
      "an event of the other provider",
      {
        result: "accepted",
        httpStatus: 200,
        events: [{ ...event, provider: "microsoft_calendar" }],
        unknownWatches: 0,
      },
      "badVerifyAnswer",
    ],
    [
      "an event whose payload is not a calendar notice",
      {
        result: "accepted",
        httpStatus: 200,
        events: [{ ...event, payload: { calendarLinkId: "callink-riley-google", title: "Dentist" } }],
        unknownWatches: 0,
      },
      "badVerifyAnswer",
    ],
    [
      "unknown watches that are not a count",
      { result: "accepted", httpStatus: 200, events: [], unknownWatches: -1 },
      "badVerifyAnswer",
    ],
    [
      "a handshake answer to a push",
      { result: "validation", httpStatus: 200, contentType: "text/plain", body: "x" },
      "badVerifyAnswer",
    ],
  ])("a check answer off the contract: %s", async (_name, answer, code) => {
    const odd = { verifyNotification: () => Promise.resolve(answer) } as unknown as CalendarPort;
    const { response, store, spans } = await sendGoogle((deps) => ({ ...deps, calendar: odd }));
    expect(response.status).toBe(503);
    expect(store.calls).toHaveLength(0);
    expect(spans[0]).toMatchObject({ outcome: "failed", error_code: code });
  });

  it("a handshake answered with another body: 503, never echoed", async () => {
    captureLogLines();
    const world = worldAt(validation.given.now);
    const odd = {
      verifyNotification: () =>
        Promise.resolve({
          result: "validation",
          httpStatus: 200,
          contentType: "text/plain",
          body: "<script>",
        }),
    } as unknown as CalendarPort;

    const response = await handleCalendarWebhook(
      graphValidationRequest(validation.request.validationToken),
      "microsoft",
      { ...world.deps, calendar: odd },
      WHERE,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("<script>");
  });

  it("Google's sync answer to Graph's notifications: 503", async () => {
    captureLogLines();
    const world = worldAt(microsoft.given.now);
    const odd = {
      verifyNotification: () => Promise.resolve({ result: "ignored", httpStatus: 200, why: "syncMessage" }),
    } as unknown as CalendarPort;

    const response = await handleCalendarWebhook(
      graphRequest(world.port, microsoft),
      "microsoft",
      { ...world.deps, calendar: odd },
      WHERE,
    );

    expect(response.status).toBe(503);
    expect(world.store.calls).toHaveLength(0);
  });

  it.each([
    ["a write that throws", "throw", "writeFailed"],
    ["K-05's transient error", { error: "transient", sqlstate: "40P01" }, "transient"],
  ] as const)("%s", async (_name, failure, code) => {
    const { response, store, spans } = await sendGoogle((deps, world) => {
      world.store.failNext.push(failure);
      return deps;
    });
    expect(response.status).toBe(503);
    expect(store.rows).toHaveLength(0);
    expect(spans[0]).toMatchObject({
      outcome: "failed",
      error_code: code,
      decided: { result: "accepted", stored: 0 },
    });
  });

  it("a lifecycle POST whose second write fails: 503; Graph's retry stores the second, the first a known id", async () => {
    captureLogLines();
    const { port, store, deps } = worldAt(lifecycle.given.now);
    // Only the second write of all fails; every other goes to the fake.
    let writes = 0;
    const flaky = {
      recordProviderEvent: (row: ProviderEvent) => {
        writes += 1;
        return writes === 2 ? Promise.reject(new Error("the write failed")) : store.recordProviderEvent(row);
      },
    };

    const failedOnce = await handleCalendarWebhook(
      graphRequest(port, lifecycle),
      "microsoft",
      { ...deps, events: flaky },
      WHERE,
    );
    const retried = await handleCalendarWebhook(
      graphRequest(port, lifecycle),
      "microsoft",
      { ...deps, events: flaky },
      WHERE,
    );

    expect(failedOnce.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(store.rows.map((row) => row.eventType)).toEqual(["reauthorizationRequired", "missed"]);
  });

  it("a clock that is not a number: 503, the check never asked, nothing stored", async () => {
    captureLogLines();
    const world = worldAt(google.given.now);

    const response = await handleCalendarWebhook(
      googleRequest(world.port, google.request),
      "google",
      { ...world.deps, now: () => Number.NaN },
      WHERE,
    );

    expect(response.status).toBe(503);
    expect(world.port.requests).toHaveLength(0);
    expect(world.store.calls).toHaveLength(0);
  });
});

describe("a push for a watch Rosie no longer holds", () => {
  it("is 200 so the provider stops, counted and never stored", async () => {
    const logLines = captureLogLines();
    const world = worldAt(google.given.now);
    const stopped: CalendarPort = {
      verifyNotification: () =>
        Promise.resolve({ result: "accepted", httpStatus: 200, events: [], unknownWatches: 1 }),
    };

    const response = await handleCalendarWebhook(
      googleRequest(world.port, google.request),
      "google",
      { ...world.deps, calendar: stopped },
      WHERE,
    );

    expect(response.status).toBe(200);
    expect(world.store.calls).toHaveLength(0);
    expect(providerSpans(logLines())[0]).toMatchObject({
      outcome: "dropped",
      decided: { result: "accepted", stored: 0, unknownWatches: 1 },
    });
  });
});

describe("logs", () => {
  it("write no verifier, token or body to any log line, even when an error's message holds the event", async () => {
    const logLines = captureLogLines();
    const world = worldAt(microsoft.given.now);
    world.store.failNext.push("throw");
    const verifier = world.port.verifierOf("graph-sub-sam-01");

    await handleCalendarWebhook(graphRequest(world.port, microsoft), "microsoft", world.deps, WHERE);
    await handleCalendarWebhook(graphRequest(world.port, microsoft), "microsoft", world.deps, WHERE);
    await handleCalendarWebhook(
      graphValidationRequest("graph-validation-demo-0001"),
      "microsoft",
      worldAt(validation.given.now).deps,
      WHERE,
    );

    const text = JSON.stringify(logLines());
    expect(text).not.toContain(verifier);
    expect(text).not.toContain("graph-validation-demo-0001");
    expect(text).not.toContain("tenantId");
    expect(text).not.toContain("graph-notif-demo-0001");
  });
});

describe("the Worker's calendar routes", () => {
  // The gateway never reads the context; the Workers runtime's own context has members this test cannot build.
  const context = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  it("answers a POST on each provider's path under BASE_PATH through its door", async () => {
    captureLogLines();
    const world = worldAt(google.given.now);
    const routed = createWorker(() => ({
      ...unconfiguredGateway(),
      now: () => Date.parse(google.given.now),
      providers: world.deps,
    }));

    const fromGoogle = await routed.fetch(googleRequest(world.port, google.request), env, context);
    const handshake = await routed.fetch(graphValidationRequest("graph-validation-demo-0001"), env, context);

    expect(fromGoogle.status).toBe(200);
    expect(world.store.rows).toHaveLength(1);
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe("graph-validation-demo-0001");
  });

  it("answers any other method on a calendar path with 405", async () => {
    captureLogLines();
    const routed = createWorker(() => unconfiguredGateway());

    const response = await routed.fetch(
      new Request(`https://rosie.test${calendarPath("google")}`, { method: "GET" }),
      env,
      context,
    );

    expect(response.status).toBe(405);
  });

  it("answers 503 while the calendar adapters and the store are not connected", async () => {
    captureLogLines();
    const port = calendarPortDouble(ALL);

    const response = await worker.fetch(googleRequest(port, google.request), env, context);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-trace-id")).toMatch(UUID);
  });
});
