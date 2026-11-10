// The email double's types (T-418; C-213; K-12 v1 and K-06 v1). They mirror contracts/port-email/port-email.v1.schema.json
// and the email events of contracts/inbound-event/inbound-event.v1.schema.json by hand, as the Linq double's types do,
// because the generated contract types are git-ignored (ADR-005). This folder's tests check every answer against the
// schemas themselves.

/** Why an email goes: the transactional uses only (K-12 `purpose`; RULES 4.1, 4.4). */
export type EmailPurpose = "confirmation" | "copy" | "emailWay" | "nextWay" | "code" | "notice";

export interface EmailSender {
  name: string;
  address: string;
}

export interface EmailChatLink {
  link: string;
  readyText: string;
  shortCode: string;
  qrText: string;
}

export interface EmailThread {
  inReplyTo: string | null;
  references: string[];
}

/** K-12 `sendEmail.request`: one email row to one person, plain text, under its K-07 key. */
export interface SendEmailRequest {
  idempotencyKey: string;
  purpose: EmailPurpose;
  bookingId: string | null;
  from: EmailSender;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  assistantLine: string;
  manageLink: string | null;
  chatLink: EmailChatLink | null;
  thread: EmailThread;
}

/** K-12 `sendEmail.response`: Resend took the email (accepted is not delivered). */
export interface SendEmailAccepted {
  result: "accepted";
  providerMessageId: string;
  acceptedAt: string;
}

export type SendFailureKind = "rateLimited" | "quotaReached" | "refused" | "transient";

/** K-12 `sendEmail.errors`. */
export interface SendEmailFailed {
  result: "failed";
  kind: SendFailureKind;
  httpStatus: number | null;
  code: string | null;
  reason: string;
  retryAfterSeconds: number | null;
}

export type SendEmailOutcome = SendEmailAccepted | SendEmailFailed;

/** K-02's attachment, as K-06 carries it. */
export interface Attachment {
  attachmentId: string;
  mediaType: string;
}

/** K-12 `failureCode`: how an email failed, as its K-06 failed receipt says. */
export type EmailFailureCode = "bouncePermanent" | "bounceTemporary" | "suppressed" | "notSent";

export interface EmailReceiptStatus {
  messageId: string;
  at: string;
  failure: { code: EmailFailureCode; reason: string } | null;
}

/** K-06 `emailReply`: a reply's reply address, subject and sender check. */
export interface EmailReplyFields {
  replyAddress: string;
  subject: string;
  senderCheck: "passed" | "failed";
}

/** K-06 v1's inbound event, for an email: a reply (kind text) or a delivered or failed receipt. */
export interface EmailEvent {
  eventId: string;
  provider: "email";
  handle: { kind: "email"; address: string };
  service: "email";
  kind: "text" | "delivered" | "failed";
  messageId: string | null;
  chatId: null;
  sentAt: string | null;
  receivedAt: string;
  body: string | null;
  scrubbed: { cards: number; ssns: number };
  attachments: Attachment[];
  threadedReplyTo: null;
  poll: null;
  reaction: null;
  edit: null;
  status: EmailReceiptStatus | null;
  fromRosie: false;
  email: EmailReplyFields | null;
  traceId: string;
}

/** K-12 `verifyWebhook.request`: one webhook as the gateway received it, before any parsing. */
export interface VerifyWebhookRequest {
  webhookId: string;
  timestamp: string;
  signature: string;
  raw: string;
  receivedAt: string;
  traceId: string;
}

export type VerifyRejectReason = "badTimestamp" | "staleTimestamp" | "badSignature";

/** K-12 `verifyWebhook` answers (`rejected` is answered 401 by the gateway). */
export type VerifyWebhookOutcome =
  | { result: "event"; httpStatus: 200; event: EmailEvent; rfcMessageId: string | null }
  | { result: "reply"; eventId: string; receivedEmailId: string; replyAddress: string }
  | { result: "ignored"; httpStatus: 200; eventType: string }
  | { result: "rejected"; httpStatus: 401; reason: VerifyRejectReason };

/** K-12 `readReply.request`. */
export interface ReadReplyRequest {
  eventId: string;
  receivedEmailId: string;
  receivedAt: string;
  traceId: string;
}

/** K-12 `readReply` answers: the gateway answers 503 to a transient failure, so Resend retries, and 200 to the rest. */
export type ReadReplyOutcome =
  | { result: "event"; httpStatus: 200; event: EmailEvent }
  | { result: "ignored"; httpStatus: 200; reason: "automaticReply" }
  | { result: "failed"; kind: "transient"; httpStatus: 503; code: string | null; reason: string }
  | { result: "failed"; kind: "unreadable"; httpStatus: 200; code: string | null; reason: string };

/** K-12 `doubleWebhook.request`: the K-06 event the gateway must get back, and a receipt's Message-ID. */
export interface DoubleWebhookRequest {
  event: EmailEvent;
  rfcMessageId: string | null;
}

/** K-12 `doubleWebhook.response`. */
export interface DoubleWebhookOutcome {
  result: "signed";
  webhook: VerifyWebhookRequest;
  receivedEmailId: string | null;
}

/** K-12 `doubleSentEmails.request`. */
export interface DoubleSentEmailsRequest {
  to: string | null;
}

/** One email the double accepted, as K-12 `doubleSentEmails.response` lists it. */
export interface RecordedEmail {
  recordedAt: string;
  providerMessageId: string;
  request: SendEmailRequest;
}

/** K-12 `doubleSentEmails.response`. */
export interface DoubleSentEmailsOutcome {
  result: "recorded";
  emails: RecordedEmail[];
}

/** K-12 v1's three calls, as the real adapter (T-419 to T-421) and this double both answer them. */
export interface EmailPort {
  sendEmail(request: SendEmailRequest): Promise<SendEmailOutcome>;
  verifyWebhook(request: VerifyWebhookRequest): Promise<VerifyWebhookOutcome>;
  readReply(request: ReadReplyRequest): Promise<ReadReplyOutcome>;
}

/**
 * What a test chooses for the next send: any failure K-12 defines. The double fills the contract's status, code and
 * reason, so the outcome always passes `sendEmail.errors`; a choice outside it is refused when it is made.
 */
export type ScriptedSendFailure =
  | { kind: "rateLimited"; retryAfterSeconds?: number | null }
  | { kind: "quotaReached"; code?: "daily_quota_exceeded" | "monthly_quota_exceeded" }
  | { kind: "refused"; httpStatus?: number; code?: string | null }
  | { kind: "transient"; httpStatus?: number | null; code?: string | null };

/** What a test chooses for the next read of a reply (K-12 `readReply.errors`). */
export type ScriptedReadFailure =
  { kind: "transient"; code?: string | null } | { kind: "unreadable"; code?: string | null };

/** A send K-12 refuses for its shape, with the fields at fault (never their values). */
export interface RejectedRequest {
  request: unknown;
  problems: string[];
}
