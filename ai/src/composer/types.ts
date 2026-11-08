// Types of the composer's call (T-373, C-118; arch 07 "Decide, then word", architecture.txt line 397; arch 01 "Message
// plan", line 97). The K-03 shapes (contracts/message-plan: v1.1's `composeInput` in, whose facts are slot facts and term
// facts; v1's `plan` out, which v1.1 leaves unchanged) are T-372's hand-written types in ./prompt/types.ts: the generated
// types are git-ignored (ADR-005) and the Worker must not depend on them. The tests hold every list the checks read to
// the contract's own.

import type { PromptCache } from "../cache";
import type { AttemptFailure, CallOptions, FetchLike, GatewayBundle, ModelCall, ModelRole } from "../gateway";
import type { ComposeInput, MessagePlan } from "./prompt";

export type { ComposeInput, MessagePlan, ModelCall, ModelRole };

/**
 * Why a row is refused: a label and a place, never words (K-08 README: no message words in a span or a log line).
 *
 *   input             the input is not a K-03 v1.1 composeInput;
 *   frontier          the input carries the frontier, which the composer never gets (arch 07 line 397;
 *                     refuse-frontier-in-input.json);
 *   plan              the model's answer is not a K-03 v1 plan;
 *   formatNotAllowed  a format outside K-03's five (refuse-format-not-allowed.json), or one the input's allowedFormats
 *                     does not list (arch 07 line 365: code lists what this phone allows, and the AI picks from it);
 *   holdSlot          a {{hold}} slot, refused since D66 (refuse-hold-slot.json);
 *   unknownSlot       a {{ that opens no slot of K-03's vocabulary;
 *   literalValue      a number, date or price typed in the plan's words, outside its slots, that no fact of the input
 *                     holds, a slot fact or a term fact (rule 4: code fills every value; arch 07 lines 403 and 409;
 *                     K-03 v1.1 README "v1.1").
 */
export const REFUSAL_CHECKS = [
  "input",
  "frontier",
  "plan",
  "formatNotAllowed",
  "holdSlot",
  "unknownSlot",
  "literalValue",
] as const;
export type RefusalCheck = (typeof REFUSAL_CHECKS)[number];

/** What kind of value a literalValue typed: a price, a date or time, or any other number. */
export const LITERAL_KINDS = ["number", "date", "price"] as const;
export type LiteralKind = (typeof LITERAL_KINDS)[number];

/** One reason a row is refused. */
export interface ComposeProblem {
  readonly check: RefusalCheck;
  /** Where: a path into the input or the plan, such as `frontier`, `formats[1]` or `lines[1].text`; `(root)` for the whole. */
  readonly at: string;
  /** For a literalValue: the kind of value typed, never the value. */
  readonly kind?: LiteralKind;
}

/** What the composer is built with: one bundle's id, models and prompt layout, and the key's environment. */
export interface ComposerOptions {
  /** The bundle id and its two model ids (K-01 v1 manifest), checked as the AI gateway checks them (T-361). */
  readonly bundle: GatewayBundle;
  /** The same bundle's prompt layout (T-364): its composer prompt (K-01 manifest.prompts.composer) is the cached system prompt. */
  readonly prompts: PromptCache;
  /** The environment the key is read from, by name (ANTHROPIC_API_KEY), at the moment of each call. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`. Tests pass a fake Messages API. */
  readonly fetch?: FetchLike;
}

/** Where the call's spans go: the turn's trace, as the AI gateway takes it (one portCall span per attempt). */
export type ComposeCallOptions = CallOptions;

/** The row's plan: a K-03 v1 plan that keeps to its input (allowed formats; no value typed that no fact holds). */
export interface ComposeOk {
  readonly status: "ok";
  readonly plan: MessagePlan;
  /** The model that answered, and its role in the bundle. */
  readonly model: string;
  readonly role: ModelRole;
  /** The gateway attempt that answered (1 to 3). */
  readonly attempt: number;
  /** True when Sonnet answered after Haiku failed twice (the gateway's fallback). */
  readonly fallback: boolean;
  /** Every attempt's model call, in order (K-08 v1). */
  readonly modelCalls: readonly ModelCall[];
}

/**
 * A typed refusal, never a plan: the input, refused before any call (stage "input"), or the model's answer, refused
 * before it leaves the AI layer (stage "plan"). Problems name checks and places, never words.
 */
export interface ComposeRefused {
  readonly status: "refused";
  readonly stage: "input" | "plan";
  readonly problems: readonly ComposeProblem[];
  /** The model calls made: none for a refused input. */
  readonly modelCalls: readonly ModelCall[];
}

/** The call failed on both models (the gateway's typed `modelsDown`); what follows is T-271's. */
export interface ComposeDown {
  readonly status: "modelsDown";
  readonly failures: readonly AttemptFailure[];
  readonly modelCalls: readonly ModelCall[];
}

export type ComposeAnswer = ComposeOk | ComposeRefused | ComposeDown;

/** The composer (C-118): one Haiku call per outbox row, the row's message plan out. */
export interface Composer {
  /**
   * Composes one outbox row's message plan. Never rejects for a failed model call or a bad answer: those are
   * `modelsDown` and `refused`. Rejects, before any call, only for a call that cannot be made: no key
   * (MissingKeyError), a trace of another bundle (GatewayConfigError).
   */
  compose(input: ComposeInput, options?: ComposeCallOptions): Promise<ComposeAnswer>;
}
