// The email double's webhooks in Resend's form (T-418; C-213; K-12 v1 README 'Delivery events', 'Inbound replies' and
// spike rows 6 to 10). receiptBody and replyBody write the body Resend would send for a faked receipt or reply;
// signWebhook signs it as Svix does; parseResendWebhook is the double's reading of a signed body, which verifyWebhook
// gives. Nothing here logs, and an address in a failure's words is taken out before it reaches an event.
//
// Svix signs by the Standard Webhooks scheme the shared base implements for Linq (README spike row 9; K-11 spike rows 2
// and 3): "v1," and the base64 HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<raw>" under the key bytes after the secret's
// "whsec_", space-separated entries, a 300 s window. So the double signs and checks with the shared signer and verifier,
// and the real adapter's verify (T-419) checks the double's webhooks too.

import { DEFAULT_TOLERANCE_SECONDS, signLinqWebhook } from "../../shared/hmac";
import type {
  EmailEvent,
  EmailFailureCode,
  EmailReceiptStatus,
  EmailReplyFields,
  RecordedEmail,
  VerifyWebhookOutcome,
  VerifyWebhookRequest,
} from "./types";
import { EMAIL_ADDRESS, RFC_MESSAGE_ID, isId, isObject, isUtc } from "./validate";

type Json = Record<string, unknown>;

/** The default age of a stale webhook, in seconds: one past the 300 s window. */
export const STALE_BY_SECONDS = 301;

/** The event type an ignored webhook names when its body gives none in K-12's `eventType` form (for the log). */
export const UNREADABLE_EVENT_TYPE = "unknown.unreadable";

/** What replaces an address in a failure's words (the shared base's redaction word). */
export const ADDRESS_TAKEN_OUT = "[redacted]";

const EVENT_TYPE = /^[a-z_]+(?:[.][a-z_]+)+$/;
const ADDRESS = /[^\s<>@]+@[^\s<>@]+/;
// An address with any angle brackets around it, every one in the text: what reasonOf takes out.
const ADDRESSES = /<?[^\s<>@]+@[^\s<>@]+>?/g;

/** Test-side choices for a signed webhook, outside the port: a stale timestamp, or one byte of the signature changed. */
export interface SignOptions {
  /** Sign outside the 300 s window: true makes it STALE_BY_SECONDS older than receipt; a number sets the age. */
  readonly stale?: boolean | number;
  /** Change one byte of the signature (K-12 fixtures' `given.signing` oneByteChanged). */
  readonly oneByteChanged?: boolean;
}

const epochSeconds = (utc: string): number => Math.floor(Date.parse(utc) / 1000);
const withMillis = (utc: string): string => new Date(Date.parse(utc)).toISOString();
const wholeSeconds = (ms: number): string =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[.]000Z$/, "Z");

/** The UTC time `seconds` before `utc`, in whole seconds. */
export const secondsBefore = (utc: string, seconds: number): string =>
  wholeSeconds(Date.parse(utc) - seconds * 1000);

/** Whether a failure's words hold an address (the double never puts one in a body: K-06's reason never holds one). */
export const hasAddress = (text: string): boolean => ADDRESS.test(text);

/** Whether an address is on Rosie's receiving domain (K-12 default 13; a config value until J-14). */
export const onReceivingDomain = (address: string, domain: string): boolean =>
  address.endsWith(`@${domain.toLowerCase()}`);

/** The bare address of `name <address>` or `address`, in lower case; undefined when it is no address. */
export function bareAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const angled = /<([^<>\s]+)>\s*$/.exec(value);
  const address = (angled?.[1] ?? value.trim()).toLowerCase();
  return EMAIL_ADDRESS.test(address) ? address : undefined;
}

/**
 * Svix's timestamp: when the try was sent, in whole seconds. Resend sends the first try as the event is made (each
 * recorded sample's timestamp is its event's created_at), so it is `madeAt`; a gateway receipt more than 300 s from it
 * is a later try, signed when sent, so it is `receivedAt`. Asked for stale, it is that age before `receivedAt`.
 */
export function timestampFor(
  madeAt: string,
  receivedAt: string,
  stale: boolean | number | undefined,
): string {
  const received = epochSeconds(receivedAt);
  if (stale !== undefined && stale !== false)
    return String(received - (stale === true ? STALE_BY_SECONDS : stale));
  const made = epochSeconds(madeAt);
  return String(Math.abs(received - made) <= DEFAULT_TOLERANCE_SECONDS ? made : received);
}

/** One byte of a "v1,<base64>" signature changed: its first byte, one bit flipped. */
function changeOneByte(signature: string): string {
  const bytes = Uint8Array.from(atob(signature.slice("v1,".length)), (char) => char.charCodeAt(0));
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return `v1,${btoa(String.fromCharCode(...bytes))}`;
}

/** The webhook Svix sends: the svix-signature header under the secret, the rest as given. */
export async function signWebhook(
  secret: string,
  unsigned: Omit<VerifyWebhookRequest, "signature">,
  oneByteChanged: boolean,
): Promise<VerifyWebhookRequest> {
  const signature = await signLinqWebhook(secret, unsigned.webhookId, unsigned.timestamp, unsigned.raw);
  return {
    webhookId: unsigned.webhookId,
    timestamp: unsigned.timestamp,
    signature: oneByteChanged ? changeOneByte(signature) : signature,
    raw: unsigned.raw,
    receivedAt: unsigned.receivedAt,
    traceId: unsigned.traceId,
  };
}

const RESEND_TYPE: Readonly<Record<EmailFailureCode, string>> = {
  bouncePermanent: "email.bounced",
  bounceTemporary: "email.bounced",
  suppressed: "email.suppressed",
  notSent: "email.failed",
};

/**
 * Resend's body for a receipt of an email the double recorded (spike row 7): the event's time, the email's own time,
 * id, Message-ID (left out for an email that never went), From, To and subject, and the failure's own object.
 */
export function receiptBody(
  event: EmailEvent,
  status: EmailReceiptStatus,
  rfcMessageId: string | null,
  recorded: RecordedEmail,
): Json {
  const data: Json = {
    created_at: withMillis(recorded.recordedAt),
    email_id: status.messageId,
    ...(rfcMessageId === null ? {} : { message_id: rfcMessageId }),
    from: `${recorded.request.from.name} <${recorded.request.from.address}>`,
    to: [event.handle.address],
    subject: recorded.request.subject,
  };
  const failure = status.failure;
  if (failure === null) return { type: "email.delivered", created_at: withMillis(status.at), data };
  switch (failure.code) {
    case "bouncePermanent":
    case "bounceTemporary":
      data.bounce = {
        message: failure.reason,
        subType: "General",
        type: failure.code === "bouncePermanent" ? "Permanent" : "Temporary",
      };
      break;
    case "suppressed":
      data.suppressed = { message: failure.reason, type: "OnAccountSuppressionList" };
      break;
    case "notSent":
      data.failed = { reason: failure.reason };
      break;
  }
  return { type: RESEND_TYPE[failure.code], created_at: withMillis(status.at), data };
}

/** Resend's email.received body (spike row 10): the reply's metadata only, so the gateway reads it with readReply. */
export function replyBody(
  event: EmailEvent,
  reply: EmailReplyFields,
  receivedEmailId: string,
  madeAt: string,
): Json {
  return {
    type: "email.received",
    created_at: withMillis(madeAt),
    data: {
      email_id: receivedEmailId,
      created_at: withMillis(event.sentAt ?? madeAt),
      from: event.handle.address,
      to: [reply.replyAddress],
      cc: [],
      bcc: [],
      received_for: [reply.replyAddress],
      message_id: event.messageId,
      subject: reply.subject,
      attachments: event.attachments.map((attachment, index) => ({
        id: attachment.attachmentId,
        filename: `attachment-${String(index + 1)}`,
        content_type: attachment.mediaType,
        content_disposition: "attachment",
        content_id: null,
      })),
    },
  };
}

const ignored = (eventType: string): VerifyWebhookOutcome => ({
  result: "ignored",
  httpStatus: 200,
  eventType,
});

/** A failure's words as Resend gave them, any address taken out; the fallback when none are left. */
function reasonOf(value: unknown, fallback: string): string {
  const words = typeof value === "string" ? value.replace(ADDRESSES, ADDRESS_TAKEN_OUT) : "";
  return /\S/.test(words) ? words : fallback;
}

/** K-12's failure for a receipt type (README 'Delivery events'); null for email.delivered. */
function failureOf(type: string, data: Json): EmailReceiptStatus["failure"] {
  if (type === "email.bounced") {
    const bounce: Json = isObject(data.bounce) ? data.bounce : {};
    return {
      code: bounce.type === "Permanent" ? "bouncePermanent" : "bounceTemporary",
      reason: reasonOf(bounce.message, "bounced"),
    };
  }
  if (type === "email.suppressed") {
    const suppressed: Json = isObject(data.suppressed) ? data.suppressed : {};
    return { code: "suppressed", reason: reasonOf(suppressed.message, "suppressed") };
  }
  if (type === "email.failed") {
    const failed: Json = isObject(data.failed) ? data.failed : {};
    return { code: "notSent", reason: reasonOf(failed.reason, "not sent") };
  }
  return null;
}

/** A receipt as one K-06 event with its Message-ID beside it, or undefined when the body lacks what the event needs. */
function readReceipt(
  type: string,
  createdAt: unknown,
  data: Json,
  request: VerifyWebhookRequest,
): VerifyWebhookOutcome | undefined {
  const emailId = data.email_id;
  const to: unknown = Array.isArray(data.to) ? (data.to as unknown[])[0] : undefined;
  const address = bareAddress(to);
  if (!isUtc(createdAt) || !isId(emailId) || address === undefined) return undefined;
  const failure = failureOf(type, data);
  // An email that never went (suppressed, failed) has no Message-ID (spike row 7).
  const went = type === "email.delivered" || type === "email.bounced";
  const messageId = data.message_id;
  const rfcMessageId =
    went && typeof messageId === "string" && RFC_MESSAGE_ID.test(messageId) ? messageId : null;
  const event: EmailEvent = {
    eventId: request.webhookId,
    provider: "email",
    handle: { kind: "email", address },
    service: "email",
    kind: failure === null ? "delivered" : "failed",
    messageId: null,
    chatId: null,
    sentAt: null,
    receivedAt: request.receivedAt,
    body: null,
    scrubbed: { cards: 0, ssns: 0 },
    attachments: [],
    threadedReplyTo: null,
    poll: null,
    reaction: null,
    edit: null,
    status: { messageId: emailId, at: wholeSeconds(Date.parse(createdAt)), failure },
    fromRosie: false,
    email: null,
    traceId: request.traceId,
  };
  return { result: "event", httpStatus: 200, event, rfcMessageId };
}

/** email.received as the reply to read: the first of to, cc and received_for on the receiving domain (default 13). */
function readReplyNotice(
  data: Json,
  request: VerifyWebhookRequest,
  receivingDomain: string,
): VerifyWebhookOutcome | undefined {
  const receivedEmailId = data.email_id;
  if (!isId(receivedEmailId)) return undefined;
  for (const list of [data.to, data.cc, data.received_for]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      const address = bareAddress(entry);
      if (address !== undefined && onReceivingDomain(address, receivingDomain))
        return { result: "reply", eventId: request.webhookId, receivedEmailId, replyAddress: address };
    }
  }
  return undefined;
}

/**
 * The double's reading of a webhook whose signature passed (README 'Delivery events' and 'Inbound replies'): a
 * delivered, bounced, suppressed or failed email as one K-06 event; email.received as the reply to read; anything else,
 * or a body Rosie cannot read, ignored (answered 200 and dropped, README default 10).
 */
export function parseResendWebhook(
  request: VerifyWebhookRequest,
  receivingDomain: string,
): VerifyWebhookOutcome {
  let body: unknown;
  try {
    body = JSON.parse(request.raw);
  } catch {
    return ignored(UNREADABLE_EVENT_TYPE);
  }
  if (!isObject(body) || typeof body.type !== "string") return ignored(UNREADABLE_EVENT_TYPE);
  const type = body.type;
  const eventType = EVENT_TYPE.test(type) ? type : UNREADABLE_EVENT_TYPE;
  const data = body.data;
  if (!isObject(data)) return ignored(eventType);
  switch (type) {
    case "email.delivered":
    case "email.bounced":
    case "email.suppressed":
    case "email.failed":
      return readReceipt(type, body.created_at, data, request) ?? ignored(eventType);
    case "email.received":
      return readReplyNotice(data, request, receivingDomain) ?? ignored(eventType);
    default:
      return ignored(eventType);
  }
}
