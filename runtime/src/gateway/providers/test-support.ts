// Doubles for the provider doors' tests (T-275). Not imported by the Worker. Each answers as a frozen contract states:
//
//   - the Stripe port (K-14 v1 verifyWebhook): reads the Stripe-Signature header as K-14 states it (t=, one or more v1=,
//     300 s from receivedAt) and checks every v1 with the shared helper's constant-time HMAC check (adapters/src/shared/
//     hmac.ts, T-410's verifyHmacSha256) under its endpoint's made-up test secret, as the Stripe adapters will; once one
//     matches, it answers the outcome of the K-14 fixture holding the same body (the parse is the adapter's, C-214);
//   - Stripe webhooks signed at test time over "<t>.<raw>" (K-14 fixtures hold COMPUTED-AT-TEST-TIME and say in
//     given.signing whether the signature is valid or has one byte changed);
//   - the calendar port (K-16 v1 verifyNotification): a verifier made at test time for each watch, compared with the
//     push's; a match answers the outcome of the K-16 fixture holding the same push, with the request's receipt time and
//     trace, as the adapters do; a mismatch answers K-16's verifierMismatch;
//   - a Graph batch (T-1201): one POST of many change notifications in K-16's shape, as an exchange the calendar double
//     answers like a fixture (K-16 README spike row 10: several per POST, from different subscriptions);
//   - K-05 v1.1 recordProviderEvent: written once by (provider, provider event id); a repeat writes nothing and answers
//     the stored row's receivedAt and effectId, whatever the repeat's body (K-05 item 23; provider-event-recorded.json,
//     provider-event-duplicate.json);
//   - the Stripe business lookup: K-14's demo account, and the effect Rosfield's bill card names, to K-07's demo business
//     (provider-event-stripe.json names that business for the same event).
// Test values only: the fixtures' demo shops and sample cast, and made-up secrets, never Stripe's (rules 7 and 9).

import { vi } from "vitest";

import { signHmacSha256, verifyHmacSha256 } from "../../../../adapters/src/shared/hmac";
import type {
  CalendarPort,
  CalendarPushRequest,
  CalendarVerifyResult,
  GraphChangeType,
  ProviderEvent,
  ProviderEventRecorded,
  ProviderEventStore,
  RecordProviderEventError,
  StripeBusinessLookup,
  StripeEndpoint,
  StripePort,
  StripeVerifyRequest,
  StripeVerifyResult,
} from "./types";

type Json = Record<string, unknown>;

// ---- Stripe -------------------------------------------------------------------------------------------------------

/** Made-up signing secrets in Stripe's whsec_ form, one per endpoint; never Stripe's (rule 7). */
export const STRIPE_TEST_SECRETS: Readonly<Record<StripeEndpoint, string>> = {
  rosfield: "whsec_TestOnlyRosfieldGatewaySecret0001",
  businesses: "whsec_TestOnlyBusinessesGatewaySecret0002",
};

/** A K-14 verifyWebhook exchange (contracts/port-stripe/fixtures). */
export interface StripeExchange {
  given: { now: string; signing?: string };
  request: {
    endpoint: string;
    signatureHeader: string;
    raw: string;
    receivedAt: string;
    traceId: string;
  };
  outcome: unknown;
}

/** Where a K-14 fixture's header holds the signature the test makes (README "Signatures in fixtures"). */
const PLACEHOLDER = "COMPUTED-AT-TEST-TIME";

/** The endpoint of a K-14 exchange, checked. */
export function endpointOf(exchange: StripeExchange): StripeEndpoint {
  const { endpoint } = exchange.request;
  if (endpoint !== "rosfield" && endpoint !== "businesses") throw new Error("not a K-14 endpoint");
  return endpoint;
}

/** The t= of a K-14 exchange's header. */
export function timestampOf(exchange: StripeExchange): string {
  const match = /(?:^|,)t=([0-9]+)/.exec(exchange.request.signatureHeader);
  if (match?.[1] === undefined) throw new Error("the fixture's header has no t=");
  return match[1];
}

/** One hex digit of a signature changed (the fixtures' oneByteChanged). */
export function changeOneByte(hex: string): string {
  return `${hex.startsWith("0") ? "1" : "0"}${hex.slice(1)}`;
}

/** The v1 signature Stripe's form gives a body at t= under a secret: hex HMAC-SHA256 of "<t>.<raw>" (spike row 13). */
export function stripeSignature(secret: string, timestamp: string, raw: string): Promise<string> {
  return signHmacSha256(secret, `${timestamp}.${raw}`);
}

/** The Stripe-Signature header of a fixture, signed now under its endpoint's test secret as its given.signing says. */
export async function signedHeaderOf(exchange: StripeExchange): Promise<string> {
  const hex = await stripeSignature(
    STRIPE_TEST_SECRETS[endpointOf(exchange)],
    timestampOf(exchange),
    exchange.request.raw,
  );
  const signature = exchange.given.signing === "oneByteChanged" ? changeOneByte(hex) : hex;
  return exchange.request.signatureHeader.replace(PLACEHOLDER, signature);
}

/** A Stripe webhook as Stripe sends it: a POST of the raw body with its Stripe-Signature header (none when null). */
export function stripeRequest(path: string, header: string | null, raw: string): Request {
  return new Request(`https://rosie.test${path}`, {
    method: "POST",
    headers: header === null ? {} : { "stripe-signature": header },
    body: raw,
  });
}

/** The path, under staging's BASE_PATH (/test), of a Stripe endpoint's webhook. */
export function stripePath(endpoint: StripeEndpoint): string {
  return `/test/webhooks/stripe/${endpoint}`;
}

export interface StripePortDouble extends StripePort {
  /** Every request the door handed the verify call, in order. */
  readonly requests: StripeVerifyRequest[];
}

/**
 * The K-14 double: the header read as K-14 states it, each v1 checked with the shared helper under the endpoint's test
 * secret, then the outcome of the fixture holding the same body and endpoint (a fixture that is itself a rejection is
 * never the answer to a signature that matched). A body no fixture holds rejects, as a verify call that cannot answer.
 */
export function stripePortDouble(exchanges: readonly StripeExchange[]): StripePortDouble {
  const requests: StripeVerifyRequest[] = [];
  const rejected = (reason: "badHeader" | "staleTimestamp" | "badSignature"): StripeVerifyResult => ({
    result: "rejected",
    httpStatus: 401,
    reason,
  });
  return {
    requests,
    async verifyWebhook(request) {
      requests.push(structuredClone(request));
      let timestamp: string | undefined;
      const signatures: string[] = [];
      for (const element of request.signatureHeader.split(",")) {
        const equals = element.indexOf("=");
        const key = element.slice(0, equals);
        const value = element.slice(equals + 1);
        if (key === "t") timestamp = value;
        else if (key === "v1") signatures.push(value);
      }
      if (timestamp === undefined || !/^[0-9]+$/.test(timestamp) || signatures.length === 0) {
        return rejected("badHeader");
      }
      if (Math.abs(Date.parse(request.receivedAt) / 1000 - Number(timestamp)) > 300) {
        return rejected("staleTimestamp");
      }
      let matched = false;
      for (const signature of signatures) {
        const message = `${timestamp}.${request.raw}`;
        if (await verifyHmacSha256(STRIPE_TEST_SECRETS[request.endpoint], message, signature)) matched = true;
      }
      if (!matched) return rejected("badSignature");
      const exchange = exchanges.find(
        (candidate) =>
          candidate.request.raw === request.raw &&
          candidate.request.endpoint === request.endpoint &&
          (candidate.outcome as Json).result !== "rejected",
      );
      if (exchange === undefined) throw new Error("no fixture for this webhook");
      return structuredClone(exchange.outcome) as StripeVerifyResult;
    },
  };
}

export interface BusinessLookupDouble extends StripeBusinessLookup {
  readonly calls: { account: unknown; effectId: string | null }[];
}

/**
 * The business lookup's double: a business's account by its K-23 stripe_account_id, Rosfield's own account by the effect
 * the event names (K-14 README "Webhook events"). The world is the fixtures': K-14's demo account for Lee's Barbershop
 * and the bill card's effect (webhook-bill-card-saved.json), both K-07's biz-lees-barbershop.
 */
export function businessLookupDouble(): BusinessLookupDouble {
  const accounts = new Map([["stripe-acct-demo-lees-barbershop", "biz-lees-barbershop"]]);
  const effects = new Map([["eff-sam-bill-card-lees-barbershop", "biz-lees-barbershop"]]);
  const calls: BusinessLookupDouble["calls"] = [];
  return {
    calls,
    businessOf(event) {
      calls.push(structuredClone(event));
      if (event.account.kind === "business") {
        return Promise.resolve(accounts.get(event.account.accountId) ?? null);
      }
      return Promise.resolve(event.effectId === null ? null : (effects.get(event.effectId) ?? null));
    },
  };
}

// ---- K-05 v1.1 recordProviderEvent ----------------------------------------------------------------------------------

/** What a fake call answers instead of writing: a throw, a K-05 error, or any other answer (a store off the contract). */
export type StoreFailure = "throw" | RecordProviderEventError | Json;

export interface ProviderEventStoreFake extends ProviderEventStore {
  /** The rows written, in order: each a copy of the request as it was stored. */
  readonly rows: ProviderEvent[];
  /** Every request, in order. */
  readonly calls: ProviderEvent[];
  /** The next calls' answers, each used once, instead of a write. */
  readonly failNext: StoreFailure[];
}

/** K-05 v1.1 recordProviderEvent as a fake: insert once by (provider, provider event id), a repeat answers the stored row. */
export function providerEventStoreFake(): ProviderEventStoreFake {
  const byKey = new Map<string, ProviderEvent>();
  const rows: ProviderEvent[] = [];
  const calls: ProviderEvent[] = [];
  const failNext: StoreFailure[] = [];
  const answerOf = (row: ProviderEvent, repeated: boolean): ProviderEventRecorded => ({
    result: "recorded",
    provider: row.provider,
    providerEventId: row.providerEventId,
    repeated,
    receivedAt: row.receivedAt,
    effectId: row.effectId,
  });
  return {
    rows,
    calls,
    failNext,
    recordProviderEvent(event) {
      calls.push(structuredClone(event));
      const failure = failNext.shift();
      if (failure === "throw") return Promise.reject(new Error(`the write failed: ${JSON.stringify(event)}`));
      if (failure !== undefined) return Promise.resolve(failure as unknown as ProviderEventRecorded);
      const key = JSON.stringify([event.provider, event.providerEventId]);
      const known = byKey.get(key);
      if (known !== undefined) return Promise.resolve(answerOf(known, true));
      const row = structuredClone(event);
      byKey.set(key, row);
      rows.push(row);
      return Promise.resolve(answerOf(row, false));
    },
  };
}

// ---- K-16 v1 verifyNotification ---------------------------------------------------------------------------------------

/** A K-16 verifyNotification exchange (contracts/port-calendar/fixtures). */
export interface CalendarExchange {
  given: { now: string; verifier?: string };
  request: Json;
  outcome: Json;
}

export interface CalendarPortDouble extends CalendarPort {
  /** Every request the door handed the check, in order. */
  readonly requests: CalendarPushRequest[];
  /** The verifier made at test time for a watch: Google's channel token, Graph's clientState. Needs no `this`. */
  readonly verifierOf: (watchId: string) => string;
}

/** A value with its keys sorted at every level, so two pushes compare whatever order their fields came in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** A push without its receipt time, trace and verifiers: what makes it the same push as a fixture's. */
function pushKey(push: Json): string {
  const copy: Json = { ...push };
  delete copy.receivedAt;
  delete copy.traceId;
  delete copy.channelToken;
  if (Array.isArray(copy.notifications)) {
    copy.notifications = (copy.notifications as Json[]).map((notice) => {
      const kept: Json = { ...notice };
      delete kept.clientState;
      return kept;
    });
  }
  return JSON.stringify(canonical(copy));
}

/**
 * The K-16 double: compares each verifier with the one made for its watch (K-16's adapters check an HMAC under
 * CALENDAR_PUSH_SECRET; a made-up value per watch stands for it here), then answers the outcome of the fixture holding
 * the same push, its events stamped with the request's receipt time and trace. A push no fixture holds rejects.
 */
export function calendarPortDouble(exchanges: readonly CalendarExchange[]): CalendarPortDouble {
  const verifiers = new Map<string, string>();
  const verifierOf = (watchId: string): string => {
    let verifier = verifiers.get(watchId);
    if (verifier === undefined) {
      verifier = `verifier-${crypto.randomUUID()}`;
      verifiers.set(watchId, verifier);
    }
    return verifier;
  };
  const requests: CalendarPushRequest[] = [];
  return {
    requests,
    verifierOf,
    verifyNotification(request) {
      requests.push(structuredClone(request));
      const key = pushKey(request as unknown as Json);
      const exchange = exchanges.find((candidate) => pushKey(candidate.request) === key);
      if (exchange === undefined) return Promise.reject(new Error("no fixture for this push"));
      const mismatch =
        (request.kind === "push" && request.channelToken !== verifierOf(request.channelId)) ||
        (request.kind === "notifications" &&
          request.notifications.some((notice) => notice.clientState !== verifierOf(notice.subscriptionId)));
      if (mismatch) {
        return Promise.resolve({ result: "rejected", httpStatus: 401, why: "verifierMismatch" });
      }
      const outcome = structuredClone(exchange.outcome);
      if (outcome.result === "accepted" && Array.isArray(outcome.events)) {
        outcome.events = (outcome.events as Json[]).map((event) => ({
          ...event,
          receivedAt: request.receivedAt,
          traceId: request.traceId,
        }));
      }
      return Promise.resolve(outcome as unknown as CalendarVerifyResult);
    },
  };
}

/** The path, under staging's BASE_PATH (/test), of a calendar provider's pushes. */
export function calendarPath(source: "google" | "microsoft"): string {
  return `/test/webhooks/calendar/${source}`;
}

/** Google's push as Google sends it: a POST with no body, a fixture's push in X-Goog-* headers, the token as given. */
export function googlePushRequest(push: Json, channelToken: string | null): Request {
  const headers: Record<string, string> = {
    "X-Goog-Channel-ID": String(push.channelId),
    "X-Goog-Message-Number": String(push.messageNumber),
    "X-Goog-Resource-ID": String(push.resourceId),
    "X-Goog-Resource-State": String(push.resourceState),
    "X-Goog-Resource-URI": "https://calendar.example.com/calendars/primary/events",
  };
  if (channelToken !== null) headers["X-Goog-Channel-Token"] = channelToken;
  if (typeof push.channelExpiration === "string") {
    headers["X-Goog-Channel-Expiration"] = push.channelExpiration;
  }
  return new Request(`https://rosie.test${calendarPath("google")}`, { method: "POST", headers });
}

/** Graph's POST as Graph sends it: a fixture's notices in Graph's own JSON (value[]), each clientState as given. */
export function graphNotificationsRequest(
  notifications: readonly Json[],
  clientStateOf: (subscriptionId: string) => string,
): Request {
  const value = notifications.map((notice) => ({
    ...(notice.notificationId === null ? {} : { id: notice.notificationId }),
    subscriptionId: notice.subscriptionId,
    subscriptionExpirationDateTime: notice.subscriptionExpirationDateTime,
    clientState: clientStateOf(String(notice.subscriptionId)),
    ...(notice.changeType === null ? {} : { changeType: notice.changeType, resource: "me/events" }),
    ...(notice.lifecycleEvent === null ? {} : { lifecycleEvent: notice.lifecycleEvent }),
    tenantId: "00000000-0000-0000-0000-000000000000",
  }));
  return graphBodyRequest(JSON.stringify({ value }));
}

/** A POST of this body to Graph's address. */
export function graphBodyRequest(body: string): Request {
  return new Request(`https://rosie.test${calendarPath("microsoft")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Graph's handshake: a POST to the address with ?validationToken= (URL-encoded). */
export function graphValidationRequest(token: string): Request {
  return new Request(
    `https://rosie.test${calendarPath("microsoft")}?validationToken=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "content-type": "text/plain" }, body: "" },
  );
}

/** A K-16 verifyNotification exchange of one Graph POST of change notifications, as graphBatchExchange makes it. */
export interface GraphBatchExchange extends CalendarExchange {
  call: "verifyNotification";
  given: { now: string; note: string; verifier: "valid" };
  request: {
    provider: "microsoft";
    kind: "notifications";
    notifications: Json[];
    receivedAt: string;
    traceId: string;
  };
  outcome: { result: "accepted"; httpStatus: 200; events: ProviderEvent[]; unknownWatches: number };
}

/** A batch's i-th subscription: Sam's and Maya's Outlook links in turn (K-16 README "The double", its world). */
function batchWatchOf(index: number): { subscriptionId: string; calendarLinkId: string } {
  return index % 2 === 0
    ? { subscriptionId: "graph-sub-sam-01", calendarLinkId: "callink-sam-microsoft" }
    : { subscriptionId: "graph-sub-maya-01", calendarLinkId: "callink-maya-microsoft" };
}

/** A batch's i-th change: created, updated and deleted in turn (K-16 graphNotice.changeType). */
function batchChangeOf(index: number): GraphChangeType {
  const turn = index % 3;
  if (turn === 0) return "created";
  return turn === 1 ? "updated" : "deleted";
}

/**
 * One Graph POST of `count` basic change notifications in K-16's shape (README spike row 10: "several per POST, from
 * different subscriptions", with no stated count), as a K-16 exchange in notification-microsoft.json's form: the i-th is
 * change notification graph-notif-batch-<i>, for Sam's and Maya's subscriptions in turn, and the check stores each once
 * under its notification id with notice changed. Test values only: K-16's cast, readable stand-in ids, and each
 * clientState made at test time (given.verifier valid).
 */
export function graphBatchExchange(count: number, now: string): GraphBatchExchange {
  const traceId = "trace-graph-batch-0001";
  const notifications: Json[] = [];
  const events: ProviderEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const watch = batchWatchOf(index);
    const changeType = batchChangeOf(index);
    const notificationId = `graph-notif-batch-${String(index + 1).padStart(4, "0")}`;
    notifications.push({
      notificationId,
      subscriptionId: watch.subscriptionId,
      clientState: "made-at-test-time",
      changeType,
      lifecycleEvent: null,
      subscriptionExpirationDateTime: "2026-11-13T09:20:30Z",
    });
    events.push({
      provider: "microsoft_calendar",
      providerEventId: notificationId,
      eventType: changeType,
      occurredAt: null,
      receivedAt: now,
      businessId: null,
      effectId: null,
      payload: { calendarLinkId: watch.calendarLinkId, watchId: watch.subscriptionId, notice: "changed" },
      traceId,
    });
  }
  return {
    call: "verifyNotification",
    given: {
      now,
      note: `Graph posts ${String(count)} basic change notifications in one POST, for Sam's and Maya's subscriptions in turn. Every clientState matches the one made for its subscription, so each is stored once under its notification id and the gateway answers 200.`,
      verifier: "valid",
    },
    request: { provider: "microsoft", kind: "notifications", notifications, receivedAt: now, traceId },
    outcome: { result: "accepted", httpStatus: 200, events, unknownWatches: 0 },
  };
}

// ---- logs and spans -----------------------------------------------------------------------------------------------

/** Captures every console.log line as parsed JSON (each gateway line is one JSON object). */
export function captureLogLines(): () => Record<string, unknown>[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

/** The provider doors' spans among the log lines. */
export function providerSpans(lines: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line.msg === "span" && line.hop === "providerWebhook");
}
