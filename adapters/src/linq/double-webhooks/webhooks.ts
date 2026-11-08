// The Linq double's signed webhooks (T-412; C-211; K-11 v1 `doubleWebhook`; build prompt 9.4). Test code only: it makes no
// network call, reads no key (the caller hands in a made-up whsec_ test secret), and logs nothing, so no body, phone
// number or secret leaves it. An error names a label, never a value.
//
// `sign` takes one K-06 v1 event (and the part key a receipt echoes) and gives the webhook Linq would send for it, in the
// 2026-02-03 form T-413's adapter reads: raw body, id, timestamp and the `v1,<base64>` signature under the shared signer.
// `verifyWebhook` on the result, inside the 300 s window, gives the same event back (the contract test's round trip).
//
// What a K-06 event cannot carry stays out of the body, and the adapter's lookups give it back (as for the real line):
//   - a receipt, Rosie's own reaction and a failed message carry the chat, not the person's number, so the adapter's
//     `chatHandle` lookup finds the person; the body holds Rosie's line as the sender (`rosieLine`);
//   - a vote carries the option's id, so the words come from the adapter's `optionWords` lookup.

import { signLinqWebhook } from "../../shared/hmac";
import type { DoubleEvent } from "../double/types";
import type { InboundEvent, LinqServiceName, VerifyWebhookRequest } from "../webhook/types";

/** The fictional block (+1 xxx 555 01xx) that adapters/src/shared/samples.ts also accepts. */
const FICTIONAL_PHONE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** Rosie's own line in the double: a fictional number, as the recorded samples use. */
export const DEFAULT_ROSIE_LINE = "+15555550199";

/** The default age of a stale webhook, in seconds: one past K-11's 300 s window. */
export const STALE_BY_SECONDS = 301;

/** A request the double cannot sign: a setup fault in the test, named by label. */
export class LinqDoubleWebhookError extends Error {
  override readonly name = "LinqDoubleWebhookError";
  readonly code:
    | "notLinq"
    | "notFictionalPhone"
    | "badTime"
    | "missingField"
    | "keyOnNonReceipt"
    | "fromRosieOnNonReaction"
    | "notAnImage"
    | "imageOnText"
    | "unknownKind";

  constructor(code: LinqDoubleWebhookError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface DoubleWebhookRequest {
  /** The K-06 v1 event the gateway must get back from verifyWebhook. */
  readonly event: InboundEvent;
  /** For a sent or delivered receipt, the part key it echoes; else null. */
  readonly partKey: string | null;
}

export interface SignOptions {
  /**
   * Sign the webhook outside the 300 s window, on request: true makes it STALE_BY_SECONDS old, a number sets the age in
   * seconds. The signature is still correct for that timestamp, so only the window fails it (verify-stale-timestamp).
   */
  readonly stale?: boolean | number;
}

export interface LinqWebhookDoubleOptions {
  /** The test environment's webhook secret, "whsec_" and base64. Never Linq's. */
  readonly secret: string;
  /** Rosie's own line, a fictional number. Default DEFAULT_ROSIE_LINE. */
  readonly rosieLine?: string;
}

/** What `echo` needs: Rosie's own words, as the line reports them back (Linq's is_me), which the adapter ignores. */
export interface RosieEchoRequest {
  readonly eventId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly service: LinqServiceName;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly traceId: string;
}

export interface LinqWebhookDouble {
  /** The signed webhook for one K-06 event, inside the window unless `stale` is asked for. */
  sign(request: DoubleWebhookRequest, options?: SignOptions): Promise<VerifyWebhookRequest>;
  /** The signed message.received that echoes Rosie's own words back with is_me true: never a customer event. */
  echo(request: RosieEchoRequest, options?: SignOptions): Promise<VerifyWebhookRequest>;
}

/** Where a double's faked event lands as a K-06 event: the facts a DoubleEvent does not hold. */
export interface DoubleEventContext {
  readonly eventId: string;
  readonly receivedAt: string;
  readonly traceId: string;
  /** The person's number: the chat's person (the voter of a vote is its own handle). */
  readonly handle: string;
  /** The chat. Required for a vote and a failure; a sent or delivered DoubleEvent holds its own. */
  readonly chatId?: string;
  readonly service?: LinqServiceName | null;
  /** The message a receipt or failure is for, when the DoubleEvent holds none (a part that failed with 4006). */
  readonly messageId?: string;
  /** A vote's option words, as K-06 carries them. Default "". */
  readonly optionWords?: string;
}

type Json = Record<string, unknown>;

const bad = (code: LinqDoubleWebhookError["code"]): LinqDoubleWebhookError =>
  new LinqDoubleWebhookError(code);

const SERVICE_NAMES: Readonly<Record<LinqServiceName, string>> = {
  imessage: "iMessage",
  rcs: "RCS",
  sms: "SMS",
};

function serviceName(service: LinqServiceName | null): string | null {
  return service === null ? null : SERVICE_NAMES[service];
}

function requiredServiceName(service: LinqServiceName | null): string {
  const name = serviceName(service);
  if (name === null) throw bad("missingField");
  return name;
}

function phone(value: string): string {
  if (!FICTIONAL_PHONE.test(value)) throw bad("notFictionalPhone");
  return value;
}

function utc(value: string | null): string {
  if (value === null || !UTC.test(value) || Number.isNaN(Date.parse(value))) throw bad("badTime");
  return value;
}

function present(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") throw bad("missingField");
  return value;
}

function epochSeconds(time: string): number {
  return Date.parse(utc(time)) / 1000;
}

/** A webhook for `event.kind`: Linq's event type, the envelope's own time, and the data object. */
interface Built {
  readonly type: string;
  readonly createdAt: string;
  readonly data: Json;
}

function rosieSender(rosieLine: string, service: LinqServiceName | null): Json {
  return { handle: rosieLine, is_me: true, service: serviceName(service) };
}

function buildReceived(event: InboundEvent): Built {
  const attachments = event.attachments;
  const hasImage = attachments.some((a) => /^image\//i.test(a.mediaType));
  if (event.kind === "photo" && !hasImage) throw bad("notAnImage");
  if (event.kind === "text" && hasImage) throw bad("imageOnText");
  const parts: Json[] = [];
  const words = event.body ?? "";
  if (words !== "") parts.push({ type: "text", value: words });
  for (const a of attachments) parts.push({ type: "media", id: a.attachmentId, mime_type: a.mediaType });
  const service = requiredServiceName(event.service);
  return {
    type: "message.received",
    createdAt: event.receivedAt,
    data: {
      chat: { id: present(event.chatId), is_group: false },
      id: present(event.messageId),
      direction: "inbound",
      sender_handle: { handle: phone(event.handle.address), is_me: false, service },
      parts,
      reply_to: event.threadedReplyTo === null ? null : { message_id: event.threadedReplyTo, part_index: 0 },
      sent_at: utc(event.sentAt),
      service,
    },
  };
}

function buildEdited(event: InboundEvent): Built {
  if (event.edit === null || event.body === null) throw bad("missingField");
  return {
    type: "message.edited",
    createdAt: event.receivedAt,
    data: {
      chat: { id: present(event.chatId), is_group: false },
      id: present(event.edit.messageId),
      direction: "inbound",
      sender_handle: {
        handle: phone(event.handle.address),
        is_me: false,
        service: requiredServiceName(event.service),
      },
      part: { index: 0, text: event.body },
      edited_at: utc(event.sentAt),
    },
  };
}

function buildReaction(event: InboundEvent, rosieLine: string): Built {
  if (event.reaction === null) throw bad("missingField");
  const from = event.fromRosie ? rosieLine : phone(event.handle.address);
  const service = requiredServiceName(event.service);
  return {
    type: "reaction.added",
    createdAt: event.receivedAt,
    data: {
      chat_id: present(event.chatId),
      message_id: event.reaction.onMessageId,
      part_index: 0,
      reaction_type: event.reaction.reaction,
      is_from_me: event.fromRosie,
      from: from,
      from_handle: { handle: from, is_me: event.fromRosie, service },
      service,
      reacted_at: utc(event.sentAt),
    },
  };
}

function buildVote(event: InboundEvent): Built {
  if (event.poll === null) throw bad("missingField");
  const service = requiredServiceName(event.service);
  return {
    type: event.kind === "voteRemoved" ? "poll.vote.removed" : "poll.vote.added",
    // The adapter reads a vote's time from the envelope (the vote carries none of its own).
    createdAt: utc(event.sentAt),
    data: {
      message_id: event.poll.pollId,
      direction: "inbound",
      chat: { id: present(event.chatId), is_group: false },
      sender_handle: { handle: phone(event.handle.address), is_me: false, service },
      option_id: event.poll.optionId,
      service,
    },
  };
}

function buildReceipt(event: InboundEvent, partKey: string | null, rosieLine: string): Built {
  if (event.status === null) throw bad("missingField");
  const delivered = event.kind === "delivered";
  const at = utc(event.status.at);
  const service = serviceName(event.service);
  return {
    type: delivered ? "message.delivered" : "message.sent",
    createdAt: event.receivedAt,
    data: {
      chat: { id: present(event.chatId), is_group: false },
      id: event.status.messageId,
      direction: "outbound",
      sender_handle: rosieSender(rosieLine, event.service),
      parts: [],
      idempotency_key: partKey,
      sent_at: at,
      delivered_at: delivered ? at : null,
      read_at: null,
      service,
    },
  };
}

/** Linq code as it comes: a number when the code is digits, else the text. */
function linqCode(code: string | null): number | string | null {
  if (code === null) return null;
  return /^[0-9]+$/.test(code) ? Number(code) : code;
}

function buildFailed(event: InboundEvent): Built {
  const status = event.status;
  const failure = status?.failure;
  if (status === null || failure === null || failure === undefined) throw bad("missingField");
  const failedAt = utc(status.at);
  const common = {
    message_id: status.messageId,
    service: serviceName(event.service),
    failed_at: failedAt,
  };
  // K-06 holds one `failed` kind for both Linq events; the reason tells them apart (the adapter writes "poll failed").
  if (failure.reason === "poll failed") {
    return {
      type: "poll.failed",
      createdAt: event.receivedAt,
      data: {
        message_id: common.message_id,
        direction: "outbound",
        chat: { id: present(event.chatId), is_group: false },
        sender_handle: null,
        poll: { options: [], total_voters: 0 },
        service: common.service,
        error: { code: linqCode(failure.code), message: "Message send failed" },
        failed_at: common.failed_at,
      },
    };
  }
  return {
    type: "message.failed",
    createdAt: event.receivedAt,
    data: {
      chat_id: present(event.chatId),
      message_id: common.message_id,
      code: linqCode(failure.code),
      reason: failure.reason,
      service: common.service,
      failed_at: common.failed_at,
    },
  };
}

function build(request: DoubleWebhookRequest, rosieLine: string): Built {
  const { event, partKey } = request;
  // A test may hand in any value, whatever the type says.
  if ((event.provider as string) !== "linq") throw bad("notLinq");
  if (partKey !== null && event.kind !== "sent" && event.kind !== "delivered") throw bad("keyOnNonReceipt");
  // Only a reaction carries fromRosie true (T-413's parse); Rosie's own words are made by `echo`, as is_me.
  if (event.fromRosie && event.kind !== "reaction") throw bad("fromRosieOnNonReaction");
  // Every kind names a test phone: a number outside 555-01xx never reaches a body.
  phone(event.handle.address);
  switch (event.kind) {
    case "text":
    case "photo":
      return buildReceived(event);
    case "edit":
      return buildEdited(event);
    case "reaction":
      return buildReaction(event, rosieLine);
    case "pollVote":
    case "voteRemoved":
      return buildVote(event);
    case "sent":
    case "delivered":
      return buildReceipt(event, partKey, rosieLine);
    case "failed":
      return buildFailed(event);
    default:
      throw bad("unknownKind");
  }
}

/** The double that makes signed webhooks. Each call counts its own envelope trace id, so a test reads them in order. */
export function createLinqWebhookDouble(options: LinqWebhookDoubleOptions): LinqWebhookDouble {
  const rosieLine = phone(options.rosieLine ?? DEFAULT_ROSIE_LINE);
  let serial = 0;

  async function envelope(
    eventId: string,
    receivedAt: string,
    traceId: string,
    built: Built,
    signOptions: SignOptions,
  ): Promise<VerifyWebhookRequest> {
    serial += 1;
    const body = {
      api_version: "v3",
      webhook_version: "2026-02-03",
      event_type: built.type,
      event_id: present(eventId),
      created_at: utc(built.createdAt),
      trace_id: `linq-trace-double-${String(serial).padStart(4, "0")}`,
      partner_id: "partner-double",
      data: built.data,
    };
    const raw = JSON.stringify(body);
    // The window runs from the gateway's receipt time: the timestamp is that moment, or older when asked.
    const age =
      signOptions.stale === undefined || signOptions.stale === false
        ? 0
        : signOptions.stale === true
          ? STALE_BY_SECONDS
          : signOptions.stale;
    const timestamp = String(epochSeconds(receivedAt) - age);
    return {
      webhookId: eventId,
      timestamp,
      signature: await signLinqWebhook(options.secret, eventId, timestamp, raw),
      raw,
      receivedAt,
      traceId,
    };
  }

  return {
    // async, so a request the double cannot sign rejects, whatever the call shape.
    async sign(request, signOptions = {}) {
      const built = build(request, rosieLine);
      const { event } = request;
      return envelope(event.eventId, event.receivedAt, event.traceId, built, signOptions);
    },
    async echo(request, signOptions = {}) {
      const service = serviceName(request.service);
      const built: Built = {
        type: "message.received",
        createdAt: request.receivedAt,
        data: {
          chat: { id: present(request.chatId), is_group: false },
          id: present(request.messageId),
          direction: "outbound",
          sender_handle: rosieSender(rosieLine, request.service),
          parts: [{ type: "text", value: request.text }],
          reply_to: null,
          sent_at: utc(request.sentAt),
          service,
        },
      };
      return envelope(request.eventId, request.receivedAt, request.traceId, built, signOptions);
    },
  };
}

/**
 * A faked event of the Linq double (T-411's fakeSent, fakeDelivered, fakePollVote, fakeFailure) as the K-06 event and
 * part key `sign` takes: the facts the faked event does not hold come from `context`.
 */
export function eventFromDoubleEvent(event: DoubleEvent, context: DoubleEventContext): DoubleWebhookRequest {
  const base = {
    eventId: context.eventId,
    provider: "linq" as const,
    handle: { kind: "phone" as const, address: context.handle },
    service: context.service === undefined ? ("imessage" as const) : context.service,
    messageId: null,
    sentAt: null,
    receivedAt: context.receivedAt,
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
    traceId: context.traceId,
  };
  switch (event.kind) {
    case "sent":
    case "delivered": {
      const messageId = event.messageId ?? context.messageId ?? null;
      if (messageId === null) throw bad("missingField");
      return {
        event: {
          ...base,
          kind: event.kind,
          chatId: event.chatId,
          status: { messageId, at: event.at, failure: null },
        },
        partKey: event.partKey,
      };
    }
    case "pollVote":
      return {
        event: {
          ...base,
          kind: event.removed ? "voteRemoved" : "pollVote",
          handle: { kind: "phone", address: event.voter },
          chatId: present(context.chatId),
          sentAt: event.at,
          poll: {
            pollId: event.messageId,
            optionId: event.optionId,
            optionWords: context.optionWords ?? "",
          },
        },
        partKey: null,
      };
    case "failed": {
      const messageId = event.messageId ?? context.messageId ?? null;
      if (messageId === null) throw bad("missingField");
      return {
        event: {
          ...base,
          kind: "failed",
          chatId: present(context.chatId),
          status: { messageId, at: event.at, failure: { code: event.code, reason: event.reason } },
        },
        partKey: null,
      };
    }
  }
}
