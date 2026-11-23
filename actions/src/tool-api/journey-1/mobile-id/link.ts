// S1-10's secure link, minted at the walk (T-1533; K-09 README default 211; K-21 v1 "Links" and default 18).
//
//   - The code: 16 bytes from a cryptographically secure random generator (crypto.getRandomValues, through the proof
//     codes' RandomFill: domain/proof-codes/draw.ts WEB_CRYPTO_FILL), written as 32 lowercase hexadecimal characters:
//     128 bits, inside K-21's linkCode pattern (^[A-Za-z0-9-]{3,64}$), never "_", and in this one made form only, which
//     staging's openLink checks before any read (default 212 (1)).
//   - The link: https://<LINK_HOST><BASE_PATH>/<code>, as web/src/shell/config.ts linkUrl builds it from the Worker's
//     vars (Q-51; K-21 default 5), read from the same two vars the web shell reads and handed in by the binding, never a
//     constant: rosfield.com/test/<code> on staging (DL-014, DL-023). A host or base path that is not a link's is refused
//     before any code is drawn, so no link is built on a host nobody set.
//   - The row keeps only the code's sha256 in UTF-8, 64 lowercase hex characters (K-22 v1.1 page_links_code_hash_form),
//     and the link lives 7 days from its issue (K-21's fixtures' example; open gap 197).
// Nothing here logs, and no error carries a draw, a code, a hash or a link.

import { WEB_CRYPTO_FILL, sha256Hex, type RandomFill } from "../../../domain/proof-codes";

/** The code's bytes: 16, so 128 bits (K-21 default 18). */
export const LINK_CODE_BYTES = 16;

/** The code's one made form: 32 lowercase hexadecimal characters (default 211). */
export const LINK_CODE_FORM = /^[0-9a-f]{32}$/;

/** How long S1-10's link lives from its issue (default 211; K-21 open gap 4; open gap 197): 7 days. */
export const LINK_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** A host name, as the web shell's config reads LINK_HOST (web/src/shell/config.ts HOST): a port only where one is set. */
const HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;
const HOST_MAX = 253;

/** A base path as the frame reads BASE_PATH: "" or /segments, with no closing slash. */
const BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/** Where the link points: the Worker's LINK_HOST and BASE_PATH, as the binding hands them in. */
export interface LinkPlace {
  readonly host: string;
  readonly basePath: string;
}

/** Whether `place` is a link's host and base path (the web shell's own reading of the two vars). */
export function isLinkPlace(place: LinkPlace): boolean {
  const { host, basePath } = place;
  return (
    typeof host === "string" &&
    host.length <= HOST_MAX &&
    HOST.test(host) &&
    typeof basePath === "string" &&
    BASE_PATH.test(basePath)
  );
}

/** A fill that gave fewer bytes than asked, or none in the made form: no code is made. Names no draw. */
export class LinkCodeError extends Error {
  override name = "LinkCodeError";

  constructor() {
    super("no link code made: the generator gave no code in its made form");
  }
}

/** One code: LINK_CODE_BYTES bytes from `fill`, as 32 lowercase hexadecimal characters. */
export function mintCode(fill: RandomFill = WEB_CRYPTO_FILL): string {
  const bytes = new Uint8Array(LINK_CODE_BYTES);
  fill(bytes);
  const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!LINK_CODE_FORM.test(code)) throw new LinkCodeError();
  return code;
}

/** The link to the secure page for `code`: https://<host><basePath>/<code>. Throws on a code not in its made form. */
export function secureLinkOf(place: LinkPlace, code: string): string {
  if (!LINK_CODE_FORM.test(code)) throw new LinkCodeError();
  return `https://${place.host}${place.basePath}/${code}`;
}

/** The code's sha256 in UTF-8, 64 lowercase hex characters: the one form a row keeps (page_links.code_sha256). */
export function codeSha256(code: string): Promise<string> {
  return sha256Hex(code);
}

/** A moment as K-04's seeds write a timestamptz: UTC to the second, ending in Z. */
export function utcSecond(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** The link's issue and lapse, to the second: issued at `now`, lapsing LINK_LIFE_MS later. */
export function linkLifeOf(now: Date): { readonly issuedAt: string; readonly expiresAt: string } {
  const issued = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return { issuedAt: utcSecond(issued), expiresAt: utcSecond(new Date(issued.getTime() + LINK_LIFE_MS)) };
}
