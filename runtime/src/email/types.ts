// The email port's send call as the dispatcher's email rows use it (T-1286, "T-264a"; C-129, C-124; K-12 v1 `sendEmail`;
// ADR-016 sections 3 and 5). The shapes mirror contracts/port-email/port-email.v1.schema.json's sendEmail definitions
// field for field, written by hand: the generated types are git-ignored (ADR-005) and the Worker must not depend on them.
// The Resend adapter (T-419) and the email double (T-418) answer this call in these shapes, so staging's wiring (T-1288)
// can bind either one as the port. The gateway's side of K-12 (a webhook's verify, a reply's read) is
// ../gateway/email/types.ts.

/** Why an email goes: K-12 v1's transactional purposes (RULES 4.1, 4.4), as K-04 v1.1 outbox_rows.email_purpose holds them. */
export type EmailPurpose = "confirmation" | "copy" | "emailWay" | "nextWay" | "code" | "notice";

/** K-12 `sender`: a one-line display name and the one confirmation address on mail.rosfield.com (DL-028). */
export interface EmailSender {
  name: string;
  address: string;
}

/** K-12 `chatLink`: a confirmation's chat link and its QR (K-09 issueChatLink). */
export interface EmailChatLink {
  link: string;
  readyText: string;
  shortCode: string;
  qrText: string;
}

/** K-12 `thread`: the Message-IDs that keep an email in its booking's reply thread. An email about no booking has none. */
export interface EmailThread {
  inReplyTo: string | null;
  references: string[];
}

/** K-12 v1 `sendEmail.request`: one email row to one person, plain text, under its part's K-07 key. */
export interface EmailSendRequest {
  /** The part's K-07 key, `<row>/1/<try>`, sent as Resend's Idempotency-Key. */
  idempotencyKey: string;
  purpose: EmailPurpose;
  bookingId: string | null;
  from: EmailSender;
  /** The person's address, in lower case (K-04 handles.address). Never logged. */
  to: string;
  replyTo: string | null;
  /** Built by code, one line. */
  subject: string;
  /** The whole plain-text body as it goes: the assistant line first. Never logged: it holds the words (a code, too). */
  text: string;
  /** The fixed line that says Rosie is an automated assistant (RULES 1.11), the text's first line. */
  assistantLine: string;
  manageLink: string | null;
  chatLink: EmailChatLink | null;
  thread: EmailThread;
}

/** K-12 v1 `sendEmail.response`: Resend took the email. Accepted is not delivered: the receipt comes later. */
export interface EmailAccepted {
  result: "accepted";
  /** Resend's id for the email (K-07's part id; every receipt names it as K-06 `status.messageId`). */
  providerMessageId: string;
  acceptedAt: string;
}

/** K-12 v1 `sendEmail.errors` (README 'Outcomes of a send'). */
export interface EmailFailed {
  result: "failed";
  kind: "rateLimited" | "quotaReached" | "refused" | "transient";
  /** The HTTP status, or null when no answer came (a timeout, a network error, an answer with no id). */
  httpStatus: number | null;
  /** Resend's error name, or null when it gave none. */
  code: string | null;
  /** The adapter's own fixed words: never a key, an address or the email's words, and never logged here. */
  reason: string;
  retryAfterSeconds: number | null;
}

export type EmailSendOutcome = EmailAccepted | EmailFailed;

/**
 * K-12 v1's send call as the dispatcher makes it: one email per call, safe to repeat under its key (Resend's
 * Idempotency-Key answers a repeat with the same email within 24 hours with its first answer and sends nothing again).
 */
export interface EmailSendPort {
  sendEmail(request: EmailSendRequest): Promise<EmailSendOutcome>;
}

/** What the dispatcher's email rows are joined with (DispatchDeps.email): the port and the From address. */
export interface EmailRowsDeps {
  port: EmailSendPort;
  /**
   * The one confirmation address on mail.rosfield.com every email goes from (K-12 default 2; DL-028): a config value,
   * which K-12's fixtures write as `rosie@mail.rosfield.com` (./rows.ts ROSIE_FROM_ADDRESS).
   */
  fromAddress: string;
}
