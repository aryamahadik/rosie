// The Resend webhook door (T-265; C-044; K-12 v1 "Delivery events" and "Inbound replies"; arch 02 step 1 "Receive", line
// 109: "An email failing its sender check proves nothing (RULES 6.1). Before any write it swaps card numbers ... and
// Social Security numbers for a tag. It writes the sealed event to the handle's actor").
//
// One door for both things Resend sends Rosie: the delivery events of Rosie's own emails and the notice that a reply came
// in. The signature is checked by the port's verify call (K-12 `verifyWebhook`: the email adapter checks Svix's HMAC over
// "<svix-id>.<svix-timestamp>.<raw>" under RESEND_WEBHOOK_SECRET); the door holds no secret and no HMAC. What it does with
// each verified webhook:
// - a delivery event (K-12 `receiptEvent`: delivered, or failed for a bounce, a suppression or an email not sent) goes,
//   scrubbed, to the receipt door, with the Message-ID of Rosie's email beside it: the dispatcher's receipt handler marks
//   the part delivered and arms the question's clock (arch 02 line 127: "Resend's delivered on email"). It never reaches
//   the handle's actor, and no key is asked for it;
// - a reply (Resend's email.received, metadata only) is read through the port (K-12 `readReply`) into one K-06 text
//   event, then scrubbed (its text and its subject), sealed under the handle's key and written to the handle's actor, as
//   a text is (../hand-off.ts, T-243). Its sender check rides in the event, in the clear, as K-06's `email.senderCheck`:
//   only the port's own "passed" is kept as passed, and anything else is written "failed", so an email whose check
//   failed, or did not run, proves nothing to whatever reads it (RULES 6.1; K-06 default 4). An email opens no chat.
//
// Answers, after T-241's rules (../answer.ts, ../providers/common.ts):
// - 413, nothing verified, read or handed on: a body over the door's cap (../body.ts; EmailDeps.emailBodyLimitBytes,
//   EMAIL_BODY_LIMIT_BYTES by default), refused before it is read whole and before any signature check;
// - 401, nothing read or handed on: a missing svix-id or svix-signature header, a svix-timestamp that is not whole
//   seconds or lies more than 300 s from receipt, no "v1," entry or more than 5 of them, or a clock that is not a
//   number, all refused by the door itself before any HMAC (fail closed, as the Stripe door does: T-1079); and every
//   rejection the verify call gives;
// - 200, nothing handed on: a signed type Rosie does not use (ignored: K-12 default 10), an automatic reply (default
//   17), and a reply Resend keeps no content of (unreadable: default 11);
// - 200 after the write: the event, written once by its event id, which is the webhook's id (K-12 default 7); a known
//   event id is 200 with nothing more stored, as the door that stores says in the same step as its write (T-241's and
//   T-244's rule). A reply's handle is known only once it is read, so its read comes before that check: the read has no
//   side effect, and a repeat is dropped at the actor;
// - 503, nothing stored, so Resend sends it again (for about 27 hours: K-12 spike row 9): a verify or a read that cannot
//   answer, a read that fails transient, an answer the door does not know or one off the contract (an event under
//   another id than the webhook's, a delivery event of a kind that is no receipt, a reply that is not an email's text),
//   a key store that gives no key, a seal or a write that fails;
// - 400: a body that cannot be read.
//
// The trace opens at receipt (K-08 opened_by textWebhook) and one `receive` span with provider resend ends every answer
// (K-12 README: "a Resend webhook's arrival is the gateway's receive span with provider resend"). After it, with their own
// start and time: a `portCall` span for each read of a reply (provider resend, call readReply), and, for a reply its actor
// wrote, the `scrub` span (counts only), as the Linq entry writes it (T-1096). Never logged, put in a span or answered: an
// address, a subject, a word of the email, a Message-ID, a header, the body, a failure's reason, a key.

import { isLabel, type BundleId, type Outcome, type SpanFacts, type TraceContext } from "../../trace";
import {
  labelFacts,
  logFailure,
  openWebhookTrace,
  readBundleId,
  respond,
  type WebhookEnvironment,
} from "../answer";
import { bodyLimitOf, readCappedText } from "../body";
import { HandoffError, prepareHandoff, type ScrubDone } from "../hand-off";
import { recordScrub } from "../linq-webhook";
import {
  answerOf,
  dropped,
  failed,
  isRecord,
  isText,
  isTextOrNull,
  refused,
  tooLarge,
  unreadableBody,
  written,
  type Verdict,
} from "../providers/common";
import type { InboundEvent } from "../types";
import type { EmailDeps, EmailRejectReason } from "./types";

// Svix's headers (K-12 `verifyWebhook.request`; README spike row 9). The Headers API reads them in any case.
const HEADER_ID = "svix-id";
const HEADER_TIMESTAMP = "svix-timestamp";
const HEADER_SIGNATURE = "svix-signature";

/**
 * The email door's cap in bytes: 256 KiB, the Linq webhook's and the Stripe door's. Resend's email webhooks carry an
 * email's metadata only, never its body or files (K-12 README "Inbound replies"; spike rows 7 and 10): every K-12 fixture
 * and recorded sample is under 1 KB. Resend's documents give no size.
 */
export const EMAIL_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * The most "v1," entries the door lets through to the verify call: one per active secret, two while a secret is rolled,
 * each costing an HMAC over the whole body (T-1079's cap for the shared verifiers, as the Stripe door holds it).
 */
export const EMAIL_MAX_SIGNATURE_ENTRIES = 5;

/** The signing window either side of receipt, in seconds (K-12 `verifyWebhook.request.timestamp`; arch 02 line 109). */
export const EMAIL_WINDOW_SECONDS = 300;

const WHOLE_SECONDS = /^[0-9]{1,15}$/;

/** K-12 `receiptEvent.kind`: the delivery events of Rosie's own emails. */
const RECEIPT_KINDS: readonly string[] = ["delivered", "failed"];

/** K-12 `replyEvent.kind`: an inbound reply is a text. */
const REPLY_KINDS: readonly string[] = ["text"];

/** A webhook's three Svix headers as sent, each "" when missing. */
export interface SvixHeaders {
  webhookId: string;
  timestamp: string;
  signature: string;
}

/**
 * The door's own reading of the Svix headers before the verify call, by K-12's rejection reasons: badTimestamp when
 * svix-timestamp is not whole seconds; staleTimestamp when it is more than 300 s from now, or when now is not a number
 * (written so that NaN fails); badSignature when svix-id or svix-signature is missing, no entry is a "v1," one, or more
 * than 5 are. The signature itself is the port's to check. Null when the webhook may go to the verify call.
 */
export function svixHeaderProblem(headers: SvixHeaders, nowMs: number): EmailRejectReason | null {
  if (!WHOLE_SECONDS.test(headers.timestamp)) return "badTimestamp";
  if (!(Math.abs(nowMs / 1000 - Number(headers.timestamp)) <= EMAIL_WINDOW_SECONDS)) {
    return "staleTimestamp";
  }
  if (headers.webhookId === "") return "badSignature";
  const entries = headers.signature.split(/\s+/).filter((entry) => entry.startsWith("v1,"));
  if (entries.length === 0 || entries.length > EMAIL_MAX_SIGNATURE_ENTRIES) return "badSignature";
  return null;
}

/**
 * True for a K-06 event the email port may hand the gateway for this webhook: an email's event (provider and service
 * email, an email handle, so it can never name a phone's actor), of one of `kinds`, under the webhook's own id (K-12
 * default 7: the event id is the webhook id, the key a repeat is dropped by).
 */
function isEmailEvent(value: unknown, webhookId: string, kinds: readonly string[]): value is InboundEvent {
  if (!isRecord(value)) return false;
  const { handle, kind } = value;
  return (
    value.eventId === webhookId &&
    value.provider === "email" &&
    value.service === "email" &&
    typeof kind === "string" &&
    kinds.includes(kind) &&
    isText(value.traceId) &&
    isRecord(handle) &&
    handle.kind === "email" &&
    isText(handle.address)
  );
}

/** The verify call's answer, read as unknown: a result the door does not know, or a field off the contract, is unknown. */
type VerifyReading =
  | { kind: "rejected"; reason: string }
  | { kind: "ignored"; eventType: string }
  | { kind: "receipt"; event: InboundEvent; rfcMessageId: string | null }
  | { kind: "reply"; receivedEmailId: string }
  | { kind: "unknown"; code: "unknownVerifyResult" | "badVerifyAnswer" };

function readVerifyAnswer(answer: unknown, webhookId: string): VerifyReading {
  if (!isRecord(answer)) return { kind: "unknown", code: "unknownVerifyResult" };
  const bad = { kind: "unknown", code: "badVerifyAnswer" } as const;
  switch (answer.result) {
    case "rejected":
      return { kind: "rejected", reason: typeof answer.reason === "string" ? answer.reason : "" };
    case "ignored":
      return { kind: "ignored", eventType: typeof answer.eventType === "string" ? answer.eventType : "" };
    case "event": {
      const { event, rfcMessageId } = answer;
      return isEmailEvent(event, webhookId, RECEIPT_KINDS) && isTextOrNull(rfcMessageId)
        ? { kind: "receipt", event, rfcMessageId }
        : bad;
    }
    case "reply":
      return answer.eventId === webhookId && isText(answer.receivedEmailId)
        ? { kind: "reply", receivedEmailId: answer.receivedEmailId }
        : bad;
    default:
      return { kind: "unknown", code: "unknownVerifyResult" };
  }
}

/** The read's answer, read as unknown, as the verify's is. */
type ReplyReading =
  | { kind: "event"; event: InboundEvent }
  | { kind: "automaticReply" }
  | { kind: "transient"; code: string | null }
  | { kind: "unreadable"; code: string | null }
  | { kind: "unknown"; code: "unknownReadResult" | "badReadAnswer" };

function readReplyAnswer(answer: unknown, webhookId: string): ReplyReading {
  if (!isRecord(answer)) return { kind: "unknown", code: "unknownReadResult" };
  const bad = { kind: "unknown", code: "badReadAnswer" } as const;
  switch (answer.result) {
    case "event": {
      const { event } = answer;
      // A reply is an email's text with its reply fields (K-12 `replyEvent`): the sender check lives there.
      return isEmailEvent(event, webhookId, REPLY_KINDS) && isRecord(event.email)
        ? { kind: "event", event }
        : bad;
    }
    case "ignored":
      return answer.reason === "automaticReply" ? { kind: "automaticReply" } : bad;
    case "failed": {
      const code = typeof answer.code === "string" ? answer.code : null;
      if (answer.kind === "transient") return { kind: "transient", code };
      if (answer.kind === "unreadable") return { kind: "unreadable", code };
      return bad;
    }
    default:
      return { kind: "unknown", code: "unknownReadResult" };
  }
}

/**
 * The reply with its sender check as the door writes it (RULES 6.1; K-06 default 4: "A sender check that did not run is
 * failed"): passed only when the port's own word is exactly "passed"; anything else, or none, is written "failed", so the
 * event that reaches the actor says it proves nothing. The door never turns a failed check into a passed one.
 */
export function withSenderCheck(event: InboundEvent): { event: InboundEvent; passed: boolean } {
  const email: unknown = event.email;
  const fields = isRecord(email) ? email : {};
  if (fields.senderCheck === "passed") return { event, passed: true };
  return { event: { ...event, email: { ...fields, senderCheck: "failed" } }, passed: false };
}

/** One read of a reply through the port, for its `portCall` span: when it started, how long it took and how it ended. */
interface ReadDone {
  startedAt: number;
  ms: number;
  outcome: Outcome;
  /** How the read ended, by K-12's own words (event, automaticReply, transient, unreadable) or the door's (noAnswer, unknown). */
  result: string;
  /** Resend's error name for a failed read (K-12 `readReply.errors.code`), kept only when it is a label. */
  code: string | null;
  errorCode: string | null;
}

/** What the spans name beside the verdict: labels, counts and times only, each set once it is known. */
interface SpanNotes {
  got: Record<string, string>;
  /** The webhook's id, once its signature passed, when it is a label. */
  eventId?: string;
  read?: ReadDone;
  /** The scrub of a reply its actor wrote: its span follows receive's. */
  scrub?: ScrubDone;
}

/** What one webhook's steps share: the door's dependencies, the trace, the receipt time and the failure log. */
interface Receipt {
  deps: EmailDeps;
  now: () => number;
  webhookId: string;
  receivedAt: string;
  traceId: string;
  bundleId: BundleId;
  notes: SpanNotes;
  onError: (stage: string, error: unknown) => void;
}

/**
 * Handles one Resend webhook POST. The request's own x-trace-id is never kept (../answer.ts): a webhook comes from
 * Resend, which knows no Rosie trace, so the id is always new, and the event carries it.
 */
export async function handleResendWebhook(
  request: Request,
  deps: EmailDeps,
  where: WebhookEnvironment,
): Promise<Response> {
  const bundleId = await readBundleId(deps);
  const context = openWebhookTrace(deps, bundleId, where, "textWebhook");
  const timing = context.start("receive");
  const notes: SpanNotes = { got: {} };
  const onError = (stage: string, error: unknown): void => {
    logFailure(context.traceId, stage, error);
  };

  const verdict = await decide(request, deps, context.traceId, bundleId, notes, onError);

  let received = false;
  try {
    timing.finish({
      outcome: verdict.outcome,
      provider: "resend",
      ...(notes.eventId === undefined ? {} : { eventId: notes.eventId }),
      got: labelFacts(notes.got),
      decided: { ...verdict.decided, answered: verdict.status },
      errorCode: verdict.errorCode,
    });
    received = true;
  } catch (error) {
    // A span the contract refuses is never logged; the answer does not change for it.
    onError("span", error);
  }
  // Only after a kept receive span: a read's or a scrub's span alone would stand first in a trace that has no receive.
  if (received && notes.read !== undefined) recordRead(context, notes.read, notes.eventId);
  if (received && notes.scrub !== undefined) recordScrub(context, notes.scrub, notes.eventId);
  return respond(answerOf(verdict), context.traceId);
}

/**
 * Records the `portCall` span of one read of a reply, after receive's: provider resend, call readReply, its own start
 * and time, and how it ended in labels. A span the contract refuses is never logged, and the answer does not change.
 */
function recordRead(context: TraceContext, read: ReadDone, eventId: string | undefined): void {
  try {
    context.record({
      hop: "portCall",
      at: new Date(read.startedAt).toISOString(),
      ms: read.ms,
      outcome: read.outcome,
      provider: "resend",
      call: "readReply",
      attempt: 1,
      ...(eventId === undefined ? {} : { eventId }),
      got: labelFacts(read.code === null ? {} : { code: read.code }),
      decided: { result: read.result },
      errorCode: read.errorCode,
    });
  } catch (error) {
    logFailure(context.traceId, "span", error);
  }
}

async function decide(
  request: Request,
  deps: EmailDeps,
  traceId: string,
  bundleId: BundleId,
  notes: SpanNotes,
  onError: (stage: string, error: unknown) => void,
): Promise<Verdict> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  // The body under its cap (../body.ts), before any signature check: one over it is never read whole or verified, and
  // nothing but the span is logged. A body that cannot be read still answers only after the headers' checks.
  const read = await readCappedText(request, bodyLimitOf(deps.emailBodyLimitBytes, EMAIL_BODY_LIMIT_BYTES));
  if ("problem" in read && read.problem === "tooLarge") return tooLarge();

  // A clock that is not a number cannot measure the window: refused, as T-1079 refuses a NaN clock.
  if (!Number.isFinite(nowMs)) return refused("badClock", { signatureValid: false });
  const receivedAt = new Date(nowMs).toISOString();

  const headers: SvixHeaders = {
    webhookId: request.headers.get(HEADER_ID) ?? "",
    timestamp: request.headers.get(HEADER_TIMESTAMP) ?? "",
    signature: request.headers.get(HEADER_SIGNATURE) ?? "",
  };
  const problem = svixHeaderProblem(headers, nowMs);
  if (problem !== null) return refused(problem, { signatureValid: false });

  if ("problem" in read) {
    onError("readBody", read.error);
    return unreadableBody();
  }

  let answer: unknown;
  try {
    // The text request.text() gave before the cap (../body.ts): Svix signs "<id>.<timestamp>.<raw>", so the verify gets
    // the body as sent.
    answer = await deps.email.verifyWebhook({ ...headers, raw: read.text, receivedAt, traceId });
  } catch (error) {
    onError("verify", error);
    return failed("verifyUnavailable");
  }

  const reading = readVerifyAnswer(answer, headers.webhookId);
  if (reading.kind === "rejected") return refused(reading.reason, { signatureValid: false });
  if (reading.kind === "unknown") return failed(reading.code);
  if (reading.kind === "ignored") {
    notes.got.eventType = reading.eventType;
    return dropped({ signatureValid: true, ignoredType: true });
  }

  // The signature passed and the webhook is one Rosie uses: its id names the event from here on.
  if (isLabel(headers.webhookId)) notes.eventId = headers.webhookId;
  const receipt: Receipt = {
    deps,
    now,
    webhookId: headers.webhookId,
    receivedAt,
    traceId,
    bundleId,
    notes,
    onError,
  };
  return reading.kind === "receipt"
    ? storeReceipt(reading.event, reading.rfcMessageId, receipt)
    : storeReply(reading.receivedEmailId, receipt);
}

/** The verdict for what a door that stores answered: 200 only on its own positive word, anything else 503. */
function storedVerdict(stored: unknown, failureCode: string, decided: SpanFacts): Verdict {
  if (stored === "written") return written({ ...decided, knownEventId: false });
  if (stored === "duplicate") return dropped({ ...decided, knownEventId: true });
  return failed(failureCode, decided);
}

/**
 * A delivery event goes, scrubbed, to the receipt door with the Message-ID beside it; never to the handle's actor, and
 * no key is asked for it (a receipt has no words to seal).
 */
async function storeReceipt(
  event: InboundEvent,
  rfcMessageId: string | null,
  receipt: Receipt,
): Promise<Verdict> {
  const { deps, notes } = receipt;
  notes.got.kind = event.kind;
  notes.got.service = event.service;
  let stored: unknown;
  let stage = "prepare";
  let code = "handoffFailed";
  try {
    const prepared = await prepareHandoff(
      {
        event,
        partKey: null,
        traceId: receipt.traceId,
        bundleId: receipt.bundleId,
        now: receipt.now,
      },
      deps.keys,
    );
    // The kind was checked to be a receipt's, so its door is the receipt door; anything else is not handed on.
    if (prepared.door !== "receipts") throw new HandoffError("unroutable");
    stage = "handoff";
    stored = await deps.receipts.accept({ ...prepared.handoff, rfcMessageId });
  } catch (error) {
    receipt.onError(stage, error);
    if (stage === "prepare") code = error instanceof HandoffError ? error.code : "handoffFailed";
  }
  return storedVerdict(stored, code, { signatureValid: true });
}

/** The read's verdict when it gives no event to write, and the read's own span outcome and labels. */
function readEnded(reading: Exclude<ReplyReading, { kind: "event" }> | { kind: "noAnswer" }): {
  verdict: Verdict;
  outcome: Outcome;
  code: string | null;
  errorCode: string | null;
} {
  const decided: SpanFacts = { signatureValid: true };
  switch (reading.kind) {
    case "noAnswer":
      return {
        verdict: failed("readUnavailable", decided),
        outcome: "failed",
        code: null,
        errorCode: "readUnavailable",
      };
    case "transient":
      return {
        verdict: failed("readTransient", decided),
        outcome: "failed",
        code: reading.code,
        errorCode: "readTransient",
      };
    case "unreadable":
      // Answered 200 and dropped (K-12 default 11); the label is what the team console's view of the trace shows.
      return {
        verdict: { ...dropped({ ...decided, unreadableReply: true }), errorCode: "replyUnreadable" },
        outcome: "dropped",
        code: reading.code,
        errorCode: "replyUnreadable",
      };
    case "automaticReply":
      return {
        verdict: dropped({ ...decided, automaticReply: true }),
        outcome: "dropped",
        code: null,
        errorCode: null,
      };
    case "unknown":
      return {
        verdict: failed(reading.code, decided),
        outcome: "failed",
        code: null,
        errorCode: reading.code,
      };
  }
}

/**
 * A reply is read through the port, then scrubbed, sealed and written to the handle's actor, its sender check marked
 * (`withSenderCheck`). The door never gets an unscrubbed or an unsealed body (../hand-off.ts).
 */
async function storeReply(receivedEmailId: string, receipt: Receipt): Promise<Verdict> {
  const { deps, notes, now } = receipt;
  notes.got.kind = "reply";

  const startedAt = now();
  let reading: ReplyReading | { kind: "noAnswer" };
  try {
    const answer: unknown = await deps.email.readReply({
      eventId: receipt.webhookId,
      receivedEmailId,
      receivedAt: receipt.receivedAt,
      traceId: receipt.traceId,
    });
    reading = readReplyAnswer(answer, receipt.webhookId);
  } catch (error) {
    receipt.onError("readReply", error);
    reading = { kind: "noAnswer" };
  }
  const ms = Math.max(0, Math.round(now() - startedAt));

  if (reading.kind !== "event") {
    const ended = readEnded(reading);
    notes.read = {
      startedAt,
      ms,
      outcome: ended.outcome,
      result: reading.kind,
      code: ended.code,
      errorCode: ended.errorCode,
    };
    return ended.verdict;
  }
  notes.read = { startedAt, ms, outcome: "ok", result: "event", code: null, errorCode: null };

  const { event, passed } = withSenderCheck(reading.event);
  notes.got.kind = event.kind;
  notes.got.service = event.service;
  let stored: unknown;
  let scrub: ScrubDone | undefined;
  let stage = "prepare";
  let code = "handoffFailed";
  try {
    // Scrub, then seal, then write: the actor never gets an unscrubbed or an unsealed body or subject.
    const prepared = await prepareHandoff(
      {
        event,
        partKey: null,
        traceId: receipt.traceId,
        bundleId: receipt.bundleId,
        now,
      },
      deps.keys,
    );
    // The kind was checked to be a text, so its door is the actor's; anything else is not handed on.
    if (prepared.door !== "actor") throw new HandoffError("unroutable");
    scrub = prepared.scrub;
    stage = "handoff";
    stored = await deps.actor.accept(prepared.handoff);
  } catch (error) {
    receipt.onError(stage, error);
    if (stage === "prepare") code = error instanceof HandoffError ? error.code : "sealFailed";
  }
  if (stored === "written" && scrub !== undefined) notes.scrub = scrub;
  return storedVerdict(stored, code, { signatureValid: true, senderCheckPassed: passed });
}
