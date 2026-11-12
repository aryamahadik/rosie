// The Resend send adapter's types (T-419; C-213; K-12 v1 sendEmail). They mirror the sendEmail definitions of
// contracts/port-email/port-email.v1.schema.json by hand, field for field as the email double's types do
// (adapters/src/email/double/types.ts), because the generated contract types are git-ignored (ADR-005). This folder's
// tests check every outcome against the schema itself.

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
