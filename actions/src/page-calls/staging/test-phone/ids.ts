// The ids a test-phone send makes (CQ-09: opaque, made by code, never parsed), and the sha256 the server keeps of a
// session token (K-22 v1 sessions.token_sha256: lower-case hex). WebCrypto, so the same code runs in Node and workerd.

import type { SendIdInput, SendIds } from "./types";

const HEX_DIGITS = 32;

/** The sha256 of the text's UTF-8 bytes, as lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The default ids of one send. The event's and the inbound message's ids come from the sha256 of the session token's hash
 * and the page's requestId, the key a repeat is known by within the credential it came with (K-21 v1 page.requestId): a
 * repeat of one submit sends the same event id, which the gateway drops as known (arch 02 line 109; K-21 README
 * "testPhoneSend": "the gateway drops a known event id"), in any isolate, while two submits, or one id from two sessions,
 * never share one. The chat's id comes from the roster's id for the phone, so every send as one phone lands in one chat.
 * None carries a number, a word or the token.
 */
export async function defaultSendIds(input: SendIdInput): Promise<SendIds> {
  const send = (await sha256Hex(`${input.tokenSha256}\n${input.requestId}`)).slice(0, HEX_DIGITS);
  const chat = (await sha256Hex(`test-phone\n${input.phone.testPhoneId}`)).slice(0, HEX_DIGITS);
  return {
    eventId: `evt-test-phone-${send}`,
    messageId: `linq-msg-test-phone-in-${send}`,
    chatId: `linq-chat-test-phone-${chat}`,
  };
}
