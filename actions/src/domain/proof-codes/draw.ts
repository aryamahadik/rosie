// The proof code's draw and the session token (T-322; ADR-016 card A, DL-526; the security reviewer's note d). Both come
// from the Workers runtime's Web Crypto generator, crypto.getRandomValues, the same generator in Node for the tests.
//
//   - The 6-digit code (S11-52's example; K-22 README line 131) is drawn so that each of the million codes is equally
//     likely: one 32-bit draw at a time, and a draw at or above 4,294,000,000 (the largest multiple of 1,000,000 below
//     2^32) is drawn again; the rest are taken modulo 1,000,000 and zero-padded. Taking any 32-bit draw modulo 1,000,000
//     would favour the codes below 967,296, which 4,295 draws reach against 4,294 for the others.
//   - The session token is 32 bytes (256 bits) from the same generator (ADR-016 section 6), written in base64url with no
//     padding, so 43 characters a cookie holds as they are (K-21 v1 opaqueToken). The server keeps only its sha256
//     (K-22 v1 sessions_token_hash_form), and the token leaves the server once, in the first signedIn (K-21 README).
//
// Nothing here logs, and no error carries a draw, a code or a token.

/** Fills a typed array with random values in place, as Web Crypto's crypto.getRandomValues does. */
export type RandomFill = (array: Uint8Array | Uint32Array) => void;

/** The Workers runtime's Web Crypto generator (and Node's, in the tests): the only fill the Worker uses. */
export const WEB_CRYPTO_FILL: RandomFill = (array) => {
  crypto.getRandomValues(array);
};

/** A proof code's digits (S11-52's example code has 6; K-22 README line 131; ADR-016 section 1). */
export const CODE_DIGITS = 6;

/** How many codes there are: 10^6. */
export const CODE_SPACE = 1_000_000;

/**
 * The largest multiple of CODE_SPACE below 2^32 (4,294 times 1,000,000): a 32-bit draw at or above it is drawn again, so
 * every code has exactly 4,294 draws that give it.
 */
export const DRAW_LIMIT = 4_294_000_000;

/**
 * At most this many 32-bit draws for one code. A working generator lands in the top range with odds of 967,296 in
 * 2^32 (about 1 in 4,440), so 16 such draws in a row (odds below 1 in 10^58) mean the generator is broken: the draw
 * stops rather than loop for ever (fail closed: no code is made, nothing is sent).
 */
export const MAX_DRAWS = 16;

/** The bytes of a session token (ADR-016 section 6: 256 bits). */
export const SESSION_TOKEN_BYTES = 32;

/** The generator gave only draws from the top range: no code was made. Names no draw. */
export class CodeDrawError extends Error {
  override name = "CodeDrawError";

  constructor() {
    super(`no code drawn: ${String(MAX_DRAWS)} draws in a row fell in the top range`);
  }
}

/**
 * One 6-digit code, each of the million equally likely: 32-bit draws from `fill` until one falls below DRAW_LIMIT, taken
 * modulo CODE_SPACE and zero-padded to CODE_DIGITS.
 */
export function drawCode(fill: RandomFill = WEB_CRYPTO_FILL): string {
  const draw = new Uint32Array(1);
  for (let tries = 0; tries < MAX_DRAWS; tries += 1) {
    fill(draw);
    const value = draw[0] ?? DRAW_LIMIT;
    if (value < DRAW_LIMIT) return String(value % CODE_SPACE).padStart(CODE_DIGITS, "0");
  }
  throw new CodeDrawError();
}

/** Bytes as base64url with no padding (RFC 4648 section 5). */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The sha256 of a text's UTF-8 bytes, as lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new session's token and the one form of it the server keeps. */
export interface SessionToken {
  /** SESSION_TOKEN_BYTES random bytes in base64url: it leaves the server once, never logged or put in a span. */
  readonly token: string;
  /** The sha256 of the token's text, lower-case hex (K-22 v1 sessions.token_sha256), as the session reads hash it. */
  readonly tokenSha256: string;
}

/** A session token of SESSION_TOKEN_BYTES bytes from `fill`, and its sha256. */
export async function newSessionToken(fill: RandomFill = WEB_CRYPTO_FILL): Promise<SessionToken> {
  const bytes = new Uint8Array(SESSION_TOKEN_BYTES);
  fill(bytes);
  const token = base64Url(bytes);
  return { token, tokenSha256: await sha256Hex(token) };
}
