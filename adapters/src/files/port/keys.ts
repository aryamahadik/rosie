// Object keys, days and hashes (T-437; K-13 v1 README "The object key", default 2). The port makes every key:
// `<kind>/<day>/<id>`, the kind the file's, the day the UTC day the key was made (for the event-log export, the day of
// its rows), the id 26 lowercase letters and digits from a cryptographically secure random source. So a key never holds
// a name, a number, an address or anyone's words, and is never guessable from a row id.
//
// Web Crypto only, so it runs in a Worker (T-438) and under Node (the double, the tests).

import type { FileKind, ObjectKey } from "./types";

/** The 36 symbols of an id: digits and lowercase letters. */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** An id's length: 26 symbols of 36 hold log2(36) * 26, about 134 bits, so at least the README's 128. */
export const KEY_ID_LENGTH = 26;
/** The largest multiple of 36 that fits in a byte: bytes at or above it are dropped, so every symbol is equally likely. */
const UNBIASED_LIMIT = 252;

export const FILE_KINDS: readonly FileKind[] = [
  "idDocument",
  "photo",
  "priceList",
  "form",
  "signedDocument",
  "licenseFile",
  "sealedTrace",
  "eventLogExport",
  "export",
  "report",
];

const KEY_ID = /^[a-z0-9]{26}$/;
const DAY = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]+))?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * A new key id or writeId: 26 lowercase letters and digits from crypto.getRandomValues, by rejection sampling so no
 * symbol is likelier than another. A writer (C-017, C-037, C-207) makes its writeId with it once per object and keeps it
 * for every retry.
 */
export function newKeyId(): string {
  let id = "";
  const bytes = new Uint8Array(KEY_ID_LENGTH * 2);
  while (id.length < KEY_ID_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      id += ALPHABET.charAt(byte % ALPHABET.length);
      if (id.length === KEY_ID_LENGTH) break;
    }
  }
  return id;
}

/** True for an id in the key's form: 26 lowercase letters and digits (K-13 v1 `writeId`). */
export function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID.test(value);
}

/** True for a day in the schema's form that exists in the calendar (the schema leaves "whether the day exists" to code). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [, year = "", month = "", day = ""] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/** True for an RFC 3339 UTC time ending in Z whose date and time exist (common `utc`, and the code check it leaves). */
export function isUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC.exec(value);
  if (match === null) return false;
  const [, year = "", month = "", day = "", hours = "", minutes = "", seconds = ""] = match;
  return (
    isDay(`${year}-${month}-${day}`) && Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59
  );
}

/** True for a sha256 in lowercase hex (K-01 v1 `sha256`). */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

/** The UTC day of an instant, YYYY-MM-DD. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** An instant as K-13's answers write it: RFC 3339 UTC, whole seconds. */
export function utcSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The key `<kind>/<day>/<id>`. Throws a TypeError naming the part at fault, never its value. */
export function objectKeyOf(kind: FileKind, day: string, id: string): ObjectKey {
  if (!FILE_KINDS.includes(kind)) throw new TypeError("objectKeyOf: the kind is not a K-13 v1 file kind");
  if (!isDay(day)) throw new TypeError("objectKeyOf: the day is not a calendar day");
  if (!isKeyId(id)) throw new TypeError("objectKeyOf: the id is not 26 lowercase letters and digits");
  return `${kind}/${day}/${id}`;
}

/** A key's parts, or null when it is not a key in K-13 v1's form on a calendar day. */
export function parseObjectKey(value: unknown): { kind: FileKind; day: string; id: string } | null {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const [kind = "", day = "", id = ""] = parts;
  const known = FILE_KINDS.find((candidate) => candidate === kind);
  if (known === undefined || !isDay(day) || !isKeyId(id)) return null;
  return { kind: known, day, id };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The sha256 of some bytes, lowercase hex, by Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy on its own ArrayBuffer, which is what Web Crypto takes.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return toHex(new Uint8Array(digest));
}
