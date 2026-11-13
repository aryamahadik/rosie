// Resend's wire format for one send (T-419; C-213), kept in this folder (K-12 README: "Resend's paths, headers, field
// names and codes stay inside the adapter"; 02-contracts section 5). Sources: K-12 README 'Spike findings' rows 1 (the
// call and its body), 2 (Idempotency-Key), 4 (the error names and their {statusCode, name, message} body), 5 (the
// retry-after header), 13 and 15 (In-Reply-To and References as custom headers); its vendor samples
// (contracts/port-email/vendor-samples/send-email-*.json, error-*.json); and Resend's API introduction
// (resend.com/docs/api-reference/introduction, read Nov 12 2026): "All API requests must include a User-Agent header",
// else 403, which K-12's samples do not show.
//
// What goes to Resend, from one K-12 email row:
//   from         "<name> <address>": the business's name and the one address on mail.rosfield.com; a name that holds
//                one of RFC 5322's specials ( ) [ ] : ; @ \ , . is written in double quotes, a \ escaped (the schema
//                refuses a " or an angle bracket in it), so Resend reads one name and one address
//   to           [the person's address]
//   reply_to     the booking's own reply address; none with no booking
//   subject      the code-built subject; text the whole plain-text body (no html: v1 has no HTML part)
//   headers      In-Reply-To and References (the Message-IDs, separated by spaces) when the thread names any
//   attachments  for a confirmation, the chat link's QR code: chat-link-qr.png (README default 5)
// with the headers Authorization (Bearer and the key), Content-Type, Idempotency-Key (the part's K-07 key) and User-Agent.
//
// What comes back, read into K-12's outcomes (README 'Outcomes of a send'):
//   2xx with {id}                                   accepted, Resend's id as providerMessageId
//   429 daily_quota_exceeded, monthly_quota_exceeded quotaReached
//   429 under any other name                        rateLimited (Resend's 429 is "The rate limit was exceeded"), with
//                                                   retry-after in whole seconds, rounded up
//   409 concurrent_idempotent_requests              transient (the same key is still in progress)
//   any other 4xx, 409 invalid_idempotent_request   refused, Resend's error name as the code (null when it gave none,
//                                                   as for a 403 that is not JSON)
//   5xx                                             transient
//   anything else (1xx, 3xx, 2xx with no id)        transient with no status: an answer the adapter cannot read
// The reason is the adapter's own words, fixed for each case, so it never holds a key, an address or the email's words.

import type {
  EmailSender,
  SendEmailFailed,
  SendEmailOutcome,
  SendEmailRequest,
  SendFailureKind,
} from "./types";

/** Resend's send call (README 'Spike findings' row 1). */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
/** The client name sent as User-Agent: Resend answers 403 to a request without one. A plain name, no contact. */
export const USER_AGENT = "rosie-email-adapter/1";
/** The QR attachment's file name (K-12 README default 5). */
export const QR_FILENAME = "chat-link-qr.png";
/** Resend keeps an idempotency key of at most 256 characters (README 'Spike findings' row 2). */
export const MAX_IDEMPOTENCY_KEY = 256;

/** One send's body, as Resend's send call takes it, in the recorded samples' order. */
export interface ResendEmailBody {
  from: string;
  to: string[];
  reply_to?: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
}

/** RFC 5322 atext, the spaces between words, and any character past ASCII (RFC 6532): a name of these needs no quotes. */
const PLAIN_NAME = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ \u{80}-\u{10FFFF}-]+$/u;
/** Resend's error names, the form K-12 writes a code in. */
const ERROR_NAME = /^[a-z][a-z_]*$/;
/** A provider id the adapter keeps: Resend's ids are UUIDs; any short run of visible characters is taken. */
const PROVIDER_ID = /^[\x21-\x7e]{1,256}$/;

/** The From header: "name <address>", the name in double quotes when it holds one of RFC 5322's specials. */
export function fromHeader(sender: EmailSender): string {
  const name = sender.name.trim();
  const shown = PLAIN_NAME.test(name) ? name : `"${name.replace(/\\/g, "\\\\")}"`;
  return `${shown} <${sender.address}>`;
}

/** Resend's body for one K-12 email row; `qrPng` is the confirmation's QR in base64, null for any other email. */
export function resendBody(request: SendEmailRequest, qrPng: string | null): ResendEmailBody {
  const body: ResendEmailBody = {
    from: fromHeader(request.from),
    to: [request.to],
    ...(request.replyTo === null ? {} : { reply_to: request.replyTo }),
    subject: request.subject,
    text: request.text,
  };
  const headers: Record<string, string> = {};
  if (request.thread.inReplyTo !== null) headers["In-Reply-To"] = request.thread.inReplyTo;
  if (request.thread.references.length > 0) headers.References = request.thread.references.join(" ");
  if (Object.keys(headers).length > 0) body.headers = headers;
  if (qrPng !== null) body.attachments = [{ filename: QR_FILENAME, content: qrPng }];
  return body;
}

/** Whether a key can go as Resend's Idempotency-Key header: visible ASCII, at most 256 characters. */
export function isSendableKey(key: string): boolean {
  return key.length <= MAX_IDEMPOTENCY_KEY && /^[\x21-\x7e]+$/.test(key);
}

export function failed(
  kind: SendFailureKind,
  httpStatus: number | null,
  code: string | null,
  reason: string,
  retryAfterSeconds: number | null = null,
): SendEmailFailed {
  return { result: "failed", kind, httpStatus, code, reason, retryAfterSeconds };
}

/** The adapter's fixed words for each answer (the double's, where the double answers the same). */
export const REASONS = {
  rateLimited: "Too many requests: Resend allows 10 a second for the team.",
  dailyQuota: "The daily sending quota is used up; it resets at midnight UTC.",
  monthlyQuota: "The monthly sending quota is used up.",
  keyReused: "This idempotency key was used with another email.",
  refused: "Resend refused the email.",
  inProgress: "Resend is still sending an email under this idempotency key.",
  serverError: "A server error at Resend.",
  noAnswer: "No answer came: a timeout or a network error.",
  unreadable: "Resend's answer could not be read: no id came back.",
} as const;

/** The no-answer failure: a timeout or a network error (K-12: httpStatus null). */
export const noAnswer = (): SendEmailFailed => failed("transient", null, null, REASONS.noAnswer);

/** Resend's retry-after header in whole seconds, rounded up; null when absent or not a number of seconds. */
export function secondsToWait(header: string | null): number | null {
  const value = header?.trim() ?? "";
  if (!/^[0-9]+(?:[.][0-9]+)?$/.test(value)) return null;
  const seconds = Math.ceil(Number(value));
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** Resend's answer to one send, read into K-12's outcome (see the top of this file). */
export function readAnswer(
  status: number,
  retryAfter: string | null,
  text: string,
  acceptedAt: string,
): SendEmailOutcome {
  const body = parseJson(text);
  if (status >= 200 && status <= 299) {
    const id = field(body, "id");
    return typeof id === "string" && PROVIDER_ID.test(id)
      ? { result: "accepted", providerMessageId: id, acceptedAt }
      : failed("transient", null, null, REASONS.unreadable);
  }
  const given = field(body, "name");
  const name = typeof given === "string" && ERROR_NAME.test(given) ? given : null;
  if (status === 429) {
    if (name === "daily_quota_exceeded") return failed("quotaReached", 429, name, REASONS.dailyQuota);
    if (name === "monthly_quota_exceeded") return failed("quotaReached", 429, name, REASONS.monthlyQuota);
    return failed("rateLimited", 429, "rate_limit_exceeded", REASONS.rateLimited, secondsToWait(retryAfter));
  }
  if (status === 409 && name === "concurrent_idempotent_requests")
    return failed("transient", 409, name, REASONS.inProgress);
  if (status >= 400 && status <= 499)
    return failed(
      "refused",
      status,
      name,
      name === "invalid_idempotent_request" ? REASONS.keyReused : REASONS.refused,
    );
  if (status >= 500 && status <= 599) return failed("transient", status, name, REASONS.serverError);
  return failed("transient", null, null, REASONS.unreadable);
}
