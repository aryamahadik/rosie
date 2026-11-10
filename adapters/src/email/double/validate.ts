// What the email double refuses (T-418; K-12 v1), written by hand from the schema as the Linq double's checks are: the
// exact field set of a sendEmail request, each field's form, what an email about a booking and each purpose carry, and
// the checks K-12 leaves to code (README 'The email row'): the text's first line is the assistant line, the text holds
// the manage link and the chat link word for word, and the last reference is inReplyTo. Also the forms of the other
// calls' requests and of the K-06 email events a test hands doubleWebhook. A problem line names the field, never its
// value: no address and no words in any message.

import type { ReadReplyRequest, VerifyWebhookRequest } from "./types";

type Obj = Record<string, unknown>;

/** K-12 `emailAddress`: lower case, as K-04 handles.address writes an email handle. */
export const EMAIL_ADDRESS = /^[^@\sA-Z]+@[^@\sA-Z]+$/;
/** K-12 `rfcMessageId`: an email's Message-ID with its angle brackets. */
export const RFC_MESSAGE_ID = /^<[^<>@\s]+@[^<>@\s]+>$/;
/** Resend's error names (README spike row 4), the form K-12 writes a code in. */
export const ERROR_NAME = /^[a-z][a-z_]*$/;

const PART_KEY = /^.+\/[12]\/[1-9][0-9]*$/;
const FROM_ADDRESS = /^[a-z0-9._+-]+@mail[.]rosfield[.]com$/;
const FROM_NAME = /^[^\r\n<>"]*\S[^\r\n<>"]*$/;
const ONE_LINE = /^[^\r\n]*\S[^\r\n]*$/;
const ASSISTANT_LINE = /^[^\r\n]*[Aa]utomated[^\r\n]*$/;
const HTTPS_LINK = /^https:\/\/\S+$/;
const SMS_LINK = /^sms:\+[1-9][0-9]{6,14}&body=\S+$/;
const ONE_WORD = /^\S+$/;
const WORDS = /\S/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/;
const WHOLE_SECONDS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const MEDIA_TYPE = /^[^/\s]+\/[^/\s]+$/;

const PURPOSES: readonly unknown[] = ["confirmation", "copy", "emailWay", "nextWay", "code", "notice"];
const FAILURE_CODES: readonly unknown[] = ["bouncePermanent", "bounceTemporary", "suppressed", "notSent"];

/** The problem line of a From address off mail.rosfield.com: alone, Resend answers it as an unverified domain (403). */
export const FROM_DOMAIN_PROBLEM = "from.address is not on mail.rosfield.com";

const SEND_FIELDS = [
  "idempotencyKey",
  "purpose",
  "bookingId",
  "from",
  "to",
  "replyTo",
  "subject",
  "text",
  "assistantLine",
  "manageLink",
  "chatLink",
  "thread",
];
const EVENT_FIELDS = [
  "eventId",
  "provider",
  "handle",
  "service",
  "kind",
  "messageId",
  "chatId",
  "sentAt",
  "receivedAt",
  "body",
  "scrubbed",
  "attachments",
  "threadedReplyTo",
  "poll",
  "reaction",
  "edit",
  "status",
  "fromRosie",
  "email",
  "traceId",
];
const VERIFY_FIELDS = ["webhookId", "timestamp", "signature", "raw", "receivedAt", "traceId"];
const READ_FIELDS = ["eventId", "receivedEmailId", "receivedAt", "traceId"];

export function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const isUtc = (value: unknown): value is string =>
  typeof value === "string" && UTC.test(value) && !Number.isNaN(Date.parse(value));
export const isWholeSecondsUtc = (value: unknown): value is string =>
  isUtc(value) && WHOLE_SECONDS.test(value);
export const isEmailAddress = (value: unknown): value is string =>
  typeof value === "string" && EMAIL_ADDRESS.test(value);

/** The exact-fields check: every listed field present, none other. */
function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

function hasExactFields(value: Obj, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function checkFrom(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("from is not an object");
    return;
  }
  exactFields("from", value, ["name", "address"], problems);
  if (typeof value.name !== "string" || !FROM_NAME.test(value.name))
    problems.push("from.name is not one line of words without angle brackets or quotes");
  if (typeof value.address !== "string" || !FROM_ADDRESS.test(value.address))
    problems.push(FROM_DOMAIN_PROBLEM);
}

function checkChatLink(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("chatLink is not an object");
    return;
  }
  exactFields("chatLink", value, ["link", "readyText", "shortCode", "qrText"], problems);
  if (typeof value.link !== "string" || !SMS_LINK.test(value.link))
    problems.push("chatLink.link is not an sms: link with a body");
  if (typeof value.readyText !== "string" || !WORDS.test(value.readyText))
    problems.push("chatLink.readyText is not words");
  if (typeof value.shortCode !== "string" || !ONE_WORD.test(value.shortCode))
    problems.push("chatLink.shortCode is not one word");
  if (typeof value.qrText !== "string" || !ONE_WORD.test(value.qrText))
    problems.push("chatLink.qrText is not one word");
}

function checkThread(value: unknown, problems: string[]): void {
  if (!isObject(value)) {
    problems.push("thread is not an object");
    return;
  }
  exactFields("thread", value, ["inReplyTo", "references"], problems);
  const inReplyTo = value.inReplyTo;
  if (inReplyTo !== null && !(typeof inReplyTo === "string" && RFC_MESSAGE_ID.test(inReplyTo)))
    problems.push("thread.inReplyTo is not a Message-ID or null");
  const references: unknown = value.references;
  if (
    !Array.isArray(references) ||
    !(references as unknown[]).every((ref) => typeof ref === "string" && RFC_MESSAGE_ID.test(ref))
  ) {
    problems.push("thread.references is not a list of Message-IDs");
    return;
  }
  if (typeof inReplyTo !== "string") return;
  // RFC 5322: the last of References is the message this one answers (K-12 leaves it to code).
  if (references.length === 0) problems.push("thread.references is empty though inReplyTo names a message");
  else if ((references as unknown[])[references.length - 1] !== inReplyTo)
    problems.push("thread.references does not end with inReplyTo");
}

/** The problems with one sendEmail request, one line each; empty when K-12 v1 allows it. */
export function sendEmailProblems(request: unknown): string[] {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  exactFields("request", request, SEND_FIELDS, problems);
  if (problems.length > 0) return problems;

  const { bookingId, replyTo, manageLink, chatLink, text, assistantLine } = request;
  if (typeof request.idempotencyKey !== "string" || !PART_KEY.test(request.idempotencyKey))
    problems.push("idempotencyKey is not <row>/<part>/<try>");
  if (!PURPOSES.includes(request.purpose)) problems.push("purpose is not a transactional purpose of v1");
  if (bookingId !== null && !isId(bookingId)) problems.push("bookingId is not an id or null");
  checkFrom(request.from, problems);
  if (!isEmailAddress(request.to)) problems.push("to is not a lower-case email address");
  if (replyTo !== null && !isEmailAddress(replyTo))
    problems.push("replyTo is not a lower-case email address or null");
  if (typeof request.subject !== "string" || !ONE_LINE.test(request.subject))
    problems.push("subject is not one line of words");
  if (typeof text !== "string" || !WORDS.test(text)) problems.push("text is not words");
  if (typeof assistantLine !== "string" || !ASSISTANT_LINE.test(assistantLine))
    problems.push("assistantLine is not one line that says automated");
  if (manageLink !== null && !(typeof manageLink === "string" && HTTPS_LINK.test(manageLink)))
    problems.push("manageLink is not an https link or null");
  if (chatLink !== null) checkChatLink(chatLink, problems);
  checkThread(request.thread, problems);
  if (problems.length > 0) return problems;

  // What a booking carries (RULES 4.1; arch 07 line 371): an email about no booking has no reply address, manage link
  // or thread, since an email thread belongs to one booking (K-04 threads_chat_or_email).
  const thread = request.thread as { inReplyTo: string | null; references: string[] };
  if (bookingId === null) {
    if (replyTo !== null) problems.push("replyTo is set on an email about no booking");
    if (manageLink !== null) problems.push("manageLink is set on an email about no booking");
    if (thread.inReplyTo !== null || thread.references.length > 0)
      problems.push("thread is set on an email about no booking");
  } else {
    if (replyTo === null) problems.push("replyTo is missing on an email about a booking");
    if (manageLink === null) problems.push("manageLink is missing on an email about a booking");
  }
  // What each purpose carries (MC C9; RULES 4.1, 4.1b).
  if (request.purpose === "confirmation") {
    if (bookingId === null) problems.push("a confirmation names its booking");
    if (chatLink === null) problems.push("a confirmation carries the chat link");
  } else if (chatLink !== null) problems.push("only a confirmation carries the chat link");
  if (request.purpose === "copy" && bookingId === null) problems.push("a copy names its booking");

  // What K-12 leaves to code (README 'The email row').
  const words = text as string;
  if (words.split(/\r?\n/)[0] !== assistantLine) problems.push("text does not start with assistantLine");
  if (typeof manageLink === "string" && !words.includes(manageLink))
    problems.push("text does not hold manageLink");
  if (isObject(chatLink) && typeof chatLink.link === "string" && !words.includes(chatLink.link))
    problems.push("text does not hold chatLink.link");
  return problems;
}

function checkCounts(value: unknown, problems: string[]): void {
  const count = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (
    !isObject(value) ||
    !hasExactFields(value, ["cards", "ssns"]) ||
    !count(value.cards) ||
    !count(value.ssns)
  )
    problems.push("event.scrubbed is not two counts");
}

function checkAttachments(value: unknown, problems: string[]): void {
  const fine =
    Array.isArray(value) &&
    (value as unknown[]).every(
      (item) =>
        isObject(item) &&
        hasExactFields(item, ["attachmentId", "mediaType"]) &&
        isId(item.attachmentId) &&
        typeof item.mediaType === "string" &&
        MEDIA_TYPE.test(item.mediaType),
    );
  if (!fine) problems.push("event.attachments is not a list of attachments");
}

function checkReplyFields(event: Obj, problems: string[]): void {
  if (!isId(event.messageId)) problems.push("event.messageId is not an id");
  if (!isWholeSecondsUtc(event.sentAt)) problems.push("event.sentAt is not a UTC time in whole seconds");
  if (typeof event.body !== "string") problems.push("event.body is not text");
  if (event.status !== null) problems.push("event.status is set on a reply");
  const email = event.email;
  if (
    !isObject(email) ||
    !hasExactFields(email, ["replyAddress", "subject", "senderCheck"]) ||
    !isEmailAddress(email.replyAddress) ||
    typeof email.subject !== "string" ||
    (email.senderCheck !== "passed" && email.senderCheck !== "failed")
  )
    problems.push("event.email is not a reply's fields");
}

function checkReceiptFields(event: Obj, problems: string[]): void {
  if (event.messageId !== null || event.sentAt !== null || event.body !== null || event.email !== null)
    problems.push("event carries a reply's field on a receipt");
  if (Array.isArray(event.attachments) && event.attachments.length > 0)
    problems.push("event.attachments is set on a receipt");
  const status = event.status;
  if (
    !isObject(status) ||
    !hasExactFields(status, ["messageId", "at", "failure"]) ||
    !isId(status.messageId) ||
    !isWholeSecondsUtc(status.at)
  ) {
    problems.push("event.status is not a receipt's status");
    return;
  }
  const failure = status.failure;
  if (event.kind === "delivered") {
    if (failure !== null) problems.push("event.status.failure is set on a delivered receipt");
    return;
  }
  if (
    !isObject(failure) ||
    !hasExactFields(failure, ["code", "reason"]) ||
    !FAILURE_CODES.includes(failure.code) ||
    typeof failure.reason !== "string" ||
    !WORDS.test(failure.reason)
  )
    problems.push("event.status.failure is not an email failure");
}

/** The problems with a K-06 v1 email event a test hands doubleWebhook; empty when the double can fake it. */
export function emailEventProblems(event: unknown): string[] {
  if (!isObject(event)) return ["event is not an object"];
  const problems: string[] = [];
  exactFields("event", event, EVENT_FIELDS, problems);
  if (problems.length > 0) return problems;
  if (!isId(event.eventId)) problems.push("event.eventId is not an id");
  if (event.provider !== "email" || event.service !== "email")
    problems.push("event.provider and event.service are not email");
  const handle = event.handle;
  if (
    !isObject(handle) ||
    !hasExactFields(handle, ["kind", "address"]) ||
    handle.kind !== "email" ||
    !isEmailAddress(handle.address)
  )
    problems.push("event.handle is not an email handle");
  if (
    event.chatId !== null ||
    event.threadedReplyTo !== null ||
    event.poll !== null ||
    event.reaction !== null ||
    event.edit !== null
  )
    problems.push("event carries a field email has none of");
  if (event.fromRosie !== false) problems.push("event.fromRosie is not false");
  if (!isWholeSecondsUtc(event.receivedAt))
    problems.push("event.receivedAt is not a UTC time in whole seconds");
  if (!isId(event.traceId)) problems.push("event.traceId is not an id");
  checkCounts(event.scrubbed, problems);
  checkAttachments(event.attachments, problems);
  if (event.kind === "text") checkReplyFields(event, problems);
  else if (event.kind === "delivered" || event.kind === "failed") checkReceiptFields(event, problems);
  else problems.push("event.kind is not text, delivered or failed");
  return problems;
}

/** The problems with a doubleWebhook request (K-12 `doubleWebhook.request`); empty when it has the contract's form. */
export function doubleWebhookProblems(request: unknown): string[] {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  exactFields("request", request, ["event", "rfcMessageId"], problems);
  if (problems.length > 0) return problems;
  const rfcMessageId = request.rfcMessageId;
  if (rfcMessageId !== null && !(typeof rfcMessageId === "string" && RFC_MESSAGE_ID.test(rfcMessageId)))
    problems.push("rfcMessageId is not a Message-ID or null");
  problems.push(...emailEventProblems(request.event));
  return problems;
}

/** A verifyWebhook request in K-12's form: the header values and body as text, the gateway's time and trace. */
export function isVerifyRequest(value: unknown): value is VerifyWebhookRequest {
  return (
    isObject(value) &&
    hasExactFields(value, VERIFY_FIELDS) &&
    isId(value.webhookId) &&
    typeof value.timestamp === "string" &&
    typeof value.signature === "string" &&
    typeof value.raw === "string" &&
    isUtc(value.receivedAt) &&
    isId(value.traceId)
  );
}

/** A readReply request in K-12's form. */
export function isReadRequest(value: unknown): value is ReadReplyRequest {
  return (
    isObject(value) &&
    hasExactFields(value, READ_FIELDS) &&
    isId(value.eventId) &&
    isId(value.receivedEmailId) &&
    isUtc(value.receivedAt) &&
    isId(value.traceId)
  );
}
