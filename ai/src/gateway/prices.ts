// The price table for a call's cost (NQ-AI-2's default: a table in ai/ config, cache reads and writes priced apart,
// the date and source recorded; the CTO confirms it before the first eval run).
//
// Prices are whole nano-dollars per token, so the arithmetic is exact: $0.10 per million tokens is 100 nano-USD a token.
// K-08 v1 holds a call's cost in whole micro-dollars (README default 7).

import { HAIKU_MODEL, SONNET_MODEL } from "./types";

export interface PriceRow {
  /** Input tokens that were neither read from nor written to the cache. */
  readonly input: number;
  /** Input tokens read from the prompt cache. */
  readonly cacheRead: number;
  /** Input tokens written to the prompt cache (the 5-minute write). */
  readonly cacheWrite: number;
  readonly output: number;
}

export interface PriceList {
  /** Where the numbers come from, and when they were read. */
  readonly source: string;
  readonly readOn: string;
  /** False until the CTO confirms the table (NQ-AI-2). */
  readonly confirmedByCto: boolean;
  readonly models: Readonly<Record<string, PriceRow>>;
}

/**
 * Input and output prices are the ones T-1068's findings list (Haiku 5.5 $0.10 in and $0.50 out, Sonnet 5.5 $2 in and
 * $10 out, per million tokens, read from Anthropic's price list on 2026-11-07). Cache reads are priced at a tenth of
 * input and 5-minute cache writes at 1.25 times input, Anthropic's published prompt-caching rule. Neither the cache
 * multipliers nor the table as a whole is confirmed by the CTO yet (NQ-AI-2).
 */
export const PRICE_LIST: PriceList = {
  source: "Anthropic's published price list, as listed in ai/spikes/decide-wire/FINDINGS.md",
  readOn: "2026-11-07",
  confirmedByCto: false,
  models: {
    [HAIKU_MODEL]: { input: 100, cacheRead: 10, cacheWrite: 125, output: 500 },
    [SONNET_MODEL]: { input: 2000, cacheRead: 200, cacheWrite: 2500, output: 10000 },
  },
};

export interface Usage {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

/** A call's cost in whole micro-dollars (rounded to the nearest), from its tokens and the price list in force. */
export function costMicroUsd(model: string, usage: Usage, prices: PriceList = PRICE_LIST): number {
  const row = prices.models[model];
  if (row === undefined) throw new RangeError(`no price for model ${model}`);
  const nano =
    usage.inputTokens * row.input +
    usage.cachedTokens * row.cacheRead +
    usage.cacheWriteTokens * row.cacheWrite +
    usage.outputTokens * row.output;
  return Math.round(nano / 1000);
}
