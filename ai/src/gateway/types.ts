// Types of the AI gateway (T-361, C-121). Every model call but the safety read goes through it (arch 06 figure "AI
// gateway": bundle id, timeout 2x its stage budget, one retry, the other model once, traces kept).

import type { JsonObject } from "../recorded-double/types";
import type { ModelCall } from "../../../runtime/src/trace/types";
import type { BundleId, TraceContext } from "../../../runtime/src/trace";

export type { BundleId, ModelCall };

/** Which of the bundle's two models (K-01 v1 `modelRole`). */
export type ModelRole = "haiku" | "sonnet";

/** The only two model ids the gateway can call (arch 11 line 564; DL-027). DeepInfra is never called. */
export const HAIKU_MODEL = "claude-haiku-5-5";
export const SONNET_MODEL = "claude-sonnet-5-5";
export const ALLOWED_MODELS = [HAIKU_MODEL, SONNET_MODEL] as const;

/** The models one bundle runs on (K-01 v1 `manifest.models`). */
export interface BundleModels {
  readonly haiku: string;
  readonly sonnet: string;
}

/** What the gateway reads of a bundle's manifest: its id and its two model ids (K-01 v1). */
export interface GatewayBundle {
  readonly bundleId: BundleId;
  readonly models: BundleModels;
}

/**
 * What a call is for: K-08 v1's model-call purposes, less the safety read, which has its own path with 2 s per model
 * (arch 04 line 231) and never goes through the gateway.
 */
export const GATEWAY_PURPOSES = [
  "decideFirst",
  "decideCheck",
  "reread",
  "planner",
  "compose",
  "rewrite",
] as const;
export type GatewayPurpose = (typeof GATEWAY_PURPOSES)[number];

/** The stages a call can belong to, each with its own budget (arch 04 latency table). */
export type GatewayStage = "decide" | "reread" | "planner" | "composer";

/** The stage a purpose belongs to. A rewrite is the composer's own second write (arch 02 line 123). */
export const STAGE_OF: Readonly<Record<GatewayPurpose, GatewayStage>> = {
  decideFirst: "decide",
  decideCheck: "decide",
  reread: "reread",
  planner: "planner",
  compose: "composer",
  rewrite: "composer",
};

export type GatewayEffort = "low" | "medium" | "high";

/** One model call as the gateway is asked for it. The model id is never named here: the bundle names it by `role`. */
export interface GatewayRequest {
  readonly purpose: GatewayPurpose;
  /** The model that is asked first; the other one is the fallback. Routing by stakes is T-363's. */
  readonly role: ModelRole;
  readonly system: string;
  readonly user: string;
  /** The structured output's JSON schema (a static one; option ids are checked in code, not in the schema). */
  readonly schema: JsonObject;
  readonly maxTokens?: number;
  /** `output_config.effort`; "low" is what the spikes measured. */
  readonly effort?: GatewayEffort;
}

/** Where a call's spans go: the turn's trace (runtime/src/trace). Its bundle id must be the gateway's. */
export interface CallOptions {
  readonly trace?: TraceContext;
  readonly businessId?: string | null;
  readonly eventId?: string | null;
}

/** Why one attempt failed: a label, never the provider's words. */
export type FailureCode =
  "timeout" | "network" | "refusal" | "max_tokens" | "bad_stop" | "bad_output" | `http_${string}`;

/** One failed attempt. */
export interface AttemptFailure {
  readonly model: string;
  readonly role: ModelRole;
  /** 1 to 3, in the order the attempts ran. */
  readonly attempt: number;
  readonly code: FailureCode;
}

export interface GatewaySuccess {
  readonly status: "ok";
  readonly purpose: GatewayPurpose;
  /** The structured output, parsed. The stage that asked checks it against its own contract. */
  readonly output: unknown;
  readonly model: string;
  readonly role: ModelRole;
  /** The attempt that answered (1 to 3). */
  readonly attempt: number;
  /** True when the answer came from the other model, after the first model failed twice. */
  readonly fallback: boolean;
  /** Every attempt's model call, in order, the failed ones included. */
  readonly modelCalls: readonly ModelCall[];
  readonly failures: readonly AttemptFailure[];
}

/** All three attempts failed: the first model twice, then the other model once (arch 06 "A model call fails"). */
export interface ModelsDown {
  readonly status: "modelsDown";
  readonly purpose: GatewayPurpose;
  readonly modelCalls: readonly ModelCall[];
  readonly failures: readonly AttemptFailure[];
}

export type GatewayResult = GatewaySuccess | ModelsDown;

/** The part of `fetch` the gateway uses. Tests pass a fake; the Worker passes `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GatewayOptions {
  readonly bundle: GatewayBundle;
  /** The environment the key is read from, by name (ANTHROPIC_API_KEY): the Worker's `env`, or `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

export interface Gateway {
  /** One model call: the first model twice at most, then the other model once. Never throws for a failed model call. */
  call(request: GatewayRequest, options?: CallOptions): Promise<GatewayResult>;
}
