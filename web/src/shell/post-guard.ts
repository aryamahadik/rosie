// The three guards every POST route gets before its handler runs (T-520, DL-487; T-1237, DL-490; K-21 v1 README, "The
// cookies", default 21: "the web app's server checks every call that writes for its own origin"). The shell (shell.ts)
// runs them for every POST a route takes, so each form task inherits them and no handler can leave them out. They run
// only for a route in the shell's table: outside staging no staging tool's route is there (shell.ts), so its address
// gets an unknown address's answer and no guard ever says that such a route exists (T-520 round 2; DL-491). They run
// in this order, and the first that refuses answers:
//
// 1. The host rule (T-1237). A POST is answered only when it was sent to this site's own host: the host of the
//    request's URL, as the URL standard parses it, must be exactly LINK_HOST (config.ts). The Worker answers on other
//    hosts too (wrangler.jsonc keeps workers_dev on, as the deploy check reads that address), and the browser's
//    same-origin word in check 2 is relative to the host it reached, not to LINK_HOST, so a page served on the
//    workers.dev address could post its own form there (T-520's security review, note b). The comparison folds and trims
//    nothing: another host, another subdomain, a port, a trailing dot or a different case is refused. (The URL standard
//    lowers a host's capitals and drops the scheme's own port when it parses the address, so those two reach the rule
//    as LINK_HOST itself, as they do in a browser.) The request's host is only compared, never used to build a link or
//    an origin. GET and HEAD never meet the rule, so every page reads on every host as before. It is the same
//    everywhere, a local `wrangler dev` session included: such a session names its own host as LINK_HOST to post a form
//    (web/README.md).
// 2. The origin check. A form on another site can post to this one, and the browser would send this site's cookies
//    with it; `form-action 'self'` in a page's content security policy only limits where this site's own forms post.
//    So a POST is answered only when the browser says it comes from this site's own origin, and that origin is the
//    config's (https:// + LINK_HOST, config.ts), never the request's own Host or address.
//      - An Origin header that names an origin decides alone: it must be exactly this site's.
//      - Every page here is served with `referrer-policy: no-referrer` (serve.ts), and under that policy a browser
//        sends `Origin: null` with a form's POST, even to its own site (Fetch standard, "append a request Origin
//        header"). So when Origin is `null` or missing, the browser's own `Sec-Fetch-Site: same-origin` is what says
//        the form was this site's; a page cannot set or change that header. Anything else is refused.
// 3. The body cap. A POST body over POST_BODY_MAX_BYTES is refused: by its declared length before any of it is read,
//    else while it is read, stopping at the first byte past the cap, never after reading it in full. The handler gets
//    the request again with the bytes that were read, so it never reads an uncapped body.
//
// A refusal says nothing of the request: the shell answers it with its own 403 or 413 page and its one log line.

import type { WebConfig } from "./config";

/** The most a page's form may send, in bytes. A form here holds a few typed fields; files go to storage by their own signed address. */
export const POST_BODY_MAX_BYTES = 16 * 1024;

/** Why a POST is refused: 403 for one not sent to this site's own host or not from this site, 413 for a body over the cap. */
export type PostRefusal = 403 | 413;

/** This site's own origin, from the config alone. */
export function siteOrigin(config: WebConfig): string {
  return `https://${config.linkHost}`;
}

/** True when the request was sent to this site's own host: its URL's host is exactly LINK_HOST (see the top of this file). */
export function toThisHost(request: Request, config: WebConfig): boolean {
  return new URL(request.url).host === config.linkHost;
}

/** True when the browser says the request comes from this site's own origin (see the top of this file). */
export function fromThisSite(request: Request, config: WebConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") return origin === siteOrigin(config);
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** The body's bytes, or null once it passes `max`: the rest is then left unread and the stream is cancelled. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    size += read.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The guards for one POST: the refusal's status, or the request for the handler, its body read and held to the cap.
 * Rejects only when the body cannot be read at all.
 */
export async function guardPost(request: Request, config: WebConfig): Promise<Request | PostRefusal> {
  if (!toThisHost(request, config) || !fromThisSite(request, config)) return 403;

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > POST_BODY_MAX_BYTES))
    return 413;

  const bytes = await readCapped(request.body, POST_BODY_MAX_BYTES);
  if (bytes === null) return 413;

  // The length is the read bytes' own from here on, so the declared one is not carried over.
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: bytes });
}
