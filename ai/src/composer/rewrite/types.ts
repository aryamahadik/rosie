// Types of the composer's one rewrite (T-374, C-118; arch 02 step 7, architecture.txt line 123: "One rewrite, told what
// failed. Fails again: the step's fallback text ..."; arch 07 lines 405 to 417).
//
// What the rewrite is told is the action layer's rewriteTold (actions/src/finalize/rewrite/told.ts, T-313): each check the
// attempt missed, in K-03's order, with its detail, every filled value written as its {{slot}} (DL-158 ruling c). That is
// the whole of what the model is told about the failure (K-09 v1 finalizeMessage.response.checks: "for the one rewrite,
// C-118 sends the model only each failed check and its detail"; STATE note 35): never the final parts it checked, whose
// slot values the composer never got, and never a raw check detail. The shapes are written by hand, as the rest of the
// composer's are (./prompt/types.ts): the generated contract types are git-ignored (ADR-005) and the Worker must not
// depend on them; the tests hold them to K-03 and to rewriteTold itself.

import type { AttemptFailure, ModelCall } from "../../gateway";
import type { ComposeInput, MessagePlan } from "../prompt";
import type { ComposeOk, ComposeProblem } from "../types";

/** A check on every message (K-03 `checkName`; arch 07 lines 405 to 417), as the told names it. */
export type CheckName =
  "fixedLines" | "values" | "oneQuestion" | "neverInMessage" | "shape" | "lengthAndReading" | "format";

/** One failed check as the rewrite is told it (rewriteTold's `Told`): the check and its detail, no filled value in it. */
export interface Told {
  readonly check: CheckName;
  readonly detail: string;
}

/**
 * Which attempt the told comes from (K-03 `checkResult.attempt`): `composed`, the composer's own plan, gets the one
 * rewrite; `rewrite`, the one rewrite failing too, is the second failure, which gets 'use the fallback' and no call. A
 * `fallback` attempt is the step's fallback text, never the composer's: the composer is never asked about it.
 */
export type FailedAttempt = "composed" | "rewrite";

/** What the one rewrite is given: the row's input, the plan that failed, which attempt that was, and what failed. */
export interface RewriteRequest {
  /** The row's K-03 v1.1 composer input, the same one the plan was composed from (checked again, as compose checks it). */
  readonly input: ComposeInput;
  /** The plan that failed, as the composer returned it, with its slots (never the final parts, whose slots are filled). */
  readonly plan: MessagePlan;
  /** The attempt whose check result the told comes from. */
  readonly attempt: FailedAttempt;
  /** What rewriteTold gives for that check result: each failed check, at most once, with its detail. */
  readonly told: readonly Told[];
}

/**
 * Why a rewrite request is refused before any call: a label and a place, never words (K-08 README line 75).
 *
 *   attempt    the attempt is not `composed` or `rewrite`;
 *   request    the request is not an object, or has a field besides input, plan, attempt and told (such as the final
 *              parts a check result holds, whose slot values the composer never got);
 *   planToFix  the plan to fix is not a plan the composer could have returned for this input: not a K-03 v1 plan, or
 *              with a format or a literal value the input does not allow (check.ts planAgainstInput);
 *   told       the told is not a list of failed checks, each a K-03 check name, at most once, with a detail in words.
 */
export const REWRITE_REFUSALS = ["attempt", "request", "planToFix", "told"] as const;
export type RewriteRefusal = (typeof REWRITE_REFUSALS)[number];

/** One reason a rewrite request is refused. */
export interface RewriteProblem {
  readonly check: RewriteRefusal;
  /** Where: `attempt`, `(root)`, `told`, `told[1]`, or a place in the plan such as `plan.lines[0].text`. */
  readonly at: string;
}

/** The one rewrite's plan, checked as compose checks every plan (a K-03 plan that keeps to its input). */
export type RewriteOk = ComposeOk;

/**
 * No rewritten plan: the action layer's fallback path takes over (C-093, inside finalizeMessage: the step's fallback
 * text through the same checks, then the passed-on line). Never a second rewrite.
 *
 *   rewriteFailed   the told is the one rewrite's own failure (attempt `rewrite`): the second failure. No call is made.
 *   rewriteRefused  the one rewrite's answer failed the AI layer's own checks (check.ts planAgainstInput), so it never
 *                   leaves the AI layer: it failed too. Its one call is in modelCalls; `problems` name what was refused.
 */
export interface RewriteUseFallback {
  readonly status: "useFallback";
  readonly why: "rewriteFailed" | "rewriteRefused";
  /** For rewriteRefused, what the AI layer refused in the answer: checks and places, never words; else empty. */
  readonly problems: readonly ComposeProblem[];
  readonly modelCalls: readonly ModelCall[];
}

/**
 * A request that cannot be rewritten, refused before any call: its input (stage `input`, as compose refuses one), or the
 * rest of it (stage `request`).
 */
export interface RewriteRefused {
  readonly status: "refused";
  readonly stage: "input" | "request";
  readonly problems: readonly (ComposeProblem | RewriteProblem)[];
  /** Always empty: nothing is sent for a refused request. */
  readonly modelCalls: readonly ModelCall[];
}

/** The rewrite's call failed on both models (the gateway's typed `modelsDown`); what follows is T-252's and T-271's. */
export interface RewriteDown {
  readonly status: "modelsDown";
  readonly failures: readonly AttemptFailure[];
  readonly modelCalls: readonly ModelCall[];
}

export type RewriteAnswer = RewriteOk | RewriteUseFallback | RewriteRefused | RewriteDown;
