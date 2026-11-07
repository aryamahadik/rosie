// A laid-out prompt on the wire (T-364, C-122): the Messages API's `system` blocks with their cache markers, and the
// way those markers ride the AI gateway's requests (T-361).
//
// Each cached segment is one system text block ending in a `cache_control` marker; the per-turn part is the user message
// and carries none. So a request has at most 2 markers (of the 4 allowed), and the per-turn part is always after the
// last one: render order is system, then messages.
//
// The gateway sends `system` as one string, as given (it changes no prompt). createCachedGateway keeps every gateway
// guarantee (the bundle's two models, the stage timeouts, one retry then the other model, the typed modelsDown, one
// K-08 span per attempt) and adds the markers at the last step, in the request body each attempt sends: the system
// string it built from the prompt is replaced by the same text as the prompt's marked blocks. Nothing else in the body
// changes, and a body whose system is not that exact text goes as it came. The safety read, which has its own path
// (arch 04 line 231), sends messagesParams(prompt) itself.

import {
  GATEWAY_PURPOSES,
  GatewayConfigError,
  NotForTheGatewayError,
  createGateway,
  type CallOptions,
  type FetchLike,
  type GatewayEffort,
  type GatewayOptions,
  type GatewayPurpose,
  type GatewayRequest,
  type GatewayResult,
  type ModelRole,
} from "../gateway";
import type { JsonObject } from "../recorded-double/types";
import { bundleIdText, sameBundleId } from "./bundle";
import type { CachedPrompt } from "./layout";
import { CACHE_MARKER, type CacheMarker } from "./rules";

/** A Messages API system text block. */
export interface SystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: CacheMarker;
}

/** What a call sends besides its prompt; the model is the bundle's for `role` (the gateway's rule). */
export interface PromptRequest {
  readonly role: ModelRole;
  /** The stage's structured-output schema: static, so its cache entries are read call after call. */
  readonly schema: JsonObject;
  readonly maxTokens?: number;
  /** Pinned per stage: a changed effort misses the cache. */
  readonly effort?: GatewayEffort;
}

/** The system prompt as one string: the cached segments, in order, exactly as the model reads them. */
export function systemText(prompt: CachedPrompt): string {
  return prompt.segments.map((segment) => segment.text).join("");
}

/** The system prompt as the Messages API takes it: one block per cached segment, each ending at a cache breakpoint. */
export function systemBlocks(prompt: CachedPrompt): SystemBlock[] {
  return prompt.segments.map((segment): SystemBlock => ({
    type: "text",
    text: segment.text,
    cache_control: CACHE_MARKER,
  }));
}

/** `system` and `messages` of a Messages API request for the prompt: for a path that builds its own body. */
export function messagesParams(prompt: CachedPrompt): {
  system: SystemBlock[];
  messages: [{ role: "user"; content: string }];
} {
  return { system: systemBlocks(prompt), messages: [{ role: "user", content: prompt.turn }] };
}

function gatewayPurpose(prompt: CachedPrompt): GatewayPurpose {
  const purpose = GATEWAY_PURPOSES.find((candidate) => candidate === prompt.purpose);
  if (purpose === undefined) throw new NotForTheGatewayError(prompt.purpose);
  return purpose;
}

/** The gateway's request for a prompt: the system prompt as one string, the per-turn part as the user text. */
export function toGatewayRequest(prompt: CachedPrompt, request: PromptRequest): GatewayRequest {
  return {
    purpose: gatewayPurpose(prompt),
    role: request.role,
    system: systemText(prompt),
    user: prompt.turn,
    schema: request.schema,
    ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
    ...(request.effort !== undefined && { effort: request.effort }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The request as it goes out with the prompt's markers: the body's `system`, when it is exactly the prompt's system
 * text, becomes its marked blocks. Any other body is returned as it came.
 */
export function withCacheMarkers(init: RequestInit, prompt: CachedPrompt): RequestInit {
  if (typeof init.body !== "string") return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body) as unknown;
  } catch {
    return init;
  }
  if (!isRecord(body) || body.system !== systemText(prompt)) return init;
  return { ...init, body: JSON.stringify({ ...body, system: systemBlocks(prompt) }) };
}

/** The gateway, sending laid-out prompts with their cache markers. */
export interface CachedGateway {
  /**
   * One model call for a laid-out prompt, with the gateway's attempts, timeouts and spans. Refuses (before any call) a
   * prompt of another bundle and a safety read, which does not go through the gateway.
   */
  call(prompt: CachedPrompt, request: PromptRequest, options?: CallOptions): Promise<GatewayResult>;
}

/** Builds the gateway for one bundle, as createGateway does (and refusing what it refuses), with the cache markers. */
export function createCachedGateway(options: GatewayOptions): CachedGateway {
  createGateway(options);
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async call(
      prompt: CachedPrompt,
      request: PromptRequest,
      callOptions: CallOptions = {},
    ): Promise<GatewayResult> {
      if (!sameBundleId(prompt.bundleId, options.bundle.bundleId)) {
        throw new GatewayConfigError(
          `the prompt is laid out for bundle ${bundleIdText(prompt.bundleId)}, not the gateway's`,
        );
      }
      const gatewayRequest = toGatewayRequest(prompt, request);
      const gateway = createGateway({
        ...options,
        fetch: (url, init) => send(url, withCacheMarkers(init, prompt)),
      });
      return await gateway.call(gatewayRequest, callOptions);
    },
  };
}
