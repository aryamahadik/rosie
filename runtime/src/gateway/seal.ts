// Sealing the event's words (T-243; C-044; arch 02 step 1 "writes the sealed event to the handle's actor", line 109;
// NQ-RT-1 default: the gateway seals under the handle's key, made on first sight and linked to the person once known).
//
// The seal that is stored: AES-256-GCM through WebCrypto, a fresh random 96-bit IV per seal, the cipher text and its
// 128-bit tag as one base64 string. The additional data binds the box to its handle and event (`${actor name}|${event
// id}`), so a box copied onto another event or handle fails to open. What is sealed is one JSON text, in one of two
// forms (K-06 v1.2, README "The sealed hand-off"; T-1297):
//   - form 2 (`SealedBoxV2`, K-06 v1.2 sealedBox): {"body", "subject", "optionWords"}, every word a person typed after the
//     scrub, a poll's option words among them (CQ-58). The gateway seals every event's words in this form
//     (`sealEventWords`), and never makes a form 1 box for an event after v1.2.
//   - form 1 (`SealedBox`, K-06 v1.2 sealedBoxV1; T-243): {"body", "subject"}. Every event box the gateway made before
//     v1.2 is one, and still opens as it is (v1.2 default 4: a kept event is never rewritten). The actor's own boxes (a
//     kept safety result, a write queued for the return) are sealed in it too (`sealWords`).
// The form is not in the additional data (v1.2 default 3), so a form 1 box keeps opening. `openWords` reads a box by its
// form and fails closed (items 6 and 7): a form it does not know, a box that does not open, and an opened box whose
// members are not exactly its form's (one missing, one more, or one of another type) are refused, and nothing in them is
// read. A stored event's option words are read by its box's form (`optionWordsOf`, `wordsOfEvent`).
//
// The key comes through a key-store interface (the real call is K-05 v1.2's "get or create a handle's sealing key",
// T-072, served by T-220; it joins at D-017, T-553). The seal and the open take the handle's data key in either of two
// forms: 32 raw bytes (T-243's form, every double's), or the key object K-05 v1.2 item 29 hands over (T-182's form:
// AES-256-GCM, for encrypt and decrypt, never exportable; README default 27: "the gateway's seal takes a WebCrypto key").
// A key object of any other kind is refused, so nothing is sealed or opened under it. Never logged, put in a span or
// answered: a key, a plain body.

/** A handle as K-06 and K-04 write it: the phone in E.164 or the email in lower case. */
export interface HandleRef {
  readonly kind: string;
  readonly address: string;
}

/**
 * A handle's data key (AES-256): its 32 raw bytes, or a key object for AES-256-GCM that cannot be exported (T-182's
 * form, which K-05 v1.2 `handleSealingKey` hands over).
 */
export type SealingKey = Uint8Array | CryptoKey;

/** A handle's data key with the K-04 id of the handle, as one key call answers both (K-05 v1.2 item 29: handleId). */
export interface HandleKey {
  readonly key: SealingKey;
  readonly handleId: string;
}

/**
 * The handle's sealing key store. `getOrCreateKey` answers the handle's data key (AES-256), making it on first sight:
 * the key object K-05 v1.2 `handleSealingKey` hands over (the real port, T-553), or 32 raw bytes (every double's). A
 * throw means no key: the gateway answers 503 and writes nothing.
 */
export interface SealingKeyStore {
  getOrCreateKey(handle: HandleRef): Promise<SealingKey>;
  /**
   * The same key call, answering the handle's K-04 id beside its key (K-05 v1.2 handleSealingKey's handleId): the gateway
   * hands that id to K-05 v1.7 openChatOnText at receipt (T-1213; ./chat-open.ts). Left out by a store that knows no K-04
   * id, as the gateway's own doubles are: a text then opens no chat. A throw means no key, as for `getOrCreateKey`.
   */
  getOrCreateHandleKey?(handle: HandleRef): Promise<HandleKey>;
}

/**
 * A box of form 1 (T-243; K-06 v1.2 sealedBoxV1), opened to {body, subject}: every event box made before K-06 v1.2, and
 * the actor's own boxes (a kept safety result, a write queued for the return).
 */
export interface SealedBox {
  readonly v: 1;
  readonly alg: "A256GCM";
  /** The 12-byte IV, base64. */
  readonly iv: string;
  /** The cipher text with its 16-byte tag, base64. */
  readonly ct: string;
}

/** A box of form 2 (K-06 v1.2 sealedBox; T-1297): form 1's seal, opened to {body, subject, optionWords}. */
export interface SealedBoxV2 {
  readonly v: 2;
  readonly alg: "A256GCM";
  /** The 12-byte IV, base64. */
  readonly iv: string;
  /** The cipher text with its 16-byte tag, base64. */
  readonly ct: string;
}

/** The box a stored event holds: form 2 since K-06 v1.2, or form 1 for an event kept before it. */
export type EventBox = SealedBox | SealedBoxV2;

/** What a box holds once opened: its form's members, the words after the scrub, each null where the event has none. */
export interface SealedWords {
  readonly body: string | null;
  readonly subject: string | null;
  /**
   * A form 2 box's third member (K-06 v1.2 sealedWords.optionWords): a vote's or a vote taken back's option words after
   * the scrub, null for every other kind. A form 1 box holds none, so it is left out there.
   */
  readonly optionWords?: string | null;
}

/** The words a form 2 box seals: exactly its three members (K-06 v1.2 sealedWords), each null where the event has none. */
export interface EventWords {
  readonly body: string | null;
  readonly subject: string | null;
  readonly optionWords: string | null;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Each form's members, exactly (K-06 v1.2 sealedWordsV1 and sealedWords). */
const FORM_MEMBERS = {
  1: ["body", "subject"],
  2: ["body", "subject", "optionWords"],
} as const;

type Form = keyof typeof FORM_MEMBERS;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A key object as T-182 makes it: a secret AES-GCM key of 256 bits that cannot be exported and may be used for `use`.
 * Anything else is refused, naming no key.
 */
function checkedKeyObject(key: CryptoKey, use: "encrypt" | "decrypt"): CryptoKey {
  const algorithm: unknown = key.algorithm;
  const fits =
    key.type === "secret" &&
    !key.extractable &&
    isRecord(algorithm) &&
    algorithm.name === "AES-GCM" &&
    algorithm.length === KEY_BYTES * 8 &&
    key.usages.includes(use);
  if (!fits) throw new Error("sealing key is not a non-exportable AES-256-GCM key");
  return key;
}

/** The key as WebCrypto takes it: raw bytes imported as before, a key object checked and used as it is. */
function keyFor(key: SealingKey, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (ArrayBuffer.isView(key)) return importKey(key);
  return Promise.resolve(checkedKeyObject(key, use));
}

/** The one seal both forms share: a fresh IV, the cipher text and its tag, under the actor name and event id. */
async function seal(
  text: string,
  key: SealingKey,
  actorName: string,
  eventId: string,
): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(actorName, eventId), tagLength: 128 },
    await keyFor(key, "encrypt"),
    new TextEncoder().encode(text),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(cipher)) };
}

/**
 * Seals a body and a subject in a box of form 1 (T-243): the actor's own boxes (a kept safety result, a write queued for
 * the return). An event's words go in form 2 (`sealEventWords`); words with option words are refused here, so none is
 * dropped.
 */
export async function sealWords(
  words: SealedWords,
  key: SealingKey,
  actorName: string,
  eventId: string,
): Promise<SealedBox> {
  if (words.optionWords !== undefined && words.optionWords !== null) {
    throw new Error("a form 1 box holds no option words");
  }
  const sealed = await seal(
    JSON.stringify({ body: words.body, subject: words.subject }),
    key,
    actorName,
    eventId,
  );
  return { v: 1, alg: "A256GCM", ...sealed };
}

/**
 * Seals an event's words in a box of form 2 (K-06 v1.2 sealedBox, opened to sealedWords: exactly the body, the subject
 * and the option words, each a string or null): the gateway's seal for every kind with words (T-1297).
 */
export async function sealEventWords(
  words: EventWords,
  key: SealingKey,
  actorName: string,
  eventId: string,
): Promise<SealedBoxV2> {
  const sealed = await seal(
    JSON.stringify({ body: words.body, subject: words.subject, optionWords: words.optionWords }),
    key,
    actorName,
    eventId,
  );
  return { v: 2, alg: "A256GCM", ...sealed };
}

/** The box's form; a value that is not a box of form 1 or 2 is refused, naming no value. */
function formOf(box: unknown): Form {
  if (!isRecord(box) || box.alg !== "A256GCM" || typeof box.iv !== "string" || typeof box.ct !== "string") {
    throw new Error("not a sealed box");
  }
  if (box.v === 1 || box.v === 2) return box.v;
  throw new Error("a sealed box of a form this build does not know");
}

/**
 * An opened box's words, read by its form (K-06 v1.2 item 6): refused, with nothing in them read, unless the members are
 * exactly the form's, each a string or null.
 */
function wordsOfForm(form: Form, opened: unknown): SealedWords {
  const members: readonly string[] = FORM_MEMBERS[form];
  if (!isRecord(opened) || Array.isArray(opened)) throw new Error("an opened box that is not its form's");
  const keys = Object.keys(opened);
  const exact = keys.length === members.length && members.every((member) => keys.includes(member));
  const words = exact ? members.map((member) => opened[member]) : [];
  if (!exact || !words.every((value) => value === null || typeof value === "string")) {
    throw new Error("an opened box that is not its form's");
  }
  const [body, subject, optionWords] = words;
  const two = { body: body ?? null, subject: subject ?? null };
  return form === 1 ? two : { ...two, optionWords: optionWords ?? null };
}

/**
 * Opens a box of either form and gives its words by its form: form 1's body and subject, form 2's body, subject and
 * option words. Throws when the key, the actor name or the event id is not the one it was sealed with, and for a form it
 * does not know or an opened box whose members are not exactly its form's (K-06 v1.2 items 6 and 7).
 */
export async function openWords(
  box: EventBox,
  key: SealingKey,
  actorName: string,
  eventId: string,
): Promise<SealedWords> {
  const form = formOf(box);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(box.iv),
      additionalData: additionalData(actorName, eventId),
      tagLength: 128,
    },
    await keyFor(key, "decrypt"),
    fromBase64(box.ct),
  );
  return wordsOfForm(form, JSON.parse(new TextDecoder().decode(plain)) as unknown);
}

/** What a reader of a stored event's words reads of it: its box and, for an event kept before K-06 v1.2, its poll. */
export interface StoredWords {
  readonly sealed: EventBox | null;
  readonly poll?: unknown;
}

/**
 * A stored event's option words, read by its box's form (K-06 v1.2 "The sealed hand-off", items 5 and 6): with a form 2
 * box, only the opened box's (`opened`, from `openWords` on that box), never a plain field, which a form 2 event does not
 * have; with a form 1 box or none, which means the event was kept before v1.2, its plain `poll.optionWords` as it was kept
 * (they passed no scrub: ADR-017 open point 8). Null where it has none.
 */
export function optionWordsOf(event: StoredWords, opened: SealedWords | null): string | null {
  if (event.sealed?.v === 2) return opened?.optionWords ?? null;
  const poll = event.poll;
  if (!isRecord(poll)) return null;
  const words = poll.optionWords;
  return typeof words === "string" ? words : null;
}

/**
 * A stored event's words as its readers take them (K-06 v1.2 items 5 and 6): its opened box as it is (`opened`, from
 * `openWords` on the event's box; null for an event with none), with an event kept before v1.2 also giving a vote's plain
 * option words (`optionWordsOf`). Null for an event with no words.
 */
export function wordsOfEvent(event: StoredWords, opened: SealedWords | null): SealedWords | null {
  if (event.sealed?.v === 2) return opened;
  const optionWords = optionWordsOf(event, opened);
  if (optionWords === null) return opened;
  return { body: opened?.body ?? null, subject: opened?.subject ?? null, optionWords };
}
