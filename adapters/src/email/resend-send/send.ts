// The real Resend send adapter (T-419; C-213; K-12 v1 `sendEmail`; DL-028; ADR-016 sections 5 and 7). It sends one email
// row from the one address on mail.rosfield.com, with the booking's reply address and the thread headers, under the
// part's K-07 key as Resend's Idempotency-Key, and answers K-12's outcome. One call is at most one request; it never
// tries again itself (the dispatcher's K-07 rules do) and it writes, logs and prints nothing.
//
// It reads two names from the environment it is given, at each call, and nothing else:
//   RESEND_API_KEY        the send-only key (K-12 default 1; DL-022). Sent only as the Authorization header to Resend;
//                         never kept, returned, logged or put in an outcome.
//   STAGING_TEST_INBOXES  the named inboxes (K-12 default 19; Q-23's default; ADR-016 section 5's name): addresses
//                         separated by commas or white space, read in lower case. An email goes only to an address on
//                         it. Behind staging's router (T-1288) it is a second lock, so it cannot be turned off here.
//
// Before any request, in this order, a send is refused (K-12 `refused`; each reason names at most a variable's name):
//   1. a request K-12 v1 refuses for its shape (validate.ts): 400 validation_error, or 403 validation_error when the
//      From domain is its one fault, as Resend answers an unverified domain (the email double's answers, T-418);
//   2. a key Resend could not take as its Idempotency-Key header (over 256 characters, or not visible ASCII):
//      400 invalid_idempotency_key, as Resend names it;
//   3. an address not on the named inboxes, or no list, or a list holding an entry that is not an address (fails
//      closed): 403, no code (Resend gave none);
//   4. no key: 401 missing_api_key, as Resend answers a request without one (ADR-016 section 5: a missing key refuses
//      a listed code row, never sending it another way); a key that cannot go in a header: 403 invalid_api_key;
//   5. a confirmation whose QR code cannot be drawn: 400, no code.
// Then the one request (wire.ts), with a time limit; no answer in time, or a network error, is `transient`.

import { base64, qrPng } from "./qr-png";
import type { SendEmailFailed, SendEmailOutcome, SendEmailRequest } from "./types";
import { FROM_DOMAIN_PROBLEM, isEmailAddress, sendEmailProblems } from "./validate";
import {
  RESEND_EMAILS_URL,
  USER_AGENT,
  failed,
  isSendableKey,
  noAnswer,
  readAnswer,
  resendBody,
} from "./wire";

/** The name the send-only key is read by (K-12 default 1). */
export const RESEND_API_KEY = "RESEND_API_KEY";
/** The name the named inboxes are read by (ADR-016 section 5's default name; the release engineer names it). */
export const TEST_INBOXES = "STAGING_TEST_INBOXES";

/** Where the two names are read at each call: the Worker's env on staging; the live check's own (its key, the test inbox). */
export interface ResendSendEnv {
  readonly RESEND_API_KEY?: unknown;
  readonly STAGING_TEST_INBOXES?: unknown;
}

export interface ResendSenderOptions {
  /** Where RESEND_API_KEY and STAGING_TEST_INBOXES are read, by name, at each call. */
  readonly env: ResendSendEnv;
  /** The HTTP call. Default: the runtime's fetch. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The clock for acceptedAt, an RFC 3339 UTC time. Default: the real clock, whole seconds. */
  readonly now?: () => string;
  /** How long to wait for Resend's whole answer, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
}

/** K-12 v1's send call, as this adapter answers it (the email double answers the same call: T-418). */
export interface ResendSender {
  sendEmail(request: unknown): Promise<SendEmailOutcome>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");
const defaultFetch = (request: Request): Promise<Response> => fetch(request);
const KEY_FORM = /^[\x21-\x7e]+$/;

type InboxList = { readonly ok: true; readonly inboxes: ReadonlySet<string> } | { readonly ok: false };

/** The named inboxes: addresses separated by commas or white space, read in lower case. Unset, blank or unreadable: none. */
export function readTestInboxes(value: unknown): InboxList {
  if (typeof value !== "string") return { ok: false };
  const entries = value
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .map((entry) => entry.toLowerCase());
  if (entries.length === 0 || !entries.every((entry) => isEmailAddress(entry))) return { ok: false };
  return { ok: true, inboxes: new Set(entries) };
}

/** Refuses a send that K-12 v1 refuses for its shape, with the double's answers (see the top of this file). */
function shapeRefusal(problems: readonly string[]): SendEmailFailed {
  return problems.length === 1 && problems[0] === FROM_DOMAIN_PROBLEM
    ? failed("refused", 403, "validation_error", "The From domain is not verified for sending.")
    : failed("refused", 400, "validation_error", "The request has no shape in the contract.");
}

export function createResendSender(options: ResendSenderOptions): ResendSender {
  const now = options.now ?? defaultNow;
  const send = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A setup fault, found when the adapter is made rather than at a send.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("timeoutMs is not a whole number of milliseconds above 0");

  return {
    async sendEmail(request: unknown): Promise<SendEmailOutcome> {
      const problems = sendEmailProblems(request);
      if (problems.length > 0) return shapeRefusal(problems);
      const email = request as SendEmailRequest;
      if (!isSendableKey(email.idempotencyKey))
        return failed(
          "refused",
          400,
          "invalid_idempotency_key",
          "The idempotency key is over 256 characters or not visible ASCII: nothing was sent.",
        );

      const list = readTestInboxes(options.env.STAGING_TEST_INBOXES);
      if (!list.ok)
        return failed(
          "refused",
          403,
          null,
          `${TEST_INBOXES} is not set or not a list of addresses, so no address is allowed: nothing was sent.`,
        );
      if (!list.inboxes.has(email.to))
        return failed("refused", 403, null, `The address is not on ${TEST_INBOXES}: nothing was sent.`);

      const key = options.env.RESEND_API_KEY;
      if (typeof key !== "string" || key.trim() === "")
        return failed("refused", 401, "missing_api_key", `${RESEND_API_KEY} is not set: nothing was sent.`);
      if (!KEY_FORM.test(key))
        return failed(
          "refused",
          403,
          "invalid_api_key",
          `${RESEND_API_KEY} holds a space or a character a header cannot carry: nothing was sent.`,
        );

      let qr: string | null = null;
      if (email.chatLink !== null) {
        try {
          qr = base64(qrPng(email.chatLink.qrText));
        } catch {
          return failed(
            "refused",
            400,
            null,
            "The chat link's QR code could not be drawn: nothing was sent.",
          );
        }
      }
      const call = new Request(RESEND_EMAILS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(resendBody(email, qr)),
        // Never follow a redirect: the key goes to Resend's address and nowhere else.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });

      let answer: Response;
      try {
        answer = await send(call);
      } catch {
        return noAnswer();
      }
      let text: string;
      try {
        text = await answer.text();
      } catch {
        // The body did not come: for a 2xx no id can be read, and an error is read by its status alone.
        text = "";
      }
      return readAnswer(answer.status, answer.headers.get("retry-after"), text, now());
    },
  };
}
