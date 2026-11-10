// The Tool API base (T-290; C-074): every K-09 v1 call registered with request and response validation, run under its
// business scope, with one K-08 span each. See tool-api.ts.

export {
  CALLER_KINDS,
  CALL_HOPS,
  CALL_NAMES,
  hopOf,
  isCallName,
  isCallerKind,
  type AnswerOf,
  type CallName,
  type CallTypes,
  type Caller,
  type CallerKind,
  type ErrorsOf,
  type PlannerVerbsErrors,
  type RequestOf,
  type ResponseOf,
} from "./calls";
export {
  BASE_REFUSAL_CODES,
  NotBuiltError,
  ToolApiContractError,
  isBaseRefusal,
  type BaseRefusal,
  type InvalidRequestRefusal,
  type NoBusinessScopeRefusal,
  type NotBuiltRefusal,
  type UnknownCallRefusal,
} from "./errors";
export { businessScopeOf, type BusinessScope } from "./scope";
export {
  createToolApi,
  notBuiltHandlers,
  type CallAnswer,
  type CallContext,
  type CallTrace,
  type Handler,
  type Handlers,
  type SpanNotes,
  type SpanRefusedReport,
  type ToolApi,
  type ToolApiOptions,
} from "./tool-api";
export {
  COMPOSE_INPUT_TOOL_API_SCHEMA_ID,
  CONTRACTS_DIR,
  EVENT_TRACE_SCHEMA_ID,
  SCHEMA_FILES,
  TOOL_API_SCHEMA_ID,
  V1_6_SCHEMA_FILES,
  createToolApiValidator,
  formatProblems,
  loadToolApiSchemas,
  toolApiSchemaIdOf,
  type CallPart,
  type ToolApiValidator,
} from "./validator";
