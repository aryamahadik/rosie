// The safety read (T-365, C-113; steps A3-22 and B3-17; arch 02 step S, line 111, and step Q, line 129; arch 06 lines
// 283 and 315 to 329).
//
// Each raw text, on arrival and before batching, and each piece of free text from a secure page or an outside AI, is
// read for danger by meaning: Haiku first, then Sonnet if Haiku fails or times out, one 2 s try each, outside the AI
// gateway (arch 06 line 283; arch 04 line 231). The answer is K-02 v1's `safetyResult`, with the model's labels from
// the 8 outcomes (several per text, each with its tense, evidence words, who is at risk and who wrote it) and the
// model calls made, which is what the handle actor's safety-read port takes (T-246, runtime/src/safety/types.ts).
//
//   - A verdict is the first try whose answer is a K-02 `safetyRead`; a refusal, a cut-off, a failed call, an answer
//     that is not a K-02 read, or 2 s without an answer fails that try. Sonnet's try runs only when Haiku's failed.
//   - Both failed: no verdict (`read` null, `timedOut` true), given when 4 s have passed since the call, however fast
//     the tries failed: it is the marker of no verdict in 4 s (arch 02 line 111). So the actor's own 4 s deadline,
//     which started at the text's arrival, comes first, and its no-verdict rule (a danger word from the bundle's list
//     gets the safety line, any other text the outage line; T-246) is what applies; a marker that carries the danger
//     words itself is T-366's.
//   - The outcomes that hold are the labels' danger outcomes, each once, in the labels' order, where a label whose
//     tense is over or joke is not danger and Unsure always is (arch 06 line 329; A3-22: "Safe default: unsure is read
//     as danger"); with none, No. Code's danger words are T-366's: this read matches none, so `dangerWords` is empty,
//     `liftedToUnsure` false, and a no-verdict answer is the plain marker with no outcome.
//   - Each model call writes one K-08 v1 span into the text's trace, as the gateway writes its own: a `portCall` to
//     provider anthropic, call messages, attempt 1 (Haiku) or 2 (Sonnet), with its one model call (purpose safetyRead:
//     tokens, cached tokens, cache-write tokens, cost and time). A span holds labels and counts only, never the text,
//     a quote, a name or the key (K-08 README "Never the raw number or words"); per CQ-36's default, the cost meter
//     counts these portCall spans, not the actor's safetyRead hop.
//   - The key is read from the environment by name at each call and goes only into the x-api-key header (the gateway's
//     rule). Nothing here writes a message: code sends the outcome's checked line (BP rule 3).

import {
  ALLOWED_MODELS,
  DEFAULT_MAX_TOKENS,
  GatewayConfigError,
  KEY_VARIABLE,
  MissingKeyError,
  costMicroUsd,
  createGateway,
  type FetchLike,
  type ModelRole,
} from "../gateway";
import { messagesParams } from "../cache";
import { isLabel, type BundleId } from "../../../runtime/src/trace";
import { safetyReadTurn } from "./prompt";
import { SAFETY_READ_SCHEMA, safetyReadProblems } from "./schema";
import { exchange, type Exchange } from "./wire";
import {
  NOT_DANGER_TENSES,
  type ModelCall,
  type SafetyOutcome,
  type SafetyRead,
  type SafetyReadAnswer,
  type SafetyReadCallOptions,
  type SafetyReadInput,
  type SafetyReader,
  type SafetyReaderOptions,
  type SafetyResult,
  type SafetyTry,
} from "./types";

/** One try per model: 2 s (arch 02 line 111: "One 2 s try per model"; arch 04 line 231). */
export const SAFETY_TRY_MS = 2000;
/** When an answer with no verdict is given: 4 s after the call (arch 02 line 111: "No verdict in 4 s"). */
export const SAFETY_VERDICT_MS = 2 * SAFETY_TRY_MS;
/** Haiku, then Sonnet (arch 06 line 283). */
export const SAFETY_MODEL_ORDER: readonly ModelRole[] = ["haiku", "sonnet"];
/** `output_config.effort`: what the structured-output spikes measured, pinned so the cached prefix is read. */
export const SAFETY_EFFORT = "low";

const sameBundle = (a: BundleId, b: BundleId): boolean => a.hash === b.hash && a.build === b.build;

/** Resolves once `ms` milliseconds have passed since `since` (epoch ms), or at once when they have. */
function until(since: number, ms: number): Promise<void> {
  const left = since + ms - Date.now();
  if (left <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, left);
  });
}

/**
 * The outcomes that hold for a read, before code's danger-word rules (T-366): each label's danger outcome, once, in the
 * labels' order. A label whose tense is over or joke is not danger (arch 06 line 329); Unsure is danger whatever its
 * tense (A3-22: "call it a joke when unsure" is never done; "unsure is read as danger"). No danger: No.
 */
export function heldOutcomes(read: SafetyRead): SafetyOutcome[] {
  const held: SafetyOutcome[] = [];
  for (const label of read.labels) {
    if (label.outcome === "No") continue;
    const danger = label.outcome === "Unsure" || !NOT_DANGER_TENSES.includes(label.tense);
    if (danger && !held.includes(label.outcome)) held.push(label.outcome);
  }
  return held.length > 0 ? held : ["No"];
}

/** K-02's result for a verdict. Danger words and their lift are T-366's: none here. */
function verdictResult(input: SafetyReadInput, tries: SafetyTry[], read: SafetyRead): SafetyResult {
  return {
    eventId: input.eventId,
    source: input.source,
    tries,
    read,
    timedOut: false,
    dangerWords: [],
    outcomes: heldOutcomes(read),
    liftedToUnsure: false,
  };
}

/** K-02's result with no verdict: the plain marker, no read and no outcome; a danger word's Unsure is T-366's. */
function noVerdictResult(input: SafetyReadInput, tries: SafetyTry[]): SafetyResult {
  return {
    eventId: input.eventId,
    source: input.source,
    tries,
    read: null,
    timedOut: true,
    dangerWords: [],
    outcomes: [],
    liftedToUnsure: false,
  };
}

/** A try's answer as it counts: a 200 whose output is not a K-02 safety read is a failed try (bad_output). */
function checked(answer: Exchange): Exchange {
  if (!answer.ok) return answer;
  return safetyReadProblems(answer.output).length === 0
    ? answer
    : { ok: false, code: "bad_output", usage: answer.usage };
}

/**
 * Builds the safety read for one bundle: its id, its two model ids and its safety read prompt. Refuses, before any
 * call, a bundle the AI gateway refuses (GatewayConfigError), prompts of another bundle, and a bundle whose safety read
 * prompt is empty (T-364's CacheLayoutError).
 */
export function createSafetyReader(options: SafetyReaderOptions): SafetyReader {
  const { bundle, prompts, env } = options;
  // The AI gateway's own set-up checks: a K-01 bundle id, and exactly claude-haiku-5-5 and claude-sonnet-5-5 (T-361).
  // Building it makes no call; the safety read never goes through it.
  createGateway({ bundle, env });
  if (!sameBundle(prompts.bundleId, bundle.bundleId))
    throw new GatewayConfigError("the safety read's prompts are of another bundle than its models");
  // A bundle with no safety read prompt fails here, at set-up, rather than on a text.
  prompts.layout({ purpose: "safetyRead", turn: safetyReadTurn({ source: "text", text: "" }) });
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const modelOf = (role: ModelRole): string =>
    role === "haiku" ? bundle.models.haiku : bundle.models.sonnet;

  return {
    async read(input: SafetyReadInput, callOptions: SafetyReadCallOptions = {}): Promise<SafetyReadAnswer> {
      const trace = callOptions.trace;
      if (trace !== undefined && !sameBundle(trace.bundleId, bundle.bundleId))
        throw new GatewayConfigError("the trace is of another bundle than the safety read's");
      const key = env[KEY_VARIABLE];
      if (key === undefined || key === "") throw new MissingKeyError(KEY_VARIABLE);
      const calledAt = Date.now();

      // The bundle's safety read prompt as the cached system prompt, the text after it (T-364's layout).
      const prompt = prompts.layout({ purpose: "safetyRead", turn: safetyReadTurn(input) });
      const { system, messages } = messagesParams(prompt);
      const tries: SafetyTry[] = [];
      const modelCalls: ModelCall[] = [];

      for (const [index, role] of SAFETY_MODEL_ORDER.entries()) {
        const model = modelOf(role);
        if (!(ALLOWED_MODELS as readonly string[]).includes(model))
          throw new GatewayConfigError(`model ${model} is not one the safety read may call`);
        const body = JSON.stringify({
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system,
          messages,
          output_config: {
            effort: SAFETY_EFFORT,
            format: { type: "json_schema", schema: SAFETY_READ_SCHEMA },
          },
        });
        const startedAt = Date.now();
        const answer = checked(await exchange(fetchImpl, key, body, SAFETY_TRY_MS));
        const ms = Math.max(0, Date.now() - startedAt);

        const modelCall: ModelCall = {
          model,
          role,
          purpose: "safetyRead",
          input_tokens: answer.usage.inputTokens,
          cached_tokens: answer.usage.cachedTokens,
          cache_write_tokens: answer.usage.cacheWriteTokens,
          output_tokens: answer.usage.outputTokens,
          cost_micro_usd: costMicroUsd(model, answer.usage),
          ms,
          outcome: answer.ok ? "ok" : answer.code === "timeout" ? "timedOut" : "failed",
        };
        modelCalls.push(modelCall);
        tries.push({
          model: role,
          result: answer.ok ? "verdict" : answer.code === "timeout" ? "timeout" : "error",
        });

        // One span per call. A span that cannot be written never stops a safety read: the verdict stands without it.
        try {
          trace?.record({
            hop: "portCall",
            at: new Date(startedAt).toISOString(),
            ms,
            outcome: modelCall.outcome,
            ...(callOptions.businessId !== undefined && { businessId: callOptions.businessId }),
            ...(isLabel(input.eventId) && { eventId: input.eventId }),
            provider: "anthropic",
            call: "messages",
            attempt: index + 1,
            got: { purpose: "safetyRead", source: input.source },
            decided: { role, fallback: index > 0, verdict: answer.ok },
            modelCalls: [modelCall],
            errorCode: answer.ok ? null : answer.code,
          });
        } catch {
          // Left out of the trace; the read goes on.
        }

        if (answer.ok) {
          return { result: verdictResult(input, tries, answer.output as SafetyRead), modelCalls };
        }
      }
      // No verdict: the marker is given at the 4 s mark, never before (see the head of this file).
      await until(calledAt, SAFETY_VERDICT_MS);
      return { result: noVerdictResult(input, tries), modelCalls };
    },
  };
}
