// The composer's call (T-373, C-118; arch 07 "Decide, then word", architecture.txt line 397; arch 02 line 123).
//
// "After the commit, each outbox row gets its own composer call, in parallel, with its committed choices and only what
// limit 7 lets its recipient see, never the frontier ... It returns the plan as structured output." One row is:
//
//   1. The input is checked as a K-03 v1 composeInput (check.ts): one carrying the frontier, or any other field, is a
//      typed refusal before any call.
//   2. One call through the AI gateway (T-361) with T-364's cache markers, Haiku first: the bundle's composer prompt
//      (T-372, K-01 manifest.prompts.composer) is the cached system prompt, and the row's tagged input
//      (composeInputText, every value escaped as data: S13-54 rule 67) is the per-turn part. The structured-output
//      schema is K-03's plan, bundled and static (schema.ts). The gateway retries Haiku once, then asks Sonnet once,
//      then answers modelsDown.
//   3. The answer is checked before it leaves the AI layer (check.ts): a K-03 v1 plan; its formats from the row's
//      allowedFormats; no number, date or price typed in its words that no fact of the row holds. Any failure is a
//      typed refusal, never a plan.
//
// Rows of one turn are composed side by side by calling compose once per row (each call is independent). An email copy
// takes its text row's plan instead of a call (arch 07 line 397); filling slots, fixed lines, the message checks and the
// one rewrite are the action layer's (C-088, C-089, C-091 to C-093).
//
// Each gateway attempt writes its own K-08 portCall span (labels and counts only); the composer writes none of its own,
// and nothing here logs. A refusal names checks and places, never words (K-08 README line 75). The key is read from the
// environment by name at each call, by the gateway, and goes only into the x-api-key header.

import { createCachedGateway } from "../cache";
import { sameBundleId } from "../cache/bundle";
import { GatewayConfigError, type GatewayEffort, type ModelRole } from "../gateway";
import { inputProblems, planAgainstInput } from "./check";
import { composeInputText } from "./prompt";
import { PLAN_SCHEMA } from "./schema";
import type {
  ComposeAnswer,
  ComposeCallOptions,
  ComposeInput,
  Composer,
  ComposerOptions,
  MessagePlan,
} from "./types";

/** The model asked first for every row: one Haiku call per outbox row (the card; arch 11 line 564). */
export const COMPOSE_ROLE: ModelRole = "haiku";
/** `output_config.effort`, pinned so the cached prefix is read call after call (T-364); "low" is what the spikes measured. */
export const COMPOSE_EFFORT: GatewayEffort = "low";

/**
 * Builds the composer for one bundle: its id, its two model ids and its prompt layout. Refuses, before any call, a
 * bundle the AI gateway refuses (GatewayConfigError) and prompts of another bundle.
 */
export function createComposer(options: ComposerOptions): Composer {
  const { bundle, prompts, env } = options;
  const gateway = createCachedGateway({
    bundle,
    env,
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  if (!sameBundleId(prompts.bundleId, bundle.bundleId))
    throw new GatewayConfigError("the composer's prompts are of another bundle than its models");

  return {
    async compose(input: ComposeInput, callOptions: ComposeCallOptions = {}): Promise<ComposeAnswer> {
      // The types say K-03's input; a caller that casts is still refused before any call.
      const before = inputProblems(input);
      if (before.length > 0) return { status: "refused", stage: "input", problems: before, modelCalls: [] };

      const prompt = prompts.layout({ purpose: "compose", turn: composeInputText(input) });
      const answer = await gateway.call(
        prompt,
        { role: COMPOSE_ROLE, schema: PLAN_SCHEMA, effort: COMPOSE_EFFORT },
        callOptions,
      );
      if (answer.status !== "ok")
        return { status: "modelsDown", failures: answer.failures, modelCalls: answer.modelCalls };

      const problems = planAgainstInput(answer.output, input);
      if (problems.length > 0)
        return { status: "refused", stage: "plan", problems, modelCalls: answer.modelCalls };
      return {
        status: "ok",
        plan: answer.output as MessagePlan,
        model: answer.model,
        role: answer.role,
        attempt: answer.attempt,
        fallback: answer.fallback,
        modelCalls: answer.modelCalls,
      };
    },
  };
}
