// Linq's webhook payloads to K-06 v1 events (T-413; C-207; K-11 v1 README spike rows 5 to 9; 02-contracts K-06).
//
// Linq's wire format stays in this file: event types, field names and the 2026-02-03 envelope. Nothing here logs, and an
// error names a code, never a field value, so no body, phone number or secret reaches a log through it.
//
// What the payload cannot give, and where it comes from instead (both recorded in the T-413 report):
//   - A receipt, Rosie's own reaction and a failed poll carry the chat, not the person's number (the sender is Rosie's
//     line). K-06 wants "the handle Rosie's part went to", so the caller gives `chatHandle`, which finds it by chat id
//     (K-04 threads.linq_chat_id). With no answer the parse throws and the gateway answers 503, so Linq retries.
//   - A vote carries the option's id, not its words (K-06 `optionWords`). The caller may give `optionWords`; without it
//     the words are "" and the actor reads them from the poll part K-04 holds.

import type { InboundEvent, PollVoteFields, ParsedEvent } from "./types";

/** A signed webhook this adapter cannot turn into an event. The code is a label; the gateway answers 503 for it. */
export class LinqWebhookError extends Error {
  override readonly name = "LinqWebhookError";
  readonly code: "badEvent" | "unsupportedWebhookVersion" | "unknownService" | "receiptHandleUnknown";

  constructor(code: LinqWebhookError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface ParseLookups {
  /** The person's number (E.164) for a chat id, or null when unknown. */
  readonly chatHandle?: (chatId: string) => string | null | Promise<string | null>;
  /** The words of a poll option, or null when unknown. */
  readonly optionWords?: (pollId: string, optionId: string) => string | null | Promise<string | null>;
}

export interface ParseInput {
  readonly body: unknown;
  readonly receivedAt: string;
  readonly traceId: string;
}

type Json = Record<string, unknown>;

const SUPPORTED_VERSION = "2026-02-03";
const E164 = /^\+[1-9][0-9]{6,14}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;
const SERVICES: Readonly<Record<string, "imessage" | "rcs" | "sms">> = {
  imessage: "imessage",
  rcs: "rcs",
  sms: "sms",
};

const bad = (): LinqWebhookError => new LinqWebhookError("badEvent");

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function need(value: unknown): string {
  const found = text(value);
  if (found === undefined) throw bad();
  return found;
}

function obj(value: unknown): Json {
  if (!isJson(value)) throw bad();
  return value;
}

/** An RFC 3339 instant ending in Z, as K-06 writes it; another offset is converted. */
function utc(value: unknown): string {
  const given = need(value);
  if (UTC.test(given)) return given;
  const ms = Date.parse(given);
  if (Number.isNaN(ms)) throw bad();
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function phone(value: unknown): string {
  const given = need(value);
  if (!E164.test(given)) throw bad();
  return given;
}

function service(value: unknown): "imessage" | "rcs" | "sms" | null {
  const given = text(value);
  return given === undefined ? null : (SERVICES[given.toLowerCase()] ?? null);
}

/** The service of a text-like event: Linq must name one K-06 knows. */
function requiredService(value: unknown): "imessage" | "rcs" | "sms" {
  const found = service(value);
  if (found === null) throw new LinqWebhookError("unknownService");
  return found;
}

function chatIdOf(data: Json): string {
  // 2026-02-03 puts the chat under data.chat.id; the failed receipts keep a flat data.chat_id.
  return isJson(data.chat) ? need(data.chat.id) : need(data.chat_id);
}

const MEDIA_IMAGE = /^image\//i;

function baseEvent(
  input: ParseInput,
  eventId: string,
  handle: string,
  svc: "imessage" | "rcs" | "sms" | null,
  chatId: string,
  kind: InboundEvent["kind"],
): InboundEvent {
  return {
    eventId,
    provider: "linq",
    handle: { kind: "phone", address: handle },
    service: svc,
    kind,
    messageId: null,
    chatId,
    sentAt: null,
    receivedAt: input.receivedAt,
    body: null,
    scrubbed: { cards: 0, ssns: 0 },
    attachments: [],
    threadedReplyTo: null,
    poll: null,
    reaction: null,
    edit: null,
    status: null,
    fromRosie: false,
    email: null,
    traceId: input.traceId,
  };
}

async function receiptHandle(lookups: ParseLookups, chatId: string): Promise<string> {
  const found = await Promise.resolve()
    .then(() => lookups.chatHandle?.(chatId))
    .then(
      (value) => value ?? null,
      () => null,
    );
  if (found === null || !E164.test(found)) throw new LinqWebhookError("receiptHandleUnknown");
  return found;
}

function senderIsRosie(data: Json): boolean {
  const sender = data.sender_handle;
  return isJson(sender) && sender.is_me === true;
}

/** message.received: a person's text or photo. Rosie's own words echoed back (is_me) are never the person's. */
function parseReceived(data: Json, input: ParseInput, eventId: string): ParsedEvent {
  // K-11 README row 6: an is_me message is Rosie's own words. fromRosie on a text would still start a turn (K-06
  // routing), so it is ignored here and never becomes an event.
  if (senderIsRosie(data) || data.direction === "outbound") return { result: "ignored" };
  const sender = obj(data.sender_handle);
  const svc = requiredService(data.service ?? sender.service);
  const parts = Array.isArray(data.parts) ? data.parts : [];
  const words: string[] = [];
  const attachments: InboundEvent["attachments"] = [];
  for (const part of parts) {
    if (!isJson(part)) continue;
    if ((part.type === "text" || part.type === "link") && typeof part.value === "string") {
      words.push(part.value);
    } else if (part.type === "media") {
      attachments.push({
        attachmentId: need(part.id),
        mediaType: text(part.mime_type) ?? "application/octet-stream",
      });
    }
  }
  const isPhoto = attachments.some((a) => MEDIA_IMAGE.test(a.mediaType));
  const event = baseEvent(
    input,
    eventId,
    phone(sender.handle),
    svc,
    chatIdOf(data),
    isPhoto ? "photo" : "text",
  );
  event.messageId = need(data.id);
  event.sentAt = utc(data.sent_at);
  event.body = words.join("\n");
  event.attachments = attachments;
  event.threadedReplyTo = isJson(data.reply_to) ? (text(data.reply_to.message_id) ?? null) : null;
  return { result: "event", event, partKey: null };
}

/** message.sent and message.delivered: a receipt, with the key Linq echoes for the part. */
async function parseReceipt(
  kind: "sent" | "delivered",
  data: Json,
  input: ParseInput,
  eventId: string,
  lookups: ParseLookups,
): Promise<ParsedEvent> {
  const chatId = chatIdOf(data);
  const event = baseEvent(
    input,
    eventId,
    await receiptHandle(lookups, chatId),
    service(data.service),
    chatId,
    kind,
  );
  const at = kind === "delivered" ? (data.delivered_at ?? data.sent_at) : data.sent_at;
  event.status = { messageId: need(data.id), at: utc(at), failure: null };
  return { result: "event", event, partKey: text(data.idempotency_key) ?? null };
}

/** message.failed: the part failed, with Linq's code. */
async function parseFailed(
  data: Json,
  input: ParseInput,
  eventId: string,
  lookups: ParseLookups,
): Promise<ParsedEvent> {
  const chatId = chatIdOf(data);
  const event = baseEvent(
    input,
    eventId,
    await receiptHandle(lookups, chatId),
    service(data.service),
    chatId,
    "failed",
  );
  const code = data.code;
  event.status = {
    messageId: need(data.message_id),
    at: utc(data.failed_at),
    failure: {
      code: typeof code === "number" || text(code) !== undefined ? String(code) : null,
      reason: text(data.reason) ?? "message failed",
    },
  };
  return { result: "event", event, partKey: null };
}

/** poll.failed: a poll that did not send; the sender is null, so the person is found by chat. */
async function parsePollFailed(
  data: Json,
  input: ParseInput,
  eventId: string,
  lookups: ParseLookups,
): Promise<ParsedEvent> {
  const chatId = chatIdOf(data);
  const event = baseEvent(
    input,
    eventId,
    await receiptHandle(lookups, chatId),
    service(data.service),
    chatId,
    "failed",
  );
  const error = isJson(data.error) ? data.error : {};
  const code = error.code;
  event.status = {
    messageId: need(data.message_id),
    at: utc(data.failed_at),
    failure: {
      code: typeof code === "number" || text(code) !== undefined ? String(code) : null,
      reason: "poll failed",
    },
  };
  return { result: "event", event, partKey: null };
}

/** message.edited: the new words of a message the person edited (2026-02-03 only). */
function parseEdited(data: Json, input: ParseInput, eventId: string): ParsedEvent {
  if (senderIsRosie(data)) return { result: "ignored" };
  const sender = obj(data.sender_handle);
  const part = obj(data.part);
  if (typeof part.text !== "string") throw bad();
  const event = baseEvent(
    input,
    eventId,
    phone(sender.handle),
    requiredService(data.service ?? sender.service),
    chatIdOf(data),
    "edit",
  );
  event.sentAt = utc(data.edited_at);
  event.body = part.text;
  event.edit = { messageId: need(data.id) };
  return { result: "event", event, partKey: null };
}

/** reaction.added: a tapback. Rosie's own (is_from_me) is kept with fromRosie true: the actor starts no turn for it. */
async function parseReaction(
  data: Json,
  input: ParseInput,
  eventId: string,
  lookups: ParseLookups,
): Promise<ParsedEvent> {
  const chatId = chatIdOf(data);
  const fromRosie = data.is_from_me === true;
  const from = isJson(data.from_handle) ? data.from_handle : {};
  const handle = fromRosie ? await receiptHandle(lookups, chatId) : phone(from.handle);
  const event = baseEvent(
    input,
    eventId,
    handle,
    requiredService(data.service ?? from.service),
    chatId,
    "reaction",
  );
  event.sentAt = utc(data.reacted_at);
  event.reaction = { reaction: need(data.reaction_type), onMessageId: need(data.message_id) };
  event.fromRosie = fromRosie;
  return { result: "event", event, partKey: null };
}

/** poll.vote.added and poll.vote.removed: a person's vote on one of Rosie's polls. */
async function parseVote(
  kind: "pollVote" | "voteRemoved",
  data: Json,
  input: ParseInput,
  eventId: string,
  createdAt: unknown,
  lookups: ParseLookups,
): Promise<ParsedEvent> {
  if (senderIsRosie(data)) return { result: "ignored" };
  const sender = obj(data.sender_handle);
  const pollId = need(data.message_id);
  const optionId = need(data.option_id);
  const words = await Promise.resolve()
    .then(() => lookups.optionWords?.(pollId, optionId))
    .then(
      (value) => value ?? null,
      () => null,
    );
  const poll: PollVoteFields = { pollId, optionId, optionWords: words ?? "" };
  const event = baseEvent(
    input,
    eventId,
    phone(sender.handle),
    requiredService(data.service ?? sender.service),
    chatIdOf(data),
    kind,
  );
  // The vote carries no time of its own: Linq's envelope time stands in for the send time.
  event.sentAt = utc(createdAt);
  event.poll = poll;
  return { result: "event", event, partKey: null };
}

/** Event types Rosie uses; every other signed type is ignored (K-11 README default 2). */
export const USED_EVENT_TYPES = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.failed",
  "message.edited",
  "reaction.added",
  "poll.vote.added",
  "poll.vote.removed",
  "poll.failed",
] as const;

/**
 * One signed Linq webhook body to a K-06 event (with the part key beside it), or ignored. `poll.updated` (options
 * someone added: K-11 README open gap 2) and `reaction.removed` map to nothing in v1 and are ignored.
 */
export async function parseLinqWebhook(input: ParseInput, lookups: ParseLookups = {}): Promise<ParsedEvent> {
  const body = input.body;
  if (!isJson(body)) return { result: "ignored", eventType: "unknown" };
  const eventType = text(body.event_type);
  if (eventType === undefined) return { result: "ignored", eventType: "unknown" };
  if (!(USED_EVENT_TYPES as readonly string[]).includes(eventType)) return { result: "ignored", eventType };
  if (body.webhook_version !== SUPPORTED_VERSION) throw new LinqWebhookError("unsupportedWebhookVersion");
  const eventId = need(body.event_id);
  const data = obj(body.data);

  let parsed: ParsedEvent;
  switch (eventType) {
    case "message.received":
      parsed = parseReceived(data, input, eventId);
      break;
    case "message.sent":
      parsed = await parseReceipt("sent", data, input, eventId, lookups);
      break;
    case "message.delivered":
      parsed = await parseReceipt("delivered", data, input, eventId, lookups);
      break;
    case "message.failed":
      parsed = await parseFailed(data, input, eventId, lookups);
      break;
    case "message.edited":
      parsed = parseEdited(data, input, eventId);
      break;
    case "reaction.added":
      parsed = await parseReaction(data, input, eventId, lookups);
      break;
    case "poll.vote.added":
      parsed = await parseVote("pollVote", data, input, eventId, body.created_at, lookups);
      break;
    case "poll.vote.removed":
      parsed = await parseVote("voteRemoved", data, input, eventId, body.created_at, lookups);
      break;
    default:
      parsed = await parsePollFailed(data, input, eventId, lookups);
  }
  return parsed.result === "ignored" ? { result: "ignored", eventType } : parsed;
}
