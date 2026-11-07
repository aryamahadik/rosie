// Per-person sealing: seal and unseal a person's private values under a key of their own, and erase the person by
// deleting that key (K-04 v1 core sealing_keys; arch 01 line 93, arch 09 line 492; RULES 4.10; T-182).
//
// Keys, two layers (NQ-DB-1 default: one environment key wraps every data key):
//   data key     a random 256-bit AES-GCM key, made on a person's first seal. It seals that person's values.
//   wrapping key a 256-bit AES-GCM key held in a Workers secret. The caller reads it from the environment by name and
//                hands it in through `WrappingKeys`; this code names the secret and never holds its value beyond a
//                call. The table stores the data key only wrapped under it, with the secret's name beside it.
// A data key is never written anywhere in the clear: it is made, wrapped, and every later use unwraps it into a key
// object the runtime cannot export. After erasePerson the wrapped bytes are gone from the row, so nothing that was
// sealed under that key can be opened again, by this code or by anyone holding the wrapping key.
//
// Sealed form (what `seal` returns and the caller stores in a bytea column), version 1, 29 bytes longer than the input:
//   byte 0        format: 0x01 (AES-256-GCM, 12-byte IV, 16-byte tag)
//   bytes 1..12   IV, random per value
//   bytes 13..    ciphertext followed by the 16-byte GCM tag
//   additional authenticated data: "rosie:seal:v1:" + person id, so a sealed value cannot be moved to another person.
// Wrapped data key (sealing_keys.wrapped_key), version 1, 61 bytes: the same layout around the 32 raw key bytes, with
//   additional authenticated data "rosie:wrap:v1:" + person id (one person's wrapped key cannot stand in for another's).
//
// Nothing here logs. An error carries a code and a fixed message: never a key, a plaintext, a sealed value or an id.
// Web Crypto (the global `crypto.subtle`) is used, which Workers and Node both have; there is no dependency.
//
// Updates are compare-and-set on the row's version like db/repo/people.ts; the database refuses any update that does
// not raise the version by one (trigger from 0002).
import type { Sql, Tx } from "./scope";

type Db = Sql | Tx;

/** The format byte of the sealed form and of the wrapped key. */
export const SEAL_FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Format byte, IV and tag around the data. */
export const SEAL_OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES;
/** Length of sealing_keys.wrapped_key: the overhead around a 32-byte key. */
export const WRAPPED_KEY_BYTES = SEAL_OVERHEAD_BYTES + KEY_BYTES;

/** The secret's name used when a person's first seal makes their key (NQ-DB-1; the fixture's name too). */
export const DEFAULT_WRAPPING_KEY_NAME = "SEALING_WRAP_KEY";

export type SealingErrorCode =
  /** The person has no key yet (unseal only; seal makes one). */
  | "no_key"
  /** The person was erased: their key is gone, so nothing can be sealed or opened for them. */
  | "erased"
  /** The environment has no wrapping key under the name the row names. */
  | "wrapping_key_missing"
  /** The wrapping key is not 32 bytes (as bytes, or as base64). */
  | "wrapping_key_invalid"
  /** The bytes are not a sealed value of a known format. */
  | "bad_format"
  /** The bytes do not open: altered, sealed for someone else, or under another key. */
  | "cannot_open";

const MESSAGES: Record<SealingErrorCode, string> = {
  no_key: "the person has no sealing key",
  erased: "the person's sealing key was erased",
  wrapping_key_missing: "the wrapping key named by the sealing key is not available",
  wrapping_key_invalid: "the wrapping key is not a 256-bit key",
  bad_format: "not a sealed value of a known format",
  cannot_open: "the sealed value cannot be opened",
};

/** The one error type of this file. `message` is fixed per code and never holds key material, plaintext or an id. */
export class SealingError extends Error {
  readonly code: SealingErrorCode;

  constructor(code: SealingErrorCode) {
    super(MESSAGES[code]);
    this.name = "SealingError";
    this.code = code;
  }
}

/** Where the wrapping keys come from. The caller reads them from the environment (Workers secrets) by name. */
export interface WrappingKeys {
  /** The secret that wraps the data key of a person's first seal (default DEFAULT_WRAPPING_KEY_NAME). */
  name?: string;
  /**
   * The value of the secret called `name`, or undefined when it is not set: 32 raw bytes, or those bytes as base64.
   * Called for every seal and unseal; the value is used for that call only.
   */
  resolve(name: string): Uint8Array | string | undefined | Promise<Uint8Array | string | undefined>;
}

/** What the table says about a person's key; never the wrapped bytes. */
export interface SealingKeyInfo {
  personId: string;
  wrappingKeyName: string;
  createdAt: Date;
  /** Null while the key is held. */
  erasedAt: Date | null;
  version: number;
}

/** A compare-and-set: written, or refused with the row as it is now (null when there is no such row). */
export type EraseResult = { ok: true; row: SealingKeyInfo } | { ok: false; current: SealingKeyInfo | null };

interface KeyRow {
  person_id: string;
  wrapped_key: Uint8Array | null;
  wrapping_key_name: string;
  created_at: Date;
  erased_at: Date | null;
  version: number;
}

const toInfo = (row: KeyRow): SealingKeyInfo => ({
  personId: row.person_id,
  wrappingKeyName: row.wrapping_key_name,
  createdAt: row.created_at,
  erasedAt: row.erased_at,
  version: row.version,
});

const encoder = new TextEncoder();
const subtle = (): SubtleCrypto => crypto.subtle;

function aad(kind: "seal" | "wrap", personId: string): Uint8Array {
  return encoder.encode(`rosie:${kind}:v1:${personId}`);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim());
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Reads the wrapping key called `name` and makes it a key object that can wrap and unwrap, and nothing else. */
async function importWrappingKey(keys: WrappingKeys, name: string): Promise<CryptoKey> {
  const value = await keys.resolve(name);
  if (value === undefined || value === "") {
    throw new SealingError("wrapping_key_missing");
  }
  const bytes = typeof value === "string" ? fromBase64(value) : value;
  if (bytes?.length !== KEY_BYTES) {
    throw new SealingError("wrapping_key_invalid");
  }
  return subtle().importKey("raw", bytes, { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey"]);
}

function joinParts(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Splits `format | iv | body` and refuses anything shorter than the overhead or of another format. */
function splitSealed(bytes: Uint8Array): { iv: Uint8Array; body: Uint8Array } {
  if (bytes.length < SEAL_OVERHEAD_BYTES || bytes[0] !== SEAL_FORMAT_V1) {
    throw new SealingError("bad_format");
  }
  return { iv: bytes.slice(1, 1 + IV_BYTES), body: bytes.slice(1 + IV_BYTES) };
}

async function wrapDataKey(
  wrappingKey: CryptoKey,
  dataKey: CryptoKey,
  personId: string,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const body = await subtle().wrapKey("raw", dataKey, wrappingKey, {
    name: "AES-GCM",
    iv,
    additionalData: aad("wrap", personId),
  });
  return joinParts(Uint8Array.of(SEAL_FORMAT_V1), iv, new Uint8Array(body));
}

/** The data key as a key object that cannot be exported. */
async function unwrapDataKey(
  wrappingKey: CryptoKey,
  wrapped: Uint8Array,
  personId: string,
): Promise<CryptoKey> {
  const { iv, body } = splitSealed(wrapped);
  try {
    return await subtle().unwrapKey(
      "raw",
      body,
      wrappingKey,
      { name: "AES-GCM", iv, additionalData: aad("wrap", personId) },
      { name: "AES-GCM", length: KEY_BYTES * 8 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new SealingError("cannot_open");
  }
}

async function readRow(sql: Db, personId: string): Promise<KeyRow | null> {
  const [row] = await sql<KeyRow[]>`select * from sealing_keys where person_id = ${personId}`;
  return row ?? null;
}

/** What the table says about a person's key (never the bytes), or null when the person has none. */
export async function getSealingKeyInfo(sql: Db, personId: string): Promise<SealingKeyInfo | null> {
  const [row] = await sql<KeyRow[]>`
    select person_id, null::bytea as wrapped_key, wrapping_key_name, created_at, erased_at, version
    from sealing_keys where person_id = ${personId}
  `;
  return row === undefined ? null : toInfo(row);
}

/** The person's data key, made and stored wrapped on the first call. Throws "erased" for an erased person. */
async function dataKeyFor(
  sql: Db,
  keys: WrappingKeys,
  personId: string,
  mayCreate: boolean,
): Promise<CryptoKey> {
  let row = await readRow(sql, personId);
  if (row === null && mayCreate) {
    const name = keys.name ?? DEFAULT_WRAPPING_KEY_NAME;
    const wrappingKey = await importWrappingKey(keys, name);
    const fresh = (await subtle().generateKey({ name: "AES-GCM", length: KEY_BYTES * 8 }, true, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey;
    const wrapped = await wrapDataKey(wrappingKey, fresh, personId);
    // Two first seals at once: one insert wins, the other reads the winner's row below.
    await sql`
      insert into sealing_keys (person_id, wrapped_key, wrapping_key_name)
      values (${personId}, ${wrapped}, ${name})
      on conflict (person_id) do nothing
    `;
    row = await readRow(sql, personId);
  }
  if (row === null) {
    throw new SealingError("no_key");
  }
  if (row.wrapped_key === null) {
    throw new SealingError("erased");
  }
  // The row says which secret wraps it, so a key made under an older name still opens.
  const wrappingKey = await importWrappingKey(keys, row.wrapping_key_name);
  return unwrapDataKey(wrappingKey, new Uint8Array(row.wrapped_key), personId);
}

/**
 * Seals `plaintext` for a person: makes their key if this is their first seal, and returns the sealed form (see the
 * top of this file) to store in a bytea column. The same plaintext sealed twice gives different bytes (a fresh IV).
 * Throws SealingError "erased" for an erased person; "wrapping_key_missing" or "wrapping_key_invalid" when the
 * environment key is not usable.
 */
export async function seal(
  sql: Db,
  keys: WrappingKeys,
  personId: string,
  plaintext: Uint8Array | string,
): Promise<Uint8Array> {
  const dataKey = await dataKeyFor(sql, keys, personId, true);
  const iv = randomBytes(IV_BYTES);
  const data = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
  const body = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: aad("seal", personId) },
    dataKey,
    data,
  );
  return joinParts(Uint8Array.of(SEAL_FORMAT_V1), iv, new Uint8Array(body));
}

/**
 * Opens a sealed value of a person. Throws SealingError: "no_key" (the person never sealed anything), "erased" (their
 * key was deleted: the value can never be opened again), "bad_format", "cannot_open" (altered, or another person's),
 * "wrapping_key_missing" or "wrapping_key_invalid".
 */
export async function unseal(
  sql: Db,
  keys: WrappingKeys,
  personId: string,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const { iv, body } = splitSealed(sealed);
  const dataKey = await dataKeyFor(sql, keys, personId, false);
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv, additionalData: aad("seal", personId) },
      dataKey,
      body,
    );
    return new Uint8Array(plain);
  } catch {
    throw new SealingError("cannot_open");
  }
}

/** `unseal`, read as UTF-8 text. */
export async function unsealText(
  sql: Db,
  keys: WrappingKeys,
  personId: string,
  sealed: Uint8Array,
): Promise<string> {
  return new TextDecoder().decode(await unseal(sql, keys, personId, sealed));
}

/**
 * Erases a person: deletes their wrapped key (wrapped_key null, erased_at now) and raises the row's version by one, as
 * a compare-and-set. After it every value sealed for them is unreadable for good. With `expectedVersion` the write
 * happens only if the row is still at that version; without it the version is read first, and the write retried a few
 * times if another writer changed the row in between. Refused as `{ ok: false, current }` when the person has no key
 * row (current null), was erased already (current shows when), or the version was stale.
 */
export async function erasePerson(sql: Db, personId: string, expectedVersion?: number): Promise<EraseResult> {
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw new TypeError("a row version is a positive integer");
  }
  let version = expectedVersion;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (version === undefined) {
      const current = await getSealingKeyInfo(sql, personId);
      if (current?.erasedAt !== null) {
        return { ok: false, current };
      }
      version = current.version;
    }
    const [row] = await sql<KeyRow[]>`
      update sealing_keys set wrapped_key = null, erased_at = now(), version = ${version + 1}
      where person_id = ${personId} and version = ${version} and wrapped_key is not null
      returning person_id, null::bytea as wrapped_key, wrapping_key_name, created_at, erased_at, version
    `;
    if (row !== undefined) {
      return { ok: true, row: toInfo(row) };
    }
    const current = await getSealingKeyInfo(sql, personId);
    if (expectedVersion !== undefined || current?.erasedAt !== null) {
      return { ok: false, current };
    }
    version = undefined;
  }
  return { ok: false, current: await getSealingKeyInfo(sql, personId) };
}
