// The calendar webhook doors (T-275; C-044; K-16 v1 "Checking a push"; arch 02 step 1 "Receive", line 109).
//
// One door per provider: Google's pushes and Graph's (its validation handshake, change and lifecycle notifications). The
// door reads the push into K-16's `verifyNotification.request` (Google's X-Goog-* headers; Graph's ?validationToken= or
// its JSON body) and the port's check answers it (K-16 `verifyNotification`: the adapters check each verifier, an HMAC
// under CALENDAR_PUSH_SECRET, and name each provider event); the door holds no secret. Answers, after T-241's rules
// (../answer.ts, ./common.ts):
// - 413, nothing checked or stored: a body over the door's cap (T-1195; ../body.ts; ProviderDoors.calendarBodyLimitBytes,
//   CALENDAR_BODY_LIMIT_BYTES by default), at Google's door and Graph's, refused before it is read whole and before the
//   push is read or checked, with nothing logged but the span, as the page entry and the Linq webhook refuse theirs
//   (T-1180). Google's push and Graph's handshake carry no body (K-16 spike rows 2 and 9), so only Graph's notifications
//   use what is read; every other answer comes in the order it came before the cap, from the same headers, clock and text;
// - 200, text/plain, the token: Graph's handshake (K-16 spike row 9), nothing stored;
// - 401, nothing stored: a push the door cannot read into K-16's request, and every rejection the port gives (a verifier
//   that does not match, a push it cannot read);
// - 200, nothing stored: Google's sync message (ignored), and every item of a watch Rosie no longer holds (counted);
// - 200 after the writes: each provider event the port names, stored once by (provider, provider event id) as a K-07 v1
//   provider event (K-05 v1.1 recordProviderEvent), linked to no effect row (S12-33); a known event id is 200 with
//   nothing more stored, as the store says in the same step;
// - 503, so the provider retries (Google on 5xx, Graph for up to 4 hours): a check that cannot answer, an answer the
//   door does not know, a write that fails, a clock that is not a number;
// - 400: a body that cannot be read.
// The trace opens at receipt (K-08 opened_by providerWebhook) and one `providerWebhook` span ends every answer, with
// K-16's closed list of facts (calendar.span). Never logged: a verifier, a token, a body.

import { isLabel, type Provider, type SpanFacts } from "../../trace";
import { logFailure, openWebhookTrace, readBundleId, respond, type WebhookEnvironment } from "../answer";
import { bodyLimitOf, readCappedText, type BodyRead } from "../body";
import {
  answerOf,
  dropped,
  failed,
  isRecord,
  isText,
  isTextOrNull,
  recordOnce,
  refused,
  scrubPayload,
  tooLarge,
  unreadableBody,
  written,
  type Verdict,
} from "./common";
import type {
  CalendarNotice,
  CalendarPushRequest,
  GooglePush,
  GraphChangeType,
  GraphLifecycleEvent,
  GraphNotice,
  GraphNotifications,
  ProviderDeps,
  ProviderEvent,
} from "./types";

/** The two calendar providers, each with its own door (K-16 v1: "One interface with two adapters"). */
export type CalendarSource = "google" | "microsoft";

/**
 * The calendar doors' cap in bytes: 64 KiB, the card's default (T-1195), since K-16's spike findings from Google's and
 * Microsoft's documents give no size (rows 2, 9 to 11): Google's push and Graph's handshake have no body, and Rosie asks
 * Graph for basic notifications only, of which K-16's largest push (two lifecycle notices) is under 3 KB, fixture whole.
 */
export const CALENDAR_BODY_LIMIT_BYTES = 64 * 1024;

/** K-07 v1's provider for each source's events (K-16 `calendarProviderEvent.provider`). */
const EVENT_PROVIDER = {
  google: "google_calendar",
  microsoft: "microsoft_calendar",
} as const satisfies Record<CalendarSource, Provider>;

// Google's push headers (K-16 `googlePush`; README spike row 2). The Headers API reads them in any case.
const GOOGLE_CHANNEL_ID = "x-goog-channel-id";
const GOOGLE_CHANNEL_TOKEN = "x-goog-channel-token";
const GOOGLE_RESOURCE_ID = "x-goog-resource-id";
const GOOGLE_RESOURCE_STATE = "x-goog-resource-state";
const GOOGLE_MESSAGE_NUMBER = "x-goog-message-number";
const GOOGLE_CHANNEL_EXPIRATION = "x-goog-channel-expiration";

/** Graph's handshake query parameter (K-16 `graphValidation`; README spike row 9). */
const GRAPH_VALIDATION_TOKEN = "validationToken";

const MESSAGE_NUMBER = /^[0-9]+$/;
const CHANGE_TYPES: readonly string[] = ["created", "updated", "deleted"] satisfies GraphChangeType[];
const LIFECYCLE_EVENTS: readonly string[] = [
  "reauthorizationRequired",
  "subscriptionRemoved",
  "missed",
] satisfies GraphLifecycleEvent[];
const NOTICES: readonly string[] = [
  "changed",
  "missed",
  "reauthorizationRequired",
  "watchRemoved",
] satisfies CalendarNotice["notice"][];

/**
 * Google's push read into K-16's `googlePush` (a POST with no body; README spike row 2), or null when it cannot be: no
 * channel id, no resource state, or a message number that is not whole digits. A missing token is "" (K-16: "empty when
 * missing"), which the port's check refuses.
 */
export function googlePushOf(headers: Headers, receivedAt: string, traceId: string): GooglePush | null {
  const channelId = headers.get(GOOGLE_CHANNEL_ID) ?? "";
  const resourceState = headers.get(GOOGLE_RESOURCE_STATE) ?? "";
  const messageNumber = headers.get(GOOGLE_MESSAGE_NUMBER) ?? "";
  if (channelId === "" || resourceState === "" || !MESSAGE_NUMBER.test(messageNumber)) return null;
  return {
    provider: "google",
    kind: "push",
    channelId,
    channelToken: headers.get(GOOGLE_CHANNEL_TOKEN) ?? "",
    resourceId: headers.get(GOOGLE_RESOURCE_ID) ?? "",
    resourceState,
    messageNumber,
    channelExpiration: headers.get(GOOGLE_CHANNEL_EXPIRATION),
    receivedAt,
    traceId,
  };
}

/** One item of Graph's `value` list read into K-16's `graphNotice`, or null: a change or a lifecycle event, never both. */
function graphNoticeOf(item: unknown): GraphNotice | null {
  if (!isRecord(item) || !isText(item.subscriptionId)) return null;
  const clientState = item.clientState ?? "";
  const notificationId = item.id ?? null;
  const expiry = item.subscriptionExpirationDateTime ?? null;
  const changeType = item.changeType ?? null;
  const lifecycleEvent = item.lifecycleEvent ?? null;
  if (typeof clientState !== "string" || !isTextOrNull(notificationId) || !isTextOrNull(expiry)) {
    return null;
  }
  if (typeof changeType === "string" && lifecycleEvent === null) {
    if (!CHANGE_TYPES.includes(changeType)) return null;
    return {
      notificationId,
      subscriptionId: item.subscriptionId,
      clientState,
      changeType: changeType as GraphChangeType,
      lifecycleEvent: null,
      subscriptionExpirationDateTime: expiry,
    };
  }
  if (changeType === null && typeof lifecycleEvent === "string") {
    if (!LIFECYCLE_EVENTS.includes(lifecycleEvent)) return null;
    return {
      notificationId,
      subscriptionId: item.subscriptionId,
      clientState,
      changeType: null,
      lifecycleEvent: lifecycleEvent as GraphLifecycleEvent,
      subscriptionExpirationDateTime: expiry,
    };
  }
  return null;
}

/**
 * Graph's POST read into K-16's `graphNotifications` (README spike row 10: `value[]`, several per POST), or null when the
 * body is not JSON, holds no item, or any item is not a K-16 notice. Graph's other fields (resource, tenant, resource
 * data) are not read: Rosie asks for basic notifications only.
 */
export function graphNotificationsOf(
  raw: string,
  receivedAt: string,
  traceId: string,
): GraphNotifications | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(body) || !Array.isArray(body.value) || body.value.length === 0) return null;
  const notifications: GraphNotice[] = [];
  for (const item of body.value as unknown[]) {
    const notice = graphNoticeOf(item);
    if (notice === null) return null;
    notifications.push(notice);
  }
  return { provider: "microsoft", kind: "notifications", notifications, receivedAt, traceId };
}

/** A K-16 `calendarNotice`, copied field by field so nothing else of a port's payload is stored; null when it is not one. */
function noticeOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const { calendarLinkId, watchId, notice } = value;
  if (
    !isText(calendarLinkId) ||
    !isText(watchId) ||
    typeof notice !== "string" ||
    !NOTICES.includes(notice)
  ) {
    return null;
  }
  return { calendarLinkId, watchId, notice };
}

/**
 * One event the port named, as the K-07 v1 provider event the door stores: the port's provider (this door's), id, type,
 * times and links, its calendarNotice, and the door's own receipt time and trace (arch 10 line 548). Null when it is off
 * the contract.
 */
function eventOf(
  value: unknown,
  provider: ProviderEvent["provider"],
  receivedAt: string,
  traceId: string,
): ProviderEvent | null {
  if (!isRecord(value) || value.provider !== provider) return null;
  const { providerEventId, eventType, occurredAt, businessId, effectId } = value;
  const payload = noticeOf(value.payload);
  if (!isText(providerEventId) || !isText(eventType) || payload === null) return null;
  if (!isTextOrNull(occurredAt) || !isTextOrNull(businessId) || !isTextOrNull(effectId)) return null;
  return {
    provider,
    providerEventId,
    eventType,
    occurredAt,
    receivedAt,
    businessId,
    effectId,
    payload,
    traceId,
  };
}

/** The check's answer, read as unknown against the request it answers (K-16 `verifyNotification.exchange`'s rules). */
type Reading =
  | { kind: "validation"; body: string }
  | { kind: "accepted"; events: ProviderEvent[]; unknownWatches: number }
  | { kind: "ignored" }
  | { kind: "rejected"; why: string }
  | { kind: "unknown"; code: "unknownVerifyResult" | "badVerifyAnswer" };

function readCheckAnswer(
  answer: unknown,
  request: CalendarPushRequest,
  provider: ProviderEvent["provider"],
): Reading {
  if (!isRecord(answer)) return { kind: "unknown", code: "unknownVerifyResult" };
  const bad = { kind: "unknown", code: "badVerifyAnswer" } as const;
  switch (answer.result) {
    case "rejected":
      return { kind: "rejected", why: typeof answer.why === "string" ? answer.why : "" };
    case "validation":
      // Graph's handshake is answered with its own token, and only a handshake is (K-16: "a validation answer's body is its token").
      return request.kind === "validation" &&
        answer.contentType === "text/plain" &&
        answer.body === request.validationToken
        ? { kind: "validation", body: request.validationToken }
        : bad;
    case "ignored":
      return request.kind === "push" && answer.why === "syncMessage" ? { kind: "ignored" } : bad;
    case "accepted": {
      if (request.kind === "validation" || !Array.isArray(answer.events)) return bad;
      const { unknownWatches } = answer;
      if (typeof unknownWatches !== "number" || !Number.isInteger(unknownWatches) || unknownWatches < 0) {
        return bad;
      }
      const events: ProviderEvent[] = [];
      for (const value of answer.events as unknown[]) {
        const event = eventOf(value, provider, request.receivedAt, request.traceId);
        if (event === null) return bad;
        events.push(event);
      }
      return { kind: "accepted", events, unknownWatches };
    }
    default:
      return { kind: "unknown", code: "unknownVerifyResult" };
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The one label of a list, or none: a span names a watch or link only when the push holds exactly one. */
function single(values: readonly string[]): string | undefined {
  const distinct = [...new Set(values)];
  const [only] = distinct;
  return distinct.length === 1 && only !== undefined && isLabel(only) ? only : undefined;
}

/** What the span names beside the verdict, from K-16 `calendar.span`'s closed list: labels and counts only. */
interface SpanNotes {
  got: SpanFacts;
  /** Graph's handshake token, which only the 200 text/plain answer carries. */
  validation?: string;
}

/** Graph's handshake answer: 200, text/plain, the URL-decoded token (K-16 spike row 9), never sniffed as anything else. */
function validationResponse(token: string, traceId: string): Response {
  return new Response(token, {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-trace-id": traceId,
    },
  });
}

/**
 * Handles one calendar push POST from one provider. The request's own x-trace-id is never kept (answer.ts): the trace id
 * is always new, and each stored event carries it.
 */
export async function handleCalendarWebhook(
  request: Request,
  source: CalendarSource,
  deps: ProviderDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const bundleId = await readBundleId(deps);
  const context = openWebhookTrace(deps, bundleId, where, "providerWebhook");
  const timing = context.start("providerWebhook");
  const notes: SpanNotes = { got: {} };
  const onError = (stage: string, error: unknown): void => {
    logFailure(context.traceId, stage, error);
  };

  const verdict = await decide(request, source, deps, context.traceId, notes, onError);

  try {
    timing.finish({
      outcome: verdict.outcome,
      provider: EVENT_PROVIDER[source],
      call: "verifyNotification",
      got: notes.got,
      decided: verdict.decided,
      errorCode: verdict.errorCode,
    });
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    onError("span", error);
  }
  if (verdict.status === 200 && notes.validation !== undefined) {
    return validationResponse(notes.validation, context.traceId);
  }
  return respond(answerOf(verdict), context.traceId);
}

/**
 * The push read into K-16's request, or null when it cannot be (answered 401), or "unreadableBody" (answered 400). Only
 * Graph's notifications are read from the body under the cap; Google's push and Graph's handshake from the headers and
 * the address, whatever their body held, as before the cap.
 */
function pushOf(
  request: Request,
  source: CalendarSource,
  body: Exclude<BodyRead, { problem: "tooLarge" }>,
  receivedAt: string,
  traceId: string,
  onError: (stage: string, error: unknown) => void,
): CalendarPushRequest | null | "unreadableBody" {
  if (source === "google") return googlePushOf(request.headers, receivedAt, traceId);
  const token = new URL(request.url).searchParams.get(GRAPH_VALIDATION_TOKEN);
  if (token !== null) {
    return token === ""
      ? null
      : { provider: "microsoft", kind: "validation", validationToken: token, receivedAt, traceId };
  }
  if ("problem" in body) {
    onError("readBody", body.error);
    return "unreadableBody";
  }
  // The text request.text() gave before the cap (../body.ts).
  return graphNotificationsOf(body.text, receivedAt, traceId);
}

async function decide(
  request: Request,
  source: CalendarSource,
  deps: ProviderDeps,
  traceId: string,
  notes: SpanNotes,
  onError: (stage: string, error: unknown) => void,
): Promise<Verdict> {
  const nowMs = (deps.now ?? Date.now)();
  // The body under its cap (../body.ts), before the push is read or checked: one over it is never read whole or checked,
  // and nothing but the span is logged.
  const body = await readCappedText(
    request,
    bodyLimitOf(deps.calendarBodyLimitBytes, CALENDAR_BODY_LIMIT_BYTES),
  );
  if ("problem" in body && body.problem === "tooLarge") return tooLarge();

  // A clock that is not a number gives no receipt time for the request: nothing is checked or stored, and the provider retries.
  if (!Number.isFinite(nowMs)) return failed("badClock");
  const receivedAt = new Date(nowMs).toISOString();

  const push = pushOf(request, source, body, receivedAt, traceId, onError);
  if (push === "unreadableBody") return unreadableBody();
  if (push === null) return refused("unreadable", { result: "rejected", stored: 0 });
  if (push.kind === "push") {
    notes.got.notices = 1;
  } else if (push.kind === "notifications") {
    notes.got.notices = push.notifications.length;
  }

  let answer: unknown;
  try {
    answer = await deps.calendar.verifyNotification(push);
  } catch (error) {
    onError("verify", error);
    return failed("verifyUnavailable");
  }

  const reading = readCheckAnswer(answer, push, EVENT_PROVIDER[source]);
  switch (reading.kind) {
    case "rejected":
      return refused(reading.why, { result: "rejected", stored: 0 });
    case "unknown":
      return failed(reading.code);
    case "validation":
      notes.validation = reading.body;
      return dropped({ result: "validation", stored: 0 });
    case "ignored":
      if (push.kind === "push" && isLabel(push.channelId)) notes.got.watch = push.channelId;
      return dropped({ result: "ignored", stored: 0 });
    case "accepted":
      return storeAll(reading.events, reading.unknownWatches, deps, notes, onError);
  }
}

async function storeAll(
  events: readonly ProviderEvent[],
  unknownWatches: number,
  deps: ProviderDeps,
  notes: SpanNotes,
  onError: (stage: string, error: unknown) => void,
): Promise<Verdict> {
  const watch = single(events.map((event) => textOf(event.payload.watchId)));
  const link = single(events.map((event) => textOf(event.payload.calendarLinkId)));
  if (watch !== undefined) notes.got.watch = watch;
  if (link !== undefined) notes.got.link = link;

  let stored = 0;
  // One at a time, in the push's order: the first failed write answers 503 and the provider sends the push again, whose
  // events already stored are then known ids.
  for (const event of events) {
    const { payload } = scrubPayload(event.payload);
    const outcome = await recordOnce(deps.events, { ...event, payload }, onError);
    if (outcome.kind === "failed") {
      return failed(outcome.code, { result: "accepted", stored, unknownWatches });
    }
    if (outcome.kind === "written") stored += 1;
  }
  const decided = { result: "accepted", stored, unknownWatches };
  return stored > 0 ? written(decided) : dropped(decided);
}
