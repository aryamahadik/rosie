// The provider doors held to the frozen schemas (T-275), run under Node because Ajv cannot run in the Workers runtime:
// what each door hands its port (K-14 verifyWebhook.request, K-16 verifyNotification.request), every row it stores (K-07
// v1 providerEvent, in provider-event-stripe.json's and provider-event-calendar.json's record form; K-05 v1.1
// recordProviderEvent.request; K-16 calendarProviderEvent), the store fake's answers (K-05 v1.1
// recordProviderEvent.response) and every span (K-08 v1 span; K-16 calendar.span). The doors run as the Worker runs
// them, with the same doubles as the Workers tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import providerEventDuplicate from "../../../../contracts/data-access/fixtures/provider-event-duplicate.json";
import providerEventRecorded from "../../../../contracts/data-access/fixtures/provider-event-recorded.json";
import googleSync from "../../../../contracts/port-calendar/fixtures/notification-google-sync.json";
import google from "../../../../contracts/port-calendar/fixtures/notification-google.json";
import lifecycle from "../../../../contracts/port-calendar/fixtures/notification-microsoft-lifecycle.json";
import validation from "../../../../contracts/port-calendar/fixtures/notification-microsoft-validation.json";
import microsoft from "../../../../contracts/port-calendar/fixtures/notification-microsoft.json";
import wrongVerifier from "../../../../contracts/port-calendar/fixtures/notification-rejected.json";
import badSignature from "../../../../contracts/port-stripe/fixtures/verify-bad-signature.json";
import ignoredType from "../../../../contracts/port-stripe/fixtures/verify-ignored.json";
import billCardSaved from "../../../../contracts/port-stripe/fixtures/webhook-bill-card-saved.json";
import cardDetails from "../../../../contracts/port-stripe/fixtures/webhook-card-details.json";
import cardReplaced from "../../../../contracts/port-stripe/fixtures/webhook-card-replaced.json";
import cardSaved from "../../../../contracts/port-stripe/fixtures/webhook-card-saved.json";
import disputeOpened from "../../../../contracts/port-stripe/fixtures/webhook-dispute-opened.json";
import webhookEvent from "../../../../contracts/port-stripe/fixtures/webhook-event.json";
import payoutFailed from "../../../../contracts/port-stripe/fixtures/webhook-payout-failed.json";
import { readContractJson } from "../../trace/test-support";
import { unconfiguredProviders } from ".";
import { CALENDAR_BODY_LIMIT_BYTES, handleCalendarWebhook } from "./calendar-webhook";
import { handleStripeWebhook, STRIPE_BODY_LIMIT_BYTES } from "./stripe-webhook";
import {
  businessLookupDouble,
  calendarPortDouble,
  captureLogLines,
  endpointOf,
  googlePushRequest,
  graphBodyRequest,
  graphNotificationsRequest,
  graphValidationRequest,
  providerEventStoreFake,
  providerSpans,
  signedHeaderOf,
  stripePath,
  stripePortDouble,
  stripeRequest,
  type CalendarExchange,
  type StripeExchange,
} from "./test-support";
import type { ProviderDeps, ProviderEvent } from "./types";

const ID_BASE = "https://rosie.invalid/contracts/";
const K05_V1_1 = "data-access/data-access.v1.1.schema.json";
const K07 = "outbox-effects/outbox-effects.v1.schema.json";
const K08 = "event-trace/event-trace.v1.schema.json";
const K14 = "port-stripe/port-stripe.v1.schema.json";
const K16 = "port-calendar/port-calendar.v1.schema.json";

/** Every schema file the five contracts above reach. */
const SCHEMA_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
  "inbound-event/inbound-event.v1.schema.json",
  K07,
  K08,
  "data-access/data-access.v1.schema.json",
  K05_V1_1,
  K14,
  K16,
];

let ajv: Ajv2020 | undefined;

/** The schema's problems with `value` against `$defs/<definition>` of a frozen schema file; empty when accepted. */
function problems(file: string, definition: string, value: unknown): string[] {
  if (ajv === undefined) {
    // The contract check's own settings (contracts/scripts/lib.mjs createAjv).
    const created = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const schema of SCHEMA_FILES) created.addSchema(readContractJson(schema) as object);
    ajv = created;
  }
  const validate = ajv.getSchema(`${ID_BASE}${file}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`${file} has no definition ${definition}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? ""}`,
  );
}

const WHERE = { environment: "staging", version: "test-sha" };
const STRIPE_EVENTS: StripeExchange[] = [
  webhookEvent,
  cardSaved,
  cardDetails,
  cardReplaced,
  billCardSaved,
  disputeOpened,
  payoutFailed,
];
const STRIPE_ALL: StripeExchange[] = [...STRIPE_EVENTS, badSignature, ignoredType];
const CALENDAR_ALL: CalendarExchange[] = [
  google,
  googleSync,
  wrongVerifier,
  microsoft,
  lifecycle,
  validation,
];

function depsAt(now: string): ProviderDeps & {
  stripe: ReturnType<typeof stripePortDouble>;
  calendar: ReturnType<typeof calendarPortDouble>;
  events: ReturnType<typeof providerEventStoreFake>;
} {
  return {
    ...unconfiguredProviders(),
    stripe: stripePortDouble(STRIPE_ALL),
    stripeBusinesses: businessLookupDouble(),
    calendar: calendarPortDouble(CALENDAR_ALL),
    events: providerEventStoreFake(),
    bundleId: () => ({ hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 }),
    now: () => Date.parse(now),
  };
}

/** A span's own fields: its log line without what the log sink adds beside it (level, msg, environment, version). */
function spanOf(line: Record<string, unknown>): Record<string, unknown> {
  const span = { ...line };
  delete span.level;
  delete span.msg;
  delete span.environment;
  delete span.version;
  return span;
}

async function sendStripe(exchange: StripeExchange, deps: ProviderDeps): Promise<Response> {
  const endpoint = endpointOf(exchange);
  const request = stripeRequest(stripePath(endpoint), await signedHeaderOf(exchange), exchange.request.raw);
  return handleStripeWebhook(request, endpoint, deps, WHERE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("K-05 v1.1 recordProviderEvent", () => {
  it("the store fake answers provider-event-recorded.json and provider-event-duplicate.json, each a valid answer", async () => {
    const store = providerEventStoreFake();
    const recorded = await store.recordProviderEvent(
      providerEventRecorded.request as unknown as ProviderEvent,
    );
    const repeated = await store.recordProviderEvent(
      providerEventDuplicate.request as unknown as ProviderEvent,
    );

    expect(recorded).toEqual(providerEventRecorded.outcome);
    expect(repeated).toEqual(providerEventDuplicate.outcome);
    expect(problems(K05_V1_1, "recordProviderEvent.response", recorded)).toEqual([]);
    expect(problems(K05_V1_1, "recordProviderEvent.response", repeated)).toEqual([]);
  });
});

describe("the Stripe door", () => {
  it.each(STRIPE_EVENTS.map((exchange) => [exchange.request.traceId, exchange] as const))(
    "%s: the verify request is K-14's, and the stored row is a K-07 provider event and a K-05 request",
    async (_name, exchange) => {
      const logLines = captureLogLines();
      const deps = depsAt(exchange.given.now);

      const response = await sendStripe(exchange, deps);

      expect(response.status).toBe(200);
      for (const request of deps.stripe.requests) {
        expect(problems(K14, "verifyWebhook.request", request)).toEqual([]);
      }
      expect(deps.events.rows).toHaveLength(1);
      const row = deps.events.rows[0];
      expect(problems(K07, "providerEvent", row)).toEqual([]);
      expect(problems(K07, "providerEventRecord", { record: "providerEvent", event: row })).toEqual([]);
      expect(problems(K05_V1_1, "recordProviderEvent.request", row)).toEqual([]);
      const event = (exchange.outcome as { event: Record<string, unknown> }).event;
      expect(row).toMatchObject({
        provider: "stripe",
        providerEventId: event.eventId,
        eventType: event.stripeType,
        occurredAt: event.occurredAt,
        effectId: event.effectId,
        payload: {
          kind: event.kind,
          account: event.account,
          testMode: event.testMode,
          payload: event.payload,
        },
        traceId: response.headers.get("x-trace-id"),
      });
      const spans = providerSpans(logLines());
      expect(spans).toHaveLength(1);
      for (const line of spans) expect(problems(K08, "span", spanOf(line))).toEqual([]);
    },
  );

  it("its refusals and drops write spans K-08 accepts", async () => {
    const logLines = captureLogLines();

    await sendStripe(badSignature, depsAt(badSignature.given.now));
    await sendStripe(ignoredType, depsAt(ignoredType.given.now));
    await handleStripeWebhook(
      stripeRequest(stripePath("businesses"), null, webhookEvent.request.raw),
      "businesses",
      depsAt(webhookEvent.given.now),
      WHERE,
    );

    const spans = providerSpans(logLines());
    expect(spans.map((span) => span.outcome)).toEqual(["refused", "dropped", "refused"]);
    for (const line of spans) expect(problems(K08, "span", spanOf(line))).toEqual([]);
  });
});

describe("the calendar doors", () => {
  it("each push's request is K-16's, each stored row a K-07 provider event and K-16's calendar provider event, each span K-16's", async () => {
    const logLines = captureLogLines();
    const deps = depsAt(google.given.now);
    const port = deps.calendar;

    const sent = [
      await handleCalendarWebhook(
        googlePushRequest(google.request, port.verifierOf(google.request.channelId)),
        "google",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        googlePushRequest(googleSync.request, port.verifierOf(googleSync.request.channelId)),
        "google",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        googlePushRequest(wrongVerifier.request, "a-token-made-for-another-channel"),
        "google",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        graphNotificationsRequest(microsoft.request.notifications, port.verifierOf),
        "microsoft",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        graphNotificationsRequest(lifecycle.request.notifications, port.verifierOf),
        "microsoft",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        graphValidationRequest(validation.request.validationToken),
        "microsoft",
        deps,
        WHERE,
      ),
    ];

    expect(sent.map((response) => response.status)).toEqual([200, 200, 401, 200, 200, 200]);
    expect(port.requests).toHaveLength(6);
    for (const request of port.requests) {
      expect(problems(K16, "verifyNotification.request", request)).toEqual([]);
    }
    expect(deps.events.rows.map((row) => row.providerEventId)).toEqual([
      "gcal-channel-riley-03:7",
      "graph-notif-demo-0001",
      "graph-sub-sam-01:reauthorizationRequired:2026-11-13T09:20:30Z",
      "graph-sub-sam-01:missed:2026-11-13T09:20:30Z",
    ]);
    for (const row of deps.events.rows) {
      expect(problems(K07, "providerEvent", row)).toEqual([]);
      expect(problems(K07, "providerEventRecord", { record: "providerEvent", event: row })).toEqual([]);
      expect(problems(K05_V1_1, "recordProviderEvent.request", row)).toEqual([]);
      expect(problems(K16, "calendarProviderEvent", row)).toEqual([]);
    }
    const spans = providerSpans(logLines());
    expect(spans).toHaveLength(6);
    for (const line of spans) {
      expect(problems(K08, "span", spanOf(line))).toEqual([]);
      expect(problems(K16, "calendar.span", spanOf(line))).toEqual([]);
    }
  });
});

describe("a body over its door's cap (T-1195)", () => {
  it("is answered 413 with a span K-08 accepts, and K-16's calendar.span at the calendar doors, nothing handed to a port", async () => {
    const logLines = captureLogLines();
    const deps = depsAt(webhookEvent.given.now);
    const overStripe = "x".repeat(STRIPE_BODY_LIMIT_BYTES + 1);
    const overCalendar = "x".repeat(CALENDAR_BODY_LIMIT_BYTES + 1);
    const push = googlePushRequest(google.request, deps.calendar.verifierOf(google.request.channelId));

    const sent = [
      await handleStripeWebhook(
        stripeRequest(stripePath("businesses"), await signedHeaderOf(webhookEvent), overStripe),
        "businesses",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(
        new Request(push.url, { method: "POST", headers: push.headers, body: overCalendar }),
        "google",
        deps,
        WHERE,
      ),
      await handleCalendarWebhook(graphBodyRequest(overCalendar), "microsoft", deps, WHERE),
    ];

    expect(sent.map((response) => response.status)).toEqual([413, 413, 413]);
    expect(deps.stripe.requests).toHaveLength(0);
    expect(deps.calendar.requests).toHaveLength(0);
    expect(deps.events.calls).toHaveLength(0);
    const spans = providerSpans(logLines());
    expect(spans.map((span) => [span.provider, span.outcome, span.error_code])).toEqual([
      ["stripe", "refused", "bodyTooLarge"],
      ["google_calendar", "refused", "bodyTooLarge"],
      ["microsoft_calendar", "refused", "bodyTooLarge"],
    ]);
    for (const line of spans) expect(problems(K08, "span", spanOf(line))).toEqual([]);
    for (const line of spans.slice(1)) expect(problems(K16, "calendar.span", spanOf(line))).toEqual([]);
  });
});
