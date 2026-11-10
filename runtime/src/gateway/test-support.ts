// Doubles for the gateway's tests (T-243; T-1180's bodies). Not imported by the Worker.

import { actorNameOf, type HandleRef, type SealingKeyStore } from "./seal";

/** A POST whose body is `body` (text, bytes or a stream), with these headers. */
export function postOf(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  url = "https://rosie.test/body",
): Request {
  // Node's fetch takes a stream body only as half duplex; the Workers runtime needs no such word.
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(url, init);
}

/** `count` bytes of "x". */
export function xBytes(count: number): Uint8Array {
  return new TextEncoder().encode("x".repeat(count));
}

/** A body stream that counts what its reader takes. */
export interface CountedStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** How many chunks the reader has pulled. */
  pulled(): number;
  /** True once the reader cancelled the stream. */
  cancelled(): boolean;
}

/**
 * A body stream of `count` chunks, the i-th `chunkAt(i)`, made one per read: nothing is pulled before a read, so a
 * chunk never pulled was never read, and a large `count` costs nothing until it is read.
 */
export function countedStream(count: number, chunkAt: (index: number) => Uint8Array): CountedStream {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= count) {
          controller.close();
          return;
        }
        controller.enqueue(chunkAt(pulled));
        pulled += 1;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];

/**
 * Bodies whose text request.text() decodes in its own ways: plain JSON, characters of two to four bytes, a byte-order
 * mark (dropped), a malformed byte and a cut-off character (each U+FFFD), and no bytes at all.
 */
export function bodyTexts(): Uint8Array[] {
  return [
    utf8('{"page":{"requestId":"req-0001"}}'),
    utf8("é 漢字 🙂"),
    [...BYTE_ORDER_MARK, ...utf8('{"a":1}')],
    [0x61, 0xff, 0x62],
    [...utf8("ab"), 0xe6, 0xbc],
    [],
  ].map((bytes) => new Uint8Array(bytes));
}

/**
 * Two byte-order marks, then "a". The Encoding standard's UTF-8 decode drops the first only, giving U+FEFF then "a", as
 * the Workers runtime's request.text() does (body.worker.test.ts); Node's own request.text() drops both.
 */
export function twoByteOrderMarks(): Uint8Array {
  return new Uint8Array([...BYTE_ORDER_MARK, ...BYTE_ORDER_MARK, ...utf8("a")]);
}

export interface FakeKeyStore extends SealingKeyStore {
  /** The handles a key was asked for, in order. */
  readonly asked: HandleRef[];
  /** The key made for a handle, for a test that opens a box itself; throws when none was made. */
  keyOf(handle: HandleRef): Uint8Array;
}

/** A value a test needs to be there: throws, with the name, when it is not. */
export function present<T>(value: T | null | undefined, name = "value"): T {
  if (value === undefined || value === null) throw new Error(`${name} is missing`);
  return value;
}

/** A key store that makes a random 32-byte key for a handle on first sight and gives the same one after. */
export function fakeKeyStore(): FakeKeyStore {
  const keys = new Map<string, Uint8Array>();
  const asked: HandleRef[] = [];
  return {
    asked,
    keyOf: (handle) => present(keys.get(actorNameOf(handle)), "the handle's key"),
    getOrCreateKey(handle) {
      asked.push(handle);
      const name = actorNameOf(handle);
      let key = keys.get(name);
      if (key === undefined) {
        key = crypto.getRandomValues(new Uint8Array(32));
        keys.set(name, key);
      }
      return Promise.resolve(key);
    },
  };
}
