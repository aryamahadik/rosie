// One request to the Messages endpoint inside a time limit, with no retry (T-365): the safety read's own path, outside
// the AI gateway (arch 06 figure "AI gateway": "every call but the safety read"; arch 04 line 231: "except the safety
// read at 2 s per model, so its line still meets 5 s").
//
// It is the AI gateway's exchange (T-361, ai/src/gateway/gateway.ts `send`, `readAnswer`, `usageOf`) without its retry
// plan: the same endpoint, version and headers, the key only in x-api-key, the same timer that aborts the request and
// settles the race itself, and `stop_reason` checked before the answer is parsed (a refusal, a cut-off or any stop but
// end_turn is a failed call, never a read). The gateway keeps those functions to itself, and this task may change only
// ai/src/safety, so they are repeated here line for line rather than imported; one shared copy is a follow-up for
// ai/src/gateway. A failure is a label, never the provider's words.

import { API_URL, API_VERSION, type FailureCode, type FetchLike, type Usage } from "../gateway";

/** What one exchange came back with. */
export type Exchange =
  | { readonly ok: true; readonly output: unknown; readonly usage: Usage }
  | { readonly ok: false; readonly code: FailureCode; readonly usage: Usage };

export const NO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

function usageOf(body: unknown): Usage {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    inputTokens: count(usage.input_tokens),
    cachedTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

/** The response of a 200: its stop reason first, then its first text block parsed as JSON. */
function readAnswer(body: unknown): Exchange {
  const usage = usageOf(body);
  if (!isRecord(body)) return { ok: false, code: "bad_output", usage };
  const stop = body.stop_reason;
  if (stop === "refusal") return { ok: false, code: "refusal", usage };
  if (stop === "max_tokens") return { ok: false, code: "max_tokens", usage };
  if (stop !== "end_turn") return { ok: false, code: "bad_stop", usage };
  const content = Array.isArray(body.content) ? (body.content as unknown[]) : [];
  const block = content.find((item) => isRecord(item) && item.type === "text");
  if (!isRecord(block) || typeof block.text !== "string") return { ok: false, code: "bad_output", usage };
  try {
    return { ok: true, output: JSON.parse(block.text) as unknown, usage };
  } catch {
    return { ok: false, code: "bad_output", usage };
  }
}

/**
 * One request to the Messages endpoint inside `timeoutMs`. The timer aborts the request and also settles the race
 * itself, so a `fetch` that ignores its signal still times out on time: `{ ok: false, code: "timeout" }`.
 */
export async function exchange(
  fetchImpl: FetchLike,
  key: string,
  body: string,
  timeoutMs: number,
): Promise<Exchange> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Exchange>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, code: "timeout", usage: NO_USAGE });
    }, timeoutMs);
  });
  const call = async (): Promise<Exchange> => {
    try {
      const response = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status !== 200)
        return { ok: false, code: `http_${String(response.status)}`, usage: NO_USAGE };
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { ok: false, code: "bad_output", usage: NO_USAGE };
      }
      return readAnswer(parsed);
    } catch {
      return { ok: false, code: "network", usage: NO_USAGE };
    }
  };
  try {
    return await Promise.race([call(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
