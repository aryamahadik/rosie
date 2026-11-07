// HMAC-SHA256 signature helper (T-410; K-11 "Verify and parse a webhook": HMAC over id.ts.raw with a 300 s window; the
// other signed webhooks, Stripe's and Resend's, use the same primitive with their own signed string).
//
// Web Crypto only, so it runs in a Worker and under Node. The secret is passed in by the caller, read from the
// environment at run time; this file holds none and never logs or returns one. Comparison is Web Crypto's own
// constant-time verify, so a changed byte is refused without a timing signal.

const encoder = new TextEncoder();

/** The default signing window, in seconds (K-11: a 300 s window). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const HEX = /^(?:[0-9a-fA-F]{2})+$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!HEX.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/** The HMAC-SHA256 of `message` under `secret`, as lowercase hex. */
export async function signHmacSha256(secret: string, message: string): Promise<string> {
  const key = await importKey(secret, "sign");
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/**
 * True only when `signatureHex` (either case) is the HMAC-SHA256 of `message` under `secret`. A signature that is not
 * hex, or is the wrong length, or differs in any byte, is false. Never throws on a bad signature.
 */
export async function verifyHmacSha256(
  secret: string,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = fromHex(signatureHex);
  if (signature === undefined) return false;
  const key = await importKey(secret, "verify");
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}

/** The string a Linq-style webhook signs: id, timestamp and the raw body, joined by dots (K-11). */
export function signedWebhookString(id: string, timestamp: string, raw: string): string {
  return `${id}.${timestamp}.${raw}`;
}

export interface WebhookSignatureInput {
  readonly secret: string;
  readonly id: string;
  /** The timestamp header as sent: whole seconds since 1970. */
  readonly timestamp: string;
  /** The body exactly as received, before any parsing. */
  readonly raw: string;
  /** The signature header, hex. */
  readonly signature: string;
  /** Now, in milliseconds (a test gives its own clock). */
  readonly nowMs: number;
  /** The window either side of now, in seconds. Default 300. */
  readonly toleranceSeconds?: number;
}

export type WebhookSignatureResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "badTimestamp" | "staleTimestamp" | "badSignature" };

/**
 * Checks a webhook: the timestamp is whole seconds and within the window, then the signature over id.timestamp.raw.
 * The reason names the failure by a label only: no key, body or signature value.
 */
export async function verifyWebhookSignature(input: WebhookSignatureInput): Promise<WebhookSignatureResult> {
  if (!/^\d{1,15}$/.test(input.timestamp)) return { valid: false, reason: "badTimestamp" };
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowMs / 1000 - Number(input.timestamp)) > tolerance)
    return { valid: false, reason: "staleTimestamp" };
  const ok = await verifyHmacSha256(
    input.secret,
    signedWebhookString(input.id, input.timestamp, input.raw),
    input.signature,
  );
  return ok ? { valid: true } : { valid: false, reason: "badSignature" };
}

// Linq's real scheme (K-11 v1 README spike rows 2 and 3; T-020; T-1075). The hex form above stays for any port that
// signs that way; Linq does not: it signs "v1,<base64>" over {id}.{timestamp}.{raw} (the same signed string) under the
// key bytes that follow the secret's "whsec_" prefix, base64-decoded. The header may hold several space-separated
// entries (key rotation); one match passes.

const WHSEC_PREFIX = "whsec_";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text === "" || !BASE64.test(text)) return undefined;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importLinqKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey | undefined> {
  if (!secret.startsWith(WHSEC_PREFIX)) return undefined;
  const keyBytes = fromBase64(secret.slice(WHSEC_PREFIX.length));
  if (keyBytes === undefined) return undefined;
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * The `webhook-signature` header value Linq's scheme gives for this webhook: "v1," and the base64 HMAC-SHA256 of
 * id.timestamp.raw under the decoded key. For the double (C-211) and tests. Throws only when `secret` is not
 * "whsec_" plus base64, which is a setup fault, never webhook input.
 */
export async function signLinqWebhook(
  secret: string,
  id: string,
  timestamp: string,
  raw: string,
): Promise<string> {
  const key = await importLinqKey(secret, "sign");
  if (key === undefined) throw new Error("The Linq webhook secret must be whsec_ followed by base64.");
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedWebhookString(id, timestamp, raw)));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/**
 * Checks a Linq webhook: the timestamp is whole seconds and within the window, then any one "v1,<base64>" entry of
 * the space-separated header matches the HMAC over id.timestamp.raw (constant-time verify). A bare hex signature,
 * an entry without "v1,", a secret that is not whsec_ plus base64, or any changed byte is badSignature. Never throws
 * on webhook input and never returns or logs the secret.
 */
export async function verifyLinqWebhookSignature(
  input: WebhookSignatureInput,
): Promise<WebhookSignatureResult> {
  if (!/^\d{1,15}$/.test(input.timestamp)) return { valid: false, reason: "badTimestamp" };
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowMs / 1000 - Number(input.timestamp)) > tolerance)
    return { valid: false, reason: "staleTimestamp" };
  const bad = { valid: false, reason: "badSignature" } as const;
  let key: CryptoKey | undefined;
  try {
    key = await importLinqKey(input.secret, "verify");
  } catch {
    return bad;
  }
  if (key === undefined) return bad;
  const message = encoder.encode(signedWebhookString(input.id, input.timestamp, input.raw));
  let matched = false;
  for (const entry of input.signature.split(/\s+/)) {
    if (!entry.startsWith("v1,")) continue;
    const signature = fromBase64(entry.slice(3));
    if (signature === undefined) continue;
    // Every entry is checked, so the time does not show which one matched.
    if (await crypto.subtle.verify("HMAC", key, signature, message)) matched = true;
  }
  return matched ? { valid: true } : bad;
}
