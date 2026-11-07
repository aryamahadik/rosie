// Prompt caching (T-364, C-122): the layout of every model call (layout.ts), its cache markers on the wire and through
// the AI gateway (wire.ts), and Anthropic's prompt-caching rules for the two models (rules.ts).

export {
  FLOW_LETTERS,
  PROMPT_KINDS,
  sha256Hex,
  type AlwaysOnRules,
  type BundlePrompt,
  type CacheBundle,
  type CacheFlow,
  type CardMeaning,
  type FlowLetter,
  type PromptKind,
  type StepCard,
} from "./bundle";
export { CacheLayoutError } from "./errors";
export {
  CACHE_PURPOSES,
  CARDS_CLOSE,
  CARDS_OPEN,
  CONTEXT_PURPOSES,
  PROMPT_OF,
  RULES_CLOSE,
  RULES_OPEN,
  createPromptCache,
  isContextPurpose,
  type CachePurpose,
  type CachedPrompt,
  type ContextLayout,
  type ContextPurpose,
  type LayoutRequest,
  type PlainLayout,
  type PlainPurpose,
  type PromptCache,
  type PromptSegment,
  type TurnCard,
  type TurnContext,
} from "./layout";
export { CACHE_MARKER, CACHE_RULES, type CacheMarker } from "./rules";
export {
  createCachedGateway,
  messagesParams,
  systemBlocks,
  systemText,
  toGatewayRequest,
  withCacheMarkers,
  type CachedGateway,
  type PromptRequest,
  type SystemBlock,
} from "./wire";
