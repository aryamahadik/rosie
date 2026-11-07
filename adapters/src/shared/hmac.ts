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
