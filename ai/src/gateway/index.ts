// The AI gateway (T-361, C-121). See gateway.ts for what it guarantees.

export {
  API_URL,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
  KEY_VARIABLE,
  STAGE_TIMEOUT_MS,
  createGateway,
} from "./gateway";
export { GatewayConfigError, MissingKeyError, NotForTheGatewayError } from "./errors";
export { PRICE_LIST, costMicroUsd, type PriceList, type PriceRow, type Usage } from "./prices";
export {
  ALLOWED_MODELS,
  GATEWAY_PURPOSES,
  HAIKU_MODEL,
  SONNET_MODEL,
  STAGE_OF,
  type AttemptFailure,
  type BundleModels,
  type CallOptions,
  type FailureCode,
  type FetchLike,
  type Gateway,
  type GatewayBundle,
  type GatewayEffort,
  type GatewayOptions,
  type GatewayPurpose,
  type GatewayRequest,
  type GatewayResult,
  type GatewayStage,
  type GatewaySuccess,
  type ModelCall,
  type ModelRole,
  type ModelsDown,
} from "./types";
