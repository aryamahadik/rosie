// Sam's JOIN, the walking skeleton's one text (D-017's human test; S1-01), shared by the skeleton's two files: the K-06 check
// in Node (./skeleton.test.ts) and the run inside workerd (./skeleton.worker.test.ts).

import type { InboundEvent } from "../../../adapters/src/linq/webhook/types";

/**
 * Sam's JOIN: test owner 1's first text, how the sign-up link starts an owner's chat (D-017's human test; S1-01), as
 * one K-06 v1 event. The master's sample cast, never a real person: its ids are K-08 trace-skeleton.json's
 * (evt-sam-0000, trace-sam-0000), its number is test owner 1's on K-21 test-roster.json (tp-01, Sam, the fictional
 * 555-0100, the handle T-1148's seed writes), its chat is Sam's (linq-chat-demo-sam), and every other field takes K-06
 * text-imessage.json's form.
 */
export const JOIN: InboundEvent = {
  eventId: "evt-sam-0000",
  provider: "linq",
  handle: { kind: "phone", address: "+15555550100" },
  service: "imessage",
  kind: "text",
  messageId: "linq-msg-demo-in-sam-0000",
  chatId: "linq-chat-demo-sam",
  sentAt: "2026-10-19T14:01:49Z",
  receivedAt: "2026-10-19T14:01:50Z",
  body: "JOIN",
  scrubbed: { cards: 0, ssns: 0 },
  attachments: [],
  threadedReplyTo: null,
  poll: null,
  reaction: null,
  edit: null,
  status: null,
  fromRosie: false,
  email: null,
  traceId: "trace-sam-0000",
};
