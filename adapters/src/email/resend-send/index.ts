// The real Resend send adapter (T-419; C-213; K-12 v1 sendEmail). live-check.mjs, beside it, is T-1032's live check: it
// is run by hand and imports this file.
export {
  DEFAULT_TIMEOUT_MS,
  RESEND_API_KEY,
  TEST_INBOXES,
  createResendSender,
  readTestInboxes,
  type ResendSendEnv,
  type ResendSender,
  type ResendSenderOptions,
} from "./send";
export type {
  EmailChatLink,
  EmailPurpose,
  EmailSender,
  EmailThread,
  SendEmailAccepted,
  SendEmailFailed,
  SendEmailOutcome,
  SendEmailRequest,
  SendFailureKind,
} from "./types";
export { sendEmailProblems } from "./validate";
export { RESEND_EMAILS_URL, USER_AGENT } from "./wire";
