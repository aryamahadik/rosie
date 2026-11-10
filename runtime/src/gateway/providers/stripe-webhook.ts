// The Stripe webhook door (T-275; C-044; K-14 v1 "Webhook events"; arch 02 step 1 "Receive", line 109).
//
// Two endpoints, each with its own signing secret (K-14 README spike rows 13 and 14): `rosfield`, Rosfield's own account,
// and `businesses`, the connected accounts. The signature is checked by the port's verify call (K-14 `verifyWebhook`:
// the Stripe adapters check it with the shared helper, adapters/src/shared/hmac.ts); the door holds no secret and no
// HMAC. Answers, after T-241's rules (../answer.ts, ./common.ts):
// - 413, nothing verified or stored: a body over the door's cap (T-1195; ../body.ts; ProviderDoors.stripeBodyLimitBytes,
//   STRIPE_BODY_LIMIT_BYTES by default), refused before it is read whole and before any signature check, with nothing
//   logged but the span, as the page entry and the Linq webhook refuse theirs (T-1180). Every other answer comes in the
//   order it came before the cap, from the same header, clock and text;
// - 401, nothing stored: a missing Stripe-Signature header, one with no single t= of whole seconds or no v1=, more than
//   5 v1= entries, a t= more than 300 s from receipt, or a clock that is not a number, all refused by the door itself
//   before any HMAC (fail closed on the odd input T-1079 hardens the shared verifiers against); and every rejection the
//   verify call gives;
// - 200, nothing stored: a signed type Rosie does not use (ignored), and an event from the other mode, a live one off
//   production or a test one on production (K-14 README "Test mode");
// - 200 after the write: the event, stored once by its event id as a K-07 v1 provider event (K-05 v1.1
//   recordProviderEvent); a known event id is 200 with nothing more stored, as the store says in the same step;
// - 503, nothing stored, so Stripe retries (up to 3 days live): a verify call or a business lookup that cannot answer,
//   an answer the door does not know, a write that fails;
// - 400: a body that cannot be read.
// The trace opens at receipt (K-08 opened_by providerWebhook) and one `providerWebhook` span ends every answer. Never
// logged: the body, the signature header, a secret, a card detail, a name.

import { isLabel, type SpanFacts } from "../../trace";
import {
  labelFacts,
  logFailure,
  openWebhookTrace,
  readBundleId,
  respond,
  type WebhookEnvironment,
} from "../answer";
import { bodyLimitOf, readCappedText } from "../body";
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
  ProviderDeps,
  ProviderEvent,
  StripeAccount,
  StripeEndpoint,
  StripeRejectReason,
  StripeWebhookEvent,
} from "./types";

/** Stripe's signature header (K-14 `verifyWebhook.request.signatureHeader`; README spike row 13). */
const SIGNATURE_HEADER = "stripe-signature";

/**
 * The Stripe door's cap in bytes: 256 KiB, the card's default (T-1195) and the Linq webhook's, over a hundred times K-14's
 * largest webhook (each fixture, its body inside, under 2 KB); neither K-14 nor its spike's Stripe documents give a size.
 */
export const STRIPE_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * The most v1= entries the door lets through to the verify call: one per active secret, two while a secret is rolled
 * (README spike row 13), each costing an HMAC over the whole body. T-1079's cap for the shared verifiers.
 */
export const MAX_SIGNATURE_ENTRIES = 5;

/** The signing window either side of receipt, in seconds (arch 02 line 109; K-14 README default 13). */
export const WINDOW_SECONDS = 300;

const WHOLE_SECONDS = /^[0-9]{1,15}$/;

/**
 * The door's own reading of the Stripe-Signature header before the verify call, by K-14's rejection reasons: badHeader
 * when it is missing or has no single t= of whole seconds or no v1=; badSignature when it has more than 5 v1= entries;
 * staleTimestamp when t= is more than 300 s from now, or when now or t= is not a number (written so that NaN fails).
 * The signature itself is the port's to check. Null when the header may go to the verify call.
 */
export function signatureHeaderProblem(header: string, nowMs: number): StripeRejectReason | null {
  if (header === "") return "badHeader";
  const timestamps: string[] = [];
  let signatures = 0;
  for (const element of header.split(",")) {
    const equals = element.indexOf("=");
    if (equals < 0) continue;
    const key = element.slice(0, equals).trim();
    if (key === "t") timestamps.push(element.slice(equals + 1).trim());
    else if (key === "v1") signatures += 1;
  }
  const [timestamp] = timestamps;
  if (timestamps.length !== 1 || timestamp === undefined || !WHOLE_SECONDS.test(timestamp)) {
    return "badHeader";
  }
  if (signatures === 0) return "badHeader";
  if (signatures > MAX_SIGNATURE_ENTRIES) return "badSignature";
  if (!(Math.abs(nowMs / 1000 - Number(timestamp)) <= WINDOW_SECONDS)) return "staleTimestamp";
  return null;
}

function isAccount(value: unknown): value is StripeAccount {
  if (!isRecord(value)) return false;
  if (value.kind === "rosfield") return true;
  return value.kind === "business" && isText(value.accountId);
}

/** The fields the door reads of K-14's webhookEvent, each of its contract type; the kind's own fields ride in payload. */
function isStripeEvent(value: unknown): value is StripeWebhookEvent {
  if (!isRecord(value)) return false;
  return (
    isText(value.eventId) &&
    isText(value.kind) &&
    isText(value.stripeType) &&
    isAccount(value.account) &&
    typeof value.testMode === "boolean" &&
    isText(value.occurredAt) &&
    isTextOrNull(value.effectId) &&
    isRecord(value.payload)
  );
}

/** The verify call's answer, read as unknown: a result the door does not know, or a field off the contract, is unknown. */
type Reading =
  | { kind: "event"; event: StripeWebhookEvent }
  | { kind: "ignored"; stripeType: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; code: "unknownVerifyResult" | "badVerifyAnswer" };

function readVerifyAnswer(answer: unknown): Reading {
  if (!isRecord(answer)) return { kind: "unknown", code: "unknownVerifyResult" };
  switch (answer.result) {
    case "rejected":
      return { kind: "rejected", reason: typeof answer.reason === "string" ? answer.reason : "" };
    case "ignored":
      return { kind: "ignored", stripeType: typeof answer.stripeType === "string" ? answer.stripeType : "" };
    case "event":
      return isStripeEvent(answer.event)
        ? { kind: "event", event: answer.event }
        : { kind: "unknown", code: "badVerifyAnswer" };
    default:
      return { kind: "unknown", code: "unknownVerifyResult" };
  }
}

/**
 * K-14 README "Test mode": a production endpoint for connected accounts gets live and test events alike, so the gateway
 * keeps only live events on production and only test events anywhere else (staging and its previews: BP 9.4, payments
 * in Stripe's test mode only). True for an event to drop.
 */
export function outOfMode(testMode: boolean, environment: string): boolean {
  return environment === "production" ? testMode : !testMode;
}

/** What the span names beside the verdict: labels only, each set once it is known. */
interface SpanNotes {
  got: Record<string, string>;
  eventId?: string;
  businessId?: string | null;
}

/**
 * Handles one Stripe webhook POST on one endpoint. The request's own x-trace-id is never kept (answer.ts): the trace
 * id is always new, and the stored event carries it.
 */
export async function handleStripeWebhook(
  request: Request,
  endpoint: StripeEndpoint,
  deps: ProviderDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const bundleId = await readBundleId(deps);
  const context = openWebhookTrace(deps, bundleId, where, "providerWebhook");
  const timing = context.start("providerWebhook");
  const notes: SpanNotes = { got: { endpoint } };
  const onError = (stage: string, error: unknown): void => {
    logFailure(context.traceId, stage, error);
  };

  const verdict = await decide(request, endpoint, deps, where, context.traceId, notes, onError);

  try {
    timing.finish({
      outcome: verdict.outcome,
      provider: "stripe",
      call: "verifyWebhook",
      ...(notes.eventId === undefined ? {} : { eventId: notes.eventId }),
      ...(notes.businessId === undefined ? {} : { businessId: notes.businessId }),
      got: labelFacts(notes.got),
      decided: { ...verdict.decided, answered: verdict.status },
      errorCode: verdict.errorCode,
    });
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    onError("span", error);
  }
  return respond(answerOf(verdict), context.traceId);
}

async function decide(
  request: Request,
  endpoint: StripeEndpoint,
  deps: ProviderDeps,
  where: WebhookEnvironment,
  traceId: string,
  notes: SpanNotes,
  onError: (stage: string, error: unknown) => void,
): Promise<Verdict> {
  const nowMs = (deps.now ?? Date.now)();
  // The body under its cap (../body.ts), before any signature check: one over it is never read whole or verified, and
  // nothing but the span is logged. A body that cannot be read still answers only after the header's checks.
  const read = await readCappedText(request, bodyLimitOf(deps.stripeBodyLimitBytes, STRIPE_BODY_LIMIT_BYTES));
  if ("problem" in read && read.problem === "tooLarge") return tooLarge();

  // A clock that is not a number cannot measure the window: refused, as T-1079 refuses a NaN clock.
  if (!Number.isFinite(nowMs)) return refused("badClock", { signatureValid: false });
  const receivedAt = new Date(nowMs).toISOString();

  const header = request.headers.get(SIGNATURE_HEADER) ?? "";
  const problem = signatureHeaderProblem(header, nowMs);
  if (problem !== null) return refused(problem, { signatureValid: false });

  if ("problem" in read) {
    onError("readBody", read.error);
    return unreadableBody();
  }
  // The text request.text() gave before the cap (../body.ts): Stripe signs "<t>.<raw>", so the verify gets it as sent.
  const raw = read.text;

  let answer: unknown;
  try {
    answer = await deps.stripe.verifyWebhook({
      endpoint,
      signatureHeader: header,
      raw,
      receivedAt,
      traceId,
    });
  } catch (error) {
    onError("verify", error);
    return failed("verifyUnavailable");
  }

  const reading = readVerifyAnswer(answer);
  switch (reading.kind) {
    case "rejected":
      return refused(reading.reason, { signatureValid: false });
    case "ignored":
      notes.got.stripeType = reading.stripeType;
      return dropped({ signatureValid: true, ignoredType: true });
    case "unknown":
      return failed(reading.code);
    case "event":
      return store(reading.event, deps, where, receivedAt, traceId, notes, onError);
  }
}

async function store(
  event: StripeWebhookEvent,
  deps: ProviderDeps,
  where: WebhookEnvironment,
  receivedAt: string,
  traceId: string,
  notes: SpanNotes,
  onError: (stage: string, error: unknown) => void,
): Promise<Verdict> {
  if (isLabel(event.eventId)) notes.eventId = event.eventId;
  notes.got.kind = event.kind;
  notes.got.stripeType = event.stripeType;
  if (outOfMode(event.testMode, where.environment)) {
    return dropped({ signatureValid: true, testModeDropped: true });
  }

  let businessId: unknown;
  try {
    businessId = await deps.stripeBusinesses.businessOf({
      account: event.account,
      effectId: event.effectId,
    });
  } catch (error) {
    onError("business", error);
    return failed("businessUnavailable", { signatureValid: true });
  }
  if (!isTextOrNull(businessId)) return failed("badBusinessAnswer", { signatureValid: true });
  if (businessId === null || isLabel(businessId)) notes.businessId = businessId;

  // K-14 README "Webhook events": the stored payload is the event's kind, account, test mode and its kind's fields.
  const { payload, swapped } = scrubPayload({
    kind: event.kind,
    account: event.account,
    testMode: event.testMode,
    payload: event.payload,
  });
  const record: ProviderEvent = {
    provider: "stripe",
    providerEventId: event.eventId,
    eventType: event.stripeType,
    occurredAt: event.occurredAt,
    receivedAt,
    businessId,
    effectId: event.effectId,
    payload,
    traceId,
  };
  const scrubbed: SpanFacts = swapped > 0 ? { scrubbed: swapped } : {};
  const outcome = await recordOnce(deps.events, record, onError);
  switch (outcome.kind) {
    case "written":
      return written({ signatureValid: true, knownEventId: false, ...scrubbed });
    case "duplicate":
      return dropped({ signatureValid: true, knownEventId: true, ...scrubbed });
    case "failed":
      return failed(outcome.code, { signatureValid: true, ...scrubbed });
  }
}
