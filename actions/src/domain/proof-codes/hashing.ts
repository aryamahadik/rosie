// The code's keyed hash (T-322; K-22 v1 README "Codes and sessions" and default 7; ADR-016 section 4, "The key"; DL-526).
// A code is never stored: K-22 v1 proof_codes.code_hash is its HMAC-SHA-256 under the Workers secret hash_key_name names,
// so a 6-digit code cannot be found by hashing every code without the key. The action layer reads no key: the
// composition root reads the secret by name and hands this service a hashing port (KeyedHash), and the service hashes
// the code with its own fixed prefix. ADR-016's contact hash uses the same port with another fixed prefix, so a code's
// hash and a contact's never meet.
//
// hmacSha256Hash is that port over Web Crypto, for the root to bind to the key bytes it read; nothing here reads an
// environment, a file or a binding. Nothing here logs, and no error carries a key, a code or a hash.

/** HMAC-SHA-256 under one Workers secret, handed in by the composition root (ADR-016 section 4). */
export interface KeyedHash {
  /** The secret's name (K-22 v1 proof_codes.hash_key_name): a name, never a value. */
  readonly keyName: string;
  /** HMAC-SHA-256 of the message's UTF-8 bytes under that secret, as 64 lower-case hex digits. */
  hmacHex(message: string): Promise<string>;
}

/** A proof code's own fixed prefix (ADR-016 section 4: the code's hash takes "its own fixed, distinct prefix"). */
export const PROOF_CODE_HASH_PREFIX = "rosie/proof-code/v1\n";

/** K-22 v1 proof_codes_key_name_form: a secret's name, upper case. */
const KEY_NAME_FORM = /^[A-Z][A-Z0-9_]*$/u;

/** K-22 v1 proof_codes_hash_form: 64 lower-case hex digits. */
export const HASH_FORM = /^[0-9a-f]{64}$/u;

/** The fewest key bytes the port takes: staging's key is 32 random bytes (ADR-016 card G, as SEALING_WRAP_KEY). */
export const MIN_KEY_BYTES = 32;

/** A hash that is not K-22's form, or a key name that is not a secret's: nothing is stored. Names no value. */
export class ProofCodeHashError extends Error {
  override name = "ProofCodeHashError";
}

/** Whether a name is a Workers secret's name as K-22 v1 keeps it. */
export function isKeyName(name: string): boolean {
  return KEY_NAME_FORM.test(name);
}

/**
 * The code as it is hashed: the code as typed or texted with its white space taken out ("482 913" is 482913), nothing
 * else changed (default 1 in send.ts), so a code typed in two groups is the same code and any other text is not.
 */
export function codeAsHashed(typed: string): string {
  return typed.replace(/\s+/gu, "");
}

/**
 * The code's keyed hash, K-22 v1 proof_codes.code_hash: HMAC-SHA-256 of the fixed prefix and the code. A port that
 * answers anything but K-22's hash form, or names a key that is not a secret's name, is refused (fail closed).
 */
export async function codeHashOf(hash: KeyedHash, code: string): Promise<string> {
  if (!isKeyName(hash.keyName)) throw new ProofCodeHashError("the hashing port names no secret");
  const hex = await hash.hmacHex(`${PROOF_CODE_HASH_PREFIX}${codeAsHashed(code)}`);
  if (!HASH_FORM.test(hex)) throw new ProofCodeHashError("the hashing port gave no HMAC-SHA-256 in hex");
  return hex;
}

/**
 * The hashing port over Web Crypto's HMAC-SHA-256, for the composition root: it reads the secret by name and hands its
 * bytes in, and they stay inside a non-extractable key. Refused: a name that is not a secret's, or a key shorter than
 * MIN_KEY_BYTES.
 */
export async function hmacSha256Hash(keyName: string, keyBytes: Uint8Array): Promise<KeyedHash> {
  if (!isKeyName(keyName)) throw new ProofCodeHashError("a hashing key is named by its secret's name");
  if (keyBytes.byteLength < MIN_KEY_BYTES) {
    throw new ProofCodeHashError(`a hashing key has at least ${String(MIN_KEY_BYTES)} bytes`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return {
    keyName,
    async hmacHex(message) {
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
      return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}
