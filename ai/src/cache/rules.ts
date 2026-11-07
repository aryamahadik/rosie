// Anthropic's prompt-caching rules for the two models the gateway may call (T-364, C-122), as Anthropic publishes them:
// "Prompt caching", https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md, read 2026-11-07, and
// "Structured outputs", https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md, read 2026-11-07.
//
//   - Caching is a prefix match. A request is rendered tools, then system, then messages; a `cache_control` marker on a
//     block caches everything up to and including that block, and one changed byte before a marker misses it.
//   - At most 4 markers in one request.
//   - A prefix shorter than the model's minimum is not cached, silently: 512 tokens for claude-haiku-5-5 and
//     claude-sonnet-5-5.
//   - `{ type: "ephemeral" }` lives 5 minutes, counted from the start of the request that writes or reads it, and each
//     read refreshes it at no cost. A 1-hour lifetime exists at twice the input price for a write; this layout does not
//     use it, because the gateway's price table prices only the 5-minute write (NQ-AI-2).
//   - Caches are per model, and the structured-output format is part of the prompt ("Changing the output_config.format
//     parameter will invalidate any prompt cache"), so each model and each stage's schema keeps its own entries; a
//     changed `effort` also misses. A stage keeps one schema and one effort, so its entries are read turn after turn.
//   - An entry can be read only once the response that writes it has started: calls sent side by side each write.
//   - The usage of a response gives `cache_read_input_tokens` (read), `cache_creation_input_tokens` (written) and
//     `input_tokens` (the rest, after the last marker); the gateway's K-08 span holds them as `cached_tokens`,
//     `cache_write_tokens` and `input_tokens`.

import { HAIKU_MODEL, SONNET_MODEL } from "../gateway";

/** The marker on the last block of each cached segment: the default 5-minute lifetime. */
export interface CacheMarker {
  readonly type: "ephemeral";
}

export const CACHE_MARKER: CacheMarker = Object.freeze({ type: "ephemeral" });

/** The shortest prefix each model caches, in tokens, by model id; a shorter one is sent uncached, with no error. */
const MIN_CACHEABLE_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  [HAIKU_MODEL]: 512,
  [SONNET_MODEL]: 512,
});

export const CACHE_RULES = Object.freeze({
  source:
    "Anthropic, Prompt caching (https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) and Structured outputs (https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md)",
  readOn: "2026-11-07",
  /** Markers one request may carry. */
  maxBreakpoints: 4,
  minCacheableTokens: MIN_CACHEABLE_TOKENS,
  /** The lifetime of an `ephemeral` entry, refreshed by every read. */
  ttlMs: 5 * 60 * 1000,
});
