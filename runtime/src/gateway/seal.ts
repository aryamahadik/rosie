// Sealing the event's words (T-243; C-044; arch 02 step 1 "writes the sealed event to the handle's actor", line 109;
// NQ-RT-1 default: the gateway seals under the handle's key, made on first sight and linked to the person once known).
//
// The sealed form that is stored (`SealedBox`): AES-256-GCM through WebCrypto, a fresh random 96-bit IV per seal, the
// cipher text and its 128-bit tag as one base64 string. The additional data binds the box to its handle and event
// (`${actor name}|${event id}`), so a box copied onto another event or handle fails to open. What is sealed is one JSON
// text, {"body": ..., "subject": ...}: the words after the scrub, and an email's subject.
//
// The key comes through a key-store interface (the real call is K-05 v1.2's "get or create a handle's sealing key",
// T-072, served by T-220; it joins at D-017). Never logged, put in a span or answered: a key, a plain body.

/** A handle as K-06 and K-04 write it: the phone in E.164 or the email in lower case. */
export interface HandleRef {
  readonly kind: string;
  readonly address: string;
}

/**
 * The handle's sealing key store. `getOrCreateKey` answers the handle's 32-byte data key (AES-256), making it on first
 * sight. A throw means no key: the gateway answers 503 and writes nothing.
 */
export interface SealingKeyStore {
  getOrCreateKey(handle: HandleRef): Promise<Uint8Array>;
}

/** The sealed form stored in place of the words. */
export interface SealedBox {
  readonly v: 1;
  readonly alg: "A256GCM";
  /** The 12-byte IV, base64. */
  readonly iv: string;
  /** The cipher text with its 16-byte tag, base64. */
  readonly ct: string;
}

/** What a box holds once opened. */
export interface SealedWords {
  readonly body: string | null;
  readonly subject: string | null;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The name of the handle's Durable Object: one actor per handle, the same name for every event of the handle. */
export function actorNameOf(handle: HandleRef): string {
  return `${handle.kind}:${handle.address}`;
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let k = 0; k < raw.length; k += 1) bytes[k] = raw.charCodeAt(k);
  return bytes;
}

function additionalData(actorName: string, eventId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${actorName}|${eventId}`));
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.byteLength !== KEY_BYTES) throw new Error("sealing key has the wrong length");
  return crypto.subtle.importKey("raw", Uint8Array.from(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals the words under the key. */
export async function sealWords(
  words: SealedWords,
  key: Uint8Array,
  actorName: string,
  eventId: string,
): Promise<SealedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify({ body: words.body, subject: words.subject }));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(actorName, eventId), tagLength: 128 },
    await importKey(key),
    plain,
  );
  return { v: 1, alg: "A256GCM", iv: toBase64(iv), ct: toBase64(new Uint8Array(cipher)) };
}

/** Opens a box; throws when the key, the actor name or the event id is not the one it was sealed with. */
export async function openWords(
  box: SealedBox,
  key: Uint8Array,
  actorName: string,
  eventId: string,
): Promise<SealedWords> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(box.iv),
      additionalData: additionalData(actorName, eventId),
      tagLength: 128,
    },
    await importKey(key),
    fromBase64(box.ct),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as {
    body: string | null;
    subject: string | null;
  };
  return { body: parsed.body, subject: parsed.subject };
}
