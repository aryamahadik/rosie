// The real Linq send adapter (T-414; C-206 Linq send, C-043 capacity; K-11 v1 `sendPart`; K-07 v1 part keys). It sends
// one part into a chat that already exists, of each kind the Nov 5 iPhone tests passed (MC 8 "iPhone tests"): words,
// with an optional calendar file or thread target; a poll of 2 to 5 options; a link card; a photo; typing dots; and
// Rosie's tapback, never on a poll. Each part goes under its K-07 key as Linq's idempotency_key, override_optout goes
// only on a send the caller marks as allowed after an exact STOP, and Linq's answers are read into K-11's outcomes
// (wire.ts). One call is at most one request to send the part (a part with a file first has the file put up, by the
// caller's step: see `attachFile`); it never tries again itself (the dispatcher's K-07 rules do), and it writes, logs
// and prints nothing.
//
// It reads one name from the environment it is given, at each call, and nothing else:
//   LINQ_API_TOKEN  Linq's key (K-11 README default 1; the Worker's secret of that name). Sent only as the
//                   Authorization header to Linq's API base; never kept, returned, logged or put in an outcome.
//
// Before any request is built, in this order, a send is refused (K-11 `refused`; each reason names at most a
// variable's name):
//   1. a request K-11 v1 refuses for its shape (validate.ts), with the Linq double's answer word for word (400, code
//      1004), so the double and the adapter give one port-level result (K-11 contract test): among them bold text
//      decorations, a read receipt and a chosen SMS channel, which v1 has no field or kind for (MC 8; DL-012);
//   2. a poll or a tapback marked to pass an opt-out: Linq's poll and reaction calls take no override_optout (K-11
//      README spike rows 9 and 11), and a stop reply or safety line goes as words; no status, no code;
//   3. a chat or message id of "." or "..", which no encoding keeps from stepping to another of Linq's paths;
//      no status, no code;
//   4. no key, or one no header can carry: no status, no code;
//   5. a part with a file when no step to put files up is given: no status, no code. The dispatcher then sends the
//      part again plain, the words without their file (arch 07 line 367).
// Then the one request, with a time limit; no answer in time, or a network error, is `transient`.
//
// A failure's reason never holds the key or any part of it, a number, an address or the part's own words: Linq's
// error.message and the reason of the caller's file step are both screened (wire.ts `screenedReason`), and screened
// words give way to the adapter's fixed ones. The file step's code is read as Linq's is, digits alone.

import type {
  AttachFile,
  LinqAttachOutcome,
  LinqFile,
  SendPartFailed,
  SendPartOutcome,
  SendPartRequest,
} from "./types";
import { sendPartProblems } from "./validate";
import {
  LINQ_API_BASE,
  REASONS,
  USER_AGENT,
  codeOf,
  failed,
  isStepSegment,
  linqCall,
  noAnswer,
  pathIds,
  readAnswer,
  screenedReason,
} from "./wire";

/** The name Linq's key is read by (K-11 README default 1). */
export const LINQ_API_TOKEN = "LINQ_API_TOKEN";

/** Where LINQ_API_TOKEN is read, by name, at each call: the Worker's env. */
export interface LinqSendEnv {
  readonly LINQ_API_TOKEN?: unknown;
}

export interface LinqSenderOptions {
  /** Where LINQ_API_TOKEN is read, by name, at each call. */
  readonly env: LinqSendEnv;
  /** The HTTP call. Default: the runtime's fetch. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The clock, an RFC 3339 UTC time, for acceptedAt when Linq's answer gives none. Default: the real clock. */
  readonly now?: () => string;
  /** How long to wait for Linq's whole answer, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /** Puts a part's file up at Linq and answers its attachment id (types.ts `AttachFile`). Default: none. */
  readonly attachFile?: AttachFile;
}

/** K-11 v1's send call, as this adapter answers it (the Linq double answers the same call: T-411). */
export interface LinqSender {
  sendPart(request: unknown): Promise<SendPartOutcome>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The Linq double's answer to a request K-11 refuses (adapters/src/linq/double/double.ts), word for word. */
const SHAPE_REFUSAL: SendPartFailed = failed(
  "refused",
  400,
  "1004",
  "The request has no shape in the contract.",
);
/** A key Linq could take in its Authorization header: visible ASCII, no spaces. */
const KEY_FORM = /^[\x21-\x7e]+$/;
const ATTACHMENT_ID = /^[\x21-\x7e]{1,256}$/;

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");
const defaultFetch = (request: Request): Promise<Response> => fetch(request);
const refusedHere = (reason: string): SendPartFailed => failed("refused", null, null, reason);

/** The file a part carries, as it goes up to Linq; null for a part with none. */
function fileOf(request: SendPartRequest): LinqFile | null {
  if (request.kind === "photo" && request.photo !== null)
    return { kind: "photo", fileId: request.photo.fileId, mediaType: request.photo.mediaType };
  if (request.kind === "words" && request.calendarFile !== null)
    return {
      kind: "calendarFile",
      fileName: request.calendarFile.fileName,
      mediaType: "text/calendar",
      bytes: new TextEncoder().encode(request.calendarFile.ics),
    };
  return null;
}

/**
 * The file step's answer: attached with an id the message can name, its failure (K-11's fields alone, so the outcome
 * holds nothing else), or one the adapter cannot read. The failure's reason is screened as Linq's message is, and its
 * code read as Linq's is, so the caller's words never bring the key, a number or the part's words into the outcome.
 */
function readAttached(outcome: unknown, request: SendPartRequest, key: string): LinqAttachOutcome {
  if (typeof outcome === "object" && outcome !== null) {
    const { result, attachmentId } = outcome as { result?: unknown; attachmentId?: unknown };
    if (result === "attached" && typeof attachmentId === "string" && ATTACHMENT_ID.test(attachmentId))
      return { result: "attached", attachmentId };
    if (result === "failed") {
      const failure = outcome as SendPartFailed;
      return failed(
        failure.kind,
        failure.httpStatus,
        codeOf(failure.code),
        screenedReason(failure.reason, REASONS.fileStep, request, key),
        failure.retryAfterSeconds,
      );
    }
  }
  return failed("transient", null, null, "The file step's answer could not be read: nothing was sent.");
}

export function createLinqSender(options: LinqSenderOptions): LinqSender {
  const now = options.now ?? defaultNow;
  const send = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A setup fault, found when the adapter is made rather than at a send.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("timeoutMs is not a whole number of milliseconds above 0");

  /** Puts the part's file up through the caller's step; its failure is the part's. */
  async function attach(file: LinqFile, request: SendPartRequest, key: string): Promise<LinqAttachOutcome> {
    if (options.attachFile === undefined)
      return refusedHere("No step to put a file up at Linq is set up: nothing was sent.");
    try {
      return readAttached(await options.attachFile(file), request, key);
    } catch {
      return failed("transient", null, null, REASONS.fileStep);
    }
  }

  return {
    async sendPart(input: unknown): Promise<SendPartOutcome> {
      if (sendPartProblems(input).length > 0) return { ...SHAPE_REFUSAL };
      const request = input as SendPartRequest;
      if (request.overrideOptout && (request.kind === "poll" || request.kind === "tapback"))
        return refusedHere(
          `Linq's ${request.kind} call takes no override_optout, so a send past an opt-out goes as words: nothing was sent.`,
        );
      if (pathIds(request).some(isStepSegment))
        return refusedHere("An id in the request would read as a step in Linq's path: nothing was sent.");

      const key = options.env.LINQ_API_TOKEN;
      if (typeof key !== "string" || key.trim() === "")
        return refusedHere(`${LINQ_API_TOKEN} is not set: nothing was sent.`);
      if (!KEY_FORM.test(key))
        return refusedHere(
          `${LINQ_API_TOKEN} holds a space or a character a header cannot carry: nothing was sent.`,
        );

      let attachmentId: string | null = null;
      const file = fileOf(request);
      if (file !== null) {
        const attached = await attach(file, request, key);
        if (attached.result !== "attached") return attached;
        attachmentId = attached.attachmentId;
      }

      const call = linqCall(request, attachmentId);
      const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT };
      if (call.body !== null) headers["Content-Type"] = "application/json";
      const http = new Request(`${LINQ_API_BASE}${call.path}`, {
        method: call.method,
        headers,
        ...(call.body === null ? {} : { body: JSON.stringify(call.body) }),
        // Never follow a redirect: the key goes to Linq's API base and nowhere else.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });

      let answer: Response;
      try {
        answer = await send(http);
      } catch {
        return noAnswer();
      }
      let text: string;
      try {
        text = await answer.text();
      } catch {
        // The body did not come: a 2xx is then unreadable, and an error is read by its status alone.
        text = "";
      }
      return readAnswer(call, request, key, answer.status, answer.headers.get("retry-after"), text, now());
    },
  };
}
