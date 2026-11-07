// The AI gateway (T-361, C-121; arch 06 "A model call fails" and figure "AI gateway"; arch 04 line 231).
//
// Every model call but the safety read goes through here. One call is up to three attempts:
//   1. the first model (the request's `role`), with the stage's timeout;
//   2. the same model once more (the one retry);
//   3. the other model once.
// If all three fail the result is the typed `modelsDown`; what the runtime does with it is T-271's. A call times out at
// twice its stage's upper budget (arch 04 latency table): decide 8 s, re-read 12 s, composer 6 s, and the planner 12 s
// (NQ-AI-1's default: the re-read's budget).
//
// What the gateway guarantees:
//   - Only the two model ids of arch 11 line 564 can be called, only at api.anthropic.com's Messages endpoint. The
//     bundle names the ids; a bundle naming another id is refused at set-up, and the body's id is checked again before
//     every send.
//   - The key is read from the environment by name (ANTHROPIC_API_KEY) at the moment of each call, goes only into the
//     x-api-key header, and appears in no result, span, error or log line. A provider's error text is never kept: a
//     failure is a label (`timeout`, `http_529`, `refusal` ...).
//   - `stop_reason` is checked before an output is parsed: a refusal, a cut-off (max_tokens) or any stop but end_turn
//     is a failed call, never a read (arch 06; ai/spikes/decide-wire/FINDINGS.md).
//   - Each attempt writes one K-08 v1 span into the turn's trace (a `portCall` to provider `anthropic`, call
//     `messages`, the attempt's number), with one model call: tokens, cached tokens, cache-write tokens, cost and time.
//     A span holds labels and counts only, never the prompt or the answer.
//
// The gateway changes no prompt and no answer: it sends the request's system text, user text and schema as given. The
// two-call decide of CQ-25 (stage 1, then one stage-2 call per part, side by side) is C-115's: each is one `call` here
// and retries and falls back on its own.

import { bundleIdProblems } from "../../../runtime/src/trace";
import { GatewayConfigError, MissingKeyError, NotForTheGatewayError } from "./errors";
import { costMicroUsd, type Usage } from "./prices";
import {
  ALLOWED_MODELS,
  GATEWAY_PURPOSES,
  HAIKU_MODEL,
  SONNET_MODEL,
  STAGE_OF,
  type AttemptFailure,
  type CallOptions,
  type FailureCode,
  type FetchLike,
  type Gateway,
  type GatewayOptions,
  type GatewayRequest,
  type GatewayResult,
  type GatewayStage,
  type ModelCall,
  type ModelRole,
} from "./types";

/** The only endpoint the gateway calls (no other provider is ever called: arch 11 line 564). */
export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
/** The environment variable the key is read from. */
export const KEY_VARIABLE = "ANTHROPIC_API_KEY";
export const DEFAULT_MAX_TOKENS = 4096;

/** Twice each stage's upper budget (arch 04 latency table and line 231); the planner's is NQ-AI-1's default. */
export const STAGE_TIMEOUT_MS: Readonly<Record<GatewayStage, number>> = {
  decide: 8000,
  reread: 12000,
  planner: 12000,
  composer: 6000,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

const httpCode = (status: number): FailureCode => `http_${String(status)}`;

const otherRole = (role: ModelRole): ModelRole => (role === "haiku" ? "sonnet" : "haiku");

/** What one attempt came back with, before it is written up as a model call and a span. */
type Attempt =
  | { readonly ok: true; readonly output: unknown; readonly usage: Usage }
  | { readonly ok: false; readonly code: FailureCode; readonly usage: Usage };

const NO_USAGE: Usage = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

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
function readAnswer(body: unknown): Attempt {
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

function requestBody(request: GatewayRequest, model: string): string {
  return JSON.stringify({
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: [{ role: "user", content: request.user }],
    output_config: {
      effort: request.effort ?? "low",
      format: { type: "json_schema", schema: request.schema },
    },
  });
}

/**
 * One request to the Messages endpoint inside the stage's time. The timer aborts the request and also settles the
 * race itself, so a `fetch` that ignores its signal still times out on time.
 */
async function send(
  fetchImpl: FetchLike,
  key: string,
  body: string,
  timeoutMs: number,
): Promise<Attempt | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const exchange = async (): Promise<Attempt> => {
    try {
      const response = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": API_VERSION },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status !== 200) {
        return { ok: false, code: httpCode(response.status), usage: NO_USAGE };
      }
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
    return await Promise.race([exchange(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function checkModels(options: GatewayOptions): void {
  const { models, bundleId } = options.bundle;
  const problems = bundleIdProblems(bundleId);
  if (models.haiku !== HAIKU_MODEL) problems.push(`models.haiku is not ${HAIKU_MODEL}`);
  if (models.sonnet !== SONNET_MODEL) problems.push(`models.sonnet is not ${SONNET_MODEL}`);
  if (problems.length > 0) throw new GatewayConfigError(`the bundle cannot be used: ${problems.join("; ")}`);
}

/** Builds the gateway for one bundle (its id and its two model ids, K-01 v1). */
export function createGateway(options: GatewayOptions): Gateway {
  checkModels(options);
  const { bundle, env } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const modelOf = (role: ModelRole): string =>
    role === "haiku" ? bundle.models.haiku : bundle.models.sonnet;

  return {
    async call(request: GatewayRequest, callOptions: CallOptions = {}): Promise<GatewayResult> {
      if (!(GATEWAY_PURPOSES as readonly string[]).includes(request.purpose)) {
        throw new NotForTheGatewayError(request.purpose);
      }
      const trace = callOptions.trace;
      if (
        trace !== undefined &&
        (trace.bundleId.hash !== bundle.bundleId.hash || trace.bundleId.build !== bundle.bundleId.build)
      ) {
        throw new GatewayConfigError("the trace is of another bundle than the gateway's");
      }
      const key = env[KEY_VARIABLE];
      if (key === undefined || key === "") throw new MissingKeyError(KEY_VARIABLE);

      const stage = STAGE_OF[request.purpose];
      const timeoutMs = STAGE_TIMEOUT_MS[stage];
      const plan: readonly { role: ModelRole; fallback: boolean }[] = [
        { role: request.role, fallback: false },
        { role: request.role, fallback: false },
        { role: otherRole(request.role), fallback: true },
      ];
      const modelCalls: ModelCall[] = [];
      const failures: AttemptFailure[] = [];

      for (const [index, step] of plan.entries()) {
        const attempt = index + 1;
        const model = modelOf(step.role);
        if (!(ALLOWED_MODELS as readonly string[]).includes(model)) {
          throw new GatewayConfigError(`model ${model} is not one the gateway may call`);
        }
        const startedAt = Date.now();
        const sent = await send(fetchImpl, key, requestBody(request, model), timeoutMs);
        const ms = Math.max(0, Date.now() - startedAt);
        const result: Attempt = sent === "timeout" ? { ok: false, code: "timeout", usage: NO_USAGE } : sent;

        const modelCall: ModelCall = {
          model,
          role: step.role,
          purpose: request.purpose,
          input_tokens: result.usage.inputTokens,
          cached_tokens: result.usage.cachedTokens,
          cache_write_tokens: result.usage.cacheWriteTokens,
          output_tokens: result.usage.outputTokens,
          cost_micro_usd: costMicroUsd(model, result.usage),
          ms,
          outcome: result.ok ? "ok" : result.code === "timeout" ? "timedOut" : "failed",
        };
        modelCalls.push(modelCall);
        trace?.record({
          hop: "portCall",
          at: new Date(startedAt).toISOString(),
          ms,
          outcome: modelCall.outcome,
          ...(callOptions.businessId !== undefined && { businessId: callOptions.businessId }),
          ...(callOptions.eventId !== undefined && { eventId: callOptions.eventId }),
          provider: "anthropic",
          call: "messages",
          attempt,
          got: { purpose: request.purpose, stage },
          decided: { role: step.role, fallback: step.fallback },
          modelCalls: [modelCall],
          errorCode: result.ok ? null : result.code,
        });

        if (result.ok) {
          return {
            status: "ok",
            purpose: request.purpose,
            output: result.output,
            model,
            role: step.role,
            attempt,
            fallback: step.fallback,
            modelCalls,
            failures,
          };
        }
        failures.push({ model, role: step.role, attempt, code: result.code });
      }
      return { status: "modelsDown", purpose: request.purpose, modelCalls, failures };
    },
  };
}
