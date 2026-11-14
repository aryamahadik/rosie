// The hashes and ids a sign-in's start makes (ADR-016 section 4; K-22 v1.2 rule 9 "The hashes" and default 14; K-05 v1.13
// startSignIn.request; DL-546, DL-610). Web Crypto only, so the same code runs in Node and workerd. Nothing here logs,
// and no error carries a value, a hash or an id.
//
//   - device_sha256  = sha256(the device cookie as sent): the attempt is bound to it, and the cookie never leaves.
//   - request_sha256 = sha256(device_sha256 LF page.requestId): the start's repeat key, so the same requestId from
//                      another browser never matches.
//   - contact_hash   = HMAC-SHA-256 through the root's hashing port (PROOF_CODE_HASH_KEY, read by name in the root; the
//                      action layer reads no key) over "rosie-sign-in-contact" LF kind LF contact, the kind email,
//                      mobile or link; never the contact itself. A code's own HMAC message (proof-codes/hashing.ts) begins
//                      with its own prefix, so under the one key a contact's hash and a code's never share a message.
//   - the start's two ids, each from 16 bytes (128 bits) of Web Crypto's generator, in base64url (22 characters of
//     A-Z a-z 0-9 - _), behind a fixed word, so each is a K-08 safe id that never reads as a number: `id`, the attempt's
//     server id and the job id of its code's rows and entries, which never reaches the page; and `attemptId`, the one id
//     the page holds (K-21 default 18). Neither is made from the contact, the device, the request or the time.

import { HASH_FORM, isKeyName, sha256Hex, type KeyedHash, type RandomFill } from "../../domain/proof-codes";
import { SignInError } from "./errors";
import type { ReadContact } from "./request";

/** K-22 rule 9's fixed prefix of a contact's HMAC message (default 14). */
export const CONTACT_HASH_PREFIX = "rosie-sign-in-contact";

/** The random bytes behind each id a start makes: 128 bits (DL-546; K-21 default 18). */
export const ID_RANDOM_BYTES = 16;

/** The fixed words before each id's random part: letters, so the id starts with one and never reads as a number. */
export const ATTEMPT_SERVER_ID_PREFIX = "sign-in-";
export const ATTEMPT_ID_PREFIX = "attempt-";

/** Bytes as base64url with no padding (RFC 4648 section 5). */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** One id: the prefix and ID_RANDOM_BYTES fresh bytes from `random`, in base64url. */
export function randomId(prefix: string, random: RandomFill): string {
  const bytes = new Uint8Array(ID_RANDOM_BYTES);
  random(bytes);
  return `${prefix}${base64Url(bytes)}`;
}

/** The start's two ids: the attempt's server id and the page's attempt id, each drawn on its own. */
export interface StartIds {
  readonly id: string;
  readonly attemptId: string;
}

export function drawStartIds(random: RandomFill): StartIds {
  return {
    id: randomId(ATTEMPT_SERVER_ID_PREFIX, random),
    attemptId: randomId(ATTEMPT_ID_PREFIX, random),
  };
}

/** sha256 of the device cookie as sent (K-22 sign_in_attempts.device_sha256). */
export function deviceSha256Of(deviceToken: string): Promise<string> {
  return sha256Hex(deviceToken);
}

/** The start's repeat key (K-22 sign_in_attempts.request_sha256): sha256 of the device's sha256, a line feed, requestId. */
export function requestSha256Of(deviceSha256: string, requestId: string): Promise<string> {
  return sha256Hex(`${deviceSha256}\n${requestId}`);
}

/**
 * The contact's keyed hash (K-22 sign_in_attempts.contact_hash) through the root's port. A port that names no secret or
 * answers anything but 64 lower-case hex digits is refused before anything is written (fail closed).
 */
export async function contactHashOf(hash: KeyedHash, contact: ReadContact): Promise<string> {
  if (!isKeyName(hash.keyName)) throw new SignInError("noHashKey");
  const hex = await hash.hmacHex(`${CONTACT_HASH_PREFIX}\n${contact.kind}\n${contact.hashed}`);
  if (!HASH_FORM.test(hex)) throw new SignInError("noHashKey");
  return hex;
}
