// Test support for the cache's tests: a fake Messages API that keeps Anthropic's prompt-cache rules (rules.ts), so a
// test sees what the real API would report for the requests the gateway sends. No network, no key, no live call
// (J-02; CI makes none). Never imported by the Worker.
//
// What it keeps, from Anthropic's published rules:
//   - a prefix is cached only at a block carrying `cache_control`, and read only by a request whose blocks up to that
//     point are the same text, in the same blocks, rendered system then messages;
//   - entries are per model, per structured-output format and per effort;
//   - more than 4 markers is a 400; a prefix under the model's minimum (512 tokens) is neither written nor read;
//   - an entry lives 5 minutes from the start of the request that wrote or last read it ("1h": an hour), and a later
//     marker may not have a longer lifetime than an earlier one (a 400);
//   - a breakpoint looks back at most 20 blocks for an entry;
//   - an entry is readable only once the response that wrote it has been handed back, so calls sent side by side do
//     not read each other's writes;
//   - usage reports cache_read_input_tokens, cache_creation_input_tokens (from the read point to the last marker) and
//     input_tokens (the rest).
// Tokens are counted as one per 4 UTF-8 bytes, rounded up: a stand-in for the tokenizer, the same for every model.

import { createHash } from "node:crypto";

import type { FetchLike } from "../gateway";
import { canonical } from "./bundle";
import { CACHE_RULES } from "./rules";

const LOOKBACK = 20;
const HOUR_MS = 60 * 60 * 1000;

export interface FakeUsage {
  readonly input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly output_tokens: number;
}

/** One request the fake API received, and what it answered. */
export interface FakeCall {
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly status: number;
  /** How many blocks carried `cache_control`. */
  readonly markers: number;
  readonly usage: FakeUsage | null;
}

export interface FakeCachingOptions {
  /** The answer to a call (n counts from 0): the recorded-model double's output, sent back as the text block's JSON. */
  readonly answer: (body: Record<string, unknown>, n: number) => unknown;
  /** An HTTP status to fail a call with instead of answering, or null to answer it. */
  readonly fail?: (body: Record<string, unknown>, n: number) => number | null;
  /** The fake's clock in epoch ms; the cache lifetime counts on it. Default: Date.now. */
  readonly now?: () => number;
}

export interface FakeCachingApi {
  readonly fetch: FetchLike;
  readonly calls: readonly FakeCall[];
}

interface Block {
  readonly text: string;
  readonly ttlMs: number | null;
}

interface Entry {
  expiresAt: number;
  readonly ttlMs: number;
  ready: boolean;
}

const encoder = new TextEncoder();

/** Tokens of a text as the fake counts them. */
export function fakeTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / 4);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The marker's lifetime, null for no marker, or a problem. */
function markerTtl(value: unknown): number | null | string {
  if (value === undefined) return null;
  if (!isRecord(value) || value.type !== "ephemeral") return "cache_control is not ephemeral";
  if (value.ttl === undefined || value.ttl === "5m") return CACHE_RULES.ttlMs;
  if (value.ttl === "1h") return HOUR_MS;
  return "cache_control.ttl is not 5m or 1h";
}

function textBlock(value: unknown): Block | string {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string" || value.text === "")
    return "a block is not a non-empty text block";
  const ttl = markerTtl(value.cache_control);
  return typeof ttl === "string" ? ttl : { text: value.text, ttlMs: ttl };
}

/** The request's blocks in render order: system, then each message's content. */
function blocksOf(body: Record<string, unknown>): Block[] | string {
  const blocks: Block[] = [];
  const system = body.system;
  if (typeof system === "string") {
    if (system !== "") blocks.push({ text: system, ttlMs: null });
  } else if (Array.isArray(system)) {
    for (const item of system as unknown[]) {
      const block = textBlock(item);
      if (typeof block === "string") return block;
      blocks.push(block);
    }
  } else if (system !== undefined) {
    return "system is neither text nor blocks";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "messages is empty";
  for (const message of body.messages as unknown[]) {
    if (!isRecord(message)) return "a message is not an object";
    if (typeof message.content === "string") {
      if (message.content === "") return "a message is empty";
      blocks.push({ text: message.content, ttlMs: null });
    } else if (Array.isArray(message.content)) {
      for (const item of message.content as unknown[]) {
        const block = textBlock(item);
        if (typeof block === "string") return block;
        blocks.push(block);
      }
    } else {
      return "a message's content is neither text nor blocks";
    }
  }
  return blocks;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A fake Messages API with Anthropic's prompt cache. */
export function fakeCachingApi(options: FakeCachingOptions): FakeCachingApi {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const calls: FakeCall[] = [];

  const fetchFake: FetchLike = (_url, init) => {
    const n = calls.length;
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    let markers = 0;
    const refuse = (status: number, why: string): Promise<Response> => {
      calls.push({ model, body, status, markers, usage: null });
      return Promise.resolve(
        new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: why } }),
          {
            status,
          },
        ),
      );
    };

    const blocks = blocksOf(body);
    if (typeof blocks === "string") return refuse(400, blocks);
    const marked: { index: number; ttlMs: number }[] = [];
    blocks.forEach((block, index) => {
      if (block.ttlMs !== null) marked.push({ index, ttlMs: block.ttlMs });
    });
    markers = marked.length;
    if (markers > CACHE_RULES.maxBreakpoints)
      return refuse(400, "a maximum of 4 blocks with cache_control may be provided");
    for (let k = 1; k < marked.length; k += 1) {
      if ((marked[k]?.ttlMs ?? 0) > (marked[k - 1]?.ttlMs ?? 0))
        return refuse(400, "a longer lifetime may not follow a shorter one");
    }
    const failWith = options.fail?.(body, n) ?? null;
    if (failWith !== null) return refuse(failWith, "failed on purpose");

    const at = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key);

    const outputConfig = isRecord(body.output_config) ? body.output_config : {};
    const scope = canonical({
      model,
      format: outputConfig.format ?? null,
      effort: outputConfig.effort ?? null,
    });
    const keyAt = (index: number): string =>
      sha256(`${scope}\u0000${JSON.stringify(blocks.slice(0, index + 1).map((block) => block.text))}`);
    const tokensUpTo: number[] = [];
    let running = 0;
    for (const block of blocks) {
      running += fakeTokens(block.text);
      tokensUpTo.push(running);
    }
    const total = running;
    const minimum = CACHE_RULES.minCacheableTokens[model] ?? Number.POSITIVE_INFINITY;

    // Read: the longest prefix with an entry, looking back from each marker, the last marker first.
    let readAt = -1;
    for (const marker of [...marked].reverse()) {
      for (let index = marker.index; index >= Math.max(0, marker.index - LOOKBACK + 1); index -= 1) {
        const entry = entries.get(keyAt(index));
        if (entry?.ready === true) {
          readAt = index;
          entry.expiresAt = at + entry.ttlMs;
          break;
        }
      }
      if (readAt >= 0) break;
    }
    const read = readAt >= 0 ? (tokensUpTo[readAt] ?? 0) : 0;

    // Write: every marker past the read point whose prefix is long enough; the last marker ends what is written.
    const written: Entry[] = [];
    let write = 0;
    const last = marked[marked.length - 1];
    if (last !== undefined && last.index > readAt && (tokensUpTo[last.index] ?? 0) >= minimum) {
      for (const marker of marked) {
        if (marker.index <= readAt || (tokensUpTo[marker.index] ?? 0) < minimum) continue;
        const entry: Entry = { expiresAt: at + marker.ttlMs, ttlMs: marker.ttlMs, ready: false };
        entries.set(keyAt(marker.index), entry);
        written.push(entry);
      }
      write = (tokensUpTo[last.index] ?? 0) - read;
    }

    const output = JSON.stringify(options.answer(body, n));
    const usage: FakeUsage = {
      input_tokens: total - read - write,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      output_tokens: fakeTokens(output),
    };
    calls.push({ model, body, status: 200, markers: marked.length, usage });
    const delivered = Promise.resolve(
      new Response(
        JSON.stringify({
          id: `msg_fake_${String(n)}`,
          type: "message",
          role: "assistant",
          model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: output }],
          usage,
        }),
        { status: 200 },
      ),
    );
    // Readable once the response is handed back: a call sent beside this one does not see these entries.
    void delivered.then(() => {
      for (const entry of written) entry.ready = true;
    });
    return delivered;
  };

  return { fetch: fetchFake, calls };
}
