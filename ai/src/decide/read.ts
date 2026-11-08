// Decide, one read (T-368, C-115; arch 03 lines 181 to 189; arch 02 line 119; CQ-25, DL-089, T-1068).
//
// One read of one turn's K-02 v1 context, in the two-step wire form, the only one accepted live:
//
//   1. The context bundle (T-367) lays the context out with this read's seed: the bundle's decide prompt, the flow's
//      always-on rules and the turn's cards as the cached system prompt (T-364), the per-turn part as the user message.
//   2. Step 1, one call through the AI gateway (T-361, with T-364's cache markers): the per-turn part ends with
//      <step n="1"></step>; the answer (STAGE1_SCHEMA) is the text's language and each part's quote and verb. It is
//      checked, and each quote is confirmed in the turn's texts, before any step-2 call is spent.
//   3. Step 2, side by side, one call per part that is not no_op: the per-turn part ends with the parts step 1 found
//      and <step n="2" part="k"></step>; the answer (the verb's own K-02 schema less verb and quote) is that part's
//      fields. Each asks first the model that answered step 1, so a read stays on one model where it can.
//   4. Code maps the two into K-02 v1's `decideRead` (map.ts) and validates it before it leaves the AI layer
//      (check.ts): K-02's schema and the named rules optionOffered and quoteInText against the context.
//
// The answer is K-02's `read`: which model read it (the one that answered step 1), in which role, and the output with
// the text's language (CQ-07 default), or a typed refusal (an unmapped read: the turn's one re-read follows, arch 02
// line 119) or the gateway's modelsDown. Two reads and their agreement are T-369's; routing by stakes T-363's; the gate
// re-checks quotes and re-parses values from their words (T-298).
//
// Each gateway attempt writes its own K-08 portCall span; this read writes none of its own, and nothing here logs: the
// span facts it returns are T-367's seed and counts, and a refusal's problems name parts and fields, never words. The
// key is read from the environment by name at each call, by the gateway, and goes only into the x-api-key header.

import { createCachedGateway, type CachedPrompt } from "../cache";
import { sameBundleId } from "../cache/bundle";
import { buildContextPrompt, drawSeed } from "../context";
import { GatewayConfigError, type AttemptFailure, type GatewayEffort } from "../gateway";
import { partRuleProblems, readProblems, ruleView } from "./check";
import { DecideRequestError } from "./errors";
import { mapPart, readStageOne } from "./map";
import { stageOneTail, stageTwoTail } from "./prompt";
import { STAGE1_SCHEMA, STAGE2_SCHEMAS } from "./schema";
import {
  DECIDE_PURPOSES,
  ROLE_OF,
  type DecideContext,
  type DecidePart,
  type DecideRead,
  type DecideReadAnswer,
  type DecideReader,
  type DecideReaderOptions,
  type DecideReadRequest,
  type DecideCallOptions,
  type ModelCall,
} from "./types";

/** `output_config.effort` of both steps: what the spike measured, pinned so the cached prefix is read (T-364). */
export const DECIDE_EFFORT: GatewayEffort = "low";

/** The models a read may ask first: the bundle's two (K-01 v1 `modelRole`). */
const MODEL_ROLES: readonly string[] = ["haiku", "sonnet"];

/** The laid-out call with a step's tail after the per-turn part; the cached segments are untouched. */
function withTail(prompt: CachedPrompt, tail: string): CachedPrompt {
  return Object.freeze({ ...prompt, turn: `${prompt.turn}\n\n${tail}` });
}

/**
 * Builds decide's one read for one bundle: its id, its two model ids and its prompt layout. Refuses, before any call, a
 * bundle the AI gateway refuses (GatewayConfigError) and prompts of another bundle.
 */
export function createDecideReader(options: DecideReaderOptions): DecideReader {
  const { bundle, prompts, env } = options;
  const gateway = createCachedGateway({
    bundle,
    env,
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  if (!sameBundleId(prompts.bundleId, bundle.bundleId))
    throw new GatewayConfigError("decide's prompts are of another bundle than its models");

  return {
    async read(
      context: DecideContext,
      request: DecideReadRequest,
      callOptions: DecideCallOptions = {},
    ): Promise<DecideReadAnswer> {
      // The types say both; a caller that casts is still refused before any call.
      if (!(DECIDE_PURPOSES as readonly string[]).includes(request.purpose))
        throw new DecideRequestError(`a ${request.purpose} call is not a decide read`);
      if (!MODEL_ROLES.includes(request.model))
        throw new DecideRequestError("a decide read asks haiku or sonnet first");
      const seed = request.seed ?? drawSeed();
      // Refuses, before any call, a context it cannot lay out (ContextRefusedError) or of another bundle (CacheLayoutError).
      const built = buildContextPrompt(prompts, context, { purpose: request.purpose, seed });
      const base = {
        turnId: context.turnId,
        purpose: request.purpose,
        seed,
        choiceOrder: built.choiceOrder,
        span: built.span,
      };
      const texts = context.texts.map((text) => text.words);
      const modelCalls: ModelCall[] = [];

      // Step 1: the parts, their quotes and verbs, and the language.
      const first = await gateway.call(
        withTail(built.prompt, stageOneTail()),
        { role: request.model, schema: STAGE1_SCHEMA, effort: DECIDE_EFFORT },
        callOptions,
      );
      modelCalls.push(...first.modelCalls);
      if (first.status !== "ok")
        return { ...base, status: "modelsDown", stage: 1, failures: first.failures, modelCalls };
      const head = readStageOne(first.output, texts);
      if (!head.ok) {
        return {
          ...base,
          status: "refused",
          stage: 1,
          problems: head.problems,
          unmappedParts: head.unmappedParts,
          modelCalls,
        };
      }

      // Step 2: each part's fields, side by side, on the model that answered step 1.
      const answers = await Promise.all(
        head.parts.map((part, k) =>
          part.verb === "no_op"
            ? Promise.resolve(null)
            : gateway.call(
                withTail(built.prompt, stageTwoTail(head.parts, k)),
                { role: first.role, schema: STAGE2_SCHEMAS[part.verb], effort: DECIDE_EFFORT },
                callOptions,
              ),
        ),
      );
      const failures: AttemptFailure[] = [];
      let down = false;
      for (const answer of answers) {
        if (answer === null) continue;
        modelCalls.push(...answer.modelCalls);
        if (answer.status !== "ok") {
          down = true;
          failures.push(...answer.failures);
        }
      }
      if (down) return { ...base, status: "modelsDown", stage: 2, failures, modelCalls };

      // Each part as K-02 writes it, checked against K-02's part and both named rules: every part that fails is named.
      const view = ruleView(context);
      const problems: string[] = [];
      const unmappedParts: number[] = [];
      const parts: DecidePart[] = [];
      head.parts.forEach((part, k) => {
        const answer = answers[k];
        const mapped = mapPart(part, answer?.status === "ok" ? answer.output : undefined, k, texts);
        const lines = mapped.ok
          ? partRuleProblems(view, mapped.part, `parts[${String(k)}]`)
          : mapped.problems;
        if (mapped.ok) parts.push(mapped.part);
        if (lines.length > 0) {
          problems.push(...lines);
          unmappedParts.push(k);
        }
      });
      if (problems.length > 0)
        return { ...base, status: "refused", stage: 2, problems, unmappedParts, modelCalls };
      // The last gate before the read leaves the AI layer: the whole read against K-02's schema and the named rules.
      const output: DecideRead = { language: head.language, parts };
      const final = readProblems(context, output);
      if (final.length > 0)
        return { ...base, status: "refused", stage: 2, problems: final, unmappedParts: [], modelCalls };
      return {
        ...base,
        status: "ok",
        read: { model: first.role, role: ROLE_OF[request.purpose], output },
        language: output.language,
        fallback: first.fallback || answers.some((answer) => answer?.status === "ok" && answer.fallback),
        modelCalls,
      };
    },
  };
}
