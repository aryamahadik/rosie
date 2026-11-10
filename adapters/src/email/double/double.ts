// The email double (T-418; C-213; K-12 v1; build prompt 9.4). Test code only: it makes no network call, reads no key
// (the caller hands in a made-up "whsec_" test secret through a function read at each call), and logs nothing, so no
// address, word or secret leaves it. An error names a label, never a value. It answers K-12's calls as the real adapter
// will (T-419 to T-421), and the double's two test hooks:
//
//   sendEmail        records each email it accepts, once per idempotency key: within 24 hours a repeat with the same
//                    email answers the first answer and sends nothing again, and the same key with another email is
//                    refused 409 invalid_idempotent_request, as Resend's Idempotency-Key does (README spike row 2);
//                    refuses what K-12 refuses (validate.ts); answers any failure K-12 defines, as the test chooses
//   verifyWebhook    checks Svix's signature (HMAC-SHA256 over id.timestamp.raw, 300 s window), then reads Resend's body
//                    as one K-06 event with its Message-ID beside it, a reply to read, or ignored
//   readReply        answers a reply the double keeps as one K-06 text event with the gateway's receivedAt and traceId;
//                    ignored for an automatic reply; or a read failure the test chooses
//   doubleWebhook    a signed webhook in Resend's form: a faked delivered or failed receipt of an email it recorded, or a
//                    faked inbound reply's email.received (metadata only), which it keeps for readReply (the two steps)
//   doubleSentEmails the emails it recorded, oldest first, for the staging test-phone page (C-205, through T-565)
//
// Test-side hooks outside the port: failNextSend and failNextRead (failures the test chooses), signRaw (any body signed
// as the double signs, such as a type Rosie ignores), rejectedRequests and reset.

import { verifyLinqWebhookSignature } from "../../shared/hmac";
import type {
  DoubleSentEmailsOutcome,
  DoubleWebhookOutcome,
  DoubleWebhookRequest,
  EmailEvent,
  EmailPort,
  ReadReplyOutcome,
  RecordedEmail,
  RejectedRequest,
  ScriptedReadFailure,
  ScriptedSendFailure,
  SendEmailAccepted,
  SendEmailFailed,
  SendEmailOutcome,
  SendEmailRequest,
  SendFailureKind,
  VerifyRejectReason,
  VerifyWebhookOutcome,
  VerifyWebhookRequest,
} from "./types";
import {
  ERROR_NAME,
  FROM_DOMAIN_PROBLEM,
  doubleWebhookProblems,
  isEmailAddress,
  isId,
  isObject,
  isReadRequest,
  isUtc,
  isVerifyRequest,
  sendEmailProblems,
} from "./validate";
import {
  hasAddress,
  onReceivingDomain,
  parseResendWebhook,
  receiptBody,
  replyBody,
  secondsBefore,
  signWebhook,
  timestampFor,
  type SignOptions,
} from "./webhooks";

/** Rosie's receiving domain for reply addresses until J-14 decides it: K-06's and K-12's fixtures' (open gap 1). */
export const DEFAULT_RECEIVING_DOMAIN = "reply.example.com";

/** How long Resend keeps an idempotency key (README spike row 2: 24 hours). */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

export type EmailDoubleErrorCode =
  | "badRequest"
  | "badChoice"
  | "notRecorded"
  | "wrongHandle"
  | "messageIdOnUnsent"
  | "messageIdOnReply"
  | "addressInReason"
  | "notReceivingDomain"
  | "noSecret"
  | "badSecret";

/** A request the double cannot fake or a choice outside the contract: a setup fault in the test, named by label. */
export class EmailDoubleError extends Error {
  override readonly name = "EmailDoubleError";
  readonly code: EmailDoubleErrorCode;
  /** The fields at fault, for badRequest: names only, never values. */
  readonly problems: readonly string[];

  constructor(code: EmailDoubleErrorCode, problems: readonly string[] = []) {
    super(code);
    this.code = code;
    this.problems = problems;
  }
}

export interface EmailDoubleOptions {
  /** The clock, an RFC 3339 UTC time ending in Z. Default: the real clock, whole seconds. */
  readonly now?: () => string;
  /** The test environment's webhook secret, "whsec_" and base64, read at each call. Never Resend's. */
  readonly webhookSecret?: () => string | Promise<string>;
  /** Rosie's receiving domain, which reply addresses are on. Default DEFAULT_RECEIVING_DOMAIN. */
  readonly receivingDomain?: string;
}

/** Test-side choices for doubleWebhook, outside the port. */
export interface DoubleWebhookOptions extends SignOptions {
  /** For a reply: the id the double keeps it under. Default email-double-in-<n>, counted per double. */
  readonly receivedEmailId?: string;
  /** For a reply: an automatic reply (Auto-Submitted other than "no", RFC 3834), which readReply answers ignored. */
  readonly automatic?: boolean;
}

/** A body to sign as the double signs (signRaw): the timestamp is Svix's header as sent, by default the receipt's. */
export interface SignRawInput {
  readonly webhookId: string;
  readonly raw: string;
  readonly receivedAt: string;
  readonly traceId: string;
  readonly timestamp?: string;
}

export interface SendScriptOptions {
  /** Only a send to this address takes it. Default: any address. */
  readonly to?: string;
  /** How many sends take it. Default 1. */
  readonly times?: number;
}

export interface ReadScriptOptions {
  /** Only a read of this received email takes it. Default: any. */
  readonly receivedEmailId?: string;
  /** How many reads take it. Default 1. */
  readonly times?: number;
}

interface ScriptEntry<T> {
  readonly value: T;
  readonly match: string | null;
  remaining: number;
}

interface KeyRecord {
  readonly at: string;
  readonly canonical: string;
  readonly outcome: SendEmailAccepted;
}

interface KeptReply {
  readonly event: EmailEvent;
  readonly automatic: boolean;
}

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");
const pad = (n: number): string => String(n).padStart(4, "0");
const WHSEC = /^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function failed(
  kind: SendFailureKind,
  httpStatus: number | null,
  code: string | null,
  reason: string,
  retryAfterSeconds: number | null = null,
): SendEmailFailed {
  return { result: "failed", kind, httpStatus, code, reason, retryAfterSeconds };
}

const rejected = (reason: VerifyRejectReason): VerifyWebhookOutcome => ({
  result: "rejected",
  httpStatus: 401,
  reason,
});

function readFailed(kind: "transient" | "unreadable", code: string | null, reason: string): ReadReplyOutcome {
  return kind === "transient"
    ? { result: "failed", kind, httpStatus: 503, code, reason }
    : { result: "failed", kind, httpStatus: 200, code, reason };
}

/** Resend's error name for a transient status (README spike row 4). */
function transientCode(status: number): string {
  if (status === 409) return "concurrent_idempotent_requests";
  return status === 503 ? "service_unavailable" : "application_error";
}

/** The contract's failure for a chosen kind: its status, code and a reason with no key, address or words. */
function scriptedSendFailure(choice: ScriptedSendFailure): SendEmailFailed {
  switch (choice.kind) {
    case "rateLimited":
      return failed(
        "rateLimited",
        429,
        "rate_limit_exceeded",
        "Too many requests: Resend allows 10 a second for the team.",
        choice.retryAfterSeconds ?? null,
      );
    case "quotaReached":
      return choice.code === "monthly_quota_exceeded"
        ? failed("quotaReached", 429, "monthly_quota_exceeded", "The monthly sending quota is used up.")
        : failed(
            "quotaReached",
            429,
            "daily_quota_exceeded",
            "The daily sending quota is used up; it resets at midnight UTC.",
          );
    case "refused":
      return failed(
        "refused",
        choice.httpStatus ?? 400,
        choice.code === undefined ? "validation_error" : choice.code,
        "Resend refused the email.",
      );
    case "transient": {
      const status = choice.httpStatus === undefined ? 500 : choice.httpStatus;
      const code = choice.code !== undefined ? choice.code : status === null ? null : transientCode(status);
      const reason =
        status === null ? "No answer came: a timeout or a network error." : "A server error at Resend.";
      return failed("transient", status, code, reason);
    }
  }
}

const isErrorName = (code: unknown): boolean =>
  code === undefined || code === null || (typeof code === "string" && ERROR_NAME.test(code));
const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Whether a send choice has a form in K-12's `sendEmail.errors` (its status and code rules). */
function sendChoiceFits(choice: unknown): boolean {
  if (!isObject(choice)) return false;
  const { kind, httpStatus, code, retryAfterSeconds } = choice;
  switch (kind) {
    case "rateLimited":
      return (
        retryAfterSeconds === undefined ||
        retryAfterSeconds === null ||
        (isWhole(retryAfterSeconds) && retryAfterSeconds >= 0)
      );
    case "quotaReached":
      return code === undefined || code === "daily_quota_exceeded" || code === "monthly_quota_exceeded";
    case "refused":
      return (
        isErrorName(code) &&
        (httpStatus === undefined ||
          (isWhole(httpStatus) && httpStatus >= 400 && httpStatus <= 499 && httpStatus !== 429))
      );
    case "transient":
      return (
        isErrorName(code) &&
        (httpStatus === undefined ||
          httpStatus === null ||
          httpStatus === 409 ||
          (isWhole(httpStatus) && httpStatus >= 500 && httpStatus <= 599))
      );
    default:
      return false;
  }
}

function readChoiceFits(choice: unknown): boolean {
  return (
    isObject(choice) &&
    (choice.kind === "transient" || choice.kind === "unreadable") &&
    isErrorName(choice.code)
  );
}

function timesOf(times: number | undefined): number {
  if (times === undefined) return 1;
  if (!isWhole(times) || times < 1) throw new EmailDoubleError("badChoice");
  return times;
}

function take<T>(queue: ScriptEntry<T>[], key: string): T | undefined {
  const index = queue.findIndex((entry) => entry.match === null || entry.match === key);
  const entry = queue[index];
  if (entry === undefined) return undefined;
  entry.remaining -= 1;
  if (entry.remaining <= 0) queue.splice(index, 1);
  return entry.value;
}

/** JSON with every object's keys sorted, so two requests compare by content alone ("the same email"). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map((item) => canonicalJson(item)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const secondsBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 1000;

export class EmailDouble implements EmailPort {
  readonly #now: () => string;
  readonly #secret: (() => string | Promise<string>) | undefined;
  readonly #receivingDomain: string;
  #sent: RecordedEmail[] = [];
  #rejected: RejectedRequest[] = [];
  readonly #keys = new Map<string, KeyRecord>();
  readonly #replies = new Map<string, KeptReply>();
  #sendScript: ScriptEntry<ScriptedSendFailure>[] = [];
  #readScript: ScriptEntry<ScriptedReadFailure>[] = [];
  #sentSerial = 0;
  #replySerial = 0;

  constructor(options: EmailDoubleOptions = {}) {
    this.#now = options.now ?? defaultNow;
    this.#secret = options.webhookSecret;
    this.#receivingDomain = (options.receivingDomain ?? DEFAULT_RECEIVING_DOMAIN).toLowerCase();
  }

  // ---- what the test chooses ----

  /** The next send (to `to`, if given) fails this way, `times` times. Nothing is sent, so the key may go again. */
  failNextSend(choice: ScriptedSendFailure, options: SendScriptOptions = {}): void {
    if (!sendChoiceFits(choice)) throw new EmailDoubleError("badChoice");
    this.#sendScript.push({
      value: structuredClone(choice),
      match: options.to ?? null,
      remaining: timesOf(options.times),
    });
  }

  /** The next read of a reply (of `receivedEmailId`, if given) fails this way, `times` times. */
  failNextRead(choice: ScriptedReadFailure, options: ReadScriptOptions = {}): void {
    if (!readChoiceFits(choice)) throw new EmailDoubleError("badChoice");
    this.#readScript.push({
      value: structuredClone(choice),
      match: options.receivedEmailId ?? null,
      remaining: timesOf(options.times),
    });
  }

  /** Back to a new double: no record, no key, no kept reply, no script, ids from 0001 again. */
  reset(): void {
    this.#sent = [];
    this.#rejected = [];
    this.#keys.clear();
    this.#replies.clear();
    this.#sendScript = [];
    this.#readScript = [];
    this.#sentSerial = 0;
    this.#replySerial = 0;
  }

  // ---- what the test reads ----

  /** The sends K-12 refuses for their shape, in order, with the fields at fault (never their values). */
  rejectedRequests(): RejectedRequest[] {
    return structuredClone(this.#rejected);
  }

  // ---- the port's calls ----

  sendEmail(request: unknown): Promise<SendEmailOutcome> {
    return Promise.resolve(this.#send(request));
  }

  async verifyWebhook(request: unknown): Promise<VerifyWebhookOutcome> {
    if (!isVerifyRequest(request)) return rejected("badSignature");
    let secret: string | undefined;
    try {
      secret = this.#secret === undefined ? undefined : await this.#secret();
    } catch {
      secret = undefined;
    }
    // No key, no trust: a double with no secret verifies nothing.
    if (secret === undefined) return rejected("badSignature");
    const checked = await verifyLinqWebhookSignature({
      secret,
      id: request.webhookId,
      timestamp: request.timestamp,
      raw: request.raw,
      signature: request.signature,
      // The window runs from the gateway's own receipt time.
      nowMs: Date.parse(request.receivedAt),
    });
    if (!checked.valid) return rejected(checked.reason);
    return parseResendWebhook(request, this.#receivingDomain);
  }

  readReply(request: unknown): Promise<ReadReplyOutcome> {
    return Promise.resolve(this.#read(request));
  }

  // ---- the double's test hooks (K-12) ----

  /** A signed webhook in Resend's form for a faked receipt or reply; a request it cannot fake rejects by label. */
  async doubleWebhook(request: unknown, options: DoubleWebhookOptions = {}): Promise<DoubleWebhookOutcome> {
    const problems = doubleWebhookProblems(request);
    if (problems.length > 0) throw new EmailDoubleError("badRequest", problems);
    const { event, rfcMessageId } = structuredClone(request as DoubleWebhookRequest);
    return event.kind === "text"
      ? this.#signReply(event, rfcMessageId, options)
      : this.#signReceipt(event, rfcMessageId, options);
  }

  /** The emails the double accepted, oldest first, each once; only those to `to` when it is given. */
  doubleSentEmails(request: unknown): Promise<DoubleSentEmailsOutcome> {
    if (!isObject(request) || Object.keys(request).length !== 1 || !("to" in request))
      return Promise.reject(new EmailDoubleError("badRequest"));
    const to = request.to;
    if (to !== null && !isEmailAddress(to)) return Promise.reject(new EmailDoubleError("badRequest"));
    const emails = this.#sent.filter((email) => to === null || email.request.to === to);
    return Promise.resolve({ result: "recorded", emails: structuredClone(emails) });
  }

  /** Any body signed as the double signs, such as a type Rosie ignores or a fixture's own body (a test-side hook). */
  async signRaw(input: SignRawInput, options: SignOptions = {}): Promise<VerifyWebhookRequest> {
    if (!isId(input.webhookId) || !isUtc(input.receivedAt) || !isId(input.traceId))
      throw new EmailDoubleError("badRequest");
    const secret = await this.#signingSecret();
    const timestamp = input.timestamp ?? timestampFor(input.receivedAt, input.receivedAt, options.stale);
    return signWebhook(
      secret,
      {
        webhookId: input.webhookId,
        timestamp,
        raw: input.raw,
        receivedAt: input.receivedAt,
        traceId: input.traceId,
      },
      options.oneByteChanged === true,
    );
  }

  // ---- inside ----

  #send(request: unknown): SendEmailOutcome {
    const problems = sendEmailProblems(request);
    if (problems.length > 0) {
      this.#rejected.push({ request: structuredClone(request), problems });
      return problems.length === 1 && problems[0] === FROM_DOMAIN_PROBLEM
        ? failed("refused", 403, "validation_error", "The From domain is not verified for sending.")
        : failed("refused", 400, "validation_error", "The request has no shape in the contract.");
    }
    const email = structuredClone(request as SendEmailRequest);
    const now = this.#now();
    const canonical = canonicalJson(email);

    // Resend's Idempotency-Key: one key sends once within 24 hours; another email under it is refused.
    const stored = this.#keys.get(email.idempotencyKey);
    if (stored !== undefined && secondsBetween(stored.at, now) < IDEMPOTENCY_WINDOW_SECONDS) {
      if (stored.canonical !== canonical)
        return failed(
          "refused",
          409,
          "invalid_idempotent_request",
          "This idempotency key was used with another email.",
        );
      return structuredClone(stored.outcome);
    }

    const script = take(this.#sendScript, email.to);
    if (script !== undefined) return scriptedSendFailure(script);

    this.#sentSerial += 1;
    const outcome: SendEmailAccepted = {
      result: "accepted",
      providerMessageId: `email-double-msg-${pad(this.#sentSerial)}`,
      acceptedAt: now,
    };
    this.#keys.set(email.idempotencyKey, { at: now, canonical, outcome });
    this.#sent.push({ recordedAt: now, providerMessageId: outcome.providerMessageId, request: email });
    return structuredClone(outcome);
  }

  #read(request: unknown): ReadReplyOutcome {
    if (!isReadRequest(request))
      return readFailed("unreadable", null, "The request has no shape in the contract.");
    const script = take(this.#readScript, request.receivedEmailId);
    if (script?.kind === "transient")
      return readFailed(
        "transient",
        script.code ?? null,
        "A server or network error: Resend retries the webhook.",
      );
    if (script?.kind === "unreadable")
      return readFailed(
        "unreadable",
        script.code === undefined ? "not_found" : script.code,
        "Resend keeps none of that email's content.",
      );
    const kept = this.#replies.get(request.receivedEmailId);
    if (kept === undefined)
      return readFailed("unreadable", "not_found", "Resend keeps no received email with that id.");
    if (kept.automatic) return { result: "ignored", httpStatus: 200, reason: "automaticReply" };
    return {
      result: "event",
      httpStatus: 200,
      event: {
        ...structuredClone(kept.event),
        eventId: request.eventId,
        receivedAt: request.receivedAt,
        traceId: request.traceId,
      },
    };
  }

  async #signingSecret(): Promise<string> {
    if (this.#secret === undefined) throw new EmailDoubleError("noSecret");
    const secret = await this.#secret();
    if (secret.length <= "whsec_".length || !WHSEC.test(secret)) throw new EmailDoubleError("badSecret");
    return secret;
  }

  async #signReceipt(
    event: EmailEvent,
    rfcMessageId: string | null,
    options: DoubleWebhookOptions,
  ): Promise<DoubleWebhookOutcome> {
    const status = event.status;
    if (status === null) throw new EmailDoubleError("badRequest");
    const recorded = this.#sent.find((email) => email.providerMessageId === status.messageId);
    if (recorded === undefined) throw new EmailDoubleError("notRecorded");
    if (recorded.request.to !== event.handle.address) throw new EmailDoubleError("wrongHandle");
    const failure = status.failure;
    if (
      failure !== null &&
      (failure.code === "suppressed" || failure.code === "notSent") &&
      rfcMessageId !== null
    )
      throw new EmailDoubleError("messageIdOnUnsent");
    if (failure !== null && hasAddress(failure.reason)) throw new EmailDoubleError("addressInReason");
    const secret = await this.#signingSecret();
    const webhook = await signWebhook(
      secret,
      {
        webhookId: event.eventId,
        timestamp: timestampFor(status.at, event.receivedAt, options.stale),
        raw: JSON.stringify(receiptBody(event, status, rfcMessageId, recorded)),
        receivedAt: event.receivedAt,
        traceId: event.traceId,
      },
      options.oneByteChanged === true,
    );
    return { result: "signed", webhook, receivedEmailId: null };
  }

  async #signReply(
    event: EmailEvent,
    rfcMessageId: string | null,
    options: DoubleWebhookOptions,
  ): Promise<DoubleWebhookOutcome> {
    // A reply's own Message-ID is its event's messageId; nothing travels beside it (K-12 doubleWebhook.request).
    if (rfcMessageId !== null) throw new EmailDoubleError("messageIdOnReply");
    const reply = event.email;
    if (reply === null || !onReceivingDomain(reply.replyAddress, this.#receivingDomain))
      throw new EmailDoubleError("notReceivingDomain");
    if (options.receivedEmailId !== undefined && !isId(options.receivedEmailId))
      throw new EmailDoubleError("badRequest");
    const secret = await this.#signingSecret();
    const receivedEmailId = options.receivedEmailId ?? `email-double-in-${pad(this.#replySerial + 1)}`;
    // Resend makes the webhook a second before the gateway receives it, as the recorded sample does (K-12
    // verify-reply-received.json: made at 18:30:03, received at 18:30:04).
    const madeAt = secondsBefore(event.receivedAt, 1);
    const webhook = await signWebhook(
      secret,
      {
        webhookId: event.eventId,
        timestamp: timestampFor(madeAt, event.receivedAt, options.stale),
        raw: JSON.stringify(replyBody(event, reply, receivedEmailId, madeAt)),
        receivedAt: event.receivedAt,
        traceId: event.traceId,
      },
      options.oneByteChanged === true,
    );
    if (options.receivedEmailId === undefined) this.#replySerial += 1;
    this.#replies.set(receivedEmailId, { event, automatic: options.automatic === true });
    return { result: "signed", webhook, receivedEmailId };
  }
}

/** A new email double. */
export function createEmailDouble(options: EmailDoubleOptions = {}): EmailDouble {
  return new EmailDouble(options);
}
