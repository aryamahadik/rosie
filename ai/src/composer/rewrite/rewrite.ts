// The composer's one rewrite (T-374, C-118; arch 02 step 7, architecture.txt line 123: "One rewrite, told what failed.
// Fails again: the step's fallback text, Jay's reviewed one or else its master line with slots filled, through the same
// checks"; arch 07 line 417). Given what failed in a check result, as the action layer's rewriteTold gives it:
//
//   1. The request is checked before any call (request.ts). A told from the one rewrite's own failure is the second
//      failure: 'use the fallback' (why rewriteFailed), with no call, so there is never a third model call for a row.
//   2. One call through the AI gateway (T-361) with T-364's layout, purpose `rewrite`: the composer's own cached system
//      prompt, unchanged, then the per-turn part (turn.ts): the row's input as compose sent it, the plan to fix and the
//      failed checks, each as data, and code's rewrite task with its two rules (fixed lines are code's; never a money
//      sentence of the model's own). Haiku first, at compose's effort and with K-03's plan schema, as compose, so the
//      call reads the prefix compose cached. The gateway's purpose `rewrite` is the composer's stage, so each attempt
//      times out at the composer's 6 s (STAGE_OF.rewrite, STAGE_TIMEOUT_MS.composer); it retries Haiku once, then asks
//      Sonnet once, then answers modelsDown.
//   3. The answer is checked as compose checks every plan (check.ts planAgainstInput). One that fails is the rewrite
//      failing too: 'use the fallback' (why rewriteRefused), never a plan and never a second rewrite.
//
// What follows 'use the fallback' is the action layer's (C-093, inside finalizeMessage; the fallback text and "I've passed
// this on" are not here). Each gateway attempt writes its own K-08 portCall span (labels and counts only); the rewrite
// writes none of its own, and nothing here logs. A refusal names checks and places, never words.

import type { CachedGateway, PromptCache } from "../../cache";
import type { GatewayEffort, ModelRole } from "../../gateway";
import { planAgainstInput } from "../check";
import type { MessagePlan } from "../prompt";
import { PLAN_SCHEMA } from "../schema";
import type { ComposeCallOptions } from "../types";
import { checkRequest } from "./request";
import { rewriteTurnText } from "./turn";
import type { RewriteAnswer, RewriteRequest } from "./types";

/** What the rewrite calls with: the composer's own gateway, prompt layout, first model and effort. */
export interface RewriteDeps {
  readonly gateway: CachedGateway;
  readonly prompts: PromptCache;
  readonly role: ModelRole;
  readonly effort: GatewayEffort;
}

/** The composer's rewrite: one call for a composed plan's failed checks, and none after that. */
export type Rewrite = (request: RewriteRequest, options?: ComposeCallOptions) => Promise<RewriteAnswer>;

/** Builds the rewrite over the composer's gateway and layout (createComposer does, for its `rewrite`). */
export function createRewrite(deps: RewriteDeps): Rewrite {
  return async (request, callOptions = {}) => {
    const checked = checkRequest(request);
    if (checked.kind === "secondFailure")
      return { status: "useFallback", why: "rewriteFailed", problems: [], modelCalls: [] };
    if (checked.kind === "refused")
      return { status: "refused", stage: checked.stage, problems: checked.problems, modelCalls: [] };

    const { input, plan, told } = checked.request;
    const prompt = deps.prompts.layout({ purpose: "rewrite", turn: rewriteTurnText(input, plan, told) });
    const answer = await deps.gateway.call(
      prompt,
      { role: deps.role, schema: PLAN_SCHEMA, effort: deps.effort },
      callOptions,
    );
    if (answer.status !== "ok")
      return { status: "modelsDown", failures: answer.failures, modelCalls: answer.modelCalls };

    const problems = planAgainstInput(answer.output, input);
    if (problems.length > 0)
      return { status: "useFallback", why: "rewriteRefused", problems, modelCalls: answer.modelCalls };
    return {
      status: "ok",
      plan: answer.output as MessagePlan,
      model: answer.model,
      role: answer.role,
      attempt: answer.attempt,
      fallback: answer.fallback,
      modelCalls: answer.modelCalls,
    };
  };
}
