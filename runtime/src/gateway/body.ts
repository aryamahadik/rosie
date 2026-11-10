// A request's body read under a cap (T-1180; T-266's QA and security notes; DL-357). The page entry (pages/entry.ts) and
// the Linq webhook entry (linq-webhook.ts) read their body only through here, each under its own cap, a config value with
// a default (GatewayDeps.pageBodyLimitBytes and linqBodyLimitBytes), so a body over it is refused before it is read whole:
//
//   - a declared length (content-length) over the cap is refused before a byte is read;
//   - a body that declares no length, or less than it sends, is read a chunk at a time, and refused at the chunk that
//     takes it over the cap: its stream is cancelled there, so the rest is never read.
//
// A refused body is never kept, and nothing of any body is logged here. The text is the body's bytes decoded as UTF-8,
// as request.text() decodes them (a leading byte-order mark dropped, a malformed sequence read as U+FFFD), so each door
// reads the same text it read before the cap.

/** The page entry's cap in bytes: 64 KiB, larger than every K-21 fixture's request (the card's default). */
export const PAGE_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The Linq webhook's cap in bytes: 256 KiB, about a hundred times the largest K-11 webhook (fixtures and vendor samples,
 * under 3 KB each), so a long text and its JSON fit, while a body that size costs the Worker little before the verify.
 */
export const LINQ_BODY_LIMIT_BYTES = 256 * 1024;

/** What came of reading a body: its text, or why there is none (over the cap, or a stream that failed). */
export type BodyRead =
  | { readonly text: string }
  | { readonly problem: "tooLarge" }
  | { readonly problem: "unreadable"; readonly error: unknown };

const TOO_LARGE: BodyRead = Object.freeze({ problem: "tooLarge" });

/** A declared length is digits only (RFC 9110 section 8.6); anything else declares nothing, and the count decides. */
const DIGITS = /^[0-9]+$/u;

/**
 * The cap a door reads under: its configured value when that is a whole number of bytes from 0, else the door's
 * default, so a mistyped value never lifts the cap (NaN would let every body through) and never closes the door.
 */
export function bodyLimitOf(configured: number | undefined, fallback: number): number {
  return configured !== undefined && Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : fallback;
}

/** The request's body as text, read under `limitBytes`, or why not. Never throws. */
export async function readCappedText(request: Request, limitBytes: number): Promise<BodyRead> {
  const declared = request.headers.get("content-length")?.trim();
  if (declared !== undefined && DIGITS.test(declared) && Number(declared) > limitBytes) return TOO_LARGE;
  // As request.text() refuses a body read before.
  if (request.bodyUsed) {
    return { problem: "unreadable", error: new TypeError("the body was already read") };
  }

  const body = request.body;
  if (body === null) return { text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    // Each chunk is checked to be bytes before it counts: the runtime's types leave a body stream's chunks untyped.
    const reader: ReadableStreamDefaultReader<unknown> = body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        await stop(reader);
        return { problem: "unreadable", error: new TypeError("a body chunk that is not bytes") };
      }
      size += chunk.byteLength;
      if (size > limitBytes) {
        await stop(reader);
        return TOO_LARGE;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    return { problem: "unreadable", error };
  }
  return { text: utf8Of(chunks, size) };
}

/** Cancels the rest of a body: its source is told no more is read. A cancel that fails changes nothing. */
async function stop(reader: ReadableStreamDefaultReader<unknown>): Promise<void> {
  await reader.cancel().then(
    () => undefined,
    () => undefined,
  );
}

/** The chunks as one text, decoded as request.text() decodes a body (UTF-8, its byte-order mark dropped). */
function utf8Of(chunks: readonly Uint8Array[], size: number): string {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
