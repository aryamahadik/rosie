// The compose-input call (C-090, T-309; K-09 v1 composeInput): one committed outbox row turned into K-03 v1's composer
// input, with only what limit 7 lets its recipient see and code's situation tag, never the frontier. See handler.ts.
// Wiring (D-017): `{ ...handlers, composeInput: createComposeInputHandler({ ports, bundles }) }`, with the row reader as
// `ports` once it is built; until then notBuiltComposeInputPorts() keeps the call failing closed (notBuilt).

export { MAX_CONVERSATION, buildComposeInput, slotsIn } from "./build";
export {
  MESSAGE_PLAN_SCHEMA_ID,
  admitInput,
  createComposeInputChecker,
  defaultComposeInputChecker,
  type ComposeInputChecker,
} from "./check";
export {
  ComposeInputNotBuiltError,
  ComposeInputRefusedError,
  type ComposeInputFault,
  type ComposeInputSeam,
} from "./errors";
export {
  CLOSED_STATES,
  COMPOSABLE_STATES,
  composeInputHandlers,
  createComposeInputHandler,
  notBuiltComposeInputPorts,
  type ComposeInputDeps,
} from "./handler";
export {
  READER_LANES,
  ROSIE_LANE,
  optOutLinesOf,
  readMasterLine,
  withoutOptOutLine,
  type MasterLine,
} from "./master-line";
export {
  MONEY_SLOTS,
  NO_DANGER,
  SIGNAL_TAGS,
  SITUATIONS,
  sensitiveOn,
  signalsOf,
  situationOf,
  type Signal,
} from "./situation";
export type {
  Audience,
  BundleId,
  Channel,
  ComposeBundles,
  ComposeInput,
  ComposeInputAnswer,
  ComposeInputError,
  ComposeInputPorts,
  ComposeInputRequest,
  ComposeInputResponse,
  ComposeRow,
  ComposeRowRead,
  Concern,
  ConversationMessage,
  Fact,
  FlowLetter,
  Format,
  Inbound,
  InboundText,
  LinkSlot,
  NotFound,
  OpenQuestion,
  Option,
  Reach,
  RowState,
  Situation,
  SituationFacts,
  Transient,
} from "./types";
