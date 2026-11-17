// Linq's wire format for one send (T-414; C-206), kept in this folder (K-11 README: "Linq's paths, headers, field names
// and codes stay inside the adapter"; 02-contracts section 5). Sources, and nothing else: K-11 v1 README 'Spike
// findings' rows 1 (the base, the bearer token, the send into a chat), 9 (polls), 10 (the send body, reply_to,
// override_optout, a link alone, files up first), 11 (reactions), 12 (typing) and 14 (the error body and its codes); its
// vendor samples (contracts/port-linq/vendor-samples/: send-message-request*.json, send-message-response.json,
// create-poll-*.json, reaction-*.json, error-*.json); and T-1121's live answers of Nov 17
// (adapters/spikes/linq-live/samples/; FINDINGS.md vendor facts 2, 4 and 6). No other path or field is sent or read.
//
// What goes to Linq, by kind, always into a chat that exists (Rosie never opens one: arch 07 line 369). Every id in a
// path is percent-encoded, and an id of . or .. never reaches one (send.ts refuses it), so no id can name another
// endpoint:
//   words, linkCard, photo  POST /chats/{chatId}/messages
//                           {message: {parts, reply_to?, idempotency_key}, override_optout?}
//                           parts: words [{type text, value}] and, with a calendar file, [.., {type media,
//                           attachment_id}]; a link card [{type link, value}], the whole message; a photo
//                           [{type media, attachment_id}]. reply_to {message_id, part_index 0} for a threaded reply.
//                           override_optout true only on a send the caller marks (K-11 overrideOptout); never sent
//                           false, so no other request holds the field at all
//   poll                    POST /chats/{chatId}/polls  {poll: {options: [{text}], idempotency_key}}
//   tapback                 POST /messages/{onMessageId}/reactions  {operation add, type like, part_index 0}: the call
//                           takes no idempotency key and no override_optout (row 11; reaction-request.json)
//   typing                  POST (start) or DELETE (stop) /chats/{chatId}/typing, no body and no key (row 12)
// with the headers Authorization (Bearer and the key), Content-Type when there is a body, and User-Agent. There is no
// field for bold text decorations, a read receipt or a chosen service (preferred_service): none is in K-11 v1.
//
// What comes back, read into K-11's outcomes (README 'Outcomes of a send'):
//   2xx  a message send: the message's id, its service (else the chat's), created_at as acceptedAt. Read from a
//        top-level message (send-message-response.json) or from chat.message (the live answer's shape, FINDINGS
//        vendor fact 4). A poll: message_id and each option's option_id, matched to the request's options by their
//        words; the service is the request's (a poll goes on iMessage alone). A tapback or typing dots: no id, no
//        service. A 2xx the adapter cannot read: transient with no status, as no answer.
//   403 with code 2024                    optedOut (arch 10 line 524), whatever override_optout the send carried
//   code 4001 or 4006                     mayStillDeliver (arch 01 line 65)
//   429 (Linq code 1007)                  rateLimited, retryAfterSeconds from the Retry-After header or the body's
//                                         error.retry_after, the longer of the two, whole seconds rounded up
//   any other 4xx, such as 1004, 1005 or 2008   refused, with Linq's code (1005: a link as a new chat's first message)
//   5xx                                   transient
//   anything else (1xx, 3xx), no answer   transient with no status
// A code K-11 keeps for one kind (2024 for optedOut at 403) is never written on another. The reason is Linq's own
// message when it holds no key, number, address or words of the request, and no part of the key the adapter sends,
// whatever its shape (raw, URL-encoded, inside a longer token, in another case, cut short); else the adapter's fixed
// words, so no part of a screened message reaches the outcome (`screenedReason`).

import { findPrivateValue } from "../../shared/redact";
import type { LinqService, SendFailureKind, SendPartFailed, SendPartOutcome, SendPartRequest } from "./types";

/** Linq's API base (K-11 README spike row 1; the live samples' paths). */
export const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";
/** A plain client name sent as User-Agent, with no contact in it. */
export const USER_AGENT = "rosie-linq-adapter/1";

/** One request to Linq: its method, its path under LINQ_API_BASE, its JSON body or none, and how its answer reads. */
export interface LinqCall {
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly answer: "message" | "poll" | "noMessage";
}

const segment = (id: string): string => encodeURIComponent(id);

/** The ids a part's path names: the chat's, or for a tapback the message it likes. */
export function pathIds(request: SendPartRequest): string[] {
  return request.kind === "tapback" ? [request.tapback?.onMessageId ?? ""] : [request.chatId];
}

/**
 * Whether an id would read as a step within the path: percent-encoding makes any id one path segment, except "." and
 * "..", which a URL resolves (the URL standard's dot segments), so a chat id ".." would send to /messages instead.
 */
export const isStepSegment = (id: string): boolean => id === "." || id === "..";

/** A message send's parts (row 10): the words, then any calendar file; a link card's link; a photo. */
function messageParts(request: SendPartRequest, attachmentId: string | null): Record<string, unknown>[] {
  const media = attachmentId === null ? [] : [{ type: "media", attachment_id: attachmentId }];
  if (request.kind === "linkCard") return [{ type: "link", value: request.link }];
  if (request.kind === "photo") return media;
  return [{ type: "text", value: request.text }, ...media];
}

/**
 * The one request a part goes as. `attachmentId` is the id of the file the part carries, once it is up at Linq; null
 * for a part with no file.
 */
export function linqCall(request: SendPartRequest, attachmentId: string | null): LinqCall {
  const chat = `/chats/${segment(request.chatId)}`;
  switch (request.kind) {
    case "poll":
      return {
        method: "POST",
        path: `${chat}/polls`,
        body: {
          poll: {
            options: request.options.map((text) => ({ text })),
            idempotency_key: request.idempotencyKey,
          },
        },
        answer: "poll",
      };
    case "tapback":
      return {
        method: "POST",
        path: `/messages/${segment(request.tapback?.onMessageId ?? "")}/reactions`,
        body: { operation: "add", type: "like", part_index: 0 },
        answer: "noMessage",
      };
    case "typing":
      return {
        method: request.typing === "stop" ? "DELETE" : "POST",
        path: `${chat}/typing`,
        body: null,
        answer: "noMessage",
      };
    case "words":
    case "linkCard":
    case "photo": {
      const message: Record<string, unknown> = { parts: messageParts(request, attachmentId) };
      if (request.threadedReplyTo !== null)
        message.reply_to = { message_id: request.threadedReplyTo.messageId, part_index: 0 };
      message.idempotency_key = request.idempotencyKey;
      const body: Record<string, unknown> = { message };
      // Only a send the caller marks as allowed after an exact STOP carries the field (arch 10 line 524).
      if (request.overrideOptout) body.override_optout = true;
      return { method: "POST", path: `${chat}/messages`, body, answer: "message" };
    }
  }
}

export function failed(
  kind: SendFailureKind,
  httpStatus: number | null,
  code: string | null,
  reason: string,
  retryAfterSeconds: number | null = null,
): SendPartFailed {
  return { result: "failed", kind, httpStatus, code, reason, retryAfterSeconds, providerMessageId: null };
}

/** The adapter's fixed words for each answer, used when Linq gives none it may keep. */
export const REASONS = {
  optedOut: "The recipient asked to stop: Linq blocks sends to this phone.",
  failed4001: "Delivery failed at Linq; it may still deliver.",
  timedOut4006: "Delivery timed out at Linq; it may still deliver.",
  rateLimited: "Linq's rate limit was reached.",
  refused: "Linq refused the request.",
  serverError: "A server error at Linq.",
  noAnswer: "No answer came: a timeout or a network error.",
  unreadable: "Linq's answer could not be read.",
  fileStep: "The file could not be put up at Linq: nothing was sent.",
} as const;

/** The no-answer failure: a timeout or a network error (K-11: httpStatus null). */
export const noAnswer = (): SendPartFailed => failed("transient", null, null, REASONS.noAnswer);
const unreadable = (): SendPartFailed => failed("transient", null, null, REASONS.unreadable);

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

/** A provider id the adapter keeps: Linq's ids are UUIDs; any short run of visible characters is taken. */
const PROVIDER_ID = /^[\x21-\x7e]{1,256}$/;
const isProviderId = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_ID.test(value);

/** K-11's utc form (common formats `utc`), which Linq's created_at takes, fraction and all. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/;

/** Linq's time when it is a real instant in K-11's utc form, else the adapter's own. */
function utcOr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !UTC.test(value)) return fallback;
  return Number.isNaN(Date.parse(value.replace(/[.][0-9]+Z$/, "Z"))) ? fallback : value;
}

/** Linq's service names (row 6: iMessage, RCS, SMS) as K-11 writes them; null for none or any other. */
function serviceOf(value: unknown): LinqService | null {
  if (typeof value !== "string") return null;
  const name = value.toLowerCase();
  return name === "imessage" || name === "rcs" || name === "sms" ? name : null;
}

/** Linq's error code as K-11 writes it (digits as text): a whole number or a string of digits; else null. */
export function codeOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string") return /^[0-9]{1,9}$/.test(value) ? value : null;
  return null;
}

/** A number of seconds to wait, rounded up: digits with any fraction; null for anything else. */
function seconds(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const rounded = Math.ceil(value);
    return Number.isSafeInteger(rounded) ? rounded : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^[0-9]+(?:[.][0-9]+)?$/.test(text) ? seconds(Number(text)) : null;
}

/**
 * The wait a 429 asks for (arch 10 line 540; K-07 rule 6): the Retry-After header in seconds and the body's
 * error.retry_after (row 14), the longer when both are given, since the next try comes after any of them; null when
 * neither is a number of seconds.
 */
export function retryAfterSeconds(header: string | null, bodyValue: unknown): number | null {
  const found = [seconds(header), seconds(bodyValue)].filter((value): value is number => value !== null);
  return found.length === 0 ? null : Math.max(...found);
}

/**
 * The request's own words, link and number, and the key the adapter sends it with (send.ts reads LINQ_API_TOKEN), which
 * no reason may hold (K-11 `reason`: "Never a key, a phone number or the message's words").
 */
function privateValues(request: SendPartRequest, key: string): string[] {
  return [request.text, request.link, request.to, request.calendarFile?.ics, ...request.options, key].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/** The fewest of the key's characters in a row that count as a part of it: a masked key shows its last 4, say. */
const KEY_PART_LENGTH = 4;

/**
 * Whether `text` holds any part of the key: the whole key in any case, or any KEY_PART_LENGTH of its characters in a
 * row (the key cut short, or masked down to its first or last few). Shorter runs are left, since any text holds a few
 * of the key's characters together by chance.
 */
function holdsKeyPart(text: string, key: string): boolean {
  if (text.toLowerCase().includes(key.toLowerCase())) return true;
  for (let start = 0; start + KEY_PART_LENGTH <= key.length; start += 1)
    if (text.includes(key.slice(start, start + KEY_PART_LENGTH))) return true;
  return false;
}

const UTF8 = new TextDecoder();

/** `text` with each run of %XX escapes read as the UTF-8 bytes it encodes; a byte that is not UTF-8 reads as U+FFFD. */
function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    UTF8.decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
  );
}

/**
 * The ways a private value may sit in `text`: as given, and URL-decoded, again until nothing changes (at most 3 times),
 * so a value written URL-encoded, even twice, reads as itself.
 */
function readings(text: string): string[] {
  const found = [text];
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const decoded = percentDecoded(current);
    if (decoded === current) break;
    found.push(decoded);
    current = decoded;
  }
  return found;
}

/**
 * Words given for a failure (Linq's error.message, or the reason of the caller's file step) as the outcome's reason,
 * when they are one short line in which no reading (as given, or URL-decoded) holds a number, an address or a key's
 * shape (shared/redact.ts), the request's own words, link or number, or any part of the key the adapter sends (raw,
 * URL-encoded, inside a longer token, in another case, cut short); else `fallback`, the adapter's fixed words, so no part
 * of screened words reaches the outcome. Words may still name LINQ_API_TOKEN, the key's name.
 */
export function screenedReason(
  given: unknown,
  fallback: string,
  request: SendPartRequest,
  key: string,
): string {
  if (typeof given !== "string") return fallback;
  const words = given.trim();
  if (words === "" || words.length > 300 || /\p{Cc}/u.test(words)) return fallback;
  const values = privateValues(request, key);
  const holdsPrivate = (text: string): boolean =>
    findPrivateValue(text) !== undefined ||
    values.some((value) => text.includes(value)) ||
    holdsKeyPart(text, key);
  return readings(words).some(holdsPrivate) ? fallback : words;
}

/** A poll's option ids in the order of the request's options, each found by its words; null when any is not found once. */
function optionIds(asked: readonly string[], given: unknown): string[] | null {
  if (!Array.isArray(given) || given.length !== asked.length) return null;
  const options = (given as unknown[]).map((option) => ({
    id: field(option, "option_id"),
    text: field(option, "text"),
  }));
  const ids: string[] = [];
  for (const words of asked) {
    const matches = options.filter((option) => option.text === words);
    const id = matches.length === 1 ? matches[0]?.id : undefined;
    if (!isProviderId(id)) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}

function readAccepted(
  call: LinqCall,
  request: SendPartRequest,
  body: unknown,
  answeredAt: string,
): SendPartOutcome {
  const accepted = { result: "accepted" as const, chatId: request.chatId };
  if (call.answer === "noMessage")
    return {
      ...accepted,
      providerMessageId: null,
      providerOptionIds: null,
      service: null,
      acceptedAt: answeredAt,
    };
  if (call.answer === "poll") {
    const id = field(body, "message_id");
    const ids = optionIds(request.options, field(field(body, "poll"), "options"));
    if (!isProviderId(id) || ids === null) return unreadable();
    return {
      ...accepted,
      providerMessageId: id,
      providerOptionIds: ids,
      service: request.service,
      acceptedAt: utcOr(field(body, "created_at"), answeredAt),
    };
  }
  const chat = field(body, "chat");
  const message = field(body, "message") ?? field(chat, "message");
  const id = field(message, "id");
  if (!isProviderId(id)) return unreadable();
  return {
    ...accepted,
    providerMessageId: id,
    providerOptionIds: null,
    service: serviceOf(field(message, "service")) ?? serviceOf(field(chat, "service")),
    acceptedAt: utcOr(field(message, "created_at"), answeredAt),
  };
}

function readFailure(
  status: number,
  retryAfter: string | null,
  body: unknown,
  request: SendPartRequest,
  key: string,
): SendPartFailed {
  const error = field(body, "error");
  const given = codeOf(field(error, "code"));
  const words = (fallback: string): string => screenedReason(field(error, "message"), fallback, request, key);
  if (status === 403 && given === "2024") return failed("optedOut", 403, "2024", words(REASONS.optedOut));
  if (given === "4001" || given === "4006")
    return failed(
      "mayStillDeliver",
      status,
      given,
      words(given === "4006" ? REASONS.timedOut4006 : REASONS.failed4001),
    );
  // K-11 reads 2024 only as optedOut, at 403 (sendPart.errors): under any other status the code is not kept.
  const code = given === "2024" ? null : given;
  if (status === 429)
    return failed(
      "rateLimited",
      429,
      code,
      words(REASONS.rateLimited),
      retryAfterSeconds(retryAfter, field(error, "retry_after")),
    );
  if (status >= 400 && status <= 499) return failed("refused", status, code, words(REASONS.refused));
  if (status >= 500 && status <= 599) return failed("transient", status, code, words(REASONS.serverError));
  return unreadable();
}

/**
 * Linq's answer to one call, read into K-11's outcome (see the top of this file). `key` is the key the call was sent
 * with, which no reason may hold any part of.
 */
export function readAnswer(
  call: LinqCall,
  request: SendPartRequest,
  key: string,
  status: number,
  retryAfter: string | null,
  text: string,
  answeredAt: string,
): SendPartOutcome {
  const body = parseJson(text);
  if (status >= 200 && status <= 299) return readAccepted(call, request, body, answeredAt);
  return readFailure(status, retryAfter, body, request, key);
}
