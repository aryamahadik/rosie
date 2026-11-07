// The webhook adapter's types (T-413; K-11 v1 verifyWebhook; K-06 v1). They mirror the contracts' shapes by hand, as the
// Linq double's types do, because the generated contract types are git-ignored (ADR-005).

export type LinqServiceName = "imessage" | "rcs" | "sms";

export interface Attachment {
  attachmentId: string;
  mediaType: string;
}

export interface PollVoteFields {
  pollId: string;
  optionId: string;
  optionWords: string;
}

/** K-06 v1's inbound event, for a Linq event. */
export interface InboundEvent {
  eventId: string;
  provider: "linq";
  handle: { kind: "phone"; address: string };
  service: LinqServiceName | null;
  kind: "text" | "photo" | "reaction" | "pollVote" | "voteRemoved" | "edit" | "delivered" | "sent" | "failed";
  messageId: string | null;
  chatId: string | null;
  sentAt: string | null;
  receivedAt: string;
  body: string | null;
  scrubbed: { cards: number; ssns: number };
  attachments: Attachment[];
  threadedReplyTo: string | null;
  poll: PollVoteFields | null;
  reaction: { reaction: string; onMessageId: string } | null;
  edit: { messageId: string } | null;
  status: {
    messageId: string;
    at: string;
    failure: { code: string | null; reason: string } | null;
  } | null;
  fromRosie: boolean;
  email: null;
  traceId: string;
}

/** K-11 v1 `verifyWebhook.request`: one webhook before any parsing. */
export interface VerifyWebhookRequest {
  webhookId: string;
  timestamp: string;
  signature: string;
  raw: string;
  receivedAt: string;
  traceId: string;
}

/** K-11 v1 `verifyWebhook` answers (`rejected` is answered 401 by the gateway). */
export type VerifyWebhookResult =
  | { result: "event"; httpStatus: 200; event: InboundEvent; partKey: string | null }
  | { result: "ignored"; httpStatus: 200; eventType: string }
  | { result: "rejected"; httpStatus: 401; reason: "badTimestamp" | "staleTimestamp" | "badSignature" };

/** What the parse gives before the port wraps it: an event with its part key, or ignored (the type is filled by the parse). */
export type ParsedEvent =
  | { result: "event"; event: InboundEvent; partKey: string | null }
  | { result: "ignored"; eventType?: string };
