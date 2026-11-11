// The email webhook door (T-265; C-044): Resend's delivery events and inbound replies, each verified through the email
// port (K-12 v1), a reply read, scrubbed and sealed to the handle's actor as a text is, a delivery event handed to the
// receipt door. See resend-webhook.ts.

import type { EmailPort } from "./types";

export {
  EMAIL_BODY_LIMIT_BYTES,
  EMAIL_MAX_SIGNATURE_ENTRIES,
  EMAIL_WINDOW_SECONDS,
  handleResendWebhook,
  svixHeaderProblem,
  withSenderCheck,
  type SvixHeaders,
} from "./resend-webhook";
export type * from "./types";

/** The path, under BASE_PATH, that Resend's webhook (its email events and email.received) is pointed at. */
export const RESEND_WEBHOOK_PATH = "/webhooks/resend";

/**
 * The email port until the email adapter (C-213) is joined by the composition root: each call answers by failing, so a
 * webhook the door can read answers 503 and nothing is read, written or handed on. A webhook is never accepted
 * unverified, and Resend's retries cover the gap.
 */
export function unconfiguredEmail(): EmailPort {
  const notYet = (): Promise<never> => Promise.reject(new Error("the email adapter is not connected yet"));
  return { verifyWebhook: notYet, readReply: notYet };
}
