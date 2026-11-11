// A number's text opens its chat at receipt (T-1213; C-044; K-05 v1.7 README item 46, "Who calls it, and when" and "What
// the two new tasks must hold to"; defaults 70, 71, 76 and 77; QUESTIONS.md CQ-194, CQ-196). The gateway calls K-05 v1.7
// openChatOnText before anything is written for the text, so a first text's checked safety line and its STOP meet an
// open chat and a phone row (item 46, reasons 1 and 2).
//
// Which texts (default 71): a text or photo a phone handle sends through Linq (K-06 v1 provider linq, handle kind phone,
// kind text or photo, fromRosie false). Never an email handle, a reaction, a vote, an edit or a receipt, which open no
// mobile's chat.
//
// When: after the scrub and the key call (K-05 v1.2 handleSealingKey, which answers the handle's K-04 id: ./hand-off.ts),
// and before the sealed text reaches the handle's actor (./linq-webhook.ts). Once per webhook: a repeat is K-05's to
// answer, by the text's event id (repeated, nothing written: default 76).
//
// The request: the key call's handle id and, from the K-06 event, its id, service, receivedAt and trace. Never the
// number: K-05 reads it from the handle's own row.
//
// What each answer does (default 77; the card's "Gives"):
//   - inserted, opened, alreadyOpen, stopped, repeated: the text goes on to its actor;
//   - notFound, notAPhone (the caller's fault, never the person's): the text is stored all the same, so a refusal never
//     keeps it from being received and read for safety; rows to the number wait for the chat (limit 8 fails closed); the
//     refusal is the receive span's error code;
//   - transient, or no answer (the port throws: a database error K-05 names no answer for, a port closed or with no
//     database bound): 503, nothing stored, and Linq's retry is a repeat.
// A call the gateway cannot make as K-05 takes it is never sent, and the text is stored as a refusal is: no handle id
// (a key store that knows none: noHandleId), or a request K-05 would refuse before reading anything (an event id that is
// not a K-08 safe id, a service Linq does not name, a receipt time that is not one: chatRequestRefused). Each would be
// the same at every one of Linq's retries, so a 503 for it would keep the text from its safety read for good (CQ-196).
//
// Nothing here logs, and nothing it answers holds the number or the chat id.

import { isLabel } from "../trace";
import type { ChatOpenPort, ChatOpenRequest, InboundEvent } from "./types";

/** K-06 v1 kinds that open a chat: a person's own text or photo (default 71). */
export const CHAT_KINDS: readonly string[] = ["text", "photo"];

/** The services Linq reports for a text (K-06 v1 service; K-05 v1.7 textService). */
export const TEXT_SERVICES: readonly string[] = ["imessage", "rcs", "sms"];

/** The receive span's error code for a text whose key call gave no handle id: stored, its chat not opened. */
export const NO_HANDLE_ID = "noHandleId";

/** The receive span's error code for a request K-05 would refuse before reading anything: stored, its chat not opened. */
export const CHAT_REQUEST_REFUSED = "chatRequestRefused";

/** K-05 v1.7 openChatOnText's five results: each lets the text go on to its actor (item 46). */
const RESULTS: readonly string[] = ["inserted", "opened", "alreadyOpen", "stopped", "repeated"];

/** K-05's refusals of a request it takes: notFound and notAPhone (item 46, "Who calls it, and when"). */
const REFUSALS: readonly string[] = ["notFound", "notAPhone"];

/** common/formats.v1 utc: an RFC 3339 instant in UTC, ending in Z. */
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$/;

/** An answer the gateway does not know: no answer, so the gateway answers 503. Names no value. */
export class ChatOpenError extends Error {
  constructor(what: string) {
    super(`openChatOnText gave no answer the gateway knows: ${what}`);
    this.name = "ChatOpenError";
  }
}

/** What opening the chat at receipt came to. */
export type ChatAtReceipt =
  /** No call: the event opens no chat, or no chat port is bound. */
  | { readonly kind: "none" }
  /** One of K-05's five results: the text goes on to its actor. */
  | { readonly kind: "answered"; readonly result: string }
  /** A refusal, or a call that could not be made: the text is stored all the same, `code` on its receive span. */
  | { readonly kind: "refused"; readonly code: string }
  /** transient: nothing was written; the gateway answers 503 and stores nothing. */
  | { readonly kind: "transient" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True for a text or photo a phone handle sent through Linq (default 71): the events that open a number's chat. */
export function opensChat(event: InboundEvent): boolean {
  const handle: unknown = event.handle;
  return (
    event.provider === "linq" &&
    isRecord(handle) &&
    handle.kind === "phone" &&
    CHAT_KINDS.includes(event.kind) &&
    event.fromRosie === false
  );
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** The request for a text: the key call's handle id and the event's own id, service, receipt time and trace. */
export function chatRequestOf(event: InboundEvent, handleId: string): ChatOpenRequest {
  return {
    eventId: textOf(event.eventId),
    handleId,
    service: textOf(event.service),
    receivedAt: textOf(event.receivedAt),
    traceId: textOf(event.traceId),
  };
}

/**
 * True when K-05 would refuse the request before reading anything (db/repo/chat-open.ts's own checks): the event id and
 * the handle id K-08 safe ids, never reading as a number; Linq's three services; a UTC time; a non-empty trace id.
 */
export function isRefusedRequest(request: ChatOpenRequest): boolean {
  const { eventId, handleId, service, receivedAt, traceId } = request;
  const takes =
    isLabel(eventId) &&
    isLabel(handleId) &&
    TEXT_SERVICES.includes(service) &&
    UTC.test(receivedAt) &&
    !Number.isNaN(Date.parse(receivedAt)) &&
    traceId !== "" &&
    !traceId.includes("\u0000");
  return !takes;
}

/** K-05's answer as the gateway acts on it; one it does not know is no answer (ChatOpenError: 503). */
function readAnswer(answer: unknown): ChatAtReceipt {
  if (isRecord(answer)) {
    const { result, error } = answer;
    if (typeof result === "string" && RESULTS.includes(result)) return { kind: "answered", result };
    if (typeof error === "string" && REFUSALS.includes(error)) return { kind: "refused", code: error };
    if (error === "transient") return { kind: "transient" };
  }
  throw new ChatOpenError("an answer that is none of its results or errors");
}

/**
 * Opens the chat of a text's number at receipt (K-05 v1.7 item 46) through `chats`, with the handle's K-04 id the key
 * call answered (null when it gave none). A port that throws is no answer: the throw goes to the caller, which answers
 * 503 and stores nothing.
 */
export async function openChatAtReceipt(
  chats: ChatOpenPort | undefined,
  event: InboundEvent,
  handleId: string | null,
): Promise<ChatAtReceipt> {
  if (chats === undefined || !opensChat(event)) return { kind: "none" };
  if (handleId === null) return { kind: "refused", code: NO_HANDLE_ID };
  const request = chatRequestOf(event, handleId);
  if (isRefusedRequest(request)) return { kind: "refused", code: CHAT_REQUEST_REFUSED };
  return readAnswer(await chats.openChatOnText(request));
}
